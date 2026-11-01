const { chromium } = require('playwright-core');
const db = require('./db');

const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();

async function checkTrackingPage() {
  const acc = db.getAccounts().find(a => a.phone.includes('9650146938'));
  console.log('Using account:', acc.phone);
  
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  if (acc.cookies && acc.cookies.length > 0) {
    const validCookies = acc.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.dominos.co.in',
      path: c.path || '/'
    }));
    await context.addCookies(validCookies);
    console.log('Added ' + validCookies.length + ' cookies');
  }

  const page = await context.newPage();

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('dominos.co.in') && (u.includes('order') || u.includes('track') || u.includes('rider') || u.includes('delivery'))) {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) {
        try {
          const body = await res.json();
          const str = JSON.stringify(body);
          if (str.includes('rider') || str.includes('driver') || str.includes('1542545963') || str.includes('790022')) {
            console.log('MATCHED RESPONSE from', u, ':', str.slice(0, 500));
          }
        } catch (e) {}
      }
    }
  });

  const testUrls = [
    'https://m.dominos.co.in/jfl-discovery-payment/en/pwa/order-status/1542545963',
    'https://pizzaonline.dominos.co.in/order-tracking?orderId=1542545963',
    'https://pizzaonline.dominos.co.in/track-order?orderId=1542545963',
    'https://m.dominos.co.in/track/1542545963'
  ];

  for (const url of testUrls) {
    try {
      console.log('Navigating to:', url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      const content = await page.content();
      console.log('Page title:', await page.title());
      
      // Look for phone numbers in page text
      const text = await page.innerText('body').catch(() => '');
      const phones = text.match(/(\+?91[\-\s]?)?[6-9]\d{9}|\b011[\-\s]?\d{7,8}\b/g) || [];
      console.log('Found phone numbers in page text:', [...new Set(phones)]);
      if (text.toLowerCase().includes('rider') || text.toLowerCase().includes('delivery executive') || text.toLowerCase().includes('suresh') || text.toLowerCase().includes('dispatched')) {
        console.log('Snippet mentioning rider:', text.slice(0, 500));
      }
    } catch (e) {
      console.log('Err loading', url, ':', e.message);
    }
  }

  await browser.close();
}

checkTrackingPage().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
