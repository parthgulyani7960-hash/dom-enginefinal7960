const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'store.json');
const BACKUP_FILE = path.join(__dirname, '..', 'data', 'store.json.backup');

// Generate 12-digit random unique numerical User ID for Domino's Order Engine platform
function generate12DigitUid() {
  return Math.floor(100000000000 + Math.random() * 900000000000).toString();
}

const INITIAL_DATA = {
  accounts: [],
  couponRules: {
    firstOrderCoupon: 'DOMNEW50',
    firstOrderDiscount: 100,
    secondOrderCoupon: 'CHEESY',
    secondOrderDiscount: 50,
    regularOrderCoupon: 'PARTY',
    regularOrderDiscount: 100,
    fallbackCoupon: 'DOMNEW30',
    fallbackDiscount: 80
  },
  paymentSettings: {
    upiId: 'dominos.pay@okhdfcbank',
    payeeName: "Domino's Official Kitchen Outlet",
    merchantCode: 'DOM-5819',
    note: "Domino's Order Payment"
  },
  vouchers: [
    {
      id: 'VOUCH-501',
      code: '6014829301928471', // 16-digit voucher
      pin: '839201',             // 6-digit PIN
      balance: 1000,
      initialBalance: 1000,
      status: 'UNUSED',          // UNUSED, PARTIALLY_USED, EXHAUSTED
      usedInOrderId: null
    },
    {
      id: 'VOUCH-502',
      code: '6014992100481239',
      pin: '517290',
      balance: 1500,
      initialBalance: 1500,
      status: 'UNUSED',
      usedInOrderId: null
    },
    {
      id: 'VOUCH-503',
      code: '6014381029471182',
      pin: '394812',
      balance: 800,
      initialBalance: 800,
      status: 'UNUSED',
      usedInOrderId: null
    }
  ],
  combos: [
    {
      id: 'COMBO-1',
      name: 'Double Treat Veg Extravaganza',
      tag: '🔥 Bestseller Combo',
      badge: 'Save ₹160',
      price: 549,
      originalPrice: 709,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      description: '1 Medium Farmhouse Pizza + 1 Regular Peppy Paneer + 1 Stuffed Garlic Bread + 2x 250ml Coke',
      includedItems: [
        { name: 'Farmhouse Pizza (Medium)', dominosCode: 'PIZ0119', qty: 1 },
        { name: 'Peppy Paneer (Regular)', dominosCode: 'PIZ0120', qty: 1 },
        { name: 'Stuffed Garlic Bread', dominosCode: 'SID0046', qty: 1 },
        { name: 'Coca-Cola 250ml', dominosCode: 'BEV-COKE-250', qty: 2 }
      ]
    },
    {
      id: 'COMBO-2',
      name: 'Carnivore Non-Veg Feast',
      tag: '🍗 Non-Veg Special',
      badge: 'Save ₹220',
      price: 699,
      originalPrice: 919,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/893ad735-bc90-40b9-83c9-5cebfc876508_new_chicken_golden_delight.webp',
      description: '1 Medium Chicken Golden Delight + 1 Regular Barbeque Chicken + 1 Cheesy Dip + 2x 250ml Coke',
      includedItems: [
        { name: 'Chicken Golden Delight (Medium)', dominosCode: 'PIZ0125', qty: 1 },
        { name: 'Barbeque Chicken Pizza (Regular)', dominosCode: 'PIZ0124', qty: 1 },
        { name: 'Cheesy Jalapeno Dip', dominosCode: 'SID0010', qty: 1 },
        { name: 'Coca-Cola 250ml', dominosCode: 'BEV-COKE-250', qty: 2 }
      ]
    },
    {
      id: 'COMBO-3',
      name: 'Late Night Midnight Cravings',
      tag: '🌙 Solo Combo',
      badge: 'Save ₹90',
      price: 389,
      originalPrice: 479,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/1f7ddf95-d357-4d61-8ab0-b0bafbeedad1_ChocoLavaCakeHomeProductV1.webp',
      description: '1 Regular Margherita with Cheese Burst Crust + 1 Choco Lava Cake + 1 Thums Up',
      includedItems: [
        { name: 'Margherita (Regular, Cheese Burst)', dominosCode: 'PIZ0117', qty: 1 },
        { name: 'Choco Lava Cake', dominosCode: 'DES0001', qty: 1 },
        { name: 'Thums Up 250ml', dominosCode: 'BEV-THUM-250', qty: 1 }
      ]
    },
    {
      id: 'COMBO-4',
      name: 'Party Squad 4-Pizza Mania Box',
      tag: '🎉 Mega Party',
      badge: 'Save ₹250',
      price: 599,
      originalPrice: 849,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/67b5ed83-ed05-4097-a909-cc3b0d0679f6_pizza_mania_veg_loaded.webp',
      description: '4x Regular Pizzas (Capsicum, Golden Corn, Onion, Veg Loaded) + 1 Garlic Breadsticks + 1.25L Cold Drink',
      includedItems: [
        { name: 'Capsicum Mania Pizza', dominosCode: 'PIZ0232', qty: 1 },
        { name: 'Golden Corn Mania Pizza', dominosCode: 'PIZ0130', qty: 1 },
        { name: 'Onion Mania Pizza', dominosCode: 'PIZ0129', qty: 1 },
        { name: 'Veg Loaded Pizza', dominosCode: 'PIZ0140', qty: 1 },
        { name: 'Garlic Breadsticks', dominosCode: 'SID0001', qty: 1 },
        { name: 'Coca-Cola 1.25L Bottle', dominosCode: 'BEV-COKE-125', qty: 1 }
      ]
    }
  ],
  menu: [
    {
      id: 'ITEM-1',
      name: 'Farmhouse Pizza',
      category: 'Veg Pizza',
      type: 'VEG',
      price: 269,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
      description: 'Delightful combination of onion, capsicum, tomato & grilled mushroom.',
      dominosCode: 'PIZ0119'
    },
    {
      id: 'ITEM-2',
      name: 'Peppy Paneer Pizza',
      category: 'Veg Pizza',
      type: 'VEG',
      price: 279,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/0b41b2cb-958c-4c17-b0b2-397308538684_volcanoHomePeppyPaneer.webp',
      description: 'Chunky paneer with crisp capsicum and spicy red pepper.',
      dominosCode: 'PIZ0120'
    },
    {
      id: 'ITEM-3',
      name: 'Veggie Paradise',
      category: 'Veg Pizza',
      type: 'VEG',
      price: 259,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/391142c2-055c-4214-b06a-c2005c5f9768_new_veggie_paradise.webp',
      description: 'Golden Corn, Black Olives, Capsicum & Red Paprika.',
      dominosCode: 'PIZ0121'
    },
    {
      id: 'ITEM-4',
      name: 'Chicken Dominator',
      category: 'Non-Veg Pizza',
      type: 'NON-VEG',
      price: 369,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/b8c12238-5779-496e-a233-dc1af1d14b81_new_chicken_dominator.webp',
      description: 'Loaded with double pepper barbecue chicken, peri-peri chicken, chicken tikka.',
      dominosCode: 'PIZ0126'
    },
    {
      id: 'ITEM-5',
      name: 'Chicken Golden Delight',
      category: 'Non-Veg Pizza',
      type: 'NON-VEG',
      price: 329,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/893ad735-bc90-40b9-83c9-5cebfc876508_new_chicken_golden_delight.webp',
      description: 'Barbeque chicken with a topping of golden corn loaded with extra cheese.',
      dominosCode: 'PIZ0125'
    },
    {
      id: 'ITEM-6',
      name: 'Stuffed Garlic Bread',
      category: 'Garlic Breads & Sides',
      type: 'VEG',
      price: 149,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/d8fef862-36b4-4e50-a5dc-8af4bbf1ab71_FullsizeGarlicBreadwithcornFiery.webp',
      description: 'Freshly baked garlic bread stuffed with mozzarella cheese, sweet corn and tangy jalapenos.',
      dominosCode: 'SID0046'
    },
    {
      id: 'ITEM-7',
      name: 'Choco Lava Cake',
      category: 'Desserts',
      type: 'VEG',
      price: 109,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/1f7ddf95-d357-4d61-8ab0-b0bafbeedad1_ChocoLavaCakeHomeProductV1.webp',
      description: 'Chocolate lovers delight! Indulgent, gooey molten lava inside chocolate cake.',
      dominosCode: 'DES0001'
    },
    {
      id: 'ITEM-8',
      name: 'Coca-Cola 475ml',
      category: 'Beverages',
      type: 'VEG',
      price: 60,
      image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/c75f77f0-987b-45df-b976-12be349df9dc_CokeHomeProductV1.webp',
      description: 'Sparkling refreshing beverage bottle 475ml.',
      dominosCode: 'BEV-COKE-475'
    }
  ],
  dominosRegisteredPhones: [
    {
      phone: '+91 7888402429',
      cleanPhone: '7888402429',
      isDominoRegistered: true,
      autoCoupon: 'PARTY',
      couponCode: 'PARTY',
      accountType: 'EXISTING_ACCOUNT',
      categoryName: '🔵 Party Repeat Order Tier',
      customerName: "Parth (Verified Domino's Customer)",
      lastCheckedAt: '2026-11-01T12:00:00.000Z',
      source: 'DOMINOS_LIVE_NXG_PROBE'
    },
    {
      phone: '+91 7888422429',
      cleanPhone: '7888422429',
      isDominoRegistered: true,
      autoCoupon: 'PARTY',
      couponCode: 'PARTY',
      accountType: 'EXISTING_ACCOUNT',
      categoryName: '🔵 Party Repeat Order Tier',
      customerName: "Parth (Verified Domino's Customer)",
      lastCheckedAt: '2026-11-01T12:00:00.000Z',
      source: 'DOMINOS_LIVE_NXG_PROBE'
    }
  ],
  orders: []
};

