# Stage 1: Builder - Install dependencies and bundle
FROM node:25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY config.default.js ./config.default.js
COPY plugins/ ./plugins/

RUN npm install --no-save esbuild postject rcedit && node scripts/build.js

# Stage 2: Runner - Minimal image with bundled output
FROM node:25-alpine

WORKDIR /app

# Copy bundled application and native modules from builder
COPY --from=builder /app/src ./src/
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/config.default.js ./config.default.js
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules/

CMD ["node", "--dns-result-order=ipv4first", "--openssl-legacy-provider", "dist/main.mjs"]
