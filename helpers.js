import dotenv from "dotenv";
dotenv.config();

import os from "os";

// ─────────────────────────────────────────
// SLEEP
// ─────────────────────────────────────────
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────
// LOCAL IP
// ─────────────────────────────────────────
export function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
    }
    return "127.0.0.1";
}


export function buildTimeframe(data, size) {
    if (!data.length) return [];

    const result = [];
    let bucket = [];
    let currentMinute = null;

    // Helper to aggregate a bucket of candles
    const aggregate = (chunk) => ({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
        oi: chunk.reduce((s, c) => s + (c.oi || 0), 0)
    });

    for (const c of data) {
        const date = new Date(c.time);
        const totalMinutes = date.getHours() * 60 + date.getMinutes();

        // Alignment base: 09:15 is the start of trading
        // We calculate how many minutes since 09:15
        const marketStartMinutes = 9 * 60 + 15;
        const diff = totalMinutes - marketStartMinutes;

        // The bucket index for this candle (e.g., 0-4 for 5m, 0-14 for 15m)
        const bucketStart = Math.floor(diff / size) * size;

        if (currentMinute === null) {
            currentMinute = bucketStart;
        }

        if (bucketStart === currentMinute) {
            bucket.push(c);
        } else {
            if (bucket.length) {
                result.push(aggregate(bucket));
            }
            bucket = [c];
            currentMinute = bucketStart;
        }
    }

    // ⚠ CRITICAL: Only push the last bucket if it's complete.
    // An incomplete bucket (e.g. 3 out of 5 1m bars for a 5m candle)
    // has provisional OHLC values — using it for signals causes false entries.
    if (bucket.length === size) {
        result.push(aggregate(bucket));
    }
    // else: drop it — it's still forming

    return result;
}

// ─────────────────────────────────────────
// API HEADERS
// ─────────────────────────────────────────
export function buildHeaders(jwtToken = null) {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": getLocalIP(),
        "X-ClientPublicIP": getLocalIP(),
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": process.env.API_KEY,
        ...(jwtToken && { Authorization: `Bearer ${jwtToken}` })
    };
}

// ─────────────────────────────────────────
// DATE FORMATTING
// ─────────────────────────────────────────
export function formatDateTime() {
    const date = new Date();

    // Go 20 days back
    date.setDate(date.getDate() - 20);

    // Set fixed time 09:15
    date.setHours(9);
    date.setMinutes(15);
    date.setSeconds(0);
    date.setMilliseconds(0);

    const p = n => String(n).padStart(2, "0");

    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
        `${p(date.getHours())}:${p(date.getMinutes())}`;
}


// export function formatCurrentDateTime() {
//     const now = new Date();
//     const p = n => String(n).padStart(2, "0");

//     return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
//         `${p(now.getHours())}:${p(now.getMinutes())}`;
// }

// ✅ FIXED: always use IST (Asia/Kolkata) for the todate window.
// The old version used getHours()/getDate() which is LOCAL/UTC time on most servers.
// On a UTC server at 10:48 IST, getHours() = 5 and the date could appear as yesterday,
// causing the AngelOne API to return no data or stale candles.
export function formatCurrentDateTime() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    now.setSeconds(0, 0);

    const p = n => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
        `${p(now.getHours())}:${p(now.getMinutes())}`;
}
// ─────────────────────────────────────────
// DYNAMIC DATE HELPERS
// ─────────────────────────────────────────
export function getTodayFromDate(daysBack = 30) {
    const p = n => String(n).padStart(2, "0");
    // Use IST date so daysBack is calculated from the real IST calendar day
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    d.setDate(d.getDate() - daysBack);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
}

export function getDailyFromDate() {
    const p = n => String(n).padStart(2, "0");
    const d = new Date();
    d.setDate(d.getDate() - 45);  // 45 days ensures 20+ trading days for EMA even with holidays
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
}


export function formatISTDateTime() {
    const now = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );

    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Returns the timestamp of the last candle that SHOULD be closed.
 * Market closes at 15:30, so if it's 15:31, last closed is 15:30.
 * If it's 09:16, last closed is 09:15.
 */
export function getExpectedLastCandleTime() {
    // Force IST for calculations
    const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

    const expected = new Date(nowIst);
    expected.setSeconds(0, 0);
    expected.setMilliseconds(0);

    // The candle that just closed is (CurrentMinute - 1)
    expected.setMinutes(expected.getMinutes() - 1);

    // Market Bound Constraints (09:15 to 15:30)
    const h = expected.getHours();
    const m = expected.getMinutes();
    const mins = h * 60 + m;
    const marketOpen = 9 * 60 + 15;
    const marketClose = 15 * 60 + 30;

    if (mins < marketOpen) {
        // Before market, return previous day's last candle (09:15) or let engine handle it
        // We'll set it to 09:15 of current day for sync logic to wait/fallback
        expected.setHours(9, 15, 0, 0);
    } else if (mins > marketClose) {
        expected.setHours(15, 30, 0, 0);
    }

    const p = n => String(n).padStart(2, "0");
    return `${expected.getFullYear()}-${p(expected.getMonth() + 1)}-${p(expected.getDate())} ${p(expected.getHours())}:${p(expected.getMinutes())}`;
}

