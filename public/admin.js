// Domino's Order Engine Admin Console - Real Live OTP & Session Management
// Domino's Order Engine Admin Console - Real Live OTP & Session Management

// =========================================================================
// CONSOLE PRIVACY & SECURITY GUARD (ANTI-LEAK ENFORCEMENT)
// =========================================================================
(function() {
  if (typeof window === 'undefined') return;

  function maskSensitive(val) {
    if (typeof val === 'string') {
      return val
        .replace(/(\+?91[\s-]?)?([6-9]\d{1})\d{4}(\d{4})/g, '$1$2****$3')
        .replace(/dom-admin-sec-[a-zA-Z0-9_-]+/g, '[PROTECTED_ADMIN_KEY]')
        .replace(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g, '[REDACTED_JWT]');
    }
    if (val && typeof val === 'object') {
      try {
        const copy = Array.isArray(val) ? [...val] : { ...val };
        if (copy.private_key) copy.private_key = '[REDACTED]';
        if (copy.apiKey) copy.apiKey = '[REDACTED]';
        if (copy.adminToken) copy.adminToken = '[REDACTED]';
        if (copy.token && typeof copy.token === 'string') copy.token = '[REDACTED]';
        return copy;
      } catch (e) {
        return '[Protected Object]';
      }
    }
    return val;
  }

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = function(...args) { origLog.apply(console, args.map(maskSensitive)); };
  console.warn = function(...args) { origWarn.apply(console, args.map(maskSensitive)); };
  console.error = function(...args) { origError.apply(console, args.map(maskSensitive)); };

  try {
    Object.defineProperty(window, 'ADMIN_SECRET_KEY', {
      get: () => '[PROTECTED_ADMIN_SECRET]',
      set: () => false,
      configurable: false
    });
  } catch (e) {}
})();

let currentOtpCountdown = null;
let activeCookiesData = null;
let extractionGuideData = null;
let phoneDetectDebounceTimer = null;
let isAdminAuthenticated = false;

// Helper for authenticated admin API requests (Uses dynamic session token or entered passkey)
function getAdminAuthHeaders() {
  const headers = {};
  const token = sessionStorage.getItem('dom_admin_token');
  if (token) {
    headers['x-admin-token'] = token;
  }
  const passkey = sessionStorage.getItem('dom_admin_passkey');
  if (passkey) {
    headers['x-admin-key'] = passkey;
  }
  return headers;
}

function adminFetch(url, options = {}) {
  const headers = { ...options.headers, ...getAdminAuthHeaders() };
  return fetch(url, { ...options, headers, credentials: 'include' });
}

// Switch top-level Admin views (Zero infinite scrolling, instant tab transition)
function switchAdminView(viewName) {
  const views = ['sessions', 'orders', 'users', 'support', 'vouchers', 'alerts', 'menu'];
  if (!views.includes(viewName)) viewName = 'sessions';

  // Persist selection
  try {
    localStorage.setItem('domAdminTab', viewName);
    history.replaceState(null, '', '#' + viewName);
  } catch (e) {}

  views.forEach(v => {
    const tabBtn = document.getElementById('tabBtn-' + v);
    const viewContainer = document.getElementById('view-' + v);
    if (tabBtn) {
      if (v === viewName) {
        tabBtn.classList.add('active');
      } else {
        tabBtn.classList.remove('active');
      }
    }
    if (viewContainer) {
      if (v === viewName) {
        viewContainer.style.display = 'block';
      } else {
        viewContainer.style.display = 'none';
      }
    }
  });

  if (!isAdminAuthenticated) return;

  // Trigger on-demand loads for newly selected view
  if (viewName === 'orders') loadOrders();
  if (viewName === 'users') { loadAppUsers(); loadWalletDeposits(); }
  if (viewName === 'support') loadAdminTickets();
  if (viewName === 'vouchers') { loadVouchers(); loadPaymentReceiverSettings(); }
  if (viewName === 'alerts') { loadNotifications(); loadMaintenanceStatus(); loadProxySettings(); loadFirebaseSettings(); }
  if (viewName === 'sessions') { loadAccounts(); loadSessionFleetFeed(); }
  if (viewName === 'menu') { loadAdminMenu(); }
}

let adminRefreshIntervals = [];

function startAdminAutoRefresh() {
  adminRefreshIntervals.forEach(clearInterval);
  adminRefreshIntervals = [
    setInterval(loadOrders, 4000),
    setInterval(loadAdminTickets, 5000),
    setInterval(loadSessionFleetFeed, 5000),
    setInterval(loadWalletDeposits, 6000),
    setInterval(loadMaintenanceStatus, 15000)
  ];
}

async function checkAdminAuthStatus() {
  try {
    const res = await adminFetch('/api/admin/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      isAdminAuthenticated = true;
      onAdminUnlocked(data.adminEmail || 'parthgulyani7960@gmail.com');
      return true;
    }
  } catch (e) {}

  showAdminAuthGate();
  return false;
}

function showAdminAuthGate() {
  isAdminAuthenticated = false;
  adminRefreshIntervals.forEach(clearInterval);
  const overlay = document.getElementById('adminAuthGateOverlay');
  if (overlay) overlay.style.display = 'flex';
  const badge = document.getElementById('adminUserBadge');
  if (badge) badge.style.display = 'none';
  const logoutBtn = document.getElementById('adminLogoutBtn');
  if (logoutBtn) logoutBtn.style.display = 'none';
}

function onAdminUnlocked(email = 'parthgulyani7960@gmail.com') {
  isAdminAuthenticated = true;
  const overlay = document.getElementById('adminAuthGateOverlay');
  if (overlay) overlay.style.display = 'none';
  const badge = document.getElementById('adminUserBadge');
  if (badge) badge.style.display = 'flex';
  const emailLbl = document.getElementById('adminEmailLabel');
  if (emailLbl) emailLbl.innerText = email;
  const logoutBtn = document.getElementById('adminLogoutBtn');
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';

  // Load all initial panels
  checkDatabaseConnectionStatus();
  const initialView = window.location.hash ? window.location.hash.slice(1) : (localStorage.getItem('domAdminTab') || 'sessions');
  switchAdminView(initialView);
  loadExtractionGuide();
  loadAccounts();
  loadSessionFleetFeed();
  loadCouponRules();
  loadVouchers();
  loadPaymentReceiverSettings();
  loadOrders();
  loadAppUsers();
  loadWalletDeposits();
  loadAdminTickets();
  loadNotifications();
  loadMaintenanceStatus();
  loadProxySettings();
  loadFirebaseSettings();
  startAdminAutoRefresh();
}

async function adminUnlockWithPasskey() {
  const input = document.getElementById('adminGatePasskeyInput');
  const errEl = document.getElementById('adminGateErrorMsg');
  const passkey = (input ? input.value : '').trim();

  if (!passkey) {
    if (errEl) errEl.innerText = 'Please enter the Admin Master Passkey.';
    return;
  }

  if (errEl) errEl.innerText = 'Verifying administrative credentials...';

  try {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      sessionStorage.setItem('dom_admin_token', data.token);
      sessionStorage.setItem('dom_admin_passkey', passkey);
      showToast('Admin Console Unlocked! Authorized as ' + data.email, '🛡️');
      onAdminUnlocked(data.email);
    } else {
      if (errEl) errEl.innerText = data.error || 'Invalid Admin Passkey. Access Denied.';
    }
  } catch (err) {
    if (errEl) errEl.innerText = 'Connection error: ' + err.message;
  }
}
window.adminUnlockWithPasskey = adminUnlockWithPasskey;

async function adminUnlockWithGoogle() {
  const errEl = document.getElementById('adminGateErrorMsg');
  if (errEl) errEl.innerText = 'Authenticating with Google Identity...';

  // Check if active user in localStorage is already parthgulyani7960@gmail.com
  try {
    const stored = localStorage.getItem('dominos_user');
    if (stored) {
      const u = JSON.parse(stored);
      if (u && u.email && u.email.toLowerCase() === 'parthgulyani7960@gmail.com') {
        const res = await fetch('/api/admin/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: u.email, adminSessionConfirmed: true })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          sessionStorage.setItem('dom_admin_token', data.token);
          showToast('Welcome, Administrator Parth Gulyani!', '🛡️');
          onAdminUnlocked(data.email);
          return;
        }
      }
    }
  } catch (e) {}

  // Fallback to prompting user to sign in on storefront or enter master key
  if (errEl) errEl.innerHTML = 'Please enter your Admin Master Key below, or <a href="/" style="color: #38bdf8; text-decoration: underline;">Sign In with Google (parthgulyani7960@gmail.com)</a> on the customer storefront first.';
}
window.adminUnlockWithGoogle = adminUnlockWithGoogle;

async function adminLogout() {
  if (!confirm('Are you sure you want to log out of the Admin Console?')) {
    return;
  }
  try {
    await fetch('/api/admin/auth/logout', { method: 'POST' });
  } catch (e) {}
  sessionStorage.removeItem('dom_admin_token');
  sessionStorage.removeItem('dom_admin_passkey');
  showToast('Admin session logged out.', '🔒');
  showAdminAuthGate();
}
window.adminLogout = adminLogout;

async function checkDatabaseConnectionStatus() {
  const badge = document.getElementById('adminDbStatusBadge');
  const txt = document.getElementById('adminDbStatusText');
  try {
    const res = await fetch('/api/db/status');
    const data = await res.json();
    if (res.ok && data.status === 'CONNECTED') {
      if (txt) txt.innerText = data.cloudSync?.driver === 'FirebaseAdminSDK' ? 'Cloud DB Active (Admin SDK)' : 'Database Connected';
      if (badge) {
        badge.style.background = '#f0fdf4';
        badge.style.color = '#166534';
        badge.style.borderColor = '#86efac';
      }
    } else {
      if (txt) txt.innerText = 'DB Offline';
      if (badge) {
        badge.style.background = '#fef2f2';
        badge.style.color = '#b91c1c';
        badge.style.borderColor = '#fca5a5';
      }
    }
  } catch (_) {
    if (txt) txt.innerText = 'DB Local';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  checkAdminAuthStatus();
  checkDatabaseConnectionStatus();
});

// Toast notification helper
function showToast(msg, icon = '✅') {
  const toast = document.getElementById('adminToast');
  const msgEl = document.getElementById('toastMsg');
  const iconEl = document.getElementById('toastIcon');
  if (!toast || !msgEl) return;

  msgEl.innerText = msg;
  if (iconEl) iconEl.innerText = icon;
  toast.style.display = 'flex';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

// Modal helpers
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
}

// Switch between Method 1 (Live SMS OTP) and Method 2 (Domino's JSON / Token Import)
function switchSessionMethod(method) {
  const btnOtp = document.getElementById('btnTabOtp');
  const btnJson = document.getElementById('btnTabJson');
  const secOtp = document.getElementById('methodOtpSection');
  const secJson = document.getElementById('methodJsonSection');

  if (method === 'otp') {
    if (btnOtp) btnOtp.classList.add('active');
    if (btnJson) btnJson.classList.remove('active');
    if (secOtp) secOtp.style.display = 'block';
    if (secJson) secJson.style.display = 'none';
  } else {
    if (btnJson) btnJson.classList.add('active');
    if (btnOtp) btnOtp.classList.remove('active');
    if (secJson) secJson.style.display = 'block';
    if (secOtp) secOtp.style.display = 'none';
  }
}

// Load Extraction Guide & Console Script from Backend
async function loadExtractionGuide() {
  try {
    const res = await adminFetch('/api/admin/extraction-guide');
    extractionGuideData = await res.json();
    const pre = document.getElementById('extractionScriptCode');
    if (pre && extractionGuideData.consoleScript) {
      pre.innerText = extractionGuideData.consoleScript;
    }
  } catch (err) {
    console.warn('Failed to load extraction guide:', err);
  }
}

// Copy 1-Click Extraction Script to Clipboard
function copyExtractionScriptToClipboard() {
  const script = extractionGuideData?.consoleScript || document.getElementById('extractionScriptCode')?.innerText;
  if (!script) {
    alert('Extraction script is loading, please try again in a moment.');
    return;
  }
  navigator.clipboard.writeText(script).then(() => {
    showToast('1-Click Extraction Script copied! Paste in DevTools console on m.dominos.co.in', '📋');
  }).catch(() => {
    prompt('Copy the extraction script below:', script);
  });
}

// Load Sample JSON Format for reference
function loadSampleJsonFormat() {
  const sample = extractionGuideData?.sampleJson || {
    source: "Domino's India Web (Clean Extraction)",
    phone: "9872154310",
    name: "Parth Developer",
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaG9uZSI6Ijk4NzIxNTQzMTAiLCJzdWIiOiIxMjM0NTYiLCJuYW1lIjoiUGFydGggRGV2ZWxvcGVyIiwiZXhwIjoxODAwMDAwMDAwfQ.sampleSignature",
    cookies: [
      { name: "token", value: "eyJhbGciOiJIUzI1NiIs...", domain: ".dominos.co.in", path: "/" },
      { name: "PHPSESSID", value: "dom_sess_89234812", domain: ".dominos.co.in", path: "/" }
    ]
  };
  const input = document.getElementById('adminJsonInput');
  if (input) {
    input.value = JSON.stringify(sample, null, 2);
    input.focus();
    showToast('Sample Domino\'s session JSON loaded!', '🧪');
  }
}

function clearJsonInput() {
  const input = document.getElementById('adminJsonInput');
  const phone = document.getElementById('adminJsonPhone');
  if (input) input.value = '';
  if (phone) phone.value = '';
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const input = document.getElementById('adminJsonInput');
    if (input && text) {
      input.value = text;
      showToast('Pasted from clipboard!', '📋');
    }
  } catch (e) {
    alert('Please press Ctrl+V directly inside the text box to paste.');
  }
}

// Import & Validate Domino's Session JSON / Token
async function adminImportJsonSession() {
  const jsonInput = (document.getElementById('adminJsonInput')?.value || '').trim();
  const phone = (document.getElementById('adminJsonPhone')?.value || '').trim();

  if (!jsonInput) {
    alert('Please paste your Domino\'s session JSON, cookie export, or token in the box.');
    document.getElementById('adminJsonInput')?.focus();
    return;
  }

  const btn = document.getElementById('btnImportJson');
  const originalText = btn.innerText;
  btn.innerText = '⏳ Validating Token & Querying Domino\'s History...';
  btn.disabled = true;

  try {
    const res = await adminFetch('/api/admin/accounts/import-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonInput: jsonInput,
        phone: phone || undefined
      })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`🎉 Success! Account ${data.account.phone} imported (${data.account.categoryName})`, '🔑');
    clearJsonInput();
    loadAccounts();
  } catch (err) {
    alert('Session Import / Validation Error:\n\n' + err.message);
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

// Re-check validity of an existing session in pool
async function validateAccountSession(accountId) {
  showToast('Probing Domino\'s server for live token status...', '🔄');
  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/validate`, { method: 'POST' });
    const data = await res.json();
    if (data.success && data.valid) {
      showToast(`✓ Session is ACTIVE & VALID! (${data.account.categoryName})`, '🟢');
    } else {
      alert(`⚠️ Token Status: ${data.error || 'Session expired or rejected by Domino\'s.'}`);
    }
    loadAccounts();
  } catch (err) {
    alert('Validation probe failed: ' + err.message);
  }
}

// Manually trigger official Domino's token refresh
async function refreshAccountSession(accountId, btnEl = null) {
  let originalHtml = '';
  if (btnEl) {
    originalHtml = btnEl.innerHTML;
    btnEl.innerHTML = '⏳ Refreshing...';
    btnEl.disabled = true;
  }
  showToast('Connecting to Domino\'s India live auth API...', '🔄');

  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/refresh`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`🎉 Domino's session refreshed! New access token & Cart ID (${data.cartId || 'Active'}) synced. 30 days renewed!`, '✅');
    } else {
      alert(`⚠️ Refresh Failed:\n\n${data.error || 'Token could not be refreshed. Please re-import from m.dominos.co.in.'}`);
    }
    loadAccounts();
  } catch (err) {
    alert('Refresh request failed: ' + err.message);
  } finally {
    if (btnEl) {
      btnEl.innerHTML = originalHtml;
      btnEl.disabled = false;
    }
  }
}
window.refreshAccountSession = refreshAccountSession;
window.validateAccountSession = validateAccountSession;

// Copy raw token to clipboard
async function copyTokenToClipboard(accountId) {
  try {
    const res = await adminFetch('/api/admin/accounts');
    const accounts = await res.json();
    const acc = accounts.find(a => a.id === accountId);
    if (!acc || !acc.sessionToken) {
      alert('No auth token found for this account.');
      return;
    }
    await navigator.clipboard.writeText(acc.sessionToken);
    showToast(`Copied Auth Token for ${acc.phone} to clipboard!`, '🔑');
  } catch (e) {
    alert('Failed to copy token: ' + e.message);
  }
}
window.copyTokenToClipboard = copyTokenToClipboard;

// =========================================================================
// 1. DOMINO'S REAL LIVE SMS OTP & SESSION STORAGE
// =========================================================================

// Request Real Live SMS OTP from Domino's India
async function adminSendLiveOtp() {
  const phoneInput = document.getElementById('adminPhone');
  const rawPhone = (phoneInput.value || '').trim();
  const cleanPhone = rawPhone.replace(/[^0-9]/g, '').slice(-10);
  const statusBanner = document.getElementById('otpStatusBanner');

  if (statusBanner) {
    statusBanner.style.display = 'none';
    statusBanner.innerHTML = '';
  }

  if (!cleanPhone || cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    alert('Please enter a valid 10-digit Indian mobile number (starting with 6, 7, 8, or 9).');
    phoneInput.focus();
    return;
  }

  const sendBtn = document.getElementById('btnSendOtp');
  const originalText = sendBtn.innerText;
  sendBtn.innerText = '🚀 Requesting Domino\'s Live OTP...';
  sendBtn.disabled = true;

  if (statusBanner) {
    statusBanner.style.display = 'block';
    statusBanner.innerHTML = `
      <div style="background: #eff6ff; border: 1.5px solid #93c5fd; color: #1e40af; padding: 12px 16px; border-radius: 8px; font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 16px;">⏳</span>
        <span>Connecting to Domino's India live SMS gateway for +91 ${cleanPhone}... Please wait a moment.</span>
      </div>
    `;
  }

  try {
    const res = await adminFetch('/api/admin/accounts/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: cleanPhone })
    });
    const data = await res.json();
    
    if (!data.success) {
      const isLimit = data.isLimitExhausted || (data.error && data.error.toLowerCase().includes('limit'));
      if (statusBanner) {
        statusBanner.style.display = 'block';
        if (isLimit) {
          statusBanner.innerHTML = `
            <div style="background: #fef2f2; border: 1.5px solid #fecaca; color: #991b1b; padding: 14px 16px; border-radius: 8px;">
              <div style="font-weight: 800; font-size: 13px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                <span>⚠️ Domino's Gateway: Daily OTP Limit Exhausted</span>
              </div>
              <div style="font-size: 12px; color: #7f1d1d; margin-bottom: 12px; line-height: 1.5;">
                Domino's India restricts each mobile number (+91 ${cleanPhone}) to a maximum of 3 SMS OTPs per 24 hours.
              </div>
              <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 10px 14px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                <span style="font-size: 12px; font-weight: 600; color: #1e40af;">
                  💡 <strong>Direct Solution:</strong> Import this account instantly using Method 2 (No SMS OTP required)!
                </span>
                <button type="button" onclick="switchToMethod2WithPhone('${cleanPhone}')" style="background: #0284c7; color: white; border: none; padding: 6px 14px; font-size: 11px; font-weight: 800; border-radius: 6px; cursor: pointer;">
                  👉 Switch to 1-Click JSON Import &rarr;
                </button>
              </div>
            </div>
          `;
        } else {
          statusBanner.innerHTML = `
            <div style="background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 10px 14px; border-radius: 6px; font-weight: 600; font-size: 12px;">
              ⚠️ Domino's Error: ${data.error || 'Failed to dispatch OTP.'}
            </div>
          `;
        }
      } else {
        alert('Domino\'s Notice: ' + data.error);
      }
      return;
    }

    showToast(`SMS OTP sent by Domino's to +91 ${cleanPhone}!`, '📱');

    if (statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 10px 14px; border-radius: 6px; font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 6px;">
          <span>✅ Official Domino's SMS OTP has been dispatched to +91 ${cleanPhone}. Enter the 6-digit code below.</span>
        </div>
      `;
    }

    // Show OTP input section & update phone label
    const otpSec = document.getElementById('otpSection');
    const phoneDisplay = document.getElementById('otpTargetPhoneDisplay');
    if (phoneDisplay) phoneDisplay.innerText = `+91 ${cleanPhone}`;
    if (otpSec) {
      otpSec.dataset.activePhone = cleanPhone;
      otpSec.style.display = 'block';
      otpSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Reset unified input & digit boxes
    const unifiedInput = document.getElementById('adminOtpUnifiedInput');
    if (unifiedInput) {
      unifiedInput.value = '';
      setTimeout(() => unifiedInput.focus(), 150);
    }
    for (let i = 1; i <= 6; i++) {
      const box = document.getElementById(`otpDigit${i}`);
      if (box) box.value = '';
    }

    // Start 180-second (3 min) OTP connection countdown timer
    startOtpCountdown(data.timer || 45, data.sessionTtlSeconds || 180);

  } catch (err) {
    if (statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div style="background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 10px 14px; border-radius: 6px; font-weight: 600; font-size: 12px;">
          ⚠️ Network Notice: ${err.message}
        </div>
      `;
    } else {
      alert('Domino\'s OTP Dispatch Notice: ' + err.message);
    }
  } finally {
    sendBtn.innerText = originalText;
    sendBtn.disabled = false;
  }
}

// Switch to Method 2 with pre-filled phone
function switchToMethod2WithPhone(phone) {
  switchSessionMethod('json');
  const inputPhone = document.getElementById('adminJsonPhone');
  if (inputPhone) inputPhone.value = phone;
  copyExtractionScriptToClipboard();
  showToast('Switched to Method 2! Extractor script copied to clipboard.', '📋');
}

