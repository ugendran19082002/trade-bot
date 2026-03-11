import dotenv from "dotenv";
dotenv.config();

import { createRequire } from "module";
const require = createRequire(import.meta.url);

// ── Load config-driven strategy parameters ─────────────────────────────────
let CFG;
try {
    CFG = require("./strategy.config.json");
} catch (e) {
    // Fallback defaults if config file missing
    CFG = require("./strategy.config.default.json");
}

import { buildTimeframe } from "./helpers.js";
import {
    calculateEMA,
    calculateRSI,
    calculateATR,
    calculateADX,
    volumeSpike,
    calculateVWAP
} from "./indicators.js";

import { logger } from "./logger.js";

// ─────────────────────────────────────────
// BASE DIAGNOSTIC OBJECT
// FIX #7 — Added `warnings: []` field for surfacing fallback conditions
// ─────────────────────────────────────────
const getBaseDiag = (indexLTP = "0.00", futureLTP = "0.00") => ({
    indexLTP,
    futureLTP,
    dailyBias: "N/A",
    emaAbove: false,
    bullCandle: false,
    bearCandle: false,
    gapUp: false,
    gapDown: false,
    gapLabel: "N/A",
    gapPoints: 0,
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false,
    bullishStructure: false,
    bearishStructure: false,
    currentADX: "0.0",
    currentRSI: "50.0",
    currentATR: "0.00",
    currentEMA: "0.00",
    trendStrong: false,
    rsiBullish: false,
    rsiBearish: false,
    trendUp: false,
    trendDown: false,
    dynamicSL: 0,
    dynamicTGT: 0,
    slPrice: 0,   // ✅ FIX #6 — absolute SL price level
    tgtPrice: 0,   // ✅ FIX #6 — absolute target price level
    bigCandle: false,
    strongBody: false,
    breakUp: false,
    breakDown: false,

    volConfirm: false,
    exhaustedBull: false,
    exhaustedBear: false,
    volume: 0,
    oi: 0,
    finalSupports: [],
    finalResistances: [],
    warnings: [],   // ✅ FIX #7 — degraded signal visibility
    // ── PRO FILTERS ─────────────────────────
    vwap: null,
    aboveVWAP: false,
    belowVWAP: false,
    trendAligned: false,
    breakoutStrong: false,
    timeAllowed: false,
    vwapDown: null,
    vwapUp: null
});

