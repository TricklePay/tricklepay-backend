# Documentation update: failed events table

## Summary

This PR updates the project documentation to describe the `FailedEvent` table, how operators can inspect unresolved failed events, and how the indexer continues processing when one event fails.

## Files updated

- [README.md](README.md)
- [docs/database-schema.md](docs/database-schema.md)

## What was documented

- What data is stored for a failed event in `FailedEvent`
- How to inspect the table via SQL queries
- How to preview failed-event retries using the replay CLI command
- The cursor behavior when an event fails: the page continues and the cursor is not rewound to the failing event
- The fact that `lastLedger` only advances after a successful apply

## Verification performed

I ran the following commands in the repository:

```bash
npm install --no-fund --no-audit
npm run typecheck
npm test
```

## Actual results

- `npm install --no-fund --no-audit` completed successfully.
- `npm run typecheck` failed with 3 TypeScript errors in the current repository state:
  - `src/indexer/poller.ts` — missing exported members `indexedEventFromDecoded` and `recordIndexedEvent`
  - `src/routes/streams.ts` — bigint mismatch in `getStream(streamId)`
- `npm test` failed with 10 failing tests and 314 passing tests in the current repository state.

## Notes

This PR is documentation-only and reflects the verified repository state at the time of writing. It does not claim the repository is fully green; the validation output above is the actual result from the commands run here.
