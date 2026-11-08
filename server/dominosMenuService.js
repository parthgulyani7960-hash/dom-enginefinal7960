/**
 * Live Domino's India Menu & Catalog Engine
 * Fetches and maintains the full official Domino's India catalog across all categories:
 *  - Veg Pizzas
 *  - Non-Veg Pizzas
 *  - Pizza Mania
 *  - Garlic Breads & Dips (Sides)
 *  - Pastas
 *  - Desserts
 *  - Beverages
 * 
 * Provides real-time, store-specific availability resolution:
 *  - Automatically tags out-of-stock items as "Unavailable at your area"
 *  - Supports mandatory current-location gating
 */

const fs = require('fs');
const path = require('path');
const locationService = require('./locationService');

const DOMINOS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const MEDIA_BASE_URL = 'https://images.dominos.co.in/nextgen-catalog/media/prod/';

// In-memory cache for store menus (15 min TTL)
const storeMenuCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

class DominosMenuService {
  constructor() {
    this.masterMenu = [];
    this.combos = [];
    this.isLoaded = false;
    this.loadCatalog();
  }

  /**
   * Load master menu from extracted official catalog or fallback
   */
  loadCatalog() {
    try {
      const dataCatalogPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
      const extractedPath = path.join(__dirname, '..', 'scratch', 'dominos_extracted_menu.json');
      const catalogPath = fs.existsSync(dataCatalogPath) ? dataCatalogPath : extractedPath;
      if (fs.existsSync(catalogPath)) {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        this.masterMenu = JSON.parse(raw);
        console.log(`[MENU-SERVICE] Loaded ${this.masterMenu.length} official items from catalog (${path.basename(catalogPath)})`);
      }
    } catch (err) {
      console.warn('[MENU-SERVICE] Note loading catalog:', err.message);
    }

    if (!this.masterMenu || this.masterMenu.length === 0) {
      this.masterMenu = this.getDefaultFallbackCatalog();
    }

    const storeJsonPath = path.join(__dirname, '..', 'data', 'store.json');
    try {
      if (fs.existsSync(storeJsonPath)) {
        const storeData = JSON.parse(fs.readFileSync(storeJsonPath, 'utf8'));
        if (storeData.combos && storeData.combos.length > 0) {
          this.combos = storeData.combos;
        }
      }
    } catch (e) {}

    if (!this.combos || this.combos.length === 0) {
      this.combos = this.getDefaultCombos();
    }
    this.isLoaded = true;
  }

  /**
   * Normalize item category from Domino's family and name
   */
  normalizeCategory(product) {
    const fam = (product.family && product.family.name) || '';
    const nameLower = (product.name || '').toLowerCase();
    const catNames = (product.categoryInfo || []).map(c => c.categoryName || c.name || '');
    const productModel = product.metadataMap?.productModel?.values?.[0] || '';
    const sizeCode = product.sizeCode || '';

    const isVeg = product.metadataMap?.foodLabel?.values?.[0] === 'VEG' ||
                  product.metadataMap?.filterKeys?.values?.includes('Veg') ||
                  product.isVeg === true ||
                  (!nameLower.includes('chicken') && !nameLower.includes('meat') && !nameLower.includes('keema') && !nameLower.includes('egg') && !catNames.some(c => c.toLowerCase().includes('non-veg')));

    // Pizza Mania check
    if (
      productModel === 'PIZZA-MANIA' ||
      sizeCode === 'PM' ||
      catNames.includes('Pizza Mania') ||
      nameLower.includes('mania') ||
      (nameLower.includes('classic') && fam === 'Pizza' && !nameLower.includes('cold coffee')) ||
      (nameLower.includes('loaded') && fam === 'Pizza' && !nameLower.includes('taco') && !nameLower.includes('parcel'))
    ) {
      return 'Pizza Mania';
    }

    // Pastas
    if (nameLower.includes('pasta')) {
      return 'Pastas';
    }

    // Sides, Breads, Dips, Burger Pizza, Tacos
    if (catNames.includes('Garlic Breads & Dips') || catNames.includes('Tacos & Parcels') || nameLower.includes('burger pizza') || nameLower.includes('garlic') || nameLower.includes('bread') || nameLower.includes('dip') || nameLower.includes('taco') || nameLower.includes('parcel') || nameLower.includes('meltz') || nameLower.includes('bites') || fam === 'Bread' || fam === 'Sides') {
      return 'Garlic Breads & Sides';
    }

    // Desserts
    if (fam === 'Dessert' || catNames.includes('Desserts') || nameLower.includes('cake') || nameLower.includes('lava') || nameLower.includes('mousse') || nameLower.includes('brownie')) {
      return 'Desserts';
    }

    // Beverages
    if (fam === 'Beverage' || catNames.includes('Beverages') || nameLower.includes('pepsi') || nameLower.includes('mirinda') || nameLower.includes('7up') || nameLower.includes('drink') || nameLower.includes('water') || nameLower.includes('coffee') || nameLower.includes('lipton')) {
      return 'Beverages';
    }

    // Standard Pizzas
    return isVeg ? 'Veg Pizza' : 'Non-Veg Pizza';
  }

