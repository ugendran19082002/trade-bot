import dotenv from "dotenv";
dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
//  ORDER QUEUE  (BullMQ) — lazy-init, zero startup noise
//  Queue is only created on first addOrderJob() call, after dotenv is loaded.
//  Enable with USE_QUEUE=true in .env  (requires Redis running)
// ═════════════════════════════════════════════════════════════════════════════
import { logger } from "./logger.js";
import { executeOrder } from "./order.js";
import { openPosition } from "./positionManager.js";


let orderQueue = null;
let orderWorker = null;
let queueReady = false;
let initDone = false;

async function ensureQueue() {
    if (initDone) return;
    initDone = true;

    const USE_QUEUE = process.env.USE_QUEUE === "true";
    if (!USE_QUEUE) {
        logger.info("ℹ Order queue disabled (USE_QUEUE=false)");
        return;
    }

    try {
        const { Queue, Worker } = await import("bullmq");
        const { default: Redis } = await import("ioredis");

        const connectionOpts = {
            host: process.env.REDIS_HOST ?? "127.0.0.1",
            port: parseInt(process.env.REDIS_PORT ?? "6379"),
            maxRetriesPerRequest: null,
            retryStrategy: () => null // Prevent infinite reconnection loops
        };

        const client = new Redis(connectionOpts);
        const subscriber = new Redis(connectionOpts);
        const bclient = new Redis(connectionOpts);

        // Silence background socket connection errors gracefully if Redis is offline
        client.on("error", () => { });
        subscriber.on("error", () => { });
        bclient.on("error", () => { });

        orderQueue = new Queue("orders", {
            connection: client,
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: "exponential", delay: 2000 },
                removeOnComplete: { count: 100 },
                removeOnFail: { count: 50 },
            },
        });

        orderQueue.on("error", (err) => {
            logger.warn(`⚠ OrderQueue error: ${err.message}`);
            queueReady = false;
        });

        orderWorker = new Worker(
            "orders",
            async (job) => {
                const { signalObj } = job.data;
                logger.info(`📦 OrderQueue: processing job ${job.id} → ${signalObj.signal}`);
                await executeOrder(signalObj);
            },
            { connection: bclient, concurrency: 1 }
        );

        orderWorker.on("failed", (job, err) => logger.error(`❌ OrderQueue job ${job?.id} failed: ${err.message}`));
        orderWorker.on("completed", (job) =>{
            const signalObj = job.data?.signalObj;
            if (!signalObj) {
                logger.error("❌ OrderQueue completed but signalObj missing");
                return;
            }
            openPosition(signalObj);
            logger.info(`✅ OrderQueue job ${job.id} done`);

            logger.info(`✅ OrderQueue job ${job.id} done`)});
        orderWorker.on("error", (err) => {
            logger.warn(`⚠ OrderWorker error: ${err.message}`);
            queueReady = false;
        });

        queueReady = true;
        logger.info("✅ OrderQueue (BullMQ) ready");

    } catch (err) {
        logger.warn(`⚠ OrderQueue unavailable: ${err.message}`);
    }
}

// ─────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────

/**
 * Enqueues an order job via BullMQ, or falls back to direct execution.
 * Returns true if order was successfully placed/enqueued, false otherwise.
 * IMPORTANT: openPosition() should only be called in entryEngine AFTER this returns true.
 */
export async function addOrderJob(signalObj) {
    await ensureQueue();

    if (queueReady && orderQueue) {
        const jobId = `${signalObj.signal}-${Date.now()}`;
        try {
            await orderQueue.add("placeOrder", { signalObj }, { jobId });
            logger.info(`📥 OrderQueue: enqueued job ${jobId}`);
            return true; // Queued = optimistically success
        } catch (err) {
            logger.warn(`⚠ OrderQueue add failed: ${err.message} — falling back to direct execution`);
            queueReady = false;
            const result = await executeOrder(signalObj);
            return !!(result?.orderNo);
        }
    } else {
        // Fallback: direct execution
        const result = await executeOrder(signalObj);
        return !!(result?.orderNo);
    }
}

export async function closeQueue() {
    if (orderWorker) await orderWorker.close();
    if (orderQueue) await orderQueue.close();
}
