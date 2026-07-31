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
  sourceUrl?: string | null;
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
  /** Required by snapshot v3; absent v2 values fall back conservatively. */
  isOpenWeight?: boolean;
  /** Required by snapshot v3; v2 falls back to meta.modelSyncMaxAt. */
  syncedAt?: string | null;
  metricValues: Record<string, number>;
  predictedMetricKeys: string[];
  capabilitySummary: string | null;
  variant?: {
    reasoning: "reasoning" | "non-reasoning" | "unspecified";
    effort: string | null;
    snapshot: string | null;
  };
};

export type SnapshotMeta = {
  version: number;
  contractVersion?: "agmodb.decision-packet.v1";
  policyVersion?: "agmodb.recommendation.v1";
  catalogDigest?: string;
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

export type SnapshotModelFamily = {
  routingName: string;
  displayName: string;
  provider: string;
  primarySlug: string;
  slugs: string[];
  aliases: string[];
  costTier: "budget" | "mid" | "premium";
  strengths: string[];
};

export type PublicDataSnapshot = {
  meta: SnapshotMeta;
  metrics: SnapshotMetric[];
  benchmarks: SnapshotBenchmark[];
  models: SnapshotModel[];
  modelFamilies?: SnapshotModelFamily[];
};