  /**
   * Extract high-resolution CDN image URL from product mediaList
   */
  extractImageUrl(product, category) {
    if (product.mediaList && product.mediaList.length > 0) {
      for (const m of product.mediaList) {
        if (m.mediaUrls) {
          const u = m.mediaUrls.WebHomeProductV1 || m.mediaUrls.menu || m.mediaUrls.cart || m.mediaUrls.HomeProductV1 || Object.values(m.mediaUrls)[0];
          if (u && typeof u === 'string') {
            return u.startsWith('http') ? u : `${MEDIA_BASE_URL}${u}`;
          }
        }
      }
    }

    // High quality official Domino's CDN fallbacks
    if (category === 'Veg Pizza') return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';
    if (category === 'Non-Veg Pizza') return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/e0717098-c280-4fc4-a692-ca6dde1021d6_TandooriMaxxFHomeProductVxpx.webp';
    if (category === 'Pizza Mania') return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/40676ebf-2627-49f4-a221-aa83838213cb_PMClassicMenu.webp';
    if (category === 'Garlic Breads & Sides') return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/46ad3a45-5866-4984-8bb0-f8d4c660eef1_HomeProductV1TandooriLoadedVegTaco720x700px.webp';
    if (category === 'Desserts') return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/1f7ddf95-d357-4d61-8ab0-b0bafbeedad1_ChocoLavaCakeHomeProductV1.webp';
    if (category === 'Beverages') return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/d9375215-52ed-447f-b0b9-90d107535c1c_BlueberryMousseHOMEPRODUCT.webp';
    return 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp';
  }

  /**
   * Fetch store-specific menu and availability directly from Domino's SSR page
   */
  async fetchStoreMenu(storeId) {
    if (!storeId) return null;

    const cacheKey = String(storeId);
    if (storeMenuCache.has(cacheKey)) {
      const cached = storeMenuCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }
    }

    const url = `https://pizzaonline.dominos.co.in/jfl-discovery-ui/en/dt/menu-v1/${storeId}`;
    console.log(`[DOMINOS-MENU] Fetching live store menu: ${url}`);

