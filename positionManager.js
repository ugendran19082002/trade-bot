import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  POSITION MANAGER
//  Tracks the current open position and persists it to disk.
//  On bot restart, the open position is automatically reloaded so the bot
//  can continue monitoring SL / Target without re-entering the trade.
//
//  Best Practices:
//  - openPosition() called ONLY after order is confirmed placed
//  - All state mutations go through savePosition() to stay in sync
//  - Invalid signalObj fields are validated with warnings, never throw
// ═════════════════════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const STATE_FILE = path.resolve("position_state.json");

// ─────────────────────────────────────────
// Disk helpers
// ─────────────────────────────────────────
function loadPosition() {
    try {
        if (!fs.existsSync(STATE_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        // Validate restored position has required fields
        if (raw && raw.optionSymbol && raw.side && raw.entry) {
            logger.info(`📂 PositionManager: restored — ${raw.optionSymbol} ${raw.side} @ ${raw.entry}`);
            return raw;
        }
        logger.warn("⚠ PositionManager: state file missing required fields — ignoring");
        clearPositionFile();
        return null;
    } catch (e) {
        logger.warn(`⚠ PositionManager: could not load state — ${e.message}`);
        return null;
    }
}

function savePosition(pos) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(pos, null, 2));
    } catch (e) {
        logger.warn(`⚠ PositionManager: could not save state — ${e.message}`);
    }
}

function clearPositionFile() {
    try {
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } catch (e) {
        logger.warn(`⚠ PositionManager: could not clear state — ${e.message}`);
    }
}

// ─────────────────────────────────────────
// In-memory current position
// ─────────────────────────────────────────
let _position = loadPosition();  // null = flat

// ─────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────

/**
 * Open a new position from a signalObj returned by entryEngine.
 * MUST be called only after the broker order is confirmed placed.
 * @param {Object} signalObj
 */
export function openPosition(signalObj) {
    if (_position) {
        logger.warn("⚠ PositionManager: already have an open position — ignoring openPosition()");
        return;
    }

    // Validate required fields
    if (!signalObj?.signal || !signalObj?.entryPrice) {
        logger.error("❌ PositionManager: invalid signalObj — missing signal or entryPrice");
        return;
    }

    if (!signalObj.optionSymbol) {
        logger.warn("⚠ PositionManager: optionSymbol missing — position tracking may be incomplete");
    }

    _position = {
        optionSymbol: signalObj.optionSymbol ?? null,   // e.g. "SENSEX2630580300PE"
        optionToken: signalObj.optionToken ?? null,
        side: signalObj.signal,                 // "CE" | "PE"
        entry: signalObj.entryPrice,
        sl: signalObj.slPrice,
        target: signalObj.tgtPrice,
        slPoints: signalObj.slPoints,
        tgtPoints: signalObj.tgtPoints,
        optionEntry: signalObj.optionLTP ?? null,
        optionSL: signalObj.optionSL ?? null,
        optionTarget: signalObj.optionTarget ?? null,
        openedAt: new Date().toISOString(),
    };

    savePosition(_position);
    logger.info(
        `📌 PositionManager: OPENED ${_position.side} @ ${_position.entry} | ` +
        `SL:${_position.sl} | TGT:${_position.target} | Symbol:${_position.optionSymbol ?? "N/A"}`
    );
}

/**
 * Close and clear the current position.
 * @param {string} reason - e.g. "SL", "TGT", "MANUAL"
 * @param {number} exitPrice
 */
export function closePosition(reason = "UNKNOWN", exitPrice = 0) {
    if (!_position) {
        logger.warn("⚠ PositionManager: closePosition() called with no open position");
        return null;
    }

    const closed = { ..._position, closedAt: new Date().toISOString(), exitReason: reason, exitPrice };
    logger.info(
        `❌ PositionManager: CLOSED ${closed.side} | Reason:${reason} | ` +
        `Exit:${exitPrice} | Entry:${closed.entry} | Symbol:${closed.optionSymbol ?? "N/A"}`
    );

    _position = null;
    clearPositionFile();
    return closed;
}

/** Returns true if there is NO open position. */
export function isFlat() { return _position === null; }

/** Returns true if there IS an open position. */
export function isOpen() { return _position !== null; }

/** Returns the full position object, or null if flat. */
export function getPosition() { return _position ? { ..._position } : null; }   // defensive copy

/**
 * Update SL/Target on an existing position (e.g. trailing stop).
 * @param {Object} updates - partial fields to merge into position
 */
export function updatePosition(updates = {}) {
    if (!_position) {
        logger.warn("⚠ PositionManager: updatePosition() called with no open position");
        return;
    }
    _position = { ..._position, ...updates, updatedAt: new Date().toISOString() };
    savePosition(_position);
    logger.info(`🔄 PositionManager: updated — SL:${_position.sl} TGT:${_position.target}`);
}

/**
 * Log current position status to console.
 */
export function logStatus() {
    if (!_position) {
        logger.info("📊 PositionManager: FLAT (no open position)");
    } else {
        logger.info(
            `📊 PositionManager: OPEN ${_position.side} | ` +
            `Entry:${_position.entry} SL:${_position.sl} TGT:${_position.target} | ` +
            `Symbol:${_position.optionSymbol ?? "N/A"} | Since:${_position.openedAt}`
        );
    }
}
