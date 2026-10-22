# Container Image

The root `Dockerfile` builds the backend in two stages:

1. The `node:22-alpine` build stage installs the locked dependencies, generates
   the Prisma client, and compiles the TypeScript sources into `dist/`. This is
   newer than the minimum Node version the service supports — see
   [node-version-policy.md](node-version-policy.md) for why the two differ.
2. The runtime stage contains the production `node_modules`, compiled `dist/`,
   the Prisma schema and migrations, and `package.json`.

The runtime image starts as the non-root `node` user provided by the official
Node Alpine image. Its entrypoint is the container command:

```text
node dist/index.js
```

The service listens on `PORT` (default `3000`) on `HOST` (default `0.0.0.0`).
The image declares port `3000`; configure the platform mapping if `PORT` is
changed. Database migrations are applied by the deployment command before the
server starts when using the repository's Docker Compose setup.
