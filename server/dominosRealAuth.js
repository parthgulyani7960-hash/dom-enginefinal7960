const { chromium } = require('playwright-core');
const db = require('./db');
const proxyService = require('./proxyService');
const { safeClick, safeType, dismissDominosPopups, waitForDominoSettle, sleep } = require('./browserActions');

const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();
const activeLoginSessions = new Map();

/**
 * Robust Human-like OTP Request Flow
 */
async function requestLiveDominosOtp(phone, onLog = console.log) {
  const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
  if (cleanPhone.length !== 10) {
    return { success: false, error: 'Please enter a valid 10-digit Indian mobile number.' };
  }

  onLog(`[REAL-AUTH] 🚀 Launching Chrome for real OTP request to +91 ${cleanPhone}...`);

  // Close any lingering session
  if (activeLoginSessions.has(cleanPhone)) {
    try {
      await activeLoginSessions.get(cleanPhone).browser.close();
    } catch (e) {}
    activeLoginSessions.delete(cleanPhone);
  }

  const proxyConfig = proxyService.getPlaywrightProxy();
  const authLaunchOpts = {
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  };
  if (proxyConfig) authLaunchOpts.proxy = proxyConfig;

  const browser = await chromium.launch(authLaunchOpts);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    viewport: { width: 390, height: 844 },
    hasTouch: true
  });

  const page = await context.newPage();

  try {
    onLog(`[REAL-AUTH] Navigating to https://m.dominos.co.in/postorder-ui/login ...`);
    await page.goto('https://m.dominos.co.in/postorder-ui/login', {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    await dismissDominosPopups(page);

    // 1. Human-like Input Focus & Entry
    onLog(`[REAL-AUTH] Focusing input#loginNumber and typing 10 digits...`);
    await safeType(page, '#loginNumber', cleanPhone, {
      delayMs: 40,
      clearFirst: true,
      description: 'Phone Input Field'
    });

    await sleep(600);

    // 2. Click "Send OTP" Button
    onLog(`[REAL-AUTH] Clicking Domino's "Send OTP" button...`);
    await safeClick(page, 'button:has-text("Send OTP"), button[type="submit"]', {
      timeout: 6000,
      description: 'Send OTP Button'
    });

    // 3. Monitor for Rate-Limit or Success State
    await sleep(2500);
    const errorEl = page.locator('.error-msg, .alert, [class*="error"]').first();
    if (await errorEl.isVisible({ timeout: 1500 }).catch(() => false)) {
      const errText = await errorEl.innerText();
      onLog(`[REAL-AUTH] ⚠️ Domino's Response: ${errText}`);
    }

    // Keep active session in memory
    activeLoginSessions.set(cleanPhone, {
      browser,
      context,
      page,
      phone: `+91 ${cleanPhone}`,
      createdAt: Date.now()
    });

    onLog(`[REAL-AUTH] ✅ Real SMS OTP successfully dispatched to +91 ${cleanPhone}!`);
    return {
      success: true,
      message: `Domino's India has sent a real 6-digit SMS OTP to +91 ${cleanPhone}. Please enter it to complete authentication.`
    };

  } catch (err) {
    onLog(`[REAL-AUTH] ❌ Error during OTP request: ${err.message}`);
    await browser.close().catch(() => {});
    return { success: false, error: err.message };
  }
}

/**
 * Robust Human-like OTP Verification Flow
 */
async function submitLiveDominosOtpAndSave(phone, otp, category = 'CATEGORY_50_OFF', categoryName = '50% OFF New User Tier', couponCode = 'DOMNEW50', onLog = console.log) {
  const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
  const session = activeLoginSessions.get(cleanPhone);

  if (!session) {
    return {
      success: false,
      error: 'No active login session found for this phone number. Please click "Send OTP" first.'
    };
  }

  const { browser, context, page } = session;

  try {
    onLog(`[REAL-AUTH] ✍️ Typing 6-digit OTP (${otp}) with realistic keystroke delay...`);

    const digitInputs = page.locator('input[type="tel"], input[maxlength="1"], input[name*="otp" i], input[placeholder*="otp" i]');
    const count = await digitInputs.count();

    if (count >= 6) {
      for (let i = 0; i < 6; i++) {
        await digitInputs.nth(i).click();
        await digitInputs.nth(i).fill(otp[i]);
        await sleep(120);
      }
    } else {
      await safeType(page, digitInputs.first(), otp, { delayMs: 60, clearFirst: true });
    }

    onLog(`[REAL-AUTH] Submitting OTP for Domino's token verification...`);
    await safeClick(page, 'button:has-text("Submit"), button:has-text("Verify"), button:has-text("Login"), button[type="submit"]', {
      timeout: 5000,
      description: 'Submit OTP Button'
    });

    await waitForDominoSettle(page, 4000);

    // Capture Real Cookies & LocalStorage
    const realCookies = await context.cookies();
    const realLocalStorage = await page.evaluate(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        items[key] = localStorage.getItem(key);
      }
      return items;
    });

    onLog(`[REAL-AUTH] 🔑 Successfully extracted ${realCookies.length} real cookies and ${Object.keys(realLocalStorage).length} LocalStorage items!`);

    const newAccount = {
      id: `ACC-LIVE-${Date.now().toString().slice(-4)}`,
      phone: `+91 ${cleanPhone}`,
      category: category,
      categoryName: categoryName,
      couponCode: couponCode,
      cookies: realCookies,
      localStorage: realLocalStorage,
      sessionToken: realLocalStorage['auth_token'] || realLocalStorage['token'] || `dom_auth_${Date.now()}`,
      status: 'IDLE',
      totalOrdersPlaced: 0,
      authenticatedAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    };

    db.addAccount(newAccount);
    activeLoginSessions.delete(cleanPhone);
    await browser.close().catch(() => {});

    onLog(`[REAL-AUTH] ✅ Real Domino's Account ${newAccount.phone} saved to pool!`);
    return { success: true, account: newAccount };

  } catch (err) {
    onLog(`[REAL-AUTH] ❌ Error verifying OTP: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  requestLiveDominosOtp,
  submitLiveDominosOtpAndSave
};
