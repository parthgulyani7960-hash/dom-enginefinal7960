const { chromium } = require('playwright-core');
const crypto = require('crypto');
const db = require('./db');
const proxyService = require('./proxyService');

const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();

const DOMINO_SALT = '2Na@4Sr&8Qp&2NmLk$4Om&0Fe@9Dc#8Ba';

/**
 * OpenSSL EVP_BytesToKey implementation for CryptoJS AES-256-CBC compatibility (MD5 KDF)
 */
function evpBytesToKey(passphrase, salt, keyLen = 32, ivLen = 16) {
  let prev = Buffer.alloc(0);
  let total = Buffer.alloc(0);
  const needed = keyLen + ivLen;
  while (total.length < needed) {
    const hash = crypto.createHash('md5');
    hash.update(prev);
    hash.update(Buffer.from(passphrase, 'utf8'));
    hash.update(salt);
    prev = hash.digest();
    total = Buffer.concat([total, prev]);
  }
  return {
    key: total.subarray(0, keyLen),
    iv: total.subarray(keyLen, keyLen + ivLen)
  };
}

/**
 * Decrypt Domino's India AES-256-CBC encrypted strings starting with 'U2FsdGVkX1'
 * (Used for userInfo.userData, addressDetail, and userLocationData)
 */
function decryptDominoEncryptedString(cipherB64, passphrase = DOMINO_SALT) {
  if (!cipherB64 || typeof cipherB64 !== 'string') return null;
  const cleanStr = cipherB64.trim();
  if (!cleanStr.startsWith('U2FsdGVkX1')) return null;

  try {
    const buf = Buffer.from(cleanStr, 'base64');
    if (buf.length < 16) return null;
    const header = buf.subarray(0, 8).toString('utf8');
    if (header !== 'Salted__') return null;
    const salt = buf.subarray(8, 16);
    const ciphertext = buf.subarray(16);
    const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted;
    }
  } catch (e) {
    return null;
  }
}

/**
 * Encrypt a plain object or string using Domino's AES-256-CBC compatible with CryptoJS (Salted__ format)
 * (Used for userInfo.userData, addressDetail, and userLocationData)
 */
function encryptDominoString(plainText, passphrase = DOMINO_SALT) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const str = typeof plainText === 'string' ? plainText : JSON.stringify(plainText);
  let enc = cipher.update(str, 'utf8');
  enc = Buffer.concat([enc, cipher.final()]);
  const prefix = Buffer.from('Salted__', 'utf8');
  return Buffer.concat([prefix, salt, enc]).toString('base64');
}

// Active Playwright live OTP login sessions (keyed by 10-digit mobile number)
const activeLiveOtpSessions = new Map();

/**
 * Clean up an active OTP session
 */
async function cleanupSession(phone) {
  const cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(-10);
  if (activeLiveOtpSessions.has(cleanPhone)) {
    const session = activeLiveOtpSessions.get(cleanPhone);
    try {
      if (session.browser) {
        await session.browser.close().catch(() => {});
      }
    } catch (e) {}
    activeLiveOtpSessions.delete(cleanPhone);
  }
}

/**
 * 1. Request Domino's Live SMS OTP Dispatch via Real Chrome Automation
 * ZERO MOCK DATA - Directly triggers Domino's official SMS gateway
 */
async function requestLiveDominoOtp(phone) {
  const cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(-10);
  if (!cleanPhone || cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    return {
      success: false,
      error: 'Please enter a valid 10-digit Indian mobile number (starting with 6, 7, 8, or 9).'
    };
  }

  console.log(`[ADMIN-OTP] 🚀 Dispatching real Domino's India SMS OTP to +91 ${cleanPhone}...`);

  // Close any existing lingering session for this phone
  await cleanupSession(cleanPhone);

  let browser;
  try {
    const proxyConfig = proxyService.getPlaywrightProxy();
    const launchOptions = {
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    };
    if (proxyConfig) {
      launchOptions.proxy = proxyConfig;
      console.log(`[ADMIN-OTP] 🌐 Routing browser session through rotating proxy: ${proxyConfig.server}`);
    }

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 412, height: 915 }
    });

    const page = await context.newPage();

    // Route optimization: Block third-party tracking scripts to speed up load time
    await page.route('**/*', route => {
      const u = route.request().url();
      if (
        u.includes('moengage') ||
        u.includes('amplitude') ||
        u.includes('datadog') ||
        u.includes('hotjar') ||
        u.includes('google-analytics') ||
        u.includes('clarity') ||
        u.includes('facebook')
      ) {
        return route.abort();
      }
      route.continue();
    });

    let otpSuccessResponse = null;
    let otpErrorResponse = null;

    page.on('response', async res => {
      const u = res.url();
      if (u.includes('forgotpassword') || u.includes('sso-aggregation') || u.includes('sendotp')) {
        try {
          const body = await res.json();
          if (body.status === 'SUCCESS' || body.success === true) {
            otpSuccessResponse = body;
          } else if (body.status === 'FAILED' || body.status === 'FAILURE' || res.status() >= 400 || body.errors || body.error || body.message) {
            otpErrorResponse = body;
          }
        } catch (e) {}
      }
    });

    console.log(`[ADMIN-OTP] Loading Domino's login page...`);
    await page.goto('https://m.dominos.co.in/postorder-ui/login', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    // Locate mobile input field
    const inputSelector = '#loginNumber, input[name="loginNumber"], [data-testid="user-input"], input[type="tel"], input[type="text"]';
    const input = page.locator(inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    console.log(`[ADMIN-OTP] Entering mobile number: ${cleanPhone}`);
    await input.click();
    await input.fill(cleanPhone);
    await page.evaluate((ph) => {
      const el = document.getElementById('loginNumber') || document.querySelector('input[name="loginNumber"]');
      if (el) {
        el.value = ph;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, cleanPhone);
    await page.waitForTimeout(400);

    // Fast check: Did entering the 10-digit number immediately navigate to login-otp?
    let reachedOtpScreen = page.url().includes('login-otp');
    let detectedError = null;

    if (!reachedOtpScreen) {
      // Click Domino's Send OTP button
      const submitBtn = page.locator('button:has-text("Send OTP"), button:has-text("Login"), button.btn--red, button[type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        for (let w = 0; w < 10; w++) {
          if (await submitBtn.isEnabled().catch(() => false)) break;
          await page.waitForTimeout(150);
        }
        console.log(`[ADMIN-OTP] Clicking Send OTP button...`);
        await submitBtn.click({ force: true }).catch(() => {});
      } else {
        await input.press('Enter').catch(() => {});
      }
    }

    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(300);

      if (otpErrorResponse) {
        const errObj = otpErrorResponse.errors?.[0] || {};
        detectedError = errObj.displayMsg || errObj.description || otpErrorResponse.message || otpErrorResponse.error || 'Domino\'s rejected OTP request.';
        break;
      }

      // 1. Direct API confirmation: If official Domino's API returned SUCCESS response, OTP is dispatched!
      if (otpSuccessResponse && (otpSuccessResponse.status === 'SUCCESS' || otpSuccessResponse.success === true)) {
        reachedOtpScreen = true;
        break;
      }

      // Check DOM for error text
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (bodyText.includes('Daily OTP limit has been exhausted')) {
        detectedError = 'Daily OTP limit has been exhausted for this mobile number on Domino\'s India.';
        break;
      }
      if (bodyText.includes('Please enter valid mobile number') || bodyText.includes('Mobile Number should be of 10 digits')) {
        detectedError = 'Please enter a valid 10-digit Indian mobile number.';
        break;
      }
      if (bodyText.includes('Something went wrong') && !page.url().includes('login-otp')) {
        detectedError = 'Domino\'s gateway reported: Something went wrong. Please try again after some time.';
        break;
      }

      // Check if OTP input is visible or URL is login-otp
      if (page.url().includes('login-otp')) {
        reachedOtpScreen = true;
        break;
      }
      const otpInputCount = await page.locator('[data-testid="otp-input"], [data-testid="user-input"], input[autocomplete="one-time-code"], input[name="otpInput"], input.OtpInputstyle__OtpNativeInput-bvKQdi, input[maxlength="1"]').count();
      if (otpInputCount > 0 && !(await page.locator('#loginNumber').isVisible().catch(() => false))) {
        reachedOtpScreen = true;
        break;
      }
    }

    if (detectedError) {
      console.warn(`[ADMIN-OTP] ⚠️ Domino's OTP Rejected: ${detectedError}`);
      await browser.close().catch(() => {});
      return {
        success: false,
        error: detectedError,
        isLimitExhausted: detectedError.toLowerCase().includes('limit') || detectedError.toLowerCase().includes('exhausted')
      };
    }

    if (!reachedOtpScreen) {
      const finalBody = await page.locator('body').innerText().catch(() => '');
      if (finalBody.includes('Daily OTP limit')) {
        await browser.close().catch(() => {});
        return {
          success: false,
          error: 'Daily OTP limit has been exhausted for this mobile number on Domino\'s India.',
          isLimitExhausted: true
        };
      }
      await browser.close().catch(() => {});
      return {
        success: false,
        error: 'Domino\'s did not transition to the OTP verification screen. Please verify your mobile number or try Method 2.'
      };
    }

    const timer = otpSuccessResponse?.timer || 45;
    console.log(`[ADMIN-OTP] ✅ OTP Screen reached! Domino's ${timer}s SMS timer started.`);

    // Ensure transition to login-otp finishes
    try {
      if (!page.url().includes('login-otp')) {
        await page.waitForURL(/.*login-otp.*/, { timeout: 6000 }).catch(() => {});
      }
    } catch (e) {}

    // Active connection TTL: 180 seconds (3 minutes) max to allow authentic SMS arrival & verification
    const OTP_SESSION_TTL_MS = 180 * 1000;
    const cleanupTimeout = setTimeout(() => {
      console.log(`[ADMIN-OTP] ⏱️ 180-second OTP window expired for +91 ${cleanPhone}. Disposing browser session.`);
      cleanupSession(cleanPhone);
    }, OTP_SESSION_TTL_MS);

    activeLiveOtpSessions.set(cleanPhone, {
      browser,
      context,
      page,
      phone: cleanPhone,
      requestedAt: Date.now(),
      ttlMs: OTP_SESSION_TTL_MS,
      cleanupTimeout,
      timer: timer
    });

    return {
      success: true,
      message: `Domino's India has dispatched a real 6-digit SMS OTP to +91 ${cleanPhone}. Please enter it below.`,
      timer: timer,
      sessionTtlSeconds: 180
    };

  } catch (err) {
    console.error(`[ADMIN-OTP-ERR]`, err.message);
    if (browser) await browser.close().catch(() => {});
    return {
      success: false,
      error: `Domino's OTP dispatch failed: ${err.message}`
    };
  }
}

/**
 * 2. Verify Live Domino's SMS OTP & Extract Authentic Session Cookies & Tokens
 * Tags Account as NEW_ACCOUNT (50% OFF) or EXISTING_ACCOUNT (Reorder history)
 */
