import dotenv from "dotenv";
dotenv.config();

import { logger, tradeLogger, getISTTime } from "./logger.js";
import { sleep, getDailyFromDate, calculateOptionLevels, buildTimeframe } from "./helpers.js";
import { getHistorical, getFuture, format } from "./api/historical.js";
import { getATMOptionTokens, getLTP, } from "./getStrick.js";
import { generateSignal } from "./signals.js";
import { sendTelegram } from "./telegram.js";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import path from "path";

// ── Feature-flag imports (graceful if deps not installed) ───────────────────
import { canTrade, recordTrade, getRiskStatus, resetDaily } from "./riskEngine.js";
import { isFlat, isOpen, openPosition, closePosition, getPosition, logStatus } from "./positionManager.js";
import { setCandles, getCandles } from "./redisCache.js";
import { addOrderJob } from "./orderQueue.js";

const USE_WORKER_THREADS = process.env.USE_WORKER_THREADS === "true";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
// Worker Thread: run indicator calculations off main thread
// ─────────────────────────────────────────
function runIndicatorWorker(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            path.join(__dirname, "indicatorWorker.js"),
            { workerData }
        );
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
    if (cached) return cached; // cache HIT

    const raw = await fetchFn();
    if (raw && raw.length) await setCandles(cacheKey, raw, tfLabel);
    return raw;
}

// ─────────────────────────────────────────
// Live session state — persists across loop ticks
// Updated by onTradeExit(), reset by maybeDailyReset()
// ─────────────────────────────────────────
const _liveSessionState = {
    consecutiveLosses: 0,
    tradesToday: 0,
    lastTradeMinute: -999,
};

// ─────────────────────────────────────────
// Daily reset tracker
// ─────────────────────────────────────────
let _lastResetDay = null;
function maybeDailyReset() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (_lastResetDay !== today) {
        _lastResetDay = today;
        resetDaily();
        // ✅ Reset consecutive loss counter on new trading day
        _liveSessionState.consecutiveLosses = 0;
        _liveSessionState.tradesToday = 0;
        _liveSessionState.lastTradeMinute = -999;
    }
}

