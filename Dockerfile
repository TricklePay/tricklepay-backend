# Build stage: install all dependencies, generate the Prisma client, compile TS.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# Runtime stage: carry over the built output and the resolved dependencies,
# including the generated Prisma client.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
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