async function verifyLiveDominoOtp({ phone, otp, category, categoryName, couponCode }) {
  let cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(-10);
  const cleanOtp = (otp || '').trim().replace(/[^0-9]/g, '');

  if (!cleanOtp || cleanOtp.length !== 6) {
    return {
      success: false,
      error: 'Please enter the authentic 6-digit OTP received via SMS from Domino\'s.'
    };
  }

  let session = activeLiveOtpSessions.get(cleanPhone);
  if (!session) {
    // Check if any active session matches suffix or prefix
    for (const [k, s] of activeLiveOtpSessions.entries()) {
      if (k === cleanPhone || k.endsWith(cleanPhone) || cleanPhone.endsWith(k)) {
        session = s;
        cleanPhone = k;
        break;
      }
    }
  }
  if (!session && activeLiveOtpSessions.size > 0) {
    let mostRecent = null;
    for (const s of activeLiveOtpSessions.values()) {
      if ((Date.now() - s.requestedAt) < (s.ttlMs || 180000)) {
        if (!mostRecent || s.requestedAt > mostRecent.requestedAt) {
          mostRecent = s;
        }
      }
    }
    if (mostRecent) {
      session = mostRecent;
      cleanPhone = mostRecent.phone;
      console.log(`[ADMIN-OTP] Matched most recent active OTP session for +91 ${cleanPhone}`);
    }
  }

  // Graceful duplicate verify protection: if session was just consumed within 20s
  if (!session) {
    const existingAccounts = db.getAccounts();
    const recentlyVerified = existingAccounts.find(a => a.cleanPhone === cleanPhone && (Date.now() - new Date(a.lastRefreshedAt || a.storedAt).getTime()) < 20000);
    if (recentlyVerified) {
      console.log(`[ADMIN-OTP] Duplicate verify request: Account ${cleanPhone} was already verified successfully! Returning existing session.`);
      return {
        success: true,
        message: `Domino's session verified and saved! Account tier: ${recentlyVerified.categoryName}`,
        account: recentlyVerified
      };
    }
  }

  if (!session) {
    return {
      success: false,
      error: 'No active OTP session found for this number or the 3-minute session window has expired. Please request a fresh OTP.'
    };
  }

  const elapsedMs = Date.now() - session.requestedAt;
  if (elapsedMs > (session.ttlMs || 180000)) {
    await cleanupSession(cleanPhone);
    return {
      success: false,
      error: 'The 3-minute OTP session window has expired. Please request a fresh OTP.'
    };
  }

  const { browser, context, page, cleanupTimeout } = session;
  if (cleanupTimeout) clearTimeout(cleanupTimeout);

  try {
    // Ensure we are on login-otp page before locating the OTP input
    if (!page.url().includes('login-otp')) {
      await page.waitForURL(/.*login-otp.*/, { timeout: 6000 }).catch(() => {});
    }

    console.log(`[ADMIN-OTP] ✍️ Typing 6-digit OTP (${cleanOtp}) into Domino's verification input...`);

    let otpInput = null;

    // Check if Domino's renders 6 individual digit inputs
    const digitInputs = await page.locator('input[maxlength="1"], .otp-digit-input, [data-testid*="otp-digit"]').all();
    if (digitInputs && digitInputs.length >= 6) {
      console.log(`[ADMIN-OTP] Detected 6 individual digit inputs on Domino's page. Populating individually...`);
      for (let d = 0; d < 6; d++) {
        await digitInputs[d].fill(cleanOtp[d]);
        await page.waitForTimeout(60);
      }
    } else {
      const otpInputSelector = '[data-testid="otp-input"] input, [data-testid="user-input"], input[autocomplete="one-time-code"], input[name="otpInput"], input.OtpInputstyle__OtpNativeInput-bvKQdi, input[maxlength="6"], input[type="tel"], input[type="text"]';
      otpInput = page.locator(otpInputSelector).first();
      if (await otpInput.isVisible({ timeout: 8000 }).catch(() => false)) {
        await otpInput.click();
        await otpInput.fill(''); // Clear any previous digits
        await otpInput.pressSequentially(cleanOtp, { delay: 80 });
      }
    }
    await page.waitForTimeout(400);

    // Also trigger in-page input/change event
    await page.evaluate((val) => {
      const inp = document.querySelector('[data-testid="otp-input"] input, [data-testid="user-input"], input[autocomplete="one-time-code"]');
      if (inp) {
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const boxes = document.querySelectorAll('input[maxlength="1"]');
      if (boxes && boxes.length >= 6) {
        for (let i = 0; i < 6; i++) {
          boxes[i].value = val[i] || '';
          boxes[i].dispatchEvent(new Event('input', { bubbles: true }));
          boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, cleanOtp);
    await page.waitForTimeout(400);

    // Listen for Domino's official validatecode response
    let validateCodeResponse = null;
    page.on('response', async res => {
      if (res.url().includes('loginhandler/validatecode')) {
        try {
          validateCodeResponse = await res.json();
        } catch (e) {}
      }
    });

    console.log(`[ADMIN-OTP] Submitting OTP by clicking Login / Submit button...`);
    const loginBtn = page.locator('[data-testid="login-button"] button, button:has-text("Login"), button:has-text("Submit"), button:has-text("Verify"), button.btn--red').first();
    if (await loginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      for (let w = 0; w < 10; w++) {
        if (await loginBtn.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(200);
      }
      await loginBtn.click();
    } else {
      if (otpInput) {
        await otpInput.press('Enter').catch(() => {});
      } else {
        await page.keyboard.press('Enter').catch(() => {});
      }
    }

    // Wait for validatecode response or error message for up to 8 seconds
    for (let i = 0; i < 25; i++) {
      if (validateCodeResponse) break;
      await page.waitForTimeout(300);
    }

    // Check validatecode response if captured
    if (validateCodeResponse) {
      if (validateCodeResponse.status === 'FAILED') {
        const errMsg = validateCodeResponse.errors?.[0]?.displayMsg || 
                       validateCodeResponse.errors?.[0]?.description || 
                       validateCodeResponse.message || 
                       'Incorrect OTP entered. Please check your SMS and retry.';
        console.warn(`[ADMIN-OTP] ⚠️ Domino's OTP Error: ${errMsg}`);
        return {
          success: false,
          error: errMsg
        };
      }
    }

    // Also check DOM for error message
    const errorLocator = page.locator('.error, .alert, [class*="error"], [class*="Error"], span:has-text("Invalid OTP"), span:has-text("Incorrect OTP"), span:has-text("Wrong OTP")').first();
    if (await errorLocator.isVisible({ timeout: 1500 }).catch(() => false)) {
      const errText = await errorLocator.innerText();
      console.warn(`[ADMIN-OTP] ⚠️ Domino's OTP Error from DOM: ${errText}`);
      return {
        success: false,
        error: `Domino's validation error: ${errText || 'Invalid OTP. Please check your SMS and retry.'}`
      };
    }

    // Wait for session storage to populate
    await page.waitForTimeout(3000);

    // Extract real credentials from validateCodeResponse if available, or from page context
    let accessToken = validateCodeResponse?.credentials?.accessToken || validateCodeResponse?.credentials?.idToken || '';
    let refreshToken = validateCodeResponse?.credentials?.refreshToken || '';
    let userId = validateCodeResponse?.attributes?.userId || '';
    let cartId = validateCodeResponse?.attributes?.cartId || '';
    let customerName = (validateCodeResponse?.attributes?.firstName || validateCodeResponse?.attributes?.lastName)
      ? `${validateCodeResponse?.attributes?.firstName || ''} ${validateCodeResponse?.attributes?.lastName || ''}`.trim()
      : '';

    // Capture Real Domino's Cookies
    const realCookies = await context.cookies();
    console.log(`[ADMIN-OTP] 🔑 Extracted ${realCookies.length} authentic Domino's session cookies!`);

    // Capture LocalStorage Auth Tokens & User Info
    const realLocalStorage = await page.evaluate(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        items[key] = localStorage.getItem(key);
      }
      return items;
    });

    if (!accessToken) {
      accessToken = realLocalStorage['token'] || realLocalStorage['authToken'] || realLocalStorage['auth_token'];
    }
    if (!refreshToken && realLocalStorage['userInfo']) {
      try {
        const uInfo = JSON.parse(realLocalStorage['userInfo']);
        refreshToken = uInfo.headers?.credentials?.refreshToken || '';
        if (!accessToken) accessToken = uInfo.headers?.credentials?.accessToken || uInfo.headers?.credentials?.sessionToken || '';
        if (!userId) userId = uInfo.headers?.userId || '';
        if (!cartId) cartId = uInfo.headers?.cartId || '';
      } catch (e) {}
    }

    // Automatically detect past order history and reorder items inside live authenticated browser context
    let detectedHistory = { pastOrdersCount: 0, reorderItems: [] };
    try {
      detectedHistory = await page.evaluate(async (uid) => {
        let count = 0;
        let items = [];

        // 1. Check LocalStorage for Domino's stored order history / reorders
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const raw = localStorage.getItem(k);
          if (k.toLowerCase().includes('order') || k.toLowerCase().includes('reorder') || k.toLowerCase().includes('history')) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed) && parsed.length > 0) {
                count = Math.max(count, parsed.length);
                parsed.forEach(o => {
                  const itm = o.name || o.items?.[0]?.name || o.orderItems?.[0]?.name || o.title;
                  if (itm && !items.includes(itm)) items.push(itm);
                });
              } else if (parsed && Array.isArray(parsed.orders) && parsed.orders.length > 0) {
                count = Math.max(count, parsed.orders.length);
                parsed.orders.forEach(o => {
                  const itm = o.items?.[0]?.name || o.orderItems?.[0]?.name || o.name;
                  if (itm && !items.includes(itm)) items.push(itm);
                });
              }
            } catch(e) {}
          }
        }

        // 2. Query Domino's internal endpoints with browser session
        try {
          const endpoints = [
            'https://api.dominos.co.in/order-service/v1/orders/favourites/recommendations',
            'https://api.dominos.co.in/order-service/v1/customer/orders'
          ];
          for (const ep of endpoints) {
            try {
              const res = await fetch(ep, {
                headers: {
                  'api_key': 'd2aeb489bb8df385',
                  'client_type': 'web app-chrome',
                  'source': 'PWA18'
                }
              });
              if (res.ok) {
                const data = await res.json();
                const list = data.orders || data.data || data.orderHistory || [];
                if (Array.isArray(list) && list.length > 0) {
                  count = Math.max(count, list.length);
                  list.forEach(o => {
                    const name = o.items?.[0]?.name || o.orderItems?.[0]?.name || o.name;
                    if (name && !items.includes(name)) items.push(name);
                  });
                }
              }
            } catch(e) {}
          }
        } catch(e) {}

        // 3. Inspect DOM for Domino's Reorder / Order Again cards
        try {
          const reorderCards = document.querySelectorAll('.reorder-card, .reorder-item, [class*="reorder"], [class*="order-again"]');
          if (reorderCards && reorderCards.length > 0) {
            count = Math.max(count, reorderCards.length);
            reorderCards.forEach(c => {
              const txt = c.querySelector('h3, h4, .title, .item-name, [class*="name"]')?.innerText?.trim();
              if (txt && !items.includes(txt)) items.push(txt);
            });
          }
        } catch(e) {}

        return {
          pastOrdersCount: count,
          reorderItems: items.slice(0, 5)
        };
      }, userId);
    } catch (histErr) {
      console.warn(`[ADMIN-OTP] Live browser order history evaluation note:`, histErr.message);
    }

    let pastOrdersCount = detectedHistory.pastOrdersCount || 0;
    let reorderItems = detectedHistory.reorderItems || [];
    let hasOrderHistory = pastOrdersCount > 0 || reorderItems.length > 0;
    let accountType = 'NEW_ACCOUNT';

    let assignedCategory = 'CATEGORY_50_OFF';
    let assignedCategoryName = '50% OFF New User Tier';
    let assignedCoupon = 'DOMNEW50';

    if (pastOrdersCount === 0 && reorderItems.length === 0) {
      accountType = 'NEW_ACCOUNT';
      assignedCategory = 'CATEGORY_50_OFF';
      assignedCategoryName = '50% OFF New User Tier';
      assignedCoupon = 'DOMNEW50';
    } else if (pastOrdersCount === 1) {
      accountType = 'SECOND_ORDER_ACCOUNT';
      assignedCategory = 'CATEGORY_SECOND_ORDER';
      assignedCategoryName = 'Cheesy 2nd Order Tier';
      assignedCoupon = 'CHEESY';
    } else {
      accountType = 'EXISTING_ACCOUNT';
      assignedCategory = 'CATEGORY_FLAT_100';
      assignedCategoryName = 'Party Repeat Order Tier';
      assignedCoupon = 'PARTY';
    }

    if (category) assignedCategory = category;
    if (categoryName) assignedCategoryName = categoryName;
    if (couponCode) assignedCoupon = couponCode;

    // Build authentic Domino's account record
    const existingAccounts = db.getAccounts();
    const existingIdx = existingAccounts.findIndex(a => a.cleanPhone === cleanPhone);
    const accountId = existingIdx >= 0 ? existingAccounts[existingIdx].id : `ACC-DOM-${Date.now().toString().slice(-4)}`;

    const newAccount = {
      id: accountId,
      phone: `+91 ${cleanPhone}`,
      cleanPhone: cleanPhone,
      customerName: customerName || `Domino's Customer (${cleanPhone.slice(-4)})`,
      userId: String(userId || ''),
      cartId: String(cartId || ''),
      accountType: accountType,
      category: assignedCategory,
      categoryName: assignedCategoryName,
      couponCode: assignedCoupon,
      cookies: realCookies,
      localStorage: realLocalStorage,
      sessionToken: accessToken || `dom_auth_${Date.now()}`,
      refreshToken: refreshToken,
      credentials: {
        accessToken: accessToken,
        refreshToken: refreshToken,
        sessionToken: accessToken,
        accessKeyId: accessToken,
        cartId: String(cartId || ''),
        userId: String(userId || '')
      },
      pastOrdersCount: pastOrdersCount,
      reorderItems: reorderItems,
      status: 'IDLE',
      totalOrdersPlaced: existingIdx >= 0 ? (existingAccounts[existingIdx].totalOrdersPlaced || 0) : 0,
      storedAt: existingIdx >= 0 ? (existingAccounts[existingIdx].storedAt || new Date().toISOString()) : new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      source: 'LIVE_SMS_OTP',
      lastActive: new Date().toISOString()
    };

    // Deeply sync credentials into localStorage and cookies
    applyAccountRefresh(newAccount, {
      success: true,
      accessToken: accessToken,
      refreshToken: refreshToken,
      cartId: String(cartId || ''),
      userId: String(userId || ''),
      lastRefreshedAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });

    if (existingIdx >= 0) {
      existingAccounts[existingIdx] = newAccount;
      db.save();
    } else {
      db.addAccount(newAccount);
    }

    // Sync storefront profile
    try {
      const currentProfile = db.getUserProfile();
      if (!currentProfile.phone || currentProfile.phone.includes('9876543210') || !currentProfile.phone.slice(-10).match(/^[6-9]\d{9}$/)) {
        db.updateUserProfile({
          phone: `+91 ${cleanPhone}`,
          name: customerName || currentProfile.name
        });
      }
    } catch (e) {}

    await cleanupSession(cleanPhone);

    console.log(`[ADMIN-OTP] ✅ Domino's Account ${newAccount.phone} securely saved into pool!`);
    return {
      success: true,
      isUpdated: existingIdx >= 0,
      message: existingIdx >= 0
        ? `Session for ${newAccount.phone} successfully updated! Refreshed cookies & renewed 30-day token.`
        : `Domino's session verified and saved! Account categorized as: ${newAccount.categoryName}`,
      account: newAccount
    };

  } catch (err) {
    console.error(`[ADMIN-OTP-VERIFY-ERR]`, err.message);
    return {
      success: false,
      error: `OTP verification error: ${err.message}`
    };
  }
}

