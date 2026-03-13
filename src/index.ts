import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  buildSnapshotIndexes,
  loadSnapshot,
  sortForMetric,
  type SnapshotIndexes,
  type SnapshotSource,
} from "./load.js";
import type { PublicDataSnapshot, SnapshotModel } from "./types.js";
import { scoreBenchmarks, recommendModels } from "./recommend.js";

const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const MAX_LIMIT = 200;
const DEFAULT_SNAPSHOT_REPOSITORY = "mistakeknot/agmodb";
const DEFAULT_SNAPSHOT_TAG = "data-snapshot-latest";
const DEFAULT_SNAPSHOT_ASSET = "agmodb-snapshot.json.gz";

type SnapshotState = {
  snapshot: PublicDataSnapshot;
  indexes: SnapshotIndexes;
  loadedAt: number;
};

class SnapshotStore {
  private state: SnapshotState | null = null;

  constructor(
    private readonly source: SnapshotSource,
    private readonly refreshMs: number,
  ) {}

  async get(): Promise<SnapshotState> {
    if (!this.state) {
      this.state = await this.loadFresh();
      return this.state;
    }

    if (Date.now() - this.state.loadedAt > this.refreshMs) {
      this.state = await this.loadFresh();
    }

    return this.state;
  }

  async refresh(): Promise<SnapshotState> {
    this.state = await this.loadFresh();
    return this.state;
  }

  private async loadFresh(): Promise<SnapshotState> {
    const snapshot = await loadSnapshot(this.source);
    const indexes = buildSnapshotIndexes(snapshot);
    return {
      snapshot,
      indexes,
      loadedAt: Date.now(),
    };
  }
}

function parseArgValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function resolveSourceFromArgs(argv: string[]): SnapshotSource {
  const argPath = parseArgValue(argv, "--snapshot-path");
  const argUrl = parseArgValue(argv, "--snapshot-url");
  const argRepo = parseArgValue(argv, "--snapshot-repo");
  const argTag = parseArgValue(argv, "--snapshot-tag");
  const argAsset = parseArgValue(argv, "--snapshot-asset");
  const envPath = process.env.AGMODB_SNAPSHOT_PATH;
  const envUrl = process.env.AGMODB_SNAPSHOT_URL;
  const envRepo = process.env.AGMODB_SNAPSHOT_REPOSITORY;
  const envTag = process.env.AGMODB_SNAPSHOT_TAG;
  const envAsset = process.env.AGMODB_SNAPSHOT_ASSET;
  const token =
    process.env.AGMODB_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    null;

  const path = argPath ?? envPath;
  if (path) {
    return { kind: "file", path };
  }

  const url = argUrl ?? envUrl;
  if (url) {
    return { kind: "url", url };
  }

  const repository = argRepo ?? envRepo ?? DEFAULT_SNAPSHOT_REPOSITORY;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid snapshot repository: ${repository}. Expected owner/repo.`
    );
  }

  return {
    kind: "githubRelease",
    owner,
    repo,
    tag: argTag ?? envTag ?? DEFAULT_SNAPSHOT_TAG,
    assetName: argAsset ?? envAsset ?? DEFAULT_SNAPSHOT_ASSET,
    token,
  };
}

function resolveRefreshMs(argv: string[]): number {
  const arg = parseArgValue(argv, "--refresh-ms") ?? process.env.AGMODB_SNAPSHOT_REFRESH_MS;
  if (!arg) return DEFAULT_REFRESH_MS;
  const value = Number(arg);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid refresh interval: ${arg}`);
  }
  return value;
}

