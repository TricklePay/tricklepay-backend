# Documentation Index

This directory contains technical documentation and operational guides for the TricklePay backend service:

- [database-schema.md](database-schema.md): PostgreSQL schema reference covering models (`Stream`, `IndexedEvent`, `FailedEvent`, `IndexerState`), field definitions, types, indexes, and persistence logic.
- [event-replay.md](event-replay.md): Operator guide for the event replay recovery CLI tool (`npm run replay-failed-events`), detailing how to inspect, dry-run, and reprocess failed events.
- [failed-events-retention.md](failed-events-retention.md): Recommended data retention windows and SQL cleanup instructions for pruning unresolved records from the `FailedEvent` table.
- [glossary.md](glossary.md): Terminology definitions for domain and indexer concepts, including cursors, ledgers, backfill, lag, and event application.
