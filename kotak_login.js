import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import { authenticator } from "otplib";
import { NeoSDK } from "kotak-neo-nodejs-sdk";


dotenv.config();

// ENV VARIABLES
const ACCESS_TOKEN = process.env.KOTAK_ACCESS_TOKEN;
const MOBILE = process.env.KOTAK_MOBILE;
const UCC = process.env.KOTAK_UCC;
const MPIN = process.env.KOTAK_MPIN;
const TOTP_SECRET = process.env.KOTAK_TOTP_SECRET;


// ------------------------------------------------
// Update .env value
// ------------------------------------------------
function updateEnv(key, value) {

    const envFile = ".env";

    let env = fs.readFileSync(envFile, "utf8");

    const regex = new RegExp(`^${key}=.*`, "m");

    if (env.match(regex)) {
        env = env.replace(regex, `${key}=${value}`);
    } else {
        env += `\n${key}=${value}`;
    }

    fs.writeFileSync(envFile, env);
}


// ------------------------------------------------
// Login Function
// ------------------------------------------------
export async function kotakLogin() {

    try {

        console.log("🔐 Generating TOTP...");

        const totp = authenticator.generate(TOTP_SECRET);

        console.log("TOTP:", totp);


        // -------------------------------
        // STEP 1 — TOTP LOGIN
        // -------------------------------
        const loginRes = await axios.post(
            "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin",
            {
                mobileNumber: MOBILE,
                ucc: UCC,
                totp: totp
            },
            {
                headers: {
                    Authorization: ACCESS_TOKEN,
                    "neo-fin-key": "neotradeapi",
                    "Content-Type": "application/json"
                }
            }
        );

        const viewToken = loginRes.data.data.token;
        const viewSid = loginRes.data.data.sid;

        console.log("✅ TOTP Login Success");


        // -------------------------------
        // STEP 2 — MPIN VALIDATE
        // -------------------------------
        const validateRes = await axios.post(
            "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate",
            {
                mpin: MPIN
            },
            {
                headers: {
                    Authorization: ACCESS_TOKEN,
                    "neo-fin-key": "neotradeapi",
                    sid: viewSid,
                    Auth: viewToken,
                    "Content-Type": "application/json"
                }
            }
        );


        const sessionToken = validateRes.data.data.token;
        const sessionSid = validateRes.data.data.sid;
        const baseUrl = validateRes.data.data.baseUrl;
        const rid = validateRes.data.data.rid;
        const serverId = validateRes.data.data.dataCenter;

        console.log("🎉 LOGIN SUCCESS");

        console.log("Session Token:", sessionToken);
        console.log("Session SID:", sessionSid);
        console.log("Base URL:", baseUrl);


        // -------------------------------
        // SAVE VALUES TO .ENV
        // -------------------------------
        updateEnv("KOTAK_TOKEN", sessionToken);
        updateEnv("KOTAK_SID", sessionSid);
        updateEnv("KOTAK_RID", rid);
        updateEnv("KOTAK_SERVERID", serverId);
        updateEnv("KOTAK_BASEURL", baseUrl);

        console.log("💾 .env updated successfully");


    } catch (error) {

        console.error("❌ LOGIN FAILED");

        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }

    }

}


// ------------------------------------------------
// RUN LOGIN