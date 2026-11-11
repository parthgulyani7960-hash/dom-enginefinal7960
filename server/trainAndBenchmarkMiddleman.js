const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dismissPopups(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        'button.close', 'button.dismiss', 'button:has-text("Don\'t Allow")',
        'button:has-text("Later")', 'button:has-text("NO THANKS")',
        '.jfi-close', '.close-icon', '[data-quid="btn-close"]',
        '.popup-close', '.modal-close'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (el.offsetHeight > 0) el.click();
        });
      });
    });
  } catch (_) {}
}

async function runSessionTrainingCycle({ accountSession, storeId = '66409', testItems = [], cycles = 2, onLog = console.log }) {
  const phone = accountSession.phone || accountSession.cleanPhone;
  const tag = `[TRAIN-${phone}]`;
  onLog(`${tag} 🚀 Initializing training and benchmark cycle (${cycles} pass(es))...`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 30.7582, longitude: 76.7818 },
    permissions: ['geolocation']
  });

  const activeToken = (accountSession.credentials?.accessToken || accountSession.sessionToken || '').replace(/^Bearer\s+/i, '').trim();
  const userId = accountSession.userId || '353304039';
  const cleanMobile = (accountSession.cleanPhone || phone).replace(/[^0-9]/g, '').slice(-10);

  // Inject authentication cookies
  const cookiesToAdd = [];
  if (Array.isArray(accountSession.cookies) && accountSession.cookies.length > 0) {
    cookiesToAdd.push(...accountSession.cookies.map(c => ({
      name: c.name,
      value: c.name === 'token' && activeToken ? activeToken : c.value,
      domain: (c.domain || '.dominos.co.in').replace(/^\./, ''),
      path: c.path || '/'
    })));
  }
  if (activeToken && !cookiesToAdd.some(c => c.name === 'token')) {
    cookiesToAdd.push({ name: 'token', value: activeToken, domain: 'dominos.co.in', path: '/' });
  }
  if (cookiesToAdd.length > 0) {
    await context.addCookies(cookiesToAdd);
    onLog(`${tag} 🔑 Injected ${cookiesToAdd.length} authenticated session cookies.`);
  }

  const page = await context.newPage();

  // Inject session storage and location state
  await page.addInitScript(({ token, phone, uId, sId }) => {
    try {
      localStorage.setItem('token', token);
      localStorage.setItem('authToken', token);
      localStorage.setItem('mobileNo', phone);
      localStorage.setItem('userId', uId);
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('orderType', 'D');
      localStorage.setItem('storeId', sId);
      sessionStorage.setItem('token', token);
      sessionStorage.setItem('isLoggedIn', 'true');
    } catch (_) {}
  }, { token: activeToken, phone: cleanMobile, uId: userId, sId: storeId });

  // Block analytical bloat for lightning benchmark speed
  await page.route('**/*', (route) => {
    const url = route.request().url();
    const type = route.request().resourceType();
    if (
      type === 'image' || type === 'media' || type === 'font' ||
      url.includes('google-analytics') || url.includes('hotjar') ||
      url.includes('clevertap') || url.includes('clarity.ms') || url.includes('sentry')
    ) {
      return route.abort();
    }
    route.continue();
  });

  const benchmarkMetrics = {
    phone,
    cyclesCompleted: 0,
    itemAddResults: [],
    pruneResults: [],
    totalTimeMs: 0
  };

  const startTime = Date.now();

  try {
    onLog(`${tag} 🛒 Navigating to Domino's Menu V1 for Store ${storeId}...`);
    await page.goto(`https://m.dominos.co.in/jfl-discovery-ui/en/pwa/menu-v1/${storeId}?&showSearchModal=true&scrollTo=3`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    }).catch(() => {});
    await dismissPopups(page);
    await sleep(600);

    for (let cIdx = 1; cIdx <= cycles; cIdx++) {
      onLog(`${tag} 🔁 --- STARTING TRAINING PASS ${cIdx}/${cycles} ---`);

      // PHASE 1: Add constituent items with full customizations
      for (const item of testItems) {
        const itemStart = Date.now();
        onLog(`${tag} 🔍 Searching & Customizing "${item.name}" (Size: ${item.customSize || 'Standard'}, Crust: ${item.customCrust || 'Standard'})...`);

        // Open search input
        const searchInput = page.locator('input.search-input, input[placeholder*="search" i], input[type="search"]').first();
        if (await searchInput.isVisible({ timeout: 1500 }).catch(() => false)) {
          await searchInput.fill(item.name);
          await sleep(500);

          // Find matching card
          const card = page.locator('.card-item-search').filter({
            has: page.locator('h1, h2, h3, h4, .itm-name, .pizza-title, [class*="title"]').filter({ hasText: item.name })
          }).first();

          if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
            const addBtn = card.locator('button.cta-add, .cta-add, div.main-cta, button:has-text("Add"), button:has-text("ADD")').first();
            if (await addBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await addBtn.click({ force: true });
              await sleep(350);

              // Apply size & crust in customization sheet
              if (item.customSize || item.customCrust) {
                await page.evaluate(({ customSize, customCrust }) => {
                  const modal = document.querySelector('.customise-bottom-sheet, .customisation-modal, div[class*="customiz" i], div[class*="bottom-sheet" i]') || document.body;
                  
                  // Size
                  if (customSize) {
                    const normSize = customSize.toLowerCase();
                    const sizeEls = Array.from(modal.querySelectorAll('button, div[role="tab"], .size-tab, label, span, div, li'));
                    for (const el of sizeEls) {
                      const txt = (el.innerText || '').trim().toLowerCase();
                      if (txt === normSize || txt.startsWith(normSize + ' ') || txt.includes(normSize)) {
                        el.click();
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        break;
                      }
                    }
                  }

                  // Crust
                  if (customCrust) {
                    const normCrust = customCrust.toLowerCase();
                    const crustEls = Array.from(modal.querySelectorAll('div.crust-item, div.crust-option, div.row, label, button, span'));
                    for (const el of crustEls) {
                      const txt = (el.innerText || '').trim().toLowerCase();
                      if (txt.includes(normCrust)) {
                        const clickable = el.querySelector('input[type="radio"]') || el.querySelector('button') || el;
                        clickable.click();
                        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        break;
                      }
                    }
                  }
                }, { customSize: item.customSize, customCrust: item.customCrust });
                await sleep(250);

                // Confirm sheet
                const confirmBtn = page.locator('button:has-text("ADD TO CART"), button:has-text("| Add"), button:has-text("Add"), button:has-text("I CHOOSE"), .customise-bottom-bar button').first();
                if (await confirmBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                  await confirmBtn.click({ force: true }).catch(() => {});
                  await sleep(300);
                }
              }

              const addDuration = Date.now() - itemStart;
              benchmarkMetrics.itemAddResults.push({ item: item.name, durationMs: addDuration, success: true });
              onLog(`${tag} ✓ "${item.name}" added & customized in ${addDuration}ms.`);
            }
          }
        }
      }

      // PHASE 2: Navigate to Cart & Audit Contents
      onLog(`${tag} 🛒 Navigating to Domino's Cart...`);
      await page.goto(`https://m.dominos.co.in/jfl-discovery-payment/en/pwa/cart/${storeId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      }).catch(() => {});
      await dismissPopups(page);
      await sleep(1000);

      const cartItemsCount = await page.evaluate(() => {
        const cards = document.querySelectorAll('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper, [class*="cart-item"], [data-quid="cart-item"]');
        return cards.length;
      });
      onLog(`${tag} 📊 Cart verified: ${cartItemsCount} item card(s) detected.`);

      // PHASE 3: Prune / Remove Items One by One (Stress-test rapid deletion)
      onLog(`${tag} 🗑️ Executing rapid cart pruning & removal test...`);
      const pruneStart = Date.now();
      let removedItems = 0;

      for (let pAttempt = 0; pAttempt < 5; pAttempt++) {
        const minusBtns = await page.locator('.anim-ico-minus, [class*="minus"], .minus, span:has-text("-"), button:has-text("-")').all();
        if (minusBtns.length === 0) break;

        const btn = minusBtns[0];
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ force: true }).catch(() => {});
          await sleep(250);

          // Confirm removal if dialog appears
          await page.evaluate(() => {
            const allBtns = Array.from(document.querySelectorAll('button, div.btn, span, a'));
            const rmBtn = allBtns.find(el => {
              const t = (el.innerText || '').trim().toUpperCase();
              return (t === 'REMOVE' || t === 'YES' || t === 'YES, REMOVE' || t === 'DELETE' || t === 'CONFIRM') && el.offsetHeight > 10;
            });
            if (rmBtn) {
              rmBtn.click();
              rmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          });
          await sleep(350);
          removedItems++;
        }
      }

      const pruneDuration = Date.now() - pruneStart;
      benchmarkMetrics.pruneResults.push({ cycle: cIdx, itemsRemoved: removedItems, durationMs: pruneDuration });
      onLog(`${tag} ✓ Pruned ${removedItems} item(s) from cart in ${pruneDuration}ms.`);

      benchmarkMetrics.cyclesCompleted++;

      if (cIdx < cycles) {
        // Return to menu for next training pass
        await page.goto(`https://m.dominos.co.in/jfl-discovery-ui/en/pwa/menu-v1/${storeId}?&showSearchModal=true&scrollTo=3`, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        }).catch(() => {});
        await sleep(600);
      }
    }
  } catch (err) {
    onLog(`${tag} ⚠️ Benchmark error: ${err.message}`);
    benchmarkMetrics.error = err.message;
  } finally {
    await browser.close().catch(() => {});
    benchmarkMetrics.totalTimeMs = Date.now() - startTime;
    onLog(`${tag} 🏁 Completed training run in ${(benchmarkMetrics.totalTimeMs / 1000).toFixed(1)}s.`);
  }

  return benchmarkMetrics;
}

module.exports = {
  runSessionTrainingCycle
};
