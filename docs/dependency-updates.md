# Dependency updates

Two pieces of automation keep dependencies current: Dependabot opens the update
pull requests, and a weekly canary build warns when the newest versions break
the build before those pull requests arrive.

## Dependabot

Configured in [`.github/dependabot.yml`](../.github/dependabot.yml). It covers
three ecosystems, each checked weekly on Monday at 06:00 UTC:

| Ecosystem | What it watches | Grouping | Open PR limit |
| --- | --- | --- | ---: |
| `npm` | `package.json` / `package-lock.json` | `prisma` + `@prisma/*` together; other production minor/patch in one PR; other development minor/patch in one PR; majors one PR each | 5 |
| `docker` | base images in the `Dockerfile` | all in one PR | 2 |
| `github-actions` | actions used in `.github/workflows/` | all in one PR | 2 |

Two majors are ignored on purpose because they are policy decisions, not
routine bumps (see [node-version-policy.md](node-version-policy.md)): the
`node` base image and `@types/node`. Minor and patch releases of both still
arrive.

**Security updates are not delayed.** The groups, schedule and PR limits apply
to version updates only. A security update is opened as its own pull request
as soon as an advisory is published, and does not count towards the limit. This
requires "Dependabot security updates" to be enabled under the repository's
*Code security* settings.

## Canary build

[`.github/workflows/canary.yml`](../.github/workflows/canary.yml) runs every
Monday at 05:00 UTC, an hour before Dependabot, and can be started by hand from
the Actions tab (*Run workflow*). On Node 20 and 22 it:

1. installs from the lockfile (`npm ci`),
2. writes the output of `npm outdated` to the job summary,
3. runs `npm update`, moving every dependency to the newest version its
   `package.json` range allows,
4. runs `npm run typecheck`, `npm test` and `npm run build`.

It never commits or pushes: the checkout has no stored credentials and the job
only has read access to the repository contents. The updated lockfile is thrown
away with the runner.

When it fails, the failing step carries an error annotation, and a follow-up job
opens an issue titled *Canary build failing with the latest dependency
versions*. Later failures comment on that issue instead of opening another.
Close it once the breakage is fixed or the offending version is pinned.

`npm update` stays within the declared ranges, so it does not test new major
versions; those arrive as individual Dependabot pull requests and are tested by
the regular CI on that pull request.
