/**
 * High-Definition, Authentic Food Image Engine for Domino's Platform
 * Provides verified, 100% authentic local Domino's assets and fallbacks.
 */

const CATEGORY_IMAGES = {
  'Veg Pizza': '/images/menu/margherita.webp',
  'Non-Veg Pizza': '/images/menu/chicken-golden-delight.webp',
  'Pizza Mania': '/images/menu/veg-loaded-pizza-mania.webp',
  'Garlic Breads & Sides': '/images/menu/garlic-breadsticks.webp',
  'Pastas': '/images/menu/paneer-tandoori-meltz-lxt.webp',
  'Desserts': '/images/menu/choco-lava-cake.webp',
  'Beverages': '/images/menu/pepsi-475ml.webp'
};

const SPECIFIC_ITEM_IMAGES = {
  // Classics & Cheese
  'margherita': '/images/menu/margherita.webp',
  'double cheese margherita': '/images/menu/double-cheese-margherita.webp',
  'cheese n corn': '/images/menu/cheese-n-corn.webp',
  
  // Veg Specialties
  'farmhouse': '/images/menu/farmhouse.webp',
  'peppy paneer': '/images/menu/peppy-paneer.webp',
  'mexican green wave': '/images/menu/mexican-green-wave.webp',
  'veggie paradise': '/images/menu/veggie-paradise.webp',
  'indi tandoori paneer': '/images/menu/indi-tandoori-paneer.webp',
  'veg extravaganza': '/images/menu/veg-extravaganza.webp',

  // Non-Veg Specialties
  'pepper barbecue chicken': '/images/menu/pepper-barbecue-chicken.webp',
  'chicken golden delight': '/images/menu/chicken-golden-delight.webp',
  'chicken dominator': '/images/menu/chicken-dominator.webp',
  'non-veg supreme': '/images/menu/non-veg-supreme.webp',
  'indi chicken tikka': '/images/menu/indi-chicken-tikka.webp',
  'chicken sausage': '/images/menu/chicken-sausage.webp',
  'chicken pepperoni': '/images/menu/chicken-pepperoni.webp',
  'chicken fiesta': '/images/menu/chicken-fiesta.webp',

  // Pizza Mania Range
  'golden corn': '/images/menu/golden-corn-pizza-mania.webp',
  'golden corn pizza mania': '/images/menu/golden-corn-pizza-mania.webp',
  'veg loaded': '/images/menu/veg-loaded-pizza-mania.webp',
  'veg loaded pizza mania': '/images/menu/veg-loaded-pizza-mania.webp',
  'cheesy pizza mania': '/images/menu/cheesy-pizza-mania.webp',
  'paneer & onion pizza mania': '/images/menu/paneer-onion-pizza-mania.webp',
  'classic onion pizza mania': '/images/menu/classic-onion-pizza-mania.webp',
  'non-veg loaded pizza mania': '/images/menu/non-veg-loaded-pizza-mania.webp',

  // Sides, Breads & Tacos
  'garlic breadsticks': '/images/menu/garlic-breadsticks.webp',
  'classic stuffed garlic bread': '/images/menu/classic-stuffed-garlic-bread.webp',
  'paneer tikka garlic bread': '/images/menu/paneer-tikka-stuffed-gb.webp',
  'zingy parcel veg': '/images/menu/zingy-parcel-veg.webp',
  'zingy parcel non-veg': '/images/menu/zingy-parcel-non-veg.webp',
  'cheesy dip': '/images/menu/cheesy-dip.webp',
  'peri peri dip': '/images/menu/peri-peri-dip.webp',
  'taco': '/images/menu/taco-mexicana-veg.webp',
  'burger pizza': '/images/menu/burger-pizza-premium-veg.webp',

  // Desserts
  'choco lava cake': '/images/menu/choco-lava-cake.webp',
  'butterscotch mousse cake': '/images/menu/butterscotch-mousse-cake.webp',
  'red velvet lava cake': '/images/menu/red-velvet-lava-cake.webp',
  'brownie': '/images/menu/choco-lava-cake.webp',

  // Beverages
  'pepsi': '/images/menu/pepsi-475ml.webp',
  'mirinda': '/images/menu/mirinda-fanta-475ml.webp',
  '7up': '/images/menu/7up-sprite-475ml.webp',
  'fanta': '/images/menu/mirinda-fanta-475ml.webp',
  'coca cola': '/images/menu/coca-cola-475ml.webp',
  'sprite': '/images/menu/7up-sprite-475ml.webp'
};

function getItemImageUrl(item) {
  if (!item) return CATEGORY_IMAGES['Veg Pizza'];

  // 1. Client custom uploaded image URL always takes top precedence
  if (item.customImageUrl || item.uploadedImageUrl || item.clientImageUrl) {
    return item.customImageUrl || item.uploadedImageUrl || item.clientImageUrl;
  }

  // 2. Direct verified local asset
  if (item.image && (item.image.startsWith('/images/') || item.image.startsWith('images/'))) {
    return item.image.startsWith('/') ? item.image : '/' + item.image;
  }
  if (item.imageUrl && (item.imageUrl.startsWith('/images/') || item.imageUrl.startsWith('images/'))) {
    return item.imageUrl.startsWith('/') ? item.imageUrl : '/' + item.imageUrl;
  }

  // 3. Direct specific name match
  const nameNorm = (item.name || '').toLowerCase().trim();
  if (SPECIFIC_ITEM_IMAGES[nameNorm]) {
    return SPECIFIC_ITEM_IMAGES[nameNorm];
  }

  // 4. Substring keyword match
  for (const [key, url] of Object.entries(SPECIFIC_ITEM_IMAGES)) {
    if (nameNorm.includes(key) || key.includes(nameNorm)) {
      return url;
    }
  }

  // 5. Category match
  const cat = item.category || '';
  if (CATEGORY_IMAGES[cat]) {
    return CATEGORY_IMAGES[cat];
  }

  if (nameNorm.includes('chicken') || nameNorm.includes('meat') || nameNorm.includes('keema') || nameNorm.includes('pepperoni')) {
    return CATEGORY_IMAGES['Non-Veg Pizza'];
  }

  return CATEGORY_IMAGES['Veg Pizza'];
}

module.exports = {
  getItemImageUrl,
  CATEGORY_IMAGES,
  SPECIFIC_ITEM_IMAGES
};
