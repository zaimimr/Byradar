FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

FROM deps AS web
ARG VITE_MAPTILER_KEY=""
ARG VITE_MAPTILER_STYLE="dataviz-v4-dark"
ENV VITE_MAPTILER_KEY=$VITE_MAPTILER_KEY
ENV VITE_MAPTILER_STYLE=$VITE_MAPTILER_STYLE
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --include-workspace-root \
  --workspace @oslomap/server --workspace @oslomap/pipeline \
  && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/pipeline ./packages/pipeline
COPY packages/server ./packages/server
COPY --from=web /app/packages/web/dist ./packages/web/dist
RUN mkdir -p /app/data /app/.cache && chown -R node:node /app/data /app/.cache
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "-w", "@oslomap/server", "start"]