export function calculateOptionLevels({
    indexEntry,
    indexSL,
    indexTarget,
    optionLTP,
    delta = parseFloat(process.env.OPTION_DELTA ?? 0.5),
    gamma = parseFloat(process.env.GAMMA_VALUE ?? 0.001),
}) {
    const d = Math.abs(parseFloat(delta));
    const g = Math.abs(parseFloat(gamma));

    // ── Index move distances (always positive) ───────────────────────────
    const indexSLMove = Math.abs(indexSL - indexEntry);
    const indexTargetMove = Math.abs(indexTarget - indexEntry);

    // ── SL side ──────────────────────────────────────────────────────────
    const avgDeltaSL = d + (g * indexSLMove / 2);
    const optionSLMove = indexSLMove * avgDeltaSL;

    // ── Target side ───────────────────────────────────────────────────────
    const avgDeltaTGT = d + (g * indexTargetMove / 2);
    const optionTargetMove = indexTargetMove * avgDeltaTGT;

    // ── SL buffer — based on optionSLMove (how far SL is from LTP) ───────
    // The deeper the SL move, the more buffer we add (protect against noise)
    //
    //  optionSLMove < 50  → add 10 pts
    //  optionSLMove < 70  → add  5 pts
    //  else               → add  0 pts
    function getSLBuffer(move) {
        if (move < 50) return 10;   // very tight SL → add 10 buffer
        if (move < 70) return 5;    // moderate SL   → add  5 buffer
        return 0;                   // wide SL       → no buffer needed
    }

    // ── Target buffer — based on optionTargetMove (how far TGT is) ───────
    // The bigger the target move, the more we trim (lock in conservative TGT)
    //
    //  optionTargetMove >= 300 → subtract 30 pts
    //  optionTargetMove >= 250 → subtract 20 pts
    //  optionTargetMove >= 200 → subtract 10 pts
    //  optionTargetMove >= 150 → subtract  5 pts
    //  else                    → subtract  0 pts
    function getTGTBuffer(move) {
        if (move >= 300) return 30;
        if (move >= 250) return 20;
        if (move >= 200) return 10;
        if (move >= 150) return 5;
        return 0;
    }

    const slBuffer = getSLBuffer(optionSLMove);
    const tgtBuffer = getTGTBuffer(optionTargetMove);

    // ── Absolute option price levels ──────────────────────────────────────
    // SL     = optionLTP - SLMove  - slBuffer   (wider  → less premature exit)
    // Target = optionLTP + TGTMove - tgtBuffer  (tighter → easier to hit)
    const optionSL = parseFloat((optionLTP - optionSLMove).toFixed(2));
    const optionTarget = parseFloat((optionLTP + optionTargetMove).toFixed(2));

    // ── Sanity guards ─────────────────────────────────────────────────────
    const safeOptionSL = Math.max(0.05, optionSL);
    const safeOptionTarget = Math.max(optionLTP + 0.05, optionTarget);

    return {
        optionSL: parseFloat(safeOptionSL.toFixed(2)),
        optionTarget: parseFloat(safeOptionTarget.toFixed(2)),
    };
}

// ATOMIC .ENV WRITER  (BUG 7 FIX)
// Multiple files (main.js, tokens.js, kotak_login.js) all write .env
// simultaneously — race condition corrupts file. This serializes writes.
// ─────────────────────────────────────────
import fs from "fs";
let _envWriteLock = false;
const _envWriteQueue = [];

async function _flushEnvQueue() {
    if (_envWriteLock || !_envWriteQueue.length) return;
    _envWriteLock = true;
    try {
        // Drain entire queue into one read-modify-write
        let env = fs.readFileSync(".env", "utf8");
        while (_envWriteQueue.length) {
            const { key, value } = _envWriteQueue.shift();
            env = env.replace(new RegExp(`^${key}=.*`, "m"), `${key}=${value}`);
        }
        fs.writeFileSync(".env", env, "utf8");
    } finally {
        _envWriteLock = false;
        if (_envWriteQueue.length) await _flushEnvQueue();
    }
}
export function updateEnvKey(key, value) {
    process.env[key] = value; // ✅ sync runtime env

    const envFile = ".env";
    let env = fs.readFileSync(envFile, "utf8");
    const regex = new RegExp(`^${key}=.*`, "m");
    if (env.match(regex)) {
        env = env.replace(regex, `${key}=${value}`);
    } else {
        env += `\n${key}=${value}`;
    }
    fs.writeFileSync(envFile, env);
}