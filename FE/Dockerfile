# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_AMOY_CHAIN_ID
ARG NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID
ARG NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL
ARG NEXT_PUBLIC_CHARITY_TOKEN_ADDRESS
ARG NEXT_PUBLIC_DONATION_RANKING_ADDRESS
ARG NEXT_PUBLIC_DONATION_RANKING_CONTRACT_ADDRESS
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT
ARG SENTRY_RELEASE
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
ENV NEXT_PUBLIC_AMOY_CHAIN_ID=${NEXT_PUBLIC_AMOY_CHAIN_ID}
ENV NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID=${NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID}
ENV NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL=${NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL}
ENV NEXT_PUBLIC_CHARITY_TOKEN_ADDRESS=${NEXT_PUBLIC_CHARITY_TOKEN_ADDRESS}
ENV NEXT_PUBLIC_DONATION_RANKING_ADDRESS=${NEXT_PUBLIC_DONATION_RANKING_ADDRESS}
ENV NEXT_PUBLIC_DONATION_RANKING_CONTRACT_ADDRESS=${NEXT_PUBLIC_DONATION_RANKING_CONTRACT_ADDRESS}
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=${NEXT_PUBLIC_SENTRY_ENVIRONMENT}
ENV NEXT_PUBLIC_SENTRY_RELEASE=${SENTRY_RELEASE}
ENV SENTRY_RELEASE=${SENTRY_RELEASE}
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json next.config.js postcss.config.js tailwind.config.js tsconfig.json ./
COPY instrumentation.ts sentry.client.config.ts sentry.server.config.ts sentry.edge.config.ts ./
COPY app ./app
COPY scripts ./scripts
RUN --mount=type=secret,id=sentry_auth_token \
    if [ -s /run/secrets/sentry_auth_token ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
    else \
      echo "[sentry] Thiếu SENTRY_AUTH_TOKEN — build không upload source map."; \
    fi; \
    npm run build > next-build-output.txt 2>&1; \
    build_status=$?; \
    cat next-build-output.txt; \
    if [ "$build_status" -ne 0 ]; then exit "$build_status"; fi; \
    npm run verify:feedback:build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ARG SENTRY_RELEASE
ENV SENTRY_RELEASE=${SENTRY_RELEASE}
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/scripts/check-frontend-liveness.mjs ./scripts/check-frontend-liveness.mjs
EXPOSE 3000
CMD ["node", "server.js"]
