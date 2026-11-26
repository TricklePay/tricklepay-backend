# Container Image

The root `Dockerfile` builds two distinct container images using a multi-stage process:

1. **Build stage (`AS build`)**: installs all dependencies, generates the Prisma client, and compiles the TypeScript sources into `dist/`. This uses `node:22-alpine` (see [node-version-policy.md](node-version-policy.md)).
2. **Production dependencies stage (`AS prod-deps`)**: installs production-only dependencies (`npm ci --omit=dev --ignore-scripts`) and carries over the generated Prisma client artifacts from the build stage.
3. **Migration image (`AS migrate`)**: a dedicated, one-shot migration image containing the Prisma CLI, schema, migrations, and dependencies. Its default entrypoint executes `npx prisma migrate deploy`.
4. **Runtime API image (`AS runtime`)**: the default production service image containing only production dependencies, compiled `dist/`, Prisma schema, and `package.json`. Dev dependencies (such as TypeScript, Vitest, and the Prisma CLI) are excluded to minimize the runtime image footprint and attack surface.

The runtime API image starts as the non-root `node` user provided by the official
Node Alpine image. Its entrypoint is the container command:

```text
node dist/index.js
```

The service listens on `PORT` (default `3000`) on `HOST` (default `0.0.0.0`).
The image declares port `3000`; configure the platform mapping if `PORT` is
changed.

## Database Migration Path

Database migrations should be executed before starting or rolling out the API service:

- **Docker Compose**: The `docker-compose.yml` file defines a dedicated `migrate` service (`target: migrate`) that runs `prisma migrate deploy` ahead of the `api` service. The `api` service specifies `depends_on: { migrate: { condition: service_completed_successfully } }`, ensuring migrations complete successfully before the application starts.
- **Standalone Docker**:
  ```bash
  # Build and run the migration image
  docker build --target migrate -t tricklepay-migrate:latest .
  docker run --rm -e DATABASE_URL="$DATABASE_URL" tricklepay-migrate:latest
  ```
- **Kubernetes / ECS**: Run the migration image (`target: migrate`) as an init container or pre-deployment task before the API pods or tasks start.

## Dockerfile Linting with Hadolint

