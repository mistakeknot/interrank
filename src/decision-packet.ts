import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type {
  PublicDataSnapshot,
  SnapshotBenchmark,
  SnapshotModel,
} from "./types.js";

export const DECISION_PACKET_CONTRACT_VERSION =
  "agmodb.decision-packet.v1" as const;
export const DECISION_PACKET_POLICY_VERSION =
  "agmodb.recommendation.v1" as const;

const nonNegativeFinite = z.number().finite().nonnegative();

export const decisionConstraintsSchema = z.strictObject({
  providers: z.array(z.string().trim().min(1)).min(1).optional(),
  excludeProviders: z.array(z.string().trim().min(1)).min(1).optional(),
  maxBlendedPricePerMillion: nonNegativeFinite.optional(),
  minOutputTokensPerSecond: nonNegativeFinite.optional(),
  maxTimeToFirstTokenSeconds: nonNegativeFinite.optional(),
  minContextWindow: z.number().int().nonnegative().optional(),
  requireOpenWeight: z.boolean().optional(),
  allowPredicted: z.boolean().optional(),
});

export const decisionPacketRequestSchema = z.strictObject({
  task: z.string().trim().min(2).max(1_000),
  constraints: decisionConstraintsSchema.optional().default({}),
  limit: z.number().int().min(1).max(5).optional().default(3),
});

export const recommendModelToolInputSchema = z.strictObject({
  task: z.string().trim().min(2).max(1_000),
  constraints: decisionConstraintsSchema.optional().default({}),
  limit: z.number().int().min(1).max(5).optional().default(3),
  budget: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Deprecated compatibility shortcut; prefer maxBlendedPricePerMillion."),
  provider: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Deprecated compatibility shortcut; prefer constraints.providers."),
});

const variantSchema = z.strictObject({
  reasoning: z.enum(["reasoning", "non-reasoning", "unspecified"]),
  effort: z.string().nullable(),
  snapshot: z.string().nullable(),
});

const routeSchema = z.strictObject({
  id: z.string().regex(/^agmodb:model:[a-z0-9][a-z0-9-]*$/),
  identityLevel: z.literal("model"),
  modelSlug: z.string().min(1),
  modelName: z.string().min(1),
  provider: z.strictObject({
    name: z.string().min(1),
    slug: z.string().min(1),
  }),
  variant: variantSchema.nullable(),
  harness: z.null(),
  identityCaveat: z.string().min(1),
});

const evidenceSchema = z.strictObject({
  benchmarkKey: z.string().min(1),
  benchmarkName: z.string().min(1),
  category: z.string().min(1),
  value: z.number().finite(),
  normalizedScore: z.number().min(0).max(100),
  higherIsBetter: z.boolean(),
  predicted: z.boolean(),
  relevanceWeight: z.number().positive(),
  source: z.strictObject({
    name: z.string().min(1),
    url: z.string().url().nullable(),
  }),
  contaminationRisk: z.enum(["low", "moderate", "high"]),
  freshnessType: z.enum(["static", "periodic", "continuous"]),
  caveats: z.array(z.string()),
});

