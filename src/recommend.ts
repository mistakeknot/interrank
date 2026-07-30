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
  coding: ["coding", "agents"],
  programming: ["coding", "agents"],
  "software engineering": ["coding", "agents"],
  "code review": ["coding", "agents", "fluxbench"],
  chatbot: ["quality", "safety"],
  "customer support": ["quality", "safety"],
  research: ["reasoning", "knowledge"],
  math: ["math", "reasoning"],
  "data science": ["coding", "math", "reasoning"],
  writing: ["quality"],
  summarization: ["quality", "long-context"],
  agent: ["agents", "coding", "fluxbench"],
  automation: ["agents", "coding", "fluxbench"],
  factual: ["safety", "knowledge"],
  hallucination: ["safety"],
};

const WEIGHT_USE_CASE = 3;
const WEIGHT_DESCRIPTION = 1;
const WEIGHT_CATEGORY = 1.5;
const WEIGHT_NAME = 1;
const DOMAIN_BOOST = 2;

/**
 * Function words that carry no topical signal.
 *
 * Without this filter, substring matching on tokens like "to" or "use" hits
 * almost every benchmark description: one consultant-style query matched 155 of
 * 170 benchmarks, which made both the relevance weights and the coverage-based
 * confidence meaningless.
 */
const STOPWORDS = new Set([
  "a",
  "about",
  "across",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "both",
  "but",
  "by",
  "can",
  "do",
  "does",
  "during",
  "each",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "make",
  "makes",
  "made",
  "me",
  "more",
  "most",
  "my",
  "no",
  "not",
  "now",
  "of",
  "on",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "per",
  "same",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "under",
  "up",
  "us",
  "use",
  "used",
  "uses",
  "using",
  "very",
  "via",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

/** Tokens at least this long may match a longer word by prefix ("problem" → "problems"). */
const PREFIX_MATCH_MIN_LENGTH = 5;

function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 0);
}

/**
 * Split a query into content tokens.
 *
 * Punctuation is stripped before filtering, so "agent:" and "problems," become
 * "agent" and "problems" instead of failing every comparison.
 */
