# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until package*.json change)
# ---------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------
# Stage 2 — build
#
# Only two NEXT_PUBLIC_* values are inlined into the client bundle
# (site URL for OG/sitemap, UI locale). Everything else — DATABASE_URL,
# ENCRYPTION_KEY, META_APP_SECRET, SMTP, storage — is read at runtime
# and must NOT be baked into the image.
# ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
#
# The same image runs the app (default CMD) and the one-shot
# migration job (`node scripts/migrate.mjs`, see docker-compose.yml);
# `pg` ships in the standalone bundle's node_modules.
# ---------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DIR=/data/storage

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs \
 && mkdir -p /data/storage && chown nextjs:nextjs /data/storage

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public
COPY --from=builder --chown=nextjs:nextjs /app/db ./db
COPY --from=builder --chown=nextjs:nextjs /app/scripts/migrate.mjs /app/scripts/auth-cli.mjs ./scripts/

USER nextjs
VOLUME ["/data/storage"]
EXPOSE 3000
CMD ["node", "server.js"]
