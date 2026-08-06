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
 * Snapshot v3 resolves exact slugs, targeted aliases, declared primaries, and
 * authoritative model variant descriptors in that order. Ambiguous qualified
 * requests require an exact slug and zero matches fail closed. Older snapshots
 * retain the historical slug heuristic for response compatibility.
 *
 * Tracks agmodb-dhu.2. The full editorial variant glossary lives in agmodb
 * (src/data/variant-glossary.ts) for the web UI; this is the focused
 * routing-relevant subset.
 */
import type {
  DecisionRoute,
  SnapshotModel,
  SnapshotModelFamily,
} from "./types.js";
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
  catalog: SnapshotIndexes["catalog"];
  /** Every declared family member, including declared-but-missing slugs. */
  members: RoutingFamilyMember[];
  /** Authoritative selection result for agent consumers. */
  selection: RoutingSelection;
  /** The specific slug chosen for this resolution. */
  resolvedSlug: string | null;
  /** Reasoning posture of the resolved slug. */
  variant:
    | ResolvedVariant
    | "unspecified"
    | null;
  /** Whether the resolved posture came from v3 metadata or a v2 heuristic. */
  variantProvenance: "snapshot" | "legacy_inferred" | "unknown";
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

export type RoutingFamilyMember = {
  slug: string;
  model: SnapshotModel | null;
  route: DecisionRoute | null;
};

export type RoutingSelection = {
  kind:
    | "exact-slug"
    | "targeted-alias"
    | "family-primary"
    | "qualified-variant"
    | "ambiguous"
    | "no-match"
    | "legacy-qualified-variant"
    | "legacy-fallback";
  route: DecisionRoute | null;
  requiresExactSlug: boolean;
  candidateSlugs: string[];
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

const ROUTE_IDENTITY_CAVEAT =
  "This route identifies a model variant only; benchmark harness and deployment configuration remain unresolved.";

/** Build the exact model-level identity used by AgMoDB Decision Packet v1. */
function decisionRoute(model: SnapshotModel): DecisionRoute {
  return {
    id: `agmodb:model:${model.slug}`,
    identityLevel: "model",
    modelSlug: model.slug,
    modelName: model.name,
    provider: { name: model.providerName, slug: model.providerSlug },
    variant: model.variant ?? null,
    harness: null,
    identityCaveat: ROUTE_IDENTITY_CAVEAT,
  };
}

function familyMembers(
  family: SnapshotModelFamily,
  indexes: SnapshotIndexes,
): RoutingFamilyMember[] {
  return family.slugs.map((slug) => {
    const model = indexes.modelsBySlug.get(slug) ?? null;
    return {
      slug,
      model,
      route: model ? decisionRoute(model) : null,
    };
  });
}

function authoritativeVariant(
  model: SnapshotModel | null,
): RoutingResolution["variant"] {
  return model?.variant?.reasoning ?? null;
}

function requestedVariantForModel(
  model: SnapshotModel | null,
): "reasoning" | "non-reasoning" | null {
  const reasoning = model?.variant?.reasoning;
  return reasoning === "reasoning" || reasoning === "non-reasoning"
    ? reasoning
    : null;
}

function normalizeEffort(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+effort$/, "")
    .replace(/\s+/g, " ");
}

function makeResolution(
  family: SnapshotModelFamily,
  indexes: SnapshotIndexes,
  selection: RoutingSelection,
  requestedVariant: ResolvedVariant | null,
  effort: ResolvedEffort | null,
  legacyVariant?: ResolvedVariant,
  fellBackToPrimary = false,
): RoutingResolution {
  const selectedModel = selection.route
    ? indexes.modelsBySlug.get(selection.route.modelSlug) ?? null
    : null;
  return {
    family,
    catalog: indexes.catalog,
    members: familyMembers(family, indexes),
    selection,
    resolvedSlug:
      selection.route?.modelSlug ??
      (selection.requiresExactSlug ? null : selection.candidateSlugs[0] ?? null),
    variant:
      indexes.catalog.snapshotVersion >= 3
        ? authoritativeVariant(selectedModel)
        : (legacyVariant ?? null),
    variantProvenance:
      indexes.catalog.snapshotVersion < 3
        ? "legacy_inferred"
        : selectedModel?.variant
          ? "snapshot"
          : "unknown",
    requestedVariant,
    fellBackToPrimary,
    effort,
  };
}