// ── Execution mutex — prevents duplicate orders if loop outruns signal reset ──
let _tradeLock = false;
let _iterationCount = 0;

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY ENGINE (live)
// ═════════════════════════════════════════════════════════════════════════════
export async function entryEngine(jwt, fromdate, todate, futureToken) {

    // Guard: if a previous trade is still in-flight, skip this loop tick
    if (_tradeLock) {
        logger.warn("⚠ EntryEngine locked — trade in-flight, skipping loop tick");
        return { signal: "NO_TRADE", reason: "execution_locked" };
    }

    _iterationCount++;

    // ── Daily state reset at start of each new day ────────────────────────
    maybeDailyReset();

    // ── Log position status (Periodic if flat, every time if open) ─────────
    if (isOpen() || _iterationCount % 20 === 1) {
        logStatus();
    }

    // ── Risk Engine check: don't run if daily limits hit ─────────────────
    const risk = canTrade();
    if (!risk.allowed) {
        logger.warn(`🚨 RiskEngine BLOCKED: ${risk.reason}`);
        const rs = getRiskStatus();
        logger.info(
            `📊 Risk Status | Trades:${rs.dailyTrades}/${rs.maxTrades} | ` +
            `PnL:${rs.dailyPnL} | Reason:${rs.blockReason}`
        );
        return { signal: "NO_TRADE", reason: `risk_blocked_${risk.reason}` };
    }

    // ── If position already open, skip new signal ─────────────────────────
    if (isOpen()) {
        const pos = getPosition();
        logger.info(`⏳ Position already open: ${pos.side} @ ${pos.entry} — skipping new signal`);
        return { signal: "NO_TRADE", reason: "position_already_open" };
    }

    // ── Fetch market data (Redis-cached where enabled) ─────────────────────
    const SYMBOLTOKEN = process.env.SYMBOLTOKEN;
    if (!SYMBOLTOKEN) {
        logger.error("❌ SYMBOLTOKEN not set in .env — skipping signal");
        return { signal: "NO_TRADE", reason: "missing_SYMBOLTOKEN" };
    }

    // BUG 14 FIX: parallel fetch — 5 sequential awaits (5s) → Promise.all (~1s)
    // const dailyFrom = getDailyFromDate();
    // const [indexRaw1m, indexRaw5m, indexRaw15m, raw1D, futureRaw1m] = await Promise.all([
    //     cachedFetch(`index1m_${todate}`, "1m", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate)),
    //     cachedFetch(`index5m_${todate}`, "5m", () => getHistorical(null, null, SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate)),
    //     cachedFetch(`index15m_${todate}`, "15m", () => getHistorical(null, null, SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate)),
    //     cachedFetch(`index1D_${dailyFrom}`, "1D", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_DAY", dailyFrom, todate)),
    //     cachedFetch(`future1m_${todate}`, "1m", () => getFuture(futureToken, fromdate, todate)),
    // ]);

    const dailyFrom = getDailyFromDate();
    const indexRaw1m = await cachedFetch(`index1m_${todate}`, "1m", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate)); await sleep(400);
    const indexRaw5m = await cachedFetch(`index5m_${todate}`, "5m", () => getHistorical(null, null, SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate)); await sleep(400);
    const indexRaw15m = await cachedFetch(`index15m_${todate}`, "15m", () => getHistorical(null, null, SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate)); await sleep(400);
    const raw1D = await cachedFetch(`index1D_${dailyFrom}`, "1D", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_DAY", dailyFrom, todate)); await sleep(400);
    const futureRaw1m = await cachedFetch(`future1m_${todate}`, "1m", () => getFuture(futureToken, fromdate, todate));


    const index1m = format(indexRaw1m);
    let future1m = format(futureRaw1m);
    const data1D = format(raw1D);

    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return { signal: "NO_TRADE", reason: "missing data" };
    }

    // ── Stale data guard ─────────────────────────────────────────────────
    // In live mode the last future candle must be recent.
    // If the API returns only old data (holiday gap, rate-limit, etc.)
    // we must NOT generate a signal — the price, ATM strike, and option
    // tokens would all be wrong relative to the real market right now.
    const lastFutureCandle = future1m[future1m.length - 1];

    const staleLimitMs = 3 * 60 * 1000; // 3 minutes
    const candleAgeMs = Date.now() - new Date(lastFutureCandle.time).getTime();
    if (candleAgeMs > staleLimitMs) {
        logger.warn(`⚠ Future candle stale by ${(candleAgeMs / 60000).toFixed(1)}m — skipping signal to avoid wrong strike/price`);
        return { signal: "NO_TRADE", reason: "stale_future_candle" };
    }

    // ── Combine candle and price data logging ─────────────────────────────
    const latest = future1m[future1m.length - 1];
    logger.info(`📍 Candle [${latest.time}] O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close} V:${latest.volume} OI:${latest.oi}`);

    // ── Fall back to building 5m / 15m from 1m when API returns empty
    const index5m = (indexRaw5m && indexRaw5m.length) ? format(indexRaw5m) : buildTimeframe(index1m, 5);
    const index15m = (indexRaw15m && indexRaw15m.length) ? format(indexRaw15m) : buildTimeframe(index1m, 15);

    if (!index5m.length) logger.warn("⚠ 5m data empty even after buildTimeframe fallback");
    if (!index15m.length) logger.warn("⚠ 15m data empty even after buildTimeframe fallback");

    logger.info(`Timeframes → 1m:${index1m.length} 5m:${index5m.length} 15m:${index15m.length} 1D:${data1D.length}`);

    // ── Indicator computation (Worker Thread or inline) ───────────────────
    let r;
    if (USE_WORKER_THREADS) {
        try {
            logger.debug("🧵 Worker Thread: running indicators...");
            // Worker computes indicators; generateSignal still runs on main thread
            // for signal logic (uses pre-computed arrays via injected results)
            const workerResult = await runIndicatorWorker({
                index1m, index5m, index15m, future1m, data1D
            });
            if (!workerResult.ok) throw new Error(workerResult.error);
            logger.debug(`🧵 Worker Thread: done (warnings: ${workerResult.warnings.join(",") || "none"})`);
            // Fall through to generateSignal which re-uses full data sets
            // (worker pre-validates; actual signal struct built in main thread)
            r = generateSignal(index1m, index5m, index15m, future1m, data1D, _liveSessionState);
        } catch (err) {
            logger.warn(`⚠ Worker Thread failed (${err.message}) — falling back to inline`);
            r = generateSignal(index1m, index5m, index15m, future1m, data1D, _liveSessionState);
        }
    } else {
        r = generateSignal(index1m, index5m, index15m, future1m, data1D, _liveSessionState);
    }

    logger.info(`📍 LTP → Index:${r.indexLTP}  Fut:${r.futureLTP} Bias:${r.dailyBias}  Signal:${r.signal}`);


    if (r.signal === "NO_TRADE") {
        logger.debug(`   Reason: ${r.reason} | ADX:${r.currentADX} RSI:${r.currentRSI} ATR:${r.currentATR} | trend↑${r.trendUp} ↓${r.trendDown}`);
        return { signal: "NO_TRADE", reason: r.reason ?? "conditions not met" };
    }

    // ── Price levels
    const isPE = r.signal === "PE";
    const lastCandle = index1m[index1m.length - 1];
    const entryPrice = parseFloat(r.indexLTP) || index1m[index1m.length - 1].close;

    const slPrice = isPE
        ? parseFloat((entryPrice + r.dynamicSL).toFixed(2))
        : parseFloat((entryPrice - r.dynamicSL).toFixed(2));
    const tgtPrice = isPE
        ? parseFloat((entryPrice - r.dynamicTGT).toFixed(2))
        : parseFloat((entryPrice + r.dynamicTGT).toFixed(2));
    const riskReward = (r.dynamicTGT / r.dynamicSL).toFixed(2);

    logger.info(`🎯 Entry:${entryPrice} | SL:${slPrice} | TGT:${tgtPrice} | RR:${riskReward}`);

    // ── ATM Option Token fetch
    // IMPORTANT: always use real Date.now() — not lastCandle.time.
    // lastCandle.time may lag by several minutes; using it would cause
    // getATMOptionTokens to pick an expiry that has already expired today.
    let optionToken = null, optionSymbol = null, optionLTP = null, atmStrike = null, optionExpiry = null;
    let optionSL = null, optionTarget = null;

    try {
        const atm = await getATMOptionTokens(process.env.INDEX_SYMBOL || "SENSEX", entryPrice, jwt, new Date());

        if (atm) {
            atmStrike = atm.strike;
            optionExpiry = new Date(atm.expiry).toDateString();
            optionToken = isPE ? atm.peToken : atm.ceToken;
            optionSymbol = isPE ? atm.peSymbol : atm.ceSymbol;

            logger.info(`📌 ATM: ${optionSymbol} | Strike:${atmStrike} | Expiry:${optionExpiry}`);

            await sleep(300);
            const reqPayload = {};
            reqPayload[process.env.EXCHANGE_SEGMENT || "BFO"] = [optionToken];
            const ltpData = await getLTP(jwt, reqPayload);

            if (ltpData.length) {
                optionLTP = parseFloat(ltpData[0].ltp.toFixed(2));
                logger.info(`💰 Option LTP  : ${optionLTP}`);

                const levels = calculateOptionLevels({
                    indexEntry: entryPrice,
                    indexSL: slPrice,
                    indexTarget: tgtPrice,
                    optionLTP,
                });
                optionSL = parseFloat(levels.optionSL.toFixed(2));
                optionTarget = parseFloat(levels.optionTarget.toFixed(2));
                logger.info(`📐 Option SL   : ${optionSL}  | Option TGT: ${optionTarget}`);
            } else {
                // LTP fetch failed (option may be expired or illiquid).
                // Abort here — do NOT alert Telegram or place order without a live LTP.
                logger.warn("⚠ Option LTP fetch returned empty — option may be expired or illiquid. Aborting signal.");
                return { signal: "NO_TRADE", reason: "option_ltp_empty" };
            }
        } else {
            logger.warn("⚠ ATM tokens unavailable — continuing without option data");
        }
    } catch (err) {
        logger.error(`❌ ATM fetch error: ${err.message}`);
        return { signal: "NO_TRADE", reason: "atm_fetch_error" };

    }

    // ── Telegram message ─────────────────────────────────────────────────────
    const slArrow = isPE ? "⬆" : "⬇";
    const tgtArrow = isPE ? "⬇" : "⬆";

    const structure = isPE
        ? (r.bearishStructure ? "✅ LH+LL" : "❌ Weak")
        : (r.bullishStructure ? "✅ HH+HL" : "❌ Weak");

    const rsiLine = isPE
        ? `${r.currentRSI}  ${r.rsiBearish ? "✅ <45" : "❌"}`
        : `${r.currentRSI}  ${r.rsiBullish ? "✅ >55" : "❌"}`;

    const trendLine = isPE
        ? `${r.trendDown ? "✅" : "❌"}  BreakDown: ${r.breakDown ? "✅" : "❌"}`
        : `${r.trendUp ? "✅" : "❌"}  BreakUp:   ${r.breakUp ? "✅" : "❌"}`;

    const header = isPE
        ? "🔴 *SHORT  |  PE SIGNAL*"
        : "🟢 *LONG   |  CE SIGNAL*";

    const biasIcon = isPE ? "📉" : "📈";

    const optionSection = optionToken ? `
┌─── 🏷  Option Info ────────────────
│  Symbol  : ${optionSymbol}
│  Strike  : ${atmStrike}   Expiry: ${optionExpiry}
│  LTP     : ₹${optionLTP}
│  SL      : ₹${optionSL}
│  Target  : ₹${optionTarget}
└────────────────────────────────────` : "";

    const gapLine = r.gapLabel ? `\n📌 ${r.gapLabel}` : "";

    const msg = `${header}

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
│  ADX(14)    : ${r.currentADX}  ${r.trendStrong ? "✅ Strong" : "❌ Weak"}
│  RSI(14)    : ${rsiLine}
│  ATR(14)    : ${r.currentATR}
│  Trend      : ${trendLine}
│  BigCandle  : ${r.bigCandle ? "✅" : "❌"}   StrongBreak: ${r.breakoutStrong ? "✅" : "❌"}
│  Volume     : ${r.volConfirm ? "✅ OK" : "❌ Low"}
└────────────────────────────────────
`;

    tradeLogger.info(msg);
    await sendTelegram(msg);

    // ── Proper signalObj construction ───────────────────────────────────────
    const signalObj = {
        signal: r.signal,
        entryPrice,
        slPrice,
        tgtPrice,
        slPoints: r.dynamicSL,
        tgtPoints: r.dynamicTGT,
        riskReward,
        optionSymbol,
        optionToken,
        optionLTP,
        optionSL,
        optionTarget
    };

    // ── Place order FIRST — only open position if order succeeds ───────────
    _tradeLock = true;   // ⚠ Lock: no new entries until this trade resolves

    const orderOk = await addOrderJob(signalObj, jwt);

    if (!orderOk) {
        logger.error("❌ Order placement failed — position NOT opened, lock released");
        _tradeLock = false;
        return { signal: "NO_TRADE", reason: "order_failed" };
    }

    // ── Open position in Position Manager AFTER order is confirmed ─────────
    openPosition(signalObj);

    // Lock stays ON — released via onTradeExit() when the trade closes
    return signalObj;
}

/**
 * Called externally (e.g. from main.js) when a trade exits.
 * Updates Risk Engine with final PnL.
 * @param {number} pnl - index points, positive=profit negative=loss
 * @param {string} reason - "SL" | "TGT" | "EOD" | "MANUAL"
 */
export function onTradeExit(pnl, reason = "UNKNOWN", exitPrice = NaN) {
    closePosition(reason, exitPrice);
    recordTrade(pnl);
    _tradeLock = false;   // ✅ Unlock: bot can accept a new entry now
    logger.info(`📊 Trade closed: ${reason} | PnL: ${pnl > 0 ? "+" : ""}${pnl}`);

    // ── Update consecutive loss counter for circuit breaker
    if (reason === "SL") {
        _liveSessionState.consecutiveLosses++;
        logger.warn(`⚠ Consecutive losses: ${_liveSessionState.consecutiveLosses}/${process.env.MAX_CONSEC_LOSS ?? 3}`);
    } else if (reason === "TGT" || reason === "EOD") {
        _liveSessionState.consecutiveLosses = 0; // win/EOD resets streak
    }
    _liveSessionState.tradesToday++;
}