    try {
      const res = await fetch(url, { headers: DOMINOS_HEADERS });
      if (!res.ok) {
        console.warn(`[DOMINOS-MENU] Store ${storeId} returned ${res.status} (cached to prevent hammering)`);
        storeMenuCache.set(cacheKey, { timestamp: Date.now(), data: null });
        return null;
      }

      const content = await res.text();
      const startTag = '<menu-products data-results="';
      const startIdx = content.indexOf(startTag);
      if (startIdx === -1) {
        console.warn(`[DOMINOS-MENU] Could not find menu-products tag for store ${storeId}`);
        return null;
      }

      const valStart = startIdx + startTag.length;
      let valEnd = -1;
      for (let i = valStart; i < content.length; i++) {
        if (content[i] === '"' && content[i - 1] !== '\\') {
          valEnd = i;
          break;
        }
      }

      const rawAttr = content.slice(valStart, valEnd);
      const unescaped = rawAttr.replace(/&quot;/g, '"')
                               .replace(/&amp;/g, '&')
                               .replace(/&lt;/g, '<')
                               .replace(/&gt;/g, '>')
                               .replace(/&#39;/g, "'");

      const parsed = JSON.parse(unescaped);
      const products = parsed.productDefinitions || [];

      // Build store inventory map: menuCode / skuId -> availability info
      const storeItems = new Map();
      products.forEach(p => {
        const prodDisabled = p.isCartDisabled || p.cartDisabled || p.masterDisabled || (p.disabledOrderTypes && p.disabledOrderTypes.includes('D'));
        
        let availableVariantsCount = 0;
        const variants = (p.variants || []).map(v => {
          const vDisabled = v.isCartDisabled || v.cartDisabled || v.masterDisabled || (v.disabledOrderTypes && v.disabledOrderTypes.includes('D'));
          if (!vDisabled) availableVariantsCount++;
          const sizeAttr = (v.attributes || []).find(a => (a.name || '').toLowerCase() === 'size')?.value;
          const crustAttr = (v.attributes || []).find(a => (a.name || '').toLowerCase() === 'crust')?.value;
          return {
            skuId: v.skuId,
            isAvailable: !vDisabled,
            size: sizeAttr,
            crust: crustAttr,
            price: (v.price && v.price.currentPrice) || v.currentPrice || 0,
            regularPrice: (v.price && v.price.regularPrice) || v.regularPrice || 0
          };
        });

        const isAvailable = !prodDisabled && (variants.length === 0 || availableVariantsCount > 0);

        const itemInfo = {
          productMasterUID: p.productMasterUID,
          name: p.name,
          menuCode: p.menuCode,
          parentSkuId: p.parentSkuId,
          isAvailable,
          variants
        };

        // If item already exists, merge variants so we don't lose sizes/crusts
        const existing = storeItems.get(p.menuCode);
        if (!existing) {
          if (p.menuCode) storeItems.set(p.menuCode, itemInfo);
          if (p.parentSkuId) storeItems.set(p.parentSkuId, itemInfo);
          if (p.name) storeItems.set(p.name.toLowerCase().trim(), itemInfo);
        } else {
          // Merge variants
          variants.forEach(nv => {
            if (!existing.variants.some(ev => ev.skuId === nv.skuId || (ev.size === nv.size && ev.crust === nv.crust))) {
              existing.variants.push(nv);
            }
          });
          if (p.name && !storeItems.has(p.name.toLowerCase().trim())) {
            storeItems.set(p.name.toLowerCase().trim(), existing);
          }
        }
      });

      const result = {
        storeId,
        totalItemsCount: products.length,
        storeItems,
        rawProducts: products
      };

      storeMenuCache.set(cacheKey, { timestamp: Date.now(), data: result });
      return result;
    } catch (err) {
      console.error(`[DOMINOS-MENU] Error fetching store ${storeId} menu:`, err.message);
      storeMenuCache.set(cacheKey, { timestamp: Date.now(), data: null });
      return null;
    }
  }

