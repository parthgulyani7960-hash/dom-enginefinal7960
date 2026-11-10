# =========================================================================
# Domino's Order Engine - Production 24/7 Cloud Dockerfile
# Compatible with Koyeb, Render, Hugging Face Spaces & Fly.io
# =========================================================================

# Use Microsoft's official Playwright runtime with pre-bundled Chromium & Linux dependencies
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Set working directory
WORKDIR /app

# Configure cloud production environment
ENV NODE_ENV=production
ENV PORT=3005
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application codebase
COPY . .

# Expose default listening port
EXPOSE 3005

# Container Healthcheck probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "const http=require('http'); http.get('http://localhost:' + (process.env.PORT || 3005) + '/api/maintenance', (r) => process.exit(r.statusCode === 200 ? 0 : 1));"

# Launch Domino's Order Engine server
CMD ["node", "server/index.js"]
