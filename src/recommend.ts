import type { SnapshotBenchmark, SnapshotModel } from "./types.js";

export type ScoredBenchmark = SnapshotBenchmark & {
  score: number;
  matchReason: string;
};

/**
 * Map of task archetype keywords → benchmark categories.
 * When a query matches an archetype, benchmarks in those categories get a boost.
 */
export const TASK_DOMAIN_MAP: Record<string, string[]> = {
  "coding": ["coding", "agents"],
  "programming": ["coding", "agents"],
  "software engineering": ["coding", "agents"],
  "code review": ["coding", "agents", "fluxbench"],
  "chatbot": ["quality", "safety"],
  "customer support": ["quality", "safety"],
  "research": ["reasoning", "knowledge"],
  "math": ["math", "reasoning"],
  "data science": ["coding", "math", "reasoning"],
  "writing": ["quality"],
  "summarization": ["quality", "long-context"],
  "agent": ["agents", "coding", "fluxbench"],
  "automation": ["agents", "coding", "fluxbench"],
  "factual": ["safety", "knowledge"],
  "hallucination": ["safety"],
};

const WEIGHT_USE_CASE = 3;
const WEIGHT_DESCRIPTION = 1;
const WEIGHT_CATEGORY = 1.5;
const WEIGHT_NAME = 1;
const DOMAIN_BOOST = 2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function fieldMatches(tokens: string[], text: string): string[] {
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token));
}

function resolveAffinityDomains(query: string): string[] {
  const lower = query.toLowerCase();
  const domains = new Set<string>();
  for (const [archetype, archetypeDomains] of Object.entries(TASK_DOMAIN_MAP)) {
    if (lower.includes(archetype)) {
      for (const domain of archetypeDomains) {
        domains.add(domain);
      }
    }
  }
  return [...domains];
}

/**
 * Score benchmarks against a natural-language task query.
 *
 * Scoring:
 * - Token overlap against relevantUseCases (weight 3)
 * - Token overlap against description (weight 1)
 * - Token overlap against category (weight 1.5)
 * - Token overlap against name (weight 1)
 * - Domain affinity boost when task matches a TASK_DOMAIN_MAP archetype (weight 2)
 *
 * Returns benchmarks with score > 0, sorted descending by score.
 */
