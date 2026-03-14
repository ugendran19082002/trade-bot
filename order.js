import axios from "axios";
import dotenv from "dotenv";
import { sleep } from "./helpers.js";
import { logger } from "./logger.js";
import { getLTP } from "./getStrick.js";

dotenv.config();

const BASE_URL = process.env.KOTAK_BASEURL;
const LOT_SIZE = parseInt(process.env.LOT_SIZE ?? "20");
const EXCHANGE = "bse_fo";   // SENSEX options — BSE F&O

// ─────────────────────────────────────────────────────
// HEADERS
// ─────────────────────────────────────────────────────
export function kotakHeaders() {
    return {
        accept: "application/json",
        Auth: process.env.KOTAK_TOKEN,
        Sid: process.env.KOTAK_SID,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/x-www-form-urlencoded"
    };
}

function jData(data) {
    const p = new URLSearchParams();
    p.append("jData", JSON.stringify(data));
    return p.toString();
}

// ─────────────────────────────────────────────────────
// MARKET HOURS (IST)
// ─────────────────────────────────────────────────────
export function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────
function extractExecPrice(order) {
    const candidates = [
        order.avgExePrc, order.avgPrc, order.avgPr,
        order.fillPrc, order.flPr, order.prc,
        order.pr, order.trdPrc, order.execPrc, order.exePrc,
    ];
    for (const v of candidates) {
        const n = parseFloat(v);
        if (!isNaN(n) && n > 0) return n;
    }
    const fillAmt = parseFloat(order.flAmt ?? order.fillAmt ?? order.trdVal);
    const fillQty = parseFloat(order.flQty ?? order.fillQty ?? order.qt ?? order.qty);
    if (!isNaN(fillAmt) && !isNaN(fillQty) && fillQty > 0) {
        const c = fillAmt / fillQty;
        if (c > 0) return c;
    }
    return NaN;
}

function extractNetQty(pos) {
    for (const f of ["netQty", "netqty", "nQty", "qty", "qt"]) {
        const v = parseInt(pos[f]);
        if (!isNaN(v)) return v;
    }
    const flBuy = parseInt(pos.flBuyQty ?? pos.buyQty ?? pos.bQty ?? 0);
    const flSell = parseInt(pos.flSellQty ?? pos.sellQty ?? pos.sQty ?? 0);
    const cfBuy = parseInt(pos.cfBuyQty ?? pos.cfbQty ?? 0);
    const cfSell = parseInt(pos.cfSellQty ?? pos.cfsQty ?? 0);
    if (!isNaN(flBuy) && !isNaN(flSell)) return (flBuy + cfBuy) - (flSell + cfSell);
    return NaN;
}