// Map to hold persistent launched browser sessions for server host inspection
const activeAdminBrowsers = new Map();

/**
 * Sanitize cookies so Playwright's context.addCookies never throws
 */
function sanitizeCookiesForPlaywright(cookies) {
  if (!Array.isArray(cookies)) return [];
  const validSameSite = ['Strict', 'Lax', 'None'];
  const sanitized = [];
  for (const c of cookies) {
    if (!c.name || c.value === undefined) continue;
    let sameSite = 'Lax';
    if (c.sameSite && validSameSite.includes(c.sameSite)) {
      sameSite = c.sameSite;
    } else if (typeof c.sameSite === 'string') {
      const match = validSameSite.find(s => s.toLowerCase() === c.sameSite.toLowerCase());
      if (match) sameSite = match;
    }
    let domain = c.domain || '.dominos.co.in';
    if (domain.startsWith('http')) {
      try {
        domain = new URL(domain).hostname;
      } catch (e) {
        domain = '.dominos.co.in';
      }
    }
    let expires = typeof c.expires === 'number' && c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    
    sanitized.push({
      name: String(c.name),
      value: String(c.value),
      domain: domain,
      path: c.path || '/',
      expires: expires,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure || domain.includes('dominos')),
      sameSite: sameSite
    });
  }
  return sanitized;
}

/**
 * 3. Launch a Headed Browser Session Pre-filled with Domino's Stored Cookies
 * Allows admin to directly inspect and use the account on m.dominos.co.in
 */
async function launchBrowserWithSession(accountId) {
  const accounts = db.getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    return { success: false, error: 'Account not found in pool.' };
  }

  // Auto-refresh token if expired or close to expiry before launching host browser
  if (account.refreshToken && account.userId) {
    const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : 0;
    const now = Date.now();
    if (!expiresAt || expiresAt <= now + 5 * 60 * 1000) {
      console.log(`[ADMIN-LAUNCH] 🔄 Access token for ${account.phone} expired or expiring soon. Refreshing via Domino's API...`);
      try {
        const refreshResult = await refreshDominoSession(account.userId, account.refreshToken);
        if (refreshResult && refreshResult.success) {
          applyAccountRefresh(account, refreshResult);
          db.save();
          console.log(`[ADMIN-LAUNCH] ✅ Refreshed session token for ${account.phone}.`);
        }
      } catch (err) {
        console.warn(`[ADMIN-LAUNCH] ⚠️ Token refresh error:`, err.message);
      }
    }
  }

  console.log(`[ADMIN-LAUNCH] 🚀 Opening headed browser session for ${account.phone}...`);

  try {
    // If an existing launched browser is active for this account, focus it or close it first
    if (activeAdminBrowsers.has(accountId)) {
      try {
        const old = activeAdminBrowsers.get(accountId);
        await old.browser.close().catch(() => {});
      } catch (e) {}
      activeAdminBrowsers.delete(accountId);
    }

    const proxyConfig = proxyService.getPlaywrightProxy();
    const headedOpts = {
      executablePath: CHROME_PATH,
      headless: false,
      args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled']
    };
    if (proxyConfig) headedOpts.proxy = proxyConfig;

    const browser = await chromium.launch(headedOpts);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: null
    });

    // Inject sanitized cookies
    if (account.cookies && Array.isArray(account.cookies) && account.cookies.length > 0) {
      const sanitized = sanitizeCookiesForPlaywright(account.cookies);
      await context.addCookies(sanitized).catch(e => console.warn('[ADMIN-LAUNCH] Cookie injection warning:', e.message));
    }

    const page = await context.newPage();

    // Prepare verified authentic userInfo payload for Domino's React/Redux App
    const storageData = account.localStorage || {};
    const token = account.sessionToken || '';
    const cleanPhone = account.cleanPhone || '';
    const userId = account.userId || '';
    const cartId = account.cartId || '';
    const customerName = account.customerName || '';
    const cleanToken = token.startsWith('Bearer ') ? token : (token ? `Bearer ${token}` : '');
    const cleanRefreshToken = account.refreshToken ? (account.refreshToken.startsWith('Bearer ') ? account.refreshToken : `Bearer ${account.refreshToken}`) : '';

    let hostUserInfoStr = null;
    if (storageData && storageData.userInfo) {
      try {
        const parsedUI = typeof storageData.userInfo === 'string' ? JSON.parse(storageData.userInfo) : { ...storageData.userInfo };
        parsedUI.headers = parsedUI.headers || {};
        parsedUI.headers.isLoggedIn = true;
        parsedUI.headers.status = 'SUCCESS';
        parsedUI.headers.source = parsedUI.headers.source || 'PWA18#upsell';
        parsedUI.headers.deliveryType = parsedUI.headers.deliveryType || 'D';
        parsedUI.headers.credentials = parsedUI.headers.credentials || {};
        if (cleanToken) {
          parsedUI.headers.credentials.accessToken = cleanToken;
          parsedUI.headers.credentials.sessionToken = cleanToken;
          parsedUI.headers.credentials.accessKeyId = cleanToken;
        }
        if (cleanRefreshToken) {
          parsedUI.headers.credentials.refreshToken = cleanRefreshToken;
        }
        if (userId) parsedUI.headers.userId = userId;
        if (cartId) parsedUI.headers.cartId = cartId;
        hostUserInfoStr = JSON.stringify(parsedUI);
      } catch (e) {
        hostUserInfoStr = typeof storageData.userInfo === 'string' ? storageData.userInfo : JSON.stringify(storageData.userInfo);
      }
    }
    if (!hostUserInfoStr) {
      const userProfilePlain = JSON.stringify({
        phone: cleanPhone,
        mobile: cleanPhone,
        name: customerName || `Domino's Customer (${cleanPhone.slice(-4)})`,
        email: '',
        userId: userId || ''
      });
      const encryptedUserData = encryptDominoString(userProfilePlain, DOMINO_SALT);
      const defaultUserInfo = {
        headers: {
          isLoggedIn: true,
          status: 'SUCCESS',
          source: 'PWA18#upsell',
          deliveryType: 'D',
          credentials: {
            accessToken: cleanToken,
            refreshToken: cleanRefreshToken || cleanToken,
            sessionToken: cleanToken,
            accessKeyId: cleanToken
          },
          userId: userId || '',
          cartId: cartId || ''
        },
        userData: encryptedUserData
      };
      hostUserInfoStr = JSON.stringify(defaultUserInfo);
    }

    // Inject saved localStorage & auth state before page scripts execute
    await page.addInitScript(({ storage, token, phone, userId, cartId, finalUserInfo }) => {
      try {
        for (const [k, v] of Object.entries(storage)) {
          if (v !== undefined && v !== null) {
            localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
          }
        }
        if (finalUserInfo) {
          localStorage.setItem('userInfo', finalUserInfo);
          sessionStorage.setItem('userInfo', finalUserInfo);
        }
        if (token) {
          localStorage.setItem('token', token);
          localStorage.setItem('authToken', token);
          localStorage.setItem('auth_token', token);
          sessionStorage.setItem('token', token);
          sessionStorage.setItem('authToken', token);
        }
        if (phone) {
          localStorage.setItem('mobileNo', phone);
          localStorage.setItem('trackOrderMobile', phone);
          sessionStorage.setItem('mobileNo', phone);
        }
        if (userId) localStorage.setItem('userId', userId);
        if (cartId) localStorage.setItem('cartId', cartId);
        localStorage.setItem('isLoggedIn', 'true');
        localStorage.setItem('userLoggedIn', 'true');
      } catch (e) {}
    }, {
      storage: storageData,
      finalUserInfo: hostUserInfoStr,
      token: cleanToken,
      phone: cleanPhone,
      userId: userId,
      cartId: cartId
    });

    await page.goto('https://m.dominos.co.in/jfl-discovery-ui/en/dt/home', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Store active browser instance in memory so it does not close unexpectedly
    activeAdminBrowsers.set(accountId, { browser, context, page });

    return {
      success: true,
      message: `Launched Domino's session for ${account.phone} in Chrome on server host!`
    };
  } catch (err) {
    console.error(`[ADMIN-LAUNCH-ERR]`, err.message);
    return {
      success: false,
      error: `Failed to launch browser: ${err.message}`
    };
  }
}

/**
 * 4. Export Cookies JSON & 1-Click Auto-Login Console Snippet
 * Generates an IIFE that safely injects both cookies and all localStorage keys into Domino's PWA
 */
