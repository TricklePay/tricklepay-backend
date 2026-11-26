#!/usr/bin/env bash

set -e

# Parse command line arguments
INTEGRATION=false
for arg in "$@"; do
  case $arg in
    --integration)
      INTEGRATION=true
      shift
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--integration]"
      exit 1
      ;;
  esac
done

echo "Running typecheck..."
npm run typecheck

echo "Running tests..."
npm test

echo "Running build..."
npm run build

echo "Running depcheck..."
npm run depcheck

if [ "$INTEGRATION" = true ]; then
  echo "Running integration tests..."
  npm run test:integration
fi
