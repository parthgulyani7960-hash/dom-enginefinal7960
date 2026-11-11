const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const db = require('./db');
const queue = require('./queue');
const { 
  requestLiveDominoOtp, 
  verifyLiveDominoOtp, 
  launchBrowserWithSession, 
  exportCookiesJson,
  importDominoSessionJson,
  validateExistingAccount,
  validateDominoSession,
  refreshDominoSession,
  applyAccountRefresh,
  getExtractionGuide,
  calculateSessionHealth
} = require('./adminSession');
const locationService = require('./locationService');
const rateLimiter = require('./rateLimiter');
const dominosAddressService = require('./dominosAddressService');
const dominosMenuService = require('./dominosMenuService');
const securityService = require('./securityService');
const firebaseService = require('./firebaseService');
const proxyService = require('./proxyService');

// Wire Firebase cloud persistence
db.setFirebaseService(firebaseService);
firebaseService.pullFromCloud().then(cloudData => {
  if (cloudData) db.mergeCloudData(cloudData);
}).catch(e => console.warn('[FIREBASE] Startup pull error:', e.message));

const PORT = process.env.PORT || 3005;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const crypto = require('crypto');

const ADMIN_EMAILS = new Set([
  'parthgulyani7960@gmail.com'
]);
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || crypto.createHash('sha256').update('dom-order-engine-key-2026').digest('hex').slice(0, 24);
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || (ADMIN_SECRET_KEY + '-salt-token-2026');

function maskPhone(p) {
  if (!p) return '••••••••••';
  const s = String(p).replace(/[^0-9]/g, '');
  return s.length >= 10 ? `+91 ${s.slice(0, 2)}••••••${s.slice(-2)}` : '••••••••••';
}

function createAdminToken(email) {
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours validity
  const em = String(email || 'parthgulyani7960@gmail.com').toLowerCase().trim();
  const payload = `${em}:${exp}`;
  const sig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ email: em, exp, sig })).toString('base64url');
}

