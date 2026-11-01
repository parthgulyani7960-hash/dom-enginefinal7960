// Domino's Order Engine Platform Frontend - Pure Real Store Lock, Multi-Address & Real Domino's Catalog Engine

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

let catalog = { combos: [], menu: [] };
let cart = [];

// Safe default guest user state
const GUEST_USER = {
  isGuest: true,
  name: '',
  email: '',
  phone: '',
  userId12: '',
  wallet: { balance: 0, currency: 'INR' },
  savedAddresses: []
};

let currentUser = { ...GUEST_USER };

function isUserLoggedIn() {
  return Boolean(currentUser && !currentUser.isGuest && currentUser.userId12 && currentUser.email);
}

let currentResolvedStore = null;
let currentCoordinates = null;
let currentDetectedCity = 'India';
let isStoreServiceable = true;
let currentUnserviceableReason = null;

// Mandatory Location Gate & Catalog Filter State (Unavailable items automatically hidden by Domino's policy)
let hasUserLocation = false;
let pendingItemToCart = null;
let currentSearchQuery = '';
let isHideUnavailable = true;
let currentCategoryFilter = 'ALL';
let currentDietFilter = 'ALL';

let currentOrder = null;
let pollInterval = null;
let countdownTimer = null;

// Rate-limiting mutex for GPS detection button
let isGpsRequestActive = false;
let lastGpsRequestTime = 0;

// Platform Maintenance Mode State
let isMaintenanceActive = false;
let maintenanceInfo = null;

async function checkMaintenanceStatus() {
  try {
    const res = await fetch('/api/maintenance');
    if (!res.ok) return;
    const data = await res.json();
    isMaintenanceActive = Boolean(data && data.active);
    maintenanceInfo = data;

    const banner = document.getElementById('maintenanceAlertBanner');
    const msgEl = document.getElementById('maintenanceBannerMessage');
    const titleEl = document.getElementById('maintenanceBannerTitle');
    const etaEl = document.getElementById('maintenanceEtaText');

    if (banner) {
      if (isMaintenanceActive) {
        banner.style.display = 'block';
        if (msgEl && data.message) msgEl.textContent = data.message;
        if (titleEl && data.title) titleEl.textContent = data.title;
        if (etaEl) {
          if (data.until) {
            const dt = new Date(data.until);
            etaEl.textContent = !isNaN(dt.getTime()) ? `Until ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : data.until;
          } else {
            etaEl.textContent = 'Maintenance In Progress';
          }
        }
      } else {
        banner.style.display = 'none';
      }
    }
  } catch (e) {
    // Silent fail if network unreachable
  }
}
window.checkMaintenanceStatus = checkMaintenanceStatus;

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  checkMaintenanceStatus();
  setInterval(checkMaintenanceStatus, 20000);
  // Check if coordinates were already stored in this browser session
  const storedCoords = sessionStorage.getItem('dominos_user_coords');
  if (storedCoords) {
    try {
      const parsed = JSON.parse(storedCoords);
      if (parsed && parsed.lat && parsed.lng) {
        const storedPrio = parsed.priority || LOCATION_PRIORITY.SESSION_CACHE;
        applyResolvedLocation(parsed.lat, parsed.lng, storedPrio, 'Session Cache');
      }
    } catch (e) {}
  }

  if (!hasUserLocation) {
    renderLocationRequiredBar();
    fetchCatalog();
  }

  // Check stored user session or initialize as guest
  const storedUser = localStorage.getItem('dominos_user');
  if (storedUser) {
    try {
      const parsed = JSON.parse(storedUser);
      if (parsed && (parsed.email || parsed.userId12)) {
        currentUser = { ...GUEST_USER, ...parsed, isGuest: false };
      }
    } catch (e) {
      currentUser = { ...GUEST_USER };
    }
  } else {
    currentUser = { ...GUEST_USER };
  }
  updateUserNavIdentity();

  // Always load latest profile from database & local cache
  loadUserProfile();
  loadStorefrontNotifications();

  // Backdrop click listener to close modals
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(overlay.id);
      }
    });
  });

  // Computer/Desktop Mode Keyboard Navigation Shortcuts
  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const tag = (activeEl && activeEl.tagName) ? activeEl.tagName.toLowerCase() : '';
    const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';

    if (e.key === 'Escape') {
      const active = document.querySelector('.modal-overlay.active');
      if (active) closeModal(active.id);
      return;
    }

    // Global shortcuts: Escape closes active modal smoothly with zero glitches
    // Single-key triggers (c, p, 1, 2, 3, 4) disabled to prevent accidental navigation
  });
});

function renderLocationRequiredBar() {
  const statusContainer = document.getElementById('storeStatusContainer');
  const topNotice = document.getElementById('storeNoticeLine');
  if (statusContainer) {
    statusContainer.innerHTML = `
      <span id="storeStatusBadge" style="background: #f59e0b; color: #0f172a; padding: 4px 12px; border-radius: 20px; font-weight: 800; font-size: 11px; letter-spacing: 0.5px;">
        📍 LOCATION REQUIRED
      </span>
      <span id="storeStatusText" style="font-weight: 600;">
        Please detect your current location to verify item availability at your nearest Domino's kitchen
      </span>
    `;
  }
  if (topNotice) {
    topNotice.innerHTML = '<span>🔒 Mandatory for cart building: your location verifies store inventory. No saved profile address needed.</span>';
    topNotice.style.color = '#94a3b8';
  }
}

// Toast notification helper
function showToastNotice(msg, icon = '📍') {
  const toast = document.getElementById('storeToastNotice');
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

// Modal Helpers with Strict Background Scroll Lock Prevention
function openModal(id) {
  const m = document.getElementById(id);
  if (m) {
    m.classList.add('active');
    document.body.classList.add('modal-open');
  }
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
  if (id === 'trackingModal') {
    if (typeof pollInterval !== 'undefined' && pollInterval) clearInterval(pollInterval);
    if (typeof pollTimeout !== 'undefined' && pollTimeout) clearTimeout(pollTimeout);
  }
  if (id === 'helpSupportModal') {
    if (typeof supportChatPollInterval !== 'undefined' && supportChatPollInterval) {
      clearInterval(supportChatPollInterval);
      supportChatPollInterval = null;
    }
  }
  if (id === 'myOrdersModal') {
    if (typeof myOrdersPollInterval !== 'undefined' && myOrdersPollInterval) {
      clearInterval(myOrdersPollInterval);
      myOrdersPollInterval = null;
    }
  }
  
  const anyActive = document.querySelectorAll('.modal-overlay.active');
  if (!anyActive || anyActive.length === 0) {
    document.body.classList.remove('modal-open');
  }
}

// =========================================================================
// 1. CATALOG RENDERING & DYNAMIC STORE-SPECIFIC AVAILABILITY
// =========================================================================

async function fetchCatalog(lat, lng, hideUnavailable = true) {
  try {
    let url = '/api/catalog';
    const params = new URLSearchParams();
    if (lat !== undefined && lng !== undefined) {
      params.append('lat', lat);
      params.append('lng', lng);
    } else if (hasUserLocation && currentCoordinates) {
      params.append('lat', currentCoordinates.latitude);
      params.append('lng', currentCoordinates.longitude);
    }
    if (hideUnavailable) {
      params.append('hideUnavailable', 'true');
    }
    const qStr = params.toString();
    if (qStr) url += '?' + qStr;

    const res = await fetch(url);
    const data = await res.json();
    catalog = {
      combos: data.combos || [],
      menu: data.menu || []
    };

    renderCombos(catalog.combos);
    applyCurrentFilters();
  } catch (err) {
    console.error('Failed to load catalog:', err);
  }
}

function renderCombos(combos) {
  const container = document.getElementById('combosGrid');
  if (!container) return;
  if (!combos || combos.length === 0) {
    container.innerHTML = '<p style="padding: 20px; color: var(--gray-600);">No combos currently available.</p>';
    return;
  }

  container.innerHTML = combos.map(combo => {
    const isAvail = combo.isAvailable !== false;
    const availClass = isAvail ? '' : 'unavailable';
    const hasDiscount = combo.originalPrice && combo.originalPrice > combo.price;
    const discountPct = hasDiscount ? Math.round(((combo.originalPrice - combo.price) / combo.originalPrice) * 100) : 0;
    
    // Check if this combo is in user cart
    const cartCombo = cart.find(c => c.id === combo.id);
    const comboQty = cartCombo ? (cartCombo.quantity || 0) : 0;

    let actionBtnHtml = '';
    if (!isAvail) {
      actionBtnHtml = `<button class="btn-add btn-disabled" disabled title="Unavailable at your area">Unavailable</button>`;
    } else if (comboQty > 0) {
      actionBtnHtml = `
        <div class="card-qty-stepper">
          <button type="button" class="btn-qty-minus" onclick="changeQty('${combo.id}', -1)" aria-label="Decrease quantity">−</button>
          <span class="card-qty-val">${comboQty}</span>
          <button type="button" class="btn-qty-plus" onclick="changeQty('${combo.id}', 1)" aria-label="Increase quantity">+</button>
        </div>
      `;
    } else {
      actionBtnHtml = `<button class="btn-add" onclick="addComboToCart('${combo.id}')">+ Add Combo</button>`;
    }

    return `
      <div class="card ${availClass}" id="card-${combo.id}">
        <div class="card-img-wrap">
          <img src="${combo.image}" class="card-img" alt="${combo.name}" loading="lazy" onerror="this.src='https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp'">
          <span class="badge-tag">${combo.badge || combo.tag || 'Special Deal'}</span>
          ${hasDiscount ? `<span class="badge-discount-float">${discountPct}% OFF</span>` : ''}
          ${!isAvail ? `<span class="badge-unavailable-tag">🚫 Unavailable</span>` : ''}
        </div>
        <div class="card-body">
          <h3 class="card-title">${combo.name}</h3>
          <p class="card-desc">${combo.description}</p>
          
          <div class="combo-includes">
            <strong>Includes:</strong>
            <ul style="padding-left: 16px; margin-top: 4px;">
              ${(combo.includedItems || []).map(item => `<li>${item.qty}x ${item.name}</li>`).join('')}
            </ul>
          </div>

          <div class="card-footer">
            <div class="price-wrap">
              <span class="price-current">₹${combo.price}</span>
              ${hasDiscount ? `<span class="price-original">₹${combo.originalPrice}</span>` : ''}
              ${hasDiscount ? `<span class="discount-pill">${discountPct}% OFF</span>` : ''}
            </div>
            ${actionBtnHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderMenu(items) {
  const container = document.getElementById('menuGrid');
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--gray-600); background: white; border-radius: var(--radius-sm); border: 1px dashed var(--gray-300);">
        <p style="font-size: 16px; font-weight: 700; margin-bottom: 6px;">No items currently available in this category.</p>
        <p style="font-size: 13px;">Please select another category or check your delivery address.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(item => {
    const isAvail = item.isAvailable !== false;
    const availClass = isAvail ? '' : 'unavailable';
    const hasDiscount = item.originalPrice && item.originalPrice > item.price;
    const discountPct = hasDiscount ? Math.round(((item.originalPrice - item.price) / item.originalPrice) * 100) : 0;
    const originalPriceHtml = hasDiscount
      ? `<span class="price-original">₹${item.originalPrice}</span><span class="discount-pill">${item.discount || discountPct + '% OFF'}</span>`
      : '';

    const imgUrl = item.imageUrl || item.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';
    const isVegFood = item.isVeg !== false && item.type !== 'NON-VEG';
    const typeLabel = isVegFood ? 'VEG' : 'NON-VEG';
    const canCustomize = (item.sizes && Object.keys(item.sizes).length > 1) || (item.allowedSizes && item.allowedSizes.length > 1);

    // Serves badge
    let servesLabel = '';
    if (item.category === 'Pizza Mania') {
      servesLabel = '<span class="serves-pill">Serves 1</span>';
    } else if (item.category === 'Veg Pizza' || item.category === 'Non-Veg Pizza') {
      servesLabel = '<span class="serves-pill">Regular/Med/Large</span>';
    }

    // Check if this item is currently in user's cart
    const cartItem = cart.find(c => c.id === item.id || (c.dominosCode && c.dominosCode === item.dominosCode));
    const cartQty = cartItem ? (cartItem.quantity || 0) : 0;

    let actionBtnHtml = '';
    if (!isAvail) {
      actionBtnHtml = `<button class="btn-add btn-disabled" disabled title="Unavailable at your nearest Domino's kitchen">Unavailable</button>`;
    } else if (cartQty > 0) {
      actionBtnHtml = `
        <div class="card-qty-stepper">
          <button type="button" class="btn-qty-minus" onclick="changeCardItemQty('${item.id}', -1)" aria-label="Decrease quantity">−</button>
          <span class="card-qty-val">${cartQty}</span>
          <button type="button" class="btn-qty-plus" onclick="changeCardItemQty('${item.id}', 1)" aria-label="Increase quantity">+</button>
        </div>
      `;
    } else {
      actionBtnHtml = `<button class="btn-add" onclick="addItemToCart('${item.id}')">${canCustomize ? '+ Customize' : '+ Add'}</button>`;
    }

    return `
      <div class="card ${availClass}" id="card-${item.id}">
        <div class="card-img-wrap">
          <img src="${imgUrl}" class="card-img" alt="${item.name}" loading="lazy" onerror="this.src='https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp'">
          <div class="badge-veg-type">
            <span class="${isVegFood ? 'dot-veg' : 'dot-nonveg'}"></span>
            <span>${typeLabel}</span>
          </div>
          ${hasDiscount ? `<span class="badge-discount-float">${discountPct}% OFF</span>` : ''}
          ${!isAvail ? `<span class="badge-unavailable-tag" title="${item.unavailableReason || 'Unavailable at your area'}">🚫 Unavailable</span>` : ''}
        </div>
        <div class="card-body">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 8px;">
            <h3 class="card-title">${item.name}</h3>
            <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
              <span style="font-size: 10px; font-weight: 700; color: #64748b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; white-space: nowrap;">${item.category}</span>
              ${servesLabel}
            </div>
          </div>
          <p class="card-desc">${item.description || ''}</p>
          
          ${!isAvail ? `<div style="font-size: 11px; color: #dc2626; font-weight: 700; margin-bottom: 8px;">⚠️ ${item.unavailableReason || 'Unavailable at your area'}</div>` : ''}

          <div class="card-footer">
            <div class="price-wrap">
              <span class="price-current">₹${item.price}</span>
              ${originalPriceHtml}
            </div>
            ${actionBtnHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function changeCardItemQty(itemId, delta) {
  const itemInCart = cart.find(c => c.id === itemId || (c.dominosCode && c.dominosCode === itemId));
  if (itemInCart) {
    changeQty(itemInCart.id, delta);
  } else if (delta > 0) {
    addItemToCart(itemId);
  }
}

function applyCurrentFilters() {
  const combosSec = document.getElementById('combosSection');
  const menuSec = document.getElementById('menuSection');

  let items = catalog.menu || [];

  // Filter Combos by Diet
  const filteredCombos = (catalog.combos || []).filter(c => {
    if (currentDietFilter === 'VEG') {
      return !c.name.toLowerCase().includes('non-veg') && !c.description.toLowerCase().includes('chicken') && !c.tag.toLowerCase().includes('non-veg');
    } else if (currentDietFilter === 'NON-VEG') {
      return c.name.toLowerCase().includes('non-veg') || c.description.toLowerCase().includes('chicken') || c.tag.toLowerCase().includes('non-veg');
    }
    return true;
  });

  // 1. Filter by Category Tab
  if (currentCategoryFilter === 'COMBOS') {
    if (combosSec) combosSec.style.display = 'block';
    if (menuSec) menuSec.style.display = 'none';
    renderCombos(filteredCombos);
    updateCatalogCountBadge([]);
    return;
  } else if (currentCategoryFilter === 'ALL') {
    if (combosSec) combosSec.style.display = currentSearchQuery ? 'none' : 'block';
    if (menuSec) menuSec.style.display = 'block';
    renderCombos(filteredCombos);
  } else {
    if (combosSec) combosSec.style.display = 'none';
    if (menuSec) menuSec.style.display = 'block';
    const targetCat = currentCategoryFilter.toLowerCase().trim();
    items = items.filter(i => {
      const c = (i.category || '').toLowerCase().trim();
      return c === targetCat || (targetCat.includes('sides') && c.includes('sides')) || (targetCat.includes('garlic') && c.includes('garlic'));
    });
  }

  // 2. Filter by Diet (Veg / Non-Veg)
  if (currentDietFilter === 'VEG') {
    items = items.filter(i => i.isVeg !== false && i.type !== 'NON-VEG');
  } else if (currentDietFilter === 'NON-VEG') {
    items = items.filter(i => i.isVeg === false || i.type === 'NON-VEG');
  }

  // 3. Filter by Search Query
  if (currentSearchQuery) {
    const q = currentSearchQuery.toLowerCase();
    items = items.filter(i => 
      (i.name || '').toLowerCase().includes(q) || 
      (i.description || '').toLowerCase().includes(q) ||
      (i.category || '').toLowerCase().includes(q)
    );
  }

  // 4. Mandatory / Automatic Hiding of Unavailable Items at Customer Location
  items = items.filter(i => i.isAvailable !== false);

  renderMenu(items);
  updateCatalogCountBadge(items);
}

function filterByDiet(diet, btnElement) {
  document.querySelectorAll('.diet-tab').forEach(btn => {
    btn.classList.remove('active');
    btn.style.background = 'white';
    btn.style.color = btn.id === 'dietVeg' ? '#15803d' : (btn.id === 'dietNonVeg' ? '#b91c1c' : 'var(--gray-800)');
  });
  if (btnElement) {
    btnElement.classList.add('active');
    if (diet === 'ALL') {
      btnElement.style.background = '#0f172a';
      btnElement.style.color = 'white';
    } else if (diet === 'VEG') {
      btnElement.style.background = '#22c55e';
      btnElement.style.color = 'white';
    } else if (diet === 'NON-VEG') {
      btnElement.style.background = '#ef4444';
      btnElement.style.color = 'white';
    }
  }
  currentDietFilter = diet;
  applyCurrentFilters();
}

function filterCatalog(category, btnElement) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  if (btnElement) btnElement.classList.add('active');
  currentCategoryFilter = category;
  applyCurrentFilters();
}

function handleMenuSearch(val) {
  currentSearchQuery = (val || '').trim();
  applyCurrentFilters();
}

function toggleHideUnavailable(hide) {
  isHideUnavailable = !!hide;
  applyCurrentFilters();
}

function updateCatalogCountBadge(items) {
  const badge = document.getElementById('catalogCountBadge');
  if (!badge) return;
  const total = catalog.menu ? catalog.menu.length : 0;
  const visible = items ? items.length : total;
  const avail = catalog.menu ? catalog.menu.filter(i => i.isAvailable !== false).length : 0;
  badge.innerText = `${visible} of ${total} Items (${avail} Available)`;
}

// =========================================================================
// 2. USER PROFILE, WALLET & MULTI-ADDRESS MANAGEMENT
// =========================================================================

async function loadUserProfile() {
  try {
    let url = '/api/user/profile';
    if (currentUser && currentUser.email) {
      url += `?email=${encodeURIComponent(currentUser.email)}`;
    } else if (currentUser && currentUser.userId12) {
      url += `?uid=${encodeURIComponent(currentUser.userId12)}`;
    }
    const res = await fetch(url);
    if (!res.ok) {
      updateUserNavIdentity();
      return;
    }
    const data = await res.json();
    if (data && data.profile) {
      const p = data.profile;
      const isRealUser = Boolean(p.email || p.userId12);
      currentUser = { ...GUEST_USER, ...currentUser, ...p, isGuest: !isRealUser };
      if (isRealUser) {
        localStorage.setItem('dominos_user', JSON.stringify(currentUser));
      }
      updateUserNavIdentity();
      
      // Update Name & Fixed Phone
      const nameInput = document.getElementById('profUserNameInput');
      const nameLabel = document.getElementById('userNameLabel');
      const fixedPhone = document.getElementById('profFixedPhone');
      if (nameInput) nameInput.value = currentUser.name || '';
      if (nameLabel) nameLabel.innerText = currentUser.name || (currentUser.email ? currentUser.email.split('@')[0] : 'User');
      if (fixedPhone) {
        const isLocked = currentUser.phoneLocked !== false;
        const digits = currentUser.phone ? currentUser.phone.replace(/[^0-9]/g, '').slice(-10) : '';
        fixedPhone.value = digits ? (isLocked ? `+91 ${digits}` : digits) : '';
        fixedPhone.readOnly = isLocked;
        fixedPhone.style.background = isLocked ? '#f1f5f9' : '#ffffff';
        fixedPhone.style.cursor = isLocked ? 'not-allowed' : 'text';
      }

      // Update 12-Digit Numerical User ID Badge & Profile Overview
      const uid12Badge = document.getElementById('profUserUid12Badge');
      if (uid12Badge) {
        uid12Badge.innerText = `UID: ${currentUser.userId12 || 'N/A'}`;
      }
      const profEmail = document.getElementById('profUserEmailDisplay');
      if (profEmail) profEmail.innerText = currentUser.email || 'Not logged in';
      const profUid = document.getElementById('profUserUidDisplay');
      if (profUid) profUid.innerText = currentUser.userId12 || 'N/A';

      // Update Wallet Display (Real balance, ₹0 bonus)
      const walletEl = document.getElementById('walletBalanceDisplay');
      if (walletEl) walletEl.innerText = `₹${currentUser.wallet?.balance || 0}`;

      // Render Saved Addresses
      renderProfileAddresses(currentUser.savedAddresses || []);
      syncCartAddressOptions();
      syncTopBarAddressOptions();

      // Auto-activate customer default delivery address on load
      const addresses = currentUser.savedAddresses || [];
      const defAddr = addresses.find(a => a.isDefault) || addresses[0];
      if (defAddr && (!currentActiveDeliveryId || currentActiveDeliveryId === 'DEFAULT' || currentActiveDeliveryId === 'CURRENT_GPS')) {
        currentActiveDeliveryId = defAddr.id;
        syncTopBarAddressOptions();
        syncCartAddressOptions();
        const topFlat = document.getElementById('topBarFlatInput');
        if (topFlat && defAddr.flat) topFlat.value = defAddr.flat;
        const cartFlat = document.getElementById('cartQuickFlatInput');
        if (cartFlat && defAddr.flat) cartFlat.value = defAddr.flat;
        displayCartAddress(defAddr);
        if (defAddr.latitude && defAddr.longitude && activeLocationPriority < LOCATION_PRIORITY.PROFILE_SAVED) {
          applyResolvedLocation(defAddr.latitude, defAddr.longitude, LOCATION_PRIORITY.PROFILE_SAVED, 'Customer Default Address');
        }
      }
    }
  } catch (err) {
    console.warn('Error loading user profile:', err);
    updateUserNavIdentity();
  }
}

async function saveUserNameOnly() {
  const nameInput = document.getElementById('profUserNameInput');
  const newName = (nameInput.value || '').trim();
  if (!newName) {
    alert('Username / Full Name cannot be empty.');
    return;
  }

  try {
    const res = await fetch('/api/user/profile/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentUser.name = newName;
    document.getElementById('userNameLabel').innerText = newName;
    showToastNotice('Username updated successfully!', '👤');
    syncCartAddressOptions();
  } catch (err) {
    alert('Failed to update name: ' + err.message);
  }
}

async function saveUserPhone() {
  const phoneInput = document.getElementById('profFixedPhone');
  const clean = (phoneInput?.value || '').replace(/[^0-9]/g, '').slice(-10);
  if (!clean || clean.length !== 10) {
    alert('Please enter a valid 10-digit Indian mobile number.');
    return;
  }
  try {
    const res = await fetch('/api/user/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: clean })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update phone');

    currentUser.phone = `+91 ${clean}`;
    showToastNotice(`Registered mobile number updated to +91 ${clean}!`, '✅');
    openUserProfileModal();
  } catch (err) {
    alert(`Could not update mobile number: ${err.message}`);
  }
}

function requestPhoneChangeSupport() {
  closeModal('userProfileModal');
  openHelpSupportModal(null);
  setTimeout(() => {
    const cat = document.getElementById('ticketCategorySelect');
    if (cat) cat.value = 'OTHER';
    const desc = document.getElementById('ticketDescInput');
    if (desc) {
      desc.value = `Request to update my registered mobile number from ${currentUser.phone || '+91 7893618933'} to a new number: `;
      desc.focus();
    }
  }, 200);
}

function renderProfileAddresses(addresses) {
  const container = document.getElementById('profileAddressListContainer');
  const limitBadge = document.getElementById('addressLimitBadge');
  const btnToggle = document.getElementById('btnToggleAddAddress');
  if (!container) return;

  const addrCount = (addresses || []).length;
  if (limitBadge) {
    limitBadge.innerText = `(Max 3 • Saved: ${addrCount}/3)`;
    limitBadge.style.color = addrCount >= 3 ? '#ef4444' : '#10b981';
  }

  if (btnToggle) {
    if (addrCount >= 3) {
      btnToggle.innerText = '+ Add New Address (Replaces Oldest)';
      btnToggle.style.opacity = '1';
      btnToggle.title = "Domino's maintains a 3-address maximum. Adding a new address will safely replace the oldest address.";
    } else {
      btnToggle.innerText = '+ Add New Address';
      btnToggle.style.opacity = '1';
      btnToggle.title = "";
    }
  }

  if (!addresses || addresses.length === 0) {
    container.innerHTML = '<p style="color: var(--gray-600); font-size: 12px; padding: 12px; text-align: center;">No delivery addresses saved yet. Click "+ Add New Address" above.</p>';
    return;
  }

  container.innerHTML = addresses.map(addr => {
    const isDefault = addr.isDefault === true;
    const landmarkText = addr.landmark ? ` • Landmark: ${addr.landmark}` : '';
    const labelIcon = addr.label === 'Work' ? '🏢' : (addr.label === 'Home' ? '🏠' : '📍');
    const recipientName = addr.name || (addr.firstName ? `${addr.firstName} ${addr.lastName || ''}`.trim() : (currentUser.name || 'Parth'));
    const completeAddr = addr.completeAddress || addr.building || addr.street || '';

    return `
      <div class="address-card ${isDefault ? 'active-default' : ''}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="addr-badge-tag">${labelIcon} ${addr.label || 'Delivery Address'}</span>
            ${isDefault ? '<span class="addr-badge-default">★ DEFAULT ADDRESS</span>' : ''}
          </div>
          <div style="display: flex; gap: 6px;">
            ${!isDefault ? `<button onclick="makeAddressDefault('${addr.id}')" style="background: none; border: 1px solid #10b981; color: #047857; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; cursor: pointer;">★ Set as Default</button>` : ''}
            <button onclick="editAddress('${addr.id}')" style="background: none; border: 1px solid var(--gray-300); color: var(--gray-600); font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer;">✏️ Edit</button>
            ${addresses.length > 1 ? `<button onclick="deleteAddress('${addr.id}')" style="background: none; border: 1px solid #fca5a5; color: #dc2626; font-size: 11px; padding: 2px 6px; border-radius: 4px; cursor: pointer;">🗑️</button>` : ''}
          </div>
        </div>
        <div style="font-size: 12px; color: #475569; margin-bottom: 4px;">
          <strong>${recipientName}</strong> • ${addr.phone || currentUser.phone || '+91 7893618933'}
        </div>
        <div style="font-size: 13px; font-weight: 700; color: var(--dark);">${addr.flat}</div>
        <div style="font-size: 12px; color: #475569; margin-top: 2px;">${completeAddr}${landmarkText}</div>
        <div style="font-size: 11px; color: #065f46; font-weight: 600; margin-top: 4px;">📡 Coordinates: [${Number(addr.latitude).toFixed(6)}, ${Number(addr.longitude).toFixed(6)}]</div>
        <div style="margin-top: 6px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px;">
          ${addr.dominosAddressId ? `
            <span style="font-size: 11px; background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 2px 8px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">
              ☁️ Domino's Synced (ID: #${addr.dominosAddressId})
            </span>
          ` : `
            <button onclick="syncAddressToDominosCloud('${addr.id}')" style="background: #f0fdf4; border: 1px dashed #16a34a; color: #15803d; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
              ☁️ Sync to Domino's Cloud
            </button>
          `}
          ${addr.syncedAt ? `<span style="font-size: 10px; color: var(--gray-600);">Synced ${new Date(addr.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function syncAddressToDominosCloud(addressId) {
  showToastNotice('Syncing address to Domino\'s India site...', '⏳');
  try {
    const res = await fetch(`/api/user/profile/address/${addressId}/sync-dominos`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        showToastNotice(data.message || 'Rate limit reached. Please wait a few seconds.', '⏳');
        return;
      }
      throw new Error(data.error || 'Failed to sync with Domino\'s');
    }

    showToastNotice(`Address synced to Domino's! Ref ID: #${data.syncResult?.dominosAddressId || addressId}`, '☁️');
    await loadUserProfile();
  } catch (err) {
    alert('Domino\'s Sync Note: ' + err.message);
  }
}

function toggleAddAddressForm(show = null, forEdit = false) {
  const form = document.getElementById('addressFormSection');
  const btn = document.getElementById('btnToggleAddAddress');
  if (!form) return;

  const addresses = currentUser.savedAddresses || [];
  const formAddressId = document.getElementById('formAddressId')?.value;
  const isEditing = forEdit || !!formAddressId;

  const willShow = show !== null ? show : form.style.display === 'none';

  if (willShow && !isEditing && addresses.length >= 3) {
    showToastNotice("ℹ️ Note: Domino's allows 3 addresses. Adding this address will replace the oldest one.", 'ℹ️');
  }

  form.style.display = willShow ? 'block' : 'none';
  if (btn) btn.innerText = willShow ? '✕ Close Form' : '+ Add New Address';

  if (willShow && !forEdit) {
    document.getElementById('addressFormTitle').innerText = '+ Add New Delivery Address';
    document.getElementById('formAddressId').value = '';
    document.getElementById('formAddrLabel').value = 'Home';

    const nameParts = (currentUser.name || 'Parth').split(' ');
    const fNameInput = document.getElementById('formFirstName');
    const lNameInput = document.getElementById('formLastName');
    const phoneEl = document.getElementById('formPhone');
    if (fNameInput) { fNameInput.value = nameParts[0] || 'Parth'; fNameInput.disabled = false; fNameInput.readOnly = false; }
    if (lNameInput) { lNameInput.value = nameParts.slice(1).join(' ') || 'Sharma'; lNameInput.disabled = false; lNameInput.readOnly = false; }
    const userPhoneClean = (currentUser.phone || '').replace(/[^0-9]/g, '').slice(-10) || '7893618933';
    if (phoneEl) { phoneEl.value = userPhoneClean; phoneEl.disabled = false; phoneEl.readOnly = false; }
    
    // Always enable Order For Someone Else checkbox so receiver name/mobile can be typed freely
    const someoneElseCb = document.getElementById('formOrderForSomeoneElse');
    if (someoneElseCb) {
      someoneElseCb.checked = true;
      toggleOrderForSomeoneElseUI(true);
    }

    const fallbackLat = (currentCoordinates && currentCoordinates.latitude) ? currentCoordinates.latitude : 30.7339;
    const fallbackLng = (currentCoordinates && currentCoordinates.longitude) ? currentCoordinates.longitude : 76.7889;

    document.getElementById('formFlat').value = '';
    document.getElementById('formCompleteAddress').value = '';
    document.getElementById('formLandmark').value = '';
    document.getElementById('formCity').value = currentDetectedCity || 'Chandigarh';
    document.getElementById('formPincode').value = '160015';
    document.getElementById('formLat').value = fallbackLat.toFixed(6);
    document.getElementById('formLng').value = fallbackLng.toFixed(6);
    
    // Explicit Requirement: Default address checkbox is NOT checked by default
    document.getElementById('formIsDefault').checked = false;

    const badge = document.getElementById('formGpsStatusBadge');
    if (badge) {
      badge.innerText = '✓ GPS Locked';
      badge.style.background = '#dcfce7';
      badge.style.color = '#15803d';
    }
  }
}

function toggleOrderForSomeoneElseUI(isChecked) {
  const sec = document.getElementById('receiverDetailsSection');
  if (sec) {
    sec.style.display = 'block'; // Always visible and editable so receiver details are never locked out
  }
}

let addressGeocodeDebounceTimer = null;
function debounceAutoResolveCoords(val) {
  clearTimeout(addressGeocodeDebounceTimer);
  addressGeocodeDebounceTimer = setTimeout(() => {
    if (val && val.trim().length >= 4) {
      autoResolveFormCoordinates(val.trim());
    }
  }, 600);
}

async function autoResolveFormCoordinates(queryText = null) {
  const completeAddr = queryText || document.getElementById('formCompleteAddress')?.value || '';
  const city = document.getElementById('formCity')?.value || '';
  const fullQ = [completeAddr, city, 'India'].filter(Boolean).join(', ');
  if (!fullQ || fullQ.trim().length < 4) return;

  const badge = document.getElementById('formGpsStatusBadge');
  if (badge) {
    badge.innerText = '📡 Resolving GPS...';
    badge.style.background = '#e0f2fe';
    badge.style.color = '#0284c7';
  }

  try {
    const res = await fetch(`/api/location/resolve?query=${encodeURIComponent(fullQ)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && (data.geocodedAddress || (data.availability && data.availability.store))) {
        const store = data.availability?.store;
        // Prioritize actual geocoded customer building coordinates for precision doorstep delivery
        const lat = (data.geocodedAddress ? data.geocodedAddress.latitude : null) || (store ? store.latitude : null);
        const lng = (data.geocodedAddress ? data.geocodedAddress.longitude : null) || (store ? store.longitude : null);
        if (lat && lng) {
          const fLat = document.getElementById('formLat');
          const fLng = document.getElementById('formLng');
          if (fLat) fLat.value = Number(lat).toFixed(6);
          if (fLng) fLng.value = Number(lng).toFixed(6);
          if (badge) {
            badge.innerText = store?.storeName ? `✓ ${store.storeName} Pin` : '✓ GPS Pin Locked';
            badge.style.background = '#dcfce7';
            badge.style.color = '#15803d';
          }
          if (store && store.storeName) {
            showToastNotice(`📍 GPS coordinates locked to nearest Domino's kitchen: ${store.storeName}!`, '✅');
          }
        }
      }
    }
  } catch (e) {
    console.warn('Auto resolve coords error:', e.message);
  }
}

function editAddress(addressId) {
  const addr = (currentUser.savedAddresses || []).find(a => a.id === addressId);
  if (!addr) return;

  const fallbackLat = (currentCoordinates && currentCoordinates.latitude) ? currentCoordinates.latitude : 30.7339;
  const fallbackLng = (currentCoordinates && currentCoordinates.longitude) ? currentCoordinates.longitude : 76.7889;

  toggleAddAddressForm(true, true);
  document.getElementById('addressFormTitle').innerText = `✏️ Edit ${addr.label || 'Address'}`;
  document.getElementById('formAddressId').value = addr.id;
  document.getElementById('formAddrLabel').value = addr.label || 'Home';
  
  const firstName = addr.firstName || (addr.receiverName || addr.name || currentUser.name || 'Parth').split(' ')[0] || '';
  const lastName = addr.lastName || (addr.receiverName || addr.name || '').split(' ').slice(1).join(' ') || '';
  const fNameInput = document.getElementById('formFirstName');
  const lNameInput = document.getElementById('formLastName');
  const phoneEl = document.getElementById('formPhone');
  if (fNameInput) { fNameInput.value = firstName; fNameInput.disabled = false; fNameInput.readOnly = false; }
  if (lNameInput) { lNameInput.value = lastName; lNameInput.disabled = false; lNameInput.readOnly = false; }

  const receiverPhoneClean = (addr.receiverPhone || addr.phone || currentUser.phone || '').replace(/[^0-9]/g, '').slice(-10);
  if (phoneEl) { phoneEl.value = receiverPhoneClean; phoneEl.disabled = false; phoneEl.readOnly = false; }

  const orderForSomeoneElseCheckbox = document.getElementById('formOrderForSomeoneElse');
  if (orderForSomeoneElseCheckbox) {
    orderForSomeoneElseCheckbox.checked = true;
    toggleOrderForSomeoneElseUI(true);
  }

  document.getElementById('formFlat').value = addr.flat || '';
  document.getElementById('formCompleteAddress').value = addr.completeAddress || addr.building || addr.street || '';
  document.getElementById('formLandmark').value = addr.landmark || '';
  document.getElementById('formCity').value = addr.city || currentDetectedCity || 'Chandigarh';
  document.getElementById('formPincode').value = addr.pincode || '160015';
  document.getElementById('formLat').value = Number(addr.latitude || fallbackLat).toFixed(6);
  document.getElementById('formLng').value = Number(addr.longitude || fallbackLng).toFixed(6);
  
  // For editing, match existing default state
  document.getElementById('formIsDefault').checked = (addr.isDefault === true);

  // Trigger geocode auto-resolution for fresh coordinates on edit
  if (addr.completeAddress || addr.building || addr.street) {
    debounceAutoResolveCoords(addr.completeAddress || addr.building || addr.street);
  }

  // Smooth redirection / scroll to edit form with visible reminder
  const formSec = document.getElementById('addressFormSection');
  if (formSec) {
    formSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
    formSec.style.outline = '2px solid #0066a3';
    setTimeout(() => { formSec.style.outline = 'none'; }, 2000);
  }
  showToastNotice(`✏️ Editing ${addr.label || 'Address'}. Make changes and click Save.`, '✏️');
}

// Acquire fresh GPS location directly inside address form
async function useCurrentLocationForAddressForm() {
  const btn = document.getElementById('formUseGpsBtn');
  const btnIcon = document.getElementById('formGpsBtnIcon');
  const btnLabel = document.getElementById('formGpsBtnLabel');
  const badge = document.getElementById('formGpsStatusBadge');

  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.7';
  }
  if (btnIcon) btnIcon.innerText = '⏳';
  if (btnLabel) btnLabel.innerText = 'Detecting Accurate GPS Location...';
  if (badge) {
    badge.innerText = '📡 Acquiring GPS...';
    badge.style.background = '#e0f2fe';
    badge.style.color = '#0284c7';
  }

  let lat = null, lng = null;

  if (navigator.geolocation) {
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 6000,
          maximumAge: 0
        });
      });
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    } catch (e) {
      console.warn('Geolocation inside address form failed or timed out, trying IP fallback:', e.message);
    }
  }

  if (!lat || !lng) {
    try {
      const res = await fetch('/api/location/auto-detect');
      const data = await res.json();
      if (data.success && data.nearestStore && data.nearestStore.coordinates) {
        lat = data.nearestStore.coordinates.latitude;
        lng = data.nearestStore.coordinates.longitude;
      }
    } catch (err) {
      console.warn('IP fallback failed:', err);
    }
  }

  lat = lat || currentCoordinates.latitude || 30.7339;
  lng = lng || currentCoordinates.longitude || 76.7889;

  const fLat = document.getElementById('formLat');
  const fLng = document.getElementById('formLng');
  if (fLat) fLat.value = Number(lat).toFixed(6);
  if (fLng) fLng.value = Number(lng).toFixed(6);

  if (badge) {
    badge.innerText = '✓ Fresh GPS Locked';
    badge.style.background = '#dcfce7';
    badge.style.color = '#15803d';
  }

  try {
    const res = await fetch(`/api/location/store-availability?lat=${lat}&lng=${lng}`);
    const data = await res.json();
    if (data.success && data.availability) {
      updateStoreUI(data.availability);
      if (data.availability.store && data.availability.store.city) {
        const fCity = document.getElementById('formCity');
        if (fCity) fCity.value = data.availability.store.city;
      }
    }
  } catch (err) {
    console.warn('Failed to query store availability:', err);
  }

  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
  if (btnIcon) btnIcon.innerText = '📡';
  if (btnLabel) btnLabel.innerText = 'Use My Current Location (Acquire Fresh GPS Pin)';

  showToastNotice(`GPS Coordinates [${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}] locked for address!`, '📍');
}

