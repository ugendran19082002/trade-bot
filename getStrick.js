import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { logger } from "./logger.js";
import { loadScripMaster } from "./scriptMaster.js";
import { buildHeaders } from "./helpers.js";

const MONTH_MAP = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

const MARKET_URL = "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/";

function parseExpiry(str) {
    return new Date(parseInt(str.slice(5)), MONTH_MAP[str.slice(2, 5)], parseInt(str.slice(0, 2)));
}

// ✅ Math.floor — always rounds DOWN to nearest strike
// 77952.77 → floor(779.52) → 779 → 77900 ✅
// 78050.00 → floor(780.50) → 780 → 78000 ✅
function getATMStrike(price, step = 100) {
    return Math.floor(price / step) * step;
}

// ─────────────────────────────────────────
// LAST COMPLETED CANDLE TIME
// ─────────────────────────────────────────
export function getLastCompletedCandleTime(timeframe = 1) {
    const now = Date.now();
    const frameMs = timeframe * 60 * 1000;
    const lastFrameStart = Math.floor(now / frameMs) * frameMs - frameMs;
    return new Date(lastFrameStart);
}

// ─────────────────────────────────────────
// BATCH LTP FETCH — chunked
//
// Angel One rejects requests with more than 25 tokens.
// Splits into chunks of 25, fires sequentially, merges into one Map.
// Returns Map<token (string), ltp (number)>
// ─────────────────────────────────────────
const ANGEL_LTP_CHUNK_SIZE = 25;

async function fetchLTPMap(jwtToken, tokens, exchangeSegment = "BFO") {
    const ltpMap = new Map();

    const chunks = [];
    for (let i = 0; i < tokens.length; i += ANGEL_LTP_CHUNK_SIZE) {
        chunks.push(tokens.slice(i, i + ANGEL_LTP_CHUNK_SIZE));
    }

    logger.info(`🔍 fetchLTPMap: ${tokens.length} tokens → ${chunks.length} chunk(s) of ≤${ANGEL_LTP_CHUNK_SIZE}`);

    for (let ci = 0; ci < chunks.length; ci++) {
        try {
            const response = await axios.post(
                MARKET_URL,
                { mode: "LTP", exchangeTokens: { [exchangeSegment]: chunks[ci] } },
                { headers: buildHeaders(jwtToken) }
            );

            if (!response.data?.status) {
                throw new Error(response.data?.message || "Batch LTP fetch failed");
            }

            const fetched = response.data?.data?.fetched ?? [];

            for (const item of fetched) {
                const ltp = parseFloat(item.ltp ?? 0);
                // Store under both raw string and parsed-int — covers any
                // leading-zero / whitespace mismatch between API and ScripMaster
                const raw = item.symbolToken ?? item.token ?? item.instrumentToken ?? "";
                if (raw) {
                    ltpMap.set(String(raw), ltp);
                    ltpMap.set(String(parseInt(raw, 10)), ltp);
                }
            }

        } catch (err) {
            const errorMsg = err.response?.data?.message || err.message;
            const errorCode = err.response?.data?.errorCode;

            if (errorCode === "AG8001" || errorMsg === "Invalid Token") {
                throw new Error("INVALID_TOKEN");
            }

            logger.warn(`⚠️  fetchLTPMap chunk ${ci + 1}/${chunks.length} failed (${errorMsg}) — skipping`);
        }
    }

    logger.info(`🔍 fetchLTPMap: done — ${ltpMap.size / 2} unique LTPs`);
    return ltpMap;
}

