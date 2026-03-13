import { describe, expect, it } from "vitest";
import {
  buildSnapshotIndexes,
  sortForMetric,
} from "./load.js";
import type { PublicDataSnapshot } from "./types.js";

const SNAPSHOT: PublicDataSnapshot = {
  meta: {
    version: 1,
    generatedAt: "2026-02-27T00:00:00.000Z",
    sourceRepo: "mistakeknot/agmodb",
    sourceCommit: "abc123",
    modelSyncMaxAt: null,
    counts: {
      models: 2,
      benchmarks: 1,
      metrics: 2,
      metricValues: 4,
      predictedCells: 1,
    },
  },
  metrics: [
    { key: "agmobench", label: "AgMoBench", higherIsBetter: true },
    { key: "blendedPricePerM", label: "Price", higherIsBetter: false },
  ],
  benchmarks: [
    {
      id: 1,
      key: "agmobench",
      name: "AgMoBench",
      slug: "agmobench",
      source: "agmodb",
      category: "aggregate",
      description: "desc",
      strengths: "str",
      caveats: "cav",
      relevantUseCases: ["use"],
      scoreInterpretation: "interp",
      maxScore: "100",
      higherIsBetter: true,
      contaminationRisk: "low",
      freshnessType: "periodic",
      metadataStatus: "complete",
    },
  ],
  models: [
    {
      id: 1,
      name: "Model A",
      slug: "model-a",
      providerName: "OpenAI",
      providerSlug: "openai",
      description: null,
      releaseDate: null,
      contextWindow: null,
      outputTokens: null,
      metricValues: {
        agmobench: 90,
        blendedPricePerM: 20,
      },
      predictedMetricKeys: [],
      capabilitySummary: null,
    },
    {
      id: 2,
      name: "Model B",
      slug: "model-b",
      providerName: "OpenAI",
      providerSlug: "openai",
      description: null,
      releaseDate: null,
      contextWindow: null,
      outputTokens: null,
      metricValues: {
        agmobench: 80,
        blendedPricePerM: 10,
      },
      predictedMetricKeys: ["agmobench"],
      capabilitySummary: null,
    },
  ],
};

describe("snapshot load helpers", () => {
  it("builds slug and metric indexes", () => {
    const indexes = buildSnapshotIndexes(SNAPSHOT);

    expect(indexes.modelsBySlug.get("model-a")?.name).toBe("Model A");
    expect(indexes.metricsByKey.get("agmobench")?.label).toBe("AgMoBench");
    expect(indexes.benchmarksBySlug.get("agmobench")?.key).toBe("agmobench");
  });

  it("sorts desc for higher-is-better metrics", () => {
    const sorted = sortForMetric(SNAPSHOT.models, "agmobench", true);
    expect(sorted.map((m) => m.slug)).toEqual(["model-a", "model-b"]);
  });

  it("sorts asc for lower-is-better metrics", () => {
    const sorted = sortForMetric(SNAPSHOT.models, "blendedPricePerM", false);
    expect(sorted.map((m) => m.slug)).toEqual(["model-b", "model-a"]);
  });
});

describe("cost efficiency", () => {
  it("computes efficiency ratio correctly", () => {
    // Model A: agmobench=90, blendedPricePerM=20 → efficiency=90/20=4.5
    // Model B: agmobench=80, blendedPricePerM=10 → efficiency=80/10=8.0
    // Model B is more cost-efficient
    const modelA = SNAPSHOT.models.find((m) => m.slug === "model-a")!;
    const modelB = SNAPSHOT.models.find((m) => m.slug === "model-b")!;
    const effA = modelA.metricValues["agmobench"] / modelA.metricValues["blendedPricePerM"];
    const effB = modelB.metricValues["agmobench"] / modelB.metricValues["blendedPricePerM"];
    expect(effB).toBeGreaterThan(effA);
  });
});
