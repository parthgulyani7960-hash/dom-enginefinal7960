/**
 * Domino's Order Engine Production Rate Limiter
 * Implements sliding-window counter rate limiting with per-route rules,
 * automatic cleanup, HTTP 429 response handling, and Retry-After headers.
 */

class RateLimiter {
  constructor() {
    // Map of key -> array of timestamps: { "ip:route": [ts1, ts2, ...] }
    this.hits = new Map();
    
    // Cleanup old records every 60 seconds
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if an action is allowed under the rate limit rule.
   * @param {string} key - Identifier (e.g. `ip:/api/location/auto-detect`)
   * @param {number} maxRequests - Max requests allowed in window
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number }}
   */
  check(key, maxRequests, windowMs) {
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = this.hits.get(key) || [];
    // Filter timestamps within current window
    timestamps = timestamps.filter(ts => ts > windowStart);

    if (timestamps.length >= maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    return {
      allowed: true,
      remaining: maxRequests - timestamps.length,
      retryAfterSec: 0
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.hits.entries()) {
      const valid = timestamps.filter(ts => now - ts < 120000);
      if (valid.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, valid);
      }
    }
  }

  /**
   * HTTP Middleware helper
   * Returns true if request should continue, false if rate limited (response already sent)
   */
  middleware(req, res, { routeKey, maxRequests = 30, windowMs = 60000, message = 'Rate limit exceeded. Please slow down.' }) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
    const key = `${clientIp}:${routeKey || req.url.split('?')[0]}`;

    const result = this.check(key, maxRequests, windowMs);
    if (!result.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Retry-After': String(result.retryAfterSec),
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor((Date.now() + result.retryAfterSec * 1000) / 1000))
      });
      res.end(JSON.stringify({
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: `${message} Retry after ${result.retryAfterSec} seconds.`,
        retryAfter: result.retryAfterSec
      }));
      return false;
    }

    // Set rate limit headers
    res.setHeader?.('X-RateLimit-Limit', String(maxRequests));
    res.setHeader?.('X-RateLimit-Remaining', String(result.remaining));
    return true;
  }
}

module.exports = new RateLimiter();