// ─────────────────────────────────────────
// ATM OPTION TOKENS
//
// MODE 1 — DELTA-BASED   : OPTION_DELTA set in .env
// MODE 2 — CLOSEST PREMIUM: CLOSEST_PREMIUM set in .env
// MODE 3 — PURE ATM      : neither set
// ─────────────────────────────────────────
export async function getATMOptionTokens(
    symbolName = "SENSEX",
    price,
    jwtToken,
    targetPremium = process.env.CLOSEST_PREMIUM,
    strikeStep = 100,
    strikeRange = 20,
    signal = ""   // "CE" or "PE"
) {

    if (!signal || (signal !== "CE" && signal !== "PE")) {
        throw new Error(`Invalid signal "${signal}" — must be "CE" or "PE"`);
    }

    const parsedTargetPremium = targetPremium ? parseFloat(targetPremium) : 0;
    const targetDelta = parseFloat(process.env.OPTION_DELTA ?? 0);

    logger.info(`🧪 getATMOptionTokens | symbol:${symbolName} price:${price} targetPremium:${parsedTargetPremium} targetDelta:${targetDelta} signal:${signal}`);

    const res = await loadScripMaster();

    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    nowIST.setHours(0, 0, 0, 0);

    const exchangeSegment = process.env.EXCHANGE_SEGMENT || "BFO";

    const options = res
        .filter(i =>
            i.exch_seg === exchangeSegment &&
            i.instrumenttype === "OPTIDX" &&
            i.name === symbolName
        )
        .map(i => ({ ...i, expiryDate: parseExpiry(i.expiry) }))
        .filter(i => i.expiryDate >= nowIST);

    if (!options.length) {
        throw new Error(`No options found for ${symbolName} — ScripMaster may be stale or EXCHANGE_SEGMENT wrong`);
    }

    const expiryDates = [...new Set(options.map(o => o.expiryDate.getTime()))].sort((a, b) => a - b);
    const weeklyExpiry = new Date(expiryDates[0]);
    const weeklyOptions = options.filter(o => o.expiryDate.getTime() === expiryDates[0]);

    // ✅ Math.floor — 77952 → 77900, NOT 78000
    const atmStrike = getATMStrike(price, strikeStep);
    logger.info(`📍 ATM Strike: ${atmStrike} (price:${price} → floor to nearest ${strikeStep})`);

    // ── Fallback helper: next weekly expiry ATM ──────────────────────────────
    function getNextExpiryATM() {
        const nextExpiryTime = expiryDates[1] ?? expiryDates[0];
        const nextExpiry = new Date(nextExpiryTime);
        const nextOpts = options.filter(o => o.expiryDate.getTime() === nextExpiryTime);

        const ce = nextOpts.find(o => Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("CE"));
        const pe = nextOpts.find(o => Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("PE"));

        if (!ce || !pe) throw new Error(`Fallback failed: no ATM CE/PE for ${symbolName} @ ${atmStrike} expiry ${nextExpiry.toDateString()}`);

        logger.warn(`⚠️  All LTPs zero — fallback to NEXT expiry ATM`);
        logger.info(`📅 Fallback Expiry: ${nextExpiry.toDateString()} | Strike: ${atmStrike}`);
        logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
        logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);

        return { strike: atmStrike, expiry: nextExpiry, ceToken: ce.token, ceSymbol: ce.symbol, ceLTP: 0, peToken: pe.token, peSymbol: pe.symbol, peLTP: 0 };
    }

    // ── ATM pure helper (reused by fallbacks) ────────────────────────────────
    function getATMTokens() {
        const ce = weeklyOptions.find(o => Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("CE"));
        const pe = weeklyOptions.find(o => Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("PE"));
        if (!ce || !pe) throw new Error(`ATM CE/PE not found for ${symbolName} @ ${atmStrike} expiry ${weeklyExpiry.toDateString()}`);
        logger.info(`📅 Weekly Expiry : ${weeklyExpiry.toDateString()}`);
        logger.info(`🎯 ATM Strike    : ${atmStrike}`);
        logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
        logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);
        return { strike: atmStrike, expiry: weeklyExpiry, ceToken: ce.token, ceSymbol: ce.symbol, peToken: pe.token, peSymbol: pe.symbol };
    }

    // ════════════════════════════════════════════════════════════════════
    //  MODE 1 — DELTA-BASED  (OPTION_DELTA set in .env)
    //
    //  Each 0.10 delta step = 1 strike offset
    //
    //  Delta  → Offset → Type
    //  < 0.10 → +5     → Deep OTM
    //  0.10–0.19 → +4  → 4 OTM
    //  0.20–0.29 → +3  → 3 OTM
    //  0.30–0.39 → +2  → 2 OTM
    //  0.40–0.49 → +1  → 1 OTM
    //  0.50–0.59 → 0   → ATM ✅
    //  0.60–0.69 → -1  → 1 ITM
    //  0.70–1.0  → -2  → 2 ITM
    //
    //  CE: targetStrike = atmStrike + offset * strikeStep
    //  PE: targetStrike = atmStrike - offset * strikeStep
    //
    //  Example: price=77952, ATM=77900, delta=0.7, signal=PE
    //  offset = -2
    //  targetStrike = 77900 - (-2 * 100) = 77900 + 200 = 78100 ✅
    // ════════════════════════════════════════════════════════════════════
    if (targetDelta > 0) {
        logger.info(`🎯 MODE: Delta-based | targetDelta: ${targetDelta}`);
function deltaToOffset(delta) {
    // OTM — low delta (positive offset)
    if (delta < 0.07) return 10;   // deep OTM  (< 0.07)
    if (delta < 0.17) return 9;    // 9 OTM     (0.07–0.16)
    if (delta < 0.27) return 8;    // 8 OTM     (0.17–0.26)
    if (delta < 0.37) return 7;    // 7 OTM     (0.27–0.36)
    if (delta < 0.47) return 6;    // 6 OTM     (0.37–0.46)
    if (delta < 0.57) return 5;    // 5 OTM     (0.47–0.56)
    if (delta < 0.67) return 4;    // 4 OTM     (0.57–0.66)
    if (delta < 0.77) return 3;    // 3 OTM     (0.67–0.76)
    if (delta < 0.87) return 2;    // 2 OTM     (0.77–0.86)
    if (delta < 0.97) return 1;    // 1 OTM     (0.87–0.96)
    // ATM
    if (delta < 1.07) return 0;    // ATM       (0.97–1.06) ✅
    // ITM — high delta (negative offset)
    if (delta < 1.17) return -1;   // 1 ITM
    if (delta < 1.27) return -2;   // 2 ITM
    if (delta < 1.37) return -3;   // 3 ITM
    if (delta < 1.47) return -4;   // 4 ITM
    if (delta < 1.57) return -5;   // 5 ITM
    if (delta < 1.67) return -6;   // 6 ITM
    if (delta < 1.77) return -7;   // 7 ITM
    if (delta < 1.87) return -8;   // 8 ITM
    if (delta < 1.97) return -9;   // 9 ITM
    return -10;                     // 10 ITM    (1.97+)
}
        const offset = deltaToOffset(targetDelta);
        const label = offset === 0 ? "ATM" : offset > 0 ? `${offset} OTM` : `${Math.abs(offset)} ITM`;

        // CE: OTM = higher strike (+), ITM = lower strike (-)
        // PE: OTM = lower strike  (-), ITM = higher strike (+)
        // Formula is same — offset sign handles direction automatically
        const targetStrike = signal === "CE"
            ? atmStrike + offset * strikeStep
            : atmStrike - offset * strikeStep;

        logger.info(`🎯 Delta ${targetDelta} → offset ${offset} (${label}) → Strike ${targetStrike}`);
        logger.info(`   ATM:${atmStrike} | offset:${offset} | step:${strikeStep} | signal:${signal}`);

        // ✅ Math.round avoids floating point mismatch
        // parseFloat("7790000") / 100 = 77900.00000000001 !== 77900
        const ce = weeklyOptions.find(o =>
            Math.round(parseFloat(o.strike) / 100) === targetStrike &&
            o.symbol.endsWith("CE")
        );
        const pe = weeklyOptions.find(o =>
            Math.round(parseFloat(o.strike) / 100) === targetStrike &&
            o.symbol.endsWith("PE")
        );

        if (!ce || !pe) {
            logger.warn(`⚠ Strike ${targetStrike} not found — falling back to ATM`);
            logger.warn(`   Available strikes: ${[...new Set(weeklyOptions.map(o => Math.round(parseFloat(o.strike) / 100)))].sort((a, b) => a - b).join(", ")}`);
            return getATMTokens();
        }

        logger.info(`✅ Delta Strike : ${targetStrike} (${label})`);
        logger.info(`📅 Weekly Expiry: ${weeklyExpiry.toDateString()}`);
        logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
        logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);

        return {
            strike: targetStrike,
            expiry: weeklyExpiry,
            ceToken: ce.token,
            ceSymbol: ce.symbol,
            peToken: pe.token,
            peSymbol: pe.symbol,
        };
    }

    // ════════════════════════════════════════════════════════════════════
    //  MODE 2 — CLOSEST PREMIUM  (CLOSEST_PREMIUM set in .env)
    //  Fetches live LTPs and picks the strike whose traded-leg LTP
    //  is closest to the target premium amount
    //
    //  .env:  CLOSEST_PREMIUM=150
    // ════════════════════════════════════════════════════════════════════
    else if (parsedTargetPremium > 0) {
        logger.info(`💰 MODE: Closest Premium | targetPremium: ₹${parsedTargetPremium}`);

        const candidatePairs = [];
        for (let i = -strikeRange; i <= strikeRange; i++) {
            const strike = atmStrike + i * strikeStep;
            const ce = weeklyOptions.find(o => Math.round(parseFloat(o.strike) / 100) === strike && o.symbol.endsWith("CE"));
            const pe = weeklyOptions.find(o => Math.round(parseFloat(o.strike) / 100) === strike && o.symbol.endsWith("PE"));
            if (ce && pe) candidatePairs.push({ strike, ce, pe });
        }

        if (!candidatePairs.length) {
            throw new Error(`No CE/PE pairs found for ${symbolName} around ATM ${atmStrike}`);
        }

        const allTokens = candidatePairs.flatMap(p => [String(p.ce.token), String(p.pe.token)]);

        let ltpMap;
        try {
            ltpMap = await fetchLTPMap(jwtToken, allTokens, exchangeSegment);
        } catch (err) {
            if (err.message === "INVALID_TOKEN") throw err;
            logger.warn(`⚠️  fetchLTPMap threw: ${err.message} — fallback to next expiry ATM`);
            return getNextExpiryATM();
        }

        let bestPair = null;
        let bestDiff = Infinity;

        for (const pair of candidatePairs) {
            const ceLTP = ltpMap.get(String(pair.ce.token)) ?? ltpMap.get(String(parseInt(pair.ce.token, 10))) ?? 0;
            const peLTP = ltpMap.get(String(pair.pe.token)) ?? ltpMap.get(String(parseInt(pair.pe.token, 10))) ?? 0;

            if (ceLTP === 0 && peLTP === 0) continue;

            const tradedLTP = signal === "CE" ? ceLTP : peLTP;
            const diff = Math.abs(tradedLTP - parsedTargetPremium);
            logger.info(`   Strike ${pair.strike} | CE ₹${ceLTP} | PE ₹${peLTP} | ${signal} diff ₹${diff.toFixed(2)}${diff < bestDiff ? " ← best" : ""}`);

            if (diff < bestDiff) {
                bestDiff = diff;
                bestPair = { ...pair, ceLTP, peLTP };
            }
        }

        if (!bestPair) {
            logger.warn(`⚠️  LTP unavailable for all ${candidatePairs.length} candidates`);
            return getNextExpiryATM();
        }

        logger.info(`📅 Weekly Expiry  : ${weeklyExpiry.toDateString()}`);
        logger.info(`🎯 ATM Strike     : ${atmStrike}`);
        logger.info(`💰 Target Premium : ₹${parsedTargetPremium}`);
        logger.info(`✅ Selected Strike: ${bestPair.strike} | CE ₹${bestPair.ceLTP} | PE ₹${bestPair.peLTP}`);
        logger.info(`🟢 CE: ${bestPair.ce.symbol} | Token: ${bestPair.ce.token}`);
        logger.info(`🔴 PE: ${bestPair.pe.symbol} | Token: ${bestPair.pe.token}`);

        return {
            strike: bestPair.strike,
            expiry: weeklyExpiry,
            ceToken: bestPair.ce.token,
            ceSymbol: bestPair.ce.symbol,
            ceLTP: bestPair.ceLTP,
            peToken: bestPair.pe.token,
            peSymbol: bestPair.pe.symbol,
            peLTP: bestPair.peLTP,
        };
    }

    // ════════════════════════════════════════════════════════════════════
    //  MODE 3 — PURE ATM  (neither OPTION_DELTA nor CLOSEST_PREMIUM set)
    // ════════════════════════════════════════════════════════════════════
    else {
        logger.info(`📍 MODE: Pure ATM`);
        return getATMTokens();
    }
}

// ─────────────────────────────────────────
// LTP ONLY (lightweight — for option LTP)
// ─────────────────────────────────────────
export async function getLTP(jwtToken, exchangeTokens) {
    try {
        const response = await axios.post(
            MARKET_URL,
            { mode: "LTP", exchangeTokens },
            { headers: buildHeaders(jwtToken) }
        );

        if (!response.data?.status) {
            throw new Error(response.data?.message || "LTP fetch failed");
        }

        return response.data.data.fetched;

    } catch (err) {
        const errorMsg = err.response?.data?.message || err.message;
        const errorCode = err.response?.data?.errorCode;

        if (errorCode === "AG8001" || errorMsg === "Invalid Token") {
            throw new Error("INVALID_TOKEN getLtp");
        }

        logger.error(`❌ LTP Fetch Error: ${errorMsg}`);
        return [];
    }
}