import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  INDICATOR WORKER  (Worker Thread)
//  Runs inside a separate thread — receives OHLCV data via workerData,
//  performs all CPU-heavy indicator calculations, and posts result back.
//
//  Usage: called by entryEngine via runIndicatorWorker()
//  Enable with USE_WORKER_THREADS=true in .env
// ═════════════════════════════════════════════════════════════════════════════
import { workerData, parentPort } from "worker_threads";

// Import indicator functions — worker_threads run in separate context
// but can import ESM modules directly (Node 18+)
import {
    calculateEMA,
    calculateRSI,
    calculateATR,
    calculateADX,
    calculateVWAP,
    volumeSpike,
} from "./indicators.js";
import { buildTimeframe } from "./helpers.js";

async function run() {
    try {
        const { index1m, index5m, index15m, future1m, data1D } = workerData;

        const warnings = [];

        // ── Daily EMA
        const dailyEMA = calculateEMA(data1D, 20);

        // ── 5m indicators
        const ema5m = calculateEMA(index5m);
        const atrArr = calculateATR(index5m, 14, warnings);
        const adxArr = calculateADX(index5m, 14, warnings);
        const rsiArr = calculateRSI(index5m, 14, warnings);

        // ── VWAP on future 1m
        const vwapArr = calculateVWAP(future1m);

        // ── Volume spike on future 1m
        const volConfirm = volumeSpike(future1m, future1m.length - 1);

        // ── Future 5m OI
        const future5m = buildTimeframe(future1m, 5);

        parentPort.postMessage({
            ok: true,
            dailyEMA,
            ema5m,
            atrArr,
            adxArr,
            rsiArr,
            vwapArr,
            volConfirm,
            future5m,
            warnings,
        });
    } catch (err) {
        parentPort.postMessage({ ok: false, error: err.message });
    }
}

run();