export function scoreBenchmarks(
  task: string,
  benchmarks: SnapshotBenchmark[],
  limit: number = 10,
): ScoredBenchmark[] {
  const tokens = tokenize(task);
  if (tokens.length === 0) return [];

  const affinityDomains = resolveAffinityDomains(task);

  const scored: ScoredBenchmark[] = [];

  for (const benchmark of benchmarks) {
    let score = 0;
    const reasons: string[] = [];

    // Match against relevantUseCases
    for (const useCase of benchmark.relevantUseCases ?? []) {
      const matches = fieldMatches(tokens, useCase);
      if (matches.length > 0) {
        score += matches.length * WEIGHT_USE_CASE;
        reasons.push(`matched '${matches.join("', '")}' in useCases`);
      }
    }

    // Match against description
    if (benchmark.description) {
      const matches = fieldMatches(tokens, benchmark.description);
      if (matches.length > 0) {
        score += matches.length * WEIGHT_DESCRIPTION;
        reasons.push(`matched '${matches.join("', '")}' in description`);
      }
    }

    // Match against category
    const categoryMatches = fieldMatches(tokens, benchmark.category);
    if (categoryMatches.length > 0) {
      score += categoryMatches.length * WEIGHT_CATEGORY;
      reasons.push(`matched '${categoryMatches.join("', '")}' in category`);
    }

    // Match against name
    const nameMatches = fieldMatches(tokens, benchmark.name);
    if (nameMatches.length > 0) {
      score += nameMatches.length * WEIGHT_NAME;
      reasons.push(`matched '${nameMatches.join("', '")}' in name`);
    }

    // Domain affinity boost
    if (affinityDomains.length > 0 && affinityDomains.includes(benchmark.category)) {
      score += DOMAIN_BOOST;
      reasons.push(`boosted by '${benchmark.category}' domain affinity`);
    }

    if (score > 0) {
      scored.push({
        ...benchmark,
        score,
        matchReason: reasons.join("; "),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export type ModelRecommendation = {
  slug: string;
  name: string;
  provider: string;
  weightedScore: number;
  confidence: number;
  matchReason: string;
};

export type RecommendOptions = {
  budget?: "low" | "medium" | "high";
  costMetric?: string;
  budgetThresholds?: Record<string, number>;
  provider?: string;
  limit?: number;
};

const DEFAULT_BUDGET_THRESHOLDS: Record<string, number> = {
  low: 1,
  medium: 10,
  high: Infinity,
};

const PREDICTED_DISCOUNT = 0.7;
const MIN_BENCHMARK_COVERAGE = 2;

/**
 * Recommend models for a natural-language task.
 *
 * 1. Score benchmarks for relevance (reuses scoreBenchmarks)
 * 2. For each model, compute weighted score across relevant benchmarks
 * 3. Apply predicted score discount (0.7x for BenchPress-predicted values)
 * 4. Filter by budget, provider, and minimum benchmark coverage
 * 5. Return ranked models with confidence and reasoning
 */
export function recommendModels(
  task: string,
  benchmarks: SnapshotBenchmark[],
  models: SnapshotModel[],
  options: RecommendOptions,
): ModelRecommendation[] {
  const relevantBenchmarks = scoreBenchmarks(task, benchmarks, benchmarks.length);
  if (relevantBenchmarks.length === 0) return [];

  const thresholds = options.budgetThresholds ?? DEFAULT_BUDGET_THRESHOLDS;
  const costMetric = options.costMetric ?? "blendedPricePerM";
  const limit = options.limit ?? 50;

  // Filter models by provider
  let candidateModels = models;
  if (options.provider) {
    const p = options.provider.trim().toLowerCase();
    candidateModels = candidateModels.filter(
      (m) => m.providerName.toLowerCase() === p || m.providerSlug.toLowerCase() === p,
    );
  }

  // Filter models by budget (exclude models with unknown cost)
  if (options.budget) {
    const maxCost = thresholds[options.budget] ?? Infinity;
    candidateModels = candidateModels.filter((m) => {
      const cost = m.metricValues[costMetric];
      if (typeof cost !== "number" || Number.isNaN(cost)) return false;
      return cost <= maxCost;
    });
  }

  // Score each model across relevant benchmarks
  const scored: ModelRecommendation[] = [];

  for (const model of candidateModels) {
    let totalWeightedScore = 0;
    let totalWeight = 0;
    let coveredCount = 0;
    const reasons: string[] = [];

    for (const benchmark of relevantBenchmarks) {
      const value = model.metricValues[benchmark.key];
      if (typeof value !== "number" || Number.isNaN(value)) continue;

      coveredCount++;
      const isPredicted = model.predictedMetricKeys.includes(benchmark.key);
      const discount = isPredicted ? PREDICTED_DISCOUNT : 1.0;
      const weight = benchmark.score * discount;

      totalWeightedScore += value * weight;
      totalWeight += weight;

      if (isPredicted) {
        reasons.push(`${benchmark.name} (predicted)`);
      } else {
        reasons.push(benchmark.name);
      }
    }

    if (coveredCount < MIN_BENCHMARK_COVERAGE) continue;

    const confidence = coveredCount / relevantBenchmarks.length;
    const normalizedScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

    scored.push({
      slug: model.slug,
      name: model.name,
      provider: model.providerName,
      weightedScore: Math.round(normalizedScore * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      matchReason: `Scored on: ${reasons.join(", ")}`,
    });
  }

  scored.sort((a, b) => {
    const scoreDiff = b.weightedScore - a.weightedScore;
    if (scoreDiff !== 0) return scoreDiff;
    return b.confidence - a.confidence;
  });

  return scored.slice(0, limit);
}

export const HERMES_ROUTE_TASKS = [
  "vision",
  "web_extract",
  "compression",
  "skills_hub",
  "approval",
  "mcp",
  "title_gen",
  "curator",
] as const;

export type HermesRouteTask = (typeof HERMES_ROUTE_TASKS)[number];

export const HERMES_ROUTE_LANES = [
  "balanced",
  "budget",
  "quality",
  "fast",
] as const;

export type HermesRouteLane = (typeof HERMES_ROUTE_LANES)[number];

export type HermesRouteConstraints = {
  maxCostPerMtok?: number;
  maxLatencyMs?: number;
  minContextTokens?: number;
  providerAllowlist?: string[];
};

export type HermesRouteRecommendation = {
  task: HermesRouteTask;
  lane: HermesRouteLane;
  route_id: string;
  provider: string;
  model: string;
  name: string;
  canonical_family: string;
  score: number;
  expected: {
    cost_per_mtok: number | null;
    output_tokens_per_sec: number | null;
    ttft_ms: number | null;
    context_tokens: number | null;
  };
  evidence: {
    quality_score: number;
    cost_score: number;
    latency_score: number;
    evidence_grade: "A" | "A-" | "B+" | "B" | "C";
  };
  reason: string;
};

export type RecommendHermesRouteOptions = {
  lane?: HermesRouteLane;
  constraints?: HermesRouteConstraints;
  limit?: number;
  modelFamilies?: import("./types.js").SnapshotModelFamily[];
};

export type RecommendHermesAuxiliaryOptions = Omit<
  RecommendHermesRouteOptions,
  "limit"
> & {
  limitPerTask?: number;
};

const HERMES_TASK_METRIC_WEIGHTS: Record<HermesRouteTask, Record<string, number>> = {
  vision: {
    agmobench: 0.45,
    intelligenceIndex: 0.25,
    agmobench_reasoning: 0.2,
    agmobench_robustness: 0.1,
  },
  web_extract: {
    agmobench_reasoning: 0.35,
    agmobench: 0.3,
    intelligenceIndex: 0.2,
    agmobench_robustness: 0.15,
  },
  compression: {
    agmobench_reasoning: 0.4,
    agmobench: 0.3,
    intelligenceIndex: 0.2,
    agmobench_robustness: 0.1,
  },
  skills_hub: {
    agmobench_agentic: 0.35,
    agmobench_reasoning: 0.3,
    agmobench: 0.2,
    agmobench_coding: 0.15,
  },
  approval: {
    agmobench_robustness: 0.45,
    agmobench_reasoning: 0.25,
    agmobench: 0.2,
    intelligenceIndex: 0.1,
  },
  mcp: {
    agmobench_agentic: 0.4,
    agmobench_coding: 0.25,
    agmobench_reasoning: 0.2,
    agmobench: 0.15,
  },
  title_gen: {
    agmobench: 0.35,
    agmobench_reasoning: 0.25,
    intelligenceIndex: 0.2,
    agmobench_robustness: 0.2,
  },
  curator: {
    agmobench_reasoning: 0.35,
    agmobench_robustness: 0.25,
    agmobench_agentic: 0.2,
    agmobench: 0.2,
  },
};

const HERMES_LANE_WEIGHTS: Record<
  HermesRouteLane,
  { quality: number; cost: number; latency: number }
> = {
  balanced: { quality: 0.55, cost: 0.3, latency: 0.15 },
  budget: { quality: 0.25, cost: 0.6, latency: 0.15 },
  quality: { quality: 0.92, cost: 0.04, latency: 0.04 },
  fast: { quality: 0.25, cost: 0.15, latency: 0.6 },
};

function metric(model: SnapshotModel, key: string): number | null {
  const value = model.metricValues[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scoreQuality(task: HermesRouteTask, model: SnapshotModel): number {
  const weights = HERMES_TASK_METRIC_WEIGHTS[task];
  let weighted = 0;
  let total = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const value = metric(model, key);
    if (value == null) continue;
    weighted += Math.max(0, Math.min(1, value / 100)) * weight;
    total += weight;
  }

  return total > 0 ? weighted / total : 0;
}

function positiveMetric(model: SnapshotModel, key: string): number | null {
  const value = metric(model, key);
  return value != null && value > 0 ? value : null;
}

function scoreCost(model: SnapshotModel): number {
  const cost = positiveMetric(model, "blendedPricePerM");
  if (cost == null) return 0.35;
  if (cost <= 0.5) return 1;
  if (cost <= 1) return 0.94;
  if (cost <= 3) return 0.84;
  if (cost <= 5) return 0.74;
  if (cost <= 10) return 0.58;
  if (cost <= 20) return 0.42;
  return 0.25;
}

function scoreLatency(model: SnapshotModel): number {
  const tps = positiveMetric(model, "outputTokensPerSec");
  const ttft = positiveMetric(model, "ttftSeconds");
  const tpsScore = tps == null ? 0.45 : Math.max(0.1, Math.min(1, tps / 200));
  const ttftScore = ttft == null ? 0.55 : Math.max(0.1, Math.min(1, 1.5 / Math.max(ttft, 0.05)));
  return tpsScore * 0.65 + ttftScore * 0.35;
}

function evidenceGrade(qualityScore: number): HermesRouteRecommendation["evidence"]["evidence_grade"] {
  if (qualityScore >= 0.93) return "A";
  if (qualityScore >= 0.88) return "A-";
  if (qualityScore >= 0.82) return "B+";
  if (qualityScore >= 0.74) return "B";
  return "C";
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function familyForModel(
  model: SnapshotModel,
  modelFamilies: import("./types.js").SnapshotModelFamily[] = [],
): string {
  const family = modelFamilies.find(
    (candidate) =>
      candidate.primarySlug === model.slug || candidate.slugs.includes(model.slug),
  );
  return family?.routingName ?? model.slug;
}

function passesHermesConstraints(
  model: SnapshotModel,
  constraints: HermesRouteConstraints | undefined,
): boolean {
  if (!constraints) return true;

  if (constraints.providerAllowlist?.length) {
    const allowed = new Set(
      constraints.providerAllowlist.map((provider) => provider.trim().toLowerCase()),
    );
    if (
      !allowed.has(model.providerSlug.toLowerCase()) &&
      !allowed.has(model.providerName.toLowerCase())
    ) {
      return false;
    }
  }

  const cost = positiveMetric(model, "blendedPricePerM");
  if (
    constraints.maxCostPerMtok != null &&
    (cost == null || cost > constraints.maxCostPerMtok)
  ) {
    return false;
  }

  if (
    constraints.minContextTokens != null &&
    (model.contextWindow == null || model.contextWindow < constraints.minContextTokens)
  ) {
    return false;
  }

  const ttft = positiveMetric(model, "ttftSeconds");
  if (
    constraints.maxLatencyMs != null &&
    (ttft == null || ttft * 1000 > constraints.maxLatencyMs)
  ) {
    return false;
  }

  return true;
}

export function recommendHermesRoute(
  task: HermesRouteTask,
  models: SnapshotModel[],
  options: RecommendHermesRouteOptions = {},
): HermesRouteRecommendation[] {
  const lane = options.lane ?? "balanced";
  const weights = HERMES_LANE_WEIGHTS[lane];

  return models
    .filter((model) => passesHermesConstraints(model, options.constraints))
    .map((model) => {
      const qualityScore = scoreQuality(task, model);
      const costScore = scoreCost(model);
      const latencyScore = scoreLatency(model);
      const score =
        qualityScore * weights.quality +
        costScore * weights.cost +
        latencyScore * weights.latency;
      const provider = model.providerSlug || model.providerName.toLowerCase();
      const cost = positiveMetric(model, "blendedPricePerM");
      const tps = positiveMetric(model, "outputTokensPerSec");
      const ttft = positiveMetric(model, "ttftSeconds");

      return {
        task,
        lane,
        route_id: `${provider}:${model.slug}`,
        provider,
        model: model.slug,
        name: model.name,
        canonical_family: familyForModel(model, options.modelFamilies),
        score: roundScore(score),
        expected: {
          cost_per_mtok: cost,
          output_tokens_per_sec: tps,
          ttft_ms: ttft == null ? null : Math.round(ttft * 1000),
          context_tokens: model.contextWindow,
        },
        evidence: {
          quality_score: roundScore(qualityScore),
          cost_score: roundScore(costScore),
          latency_score: roundScore(latencyScore),
          evidence_grade: evidenceGrade(qualityScore),
        },
        reason: `Recommended for Hermes ${task} using the ${lane} lane trade-off across task quality, cost, and latency.`,
      } satisfies HermesRouteRecommendation;
    })
    .filter((candidate) => candidate.evidence.quality_score > 0)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return b.evidence.quality_score - a.evidence.quality_score;
    })
    .slice(0, options.limit ?? 5);
}

export function recommendHermesAuxiliaryModels(
  models: SnapshotModel[],
  options: RecommendHermesAuxiliaryOptions = {},
): Record<HermesRouteTask, HermesRouteRecommendation[]> {
  return Object.fromEntries(
    HERMES_ROUTE_TASKS.map((task) => [
      task,
      recommendHermesRoute(task, models, {
        lane: options.lane,
        constraints: options.constraints,
        modelFamilies: options.modelFamilies,
        limit: options.limitPerTask ?? 3,
      }),
    ]),
  ) as Record<HermesRouteTask, HermesRouteRecommendation[]>;
}
