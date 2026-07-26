# One image, two services.
#
# api and worker share every layer and differ only in CMD, so a deploy ships a
# single artifact and the two processes can never drift to different builds of
# the same code. The web app is a separate target because Next's standalone
# output has entirely different runtime needs.
#
# Build:
#   docker build -f infra/Dockerfile --target api    -t invoiceiq-api .
#   docker build -f infra/Dockerfile --target worker -t invoiceiq-worker .
#   docker build -f infra/Dockerfile --target web    -t invoiceiq-web .

# ---------------------------------------------------------------------- base
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Non-negotiable in an image build. `pnpm fetch` populates node_modules/.pnpm,
# so a later `--prod` install wants to purge and reinstall the modules
# directory -- and it *prompts* to confirm. With no TTY that prompt is never
# answered: pnpm gives up, leaves every workspace package unlinked, and still
# exits 0. The failure then surfaces much later as "sh: prisma: not found".
ENV CI=true
# Pinned so the image cannot silently build with a different resolver than CI.
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /app

# ------------------------------------------------------------------- fetch
# Only the lockfile lands here, so the (slow) dependency download is cached
# until dependencies actually change — not on every source edit.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

# ----------------------------------------------------------------- builder
FROM fetch AS builder
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# Generates into node_modules/.prisma; needs the schema only, not a database.
RUN pnpm --filter @invoiceiq/database db:generate
# turbo, not a bare pnpm filter: `dependsOn: ["^build"]` is what builds
# packages/{config,contracts,database,domain} first, in topological order.
RUN pnpm exec turbo run build --filter=@invoiceiq/api --filter=@invoiceiq/worker

# ---------------------------------------------------------------- deploy
# `pnpm deploy` emits a self-contained directory holding ONE package plus its
# transitive production dependencies, with workspace deps copied in as real
# directories instead of symlinks into the store.
#
# The alternative -- a workspace-root `pnpm install --prod` -- resolves
# dependencies for all eight projects at once, so the API image ended up
# carrying Next.js, two @next/swc native binaries, turbo and @swc/core: 470MB+
# of frontend and build tooling the API never loads.
FROM builder AS deploy-api
RUN pnpm --filter=@invoiceiq/api deploy --prod --legacy /out
# The Prisma client is generated, not published, so it must be produced inside
# the deployed tree. This is also why `prisma` is a runtime dependency: the
# deploy runs `prisma migrate deploy` as a release command.
# pnpm deploy nests each workspace dep's own binaries, so the CLI lives under
# the database package rather than the deployed root.
RUN cd /out/node_modules/@invoiceiq/database \
 && ./node_modules/.bin/prisma generate

FROM builder AS deploy-worker
RUN pnpm --filter=@invoiceiq/worker deploy --prod --legacy /out
# pnpm deploy nests each workspace dep's own binaries, so the CLI lives under
# the database package rather than the deployed root.
RUN cd /out/node_modules/@invoiceiq/database \
 && ./node_modules/.bin/prisma generate

# ------------------------------------------------------------ node runtime
FROM base AS node-runtime
ENV NODE_ENV=production
# dumb-init reaps zombies and, critically, forwards SIGTERM to node so the
# worker's graceful drain actually runs on deploy.
RUN apk add --no-cache dumb-init
WORKDIR /app
USER node
ENTRYPOINT ["dumb-init", "--"]

# ------------------------------------------------------------------- api
FROM node-runtime AS api
COPY --from=deploy-api --chown=node:node /out /app
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- worker
FROM node-runtime AS worker
COPY --from=deploy-worker --chown=node:node /out /app
# No HTTP port, so liveness is the Redis heartbeat the API reads instead.
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------- web
# Next standalone bundles its own minimal node_modules, so this stage shares
# nothing with the node-runtime tree above.
FROM fetch AS web-builder
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
RUN pnpm exec turbo run build --filter=@invoiceiq/web

FROM base AS web
ENV NODE_ENV=production
RUN apk add --no-cache dumb-init
COPY --from=web-builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-builder --chown=node:node /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=web-builder --chown=node:node /app/apps/web/public           ./apps/web/public
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
