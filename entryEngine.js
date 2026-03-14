import dotenv from "dotenv";
dotenv.config();

import { logger, tradeLogger, getISTTime } from "./logger.js";
import { sleep, getDailyFromDate, getTodayFromDate, formatISTDateTime, buildTimeframe } from "./helpers.js";
import { getHistorical, getFuture, format } from "./historical.js";
import { getATMOptionTokens, getLTP } from "./getStrick.js";
import { generateSignal } from "./signals.js";
import { sendTelegram } from "./telegram.js";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import path from "path";

import { canTrade, recordTrade, getRiskStatus, resetDaily } from "./riskEngine.js";
import { isFlat, isOpen, openPosition, closePosition, getPosition, logStatus } from "./positionManager.js";
import { setCandles, getCandles, invalidate } from "./redisCache.js";
import { addOrderJob } from "./orderQueue.js";

const USE_WORKER_THREADS = process.env.USE_WORKER_THREADS === "true";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    return raw;
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
        _liveSessionState.consecutiveLosses = 0;
        _liveSessionState.tradesToday = 0;
        _liveSessionState.lastTradeMinute = -999;
    }
}

// ── Execution mutex ───────────────────────────────────────────────────────
let _tradeLock = false;
let _iterationCount = 0;

// ── Last signal Redis cache helpers ──────────────────────────────────────
//  Key: "lastSignal"
//  Value: { signal, entryPrice, slPrice, tgtPrice, slPoints, tgtPoints, side }
//  Purpose: When the next signal arrives, FIRST check if the PREVIOUS signal's
//           SENSEX SL or TGT level was already crossed. If not yet crossed →
//           block new entry (last trade may still be live / pending broker exit).
//           If crossed → allow new signal.

const LAST_SIGNAL_KEY = "lastSignal";

async function saveLastSignal(signalObj) {
    try {
        const payload = JSON.stringify({
            signal: signalObj.signal,
            entryPrice: signalObj.entryPrice,
            slPrice: signalObj.slPrice,
            tgtPrice: signalObj.tgtPrice,
            slPoints: signalObj.slPoints,
            tgtPoints: signalObj.tgtPoints,
            side: signalObj.signal,   // "CE" | "PE"
            savedAt: Date.now(),
        });
        await setCandles(LAST_SIGNAL_KEY, payload, "1m");
        logger.info(`💾 lastSignal cached → ${signalObj.signal} Entry:${signalObj.entryPrice} SL:${signalObj.slPrice} TGT:${signalObj.tgtPrice}`);
    } catch (e) {
        logger.warn(`⚠ saveLastSignal failed: ${e.message}`);
    }
}

async function clearLastSignal() {
    try {
        await invalidate(LAST_SIGNAL_KEY);   // redis.del() — no null.length crash
        logger.info("🗑  lastSignal cleared from cache");
    } catch (e) {
        logger.warn(`⚠ clearLastSignal failed: ${e.message}`);
    }
}

async function getLastSignal() {
    try {
        const raw = await getCandles(LAST_SIGNAL_KEY);
        if (!raw) return null;
        // getCandles returns parsed JSON or string depending on how it was stored
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!obj || !obj.signal) return null;
        return obj;
    } catch (e) {
        logger.warn(`⚠ getLastSignal failed: ${e.message}`);
        return null;
    }
}

/**
 * checkLastSignalExited
 * ─────────────────────
 * Called at the START of every loop tick, BEFORE processing a new signal.
 *
 * Flow:
 *   1. Load "lastSignal" from Redis.
 *   2. Fetch the latest SENSEX index LTP (1m candle).
 *   3. Compute whether SL or TGT was crossed for that saved signal.
 *   4a. If crossed  → clear lastSignal from Redis, return { exited: true, reason }
 *   4b. If NOT yet  → return { exited: false, reason: "pending" }
 *       → entryEngine must block new signal until 4a happens.
 *   5. If no lastSignal in Redis → return { exited: true } (nothing pending).
 *
 * @param {string} SYMBOLTOKEN  – e.g. "BSE_INDEX|SENSEX"
 * @param {string} fromdate     – same fromdate used by the loop
 * @param {string} todate       – same todate used by the loop
 */