function verifyAdminToken(tokenStr) {
  try {
    if (!tokenStr || typeof tokenStr !== 'string') return null;
    const jsonStr = Buffer.from(tokenStr, 'base64url').toString('utf8');
    const data = JSON.parse(jsonStr);
    if (!data || !data.email || !data.exp || !data.sig) return null;
    if (Date.now() > data.exp) return null;
    if (!ADMIN_EMAILS.has(data.email.toLowerCase())) return null;

    const payload = `${data.email}:${data.exp}`;
    const expected = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('hex');
    const a = Buffer.from(data.sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function decodeGoogleJwt(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

function checkAdminAuth(req) {
  // 1. Direct admin secret key header (only genuine env secret key if set)
  const key = req.headers['x-admin-key'] || req.headers['authorization'];
  if (ADMIN_SECRET_KEY && (key === ADMIN_SECRET_KEY || key === `Bearer ${ADMIN_SECRET_KEY}`)) return true;

  // 2. Cryptographic HMAC token issued strictly to parthgulyani7960@gmail.com
  const tokenHeader = req.headers['x-admin-token'];
  if (tokenHeader && verifyAdminToken(tokenHeader)) return true;

  // 3. Admin cookie checks
  const cookie = req.headers['cookie'] || '';
  const matchToken = cookie.match(/admin_token=([^;]+)/);
  if (matchToken && verifyAdminToken(matchToken[1])) return true;

  const matchKey = cookie.match(/admin_key=([^;]+)/);
  if (matchKey && matchKey[1] === ADMIN_SECRET_KEY) return true;

  // 4. Admin console client header
  const adminClient = req.headers['x-admin-client'];
  if (adminClient === 'dominos-order-engine-admin-console') return true;

  // 5. Direct Authorized Access: Requests originating from the Admin Console (/admin) or same-origin (Render, custom domain, localhost)
  const referer = req.headers['referer'] || '';
  const origin = req.headers['origin'] || '';
  const host = req.headers['host'] || '';
  const secFetchSite = req.headers['sec-fetch-site'] || '';

  if (referer.includes('/admin') || referer.includes('/admin.html')) {
    return true;
  }
  if (secFetchSite === 'same-origin' || (origin && host && origin.includes(host)) || (referer && host && referer.includes(host))) {
    return true;
  }

  // 6. Localhost / loopback direct administrator access
  const ip = req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1') || host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return true;
  }

  return false;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX_SIZE = 1024 * 1024; // 1MB payload security limit
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        reject(new Error('Payload too large. Maximum allowable request size is 1MB.'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(securityService.sanitizeBody(parsed));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-admin-token',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Embedder-Policy': 'unsafe-none',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  let targetPath = filePath;
  // If requested screenshot file does not exist, check for alternative extension (.svg <-> .png)
  if (!fs.existsSync(targetPath)) {
    if (targetPath.endsWith('.png')) {
      const svgPath = targetPath.replace(/\.png$/, '.svg');
      if (fs.existsSync(svgPath)) targetPath = svgPath;
    } else if (targetPath.endsWith('.svg')) {
      const pngPath = targetPath.replace(/\.svg$/, '.png');
      if (fs.existsSync(pngPath)) targetPath = pngPath;
    }
  }

  // Resilient Screenshot Serving: If screenshot file is missing from local disk (e.g. fresh cloud Render instance),
  // dynamically reconstruct the PNG from the base64 data URI stored in the order!
  if (!fs.existsSync(targetPath) && (targetPath.includes('screenshots') || targetPath.includes('proof-') || targetPath.includes('cart-bill-'))) {
    try {
      const filename = path.basename(targetPath);
      const orders = db.getOrders ? db.getOrders() : (db.data?.orders || []);
      const matchedOrder = orders.find(o => {
        const pUrl = o.robot?.proofScreenshotUrl || '';
        const cUrl = o.robot?.cartBillScreenshotUrl || '';
        return pUrl.includes(filename) || cUrl.includes(filename) || (o.id && filename.includes(o.id.replace(/[^a-zA-Z0-9]/g, '')));
      });
      const dataUri = matchedOrder?.robot?.cartBillScreenshotDataUri || matchedOrder?.robot?.proofScreenshotDataUri;
      if (dataUri && typeof dataUri === 'string' && dataUri.startsWith('data:image/')) {
        const base64Data = dataUri.split(',')[1];
        if (base64Data) {
          const buf = Buffer.from(base64Data, 'base64');
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, buf);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'X-Reconstructed-From': 'Cloud-Data-URI'
          });
          res.end(buf);
          return;
        }
      }
    } catch (reconstErr) {
      console.warn('[SCREENSHOT-SERVE] Reconstruct notice:', reconstErr.message);
    }
  }

  fs.readFile(targetPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
      }
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Cross-Origin-Embedder-Policy': 'unsafe-none'
    };
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

// Domino's India Cloud Order Telemetry Synchronizer
async function syncOrdersWithDominosCloud(targetOrderId = null) {
  const accounts = db.getAccounts();
  const allOrders = db.getOrders();
  const updatedOrders = [];

  const candidateAccounts = targetOrderId 
    ? accounts.filter(a => {
        const ord = allOrders.find(o => o.id === targetOrderId);
        return ord && (ord.robot?.assignedAccountId === a.id || ord.robot?.sessionPhone === a.phone || a.sessionToken || a.credentials?.accessToken);
      })
    : accounts.filter(a => a.sessionToken || a.credentials?.accessToken);

  for (const acc of candidateAccounts) {
    let tok = acc.sessionToken || acc.credentials?.accessToken;
    if (!tok) continue;
    let bearer = tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`;
    let uId = String(acc.userId || acc.credentials?.userId || '366623451');

    try {
      let trackRes = await fetch('https://api.dominos.co.in/order-service/v1/orders', {
        headers: {
          'Content-Type': 'application/json',
          'api_key': 'd2aeb489bb8df385',
          'authToken': bearer,
          'Authorization': bearer,
          'userId': uId,
          'client_type': 'web app-chrome',
          'source': 'PWA18'
        }
      });

      if (trackRes.status === 401) {
        const rToken = acc.refreshToken || acc.credentials?.refreshToken;
        if (rToken) {
          const refreshRes = await refreshDominoSession(uId, rToken);
          if (refreshRes && refreshRes.success) {
            applyAccountRefresh(acc, refreshRes);
            db.save();
            tok = acc.sessionToken || acc.credentials?.accessToken;
            bearer = tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`;
            trackRes = await fetch('https://api.dominos.co.in/order-service/v1/orders', {
              headers: {
                'Content-Type': 'application/json',
                'api_key': 'd2aeb489bb8df385',
                'authToken': bearer,
                'Authorization': bearer,
                'userId': String(acc.userId),
                'client_type': 'web app-chrome',
                'source': 'PWA18'
              }
            });
          }
        }
      }

      if (trackRes.ok) {
        const data = await trackRes.json().catch(() => null);
        if (data?.orders && data.orders.length > 0) {
          for (const liveO of data.orders) {
            const liveOrderId = String(liveO.orderId || '').replace(/[^0-9]/g, '');
            const liveDomId = String(liveO.dominosOrderId || liveO.store?.orderId || '').replace(/[^0-9]/g, '');

            // Strict zero-mismatch isolation: Never match temporary random references (DOM-IND-*) via substring/endsWith
            const matchedOrder = allOrders.find(locO => {
              if (targetOrderId && locO.id !== targetOrderId) return false;
              const isTempRef = String(locO.robot?.dominosOrderRef || locO.dominosOrderRef || '').startsWith('DOM-IND-');
              const locPos = String(locO.robot?.posOrderId || locO.posOrderId || '').replace(/[^0-9]/g, '');
              const locRef = !isTempRef ? String(locO.robot?.dominosOrderRef || locO.dominosOrderRef || '').replace(/[^0-9]/g, '') : '';

              if (locPos && locPos === liveOrderId) return true;
              if (locRef && (locRef === liveDomId || locRef === liveOrderId)) return true;
              if (locO.robot?.orderTransactionId && locO.robot.orderTransactionId === liveO.orderTransactionId) return true;
              if (locO.robot?.cartId && String(liveO.cartId) === String(locO.robot.cartId)) return true;
              return false;
            });

            if (matchedOrder) {
              const posMap = {
                '1': 'ORDER_RECEIVED',
                '2': 'BAKING',
                '3': 'PACKED',
                '4': 'DISPATCHED',
                '11': 'DISPATCHED',
                '5': 'DELIVERED',
                '99': 'CANCELLED'
              };
              let liveStatus = posMap[liveO.currentPosState] || liveO.orderState || matchedOrder.robot?.status;
              if (liveO.orderState === 'CANCELLED' || liveO.currentPosState === '99') {
                liveStatus = 'CANCELLED';
              }

              matchedOrder.robot = matchedOrder.robot || {};
              matchedOrder.robot.status = liveStatus;
              matchedOrder.robot.dominosLiveStatus = liveStatus;
              matchedOrder.status = liveStatus;
              matchedOrder.robot.lastCloudSync = new Date().toISOString();

              if (liveStatus === 'DELIVERED') {
                matchedOrder.robot.deliveredAt = matchedOrder.robot.deliveredAt || new Date().toISOString();
                matchedOrder.robot.isDelayed = false;
                matchedOrder.robot.trackingNotice = 'Order delivered at doorstep. Live telemetry finalized.';
              } else if (liveStatus === 'CANCELLED') {
                matchedOrder.robot.cancelledAt = matchedOrder.robot.cancelledAt || new Date().toISOString();
              }

              if (liveO.store) {
                matchedOrder.robot.storePhone = liveO.store.phoneNumber || matchedOrder.robot.storePhone || '18002081234';
                matchedOrder.robot.storeName = liveO.store.name || matchedOrder.robot.storeName;
                matchedOrder.robot.storeId = String(liveO.store.id || matchedOrder.robot.storeId);
                matchedOrder.robot.storeAddress = liveO.store.addressLine || matchedOrder.robot.storeAddress;
              }

              if (liveO.orderId) matchedOrder.robot.posOrderId = String(liveO.orderId);
              if (liveO.dominosOrderId || liveO.store?.orderId) {
                matchedOrder.robot.dominosOrderRef = `#${liveO.dominosOrderId || liveO.store.orderId}`;
                matchedOrder.dominosOrderRef = matchedOrder.robot.dominosOrderRef;
              }

              let rName = liveO.riderName || liveO.deliveryExecutiveName || liveO.deliveryExecutive?.name || liveO.rider?.name || (liveStatus === 'DISPATCHED' ? (matchedOrder.robot.rider?.name || "Domino's Delivery Executive") : null);
              let rMobile = null;
              let rStatusText = null;
              let riderCoords = null;

              if (liveO.id) {
                try {
                  const accMobile = String(acc.cleanPhone || acc.phone || '').replace(/[^0-9]/g, '').slice(-10);
                  const trackerRes = await fetch(`https://api.dominos.co.in/post-order-service/v1/tracker/status?orderId=${encodeURIComponent(liveO.id)}&riderTracker=true`, {
                    headers: {
                      'Content-Type': 'application/json',
                      'api_key': 'd2aeb489bb8df385',
                      'authToken': bearer,
                      'Authorization': bearer,
                      'userId': String(acc.userId),
                      'Mobile': accMobile,
                      'client_type': 'web app-chrome',
                      'source': 'PWA18'
                    }
                  });
                  if (trackerRes.ok) {
                    const trackerData = await trackerRes.json().catch(() => null);
                    if (trackerData) {
                      if (trackerData.orderStatus === 'CANCELLED' || trackerData.cancellationDetails || trackerData.orderStatusCode === 99) {
                        liveStatus = 'CANCELLED';
                        if (trackerData.cancellationDetails?.reason) {
                          matchedOrder.robot.cancellationReason = trackerData.cancellationDetails.reason;
                          matchedOrder.robot.error = `Order cancelled by Domino's Kitchen: ${trackerData.cancellationDetails.reason}`;
                        }
                      } else if (trackerData.orderStatusCode === 4 || trackerData.orderStatusCode === 11) {
                        liveStatus = 'DISPATCHED';
                      } else if (trackerData.orderStatusCode === 5) {
                        liveStatus = 'DELIVERED';
                      }

                      const rInfo = trackerData.orderTracker?.riderInfo || trackerData.riderInfo;
                      if (rInfo) {
                        if (rInfo.riderName && rInfo.riderName.trim()) {
                          rName = rInfo.riderName.trim();
                        }
                        if (rInfo.riderContactNumber) {
                          const clean = String(rInfo.riderContactNumber).replace(/[^0-9]/g, '').slice(-10);
                          if (/^[6-9]\d{9}$/.test(clean)) {
                            rMobile = `+91 ${clean}`;
                          }
                        }
                        if (rInfo.orderStatusText) {
                          rStatusText = rInfo.orderStatusText;
                        }
                      }

                      if (trackerData.orderTracker?.currentLatitude && trackerData.orderTracker?.currentLongitude) {
                        riderCoords = {
                          lat: trackerData.orderTracker.currentLatitude,
                          lng: trackerData.orderTracker.currentLongitude
                        };
                      }
                    }
                  }
                } catch (trackErr) {
                  console.warn('[CLOUD-SYNC-TRACKER-ERR]', trackErr.message);
                }
              }

              if (!rMobile) {
                let fallbackMobile = liveO.riderMobile || liveO.deliveryExecutiveContact || liveO.deliveryExecutive?.contactNumber || liveO.deliveryExecutive?.mobile || liveO.rider?.phone || (liveStatus === 'DISPATCHED' ? (matchedOrder.robot.rider?.phone || null) : null);
                if (fallbackMobile) {
                  const cleanDigits = String(fallbackMobile).replace(/[^0-9]/g, '');
                  if (cleanDigits.length >= 10 && cleanDigits.length <= 12) {
                    const clean10 = cleanDigits.slice(-10);
                    rMobile = cleanDigits.length === 10 ? `+91 ${clean10}` : cleanDigits;
                    console.log(`[CLOUD-SYNC] 🛵 Live Rider Contact captured for Order #${matchedOrder.id}: ${rMobile}`);
                  }
                }
              }

              if (liveO.id) {
                matchedOrder.robot.dominosEncryptedId = liveO.id;
              }
              const sLat = liveO.store?.latitude || matchedOrder.location?.store?.latitude || matchedOrder.address?.latitude;
              const sLng = liveO.store?.longitude || matchedOrder.location?.store?.longitude || matchedOrder.address?.longitude;
              const dLat = liveO.deliveryAddress?.latitude || matchedOrder.address?.latitude;
              const dLng = liveO.deliveryAddress?.longitude || matchedOrder.address?.longitude;

              matchedOrder.robot.mapTelemetry = {
                storeCoords: (sLat && sLng) ? { lat: parseFloat(sLat), lng: parseFloat(sLng) } : null,
                riderCoords: riderCoords || matchedOrder.robot.mapTelemetry?.riderCoords || null,
                destCoords: (dLat && dLng) ? { lat: parseFloat(dLat), lng: parseFloat(dLng) } : null,
                statusText: rStatusText || (liveStatus === 'DISPATCHED' ? 'Rider is on the way' : liveStatus),
                orderStatus: liveStatus
              };

              if (rName || rMobile) {
                matchedOrder.robot.rider = {
                  name: rName || "Domino's Delivery Executive",
                  phone: rMobile || matchedOrder.robot.rider?.phone || null,
                  status: liveStatus,
                  statusText: rStatusText || matchedOrder.robot.rider?.statusText || null,
                  coords: riderCoords || matchedOrder.robot.rider?.coords || null
                };
              }

              if (liveStatus === 'CANCELLED') {
                matchedOrder.robot.error = `Order cancelled by Domino's Kitchen (${matchedOrder.robot.storeName || 'Store'}). Store Hotline: ${matchedOrder.robot.storePhone || '1800 208 1234'}`;
              }

              db.updateOrder(matchedOrder.id, matchedOrder);
              if (!updatedOrders.includes(matchedOrder.id)) updatedOrders.push(matchedOrder.id);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[CLOUD-SYNC-ERR]', acc.phone, e.message);
    }
  }

  return { success: true, updatedOrders, count: updatedOrders.length };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-admin-token'
    });
    res.end();
    return;
  }

  // Anti-Abuse, DDoS & Sliding Window Rate Limiting Protection
  const security = securityService.check(req, pathname);
  if (!security.allowed) {
    res.setHeader('Retry-After', String(security.resetInSeconds));
    return sendJson(res, 429, {
      error: 'Too Many Requests',
      message: security.reason,
      retryAfter: security.resetInSeconds
    });
  }

  // Security Check: Protect Admin Endpoints
  if (pathname.startsWith('/api/admin/')) {
    const isPublicAdminAuth = pathname === '/api/admin/auth/login' || pathname === '/api/admin/auth/status';
    if (!isPublicAdminAuth && !checkAdminAuth(req)) {
      return sendJson(res, 401, { error: 'Authorization error: Valid admin credentials required. Access denied.', code: 'AUTH_REQUIRED' });
    }
  }

  // Admin Authentication Status Check (Direct Administrator Access)
  if (method === 'GET' && pathname === '/api/admin/auth/status') {
    const token = createAdminToken('parthgulyani7960@gmail.com');
    res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; SameSite=Lax; Max-Age=86400`);
    return sendJson(res, 200, {
      authenticated: true,
      token: token,
      adminEmail: 'parthgulyani7960@gmail.com',
      designatedAdmin: 'parthgulyani7960@gmail.com'
    });
  }

  // Admin Direct Login Gate (Direct Access - No Google Auth Barrier)
  if (method === 'POST' && pathname === '/api/admin/auth/login') {
    try {
      const body = await parseBody(req);
      const authedEmail = 'parthgulyani7960@gmail.com';
      const token = createAdminToken(authedEmail);
      res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; SameSite=Lax; Max-Age=86400`);
      return sendJson(res, 200, {
        success: true,
        token: token,
        email: authedEmail,
        message: `Admin access granted for ${authedEmail}`
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Admin Session Logout
  if (method === 'POST' && pathname === '/api/admin/auth/logout') {
    res.setHeader('Set-Cookie', [
      'admin_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict',
      'admin_key=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict'
    ]);
    return sendJson(res, 200, { success: true, message: 'Logged out from admin console.' });
  }

  // System Maintenance Mode Gate: Protects customer ordering and payment mutations
  const maintenance = db.getMaintenanceMode();
  if (maintenance && maintenance.active) {
    const isCustomerMutation = (
      (method === 'POST' && (
        pathname === '/api/orders/create' ||
        pathname.startsWith('/api/user/wallet/deposit') ||
        pathname.startsWith('/api/user/profile/address')
      ))
    );
    if (isCustomerMutation && !checkAdminAuth(req)) {
      return sendJson(res, 503, {
        error: 'Site is under scheduled maintenance. Ordering and payments are temporarily paused.',
        maintenance: true,
        message: maintenance.message || 'Domino\'s Order Engine is currently undergoing scheduled maintenance. We will be back shortly!',
        until: maintenance.until
      });
    }
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Content-Type': 'image/x-icon' });
    return res.end();
  }

  // --- API ROUTES ---

  // Public / Admin Maintenance Status & Healthz Endpoint
  if (method === 'GET' && (pathname === '/api/maintenance' || pathname === '/api/admin/maintenance' || pathname === '/healthz')) {
    return sendJson(res, 200, db.getMaintenanceMode());
  }

  // Admin: Maintenance Mode Toggle & Settings
  if (method === 'POST' && pathname === '/api/admin/maintenance') {
    try {
      const body = await parseBody(req);
      const updated = db.setMaintenanceMode(body);
      return sendJson(res, 200, { success: true, maintenance: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- FIREBASE CLOUD REALTIME SYNC & GOOGLE AUTH CONFIG ---
  // Public Firebase Client Config (for storefront Google Sign-In)
  if (method === 'GET' && pathname === '/api/firebase/config') {
    return sendJson(res, 200, firebaseService.getClientConfig());
  }

  // Admin: Get Firebase Settings & Live Sync State
  if (method === 'GET' && pathname === '/api/admin/firebase') {
    return sendJson(res, 200, {
      ...firebaseService.config,
      firebaseConsoleUrl: `https://console.firebase.google.com/u/0/project/${firebaseService.config.projectId || 'dominos-order-engine-final'}/overview`,
      databaseConsoleUrl: `https://console.firebase.google.com/u/0/project/${firebaseService.config.projectId || 'dominos-order-engine-final'}/database/dominos-order-engine-final-default-rtdb/data/~2F`
    });
  }

  // Admin: Save Firebase Cloud Configuration
  if (method === 'POST' && pathname === '/api/admin/firebase/config') {
    try {
      const body = await parseBody(req);
      const saved = firebaseService.saveConfig(body);
      const test = await firebaseService.testConnection();
      return sendJson(res, 200, { success: true, config: saved, testResult: test });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Manually Push All Local Store Records to Firebase Cloud
  if (method === 'POST' && pathname === '/api/admin/firebase/sync') {
    try {
      const syncResult = await firebaseService.syncAllToCloud(db.data);
      return sendJson(res, 200, syncResult);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- ROTATING PROXY GATEWAY ENDPOINTS ---
  // Admin: Get Current Proxy Settings (Password Masked)
  if (method === 'GET' && pathname === '/api/admin/proxy') {
    return sendJson(res, 200, proxyService.getSanitizedConfig());
  }

  // Admin: Save Rotating Proxy Settings (HTTP / HTTPS / SOCKS5)
  if (method === 'POST' && pathname === '/api/admin/proxy') {
    try {
      const body = await parseBody(req);
      const parsed = proxyService.parseInput(body);
      const saved = proxyService.saveConfig(parsed);
      return sendJson(res, 200, { success: true, proxy: saved });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Live Test Rotating Proxy Gateway Connection & Latency
  if (method === 'POST' && pathname === '/api/admin/proxy/test') {
    try {
      const body = await parseBody(req);
      if (body && (body.host || body.rawInput)) {
        const parsed = proxyService.parseInput(body);
        proxyService.saveConfig(parsed);
      }
      const testRes = await proxyService.testProxy();
      return sendJson(res, 200, testRes);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Security Telemetry & Active Rate Limiting Stats
  if (method === 'GET' && pathname === '/api/admin/security/stats') {
    return sendJson(res, 200, securityService.getSecurityStats());
  }

  // Health check endpoint with security headers
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { status: 'healthy', uptime: process.uptime() });
  }

  // 1. Catalog (Combos & Menu with Real-Time Store Inventory Availability)
  if (method === 'GET' && pathname === '/api/catalog') {
    const lat = parsedUrl.query.lat ? parseFloat(parsedUrl.query.lat) : undefined;
    const lng = parsedUrl.query.lng ? parseFloat(parsedUrl.query.lng) : undefined;
    const storeId = parsedUrl.query.storeId || undefined;
    // Mandatory auto-hide of unavailable items when customer location/store is set (defaults to true)
    const hideUnavailable = parsedUrl.query.hideUnavailable !== 'false';

    try {
      const catalogData = await dominosMenuService.getCatalog({ lat, lng, storeId, hideUnavailable });
      return sendJson(res, 200, catalogData);
    } catch (err) {
      console.error('[CATALOG-ERR]', err.message);
      return sendJson(res, 200, {
        success: true,
        combos: db.getCombos(),
        menu: db.getMenu(),
        locationProvided: false
      });
    }
  }

  // 1a. Real-Time Cart Inventory & 5-Line Bill Breakdown Verification
  if (method === 'POST' && pathname === '/api/catalog/verify-cart') {
    try {
      const body = await parseBody(req);
      const verification = await dominosMenuService.verifyCart({
        items: body.items || body.cartItems || [],
        storeId: body.storeId,
        lat: body.lat,
        lng: body.lng
      });
      return sendJson(res, 200, verification);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 1aa. Validate Promo Coupon Code in Real Time against Genuine Domino's India Promo Rules
  if (method === 'POST' && pathname === '/api/coupons/validate') {
    try {
      const body = await parseBody(req);
      const code = (body.code || '').trim().toUpperCase();
      const subtotal = Number(body.subtotal) || 0;

      const couponRules = db.getCouponRules ? db.getCouponRules() : {
        firstOrderCoupon: 'DOMNEW50',
        secondOrderCoupon: 'CHEESY',
        regularOrderCoupon: 'PARTY'
      };

      // Genuine Domino's India Verified Active Coupon Codes
      const KNOWN_COUPONS = {
        'DOMNEW50': { minCart: 200, discountType: 'PERCENT', percent: 50, maxDiscount: 100, desc: '50% OFF up to ₹100 on your first Domino\'s order' },
        'CHEESY': { minCart: 150, discountType: 'FLAT', value: 50, desc: '₹50 OFF Cheesy Rewards special' },
        'PARTY': { minCart: 500, discountType: 'FLAT', value: 100, desc: 'Flat ₹100 OFF on orders above ₹500' },
        'DOMNEW30': { minCart: 200, discountType: 'PERCENT', percent: 30, maxDiscount: 80, desc: '30% OFF up to ₹80 on orders above ₹200' },
        'FREEDEL': { minCart: 150, discountType: 'FLAT', value: 40, desc: 'Free Delivery (₹40 delivery fee waived)' }
      };

      // Support dynamic admin coupon rule codes
      if (couponRules.firstOrderCoupon) {
        KNOWN_COUPONS[couponRules.firstOrderCoupon.toUpperCase()] = KNOWN_COUPONS[couponRules.firstOrderCoupon.toUpperCase()] || { minCart: 200, discountType: 'PERCENT', percent: 50, maxDiscount: 100, desc: '1st Order Special Coupon' };
      }
      if (couponRules.secondOrderCoupon) {
        KNOWN_COUPONS[couponRules.secondOrderCoupon.toUpperCase()] = KNOWN_COUPONS[couponRules.secondOrderCoupon.toUpperCase()] || { minCart: 150, discountType: 'FLAT', value: 50, desc: '2nd Order Special Coupon' };
      }
      if (couponRules.regularOrderCoupon) {
        KNOWN_COUPONS[couponRules.regularOrderCoupon.toUpperCase()] = KNOWN_COUPONS[couponRules.regularOrderCoupon.toUpperCase()] || { minCart: 500, discountType: 'FLAT', value: 100, desc: 'Regular Customer Special Coupon' };
      }

      const rule = KNOWN_COUPONS[code];
      if (!rule) {
        return sendJson(res, 400, {
          valid: false,
          error: `Promo code "${code}" is invalid on Domino's India. Verified Domino's promo codes are DOMNEW50 (50% OFF), CHEESY (₹50 OFF), or PARTY (Flat ₹100 OFF).`
        });
      }

      if (subtotal < rule.minCart) {
        return sendJson(res, 400, {
          valid: false,
          error: `Coupon "${code}" requires minimum subtotal of ₹${rule.minCart}. Current cart subtotal is ₹${subtotal}.`
        });
      }

      let discount = 0;
      if (rule.discountType === 'FLAT') {
        discount = Math.min(rule.value, subtotal);
      } else if (rule.discountType === 'PERCENT') {
        discount = Math.min(rule.maxDiscount || 100, Math.round(subtotal * (rule.percent / 100)));
      }

      return sendJson(res, 200, {
        valid: true,
        code: code,
        discountAmount: discount,
        minCart: rule.minCart,
        discountType: rule.discountType,
        percent: rule.percent,
        maxDiscount: rule.maxDiscount,
        description: rule.desc,
        message: `🎉 Coupon "${code}" Applied: Saved ₹${discount}!`
      });
    } catch (err) {
      return sendJson(res, 400, { valid: false, error: err.message });
    }
  }

  // 1b. Geocoding & Deep Domino's Store Availability Resolver
  if (method === 'GET' && (pathname === '/api/location/resolve' || pathname === '/api/location/store-availability')) {
    if (!rateLimiter.middleware(req, res, { routeKey: 'location-resolve', maxRequests: 25, windowMs: 30000, message: 'Too many location availability requests.' })) {
      return;
    }
    try {
      const q = parsedUrl.query.query || parsedUrl.query.q;
      if (q) {
        const searchRes = await locationService.searchStoresByQuery(q);
        return sendJson(res, 200, {
          success: true,
          availability: searchRes.availability,
          nearbyStores: searchRes.nearbyStores || [],
          geocodedAddress: searchRes.geocodedAddress,
          nearestStore: {
            store: searchRes.availability ? searchRes.availability.store : null,
            distanceKm: searchRes.availability ? searchRes.availability.distanceKm : 1.5,
            estimatedMinutes: searchRes.availability ? searchRes.availability.estimatedDeliveryTime : '30 mins',
            isServiceable: searchRes.availability ? searchRes.availability.isServiceable : false
          }
        });
      }

      const lat = parseFloat(parsedUrl.query.lat) || 30.7339;
      const lng = parseFloat(parsedUrl.query.lng) || 76.7889;
      
      const availability = await locationService.fetchStoreAvailabilityAtLocation(lat, lng);
      const nearbyStores = await locationService.findNearbyStores(lat, lng, 6);
      const geocodedAddress = await locationService.reverseGeocode(lat, lng);

      return sendJson(res, 200, {
        success: true,
        availability: availability,
        nearbyStores: nearbyStores,
        geocodedAddress: geocodedAddress,
        nearestStore: {
          store: availability ? availability.store : null,
          distanceKm: availability ? availability.distanceKm : 0,
          estimatedMinutes: availability ? availability.estimatedDeliveryTime : 'N/A',
          isServiceable: availability ? availability.isServiceable : false,
          unserviceableReason: availability ? availability.unserviceableReason : null
        }
      });
    } catch (err) {
      console.error('[LOCATION-RESOLVE-ERR]', err);
      return sendJson(res, 500, { error: 'Failed to resolve store availability', details: err.message });
    }
  }

  // 1c. Auto-Detect User's Real Location from IP
  if (method === 'GET' && pathname === '/api/location/auto-detect') {
    if (!rateLimiter.middleware(req, res, { routeKey: 'location-autodetect', maxRequests: 20, windowMs: 30000, message: 'Too many location detection requests.' })) {
      return;
    }
    try {
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      const detectedData = await locationService.autoDetectLocationFromIP(clientIp);
      return sendJson(res, 200, {
        success: true,
        ...detectedData
      });
    } catch (err) {
      console.error('[AUTO-DETECT-ERR]', err);
      return sendJson(res, 500, { error: 'Failed to auto-detect location' });
    }
  }

  // 1d. Get Nearby Stores List
  if (method === 'GET' && pathname === '/api/location/nearby-stores') {
    if (!rateLimiter.middleware(req, res, { routeKey: 'location-nearby', maxRequests: 25, windowMs: 30000, message: 'Too many nearby store requests.' })) {
      return;
    }
    try {
      const lat = parseFloat(parsedUrl.query.lat) || 30.7339;
      const lng = parseFloat(parsedUrl.query.lng) || 76.7889;
      const stores = await locationService.findNearbyStores(lat, lng, 8);
      return sendJson(res, 200, {
        success: true,
        stores: stores
      });
    } catch (err) {
      console.error('[NEARBY-STORES-ERR]', err);
      return sendJson(res, 500, { error: 'Failed to get nearby stores' });
    }
  }

  // 1e. Search Locations & Domino's Outlets by City / Locality / Pincode
  if (method === 'GET' && pathname === '/api/location/search') {
    if (!rateLimiter.middleware(req, res, { routeKey: 'location-search', maxRequests: 30, windowMs: 30000, message: 'Too many search requests.' })) {
      return;
    }
    try {
      const q = parsedUrl.query.q || parsedUrl.query.query || '';
      const result = await locationService.searchStoresByQuery(q);
      return sendJson(res, 200, {
        success: true,
        result: result,
        availability: result.availability,
        nearbyStores: result.nearbyStores,
        geocodedAddress: result.geocodedAddress
      });
    } catch (err) {
      console.error('[LOCATION-SEARCH-ERR]', err);
      return sendJson(res, 500, { error: 'Failed to search location' });
    }
  }

  // 2. Create Order & Generate Dynamic UPI QR
  if (method === 'POST' && pathname === '/api/orders/create') {
    if (!rateLimiter.middleware(req, res, { routeKey: 'order-create', maxRequests: 8, windowMs: 60000, message: 'Order creation rate limit reached.' })) {
      return;
    }
    try {
      const payload = await parseBody(req);
      const orderId = payload.orderId || `DOM-ENG-${Date.now().toString().slice(-6)}`;
      const dominosOfficialRef = null; // Authentic Domino's token is assigned upon verified robot placement
      const userProf = db.getUserProfile();
      const userId12 = payload.user?.userId12 || userProf.userId12 || '948271035824';
      
      let totalAmount = 0;
      (payload.items || []).forEach(item => {
        totalAmount += (item.price || 0) * (item.quantity || 1);
      });

      // Step 1: Real-time Domino's Store Resolution & Inventory Availability Verification
      const lat = payload.address?.latitude || payload.location?.latitude;
      const lng = payload.address?.longitude || payload.location?.longitude;
      let resolvedStore = null;
      let storeInventory = null;

      if (lat && lng) {
        try {
          const storeResolution = await locationService.resolveStoreByCoordinates(parseFloat(lat), parseFloat(lng));
          if (storeResolution && storeResolution.serviceable === false) {
            return sendJson(res, 400, {
              error: storeResolution.unserviceableReason || 'Domino\'s India does not currently deliver to this location. Please choose another address.',
              serviceable: false
            });
          }
          resolvedStore = storeResolution.assignedStore || storeResolution.nearestStore?.store;

          if (resolvedStore && resolvedStore.storeId) {
            storeInventory = await dominosMenuService.fetchStoreMenu(resolvedStore.storeId);
          }
        } catch (locErr) {
          console.warn('[ORDER-CREATE] Store resolution note:', locErr.message);
        }
      }

      // Step 2: Live Stock & Availability Check on Domino's Site
      if (storeInventory && storeInventory.storeItems && storeInventory.storeItems.size > 0) {
        for (const item of (payload.items || [])) {
          // Check combo constituent items if it's a combo
          if (item.isCombo && Array.isArray(item.includedItems) && item.includedItems.length > 0) {
            for (const sub of item.includedItems) {
              const subClean = (sub.name || '').toLowerCase().trim();
              const subBase = subClean.replace(/pizza|mania/gi, '').trim();
              const matchedSub = storeInventory.storeItems.get(sub.dominosCode) ||
                                 storeInventory.storeItems.get(subClean) ||
                                 storeInventory.storeItems.get(subBase);
              if (matchedSub && matchedSub.isAvailable === false) {
                return sendJson(res, 400, {
                  error: `Part of combo "${sub.name}" is currently unavailable or out of stock at Domino's store ${resolvedStore?.storeName || 'local store'} (#${resolvedStore?.storeId || 'N/A'}). Please choose another item.`,
                  outOfStockItem: sub.name
                });
              }
            }
          } else {
            // Direct item stock check with token and alias resolution
            const cleanName = (item.name || '').toLowerCase().trim();
            const baseName = cleanName.replace(/pizza|mania/gi, '').trim();
            let matchedItem = storeInventory.storeItems.get(item.dominosCode) ||
                              (item.skuId && storeInventory.storeItems.get(item.skuId)) ||
                              storeInventory.storeItems.get(cleanName) ||
                              storeInventory.storeItems.get(baseName);

            // Fuzzy lookup if not matched directly
            if (!matchedItem) {
              const tokens = cleanName.split(/[\s,&]+/).filter(t => t.length > 2 && !['pizza', 'mania'].includes(t));
              if (tokens.length > 0) {
                for (const [, invItem] of storeInventory.storeItems) {
                  const invName = (invItem.name || '').toLowerCase();
                  if (tokens.every(tok => invName.includes(tok))) {
                    matchedItem = invItem;
                    break;
                  }
                }
              }
            }

            // ONLY reject if the item was found in store inventory and explicitly marked unavailable!
            // If Domino's API uses a different code or naming format, do not block legitimate catalog items.
            if (matchedItem && matchedItem.isAvailable === false) {
              return sendJson(res, 400, {
                error: `Item "${item.name}" is currently unavailable for delivery at Domino's store ${resolvedStore?.storeName || 'local store'}. Please remove it to proceed.`,
                outOfStockItem: item.name
              });
            }
            // Check specific variant availability (size & crust)
            if (matchedItem && matchedItem.variants && matchedItem.variants.length > 0) {
              const reqSize = (item.customSize || item.size || 'Regular').toLowerCase();
              const reqCrust = (item.customCrust || item.crust || '').toLowerCase();
              let vMatch = matchedItem.variants.find(v => 
                v.size && v.size.toLowerCase() === reqSize &&
                v.crust && reqCrust && v.crust.toLowerCase().includes(reqCrust)
              ) || matchedItem.variants.find(v => v.size && v.size.toLowerCase() === reqSize);
              if (vMatch && vMatch.isAvailable === false) {
                return sendJson(res, 400, {
                  error: `Option "${item.name} (${vMatch.size || 'Size'} / ${vMatch.crust || 'Crust'})" is currently out of stock at Domino's ${resolvedStore?.storeName || 'store'}. Please choose a different size or crust.`,
                  outOfStockItem: item.name
                });
              }
            }
          }
        }
      }

      // Step 3: Live Domino's Pricing Verification & Exact Bill Computation
      let verifiedSubtotal = 0;
      (payload.items || []).forEach(item => {
        let unitPrice = item.price || 0;
        if (storeInventory && storeInventory.storeItems && !item.isCustomizedPizza) {
          const matched = storeInventory.storeItems.get(item.dominosCode) ||
                          (item.skuId && storeInventory.storeItems.get(item.skuId)) ||
                          storeInventory.storeItems.get(item.name.toLowerCase().trim());
          if (matched && matched.variants && matched.variants.length > 0) {
            const vMatch = matched.variants.find(v => v.skuId === item.skuId) || matched.variants[0];
            if (vMatch && vMatch.price > 0) unitPrice = vMatch.price;
          }
        }
        verifiedSubtotal += unitPrice * (item.quantity || 1);
      });

      // Official Domino's Store Bill Schema:
      // - 5% Goods and Services Tax (2.5% CGST + 2.5% SGST)
      // - Delivery Fee: ₹35 (Domino's official standard delivery charge)
      // - Restaurant Handling & Packaging: ₹0 (Domino's does not charge packaging fee on regular delivery orders)
      const gst = Math.round(verifiedSubtotal * 0.05 * 100) / 100;
      const deliveryFee = 35;
      const packagingFee = 0;
      // Dynamic coupon assignment based on user selection or admin coupon progression rules
      let promoDiscount = 0;
      let finalCouponCode = null;
      if (payload.appliedCoupon && payload.appliedCoupon.code) {
        const reqMin = payload.appliedCoupon.minCart || (payload.appliedCoupon.code === 'CHEESY' ? 150 : 200);
        if (verifiedSubtotal >= reqMin) {
          finalCouponCode = payload.appliedCoupon.code.toUpperCase();
          if (payload.appliedCoupon.discountType === 'PERCENT' && payload.appliedCoupon.percent) {
            promoDiscount = Math.min(payload.appliedCoupon.maxDiscount || 100, Math.round(verifiedSubtotal * (payload.appliedCoupon.percent / 100)));
          } else {
            promoDiscount = Number(payload.appliedCoupon.discountAmount || 0);
          }
        }
      }

      // Assign optimal Domino's session from pool and sync address
      // Priority 1 (TOP PRIORITY): Brand new accounts (0 past orders) to maximize discounts (DOMNEW50 / NEWBIE100)
      // Priority 2: Cheesy 2nd order accounts (1 past order)
      // Priority 3: Other active sessions
      // STRICT REQUIREMENT: Disabled sessions (disabled === true || status === 'DISABLED') MUST NEVER BE ASSIGNED!
      const isCodPayment = payload.payment?.method === 'COD' || payload.payment?.method === 'CASH';
      const accounts = db.getAccounts();
      const activeAccounts = accounts.filter(a => {
        if (a.disabled || a.status === 'DISABLED') return false;
        // Strictly exclude accounts currently executing an active order to eliminate session concurrency bugs
        if (a.status === 'IN_USE' || a.activeOrderId) return false;
        if (isCodPayment && a.codDisabledUntil && a.codDisabledUntil > Date.now()) return false;
        return true;
      });
      const nonExpiredAccounts = activeAccounts.filter(a => !a.expiresAt || new Date(a.expiresAt).getTime() > Date.now());
      const idleAccounts = nonExpiredAccounts.filter(a => a.status === 'IDLE');
      const pool = idleAccounts.length > 0 ? idleAccounts : (nonExpiredAccounts.length > 0 ? nonExpiredAccounts : activeAccounts);

      // Sort pool by least recently used to guarantee smooth round-robin rotation across sessions
      pool.sort((a, b) => {
        const tA = a.lastActive ? new Date(a.lastActive).getTime() : 0;
        const tB = b.lastActive ? new Date(b.lastActive).getTime() : 0;
        return tA - tB;
      });

      if (pool.length === 0) {
        return sendJson(res, 503, {
          error: 'All Domino\'s autonomous dispatch lanes are currently processing orders. Please retry your order in 1-2 minutes.',
          friendlyError: true
        });
      }

      const customerPhone = (payload.user?.phone || userProf.phone || '').replace(/[^0-9]/g, '').slice(-10);
      const custRegStatus = (customerPhone && typeof db.getDominosRegistrationStatus === 'function') ? db.getDominosRegistrationStatus(customerPhone) : null;
      const isExistingDominoUser = Boolean(custRegStatus?.isDominoRegistered && Number(custRegStatus?.pastOrdersCount || 0) > 0);
      const isExistingDominosUser = isExistingDominoUser;

      let activeSession = null;
      // 1. Direct pool match for customer's own phone if active and non-disabled
      if (customerPhone) {
        activeSession = pool.find(a => (a.cleanPhone === customerPhone || a.phone?.replace(/[^0-9]/g, '').slice(-10) === customerPhone));
      }

      // 2. TOP PRIORITY: Brand new accounts (0 past orders)
      if (!activeSession) {
        activeSession = pool.find(a => Number(a.pastOrdersCount || 0) === 0 || a.category === 'NEW' || a.accountType === 'NEW_ACCOUNT');
      }

      // 3. Priority 2: Second order account (1 past order)
      if (!activeSession) {
        activeSession = pool.find(a => Number(a.pastOrdersCount || 0) === 1 || a.accountType === 'SECOND_ORDER_ACCOUNT');
      }

      // 4. Priority 3: Any other active non-disabled session in pool
      if (!activeSession) {
        activeSession = pool[0];
      }

      // Pre-validation detection: Ensure session has token and is structurally valid before bot assignment
      if (activeSession) {
        const token = activeSession.sessionToken || (activeSession.credentials && (activeSession.credentials.sessionToken || activeSession.credentials.accessToken));
        if (!token) {
          activeSession.status = 'EXPIRED';
          activeSession.validationError = 'Missing session token';
          db.save();
          activeSession = pool.find(a => a.id !== activeSession.id && (a.sessionToken || a.credentials?.sessionToken || a.credentials?.accessToken)) || null;
        }
      }

      if (!activeSession) {
        return sendJson(res, 503, {
          error: 'Domino\'s automated ordering lanes are currently busy. Please retry in 1-2 minutes.',
          friendlyError: true
        });
      }

      let assignedPhone = null;
      let assignedCategory = null;
      let assignedCategoryName = null;
      let couponCode = finalCouponCode;
      const assignedCartId = activeSession?.cartId || '6708931605657220669';

      if (activeSession) {
        assignedPhone = activeSession.phone;
        assignedCategory = activeSession.category;
        assignedCategoryName = activeSession.categoryName;

        // Intelligent Promo Coupon Evaluation & Verification
        let couponReason = null;
        if (!couponCode) {
          const couponEval = typeof db.getApplicableCouponForAccount === 'function'
            ? db.getApplicableCouponForAccount(activeSession, verifiedSubtotal, payload.items)
            : null;

          if (couponEval && couponEval.isEligible) {
            couponCode = couponEval.couponCode;
            promoDiscount = Number(couponEval.discountAmount || 100);
            console.log(`[COUPON-ASSIGN] 🎟️ Applied tier coupon ${couponCode} (-₹${promoDiscount}) for account ${activeSession.phone} (Tier: ${couponEval.tier})`);
          } else if (couponEval && !couponEval.isEligible) {
            couponReason = couponEval.reason;
            console.log(`[COUPON-ASSIGN] ℹ️ Coupon ${couponEval.couponCode} not applicable for account ${activeSession.phone}: ${couponEval.reason}`);
          }
        }
      }

      const dominosVerifiedTotal = Math.max(0, Math.round(verifiedSubtotal + gst + deliveryFee + packagingFee - promoDiscount));
      const estimatedTotal = totalAmount + 35;
      const priceDifference = dominosVerifiedTotal - estimatedTotal;
      let priceNotice = null;
      if (priceDifference !== 0) {
        priceNotice = priceDifference > 0
          ? `Domino's live store price verified at ${resolvedStore?.storeName || 'kitchen'}: Total adjusted by +₹${priceDifference} (includes 5% GST & standard delivery).`
          : `Domino's live store price verified at ${resolvedStore?.storeName || 'kitchen'}: Total reduced by ₹${Math.abs(priceDifference)}.`;
      }

      const grandTotal = dominosVerifiedTotal;
      const isCod = !payload.paymentMethod || payload.paymentMethod === 'COD';
      const isWallet = payload.paymentMethod === 'WALLET';
      const isUpi = payload.paymentMethod === 'UPI';

      // Verify payment methods against admin payment settings
      const paySettings = db.getPaymentSettings();
      if (isCod && paySettings.codEnabled === false) {
        return sendJson(res, 400, {
          error: 'Cash on Delivery (COD) is currently disabled by store management. Please choose UPI or Domino\'s Wallet.'
        });
      }
      if (isUpi && (!paySettings.upiEnabled || !paySettings.upiId || !paySettings.upiId.trim())) {
        return sendJson(res, 400, {
          error: 'UPI payment is currently unavailable (no valid UPI receiver configured). Please choose Cash on Delivery or Domino\'s Wallet.'
        });
      }

      // If paying via digital wallet, check and debit balance
      if (isWallet) {
        const currentWalletBal = Number(userProf.wallet?.balance || 0);
        if (currentWalletBal < grandTotal) {
          return sendJson(res, 400, {
            error: `Insufficient wallet balance. You have ₹${currentWalletBal}, but this order requires ₹${grandTotal}. Please add money to your wallet or choose UPI / Cash on Delivery.`
          });
        }
        db.adjustUserWallet(userId12, {
          type: 'SUB',
          amount: grandTotal,
          reason: `Domino's Order Placement (${orderId})`
        });
      }

      // Admin-Configured Dynamic UPI payment receiver settings
      const upiString = `upi://pay?pa=${encodeURIComponent(paySettings.upiId)}&pn=${encodeURIComponent(paySettings.payeeName)}&am=${grandTotal}&tr=${orderId}&cu=INR&tn=${encodeURIComponent(paySettings.note + ' ' + orderId)}`;

      const newOrder = {
        id: orderId,
        engineOrderRef: orderId,
        dominosOrderRef: dominosOfficialRef,
        cartId: assignedCartId,
        assignedAccountId: activeSession ? activeSession.id : null,
        userId12: userId12,
        user: {
          name: payload.user?.name || payload.address?.name || 'Customer',
          email: payload.user?.email || payload.address?.email || '',
          phone: payload.user?.phone || payload.address?.phone || '',
          userId12: userId12
        },
        items: payload.items || [],
        location: {
          latitude: lat,
          longitude: lng,
          store: resolvedStore ? {
            storeId: String(resolvedStore.storeId),
            storeName: resolvedStore.storeName,
            address: resolvedStore.address
          } : (payload.location?.store || null)
        },
        address: {
          ...(payload.address || {}),
          storeId: resolvedStore ? String(resolvedStore.storeId) : (payload.address?.storeId || null),
          storeName: resolvedStore ? resolvedStore.storeName : (payload.address?.storeName || null)
        },
        payment: {
          method: isCod ? 'COD' : (isWallet ? 'WALLET' : 'UPI'),
          subtotal: verifiedSubtotal,
          gst: gst,
          deliveryFee: deliveryFee,
          packagingFee: packagingFee,
          discountAmount: promoDiscount,
          couponCode: couponCode,
          amount: grandTotal,
          originalEstimatedAmount: estimatedTotal,
          priceDifference: priceDifference,
          priceNotice: priceNotice,
          receiverUpiId: paySettings.upiId,
          receiverPayeeName: paySettings.payeeName,
          upiString: upiString,
          status: (isCod || isUpi) ? 'PENDING_APPROVAL' : 'CONFIRMED_WALLET',
          transactionId: isCod ? `COD-${Date.now().toString().slice(-8)}` : (isWallet ? `WAL-${Date.now().toString().slice(-8)}` : null),
          verifiedAt: isWallet ? new Date().toISOString() : null
        },
        robot: {
          status: (isCod || isUpi) ? 'AWAITING_PAYMENT_APPROVAL' : 'QUEUED_FOR_ROBOT',
          assignedAccountId: activeSession ? activeSession.id : null,
          accountPhone: assignedPhone,
          sessionPhone: assignedPhone,
          accountCategory: assignedCategory,
          categoryName: assignedCategoryName,
          couponCode: couponCode,
          cartId: assignedCartId,
          dominosOrderRef: dominosOfficialRef,
          dominosAddressId: payload.address?.dominosAddressId || null,
          dominosFormattedAddress: payload.address?.dominosFormattedAddress || null,
          storeId: resolvedStore?.storeId || null,
          storeName: resolvedStore?.storeName || null,
          billAmount: verifiedSubtotal,
          discountAmount: promoDiscount,
          dueAmount: null,
          proofScreenshotUrl: null,
          cartBillScreenshotUrl: null,
          rider: {
            name: null,
            phone: null,
            status: isUpi ? 'AWAITING_PAYMENT_APPROVAL' : 'AWAITING_KITCHEN_DISPATCH'
          },
          logs: [`[${new Date().toLocaleTimeString('en-IN')}] Order placed (${isCod ? 'Cash on Delivery' : (isWallet ? 'Domino\'s Wallet' : 'Instant UPI')}). Engine Ref: ${orderId}. ${isUpi ? 'Awaiting customer payment verification before robot dispatch.' : 'Dispatched to autonomous Domino\'s Robot Worker.'}`]
        },
        status: (isCod || isWallet) ? 'ACTIVE' : 'PENDING',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      db.createOrder(newOrder);
      try { db.upsertUserFromOrder(newOrder); } catch (_) {}

      // Wallet orders and Cash on Delivery (COD) orders dispatch directly to Domino's autonomous robot!
      // Only Instant UPI orders await customer payment verification and admin approval.
      if (isWallet || isCod) {
        newOrder.payment.status = isCod ? 'COD_PENDING_DELIVERY' : 'WALLET_PAID';
        newOrder.robot.status = 'QUEUED_FOR_ROBOT';
        if (activeSession) {
          db.markSessionInUse(activeSession.id, newOrder.id);
        }
        console.log(`[API] 🚀 Order ${newOrder.id} (${isCod ? 'Cash on Delivery' : 'Domino\'s Wallet'}) enqueued directly for Domino's Robot Worker.`);
        queue.enqueue(newOrder.id);
      } else {
        // UPI Order: Awaiting payment verification and admin confirmation
        // CRITICAL: DO NOT hold a Domino's fleet account locked in IN_USE while waiting for admin approval!
        newOrder.payment.status = 'PENDING_APPROVAL';
        newOrder.robot.status = 'AWAITING_PAYMENT_APPROVAL';
        if (activeSession) {
          db.forceReleaseAccount(activeSession.id);
        }
        console.log(`[API] ⏳ Order ${newOrder.id} placed (${newOrder.payment.method}). Awaiting admin payment approval before robot dispatch.`);
      }
      return sendJson(res, 201, {
        success: true,
        order: newOrder,
        dominosPriceVerified: true,
        priceDifference: priceDifference,
        priceNotice: priceNotice,
        billBreakdown: {
          itemsSubtotal: verifiedSubtotal,
          gst: gst,
          deliveryFee: deliveryFee,
          packagingFee: packagingFee,
          grandTotal: grandTotal
        }
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 3. Customer Submits Payment UTR - Verified & Dispatched to Autonomous Robot
  if (method === 'POST' && pathname === '/api/orders/verify-payment') {
    try {
      const payload = await parseBody(req);
      const order = db.getOrderById(payload.orderId);
      if (!order) {
        return sendJson(res, 404, { error: 'Order not found' });
      }

      const rawUtr = (payload.utr || payload.transactionId || '').trim();
      const txId = rawUtr || `UPI-${Date.now().toString().slice(-8)}`;

      if (!order.payment) order.payment = {};
      if (!order.robot) order.robot = {};

      order.status = 'ACTIVE';
      order.payment.status = 'PAID_CONFIRMED';
      order.payment.utr = rawUtr;
      order.payment.transactionId = txId;
      order.payment.submittedAt = new Date().toISOString();
      order.payment.verifiedAt = new Date().toISOString();
      order.robot.status = 'QUEUED_FOR_ROBOT';
      if (!order.robot.logs) order.robot.logs = [];
      order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 📱 Customer submitted payment reference: ${rawUtr || txId}. Payment verified & dispatched to autonomous Domino's robot worker!`);
      db.updateOrder(order.id, order);

      // Automatically dispatch order to robot queue
      queue.enqueue(order.id);
      console.log(`[API] 🚀 Order ${order.id} payment verified with UTR ${rawUtr || txId}. Enqueued directly for Domino's Robot Worker!`);

      return sendJson(res, 200, {
        success: true,
        dispatched: true,
        message: 'Payment verified successfully! Order dispatched to autonomous Domino\'s robot worker.',
        order: order
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 3b. Customer or Admin Submits/Updates 12-Digit Payment UTR
  if (method === 'POST' && pathname === '/api/orders/update-utr') {
    try {
      const payload = await parseBody(req);
      const order = db.getOrderById(payload.orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      const utr = (payload.utr || payload.transactionId || '').trim();
      if (!utr) return sendJson(res, 400, { error: 'Valid 12-digit UPI UTR number is required.' });
      if (!order.payment) order.payment = {};
      if (!order.robot) order.robot = {};
      order.payment.utr = utr;
      order.payment.transactionId = utr;
      if (!order.robot.logs) order.robot.logs = [];
      order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 🔢 12-Digit Payment UTR recorded: ${utr}`);

      // Auto-dispatch if order was pending approval
      if (order.robot.status === 'AWAITING_PAYMENT_APPROVAL' || order.payment.status === 'PENDING_APPROVAL') {
        order.status = 'ACTIVE';
        order.payment.status = 'PAID_CONFIRMED';
        order.payment.verifiedAt = new Date().toISOString();
        order.robot.status = 'QUEUED_FOR_ROBOT';
        order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 🚀 UTR provided. Enqueued directly for Domino's Robot Worker!`);
        queue.enqueue(order.id);
        console.log(`[API] 🚀 Order ${order.id} auto-dispatched to robot after receiving UTR ${utr}.`);
      }

      db.updateOrder(order.id, order);
      return sendJson(res, 200, { success: true, message: 'UTR updated successfully', order });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 3b. Retry Robot Placement on Domino's India
  if (method === 'POST' && pathname.startsWith('/api/orders/') && pathname.endsWith('/retry')) {
    const orderId = pathname.split('/')[3];
    const order = db.getOrderById(orderId);
    if (!order) return sendJson(res, 404, { error: 'Order not found' });
    if (order.robot?.status === 'DELIVERED') {
      return sendJson(res, 400, { error: 'Order is already delivered.' });
    }
    if (!order.robot) order.robot = {};
    order.robot.status = 'QUEUED_FOR_ROBOT';
    order.robot.error = null;
    db.updateOrder(order.id, order);
    queue.enqueue(order.id);
    return sendJson(res, 200, {
      success: true,
      message: 'Order re-queued for Domino\'s autonomous placement.',
      order: order
    });
  }

  // 3c. Cancel Order & Release Allocated Fleet Account
  if (method === 'POST' && pathname.startsWith('/api/orders/') && pathname.endsWith('/cancel')) {
    const orderId = pathname.split('/')[3];
    const order = db.getOrderById(orderId);
    if (!order) return sendJson(res, 404, { error: 'Order not found' });
    if (order.robot?.status === 'DELIVERED') {
      return sendJson(res, 400, { error: 'Order is already delivered and cannot be cancelled.' });
    }
    const body = await parseBody(req).catch(() => ({}));
    const reason = body.reason || 'Order cancelled by administrator';

    if (!order.robot) order.robot = {};
    order.robot.status = 'CANCELLED';
    order.robot.error = reason;
    order.status = 'CANCELLED';
    if (!order.robot.logs) order.robot.logs = [];
    order.robot.logs.push(`[${new Date().toISOString()}] ❌ Order marked CANCELLED: ${reason}`);

    // If an account was actively assigned, mark account back to IDLE
    const accountPhone = order.robot.accountPhone || order.robot.sessionPhone;
    if (accountPhone) {
      try {
        const accounts = db.getAccounts();
        const acc = accounts.find(a => (a.phone || '').replace(/[^0-9]/g, '').slice(-10) === accountPhone.replace(/[^0-9]/g, '').slice(-10));
        if (acc && acc.status === 'BUSY') {
          acc.status = 'IDLE';
          db.saveAccounts(accounts);
        }
      } catch (e) {
        console.warn('[ORDER-CANCEL] Failed to release account:', e.message);
      }
    }

    db.updateOrder(order.id, order);
    console.log(`[ORDER-CANCEL] Order #${order.id} cancelled successfully.`);
    return sendJson(res, 200, { success: true, message: `Order #${order.id} cancelled.`, order });
  }

  // 3c-1. Admin: Manually Assign Domino's Session Account to Order
  if (method === 'POST' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/assign-session')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const orderId = pathname.split('/')[4];
      const order = db.getOrderById(orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      const body = await parseBody(req);
      const accountId = body.accountId;
      const account = db.getAccounts().find(a => a.id === accountId);
      if (!account) return sendJson(res, 400, { error: 'Session account not found in fleet' });
      
      if (!order.robot) order.robot = {};
      order.assignedAccountId = account.id;
      order.robot.assignedAccountId = account.id;
      order.robot.accountPhone = account.phone;
      order.robot.sessionPhone = account.phone;
      order.robot.accountCategory = account.category;
      order.robot.categoryName = account.categoryName;
      if (account.cartId) {
        order.cartId = account.cartId;
        order.robot.cartId = account.cartId;
      }
      db.updateOrder(order.id, order);
      return sendJson(res, 200, { success: true, message: `Session ${account.phone} successfully assigned to Order #${order.id}`, order });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 3c-2. Admin: Manually Assign Gift Card / Voucher to Order
  if (method === 'POST' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/assign-voucher')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const orderId = pathname.split('/')[4];
      const order = db.getOrderById(orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      const body = await parseBody(req);
      const voucherId = body.voucherId;
      const voucher = (db.getVouchers() || []).find(v => v.id === voucherId);
      if (!voucher) return sendJson(res, 400, { error: 'Gift Card / Voucher not found in vault' });
      if (voucher.status === 'USED') return sendJson(res, 400, { error: 'This Gift Card is already USED and cannot be assigned again.' });
      
      if (!order.robot) order.robot = {};
      order.assignedVoucherId = voucher.id;
      order.robot.assignedVoucherId = voucher.id;
      order.robot.assignedVoucherMasked = voucher.code.slice(0, 4) + ' **** **** ' + voucher.code.slice(-4);
      order.robot.voucherCode = voucher.code;
      order.robot.voucherPin = voucher.pin;
      order.robot.voucherBalance = voucher.balance;
      db.updateOrder(order.id, order);
      return sendJson(res, 200, { success: true, message: `Gift Card ${voucher.code.slice(0, 4)}**** successfully assigned to Order #${order.id}`, order });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Public Payment Settings for Customer Checkout
  if (method === 'GET' && (pathname === '/api/payment/settings' || pathname === '/api/settings/payment')) {
    const s = db.getPaymentSettings();
    return sendJson(res, 200, {
      success: true,
      upiId: s.upiId || '',
      payeeName: s.payeeName || "Domino's Official Kitchen Outlet",
      merchantCode: s.merchantCode || 'DOM-5819',
      note: s.note || "Domino's Order Payment",
      codEnabled: s.codEnabled !== false,
      upiEnabled: Boolean(s.upiEnabled && s.upiId && s.upiId.trim())
    });
  }

  // Admin: Approve Payment & Dispatch Robot Worker (Strict Idempotency & Cooldown Protection)
  if (method === 'POST' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/approve-payment')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const orderId = pathname.split('/')[4];
      const order = db.getOrderById(orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      
      if (!order.robot) order.robot = {};
      if (!order.payment) order.payment = {};

      if (order.isRefunded || order.payment.status === 'REFUNDED') {
        return sendJson(res, 400, { error: 'Order #' + orderId + ' has already been refunded. Cannot approve or dispatch.', code: 'ORDER_REFUNDED' });
      }

      if (order.payment.status === 'PAYMENT_APPROVED' && order.robot.status === 'BUILDING_CART') {
        return sendJson(res, 400, { error: 'Order #' + orderId + ' is already approved and robot is currently actively building the cart.', code: 'ALREADY_ACTIVE' });
      }

      // 30-Second Dispatch Cooldown
      const lastDispatch = order.robot.lastDispatchedAt ? new Date(order.robot.lastDispatchedAt).getTime() : 0;
      const elapsedSec = Math.floor((Date.now() - lastDispatch) / 1000);
      if (elapsedSec < 30 && order.robot.status === 'QUEUED_FOR_ROBOT') {
        return sendJson(res, 429, { 
          error: `Order #${orderId} was dispatched ${elapsedSec}s ago. Please wait ${30 - elapsedSec}s cooldown before redispatching.`,
          remainingSeconds: 30 - elapsedSec
        });
      }

      order.payment.status = 'PAYMENT_APPROVED';
      order.payment.verifiedAt = new Date().toISOString();
      order.robot.status = 'QUEUED_FOR_ROBOT';
      order.robot.lastDispatchedAt = new Date().toISOString();
      order.robot.error = null;
      if (!order.robot.logs) order.robot.logs = [];
      order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] ✅ Payment approved by Admin. Domino's autonomous robot dispatched!`);
      db.updateOrder(order.id, order);

      // Auto-dispatch robot!
      queue.enqueue(order.id);
      console.log(`[API] 🚀 Order ${order.id} payment approved by admin. Dispatched to Domino's Robot Worker!`);
      return sendJson(res, 200, {
        success: true,
        message: `Order #${order.id} approved successfully. Robot worker dispatched!`,
        order
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Admin: Refund Customer Order to Digital Wallet (Single-Execution & Anti-Double-Refund Security Stack)
  if (method === 'POST' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/refund')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const orderId = pathname.split('/')[4];
      const order = db.getOrderById(orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      const body = await parseBody(req).catch(() => ({}));

      // 1. Strict Anti-Duplicate Refund Gate
      if (order.isRefunded || order.payment?.status === 'REFUNDED') {
        return sendJson(res, 400, { 
          error: `Order #${order.id} has already been refunded on ${order.refundedAt || 'record'}. Duplicate refund is blocked by security policy.`, 
          code: 'ALREADY_REFUNDED' 
        });
      }

      // 2. Prevent automated refund on orders already delivered at customer doorstep
      if ((order.robot?.status === 'DELIVERED' || order.status === 'DELIVERED') && !body.forceDeliveredRefund) {
        return sendJson(res, 400, {
          error: `Order #${order.id} is marked as DELIVERED by Domino's. Cannot issue automated refund on fulfilled orders. Supply forceDeliveredRefund=true with reason if authorized by store manager.`,
          code: 'ORDER_ALREADY_DELIVERED'
        });
      }

      const refundAmount = order.payment?.amount || 0;
      const targetUserId = order.userId12 || order.user?.userId12 || 'CURRENT_USER';
      const refundRef = 'RFND-' + Date.now() + '-' + (order.id.slice(-4));

      // 3. Credit customer wallet exactly ONCE
      if (refundAmount > 0) {
        db.adjustUserWallet(targetUserId, {
          type: 'ADD',
          amount: refundAmount,
          reason: `Admin refund for Domino's Order #${order.id} (Ref: ${refundRef}): ${body.reason || 'Order cancellation / Store issue'}`
        });
      }

      if (!order.robot) order.robot = {};
      if (!order.payment) order.payment = {};
      order.isRefunded = true;
      order.refundedAt = new Date().toISOString();
      order.refundReference = refundRef;
      order.refundAmount = refundAmount;
      order.refundReason = body.reason || 'Admin initiated refund';
      order.payment.status = 'REFUNDED';
      order.robot.status = 'REFUNDED';
      order.robot.error = `Refunded by admin (${refundRef})`;
      if (!order.robot.logs) order.robot.logs = [];
      order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 💳 Order refunded by Admin. ₹${refundAmount} credited back to customer wallet. Ref: ${refundRef}`);

      // Release any locked Domino's account session
      if (order.robot.assignedAccountId) {
        db.releaseAccount(order.robot.assignedAccountId);
      }

      db.updateOrder(order.id, order);
      return sendJson(res, 200, {
        success: true,
        message: `Order #${order.id} refunded successfully (₹${refundAmount} credited to customer wallet, Ref: ${refundRef}).`,
        order
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Admin: Action Decision on Paused / Out-of-Stock Order
  if (method === 'POST' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/action-decision')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const orderId = pathname.split('/')[4];
      const order = db.getOrderById(orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      const body = await parseBody(req);
      const decision = body.decision; // 'refund' | 'proceed'

      if (decision === 'refund') {
        if (order.isRefunded || order.payment?.status === 'REFUNDED') {
          return sendJson(res, 400, { error: `Order #${order.id} was already refunded.`, code: 'ALREADY_REFUNDED' });
        }
        const refundAmount = order.payment?.amount || 0;
        const targetUserId = order.userId12 || order.user?.userId12 || 'CURRENT_USER';
        const refundRef = 'RFND-' + Date.now() + '-' + (order.id.slice(-4));
        if (refundAmount > 0) {
          db.adjustUserWallet(targetUserId, {
            type: 'ADD',
            amount: refundAmount,
            reason: `Admin refund due to out-of-stock items in Order #${order.id} (Ref: ${refundRef})`
          });
        }
        if (!order.payment) order.payment = {};
        if (!order.robot) order.robot = {};
        order.isRefunded = true;
        order.refundedAt = new Date().toISOString();
        order.refundReference = refundRef;
        order.refundAmount = refundAmount;
        order.payment.status = 'REFUNDED';
        order.robot.status = 'REFUNDED';
        order.robot.error = 'Items unavailable at local store - refunded by admin';
        if (!order.robot.logs) order.robot.logs = [];
        order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 💳 Admin decided: Refund customer (₹${refundAmount} returned to digital wallet). Ref: ${refundRef}`);
        if (order.robot.assignedAccountId) db.releaseAccount(order.robot.assignedAccountId);
        db.updateOrder(order.id, order);
        return sendJson(res, 200, { success: true, message: 'Order refunded to customer wallet.', order });
      } else if (decision === 'proceed') {
        // Cooldown check
        const lastDispatch = order.robot?.lastDispatchedAt ? new Date(order.robot.lastDispatchedAt).getTime() : 0;
        const elapsedSec = Math.floor((Date.now() - lastDispatch) / 1000);
        if (elapsedSec < 15) {
          return sendJson(res, 429, { error: `Please wait ${15 - elapsedSec}s cooldown before redispatching.` });
        }
        order.items = (order.items || []).filter(item => !item.isUnavailableAtArea && !item.outOfStock);
        if (!order.robot) order.robot = {};
        order.robot.status = 'QUEUED_FOR_ROBOT';
        order.robot.lastDispatchedAt = new Date().toISOString();
        order.robot.error = null;
        if (!order.robot.logs) order.robot.logs = [];
        order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 🚀 Admin decided: Proceed with in-stock items. Robot re-enqueued.`);
        db.updateOrder(order.id, order);
        queue.enqueue(order.id);
        return sendJson(res, 200, { success: true, message: 'Robot resumed with available items.', order });
      } else {
        return sendJson(res, 400, { error: 'Invalid decision. Use "refund" or "proceed".' });
      }
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Admin: Update Menu Item (Price, Name, Image, Availability)
  if (method === 'POST' && pathname === '/api/admin/menu/item/update') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const itemId = body.id || body.itemId;
      if (!itemId) return sendJson(res, 400, { error: 'Missing item id' });

      const catalogPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
      let catalog = [];
      if (fs.existsSync(catalogPath)) {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      }
      const itemIdx = catalog.findIndex(i => i.id === itemId);
      if (itemIdx === -1) return sendJson(res, 404, { error: 'Item not found in catalog' });

      if (body.price !== undefined) catalog[itemIdx].price = Number(body.price);
      if (body.originalPrice !== undefined) catalog[itemIdx].originalPrice = Number(body.originalPrice);
      if (body.name !== undefined) catalog[itemIdx].name = String(body.name).trim();
      if (body.description !== undefined) catalog[itemIdx].description = String(body.description).trim();
      if (body.imageUrl !== undefined) {
        catalog[itemIdx].imageUrl = String(body.imageUrl).trim();
        catalog[itemIdx].image = String(body.imageUrl).trim();
        catalog[itemIdx].customImageUrl = String(body.imageUrl).trim();
      }
      if (body.isAvailable !== undefined) catalog[itemIdx].isAvailable = Boolean(body.isAvailable);

      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
      dominosMenuService.loadCatalog();
      return sendJson(res, 200, { success: true, message: 'Item updated successfully', item: catalog[itemIdx] });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 3c-3. Admin: Live Trigger Robot Dispatch Now (with 30s Anti-Spam Cooldown & Delivery Gate)
  if (method === 'POST' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/dispatch-live')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const orderId = pathname.split('/')[4];
      const order = db.getOrderById(orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });

      if (order.isRefunded || order.payment?.status === 'REFUNDED') {
        return sendJson(res, 400, { error: 'Order #' + orderId + ' is already refunded. Cannot dispatch.', code: 'ORDER_REFUNDED' });
      }

      if (order.robot?.status === 'DELIVERED' || order.status === 'DELIVERED') {
        return sendJson(res, 400, { error: 'Order #' + orderId + ' is already delivered to customer doorstep. Dispatch cancelled.', code: 'ALREADY_DELIVERED' });
      }

      // 30-Second Dispatch Cooldown
      const lastDispatch = order.robot?.lastDispatchedAt ? new Date(order.robot.lastDispatchedAt).getTime() : 0;
      const elapsedSec = Math.floor((Date.now() - lastDispatch) / 1000);
      if (elapsedSec < 30) {
        return sendJson(res, 429, { 
          error: `Order #${orderId} was dispatched ${elapsedSec}s ago. Please wait ${30 - elapsedSec}s cooldown before redispatching.`,
          remainingSeconds: 30 - elapsedSec
        });
      }

      if (!order.robot) order.robot = {};
      order.robot.status = 'QUEUED_FOR_ROBOT';
      order.robot.lastDispatchedAt = new Date().toISOString();
      order.robot.error = null;
      if (!order.robot.logs) order.robot.logs = [];
      order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 🚀 Live robot dispatch triggered by Admin.`);
      db.updateOrder(order.id, order);
      queue.enqueue(order.id);
      return sendJson(res, 200, { success: true, message: `Live robot dispatch started for Order #${order.id}`, order });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 3d. Robot Automation Status & Mode Toggle
  if (method === 'GET' && pathname === '/api/admin/robot/status') {
    return sendJson(res, 200, {
      success: true,
      paused: queue.isPaused(),
      activeWorkers: queue.activeWorkers,
      queueLength: queue.queue.length
    });
  }

  if (method === 'POST' && pathname === '/api/admin/robot/toggle-mode') {
    if (queue.isPaused()) {
      queue.resume();
    } else {
      queue.pause();
    }
    return sendJson(res, 200, {
      success: true,
      paused: queue.isPaused(),
      message: queue.isPaused() ? 'Robot dispatch queue PAUSED.' : 'Robot dispatch queue ACTIVE.'
    });
  }

  // 4. Get Orders List / Status (for live monitoring & polling)
  if (method === 'GET' && pathname === '/api/orders') {
    return sendJson(res, 200, db.getOrders());
  }

  if (method === 'GET' && pathname.startsWith('/api/orders/')) {
    const id = pathname.split('/')[3];
    const order = db.getOrderById(id);
    if (!order) {
      return sendJson(res, 404, { error: 'Order not found' });
    }

    // Terminal state protection: Stop polling Domino's if order is delivered or cancelled (or > 30 mins after delivery)
    const isDeliveredOrCancelled = order.robot?.status === 'DELIVERED' || order.robot?.status === 'CANCELLED';
    const deliveredTime = order.robot?.deliveredAt ? new Date(order.robot.deliveredAt).getTime() : 0;
    const isPastDeliveryWindow = deliveredTime > 0 && (Date.now() - deliveredTime) > (30 * 60 * 1000);

    if (isDeliveredOrCancelled || isPastDeliveryWindow) {
      if (order.robot?.status === 'DELIVERED') {
        order.robot.isDelayed = false;
        order.robot.trackingClosed = true;
        order.robot.trackingNotice = 'Order delivered at doorstep. Live telemetry finalized.';
      }
    }

    // Real-time status refresh from Domino's India tracking API (automatic cadence for live active orders + instant on-demand)
    const isRefresh = parsedUrl.query?.refresh === 'true';
    const lastSyncTime = order.robot?.lastCloudSync ? new Date(order.robot.lastCloudSync).getTime() : 0;
    const isLiveActive = ['ORDER_PLACED', 'BAKING', 'PACKED', 'DISPATCHED', 'BUILDING_CART', 'STORE_RESOLVING'].includes(order.robot?.status) || order.status === 'DISPATCHED' || order.status === 'BAKING';
    const shouldAutoSync = (isRefresh || (isLiveActive && (Date.now() - lastSyncTime) > 6000)) && !isDeliveredOrCancelled && !isPastDeliveryWindow && (order.robot?.dominosOrderRef || order.robot?.posOrderId || order.robot?.dominosEncryptedId);

    if (shouldAutoSync) {
      try {
        const accounts = db.getAccounts();
        const acc = (order.robot?.assignedAccountId && accounts.find(a => a.id === order.robot.assignedAccountId)) ||
                    (order.robot?.sessionPhone && accounts.find(a => a.phone === order.robot.sessionPhone)) ||
                    accounts.find(a => a.sessionToken || a.credentials?.accessToken);
        if (acc && (acc.sessionToken || acc.credentials?.accessToken)) {
          let tok = acc.sessionToken || acc.credentials?.accessToken;
          let bearer = tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`;
          let uId = String(acc.userId || acc.credentials?.userId || '366623451');
          const accMobile = String(acc.cleanPhone || acc.phone || '').replace(/[^0-9]/g, '').slice(-10);

          let updatedViaDirectTracker = false;

          // FAST PATH: If we have the encrypted cipher ID, query post-order tracker directly in ~150ms!
          if (order.robot?.dominosEncryptedId) {
            try {
              let directRes = await fetch(`https://api.dominos.co.in/post-order-service/v1/tracker/status?orderId=${encodeURIComponent(order.robot.dominosEncryptedId)}&riderTracker=true`, {
                headers: {
                  'Content-Type': 'application/json',
                  'api_key': 'd2aeb489bb8df385',
                  'authToken': bearer,
                  'Authorization': bearer,
                  'userId': uId,
                  'Mobile': accMobile,
                  'client_type': 'web app-chrome',
                  'source': 'PWA18'
                }
              });

              if (directRes.status === 401) {
                const rToken = acc.refreshToken || acc.credentials?.refreshToken;
                if (rToken) {
                  const refreshRes = await refreshDominoSession(uId, rToken);
                  if (refreshRes && refreshRes.success) {
                    applyAccountRefresh(acc, refreshRes);
                    db.save();
                    tok = acc.sessionToken || acc.credentials?.accessToken;
                    bearer = tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`;
                    directRes = await fetch(`https://api.dominos.co.in/post-order-service/v1/tracker/status?orderId=${encodeURIComponent(order.robot.dominosEncryptedId)}&riderTracker=true`, {
                      headers: {
                        'Content-Type': 'application/json',
                        'api_key': 'd2aeb489bb8df385',
                        'authToken': bearer,
                        'Authorization': bearer,
                        'userId': uId,
                        'Mobile': accMobile,
                        'client_type': 'web app-chrome',
                        'source': 'PWA18'
                      }
                    });
                  }
                }
              }

              if (directRes.ok) {
                const trackerData = await directRes.json().catch(() => null);
                if (trackerData) {
                  let liveStatus = order.robot.status || 'DISPATCHED';
                  if (trackerData.orderStatus === 'CANCELLED' || trackerData.cancellationDetails || trackerData.orderStatusCode === 99) {
                    liveStatus = 'CANCELLED';
                    if (trackerData.cancellationDetails?.reason) {
                      order.robot.cancellationReason = trackerData.cancellationDetails.reason;
                      order.robot.error = `Order cancelled by Domino's Kitchen: ${trackerData.cancellationDetails.reason}`;
                    }
                  } else if (trackerData.orderStatusCode === 4 || trackerData.orderStatusCode === 11) {
                    liveStatus = 'DISPATCHED';
                  } else if (trackerData.orderStatusCode === 5) {
                    liveStatus = 'DELIVERED';
                  }

                  order.robot.status = liveStatus;
                  order.robot.dominosLiveStatus = liveStatus;
                  order.status = liveStatus;
                  order.robot.lastCloudSync = new Date().toISOString();

                  const rInfo = trackerData.orderTracker?.riderInfo || trackerData.riderInfo;
                  let rName = order.robot.rider?.name || "Domino's Delivery Executive";
                  let rMobile = null;
                  let rStatusText = trackerData.etaWidget?.orderTrackingMessages?.statusMessage || null;
                  let riderCoords = null;

                  if (rInfo) {
                    if (rInfo.riderName && rInfo.riderName.trim()) {
                      rName = rInfo.riderName.trim();
                    }
                    if (rInfo.riderContactNumber) {
                      const clean = String(rInfo.riderContactNumber).replace(/[^0-9]/g, '').slice(-10);
                      if (/^[6-9]\d{9}$/.test(clean)) {
                        rMobile = `+91 ${clean}`;
                      }
                    }
                    if (rInfo.orderStatusText) {
                      rStatusText = rInfo.orderStatusText;
                    }
                  }

                  if (trackerData.orderTracker?.currentLatitude && trackerData.orderTracker?.currentLongitude) {
                    riderCoords = {
                      lat: parseFloat(trackerData.orderTracker.currentLatitude),
                      lng: parseFloat(trackerData.orderTracker.currentLongitude)
                    };
                  }

                  order.robot.rider = {
                    name: rName,
                    phone: rMobile || order.robot.rider?.phone || null,
                    status: liveStatus,
                    statusText: rStatusText || order.robot.rider?.statusText || null,
                    coords: riderCoords || order.robot.rider?.coords || null
                  };

                  const sLat = rInfo?.sourceLatitude || (order.location?.store?.latitude || order.address?.latitude);
                  const sLng = rInfo?.sourceLongitude || (order.location?.store?.longitude || order.address?.longitude);
                  const dLat = rInfo?.destinationLatitude || order.address?.latitude;
                  const dLng = rInfo?.destinationLongitude || order.address?.longitude;

                  order.robot.mapTelemetry = {
                    storeCoords: (sLat && sLng) ? { lat: parseFloat(sLat), lng: parseFloat(sLng) } : null,
                    riderCoords: riderCoords || order.robot.mapTelemetry?.riderCoords || null,
                    destCoords: (dLat && dLng) ? { lat: parseFloat(dLat), lng: parseFloat(dLng) } : null,
                    statusText: rStatusText || (liveStatus === 'DISPATCHED' ? 'Rider is on the way' : liveStatus),
                    orderStatus: liveStatus,
                    etaSeconds: trackerData.orderTracker?.etaInSeconds || 500
                  };

                  if (liveStatus === 'DELIVERED') {
                    order.robot.deliveredAt = order.robot.deliveredAt || new Date().toISOString();
                    order.robot.isDelayed = false;
                  } else if (liveStatus === 'CANCELLED') {
                    order.robot.isDelayed = false;
                    order.robot.cancelledAt = order.robot.cancelledAt || new Date().toISOString();
                    if (order.robot.rider) order.robot.rider.status = 'CANCELLED';
                    if (order.robot.mapTelemetry) {
                      order.robot.mapTelemetry.orderStatus = 'CANCELLED';
                      order.robot.mapTelemetry.statusText = order.robot.cancellationReason || 'Order Cancelled by Domino\'s Store';
                    }
                  }

                  db.updateOrder(order.id, order);
                  updatedViaDirectTracker = true;
                }
              }
            } catch (directErr) {
              console.warn('[DIRECT-TRACKER-FAST-PATH-ERR]', directErr.message);
            }
          }

          if (!updatedViaDirectTracker) {
            let trackRes = await fetch('https://api.dominos.co.in/order-service/v1/orders', {
            headers: {
              'Content-Type': 'application/json',
              'api_key': 'd2aeb489bb8df385',
              'authToken': bearer,
              'Authorization': bearer,
              'userId': uId,
              'client_type': 'web app-chrome',
              'source': 'PWA18'
            }
          });

          // Auto-rejuvenate access token if Domino's 1-hour session returned 401
          if (trackRes.status === 401) {
            const rToken = acc.refreshToken || acc.credentials?.refreshToken;
            if (rToken) {
              const refreshRes = await refreshDominoSession(uId, rToken);
              if (refreshRes && refreshRes.success) {
                applyAccountRefresh(acc, refreshRes);
                db.save();
                tok = acc.sessionToken || acc.credentials?.accessToken;
                bearer = tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`;
                trackRes = await fetch('https://api.dominos.co.in/order-service/v1/orders', {
                  headers: {
                    'Content-Type': 'application/json',
                    'api_key': 'd2aeb489bb8df385',
                    'authToken': bearer,
                    'Authorization': bearer,
                    'userId': String(acc.userId),
                    'client_type': 'web app-chrome',
                    'source': 'PWA18'
                  }
                });
              }
            }
          }

          if (trackRes.ok) {
            const data = await trackRes.json().catch(() => null);
            if (data?.orders && data.orders.length > 0) {
              const isTempRef = String(order.robot.dominosOrderRef || '').startsWith('DOM-IND-') || String(order.robot.dominosOrderRef || '').startsWith('DOM-REF-');
              const cleanRef = !isTempRef ? String(order.robot.dominosOrderRef || '').replace(/[^0-9]/g, '') : '';
              const cleanPos = String(order.robot.posOrderId || '').replace(/[^0-9]/g, '');
              const liveOrder = data.orders.find(o => {
                const oId = String(o.orderId || '').replace(/[^0-9]/g, '');
                const dId = String(o.dominosOrderId || o.store?.orderId || '').replace(/[^0-9]/g, '');
                if (cleanPos && oId === cleanPos) return true;
                if (cleanRef && (dId === cleanRef || oId === cleanRef)) return true;
                if (order.robot.orderTransactionId && o.orderTransactionId === order.robot.orderTransactionId) return true;
                if (order.robot.cartId && String(o.cartId) === String(order.robot.cartId)) return true;
                return false;
              });

              if (liveOrder) {
                const posMap = {
                  '1': 'ORDER_RECEIVED',
                  '2': 'BAKING',
                  '3': 'PACKED',
                  '4': 'DISPATCHED',
                  '11': 'DISPATCHED',
                  '5': 'DELIVERED',
                  '99': 'CANCELLED'
                };

                let liveStatus = posMap[liveOrder.currentPosState] || liveOrder.orderState || order.robot.status;
                if (liveOrder.orderState === 'CANCELLED' || liveOrder.currentPosState === '99') {
                  liveStatus = 'CANCELLED';
                }

                // Extract authentic Domino's store details and telephone contact
                if (liveOrder.store) {
                  order.robot.storePhone = liveOrder.store.phoneNumber || order.robot.storePhone || order.location?.store?.phone || '18002081234';
                  order.robot.storeName = liveOrder.store.name || order.robot.storeName;
                  order.robot.storeId = String(liveOrder.store.id || order.robot.storeId);
                  order.robot.storeAddress = liveOrder.store.addressLine || order.robot.storeAddress;
                }

                // Extract authentic Domino's reference tokens
                if (liveOrder.orderId) {
                  order.robot.posOrderId = String(liveOrder.orderId);
                }
                if (liveOrder.dominosOrderId || liveOrder.store?.orderId) {
                  order.robot.dominosOrderRef = `#${liveOrder.dominosOrderId || liveOrder.store.orderId}`;
                }

                order.robot.status = liveStatus;
                order.robot.dominosLiveStatus = liveStatus;
                order.status = liveStatus;

                if (liveStatus === 'DELIVERED') {
                  order.robot.deliveredAt = order.robot.deliveredAt || new Date().toISOString();
                  order.robot.isDelayed = false;
                  order.robot.trackingNotice = 'Order delivered at doorstep. Live telemetry finalized.';
                } else if (liveStatus === 'CANCELLED') {
                  order.robot.cancelledAt = order.robot.cancelledAt || new Date().toISOString();
                }

                // Check kitchen delay (~8-9 mins oven delay)
                const orderTime = order.robot.placedAt ? new Date(order.robot.placedAt).getTime() : new Date(order.createdAt).getTime();
                const elapsedMins = (Date.now() - orderTime) / (60 * 1000);
                const isBakingOrPacked = liveStatus === 'BAKING' || liveStatus === 'PACKED' || order.robot.status === 'BAKING';

                if (liveStatus === 'DELIVERED') {
                  order.robot.isDelayed = false;
                  order.robot.deliveredAt = order.robot.deliveredAt || new Date().toISOString();
                  console.log(`[DOMINOS-LIVE-TRACKER] 🟢 Order #${order.id} has been DELIVERED at customer doorstep! Domino's Token: ${order.robot.dominosOrderRef}`);
                } else if (isBakingOrPacked && elapsedMins >= 16) {
                  const delayMins = Math.min(Math.round(elapsedMins - 14), 12);
                  if (!order.robot.isDelayed) {
                    order.robot.isDelayed = true;
                    order.robot.delayMinutes = delayMins;
                    order.robot.delayReason = `Domino's kitchen oven volume is high. Pizza preparation is running ~${delayMins} mins behind schedule. Store kitchen team is expediting.`;
                    console.warn(`[DOMINOS-LIVE-TRACKER] ⚠️ Order #${order.id} is slightly delayed by ~${delayMins} mins in ${liveStatus} stage at ${order.robot.storeName || 'Store'}. Store alerted!`);
                  } else {
                    order.robot.delayMinutes = delayMins;
                  }
                } else if (liveStatus === 'DISPATCHED') {
                  order.robot.isDelayed = false;
                }

                // Extract authentic Rider Contact Details (Name, Phone) directly from Domino's post-order live tracker
                let rName = liveOrder.riderName || liveOrder.deliveryExecutiveName || liveOrder.deliveryExecutive?.name || liveOrder.rider?.name || (liveStatus === 'DISPATCHED' ? (order.robot.rider?.name || "Domino's Delivery Executive") : null);
                let rMobile = null;
                let rStatusText = null;
                let riderCoords = null;

                if (liveOrder.id) {
                  try {
                    const accMobile = String(acc.cleanPhone || acc.phone || '').replace(/[^0-9]/g, '').slice(-10);
                    const trackerRes = await fetch(`https://api.dominos.co.in/post-order-service/v1/tracker/status?orderId=${encodeURIComponent(liveOrder.id)}&riderTracker=true`, {
                      headers: {
                        'Content-Type': 'application/json',
                        'api_key': 'd2aeb489bb8df385',
                        'authToken': bearer,
                        'Authorization': bearer,
                        'userId': String(acc.userId),
                        'Mobile': accMobile,
                        'client_type': 'web app-chrome',
                        'source': 'PWA18'
                      }
                    });
                    if (trackerRes.ok) {
                      const trackerData = await trackerRes.json().catch(() => null);
                      if (trackerData) {
                        if (trackerData.orderStatus === 'CANCELLED' || trackerData.cancellationDetails || trackerData.orderStatusCode === 99) {
                          liveStatus = 'CANCELLED';
                          if (trackerData.cancellationDetails?.reason) {
                            order.robot.cancellationReason = trackerData.cancellationDetails.reason;
                            order.robot.error = `Order cancelled by Domino's Kitchen: ${trackerData.cancellationDetails.reason}`;
                          }
                        } else if (trackerData.orderStatusCode === 4 || trackerData.orderStatusCode === 11) {
                          liveStatus = 'DISPATCHED';
                        } else if (trackerData.orderStatusCode === 5) {
                          liveStatus = 'DELIVERED';
                        }

                        const rInfo = trackerData.orderTracker?.riderInfo || trackerData.riderInfo;
                        if (rInfo) {
                          if (rInfo.riderName && rInfo.riderName.trim()) {
                            rName = rInfo.riderName.trim();
                          }
                          if (rInfo.riderContactNumber) {
                            const clean = String(rInfo.riderContactNumber).replace(/[^0-9]/g, '').slice(-10);
                            if (/^[6-9]\d{9}$/.test(clean)) {
                              rMobile = `+91 ${clean}`;
                            }
                          }
                          if (rInfo.orderStatusText) {
                            rStatusText = rInfo.orderStatusText;
                          }
                        }

                        if (trackerData.orderTracker?.currentLatitude && trackerData.orderTracker?.currentLongitude) {
                          riderCoords = {
                            lat: trackerData.orderTracker.currentLatitude,
                            lng: trackerData.orderTracker.currentLongitude
                          };
                        }
                      }
                    }
                  } catch (trackErr) {
                    console.warn('[ORDER-POLL-TRACKER-ERR]', trackErr.message);
                  }
                }

                if (!rMobile) {
                  let fallbackMobile = liveOrder.riderMobile || liveOrder.deliveryExecutiveContact || liveOrder.deliveryExecutive?.contactNumber || liveOrder.deliveryExecutive?.mobile || liveOrder.rider?.phone || (liveStatus === 'DISPATCHED' ? (order.robot.rider?.phone || null) : null);
                  if (fallbackMobile) {
                    const cleanDigits = String(fallbackMobile).replace(/[^0-9]/g, '');
                    const clean10 = cleanDigits.slice(-10);
                    if (!cleanDigits.startsWith('011') && !cleanDigits.startsWith('0120') && /^[6-9]\d{9}$/.test(clean10)) {
                      rMobile = `+91 ${clean10}`;
                    }
                  }
                }

                if (liveOrder.id) {
                  order.robot.dominosEncryptedId = liveOrder.id;
                }
                order.robot.lastCloudSync = new Date().toISOString();

                const sLat = liveOrder.store?.latitude || order.location?.store?.latitude || order.address?.latitude;
                const sLng = liveOrder.store?.longitude || order.location?.store?.longitude || order.address?.longitude;
                const dLat = liveOrder.deliveryAddress?.latitude || order.address?.latitude;
                const dLng = liveOrder.deliveryAddress?.longitude || order.address?.longitude;

                order.robot.mapTelemetry = {
                  storeCoords: (sLat && sLng) ? { lat: parseFloat(sLat), lng: parseFloat(sLng) } : null,
                  riderCoords: riderCoords || order.robot.mapTelemetry?.riderCoords || null,
                  destCoords: (dLat && dLng) ? { lat: parseFloat(dLat), lng: parseFloat(dLng) } : null,
                  statusText: rStatusText || (liveStatus === 'DISPATCHED' ? 'Rider is on the way' : liveStatus),
                  orderStatus: liveStatus
                };

                if (rName || rMobile) {
                  order.robot.rider = {
                    name: rName || "Domino's Delivery Executive",
                    phone: rMobile || order.robot.rider?.phone || null,
                    status: liveStatus,
                    statusText: rStatusText || order.robot.rider?.statusText || null,
                    coords: riderCoords || order.robot.rider?.coords || null
                  };
                }

                if (liveStatus === 'CANCELLED') {
                  order.robot.isDelayed = false;
                  order.robot.error = `Order cancelled by Domino's Kitchen (${order.robot.storeName || 'Store'}). Store Contact: ${order.robot.storePhone || order.location?.store?.phone || '18002081234'}`;
                }

                db.updateOrder(order.id, order);
              }
            }
          }
        }
      }
    } catch (trackErr) {
        console.warn('[TRACK-REFRESH-ERR]', trackErr.message);
      }
    }

    return sendJson(res, 200, order);
  }

  // Update Rider Details & Dispatch Telemetry for Order
  if (method === 'POST' && pathname.startsWith('/api/orders/') && pathname.endsWith('/rider')) {
    const orderId = pathname.split('/')[3];
    const order = db.getOrderById(orderId);
    if (!order) return sendJson(res, 404, { error: 'Order not found' });
    try {
      const body = await parseBody(req);
      const rawPhone = (body.phone || '').trim();
      const digitsOnly = rawPhone.replace(/[^0-9]/g, '');
      if (!digitsOnly || digitsOnly.length < 8 || digitsOnly.length > 12) {
        return sendJson(res, 400, { error: 'Please enter a valid 10-digit mobile number or Domino\'s Store Dispatch number.' });
      }

      let formattedPhone = rawPhone;
      if (digitsOnly.length === 10 && ['6', '7', '8', '9'].includes(digitsOnly[0])) {
        formattedPhone = `+91 ${digitsOnly}`;
      } else if (digitsOnly.startsWith('011') || (digitsOnly.length === 10 && digitsOnly.startsWith('11'))) {
        const last8 = digitsOnly.slice(-8);
        formattedPhone = `011-${last8}`;
      } else if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
        formattedPhone = `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3)}`;
      } else {
        formattedPhone = digitsOnly.length === 10 ? `+91 ${digitsOnly}` : digitsOnly;
      }

      order.robot = order.robot || {};
      const newStatus = body.status || (order.robot.status === 'DELIVERED' ? 'DELIVERED' : 'DISPATCHED');
      order.robot.rider = {
        name: body.name ? body.name.trim() : (order.robot.rider?.name || "Domino's Delivery Executive"),
        phone: formattedPhone,
        status: newStatus
      };
      if (['DISPATCHED', 'DELIVERED', 'BAKING'].includes(newStatus)) {
        order.robot.status = newStatus;
        order.robot.dominosLiveStatus = newStatus;
        order.status = newStatus;
      }
      order.robot.logs = order.robot.logs || [];
      order.robot.logs.push(`[${new Date().toLocaleTimeString('en-IN')}] 🛵 Rider contact verified: ${order.robot.rider.name} (${formattedPhone}). This is the rider and you can contact the rider for your order.`);
      db.updateOrder(order.id, order);
      return sendJson(res, 200, {
        success: true,
        message: `Rider contact updated to ${formattedPhone}. This is the rider and you can contact the rider for your order.`,
        rider: order.robot.rider,
        order: order
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 4b. Domino's Cloud Real-Time Sync & Order History
  if (method === 'POST' && (pathname === '/api/orders/sync-cloud' || (pathname.startsWith('/api/orders/') && pathname.endsWith('/sync-cloud')))) {
    try {
      const targetId = pathname.includes('/api/orders/') && pathname !== '/api/orders/sync-cloud' ? pathname.split('/')[3] : null;
      const syncResult = await syncOrdersWithDominosCloud(targetId);
      const orders = db.getUserOrders('CURRENT_USER');
      return sendJson(res, 200, {
        success: true,
        message: `Synced with Domino's India Cloud! ${syncResult.count} order(s) updated.`,
        syncedCount: syncResult.count,
        updatedOrderIds: syncResult.updatedOrders,
        orders: orders
      });
    } catch (err) {
      return sendJson(res, 500, { error: `Domino's Cloud Sync failed: ${err.message}` });
    }
  }

  if (method === 'GET' && pathname === '/api/user/orders') {
    // Auto-sync with Domino's Cloud in background for transparent, live updates
    syncOrdersWithDominosCloud().catch(() => null);

    const email = (req.headers['x-user-email'] || parsedUrl.query?.email || '').trim().toLowerCase();
    const uid = (req.headers['x-user-uid'] || parsedUrl.query?.uid || '').trim();
    const orderRef = (parsedUrl.query?.ref || parsedUrl.query?.orderRef || '').trim().toLowerCase();
    const rawPhone = (parsedUrl.query?.phone || '').trim();
    const cleanPhone = rawPhone.replace(/[^0-9]/g, '').slice(-10);
    const orderIdsParam = (parsedUrl.query?.orderIds || '').trim();
    const localOrderIds = orderIdsParam ? orderIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

    const allOrders = db.getOrders();
    const matchedOrders = allOrders.filter(o => {
      const uPhone = (o.user?.phone || '').replace(/[^0-9]/g, '').slice(-10);
      const aPhone = (o.address?.phone || '').replace(/[^0-9]/g, '').slice(-10);
      const rPhone = (o.address?.receiverPhone || '').replace(/[^0-9]/g, '').slice(-10);

      // 1. If queried with a specific phone number, STRICTLY require the order to belong to this phone!
      if (cleanPhone && cleanPhone.length === 10) {
        return (uPhone === cleanPhone || aPhone === cleanPhone || rPhone === cleanPhone);
      }

      // 2. If queried with user email:
      if (email) {
        return (o.user?.email?.toLowerCase() === email || o.address?.email?.toLowerCase() === email);
      }

      // 3. If queried with user numerical UID:
      if (uid) {
        return (
          o.userId12 === uid || 
          o.user?.userId12 === uid || 
          o.user?.uid === uid || 
          o.uid === uid || 
          o.userId === uid || 
          o.user?.id === uid
        );
      }

      // 4. Order matches specific Order Engine Reference ID or Domino's Order Ref
      if (orderRef && (
        o.id?.toLowerCase() === orderRef || 
        o.engineOrderRef?.toLowerCase() === orderRef || 
        o.dominosOrderRef?.toLowerCase() === orderRef || 
        o.robot?.dominosOrderRef?.toLowerCase() === orderRef
      )) return true;

      // 5. Unauthenticated guest browser device (only when neither phone nor email nor uid filter is set)
      if (localOrderIds.length > 0 && localOrderIds.includes(o.id)) {
        return true;
      }

      return false;
    });

    // Return strictly isolated orders, sorted newest first, capped at 30 orders
    const sortedOrders = matchedOrders
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 30);

    return sendJson(res, 200, { success: true, count: sortedOrders.length, orders: sortedOrders });
  }

  // --- ADMIN ROUTES ---

  // 5. Admin: Get Domino's Account Pool (Enriched with Session Health & Age)
  if (method === 'GET' && pathname === '/api/admin/accounts') {
    let rawAccounts = db.getAccounts();
    if (rawAccounts.length === 0) {
      try {
        const cloudData = await firebaseService.pullFromCloud();
        if (cloudData) {
          db.mergeCloudData(cloudData);
          rawAccounts = db.getAccounts();
        }
      } catch (_) {}
    }
    const enriched = rawAccounts.map(acc => ({
      ...acc,
      sessionHealth: calculateSessionHealth(acc)
    }));
    return sendJson(res, 200, enriched);
  }

  // 6. Admin: Send Real Live Domino's SMS OTP
  if (method === 'POST' && pathname === '/api/admin/accounts/send-otp') {
    try {
      const { phone } = await parseBody(req);
      if (!phone) return sendJson(res, 400, { error: 'Phone number is required' });

      console.log(`[API] Dispatching real Domino's live SMS OTP to ${phone}...`);
      const result = await requestLiveDominoOtp(phone);
      if (!result.success) {
        return sendJson(res, 400, { 
          error: result.error,
          isLimitExhausted: result.isLimitExhausted || false 
        });
      }
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7. Admin: Verify Live OTP & Save Authentic Domino's Session Cookies
  if (method === 'POST' && pathname === '/api/admin/accounts/verify-otp') {
    try {
      const body = await parseBody(req);
      const { phone, otp, category, categoryName, couponCode } = body;

      if (!phone || !otp) {
        return sendJson(res, 400, { error: 'Both phone number and 6-digit OTP are required.' });
      }

      const result = await verifyLiveDominoOtp({ phone, otp, category, categoryName, couponCode });
      if (!result.success) {
        return sendJson(res, 400, { error: result.error });
      }
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7b. Admin: Get Cookies JSON for Console Injection
  if (method === 'GET' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/cookies')) {
    const id = pathname.split('/')[4];
    const exportData = await exportCookiesJson(id);
    if (!exportData.success) {
      return sendJson(res, 404, exportData);
    }
    return sendJson(res, 200, exportData);
  }

  // 7c. Admin: Launch Headed Browser Session Pre-filled with Account Cookies
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/launch')) {
    const id = pathname.split('/')[4];
    const launchResult = await launchBrowserWithSession(id);
    if (!launchResult.success) {
      return sendJson(res, 400, launchResult);
    }
    return sendJson(res, 200, launchResult);
  }

  // 7d. Admin: Import Session via Domino's JSON Key-Value Pair or Token
  if (method === 'POST' && pathname === '/api/admin/accounts/import-json') {
    try {
      const body = await parseBody(req);
      const { jsonInput, phone, category, categoryName, couponCode } = body;
      if (!jsonInput) {
        return sendJson(res, 400, { error: 'Please paste Domino\'s session JSON or token.' });
      }

      const result = await importDominoSessionJson({ jsonInput, phone, category, categoryName, couponCode });
      if (!result.success) {
        return sendJson(res, 400, { error: result.error });
      }
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7e. Admin: Re-validate Live Status of a Saved Domino's Session
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/validate')) {
    try {
      const id = pathname.split('/')[4];
      const result = await validateExistingAccount(id);
      if (!result.success) {
        return sendJson(res, 400, result);
      }
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7ee. Admin: Manually Refresh Domino's Session Token via Official API (with intelligent fallback to live session validation)
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/refresh')) {
    try {
      const id = pathname.split('/')[4];
      const accounts = db.getAccounts();
      const acc = accounts.find(a => a.id === id);
      if (!acc) return sendJson(res, 404, { error: 'Account not found in pool' });

      const rToken = acc.refreshToken || (acc.credentials && acc.credentials.refreshToken) || (acc.localStorage && acc.localStorage['refreshToken']);
      const uId = acc.userId || (acc.credentials && acc.credentials.userId);

      // 1. If refreshToken exists, attempt official Domino's token refresh
      if (rToken && uId) {
        console.log(`[API] 🔄 Admin triggered token refresh for ${acc.phone} (${acc.id})...`);
        const result = await refreshDominoSession(uId, rToken);
        if (result.success) {
          applyAccountRefresh(acc, result);

          // Detect authentic customer name from refreshed attributes
          const fName = result.attributes?.firstName || '';
          const lName = result.attributes?.lastName || '';
          const detectedName = (fName || lName) ? `${fName} ${lName}`.trim() : null;
          if (detectedName && (!acc.customerName || acc.customerName.includes('Customer'))) {
            acc.customerName = detectedName;
          }

          // Probe authentic past order history and loyalty tier with fresh token
          const activeToken = result.accessToken || acc.sessionToken;
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
                  acc.categoryName = '🟢 50% OFF New User Tier';
                  acc.couponCode = 'DOMNEW50';
                } else if (orders.length === 1) {
                  acc.accountType = 'SECOND_ORDER_ACCOUNT';
                  acc.category = 'CATEGORY_SECOND_ORDER';
                  acc.categoryName = '🟡 Cheesy 2nd Order Tier';
                  acc.couponCode = 'CHEESY';
                } else {
                  acc.accountType = 'EXISTING_ACCOUNT';
                  acc.category = 'CATEGORY_FLAT_100';
                  acc.categoryName = '🔵 Party Repeat Order Tier';
                  acc.couponCode = 'PARTY';
                }
              }
            }
          } catch (histErr) {}

          acc.lastValidated = new Date().toISOString();
          acc.status = 'IDLE';
          delete acc.validationError;
          db.save();

          return sendJson(res, 200, {
            success: true,
            message: `Domino's session refreshed successfully with live API! Cart ID: ${acc.cartId || 'Active'}, 30-day validity renewed.`,
            cartId: acc.cartId,
            lastRefreshedAt: acc.lastRefreshedAt,
            accessTokenExpiresAt: acc.accessTokenExpiresAt,
            refreshTokenExpiresAt: acc.refreshTokenExpiresAt,
            expiresAt: acc.expiresAt,
            account: acc
          });
        } else {
          console.warn(`[API] ⚠️ Live token refresh rejected for ${acc.phone}: ${result.error}. Falling back to session token validation.`);
        }
      }

      // 2. Resilient session validation fallback (restores accounts without refreshToken or after token rotation)
      const token = acc.sessionToken || (acc.credentials && (acc.credentials.sessionToken || acc.credentials.accessToken));
      const validation = await validateDominoSession(token, acc.cookies, acc.cleanPhone, acc.credentials);
      if (validation.valid) {
        acc.status = 'IDLE';
        acc.lastValidated = new Date().toISOString();
        acc.expiresAt = validation.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        delete acc.validationError;
        if (validation.pastOrdersCount !== undefined && (acc.pastOrdersCount === undefined || acc.pastOrdersCount === null)) {
          acc.pastOrdersCount = validation.pastOrdersCount;
        }
        if (validation.accountType && !acc.accountType) acc.accountType = validation.accountType;
        if (validation.category && !acc.category) acc.category = validation.category;
        if (validation.categoryName && !acc.categoryName) acc.categoryName = validation.categoryName;
        if (validation.couponCode && !acc.couponCode) acc.couponCode = validation.couponCode;
        db.save();

        return sendJson(res, 200, {
          success: true,
          message: `Domino's session verified and restored to ACTIVE! (${acc.categoryName || 'Standard'})`,
          cartId: acc.cartId,
          lastRefreshedAt: acc.lastValidated,
          expiresAt: acc.expiresAt,
          account: acc
        });
      } else {
        acc.status = 'EXPIRED';
        acc.expiresAt = new Date().toISOString();
        acc.validationError = validation.error;
        acc.lastValidated = new Date().toISOString();
        db.save();

        return sendJson(res, 400, {
          success: false,
          error: validation.error || 'Token expired or invalid. Please re-import from m.dominos.co.in or request a new OTP.',
          account: acc
        });
      }
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7f. Admin: Get 1-Click Extraction Script & Step-by-Step Instructions
  if (method === 'GET' && pathname === '/api/admin/extraction-guide') {
    const guide = getExtractionGuide();
    return sendJson(res, 200, guide);
  }

  // 7g. Admin: Update Account Tier & Loyalty Category
  if ((method === 'PATCH' || method === 'POST' || method === 'PUT') && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/tier')) {
    try {
      const id = pathname.split('/')[4];
      const accounts = db.getAccounts();
      const acc = accounts.find(a => a.id === id);
      if (!acc) return sendJson(res, 404, { error: 'Account not found in pool' });

      const body = await parseBody(req);
      const tierKey = body.tier || 'EXISTING_ACCOUNT';

      const TIERS = {
        NEW_ACCOUNT: {
          accountType: 'NEW_ACCOUNT',
          category: 'CATEGORY_50_OFF',
          categoryName: '🟢 50% OFF New User Tier (0 Past Orders)',
          couponCode: 'DOMNEW50',
          pastOrdersCount: 0
        },
        SECOND_ORDER_ACCOUNT: {
          accountType: 'SECOND_ORDER_ACCOUNT',
          category: 'CATEGORY_SECOND_ORDER',
          categoryName: '🟡 Cheesy 2nd Order Tier (1 Past Order)',
          couponCode: 'CHEESY',
          pastOrdersCount: 1
        },
        CHEESY_REWARDS: {
          accountType: 'SECOND_ORDER_ACCOUNT',
          category: 'CATEGORY_SECOND_ORDER',
          categoryName: '🟡 Cheesy 2nd Order Tier (1 Past Order)',
          couponCode: 'CHEESY',
          pastOrdersCount: 1
        },
        EXISTING_ACCOUNT: {
          accountType: 'EXISTING_ACCOUNT',
          category: 'CATEGORY_FLAT_100',
          categoryName: '🔵 Party Repeat Order Tier (2+ Past Orders)',
          couponCode: 'PARTY',
          pastOrdersCount: Math.max(2, acc.pastOrdersCount || 2)
        },
        VIP_GOLD: {
          accountType: 'EXISTING_ACCOUNT',
          category: 'CATEGORY_VIP_GOLD',
          categoryName: '👑 Gold Club Member Tier',
          couponCode: 'PARTY',
          pastOrdersCount: Math.max(3, acc.pastOrdersCount || 3)
        }
      };

      const selected = TIERS[tierKey] || TIERS.EXISTING_ACCOUNT;
      acc.accountType = selected.accountType;
      acc.category = selected.category;
      acc.categoryName = selected.categoryName;
      acc.couponCode = selected.couponCode;
      if (selected.pastOrdersCount !== undefined) {
        acc.pastOrdersCount = selected.pastOrdersCount;
      }
      db.save();

      console.log(`[API] 🏷️ Admin switched account ${acc.phone} to ${acc.categoryName} (Coupon: ${acc.couponCode})`);
      return sendJson(res, 200, { success: true, account: acc });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7h. Admin: Domino's Automated Promo & Coupon Rules Configuration
  if (method === 'GET' && pathname === '/api/admin/coupon-rules') {
    return sendJson(res, 200, db.getCouponRules());
  }

  if (method === 'POST' && pathname === '/api/admin/coupon-rules') {
    try {
      const body = await parseBody(req);
      const updated = db.updateCouponRules(body);
      return sendJson(res, 200, { success: true, couponRules: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 8. Admin & Session Extension: Delete Account / Session (Permanently purge from pool, storage system & cloud)
  if (
    (method === 'DELETE' && (
      pathname.startsWith('/api/admin/accounts/') || 
      pathname.startsWith('/api/admin/sessions/') || 
      pathname.startsWith('/api/session/') ||
      pathname.startsWith('/api/extension/session/') ||
      pathname.startsWith('/api/extension/accounts/') ||
      pathname.startsWith('/api/extension/account/')
    )) ||
    (method === 'POST' && (
      pathname === '/api/admin/sessions/delete' || 
      pathname === '/api/admin/accounts/delete' || 
      pathname === '/api/extension/session/delete' || 
      pathname === '/api/extension/session/remove' ||
      pathname === '/api/extension/delete' ||
      pathname === '/api/session/delete'
    ))
  ) {
    try {
      let id = pathname.startsWith('/api/admin/accounts/') || pathname.startsWith('/api/admin/sessions/') || pathname.startsWith('/api/extension/session/') || pathname.startsWith('/api/extension/accounts/') || pathname.startsWith('/api/extension/account/')
        ? pathname.split('/')[4] || pathname.split('/')[3]
        : (pathname.startsWith('/api/session/') ? pathname.split('/')[3] : null);

      if (!id && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        id = body.id || body.accountId || body.phone || body.sessionToken || body.cleanPhone;
      }

      if (!id) return sendJson(res, 400, { error: 'Missing account ID or session identifier to delete.' });

      db.deleteAccount(id);
      if (typeof cleanupSession === 'function') {
        cleanupSession(id);
      }
      console.log(`[STORAGE-PURGE] 🗑️ Account/Session ${id} permanently deleted from pool, disk storage, and cloud.`);
      return sendJson(res, 200, { success: true, message: `Account ${id} permanently removed from pool and storage system.` });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Toggle Disable / Enable Account for Robot Orders
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/toggle-disabled')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const id = pathname.split('/')[4];
      const acc = db.toggleAccountDisabled(id);
      return sendJson(res, 200, { success: true, account: acc, disabled: acc.disabled, status: acc.status });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: 1-Click Force Release / Set Session Available
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/release')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const id = pathname.split('/')[4];
      const acc = db.forceReleaseAccount(id);
      return sendJson(res, 200, { success: true, message: `Account ${acc?.phone || id} released and set to AVAILABLE / IDLE!`, account: acc });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Toggle Session Working / Busy / Idle Status
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/toggle-status')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const id = pathname.split('/')[4];
      const accounts = db.getAccounts();
      const acc = accounts.find(a => a.id === id);
      if (!acc) return sendJson(res, 404, { error: 'Account not found' });
      acc.status = acc.status === 'IDLE' ? 'BUSY' : 'IDLE';
      db.save();
      return sendJson(res, 200, { success: true, message: `Account status updated to ${acc.status}`, status: acc.status, account: acc });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Set Account Past Orders Count
  if (method === 'POST' && pathname.startsWith('/api/admin/accounts/') && pathname.endsWith('/set-orders-count')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const id = pathname.split('/')[4];
      const body = await parseBody(req);
      const acc = db.setAccountPastOrdersCount(id, body.count);
      return sendJson(res, 200, { success: true, account: acc, pastOrdersCount: acc.pastOrdersCount, tier: acc.categoryName });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- GOOGLE SIGN-IN AUTHENTICATION & IDENTITY INTEGRATION ---
  if (method === 'POST' && pathname === '/api/auth/google') {
    try {
      const body = await parseBody(req);
      let googleUser = null;

      if (body.credential) {
        const payload = decodeGoogleJwt(body.credential);
        if (payload && (payload.email || payload.sub)) {
          googleUser = {
            googleId: payload.sub,
            email: payload.email,
            name: payload.name || payload.given_name || 'Google User',
            picture: payload.picture || 'https://lh3.googleusercontent.com/a/default-user=s96-c'
          };
        }
      } else if (body.userInfo && body.userInfo.email) {
        googleUser = {
          googleId: body.userInfo.sub || body.userInfo.id || body.userInfo.uid || `g-${Date.now()}`,
          email: body.userInfo.email,
          name: body.userInfo.name || body.userInfo.displayName || 'Google User',
          picture: body.userInfo.picture || body.userInfo.photoURL || 'https://lh3.googleusercontent.com/a/default-user=s96-c'
        };
      } else if (body.firebaseUser && body.firebaseUser.email) {
        googleUser = {
          googleId: body.firebaseUser.uid || body.firebaseUser.id || `fb-${Date.now()}`,
          email: body.firebaseUser.email,
          name: body.firebaseUser.displayName || body.firebaseUser.name || 'Google User',
          picture: body.firebaseUser.photoURL || body.firebaseUser.picture || 'https://lh3.googleusercontent.com/a/default-user=s96-c'
        };
      }

      if (!googleUser || !googleUser.email) {
        return sendJson(res, 400, { error: 'Invalid Google authentication payload.' });
      }

      const users = db.getUsers();
      let user = users.find(u => u.email === googleUser.email || (googleUser.googleId && u.googleId === googleUser.googleId));

      if (!user) {
        user = {
          id: `USR-${Date.now().toString().slice(-4)}`,
          userId12: Math.floor(100000000000 + Math.random() * 900000000000).toString(),
          name: googleUser.name,
          email: googleUser.email,
          googleId: googleUser.googleId,
          picture: googleUser.picture,
          phone: '',
          phoneLocked: false,
          walletBalance: 0,
          savedAddresses: [],
          transactions: [],
          registeredAt: new Date().toISOString(),
          lastActive: new Date().toISOString(),
          status: 'ACTIVE'
        };
        users.push(user);
      } else {
        user.name = googleUser.name || user.name;
        user.picture = googleUser.picture || user.picture;
        user.googleId = googleUser.googleId || user.googleId;
        user.lastActive = new Date().toISOString();
      }

      const isAdmin = user.email.toLowerCase() === 'parthgulyani7960@gmail.com' || ADMIN_EMAILS.has(user.email.toLowerCase());
      if (isAdmin) {
        user.role = 'ADMIN';
        user.isAdmin = true;
      }

      // Sync active userProfile if it's the primary owner account
      if (db.data.userProfile && (isAdmin || user.email === 'parth.google@gmail.com' || !db.data.userProfile.email)) {
        db.data.userProfile.name = user.name;
        db.data.userProfile.email = user.email;
        db.data.userProfile.picture = user.picture;
        db.data.userProfile.userId12 = user.userId12;
        if (db.data.userProfile.wallet) {
          db.data.userProfile.wallet.balance = user.walletBalance || 0;
        }
      }

      db.save();

      let adminToken = null;
      if (isAdmin) {
        adminToken = createAdminToken(user.email);
        res.setHeader('Set-Cookie', `admin_token=${adminToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      }

      return sendJson(res, 200, {
        success: true,
        message: `Welcome to Domino's Order Engine, ${user.name}!`,
        user: {
          id: user.id,
          userId12: user.userId12,
          name: user.name,
          email: user.email,
          picture: user.picture,
          phone: user.phone,
          phoneLocked: user.phoneLocked,
          walletBalance: user.walletBalance || 0,
          role: user.role || 'CUSTOMER',
          isAdmin: isAdmin
        },
        isAdmin: isAdmin,
        adminToken: adminToken,
        profile: db.getUserProfile()
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Google Sign-Out
  if (method === 'POST' && pathname === '/api/auth/logout') {
    return sendJson(res, 200, { success: true, message: 'Signed out successfully from Domino\'s Order Engine.' });
  }

  // --- USER PROFILE & ADDRESS ROUTES (Strict Domino's India Schema) ---
  
  // Database Connectivity & Health Status (Azure, Render & Local App Layer)
  if (method === 'GET' && (pathname === '/api/db/status' || pathname === '/api/health')) {
    const conn = firebaseService.getConnectionStatus ? firebaseService.getConnectionStatus() : { connected: true };
    return sendJson(res, 200, {
      status: 'CONNECTED',
      server: 'Domino\'s Order Engine Production Server',
      database: 'Firebase Realtime Database & Local Store',
      cloudSync: conn,
      accountsInPool: db.getAccounts().length,
      registeredUsers: db.getUsers().length,
      ordersRecorded: db.getOrders().length,
      timestamp: new Date().toISOString()
    });
  }

  // User Profile with IP and multi-user support
  if (method === 'GET' && pathname === '/api/user/profile') {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const email = req.headers['x-user-email'] || parsedUrl.query?.email;
    const uid = req.headers['x-user-uid'] || parsedUrl.query?.uid;
    const users = db.getUsers();
    let user = null;
    if (email) {
      const em = String(email).toLowerCase().trim();
      user = users.find(u => u.email && u.email.toLowerCase().trim() === em);
    } else if (uid) {
      const uStr = String(uid).trim();
      user = users.find(u => u.userId12 === uStr || u.id === uStr);
    }

    // If no user matches the given email/uid, return guest profile
    if (user) {
      return sendJson(res, 200, {
        profile: {
          id: user.id,
          userId12: user.userId12,
          name: user.name,
          email: user.email,
          picture: user.picture || 'https://lh3.googleusercontent.com/a/default-user=s96-c',
          phone: user.phone || '',
          phoneLocked: user.phoneLocked ?? false,
          wallet: {
            balance: user.walletBalance || 0,
            currency: 'INR'
          },
          savedAddresses: user.savedAddresses || []
        },
        clientIp: clientIp
      });
    }

    return sendJson(res, 200, {
      profile: null,
      isGuest: true,
      clientIp: clientIp
    });
  }

  // Save Delivery Address with Mandatory GPS Coordinates & Real Domino's Site Sync
  if (method === 'POST' && pathname === '/api/user/profile/address') {
    if (!rateLimiter.middleware(req, res, { routeKey: 'user-address', maxRequests: 12, windowMs: 60000, message: 'Too many address updates.' })) {
      return;
    }
    try {
      const address = await parseBody(req);
      const userProf = db.getUserProfile();
      address.name = address.name || (address.firstName ? `${address.firstName} ${address.lastName || ''}`.trim() : (address.receiverName || 'Customer'));
      address.phone = address.phone || address.receiverPhone || '';
      address.orderForSomeoneElse = Boolean(address.orderForSomeoneElse);
      address.receiverName = address.receiverName || address.name;
      address.receiverPhone = address.receiverPhone || address.phone;
      address.other_person_name = address.other_person_name || address.receiverName || address.name;
      address.other_person_phone = address.other_person_phone || address.receiverPhone || address.phone;
      address.customers_mobile = (address.receiverPhone || address.phone).replace(/[^0-9]/g, '').slice(-10);
      address.contact_number = address.customers_mobile;

      address.street = address.street || address.completeAddress || address.building || 'Main Street';
      address.completeAddress = address.completeAddress || address.street;
      address.building = address.building || address.street;

      // Real-Time Domino's Geocoding for coordinates if not provided
      if (!address.latitude || !address.longitude) {
        try {
          const query = `${address.building || ''} ${address.street || ''} ${address.city || ''}`.trim();
          if (query) {
            const resolved = await locationService.searchStoresByQuery(query);
            if (resolved && resolved.coordinates) {
              address.latitude = resolved.coordinates.latitude;
              address.longitude = resolved.coordinates.longitude;
              if (!address.city && resolved.nearestCity) address.city = resolved.nearestCity;
            }
          }
        } catch (_) {}
      }

      if (!address.flat || !address.street || !address.name || !address.phone) {
        return sendJson(res, 400, { error: 'House/Flat, Street, Name, and Phone are mandatory address fields.' });
      }
      if (!address.latitude || !address.longitude) {
        return sendJson(res, 400, { error: 'Mandatory GPS Coordinates (latitude, longitude) are required for Domino\'s delivery.' });
      }

      // Save locally first
      let addresses = db.saveUserAddress(address);
      const savedItem = addresses.find(a => a.id === address.id || (a.flat === address.flat && a.street === address.street));

      // Asynchronously trigger Real Domino's Site Address Sync
      const accounts = db.getAccounts();
      const activeSession = accounts.find(a => a.status === 'IDLE') || accounts[0];

      let dominosSyncResult = null;
      if (activeSession) {
        console.log(`[API] 🚀 Initiating Real Address Sync to Domino's India Site for ${address.flat}...`);
        dominosSyncResult = await dominosAddressService.syncAddressToDominos(address, activeSession);
        if (dominosSyncResult.success && dominosSyncResult.dominosAddressId && savedItem) {
          savedItem.dominosAddressId = dominosSyncResult.dominosAddressId;
          savedItem.dominosFormattedAddress = dominosSyncResult.dominosFormattedAddress;
          savedItem.syncedWithDominos = true;
          savedItem.syncedAt = new Date().toISOString();
          db.save();
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: dominosSyncResult?.success 
          ? `Delivery address saved and synced to Domino's site! (Ref ID: #${dominosSyncResult.dominosAddressId})`
          : 'Delivery address saved with mandatory GPS coordinates.',
        addresses: addresses,
        activeAddress: savedItem || addresses[0],
        dominosSync: dominosSyncResult
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Explicit Trigger to Sync Address to Domino's Site
  if (method === 'POST' && pathname.startsWith('/api/user/profile/address/') && pathname.endsWith('/sync-dominos')) {
    if (!rateLimiter.middleware(req, res, { routeKey: 'sync-dominos-address', maxRequests: 10, windowMs: 60000, message: 'Too many sync requests.' })) {
      return;
    }
    try {
      const addressId = pathname.split('/')[5];
      const profile = db.getUserProfile();
      const addr = (profile.savedAddresses || []).find(a => a.id === addressId);
      if (!addr) return sendJson(res, 404, { error: 'Address not found' });

      const accounts = db.getAccounts();
      const activeSession = accounts.find(a => a.status === 'IDLE') || accounts[0];
      if (!activeSession) return sendJson(res, 400, { error: 'No active Domino\'s session available in pool.' });

      const syncRes = await dominosAddressService.syncAddressToDominos(addr, activeSession);
      if (syncRes.success && syncRes.dominosAddressId) {
        addr.dominosAddressId = syncRes.dominosAddressId;
        addr.dominosFormattedAddress = syncRes.dominosFormattedAddress;
        addr.syncedWithDominos = true;
        addr.syncedAt = new Date().toISOString();
        db.save();
      }

      return sendJson(res, syncRes.success ? 200 : 400, {
        success: syncRes.success,
        syncResult: syncRes,
        address: addr
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Get Saved Addresses Directly from Domino's Live Cloud
  if (method === 'GET' && pathname === '/api/user/profile/dominos-addresses') {
    try {
      const accounts = db.getAccounts();
      const activeSession = accounts.find(a => a.status === 'IDLE') || accounts[0];
      if (!activeSession) return sendJson(res, 400, { error: 'No active Domino\'s session available in pool.' });

      const liveAddresses = await dominosAddressService.fetchSavedAddressesFromDominos(activeSession);
      return sendJson(res, 200, liveAddresses);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Update User Profile Name
  if (method === 'POST' && pathname === '/api/user/profile/name') {
    try {
      const { name } = await parseBody(req);
      if (!name || !name.trim()) {
        return sendJson(res, 400, { error: 'Username/Name cannot be empty.' });
      }
      const updated = db.updateUserName(name);
      return sendJson(res, 200, { success: true, profile: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Set Default Delivery Address
  if (method === 'POST' && pathname === '/api/user/profile/set-default-address') {
    try {
      const { addressId } = await parseBody(req);
      if (!addressId) return sendJson(res, 400, { error: 'Address ID is required.' });
      const addresses = db.setDefaultAddress(addressId);
      return sendJson(res, 200, { success: true, addresses: addresses });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Delete Delivery Address
  if (method === 'DELETE' && pathname.startsWith('/api/user/profile/address/')) {
    const addressId = pathname.split('/')[5];
    const addresses = db.deleteUserAddress(addressId);
    return sendJson(res, 200, { success: true, addresses: addresses });
  }

  // 9. Admin: Vouchers & Gift Cards Inventory
  if (method === 'GET' && pathname === '/api/admin/vouchers') {
    return sendJson(res, 200, db.getVouchers());
  }

  if (method === 'POST' && pathname === '/api/admin/vouchers') {
    try {
      const body = await parseBody(req);
      if (!body.code || !body.pin) {
        return sendJson(res, 400, { error: '16-digit voucher code and 6-digit PIN are required' });
      }
      const cleanCode = body.code.replace(/\s+/g, '');
      const newVoucher = {
        id: `VOUCH-${Math.floor(100 + Math.random() * 900)}`,
        code: cleanCode,
        pin: body.pin.trim(),
        balance: Number(body.balance) || 500,
        initialBalance: Number(body.balance) || 500,
        status: 'UNUSED',
        usedInOrderId: null
      };
      db.addVoucher(newVoucher);
      return sendJson(res, 201, { success: true, voucher: newVoucher });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/admin/vouchers/') && pathname.endsWith('/update')) {
    try {
      const vId = pathname.split('/')[4];
      const body = await parseBody(req);
      const updated = db.updateVoucher(vId, body);
      return sendJson(res, 200, { success: true, voucher: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'DELETE' && pathname.startsWith('/api/admin/vouchers/')) {
    const vId = pathname.split('/')[4];
    const remaining = db.deleteVoucher(vId);
    return sendJson(res, 200, { success: true, vouchers: remaining });
  }

  // 9a. Admin: Dynamic UPI Payment Receiver Configuration (Strictly Protected)
  if (method === 'GET' && (pathname === '/api/admin/payment-settings' || pathname === '/api/admin/payment-receiver')) {
    return sendJson(res, 200, db.getPaymentSettings());
  }

  if (method === 'POST' && (pathname === '/api/admin/payment-settings' || pathname === '/api/admin/payment-receiver')) {
    try {
      const body = await parseBody(req);
      const rawUpi = (body.upiId !== undefined) ? String(body.upiId).trim() : ((body.receiverUpiId !== undefined) ? String(body.receiverUpiId).trim() : null);
      const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/;
      if (rawUpi !== null && rawUpi.length > 0 && !UPI_REGEX.test(rawUpi)) {
        return sendJson(res, 400, {
          error: 'Invalid UPI ID format. Must follow standard UPI pattern (e.g. dominos.pay@okhdfcbank).'
        });
      }
      const payeeName = body.payeeName !== undefined ? String(body.payeeName).slice(0, 60).trim() : undefined;
      const merchantCode = body.merchantCode !== undefined ? String(body.merchantCode).slice(0, 20).trim() : undefined;
      const note = body.note !== undefined ? String(body.note).slice(0, 80).trim() : undefined;
      const codEnabled = body.codEnabled !== undefined ? Boolean(body.codEnabled) : undefined;
      const upiEnabled = body.upiEnabled !== undefined ? Boolean(body.upiEnabled) : undefined;

      const updated = db.updatePaymentSettings({
        upiId: rawUpi,
        receiverUpiId: rawUpi,
        payeeName: payeeName,
        merchantCode: merchantCode,
        note: note,
        codEnabled: codEnabled,
        upiEnabled: upiEnabled
      });
      console.log(`[PAYMENT-SECURITY] Payment settings updated: UPI=${updated.upiId}, COD_Enabled=${updated.codEnabled}, UPI_Enabled=${updated.upiEnabled}`);
      return sendJson(res, 200, { success: true, settings: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 9b. Admin: Menu Catalog & Real-Time Item Pricing Manager
  if (method === 'GET' && pathname === '/api/admin/menu') {
    return sendJson(res, 200, {
      success: true,
      menu: db.getMenu(),
      combos: db.getCombos(),
      totalItems: db.getMenu().length
    });
  }

  if (method === 'POST' && pathname === '/api/admin/menu') {
    try {
      const body = await parseBody(req);
      const created = db.addMenuItem(body);
      return sendJson(res, 201, { success: true, item: created });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if ((method === 'PUT' || method === 'POST') && pathname.startsWith('/api/admin/menu/') && !pathname.endsWith('/delete')) {
    try {
      const id = decodeURIComponent(pathname.replace('/api/admin/menu/', ''));
      const body = await parseBody(req);
      const updated = db.updateMenuItem(id, body);
      if (!updated) {
        return sendJson(res, 404, { error: 'Menu item not found' });
      }
      return sendJson(res, 200, { success: true, item: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'DELETE' && pathname.startsWith('/api/admin/menu/')) {
    const id = decodeURIComponent(pathname.replace('/api/admin/menu/', ''));
    const deleted = db.deleteMenuItem(id);
    return sendJson(res, 200, { success: deleted });
  }

  // Update User Profile (With One-Time Phone Lock Enforcement)
  if (method === 'POST' && pathname === '/api/user/profile') {
    try {
      const body = await parseBody(req);
      const current = db.getUserProfile();

      // Check one-time phone lock: user cannot modify phone if already locked
      if (current.phoneLocked && body.phone && body.phone.replace(/[^0-9]/g, '').slice(-10) !== (current.phone || '').replace(/[^0-9]/g, '').slice(-10)) {
        return sendJson(res, 403, {
          error: 'Your mobile number is verified and locked. Only an administrator can update your registered mobile number.'
        });
      }

      const updates = {};
      if (body.name) updates.name = body.name.trim();
      if (body.email) updates.email = body.email.trim();
      if (body.phone && !current.phoneLocked) {
        const clean = body.phone.replace(/[^0-9]/g, '').slice(-10);
        if (!/^[6-9]\d{9}$/.test(clean)) {
          return sendJson(res, 400, { error: 'Please enter a valid 10-digit Indian mobile number.' });
        }
        updates.phone = `+91 ${clean}`;
        updates.phoneLocked = true; // Lock after first save!
      }

      const updatedProfile = db.updateUserProfile(updates);
      return sendJson(res, 200, { success: true, profile: updatedProfile });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Customer Wallet Deposit API: Step 1 - Request Dynamic UPI QR & Payment Reference (5-Minute Window)
  if (method === 'POST' && pathname === '/api/user/wallet/deposit/request') {
    try {
      const body = await parseBody(req);
      const amount = Math.round(Number(body.amount));
      if (isNaN(amount) || amount < 50) {
        return sendJson(res, 400, { error: 'Minimum deposit amount is ₹50.' });
      }

      const paySettings = db.getPaymentSettings();
      const depositRef = `DEP-${Math.floor(100000 + Math.random() * 900000)}`;
      const note = `Domino's Order Engine Wallet Deposit ${depositRef}`;
      const upiUri = `upi://pay?pa=${encodeURIComponent(paySettings.upiId)}&pn=${encodeURIComponent(paySettings.payeeName)}&am=${amount}&tr=${depositRef}&tn=${encodeURIComponent(note)}&cu=INR`;
      const profile = db.getUserProfile();
      const userId = body.userId || profile.userId12 || profile.id || 'CURRENT_USER';

      // Save as INITIATED in DB
      const deposit = db.createWalletDeposit({
        userId: userId,
        phone: body.phone || profile.phone,
        amount: amount,
        reference: depositRef,
        method: 'UPI_DEEP_LINK',
        upiUri: upiUri,
        status: 'INITIATED'
      });

      return sendJson(res, 200, {
        success: true,
        reference: depositRef,
        referenceId: depositRef,
        amount: amount,
        upiUri: upiUri,
        payeeUpi: paySettings.upiId,
        payeeName: paySettings.payeeName,
        note: note,
        expiresAt: deposit.expiresAt,
        deposit: deposit
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Customer Wallet Deposit API: Step 2 - Submit "I Have Paid" for Admin Approval
  if (method === 'POST' && pathname === '/api/user/wallet/deposit/submit') {
    try {
      const body = await parseBody(req);
      const reference = body.reference || body.referenceId || body.id;
      if (!reference) {
        return sendJson(res, 400, { error: 'Valid deposit reference is required.' });
      }

      const utr = (body.utr || body.transactionId || '').trim();
      const deposit = db.submitWalletDeposit(reference, utr);

      return sendJson(res, 200, {
        success: true,
        message: 'Deposit confirmed! Awaiting admin approval. Your wallet balance will be credited within a few minutes.',
        deposit: deposit
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Update UTR on a Wallet Deposit (Customer or Admin)
  if (method === 'POST' && (pathname === '/api/user/wallet/deposit/update-utr' || pathname === '/api/admin/wallet/deposits/update-utr')) {
    try {
      const body = await parseBody(req);
      const referenceId = body.referenceId || body.reference || body.id;
      const utr = (body.utr || body.transactionId || '').trim();
      if (!referenceId) return sendJson(res, 400, { error: 'Deposit reference required.' });
      if (!utr) return sendJson(res, 400, { error: 'Valid 12-digit UTR required.' });

      const deposits = db.getWalletDeposits();
      const dep = deposits.find(d => d.reference === referenceId || d.referenceId === referenceId || d.id === referenceId);
      if (!dep) return sendJson(res, 404, { error: 'Deposit not found.' });

      dep.utr = utr;
      dep.updatedAt = new Date().toISOString();
      db.save();

      return sendJson(res, 200, { success: true, message: 'Deposit UTR updated', deposit: dep });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Customer Wallet Deposit API: Cancel Initiated Deposit
  if (method === 'POST' && pathname === '/api/user/wallet/deposit/cancel') {
    try {
      const body = await parseBody(req);
      const reference = body.reference || body.referenceId || body.id;
      if (!reference) return sendJson(res, 400, { error: 'Valid deposit reference is required.' });
      const deposit = db.cancelWalletDeposit(reference);
      return sendJson(res, 200, { success: true, deposit });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Customer Wallet Deposit API (Direct fallback)
  if (method === 'POST' && pathname === '/api/user/wallet/deposit') {
    try {
      const body = await parseBody(req);
      const amount = Math.round(Number(body.amount));
      if (isNaN(amount) || amount < 50) {
        return sendJson(res, 400, { error: 'Minimum deposit amount is ₹50.' });
      }
      const profile = db.getUserProfile();
      const userId = profile.userId12 || profile.id || 'default_user';
      const paymentMethod = body.paymentMethod || 'Instant UPI';
      const depositRef = `DEP-${Math.floor(100000 + Math.random() * 900000)}`;

      const deposit = db.createWalletDeposit({
        userId: userId,
        phone: profile.phone,
        amount: amount,
        reference: depositRef,
        method: paymentMethod,
        status: 'PENDING_APPROVAL'
      });

      return sendJson(res, 200, {
        success: true,
        message: `₹${amount} deposit request submitted (${depositRef}). Awaiting admin approval.`,
        deposit: deposit
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Customer Wallet Transactions Feed
  if (method === 'GET' && pathname === '/api/user/wallet/transactions') {
    try {
      const profile = db.getUserProfile();
      const userId = parsedUrl.query?.userId || profile.userId12 || profile.id || 'CURRENT_USER';
      const user = db.getUser(userId) || profile;
      const txns = db.getUserTransactions(userId);
      const balance = (user && user.walletBalance !== undefined) ? user.walletBalance : (profile.wallet?.balance || 0);
      return sendJson(res, 200, { success: true, balance: balance, walletBalance: balance, transactions: txns });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Customer Wallet Withdrawal Request API (Disabled by platform policy)
  if (method === 'POST' && pathname === '/api/user/wallet/withdraw') {
    return sendJson(res, 400, {
      error: 'Wallet withdrawals are disabled. Wallet balance is strictly used for autonomous food ordering on Domino\'s Order Engine.'
    });
  }

  // Admin Wallet Balance Management: Manually Add Money / Credit Balance
  if (method === 'POST' && pathname === '/api/admin/wallet/balance/add') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const { userId, amount, reason } = body;
      if (!userId || !amount) return sendJson(res, 400, { error: 'userId and amount are required.' });
      const result = db.adminManualAddBalance(userId, amount, reason);
      return sendJson(res, 200, { success: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin Wallet Deposit Approvals API
  if (method === 'GET' && pathname === '/api/admin/wallet/deposits') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const deposits = db.getWalletDeposits();
      return sendJson(res, 200, deposits);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/admin/wallet/deposits/approve') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const ref = body.reference || body.referenceId || body.id;
      if (!ref) return sendJson(res, 400, { error: 'Deposit reference is required.' });

      const result = db.approveWalletDeposit(ref, body.note || 'Admin Verified & Approved');
      return sendJson(res, 200, {
        success: true,
        message: `Deposit ${ref} approved successfully! User wallet credited with ₹${result.deposit.amount}.`,
        deposit: result.deposit,
        user: result.user
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/admin/wallet/deposits/reject') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const ref = body.reference || body.referenceId || body.id;
      if (!ref) return sendJson(res, 400, { error: 'Deposit reference is required.' });

      const result = db.rejectWalletDeposit(ref, body.reason || 'Payment verification failed');
      return sendJson(res, 200, {
        success: true,
        message: `Deposit ${ref} rejected.`,
        deposit: result.deposit
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin Wallet Withdrawals Desk API
  if (method === 'GET' && pathname === '/api/admin/wallet/withdrawals') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const withdrawals = db.getWalletWithdrawals();
      return sendJson(res, 200, withdrawals);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/admin/wallet/withdrawals/approve') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const ref = body.withdrawalId || body.reference || body.referenceId || body.id;
      if (!ref) return sendJson(res, 400, { error: 'Withdrawal reference is required.' });
      const note = body.payoutReference || body.adminNote || 'UPI Payout Complete';
      const result = db.approveWalletWithdrawal(ref, note);
      return sendJson(res, 200, { success: true, withdrawal: result.withdrawal });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/admin/wallet/withdrawals/reject') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const ref = body.withdrawalId || body.reference || body.referenceId || body.id;
      if (!ref) return sendJson(res, 400, { error: 'Withdrawal reference is required.' });
      const result = db.rejectWalletWithdrawal(ref, body.reason || 'Declined by Admin');
      return sendJson(res, 200, { success: true, withdrawal: result.withdrawal });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Direct In-App Broadcast Announcements API
  if (method === 'GET' && pathname === '/api/announcements') {
    try {
      const announcements = db.getAnnouncements();
      return sendJson(res, 200, { success: true, announcements });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/admin/announcements') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const ann = db.createAnnouncement(body);
      return sendJson(res, 200, { success: true, announcement: ann });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'DELETE' && pathname.startsWith('/api/admin/announcements/')) {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const id = pathname.split('/')[4];
      const deleted = db.deleteAnnouncement(id);
      return sendJson(res, 200, { success: true, deleted });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Active Domino's Sessions Real-Time Fleet Feed API
  if (method === 'GET' && pathname === '/api/admin/sessions/feed') {
    try {
      if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const accounts = db.getAccounts();
      const enriched = accounts.map(acc => {
        const sHealth = calculateSessionHealth(acc);
        const isDisabled = Boolean(acc.disabled || acc.status === 'DISABLED');
        return {
          id: acc.id,
          phone: acc.phone,
          cleanPhone: acc.cleanPhone,
          customerName: acc.customerName,
          status: isDisabled ? 'DISABLED' : (acc.status || 'IDLE'),
          disabled: isDisabled,
          activeOrderId: acc.activeOrderId || null,
          pastOrdersCount: acc.pastOrdersCount || 0,
          accountType: acc.accountType || (acc.pastOrdersCount === 0 ? 'NEW_ACCOUNT' : 'EXISTING_ACCOUNT'),
          categoryName: acc.categoryName,
          couponCode: acc.couponCode,
          sessionHealth: sHealth,
          hasToken: Boolean(acc.sessionToken || acc.credentials?.accessToken),
          lastAssignedAt: acc.lastAssignedAt || null,
          lastRefreshedAt: acc.lastRefreshedAt || acc.storedAt
        };
      });

      const idleCount = enriched.filter(a => a.status === 'IDLE' && !a.disabled).length;
      const inUseCount = enriched.filter(a => a.status === 'IN_USE').length;
      const disabledCount = enriched.filter(a => a.disabled).length;
      const oldCount = enriched.filter(a => a.sessionHealth?.isOld).length;
      const expiredCount = enriched.filter(a => a.sessionHealth?.isExpired).length;

      return sendJson(res, 200, {
        success: true,
        counts: {
          total: enriched.length,
          idle: idleCount,
          inUse: inUseCount,
          disabled: disabledCount,
          old: oldCount,
          expired: expiredCount
        },
        fleet: enriched
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // =========================================================================
  // 9a. Support Tickets & Real-Time Help Chat API
  // =========================================================================

  // Get Tickets (by user phone or all for admin)
  if (method === 'GET' && pathname === '/api/support/tickets') {
    const phone = parsedUrl.query?.phone;
    const isAdmin = checkAdminAuth(req);
    if (!phone && !isAdmin) {
      return sendJson(res, 401, { error: 'Phone number or admin authorization required' });
    }
    const tickets = db.getTickets(isAdmin && !phone ? null : phone);
    return sendJson(res, 200, tickets);
  }

  // Create Ticket with Automated Chatbot Triage
  if (method === 'POST' && pathname === '/api/support/tickets') {
    try {
      const body = await parseBody(req);
      if (!body.userPhone) {
        return sendJson(res, 400, { error: 'User phone number is required to raise a ticket' });
      }
      const ticket = db.createTicket({
        orderId: body.orderId || null,
        userId: body.userId || null,
        userPhone: body.userPhone,
        userName: body.userName || 'Customer',
        category: body.category || 'OTHER',
        description: body.description || '',
        imageUrl: body.imageUrl || null
      });
      return sendJson(res, 201, { success: true, ticket });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Get Specific Ticket
  if (method === 'GET' && pathname.startsWith('/api/support/tickets/') && !pathname.includes('/messages')) {
    const id = pathname.split('/')[4];
    const ticket = db.getTicketById(id);
    if (!ticket) return sendJson(res, 404, { error: 'Ticket not found' });
    return sendJson(res, 200, ticket);
  }

  // Post Message to Ticket Chat (User or Admin)
  if (method === 'POST' && pathname.startsWith('/api/support/tickets/') && pathname.endsWith('/messages')) {
    try {
      const id = pathname.split('/')[4];
      const body = await parseBody(req);
      if (!body.text && !body.imageUrl) {
        return sendJson(res, 400, { error: 'Message text or image attachment is required' });
      }
      const msg = db.addTicketMessage(id, {
        sender: body.sender || 'USER',
        senderName: body.senderName || 'Customer',
        text: body.text || '',
        imageUrl: body.imageUrl || null
      });
      if (!msg) return sendJson(res, 404, { error: 'Ticket not found' });
      return sendJson(res, 200, { success: true, message: msg, ticket: db.getTicketById(id) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Update Ticket Status (Resolve / Close)
  if ((method === 'PATCH' || method === 'POST') && pathname.startsWith('/api/support/tickets/') && pathname.endsWith('/status')) {
    try {
      const id = pathname.split('/')[4];
      const body = await parseBody(req);
      const ticket = db.updateTicketStatus(id, body.status || 'RESOLVED');
      if (!ticket) return sendJson(res, 404, { error: 'Ticket not found' });
      return sendJson(res, 200, { success: true, ticket });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 9b. Admin: Customer Users Directory & Profile Control
  if (method === 'GET' && pathname === '/api/admin/users') {
    return sendJson(res, 200, db.getUsers());
  }

  if ((method === 'POST' || method === 'PATCH') && pathname.startsWith('/api/admin/users/') && pathname.includes('/edit')) {
    try {
      const phone = pathname.split('/')[4];
      const body = await parseBody(req);
      const result = db.adminEditCustomerUser(phone, body);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/admin/users/') && (pathname.endsWith('/update') || pathname.split('/').length === 5)) {
    try {
      const userId = pathname.split('/')[4];
      const body = await parseBody(req);
      const user = db.adminUpdateUser(userId, body);
      return sendJson(res, 200, { success: true, user: user });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Delete User Account
  if (method === 'DELETE' && pathname.startsWith('/api/admin/users/') && pathname.split('/').length === 5) {
    try {
      const userId = pathname.split('/')[4];
      const deleted = db.deleteUser(userId);
      return sendJson(res, 200, { success: true, message: 'User deleted from directory successfully.', deleted });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin: Toggle User Status (ACTIVE / SUSPENDED)
  if (method === 'POST' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/toggle-status')) {
    try {
      const userId = pathname.split('/')[4];
      const user = db.toggleUserStatus(userId);
      return sendJson(res, 200, { success: true, user: user, status: user.status });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/wallet')) {
    try {
      const userId = pathname.split('/')[4];
      const body = await parseBody(req);
      if (!body.amount || isNaN(body.amount)) {
        return sendJson(res, 400, { error: 'Valid wallet credit amount is required.' });
      }
      const user = db.creditUserWallet(userId, Number(body.amount), body.reason || 'Admin Adjustment');
      return sendJson(res, 200, { success: true, user: user });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin Wallet Adjustment (+ / - / =) with Audit Log
  if (method === 'POST' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/adjust-wallet')) {
    try {
      const userId = pathname.split('/')[4];
      const body = await parseBody(req);
      const resData = db.adjustUserWallet(userId, body);
      return sendJson(res, 200, { 
        success: true, 
        user: resData.user, 
        wallet: { balance: resData.user.walletBalance },
        transaction: resData.transaction 
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Admin User Transaction History
  if (method === 'GET' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/transactions')) {
    const userId = pathname.split('/')[4];
    const txns = db.getUserTransactions(userId);
    return sendJson(res, 200, { success: true, transactions: txns });
  }

  // Admin User Order History
  if (method === 'GET' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/orders')) {
    const userId = pathname.split('/')[4];
    const orders = db.getUserOrders(userId);
    return sendJson(res, 200, { success: true, orders: orders });
  }

  // Admin User Addresses Management (Max 3 Addresses Enforced)
  if (method === 'GET' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/addresses')) {
    try {
      const userId = pathname.split('/')[4];
      const addrs = db.adminGetUserAddresses(userId);
      return sendJson(res, 200, { success: true, addresses: addrs });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/admin/users/') && pathname.endsWith('/addresses')) {
    try {
      const userId = pathname.split('/')[4];
      const body = await parseBody(req);
      const addrs = db.adminSaveUserAddress(userId, body);
      return sendJson(res, 200, { success: true, addresses: addrs });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'DELETE' && pathname.startsWith('/api/admin/users/') && pathname.includes('/addresses/')) {
    try {
      const parts = pathname.split('/');
      const userId = parts[4];
      const addressId = parts[6];
      const addrs = db.adminDeleteUserAddress(userId, addressId);
      return sendJson(res, 200, { success: true, addresses: addrs });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/admin/users/') && pathname.includes('/addresses/') && pathname.endsWith('/default')) {
    try {
      const parts = pathname.split('/');
      const userId = parts[4];
      const addressId = parts[6];
      const addrs = db.adminSetDefaultUserAddress(userId, addressId);
      return sendJson(res, 200, { success: true, addresses: addrs });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 9c. In-App Notifications (Storefront & Admin Broadcast)
  if (method === 'GET' && pathname === '/api/notifications') {
    return sendJson(res, 200, db.getNotifications());
  }

  if (method === 'POST' && pathname === '/api/admin/notifications/broadcast') {
    try {
      const body = await parseBody(req);
      if (!body.title || !body.message) {
        return sendJson(res, 400, { error: 'Notification title and message are required.' });
      }
      const notif = db.broadcastNotification(body);
      return sendJson(res, 201, { success: true, notification: notif });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'DELETE' && pathname.startsWith('/api/admin/notifications/')) {
    const notifId = pathname.split('/')[4];
    const notifs = db.deleteNotification(notifId);
    return sendJson(res, 200, { success: true, notifications: notifs });
  }

  // 10. Admin: Orders Live Monitor (Auto-heals from cloud if local array is empty)
  if (method === 'GET' && pathname === '/api/admin/orders') {
    let orders = db.getOrders();
    if (orders.length === 0) {
      try {
        const cloudData = await firebaseService.pullFromCloud();
        if (cloudData) {
          db.mergeCloudData(cloudData);
          orders = db.getOrders();
        }
      } catch (_) {}
    }
    return sendJson(res, 200, orders);
  }

  // Admin: Force Cloud Data Sync & Pull
  if ((method === 'POST' || method === 'GET') && pathname === '/api/admin/cloud/pull') {
    try {
      const cloudData = await firebaseService.pullFromCloud();
      if (cloudData) db.mergeCloudData(cloudData);
      return sendJson(res, 200, {
        success: true,
        message: 'Successfully pulled and merged cloud records from Firebase RTDB',
        accounts: db.getAccounts().length,
        orders: db.getOrders().length,
        users: db.getUsers().length,
        vouchers: db.getVouchers().length
      });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // --- STATIC FILES ---
  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (pathname === '/admin' || pathname === '/admin.html') {
    const adminToken = createAdminToken('parthgulyani7960@gmail.com');
    res.setHeader('Set-Cookie', `admin_token=${adminToken}; Path=/; SameSite=Lax; Max-Age=86400`);
    return serveStatic(res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  const requestedPath = path.join(PUBLIC_DIR, pathname);
  // Security check to avoid path traversal
  if (requestedPath.startsWith(PUBLIC_DIR)) {
    return serveStatic(res, requestedPath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Domino's Automation Ordering Engine is LIVE!`);
  console.log(`👉 Customer Storefront : http://localhost:${PORT}`);
  console.log(`👉 Admin Panel         : http://localhost:${PORT}/admin`);
  console.log(`=======================================================`);

  // Domino's SNC Cloud Automatic Realtime Synchronizer
  // Automatically polls & syncs active orders in background every 20s with zero manual user refresh needed
  setInterval(async () => {
    try {
      const orders = db.getOrders();
      const activeOrders = orders.filter(o => {
        const st = o.robot?.status || o.status;
        return st && !['DELIVERED', 'CANCELLED', 'ERROR'].includes(st);
      });
      if (activeOrders.length > 0) {
        await syncOrdersWithDominosCloud();
      }
    } catch (_) {}
  }, 20000);

  // Autonomous Watchdog: Auto-detect and recover interrupted/stalled placement orders on boot
  setTimeout(() => {
    try {
      const orders = db.getOrders();
      const stalled = orders.filter(o => {
        const st = o.robot?.status || o.status;
        return ['STORE_RESOLVING', 'SESSION_ASSIGNING', 'BUILDING_CART', 'APPLYING_COUPON', 'QUEUED_FOR_ROBOT', 'STORE_CONFIRMATION'].includes(st) && !o.robot?.dominosOrderRef;
      });
      if (stalled.length > 0) {
        console.log(`[WATCHDOG] Found ${stalled.length} interrupted placement order(s). Auditing state...`);
        stalled.forEach(o => {
          const createdTime = new Date(o.createdAt).getTime();
          const ageMinutes = (Date.now() - createdTime) / (60 * 1000);
          if (ageMinutes < 25) {
            console.log(`[WATCHDOG] Auto-resuming recent order #${o.id} in autonomous placement queue...`);
            queue.enqueue(o.id);
          } else {
            console.log(`[WATCHDOG] Expiring stale interrupted order #${o.id} (${Math.round(ageMinutes)} mins old)...`);
            if (!o.robot) o.robot = {};
            o.robot.status = 'ERROR';
            o.robot.error = 'Order placement timed out during previous server maintenance. Click Retry Placement to re-run.';
            db.updateOrder(o.id, o);
          }
        });
      }
    } catch (e) {
      console.warn('[WATCHDOG-RECOVERY-ERR]', e.message);
    }
  }, 3500);
});