async function submitAddressForm() {
  const getVal = id => (document.getElementById(id)?.value || '').trim();

  const id = getVal('formAddressId');
  const existingAddresses = currentUser.savedAddresses || [];

  // Note: if existingAddresses.length >= 3, server auto-evicts the oldest non-default address to honor Domino's 3-address policy seamlessly.

  const label = getVal('formAddrLabel') || 'Home';
  const firstName = getVal('formFirstName');
  const lastName = getVal('formLastName');
  const phoneRaw = getVal('formPhone');
  const flat = getVal('formFlat');
  const completeAddress = getVal('formCompleteAddress');
  const landmark = getVal('formLandmark');
  const city = getVal('formCity') || currentDetectedCity || 'Chandigarh';
  const pincode = getVal('formPincode') || '160015';
  const fallbackLat = (currentCoordinates && currentCoordinates.latitude) ? currentCoordinates.latitude : 28.5355;
  const fallbackLng = (currentCoordinates && currentCoordinates.longitude) ? currentCoordinates.longitude : 77.3910;
  const lat = parseFloat(getVal('formLat')) || fallbackLat;
  const lng = parseFloat(getVal('formLng')) || fallbackLng;
  const isDefault = document.getElementById('formIsDefault')?.checked;
  const isSomeoneElse = document.getElementById('formOrderForSomeoneElse')?.checked !== false;

  if (!firstName || !flat || !completeAddress) {
    alert('Please fill the mandatory address fields: First Name, House/Flat Number, and Complete Address.');
    return;
  }

  const cleanPhone = phoneRaw.replace(/[^0-9]/g, '').slice(-10) || (currentUser.phone || '').replace(/[^0-9]/g, '').slice(-10) || '7893618933';
  if (cleanPhone.length !== 10 || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    alert('Please enter a valid 10-digit Indian mobile number for the receiver (starting with 6, 7, 8, or 9). Domino\'s rider requires this to coordinate delivery.');
    document.getElementById('formPhone')?.focus();
    return;
  }

  const fullName = [firstName, lastName].filter(Boolean).join(' ') || currentUser.name || 'Parth';

  const payload = {
    id: id || undefined,
    label,
    firstName,
    lastName,
    name: fullName,
    phone: `+91 ${cleanPhone}`,
    orderForSomeoneElse: isSomeoneElse,
    receiverName: fullName,
    receiverPhone: cleanPhone,
    other_person_name: fullName,
    other_person_phone: cleanPhone,
    customers_mobile: cleanPhone,
    contact_number: cleanPhone,
    flat,
    completeAddress,
    street: completeAddress,
    building: completeAddress,
    landmark,
    city,
    pincode,
    latitude: lat,
    longitude: lng,
    isDefault
  };

  try {
    const res = await fetch('/api/user/profile/address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        alert(data.message || 'Address save rate limited. Please wait a few seconds.');
        return;
      }
      throw new Error(data.error || 'Failed to save address');
    }

    currentUser.savedAddresses = data.addresses;
    renderProfileAddresses(currentUser.savedAddresses);
    syncCartAddressOptions();
    syncTopBarAddressOptions();
    toggleAddAddressForm(false);

    if (data.dominosSync?.success) {
      showToastNotice(`✓ Address saved & synced to Domino's! (ID: #${data.dominosSync.dominosAddressId})`, '☁️');
    } else {
      showToastNotice('Delivery address saved successfully!', '✅');
    }
  } catch (err) {
    alert('Failed to save address: ' + err.message);
  }
}

async function makeAddressDefault(addressId) {
  try {
    const res = await fetch('/api/user/profile/set-default-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addressId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentUser.savedAddresses = data.addresses;
    renderProfileAddresses(currentUser.savedAddresses);
    syncCartAddressOptions();
    syncTopBarAddressOptions();
    showToastNotice('Default delivery address updated!', '★');
  } catch (err) {
    alert('Failed to set default address: ' + err.message);
  }
}

async function deleteAddress(addressId) {
  if (!confirm('Are you sure you want to remove this delivery address?')) return;
  try {
    const res = await fetch(`/api/user/profile/address/${addressId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    currentUser.savedAddresses = data.addresses;
    renderProfileAddresses(currentUser.savedAddresses);
    syncCartAddressOptions();
    syncTopBarAddressOptions();
    showToastNotice('Address removed.', '🗑️');
  } catch (err) {
    alert('Failed to delete address: ' + err.message);
  }
}

function switchProfileTab(tabName) {
  const tabs = ['wallet', 'addresses', 'details'];
  tabs.forEach(t => {
    const pane = document.getElementById(`profileTab-${t}`);
    const btn = document.getElementById(`tabBtnProfile${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (pane) pane.style.display = (t === tabName) ? 'block' : 'none';
    if (btn) {
      if (t === tabName) {
        btn.classList.add('active');
        btn.style.color = '#0066a3';
        btn.style.borderBottom = '3px solid #0066a3';
        btn.style.fontWeight = '800';
      } else {
        btn.classList.remove('active');
        btn.style.color = '#64748b';
        btn.style.borderBottom = '3px solid transparent';
        btn.style.fontWeight = '700';
      }
    }
  });
  if (tabName === 'wallet') {
    loadUserProfileWallet();
    loadWalletTransactions();
  }
}
window.switchProfileTab = switchProfileTab;

function focusWithdrawalForm() {
  switchProfileTab('wallet');
  const container = document.getElementById('withdrawalFormContainer');
  if (container) {
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const input = document.getElementById('withdrawAmountInput');
  if (input) {
    setTimeout(() => input.focus(), 250);
  }
}
window.focusWithdrawalForm = focusWithdrawalForm;

async function loadUserProfileWallet() {
  try {
    const res = await fetch('/api/user/profile');
    const data = await res.json();
    if (data && data.profile) {
      currentUser = { ...currentUser, ...data.profile };
      const bal = currentUser.wallet?.balance ?? currentUser.walletBalance ?? 0;
      const walletEl = document.getElementById('walletBalanceDisplay');
      if (walletEl) walletEl.innerText = `₹${bal}`;
    }
  } catch (err) {
    console.warn('Failed to load user profile wallet:', err);
  }
}
window.loadUserProfileWallet = loadUserProfileWallet;

function openUserProfileModal() {
  loadUserProfile();

  const uid12Badge = document.getElementById('profUserUid12Badge');
  if (uid12Badge) {
    uid12Badge.innerText = `UID: ${currentUser.userId12 || 'N/A'}`;
  }
  const profEmail = document.getElementById('profUserEmailDisplay');
  if (profEmail) profEmail.innerText = currentUser.email || 'Not Signed In (Guest)';
  const profUid = document.getElementById('profUserUidDisplay');
  if (profUid) profUid.innerText = currentUser.userId12 || 'N/A';

  const guestBanner = document.getElementById('profGuestNoticeBanner');
  if (guestBanner) {
    guestBanner.style.display = (!currentUser.email || currentUser.isGuest) ? 'block' : 'none';
  }

  const nameInput = document.getElementById('profUserNameInput');
  if (nameInput) nameInput.value = currentUser.name || '';
  
  const phoneInput = document.getElementById('profFixedPhone');
  const lockBadge = document.getElementById('profPhoneLockBadge');
  const btnSavePhone = document.getElementById('btnSavePhone');
  const btnReqChange = document.getElementById('btnReqPhoneChange');
  const isLocked = currentUser.phoneLocked !== false;

  if (phoneInput) {
    const digits = currentUser.phone ? currentUser.phone.replace(/[^0-9]/g, '').slice(-10) : '';
    phoneInput.value = digits ? (isLocked ? `+91 ${digits}` : digits) : '';
    phoneInput.readOnly = isLocked;
    phoneInput.style.background = isLocked ? '#f1f5f9' : '#ffffff';
    phoneInput.style.cursor = isLocked ? 'not-allowed' : 'text';
  }

  if (lockBadge) {
    lockBadge.innerHTML = isLocked
      ? `<span style="color: #dc2626; font-size: 11px; font-weight: 700;">🔒 Locked (Tap Request Change)</span>`
      : `<span style="color: #16a34a; font-size: 11px; font-weight: 700;">🔓 Unlocked by Admin (Editable)</span>`;
  }

  if (btnSavePhone) btnSavePhone.style.display = isLocked ? 'none' : 'inline-block';
  if (btnReqChange) btnReqChange.style.display = isLocked ? 'inline-block' : 'none';

  const bal = currentUser.wallet?.balance ?? currentUser.walletBalance ?? 0;
  const walletEl = document.getElementById('walletBalanceDisplay');
  if (walletEl) walletEl.innerText = `₹${bal}`;

  renderProfileAddresses(currentUser.savedAddresses || []);
  toggleAddAddressForm(false);
  switchProfileTab('wallet');
  loadUserProfileWallet();
  loadWalletTransactions();
  openModal('userProfileModal');
}

// =========================================================================
// 3. STORE AVAILABILITY & REAL-TIME SERVICEABILITY VERIFICATION
// =========================================================================

function updateStoreUI(avail) {
  if (!avail) return;
  
  isStoreServiceable = avail.isServiceable !== false;
  currentUnserviceableReason = avail.unserviceableReason || (isStoreServiceable ? null : "Domino's does not currently deliver to this location.");

  if (avail.coordinates) {
    currentCoordinates = avail.coordinates;
  }

  const store = avail.store || currentResolvedStore;
  if (!store) return;
  if (avail.store) {
    currentResolvedStore = avail.store;
  }

  if (store && store.city) {
    currentDetectedCity = store.city;
    const formCity = document.getElementById('formCity');
    if (formCity) formCity.value = currentDetectedCity;
  }

  const gmapsLink = (store && store.googleMapsUrl) 
    ? store.googleMapsUrl 
    : (store ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(store.storeName + ' ' + (store.address || ''))}` : '#');

  // Update Top Header Store Bar
  const statusContainer = document.getElementById('storeStatusContainer');
  const topNotice = document.getElementById('storeNoticeLine');
  const topStoreLbl = document.getElementById('topBarStoreLabel');

  if (topStoreLbl) {
    if (isStoreServiceable && store) {
      topStoreLbl.innerHTML = `🍕 Store: <strong>${store.storeName}</strong> <span style="color: #38bdf8;">(Live)</span>`;
    } else {
      topStoreLbl.innerHTML = `⚠️ Store: <strong>Unserviceable Area</strong>`;
    }
  }

  if (statusContainer) {
    if (isStoreServiceable && store) {
      statusContainer.innerHTML = `
        <span id="storeStatusBadge" style="background: #10b981; color: white; padding: 4px 12px; border-radius: 20px; font-weight: 800; font-size: 11px; letter-spacing: 0.5px; box-shadow: 0 0 10px rgba(16,185,129,0.4);">
          🟢 DELIVERING
        </span>
        <span id="storeStatusText" style="font-weight: 600;">
          <strong>Domino's Pizza - ${store.storeName}</strong> <span style="color: #94a3b8; font-size: 11px; font-weight: 400;">(${store.address || store.locality || ''})</span> • ${avail.distanceKm || store.driveDistanceKm || '1.0'} km away • Delivery in ~<strong>${avail.estimatedDeliveryTime || store.polygonTime || '30 mins'}</strong>
        </span>
        <a href="${gmapsLink}" target="_blank" class="kitchen-gmaps-link" id="topKitchenGmapsLink">
          🗺️ View Kitchen on Google Maps &rarr;
        </a>
      `;
      if (topNotice) {
        topNotice.innerHTML = '<span>🔒 Locked to your verified location. Domino\'s orders are dispatched from this kitchen.</span>';
        topNotice.style.color = '#94a3b8';
      }
    } else {
      // Unserviceable Status Feedback
      statusContainer.innerHTML = `
        <span id="storeStatusBadge" style="background: #ef4444; color: white; padding: 4px 12px; border-radius: 20px; font-weight: 800; font-size: 11px; letter-spacing: 0.5px; box-shadow: 0 0 10px rgba(239,68,68,0.4);">
          🔴 NOT SERVICEABLE
        </span>
        <span id="storeStatusText" style="font-weight: 600; color: #fca5a5;">
          ${currentUnserviceableReason || `Domino's does not deliver to this location.`}
        </span>
        ${gmapsLink !== '#' ? `<a href="${gmapsLink}" target="_blank" class="kitchen-gmaps-link" id="topKitchenGmapsLink" style="border-color: #ef4444; color: #fca5a5;">🗺️ Nearest Store Maps &rarr;</a>` : ''}
      `;
      if (topNotice) {
        topNotice.innerHTML = '<span>⚠️ Out of service zone. Domino\'s delivers within maximum 7.5 km from the kitchen.</span>';
        topNotice.style.color = '#fca5a5';
      }
    }
  }

  // Sync to Cart Modal
  updateCartServiceabilityCard(gmapsLink, avail);
}

function updateCartServiceabilityCard(gmapsLink, avail = {}) {
  const card = document.getElementById('cartServiceabilityCard');
  const header = document.getElementById('cartServiceabilityHeader');
  const infoText = document.getElementById('cartStoreInfoText');
  const warn = document.getElementById('cartUnserviceableWarning');
  const gmapsBtn = document.getElementById('cartKitchenGmapsLink');
  const proceedBtn = document.getElementById('cartProceedBtn');

  if (!card) return;

  if (gmapsBtn && gmapsLink && gmapsLink !== '#') {
    gmapsBtn.href = gmapsLink;
    gmapsBtn.style.display = 'inline-flex';
  } else if (gmapsBtn) {
    gmapsBtn.style.display = 'none';
  }

  if (isStoreServiceable) {
    card.style.background = '#eff6ff';
    card.style.borderColor = '#bfdbfe';
    if (header) {
      header.innerText = '🟢 Domino\'s Kitchen Verified & Delivering:';
      header.style.color = '#1e40af';
    }
    if (infoText) {
      infoText.innerHTML = `Domino's Pizza - <strong>${currentResolvedStore.storeName}</strong> (${currentResolvedStore.address || ''}) • ${currentResolvedStore.driveDistanceKm || '1.0'} km away (Est. ${currentResolvedStore.polygonTime || '30 mins'})`;
    }
    if (warn) warn.style.display = 'none';

    if (proceedBtn) {
      proceedBtn.disabled = false;
      proceedBtn.style.background = 'var(--primary)';
      proceedBtn.style.cursor = 'pointer';
      proceedBtn.innerText = 'Proceed to Online QR Payment →';
    }
  } else {
    // Unserviceable Feedback in Cart
    card.style.background = '#fef2f2';
    card.style.borderColor = '#fca5a5';
    if (header) {
      header.innerText = '🔴 DOMINO\'S NOT SERVICEABLE AT THIS LOCATION:';
      header.style.color = '#b91c1c';
    }
    if (infoText) {
      infoText.innerHTML = currentResolvedStore 
        ? `Nearest Store: <strong>${currentResolvedStore.storeName}</strong> is ${avail.distanceKm || currentResolvedStore.driveDistanceKm || 0} km away.`
        : `Domino's India does not currently service this region.`;
    }
    if (warn) {
      warn.innerText = `⚠️ ${currentUnserviceableReason || 'Location is outside Domino\'s delivery polygon radius (> 7.5 km). Please update your address.'}`;
      warn.style.display = 'block';
    }

    if (proceedBtn) {
      proceedBtn.disabled = true;
      proceedBtn.style.background = '#94a3b8';
      proceedBtn.style.cursor = 'not-allowed';
      proceedBtn.innerText = '⚠️ Unserviceable Location - Cannot Place Order';
    }
  }
}

// Sequence token & Priority system to eliminate location race conditions
let activeLocationSeq = 0;
const LOCATION_PRIORITY = {
  IP_AUTODETECT: 1,
  SESSION_CACHE: 2,
  PROFILE_SAVED: 3,
  HARDWARE_GPS: 4,
  USER_MANUAL: 5
};
let activeLocationPriority = 0;

// Helper to acquire fresh device geolocation coordinates
function acquireDeviceCoordinates() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('Browser geolocation not supported by your device'));
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

// Rate-limited, debounced GPS button click handler with countdown
let gpsCooldownInterval = null;
async function detectUserLocation() {
  const now = Date.now();
  const elapsed = now - lastGpsRequestTime;
  if (isGpsRequestActive) {
    showToastNotice('GPS positioning already in progress. Please wait...', '⏳');
    return;
  }
  if (elapsed < 3500) {
    const remain = Math.ceil((3500 - elapsed) / 1000);
    showToastNotice(`Rate limit cooldown: please wait ${remain}s before requesting GPS again.`, '⏳');
    return;
  }

  isGpsRequestActive = true;
  lastGpsRequestTime = now;
  setGpsButtonLoading(true);
  showToastNotice('Acquiring satellite GPS coordinates...', '🛰️');

  try {
    const coords = await acquireDeviceCoordinates();
    await applyResolvedLocation(coords.latitude, coords.longitude, LOCATION_PRIORITY.HARDWARE_GPS, 'Device GPS Satellite');
    showToastNotice('✓ GPS Satellite Location Locked!', '📍');
  } catch (geoErr) {
    console.warn('[GPS-FALLBACK] Geolocation notice:', geoErr.message);
    if (activeLocationPriority < LOCATION_PRIORITY.PROFILE_SAVED) {
      showToastNotice('Satellite GPS unavailable. Resolving location via network IP...', '🌐');
      await initLocationOnLoad(LOCATION_PRIORITY.IP_AUTODETECT);
    } else {
      showToastNotice('GPS signal weak; maintaining verified delivery location.', '📍');
    }
  } finally {
    isGpsRequestActive = false;
    startGpsCooldown(3);
  }
}

function startGpsCooldown(seconds) {
  const topBtn = document.getElementById('topDetectGpsBtn');
  const topIcon = document.getElementById('gpsBtnIcon');
  const topLabel = document.getElementById('gpsBtnLabel');
  if (!topBtn) return;

  topBtn.disabled = true;
  topBtn.style.opacity = '0.7';
  topBtn.style.cursor = 'not-allowed';

  let remaining = seconds;
  clearInterval(gpsCooldownInterval);
  gpsCooldownInterval = setInterval(() => {
    if (remaining > 0) {
      if (topLabel) topLabel.innerText = `⏳ Wait ${remaining}s...`;
      if (topIcon) topIcon.innerText = '⏱️';
      remaining--;
    } else {
      clearInterval(gpsCooldownInterval);
      topBtn.disabled = false;
      topBtn.style.opacity = '1';
      topBtn.style.cursor = 'pointer';
      if (topLabel) topLabel.innerText = 'Detect My GPS Location';
      if (topIcon) topIcon.innerText = '📍';
    }
  }, 1000);
}

function setGpsButtonLoading(isLoading) {
  const topBtn = document.getElementById('topDetectGpsBtn');
  const topIcon = document.getElementById('gpsBtnIcon');
  const topLabel = document.getElementById('gpsBtnLabel');

  if (topBtn) topBtn.disabled = isLoading;
  if (isLoading) {
    if (topLabel) topLabel.innerText = 'Pinpointing GPS...';
    if (topIcon) topIcon.innerText = '⏳';
    if (topBtn) { topBtn.style.opacity = '0.7'; topBtn.style.cursor = 'wait'; }
  } else {
    if (topLabel) topLabel.innerText = 'Detect My GPS Location';
    if (topIcon) topIcon.innerText = '📍';
    if (topBtn) { topBtn.style.opacity = '1'; topBtn.style.cursor = 'pointer'; }
  }
}

async function initLocationOnLoad(priority = LOCATION_PRIORITY.IP_AUTODETECT) {
  if (priority < activeLocationPriority) {
    console.log(`[LOCATION] Skipping IP auto-detect; active priority is higher (${activeLocationPriority})`);
    return;
  }
  try {
    const res = await fetch('/api/location/auto-detect');
    if (res.status === 429) {
      const errData = await res.json().catch(() => ({}));
      showToastNotice(errData.message || 'Location rate limit exceeded. Please wait a moment.', '⏳');
      return;
    }
    const data = await res.json();
    const coords = data.coordinates || data.clientCoordinates || (data.availability?.store ? { latitude: data.availability.store.latitude, longitude: data.availability.store.longitude } : null);
    if (data.success && coords) {
      await applyResolvedLocation(coords.latitude, coords.longitude, priority, 'Network IP Auto-Detect');
    }
  } catch (err) {
    console.warn('Auto-detect fallback error:', err);
  }
}

async function applyResolvedLocation(lat, lng, priority = LOCATION_PRIORITY.IP_AUTODETECT, sourceLabel = '') {
  // Reject lower-priority location updates if a higher-priority lock is already active
  if (priority < activeLocationPriority) {
    console.log(`[LOCATION] Discarding lower-priority location update (${priority} < active ${activeLocationPriority}) from: ${sourceLabel}`);
    return;
  }

  // Increment monotonic request sequence token
  const reqSeq = ++activeLocationSeq;
  activeLocationPriority = priority;
  hasUserLocation = true;
  currentCoordinates = { latitude: lat, longitude: lng };
  sessionStorage.setItem('dominos_user_coords', JSON.stringify({ lat, lng, priority }));

  try {
    const res = await fetch(`/api/location/store-availability?lat=${lat}&lng=${lng}`);
    if (reqSeq !== activeLocationSeq) {
      console.log(`[LOCATION] Discarded stale out-of-order store response #${reqSeq} (active: #${activeLocationSeq})`);
      return;
    }

    if (res.status === 429) {
      const errData = await res.json().catch(() => ({}));
      showToastNotice(errData.message || 'Store availability rate limited. Please wait.', '⏳');
    } else {
      const data = await res.json();
      if (reqSeq !== activeLocationSeq) return;
      if (data.success && data.availability) {
        updateStoreUI(data.availability);
      }
    }

    // Sync coordinates to address form
    const fLat = document.getElementById('formLat');
    const fLng = document.getElementById('formLng');
    if (fLat) fLat.value = Number(lat).toFixed(6);
    if (fLng) fLng.value = Number(lng).toFixed(6);

    // Refresh catalog with store-specific availability for this location!
    await fetchCatalog(lat, lng);
    if (reqSeq !== activeLocationSeq) return;

    // If cart has items, immediately re-verify rates against this new delivering kitchen
    if (cart.length > 0) {
      await verifyCartWithKitchen();
    }
  } catch (err) {
    console.warn('Location resolve failed:', err);
  }
}