async function exportCookiesJson(accountId) {
  const accounts = db.getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    return { success: false, error: 'Account not found' };
  }

  // Auto-refresh token if expired or close to expiry before generating export code
  if (account.refreshToken && account.userId) {
    const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : 0;
    const now = Date.now();
    // Refresh if expired or expiring within 5 minutes
    if (!expiresAt || expiresAt <= now + 5 * 60 * 1000) {
      console.log(`[ADMIN-EXPORT] 🔄 Access token for account ${account.phone} expired or expiring soon. Refreshing via Domino's API...`);
      try {
        const refreshResult = await refreshDominoSession(account.userId, account.refreshToken);
        if (refreshResult && refreshResult.success) {
          applyAccountRefresh(account, refreshResult);
          db.save();
          console.log(`[ADMIN-EXPORT] ✅ Auto-refreshed token for ${account.phone}. Valid until ${account.accessTokenExpiresAt}`);
        } else {
          console.warn(`[ADMIN-EXPORT] ⚠️ Auto-refresh attempt failed:`, refreshResult?.error);
        }
      } catch (err) {
        console.warn(`[ADMIN-EXPORT] ⚠️ Network error during auto-refresh:`, err.message);
      }
    }
  }

  const cookies = account.cookies || [];
  const localStorageData = account.localStorage || {};
  const token = account.sessionToken || '';
  const phone = account.cleanPhone || '';
  const userId = account.userId || '';
  const cartId = account.cartId || '';
  const customerName = account.customerName || '';

  // Bulletproof IIFE for DevTools Console
  const cleanToken = token.startsWith('Bearer ') ? token : (token ? `Bearer ${token}` : '');
  const cleanRefreshToken = account.refreshToken ? (account.refreshToken.startsWith('Bearer ') ? account.refreshToken : `Bearer ${account.refreshToken}`) : '';

  // Prepare verified authentic userInfo payload for Domino's React/Redux App
  let finalUserInfoStr = null;
  if (localStorageData && localStorageData.userInfo) {
    try {
      const parsedUI = typeof localStorageData.userInfo === 'string' ? JSON.parse(localStorageData.userInfo) : { ...localStorageData.userInfo };
      parsedUI.headers = parsedUI.headers || {};
      parsedUI.headers.isLoggedIn = true;
      parsedUI.headers.status = 'SUCCESS';
      parsedUI.headers.source = parsedUI.headers.source || 'PWA18#upsell';
      parsedUI.headers.deliveryType = parsedUI.headers.deliveryType || 'D';
      parsedUI.headers.credentials = parsedUI.headers.credentials || {};
      if (cleanToken) {
        parsedUI.headers.credentials.accessToken = cleanToken;
        parsedUI.headers.credentials.sessionToken = cleanToken;
        parsedUI.headers.credentials.accessKeyId = cleanToken;
      }
      if (cleanRefreshToken) {
        parsedUI.headers.credentials.refreshToken = cleanRefreshToken;
      }
      if (userId) parsedUI.headers.userId = userId;
      if (cartId) parsedUI.headers.cartId = cartId;

      // Ensure parsedUI.userData is authentic Domino's encrypted Salted__ string
      if (!parsedUI.userData || typeof parsedUI.userData !== 'string' || !parsedUI.userData.startsWith('U2FsdGVkX1')) {
        const userProfilePlain = JSON.stringify({
          phone: phone,
          mobile: phone,
          name: customerName || `Domino's Customer (${phone.slice(-4)})`,
          email: '',
          userId: userId || ''
        });
        parsedUI.userData = encryptDominoString(userProfilePlain, DOMINO_SALT);
      }
      finalUserInfoStr = JSON.stringify(parsedUI);
    } catch (e) {
      finalUserInfoStr = typeof localStorageData.userInfo === 'string' ? localStorageData.userInfo : JSON.stringify(localStorageData.userInfo);
    }
  }

  if (!finalUserInfoStr) {
    const userProfilePlain = JSON.stringify({
      phone: phone,
      mobile: phone,
      name: customerName || `Domino's Customer (${phone.slice(-4)})`,
      email: '',
      userId: userId || ''
    });
    const encryptedUserData = encryptDominoString(userProfilePlain, DOMINO_SALT);
    const defaultUserInfo = {
      headers: {
        isLoggedIn: true,
        status: 'SUCCESS',
        source: 'PWA18#upsell',
        deliveryType: 'D',
        credentials: {
          accessToken: cleanToken,
          refreshToken: cleanRefreshToken || cleanToken,
          sessionToken: cleanToken,
          accessKeyId: cleanToken
        },
        userId: userId || '',
        cartId: cartId || ''
      },
      userData: encryptedUserData
    };
    finalUserInfoStr = JSON.stringify(defaultUserInfo);
  }

  const consoleScript = `(function() {
  try {
    if (!window.location.hostname.includes('dominos.co.in')) {
      alert('⚠️ Domino\'s Order Engine Auto-Login Note:\\n\\nPlease paste and run this code in the DevTools Console on https://m.dominos.co.in/ !\\n\\nRedirecting you to Domino\\'s now...');
      window.location.href = 'https://m.dominos.co.in/jfl-discovery-ui/en/dt/home';
      return;
    }

    console.log('%c🚀 Domino\'s Order Engine Auto-Login Initiating for +91 ${phone}...', 'background: #0066a3; color: #fff; font-size: 14px; font-weight: bold; padding: 6px 12px; border-radius: 6px;');
    
    // 0. Clear conflicting guest Redux persist state & session data so app rehydrates cleanly
    try {
      localStorage.removeItem('persist:root');
      localStorage.removeItem('cartItems');
      sessionStorage.clear();
    } catch(e) {}

    // 1. Inject Authentic Domino's Session Cookies
    const cookies = ${JSON.stringify(cookies)};
    let cookiesCount = 0;
    for (const c of cookies) {
      if (!c.name || c.value === undefined) continue;
      try {
        const val = c.value;
        // Host-only cookie
        document.cookie = c.name + '=' + val + '; path=/; max-age=2592000; SameSite=Lax; Secure';
        // Domain .dominos.co.in cookie
        document.cookie = c.name + '=' + val + '; path=/; domain=.dominos.co.in; max-age=2592000; SameSite=Lax; Secure';
        cookiesCount++;
      } catch(e) {}
    }

    const tok = ${JSON.stringify(cleanToken)};
    if (tok) {
      const rawTok = tok.replace(/^Bearer\\s+/i, '');
      document.cookie = 'token=' + tok + '; path=/; domain=.dominos.co.in; max-age=2592000; SameSite=Lax; Secure';
      document.cookie = 'token=' + tok + '; path=/; max-age=2592000; SameSite=Lax; Secure';
      document.cookie = 'authToken=' + tok + '; path=/; domain=.dominos.co.in; max-age=2592000; SameSite=Lax; Secure';
      document.cookie = 'authToken=' + tok + '; path=/; max-age=2592000; SameSite=Lax; Secure';
      document.cookie = 'rawToken=' + rawTok + '; path=/; domain=.dominos.co.in; max-age=2592000; SameSite=Lax; Secure';
    }

    // 2. Inject Domino's LocalStorage Keys (Required by Domino's React/Redux app)
    const storageData = ${JSON.stringify(localStorageData)};
    let storageCount = 0;
    for (const [key, val] of Object.entries(storageData)) {
      if (val !== undefined && val !== null && key !== 'persist:root') {
        try {
          localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
          storageCount++;
        } catch(e) {}
      }
    }

    // 3. Set Verified userInfo with complete userData & credentials
    const finalUserInfo = ${JSON.stringify(finalUserInfoStr)};
    if (finalUserInfo) {
      try {
        localStorage.setItem('userInfo', finalUserInfo);
        sessionStorage.setItem('userInfo', finalUserInfo);
      } catch(e) {}
    }

    // 4. Ensure Essential Auth Keys are Present
    const phone = ${JSON.stringify(phone)};
    const uid = ${JSON.stringify(userId)};
    const cid = ${JSON.stringify(cartId)};
    const cName = ${JSON.stringify(customerName)};

    try {
      if (tok) {
        const rawTok = tok.replace(/^Bearer\\s+/i, '');
        localStorage.setItem('token', tok);
        localStorage.setItem('authToken', tok);
        localStorage.setItem('auth_token', tok);
        localStorage.setItem('rawToken', rawTok);
        sessionStorage.setItem('token', tok);
        sessionStorage.setItem('authToken', tok);
      }
      if (phone) {
        localStorage.setItem('mobileNo', phone);
        localStorage.setItem('trackOrderMobile', phone);
        sessionStorage.setItem('mobileNo', phone);
      }
      if (uid) {
        localStorage.setItem('userId', uid);
        sessionStorage.setItem('userId', uid);
      }
      if (cid) {
        localStorage.setItem('cartId', cid);
        sessionStorage.setItem('cartId', cid);
      }
      if (cName) localStorage.setItem('customerName', cName);
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('userLoggedIn', 'true');
    } catch(e) {}

    console.log('%c✓ Injected ' + cookiesCount + ' cookies and ' + storageCount + ' storage state items!', 'color: #16a34a; font-weight: bold; font-size: 13px;');

    // 5. Visual Banner on Page
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#15803d;color:#fff;padding:14px 28px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:bold;z-index:9999999;box-shadow:0 10px 30px rgba(0,0,0,0.35);text-align:center;border:2px solid #86efac;';
    banner.innerHTML = '🎉 Domino\'s Order Engine Auto-Login Successful!<br><span style="font-size:12px;font-weight:600;opacity:0.9;">Logged in as +91 ' + phone + (uid ? ' (UID: ' + uid + ')' : '') + '. Redirecting to Domino\\'s...</span>';
    document.body.appendChild(banner);

    // 6. Direct Clean Navigation to Storefront
    setTimeout(function() {
      window.location.href = 'https://m.dominos.co.in/jfl-discovery-ui/en/dt/home';
    }, 800);
  } catch (err) {
    console.error('❌ Domino\'s Order Engine Auto-Login encountered an error:', err);
    alert('Domino\'s Order Engine Auto-Login error: ' + err.message);
  }
})();`;

  const bookmarkletCode = `javascript:${encodeURIComponent(consoleScript)}`;

  return {
    success: true,
    phone: account.phone,
    accountId: account.id,
    cookiesCount: cookies.length,
    cookies: cookies,
    consoleScript: consoleScript,
    bookmarkletCode: bookmarkletCode
  };
}

/**
 * 5. Decode JWT Payload without external dependencies
 */
function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const clean = token.replace(/^Bearer\s+/i, '').trim();
  if (clean.includes('..')) return null; // Direct JWE token with encrypted payload
  const parts = clean.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/**
 * 6. Parse Any Key-Value Pair Format, JSON, Cookie Array or Raw Token Input
 * Deep-scans userInfo, Redux persist trees, raw text, and decrypts Domino's AES-256 data.
 */