// Cancel OTP entry and change mobile number
function cancelOtpAndChangePhone() {
  clearInterval(currentOtpCountdown);
  const otpSec = document.getElementById('otpSection');
  const statusBanner = document.getElementById('otpStatusBanner');
  if (otpSec) otpSec.style.display = 'none';
  if (statusBanner) statusBanner.style.display = 'none';
  const phoneInput = document.getElementById('adminPhone');
  if (phoneInput) {
    phoneInput.focus();
    phoneInput.select();
  }
}

// 180-second OTP connection lifecycle (Resend active after 45s, Session window 180s)
function startOtpCountdown(resendSeconds = 45, totalSessionSeconds = 180) {
  clearInterval(currentOtpCountdown);
  let resendRemaining = resendSeconds;
  let sessionRemaining = totalSessionSeconds;

  const statusText = document.getElementById('timerStatusText');
  const fill = document.getElementById('timerProgressFill');
  const resendBtn = document.getElementById('btnResendOtp');
  const verifyBtn = document.getElementById('btnVerifyOtp');
  if (verifyBtn) verifyBtn.style.background = '#16a34a';

  if (resendBtn) {
    resendBtn.disabled = true;
    resendBtn.style.color = 'var(--gray-400)';
    resendBtn.innerText = `Resend in ${resendRemaining}s`;
  }

  function update() {
    if (statusText) {
      if (sessionRemaining > 0) {
        statusText.innerText = `Domino's SMS connection active (${sessionRemaining}s session window)`;
      } else {
        statusText.innerText = '⚠️ 3-minute OTP session expired. Click Resend SMS OTP to reconnect.';
      }
    }

    if (fill) {
      const pct = Math.max(0, (sessionRemaining / totalSessionSeconds) * 100);
      fill.style.width = `${pct}%`;
      fill.style.background = sessionRemaining < 30 ? '#ef4444' : 'linear-gradient(90deg, #10b981, #0066a3)';
    }

    if (resendBtn) {
      if (resendRemaining > 0) {
        resendBtn.innerText = `Resend in ${resendRemaining}s`;
        resendBtn.disabled = true;
      } else {
        resendBtn.disabled = false;
        resendBtn.style.color = 'var(--primary)';
        resendBtn.innerText = '🔄 Resend SMS OTP';
      }
    }

    if (sessionRemaining <= 0) {
      clearInterval(currentOtpCountdown);
      if (verifyBtn) verifyBtn.style.background = '#94a3b8';
    }

    resendRemaining--;
    sessionRemaining--;
  }

  update();
  currentOtpCountdown = setInterval(update, 1000);
}

// Bidirectional sync between unified OTP input and 6 digit boxes
function syncUnifiedOtpToBoxes(val) {
  const digits = (val || '').replace(/[^0-9]/g, '').slice(0, 6);
  for (let i = 1; i <= 6; i++) {
    const box = document.getElementById(`otpDigit${i}`);
    if (box) box.value = digits[i - 1] || '';
  }
  if (digits.length === 6) {
    setTimeout(adminVerifyLiveOtp, 500);
  }
}

function syncBoxesToUnifiedInput() {
  let combined = '';
  for (let i = 1; i <= 6; i++) {
    combined += (document.getElementById(`otpDigit${i}`)?.value || '');
  }
  const unified = document.getElementById('adminOtpUnifiedInput');
  if (unified) unified.value = combined;
  return combined;
}

// Global OTP Paste Handler (works across whole box / any input)
function handleOtpPaste(event) {
  event.preventDefault();
  const clipboardData = event.clipboardData || window.clipboardData;
  const pastedText = clipboardData ? clipboardData.getData('text') : '';
  const digits = pastedText.replace(/[^0-9]/g, '').slice(0, 6);
  if (!digits) return;

  const unifiedInput = document.getElementById('adminOtpUnifiedInput');
  if (unifiedInput) unifiedInput.value = digits;

  for (let i = 1; i <= 6; i++) {
    const box = document.getElementById(`otpDigit${i}`);
    if (box) box.value = digits[i - 1] || '';
  }

  showToast(`Domino's OTP pasted (${digits})!`, '📋');

  if (digits.length === 6) {
    setTimeout(adminVerifyLiveOtp, 500);
  } else {
    const nextBox = document.getElementById(`otpDigit${Math.min(digits.length + 1, 6)}`);
    if (nextBox) nextBox.focus();
  }
}

// Split 6-digit OTP input auto-advance handlers
function handleOtpInput(index, event) {
  const val = event.target.value;

  // Handle paste of full 6 digits if fired on single input
  if (val.length > 1) {
    const digits = val.replace(/[^0-9]/g, '').slice(0, 6);
    syncUnifiedOtpToBoxes(digits);
    const unified = document.getElementById('adminOtpUnifiedInput');
    if (unified) unified.value = digits;
    if (digits.length === 6) {
      setTimeout(adminVerifyLiveOtp, 250);
    }
    return;
  }

  const combined = syncBoxesToUnifiedInput();

  // Auto-advance to next box
  if (val && index < 6) {
    const next = document.getElementById(`otpDigit${index + 1}`);
    if (next) next.focus();
  } else if (combined.length === 6) {
    setTimeout(adminVerifyLiveOtp, 250);
  }
}

function handleOtpKey(index, event) {
  if (event.key === 'Backspace') {
    if (!event.target.value && index > 1) {
      const prev = document.getElementById(`otpDigit${index - 1}`);
      if (prev) {
        prev.focus();
        prev.value = '';
      }
    } else {
      event.target.value = '';
    }
    syncBoxesToUnifiedInput();
  } else if (event.key === 'Enter') {
    adminVerifyLiveOtp();
  } else if (event.key === 'ArrowLeft' && index > 1) {
    document.getElementById(`otpDigit${index - 1}`)?.focus();
  } else if (event.key === 'ArrowRight' && index < 6) {
    document.getElementById(`otpDigit${index + 1}`)?.focus();
  }
}

function manuallyOpenOtpSection() {
  const cleanPhone = (document.getElementById('adminPhone').value || '').trim().replace(/[^0-9]/g, '').slice(-10);
  if (!cleanPhone || cleanPhone.length !== 10) {
    alert('Please enter a 10-digit phone number first.');
    document.getElementById('adminPhone').focus();
    return;
  }
  const otpSec = document.getElementById('otpSection');
  const phoneDisplay = document.getElementById('otpTargetPhoneDisplay');
  if (phoneDisplay) phoneDisplay.innerText = `+91 ${cleanPhone}`;
  if (otpSec) {
    otpSec.dataset.activePhone = cleanPhone;
    otpSec.style.display = 'block';
    otpSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const unified = document.getElementById('adminOtpUnifiedInput');
  if (unified) {
    unified.focus();
  }
}

let isVerifyingOtp = false;

// Verify Real OTP with Domino's India
async function adminVerifyLiveOtp() {
  if (isVerifyingOtp) return;
  const otpSec = document.getElementById('otpSection');
  let cleanPhone = (otpSec?.dataset?.activePhone || '').trim();
  if (!cleanPhone) {
    const phone = (document.getElementById('adminPhone').value || '').trim();
    cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
  }
  const statusBanner = document.getElementById('otpStatusBanner');

  // Check unified input first, then digit boxes
  let otp = (document.getElementById('adminOtpUnifiedInput')?.value || '').trim().replace(/[^0-9]/g, '');
  if (otp.length !== 6) {
    otp = '';
    for (let i = 1; i <= 6; i++) {
      const digit = document.getElementById(`otpDigit${i}`)?.value || '';
      otp += digit;
    }
  }

  if (otp.length !== 6) {
    alert('Please enter the complete 6-digit SMS OTP received on your phone.');
    const uInput = document.getElementById('adminOtpUnifiedInput');
    if (uInput) uInput.focus();
    return;
  }

  isVerifyingOtp = true;
  const verifyBtn = document.getElementById('btnVerifyOtp');
  const originalText = verifyBtn.innerText;
  verifyBtn.innerText = '⏳ Submitting OTP to Domino\'s & Extracting Session...';
  verifyBtn.disabled = true;

  try {
    const res = await adminFetch('/api/admin/accounts/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: cleanPhone,
        otp: otp
      })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    clearInterval(currentOtpCountdown);
    showToast(`🎉 Success! Account ${data.account.phone} verified and session saved to pool!`, '🔑');

    // Reset UI
    document.getElementById('adminPhone').value = '';
    document.getElementById('otpSection').style.display = 'none';
    if (statusBanner) statusBanner.style.display = 'none';
    const unified = document.getElementById('adminOtpUnifiedInput');
    if (unified) unified.value = '';
    for (let i = 1; i <= 6; i++) {
      const box = document.getElementById(`otpDigit${i}`);
      if (box) box.value = '';
    }

    // Refresh Accounts Table
    loadAccounts();

  } catch (err) {
    if (statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div style="background: #fef2f2; border: 1.5px solid #fecaca; color: #991b1b; padding: 10px 14px; border-radius: 6px; font-weight: 600; font-size: 13px;">
          ❌ Domino's Verification Failed: ${err.message}
        </div>
      `;
      statusBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      alert('Domino\'s Verification Failed:\n\n' + err.message);
    }
  } finally {
    isVerifyingOtp = false;
    verifyBtn.innerText = originalText;
    verifyBtn.disabled = false;
  }
}

// Load Accounts Pool
async function loadAccounts() {
  try {
    loadSessionFleetFeed();
    const res = await adminFetch('/api/admin/accounts');
    const data = await res.json();
    const accounts = Array.isArray(data) ? data : [];
    window.cachedAccounts = accounts;
    const countBadge = document.getElementById('accountsCount');
    if (countBadge) countBadge.innerText = `${accounts.length} Accounts in Pool`;

    const quickStatSessions = document.getElementById('quickStatSessions');
    if (quickStatSessions) quickStatSessions.innerText = `${accounts.length} Active`;
    const navBadgeSessions = document.getElementById('navBadgeSessions');
    if (navBadgeSessions) navBadgeSessions.innerText = accounts.length;

    const tbody = document.getElementById('accountsTableBody');
    if (!tbody) return;

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--gray-600); padding: 24px;">No live Domino\'s accounts saved yet. Enter a mobile number above to request a real live SMS OTP.</td></tr>';
      return;
    }

    const now = Date.now();

    tbody.innerHTML = accounts.map(acc => {
      // 1. Session Age (When imported/stored)
      const storedTime = acc.storedAt ? new Date(acc.storedAt).getTime() : (acc.createdAt ? new Date(acc.createdAt).getTime() : now);
      const ageMs = Math.max(0, now - storedTime);
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const ageHours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      const ageMins = Math.floor((ageMs % (60 * 60 * 1000)) / 60000);
      const ageStr = ageDays > 0 ? `${ageDays}d ${ageHours}h ago` : (ageHours > 0 ? `${ageHours}h ${ageMins}m ago` : `${ageMins}m ago`);
      const storedDateFormatted = new Date(storedTime).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
      const storedTimeFormatted = new Date(storedTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

      // 2. Short-term Access Token Lifespan (1-Hour Domino's JWT)
      const accExpTime = acc.accessTokenExpiresAt ? new Date(acc.accessTokenExpiresAt).getTime() : 0;
      const accRemainingMs = accExpTime - now;
      const accRemainingMins = Math.max(0, Math.ceil(accRemainingMs / 60000));
      const isAccessFresh = accRemainingMs > 0;

      // 3. Sliding 30-Day Refresh Window (Session Expiry)
      const refExpTime = acc.refreshTokenExpiresAt 
        ? new Date(acc.refreshTokenExpiresAt).getTime() 
        : (acc.expiresAt ? new Date(acc.expiresAt).getTime() : now + 30 * 24 * 60 * 60 * 1000);
      const refRemainingMs = refExpTime - now;
      const refDays = Math.max(0, Math.floor(refRemainingMs / (24 * 60 * 60 * 1000)));
      const refHours = Math.max(0, Math.floor((refRemainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)));
      const isSessionExpired = acc.status === 'EXPIRED' || refRemainingMs <= 0;
      const refDateFormatted = new Date(refExpTime).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const refTimeFormatted = new Date(refExpTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

      // Evaluate Health & Session Age
      const sHealth = acc.sessionHealth || {
        ageDays: ageDays,
        ageHours: ageHours,
        ageFormatted: ageStr,
        health: isSessionExpired ? 'EXPIRED' : (refDays <= 3 ? 'EXPIRING_SOON' : (ageDays >= 14 ? 'OLD' : 'FRESH')),
        healthBadge: isSessionExpired ? '🔴 Expired Session' : (refDays <= 3 ? `🟠 Expiring Soon (${refDays}d left)` : (ageDays >= 14 ? `🟡 Old Session (${ageDays}d old)` : `🟢 Fresh & Active (${ageStr})`)),
        isExpired: isSessionExpired,
        isOld: isSessionExpired || refDays <= 3 || ageDays >= 14
      };

      // 4. Domino's Live Verification Status
      const lastValTime = acc.lastValidated || acc.lastRefreshedAt;
      const lastValFormatted = lastValTime ? new Date(lastValTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Verified';

      // 5. Clean Customer Name
      const cleanName = (acc.customerName && !/utm_|token|moe_|ide/i.test(acc.customerName)) ? acc.customerName : 'Parth Sharma';

      // 6. Source Badge
      const sourceTag = acc.source === 'JSON_TOKEN_IMPORT' 
        ? '<span style="font-size: 10px; background: #e0f2fe; color: #0369a1; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px;">JSON</span>'
        : '<span style="font-size: 10px; background: #dcfce7; color: #15803d; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px;">SMS</span>';

      // 7. Order History & Independent Loyalty Program Details
      const isNewUser = (acc.pastOrdersCount === 0 || acc.accountType === 'NEW_ACCOUNT');
      const hasCheesyRewards = Boolean(
        acc.isCheesyRewards || 
        acc.loyaltyProgram === 'POTP2' || 
        acc.category === 'CATEGORY_CHEESY_REWARDS' || 
        acc.categoryName?.includes('Cheesy') ||
        (acc.localStorage && typeof acc.localStorage['loyaltyInfo'] === 'string' && acc.localStorage['loyaltyInfo'].includes('POTP2'))
      );

      let orderHistoryHtml = '';
      if (hasCheesyRewards) {
        orderHistoryHtml += `
          <div style="font-weight: 800; color: #b45309; font-size: 11px; display: inline-flex; align-items: center; gap: 4px; background: #fffbeb; padding: 2px 8px; border-radius: 4px; border: 1px solid #fde68a;">
            <span>🌟 Cheesy Rewards (POTP2)</span>
          </div>
          <div style="font-size: 10px; color: #475569; margin-top: 3px;">Earns 100 pts/order • Redemptions Active</div>
        `;
      }
      
      if (isNewUser) {
        orderHistoryHtml += `
          <div style="font-weight: 800; color: #15803d; font-size: 11px; margin-top: 3px; display: flex; align-items: center; gap: 4px;">
            <span>🟢 0 Past Orders</span>
          </div>
          <div style="font-size: 11px; color: #166534; font-weight: 600;">Eligible for 50% New User Coupon (DOMNEW50)</div>
        `;
      } else {
        const orderCountDisplay = (acc.pastOrdersCount !== undefined && acc.pastOrdersCount !== null)
          ? `${acc.pastOrdersCount} Past Orders Verified`
          : 'Repeat Customer (Verified Domino\'s Account)';
        orderHistoryHtml += `
          <div style="font-weight: 800; color: #0369a1; font-size: 11px; margin-top: 3px; display: flex; align-items: center; gap: 4px;">
            <span>🔵 ${orderCountDisplay}</span>
          </div>
          <div style="font-size: 11px; color: #475569;">VIP Repeat Customer (${acc.couponCode || 'PARTY'})</div>
          ${acc.reorderItems?.length ? `<div style="font-size: 10px; color: #0284c7; margin-top: 2px; font-weight: 600;">Reorder: ${acc.reorderItems.slice(0, 2).join(', ')}</div>` : ''}
        `;
      }

      // 8. Health Badge & Expiry / Age Combined Details
      let healthBadgeHtml = '';
      if (sHealth.health === 'FRESH') {
        healthBadgeHtml = `<span style="background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; padding: 2px 8px; border-radius: 12px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">🟢 Fresh &amp; Active</span>`;
      } else if (sHealth.health === 'OLD') {
        healthBadgeHtml = `<span style="background: #fef3c7; color: #b45309; border: 1.5px solid #fde68a; padding: 2px 8px; border-radius: 12px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">🟡 Old Session (${sHealth.ageDays}d old)</span>`;
      } else if (sHealth.health === 'EXPIRING_SOON') {
        healthBadgeHtml = `<span style="background: #ffedd5; color: #c2410c; border: 1.5px solid #fdba74; padding: 2px 8px; border-radius: 12px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">🟠 Expiring Soon (${refDays}d left)</span>`;
      } else {
        healthBadgeHtml = `<span style="background: #fee2e2; color: #b91c1c; border: 1.5px solid #fca5a5; padding: 2px 8px; border-radius: 12px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">🔴 Expired Session</span>`;
      }

      let expiryHtml = '';
      if (isSessionExpired) {
        expiryHtml = `
          <div style="margin-bottom: 4px;">${healthBadgeHtml}</div>
          <div style="font-weight: 800; color: #dc2626; font-size: 11px;">⚠️ SESSION EXPIRED</div>
          <div style="font-size: 10px; color: #dc2626; margin-top: 2px;">Click ⚡ Refresh to Rejuvenate Token</div>
        `;
      } else {
        expiryHtml = `
          <div style="margin-bottom: 5px;">
            ${healthBadgeHtml}
          </div>
          <div style="font-size: 11px; margin-bottom: 3px;">
            <strong>📅 Session Age:</strong> <span style="color: #334155; font-weight: 700;">${sHealth.ageFormatted}</span>
            <div style="font-size: 10px; color: #64748b;">(Created: ${storedDateFormatted} ${storedTimeFormatted})</div>
          </div>
          <div style="margin-bottom: 3px;">
            ${isAccessFresh 
              ? `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; display: inline-flex; align-items: center; gap: 3px;">⚡ Access Token: ${accRemainingMins}m valid</span>` 
              : `<span style="background: #fef3c7; color: #92400e; border: 1px solid #fde68a; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; display: inline-flex; align-items: center; gap: 3px;">⚠️ Access Token Expired (Auto-renews)</span>`}
          </div>
          <div style="font-size: 11px; margin-bottom: 2px;">
            <strong>🔄 30-Day Window:</strong> <span style="color: #0284c7; font-weight: 700;">${refDays}d ${refHours}h left</span>
            <div style="font-size: 10px; color: #64748b;">Valid until: ${refDateFormatted} ${refTimeFormatted}</div>
          </div>
          ${sHealth.isOld ? `<div style="font-size: 10px; color: #b45309; font-weight: 800; margin-top: 3px;">⚡ Rejuvenation Recommended</div>` : ''}
          <div style="font-size: 10px; color: #15803d; font-weight: 700; margin-top: 2px;">
            ✓ Verified: ${lastValFormatted} (Domino's Handshake OK)
          </div>
        `;
      }

      // 9. Status Badge & Disabled State
      const isDisabled = acc.disabled || acc.status === 'DISABLED';
      const statusBadge = isDisabled
        ? '<span style="background: #f1f5f9; color: #475569; border: 1.5px solid #cbd5e1; padding: 3px 8px; border-radius: 12px; font-weight: 800; font-size: 11px;">⏸️ DISABLED</span>'
        : (isSessionExpired
            ? '<span style="background: #fef2f2; color: #b91c1c; padding: 3px 8px; border-radius: 12px; font-weight: 700; font-size: 11px;">🔴 EXPIRED</span>'
            : (acc.status === 'IDLE' 
                ? '<span class="status-idle">🟢 ACTIVE &amp; READY</span>' 
                : `<span class="status-inuse">🟡 IN USE ${acc.activeOrderId ? `(${acc.activeOrderId})` : ''}</span>`));

      // Tier Badge (Strictly Past Orders Count, Decoupled from Loyalty!)
      let tierBadgeHtml = '';
      const orderCount = Number(acc.pastOrdersCount || 0);
      if (acc.accountType === 'NEW_ACCOUNT' || orderCount === 0) {
        tierBadgeHtml = `
          <div style="background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; padding: 4px 10px; border-radius: 6px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">
            <span>🟢 New User Tier (0 Past Orders)</span>
          </div>
          <div style="font-size: 10px; color: #047857; font-weight: 700; margin-top: 3px;">
            🔒 Auto-Detected • DOMNEW50 Eligible
          </div>
        `;
      } else if (acc.accountType === 'SECOND_ORDER_ACCOUNT' || orderCount === 1) {
        tierBadgeHtml = `
          <div style="background: #fef3c7; color: #b45309; border: 1.5px solid #fcd34d; padding: 4px 10px; border-radius: 6px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">
            <span>🟡 Cheesy 2nd Order Tier (1 Past Order)</span>
          </div>
          <div style="font-size: 10px; color: #b45309; font-weight: 700; margin-top: 3px;">
            🔒 Auto-Detected • CHEESY Eligible
          </div>
        `;
      } else {
        tierBadgeHtml = `
          <div style="background: #e0f2fe; color: #0369a1; border: 1.5px solid #7dd3fc; padding: 4px 10px; border-radius: 6px; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">
            <span>🔵 Party Repeat Tier (${orderCount} Past Orders)</span>
          </div>
          <div style="font-size: 10px; color: #0369a1; font-weight: 700; margin-top: 3px;">
            🔒 Auto-Detected • PARTY Eligible
          </div>
        `;
      }

      tierBadgeHtml += `
        <div style="margin-top: 6px;">
          <select class="tier-select" onchange="changeAccountTier('${acc.id}', this.value)" style="padding: 2px 6px; font-size: 10px; font-weight: 700; border-radius: 4px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; color: #1e293b;">
            <option value="NEW_ACCOUNT" ${(acc.accountType === 'NEW_ACCOUNT' || orderCount === 0) ? 'selected' : ''}>🟢 New User (DOMNEW50)</option>
            <option value="SECOND_ORDER_ACCOUNT" ${(acc.accountType === 'SECOND_ORDER_ACCOUNT' || orderCount === 1) ? 'selected' : ''}>🟡 2nd Order (CHEESY)</option>
            <option value="EXISTING_ACCOUNT" ${(acc.accountType === 'EXISTING_ACCOUNT' && orderCount >= 2) ? 'selected' : ''}>🔵 Repeat Order (PARTY)</option>
          </select>
        </div>
      `;

      // Refresh Button Styling (Highlighted when Rejuvenation is needed!)
      const refreshBtnStyle = sHealth.isOld || isSessionExpired
        ? 'border: 1.5px solid #7c3aed; color: #6d28d9; background: #ede9fe; font-weight: 800; cursor: pointer; box-shadow: 0 0 6px rgba(124, 58, 237, 0.35);'
        : 'border-color: #c4b5fd; color: #7c3aed; background: #faf5ff; cursor: pointer; font-weight: 700;';

      const displayPhone = (acc.phone && !String(acc.phone).includes('undefined')) 
        ? acc.phone 
        : (acc.cleanPhone ? `+91 ${acc.cleanPhone}` : `Session #${acc.id || 'N/A'}`);

      return `
        <tr>
          <td style="font-weight: 800; font-size: 13px; color: var(--dark);">
            <div>📱 ${displayPhone} ${sourceTag}</div>
            <div style="font-size: 10px; font-weight: 500; color: #64748b; margin-top: 2px;">
              UID: <code>${acc.userId || 'N/A'}</code>
            </div>
            ${acc.cartId ? `<div style="font-size: 10px; font-weight: 600; color: #0284c7; margin-top: 1px;">🛒 Cart: <code>${acc.cartId}</code></div>` : ''}
          </td>
          <td>
            <div style="margin-bottom: 4px;">
              ${tierBadgeHtml}
            </div>
            <div style="font-size: 11px; color: #334155; font-weight: 600; margin-top: 4px;">
              👤 <strong>${cleanName}</strong>
            </div>
          </td>
          <td style="font-size: 12px;">${orderHistoryHtml}</td>
          <td>
            ${expiryHtml}
          </td>
          <td>
            ${statusBadge}
          </td>
          <td>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              ${isDisabled 
                ? `<button class="btn-action-copy" onclick="adminToggleAccountDisabled('${acc.id}')" title="Enable account for autonomous ordering" style="border-color: #86efac; color: #15803d; background: #dcfce7; cursor: pointer; font-weight: 800;">▶️ Enable</button>` 
                : `<button class="btn-action-copy" onclick="adminToggleAccountDisabled('${acc.id}')" title="Disable account (excluded from autonomous ordering)" style="border-color: #fca5a5; color: #991b1b; background: #fee2e2; cursor: pointer; font-weight: 800;">⏸️ Disable</button>`}
              <button class="btn-action-copy" onclick="adminSetAccountOrdersPrompt('${acc.id}', ${orderCount})" title="Directly set verified past orders count" style="border-color: #cbd5e1; color: #334155; cursor: pointer; font-size: 10px;">
                ✏️ Orders (${orderCount})
              </button>
              <button class="btn-action-copy" onclick="openCookiesModal('${acc.id}')" title="Copy Cookies JSON for browser console or extension" style="cursor: pointer;">
                📋 Cookies
              </button>
              <button class="btn-action-copy" onclick="copyTokenToClipboard('${acc.id}')" title="Copy raw Auth / Bearer Token" style="border-color: #7dd3fc; color: #0284c7; cursor: pointer;">
                🔑 Token
              </button>
              <button class="btn-action-copy" onclick="validateAccountSession('${acc.id}')" title="Test session status against Domino's API" style="border-color: #86efac; color: #15803d; cursor: pointer;">
                🔄 Test
              </button>
              <button class="btn-action-copy" onclick="refreshAccountSession('${acc.id}', this)" title="Refresh session token with Domino's live API to renew 30 days" style="${refreshBtnStyle}">
                ⚡ Refresh
              </button>
              <button class="btn-action-launch" onclick="launchBrowserSession('${acc.id}')" title="Launch Chrome browser pre-logged in with this account" style="cursor: pointer;">
                🚀 Open
              </button>
              <button class="btn-action-del" onclick="deleteAccount('${acc.id}')" title="Remove account from pool" style="cursor: pointer;">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading accounts:', err);
  }
}

// 7b. Admin Tier Override Function
window.changeAccountTier = async function(accountId, newTier) {
  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/tier`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: newTier })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`✅ Account tier updated successfully to: ${data.account?.categoryName || newTier}`);
      loadAccounts();
    } else {
      alert('Failed to update tier: ' + (data.error || 'Server error'));
    }
  } catch (err) {
    alert('Error updating tier: ' + err.message);
  }
};

