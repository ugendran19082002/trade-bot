import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET MARKET FEED  (Upstox v3)
//  Real-time tick-driven strategy execution using Upstox WebSocket v3.
//  Enable with USE_WEBSOCKET=true in .env
//  Falls back to REST polling if WebSocket disconnects or is disabled.
//
//  Requires:  npm install protobufjs
// ═════════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import axios from "axios";
import protobuf from "protobufjs";
import { logger } from "./logger.js";
import { sleep } from "./helpers.js";

const USE_WEBSOCKET = process.env.USE_WEBSOCKET === "true";

// ─────────────────────────────────────────
// Upstox v3 endpoints
// ─────────────────────────────────────────
const UPSTOX_AUTH_URL   = "https://api.upstox.com/v3/feed/market-data-feed/authorize";
const UPSTOX_WS_URL     = "wss://api.upstox.com/v3/feed/market-data-feed";
const PROTO_URL         = "https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto";

// ─────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────
let ws               = null;
let isConnected      = false;
let _onTick          = null;
let _reconnectTimer  = null;
let _FeedResponse    = null;   // protobuf type — loaded once at startup

const RECONNECT_DELAY_MS = 5_000;

// ─────────────────────────────────────────
// Load Protobuf schema from Upstox CDN
// ─────────────────────────────────────────
async function loadProto() {
    if (_FeedResponse) return; // already loaded

    try {
        logger.info("📦 Loading Upstox v3 protobuf schema...");

        // protobuf.load() only handles file paths — fetch manually via axios
        const res = await axios.get(PROTO_URL, { responseType: "text" });
        const protoText = res.data;

        const root = protobuf.parse(protoText, { keepCase: true }).root;

        _FeedResponse = root.lookupType(
            "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse"
        );

        logger.info("✅ Protobuf schema loaded");

    } catch (err) {
        logger.error(`❌ Failed to load protobuf schema: ${err.message}`);
        throw err;
    }
}

// ─────────────────────────────────────────
// Authorize and get redirect WebSocket URL
// ─────────────────────────────────────────
async function getAuthorizedWS() {
    try {
        const res = await axios.get(UPSTOX_AUTH_URL, {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
            },
            maxRedirects: 0,          // don't follow — we want the redirect URL
            validateStatus: (s) => s < 400
        });

        // v3 returns 302 redirect — grab Location header as WS URL
        const redirectUrl = res.headers?.location;
        if (redirectUrl && redirectUrl.startsWith("wss://")) {
            logger.info(`🔑 Authorized WS URL obtained via redirect`);
            return redirectUrl;
        }

        // Some responses return it in the body
        const bodyUrl = res.data?.data?.authorized_redirect_uri
                     || res.data?.data?.authorizedRedirectUri;
        if (bodyUrl) return bodyUrl;

        // Fallback: connect directly with Bearer token in header
        logger.warn("⚠ No redirect URL found — using direct WS URL with Bearer token");
        return UPSTOX_WS_URL;

    } catch (err) {
        logger.warn(`⚠ Auth endpoint error: ${err.message} — using direct WS URL`);
        return UPSTOX_WS_URL;
    }
}

// ─────────────────────────────────────────
// Build subscribe message (v3 format)
// NOTE: v3 requires binary (Buffer), NOT text
// ─────────────────────────────────────────
function buildSubscribeMsg(instrumentKey, mode = "ltpc") {
    const payload = JSON.stringify({
        guid: `sub_${Date.now()}`,
        method: "sub",
        data: {
            mode,
            instrumentKeys: [instrumentKey]
        }
    });

    // v3 requires binary frame
    return Buffer.from(payload, "utf-8");
}

