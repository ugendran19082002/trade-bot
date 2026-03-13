import dotenv from "dotenv";
dotenv.config();

import { logger, tradeLogger, getISTTime } from "./logger.js";
import { sleep, getDailyFromDate, buildTimeframe } from "./helpers.js";
import { getHistorical, getFuture, format } from "./historical.js";
import { getATMOptionTokens, getLTP } from "./getStrick.js";
import { generateSignal } from "./signals.js";
import { sendTelegram } from "./telegram.js";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import path from "path";

import { canTrade, recordTrade, getRiskStatus, resetDaily } from "./riskEngine.js";
import { isOpen, openPosition, closePosition, getPosition, logStatus } from "./positionManager.js";
import { setCandles, getCandles } from "./redisCache.js";
import { addOrderJob } from "./orderQueue.js";

import {
    recordExit,
    isPriceLevelGatePassed,
    isGateActive,
    getGateStatus,
    resetDailyCache,
    checkIndexExitCondition,
} from "./tradeExitTracker.js";

const USE_WORKER_THREADS = process.env.USE_WORKER_THREADS === "true";
const USE_QUEUE          = process.env.USE_QUEUE === "true";
const __dirname          = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
// Worker Thread helper
// ─────────────────────────────────────────
function runIndicatorWorker(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "indicatorWorker.js"), { workerData });
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Indicator worker exited with code ${code}`));
        });
    });
}

// ─────────────────────────────────────────
// Redis-aware fetch helper
// ─────────────────────────────────────────
async function cachedFetch(cacheKey, tfLabel, fetchFn) {
    const cached = await getCandles(cacheKey);
    if (cached) return cached;
    const raw = await fetchFn();
    if (raw && raw.length) await setCandles(cacheKey, raw, tfLabel);
    return raw ?? [];
}

// ─────────────────────────────────────────
// Live session state
// ─────────────────────────────────────────
const _liveSessionState = {
    consecutiveLosses: 0,
    tradesToday: 0,
    lastTradeMinute: -999,
};

// ─────────────────────────────────────────
// Daily reset
// ─────────────────────────────────────────
let _lastResetDay = null;
function maybeDailyReset() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (_lastResetDay !== today) {
        _lastResetDay = today;
        resetDaily();
        resetDailyCache();
        _liveSessionState.consecutiveLosses = 0;
        _liveSessionState.tradesToday = 0;
        _liveSessionState.lastTradeMinute = -999;
        logger.info("🔄 Daily reset complete");
    }
}

// ─────────────────────────────────────────
// Execution mutex
// ─────────────────────────────────────────
let _tradeLock = false;
let _iterationCount = 0;

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY ENGINE
// ═════════════════════════════════════════════════════════════════════════════
export async function entryEngine(jwt, fromdate, todate, futureToken) {

    // ── Mutex guard ───────────────────────────────────────────────────────
    if (_tradeLock) {
        logger.warn("⚠ EntryEngine locked — trade in-flight, skipping loop tick");
        return { signal: "NO_TRADE", reason: "execution_locked" };
    }

    _iterationCount++;
    maybeDailyReset();

    if (isOpen() || _iterationCount % 20 === 1) logStatus();

    // ── Risk Engine ───────────────────────────────────────────────────────
    const risk = canTrade();
    if (!risk.allowed) {
        logger.warn(`🚨 RiskEngine BLOCKED: ${risk.reason}`);
        const rs = getRiskStatus();
        logger.info(`📊 Risk | Trades:${rs.dailyTrades}/${rs.maxTrades} PnL:${rs.dailyPnL} Reason:${rs.blockReason}`);
        return { signal: "NO_TRADE", reason: `risk_blocked_${risk.reason}` };
    }

    // ── Position already open ─────────────────────────────────────────────
    if (isOpen()) {
        const pos = getPosition();
        logger.info(`⏳ Position open: ${pos.side} @ ${pos.entry} — skipping new signal`);
        return { signal: "NO_TRADE", reason: "position_already_open" };
    }

    // ── SYMBOLTOKEN guard ─────────────────────────────────────────────────
    const SYMBOLTOKEN = process.env.SYMBOLTOKEN;
    if (!SYMBOLTOKEN) {
        logger.error("❌ SYMBOLTOKEN not set");
        return { signal: "NO_TRADE", reason: "missing_SYMBOLTOKEN" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FETCH ALL CANDLES FIRST
    //  Gate check reuses index1m — no extra API call needed
    // ═══════════════════════════════════════════════════════════════════════
    const dailyFrom = getDailyFromDate();

    const indexRaw1m  = await cachedFetch(`index1m_${todate}`,  "1m",  () => getHistorical(null, null, SYMBOLTOKEN, "ONE_MINUTE",      fromdate, todate)); await sleep(400);
    const indexRaw5m  = await cachedFetch(`index5m_${todate}`,  "5m",  () => getHistorical(null, null, SYMBOLTOKEN, "FIVE_MINUTE",     fromdate, todate)); await sleep(400);
    const indexRaw15m = await cachedFetch(`index15m_${todate}`, "15m", () => getHistorical(null, null, SYMBOLTOKEN, "FIFTEEN_MINUTE",  fromdate, todate)); await sleep(400);
    const raw1D       = await cachedFetch(`index1D_${dailyFrom}`, "1D", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_DAY",         dailyFrom, todate)); await sleep(400);
    const futureRaw1m = await cachedFetch(`future1m_${todate}`, "1m",  () => getFuture(futureToken, fromdate, todate));

    // ── Guard: missing data ───────────────────────────────────────────────
    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return { signal: "NO_TRADE", reason: "missing_data" };
    }

    const index1m  = format(indexRaw1m);
    const future1m = format(futureRaw1m);
    const data1D   = format(raw1D);

    // ── Guard: empty after format ─────────────────────────────────────────
    if (!index1m.length || !future1m.length) {
        logger.warn("⚠ Formatted data empty — skipping");
        return { signal: "NO_TRADE", reason: "empty_formatted_data" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PRICE-LEVEL GATE CHECK  (reuses index1m — zero extra API call)
    //
    //  Gate uses SENSEX index LTP, NOT the future price.
    //  Future has a premium/discount spread vs spot index.
    // ═══════════════════════════════════════════════════════════════════════
    const currentIndexLTPForGate = index1m[index1m.length - 1].close;
    logger.debug(`🔍 Gate index LTP: ${currentIndexLTPForGate} (from index1m)`);

    const gate = isPriceLevelGatePassed(currentIndexLTPForGate);
    if (!gate.passed) {
        logger.info(
            `🔒 GATE BLOCKED [${gate.reason}] | ` +
            `Need LTP to go ${gate.gateCrossDir} ${gate.gateLevel} | ` +
            `Current LTP: ${gate.currentLTP} | ${gate.ptsAway} pts away`
        );
        return { signal: "NO_TRADE", reason: gate.reason };
    }

    // ── Log candle info ───────────────────────────────────────────────────
    const latest = future1m[future1m.length - 1];
    logger.info(`📍 Candle [${latest.time}] O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close} V:${latest.volume} OI:${latest.oi}`);

    // ── Build 5m / 15m timeframes ─────────────────────────────────────────
    const index5m  = (indexRaw5m?.length)  ? format(indexRaw5m)  : buildTimeframe(index1m, 5);
    const index15m = (indexRaw15m?.length) ? format(indexRaw15m) : buildTimeframe(index1m, 15);

    if (!index5m.length)  logger.warn("⚠ 5m data empty after fallback");
    if (!index15m.length) logger.warn("⚠ 15m data empty after fallback");

    logger.info(`Timeframes → 1m:${index1m.length} 5m:${index5m.length} 15m:${index15m.length} 1D:${data1D.length}`);

    // ═══════════════════════════════════════════════════════════════════════
    //  SIGNAL GENERATION
    //  Worker thread runs indicators in parallel (if enabled).
    //  NOTE: wResult from worker is validation-only — generateSignal()
    //  is always called inline so signal state is in this thread.
    // ═══════════════════════════════════════════════════════════════════════
    let r;
    if (USE_WORKER_THREADS) {
        try {
            const wResult = await runIndicatorWorker({ index1m, index5m, index15m, future1m, data1D });
            if (!wResult.ok) throw new Error(wResult.error);
            // Worker confirms indicators computed OK — now generate signal inline
            r = generateSignal(index1m, index5m, index15m, future1m, data1D, _liveSessionState);
        } catch (err) {
            logger.warn(`⚠ Worker failed (${err.message}) — inline fallback`);
            r = generateSignal(index1m, index5m, index15m, future1m, data1D, _liveSessionState);
        }
    } else {
        r = generateSignal(index1m, index5m, index15m, future1m, data1D, _liveSessionState);
    }

    logger.info(`📍 LTP → Index:${r.indexLTP} Fut:${r.futureLTP} Bias:${r.dailyBias} Signal:${r.signal} Reason:${r?.reason}`);

    if (r.signal === "NO_TRADE") {
        logger.debug(`   Reason:${r.reason} ADX:${r.currentADX} RSI:${r.currentRSI} ATR:${r.currentATR}`);
        return { signal: "NO_TRADE", reason: r.reason ?? "conditions_not_met" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PRICE LEVELS
    // ═══════════════════════════════════════════════════════════════════════
    const isPE       = r.signal === "PE";
    const entryPrice = parseFloat(r.indexLTP) || index1m[index1m.length - 1].close;

    const slPrice  = isPE
        ? parseFloat((entryPrice + r.dynamicSL).toFixed(2))
        : parseFloat((entryPrice - r.dynamicSL).toFixed(2));
    const tgtPrice = isPE
        ? parseFloat((entryPrice - r.dynamicTGT).toFixed(2))
        : parseFloat((entryPrice + r.dynamicTGT).toFixed(2));
    const riskReward = (r.dynamicTGT / r.dynamicSL).toFixed(2);

    logger.info(`🎯 Entry:${entryPrice} SL:${slPrice} TGT:${tgtPrice} RR:${riskReward}`);

    // ═══════════════════════════════════════════════════════════════════════
    //  ATM OPTION FETCH
    // ═══════════════════════════════════════════════════════════════════════
    let optionToken = null, optionSymbol = null, optionLTP = null;
    let atmStrike = null, optionExpiry = null;

    try {
        const atm = await getATMOptionTokens(
            process.env.INDEX_SYMBOL || "SENSEX", entryPrice, jwt,
            undefined, undefined, undefined, isPE ? "PE" : "CE"
        );

        if (atm) {
            atmStrike    = atm.strike;
            optionExpiry = new Date(atm.expiry).toDateString();
            optionToken  = isPE ? atm.peToken  : atm.ceToken;
            optionSymbol = isPE ? atm.peSymbol : atm.ceSymbol;
            logger.info(`📌 ATM: ${optionSymbol} Strike:${atmStrike} Expiry:${optionExpiry}`);

            await sleep(300);
            const reqPayload = {};
            reqPayload[process.env.EXCHANGE_SEGMENT || "BFO"] = [optionToken];
            const ltpData = await getLTP(jwt, reqPayload);

            if (ltpData && ltpData.length) {
                optionLTP = parseFloat(ltpData[0].ltp.toFixed(2));
                logger.info(`💰 Option LTP: ${optionLTP}`);
            } else {
                logger.warn("⚠ Option LTP empty — aborting signal");
                return { signal: "NO_TRADE", reason: "option_ltp_empty" };
            }
        } else {
            logger.warn("⚠ ATM tokens unavailable — aborting signal");
            return { signal: "NO_TRADE", reason: "atm_unavailable" };
        }
    } catch (err) {
        logger.error(`❌ ATM fetch error: ${err.message}`);
        return { signal: "NO_TRADE", reason: "atm_fetch_error" };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TELEGRAM ALERT
    // ═══════════════════════════════════════════════════════════════════════
    const slArrow  = isPE ? "⬆" : "⬇";
    const tgtArrow = isPE ? "⬇" : "⬆";
    const header   = isPE ? "🔴 *SHORT  |  PE SIGNAL*" : "🟢 *LONG   |  CE SIGNAL*";
    const biasIcon = isPE ? "📉" : "📈";

    const structure = isPE
        ? (r.bearishStructure ? "✅ LH+LL" : "❌ Weak")
        : (r.bullishStructure ? "✅ HH+HL" : "❌ Weak");
    const rsiLine = isPE
        ? `${r.currentRSI}  ${r.rsiBearish ? "✅ <45" : "❌"}`
        : `${r.currentRSI}  ${r.rsiBullish ? "✅ >55" : "❌"}`;
    const trendLine = isPE
        ? `${r.trendDown ? "✅" : "❌"}  BreakDown: ${r.breakDown ? "✅" : "❌"}`
        : `${r.trendUp  ? "✅" : "❌"}  BreakUp:   ${r.breakUp  ? "✅" : "❌"}`;

    const optionSection = `
