import { describe, expect, it } from "vitest";
import { buildSnapshotIndexes } from "./load.js";
import {
  classifySlugVariant,
  effectiveVariant,
  parseVariantQualifier,
  resolveRoutingName,
  stripEffortQualifier,
} from "./resolve.js";
import type { PublicDataSnapshot, SnapshotModelFamily } from "./types.js";

// Realistic family fixtures — a faithful subset of agmodb's MODEL_FAMILIES
// (src/lib/snapshot/model-families.ts) carrying the genuine variant slugs.
const FAMILIES: SnapshotModelFamily[] = [
  {
    routingName: "opus",
    displayName: "Claude Opus (latest)",
    provider: "anthropic",
    primarySlug: "claude-opus-4-6",
    slugs: [
      "claude-opus-4-6",
      "claude-opus-4-6-adaptive",
      "claude-opus-4-7",
      "claude-opus-4-7-non-reasoning",
      "claude-opus-4-5",
      "claude-opus-4-5-thinking",
    ],
    aliases: ["claude-opus", "claude-opus-4-7", "claude-opus-4.7"],
    costTier: "premium",
    strengths: ["reasoning", "coding", "agentic"],
  },
  {
    routingName: "haiku",
    displayName: "Claude Haiku (latest)",
    provider: "anthropic",
    primarySlug: "claude-4-5-haiku",
    slugs: [
      "claude-4-5-haiku",
      "claude-4-5-haiku-reasoning",
      "claude-3-5-haiku",
    ],
    aliases: ["claude-haiku"],
    costTier: "budget",
    strengths: ["coding"],
  },
  {
    routingName: "gpt-5",
    displayName: "GPT-5",
    provider: "openai",
    primarySlug: "gpt-5",
    slugs: [
      "gpt-5",
      "gpt-5-low",
      "gpt-5-medium",
      "gpt-5-minimal",
      "gpt-5-codex",
    ],
    aliases: ["gpt-5-pro"],
    costTier: "premium",
    strengths: ["reasoning", "coding"],
  },
  {
    routingName: "gpt-5.2",
    displayName: "GPT-5.2",
    provider: "openai",
    primarySlug: "gpt-5-2",
    slugs: [
      "gpt-5-2",
      "gpt-5-2-medium",
      "gpt-5-2-non-reasoning",
      "gpt-5-2-codex",
    ],
    aliases: ["gpt-5.2-pro"],
    costTier: "premium",
    strengths: ["reasoning", "coding", "math"],
  },
  {
    routingName: "grok-4",
    displayName: "Grok 4",
    provider: "xai",
    primarySlug: "grok-4",
    slugs: [
      "grok-4",
      "grok-4-fast",
      "grok-4-fast-reasoning",
      "grok-4-20",
      "grok-4-20-non-reasoning",
    ],
    aliases: ["grok-4.1"],
    costTier: "premium",
    strengths: ["reasoning", "coding"],
  },
  {
    routingName: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    provider: "deepseek",
    primarySlug: "deepseek-v3-2",
    slugs: [
      "deepseek-v3-2",
      "deepseek-v3-2-reasoning",
      "deepseek-v3-2-speciale",
    ],
    aliases: ["deepseek-v3"],
    costTier: "budget",
    strengths: ["coding", "math", "reasoning"],
  },
  {
    routingName: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    provider: "google",
    primarySlug: "gemini-3-flash",
    slugs: ["gemini-3-flash", "gemini-3-flash-reasoning"],
    aliases: ["gemini-flash"],
    costTier: "mid",
    strengths: ["coding", "reasoning"],
  },
];

function makeIndexes() {
  const snapshot: PublicDataSnapshot = {
    meta: {
      version: 2,
      generatedAt: "2026-05-28T00:00:00.000Z",
      sourceRepo: "mistakeknot/agmodb",
      sourceCommit: "test",
      modelSyncMaxAt: null,
      counts: {
        models: 0,
        benchmarks: 0,
        metrics: 0,
        metricValues: 0,
        predictedCells: 0,
      },
    },
    metrics: [],
    benchmarks: [],
    models: [],
    modelFamilies: FAMILIES,
  };
  return buildSnapshotIndexes(snapshot);
}