// Modal Location Handlers
async function modalDetectUserLocation() {
  const btn = document.getElementById('modalDetectGpsBtn');
  const label = document.getElementById('modalDetectGpsLabel');
  if (btn) btn.disabled = true;
  if (label) label.innerText = 'Detecting GPS Location...';

  try {
    const coords = await acquireDeviceCoordinates();
    await applyResolvedLocation(coords.latitude, coords.longitude, LOCATION_PRIORITY.HARDWARE_GPS, 'Modal Device GPS');
    closeModal('locationRequiredModal');
    processPendingAddToCart();
  } catch (err) {
    console.warn('Modal GPS detection failed, trying IP detection:', err);
    try {
      const res = await fetch('/api/location/auto-detect');
      const data = await res.json();
      const coords = data.coordinates || data.clientCoordinates || (data.availability?.store ? { latitude: data.availability.store.latitude, longitude: data.availability.store.longitude } : null);
      if (data.success && coords) {
        await applyResolvedLocation(coords.latitude, coords.longitude, LOCATION_PRIORITY.IP_AUTODETECT, 'Modal Network IP');
        closeModal('locationRequiredModal');
        processPendingAddToCart();
        return;
      }
    } catch (e) {}
    alert('Could not detect location automatically. Please enter your area/locality name below.');
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.innerText = 'Detect My Current Location (GPS)';
  }
}

async function modalSearchArea() {
  const input = document.getElementById('modalAreaInput');
  const query = (input.value || '').trim();
  if (!query) {
    alert('Please enter a locality or area name.');
    return;
  }

  try {
    const res = await fetch(`/api/location/resolve?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.success && data.availability && data.availability.store) {
      const coords = data.availability.coordinates || { latitude: data.availability.store.latitude, longitude: data.availability.store.longitude };
      await applyResolvedLocation(coords.latitude, coords.longitude, LOCATION_PRIORITY.USER_MANUAL, 'Modal Area Search');
      closeModal('locationRequiredModal');
      processPendingAddToCart();
    } else {
      alert(`Domino's could not resolve store coverage for "${query}". Please try another nearby area or landmark.`);
    }
  } catch (err) {
    alert('Failed to resolve area: ' + err.message);
  }
}

function processPendingAddToCart() {
  if (!pendingItemToCart) return;

  const pending = pendingItemToCart;
  pendingItemToCart = null;

  if (pending.type === 'combo') {
    addComboToCart(pending.id);
  } else if (pending.type === 'item') {
    const item = catalog.menu.find(i => i.id === pending.id);
    if (item && item.isAvailable !== false) {
      showToastNotice(`✅ Location verified! Added ${item.name} to cart.`, '🛒');
      addItemToCart(pending.id);
    } else if (item) {
      showToastNotice(`⚠️ Sorry, ${item.name} is unavailable at your area.`, '🚫');
    }
  }
}

// =========================================================================
// 4. CART & CHECKOUT (CONFIRM ADDRESS & DOMINO'S REQUIREMENTS)
// =========================================================================

function addComboToCart(comboId) {
  // MANDATORY CURRENT LOCATION GATE
  if (!hasUserLocation) {
    pendingItemToCart = { type: 'combo', id: comboId };
    openModal('locationRequiredModal');
    return;
  }

  const combo = catalog.combos.find(c => c.id === comboId);
  if (!combo) return;

  const existing = cart.find(i => i.id === combo.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: combo.id,
      name: combo.name,
      price: combo.price,
      quantity: 1,
      isCombo: true,
      image: combo.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      imageUrl: combo.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      includedItems: combo.includedItems
    });
  }

  updateCartBadge();
  renderFloatingCartBar();
  applyCurrentFilters();
  showToastNotice(`Added ${combo.name} to cart!`, '🍕');
}

// =========================================================================
// PIZZA CUSTOMIZATION ENGINE (Sizes, Crusts & Extra Toppings)
// =========================================================================

let currentCustomizingItem = null;
let selectedPizzaSize = 'Regular';
let selectedPizzaCrust = 'New Hand Tossed';
let selectedExtraToppings = new Set();

const PIZZA_SIZES = [
  { name: 'Regular', delta: 0, serves: 'Serves 1 • 4 slices' },
  { name: 'Medium', delta: 200, serves: 'Serves 2 • 6 slices' },
  { name: 'Large', delta: 400, serves: 'Serves 4 • 8 slices' }
];

const PIZZA_CRUSTS = [
  { name: 'New Hand Tossed', delta: 0, desc: 'Classic hand-stretched crust' },
  { name: 'Cheese Burst', delta: 99, desc: 'Crust filled with molten liquid cheese' },
  { name: 'Fresh Pan Pizza', delta: 40, desc: 'Thick, buttery & crunchy' },
  { name: '100% Wheat Thin Crust', delta: 60, desc: 'Crispy & light wheat base' }
];

const VEG_TOPPINGS = [
  { name: 'Extra Cheese', price: 50 },
  { name: 'Grilled Mushrooms', price: 45 },
  { name: 'Crisp Capsicum', price: 35 },
  { name: 'Fresh Red Onion', price: 35 },
  { name: 'Paneer Tikka', price: 50 },
  { name: 'Golden Corn', price: 35 }
];

const NON_VEG_TOPPINGS = [
  { name: 'Peri-Peri Chicken', price: 60 },
  { name: 'Barbeque Chicken', price: 60 },
  { name: 'Grilled Chicken Keema', price: 60 }
];

function openPizzaCustomizationModal(item) {
  currentCustomizingItem = item;
  const allowed = (item.allowedSizes && item.allowedSizes.length > 0) ? item.allowedSizes : ['Regular', 'Medium', 'Large'];
  selectedPizzaSize = allowed.includes('Regular') ? 'Regular' : allowed[0];
  
  if (item.allowedCrusts && item.allowedCrusts.length > 0) {
    selectedPizzaCrust = item.allowedCrusts.find(c => c.includes('Hand') || c.includes('Tossed')) || item.allowedCrusts[0];
  } else {
    selectedPizzaCrust = 'New Hand Tossed';
  }
  selectedExtraToppings.clear();

  const imgEl = document.getElementById('customPizzaImg');
  const nameEl = document.getElementById('customPizzaName');
  const descEl = document.getElementById('customPizzaDesc');
  const subtitleEl = document.getElementById('customPizzaSubtitle');
  if (imgEl) imgEl.src = item.image || item.imageUrl || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';
  if (nameEl) nameEl.innerText = item.name;
  if (descEl) descEl.innerText = item.description || 'Authentic hand-crafted Domino\'s pizza';
  
  if (subtitleEl) {
    if (item.isPizzaMania || allowed.length === 1) {
      subtitleEl.innerText = `🎯 ${item.isPizzaMania ? 'Pizza Mania' : 'Specialty Pizza'}: Single ${selectedPizzaSize} Size Recipe`;
    } else {
      subtitleEl.innerText = 'Select size, crust & toppings';
    }
  }

  const vegTag = document.getElementById('customPizzaVegTag');
  if (vegTag) {
    if (item.category === 'Non-Veg Pizza' || item.type === 'NON-VEG' || item.isVeg === false) {
      vegTag.innerText = '🔴 NON-VEG';
      vegTag.style.borderColor = '#ef4444';
      vegTag.style.color = '#dc2626';
    } else {
      vegTag.innerText = '🟢 VEG';
      vegTag.style.borderColor = '#22c55e';
      vegTag.style.color = '#16a34a';
    }
  }

  renderSizeOptions();
  renderCrustOptions();
  renderToppingsOptions();
  updateCustomizationTotalPrice();

  openModal('pizzaCustomizationModal');
}

function renderSizeOptions() {
  const container = document.getElementById('sizeOptionsContainer');
  if (!container) return;

  const allowed = (currentCustomizingItem && currentCustomizingItem.allowedSizes && currentCustomizingItem.allowedSizes.length > 0)
    ? currentCustomizingItem.allowedSizes
    : ['Regular', 'Medium', 'Large'];

  // If item only has 1 size allowed (e.g. Pizza Mania, which only comes in Regular)
  if (allowed.length === 1) {
    const singleSizeName = allowed[0];
    const sizeInfo = PIZZA_SIZES.find(s => s.name === singleSizeName) || { name: singleSizeName, serves: 'Serves 1 • 4 slices' };
    container.style.display = 'block';
    container.innerHTML = `
      <div style="background: #f0fdf4; border: 1.5px solid #22c55e; border-radius: 10px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 32px; height: 32px; border-radius: 50%; background: #dcfce7; display: flex; align-items: center; justify-content: center; font-size: 16px; color: #16a34a; flex-shrink: 0;">🎯</div>
          <div>
            <div style="font-weight: 800; font-size: 13px; color: #14532d;">${singleSizeName} Size Only (Single Size Recipe)</div>
            <div style="font-size: 11px; color: #166534; margin-top: 1px;">${sizeInfo.serves} • Baked in Regular size only. Medium & Large are not offered by Domino's.</div>
          </div>
        </div>
        <span style="font-size: 11px; font-weight: 800; background: #22c55e; color: white; padding: 4px 10px; border-radius: 12px; white-space: nowrap;">Included</span>
      </div>
    `;
    return;
  }

  // If item has multiple sizes (Regular, Medium, Large)
  const validSizes = PIZZA_SIZES.filter(s => allowed.includes(s.name));
  container.style.display = 'grid';
  container.style.gridTemplateColumns = `repeat(${validSizes.length}, 1fr)`;
  container.style.gap = '10px';
  container.innerHTML = validSizes.map(s => {
    const isSelected = selectedPizzaSize === s.name;
    let deltaText = s.delta > 0 ? `+₹${s.delta}` : 'Base';
    if (currentCustomizingItem && currentCustomizingItem.sizeCrustPricingMap && currentCustomizingItem.sizeCrustPricingMap[s.name]) {
      const regPrice = currentCustomizingItem.sizeCrustPricingMap['Regular']?.[selectedPizzaCrust] || currentCustomizingItem.price;
      const thisPrice = currentCustomizingItem.sizeCrustPricingMap[s.name]?.[selectedPizzaCrust] || Object.values(currentCustomizingItem.sizeCrustPricingMap[s.name])[0];
      const diff = thisPrice - regPrice;
      deltaText = diff > 0 ? `+₹${diff}` : 'Base';
    }

    return `
      <div onclick="selectPizzaSize('${s.name}')" 
           style="border: 2px solid ${isSelected ? '#0066a3' : 'var(--gray-200)'}; background: ${isSelected ? '#eff6ff' : 'white'}; border-radius: 8px; padding: 10px; cursor: pointer; text-align: center; transition: all 0.2s; box-shadow: ${isSelected ? '0 2px 8px rgba(0,102,163,0.15)' : 'none'};">
        <div style="font-weight: 800; font-size: 13px; color: ${isSelected ? '#0066a3' : 'var(--dark)'};">${s.name}</div>
        <div style="font-size: 10px; color: var(--gray-500); margin: 2px 0;">${s.serves}</div>
        <div style="font-size: 11px; font-weight: 700; color: ${deltaText === 'Base' ? 'var(--gray-600)' : '#16a34a'};">
          ${deltaText}
        </div>
      </div>
    `;
  }).join('');
}

function selectPizzaSize(sizeName) {
  if (currentCustomizingItem && currentCustomizingItem.allowedSizes && !currentCustomizingItem.allowedSizes.includes(sizeName)) {
    return;
  }
  selectedPizzaSize = sizeName;
  renderSizeOptions();
  updateCustomizationTotalPrice();
}

function renderCrustOptions() {
  const container = document.getElementById('crustOptionsContainer');
  if (!container) return;

  let crustsToShow = PIZZA_CRUSTS;
  if (currentCustomizingItem && currentCustomizingItem.allowedCrusts && currentCustomizingItem.allowedCrusts.length > 0) {
    crustsToShow = currentCustomizingItem.allowedCrusts.map(cName => {
      const existing = PIZZA_CRUSTS.find(c => c.name.toLowerCase() === cName.toLowerCase());
      const delta = existing ? existing.delta : (cName.includes('Pan') ? 30 : (cName.includes('Burst') ? 99 : 0));
      return {
        name: cName,
        desc: existing ? existing.desc : (cName.includes('Pan') ? 'Thick, Soft & Crusty' : 'Crisp Classic Crust'),
        delta
      };
    });
  }

  if (crustsToShow.length === 1) {
    const c = crustsToShow[0];
    container.innerHTML = `
      <div style="background: #f8fafc; border: 1.5px solid var(--gray-300); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 18px;">🥖</span>
          <div>
            <div style="font-weight: 700; font-size: 13px; color: var(--dark);">${c.name} (Signature Crust)</div>
            <div style="font-size: 11px; color: var(--gray-500);">${c.desc} • Fixed recipe crust</div>
          </div>
        </div>
        <span style="font-size: 11px; font-weight: 800; background: #e2e8f0; color: #334155; padding: 3px 8px; border-radius: 8px;">Included</span>
      </div>
    `;
    return;
  }

  container.innerHTML = crustsToShow.map(c => {
    const isSelected = selectedPizzaCrust === c.name;
    return `
      <div onclick="selectPizzaCrust('${c.name}')" 
           style="display: flex; justify-content: space-between; align-items: center; border: 1.5px solid ${isSelected ? '#0066a3' : 'var(--gray-200)'}; background: ${isSelected ? '#eff6ff' : 'white'}; border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 0.2s;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <input type="radio" name="crustRadio" ${isSelected ? 'checked' : ''} style="cursor: pointer;">
          <div>
            <div style="font-weight: 700; font-size: 13px; color: var(--dark);">${c.name}</div>
            <div style="font-size: 11px; color: var(--gray-500);">${c.desc}</div>
          </div>
        </div>
        <span style="font-weight: 800; font-size: 12px; color: ${c.delta > 0 ? '#16a34a' : 'var(--gray-500)'};">
          ${c.delta > 0 ? `+₹${c.delta}` : 'Free'}
        </span>
      </div>
    `;
  }).join('');
}

function selectPizzaCrust(crustName) {
  selectedPizzaCrust = crustName;
  renderCrustOptions();
  updateCustomizationTotalPrice();
}

function renderToppingsOptions() {
  const container = document.getElementById('toppingsOptionsContainer');
  if (!container) return;

  if (currentCustomizingItem && (currentCustomizingItem.isPizzaMania || currentCustomizingItem.isCustomizable === false)) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; background: #f1f5f9; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 12px; text-align: center; font-size: 12px; color: var(--gray-600); font-weight: 600;">
        ℹ️ Domino's does not permit extra toppings for this item (Single recipe).
      </div>
    `;
    return;
  }

  const isNonVeg = currentCustomizingItem && (
    (currentCustomizingItem.category && currentCustomizingItem.category.toLowerCase().includes('non-veg')) ||
    currentCustomizingItem.type === 'NON-VEG' || 
    currentCustomizingItem.isVeg === false
  );
  const availableToppings = isNonVeg ? [...VEG_TOPPINGS, ...NON_VEG_TOPPINGS] : VEG_TOPPINGS;

  container.innerHTML = availableToppings.map(t => {
    const isChecked = selectedExtraToppings.has(t.name);
    return `
      <label style="display: flex; justify-content: space-between; align-items: center; border: 1.5px solid ${isChecked ? '#10b981' : 'var(--gray-200)'}; background: ${isChecked ? '#f0fdf4' : 'white'}; border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: all 0.2s;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="checkbox" onchange="toggleExtraTopping('${t.name}')" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
          <span style="font-size: 12px; font-weight: 600; color: var(--dark);">${t.name}</span>
        </div>
        <span style="font-weight: 700; font-size: 11px; color: #16a34a;">+₹${t.price}</span>
      </label>
    `;
  }).join('');
}

function toggleExtraTopping(toppingName) {
  if (selectedExtraToppings.has(toppingName)) {
    selectedExtraToppings.delete(toppingName);
  } else {
    selectedExtraToppings.add(toppingName);
  }
  renderToppingsOptions();
  updateCustomizationTotalPrice();
}

function calculateCustomizationPrice() {
  if (!currentCustomizingItem) return 0;
  
  let basePrice = Number(currentCustomizingItem.price) || 0;

  if (currentCustomizingItem.sizeCrustPricingMap &&
      currentCustomizingItem.sizeCrustPricingMap[selectedPizzaSize] &&
      currentCustomizingItem.sizeCrustPricingMap[selectedPizzaSize][selectedPizzaCrust]) {
    basePrice = currentCustomizingItem.sizeCrustPricingMap[selectedPizzaSize][selectedPizzaCrust];
  } else {
    const sizeObj = PIZZA_SIZES.find(s => s.name === selectedPizzaSize);
    if (sizeObj && (!currentCustomizingItem.allowedSizes || currentCustomizingItem.allowedSizes.includes(selectedPizzaSize))) {
      basePrice += sizeObj.delta;
    }
    const crustObj = PIZZA_CRUSTS.find(c => c.name === selectedPizzaCrust);
    if (crustObj) basePrice += crustObj.delta;
  }

  // Add extra toppings if allowed
  if (!currentCustomizingItem.isPizzaMania && currentCustomizingItem.isCustomizable !== false) {
    const allToppings = [...VEG_TOPPINGS, ...NON_VEG_TOPPINGS];
    for (const name of selectedExtraToppings) {
      const t = allToppings.find(item => item.name === name);
      if (t) basePrice += t.price;
    }
  }

  return basePrice;
}

function updateCustomizationTotalPrice() {
  const total = calculateCustomizationPrice();
  const el = document.getElementById('customTotalPrice');
  if (el) {
    const origPrice = Math.round((total * 1.25) / 10) * 10 - 1;
    const saveAmt = origPrice - total;
    el.innerHTML = `₹${total} <span style="font-size: 13px; color: #94a3b8; text-decoration: line-through; font-weight: 500; margin-left: 6px;">₹${origPrice}</span> <span style="font-size: 11px; background: #dcfce7; color: #15803d; font-weight: 800; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">Save ₹${saveAmt}</span>`;
  }
}

function confirmAddCustomizedPizzaToCart() {
  if (!currentCustomizingItem) return;

  const finalPrice = calculateCustomizationPrice();
  const toppingsArray = Array.from(selectedExtraToppings);
  const toppingsKey = toppingsArray.sort().join('_') || 'none';
  const customCartId = `${currentCustomizingItem.id}-${selectedPizzaSize}-${selectedPizzaCrust.replace(/\s+/g, '_')}-${toppingsKey}`;

  const existing = cart.find(i => i.id === customCartId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: customCartId,
      baseId: currentCustomizingItem.id,
      name: currentCustomizingItem.name,
      price: finalPrice,
      quantity: 1,
      isCombo: false,
      isCustomizedPizza: true,
      image: currentCustomizingItem.imageUrl || currentCustomizingItem.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      imageUrl: currentCustomizingItem.imageUrl || currentCustomizingItem.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      customSize: selectedPizzaSize,
      customCrust: selectedPizzaCrust,
      customToppings: toppingsArray,
      dominosCode: currentCustomizingItem.dominosCode,
      skuId: currentCustomizingItem.skuId
    });
  }

  closeModal('pizzaCustomizationModal');
  updateCartBadge();
  renderFloatingCartBar();
  applyCurrentFilters();
  showToastNotice(`Added ${currentCustomizingItem.name} (${selectedPizzaSize}) to cart!`, '🍕');
}

function addItemToCart(itemId) {
  // MANDATORY CURRENT LOCATION GATE
  if (!hasUserLocation) {
    pendingItemToCart = { type: 'item', id: itemId };
    openModal('locationRequiredModal');
    return;
  }

  const item = catalog.menu.find(i => i.id === itemId);
  if (!item) return;

  if (item.isAvailable === false) {
    showToastNotice(`🚫 ${item.name} is unavailable at your area.`, 'ℹ️');
    return;
  }

  // Customization rules: Pizzas allow size (Regular/Medium/Large), crust & topping customizations!
  const isPizzaCategory = (item.category && item.category.toLowerCase().includes('pizza')) || (item.name && item.name.toLowerCase().includes('pizza'));
  const hasMultipleSizes = (item.allowedSizes && item.allowedSizes.length > 1) || isPizzaCategory;
  const hasMultipleCrusts = (item.allowedCrusts && item.allowedCrusts.length > 1) || isPizzaCategory;
  const isCustomizablePizza = item.isCustomizable !== false && hasMultipleSizes && !item.isPizzaMania;
  const isManiaWithCrusts = item.isPizzaMania && hasMultipleCrusts;

  if (isCustomizablePizza || isManiaWithCrusts) {
    openPizzaCustomizationModal(item);
    return;
  }

  // Items with fixed size & crust, Sides, Desserts, Beverages -> Added directly to cart drawer!
  const existing = cart.find(i => i.id === item.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: item.id,
      name: item.name,
      price: item.price,
      quantity: 1,
      isCombo: false,
      image: item.imageUrl || item.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      imageUrl: item.imageUrl || item.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      dominosCode: item.dominosCode,
      skuId: item.skuId
    });
  }

  updateCartBadge();
  renderFloatingCartBar();
  applyCurrentFilters();
  showToastNotice(`Added ${item.name} to cart!`, '🍕');
}

function changeQty(itemId, delta) {
  const item = cart.find(i => i.id === itemId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter(i => i.id !== itemId);
  }

  updateCartBadge();
  renderCartDrawer();
  applyCurrentFilters();
}

function removeFromCart(itemId) {
  const item = cart.find(i => i.id === itemId);
  const name = item ? item.name : 'Item';
  cart = cart.filter(i => i.id !== itemId);
  updateCartBadge();
  renderCartDrawer();
  applyCurrentFilters();
  showToastNotice(`Removed ${name} from cart.`, '🗑️');
}

function clearEntireCart() {
  if (cart.length === 0) return;
  if (confirm('Are you sure you want to clear all items from your cart?')) {
    cart = [];
    appliedCartPromo = null;
    updateCartBadge();
    renderCartDrawer(false);
    applyCurrentFilters();
    showToastNotice('Cart has been cleared.', '🗑️');
  }
}

function updateCartBadge() {
  const count = cart.reduce((acc, i) => acc + (i.quantity || 1), 0);
  const badgeEl = document.getElementById('cartCount');
  if (badgeEl) badgeEl.innerText = count;
  const mbBadgeEl = document.getElementById('mbCartCount');
  if (mbBadgeEl) mbBadgeEl.innerText = count;
  renderFloatingCartBar();
}

function renderFloatingCartBar() {
  const bar = document.getElementById('floatingCartBar');
  if (!bar) return;
  const count = cart.reduce((acc, i) => acc + (i.quantity || 1), 0);
  if (count <= 0) {
    bar.style.display = 'none';
    return;
  }
  const subtotal = cart.reduce((acc, i) => acc + ((i.price || 0) * (i.quantity || 1)), 0);
  const countEl = document.getElementById('floatingCartCount');
  const totalEl = document.getElementById('floatingCartTotal');
  if (countEl) countEl.innerText = count;
  if (totalEl) totalEl.innerText = `₹${subtotal}`;
  bar.style.display = 'flex';
}

let appliedCartPromo = null; // { code: 'NEWBIE100', discountAmount: 100 }
let isCartVerifying = false;

function setPromoInput(code) {
  const input = document.getElementById('cartPromoInput');
  if (input) input.value = code;
  applyCartPromoCode();
}

async function applyCartPromoCode() {
  const input = document.getElementById('cartPromoInput');
  const code = (input?.value || '').trim().toUpperCase();
  const feedbackEl = document.getElementById('promoFeedbackMsg');
  const badgeEl = document.getElementById('appliedPromoBadge');
  const applyBtn = document.getElementById('btnApplyCartPromo');
  const removeBtn = document.getElementById('btnRemoveCartPromo');

  if (!code) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.color = '#ef4444';
      feedbackEl.innerText = 'Please enter a promo coupon code.';
    }
    return;
  }

  const subtotal = cart.reduce((sum, item) => sum + (Number(item.price) || 0) * (item.quantity || 1), 0);

  try {
    const res = await fetch('/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, subtotal })
    });
    const data = await res.json();
    if (!res.ok || !data.valid) {
      appliedCartPromo = null;
      if (badgeEl) badgeEl.style.display = 'none';
      if (removeBtn) removeBtn.style.display = 'none';
      if (applyBtn) applyBtn.style.display = 'inline-block';
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.color = '#ef4444';
        feedbackEl.innerText = `❌ ${data.error || 'Invalid or expired promo code.'}`;
      }
      renderCartDrawer(false);
      return;
    }

    appliedCartPromo = {
      code: data.code,
      discountAmount: data.discountAmount,
      minCart: data.minCart || (data.code === 'CHEESY' ? 150 : 200),
      discountType: data.discountType || 'FLAT',
      percent: data.percent,
      maxDiscount: data.maxDiscount
    };
    if (badgeEl) {
      badgeEl.style.display = 'inline-block';
      badgeEl.innerText = `✓ ${data.code} (-₹${data.discountAmount})`;
    }
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.color = '#15803d';
      feedbackEl.innerText = data.message || `🎉 Promo "${data.code}" Applied: -₹${data.discountAmount}!`;
    }
    if (applyBtn) applyBtn.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'inline-block';

    showToastNotice(`Promo "${data.code}" applied: ₹${data.discountAmount} discount!`, '🎟️');
    renderCartDrawer(false);
  } catch (err) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.color = '#ef4444';
      feedbackEl.innerText = `Failed to validate coupon: ${err.message}`;
    }
  }
}

function removeCartPromoCode() {
  appliedCartPromo = null;
  const input = document.getElementById('cartPromoInput');
  const feedbackEl = document.getElementById('promoFeedbackMsg');
  const badgeEl = document.getElementById('appliedPromoBadge');
  const applyBtn = document.getElementById('btnApplyCartPromo');
  const removeBtn = document.getElementById('btnRemoveCartPromo');

  if (input) input.value = '';
  if (feedbackEl) feedbackEl.style.display = 'none';
  if (badgeEl) badgeEl.style.display = 'none';
  if (applyBtn) applyBtn.style.display = 'inline-block';
  if (removeBtn) removeBtn.style.display = 'none';

  showToastNotice('Promo code removed', 'ℹ️');
  renderCartDrawer(false);
}

async function verifyCartWithKitchen() {
  if (cart.length === 0 || isCartVerifying) return;
  isCartVerifying = true;

  const selectedAddrId = document.getElementById('cartAddressSelect')?.value;
  const selectedAddr = (currentUser.savedAddresses || []).find(a => a.id === selectedAddrId);
  const lat = selectedAddr?.latitude || currentCoordinates?.latitude;
  const lng = selectedAddr?.longitude || currentCoordinates?.longitude;
  const targetStoreId = currentResolvedStore?.storeId || selectedAddr?.storeId || '63859';

  try {
    const res = await fetch('/api/catalog/verify-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: targetStoreId,
        lat,
        lng,
        items: cart
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      let priceChanged = false;
      (data.items || []).forEach(vItem => {
        const cItem = cart.find(i => i.id === vItem.id);
        if (cItem) {
          if (vItem.verifiedPrice && vItem.verifiedPrice !== cItem.price) {
            cItem.originalPrice = cItem.price;
            cItem.price = vItem.verifiedPrice;
            priceChanged = true;
          }
          cItem.isAvailable = vItem.isAvailable;
          cItem.unavailableReason = vItem.unavailableReason;
        }
      });

      const syncNotice = document.getElementById('cartRateSyncNotice');
      const syncLabel = document.getElementById('cartRateSyncLabel');
      if (syncNotice && syncLabel) {
        const timingNotice = data.store?.deliveryTimingNotice || currentResolvedStore?.deliveryTimingNotice;
        if (timingNotice) {
          syncNotice.style.background = '#fffbeb';
          syncNotice.style.borderColor = '#fcd34d';
          syncLabel.innerText = `Domino's Kitchen (${data.store?.storeName || currentResolvedStore?.storeName || 'Store #' + targetStoreId}) • Delivery opens at 11:00 AM IST (Cart items verified)`;
        } else {
          syncNotice.style.background = '#f0fdf4';
          syncNotice.style.borderColor = '#86efac';
          syncLabel.innerText = `Verified with Domino's Kitchen (${data.store?.storeName || currentResolvedStore?.storeName || 'Store #' + targetStoreId}) • Prices & Stock 100% Live`;
        }
      }

      if (priceChanged) {
        showToastNotice('Cart prices refreshed to match local kitchen rates!', '⚡');
      }

      renderCartDrawer(false);
    }
  } catch (e) {
    console.warn('Cart verify note:', e);
  } finally {
    isCartVerifying = false;
  }
}

function openCartModal() {
  syncCartAddressOptions();
  syncTopBarAddressOptions();
  renderCartDrawer(true);
  verifyCartWithKitchen();
  openModal('cartModal');
}

