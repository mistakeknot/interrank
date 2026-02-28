# interrank

Snapshot-backed MCP server for querying AgMoDB models and benchmark metadata without direct Neon reads.

## What It Does

- Loads a published AgMoDB JSON snapshot (`.json` or `.json.gz`) from GitHub or local file.
- Serves read-only ranking and lookup tools over MCP stdio.
- Caches snapshot in memory and auto-refreshes on interval.

## MCP Tools

- `snapshot_info`
- `refresh_snapshot`
- `list_models`
- `get_model`
- `list_benchmarks`
- `leaderboard`
- `benchmark_leaderboard`

## Local Run

```bash
cd interverse/interrank
pnpm install
pnpm mcp
```

Optional args:

```bash
pnpm mcp --snapshot-url https://.../agmodb-snapshot.json.gz
pnpm mcp --snapshot-path /absolute/path/agmodb-snapshot.json.gz
pnpm mcp --snapshot-repo mistakeknot/agmodb --snapshot-tag data-snapshot-latest --snapshot-asset agmodb-snapshot.json.gz
pnpm mcp --refresh-ms 300000
```

## Plugin Wiring

The plugin manifest points at `scripts/launch-interrank.sh`, which auto-installs dependencies (if needed) and launches `pnpm mcp`.

## Data Source

Default snapshot source is GitHub release asset resolution via API:
- Repository: `mistakeknot/agmodb`
- Tag: `data-snapshot-latest`
- Asset: `agmodb-snapshot.json.gz`

Override with env vars:

- `AGMODB_SNAPSHOT_PATH`
- `AGMODB_SNAPSHOT_URL`
- `AGMODB_SNAPSHOT_REPOSITORY`
- `AGMODB_SNAPSHOT_TAG`
- `AGMODB_SNAPSHOT_ASSET`
- `AGMODB_GITHUB_TOKEN` (or `GITHUB_TOKEN` / `GH_TOKEN` for private repos)
- `AGMODB_SNAPSHOT_REFRESH_MS`
