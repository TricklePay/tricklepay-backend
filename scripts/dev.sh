#!/usr/bin/env bash
#
# One-command local development: start Postgres, sync the schema, run the
# server with live reload. Requires Docker and a `.env` file (copy from
# `.env.example` and set STREAM_CONTRACT_ID).

set -euo pipefail

echo "Starting Postgres..."
docker compose up -d postgres

echo "Waiting for Postgres to accept connections..."
until docker compose exec -T postgres pg_isready -U tricklepay >/dev/null 2>&1; do
  sleep 1
done

echo "Syncing database schema..."
npx prisma db push

echo "Starting the API and indexer..."
npm run dev
