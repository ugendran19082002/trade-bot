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

function getATMStrike(price, step = 100) {
    return Math.round(price / step) * step;
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
// ATM OPTION TOKENS  (closest-premium logic)
//
// targetPremium  ₹ target per leg (from env CLOSEST_PREMIUM).
//   • Scans ATM ± strikeRange across OTM/ATM/ITM.
//   • Picks CE+PE pair with smallest combined delta to target.
//   • Pass null/0 to use pure ATM (no LTP scan).
// Fallback: if all LTPs are 0 → next weekly expiry ATM.
// ─────────────────────────────────────────
export async function getATMOptionTokens(
    symbolName = "SENSEX",
    price,
    jwtToken,
    refDate = new Date(),
    targetPremium = process.env.CLOSEST_PREMIUM,
    strikeStep = 100,
    strikeRange = 20,
    signal = "PE"   // "CE" or "PE" — which leg to prioritise for closest-premium scoring
) {
    const parsedTargetPremium = targetPremium ? parseFloat(targetPremium) : 0;

    logger.info(`🧪 getATMOptionTokens | symbol:${symbolName} price:${price} targetPremium:${parsedTargetPremium} signal:${signal}`);

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
    const atmStrike = getATMStrike(price, strikeStep);

    // ── Fallback helper: next weekly expiry ATM ──────────────────────────────
    function getNextExpiryATM() {
        const nextExpiryTime = expiryDates[1] ?? expiryDates[0];
        const nextExpiry = new Date(nextExpiryTime);
        const nextOpts = options.filter(o => o.expiryDate.getTime() === nextExpiryTime);

        const ce = nextOpts.find(o => parseFloat(o.strike) / 100 === atmStrike && o.symbol.endsWith("CE"));
        const pe = nextOpts.find(o => parseFloat(o.strike) / 100 === atmStrike && o.symbol.endsWith("PE"));

        if (!ce || !pe) throw new Error(`Fallback failed: no ATM CE/PE for ${symbolName} @ ${atmStrike} expiry ${nextExpiry.toDateString()}`);

        logger.warn(`⚠️  All LTPs zero — fallback to NEXT expiry ATM`);
        logger.info(`📅 Fallback Expiry: ${nextExpiry.toDateString()} | Strike: ${atmStrike}`);
        logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
        logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);

        return { strike: atmStrike, expiry: nextExpiry, ceToken: ce.token, ceSymbol: ce.symbol, ceLTP: 0, peToken: pe.token, peSymbol: pe.symbol, peLTP: 0 };
    }

    // ── Pure ATM mode (no targetPremium) ────────────────────────────────────
    if (!parsedTargetPremium) {
        const ce = weeklyOptions.find(o => Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("CE"));
        const pe = weeklyOptions.find(o => Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("PE"));

        if (!ce || !pe) throw new Error(`ATM CE/PE not found for ${symbolName} @ ${atmStrike} expiry ${weeklyExpiry.toDateString()}`);

        logger.info(`📅 Weekly Expiry : ${weeklyExpiry.toDateString()}`);
        logger.info(`🎯 ATM Strike    : ${atmStrike}`);
        logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
        logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);

        return { strike: atmStrike, expiry: weeklyExpiry, ceToken: ce.token, ceSymbol: ce.symbol, peToken: pe.token, peSymbol: pe.symbol };
    }

    // ── Build candidate pairs: ATM ± strikeRange ─────────────────────────────
    const candidatePairs = [];
    for (let i = -strikeRange; i <= strikeRange; i++) {
        const strike = atmStrike + i * strikeStep;
        const ce = weeklyOptions.find(o => parseFloat(o.strike) / 100 === strike && o.symbol.endsWith("CE"));
        const pe = weeklyOptions.find(o => parseFloat(o.strike) / 100 === strike && o.symbol.endsWith("PE"));
        if (ce && pe) candidatePairs.push({ strike, ce, pe });
    }

    if (!candidatePairs.length) {
        throw new Error(`No CE/PE pairs found for ${symbolName} around ATM ${atmStrike} expiry ${weeklyExpiry.toDateString()}`);
    }

    // ── Chunked batch LTP fetch ───────────────────────────────────────────────
    const allTokens = candidatePairs.flatMap(p => [String(p.ce.token), String(p.pe.token)]);

    let ltpMap;
    try {
        ltpMap = await fetchLTPMap(jwtToken, allTokens, exchangeSegment);
    } catch (err) {
        if (err.message === "INVALID_TOKEN") throw err;
        logger.warn(`⚠️  fetchLTPMap threw: ${err.message} — fallback to next expiry ATM`);
        return getNextExpiryATM();
    }

    // ── Score: pick pair with smallest combined delta to targetPremium ────────
    //
    //   delta = |tradedLeg_ltp − target|  (signal="CE" or "PE")
    //   Lowest delta wins — OTM / ATM / ITM all compete equally.
    //
    let bestPair = null;
    let bestDelta = Infinity;

    for (const pair of candidatePairs) {
        const ceLTP = ltpMap.get(String(pair.ce.token)) ?? ltpMap.get(String(parseInt(pair.ce.token, 10))) ?? 0;
        const peLTP = ltpMap.get(String(pair.pe.token)) ?? ltpMap.get(String(parseInt(pair.pe.token, 10))) ?? 0;

        if (ceLTP === 0 && peLTP === 0) continue;

        // Score ONLY the traded leg — other leg uses same strike
        const tradedLTP = signal === "CE" ? ceLTP : peLTP;
        const delta = Math.abs(tradedLTP - parsedTargetPremium);
        logger.info(`   Strike ${pair.strike} | CE \u20b9${ceLTP} | PE \u20b9${peLTP} | ${signal} delta \u20b9${delta.toFixed(2)}${delta < bestDelta ? " \u2190 best" : ""}`);
        if (delta < bestDelta) {
            bestDelta = delta;
            bestPair = { ...pair, ceLTP, peLTP };
        }
    }

    // ── All LTPs zero → next expiry ATM fallback ─────────────────────────────
    if (!bestPair) {
        logger.warn(`⚠️  LTP unavailable for all ${candidatePairs.length} candidates`);
        return getNextExpiryATM();
    }

    logger.info(`📅 Weekly Expiry  : ${weeklyExpiry.toDateString()}`);
    logger.info(`🎯 ATM Strike     : ${atmStrike}`);
    logger.info(`💰 Target Premium : ₹${parsedTargetPremium}`);
    logger.info(`✅ Selected Strike: ${bestPair.strike}  |  CE ₹${bestPair.ceLTP}  |  PE ₹${bestPair.peLTP}  |  Delta ₹${bestDelta.toFixed(2)}`);
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