function selectSlug(
  family: SnapshotModelFamily,
  indexes: SnapshotIndexes,
  slug: string,
  kind: RoutingSelection["kind"],
  requestedVariant: ResolvedVariant | null,
  effort: ResolvedEffort | null,
  legacyVariant?: ResolvedVariant,
  fellBackToPrimary = false,
): RoutingResolution {
  const model = indexes.modelsBySlug.get(slug) ?? null;
  return makeResolution(
    family,
    indexes,
    {
      kind,
      route: model ? decisionRoute(model) : null,
      requiresExactSlug: false,
      candidateSlugs: [slug],
    },
    requestedVariant,
    effort,
    legacyVariant,
    fellBackToPrimary,
  );
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

  // 1. An exact member slug always wins over aliases and qualifiers.
  const exactFamily = indexes.familyBySlug.get(normalized);
  const matchedSlug = exactFamily?.slugs.find(
    (slug) => slug.toLowerCase() === normalized,
  );
  if (exactFamily && matchedSlug) {
    const model = indexes.modelsBySlug.get(matchedSlug) ?? null;
    const legacyVariant = effectiveVariant(
      matchedSlug,
      slugSetFor(exactFamily),
    );
    return selectSlug(
      exactFamily,
      indexes,
      matchedSlug,
      "exact-slug",
      indexes.catalog.snapshotVersion >= 3
        ? requestedVariantForModel(model)
        : legacyVariant !== "base"
          ? legacyVariant
          : null,
      null,
      legacyVariant,
    );
  }

  // 2. A snapshot may bind an alias to one exact family member.
  const direct = indexes.familyByName.get(normalized);
  const targetedAlias = indexes.targetedAliasByName.get(normalized);
  if (targetedAlias) {
    const model = indexes.modelsBySlug.get(targetedAlias.targetSlug) ?? null;
    return selectSlug(
      targetedAlias.family,
      indexes,
      targetedAlias.targetSlug,
      "targeted-alias",
      requestedVariantForModel(model),
      null,
      model
        ? effectiveVariant(model.slug, slugSetFor(targetedAlias.family))
        : undefined,
    );
  }

  // 3. A bare routing name or untargeted alias selects the declared primary.
  if (direct) {
    const legacyVariant = effectiveVariant(
      direct.primarySlug,
      slugSetFor(direct),
    );
    return selectSlug(
      direct,
      indexes,
      direct.primarySlug,
      "family-primary",
      null,
      null,
      legacyVariant,
    );
  }

  // 4. Strip reasoning and/or effort qualifiers and retry the base family.
  const { base: afterVariant, variant } = parseVariantQualifier(name);
  const { base, effort } = stripEffortQualifier(afterVariant);

  if (!base || (!variant && !effort)) return null;
  const family = indexes.familyByName.get(base);
  if (!family) return null;

  // Snapshot v3 owns variant truth. Do not infer from slugs or silently fall
  // back when the authoritative descriptors return zero or multiple matches.
  if (indexes.catalog.snapshotVersion >= 3) {
    const matches = family.slugs
      .map((slug) => indexes.modelsBySlug.get(slug) ?? null)
      .filter((model): model is SnapshotModel => model !== null)
      .filter((model) => {
        if (!model.variant) return false;
        if (variant && model.variant.reasoning !== variant) return false;
        if (
          effort &&
          (model.variant.effort === null ||
            normalizeEffort(model.variant.effort) !== normalizeEffort(effort))
        ) {
          return false;
        }
        return true;
      });

    if (matches.length === 0) {
      return makeResolution(
        family,
        indexes,
        {
          kind: "no-match",
          route: null,
          requiresExactSlug: false,
          candidateSlugs: [],
        },
        variant,
        effort,
      );
    }
    if (matches.length === 1) {
      return selectSlug(
        family,
        indexes,
        matches[0].slug,
        "qualified-variant",
        variant,
        effort,
      );
    }
    return makeResolution(
      family,
      indexes,
      {
        kind: "ambiguous",
        route: null,
        requiresExactSlug: true,
        candidateSlugs: matches.map((model) => model.slug),
      },
      variant,
      effort,
    );
  }

  // Legacy snapshots have no descriptors. Preserve the previous heuristic
  // contract until those snapshots age out.
  if (variant) {
    const slug = pickVariantSlug(family, variant);
    if (slug) {
      return selectSlug(
        family,
        indexes,
        slug,
        "legacy-qualified-variant",
        variant,
        effort,
        variant,
      );
    }
    const primaryVariant = effectiveVariant(
      family.primarySlug,
      slugSetFor(family),
    );
    return selectSlug(
      family,
      indexes,
      family.primarySlug,
      "legacy-fallback",
      variant,
      effort,
      primaryVariant,
      true,
    );
  }

  const primaryVariant = effectiveVariant(
    family.primarySlug,
    slugSetFor(family),
  );
  return selectSlug(
    family,
    indexes,
    family.primarySlug,
    "legacy-qualified-variant",
    null,
    effort,
    primaryVariant,
  );
}
