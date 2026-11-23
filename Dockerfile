# Build stage: install all dependencies, generate the Prisma client, compile TS.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm ci runs the postinstall hook (prisma generate), which needs the schema,
# so copy it before installing. Copying only prisma/ keeps the dependency
# layer cached across source-only changes.
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# Dedicated production dependencies stage: install only production dependencies.
# --ignore-scripts prevents postinstall from running prisma generate without prisma CLI.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts
# Copy generated Prisma client artifacts from the build stage.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Migration stage: dedicated one-shot image containing the Prisma CLI and migrations.
FROM node:22-alpine AS migrate
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
COPY --from=build --chown=node:node /app/node_modules ./node_modules
USER node
ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]

# Runtime stage: carry over the compiled dist and production dependencies only.
# Dev dependencies (prisma CLI, typescript, vitest, etc.) are omitted, producing a smaller image.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/prisma ./prisma

USER node

EXPOSE 3000

# Liveness only: /health returns 200 as soon as the process is up and does
# no database read, so a transient DB hiccup never flaps the container to
# unhealthy (that distinction is what /ready is for). --start-period gives
# Prisma client generation and initial connection setup room before checks
# count toward the container's health state.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
