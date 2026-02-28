#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for interrank. Install pnpm and retry." >&2
  exit 1
fi

if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
  echo "Installing interrank dependencies..." >&2
  pnpm --dir "$PLUGIN_ROOT" install --no-frozen-lockfile --silent
fi

# If no explicit token is set, reuse gh CLI auth for private release assets.
if [ -z "${AGMODB_GITHUB_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  AGMODB_GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
  export AGMODB_GITHUB_TOKEN
fi

exec pnpm --dir "$PLUGIN_ROOT" mcp "$@"