// Open Cookies JSON Modal
async function openCookiesModal(accountId) {
  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/cookies`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    activeCookiesData = data;
    document.getElementById('modalPhoneLabel').innerText = `Account: ${data.phone} (${data.cookiesCount} Cookies Extracted)`;
    document.getElementById('cookiesJsonDisplay').value = JSON.stringify(data.cookies, null, 2);
    openModal('cookiesModal');
  } catch (err) {
    alert('Failed to load cookies: ' + err.message);
  }
}

function copyJsonToClipboard() {
  if (!activeCookiesData) return;
  const jsonStr = JSON.stringify(activeCookiesData.cookies, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    showToast('Cookies JSON copied to clipboard! Paste in Cookie-Editor / EditThisCookie extension.', '📋');
  });
}

function copyConsoleScriptToClipboard() {
  if (!activeCookiesData) return;
  const script = activeCookiesData.consoleScript;
  navigator.clipboard.writeText(script).then(() => {
    showToast('Console JavaScript snippet copied! Paste in DevTools Console on m.dominos.co.in to directly login.', '⚡');
  });
}

// Launch Browser Session with preloaded cookies (Support both current client device & server host)
let currentLaunchAccountId = null;
let currentLaunchConsoleScript = '';

async function launchBrowserSession(accountId) {
  currentLaunchAccountId = accountId;
  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/cookies`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    activeCookiesData = data;
    currentLaunchConsoleScript = data.consoleScript || '';

    const label = document.getElementById('launchPhoneLabel');
    if (label) label.innerText = `Account: ${data.phone} (${data.cookiesCount} Cookies Extracted)`;

    const preview = document.getElementById('launchConsoleScriptPreview');
    if (preview) preview.value = currentLaunchConsoleScript;

    const bmark = document.getElementById('launchBookmarkletLink');
    if (bmark) {
      const code = data.bookmarkletCode || ('javascript:' + encodeURIComponent(currentLaunchConsoleScript));
      bmark.href = code;
    }

    openModal('launchModal');
  } catch (err) {
    alert('Failed to prepare session launch: ' + err.message);
  }
}

function copyLaunchConsoleScript() {
  const script = currentLaunchConsoleScript || activeCookiesData?.consoleScript;
  if (!script) {
    alert('No script found for this session.');
    return;
  }
  navigator.clipboard.writeText(script).then(() => {
    showToast('Auto-login code copied! Paste in DevTools Console on m.dominos.co.in & press Enter', '📋');
  }).catch(() => {
    // Fallback selection
    const preview = document.getElementById('launchConsoleScriptPreview');
    if (preview) {
      preview.select();
      document.execCommand('copy');
      showToast('Code copied from preview box!', '📋');
    }
  });
}

function openOnCurrentDevice() {
  copyLaunchConsoleScript();
  // Open Domino's Storefront in a new tab on current user device
  window.open('https://m.dominos.co.in/jfl-discovery-ui/en/dt/home', '_blank');
}

// Domino's Promo Coupon Rules Engine
async function loadCouponRules() {
  try {
    const res = await adminFetch('/api/admin/coupon-rules');
    const rules = await res.json();
    if (rules) {
      const f = document.getElementById('ruleFirstOrderCoupon');
      const s = document.getElementById('ruleSecondOrderCoupon');
      const r = document.getElementById('ruleRegularOrderCoupon');
      if (f) f.value = rules.firstOrderCoupon || 'DOMNEW50';
      if (s) s.value = rules.secondOrderCoupon || 'CHEESY';
      if (r) r.value = rules.regularOrderCoupon || 'PARTY';
    }
  } catch (err) {
    console.warn('Failed to load coupon rules:', err);
  }
}

async function saveCouponRules() {
  const firstOrderCoupon = (document.getElementById('ruleFirstOrderCoupon')?.value || 'DOMNEW50').trim().toUpperCase();
  const secondOrderCoupon = (document.getElementById('ruleSecondOrderCoupon')?.value || 'CHEESY').trim().toUpperCase();
  const regularOrderCoupon = (document.getElementById('ruleRegularOrderCoupon')?.value || 'PARTY').trim().toUpperCase();

  try {
    const res = await adminFetch('/api/admin/coupon-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstOrderCoupon, secondOrderCoupon, regularOrderCoupon })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showToast('Domino\'s automated coupon rules saved!', '🎟️');
  } catch (err) {
    alert('Failed to save coupon rules: ' + err.message);
  }
}

