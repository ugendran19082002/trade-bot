import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import speakeasy from "speakeasy";
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";
import { buildHeaders } from "../helpers.js";

const BASE_URL = process.env.ANGELONE_BASE_URL || "https://apiconnect.angelone.in";
const TOKEN_FILE = path.resolve("./jwt_cache.json");

// AngelOne JWT is valid for ~24h — we refresh 30 min before expiry
const TOKEN_TTL_MS = 23.5 * 60 * 60 * 1000; // 23.5 hours

function loadCachedToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        const { jwt, feedToken, savedAt } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
        const age = Date.now() - savedAt;
        if (age < TOKEN_TTL_MS && feedToken) {
            logger.info(`✅ Reusing cached JWT (age: ${(age / 3600000).toFixed(2)}h)`);
            return { jwt, feedToken };
        }
        logger.info("🔄 Cached JWT expired or missing feedToken — refreshing...");
        return null;
    } catch {
        return null;
    }
}

/** Returns the cached feed token (empty string if not yet cached). */
export function getFeedToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return "";
        const { feedToken } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
        return feedToken ?? "";
    } catch {
        return "";
    }
}

export function clearTokenCache() {
    if (fs.existsSync(TOKEN_FILE)) {
        fs.unlinkSync(TOKEN_FILE);
        logger.info("🗑 Cached JWT cleared");
    }
}

function saveToken(jwt, feedToken = "") {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ jwt, feedToken, savedAt: Date.now() }), "utf-8");
}