const candidateSchema = z.strictObject({
  rank: z.number().int().positive(),
  route: routeSchema,
  score: z.number().min(0).max(100),
  cost: z.strictObject({
    inputUsdPerMillion: nonNegativeFinite.nullable(),
    outputUsdPerMillion: nonNegativeFinite.nullable(),
    blendedUsdPerMillion: nonNegativeFinite.nullable(),
  }),
  latency: z.strictObject({
    outputTokensPerSecond: nonNegativeFinite.nullable(),
    timeToFirstTokenSeconds: nonNegativeFinite.nullable(),
    timeToFirstAnswerSeconds: nonNegativeFinite.nullable(),
  }),
  capacity: z.strictObject({
    contextWindowTokens: z.number().int().nonnegative().nullable(),
    maxOutputTokens: z.number().int().nonnegative().nullable(),
  }),
  evidence: z.array(evidenceSchema),
  uncertainty: z.strictObject({
    confidence: z.number().min(0).max(1),
    level: z.enum(["low", "medium", "high"]),
    coverage: z.strictObject({
      observed: z.number().int().nonnegative(),
      predicted: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    reasons: z.array(z.string()),
  }),
  caveats: z.array(z.string()),
  freshness: z.strictObject({
    catalogGeneratedAt: z.string().datetime(),
    modelSyncedAt: z.string().datetime().nullable(),
  }),
});

export const decisionPacketSchema = z.strictObject({
  schemaVersion: z.literal(DECISION_PACKET_CONTRACT_VERSION),
  policyVersion: z.literal(DECISION_PACKET_POLICY_VERSION),
  packetId: z.string().regex(/^dp_[a-f0-9]{16}$/),
  generatedAt: z.string().datetime(),
  request: z.strictObject({
    task: z.string().min(2),
    constraints: decisionConstraintsSchema,
    limit: z.number().int().min(1).max(5),
  }),
  catalog: z.strictObject({
    digest: z.string().min(1),
    sourceRepo: z.string().min(1),
    sourceCommit: z.string().nullable(),
    generatedAt: z.string().datetime(),
  }),
  decision: z.strictObject({
    recommended: candidateSchema,
    alternatives: z.array(candidateSchema),
    eligibleCandidateCount: z.number().int().positive(),
  }),
  exclusions: z.strictObject({
    total: z.number().int().nonnegative(),
    byConstraint: z.record(z.string(), z.number().int().nonnegative()),
  }),
  nextDiscriminatingEval: z
    .strictObject({
      benchmarkKey: z.string().min(1),
      benchmarkName: z.string().min(1),
      candidateRouteIds: z.array(z.string()).min(2),
      rationale: z.string().min(1),
    })
    .nullable(),
});

export type DecisionPacketRequest = z.input<typeof decisionPacketRequestSchema>;
export type ParsedDecisionPacketRequest = z.output<
  typeof decisionPacketRequestSchema
>;
export type RecommendModelToolInput = z.output<
  typeof recommendModelToolInputSchema
>;
export type DecisionPacket = z.output<typeof decisionPacketSchema>;
type DecisionCandidate = DecisionPacket["decision"]["recommended"];
type DecisionEvidence = DecisionCandidate["evidence"][number];

export const RECOMMEND_MODEL_TOOL_ANNOTATIONS = {
  title: "Recommend model with Decision Packet",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const PREDICTED_DISCOUNT = 0.7;
const MIN_BENCHMARK_COVERAGE = 2;
const IMPUTATION_STRENGTH = 1;
const NON_CAPABILITY_CATEGORIES = new Set(["usage", "efficiency"]);
const NON_CAPABILITY_KEYS = new Set([
  "epoch_training_compute_flop",
  "epoch_parameters",
  "epoch_training_cost_usd",
]);

const TASK_DOMAIN_MAP: Record<string, string[]> = {
  coding: ["coding", "agents"],
  programming: ["coding", "agents"],
  "software engineering": ["coding", "agents"],
  "code review": ["coding", "agents", "fluxbench"],
  bug: ["coding", "agents"],
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

const STOPWORDS = new Set([
  "a", "about", "all", "an", "and", "any", "are", "as", "at", "be",
  "by", "can", "do", "for", "from", "how", "in", "into", "is", "it",
  "its", "low", "of", "on", "or", "our", "per", "the", "their", "this",
  "to", "use", "using", "via", "we", "what", "when", "which", "with",
  "you", "your",
]);

type ScoredBenchmark = SnapshotBenchmark & { relevanceWeight: number };
type BenchmarkRange = { min: number; max: number };
type ScoredCandidate = {
  model: SnapshotModel;
  score: number;
  confidence: number;
  evidence: DecisionEvidence[];
  coverage: DecisionCandidate["uncertainty"]["coverage"];
};

export class DecisionPacketNoEligibleCandidatesError extends Error {
  constructor(
    message: string,
    public readonly exclusions: Record<string, number>,
  ) {
    super(message);
    this.name = "DecisionPacketNoEligibleCandidatesError";
  }
}

export function normalizeRecommendModelToolInput(
  input: RecommendModelToolInput,
): ParsedDecisionPacketRequest {
  const constraints = { ...input.constraints };
  if (input.provider && !constraints.providers) {
    constraints.providers = [input.provider];
  }
  const legacyBudgetMaximum =
    input.budget === "low" ? 1 : input.budget === "medium" ? 10 : undefined;
  if (legacyBudgetMaximum !== undefined) {
    constraints.maxBlendedPricePerMillion = Math.min(
      constraints.maxBlendedPricePerMillion ?? Number.POSITIVE_INFINITY,
      legacyBudgetMaximum,
    );
  }
  return decisionPacketRequestSchema.parse({
    task: input.task,
    constraints,
    limit: input.limit,
  });
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function fallbackCatalogDigest(snapshot: PublicDataSnapshot): string {
  return sha256({
    metrics: [...snapshot.metrics].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
    benchmarks: [...snapshot.benchmarks].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
    models: [...snapshot.models]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((model) => ({
        ...model,
        predictedMetricKeys: [...model.predictedMetricKeys].sort(),
      })),
  });
}

function stableId(value: unknown): string {
  return sha256(value).slice(0, 16);
}

function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
}

function tokenize(text: string): string[] {
  return splitWords(text).filter(
    (token) => token.length >= 2 && !STOPWORDS.has(token),
  );
}

function fieldMatches(tokens: string[], text: string): string[] {
  const words = new Set(splitWords(text));
  return tokens.filter((token) => {
    if (words.has(token)) return true;
    for (const word of words) {
      if (token.length >= 5 && word.startsWith(token)) return true;
      if (word.length >= 5 && token.startsWith(word)) return true;
    }
    return false;
  });
}

function relevantBenchmarks(
  task: string,
  benchmarks: SnapshotBenchmark[],
): ScoredBenchmark[] {
  const tokens = tokenize(task);
  const lowerTask = task.toLowerCase();
  const affinityDomains = new Set<string>();
  for (const [archetype, domains] of Object.entries(TASK_DOMAIN_MAP)) {
    if (lowerTask.includes(archetype)) {
      for (const domain of domains) affinityDomains.add(domain);
    }
  }

  return benchmarks
    .filter(
      (benchmark) =>
        !NON_CAPABILITY_CATEGORIES.has(benchmark.category) &&
        !NON_CAPABILITY_KEYS.has(benchmark.key),
    )
    .map((benchmark) => {
      let relevanceWeight = 0;
      for (const useCase of benchmark.relevantUseCases ?? []) {
        relevanceWeight += fieldMatches(tokens, useCase).length * 3;
      }
      relevanceWeight += fieldMatches(tokens, benchmark.description ?? "").length;
      relevanceWeight +=
        fieldMatches(tokens, benchmark.category).length * 1.5;
      relevanceWeight += fieldMatches(tokens, benchmark.name).length;
      if (affinityDomains.has(benchmark.category)) relevanceWeight += 2;
      return { ...benchmark, relevanceWeight };
    })
    .filter((benchmark) => benchmark.relevanceWeight > 0)
    .sort(
      (left, right) =>
        right.relevanceWeight - left.relevanceWeight ||
        left.key.localeCompare(right.key),
    );
}

function metricValue(model: SnapshotModel, key: string): number | null {
  const value = model.metricValues[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildRanges(
  models: SnapshotModel[],
  benchmarks: ScoredBenchmark[],
): Map<string, BenchmarkRange> {
  const ranges = new Map<string, BenchmarkRange>();
  for (const benchmark of benchmarks) {
    const values = models
      .map((model) => metricValue(model, benchmark.key))
      .filter((value): value is number => value !== null);
    if (values.length > 0) {
      ranges.set(benchmark.key, {
        min: Math.min(...values),
        max: Math.max(...values),
      });
    }
  }
  return ranges;
}

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
      const value = metricValue(model, benchmark.key);
      if (value === null) continue;
      sum += normalizeValue(value, range, benchmark.higherIsBetter);
      count++;
    }
  }
  return count > 0 ? sum / count : 0.5;
}

function providerMatches(model: SnapshotModel, candidates: string[]): boolean {
  const expected = new Set(candidates.map((value) => value.trim().toLowerCase()));
  return (
    expected.has(model.providerName.toLowerCase()) ||
    expected.has(model.providerSlug.toLowerCase())
  );
}

function hardConstraintFailures(
  model: SnapshotModel,
  constraints: ParsedDecisionPacketRequest["constraints"],
): string[] {
  const failures: string[] = [];
  if (constraints.providers && !providerMatches(model, constraints.providers)) {
    failures.push("providers");
  }
  if (
    constraints.excludeProviders &&
    providerMatches(model, constraints.excludeProviders)
  ) {
    failures.push("excludeProviders");
  }
  const price = metricValue(model, "blendedPricePerM");
  if (
    constraints.maxBlendedPricePerMillion !== undefined &&
    (price === null || price > constraints.maxBlendedPricePerMillion)
  ) {
    failures.push("maxBlendedPricePerMillion");
  }
  const speed = metricValue(model, "outputTokensPerSec");
  if (
    constraints.minOutputTokensPerSecond !== undefined &&
    (speed === null || speed < constraints.minOutputTokensPerSecond)
  ) {
    failures.push("minOutputTokensPerSecond");
  }
  const ttft = metricValue(model, "ttftSeconds");
  if (
    constraints.maxTimeToFirstTokenSeconds !== undefined &&
    (ttft === null || ttft > constraints.maxTimeToFirstTokenSeconds)
  ) {
    failures.push("maxTimeToFirstTokenSeconds");
  }
  if (
    constraints.minContextWindow !== undefined &&
    (model.contextWindow === null ||
      model.contextWindow < constraints.minContextWindow)
  ) {
    failures.push("minContextWindow");
  }
  if (constraints.requireOpenWeight === true && model.isOpenWeight !== true) {
    failures.push("requireOpenWeight");
  }
  return failures;
}

function splitCaveats(value: string | null): string[] {
  return (value ?? "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function contaminationRisk(
  value: string | null,
): "low" | "moderate" | "high" {
  return value === "low" || value === "high" ? value : "moderate";
}

function freshnessType(
  value: string | null,
): "static" | "periodic" | "continuous" {
  return value === "static" || value === "continuous" ? value : "periodic";
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function scoreCandidates(
  models: SnapshotModel[],
  benchmarks: ScoredBenchmark[],
  ranges: Map<string, BenchmarkRange>,
  priorMean: number,
  allowPredicted: boolean,
): { scored: ScoredCandidate[]; insufficientCoverage: number } {
  const scored: ScoredCandidate[] = [];
  let insufficientCoverage = 0;
  const minimumCoverage = Math.min(MIN_BENCHMARK_COVERAGE, benchmarks.length);

  for (const model of models) {
    let weightedScore = 0;
    let observedWeight = 0;
    let missingWeight = 0;
    let observed = 0;
    let predicted = 0;
    const evidence: DecisionEvidence[] = [];

    for (const benchmark of benchmarks) {
      const value = metricValue(model, benchmark.key);
      const range = ranges.get(benchmark.key);
      const isPredicted = model.predictedMetricKeys.includes(benchmark.key);
      if (value === null || !range || (!allowPredicted && isPredicted)) {
        missingWeight += benchmark.relevanceWeight;
        continue;
      }

      const discount = isPredicted ? PREDICTED_DISCOUNT : 1;
      const weight = benchmark.relevanceWeight * discount;
      const normalized = normalizeValue(
        value,
        range,
        benchmark.higherIsBetter,
      );
      weightedScore += normalized * weight;
      observedWeight += weight;
      if (isPredicted) predicted++;
      else observed++;
      evidence.push({
        benchmarkKey: benchmark.key,
        benchmarkName: benchmark.name,
        category: benchmark.category,
        value,
        normalizedScore: round(normalized * 100, 2),
        higherIsBetter: benchmark.higherIsBetter,
        predicted: isPredicted,
        relevanceWeight: round(benchmark.relevanceWeight, 2),
        source: {
          name: benchmark.source,
          url: benchmark.sourceUrl ?? null,
        },
        contaminationRisk: contaminationRisk(benchmark.contaminationRisk),
        freshnessType: freshnessType(benchmark.freshnessType),
        caveats: splitCaveats(benchmark.caveats),
      });
    }

    if (observed + predicted < minimumCoverage) {
      insufficientCoverage++;
      continue;
    }

    const priorWeight = missingWeight * IMPUTATION_STRENGTH;
    const normalizedScore =
      (weightedScore + priorWeight * priorMean) /
      (observedWeight + priorWeight);
    const total = benchmarks.length;
    const confidence =
      total > 0 ? (observed + predicted * PREDICTED_DISCOUNT) / total : 0;
    scored.push({
      model,
      score: round(normalizedScore * 100, 2),
      confidence: round(confidence, 2),
      evidence,
      coverage: {
        observed,
        predicted,
        missing: total - observed - predicted,
        total,
      },
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.confidence - left.confidence ||
      left.model.slug.localeCompare(right.model.slug),
  );
  return { scored, insufficientCoverage };
}

function uncertaintyLevel(confidence: number): "low" | "medium" | "high" {
  if (confidence >= 0.8) return "low";
  if (confidence >= 0.5) return "medium";
  return "high";
}

function candidate(
  scored: ScoredCandidate,
  rank: number,
  snapshot: PublicDataSnapshot,
): DecisionCandidate {
  const { model, evidence, coverage, confidence } = scored;
  const caveats = new Set<string>([
    "Benchmark scores identify the model variant where available, but do not select an agent harness, prompt, tool policy, or inference provider configuration.",
  ]);
  if (coverage.predicted > 0) {
    caveats.add(
      `${coverage.predicted} relevant benchmark value${coverage.predicted === 1 ? " is" : "s are"} predicted and discounted by the policy.`,
    );
  }
  if (coverage.missing > 0) {
    caveats.add(
      `${coverage.missing} relevant benchmark${coverage.missing === 1 ? " is" : "s are"} missing and imputed at the catalog population mean.`,
    );
  }
  for (const item of evidence) {
    if (item.contaminationRisk === "high") {
      caveats.add(`${item.benchmarkName} has high contamination risk.`);
    }
  }

  const reasons: string[] = [];
  if (coverage.predicted > 0) reasons.push("Predicted evidence receives 0.7x weight.");
  if (coverage.missing > 0) reasons.push("Missing evidence is shrunk toward the population mean.");
  if (reasons.length === 0) reasons.push("All task-relevant evidence is observed.");

  return {
    rank,
    route: {
      id: `agmodb:model:${model.slug}`,
      identityLevel: "model",
      modelSlug: model.slug,
      modelName: model.name,
      provider: { name: model.providerName, slug: model.providerSlug },
      variant: model.variant ?? null,
      harness: null,
      identityCaveat:
        "This route identifies a model variant only; benchmark harness and deployment configuration remain unresolved.",
    },
    score: scored.score,
    cost: {
      inputUsdPerMillion: metricValue(model, "inputPricePerM"),
      outputUsdPerMillion: metricValue(model, "outputPricePerM"),
      blendedUsdPerMillion: metricValue(model, "blendedPricePerM"),
    },
    latency: {
      outputTokensPerSecond: metricValue(model, "outputTokensPerSec"),
      timeToFirstTokenSeconds: metricValue(model, "ttftSeconds"),
      timeToFirstAnswerSeconds: metricValue(model, "ttfaSeconds"),
    },
    capacity: {
      contextWindowTokens: model.contextWindow,
      maxOutputTokens: model.outputTokens,
    },
    evidence,
    uncertainty: {
      confidence,
      level: uncertaintyLevel(confidence),
      coverage,
      reasons,
    },
    caveats: [...caveats],
    freshness: {
      catalogGeneratedAt: snapshot.meta.generatedAt,
      modelSyncedAt: model.syncedAt ?? snapshot.meta.modelSyncMaxAt,
    },
  };
}

function nextEval(
  candidates: DecisionCandidate[],
  benchmarks: ScoredBenchmark[],
): DecisionPacket["nextDiscriminatingEval"] {
  if (candidates.length < 2) return null;
  const pair = candidates.slice(0, 2);
  let best:
    | { benchmark: ScoredBenchmark; discrimination: number }
    | undefined;

  for (const benchmark of benchmarks) {
    const evidence = pair.map((item) =>
      item.evidence.find((entry) => entry.benchmarkKey === benchmark.key),
    );
    let discrimination = 0;
    if (!evidence[0] || !evidence[1]) discrimination += 100;
    if (evidence[0] && evidence[1]) {
      discrimination += Math.abs(
        evidence[0].normalizedScore - evidence[1].normalizedScore,
      );
      if (evidence[0].predicted !== evidence[1].predicted) discrimination += 25;
    }
    if (
      !best ||
      discrimination > best.discrimination ||
      (discrimination === best.discrimination &&
        benchmark.key.localeCompare(best.benchmark.key) < 0)
    ) {
      best = { benchmark, discrimination };
    }
  }
  if (!best) return null;
  return {
    benchmarkKey: best.benchmark.key,
    benchmarkName: best.benchmark.name,
    candidateRouteIds: pair.map((item) => item.route.id),
    rationale:
      `Run a matched system-level ${best.benchmark.name} evaluation for the top two routes; it currently has the largest evidence gap or provenance mismatch and would most reduce decision uncertainty.`,
  };
}

export function buildDecisionPacket(
  request: DecisionPacketRequest,
  snapshot: PublicDataSnapshot,
): DecisionPacket {
  const parsed = decisionPacketRequestSchema.parse(request);
  const benchmarks = relevantBenchmarks(parsed.task, snapshot.benchmarks);
  if (benchmarks.length === 0) {
    throw new DecisionPacketNoEligibleCandidatesError(
      "No capability benchmarks matched the requested task.",
      { taskEvidence: snapshot.models.length },
    );
  }

  const exclusions: Record<string, number> = {};
  const eligibleModels = snapshot.models.filter((model) => {
    const failures = hardConstraintFailures(model, parsed.constraints);
    for (const failure of failures) {
      exclusions[failure] = (exclusions[failure] ?? 0) + 1;
    }
    return failures.length === 0;
  });
  if (eligibleModels.length === 0) {
    throw new DecisionPacketNoEligibleCandidatesError(
      "Hard constraints excluded every model in the catalog.",
      exclusions,
    );
  }

  const ranges = buildRanges(snapshot.models, benchmarks);
  const priorMean = populationMean(snapshot.models, benchmarks, ranges);
  const { scored, insufficientCoverage } = scoreCandidates(
    eligibleModels,
    benchmarks,
    ranges,
    priorMean,
    parsed.constraints.allowPredicted !== false,
  );
  if (insufficientCoverage > 0) exclusions.evidenceCoverage = insufficientCoverage;
  if (scored.length === 0) {
    throw new DecisionPacketNoEligibleCandidatesError(
      "Eligible models lack enough task-relevant benchmark evidence.",
      exclusions,
    );
  }

  const candidates = scored
    .slice(0, parsed.limit)
    .map((item, index) => candidate(item, index + 1, snapshot));
  const normalizedRequest = {
    task: parsed.task,
    constraints: parsed.constraints,
    limit: parsed.limit,
  };
  const catalogDigest =
    snapshot.meta.catalogDigest ?? fallbackCatalogDigest(snapshot);
  return decisionPacketSchema.parse({
    schemaVersion: DECISION_PACKET_CONTRACT_VERSION,
    policyVersion: DECISION_PACKET_POLICY_VERSION,
    packetId: `dp_${stableId({
      request: normalizedRequest,
      catalogDigest,
      routes: candidates.map((item) => item.route.id),
    })}`,
    generatedAt: snapshot.meta.generatedAt,
    request: normalizedRequest,
    catalog: {
      digest: catalogDigest,
      sourceRepo: snapshot.meta.sourceRepo,
      sourceCommit: snapshot.meta.sourceCommit,
      generatedAt: snapshot.meta.generatedAt,
    },
    decision: {
      recommended: candidates[0],
      alternatives: candidates.slice(1),
      eligibleCandidateCount: scored.length,
    },
    exclusions: {
      total: snapshot.models.length - scored.length,
      byConstraint: exclusions,
    },
    nextDiscriminatingEval: nextEval(candidates, benchmarks),
  });
}

export function buildRecommendModelToolResult(
  request: DecisionPacketRequest,
  snapshot: PublicDataSnapshot,
) {
  const packet = buildDecisionPacket(request, snapshot);
  const summary = {
    packetId: packet.packetId,
    schemaVersion: packet.schemaVersion,
    policyVersion: packet.policyVersion,
    recommended: {
      routeId: packet.decision.recommended.route.id,
      model: packet.decision.recommended.route.modelName,
      score: packet.decision.recommended.score,
      confidence: packet.decision.recommended.uncertainty.confidence,
    },
    alternatives: packet.decision.alternatives.map((item) => ({
      routeId: item.route.id,
      model: item.route.modelName,
      score: item.score,
    })),
    nextDiscriminatingEval: packet.nextDiscriminatingEval,
    catalogDigest: packet.catalog.digest,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: packet,
  };
}
