import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { logger } from "./logger.js";
import { loadScripMaster } from "./scriptMaster.js";

// ─────────────────────────────────────────────────────────────────────────────
//  UPSTOX v3 Market Quote — getStrick.js
//
//  Changes from AngelOne version:
//    • MARKET_URL → Upstox v3  /market-quote/ltp
//    • Auth header → Bearer token from process.env.UPSTOX_ACCESS_TOKEN
//    • Instrument key format → "BFO_FO|<token>"  (was numeric token string)
//    • LTP field → response.data[key].last_price  (was item.ltp)
//    • Max 500 instruments per request — no chunking needed for normal use
//    • Removed buildHeaders() (Angel-specific X-* headers not needed)
//    • getLTP() input → instrument_key string (comma-joined)
//    • fetchLTPMap() → returns Map<instrumentKey, ltp>
// ─────────────────────────────────────────────────────────────────────────────

const UPSTOX_BASE_URL = process.env.UPSTOX_BASE_URL || "https://api.upstox.com/v3";
const LTP_URL = `${UPSTOX_BASE_URL}/market-quote/ltp`;

// Upstox allows up to 500 instruments per LTP request
const UPSTOX_LTP_CHUNK_SIZE = 500;

const MONTH_MAP = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

// ─────────────────────────────────────────
// Shared Upstox auth header
// ─────────────────────────────────────────
function upstoxHeaders() {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`,
    };
}

// ─────────────────────────────────────────
// Expiry parser  (ScripMaster format "28MAR25")
// ─────────────────────────────────────────
function parseExpiry(str) {
    // str = "28MAR25"  →  day=28, month=MAR, year=25
    const day = parseInt(str.slice(0, 2));
    const mon = MONTH_MAP[str.slice(2, 5)];
    const yr = 2000 + parseInt(str.slice(5));
    return new Date(yr, mon, day);
}

// ─────────────────────────────────────────
// ATM strike helper
// Math.floor — 77952 → 77900, NOT 78000
// ─────────────────────────────────────────
function getATMStrike(price, step = 100) {
    return Math.floor(price / step) * step;
}

// ─────────────────────────────────────────
// Build Upstox instrument_key from ScripMaster token
//
// ScripMaster: exch_seg="BFO", token="12345"
// Upstox key : "BSE_FO|12345"
//
// Mapping (EXCHANGE_SEGMENT .env → Upstox prefix):
//   BFO  → BSE_FO   (BSE F&O — SENSEX options)  ✅
//   NFO  → NSE_FO   (NSE F&O — NIFTY options)
//   BSE  → BSE_EQ
//   NSE  → NSE_EQ
//
// NOTE: old code used "BFO_FO" — that was wrong.
//       Upstox uses "BSE_FO" for BSE F&O instruments.
// ─────────────────────────────────────────
function toInstrumentKey(token) {
    const seg = (process.env.EXCHANGE_SEGMENT || "BFO").toUpperCase();
    const segMap = {
        "BFO": "BSE_FO",   // BSE Futures & Options (SENSEX) ← your case
        "NFO": "NSE_FO",   // NSE Futures & Options (NIFTY)
        "BSE": "BSE_EQ",   // BSE Equity
        "NSE": "NSE_EQ",   // NSE Equity
        "CDS": "CDS_FO",   // Currency Derivatives
        "MCX": "MCX_FO",   // Commodity
    };
    const prefix = segMap[seg] ?? "BSE_FO";
    return `${prefix}|${token}`;
}

// ─────────────────────────────────────────
// LAST COMPLETED CANDLE TIME (unchanged)
// ─────────────────────────────────────────
export function getLastCompletedCandleTime(timeframe = 1) {
    const now = Date.now();
    const frameMs = timeframe * 60 * 1000;
    const lastFrameStart = Math.floor(now / frameMs) * frameMs - frameMs;
    return new Date(lastFrameStart);
}

// ─────────────────────────────────────────
// BATCH LTP FETCH (Upstox v3)
//
// endpoint: GET /v3/market-quote/ltp?instrument_key=KEY1,KEY2,...
// max 500 per request — chunks only if > 500 tokens
//
// Returns Map<instrumentKey (string), ltp (number)>
//   key format:  "BSE_FO|12345"
// ─────────────────────────────────────────
async function fetchLTPMap(tokens) {
    // tokens = array of ScripMaster token strings e.g. ["12345","67890"]
    // Convert to Upstox instrument_key format
    const instrumentKeys = tokens.map(t =>
        String(t).includes("|") ? String(t) : toInstrumentKey(String(t))
    );

    const ltpMap = new Map();

    // chunk into groups of 500
    const chunks = [];
    for (let i = 0; i < instrumentKeys.length; i += UPSTOX_LTP_CHUNK_SIZE) {
        chunks.push(instrumentKeys.slice(i, i + UPSTOX_LTP_CHUNK_SIZE));
    }

    logger.info(`🔍 fetchLTPMap: ${tokens.length} tokens → ${chunks.length} chunk(s)`);

    for (let ci = 0; ci < chunks.length; ci++) {
        try {
            const res = await axios.get(LTP_URL, {
                params: { instrument_key: chunks[ci].join(",") },
                headers: upstoxHeaders(),
            });

            if (res.data?.status !== "success") {
                throw new Error(res.data?.message || "LTP fetch failed");
            }

            // Response shape:
            // { status:"success", data: { "BSE_FO:SENSEX25MAR2580000CE": { last_price:320.5, instrument_token:"BSE_FO|12345", ... } } }
            const data = res.data?.data ?? {};
            for (const [respKey, quote] of Object.entries(data)) {
                const ltp = parseFloat(quote.last_price ?? 0);
                const instrToken = quote.instrument_token ?? respKey;
                const normKey = instrToken.replace(":", "|");   // "BSE_FO:x" → "BSE_FO|x"
                ltpMap.set(normKey, ltp);
                // also store by raw token for easy lookup
                const rawToken = normKey.split("|")[1] ?? "";
                if (rawToken) {
                    ltpMap.set(rawToken, ltp);
                    ltpMap.set(String(parseInt(rawToken, 10)), ltp);
                }
            }

        } catch (err) {
            if (err.response?.status === 401) {
                throw new Error("INVALID_TOKEN");
            }
            const upstoxMsg = err.response?.data?.message ?? err.response?.data?.errors ?? err.message;
            logger.warn(`⚠ fetchLTPMap chunk ${ci + 1}/${chunks.length} failed [${err.response?.status ?? "N/A"}]: ${JSON.stringify(upstoxMsg)}`);
            logger.warn(`   Keys sent: ${chunks[ci].slice(0, 3).join(", ")}${chunks[ci].length > 3 ? "..." : ""}`);
        }
    }

    logger.info(`🔍 fetchLTPMap: done — ${ltpMap.size} entries`);
    return ltpMap;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATM OPTION TOKENS
//
//  MODE 1 — DELTA-BASED    : OPTION_DELTA set in .env
//  MODE 2 — CLOSEST PREMIUM: CLOSEST_PREMIUM set in .env  (uses Upstox LTP)
//  MODE 3 — PURE ATM       : neither set
// ─────────────────────────────────────────────────────────────────────────────
export async function getATMOptionTokens(
    symbolName = "SENSEX",
    price,
    targetPremium = process.env.CLOSEST_PREMIUM,
    strikeStep = 100,
    strikeRange = 20,
    signal,          // "CE" or "PE"
) {
    if (!signal || (signal !== "CE" && signal !== "PE")) {
        throw new Error(`Invalid signal "${signal}" — must be "CE" or "PE"`);
    }

    const parsedTargetPremium = targetPremium ? parseFloat(targetPremium) : 0;
    const targetDelta = parseFloat(process.env.OPTION_DELTA ?? 0);

    logger.info(
        `🧪 getATMOptionTokens | symbol:${symbolName} price:${price} ` +
        `targetPremium:${parsedTargetPremium} targetDelta:${targetDelta} signal:${signal}`
    );

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
        throw new Error(
            `No options found for ${symbolName} — ScripMaster stale or EXCHANGE_SEGMENT wrong`
        );
    }

    const expiryDates = [...new Set(options.map(o => o.expiryDate.getTime()))].sort((a, b) => a - b);
    const weeklyExpiry = new Date(expiryDates[0]);
    const weeklyOptions = options.filter(o => o.expiryDate.getTime() === expiryDates[0]);

    const atmStrike = getATMStrike(price, strikeStep);
    logger.info(`📍 ATM Strike: ${atmStrike} (price:${price} → floor nearest ${strikeStep})`);

    // ── Pure ATM helper ──────────────────────────────────────────────────────
    function getATMTokens() {
        const ce = weeklyOptions.find(o =>
            Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("CE")
        );
        const pe = weeklyOptions.find(o =>
            Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("PE")
        );
        if (!ce || !pe) {
            throw new Error(
                `ATM CE/PE not found for ${symbolName} @ ${atmStrike} expiry ${weeklyExpiry.toDateString()}`
            );
        }
        logger.info(`📅 Weekly Expiry: ${weeklyExpiry.toDateString()}`);
        logger.info(`🎯 ATM Strike  : ${atmStrike}`);
        logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
        logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);
        return {
            strike: atmStrike,
            expiry: weeklyExpiry,
            ceToken: ce.token,
            ceSymbol: ce.symbol,
            peToken: pe.token,
            peSymbol: pe.symbol,
        };
    }

    // ── Next-expiry ATM fallback ─────────────────────────────────────────────
    function getNextExpiryATM() {
        const nextTime = expiryDates[1] ?? expiryDates[0];
        const nextExpiry = new Date(nextTime);
        const nextOpts = options.filter(o => o.expiryDate.getTime() === nextTime);
        const ce = nextOpts.find(o =>
            Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("CE")
        );
        const pe = nextOpts.find(o =>
            Math.round(parseFloat(o.strike) / 100) === atmStrike && o.symbol.endsWith("PE")
        );
        if (!ce || !pe) {
            throw new Error(
                `Fallback failed: no ATM CE/PE for ${symbolName} @ ${atmStrike} expiry ${nextExpiry.toDateString()}`
            );
        }
        logger.warn(`⚠ All LTPs zero — fallback to NEXT expiry ATM`);
        logger.info(`📅 Fallback Expiry: ${nextExpiry.toDateString()} | Strike: ${atmStrike}`);
        return {
            strike: atmStrike,
            expiry: nextExpiry,
            ceToken: ce.token,
            ceSymbol: ce.symbol,
            ceLTP: 0,
            peToken: pe.token,
            peSymbol: pe.symbol,
            peLTP: 0,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODE 1 — DELTA-BASED  (OPTION_DELTA set in .env)
    //  No LTP fetch needed — just pick strike by offset
    // ════════════════════════════════════════════════════════════════════════
    if (targetDelta > 0) {
        logger.info(`🎯 MODE: Delta-based | targetDelta: ${targetDelta}`);

        function deltaToOffset(delta) {
            if (delta < 0.10) return 10;
            if (delta < 0.14) return 9;
            if (delta < 0.18) return 8;
            if (delta < 0.22) return 7;
            if (delta < 0.26) return 6;
            if (delta < 0.30) return 5;
            if (delta < 0.34) return 4;
            if (delta < 0.38) return 3;
            if (delta < 0.42) return 2;
            if (delta < 0.48) return 1;
            if (delta <= 0.55) return 0;   // ATM
            if (delta < 0.59) return -1;
            if (delta < 0.63) return -2;
            if (delta < 0.67) return -3;
            if (delta < 0.71) return -4;
            if (delta < 0.75) return -5;
            if (delta < 0.79) return -6;
            if (delta < 0.83) return -7;
            if (delta < 0.87) return -8;
            if (delta < 0.91) return -9;
            return -10;
        }

        const offset = deltaToOffset(targetDelta);
        const label = offset === 0 ? "ATM" : offset > 0 ? `${offset} OTM` : `${Math.abs(offset)} ITM`;
        const targetStrike = signal === "CE"
            ? atmStrike + offset * strikeStep
            : atmStrike - offset * strikeStep;

        logger.info(`🎯 Delta ${targetDelta} → offset ${offset} (${label}) → Strike ${targetStrike}`);

        const ce = weeklyOptions.find(o =>
            Math.round(parseFloat(o.strike) / 100) === targetStrike && o.symbol.endsWith("CE")
        );
        const pe = weeklyOptions.find(o =>
            Math.round(parseFloat(o.strike) / 100) === targetStrike && o.symbol.endsWith("PE")
        );

        if (!ce || !pe) {
            logger.warn(`⚠ Strike ${targetStrike} not found — falling back to ATM`);
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

    // ════════════════════════════════════════════════════════════════════════
    //  MODE 2 — CLOSEST PREMIUM  (CLOSEST_PREMIUM set in .env)
    //
    //  Uses Upstox v3 LTP API to fetch live premiums and pick the strike
    //  whose option premium is closest to the target amount.
    //
    //  .env:  CLOSEST_PREMIUM=150
    // ════════════════════════════════════════════════════════════════════════
    else if (parsedTargetPremium > 0) {
        logger.info(`💰 MODE: Closest Premium | targetPremium: ₹${parsedTargetPremium}`);

        // Build candidate CE+PE pairs around ATM
        const candidatePairs = [];
        for (let i = -strikeRange; i <= strikeRange; i++) {
            const strike = atmStrike + i * strikeStep;
            const ce = weeklyOptions.find(o =>
                Math.round(parseFloat(o.strike) / 100) === strike && o.symbol.endsWith("CE")
            );
            const pe = weeklyOptions.find(o =>
                Math.round(parseFloat(o.strike) / 100) === strike && o.symbol.endsWith("PE")
            );
            if (ce && pe) candidatePairs.push({ strike, ce, pe });
        }

        if (!candidatePairs.length) {
            throw new Error(`No CE/PE pairs found for ${symbolName} around ATM ${atmStrike}`);
        }

        // Collect all ScripMaster tokens → fetchLTPMap converts to Upstox keys
        const allTokens = candidatePairs.flatMap(p => [String(p.ce.token), String(p.pe.token)]);

        let ltpMap;
        try {
            ltpMap = await fetchLTPMap(allTokens);
        } catch (err) {
            if (err.message === "INVALID_TOKEN") throw err;
            logger.warn(`⚠ fetchLTPMap threw: ${err.message} — fallback to next expiry ATM`);
            return getNextExpiryATM();
        }

        let bestPair = null;
        let bestDiff = Infinity;

        for (const pair of candidatePairs) {
            // Look up LTP by raw token string (fetchLTPMap stores both formats)
            const ceLTP = ltpMap.get(String(pair.ce.token))
                ?? ltpMap.get(String(parseInt(pair.ce.token, 10)))
                ?? 0;
            const peLTP = ltpMap.get(String(pair.pe.token))
                ?? ltpMap.get(String(parseInt(pair.pe.token, 10)))
                ?? 0;

            if (ceLTP === 0 && peLTP === 0) continue;

            const tradedLTP = signal === "CE" ? ceLTP : peLTP;
            const diff = Math.abs(tradedLTP - parsedTargetPremium);

            logger.info(
                `   Strike ${pair.strike} | CE ₹${ceLTP} | PE ₹${peLTP} | ` +
                `${signal} diff ₹${diff.toFixed(2)}${diff < bestDiff ? " ← best" : ""}`
            );

            if (diff < bestDiff) {
                bestDiff = diff;
                bestPair = { ...pair, ceLTP, peLTP };
            }
        }

        if (!bestPair) {
            logger.warn(`⚠ LTP unavailable for all ${candidatePairs.length} candidates`);
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

    // ════════════════════════════════════════════════════════════════════════
    //  MODE 3 — PURE ATM  (no OPTION_DELTA, no CLOSEST_PREMIUM)
    // ════════════════════════════════════════════════════════════════════════
    else {
        logger.info(`📍 MODE: Pure ATM`);
        return getATMTokens();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  getLTP  — lightweight single/batch LTP fetch  (Upstox v3)
//
//  Accepts TWO input shapes for backward compat with entryEngine.js:
//
//  Shape A — AngelOne legacy (entryEngine.js line 193):
//    { "BFO": ["12345"] }
//    → token "12345" is ScripMaster numeric token
//    → converted to "BFO_FO|12345" for Upstox
//
//  Shape B — Already an Upstox instrument_key (direct pass-through):
//    { "BFO_FO": ["BFO_FO|12345"] }   OR   just pass a key string directly
//
//  Output: array of { symbolToken, ltp, ltq, volume, cp }
//    (same shape entryEngine.js uses: ltpData[0].ltp)
// ─────────────────────────────────────────────────────────────────────────────
export async function getLTP(exchangeTokens) {
    try {
        // Flatten all token values from the input object
        // Input: { "BFO": ["12345"] }  →  tokenList = ["12345"]
        const tokenList = Object.values(exchangeTokens).flat().map(String);

        if (!tokenList.length) {
            logger.warn("⚠ getLTP: empty token list");
            return [];
        }

        // Build Upstox instrument_key for each token.
        // If the token already contains "|" it's already a full key — use as-is.
        // Otherwise build from EXCHANGE_SEGMENT mapping.
        const instrumentKeys = tokenList.map(t =>
            t.includes("|") ? t : toInstrumentKey(t)
        );

        // Upstox wants comma-joined, NOT URL-encoded in the query string value
        // Correct: ?instrument_key=BFO_FO|12345,BFO_FO|67890
        const keyParam = instrumentKeys.join(",");

        logger.info(`🔍 getLTP → keys: ${keyParam}`);

        const res = await axios.get(LTP_URL, {
            params: { instrument_key: keyParam },
            headers: upstoxHeaders(),
        });

        if (res.data?.status !== "success") {
            throw new Error(res.data?.message || "LTP fetch failed");
        }

        // Upstox response shape:
        // { status:"success", data: {
        //     "BFO_FO:SENSEX25MAR2580000CE": {
        //       last_price: 320.5,
        //       instrument_token: "BFO_FO|12345",
        //       ltq: 10, volume: 5000, cp: 285.0
        //     }
        // }}
        const data = res.data?.data ?? {};

        if (!Object.keys(data).length) {
            logger.warn(`⚠ getLTP: empty data in response for keys: ${keyParam}`);
            return [];
        }

        // Normalise → [{ symbolToken, ltp, ltq, volume, cp }]
        return Object.entries(data).map(([respKey, quote]) => {
            // instrument_token = "BFO_FO|12345"  →  rawToken = "12345"
            const instrToken = quote.instrument_token ?? respKey;
            const rawToken = instrToken.split(/[|:]/)[1] ?? instrToken;
            return {
                symbolToken: rawToken,
                ltp: parseFloat(quote.last_price ?? 0),
                ltq: quote.ltq ?? 0,
                volume: quote.volume ?? 0,
                cp: quote.cp ?? 0,
            };
        });

    } catch (err) {
        if (err.response?.status === 401) {
            throw new Error("INVALID_TOKEN getLtp");
        }
        // Log the FULL Upstox error body so we can debug 400 errors
        const upstoxMsg = err.response?.data?.message ?? err.response?.data?.errors ?? err.message;
        const statusCode = err.response?.status ?? "N/A";
        logger.error(`❌ getLTP Error [${statusCode}]: ${JSON.stringify(upstoxMsg)}`);
        logger.error(`   URL: ${LTP_URL}`);
        logger.error(`   Token input: ${JSON.stringify(exchangeTokens)}`);
        return [];
    }
}