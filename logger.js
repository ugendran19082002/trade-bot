import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import winston from "winston";

// ─────────────────────────────────────────
// LOGS FOLDER — date-based  e.g. logs/2026-03-10/
// ─────────────────────────────────────────
const LOGS_ROOT = "./logs";

function getTodayFolder() {
    const d = new Date();
    const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const y = ist.getFullYear();
    const m = String(ist.getMonth() + 1).padStart(2, "0");
    const day = String(ist.getDate()).padStart(2, "0");
    return path.join(LOGS_ROOT, `${y}-${m}-${day}`);
}

function ensureFolder(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ─────────────────────────────────────────
// AUTO-CLEANUP — delete folders older than 7 days
// ─────────────────────────────────────────
function cleanOldLogs() {
    if (!fs.existsSync(LOGS_ROOT)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const entry of fs.readdirSync(LOGS_ROOT)) {
        const fullPath = path.join(LOGS_ROOT, entry);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory() && stat.mtimeMs < cutoff) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            }
        } catch (_) { /* skip if already gone */ }
    }
}

cleanOldLogs();

// ─────────────────────────────────────────
// IST TIME
// ─────────────────────────────────────────
export function getISTTime(date = new Date()) {
    return date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(",", " |");
}

function istTimestamp() {
    return winston.format((info) => {
        info.timestamp = getISTTime();
        return info;
    })();
}

// ─────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const todayDir = ensureFolder(getTodayFolder());

const fileOpts = (name) => ({
    filename: path.join(todayDir, name),
    maxsize: 10 * 1024 * 1024, // 10 MB
    maxFiles: 3,
    tailable: true,
});

// ─────────────────────────────────────────
// MAIN LOGGER  →  logs/YYYY-MM-DD/bot.log
// ─────────────────────────────────────────
export const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        istTimestamp(),
        winston.format.printf(({ timestamp, level, message }) =>
            `${timestamp} [${level.toUpperCase()}]: ${message}`
        )
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File(fileOpts("bot.log")),
    ]
});

// ─────────────────────────────────────────
// TRADE LOGGER  →  logs/YYYY-MM-DD/trade.log
// ─────────────────────────────────────────
export const tradeLogger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        istTimestamp(),
        winston.format.printf(({ timestamp, message }) =>
            `${timestamp} | ${message}`
        )
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File(fileOpts("trade.log")),
    ]
});

// ─────────────────────────────────────────
// BACKTEST LOGGER  →  logs/YYYY-MM-DD/backtest.log
// No timestamps — clean report format
// ─────────────────────────────────────────
export const btLogger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.printf(({ message }) => message)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File(fileOpts("backtest.log")),
    ]
});

logger.info(`📁 Logs → ${todayDir}`);