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
