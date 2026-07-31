import { describe, expect, it } from "vitest";
import type {
  PublicDataSnapshot,
  SnapshotBenchmark,
  SnapshotModel,
} from "./types.js";
import {
  buildDecisionPacket,
  buildRecommendModelToolResult,
  decisionPacketRequestSchema,
  decisionPacketSchema,
  RECOMMEND_MODEL_TOOL_ANNOTATIONS,
  normalizeRecommendModelToolInput,
  recommendModelToolInputSchema,
} from "./decision-packet.js";

function benchmark(
  key: string,
  overrides: Partial<SnapshotBenchmark>,
): SnapshotBenchmark {
  return {
    id: 1,
    key,
    name: key,
    slug: key,
    source: "fixture",
    sourceUrl: `https://example.com/${key}`,
    category: "coding",
    description: "Software engineering benchmark.",
    strengths: "Relevant capability evidence.",
    caveats: "Scores depend on the agent harness.",
    relevantUseCases: ["Software engineering", "Bug fixing"],
    scoreInterpretation: "Higher is better.",
    maxScore: "100",
    higherIsBetter: true,
    contaminationRisk: "low",
    freshnessType: "periodic",
    metadataStatus: "complete",
    ...overrides,
  };
}

function model(
  id: number,
  slug: string,
  overrides: Partial<SnapshotModel>,
): SnapshotModel {
  return {
    id,
    name: slug,
    slug,
    providerName: "Fixture",
    providerSlug: "fixture",
    description: null,
    releaseDate: null,
    contextWindow: 128_000,
    outputTokens: 16_000,
    isOpenWeight: false,
    syncedAt: "2026-07-31T10:00:00.000Z",
    metricValues: {},
    predictedMetricKeys: [],
    capabilitySummary: null,
    ...overrides,
  };
}

const SNAPSHOT: PublicDataSnapshot = {
  meta: {
    version: 3,
    contractVersion: "agmodb.decision-packet.v1",
    policyVersion: "agmodb.recommendation.v1",
    catalogDigest: "fixture-catalog-v1",
    generatedAt: "2026-07-31T12:00:00.000Z",
    sourceRepo: "mistakeknot/agmodb",
    sourceCommit: "fixture-commit",
    modelSyncMaxAt: "2026-07-31T10:00:00.000Z",
    counts: {
      models: 4,
      benchmarks: 3,
      metrics: 5,
      metricValues: 29,
      predictedCells: 1,
    },
  },
  metrics: [
    { key: "blendedPricePerM", label: "Price", higherIsBetter: false },
    { key: "inputPricePerM", label: "Input price", higherIsBetter: false },
    { key: "outputPricePerM", label: "Output price", higherIsBetter: false },
    { key: "outputTokensPerSec", label: "Speed", higherIsBetter: true },
    { key: "ttftSeconds", label: "TTFT", higherIsBetter: false },
  ],
  benchmarks: [
    benchmark("swe_rebench", {
      name: "SWE-rebench",
      category: "coding",
      freshnessType: "continuous",
      description: "Fresh repository-level software engineering and bug fixing tasks.",
      relevantUseCases: ["Autonomous coding agents", "Bug fixing", "Code review"],
    }),
    benchmark("senior_swe_bench", {
      name: "Senior SWE-Bench",
      category: "agents",
      description: "Senior-level software engineering tasks in large repositories.",
      relevantUseCases: ["Software engineering", "Large repositories", "Coding agents"],
    }),
    benchmark("hallucination_rate", {
      name: "Hallucination Rate",
      category: "safety",
      description: "Rate of unsupported or fabricated factual claims.",
      relevantUseCases: ["Low hallucination", "Factual assistants"],
      scoreInterpretation: "Lower rate is better.",
      higherIsBetter: false,
    }),
  ],
  models: [
    model(1, "alpha-pro-reasoning-high", {
      name: "Alpha Pro (Reasoning, High Effort)",
      providerName: "Alpha Labs",
      providerSlug: "alpha",
      contextWindow: 200_000,
      outputTokens: 32_000,
      variant: { reasoning: "reasoning", effort: "High Effort", snapshot: null },
      metricValues: {
        swe_rebench: 90,
        senior_swe_bench: 86,
        hallucination_rate: 8,
        blendedPricePerM: 5.5,
        inputPricePerM: 3,
        outputPricePerM: 8,
        outputTokensPerSec: 75,
        ttftSeconds: 0.8,
      },
    }),
    model(2, "beta-open", {
      name: "Beta Open",
      providerName: "Beta AI",
      providerSlug: "beta",
      isOpenWeight: true,
      metricValues: {
        swe_rebench: 84,
        senior_swe_bench: 82,
        hallucination_rate: 2,
        blendedPricePerM: 2,
        inputPricePerM: 1,
        outputPricePerM: 3,
        outputTokensPerSec: 120,
        ttftSeconds: 0.4,
      },
      predictedMetricKeys: ["swe_rebench"],
    }),
    model(3, "gamma-cheap", {
      name: "Gamma Cheap",
      providerName: "Gamma",
      providerSlug: "gamma",
      isOpenWeight: true,
      contextWindow: 32_000,
      metricValues: {
        swe_rebench: 78,
        blendedPricePerM: 0.5,
        inputPricePerM: 0.25,
        outputPricePerM: 0.75,
        outputTokensPerSec: 180,
      },
    }),
    model(4, "delta-ceiling", {
      name: "Delta Ceiling",
      providerName: "Delta",
      providerSlug: "delta",
      contextWindow: 256_000,
      metricValues: {
        swe_rebench: 98,
        senior_swe_bench: 96,
        hallucination_rate: 1,
        blendedPricePerM: 18,
        inputPricePerM: 10,
        outputPricePerM: 26,
        outputTokensPerSec: 90,
        ttftSeconds: 1.1,
      },
    }),
  ],
  modelFamilies: [],
};

