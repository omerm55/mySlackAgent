FROM node:22-alpine

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# The integrations config is mounted at runtime (see docker-compose.yml),
# not baked into the image — it contains channel IDs and field names.
# Credentials are passed via environment variables, never via the image.

USER appuser

CMD ["node", "src/index.js"]