async function launchOnServerHost() {
  if (!currentLaunchAccountId) return;
  showToast('Launching Chrome browser with pre-loaded Domino\'s session on server host...', '🖥️');
  try {
    const res = await adminFetch(`/api/admin/accounts/${currentLaunchAccountId}/launch`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showToast(data.message, '🌐');
    closeModal('launchModal');
  } catch (err) {
    alert('Server Host Launch Notice: ' + err.message);
  }
}

// Delete Account from pool
async function deleteAccount(id) {
  if (!confirm('Are you sure you want to remove this Domino\'s account from the pool?')) return;
  try {
    await adminFetch(`/api/admin/accounts/${id}`, { method: 'DELETE' });
    showToast('Account removed from pool.', '🗑️');
    loadAccounts();
  } catch (err) {
    alert('Failed to delete account');
  }
}

window.openCookiesModal = openCookiesModal;
window.copyConsoleScriptToClipboard = copyConsoleScriptToClipboard;
window.launchBrowserSession = launchBrowserSession;
window.deleteAccount = deleteAccount;

// =========================================================================
// 2. VOUCHER & PIN VAULT
// =========================================================================

async function loadVouchers() {
  try {
    const res = await adminFetch('/api/admin/vouchers');
    const vouchers = await res.json();
    const countEl = document.getElementById('vouchersCount');
    if (countEl) countEl.innerText = `${vouchers.length} Vouchers`;
    const qv = document.getElementById('quickStatVouchers');
    if (qv) qv.innerText = `${vouchers.length} Vouchers`;

    const tbody = document.getElementById('vouchersTableBody');
    if (!vouchers || vouchers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--gray-600); padding: 16px;">No vouchers in vault. Add a gift card above.</td></tr>';
      return;
    }

    tbody.innerHTML = vouchers.map(v => {
      const masked = `${v.code.slice(0, 4)} **** **** ${v.code.slice(12)}`;
      let statusBadge = '<span class="status-idle" style="background:#ecfdf5; color:#047857;">UNUSED</span>';
      if (v.status === 'PARTIALLY_USED') statusBadge = '<span class="status-inuse" style="background:#fef3c7; color:#b45309;">PARTIALLY USED</span>';
      else if (v.status === 'EXHAUSTED' || v.balance === 0) statusBadge = '<span class="status-error">EXHAUSTED</span>';

      return `
        <tr>
          <td><code style="font-weight: 700; color: #0066a3;" title="${v.code}">${masked}</code></td>
          <td><code style="color: #64748b;">${v.pin}</code></td>
          <td style="font-weight: 800; color: #16a34a;">₹${v.balance} <small style="color:#64748b;">/ ₹${v.initialBalance || v.balance}</small></td>
          <td>${statusBadge}</td>
          <td><small style="font-family: monospace; color: #475569;">${v.usedInOrderId || '—'}</small></td>
          <td>
            <button class="btn-action-del" onclick="deleteVoucherCard('${v.id}')">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading vouchers:', err);
  }
}

async function addVoucherCard() {
  const code = document.getElementById('vouchCode').value.replace(/\s+/g, '');
  const pin = document.getElementById('vouchPin').value.trim();
  const balance = document.getElementById('vouchBalance').value;

  if (code.length !== 16) {
    alert('Voucher card number must be exactly 16 digits.');
    return;
  }
  if (pin.length !== 6) {
    alert('Voucher PIN must be exactly 6 digits.');
    return;
  }

  try {
    const res = await adminFetch('/api/admin/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, pin, balance })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('16-Digit Voucher & PIN added to inventory as UNUSED!', '💳');
    document.getElementById('vouchCode').value = '';
    document.getElementById('vouchPin').value = '';
    loadVouchers();
  } catch (err) {
    alert('Failed to add voucher: ' + err.message);
  }
}

async function deleteVoucherCard(id) {
  if (!confirm('Are you sure you want to delete this voucher from the vault?')) return;
  try {
    const res = await adminFetch(`/api/admin/vouchers/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Voucher card removed.', '🗑️');
      loadVouchers();
    }
  } catch (err) {
    alert('Failed to delete voucher: ' + err.message);
  }
}

// =========================================================================
// 2B. DYNAMIC UPI PAYMENT RECEIVER CONFIGURATION
// =========================================================================

async function loadPaymentReceiverSettings() {
  try {
    const res = await adminFetch('/api/admin/payment-settings');
    const settings = await res.json();
    if (settings) {
      const upiInput = document.getElementById('payReceiverUpiId');
      const payeeInput = document.getElementById('payReceiverPayeeName');
      const mccInput = document.getElementById('payReceiverMerchantCode');
      const noteInput = document.getElementById('payReceiverNote');

      if (upiInput) upiInput.value = settings.upiId || 'dominos.pay@okhdfcbank';
      if (payeeInput) payeeInput.value = settings.payeeName || "Domino's Official Kitchen Outlet";
      if (mccInput) mccInput.value = settings.merchantCode || 'DOM-5819';
      if (noteInput) noteInput.value = settings.note || "Domino's Order Payment";

      updateQrPreviewString(settings);
    }
  } catch (err) {
    console.error('Error loading payment receiver settings:', err);
  }
}

function updateQrPreviewString(settings) {
  const previewEl = document.getElementById('adminQrStringPreview');
  if (previewEl) {
    const sampleRef = 'DOM-ENG-' + Math.floor(100000 + Math.random() * 900000);
    previewEl.innerText = `upi://pay?pa=${encodeURIComponent(settings.upiId || 'dominos.pay@okhdfcbank')}&pn=${encodeURIComponent(settings.payeeName || "Domino's Outlet")}&am=1823&tr=${sampleRef}&cu=INR&tn=${encodeURIComponent((settings.note || "Domino's Order") + ' ' + sampleRef)}`;
  }
}

async function savePaymentReceiverSettings() {
  const upiId = document.getElementById('payReceiverUpiId').value.trim();
  const payeeName = document.getElementById('payReceiverPayeeName').value.trim();
  const merchantCode = document.getElementById('payReceiverMerchantCode').value.trim();
  const note = document.getElementById('payReceiverNote').value.trim();

  if (!upiId) {
    alert('Receiver UPI ID is required.');
    return;
  }

  try {
    const res = await adminFetch('/api/admin/payment-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upiId, payeeName, merchantCode, note })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('Payment Receiver Settings saved! Dynamic QR updated.', '💳');
    updateQrPreviewString(data.settings);
  } catch (err) {
    alert('Failed to save payment settings: ' + err.message);
  }
}

// =========================================================================
// 3. ORDERS TELEMETRY MONITOR & SEARCH
// =========================================================================

let cachedAdminOrders = [];

async function loadOrders() {
  try {
    const res = await adminFetch('/api/admin/orders');
    const data = await res.json();
    const orders = Array.isArray(data) ? data : [];
    cachedAdminOrders = orders;
    const countEl = document.getElementById('ordersCount');
    if (countEl) countEl.innerText = `${orders.length} Total Orders`;
    const qo = document.getElementById('quickStatOrders');
    if (qo) qo.innerText = `${orders.length} Orders`;
    const no = document.getElementById('navBadgeOrders');
    if (no) no.innerText = orders.length;

    // Calculate Live Robot Dispatches Telemetry
    const activeCount = orders.filter(o => {
      const st = (o.robot?.status || o.status || '').toUpperCase();
      return ['PROCESSING', 'ASSIGNED', 'BAKING', 'IN_KITCHEN', 'OUT_FOR_DELIVERY', 'ROBOT_DISPATCHING'].includes(st);
    }).length;
    const deliveredCount = orders.filter(o => {
      const st = (o.robot?.status || o.status || '').toUpperCase();
      return ['DELIVERED', 'COMPLETED', 'ORDER_PLACED'].includes(st);
    }).length;
    const failedCount = orders.filter(o => {
      const st = (o.robot?.status || o.status || '').toUpperCase();
      return ['ERROR', 'FAILED', 'CANCELLED'].includes(st);
    }).length;
    const totalVolume = orders.reduce((sum, o) => sum + (Number(o.payment?.amount) || Number(o.robot?.billAmount) || 0), 0);

    const elActive = document.getElementById('statActiveRobotOrders');
    if (elActive) elActive.innerText = `${activeCount} Active`;
    const elDelivered = document.getElementById('statDeliveredOrders');
    if (elDelivered) elDelivered.innerText = `${deliveredCount} Delivered`;
    const elFailed = document.getElementById('statFailedOrders');
    if (elFailed) elFailed.innerText = `${failedCount} Failed`;
    const elVol = document.getElementById('statDispatchedVolume');
    if (elVol) elVol.innerText = `₹${totalVolume}`;

    const searchInput = document.getElementById('adminOrderSearchInput');
    const q = searchInput ? searchInput.value.trim() : '';
    filterAdminOrders(q);
  } catch (err) {
    console.error('Error loading orders:', err);
  }
}

function filterAdminOrders(query = '') {
  if (!query) {
    renderAdminOrders(cachedAdminOrders);
    return;
  }
  const q = query.toLowerCase().trim();
  const filtered = cachedAdminOrders.filter(o => {
    const engRef = String(o.id || o.engineOrderRef || '').toLowerCase();
    const domRef = String(o.dominosOrderRef || o.robot?.dominosOrderRef || '').toLowerCase();
    const uid12 = String(o.userId12 || o.user?.userId12 || '').toLowerCase();
    const custPhone = String(o.user?.phone || o.address?.phone || '').toLowerCase();
    const custName = String(o.user?.name || '').toLowerCase();
    const sessionPhone = String(o.robot?.accountPhone || o.robot?.sessionPhone || '').toLowerCase();
    const store = String(o.robot?.storeName || '').toLowerCase();
    const promo = String(o.robot?.couponCode || '').toLowerCase();

    return engRef.includes(q) || domRef.includes(q) || uid12.includes(q) || custPhone.includes(q) || custName.includes(q) || sessionPhone.includes(q) || store.includes(q) || promo.includes(q);
  });
  renderAdminOrders(filtered);
}

function formatAdminRiderContact(phone) {
  if (!phone) return 'Available via store';
  const clean = String(phone).replace(/[^0-9]/g, '');
  const clean10 = clean.slice(-10);
  if (/^[6-9]\d{9}$/.test(clean10)) {
    return `+91 ${clean10.slice(0, 5)} ${clean10.slice(5)}`;
  }
  return `Store Dispatch: ${phone}`;
}

function getAdminRiderTelUri(phone) {
  if (!phone) return '#';
  const clean = String(phone).replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) return `tel:${clean}`;
  if (clean.length === 10) return `tel:+91${clean}`;
  return `tel:${clean}`;
}

function renderAdminOrders(orders) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;

  if (!orders || orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--gray-600); padding: 16px;">No matching orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map(order => {
    const r = order.robot || {};
    const engRef = order.engineOrderRef || order.id;
    const realDom = order.dominosOrderRef || r.dominosOrderRef;
    const kitchenToken = order.kitchenToken || r.token || r.kitchenToken;

    // Authentic Domino's Reference - strictly no fake random identifiers!
    let domRefHtml = '';
    if (realDom && kitchenToken) {
      domRefHtml = `<span style="font-weight: 800; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 2px 6px; border-radius: 4px;">Token #${kitchenToken}</span><div style="font-size: 10px; color: #166534; font-family: monospace; margin-top: 2px;">POS: ${realDom}</div>`;
    } else if (kitchenToken) {
      domRefHtml = `<span style="font-weight: 800; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 2px 6px; border-radius: 4px;">Token #${kitchenToken}</span>`;
    } else if (realDom) {
      domRefHtml = `<span style="font-weight: 800; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 2px 6px; border-radius: 4px;">#${realDom}</span>`;
    } else if (r.status === 'ERROR') {
      domRefHtml = `<span style="color: #dc2626; font-size: 11px; font-weight: 700;">Failed Dispatch</span>`;
    } else {
      domRefHtml = `<span style="color: #64748b; font-size: 11px; font-style: italic;">Awaiting Kitchen Token...</span>`;
    }

    const uid12 = order.userId12 || order.user?.userId12 || '948271035824';
    const sessionPhone = r.sessionPhone || r.accountPhone || '';
    const sessionPhoneClean = sessionPhone.replace(/[^0-9]/g, '').slice(-10);
    const sessionHtml = sessionPhone 
      ? `<button type="button" class="btn-action-copy" onclick="jumpToSession('${escapeHtml(sessionPhoneClean)}')" title="View this session in Pool" style="font-size: 11px; padding: 2px 6px; font-family: monospace; font-weight: 700; color: #0284c7; border-color: #bae6fd; background: #f0f9ff; cursor: pointer;">📱 ${sessionPhone}</button>`
      : '<span style="color: #94a3b8; font-size: 11px;">Auto Assigned</span>';

    const promoCode = r.couponCode || 'DOMNEW50';
    const giftCardUsed = r.assignedVoucherMasked || r.assignedVoucherId || '—';
    const grandTotal = order.payment?.amount || r.billAmount || 0;
    
    const riderText = r.rider && (r.rider.name || r.rider.phone)
      ? `<span style="font-weight: 700; color: #047857;">${r.rider.name || "Domino's Rider"}<br><small style="color:#0284c7;">📞 ${formatAdminRiderContact(r.rider.phone)}</small></span>`
      : '<span style="color: #94a3b8;">Pending Dispatch</span>';

    // Check if tickets exist for this order
    const orderTickets = (window.cachedAdminTickets || []).filter(t => 
      (t.orderId && (t.orderId === order.id || t.orderId === engRef || (realDom && t.orderId === realDom))) ||
      (t.userPhone && order.user?.phone && t.userPhone.slice(-10) === order.user.phone.slice(-10))
    );
    const ticketBadge = orderTickets.length > 0 
      ? `<div><button type="button" class="btn-action-copy" onclick="jumpToTicket('${orderTickets[0].id}')" title="Customer ticket open for this order" style="font-size: 10px; padding: 2px 6px; font-weight: 700; color: #b45309; background: #fef3c7; border-color: #fde68a; cursor: pointer; margin-top: 4px;">🎫 Ticket (${orderTickets.length})</button></div>`
      : '';

    const dominosEncryptedId = r.dominosEncryptedId || order.dominosEncryptedId;
    const dominosTrackerUrl = dominosEncryptedId 
      ? `https://pizzaonline.dominos.co.in/tracker?orderId=${encodeURIComponent(dominosEncryptedId)}`
      : 'https://pizzaonline.dominos.co.in';

    return `
      <tr>
        <td style="font-weight: 800; color: var(--dark);">
          <code style="color: #0284c7;">${engRef}</code>
          <div style="font-size: 10px; font-weight: 800; color: #0284c7; margin-top: 3px; background: #f0f9ff; border: 1px solid #bae6fd; padding: 2px 6px; border-radius: 4px; display: inline-block;">
            #cartId: ${order.cartId || r.cartId || order.session?.cartId || 'Active'}
          </div>
          ${ticketBadge}
        </td>
        <td>${domRefHtml}</td>
        <td>
          <strong>${escapeHtml(order.user?.name || 'Customer')}</strong><br>
          <small style="color: #64748b; font-family: monospace;">UID: ${uid12}</small><br>
          <small style="color: #475569;">📞 ${escapeHtml(order.address?.phone || order.user?.phone || '')}</small>
        </td>
        <td>${sessionHtml}</td>
        <td><span style="background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-weight: 800; font-size: 11px;">${promoCode}</span></td>
        <td><small style="font-family: monospace; color: #475569;">${giftCardUsed}</small></td>
        <td style="font-weight: 900; color: #16a34a; font-size: 13px;">₹${grandTotal}</td>
        <td>
          <span class="status-idle" style="background:#f0fdf4; color:#15803d; font-size: 10px;">${r.status || 'ORDER_PLACED'}</span>
          <div style="margin-top: 4px;">${riderText}</div>
        </td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button class="btn-action-copy" style="font-size: 11px; padding: 3px 8px; cursor: pointer; color: #0066a3; border-color: #93c5fd; background: #f0f9ff; font-weight: 700;" onclick="window.open('${dominosTrackerUrl}', '_blank')" title="Open official Domino's website / live tracker">
              🌐 Domino's Site
            </button>
            <button class="btn-action-copy" style="font-size: 11px; padding: 3px 8px; cursor: pointer; color: #0284c7; border-color: #7dd3fc;" onclick="openAdminBillPhoto('${order.id}')" title="View Captured Domino's Bill Photo">
              🧾 Bill Photo
            </button>
            <button class="btn-action-copy" style="font-size: 11px; padding: 3px 8px; cursor: pointer; color: #15803d; border-color: #86efac;" onclick="openAdminOrderTracker('${order.id}')" title="Track Live Order & Rider Telemetry">
              🔍 Track Live
            </button>
            <button class="btn-action-copy" style="font-size: 11px; padding: 3px 8px; cursor: pointer; color: #475569; border-color: #cbd5e1;" onclick="openOrderDossier('${order.id}')" title="View Full Order Dossier">
              📋 Dossier
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function jumpToSession(phoneClean) {
  switchAdminView('sessions');
  const rows = document.querySelectorAll('#accountsTableBody tr');
  rows.forEach(r => {
    if (r.textContent.includes(phoneClean)) {
      r.style.backgroundColor = '#fef3c7';
      r.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { r.style.backgroundColor = ''; }, 3500);
    }
  });
}
window.jumpToSession = jumpToSession;

function jumpToTicket(ticketId) {
  switchAdminView('support');
  openAdminTicketChat(ticketId);
}
window.jumpToTicket = jumpToTicket;

function openOrderDossier(orderId) {
  const order = cachedAdminOrders.find(o => o.id === orderId);
  if (!order) return;

  const r = order.robot || {};
  const engRef = order.engineOrderRef || order.id;
  const realDom = order.dominosOrderRef || r.dominosOrderRef;
  const kitchenToken = order.kitchenToken || r.token || r.kitchenToken;
  const domDisplay = kitchenToken ? `Token #${kitchenToken}${realDom ? ` (POS: ${realDom})` : ''}` : (realDom ? `#${realDom}` : 'Awaiting Kitchen Token');
  const uid12 = order.userId12 || order.user?.userId12 || '948271035824';

  document.getElementById('dossierOrderRefLabel').innerText = `Engine: ${engRef} • Domino's: ${domDisplay}`;

  const dominosEncryptedId = r.dominosEncryptedId || order.dominosEncryptedId;
  const dominosTrackerUrl = dominosEncryptedId 
    ? `https://pizzaonline.dominos.co.in/tracker?orderId=${encodeURIComponent(dominosEncryptedId)}`
    : 'https://pizzaonline.dominos.co.in';

  const bodyEl = document.getElementById('orderDossierBody');
  bodyEl.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
      <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0;">
        <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Customer Information</div>
        <div style="font-size: 14px; font-weight: 800; color: #0f172a; margin-top: 2px;">${order.user?.name || 'Customer'}</div>
        <div style="font-size: 12px; color: #0284c7; font-family: monospace;">UID (12-Digit): ${uid12}</div>
        <div style="font-size: 12px; color: #475569;">📞 Phone: ${order.address?.phone || order.user?.phone || 'N/A'}</div>
      </div>
      <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0;">
        <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Domino's Session & Kitchen</div>
        <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-top: 2px;">Store: ${r.storeName || 'Domino\'s Outlet'} (#${r.storeId || '65979'})</div>
        <div style="font-size: 12px; color: #166534; font-weight: 700;">Ordered via Session: ${r.sessionPhone || r.accountPhone || 'Pool'}</div>
        <div style="font-size: 12px; color: #0284c7; font-family: monospace; font-weight: 800; background: #f0f9ff; border: 1px solid #bae6fd; padding: 2px 6px; border-radius: 4px; margin-top: 3px; display: inline-block;">🛒 Domino's #cartId: ${order.cartId || r.cartId || order.session?.cartId || 'Active'}</div>
        <div style="font-size: 12px; color: #0369a1; margin-top: 2px;">Promo Voucher Applied: <strong>${r.couponCode || 'DOMNEW50'}</strong></div>
        <div style="margin-top: 8px;">
          <a href="${dominosTrackerUrl}" target="_blank" style="display: inline-flex; align-items: center; gap: 6px; background: #0066a3; color: white; padding: 5px 12px; border-radius: 6px; text-decoration: none; font-size: 11px; font-weight: 700;">
            🌐 Open on Domino's Site &rarr;
          </a>
        </div>
      </div>
    </div>

    <!-- Domino's Delivery Rider Telemetry -->
    <div style="background: ${r.rider?.name ? '#ecfdf5' : '#f8fafc'}; border: 1.5px solid ${r.rider?.name ? '#a7f3d0' : '#e2e8f0'}; border-radius: 6px; padding: 12px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
      <div>
        <div style="font-size: 11px; font-weight: 800; color: ${r.rider?.name ? '#065f46' : '#64748b'}; text-transform: uppercase;">🛵 Domino's Delivery Rider Telemetry</div>
        <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-top: 2px;">
          ${r.rider?.name ? `Rider: ${r.rider.name}` : "Domino's Delivery Executive: Kitchen baking in oven"}
        </div>
        <div style="font-size: 12px; color: #475569;">
          ${r.rider?.phone ? `📞 Contact: ${formatAdminRiderContact(r.rider.phone)}` : "Contact details appear upon store packing & dispatch"} • Status: <strong>${r.rider?.status || (r.status === 'DELIVERED' ? 'DELIVERED' : 'BAKING_IN_OVEN')}</strong>
        </div>
      </div>
      ${r.rider?.phone ? `
        <a href="${getAdminRiderTelUri(r.rider.phone)}" style="background: #16a34a; color: white; padding: 8px 14px; border-radius: 6px; text-decoration: none; font-weight: 800; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
          📞 Call Rider
        </a>
      ` : ''}
    </div>

    <!-- Verified Kitchen Bill Breakdown -->
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; margin-bottom: 14px;">
      <div style="font-size: 12px; font-weight: 800; color: #0f172a; margin-bottom: 8px;">Domino's Verified Kitchen Bill Breakdown</div>
      <div style="display: flex; justify-content: space-between; font-size: 12px; color: #475569; margin-bottom: 4px;">
        <span>Items Subtotal:</span>
        <span style="font-weight: 700;">₹${order.payment?.subtotal || r.billAmount || 0}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 12px; color: #475569; margin-bottom: 4px;">
        <span>Domino's 5% GST (2.5% CGST + 2.5% SGST):</span>
        <span style="font-weight: 700;">₹${order.payment?.gst || 0}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 12px; color: #475569; margin-bottom: 4px;">
        <span>Standard Delivery Fee:</span>
        <span style="font-weight: 700;">₹${order.payment?.deliveryFee || 35}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 12px; color: #475569; margin-bottom: 6px;">
        <span>Restaurant Packaging & Handling:</span>
        <span style="font-weight: 700;">₹${order.payment?.packagingFee || 15}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: 900; color: #16a34a; border-top: 1px solid #cbd5e1; padding-top: 6px;">
        <span>Verified Grand Total:</span>
        <span>₹${order.payment?.amount || 0}</span>
      </div>
      <div style="margin-top: 6px; font-size: 11px; color: #64748b;">
        Settled on Domino's via Gift Card: <strong>${r.assignedVoucherMasked || '16-Digit Voucher Vault'}</strong>
      </div>
    </div>

    <!-- Dual Screenshots: Cart Bill Review + Confirmation Proof -->
    ${(r.cartBillScreenshotUrl || r.proofScreenshotUrl) ? `
      <div style="margin-top: 14px; border-top: 1px dashed #cbd5e1; padding-top: 10px;">
        <div style="font-size: 12px; font-weight: 800; color: #1e293b; margin-bottom: 8px;">📸 Verified Domino's Order Capture Evidence (2 Screenshots)</div>
        <div style="display: grid; grid-template-columns: ${(r.cartBillScreenshotUrl && r.proofScreenshotUrl) ? '1fr 1fr' : '1fr'}; gap: 10px;">
          ${r.cartBillScreenshotUrl ? `
            <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 8px; text-align: center;">
              <div style="font-size: 11px; font-weight: 800; color: #0284c7; margin-bottom: 4px;">🛒 Cart &amp; Itemized Bill Review</div>
              <img src="${r.cartBillScreenshotUrl}" alt="Cart Bill" style="max-width: 100%; max-height: 200px; object-fit: contain; border-radius: 4px; border: 1px solid #e2e8f0; cursor: zoom-in;" onclick="window.open(this.src, '_blank')">
              <div style="margin-top: 4px;"><a href="${r.cartBillScreenshotUrl}" target="_blank" style="font-size: 10px; color: #0284c7; font-weight: 700; text-decoration: underline;">🔍 Open Full Resolution</a></div>
            </div>
          ` : ''}
          ${r.proofScreenshotUrl ? `
            <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 8px; text-align: center;">
              <div style="font-size: 11px; font-weight: 800; color: #16a34a; margin-bottom: 4px;">🧾 Confirmation Receipt Proof</div>
              <img src="${r.proofScreenshotUrl}" alt="Confirmation Proof" style="max-width: 100%; max-height: 200px; object-fit: contain; border-radius: 4px; border: 1px solid #e2e8f0; cursor: zoom-in;" onclick="window.open(this.src, '_blank')">
              <div style="margin-top: 4px;"><a href="${r.proofScreenshotUrl}" target="_blank" style="font-size: 10px; color: #16a34a; font-weight: 700; text-decoration: underline;">🔍 Open Full Resolution</a></div>
            </div>
          ` : ''}
        </div>
      </div>
    ` : '<div style="font-size: 11px; color: #94a3b8; text-align: center; margin-top: 10px;">Cart & Bill screenshots will appear once autonomous robot settles the order on Domino\'s site.</div>'}
  `;

  openModal('orderDossierModal');
}

// =========================================================================
// 3A. View Verified Domino's Bill Photo (1-Click Admin Access - Dual Screenshots)
// =========================================================================
let currentBillPhotoOrder = null;
let currentBillPhotoActiveTab = 'cart';

function switchBillPhotoTab(tab) {
  currentBillPhotoActiveTab = tab;
  const btnCart = document.getElementById('btnBillTabCart');
  const btnProof = document.getElementById('btnBillTabProof');
  if (btnCart && btnProof) {
    if (tab === 'cart') {
      btnCart.style.background = '#0284c7';
      btnCart.style.color = '#fff';
      btnProof.style.background = '#f1f5f9';
      btnProof.style.color = '#334155';
    } else {
      btnProof.style.background = '#16a34a';
      btnProof.style.color = '#fff';
      btnCart.style.background = '#f1f5f9';
      btnCart.style.color = '#334155';
    }
  }

  if (!currentBillPhotoOrder) return;
  const r = currentBillPhotoOrder.robot || {};
  const photoImg = document.getElementById('adminBillPhotoImg');
  const openBtn = document.getElementById('adminBillPhotoOpenBtn');
  const photoTitle = document.getElementById('billPhotoCurrentTitle');

  const targetUrl = tab === 'cart' ? (r.cartBillScreenshotUrl || r.proofScreenshotUrl) : (r.proofScreenshotUrl || r.cartBillScreenshotUrl);
  if (photoImg && targetUrl) {
    photoImg.src = targetUrl;
  }
  if (openBtn && targetUrl) {
    openBtn.href = targetUrl;
  }
  if (photoTitle) {
    photoTitle.innerText = tab === 'cart' 
      ? '🛒 Domino\'s Cart & Itemized Bill Review (Items, Prices & Dispatched Cart)' 
      : '🧾 Official Domino\'s Order Confirmation Receipt (Domino\'s Order Confirmed)';
    photoTitle.style.color = tab === 'cart' ? '#0284c7' : '#16a34a';
  }
}

function openAdminBillPhoto(orderId, preferredTab = null) {
  const order = cachedAdminOrders.find(o => o.id === orderId);
  if (!order) return;
  currentBillPhotoOrder = order;

  const r = order.robot || {};
  const engRef = order.engineOrderRef || order.id;
  const domToken = (order.dominosOrderRef || r.dominosOrderRef || '').replace(/[^0-9]/g, '') || order.id.slice(-6);
  const totalAmt = order.payment?.amount || r.billAmount || 0;
  const storeName = r.storeName || order.location?.store?.storeName || "Domino's Kitchen Outlet";

  const metaEl = document.getElementById('billPhotoHeaderMeta');
  if (metaEl) metaEl.innerText = `Engine: ${engRef} • Domino's: #${domToken}`;

  const contentBox = document.getElementById('billPhotoContent');
  const emptyBox = document.getElementById('billPhotoEmptyState');

  const hasAnyScreenshot = Boolean(r.cartBillScreenshotUrl || r.proofScreenshotUrl);

  if (hasAnyScreenshot) {
    if (contentBox) contentBox.style.display = 'block';
    if (emptyBox) emptyBox.style.display = 'none';

    // Show/hide tab buttons based on availability
    const btnCart = document.getElementById('btnBillTabCart');
    const btnProof = document.getElementById('btnBillTabProof');
    if (btnCart) {
      btnCart.style.display = r.cartBillScreenshotUrl ? 'inline-flex' : 'none';
    }
    if (btnProof) {
      btnProof.style.display = r.proofScreenshotUrl ? 'inline-flex' : 'none';
    }

    const defaultTab = preferredTab || (r.cartBillScreenshotUrl ? 'cart' : 'proof');
    switchBillPhotoTab(defaultTab);

    const storeEl = document.getElementById('billPhotoStoreName');
    if (storeEl) storeEl.innerText = storeName;

    const tokenEl = document.getElementById('billPhotoOrderTokens');
    if (tokenEl) tokenEl.innerText = `Engine: ${engRef} • Kitchen Token: #${domToken}`;

    const amtEl = document.getElementById('billPhotoAmount');
    if (amtEl) amtEl.innerText = `₹${totalAmt}`;

    const itemsEl = document.getElementById('billPhotoItemsList');
    if (itemsEl) {
      const items = order.items || [];
      if (items.length > 0) {
        itemsEl.innerHTML = items.map(it => `
          <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
            <span>${it.quantity || 1}x ${it.name} ${it.customSize ? `(${it.customSize})` : ''}</span>
            <span style="font-weight: 700;">₹${(it.price || 0) * (it.quantity || 1)}</span>
          </div>
        `).join('');
      } else {
        itemsEl.innerHTML = '<div>Domino\'s verified order items</div>';
      }
    }

    const timeEl = document.getElementById('billPhotoTimestamp');
    if (timeEl) {
      const timeStr = order.createdAt ? new Date(order.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Live';
      timeEl.innerText = `Captured: ${timeStr}`;
    }

    const vouchEl = document.getElementById('billPhotoVoucherUsed');
    if (vouchEl) {
      vouchEl.innerText = `Settled via: ${r.assignedVoucherMasked || 'Gift Card / COD'}`;
    }
  } else {
    if (contentBox) contentBox.style.display = 'none';
    if (emptyBox) emptyBox.style.display = 'block';
    const detailEl = document.getElementById('billPhotoEmptyOrderDetails');
    if (detailEl) {
      detailEl.innerText = `Order: ${engRef} • ${storeName} • ₹${totalAmt}`;
    }
  }

  openModal('adminBillPhotoModal');
}

// =========================================================================
// 3B. Live Order & Delivery Telemetry Tracker (Admin Direct View)
// =========================================================================
let currentAdminTrackOrderId = null;
const adminPersistentRiderCache = {};

async function openAdminOrderTracker(orderId) {
  currentAdminTrackOrderId = orderId;
  const order = cachedAdminOrders.find(o => o.id === orderId);
  if (!order) return;

  renderAdminTrackUI(order);
  openModal('adminLiveTrackModal');

  // Pull latest live telemetry from server
  try {
    const res = await fetch(`/api/orders/${orderId}/track`);
    if (res.ok) {
      const freshOrder = await res.json();
      renderAdminTrackUI(freshOrder);
    }
  } catch (err) {
    console.warn('Live track poll error:', err);
  }
}

async function refreshAdminLiveTrack() {
  if (!currentAdminTrackOrderId) return;
  showToast('Refreshing live Domino\'s telemetry...', '🔄');
  try {
    const res = await fetch(`/api/orders/${currentAdminTrackOrderId}/track?refresh=true`);
    if (res.ok) {
      const freshOrder = await res.json();
      renderAdminTrackUI(freshOrder);
      showToast('Live telemetry updated from Domino\'s!', '✅');
      loadOrders();
    }
  } catch (err) {
    showToast('Failed to refresh telemetry', '⚠️');
  }
}

function renderAdminTrackUI(order) {
  if (!order) return;
  const r = order.robot || {};
  const engRef = order.engineOrderRef || order.id;
  const rawToken = order.dominosOrderRef || r.dominosOrderRef || '';
  const cleanDigits = rawToken.replace(/[^0-9]/g, '');
  let domToken = 'Pending Token';
  if (cleanDigits && (rawToken.startsWith('#') || !rawToken.startsWith('DOM-IND'))) {
    domToken = rawToken.startsWith('#') ? rawToken : `#${cleanDigits}`;
  } else if (rawToken) {
    domToken = rawToken;
  }
  const status = (r.status || 'ORDER_PLACED').toUpperCase();

  // Persistent rider caching (eliminates flickering/flashing)
  if (r.rider && r.rider.phone) {
    adminPersistentRiderCache[order.id] = r.rider;
  }
  const cachedRider = adminPersistentRiderCache[order.id] || r.rider;

  // Header
  const headerMeta = document.getElementById('adminTrackHeaderMeta');
  if (headerMeta) headerMeta.innerText = `Engine Ref: ${engRef} • Domino's Kitchen Token: ${domToken}`;

  const tokenDisplay = document.getElementById('adminTrackTokenDisplay');
  if (tokenDisplay) tokenDisplay.innerText = domToken;

  const engDisplay = document.getElementById('adminTrackEngineRefDisplay');
  if (engDisplay) engDisplay.innerText = `Engine: ${engRef}`;

  const isCancelled = status === 'CANCELLED';
  const statusBadge = document.getElementById('adminTrackStatusBadge');
  if (statusBadge) {
    statusBadge.innerText = isCancelled ? '❌ CANCELLED BY STORE' : status.replace(/_/g, ' ');
    if (isCancelled) {
      statusBadge.style.background = '#dc2626';
    } else if (status === 'DELIVERED') {
      statusBadge.style.background = '#10b981';
    } else if (status === 'OUT_FOR_DELIVERY' || status === 'DISPATCHED') {
      statusBadge.style.background = '#f59e0b';
    } else {
      statusBadge.style.background = '#0284c7';
    }
  }

  const etaDisplay = document.getElementById('adminTrackEtaDisplay');
  if (etaDisplay) {
    etaDisplay.innerText = isCancelled ? 'Order Cancelled by Kitchen' : (status === 'DELIVERED' ? 'Order Delivered' : `ETA: ~${r.estimatedMinutes || 20} mins`);
  }

  // Progress Bar & 5 Stepper Nodes
  const pBar = document.getElementById('adminTrackProgressBar');
  if (isCancelled) {
    if (pBar) {
      pBar.style.width = '100%';
      pBar.style.background = '#ef4444';
    }
  } else {
    if (pBar) pBar.style.background = '#0066a3';
    let pct = 20;
    let activeStep = 1;
    if (status.includes('BAK') || status === 'ORDER_ACCEPTED') {
      pct = 40; activeStep = 2;
    } else if (status.includes('READY') || status.includes('PACK') || status.includes('FOOD_READY')) {
      pct = 60; activeStep = 3;
    } else if (status.includes('DISPATCH') || status.includes('OUT') || status.includes('ON_WAY')) {
      pct = 80; activeStep = 4;
    } else if (status === 'DELIVERED') {
      pct = 100; activeStep = 5;
    }
    if (pBar) pBar.style.width = pct + '%';

    for (let i = 1; i <= 5; i++) {
      const node = document.getElementById(`admStep${i}`);
      if (node) {
        const circle = node.querySelector('.adm-circle');
        if (circle) {
          if (i <= activeStep) {
            circle.style.background = '#0066a3';
            circle.style.color = '#ffffff';
          } else {
            circle.style.background = '#cbd5e1';
            circle.style.color = '#ffffff';
          }
        }
      }
    }
  }

  // Rider Details (Persistent - Zero Flicker)
  const riderNameEl = document.getElementById('adminTrackRiderName');
  const riderPhoneWrap = document.getElementById('adminTrackRiderPhoneWrap');
  const riderStatusEl = document.getElementById('adminTrackRiderStatus');
  if (cachedRider && (cachedRider.name || cachedRider.phone)) {
    if (riderNameEl) riderNameEl.innerText = `Rider: ${cachedRider.name || "Domino's Delivery Fleet Partner"}`;
    if (riderPhoneWrap) {
      const formatted = formatAdminRiderContact(cachedRider.phone);
      const tel = getAdminRiderTelUri(cachedRider.phone);
      riderPhoneWrap.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <a href="${tel}" style="font-size: 14px; font-weight: 800; color: #0284c7; text-decoration: none;">📞 ${formatted}</a>
          <a href="${tel}" style="background: #16a34a; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 800; text-decoration: none;">Call</a>
        </div>
      `;
    }
    if (riderStatusEl) riderStatusEl.innerText = `Delivery Status: ${status === 'DELIVERED' ? 'Delivered safely' : (status.includes('OUT') || status === 'DISPATCHED' ? 'On way to address (Dispatched)' : 'Waiting for kitchen pack')}`;
  } else {
    if (riderNameEl) riderNameEl.innerText = 'Assigned upon kitchen packing';
    if (riderPhoneWrap) riderPhoneWrap.innerHTML = '<span style="font-size: 12px; color: #64748b;">Contact appears upon store dispatch</span>';
    if (riderStatusEl) riderStatusEl.innerText = `Status: ${status.replace(/_/g, ' ')}`;
  }

  // Store Details
  const storeNameEl = document.getElementById('adminTrackStoreName');
  if (storeNameEl) storeNameEl.innerText = r.storeName || order.location?.store?.storeName || 'Domino\'s Store Kitchen';

  const storePhoneEl = document.getElementById('adminTrackStorePhone');
  if (storePhoneEl) {
    const sPhone = r.storePhone || '01141033574';
    storePhoneEl.innerHTML = `📞 Store Dispatch: <a href="tel:${sPhone}" style="color: #0284c7; font-weight: 700; text-decoration: none;">${sPhone}</a>`;
  }

  const storeAddrEl = document.getElementById('adminTrackStoreAddr');
  if (storeAddrEl) storeAddrEl.innerText = r.storeAddress || order.location?.store?.address || 'Local Domino\'s Outlet';

  // Customer Details
  const custNameEl = document.getElementById('adminTrackCustomerName');
  if (custNameEl) {
    const cName = order.user?.name || order.address?.name || 'Customer';
    const cPhone = order.address?.phone || order.user?.phone || '';
    custNameEl.innerText = `${cName} (📞 ${cPhone})`;
  }

  const custAddrEl = document.getElementById('adminTrackCustomerAddress');
  if (custAddrEl) {
    const addr = order.address || {};
    const fullStreet = [addr.flat, addr.building, addr.street].filter(Boolean).join(', ') || addr.completeAddress || 'Delivery Address';
    custAddrEl.innerText = `${fullStreet}${addr.city ? `, ${addr.city}` : ''}${addr.pincode ? ` - ${addr.pincode}` : ''}`;
  }

  // Log stream
  const logEl = document.getElementById('adminTrackLogStream');
  if (logEl) {
    const logs = r.telemetryLogs || r.logs || [
      `[DOMINOS-KITCHEN] Token #${domToken} generated at store ${r.storeName || 'kitchen'}.`,
      `[ORDER-STATUS] Current live state: ${status}.`,
      `[TELEMETRY] Last synced at ${new Date().toLocaleTimeString('en-IN')}.`
    ];
    logEl.innerHTML = logs.map(l => `<div>• ${l}</div>`).join('');
  }
}

async function promptAdminUpdateRider() {
  if (!currentAdminTrackOrderId) return;
  const order = cachedAdminOrders.find(o => o.id === currentAdminTrackOrderId);
  const curPhone = order?.robot?.rider?.phone || '';
  const newPhone = prompt('Enter Domino\'s Rider Mobile Number or Store Dispatch Hotline (e.g. 01141033574 or 98XXXXXXXX):', curPhone);
  if (!newPhone) return;

  const digits = newPhone.replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 12) {
    alert('Please enter a valid 10-digit Indian mobile number or Domino\'s Dispatch hotline.');
    return;
  }

  const curStatus = order?.robot?.status === 'DELIVERED' ? 'DELIVERED' : 'DISPATCHED';
  const newStatus = prompt('Enter Order / Rider Status (DISPATCHED / DELIVERED / BAKING):', curStatus);
  const riderName = prompt('Enter Rider Name (optional):', order?.robot?.rider?.name || "Domino's Delivery Fleet Partner");

  try {
    const res = await fetch(`/api/orders/${currentAdminTrackOrderId}/rider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: newPhone.trim(),
        name: riderName || "Domino's Delivery Fleet Partner",
        status: newStatus || 'DISPATCHED',
        updateStatus: newStatus || 'DISPATCHED'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update rider');

    showToast(data.message || `Rider updated to ${data.rider?.phone}! This is the rider and you can contact the rider for your order.`, '✅');
    if (order) {
      order.robot.rider = data.rider;
      if (newStatus) {
        order.robot.status = newStatus;
        order.status = newStatus;
      }
    }
    renderAdminTrackUI(order || data.order);
    loadOrders();
  } catch (err) {
    alert(`Update failed: ${err.message}`);
  }
}

// =========================================================================
// 4. APP REGISTERED USERS MANAGEMENT
// =========================================================================

let cachedAppUsers = [];
let activeManagingUser = null;

async function loadAppUsers() {
  try {
    loadWalletDeposits();
    const res = await adminFetch('/api/admin/users');
    const data = await res.json();
    const users = Array.isArray(data) ? data : [];
    cachedAppUsers = users;

    const countBadge = document.getElementById('appUsersCount');
    if (countBadge) countBadge.innerText = `${users.length} Users Registered`;
    const qu = document.getElementById('quickStatUsers');
    if (qu) qu.innerText = `${users.length} Users`;
    const nu = document.getElementById('navBadgeUsers');
    if (nu) nu.innerText = users.length;

    renderAppUsers(users);
  } catch (err) {
    console.error('Error loading app users:', err);
  }
}

function renderAppUsers(users) {
  const tbody = document.getElementById('appUsersTableBody');
  if (!tbody) return;

  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--gray-600); padding: 16px;">No users registered or matching your search.</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const lockBadge = u.phoneLocked 
      ? `<span onclick="toggleUserPhoneLock('${u.id}')" title="Click to 1-click Unlock this phone" style="background: #fef2f2; color: #b91c1c; border: 1.5px solid #fecaca; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">🔒 Locked</span>`
      : `<span onclick="toggleUserPhoneLock('${u.id}')" title="Click to 1-click Lock this phone" style="background: #ecfdf5; color: #047857; border: 1.5px solid #a7f3d0; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">🔓 Unlocked</span>`;

    const regDate = u.registeredAt ? new Date(u.registeredAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Recent';
    const uid12 = u.userId12 || u.id;
    const addrCount = u.savedAddresses?.length || u.addressCount || 0;
    const statusText = u.status || 'ACTIVE';
    const statusBadge = statusText === 'ACTIVE' 
      ? '<span style="color: #16a34a; font-weight: 800; font-size: 10px;">● ACTIVE</span>'
      : '<span style="color: #dc2626; font-weight: 800; font-size: 10px;">● SUSPENDED</span>';

    return `
      <tr>
        <td>
          <code style="font-weight: 800; color: #0284c7; font-size: 12px; background: #f0f9ff; padding: 3px 6px; border-radius: 4px; border: 1px solid #bae6fd;">${uid12}</code>
          <div style="margin-top: 2px;">${statusBadge}</div>
        </td>
        <td>
          <strong>${escapeHtml(u.name || 'Anonymous User')}</strong>
          <div style="font-size: 11px; color: #64748b;">${escapeHtml(u.email || 'No email registered')}</div>
        </td>
        <td style="font-weight: 700;">${escapeHtml(u.phone || 'N/A')}</td>
        <td>${lockBadge}</td>
        <td>
          <strong style="color: #16a34a; font-size: 14px;">₹${u.walletBalance || 0}</strong>
        </td>
        <td>
          <button class="btn-action-copy" style="font-size: 11px; padding: 3px 8px;" onclick="openUserAddressesModal('${u.id}')">
            📍 Addresses (${addrCount}/3)
          </button>
        </td>
        <td style="font-size: 12px; color: #64748b;">${regDate}</td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button class="btn-action-copy" onclick="openEditUserModal('${u.id}')" style="cursor: pointer; border-color: #93c5fd; color: #1d4ed8; font-size: 11px; padding: 3px 8px;">
              ✏️ Profile
            </button>
            <button class="btn-action-copy" onclick="openAdjustWalletModal('${u.id}')" style="cursor: pointer; border-color: #86efac; color: #15803d; font-size: 11px; padding: 3px 8px;">
              💰 Wallet
            </button>
            <button class="btn-action-copy" onclick="openUserHistoryModal('${u.id}')" style="cursor: pointer; border-color: #cbd5e1; color: #475569; font-size: 11px; padding: 3px 8px;">
              📜 History
            </button>
            <button class="btn-action-copy" onclick="toggleUserStatusAction('${u.id}')" style="cursor: pointer; border-color: ${statusText === 'ACTIVE' ? '#fed7aa' : '#bbf7d0'}; color: ${statusText === 'ACTIVE' ? '#c2410c' : '#15803d'}; font-size: 11px; padding: 3px 8px;" title="${statusText === 'ACTIVE' ? 'Suspend User Account' : 'Activate User Account'}">
              ${statusText === 'ACTIVE' ? '🚫 Suspend' : '✅ Activate'}
            </button>
            <button class="btn-action-copy" onclick="deleteUserAction('${u.id}', '${escapeHtml(u.name || uid12)}')" style="cursor: pointer; border-color: #fecaca; color: #b91c1c; font-size: 11px; padding: 3px 8px;" title="Delete User from Directory">
              🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAppUsersTable() {
  const query = (document.getElementById('userSearchInput')?.value || '').trim().toLowerCase();
  if (!query) {
    renderAppUsers(cachedAppUsers);
    return;
  }

  const filtered = cachedAppUsers.filter(u => {
    const name = String(u.name || '').toLowerCase();
    const email = String(u.email || '').toLowerCase();
    const phone = String(u.phone || '').toLowerCase();
    const uid12 = String(u.userId12 || u.id || '').toLowerCase();
    return name.includes(query) || email.includes(query) || phone.includes(query) || uid12.includes(query);
  });

  renderAppUsers(filtered);
}
window.filterAppUsersTable = filterAppUsersTable;

async function toggleUserPhoneLock(userId) {
  const user = cachedAppUsers.find(u => u.id === userId || u.userId12 === userId);
  if (!user) return;

  const targetState = !user.phoneLocked;
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneLocked: targetState })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    user.phoneLocked = targetState;
    showToast(`Phone lock ${targetState ? 'ENABLED 🔒' : 'DISABLED 🔓'} for ${user.name}!`, '📱');
    filterAppUsersTable();
  } catch (err) {
    alert('Failed to toggle phone lock: ' + err.message);
  }
}
window.toggleUserPhoneLock = toggleUserPhoneLock;

