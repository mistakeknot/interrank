/**
 * Routing-name resolution with explicit variant disambiguation.
 *
 * Hermes (the routing-agent persona) calls resolve_routing_name to translate
 * a model identifier into AgMoDB's canonical family/slug. The fragility this
 * module fixes: variant suffixes are inconsistent across providers — Anthropic
 * says "(Thinking)", everyone else says "(Reasoning)" — and the old resolver
 * did pure exact-match, so "opus reasoning" failed and a bare "opus" silently
 * dropped any variant intent. There was also no way for the agent to tell
 * which variant it actually got.
 *
 * This resolver:
 *   1. Normalizes the query (case, parens, "thinking" ≡ "reasoning").
 *   2. Splits an explicit variant qualifier off the routing name.
 *   3. Resolves the base family, then picks the slug matching the requested
 *      variant — falling back to the family primary if that variant isn't
 *      present, with the fallback flagged.
 *   4. Returns an explicit `variant` field so routing is deterministic.
 *
 * Tracks agmodb-dhu.2. The full editorial variant glossary lives in agmodb
 * (src/data/variant-glossary.ts) for the web UI; this is the focused
 * routing-relevant subset. A future snapshot revision could carry canonical
 * variant tags per slug so both sides share one source of truth.
 */
import type { SnapshotModelFamily } from "./types.js";
import type { SnapshotIndexes } from "./load.js";

/** Reasoning posture of a model variant, as far as routing cares. */
export type ResolvedVariant = "reasoning" | "non-reasoning" | "base";

/** Reasoning-effort tier a caller may append (OpenAI-style). */
export type ResolvedEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type RoutingResolution = {
  family: SnapshotModelFamily;
  /** The specific slug chosen for this resolution. */
  resolvedSlug: string;
  /** Reasoning posture of the resolved slug. */
  variant: ResolvedVariant;
  /** The variant the caller explicitly asked for, or null if unqualified. */
  requestedVariant: ResolvedVariant | null;
  /**
   * True when the caller asked for a variant the family doesn't carry, so we
   * fell back to the primary slug. Lets the agent know the variant intent
   * was not honored exactly.
   */
  fellBackToPrimary: boolean;
  /**
   * Effort tier the caller appended (e.g. "high" from "gpt-5 high"), or null.
   * Does not change the resolved family/slug in v0 — surfaced so the agent can
   * forward it to the provider.
   */
  effort: ResolvedEffort | null;
};

/**
 * Classify a slug's reasoning posture from its naming convention.
 *
 * Order matters: "-non-reasoning" contains "reasoning" as a substring, so the
 * non-reasoning check must come first. "-thinking" (Anthropic) is treated as
 * equivalent to "-reasoning".
 *
 * NOTE: a slug with no marker is "base" — but for some families the unmarked
 * slug IS the reasoning variant (e.g. claude-opus-4-7, whose sibling is
 * claude-opus-4-7-non-reasoning). That ambiguity is handled at resolution
 * time, not here, because it requires sibling context.
 */
export function classifySlugVariant(slug: string): ResolvedVariant {
  const s = slug.toLowerCase();
  if (s.includes("non-reasoning") || s.includes("non-thinking")) {
    return "non-reasoning";
  }
  if (s.includes("reasoning") || s.includes("thinking")) {
    return "reasoning";
  }
  return "base";
}

/**
 * Variant posture of a slug *in the context of its family's other slugs*.
 *
 * Providers disagree on how the reasoning variant is named. DeepSeek/Gemini/
 * Grok mark the reasoning slug (`…-reasoning`) and leave the base unmarked.
 * Anthropic inverts this: the reasoning variant is unmarked (`claude-opus-4-7`)
 * and the *non-reasoning* sibling carries the marker. So an unmarked slug whose
 * `"{slug}-non-reasoning"` sibling exists in the family is, by contrast, the
 * reasoning variant. Self-name classification (`classifySlugVariant`) can't see
 * that — it needs the sibling set.
 */
export function effectiveVariant(
  slug: string,
  slugSet: Set<string>,
): ResolvedVariant {
  const own = classifySlugVariant(slug);
  if (own !== "base") return own;
  if (slugSet.has(`${slug.toLowerCase()}-non-reasoning`)) return "reasoning";
  return "base";
}

const NON_REASONING_RE = /\b(non[-\s]?reasoning|non[-\s]?thinking)\b/;
const REASONING_RE = /\b(reasoning|thinking)\b/;

