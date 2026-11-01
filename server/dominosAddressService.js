const { chromium } = require('playwright-core');
const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();
const { refreshDominoSession, applyAccountRefresh } = require('./adminSession');
const db = require('./db');
const proxyService = require('./proxyService');

/**
 * Real Domino's India Address Service
 * Interacts with Domino's live backend to save and retrieve delivery addresses for the active session.
 */
class DominosAddressService {

  /**
   * Sync a delivery address directly to Domino's backend for an account session.
   * Uses authenticated headless browser context to satisfy Akamai WAF & token policies.
   */
  async syncAddressToDominos(address, account) {
    if (!account) {
      return { success: false, error: 'No active Domino\'s account session provided.' };
    }

    const cleanMobile = (account.cleanPhone || '7893618933').replace(/[^0-9]/g, '').slice(-10);
    const uId = account.userId || '353304039';
    const rToken = account.refreshToken || account.credentials?.refreshToken;

    // Proactively refresh access token if nearing expiration (>45 mins old or missing)
    if (rToken && uId) {
      const isStale = !account.lastRefreshedAt || (Date.now() - new Date(account.lastRefreshedAt).getTime() > 45 * 60 * 1000);
      if (isStale) {
        console.log(`[DOMINOS-ADDR] 🔄 Proactively refreshing access token for ${cleanMobile} prior to address sync...`);
        try {
          const ref = await refreshDominoSession(uId, rToken);
          if (ref.success) {
            applyAccountRefresh(account, ref);
            db.save();
          }
        } catch (e) {}
      }
    }

    console.log(`[DOMINOS-ADDR] 🏠 Syncing address to Domino's site for User ${uId} (${cleanMobile})...`);

    let browser = null;
    try {
      const proxyConfig = proxyService.getPlaywrightProxy();
      const addrOpts = {
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
      };
      if (proxyConfig) addrOpts.proxy = proxyConfig;
      browser = await chromium.launch(addrOpts);

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 412, height: 915 }
      });

      if (Array.isArray(account.cookies)) {
        const validCookies = account.cookies.filter(c => c.name && c.value && !c.name.includes(' '));
        await context.addCookies(validCookies).catch(() => {});
      }

      const page = await context.newPage();

      if (account.localStorage) {
        await page.addInitScript((storage) => {
          try {
            for (const [k, v] of Object.entries(storage)) {
              if (v) localStorage.setItem(k, typeof v === 'object' ? JSON.stringify(v) : v);
            }
          } catch (e) {}
        }, account.localStorage);
      }

      // Fast intercept for token rejuvenation
      let interceptedToken = null;
      page.on('response', async res => {
        if (res.url().includes('loginhandler/refreshtoken')) {
          try {
            const j = await res.json();
            if (j.credentials?.accessToken) {
              interceptedToken = j.credentials.accessToken;
            }
          } catch (e) {}
        }
      });

      // Navigate to Domino's address origin to establish session context
      await page.goto('https://m.dominos.co.in/postorder-ui/myAddresses?fromProfile=true', {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      });
      await page.waitForTimeout(2500);

      const tokenInStorage = await page.evaluate(() => localStorage.getItem('token') || localStorage.getItem('authToken'));
      const activeToken = interceptedToken || tokenInStorage || account.sessionToken;

      const fullStreet = [address.flat, address.building, address.street].filter(Boolean).join(', ');
      const receiverMobile = (address.phone || address.mobile || cleanMobile).replace(/[^0-9]/g, '').slice(-10);
      const receiverName = address.name || address.receiverName || account.customerName || 'Customer';

      const isOtherPerson = Boolean(address.orderForSomeoneElse || (receiverMobile && cleanMobile && receiverMobile !== cleanMobile) || (receiverName && receiverName !== account.customerName));

      const dominosAddressPayload = {
        building_number: address.flat || 'House',
        customers_mobile: receiverMobile,
        contact_number: receiverMobile,
        customer_name: receiverName,
        first_name: receiverName.split(' ')[0] || 'Customer',
        last_name: receiverName.split(' ').slice(1).join(' ') || '',
        is_other_person: isOtherPerson,
        other_person_name: receiverName,
        other_person_phone: receiverMobile,
        order_for_someone_else: isOtherPerson,
        street_name: address.street || address.completeAddress || address.building || 'Main Street',
        area_level0: address.city || 'Chandigarh',
        city_region: address.city || 'Chandigarh',
        area_level1: address.city || 'Chandigarh',
        area_level2: ' ',
        city: address.city || 'Chandigarh',
        country: 'India',
        latitude: parseFloat(address.latitude) || 30.7339,
        longitude: parseFloat(address.longitude) || 76.7889,
        formatted_address: `${fullStreet}, ${address.city || ''} ${address.pincode || ''}`.trim(),
        address_status: 'A',
        address_type: address.label === 'Work' ? 'Work' : 'Home',
        postal_code: address.pincode || '',
        source: 'web app-chrome',
        floor_number: '1',
        landmark: address.landmark || ' '
      };

      // Call Domino's official SAVE_ADDRESS endpoint in page context
      const saveResult = await page.evaluate(async ({ token, mobile, userId, payload }) => {
        try {
          const reqId = `pwa-${userId}-${Date.now()}`;
          const res = await fetch(`https://api.dominos.co.in/customer-service/ve2/user/${userId}/addresses?site=jflcms`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api_key': 'd2aeb489bb8df385',
              'authToken': token,
              'sessiontoken': token,
              'userId': userId,
              'mobile': mobile,
              'isLoggedIn': 'true',
              'client_type': 'web app-chrome',
              'source': 'PWA18',
              'X-FORWARDED-FOR-requestId': reqId
            },
            body: JSON.stringify(payload)
          });

          const status = res.status;
          const json = await res.json().catch(() => null);
          return { status, data: json };
        } catch (err) {
          return { error: err.message };
        }
      }, {
        token: activeToken,
        mobile: receiverMobile,
        userId: uId,
        payload: dominosAddressPayload
      });

      await browser.close();

      if (saveResult.status === 200 && saveResult.data?.status === 'SUCCESS') {
        const savedData = saveResult.data.data?.[0] || {};
        const domAddressId = savedData.address_id || null;
        console.log(`[DOMINOS-ADDR] ✅ Successfully saved to Domino's! Domino's Address ID: ${domAddressId}`);
        return {
          success: true,
          dominosAddressId: domAddressId,
          dominosFormattedAddress: savedData.formatted_address || dominosAddressPayload.formatted_address,
          rawResponse: saveResult.data
        };
      } else {
        const errMsg = saveResult.data?.message || saveResult.error || `HTTP ${saveResult.status}`;
        console.warn(`[DOMINOS-ADDR] ⚠️ Domino's address API notice: ${errMsg}`);
        return {
          success: false,
          error: errMsg,
          details: saveResult.data
        };
      }
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      console.error(`[DOMINOS-ADDR-ERR]`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Fetch saved addresses directly from Domino's cloud for the account
   */
  async fetchSavedAddressesFromDominos(account) {
    if (!account) return { success: false, error: 'No active account provided' };

    const rToken = account.refreshToken || account.credentials?.refreshToken;
    const uId = account.userId || account.credentials?.userId;
    if (rToken && uId) {
      const isStale = !account.lastRefreshedAt || (Date.now() - new Date(account.lastRefreshedAt).getTime() > 45 * 60 * 1000);
      if (isStale) {
        try {
          const ref = await refreshDominoSession(uId, rToken);
          if (ref.success) {
            applyAccountRefresh(account, ref);
            db.save();
          }
        } catch (e) {}
      }
    }

    let browser = null;
    try {
      const proxyConfig = proxyService.getPlaywrightProxy();
      const fetchOpts = {
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      };
      if (proxyConfig) fetchOpts.proxy = proxyConfig;
      browser = await chromium.launch(fetchOpts);

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 412, height: 915 }
      });

      if (Array.isArray(account.cookies)) {
        await context.addCookies(account.cookies.filter(c => c.name && c.value && !c.name.includes(' '))).catch(() => {});
      }

      const page = await context.newPage();
      if (account.localStorage) {
        await page.addInitScript((storage) => {
          try {
            for (const [k, v] of Object.entries(storage)) {
              if (v) localStorage.setItem(k, typeof v === 'object' ? JSON.stringify(v) : v);
            }
          } catch (e) {}
        }, account.localStorage);
      }

      let liveAddresses = null;
      let interceptedToken = null;

      page.on('response', async res => {
        const u = res.url();
        if (u.includes('customer-service/ve2/user') && u.includes('addresses')) {
          try {
            const j = await res.json();
            if (j.status === 'SUCCESS' && Array.isArray(j.data)) {
              liveAddresses = j.data;
            }
          } catch (e) {}
        }
        if (u.includes('loginhandler/refreshtoken')) {
          try {
            const j = await res.json();
            if (j.credentials?.accessToken) {
              interceptedToken = j.credentials.accessToken;
            }
          } catch (e) {}
        }
      });

      await page.goto('https://m.dominos.co.in/postorder-ui/myAddresses?fromProfile=true', {
        waitUntil: 'networkidle',
        timeout: 25000
      });
      await page.waitForTimeout(2500);

      if (liveAddresses) {
        await browser.close();
        return { success: true, addresses: liveAddresses };
      }

      const token = interceptedToken || await page.evaluate(() => localStorage.getItem('token') || localStorage.getItem('authToken'));
      const uId = account.userId || '353304039';

      const fetchRes = await page.evaluate(async ({ token, userId }) => {
        const res = await fetch(`https://api.dominos.co.in/customer-service/ve2/user/${userId}/addresses`, {
          headers: {
            'Content-Type': 'application/json',
            'api_key': 'd2aeb489bb8df385',
            'authToken': token,
            'sessiontoken': token,
            'userId': userId,
            'isLoggedIn': 'true',
            'client_type': 'web app-chrome',
            'source': 'PWA18',
            'X-FORWARDED-FOR-requestId': `pwa-${userId}-${Date.now()}`
          }
        });
        return { status: res.status, data: await res.json().catch(() => null) };
      }, { token: token || account.sessionToken, userId: uId });

      await browser.close();

      console.log('[DOMINOS-ADDR] GET saved addresses status:', fetchRes.status, 'Response:', JSON.stringify(fetchRes.data).slice(0, 300));
      if (fetchRes.status === 200 && fetchRes.data?.status === 'SUCCESS') {
        return { success: true, addresses: fetchRes.data.data || [] };
      } else {
        return { success: false, error: fetchRes.data?.message || `HTTP ${fetchRes.status}` };
      }
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      return { success: false, error: err.message };
    }
  }
}

module.exports = new DominosAddressService();
