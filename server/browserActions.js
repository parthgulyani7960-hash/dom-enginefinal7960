/**
 * Resilient Browser Action Helpers for Domino's India Mobile Web
 * Handles human-like typing, robust clicking, modal dismissal, and DOM stability.
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Scrolls element into view, waits for stability, and clicks without interception errors.
 */
async function safeClick(page, selector, { timeout = 8000, description = '' } = {}) {
  const label = description || selector;
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout });
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await sleep(200);

    // Click with gentle action
    await locator.click({ timeout: 5000 });
    return true;
  } catch (err) {
    // Fallback: evaluate click via DOM if overlays block pointer events
    try {
      const clicked = await page.$eval(selector, el => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
        return true;
      });
      return clicked;
    } catch (e) {
      throw new Error(`Failed to click [${label}]: ${err.message}`);
    }
  }
}

/**
 * Human-like typing with random jitter between keystrokes to mimic authentic entry.
 */
async function safeType(page, selector, text, { delayMs = 45, clearFirst = true, description = '' } = {}) {
  const label = description || selector;
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 8000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click();
  await sleep(150);

  if (clearFirst) {
    // Select all and clear existing content cleanly
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(100);
  }

  // Type character by character with micro-variations
  for (const char of String(text)) {
    await page.keyboard.type(char);
    const jitter = delayMs + Math.floor(Math.random() * 25);
    await sleep(jitter);
  }
}

/**
 * Automatically detects and dismisses intrusive Domino's upsells, location popups, or banner dialogs.
 */
async function dismissDominosPopups(page) {
  const dismissSelectors = [
    'button:has-text("No Thanks")',
    'button:has-text("Skip")',
    'button:has-text("Don\'t Allow")',
    'button:has-text("Later")',
    'span:has-text("✕")',
    'button[aria-label="Close"]',
    '.modal-close'
  ];

  for (const sel of dismissSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        console.log(`[DOMINOS-BOT] 🛡️ Dismissed popup dialog: ${sel}`);
        await btn.click({ timeout: 1500 });
        await sleep(300);
      }
    } catch (e) {}
  }
}

/**
 * Waits for network idle or background AJAX calculation to settle.
 */
async function waitForDominoSettle(page, ms = 2000) {
  await sleep(ms);
  await dismissDominosPopups(page);
}

module.exports = {
  sleep,
  safeClick,
  safeType,
  dismissDominosPopups,
  waitForDominoSettle
};
