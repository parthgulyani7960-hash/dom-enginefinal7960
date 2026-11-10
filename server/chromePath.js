const fs = require('fs');
const path = require('path');

/**
 * Dynamically resolves Chrome / Chromium executable path across
 * Windows local development and Linux/Docker cloud hosting environments (Koyeb, Render, Hugging Face, etc.)
 */
function getChromeExecutablePath() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  if (process.platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined; // Fall back to Playwright's bundled browser
  }

  // Linux / Docker environments (Koyeb, Render, Ubuntu, Debian)
  if (fs.existsSync('/ms-playwright')) {
    try {
      const entries = fs.readdirSync('/ms-playwright');
      for (const e of entries) {
        if (e.startsWith('chromium-')) {
          const cPath = path.join('/ms-playwright', e, 'chrome-linux', 'chrome');
          if (fs.existsSync(cPath)) return cPath;
        }
      }
    } catch (_) {}
  }

  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/ms-playwright/chromium/chrome-linux/chrome'
  ];
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // Fall back to Playwright's bundled browser
}

module.exports = { getChromeExecutablePath };
