/**
 * ============================================================
 *  UPSTOX AUTO LOGIN BOT  — Single File (v2.5 - Dynamic Screen Detection)
 * ============================================================
 *  .env file:
 *    UPSTOX_API_KEY=your_api_key
 *    UPSTOX_SECRET=your_api_secret
 *    UPSTOX_MOBILE=your_mobile_number
 *    UPSTOX_PIN=your_6digit_pin
 *    UPSTOX_TOTP_SECRET=your_totp_secret_key
 *    REDIRECT_URI=https://your-ngrok-url/callback
 *    UPSTOX_ACCESS_TOKEN=
 *    UPSTOX_ACCESS_TOKEN_DATE=
 * ============================================================
 *  v2.5 Changes (over v2.4):
 *    - REWRITE: Replaced rigid step-by-step flow with a
 *      dynamic screen-detection loop that identifies whichever
 *      screen is currently visible and handles it appropriately.
 *
 *    - Handles ALL known Upstox login screens:
 *        MOBILE    -> input#mobileNum  (enter mobile + click Get OTP)
 *        SMS_OTP   -> input#mobileOtp  (SMS OTP sent — currently
 *                    unsupported; throws a clear error asking user
 *                    to disable SMS OTP in Upstox settings)
 *        PIN       -> input#pinCode or input#otpNum (password type)
 *        TOTP      -> input#otpNum (text type, 6-char)
 *        DONE      -> URL left login.upstox.com
 *        UNKNOWN   -> dumps inputs and throws a descriptive error
 *
 *    - FIX: Page was staying on mobileNum after "Get OTP" because
 *      Upstox was showing an SMS OTP screen (input#mobileOtp) that
 *      the old bot never handled, causing a 20s timeout crash.
 *
 *    - FIX: All redirect race conditions from v2.4 retained:
 *        enterTOTP() checks isLoggedIn() before AND after
 *        generateSafeTOTP() (which can sleep ~30s).
 *
 *    - IMPROVEMENT: Each screen handler is an isolated async
 *      function — easy to extend if Upstox adds new steps.
 *
 *    - IMPROVEMENT: Loop has a hard cap (MAX_SCREENS = 20) to
 *      prevent infinite loops if an unknown screen repeats.
 * ============================================================
 */

import "dotenv/config";
import express from "express";
import axios from "axios";
import fs from "fs";
import { chromium } from "playwright";
import { TOTP } from "totp-generator";

// ─── CONFIG ──────────────────────────────────────────────────
const {
    UPSTOX_API_KEY,
    UPSTOX_SECRET,
    UPSTOX_MOBILE,
    UPSTOX_PIN,
    UPSTOX_TOTP_SECRET,
    REDIRECT_URI = "https://51cf-140-245-253-89.ngrok-free.app/callback",
} = process.env;

const ENV_FILE = "./.env";
const CALLBACK_PORT = new URL(REDIRECT_URI).port || 3000;

// ─── VALIDATE ENV AT STARTUP ─────────────────────────────────
const REQUIRED = { UPSTOX_API_KEY, UPSTOX_SECRET, UPSTOX_MOBILE, UPSTOX_PIN, UPSTOX_TOTP_SECRET };
for (const [k, v] of Object.entries(REQUIRED)) {
    if (!v) { console.error(`Missing .env variable: ${k}`); process.exit(1); }
}
console.log("All env vars present");

// ─── UTILS ───────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dumpInputs(page) {
    try {
        const inputs = await page.$$eval("input", els =>
            els.map(e => ({
                type: e.type,
                id: e.id,
                name: e.name,
                placeholder: e.placeholder,
                maxlength: e.maxLength,
                class: e.className.slice(0, 80),
                visible: e.offsetParent !== null,
            }))
        );
        console.log("Inputs on page:\n" + JSON.stringify(inputs, null, 2));
    } catch {
        console.log("dumpInputs: could not read inputs (page may have navigated)");
    }
}