// ─────────────────────────────────────────
// Decode protobuf binary tick → plain object
// ─────────────────────────────────────────
function decodeTick(binaryData) {
    if (!_FeedResponse) {
        logger.warn("⚠ Protobuf not loaded yet — skipping tick");
        return null;
    }

    try {
        const buffer = Buffer.isBuffer(binaryData)
            ? binaryData
            : Buffer.from(binaryData);

        const decoded = _FeedResponse.decode(buffer);
        const obj     = _FeedResponse.toObject(decoded, { longs: Number, defaults: true });

        // market_info tick (type=2) — no price data, skip
        if (obj.type === 2) return null;

        // Extract LTP from the first feed entry
        const feedEntries = Object.entries(obj.feeds || {});
        if (!feedEntries.length) return null;

        const [instrumentKey, feed] = feedEntries[0];

        // ltpc mode
        const ltpc = feed?.ltpc;
        if (ltpc?.ltp) {
            return {
                ltp:           ltpc.ltp,
                cp:            ltpc.cp  || 0,
                volume:        0,
                oi:            0,
                instrumentKey,
                ts:            Date.now()
            };
        }

        // full mode — try marketFF or indexFF
        const marketFF = feed?.fullFeed?.marketFF;
        const indexFF  = feed?.fullFeed?.indexFF;
        const ff       = marketFF || indexFF;

        if (ff?.ltpc?.ltp) {
            return {
                ltp:           ff.ltpc.ltp,
                cp:            ff.ltpc.cp   || 0,
                volume:        ff.vtt        || 0,
                oi:            ff.oi         || 0,
                instrumentKey,
                ts:            Date.now()
            };
        }

        return null;

    } catch (err) {
        logger.warn(`⚠ Protobuf decode error: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────
// Connect WebSocket
// ─────────────────────────────────────────
async function _connect(token) {

    // Clean up any existing connection
    if (ws) {
        ws.removeAllListeners();
        ws.terminate();
        ws = null;
    }

    // Ensure proto is loaded before connecting
    try {
        await loadProto();
    } catch {
        logger.error("❌ Cannot connect — protobuf schema unavailable");
        _scheduleReconnect(token);
        return;
    }

    let WS_URL;
    try {
        WS_URL = await getAuthorizedWS();
    } catch {
        logger.error("❌ Unable to obtain WebSocket URL");
        _scheduleReconnect(token);
        return;
    }

    logger.info(`🔌 WebSocket: connecting to ${WS_URL}`);

    ws = new WebSocket(WS_URL, {
        followRedirects: true,       // required for Upstox v3 auth redirect
        headers: {
            Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`,
            Accept: "*/*"
        }
    });

    // ── Event handlers ────────────────────────────────────────────────────

    ws.on("open", () => {
        isConnected = true;
        logger.info("✅ WebSocket: connected (Upstox v3)");

        // v3: subscribe message must be sent as binary
        const msg = buildSubscribeMsg(token, "ltpc");
        ws.send(msg, { binary: true });

        logger.info(`📡 WebSocket: subscribed to ${token} [ltpc mode]`);
    });

    ws.on("message", (data) => {
        try {
            // v3 always sends binary protobuf — skip text frames (pings etc.)
            if (typeof data === "string") return;

            const tick = decodeTick(data);

            if (tick && _onTick) {
                _onTick(tick);
            }

        } catch (err) {
            logger.warn(`⚠ WebSocket message error: ${err.message}`);
        }
    });

    ws.on("close", (code) => {
        isConnected = false;
        logger.warn(`⚠ WebSocket: closed (code ${code}) — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        _scheduleReconnect(token);
    });

    ws.on("error", (err) => {
        isConnected = false;
        logger.error(`❌ WebSocket error: ${err.message}`);
        _scheduleReconnect(token);
    });

    ws.on("ping", () => {
        // ws library auto-responds with pong — just log occasionally
        logger.debug("🏓 WebSocket: ping received");
    });
}

// ─────────────────────────────────────────
// Reconnect with backoff
// ─────────────────────────────────────────
async function _scheduleReconnect(token) {
    if (_reconnectTimer) return; // already scheduled

    _reconnectTimer = true;

    await sleep(RECONNECT_DELAY_MS);

    _reconnectTimer = false;

    if (!isConnected) {
        logger.info("🔄 WebSocket: attempting reconnect...");
        _connect(token);
    }
}

// ─────────────────────────────────────────
// PUBLIC: Start feed
// ─────────────────────────────────────────
export async function startFeed(feedToken, token, onTick) {

    if (!USE_WEBSOCKET) {
        logger.info("ℹ WebSocket feed disabled (USE_WEBSOCKET=false) — using REST polling");
        return;
    }

    _onTick = onTick;

    await _connect(token);
}

// ─────────────────────────────────────────
// PUBLIC: Stop feed
// ─────────────────────────────────────────
export function stopFeed() {
    _reconnectTimer = false;

    if (ws) {
        ws.removeAllListeners();
        ws.terminate();
        ws = null;
    }

    isConnected = false;
    logger.info("🔌 WebSocket: stopped");
}

// ─────────────────────────────────────────
// PUBLIC: Check connection status
// ─────────────────────────────────────────
export function isFeedConnected() {
    return isConnected;
}