const REQUEST = {
  task: "Autonomous code review and bug fixing in large TypeScript repositories with low hallucination",
  constraints: {
    maxBlendedPricePerMillion: 6,
    minOutputTokensPerSecond: 60,
    minContextWindow: 100_000,
    allowPredicted: true,
  },
  limit: 3,
};

describe("InterRank Decision Packet parity", () => {
  it("returns the canonical contract, policy, route, constraints, and evidence semantics", () => {
    const packet = buildDecisionPacket(REQUEST, SNAPSHOT);
    expect(packet.schemaVersion).toBe("agmodb.decision-packet.v1");
    expect(packet.policyVersion).toBe("agmodb.recommendation.v1");
    expect(packet.catalog.digest).toBe("fixture-catalog-v1");
    expect(packet.decision.recommended.route.modelSlug).toBe(
      "alpha-pro-reasoning-high",
    );
    expect(packet.decision.alternatives.map((entry) => entry.route.modelSlug)).toEqual([
      "beta-open",
    ]);
    expect(packet.exclusions.byConstraint.maxBlendedPricePerMillion).toBe(1);
    expect(packet.exclusions.byConstraint.minContextWindow).toBe(1);
    expect(packet.decision.alternatives[0].evidence.find((entry) => entry.benchmarkKey === "swe_rebench")?.predicted).toBe(true);
    expect(packet.decision.recommended.route.harness).toBeNull();
    expect(packet.nextDiscriminatingEval?.candidateRouteIds).toHaveLength(2);
    expect(decisionPacketSchema.parse(packet)).toEqual(packet);
  });

  it("accepts v2 snapshots with explicit conservative fallbacks", () => {
    const v2 = structuredClone(SNAPSHOT);
    v2.meta = {
      version: 2,
      generatedAt: SNAPSHOT.meta.generatedAt,
      sourceRepo: SNAPSHOT.meta.sourceRepo,
      sourceCommit: SNAPSHOT.meta.sourceCommit,
      modelSyncMaxAt: SNAPSHOT.meta.modelSyncMaxAt,
      counts: SNAPSHOT.meta.counts,
    };
    for (const candidate of v2.models) {
      delete candidate.isOpenWeight;
      delete candidate.syncedAt;
      delete candidate.variant;
    }
    const packet = buildDecisionPacket(REQUEST, v2);
    expect(packet.catalog.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.decision.recommended.route.variant).toBeNull();
    expect(packet.decision.recommended.freshness.modelSyncedAt).toBe(
      SNAPSHOT.meta.modelSyncMaxAt,
    );
  });

  it("returns validated structuredContent plus an equivalent concise text rendering", () => {
    const result = buildRecommendModelToolResult(REQUEST, SNAPSHOT);
    expect(decisionPacketSchema.parse(result.structuredContent)).toEqual(
      result.structuredContent,
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      packetId: result.structuredContent.packetId,
      recommended: {
        routeId: result.structuredContent.decision.recommended.route.id,
      },
      catalogDigest: result.structuredContent.catalog.digest,
    });
  });

  it("declares read-only, non-destructive, idempotent tool behavior", () => {
    expect(RECOMMEND_MODEL_TOOL_ANNOTATIONS).toEqual({
      title: "Recommend model with Decision Packet",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("strictly rejects unknown numeric constraints", () => {
    expect(() =>
      decisionPacketRequestSchema.parse({
        task: "coding",
        constraints: { unknownLimit: 1 },
      }),
    ).toThrow();
  });

  it("translates legacy provider and budget shortcuts into hard constraints", () => {
    const legacy = recommendModelToolInputSchema.parse({
      task: "coding agent",
      provider: "Alpha Labs",
      budget: "medium",
    });
    expect(normalizeRecommendModelToolInput(legacy)).toMatchObject({
      constraints: {
        providers: ["Alpha Labs"],
        maxBlendedPricePerMillion: 10,
      },
    });
  });
});