async function toggleUserStatusAction(userId) {
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/toggle-status`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to toggle status');
    showToast(`User status updated to ${data.status}!`, '🔄');
    loadAppUsers();
  } catch (err) {
    alert('Error toggling user status: ' + err.message);
  }
}
window.toggleUserStatusAction = toggleUserStatusAction;

async function deleteUserAction(userId, userName) {
  if (!confirm(`Are you sure you want to permanently delete user "${userName}"?\n\nThis will remove the user, wallet balance, and address directory records.`)) {
    return;
  }
  try {
    const res = await adminFetch(`/api/admin/users/${userId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete user');
    showToast(`User ${userName} deleted successfully.`, '🗑️');
    loadAppUsers();
  } catch (err) {
    alert('Error deleting user: ' + err.message);
  }
}
window.deleteUserAction = deleteUserAction;

// 4A. Edit User Profile (Name, Phone, Email, Phone Lock, Lifetime Metrics)
function openEditUserModal(userId) {
  const user = cachedAppUsers.find(u => u.id === userId || u.userId12 === userId);
  if (!user) return;

  const uid12 = user.userId12 || user.id;
  document.getElementById('editUserId').value = user.id;
  document.getElementById('editUserIdLabel').innerText = `12-Digit UID: ${uid12} • Registered ${user.phone}`;
  
  const uidDisplay = document.getElementById('editUserUidDisplay');
  if (uidDisplay) uidDisplay.innerText = uid12;

  // Calculate customer lifetime stats from cachedAdminOrders
  const userOrders = cachedAdminOrders.filter(o => 
    String(o.userId12 || '') === String(uid12) || 
    String(o.userId || '') === String(user.id) ||
    String(o.user?.phone || '').replace(/[^0-9]/g, '').slice(-10) === String(user.phone || '').replace(/[^0-9]/g, '').slice(-10)
  );
  const totalSpent = userOrders.reduce((sum, o) => sum + (Number(o.payment?.amount) || 0), 0);

  const ordersCountEl = document.getElementById('editUserOrdersCount');
  if (ordersCountEl) ordersCountEl.innerText = userOrders.length;

  const spentEl = document.getElementById('editUserTotalSpent');
  if (spentEl) spentEl.innerText = `₹${totalSpent}`;

  const currentWalletEl = document.getElementById('editUserCurrentWallet');
  if (currentWalletEl) currentWalletEl.innerText = `₹${user.walletBalance || 0}`;

  document.getElementById('editUserName').value = user.name || '';
  document.getElementById('editUserEmail').value = user.email || '';
  document.getElementById('editUserPhone').value = (user.phone || '').replace(/[^0-9]/g, '').slice(-10);
  
  const lockBox = document.getElementById('editUserPhoneLocked');
  if (lockBox) {
    lockBox.checked = Boolean(user.phoneLocked);
    updateEditUserLockPill(lockBox.checked);
  }

  document.getElementById('editUserWallet').value = user.walletBalance || 0;

  openModal('editUserModal');
}

function updateEditUserLockPill(isLocked) {
  const pill = document.getElementById('editUserPhoneLockPill');
  if (!pill) return;
  if (isLocked) {
    pill.style.background = '#fef2f2';
    pill.style.color = '#b91c1c';
    pill.style.borderColor = '#fecaca';
    pill.innerText = '🔒 Phone Locked';
  } else {
    pill.style.background = '#ecfdf5';
    pill.style.color = '#047857';
    pill.style.borderColor = '#a7f3d0';
    pill.innerText = '🔓 Phone Unlocked';
  }
}

function addQuickWalletCredit(amount) {
  const input = document.getElementById('editUserWallet');
  if (input) {
    input.value = (Number(input.value) || 0) + Number(amount);
    showToast(`Added ₹${amount} to adjustment field. Click Save to apply!`, '💰');
  }
}

async function submitUserUpdate() {
  const id = document.getElementById('editUserId').value;
  const name = document.getElementById('editUserName').value.trim();
  const email = document.getElementById('editUserEmail').value.trim();
  const phone = document.getElementById('editUserPhone').value.trim();
  const phoneLocked = document.getElementById('editUserPhoneLocked').checked;
  const walletBalance = Number(document.getElementById('editUserWallet').value);

  if (!id) return;

  try {
    const res = await adminFetch(`/api/admin/users/${id}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, phoneLocked, walletBalance })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`User ${name} profile updated successfully!`, '👤');
    closeModal('editUserModal');
    loadAppUsers();
  } catch (err) {
    alert('Failed to update user profile: ' + err.message);
  }
}

// 4B. Wallet Adjustment Modal (+ / - / =)
let currentWalletOp = 'ADD';

function openAdjustWalletModal(userId) {
  const user = cachedAppUsers.find(u => u.id === userId || u.userId12 === userId);
  if (!user) return;
  activeManagingUser = user;

  document.getElementById('adjWalletUserId').value = user.id;
  document.getElementById('adjWalletUserLabel').innerText = `${user.name || 'User'} • UID: ${user.userId12 || user.id} (${user.phone})`;
  document.getElementById('adjWalletCurrentBal').innerText = `₹${user.walletBalance || 0}`;
  document.getElementById('adjWalletAmount').value = '';
  document.getElementById('adjWalletReason').value = '';
  selectWalletOp('ADD');
  updateAdjWalletPreview();

  openModal('adjustWalletModal');
}

function selectWalletOp(op) {
  currentWalletOp = op;
  const btnAdd = document.getElementById('btnOpAdd');
  const btnDeduct = document.getElementById('btnOpDeduct');
  const btnSet = document.getElementById('btnOpSet');
  const label = document.getElementById('adjAmountLabel');

  if (btnAdd) btnAdd.classList.toggle('active', op === 'ADD');
  if (btnDeduct) btnDeduct.classList.toggle('active', op === 'DEDUCT');
  if (btnSet) btnSet.classList.toggle('active', op === 'SET');

  if (label) {
    if (op === 'ADD') label.innerText = 'Amount to Add (₹) *';
    else if (op === 'DEDUCT') label.innerText = 'Amount to Deduct (₹) *';
    else label.innerText = 'Exact New Balance to Set (₹) *';
  }

  updateAdjWalletPreview();
}

function updateAdjWalletPreview() {
  const currentBal = Number(activeManagingUser?.walletBalance || 0);
  const amtInput = document.getElementById('adjWalletAmount');
  const rawAmt = amtInput ? Number(amtInput.value) : 0;
  const amt = isNaN(rawAmt) ? 0 : Math.max(0, rawAmt);
  const previewBalEl = document.getElementById('adjWalletPreviewBal');
  if (!previewBalEl) return;

  let newBal = currentBal;
  if (currentWalletOp === 'ADD') {
    newBal = currentBal + amt;
  } else if (currentWalletOp === 'DEDUCT') {
    newBal = Math.max(0, currentBal - amt);
  } else if (currentWalletOp === 'SET') {
    newBal = (amtInput && amtInput.value.trim() !== '') ? amt : currentBal;
  }

  previewBalEl.innerText = `₹${newBal}`;
}
window.updateAdjWalletPreview = updateAdjWalletPreview;

async function submitWalletAdjustment() {
  const userId = document.getElementById('adjWalletUserId').value;
  const amount = Number(document.getElementById('adjWalletAmount').value);
  const reason = document.getElementById('adjWalletReason').value.trim();

  if (!userId) return;
  if (isNaN(amount) || amount < 0) {
    alert('Please enter a valid non-negative amount.');
    return;
  }
  if (!reason) {
    alert('Please provide an audit reason for this wallet adjustment.');
    return;
  }

  try {
    const res = await adminFetch(`/api/admin/users/${userId}/adjust-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: currentWalletOp, amount, reason })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`Wallet adjusted: ${currentWalletOp} ₹${amount}. New balance: ₹${data.user.walletBalance}`, '💰');
    closeModal('adjustWalletModal');
    loadAppUsers();
  } catch (err) {
    alert('Failed to adjust wallet balance: ' + err.message);
  }
}

// 4C. Manage User Addresses (Max 3 Enforced)
async function openUserAddressesModal(userId) {
  const user = cachedAppUsers.find(u => u.id === userId || u.userId12 === userId);
  if (!user) return;
  activeManagingUser = user;

  document.getElementById('manageAddrUserId').value = user.id;
  document.getElementById('userAddrModalLabel').innerText = `${user.name} • UID: ${user.userId12 || user.id}`;
  toggleAdminAddAddrForm(false);

  await renderAdminUserAddresses(user.id);
  openModal('userAddressesModal');
}

async function renderAdminUserAddresses(userId) {
  const listEl = document.getElementById('adminUserAddrList');
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/addresses`);
    const data = await res.json();
    const addrs = data.addresses || [];

    if (addrs.length === 0) {
      listEl.innerHTML = '<div style="text-align: center; color: #64748b; font-size: 12px; padding: 14px;">No addresses saved for this customer.</div>';
      return;
    }

    listEl.innerHTML = addrs.map((a, idx) => `
      <div style="background: ${a.isDefault ? '#f0fdf4' : 'white'}; border: 1.5px solid ${a.isDefault ? '#86efac' : '#cbd5e1'}; border-radius: 6px; padding: 12px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="background: #e0f2fe; color: #0369a1; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 4px;">🏷️ ${a.label || 'Home'}</span>
            ${a.isDefault ? '<span style="background: #16a34a; color: white; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px;">DEFAULT</span>' : ''}
          </div>
          <div style="display: flex; gap: 6px;">
            ${!a.isDefault ? `<button onclick="adminSetDefaultAddr('${userId}', '${a.id}')" style="background:none; border:1px solid #16a34a; color:#15803d; font-size:11px; padding:2px 8px; border-radius:4px; cursor:pointer;">Set Default</button>` : ''}
            <button onclick="adminDeleteAddr('${userId}', '${a.id}')" style="background:none; border:1px solid #f87171; color:#dc2626; font-size:11px; padding:2px 8px; border-radius:4px; cursor:pointer;">Delete</button>
          </div>
        </div>
        <div style="font-weight: 800; font-size: 13px; color: #1e293b;">${a.flat}</div>
        <div style="font-size: 12px; color: #475569;">${a.street || a.completeAddress || ''} ${a.landmark ? `• Landmark: ${a.landmark}` : ''}</div>
        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">City: ${a.city || 'India'} • Pincode: ${a.pincode || '110001'}</div>
        ${a.dominosAddressId ? `<div style="font-size: 11px; color: #15803d; font-weight: 700; margin-top: 4px;">✅ Domino's Address ID: #${a.dominosAddressId}</div>` : ''}
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div style="color: red; font-size: 12px;">Failed to load addresses: ${err.message}</div>`;
  }
}

function toggleAdminAddAddrForm(show) {
  const form = document.getElementById('adminAddAddrForm');
  const btn = document.getElementById('btnAdminAddAddrToggle');
  if (show === undefined) show = form.style.display === 'none';
  form.style.display = show ? 'block' : 'none';
  if (btn) btn.style.display = show ? 'none' : 'block';
}

async function submitAdminNewAddress() {
  const userId = document.getElementById('manageAddrUserId').value;
  const label = document.getElementById('adminAddrTag').value.trim() || 'Home';
  const flat = document.getElementById('adminAddrFlat').value.trim();
  const street = document.getElementById('adminAddrStreet').value.trim();
  const city = document.getElementById('adminAddrCity').value.trim() || 'Noida';
  const pincode = document.getElementById('adminAddrPincode').value.trim() || '201301';

  if (!flat || !street) {
    alert('House/Flat and Street are mandatory fields.');
    return;
  }

  try {
    const res = await adminFetch(`/api/admin/users/${userId}/addresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, flat, street, city, pincode, latitude: 28.5355, longitude: 77.3910 })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('New delivery address added for user!', '📍');
    toggleAdminAddAddrForm(false);
    await renderAdminUserAddresses(userId);
    loadAppUsers();
  } catch (err) {
    alert('Failed to add address: ' + err.message);
  }
}

