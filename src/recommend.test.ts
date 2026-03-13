import { describe, expect, it } from "vitest";
import { scoreBenchmarks, recommendModels, TASK_DOMAIN_MAP } from "./recommend.js";
import type { SnapshotBenchmark, SnapshotModel } from "./types.js";

function makeBenchmark(overrides: Partial<SnapshotBenchmark> & { key: string }): SnapshotBenchmark {
  return {
    id: 1,
    name: overrides.key,
    slug: overrides.key,
    source: "test",
    category: "coding",
    description: null,
    strengths: null,
    caveats: null,
    relevantUseCases: [],
    scoreInterpretation: null,
    maxScore: null,
    higherIsBetter: true,
    contaminationRisk: null,
    freshnessType: null,
    metadataStatus: null,
    ...overrides,
  };
}

const benchmarks: SnapshotBenchmark[] = [
  makeBenchmark({
    key: "livecodebench",
    name: "LiveCodeBench",
    category: "coding",
    description: "Code generation benchmark with fresh problems",
    relevantUseCases: ["Code generation", "Algorithm design", "Programming assistance"],
  }),
  makeBenchmark({
    key: "swebench_verified",
    name: "SWE-bench Verified",
    category: "agents",
    description: "Autonomous software engineering benchmark",
    relevantUseCases: ["AI coding agents", "Bug fixing", "Software engineering"],
  }),
  makeBenchmark({
    key: "truthfulqa_overall",
    name: "TruthfulQA",
    category: "safety",
    description: "Measures tendency to generate truthful answers",
    relevantUseCases: ["Customer support AI", "Factual Q&A", "Content moderation"],
  }),
];

describe("scoreBenchmarks", () => {
  it("matches query tokens against relevantUseCases", () => {
    const results = scoreBenchmarks("coding agent", benchmarks);
    expect(results.length).toBeGreaterThan(0);
    // "coding" matches swebench useCases ("AI coding agents") and livecodebench useCases ("Code generation")
    // "agent" matches swebench useCases ("AI coding agents")
    expect(results[0].key).toBe("swebench_verified");
  });

  it("returns matchReason for each result", () => {
    const results = scoreBenchmarks("coding", benchmarks);
    const livecodebench = results.find((r) => r.key === "livecodebench");
    expect(livecodebench).toBeDefined();
    expect(livecodebench!.matchReason).toBeTruthy();
    expect(livecodebench!.matchReason).toContain("coding");
  });

  it("excludes benchmarks with zero score", () => {
    const results = scoreBenchmarks("quantum physics", benchmarks);
    expect(results.length).toBe(0);
  });

  it("boosts by domain affinity when task matches TASK_DOMAIN_MAP", () => {
    const results = scoreBenchmarks("code review agent", benchmarks);
    // "code review" maps to coding+agents domains, should boost swebench and livecodebench
    const codingResults = results.filter((r) => r.category === "coding" || r.category === "agents");
    expect(codingResults.length).toBeGreaterThan(0);
  });

  it("respects limit parameter", () => {
    const results = scoreBenchmarks("coding software", benchmarks, 1);
    expect(results.length).toBe(1);
  });

  it("returns results sorted by score descending", () => {
    const results = scoreBenchmarks("coding", benchmarks);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns empty for empty query", () => {
    const results = scoreBenchmarks("", benchmarks);
    expect(results.length).toBe(0);
  });
});

function makeModel(overrides: Partial<SnapshotModel> & { slug: string }): SnapshotModel {
  const { slug, ...rest } = overrides;
  return {
    id: 1,
    name: slug,
    slug,
    providerName: "TestProvider",
    providerSlug: "testprovider",
    description: null,
    releaseDate: null,
    contextWindow: null,
    outputTokens: null,
    metricValues: {},
    predictedMetricKeys: [],
    capabilitySummary: null,
    ...rest,
  };
}

const testModels: SnapshotModel[] = [
  makeModel({
    slug: "alpha",
    name: "Alpha",
    providerName: "ProvA",
    metricValues: { livecodebench: 85, swebench_verified: 90, blendedPricePerM: 15 },
    predictedMetricKeys: [],
  }),
  makeModel({
    slug: "beta",
    name: "Beta",
    providerName: "ProvB",
    metricValues: { livecodebench: 70, swebench_verified: 95, blendedPricePerM: 5 },
    predictedMetricKeys: ["livecodebench"],
  }),
  makeModel({
    slug: "gamma",
    name: "Gamma",
    providerName: "ProvC",
    metricValues: { truthfulqa_overall: 80, blendedPricePerM: 2 },
    predictedMetricKeys: [],
  }),
];

describe("recommendModels", () => {
  it("ranks models by weighted benchmark scores for a coding task", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, {});
    expect(results.length).toBeGreaterThan(0);
    // Alpha and Beta have coding/agent benchmark data; Gamma only has safety data
    expect(results.every((r) => r.slug !== "gamma")).toBe(true);
  });

  it("includes confidence and matchReason in results", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, {});
    expect(results[0].confidence).toBeGreaterThan(0);
    expect(results[0].confidence).toBeLessThanOrEqual(1);
    expect(results[0].matchReason).toBeTruthy();
  });

  it("applies predicted score discount (0.7x weight)", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, {});
    const beta = results.find((r) => r.slug === "beta");
    expect(beta).toBeDefined();
    // Beta's livecodebench is predicted — verify its matchReason indicates predicted data
    expect(beta!.matchReason).toContain("predicted");
    // Beta's weighted score should differ from a naive average of its raw benchmark values
    // (raw avg = (70+95)/2 = 82.5) due to benchmark-weight × predicted-discount interaction
    expect(beta!.weightedScore).not.toBe(82.5);
  });

  it("filters by budget when costMetric is available", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, {
      budget: "low",
      costMetric: "blendedPricePerM",
      budgetThresholds: { low: 5, medium: 15, high: Infinity },
    });
    // Alpha has blendedPricePerM=15, above "low" threshold of 5
    expect(results.find((r) => r.slug === "alpha")).toBeUndefined();
  });

  it("excludes models with fewer than 2 relevant benchmark scores", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, {});
    // Gamma only has truthfulqa_overall — no coding benchmarks — excluded
    expect(results.find((r) => r.slug === "gamma")).toBeUndefined();
  });

  it("returns empty for task with no matching benchmarks", () => {
    const results = recommendModels("quantum teleportation", benchmarks, testModels, {});
    expect(results.length).toBe(0);
  });

  it("respects limit parameter", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("filters by provider", () => {
    const results = recommendModels("coding agent", benchmarks, testModels, { provider: "ProvA" });
    expect(results.every((r) => r.provider === "ProvA")).toBe(true);
  });
});

describe("TASK_DOMAIN_MAP", () => {
  it("contains at least 8 task archetype entries", () => {
    expect(Object.keys(TASK_DOMAIN_MAP).length).toBeGreaterThanOrEqual(8);
  });

  it("maps coding tasks to coding domain", () => {
    const codingEntry = Object.entries(TASK_DOMAIN_MAP).find(([key]) =>
      key.includes("coding") || key.includes("programming")
    );
    expect(codingEntry).toBeDefined();
    expect(codingEntry![1]).toContain("coding");
  });
});