  /**
   * Get catalog with store-specific availability
   */
  async getCatalog({ lat, lng, storeId, hideUnavailable = true } = {}) {
    let resolvedStore = null;
    let isServiceable = true;
    let unserviceableReason = null;
    let storeInventory = null;
    const hasCoordinates = lat !== undefined && lng !== undefined && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));

    // Step 1: Resolve Store if coordinates or storeId provided
    if (hasCoordinates) {
      try {
        const resolution = await locationService.resolveStoreByCoordinates(parseFloat(lat), parseFloat(lng));
        resolvedStore = resolution.assignedStore || (resolution.nearestStore ? resolution.nearestStore.store : null);
        isServiceable = resolution.serviceable !== false;
        unserviceableReason = resolution.nearestStore?.unserviceableReason || (isServiceable ? null : 'Domino\'s India does not currently deliver to this location.');

        if (resolvedStore && resolvedStore.storeId) {
          storeInventory = await this.fetchStoreMenu(resolvedStore.storeId);
        }
      } catch (err) {
        console.warn('[MENU-CATALOG] Store resolution note:', err.message);
      }
    } else if (storeId) {
      storeInventory = await this.fetchStoreMenu(storeId);
    }

    // Step 2: Map availability onto Master Menu with exact store pricing & full variant schema
    const menuWithAvailability = this.masterMenu.map(item => {
      let isAvailable = true;
      let unavailableReason = null;
      let livePrice = item.price;
      let liveOriginalPrice = item.originalPrice;
      let itemVariants = item.variants || [];
      let itemSizeCrustMap = item.sizeCrustPricingMap || {};
      let itemAllowedSizes = item.allowedSizes || (item.category?.toLowerCase().includes('pizza') ? ['Regular', 'Medium', 'Large'] : ['Regular']);
      let itemAllowedCrusts = item.allowedCrusts || (item.category?.toLowerCase().includes('pizza') ? ['New Hand Tossed', 'Cheese Burst', 'Fresh Pan Pizza'] : ['New Hand Tossed']);

      if (hasCoordinates && !isServiceable) {
        isAvailable = false;
        unavailableReason = unserviceableReason || 'Delivery unavailable at this location';
      } else if (storeInventory) {
        // Match against store inventory by dominosCode, parentSkuId, or item name
        const match = storeInventory.storeItems.get(item.dominosCode) ||
                      (item.parentSkuId && storeInventory.storeItems.get(item.parentSkuId)) ||
                      storeInventory.storeItems.get(item.name.toLowerCase().trim());

        if (match && match.isAvailable === false) {
          // Explicitly out of stock or disabled by this store
          isAvailable = false;
          unavailableReason = `Out of stock at ${resolvedStore?.storeName || 'your area'}`;
        } else if (match) {
          if (match.variants && match.variants.length > 0) {
            itemVariants = match.variants;
            const sizeCrustPricingMap = {};
            const sizesSet = new Set();
            const crustsSet = new Set();

            match.variants.forEach(v => {
              const sz = v.size || 'Regular';
              const cr = v.crust || 'New Hand Tossed';
              sizesSet.add(sz);
              crustsSet.add(cr);
              if (v.price) {
                if (!sizeCrustPricingMap[sz]) sizeCrustPricingMap[sz] = {};
                sizeCrustPricingMap[sz][cr] = v.price;
              }
            });

            if (Object.keys(sizeCrustPricingMap).length > 0) {
              itemSizeCrustMap = sizeCrustPricingMap;
            }
            if (sizesSet.size > 0) itemAllowedSizes = Array.from(sizesSet);
            if (crustsSet.size > 0) itemAllowedCrusts = Array.from(crustsSet);

            const regVariant = match.variants.find(v => (v.size || '').toLowerCase() === 'regular') || match.variants[0];
            if (regVariant && regVariant.price) {
              livePrice = regVariant.price;
              if (regVariant.regularPrice && regVariant.regularPrice > livePrice) {
                liveOriginalPrice = regVariant.regularPrice;
              }
            }
          }
        }
      }

      return {
        ...item,
        price: livePrice,
        originalPrice: liveOriginalPrice,
        isAvailable,
        unavailableReason,
        variants: itemVariants,
        sizeCrustPricingMap: itemSizeCrustMap,
        allowedSizes: itemAllowedSizes,
        allowedCrusts: itemAllowedCrusts
      };
    });

    // Step 3: Mandatory / Automatic filtering of unavailable items & combos
    const combosWithAvailability = this.combos.map(combo => {
      let isAvailable = isServiceable;
      let unavailableReason = null;
      if (!isServiceable) {
        isAvailable = false;
        unavailableReason = unserviceableReason || 'Delivery unavailable at this location';
      } else if (storeInventory && combo.includedItems) {
        for (const inc of combo.includedItems) {
          const match = storeInventory.storeItems.get(inc.dominosCode) ||
                        storeInventory.storeItems.get(inc.name.toLowerCase().trim());
          if (match && !match.isAvailable) {
            isAvailable = false;
            unavailableReason = `${inc.name} is out of stock at this store`;
            break;
          }
        }
      }
      return {
        ...combo,
        isAvailable,
        unavailableReason
      };
    });

    const finalCombos = (hideUnavailable && combosWithAvailability.some(c => c.isAvailable))
      ? combosWithAvailability.filter(c => c.isAvailable)
      : combosWithAvailability;

    let finalMenu = (hideUnavailable && menuWithAvailability.some(i => i.isAvailable))
      ? menuWithAvailability.filter(i => i.isAvailable)
      : menuWithAvailability;

    // Safety guarantee: Never return an empty catalog if catalog items exist
    if (finalMenu.length === 0 && menuWithAvailability.length > 0) {
      finalMenu = menuWithAvailability;
    }

    return {
      success: true,
      store: resolvedStore,
      isServiceable,
      unserviceableReason,
      locationProvided: hasCoordinates,
      totalCatalogItems: this.masterMenu.length,
      availableItemsCount: finalMenu.filter(i => i.isAvailable).length,
      unavailableItemsCount: finalMenu.filter(i => !i.isAvailable).length,
      combos: finalCombos,
      menu: finalMenu
    };
  }

  /**
   * Real-time Cart & Pricing Verification against Domino's Store Inventory
   */
  async verifyCart({ items = [], storeId, lat, lng } = {}) {
    let resolvedStore = null;
    let storeInventory = null;
    let isServiceable = true;

    if (lat !== undefined && lng !== undefined && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng))) {
      try {
        const res = await locationService.resolveStoreByCoordinates(parseFloat(lat), parseFloat(lng));
        resolvedStore = res.assignedStore || (res.nearestStore ? res.nearestStore.store : null);
        isServiceable = res.serviceable !== false;
      } catch (e) {}
    }

    const targetStoreId = storeId || (resolvedStore && resolvedStore.storeId);
    if (targetStoreId) {
      storeInventory = await this.fetchStoreMenu(targetStoreId);
    }

    let itemsSubtotal = 0;
    let hasUnavailableItems = false;
    const verifiedItems = (items || []).map(cartItem => {
      let isAvailable = isServiceable;
      let unavailableReason = null;
      let currentPrice = Number(cartItem.price) || 0;

      if (!isServiceable) {
        isAvailable = false;
        unavailableReason = 'Store not delivering to this location';
        hasUnavailableItems = true;
      } else if (storeInventory && storeInventory.storeItems) {
        // 1. Combo Constituent Items Availability Audit
        if (cartItem.isCombo && Array.isArray(cartItem.includedItems) && cartItem.includedItems.length > 0) {
          for (const sub of cartItem.includedItems) {
            const subCleanName = (sub.name || '').toLowerCase().trim();
            const subBaseName = subCleanName.replace(/pizza|mania/gi, '').trim();
            const subMatch = storeInventory.storeItems.get(sub.dominosCode) ||
                             storeInventory.storeItems.get(subCleanName) ||
                             storeInventory.storeItems.get(subBaseName);
            if (subMatch && subMatch.isAvailable === false) {
              isAvailable = false;
              unavailableReason = `Part of combo (${sub.name}) is out of stock at Domino's ${resolvedStore?.storeName || 'kitchen'}`;
              hasUnavailableItems = true;
              break;
            }
          }
        } else {
          // 2. Direct Item & Variant Availability Audit
          const strippedId = (cartItem.id || '').replace(/^DOM-/, '');
          const cleanName = (cartItem.name || '').toLowerCase().trim();
          const baseName = cleanName.replace(/pizza|mania/gi, '').trim();

          const match = storeInventory.storeItems.get(cartItem.dominosCode) ||
                        storeInventory.storeItems.get(strippedId) ||
                        storeInventory.storeItems.get(cartItem.id) ||
                        storeInventory.storeItems.get(cleanName) ||
                        storeInventory.storeItems.get(baseName);

          if (!match || match.isAvailable === false) {
            isAvailable = false;
            unavailableReason = `Out of stock at Domino's ${resolvedStore?.storeName || 'kitchen'}`;
            hasUnavailableItems = true;
          } else if (match.variants && match.variants.length > 0) {
            const reqSize = (cartItem.customSize || cartItem.size || 'Regular').toLowerCase();
            const reqCrust = (cartItem.customCrust || cartItem.crust || '').toLowerCase();

            // Match by size and crust
            let vMatch = match.variants.find(v => 
              v.size && v.size.toLowerCase() === reqSize &&
              v.crust && reqCrust && v.crust.toLowerCase().includes(reqCrust)
            );
            if (!vMatch) {
              vMatch = match.variants.find(v => v.size && v.size.toLowerCase() === reqSize);
            }
            if (!vMatch) {
              vMatch = match.variants.find(v => v.skuId === cartItem.skuId) || match.variants[0];
            }

            if (vMatch) {
              if (vMatch.isAvailable === false) {
                isAvailable = false;
                unavailableReason = `${cartItem.name} (${vMatch.size || 'Size'} / ${vMatch.crust || 'Crust'}) is out of stock at Domino's ${resolvedStore?.storeName || 'kitchen'}`;
                hasUnavailableItems = true;
              } else if (vMatch.price > 0) {
                currentPrice = vMatch.price;
              }
            }
          }
        }
      }

      const itemTotal = currentPrice * (cartItem.quantity || 1);
      itemsSubtotal += itemTotal;

      return {
        ...cartItem,
        verifiedPrice: currentPrice,
        itemTotal: itemTotal,
        isAvailable: isAvailable,
        unavailableReason: unavailableReason
      };
    });

    const gst = Math.round(itemsSubtotal * 0.05 * 100) / 100;
    const deliveryFee = 35;
    const packagingFee = 0;
    const grandTotal = Math.round(itemsSubtotal + gst + deliveryFee + packagingFee);

    return {
      success: true,
      store: resolvedStore,
      storeId: targetStoreId,
      isServiceable: isServiceable,
      allAvailable: !hasUnavailableItems,
      hasUnavailableItems: hasUnavailableItems,
      items: verifiedItems,
      billBreakdown: {
        subtotal: itemsSubtotal,
        itemsSubtotal: itemsSubtotal,
        gst,
        deliveryFee,
        packagingFee,
        grandTotal
      }
    };
  }

  /**
   * Default Combos
   */
  getDefaultCombos() {
    return [
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
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/4465ab77-1c41-4d24-b96b-cd26bd92df0f_homep.webp',
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
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/40676ebf-2627-49f4-a221-aa83838213cb_PMClassicMenu.webp',
        description: '4x Regular Pizzas (Capsicum, Golden Corn, Onion, Veg Loaded) + 1 Garlic Breadsticks + 1.25L Cold Drink',
        includedItems: [
          { name: 'Capsicum Mania Pizza', dominosCode: 'PIZ0232', qty: 1 },
          { name: 'Golden Corn Mania Pizza', dominosCode: 'PIZ0130', qty: 1 },
          { name: 'Onion Mania Pizza', dominosCode: 'PIZ0129', qty: 1 },
          { name: 'Veg Loaded Pizza', dominosCode: 'PIZ0140', qty: 1 },
          { name: 'Garlic Breadsticks', dominosCode: 'SID0001', qty: 1 },
          { name: 'Coca-Cola 1.25L Bottle', dominosCode: 'BEV-COKE-125', qty: 1 }
        ]
      },
      {
        id: 'COMBO-5',
        name: 'Solo Pizza & Choco Lava Treat',
        tag: '🍫 Sweet Cravings',
        badge: 'Save ₹80',
        price: 249,
        originalPrice: 329,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/1f7ddf95-d357-4d61-8ab0-b0bafbeedad1_ChocoLavaCakeHomeProductV1.webp',
        description: '1 Regular Classic Margherita + 1 Gooey Choco Lava Cake + 1 Coke 250ml',
        includedItems: [
          { name: 'Margherita (Regular)', dominosCode: 'PIZ0117', qty: 1 },
          { name: 'Choco Lava Cake', dominosCode: 'DES0001', qty: 1 },
          { name: 'Coca-Cola 250ml', dominosCode: 'BEV-COKE-250', qty: 1 }
        ]
      },
      {
        id: 'COMBO-6',
        name: 'Cheesy Volcano Feast',
        tag: '🌋 Molten Cheese Delight',
        badge: 'Save ₹150',
        price: 499,
        originalPrice: 649,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/0b41b2cb-958c-4c17-b0b2-397308538684_volcanoHomePeppyPaneer.webp',
        description: '1 Cheese Volcano Peppy Paneer + 1 Classic Stuffed Garlic Bread + 2x Coke',
        includedItems: [
          { name: 'Cheese Volcano Peppy Paneer', dominosCode: 'PIZ0120', qty: 1 },
          { name: 'Stuffed Garlic Bread', dominosCode: 'SID0046', qty: 1 },
          { name: 'Coca-Cola 250ml', dominosCode: 'BEV-COKE-250', qty: 2 }
        ]
      },
      {
        id: 'COMBO-7',
        name: 'Weekend Family Feast',
        tag: '👨‍👩‍👧‍👦 Family Special',
        badge: 'Save ₹300',
        price: 899,
        originalPrice: 1199,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
        description: '2 Medium Pizzas (Farmhouse & Peppy Paneer) + 1 Stuffed Garlic Bread + 2 Choco Lava Cakes + 1.25L Coke',
        includedItems: [
          { name: 'Farmhouse (Medium)', dominosCode: 'PIZ0119', qty: 1 },
          { name: 'Peppy Paneer (Medium)', dominosCode: 'PIZ0120', qty: 1 },
          { name: 'Stuffed Garlic Bread', dominosCode: 'SID0046', qty: 1 },
          { name: 'Choco Lava Cake', dominosCode: 'DES0001', qty: 2 },
          { name: 'Coca-Cola 1.25L Bottle', dominosCode: 'BEV-COKE-125', qty: 1 }
        ]
      },
      {
        id: 'COMBO-8',
        name: 'Snack Attack Platter',
        tag: '⚡ Quick Bites',
        badge: 'Save ₹100',
        price: 329,
        originalPrice: 429,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/d8fef862-36b4-4e50-a5dc-8af4bbf1ab71_FullsizeGarlicBreadwithcornFiery.webp',
        description: '1 Stuffed Garlic Bread + 1 Paneer Zingy Parcel + 1 Cheesy Jalapeno Dip + 2x Coke 250ml',
        includedItems: [
          { name: 'Stuffed Garlic Bread', dominosCode: 'SID0046', qty: 1 },
          { name: 'Veg Parcel', dominosCode: 'SID0002', qty: 1 },
          { name: 'Cheesy Jalapeno Dip', dominosCode: 'SID0010', qty: 1 },
          { name: 'Coca-Cola 250ml', dominosCode: 'BEV-COKE-250', qty: 2 }
        ]
      }
    ];
  }

  getDefaultFallbackCatalog() {
    return [
      {
        id: 'DOM-PIZ0119',
        name: 'Farmhouse Pizza',
        category: 'Veg Pizza',
        type: 'VEG',
        price: 269,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
        description: 'Delightful combination of onion, capsicum, tomato & grilled mushroom.',
        dominosCode: 'PIZ0119',
        isAvailable: true
      },
      {
        id: 'DOM-PIZ0117',
        name: 'Margherita Pizza',
        category: 'Veg Pizza',
        type: 'VEG',
        price: 109,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/be33bb82-d74d-4a37-b742-9292562bea08_farmhouse.webp',
        description: 'Classic delight with 100% real mozzarella cheese.',
        dominosCode: 'PIZ0117',
        isAvailable: true
      },
      {
        id: 'DOM-PIZ0120',
        name: 'Peppy Paneer Pizza',
        category: 'Veg Pizza',
        type: 'VEG',
        price: 279,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/0b41b2cb-958c-4c17-b0b2-397308538684_volcanoHomePeppyPaneer.webp',
        description: 'Chunky paneer with crisp capsicum and spicy red pepper.',
        dominosCode: 'PIZ0120',
        isAvailable: true
      },
      {
        id: 'DOM-PIZ0125',
        name: 'Chicken Golden Delight',
        category: 'Non-Veg Pizza',
        type: 'NON-VEG',
        price: 329,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/menu/893ad735-bc90-40b9-83c9-5cebfc876508_new_chicken_golden_delight.webp',
        description: 'Barbeque chicken with a topping of golden corn loaded with extra cheese.',
        dominosCode: 'PIZ0125',
        isAvailable: true
      },
      {
        id: 'DOM-SID0046',
        name: 'Stuffed Garlic Bread',
        category: 'Garlic Breads & Sides',
        type: 'VEG',
        price: 149,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/d8fef862-36b4-4e50-a5dc-8af4bbf1ab71_FullsizeGarlicBreadwithcornFiery.webp',
        description: 'Freshly baked garlic bread stuffed with mozzarella cheese, sweet corn and tangy jalapenos.',
        dominosCode: 'SID0046',
        isAvailable: true
      },
      {
        id: 'DOM-DES0001',
        name: 'Choco Lava Cake',
        category: 'Desserts',
        type: 'VEG',
        price: 109,
        image: 'https://images.dominos.co.in/nextgen-catalog/media/prod/Dominos/WebHomeProductV1/1f7ddf95-d357-4d61-8ab0-b0bafbeedad1_ChocoLavaCakeHomeProductV1.webp',
        description: 'Chocolate lovers delight! Indulgent, gooey molten lava inside chocolate cake.',
        dominosCode: 'DES0001',
        isAvailable: true
      }
    ];
  }
}

module.exports = new DominosMenuService();
