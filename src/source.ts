import type { SnapshotSource } from "./load.js";

export const DEFAULT_PUBLIC_SNAPSHOT_URL =
  "https://agmodb.com/api/v1/snapshot";
export const DEFAULT_SNAPSHOT_REPOSITORY = "mistakeknot/agmodb";
export const DEFAULT_SNAPSHOT_TAG = "data-snapshot-latest";
export const DEFAULT_SNAPSHOT_ASSET = "agmodb-snapshot.json.gz";

type SnapshotEnvironment = Record<string, string | undefined>;

function argValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

export function resolveSnapshotSource(
  argv: string[],
  environment: SnapshotEnvironment,
): SnapshotSource {
  const path =
    argValue(argv, "--snapshot-path") ?? environment.AGMODB_SNAPSHOT_PATH;
  if (path) return { kind: "file", path };

  const url =
    argValue(argv, "--snapshot-url") ?? environment.AGMODB_SNAPSHOT_URL;
  if (url) return { kind: "url", url };

  const explicitRepository =
    argValue(argv, "--snapshot-repo") ??
    environment.AGMODB_SNAPSHOT_REPOSITORY;
  const explicitTag =
    argValue(argv, "--snapshot-tag") ?? environment.AGMODB_SNAPSHOT_TAG;
  const explicitAsset =
    argValue(argv, "--snapshot-asset") ?? environment.AGMODB_SNAPSHOT_ASSET;

  if (!explicitRepository && !explicitTag && !explicitAsset) {
    return { kind: "url", url: DEFAULT_PUBLIC_SNAPSHOT_URL };
  }

  const repository = explicitRepository ?? DEFAULT_SNAPSHOT_REPOSITORY;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid snapshot repository: ${repository}. Expected owner/repo.`,
    );
  }

  return {
    kind: "githubRelease",
    owner,
    repo,
    tag: explicitTag ?? DEFAULT_SNAPSHOT_TAG,
    assetName: explicitAsset ?? DEFAULT_SNAPSHOT_ASSET,
    token:
      environment.AGMODB_GITHUB_TOKEN ??
      environment.GITHUB_TOKEN ??
      environment.GH_TOKEN ??
      null,
  };
}
