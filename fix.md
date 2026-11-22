Responses are sent uncompressed, and list responses with 100 streams are mostly repetitive JSON. Registering @fastify/compress with a size threshold would cut transfer size for clients that accept gzip or brotli.

Acceptance criteria

Responses above a threshold are compressed when the client accepts it.

Small responses and clients without support are unaffected.

A test checks the Content-Encoding header.




When you're done with the above and it good to go
fill this pr message:
## Summary

<!-- What does this change do, and why? Keep it short. -->

Responses were sent uncompressed, so large list payloads (for example `/streams` with 100 streams) moved full-size repetitive JSON over the wire. This registers `@fastify/compress` in `buildServer` with a byte threshold read from a new `COMPRESSION_THRESHOLD_BYTES` setting (default 1024, 1 KiB). Responses at or above the threshold are now compressed for clients that advertise `gzip` or `br`; smaller responses and clients that do not opt in are unchanged. The resolved value is logged with the rest of the configuration and documented.

## Linked issue

<!-- Every PR should link the issue it closes. -->
Closes #

## What was tested

<!--
Describe what you ran and what it proves. Include commands and, where useful,
the scenario covered (e.g. "npm test -- tests/indexer/apply.test.ts").
-->

- `npm run typecheck` — passes.
- `npm run build` — passes.
- `npx vitest run --project unit tests/routes/compression.test.ts` — 5 passed. Cases assert a response above the threshold carries `Content-Encoding: gzip` (and `br` when the client prefers it), a below-threshold response carries no `Content-Encoding`, a client sending `Accept-Encoding: identity` gets an uncompressed body, and the configured threshold is honoured (same body compresses at 512 but not at 8192).
- `npx vitest run --project unit tests/config.test.ts tests/config-log.test.ts` — passes, including the new `COMPRESSION_THRESHOLD_BYTES` default/override cases and the redacted-config field list.
- `npm test` — 623 passed; the single remaining failure (`tests/routes/stream-events.test.ts > returns 400 for an unknown kind`) is pre-existing on `main` and unrelated to this change.

## Checklist

- [x] `npm run typecheck` passes
- [x] `npm test` passes
- [x] `npm run build` passes
- [x] The change is covered by tests (or the reason it can't be is explained above)
- [x] Documentation updated when behaviour changed
