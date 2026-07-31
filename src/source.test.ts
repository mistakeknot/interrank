import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLIC_SNAPSHOT_URL,
  resolveSnapshotSource,
} from "./source.js";

describe("InterRank snapshot source resolution", () => {
  it("uses AgMoDB's public snapshot endpoint without requiring GitHub auth", () => {
    expect(resolveSnapshotSource([], {})).toEqual({
      kind: "url",
      url: DEFAULT_PUBLIC_SNAPSHOT_URL,
    });
  });

  it("preserves explicit local file and URL overrides", () => {
    expect(
      resolveSnapshotSource(["--snapshot-path", "/tmp/snapshot.json.gz"], {}),
    ).toEqual({ kind: "file", path: "/tmp/snapshot.json.gz" });
    expect(
      resolveSnapshotSource([], {
        AGMODB_SNAPSHOT_URL: "https://example.com/snapshot.json",
      }),
    ).toEqual({
      kind: "url",
      url: "https://example.com/snapshot.json",
    });
  });

  it("retains authenticated GitHub release resolution as an explicit override", () => {
    expect(
      resolveSnapshotSource(
        ["--snapshot-repo", "owner/catalog", "--snapshot-tag", "rolling"],
        { GITHUB_TOKEN: "redacted-test-token" },
      ),
    ).toEqual({
      kind: "githubRelease",
      owner: "owner",
      repo: "catalog",
      tag: "rolling",
      assetName: "agmodb-snapshot.json.gz",
      token: "redacted-test-token",
    });
  });
});