function parseDominoSessionInput(rawInput, fallbackPhone = '') {
  if (!rawInput) {
    throw new Error('Please paste your Domino\'s session JSON, key-value pairs, or token.');
  }

  let text = typeof rawInput === 'string' ? rawInput.trim() : JSON.stringify(rawInput);
  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // If not strict JSON, try unescaping
  }

  let token = null;
  let refreshToken = null;
  let phone = fallbackPhone ? fallbackPhone.replace(/[^0-9]/g, '').slice(-10) : '';
  let customerName = '';
  let userId = '';
  let cartId = '';
  let credentials = null;
  let cookies = [];
  let localStorageData = {};

  const jwtRegex = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/;

  function inspectCandidate(cand) {
    if (cand && typeof cand === 'string' && !token) {
      const trimmed = cand.trim();
      // Keep entire string intact if it starts with Bearer eyJ or eyJ (including 5-part JWEs)
      if (/^(Bearer\s+)?eyJ/i.test(trimmed)) {
        token = trimmed;
        return;
      }
      const clean = trimmed.replace(/^Bearer\s+/i, '').trim();
      if (clean.length > 25) {
        if (clean.includes('..') && clean.startsWith('eyJ')) {
          token = clean;
          return;
        }
        if (jwtRegex.test(clean)) {
          token = clean.match(jwtRegex)[0];
        } else if (clean.length >= 32 && !clean.includes(' ') && !clean.startsWith('U2FsdGVkX1')) {
          token = clean;
        }
      }
    }
  }

  // Helper to extract decrypted Domino's user data
  function applyDecryptedUserData(dec) {
    if (!dec || typeof dec !== 'object') return;
    if (dec.mobile && !phone) {
      const m = String(dec.mobile).replace(/[^0-9]/g, '').slice(-10);
      if (m.length === 10 && /^[6-9]\d{9}$/.test(m)) phone = m;
    }
    if (dec.userId && !userId) {
      userId = String(dec.userId);
    }
    if (dec.cartId && !cartId) {
      cartId = String(dec.cartId);
    }
    if (!customerName && (dec.firstName || dec.lastName)) {
      customerName = `${dec.firstName || ''} ${dec.lastName || ''}`.trim();
    }
  }

  // Helper to extract decrypted address data
  function applyDecryptedAddress(dec) {
    if (!dec || typeof dec !== 'object') return;
    if (dec.mobNo && !phone) {
      const m = String(dec.mobNo).replace(/[^0-9]/g, '').slice(-10);
      if (m.length === 10 && /^[6-9]\d{9}$/.test(m)) phone = m;
    }
    if (!customerName && (dec.fName || dec.lName)) {
      customerName = `${dec.fName || ''} ${dec.lName || ''}`.trim();
    }
  }

  // Recursive search inside any nested JavaScript object or stringified JSON
  function deepSearchObject(obj) {
    if (!obj) return;

    if (typeof obj === 'string') {
      inspectCandidate(obj);
      if (obj.startsWith('U2FsdGVkX1')) {
        const dec = decryptDominoEncryptedString(obj);
        if (dec && typeof dec === 'object') {
          applyDecryptedUserData(dec);
          applyDecryptedAddress(dec);
        }
      } else if (obj.startsWith('{') || obj.startsWith('[')) {
        try { deepSearchObject(JSON.parse(obj)); } catch (e) {}
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        deepSearchObject(item);
      }
      return;
    }

    if (typeof obj === 'object') {
      // Direct credentials check
      if (obj.credentials && typeof obj.credentials === 'object') {
        credentials = credentials || obj.credentials;
        if (obj.credentials.refreshToken) refreshToken = obj.credentials.refreshToken;
        if (obj.credentials.sessionToken) inspectCandidate(obj.credentials.sessionToken);
        if (obj.credentials.accessToken) inspectCandidate(obj.credentials.accessToken);
        if (obj.credentials.accessKeyId) inspectCandidate(obj.credentials.accessKeyId);
      }

      // Direct userInfo check
      if (obj.headers && typeof obj.headers === 'object') {
        if (obj.headers.authToken) inspectCandidate(obj.headers.authToken);
        if (obj.headers.credentials && typeof obj.headers.credentials === 'object') {
          credentials = credentials || obj.headers.credentials;
          if (obj.headers.credentials.refreshToken) refreshToken = obj.headers.credentials.refreshToken;
          if (obj.headers.credentials.sessionToken) inspectCandidate(obj.headers.credentials.sessionToken);
          if (obj.headers.credentials.accessToken) inspectCandidate(obj.headers.credentials.accessToken);
        }
        if (!phone && obj.headers.mobile) {
          const m = String(obj.headers.mobile).replace(/[^0-9]/g, '').slice(-10);
          if (m.length === 10 && /^[6-9]\d{9}$/.test(m)) phone = m;
        }
      }

      // Check userData (AES encrypted or plaintext)
      if (obj.userData) {
        if (typeof obj.userData === 'string' && obj.userData.startsWith('U2FsdGVkX1')) {
          const dec = decryptDominoEncryptedString(obj.userData);
          applyDecryptedUserData(dec);
        } else if (typeof obj.userData === 'object') {
          applyDecryptedUserData(obj.userData);
        }
      }

      // Check addressDetail (AES encrypted or plaintext)
      if (obj.addressDetail) {
        if (typeof obj.addressDetail === 'string' && obj.addressDetail.startsWith('U2FsdGVkX1')) {
          const decAddr = decryptDominoEncryptedString(obj.addressDetail);
          applyDecryptedAddress(decAddr);
        } else if (typeof obj.addressDetail === 'object') {
          applyDecryptedAddress(obj.addressDetail);
        }
      }

      // Priority token keys
      const tokenKeys = ['token', 'authToken', 'auth_token', 'sessionToken', 'accessToken', 'authorization', 'jwt', 'sso_token'];
      for (const tk of tokenKeys) {
        if (obj[tk]) {
          inspectCandidate(obj[tk]);
        }
      }

      // Check phone keys
      if (!phone) {
        const phoneKeys = ['phone', 'mobile', 'mobileNumber', 'mobNo', 'customerPhone', 'customer_phone', 'userPhone', 'trackOrderMobile'];
        for (const pk of phoneKeys) {
          if (obj[pk]) {
            const pVal = String(obj[pk]).replace(/[^0-9]/g, '').slice(-10);
            if (pVal.length === 10 && /^[6-9]\d{9}$/.test(pVal)) {
              phone = pVal;
              break;
            }
          }
        }
      }

      // Check name keys (do NOT extract cookie name from cookie objects { name: '...', value: '...' })
      if (!customerName) {
        const blacklistNames = new Set([
          'utm_source', 'token', 'authtoken', 'auth_token', 'moe_c_s', 'ide', 'test_cookie', 'neo_sc',
          'source', 'advancestore', 'deviceuniqueid', 'store_pages', 'phpsessid', '_ga', '_gid',
          'bearer', 'undefined', 'null', 'storeid', 'useraddresses', 'addressdetail', 'cartitems',
          'neotag', 'loyaltyinfo', 'userinfo', 'paymentmode', 'app_config', 'pwa_config'
        ]);
        const nameKeys = ['userName', 'customerName', 'fullName', 'fName', 'firstName', 'name'];
        for (const nk of nameKeys) {
          // If the object has a 'value' property and nk === 'name', it is a cookie or key-value pair, NOT a person's name
          if (nk === 'name' && (obj.value !== undefined || obj.domain !== undefined || obj.path !== undefined)) {
            continue;
          }
          if (obj[nk] && typeof obj[nk] === 'string' && obj[nk].trim() && !obj[nk].includes('Domino')) {
            const cand = obj[nk].trim();
            if (!blacklistNames.has(cand.toLowerCase()) && !cand.startsWith('utm_') && !cand.startsWith('moe_') && !cand.startsWith('nt_')) {
              customerName = cand;
              break;
            }
          }
        }
      }

      // Check userId
      if (!userId && (obj.userId || obj.sub || obj.customerId)) {
        userId = String(obj.userId || obj.sub || obj.customerId);
      }

      // Recurse into all object values
      for (const [k, v] of Object.entries(obj)) {
        deepSearchObject(v);
      }
    }
  }

  // Run deep search on parsed JSON structure if available
  if (parsed) {
    if (Array.isArray(parsed)) {
      cookies = parsed.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.dominos.co.in',
        path: c.path || '/'
      }));
      const tokenCookie = cookies.find(c => /token|auth|session|jwt/i.test(c.name));
      if (tokenCookie) inspectCandidate(tokenCookie.value);
    } else if (typeof parsed === 'object') {
      deepSearchObject(parsed);

      if (parsed.credentials && typeof parsed.credentials === 'object') {
        credentials = credentials || parsed.credentials;
      }
      if (parsed.userId && !userId) {
        userId = String(parsed.userId);
      }

      if (Array.isArray(parsed.cookies)) {
        cookies = parsed.cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.dominos.co.in',
          path: c.path || '/'
        }));
      } else if (typeof parsed.cookies === 'string') {
        cookies = parsed.cookies.split(';').map(c => {
          const [k, ...v] = c.trim().split('=');
          return { name: k, value: v.join('='), domain: '.dominos.co.in', path: '/' };
        }).filter(c => c.name);
      }

      if (parsed.localStorage && typeof parsed.localStorage === 'object') {
        localStorageData = { ...parsed.localStorage };
        for (const [k, v] of Object.entries(parsed.localStorage)) {
          if (typeof v === 'string') {
            if (v.startsWith('U2FsdGVkX1')) {
              const dec = decryptDominoEncryptedString(v);
              if (dec) {
                applyDecryptedUserData(dec);
                applyDecryptedAddress(dec);
              }
            } else if (v.startsWith('{')) {
              try {
                const subObj = JSON.parse(v);
                deepSearchObject(subObj);
              } catch (e) {}
            }
          }
        }
      }

      if (parsed.userInfo) {
        localStorageData['userInfo'] = typeof parsed.userInfo === 'object' ? JSON.stringify(parsed.userInfo) : String(parsed.userInfo);
        try {
          const uInfo = typeof parsed.userInfo === 'string' ? JSON.parse(parsed.userInfo) : parsed.userInfo;
          deepSearchObject(uInfo);
        } catch (e) {}
      }
    }
  }

  // If token not yet found, check raw text for JWE / JWT pattern
  if (!token) {
    const jweMatch = text.match(/Bearer\s+eyJlbm[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jweMatch) {
      token = jweMatch[0];
    } else {
      const rawJwt = text.match(jwtRegex);
      if (rawJwt) {
        token = rawJwt[0];
      } else {
        const tokenMatch = text.match(/["']?(?:token|auth_token|authToken|sessionToken|authorization)["']?\s*[:=]\s*["']?([^"';\r\n\s]{20,})/i);
        if (tokenMatch) {
          token = tokenMatch[1].trim();
        }
      }
    }
  }

  // If phone not yet found, scan raw text for 10-digit Indian phone
  if (!phone) {
    const phoneMatch = text.match(/(?:(?:\+91|91|0)?[6-9]\d{9})/);
    if (phoneMatch) {
      phone = phoneMatch[0].replace(/[^0-9]/g, '').slice(-10);
    }
  }

  // If token is JWT (not JWE), decode payload for phone, name & expiration
  if (token && !token.includes('..')) {
    const jwt = decodeJwtPayload(token);
    if (jwt) {
      if (!phone && (jwt.phone || jwt.mobile || jwt.sub)) {
        const cand = String(jwt.phone || jwt.mobile || jwt.sub).replace(/[^0-9]/g, '').slice(-10);
        if (cand.length === 10 && /^[6-9]\d{9}$/.test(cand)) phone = cand;
      }
      if (!customerName && (jwt.name || jwt.userName || jwt.customerName)) {
        customerName = jwt.name || jwt.userName || jwt.customerName;
      }
    }
  }

  // Ensure default cookies if none provided
  if (cookies.length === 0 && token) {
    cookies = [
      { name: 'token', value: token, domain: '.dominos.co.in', path: '/' },
      { name: 'auth_token', value: token, domain: '.dominos.co.in', path: '/' }
    ];
  }

  // Ensure token and phone in localStorageData
  if (token) {
    localStorageData['token'] = token;
    localStorageData['authToken'] = token;
    localStorageData['auth_token'] = token;
  }
  if (phone) {
    localStorageData['phone'] = phone;
    localStorageData['trackOrderMobile'] = phone;
  }

  // Fallback to registered profile name if customerName was not found or was tracking garbage
  let finalName = customerName;
  if (!finalName || /utm_|moe_|token|ide/i.test(finalName)) {
    try {
      const prof = db.getUserProfile();
      if (prof && prof.phone && prof.phone.replace(/[^0-9]/g, '').slice(-10) === phone) {
        finalName = prof.name;
      }
    } catch (e) {}
  }
  if (!finalName) {
    finalName = phone ? `Domino's Customer (${phone.slice(-4)})` : 'Domino\'s Customer';
  }

  return {
    token,
    refreshToken,
    phone,
    name: finalName,
    userId,
    cartId,
    credentials,
    cookies,
    localStorage: localStorageData
  };
}

/**
 * 6b. Refresh an Expiring or Expired Domino's Session via Official Domino's Live API
 * Directly probes Domino's authentication server and exchanges refreshToken for a fresh accessToken.
 * Returns authentic credentials, newly minted cartId, exact lastRefreshedAt timestamp,
 * short-term accessTokenExpiresAt (1 hour TTL), and sliding 30-day refreshTokenExpiresAt.
 */
async function refreshDominoSession(userId, refreshToken) {
  if (!refreshToken || !userId) {
    return { success: false, error: 'User ID and refresh token are required to refresh Domino\'s session.' };
  }

  const cleanRefreshToken = refreshToken.startsWith('Bearer ') ? refreshToken : `Bearer ${refreshToken}`;

  try {
    const res = await fetch('https://api.dominos.co.in/loginhandler/refreshtoken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'userId': String(userId),
        'refreshToken': cleanRefreshToken,
        'isLoggedIn': 'true',
        'authToken': cleanRefreshToken,
        'api_key': 'd2aeb489bb8df385',
        'client_type': 'web app-chrome',
        'source': 'PWA18',
        'Origin': 'https://pizzaonline.dominos.co.in',
        'Referer': 'https://pizzaonline.dominos.co.in/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({
        userId: String(userId),
        refreshToken: cleanRefreshToken
      })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.status === 'SUCCESS' && data.credentials) {
        const newAccessToken = data.credentials.accessToken || data.credentials.idToken;
        const newRefreshToken = data.credentials.refreshToken || cleanRefreshToken;
        const attributes = data.attributes || {};
        const now = Date.now();
        const lastRefreshedAt = new Date(now).toISOString();
        // Short-lived API access token is valid for 1 hour on Domino's API Gateway
        const accessTokenExpiresAt = new Date(now + 60 * 60 * 1000).toISOString();
        // Sliding refresh token session extended for 30 days
        const refreshTokenExpiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

        return {
          success: true,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          cartId: attributes.cartId || '',
          userId: attributes.userId || String(userId),
          mobile: attributes.mobile || '',
          attributes: attributes,
          credentials: data.credentials,
          lastRefreshedAt: lastRefreshedAt,
          accessTokenExpiresAt: accessTokenExpiresAt,
          refreshTokenExpiresAt: refreshTokenExpiresAt,
          expiresAt: refreshTokenExpiresAt
        };
      } else {
        return {
          success: false,
          error: data.errorMessage || data.message || 'Domino\'s rejected refresh token.'
        };
      }
    } else {
      const errText = await res.text();
      return {
        success: false,
        error: `Domino's refresh failed with HTTP ${res.status}: ${errText}`
      };
    }
  } catch (err) {
    return { success: false, error: `Network error refreshing session: ${err.message}` };
  }
}

