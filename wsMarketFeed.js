import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET MARKET FEED
//  Real-time tick-driven strategy execution using AngelOne SmartAPI WebSocket.
//  Enable with USE_WEBSOCKET=true in .env
//  Falls back to REST polling if WebSocket disconnects or is disabled.
// ═════════════════════════════════════════════════════════════════════════════
import WebSocket from "ws";
import { logger } from "./logger.js";
import { sleep } from "./helpers.js";

const USE_WEBSOCKET = process.env.USE_WEBSOCKET === "true";

// AngelOne SmartAPI WebSocket endpoint
// Ref: https://smartapi.angelbroking.com/docs/WebSocket2
const WS_URL = process.env.ANGELONE_WS_URL || "wss://smartapisocket.angelone.in/smart-stream";

// ─────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────
let ws = null;
let isConnected = false;
let _onTick = null;   // callback(tickData)
let _jwt = null;
let _feedToken = null;
let _reconnectTimer = null;
const RECONNECT_DELAY_MS = 5000;

// ─────────────────────────────────────────
// Subscribe message builder (AngelOne format)
// ─────────────────────────────────────────
function buildSubscribeMsg(token) {
    return JSON.stringify({
        correlationID: "bot_feed",
        action: 1,           // 1 = subscribe
        params: {
            mode: 3,          // 3 = SNAP_QUOTE (OHLCV + OI)
            tokenList: [{
                exchangeType: parseInt(process.env.EXCHANGE_TYPE || "2"),    // 2 = BSE, 1 = NSE
                tokens: [token],
            }],
        },
    });
}

// ─────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────

/**
 * Start the WebSocket feed.
 * @param {string} jwt       - AngelOne JWT token
 * @param {string} feedToken - AngelOne feed token (from login response)
 * @param {string} token     - instrument token to subscribe
 * @param {Function} onTick  - callback(tickData) called on each price update
 */
export function startFeed(jwt, feedToken, token, onTick) {
    if (!USE_WEBSOCKET) {
        logger.info("ℹ WebSocket feed disabled (USE_WEBSOCKET=false) — using REST polling");
        return;
    }

    _jwt = jwt;
    _feedToken = feedToken;
    _onTick = onTick;

    _connect(token);
}

function _connect(token) {
    if (ws) {
        ws.removeAllListeners();
        ws.terminate();
    }

    logger.info(`🔌 WebSocket: connecting to ${WS_URL}`);

    ws = new WebSocket(WS_URL, {
        headers: {
            Authorization: _jwt.startsWith("Bearer ") ? _jwt : `Bearer ${_jwt}`,
            "x-api-key": process.env.API_KEY,
            "x-client-code": process.env.CLIENT_ID,
            "x-feed-token": _feedToken,
        },
    });

    ws.on("open", () => {
        isConnected = true;
        logger.info("✅ WebSocket: connected");
        ws.send(buildSubscribeMsg(token));
        logger.info(`📡 WebSocket: subscribed to token ${token}`);
    });

    ws.on("message", (data) => {
        try {
            const tick = _parseTick(data);
            if (tick && _onTick) _onTick(tick);
        } catch (err) {
            logger.warn(`⚠ WebSocket: tick parse error — ${err.message}`);
        }
    });

    ws.on("close", (code, reason) => {
        isConnected = false;
        logger.warn(`⚠ WebSocket: closed (code ${code}) — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        _scheduleReconnect(token);
    });

    ws.on("error", (err) => {
        isConnected = false;
        logger.error(`❌ WebSocket error: ${err.message}`);
        _scheduleReconnect(token);
    });
}

async function _scheduleReconnect(token) {
    if (_reconnectTimer) return;
    _reconnectTimer = true;
    await sleep(RECONNECT_DELAY_MS);
    _reconnectTimer = false;
    if (!isConnected) { // Make sure we haven't connected in another way
        _connect(token);
    }
}

/**
 * Parse AngelOne binary/JSON tick into a standardised tick object.
 * AngelOne SmartAPI sends binary frames — we parse key fields.
 */
function _parseTick(raw) {
    // AngelOne sends binary Buffer; attempt JSON parse as fallback for string frames
    let parsed;
    if (typeof raw === "string") {
        parsed = JSON.parse(raw);
    } else {
        // Binary frame: parse fields at known byte offsets (SmartAPI v2 format)
        // Byte layout reference: AngelOne SmartAPI docs — SNAP_QUOTE mode
        const buf = Buffer.from(raw);
        if (buf.length < 51) return null;

        const ltp = buf.readInt32BE(43) / 100;   // LTP at offset 43
        const volume = buf.readInt32BE(27);          // Volume at offset 27
        const oi = buf.readInt32BE(35);          // OI at offset 35

        parsed = { ltp, volume, oi, ts: Date.now() };
    }

    return {
        ltp: parsed.ltp ?? parsed.last_price ?? 0,
        volume: parsed.volume ?? 0,
        oi: parsed.oi ?? 0,
        ts: parsed.ts ?? Date.now(),
    };
}

/**
 * Gracefully close the WebSocket connection.
 */
export function stopFeed() {
    if (_reconnectTimer) {
        _reconnectTimer = false;
    }
    if (ws) {
        ws.removeAllListeners();
        ws.terminate();
        ws = null;
    }
    isConnected = false;
    logger.info("🔌 WebSocket: stopped");
}

/** Returns true if WebSocket is currently connected. */
export function isFeedConnected() { return isConnected; }
