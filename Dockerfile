FROM node:22-alpine

# Update system packages and root certificates to mitigate TLS vulnerabilities
RUN apk update && apk upgrade && apk add --no-cache ca-certificates && update-ca-certificates

# Set default environment variables for production and Hugging Face Spaces
ENV NODE_ENV=production \
    PORT=7860 \
    HOME=/home/node

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Ensure UID 1000 (node user) owns /app and home directory
RUN chown -R 1000:1000 /app /home/node

# Expose Hugging Face default port
EXPOSE 7860

# Switch to non-root user (UID 1000) required by Hugging Face Spaces
USER 1000

# Healthcheck probe using Alpine's built-in wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-7860}/health || exit 1

# Start MiTV Studio server
CMD ["node", "server.js"]