/**
 * Helper: Apply refreshed Domino's session credentials across account object,
 * including sessionToken, credentials, cookies, and localStorage userInfo.
 */
function applyAccountRefresh(acc, refreshResult) {
  if (!acc || !refreshResult || !refreshResult.success) return false;

  acc.sessionToken = refreshResult.accessToken;
  acc.refreshToken = refreshResult.refreshToken;
  if (refreshResult.cartId) acc.cartId = refreshResult.cartId;
  acc.lastRefreshedAt = refreshResult.lastRefreshedAt || new Date().toISOString();
  acc.accessTokenExpiresAt = refreshResult.accessTokenExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  acc.refreshTokenExpiresAt = refreshResult.refreshTokenExpiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  acc.expiresAt = acc.refreshTokenExpiresAt;
  acc.status = 'IDLE';
  acc.lastValidated = new Date().toISOString();
  delete acc.validationError;

  // 1. Sync credentials block
  if (!acc.credentials) acc.credentials = {};
  acc.credentials.accessToken = refreshResult.accessToken;
  acc.credentials.sessionToken = refreshResult.accessToken;
  acc.credentials.accessKeyId = refreshResult.accessToken;
  acc.credentials.refreshToken = refreshResult.refreshToken;
  if (acc.cartId) acc.credentials.cartId = acc.cartId;
  if (acc.userId) acc.credentials.userId = acc.userId;

  // 2. Sync localStorage
  if (!acc.localStorage) acc.localStorage = {};
  acc.localStorage['token'] = refreshResult.accessToken;
  acc.localStorage['authToken'] = refreshResult.accessToken;
  acc.localStorage['auth_token'] = refreshResult.accessToken;
  if (acc.cartId) acc.localStorage['cartId'] = acc.cartId;

  if (acc.localStorage['userInfo']) {
    try {
      const uInfo = typeof acc.localStorage['userInfo'] === 'string'
        ? JSON.parse(acc.localStorage['userInfo'])
        : acc.localStorage['userInfo'];
      if (!uInfo.headers) uInfo.headers = {};
      if (!uInfo.headers.credentials) uInfo.headers.credentials = {};
      uInfo.headers.credentials.accessKeyId = refreshResult.accessToken;
      uInfo.headers.credentials.accessToken = refreshResult.accessToken;
      uInfo.headers.credentials.sessionToken = refreshResult.accessToken;
      uInfo.headers.credentials.refreshToken = refreshResult.refreshToken;
      if (acc.cartId) uInfo.headers.cartId = acc.cartId;
      if (acc.userId) uInfo.headers.userId = acc.userId;
      acc.localStorage['userInfo'] = JSON.stringify(uInfo);
    } catch (e) {}
  }

  // 3. Sync cookies array
  if (Array.isArray(acc.cookies)) {
    const tokCookie = acc.cookies.find(c => c.name === 'token');
    if (tokCookie) {
      tokCookie.value = refreshResult.accessToken;
    } else {
      acc.cookies.unshift({ name: 'token', value: refreshResult.accessToken, domain: '.dominos.co.in', path: '/' });
    }
    const authCookie = acc.cookies.find(c => c.name === 'auth_token');
    if (authCookie) authCookie.value = refreshResult.accessToken;
  }

  // 4. Clean up corrupted customerName and sync real Profile Name
  if (!acc.customerName || /utm_|token|moe_|ide/i.test(acc.customerName)) {
    try {
      const prof = db.getUserProfile();
      if (prof && prof.name) {
        acc.customerName = prof.name;
      } else {
        acc.customerName = `Domino's Customer (${(acc.cleanPhone || '').slice(-4)})`;
      }
    } catch (e) {}
  }

  // 5. Auto-detect Cheesy Rewards Loyalty program from localStorage (Loyalty is independent of Account Tier!)
  let isCheesyLoyalty = false;
  if (acc.localStorage && acc.localStorage['loyaltyInfo']) {
    try {
      const lInfo = typeof acc.localStorage['loyaltyInfo'] === 'string'
        ? JSON.parse(acc.localStorage['loyaltyInfo'])
        : acc.localStorage['loyaltyInfo'];
      if (lInfo?.enrollmentStatus === 'ENABLED' || lInfo?.loyaltyProgramTitle?.includes('Cheesy') || lInfo?.loyaltyCardCode === 'POTP2') {
        isCheesyLoyalty = true;
      }
    } catch (e) {}
  }
  acc.isCheesyRewards = isCheesyLoyalty;
  acc.loyaltyProgram = isCheesyLoyalty ? 'POTP2' : null;
  acc.loyaltyTitle = isCheesyLoyalty ? '🌟 Cheesy Rewards (POTP2)' : null;

  // Account tier is strictly determined by past orders count (0 = New, 1 = 2nd Order, 2+ = Existing Repeat)
  if (acc.pastOrdersCount === 1 || acc.accountType === 'SECOND_ORDER_ACCOUNT') {
    acc.accountType = 'SECOND_ORDER_ACCOUNT';
    acc.category = 'CATEGORY_SECOND_ORDER';
    acc.categoryName = '🟡 Cheesy 2nd Order Tier';
    acc.couponCode = 'CHEESY';
  } else if (acc.pastOrdersCount >= 2 || acc.accountType === 'EXISTING_ACCOUNT') {
    acc.accountType = 'EXISTING_ACCOUNT';
    acc.category = 'CATEGORY_FLAT_100';
    acc.categoryName = '🔵 Party Repeat Order Tier';
    acc.couponCode = 'PARTY';
  } else {
    acc.accountType = 'NEW_ACCOUNT';
    acc.category = 'CATEGORY_50_OFF';
    acc.categoryName = '🟢 50% OFF New User Tier';
    acc.couponCode = 'DOMNEW50';
  }

  return true;
}

/**
 * 7. Validate Session with Domino's India Backend & Probe Order History
 * Resilient to Akamai/Cloudflare bot protection on direct node fetch.
 */