async function checkLastSignalExited(SYMBOLTOKEN, fromdate, todate) {
    const last = await getLastSignal();
    if (!last) return { exited: true, reason: "no_pending_signal" };

    // Fetch latest index LTP
    let currentLTP = null;
    try {
        const iRaw = await getHistorical(null, null, SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate);
        const iData = format(iRaw);
        if (iData && iData.length) {
            currentLTP = parseFloat(iData[iData.length - 1].close);
        }
    } catch (e) {
        logger.warn(`⚠ checkLastSignalExited: LTP fetch failed (${e.message}) — blocking new signal`);
        return { exited: false, reason: "ltp_fetch_failed" };
    }

    if (currentLTP === null) {
        logger.warn("⚠ checkLastSignalExited: no LTP data — blocking new signal");
        return { exited: false, reason: "no_ltp_data" };
    }

    const isPE = last.side === "PE";

    // Recompute absolute SL/TGT levels from stored entry + points
    // (same logic as checkAndHandleIndexExit)
    const slLevel = isPE
        ? parseFloat((last.entryPrice + last.slPoints).toFixed(2))
        : parseFloat((last.entryPrice - last.slPoints).toFixed(2));
    const tgtLevel = isPE
        ? parseFloat((last.entryPrice - last.tgtPoints).toFixed(2))
        : parseFloat((last.entryPrice + last.tgtPoints).toFixed(2));

    let crossed = null;
    if (isPE) {
        if (currentLTP >= slLevel) crossed = "SL";
        else if (currentLTP <= tgtLevel) crossed = "TGT";
    } else {
        if (currentLTP <= slLevel) crossed = "SL";
        else if (currentLTP >= tgtLevel) crossed = "TGT";
    }

    logger.info(
        `🔍 LastSignal check | ${last.side} Entry:${last.entryPrice} ` +
        `SL_Level:${slLevel} TGT_Level:${tgtLevel} CurrentLTP:${currentLTP} ` +
        `→ ${crossed ?? "NOT_CROSSED"}`
    );

    if (crossed) {
        logger.info(`✅ Last signal ${crossed} confirmed at LTP:${currentLTP} — clearing cache`);
        await clearLastSignal();
        return { exited: true, reason: crossed, ltp: currentLTP };
    }

    // Not yet crossed — block new entry
    return {
        exited: false,
        reason: "pending_exit",
        ltp: currentLTP,
        slLevel,
        tgtLevel,
        lastSide: last.side,
        lastEntry: last.entryPrice,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY ENGINE
// ═════════════════════════════════════════════════════════════════════════════
export async function entryEngine(fromdate, todate, futureToken) {

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

    // ── Last signal SL/TGT cross check ───────────────────────────────────────
    //  Before allowing a NEW signal, verify that the PREVIOUS signal's index
    //  level was already crossed (SL or TGT hit). If the last trade's exit
    //  level hasn't been crossed yet, the broker order may still be live —
    //  block new entry to avoid double positions.
    //
    //  This is stored in Redis under key "lastSignal" and is independent of
    //  positionManager (which tracks the current open position in memory/disk).
    //  The Redis check catches the gap between:
    //    order placed → broker filled → positionManager.closePosition() called
    //  during which isOpen() may already be FALSE but the index hasn't
    //  crossed SL/TGT yet.
    const SYMBOLTOKEN = process.env.SYMBOLTOKEN;
    if (!SYMBOLTOKEN) {
        logger.error("❌ SYMBOLTOKEN not set");
        return { signal: "NO_TRADE", reason: "missing_SYMBOLTOKEN" };
    }

    {
        const exitCheck = await checkLastSignalExited(SYMBOLTOKEN, fromdate, todate);
        if (!exitCheck.exited) {
            logger.info(
                `⏳ Waiting for last signal exit | ${exitCheck.lastSide} @ ${exitCheck.lastEntry} | ` +
                `LTP:${exitCheck.ltp} SL:${exitCheck.slLevel} TGT:${exitCheck.tgtLevel} | ` +
                `Reason: ${exitCheck.reason}`
            );
            return { signal: "NO_TRADE", reason: `last_signal_pending_exit` };
        }
        if (exitCheck.reason !== "no_pending_signal") {
            logger.info(`✅ Last signal exit confirmed (${exitCheck.reason} @ ${exitCheck.ltp}) — new signal allowed`);
        }
    }

    const dailyFrom = getDailyFromDate();
    const indexRaw1m = await cachedFetch(`index1m_${todate}`, "1m", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate)); await sleep(400);
    const indexRaw5m = await cachedFetch(`index5m_${todate}`, "5m", () => getHistorical(null, null, SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate)); await sleep(400);
    const indexRaw15m = await cachedFetch(`index15m_${todate}`, "15m", () => getHistorical(null, null, SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate)); await sleep(400);
    const raw1D = await cachedFetch(`index1D_${dailyFrom}`, "1D", () => getHistorical(null, null, SYMBOLTOKEN, "ONE_DAY", dailyFrom, todate)); await sleep(400);
    const futureRaw1m = await cachedFetch(`future1m_${todate}`, "1m", () => getFuture(futureToken, fromdate, todate));

    const index1m = format(indexRaw1m);
    const future1m = format(futureRaw1m);
    const data1D = format(raw1D);

    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return { signal: "NO_TRADE", reason: "missing_data" };
    }

    const latest = future1m[future1m.length - 1];
    logger.info(`📍 Candle [${latest.time}] O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close} V:${latest.volume} OI:${latest.oi}`);

    const index5m = (indexRaw5m && indexRaw5m.length) ? format(indexRaw5m) : buildTimeframe(index1m, 5);
    const index15m = (indexRaw15m && indexRaw15m.length) ? format(indexRaw15m) : buildTimeframe(index1m, 15);

    if (!index5m.length) logger.warn("⚠ 5m data empty after fallback");
    if (!index15m.length) logger.warn("⚠ 15m data empty after fallback");

    logger.info(`Timeframes → 1m:${index1m.length} 5m:${index5m.length} 15m:${index15m.length} 1D:${data1D.length}`);

    // ── Indicators / Signal ───────────────────────────────────────────────
    let r;
    if (USE_WORKER_THREADS) {
        try {
            const wResult = await runIndicatorWorker({ index1m, index5m, index15m, future1m, data1D });
            if (!wResult.ok) throw new Error(wResult.error);
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

    // ── Price levels ──────────────────────────────────────────────────────
    const isPE = r.signal === "PE";
    const entryPrice = parseFloat(r.indexLTP) || index1m[index1m.length - 1].close;

    const slPrice = isPE
        ? parseFloat((entryPrice + r.dynamicSL).toFixed(2))
        : parseFloat((entryPrice - r.dynamicSL).toFixed(2));
    const tgtPrice = isPE
        ? parseFloat((entryPrice - r.dynamicTGT).toFixed(2))
        : parseFloat((entryPrice + r.dynamicTGT).toFixed(2));
    const riskReward = (r.dynamicTGT / r.dynamicSL).toFixed(2);

    logger.info(`🎯 Entry:${entryPrice} SL:${slPrice} TGT:${tgtPrice} RR:${riskReward}`);

    // ── ATM Option fetch ──────────────────────────────────────────────────
    let optionToken = null, optionSymbol = null, optionLTP = null, atmStrike = null, optionExpiry = null;

    try {
        const atm = await getATMOptionTokens(
            process.env.INDEX_SYMBOL || "SENSEX", entryPrice,
            undefined, undefined, undefined, isPE ? "PE" : "CE"
        );
        if (atm) {
            atmStrike = atm.strike;
            optionExpiry = new Date(atm.expiry).toDateString();
            optionToken = isPE ? atm.peToken : atm.ceToken;
            optionSymbol = isPE ? atm.peSymbol : atm.ceSymbol;
            logger.info(`📌 ATM: ${optionSymbol} Strike:${atmStrike} Expiry:${optionExpiry}`);

            await sleep(300);
            const reqPayload = {};
            reqPayload[process.env.EXCHANGE_SEGMENT || "BFO"] = [optionToken];
            const ltpData = await getLTP(reqPayload);

            if (ltpData.length) {
                optionLTP = parseFloat(ltpData[0].ltp.toFixed(2));
                logger.info(`💰 Option LTP: ${optionLTP}`);
            } else {
                logger.warn("⚠ Option LTP empty — aborting signal");
                return { signal: "NO_TRADE", reason: "option_ltp_empty" };
            }
        } else {
            logger.warn("⚠ ATM tokens unavailable");
        }
    } catch (err) {
        logger.error(`❌ ATM fetch error: ${err.message}`);
        return { signal: "NO_TRADE", reason: "atm_fetch_error" };
    }

    // ── Telegram ──────────────────────────────────────────────────────────
    const slArrow = isPE ? "⬆" : "⬇";
    const tgtArrow = isPE ? "⬇" : "⬆";
    const header = isPE ? "🔴 *SHORT  |  PE SIGNAL*" : "🟢 *LONG   |  CE SIGNAL*";
    const biasIcon = isPE ? "📉" : "📈";

    const structure = isPE
        ? (r.bearishStructure ? "✅ LH+LL" : "❌ Weak")
        : (r.bullishStructure ? "✅ HH+HL" : "❌ Weak");
    const rsiLine = isPE
        ? `${r.currentRSI}  ${r.rsiBearish ? "✅ <45" : "❌"}`
        : `${r.currentRSI}  ${r.rsiBullish ? "✅ >55" : "❌"}`;
    const trendLine = isPE
        ? `${r.trendDown ? "✅" : "❌"}  BreakDown: ${r.breakDown ? "✅" : "❌"}`
        : `${r.trendUp ? "✅" : "❌"}  BreakUp:   ${r.breakUp ? "✅" : "❌"}`;

    const optionSection = optionToken ? `
┌─── 🏷  Option Info ────────────────
│  Symbol  : ${optionSymbol}
│  Strike  : ${atmStrike}   Expiry: ${optionExpiry}
│  LTP     : ₹${optionLTP}
│  SL      : ₹${process.env.OPTION_SL}
│  Target  : ₹${process.env.OPTION_TGT}
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
│  BigCandle  : ${r.bigCandle ? "✅" : "❌"}  
|  StrongBreak: ${r.breakoutStrong ? "✅" : "❌"}
│  Volume     : ${r.volConfirm ? "✅ OK" : "❌ Low"}
└────────────────────────────────────
`;

    tradeLogger.info(msg);
    await sendTelegram(msg);

    // ── Signal object ─────────────────────────────────────────────────────
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
        optionSL: parseFloat(process.env.OPTION_SL ?? 50),
        optionTarget: parseFloat(process.env.OPTION_TGT ?? 300),
    };

    // ── Place order ───────────────────────────────────────────────────────
    _tradeLock = true;
    const orderOk = await addOrderJob(signalObj);
    if (!orderOk) {
        logger.error("❌ Order placement failed — lock released");
        _tradeLock = false;
        return { signal: "NO_TRADE", reason: "order_failed" };
    }

    // ── Cache signal in Redis for next-tick SL/TGT cross check ──────────
    //  Stored here (after order confirmed) so the next loop tick can verify
    //  whether this trade's index levels were crossed before allowing a new entry.
    await saveLastSignal(signalObj);

    return signalObj;
}

// ═════════════════════════════════════════════════════════════════════════════
//  onTradeExit
//  Called from main.js safeExit() after every trade closes.
// ═════════════════════════════════════════════════════════════════════════════
export function onTradeExit(pnl, reason = "UNKNOWN", exitPrice = NaN) {
    closePosition(reason, exitPrice);
    recordTrade(pnl);
    _tradeLock = false;

    logger.info(`📊 Trade closed: ${reason} | PnL: ${pnl > 0 ? "+" : ""}${pnl}`);

    // ── Clear last signal cache on confirmed exit ─────────────────────────
    //  When the trade exits via broker fill / index cross, the Redis
    //  "lastSignal" key is redundant — clear it so the next signal check
    //  doesn't block unnecessarily. clearLastSignal() is async but fire-and-forget
    //  here (non-critical — checkLastSignalExited will also clear on cross detection).
    clearLastSignal().catch(e => logger.warn(`⚠ clearLastSignal in onTradeExit: ${e.message}`));

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
//  checkAndHandleIndexExit  (exported — used by main.js polling + WS handler)
//  Checks index LTP against open position SL/TGT in index points.
//  If triggered: calls broker marketExit → safeExit → onTradeExit.
// ═════════════════════════════════════════════════════════════════════════════
export async function checkAndHandleIndexExit(currentIndexLTP, safeExit, marketExitFn) {
    if (!isOpen()) return false;

    const pos = getPosition();
    if (!pos || pos.side === "NO_TRADE") return false;

    const ltp = parseFloat(currentIndexLTP);
    const isPE = pos.side === "PE";

    const slLevel = isPE
        ? parseFloat((pos.entry + pos.slPoints).toFixed(2))
        : parseFloat((pos.entry - pos.slPoints).toFixed(2));
    const tgtLevel = isPE
        ? parseFloat((pos.entry - pos.tgtPoints).toFixed(2))
        : parseFloat((pos.entry + pos.tgtPoints).toFixed(2));

    let triggered = null;
    if (isPE) {
        if (ltp >= slLevel) triggered = "SL";
        else if (ltp <= tgtLevel) triggered = "TGT";
    } else {
        if (ltp <= slLevel) triggered = "SL";
        else if (ltp >= tgtLevel) triggered = "TGT";
    }

    if (!triggered) return false;

    logger.info(
        `🎯 INDEX EXIT | Reason:${triggered} LTP:${ltp} ` +
        `SL_Level:${slLevel} TGT_Level:${tgtLevel}`
    );

    // Telegram alert
    const icon = triggered === "TGT" ? "✅" : "🛑";
    const exitLevel = triggered === "TGT" ? tgtLevel : slLevel;
    const alertMsg =
        `${icon} *INDEX ${triggered} HIT*\n\n` +
        `Side   : ${pos.side}\n` +
        `Entry  : ${pos.entry}\n` +
        `Exit   : ${ltp}\n` +
        `Level  : ${exitLevel}\n` +
        `Symbol : ${pos.optionSymbol ?? "N/A"}\n🕒 ${getISTTime()}`;

    try { await sendTelegram(alertMsg); } catch (_) { /* non-fatal */ }

    // Broker exit
    if (marketExitFn && pos.optionSymbol) {
        try { await marketExitFn(pos.optionSymbol); } catch (e) {
            logger.error(`❌ marketExit error: ${e.message}`);
        }
    }

    // PnL in index points
    const pnl = parseFloat((isPE ? pos.entry - ltp : ltp - pos.entry).toFixed(2));
    safeExit(pnl, triggered, ltp);
    return true;
}