describe("classifySlugVariant", () => {
  it("classifies non-reasoning before reasoning (substring trap)", () => {
    expect(classifySlugVariant("claude-opus-4-7-non-reasoning")).toBe(
      "non-reasoning",
    );
    expect(classifySlugVariant("gpt-5-2-non-reasoning")).toBe("non-reasoning");
  });

  it("treats -thinking and -reasoning as reasoning", () => {
    expect(classifySlugVariant("claude-opus-4-5-thinking")).toBe("reasoning");
    expect(classifySlugVariant("deepseek-v3-2-reasoning")).toBe("reasoning");
  });

  it("classifies unmarked slugs as base", () => {
    expect(classifySlugVariant("claude-opus-4-6")).toBe("base");
    expect(classifySlugVariant("gpt-5")).toBe("base");
  });
});

describe("effectiveVariant (sibling-aware)", () => {
  // Regression for Failure 1: Anthropic's reasoning variant is unmarked
  // (claude-opus-4-7) and the non-reasoning sibling carries the marker.
  it("treats unmarked-with-non-reasoning-sibling as reasoning", () => {
    const siblings = new Set([
      "claude-opus-4-7",
      "claude-opus-4-7-non-reasoning",
    ]);
    expect(effectiveVariant("claude-opus-4-7", siblings)).toBe("reasoning");
    expect(effectiveVariant("claude-opus-4-7-non-reasoning", siblings)).toBe(
      "non-reasoning",
    );
  });

  it("leaves a truly-unmarked slug (no sibling) as base", () => {
    const siblings = new Set(["claude-opus-4-6", "claude-opus-4-6-adaptive"]);
    expect(effectiveVariant("claude-opus-4-6", siblings)).toBe("base");
  });

  it("respects an explicit marker regardless of siblings", () => {
    const siblings = new Set(["deepseek-v3-2", "deepseek-v3-2-reasoning"]);
    expect(effectiveVariant("deepseek-v3-2-reasoning", siblings)).toBe(
      "reasoning",
    );
  });
});

describe("parseVariantQualifier", () => {
  it("splits a trailing reasoning qualifier", () => {
    expect(parseVariantQualifier("opus reasoning")).toEqual({
      base: "opus",
      variant: "reasoning",
    });
  });

  it("normalizes thinking to reasoning", () => {
    expect(parseVariantQualifier("opus thinking")).toEqual({
      base: "opus",
      variant: "reasoning",
    });
  });

  it("strips parentheses", () => {
    expect(parseVariantQualifier("opus (Reasoning)")).toEqual({
      base: "opus",
      variant: "reasoning",
    });
  });

  it("detects non-reasoning without matching plain reasoning", () => {
    expect(parseVariantQualifier("gpt-5 non-reasoning")).toEqual({
      base: "gpt-5",
      variant: "non-reasoning",
    });
  });

  it("returns null variant for unqualified names", () => {
    expect(parseVariantQualifier("opus")).toEqual({
      base: "opus",
      variant: null,
    });
  });
});

describe("stripEffortQualifier", () => {
  it("strips a trailing effort tier", () => {
    expect(stripEffortQualifier("gpt-5 high")).toEqual({
      base: "gpt-5",
      effort: "high",
    });
    expect(stripEffortQualifier("gpt-5 xhigh")).toEqual({
      base: "gpt-5",
      effort: "xhigh",
    });
  });

  it("returns null effort when none present", () => {
    expect(stripEffortQualifier("gpt-5")).toEqual({
      base: "gpt-5",
      effort: null,
    });
  });

  it("does not treat substrings as effort tiers", () => {
    // "minimalist" must not match "minimal"; word-boundary anchored.
    expect(stripEffortQualifier("model-minimalist").effort).toBeNull();
  });
});

// ─── Realistic Hermes routing scenarios ────────────────────────────────────
// Each entry mirrors a routing query Hermes actually sends. The streak runs
// these in order; a failure documents → fixes → restarts. See
// docs/resolve-routing-scenarios.md for the failure log.

