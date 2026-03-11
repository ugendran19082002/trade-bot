import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { logger } from "./logger.js";

export async function sendTelegram(message) {
    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
            { chat_id: process.env.TG_CHAT_ID, text: message }
        );
        logger.info(`📱 Telegram sent | msg_id: ${res.data.result.message_id}`);
    } catch (err) {
        logger.error(`📱 Telegram error: ${err.response?.data?.description || err.message}`);
    }
}