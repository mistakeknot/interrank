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
};

function maybeDecompress(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1) {
    return gunzipSync(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

function assertSnapshotShape(data: unknown): asserts data is PublicDataSnapshot {
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
  if (Array.isArray(snapshot.modelFamilies)) {
    for (const family of snapshot.modelFamilies) {
      // Index by routing name (primary lookup)
      familyByName.set(family.routingName.toLowerCase(), family);
      // Index by aliases
      for (const alias of family.aliases) {
        familyByName.set(alias.toLowerCase(), family);
      }
      // Index by member slugs (so a full slug also resolves)
      for (const slug of family.slugs) {
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
