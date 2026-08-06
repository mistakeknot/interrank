import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type {
  PublicDataSnapshot,
  SnapshotModel,
  SnapshotModelFamily,
} from "./types.js";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export type SnapshotSource =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }
  | {
      kind: "githubRelease";
      owner: string;
      repo: string;
      tag: string;
      assetName: string;
      token?: string | null;
    };

export type SnapshotIndexes = {
  modelsBySlug: Map<string, SnapshotModel>;
  metricsByKey: Map<string, { key: string; label: string; higherIsBetter: boolean }>;
  benchmarksByKey: Map<string, { key: string; slug: string; name: string; higherIsBetter: boolean }>;
  benchmarksBySlug: Map<string, { key: string; slug: string; name: string; higherIsBetter: boolean }>;
  /** Resolve routing names, aliases, and slugs to model families (v2+ snapshots only) */
  familyByName: Map<string, SnapshotModelFamily>;
  /** Resolve exact declared member slugs before consulting routing aliases. */
  familyBySlug: Map<string, SnapshotModelFamily>;
  /** Optional exact alias-to-variant bindings supplied by the snapshot. */
  targetedAliasByName: Map<
    string,
    { family: SnapshotModelFamily; targetSlug: string }
  >;
  /** Snapshot provenance returned with routing selections. */
  catalog: {
    digest: string | null;
    generatedAt: string;
    sourceRepo: string;
    sourceCommit: string | null;
    snapshotVersion: number;
  };
};

function maybeDecompress(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1) {
    return gunzipSync(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

export function assertSnapshotShape(
  data: unknown,
): asserts data is PublicDataSnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Snapshot payload is not an object");
  }

  const snapshot = data as Record<string, unknown>;
  if (!snapshot.meta || typeof snapshot.meta !== "object") {
    throw new Error("Snapshot payload is missing meta");
  }
  if (!Array.isArray(snapshot.models)) {
    throw new Error("Snapshot payload is missing models[]");
  }
  if (!Array.isArray(snapshot.metrics)) {
    throw new Error("Snapshot payload is missing metrics[]");
  }
  if (!Array.isArray(snapshot.benchmarks)) {
    throw new Error("Snapshot payload is missing benchmarks[]");
  }

  const meta = snapshot.meta as Record<string, unknown>;
  if (typeof meta.version !== "number") {
    throw new Error("Snapshot meta.version must be a number");
  }
  if (meta.version >= 3) {
    if (meta.contractVersion !== "agmodb.decision-packet.v1") {
      throw new Error("Snapshot v3 has an unsupported contractVersion");
    }
    if (meta.policyVersion !== "agmodb.recommendation.v1") {
      throw new Error("Snapshot v3 has an unsupported policyVersion");
    }
    if (
      typeof meta.catalogDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(meta.catalogDigest)
    ) {
      throw new Error("Snapshot v3 is missing a valid catalogDigest");
    }
    for (const [index, value] of snapshot.models.entries()) {
      if (!value || typeof value !== "object") {
        throw new Error(`Snapshot v3 model ${index} is not an object`);
      }
      const model = value as Record<string, unknown>;
      if (typeof model.isOpenWeight !== "boolean") {
        throw new Error(
          `Snapshot v3 model ${index} is missing isOpenWeight`,
        );
      }
      if (
        model.syncedAt !== null &&
        typeof model.syncedAt !== "string"
      ) {
        throw new Error(`Snapshot v3 model ${index} has invalid syncedAt`);
      }
    }

    if (Array.isArray(snapshot.modelFamilies)) {
      for (const [index, value] of snapshot.modelFamilies.entries()) {
        if (!value || typeof value !== "object") continue;
        const family = value as Record<string, unknown>;
        if (family.aliasTargets === undefined) continue;
        if (
          !family.aliasTargets ||
          typeof family.aliasTargets !== "object" ||
          Array.isArray(family.aliasTargets)
        ) {
          throw new Error(
            `Snapshot v3 family ${index} has invalid aliasTargets`,
          );
        }
        const slugs = new Set(
          Array.isArray(family.slugs)
            ? family.slugs.filter((slug): slug is string => typeof slug === "string")
            : [],
        );
        for (const target of Object.values(
          family.aliasTargets as Record<string, unknown>,
        )) {
          if (typeof target !== "string" || !slugs.has(target)) {
            throw new Error(
              `Snapshot v3 family ${index} alias target is not a declared member`,
            );
          }
        }
      }
    }
  }
}

