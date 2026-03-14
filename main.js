import dotenv from "dotenv";
dotenv.config();
import fs from "fs";

import { logger, getISTTime } from "./logger.js";
import { sleep, getTodayFromDate, formatISTDateTime, updateEnvKey } from "./helpers.js";
import { getFutureToken } from "./tokens.js";
import { entryEngine, onTradeExit, checkAndHandleIndexExit } from "./entryEngine.js";
import { backtest } from "./backtest.js";
import { startFeed, stopFeed } from "./wsMarketFeed.js";
import { isOpen, getPosition } from "./positionManager.js";
import { checkExitAndCleanup, marketExit } from "./order.js";
import { kotakLogin } from "./kotak_login.js";
import { getUpstoxToken } from "./up_stock_login.js";

const USE_WEBSOCKET = process.env.USE_WEBSOCKET === "true";
let _upstoxLoginInProgress = false;

const BROKER_SETTLE_MS = parseInt(process.env.BROKER_SETTLE_MS ?? "10000");

function isToday(dateStr) {
    const today = new Date().toISOString().split("T")[0];
    return dateStr === today;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");
        const btFrom = getTodayFromDate(29);
        const btTo = formatISTDateTime();
        logger.info(`📅 Window: ${btFrom} → ${btTo}`);
        const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX", btFrom);
        await backtest(futureToken, btFrom, btTo, {
            slPoints: parseInt(process.env.BT_SL ?? "80"),
            tgtPoints: parseInt(process.env.BT_TGT ?? "200"),
            startBar: 30,
        });
        logger.info("✅ Done. See backtest.log");
        return;
    }

    logger.info("🚀 BOT STARTED");
    logger.info(`⚙ WebSocket mode: ${USE_WEBSOCKET ? "ON" : "OFF (polling)"}`);

    let lastSignal = null;
    let iteration = 0;
    let _lastWindowLog = null;
    let _noTradeLogCount = 0;

    let _positionOpenedAt = null;
    let _exitLock = false;
    let _exitFired = false;

    // ── safeExit — single-exit guard ────────────────────────────────────────
    function safeExit(pnl, reason, exitPrice = NaN) {
        if (_exitFired) {
            logger.warn(`⚠ safeExit: duplicate suppressed (${reason})`);
            return;
        }
        _exitFired = true;
        _exitLock = false;
        onTradeExit(pnl, reason, exitPrice);
        _positionOpenedAt = null;
        logger.debug(`🔒 safeExit fired [${reason}] PnL:${pnl}`);
    }

    // ── WebSocket mode ─────────────────────────────────────────────────────
    if (USE_WEBSOCKET) {
        logger.info("🔌 Starting WebSocket feed...");
        try {
            const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX");
            const feedToken = process.env.FEED_TOKEN || "";

            async function handleLiveExit(tickLtp) {
                if (_exitLock || _exitFired || !isOpen()) return;
                if (_positionOpenedAt && (Date.now() - _positionOpenedAt < BROKER_SETTLE_MS)) return;

                const pos = getPosition();
                if (!pos || pos.side === "NO_TRADE") return;

                _exitLock = true;
                try {
                    // Index-point SL/TGT check
                    const indexExited = await checkAndHandleIndexExit(tickLtp, safeExit, marketExit);
                    if (indexExited) return;

                    // Fallback: broker fill check
                    const isPE = pos.side === "PE";
                    const status = await checkExitAndCleanup(pos.optionSymbol, {
                        currentIndexLTP: tickLtp,
                        indexSL: pos.sl,
                        indexTGT: pos.target,
                        isPE,
                    });

                    if (status?.exited) {
                        const price = parseFloat(tickLtp);
                        const optExit = status.exitPrice && !isNaN(parseFloat(status.exitPrice))
                            ? parseFloat(status.exitPrice) : null;
                        const pnl = optExit && pos.optionEntry
                            ? (isPE ? pos.optionEntry - optExit : optExit - pos.optionEntry)
                            : (isPE ? pos.entry - price : price - pos.entry);
                        const actualExit = status.exitPrice && !isNaN(status.exitPrice) ? status.exitPrice : price;
                        logger.info(`🚨 BROKER EXIT (WS): ${pos.side} @ ${tickLtp}`);
                        safeExit(pnl, "BROKER SL/TGT FILLED (WS)", actualExit);
                    }
                } catch (err) {
                    logger.error(`❌ Live Exit Error: ${err.message}`);
                } finally {
                    _exitLock = false;
                }
            }

            startFeed(feedToken, "BSE_INDEX|SENSEX", async (tick) => {
                if (Math.random() < 0.05) logger.info(`📡 WS → LTP:${tick.ltp}`);
                await handleLiveExit(tick.ltp);
            });

            logger.info("✅ WebSocket feed running");
        } catch (err) {
            logger.error(`❌ WebSocket startup failed: ${err.message} — polling fallback`);
        }
    }

    // ── Main polling loop ──────────────────────────────────────────────────
    while (true) {
        iteration++;
        let signalObj = null;

        try {
            const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const istMins = istNow.getHours() * 60 + istNow.getMinutes();

            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            // ── Token refreshes ──────────────────────────────────────────────
            const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

            if (!process.env.KOTAK_TOKEN_DATE || !isToday(process.env.KOTAK_TOKEN_DATE)) {
                logger.info("🔐 Kotak token expired — logging in...");
                await kotakLogin();
                updateEnvKey("KOTAK_TOKEN_DATE", today);
                logger.info(`📅 Kotak token updated → ${today}`);
            } else {
                logger.info("✅ Kotak token valid.");
            }

            if (!process.env.UPSTOX_ACCESS_TOKEN_DATE || !isToday(process.env.UPSTOX_ACCESS_TOKEN_DATE)) {
                if (_upstoxLoginInProgress) {
                    logger.info("⏳ Upstox login in progress...");
                } else {
                    _upstoxLoginInProgress = true;
                    try {
                        logger.info("🔐 Upstox token expired — logging in...");
                        await getUpstoxToken();
                        logger.info(`📅 Upstox token updated → ${today}`);
                    } finally { _upstoxLoginInProgress = false; }
                }
            } else {
                logger.info("✅ Upstox token valid.");
            }

            // ── Market hours ─────────────────────────────────────────────────
            if (istMins < (9 * 60) || istMins > (15 * 60 + 40)) {
                logger.info(`😴 Market closed — sleeping 60s`);
                await sleep(60_000);
                continue;
            }

            const liveFrom = getTodayFromDate(29);
            const liveTo = formatISTDateTime();

            const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX", liveTo);

            const windowKey = `${liveFrom}_${liveTo}`;
            if (windowKey !== _lastWindowLog) {
                logger.info(`📅 Window: ${liveFrom} → ${liveTo}`);
                _lastWindowLog = windowKey;
            }

            const positionJustOpened = _positionOpenedAt && (Date.now() - _positionOpenedAt < BROKER_SETTLE_MS);

            // ── Exit monitoring (REST polling path) ──────────────────────────
            if (isOpen() && !positionJustOpened && !_exitLock && !_exitFired) {
                const pos = getPosition();
                if (pos) {
                    // Fetch SENSEX index LTP via SYMBOLTOKEN (ONE_MINUTE candle)
                    try {
                        const { getHistorical, format } = await import("./historical.js");
                        const SYMBOLTOKEN = process.env.SYMBOLTOKEN;
                        const pollFrom = getTodayFromDate(1);
                        const pollTo = formatISTDateTime();
                        const iRaw = await getHistorical(null, null, SYMBOLTOKEN, "ONE_MINUTE", pollFrom, pollTo);
                        const iData = format(iRaw);
                        if (iData && iData.length) {
                            const currentIndexLTP = iData[iData.length - 1].close;

                            const indexExited = await checkAndHandleIndexExit(
                                currentIndexLTP, safeExit, marketExit
                            );
                            if (indexExited) {
                                await sleep(5_000);
                                continue;
                            }
                        }
                    } catch (e) {
                        logger.warn(`⚠ Index LTP fetch (SYMBOLTOKEN) failed: ${e.message}`);
                    }

                    // Broker REST poll — position gone at broker?
                    if (!_exitLock && !_exitFired && pos.optionSymbol) {
                        try {
                            const status = await checkExitAndCleanup(pos.optionSymbol, { isPE: pos.side === "PE" });
                            if (status?.exited) {
                                logger.info(`🔔 Broker exit detected (poll) for ${pos.optionSymbol}`);
                                let exitPx = status.exitPrice;
                                if (isNaN(exitPx) || exitPx === 0) {
                                    exitPx = parseFloat(pos.optionEntry ?? NaN);
                                    if (!isNaN(exitPx)) logger.warn(`⚠ Using optionEntry as exit price fallback: ${exitPx}`);
                                }
                                safeExit(0, "BROKER SL/TGT FILLED (POLL)", exitPx);
                            }
                        } catch (e) {
                            logger.warn(`⚠ Broker exit poll error: ${e.message}`);
                        }
                    }
                }
            } else if (positionJustOpened) {
                const elapsed = ((Date.now() - _positionOpenedAt) / 1000).toFixed(0);
                logger.debug(`⏳ Settling (${elapsed}s / ${BROKER_SETTLE_MS / 1000}s)`);
            }

            // ── Entry Engine ────────────────────────────────────────────────
            signalObj = await entryEngine(liveFrom, liveTo, futureToken);

            if (signalObj?.signal && signalObj.signal !== "NO_TRADE") {
                _positionOpenedAt = Date.now();
                _exitFired = false;
                logger.debug(`📍 Position opened — settling ${BROKER_SETTLE_MS / 1000}s`);
            }

            const signalType = signalObj?.signal ?? "NO_TRADE";
            const isNoTrade = signalType === "NO_TRADE";

            if (isNoTrade) {
                _noTradeLogCount++;
                if (lastSignal !== "NO_TRADE" || _noTradeLogCount % 20 === 1) {
                    logger.info(`🎯 NO_TRADE (${signalObj?.reason ?? ""})`);
                }
                lastSignal = "NO_TRADE";
            } else {
                _noTradeLogCount = 0;
                if (signalType !== lastSignal) {
                    logger.info(`🚨 SIGNAL: ${signalType} Entry:${signalObj.entryPrice} SL:${signalObj.slPrice} TGT:${signalObj.tgtPrice} RR:${signalObj.riskReward}`);
                    lastSignal = signalType;
                }
            }

        } catch (err) {
            logger.error(`❌ Loop #${iteration} Error: ${err.message}`);
        }

        await sleep(5_000);
    }
}

process.on("SIGINT", () => { stopFeed(); logger.info("👋 Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { stopFeed(); logger.info("👋 Shutting down..."); process.exit(0); });

main();