export function generateSignal(index1m, index5m, index15m, future1m, data1D, sessionState = {}
) {

    // ─────────────────────────────────────────
    // GUARD — Insufficient data
    // ─────────────────────────────────────────
    if (
        !index1m?.length ||
        !index5m?.length ||
        !index15m?.length ||
        !future1m?.length || index5m.length < 8
    ) {
        const ltp = index1m?.[index1m.length - 1]?.close?.toFixed(2) || "0.00";
        const fltp = future1m?.[future1m.length - 1]?.close?.toFixed(2) || "0.00";
        return {
            signal: "NO_TRADE",
            reason: "insufficient_timeframe_data",
            ...getBaseDiag(ltp, fltp)
        };
    }

    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5m = index5m[index5m.length - 1];
    const prev5m = index5m[index5m.length - 2];
    const lastFuture = future1m[future1m.length - 1];

    if (!last1m || !prev1m || !last5m || !prev5m || !lastFuture) {
        return {
            signal: "NO_TRADE",
            reason: "invalid_candle_structure",
            ...getBaseDiag(
                last1m?.close?.toFixed(2),
                lastFuture?.close?.toFixed(2)
            )
        };
    }

    // ─────────────────────────────────────────
    // PRO FILTER #1 — TIME FILTER (IST 9:18–15:00)
    // Avoid pre-open noise + end-of-day closing traps
    // Configurable via CFG.TIME_START_MIN (558) and CFG.TIME_END_MIN (900)
    // ─────────────────────────────────────────
    const istStr = new Date(last1m.time).toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istStr);
    const minuteOfDay = istDate.getHours() * 60 + istDate.getMinutes();
    const TIME_START = CFG.TIME_START_MIN; // default 9:18 IST
    const TIME_END = CFG.TIME_END_MIN;   // default 15:00 IST

    // ─────────────────────────────────────────
    // INITIAL DIAGNOSTIC
    // ─────────────────────────────────────────
    const diag = getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2));
    diag.warnings = [];

    diag.timeAllowed = minuteOfDay >= TIME_START && minuteOfDay <= TIME_END;

    // ─────────────────────────────────────────
    // DAILY BIAS
    // FIX #1 — Enforce minimum 20 daily candles for reliable EMA
    // ─────────────────────────────────────────
    const DAILY_EMA_PERIOD = CFG.DAILY_EMA_PERIOD;
    const dailyData = data1D?.length >= DAILY_EMA_PERIOD ? data1D : [];

    if (dailyData.length < DAILY_EMA_PERIOD) {
        diag.warnings.push("DAILY_EMA_INSUFFICIENT");
        return {
            signal: "NO_TRADE",
            reason: "insufficient_daily_ema_data",
            ...diag
        };
    }

    const dailyEMA = calculateEMA(dailyData, DAILY_EMA_PERIOD); // ✅ SMA-seeded
    const dailyLast = dailyData[dailyData.length - 1];
    const prevDay = dailyData[dailyData.length - 2];

    const lastDailyEMA = dailyEMA[dailyEMA.length - 1];


    // Guard: EMA could be null if data < period (shouldn't happen given check above)
    if (lastDailyEMA === null) {
        diag.warnings.push("DAILY_EMA_NULL");
        return {
            signal: "NO_TRADE",
            reason: "daily_ema_null",
            ...diag
        };
    }

    diag.emaAbove = dailyLast.close > lastDailyEMA;
    diag.bullCandle = dailyLast.close > dailyLast.open;
    diag.bearCandle = dailyLast.close < dailyLast.open;

    diag.dailyBias =
        (diag.emaAbove && diag.bullCandle) ? "BULLISH" :
            (!diag.emaAbove && diag.bearCandle) ? "BEARISH" :
                "NEUTRAL";

    const dailyBreakUp = dailyLast.close > prevDay.high;
    const dailyBreakDown = dailyLast.close < prevDay.low;

    if (dailyBreakUp && diag.emaAbove) diag.dailyBias = "BULLISH";
    if (dailyBreakDown && !diag.emaAbove) diag.dailyBias = "BEARISH";

    // ─────────────────────────────────────────
    // PRO FILTER #2 — VWAP (Institutional Bias)
    // CE → price > VWAP | PE → price < VWAP
    // ─────────────────────────────────────────
    const vwapArr = calculateVWAP(future1m);
    const currentVWAP = vwapArr[vwapArr.length - 1];
    diag.vwap = currentVWAP !== null ? parseFloat(currentVWAP.toFixed(2)) : null;
    const VWAP_TOLERANCE = 20;
    diag.aboveVWAP = currentVWAP !== null && lastFuture.close > currentVWAP - VWAP_TOLERANCE;
    diag.belowVWAP = currentVWAP !== null && lastFuture.close < currentVWAP + VWAP_TOLERANCE;

    // ─────────────────────────────────────────
    // 5M TREND + INDICATORS
    // FIX #3, #4, #5 — Pass shared warnings[] into all indicator functions
    // ─────────────────────────────────────────
    const ema5m = calculateEMA(index5m);
    diag.currentEMA = ema5m[ema5m.length - 1]?.toFixed(2) || "0.00";
    diag.trendUp = last5m.close > (ema5m[ema5m.length - 1] ?? -Infinity);
    diag.trendDown = last5m.close < (ema5m[ema5m.length - 1] ?? Infinity);

    const atrArr = calculateATR(index5m, 14, diag.warnings);
    const rawATR = atrArr[atrArr.length - 1];
    const currentATR = rawATR; // Define for downstream logic

    if (rawATR !== null) {
        diag.currentATR = rawATR.toFixed(2);
        diag.dynamicSL = parseFloat(Math.min(CFG.ATR_SL_CAP, rawATR * CFG.ATR_SL_MULTIPLIER).toFixed(2));
        diag.dynamicTGT = parseFloat(Math.min(CFG.ATR_TGT_CAP, rawATR * CFG.ATR_TGT_MULTIPLIER).toFixed(2));
    }

    const adxArr = calculateADX(index5m, 14, diag.warnings);
    const rawADX = adxArr[adxArr.length - 1];
    const currentADX = rawADX; // Define for downstream logic

    if (rawADX !== null) {
        diag.currentADX = rawADX.toFixed(1);
        diag.trendStrong = rawADX >= CFG.ADX_MIN;
    }

    const rsiArr = calculateRSI(index5m, 14, diag.warnings);
    const currentRSI = rsiArr[rsiArr.length - 1];
    if (currentRSI !== null) {
        diag.currentRSI = currentRSI.toFixed(1);
        diag.rsiBullish = currentRSI > CFG.RSI_BULL_MIN;
        diag.rsiBearish = currentRSI < CFG.RSI_BEAR_MAX;
    }

    // ─────────────────────────────────────────
    // GAP ANALYSIS
    // ─────────────────────────────────────────
    const GAP_THRESHOLD = CFG.GAP_THRESHOLD;
    diag.gapPoints = dailyLast.open - prevDay.close;
    diag.gapUp = diag.gapPoints > GAP_THRESHOLD;
    diag.gapDown = diag.gapPoints < -GAP_THRESHOLD;

    diag.gapLabel =
        diag.gapUp ? `🔼 Gap Up (+${diag.gapPoints.toFixed(0)} pts)` :
            diag.gapDown ? `🔽 Gap Down (${diag.gapPoints.toFixed(0)} pts)` :
                `◾ Normal Day (${diag.gapPoints.toFixed(0)} pts)`;

    // ─────────────────────────────────────────
    // FIX #9 — NEUTRAL daily bias checked EARLY (Priority 2)
    //           Prevents sweep setups evaluating on structureless days
    // ─────────────────────────────────────────
    if (diag.dailyBias === "NEUTRAL") {
        return { signal: "NO_TRADE", reason: "daily_bias_neutral", ...diag };
    }

    // ─────────────────────────────────────────
    // 15M STRUCTURE
    // ─────────────────────────────────────────
    const last3 = index15m.slice(-3);
    const hasStructure = last3.length === 3;

    diag.higherHigh = hasStructure && last3[2].high > last3[1].high;
    diag.higherLow = hasStructure && last3[2].low > last3[1].low;
    diag.lowerHigh = hasStructure && last3[2].high < last3[1].high;
    diag.lowerLow = hasStructure && last3[2].low < last3[1].low;

    diag.bullishStructure = diag.higherHigh && diag.higherLow;
    diag.bearishStructure = diag.lowerHigh && diag.lowerLow;


    // ─────────────────────────────────────────
    // PRO FILTER #3 — ATR DEAD MARKET GUARD
    // Skip trades when volatility is too low
    // ─────────────────────────────────────────
    if (rawATR === null) {
        return { signal: "NO_TRADE", reason: "atr_unavailable", ...diag };
    }

    if (rawATR < CFG.ATR_MIN) {
        return { signal: "NO_TRADE", reason: "low_volatility_atr", ...diag };
    }

    if (rawADX === null) {
        return { signal: "NO_TRADE", reason: "insufficient_adx_data", ...diag };
    }

    // ─────────────────────────────────────────
    // 1M BREAK STRUCTURE
    // Compares last closed 1m candle vs the one before it to detect micro-breakouts
    // ─────────────────────────────────────────
    const prevCandles = index1m.slice(-2, -1);   // ✅ renamed: was misleadingly called last5
    const prevHigh = Math.max(...prevCandles.map(c => c.high));  // ✅ renamed from max5High
    const prevLow = Math.min(...prevCandles.map(c => c.low));   // ✅ renamed from min5Low

    diag.breakUp = last1m.high > prevHigh;
    diag.breakDown = last1m.low < prevLow;

    const momentumUp = last1m.close > prev1m.high;
    const momentumDown = last1m.close < prev1m.low;

    const microPullbackUp = diag.trendUp && prev1m.close < prev1m.open && last1m.close > last1m.open;
    const microPullbackDown = diag.trendDown && prev1m.close > prev1m.open && last1m.close < last1m.open;


    // ─────────────────────────────────────────
    // VOLUME + CANDLE
    // ─────────────────────────────────────────
    diag.volConfirm = volumeSpike(future1m, future1m.length - 1); // ✅ 1.5× threshold

    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;

    diag.strongBody = range > 0 && (body / range) > CFG.STRONG_BODY_RATIO;
    diag.bigCandle =
        prev1m &&
        (range > (prev1m.high - prev1m.low) * CFG.BIG_CANDLE_MULT) &&
        diag.strongBody;


    // ─────────────────────────────────────────
    // FIX #6 — Compute absolute SL and Target price levels per side
    // ─────────────────────────────────────────
    const entryPrice = last1m.close;
    const ceSLPrice = parseFloat((entryPrice - diag.dynamicSL).toFixed(2));
    const ceTGTPrice = parseFloat((entryPrice + diag.dynamicTGT).toFixed(2));
    const peSLPrice = parseFloat((entryPrice + diag.dynamicSL).toFixed(2));
    const peTGTPrice = parseFloat((entryPrice - diag.dynamicTGT).toFixed(2));

    // ─────────────────────────────────────────
    // FUTURE 5M + OI
    // ─────────────────────────────────────────
    const future5m = buildTimeframe(future1m, 5);
    const lastFuture5m = (future5m && future5m.length > 0) ? future5m[future5m.length - 1] : { volume: 0, oi: 0 };
    const prevFuture5m = (future5m && future5m.length > 1) ? future5m[future5m.length - 2] : null;

    if (!future5m || future5m.length < 2) {
        diag.warnings.push("VOLUME_INSUFFICIENT");
        return {
            signal: "NO_TRADE",
            reason: "insufficient_volume_data",
            ...diag
        };
    }

    diag.volume = lastFuture5m.volume;
    diag.oi = lastFuture5m.oi;


    // ─────────────────────────────────────────
    // ENTRY CONDITIONS (PRIORITY STRUCTURE)
    // ─────────────────────────────────────────

    // ── Priority 1: CHOP FILTER ──────────────
    // ADX < ADX_CHOP AND RSI near midline → dead/ranging market
    if (currentADX < CFG.ADX_CHOP && currentRSI > CFG.RSI_BEAR_MAX && currentRSI < CFG.RSI_BULL_MIN) {
        return { signal: "NO_TRADE", reason: "choppy_market", ...diag };
    }

    // ── Priority 2: TIME FILTER ──────────────
    if (!diag.timeAllowed) {
        return { signal: "NO_TRADE", reason: "time_filter", ...diag };
    }

    // ── PRO FILTER #4 — MULTI-TF ALIGNMENT ──
    // 5m trend direction + 15m structure must align with daily bias.
    // NOTE: bullishStructure / bearishStructure (15m HH/HL, LH/LL) are embedded here.
    // Trend setups downstream do NOT need to re-check them — trendAligned is the gate.
    diag.trendAligned =
        (diag.dailyBias === "BULLISH" && diag.trendUp && diag.bullishStructure) ||
        (diag.dailyBias === "BEARISH" && diag.trendDown && diag.bearishStructure);

    if (!diag.trendAligned) {
        return { signal: "NO_TRADE", reason: "multi_tf_misaligned", ...diag };
    }

    // ── PRO FILTER #5 — BREAKOUT STRENGTH ───
    // Real breakout must have big candle + strong body + volume
    diag.breakoutStrong =
        diag.strongBody &&
        (diag.volConfirm || diag.bigCandle);

    // ── Priority 3: TREND CONTINUATION ──────
    // FIX #8 — Gap guard extended: if gap fills intraday, allow trend
    const gapDownFilled = diag.gapDown && last5m.close < prevDay.close;
    const gapUpFilled = diag.gapUp && last5m.close > prevDay.close;

    const gapDownAllowed = diag.gapDown && currentADX > 25;
    const gapUpAllowed = diag.gapUp && currentADX > 25;

    const pullbackShort = diag.dailyBias === "BEARISH" && diag.trendDown && currentRSI < 50 && (last1m.high >= (ema5m[ema5m.length - 1] || 0));
    const pullbackLong = diag.dailyBias === "BULLISH" && diag.trendUp && currentRSI > 50 && (last1m.low <= (ema5m[ema5m.length - 1] || Infinity));

    const continuationShort = diag.trendStrong && currentRSI < 40;
    const continuationLong = diag.trendStrong && currentRSI > 60;

    const bearishTrendSetup =
        diag.dailyBias === "BEARISH" &&
        !(diag.gapDown && !diag.breakDown && !gapDownFilled && !gapDownAllowed) &&
        diag.belowVWAP &&
        (
            (diag.trendStrong && diag.rsiBearish && (diag.trendDown && diag.breakoutStrong) && (diag.volConfirm || diag.bigCandle)) ||
            (pullbackShort) ||
            (continuationShort) ||
            (microPullbackDown && momentumDown)
        );

    const bullishTrendSetup =
        diag.dailyBias === "BULLISH" &&
        !(diag.gapUp && !diag.breakUp && !gapUpFilled && !gapUpAllowed) &&
        diag.aboveVWAP &&
        (
            (diag.trendStrong && diag.rsiBullish && (diag.trendUp && diag.breakoutStrong) && (diag.volConfirm || diag.bigCandle)) ||
            (pullbackLong) ||
            (continuationLong) ||
            (microPullbackUp && momentumUp)
        );




    // const maxConsecLoss = CFG.MAX_CONSECUTIVE_LOSS ?? 3;
    // if ((sessionState.consecutiveLosses ?? 0) >= maxConsecLoss) {
    //     diag.warnings.push("DAILY_LOSS_LIMIT_REACHED");
    //     return {
    //         signal: "NO_TRADE",
    //         reason: `max_consecutive_losses_${sessionState.consecutiveLosses}`,
    //         ...diag
    //     };
    // }
    // ── VWAP DISTANCE FILTER ─────────────────

    // After ATR calculation:
    const last15m = index15m[index15m.length - 1];
    const prev15m = index15m[index15m.length - 2];

    const bullClose15m = last15m.close > prev15m.close && last15m.close > last15m.open;
    const bearClose15m = last15m.close < prev15m.close && last15m.close < last15m.open;


    const vwapDistance = Math.abs(lastFuture.close - currentVWAP);

    if (vwapDistance < CFG.VWAP_MIN_DISTANCE) {
        return { signal: "NO_TRADE", reason: "price_too_close_to_vwap", ...diag };
    }



    // After 15m structure block:
    const ema15m = calculateEMA(index15m, 20);
    const lastEMA15m = ema15m[ema15m.length - 1];
    const last15mClose = index15m[index15m.length - 1].close;

    diag.above15mEMA = last15mClose > lastEMA15m;
    diag.below15mEMA = last15mClose < lastEMA15m;

    // Triple confirmation — daily + 5m + 15m all aligned
    if (bearishTrendSetup && !diag.below15mEMA) {
        return { signal: "NO_TRADE", reason: "price_above_15m_ema_blocks_pe", ...diag };
    }
    if (bullishTrendSetup && !diag.above15mEMA) {
        return { signal: "NO_TRADE", reason: "price_below_15m_ema_blocks_ce", ...diag };
    }

    // After 1m data:
    let consecutiveBearBars = 0;
    let consecutiveBullBars = 0;

    for (let i = index1m.length - 1; i >= Math.max(0, index1m.length - 12); i--) {
        const c = index1m[i];
        if (c.close < c.open) consecutiveBearBars++;
        else break;
    }
    for (let i = index1m.length - 1; i >= Math.max(0, index1m.length - 12); i--) {
        const c = index1m[i];
        if (c.close > c.open) consecutiveBullBars++;
        else break;
    }

    const TREND_AGE_MAX = CFG.TREND_AGE_MAX_BARS ?? 8;

    if (bearishTrendSetup && consecutiveBearBars >= TREND_AGE_MAX) {
        return { signal: "NO_TRADE", reason: `trend_overextended_${consecutiveBearBars}_bear_bars`, ...diag };
    }
    if (bullishTrendSetup && consecutiveBullBars >= TREND_AGE_MAX) {
        return { signal: "NO_TRADE", reason: `trend_overextended_${consecutiveBullBars}_bull_bars`, ...diag };
    }

    // After body/range calc:
    // const last7Ranges = index1m.slice(-7).map(c => c.high - c.low);
    // const minRange7 = Math.min(...last7Ranges);
    // const isNR7 = range <= minRange7 * (CFG.NR7_TOLERANCE ?? 1.05);

    // diag.isNR7 = isNR7;

    // if (isNR7) {
    //     return {
    //         signal: "NO_TRADE",
    //         reason: "nr7_compression_direction_unknown",
    //         ...diag
    //     };
    // }

    // // After 5m data:
    // const range5m = last5m.high - last5m.low;
    // const closePos5m = range5m > 0
    //     ? (last5m.close - last5m.low) / range5m
    //     : 0.5;

    // diag.closePos5m = parseFloat(closePos5m.toFixed(3));

    // // PE needs 5m bar to have closed in lower half
    // // CE needs 5m bar to have closed in upper half
    // if (bearishTrendSetup && closePos5m > (CFG.MAX_5M_CLOSE_POS_BEAR ?? 0.45)) {
    //     return {
    //         signal: "NO_TRADE",
    //         reason: `5m_close_too_high_${(closePos5m * 100).toFixed(0)}pct_blocks_pe`,
    //         ...diag
    //     };
    // }
    // if (bullishTrendSetup && closePos5m < (CFG.MIN_5M_CLOSE_POS_BULL ?? 0.55)) {
    //     return {
    //         signal: "NO_TRADE",
    //         reason: `5m_close_too_low_${(closePos5m * 100).toFixed(0)}pct_blocks_ce`,
    //         ...diag
    //     };
    // }
    // const recentVols = future1m.slice(-5).map(c => c.volume);
    // const vol1 = recentVols[recentVols.length - 1];
    // const vol2 = recentVols[recentVols.length - 2];
    // const vol3 = recentVols[recentVols.length - 3];

    // // 3 consecutive declining volume bars = drying up
    // const volumeDryingUp = vol1 < vol2 && vol2 < vol3;

    // if (volumeDryingUp && !diag.volConfirm) {
    //     return { signal: "NO_TRADE", reason: "volume_drying_up_no_conviction", ...diag };
    // }





    // // After 1m data — check last 4 bars for sequence integrity:
    // const b1 = index1m[index1m.length - 4];
    // const b2 = index1m[index1m.length - 3];
    // const b3 = index1m[index1m.length - 2];
    // const b4 = index1m[index1m.length - 1];

    // if (b1 && b2 && b3 && b4) {

    //     // ── Bear sequence check ──────────────────
    //     const bearSequence = b2.low < b1.low && b3.low < b2.low;

    //     const bearSeqBroken =
    //         bearSequence &&
    //         b4.low > b3.low &&                                    // Condition 1: higher low formed
    //         (b4.low - b3.low) > (CFG.SEQ_BREAK_MIN_PTS ?? 10) && // Condition 2: break is meaningful (not 2pt noise)
    //         b4.close > b4.open;                                   // Condition 3: bar also closed bullish (buyers confirmed)

    //     // ── Bull sequence check ──────────────────
    //     const bullSequence = b2.high > b1.high && b3.high > b2.high;

    //     const bullSeqBroken =
    //         bullSequence &&
    //         b4.high < b3.high &&                                   // Condition 1: lower high formed
    //         (b3.high - b4.high) > (CFG.SEQ_BREAK_MIN_PTS ?? 10) && // Condition 2: break is meaningful
    //         b4.close < b4.open;                                    // Condition 3: bar also closed bearish (sellers confirmed)

    //     if (bearishTrendSetup && bearSeqBroken) {
    //         return {
    //             signal: "NO_TRADE",
    //             reason: `bear_seq_broken_hl_${(b4.low - b3.low).toFixed(0)}pts_bullish_close`,
    //             ...diag
    //         };
    //     }
    //     if (bullishTrendSetup && bullSeqBroken) {
    //         return {
    //             signal: "NO_TRADE",
    //             reason: `bull_seq_broken_lh_${(b3.high - b4.high).toFixed(0)}pts_bearish_close`,
    //             ...diag
    //         };
    //     }
    // }

    if (currentADX > 65)
        return { signal: "NO_TRADE", reason: "adx_too_high", ...diag };

    if (currentADX < 18)
        return { signal: "NO_TRADE", reason: "adx_too_low", ...diag };

    // const emaDistance = Math.abs(last1m.close - ema5m[ema5m.length - 1]);

    // if (emaDistance > CFG.MAX_EMA_DISTANCE ?? 120) {
    //     return { signal: "NO_TRADE", reason: "price_far_from_ema", ...diag };
    // }

    // // After 15m structure block:
    // const rsi15mArr = calculateRSI(index15m, 14, diag.warnings);
    // const rsi15m = rsi15mArr[rsi15mArr.length - 1] ?? 50;

    // diag.currentRSI15m = parseFloat(rsi15m.toFixed(1));

    // // PE needs 15m RSI below 50 (sellers in control on 15m)
    // // CE needs 15m RSI above 50 (buyers in control on 15m)
    // if (bearishTrendSetup && rsi15m > (CFG.RSI15M_BEAR_MAX ?? 52)) {
    //     return {
    //         signal: "NO_TRADE",
    //         reason: `15m_rsi_${rsi15m.toFixed(1)}_too_high_blocks_pe`,
    //         ...diag
    //     };
    // }
    // if (bullishTrendSetup && rsi15m < (CFG.RSI15M_BULL_MIN ?? 48)) {
    //     return {
    //         signal: "NO_TRADE",
    //         reason: `15m_rsi_${rsi15m.toFixed(1)}_too_low_blocks_ce`,
    //         ...diag
    //     };
    // }


    // ── 5M WICK REJECTION FILTER ─────────────────
    // Long lower wick on 5m = buyers defended low strongly = PE SL
    // Long upper wick on 5m = sellers defended high strongly = CE SL

    const upper5m = last5m.high - Math.max(last5m.open, last5m.close);
    const lower5m = Math.min(last5m.open, last5m.close) - last5m.low;
    const range5m = last5m.high - last5m.low;

    const upper5mRatio = range5m > 0 ? upper5m / range5m : 0;
    const lower5mRatio = range5m > 0 ? lower5m / range5m : 0;

    const WICK_5M_THRESHOLD = CFG.WICK_5M_THRESHOLD ?? 0.4;

    const strongBuyWick5m = lower5mRatio > WICK_5M_THRESHOLD;
    const strongSellWick5m = upper5mRatio > WICK_5M_THRESHOLD;

    diag.strongBuyWick5m = strongBuyWick5m;
    diag.strongSellWick5m = strongSellWick5m;
    diag.upper5mRatio = parseFloat(upper5mRatio.toFixed(3));
    diag.lower5mRatio = parseFloat(lower5mRatio.toFixed(3));

    if (bearishTrendSetup && strongBuyWick5m) {
        return {
            signal: "NO_TRADE",
            reason: `5m_strong_buy_wick_${(lower5mRatio * 100).toFixed(0)}pct_blocks_pe`,
            ...diag
        };
    }
    if (bullishTrendSetup && strongSellWick5m) {
        return {
            signal: "NO_TRADE",
            reason: `5m_strong_sell_wick_${(upper5mRatio * 100).toFixed(0)}pct_blocks_ce`,
            ...diag
        };
    }








    // In generateSignal.js after candle body calc:
    const upperWick = last1m.high - Math.max(last1m.open, last1m.close);
    const lowerWick = Math.min(last1m.open, last1m.close) - last1m.low;

    // For PE entry — long upper wick = sellers tried but failed = weak
    const weakBearCandle = upperWick > body * CFG.WICK_BODY_RATIO ?? 0.6;
    // For CE entry — long lower wick = buyers tried but failed = weak  
    const weakBullCandle = lowerWick > body * CFG.WICK_BODY_RATIO ?? 0.6;

    if (bearishTrendSetup && weakBearCandle) {
        return { signal: "NO_TRADE", reason: "weak_bear_wick_rejection", ...diag };
    }
    if (bullishTrendSetup && weakBullCandle) {
        return { signal: "NO_TRADE", reason: "weak_bull_wick_rejection", ...diag };
    }

    // const prevRange = prev1m.high - prev1m.low;

    // if (range > prevRange * 2.5) {
    //     return { signal: "NO_TRADE", reason: "exhaustion_candle", ...diag };
    // }

    if (bearishTrendSetup && bearClose15m) {
        logger.debug(`🔻 BEARISH setup | breakDown:${diag.breakDown} ADX:${diag.currentADX}`);

        return {
            signal: "PE",
            reason: "trend_continuation_down",
            slPrice: peSLPrice,   // ✅ FIX #6
            tgtPrice: peTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    if (bullishTrendSetup && bullClose15m) {
        logger.debug(`🔺 BULLISH setup | breakUp:${diag.breakUp} ADX:${diag.currentADX}`);
        return {
            signal: "CE",
            reason: "trend_continuation_up",
            slPrice: ceSLPrice,   // ✅ FIX #6
            tgtPrice: ceTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    // ── Priority 4: DEFAULT ──────────────────
    return { signal: "NO_TRADE", reason: "no_conditions_met", ...diag };
}