/**
 * Split a routing query into its base name and an explicit variant qualifier.
 *
 * Handles "opus reasoning", "opus (reasoning)", "opus thinking",
 * "gpt-5 non-reasoning". Returns variant=null when no qualifier is present.
 * The base is cleaned of trailing separators so it can be looked up directly.
 */
export function parseVariantQualifier(name: string): {
  base: string;
  variant: ResolvedVariant | null;
} {
  // Normalize parens and whitespace: "opus (reasoning)" → "opus reasoning".
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cleanup = (base: string): string =>
    base
      .replace(/[-\s]+$/, "")
      .replace(/^[-\s]+/, "")
      .trim();

  if (NON_REASONING_RE.test(s)) {
    return {
      base: cleanup(s.replace(NON_REASONING_RE, " ")),
      variant: "non-reasoning",
    };
  }
  if (REASONING_RE.test(s)) {
    return {
      base: cleanup(s.replace(REASONING_RE, " ")),
      variant: "reasoning",
    };
  }
  return { base: s, variant: null };
}

const EFFORT_TIERS: ResolvedEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const EFFORT_RE = new RegExp(`\\b(${EFFORT_TIERS.join("|")})\\b`);

/**
 * Strip a trailing effort-tier qualifier off a (already variant-stripped,
 * lowercased, paren-free) name. Returns the cleaned base and the effort, or
 * effort=null when none is present. Routing agents send "gpt-5 high".
 */
export function stripEffortQualifier(name: string): {
  base: string;
  effort: ResolvedEffort | null;
} {
  const match = name.match(EFFORT_RE);
  if (!match) return { base: name.trim(), effort: null };
  const effort = match[1] as ResolvedEffort;
  const base = name
    .replace(EFFORT_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/[-\s]+$/, "")
    .replace(/^[-\s]+/, "")
    .trim();
  return { base, effort };
}

/** Lowercased slug set for a family, for sibling lookups. */
function slugSetFor(family: SnapshotModelFamily): Set<string> {
  return new Set(family.slugs.map((s) => s.toLowerCase()));
}

/**
 * Pick the slug in a family matching the requested reasoning posture, using
 * sibling-aware classification so Anthropic's unmarked reasoning slugs resolve
 * correctly. Slugs are ordered by recency in the family, so the first match is
 * the newest variant of that posture.
 */
function pickVariantSlug(
  family: SnapshotModelFamily,
  variant: ResolvedVariant,
): string | null {
  const slugs = slugSetFor(family);
  for (const slug of family.slugs) {
    if (effectiveVariant(slug, slugs) === variant) return slug;
  }
  return null;
}

/**
 * Resolve a routing-level model name to a family + specific slug + variant.
 * Returns null when the name resolves to no known family.
 */
export function resolveRoutingName(
  name: string,
  indexes: SnapshotIndexes,
): RoutingResolution | null {
  const normalized = name.trim().toLowerCase();

  // 1. Exact match — a routingName, alias, or full slug.
  const direct = indexes.familyByName.get(normalized);
  if (direct) {
    // If the matched key was itself a variant-bearing slug, honor that slug
    // and its posture. Otherwise use the family primary.
    const matchedSlug = direct.slugs.find(
      (s) => s.toLowerCase() === normalized,
    );
    const resolvedSlug = matchedSlug ?? direct.primarySlug;
    const variant = effectiveVariant(resolvedSlug, slugSetFor(direct));
    return {
      family: direct,
      resolvedSlug,
      variant,
      requestedVariant: matchedSlug ? variant : null,
      fellBackToPrimary: false,
    };
  }

  // 2. No exact match — try splitting a variant qualifier off the name.
  const { base, variant } = parseVariantQualifier(name);
  if (variant && base) {
    const family = indexes.familyByName.get(base);
    if (family) {
      const slug = pickVariantSlug(family, variant);
      if (slug) {
        return {
          family,
          resolvedSlug: slug,
          variant,
          requestedVariant: variant,
          fellBackToPrimary: false,
        };
      }
      // Requested variant not present — fall back to primary, flag it.
      return {
        family,
        resolvedSlug: family.primarySlug,
        variant: effectiveVariant(family.primarySlug, slugSetFor(family)),
        requestedVariant: variant,
        fellBackToPrimary: true,
      };
    }
  }

  return null;
}