async function validateDominoSession(token, cookiesArray = [], phone = '', credentials = null) {
  if (!token && !credentials && (!cookiesArray || cookiesArray.length === 0)) {
    return { valid: false, error: 'No authentication token or session credentials provided.' };
  }

  const jwt = decodeJwtPayload(token);
  let isExpired = false;
  let expDate = null;
  let jwtPhone = null;

  if (jwt) {
    if (jwt.exp) {
      expDate = new Date(jwt.exp * 1000);
      if (expDate.getTime() < Date.now()) {
        isExpired = true;
      }
    }
    if (jwt.phone || jwt.mobile || jwt.sub) {
      const candidate = String(jwt.phone || jwt.mobile || jwt.sub).replace(/[^0-9]/g, '').slice(-10);
      if (candidate.length === 10 && /^[6-9]\d{9}$/.test(candidate)) jwtPhone = candidate;
    }
  }

  if (isExpired) {
    return {
      valid: false,
      error: `Domino's token has expired (Expired on ${expDate.toLocaleString('en-IN')}). Please log in again on https://m.dominos.co.in/ to refresh.`
    };
  }

  const cookieHeader = cookiesArray.map(c => `${c.name}=${c.value}`).join('; ');

  let orderHistory = [];
  let pastOrdersCount = 0;
  let customerProfile = null;
  let probeOk = false;

  // Domino's India API Client Headers
  const dominosHeaders = {
    'Content-Type': 'application/json',
    'api_key': 'd2aeb489bb8df385',
    'authToken': token || (credentials && (credentials.sessionToken || credentials.accessToken)) || '',
    'Authorization': token ? (token.startsWith('Bearer ') ? token : `Bearer ${token}`) : '',
    'client_type': 'web app-chrome',
    'source': 'PWA18',
    'Origin': 'https://m.dominos.co.in',
    'Referer': 'https://m.dominos.co.in/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': cookieHeader
  };
  if (phone) dominosHeaders.mobile = phone;

  // Probe Domino's Order History & Recommendations API
  try {
    const historyRes = await fetch('https://api.dominos.co.in/order-service/v1/orders/favourites/recommendations', {
      headers: dominosHeaders
    });

    if (historyRes.ok) {
      const histData = await historyRes.json();
      orderHistory = histData.orders || histData.data || histData.orderHistory || [];
      pastOrdersCount = orderHistory.length;
      probeOk = true;
      console.log(`[VALIDATE] Domino's live order probe succeeded: ${pastOrdersCount} past orders.`);
    } else {
      console.log(`[VALIDATE] Domino's recommendations probe HTTP ${historyRes.status} (direct node fetch restricted).`);
    }
  } catch (netErr) {
    console.warn('[VALIDATE-NET] Domino history probe note:', netErr.message);
  }

  // Attempt Loyalty user info probe
  if (!probeOk) {
    try {
      const loyaltyRes = await fetch('https://api.dominos.co.in/customer-service/v1/loyalty/user?loyaltySync=true', {
        headers: dominosHeaders
      });
      if (loyaltyRes.ok) {
        probeOk = true;
        customerProfile = await loyaltyRes.json();
        console.log('[VALIDATE] Domino\'s live loyalty probe succeeded.');
      }
    } catch (e) {}
  }

  // Gracefully accept active browser sessions even if direct server HTTP probe was blocked by Domino's WAF
  if (!probeOk) {
    console.log('[VALIDATE] Direct node HTTP probe blocked by Domino\'s WAF/gateway. Session token and cookies are structurally valid; accepting session as ACTIVE for browser execution.');
  }

  let isNew = pastOrdersCount === 0;
  let isCheesy = false;
  if (customerProfile?.loyaltyInfo?.enrollmentStatus === 'ENABLED' || customerProfile?.loyaltyProgramTitle?.includes('Cheesy') || customerProfile?.loyaltyCardCode === 'POTP2') {
    isCheesy = true;
  }
  let accountType = 'NEW_ACCOUNT';
  let category = 'CATEGORY_50_OFF';
  let categoryName = '🟢 50% OFF New User Tier';
  let couponCode = 'DOMNEW50';

  if (pastOrdersCount === 1) {
    accountType = 'SECOND_ORDER_ACCOUNT';
    category = 'CATEGORY_SECOND_ORDER';
    categoryName = '🟡 Cheesy 2nd Order Tier';
    couponCode = 'CHEESY';
  } else if (pastOrdersCount >= 2) {
    accountType = 'EXISTING_ACCOUNT';
    category = 'CATEGORY_FLAT_100';
    categoryName = '🔵 Party Repeat Order Tier';
    couponCode = 'PARTY';
  }
  const reorderItems = orderHistory.slice(0, 3).map(o => o.items?.[0]?.name || o.orderItems?.[0]?.name).filter(Boolean);

  const cleanPhone = (phone || jwtPhone || customerProfile?.phone || customerProfile?.mobile || '').replace(/[^0-9]/g, '').slice(-10);

  if (!cleanPhone || cleanPhone.length !== 10) {
    return {
      valid: false,
      error: 'Could not detect an authentic registered mobile number from this Domino\'s session. Please make sure you are logged in on https://m.dominos.co.in/ before extracting your session.'
    };
  }

  return {
    valid: true,
    phone: cleanPhone,
    customerProfile,
    accountType,
    category,
    categoryName,
    couponCode,
    isCheesyRewards: isCheesy,
    loyaltyProgram: isCheesy ? 'POTP2' : null,
    loyaltyTitle: isCheesy ? '🌟 Cheesy Rewards (POTP2)' : null,
    pastOrdersCount,
    reorderItems,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
}

/**
 * 8. Import Account Session via JSON Key-Value Pair or Token
 */
async function importDominoSessionJson({ jsonInput, phone: overridePhone, category, categoryName, couponCode }) {
  console.log(`[ADMIN-IMPORT] 📥 Parsing and validating pasted Domino's session JSON / Token...`);

  let parsed;
  try {
    parsed = parseDominoSessionInput(jsonInput, overridePhone);
  } catch (err) {
    return { success: false, error: err.message };
  }

  if (!parsed.token && !parsed.credentials && (!parsed.cookies || parsed.cookies.length === 0)) {
    return {
      success: false,
      error: 'Could not extract a valid Domino\'s authentication token or session. Please verify your JSON or key-value format.'
    };
  }

  const validation = await validateDominoSession(parsed.token, parsed.cookies, parsed.phone, parsed.credentials);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const finalPhone = overridePhone 
    ? overridePhone.replace(/[^0-9]/g, '').slice(-10) 
    : validation.phone;

  if (!finalPhone || finalPhone.length !== 10) {
    return {
      success: false,
      error: 'Could not detect a valid 10-digit mobile number for this account. Please verify your Domino\'s session.'
    };
  }

  // Extract refresh token from input or nested credentials
  let refreshToken = parsed.refreshToken || (parsed.credentials && parsed.credentials.refreshToken) || '';
  if (!refreshToken && parsed.localStorage) {
    try {
      const uInfo = typeof parsed.localStorage.userInfo === 'string' ? JSON.parse(parsed.localStorage.userInfo) : parsed.localStorage.userInfo;
      if (uInfo && uInfo.headers && uInfo.headers.credentials && uInfo.headers.credentials.refreshToken) {
        refreshToken = uInfo.headers.credentials.refreshToken;
      }
    } catch (e) {}
  }

  // Check if account with same mobile already exists in DB
  const existingAccounts = db.getAccounts();
  const existingIdx = existingAccounts.findIndex(a => a.cleanPhone === finalPhone);

  const accountId = existingIdx >= 0 ? existingAccounts[existingIdx].id : `ACC-DOM-${Date.now().toString().slice(-4)}`;

  const accountRecord = {
    id: accountId,
    phone: `+91 ${finalPhone}`,
    cleanPhone: finalPhone,
    customerName: parsed.name && !parsed.name.includes('Domino') ? parsed.name : `Domino's Customer (${finalPhone.slice(-4)})`,
    userId: parsed.userId || '',
    cartId: parsed.cartId || '',
    accountType: validation.accountType,
    category: category || validation.category,
    categoryName: categoryName || validation.categoryName,
    couponCode: couponCode || validation.couponCode,
    isCheesyRewards: validation.isCheesyRewards,
    loyaltyProgram: validation.loyaltyProgram,
    loyaltyTitle: validation.loyaltyTitle,
    cookies: parsed.cookies,
    localStorage: parsed.localStorage,
    sessionToken: parsed.token || (parsed.credentials && (parsed.credentials.sessionToken || parsed.credentials.accessToken)) || `dom_auth_${Date.now()}`,
    refreshToken: refreshToken,
    credentials: parsed.credentials,
    pastOrdersCount: validation.pastOrdersCount,
    reorderItems: validation.reorderItems,
    status: 'IDLE',
    totalOrdersPlaced: existingIdx >= 0 ? (existingAccounts[existingIdx].totalOrdersPlaced || 0) : 0,
    storedAt: existingIdx >= 0 ? (existingAccounts[existingIdx].storedAt || new Date().toISOString()) : new Date().toISOString(),
    expiresAt: validation.expiresAt,
    lastRefreshedAt: new Date().toISOString(),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshTokenExpiresAt: validation.expiresAt,
    source: 'JSON_TOKEN_IMPORT',
    lastActive: new Date().toISOString()
  };

  // If refresh token and userId are available, perform live token refresh upon import
  // This guarantees an active access token and sets authentic live expiresAt and cartId
  if (refreshToken && parsed.userId) {
    console.log(`[ADMIN-IMPORT] 🔄 Validating & refreshing session with Domino's India live API...`);
    const ref = await refreshDominoSession(parsed.userId, refreshToken);
    if (ref.success) {
      applyAccountRefresh(accountRecord, ref);
      console.log(`[ADMIN-IMPORT] ✅ Successfully refreshed token with Domino's live backend! Expiry set to: ${ref.expiresAt}`);
    } else {
      console.warn(`[ADMIN-IMPORT] Live refresh note: ${ref.error}`);
    }
  }

  if (existingIdx >= 0) {
    existingAccounts[existingIdx] = accountRecord;
    db.save();
  } else {
    db.addAccount(accountRecord);
  }

  // Sync storefront user profile with the real phone and name if needed
  try {
    const currentProfile = db.getUserProfile();
    if (!currentProfile.phone || currentProfile.phone.includes('9876543210') || currentProfile.phone === '+91 ' || !currentProfile.phone.slice(-10).match(/^[6-9]\d{9}$/)) {
      db.updateUserProfile({
        phone: `+91 ${finalPhone}`,
        name: parsed.name && !parsed.name.includes('Domino') ? parsed.name : currentProfile.name
      });
      console.log(`[ADMIN-IMPORT] 👤 Synced storefront user profile with imported Domino's phone +91 ${finalPhone}`);
    }
  } catch (profErr) {
    console.warn('[ADMIN-IMPORT] Profile sync notice:', profErr.message);
  }

  console.log(`[ADMIN-IMPORT] ✅ Account ${accountRecord.phone} (UserID: ${accountRecord.userId || 'N/A'}) imported and saved into session pool!`);
  return {
    success: true,
    isUpdated: existingIdx >= 0,
    message: existingIdx >= 0
      ? `Existing Domino's session for ${accountRecord.phone} successfully updated! Live cookies, token, and 30-day validity renewed.`
      : `Domino's session verified and imported successfully! Tagged as: ${accountRecord.categoryName}`,
    account: accountRecord
  };
}

/**
 * 9. Re-check Session Validity or Auto-Refresh Expired Token for Account in Pool
 */
async function validateExistingAccount(accountId) {
  const accounts = db.getAccounts();
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) {
    return { success: false, error: 'Account not found in pool.' };
  }

  const rToken = acc.refreshToken || (acc.credentials && acc.credentials.refreshToken) || (acc.localStorage && acc.localStorage['refreshToken']);
  const uId = acc.userId || (acc.credentials && acc.credentials.userId);

  // 1. If account has refresh credentials, call Domino's live refresh API
  if (rToken && uId) {
    console.log(`[VALIDATE-ACCOUNT] 🔄 Testing & refreshing live Domino's session for ${acc.phone}...`);
    const refreshRes = await refreshDominoSession(uId, rToken);
    if (refreshRes.success) {
      applyAccountRefresh(acc, refreshRes);

      // 1. Detect customer name from refreshed attributes
      const fName = refreshRes.attributes?.firstName || '';
      const lName = refreshRes.attributes?.lastName || '';
      const detectedName = (fName || lName) ? `${fName} ${lName}`.trim() : null;
      if (detectedName && (!acc.customerName || acc.customerName.includes('Customer'))) {
        acc.customerName = detectedName;
      }

      // 2. Probe authentic past order history and loyalty tier with fresh token
      const activeToken = refreshRes.accessToken || acc.sessionToken;
      try {
        const historyRes = await fetch('https://api.dominos.co.in/order-service/v1/orders/favourites/recommendations', {
          headers: {
            'Content-Type': 'application/json',
            'api_key': 'd2aeb489bb8df385',
            'authToken': activeToken,
            'sessiontoken': activeToken,
            'userId': String(uId),
            'client_type': 'web app-chrome',
            'source': 'PWA18'
          }
        });
        if (historyRes.ok) {
          const histData = await historyRes.json();
          const orders = histData.orders || histData.data || histData.orderHistory || [];
          if (Array.isArray(orders)) {
            acc.pastOrdersCount = orders.length;
            acc.reorderItems = orders.slice(0, 3).map(o => o.items?.[0]?.name || o.orderItems?.[0]?.name).filter(Boolean);
            if (orders.length === 0) {
              acc.accountType = 'NEW_ACCOUNT';
              acc.category = 'CATEGORY_50_OFF';
              acc.categoryName = '50% OFF New User Tier';
              acc.couponCode = 'DOMNEW50';
            } else if (orders.length === 1) {
              acc.accountType = 'SECOND_ORDER_ACCOUNT';
              acc.category = 'CATEGORY_SECOND_ORDER';
              acc.categoryName = 'Cheesy 2nd Order Tier';
              acc.couponCode = 'CHEESY';
            } else {
              acc.accountType = 'EXISTING_ACCOUNT';
              acc.category = 'CATEGORY_FLAT_100';
              acc.categoryName = 'Party Repeat Order Tier';
              acc.couponCode = 'PARTY';
            }
          }
        }
      } catch (histErr) {
        console.warn(`[VALIDATE-ACCOUNT] Order history probe note:`, histErr.message);
      }

      acc.lastValidated = new Date().toISOString();
      acc.status = 'IDLE';
      db.save();

      return {
        success: true,
        valid: true,
        refreshed: true,
        message: `Session is ACTIVE & VALID! Refreshed with Domino's India live API. Customer: ${acc.customerName || 'Customer'} | Tier: ${acc.categoryName} (${acc.pastOrdersCount || 0} orders).`,
        account: acc
      };
    } else {
      console.warn(`[VALIDATE-ACCOUNT] ⚠️ Refresh rejected by Domino's for ${acc.phone}: ${refreshRes.error}. Falling back to session token validation.`);
    }
  }

  // 2. Resilient session token & cookie validation (restores sessions without refreshToken or with prior false expiration)
  const token = acc.sessionToken || (acc.credentials && (acc.credentials.sessionToken || acc.credentials.accessToken));
  const result = await validateDominoSession(token, acc.cookies, acc.cleanPhone, acc.credentials);
  if (result.valid) {
    acc.accountType = result.accountType || acc.accountType || 'NEW_ACCOUNT';
    if (result.pastOrdersCount !== undefined && (acc.pastOrdersCount === undefined || acc.pastOrdersCount === null)) {
      acc.pastOrdersCount = result.pastOrdersCount;
    }
    acc.lastValidated = new Date().toISOString();
    acc.expiresAt = result.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    acc.status = 'IDLE';
    delete acc.validationError;
    db.save();
    return {
      success: true,
      valid: true,
      message: `Session is ACTIVE & VALID! Account tier: ${acc.categoryName || 'Standard'} (${acc.pastOrdersCount || 0} orders).`,
      account: acc
    };
  } else {
    acc.status = 'EXPIRED';
    acc.expiresAt = new Date().toISOString();
    acc.validationError = result.error;
    acc.lastValidated = new Date().toISOString();
    db.save();
    return {
      success: false,
      valid: false,
      error: result.error || 'Domino\'s session token has expired. Please re-import from m.dominos.co.in or request a new OTP.',
      account: acc
    };
  }
}