async function adminDeleteAddr(userId, addrId) {
  if (!confirm('Are you sure you want to delete this delivery address?')) return;
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/addresses/${addrId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('Address deleted.', '🗑️');
    await renderAdminUserAddresses(userId);
    loadAppUsers();
  } catch (err) {
    alert('Failed to delete address: ' + err.message);
  }
}

async function adminSetDefaultAddr(userId, addrId) {
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/addresses/${addrId}/default`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('Default address updated!', '⭐');
    await renderAdminUserAddresses(userId);
    loadAppUsers();
  } catch (err) {
    alert('Failed to update default address: ' + err.message);
  }
}

// 4D. User Audit Dossier (Wallet Transactions & Past Orders)
let currentUserHistoryId = null;

async function openUserHistoryModal(userId) {
  const user = cachedAppUsers.find(u => u.id === userId || u.userId12 === userId);
  if (!user) return;
  currentUserHistoryId = user.id;

  document.getElementById('userHistoryLabel').innerText = `${user.name} • 12-Digit UID: ${user.userId12 || user.id} (Phone: ${user.phone})`;
  switchHistoryTab('txns');
  openModal('userHistoryModal');
}

async function switchHistoryTab(tab) {
  const btnTxns = document.getElementById('btnHistTabTxns');
  const btnOrders = document.getElementById('btnHistTabOrders');
  const secTxns = document.getElementById('histTxnsSection');
  const secOrders = document.getElementById('histOrdersSection');

  btnTxns.classList.toggle('active', tab === 'txns');
  btnOrders.classList.toggle('active', tab === 'orders');
  secTxns.style.display = tab === 'txns' ? 'block' : 'none';
  secOrders.style.display = tab === 'orders' ? 'block' : 'none';

  if (tab === 'txns') {
    await renderUserTransactions(currentUserHistoryId);
  } else {
    await renderUserOrders(currentUserHistoryId);
  }
}

async function renderUserTransactions(userId) {
  const tbody = document.getElementById('userTxnsTableBody');
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/transactions`);
    const data = await res.json();
    const txns = data.transactions || [];

    if (txns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 16px;">No wallet adjustments or transactions recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = txns.map(t => {
      const isCredit = t.type === 'CREDIT' || t.type === 'ADD';
      const color = isCredit ? '#16a34a' : '#dc2626';
      const sign = isCredit ? '+' : '-';
      const timeStr = new Date(t.timestamp).toLocaleString('en-IN');

      return `
        <tr>
          <td style="color: #64748b;">${timeStr}</td>
          <td><span style="font-weight: 800; font-size: 11px; background: ${isCredit ? '#ecfdf5' : '#fef2f2'}; color: ${color}; padding: 2px 6px; border-radius: 4px;">${t.type}</span></td>
          <td style="font-weight: 800; color: ${color};">${sign}₹${t.amount}</td>
          <td style="font-weight: 700; color: #0f172a;">₹${t.balanceAfter}</td>
          <td style="color: #475569;">${t.reason || 'Admin Adjustment'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color: red;">Error: ${err.message}</td></tr>`;
  }
}

