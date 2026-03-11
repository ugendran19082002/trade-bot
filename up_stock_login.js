/**
 * ============================================================
 *  UPSTOX AUTO LOGIN BOT  — Single File (v2.3 - TOTP Timing Fix)
 * ============================================================
 *  .env file:
 *    UPSTOX_API_KEY=your_api_key
 *    UPSTOX_SECRET=your_api_secret
 *    UPSTOX_MOBILE=your_mobile_number
 *    UPSTOX_PIN=your_6digit_pin
 *    UPSTOX_TOTP_SECRET=your_totp_secret_key
 *    REDIRECT_URI=http://127.0.0.1:3000/callback
 *    UPSTOX_ACCESS_TOKEN=
 *    UPSTOX_ACCESS_TOKEN_DATE=
 * ============================================================
 *  v2.3 Changes:
 *    - TOTP timing safety: waits if <4s remain in window
 *    - Retry loop: if TOTP is rejected (page returns to PIN),
 *      re-enters PIN + new TOTP automatically (up to 3 attempts)
 *    - Detects "wrong TOTP" state by checking for pinCode field
 *    - Waits longer after TOTP submit before checking redirect
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
const REQUIRED = {
    UPSTOX_API_KEY, UPSTOX_SECRET, UPSTOX_MOBILE,
    UPSTOX_PIN, UPSTOX_TOTP_SECRET
};
for (const [k, v] of Object.entries(REQUIRED)) {
    if (!v) { console.error(`❌ Missing .env variable: ${k}`); process.exit(1); }
}
console.log("✅ All env vars present");

// ─── UTILS ───────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dumpInputs(page) {
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
    console.log("🧪 Inputs on page:\n" + JSON.stringify(inputs, null, 2));
}

// ─── 1. .ENV HELPERS ─────────────────────────────────────────
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
    console.log(`✅ Token saved to .env (DATE=${today})`);
}

function getEnvTokenIfValid() {
    const token = process.env.UPSTOX_ACCESS_TOKEN;
    const date = process.env.UPSTOX_ACCESS_TOKEN_DATE;
    if (token && date && date === todayStr()) {
        console.log(`♻️  Reusing today's token from .env (DATE=${date})`);
        return token;
    }
    return null;
}

// ─── 2. EXCHANGE CODE → TOKEN ────────────────────────────────
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
let _callbackServer = null; // module-level — prevents EADDRINUSE on re-entry

function startCallbackServer() {
    return new Promise((resolve, reject) => {
        // Close any stale server from a previous call
        if (_callbackServer) {
            try { _callbackServer.closeAllConnections?.(); _callbackServer.close(); } catch { /* ignore */ }
            _callbackServer = null;
        }

        const app = express();

        app.get("/callback", async (req, res) => {
            const code = req.query.code;
            if (!code) {
                res.send("❌ No code received");
                return reject(new Error("No authorization code in callback"));
            }
            res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
              <h2 style="color:#22c55e">✅ Login Successful!</h2>
              <p>Token captured. You can close this tab.</p>
            </body></html>`);
            try {
                const tokenData = await exchangeCodeForToken(code);
                if (_callbackServer) { _callbackServer.close(); _callbackServer = null; }
                resolve(tokenData.access_token);
            } catch (err) { reject(err); }
        });

        _callbackServer = app.listen(Number(CALLBACK_PORT), () =>
            console.log(`🌐 Callback server on ${REDIRECT_URI}`)
        );
        _callbackServer.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                console.warn(`⚠️  Port ${CALLBACK_PORT} in use — retrying in 1s…`);
                _callbackServer = null;
                setTimeout(() => startCallbackServer().then(resolve).catch(reject), 1000);
            } else {
                reject(err);
            }
        });
    });
}

// ─── 4. WAIT FOR ANY SELECTOR ────────────────────────────────
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
    throw new Error(
        `None of these selectors appeared within ${timeout}ms:\n  ${selectors.join("\n  ")}`
    );
}

// ─── 5. CLICK THE PRIMARY BUTTON ─────────────────────────────
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
                    console.log(`   🖱️  Clicking button: ${sel}`);
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
    console.log("🧪 All buttons:", JSON.stringify(buttons, null, 2));
    throw new Error(`No clickable button found within ${timeout}ms`);
}

// ─── 6. SAFE TOTP GENERATION (timing-aware) ──────────────────
/**
 * Generates a TOTP code that is safe to submit — i.e. it won't
 * expire in the next few seconds before the server validates it.
 *
 * Strategy:
 *  - If < MIN_SECONDS_REMAINING left in the current 30s window,
 *    wait for the window to roll over, then generate a fresh code.
 *  - This prevents the "code valid when generated but expired on
 *    arrival" failure.
 */
async function generateSafeTOTP(secret, minSecondsRemaining = 5) {
    const timeStep = 30; // seconds
    const nowSec = () => Date.now() / 1000;

    const secondsIntoWindow = () => nowSec() % timeStep;
    const secondsRemaining = () => timeStep - secondsIntoWindow();

    let remaining = secondsRemaining();
    console.log(`   ⏱️  TOTP window: ${remaining.toFixed(1)}s remaining`);

    if (remaining < minSecondsRemaining) {
        const waitMs = Math.ceil((remaining + 0.5) * 1000); // wait until next window + 0.5s buffer
        console.log(`   ⚠️  Too close to window edge — waiting ${waitMs}ms for next window…`);
        await sleep(waitMs);
        remaining = secondsRemaining();
        console.log(`   ⏱️  New window: ${remaining.toFixed(1)}s remaining`);
    }

    // TOTP.generate() is async — must be awaited
    const result = await TOTP.generate(secret);
    console.log(`   🧪 Raw TOTP result: ${JSON.stringify(result)}`);

    // result is { otp: "123456", expires: 1234567890000 }
    const code = result?.otp ?? result;

    if (!code || String(code).length < 6) {
        throw new Error(
            `TOTP generation failed — check UPSTOX_TOTP_SECRET is valid base32 (got: "${code}")\n` +
            `  Raw result: ${JSON.stringify(result)}`
        );
    }

    console.log(`   🔑 TOTP code: ${code} (${remaining.toFixed(1)}s left in window)`);
    return code;
}

// ─── 7. CHECK IF PAGE IS BACK AT PIN SCREEN ──────────────────
// Returns true if Upstox rejected the TOTP and bounced back to PIN entry
async function isOnPinScreen(page) {
    try {
        const el = await page.$('input#pinCode');
        return el && await el.isVisible();
    } catch {
        return false;
    }
}

// ─── 8. ENTER PIN STEP ───────────────────────────────────────
async function enterPin(page) {
    console.log("\n🔑 Entering PIN…");
    const { sel: pinSel } = await waitForAny(page, [
        'input#pinCode',
        'input[type="password"]',
        'input[placeholder*="pin" i]',
    ]);
    console.log(`   Input: ${pinSel}`);
    // Type char-by-char to trigger React onChange validation
    await page.click(pinSel, { clickCount: 3 });
    await page.keyboard.type(UPSTOX_PIN, { delay: 60 });
    // Wait for a Continue/Verify button to become enabled
    await page.waitForFunction(
        () => {
            const btns = [...document.querySelectorAll('button')];
            return btns.some(b => !b.disabled && b.offsetParent !== null &&
                (b.textContent.includes('Continue') || b.textContent.includes('Verify') || b.textContent.includes('Login')));
        },
        { timeout: 8000 }
    ).catch(() => console.log("   ⚠️  Button enable wait timed out, trying anyway"));
    await clickPrimaryButton(page);
    console.log("   ✅ PIN submitted");
    await sleep(2000);
}

// ─── 9. ENTER TOTP STEP ──────────────────────────────────────
async function enterTOTP(page) {
    console.log("\n🔐 Entering TOTP…");
    await sleep(800); // small pause so page settles

    const totpCode = await generateSafeTOTP(UPSTOX_TOTP_SECRET);

    const { sel: totpSel } = await waitForAny(page, [
        'input#otpNum',
        'input[id*="otp" i]',
        'input[maxlength="6"]',
        'input[type="text"]',
    ]);

    // Type char-by-char to trigger React onChange validation
    await page.click(totpSel, { clickCount: 3 });
    await page.keyboard.type(totpCode, { delay: 60 });
    console.log(`   ✅ Filled TOTP via: ${totpSel}`);

    // Wait for Continue button to become enabled
    await page.waitForFunction(
        () => {
            const btns = [...document.querySelectorAll('button')];
            return btns.some(b => !b.disabled && b.offsetParent !== null &&
                (b.textContent.includes('Continue') || b.textContent.includes('Verify') || b.textContent.includes('Login')));
        },
        { timeout: 8000 }
    ).catch(() => console.log("   ⚠️  Button enable wait timed out, trying anyway"));

    await clickPrimaryButton(page);
    console.log("   ✅ TOTP submitted");

    // Wait a moment for the page response
    await sleep(3000);
}

// ─── 10. PLAYWRIGHT AUTO LOGIN ───────────────────────────────
async function autoLoginWithPlaywright() {
    console.log("🚀 Starting headless Chromium login…");

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
            console.log(`  ↪ ${frame.url().slice(0, 120)}`);
    });

    try {
        // ── Load login page ──────────────────────────────────
        await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });
        await sleep(1500);
        await dumpInputs(page);

        // ── Step 1: Mobile ───────────────────────────────────
        // Upstox uses React — the "Get OTP" button stays disabled until
        // the input fires a proper React synthetic event. We type
        // char-by-char so React's onChange fires on every keystroke.
        console.log("\n📱 Step 1: Mobile number");
        const { sel: mobileSel } = await waitForAny(page, [
            'input#mobileNum',
            'input[type="text"]',
            'input[placeholder*="mobile" i]',
            'input[name="mobile"]',
        ]);
        console.log(`   Input: ${mobileSel}`);

        // Clear + type character by character to trigger React validation
        await page.click(mobileSel, { clickCount: 3 });
        await page.keyboard.type(UPSTOX_MOBILE, { delay: 60 });
        console.log(`   Typed mobile, waiting for button to enable…`);

        // Wait specifically for the Get OTP button to become enabled
        await page.waitForFunction(
            () => {
                const btns = [...document.querySelectorAll('button')];
                return btns.some(b => !b.disabled && b.offsetParent !== null);
            },
            { timeout: 8000 }
        ).catch(() => console.log("   ⚠️  Button enable wait timed out, trying anyway"));

        await clickPrimaryButton(page);
        console.log("   ✅ Mobile submitted");

        // Wait for page to transition away from mobileNum
        await page.waitForFunction(
            () => !document.querySelector('input#mobileNum'),
            { timeout: 10000 }
        ).catch(() => { });
        await sleep(1000);

        // ── Step 2: PIN ──────────────────────────────────────
        // Flow: Mobile → PIN (input#otpNum or input#pinCode) → TOTP
        console.log("\n🔑 Step 2: PIN");
        const { sel: pinSel } = await waitForAny(page, [
            'input#otpNum',
            'input#pinCode',
            'input[type="password"]',
            'input[placeholder*="pin" i]',
        ]);
        console.log(`   Input: ${pinSel}`);

        // Type char-by-char for React
        await page.click(pinSel, { clickCount: 3 });
        await page.keyboard.type(UPSTOX_PIN, { delay: 60 });

        // Wait for Continue button to enable
        await page.waitForFunction(
            () => {
                const btns = [...document.querySelectorAll('button')];
                return btns.some(b => !b.disabled && b.offsetParent !== null &&
                    (b.textContent.includes('Continue') || b.textContent.includes('Verify') || b.textContent.includes('Login')));
            },
            { timeout: 8000 }
        ).catch(() => console.log("   ⚠️  Button enable wait timed out, trying anyway"));

        await clickPrimaryButton(page);
        console.log("   ✅ PIN submitted");

        // Wait for PIN field to disappear (page transition)
        await page.waitForFunction(
            () => !document.querySelector('input#pinCode') && !document.querySelector('input#otpNum'),
            { timeout: 10000 }
        ).catch(() => { });
        await sleep(800);
        await dumpInputs(page);

        // ── Step 4: TOTP — with redirect-aware retry ────────
        // Key insight: after TOTP submit, Upstox may redirect DURING
        // the next action (e.g. while re-entering PIN). Always check
        // page.url() before doing anything that requires login inputs.
        const MAX_TOTP_RETRIES = 3;
        const isLoggedIn = () => !page.url().includes("login.upstox.com");

        for (let attempt = 1; attempt <= MAX_TOTP_RETRIES; attempt++) {
            console.log(`\n🔐 TOTP attempt ${attempt}/${MAX_TOTP_RETRIES}`);

            await enterTOTP(page);

            // Check redirect immediately after TOTP submit
            if (isLoggedIn()) {
                console.log(`✅ Redirected after TOTP — login successful!`);
                break;
            }

            await dumpInputs(page);

            // ── Bounced back to PIN? (TOTP was accepted but flow requires PIN again) ─
            if (await isOnPinScreen(page)) {
                if (attempt >= MAX_TOTP_RETRIES) {
                    throw new Error(`TOTP rejected ${MAX_TOTP_RETRIES} times. Check UPSTOX_TOTP_SECRET.`);
                }
                console.log(`   ⚠️  TOTP rejected — page returned to PIN. Retrying (${attempt}/${MAX_TOTP_RETRIES})…`);
                await enterPin(page);

                // Redirect may have happened DURING enterPin — check before looping
                if (isLoggedIn()) {
                    console.log(`✅ Redirected after PIN re-entry — login successful!`);
                    break;
                }

            } else {
                // Still on TOTP screen — wrong code or server delay
                console.log(`   ⚠️  Still on login page after TOTP submit (attempt ${attempt})`);
                if (attempt >= MAX_TOTP_RETRIES) {
                    throw new Error(`TOTP failed after ${MAX_TOTP_RETRIES} attempts. Check UPSTOX_TOTP_SECRET or system clock sync.`);
                }
                console.log("   ⏳ Waiting 30s for a new TOTP window before retry…");
                await sleep(31000);
            }
        }

        // ── Confirm we're on the callback page ───────────────
        // If already redirected, waitForURL returns immediately.
        if (!isLoggedIn()) {
            console.log("\n⏳ Waiting for final redirect…");
            await page.waitForURL(
                url => !url.toString().includes("login.upstox.com"),
                { timeout: 15000, waitUntil: "commit" }
            );
        }

        const finalUrl = page.url();
        console.log(`↩️  Final URL: ${finalUrl}`);
        await sleep(4000);

        // // Fix localhost vs 127.0.0.1 mismatch
        // if (finalUrl.includes("localhost") && finalUrl.includes("/callback")) {
        //     const fixedUrl = finalUrl.replace("localhost", "127.0.0.1");
        //     console.log(`🔧 Fixing localhost → 127.0.0.1: ${fixedUrl}`);
        //     await axios.get(fixedUrl).catch(() => { });
        // }

    } catch (err) {
        await dumpInputs(page).catch(() => { });
        console.error(`\n❌ Error at URL: ${page.url()}`);
        throw err;
    } finally {
        // ✅ KEY FIX: Delay browser close so the callback HTTP request
        // completes fully before the process exits.
        await sleep(4000);
        await browser.close();
    }
}

// ─── 11. MAIN ────────────────────────────────────────────────
export async function getUpstoxToken() {
    const envToken = getEnvTokenIfValid();
    if (envToken) return envToken;

    console.log("🔄 Starting auto-login…\n");
    const [token] = await Promise.all([
        startCallbackServer(),
        autoLoginWithPlaywright(),
    ]);
    return token;
}

// ─── Run standalone: node up_stock_login.js
// (when used as a module, call getUpstoxToken() directly)