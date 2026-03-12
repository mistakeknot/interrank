import { describe, expect, it } from "vitest";
import { scoreBenchmarks, TASK_DOMAIN_MAP } from "./recommend.js";
import type { SnapshotBenchmark } from "./types.js";

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
