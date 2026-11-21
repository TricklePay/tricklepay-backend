# Test coverage

Unit test coverage is measured with Vitest's V8 provider. It is reported, not
enforced: no threshold fails the build yet. The figures below are the baseline
that a future threshold should be set against.

## Running it

```sh
npm run test:coverage
```

This runs the `unit` project with `--coverage` and writes the report to
`coverage/` (ignored by git). Open `coverage/index.html` for the line-by-line
view. Only `src/**/*.ts` is measured; the generated Prisma client is excluded.
The integration project is not part of the figure.

## In CI

The `coverage` job in [`ci.yml`](../.github/workflows/ci.yml) runs the same
command on Node 22, then:

- appends a per-file table to the job summary (rendered by
  [`scripts/coverage-summary.mjs`](../scripts/coverage-summary.mjs) from
  `coverage/coverage-summary.json`), and
- uploads the whole `coverage/` directory as the `coverage-report` artifact,
  kept for 14 days.

## Baseline

Recorded on 2026-11-20, with Vitest 4.1.10, from the unit project.

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| **All of `src/`** | 79.93% | 73.49% | 83.69% | 79.70% |
| `src/indexer/poller.ts` | 95.65% | 85.71% | 82.35% | 95.41% |
| `src/indexer/replay.ts` | 34.92% | 28.42% | 37.50% | 33.87% |
| `src/routes/streams.ts` | 84.39% | 73.57% | 100.00% | 85.22% |
| `src/routes/status.ts` | 100.00% | 96.29% | 100.00% | 100.00% |
| `src/repositories/streams.ts` | 61.11% | 60.56% | 54.54% | 59.49% |

`replay.ts` is the clearest gap: most of its CLI paths are untested. When a
threshold is introduced, set it a little below the figures in the latest CI
summary so that it catches regressions without blocking unrelated changes.
