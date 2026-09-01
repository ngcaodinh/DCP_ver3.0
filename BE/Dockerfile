# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
# .git bị loại khỏi context nên release phải được truyền tường minh từ CI/build args.
ARG SENTRY_RELEASE
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV SENTRY_RELEASE=${SENTRY_RELEASE}
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm run build

# Token dùng BuildKit secret, không dùng ARG/ENV để không lưu lại trong image history.
# Build local/PR không có secret vẫn phải hoàn tất mà không upload source map.
RUN --mount=type=secret,id=sentry_auth_token \
    if [ -s /run/secrets/sentry_auth_token ] && [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
      npx sentry-cli sourcemaps inject ./dist && \
      npx sentry-cli sourcemaps upload --release "$SENTRY_RELEASE" ./dist; \
    else \
      echo "[sentry] Thiếu SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT — bỏ qua upload source map."; \
    fi

# Không phát tán source map trong image runtime; debug ID đã được inject vào JavaScript.
RUN find ./dist -name '*.js.map' -delete

# Phải prune sau bước upload vì @sentry/cli là devDependency.
RUN npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# ARG không kế thừa giữa stages; runtime release phải khớp release lúc build/upload.
ARG SENTRY_RELEASE
ENV SENTRY_RELEASE=${SENTRY_RELEASE}
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY templates ./templates
EXPOSE 4000
CMD ["npm", "run", "start"]
