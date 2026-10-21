FROM node:20-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose HTTP port
EXPOSE 3000

# Healthcheck probe using Alpine's built-in wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-3000}/health || exit 1

# Start MiTV Studio server
CMD ["node", "server.js"]