// ─────────────────────────────────────────────────────
// GET POSITIONS
// ─────────────────────────────────────────────────────
export async function getPositions() {
    try {
        const res = await axios.get(
            `${BASE_URL}/quick/user/positions`,
            { headers: kotakHeaders(), timeout: 8000 }
        );
        return res.data?.data ?? [];
    } catch (err) {
        logger.error(`❌ GetPositions: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────
// GET ORDER BOOK
// ─────────────────────────────────────────────────────
async function getOrderBook() {
    try {
        const res = await axios.get(
            `${BASE_URL}/quick/user/orders`,
            { headers: kotakHeaders(), timeout: 8000 }
        );
        return res.data?.data ?? [];
    } catch (err) {
        logger.error(`❌ GetOrderBook: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────
// CANCEL REGULAR ORDER
// ─────────────────────────────────────────────────────
async function cancelOrder(orderId) {
    try {
        await axios.post(
            `${BASE_URL}/quick/order/cancel`,
            jData({ on: orderId, am: "NO" }),
            { headers: kotakHeaders() }
        );
        logger.info(`🧹 Cancelled: ${orderId}`);
        return true;
    } catch (err) {
        if (err.response?.status === 400) return false;
        logger.error(`❌ Cancel: ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// EXIT BRACKET ORDER
// Uses /bo/exit endpoint — closes both SL + Target legs
// ─────────────────────────────────────────────────────
async function exitBracketOrder(orderId) {
    try {
        const res = await axios.post(
            `${BASE_URL}/quick/order/bo/exit`,
            jData({ on: String(orderId), am: "NO" }),
            { headers: kotakHeaders() }
        );
        if (res.data?.stat === "Ok") {
            logger.info(`✅ BO Exit placed: ${res.data.nOrdNo}`);
            return true;
        }
        logger.error(`❌ BO Exit failed: ${JSON.stringify(res.data)}`);
        return false;
    } catch (err) {
        logger.error(`❌ BO Exit error: ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// CLEANUP PENDING ORDERS
// ─────────────────────────────────────────────────────
export async function cleanupOrders(symbol) {
    const orders = await getOrderBook();
    const pending = orders.filter(o =>
        o.trdSym === symbol &&
        ["open", "pending", "trigger pending", "after market order req received"]
            .includes(String(o.ordSt).toLowerCase())
    );
    if (!pending.length) return;
    logger.info(`🧹 Cancelling ${pending.length} pending orders for ${symbol}`);
    for (const o of pending) {
        await cancelOrder(o.nOrdNo);
        await sleep(500);
    }
}

// ─────────────────────────────────────────────────────
// MARKET EXIT (emergency fallback)
// ─────────────────────────────────────────────────────
export async function marketExit(symbol, boOrderId = null) {
    try {
        // If we have the BO order ID, use bo/exit — cleanest way
        if (boOrderId) {
            const ok = await exitBracketOrder(boOrderId);
            if (ok) return true;
        }

        // Fallback: MKT sell against position
        const positions = await getPositions();
        const p = positions.find(pos =>
            pos.trdSym === symbol &&
            extractNetQty(pos) !== 0 &&
            !isNaN(extractNetQty(pos))
        );
        if (!p) {
            logger.warn("⚠ marketExit: No position found");
            await cleanupOrders(symbol);
            return false;
        }
        const qty = Math.abs(extractNetQty(p));
        const body = {
            am: "NO", dq: "0", es: EXCHANGE, mp: "0",
            pc: p.prod || "MIS", pf: "N", pr: "0", pt: "MKT",
            qt: String(qty), rt: "DAY", tp: "0",
            ts: symbol, tt: extractNetQty(p) > 0 ? "S" : "B"
        };
        const res = await axios.post(
            `${BASE_URL}/quick/order/rule/ms/place`,
            jData(body),
            { headers: kotakHeaders() }
        );
        if (res.data?.stat === "Ok") {
            logger.info(`✅ Market Exit: ${res.data.nOrdNo}`);
            await cleanupOrders(symbol);
            return true;
        }
        return false;
    } catch (err) {
        logger.error(`❌ Market Exit: ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// CHECK EXIT & CLEANUP
// ─────────────────────────────────────────────────────
export async function checkExitAndCleanup(symbol, params = {}) {
    if (!symbol) return;
    const { currentIndexLTP, indexSL, indexTGT, isPE, boOrderId } = params;

    // 1. Index-level structural exit
    if (currentIndexLTP && indexSL && indexTGT) {
        const price = parseFloat(currentIndexLTP);
        let triggerReason = null;
        if (isPE) {
            if (price >= indexSL) triggerReason = "SL EXIT";
            else if (price <= indexTGT) triggerReason = "TGT EXIT";
        } else {
            if (price <= indexSL) triggerReason = "SL EXIT";
            else if (price >= indexTGT) triggerReason = "TGT EXIT";
        }
        if (triggerReason) {
            logger.info(`🎯 Index exit: ${triggerReason} (LTP:${price})`);
            await marketExit(symbol, boOrderId);
            return { exited: true, exitPrice: triggerReason };
        }
    }

    // 2. Check if broker BO already filled (position gone)
    const positions = await getPositions();
    const existing = positions.find(p =>
        p.trdSym === symbol &&
        extractNetQty(p) !== 0 &&
        !isNaN(extractNetQty(p))
    );
    if (!existing) {
        let finalExitPrice = NaN;
        try {
            const orders = await getOrderBook();
            const symOrders = orders.filter(o => o.trdSym === symbol);
            const FILLED = ["traded", "complete", "filled", "executed", "f", "s"];
            const ex = symOrders.find(o =>
                FILLED.includes(String(o.ordSt).toLowerCase()) &&
                (o.tt === "S" || o.tt === "s")
            );
            if (ex) finalExitPrice = extractExecPrice(ex);
        } catch (e) {
            logger.error(`❌ Exit price fetch: ${e.message}`);
        }
        await cleanupOrders(symbol);
        return { exited: true, exitPrice: finalExitPrice };
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════
//  EXECUTE ORDER — TRUE BRACKET ORDER on BSE F&O
//
//  App screenshot confirms: BSE F&O supports Bracket Order (BO)
//  - Product type: "Bracket order" (pc:"BO")
//  - Stoploss spread = rupee distance below entry (slv)
//  - Target spread   = rupee distance above entry (sov)
//  - slt/sot = "Absolute" (rupee amounts, not ticks)
//
//  ONE single API call → entry + SL + target all placed together
//  Exchange manages both legs — no margin conflict, no timing issues
// ═══════════════════════════════════════════════════════════════════
export async function executeOrder(signal) {
    let { optionToken, optionSymbol, optionLTP } = signal;

    if (!optionToken || optionLTP == null) {
        logger.warn("⚠ executeOrder: missing token or LTP");
        return;
    }
    if (!isMarketOpen()) {
        const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        logger.warn(`⚠ Market closed (IST ${ist.getHours()}:${String(ist.getMinutes()).padStart(2, "0")})`);
        return;
    }

    const symbol = optionSymbol;

    // Cleanup stale + check no existing position
    await cleanupOrders(symbol);
    await sleep(500);
    const positions = await getPositions();
    const existing = positions.find(p =>
        p.trdSym === symbol &&
        extractNetQty(p) !== 0 &&
        !isNaN(extractNetQty(p))
    );
    if (existing) {
        logger.warn(`⚠ Already in position for ${symbol} — skipping`);
        return;
    }

    // ── Resolve absolute SL & Target prices ──────────────────────────────


    // ── Tick alignment helper (BSE F&O tick = Rs0.05) ─────────────────────
    const toTick = (v) => parseFloat((Math.round(v / 0.05) * 0.05).toFixed(2));

    // ── Fetch live LTP via Angel One (market data provider) ─────────────────
    // Angel One segment for BSE F&O is always "BFO" — independent of Kotak "bse_fo".
    // getLTP returns the fetched[] array; extract ltp from element 0.
    const ltpResult = await getLTP({ BFO: [String(optionToken)] });
    const rawLTP = parseFloat(ltpResult?.[0]?.ltp ?? 0);

    // Fall back to signal LTP if live fetch failed (market closed / API error)
    const liveLTP = rawLTP > 0 ? rawLTP : optionLTP;
    if (rawLTP <= 0) {
        logger.warn(`⚠ Live LTP fetch returned 0 — using signal LTP ${optionLTP} as fallback`);
    }

    // ── Entry price: tick-rounded to live LTP ───────────────────────────────
    // Kotak BO validates pr == current LTP/ATP (stCode 1031 if mismatched).
    // Never offset by -0.05 — use exact tick-rounded value.
    const entryPrice = toTick(liveLTP);

    // ── Tick-align SL & Target so leg distances are clean multiples of 0.05 ─
    // Un-aligned values produce fractional slv/sov that Kotak may reject.
    const slDistance = toTick(parseFloat(process.env.OPTION_SL ?? "50"));
    const tgtDistance = toTick(parseFloat(process.env.OPTION_TGT ?? "300"));

    // Guard: both legs must be at least one tick (Rs0.05)
    if (slDistance < 0.05 || tgtDistance < 0.05) {
        logger.error(`❌ Invalid BO distances: slDist=${slDistance} tgtDist=${tgtDistance} — aborting`);
        return;
    }

    logger.info(`📐 Bracket Order | Entry:${entryPrice} | SL:${process.env.OPTION_SL} (dist:${slDistance}) | TGT:${process.env.OPTION_TGT} (dist:${tgtDistance})`);

    // ── PLACE BRACKET ORDER ───────────────────────────────────────────────
    // Single API call — exchange places entry + SL + target together
    const body = {
        am: "NO",            // BO not allowed as AMO
        dq: "0",
        es: EXCHANGE,        // bse_fo
        mp: "0",
        pc: "BO",            // ✅ Bracket Order
        pf: "N",
        pr: String(entryPrice),     // entry limit price
        pt: "L",                    // Limit entry (required for BO)
        qt: String(LOT_SIZE),
        rt: "DAY",
        tp: "0",
        ts: symbol,
        tt: "B",
        lat: "LTP",              // ✅ ADD THIS — required for BO
        // ── Bracket legs ──────────────────────────────────────────────
        slt: "Absolute",             // SL type = rupee amount
        slv: String(slDistance),     // ✅ SL distance (rupees below entry)
        sot: "Absolute",             // Target type = rupee amount
        sov: String(tgtDistance),    // ✅ Target distance (rupees above entry)
        tlt: "N",                    // No trailing SL
        tsv: "0"                     // Trailing SL value = 0
    };

    try {
        const res = await axios.post(
            `${BASE_URL}/quick/order/rule/ms/place`,
            jData(body),
            { headers: kotakHeaders(), timeout: 8000 }
        );

        if (res.data?.stat === "Ok" && res.data?.nOrdNo) {
            const orderNo = res.data.nOrdNo;
            logger.info(`✅ BRACKET ORDER PLACED: ${orderNo}`);
            logger.info(`   📌 Entry  : ${entryPrice} (Limit BUY)`);
            logger.info(`   🛡  SL     : ${process.env.OPTION_SL}  (falls by ₹${slDistance})`);
            logger.info(`   🎯 Target  : ${process.env.OPTION_TGT} (rises by ₹${tgtDistance})`);
            logger.info(`   📋 Symbol  : ${symbol} | Qty: ${LOT_SIZE} | Exchange: ${EXCHANGE}`);
            return { orderNo, optionSL: process.env.OPTION_SL, optionTarget: process.env.OPTION_TGT, entryPrice, slDistance, tgtDistance };
        }

        logger.error(`❌ Bracket Order failed: ${JSON.stringify(res.data)}`);
        return null;

    } catch (err) {
        logger.error(`❌ Bracket Order error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        return null;
    }
}