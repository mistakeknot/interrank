export type SnapshotMetric = {
  key: string;
  label: string;
  higherIsBetter: boolean;
  unit?: string;
  type?: string;
  group?: string;
};

export type SnapshotBenchmark = {
  id: number;
  key: string;
  name: string;
  slug: string;
  source: string;
  category: string;
  description: string | null;
  strengths: string | null;
  caveats: string | null;
  relevantUseCases: string[];
  scoreInterpretation: string | null;
  maxScore: string | null;
  higherIsBetter: boolean;
  contaminationRisk: string | null;
  freshnessType: string | null;
  metadataStatus: string | null;
};

export type SnapshotModel = {
  id: number;
  name: string;
  slug: string;
  providerName: string;
  providerSlug: string;
  description: string | null;
  releaseDate: string | null;
  contextWindow: number | null;
  outputTokens: number | null;
  metricValues: Record<string, number>;
  predictedMetricKeys: string[];
};

export type SnapshotMeta = {
  version: number;
  generatedAt: string;
  sourceRepo: string;
  sourceCommit: string | null;
  modelSyncMaxAt: string | null;
  counts: {
    models: number;
    benchmarks: number;
    metrics: number;
    metricValues: number;
    predictedCells: number;
  };
};

export type PublicDataSnapshot = {
  meta: SnapshotMeta;
  metrics: SnapshotMetric[];
  benchmarks: SnapshotBenchmark[];
  models: SnapshotModel[];
};