function tokenize(text: string): string[] {
  return splitWords(text).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Return the tokens that appear in `text` as whole words, allowing a longer word
 * to satisfy a shorter token by prefix so simple inflections still match.
 */
function fieldMatches(tokens: string[], text: string): string[] {
  const words = new Set(splitWords(text));
  return tokens.filter((token) => {
    if (words.has(token)) return true;
    for (const word of words) {
      // Either side may be the longer form ("problems"/"problem"), so check both
      // directions. Requiring the shorter side to be substantial keeps short
      // tokens from prefix-matching unrelated words.
      if (token.length >= PREFIX_MATCH_MIN_LENGTH && word.startsWith(token))
        return true;
      if (word.length >= PREFIX_MATCH_MIN_LENGTH && token.startsWith(word))
        return true;
    }
    return false;
  });
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
    if (
      affinityDomains.length > 0 &&
      affinityDomains.includes(benchmark.category)
    ) {
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
 * Benchmark categories that measure something other than capability.
 *
 * `usage` is popularity (HuggingFace downloads, OpenRouter token volume) and
 * `efficiency` is cost-per-task, which the `budget` option already handles.
 * Scoring either lets a widely-downloaded or expensive model outrank a more
 * capable one.
 */
export const NON_CAPABILITY_CATEGORIES = new Set(["usage", "efficiency"]);

/**
 * Metrics describing how a model was built rather than how well it performs.
 * They sit in the `aggregate` category next to genuine capability composites
 * (arena ELO, intelligence indices), so they are excluded by key, not category.
 */
export const NON_CAPABILITY_KEYS = new Set([
  "epoch_training_compute_flop",
  "epoch_parameters",
  "epoch_training_cost_usd",
]);

/**
 * How strongly an unmeasured benchmark counts as evidence of average performance.
 *
 * Every relevant benchmark a model was never scored on is imputed at the
 * population mean, carrying that benchmark's own relevance weight. A model
 * measured on three of sixty benchmarks is therefore mostly prior and sits near
 * average no matter how well it did on those three; only broad evidence moves a
 * model far from the mean. Set to 0 to disable imputation entirely.
 */
const IMPUTATION_STRENGTH = 1;

type BenchmarkRange = { min: number; max: number };

function isCapabilityBenchmark(benchmark: SnapshotBenchmark): boolean {
  return (
    !NON_CAPABILITY_CATEGORIES.has(benchmark.category) &&
    !NON_CAPABILITY_KEYS.has(benchmark.key)
  );
}

/**
 * Observed value range per benchmark across the whole model population.
 *
 * Ranges are computed before provider and budget filtering so that narrowing the
 * candidate set cannot move the scale a model is measured against.
 */
function buildRanges(
  models: SnapshotModel[],
  benchmarks: SnapshotBenchmark[],
): Map<string, BenchmarkRange> {
  const ranges = new Map<string, BenchmarkRange>();
  for (const benchmark of benchmarks) {
    let min = Infinity;
    let max = -Infinity;
    for (const model of models) {
      const value = model.metricValues[benchmark.key];
      if (typeof value !== "number" || Number.isNaN(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (min !== Infinity) ranges.set(benchmark.key, { min, max });
  }
  return ranges;
}

/**
 * Map a raw metric value onto 0..1 within its own observed range, orienting it so
 * that 1 is always better.
 *
 * Raw values are not comparable across benchmarks — percentages run 0-100, arena
 * ELO runs past 4900, training compute past 5e26 — so a weighted mean of raw
 * values is dominated by whichever benchmark happens to use the largest unit.
 * Degenerate ranges collapse to a neutral 0.5 rather than dividing by zero.
 */
function normalizeValue(
  value: number,
  range: BenchmarkRange,
  higherIsBetter: boolean,
): number {
  const span = range.max - range.min;
  if (span <= 0) return 0.5;
  const unit = (value - range.min) / span;
  return higherIsBetter ? unit : 1 - unit;
}

/**
 * Mean normalized score across every observed model/benchmark pair.
 *
 * This is the value a model with no evidence is assumed to have. It is measured
 * rather than assumed to be 0.5, because normalized benchmark distributions are
 * skewed low — most models sit well below the frontier that defines the maximum.
 */
function populationMean(
  models: SnapshotModel[],
  benchmarks: ScoredBenchmark[],
  ranges: Map<string, BenchmarkRange>,
): number {
  let sum = 0;
  let count = 0;
  for (const benchmark of benchmarks) {
    const range = ranges.get(benchmark.key);
    if (!range) continue;
    for (const model of models) {
      const value = model.metricValues[benchmark.key];
      if (typeof value !== "number" || Number.isNaN(value)) continue;
      sum += normalizeValue(value, range, benchmark.higherIsBetter);
      count++;
    }
  }
  return count > 0 ? sum / count : 0.5;
}

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
  const relevantBenchmarks = scoreBenchmarks(
    task,
    benchmarks,
    benchmarks.length,
  ).filter(isCapabilityBenchmark);
  if (relevantBenchmarks.length === 0) return [];

  // Scale reference and prior are drawn from the full population, not the
  // filtered candidate set, so filters cannot shift what "average" means.
  const ranges = buildRanges(models, relevantBenchmarks);
  const priorMean = populationMean(models, relevantBenchmarks, ranges);

  const thresholds = options.budgetThresholds ?? DEFAULT_BUDGET_THRESHOLDS;
  const costMetric = options.costMetric ?? "blendedPricePerM";
  const limit = options.limit ?? 50;

  // Filter models by provider
  let candidateModels = models;
  if (options.provider) {
    const p = options.provider.trim().toLowerCase();
    candidateModels = candidateModels.filter(
      (m) =>
        m.providerName.toLowerCase() === p ||
        m.providerSlug.toLowerCase() === p,
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
    let missingWeight = 0;
    let coveredCount = 0;
    const reasons: string[] = [];

    for (const benchmark of relevantBenchmarks) {
      const value = model.metricValues[benchmark.key];
      const range = ranges.get(benchmark.key);
      if (typeof value !== "number" || Number.isNaN(value) || !range) {
        missingWeight += benchmark.score;
        continue;
      }

      coveredCount++;
      const isPredicted = model.predictedMetricKeys.includes(benchmark.key);
      const discount = isPredicted ? PREDICTED_DISCOUNT : 1.0;
      const weight = benchmark.score * discount;

      totalWeightedScore +=
        normalizeValue(value, range, benchmark.higherIsBetter) * weight;
      totalWeight += weight;

      if (isPredicted) {
        reasons.push(`${benchmark.name} (predicted)`);
      } else {
        reasons.push(benchmark.name);
      }
    }

    if (coveredCount < MIN_BENCHMARK_COVERAGE) continue;

    const confidence = coveredCount / relevantBenchmarks.length;
    // Impute every unmeasured relevant benchmark at the population mean, carrying
    // its own relevance weight. Thin coverage therefore stays near average no
    // matter how strong the few measured results are.
    const priorWeight = missingWeight * IMPUTATION_STRENGTH;
    const shrunkScore =
      (totalWeightedScore + priorWeight * priorMean) /
      (totalWeight + priorWeight);

    scored.push({
      slug: model.slug,
      name: model.name,
      provider: model.providerName,
      weightedScore: Math.round(shrunkScore * 10000) / 100,
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