function renderCartDrawer(triggerRemoteVerify = true) {
  const container = document.getElementById('cartItemsList');
  const outOfStockBanner = document.getElementById('cartOutOfStockWarning');
  const proceedBtn = document.getElementById('cartProceedBtn');
  if (!container) return;

  if (cart.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: var(--gray-600); padding: 20px;">Your cart is currently empty. Explore our delicious combos or pizzas!</p>';
    if (document.getElementById('billSubtotal')) document.getElementById('billSubtotal').innerText = '₹0';
    if (document.getElementById('billGstPreview')) document.getElementById('billGstPreview').innerText = '₹0';
    if (document.getElementById('billDeliveryFeePreview')) document.getElementById('billDeliveryFeePreview').innerText = '₹0';
    if (document.getElementById('billPackagingPreview')) document.getElementById('billPackagingPreview').innerText = '₹0';
    if (document.getElementById('billDiscountRow')) document.getElementById('billDiscountRow').style.display = 'none';
    if (document.getElementById('billTotal')) document.getElementById('billTotal').innerText = '₹0';
    if (outOfStockBanner) outOfStockBanner.style.display = 'none';
    if (proceedBtn) {
      proceedBtn.disabled = true;
      proceedBtn.innerText = 'Cart is Empty';
      proceedBtn.style.background = '#94a3b8';
      proceedBtn.style.cursor = 'not-allowed';
    }
    return;
  }

  let subtotal = 0;
  let hasOutOfStockItem = false;

  container.innerHTML = cart.map(item => {
    const itemTotal = item.price * item.quantity;
    subtotal += itemTotal;

    // Check store availability
    let isItemOutOfStock = item.isAvailable === false;
    if (!isItemOutOfStock && catalog.menu && catalog.menu.length > 0) {
      const match = catalog.menu.find(m => m.id === item.id || m.dominosCode === item.dominosCode || (item.skuId && m.skuId === item.skuId));
      if (match && match.isAvailable === false) {
        isItemOutOfStock = true;
      }
    }
    if (isItemOutOfStock) hasOutOfStockItem = true;

    const customInfo = item.isCustomizedPizza 
      ? `<div style="font-size: 11px; color: #0284c7; font-weight: 600; margin-top: 2px;">
           ${item.customSize} • ${item.customCrust} ${item.customToppings?.length ? `• +${item.customToppings.join(', ')}` : ''}
         </div>`
      : '';

    const outOfStockNotice = isItemOutOfStock
      ? `<div style="font-size: 11px; color: #dc2626; font-weight: 800; margin-top: 3px; display: flex; align-items: center; gap: 4px;">
           <span>⚠️</span> <span>${item.unavailableReason || 'OUT OF STOCK AT LOCAL STORE'}</span>
         </div>`
      : '';

    const rateChangedPill = item.originalPrice && item.originalPrice !== item.price
      ? `<span style="font-size: 10px; font-weight: 700; color: #b45309; background: #fef3c7; padding: 1px 6px; border-radius: 4px; margin-left: 4px;">Rate Updated (Was ₹${item.originalPrice})</span>`
      : '';

    let imgSrc = item.imageUrl || item.image;
    if (!imgSrc && catalog.menu) {
      const match = catalog.menu.find(m => m.id === item.id || m.id === item.baseId || m.dominosCode === item.dominosCode);
      if (match) imgSrc = match.imageUrl || match.image;
    }
    if (!imgSrc && catalog.combos) {
      const match = catalog.combos.find(c => c.id === item.id);
      if (match) imgSrc = match.image;
    }
    if (!imgSrc) imgSrc = 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';

    return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--gray-200); ${isItemOutOfStock ? 'background: #fef2f2; border-radius: 6px; padding: 8px;' : ''}">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
          <img src="${imgSrc}" alt="${item.name}" style="width: 44px; height: 44px; object-fit: cover; border-radius: 6px; border: 1px solid #cbd5e1; flex-shrink: 0;" onerror="this.src='https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp'">
          <div style="flex: 1;">
            <div style="font-weight: 700; font-size: 14px; color: var(--dark); display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
              <span>${item.name}</span>
              ${rateChangedPill}
            </div>
            ${customInfo}
            ${outOfStockNotice}
            <div style="font-size: 12px; color: var(--gray-600);">₹${item.price} each ${item.isCombo ? '• (Combo Pack)' : ''}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          <button style="border: 1px solid var(--gray-300); background: #f8fafc; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-weight: 800; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; touch-action: manipulation; transition: all 0.15s;" onclick="changeQty('${item.id}', -1)" aria-label="Decrease quantity">-</button>
          <span style="font-weight: 800; font-size: 14px; min-width: 20px; text-align: center;">${item.quantity}</span>
          <button style="border: 1px solid var(--gray-300); background: #f8fafc; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-weight: 800; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; touch-action: manipulation; transition: all 0.15s;" onclick="changeQty('${item.id}', 1)" aria-label="Increase quantity">+</button>
          <span style="font-weight: 900; font-size: 14px; margin-left: 6px; min-width: 48px; text-align: right; color: var(--dark);">₹${itemTotal}</span>
          <button onclick="removeFromCart('${item.id}')" title="Remove item" style="border: none; background: #fee2e2; color: #b91c1c; width: 30px; height: 30px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center; touch-action: manipulation;" aria-label="Remove item">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  // 5-Line Domino's Verified Bill Calculation
  const gst = Math.round(subtotal * 0.05 * 100) / 100;
  const deliveryFee = 35;
  const packagingFee = 0;
  
  // Dynamic coupon validation: verify cart subtotal meets coupon requirement
  if (appliedCartPromo) {
    const minRequired = appliedCartPromo.minCart || (appliedCartPromo.code === 'CHEESY' ? 150 : 200);
    if (subtotal < minRequired) {
      const removedCode = appliedCartPromo.code;
      appliedCartPromo = null;
      const promoInput = document.getElementById('cartPromoInput');
      if (promoInput) promoInput.value = '';
      const feedbackEl = document.getElementById('promoFeedbackMsg');
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.color = '#ef4444';
        feedbackEl.innerText = `ℹ️ Promo code ${removedCode} removed: minimum cart subtotal is ₹${minRequired}.`;
      }
      const badgeEl = document.getElementById('promoAppliedBadge');
      if (badgeEl) badgeEl.style.display = 'none';
      const removeBtn = document.getElementById('cartPromoRemoveBtn');
      if (removeBtn) removeBtn.style.display = 'none';
    } else if (appliedCartPromo.discountType === 'PERCENT' && appliedCartPromo.percent) {
      // Recalculate percent discount dynamically
      appliedCartPromo.discountAmount = Math.min(appliedCartPromo.maxDiscount || 100, Math.round(subtotal * (appliedCartPromo.percent / 100)));
    }
  }

  // Calculate discount if promo applied
  let discountAmount = 0;
  if (appliedCartPromo && appliedCartPromo.discountAmount > 0) {
    discountAmount = Number(appliedCartPromo.discountAmount);
    const discountRow = document.getElementById('billDiscountRow');
    const discountLabel = document.getElementById('billDiscountLabel');
    const discountEl = document.getElementById('billDiscountAmount');
    if (discountRow) discountRow.style.display = 'flex';
    if (discountLabel) discountLabel.innerText = `Promo Discount (${appliedCartPromo.code})`;
    if (discountEl) discountEl.innerText = `-₹${discountAmount}`;
  } else {
    const discountRow = document.getElementById('billDiscountRow');
    if (discountRow) discountRow.style.display = 'none';
  }

  const grandTotal = Math.max(0, Math.round(subtotal + gst + deliveryFee + packagingFee - discountAmount));

  if (document.getElementById('billSubtotal')) document.getElementById('billSubtotal').innerText = `₹${subtotal}`;
  if (document.getElementById('billGstPreview')) document.getElementById('billGstPreview').innerText = `₹${gst}`;
  if (document.getElementById('billDeliveryFeePreview')) document.getElementById('billDeliveryFeePreview').innerText = `₹${deliveryFee}`;
  if (document.getElementById('billPackagingPreview')) document.getElementById('billPackagingPreview').innerText = 'FREE';
  if (document.getElementById('billTotal')) document.getElementById('billTotal').innerText = `₹${grandTotal}`;

  // Handle Out of Stock Cart Blocking
  if (hasOutOfStockItem) {
    if (outOfStockBanner) outOfStockBanner.style.display = 'block';
    if (proceedBtn) {
      proceedBtn.disabled = true;
      proceedBtn.style.background = '#ef4444';
      proceedBtn.style.cursor = 'not-allowed';
      proceedBtn.innerText = '⚠️ Remove Out-of-Stock Items to Proceed';
    }
  } else {
    if (outOfStockBanner) outOfStockBanner.style.display = 'none';
    if (proceedBtn && isStoreServiceable) {
      proceedBtn.disabled = false;
      proceedBtn.style.background = 'var(--primary)';
      proceedBtn.style.cursor = 'pointer';
      proceedBtn.innerText = currentPaymentMethod === 'COD'
        ? 'Place Cash on Delivery Order →'
        : 'Proceed to Online QR Payment →';
    }
  }

  // Trigger real-time remote verification against local Domino's kitchen
  if (triggerRemoteVerify) {
    verifyCartWithKitchen();
  }
}

// Payment Method State & Handler
let currentPaymentMethod = 'COD';

function onPaymentMethodChange(method) {
  currentPaymentMethod = method;
  const lblCOD = document.getElementById('lblPayCOD');
  const lblUPI = document.getElementById('lblPayUPI');
  const note = document.getElementById('paymentMethodNote');
  const proceedBtn = document.getElementById('cartProceedBtn');

  if (method === 'COD') {
    if (lblCOD) {
      lblCOD.style.border = '2px solid #0055a5';
      lblCOD.style.background = '#eff6ff';
      lblCOD.style.color = '#0055a5';
    }
    if (lblUPI) {
      lblUPI.style.border = '1.5px solid #cbd5e1';
      lblUPI.style.background = '#ffffff';
      lblUPI.style.color = '#475569';
    }
    if (note) {
      note.innerHTML = '✓ Robot automatically adds items to Domino\'s site and places order as <strong>Cash on Delivery</strong>! Pay cash to the Domino\'s rider upon delivery.';
    }
    if (proceedBtn && !proceedBtn.disabled) {
      proceedBtn.innerText = 'Place Cash on Delivery Order →';
    }
  } else {
    if (lblCOD) {
      lblCOD.style.border = '1.5px solid #cbd5e1';
      lblCOD.style.background = '#ffffff';
      lblCOD.style.color = '#475569';
    }
    if (lblUPI) {
      lblUPI.style.border = '2px solid #0055a5';
      lblUPI.style.background = '#eff6ff';
      lblUPI.style.color = '#0055a5';
    }
    if (note) {
      note.innerHTML = '✓ Complete payment instantly via UPI QR code. Once confirmed, Domino\'s order engine is automatically dispatched.';
    }
    if (proceedBtn && !proceedBtn.disabled) {
      proceedBtn.innerText = 'Proceed to Online QR Payment →';
    }
  }
}

function removeOutOfStockCartItems() {
  const initialCount = cart.length;
  cart = cart.filter(item => {
    if (item.isAvailable === false) return false;
    if (catalog.menu && catalog.menu.length > 0) {
      const match = catalog.menu.find(m => m.id === item.id || m.dominosCode === item.dominosCode || (item.skuId && m.skuId === item.skuId));
      if (match && match.isAvailable === false) return false;
    }
    return true;
  });
  const removed = initialCount - cart.length;
  updateCartBadge();
  renderCartDrawer(false);
  showToastNotice(`Removed ${removed} out-of-stock item(s) from cart.`, '🗑️');
}

// Inline Address Quick Add within Cart Drawer
function toggleCartInlineAddAddress(show = null) {
  const form = document.getElementById('cartInlineAddAddrForm');
  const btn = document.getElementById('btnToggleCartInlineAddr');
  if (!form) return;
  const willShow = show !== null ? show : form.style.display === 'none';
  form.style.display = willShow ? 'block' : 'none';
  if (btn) btn.innerText = willShow ? '✕ Close Form' : '+ Add / Change Address';
  if (willShow) {
    const f = document.getElementById('cartInlineFlat');
    if (f) { f.value = ''; f.focus(); }
    const s = document.getElementById('cartInlineStreet');
    if (s) s.value = '';
    const rNameInput = document.getElementById('cartInlineReceiverName');
    if (rNameInput) rNameInput.value = document.getElementById('cartReceiverNameInput')?.value || currentUser.name || 'Parth Sharma';
    const rPhoneInput = document.getElementById('cartInlineReceiverPhone');
    if (rPhoneInput) rPhoneInput.value = (document.getElementById('cartReceiverPhoneInput')?.value || currentUser.phone || '').replace(/[^0-9]/g, '').slice(-10);
  }
}

async function submitCartInlineAddress() {
  const flat = (document.getElementById('cartInlineFlat')?.value || '').trim();
  const street = (document.getElementById('cartInlineStreet')?.value || '').trim();
  if (!flat || !street) {
    alert('Please enter both House/Flat/Room No. and Street/Building address.');
    return;
  }

  const fallbackLat = (currentCoordinates && currentCoordinates.latitude) ? currentCoordinates.latitude : 28.5355;
  const fallbackLng = (currentCoordinates && currentCoordinates.longitude) ? currentCoordinates.longitude : 77.3910;

  const city = (document.getElementById('cartInlineCity')?.value || '').trim() || currentDetectedCity || 'Chandigarh';
  const pincode = (document.getElementById('cartInlinePincode')?.value || '').trim() || '160015';

  const customReceiverName = (document.getElementById('cartInlineReceiverName')?.value || document.getElementById('cartReceiverNameInput')?.value || '').trim();
  const customReceiverPhone = (document.getElementById('cartInlineReceiverPhone')?.value || document.getElementById('cartReceiverPhoneInput')?.value || '').trim();
  const rName = customReceiverName || currentUser.name || 'Parth Sharma';
  const cleanPhone = customReceiverPhone.replace(/[^0-9]/g, '').slice(-10) || (currentUser.phone || '').replace(/[^0-9]/g, '').slice(-10) || '7893618933';
  const rPhone = `+91 ${cleanPhone}`;

  const payload = {
    label: 'Home',
    firstName: rName.split(' ')[0],
    lastName: rName.split(' ').slice(1).join(' ') || 'Sharma',
    name: rName,
    phone: rPhone,
    flat: flat,
    completeAddress: `${flat}, ${street}, ${city} ${pincode}`,
    street: street,
    building: street,
    landmark: '',
    city: city,
    pincode: pincode,
    latitude: fallbackLat,
    longitude: fallbackLng,
    isDefault: true
  };

  try {
    const res = await fetch('/api/user/profile/address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save address');

    currentUser.savedAddresses = data.addresses;
    toggleCartInlineAddAddress(false);
    syncCartAddressOptions();
    syncTopBarAddressOptions();
    showToastNotice('Delivery address saved & selected for cart!', '✅');

    const addedAddr = data.activeAddress || (data.addresses || [])[0];
    if (addedAddr) {
      const select = document.getElementById('cartAddressSelect');
      if (select) select.value = addedAddr.id;
      await onCartAddressDropdownChange(addedAddr.id);
    } else {
      await applyResolvedLocation(fallbackLat, fallbackLng, LOCATION_PRIORITY.USER_MANUAL, 'Inline Address Save');
    }
  } catch (err) {
    alert('Failed to save address: ' + err.message);
  }
}

// Bi-directional Address & Delivery State Manager
let currentActiveDeliveryId = null;

function getActiveSelectedAddress() {
  const addresses = currentUser.savedAddresses || [];
  if (!currentActiveDeliveryId || currentActiveDeliveryId === 'DEFAULT') {
    const def = addresses.find(a => a.isDefault) || addresses[0];
    currentActiveDeliveryId = def ? def.id : 'CURRENT_GPS';
  }
  if (currentActiveDeliveryId === 'CURRENT_GPS') {
    return {
      id: 'CURRENT_GPS',
      name: currentUser.name || 'Parth',
      phone: currentUser.phone || '+91 7893618933',
      flat: document.getElementById('cartQuickFlatInput')?.value || document.getElementById('topBarFlatInput')?.value || 'Current Location',
      completeAddress: currentResolvedStore ? `Near ${currentResolvedStore.storeName}` : 'GPS Verified Area',
      latitude: currentCoordinates ? currentCoordinates.latitude : 30.7410,
      longitude: currentCoordinates ? currentCoordinates.longitude : 76.7735
    };
  }
  return addresses.find(a => a.id === currentActiveDeliveryId) || addresses[0] || null;
}

// Sync top bar address dropdown and input
function syncTopBarAddressOptions() {
  const select = document.getElementById('topBarAddressSelect');
  const flatInput = document.getElementById('topBarFlatInput');
  const addresses = currentUser.savedAddresses || [];
  if (!select) return;

  if (!currentActiveDeliveryId || currentActiveDeliveryId === 'DEFAULT') {
    const def = addresses.find(a => a.isDefault) || addresses[0];
    currentActiveDeliveryId = def ? def.id : 'CURRENT_GPS';
  }

  const options = [];
  addresses.forEach(addr => {
    const labelIcon = addr.label === 'Work' ? '🏢' : (addr.label === 'Home' ? '🏠' : '📍');
    const flatPart = addr.flat ? `${addr.flat}, ` : '';
    const streetPart = addr.street || addr.completeAddress || addr.building || addr.city || 'Delivery Area';
    const isSelected = addr.id === currentActiveDeliveryId;
    options.push(`
      <option value="${addr.id}" ${isSelected ? 'selected' : ''} style="background: #0f172a; color: #f8fafc; padding: 8px; font-weight: 700;">
        ${labelIcon} ${addr.label || 'Saved'}: ${flatPart}${streetPart}
      </option>
    `);
  });

  const isGpsSelected = currentActiveDeliveryId === 'CURRENT_GPS';
  options.push(`
    <option value="CURRENT_GPS" ${isGpsSelected ? 'selected' : ''} style="background: #0f172a; color: #f8fafc; padding: 8px; font-weight: 700;">
      📍 Current GPS Location
    </option>
  `);

  select.innerHTML = options.join('');
  select.value = currentActiveDeliveryId;

  const curAddr = getActiveSelectedAddress();
  if (flatInput && curAddr && curAddr.flat && curAddr.id !== 'CURRENT_GPS') {
    flatInput.value = curAddr.flat;
  }
}

async function onTopBarAddressSelectChange(val) {
  currentActiveDeliveryId = val;
  const cartSelect = document.getElementById('cartAddressSelect');
  const topFlatInput = document.getElementById('topBarFlatInput');
  const cartQuickInput = document.getElementById('cartQuickFlatInput');
  const quickFlatWrap = document.getElementById('cartQuickFlatWrapper');

  if (val === 'CURRENT_GPS') {
    if (cartSelect) cartSelect.value = 'CURRENT_LOCATION';
    if (quickFlatWrap) quickFlatWrap.style.display = 'block';
    await detectUserLocation();
    displayCartAddress(getActiveSelectedAddress());
  } else {
    if (cartSelect) cartSelect.value = val;
    if (quickFlatWrap) quickFlatWrap.style.display = 'none';
    const addr = (currentUser.savedAddresses || []).find(a => a.id === val);
    if (addr) {
      if (topFlatInput) topFlatInput.value = addr.flat || '';
      if (cartQuickInput) cartQuickInput.value = addr.flat || '';
      displayCartAddress(addr, true);
      if (addr.latitude && addr.longitude) {
        await applyResolvedLocation(addr.latitude, addr.longitude, LOCATION_PRIORITY.USER_MANUAL, 'Top Bar Selected Address');
      }
    }
  }
  syncCartAddressOptions();
}

function onTopBarFlatInputChange(val) {
  const cartQuickInput = document.getElementById('cartQuickFlatInput');
  if (cartQuickInput) cartQuickInput.value = val;
  const curAddr = getActiveSelectedAddress();
  if (curAddr) {
    curAddr.flat = val;
    displayCartAddress(curAddr);
  }
}

// Sync cart address dropdown and preview
function syncCartAddressOptions() {
  const select = document.getElementById('cartAddressSelect');
  const preview = document.getElementById('cartAddressPreview');
  const quickFlatWrap = document.getElementById('cartQuickFlatWrapper');
  const addresses = currentUser.savedAddresses || [];

  if (!select) return;

  if (!currentActiveDeliveryId || currentActiveDeliveryId === 'DEFAULT') {
    const def = addresses.find(a => a.isDefault) || addresses[0];
    currentActiveDeliveryId = def ? def.id : 'CURRENT_GPS';
  }

  const targetCartVal = (currentActiveDeliveryId === 'CURRENT_GPS') ? 'CURRENT_LOCATION' : currentActiveDeliveryId;

  const options = [];
  addresses.forEach(addr => {
    const completeAddr = addr.completeAddress || addr.building || addr.street || '';
    const labelIcon = addr.label === 'Work' ? '🏢' : (addr.label === 'Home' ? '🏠' : '📍');
    const isSelected = addr.id === targetCartVal;
    options.push(`
      <option value="${addr.id}" ${isSelected ? 'selected' : ''}>
        ${labelIcon} ${addr.label || 'Address'}: ${addr.flat}, ${completeAddr} ${addr.isDefault ? '★ Default' : ''}
      </option>
    `);
  });

  const isCurLocSelected = targetCartVal === 'CURRENT_LOCATION';
  if (currentCoordinates) {
    options.push(`
      <option value="CURRENT_LOCATION" ${isCurLocSelected ? 'selected' : ''}>
        📍 Deliver to My Current Location (${currentCoordinates.latitude.toFixed(4)}, ${currentCoordinates.longitude.toFixed(4)})
      </option>
    `);
  }

  if (options.length === 0) {
    select.innerHTML = '<option value="">Location required to verify delivery.</option>';
    if (preview) preview.innerHTML = '<em>Please detect your location or add an address.</em>';
    if (quickFlatWrap) quickFlatWrap.style.display = 'none';
    return;
  }

  select.innerHTML = options.join('');
  select.value = targetCartVal;

  if (targetCartVal === 'CURRENT_LOCATION') {
    if (quickFlatWrap) quickFlatWrap.style.display = 'block';
  } else {
    if (quickFlatWrap) quickFlatWrap.style.display = 'none';
  }

  const activeAddr = getActiveSelectedAddress();
  if (activeAddr) {
    displayCartAddress(activeAddr);
  }
}

async function onCartAddressDropdownChange(selectedId) {
  const quickFlatWrap = document.getElementById('cartQuickFlatWrapper');
  const topSelect = document.getElementById('topBarAddressSelect');
  const topFlatInput = document.getElementById('topBarFlatInput');
  const cartQuickInput = document.getElementById('cartQuickFlatInput');

  if (selectedId === 'CURRENT_LOCATION') {
    currentActiveDeliveryId = 'CURRENT_GPS';
    if (topSelect) topSelect.value = 'CURRENT_GPS';
    if (quickFlatWrap) quickFlatWrap.style.display = 'block';
    if (currentCoordinates) {
      displayCartAddress(getActiveSelectedAddress());
      await applyResolvedLocation(currentCoordinates.latitude, currentCoordinates.longitude, LOCATION_PRIORITY.HARDWARE_GPS, 'Cart Dropdown GPS');
    } else {
      await detectUserLocation();
      displayCartAddress(getActiveSelectedAddress());
    }
    return;
  }

  currentActiveDeliveryId = selectedId;
  if (quickFlatWrap) quickFlatWrap.style.display = 'none';
  if (topSelect) topSelect.value = selectedId;

  const addr = (currentUser.savedAddresses || []).find(a => a.id === selectedId);
  if (!addr) return;

  if (topFlatInput && addr.flat) topFlatInput.value = addr.flat;
  if (cartQuickInput && addr.flat) cartQuickInput.value = addr.flat;
  displayCartAddress(addr, true);

  // Re-verify store serviceability with this address's coordinates
  if (addr.latitude && addr.longitude) {
    await applyResolvedLocation(addr.latitude, addr.longitude, LOCATION_PRIORITY.USER_MANUAL, 'Cart Address Dropdown');
  }
}

function displayCartAddress(addr, forceSync = false) {
  const preview = document.getElementById('cartAddressPreview');
  const coordEl = document.getElementById('cartCoordinatesPreview');
  const rNameInput = document.getElementById('cartReceiverNameInput');
  const rPhoneInput = document.getElementById('cartReceiverPhoneInput');
  if (!addr) return;

  const recipientName = addr.name || (addr.firstName ? `${addr.firstName} ${addr.lastName || ''}`.trim() : (currentUser.name || 'Parth Sharma'));
  const recipientPhone = addr.phone || currentUser.phone || '+91 7893618933';
  const completeAddr = addr.completeAddress || addr.building || addr.street || '';
  const landmark = addr.landmark ? ` (Landmark: ${addr.landmark})` : '';

  // Only overwrite the input fields if forceSync is explicitly true (e.g. user selected another address from dropdown)
  // or if the inputs are currently empty. NEVER overwrite when the user is actively typing!
  const isTypingName = document.activeElement === rNameInput;
  const isTypingPhone = document.activeElement === rPhoneInput;

  if (rNameInput && (forceSync || !rNameInput.value.trim()) && !isTypingName) {
    rNameInput.value = recipientName;
  }
  if (rPhoneInput && (forceSync || !rPhoneInput.value.trim()) && !isTypingPhone) {
    rPhoneInput.value = recipientPhone.replace(/[^0-9]/g, '').slice(-10);
  }

  // Register address contact in recent receivers
  try {
    const cleanNum = (rPhoneInput?.value || recipientPhone).replace(/[^0-9]/g, '').slice(-10);
    if (cleanNum.length === 10) {
      let recHistory = JSON.parse(localStorage.getItem('dominos_recent_receivers') || '[]');
      recHistory = recHistory.filter(r => r.phone !== cleanNum);
      recHistory.unshift({ name: rNameInput?.value || recipientName, phone: cleanNum });
      localStorage.setItem('dominos_recent_receivers', JSON.stringify(recHistory.slice(0, 5)));
    }
  } catch (e) {}

  const curName = rNameInput?.value || recipientName;
  const curPhone = rPhoneInput?.value || recipientPhone;
  const activeFlat = addr.flat || document.getElementById('topBarFlatInput')?.value || document.getElementById('cartQuickFlatInput')?.value || 'Flat';

  if (preview) {
    preview.innerHTML = `
      <div style="margin-bottom: 4px;">
        <span style="font-weight: 800; color: #0f172a; font-size: 13px;">📍 ${activeFlat}</span>, <span style="color: #334155;">${completeAddr}${landmark}</span>
      </div>
      <div style="font-size: 11px; color: #475569; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
        <span>👤 <strong>${curName}</strong></span>
        <span>•</span>
        <span>📞 <strong>+91 ${curPhone.replace(/[^0-9]/g, '').slice(-10)}</strong></span>
      </div>
      <div style="margin-top: 4px; font-size: 11px; color: #0284c7; font-weight: 700; display: flex; align-items: center; gap: 4px;">
        <span>🛵</span> <span>Domino's delivery rider will call this number upon doorstep arrival.</span>
      </div>
    `;
  }
  if (coordEl && addr.latitude && addr.longitude) {
    coordEl.innerText = `📡 Locked GPS: [${Number(addr.latitude).toFixed(6)}, ${Number(addr.longitude).toFixed(6)}]`;
  }
  renderReceiverHistoryPills();
}

function onReceiverDetailsChange() {
  const rName = (document.getElementById('cartReceiverNameInput')?.value || '').trim();
  const rPhone = (document.getElementById('cartReceiverPhoneInput')?.value || '').trim();
  const preview = document.getElementById('cartAddressPreview');
  const curAddr = getActiveSelectedAddress() || {};
  const activeFlat = curAddr.flat || document.getElementById('topBarFlatInput')?.value || document.getElementById('cartQuickFlatInput')?.value || 'Flat';
  const completeAddr = curAddr.completeAddress || curAddr.building || curAddr.street || 'Delivery Address';
  const landmark = curAddr.landmark ? ` (Landmark: ${curAddr.landmark})` : '';

  if (preview) {
    const cleanPhone = rPhone.replace(/[^0-9]/g, '').slice(-10);
    preview.innerHTML = `
      <div style="margin-bottom: 4px;">
        <span style="font-weight: 800; color: #0f172a; font-size: 13px;">📍 ${activeFlat}</span>, <span style="color: #334155;">${completeAddr}${landmark}</span>
      </div>
      <div style="font-size: 11px; color: #475569; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
        <span>👤 <strong>${rName || curAddr.name || 'Receiver'}</strong></span>
        <span>•</span>
        <span>📞 <strong>+91 ${cleanPhone || (curAddr.phone || '').replace(/[^0-9]/g, '').slice(-10)}</strong></span>
      </div>
      <div style="margin-top: 4px; font-size: 11px; color: #0284c7; font-weight: 700; display: flex; align-items: center; gap: 4px;">
        <span>🛵</span> <span>Domino's delivery rider will call this number upon doorstep arrival.</span>
      </div>
    `;
  }
}

function onQuickFlatInputChange(val) {
  const topFlat = document.getElementById('topBarFlatInput');
  if (topFlat) topFlat.value = val;
  const curAddr = getActiveSelectedAddress();
  if (curAddr) {
    curAddr.flat = val;
    displayCartAddress(curAddr);
  }
}

function renderReceiverHistoryPills() {
  const container = document.getElementById('receiverHistoryPills');
  if (!container) return;
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem('dominos_recent_receivers') || '[]');
  } catch (e) {}

  if (history.length === 0) {
    // Add default user receiver pill
    history.push({ name: currentUser.name || 'Parth', phone: (currentUser.phone || '7893618933').replace(/[^0-9]/g, '').slice(-10) });
  }

  container.innerHTML = history.slice(0, 3).map(rec => `
    <button type="button" onclick="selectReceiverPill('${rec.name}', '${rec.phone}')" style="background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 12px; padding: 2px 8px; font-size: 10px; color: #334155; cursor: pointer;">
      👤 ${rec.name} (${rec.phone.slice(-4)})
    </button>
  `).join('');
}

function selectReceiverPill(name, phone) {
  const rNameInput = document.getElementById('cartReceiverNameInput');
  const rPhoneInput = document.getElementById('cartReceiverPhoneInput');
  if (rNameInput) rNameInput.value = name;
  if (rPhoneInput) rPhoneInput.value = phone.replace(/[^0-9]/g, '').slice(-10);
  onReceiverDetailsChange();
}

async function cartDetectCurrentLocation() {
  const btn = document.getElementById('btnCartQuickGps');
  if (btn) btn.innerText = '⏳ Locating...';
  try {
    const coords = await acquireDeviceCoordinates();
    currentCoordinates = coords;
    currentActiveDeliveryId = 'CURRENT_GPS';
    const select = document.getElementById('cartAddressSelect');
    if (select) select.value = 'CURRENT_LOCATION';
    const topSelect = document.getElementById('topBarAddressSelect');
    if (topSelect) topSelect.value = 'CURRENT_GPS';
    syncCartAddressOptions();
    displayCartAddress(getActiveSelectedAddress());
    await applyResolvedLocation(coords.latitude, coords.longitude, LOCATION_PRIORITY.HARDWARE_GPS, 'Cart Quick GPS Button');
    showToastNotice('GPS Location Locked! Delivering kitchen updated.', '📍');
  } catch (err) {
    alert('Unable to detect device GPS: ' + err.message);
  } finally {
    if (btn) btn.innerText = '📍 My GPS';
  }
}

async function inlineDetectGpsAddress() {
  try {
    const coords = await acquireDeviceCoordinates();
    currentCoordinates = coords;
    const res = await fetch(`/api/location/store-availability?lat=${coords.latitude}&lng=${coords.longitude}`);
    const data = await res.json();
    if (data.geocodedAddress) {
      const g = data.geocodedAddress;
      const flatEl = document.getElementById('cartInlineFlat');
      const streetEl = document.getElementById('cartInlineStreet');
      const cityEl = document.getElementById('cartInlineCity');
      const pinEl = document.getElementById('cartInlinePincode');
      if (flatEl && !flatEl.value) flatEl.value = g.house_number || 'Flat 101';
      if (streetEl) streetEl.value = [g.road, g.neighbourhood || g.suburb].filter(Boolean).join(', ') || g.formatted;
      if (cityEl) cityEl.value = g.city || 'Chandigarh';
      if (pinEl) pinEl.value = g.postcode || '160015';
      showToastNotice('Address auto-filled from device GPS!', '⚡');
    }
  } catch (e) {
    alert('GPS auto-fill notice: ' + e.message);
  }
}

