# interrank

Snapshot-backed MCP server for querying AgMoDB models and benchmark metadata without direct Neon reads.

## What It Does

- Loads a published AgMoDB JSON snapshot (`.json` or `.json.gz`) from GitHub or local file.
- Serves read-only ranking and lookup tools over MCP stdio.
- Caches snapshot in memory and auto-refreshes on interval.

## MCP Tools

- `snapshot_info` — show snapshot lineage, schema/policy versions, and source.
- `refresh_snapshot` — force a source refresh.
- `list_models` — search and sort the model catalog.
- `get_model` — return one model with all metrics and prediction flags.
- `list_benchmarks` — search complete benchmark descriptions and caveats.
- `recommend_benchmarks` — map a natural-language task to relevant evals.
- `recommend_model` — return an `agmodb.decision-packet.v1` as validated
  `structuredContent`, with a concise JSON text summary for older clients.
- `leaderboard` — rank by any metric.
- `benchmark_leaderboard` — rank by benchmark key or slug.
- `compare_models` — compare models across a benchmark matrix.
- `domain_leaderboard` — rank an AgMoBench domain.
- `cost_leaderboard` — rank benchmark performance per dollar.
- `resolve_routing_name` — resolve a routing alias to an AgMoDB family/variant.
- `routing_compare` — compare routing families.
- `list_model_families` — enumerate routing-level families.

### Decision Packet

`recommend_model` accepts free-form task text and hard constraints:

```json
{
  "task": "Review and fix bugs in a large TypeScript monorepo",
  "constraints": {
    "providers": ["Anthropic", "OpenAI"],
    "maxBlendedPricePerMillion": 6,
    "minOutputTokensPerSecond": 60,
    "maxTimeToFirstTokenSeconds": 1,
    "minContextWindow": 100000,
    "requireOpenWeight": false,
    "allowPredicted": true
  },
  "limit": 3
}
```

The packet includes stable model-level route identity, authoritative variant
when the snapshot has one, an explicit unresolved-harness boundary, cost,
latency, evidence source/caveats, observed versus predicted labels,
coverage-based uncertainty, freshness, alternatives, catalog digest, and the
next discriminating eval. The tool is annotated read-only, non-destructive, and
idempotent. Legacy `budget` and `provider` inputs remain accepted and are
translated into canonical hard constraints.

AgMoDB snapshot v3 supplies the full contract, policy, digest, open-weight,
freshness, and variant fields. v2 snapshots remain readable; missing identity
and openness fields fall back conservatively rather than being inferred.

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
