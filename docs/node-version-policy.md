# Node Version Policy

Three different files each name a Node version, and they are deliberately
not the same number:

| File | Says | Role |
| --- | --- | --- |
| [`package.json`](../package.json) `engines.node` | `>=20.12` | **Minimum supported.** The floor the service is guaranteed to run on. |
| [`.nvmrc`](../.nvmrc) | `20.12.0` | **Local dev default.** The exact version `nvm use` switches you to — pinned to the floor, not a moving target. |
| [`Dockerfile`](../Dockerfile) | `node:22-alpine` | **Production.** What actually runs the service once deployed. |
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | `[20, 22]` matrix | **Tested.** Both ends of the supported range run the full test suite on every push and pull request. |

All three (and the CI matrix) are compatible with each other; none of this
is a version mismatch to fix. It's one policy expressed in four places:

## The policy

- **Minimum supported: Node 20.12.** This is the floor, encoded in
  `engines.node`. It's 20.12 and not an earlier 20.x release because the
  service relies on `node:`-protocol imports and the global `fetch` in a form
  that only became fully stable at that release; earlier 20.x versions can
  fail at install or at startup. `npm install` warns (and a CI or deploy
  pipeline that runs `npm ci --engine-strict` would fail outright) if the
  running Node is older than this.
- **Tested: Node 20 and Node 22.** The CI matrix in `ci.yml` runs
  `npm run typecheck`, `npm test`, and `npm run build` on both. Node 20
  confirms the floor still works as new code is added; Node 22 confirms the
  version actually running in production is exercised by the same suite,
  not assumed compatible by extrapolation.
- **Production: Node 22**, via `node:22-alpine` in the `Dockerfile`. This is
  what every deployed instance of the service actually runs on.
- **Local development defaults to Node 20.12.0** via `.nvmrc`, so
  `nvm use` with no arguments drops a contributor onto the minimum supported
  version rather than onto whatever they happened to have installed, or onto
  production's Node 22.

## Why `.nvmrc` pins the floor instead of matching production

Pinning local development to the *minimum* rather than to production's Node
22 is deliberate, not an oversight: it's the version most likely to surface a
compatibility problem. Code that only works on Node 22 but is developed and
tested exclusively on Node 22 can reach production (or merge past a CI matrix
someone skipped locally) without anyone noticing it no longer runs on 20.12 —
the version `engines.node` still promises callers. Developing against the
floor, with the CI matrix separately confirming the Node 22 production target
stays green, catches that gap before either side finds out the hard way.

## If you need to change any of this

- Raising the floor: update `engines.node`, `.nvmrc`, and the lower bound of
  the CI matrix together — they encode one decision, not three independent
  ones.
- Raising production's version: update the `node:22-alpine` tag in the
  `Dockerfile` (both stages) and the upper bound of the CI matrix together,
  so the version that ships is also the one CI exercises.