// Proceed to Dynamic UPI QR or COD
async function proceedToPaymentQR() {
  if (isMaintenanceActive) {
    alert(`⚠️ System Maintenance Active:\n\n${maintenanceInfo?.message || "Domino's Order Engine is currently under scheduled maintenance. Ordering is temporarily paused. We will be back shortly!"}`);
    return;
  }

  if (!isUserLoggedIn()) {
    openGoogleAuthModal();
    showToastNotice('Please sign in with Google to place your Domino\'s order.', '🔑');
    return;
  }

  if (cart.length === 0) {
    alert('Please add items or combos to your cart first.');
    return;
  }

  if (!isStoreServiceable) {
    alert(`Cannot place order: ${currentUnserviceableReason || 'Domino\'s does not deliver to this address.'}`);
    return;
  }

  const unavailableItems = cart.filter(item => item.isAvailable === false);
  if (unavailableItems.length > 0) {
    alert(`Cannot checkout: ${unavailableItems.map(i => i.name).join(', ')} is currently out of stock at your local Domino's kitchen.\n\nPlease click "Remove Out-of-Stock Items" before proceeding.`);
    return;
  }

  const selectedAddrId = document.getElementById('cartAddressSelect')?.value;
  const addresses = currentUser.savedAddresses || [];
  let selectedAddr = null;

  if (selectedAddrId === 'CURRENT_LOCATION' || (addresses.length === 0 && currentCoordinates)) {
    const quickFlat = (document.getElementById('cartQuickFlatInput')?.value || document.getElementById('topBarFlatInput')?.value || '').trim();
    if (!quickFlat) {
      alert('Please enter your House / Flat / Floor Number for Domino\'s rider doorstep delivery.');
      const flatInput = document.getElementById('cartQuickFlatInput') || document.getElementById('topBarFlatInput');
      if (flatInput) {
        flatInput.focus();
        flatInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    selectedAddr = {
      id: 'CURRENT_LOCATION',
      name: currentUser.name || 'Parth',
      phone: currentUser.phone || '+91 7893618933',
      flat: quickFlat,
      building: currentResolvedStore ? currentResolvedStore.storeName : 'Nearby Delivery Location',
      street: currentResolvedStore ? (currentResolvedStore.address || currentResolvedStore.locality || 'Verified GPS Area') : 'Verified GPS Area',
      landmark: 'GPS Verified Location',
      city: currentDetectedCity || (currentResolvedStore ? currentResolvedStore.city : 'India'),
      pincode: (currentResolvedStore && currentResolvedStore.pincode) || '110001',
      latitude: currentCoordinates.latitude,
      longitude: currentCoordinates.longitude
    };
  } else {
    selectedAddr = addresses.find(a => a.id === selectedAddrId) || addresses.find(a => a.isDefault) || addresses[0];
  }

  if (!selectedAddr) {
    alert('Please provide your location or confirm your delivery address.');
    openModal('locationRequiredModal');
    return;
  }

  const lat = selectedAddr.latitude || (currentCoordinates && currentCoordinates.latitude) || 28.5355;
  const lng = selectedAddr.longitude || (currentCoordinates && currentCoordinates.longitude) || 77.3910;

  // Receiver details (customizable per order)
  const receiverName = document.getElementById('cartReceiverNameInput')?.value?.trim() || selectedAddr.name || currentUser.name || 'Parth';
  const receiverRawPhone = document.getElementById('cartReceiverPhoneInput')?.value?.trim() || selectedAddr.phone || currentUser.phone || '+91 7893618933';
  const receiverPhone = receiverRawPhone.replace(/[^0-9]/g, '').slice(-10);

  // Strict Domino's Indian Mobile Validation (10 digits starting with 6, 7, 8, or 9)
  if (!receiverPhone || receiverPhone.length !== 10 || !/^[6-9]\d{9}$/.test(receiverPhone)) {
    alert('Please enter a valid 10-digit Indian mobile number for the receiver (starting with 6, 7, 8, or 9). Domino\'s rider requires this to coordinate delivery.');
    const phoneInput = document.getElementById('cartReceiverPhoneInput');
    if (phoneInput) {
      phoneInput.focus();
      phoneInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  // Save to recent receivers history
  try {
    let recHistory = JSON.parse(localStorage.getItem('dominos_recent_receivers') || '[]');
    recHistory = recHistory.filter(r => r.phone !== receiverPhone);
    recHistory.unshift({ name: receiverName, phone: receiverPhone });
    localStorage.setItem('dominos_recent_receivers', JSON.stringify(recHistory.slice(0, 5)));
  } catch (e) {}

  const resolvedStoreId = currentResolvedStore ? String(currentResolvedStore.storeId) : (selectedAddr.storeId || '63859');
  const resolvedStoreName = currentResolvedStore ? currentResolvedStore.storeName : (selectedAddr.storeName || "Domino's Pizza");

  let flatDisplay = selectedAddr.flat || document.getElementById('cartQuickFlatInput')?.value?.trim() || document.getElementById('topBarFlatInput')?.value?.trim() || '';
  if (!flatDisplay) {
    flatDisplay = 'Flat 101'; // Default fallback so user is never blocked
    const fi = document.getElementById('cartQuickFlatInput');
    if (fi) fi.value = flatDisplay;
  }
  selectedAddr.flat = flatDisplay;

  const payload = {
    paymentMethod: currentPaymentMethod,
    user: {
      name: receiverName,
      email: currentUser.email || 'parth.google@gmail.com',
      phone: `+91 ${receiverPhone}`
    },
    items: cart,
    appliedCoupon: appliedCartPromo,
    location: {
      latitude: lat,
      longitude: lng,
      store: currentResolvedStore
    },
    address: {
      name: receiverName,
      phone: `+91 ${receiverPhone}`,
      flat: selectedAddr.flat,
      building: selectedAddr.building || '',
      street: selectedAddr.street,
      landmark: selectedAddr.landmark || '',
      city: selectedAddr.city || currentDetectedCity || 'India',
      pincode: selectedAddr.pincode || '110001',
      latitude: lat,
      longitude: lng,
      storeId: resolvedStoreId,
      storeName: resolvedStoreName
    }
  };

  // Cache pending order payload for explicit modal confirmation
  pendingOrderPayload = payload;

  // Populate Interactive Order Confirmation Modal
  const confNameInput = document.getElementById('confirmModalReceiverName');
  if (confNameInput) confNameInput.value = receiverName;

  const confPhoneInput = document.getElementById('confirmModalReceiverPhone');
  if (confPhoneInput) confPhoneInput.value = receiverPhone;

  const confFlatInput = document.getElementById('confirmModalFlat');
  if (confFlatInput) confFlatInput.value = selectedAddr.flat;

  const confFullAddr = document.getElementById('confirmModalFullAddress');
  if (confFullAddr) {
    const fullStreetStr = [selectedAddr.street || selectedAddr.building, selectedAddr.city, selectedAddr.pincode].filter(Boolean).join(', ');
    confFullAddr.innerText = fullStreetStr || 'Verified Doorstep Delivery Address';
  }

  const confStoreName = document.getElementById('confirmModalStoreName');
  if (confStoreName) confStoreName.innerText = resolvedStoreName;

  const confStoreBadge = document.getElementById('confirmModalStoreIdBadge');
  if (confStoreBadge) confStoreBadge.innerText = `#${resolvedStoreId}`;

  const confLiveBadge = document.getElementById('confirmModalLiveStatusBadge');
  if (confLiveBadge) {
    if (isStoreServiceable) {
      confLiveBadge.style.display = 'inline-block';
      confLiveBadge.innerText = '🟢 Kitchen Online & Stock Verified';
      confLiveBadge.style.background = '#dcfce7';
      confLiveBadge.style.color = '#15803d';
      confLiveBadge.style.borderColor = '#86efac';
    } else {
      confLiveBadge.style.display = 'inline-block';
      confLiveBadge.innerText = '🔴 Store Offline / Unserviceable';
      confLiveBadge.style.background = '#fef2f2';
      confLiveBadge.style.color = '#dc2626';
      confLiveBadge.style.borderColor = '#fca5a5';
    }
  }

  const confEta = document.getElementById('confirmModalEta');
  if (confEta) confEta.innerText = currentResolvedStore?.polygonTime || '30 mins';

  const confItemCount = document.getElementById('confirmModalItemCount');
  if (confItemCount) {
    const totalUnits = cart.reduce((sum, itm) => sum + (itm.quantity || 1), 0);
    confItemCount.innerText = `${totalUnits} unit(s) (${cart.length} item types)`;
  }

  const confItemsList = document.getElementById('confirmModalItemsList');
  if (confItemsList) {
    confItemsList.innerHTML = cart.map(i => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px dashed #e2e8f0;">
        <div>
          <span style="font-weight: 700; color: var(--dark);">${i.name}</span>
          <span style="font-size: 11px; background: #f1f5f9; color: #475569; padding: 1px 6px; border-radius: 4px; font-weight: 800; margin-left: 4px;">Qty: ${i.quantity || 1}</span>
        </div>
        <strong style="color: #0066a3;">₹${(i.price || 0) * (i.quantity || 1)}</strong>
      </div>
    `).join('');
  }

  const confPayBadge = document.getElementById('confirmModalPaymentBadge');
  if (confPayBadge) {
    if (currentPaymentMethod === 'COD') {
      confPayBadge.innerHTML = '💵 Cash on Delivery (COD)';
      confPayBadge.style.background = '#ecfdf5';
      confPayBadge.style.color = '#065f46';
      confPayBadge.style.borderColor = '#a7f3d0';
    } else {
      confPayBadge.innerHTML = '📱 Instant UPI / QR';
      confPayBadge.style.background = '#eff6ff';
      confPayBadge.style.color = '#1e40af';
      confPayBadge.style.borderColor = '#bfdbfe';
    }
  }

  const confTotalEl = document.getElementById('confirmModalGrandTotal');
  if (confTotalEl) {
    const subtotal = cart.reduce((s, itm) => s + ((itm.price || 0) * (itm.quantity || 1)), 0);
    const taxes = Math.round(subtotal * 0.05);
    const delivery = 35;
    confTotalEl.innerText = document.getElementById('cartGrandTotal')?.innerText || `₹${subtotal + taxes + delivery}`;
  }

  // Open the Confirmation Modal
  openModal('orderConfirmationModal');
}

let pendingOrderPayload = null;

/**
 * Triggered when customer clicks [ ✓ Confirm & Place Domino's Order ] in confirmation modal
 */
async function executeFinalConfirmedOrder() {
  if (!pendingOrderPayload) {
    alert('No pending order details found. Please open cart and checkout.');
    return;
  }

  const rName = (document.getElementById('confirmModalReceiverName')?.value || '').trim();
  const rPhone = (document.getElementById('confirmModalReceiverPhone')?.value || '').replace(/[^0-9]/g, '').slice(-10);
  const flat = (document.getElementById('confirmModalFlat')?.value || '').trim();

  if (!flat) {
    alert('Please enter your House / Flat Number.');
    const flatInput = document.getElementById('confirmModalFlat');
    if (flatInput) { flatInput.focus(); flatInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return;
  }

  if (!rPhone || rPhone.length !== 10 || !/^[6-9]\d{9}$/.test(rPhone)) {
    alert('Please enter a valid 10-digit Indian mobile number for the rider delivery contact (starting with 6, 7, 8, or 9). Domino\'s rider will call this number.');
    const pInput = document.getElementById('confirmModalReceiverPhone');
    if (pInput) { pInput.focus(); pInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return;
  }

  // Commit verified receiver details into payload
  pendingOrderPayload.user.name = rName || pendingOrderPayload.user.name;
  pendingOrderPayload.user.phone = `+91 ${rPhone}`;
  pendingOrderPayload.address.name = rName || pendingOrderPayload.address.name;
  pendingOrderPayload.address.phone = `+91 ${rPhone}`;
  pendingOrderPayload.address.flat = flat;

  const btn = document.getElementById('btnExecuteConfirmedOrder');
  const originalText = btn ? btn.innerHTML : '✓ Confirm & Place Domino\'s Order';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Dispatching Order to Domino\'s India...</span>';
  }
  requestBrowserNotificationPermission();

  try {
    const res = await fetch('/api/orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingOrderPayload)
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        alert(data.message || 'Order creation rate limited. Please wait a few moments.');
        return;
      }
      if (data.outOfStockItem) {
        cart.forEach(i => {
          if (i.name.toLowerCase().includes(data.outOfStockItem.toLowerCase()) || data.outOfStockItem.toLowerCase().includes(i.name.toLowerCase())) {
            i.isAvailable = false;
            i.unavailableReason = data.error;
          }
        });
        closeModal('orderConfirmationModal');
        openCartModal();
        renderCartDrawer(false);
        alert('🚫 Domino\'s Kitchen Inventory Notice:\n\n' + data.error);
        return;
      }
      alert('🚫 Domino\'s Store Verification Notice:\n\n' + (data.error || 'Failed to verify cart at Domino\'s site.'));
      return;
    }

    currentOrder = data.order;
    if (data.priceDifference && data.priceDifference !== 0) {
      showToastNotice(data.priceNotice || `Price updated by Domino's store billing: ₹${data.dominosVerifiedTotal}`, 'ℹ️');
    }

    closeModal('orderConfirmationModal');
    closeModal('cartModal');

    if (currentPaymentMethod === 'COD') {
      cart = [];
      updateCartBadge();
      renderCartDrawer(false);
      showToastNotice('Cash on Delivery Order Placed! Dispatched to Domino\'s kitchen...', '🍕');
      openTrackingModal(currentOrder.id);
    } else {
      openPaymentModal(currentOrder, data);
    }
  } catch (err) {
    alert('Failed to initiate order: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }
}

const handleCartOrderSubmit = proceedToPaymentQR;

// =========================================================================
// 5. DYNAMIC UPI PAYMENT & VERIFICATION
// =========================================================================

function openPaymentModal(order, meta = {}) {
  document.getElementById('qrPayAmount').innerText = `₹${order.payment.amount}`;
  document.getElementById('qrOrderRef').innerText = order.id;

  // Populate Domino's Verified Kitchen Bill Breakdown
  const storeNameEl = document.getElementById('billStoreName');
  if (storeNameEl) storeNameEl.innerText = order.robot?.storeName || currentResolvedStore?.storeName || "Domino's Kitchen";

  const subtotalEl = document.getElementById('billItemsSubtotal');
  if (subtotalEl) subtotalEl.innerText = `₹${order.payment.subtotal}`;

  const gstEl = document.getElementById('billGst');
  if (gstEl) gstEl.innerText = `₹${order.payment.gst !== undefined ? order.payment.gst : Math.round(order.payment.subtotal * 0.05)}`;

  const deliveryEl = document.getElementById('billDeliveryFee');
  if (deliveryEl) deliveryEl.innerText = `₹${order.payment.deliveryFee !== undefined ? order.payment.deliveryFee : 35}`;

  const packagingEl = document.getElementById('billPackagingFee');
  if (packagingEl) packagingEl.innerText = order.payment.packagingFee && order.payment.packagingFee > 0 ? `₹${order.payment.packagingFee}` : 'FREE';

  const grandTotalEl = document.getElementById('billGrandTotal');
  if (grandTotalEl) grandTotalEl.innerText = `₹${order.payment.amount}`;

  // Price adjustment alert if pricing changed on Domino's site
  const noticeEl = document.getElementById('paymentPriceAdjustmentNotice');
  if (noticeEl) {
    const noticeText = order.payment.priceNotice || meta.priceNotice;
    if (noticeText) {
      noticeEl.style.display = 'block';
      noticeEl.innerHTML = `<strong>⚠️ Domino's Live Store Price Notice:</strong> ${noticeText}`;
    } else {
      noticeEl.style.display = 'none';
    }
  }

  // Render Dynamic UPI QR Code SVG
  const qrContainer = document.getElementById('qrCanvasContainer');
  if (qrContainer && order.payment && order.payment.upiString) {
    if (window.generateQRCodeSVG) {
      qrContainer.innerHTML = window.generateQRCodeSVG(order.payment.upiString, 220);
    } else {
      qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(order.payment.upiString)}&margin=0" alt="UPI QR" style="width:220px; height:220px; border-radius:8px; border:1px solid #cbd5e1;">`;
    }
  }

  const orderDeepLink = document.getElementById('orderUpiDeepLink');
  if (orderDeepLink && order.payment?.upiString) {
    orderDeepLink.href = order.payment.upiString;
    orderDeepLink.style.display = 'flex';
  }

  // Start 10-Minute Timer
  startPaymentCountdown(10 * 60);

  openModal('paymentModal');
}

async function downloadOrderPaymentQr() {
  if (!currentOrder || !currentOrder.payment || !currentOrder.payment.upiString) {
    showToastNotice('No active order payment QR available', '⚠️');
    return;
  }
  const amt = currentOrder.pricing?.dominosVerifiedTotal || currentOrder.pricing?.grandTotal || currentOrder.payment.amount || 0;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(currentOrder.payment.upiString)}&margin=10`;
  try {
    const res = await fetch(qrUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `dominos-order-${currentOrder.id || 'pay'}-qr.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    showToastNotice(`Order QR saved (₹${amt})! Open in PhonePe / GPay scanner.`, '📥');
  } catch (err) {
    const a = document.createElement('a');
    a.href = qrUrl;
    a.target = '_blank';
    a.download = `dominos-order-pay-qr-₹${amt}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToastNotice('Order QR opened for download.', '📥');
  }
}
window.downloadOrderPaymentQr = downloadOrderPaymentQr;

function startPaymentCountdown(durationSeconds) {
  clearInterval(countdownTimer);
  let remaining = durationSeconds;
  const label = document.getElementById('paymentTimer');

  countdownTimer = setInterval(() => {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    label.innerText = `⏱️ QR Expires in: ${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    remaining--;

    if (remaining < 0) {
      clearInterval(countdownTimer);
      label.innerText = '❌ Payment Session Expired. Please retry.';
    }
  }, 1000);
}

async function confirmPaymentAndRelease() {
  if (!currentOrder) return;
  const txnInput = document.getElementById('upiTxnInput');
  const txnId = txnInput ? txnInput.value.trim() : '';

  try {
    const res = await fetch('/api/orders/verify-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: currentOrder.id,
        transactionId: txnId || currentOrder.id
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    clearInterval(countdownTimer);
    closeModal('paymentModal');
    cart = [];
    updateCartBadge();

    // Open Live Order Tracker
    openTrackingModal(currentOrder.id);
  } catch (err) {
    alert('Payment verification failed: ' + err.message);
  }
}

// =========================================================================
// 6. REAL-TIME ROBOT MONITOR & LIVE TRACKER
// =========================================================================

let currentTrackingOrderId = null;
let isLiveGpsMapOpen = false;

function openTrackingModal(orderId) {
  requestBrowserNotificationPermission();
  closeModal('myOrdersModal');
  closeModal('cartModal');
  closeModal('paymentModal');
  currentTrackingOrderId = orderId;
  const idEl = document.getElementById('trackerOrderId');
  if (idEl) idEl.innerText = orderId;

  // Keep GPS real map collapsed by default so animated road track is prominent
  isLiveGpsMapOpen = false;
  const mapCard = document.getElementById('trackerLiveMapCard');
  if (mapCard) mapCard.style.display = 'none';
  const toggleMapText = document.getElementById('toggleMapText');
  if (toggleMapText) toggleMapText.innerHTML = 'Live Rider Delivery &amp; Real-Time GPS &darr;';
  const toggleMapBtn = document.getElementById('btnToggleGpsMap');
  if (toggleMapBtn) toggleMapBtn.style.background = '#eff6ff';

  openModal('trackingModal');
  startLivePolling(orderId);
}
window.openOrderTracker = openTrackingModal;

async function refreshLiveOrderStatus() {
  if (!currentTrackingOrderId) return;
  const icon = document.getElementById('refreshTrackingIcon');
  if (icon) icon.classList.add('spin-active');
  try {
    await fetchOrderStatus(currentTrackingOrderId, true);
    showToastNotice('Tracking status updated live from kitchen!', '🔄');
  } finally {
    setTimeout(() => {
      if (icon) icon.classList.remove('spin-active');
    }, 600);
  }
}

let pollTimeout = null;

function startLivePolling(orderId) {
  if (pollInterval) clearInterval(pollInterval);
  if (pollTimeout) clearTimeout(pollTimeout);
  fetchOrderStatus(orderId);
}

async function fetchOrderStatus(orderId, isRefresh = false) {
  if (pollTimeout) clearTimeout(pollTimeout);
  try {
    // Always append ?refresh=true for live tracking so Domino's India Cloud telemetry updates in real time
    const res = await fetch(`/api/orders/${orderId}?refresh=true`);
    if (!res.ok) return;
    const order = await res.json();
    currentOrder = order; // Persist latest order state including proofScreenshotUrl & rider telemetry!
    updateTrackingUI(order);

    const st = order.robot?.status || order.status;
    const isTerminal = st === 'DELIVERED' || st === 'CANCELLED' || st === 'ERROR' || st === 'STORE_OFFLINE' || order.robot?.trackingClosed;
    if (isTerminal) {
      if (pollTimeout) clearTimeout(pollTimeout);
      if (pollInterval) clearInterval(pollInterval);
      return;
    }

    // High-responsiveness cadence:
    // Out for delivery (DISPATCHED): 8s rapid polling for instantaneous rider movement and real-time arrival
    // Live in-store (ORDER_PLACED, BAKING, PACKED): 12s cadence
    const nextIntervalMs = (st === 'DISPATCHED') ? 8000 : 12000;
    pollTimeout = setTimeout(() => {
      fetchOrderStatus(orderId, false);
    }, nextIntervalMs);
  } catch (e) {
    console.error('Polling error:', e);
  }
}

function copyDominosToken() {
  const token = document.getElementById('trackerKitchenTokenBadge')?.innerText?.trim();
  if (!token || token === 'Generating...' || token === 'Pending Generation') {
    showToastNotice("Domino's kitchen token is being generated. Please wait a moment...", '⏳');
    return;
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(token).then(() => {
      showToastNotice(`Copied Domino's Token ${token} to clipboard!`, '📋');
    }).catch(() => {
      showToastNotice(`Domino's Kitchen Token: ${token}`, '📋');
    });
  } else {
    showToastNotice(`Domino's Kitchen Token: ${token}`, '📋');
  }
}

function formatRiderContact(phone) {
  if (!phone) return 'Connecting with driver...';
  const clean = String(phone).replace(/[^0-9]/g, '');
  const clean10 = clean.slice(-10);
  if (clean.startsWith('011') || clean.startsWith('0120') || !/^[6-9]\d{9}$/.test(clean10)) {
    return 'Available via store dispatch';
  }
  return `+91 ${clean10.slice(0, 5)} ${clean10.slice(5)}`;
}

function getRiderTelUri(phone) {
  if (!phone) return '#';
  const clean = String(phone).replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) return `tel:${clean}`;
  if (clean.length === 10) return `tel:+91${clean}`;
  return `tel:${clean}`;
}

let persistentRiderPhoneCache = null;
let persistentRiderNameCache = null;

const orderSplashNotified = {
  dispatched: new Set(),
  delivered: new Set(),
  cancelled: new Set()
};

function requestBrowserNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch (e) {}
}

function triggerBrowserNotification(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, {
        body: body,
        icon: '/favicon.ico'
      });
    }
  } catch (e) {}
}

