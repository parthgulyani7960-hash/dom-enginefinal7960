const fs = require('fs');
const path = require('path');

/**
 * Authentic Domino's Physical Screenshot Helper
 * Zero mock or fake SVG generation.
 * Manages physical screenshots captured directly from the browser viewport
 * and purges older files to keep server disk and database storage lean.
 */

function generateProofScreenshot({ orderId }) {
  // Never generate fake SVG mocks. Return null so only authentic physical screenshots are stored.
  return null;
}

/**
 * Keeps only the most recent `maxToKeep` physical PNG proof screenshots in public/screenshots
 * and removes older files and any legacy SVG mocks to ensure storage remains lean.
 */
function cleanupOlderScreenshots(maxToKeep = 5) {
  try {
    const dir = path.join(__dirname, '..', 'public', 'screenshots');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);

    // Immediately remove any legacy SVG files
    for (const f of files) {
      if (f.endsWith('.svg')) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
      }
    }

    const remainingFiles = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
    if (remainingFiles.length <= maxToKeep) return;

    const fileStats = remainingFiles.map(file => {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        return { file, fullPath, mtime: stat.mtimeMs };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    // Sort newest first
    fileStats.sort((a, b) => b.mtime - a.mtime);

    // Delete older files beyond maxToKeep
    const toDelete = fileStats.slice(maxToKeep);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(f.fullPath);
      } catch (e) {}
    }

    // Unlink deleted screenshots from store.json orders ONLY if no data URI backup exists
    try {
      const db = require('./db');
      const validFiles = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.png')));
      let dbChanged = false;
      if (db.data && Array.isArray(db.data.orders)) {
        for (const o of db.data.orders) {
          // If order has base64 data URI, keep screenshot URLs permanently so serveStatic can reconstruct them
          if (o.robot?.proofScreenshotDataUri || o.robot?.cartBillScreenshotDataUri) {
            continue;
          }
          if (o.robot?.proofScreenshotUrl && !o.robot.proofScreenshotUrl.startsWith('data:')) {
            const basename = path.basename(o.robot.proofScreenshotUrl);
            if (!validFiles.has(basename)) {
              o.robot.proofScreenshotUrl = null;
              dbChanged = true;
            }
          }
        }
        if (dbChanged) db.save();
      }
    } catch (dbSyncErr) {}
  } catch (err) {
    console.warn('[STORAGE-CLEANUP] Prune notice:', err.message);
  }
}

module.exports = { generateProofScreenshot, cleanupOlderScreenshots };