┌─── 🏷  Option Info ────────────────
│  Symbol  : ${optionSymbol}
│  Strike  : ${atmStrike}   Expiry: ${optionExpiry}
│  LTP     : ₹${optionLTP}
│  SL      : ₹${process.env.OPTION_SL}
│  Target  : ₹${process.env.OPTION_TGT}
└────────────────────────────────────`;

    const gapLine = r.gapLabel ? `\n📌 ${r.gapLabel}` : "";

    const msg =
`${header}

${biasIcon} ${r.dailyBias}   🕒 ${getISTTime()}${gapLine}

┌─── 💹  Trade Levels ───────────────
│  Entry   : ${entryPrice}
│  SL      : ${slPrice}  (${r.dynamicSL} pts ${slArrow})
│  Target  : ${tgtPrice}  (${r.dynamicTGT} pts ${tgtArrow})
│  R:R     : 1 : ${riskReward}
└────────────────────────────────────${optionSection}
┌─── 📊  Market ─────────────────────
│  Index   : ${r.indexLTP}   Future: ${r.futureLTP}
└────────────────────────────────────
┌─── ✅  Conditions ──────────────────
│  Structure  : ${structure}
│  ADX(14)    : ${r.currentADX}  ${r.trendStrong  ? "✅ Strong" : "❌ Weak"}
│  RSI(14)    : ${rsiLine}
│  ATR(14)    : ${r.currentATR}
│  Trend      : ${trendLine}
│  BigCandle  : ${r.bigCandle      ? "✅" : "❌"}
│  StrongBreak: ${r.breakoutStrong ? "✅" : "❌"}
│  Volume     : ${r.volConfirm     ? "✅ OK" : "❌ Low"}
└────────────────────────────────────
`;

    tradeLogger.info(msg);
    await sendTelegram(msg);

    // ═══════════════════════════════════════════════════════════════════════
    //  SIGNAL OBJECT
    // ═══════════════════════════════════════════════════════════════════════
    const signalObj = {
        signal:       r.signal,
        entryPrice,
        slPrice,
        tgtPrice,
        slPoints:     r.dynamicSL,
        tgtPoints:    r.dynamicTGT,
        riskReward,
        optionSymbol,
        optionToken,
        optionLTP,
        optionSL:     parseFloat(process.env.OPTION_SL  ?? "50"),
        optionTarget: parseFloat(process.env.OPTION_TGT ?? "300"),
    };

    // ═══════════════════════════════════════════════════════════════════════
    //  PLACE ORDER
    //
    //  FIX #1 — _tradeLock set BEFORE addOrderJob so no second signal
    //           can slip through while order is in-flight.
    //
    //  FIX #2 — openPosition() called HERE (direct path) so positionManager
    //           always tracks the trade regardless of queue mode.
    //           Queue path calls openPosition() in worker "completed" event.
    // ═══════════════════════════════════════════════════════════════════════
    _tradeLock = true;

    const orderOk = await addOrderJob(signalObj, jwt);
    if (!orderOk) {
        logger.error("❌ Order placement failed — lock released");
        _tradeLock = false;
        return { signal: "NO_TRADE", reason: "order_failed" };
    }

    // Direct execution path — open position immediately after confirmed order
    if (!USE_QUEUE) {
        openPosition(signalObj);
    }
    // Queue path — openPosition() is called inside orderQueue.js
    // worker "completed" event after broker confirms the order.

    return signalObj;
}

// ═════════════════════════════════════════════════════════════════════════════
//  onTradeExit
//  ───────────
//  Called from main.js safeExit() after every trade closes.
//  Records exit → activates price-level gate → blocks re-entry until
//  index LTP crosses the SL or TGT level of the closed trade.
// ═════════════════════════════════════════════════════════════════════════════
export function onTradeExit(pnl, reason = "UNKNOWN", exitPrice = NaN) {
    const pos = getPosition();   // snapshot BEFORE closePosition clears it

    closePosition(reason, exitPrice);
    recordTrade(pnl);
    _tradeLock = false;

    logger.info(`📊 Trade closed: ${reason} | PnL: ${pnl > 0 ? "+" : ""}${pnl}`);

    // ── Record exit + activate price-level gate ───────────────────────────
    const entryPx = pos?.entry ?? NaN;
    const exitPx  = isNaN(exitPrice) ? entryPx : exitPrice;
    const side     = pos?.side ?? null;

    // pos.sl and pos.target are absolute index prices set by openPosition()
    const slLevelFromPos  = pos?.sl     ?? null;
    const tgtLevelFromPos = pos?.target ?? null;

    if (!isNaN(entryPx) && side) {
        recordExit({
            reason,
            exitPrice:  exitPx,
            entryPrice: entryPx,
            side,
            slLevel:  slLevelFromPos,
            tgtLevel: tgtLevelFromPos,
        });
    } else {
        logger.warn("⚠ onTradeExit: missing entry/side — gate not set");
    }

    // ── Consecutive loss counter ───────────────────────────────────────────
    if (reason === "SL") {
        _liveSessionState.consecutiveLosses++;
        logger.warn(`⚠ Consecutive losses: ${_liveSessionState.consecutiveLosses}/${process.env.MAX_CONSEC_LOSS ?? 3}`);
    } else if (reason === "TGT" || reason === "EOD") {
        _liveSessionState.consecutiveLosses = 0;
    }

    _liveSessionState.tradesToday++;
}

// ═════════════════════════════════════════════════════════════════════════════
//  checkAndHandleIndexExit
//  ────────────────────────
//  Called from main.js polling loop AND WebSocket tick handler.
//  Checks live index LTP against open position SL/TGT.
//  On trigger: broker exit → safeExit → onTradeExit → recordExit → gate set.
//  Next entry is blocked until index LTP crosses the gate level.
// ═════════════════════════════════════════════════════════════════════════════
export async function checkAndHandleIndexExit(currentIndexLTP, safeExit, jwt, marketExitFn) {
    if (!isOpen()) return false;

    const pos = getPosition();
    if (!pos || pos.side === "NO_TRADE") return false;

    const result = checkIndexExitCondition({
        currentIndexLTP,
        entryPrice: pos.entry,
        slPoints:   pos.slPoints,
        tgtPoints:  pos.tgtPoints,
        side:       pos.side,
    });

    if (!result.triggered) return false;

    logger.info(
        `🎯 INDEX EXIT | Reason:${result.reason} LTP:${result.ltp} ` +
        `SL_Level:${result.slLevel} TGT_Level:${result.tgtLevel}`
    );

    // ── Telegram alert ────────────────────────────────────────────────────
    const icon = result.reason === "TGT" ? "✅" : "🛑";
    const gateMsg = result.reason === "SL"
        ? (pos.side === "CE" ? `ABOVE ${result.slLevel}`  : `BELOW ${result.slLevel}`)
        : (pos.side === "CE" ? `BELOW ${result.tgtLevel}` : `ABOVE ${result.tgtLevel}`);

    const alertMsg =
        `${icon} *INDEX ${result.reason} HIT*\n\n` +
        `Side   : ${pos.side}\n` +
        `Entry  : ${pos.entry}\n` +
        `Exit   : ${result.ltp}\n` +
        `Level  : ${result.reason === "TGT" ? result.tgtLevel : result.slLevel}\n` +
        `Symbol : ${pos.optionSymbol ?? "N/A"}\n` +
        `🕒 ${getISTTime()}\n\n` +
        `🔒 Gate set — next trade after index crosses ${gateMsg}`;

    try { await sendTelegram(alertMsg); } catch (_) { /* non-fatal */ }

    // ── Broker exit ───────────────────────────────────────────────────────
    if (marketExitFn && pos.optionSymbol) {
        try {
            await marketExitFn(jwt, pos.optionSymbol);
        } catch (e) {
            logger.error(`❌ marketExit error: ${e.message}`);
        }
    }

    // ── PnL in index points ───────────────────────────────────────────────
    const isPE = pos.side === "PE";
    const pnl  = parseFloat((isPE ? pos.entry - result.ltp : result.ltp - pos.entry).toFixed(2));

    // safeExit → onTradeExit → recordExit → gate activated
    safeExit(pnl, result.reason, result.ltp);
    return true;
}