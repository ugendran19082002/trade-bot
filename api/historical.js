import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { logger } from "../logger.js";
import { sleep } from "../helpers.js";

const UPSTOX_BASE_URL = process.env.UPSTOX_BASE_URL || "https://api.upstox.com/v3";

// ─────────────────────────────────────────
// INTERVAL MAPPING  (AngelOne string → Upstox minutes)
// ─────────────────────────────────────────
const INTERVAL_MAP = {
    ONE_MINUTE: 1,
    TWO_MINUTE: 2,
    THREE_MINUTE: 3,
    FIVE_MINUTE: 5,
    TEN_MINUTE: 10,
    FIFTEEN_MINUTE: 15,
    THIRTY_MINUTE: 30,
    ONE_HOUR: 60,
};
const DAILY_INTERVALS = new Set(["ONE_DAY", "1D", "DAY"]);

const isDaily = (interval) => DAILY_INTERVALS.has(interval?.toUpperCase?.() ?? interval);

function toUpstoxInterval(interval) {
    if (INTERVAL_MAP[interval]) return INTERVAL_MAP[interval];
    const n = parseInt(interval);
    if (!isNaN(n)) return n;
    logger.warn(`⚠ Unknown interval "${interval}" — defaulting to 1`);
    return 1;
}

// ─────────────────────────────────────────
// SHARED HELPER: fetch historical + append intraday, merge, sort, filter
// Eliminates the identical 4-step pattern duplicated in getHistorical + getFuture
// ─────────────────────────────────────────
async function fetchAndMergeCandles({ historicalUrl, intradayUrl, todate, label }) {
    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`,
    };

    const [historicalRes, intradayRes] = await Promise.all([
        axios.get(historicalUrl, { headers }),
        axios.get(intradayUrl, { headers }),
    ]);

    const historical = historicalRes.data?.data?.candles || [];
    const intraday = intradayRes.data?.data?.candles || [];

    logger.info(`📦 ${label} | Historical: ${historical.length} | Intraday: ${intraday.length}`);

    // Merge: historical base, intraday overwrites on same timestamp
    const map = new Map();
    for (const c of historical) map.set(c[0], c);
    for (const c of intraday) map.set(c[0], c);

    // Sort oldest → newest, then filter up to todate boundary
    const endBoundaryTs = todate ? new Date(todate).getTime() : Date.now();

    return Array.from(map.values())
        .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
        .filter(c => new Date(c[0]).getTime() <= endBoundaryTs);
}

// ─────────────────────────────────────────
// INDEX HISTORICAL CANDLES
// jwt / exchange kept for backwards compatibility — unused by Upstox
// token    → full Upstox key e.g. "BSE_INDEX|SENSEX"
// interval → "ONE_MINUTE" | "FIVE_MINUTE" | "ONE_DAY" etc.
// ─────────────────────────────────────────
export async function getHistorical(jwt, exchange, token, interval, fromdate, todate, retries = 3) {
    const today = new Date().toISOString().slice(0, 10);
    const toDate = (todate ?? "").slice(0, 10) || today;
    const fromDate = (fromdate ?? "").slice(0, 10) || toDate;

    logger.info(`📊 Upstox Historical | ${token} | ${interval} | ${fromDate} → ${toDate}`);

    try {
        let candles;

        if (isDaily(interval)) {
            // Daily candles use a different endpoint — no intraday equivalent
            const url =
                `${UPSTOX_BASE_URL}/historical-candle/${encodeURIComponent(token)}` +
                `/days/1/${toDate}/${fromDate}`;

            const res = await axios.get(url, {
                headers: { Accept: "application/json", Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}` },
            });

            const endBoundaryTs = todate ? new Date(todate).getTime() : Date.now();
            candles = (res.data?.data?.candles || [])
                .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
                .filter(c => new Date(c[0]).getTime() <= endBoundaryTs);

            logger.info(`📦 Daily candles: ${candles.length}`);

        } else {
            const minutes = toUpstoxInterval(interval);

            candles = await fetchAndMergeCandles({
                historicalUrl:
                    `${UPSTOX_BASE_URL}/historical-candle/${encodeURIComponent(token)}` +
                    `/minutes/${minutes}/${toDate}/${fromDate}`,
                intradayUrl:
                    `${UPSTOX_BASE_URL}/historical-candle/intraday/${encodeURIComponent(token)}` +
                    `/minutes/${minutes}`,
                todate,
                label: `${token} ${minutes}m`,
            });
        }

        if (!candles.length) {
            logger.warn(`⚠ No candles after filtering by toDate: ${todate}`);
            return [];
        }

        logger.info(`📈 ${interval} candles after filter: ${candles.length}`);
        return candles;

    } catch (err) {
        if (err.response?.status === 401) {
            logger.error(`❌ Upstox token expired — re-login required`);
            throw new Error("UPSTOX_INVALID_TOKEN");
        }
        if ((err.response?.status === 429 || err.response?.status === 403) && retries > 0) {
            logger.warn(`⚠ Upstox rate-limit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getHistorical(jwt, exchange, token, interval, fromdate, todate, retries - 1);
        }
        logger.error(`❌ getHistorical failed: ${err.message} | token: ${token} | interval: ${interval}`);
        return [];
    }
}

// ─────────────────────────────────────────
// FUTURE CANDLES
// token → AngelOne future token (numeric) e.g. 825565
// ─────────────────────────────────────────
export async function getFuture(token, fromdate, todate, interval = 2, retries = 3) {
    const INSTRUMENT_KEY = `${process.env.EXCHANGE}_FO|${token}`;
    const today = new Date().toISOString().slice(0, 10);
    const toDate = (todate ?? "").slice(0, 10) || today;
    const fromDate = (fromdate ?? "").slice(0, 10) || toDate;

    logger.info(`📊 Upstox Future | ${INSTRUMENT_KEY} | ${interval}m | ${fromDate} → ${toDate}`);

    try {
        const candles = await fetchAndMergeCandles({
            historicalUrl:
                `${UPSTOX_BASE_URL}/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}` +
                `/minutes/${interval}/${toDate}/${fromDate}`,
            intradayUrl:
                `${UPSTOX_BASE_URL}/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}` +
                `/minutes/${interval}`,
            todate,
            label: `${INSTRUMENT_KEY} ${interval}m`,
        });

        if (!candles.length) {
            logger.warn(`⚠ No future candles after filtering by toDate: ${todate}`);
            return [];
        }

        // Staleness check (live mode only — skip when replaying via todate)
        const lastCandle = candles[candles.length - 1];
        const endBoundaryTs = todate ? new Date(todate).getTime() : Date.now();
        const diffMin = (endBoundaryTs - Date.parse(lastCandle[0])) / 60000;

        logger.info(`🕒 Future last candle: ${lastCandle[0]} | Delay: ${diffMin.toFixed(2)}m`);

        if (!todate && diffMin > 30) {
            logger.warn(`⚠ Future data is ${diffMin.toFixed(1)}m old — check Upstox connection`);
        }

        logger.info(`  OI: ${lastCandle[6] ?? "N/A"} | Volume: ${lastCandle[5]}`);


        return candles;

    } catch (err) {
        if (err.response?.status === 401) {
            logger.error(`❌ Upstox token expired`);
            throw new Error("UPSTOX_INVALID_TOKEN");
        }
        if ((err.response?.status === 429 || err.response?.status === 403) && retries > 0) {
            logger.warn(`⚠ Future rate-limit — retrying (${retries} left)`);
            await sleep(2000);
            return getFuture(token, fromdate, todate, interval, retries - 1);
        }
        logger.error(`❌ Future fetch failed: ${err.message} | token: ${token}`);
        return [];
    }
}

// ─────────────────────────────────────────
// FORMAT  candle array → object
// Upstox format: [time, open, high, low, close, volume, oi]
// ─────────────────────────────────────────
export const format = raw => raw.map(c => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
    oi: c[6] ?? 0,
}));

// ─────────────────────────────────────────
// STALENESS CHECK
// ─────────────────────────────────────────
export function checkLastCandleStaleness(candles, type, logger, maxAgeMinutes = 10) {
    if (!candles?.length) {
        logger.warn(`⚠ No ${type} candles available`);
        return true;
    }
    const lastCandleTime = new Date(candles.at(-1)[0]);
    const ageMinutes = (Date.now() - lastCandleTime) / 60000;

    logger.info(
        `🕒 ${type} Last Candle IST: ${lastCandleTime.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata", hour12: false,
        })}`
    );
    logger.info(`⏳ ${type} Candle Age: ${ageMinutes.toFixed(2)} mins`);

    if (ageMinutes > maxAgeMinutes) {
        logger.warn(`⚠ ${type} candle stale (${ageMinutes.toFixed(2)} mins old)`);
        return true;
    }
    return false;
}

// ─────────────────────────────────────────
// MERGE CANDLES  (dedup + sort)
// ─────────────────────────────────────────
export function mergeCandlesUnique(oldCandles = [], intradayCandles = []) {
    const map = new Map();
    for (const c of oldCandles) map.set(c[0], c);
    for (const c of intradayCandles) map.set(c[0], c);
    return Array.from(map.values()).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
}