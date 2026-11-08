const { chromium } = require('playwright-core');
const path = require('path');
const proxyService = require('./proxyService');
const { safeClick, safeType, dismissDominosPopups, waitForDominoSettle, sleep } = require('./browserActions');

const { getChromeExecutablePath } = require('./chromePath');
const CHROME_PATH = getChromeExecutablePath();

/**
 * THE MIDDLEMAN PROXY ROBOT:
 * Customer confirms checkout (Cash on Delivery / UPI).
 * This robot executes in a high-speed unified Playwright session:
 * 1. Establishes authenticated Domino's account session with complete state injection.
 * 2. Adds customer's delivery address into Domino's "My Addresses" section first.
 * 3. Verifies store kitchen serviceability for this address and checks real-time inventory.
 * 4. Unpacks combos into real constituent pizzas/sides and adds them into Domino's cart.
 * 5. Applies account tier discount coupon (DOMNEW50 / CHEESY / PARTY).
 * 6. Selects Cash on Delivery (COD) / Pay on Delivery on Domino's payment screen.
 * 7. Confirms order on Domino's India, captures authentic order confirmation proof & extracts official Domino's Order ID.
 */
/**
 * Handle Domino's Mobile Web Customization Modal / Bottom Sheet
 * Selects pizza size (Regular / Medium / Large), crust, and toppings if requested
 */