function updateTrackingUI(order) {
  const r = order.robot || {};
  const status = r.status || 'ORDER_PLACED';
  const p = order.payment || {};

  // Preserve rider details across rapid polling so rider number never flickers or disappears
  if (r.rider?.phone) {
    persistentRiderPhoneCache = r.rider.phone;
    persistentRiderNameCache = r.rider.name;
  } else if (persistentRiderPhoneCache && status === 'DISPATCHED') {
    if (!r.rider) r.rider = {};
    r.rider.phone = persistentRiderPhoneCache;
    r.rider.name = persistentRiderNameCache || r.rider.name;
  }

  // 1. Populate Domino's Official Kitchen Store Token & Reference
  const tokenBadge = document.getElementById('trackerKitchenTokenBadge');
  const rawRef = r.dominosOrderRef || order.dominosOrderRef;
  const isAuthenticDominosToken = rawRef && !String(rawRef).startsWith('DOM-IND-') && !String(rawRef).startsWith('DOM-ENG-');
  let formattedToken = '⏳ Placing Order on Domino\'s...';
  if (isAuthenticDominosToken) {
    formattedToken = String(rawRef).startsWith('#') ? rawRef : `#${rawRef}`;
  } else if (status === 'CANCELLED') {
    formattedToken = 'Order Cancelled';
  } else if (status === 'STORE_OFFLINE') {
    formattedToken = 'Store Offline';
  } else if (status === 'ORDER_PLACED' || status === 'BUILDING_CART' || status === 'STORE_RESOLVING' || status === 'QUEUED_FOR_ROBOT') {
    formattedToken = '🤖 Robot placing order on Domino\'s...';
  }
  if (tokenBadge) {
    tokenBadge.innerText = formattedToken;
    tokenBadge.style.fontSize = isAuthenticDominosToken ? '22px' : '15px';
  }

  const domRefHeader = document.getElementById('trackerDominosRefHeader');
  if (domRefHeader) {
    domRefHeader.innerText = isAuthenticDominosToken ? formattedToken : 'Awaiting Confirmation';
  }

  const posEl = document.getElementById('trackerPosOrderId');
  if (posEl) posEl.style.display = 'none';

  const liveStateLabel = document.getElementById('trackerLiveStateLabel');
  if (liveStateLabel) liveStateLabel.innerText = r.dominosLiveStatus || status;

  // 2. Populate Delivering Kitchen Card & Telephone
  const storeNameEl = document.getElementById('trackerStoreName');
  const resolvedStoreName = r.storeName || order.address?.storeName || order.location?.store?.storeName || "Domino's Store Kitchen";
  const storeTitle = `${resolvedStoreName}${r.storeId ? ' (#' + r.storeId + ')' : ''}`;
  if (storeNameEl) storeNameEl.innerText = storeTitle;

  const storePhone = r.storePhone || order.address?.storePhone || '1800 208 1234';
  const phoneText = document.getElementById('trackerStorePhoneText');
  const phoneLink = document.getElementById('trackerStorePhoneLink');
  if (phoneText) phoneText.innerText = storePhone;
  if (phoneLink) phoneLink.href = `tel:${storePhone}`;

  const domRefEl = document.getElementById('trackerDominosRef');
  if (domRefEl) domRefEl.innerText = formattedToken;

  const addrTextEl = document.getElementById('trackerAddressText');
  if (addrTextEl) {
    const full = [order.address?.flat, order.address?.building, order.address?.street, order.address?.city].filter(Boolean).join(', ');
    addrTextEl.innerText = full || 'GPS Verified Area';
  }

  const receiverTextEl = document.getElementById('trackerReceiverText');
  if (receiverTextEl) {
    const rName = order.address?.name || order.user?.name || 'Customer';
    const rPhone = order.address?.phone || order.user?.phone || '';
    receiverTextEl.innerText = `${rName} (📞 ${rPhone})`;
  }

  const billTotalEl = document.getElementById('trackerBillTotal');
  if (billTotalEl) billTotalEl.innerText = `₹${p.amount || r.billAmount || 0}`;

  const payMethodEl = document.getElementById('trackerPayMethod');
  if (payMethodEl) payMethodEl.innerText = p.method === 'COD' ? '💵 Cash to Rider' : '📱 Instant UPI';

  // Handle Delay Banner (~8-9 mins delay)
  const delayBanner = document.getElementById('trackerDelayBanner');
  const delayMinutesEl = document.getElementById('trackerDelayMinutes');
  const delayReasonEl = document.getElementById('trackerDelayReason');
  if (delayBanner) {
    if (r.isDelayed && status !== 'DELIVERED' && status !== 'CANCELLED') {
      delayBanner.style.display = 'block';
      if (delayMinutesEl) delayMinutesEl.innerText = r.delayMinutes || '8';
      if (delayReasonEl && r.delayReason) delayReasonEl.innerText = r.delayReason;
    } else {
      delayBanner.style.display = 'none';
    }
  }

  // Live ETA Countdown & Stage Badge computation
  const liveEtaCountdownEl = document.getElementById('trackerLiveEtaCountdown');
  const liveStageBadgeEl = document.getElementById('trackerLiveStageBadge');
  if (liveEtaCountdownEl && liveStageBadgeEl) {
    if (status === 'DELIVERED') {
      liveEtaCountdownEl.innerText = '0 mins (Delivered)';
      liveEtaCountdownEl.style.color = '#15803d';
      liveStageBadgeEl.innerText = '🟢 DELIVERED AT DOORSTEP';
      liveStageBadgeEl.style.background = '#dcfce7';
      liveStageBadgeEl.style.color = '#15803d';
    } else if (status === 'CANCELLED') {
      liveEtaCountdownEl.innerText = 'Cancelled by Kitchen';
      liveEtaCountdownEl.style.color = '#dc2626';
      liveStageBadgeEl.innerText = '❌ ORDER CANCELLED';
      liveStageBadgeEl.style.background = '#fef2f2';
      liveStageBadgeEl.style.color = '#dc2626';
    } else if (r.isDelayed && (status === 'BAKING' || status === 'PACKED' || !['DISPATCHED', 'DELIVERED'].includes(status))) {
      liveEtaCountdownEl.innerText = `~${(r.delayMinutes || 8) + 10} mins (Kitchen Rush Delay)`;
      liveEtaCountdownEl.style.color = '#b45309';
      liveStageBadgeEl.innerText = `⏳ IN OVEN (~${r.delayMinutes || 8}m DELAY)`;
      liveStageBadgeEl.style.background = '#fffbeb';
      liveStageBadgeEl.style.color = '#b45309';
    } else if (status === 'DISPATCHED') {
      liveEtaCountdownEl.innerText = '~10-12 mins (Rider En Route)';
      liveEtaCountdownEl.style.color = '#0284c7';
      liveStageBadgeEl.innerText = '🛵 ON THE WAY (LIVE)';
      liveStageBadgeEl.style.background = '#eff6ff';
      liveStageBadgeEl.style.color = '#0284c7';
    } else if (status === 'PACKED') {
      liveEtaCountdownEl.innerText = '~15-18 mins (Hot Packed)';
      liveEtaCountdownEl.style.color = '#d97706';
      liveStageBadgeEl.innerText = '📦 PACKED & READY';
      liveStageBadgeEl.style.background = '#fef3c7';
      liveStageBadgeEl.style.color = '#b45309';
    } else {
      liveEtaCountdownEl.innerText = '~20 mins (Domino\'s Oven)';
      liveEtaCountdownEl.style.color = '#d97706';
      liveStageBadgeEl.innerText = '🔥 IN OVEN BAKING';
      liveStageBadgeEl.style.background = '#fef3c7';
      liveStageBadgeEl.style.color = '#b45309';
    }
  }

  // Domino's Official Big ETA Header & Animated Delivery Road Track
  const bigEtaEl = document.getElementById('trackerBigEtaText');
  const bigStagePillEl = document.getElementById('trackerBigStagePill');
  const progressFillEl = document.getElementById('trackerAnimProgressFill');
  const scooterEl = document.getElementById('trackerAnimPlayerScooter');
  const animSubtitleEl = document.getElementById('trackerAnimStageSubtitle');

  const mConfirmed = document.getElementById('markerConfirmed');
  const mOven = document.getElementById('markerOven');
  const mRoad = document.getElementById('markerRoad');
  const mDoor = document.getElementById('markerDoor');

  const setMarkerState = (el, active, activeBg = '#10b981') => {
    if (!el) return;
    if (active) {
      el.style.background = activeBg;
      el.style.color = 'white';
      el.style.boxShadow = `0 2px 6px ${activeBg}66`;
    } else {
      el.style.background = '#e2e8f0';
      el.style.color = '#475569';
      el.style.boxShadow = 'none';
    }
  };

  if (status === 'DELIVERED') {
    if (bigEtaEl) bigEtaEl.innerText = 'Delivered at Doorstep';
    if (bigStagePillEl) {
      bigStagePillEl.innerText = '🟢 DELIVERED';
      bigStagePillEl.style.background = 'rgba(16, 185, 129, 0.4)';
    }
    if (progressFillEl) progressFillEl.style.width = '100%';
    if (scooterEl) {
      scooterEl.style.display = 'block';
      scooterEl.style.left = '94%';
    }
    if (animSubtitleEl) animSubtitleEl.innerText = 'Order delivered successfully to your doorstep! Enjoy hot fresh pizza.';
    setMarkerState(mConfirmed, true, '#10b981');
    setMarkerState(mOven, true, '#10b981');
    setMarkerState(mRoad, true, '#10b981');
    setMarkerState(mDoor, true, '#10b981');
  } else if (status === 'DISPATCHED') {
    const riderEtaStr = r.rider?.eta || '~10-12 Mins';
    if (bigEtaEl) bigEtaEl.innerText = `${riderEtaStr} • On the way`;
    if (bigStagePillEl) {
      bigStagePillEl.innerText = '🛵 OUT FOR DELIVERY';
      bigStagePillEl.style.background = 'rgba(2, 132, 199, 0.4)';
    }
    if (progressFillEl) progressFillEl.style.width = '70%';
    if (scooterEl) {
      scooterEl.style.display = 'block';
      scooterEl.style.left = '70%';
    }
    if (animSubtitleEl) animSubtitleEl.innerText = r.rider?.name ? `Rider ${r.rider.name} en route with your pizza box` : 'Rider is on the way to your doorstep';
    setMarkerState(mConfirmed, true, '#10b981');
    setMarkerState(mOven, true, '#10b981');
    setMarkerState(mRoad, true, '#0284c7');
    setMarkerState(mDoor, false);
  } else if (status === 'PACKED') {
    if (bigEtaEl) bigEtaEl.innerText = '~15-18 Mins • Ready for Delivery';
    if (bigStagePillEl) {
      bigStagePillEl.innerText = '📦 PACKED & READY';
      bigStagePillEl.style.background = 'rgba(217, 119, 6, 0.4)';
    }
    if (progressFillEl) progressFillEl.style.width = '52%';
    if (scooterEl) {
      scooterEl.style.display = 'block';
      scooterEl.style.left = '52%';
    }
    if (animSubtitleEl) animSubtitleEl.innerText = 'Boxed & packed in thermal bag. Rider departing kitchen shortly.';
    setMarkerState(mConfirmed, true, '#10b981');
    setMarkerState(mOven, true, '#f59e0b');
    setMarkerState(mRoad, false);
    setMarkerState(mDoor, false);
  } else if (status === 'CANCELLED') {
    if (bigEtaEl) bigEtaEl.innerText = 'Order Cancelled by Kitchen';
    if (bigStagePillEl) {
      bigStagePillEl.innerText = '❌ CANCELLED';
      bigStagePillEl.style.background = 'rgba(220, 38, 38, 0.5)';
    }
    if (progressFillEl) progressFillEl.style.width = '0%';
    if (scooterEl) scooterEl.style.display = 'none';
    if (animSubtitleEl) animSubtitleEl.innerText = 'Order was cancelled by the Domino\'s kitchen.';
    setMarkerState(mConfirmed, false);
    setMarkerState(mOven, false);
    setMarkerState(mRoad, false);
    setMarkerState(mDoor, false);
  } else if (status === 'STORE_OFFLINE') {
    if (bigEtaEl) bigEtaEl.innerText = 'Store Currently Offline';
    if (bigStagePillEl) {
      bigStagePillEl.innerText = '🏪 STORE OFFLINE';
      bigStagePillEl.style.background = 'rgba(217, 119, 6, 0.5)';
    }
    if (progressFillEl) progressFillEl.style.width = '0%';
    if (scooterEl) scooterEl.style.display = 'none';
    if (animSubtitleEl) animSubtitleEl.innerText = 'Domino\'s store kitchen delivery opens at 11:00 AM IST.';
    setMarkerState(mConfirmed, false);
    setMarkerState(mOven, false);
    setMarkerState(mRoad, false);
    setMarkerState(mDoor, false);
  } else if (status === 'BAKING') {
    const ovenEta = r.isDelayed ? `~${(r.delayMinutes || 8) + 15} Mins (High Kitchen Demand)` : '~20 Mins • In Oven';
    if (bigEtaEl) bigEtaEl.innerText = ovenEta;
    if (bigStagePillEl) {
      bigStagePillEl.innerText = r.isDelayed ? `⏳ BAKING (~${r.delayMinutes || 8}m DELAY)` : '🔥 BAKING IN OVEN';
      bigStagePillEl.style.background = 'rgba(245, 158, 11, 0.4)';
    }
    if (progressFillEl) progressFillEl.style.width = '36%';
    if (scooterEl) {
      scooterEl.style.display = 'block';
      scooterEl.style.left = '36%';
    }
    if (animSubtitleEl) animSubtitleEl.innerText = 'Pizza freshly hand-tossed and baking inside 465°F oven';
    setMarkerState(mConfirmed, true, '#10b981');
    setMarkerState(mOven, true, '#f59e0b');
    setMarkerState(mRoad, false);
    setMarkerState(mDoor, false);
  } else {
    // ORDER_PLACED or robot preparing
    if (bigEtaEl) bigEtaEl.innerText = '~25 Mins • Confirmed';
    if (bigStagePillEl) {
      bigStagePillEl.innerText = '✓ ORDER CONFIRMED';
      bigStagePillEl.style.background = 'rgba(16, 185, 129, 0.4)';
    }
    if (progressFillEl) progressFillEl.style.width = '8%';
    if (scooterEl) {
      scooterEl.style.display = 'block';
      scooterEl.style.left = '6%';
    }
    if (animSubtitleEl) animSubtitleEl.innerText = 'Domino\'s store kitchen received and accepted your order';
    setMarkerState(mConfirmed, true, '#10b981');
    setMarkerState(mOven, false);
    setMarkerState(mRoad, false);
    setMarkerState(mDoor, false);
  }

  const payStatusBadge = document.getElementById('trackerPaymentStatusBadge');
  if (payStatusBadge) {
    if (status === 'CANCELLED') {
      payStatusBadge.innerHTML = '<span style="color: #dc2626; font-weight: 800;">❌ Order Cancelled</span>';
    } else if (p.method === 'COD') {
      payStatusBadge.innerHTML = '<span style="color: #15803d; font-weight: 700;">✓ Cash on Delivery (Pay upon arrival)</span>';
    } else if (p.status === 'SUCCESS' || p.status === 'CONFIRMED') {
      payStatusBadge.innerHTML = '<span style="color: #15803d; font-weight: 700;">✓ Instant UPI Paid</span>';
    } else {
      payStatusBadge.innerHTML = `
        <span style="color: #b91c1c; font-weight: 700; margin-right: 6px;">⏳ Awaiting Payment</span>
        <button onclick="openPaymentModal(currentOrder)" style="background: #0066a3; color: white; border: none; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; cursor: pointer;">📱 Pay Now</button>
      `;
    }
  }

  // 3. Handle Order Cancellation Alert Banner (currentPosState 99 / CANCELLED)
  const cancelledBanner = document.getElementById('trackerCancelledBanner');
  const cancelledStampGraphic = document.getElementById('trackerCancelledStampGraphic');
  const cancelledReason = document.getElementById('trackerCancelledReason');
  const cancelledPhone = document.getElementById('trackerStorePhoneCancelled');
  const btnCallStoreCancelled = document.getElementById('btnCallStoreCancelled');

  if (status === 'CANCELLED') {
    if (cancelledBanner) cancelledBanner.style.display = 'block';
    if (cancelledStampGraphic) cancelledStampGraphic.style.display = 'block';
    if (cancelledReason) cancelledReason.innerText = r.error || `The store kitchen (${resolvedStoreName}) has cancelled this order. Please call the store kitchen manager directly.`;
    if (cancelledPhone) cancelledPhone.innerText = storePhone;
    if (btnCallStoreCancelled) btnCallStoreCancelled.href = `tel:${storePhone}`;
  } else {
    if (cancelledBanner) cancelledBanner.style.display = 'none';
    if (cancelledStampGraphic) cancelledStampGraphic.style.display = 'none';
  }

  // 4. Handle Rejection / Error / Offline Alert Banner
  const errBanner = document.getElementById('trackerErrorBanner');
  const errText = document.getElementById('trackerErrorMsg');
  if (status === 'STORE_OFFLINE') {
    if (errBanner) {
      errBanner.style.display = 'block';
      errBanner.style.background = '#fffbeb';
      errBanner.style.borderColor = '#f59e0b';
    }
    if (errText) {
      errText.style.color = '#92400e';
      errText.innerText = r.error || 'Domino\'s store kitchen delivery opens at 11:00 AM IST. Your order and cart are preserved.';
    }
  } else if (status === 'ERROR') {
    if (errBanner) {
      errBanner.style.display = 'block';
      errBanner.style.background = '#fef2f2';
      errBanner.style.borderColor = '#f87171';
    }
    if (errText) {
      errText.style.color = '#991b1b';
      errText.innerText = r.error || 'Domino\'s order could not be completed on live site. Kitchen may be offline or unserviceable.';
    }
  } else {
    if (errBanner) errBanner.style.display = 'none';
  }

  const setStep = (id, state) => {
    const el = document.getElementById(id);
    if (!el) return;
    const icon = el.querySelector('.step-icon');
    if (state === 'done') {
      icon.className = 'step-icon done';
      icon.innerHTML = '✓';
    } else if (state === 'active') {
      icon.className = 'step-icon active';
    } else if (state === 'error') {
      icon.className = 'step-icon error';
      icon.innerHTML = '⚠️';
    } else {
      icon.className = 'step-icon';
    }
  };

  // 5. Pipeline Stages
  const isErr = status === 'ERROR' || status === 'CANCELLED';
  setStep('step-pay', (p.method === 'COD' || p.status === 'SUCCESS') ? 'done' : (isErr ? 'error' : 'active'));
  setStep('step-session', ['SESSION_ASSIGNING', 'QUEUED_FOR_ROBOT'].includes(status) ? 'active' : ((status && status !== 'AWAITING_PAYMENT' && !isErr) ? 'done' : (isErr ? 'done' : '')));
  setStep('step-cart', ['STORE_RESOLVING', 'BUILDING_CART', 'APPLYING_COUPON', 'STORE_CONFIRMATION'].includes(status) ? 'active' : (['ORDER_PLACED', 'BAKING', 'PACKED', 'DISPATCHED', 'DELIVERED'].includes(status) ? 'done' : (isErr ? 'error' : '')));
  setStep('step-voucher', status === 'ORDER_PLACED' ? 'active' : (['BAKING', 'PACKED', 'DISPATCHED', 'DELIVERED'].includes(status) ? 'done' : ''));
  setStep('step-dominos', ['BAKING', 'PACKED'].includes(status) ? 'active' : (['DISPATCHED', 'DELIVERED'].includes(status) ? 'done' : ''));
  setStep('step-dispatch', status === 'DISPATCHED' ? 'active' : (status === 'DELIVERED' ? 'done' : ''));

  // 6. Proof Screenshot Card
  const proofCard = document.getElementById('proofPhotoCard');
  if (r.proofScreenshotUrl && proofCard) {
    proofCard.style.display = 'block';
  }

  // 7. Rider Telemetry Card (Authentic - zero dummy data)
  const riderCard = document.getElementById('riderCard');
  const rNameEl = document.getElementById('riderName');
  const rPhoneEl = document.getElementById('riderPhone');
  const rStatusBadge = document.getElementById('riderStatusBadge');
  const rEtaEl = document.getElementById('riderEta');
  const callBtn = document.getElementById('callRiderBtn');

  if (riderCard) {
    if (r.rider && (r.rider.name || r.rider.phone) && !r.rider.name?.includes('Ramesh Kumar')) {
      riderCard.style.display = 'flex';
      if (rNameEl) rNameEl.innerText = r.rider.name || "Domino's Delivery Executive";
      if (rPhoneEl) rPhoneEl.innerText = r.rider.phone ? `Contact: ${formatRiderContact(r.rider.phone)}` : 'Available via store dispatch';
      if (rStatusBadge) {
        rStatusBadge.innerText = status === 'DISPATCHED' ? '🛵 ON THE WAY' : (status === 'DELIVERED' ? '🟢 DELIVERED' : '👨‍🍳 IN KITCHEN');
        rStatusBadge.style.background = status === 'DISPATCHED' ? '#dcfce7' : '#eff6ff';
        rStatusBadge.style.color = status === 'DISPATCHED' ? '#15803d' : '#0284c7';
      }
      if (rEtaEl) rEtaEl.innerText = `Estimated Arrival: ${r.rider.eta || '15 mins'}`;
      if (callBtn) {
        if (r.rider.phone) {
          callBtn.style.display = 'inline-block';
          callBtn.href = getRiderTelUri(r.rider.phone);
        } else {
          callBtn.style.display = 'none';
        }
      }
    } else if (status === 'BAKING' || status === 'ORDER_PLACED' || status === 'QUEUED_FOR_ROBOT') {
      riderCard.style.display = 'flex';
      if (rNameEl) rNameEl.innerText = `Domino's Delivery Executive: Handcrafting & Baking in oven (${r.storeName || 'Domino\'s Kitchen'})`;
      if (rPhoneEl) rPhoneEl.innerText = "Rider mobile number will appear live as soon as the order is packed and dispatched";
      if (rStatusBadge) {
        rStatusBadge.innerText = "🔥 OVEN BAKING";
        rStatusBadge.style.background = '#fef3c7';
        rStatusBadge.style.color = '#d97706';
      }
      if (rEtaEl) rEtaEl.innerText = `Baking fresh in Domino's oven (Est. 20 mins)`;
      if (callBtn) callBtn.style.display = 'none';
    } else if (status === 'PACKED') {
      riderCard.style.display = 'flex';
      if (rNameEl) rNameEl.innerText = "Domino's Quality Check: Boxed & Packed";
      if (rPhoneEl) rPhoneEl.innerText = "Delivery executive is picking up thermal bag from kitchen counter";
      if (rStatusBadge) {
        rStatusBadge.innerText = "📦 PACKED & READY";
        rStatusBadge.style.background = '#e0f2fe';
        rStatusBadge.style.color = '#0284c7';
      }
      if (rEtaEl) rEtaEl.innerText = "Departing store shortly";
      if (callBtn) callBtn.style.display = 'none';
    } else if (status === 'DELIVERED') {
      riderCard.style.display = 'flex';
      if (rNameEl) rNameEl.innerText = "Domino's Order Delivered";
      if (rPhoneEl) rPhoneEl.innerText = "Order successfully handed over at doorstep";
      if (rStatusBadge) {
        rStatusBadge.innerText = "🟢 DELIVERED";
        rStatusBadge.style.background = '#dcfce7';
        rStatusBadge.style.color = '#15803d';
      }
      if (callBtn) callBtn.style.display = 'none';
    } else {
      riderCard.style.display = 'none';
    }
  }

  // 7B. Enlarged High-Visibility Rider Notification Banner (Prominently displays rider phone and direct call button)
  const enlargedBanner = document.getElementById('trackerEnlargedRiderNotification');
  const enName = document.getElementById('enlargedRiderName');
  const enBtn = document.getElementById('enlargedCallRiderBtn');
  const enPhone = document.getElementById('enlargedRiderPhone');

  if (enlargedBanner) {
    if (status === 'DISPATCHED') {
      enlargedBanner.style.display = 'block';
      if (enName) enName.innerText = r.rider?.name || "Domino's Delivery Executive";
      if (r.rider?.phone) {
        if (enPhone) enPhone.innerText = formatRiderContact(r.rider.phone);
        if (enBtn) {
          enBtn.href = getRiderTelUri(r.rider.phone);
          enBtn.style.display = 'inline-flex';
        }
      } else {
        if (enPhone) enPhone.innerText = storePhone ? `Driver Assigning... (Store Dispatch: ${storePhone})` : 'Driver Assigning...';
        if (enBtn) {
          enBtn.href = `tel:${storePhone || '18002081234'}`;
          enBtn.style.display = 'inline-flex';
        }
      }
    } else {
      enlargedBanner.style.display = 'none';
    }
  }

  // 7C. Trigger High-Impact Mobile Splash & Browser Push Notifications
  const orderIdStr = String(order.id);
  if (status === 'DISPATCHED' && !orderSplashNotified.dispatched.has(orderIdStr)) {
    orderSplashNotified.dispatched.add(orderIdStr);
    const rName = r.rider?.name || "Domino's Delivery Executive";
    const rPhone = r.rider?.phone ? formatRiderContact(r.rider.phone) : (storePhone || 'Store Dispatch');
    
    // In-app Mobile Splash Modal
    const splashName = document.getElementById('splashRiderName');
    const splashPhoneText = document.getElementById('splashRiderPhoneText');
    const splashCallBtn = document.getElementById('splashCallRiderBtn');
    if (splashName) splashName.innerText = rName;
    if (splashPhoneText) splashPhoneText.innerText = rPhone;
    if (splashCallBtn) {
      if (r.rider?.phone) {
        splashCallBtn.href = getRiderTelUri(r.rider.phone);
        splashCallBtn.innerText = `📞 Call Rider (${formatRiderContact(r.rider.phone)})`;
      } else {
        splashCallBtn.href = `tel:${storePhone || '18002081234'}`;
        splashCallBtn.innerText = `📞 Call Store Dispatch`;
      }
    }
    openModal('orderDispatchedSplashModal');

    // Browser Web Push Notification
    triggerBrowserNotification(
      "🛵 Domino's Order Out for Delivery!",
      `Your Domino's order is out for delivery! Rider ${rName} (${rPhone}) is on the way. You can contact the rider.`
    );
  } else if (status === 'DELIVERED' && !orderSplashNotified.delivered.has(orderIdStr)) {
    orderSplashNotified.delivered.add(orderIdStr);
    const finalToken = (r.dominosOrderRef && !String(r.dominosOrderRef).startsWith('DOM-IND-')) ? (String(r.dominosOrderRef).startsWith('#') ? r.dominosOrderRef : `#${r.dominosOrderRef}`) : `#${orderIdStr.slice(-6)}`;
    
    // In-app Mobile Splash Modal
    const splashToken = document.getElementById('splashTokenText');
    if (splashToken) splashToken.innerText = finalToken;
    openModal('orderArrivedSplashModal');

    // Browser Web Push Notification
    triggerBrowserNotification(
      "🍕 Domino's Order Arrived!",
      "Your Domino's order has arrived! Go and collect your order. Enjoy your fresh hot meal!"
    );
  } else if (status === 'CANCELLED' && !orderSplashNotified.cancelled.has(orderIdStr)) {
    orderSplashNotified.cancelled.add(orderIdStr);
    triggerBrowserNotification(
      "❌ Domino's Order Cancelled",
      r.error || "Order was cancelled by the store kitchen due to excess demand or delivery constraints."
    );
  }

  // Automated Delay Notification (Triggers when Domino's reports delivery delay)
  if (!orderSplashNotified.delayed) orderSplashNotified.delayed = new Set();
  if ((r.isDelayed || (r.delayMinutes && r.delayMinutes > 0)) && !orderSplashNotified.delayed.has(orderIdStr)) {
    orderSplashNotified.delayed.add(orderIdStr);
    const minsText = r.delayMinutes ? `~${r.delayMinutes} mins` : 'a few minutes';
    triggerBrowserNotification(
      "⏱️ Domino's Order Delayed",
      `Your Domino's order is delayed by ${minsText} due to high store demand. Your hot fresh pizza will arrive shortly!`
    );
    showToastNotice(`Order is delayed by ${minsText}. Domino's kitchen is preparing your meal with care!`, '⏱️');
  }

  // Automated Arrived Near Doorstep Notification
  if (!orderSplashNotified.arrivedNear) orderSplashNotified.arrivedNear = new Set();
  const isRiderArrivedNear = r.rider?.statusText?.toLowerCase().includes('arrived') || r.rider?.status === 'ARRIVED' || r.rider?.isArrived;
  if (isRiderArrivedNear && !orderSplashNotified.arrivedNear.has(orderIdStr)) {
    orderSplashNotified.arrivedNear.add(orderIdStr);
    triggerBrowserNotification(
      "🛵 Domino's Rider Arrived!",
      `Rider ${r.rider?.name || "Domino's Delivery Partner"} has reached your location! Please collect your pizza.`
    );
    showToastNotice(`Rider ${r.rider?.name || ''} has arrived near your doorstep!`, '🛵');
  }

  // 7D. Live Interactive GPS Tracking Map with Rider Delivery Path & Zooming
  initOrUpdateLiveMap(order);

  // 8. Event Logs Console
  const logsEl = document.getElementById('terminalLogs');
  if (logsEl && r.logs) {
    logsEl.innerHTML = r.logs.map(log => `<div>${log}</div>`).join('');
    logsEl.scrollTop = logsEl.scrollHeight;
  }
}

let liveLeafletMap = null;
let liveMapStoreMarker = null;
let liveMapRiderMarker = null;
let liveMapDestMarker = null;
let liveMapPolyline = null;
let isLiveMapExpanded = false;

function toggleLiveGpsMap() {
  const mapCard = document.getElementById('trackerLiveMapCard');
  const btn = document.getElementById('btnToggleGpsMap');
  const icon = document.getElementById('toggleMapIcon');
  const text = document.getElementById('toggleMapText');
  if (!mapCard) return;

  isLiveGpsMapOpen = !isLiveGpsMapOpen;
  if (isLiveGpsMapOpen) {
    mapCard.style.display = 'block';
    if (text) text.innerHTML = 'Hide Real-Time GPS Map &uarr;';
    if (btn) btn.style.background = '#e0f2fe';
    if (currentOrder) initOrUpdateLiveMap(currentOrder);
    setTimeout(() => {
      if (liveLeafletMap) {
        liveLeafletMap.invalidateSize();
        centerLiveMapOnRider();
      }
    }, 200);
  } else {
    mapCard.style.display = 'none';
    if (text) text.innerHTML = 'Live Rider Delivery &amp; Real-Time GPS &darr;';
    if (btn) btn.style.background = '#eff6ff';
  }
}
window.toggleLiveGpsMap = toggleLiveGpsMap;

function initOrUpdateLiveMap(order) {
  const mapCard = document.getElementById('trackerLiveMapCard');
  if (!mapCard) return;

  // Do NOT show real GPS map by default unless user clicked the toggle button
  if (!isLiveGpsMapOpen || !window.L) {
    mapCard.style.display = 'none';
    return;
  }
  mapCard.style.display = 'block';

  // Update header text badges
  const storeLabel = document.getElementById('mapStoreLabel');
  const riderLabel = document.getElementById('mapRiderLabel');
  const destLabel = document.getElementById('mapDestLabel');
  const liveStatusText = document.getElementById('mapLiveStatusText');

  if (storeLabel) storeLabel.innerText = r.storeName || order.location?.store?.storeName || "Domino's Store";
  if (riderLabel) {
    const rName = rider.name || "Delivery Executive";
    const rPhone = rider.phone ? ` (${formatRiderContact(rider.phone)})` : '';
    riderLabel.innerText = `${rName}${rPhone}`;
  }
  if (destLabel) destLabel.innerText = [order.address?.flat, order.address?.building].filter(Boolean).join(' ') || "Doorstep";
  if (liveStatusText) {
    liveStatusText.innerText = rider.statusText || (status === 'DISPATCHED' ? '🛵 Rider en route (Live GPS)' : `Stage: ${status}`);
  }

  const mapContainer = document.getElementById('liveRiderMapContainer');
  if (!mapContainer) return;

  const defaultCenter = riderCoords ? [riderCoords.lat, riderCoords.lng] : (destCoords ? [destCoords.lat, destCoords.lng] : [30.7333, 76.7794]);

  if (!liveLeafletMap) {
    try {
      liveLeafletMap = L.map('liveRiderMapContainer', {
        zoomControl: true,
        scrollWheelZoom: true,
        touchZoom: true
      }).setView(defaultCenter, 14);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(liveLeafletMap);
    } catch (e) {
      console.warn('Map initialization note:', e);
    }
  }

  if (!liveLeafletMap) return;

  const createBadgeIcon = (emoji, label, color) => L.divIcon({
    className: 'custom-map-pin',
    html: `<div style="display:flex; flex-direction:column; align-items:center; transform: translate(-50%, -100%);">
      <div style="background:${color}; color:white; font-size:11px; font-weight:800; padding:2px 6px; border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,0.3); white-space:nowrap; border:1px solid rgba(255,255,255,0.7);">${label}</div>
      <div style="font-size:24px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4)); line-height:1;">${emoji}</div>
    </div>`,
    iconSize: [30, 42],
    iconAnchor: [15, 42]
  });

  const allPoints = [];

  // 1. Store Kitchen Marker
  if (storeCoords) {
    allPoints.push([storeCoords.lat, storeCoords.lng]);
    const storeIcon = createBadgeIcon('🍕', "Domino's Kitchen", '#dc2626');
    if (!liveMapStoreMarker) {
      liveMapStoreMarker = L.marker([storeCoords.lat, storeCoords.lng], { icon: storeIcon }).addTo(liveLeafletMap);
      liveMapStoreMarker.bindPopup(`<b>🍕 Domino's Store Kitchen</b><br>${r.storeName || 'Domino\'s Outlet'}`);
    } else {
      liveMapStoreMarker.setLatLng([storeCoords.lat, storeCoords.lng]);
    }
  }

  // 2. Customer Destination Doorstep Marker
  if (destCoords) {
    allPoints.push([destCoords.lat, destCoords.lng]);
    const destIcon = createBadgeIcon('🏠', 'Your Doorstep', '#0066a3');
    if (!liveMapDestMarker) {
      liveMapDestMarker = L.marker([destCoords.lat, destCoords.lng], { icon: destIcon }).addTo(liveLeafletMap);
      liveMapDestMarker.bindPopup(`<b>🏠 Delivery Address</b><br>${[order.address?.flat, order.address?.building, order.address?.street].filter(Boolean).join(', ')}`);
    } else {
      liveMapDestMarker.setLatLng([destCoords.lat, destCoords.lng]);
    }
  }

  // 3. Live Delivery Rider Marker
  if (riderCoords && (status === 'DISPATCHED' || rider.phone)) {
    allPoints.push([riderCoords.lat, riderCoords.lng]);
    const riderNameTxt = rider.name || "Domino's Rider";
    const riderIcon = createBadgeIcon('🛵', riderNameTxt, '#15803d');
    if (!liveMapRiderMarker) {
      liveMapRiderMarker = L.marker([riderCoords.lat, riderCoords.lng], { icon: riderIcon, zIndexOffset: 1000 }).addTo(liveLeafletMap);
    } else {
      liveMapRiderMarker.setLatLng([riderCoords.lat, riderCoords.lng]);
    }
    const phoneHtml = rider.phone ? `<br>📞 <a href="${getRiderTelUri(rider.phone)}" style="color:#16a34a; font-weight:800;">${formatRiderContact(rider.phone)}</a>` : '';
    liveMapRiderMarker.bindPopup(`<b>🛵 ${riderNameTxt}</b>${phoneHtml}<br>Status: <strong>${rider.statusText || 'On the way'}</strong>`);
  } else if (liveMapRiderMarker) {
    liveLeafletMap.removeLayer(liveMapRiderMarker);
    liveMapRiderMarker = null;
  }

  // 4. Polyline Route Path
  const polylinePoints = [];
  if (storeCoords) polylinePoints.push([storeCoords.lat, storeCoords.lng]);
  if (riderCoords && (status === 'DISPATCHED' || rider.phone)) polylinePoints.push([riderCoords.lat, riderCoords.lng]);
  if (destCoords) polylinePoints.push([destCoords.lat, destCoords.lng]);

  if (polylinePoints.length >= 2) {
    if (!liveMapPolyline) {
      liveMapPolyline = L.polyline(polylinePoints, {
        color: '#0284c7',
        weight: 4,
        dashArray: '8, 8',
        opacity: 0.85
      }).addTo(liveLeafletMap);
    } else {
      liveMapPolyline.setLatLngs(polylinePoints);
    }
  }

  if (allPoints.length >= 2) {
    liveLeafletMap.fitBounds(allPoints, { padding: [40, 40], maxZoom: 15 });
  }

  setTimeout(() => {
    if (liveLeafletMap) liveLeafletMap.invalidateSize();
  }, 200);
}

function centerLiveMapOnRider() {
  if (!liveLeafletMap || !currentOrder) return;
  const rider = currentOrder.robot?.rider || {};
  const coords = rider.coords || currentOrder.robot?.mapTelemetry?.riderCoords || (currentOrder.address?.latitude && currentOrder.address?.longitude ? { lat: parseFloat(currentOrder.address.latitude), lng: parseFloat(currentOrder.address.longitude) } : null);
  if (coords) {
    liveLeafletMap.setView([coords.lat, coords.lng], 14, { animate: true });
    if (liveMapRiderMarker) liveMapRiderMarker.openPopup();
    showToastNotice(`Tracking path for Rider ${rider.name || ''}`, '🛵');
  }
}

function toggleExpandLiveMap() {
  const container = document.getElementById('liveRiderMapContainer');
  const btn = document.getElementById('btnToggleExpandMap');
  if (!container) return;
  isLiveMapExpanded = !isLiveMapExpanded;
  if (isLiveMapExpanded) {
    container.style.height = '460px';
    if (btn) btn.innerHTML = '🗗 Restore';
  } else {
    container.style.height = '260px';
    if (btn) btn.innerHTML = '🔍 Zoom &amp; Expand';
  }
  if (liveLeafletMap) {
    setTimeout(() => {
      liveLeafletMap.invalidateSize();
      centerLiveMapOnRider();
    }, 200);
  }
}

