import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  RISK ENGINE
//  Enforces daily trade limits, daily loss cap, and max drawdown guard.
//  State persisted to risk_state.json so restarts don't lose daily counts.
// ═════════════════════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const STATE_FILE = path.resolve("risk_state.json");

const MAX_TRADES = parseInt(process.env.MAX_TRADES_PER_DAY ?? "5");
const MAX_LOSS_PTS = parseFloat(process.env.MAX_DAILY_LOSS_PTS ?? "2000");
const MAX_DD_PCT = parseFloat(process.env.MAX_DRAWDOWN_PCT ?? "3") / 100;

// ─────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────
function todayIST() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
            if (raw.date === todayIST()) return raw;
        }
    } catch (e) {
        logger.warn(`⚠ RiskEngine: could not load state — ${e.message}`);
    }
    return freshState();
}

function freshState() {
    return {
        date: todayIST(),
        dailyTrades: 0,
        dailyPnL: 0,   // running pts (negative = loss)
        peakPnL: 0,   // highest point reached today (for drawdown calc)
        blocked: false,
        blockReason: null,
    };
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        logger.warn(`⚠ RiskEngine: could not save state — ${e.message}`);
    }
}

// ─────────────────────────────────────────
// In-memory state (loaded once, persisted on change)
// ─────────────────────────────────────────
let _state = loadState();

// ─────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────

/**
 * Call this BEFORE placing any trade.
 * Returns { allowed: boolean, reason: string|null }
 */
export function canTrade() {
    _state = loadState(); // always reload (supports multi-process or PM2 restarts)

    if (_state.blocked) {
        return { allowed: false, reason: _state.blockReason };
    }

    if (_state.dailyTrades >= MAX_TRADES) {
        _block("max_trades_per_day");
        return { allowed: false, reason: "max_trades_per_day" };
    }

    if (_state.dailyPnL <= -MAX_LOSS_PTS) {
        _block("max_daily_loss");
        return { allowed: false, reason: "max_daily_loss" };
    }

    // Drawdown from peak
    const drawdown = _state.peakPnL - _state.dailyPnL;
    const drawdownPct = _state.peakPnL > 0
        ? drawdown / _state.peakPnL
        : 0;

    if (drawdownPct >= MAX_DD_PCT) {
        _block("max_drawdown");
        return { allowed: false, reason: "max_drawdown" };
    }

    return { allowed: true, reason: null };
}

/**
 * Call this AFTER a trade is closed with its PnL in index points.
 * @param {number} pnl - positive for profit, negative for loss
 */
export function recordTrade(pnl) {
    _state = loadState();
    _state.dailyTrades += 1;
    _state.dailyPnL += pnl;
    if (_state.dailyPnL > _state.peakPnL) {
        _state.peakPnL = _state.dailyPnL;
    }
    saveState(_state);

    logger.info(
        `📊 RiskEngine | Trades:${_state.dailyTrades}/${MAX_TRADES} | ` +
        `DailyPnL:${_state.dailyPnL.toFixed(2)} | Peak:${_state.peakPnL.toFixed(2)}`
    );
}

/**
 * Returns current risk status snapshot.
 */
export function getRiskStatus() {
    _state = loadState();
    return {
        dailyTrades: _state.dailyTrades,
        dailyPnL: _state.dailyPnL,
        peakPnL: _state.peakPnL,
        blocked: _state.blocked,
        blockReason: _state.blockReason,
        maxTrades: MAX_TRADES,
        maxLossPts: MAX_LOSS_PTS,
        maxDDPct: (MAX_DD_PCT * 100).toFixed(1) + "%",
    };
}

/**
 * Force-reset daily state (call at 09:15 IST or on new day detection).
 */
export function resetDaily() {
    _state = freshState();
    saveState(_state);
    logger.info("🔄 RiskEngine: daily state reset");
}

// ─────────────────────────────────────────
// Internal
// ─────────────────────────────────────────
function _block(reason) {
    _state.blocked = true;
    _state.blockReason = reason;
    saveState(_state);
    logger.warn(`🚨 RiskEngine BLOCKED → ${reason}`);
}
