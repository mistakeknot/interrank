# interrank

Snapshot-backed AgMoDB ranking MCP server.

## Build & Test

```bash
cd interverse/interrank
pnpm install
pnpm build
pnpm test
```

## Run MCP Server

```bash
pnpm mcp
```

### Optional Runtime Flags

- `--snapshot-path /path/to/agmodb-snapshot.json.gz`
- `--snapshot-url https://.../agmodb-snapshot.json.gz`
- `--snapshot-repo mistakeknot/agmodb --snapshot-tag data-snapshot-latest --snapshot-asset agmodb-snapshot.json.gz`
- `--refresh-ms 300000`

### Snapshot Auth

If the snapshot repo is private, provide one of:
- `AGMODB_GITHUB_TOKEN`
- `GITHUB_TOKEN`
- `GH_TOKEN`

## Architecture

- `src/index.ts` — MCP server and tool handlers
- `src/load.ts` — snapshot load/decompress/index/sort helpers
- `src/types.ts` — snapshot schema types
- `.claude-plugin/plugin.json` — Claude plugin manifest
- `scripts/launch-interrank.sh` — plugin launcher
