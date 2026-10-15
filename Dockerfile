# ---------------------------------------------------------------------------
# Production image: one process serving the API and the built client.
#
# NOTE ON VERIFICATION: Docker was not available in the environment this project
# was built in, so this file has not been built or run by the author. It follows
# the standard npm-workspaces pattern and the exact commands that ARE verified
# natively (`npm ci`, `npm run build`, `node server/src/server.js` with
# NODE_ENV=production). Treat it as the documented alternative to the native Node
# deployment in docs/DEPLOYMENT.md, which is the path that was exercised.
# ---------------------------------------------------------------------------

# --- stage 1: build the client ---------------------------------------------
FROM node:22-alpine AS client-build
WORKDIR /app

# Manifests first so the dependency layer is cached independently of source edits.
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/

# Dev dependencies are required here (Vite lives in them). mongodb-memory-server
# would otherwise download a mongod binary into the build, which nothing in this
# stage uses.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN npm ci --workspace client --include-workspace-root

COPY client/ client/
RUN npm run build --workspace client

# --- stage 2: production dependencies only ---------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN npm ci --omit=dev --workspace server --include-workspace-root

# --- stage 3: runtime ------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_CLIENT=true

WORKDIR /app

# Run unprivileged: nothing in this image needs root after installation.
RUN addgroup -S nodejs -g 1001 && adduser -S app -u 1001 -G nodejs

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server/package.json server/package.json
COPY server/src ./server/src
COPY --from=client-build /app/client/dist ./client/dist

USER app
EXPOSE 4000

# The container is unhealthy until the API answers, not merely until it is running.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/server.js"]