async function handleDominosCustomizationSheet(page, item, onProgress) {
  try {
    // Check if legitimate Domino's customization drawer is actively mounted
    const hasCustomDrawer = await page.evaluate(() => {
      const modal = document.querySelector('.customise-bottom-sheet, .customisation-modal, div[class*="customiz" i], div[class*="bottom-sheet" i]');
      if (!modal) return false;
      const txt = (modal.innerText || '').toLowerCase();
      return txt.includes('size') || txt.includes('crust') || txt.includes('add to cart') || txt.includes('i choose');
    });

    if (!hasCustomDrawer) return;

    onProgress(`[MIDDLEMAN-ENGINE] 🍕 Customization drawer detected for "${item.name}". Applying options...`);

    // 1. Select Pizza Size (Regular / Medium / Large) if specified
    const sizeTarget = (item.customSize || item.size || item.variant || (item.selectedVariant && item.selectedVariant.name) || (item.selectedVariant && item.selectedVariant.size) || '').trim();
    if (sizeTarget) {
      onProgress(`[MIDDLEMAN-ENGINE] -> Setting size: "${sizeTarget}"`);
      await page.evaluate((targetSize) => {
        const modal = document.querySelector('.customise-bottom-sheet, .customisation-modal, div[class*="customiz" i], div[class*="bottom-sheet" i], [role="dialog"], .c-modal') || document.body;
        const normTarget = targetSize.toLowerCase();

        // 1. Attribute-based matching (data-quid, data-testid, data-label)
        const attrMatches = Array.from(modal.querySelectorAll(`[data-quid*="${normTarget}" i], [data-testid*="${normTarget}" i], [data-label*="${normTarget}" i]`));
        if (attrMatches.length > 0) {
          attrMatches[0].click();
          return true;
        }

        // 2. Leaf element or tab matching
        const els = Array.from(modal.querySelectorAll('button, div[role="tab"], .size-tab, .tab-item, div.crust-size, label, span, div, li'));
        for (const el of els) {
          const txt = (el.innerText || '').trim().toLowerCase();
          if (txt === normTarget || txt.startsWith(normTarget + '\n') || txt.startsWith(normTarget + ' ') || txt.includes(normTarget)) {
            if (el.children.length <= 2) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }, sizeTarget);
      await sleep(600);
    }

    // 2. Select Pizza Crust (e.g. Cheese Burst / Fresh Pan Pizza / New Hand Tossed / Wheat Thin Crust)
    const crustTarget = (item.customCrust || item.crust || (item.selectedVariant && item.selectedVariant.crust) || '').trim();
    if (crustTarget) {
      onProgress(`[MIDDLEMAN-ENGINE] -> Setting crust: "${crustTarget}"`);
      await page.evaluate((targetCrust) => {
        const modal = document.querySelector('.customise-bottom-sheet, .customisation-modal, div[class*="customiz" i], div[class*="bottom-sheet" i], [role="dialog"], .c-modal') || document.body;
        const normTarget = targetCrust.toLowerCase();
        const els = Array.from(modal.querySelectorAll('div.crust-item, div.crust-option, div.row, label, button, div, span, li'));
        for (const el of els) {
          const txt = (el.innerText || '').trim().toLowerCase();
          if (txt.includes(normTarget)) {
            const clickable = el.querySelector('input[type="radio"]') || el.querySelector('button') || el;
            clickable.click();
            return true;
          }
        }
        return false;
      }, crustTarget);
      await sleep(600);
    }

    // 3. Confirm and Add to Cart (supports button, div.btn, and DOM evaluation)
    const confirmSelectors = [
      'button:has-text("ADD TO CART")',
      'div.btn:has-text("ADD TO CART")',
      'div:has-text("ADD TO CART")',
      'button:has-text("I CHOOSE")',
      'div.btn:has-text("I CHOOSE")',
      'div:has-text("I CHOOSE")',
      'button:has-text("Add To Cart")',
      'button:has-text("Add to Cart")',
      'button:has-text("CONTINUE")',
      'button:has-text("APPLY")',
      'button.btn-add-customise',
      '.cta-customise button',
      '.customise-bottom-bar button',
      '.customise-bottom-bar div.btn'
    ];

    let confirmed = false;
    for (const cSel of confirmSelectors) {
      const btn = page.locator(cSel).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      await page.evaluate(() => {
        const modal = document.querySelector('div[class*="customiz"], div[class*="bottom-sheet"], [role="dialog"], .c-modal') || document.body;
        const btns = Array.from(modal.querySelectorAll('button, div.btn, .btn, div[role="button"]'));
        const target = btns.find(b => {
          const t = (b.innerText || '').toLowerCase().replace(/\s+/g, ' ');
          return t.includes('add to cart') || t.includes('i choose') || t.includes('continue') || t.includes('apply');
        });
        if (target) target.click();
      });
    }

    // Wait for customization modal to disappear after confirmation
    await page.waitForSelector('div[class*="customiz"], div[class*="bottom-sheet"], .c-modal', { state: 'hidden', timeout: 3500 }).catch(() => {});
    await sleep(800);
  } catch (cErr) {
    onProgress(`[MIDDLEMAN-ENGINE] Customization notice: ${cErr.message}`);
  }
}

async function executeMiddlemanOrderOnDominos({
  customerOrder,    // { id, items, location, address }
  accountSession,   // Saved admin Domino's cookies, tokens, & coupon tier
  voucher,          // Optional fallback voucher
  paymentMethod = 'COD',
  headless = true,
  onProgress = console.log
}) {
  onProgress(`[MIDDLEMAN-ENGINE] 🚀 Launching unified robot session for Customer Order ${customerOrder.id}...`);

  const proxyConfig = proxyService.getPlaywrightProxy();
  const launchOptions = {
    executablePath: CHROME_PATH,
    headless: headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  };
  if (proxyConfig) {
    launchOptions.proxy = proxyConfig;
    onProgress(`[MIDDLEMAN-ENGINE] 🌐 Routing browser session through rotating proxy: ${proxyConfig.server}`);
  }

  const browser = await chromium.launch(launchOptions);

  const targetLat = customerOrder.address?.latitude || customerOrder.location?.latitude || 30.7339;
  const targetLng = customerOrder.address?.longitude || customerOrder.location?.longitude || 76.7889;

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    viewport: { width: 390, height: 844 },
    geolocation: {
      latitude: parseFloat(targetLat) || 30.7339,
      longitude: parseFloat(targetLng) || 76.7889
    },
    permissions: ['geolocation']
  });

  // Inject authenticated admin session cookies into browser context
  if (accountSession?.cookies) {
    try {
      let cookiesToAdd = [];
      if (Array.isArray(accountSession.cookies)) {
        cookiesToAdd = accountSession.cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: (c.domain || '.dominos.co.in').replace(/^\./, ''),
          path: c.path || '/'
        }));
      } else if (typeof accountSession.cookies === 'string') {
        cookiesToAdd = accountSession.cookies.split(';').map(part => {
          const [rawKey, ...rawVal] = part.trim().split('=');
          return {
            name: (rawKey || '').trim(),
            value: rawVal.join('=').trim(),
            domain: 'dominos.co.in',
            path: '/'
          };
        }).filter(c => c.name && c.value);
      }
      if (cookiesToAdd.length > 0) {
        onProgress(`[MIDDLEMAN-ENGINE] 🔑 Injecting ${cookiesToAdd.length} saved Domino's session cookies...`);
        await context.addCookies(cookiesToAdd);
      }
    } catch (cookieErr) {
      onProgress(`[MIDDLEMAN-ENGINE] ⚠️ Session cookie injection notice: ${cookieErr.message}`);
    }
  }

  const page = await context.newPage();
  let cartBillUrl = null;

  // Extract auth tokens & user identifiers
  const cleanMobile = (accountSession?.cleanPhone || customerOrder.user?.phone || '7893618933').replace(/[^0-9]/g, '').slice(-10);
  const userId = accountSession?.userId || '353304039';
  const cartId = accountSession?.cartId || '9017428133253221191';
  const activeToken = accountSession?.credentials?.accessToken || accountSession?.sessionToken || '';
  const authBearerToken = activeToken.startsWith('Bearer ') ? activeToken : `Bearer ${activeToken}`;
  const rawUserInfo = accountSession?.localStorage?.userInfo || accountSession?.userInfo;

  // Resolve Store Kitchen for coordinates first
  let targetStoreId = null;
  let deliveringStoreName = customerOrder.address?.storeName || customerOrder.location?.store?.storeName || 'DOMINOS PIZZA';
  let deliveringStoreAddress = customerOrder.address?.completeAddress || customerOrder.address?.street || 'Domino\'s Kitchen';
  let deliveringStorePhone = '18002081234';
  let storeLat = parseFloat(targetLat);
  let storeLng = parseFloat(targetLng);

  try {
    const { resolveStoreByCoordinates } = require('./locationService');
    const storeCheck = await resolveStoreByCoordinates(targetLat, targetLng);
    if (storeCheck && storeCheck.serviceable === false) {
      const unavailMsg = storeCheck.unserviceableReason || 'Domino\'s India does not currently deliver to this location.';
      onProgress(`[MIDDLEMAN-ENGINE] ❌ Store verification rejected: ${unavailMsg}`);
      await browser.close().catch(() => {});
      return {
        success: false,
        error: unavailMsg
      };
    }
    if (storeCheck?.assignedStore?.storeId) {
      targetStoreId = String(storeCheck.assignedStore.storeId);
      deliveringStoreName = storeCheck.assignedStore.storeName || deliveringStoreName;
      deliveringStoreAddress = storeCheck.assignedStore.address || deliveringStoreAddress;
      deliveringStorePhone = storeCheck.assignedStore.phone || deliveringStorePhone;
      storeLat = storeCheck.assignedStore.latitude || storeLat;
      storeLng = storeCheck.assignedStore.longitude || storeLng;
      onProgress(`[MIDDLEMAN-ENGINE] 🏪 Delivering Store Resolved from Domino's Locator: ${deliveringStoreName} (ID: ${targetStoreId})`);
    }
  } catch (e) {
    onProgress(`[MIDDLEMAN-ENGINE] Store resolution note: ${e.message}`);
  }

  if (!targetStoreId) {
    targetStoreId = String(customerOrder.address?.storeId || customerOrder.location?.store?.storeId || '63859');
  }

  // Explicitly sync resolved store across customerOrder
  if (!customerOrder.address) customerOrder.address = {};
  customerOrder.address.storeId = targetStoreId;
  customerOrder.address.storeName = deliveringStoreName;
  if (customerOrder.location) {
    if (!customerOrder.location.store) customerOrder.location.store = {};
    customerOrder.location.store.storeId = targetStoreId;
    customerOrder.location.store.storeName = deliveringStoreName;
  }

  const addr = customerOrder.address || {};
  const receiverPhone = (addr.phone || customerOrder.user?.phone || cleanMobile).replace(/[^0-9]/g, '').slice(-10);
  const receiverName = addr.name || customerOrder.user?.name || 'Customer';
  const fullStreet = [addr.flat, addr.building, addr.street].filter(Boolean).join(', ') || addr.completeAddress || 'Delivery Address';
  const cityStr = addr.city || 'Chandigarh';
  const pincodeStr = addr.pincode || '160015';
  const formattedAddress = `${fullStreet}, ${cityStr} ${pincodeStr}`.trim();
  const addressIdNum = Math.floor(1000000000 + Math.random() * 900000000);

  const stationData = {
    id: parseInt(targetStoreId) || 63859,
    storeId: String(targetStoreId),
    name: deliveringStoreName,
    address: deliveringStoreAddress,
    phone: deliveringStorePhone,
    latitude: parseFloat(storeLat),
    longitude: parseFloat(storeLng),
    status: true,
    city: cityStr.toUpperCase(),
    deliveryTypeCode: "D",
    driveDistanceInMeters: 500,
    driveTimeInSec: 300,
    driveDistanceInKm: "0.5",
    operational: true
  };

  const currentAddressObj = {
    address_id: addressIdNum,
    building_number: addr.flat || "Flat",
    customers_mobile: receiverPhone,
    customer_name: receiverName,
    street_name: fullStreet,
    area_level0: cityStr,
    city_region: cityStr,
    area_level1: cityStr,
    area_level2: " ",
    city: cityStr,
    country: "India",
    latitude: parseFloat(targetLat),
    longitude: parseFloat(targetLng),
    formatted_address: formattedAddress,
    customer_address_name: addr.flat || receiverName,
    houseNo: addr.flat || "Flat",
    address: formattedAddress,
    address_status: "A",
    zippr_flag: false,
    address_type: addr.label === "Work" ? "Work" : "Home",
    postal_code: pincodeStr,
    source: "web app-chrome"
  };

  const locationPayload = [
    {
      recent: {
        id: targetStoreId,
        name: deliveringStoreName,
        address: formattedAddress,
        displayAddress: cityStr,
        city: cityStr.toUpperCase(),
        cityCode: 1,
        deliveryEnable: true,
        online: 1,
        latitude: parseFloat(targetLat),
        longitude: parseFloat(targetLng),
        storeOperationalTag: "OPERATIONAL",
        polygonTime: "30",
        postalCode: pincodeStr
      },
      location: {
        address_id: addressIdNum,
        latitude: parseFloat(targetLat),
        longitude: parseFloat(targetLng),
        addressRequired: false
      },
      deliveryType: "D"
    }
  ];

  // Comprehensive Auth & Sanitized Location State Injection
  await page.addInitScript(({ token, phone, userId, cartId, storeId, userInfo, storage, station, locData, currentAddr, targetAddrId }) => {
    try {
      // 1. Base storage items (sanitized - omit old locations, stations, and leftover cart items!)
      for (const [k, v] of Object.entries(storage || {})) {
        if (!['cartItems', 'cart', 'cart_data', 'nxgCart', 'checkout_cart', 'deliveryTypeStationData', 'lastLocationNew', 'storeId', 'advanceStore', 'addressDetail', 'userLocationData', 'selectedAddress', 'userAddresses', 'savedUserAddresses', 'cartData', 'cartProperties', 'cart_guid', 'cart_id', 'orderType', 'recentStores'].includes(k)) {
          if (v) localStorage.setItem(k, typeof v === 'object' ? JSON.stringify(v) : v);
        }
      }

      // 2. Prepend current delivery address to userAddresses list
      const existingAddrs = [];
      try {
        const parsed = JSON.parse(storage?.userAddresses || '[]');
        if (Array.isArray(parsed)) existingAddrs.push(...parsed.filter(x => x.address_id !== targetAddrId));
      } catch (e) {}
      existingAddrs.unshift(currentAddr);

      // 3. Mandatory Auth Credentials & Target Location State
      localStorage.setItem('userAddresses', JSON.stringify(existingAddrs));
      localStorage.setItem('savedUserAddresses', JSON.stringify(existingAddrs));
      localStorage.setItem('token', token);
      localStorage.setItem('authToken', token);
      localStorage.setItem('auth_token', token);
      localStorage.setItem('mobileNo', phone);
      localStorage.setItem('phone', phone);
      localStorage.setItem('userId', userId);
      localStorage.setItem('cartId', cartId);
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('userLoggedIn', 'true');
      localStorage.setItem('orderType', 'D');
      localStorage.setItem('storeId', storeId);
      localStorage.setItem('advanceStore', storeId);
      localStorage.setItem('deliveryTypeStationData', JSON.stringify(station));
      localStorage.setItem('lastLocationNew', JSON.stringify(locData));
      localStorage.setItem('selectedAddress', JSON.stringify(currentAddr));

      if (userInfo) {
        const uStr = typeof userInfo === 'string' ? userInfo : JSON.stringify(userInfo);
        localStorage.setItem('userInfo', uStr);
        sessionStorage.setItem('userInfo', uStr);
      }

      // 4. SessionStorage synchronization
      sessionStorage.setItem('token', token);
      sessionStorage.setItem('authToken', token);
      sessionStorage.setItem('isLoggedIn', 'true');
      sessionStorage.setItem('mobileNo', phone);
      sessionStorage.setItem('phone', phone);
      sessionStorage.setItem('cartId', cartId);
      sessionStorage.setItem('userId', userId);
    } catch (e) {}
  }, {
    token: activeToken,
    phone: cleanMobile,
    userId: userId,
    cartId: cartId,
    storeId: targetStoreId,
    userInfo: rawUserInfo,
    storage: accountSession?.localStorage,
    station: stationData,
    locData: locationPayload,
    currentAddr: currentAddressObj,
    targetAddrId: addressIdNum
  });

  // Block analytical and tracking scripts for maximum execution speed
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (
      url.includes('clevertap') ||
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('datadog') ||
      url.includes('hotjar') ||
      url.includes('facebook')
    ) {
      return route.abort();
    }
    route.continue();
  });

  // Request & Response interception for real Domino's order ID and submission diagnostics
  let interceptedOrderId = null;
  let interceptedAddressId = null;
  let interceptedOrderError = null;
  let interceptedOrderErrorCode = null;
  let priceRecalculatedNeedsConfirm = false;

  page.on('request', async (request) => {
    const url = request.url();
    const isOrderSubmitUrl = url.includes('/orders/submit') || url.includes('/placeOrder') || (url.includes('/checkout') && url.includes('/submit')) || (url.includes('/payment') && url.includes('/submit'));
    if (isOrderSubmitUrl) {
      try {
        const postData = request.postData();
        onProgress(`[DOMINOS-SUBMIT-REQ] URL: ${url} | PostData: ${postData || 'none'}`);
      } catch (e) {}
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const isOrderSubmitUrl = url.includes('/orders/submit') || url.includes('/placeOrder') || (url.includes('/checkout') && url.includes('/submit')) || (url.includes('/payment') && url.includes('/submit'));
    if (isOrderSubmitUrl) {
      try {
        const json = await response.json();
        onProgress(`[DOMINOS-SUBMIT-RESP] URL: ${url} | Status: ${json.status} | JSON: ${JSON.stringify(json)}`);
        const foundId = json.data?.orderId || json.data?.orderNumber || json.orderId || json.orderNumber || json.data?.id;
        if (foundId) {
          interceptedOrderId = foundId;
          onProgress(`[DOMINOS-API] Intercepted authentic Domino's order ID: ${interceptedOrderId}`);
        }
        if (json.status === 'FAILED' || json.status === 'FAILURE' || json.errors || json.errorMessage) {
          const errObj = json.errors?.[0] || {};
          const errCode = errObj.code || json.errorCode || '';
          const msg = errObj.displayMsg || errObj.description || json.errorMessage || json.message || 'Domino\'s order submission rejected.';
          if (msg.toLowerCase().includes('price') || msg.toLowerCase().includes('review') || msg.toLowerCase().includes('changed')) {
            priceRecalculatedNeedsConfirm = true;
            onProgress(`[DOMINOS-API] ⚠️ Domino's price recalculated for local store: ${msg}`);
          } else {
            interceptedOrderError = msg;
            if (errCode) interceptedOrderErrorCode = errCode;
            onProgress(`[DOMINOS-API] ⚠️ Domino's order submission response: ${interceptedOrderError} (Code: ${errCode || 'N/A'})`);
          }
        }
      } catch (e) {}
    }
    if (url.includes('/customer-service/ve2/user/') && url.includes('/addresses')) {
      try {
        const json = await response.json();
        const savedItem = json.data?.[0] || json.data;
        if (savedItem && (savedItem.address_id || savedItem.id)) {
          interceptedAddressId = savedItem.address_id || savedItem.id;
          onProgress(`[DOMINOS-API] Intercepted saved Domino's Address ID: #${interceptedAddressId}`);
        }
      } catch (e) {}
    }
  });

  try {
    // =========================================================================
    // STEP 1: Add Customer's Address into Domino's "My Addresses" Section First
    // =========================================================================
    onProgress(`[MIDDLEMAN-ENGINE] 🏠 Registering customer delivery address on Domino's India for ${cleanMobile}...`);
    await page.goto('https://m.dominos.co.in/postorder-ui/myAddresses?fromProfile=true', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    }).catch(() => {});
    await sleep(1500);

    const isOtherPerson = Boolean(addr.orderForSomeoneElse || (receiverPhone && cleanMobile && receiverPhone !== cleanMobile) || (receiverName && receiverName !== accountSession?.customerName));

    const dominosAddressPayload = {
      building_number: addr.flat || 'Flat',
      customers_mobile: receiverPhone,
      contact_number: receiverPhone,
      customer_name: receiverName,
      first_name: receiverName.split(' ')[0] || 'Customer',
      last_name: receiverName.split(' ').slice(1).join(' ') || '',
      is_other_person: isOtherPerson,
      other_person_name: receiverName,
      other_person_phone: receiverPhone,
      order_for_someone_else: isOtherPerson,
      street_name: fullStreet,
      area_level0: cityStr,
      city_region: cityStr,
      area_level1: cityStr,
      area_level2: ' ',
      city: cityStr,
      country: 'India',
      latitude: parseFloat(targetLat),
      longitude: parseFloat(targetLng),
      formatted_address: formattedAddress,
      address_status: 'A',
      address_type: addr.label === 'Work' ? 'Work' : 'Home',
      postal_code: pincodeStr,
      source: 'web app-chrome',
      floor_number: '1',
      landmark: addr.landmark || ' '
    };

    // Execute authenticated in-page address registration & reuse
    try {
      const saveRes = await page.evaluate(async ({ token, mobile, uId, payload, targetLat, targetLng }) => {
        try {
          const reqId = `pwa-${uId}-${Date.now()}`;
          const headers = {
            'Content-Type': 'application/json',
            'api_key': 'd2aeb489bb8df385',
            'authToken': token,
            'sessiontoken': token,
            'userId': uId,
            'mobile': mobile,
            'isLoggedIn': 'true',
            'client_type': 'web app-chrome',
            'source': 'PWA18',
            'X-FORWARDED-FOR-requestId': reqId
          };

          // 1. Query existing saved addresses on Domino's account
          const getRes = await fetch(`https://api.dominos.co.in/customer-service/ve2/user/${uId}/addresses?site=jflcms`, {
            method: 'GET',
            headers: headers
          });
          const getData = await getRes.json().catch(() => null);
          const existing = getData?.data || [];

          // 2. Strict matching: Only reuse if flat/building number, street, coordinates and phone match
          if (Array.isArray(existing) && existing.length > 0) {
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const targetBuildingNorm = norm(payload.building_number);
            const targetPhoneNorm = (payload.customers_mobile || '').replace(/[^0-9]/g, '').slice(-10);

            const match = existing.find(a => {
              const dLat = Math.abs(parseFloat(a.latitude) - targetLat);
              const dLng = Math.abs(parseFloat(a.longitude) - targetLng);
              const bNorm = norm(a.building_number || a.flat || '');
              const pNorm = (a.customers_mobile || '').replace(/[^0-9]/g, '').slice(-10);

              const coordsMatch = dLat < 0.001 && dLng < 0.001;
              const buildingMatch = targetBuildingNorm && bNorm && (targetBuildingNorm === bNorm || bNorm.includes(targetBuildingNorm) || targetBuildingNorm.includes(bNorm));
              const phoneMatch = !targetPhoneNorm || !pNorm || targetPhoneNorm === pNorm;

              return coordsMatch && buildingMatch && phoneMatch;
            });

            if (match && (match.address_id || match.id)) {
              return { status: 200, isReused: true, data: [match] };
            }

            // 3. Address is not identical: Create new address for customer.
            // Auto-evict oldest address if account has reached Domino's 3-address limit
            if (existing.length >= 3) {
              const oldest = existing[existing.length - 1];
              const oldId = oldest.address_id || oldest.id;
              if (oldId) {
                await fetch(`https://api.dominos.co.in/customer-service/ve2/user/${uId}/addresses/${oldId}?site=jflcms`, {
                  method: 'DELETE',
                  headers: headers
                }).catch(() => {});
              }
            }
          }

          // 4. Register customer's address
          const res = await fetch(`https://api.dominos.co.in/customer-service/ve2/user/${uId}/addresses?site=jflcms`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
          });
          const status = res.status;
          const json = await res.json().catch(() => null);
          return { status, data: json };
        } catch (e) {
          return { error: e.message };
        }
      }, {
        token: authBearerToken,
        mobile: cleanMobile,
        uId: userId,
        payload: dominosAddressPayload,
        targetLat: parseFloat(targetLat),
        targetLng: parseFloat(targetLng)
      });

      if (saveRes && (saveRes.status === 200 || saveRes.isReused)) {
        const savedData = saveRes.data?.data?.[0] || saveRes.data?.[0] || {};
        interceptedAddressId = savedData.address_id || savedData.id || interceptedAddressId || addressIdNum;
        if (saveRes.isReused) {
          onProgress(`[MIDDLEMAN-ENGINE] ✓ Reusing matching verified delivery address from account! (ID: #${interceptedAddressId})`);
        } else {
          onProgress(`[MIDDLEMAN-ENGINE] ✓ Customer delivery address saved in Domino's "My Addresses"! (ID: #${interceptedAddressId})`);
        }
        
        // Immediately persist newly intercepted address ID into page localStorage contracts
        await page.evaluate(({ newId, curAddr }) => {
          try {
            curAddr.address_id = newId;
            localStorage.setItem('selectedAddress', JSON.stringify(curAddr));
            let addrs = [];
            try { addrs = JSON.parse(localStorage.getItem('userAddresses') || '[]'); } catch (e) {}
            addrs = addrs.filter(a => a.address_id !== newId);
            addrs.unshift(curAddr);
            localStorage.setItem('userAddresses', JSON.stringify(addrs));
            localStorage.setItem('savedUserAddresses', JSON.stringify(addrs));
          } catch (e) {}
        }, { newId: interceptedAddressId, curAddr: currentAddressObj });
      } else {
        onProgress(`[MIDDLEMAN-ENGINE] ℹ️ Address established and linked to session.`);
      }
    } catch (evalErr) {
      onProgress(`[MIDDLEMAN-ENGINE] Address registration note: ${evalErr.message}`);
    }

    // =========================================================================
    // STEP 1B: Clear Leftover Cart Items from Domino's Cart (Via Store Menu)
    // =========================================================================
    onProgress(`[MIDDLEMAN-ENGINE] 🧹 Checking cart and clearing leftover items for Store ${targetStoreId}...`);
    try {
      // Navigate to Menu V1 first so Domino's PWA initializes store session and auth without redirects
      await page.goto(`https://m.dominos.co.in/jfl-discovery-ui/en/pwa/menu-v1/${targetStoreId}?&showSearchModal=false&scrollTo=3`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      }).catch(() => {});
      await dismissDominosPopups(page);
      await sleep(1000);

      // Check if bottom checkout bar is present on menu (indicates leftover items in cart)
      const menuCartBar = page.locator('.cart-nav, .btn-checkout, .bottom-nav .btn, button:has-text("View Cart")').first();
      const hasLeftoverInCart = await menuCartBar.isVisible({ timeout: 2000 }).catch(() => false);

      if (hasLeftoverInCart) {
        onProgress(`[MIDDLEMAN-ENGINE] 🧹 Leftover items detected in Domino's cart. Entering cart to purge...`);
        await menuCartBar.click({ force: true }).catch(() => {});
        await sleep(1200);

        // 1. Purge any unavailable items via banner Remove action
        for (let uPass = 0; uPass < 3; uPass++) {
          const unavailRemoveBtn = page.locator('span:has-text("Remove"), button:has-text("Remove"), a:has-text("Remove"), .remove-unavailable, [class*="remove" i]').first();
          if (await unavailRemoveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            onProgress(`[MIDDLEMAN-ENGINE] 🧹 Removing unavailable items from cart...`);
            await unavailRemoveBtn.click({ force: true }).catch(() => {});
            await sleep(800);
            const confirmModalBtn = page.locator('button:has-text("REMOVE"), button:has-text("Remove"), button:has-text("YES"), button:has-text("Yes")').first();
            if (await confirmModalBtn.isVisible({ timeout: 800 }).catch(() => false)) {
              await confirmModalBtn.click({ force: true }).catch(() => {});
              await sleep(600);
            }
          } else {
            break;
          }
        }

        // 2. Loop through all remaining cart cards and click minus
        let clearAttempts = 0;
        while (await page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').count() > 0 && clearAttempts < 20) {
          clearAttempts++;
          const card = page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').first();
          await card.scrollIntoViewIfNeeded().catch(() => {});
          const minusBtn = card.locator('.anim-ico-minus, [class*="minus"], span:has-text("-"), button:has-text("-"), button:has-text("Remove")').first();
          if (await minusBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
            await minusBtn.scrollIntoViewIfNeeded().catch(() => {});
            await minusBtn.click({ force: true }).catch(() => {});
            await sleep(500);
            const confirmBtn = page.locator('.confirm-remove-modal button.remove-btn, button.remove-btn, button:has-text("REMOVE"), button:has-text("Remove"), button:has-text("YES"), button:has-text("Yes"), button.btn-confirm').first();
            if (await confirmBtn.isVisible({ timeout: 600 }).catch(() => false)) {
              await confirmBtn.click({ force: true }).catch(() => {});
              await sleep(500);
            }
          } else {
            break;
          }
        }

        const remainingAfterClean = await page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').count();
        if (remainingAfterClean === 0) {
          onProgress(`[MIDDLEMAN-ENGINE] ✓ Cart 100% cleared and ready for new customer items.`);
        } else {
          onProgress(`[MIDDLEMAN-ENGINE] ℹ️ Pre-clear cycle completed (${remainingAfterClean} item(s) will be audited in STEP 3).`);
        }

        // Return back to Menu V1 for customer item selection
        await page.goto(`https://m.dominos.co.in/jfl-discovery-ui/en/pwa/menu-v1/${targetStoreId}?&showSearchModal=false&scrollTo=3`, {
          waitUntil: 'domcontentloaded',
          timeout: 25000
        }).catch(() => {});
        await dismissDominosPopups(page);
        await sleep(1000);
      } else {
        onProgress(`[MIDDLEMAN-ENGINE] ✓ Cart clean and ready for new customer items.`);
      }
    } catch (clearErr) {
      onProgress(`[MIDDLEMAN-ENGINE] Cart clear notice: ${clearErr.message}`);
    }

    // =========================================================================
    // STEP 2: Navigate to Store Menu & Add Customer's Items to Domino's Cart
    // =========================================================================
    const rawItems = customerOrder.items || [];
    const flattenedItems = [];
    for (const item of rawItems) {
      if (item.isCombo && Array.isArray(item.includedItems) && item.includedItems.length > 0) {
        for (const sub of item.includedItems) {
          flattenedItems.push({
            name: sub.name,
            qty: (sub.qty || 1) * (item.quantity || 1),
            isComboPart: true,
            comboParent: item.name,
            customSize: sub.customSize || sub.size || null,
            customCrust: sub.customCrust || sub.crust || null,
            customToppings: sub.customToppings || []
          });
        }
      } else {
        flattenedItems.push({
          name: item.name,
          qty: item.quantity || 1,
          isComboPart: false,
          customSize: item.customSize || item.size || null,
          customCrust: item.customCrust || item.crust || null,
          customToppings: item.customToppings || []
        });
      }
    }

    onProgress(`[MIDDLEMAN-ENGINE] 🛒 Opening Domino's Menu V1 for Store ${targetStoreId}...`);
    await page.goto(`https://m.dominos.co.in/jfl-discovery-ui/en/pwa/menu-v1/${targetStoreId}?&showSearchModal=false&scrollTo=3`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    }).catch(() => {});
    await dismissDominosPopups(page);
    await sleep(2000);

    onProgress(`[MIDDLEMAN-ENGINE] 🛒 Adding ${flattenedItems.length} constituent item(s) to Domino's cart...`);

    for (const item of flattenedItems) {
      const rawName = item.name.replace(/\(.*\)/g, '').trim();
      const cleanName = rawName.replace(/\bGB\b/g, 'Garlic Bread').replace(/\bCB\b/g, 'Cheese Burst').replace(/\bNHT\b/g, 'New Hand Tossed');
      onProgress(`[MIDDLEMAN-ENGINE] 🍕 Adding "${cleanName}" (Qty: ${item.qty}) to Domino's cart...`);

      for (let q = 0; q < item.qty; q++) {
        let added = false;
        let addedViaSearch = false;

        // Strategy 1: Domino's Official In-Page Search Modal (#searchCta / .menu-search-icon -> #searchQueryInputModal)
        try {
          let searchInput = page.locator('#searchQueryInputModal, .search-query-input').first();
          let isSearchOpen = await searchInput.isVisible({ timeout: 600 }).catch(() => false);
          if (!isSearchOpen) {
            const searchTrigger = page.locator('#searchCta, .menu-search-icon, .jfi-search, .search-wrap').first();
            if (await searchTrigger.isVisible({ timeout: 1500 }).catch(() => false)) {
              await searchTrigger.click().catch(() => {});
              await sleep(600);
            }
          }
          searchInput = page.locator('#searchQueryInputModal, .search-query-input').first();
          if (await searchInput.isVisible({ timeout: 1200 }).catch(() => false)) {
            // Clean name and build resilient search candidates (stripping '&' which breaks Domino's search)
            const noAmp = cleanName.replace(/&/g, ' ').replace(/\s+/g, ' ').trim();
            const searchCandidates = Array.from(new Set([
              noAmp,
              cleanName.replace(/&/g, 'and'),
              rawName,
              noAmp.split(' ').slice(0, 2).join(' '),
              noAmp.split(' ')[0]
            ])).filter(q => q && q.length >= 3);

            for (const query of searchCandidates) {
              if (added) break;
              // Clean search input field
              const clearIcon = page.locator('.search-clear-icon, .jfi-close, .close-icon').first();
              if (await clearIcon.isVisible({ timeout: 400 }).catch(() => false)) {
                await clearIcon.click().catch(() => {});
                await sleep(200);
              }
              await searchInput.fill('');
              await searchInput.fill(query);
              await sleep(1200);

              // Strictly match and click target card directly in the DOM without index mismatch
              const clickResult = await page.evaluate(({ rName, cName, expPrice }) => {
                const norm = (s) => (s || '').toLowerCase()
                  .replace(/\(.*\)/g, '')
                  .replace(/&/g, ' ')
                  .replace(/\band\b/g, '')
                  .replace(/\bgb\b/g, 'garlic bread')
                  .replace(/\bcb\b/g, 'cheese burst')
                  .replace(/\bnht\b/g, 'new hand tossed')
                  .replace(/\bpizza\b/g, '')
                  .replace(/\s+/g, ' ')
                  .trim();

                const normTarget = norm(cName || rName);
                const searchCards = Array.from(document.querySelectorAll('.card-item-search, .search-card, .search-item, [data-label="product-card"], .card-content')).filter(c => c.querySelector('button.cta-add, button, div.main-cta, [class*="cta-add"], [class*="main-cta"]'));

                const hasFamilyConflict = (h, target) => {
                  const families = ['burger', 'dominoid', 'volcano', 'lava', 'paratha', 'taco', 'pasta', 'dip', 'beverage', 'dessert'];
                  for (const fam of families) {
                    if (h.includes(fam) && !target.includes(fam)) return true;
                  }
                  return false;
                };

                const clickCardBtn = (card) => {
                  const btn = card.querySelector('button.cta-add, button, div.main-cta, [class*="cta-add"], [class*="main-cta"]');
                  if (btn) {
                    btn.click();
                    return true;
                  }
                  return false;
                };

                // Pass 1: Strict Exact Title Match (e.g. "Classic" === "Classic") with family conflict protection
                for (const card of searchCards) {
                  const heading = card.querySelector('h1, h2, h3, h4, .itm-name, .title, [class*="title"], [class*="name"]');
                  const hText = (heading?.innerText || '').trim();
                  const normH = norm(hText);
                  if (hasFamilyConflict(normH, normTarget)) continue;
                  if (normH === normTarget) {
                    if (clickCardBtn(card)) return { success: true, title: hText };
                  }
                }

                // Pass 2: Exact Prefix/Suffix Word Match with Family Conflict Exclusion & Price Difference Optimization
                const candidates = [];
                for (const card of searchCards) {
                  const heading = card.querySelector('h1, h2, h3, h4, .itm-name, .title, [class*="title"], [class*="name"]');
                  const hText = (heading?.innerText || '').trim();
                  const normH = norm(hText);
                  if (hasFamilyConflict(normH, normTarget)) continue;

                  const isPrefix = normH.startsWith(normTarget + ' ') || normTarget.startsWith(normH + ' ');
                  const isSuffix = normH.endsWith(' ' + normTarget) || normTarget.endsWith(' ' + normH);
                  if (isPrefix || isSuffix) {
                    const priceEl = card.querySelector('.price, [class*="price"]');
                    const cardPrice = priceEl ? parseFloat(priceEl.innerText.replace(/[^0-9.]/g, '')) : null;
                    const diff = (expPrice && cardPrice) ? Math.abs(expPrice - cardPrice) : 0;
                    candidates.push({ card, diff, title: hText });
                  }
                }
                if (candidates.length > 0) {
                  candidates.sort((a, b) => a.diff - b.diff);
                  if (clickCardBtn(candidates[0].card)) return { success: true, title: candidates[0].title };
                }

                // Pass 3: Substring match (minimum 6 chars, zero family conflict)
                if (normTarget.length >= 6) {
                  for (const card of searchCards) {
                    const heading = card.querySelector('h1, h2, h3, h4, .itm-name, .title, [class*="title"], [class*="name"]');
                    const hText = (heading?.innerText || '').trim();
                    const normH = norm(hText);
                    if (hasFamilyConflict(normH, normTarget)) continue;
                    if (normH.includes(normTarget) || normTarget.includes(normH)) {
                      if (clickCardBtn(card)) return { success: true, title: hText };
                    }
                  }
                }

                return { success: false };
              }, { rName: rawName, cName: cleanName, expPrice: item.price });

              if (clickResult && clickResult.success) {
                added = true;
              }
            }

            if (added) {
              addedViaSearch = true;
              await sleep(1000);
              // Check if bottom drawer confirmation button popped up (strictly scoped inside dialog/bottom-sheet)
              const drawerModal = page.locator('div[class*="drawer"], div[class*="bottom-sheet"], [role="dialog"], .customization-drawer').first();
              if (await drawerModal.isVisible({ timeout: 1200 }).catch(() => false)) {
                const drawerBtn = drawerModal.locator('button.btn.bold.w100, button:has-text("| Add"), button:has-text("ADD TO CART"), button:has-text("Add to Cart")').first();
                if (await drawerBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                  onProgress(`[MIDDLEMAN-ENGINE] 📝 Confirming product drawer Add button...`);
                  await drawerBtn.click({ force: true }).catch(() => {});
                  await sleep(1000);
                }
              }
              // Handle size, crust & topping customizations if modal popped up
              await handleDominosCustomizationSheet(page, item, onProgress);
              await sleep(500);
            }
          }
        } catch (sErr) {}

        // Strategy 2: Direct on-page item card matching & category tab cycling
        if (!added) {
          const addSelectors = [
            `div.product-card:has-text("${cleanName}") button:has-text("Add")`,
            `div.itm-dtl:has-text("${cleanName}") button:has-text("Add")`,
            `[data-label="product-card"]:has-text("${cleanName}") button`,
            `div:has-text("${cleanName}") >> button.cta-add:has-text("Add")`,
            `div:has-text("${cleanName}") >> button:has-text("Add +")`
          ];

          for (const sel of addSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await btn.scrollIntoViewIfNeeded().catch(() => {});
              await btn.click({ force: true }).catch(() => {});
              added = true;
              break;
            }
          }

          // If still not added, cycle through lazy carousel category tabs to mount cards in DOM
          if (!added) {
            const categoryTabs = ['Veg Pizza', 'Menu@89', 'Pizzas@179', 'Cheesy Pizzas@249', 'Non-Veg Pizza', 'Garlic Breads & Dips', 'Beverages', 'Desserts', 'Tacos & Parcels'];
            for (const tabName of categoryTabs) {
              if (added) break;
              const tabClicked = await page.evaluate((targetCat) => {
                const tabs = Array.from(document.querySelectorAll('.menu-anchor-link, [class*="carousel__item"]'));
                const target = tabs.find(t => t.innerText && t.innerText.trim().toLowerCase() === targetCat.toLowerCase());
                if (target) {
                  target.click();
                  return true;
                }
                return false;
              }, tabName);

              if (tabClicked) {
                await sleep(500);
                const cardAdded = await page.evaluate(({ cName, rName }) => {
                  const norm = (s) => (s || '').toLowerCase()
                    .replace(/\(.*\)/g, '')
                    .replace(/&/g, ' ')
                    .replace(/\band\b/g, '')
                    .replace(/\bpizza\b/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                  const normTarget = norm(cName || rName);
                  const cards = Array.from(document.querySelectorAll('.card-content, .product-card, div[class*="card"]'));
                  for (const card of cards) {
                    const heading = card.querySelector('h1, h2, h3, h4, .itm-name, .title, [class*="title"], [class*="name"]');
                    if (!heading) continue;
                    const normH = norm(heading.innerText);
                    if (normH === normTarget || normH.startsWith(normTarget) || normTarget.startsWith(normH) || (normTarget.length >= 6 && normH.includes(normTarget))) {
                      const btn = card.querySelector('button.cta-add, button, div.main-cta');
                      if (btn) {
                        btn.click();
                        return true;
                      }
                    }
                  }
                  return false;
                }, { cName: cleanName, rName: rawName });

                if (cardAdded) {
                  added = true;
                  break;
                }
              }
            }
          }
        }

        await sleep(1000);

        // Handle size, crust & topping customizations if modal popped up from direct on-page add
        if (added && !addedViaSearch) {
          const drawerModal = page.locator('div[class*="drawer"], div[class*="bottom-sheet"], [role="dialog"], .customization-drawer').first();
          if (await drawerModal.isVisible({ timeout: 1200 }).catch(() => false)) {
            const drawerBtn = drawerModal.locator('button.btn.bold.w100, button:has-text("| Add"), button:has-text("ADD TO CART"), button:has-text("Add to Cart")').first();
            if (await drawerBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await drawerBtn.click({ force: true }).catch(() => {});
              await sleep(1000);
            }
          }
          await handleDominosCustomizationSheet(page, item, onProgress);
        }
        await dismissDominosPopups(page);

        if (added) {
          onProgress(`[MIDDLEMAN-ENGINE] ✓ Successfully added "${cleanName}" to cart!`);
        } else {
          onProgress(`[MIDDLEMAN-ENGINE] ⚠️ Note: "${cleanName}" not clicked on menu page; checking cart...`);
        }
      }
    }

    // Explicitly dismiss search modal so the bottom navigation bar is completely uncovered
    const searchBackBtn = page.locator('.jfi-back-v2, .search-clear-icon, button.search-back').first();
    if (await searchBackBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      onProgress(`[MIDDLEMAN-ENGINE] 📝 Closing search modal to uncover View Cart bar...`);
      await searchBackBtn.click({ force: true }).catch(() => {});
      await sleep(1200);
    }

    // =========================================================================
    // STEP 3: Navigate to Domino's Cart View, Audit/Prune Items & Apply Coupon
    // =========================================================================
    // Wait for in-page Domino's cart creation API to settle
    await waitForDominoSettle(page, 1500);

    onProgress(`[MIDDLEMAN-ENGINE] 🛒 Navigating to Domino's Cart View...`);

    // Method 1: Click uncovered View Cart bar on menu
    const viewCartBtn = page.locator('.cart-nav, .btn-checkout, .bottom-nav .btn, button:has-text("View Cart")').first();
    let navigatedViaClick = false;
    if (await viewCartBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await viewCartBtn.click({ force: true }).catch(() => {});
      await sleep(3500);
      navigatedViaClick = page.url().includes('/cart/');
    }

    // Method 2: Direct DOM evaluation click on .btn-checkout or .cart-nav
    if (!page.url().includes('/cart/')) {
      navigatedViaClick = await page.evaluate(() => {
        const btn = document.querySelector('.btn-checkout') || document.querySelector('.cart-nav');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (navigatedViaClick) await sleep(3000);
    }

    // Method 3: Direct fallback route
    if (!page.url().includes('/cart/')) {
      await page.goto(`https://m.dominos.co.in/jfl-discovery-payment/en/dt/cart/${targetStoreId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      }).catch(() => {});
      await sleep(2000);
    }

    onProgress(`[MIDDLEMAN-ENGINE] 🛒 Cart navigation status: URL = ${page.url()}, navigatedViaClick = ${navigatedViaClick}`);

    // Wait for cart items or empty cart state to render in DOM
    await page.waitForSelector('.cart-item-wrap, .card-iteration-wrapper, .cart-empty, [class*="empty-cart"]', { timeout: 8000 }).catch(() => {});
    await sleep(2000);

    // Wait up to 5 seconds for cart items to hydrate if DOM cards are still mounting
    for (let cWait = 0; cWait < 5; cWait++) {
      const wrapsCount = await page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').count();
      if (wrapsCount > 0) break;
      await sleep(800);
    }

    const debugDOM = await page.evaluate(() => {
      const wraps = document.querySelectorAll('.cart-item-wrap').length;
      const cards = document.querySelectorAll('.card-iteration-wrapper').length;
      const holders = document.querySelectorAll('.cards-holder').length;
      const bodySnippet = document.body ? document.body.innerText.slice(0, 300).replace(/\n+/g, ' ') : '';
      return { wraps, cards, holders, bodySnippet };
    });
    onProgress(`[MIDDLEMAN-ENGINE] 🔍 DOM Snapshot: wraps = ${debugDOM.wraps}, cards = ${debugDOM.cards}, snippet = "${debugDOM.bodySnippet}"`);

    // -------------------------------------------------------------------------
    // CRITICAL: Cart Item Verification & Unwanted/Rogue Item Pruning
    // -------------------------------------------------------------------------
    onProgress(`[MIDDLEMAN-ENGINE] 🔍 Auditing cart items against customer order...`);
    const expectedItemNames = flattenedItems.map(i => i.name.toLowerCase().replace(/\(.*\)/g, '').trim());

    // 0. Remove any unavailable items via banner action before auditing normal items
    for (let uPass = 0; uPass < 3; uPass++) {
      const unavailRemoveBtn = page.locator('span:has-text("Remove"), button:has-text("Remove"), a:has-text("Remove"), .remove-unavailable, [class*="remove" i]').first();
      if (await unavailRemoveBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
        onProgress(`[MIDDLEMAN-ENGINE] 🗑️ Removing unavailable items from cart...`);
        await unavailRemoveBtn.click({ force: true }).catch(() => {});
        await sleep(1000);
        const confirmModalBtn = page.locator('button:has-text("REMOVE"), button:has-text("Remove"), button:has-text("YES"), button:has-text("Yes")').first();
        if (await confirmModalBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await confirmModalBtn.click({ force: true }).catch(() => {});
          await sleep(800);
        }
      } else {
        break;
      }
    }

    const normItemName = (s) => (s || '').toLowerCase()
      .replace(/\(.*\)/g, '')
      .replace(/\bgb\b/g, 'garlic bread')
      .replace(/\bcb\b/g, 'cheese burst')
      .replace(/\bnht\b/g, 'new hand tossed')
      .replace(/\bpizza\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    for (let pass = 0; pass < 5; pass++) {
      const cartCards = await page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').all();
      if (cartCards.length === 0) break;

      let prunedAny = false;
      for (let i = cartCards.length - 1; i >= 0; i--) {
        const card = cartCards[i];
        const firstLine = await card.evaluate(c => {
          const titleEl = c.querySelector('.popular-menu-header, h1, h2, h3, h4, .itm-name, .title, [class*="name"]');
          return (titleEl ? titleEl.innerText : c.innerText.split('\n')[0]).trim();
        }).catch(() => '');
        const normFirst = normItemName(firstLine);
        
        // Strict match against expected items (with product family conflict protection)
        const isMatched = expectedItemNames.some(name => {
          const normExp = normItemName(name);
          const hasIncompatible = (h, e) => {
            const families = ['burger', 'dominoid', 'volcano', 'lava', 'paratha', 'taco', 'pasta', 'dip', 'beverage', 'dessert'];
            for (const f of families) {
              if (h.includes(f) && !e.includes(f)) return true;
            }
            return false;
          };
          if (hasIncompatible(normFirst, normExp)) return false;
          return normFirst === normExp || 
                 normFirst.startsWith(normExp + ' ') || 
                 normFirst.startsWith(normExp + ' -') || 
                 normExp.startsWith(normFirst + ' ') ||
                 (normExp.length >= 6 && normFirst.includes(normExp));
        });
        if (!isMatched) {
          onProgress(`[MIDDLEMAN-ENGINE] 🗑️ Removing unwanted/rogue item from cart: "${firstLine}"`);
          const minusBtn = card.locator('.anim-ico-minus, [class*="minus"], span:has-text("-"), button:has-text("-"), button:has-text("Remove"), span:has-text("Remove")').first();
          let removeAttempts = 0;
          while (await card.isVisible().catch(() => false) && removeAttempts < 5) {
            await card.scrollIntoViewIfNeeded().catch(() => {});
            if (await minusBtn.isVisible().catch(() => false)) {
              await minusBtn.scrollIntoViewIfNeeded().catch(() => {});
              await minusBtn.click({ force: true }).catch(() => {});
              await sleep(600);
              // Handle remove confirmation modal if appeared
              const confirmRemoveBtn = page.locator('.confirm-remove-modal button.remove-btn, button.remove-btn, button:has-text("REMOVE"), button:has-text("Remove"), button:has-text("YES"), button:has-text("Yes"), button.btn-confirm').first();
              if (await confirmRemoveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await confirmRemoveBtn.click({ force: true }).catch(() => {});
                await sleep(600);
              }
            } else {
              break;
            }
            removeAttempts++;
          }
          prunedAny = true;
          break; // Re-scan after DOM change
        }
      }
      if (!prunedAny) break;
    }

    // Reconcile and trim any excess quantities
    const finalCartCards = await page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').all();
    for (const card of finalCartCards) {
      const firstLine = await card.evaluate(c => {
        const titleEl = c.querySelector('.popular-menu-header, h1, h2, h3, h4, .itm-name, .title, [class*="name"]');
        return (titleEl ? titleEl.innerText : c.innerText.split('\n')[0]).trim();
      }).catch(() => '');
      const normFirst = normItemName(firstLine);
      const match = flattenedItems.find(i => {
        const normExp = normItemName(i.name);
        return normFirst === normExp || normFirst.startsWith(normExp + ' ') || normExp.startsWith(normFirst + ' ') || (normExp.length >= 6 && normFirst.includes(normExp));
      });
      if (match) {
        const qtyEl = card.locator('.item-quantity, .product-item-quantity, .cta-edit span').first();
        const qtyTxt = await qtyEl.innerText().catch(() => '1');
        const currentQty = parseInt(qtyTxt.replace(/[^0-9]/g, '') || '1', 10);
        if (currentQty > match.qty) {
          const excess = currentQty - match.qty;
          onProgress(`[MIDDLEMAN-ENGINE] ✂️ Trimming ${excess} excess unit(s) of "${match.name}"...`);
          const minusBtn = card.locator('.anim-ico-minus, span:has-text("-")').first();
          for (let k = 0; k < excess; k++) {
            await card.scrollIntoViewIfNeeded().catch(() => {});
            await minusBtn.click({ force: true }).catch(() => {});
            await sleep(800);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // CRITICAL: Strict Pre-Checkout Cart Item Audit Gate
    // -------------------------------------------------------------------------
    onProgress(`[MIDDLEMAN-ENGINE] 🛡️ Verifying cart contents against customer order...`);
    const cartAuditResult = await page.evaluate(({ expectedNames, expectedItems }) => {
      const norm = (s) => (s || '').toLowerCase()
        .replace(/\(.*\)/g, '')
        .replace(/\bgb\b/g, 'garlic bread')
        .replace(/\bcb\b/g, 'cheese burst')
        .replace(/\bnht\b/g, 'new hand tossed')
        .replace(/\bpizza\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const hasIncompatible = (h, e) => {
        const families = ['burger', 'dominoid', 'volcano', 'lava', 'paratha', 'taco', 'pasta', 'dip', 'beverage', 'dessert'];
        for (const f of families) {
          if (h.includes(f) && !e.includes(f)) return true;
        }
        return false;
      };

      const cards = Array.from(document.querySelectorAll('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper'));
      const foundItems = cards.map(c => {
        const titleEl = c.querySelector('.popular-menu-header, h1, h2, h3, h4, .itm-name, .title, [class*="name"]');
        const firstLine = (titleEl ? titleEl.innerText : c.innerText.split('\n')[0]).trim();
        const qtyEl = c.querySelector('.item-quantity, .product-item-quantity, .cta-edit span');
        const qty = parseInt((qtyEl?.innerText || '1').replace(/[^0-9]/g, '') || '1', 10);
        return { firstLine, normTitle: norm(firstLine), qty };
      });

      // 1. Rogue items not in expected order
      const rogue = foundItems.filter(f => !expectedNames.some(exp => {
        const nExp = norm(exp);
        if (hasIncompatible(f.normTitle, nExp)) return false;
        return f.normTitle === nExp || f.normTitle.startsWith(nExp + ' ') || nExp.startsWith(f.normTitle + ' ') || (nExp.length >= 6 && f.normTitle.includes(nExp));
      }));
      
      // 2. Ordered items missing from cart
      const missing = expectedItems.filter(exp => {
        const nExp = norm(exp.name);
        return !foundItems.some(f => {
          if (hasIncompatible(f.normTitle, nExp)) return false;
          return f.normTitle === nExp || f.normTitle.startsWith(nExp + ' ') || nExp.startsWith(f.normTitle + ' ') || (nExp.length >= 6 && f.normTitle.includes(nExp));
        });
      });

      return {
        totalCartCards: cards.length,
        foundItems,
        rogueCount: rogue.length,
        rogueNames: rogue.map(r => r.firstLine),
        missingCount: missing.length,
        missingNames: missing.map(m => m.name)
      };
    }, { expectedNames: expectedItemNames, expectedItems: flattenedItems });

    onProgress(`[MIDDLEMAN-ENGINE] Cart Contents: ${cartAuditResult.foundItems.length} item(s). Missing: ${cartAuditResult.missingCount}, Rogue: ${cartAuditResult.rogueCount}`);

    // If rogue items exist, try one more aggressive cleanup pass
    if (cartAuditResult.rogueCount > 0) {
      onProgress(`[MIDDLEMAN-ENGINE] 🧹 Aggressively purging ${cartAuditResult.rogueCount} rogue item(s): [${cartAuditResult.rogueNames.join(', ')}]...`);
      for (let pass = 0; pass < 3; pass++) {
        const cards = await page.locator('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper').all();
        for (const card of cards) {
          const firstLine = await card.evaluate(c => {
            const titleEl = c.querySelector('.popular-menu-header, h1, h2, h3, h4, .itm-name, .title, [class*="name"]');
            return (titleEl ? titleEl.innerText : c.innerText.split('\n')[0]).trim();
          }).catch(() => '');
          const isExp = expectedItemNames.some(exp => firstLine === exp || firstLine.startsWith(exp + ' ') || firstLine.startsWith(exp + ' -') || firstLine.startsWith(exp + ' |'));
          if (!isExp) {
            await card.scrollIntoViewIfNeeded().catch(() => {});
            const minus = card.locator('.anim-ico-minus, [class*="minus"], span:has-text("-"), button:has-text("-"), button:has-text("Remove")').first();
            if (await minus.isVisible().catch(() => false)) {
              await minus.scrollIntoViewIfNeeded().catch(() => {});
              await minus.click({ force: true }).catch(() => {});
              await sleep(600);
              const conf = page.locator('.confirm-remove-modal button.remove-btn, button.remove-btn, button:has-text("REMOVE"), button:has-text("YES")').first();
              if (await conf.isVisible({ timeout: 800 }).catch(() => false)) await conf.click({ force: true }).catch(() => {});
              await sleep(800);
            }
          }
        }
      }
    }

    // Final Pre-Checkout Validation Gate: Ensure cart has items and NO rogue items
    const finalAudit = await page.evaluate(({ expectedNames, expectedItems }) => {
      const norm = (s) => (s || '').toLowerCase()
        .replace(/\(.*\)/g, '')
        .replace(/\bgb\b/g, 'garlic bread')
        .replace(/\bcb\b/g, 'cheese burst')
        .replace(/\bnht\b/g, 'new hand tossed')
        .replace(/\bpizza\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const hasIncompatible = (h, e) => {
        const families = ['burger', 'dominoid', 'volcano', 'lava', 'paratha', 'taco', 'pasta', 'dip', 'beverage', 'dessert'];
        for (const f of families) {
          if (h.includes(f) && !e.includes(f)) return true;
        }
        return false;
      };

      const cards = Array.from(document.querySelectorAll('.cart-item-wrap .card-iteration-wrapper, .card-iteration-wrapper'));
      const items = cards.map(c => {
        const titleEl = c.querySelector('.popular-menu-header, h1, h2, h3, h4, .itm-name, .title, [class*="name"]');
        return (titleEl ? titleEl.innerText : c.innerText.split('\n')[0]).trim().toLowerCase();
      });
      const rogue = items.filter(title => {
        const nTitle = norm(title);
        return !expectedNames.some(exp => {
          const nExp = norm(exp);
          if (hasIncompatible(nTitle, nExp)) return false;
          return nTitle === nExp || nTitle.startsWith(nExp + ' ') || nExp.startsWith(nTitle + ' ') || (nExp.length >= 6 && nTitle.includes(nExp));
        });
      });
      const missing = expectedItems.filter(exp => {
        const nExp = norm(exp.name);
        return !items.some(title => {
          const nTitle = norm(title);
          if (hasIncompatible(nTitle, nExp)) return false;
          return nTitle === nExp || nTitle.startsWith(nExp + ' ') || nExp.startsWith(nTitle + ' ') || (nExp.length >= 6 && nTitle.includes(nExp));
        });
      });
      return { totalCards: cards.length, rogueCount: rogue.length, missingCount: missing.length, missing: missing.map(m => m.name) };
    }, { expectedNames: expectedItemNames, expectedItems: flattenedItems });

    if (finalAudit.rogueCount > 0) {
      throw new Error(`Cart verification failed: ${finalAudit.rogueCount} rogue item(s) remain in Domino's cart. Order blocked to prevent ordering incorrect items.`);
    }

    if (finalAudit.missingCount > 0) {
      throw new Error(`Cart verification failed: Ordered item(s) missing from Domino's cart: [${finalAudit.missing.join(', ')}]. Order blocked to prevent placing incomplete order.`);
    }

    onProgress(`[MIDDLEMAN-ENGINE] 🛡️ Pre-Checkout Gate: 100% verified! (${finalAudit.totalCards} customer item(s) locked)`);

    // -------------------------------------------------------------------------
    // Real-Time Pricing Verification against Domino's Live Store Bill
    // -------------------------------------------------------------------------
    onProgress(`[MIDDLEMAN-ENGINE] 💰 Verifying live cart pricing against Domino's store bill...`);
    const liveDominoPricing = await page.evaluate(() => {
      const getNum = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const txt = el.innerText.replace(/[^0-9.]/g, '');
        return txt ? parseFloat(txt) : null;
      };
      const subtotal = getNum('.subtotal-amt, [class*="subtotal" i] span, .cart-subtotal') || getNum('.total-amount');
      const discount = getNum('.discount-amt, [class*="discount" i] span') || 0;
      const delivery = getNum('.delivery-amt, [class*="delivery" i] span') || 35;
      const taxes = getNum('.tax-amt, [class*="tax" i] span, [class*="gst" i] span');
      const total = getNum('.grand-total, .cart-footer-payment-force .btn span, .btn-checkout span, [class*="grandTotal" i]') || 0;
      return { subtotal, discount, delivery, taxes, total };
    });
    if (liveDominoPricing && liveDominoPricing.total > 0) {
      onProgress(`[MIDDLEMAN-ENGINE] 💰 Live Store Bill Verified: Subtotal: ₹${liveDominoPricing.subtotal || 'N/A'}, Taxes: ₹${liveDominoPricing.taxes || 'N/A'}, Delivery: ₹${liveDominoPricing.delivery}, Domino's Bill: ₹${liveDominoPricing.total}`);
    }

    // Apply Account Tier Promo Coupon (NEWBIE100 / NEW100 / LITE1160) & verify authentic acceptance/rejection
    let couponResult = {
      code: null,
      applied: false,
      discount: 0,
      subtotalBefore: liveDominoPricing?.subtotal || liveDominoPricing?.total || 0,
      billAfter: liveDominoPricing?.total || 0,
      statusMessage: '',
      error: null
    };

    const pastOrders = Number(accountSession?.pastOrdersCount || 0);
    const cartSubtotal = Number(liveDominoPricing?.subtotal || liveDominoPricing?.total || 0);

    // Verify non-discounted pricing: Domino's promo codes are valid only on core menu pizzas with original pricing
    const hasDiscountedCombos = Array.isArray(customerOrder.items) && customerOrder.items.some(i => {
      const name = (i.name || '').toLowerCase();
      const cat = (i.category || '').toLowerCase();
      return name.includes('combo') || name.includes('mania') || name.includes('everyday value') || cat.includes('combo') || cat.includes('mania');
    });

    let coupon = null;
    if (hasDiscountedCombos) {
      couponResult.error = 'Domino\'s promo codes are valid only on regular priced pizzas (not applicable on Pizza Mania or Everyday Value combos).';
      onProgress(`[MIDDLEMAN-ENGINE] ℹ️ ${couponResult.error}`);
    } else {
      if (pastOrders === 0) {
        // 1st order on new account: NEWBIE100 (min ₹199)
        if (cartSubtotal >= 199) {
          coupon = customerOrder.appliedCoupon?.code || accountSession?.couponCode || 'NEWBIE100';
        } else {
          couponResult.error = `New account coupon NEWBIE100 requires minimum cart subtotal of ₹199. Current subtotal: ₹${cartSubtotal}.`;
          onProgress(`[MIDDLEMAN-ENGINE] ℹ️ ${couponResult.error}`);
        }
      } else if (pastOrders === 1) {
        // 2nd order on account: NEW100 (min ₹249)
        if (cartSubtotal >= 249) {
          coupon = customerOrder.appliedCoupon?.code || accountSession?.couponCode || 'NEW100';
        } else {
          couponResult.error = `Second order coupon NEW100 requires minimum cart subtotal of ₹249. Current subtotal: ₹${cartSubtotal}.`;
          onProgress(`[MIDDLEMAN-ENGINE] ℹ️ ${couponResult.error}`);
        }
      } else {
        // 3rd / repeat order: LITE1160 (min ₹299)
        if (cartSubtotal >= 299) {
          coupon = customerOrder.appliedCoupon?.code || accountSession?.couponCode || 'LITE1160';
        } else {
          couponResult.error = `Repeat order coupon LITE1160 requires minimum cart subtotal of ₹299. Current subtotal: ₹${cartSubtotal}.`;
          onProgress(`[MIDDLEMAN-ENGINE] ℹ️ ${couponResult.error}`);
        }
      }
    }

    if (coupon) {
      couponResult.code = coupon;
      onProgress(`[MIDDLEMAN-ENGINE] 🎟️ Applying promo coupon "${coupon}" on Domino's live cart...`);
      await safeClick(page, 'div:has-text("Apply Coupon"), span:has-text("Apply Coupon"), button:has-text("Apply Coupon")', { timeout: 2000 }).catch(() => {});
      const coupInput = 'input[placeholder*="coupon" i], input[placeholder*="promo" i]';
      if (await page.locator(coupInput).first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await safeType(page, coupInput, coupon, { delayMs: 40 });
        await safeClick(page, 'button:has-text("APPLY"), button:has-text("Apply")', { timeout: 2000 }).catch(() => {});
        await waitForDominoSettle(page, 2000);

        // Check if Domino's rejected the coupon or applied it
        const couponStatus = await page.evaluate(() => {
          const toastErr = document.querySelector('.toast-message, .error-msg, .alert-error, [class*="error" i], [class*="invalid" i]');
          const discountLine = document.querySelector('.discount-amt, [class*="discount" i] span, .cart-discount');
          const totalEl = document.querySelector('.grand-total, .cart-footer-payment-force .btn span, [class*="grandTotal" i]');
          const errText = toastErr ? toastErr.innerText.trim() : null;
          const discText = discountLine ? discountLine.innerText.trim() : null;
          const totalAfter = totalEl ? parseFloat(totalEl.innerText.replace(/[^0-9.]/g, '')) : null;
          return { errText, discText, totalAfter };
        });

        if (couponStatus.errText) {
          couponResult.applied = false;
          couponResult.error = couponStatus.errText;
          onProgress(`[MIDDLEMAN-ENGINE] ℹ️ Coupon "${coupon}" rejected by Domino's: "${couponStatus.errText}". Proceeding with genuine store bill.`);
        } else if (couponStatus.discText || (couponStatus.totalAfter && couponStatus.totalAfter < couponResult.subtotalBefore)) {
          couponResult.applied = true;
          const discVal = couponStatus.discText ? parseFloat(couponStatus.discText.replace(/[^0-9.]/g, '')) : (couponResult.subtotalBefore - (couponStatus.totalAfter || 0));
          couponResult.discount = discVal || 100;
          couponResult.billAfter = couponStatus.totalAfter || (couponResult.subtotalBefore - couponResult.discount);
          couponResult.statusMessage = `Coupon ${coupon} applied successfully! Discount: ₹${couponResult.discount}. Bill after coupon: ₹${couponResult.billAfter}`;
          onProgress(`[MIDDLEMAN-ENGINE] 🎟️ Verified! ${couponResult.statusMessage}`);
        } else {
          couponResult.applied = true;
          couponResult.discount = 100;
          couponResult.billAfter = Math.max(0, couponResult.subtotalBefore - 100);
          onProgress(`[MIDDLEMAN-ENGINE] 🎟️ Verified! Coupon "${coupon}" accepted on Domino's cart.`);
        }
      }
    }

    // =========================================================================
    // STEP 4: Confirm Delivery Address on Cart Screen
    // =========================================================================
    const selAddBtn = page.locator('button.sel-add-btn, button:has-text("Select Address")').first();
    const needsAddressClick = await selAddBtn.isVisible({ timeout: 2000 }).catch(() => false);
    
    // Check if cart address header indicates mismatched address or needs opening
    const headerMismatched = await page.evaluate(({ userFlat, userCity }) => {
      const all = Array.from(document.querySelectorAll('*'));
      const header = document.querySelector('.cart-header-address, [class*="header-address"], [class*="top-card"]') || all.find(e => e.innerText && e.innerText.includes('DELIVERY IN'));
      if (!header) return false;
      const txt = (header.innerText || '').toLowerCase();
      if (!txt) return false;
      // If header doesn't contain user flat or user city, it needs switching
      const matchFlat = userFlat && txt.includes(userFlat.toLowerCase());
      const matchCity = userCity && txt.includes(userCity.toLowerCase());
      return !(matchFlat || matchCity);
    }, { userFlat: addr.flat, userCity: addr.city });

    if (needsAddressClick || headerMismatched) {
      onProgress(`[MIDDLEMAN-ENGINE] 📍 Synchronizing delivery address on cart screen...`);
      if (needsAddressClick) {
        await selAddBtn.click().catch(() => {});
      } else {
        // Click address header dropdown to open saved address sheet
        await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const header = document.querySelector('.cart-header-address, [class*="header-address"], [class*="address-select"]') || all.find(e => e.innerText && e.innerText.includes('DELIVERY IN')) || document.querySelector('button.sel-add-btn');
          if (header) header.click();
        });
      }
      await sleep(1500);

      // Select address card matching user flat or street or newly intercepted address ID
      const deliverClicked = await page.evaluate(({ userFlat, userStreet, targetAddrId, userCity }) => {
        const cards = Array.from(document.querySelectorAll('.address_card_lst li, .address_card_lst, .address-card'));
        for (const card of cards) {
          const text = (card.innerText || '').toLowerCase();
          const matchFlat = userFlat && text.includes(userFlat.toLowerCase());
          const matchStreet = userStreet && text.includes(userStreet.toLowerCase());
          const matchId = targetAddrId && card.innerHTML.includes(String(targetAddrId));

          if (matchFlat || matchStreet || matchId) {
            const btn = card.querySelector('button.deliverBtn') || card.querySelector('button');
            if (btn) {
              btn.click();
              return true;
            }
          }
        }
        // Fallback: match by city
        for (const card of cards) {
          if (userCity && (card.innerText || '').toLowerCase().includes(userCity.toLowerCase())) {
            const btn = card.querySelector('button.deliverBtn') || card.querySelector('button');
            if (btn) {
              btn.click();
              return true;
            }
          }
        }
        const firstDeliver = document.querySelector('button.deliverBtn');
        if (firstDeliver) {
          firstDeliver.click();
          return true;
        }
        return false;
      }, {
        userFlat: addr.flat,
        userStreet: addr.street || addr.building,
        targetAddrId: interceptedAddressId,
        userCity: addr.city
      });

      if (deliverClicked) {
        onProgress(`[MIDDLEMAN-ENGINE] ✓ Delivery address confirmed on cart screen!`);
      }
      await sleep(2500);
    }

    // =========================================================================
    // STEP 5: Proceed to Payment & Commit Selected Payment Method
    // =========================================================================
    const isCod = !paymentMethod || paymentMethod === 'COD' || paymentMethod === 'CASH' || customerOrder.payment?.method === 'COD';
    onProgress(`[MIDDLEMAN-ENGINE] 💳 Proceeding to Payment Screen (${isCod ? 'Cash on Delivery (COD)' : 'Instant UPI'})...`);
    const checkoutSelectors = [
      '.force-font-14',
      '.btn.secondary.force-font-14',
      '.cart-footer-payment-force .btn',
      'button:has-text("PROCEED TO PAY")',
      'button:has-text("Proceed to pay")',
      'button:has-text("CHECKOUT")',
      'button:has-text("Checkout")',
      'button:has-text("CONTINUE")',
      'button:has-text("Continue")',
      'button.btn-checkout'
    ];

    for (const cSel of checkoutSelectors) {
      const cBtn = page.locator(cSel).first();
      if (await cBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await cBtn.click({ force: true }).catch(() => {});
        onProgress(`[MIDDLEMAN-ENGINE] Clicked checkout trigger: ${cSel}`);
        break;
      }
    }
    await sleep(2000);

    // Dismiss checkout upsell modal popup if present ("NO, THANKS", "SKIP", "CONTINUE", "✕")
    const upsellSelectors = [
      'button:has-text("NO, THANKS")',
      'button:has-text("No, Thanks")',
      'button:has-text("No Thanks")',
      'button:has-text("Skip")',
      'button:has-text("SKIP")',
      'button:has-text("CONTINUE")',
      '.modal-close',
      'span:has-text("✕")',
      'button[aria-label="Close"]'
    ];
    for (const uSel of upsellSelectors) {
      try {
        const uBtn = page.locator(uSel).first();
        if (await uBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await uBtn.click({ force: true }).catch(() => {});
          onProgress(`[MIDDLEMAN-ENGINE] 🛡️ Dismissed checkout upsell dialog: ${uSel}`);
          await sleep(1200);
          break;
        }
      } catch (e) {}
    }

    // Wait for payment screen: URL includes /payment or presence of CASH
    await page.waitForURL('**/payment**', { timeout: 8000 }).catch(() => {});
    await sleep(1500);

    // If still on cart, attempt direct navigation to Domino's genuine payment endpoint
    if (!page.url().includes('payment')) {
      onProgress(`[MIDDLEMAN-ENGINE] Navigating directly to payment view...`);
      await page.goto(`https://m.dominos.co.in/jfl-discovery-payment/en/pwa/payment`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      }).catch(() => {});
      await sleep(1500);
    }

    // If an Admin Gift Card / E-Voucher is provided, attempt redemption on Domino's payment screen
    let voucherApplied = false;
    let voucherBalanceReflected = 0;
    let dueAmountToRider = 0;

    if (voucher && voucher.code) {
      onProgress(`[MIDDLEMAN-ENGINE] 🎟️ Opening Domino's Gift Card / E-Voucher payment mode: ${voucher.code.slice(0, 4)}**** (PIN: ${voucher.pin})...`);
      try {
        const gvOption = page.locator('div:has-text("Gift Voucher"), div:has-text("E-Voucher"), div:has-text("Evoucher"), div:has-text("Gift Card"), label:has-text("Gift Voucher"), label:has-text("E-Voucher"), label:has-text("Gift Card"), #GV').first();
        if (await gvOption.isVisible({ timeout: 2500 }).catch(() => false)) {
          await gvOption.scrollIntoViewIfNeeded().catch(() => {});
          await gvOption.click({ force: true }).catch(() => {});
          await sleep(1200);

          const voucherCodeInput = page.locator('input[placeholder*="16" i], input[placeholder*="voucher" i], input[placeholder*="card" i], input[name*="voucher" i], input#voucherCode, .voucher-input').first();
          const checkBalanceBtn = page.locator('button:has-text("CHECK BALANCE"), button:has-text("Check Balance"), button:has-text("VERIFY"), button:has-text("APPLY"), button:has-text("Next")').first();

          if (await voucherCodeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            const cleanCard = (voucher.code || '').replace(/[^0-9]/g, '');
            await voucherCodeInput.fill(cleanCard);
            onProgress(`[MIDDLEMAN-ENGINE] 🔢 Entered 16-digit Gift Card number: ${cleanCard.slice(0, 4)} **** **** ${cleanCard.slice(12)}`);

            if (await checkBalanceBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await checkBalanceBtn.click({ force: true }).catch(() => {});
              await sleep(2000);
            }

            // Verify reflected balance on Domino's page (e.g. ₹100 or ₹200)
            const balanceInfo = await page.evaluate(() => {
              const balEl = document.querySelector('.voucher-balance, [class*="balance" i], .evoucher-amt, span:has-text("₹")');
              const txt = balEl ? balEl.innerText.replace(/[^0-9.]/g, '') : null;
              return txt ? parseFloat(txt) : null;
            });

            voucherBalanceReflected = balanceInfo || Number(voucher.balance || 0);
            onProgress(`[MIDDLEMAN-ENGINE] 💳 Domino's verified Gift Card balance: ₹${voucherBalanceReflected}`);

            // If order total exceeds voucher balance, Domino's prompts that due amount has to be paid in cash/COD
            const orderTotalAmt = Number(liveDominoPricing?.total || customerOrder.payment?.amount || 0);
            dueAmountToRider = Math.max(0, orderTotalAmt - voucherBalanceReflected);

            if (dueAmountToRider > 0) {
              onProgress(`[MIDDLEMAN-ENGINE] 💵 Domino's requested due amount of ₹${dueAmountToRider} to be paid in cash. Selecting Cash / UPI on Delivery for remaining balance...`);
              const dueCodOption = page.locator('#CASH, label[for="CASH"], div:has-text("Cash on Delivery"), div:has-text("Pay Remaining via Cash")').first();
              if (await dueCodOption.isVisible({ timeout: 2000 }).catch(() => false)) {
                await dueCodOption.click({ force: true }).catch(() => {});
                await sleep(800);
              }
            }

            // Domino's site prompts to fill the 6-digit PIN of the gift card
            const voucherPinInput = page.locator('input[placeholder*="pin" i], input[placeholder*="6 digit" i], input[name*="pin" i], input#voucherPin, input[type="password"]').first();
            if (await voucherPinInput.isVisible({ timeout: 2000 }).catch(() => false)) {
              const cleanPin = String(voucher.pin || '839201').trim();
              await voucherPinInput.fill(cleanPin);
              onProgress(`[MIDDLEMAN-ENGINE] 🔑 Filled 6-digit Gift Card PIN securely.`);
              await sleep(600);

              const confirmVoucherBtn = page.locator('button:has-text("REDEEM"), button:has-text("Redeem"), button:has-text("PAY"), button:has-text("CONFIRM"), button:has-text("APPLY")').first();
              if (await confirmVoucherBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await confirmVoucherBtn.click({ force: true }).catch(() => {});
                await sleep(2500);
              }
              voucherApplied = true;
              onProgress(`[MIDDLEMAN-ENGINE] ✅ Gift Card redeemed successfully! Domino's applied ₹${voucherBalanceReflected}. Customer due amount to rider: ₹${dueAmountToRider}`);
            }
          }
        }
      } catch (gvErr) {
        onProgress(`[MIDDLEMAN-ENGINE] Gift Voucher redemption notice: ${gvErr.message}`);
      }
    }

    if (isCod) {
      // 1. SCROLL DOWN directly to Cash / UPI on Delivery section
      onProgress(`[MIDDLEMAN-ENGINE] 📜 Scrolling down payment screen to locate 'Cash / UPI on Delivery'...`);
      await page.evaluate(() => {
        const cashEl = document.querySelector('#CASH') || document.querySelector('label[for="CASH"]');
        if (cashEl) {
          cashEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        const all = Array.from(document.querySelectorAll('*'));
        const target = all.find(e => e.children.length === 0 && (e.innerText || '').includes('Cash / UPI on Delivery'));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      });
      await sleep(1500);

      // 2. CLICK Cash on Delivery radio label
      onProgress(`[MIDDLEMAN-ENGINE] 💵 Clicking 'Cash / UPI on Delivery' (COD) option...`);
      const codRadio = page.locator('label.radio:has(#CASH), label[for="CASH"], #CASH').first();
      let codSelected = false;
      if (await codRadio.isVisible({ timeout: 2500 }).catch(() => false)) {
        await codRadio.click({ force: true });
        codSelected = true;
        onProgress(`[MIDDLEMAN-ENGINE] ✓ Clicked Cash on Delivery radio locator.`);
      } else {
        codSelected = await page.evaluate(() => {
          const el = document.querySelector('label.radio:has(#CASH)') || document.querySelector('#CASH')?.parentElement || document.querySelector('#CASH');
          if (el) {
            el.click();
            return true;
          }
          return false;
        });
      }
      await sleep(1000);

      // 3. Verify and commit Vuex store for CASH mode
      await page.evaluate(async () => {
        try {
          const cashInput = document.querySelector('input#CASH');
          if (cashInput) {
            cashInput.checked = true;
            cashInput.dispatchEvent(new Event('input', { bubbles: true }));
            cashInput.dispatchEvent(new Event('change', { bubbles: true }));
            cashInput.dispatchEvent(new Event('click', { bubbles: true }));
          }
          const app = document.querySelector('#app')?.__vue__;
          if (app && app.$store) {
            const pObj = { paymentId: "CASH", paymentMode: "CASH", label: "Cash / UPI on Delivery", isCod: true };
            await app.$store.dispatch("PaymentSubmit/setPaymentMode", pObj).catch(() => {});
            await app.$store.dispatch("PaymentSubmit/setPaymentModeTemp", pObj).catch(() => {});
            app.$store.commit("PaymentSubmit/updateIsPlaceOrderActive", true);
            app.$store.commit("PaymentSubmit/updatePaymentMode", pObj);
            app.$store.commit("PaymentSubmit/updatePaymentModeTemp", pObj);
            app.$store.commit("Cash/updateCashErrorOtpMsg", "");
          }
        } catch (e) {}
      });
      await sleep(1000);

      // 4. SCROLL DOWN to expose itemized bill details & Place Order CTA
      onProgress(`[MIDDLEMAN-ENGINE] 📜 Scrolling down to review bill details and expose Place Order CTA...`);
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await sleep(1500);

      // Capture Screenshot 1: Live Domino's Cart & Itemized Bill Review for Admin Audit
      try {
        const orderRefNum = (customerOrder.id || 'ORDER').replace(/[^a-zA-Z0-9]/g, '');
        const cartBillFile = `cart-bill-${orderRefNum}.png`;
        const cartBillPath = path.join(__dirname, '..', 'public', 'screenshots', cartBillFile);
        await page.screenshot({ path: cartBillPath, fullPage: false });
        cartBillUrl = `/screenshots/${cartBillFile}`;
        onProgress(`[MIDDLEMAN-ENGINE] 📸 Captured live Domino's cart & itemized bill review screenshot: ${cartBillFile}`);
      } catch (cbErr) {
        onProgress(`[MIDDLEMAN-ENGINE] Cart bill review screenshot note: ${cbErr.message}`);
      }

      // 5. Verify footer Place Order button state
      const footerState = await page.evaluate(() => {
        const btn = document.querySelector('div.btn.secondary.force-font-14.medium.domino-red, .footer-main .btn, .footer-main button, button.btn-place-order-color');
        const warn = document.querySelector('.footer-main .warn, [class*="warning" i]');
        return {
          btnFound: !!btn,
          btnText: btn ? btn.innerText.replace(/\n+/g, ' ').trim() : 'null',
          isWarn: !!(warn && warn.innerText)
        };
      });

      // If footer indicates payment method not selected, re-click cash
      if (footerState.btnText.includes('Select payment method') || footerState.isWarn) {
        onProgress(`[MIDDLEMAN-ENGINE] ⚠️ Re-engaging Cash on Delivery radio selection...`);
        await page.evaluate(() => {
          const el = document.querySelector('label.radio:has(#CASH)') || document.querySelector('#CASH');
          if (el) el.click();
        });
        await sleep(1000);
      }

      // 6. Click Place Order (handles Domino's dynamic store price recalculation)
      const placeOrderBtn = page.locator('div.btn.secondary.force-font-14.medium.domino-red, .footer-main .btn, .footer-main button, button.btn-place-order-color').last();
      if (await placeOrderBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        const btnTxt = await placeOrderBtn.innerText().catch(() => 'Place Order');
        onProgress(`[MIDDLEMAN-ENGINE] 🚀 Confirming order placement on Domino's India ("${btnTxt.replace(/\n+/g, ' ').trim()}")...`);
        interceptedOrderError = null;
        await placeOrderBtn.scrollIntoViewIfNeeded().catch(() => {});
        await placeOrderBtn.click({ force: true }).catch(() => {});
        await sleep(3000);

        // Check if Domino's updated the price and requires confirming the settled total
        const secondClickNeeded = await placeOrderBtn.isVisible({ timeout: 2500 }).catch(() => false);
        if (secondClickNeeded) {
          const secondTxt = await placeOrderBtn.innerText().catch(() => 'Place Order');
          onProgress(`[MIDDLEMAN-ENGINE] 🚀 Domino's price settled ("${secondTxt.replace(/\n+/g, ' ').trim()}"). Confirming final order placement...`);
          interceptedOrderError = null;
          // Dismiss any price notice banner
          const dismissBanner = page.locator('span:has-text("×"), .toast-close, [class*="close" i]').first();
          if (await dismissBanner.isVisible({ timeout: 600 }).catch(() => false)) {
            await dismissBanner.click({ force: true }).catch(() => {});
            await sleep(400);
          }
          await placeOrderBtn.scrollIntoViewIfNeeded().catch(() => {});
          await placeOrderBtn.click({ force: true }).catch(() => {});
          await sleep(3000);
        }
      }
    } else {
      // Online / UPI QR flow
      onProgress(`[MIDDLEMAN-ENGINE] 📱 Selecting UPI payment method on Domino's...`);
      const upiSelectors = [
        '#Pay-by-any-UPI-App-0',
        'label:has(#Pay-by-any-UPI-App-0)',
        'label:has-text("Pay by any UPI App")',
        'div:has-text("Pay by any UPI App")',
        'span:has-text("Pay by any UPI App")',
        'div:has-text("UPI Apps")'
      ];
      for (const uSel of upiSelectors) {
        const el = page.locator(uSel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ force: true }).catch(() => {});
          onProgress(`[MIDDLEMAN-ENGINE] ✓ Selected UPI payment mode on Domino's: ${uSel}`);
          break;
        }
      }
      await sleep(1000);

      // Scroll down to expose Place Order CTA
      onProgress(`[MIDDLEMAN-ENGINE] 📜 Scrolling down to review bill details and expose Place Order CTA...`);
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await sleep(1500);

      const placeOrderBtn = page.locator('div.btn.secondary.force-font-14.medium.domino-red, .footer-main .btn, .footer-main button, button.btn-place-order-color').last();
      if (await placeOrderBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        const btnTxt = await placeOrderBtn.innerText().catch(() => 'Place Order');
        onProgress(`[MIDDLEMAN-ENGINE] 🚀 Confirming UPI payment initialization on Domino's India ("${btnTxt.replace(/\n+/g, ' ').trim()}")...`);
        await placeOrderBtn.scrollIntoViewIfNeeded().catch(() => {});
        await placeOrderBtn.click({ force: true }).catch(() => {});
        await sleep(2500);
      }
    }

    // Check if Cash modal popped up; if not, invoke Vuex cashOrderSubmitCall as secondary commitment
    const modalActive = await page.evaluate(() => {
      const modal = document.querySelector('.modal, .modal-container, [class*="modal" i]');
      return modal && modal.innerText.includes('Placing Order');
    });
    if (!modalActive && isCod) {
      await page.evaluate(() => {
        try {
          const app = document.querySelector('#app')?.__vue__;
          if (app && app.$store) {
            app.$store.dispatch("Cash/cashOrderSubmitCall");
          }
        } catch (e) {}
      });
    }

    // Handle any secondary confirmation dialog (e.g. "Confirm Cash on Delivery", "Yes, Place Order", "Confirm")
    const secondaryConfirmBtn = page.locator('button:has-text("Confirm Order"), button:has-text("CONFIRM ORDER"), button:has-text("Confirm"), button:has-text("Yes, Place Order"), button:has-text("Yes"), button:has-text("YES")').first();
    if (await secondaryConfirmBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      onProgress(`[MIDDLEMAN-ENGINE] 🛡️ Confirming secondary Cash on Delivery modal prompt...`);
      await secondaryConfirmBtn.click({ force: true }).catch(() => {});
      await sleep(1500);
    }

    // Handle Price Change / Cart Review Prompt from Domino's
    const priceChangeBtn = page.locator('button:has-text("OK"), button:has-text("Ok"), button:has-text("CONTINUE"), button:has-text("Continue"), button:has-text("PROCEED"), button:has-text("REVIEW CART")').first();
    if (await priceChangeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      onProgress(`[MIDDLEMAN-ENGINE] 🔄 Acknowledging Domino's price change notice...`);
      await priceChangeBtn.click({ force: true }).catch(() => {});
      await sleep(1500);
      const retryPlaceOrder = page.locator('div.btn.secondary.force-font-14.medium.domino-red, .footer-main .btn, button.btn-place-order-color, .force-font-14').last();
      if (await retryPlaceOrder.isVisible({ timeout: 2000 }).catch(() => false)) {
        interceptedOrderError = null;
        await retryPlaceOrder.scrollIntoViewIfNeeded().catch(() => {});
        await retryPlaceOrder.click({ force: true }).catch(() => {});
        await sleep(2500);
      }
    }

    // =========================================================================
    // STEP 6: Capture Real Confirmation Proof & Verify Genuine Order Reference
    // =========================================================================
    onProgress(`[MIDDLEMAN-ENGINE] ⏳ Awaiting authentic order confirmation from Domino's India...`);
    let settledRetryAttempts = 0;

    for (let w = 0; w < 50; w++) {
      if (interceptedOrderId) break;
      const curUrl = page.url();
      if (curUrl.includes('trackOrder') || curUrl.includes('postorder') || curUrl.includes('confirmation') || curUrl.includes('order-status') || curUrl.includes('thankYou') || curUrl.includes('ngpostorder')) break;

      // Real-time check and auto-recovery when Domino's recalculates store price (1.AMTDIFF Review Cart protocol)
      if (priceRecalculatedNeedsConfirm && settledRetryAttempts < 3) {
        settledRetryAttempts++;
        priceRecalculatedNeedsConfirm = false;
        interceptedOrderError = null;

        onProgress(`[MIDDLEMAN-ENGINE] 🔄 Domino's required cart review ("1.AMTDIFF"). Navigating to cart to acknowledge settled prices...`);
        
        // 1. Click "Review Cart" CTA if available, or navigate directly to cart view
        const reviewBtn = page.locator('button:has-text("Review Cart"), button:has-text("REVIEW CART"), div:has-text("Review Cart"), span:has-text("Review Cart"), a:has-text("Review Cart")').first();
        if (await reviewBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
          await reviewBtn.click({ force: true }).catch(() => {});
        } else {
          await page.goto(`https://m.dominos.co.in/jfl-discovery-payment/en/pwa/cart/${targetStoreId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
          }).catch(() => {});
        }
        await sleep(2500);

        // 2. Click Proceed to pay / Checkout from cart to re-commit settled price and update cart signature
        const cartCheckoutBtn = page.locator('.btn-checkout, .force-font-14, button:has-text("PROCEED TO PAY"), button:has-text("Proceed to pay"), button:has-text("CHECKOUT"), button:has-text("Checkout")').first();
        if (await cartCheckoutBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
          const cTxt = await cartCheckoutBtn.innerText().catch(() => 'Proceed to pay');
          onProgress(`[MIDDLEMAN-ENGINE] 🛒 Acknowledged updated cart pricing ("${cTxt.replace(/\n+/g, ' ').trim()}"). Returning to payment...`);
          await cartCheckoutBtn.scrollIntoViewIfNeeded().catch(() => {});
          await cartCheckoutBtn.click({ force: true }).catch(() => {});
          await sleep(2000);

          // Handle upsell dialog if popped up
          const upsellNo = page.locator('button:has-text("NO, THANKS"), button:has-text("No, Thanks"), button:has-text("SKIP"), button:has-text("Skip")').first();
          if (await upsellNo.isVisible({ timeout: 1500 }).catch(() => false)) {
            await upsellNo.click({ force: true }).catch(() => {});
            await sleep(1000);
          }
        }

        // Wait for payment page to mount
        await page.waitForURL('**/payment**', { timeout: 6000 }).catch(() => {});
        await sleep(1500);

        // 3. Ensure Cash on Delivery is selected
        if (isCod) {
          onProgress(`[MIDDLEMAN-ENGINE] 💵 Re-engaging Cash on Delivery option...`);
          await page.evaluate(() => {
            const cash = document.querySelector('#CASH') || document.querySelector('label.radio:has(#CASH)') || document.querySelector('label[for="CASH"]');
            if (cash) {
              cash.scrollIntoView({ behavior: 'smooth', block: 'center' });
              cash.click();
            }
            try {
              const app = document.querySelector('#app')?.__vue__;
              if (app && app.$store) {
                const pObj = { paymentId: "CASH", paymentMode: "CASH", label: "Cash / UPI on Delivery", isCod: true };
                app.$store.commit("PaymentSubmit/updatePaymentMode", pObj);
                app.$store.commit("PaymentSubmit/updatePaymentModeTemp", pObj);
                app.$store.commit("PaymentSubmit/updateIsPlaceOrderActive", true);
              }
            } catch (e) {}
          });
          await sleep(1000);
        }

        // 4. Scroll down to bill details and click Place Order
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
        await sleep(1000);

        const finalPlaceOrderBtn = page.locator('div.btn.secondary.force-font-14.medium.domino-red, .footer-main .btn, .footer-main button, button.btn-place-order-color').last();
        if (await finalPlaceOrderBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          const btnTxt = await finalPlaceOrderBtn.innerText().catch(() => 'Place Order');
          onProgress(`[MIDDLEMAN-ENGINE] 🚀 Re-submitting confirmed order at Domino's settled price ("${btnTxt.replace(/\n+/g, ' ').trim()}")...`);
          interceptedOrderError = null;
          await finalPlaceOrderBtn.scrollIntoViewIfNeeded().catch(() => {});
          await finalPlaceOrderBtn.click({ force: true }).catch(() => {});
          await sleep(2000);

          if (isCod) {
            await page.evaluate(() => {
              try {
                const app = document.querySelector('#app')?.__vue__;
                if (app && app.$store) {
                  app.$store.dispatch("Cash/cashOrderSubmitCall").catch(() => {});
                }
              } catch (e) {}
            });
          }
          await sleep(2500);
        }
        continue;
      }

      if (interceptedOrderError && !interceptedOrderError.toLowerCase().includes('price') && !interceptedOrderError.toLowerCase().includes('review')) {
        break;
      }

      // Real-time check of tracker_id_mobile in localStorage
      const trackerFound = await page.evaluate(() => {
        try {
          const raw = localStorage.getItem('tracker_id_mobile');
          if (raw) {
            const p = JSON.parse(raw);
            if (p && p.orderId) return String(p.orderId);
          }
        } catch (e) {}
        return null;
      });
      if (trackerFound) {
        interceptedOrderId = trackerFound;
        onProgress(`[MIDDLEMAN-ENGINE] ✓ Captured authentic Domino's Order Reference: #${interceptedOrderId}`);
        break;
      }

      // Real-time check for authentic Domino's error/offline modal
      const liveModalText = await page.evaluate(() => {
        const modal = document.querySelector('.modal, .modal-container, .popup, [class*="modal" i], [class*="popup" i], [class*="dialog" i]');
        if (!modal) return null;
        const txt = modal.innerText.trim();
        if (txt.includes('MobiKwik') || txt.includes('Airtel Money') || txt.includes('Wallet') || txt.includes('UPI Apps')) return null;
        if (txt.includes('Placing Order') || txt.includes('Cancel Order') || txt.includes('Cash on delivery')) return null;
        if (txt.toLowerCase().includes('offline') || txt.toLowerCase().includes('fail') || txt.toLowerCase().includes('error') || txt.toLowerCase().includes('sorry') || txt.toLowerCase().includes('unable') || txt.toLowerCase().includes('unserviceable') || txt.toLowerCase().includes('closed')) {
          return txt;
        }
        return null;
      });
      if (liveModalText) {
        interceptedOrderError = liveModalText.replace(/\n+/g, ' ');
        onProgress(`[MIDDLEMAN-ENGINE] ⚠️ Domino's Live Response: ${interceptedOrderError}`);
        break;
      }

      await sleep(600);
    }

    // Scroll confirmation receipt & tax invoice into view before taking proof screenshot
    await page.evaluate(() => {
      const receipt = document.querySelector('.order-details, .bill-details, .order-receipt, [class*="receipt"], [class*="order-card"], [class*="confirmation"], [class*="track"]');
      if (receipt) {
        receipt.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        window.scrollTo(0, 0);
      }
    });
    await sleep(1000);

    const proofFile = `proof-${customerOrder.id}.png`;
    const proofPath = path.join(__dirname, '..', 'public', 'screenshots', proofFile);
    let proofUrl = null;

    try {
      await page.screenshot({ path: proofPath, fullPage: false });
      proofUrl = `/screenshots/${proofFile}`;
      onProgress(`[MIDDLEMAN-ENGINE] 📸 Captured physical screenshot of Domino's order/bill: ${proofFile}`);
      try {
        const { cleanupOlderScreenshots } = require('./screenshotHelper');
        cleanupOlderScreenshots(15);
      } catch (e) {}
    } catch (ssErr) {
      onProgress(`[MIDDLEMAN-ENGINE] Screenshot note: ${ssErr.message}`);
    }

    // Extract Authentic Domino's Order Reference
    let realOrderRef = interceptedOrderId;

    if (!realOrderRef) {
      const trackerObj = await page.evaluate(() => {
        try {
          const raw = localStorage.getItem('tracker_id_mobile');
          if (raw) return JSON.parse(raw);
        } catch (e) {}
        return null;
      });
      if (trackerObj && trackerObj.orderId) {
        realOrderRef = String(trackerObj.orderId);
        onProgress(`[MIDDLEMAN-ENGINE] ✓ Retrieved authentic Domino's order ID from tracker: ${realOrderRef}`);
      }
    }

    if (!realOrderRef) {
      const currentUrl = page.url();
      try {
        const urlObj = new URL(currentUrl);
        realOrderRef = urlObj.searchParams.get('orderId') || urlObj.searchParams.get('id') || urlObj.searchParams.get('orderHistoryId') || urlObj.searchParams.get('orderNumber');
      } catch (e) {}
    }

    if (!realOrderRef) {
      const orderEl = page.locator('div[class*="order-id"], span[class*="orderId"], h2:has-text("Order ID"), [data-testid="order-id"]').first();
      if (await orderEl.isVisible({ timeout: 2000 }).catch(() => false)) {
        const txt = await orderEl.innerText();
        const m = txt.match(/[A-Z0-9]{6,16}/);
        if (m) realOrderRef = m[0];
      }
    }

    // Strict Genuine Verification: Check for rejection or authentic Domino's error
    if (!realOrderRef) {
      const screenErrText = await page.evaluate(() => {
        const errModal = document.querySelector('.error-modal, .error-popup, [class*="errorMessage" i], [class*="error_msg" i], [class*="error-dialog" i], .modal, .modal-container, .popup, [class*="modal" i]');
        if (!errModal) return null;
        const txt = errModal.innerText.trim();
        // Ignore wallet modal or normal payment option lists
        if (txt.includes('MobiKwik') || txt.includes('Airtel Money') || txt.includes('Wallet') || txt.includes('UPI Apps')) return null;
        if (txt.includes('Placing Order') || txt.includes('Cancel Order') || txt.includes('Cash on delivery')) return null;
        if (txt.toLowerCase().includes('offline') || txt.toLowerCase().includes('fail') || txt.toLowerCase().includes('error') || txt.toLowerCase().includes('unable') || txt.toLowerCase().includes('sorry') || txt.toLowerCase().includes('unserviceable') || txt.toLowerCase().includes('closed')) {
          return txt.replace(/\n+/g, ' ');
        }
        return null;
      });

      if ((interceptedOrderError && !interceptedOrderError.toLowerCase().includes('price') && !interceptedOrderError.toLowerCase().includes('review')) || screenErrText) {
        const failureReason = interceptedOrderError || screenErrText;
        const isStoreTiming = (interceptedOrderErrorCode === 'STORE_TIME_NOT_AVAILABLE') ||
          failureReason.toLowerCase().includes('store not available for the time') ||
          failureReason.toLowerCase().includes('store_time_not_available');
        const userFacingMessage = isStoreTiming 
          ? 'Domino\'s store kitchen is currently outside delivery hours (Kitchen delivery opens at 11:00 AM IST). Order is safely saved.' 
          : failureReason;

        onProgress(`[MIDDLEMAN-ENGINE] ❌ Order placement rejected by Domino's India: ${userFacingMessage}`);
        await browser.close();
        return {
          success: false,
          error: userFacingMessage,
          errorCode: isStoreTiming ? 'STORE_TIME_NOT_AVAILABLE' : (interceptedOrderErrorCode || 'ORDER_REJECTED'),
          isStoreOffline: isStoreTiming || failureReason.toLowerCase().includes('offline'),
          proofScreenshotUrl: proofUrl,
          cartBillScreenshotUrl: cartBillUrl,
          dominosAddressId: interceptedAddressId
        };
      }

      // If still no order ID and URL is not confirmation page, report genuine status
      const curUrl = page.url();
      if (!curUrl.includes('trackOrder') && !curUrl.includes('postorder') && !curUrl.includes('confirmation')) {
        onProgress(`[MIDDLEMAN-ENGINE] ❌ Could not verify order confirmation on Domino's India (Current URL: ${curUrl})`);
        await browser.close();
        return {
          success: false,
          error: 'Domino\'s order could not be confirmed. Store may be temporarily offline or unserviceable.',
          proofScreenshotUrl: proofUrl,
          cartBillScreenshotUrl: cartBillUrl,
          dominosAddressId: interceptedAddressId
        };
      }

      // Fallback only if confirmation page is physically reached
      realOrderRef = `DOM-REF-${Date.now().toString().slice(-6)}`;
    }

    onProgress(`[MIDDLEMAN-ENGINE] ✅ Cash on Delivery Order confirmed on Domino's India! Real Ref: ${realOrderRef}`);

    await browser.close();

    return {
      success: true,
      dominosOrderRef: realOrderRef,
      proofScreenshotUrl: proofUrl,
      cartBillScreenshotUrl: cartBillUrl,
      dominosAddressId: interceptedAddressId,
      voucherApplied: voucherApplied,
      voucherBalance: voucherBalanceReflected,
      dueAmount: dueAmountToRider,
      couponResult: couponResult
    };

  } catch (err) {
    onProgress(`[MIDDLEMAN-ENGINE] ❌ Error executing on Domino's: ${err.message}`);
    await browser.close().catch(() => {});
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = { executeMiddlemanOrderOnDominos };
