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
    delta = parseFloat(process.env.DELTA_VALUE ?? 0.5),
    gamma = parseFloat(process.env.GAMMA_VALUE ?? 0.001),
}) {
    // Re-parse: guard against caller passing raw env string
    const d = parseFloat(delta);
    const g = parseFloat(gamma);

    // Index move distances
    const indexSLMove = Math.abs(indexSL - indexEntry);
    const indexTargetMove = Math.abs(indexEntry - indexTarget);

    // SL side: delta increases as index moves against position
    const avgDeltaSL = (d + (d + g * indexSLMove)) / 2;
    const optionSLMove = indexSLMove * (avgDeltaSL + 0.15);

    // Target side: delta increases as option goes further in the money
    const avgDeltaTGT = (d + (d + g * indexTargetMove)) / 2;
    const optionTargetMove = indexTargetMove * avgDeltaTGT;

    // ✅ ABSOLUTE PRICE LEVELS — not raw move distances
    // These are sent directly to the broker as trigger/limit prices.
    // optionSL     = what the option will be worth when index hits SL
    // optionTarget = what the option will be worth when index hits target
    return {
        optionSL: parseFloat((optionLTP - optionSLMove).toFixed(2)),
        optionTarget: parseFloat((optionLTP + optionTargetMove).toFixed(2))
    };
}
// ─────────────────────────────────────────
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
    _envWriteQueue.push({ key, value });
    _flushEnvQueue().catch(() => { });
}