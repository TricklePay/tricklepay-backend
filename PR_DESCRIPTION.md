# Documentation update: failed events table

## Summary

This change documents the `FailedEvent` table and the workflow operators use to inspect and retry unresolved events without halting indexer progress.

## What was implemented

- Added a dedicated `Failed events table` section to the project README.
- Documented the exact data recorded when an event fails to apply:
  - `eventId`
  - `kind`
  - `streamId`
  - `ledger`
  - `error`
  - `failureCount`
  - `firstFailedAt` and `lastFailedAt`
- Added examples for inspecting failed rows in PostgreSQL.
- Added guidance for using the built-in replay command to check the next batch without mutating state.
- Clarified the indexer cursor behavior when an event fails: the cursor is advanced past the page, and `lastLedger` only moves after a successful apply.
- Expanded the database-schema reference to explain what is written to `FailedEvent`, how to query it, and why the cursor is not rewound on a failed event.

## Why this matters

The indexer is designed to skip bad events instead of stalling indexing. That behavior is only operationally useful if operators know the table exists, what is stored there, and how to query it.

## Verification status

Important: the repository currently has existing TypeScript errors unrelated to this documentation-only patch. The latest verification command was:

```bash
npm run typecheck
```

and it failed with these issues:

- `src/indexer/poller.ts`: exported members `indexedEventFromDecoded` and `recordIndexedEvent` are missing
- `src/routes/streams.ts`: bigint argument mismatch in `getStream(streamId)`

Those issues predate the documentation change and still need to be resolved before the repo is green.

## Suggested PR title

`docs: document the failed events table`

## Suggested PR body

### Summary

Document the `FailedEvent` table and how operators can inspect and retry failed events.

### Changes

- Added `FailedEvent` table documentation in the main README
- Added inspection queries and dry-run replay examples
- Explained the cursor behavior on failed event application
- Expanded the schema docs to cover persisted failure metadata

### Acceptance criteria

- The documentation explains what is recorded when an event fails to apply.
- It shows how to inspect the failed events.
- It states what happens to the indexer cursor when an event fails.

### Notes

The repository currently does not pass `npm run typecheck` because of existing TypeScript errors unrelated to the documentation patch.
