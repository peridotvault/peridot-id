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

# Vite inlines VITE_* at build time — bake in the API URL the browser calls.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL:-https://api.pid.peridotvault.com}

RUN pnpm --filter @peridotvault/pid-types build
RUN pnpm --filter @peridotvault/pid-core build
RUN pnpm --filter @peridotvault/pid-solana build
RUN pnpm --filter @peridotvault/pid-sdk-js build
RUN pnpm --filter @peridotvault/pid-wallet build

FROM nginx:1.27-alpine AS runner

# SPA: any unknown path falls back to index.html.
COPY --from=builder /app/apps/wallet/dist /usr/share/nginx/html

COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 3000;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Security headers (ANT-346 H1). Static SPA: the API allowlist below names
    # the first-party API origins. The trailing `https:` in connect-src covers
    # registry-provided Solana RPC endpoints + token-metadata URIs, whose hosts
    # are dynamic per chain registry / NFT collection and can't be enumerated
    # here. frame-ancestors allows https parents deliberately: the embed product
    # (pid-react-embed) renders the wallet in a third-party iframe, and every
    # trust-critical action escapes to a top-level PeridotID popup (address bar
    # visible). Tightening framing to a per-app allowlist needs a dynamic
    # header (Trevor/nginx + API) — tracked as follow-up.
    add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self' https:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://api.pid.peridotvault.com https://api.peridot.id https:; upgrade-insecure-requests" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()" always;

    gzip on;
    gzip_types application/javascript text/css image/svg+xml application/json;
    gzip_min_length 1024;

    # Vite emits content-hashed filenames: immutable, cache for a year.
    # NOTE: any add_header here replaces the server-level set for /assets/*
    # responses (nginx inheritance rule), so the security headers are
    # repeated verbatim.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable" always;
        add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self' https:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://api.pid.peridotvault.com https://api.peridot.id https:; upgrade-insecure-requests" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()" always;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1