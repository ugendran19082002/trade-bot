import dotenv from "dotenv";
dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
//  TRADE EXIT TRACKER  v2
//  ─────────────────────────────────────────────────────────────────────────
//  PURPOSE
//  ───────
//  After a trade exits (SL or TGT hit on SENSEX index points), the bot
//  must NOT re-enter immediately on the same price area.
//
//  Instead of a timer, we use a PRICE-LEVEL GATE:
//    → The previous trade's SL or TGT absolute index price becomes the gate.
//    → Next trade is allowed ONLY after the live index LTP crosses that level.
//
//  GATE DIRECTION TABLE
//  ─────────────────────
//  Exit type         Gate level    Direction to clear gate
//  ──────────────    ──────────    ───────────────────────
//  CE SL hit         SL level      LTP must go ABOVE SL level
//                                  (market recovers → bulls back in control)
//
//  CE TGT hit        TGT level     LTP must go BELOW TGT level
//                                  (pullback confirms → new setup forming)
//
//  PE SL hit         SL level      LTP must go BELOW SL level
//                                  (market drops back → bears back in control)
//
//  PE TGT hit        TGT level     LTP must go ABOVE TGT level
//                                  (bounce confirms → new setup forming)
//
//  EOD / MANUAL      no gate       Next trade immediately allowed
//
//  CACHE FILE: trade_exit_cache.json
//  ─────────────────────────────────────────────────────────────────────────
//  {
//    "lastExitReason"  : "SL" | "TGT" | "EOD" | "MANUAL",
//    "lastExitPrice"   : 76543.20,
//    "lastExitAt"      : "ISO string",
//    "lastEntryPrice"  : 76600.00,
//    "lastSide"        : "CE" | "PE",
//    "pnlPoints"       : -56.80,
//    "tradeCount"      : 3,
//    "gateActive"      : true,
//    "gateLevel"       : 76543.20,
//    "gateCrossDir"    : "ABOVE" | "BELOW",
//    "gateReason"      : "after_SL_CE" | "after_TGT_CE" | "after_SL_PE" | "after_TGT_PE"
//  }
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const CACHE_FILE = path.resolve("trade_exit_cache.json");

// ─────────────────────────────────────────────────────────────────────────
// DISK HELPERS
// ─────────────────────────────────────────────────────────────────────────
function readCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return _defaultCache();
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
        return { ..._defaultCache(), ...raw };
    } catch (e) {
        logger.warn(`⚠ ExitTracker: read error — ${e.message}`);
        return _defaultCache();
    }
}

function writeCache(data) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        logger.warn(`⚠ ExitTracker: write error — ${e.message}`);
    }
}