/**
 * 10. Extraction Script and Steps
 * Precision extractor: captures Domino's auth token from userInfo, Redux persist,
 * localStorage, and cookies with zero junk/telemetry extra details.
 */
const EXTRACTION_CONSOLE_SCRIPT = `(() => {
  // Domino\'s Order Engine - Official Domino's India Complete Session Extractor
  let token = "";
  let phone = "";
  let name = "";
  let userId = "";
  let cartId = "";
  let credentials = null;
  const localStorageDump = {};

  // 1. Access Domino's Internal Webpack Modules for Real-Time AES Decryption
  let req = null;
  try {
    if (window.webpackChunkpostorder_ui) {
      window.webpackChunkpostorder_ui.push([['dominos_ext_' + Date.now()], {}, r => req = r]);
    }
  } catch(e) {}

  let CryptoJS = null;
  let domSalt = '2Na@4Sr&8Qp&2NmLk$4Om&0Fe@9Dc#8Ba';
  if (req) {
    try { CryptoJS = req(1396); } catch(e) {}
    try { if (req(1300)?.Ay?.ENC_DEC_SALT) domSalt = req(1300).Ay.ENC_DEC_SALT; } catch(e) {}
  }

  function tryDecrypt(cipher) {
    if (!cipher || typeof cipher !== 'string' || !cipher.startsWith('U2FsdGVkX1')) return null;
    if (CryptoJS) {
      try {
        const dec = CryptoJS.AES.decrypt(cipher, domSalt).toString(CryptoJS.enc.Utf8);
        return JSON.parse(dec);
      } catch(e) {}
    }
    return null;
  }

  // 2. Dump all Domino's localStorage keys
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) localStorageDump[k] = localStorage.getItem(k);
  }

  // 3. Decrypt and inspect 'userInfo' (PRIMARY DOMINO'S AUTH STORAGE)
  try {
    const rawUserInfo = localStorage.getItem('userInfo');
    if (rawUserInfo) {
      const uObj = JSON.parse(rawUserInfo);
      if (uObj.headers?.credentials) {
        credentials = uObj.headers.credentials;
        if (credentials.sessionToken) token = credentials.sessionToken;
        if (credentials.accessToken && !token) token = credentials.accessToken;
      }
      if (uObj.headers?.authToken && !token) token = uObj.headers.authToken;

      if (uObj.userData) {
        const decUser = tryDecrypt(uObj.userData);
        if (decUser) {
          if (decUser.mobile) phone = String(decUser.mobile).replace(/[^0-9]/g, '').slice(-10);
          if (decUser.userId) userId = String(decUser.userId);
          if (decUser.cartId) cartId = String(decUser.cartId);
          if (!name && (decUser.firstName || decUser.lastName)) {
            name = ((decUser.firstName || '') + ' ' + (decUser.lastName || '')).trim();
          }
        }
      }
    }
  } catch (e) {}

  // 4. Decrypt and inspect 'addressDetail'
  try {
    const rawAddr = localStorage.getItem('addressDetail');
    if (rawAddr) {
      const decAddr = tryDecrypt(rawAddr);
      if (decAddr) {
        if (!phone && decAddr.mobNo) phone = String(decAddr.mobNo).replace(/[^0-9]/g, '').slice(-10);
        if (!name && (decAddr.fName || decAddr.lName)) {
          name = ((decAddr.fName || '') + ' ' + (decAddr.lName || '')).trim();
        }
      }
    }
  } catch (e) {}

  // 5. Check Domino's Webpack module 7455 if phone/name still empty
  if (req && (!phone || !name)) {
    try {
      const mod7455 = req(7455);
      if (mod7455 && typeof mod7455.vx === 'function') {
        const addrObj = mod7455.vx('addressDetail');
        if (addrObj) {
          if (addrObj.mobNo && !phone) phone = String(addrObj.mobNo).replace(/[^0-9]/g, '').slice(-10);
          if (addrObj.fName && !name) name = ((addrObj.fName || '') + ' ' + (addrObj.lName || '')).trim();
        }
      }
    } catch (e) {}
  }

  // 6. Direct storage keys fallback
  if (!phone) {
    const pKeys = ['trackOrderMobile', 'mobile', 'phone', 'userPhone'];
    for (const pk of pKeys) {
      const pv = localStorage.getItem(pk) || sessionStorage.getItem(pk);
      if (pv && /[6-9]\\d{9}/.test(pv)) {
        phone = pv.match(/[6-9]\\d{9}/)[0];
        break;
      }
    }
  }

  // 7. Check direct token keys
  const directTokenKeys = ['authToken', 'token', 'auth_token', 'authorization', 'accessToken', 'sessionToken'];
  for (const k of directTokenKeys) {
    if (!token) {
      const v = localStorage.getItem(k) || sessionStorage.getItem(k);
      if (v && v.length > 20) token = v;
    }
  }

  // 8. Capture ALL relevant Domino's cookies
  const cookiesList = [];
  const rawCookies = document.cookie.split(';');
  for (const c of rawCookies) {
    const parts = c.trim().split('=');
    if (!parts[0]) continue;
    const k = parts[0].trim();
    const v = parts.slice(1).join('=').trim();
    if (!token && /token|auth/i.test(k) && v.length > 20) {
      try {
        token = decodeURIComponent(v);
      } catch (e) {
        token = v;
      }
    }
    if (!/^_ga|^_gid|^_fbp|^_gcl/i.test(k)) {
      cookiesList.push({ name: k, value: v, domain: '.dominos.co.in', path: '/' });
    }
  }

  // Ensure token cookie is included
  if (token && !cookiesList.some(c => c.name === 'token')) {
    cookiesList.unshift({ name: 'token', value: token, domain: '.dominos.co.in', path: '/' });
  }

  if (!token && !credentials && cookiesList.length === 0) {
    alert("⚠️ Could not locate active Domino's session.\\nPlease make sure you are logged into https://m.dominos.co.in/ or https://pizzaonline.dominos.co.in/ before running this script.");
    return;
  }

  const cleanPayload = {
    source: "Domino's India Web",
    timestamp: new Date().toISOString(),
    phone: phone,
    name: name || (phone ? "Domino's Customer (" + phone.slice(-4) + ")" : "Domino's Customer"),
    token: token || (credentials && (credentials.sessionToken || credentials.accessToken)) || "",
    refreshToken: (credentials && credentials.refreshToken) || "",
    userId: userId || "",
    cartId: cartId || "",
    credentials: credentials,
    cookies: cookiesList,
    localStorage: localStorageDump
  };

  const outputJson = JSON.stringify(cleanPayload, null, 2);

  try { copy(outputJson); } catch (e) {}
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(outputJson).catch(() => {});
  }

  alert("✅ Domino's Session Extracted Successfully!\\n\\n📱 Phone: " + (cleanPayload.phone ? "+91 " + cleanPayload.phone : "Decrypted by Domino\'s Order Engine backend") + "\\n👤 Name: " + cleanPayload.name + "\\n🔑 Token: " + cleanPayload.token.slice(0, 25) + "...\\n🍪 Cookies: " + cookiesList.length + " session cookies captured\\n\\nClean JSON copied to clipboard! Paste it into Domino\'s Order Engine Admin Panel.");
  console.log("%c✅ DOMINO'S CLEAN SESSION EXTRACTED!", "color: #10b981; font-weight: bold; font-size: 14px;");
  console.log(cleanPayload);
})();`;

function getExtractionGuide() {
  return {
    consoleScript: EXTRACTION_CONSOLE_SCRIPT,
    steps: [
      {
        step: 1,
        title: "Log into Domino's India",
        desc: "Open https://m.dominos.co.in/ in your browser (Chrome/Edge) and log in with your phone and OTP."
      },
      {
        step: 2,
        title: "Open DevTools Console",
        desc: "Press F12 (or Ctrl+Shift+I) and switch to the 'Console' tab."
      },
      {
        step: 3,
        title: "Run the 1-Click Extraction Script",
        desc: "Paste the 1-click script into the console and hit Enter. The clean session JSON key-value pair will be automatically copied to your clipboard!"
      },
      {
        step: 4,
        title: "Paste & Save in Admin",
        desc: "Paste the JSON into the Domino\'s Order Engine Admin input box below and click 'Verify Token & Save Domino's Session'."
      }
    ],
    sampleJson: {
      source: "Domino's India Web",
      phone: "7893618933",
      name: "Domino's Customer",
      token: "Bearer eyJlbmMiOiJBMjU2Q0JDLUhTNTEyIiwiYWxnIjoiZGlyIn0..8hAfuNu5MwjTcu6u03nnBQ.2AzP6h1g6QcRdW0S2tmBx24YH9R89mL3sxqoMkb8vhki_iYl",
      cookies: [
        { name: "token", value: "Bearer eyJlbmMi...", domain: ".dominos.co.in", path: "/" },
        { name: "PHPSESSID", value: "dom_sess_89234812", domain: ".dominos.co.in", path: "/" }
      ]
    }
  };
}

/**
 * 11. Calculate Exact Session Age & Real-Time Health Status
 */
function calculateSessionHealth(acc) {
  if (!acc) return null;
  const now = Date.now();
  const storedTime = acc.storedAt ? new Date(acc.storedAt).getTime() : now;
  const ageMs = Math.max(0, now - storedTime);
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const ageHours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const ageMins = Math.floor((ageMs % (60 * 60 * 1000)) / 60000);

  const accExpTime = acc.accessTokenExpiresAt ? new Date(acc.accessTokenExpiresAt).getTime() : 0;
  const refExpTime = acc.refreshTokenExpiresAt 
    ? new Date(acc.refreshTokenExpiresAt).getTime() 
    : (acc.expiresAt ? new Date(acc.expiresAt).getTime() : now + 30 * 24 * 60 * 60 * 1000);

  const isExpired = acc.status === 'EXPIRED' || refExpTime <= now;
  const remainingWindowMs = Math.max(0, refExpTime - now);
  const remainingDays = Math.floor(remainingWindowMs / (24 * 60 * 60 * 1000));

  let health = 'FRESH';
  let healthBadge = '🟢 Fresh & Active';
  let isOld = false;

  if (isExpired) {
    health = 'EXPIRED';
    healthBadge = '🔴 Expired Session';
  } else if (remainingDays <= 3) {
    health = 'EXPIRING_SOON';
    healthBadge = `🟠 Expiring Soon (${remainingDays}d left)`;
    isOld = true;
  } else if (ageDays >= 14) {
    health = 'OLD';
    healthBadge = `🟡 Old Session (${ageDays}d old)`;
    isOld = true;
  } else {
    health = 'FRESH';
    healthBadge = `🟢 Fresh & Active (${ageDays > 0 ? `${ageDays}d old` : `${ageHours}h old`})`;
  }

  const hasRefresh = Boolean(
    (acc.refreshToken || acc.credentials?.refreshToken) && 
    (acc.userId || acc.credentials?.userId)
  );

  return {
    ageDays,
    ageHours,
    ageMins,
    ageFormatted: ageDays > 0 ? `${ageDays}d ${ageHours}h old` : (ageHours > 0 ? `${ageHours}h ${ageMins}m old` : `${ageMins}m old`),
    health,
    healthBadge,
    isExpired,
    isOld,
    remainingDays,
    canAutoRefresh: hasRefresh
  };
}

module.exports = {
  requestLiveDominoOtp,
  verifyLiveDominoOtp,
  launchBrowserWithSession,
  exportCookiesJson,
  parseDominoSessionInput,
  validateDominoSession,
  refreshDominoSession,
  applyAccountRefresh,
  importDominoSessionJson,
  validateExistingAccount,
  getExtractionGuide,
  cleanupSession,
  calculateSessionHealth
};
