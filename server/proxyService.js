/**
 * proxyService.js
 * High-Performance Rotating Proxy Gateway (HTTP / HTTPS / SOCKS5)
 * for Domino's Autonomous Order Robot & Telemetry Workers.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'proxy_config.json');

class ProxyService {
  constructor() {
    this.config = {
      enabled: false,
      protocol: 'http', // 'http', 'https', 'socks5'
      host: '',
      port: '',
      username: '',
      password: '',
      rawInput: '',
      lastTestedAt: null,
      lastTestedIp: null,
      lastLatencyMs: null,
      lastStatus: 'NOT_TESTED'
    };
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.config = { ...this.config, ...parsed };
      }
    } catch (e) {
      console.warn('[PROXY] Note loading proxy config:', e.message);
    }
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
      console.log('[PROXY] Proxy configuration updated.');
    } catch (e) {
      console.error('[PROXY] Failed to save proxy config:', e.message);
    }
    return this.getSanitizedConfig();
  }

  /**
   * Parse flexible user proxy input formats:
   * Format 1: host:port:username:password
   * Format 2: protocol://username:password@host:port
   * Format 3: Individual structured fields
   */
  parseInput(input = {}) {
    let { enabled, protocol, host, port, username, password, rawInput } = input;

    if (rawInput && typeof rawInput === 'string') {
      const trimmed = rawInput.trim();
      // Case 1: protocol://user:pass@host:port
      if (trimmed.includes('://')) {
        try {
          const parsed = new URL(trimmed);
          protocol = parsed.protocol.replace(':', '');
          host = parsed.hostname;
          port = parsed.port;
          username = decodeURIComponent(parsed.username || '');
          password = decodeURIComponent(parsed.password || '');
        } catch (e) {}
      } 
      // Case 2: host:port:user:pass
      else if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
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
    }

    return {
      enabled: Boolean(enabled),
      protocol: (protocol || 'http').toLowerCase(),
      host: (host || '').trim(),
      port: String(port || '').trim(),
      username: (username || '').trim(),
      password: (password || '').trim(),
      rawInput: (rawInput || '').trim()
    };
  }

  /**
   * Return proxy configuration tailored for Playwright Chromium browser launcher
   */
  getPlaywrightProxy() {
    if (!this.config.enabled || !this.config.host || !this.config.port) {
      return null;
    }

    const proto = (this.config.protocol || 'http').toLowerCase();
    const server = `${proto}://${this.config.host}:${this.config.port}`;

    const proxyOpts = { server };
    if (this.config.username) {
      proxyOpts.username = this.config.username;
      proxyOpts.password = this.config.password || '';
    }

    return proxyOpts;
  }

  /**
   * Ultra-fast proxy-aware fetch for Domino's direct backend APIs.
   * If proxy is enabled, tunnels through rotating proxy with Basic Auth.
   * If proxy fails, automatically falls back to direct connection.
   */
  async proxyFetch(targetUrl, options = {}) {
    if (!this.config.enabled || !this.config.host || !this.config.port) {
      return fetch(targetUrl, options);
    }

    try {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const proxyHost = this.config.host;
      const proxyPort = parseInt(this.config.port, 10);
      const timeoutMs = options.timeout || 8000;
      const tls = require('tls');

      return await new Promise((resolve, reject) => {
        const connectOpts = {
          host: proxyHost,
          port: proxyPort,
          method: 'CONNECT',
          path: `${parsed.hostname}:${parsed.port || (isHttps ? 443 : 80)}`,
          timeout: timeoutMs
        };
        if (this.config.username) {
          const auth = Buffer.from(`${this.config.username}:${this.config.password || ''}`).toString('base64');
          connectOpts.headers = { 'Proxy-Authorization': `Basic ${auth}` };
        }

        const connectReq = http.request(connectOpts);
        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            return reject(new Error(`Proxy CONNECT returned ${res.statusCode}`));
          }
          const agentSocket = isHttps ? tls.connect({
            host: parsed.hostname,
            socket: socket,
            servername: parsed.hostname
          }) : socket;

          const reqLib = isHttps ? https : http;
          const outReq = reqLib.request({
            host: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            method: options.method || 'GET',
            path: parsed.pathname + parsed.search,
            headers: {
              Host: parsed.hostname,
              ...(options.headers || {})
            },
            socket: agentSocket,
            agent: false,
            timeout: timeoutMs
          }, (outRes) => {
            let chunks = [];
            outRes.on('data', c => chunks.push(c));
            outRes.on('end', () => {
              const bodyBuf = Buffer.concat(chunks);
              resolve({
                ok: outRes.statusCode >= 200 && outRes.statusCode < 300,
                status: outRes.statusCode,
                statusText: outRes.statusMessage,
                headers: outRes.headers,
                text: async () => bodyBuf.toString('utf8'),
                json: async () => JSON.parse(bodyBuf.toString('utf8')),
                buffer: async () => bodyBuf
              });
            });
          });

          outReq.on('error', reject);
          if (options.body) {
            outReq.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
          }
          outReq.end();
        });

        connectReq.on('timeout', () => {
          connectReq.destroy();
          reject(new Error('Proxy connect timed out'));
        });
        connectReq.on('error', reject);
        connectReq.end();
      });
    } catch (err) {
      console.warn(`[PROXY] proxyFetch fallback to direct: ${err.message}`);
      return fetch(targetUrl, options);
    }
  }

  /**
   * Live test the rotating proxy by querying an external IP reflection service
   */
  async testProxy() {
    if (!this.config.host || !this.config.port) {
      return {
        success: false,
        error: 'Proxy host and port must be specified before testing.'
      };
    }

    const startTime = Date.now();
    const proto = (this.config.protocol || 'http').toLowerCase();

    // Test using standard HTTP CONNECT or direct request
    return new Promise((resolve) => {
      try {
        const proxyHost = this.config.host;
        const proxyPort = parseInt(this.config.port, 10);

        const options = {
          host: proxyHost,
          port: proxyPort,
          method: 'CONNECT',
          path: 'api.ipify.org:443',
          timeout: 10000
        };

        if (this.config.username) {
          const auth = Buffer.from(`${this.config.username}:${this.config.password || ''}`).toString('base64');
          options.headers = {
            'Proxy-Authorization': `Basic ${auth}`
          };
        }

        const req = http.request(options);
        req.on('connect', (res, socket) => {
          if (res.statusCode === 200) {
            // Establish TLS tunnel to verify external IP
            const tls = require('tls');
            const tlsSocket = tls.connect({
              host: 'api.ipify.org',
              socket: socket,
              servername: 'api.ipify.org'
            }, () => {
              tlsSocket.write("GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n");
            });

            let responseData = '';
            tlsSocket.on('data', chunk => responseData += chunk.toString());
            tlsSocket.on('end', () => {
              const latencyMs = Date.now() - startTime;
              let ip = 'Connected';
              try {
                const bodyStr = responseData.split('\r\n\r\n')[1] || responseData;
                const parsed = JSON.parse(bodyStr.trim());
                if (parsed.ip) ip = parsed.ip;
              } catch (e) {}

              this.config.lastTestedAt = new Date().toISOString();
              this.config.lastTestedIp = ip;
              this.config.lastLatencyMs = latencyMs;
              this.config.lastStatus = 'ACTIVE';
              this.saveConfig(this.config);

              resolve({
                success: true,
                ip: ip,
                latencyMs: latencyMs,
                protocol: proto,
                message: `Rotating proxy connected successfully! External IP: ${ip} (${latencyMs}ms)`
              });
            });
            tlsSocket.on('error', (err) => {
              resolve({ success: false, error: `TLS Tunnel Error: ${err.message}` });
            });
          } else {
            resolve({
              success: false,
              error: `Proxy gateway returned HTTP ${res.statusCode} ${res.statusMessage}`
            });
          }
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, error: 'Proxy connection timed out (10s).' });
        });

        req.on('error', (err) => {
          resolve({ success: false, error: `Proxy Gateway Error: ${err.message}` });
        });

        req.end();
      } catch (err) {
        resolve({ success: false, error: `Test execution failed: ${err.message}` });
      }
    });
  }

  getSanitizedConfig() {
    return {
      enabled: Boolean(this.config.enabled),
      protocol: this.config.protocol || 'http',
      host: this.config.host || '',
      port: this.config.port || '',
      username: this.config.username || '',
      passwordMasked: this.config.password ? '••••••••' : '',
      hasPassword: Boolean(this.config.password),
      lastTestedAt: this.config.lastTestedAt,
      lastTestedIp: this.config.lastTestedIp,
      lastLatencyMs: this.config.lastLatencyMs,
      lastStatus: this.config.lastStatus
    };
  }
}

module.exports = new ProxyService();