The repository enforces Dockerfile best practices and security rules using [`hadolint`](https://github.com/hadolint/hadolint) in CI via `.github/workflows/container.yml`.

- **Failure threshold**: The failure threshold is configured to `warning` in `.hadolint.yaml`. Any violation at severity `warning` or `error` fails the CI check.
- **Rules configuration**: Configuration is stored in `.hadolint.yaml`. Rules that do not apply to our Alpine-based Node container (such as Debian-specific `DL3008` for `apt-get` and `DL3018` for `apk add` version pinning) are explicitly documented and ignored.

## Base image tag policy

All stages use `node:22-alpine`: a floating tag that tracks the newest Node 22
release on the current Alpine base.

- **Major version pinned, patch floating.** The tag names the Node major that
  production runs (see [node-version-policy.md](node-version-policy.md)) and
  nothing finer, so every build picks up Node and Alpine security patches
  without a pull request. The release workflow builds with `--pull`, so a
  release never reuses a stale cached base.
- **Reproducibility comes from the published digest, not the base tag.**
  Deployments pin the image digest recorded in the release notes (see
  [Published images](#published-images)); that digest fixes the exact base
  layers that shipped.
- **The scan is the safety net.** Because the base floats, a new upstream
  vulnerability can fail the [vulnerability scan](#vulnerability-scan) on a
  pull request that did not touch the Dockerfile. Rebuilding usually clears it
  once Alpine or Node publish a fix; otherwise follow the ignore-list rules.
- **Changing the major** (for example to `node:24-alpine`) is a deliberate
  change made together with the CI matrix and the node version policy, never
  a side effect of a rebuild. Do not use `latest`, `lts` or `current` tags,
  and do not drop the `-alpine` suffix without re-checking the image size and
  scan results.

## CI checks

[`.github/workflows/container.yml`](../.github/workflows/container.yml) runs on
every pull request and on pushes to `main`. It never pushes an image.

- **Build and health check.** Builds the dedicated migration image (`target: migrate`),
  applies migrations against a PostgreSQL service container, builds the runtime API
  image (`target: runtime`), starts the service, and waits up to 180 seconds for Docker
  to report the `HEALTHCHECK` as `healthy`. If the container exits, turns `unhealthy` or
  runs out of time, the job fails and prints `docker inspect` state and the
  container logs. Startup verifies the public testnet Soroban RPC, so the job
  needs outbound network access to `soroban-testnet.stellar.org`.
- **Vulnerability scan.** See below.

## Vulnerability scan

The `scan` job builds the image and scans it with
[Trivy](https://trivy.dev) for OS package and npm vulnerabilities in the
artefact that is actually deployed.

- **Scanner version.** Trivy runs from the `aquasec/trivy` image, pinned by
  version and digest in the workflow (`TRIVY_IMAGE`). The same pin is used in
  `release.yml`; bump both together.
- **Failure threshold.** The job fails on any `CRITICAL` finding that is not
  in the ignore list. High and lower findings are reported but do not fail the
  build, matching the dependency audit, which looks at the npm tree only.
- **Report.** Every run uploads a `trivy-report` artifact with the full
  results at every severity, as JSON (`trivy-report.json`) and as a readable
  table (`trivy-report.txt`). Ignored findings appear in it marked as
  suppressed, so the ignore list stays visible.
- **Ignore list.** [`.trivyignore`](../.trivyignore) at the repository root.
  Every entry needs a comment naming the package, why the finding does not
  apply or cannot be fixed yet, and a link to the advisory, plus an
  `exp:YYYY-MM-DD` expiry no more than 90 days out. After the expiry Trivy
  reports the finding again and it must be re-reviewed. Prefer fixing the
  finding (upgrading the dependency or rebuilding on a patched base) over
  adding an entry.

## SBOMs

Software bills of materials are generated in
[CycloneDX](https://cyclonedx.org) JSON format (spec version 1.5 for the npm
SBOM; the image SBOM uses the version Trivy emits).

| SBOM | File | Tool | Produced by |
| --- | --- | --- | --- |
| npm dependencies | `tricklepay-backend-npm.cdx.json` | `npm sbom` from npm 10.9.2 (`NPM_SBOM_VERSION`), run with `--package-lock-only` | `sbom` job in `ci.yml` (artifact `sbom-npm`) and `release.yml` |
| Container image | `tricklepay-backend-image.cdx.json` | Trivy, at the pinned `TRIVY_IMAGE` version | `scan` job in `container.yml` (artifact `sbom-image`) and `release.yml` |

The npm SBOM covers the whole lockfile, documenting both runtime dependencies
and build-time tooling. The tool version that produced each file is also
recorded in its `metadata.tools`. Both files are attached to every GitHub release.

## Published images

Pushing a tag that starts with `v` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
builds the image and pushes it to
`ghcr.io/tricklepay/tricklepay-backend`. For a tag `v1.2.3` the image is
tagged `1.2.3`, `1.2`, `v1.2.3` and `latest`; pre-release tags such as
`v1.3.0-rc.1` get only the full version and the git tag, and the GitHub
release is marked as a pre-release.

The image carries the standard OCI labels, including
`org.opencontainers.image.source` (the repository URL),
`org.opencontainers.image.revision` (the commit SHA) and
`org.opencontainers.image.version` (the version from the tag):

```bash
docker inspect --format '{{json .Config.Labels}}' ghcr.io/tricklepay/tricklepay-backend:1.2.3
```

The workflow then creates the GitHub release with generated notes, or appends
to a release drafted by hand, adding the pushed image digest and attaching the
two SBOMs. Deploy by digest rather than by tag, because tags can move:

```text
ghcr.io/tricklepay/tricklepay-backend@sha256:<digest from the release notes>
```


# Container Image Verification

TricklePay container images are published to GitHub Container Registry (GHCR).

Release images are signed using Sigstore Cosign keyless signing and include
GitHub build provenance attestations.

## Image

```bash
docker pull ghcr.io/TricklePay/tricklepay-backend:<tag>
```

## Verify image signature

Install Cosign:

https://docs.sigstore.dev/cosign/system_config/installation/

Verify the image signature using the release workflow identity:

```bash
cosign verify \
  --certificate-identity-regexp='https://github.com/TricklePay/tricklepay-backend/.github/workflows/.*@refs/tags/.*' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/TricklePay/tricklepay-backend:<tag>
```

## Verify build provenance

Install GitHub CLI:

https://cli.github.com/

Verify the image's build provenance:

```bash
gh attestation verify \
  oci://ghcr.io/TricklePay/tricklepay-backend:<tag> \
  --owner TricklePay
```

## Verify by digest

For stronger reproducibility, verify an immutable image digest instead of a mutable tag.

```bash
cosign verify \
  --certificate-identity-regexp='https://github.com/TricklePay/tricklepay-backend/.github/workflows/.*@refs/tags/.*' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/TricklePay/tricklepay-backend@sha256:<digest>
```

Consumers should verify signatures and provenance before deploying
release images in production.