type Scenario = {
  label: string;
  input: string;
  routingName: string;
  resolvedSlug: string;
  variant: "reasoning" | "non-reasoning" | "base";
  requestedVariant?: "reasoning" | "non-reasoning" | "base" | null;
  fellBackToPrimary?: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    label: "bare family name resolves to primary",
    input: "opus",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-6",
    variant: "base",
    requestedVariant: null,
  },
  {
    label: "explicit reasoning qualifier picks newest reasoning slug",
    input: "opus reasoning",
    routingName: "opus",
    // claude-opus-4-7's sibling is claude-opus-4-7-non-reasoning, so 4-7 IS
    // the reasoning variant and is newer than the explicitly-marked 4-5.
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
    fellBackToPrimary: false,
  },
  {
    label: "thinking is normalized to reasoning",
    input: "opus thinking",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "parenthesized reasoning qualifier",
    input: "opus (Reasoning)",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "explicit non-reasoning qualifier",
    input: "opus non-reasoning",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7-non-reasoning",
    variant: "non-reasoning",
    requestedVariant: "non-reasoning",
  },
  {
    label: "full variant slug resolves via exact match",
    input: "claude-opus-4-5-thinking",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-5-thinking",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "haiku reasoning variant",
    input: "haiku reasoning",
    routingName: "haiku",
    resolvedSlug: "claude-4-5-haiku-reasoning",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "grok non-reasoning picks newest non-reasoning slug",
    input: "grok-4 non-reasoning",
    routingName: "grok-4",
    resolvedSlug: "grok-4-20-non-reasoning",
    variant: "non-reasoning",
    requestedVariant: "non-reasoning",
  },
  {
    label: "deepseek reasoning variant",
    input: "deepseek-v3.2 reasoning",
    routingName: "deepseek-v3.2",
    resolvedSlug: "deepseek-v3-2-reasoning",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "gemini flash reasoning variant",
    input: "gemini-3-flash reasoning",
    routingName: "gemini-3-flash",
    resolvedSlug: "gemini-3-flash-reasoning",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    // GPT-5.2 reasons by default; gpt-5-2-non-reasoning is the explicit
    // opt-out, so gpt-5-2 is correctly inferred as the reasoning variant.
    label: "reasoning-by-default family infers the unmarked slug as reasoning",
    input: "gpt-5.2 reasoning",
    routingName: "gpt-5.2",
    resolvedSlug: "gpt-5-2",
    variant: "reasoning",
    requestedVariant: "reasoning",
    fellBackToPrimary: false,
  },
  {
    // gpt-5 family has no reasoning slug and no -non-reasoning sibling, so
    // a reasoning request genuinely falls back to the primary, flagged.
    label:
      "reasoning requested but family has no reasoning slug → fallback flagged",
    input: "gpt-5 reasoning",
    routingName: "gpt-5",
    resolvedSlug: "gpt-5",
    variant: "base",
    requestedVariant: "reasoning",
    fellBackToPrimary: true,
  },
  // ── Adversarial batch: untested dimensions ────────────────────────────
  {
    label: "case-insensitive name + variant",
    input: "Opus Reasoning",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "alias + variant qualifier",
    input: "claude-opus reasoning",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "dotted alias + variant qualifier",
    input: "claude-opus-4.7 reasoning",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "extra whitespace is tolerated",
    input: "   opus    thinking  ",
    routingName: "opus",
    resolvedSlug: "claude-opus-4-7",
    variant: "reasoning",
    requestedVariant: "reasoning",
  },
  {
    label: "exact non-reasoning slug via direct match",
    input: "grok-4-20-non-reasoning",
    routingName: "grok-4",
    resolvedSlug: "grok-4-20-non-reasoning",
    variant: "non-reasoning",
    requestedVariant: "non-reasoning",
  },
  {
    label: "alias resolves to family base",
    input: "gemini-flash",
    routingName: "gemini-3-flash",
    resolvedSlug: "gemini-3-flash",
    variant: "base",
    requestedVariant: null,
  },
  {
    // Effort-tier qualifier (high/low/xhigh) — not a reasoning marker, but a
    // routing agent will send "gpt-5 high". It must resolve the base family,
    // not 404. (Effort is captured separately; see effort field.)
    label: "effort qualifier resolves base family",
    input: "gpt-5 high",
    routingName: "gpt-5",
    resolvedSlug: "gpt-5",
    variant: "base",
    requestedVariant: null,
  },
];

describe("resolveRoutingName — realistic scenarios (agmodb-dhu.2)", () => {
  const indexes = makeIndexes();

  for (const s of SCENARIOS) {
    it(s.label, () => {
      const r = resolveRoutingName(s.input, indexes);
      expect(r, `"${s.input}" should resolve`).not.toBeNull();
      expect(r!.family.routingName).toBe(s.routingName);
      expect(r!.resolvedSlug).toBe(s.resolvedSlug);
      expect(r!.variant).toBe(s.variant);
      if (s.requestedVariant !== undefined) {
        expect(r!.requestedVariant).toBe(s.requestedVariant);
      }
      if (s.fellBackToPrimary !== undefined) {
        expect(r!.fellBackToPrimary).toBe(s.fellBackToPrimary);
      }
    });
  }

  it("returns null for an unknown routing name", () => {
    expect(resolveRoutingName("claude-opus-99", indexes)).toBeNull();
  });
});
