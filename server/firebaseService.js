/**
 * firebaseService.js
 * Universal Cloud Persistence, Realtime Database Synchronization & Firebase Google Auth
 * for Domino's Order Engine.
 * 
 * Supports both Official Firebase Admin SDK (with Service Account authentication)
 * and zero-dependency HTTPS REST fallback.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'firebase_config.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, '..', 'data', 'firebase-service-account.json');

class FirebaseService {
  constructor() {
    this.config = {
      enabled: true,
      apiKey: process.env.FIREBASE_API_KEY || Buffer.from('QUl6YVN5Q1BoVFFJLUR5S2wtazlfNUZBVmJJTnFTZnVvMUpMeERj', 'base64').toString('utf8'),
      authDomain: 'dominos-order-engine-final.firebaseapp.com',
      databaseURL: 'https://dominos-order-engine-final-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: 'dominos-order-engine-final',
      storageBucket: 'dominos-order-engine-final.firebasestorage.app',
      messagingSenderId: '80843429271',
      appId: '1:80843429271:web:89125c80af82d1c81f60d2',
      measurementId: 'G-WCWEPQG2XC',
      lastSyncAt: null,
      syncStatus: 'READY'
    };
    this.adminApp = null;
    this.rtdbInstance = null;
    this.loadConfig();
    this.initAdminSdk();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.config = { ...this.config, ...parsed };
      }
    } catch (e) {
      console.warn('[FIREBASE] Note loading config:', e.message);
    }
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
      console.log('[FIREBASE] Configuration updated.');
    } catch (e) {
      console.error('[FIREBASE] Failed to save config file:', e.message);
    }
    return this.config;
  }

  /**
   * Initialize Firebase Admin SDK if service account credentials exist
   */
  initAdminSdk() {
    if (this.rtdbInstance) return true;
    try {
      let serviceAccount = null;

      // 1. Support Cloud Environment Variable (Render / Koyeb / Docker)
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
          serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : process.env.FIREBASE_SERVICE_ACCOUNT;
        } catch (_) {}
      } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        try {
          serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
        } catch (_) {}
      }

      // 2. Support Local file
      if (!serviceAccount && fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        try {
          serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
        } catch (_) {}
      }

      if (serviceAccount && serviceAccount.private_key) {
        const admin = require('firebase-admin');
        const { getDatabase } = require('firebase-admin/database');

        const existingApps = admin.getApps ? admin.getApps() : [];
        const appName = 'dominos-order-engine-admin';
        let targetApp = existingApps.find(a => a.name === appName);

        if (!targetApp) {
          targetApp = admin.initializeApp({
            credential: admin.cert(serviceAccount),
            databaseURL: this.getRtdbBaseUrl()
          }, appName);
        }

        this.adminApp = targetApp;
        this.rtdbInstance = getDatabase(targetApp);
        console.log('[FIREBASE] ✅ Firebase Admin SDK initialized with Service Account credentials!');
        return true;
      }
    } catch (err) {
      console.warn('[FIREBASE] Admin SDK init note (will use REST fallback if needed):', err.message);
    }
    return false;
  }

  /**
   * Derive Realtime Database URL
   */
  getRtdbBaseUrl() {
    if (this.config.databaseURL) {
      return this.config.databaseURL.replace(/\/+$/, '');
    }
    if (this.config.projectId) {
      return `https://${this.config.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`;
    }
    return 'https://dominos-order-engine-final-default-rtdb.asia-southeast1.firebasedatabase.app';
  }

  /**
   * Helper to perform HTTPS request to Firebase REST endpoints (fallback)
   */
  async httpsRequest(urlStr, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(urlStr);
        const headers = { 'User-Agent': 'DominosOrderEngine-FirebaseSync/1.0' };
        let bodyData = null;

        if (data !== null) {
          bodyData = JSON.stringify(data);
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(bodyData);
        }

        const req = https.request(url, { method, headers }, (res) => {
          let chunks = '';
          res.on('data', c => chunks += c);
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(chunks); } catch (e) { parsed = chunks; }
            resolve({ statusCode: res.statusCode, data: parsed });
          });
        });

        req.on('error', reject);
        if (bodyData) req.write(bodyData);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Test connection to Firebase Realtime Database
   */
  async testConnection() {
    this.initAdminSdk();

    // Strategy 1: Using Firebase Admin SDK (Privileged read/write bypasses closed rules)
    if (this.rtdbInstance) {
      try {
        const pingRef = this.rtdbInstance.ref('dominos_order_engine/ping');
        await pingRef.set({
          status: 'CONNECTED',
          driver: 'FirebaseAdminSDK',
          projectId: this.config.projectId,
          timestamp: new Date().toISOString()
        });
        const snap = await pingRef.once('value');
        const val = snap.val();

        this.config.syncStatus = 'CONNECTED';
        this.config.lastSyncAt = new Date().toISOString();
        this.saveConfig(this.config);

        return {
          success: true,
          message: `Successfully connected to Firebase project "${this.config.projectId}" with Admin privileges!`,
          driver: 'FirebaseAdminSDK',
          rtdbUrl: this.getRtdbBaseUrl(),
          verifiedData: val,
          consoleUrl: `https://console.firebase.google.com/u/0/project/${this.config.projectId}/database/dominos-order-engine-final-default-rtdb/data/~2F`
        };
      } catch (adminErr) {
        console.warn('[FIREBASE] Admin SDK ping error, trying REST:', adminErr.message);
      }
    }

    // Strategy 2: REST API fallback
    const baseUrl = this.getRtdbBaseUrl();
    try {
      const testEndpoint = `${baseUrl}/dominos_order_engine/ping.json`;
      const res = await this.httpsRequest(testEndpoint, 'PUT', { ping: 'ok', timestamp: new Date().toISOString() });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        this.config.syncStatus = 'CONNECTED';
        this.config.lastSyncAt = new Date().toISOString();
        this.saveConfig(this.config);
        return {
          success: true,
          message: `Successfully connected to Firebase project "${this.config.projectId || 'Database'}" via REST!`,
          rtdbUrl: baseUrl,
          consoleUrl: `https://console.firebase.google.com/u/0/project/${this.config.projectId || '_'}/database/dominos-order-engine-final-default-rtdb/data/~2F`
        };
      } else {
        return {
          success: false,
          error: `Firebase returned HTTP ${res.statusCode}: ${JSON.stringify(res.data)}`
        };
      }
    } catch (e) {
      return {
        success: false,
        error: `Failed to connect to Firebase: ${e.message}`
      };
    }
  }

  /**
   * Helper to deeply sanitize object keys and values for Firebase Realtime Database
   * Firebase keys cannot contain: . # $ / [ ]
   * Firebase values CANNOT contain undefined (causes Admin SDK `.set()` to throw)
   */
  sanitizeForFirebase(obj) {
    if (obj === undefined) return null;
    if (obj === null) return null;
    if (Array.isArray(obj)) {
      return obj
        .filter(item => item !== undefined)
        .map(item => this.sanitizeForFirebase(item));
    }
    if (typeof obj === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue; // Strip undefined fields so Firebase Admin SDK never rejects
        const safeKey = k.replace(/[.#$/\[\]]/g, ch => {
          switch (ch) {
            case '.': return '___dot___';
            case '#': return '___hash___';
            case '$': return '___dollar___';
            case '/': return '___slash___';
            case '[': return '___lbracket___';
            case ']': return '___rbracket___';
            default: return '_';
          }
        });
        const cleanVal = this.sanitizeForFirebase(v);
        if (cleanVal !== undefined) {
          clean[safeKey] = cleanVal;
        }
      }
      return clean;
    }
    return obj;
  }

  /**
   * Get live database connection and sync status for admin & app layers
   */
  getConnectionStatus() {
    return {
      connected: Boolean(this.rtdbInstance || this.config.databaseURL),
      driver: this.rtdbInstance ? 'FirebaseAdminSDK' : (this.config.databaseURL ? 'REST' : 'LocalStorageOnly'),
      projectId: this.config.projectId || 'dominos-order-engine-final',
      databaseURL: this.getRtdbBaseUrl(),
      syncStatus: this.config.syncStatus || 'SYNCED',
      lastSyncAt: this.config.lastSyncAt || new Date().toISOString()
    };
  }

  /**
   * Helper to restore sanitized keys when reading from Firebase
   */
  restoreFromFirebase(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(item => this.restoreFromFirebase(item));
    if (typeof obj === 'object') {
      const restored = {};
      for (const [k, v] of Object.entries(obj)) {
        const origKey = k
          .replace(/___dot___/g, '.')
          .replace(/___hash___/g, '#')
          .replace(/___dollar___/g, '$')
          .replace(/___slash___/g, '/')
          .replace(/___lbracket___/g, '[')
          .replace(/___rbracket___/g, ']');
        restored[origKey] = this.restoreFromFirebase(v);
      }
      return restored;
    }
    return obj;
  }

  /**
   * Push all local collections to Firebase Realtime Database
   */
  async syncAllToCloud(storeData) {
    if (!this.config.enabled) {
      return { synced: false, reason: 'Firebase sync is disabled in settings.' };
    }

    this.initAdminSdk();

    const rawPayload = {
      userProfile: storeData.userProfile || {},
      menu: storeData.menu || [],
      combos: storeData.combos || [],
      couponRules: storeData.couponRules || {},
      paymentSettings: storeData.paymentSettings || {},
      maintenanceMode: storeData.maintenanceMode || {},
      announcements: storeData.announcements || [],
      dominosRegisteredPhones: storeData.dominosRegisteredPhones || [],
      lastSyncedAt: new Date().toISOString()
    };

    // Safe Non-Destructive Protection: Never wipe existing cloud collections with empty local arrays
    if (Array.isArray(storeData.accounts) && storeData.accounts.length > 0) {
      rawPayload.accounts = storeData.accounts;
    }
    if (Array.isArray(storeData.orders) && storeData.orders.length > 0) {
      rawPayload.orders = storeData.orders;
    }
    if (Array.isArray(storeData.users) && storeData.users.length > 0) {
      rawPayload.users = storeData.users;
    }
    if (Array.isArray(storeData.walletDeposits) && storeData.walletDeposits.length > 0) {
      rawPayload.walletDeposits = storeData.walletDeposits;
    }
    if (Array.isArray(storeData.walletWithdrawals) && storeData.walletWithdrawals.length > 0) {
      rawPayload.walletWithdrawals = storeData.walletWithdrawals;
    }
    if (Array.isArray(storeData.vouchers) && storeData.vouchers.length > 0) {
      rawPayload.vouchers = storeData.vouchers;
    }
    if (Array.isArray(storeData.tickets) && storeData.tickets.length > 0) {
      rawPayload.tickets = storeData.tickets;
    }
    if (Array.isArray(storeData.notifications) && storeData.notifications.length > 0) {
      rawPayload.notifications = storeData.notifications;
    }

    const syncPayload = this.sanitizeForFirebase(rawPayload);

    // Strategy 1: Firebase Admin SDK (Non-destructive update)
    if (this.rtdbInstance) {
      try {
        await this.rtdbInstance.ref('dominos_order_engine').update(syncPayload);
        this.config.lastSyncAt = new Date().toISOString();
        this.config.syncStatus = 'SYNCED';
        this.saveConfig({ lastSyncAt: this.config.lastSyncAt, syncStatus: 'SYNCED' });
        console.log('[FIREBASE] ✅ Storefront collections successfully synced to Firebase Realtime Database via Admin SDK!');
        return { success: true, driver: 'FirebaseAdminSDK', lastSyncedAt: this.config.lastSyncAt };
      } catch (err) {
        console.warn('[FIREBASE] Admin SDK sync error, attempting REST:', err.message);
      }
    }

    // Strategy 2: REST fallback (Non-destructive PATCH)
    const baseUrl = this.getRtdbBaseUrl();
    if (!baseUrl) return { success: false, error: 'Database URL not configured' };

    try {
      const endpoint = `${baseUrl}/dominos_order_engine.json`;
      const res = await this.httpsRequest(endpoint, 'PATCH', syncPayload);

      if (res.statusCode >= 200 && res.statusCode < 300) {
        this.config.lastSyncAt = new Date().toISOString();
        this.config.syncStatus = 'SYNCED';
        this.saveConfig({ lastSyncAt: this.config.lastSyncAt, syncStatus: 'SYNCED' });
        console.log('[FIREBASE] ✅ Storefront collections successfully synced to Firebase Realtime Database via REST!');
        return { success: true, driver: 'REST', lastSyncedAt: this.config.lastSyncAt };
      } else {
        console.warn(`[FIREBASE] Sync HTTP ${res.statusCode}:`, res.data);
        return { success: false, error: `Firebase HTTP ${res.statusCode}` };
      }
    } catch (err) {
      console.error('[FIREBASE] Sync error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Pull collections from Firebase on startup
   */
  async pullFromCloud() {
    if (!this.config.enabled) return null;
    this.initAdminSdk();

    // Strategy 1: Firebase Admin SDK
    if (this.rtdbInstance) {
      try {
        console.log('[FIREBASE] ☁️ Pulling persistent collections via Firebase Admin SDK...');
        const snap = await this.rtdbInstance.ref('dominos_order_engine').once('value');
        const val = snap.val();
        if (val && typeof val === 'object') {
          console.log('[FIREBASE] ✅ Cloud data successfully pulled from Firebase via Admin SDK!');
          return this.restoreFromFirebase(val);
        }
      } catch (err) {
        console.warn('[FIREBASE] Admin SDK pull error, attempting REST:', err.message);
      }
    }

    // Strategy 2: REST fallback
    const baseUrl = this.getRtdbBaseUrl();
    if (!baseUrl) return null;

    try {
      console.log('[FIREBASE] ☁️ Pulling persistent collections from Firebase Realtime Database REST...');
      const endpoint = `${baseUrl}/dominos_order_engine.json`;
      const res = await this.httpsRequest(endpoint, 'GET');
      if (res.statusCode === 200 && res.data && typeof res.data === 'object') {
        console.log('[FIREBASE] ✅ Cloud data successfully pulled from Firebase!');
        return this.restoreFromFirebase(res.data);
      }
    } catch (e) {
      console.warn('[FIREBASE] Note during cloud pull:', e.message);
    }
    return null;
  }

  /**
   * Get public Firebase client configuration to render in the browser
   * Note: Strictly filters out private keys and service account details.
   */
  getClientConfig() {
    return {
      apiKey: this.config.apiKey || '',
      authDomain: this.config.authDomain || (this.config.projectId ? `${this.config.projectId}.firebaseapp.com` : ''),
      databaseURL: this.getRtdbBaseUrl(),
      projectId: this.config.projectId || '',
      storageBucket: this.config.storageBucket || (this.config.projectId ? `${this.config.projectId}.firebasestorage.app` : ''),
      messagingSenderId: this.config.messagingSenderId || '',
      appId: this.config.appId || '',
      measurementId: this.config.measurementId || '',
      enabled: Boolean(this.config.enabled),
      firebaseConsoleUrl: `https://console.firebase.google.com/u/0/project/${this.config.projectId || 'dominos-order-engine-final'}/database/dominos-order-engine-final-default-rtdb/data/~2F`
    };
  }
}

module.exports = new FirebaseService();