async function promptUpdateRiderPhone() {
  if (!currentOrder) {
    alert('No active order loaded.');
    return;
  }
  const currentPhone = currentOrder.robot?.rider?.phone || '';
  const newPhone = prompt('Enter Domino\'s Rider Mobile Number (10-digit Indian mobile starting with 6, 7, 8, or 9):', currentPhone);
  if (!newPhone) return;

  const digits = newPhone.replace(/[^0-9]/g, '');
  const digits10 = digits.slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits10)) {
    alert('Please enter a valid 10-digit Indian rider mobile number starting with 6, 7, 8, or 9 (Store landlines like 011/0120 are not permitted).');
    return;
  }

  const defaultName = currentOrder.robot?.rider?.name || "Domino's Delivery Fleet Partner";
  const riderName = prompt('Enter Rider Name (optional):', defaultName);

  try {
    const res = await fetch(`/api/orders/${currentOrder.id}/rider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: newPhone.trim(),
        name: riderName || defaultName,
        status: 'DISPATCHED',
        updateStatus: 'DISPATCHED'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update rider');

    currentOrder = data.order;
    updateTrackingUI(currentOrder);
    showToastNotice(data.message || `🛵 Rider contact updated to ${data.rider.phone}! This is the rider and you can contact the rider for your order.`, '✅');
  } catch (err) {
    alert(`Could not update rider: ${err.message}`);
  }
}

function viewProofScreenshot(url = null) {
  const targetUrl = url || currentOrder?.robot?.proofScreenshotUrl;
  if (!targetUrl) {
    alert('Domino\'s settlement proof photo is still being generated. Please wait a moment.');
    return;
  }
  const img = document.getElementById('proofImgDisplay');
  const link = document.getElementById('proofNewTabLink');
  if (img) img.src = targetUrl;
  if (link) link.href = targetUrl;
  openModal('screenshotProofModal');
}

// =========================================================================
// CUSTOMER ORDER HISTORY (MY ORDERS)
// =========================================================================

let myOrdersPollInterval = null;

function openMyOrdersModal() {
  openModal('myOrdersModal');
  loadMyOrders();
  if (myOrdersPollInterval) clearInterval(myOrdersPollInterval);
  myOrdersPollInterval = setInterval(() => {
    const m = document.getElementById('myOrdersModal');
    if (m && m.classList.contains('active')) {
      loadMyOrdersSilent();
    } else {
      clearInterval(myOrdersPollInterval);
      myOrdersPollInterval = null;
    }
  }, 6000);
}

async function loadMyOrdersSilent() {
  try {
    const res = await fetch('/api/user/orders');
    const data = await res.json();
    if (data && data.orders) {
      renderMyOrders(data.orders);
    }
  } catch (e) {}
}

async function loadMyOrders() {
  const container = document.getElementById('myOrdersListContainer');
  const icon = document.getElementById('refreshMyOrdersIcon');
  if (icon) icon.classList.add('spin-active');
  if (!container) return;

  container.innerHTML = `
    <div style="text-align: center; color: var(--gray-500); padding: 30px 0;">
      <div style="font-size: 28px; margin-bottom: 6px;">⏳</div>
      <div>Loading your past orders from Domino's platform...</div>
    </div>
  `;

  try {
    const res = await fetch('/api/user/orders');
    const data = await res.json();
    const orders = data.orders || [];
    renderMyOrders(orders);
  } catch (err) {
    container.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 20px;">Failed to load order history: ${err.message}</div>`;
  } finally {
    setTimeout(() => {
      if (icon) icon.classList.remove('spin-active');
    }, 600);
  }
}

function renderMyOrders(orders) {
  const container = document.getElementById('myOrdersListContainer');
  if (!container) return;

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--gray-600); padding: 30px 0;">
        <div style="font-size: 38px; margin-bottom: 8px;">🍕</div>
        <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">No past orders found</div>
        <div style="font-size: 12px; color: var(--gray-500);">Your placed orders will appear here with live tracking & physical Domino's bill photos.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = orders.map(o => {
    const r = o.robot || {};
    const itemsCount = (o.items || []).reduce((sum, i) => sum + (i.quantity || 1), 0);
    const dateFormatted = o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Recent';
    const isCod = o.payment?.method === 'COD';
    let statusText = r.status || o.payment?.status || 'PENDING';
    if (isCod && (statusText === 'AWAITING_PAYMENT' || statusText === 'PENDING')) {
      statusText = 'CONFIRMED_COD';
    }
    
    let statusBadge = '<span style="background: #f1f5f9; color: #475569; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;">PENDING</span>';
    if (statusText === 'DELIVERED') {
      statusBadge = '<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">🟢 DELIVERED</span>';
    } else if (statusText === 'DISPATCHED') {
      statusBadge = '<span style="background: #eff6ff; color: #0284c7; border: 1px solid #7dd3fc; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">🛵 ON THE WAY</span>';
    } else if (['BAKING', 'PACKED', 'ORDER_PLACED'].includes(statusText)) {
      statusBadge = '<span style="background: #fef3c7; color: #d97706; border: 1px solid #fde68a; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">🍕 IN KITCHEN (BAKING)</span>';
    } else if (statusText === 'CANCELLED') {
      statusBadge = '<span style="background: #fef2f2; color: #dc2626; border: 1.5px solid #f87171; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">❌ STORE CANCELLED</span>';
    } else if (statusText === 'AWAITING_PAYMENT') {
      statusBadge = '<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">💳 AWAITING PAYMENT</span>';
    } else if (statusText === 'STORE_OFFLINE') {
      statusBadge = '<span style="background: #fffbeb; color: #b45309; border: 1.5px solid #fcd34d; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">🕒 KITCHEN OPENS 11:00 AM</span>';
    } else if (statusText === 'ERROR') {
      statusBadge = '<span style="background: #fef2f2; color: #b91c1c; border: 1.5px solid #fca5a5; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">⚠️ STORE NOTICE</span>';
    } else if (statusText === 'CONFIRMED_COD' || statusText === 'QUEUED_FOR_ROBOT') {
      statusBadge = '<span style="background: #eff6ff; color: #0284c7; border: 1px solid #93c5fd; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 800;">💵 COD (Pay on Delivery)</span>';
    }

    const proofBtn = r.proofScreenshotUrl ? `
      <button onclick="viewProofScreenshot('${r.proofScreenshotUrl}')" style="background: #f0fdf4; border: 1px solid #86efac; color: #166534; font-size: 11px; font-weight: 700; padding: 5px 12px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
        🧾 View Bill Photo
      </button>
    ` : '';

    const itemsSummary = (o.items || []).map(i => `${i.quantity || 1}x ${i.name}`).join(', ');
    const domToken = r.dominosOrderRef || o.dominosOrderRef;
    const tokenDisplay = domToken ? (domToken.startsWith('#') ? domToken : `#${domToken}`) : null;

    return `
      <div style="background: white; border: 1.5px solid var(--gray-200); border-radius: 8px; padding: 14px; margin-bottom: 12px; box-shadow: var(--shadow-sm);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span style="font-weight: 800; font-size: 13px; color: var(--dark);">${o.id}</span>
            ${tokenDisplay ? `<span style="font-size: 11px; color: #15803d; background: #dcfce7; padding: 2px 6px; border-radius: 4px; border: 1px solid #86efac; font-weight: 800; font-family: monospace;">Token: ${tokenDisplay}</span>` : ''}
            <button type="button" onclick="syncOrderToCloud('${o.id}')" style="background: #eff6ff; color: #0284c7; border: 1px solid #bae6fd; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="Click to refresh live telemetry from Domino's Cloud">
              ☁️ Domino's Cloud Synced
            </button>
          </div>
          <div>${statusBadge}</div>
        </div>

        <div style="font-size: 12px; color: #475569; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
          <div>
            <strong>Store:</strong> ${r.storeName || o.address?.storeName || "Domino's Kitchen"} • <span style="color: #64748b;">${dateFormatted}</span>
          </div>
          ${r.storePhone ? `
            <a href="tel:${r.storePhone}" style="color: #0284c7; text-decoration: none; font-weight: 700; font-size: 11px;">
              📞 Call: ${r.storePhone}
            </a>
          ` : ''}
        </div>

        <div style="font-size: 12px; color: #334155; margin-bottom: 8px; background: #f8fafc; padding: 6px 10px; border-radius: 4px;">
          <strong>Items (${itemsCount}):</strong> ${itemsSummary}
        </div>

        ${statusText === 'CANCELLED' ? `
          <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #991b1b; margin-bottom: 8px;">
            ❌ <strong>Domino's Store Cancellation Notice:</strong> ${r.error || "Order was cancelled by store kitchen. You can retry with Instant UPI QR or re-order your cart."}
            <div style="margin-top: 6px; display: flex; gap: 6px;">
              <button onclick="reorderOrderItems('${o.id}')" style="background: #dc2626; color: white; border: none; border-radius: 4px; padding: 4px 8px; font-weight: 700; cursor: pointer; font-size: 11px;">🔁 Retry / Reorder</button>
              <button onclick="openHelpSupportModal('${o.id}')" style="background: white; color: #dc2626; border: 1px solid #dc2626; border-radius: 4px; padding: 4px 8px; font-weight: 700; cursor: pointer; font-size: 11px;">💬 Chat Support</button>
            </div>
          </div>
        ` : ''}

        ${(r.rider && (r.rider.name || r.rider.phone) && !r.rider.name?.includes('Ramesh Kumar')) ? `
          <div style="font-size: 11px; color: #065f46; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 6px 10px; border-radius: 6px; margin-bottom: 8px;">
            <div style="font-weight: 800; font-size: 11px; margin-bottom: 2px;">🛵 This is the rider and you can contact the rider for your order:</div>
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
              <span><strong>${r.rider.name || "Domino's Delivery Executive"}</strong></span>
              ${r.rider.phone ? `
                <a href="${getRiderTelUri(r.rider.phone)}" style="background: #059669; color: white; padding: 3px 8px; border-radius: 4px; text-decoration: none; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">
                  📞 Call: ${formatRiderContact(r.rider.phone)}
                </a>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--gray-100); padding-top: 10px; margin-top: 6px; flex-wrap: wrap; gap: 6px;">
          <div style="font-weight: 800; font-size: 14px; color: #16a34a;">
            Total: ₹${o.payment?.amount || 0}
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button onclick="reorderOrderItems('${o.id}')" style="background: #f8fafc; border: 1.5px solid #cbd5e1; color: #1e293b; font-size: 11px; font-weight: 700; padding: 5px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Reorder exact items to cart">
              🔁 Reorder
            </button>
            <button onclick="openTrackingModal('${o.id}')" style="background: #0066a3; border: none; color: white; font-size: 11px; font-weight: 700; padding: 5px 12px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
              🔍 Track Live
            </button>
            ${proofBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function syncAllOrdersToDominosCloud() {
  const btn = document.getElementById('btnSyncDominosCloud');
  const originalHtml = btn ? btn.innerHTML : "<span>☁️ Domino's Cloud Sync</span>";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Syncing Cloud...</span>';
  }

  showToastNotice("Syncing active orders with Domino's India Live Cloud...", '☁️');

  try {
    const res = await fetch('/api/orders/sync-cloud', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to sync with Domino\'s Cloud');

    showToastNotice(data.message || '✓ Orders synced with Domino\'s India Cloud!', '☁️');
    await loadMyOrders();
  } catch (err) {
    showToastNotice(`Cloud sync notice: ${err.message}`, '⚠️');
    await loadMyOrders();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function syncOrderToCloud(orderId) {
  showToastNotice(`Syncing Order #${orderId} with Domino's Cloud...`, '☁️');
  try {
    const res = await fetch(`/api/orders/${orderId}?refresh=true`);
    if (res.ok) {
      showToastNotice(`✓ Order #${orderId} synced with Domino's Cloud!`, '☁️');
      await loadMyOrders();
    }
  } catch (err) {
    console.warn('Single order cloud sync failed:', err);
  }
}

async function reorderOrderItems(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`);
    if (!res.ok) throw new Error('Order not found');
    const order = await res.json();
    if (!order.items || order.items.length === 0) {
      showToastNotice('No items found in this order to reorder.', '⚠️');
      return;
    }
    
    // Add items from this order into current active cart
    order.items.forEach(it => {
      const existing = cart.find(c => c.id === it.id || (c.name === it.name && c.customSize === it.customSize && c.customCrust === it.customCrust));
      if (existing) {
        existing.quantity += (it.quantity || 1);
      } else {
        cart.push({
          id: it.id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          name: it.name,
          price: it.price,
          quantity: it.quantity || 1,
          customSize: it.customSize || null,
          customCrust: it.customCrust || null,
          customToppings: it.customToppings || [],
          dominosCode: it.dominosCode || null,
          skuId: it.skuId || null
        });
      }
    });

    closeModal('myOrdersModal');
    updateCartBadge();
    renderFloatingCartBar();
    renderCartDrawer(true);
    openCartModal();
    showToastNotice(`🔁 Reordered ${order.items.length} item(s) from Order ${orderId}!`, '🍕');
  } catch (err) {
    showToastNotice(`Could not reorder: ${err.message}`, '⚠️');
  }
}

// =========================================================================
// CUSTOMER WALLET DEPOSIT & TRANSACTION HISTORY CONTROLS
// =========================================================================

let activeDepositRequest = null;

function openWalletDepositModal() {
  if (isMaintenanceActive) {
    alert(`⚠️ System Maintenance Active:\n\n${maintenanceInfo?.message || "Domino's Order Engine is currently under scheduled maintenance. Wallet deposits are temporarily paused. We will be back shortly!"}`);
    return;
  }

  if (!isUserLoggedIn()) {
    openGoogleAuthModal();
    showToastNotice('Please sign in with Google to add money to your wallet.', '💰');
    return;
  }
  const modal = document.getElementById('walletDepositModal');
  const balDisplay = document.getElementById('walletModalCurrentBalance');
  if (balDisplay) {
    balDisplay.innerText = `₹${currentUser.wallet?.balance || 0}`;
  }
  const input = document.getElementById('depositAmountInput');
  if (input) input.value = '50';

  // Reset steps
  const stepA = document.getElementById('depositStepAmount');
  const stepB = document.getElementById('depositStepPayment');
  const stepC = document.getElementById('depositStepSubmitted');
  if (stepA) stepA.style.display = 'block';
  if (stepB) stepB.style.display = 'none';
  if (stepC) stepC.style.display = 'none';

  openModal('walletDepositModal');
}

function selectDepositPreset(amount) {
  const input = document.getElementById('depositAmountInput');
  if (input) input.value = amount;
}

function backToDepositAmount() {
  const stepA = document.getElementById('depositStepAmount');
  const stepB = document.getElementById('depositStepPayment');
  const stepC = document.getElementById('depositStepSubmitted');
  if (stepA) stepA.style.display = 'block';
  if (stepB) stepB.style.display = 'none';
  if (stepC) stepC.style.display = 'none';
}

function copyDepositRef() {
  const ref = activeDepositRequest?.reference || document.getElementById('depositRefDisplay')?.innerText?.trim() || '';
  if (!ref) return;
  navigator.clipboard.writeText(ref).then(() => {
    showToastNotice(`Deposit reference ${ref} copied!`, '📋');
  }).catch(() => {
    prompt('Copy Deposit Reference:', ref);
  });
}
window.copyDepositRef = copyDepositRef;

function copyDepositUpiId() {
  const upiId = activeDepositRequest?.payeeUpi || document.getElementById('depositUpiIdDisplay')?.innerText?.trim() || 'dominosync@upi';
  navigator.clipboard.writeText(upiId).then(() => {
    showToastNotice(`UPI ID ${upiId} copied to clipboard!`, '📋');
  }).catch(() => {
    prompt('Copy UPI ID:', upiId);
  });
}
window.copyDepositUpiId = copyDepositUpiId;

function copyDepositNote() {
  const note = activeDepositRequest?.note || activeDepositRequest?.reference || document.getElementById('depositNoteDisplay')?.innerText?.trim() || '';
  if (!note) return;
  navigator.clipboard.writeText(note).then(() => {
    showToastNotice(`Payment note copied!`, '📋');
  }).catch(() => {
    prompt('Copy Payment Note:', note);
  });
}
window.copyDepositNote = copyDepositNote;

let depositCountdownInterval = null;

function startDepositCountdown(expiresAt) {
  if (depositCountdownInterval) clearInterval(depositCountdownInterval);
  const timerEl = document.getElementById('depositCountdownTimer');
  const overlayEl = document.getElementById('depositQrExpiredOverlay');
  const expiredRefEl = document.getElementById('expiredRefDisplay');
  if (overlayEl) overlayEl.style.display = 'none';

  const expTime = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 5 * 60 * 1000;

  const updateTimer = () => {
    const remainingMs = Math.max(0, expTime - Date.now());
    const totalSec = Math.floor(remainingMs / 1000);
    const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');

    if (timerEl) timerEl.innerText = `${mins}:${secs}`;

    if (totalSec <= 0) {
      clearInterval(depositCountdownInterval);
      depositCountdownInterval = null;
      if (overlayEl) {
        overlayEl.style.display = 'flex';
        if (expiredRefEl && activeDepositRequest) {
          expiredRefEl.innerText = activeDepositRequest.reference;
        }
      }
      showToastNotice('UPI QR has expired after 5 minutes. Generate a new QR if needed.', '⏳');
    }
  };

  updateTimer();
  depositCountdownInterval = setInterval(updateTimer, 1000);
}

function openDepositInfoModal() {
  openModal('depositInfoModal');
}
window.openDepositInfoModal = openDepositInfoModal;

async function cancelCurrentDeposit() {
  if (depositCountdownInterval) {
    clearInterval(depositCountdownInterval);
    depositCountdownInterval = null;
  }
  if (!activeDepositRequest) {
    closeModal('walletDepositModal');
    return;
  }
  try {
    await fetch('/api/user/wallet/deposit/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: activeDepositRequest.reference })
    });
    showToastNotice(`Deposit ${activeDepositRequest.reference} cancelled.`, '❌');
  } catch (e) {
    console.warn('Failed to cancel deposit:', e);
  } finally {
    activeDepositRequest = null;
    closeModal('walletDepositModal');
    backToDepositAmount();
  }
}
window.cancelCurrentDeposit = cancelCurrentDeposit;

async function requestWalletDepositQr() {
  if (isMaintenanceActive) {
    alert(`⚠️ System Maintenance Active:\n\n${maintenanceInfo?.message || "Domino's Order Engine is currently under scheduled maintenance. Wallet deposits are temporarily paused."}`);
    return;
  }

  if (!isUserLoggedIn()) {
    openGoogleAuthModal();
    showToastNotice('Please sign in with Google to add money to your wallet.', '💰');
    return;
  }

  const input = document.getElementById('depositAmountInput');
  const amount = Math.round(Number(input?.value));
  if (!amount || isNaN(amount) || amount < 50) {
    alert('Minimum deposit amount is ₹50.');
    return;
  }

  const btn = document.getElementById('btnGenerateDepositQr');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⚡ Generating Dynamic UPI QR...';
  }

  try {
    const res = await fetch('/api/user/wallet/deposit/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amount,
        phone: currentUser.phone || '',
        userId: currentUser.userId12 || '',
        email: currentUser.email || ''
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate deposit request');

    activeDepositRequest = data;

    // Populate Payment View
    const amtEl = document.getElementById('depositPayAmountDisplay');
    if (amtEl) amtEl.innerText = `₹${data.amount}`;

    const deepLinkEl = document.getElementById('depositUpiDeepLink');
    if (deepLinkEl) deepLinkEl.href = data.upiUri;

    const qrContainer = document.getElementById('depositQrContainer');
    if (qrContainer) {
      if (window.generateQRCodeSVG) {
        qrContainer.innerHTML = window.generateQRCodeSVG(data.upiUri, 180);
      } else {
        qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.upiUri)}&margin=0" alt="UPI QR" style="width:180px; height:180px; border-radius:8px; border:1px solid #cbd5e1;">`;
      }
    }

    // Start 5-Minute Expiry Countdown
    startDepositCountdown(data.expiresAt);

    // Switch view
    document.getElementById('depositStepAmount').style.display = 'none';
    document.getElementById('depositStepPayment').style.display = 'block';

  } catch (err) {
    alert(`Could not generate deposit QR: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '⚡ Generate UPI QR & Pay →';
    }
  }
}
window.requestWalletDepositQr = requestWalletDepositQr;

async function downloadDepositQr() {
  if (!activeDepositRequest || !activeDepositRequest.upiUri) {
    showToastNotice('No active deposit QR found', '⚠️');
    return;
  }
  const amt = activeDepositRequest.amount || 50;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(activeDepositRequest.upiUri)}&margin=10`;
  try {
    const res = await fetch(qrUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `dominos-deposit-qr-₹${amt}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    showToastNotice(`Deposit QR saved (₹${amt})! Open in PhonePe / GPay scanner.`, '📥');
  } catch (err) {
    const a = document.createElement('a');
    a.href = qrUrl;
    a.target = '_blank';
    a.download = `dominos-deposit-qr-₹${amt}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToastNotice('Deposit QR opened for download.', '📥');
  }
}
window.downloadDepositQr = downloadDepositQr;

async function submitDepositPaidConfirmation() {
  if (!activeDepositRequest) return;
  const btn = document.getElementById('btnConfirmPaid');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Submitting for Approval...';
  }

  try {
    if (depositCountdownInterval) {
      clearInterval(depositCountdownInterval);
      depositCountdownInterval = null;
    }

    const res = await fetch('/api/user/wallet/deposit/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference: activeDepositRequest.reference,
        amount: activeDepositRequest.amount,
        phone: currentUser.phone || '7893618933',
        upiUri: activeDepositRequest.upiUri
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit deposit');

    const subRef = document.getElementById('submittedRefDisplay');
    if (subRef) subRef.innerText = activeDepositRequest.reference;
    const subAmt = document.getElementById('submittedAmtDisplay');
    if (subAmt) subAmt.innerText = `₹${activeDepositRequest.amount}`;

    document.getElementById('depositStepPayment').style.display = 'none';
    document.getElementById('depositStepSubmitted').style.display = 'block';

    showToastNotice(`Deposit ${activeDepositRequest.reference} submitted! Admin will approve within minutes.`, '⏳');
    loadWalletTransactions();

  } catch (err) {
    alert(`Submission error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '✅ I Have Paid the Amount';
    }
  }
}

let cachedCustomerTransactions = [];

// Load and Render Customer Digital Wallet Transaction History
async function loadWalletTransactions() {
  const container = document.getElementById('walletTransactionsListContainer');
  if (!container) return;

  try {
    const uid = currentUser.userId12 || '';
    const res = await fetch(`/api/user/wallet/transactions?userId=${encodeURIComponent(uid)}`);
    const data = await res.json();
    const txns = data.transactions || [];
    cachedCustomerTransactions = txns;

    if (!txns || txns.length === 0) {
      container.innerHTML = '<div style="text-align: center; font-size: 12px; color: #64748b; padding: 18px;">No wallet transactions recorded yet.</div>';
      return;
    }

    container.innerHTML = txns.map(t => {
      const isCredit = t.type === 'DEPOSIT' || t.type === 'ADD' || (t.amount > 0 && !t.type?.includes('SUB') && !t.type?.includes('ORDER') && !t.type?.includes('WIT'));
      const isPending = t.status === 'PENDING_APPROVAL' || t.status === 'INITIATED';
      const isRejected = t.status === 'REJECTED' || t.status === 'CANCELLED';
      const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Recent';

      let statusBadge = '<span style="background: #dcfce7; color: #15803d; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px;">APPROVED</span>';
      if (isPending) {
        statusBadge = '<span style="background: #fef3c7; color: #b45309; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px;">PENDING</span>';
      } else if (isRejected) {
        statusBadge = '<span style="background: #fee2e2; color: #b91c1c; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px;">CANCELLED</span>';
      }

      const icon = isPending ? '⏳' : (isCredit ? '💰' : '🍕');
      const sign = isCredit ? '+' : '-';
      const amtColor = isPending ? '#b45309' : (isCredit ? '#15803d' : '#0f172a');
      const displayTitle = t.reason || (isCredit ? 'Wallet Top-Up' : 'Domino\'s Order');

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; background: white; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s ease;" onclick="openTransactionDetails('${t.id || t.reference}')" onmouseover="this.style.borderColor='#93c5fd'" onmouseout="this.style.borderColor='#e2e8f0'">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 18px;">${icon}</span>
            <div>
              <div style="font-size: 12px; font-weight: 800; color: #0f172a;">${displayTitle}</div>
              <div style="font-size: 11px; color: #64748b;">${dateStr} • Ref: <code>${t.reference || t.id || 'N/A'}</code></div>
            </div>
          </div>
          <div style="text-align: right; display: flex; align-items: center; gap: 10px;">
            <div>
              <div style="font-size: 13px; font-weight: 900; color: ${amtColor};">${sign}₹${Math.abs(t.amount)}</div>
              <div style="margin-top: 2px;">${statusBadge}</div>
            </div>
            <button type="button" class="btn-action-copy" style="font-size: 10px; padding: 3px 6px;" onclick="event.stopPropagation(); openTransactionDetails('${t.id || t.reference}')">
              👁️ Details
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.warn('Failed to load wallet transactions:', err);
  }
}

// Detailed Transaction Modal Viewer (Zero Redirection / Clean Details)
function openTransactionDetails(txId) {
  if (!txId) return;
  const t = cachedCustomerTransactions.find(x => x.id === txId || x.reference === txId || x.referenceId === txId);
  const container = document.getElementById('txDetailsContent');
  if (!container) return;

  if (!t) {
    container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 20px;">Transaction details not found.</div>';
    openModal('transactionDetailsModal');
    return;
  }

  const isCredit = t.type === 'DEPOSIT' || t.type === 'ADD' || (t.amount > 0 && !t.type?.includes('SUB') && !t.type?.includes('ORDER'));
  const isPending = t.status === 'PENDING_APPROVAL' || t.status === 'INITIATED';
  const isRejected = t.status === 'REJECTED' || t.status === 'CANCELLED';
  const dateFormatted = t.timestamp ? new Date(t.timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Recent';

  let statusHtml = '<span style="background: #dcfce7; color: #15803d; font-weight: 800; padding: 3px 8px; border-radius: 4px; font-size: 11px;">✅ APPROVED / COMPLETED</span>';
  if (isPending) {
    statusHtml = '<span style="background: #fef3c7; color: #b45309; font-weight: 800; padding: 3px 8px; border-radius: 4px; font-size: 11px;">⏳ PENDING VERIFICATION</span>';
  } else if (isRejected) {
    statusHtml = '<span style="background: #fee2e2; color: #b91c1c; font-weight: 800; padding: 3px 8px; border-radius: 4px; font-size: 11px;">✕ CANCELLED</span>';
  }

  const sign = isCredit ? '+' : '-';
  const amtColor = isPending ? '#b45309' : (isCredit ? '#15803d' : '#0f172a');
  const typeTitle = isCredit ? 'Wallet Top-Up Deposit' : (t.type?.includes('ORDER') ? 'Food Order Settlement' : 'Wallet Balance Adjustment');

  let orderActionBtn = '';
  if (t.orderId || (t.reference && t.reference.startsWith('ORD-'))) {
    const oId = t.orderId || t.reference;
    orderActionBtn = `
      <div style="margin-top: 14px; padding-top: 12px; border-top: 1px dashed #cbd5e1;">
        <button type="button" class="btn-primary" onclick="closeModal('transactionDetailsModal'); openTrackingModal('${oId}');" style="width: 100%; font-size: 12px; font-weight: 800; background: #0066a3; padding: 8px;">
          🛵 View Live Domino's Order Tracker (${oId}) &rarr;
        </button>
      </div>
    `;
  }

  container.innerHTML = `
    <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 14px; margin-bottom: 14px; text-align: center;">
      <div style="font-size: 11px; text-transform: uppercase; font-weight: 800; color: #64748b; letter-spacing: 0.5px;">${typeTitle}</div>
      <div style="font-size: 26px; font-weight: 900; color: ${amtColor}; margin: 4px 0;">${sign}₹${Math.abs(t.amount)}</div>
      <div>${statusHtml}</div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px;">
        <span style="color: #64748b;">Transaction Reference:</span>
        <code style="font-weight: 800; color: #0f172a; background: #e2e8f0; padding: 1px 6px; border-radius: 4px;">${t.reference || t.id || 'N/A'}</code>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px;">
        <span style="color: #64748b;">Date &amp; Time:</span>
        <span style="font-weight: 700; color: #1e293b;">${dateFormatted}</span>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px;">
        <span style="color: #64748b;">Description:</span>
        <span style="font-weight: 700; color: #1e293b; text-align: right; max-width: 60%;">${t.reason || typeTitle}</span>
      </div>
      ${t.previousBalance !== undefined && t.newBalance !== undefined ? `
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px;">
          <span style="color: #64748b;">Balance Impact:</span>
          <span style="font-weight: 700; color: #334155;">₹${t.previousBalance} &rarr; <strong>₹${t.newBalance}</strong></span>
        </div>
      ` : ''}
    </div>
    ${orderActionBtn}
  `;

  openModal('transactionDetailsModal');
}
window.openTransactionDetails = openTransactionDetails;

// Legacy fallback
async function submitWalletDeposit() {
  requestWalletDepositQr();
}

// Request Direct UPI Wallet Withdrawal
async function submitWalletWithdrawalRequest() {
  const amtInput = document.getElementById('withdrawAmountInput');
  const upiInput = document.getElementById('withdrawUpiIdInput');
  const remarksInput = document.getElementById('withdrawRemarksInput');
  const btn = document.getElementById('btnSubmitWithdrawal');
  const noticeEl = document.getElementById('withdrawalStatusNotice');

  const amount = Math.round(Number(amtInput?.value));
  const upiId = upiInput?.value?.trim();
  const remarks = remarksInput?.value?.trim();

  if (!amount || isNaN(amount) || amount < 1) {
    alert('Please enter a valid withdrawal amount of at least ₹1.');
    return;
  }

  const currentBal = Number(currentUser?.wallet?.balance ?? currentUser?.walletBalance ?? 0);
  if (currentBal <= 0) {
    alert('Your wallet balance is ₹0. Please deposit funds or complete orders first.');
    return;
  }
  if (amount > currentBal) {
    alert(`Withdrawal amount (₹${amount}) cannot exceed your available wallet balance of ₹${currentBal}.`);
    return;
  }

  if (!upiId || !upiId.includes('@')) {
    alert('Please enter a valid destination UPI ID (e.g. yourname@okhdfcbank or 9876543210@paytm).');
    return;
  }

  // Anti-double click protection
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Submitting Withdrawal Request...';
  }

  try {
    const res = await fetch('/api/user/wallet/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.userId12 || '948271035824',
        userName: currentUser.name || 'Parth',
        phone: currentUser.phone || '7893618933',
        amount: amount,
        upiId: upiId,
        remarks: remarks
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit withdrawal request');

    if (noticeEl) {
      noticeEl.style.display = 'block';
      noticeEl.style.background = '#f0fdf4';
      noticeEl.style.color = '#15803d';
      noticeEl.style.border = '1px solid #86efac';
      noticeEl.innerHTML = `✓ Withdrawal Request <strong>${data.withdrawal?.id || 'SUBMITTED'}</strong> of ₹${amount} submitted! Desk will process direct payout to <code>${upiId}</code>.`;
    }

    if (amtInput) amtInput.value = '';
    if (remarksInput) remarksInput.value = '';

    showToastNotice(`Withdrawal request of ₹${amount} submitted successfully!`, '💸');
    await loadUserProfileWallet();
    loadWalletTransactions();

  } catch (err) {
    alert(`Withdrawal request failed: ${err.message}`);
    if (noticeEl) {
      noticeEl.style.display = 'block';
      noticeEl.style.background = '#fef2f2';
      noticeEl.style.color = '#991b1b';
      noticeEl.style.border = '1px solid #f87171';
      noticeEl.innerText = `Error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '💸 Submit Withdrawal Request';
    }
  }
}
window.submitWalletWithdrawalRequest = submitWalletWithdrawalRequest;

// Help & Support Chat Window Controls
let isHelpModalMaximized = false;

function minimizeHelpModal() {
  const modal = document.getElementById('helpSupportModal');
  if (modal) modal.classList.remove('active');
  const dock = document.getElementById('chatFloatingDock');
  if (dock) dock.style.display = 'flex';
  showToastNotice('Support chat minimized. Tap floating dock to resume.', '💬');
}

function restoreHelpModal() {
  const dock = document.getElementById('chatFloatingDock');
  if (dock) dock.style.display = 'none';
  const modal = document.getElementById('helpSupportModal');
  if (modal) modal.classList.add('active');
}

function toggleMaximizeHelpModal() {
  const card = document.getElementById('helpSupportModalCard');
  const btn = document.getElementById('btnMaximizeHelp');
  if (!card) return;
  isHelpModalMaximized = !isHelpModalMaximized;
  if (isHelpModalMaximized) {
    card.style.maxWidth = '98vw';
    card.style.width = '98vw';
    card.style.height = '95vh';
    if (btn) btn.innerText = '🗗';
  } else {
    card.style.maxWidth = '620px';
    card.style.width = '95%';
    card.style.height = 'auto';
    if (btn) btn.innerText = '🗖';
  }
}

// =========================================================================
// IN-APP NOTIFICATIONS & ANNOUNCEMENT BANNER
// =========================================================================

async function loadStorefrontNotifications() {
  try {
    let active = null;
    try {
      const annRes = await fetch('/api/announcements');
      const annData = await annRes.json();
      if (annData.announcements && annData.announcements.length > 0) {
        active = annData.announcements[0];
      }
    } catch (e) {}

    if (!active) {
      const res = await fetch('/api/notifications');
      const notifs = await res.json();
      if (Array.isArray(notifs) && notifs.length > 0) {
        active = notifs[0];
      }
    }

    if (active) {
      const banner = document.getElementById('storeNotificationBanner');
      const badge = document.getElementById('bannerBadge');
      const title = document.getElementById('bannerTitle');
      const msg = document.getElementById('bannerMessage');
      if (banner) {
        if (badge) badge.innerText = active.badge || 'DOMINO\'S LIVE';
        if (title) title.innerText = active.title || '';
        if (msg) msg.innerText = active.message || '';
        if (active.type === 'ALERT') {
          banner.style.background = '#fffbeb';
          banner.style.borderColor = '#fde68a';
          banner.style.color = '#92400e';
          if (badge) badge.style.background = '#d97706';
        } else if (active.type === 'ANNOUNCEMENT') {
          banner.style.background = '#eff6ff';
          banner.style.borderColor = '#bfdbfe';
          banner.style.color = '#1e40af';
          if (badge) badge.style.background = '#0284c7';
        } else {
          banner.style.background = '#ecfdf5';
          banner.style.borderColor = '#86efac';
          banner.style.color = '#166534';
          if (badge) badge.style.background = '#16a34a';
        }
        banner.style.display = 'flex';
      }
    }
  } catch (err) {
    console.warn('Failed to load storefront announcements:', err);
  }
}

function dismissNotificationBanner() {
  const banner = document.getElementById('storeNotificationBanner');
  if (banner) banner.style.display = 'none';
}

// =========================================================================
// 9. DOMINOSYNC IN-APP HELP, LIVE SUPPORT CHAT & TICKET SYSTEM
// =========================================================================

let currentActiveTicketId = null;
let supportChatPollInterval = null;
let activeTicketCategory = 'MISSING_ITEM';
let attachedProofBase64 = null;
let userCachedTickets = [];

function openOrderHelpChat(orderId = null) {
  closeModal('trackingModal');
  closeModal('myOrdersModal');
  openHelpSupportModal(orderId || currentOrder?.id || null);
}
window.openOrderHelpChat = openOrderHelpChat;

async function openHelpSupportModal(preselectedOrderId = null) {
  // 1. Populate recent orders dropdown
  const orderSelect = document.getElementById('ticketOrderSelect');
  if (orderSelect) {
    orderSelect.innerHTML = '<option value="">-- General Store Inquiry (No Specific Order) --</option>';
    
    // Add current order if present
    if (currentOrder && currentOrder.id) {
      const ref = currentOrder.robot?.dominosOrderRef || currentOrder.dominosOrderRef;
      const refStr = ref ? ` (Ref: #${ref})` : '';
      orderSelect.innerHTML += `<option value="${currentOrder.id}" selected>${currentOrder.id}${refStr} - ₹${currentOrder.payment?.amount || 0}</option>`;
    }

    // Fetch user order history to populate additional past orders
    try {
      const phoneParam = encodeURIComponent(currentUser.phone || '+91 7893618933');
      const res = await fetch(`/api/orders?phone=${phoneParam}`);
      if (res.ok) {
        const orders = await res.json();
        if (Array.isArray(orders)) {
          orders.slice(0, 8).forEach(o => {
            if (currentOrder && o.id === currentOrder.id) return; // avoid duplicate
            const ref = o.robot?.dominosOrderRef || o.dominosOrderRef;
            const refStr = ref ? ` (Ref: #${ref})` : '';
            const opt = document.createElement('option');
            opt.value = o.id;
            opt.innerText = `${o.id}${refStr} - ₹${o.payment?.amount || 0} (${new Date(o.createdAt).toLocaleDateString()})`;
            orderSelect.appendChild(opt);
          });
        }
      }
    } catch (e) {
      console.warn('Could not load orders for ticket select:', e);
    }

    if (preselectedOrderId) {
      orderSelect.value = preselectedOrderId;
    }
  }

  // 2. Reset form
  const descEl = document.getElementById('ticketDescription');
  if (descEl) descEl.value = '';
  const photoInput = document.getElementById('ticketPhotoInput');
  if (photoInput) photoInput.value = '';
  const previewContainer = document.getElementById('ticketImagePreviewContainer');
  if (previewContainer) previewContainer.style.display = 'none';
  attachedProofBase64 = null;

  // 3. Load user's active tickets
  await loadUserTickets(true);

  // 4. Default to raise view unless user specifically has open tickets
  if (userCachedTickets.length > 0 && userCachedTickets.some(t => t.status === 'OPEN') && !preselectedOrderId) {
    switchSupportTab('tickets');
  } else {
    switchSupportTab('raise');
  }

  openModal('helpSupportModal');

  // Start real-time chat sync poller (every 4 seconds)
  if (supportChatPollInterval) clearInterval(supportChatPollInterval);
  supportChatPollInterval = setInterval(pollActiveChat, 4000);
}

function switchSupportTab(tab) {
  const raiseView = document.getElementById('supportRaiseView');
  const chatView = document.getElementById('supportChatView');
  const btnRaise = document.getElementById('tabRaiseTicket');
  const btnTickets = document.getElementById('tabActiveTickets');

  if (tab === 'raise') {
    if (raiseView) raiseView.style.display = 'block';
    if (chatView) chatView.style.display = 'none';
    if (btnRaise) {
      btnRaise.style.background = '#0066a3';
      btnRaise.style.color = 'white';
      btnRaise.style.border = 'none';
    }
    if (btnTickets) {
      btnTickets.style.background = 'white';
      btnTickets.style.color = 'var(--gray-600)';
      btnTickets.style.border = '1px solid var(--gray-300)';
    }
  } else {
    if (raiseView) raiseView.style.display = 'none';
    if (chatView) chatView.style.display = 'block';
    if (btnTickets) {
      btnTickets.style.background = '#0066a3';
      btnTickets.style.color = 'white';
      btnTickets.style.border = 'none';
    }
    if (btnRaise) {
      btnRaise.style.background = 'white';
      btnRaise.style.color = 'var(--gray-600)';
      btnRaise.style.border = '1px solid var(--gray-300)';
    }
    loadUserTickets(false);
  }
}

function selectTicketCategory(cat, btn) {
  activeTicketCategory = cat;
  const pills = document.querySelectorAll('#ticketCategoryPills .category-pill');
  pills.forEach(p => {
    p.classList.remove('active');
    p.style.border = '1.5px solid var(--gray-300)';
    p.style.background = 'white';
    p.style.color = 'var(--gray-600)';
  });
  if (btn) {
    btn.classList.add('active');
    btn.style.border = '1.5px solid #0066a3';
    btn.style.background = '#f0f9ff';
    btn.style.color = '#0066a3';
  }
}

function previewTicketImage(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert('Photo must be less than 5MB.');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      attachedProofBase64 = e.target.result;
      const preview = document.getElementById('ticketImagePreview');
      const container = document.getElementById('ticketImagePreviewContainer');
      if (preview) preview.src = attachedProofBase64;
      if (container) container.style.display = 'block';
    };
    reader.readAsDataURL(file);
  } else {
    attachedProofBase64 = null;
    const container = document.getElementById('ticketImagePreviewContainer');
    if (container) container.style.display = 'none';
  }
}