function coerceLimit(limit: number | undefined): number {
  if (!limit) return 20;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

function sourceInfo(source: SnapshotSource): Record<string, string> {
  if (source.kind === "file") {
    return { kind: "file", path: source.path };
  }
  if (source.kind === "url") {
    return { kind: "url", url: source.url };
  }
  return {
    kind: "githubRelease",
    repository: `${source.owner}/${source.repo}`,
    tag: source.tag,
    assetName: source.assetName,
    auth: source.token ? "token" : "none",
  };
}

function sourceLabel(source: SnapshotSource): string {
  if (source.kind === "file") return source.path;
  if (source.kind === "url") return source.url;
  return `${source.owner}/${source.repo}@${source.tag}:${source.assetName}`;
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function getMetricValue(model: SnapshotModel, metricKey: string): number | null {
  const value = model.metricValues[metricKey];
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function filterByProvider(models: SnapshotModel[], provider?: string): SnapshotModel[] {
  if (!provider) return models;
  const p = provider.trim().toLowerCase();
  return models.filter(
    (model) =>
      model.providerSlug.toLowerCase() === p ||
      model.providerName.toLowerCase() === p
  );
}

function modelCard(model: SnapshotModel, metricKey?: string) {
  return {
    slug: model.slug,
    name: model.name,
    provider: model.providerName,
    providerSlug: model.providerSlug,
    releaseDate: model.releaseDate,
    capabilitySummary: model.capabilitySummary,
    metricValue: metricKey ? getMetricValue(model, metricKey) : null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const source = resolveSourceFromArgs(argv);
  const refreshMs = resolveRefreshMs(argv);

  const store = new SnapshotStore(source, refreshMs);
  const initial = await store.get();

  const server = new McpServer({
    name: "interrank",
    version: "0.2.0",
  });

  server.registerTool(
    "snapshot_info",
    {
      description:
        "Return snapshot metadata and currently configured source (local file, URL, or GitHub release asset).",
    },
    async () => {
      const state = await store.get();
      return jsonContent({
        source: sourceInfo(source),
        loadedAt: new Date(state.loadedAt).toISOString(),
        meta: state.snapshot.meta,
      });
    }
  );

  server.registerTool(
    "refresh_snapshot",
    {
      description: "Force-reload the snapshot from source now.",
    },
    async () => {
      const state = await store.refresh();
      return jsonContent({
        source: sourceInfo(source),
        loadedAt: new Date(state.loadedAt).toISOString(),
        meta: state.snapshot.meta,
      });
    }
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List models with optional text/provider filtering and metric sorting.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive search on name/slug/provider."),
        provider: z.string().optional().describe("Provider slug or provider name."),
        metricKey: z.string().optional().describe("Metric key to sort by (default: agmobench)."),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ query, provider, metricKey, sortDirection, limit }) => {
      const state = await store.get();

      let models = state.snapshot.models;

      if (query) {
        const q = query.trim().toLowerCase();
        models = models.filter(
          (model) =>
            model.name.toLowerCase().includes(q) ||
            model.slug.toLowerCase().includes(q) ||
            model.providerName.toLowerCase().includes(q) ||
            model.providerSlug.toLowerCase().includes(q)
        );
      }

      models = filterByProvider(models, provider);

      const sortKey = metricKey ?? "agmobench";
      const metric = state.indexes.metricsByKey.get(sortKey);
      if (!metric) {
        throw new Error(`Unknown metric key: ${sortKey}`);
      }

      const sorted = sortForMetric(models, sortKey, metric.higherIsBetter, sortDirection);
      const capped = sorted.slice(0, coerceLimit(limit));

      return jsonContent({
        total: models.length,
        returned: capped.length,
        sortMetric: { key: metric.key, label: metric.label, higherIsBetter: metric.higherIsBetter },
        items: capped.map((model) => modelCard(model, metric.key)),
      });
    }
  );

  server.registerTool(
    "get_model",
    {
      description: "Get a model by slug, including all metric values and prediction flags.",
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async ({ slug }) => {
      const state = await store.get();
      const model = state.indexes.modelsBySlug.get(slug);
      if (!model) {
        throw new Error(`Model not found: ${slug}`);
      }
      return jsonContent(model);
    }
  );

  server.registerTool(
    "list_benchmarks",
    {
      description: "List benchmark definitions and description metadata.",
      inputSchema: {
        query: z.string().optional(),
        category: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ query, category, source: benchmarkSource, limit }) => {
      const state = await store.get();
      let items = state.snapshot.benchmarks;

      if (query) {
        const q = query.trim().toLowerCase();
        items = items.filter((benchmark) => {
          return (
            benchmark.key.toLowerCase().includes(q) ||
            benchmark.slug.toLowerCase().includes(q) ||
            benchmark.name.toLowerCase().includes(q) ||
            benchmark.description?.toLowerCase().includes(q) ||
            benchmark.relevantUseCases.some((uc) => uc.toLowerCase().includes(q))
          );
        });
      }

      if (category) {
        const c = category.trim().toLowerCase();
        items = items.filter((benchmark) => benchmark.category.toLowerCase() === c);
      }

      if (benchmarkSource) {
        const s = benchmarkSource.trim().toLowerCase();
        items = items.filter((benchmark) => benchmark.source.toLowerCase() === s);
      }

      const capped = items.slice(0, coerceLimit(limit));
      return jsonContent({
        total: items.length,
        returned: capped.length,
        items: capped.map((benchmark) => ({
          key: benchmark.key,
          slug: benchmark.slug,
          name: benchmark.name,
          source: benchmark.source,
          category: benchmark.category,
          higherIsBetter: benchmark.higherIsBetter,
          description: benchmark.description,
          strengths: benchmark.strengths,
          caveats: benchmark.caveats,
          relevantUseCases: benchmark.relevantUseCases,
          scoreInterpretation: benchmark.scoreInterpretation ?? "unknown",
          contaminationRisk: benchmark.contaminationRisk ?? "unknown",
          freshnessType: benchmark.freshnessType ?? "unknown",
          metadataStatus: benchmark.metadataStatus ?? "unknown",
          maxScore: benchmark.maxScore,
        })),
      });
    }
  );

  server.registerTool(
    "recommend_benchmarks",
    {
      description:
        "Given a natural-language task description, return the most relevant benchmarks for evaluating models on that task. Uses keyword matching against benchmark metadata plus domain affinity boosting.",
      inputSchema: {
        task: z.string().min(1).describe("Natural-language task description, e.g. 'customer support chatbot' or 'code review agent'."),
        categories: z.array(z.string()).optional().describe("Optional category filter (e.g. ['coding', 'agents'])."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max benchmarks to return (default: 10)."),
      },
    },
    async ({ task, categories, limit }) => {
      const state = await store.get();
      let benchmarks = state.snapshot.benchmarks;

      if (categories && categories.length > 0) {
        const cats = new Set(categories.map((c) => c.trim().toLowerCase()));
        benchmarks = benchmarks.filter((b) => cats.has(b.category.toLowerCase()));
      }

      const results = scoreBenchmarks(task, benchmarks, coerceLimit(limit));

      return jsonContent({
        task,
        total: results.length,
        items: results.map((r) => ({
          key: r.key,
          slug: r.slug,
          name: r.name,
          category: r.category,
          description: r.description,
          caveats: r.caveats,
          relevantUseCases: r.relevantUseCases,
          scoreInterpretation: r.scoreInterpretation ?? "unknown",
          contaminationRisk: r.contaminationRisk ?? "unknown",
          freshnessType: r.freshnessType ?? "unknown",
          metadataStatus: r.metadataStatus ?? "unknown",
          score: r.score,
          matchReason: r.matchReason,
        })),
      });
    }
  );

  server.registerTool(
    "recommend_model",
    {
      description:
        "Given a task description, recommend the best models. Chains benchmark relevance scoring into weighted model ranking with confidence indicators.",
      inputSchema: {
        task: z.string().min(1).describe("Natural-language task description, e.g. 'code review agent for Go' or 'customer support chatbot'."),
        budget: z.enum(["low", "medium", "high"]).optional().describe("Budget constraint. low: <$1/MTok, medium: <$10/MTok, high: unlimited."),
        provider: z.string().optional().describe("Filter to models from this provider (slug or name)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max models to return (default: 5)."),
      },
    },
    async ({ task, budget, provider, limit }) => {
      const state = await store.get();

      const results = recommendModels(
        task,
        state.snapshot.benchmarks,
        state.snapshot.models,
        {
          budget,
          costMetric: "blendedPricePerM",
          provider,
          limit: limit ?? 5,
        },
      );

      return jsonContent({
        task,
        budget: budget ?? null,
        total: results.length,
        items: results,
      });
    }
  );

  server.registerTool(
    "leaderboard",
    {
      description:
        "Rank models by a metric key from the snapshot (read-only, no Neon queries).",
      inputSchema: {
        metricKey: z.string().min(1),
        provider: z.string().optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        includePredicted: z.boolean().optional().describe("Include BenchPress-predicted cells (default: true)."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ metricKey, provider, sortDirection, includePredicted, limit }) => {
      const state = await store.get();
      const metric = state.indexes.metricsByKey.get(metricKey);
      if (!metric) {
        throw new Error(`Unknown metric key: ${metricKey}`);
      }

      let models = filterByProvider(state.snapshot.models, provider);

      let ranked = sortForMetric(models, metric.key, metric.higherIsBetter, sortDirection)
        .filter((model) => getMetricValue(model, metric.key) != null);

      if (includePredicted === false) {
        ranked = ranked.filter(
          (model) => !model.predictedMetricKeys.includes(metric.key)
        );
      }

      const capped = ranked.slice(0, coerceLimit(limit));

      return jsonContent({
        metric: { key: metric.key, label: metric.label, higherIsBetter: metric.higherIsBetter },
        total: ranked.length,
        returned: capped.length,
        items: capped.map((model, index) => ({
          rank: index + 1,
          slug: model.slug,
          name: model.name,
          provider: model.providerName,
          value: model.metricValues[metric.key],
          predicted: model.predictedMetricKeys.includes(metric.key),
        })),
      });
    }
  );

  server.registerTool(
    "benchmark_leaderboard",
    {
      description:
        "Rank models for a benchmark by key or slug. Resolves higher/lower-is-better automatically from benchmark definitions.",
      inputSchema: {
        benchmark: z.string().min(1).describe("Benchmark key or slug."),
        provider: z.string().optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        includePredicted: z.boolean().optional().describe("Include BenchPress-predicted cells (default: true)."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ benchmark, provider, sortDirection, includePredicted, limit }) => {
      const state = await store.get();
      const resolved =
        state.indexes.benchmarksByKey.get(benchmark) ??
        state.indexes.benchmarksBySlug.get(benchmark);

      if (!resolved) {
        throw new Error(`Unknown benchmark key/slug: ${benchmark}`);
      }

      let models = filterByProvider(state.snapshot.models, provider);

      let ranked = sortForMetric(
        models,
        resolved.key,
        resolved.higherIsBetter,
        sortDirection
      ).filter((model) => getMetricValue(model, resolved.key) != null);

      if (includePredicted === false) {
        ranked = ranked.filter(
          (model) => !model.predictedMetricKeys.includes(resolved.key)
        );
      }

      const capped = ranked.slice(0, coerceLimit(limit));

      return jsonContent({
        benchmark: resolved,
        total: ranked.length,
        returned: capped.length,
        items: capped.map((model, index) => ({
          rank: index + 1,
          slug: model.slug,
          name: model.name,
          provider: model.providerName,
          value: model.metricValues[resolved.key],
          predicted: model.predictedMetricKeys.includes(resolved.key),
        })),
      });
    }
  );

  server.registerTool(
    "compare_models",
    {
      description:
        "Compare 2-10 models side-by-side across benchmarks. Returns a matrix of scores with prediction flags.",
      inputSchema: {
        slugs: z.array(z.string().min(1)).min(2).max(10).describe("Model slugs to compare."),
        benchmarkKeys: z.array(z.string()).optional().describe("Specific benchmark keys to compare on. If omitted, uses all benchmarks with data."),
        category: z.string().optional().describe("Filter benchmarks by category (e.g. 'coding')."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max benchmarks in the matrix."),
      },
    },
    async ({ slugs, benchmarkKeys, category, limit }) => {
      const state = await store.get();

      const models: SnapshotModel[] = [];
      const notFound: string[] = [];
      for (const slug of slugs) {
        const model = state.indexes.modelsBySlug.get(slug);
        if (!model) {
          notFound.push(slug);
        } else {
          models.push(model);
        }
      }
      if (notFound.length > 0) {
        throw new Error(`Models not found: ${notFound.join(", ")}`);
      }

      let benchmarks = state.snapshot.benchmarks;
      if (benchmarkKeys && benchmarkKeys.length > 0) {
        const keySet = new Set(benchmarkKeys);
        benchmarks = benchmarks.filter((b) => keySet.has(b.key));
      }
      if (category) {
        const c = category.trim().toLowerCase();
        benchmarks = benchmarks.filter((b) => b.category.toLowerCase() === c);
      }

      benchmarks = benchmarks.filter((b) =>
        models.some((m) => {
          const v = m.metricValues[b.key];
          return typeof v === "number" && !Number.isNaN(v);
        })
      );

      const cappedBenchmarks = benchmarks.slice(0, coerceLimit(limit));

      const modelHeaders = models.map((m) => ({
        slug: m.slug,
        name: m.name,
        provider: m.providerName,
      }));

      const benchmarkHeaders = cappedBenchmarks.map((b) => ({
        key: b.key,
        name: b.name,
        category: b.category,
        higherIsBetter: b.higherIsBetter,
      }));

      const cells = models.map((model) =>
        cappedBenchmarks.map((benchmark) => ({
          value: getMetricValue(model, benchmark.key),
          predicted: model.predictedMetricKeys.includes(benchmark.key),
        }))
      );

      const compositeKeys = ["agmobench", "agmobench_reasoning", "agmobench_coding", "agmobench_math", "agmobench_agentic", "agmobench_robustness"];
      const composites = compositeKeys.map((key) => ({
        key,
        values: models.map((model) => getMetricValue(model, key)),
      }));

      return jsonContent({
        models: modelHeaders,
        benchmarks: benchmarkHeaders,
        cells,
        composites,
      });
    }
  );

  const DOMAIN_METRIC_KEYS: Record<string, string> = {
    overall: "agmobench",
    reasoning: "agmobench_reasoning",
    coding: "agmobench_coding",
    math: "agmobench_math",
    agentic: "agmobench_agentic",
    robustness: "agmobench_robustness",
  };
  const VALID_DOMAINS = Object.keys(DOMAIN_METRIC_KEYS);

  server.registerTool(
    "domain_leaderboard",
    {
      description:
        "Rank models by AgMoBench domain index (reasoning, coding, math, agentic, robustness, overall). Resolves domain name to metric key automatically.",
      inputSchema: {
        domain: z.enum(["overall", "reasoning", "coding", "math", "agentic", "robustness"]).describe("AgMoBench domain to rank by."),
        provider: z.string().optional().describe("Filter by provider slug or name."),
        includePredicted: z.boolean().optional().describe("Include BenchPress-predicted cells (default: true)."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ domain, provider, includePredicted, limit }) => {
      const state = await store.get();
      const metricKey = DOMAIN_METRIC_KEYS[domain];
      const metric = state.indexes.metricsByKey.get(metricKey);
      if (!metric) {
        throw new Error(`Domain metric not found: ${metricKey}. Valid domains: ${VALID_DOMAINS.join(", ")}`);
      }

      let models = filterByProvider(state.snapshot.models, provider);

      let ranked = sortForMetric(models, metric.key, metric.higherIsBetter)
        .filter((model) => getMetricValue(model, metric.key) != null);

      if (includePredicted === false) {
        ranked = ranked.filter(
          (model) => !model.predictedMetricKeys.includes(metric.key)
        );
      }

      const capped = ranked.slice(0, coerceLimit(limit));

      return jsonContent({
        domain,
        metric: { key: metric.key, label: metric.label, higherIsBetter: metric.higherIsBetter },
        total: ranked.length,
        returned: capped.length,
        items: capped.map((model, index) => ({
          rank: index + 1,
          slug: model.slug,
          name: model.name,
          provider: model.providerName,
          value: model.metricValues[metric.key],
          predicted: model.predictedMetricKeys.includes(metric.key),
        })),
      });
    }
  );

  server.registerTool(
    "cost_leaderboard",
    {
      description:
        "Rank models by cost-efficiency: benchmark performance per dollar. Higher efficiency = better value. Provide exactly one of metricKey or domain (not both, not neither).",
      inputSchema: {
        metricKey: z.string().optional().describe("Metric key to rank efficiency for. Required if domain is not provided. Mutually exclusive with domain."),
        domain: z.enum(["overall", "reasoning", "coding", "math", "agentic", "robustness"]).optional().describe("AgMoBench domain. Required if metricKey is not provided. Mutually exclusive with metricKey."),
        costMetric: z.string().optional().describe("Cost metric key (default: blendedPricePerM)."),
        provider: z.string().optional().describe("Filter by provider slug or name."),
        includePredicted: z.boolean().optional().describe("Include BenchPress-predicted cells (default: true)."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ metricKey, domain, costMetric, provider, includePredicted, limit }) => {
      if (!metricKey && !domain) {
        throw new Error("Exactly one of metricKey or domain is required.");
      }
      if (metricKey && domain) {
        throw new Error("metricKey and domain are mutually exclusive.");
      }

      const state = await store.get();

      const resolvedMetricKey = domain ? DOMAIN_METRIC_KEYS[domain] : metricKey!;
      const metric = state.indexes.metricsByKey.get(resolvedMetricKey);
      if (!metric) {
        throw new Error(`Unknown metric key: ${resolvedMetricKey}`);
      }

      const costKey = costMetric ?? "blendedPricePerM";
      const costMeta = state.indexes.metricsByKey.get(costKey);
      if (!costMeta) {
        throw new Error(`Unknown cost metric key: ${costKey}`);
      }

      let models = filterByProvider(state.snapshot.models, provider);

      if (includePredicted === false) {
        models = models.filter(
          (model) => !model.predictedMetricKeys.includes(resolvedMetricKey)
        );
      }

      let excludedCount = 0;
      const withData = models.filter((model) => {
        const benchmarkValue = getMetricValue(model, resolvedMetricKey);
        const costValue = getMetricValue(model, costKey);
        if (benchmarkValue == null || costValue == null || costValue === 0) {
          excludedCount++;
          return false;
        }
        return true;
      });

      const ranked = withData.map((model) => {
        const benchmarkScore = getMetricValue(model, resolvedMetricKey)!;
        const costValue = getMetricValue(model, costKey)!;
        const efficiencyRatio = Math.round((benchmarkScore / costValue) * 100) / 100;

        return {
          slug: model.slug,
          name: model.name,
          provider: model.providerName,
          benchmarkScore: Math.round(benchmarkScore * 100) / 100,
          costValue: Math.round(costValue * 100) / 100,
          efficiencyRatio,
          predicted: model.predictedMetricKeys.includes(resolvedMetricKey),
        };
      });

      ranked.sort((a, b) => b.efficiencyRatio - a.efficiencyRatio);
      const capped = ranked.slice(0, coerceLimit(limit));

      return jsonContent({
        metric: { key: metric.key, label: metric.label, higherIsBetter: metric.higherIsBetter },
        costMetric: { key: costMeta.key, label: costMeta.label },
        domain: domain ?? null,
        total: ranked.length,
        returned: capped.length,
        excludedCount,
        items: capped.map((item, index) => ({
          rank: index + 1,
          ...item,
        })),
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stderr logging only, so stdout remains clean JSON-RPC stream.
  console.error(
    `interrank MCP server started with ${initial.snapshot.models.length} models from ${sourceLabel(source)}`
  );
}

main().catch((error) => {
  console.error("Failed to start interrank MCP server:", error);
  process.exit(1);
});