class Database {
  constructor() {
    this.data = INITIAL_DATA;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.couponRules) {
          this.data.couponRules = INITIAL_DATA.couponRules;
        }
        if (!this.data.paymentSettings) {
          this.data.paymentSettings = INITIAL_DATA.paymentSettings;
        }
        if (this.data.userProfile && !this.data.userProfile.userId12) {
          this.data.userProfile.userId12 = generate12DigitUid();
        }
        if (Array.isArray(this.data.users)) {
          this.data.users.forEach(u => {
            if (!u.userId12) u.userId12 = generate12DigitUid();
            if (!u.transactions) u.transactions = [];
          });
        }
        if (!Array.isArray(this.data.walletDeposits)) {
          this.data.walletDeposits = [];
        }
        if (!Array.isArray(this.data.walletWithdrawals)) {
          this.data.walletWithdrawals = [];
        }
        let needsSave = false;
        if (!Array.isArray(this.data.announcements)) {
          this.data.announcements = [];
        }
        if (!Array.isArray(this.data.dominosRegisteredPhones)) {
          this.data.dominosRegisteredPhones = [];
        }
        // Pre-seed known Domino's India registered phones (such as 7888402429 / 7888422429)
        const seedPhones = ['7888402429', '7888422429'];
        for (const sp of seedPhones) {
          if (!this.data.dominosRegisteredPhones.some(p => p.cleanPhone === sp)) {
            this.data.dominosRegisteredPhones.push({
              phone: `+91 ${sp}`,
              cleanPhone: sp,
              isDominoRegistered: true,
              autoCoupon: 'PARTY',
              couponCode: 'PARTY',
              accountType: 'EXISTING_ACCOUNT',
              categoryName: '🔵 Party Repeat Order Tier',
              customerName: "Parth (Verified Domino's Customer)",
              lastCheckedAt: new Date().toISOString(),
              source: 'DOMINOS_LIVE_NXG_PROBE'
            });
            needsSave = true;
          }
        }
        // Migrate legacy Unsplash URLs to authentic Domino's CDN images
        if (Array.isArray(this.data.combos)) {
          this.data.combos.forEach((c, idx) => {
            if (!c.image || c.image.includes('unsplash.com')) {
              c.image = INITIAL_DATA.combos[idx]?.image || INITIAL_DATA.combos[0].image;
              needsSave = true;
            }
          });
        }
        if (Array.isArray(this.data.menu)) {
          this.data.menu.forEach((m, idx) => {
            if (!m.image || m.image.includes('unsplash.com')) {
              m.image = INITIAL_DATA.menu[idx]?.image || INITIAL_DATA.menu[0].image;
              needsSave = true;
            }
          });
        }
        if (needsSave) {
          this.save();
        }
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[DB] Error loading database file:', err.message);
      // Attempt recovery from rolling backup file to prevent account data loss
      if (fs.existsSync(BACKUP_FILE)) {
        try {
          console.log('[DB] 🔄 Recovering account data from rolling backup store.json.backup...');
          const backupRaw = fs.readFileSync(BACKUP_FILE, 'utf-8');
          this.data = JSON.parse(backupRaw);
          console.log('[DB] ✅ Account database successfully recovered from backup.');
          return;
        } catch (bkErr) {
          console.error('[DB] Backup recovery failed:', bkErr.message);
        }
      }
      this.data = INITIAL_DATA;
      this.save();
    }
  }

  save() {
    try {
      // 1. Maintain rolling backup before overwrite to guarantee accounts are never lost
      if (fs.existsSync(DATA_FILE)) {
        try {
          fs.copyFileSync(DATA_FILE, BACKUP_FILE);
        } catch (e) {}
      }
      // 2. Atomic write via temporary file
      const tmpFile = DATA_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (err) {
      console.error('[DB] Error saving database file:', err.message);
      // Fallback direct write if rename failed
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch (directErr) {
        console.error('[DB] Direct write failed:', directErr.message);
      }
    }

    // 3. Asynchronously sync to Firebase Cloud if enabled
    try {
      if (this.firebaseService) {
        this.firebaseService.syncAllToCloud(this.data).catch(() => {});
      }
    } catch (e) {}
  }

  setFirebaseService(service) {
    this.firebaseService = service;
  }

  mergeCloudData(cloudData) {
    if (!cloudData || typeof cloudData !== 'object') return;
    console.log('[DB] ☁️ Merging cloud records from Firebase Realtime Database...');

    // 1. Merge accounts (Respect deleted tombstone IDs)
    if (Array.isArray(cloudData.accounts) && cloudData.accounts.length > 0) {
      if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
      const deletedIds = new Set(this.data.deletedAccountIds || []);
      for (const cloudAcc of cloudData.accounts) {
        if (!cloudAcc || !cloudAcc.id) continue;
        if (deletedIds.has(cloudAcc.id) || (cloudAcc.cleanPhone && deletedIds.has(cloudAcc.cleanPhone))) {
          continue; // Account was deleted by admin - do not resurrect from cloud
        }
        const localIdx = this.data.accounts.findIndex(a => a.id === cloudAcc.id || (cloudAcc.cleanPhone && a.cleanPhone === cloudAcc.cleanPhone));
        if (localIdx < 0) {
          this.data.accounts.push(cloudAcc);
        } else {
          // Merge tokens and credentials if cloud has newer refresh
          const localAcc = this.data.accounts[localIdx];
          if (cloudAcc.lastRefreshedAt && (!localAcc.lastRefreshedAt || cloudAcc.lastRefreshedAt > localAcc.lastRefreshedAt)) {
            this.data.accounts[localIdx] = { ...localAcc, ...cloudAcc };
          }
        }
      }
    }

    // 2. Merge users & customer delivery addresses (Respect deleted user IDs)
    if (Array.isArray(cloudData.users) && cloudData.users.length > 0) {
      if (!Array.isArray(this.data.users)) this.data.users = [];
      const deletedUids = new Set(this.data.deletedUserIds || []);
      for (const cloudUser of cloudData.users) {
        if (!cloudUser || !cloudUser.id) continue;
        if (deletedUids.has(cloudUser.id) || (cloudUser.userId12 && deletedUids.has(cloudUser.userId12)) || (cloudUser.email && deletedUids.has(cloudUser.email.toLowerCase()))) {
          continue; // User was deleted by admin - do not resurrect from cloud
        }
        const localIdx = this.data.users.findIndex(u => u.id === cloudUser.id || (cloudUser.email && u.email === cloudUser.email));
        if (localIdx < 0) {
          this.data.users.push(cloudUser);
        } else {
          // Merge savedAddresses so customer addresses are never lost
          const localUser = this.data.users[localIdx];
          const cloudAddrs = Array.isArray(cloudUser.savedAddresses) ? cloudUser.savedAddresses : [];
          const localAddrs = Array.isArray(localUser.savedAddresses) ? localUser.savedAddresses : [];
          const mergedAddrs = [...localAddrs];
          for (const ca of cloudAddrs) {
            if (ca && !mergedAddrs.some(la => la.id === ca.id || (la.flat === ca.flat && la.street === ca.street))) {
              mergedAddrs.push(ca);
            }
          }
          this.data.users[localIdx] = {
            ...cloudUser,
            ...localUser,
            savedAddresses: mergedAddrs,
            wallet: localUser.wallet || cloudUser.wallet || { balance: 0, currency: 'INR' }
          };
        }
      }
    }

    // 3. Merge userProfile & default customer addresses
    if (cloudData.userProfile && typeof cloudData.userProfile === 'object') {
      if (!this.data.userProfile) this.data.userProfile = {};
      const cloudAddrs = Array.isArray(cloudData.userProfile.savedAddresses) ? cloudData.userProfile.savedAddresses : [];
      const localAddrs = Array.isArray(this.data.userProfile.savedAddresses) ? this.data.userProfile.savedAddresses : [];
      const mergedAddrs = [...localAddrs];
      for (const ca of cloudAddrs) {
        if (ca && !mergedAddrs.some(la => la.id === ca.id || (la.flat === ca.flat && la.street === ca.street))) {
          mergedAddrs.push(ca);
        }
      }
      this.data.userProfile = {
        ...cloudData.userProfile,
        ...this.data.userProfile,
        savedAddresses: mergedAddrs
      };
    }

    // 4. Merge vouchers
    if (Array.isArray(cloudData.vouchers) && cloudData.vouchers.length > 0) {
      if (!Array.isArray(this.data.vouchers)) this.data.vouchers = [];
      for (const cloudVouch of cloudData.vouchers) {
        if (!cloudVouch || !cloudVouch.code) continue;
        const localIdx = this.data.vouchers.findIndex(v => v.code === cloudVouch.code);
        if (localIdx < 0) {
          this.data.vouchers.push(cloudVouch);
        }
      }
    }

    // 5. Merge orders
    if (Array.isArray(cloudData.orders) && cloudData.orders.length > 0) {
      if (!Array.isArray(this.data.orders)) this.data.orders = [];
      for (const cloudOrd of cloudData.orders) {
        if (!cloudOrd || !cloudOrd.id) continue;
        const localIdx = this.data.orders.findIndex(o => o.id === cloudOrd.id);
        if (localIdx < 0) {
          this.data.orders.push(cloudOrd);
        }
      }
    }

    // 6. Merge wallet deposits
    if (Array.isArray(cloudData.walletDeposits) && cloudData.walletDeposits.length > 0) {
      if (!Array.isArray(this.data.walletDeposits)) this.data.walletDeposits = [];
      for (const dep of cloudData.walletDeposits) {
        if (!dep || (!dep.id && !dep.reference)) continue;
        const localIdx = this.data.walletDeposits.findIndex(d => (dep.id && d.id === dep.id) || (dep.reference && d.reference === dep.reference));
        if (localIdx < 0) {
          this.data.walletDeposits.push(dep);
        }
      }
    }

    // 7. Merge support tickets & live admin chats
    if (Array.isArray(cloudData.tickets) && cloudData.tickets.length > 0) {
      if (!Array.isArray(this.data.tickets)) this.data.tickets = [];
      for (const t of cloudData.tickets) {
        if (!t || !t.id) continue;
        const localIdx = this.data.tickets.findIndex(lt => lt.id === t.id);
        if (localIdx < 0) {
          this.data.tickets.push(t);
        }
      }
    }

    // 8. Merge menu items (if cloud has customized prices or items)
    if (Array.isArray(cloudData.menu) && cloudData.menu.length > 0) {
      if (!Array.isArray(this.data.menu) || this.data.menu.length === 0) {
        this.data.menu = cloudData.menu;
      } else {
        for (const cloudItem of cloudData.menu) {
          if (!cloudItem || (!cloudItem.id && !cloudItem.dominosCode)) continue;
          const localItem = this.data.menu.find(m => (cloudItem.id && m.id === cloudItem.id) || (cloudItem.dominosCode && m.dominosCode === cloudItem.dominosCode));
          if (localItem && cloudItem.price && cloudItem.price !== localItem.price) {
            localItem.price = cloudItem.price;
          }
        }
      }
    }

    // 9. Merge combos
    if (Array.isArray(cloudData.combos) && cloudData.combos.length > 0) {
      if (!Array.isArray(this.data.combos) || this.data.combos.length === 0) {
        this.data.combos = cloudData.combos;
      }
    }

    // 10. Merge coupon rules & payment settings & maintenance mode
    if (cloudData.couponRules && typeof cloudData.couponRules === 'object') {
      this.data.couponRules = { ...this.data.couponRules, ...cloudData.couponRules };
    }
    if (cloudData.paymentSettings && typeof cloudData.paymentSettings === 'object') {
      this.data.paymentSettings = { ...this.data.paymentSettings, ...cloudData.paymentSettings };
    }
    if (cloudData.maintenanceMode && typeof cloudData.maintenanceMode === 'object') {
      this.data.maintenanceMode = { ...this.data.maintenanceMode, ...cloudData.maintenanceMode };
    }

    this.save();
    console.log(`[DB] ✅ Full cloud data merged: ${this.data.accounts.length} accounts, ${this.data.users.length} users, ${this.data.orders.length} orders, ${this.data.vouchers.length} vouchers, ${this.data.menu.length} menu items in pool.`);
  }

  // Account Management
  getAccounts() {
    return this.data.accounts;
  }

  getAccountById(id) {
    if (!id) return null;
    return this.data.accounts.find(a => a.id === id || a.cleanPhone === id || a.phone?.includes(id)) || null;
  }

  addAccount(account) {
    this.data.accounts.push(account);
    this.save();
    return account;
  }

  deleteAccount(id) {
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    const idStr = String(id || '').trim();
    const cleanDigits = idStr.replace(/[^0-9]/g, '').slice(-10);

    const accountsToDelete = this.data.accounts.filter(a => {
      if (a.id === idStr) return true;
      if (cleanDigits && cleanDigits.length === 10) {
        if (a.cleanPhone === cleanDigits) return true;
        const p = (a.phone || '').replace(/[^0-9]/g, '').slice(-10);
        if (p === cleanDigits) return true;
      }
      if (a.sessionToken === idStr || a.userId === idStr) return true;
      return false;
    });

    this.data.accounts = this.data.accounts.filter(a => !accountsToDelete.includes(a));
    
    // Tombstone all deleted identifiers so they are never re-pulled from cloud merge
    if (!Array.isArray(this.data.deletedAccountIds)) {
      this.data.deletedAccountIds = [];
    }
    if (!this.data.deletedAccountIds.includes(idStr)) {
      this.data.deletedAccountIds.push(idStr);
    }
    if (cleanDigits && cleanDigits.length === 10 && !this.data.deletedAccountIds.includes(cleanDigits)) {
      this.data.deletedAccountIds.push(cleanDigits);
    }
    accountsToDelete.forEach(acc => {
      if (acc.id && !this.data.deletedAccountIds.includes(acc.id)) this.data.deletedAccountIds.push(acc.id);
      if (acc.cleanPhone && !this.data.deletedAccountIds.includes(acc.cleanPhone)) this.data.deletedAccountIds.push(acc.cleanPhone);
      const cp = (acc.phone || '').replace(/[^0-9]/g, '').slice(-10);
      if (cp && cp.length === 10 && !this.data.deletedAccountIds.includes(cp)) this.data.deletedAccountIds.push(cp);
    });
    this.save();

    // Explicitly delete/update accounts and deletedAccountIds in Firebase Cloud immediately
    if (this.firebaseService) {
      if (this.firebaseService.rtdbInstance) {
        try {
          const cleanAccounts = this.firebaseService.sanitizeForFirebase(this.data.accounts);
          this.firebaseService.rtdbInstance.ref('dominos_order_engine/accounts').set(cleanAccounts).catch(() => {});
          this.firebaseService.rtdbInstance.ref('dominos_order_engine/deletedAccountIds').set(this.data.deletedAccountIds).catch(() => {});
        } catch (_) {}
      } else {
        const baseUrl = this.firebaseService.getRtdbBaseUrl();
        if (baseUrl) {
          const cleanAccounts = this.firebaseService.sanitizeForFirebase(this.data.accounts);
          this.firebaseService.httpsRequest(`${baseUrl}/dominos_order_engine/accounts.json`, 'PUT', cleanAccounts).catch(() => {});
          this.firebaseService.httpsRequest(`${baseUrl}/dominos_order_engine/deletedAccountIds.json`, 'PUT', this.data.deletedAccountIds).catch(() => {});
        }
      }
    }
    return true;
  }

  getDominosRegistrationStatus(phone) {
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (!cleanPhone || cleanPhone.length !== 10) return null;

    if (!Array.isArray(this.data.dominosRegisteredPhones)) {
      this.data.dominosRegisteredPhones = [];
    }

    // 1. Check registry
    const reg = this.data.dominosRegisteredPhones.find(p => p.cleanPhone === cleanPhone);

    // 2. Check accounts in pool
    const acc = this.data.accounts.find(a => (a.cleanPhone === cleanPhone || (a.phone && a.phone.replace(/[^0-9]/g, '').slice(-10) === cleanPhone)));

    // 3. Check completed orders
    const allOrders = Array.isArray(this.data.orders) ? this.data.orders : [];
    const priorOrders = allOrders.filter(o => {
      const oPhone = (o.phone || o.customerPhone || o.receiverMobile || (o.address && o.address.receiverMobile) || '').replace(/[^0-9]/g, '').slice(-10);
      return oPhone === cleanPhone;
    });

    if (reg) {
      return {
        phone: reg.phone || `+91 ${cleanPhone}`,
        cleanPhone,
        isDominoRegistered: Boolean(reg.isDominoRegistered),
        pastOrdersCount: reg.pastOrdersCount !== undefined ? Number(reg.pastOrdersCount) : (acc ? Number(acc.pastOrdersCount || 0) : 0),
        autoCoupon: reg.autoCoupon || reg.couponCode || (Number(reg.pastOrdersCount || 0) === 0 ? 'DOMNEW50' : (Number(reg.pastOrdersCount || 0) === 1 ? 'CHEESY' : 'PARTY')),
        accountType: reg.accountType || (Number(reg.pastOrdersCount || 0) === 0 ? 'NEW_ACCOUNT' : (Number(reg.pastOrdersCount || 0) === 1 ? 'SECOND_ORDER_ACCOUNT' : 'EXISTING_ACCOUNT')),
        categoryName: reg.categoryName || (Number(reg.pastOrdersCount || 0) === 0 ? '🟢 50% OFF New User Tier' : (Number(reg.pastOrdersCount || 0) === 1 ? '🟡 Cheesy 2nd Order Tier' : '🔵 Party Repeat Order Tier')),
        customerName: reg.customerName || acc?.customerName || `Domino's Customer (${cleanPhone.slice(-4)})`,
        inPool: Boolean(acc),
        accountId: acc?.id || null,
        lastCheckedAt: reg.lastCheckedAt || new Date().toISOString(),
        source: reg.source || 'DOMINOS_REGISTRY'
      };
    }

    if (acc) {
      const pastOrders = Number(acc.pastOrdersCount || 0);
      const coupon = acc.couponCode || (pastOrders === 0 ? 'DOMNEW50' : (pastOrders === 1 ? 'CHEESY' : 'PARTY'));
      return {
        phone: acc.phone || `+91 ${cleanPhone}`,
        cleanPhone,
        isDominoRegistered: true,
        pastOrdersCount: pastOrders,
        autoCoupon: coupon,
        accountType: pastOrders === 0 ? 'NEW_ACCOUNT' : (pastOrders === 1 ? 'SECOND_ORDER_ACCOUNT' : 'EXISTING_ACCOUNT'),
        categoryName: acc.categoryName || (pastOrders === 0 ? '🟢 50% OFF New User Tier' : (pastOrders === 1 ? '🟡 Cheesy 2nd Order Tier' : '🔵 Party Repeat Order Tier')),
        customerName: acc.customerName || `Domino's Customer (${cleanPhone.slice(-4)})`,
        inPool: true,
        accountId: acc.id,
        lastCheckedAt: new Date().toISOString(),
        source: 'FLEET_POOL'
      };
    }

    if (priorOrders.length > 0) {
      const pastOrders = priorOrders.length;
      return {
        phone: `+91 ${cleanPhone}`,
        cleanPhone,
        isDominoRegistered: true,
        pastOrdersCount: pastOrders,
        autoCoupon: pastOrders === 1 ? 'CHEESY' : 'PARTY',
        accountType: pastOrders === 1 ? 'SECOND_ORDER_ACCOUNT' : 'EXISTING_ACCOUNT',
        categoryName: pastOrders === 1 ? '🟡 Cheesy 2nd Order Tier' : '🔵 Party Repeat Order Tier',
        customerName: `Domino's Customer (${cleanPhone.slice(-4)})`,
        inPool: false,
        accountId: null,
        lastCheckedAt: new Date().toISOString(),
        source: 'PRIOR_ORDERS'
      };
    }

    // Default: Brand new on Domino's India
    return {
      phone: `+91 ${cleanPhone}`,
      cleanPhone,
      isDominoRegistered: false,
      pastOrdersCount: 0,
      autoCoupon: 'DOMNEW50',
      accountType: 'NEW_ACCOUNT',
      categoryName: '🟢 50% OFF New User Tier',
      customerName: `Domino's Customer (${cleanPhone.slice(-4)})`,
      inPool: false,
      accountId: null,
      lastCheckedAt: new Date().toISOString(),
      source: 'NOT_REGISTERED'
    };
  }

  setDominosRegistrationStatus(phone, updateData = {}) {
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (!cleanPhone || cleanPhone.length !== 10) return null;

    if (!Array.isArray(this.data.dominosRegisteredPhones)) {
      this.data.dominosRegisteredPhones = [];
    }

    let record = this.data.dominosRegisteredPhones.find(p => p.cleanPhone === cleanPhone);
    if (!record) {
      record = {
        phone: `+91 ${cleanPhone}`,
        cleanPhone,
        isDominoRegistered: false,
        pastOrdersCount: 0,
        autoCoupon: 'DOMNEW50',
        couponCode: 'DOMNEW50',
        accountType: 'NEW_ACCOUNT',
        categoryName: '🟢 50% OFF New User Tier',
        customerName: `Domino's Customer (${cleanPhone.slice(-4)})`,
        lastCheckedAt: new Date().toISOString(),
        source: 'ADMIN_OVERRIDE'
      };
      this.data.dominosRegisteredPhones.push(record);
    }

    if (updateData.isDominoRegistered !== undefined) {
      record.isDominoRegistered = Boolean(updateData.isDominoRegistered);
      if (!record.isDominoRegistered) {
        record.pastOrdersCount = 0;
      } else if (updateData.pastOrdersCount !== undefined && updateData.pastOrdersCount !== null) {
        record.pastOrdersCount = Number(updateData.pastOrdersCount);
      }
    }

    if (updateData.pastOrdersCount !== undefined && updateData.pastOrdersCount !== null) {
      record.pastOrdersCount = Math.max(0, parseInt(updateData.pastOrdersCount, 10) || 0);
      if (record.pastOrdersCount > 0) {
        record.isDominoRegistered = true;
      }
    }

    // Recalculate tier & coupon based on registration & orders
    const orders = (record.pastOrdersCount !== undefined && record.pastOrdersCount !== null) ? Number(record.pastOrdersCount) : null;
    if (!record.isDominoRegistered) {
      record.accountType = 'NEW_ACCOUNT';
      record.categoryName = '🟢 50% OFF New User Tier';
      record.autoCoupon = updateData.autoCoupon || updateData.couponCode || 'DOMNEW50';
    } else if (orders === 1) {
      record.accountType = 'SECOND_ORDER_ACCOUNT';
      record.categoryName = '🟡 Cheesy 2nd Order Tier';
      record.autoCoupon = updateData.autoCoupon || updateData.couponCode || 'CHEESY';
    } else {
      record.accountType = 'EXISTING_ACCOUNT';
      record.categoryName = '🔵 Party Repeat Order Tier';
      record.autoCoupon = updateData.autoCoupon || updateData.couponCode || 'PARTY';
    }
    record.couponCode = record.autoCoupon;

    if (updateData.source) record.source = updateData.source;
    if (updateData.proof) record.proof = updateData.proof;

    if (updateData.customerName) record.customerName = updateData.customerName;
    record.lastCheckedAt = new Date().toISOString();

    // If matching account in fleet pool, keep it synchronized
    const acc = this.data.accounts.find(a => a.cleanPhone === cleanPhone || (a.phone && a.phone.replace(/[^0-9]/g, '').slice(-10) === cleanPhone));
    if (acc) {
      acc.pastOrdersCount = record.pastOrdersCount;
      acc.couponCode = record.couponCode;
      acc.categoryName = record.categoryName;
    }

    this.save();
    return record;
  }

  deleteDominosRegistrationStatus(phone) {
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (!cleanPhone || !Array.isArray(this.data.dominosRegisteredPhones)) return false;
    const initialLen = this.data.dominosRegisteredPhones.length;
    this.data.dominosRegisteredPhones = this.data.dominosRegisteredPhones.filter(p => p.cleanPhone !== cleanPhone);
    if (this.data.dominosRegisteredPhones.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  getDominosRegisteredPhones() {
    if (!Array.isArray(this.data.dominosRegisteredPhones)) {
      this.data.dominosRegisteredPhones = [];
    }
    return this.data.dominosRegisteredPhones;
  }

  claimAvailableAccount(preferredCategory = null, orderId = null, paymentMethod = null, cartSubtotal = 0) {
    const now = Date.now();

    // Priority 0: If orderId is provided, check if an account is ALREADY bound to this order!
    if (orderId) {
      const alreadyAssigned = this.data.accounts.find(a => 
        (!a.disabled && a.status !== 'DISABLED') && 
        (a.activeOrderId === orderId || a.lastOrderId === orderId)
      );
      if (alreadyAssigned) {
        alreadyAssigned.status = 'IN_USE';
        alreadyAssigned.activeOrderId = orderId;
        alreadyAssigned.lastActive = new Date().toISOString();
        this.save();
        return alreadyAssigned;
      }
    }

    // Look for IDLE account matching category or any account that is not expired
    const isEligible = (a) => {
      // Disabled accounts in the fleet cannot be assigned
      if (a.disabled || a.status === 'DISABLED') return false;
      // If already assigned to this specific order, it is always eligible
      if (orderId && a.activeOrderId === orderId) return true;
      if (a.status !== 'IDLE') return false;
      if (a.expiresAt && new Date(a.expiresAt).getTime() <= now) return false;
      // If COD payment, skip accounts that currently have an active COD order / codDisabledUntil flag
      if ((paymentMethod === 'COD' || paymentMethod === 'CASH') && a.codDisabledUntil && a.codDisabledUntil > now) return false;
      return true;
    };

    let eligibleAccounts = this.data.accounts.filter(isEligible);
    if (eligibleAccounts.length === 0) {
      // Fallback 1: check if an idle account exists with refresh token that is not disabled
      const fallbackAcc = this.data.accounts.find(a => !a.disabled && a.status !== 'DISABLED' && a.status === 'IDLE' && (a.refreshToken || a.credentials?.refreshToken));
      if (fallbackAcc) eligibleAccounts.push(fallbackAcc);
    }

    // Resilient Fallback 2: If still no account, pick any non-disabled active account in the fleet
    // to ensure robot order placement never fails due to pool exhaustion
    if (eligibleAccounts.length === 0) {
      const anyActiveAcc = this.data.accounts.filter(a => !a.disabled && a.status !== 'DISABLED');
      if (anyActiveAcc.length > 0) {
        // Sort by least recently active
        anyActiveAcc.sort((a, b) => {
          const tA = a.lastActive ? new Date(a.lastActive).getTime() : 0;
          const tB = b.lastActive ? new Date(b.lastActive).getTime() : 0;
          return tA - tB;
        });
        eligibleAccounts.push(anyActiveAcc[0]);
      }
    }

    if (eligibleAccounts.length === 0) return null;

    // Intelligent Priority Sorting:
    // Rule 1: If cartSubtotal is between ₹199 and ₹260, prioritize accounts with zero past orders (pastOrdersCount === 0) to maximize DOMNEW50 50% discount!
    // Rule 2: Then prioritize accounts with 1 past order (CHEESY 2nd order discount)
    // Rule 3: Then accounts with 2+ past orders (PARTY / Repeat order tier)
    // Rule 4: Match preferredCategory if specified
    // Rule 5: Distribute load across idle accounts (least recently active first)
    const subtotal = parseFloat(cartSubtotal) || 0;
    const isUnderNewUserSweetSpot = subtotal >= 199 && subtotal <= 260;

    eligibleAccounts.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;

      const pastA = parseInt(a.pastOrdersCount || 0);
      const pastB = parseInt(b.pastOrdersCount || 0);

      // Top priority for zero-order accounts (NEW_ACCOUNT) to unlock highest savings
      if (pastA === 0 || a.accountType === 'NEW_ACCOUNT' || a.category === 'CATEGORY_50_OFF') scoreA += 10000;
      if (pastB === 0 || b.accountType === 'NEW_ACCOUNT' || b.category === 'CATEGORY_50_OFF') scoreB += 10000;

      // Priority 2 for 1-past-order accounts (CHEESY 2nd order discount)
      if (pastA === 1 || a.accountType === 'SECOND_ORDER_ACCOUNT') scoreA += 500;
      if (pastB === 1 || b.accountType === 'SECOND_ORDER_ACCOUNT') scoreB += 500;

      // Priority 3 for 2+ past orders
      if (pastA >= 2 || a.accountType === 'EXISTING_ACCOUNT') scoreA += 100;
      if (pastB >= 2 || b.accountType === 'EXISTING_ACCOUNT') scoreB += 100;

      if (preferredCategory && a.category === preferredCategory) scoreA += 500;
      if (preferredCategory && b.category === preferredCategory) scoreB += 500;

      if (scoreA !== scoreB) return scoreB - scoreA;

      // Least recently used first for fair session rotation
      const timeA = a.lastActive ? new Date(a.lastActive).getTime() : 0;
      const timeB = b.lastActive ? new Date(b.lastActive).getTime() : 0;
      return timeA - timeB;
    });

    const acc = eligibleAccounts[0];
    if (acc) {
      acc.status = 'IN_USE';
      acc.activeOrderId = orderId || null;
      acc.lastActive = new Date().toISOString();
      this.save();
    }
    return acc;
  }

  releaseAccount(id) {
    const acc = this.data.accounts.find(a => a.id === id);
    if (acc) {
      acc.status = 'IDLE';
      acc.activeOrderId = null;
      acc.totalOrdersPlaced = (acc.totalOrdersPlaced || 0) + 1;
      acc.pastOrdersCount = (Number(acc.pastOrdersCount) || 0) + 1;

      // Automatically shift tier as orders are completed from this account
      if (acc.pastOrdersCount === 1) {
        acc.accountType = 'SECOND_ORDER_ACCOUNT';
        acc.category = 'CATEGORY_SECOND_ORDER';
        acc.categoryName = 'Cheesy 2nd Order Tier';
        acc.couponCode = 'CHEESY';
      } else if (acc.pastOrdersCount >= 2) {
        acc.accountType = 'EXISTING_ACCOUNT';
        acc.category = 'CATEGORY_FLAT_100';
        acc.categoryName = 'Party Repeat Order Tier';
        acc.couponCode = 'PARTY';
      }

      this.save();
    }
  }

  // Voucher Management (16-digit Code + 6-digit PIN)
  getVouchers() {
    if (!Array.isArray(this.data.vouchers) || this.data.vouchers.length === 0) {
      this.data.vouchers = [
        {
          id: 'VOUCH-501',
          code: '6014829301928471',
          pin: '839201',
          balance: 1000,
          initialBalance: 1000,
          status: 'UNUSED',
          usedInOrderId: null
        },
        {
          id: 'VOUCH-502',
          code: '6014992100481239',
          pin: '517290',
          balance: 1500,
          initialBalance: 1500,
          status: 'UNUSED',
          usedInOrderId: null
        },
        {
          id: 'VOUCH-503',
          code: '6014381029471182',
          pin: '394812',
          balance: 800,
          initialBalance: 800,
          status: 'UNUSED',
          usedInOrderId: null
        }
      ];
      this.save();
    }
    return this.data.vouchers;
  }

  addVoucher(voucher) {
    if (!voucher.status) voucher.status = 'UNUSED';
    this.data.vouchers.push(voucher);
    this.save();
    return voucher;
  }

  updateVoucher(id, updates) {
    const v = this.data.vouchers.find(item => item.id === id);
    if (!v) throw new Error('Voucher not found');
    Object.assign(v, updates);
    this.save();
    return v;
  }

  deleteVoucher(id) {
    this.data.vouchers = this.data.vouchers.filter(v => v.id !== id);
    this.save();
    return this.data.vouchers;
  }

  claimAvailableVoucher(requiredAmount = 0) {
    // Look for UNUSED or PARTIALLY_USED voucher with sufficient balance
    const isUsable = item => (item.status === 'UNUSED' || item.status === 'AVAILABLE' || item.status === 'PARTIALLY_USED') && item.balance > 0;
    const v = this.data.vouchers.find(item => isUsable(item) && item.balance >= requiredAmount);
    if (v) return v;
    // Fallback to any usable voucher with balance > 0
    return this.data.vouchers.find(isUsable) || null;
  }

  deductVoucher(id, amount, orderId) {
    const v = this.data.vouchers.find(item => item.id === id);
    if (v) {
      v.balance = Math.max(0, v.balance - amount);
      if (v.balance === 0) {
        v.status = 'EXHAUSTED';
      } else {
        v.status = 'PARTIALLY_USED';
      }
      v.usedInOrderId = orderId;
      this.save();
    }
    return v;
  }

  // Payment Settings (Configured by Admin for Dynamic UPI QR)
  getPaymentSettings() {
    if (!this.data.paymentSettings) {
      this.data.paymentSettings = {
        upiId: 'dominos.pay@okhdfcbank',
        payeeName: "Domino's Official Kitchen Outlet",
        merchantCode: 'DOM-5819',
        note: "Domino's Order Payment"
      };
      this.save();
    }
    return this.data.paymentSettings;
  }

  updatePaymentSettings(settings) {
    const current = this.getPaymentSettings();
    const upi = String(settings.upiId || settings.receiverUpiId || '').trim();
    const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/;
    if (upi) {
      if (!UPI_REGEX.test(upi)) {
        throw new Error('Invalid UPI ID format. Must follow standard UPI format (e.g. dominos.pay@okhdfcbank).');
      }
      current.upiId = upi;
      current.receiverUpiId = upi;
    }
    if (settings.payeeName) current.payeeName = String(settings.payeeName).slice(0, 60).trim();
    if (settings.merchantCode) current.merchantCode = String(settings.merchantCode).slice(0, 20).trim();
    if (settings.note) current.note = String(settings.note).slice(0, 80).trim();
    current.updatedAt = new Date().toISOString();
    this.save();
    return current;
  }

  // Automated Domino's Promo & Coupon Rules Engine (Configured by Admin)
  getCouponRules() {
    if (!this.data.couponRules) {
      this.data.couponRules = INITIAL_DATA.couponRules;
      this.save();
    }
    return this.data.couponRules;
  }

  updateCouponRules(rules) {
    const current = this.getCouponRules();
    if (rules.firstOrderCoupon) current.firstOrderCoupon = rules.firstOrderCoupon.trim().toUpperCase();
    if (rules.secondOrderCoupon) current.secondOrderCoupon = rules.secondOrderCoupon.trim().toUpperCase();
    if (rules.regularOrderCoupon) current.regularOrderCoupon = rules.regularOrderCoupon.trim().toUpperCase();
    if (rules.fallbackCoupon) current.fallbackCoupon = rules.fallbackCoupon.trim().toUpperCase();
    if (rules.firstOrderDiscount !== undefined) current.firstOrderDiscount = Number(rules.firstOrderDiscount);
    if (rules.secondOrderDiscount !== undefined) current.secondOrderDiscount = Number(rules.secondOrderDiscount);
    if (rules.regularOrderDiscount !== undefined) current.regularOrderDiscount = Number(rules.regularOrderDiscount);
    if (rules.fallbackDiscount !== undefined) current.fallbackDiscount = Number(rules.fallbackDiscount);
    this.save();
    return current;
  }

  // Combos & Menu
  getCombos() {
    return this.data.combos;
  }

  getMenu() {
    try {
      const catalogPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
      if (fs.existsSync(catalogPath)) {
        return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      }
    } catch (e) {}
    return this.data.menu || [];
  }

  updateMenuItem(id, updates = {}) {
    if (!id) return null;
    if (!Array.isArray(this.data.menu)) this.data.menu = [];
    const itemIndex = this.data.menu.findIndex(m => m.id === id || m.dominosCode === id);
    if (itemIndex === -1) return null;

    const item = this.data.menu[itemIndex];
    if (updates.price !== undefined) {
      item.price = Number(updates.price) || item.price;
    }
    if (updates.originalPrice !== undefined) {
      item.originalPrice = Number(updates.originalPrice) || item.originalPrice;
    }
    if (updates.isAvailable !== undefined) {
      item.isAvailable = Boolean(updates.isAvailable);
    }
    if (updates.name) item.name = String(updates.name).trim();
    if (updates.category) item.category = String(updates.category).trim();
    if (updates.description) item.description = String(updates.description).trim();
    if (updates.imageUrl) {
      item.imageUrl = String(updates.imageUrl).trim();
      item.image = item.imageUrl;
    }

    if (item.originalPrice && item.originalPrice > item.price) {
      item.discount = `${Math.round(((item.originalPrice - item.price) / item.originalPrice) * 100)}% OFF`;
    }

    this.data.menu[itemIndex] = item;
    this.save();

    // Also persist to dominos_catalog.json
    try {
      const catalogPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
      fs.writeFileSync(catalogPath, JSON.stringify(this.data.menu, null, 2), 'utf8');
    } catch (e) {}

    return item;
  }

  addMenuItem(itemData) {
    if (!itemData || !itemData.name) throw new Error('Menu item name is required');
    if (!Array.isArray(this.data.menu)) this.data.menu = [];
    const id = itemData.id || `DOM-ITEM-${Date.now()}`;
    const price = Number(itemData.price) || 99;
    const originalPrice = Number(itemData.originalPrice) || Math.round((price * 1.25) / 10) * 10 - 1;
    const isVeg = itemData.isVeg !== false;
    const cat = itemData.category || (isVeg ? 'Veg Pizza' : 'Non-Veg Pizza');
    const type = isVeg ? 'VEG' : 'NON-VEG';
    const imageUrl = itemData.imageUrl || itemData.image || 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';

    const newItem = {
      id,
      name: String(itemData.name).trim(),
      category: cat,
      type,
      price,
      originalPrice,
      discount: `${Math.round(((originalPrice - price) / originalPrice) * 100)}% OFF`,
      isVeg,
      isAvailable: itemData.isAvailable !== false,
      dominosCode: itemData.dominosCode || `CODE_${this.data.menu.length + 1}`,
      skuId: itemData.skuId || `SKU_${this.data.menu.length + 1}`,
      description: itemData.description || `${itemData.name} freshly baked to perfection.`,
      imageUrl,
      image: imageUrl,
      sizes: itemData.sizes || { 'Regular (Serves 1)': price },
      allowedSizes: itemData.allowedSizes || ['Regular'],
      allowedCrusts: itemData.allowedCrusts || ['New Hand Tossed']
    };

    this.data.menu.unshift(newItem);
    this.save();

    try {
      const catalogPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
      fs.writeFileSync(catalogPath, JSON.stringify(this.data.menu, null, 2), 'utf8');
    } catch (e) {}

    return newItem;
  }

  deleteMenuItem(id) {
    if (!id) return false;
    if (!Array.isArray(this.data.menu)) return false;
    const idx = this.data.menu.findIndex(m => m.id === id || m.dominosCode === id);
    if (idx === -1) return false;
    this.data.menu.splice(idx, 1);
    this.save();

    try {
      const catalogPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
      fs.writeFileSync(catalogPath, JSON.stringify(this.data.menu, null, 2), 'utf8');
    } catch (e) {}

    return true;
  }

  // Orders
  getOrders() {
    return this.data.orders;
  }

  getOrderById(id) {
    if (!id) return null;
    const cleanId = String(id).trim();
    const numId = cleanId.replace(/[^0-9]/g, '');

    // Pass 1: Exact string match
    const exact = this.data.orders.find(o => 
      o.id === cleanId ||
      o.engineOrderRef === cleanId ||
      o.dominosOrderRef === cleanId ||
      o.robot?.dominosOrderRef === cleanId ||
      o.robot?.posOrderId === cleanId
    );
    if (exact) return exact;

    // Pass 2: Domino's official kitchen token / POS order ID match (e.g. #22 or #790022)
    if (numId) {
      const tokenMatch = this.data.orders.find(o => {
        const dNum = String(o.robot?.dominosOrderRef || o.dominosOrderRef || '').replace(/[^0-9]/g, '');
        const pNum = String(o.robot?.posOrderId || '').replace(/[^0-9]/g, '');
        return (dNum && (dNum === numId || dNum.endsWith(numId))) ||
               (pNum && (pNum === numId || pNum.endsWith(numId)));
      });
      if (tokenMatch) return tokenMatch;

      // Pass 3: Internal engine order number match
      const engineMatch = this.data.orders.find(o => {
        const oNum = String(o.id || '').replace(/[^0-9]/g, '');
        return oNum && (oNum === numId || oNum.endsWith(numId));
      });
      if (engineMatch) return engineMatch;
    }
    return null;
  }

  createOrder(order) {
    this.data.orders.unshift(order);
    this.cleanupOldOrders(30);
    this.save();
    return order;
  }

  cleanupOldOrders(maxToKeep = 30) {
    if (Array.isArray(this.data.orders) && this.data.orders.length > maxToKeep) {
      this.data.orders = this.data.orders.slice(0, maxToKeep);
    }
  }

  updateOrder(id, updates) {
    const order = this.data.orders.find(o => o.id === id);
    if (order) {
      Object.assign(order, updates);
      order.updatedAt = new Date().toISOString();
      this.save();
    }
    return order;
  }

  // User Profile, Wallet & Delivery Address Management (Strict Domino's India Schema)
  getUserProfile() {
    if (!this.data.userProfile) {
      this.data.userProfile = {
        userId12: '948271035824',
        name: 'Parth Sharma',
        email: 'parth.google@gmail.com',
        phone: '+91 7893618933',
        phoneLocked: true,
        wallet: {
          balance: 0,
          currency: 'INR',
          status: 'ACTIVE'
        },
        savedAddresses: [
          {
            id: 'ADDR-DEF-01',
            label: 'Home',
            flat: 'House No. 124, 1st Floor',
            building: 'Shivalik Greens',
            street: 'Sector 15',
            landmark: 'Near Community Park',
            city: 'Chandigarh',
            pincode: '160015',
            name: 'Parth Sharma',
            phone: '+91 7893618933',
            latitude: 30.7339,
            longitude: 76.7889,
            isDefault: true
          }
        ]
      };
      this.save();
    }
    
    // Ensure 12-digit persistent numerical user ID exists
    if (!this.data.userProfile.userId12) {
      this.data.userProfile.userId12 = generate12DigitUid();
      this.save();
    }

    // Ensure wallet exists with zero fake bonus
    if (!this.data.userProfile.wallet) {
      this.data.userProfile.wallet = {
        balance: 0,
        currency: 'INR',
        status: 'ACTIVE'
      };
      this.save();
    }
    return this.data.userProfile;
  }

  updateUserProfile(profileData) {
    const current = this.getUserProfile();
    const oldPhone = current.phone ? current.phone.replace(/[^0-9]/g, '').slice(-10) : '';

    if (profileData.phone) {
      const cleanNew = profileData.phone.replace(/[^0-9]/g, '').slice(-10);
      if (!cleanNew || cleanNew.length !== 10) {
        throw new Error('Please provide a valid 10-digit Indian mobile number.');
      }
      if (current.phoneLocked && !profileData.overrideLock) {
        throw new Error('Your registered mobile number is locked. Please tap "Request Change" to contact Support Chat.');
      }
      current.phone = `+91 ${cleanNew}`;
      if (oldPhone && oldPhone !== cleanNew) {
        this.adminEditCustomerUser(oldPhone, {
          newPhone: cleanNew,
          newName: profileData.name || current.name,
          newEmail: profileData.email || current.email
        });
      }
    }

    if (profileData.name) current.name = profileData.name.trim();
    if (profileData.email) current.email = profileData.email.trim();
    if (typeof profileData.phoneLocked === 'boolean') {
      current.phoneLocked = profileData.phoneLocked;
    }
    if (profileData.wallet) {
      current.wallet = Object.assign(current.wallet || {}, profileData.wallet);
    }

    // Sync to user in this.data.users
    const users = this.getUsers();
    const cleanCurrent = (current.phone || '').replace(/[^0-9]/g, '').slice(-10);
    const user = users.find(u => u.id === current.id || u.userId12 === current.userId12 || (cleanCurrent && u.cleanPhone === cleanCurrent)) || users[0];
    if (user) {
      if (current.name) user.name = current.name;
      if (current.email) user.email = current.email;
      if (current.phone) {
        user.phone = current.phone;
        user.cleanPhone = cleanCurrent;
      }
      if (typeof current.phoneLocked === 'boolean') user.phoneLocked = current.phoneLocked;
      if (current.wallet?.balance !== undefined) user.walletBalance = current.wallet.balance;
    }

    this.save();
    return current;
  }

  updateUserName(name) {
    const profile = this.getUserProfile();
    profile.name = name.trim();
    this.save();
    return profile;
  }

  saveUserAddress(address) {
    const profile = this.getUserProfile();
    if (!profile.savedAddresses) profile.savedAddresses = [];
    
    const existingIdx = profile.savedAddresses.findIndex(a => a.id === address.id);
    
    // STRICT DOMINO'S POLICY: Maximum 3 addresses stored at any time.
    // When adding a new address and already at capacity (>= 3), auto-evict the oldest non-default address
    // so the customer's newly given address is ALWAYS accepted, saved, and active!
    if (existingIdx < 0 && profile.savedAddresses.length >= 3) {
      const nonDefaultIndices = [];
      profile.savedAddresses.forEach((a, idx) => {
        if (!a.isDefault) nonDefaultIndices.push(idx);
      });
      // Evict oldest non-default address (last in array), or the very last address
      const evictIdx = nonDefaultIndices.length > 0 ? nonDefaultIndices[nonDefaultIndices.length - 1] : (profile.savedAddresses.length - 1);
      const evicted = profile.savedAddresses.splice(evictIdx, 1)[0];
      console.log(`[DB] ℹ️ Auto-evicted address '${evicted?.label || evicted?.id}' to stay within 3-address limit while adding customer's new address.`);
    }

    // Ensure unique ID & label
    if (!address.id) {
      address.id = `ADDR-${Date.now().toString().slice(-6)}`;
    }
    address.label = address.label || 'Home';

    if (existingIdx >= 0) {
      if (address.isDefault) {
        profile.savedAddresses.forEach(a => a.isDefault = false);
      }
      profile.savedAddresses[existingIdx] = { ...profile.savedAddresses[existingIdx], ...address };
    } else {
      if (address.isDefault || profile.savedAddresses.length === 0) {
        profile.savedAddresses.forEach(a => a.isDefault = false);
        address.isDefault = true;
      }
      profile.savedAddresses.unshift(address);
    }

    // Sync with primary app user record if exists
    if (Array.isArray(this.data.users) && this.data.users[0]) {
      this.data.users[0].savedAddresses = profile.savedAddresses;
      this.data.users[0].addressCount = profile.savedAddresses.length;
    }

    this.save();
    return profile.savedAddresses;
  }

  setDefaultAddress(addressId) {
    const profile = this.getUserProfile();
    if (!profile.savedAddresses) return [];
    
    let found = false;
    profile.savedAddresses.forEach(a => {
      if (a.id === addressId) {
        a.isDefault = true;
        found = true;
      } else {
        a.isDefault = false;
      }
    });

    if (found) {
      if (Array.isArray(this.data.users) && this.data.users[0]) {
        this.data.users[0].savedAddresses = profile.savedAddresses;
      }
      this.save();
    }
    return profile.savedAddresses;
  }

  deleteUserAddress(addressId) {
    const profile = this.getUserProfile();
    if (!profile.savedAddresses) return [];

    const wasDefault = profile.savedAddresses.find(a => a.id === addressId)?.isDefault;
    profile.savedAddresses = profile.savedAddresses.filter(a => a.id !== addressId);
    
    if (wasDefault && profile.savedAddresses.length > 0) {
      profile.savedAddresses[0].isDefault = true;
    }

    if (Array.isArray(this.data.users) && this.data.users[0]) {
      this.data.users[0].savedAddresses = profile.savedAddresses;
      this.data.users[0].addressCount = profile.savedAddresses.length;
    }

    this.save();
    return profile.savedAddresses;
  }

  // =========================================================================
  // APP REGISTERED USERS MANAGEMENT (Admin View & Controls)
  // =========================================================================
  getUsers() {
    if (!this.data.users || !Array.isArray(this.data.users)) {
      this.data.users = [];
      this.save();
    }
    // Guarantee 12-digit numerical User ID & transactions array on all users
    this.data.users.forEach((u) => {
      if (!u.userId12) {
        u.userId12 = generate12DigitUid();
      }
      if (u.email && u.email.toLowerCase() === 'parthgulyani7960@gmail.com') {
        u.role = 'ADMIN';
        u.isAdmin = true;
      }
      if (!u.transactions) u.transactions = [];
      if (Array.isArray(u.savedAddresses) && u.savedAddresses.length > 3) {
        u.savedAddresses = u.savedAddresses.slice(0, 3);
        u.addressCount = u.savedAddresses.length;
      }
    });
    return this.data.users;
  }

  getUser(idOrPhone) {
    const users = this.getUsers();
    const str = String(idOrPhone || '').trim();
    if (!str) return users[0] || null;
    const clean = str.replace(/[^0-9]/g, '');
    const clean10 = clean.slice(-10);

    return users.find(u => 
      u.id === str || 
      (u.email && u.email.toLowerCase() === str.toLowerCase()) ||
      u.userId12 === str || 
      (clean.length === 12 && u.userId12 === clean) ||
      (clean10.length === 10 && u.cleanPhone === clean10) || 
      u.phone === str
    ) || null;
  }

  deleteUser(userId) {
    if (!Array.isArray(this.data.users)) return null;
    const idx = this.data.users.findIndex(u => u.id === userId || u.userId12 === userId);
    if (idx < 0) throw new Error('User not found.');
    const deleted = this.data.users.splice(idx, 1)[0];
    if (!Array.isArray(this.data.deletedUserIds)) {
      this.data.deletedUserIds = [];
    }
    if (deleted.id && !this.data.deletedUserIds.includes(deleted.id)) this.data.deletedUserIds.push(deleted.id);
    if (deleted.userId12 && !this.data.deletedUserIds.includes(deleted.userId12)) this.data.deletedUserIds.push(deleted.userId12);
    if (deleted.email && !this.data.deletedUserIds.includes(deleted.email.toLowerCase())) this.data.deletedUserIds.push(deleted.email.toLowerCase());
    this.save();
    return deleted;
  }

  toggleUserStatus(userId) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    user.status = user.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    user.lastActive = new Date().toISOString();
    this.save();
    return user;
  }

  adminUpdateUser(userId, updates) {
    const users = this.getUsers();
    const idx = users.findIndex(u => u.id === userId || u.userId12 === userId);
    if (idx < 0) throw new Error('User not found.');

    const user = users[idx];
    const oldPhone = user.phone ? user.phone.replace(/[^0-9]/g, '').slice(-10) : '';

    if (updates.name) user.name = updates.name.trim();
    if (updates.email) user.email = updates.email.trim();
    if (updates.phone) {
      const clean = updates.phone.replace(/[^0-9]/g, '').slice(-10);
      user.phone = `+91 ${clean}`;
      user.cleanPhone = clean;
    }
    if (typeof updates.phoneLocked === 'boolean') {
      user.phoneLocked = updates.phoneLocked;
      user.isPhoneLocked = updates.phoneLocked;
    }
    if (typeof updates.isLocked === 'boolean') {
      user.phoneLocked = updates.isLocked;
      user.isPhoneLocked = updates.isLocked;
    }
    if (typeof updates.walletBalance === 'number') {
      user.walletBalance = Math.max(0, updates.walletBalance);
      if (this.data.userProfile) {
        if (!this.data.userProfile.wallet) this.data.userProfile.wallet = {};
        this.data.userProfile.wallet.balance = user.walletBalance;
      }
    }

    // Deep sync to userProfile and past orders
    if (this.data.userProfile) {
      if (user.name) this.data.userProfile.name = user.name;
      if (user.phone) this.data.userProfile.phone = user.phone;
      if (user.email) this.data.userProfile.email = user.email;
      if (typeof updates.phoneLocked === 'boolean') this.data.userProfile.phoneLocked = updates.phoneLocked;
      if (this.data.userProfile.savedAddresses) {
        this.data.userProfile.savedAddresses.forEach(a => {
          if (user.phone) a.phone = user.phone;
          if (user.name) a.name = user.name;
        });
      }
    }

    if (oldPhone && user.cleanPhone && oldPhone !== user.cleanPhone) {
      this.adminEditCustomerUser(oldPhone, {
        newPhone: user.cleanPhone,
        newName: user.name,
        newEmail: user.email
      });
    }

    this.save();
    return user;
  }

  // Admin Wallet Adjustment with Audit Transaction Recording (+ / - / =)
  adjustUserWallet(userId, { type = 'ADD', amount = 0, reason = 'Admin Adjustment' }) {
    const users = this.getUsers();
    const user = users.find(u => u.id === userId || u.userId12 === userId);
    if (!user) throw new Error('User not found.');

    const numAmount = Math.abs(Number(amount));
    if (isNaN(numAmount) || numAmount < 0) throw new Error('Invalid wallet adjustment amount.');

    const prevBalance = user.walletBalance || 0;
    let newBalance = prevBalance;

    const op = String(type).toUpperCase();
    if (op === 'ADD' || op === 'CREDIT' || op === '+') {
      newBalance = prevBalance + numAmount;
    } else if (op === 'DEDUCT' || op === 'DEBIT' || op === '-') {
      newBalance = Math.max(0, prevBalance - numAmount);
    } else if (op === 'SET' || op === '=') {
      newBalance = Math.max(0, numAmount);
    } else {
      throw new Error(`Unsupported adjustment type: ${type}. Use ADD (+), DEDUCT (-), or SET (=).`);
    }

    user.walletBalance = newBalance;

    const txn = {
      id: `TXN-${Date.now().toString().slice(-6)}`,
      type: op === 'DEDUCT' || op === 'DEBIT' || op === '-' ? 'DEBIT' : (op === 'SET' || op === '=' ? 'ADJUST' : 'CREDIT'),
      amount: numAmount,
      balanceBefore: prevBalance,
      balanceAfter: newBalance,
      reason: reason.trim() || 'Admin Wallet Adjustment',
      timestamp: new Date().toISOString()
    };

    if (!user.transactions) user.transactions = [];
    user.transactions.unshift(txn);

    // Deep sync to userProfile if matching
    if (this.data.userProfile && (
      !this.data.userProfile.userId12 || 
      this.data.userProfile.userId12 === user.userId12 || 
      this.data.userProfile.id === user.id ||
      (user.cleanPhone && this.data.userProfile.phone && this.data.userProfile.phone.includes(user.cleanPhone))
    )) {
      if (!this.data.userProfile.wallet) this.data.userProfile.wallet = {};
      this.data.userProfile.wallet.balance = user.walletBalance;
    }

    this.save();
    return { user, transaction: txn };
  }

  creditUserWallet(userId, amount, reason = 'Admin Credit') {
    return this.adjustUserWallet(userId, { type: 'ADD', amount, reason }).user;
  }

  getUserTransactions(userId) {
    const user = this.getUser(userId);
    if (!user) return [];
    return user.transactions || [];
  }

  // Wallet Deposit Requests & Real-Time Approval Engine
  getWalletDeposits() {
    if (!Array.isArray(this.data.walletDeposits)) {
      this.data.walletDeposits = [];
    }
    return this.data.walletDeposits;
  }

  createWalletDeposit({ userId, phone, amount, reference, method = 'UPI_QR', upiUri = '', status = 'INITIATED', utr = '' }) {
    if (!Array.isArray(this.data.walletDeposits)) {
      this.data.walletDeposits = [];
    }
    const numAmt = Math.round(Number(amount));
    if (isNaN(numAmt) || numAmt < 50) throw new Error('Minimum deposit amount is ₹50.');

    const cleanRef = reference || `DEP-${Math.floor(100000 + Math.random() * 900000)}`;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const deposit = {
      id: cleanRef,
      reference: cleanRef,
      referenceId: cleanRef,
      userId: userId || 'CURRENT_USER',
      phone: (phone || '').replace(/[^0-9]/g, '').slice(-10),
      amount: numAmt,
      method: method,
      upiUri: upiUri,
      utr: utr,
      status: status,
      expiresAt: expiresAt,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    this.data.walletDeposits.unshift(deposit);

    // Record transaction on user object
    const user = this.getUser(userId) || (this.getUsers() && this.getUsers()[0]);
    if (user) {
      if (!Array.isArray(user.transactions)) user.transactions = [];
      user.transactions.unshift({
        id: `TXN-${cleanRef}`,
        type: status === 'APPROVED' ? 'DEPOSIT' : (status === 'INITIATED' ? 'DEPOSIT_INITIATED' : 'DEPOSIT_PENDING'),
        amount: numAmt,
        previousBalance: user.walletBalance || 0,
        newBalance: user.walletBalance || 0,
        reference: cleanRef,
        referenceId: cleanRef,
        reason: status === 'INITIATED' ? 'Deposit Initiated (QR Valid 5 Mins)' : 'Wallet Deposit (Pending Admin Approval)',
        timestamp: nowIso,
        status: status
      });
    }

    this.save();
    return deposit;
  }

  approveWalletDeposit(referenceOrId, adminNote = 'Admin Approved') {
    const deposits = this.getWalletDeposits();
    const deposit = deposits.find(d => d.reference === referenceOrId || d.id === referenceOrId);
    if (!deposit) throw new Error(`Deposit ${referenceOrId} not found.`);
    if (deposit.status === 'APPROVED') return { alreadyApproved: true, deposit };

    const nowIso = new Date().toISOString();
    deposit.status = 'APPROVED';
    deposit.approvedAt = nowIso;
    deposit.adminNote = adminNote;

    // Credit user's wallet
    const user = this.getUser(deposit.userId) || (this.getUsers() && this.getUsers()[0]);
    let updatedUser = null;
    if (user) {
      const prevBal = user.walletBalance || 0;
      const newBal = prevBal + deposit.amount;
      user.walletBalance = newBal;
      if (!Array.isArray(user.transactions)) user.transactions = [];
      
      // Update pending transaction if exists, else append approved txn
      const pendingTxn = user.transactions.find(t => t.reference === deposit.reference || t.referenceId === deposit.reference);
      if (pendingTxn) {
        pendingTxn.status = 'APPROVED';
        pendingTxn.type = 'DEPOSIT';
        pendingTxn.newBalance = newBal;
        pendingTxn.referenceId = deposit.reference;
        pendingTxn.reason = `Wallet Deposit Approved (+₹${deposit.amount})`;
      } else {
        user.transactions.unshift({
          id: `TXN-${deposit.reference}`,
          type: 'DEPOSIT',
          amount: deposit.amount,
          previousBalance: prevBal,
          newBalance: newBal,
          reference: deposit.reference,
          referenceId: deposit.reference,
          reason: `Wallet Deposit Approved (+₹${deposit.amount})`,
          timestamp: nowIso,
          status: 'APPROVED'
        });
      }

      // Sync userProfile wallet
      if (this.data.userProfile) {
        if (!this.data.userProfile.wallet) this.data.userProfile.wallet = {};
        this.data.userProfile.wallet.balance = newBal;
      }
      updatedUser = user;
    }

    this.save();
    return { success: true, deposit, user: updatedUser };
  }

  submitWalletDeposit(referenceOrId, utr = '') {
    const deposits = this.getWalletDeposits();
    let deposit = deposits.find(d => d.reference === referenceOrId || d.referenceId === referenceOrId || d.id === referenceOrId);
    if (!deposit) {
      deposit = {
        id: referenceOrId,
        reference: referenceOrId,
        referenceId: referenceOrId,
        amount: 200,
        status: 'PENDING_APPROVAL',
        utr: utr,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      deposits.unshift(deposit);
    } else {
      deposit.status = 'PENDING_APPROVAL';
      deposit.submittedAt = new Date().toISOString();
      if (utr) deposit.utr = utr;
      deposit.updatedAt = new Date().toISOString();
    }

    const user = this.getUser(deposit.userId) || (this.getUsers() && this.getUsers()[0]);
    if (user && Array.isArray(user.transactions)) {
      const txn = user.transactions.find(t => t.reference === deposit.reference || t.referenceId === deposit.reference);
      if (txn) {
        txn.status = 'PENDING_APPROVAL';
        txn.reason = 'Wallet Deposit (Paid, Awaiting Admin Approval)';
        txn.type = 'DEPOSIT_PENDING';
      }
    }

    this.save();
    return deposit;
  }

  cancelWalletDeposit(referenceOrId) {
    const deposits = this.getWalletDeposits();
    const deposit = deposits.find(d => d.reference === referenceOrId || d.referenceId === referenceOrId || d.id === referenceOrId);
    if (deposit) {
      deposit.status = 'CANCELLED';
      deposit.updatedAt = new Date().toISOString();
      const user = this.getUser(deposit.userId) || (this.getUsers() && this.getUsers()[0]);
      if (user && Array.isArray(user.transactions)) {
        const txn = user.transactions.find(t => t.reference === deposit.reference || t.referenceId === deposit.reference);
        if (txn) {
          txn.status = 'CANCELLED';
          txn.reason = 'Wallet Deposit Cancelled by Customer';
        }
      }
      this.save();
    }
    return deposit;
  }

  adminManualAddBalance(userId, amount, reason = 'Admin Manual Balance Credit') {
    const user = this.getUser(userId) || (this.getUsers() && this.getUsers().find(u => u.phone === userId || u.id === userId));
    if (!user) throw new Error('User not found.');
    const numAmt = Math.round(Number(amount));
    if (isNaN(numAmt) || numAmt <= 0) throw new Error('Invalid credit amount.');

    const prevBal = user.walletBalance || 0;
    const newBal = prevBal + numAmt;
    user.walletBalance = newBal;

    const ref = `MAN-${Math.floor(100000 + Math.random() * 900000)}`;
    const nowIso = new Date().toISOString();

    if (!Array.isArray(user.transactions)) user.transactions = [];
    user.transactions.unshift({
      id: `TXN-${ref}`,
      type: 'ADMIN_CREDIT',
      amount: numAmt,
      previousBalance: prevBal,
      newBalance: newBal,
      reference: ref,
      referenceId: ref,
      reason: reason,
      timestamp: nowIso,
      status: 'APPROVED'
    });

    const deposits = this.getWalletDeposits();
    deposits.unshift({
      id: ref,
      reference: ref,
      referenceId: ref,
      userId: user.id,
      userName: user.name || 'Customer',
      phone: user.phone,
      amount: numAmt,
      method: 'ADMIN_MANUAL_CREDIT',
      status: 'APPROVED',
      approvedAt: nowIso,
      adminNote: reason,
      createdAt: nowIso,
      updatedAt: nowIso
    });

    if (this.data.userProfile && (this.data.userProfile.id === user.id || this.data.userProfile.userId12 === user.userId12)) {
      if (!this.data.userProfile.wallet) this.data.userProfile.wallet = {};
      this.data.userProfile.wallet.balance = newBal;
    }

    this.save();
    return { success: true, user, balance: newBal, reference: ref };
  }

  // Wallet Withdrawals API
  getWalletWithdrawals() {
    if (!Array.isArray(this.data.walletWithdrawals)) {
      this.data.walletWithdrawals = [];
    }
    return this.data.walletWithdrawals;
  }

  createWalletWithdrawal({ userId, phone, amount, upiId }) {
    if (!Array.isArray(this.data.walletWithdrawals)) {
      this.data.walletWithdrawals = [];
    }
    const numAmt = Math.round(Number(amount));
    if (isNaN(numAmt) || numAmt <= 0) throw new Error('Invalid withdrawal amount.');
    if (!upiId || !upiId.includes('@')) throw new Error('Valid UPI ID is required (e.g. mobile@upi).');

    const user = this.getUser(userId) || (this.getUsers() && this.getUsers()[0]);
    if (!user) throw new Error('Customer profile not found.');

    const currentBal = (user.walletBalance !== undefined) ? user.walletBalance : (this.data.userProfile?.wallet?.balance || 0);
    if (currentBal < numAmt) {
      throw new Error(`Insufficient wallet balance (Available: ₹${currentBal}, Requested: ₹${numAmt}).`);
    }

    user.walletBalance = currentBal - numAmt;
    const ref = `WIT-${Math.floor(100000 + Math.random() * 900000)}`;
    const nowIso = new Date().toISOString();

    if (!Array.isArray(user.transactions)) user.transactions = [];
    user.transactions.unshift({
      id: `TXN-${ref}`,
      type: 'WITHDRAWAL_PENDING',
      amount: numAmt,
      previousBalance: currentBal,
      newBalance: user.walletBalance,
      reference: ref,
      referenceId: ref,
      reason: `Withdrawal to ${upiId} (Pending Admin Transfer)`,
      timestamp: nowIso,
      status: 'PENDING_APPROVAL'
    });

    if (this.data.userProfile && (this.data.userProfile.id === user.id || this.data.userProfile.userId12 === user.userId12)) {
      if (!this.data.userProfile.wallet) this.data.userProfile.wallet = {};
      this.data.userProfile.wallet.balance = user.walletBalance;
    }

    const withdrawal = {
      id: ref,
      reference: ref,
      referenceId: ref,
      userId: user.id,
      userName: user.name || 'Customer',
      phone: phone || user.phone,
      amount: numAmt,
      upiId: upiId,
      status: 'PENDING_APPROVAL',
      createdAt: nowIso,
      updatedAt: nowIso
    };

    this.data.walletWithdrawals.unshift(withdrawal);
    this.save();
    return withdrawal;
  }

  approveWalletWithdrawal(referenceOrId, adminNote = 'UPI Transfer Completed') {
    const withdrawals = this.getWalletWithdrawals();
    const item = withdrawals.find(w => w.reference === referenceOrId || w.referenceId === referenceOrId || w.id === referenceOrId);
    if (!item) throw new Error(`Withdrawal ${referenceOrId} not found.`);
    if (item.status === 'APPROVED') return { alreadyApproved: true, withdrawal: item };

    const nowIso = new Date().toISOString();
    item.status = 'APPROVED';
    item.approvedAt = nowIso;
    item.adminNote = adminNote;

    const user = this.getUser(item.userId) || (this.getUsers() && this.getUsers()[0]);
    if (user && Array.isArray(user.transactions)) {
      const txn = user.transactions.find(t => t.reference === item.reference || t.referenceId === item.reference);
      if (txn) {
        txn.status = 'APPROVED';
        txn.type = 'WITHDRAWAL';
        txn.reason = `Withdrawal to ${item.upiId} Paid ✓ (${adminNote})`;
      }
    }

    this.save();
    return { success: true, withdrawal: item };
  }

  rejectWalletWithdrawal(referenceOrId, reason = 'Declined by Admin') {
    const withdrawals = this.getWalletWithdrawals();
    const item = withdrawals.find(w => w.reference === referenceOrId || w.referenceId === referenceOrId || w.id === referenceOrId);
    if (!item) throw new Error(`Withdrawal ${referenceOrId} not found.`);
    if (item.status === 'REJECTED') return { alreadyRejected: true, withdrawal: item };

    const nowIso = new Date().toISOString();
    item.status = 'REJECTED';
    item.rejectedAt = nowIso;
    item.rejectionReason = reason;

    // Refund held balance back to user
    const user = this.getUser(item.userId) || (this.getUsers() && this.getUsers()[0]);
    if (user) {
      user.walletBalance = (user.walletBalance || 0) + item.amount;
      if (Array.isArray(user.transactions)) {
        const txn = user.transactions.find(t => t.reference === item.reference || t.referenceId === item.reference);
        if (txn) {
          txn.status = 'REJECTED';
          txn.reason = `Withdrawal Refunded: ${reason}`;
          txn.newBalance = user.walletBalance;
        }
      }
      if (this.data.userProfile && (this.data.userProfile.id === user.id || this.data.userProfile.userId12 === user.userId12)) {
        if (!this.data.userProfile.wallet) this.data.userProfile.wallet = {};
        this.data.userProfile.wallet.balance = user.walletBalance;
      }
    }

    this.save();
    return { success: true, withdrawal: item };
  }

  // Account Disabling & Past Orders Management
  toggleAccountDisabled(accountId) {
    const accounts = this.getAccounts();
    const acc = accounts.find(a => a.id === accountId || a.cleanPhone === accountId || a.phone?.includes(accountId));
    if (!acc) throw new Error(`Account ${accountId} not found.`);
    acc.disabled = !acc.disabled;
    if (acc.disabled) {
      acc.status = 'DISABLED';
    } else {
      acc.status = 'IDLE';
    }
    this.save();
    return acc;
  }

  setAccountPastOrdersCount(accountId, count) {
    const accounts = this.getAccounts();
    const acc = accounts.find(a => a.id === accountId || a.cleanPhone === accountId || a.phone?.includes(accountId));
    if (!acc) throw new Error(`Account ${accountId} not found.`);
    const num = Math.max(0, parseInt(count, 10) || 0);
    acc.pastOrdersCount = num;
    if (num === 0) {
      acc.accountType = 'NEW_ACCOUNT';
      acc.categoryName = '🟢 50% OFF New User Tier';
      acc.couponCode = 'DOMNEW50';
    } else if (num === 1) {
      acc.accountType = 'SECOND_ORDER_ACCOUNT';
      acc.categoryName = '🟡 Cheesy 2nd Order Tier';
      acc.couponCode = 'CHEESY';
    } else {
      acc.accountType = 'EXISTING_ACCOUNT';
      acc.categoryName = '🔵 Party Repeat Order Tier';
      acc.couponCode = 'PARTY';
    }
    this.save();
    return acc;
  }

  // In-App Announcements / Broadcasts
  getAnnouncements() {
    if (!Array.isArray(this.data.announcements)) {
      this.data.announcements = [];
    }
    const now = Date.now();
    return this.data.announcements.filter(a => !a.expiresAt || new Date(a.expiresAt).getTime() > now);
  }

  createAnnouncement({ title, message, type = 'ANNOUNCEMENT', priority = 'HIGH' }) {
    if (!Array.isArray(this.data.announcements)) {
      this.data.announcements = [];
    }
    const id = `ANN-${Date.now().toString(36).toUpperCase()}`;
    const announcement = {
      id,
      title: title || "Notice from Domino's Order Engine",
      message: message || '',
      type,
      priority,
      createdAt: new Date().toISOString()
    };
    this.data.announcements.unshift(announcement);
    this.save();
    return announcement;
  }

  deleteAnnouncement(id) {
    if (!Array.isArray(this.data.announcements)) return false;
    const initialLen = this.data.announcements.length;
    this.data.announcements = this.data.announcements.filter(a => a.id !== id);
    if (this.data.announcements.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  rejectWalletDeposit(referenceOrId, reason = 'Rejected by Admin') {
    const deposits = this.getWalletDeposits();
    const deposit = deposits.find(d => d.reference === referenceOrId || d.id === referenceOrId);
    if (!deposit) throw new Error(`Deposit ${referenceOrId} not found.`);

    const nowIso = new Date().toISOString();
    deposit.status = 'REJECTED';
    deposit.rejectedAt = nowIso;
    deposit.rejectionReason = reason;

    const user = this.getUser(deposit.userId) || (this.getUsers() && this.getUsers()[0]);
    if (user && Array.isArray(user.transactions)) {
      const pendingTxn = user.transactions.find(t => t.reference === deposit.reference);
      if (pendingTxn) {
        pendingTxn.status = 'REJECTED';
        pendingTxn.reason = `Wallet Deposit Rejected: ${reason}`;
      }
    }

    this.save();
    return { success: true, deposit };
  }

  // Active Session Lifecycle & Live Assignment Tracker
  markSessionInUse(accountId, orderId) {
    const accounts = this.getAccounts();
    const acc = accounts.find(a => a.id === accountId || a.cleanPhone === accountId || a.phone?.includes(accountId));
    if (acc) {
      acc.status = 'IN_USE';
      acc.activeOrderId = orderId;
      acc.lastAssignedAt = new Date().toISOString();
      this.save();
    }
    return acc;
  }

  releaseSession(accountIdOrOrderId, wasDelivered = false) {
    const accounts = this.getAccounts();
    const acc = accounts.find(a => a.id === accountIdOrOrderId || a.activeOrderId === accountIdOrOrderId);
    if (acc) {
      acc.status = 'IDLE';
      acc.activeOrderId = null;
      if (wasDelivered) {
        acc.pastOrdersCount = (Number(acc.pastOrdersCount) || 0) + 1;
      }
      this.save();
    }
    return acc;
  }

  getUserOrders(identifier) {
    if (!identifier) return [];
    const allOrders = this.getOrders();
    const cleanId = String(identifier).trim().toLowerCase();
    const cleanDigits = String(identifier).replace(/[^0-9]/g, '').slice(-10);

    const matched = allOrders.filter(o => {
      // 1. Match User Numerical UID (12-digit UID or arbitrary user UID)
      if (cleanId && (
        o.userId12 === cleanId || 
        o.user?.userId12 === cleanId || 
        o.user?.uid === cleanId || 
        o.uid === cleanId || 
        o.userId === cleanId || 
        o.user?.id === cleanId
      )) return true;

      // 2. Match User Email
      if (cleanId && (
        o.user?.email?.toLowerCase() === cleanId || 
        o.address?.email?.toLowerCase() === cleanId
      )) return true;

      // 3. Match Order Reference ID or Domino's Token
      if (cleanId && (
        o.id?.toLowerCase() === cleanId || 
        o.dominosOrderRef?.toLowerCase() === cleanId || 
        o.robot?.dominosOrderRef?.toLowerCase() === cleanId
      )) return true;

      // 4. Match 10-digit Phone
      if (cleanDigits && cleanDigits.length === 10) {
        const uPhone = (o.user?.phone || '').replace(/[^0-9]/g, '').slice(-10);
        const aPhone = (o.address?.phone || '').replace(/[^0-9]/g, '').slice(-10);
        if (uPhone === cleanDigits || aPhone === cleanDigits) return true;
      }
      return false;
    });

    // Sort newest first and limit to 30 orders
    return matched.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 30);
  }

  /**
   * Determine applicable promo coupon based on account order history and cart subtotal:
   * - 1st order on new account: NEWBIE100 (min ₹199 subtotal, non-discounted items)
   * - 2nd order on account: NEW100 (min ₹249 subtotal) or admin assigned coupon
   * - 3rd / repeat order on account: LITE1160 (min ₹299 subtotal) or admin assigned coupon
   */
  getApplicableCouponForAccount(account, cartSubtotal = 0, cartItems = []) {
    const rules = this.data.couponRules || {};
    const pastOrders = Number(account?.pastOrdersCount || 0);

    // Verify non-discounted pricing:
    // Domino's India promo coupons are rejected on Pizza Mania, Value Combos, or items already discounted below original menu MRP
    const hasDiscountedCombos = Array.isArray(cartItems) && cartItems.some(i => {
      const name = (i.name || '').toLowerCase();
      const cat = (i.category || '').toLowerCase();
      return name.includes('combo') || name.includes('mania') || name.includes('everyday value') || cat.includes('combo') || cat.includes('mania');
    });

    if (pastOrders === 0) {
      // Tier 1: Brand New Account
      const couponCode = rules.firstOrderCoupon || 'NEWBIE100';
      const minOrderVal = Number(rules.firstOrderMinCart || 199);
      const isEligible = cartSubtotal >= minOrderVal && !hasDiscountedCombos;
      return {
        tier: 'NEW_ACCOUNT',
        pastOrders: 0,
        couponCode,
        minOrderVal,
        isEligible,
        discountAmount: Number(rules.firstOrderDiscount || 100),
        reason: !isEligible ? (hasDiscountedCombos ? 'Domino\'s promo codes are valid only on regular priced pizzas (not applicable on Pizza Mania / Combos).' : `Minimum cart value of ₹${minOrderVal} required for coupon ${couponCode}. Current: ₹${cartSubtotal}`) : null
      };
    } else if (pastOrders === 1) {
      // Tier 2: Second Order Account
      const couponCode = rules.secondOrderCoupon || 'NEW100';
      const minOrderVal = Number(rules.secondOrderMinCart || 249);
      const isEligible = cartSubtotal >= minOrderVal && !hasDiscountedCombos;
      return {
        tier: 'SECOND_ORDER_ACCOUNT',
        pastOrders: 1,
        couponCode,
        minOrderVal,
        isEligible,
        discountAmount: Number(rules.secondOrderDiscount || 100),
        reason: !isEligible ? (hasDiscountedCombos ? 'Domino\'s promo codes are valid only on regular priced pizzas (not applicable on Pizza Mania / Combos).' : `Minimum cart value of ₹${minOrderVal} required for coupon ${couponCode}. Current: ₹${cartSubtotal}`) : null
      };
    } else {
      // Tier 3: Third / Repeat Order Account
      const couponCode = rules.thirdOrderCoupon || rules.regularOrderCoupon || 'LITE1160';
      const minOrderVal = Number(rules.thirdOrderMinCart || rules.regularOrderMinCart || 299);
      const isEligible = cartSubtotal >= minOrderVal && !hasDiscountedCombos;
      return {
        tier: 'REPEAT_ACCOUNT',
        pastOrders,
        couponCode,
        minOrderVal,
        isEligible,
        discountAmount: Number(rules.thirdOrderDiscount || rules.regularOrderDiscount || 100),
        reason: !isEligible ? (hasDiscountedCombos ? 'Domino\'s promo codes are valid only on regular priced pizzas (not applicable on Pizza Mania / Combos).' : `Minimum cart value of ₹${minOrderVal} required for coupon ${couponCode}. Current: ₹${cartSubtotal}`) : null
      };
    }
  }

  // Admin User Address Management (Max 3 Addresses Enforced)
  adminGetUserAddresses(userId) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    return user.savedAddresses || [];
  }

  adminSaveUserAddress(userId, address) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    if (!user.savedAddresses) user.savedAddresses = [];

    const existingIdx = user.savedAddresses.findIndex(a => a.id === address.id);
    if (existingIdx < 0 && user.savedAddresses.length >= 3) {
      const nonDefaultIndices = [];
      user.savedAddresses.forEach((a, idx) => {
        if (!a.isDefault) nonDefaultIndices.push(idx);
      });
      const evictIdx = nonDefaultIndices.length > 0 ? nonDefaultIndices[nonDefaultIndices.length - 1] : (user.savedAddresses.length - 1);
      user.savedAddresses.splice(evictIdx, 1);
    }

    if (!address.id) address.id = `ADDR-${Date.now().toString().slice(-6)}`;
    address.label = address.label || 'Home';

    if (existingIdx >= 0) {
      if (address.isDefault) user.savedAddresses.forEach(a => a.isDefault = false);
      user.savedAddresses[existingIdx] = { ...user.savedAddresses[existingIdx], ...address };
    } else {
      if (address.isDefault || user.savedAddresses.length === 0) {
        user.savedAddresses.forEach(a => a.isDefault = false);
        address.isDefault = true;
      }
      user.savedAddresses.unshift(address);
    }
    user.addressCount = user.savedAddresses.length;

    // Sync to userProfile if matching
    if (this.data.userProfile && (!this.data.userProfile.phone || this.data.userProfile.phone.includes(user.cleanPhone))) {
      this.data.userProfile.savedAddresses = user.savedAddresses;
    }

    this.save();
    return user.savedAddresses;
  }

  adminDeleteUserAddress(userId, addressId) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    if (!user.savedAddresses) return [];

    const wasDefault = user.savedAddresses.find(a => a.id === addressId)?.isDefault;
    user.savedAddresses = user.savedAddresses.filter(a => a.id !== addressId);
    if (wasDefault && user.savedAddresses.length > 0) {
      user.savedAddresses[0].isDefault = true;
    }
    user.addressCount = user.savedAddresses.length;

    if (this.data.userProfile && (!this.data.userProfile.phone || this.data.userProfile.phone.includes(user.cleanPhone))) {
      this.data.userProfile.savedAddresses = user.savedAddresses;
    }

    this.save();
    return user.savedAddresses;
  }

  adminSetDefaultUserAddress(userId, addressId) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found.');
    if (!user.savedAddresses) return [];

    user.savedAddresses.forEach(a => {
      a.isDefault = (a.id === addressId);
    });

    if (this.data.userProfile && (!this.data.userProfile.phone || this.data.userProfile.phone.includes(user.cleanPhone))) {
      this.data.userProfile.savedAddresses = user.savedAddresses;
    }

    this.save();
    return user.savedAddresses;
  }

  // =========================================================================
  // IN-APP NOTIFICATIONS & BROADCASTS
  // =========================================================================
  getNotifications() {
    if (!this.data.notifications || !Array.isArray(this.data.notifications)) {
      this.data.notifications = [
        {
          id: 'NOTIF-01',
          title: "🎉 Welcome to Domino's Order Engine Platform!",
          message: 'Order authentic Domino\'s pizzas at 50% discount with instant live tracking & autonomous robot ordering.',
          type: 'OFFER',
          badge: '50% OFF',
          active: true,
          createdAt: new Date().toISOString()
        }
      ];
      this.save();
    }
    return this.data.notifications.filter(n => n.active !== false);
  }

  broadcastNotification({ title, message, type = 'OFFER', badge = 'ANNOUNCEMENT' }) {
    if (!this.data.notifications || !Array.isArray(this.data.notifications)) {
      this.data.notifications = [];
    }
    const notif = {
      id: `NOTIF-${Date.now().toString().slice(-6)}`,
      title: title || "Domino's Order Engine Notice",
      message: message || '',
      type: type || 'OFFER',
      badge: badge || 'OFFER',
      active: true,
      createdAt: new Date().toISOString()
    };
    this.data.notifications.unshift(notif);
    this.save();
    return notif;
  }

  deleteNotification(id) {
    if (!this.data.notifications) return [];
    this.data.notifications = this.data.notifications.filter(n => n.id !== id);
    this.save();
    return this.data.notifications;
  }

  // =========================================================================
  // SUPPORT TICKETS & REAL-TIME HELP CHAT SYSTEM
  // =========================================================================

  getTickets(userPhone = null) {
    if (!Array.isArray(this.data.tickets)) {
      this.data.tickets = [];
      this.save();
    }
    if (userPhone) {
      const clean = userPhone.replace(/[^0-9]/g, '').slice(-10);
      return this.data.tickets.filter(t => (t.userPhone || '').replace(/[^0-9]/g, '').slice(-10) === clean);
    }
    return this.data.tickets;
  }

  getTicketById(id) {
    if (!Array.isArray(this.data.tickets)) return null;
    return this.data.tickets.find(t => t.id === id) || null;
  }

  createTicket({ orderId = null, userId = null, userPhone, userName, category = 'OTHER', description = '', imageUrl = null }) {
    if (!Array.isArray(this.data.tickets)) this.data.tickets = [];

    const ticketId = `TCK-${Date.now().toString().slice(-6)}`;
    const categoryLabels = {
      MISSING_ITEM: '🍕 Missing or Incomplete Items',
      DELAYED_ORDER: '⏳ Significant Delivery Delay',
      RIDER_UNREACHABLE: '🛵 Rider Unreachable / Delivery Issue',
      COLD_FOOD_QUALITY: '📦 Cold Pizza / Quality Issue',
      WRONG_ITEMS: '❌ Wrong Items Received',
      PAYMENT_REFUND: '💳 Payment / Refund Inquiry',
      OTHER: '💬 General Domino\'s Help'
    };

    // Automated Chatbot First-Response based on query category
    const triageBotReplies = {
      MISSING_ITEM: `Hello ${userName || 'there'}! I am your Domino\'s Order Engine Support Assistant. We have registered your report regarding missing items for Order ${orderId || 'your recent order'}. Our admin manager has been alerted to review the kitchen dispatch logs and CCTV packaging checks immediately.`,
      DELAYED_ORDER: `Hi ${userName || 'there'}! We apologize for the wait. We are cross-referencing your order ${orderId || ''} with the Domino's store oven queue. Our admin team will expedite this with the store manager right away.`,
      RIDER_UNREACHABLE: `Hi ${userName || 'there'}! We have pinged the store dispatcher regarding the rider assigned to ${orderId || 'your order'}. The admin manager is checking live GPS telemetry now.`,
      COLD_FOOD_QUALITY: `We are truly sorry that the food quality did not meet Domino's standard. We have recorded your feedback and photo proof. An admin support specialist will review this for an immediate resolution or replacement voucher.`,
      PAYMENT_REFUND: `Thank you for reaching out regarding payment/refund for Order ${orderId || ''}. Your payment verification record has been attached to this ticket for admin review.`,
      OTHER: `Hello! How can we assist you with your Domino's order today? An admin support specialist will respond shortly.`
    };

    const initialMessages = [
      {
        id: `msg-${Date.now()}-1`,
        sender: 'BOT',
        senderName: "Domino's Order Engine Bot",
        text: triageBotReplies[category] || triageBotReplies.OTHER,
        timestamp: new Date().toISOString()
      }
    ];

    if (description && description.trim()) {
      initialMessages.push({
        id: `msg-${Date.now()}-2`,
        sender: 'USER',
        senderName: userName || 'Customer',
        text: description.trim(),
        imageUrl: imageUrl || null,
        timestamp: new Date().toISOString()
      });
    }

    const newTicket = {
      id: ticketId,
      orderId: orderId || null,
      userId: userId || null,
      userPhone: userPhone || '',
      userName: userName || 'Customer',
      category: category,
      categoryLabel: categoryLabels[category] || category,
      description: description || '',
      imageUrl: imageUrl || null,
      status: 'OPEN', // OPEN, IN_PROGRESS, RESOLVED, CLOSED
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: initialMessages
    };

    this.data.tickets.unshift(newTicket);
    this.save();
    return newTicket;
  }

  addTicketMessage(ticketId, { sender = 'USER', senderName = 'Customer', text = '', imageUrl = null }) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) return null;

    if (!Array.isArray(ticket.messages)) ticket.messages = [];
    const msg = {
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      sender: sender, // USER, ADMIN, BOT
      senderName: senderName,
      text: text,
      imageUrl: imageUrl || null,
      timestamp: new Date().toISOString()
    };

    ticket.messages.push(msg);
    ticket.updatedAt = new Date().toISOString();
    if (sender === 'ADMIN' && ticket.status === 'OPEN') {
      ticket.status = 'IN_PROGRESS';
    }
    this.save();
    return msg;
  }

  updateTicketStatus(ticketId, status) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) return null;
    ticket.status = status;
    ticket.updatedAt = new Date().toISOString();
    this.save();
    return ticket;
  }

  // =========================================================================
  // CUSTOMER USER DIRECTORY & ADMIN USER MANAGEMENT
  // =========================================================================

  getAllCustomerUsers() {
    const usersMap = new Map();

    // 1. Current user profile
    const profile = this.getUserProfile();
    if (profile && profile.phone) {
      const clean = profile.phone.replace(/[^0-9]/g, '').slice(-10);
      usersMap.set(clean, {
        phone: profile.phone,
        cleanPhone: clean,
        name: profile.name || 'Customer',
        email: profile.email || '',
        totalOrders: 0,
        totalSpent: 0,
        lastOrderDate: null,
        source: 'PROFILE'
      });
    }

    // 2. Scan all historical orders to aggregate users
    const orders = this.getOrders();
    for (const o of orders) {
      const rawPhone = o.user?.phone || o.address?.phone || '';
      const clean = rawPhone.replace(/[^0-9]/g, '').slice(-10);
      if (!clean || clean.length !== 10) continue;

      const spent = parseFloat(o.pricing?.grandTotal || o.pricing?.total || 0);
      if (!usersMap.has(clean)) {
        usersMap.set(clean, {
          phone: `+91 ${clean}`,
          cleanPhone: clean,
          name: o.user?.name || o.address?.name || 'Customer',
          email: o.user?.email || '',
          totalOrders: 1,
          totalSpent: spent,
          lastOrderDate: o.createdAt || null,
          source: 'ORDER'
        });
      } else {
        const u = usersMap.get(clean);
        u.totalOrders += 1;
        u.totalSpent += spent;
        if (o.createdAt && (!u.lastOrderDate || new Date(o.createdAt) > new Date(u.lastOrderDate))) {
          u.lastOrderDate = o.createdAt;
        }
        if (o.user?.name && (!u.name || u.name === 'Customer')) {
          u.name = o.user.name;
        }
      }
    }

    return Array.from(usersMap.values());
  }

  adminEditCustomerUser(oldPhone, { newPhone, newName, newEmail }) {
    const cleanOld = (oldPhone || '').replace(/[^0-9]/g, '').slice(-10);
    const cleanNew = (newPhone || '').replace(/[^0-9]/g, '').slice(-10);

    let updatedOrdersCount = 0;

    // 1. Update user profile if matching
    const profile = this.getUserProfile();
    const cleanProfilePhone = (profile.phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (cleanProfilePhone === cleanOld) {
      if (cleanNew && cleanNew.length === 10) profile.phone = `+91 ${cleanNew}`;
      if (newName) profile.name = newName.trim();
      if (newEmail) profile.email = newEmail.trim();
      if (profile.savedAddresses) {
        profile.savedAddresses.forEach(a => {
          if ((a.phone || '').replace(/[^0-9]/g, '').slice(-10) === cleanOld) {
            if (cleanNew) a.phone = `+91 ${cleanNew}`;
            if (newName) a.name = newName.trim();
          }
        });
      }
    }

    // 2. Update all customer orders matching this phone
    if (Array.isArray(this.data.orders)) {
      for (const o of this.data.orders) {
        const oPhone = (o.user?.phone || o.address?.phone || '').replace(/[^0-9]/g, '').slice(-10);
        if (oPhone === cleanOld) {
          if (!o.user) o.user = {};
          if (cleanNew) o.user.phone = `+91 ${cleanNew}`;
          if (newName) o.user.name = newName.trim();
          if (newEmail) o.user.email = newEmail.trim();

          if (o.address) {
            if (cleanNew) o.address.phone = `+91 ${cleanNew}`;
            if (newName) o.address.name = newName.trim();
          }
          updatedOrdersCount++;
        }
      }
    }

    // 3. Update tickets matching this phone
    if (Array.isArray(this.data.tickets)) {
      for (const t of this.data.tickets) {
        const tPhone = (t.userPhone || '').replace(/[^0-9]/g, '').slice(-10);
        if (tPhone === cleanOld) {
          if (cleanNew) t.userPhone = `+91 ${cleanNew}`;
          if (newName) t.userName = newName.trim();
        }
      }
    }

    this.save();
    return {
      success: true,
      cleanOld,
      cleanNew: cleanNew || cleanOld,
      newName: newName || profile.name,
      updatedOrdersCount
    };
  }

  // =========================================================================
  // SYSTEM MAINTENANCE MODE
  // =========================================================================
  getMaintenanceMode() {
    if (!this.data.maintenanceMode) {
      this.data.maintenanceMode = {
        active: false,
        message: "Domino's Order Engine is currently undergoing scheduled maintenance. We will be back shortly!",
        until: null,
        updatedAt: null
      };
      this.save();
    }
    // Check if auto-expire time has passed
    if (this.data.maintenanceMode.active && this.data.maintenanceMode.until) {
      const untilTime = new Date(this.data.maintenanceMode.until).getTime();
      if (!isNaN(untilTime) && Date.now() >= untilTime) {
        this.data.maintenanceMode.active = false;
        this.data.maintenanceMode.updatedAt = new Date().toISOString();
        this.save();
      }
    }
    return this.data.maintenanceMode;
  }

  setMaintenanceMode({ active, message, until }) {
    const current = this.getMaintenanceMode();
    current.active = Boolean(active);
    if (message !== undefined && message !== null) {
      current.message = String(message).trim();
    }
    if (until !== undefined) {
      current.until = until || null;
    }
    current.updatedAt = new Date().toISOString();
    this.save();
    return current;
  }
}

module.exports = new Database();