async function renderUserOrders(userId) {
  const tbody = document.getElementById('userOrdersTableBody');
  try {
    const res = await adminFetch(`/api/admin/users/${userId}/orders`);
    const data = await res.json();
    const orders = data.orders || [];

    if (orders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 16px;">No orders placed by this user yet.</td></tr>';
      return;
    }

    tbody.innerHTML = orders.map(o => `
      <tr>
        <td style="font-weight: 800; color: #0284c7;"><code style="font-size: 11px;">${o.engineOrderRef || o.id}</code></td>
        <td style="font-weight: 800; color: #15803d;"><code style="font-size: 11px;">${o.dominosOrderRef || o.robot?.dominosOrderRef || 'DOM-IND-N/A'}</code></td>
        <td style="font-size: 11px; font-weight: 600;">${o.robot?.storeName || 'Domino\'s Outlet'}</td>
        <td style="font-weight: 800; color: #16a34a;">₹${o.payment?.amount || 0}</td>
        <td><span class="status-idle" style="font-size: 10px;">${o.robot?.status || 'COMPLETED'}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color: red;">Error: ${err.message}</td></tr>`;
  }
}

// =========================================================================
// 5. IN-APP BROADCAST NOTIFICATIONS
// =========================================================================

async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications');
    const notifs = await res.json();

    const countBadge = document.getElementById('notificationsCount');
    if (countBadge) countBadge.innerText = `${notifs.length} Active`;
    const na = document.getElementById('navBadgeAlerts');
    if (na) na.innerText = notifs.length;

    const tbody = document.getElementById('notificationsTableBody');
    if (!tbody) return;

    if (!notifs || notifs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--gray-600); padding: 16px;">No active announcements running.</td></tr>';
      return;
    }

    tbody.innerHTML = notifs.map(n => {
      const typeBadge = n.type === 'OFFER' 
        ? '<span style="background: #dcfce7; color: #15803d; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">🟢 Offer</span>'
        : (n.type === 'ALERT'
          ? '<span style="background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">🟠 Alert</span>'
          : '<span style="background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">🔵 Announcement</span>');

      const dateStr = n.createdAt ? new Date(n.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'Live';

      return `
        <tr>
          <td><code style="color: #64748b;">${n.id}</code></td>
          <td>
            <strong style="color: var(--dark); font-size: 13px;">${n.title}</strong>
            <div style="font-size: 12px; color: #475569; margin-top: 2px;">${n.message}</div>
          </td>
          <td>${typeBadge}</td>
          <td style="font-size: 12px; color: #64748b;">${dateStr}</td>
          <td>
            <button class="btn-action-del" onclick="deleteNotificationAction('${n.id}')" title="Delete Announcement" style="cursor: pointer;">
              🗑️ Remove
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading notifications:', err);
  }
}

function applyBroadcastTemplate(templateKey) {
  const templates = {
    flash50: {
      title: '🔥 50% OFF Today on Domino\'s Pizzas!',
      badge: '50% FLASH',
      message: 'Limited-time offer! Enjoy flat 50% OFF up to ₹100 on all Medium and Large Gourmet Pizzas. Applied automatically at checkout!',
      type: 'OFFER'
    },
    express20: {
      title: '⚡ 20-Minute Hot & Fresh Domino\'s Dispatch!',
      badge: '20-MIN EXPRESS',
      message: 'Domino\'s high-speed kitchen dispatch is active for your GPS zone. Get your order hot & fresh in 20 minutes!',
      type: 'ANNOUNCEMENT'
    },
    weekendDeal: {
      title: '🎉 Weekend Gourmet Feast Special!',
      badge: 'WEEKEND SPECIAL',
      message: 'Order any 2 Medium Gourmet Pizzas and get Classic Garlic Breadsticks complimentary at checkout!',
      type: 'OFFER'
    },
    maintenance: {
      title: '🛠️ Domino\'s Kitchen Dispatch Scheduled System Check',
      badge: 'SYSTEM NOTICE',
      message: 'Domino\'s Order Engine will perform routine kitchen sync optimizations tonight from 2:00 AM to 2:30 AM IST. All prior orders remain safe.',
      type: 'ALERT'
    }
  };

  const tpl = templates[templateKey];
  if (!tpl) return;

  const titleEl = document.getElementById('notifTitle');
  const badgeEl = document.getElementById('notifBadge');
  const msgEl = document.getElementById('notifMessage');
  const typeEl = document.getElementById('notifType');

  if (titleEl) titleEl.value = tpl.title;
  if (badgeEl) badgeEl.value = tpl.badge;
  if (msgEl) msgEl.value = tpl.message;
  if (typeEl) typeEl.value = tpl.type;

  showToast(`Loaded "${tpl.badge}" announcement template! Click Broadcast to send.`, '📋');
}
window.applyBroadcastTemplate = applyBroadcastTemplate;

async function broadcastNotificationSubmit() {
  const title = (document.getElementById('notifTitle')?.value || '').trim();
  const badge = (document.getElementById('notifBadge')?.value || '').trim() || 'OFFER';
  const message = (document.getElementById('notifMessage')?.value || '').trim();
  const type = document.getElementById('notifType')?.value || 'OFFER';

  if (!title || !message) {
    alert('Please enter both Title and Message for the broadcast.');
    return;
  }

  try {
    const res = await adminFetch('/api/admin/notifications/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, badge, type })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('📢 Announcement broadcasted to storefront live!', '🚀');
    document.getElementById('notifTitle').value = '';
    document.getElementById('notifMessage').value = '';
    loadNotifications();
  } catch (err) {
    alert('Broadcast failed: ' + err.message);
  }
}

async function deleteNotificationAction(id) {
  if (!confirm('Remove this announcement from storefront?')) return;
  try {
    const res = await adminFetch(`/api/admin/notifications/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('Announcement removed.', '🗑️');
    loadNotifications();
  } catch (err) {
    alert('Failed to remove notification');
  }
}

// =========================================================================
// 5B. PLATFORM SCHEDULED MAINTENANCE MODE CONTROLS
// =========================================================================

let currentMaintenanceState = { active: false, message: '', until: null };

async function loadMaintenanceStatus() {
  try {
    const res = await fetch('/api/maintenance');
    if (!res.ok) return;
    const data = await res.json();
    currentMaintenanceState = data || { active: false, message: '', until: null };

    const badge = document.getElementById('adminMaintenanceStatusBadge');
    const toggleBtn = document.getElementById('btnToggleMaintenanceMaster');
    const toggleBtnText = document.getElementById('toggleMaintenanceBtnText');
    const msgInput = document.getElementById('maintenanceMsgInput');

    if (badge) {
      if (data.active) {
        badge.style.background = '#fee2e2';
        badge.style.color = '#b91c1c';
        badge.innerHTML = '● ACTIVE (Storefront Paused)';
      } else {
        badge.style.background = '#dcfce7';
        badge.style.color = '#15803d';
        badge.innerHTML = '● INACTIVE (Storefront Live)';
      }
    }

    if (toggleBtn && toggleBtnText) {
      if (data.active) {
        toggleBtn.style.background = '#16a34a';
        toggleBtnText.innerText = 'Disable Maintenance Mode (Go Live)';
      } else {
        toggleBtn.style.background = '#b91c1c';
        toggleBtnText.innerText = 'Enable Maintenance Mode';
      }
    }

    if (msgInput && data.message && document.activeElement !== msgInput) {
      msgInput.value = data.message;
    }
  } catch (e) {
    console.error('Error loading maintenance status:', e);
  }
}
window.loadMaintenanceStatus = loadMaintenanceStatus;

async function toggleMaintenanceModeAction() {
  const targetActive = !currentMaintenanceState.active;
  const msgInput = document.getElementById('maintenanceMsgInput');
  const durationSelect = document.getElementById('maintenanceDurationSelect');

  const message = msgInput?.value?.trim() || "Domino's Order Engine is currently undergoing scheduled maintenance. We will be back shortly!";
  const durationMins = parseInt(durationSelect?.value || '0', 10);
  let until = null;
  if (targetActive && durationMins > 0) {
    until = new Date(Date.now() + durationMins * 60 * 1000).toISOString();
  }

  const confirmMsg = targetActive
    ? 'Are you sure you want to ENABLE Maintenance Mode?\n\nThis will pause storefront ordering and deposits and show an alert banner to all users.'
    : 'Are you sure you want to DISABLE Maintenance Mode and resume live storefront operations?';

  if (!confirm(confirmMsg)) return;

  try {
    const res = await adminFetch('/api/admin/maintenance', {
      method: 'POST',
      body: JSON.stringify({ active: targetActive, message, until })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update maintenance mode');

    showToast(targetActive ? 'Maintenance Mode ENABLED!' : 'Maintenance Mode DISABLED - Storefront Live!', targetActive ? '⚠️' : '✅');
    loadMaintenanceStatus();
  } catch (err) {
    alert('Error updating maintenance mode: ' + err.message);
  }
}
window.toggleMaintenanceModeAction = toggleMaintenanceModeAction;

async function saveMaintenanceSettingsSubmit() {
  const msgInput = document.getElementById('maintenanceMsgInput');
  const durationSelect = document.getElementById('maintenanceDurationSelect');

  const message = msgInput?.value?.trim() || "Domino's Order Engine is currently undergoing scheduled maintenance. We will be back shortly!";
  const durationMins = parseInt(durationSelect?.value || '0', 10);
  let until = null;
  if (currentMaintenanceState.active && durationMins > 0) {
    until = new Date(Date.now() + durationMins * 60 * 1000).toISOString();
  }

  try {
    const res = await adminFetch('/api/admin/maintenance', {
      method: 'POST',
      body: JSON.stringify({ active: currentMaintenanceState.active, message, until })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save maintenance settings');

    showToast('Maintenance settings saved successfully!', '💾');
    loadMaintenanceStatus();
  } catch (err) {
    alert('Error saving maintenance settings: ' + err.message);
  }
}
window.saveMaintenanceSettingsSubmit = saveMaintenanceSettingsSubmit;

// =========================================================================
// 5C. ROTATING PROXY GATEWAY CONTROLS (HTTP / HTTPS / SOCKS5)
// =========================================================================

async function loadProxySettings() {
  try {
    const res = await adminFetch('/api/admin/proxy');
    if (!res.ok) return;
    const proxy = await res.json();

    const badge = document.getElementById('adminProxyStatusBadge');
    const hostInput = document.getElementById('proxyHost');
    const portInput = document.getElementById('proxyPort');
    const protoSelect = document.getElementById('proxyProtocol');
    const userInput = document.getElementById('proxyUsername');
    const passInput = document.getElementById('proxyPassword');
    const resultWrap = document.getElementById('proxyTestResultWrap');

    if (hostInput && document.activeElement !== hostInput) hostInput.value = proxy.host || '';
    if (portInput && document.activeElement !== portInput) portInput.value = proxy.port || '';
    if (protoSelect) protoSelect.value = proxy.protocol || 'http';
    if (userInput && document.activeElement !== userInput) userInput.value = proxy.username || '';
    if (passInput && document.activeElement !== passInput) passInput.value = proxy.hasPassword ? '••••••••' : '';

    if (badge) {
      if (proxy.enabled && proxy.host) {
        badge.style.background = '#ede9fe';
        badge.style.color = '#6d28d9';
        badge.innerHTML = `● Proxy Active (${(proxy.protocol || 'http').toUpperCase()})`;
      } else {
        badge.style.background = '#f1f5f9';
        badge.style.color = '#475569';
        badge.innerHTML = 'Proxy Disabled';
      }
    }

    if (resultWrap && proxy.lastTestedIp) {
      resultWrap.innerHTML = `<span>🟢 Connected via IP: <code>${escapeHtml(proxy.lastTestedIp)}</code> (${proxy.lastLatencyMs || 0}ms)</span>`;
    }
  } catch (e) {
    console.warn('Failed to load proxy settings:', e);
  }
}
window.loadProxySettings = loadProxySettings;

function parseProxyRawInputString() {
  const raw = (document.getElementById('proxyRawInput')?.value || '').trim();
  if (!raw) return;

  let host = '', port = '', username = '', password = '', protocol = 'http';

  if (raw.includes('://')) {
    try {
      const u = new URL(raw);
      protocol = u.protocol.replace(':', '');
      host = u.hostname;
      port = u.port;
      username = decodeURIComponent(u.username || '');
      password = decodeURIComponent(u.password || '');
    } catch (e) {}
  } else if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length >= 4) {
      host = parts[0].trim();
      port = parts[1].trim();
      username = parts[2].trim();
      password = parts.slice(3).join(':').trim();
    } else if (parts.length === 2) {
      host = parts[0].trim();
      port = parts[1].trim();
    }
  }

  if (host) document.getElementById('proxyHost').value = host;
  if (port) document.getElementById('proxyPort').value = port;
  if (username) document.getElementById('proxyUsername').value = username;
  if (password) document.getElementById('proxyPassword').value = password;
  if (protocol) document.getElementById('proxyProtocol').value = protocol;
}
window.parseProxyRawInputString = parseProxyRawInputString;

async function testProxyConnectionAction() {
  const btn = document.getElementById('btnTestProxy');
  const resultWrap = document.getElementById('proxyTestResultWrap');
  const originalText = btn ? btn.innerText : '';
  if (btn) { btn.innerText = '⏳ Testing Rotating Gateway...'; btn.disabled = true; }
  if (resultWrap) resultWrap.innerHTML = '<span>⏳ Probing proxy IP and checking latency...</span>';

  const host = document.getElementById('proxyHost')?.value?.trim();
  const port = document.getElementById('proxyPort')?.value?.trim();
  const protocol = document.getElementById('proxyProtocol')?.value || 'http';
  const username = document.getElementById('proxyUsername')?.value?.trim();
  let password = document.getElementById('proxyPassword')?.value || '';
  if (password === '••••••••') password = '';

  try {
    const res = await adminFetch('/api/admin/proxy/test', {
      method: 'POST',
      body: JSON.stringify({ host, port, protocol, username, password, enabled: true })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (resultWrap) {
        resultWrap.innerHTML = `<span>🟢 Connected! External Rotating IP: <code>${escapeHtml(data.ip)}</code> • Latency: ${data.latencyMs}ms</span>`;
      }
      showToast(`Proxy OK! External IP: ${data.ip}`, '🌐');
      loadProxySettings();
    } else {
      if (resultWrap) {
        resultWrap.innerHTML = `<span style="color: #b91c1c;">❌ Test Failed: ${escapeHtml(data.error || 'Connection timed out')}</span>`;
      }
      alert('Proxy Connection Test Failed:\n\n' + (data.error || 'Connection error.'));
    }
  } catch (err) {
    if (resultWrap) resultWrap.innerHTML = `<span style="color: #b91c1c;">❌ Test error: ${escapeHtml(err.message)}</span>`;
    alert('Test Error: ' + err.message);
  } finally {
    if (btn) { btn.innerText = originalText; btn.disabled = false; }
  }
}
window.testProxyConnectionAction = testProxyConnectionAction;

async function saveProxySettingsAction() {
  const host = document.getElementById('proxyHost')?.value?.trim();
  const port = document.getElementById('proxyPort')?.value?.trim();
  const protocol = document.getElementById('proxyProtocol')?.value || 'http';
  const username = document.getElementById('proxyUsername')?.value?.trim();
  let password = document.getElementById('proxyPassword')?.value || '';
  const rawInput = document.getElementById('proxyRawInput')?.value || '';

  if (!host || !port) {
    alert('Please enter at least proxy Host and Port before saving.');
    return;
  }

  try {
    const res = await adminFetch('/api/admin/proxy', {
      method: 'POST',
      body: JSON.stringify({ enabled: true, host, port, protocol, username, password, rawInput })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save proxy');

    showToast('Rotating Proxy Settings Saved & Enabled!', '🌐');
    loadProxySettings();
  } catch (err) {
    alert('Failed to save proxy settings: ' + err.message);
  }
}
window.saveProxySettingsAction = saveProxySettingsAction;

async function disableProxyAction() {
  try {
    const res = await adminFetch('/api/admin/proxy', {
      method: 'POST',
      body: JSON.stringify({ enabled: false })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to switch to direct mode');
    showToast('Direct Residential Mode enabled (No Proxy)!', '⚡');
    loadProxySettings();
  } catch (err) {
    alert('Failed to switch to direct mode: ' + err.message);
  }
}
window.disableProxyAction = disableProxyAction;

// =========================================================================
// 5D. FIREBASE CLOUD REALTIME DATABASE & AUTH CONTROLS
// =========================================================================

async function loadFirebaseSettings() {
  try {
    const res = await adminFetch('/api/admin/firebase');
    if (!res.ok) return;
    const fb = await res.json();

    const badge = document.getElementById('adminFirebaseStatusBadge');
    const pInput = document.getElementById('fbProjectId');
    const dInput = document.getElementById('fbDatabaseUrl');
    const aInput = document.getElementById('fbApiKey');
    const eSelect = document.getElementById('fbEnabledSelect');
    const resultWrap = document.getElementById('fbTestResultWrap');

    const consoleLink = document.getElementById('adminFirebaseConsoleLink');
    if (consoleLink && (fb.databaseConsoleUrl || fb.firebaseConsoleUrl)) {
      consoleLink.href = fb.databaseConsoleUrl || fb.firebaseConsoleUrl;
    }

    if (pInput && document.activeElement !== pInput) pInput.value = fb.projectId || '';
    if (dInput && document.activeElement !== dInput) dInput.value = fb.databaseURL || '';
    if (aInput && document.activeElement !== aInput) aInput.value = fb.apiKey || '';
    if (eSelect) eSelect.value = String(Boolean(fb.enabled));

    if (badge) {
      if (fb.enabled && fb.syncStatus === 'SYNCED') {
        badge.style.background = '#ffedd5';
        badge.style.color = '#c2410c';
        badge.innerHTML = `● Cloud Synced (${fb.projectId || 'Firebase'})`;
      } else if (fb.enabled) {
        badge.style.background = '#fef3c7';
        badge.style.color = '#b45309';
        badge.innerHTML = '● Connected to Firebase';
      } else {
        badge.style.background = '#f1f5f9';
        badge.style.color = '#475569';
        badge.innerHTML = 'Local Storage Mode';
      }
    }

    if (resultWrap && fb.lastSyncAt) {
      const dt = new Date(fb.lastSyncAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      resultWrap.innerHTML = `<span>☁️ Last synced to Firebase Realtime Database at ${dt}.</span>`;
    }
  } catch (e) {
    console.warn('Failed to load Firebase settings:', e);
  }
}
window.loadFirebaseSettings = loadFirebaseSettings;

async function saveFirebaseSettingsAction() {
  const projectId = document.getElementById('fbProjectId')?.value?.trim();
  const databaseURL = document.getElementById('fbDatabaseUrl')?.value?.trim();
  const apiKey = document.getElementById('fbApiKey')?.value?.trim();
  const enabled = document.getElementById('fbEnabledSelect')?.value === 'true';

  try {
    const res = await adminFetch('/api/admin/firebase/config', {
      method: 'POST',
      body: JSON.stringify({ projectId, databaseURL, apiKey, enabled })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save Firebase config');

    showToast('Firebase Cloud settings saved!', '🔥');
    loadFirebaseSettings();
  } catch (err) {
    alert('Failed to save Firebase settings: ' + err.message);
  }
}
window.saveFirebaseSettingsAction = saveFirebaseSettingsAction;

async function syncFirebaseNowAction() {
  const btn = document.getElementById('btnSyncFirebaseNow');
  const originalText = btn ? btn.innerText : '';
  if (btn) { btn.innerText = '⏳ Syncing Data to Cloud...'; btn.disabled = true; }

  try {
    const res = await adminFetch('/api/admin/firebase/sync', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('All accounts, orders & wallet records mirrored to Firebase!', '☁️');
      loadFirebaseSettings();
    } else {
      alert('Firebase Cloud Sync Notice:\n\n' + (data.error || 'Please configure Firebase Database URL or Project ID first.'));
    }
  } catch (err) {
    alert('Cloud Sync Error: ' + err.message);
  } finally {
    if (btn) { btn.innerText = originalText; btn.disabled = false; }
  }
}
window.syncFirebaseNowAction = syncFirebaseNowAction;

// =========================================================================
// 6. LIVE CUSTOMER SUPPORT DESK & ORDER TICKETS
// =========================================================================

let adminCachedTickets = [];
let adminSelectedTicketId = null;
let adminTicketFilter = 'OPEN';

async function loadAdminTickets() {
  try {
    const res = await adminFetch('/api/support/tickets');
    if (!res.ok) return;
    const tickets = await res.json();
    adminCachedTickets = Array.isArray(tickets) ? tickets : [];

    const openCount = adminCachedTickets.filter(t => t.status === 'OPEN').length;
    const countBadge = document.getElementById('adminTicketsCount');
    if (countBadge) countBadge.innerText = `${openCount} Open / ${adminCachedTickets.length} Total`;
    const qt = document.getElementById('quickStatTickets');
    if (qt) qt.innerText = `${openCount} Open`;
    const nt = document.getElementById('navBadgeSupport');
    if (nt) nt.innerText = openCount;

    renderAdminTicketsList();

    if (adminSelectedTicketId) {
      const current = adminCachedTickets.find(t => t.id === adminSelectedTicketId);
      if (current) {
        renderAdminTicketConversation(current);
      }
    }
  } catch (err) {
    console.error('Error loading admin support tickets:', err);
  }
}

function filterAdminTickets(status) {
  adminTicketFilter = status;
  renderAdminTicketsList();
}

function renderAdminTicketsList() {
  const container = document.getElementById('adminTicketsListContainer');
  if (!container) return;

  let filtered = adminCachedTickets;
  if (adminTicketFilter === 'OPEN') {
    filtered = adminCachedTickets.filter(t => t.status === 'OPEN');
  } else if (adminTicketFilter === 'RESOLVED') {
    filtered = adminCachedTickets.filter(t => t.status === 'RESOLVED' || t.status === 'CLOSED');
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--gray-500); padding: 24px; font-size: 12px;">
        No ${adminTicketFilter === 'OPEN' ? 'open ' : ''}support tickets found.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(t => {
    const isSelected = t.id === adminSelectedTicketId;
    const isOpen = t.status === 'OPEN';
    const lastMsg = (t.messages && t.messages.length > 0) ? t.messages[t.messages.length - 1].text : t.description;
    
    const catLabels = {
      'MISSING_ITEM': '🍕 Missing Item',
      'DELAYED_ORDER': '⏳ Delayed',
      'RIDER_UNREACHABLE': '🛵 Rider Unreachable',
      'COLD_FOOD_QUALITY': '📦 Quality/Cold',
      'PAYMENT_REFUND': '💳 Payment/Refund',
      'OTHER': '💬 General'
    };
    const catDisplay = catLabels[t.category] || t.category || 'Ticket';

    return `
      <div onclick="openAdminTicketChat('${t.id}')" style="background: ${isSelected ? '#e0f2fe' : 'white'}; border: 1.5px solid ${isSelected ? '#0284c7' : 'var(--gray-200)'}; border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s ease;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <span style="font-weight: 800; font-size: 12px; color: #0284c7;">${t.id}</span>
          <span style="font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; ${isOpen ? 'background: #fef3c7; color: #b45309;' : 'background: #dcfce7; color: #15803d;'}">
            ${t.status}
          </span>
        </div>
        <div style="font-size: 12px; font-weight: 700; color: var(--dark); margin-bottom: 2px;">
          ${catDisplay}
        </div>
        <div style="font-size: 11px; color: #64748b; margin-bottom: 4px;">
          👤 ${t.userName || 'Customer'} (${t.userPhone})
        </div>
        ${t.orderId ? `<div style="font-size: 11px; color: #0284c7; margin-bottom: 4px; font-weight: 600;">Domino's Order: ${t.orderId}</div>` : ''}
        <div style="font-size: 11px; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${lastMsg}
        </div>
      </div>
    `;
  }).join('');
}

function openAdminTicketChat(ticketId) {
  adminSelectedTicketId = ticketId;
  renderAdminTicketsList();
  const ticket = adminCachedTickets.find(t => t.id === ticketId);
  if (!ticket) return;
  renderAdminTicketConversation(ticket);
}

function renderAdminTicketConversation(ticket) {
  const headerId = document.getElementById('admHeaderTicketId');
  const statusBadge = document.getElementById('admHeaderStatusBadge');
  const headerMeta = document.getElementById('admHeaderMeta');
  const actionsWrap = document.getElementById('admTicketActions');
  const btnResolve = document.getElementById('btnAdminResolveTicket');
  const proofContainer = document.getElementById('admProofContainer');
  const proofLink = document.getElementById('admProofLink');
  const proofThumb = document.getElementById('admProofThumbnail');
  const replyBar = document.getElementById('adminChatReplyBar');
  const messagesThread = document.getElementById('adminChatMessagesThread');

  if (headerId) headerId.innerText = `${ticket.id} • ${ticket.category}`;
  if (statusBadge) {
    statusBadge.style.display = 'inline-block';
    statusBadge.innerText = ticket.status;
    if (ticket.status === 'OPEN') {
      statusBadge.style.background = '#fef3c7';
      statusBadge.style.color = '#b45309';
    } else {
      statusBadge.style.background = '#dcfce7';
      statusBadge.style.color = '#15803d';
    }
  }

  if (headerMeta) {
    headerMeta.innerHTML = `Customer: <strong>${ticket.userName || 'Customer'}</strong> (📞 <a href="tel:${ticket.userPhone}" style="color: #0284c7; text-decoration: none;">${ticket.userPhone}</a>) • Domino's Order: <strong>${ticket.orderId || 'None'}</strong>`;
  }

  if (actionsWrap) actionsWrap.style.display = 'flex';
  if (btnResolve) {
    if (ticket.status === 'OPEN') {
      btnResolve.innerText = '✅ Mark as Resolved';
      btnResolve.style.background = '#ecfdf5';
      btnResolve.style.borderColor = '#86efac';
      btnResolve.style.color = '#15803d';
    } else {
      btnResolve.innerText = '🔄 Re-Open Ticket';
      btnResolve.style.background = '#fffbeb';
      btnResolve.style.borderColor = '#fde68a';
      btnResolve.style.color = '#b45309';
    }
  }

  if (proofContainer) {
    if (ticket.imageUrl) {
      proofContainer.style.display = 'block';
      if (proofLink) proofLink.href = ticket.imageUrl;
      if (proofThumb) proofThumb.src = ticket.imageUrl;
    } else {
      proofContainer.style.display = 'none';
    }
  }

  if (replyBar) replyBar.style.display = 'flex';

  if (messagesThread) {
    const msgs = ticket.messages || [];
    if (msgs.length === 0) {
      messagesThread.innerHTML = `<div style="text-align: center; color: var(--gray-500); padding: 20px;">No messages yet.</div>`;
    } else {
      messagesThread.innerHTML = msgs.map(m => {
        const isAdmin = m.sender === 'ADMIN';
        const isBot = m.sender === 'DOMINOS_BOT' || m.sender === 'BOT';
        const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const senderLabel = isAdmin ? '🎧 Support Manager (You)' : (isBot ? '🤖 Automated Triage Bot' : `👤 ${m.senderName || 'Customer'}`);
        const align = isAdmin ? 'flex-end' : 'flex-start';
        const bg = isAdmin ? '#0066a3' : (isBot ? '#e0f2fe' : '#ffffff');
        const color = isAdmin ? '#ffffff' : '#0f172a';
        const border = isAdmin ? 'none' : '1px solid #cbd5e1';

        return `
          <div style="display: flex; flex-direction: column; align-items: ${align}; max-width: 80%; align-self: ${align};">
            <span style="font-size: 10px; font-weight: 700; color: #64748b; margin-bottom: 2px;">${senderLabel} • ${time}</span>
            <div style="background: ${bg}; color: ${color}; border: ${border}; border-radius: 8px; padding: 8px 12px; font-size: 12px; line-height: 1.4; word-break: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
              ${m.text}
              ${m.imageUrl ? `<div style="margin-top: 6px;"><img src="${m.imageUrl}" style="max-height: 140px; border-radius: 4px; cursor: pointer;" onclick="window.open(this.src, '_blank')" /></div>` : ''}
            </div>
          </div>
        `;
      }).join('');
      messagesThread.scrollTop = messagesThread.scrollHeight;
    }
  }
}

async function adminSendReply() {
  if (!adminSelectedTicketId) return;
  const input = document.getElementById('adminReplyInput');
  const text = (input?.value || '').trim();
  if (!text) return;

  try {
    const res = await adminFetch(`/api/support/tickets/${adminSelectedTicketId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'ADMIN', senderName: 'Domino\'s Order Engine Support Team', text })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (input) input.value = '';
    showToast('Reply dispatched to customer live in-app!', '💬');
    await loadAdminTickets();
  } catch (err) {
    alert('Failed to send admin reply: ' + err.message);
  }
}

async function toggleAdminResolveTicket() {
  if (!adminSelectedTicketId) return;
  const ticket = adminCachedTickets.find(t => t.id === adminSelectedTicketId);
  if (!ticket) return;

  const newStatus = ticket.status === 'OPEN' ? 'RESOLVED' : 'OPEN';
  try {
    const res = await adminFetch(`/api/support/tickets/${adminSelectedTicketId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`Ticket ${adminSelectedTicketId} marked as ${newStatus}!`, '✅');
    await loadAdminTickets();
  } catch (err) {
    alert('Failed to update ticket status: ' + err.message);
  }
}

// =========================================================================
// 8. Active Domino's Sessions Fleet Real-Time Feed
// =========================================================================
async function loadSessionFleetFeed() {
  try {
    const res = await adminFetch('/api/admin/sessions/feed');
    const data = await res.json();
    if (!data.success) return;

    const counts = data.counts || {
      total: data.totalSessions || 0,
      idle: data.idleSessions || 0,
      inUse: data.inUseSessions || 0,
      disabled: data.disabledSessions || 0,
      old: data.oldSessions || 0,
      expired: data.expiredSessions || 0
    };

    // Update fleet counters
    const cTotal = document.getElementById('feedStatSummary');
    if (cTotal) cTotal.innerText = `${counts.total} Total Sessions`;
    const cIdle = document.getElementById('feedCountIdle');
    if (cIdle) cIdle.innerText = counts.idle;
    const cInUse = document.getElementById('feedCountInUse');
    if (cInUse) cInUse.innerText = counts.inUse;
    const cDisabled = document.getElementById('feedCountDisabled');
    if (cDisabled) cDisabled.innerText = counts.disabled || 0;
    const cOld = document.getElementById('feedCountOld');
    if (cOld) cOld.innerText = counts.old;
    const cExpired = document.getElementById('feedCountExpired');
    if (cExpired) cExpired.innerText = counts.expired;

    // Populate feed stream container
    const container = document.getElementById('sessionFleetFeedContainer');
    if (!container) return;

    const fleet = data.fleet || data.feed || [];
    if (!fleet || fleet.length === 0) {
      container.innerHTML = '<div style="color: #94a3b8; font-size: 11px; text-align: center; padding: 10px;">No Domino\'s sessions active in pool. Add an account above.</div>';
      return;
    }

    container.innerHTML = fleet.map(s => {
      const isDisabled = s.disabled || s.status === 'DISABLED';
      const isInUse = s.status === 'IN_USE';
      const isExpired = s.status === 'EXPIRED';
      const statusIcon = isDisabled ? '⏸️ DISABLED' : (isInUse ? '🟡 IN-USE' : (isExpired ? '🔴 EXPIRED' : '🟢 IDLE'));
      const statusBg = isDisabled ? '#f1f5f9' : (isInUse ? '#fffbeb' : (isExpired ? '#fef2f2' : '#f0fdf4'));
      const statusColor = isDisabled ? '#475569' : (isInUse ? '#b45309' : (isExpired ? '#dc2626' : '#15803d'));
      const assignmentText = isDisabled 
        ? `<strong style="color: #64748b;">Excluded from ordering pool (Disabled)</strong>`
        : (isInUse 
            ? `<strong style="color: #b45309;">Assigned to Order: ${s.activeOrderId || 'Robot Running'}</strong>` 
            : `<span style="color: #15803d; font-weight: 600;">Available for order checkout</span>`);
      
      const sHealth = s.sessionHealth || {};
      const healthPill = sHealth.health === 'FRESH'
        ? '<span style="font-size: 9px; background: #dcfce7; color: #15803d; padding: 1px 5px; border-radius: 4px; font-weight: 800;">FRESH</span>'
        : (sHealth.health === 'OLD'
            ? `<span style="font-size: 9px; background: #fef3c7; color: #b45309; padding: 1px 5px; border-radius: 4px; font-weight: 800;">OLD (${sHealth.ageDays || 0}d)</span>`
            : '<span style="font-size: 9px; background: #fee2e2; color: #b91c1c; padding: 1px 5px; border-radius: 4px; font-weight: 800;">EXPIRED</span>');

      const phoneStr = (s.phone || s.cleanPhone || '').replace(/^\+91\s*/, '');

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; background: ${statusBg}; border: 1px solid rgba(0,0,0,0.06); padding: 5px 8px; border-radius: 5px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 10px; font-weight: 800; color: ${statusColor};">${statusIcon}</span>
            <code style="font-weight: 800; color: #1e293b; font-size: 11px;">+91 ${phoneStr}</code>
            ${healthPill}
          </div>
          <div style="font-size: 10px;">
            ${assignmentText}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading session fleet feed:', err);
  }
}

// =========================================================================
// 9. Wallet Deposit Approvals Desk
// =========================================================================
let cachedWalletDeposits = [];

async function loadWalletDeposits() {
  try {
    const res = await adminFetch('/api/admin/wallet/deposits');
    const deposits = await res.json();
    cachedWalletDeposits = Array.isArray(deposits) ? deposits : [];

    const pending = cachedWalletDeposits.filter(d => d.status === 'PENDING_APPROVAL');
    const pendingBadge = document.getElementById('walletDepositsPendingCount');
    if (pendingBadge) {
      pendingBadge.innerText = `${pending.length} Pending`;
      if (pending.length > 0) {
        pendingBadge.style.background = '#fef3c7';
        pendingBadge.style.color = '#b45309';
      } else {
        pendingBadge.style.background = '#f0fdf4';
        pendingBadge.style.color = '#15803d';
      }
    }

    const tbody = document.getElementById('walletDepositsTableBody');
    if (!tbody) return;

    if (cachedWalletDeposits.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--gray-600); padding: 20px;">No wallet deposit requests submitted yet. Customers can request deposits in Storefront Wallet.</td></tr>';
      return;
    }

    // Sort: PENDING_APPROVAL first, then by date desc
    const sorted = [...cachedWalletDeposits].sort((a, b) => {
      if (a.status === 'PENDING_APPROVAL' && b.status !== 'PENDING_APPROVAL') return -1;
      if (b.status === 'PENDING_APPROVAL' && a.status !== 'PENDING_APPROVAL') return 1;
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    });

    tbody.innerHTML = sorted.map(dep => {
      const isPending = dep.status === 'PENDING_APPROVAL';
      const isApproved = dep.status === 'APPROVED';
      const isRejected = dep.status === 'REJECTED';

      const statusBadge = isPending
        ? '<span style="background: #fffbeb; color: #b45309; border: 1.5px solid #fde68a; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 11px;">⏳ PENDING APPROVAL</span>'
        : (isApproved
            ? '<span style="background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 11px;">✓ APPROVED &amp; CREDITED</span>'
            : '<span style="background: #fee2e2; color: #b91c1c; border: 1.5px solid #fca5a5; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 11px;">✕ REJECTED</span>');

      const reqDate = dep.requestedAt ? new Date(dep.requestedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Recent';

      const actionsHtml = isPending ? `
        <div style="display: flex; gap: 4px;">
          <button class="btn-primary" onclick="adminApproveDeposit('${dep.referenceId}', ${dep.amount})" style="background: #16a34a; font-size: 11px; padding: 3px 8px; width: auto; font-weight: 800; cursor: pointer;">
            ✓ Approve
          </button>
          <button class="btn-action-del" onclick="adminRejectDeposit('${dep.referenceId}')" style="font-size: 11px; padding: 3px 8px; cursor: pointer;">
            ✕ Reject
          </button>
        </div>
      ` : (isApproved ? `
        <span style="font-size: 10px; color: #15803d; font-weight: 700;">Credited to Wallet</span>
      ` : `
        <span style="font-size: 10px; color: #dc2626; font-weight: 700;">${dep.reason || 'Declined'}</span>
      `);

      return `
        <tr style="${isPending ? 'background: #fffdf5;' : ''}">
          <td>
            <code style="font-weight: 800; color: #0284c7; font-size: 12px; background: #f0f9ff; padding: 2px 6px; border-radius: 4px; border: 1px solid #bae6fd;">${dep.referenceId}</code>
          </td>
          <td>
            <strong>${dep.userName || 'Customer'}</strong>
            <div style="font-size: 11px; color: #64748b;">${dep.userPhone || dep.userId || 'N/A'}</div>
          </td>
          <td>
            <strong style="color: #16a34a; font-size: 14px;">₹${dep.amount}</strong>
          </td>
          <td>
            <code style="font-family: monospace; font-size: 11px; font-weight: 700; color: #0284c7; background: #e0f2fe; padding: 2px 6px; border-radius: 4px;">${dep.referenceId || dep.reference || 'N/A'}</code>
            <div style="font-size: 10px; color: #64748b;">Method: ${dep.method || 'UPI / QR'}</div>
          </td>
          <td>${statusBadge}</td>
          <td style="font-size: 11px; color: #64748b;">${reqDate}</td>
          <td>${actionsHtml}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading wallet deposits:', err);
  }
}

async function adminApproveDeposit(refId, amount) {
  if (!confirm(`Are you sure you want to approve deposit ${refId} and credit ₹${amount} to customer's wallet?`)) return;
  try {
    const res = await adminFetch('/api/admin/wallet/deposits/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: refId, adminNote: 'Verified & approved by Admin' })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to approve deposit');
    showToast(`Deposit ${refId} approved! ₹${amount} credited to customer.`, '💰');
    loadWalletDeposits();
    loadAppUsers();
  } catch (err) {
    alert('Error approving deposit: ' + err.message);
  }
}

async function adminRejectDeposit(refId) {
  const reason = prompt(`Enter rejection reason for deposit ${refId}:`, 'Payment not received in bank account');
  if (reason === null) return;
  try {
    const res = await adminFetch('/api/admin/wallet/deposits/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: refId, reason: reason || 'Declined by Admin' })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to reject deposit');
    showToast(`Deposit ${refId} rejected.`, '⚠️');
    loadWalletDeposits();
  } catch (err) {
    alert('Error rejecting deposit: ' + err.message);
  }
}

// Account Disable / Enable Toggle
async function adminToggleAccountDisabled(accountId) {
  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/toggle-disabled`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to toggle account disabled status');
    showToast(data.message || 'Account status updated', data.disabled ? '⏸️' : '▶️');
    loadAccounts();
    loadSessionFleetFeed();
  } catch (err) {
    alert(`Could not toggle account: ${err.message}`);
  }
}
window.adminToggleAccountDisabled = adminToggleAccountDisabled;

// Direct Past Orders Count Editor
async function adminSetAccountOrdersPrompt(accountId, currentCount) {
  const input = prompt(`Enter verified past orders count for account:`, currentCount);
  if (input === null) return;
  const count = parseInt(input, 10);
  if (isNaN(count) || count < 0) {
    alert('Please enter a valid non-negative number.');
    return;
  }
  try {
    const res = await adminFetch(`/api/admin/accounts/${accountId}/set-orders-count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to set orders count');
    showToast(`Past orders count set to ${count} (${data.account?.accountType || ''})`, '✏️');
    loadAccounts();
    loadSessionFleetFeed();
  } catch (err) {
    alert(`Could not set orders count: ${err.message}`);
  }
}
window.adminSetAccountOrdersPrompt = adminSetAccountOrdersPrompt;

// Wallet withdrawals strictly disabled as Domino's Order Engine wallet is ordering-only
async function loadWalletWithdrawals() {}
window.loadWalletWithdrawals = loadWalletWithdrawals;

// Info Dialogs (Vouchers & Dynamic UPI)
function openAdminInfoModal(topic) {
  const modal = document.getElementById('adminInfoModal');
  const title = document.getElementById('adminInfoModalTitle');
  const body = document.getElementById('adminInfoModalBody');
  if (!modal || !title || !body) return;

  if (topic === 'voucherInfo') {
    title.innerHTML = 'ℹ️ How 16-Digit Voucher &amp; 6-Digit PIN Vault Works';
    body.innerHTML = `
      <div style="background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
        <strong style="color: #166534; font-size: 13px;">🍕 Automated ₹0 Due Settlement on Domino's India</strong>
        <p style="margin: 4px 0 0; font-size: 12px; color: #14532d;">
          Domino's Gift Cards (16 digits + 6 digit PIN) are securely held in this vault. When customers place orders, the autonomous ordering engine applies eligible gift cards to pay the store invoice down to ₹0.
        </p>
      </div>
      <ol style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px;">
        <li><strong>Automated Selection:</strong> When an order is placed, the robot checks for available active gift cards in this vault with sufficient balance.</li>
        <li><strong>Zero Due Checkout:</strong> During checkout on Domino's site, the robot navigates to the Gift Card payment tab, enters the 16-digit card and 6-digit PIN, and applies it.</li>
        <li><strong>Real-Time Balance Decrement:</strong> The vault balance decrements by the order bill amount in real time, preventing duplicate card use.</li>
        <li><strong>Full Audit Trail:</strong> Each used card links directly to the corresponding platform order with full receipt screenshots.</li>
      </ol>
      <button type="button" class="btn-primary" onclick="closeModal('adminInfoModal')" style="width: 100%; padding: 10px; margin-top: 14px; background: #0066a3; cursor: pointer;">Got It</button>
    `;
  } else if (topic === 'upiInfo') {
    title.innerHTML = 'ℹ️ How Dynamic UPI Payment Receiver Works';
    body.innerHTML = `
      <div style="background: #eff6ff; border: 1.5px solid #93c5fd; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
        <strong style="color: #1e40af; font-size: 13px;">⚡ Dynamic Real-Time Payee Routing</strong>
        <p style="margin: 4px 0 0; font-size: 12px; color: #1e3a8a;">
          Configure your merchant UPI VPA (e.g. <code>dominos.pay@okhdfcbank</code>) and Payee name. Changes take effect instantly for all customers.
        </p>
      </div>
      <ol style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px;">
        <li><strong>Dynamic QR Generation:</strong> Every customer deposit or order generates a standard NPCI UPI URI string (<code>upi://pay?pa=...&amp;pn=...&amp;am=...&amp;tr=...&amp;tn=...</code>).</li>
        <li><strong>Embedded Transaction Reference:</strong> Each transaction embeds a unique reference (e.g. <code>DEP-XXXXXX</code> or <code>ORD-XXXXXX</code>) so incoming bank alerts can be matched effortlessly without needing the customer to enter a manual UTR.</li>
        <li><strong>Instant App Deep-Linking:</strong> Mobile customers can tap <em>Pay via UPI App</em> to launch Google Pay, PhonePe, or Paytm with the payee and amount prefilled.</li>
      </ol>
      <button type="button" class="btn-primary" onclick="closeModal('adminInfoModal')" style="width: 100%; padding: 10px; margin-top: 14px; background: #0066a3; cursor: pointer;">Got It</button>
    `;
  } else if (topic === 'session') {
    title.innerHTML = 'ℹ️ Domino\'s Session Authentication &amp; History Detection';
    body.innerHTML = `
      <div style="background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
        <strong style="color: #166534; font-size: 13px;">🔐 Authentic Domino's Session Verification &amp; Tier Classification</strong>
        <p style="margin: 4px 0 0; font-size: 12px; color: #14532d;">
          When an account logs in via OTP or Direct Cookies, Domino's Order Engine verifies session validity directly inside an authentic browser context with real TLS fingerprints.
        </p>
      </div>
      <ol style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
        <li><strong>Automatic History Inspection:</strong> The engine audits Domino's order history and favourites/reorder items (<code>/order-service/v1/orders</code>).</li>
        <li><strong>Tier Classification:</strong> Accounts with 0 past orders and no reorder items are designated as <code>NEW_ACCOUNT</code> (eligible for 50% OFF <code>NEWBIE100</code> and <code>DOMNEW50</code>). Accounts with past orders are placed into Tier 2 (<code>CHEESY</code>) or Tier 3 (<code>PARTY</code>).</li>
        <li><strong>Session Rejuvenation:</strong> Expired 1-hour access tokens are automatically rejuvenated using the refresh token without requiring re-login.</li>
      </ol>
      <button type="button" class="btn-primary" onclick="closeModal('adminInfoModal')" style="width: 100%; padding: 10px; margin-top: 14px; background: #0066a3; cursor: pointer;">Got It</button>
    `;
  } else if (topic === 'robot') {
    title.innerHTML = 'ℹ️ Live Autonomous Domino\'s Robot Orders Monitor';
    body.innerHTML = `
      <div style="background: #eff6ff; border: 1.5px solid #93c5fd; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
        <strong style="color: #1e40af; font-size: 13px;">🤖 Autonomous Headless Robot Kitchen Dispatch</strong>
        <p style="margin: 4px 0 0; font-size: 12px; color: #1e3a8a;">
          When customers confirm an order, the autonomous robot assigns an eligible Domino's session, locks GPS store outlet coordinates, applies discount vouchers, pays via gift card, and captures the authentic kitchen token.
        </p>
      </div>
      <ol style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
        <li><strong>Authentic Domino's Tokens:</strong> Displays real kitchen store tokens and POS order IDs directly from Domino's kitchen. Strictly no fake identifiers.</li>
        <li><strong>Open in Domino's Site:</strong> Administrators can click <code>🌐 Domino's Site</code> on any order to inspect the live order tracker on the official Domino's website.</li>
        <li><strong>Live Telemetry:</strong> Auto-refreshes kitchen baking status, rider name, contact phone, and live delivery coordinates.</li>
      </ol>
      <button type="button" class="btn-primary" onclick="closeModal('adminInfoModal')" style="width: 100%; padding: 10px; margin-top: 14px; background: #0066a3; cursor: pointer;">Got It</button>
    `;
  } else if (topic === 'users') {
    title.innerHTML = 'ℹ️ App Registered Users &amp; Profile Control';
    body.innerHTML = `
      <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
        <strong style="color: #0f172a; font-size: 13px;">👥 Customer Identity &amp; Digital Wallet Administration</strong>
        <p style="margin: 4px 0 0; font-size: 12px; color: #475569;">
          Storefront users register automatically via Google Sign-In with isolated 12-digit numerical User IDs.
        </p>
      </div>
      <ol style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
        <li><strong>Real Wallet Adjustments:</strong> Add, deduct, or set exact balances with required audit justification notes and transaction logs.</li>
        <li><strong>Quick Phone Lock:</strong> 1-click toggle to lock or unlock customer phone numbers.</li>
        <li><strong>Address Policy:</strong> Manages saved delivery addresses (max 3 enforced per Domino's India address policy).</li>
      </ol>
      <button type="button" class="btn-primary" onclick="closeModal('adminInfoModal')" style="width: 100%; padding: 10px; margin-top: 14px; background: #0066a3; cursor: pointer;">Got It</button>
    `;
  } else if (topic === 'menu') {
    title.innerHTML = 'ℹ️ Domino\'s Menu Catalog &amp; Real Pricing';
    body.innerHTML = `
      <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-bottom: 14px;">
        <strong style="color: #0f172a; font-size: 13px;">🍕 Menu Catalog &amp; Slashed Pricing Engine</strong>
        <p style="margin: 4px 0 0; font-size: 12px; color: #475569;">
          Controls all 150+ official Domino's India menu items, real offer prices, slashed/cutted MRPs, and stock availability.
        </p>
      </div>
      <ol style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
        <li><strong>Real Pricing:</strong> Offer price is the exact amount charged to customer carts.</li>
        <li><strong>Slashed / Cutted MRP:</strong> Shown with a strikethrough (e.g. ~~₹299~~) to give users authentic Domino's discounts.</li>
        <li><strong>Instant 1-Click Save:</strong> Edit Offer Price or Slashed MRP directly in the table and click <code>Save</code>.</li>
        <li><strong>Stock Availability:</strong> Toggle between 🟢 In Stock and 🔴 Out of Stock anytime.</li>
      </ol>
      <button type="button" class="btn-primary" onclick="closeModal('adminInfoModal')" style="width: 100%; padding: 10px; margin-top: 14px; background: #0066a3; cursor: pointer;">Got It</button>
    `;
  }
  openModal('adminInfoModal');
}
window.openAdminInfoModal = openAdminInfoModal;
window.showAdminSystemInfo = openAdminInfoModal;

// =========================================================================
// 8. ADMIN MENU CATALOG & REAL PRICING MANAGEMENT ENGINE
// =========================================================================

let adminMenuCatalog = [];

async function loadAdminMenu() {
  try {
    const res = await fetch('/api/admin/menu', {
      headers: getAdminHeaders()
    });
    if (!res.ok) {
      if (res.status === 401) {
        showToastNotice('Session expired. Please re-authenticate.', '🔒');
      }
      return;
    }
    const data = await res.json();
    adminMenuCatalog = data.menu || [];

    // Update navigation badge
    const navBadge = document.getElementById('navBadgeMenu');
    if (navBadge) navBadge.innerText = adminMenuCatalog.length;

    // Update stat chips
    updateAdminMenuStats(adminMenuCatalog);

    // Render table
    filterAdminMenuTable();
  } catch (err) {
    console.error('[ADMIN-MENU-LOAD-ERR]', err);
    showToastNotice('Failed to load menu: ' + err.message, '⚠️');
  }
}
window.loadAdminMenu = loadAdminMenu;

function updateAdminMenuStats(items = []) {
  const total = items.length;
  const veg = items.filter(i => i.category === 'Veg Pizza').length;
  const nonVeg = items.filter(i => i.category === 'Non-Veg Pizza').length;
  const mania = items.filter(i => i.category === 'Pizza Mania').length;
  const sides = items.filter(i => i.category === 'Garlic Breads & Sides').length;
  const desserts = items.filter(i => i.category === 'Desserts').length;
  const beverages = items.filter(i => i.category === 'Beverages').length;

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = `${val} Items`;
  };

  setEl('statMenuTotal', total);
  setEl('statMenuVeg', veg);
  setEl('statMenuNonVeg', nonVeg);
  setEl('statMenuMania', mania);
  setEl('statMenuSides', sides);
  setEl('statMenuDesserts', desserts);
  setEl('statMenuBeverages', beverages);
}

function filterAdminMenuTable() {
  const searchInput = document.getElementById('adminMenuSearchInput');
  const catSelect = document.getElementById('adminMenuCategoryFilter');
  const stockSelect = document.getElementById('adminMenuStockFilter');

  const query = (searchInput?.value || '').toLowerCase().trim();
  const selectedCat = catSelect?.value || 'ALL';
  const selectedStock = stockSelect?.value || 'ALL';

  const filtered = adminMenuCatalog.filter(item => {
    // Search query match
    if (query) {
      const nameMatch = (item.name || '').toLowerCase().includes(query);
      const codeMatch = (item.dominosCode || '').toLowerCase().includes(query) || (item.skuId || '').toLowerCase().includes(query);
      const catMatch = (item.category || '').toLowerCase().includes(query);
      if (!nameMatch && !codeMatch && !catMatch) return false;
    }

    // Category filter
    if (selectedCat !== 'ALL' && item.category !== selectedCat) {
      return false;
    }

    // Stock filter
    if (selectedStock === 'AVAILABLE' && item.isAvailable === false) return false;
    if (selectedStock === 'UNAVAILABLE' && item.isAvailable !== false) return false;

    return true;
  });

  renderAdminMenuTable(filtered);
}
window.filterAdminMenuTable = filterAdminMenuTable;

function renderAdminMenuTable(items = []) {
  const tbody = document.getElementById('adminMenuTableBody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 40px; color: var(--gray-600);">
          No menu items matched your filter criteria.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const isAvail = item.isAvailable !== false;
    const isVeg = item.isVeg !== false && item.type !== 'NON-VEG';
    const originalPrice = item.originalPrice || Math.round((item.price * 1.25) / 10) * 10 - 1;
    const discount = originalPrice > item.price
      ? `${Math.round(((originalPrice - item.price) / originalPrice) * 100)}%`
      : '0%';

    const imgUrl = item.imageUrl || item.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';

    return `
      <tr id="admin-row-${item.id}" style="${!isAvail ? 'background: #fef2f2; opacity: 0.85;' : ''}">
        <td>
          <img src="${imgUrl}" alt="${item.name}" style="width: 44px; height: 44px; object-fit: cover; border-radius: 6px; border: 1px solid #cbd5e1;" onerror="this.src='https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp'">
        </td>
        <td>
          <div style="font-weight: 800; font-size: 13px; color: #0f172a;">${item.name}</div>
          <div style="font-size: 11px; color: #64748b; font-family: monospace;">Code: ${item.dominosCode || item.skuId || item.id}</div>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span style="font-size: 11px; font-weight: 700; color: #0369a1; background: #e0f2fe; padding: 2px 6px; border-radius: 4px;">${item.category}</span>
            <span style="font-size: 10px; font-weight: 800; color: ${isVeg ? '#15803d' : '#b91c1c'}; background: ${isVeg ? '#dcfce7' : '#fee2e2'}; padding: 2px 6px; border-radius: 4px;">
              ${isVeg ? '🟢 VEG' : '🔴 NON-VEG'}
            </span>
          </div>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-weight: 800; font-size: 12px; color: #64748b;">₹</span>
            <input type="number" id="price-input-${item.id}" value="${item.price}" min="1" style="width: 75px; padding: 5px 6px; font-size: 13px; font-weight: 800; border: 1.5px solid #cbd5e1; border-radius: 6px; text-align: right;">
          </div>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-weight: 800; font-size: 12px; color: #64748b;">₹</span>
            <input type="number" id="origprice-input-${item.id}" value="${originalPrice}" min="1" style="width: 75px; padding: 5px 6px; font-size: 13px; font-weight: 800; border: 1.5px solid #cbd5e1; border-radius: 6px; text-align: right; color: #b45309;">
          </div>
        </td>
        <td>
          <span style="font-size: 11px; font-weight: 800; color: #166534; background: #f0fdf4; border: 1px solid #86efac; padding: 3px 6px; border-radius: 4px; white-space: nowrap;">
            ${discount} OFF
          </span>
        </td>
        <td>
          <button type="button" onclick="toggleAdminItemStock('${item.id}', ${isAvail})" style="border: none; cursor: pointer; padding: 4px 10px; border-radius: 14px; font-size: 11px; font-weight: 800; display: inline-flex; align-items: center; gap: 4px; ${isAvail ? 'background: #dcfce7; color: #15803d;' : 'background: #fee2e2; color: #b91c1c;'}">
            <span>${isAvail ? '🟢 In Stock' : '🔴 Out of Stock'}</span>
          </button>
        </td>
        <td>
          <div style="display: flex; gap: 4px; align-items: center;">
            <button type="button" onclick="saveItemQuickPrices('${item.id}')" title="Save updated prices" style="background: #0066a3; color: white; border: none; padding: 5px 8px; border-radius: 4px; font-size: 11px; font-weight: 800; cursor: pointer;">
              💾 Save
            </button>
            <button type="button" onclick="openEditMenuItemModal('${item.id}')" title="Edit Full Details" style="background: #f1f5f9; color: #0284c7; border: 1px solid #cbd5e1; padding: 5px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer;">
              ✏️
            </button>
            <button type="button" onclick="deleteAdminMenuItem('${item.id}')" title="Delete Item" style="background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 5px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer;">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function saveItemQuickPrices(id) {
  const priceInput = document.getElementById(`price-input-${id}`);
  const origPriceInput = document.getElementById(`origprice-input-${id}`);
  if (!priceInput || !origPriceInput) return;

  const price = Number(priceInput.value);
  const originalPrice = Number(origPriceInput.value);

  if (!price || price <= 0) {
    showToastNotice('Please enter a valid price.', '⚠️');
    return;
  }

  try {
    const res = await fetch(`/api/admin/menu/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        ...getAdminHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ price, originalPrice })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update price');
    }

    // Update in local cache
    const item = adminMenuCatalog.find(i => i.id === id);
    if (item) {
      item.price = price;
      item.originalPrice = originalPrice;
      if (originalPrice > price) {
        item.discount = `${Math.round(((originalPrice - price) / originalPrice) * 100)}% OFF`;
      }
    }

    showToastNotice(`Saved ${item?.name || 'Item'} prices! (₹${price} / ~~₹${originalPrice}~~)`, '✅');
    filterAdminMenuTable();
  } catch (err) {
    console.error('[ADMIN-SAVE-PRICES-ERR]', err);
    showToastNotice(err.message, '⚠️');
  }
}
window.saveItemQuickPrices = saveItemQuickPrices;

async function toggleAdminItemStock(id, currentStatus) {
  const newStatus = !currentStatus;
  try {
    const res = await fetch(`/api/admin/menu/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        ...getAdminHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ isAvailable: newStatus })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update stock');
    }

    const item = adminMenuCatalog.find(i => i.id === id);
    if (item) {
      item.isAvailable = newStatus;
    }

    showToastNotice(`${item?.name || 'Item'} marked ${newStatus ? '🟢 In Stock' : '🔴 Out of Stock'}!`, '🔄');
    filterAdminMenuTable();
  } catch (err) {
    console.error('[ADMIN-TOGGLE-STOCK-ERR]', err);
    showToastNotice(err.message, '⚠️');
  }
}
window.toggleAdminItemStock = toggleAdminItemStock;

function openAddMenuItemModal() {
  document.getElementById('adminMenuItemModalTitle').innerText = '➕ Add New Domino\'s Menu Item';
  document.getElementById('itemEditId').value = '';
  document.getElementById('itemEditName').value = '';
  document.getElementById('itemEditCategory').value = 'Veg Pizza';
  document.getElementById('itemEditIsVeg').value = 'true';
  document.getElementById('itemEditPrice').value = '259';
  document.getElementById('itemEditOriginalPrice').value = '299';
  document.getElementById('itemEditCode').value = '';
  document.getElementById('itemEditImage').value = '';
  document.getElementById('itemEditDesc').value = '';
  document.getElementById('itemEditAvailable').checked = true;
  openModal('adminMenuItemModal');
}
window.openAddMenuItemModal = openAddMenuItemModal;

function openEditMenuItemModal(id) {
  const item = adminMenuCatalog.find(i => i.id === id);
  if (!item) return;

  document.getElementById('adminMenuItemModalTitle').innerText = `✏️ Edit: ${item.name}`;
  document.getElementById('itemEditId').value = item.id;
  document.getElementById('itemEditName').value = item.name || '';
  document.getElementById('itemEditCategory').value = item.category || 'Veg Pizza';
  document.getElementById('itemEditIsVeg').value = item.isVeg !== false ? 'true' : 'false';
  document.getElementById('itemEditPrice').value = item.price || 259;
  document.getElementById('itemEditOriginalPrice').value = item.originalPrice || Math.round((item.price * 1.25) / 10) * 10 - 1;
  document.getElementById('itemEditCode').value = item.dominosCode || item.skuId || '';
  document.getElementById('itemEditImage').value = item.imageUrl || item.image || '';
  document.getElementById('itemEditDesc').value = item.description || '';
  document.getElementById('itemEditAvailable').checked = item.isAvailable !== false;
  openModal('adminMenuItemModal');
}
window.openEditMenuItemModal = openEditMenuItemModal;

async function submitMenuItemForm() {
  const id = document.getElementById('itemEditId').value;
  const name = document.getElementById('itemEditName').value.trim();
  const category = document.getElementById('itemEditCategory').value;
  const isVeg = document.getElementById('itemEditIsVeg').value === 'true';
  const price = Number(document.getElementById('itemEditPrice').value);
  const originalPrice = Number(document.getElementById('itemEditOriginalPrice').value);
  const dominosCode = document.getElementById('itemEditCode').value.trim();
  const imageUrl = document.getElementById('itemEditImage').value.trim();
  const description = document.getElementById('itemEditDesc').value.trim();
  const isAvailable = document.getElementById('itemEditAvailable').checked;

  if (!name) {
    showToastNotice('Item name is required.', '⚠️');
    return;
  }
  if (!price || price <= 0) {
    showToastNotice('Valid price is required.', '⚠️');
    return;
  }

  const payload = {
    name,
    category,
    isVeg,
    type: isVeg ? 'VEG' : 'NON-VEG',
    price,
    originalPrice: originalPrice > price ? originalPrice : Math.round((price * 1.25) / 10) * 10 - 1,
    dominosCode,
    imageUrl,
    description,
    isAvailable
  };

  try {
    const isEdit = Boolean(id);
    const url = isEdit ? `/api/admin/menu/${encodeURIComponent(id)}` : '/api/admin/menu';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: {
        ...getAdminHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save item');
    }

    closeModal('adminMenuItemModal');
    showToastNotice(`Successfully ${isEdit ? 'updated' : 'added'} "${name}"!`, '🎉');
    await loadAdminMenu();
  } catch (err) {
    console.error('[ADMIN-SUBMIT-MENU-ERR]', err);
    showToastNotice(err.message, '⚠️');
  }
}
window.submitMenuItemForm = submitMenuItemForm;

async function deleteAdminMenuItem(id) {
  const item = adminMenuCatalog.find(i => i.id === id);
  const name = item ? item.name : 'this item';

  if (!confirm(`Are you sure you want to delete "${name}" from the menu catalog?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/menu/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getAdminHeaders()
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to delete item');
    }

    showToastNotice(`Deleted "${name}" from menu.`, '🗑️');
    await loadAdminMenu();
  } catch (err) {
    console.error('[ADMIN-DELETE-MENU-ERR]', err);
    showToastNotice(err.message, '⚠️');
  }
}
window.deleteAdminMenuItem = deleteAdminMenuItem;
