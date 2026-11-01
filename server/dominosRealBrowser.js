const { chromium } = require('playwright-core');
const path = require('path');
const proxyService = require('./proxyService');

const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();

/**
 * Automates Part 2: Real Browser Launch, Session Injection, Location Search, and Store Resolution
 */
async function launchDominosStoreSession({
  latitude = 28.5355,
  longitude = 77.3910,
  searchAddress = 'Current Location',
  sessionToken = null,
  cookies = [],
  headless = true
}) {
  console.log(`[DOMINOS-BOT] 🚀 Launching Google Chrome via Playwright...`);
  console.log(`[DOMINOS-BOT] Chrome Binary: ${CHROME_PATH}`);
  console.log(`[DOMINOS-BOT] Headless Mode: ${headless}`);

  const proxyConfig = proxyService.getPlaywrightProxy();
  const launchOptions = {
    executablePath: CHROME_PATH,
    headless: headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=412,915'
    ]
  };
  if (proxyConfig) launchOptions.proxy = proxyConfig;

  const browser = await chromium.launch(launchOptions);

  // 1. Mobile Context (iPhone 14 / Pixel 7 mobile viewport + Geolocation permission)
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    geolocation: { latitude, longitude },
    permissions: ['geolocation']
  });

  // 2. Pre-inject session cookies if available
  if (cookies && cookies.length > 0) {
    console.log(`[DOMINOS-BOT] 🔑 Injecting ${cookies.length} admin session cookies...`);
    await context.addCookies(cookies);
  }

  const page = await context.newPage();

  // 3. Inject LocalStorage tokens before scripts run
  if (sessionToken) {
    await page.addInitScript((token) => {
      try {
        window.localStorage.setItem('auth_token', token);
        window.localStorage.setItem('user_session', JSON.stringify({ isLoggedIn: true }));
      } catch (e) {}
    }, sessionToken);
  }

  try {
    console.log(`[DOMINOS-BOT] 🌐 Navigating to https://m.dominos.co.in/ ...`);
    await page.goto('https://m.dominos.co.in/', { 
      waitUntil: 'domcontentloaded', 
      timeout: 45000 
    });

    console.log(`[DOMINOS-BOT] Page Title: ${await page.title()}`);

    // Wait a brief moment for dynamic client-side hydration
    await page.waitForTimeout(3000);

    // Take screenshot of landing page
    const landingShot = path.join(__dirname, '..', 'public', 'screenshots', 'dominos-landing.png');
    await page.screenshot({ path: landingShot });
    console.log(`[DOMINOS-BOT] 📸 Captured landing screenshot: ${landingShot}`);

    // 4. Check for and Click "Delivery" Option
    console.log(`[DOMINOS-BOT] 📍 Checking for Delivery selector...`);
    const deliverySelectors = [
      'button:has-text("Delivery")',
      '[data-label="delivery"]',
      'div:has-text("Delivery")',
      '.delivery-tab'
    ];

    for (const sel of deliverySelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`[DOMINOS-BOT] Clicking delivery element: ${sel}`);
        await el.click();
        break;
      }
    }

    await page.waitForTimeout(2000);

    // 5. Check for Location Search Input
    console.log(`[DOMINOS-BOT] 🔍 Searching location for: "${searchAddress}"...`);
    const searchSelectors = [
      'input[placeholder*="delivery address" i]',
      'input[placeholder*="search" i]',
      'input[placeholder*="location" i]',
      'input[type="search"]'
    ];

    let inputFound = false;
    for (const sel of searchSelectors) {
      const input = page.locator(sel).first();
      if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`[DOMINOS-BOT] Found address input field: ${sel}`);
        await input.click();
        await input.fill(searchAddress);
        inputFound = true;
        break;
      }
    }

    if (!inputFound) {
      console.log(`[DOMINOS-BOT] Notice: Direct search input not open on screen. Checking for location trigger button...`);
      const locTrigger = page.locator('button:has-text("Enter"), [class*="location"], [data-label="location-btn"]').first();
      if (await locTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
        await locTrigger.click();
        await page.waitForTimeout(2000);
      }
    }

    // 6. Wait for store / address suggestions dropdown
    console.log(`[DOMINOS-BOT] ⏳ Checking for suggestions dropdown...`);
    await page.waitForTimeout(3000);

    const suggestionSelectors = [
      'div[class*="suggestion"]',
      'div[class*="search-item"]',
      'div[class*="location-list"]',
      'li[role="option"]'
    ];

    let storeSelected = false;
    let selectedStoreText = 'Domino\'s Outlet (Auto-Resolved)';

    for (const sel of suggestionSelectors) {
      const item = page.locator(sel).first();
      if (await item.isVisible({ timeout: 4000 }).catch(() => false)) {
        selectedStoreText = await item.innerText();
        console.log(`[DOMINOS-BOT] ✅ Selecting store suggestion: ${selectedStoreText.replace(/\n/g, ' ')}`);
        await item.click();
        storeSelected = true;
        break;
      }
    }

    // Wait for route transition (menu load)
    await page.waitForTimeout(4000);

    // 7. Capture Final State Screenshot
    const finalShot = path.join(__dirname, '..', 'public', 'screenshots', 'dominos-resolved-store.png');
    await page.screenshot({ path: finalShot });
    console.log(`[DOMINOS-BOT] 📸 Final resolved store screenshot captured: ${finalShot}`);

    return {
      success: true,
      storeName: selectedStoreText,
      landingScreenshot: '/screenshots/dominos-landing.png',
      finalScreenshot: '/screenshots/dominos-resolved-store.png',
      currentUrl: page.url(),
      browser,
      context,
      page
    };

  } catch (err) {
    console.error(`[DOMINOS-BOT] ❌ Error during browser navigation:`, err.message);
    const errShot = path.join(__dirname, '..', 'public', 'screenshots', 'dominos-error.png');
    await page.screenshot({ path: errShot }).catch(() => {});
    await browser.close().catch(() => {});
    return {
      success: false,
      error: err.message,
      errorScreenshot: '/screenshots/dominos-error.png'
    };
  }
}

module.exports = { launchDominosStoreSession };
