FROM node:22-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS base

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

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runner

# SPA: any unknown path falls back to index.html.
COPY --from=builder /app/apps/wallet/dist /usr/share/nginx/html

COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 3000;
    server_name _;
    # ANT-347 H1: hide version + in-image defense in depth (Traefik
    # security-headers middleware stays primary).
    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types application/javascript text/css image/svg+xml application/json;
    gzip_min_length 1024;

    # Vite emits content-hashed filenames: immutable, cache for a year.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

# ANT-347 H1: run as non-root. Ports >1024 so no extra caps needed.
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d /var/cache/nginx
USER nginx
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1