export async function loadSnapshot(source: SnapshotSource): Promise<PublicDataSnapshot> {
  let text: string;

  if (source.kind === "file") {
    const bytes = await readFile(source.path);
    text = maybeDecompress(bytes);
  } else if (source.kind === "url") {
    const response = await fetch(source.url, {
      headers: {
        "Accept": "application/json, application/octet-stream;q=0.9",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch snapshot from ${source.url}: ${response.status} ${response.statusText}`
      );
    }

    const ab = await response.arrayBuffer();
    text = maybeDecompress(Buffer.from(ab));
  } else {
    const releaseResponse = await fetch(
      `https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/${encodeURIComponent(source.tag)}`,
      {
        headers: {
          "Accept": "application/vnd.github+json",
          ...(source.token ? { "Authorization": `Bearer ${source.token}` } : {}),
        },
      }
    );

    if (!releaseResponse.ok) {
      throw new Error(
        `Failed to resolve release tag ${source.owner}/${source.repo}@${source.tag}: ${releaseResponse.status} ${releaseResponse.statusText}`
      );
    }

    const releaseJson = await releaseResponse.json() as {
      assets?: Array<{ name?: string; url?: string }>;
    };
    const asset = releaseJson.assets?.find(
      (entry) => entry?.name === source.assetName
    );
    if (!asset?.url) {
      throw new Error(
        `Release ${source.owner}/${source.repo}@${source.tag} is missing asset ${source.assetName}`
      );
    }

    const assetResponse = await fetch(asset.url, {
      headers: {
        "Accept": "application/octet-stream",
        ...(source.token ? { "Authorization": `Bearer ${source.token}` } : {}),
      },
      redirect: "follow",
    });

    if (!assetResponse.ok) {
      throw new Error(
        `Failed to download release asset ${source.assetName}: ${assetResponse.status} ${assetResponse.statusText}`
      );
    }

    const assetBytes = await assetResponse.arrayBuffer();
    text = maybeDecompress(Buffer.from(assetBytes));
  }

  const parsed = JSON.parse(text) as unknown;
  assertSnapshotShape(parsed);
  return parsed;
}

export function buildSnapshotIndexes(snapshot: PublicDataSnapshot): SnapshotIndexes {
  const modelsBySlug = new Map<string, SnapshotModel>();
  for (const model of snapshot.models) {
    modelsBySlug.set(model.slug, model);
  }

  const metricsByKey = new Map<string, { key: string; label: string; higherIsBetter: boolean }>();
  for (const metric of snapshot.metrics) {
    metricsByKey.set(metric.key, {
      key: metric.key,
      label: metric.label,
      higherIsBetter: metric.higherIsBetter,
    });
  }

  const benchmarksByKey = new Map<string, { key: string; slug: string; name: string; higherIsBetter: boolean }>();
  const benchmarksBySlug = new Map<string, { key: string; slug: string; name: string; higherIsBetter: boolean }>();
  for (const benchmark of snapshot.benchmarks) {
    const value = {
      key: benchmark.key,
      slug: benchmark.slug,
      name: benchmark.name,
      higherIsBetter: benchmark.higherIsBetter,
    };
    benchmarksByKey.set(benchmark.key, value);
    benchmarksBySlug.set(benchmark.slug, value);
  }

  // Build family index from v2+ snapshots
  const familyByName = new Map<string, SnapshotModelFamily>();
  const familyBySlug = new Map<string, SnapshotModelFamily>();
  const targetedAliasByName = new Map<
    string,
    { family: SnapshotModelFamily; targetSlug: string }
  >();
  if (Array.isArray(snapshot.modelFamilies)) {
    for (const family of snapshot.modelFamilies) {
      // Index by routing name (primary lookup)
      familyByName.set(family.routingName.toLowerCase(), family);
      // Index by aliases
      for (const alias of family.aliases) {
        familyByName.set(alias.toLowerCase(), family);
      }
      for (const [alias, targetSlug] of Object.entries(
        family.aliasTargets ?? {},
      )) {
        targetedAliasByName.set(alias.toLowerCase(), { family, targetSlug });
      }
      // Index by member slugs (so a full slug also resolves)
      for (const slug of family.slugs) {
        if (!familyBySlug.has(slug.toLowerCase())) {
          familyBySlug.set(slug.toLowerCase(), family);
        }
        if (!familyByName.has(slug.toLowerCase())) {
          familyByName.set(slug.toLowerCase(), family);
        }
      }
    }
  }

  return {
    modelsBySlug,
    metricsByKey,
    benchmarksByKey,
    benchmarksBySlug,
    familyByName,
    familyBySlug,
    targetedAliasByName,
    catalog: {
      digest: snapshot.meta.catalogDigest ?? null,
      generatedAt: snapshot.meta.generatedAt,
      sourceRepo: snapshot.meta.sourceRepo,
      sourceCommit: snapshot.meta.sourceCommit,
      snapshotVersion: snapshot.meta.version,
    },
  };
}

export function sortForMetric(
  models: SnapshotModel[],
  metricKey: string,
  higherIsBetter: boolean,
  direction?: "asc" | "desc"
): SnapshotModel[] {
  const effectiveDirection = direction ?? (higherIsBetter ? "desc" : "asc");
  const sign = effectiveDirection === "asc" ? 1 : -1;

  return [...models].sort((a, b) => {
    const av = a.metricValues[metricKey];
    const bv = b.metricValues[metricKey];

    const aMissing = typeof av !== "number" || Number.isNaN(av);
    const bMissing = typeof bv !== "number" || Number.isNaN(bv);
    if (aMissing && bMissing) return a.name.localeCompare(b.name);
    if (aMissing) return 1;
    if (bMissing) return -1;

    const delta = av - bv;
    if (delta === 0) return a.name.localeCompare(b.name);
    return delta * sign;
  });
}
