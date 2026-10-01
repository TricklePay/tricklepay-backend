#!/usr/bin/env bash

set -e

echo "Running typecheck..."
npm run typecheck

echo "Running tests..."
npm test

echo "Running build..."
npm run build
