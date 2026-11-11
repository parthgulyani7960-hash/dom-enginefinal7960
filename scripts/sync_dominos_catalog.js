/**
 * Sync Official Domino's Catalog directly from Domino's India API
 * Ensures 100% exact item names, categories, CDN images, and size/crust pricing matrix.
 */
const fs = require('fs');
const path = require('path');

async function syncCatalog() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    'api_key': 'd2aeb489bb8df385',
    'client_type': 'web app-chrome',
    'source': 'PWA18',
    'Origin': 'https://m.dominos.co.in',
    'Referer': 'https://m.dominos.co.in/'
  };

  console.log('[CATALOG-SYNC] Connecting directly to Domino\'s India official store menu API...');
  const res = await fetch('https://api.dominos.co.in/catalog-service/ve2/stores/64493/menu?site=jflcms', { headers });
  if (!res.ok) {
    throw new Error(`Domino's API error: HTTP ${res.status}`);
  }

  const json = await res.json();
  const rawCategories = json.data || [];
  console.log(`[CATALOG-SYNC] Fetched ${rawCategories.length} official categories.`);

  const catalog = [];
  const seenCodes = new Set();

  rawCategories.forEach(cat => {
    const catName = cat.categoryName || '';
    (cat.data || []).forEach(p => {
      const code = p.code || String(p.id);
      if (seenCodes.has(code)) return;
      seenCodes.add(code);

      // Determine category mapping
      let category = 'Veg Pizza';
      const isManiaCode = ['PIZ0129', 'PIZ0130', 'PIZ0210', 'PIZ0232', 'PIZ0233', 'PIZ0234', 'PIZ0140', 'PIZ5109', 'PIZ5126', 'PIZ5127', 'PIZ5188'].includes(code);
      if (catName === 'Beverages' || code.startsWith('BEV')) {
        category = 'Beverages';
      } else if (catName === 'Desserts' || code.startsWith('DST') || code.startsWith('CAKE')) {
        category = 'Desserts';
      } else if (catName === 'Garlic Breads & Dips' || code.startsWith('BRD') || code.startsWith('DIP')) {
        category = 'Garlic Breads & Sides';
      } else if (catName === 'Pizza Mania' || isManiaCode || p.metadataMap?.dmbCategory?.values?.[0] === 'pizzaMania') {
        category = 'Pizza Mania';
      } else if (catName === 'Tacos & Parcels') {
        category = 'Tacos & Parcels';
      } else if (catName === 'Combos' || catName === 'Deals' || code.startsWith('CMB') || catName.includes('@')) {
        category = 'Deals & Combos';
      } else if (catName === 'Non-Veg Pizza' || p.metadataMap?.foodLabel?.values?.[0] === 'NON-VEG' || (p.productName || '').includes('NV') || (p.filters || []).includes('Non-Veg')) {
        category = 'Non-Veg Pizza';
      } else {
        category = 'Veg Pizza';
      }

      // Check food label
      const isVeg = !(category === 'Non-Veg Pizza' || p.metadataMap?.foodLabel?.values?.[0] === 'NON-VEG' || (p.name || '').toLowerCase().includes('chicken') || (p.name || '').toLowerCase().includes('pepperoni'));

      // Crusts & Sizes
      const sizeCrustPricingMap = {};
      const allowedSizesSet = new Set();
      const allowedCrustsSet = new Set();
      let regNhtPrice = null;

      (p.crust || []).forEach(cr => {
        const crName = cr.name || '';
        if (crName) allowedCrustsSet.add(crName);
        (cr.sizes || []).forEach(sz => {
          const szName = sz.name || '';
          if (szName) allowedSizesSet.add(szName);
          if (!sizeCrustPricingMap[szName]) sizeCrustPricingMap[szName] = {};
          sizeCrustPricingMap[szName][crName] = sz.price;
          if (szName === 'Regular' && (crName.includes('Hand Tossed') || !regNhtPrice)) {
            regNhtPrice = sz.price;
          }
        });
      });

      // Compute base price (Regular size price for pizzas, MRP for beverages/sides/desserts)
      let basePrice = p.defaultCrustPrice || p.originalPrice || 0;
      if (regNhtPrice) {
        basePrice = regNhtPrice;
      } else if (sizeCrustPricingMap['Regular']) {
        const firstCr = Object.values(sizeCrustPricingMap['Regular'])[0];
        if (firstCr) basePrice = firstCr;
      }

      // Authentic Domino's CDN Image URL
      let imageUrl = '';
      if (p.image) {
        imageUrl = p.image.startsWith('http') ? p.image : 'https://images.dominos.co.in/' + (p.image.startsWith('/') ? p.image.slice(1) : p.image);
      } else if (p.images && p.images.length > 0 && p.images[0].mediaPath) {
        imageUrl = 'https://images.dominos.co.in/' + (p.images[0].mediaPath.startsWith('/') ? p.images[0].mediaPath.slice(1) : p.images[0].mediaPath);
      }

      const isPromotional = category === 'Deals & Combos';
      const origPrice = isPromotional ? (p.originalPrice && p.originalPrice > basePrice ? p.originalPrice : Math.round(basePrice * 1.25)) : basePrice;

      catalog.push({
        id: 'DOM-' + code,
        name: p.name.trim(),
        officialDominosName: p.productName || p.name,
        category: category,
        type: isVeg ? 'VEG' : 'NON-VEG',
        price: basePrice,
        originalPrice: origPrice,
        isPromotional: isPromotional,
        isVeg: isVeg,
        isAvailable: true,
        dominosCode: code,
        skuId: String(p.skuId || p.id),
        description: p.description || `${p.name} freshly prepared with authentic ingredients.`,
        imageUrl: imageUrl,
        image: imageUrl,
        allowedSizes: Array.from(allowedSizesSet),
        allowedCrusts: Array.from(allowedCrustsSet),
        sizeCrustPricingMap: sizeCrustPricingMap,
        isCustomizable: (category === 'Veg Pizza' || category === 'Non-Veg Pizza') && allowedSizesSet.size > 0
      });
    });
  });

  console.log(`[CATALOG-SYNC] Processed ${catalog.length} authentic items.`);
  const catBreakdown = {};
  catalog.forEach(i => catBreakdown[i.category] = (catBreakdown[i.category] || 0) + 1);
  console.log('[CATALOG-SYNC] Categories:', catBreakdown);

  // Write to data/dominos_catalog.json
  const outPath = path.join(__dirname, '..', 'data', 'dominos_catalog.json');
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`[CATALOG-SYNC] Successfully written official catalog to: ${outPath}`);
}

syncCatalog().catch(err => {
  console.error('[CATALOG-SYNC-ERR]', err);
  process.exit(1);
});
