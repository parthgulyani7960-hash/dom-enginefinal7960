/**
 * securityService.js
 * Comprehensive Platform Security, Sliding Window Rate Limiting, 
 * Input Sanitization & Anti-Abuse Protection for Domino's Order Engine
 */

class SecurityService {
  constructor() {
    // Sliding window tracking: Map<clientIp, { requests: [{ timestamp, category }], violations: number, bannedUntil: number }>
    this.ipRecords = new Map();

    // Configurable rate limits per minute (Generous thresholds to prevent admin polling blockages)
    this.LIMITS = {
      GLOBAL: { max: 500, windowMs: 60 * 1000 },
      AUTH: { max: 60, windowMs: 60 * 1000 },
      MUTATION: { max: 60, windowMs: 60 * 1000 },
      SMS_OTP: { max: 15, windowMs: 60 * 1000 },
      ADMIN: { max: 800, windowMs: 60 * 1000 }
    };

    // Cooldown duration for repeated violations (5 minutes)
    this.BAN_DURATION_MS = 5 * 60 * 1000;
    this.MAX_VIOLATIONS_BEFORE_BAN = 10;

    // Periodic garbage collection every 5 minutes to prevent memory leaks
    setInterval(() => this.cleanupExpiredRecords(), 5 * 60 * 1000);
  }

  /**
   * Safely extract the real client IP address
   */
  getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp) return realIp.trim();

    return req.socket?.remoteAddress || req.connection?.remoteAddress || '127.0.0.1';
  }

  /**
   * Determine rate limit category from path and method
   */
  getCategory(method, pathname) {
    if (pathname.startsWith('/api/admin/accounts/send-otp') || pathname.startsWith('/api/admin/accounts/verify-otp')) {
      return 'SMS_OTP';
    }
    if (pathname.startsWith('/api/auth/')) {
      return 'AUTH';
    }
    if (method === 'POST' && (pathname.startsWith('/api/orders/') || pathname.startsWith('/api/user/wallet/'))) {
      return 'MUTATION';
    }
    if (pathname.startsWith('/api/admin/')) {
      return 'ADMIN';
    }
    return 'GLOBAL';
  }

  /**
   * Check rate limit for incoming request
   * Returns: { allowed: boolean, remaining: number, resetInSeconds: number, reason?: string }
   */
  check(req, pathname) {
    const ip = this.getClientIp(req);
    const now = Date.now();

    // Authenticated admin requests and local loopback are exempted from aggressive throttling
    const hasAdminCred = Boolean(req.headers['x-admin-key'] || req.headers['x-admin-token']);
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (pathname.startsWith('/api/admin/') && (hasAdminCred || isLocal)) {
      return { allowed: true, remaining: 1000, resetInSeconds: 0 };
    }

    const category = this.getCategory(req.method, pathname);
    const rule = this.LIMITS[category] || this.LIMITS.GLOBAL;

    let record = this.ipRecords.get(ip);
    if (!record) {
      record = { requests: [], violations: 0, bannedUntil: 0 };
      this.ipRecords.set(ip, record);
    }

    // Check if IP is under temporary security ban
    if (record.bannedUntil > now) {
      const remainingSec = Math.ceil((record.bannedUntil - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetInSeconds: remainingSec,
        reason: `IP temporarily blocked due to repeated security limit violations. Cooldown active for ${remainingSec}s.`
      };
    }

    // Prune requests older than the sliding window
    const windowStart = now - rule.windowMs;
    record.requests = record.requests.filter(r => r.timestamp > windowStart);

    // Count requests in this category
    const categoryRequests = record.requests.filter(r => r.category === category);

    if (categoryRequests.length >= rule.max) {
      record.violations = (record.violations || 0) + 1;
      if (record.violations >= this.MAX_VIOLATIONS_BEFORE_BAN) {
        record.bannedUntil = now + this.BAN_DURATION_MS;
      }

      const oldestInWindow = categoryRequests[0]?.timestamp || now;
      const resetInSeconds = Math.max(1, Math.ceil((oldestInWindow + rule.windowMs - now) / 1000));

      return {
        allowed: false,
        remaining: 0,
        resetInSeconds,
        reason: `Rate limit exceeded for category '${category}'. Maximum ${rule.max} requests per minute allowed.`
      };
    }

    // Record request
    record.requests.push({ timestamp: now, category });
    const remaining = Math.max(0, rule.max - categoryRequests.length - 1);
    const resetInSeconds = Math.ceil(rule.windowMs / 1000);

    return {
      allowed: true,
      remaining,
      resetInSeconds
    };
  }

  /**
   * Deep sanitize request body to prevent XSS & script injection
   */
  sanitizeBody(data) {
    if (typeof data === 'string') {
      return data
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/onerror\s*=/gi, '')
        .replace(/onload\s*=/gi, '');
    }
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeBody(item));
    }
    if (data !== null && typeof data === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        // Prevent prototype pollution
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        sanitized[key] = this.sanitizeBody(value);
      }
      return sanitized;
    }
    return data;
  }

  /**
   * Periodically purge expired IP records to prevent memory growth
   */
  cleanupExpiredRecords() {
    const now = Date.now();
    for (const [ip, record] of this.ipRecords.entries()) {
      if (record.bannedUntil < now) {
        record.requests = record.requests.filter(r => r.timestamp > (now - 60000));
        if (record.requests.length === 0) {
          this.ipRecords.delete(ip);
        }
      }
    }
  }

  /**
   * Return telemetry metrics for admin monitoring
   */
  getSecurityStats() {
    const now = Date.now();
    let totalTrackedIps = this.ipRecords.size;
    let activeBans = 0;

    for (const record of this.ipRecords.values()) {
      if (record.bannedUntil > now) activeBans++;
    }

    return {
      totalTrackedIps,
      activeBans,
      limits: this.LIMITS
    };
  }
}

module.exports = new SecurityService();
