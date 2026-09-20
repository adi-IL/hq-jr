# syntax=docker/dockerfile:1
# Multi-stage production image for hq-jr (Probot on Node 22).
# Matches docs/05 Cloud Run / standalone container story.

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HQ_JR_DB_PATH=/app/data/hq-jr.db

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 hqjr \
  && useradd --system --uid 1001 --gid hqjr --home-dir /app --shell /usr/sbin/nologin hqjr \
  && mkdir -p /app/data \
  && chown -R hqjr:hqjr /app

COPY --from=build --chown=hqjr:hqjr /app/package.json /app/package-lock.json ./
COPY --from=build --chown=hqjr:hqjr /app/node_modules ./node_modules
COPY --from=build --chown=hqjr:hqjr /app/dist ./dist
COPY --chown=hqjr:hqjr app.yml .env.example ./

USER hqjr
EXPOSE 3000

# Probot loads dist/index.js; credentials via env / Secret Manager (see docs/05).
CMD ["npm", "start"]