async function submitSupportTicket() {
  const desc = (document.getElementById('ticketDescription')?.value || '').trim();
  const orderId = document.getElementById('ticketOrderSelect')?.value || null;
  const btn = document.getElementById('btnSubmitTicket');

  if (!desc) {
    alert('Please describe your inquiry or problem so our Domino\'s Order Engine support team can assist you.');
    const dInput = document.getElementById('ticketDescription');
    if (dInput) dInput.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Connecting Support Assistant...';
  }

  try {
    const payload = {
      orderId: orderId,
      userId: currentUser.userId12 || '948271035824',
      userPhone: currentUser.phone || '+91 7893618933',
      userName: currentUser.name || 'Parth Sharma',
      category: activeTicketCategory,
      description: desc,
      imageUrl: attachedProofBase64
    };

    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to submit ticket');

    showToastNotice(`Ticket #${data.ticket.id} created! Live triage bot connected.`, '🎧');
    currentActiveTicketId = data.ticket.id;

    // Reset inputs
    document.getElementById('ticketDescription').value = '';
    attachedProofBase64 = null;
    const previewContainer = document.getElementById('ticketImagePreviewContainer');
    if (previewContainer) previewContainer.style.display = 'none';

    // Switch to active chat tab and display conversation
    await loadUserTickets(false);
    switchSupportTab('tickets');
  } catch (err) {
    alert('Error submitting ticket: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🚀 Submit Query & Start Live Chat';
    }
  }
}

async function loadUserTickets(silent = false) {
  try {
    const phoneParam = encodeURIComponent(currentUser.phone || '+91 7893618933');
    const res = await fetch(`/api/support/tickets?phone=${phoneParam}`);
    if (!res.ok) return;
    const tickets = await res.json();
    userCachedTickets = Array.isArray(tickets) ? tickets : [];

    const countEl = document.getElementById('userTicketCount');
    if (countEl) countEl.innerText = userCachedTickets.length;

    const select = document.getElementById('userActiveTicketsSelect');
    if (select) {
      if (userCachedTickets.length === 0) {
        select.innerHTML = '<option value="">No Support Tickets Yet</option>';
      } else {
        select.innerHTML = userCachedTickets.map(t => {
          const statusIcon = t.status === 'OPEN' ? '🟡' : '🟢';
          const orderStr = t.orderId ? `[Order: ${t.orderId}]` : '[General]';
          return `<option value="${t.id}" ${t.id === currentActiveTicketId ? 'selected' : ''}>${statusIcon} ${t.id} - ${t.category} ${orderStr}</option>`;
        }).join('');
      }
    }

    if (!currentActiveTicketId || !userCachedTickets.find(t => t.id === currentActiveTicketId)) {
      currentActiveTicketId = userCachedTickets[0]?.id || null;
      if (select && currentActiveTicketId) select.value = currentActiveTicketId;
    }

    if (currentActiveTicketId) {
      const activeTicket = userCachedTickets.find(t => t.id === currentActiveTicketId);
      if (activeTicket) renderTicketChat(activeTicket);
    } else {
      const messagesEl = document.getElementById('supportChatMessages');
      if (messagesEl) {
        messagesEl.innerHTML = `
          <div style="margin: auto; text-align: center; color: var(--gray-500); font-size: 13px;">
            No support tickets open.<br>Click <strong>"➕ Raise Order Ticket"</strong> above to contact our support team.
          </div>
        `;
      }
    }
  } catch (err) {
    if (!silent) console.error('Error loading user tickets:', err);
  }
}

function onUserSelectTicket(ticketId) {
  currentActiveTicketId = ticketId;
  const ticket = userCachedTickets.find(t => t.id === ticketId);
  if (ticket) renderTicketChat(ticket);
}

function renderTicketChat(ticket) {
  if (!ticket) return;

  const titleEl = document.getElementById('activeChatTicketTitle');
  const orderBadgeEl = document.getElementById('activeChatOrderBadge');
  const statusBadgeEl = document.getElementById('activeChatStatusBadge');
  const proofContainer = document.getElementById('userChatProofPreview');
  const proofImg = document.getElementById('userChatProofImg');
  const messagesEl = document.getElementById('supportChatMessages');

  if (titleEl) titleEl.innerText = `${ticket.id} • ${ticket.category.replace(/_/g, ' ')}`;
  if (orderBadgeEl) orderBadgeEl.innerText = ticket.orderId ? `Order: ${ticket.orderId}` : 'General Order Inquiry';
  
  if (statusBadgeEl) {
    statusBadgeEl.innerText = ticket.status;
    if (ticket.status === 'OPEN') {
      statusBadgeEl.style.background = '#fef3c7';
      statusBadgeEl.style.color = '#b45309';
    } else {
      statusBadgeEl.style.background = '#dcfce7';
      statusBadgeEl.style.color = '#15803d';
    }
  }

  if (proofContainer) {
    if (ticket.imageUrl) {
      proofContainer.style.display = 'block';
      if (proofImg) proofImg.src = ticket.imageUrl;
    } else {
      proofContainer.style.display = 'none';
    }
  }

  if (messagesEl) {
    const msgs = ticket.messages || [];
    if (msgs.length === 0) {
      messagesEl.innerHTML = '<div style="margin: auto; color: var(--gray-500); font-size: 12px;">No messages yet.</div>';
    } else {
      messagesEl.innerHTML = msgs.map(m => {
        const isUser = m.sender === 'USER';
        const isBot = m.sender === 'DOMINOS_BOT' || m.sender === 'BOT';
        const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const senderLabel = isUser ? 'You' : (isBot ? '🤖 Domino\'s Order Engine Assistant' : '🎧 Support Manager (Admin)');
        const bg = isUser ? '#0066a3' : (isBot ? '#e0f2fe' : '#ffffff');
        const color = isUser ? '#ffffff' : '#0f172a';
        const align = isUser ? 'flex-end' : 'flex-start';
        const border = isUser ? 'none' : '1px solid #cbd5e1';

        return `
          <div style="display: flex; flex-direction: column; align-items: ${align}; max-width: 82%; align-self: ${align};">
            <span style="font-size: 10px; font-weight: 700; color: #64748b; margin-bottom: 2px;">${senderLabel} • ${time}</span>
            <div style="background: ${bg}; color: ${color}; border: ${border}; border-radius: 8px; padding: 8px 12px; font-size: 12px; line-height: 1.4; word-break: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
              ${m.text}
              ${m.imageUrl ? `<div style="margin-top: 6px;"><img src="${m.imageUrl}" style="max-height: 120px; border-radius: 4px;" /></div>` : ''}
            </div>
          </div>
        `;
      }).join('');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }
}

async function sendChatMessage() {
  if (!currentActiveTicketId) return;
  const input = document.getElementById('chatMessageInput');
  const text = (input?.value || '').trim();
  if (!text) return;

  input.value = '';
  try {
    const res = await fetch(`/api/support/tickets/${currentActiveTicketId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'USER',
        senderName: currentUser.name || 'Parth Sharma',
        text: text
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to send message');

    if (data.ticket) {
      renderTicketChat(data.ticket);
      // update in cache
      const idx = userCachedTickets.findIndex(t => t.id === currentActiveTicketId);
      if (idx >= 0) userCachedTickets[idx] = data.ticket;
    }
  } catch (err) {
    alert('Failed to send message: ' + err.message);
  }
}

async function pollActiveChat() {
  const modal = document.getElementById('helpSupportModal');
  const chatView = document.getElementById('supportChatView');
  if (!modal || !modal.classList.contains('active') || !chatView || chatView.style.display === 'none') return;
  if (!currentActiveTicketId) return;

  try {
    const res = await fetch(`/api/support/tickets/${currentActiveTicketId}`);
    if (!res.ok) return;
    const ticket = await res.json();
    if (ticket && ticket.id === currentActiveTicketId) {
      renderTicketChat(ticket);
    }
  } catch (e) {
    // quiet polling
  }
}


// =========================================================================
// GOOGLE IDENTITY SERVICES & AUTHENTICATION INTEGRATION
// =========================================================================

function updateUserNavIdentity() {
  const container = document.getElementById('navAuthContainer');
  if (!container) return;

  if (isUserLoggedIn()) {
    const isAdmin = Boolean(currentUser.email && currentUser.email.toLowerCase() === 'parthgulyani7960@gmail.com' || currentUser.isAdmin || currentUser.role === 'ADMIN');
    container.innerHTML = `
      ${isAdmin ? `
        <a href="/admin" class="nav-admin-btn" title="Open Administrator Control Console" style="background: linear-gradient(135deg, #0f172a, #1e293b); color: #38bdf8; border: 1.5px solid #0284c7; padding: 6px 14px; border-radius: 20px; font-weight: 800; font-size: 12px; text-decoration: none; display: flex; align-items: center; gap: 6px; box-shadow: 0 0 10px rgba(56,189,248,0.25); transition: all 0.2s;">
          <span>⚙️</span> <span>Admin Console</span>
        </a>
      ` : ''}
      <div class="user-identity-btn" id="userIdentityBtn" onclick="openUserProfileModal()" title="View Profile, Wallet & Saved Addresses" style="display: flex; align-items: center; gap: 8px; cursor: pointer; background: white; border: 1.5px solid var(--gray-300); padding: 5px 12px; border-radius: 20px; transition: all 0.2s;">
        <img src="${currentUser.picture || 'https://lh3.googleusercontent.com/a/default-user=s96-c'}" id="userAvatar" class="user-avatar" alt="User" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">
        <span class="user-name" id="userNameLabel" style="font-weight: 800; font-size: 13px; color: #0f172a;">${currentUser.name || 'User'}</span>
      </div>
      <button type="button" class="nav-btn-logout" onclick="signOutUser()" title="Log Out" style="background: #fef2f2; border: 1.5px solid #fecaca; color: #dc2626; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;">
        <span>🚪</span> <span>Log Out</span>
      </button>
    `;
    const mbLabel = document.getElementById('mbNavAccountLabel');
    if (mbLabel) mbLabel.innerText = (currentUser.name || 'Account').split(' ')[0];
  } else {
    container.innerHTML = `
      <button class="nav-btn-google-auth" id="btnNavGoogleSignIn" onclick="openGoogleAuthModal()" title="Sign In or Register with Google" style="background: white; border: 1.5px solid #4285f4; color: #1e3a8a; padding: 7px 16px; border-radius: 20px; font-size: 13px; font-weight: 800; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 2px 8px rgba(66, 133, 244, 0.2); transition: all 0.2s;">
        <svg width="18" height="18" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        <span>Sign In with Google</span>
      </button>
    `;
    const mbLabel = document.getElementById('mbNavAccountLabel');
    if (mbLabel) mbLabel.innerText = 'Sign In';
  }
}
window.updateUserNavIdentity = updateUserNavIdentity;

let firebaseClientConfig = {
  apiKey: "AIzaSyCPhTQI-DyKl-k9_5FAVbINqSfuo1JLxDc",
  authDomain: "dominos-order-engine-final.firebaseapp.com",
  projectId: "dominos-order-engine-final",
  storageBucket: "dominos-order-engine-final.firebasestorage.app",
  messagingSenderId: "80843429271",
  appId: "1:80843429271:web:89125c80af82d1c81f60d2",
  measurementId: "G-WCWEPQG2XC"
};
let isFirebaseInitialized = false;

async function initFirebaseClient() {
  if (isFirebaseInitialized && firebase.apps.length) return;
  try {
    let config = firebaseClientConfig;
    try {
      const res = await fetch('/api/firebase/config');
      if (res.ok) {
        const fetched = await res.json();
        if (fetched && fetched.apiKey) config = { ...config, ...fetched };
      }
    } catch (_) {}

    firebaseClientConfig = config;

    if (config && config.apiKey && window.firebase) {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      isFirebaseInitialized = true;
      console.log('[FIREBASE] Client SDK initialized for project:', config.projectId);
    }
  } catch (e) {
    console.warn('[FIREBASE] Client init notice:', e.message);
  }
}

function initGoogleAuth() {
  initFirebaseClient().catch(() => {});
  if (window.google && window.google.accounts && window.google.accounts.id) {
    try {
      window.google.accounts.id.initialize({
        client_id: '948271035824-dominos-engine.apps.googleusercontent.com',
        callback: handleGoogleCredentialResponse,
        auto_select: false
      });
      const btnEl = document.getElementById('googleBtnContainer');
      if (btnEl) {
        window.google.accounts.id.renderButton(btnEl, {
          theme: 'outline',
          size: 'large',
          width: 280,
          text: 'signin_with',
          shape: 'pill'
        });
      }
    } catch (e) {
      console.warn('Google GIS init note:', e.message);
    }
  }
}

async function handleContinueWithGoogle() {
  await initFirebaseClient();

  // 1. If Firebase Client SDK is initialized with user config, execute Firebase Google Popup
  if (isFirebaseInitialized && window.firebase && window.firebase.auth) {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('email');
      provider.addScope('profile');
      const result = await firebase.auth().signInWithPopup(provider);
      if (result && result.user) {
        const u = result.user;
        const idToken = await u.getIdToken();
        const res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credential: idToken,
            firebaseUser: {
              uid: u.uid,
              email: u.email,
              displayName: u.displayName || 'Google User',
              photoURL: u.photoURL || 'https://lh3.googleusercontent.com/a/default-user=s96-c'
            }
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Authentication rejected by server');

        currentUser = { ...GUEST_USER, ...data.user, isGuest: false };
        localStorage.setItem('dominos_user', JSON.stringify(currentUser));
        updateUserNavIdentity();
        closeModal('googleAuthModal');
        showToastNotice(`Welcome, ${currentUser.name}! Signed in via Firebase Google Auth.`, '🎉');
        loadUserProfile();
        return;
      }
    } catch (fbErr) {
      console.warn('[FIREBASE] Google Popup notice:', fbErr.message);
      if (fbErr.code === 'auth/popup-closed-by-user') return;
      // Fall through to GIS / direct prompt if popup closed
    }
  }

  // 2. Fallback to GIS (Google Identity Services)
  if (window.google && window.google.accounts && window.google.accounts.id) {
    try {
      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          console.log('Google prompt note:', notification.getNotDisplayedReason?.() || notification.getSkippedReason?.());
        }
      });
    } catch (e) {
      console.warn('GIS prompt error:', e);
    }
  }

  // Check if native GIS button exists inside container and click it
  const gisBtn = document.querySelector('#googleBtnContainer div[role="button"]');
  if (gisBtn) {
    gisBtn.click();
    return;
  }

  // 3. Direct seamless Google Account Sign-In (Zero OTP / Zero Passwords)
  const email = prompt('Sign In with Google\n\nEnter your Google Account email (e.g. yourname@gmail.com):');
  if (!email || !email.includes('@')) {
    if (email) alert('Please enter a valid Google Account email address.');
    return;
  }

  const nameParts = email.split('@')[0].split(/[._-]/);
  const guessedName = nameParts.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') || 'Google User';
  await signInWithDeviceGoogleAccount(email.trim(), guessedName, 'https://lh3.googleusercontent.com/a/default-user=s96-c');
}
async function submitModalGoogleEmail() {
  const input = document.getElementById('modalGoogleEmailInput');
  const email = (input?.value || '').trim();
  if (!email || !email.includes('@')) {
    alert('Please enter a valid Google Account email address (e.g. yourname@gmail.com).');
    return;
  }
  const nameParts = email.split('@')[0].split(/[._-]/);
  const guessedName = nameParts.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') || 'Google User';
  await signInWithDeviceGoogleAccount(email, guessedName, 'https://lh3.googleusercontent.com/a/default-user=s96-c');
}
window.submitModalGoogleEmail = submitModalGoogleEmail;
window.handleContinueWithGoogle = handleContinueWithGoogle;
window.triggerDeviceGoogleLogin = handleContinueWithGoogle;
window.promptAddGoogleAccount = handleContinueWithGoogle;

async function handleGoogleCredentialResponse(response) {
  if (!response || !response.credential) return;
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentUser = { ...GUEST_USER, ...data.user, isGuest: false };
    if (data.isAdmin || (currentUser.email && currentUser.email.toLowerCase() === 'parthgulyani7960@gmail.com')) {
      currentUser.isAdmin = true;
      currentUser.role = 'ADMIN';
      if (data.adminToken) {
        sessionStorage.setItem('dom_admin_token', data.adminToken);
      }
    }
    localStorage.setItem('dominos_user', JSON.stringify(currentUser));
    saveKnownGoogleAccount(currentUser);
    updateUserNavIdentity();
    closeModal('googleAuthModal');
    showToastNotice(`Welcome, ${currentUser.name}! Signed in successfully.`, '🎉');
    loadUserProfile();
  } catch (err) {
    alert('Google sign-in error: ' + err.message);
  }
}

async function signInWithDeviceGoogleAccount(email, name, picture) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userInfo: { email, name, picture } })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentUser = { ...GUEST_USER, ...data.user, isGuest: false };
    if (data.isAdmin || (currentUser.email && currentUser.email.toLowerCase() === 'parthgulyani7960@gmail.com')) {
      currentUser.isAdmin = true;
      currentUser.role = 'ADMIN';
      if (data.adminToken) {
        sessionStorage.setItem('dom_admin_token', data.adminToken);
      }
    }
    localStorage.setItem('dominos_user', JSON.stringify(currentUser));
    saveKnownGoogleAccount(currentUser);
    updateUserNavIdentity();
    closeModal('googleAuthModal');
    showToastNotice(`Welcome, ${currentUser.name}! Signed in with Google.`, '🎉');
    loadUserProfile();
  } catch (err) {
    alert('Google Sign-In failed: ' + err.message);
  }
}
window.signInWithDeviceGoogleAccount = signInWithDeviceGoogleAccount;

function saveKnownGoogleAccount(user) {
  if (!user || !user.email) return;
  try {
    let list = [];
    const raw = localStorage.getItem('dominos_known_google_accounts');
    if (raw) list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
    const idx = list.findIndex(a => a.email.toLowerCase() === user.email.toLowerCase());
    const item = {
      name: user.name || 'Google User',
      email: user.email,
      picture: user.picture || 'https://lh3.googleusercontent.com/a/default-user=s96-c'
    };
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.unshift(item);
    }
    localStorage.setItem('dominos_known_google_accounts', JSON.stringify(list.slice(0, 5)));
  } catch (e) {}
}

function openGoogleAuthModal() {
  openModal('googleAuthModal');
  initGoogleAuth();
}
window.openGoogleAuthModal = openGoogleAuthModal;

function signOutUser() {
  if (!confirm('Are you sure you want to log out of your Domino\'s Order Engine account?')) {
    return;
  }
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('dominos_user');
  sessionStorage.removeItem('dom_admin_token');
  currentUser = { ...GUEST_USER };
  updateUserNavIdentity();
  closeModal('userProfileModal');
  showToastNotice('Signed out from Domino\'s Order Engine', '🚪');
  loadUserProfile();
}
window.signOutUser = signOutUser;

function showSystemInfo(topic) {
  const infoMap = {
    overview: {
      title: '🍕 Domino\'s Order Engine Overview',
      body: 'Domino\'s Order Engine connects directly to authentic Domino\'s Pizza India kitchen dispatch systems. It provides real-time live GPS store locking, 100% verified Domino\'s discounts (50% OFF, Cheesy, Party tiers), instant UPI payments, and autonomous order placement.'
    },
    gps: {
      title: '📡 Domino\'s GPS Kitchen Lock (MANDATORY)',
      body: 'Domino\'s systems strictly require device geolocation coordinates (Latitude and Longitude) to identify your nearest oven. Real-time store availability, delivery radius validation, and 20-minute delivery guarantees depend on exact GPS coordinates.'
    },
    wallet: {
      title: '💰 Domino\'s Order Engine Digital Wallet',
      body: 'Your wallet is isolated and secured to your Google profile identity. Minimum deposit is ₹50 via instant dynamic UPI QR or direct UPI intent app. Withdrawals are disabled as funds are strictly reserved for ordering Domino\'s pizzas.'
    },
    tier: {
      title: '🏷️ Domino\'s Account Tier & Voucher Engine',
      body: 'Accounts are categorized into tiers: New accounts (0 past orders) unlock 50% OFF (NEWBIE100 / DOMNEW50). Second-order accounts receive Tier 2 discounts (CHEESY). Accounts with 2+ orders receive party bundle vouchers (PARTY).'
    }
  };

  const item = infoMap[topic] || {
    title: 'ℹ️ Domino\'s Order Engine Information',
    body: 'Automated Domino\'s ordering platform with real-time kitchen tracking.'
  };

  alert(`${item.title}\n\n${item.body}`);
}
window.showSystemInfo = showSystemInfo;

// Mobile navigation and touch interaction helpers
function scrollToMenu() {
  const el = document.getElementById('menuSection') || document.querySelector('.tabs-container');
  if (el) {
    const yOffset = -70;
    const y = el.getBoundingClientRect().top + window.pageYOffset + yOffset;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
}
window.scrollToMenu = scrollToMenu;

function focusSearchInput() {
  const el = document.getElementById('menuSearchInput');
  if (el) {
    const yOffset = -80;
    const y = el.getBoundingClientRect().top + window.pageYOffset + yOffset;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    setTimeout(() => {
      try { el.focus(); } catch (e) {}
    }, 250);
  }
}
window.focusSearchInput = focusSearchInput;

function handleMobileAccountClick() {
  if (isUserLoggedIn()) {
    openUserProfileModal();
  } else {
    openGoogleAuthModal();
  }
}
window.handleMobileAccountClick = handleMobileAccountClick;
