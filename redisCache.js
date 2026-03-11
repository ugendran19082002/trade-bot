import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  REDIS CACHE — lazy-init, zero startup noise
//  Connection is attempted on first actual use, not at module load.
//  This avoids the ESM load-order issue where dotenv isn't yet applied.
//  Enable with USE_REDIS=true in .env
// ═════════════════════════════════════════════════════════════════════════════
import { logger } from "./logger.js";

let redis = null;
let redisReady = false;
let initDone = false;   // so we only attempt once per process
let _redisWarnedOnce = false; // warn ONCE per process — not every loop tick

const TTL = { "1m": 60, "5m": 300, "15m": 900, "1D": 86400 };

// ─────────────────────────────────────────
// Internal: lazy connect (called on first get/set)
// ─────────────────────────────────────────
async function ensureConnected() {
    if (initDone) return;              // already tried (success or fail)
    initDone = true;

    const USE_REDIS = process.env.USE_REDIS === "true";
    if (!USE_REDIS) {
        logger.info("ℹ Redis cache disabled (USE_REDIS=false)");
        return;
    } else {
        logger.info("✅ Redis cache enabled (USE_REDIS=true)");
    }

    try {
        const { default: Redis } = await import("ioredis");

        redis = new Redis({
            host: process.env.REDIS_HOST ?? "127.0.0.1",
            port: parseInt(process.env.REDIS_PORT ?? "6379"),
            lazyConnect: true,
            connectTimeout: 3000,
            retryStrategy: () => null,   // no retries
            enableOfflineQueue: false,
        });

        // Attach BEFORE connect() — prevents unhandled error events
        // warnedOnce is module-level so warn fires ONCE per process, not per loop
        redis.on("error", () => {
            redisReady = false;
            if (!_redisWarnedOnce) {
                _redisWarnedOnce = true;
                logger.warn("⚠ Redis unavailable — falling back to direct API (set USE_REDIS=false to silence)");
            }
        });
        redis.on("close", () => { redisReady = false; });
        redis.on("connect", () => { redisReady = true; logger.info("✅ Redis connected"); });

        await redis.connect().catch(() => { });  // error handled above
        // redisReady set by event listeners

    } catch (err) {
        logger.warn(`⚠ Redis init error: ${err.message}`);
    }
}

// ─────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────

export async function setCandles(key, data, tfLabel = "1m") {
    await ensureConnected();
    if (!redisReady || !redis) return;
    try {
        const ttl = TTL[tfLabel] ?? 60;
        await redis.set(key, JSON.stringify(data), "EX", ttl);
        logger.info(`💾 Redis SET ${key} (${data.length} candles, TTL ${ttl}s)`);
    } catch (err) {
        logger.warn(`⚠ Redis SET [${key}]: ${err.message}`);
    }
}

export async function getCandles(key) {
    await ensureConnected();
    if (!redisReady || !redis) return null;
    try {
        const raw = await redis.get(key);
        if (!raw) return null;
        const data = JSON.parse(raw);
        logger.info(`⚡ Redis HIT ${key} (${data.length} candles)`);
        return data;
    } catch (err) {
        logger.warn(`⚠ Redis GET [${key}]: ${err.message}`);
        return null;
    }
}

export async function invalidate(key) {
    await ensureConnected();
    if (!redisReady || !redis) return;
    try { await redis.del(key); } catch (_) { }
}

export function isRedisReady() { return redisReady; }