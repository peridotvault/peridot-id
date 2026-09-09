FROM node:22-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/wallet/package.json ./apps/wallet/
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/
COPY packages/solana/package.json ./packages/solana/
COPY packages/sdk-js/package.json ./packages/sdk-js/
COPY packages/openapi/package.json ./packages/openapi/
COPY packages/core/package.json ./packages/core/

# --ignore-scripts: root postinstall builds types/core/solana/sdk-js but their sources aren't
# copied yet — we build them explicitly in the builder stage after COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS builder

ENV NODE_OPTIONS=--max-old-space-size=1536

COPY . .

# Expo inlines EXPO_PUBLIC_* at export time — bake in the API URL the browser calls.
ARG EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL:-https://api.pid.peridotvault.com}

RUN pnpm --filter @peridotvault/pid-types build
RUN pnpm --filter @peridotvault/pid-core build
RUN pnpm --filter @peridotvault/pid-solana build
RUN pnpm --filter @peridotvault/pid-sdk-js build
RUN pnpm --filter @peridotvault/pid-wallet export

FROM nginx:1.27-alpine AS runner

# SPA: any unknown path falls back to index.html (Expo uses hash/history-less routes).
COPY --from=builder /app/apps/wallet/dist /usr/share/nginx/html

COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 3000;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types application/javascript text/css image/svg+xml application/json;
    gzip_min_length 1024;

    # Expo emits content-hashed filenames: immutable, cache for a year.
    location /_expo/static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1