// ─── 1. ENV HELPERS ──────────────────────────────────────────
function updateEnvKey(key, value) {
    let envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
    const regex = new RegExp(`^(${key}=).*$`, "m");
    envText = regex.test(envText)
        ? envText.replace(regex, `$1${value}`)
        : envText + `\n${key}=${value}`;
    fs.writeFileSync(ENV_FILE, envText, "utf8");
}

function saveTokenToEnv(accessToken) {
    const today = todayStr();
    updateEnvKey("UPSTOX_ACCESS_TOKEN", accessToken);
    updateEnvKey("UPSTOX_ACCESS_TOKEN_DATE", today);
    process.env.UPSTOX_ACCESS_TOKEN = accessToken;
    process.env.UPSTOX_ACCESS_TOKEN_DATE = today;
    console.log(`Token saved to .env (DATE=${today})`);
}

function getEnvTokenIfValid() {
    const token = process.env.UPSTOX_ACCESS_TOKEN;
    const date = process.env.UPSTOX_ACCESS_TOKEN_DATE;
    if (token && date && date === todayStr()) {
        console.log(`Reusing today's token from .env (DATE=${date})`);
        return token;
    }
    return null;
}

// ─── 2. EXCHANGE CODE FOR TOKEN ──────────────────────────────
async function exchangeCodeForToken(code) {
    const res = await axios.post(
        "https://api.upstox.com/v2/login/authorization/token",
        new URLSearchParams({
            code,
            client_id: UPSTOX_API_KEY,
            client_secret: UPSTOX_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    saveTokenToEnv(res.data.access_token);
    return res.data;
}

// ─── 3. CALLBACK SERVER ──────────────────────────────────────
let _callbackServer = null;

function startCallbackServer() {
    return new Promise((resolve, reject) => {
        if (_callbackServer) {
            try { _callbackServer.closeAllConnections?.(); _callbackServer.close(); } catch { /* ignore */ }
            _callbackServer = null;
        }

        const app = express();

        app.get("/callback", async (req, res) => {
            const code = req.query.code;
            if (!code) {
                res.send("No code received");
                return reject(new Error("No authorization code in callback"));
            }
            res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
              <h2 style="color:#22c55e">Login Successful!</h2>
              <p>Token captured. You can close this tab.</p>
            </body></html>`);
            try {
                const tokenData = await exchangeCodeForToken(code);
                if (_callbackServer) { _callbackServer.close(); _callbackServer = null; }
                resolve(tokenData.access_token);
            } catch (err) { reject(err); }
        });

        _callbackServer = app.listen(Number(CALLBACK_PORT), () =>
            console.log(`Callback server listening on ${REDIRECT_URI}`)
        );
        _callbackServer.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                console.warn(`Port ${CALLBACK_PORT} in use — retrying in 1s`);
                _callbackServer = null;
                setTimeout(() => startCallbackServer().then(resolve).catch(reject), 1000);
            } else {
                reject(err);
            }
        });
    });
}

// ─── 4. PAGE HELPERS ─────────────────────────────────────────

/** True when the browser has left the Upstox login domain. */
function isLoggedIn(page) {
    return !page.url().includes("login.upstox.com");
}

/** Waits for the first visible input matching any of the selectors. */
async function waitForAny(page, selectors, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        for (const sel of selectors) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) return { el, sel };
            } catch { /* ignore */ }
        }
        await sleep(300);
    }
    await dumpInputs(page).catch(() => { });
    throw new Error(`None of these selectors appeared within ${timeout}ms:\n  ${selectors.join("\n  ")}`);
}

/** Clicks the first visible+enabled button matching common submit labels. */
async function clickPrimaryButton(page, timeout = 10000) {
    const candidates = [
        'button[type="submit"]',
        'button:has-text("Continue")',
        'button:has-text("Get OTP")',
        'button:has-text("Verify")',
        'button:has-text("Login")',
        'button:has-text("Proceed")',
        'button:has-text("Next")',
        'button:visible',
    ];

    const start = Date.now();
    while (Date.now() - start < timeout) {
        for (const sel of candidates) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible() && await el.isEnabled()) {
                    console.log(`   Clicking: ${sel}`);
                    await el.click();
                    return sel;
                }
            } catch { /* ignore */ }
        }
        await sleep(300);
    }
    const buttons = await page.$$eval("button", bs =>
        bs.map(b => ({ text: b.textContent?.trim(), type: b.type, visible: b.offsetParent !== null }))
    );
    console.log("All buttons: " + JSON.stringify(buttons, null, 2));
    throw new Error(`No clickable button found within ${timeout}ms`);
}

/** Waits for a submit button to become enabled then clicks it. */
async function waitForButtonAndClick(page, labelKeywords = ["Continue", "Verify", "Login"]) {
    await page.waitForFunction(
        (keywords) => {
            const btns = [...document.querySelectorAll("button")];
            return btns.some(b =>
                !b.disabled &&
                b.offsetParent !== null &&
                keywords.some(k => b.textContent.includes(k))
            );
        },
        labelKeywords,
        { timeout: 8000 }
    ).catch(() => console.log("   Button enable wait timed out, proceeding anyway"));
    await clickPrimaryButton(page);
}

// ─── 5. SAFE TOTP GENERATION ─────────────────────────────────
/**
 * Generates a TOTP code guaranteed to have at least minSecondsRemaining
 * left before expiry. If the current window is too close to rolling over,
 * waits for the next window to start.
 */
async function generateSafeTOTP(secret, minSecondsRemaining = 5) {
    const timeStep = 30;
    const secondsRemaining = () => timeStep - (Date.now() / 1000 % timeStep);

    let remaining = secondsRemaining();
    console.log(`   TOTP window: ${remaining.toFixed(1)}s remaining`);

    if (remaining < minSecondsRemaining) {
        const waitMs = Math.ceil((remaining + 0.5) * 1000);
        console.log(`   Too close to window edge — waiting ${waitMs}ms for next window`);
        await sleep(waitMs);
        remaining = secondsRemaining();
        console.log(`   New window: ${remaining.toFixed(1)}s remaining`);
    }

    const result = await TOTP.generate(secret);
    console.log(`   Raw TOTP result: ${JSON.stringify(result)}`);

    const code = result?.otp ?? result;
    if (!code || String(code).length < 6) {
        throw new Error(
            `TOTP generation failed — check UPSTOX_TOTP_SECRET is valid base32 (got: "${code}")\n` +
            `  Raw result: ${JSON.stringify(result)}`
        );
    }
    console.log(`   TOTP code: ${code} (${remaining.toFixed(1)}s left in window)`);
    return code;
}

// ─── 6. SCREEN DETECTION ─────────────────────────────────────
/**
 * Identifies which Upstox login screen is currently visible.
 *
 * Returns one of:
 *   'DONE'    — browser has left login.upstox.com (redirect happened)
 *   'MOBILE'  — mobile number entry field visible
 *   'SMS_OTP' — SMS OTP field visible (input#mobileOtp)
 *   'PIN'     — password/PIN field visible
 *   'TOTP'    — TOTP text input visible
 *   'UNKNOWN' — none of the above matched
 */
async function detectScreen(page) {
    if (isLoggedIn(page)) return "DONE";

    try {
        const inputs = await page.$$eval("input", els =>
            els
                .filter(e => e.offsetParent !== null) // visible only
                .map(e => ({ type: e.type, id: e.id, maxlength: e.maxLength }))
        );

        console.log(`   Visible inputs: ${JSON.stringify(inputs)}`);

        for (const inp of inputs) {
            if (inp.id === "mobileNum") return "MOBILE";

            // SMS OTP: Upstox sends a code to mobile after "Get OTP" on
            // unrecognised devices. The field id is typically "mobileOtp".
            if (inp.id === "mobileOtp") return "SMS_OTP";
            if (inp.id?.toLowerCase().includes("mobileotp")) return "SMS_OTP";

            // PIN: password-type input
            if (inp.id === "pinCode" && inp.type === "password") return "PIN";
            if (inp.type === "password") return "PIN";

            // TOTP: text input named otpNum (shown after PIN accepted)
            if (inp.id === "otpNum" && inp.type === "text") return "TOTP";

            // Fallback: any 6-char text input that isn't the mobile field
            if (inp.type === "text" && inp.maxlength === 6 && inp.id !== "mobileNum") return "TOTP";
        }
    } catch {
        // Page might be mid-navigation — return UNKNOWN, caller will retry
    }

    return "UNKNOWN";
}

// ─── 7. SCREEN HANDLERS ──────────────────────────────────────

async function handleMobileScreen(page) {
    console.log("\n>>> MOBILE: entering mobile number");
    const { sel } = await waitForAny(page, [
        "input#mobileNum",
        'input[type="text"]',
        'input[placeholder*="mobile" i]',
    ]);
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.type(UPSTOX_MOBILE, { delay: 60 });

    // Wait for any button to become enabled (React validation)
    await page.waitForFunction(
        () => [...document.querySelectorAll("button")].some(b => !b.disabled && b.offsetParent !== null),
        { timeout: 8000 }
    ).catch(() => console.log("   Button enable wait timed out"));

    await clickPrimaryButton(page);
    console.log("   Mobile submitted — waiting for screen transition");

    // Wait for the mobile input to disappear
    await page.waitForFunction(
        () => { const el = document.querySelector("input#mobileNum"); return !el || el.offsetParent === null; },
        { timeout: 15000 }
    ).catch(() => console.log("   mobileNum still visible after 15s"));

    await sleep(1000);
}

async function handleSmsOtpScreen(page) {
    // SMS OTP cannot be automated — it requires intercepting a real SMS.
    // Solution: log in manually once from this IP, or disable SMS OTP in
    // Upstox > My Account > Security > Login Settings.
    console.error("\n>>> SMS_OTP screen detected — CANNOT AUTOMATE");
    console.error("    Upstox sent an OTP to your mobile number via SMS.");
    console.error("    To fix this:");
    console.error("    1. Log in manually ONCE from this server's IP address.");
    console.error("    2. Or go to Upstox > My Account > Security and disable 'Login OTP'.");
    await dumpInputs(page);
    throw new Error(
        "SMS OTP screen — automation not possible. " +
        "Disable SMS OTP in Upstox security settings, then retry."
    );
}

async function handlePinScreen(page) {
    console.log("\n>>> PIN: entering 6-digit PIN");

    if (isLoggedIn(page)) {
        console.log("   Already redirected — skipping PIN");
        return;
    }

    const { sel } = await waitForAny(page, [
        "input#pinCode",
        'input[type="password"]',
        'input[placeholder*="pin" i]',
    ]);
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.type(UPSTOX_PIN, { delay: 60 });

    await waitForButtonAndClick(page, ["Continue", "Verify", "Login"]);
    console.log("   PIN submitted — waiting for screen transition");

    await page.waitForFunction(
        () => { const el = document.querySelector("input#pinCode"); return !el || el.offsetParent === null; },
        { timeout: 15000 }
    ).catch(() => console.log("   pinCode still visible after 15s"));

    await sleep(800);
}

async function handleTotpScreen(page) {
    console.log("\n>>> TOTP: entering authenticator code");

    // Guard before generating (generateSafeTOTP can sleep ~30s)
    if (isLoggedIn(page)) {
        console.log("   Already redirected — skipping TOTP");
        return;
    }

    const totpCode = await generateSafeTOTP(UPSTOX_TOTP_SECRET);

    // Guard after generating — redirect may have fired during the sleep
    if (isLoggedIn(page)) {
        console.log("   Redirected during TOTP generation — skipping entry");
        return;
    }

    const { sel } = await waitForAny(page, [
        "input#otpNum",
        'input[id*="otp" i]',
        'input[maxlength="6"]',
        'input[type="text"]',
    ]);

    await page.click(sel, { clickCount: 3 });
    await page.keyboard.type(totpCode, { delay: 60 });
    console.log(`   Filled TOTP via: ${sel}`);

    await waitForButtonAndClick(page, ["Continue", "Verify", "Login"]);
    console.log("   TOTP submitted — waiting for redirect");

    await sleep(3000);
}

// ─── 8. PLAYWRIGHT AUTO LOGIN ────────────────────────────────
async function autoLoginWithPlaywright() {
    console.log("Starting headless Chromium login");

    const loginUrl =
        `https://api.upstox.com/v2/login/authorization/dialog` +
        `?response_type=code` +
        `&client_id=${UPSTOX_API_KEY}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.on("framenavigated", frame => {
        if (frame === page.mainFrame())
            console.log(`  -> ${frame.url().slice(0, 120)}`);
    });

    try {
        await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });
        await sleep(1500);
        await dumpInputs(page);

        // ── Dynamic screen loop ──────────────────────────────
        // Detect which screen is currently shown and handle it.
        // Robust to Upstox inserting new steps or reordering screens.
        const MAX_SCREENS = 20;
        let screensHandled = 0;
        let consecutiveUnknown = 0;

        while (screensHandled < MAX_SCREENS) {
            const screen = await detectScreen(page);
            console.log(`\nScreen [${screensHandled + 1}]: ${screen}  (url: ${page.url().slice(0, 80)})`);

            if (screen === "DONE") {
                console.log("Login complete — left login page");
                break;
            }

            switch (screen) {
                case "MOBILE":
                    consecutiveUnknown = 0;
                    await handleMobileScreen(page);
                    break;

                case "SMS_OTP":
                    await handleSmsOtpScreen(page); // always throws
                    break;

                case "PIN":
                    consecutiveUnknown = 0;
                    await handlePinScreen(page);
                    break;

                case "TOTP":
                    consecutiveUnknown = 0;
                    await handleTotpScreen(page);
                    break;

                default: // UNKNOWN
                    consecutiveUnknown++;
                    console.log(`Unknown screen (${consecutiveUnknown} consecutive)`);
                    await dumpInputs(page);

                    if (consecutiveUnknown >= 4) {
                        throw new Error(
                            `Stuck on unknown screen for ${consecutiveUnknown} iterations. ` +
                            `URL: ${page.url()}`
                        );
                    }
                    await sleep(2000); // page may still be loading
                    break;
            }

            screensHandled++;
        }

        if (screensHandled >= MAX_SCREENS) {
            throw new Error(`Login loop hit MAX_SCREENS (${MAX_SCREENS}) — aborting`);
        }

        // ── Wait for final redirect if not already there ─────
        if (!isLoggedIn(page)) {
            console.log("Waiting for final redirect");
            await page.waitForURL(
                url => !url.toString().includes("login.upstox.com"),
                { timeout: 15000, waitUntil: "commit" }
            );
        }

        const finalUrl = page.url();
        console.log(`Final URL: ${finalUrl}`);

        // ── KEY FIX: Extract code directly from the browser URL ──
        // The headless browser navigates TO the callback URL but never
        // sends an HTTP GET request to our Express server — it just
        // renders whatever is at that URL (ngrok page / error page).
        // Solution: read the ?code= param straight from page.url().
        const urlObj = new URL(finalUrl);
        const code = urlObj.searchParams.get("code");

        if (!code) {
            throw new Error(
                `No authorization code in final URL: ${finalUrl}\n` +
                `Expected: ${REDIRECT_URI}?code=...`
            );
        }

        console.log(`Code extracted from URL: ${code.slice(0, 8)}...`);
        const tokenData = await exchangeCodeForToken(code);
        console.log("Token exchange successful");
        return tokenData.access_token;

    } catch (err) {
        await dumpInputs(page).catch(() => { });
        console.error(`Error at URL: ${page.url()}`);
        throw err;
    } finally {
        await browser.close();
    }
}

// ─── 9. PUBLIC API ───────────────────────────────────────────
export async function getUpstoxToken() {
    const envToken = getEnvTokenIfValid();
    if (envToken) return envToken;

    console.log("Starting auto-login");

    // Keep callback server running as optional fallback
    // (e.g. for manual browser logins), but the primary token
    // exchange now happens inside autoLoginWithPlaywright().
    startCallbackServer().catch(err =>
        console.warn("Callback server (non-fatal):", err.message)
    );

    return await autoLoginWithPlaywright();
}

// Run standalone: node up_stock_login.js
// As a module: import { getUpstoxToken } from "./up_stock_login.js"