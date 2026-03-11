import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
let scripMasterCache = null;
import axios from "axios";
import { logger } from "./logger.js";

export async function loadScripMaster(forceRefresh = false) {

    const SYMBOL = process.env.INDEX_SYMBOL || "SENSEX";
    const CACHE_FILE = `./scripMaster_${SYMBOL.toLowerCase()}.json`;

    // 1️⃣ In-memory cache
    if (scripMasterCache && !forceRefresh) {
        return scripMasterCache;
    }

    // 2️⃣ Load from local file — only if cache is less than 20 hours old
    if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
        // BUG 6 FIX: Check file age — stale cache causes wrong weekly expiry tokens
        const ageHours = (Date.now() - fs.statSync(CACHE_FILE).mtimeMs) / 3600000;
        if (ageHours < 20) {
            logger.info(`📂 Loading ${SYMBOL} ScripMaster from local cache (age: ${ageHours.toFixed(1)}h)...`);
            const raw = fs.readFileSync(CACHE_FILE, "utf8");
            scripMasterCache = JSON.parse(raw);
            return scripMasterCache;
        }
        logger.info(`🔄 ScripMaster cache is ${ageHours.toFixed(1)}h old — refreshing...`);
    }

    // 3️⃣ Download full master
    logger.info("🌐 Downloading Full ScripMaster...");
    const res = await axios.get(
        process.env.SCRIP_MASTER_URL || "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    );

    if (!Array.isArray(res.data)) {
        throw new Error("Invalid ScripMaster response");
    }

    // 🔥 Filter ONLY SENSEX (FUTIDX + OPTIDX)
    const filtered = res.data.filter(i =>
        i.name === SYMBOL &&
        (i.instrumenttype === "FUTIDX" || i.instrumenttype === "OPTIDX")
    );

    logger.info(`🎯 Filtered ${filtered.length} SENSEX instruments`);

    scripMasterCache = filtered;
    console.log(filtered[0]);

    fs.writeFileSync(CACHE_FILE, JSON.stringify(filtered));
    logger.info(`✅ ${SYMBOL} ScripMaster cached locally.`);

    return scripMasterCache;
}