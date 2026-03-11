import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { logger } from "../logger.js";
import { updateEnvKey } from "../helpers.js";
import { loadScripMaster } from "../scriptMaster.js";

const MONTH_MAP = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

function parseExpiry(str) {
    return new Date(parseInt(str.slice(5)), MONTH_MAP[str.slice(2, 5)], parseInt(str.slice(0, 2)));
}

// ─────────────────────────────────────────
// FUTURE TOKEN (cached daily)
// ─────────────────────────────────────────
export async function getFutureToken(symbolName = process.env.INDEX_SYMBOL || "SENSEX", refDate = new Date()) {
    const today = new Date().toDateString();
    const isLive = new Date(refDate).toDateString() === today;

    if (isLive && process.env.FUTURE_TOKEN && process.env.FUTURE_TOKEN_DATE === today) {
        logger.info("♻ Using cached future token");
        return process.env.FUTURE_TOKEN;
    }

    logger.info(`🔄 Fetching future token for refDate: ${new Date(refDate).toDateString()}...`);
    const res = await loadScripMaster();

    const now = new Date(refDate);
    const futures = res
        .filter(i => i.exch_seg === (process.env.EXCHANGE_SEGMENT || "BFO") && i.instrumenttype === "FUTIDX" && i.name === symbolName)
        .map(i => ({ ...i, expiryDate: parseExpiry(i.expiry) }))
        .filter(i => i.expiryDate >= now)
        .sort((a, b) => a.expiryDate - b.expiryDate);

    if (!futures.length) {
        logger.error("No valid futures found " + process.env.EXCHANGE_SEGMENT + " " + process.env.INDEX_SYMBOL + " " + futures);
        process.exit(1);
    }

    const current = futures[0];
    logger.info(`✅ Future: ${current.symbol} | token: ${current.token} | expiry: ${current.expiry}`);

    if (isLive) {
        // BUG 7 FIX: use atomic env writer to prevent race condition
        updateEnvKey("FUTURE_TOKEN", current.token);
        updateEnvKey("FUTURE_TOKEN_DATE", today);
    }

    return current.token;
}