function _defaultCache() {
    return {
        lastExitReason: null,
        lastExitPrice: null,
        lastExitAt: null,
        lastEntryPrice: null,
        lastSide: null,
        pnlPoints: null,
        tradeCount: 0,
        gateActive: false,
        gateLevel: null,
        gateCrossDir: null,
        gateReason: null,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// INTERNAL: resolve which gate level + direction to use
// ─────────────────────────────────────────────────────────────────────────
function _resolveGate(exitReason, side, slLevel, tgtLevel) {
    const isCE = side === "CE";
    const isSL = exitReason === "SL";

    // CE SL hit  → price fell to SL. Wait for LTP to go back ABOVE SL level.
    if (isCE && isSL) return { gateLevel: slLevel, gateCrossDir: "ABOVE", gateReason: "after_SL_CE" };
    // CE TGT hit → price rose to TGT. Wait for LTP to pull back BELOW TGT level.
    if (isCE && !isSL) return { gateLevel: tgtLevel, gateCrossDir: "BELOW", gateReason: "after_TGT_CE" };
    // PE SL hit  → price rose to SL. Wait for LTP to fall back BELOW SL level.
    if (!isCE && isSL) return { gateLevel: slLevel, gateCrossDir: "BELOW", gateReason: "after_SL_PE" };
    // PE TGT hit → price fell to TGT. Wait for LTP to bounce ABOVE TGT level.
    return { gateLevel: tgtLevel, gateCrossDir: "ABOVE", gateReason: "after_TGT_PE" };
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────

/**
 * recordExit()
 * ─────────────
 * Call from onTradeExit() after every trade closes.
 * Writes exit info and activates the price-level gate (for SL/TGT exits).
 *
 * @param {object} p
 * @param {string} p.reason       "SL" | "TGT" | "EOD" | "MANUAL"
 * @param {number} p.exitPrice    Index price at moment of exit
 * @param {number} p.entryPrice   Index entry price of the closed trade
 * @param {string} p.side         "CE" | "PE"
 * @param {number} p.slLevel      Absolute SL index price level
 * @param {number} p.tgtLevel     Absolute TGT index price level
 */
export function recordExit({ reason, exitPrice, entryPrice, side, slLevel, tgtLevel }) {
    const cache = readCache();

    const isPE = side === "PE";
    const pnlPoints = parseFloat(
        (isPE ? entryPrice - exitPrice : exitPrice - entryPrice).toFixed(2)
    );

    // Gate is only set for SL / TGT exits with valid levels
    let gateActive = false, gateLevel = null, gateCrossDir = null, gateReason = null;

    if ((reason === "SL" || reason === "TGT") && slLevel != null && tgtLevel != null) {
        const g = _resolveGate(reason, side, slLevel, tgtLevel);
        gateActive = true;
        gateLevel = parseFloat(g.gateLevel.toFixed(2));
        gateCrossDir = g.gateCrossDir;
        gateReason = g.gateReason;
    }

    writeCache({
        ...cache,
        lastExitReason: reason,
        lastExitPrice: parseFloat(exitPrice.toFixed(2)),
        lastExitAt: new Date().toISOString(),
        lastEntryPrice: parseFloat(entryPrice.toFixed(2)),
        lastSide: side,
        pnlPoints,
        tradeCount: (cache.tradeCount ?? 0) + 1,
        gateActive,
        gateLevel,
        gateCrossDir,
        gateReason,
    });

    if (gateActive) {
        logger.info(
            `📝 ExitTracker | ${reason} | Side:${side} | Entry:${entryPrice} → Exit:${exitPrice} | PnL:${pnlPoints}pts\n` +
            `🔒 GATE ACTIVE → Next trade allowed only when index goes ${gateCrossDir} ${gateLevel} [${gateReason}]`
        );
    } else {
        logger.info(
            `📝 ExitTracker | ${reason} | Side:${side} | Entry:${entryPrice} → Exit:${exitPrice} | PnL:${pnlPoints}pts | Gate: NONE`
        );
    }
}

/**
 * isPriceLevelGatePassed(currentIndexLTP)
 * ─────────────────────────────────────────
 * THE KEY CHECK — call this from entryEngine every loop tick before
 * generating a signal.
 *
 * Returns:
 *   { passed: true }
 *     → Gate is open (or no gate). Signal is ALLOWED.
 *
 *   { passed: false, reason, gateLevel, gateCrossDir, currentLTP, ptsAway }
 *     → Gate still BLOCKED. Log the reason and return NO_TRADE.
 *
 * Auto-clears: when the price crosses the gate level, the gate is removed
 * from cache automatically so the next call returns passed:true without
 * any manual intervention.
 *
 * @param {number} currentIndexLTP — live SENSEX index price
 */
export function isPriceLevelGatePassed(currentIndexLTP) {
    const cache = readCache();

    // No gate → free to trade
    if (!cache.gateActive || cache.gateLevel == null) {
        return { passed: true };
    }

    const ltp = parseFloat(currentIndexLTP);
    const level = cache.gateLevel;
    const dir = cache.gateCrossDir;

    const crossed =
        (dir === "ABOVE" && ltp > level) ||
        (dir === "BELOW" && ltp < level);

    if (crossed) {
        // Gate passed → clear from cache
        writeCache({
            ...cache,
            gateActive: false,
            gateLevel: null,
            gateCrossDir: null,
            gateReason: null,
        });
        logger.info(
            `✅ ExitTracker GATE CLEARED | LTP:${ltp} went ${dir} ${level} [${cache.gateReason}] → Next signal ALLOWED`
        );
        return { passed: true };
    }

    // Still blocked — how many pts away?
    const ptsAway = parseFloat(
        (dir === "ABOVE" ? level - ltp : ltp - level).toFixed(2)
    );

    return {
        passed: false,
        reason: `gate_${cache.gateReason}`,
        gateLevel: level,
        gateCrossDir: dir,
        currentLTP: ltp,
        ptsAway,
    };
}

/**
 * isGateActive() — quick boolean
 */
export function isGateActive() {
    const c = readCache();
    return c.gateActive === true && c.gateLevel != null;
}

/**
 * getGateStatus() — full state for Telegram / logging
 */
export function getGateStatus() {
    const c = readCache();
    return {
        gateActive: c.gateActive,
        gateLevel: c.gateLevel,
        gateCrossDir: c.gateCrossDir,
        gateReason: c.gateReason,
        lastExitReason: c.lastExitReason,
        lastExitPrice: c.lastExitPrice,
        pnlPoints: c.pnlPoints,
        tradeCount: c.tradeCount,
    };
}

/**
 * getExitSummary() — full cache dump
 */
export function getExitSummary() {
    return readCache();
}

/**
 * forceOpenGate() — manual override (admin command / debug)
 */
export function forceOpenGate() {
    const c = readCache();
    writeCache({ ...c, gateActive: false, gateLevel: null, gateCrossDir: null, gateReason: null });
    logger.info("🔓 ExitTracker: gate force-opened (manual override)");
}

/**
 * resetDailyCache() — call at start of each trading day
 */
export function resetDailyCache() {
    const c = readCache();
    writeCache({
        ..._defaultCache(),
        tradeCount: 0,
        lastExitReason: c.lastExitReason,   // keep for reference
        lastExitPrice: c.lastExitPrice,
        lastExitAt: c.lastExitAt,
    });
    logger.info("🔄 ExitTracker: daily reset — gate cleared, tradeCount → 0");
}

// ─────────────────────────────────────────────────────────────────────────
// checkIndexExitCondition()
// ─────────────────────────────────────────────────────────────────────────
// Used by entryEngine / main.js to detect SL/TGT while a trade is open.
// Returns triggered reason + ABSOLUTE slLevel / tgtLevel so callers can
// pass them directly to recordExit() without re-computing.
//
// @param {number} currentIndexLTP
// @param {number} entryPrice
// @param {number} slPoints        index-point distance for SL
// @param {number} tgtPoints       index-point distance for TGT
// @param {string} side            "CE" | "PE"
// ─────────────────────────────────────────────────────────────────────────
export function checkIndexExitCondition({ currentIndexLTP, entryPrice, slPoints, tgtPoints, side }) {
    if (!currentIndexLTP || !entryPrice || !slPoints || !tgtPoints || !side) {
        return { triggered: false, reason: "missing_params" };
    }

    const ltp = parseFloat(currentIndexLTP);
    const isPE = side === "PE";

    const slLevel = isPE
        ? parseFloat((entryPrice + slPoints).toFixed(2))
        : parseFloat((entryPrice - slPoints).toFixed(2));

    const tgtLevel = isPE
        ? parseFloat((entryPrice - tgtPoints).toFixed(2))
        : parseFloat((entryPrice + tgtPoints).toFixed(2));

    if (isPE) {
        if (ltp >= slLevel) return { triggered: true, reason: "SL", slLevel, tgtLevel, ltp };
        if (ltp <= tgtLevel) return { triggered: true, reason: "TGT", slLevel, tgtLevel, ltp };
    } else {
        if (ltp <= slLevel) return { triggered: true, reason: "SL", slLevel, tgtLevel, ltp };
        if (ltp >= tgtLevel) return { triggered: true, reason: "TGT", slLevel, tgtLevel, ltp };
    }

    return { triggered: false, slLevel, tgtLevel, ltp };
}