# resolve_routing_name — scenario hardening log

Tracks the realistic-scenario streak for `resolveRoutingName` (agmodb-dhu.2).
Each failure is documented here, gets a regression test in `src/resolve.test.ts`,
is fixed, then the streak restarts. Target: 10 consecutive passing scenarios.

## Snapshot v3 authoritative routing contract

Snapshot v3 model `variant` descriptors are authoritative. Interrank does not
reclassify a v3 model whose descriptor is absent, and it never falls back to a
family primary when an explicit reasoning or effort qualifier has no match.
The deterministic precedence is:

1. An exact declared member slug selects that model.
2. An alias listed in optional `aliasTargets` selects its declared target.
3. A bare routing name or untargeted alias selects `primarySlug`.
4. Reasoning and effort qualifiers filter the family members' snapshot
   descriptors. One match selects; multiple matches return no route with
   `requiresExactSlug: true`; zero matches return an explicit `no-match`
   selection with no route or primary substitution.

The MCP response includes snapshot catalog provenance, every declared family
member, and a `selection` object. Every selected or member route uses the exact
AgMoDB Decision Packet v1 model-level route shape, including the authoritative
variant descriptor and the unresolved-harness caveat. Snapshot v2 and older
retain their legacy slug heuristic for compatibility only, and every posture
derived from that heuristic is labeled `legacy_inferred`.

An exact adaptive slug such as `claude-opus-4-6-adaptive` is valid. The query
`opus adaptive` is not: `adaptive` is not an authoritative reasoning/effort
qualifier, so Interrank does not invent an adaptive mode from the slug.

## Failure 1 — sibling-inferred reasoning variant (Anthropic naming inversion)

**Inputs:** `opus reasoning`, `opus thinking`, `opus (Reasoning)`

**Expected:** `claude-opus-4-7` (the newest reasoning-capable Opus)
**Got:** `claude-opus-4-5-thinking` (an older, explicitly-marked reasoning slug)

**Root cause.** Providers disagree on how the reasoning variant is named:

- DeepSeek / Gemini / Grok: base is unmarked, reasoning is `…-reasoning`.
- Anthropic (Opus 4.7): the *reasoning* variant is unmarked (`claude-opus-4-7`)
  and the *non-reasoning* sibling carries the marker (`…-non-reasoning`).

`classifySlugVariant` looked only at the slug's own name, so `claude-opus-4-7`
classified as `base`. The reasoning-variant picker then skipped it and matched
the next reasoning slug in recency order — the stale `claude-opus-4-5-thinking`.

**Fix.** Introduce `effectiveVariant(slug, slugSet)`: an unmarked slug whose
`"{slug}-non-reasoning"` sibling exists in the family IS the reasoning variant.
Thread the family's slug set through `pickVariantSlug` and the resolved
`variant` classification so both the picker and the reported posture agree.

**Coverage added.** Scenarios 2–4 (reasoning/thinking/paren on opus) assert
`claude-opus-4-7`. Unit test `effectiveVariant treats unmarked-with-non-reasoning-sibling as reasoning`.

**Streak after fix:** restarted from 0.

## Failure 3 — effort qualifier 404s

**Input:** `gpt-5 high`

**Expected:** resolve the `gpt-5` base family (effort captured separately).
**Got:** `null` ("Unknown routing name").

**Root cause.** The resolver only retried after stripping a *reasoning* variant
qualifier. An effort-tier qualifier (`high`/`low`/`medium`/`minimal`/`xhigh`/
`max`) left `parseVariantQualifier` with `variant: null`, so step 2's
`if (variant && base)` guard was never entered and the name fell through to
`null`. Routing agents routinely send "gpt-5 high".

**Fix.** Add `stripEffortQualifier` and an `effort` field on the resolution.
Step 2 now strips both reasoning *and* effort qualifiers, and retries the base
lookup whenever either qualifier was present (not only on a reasoning variant).
Effort doesn't change the family/slug in v0 — it's surfaced as metadata so the
agent can pass it through to the provider.

**Coverage added.** Scenario `effort qualifier resolves base family`
(`gpt-5 high`), plus `reasoning + effort combined` and a `stripEffortQualifier`
unit test.

**Streak after fix:** restarted from 0.

## Failure 4 — requestedVariant conflated resolved posture with caller intent

**Input:** `deepseek-v3-2-speciale` (exact slug)

**Expected:** `requestedVariant: null` — Speciale is a distinct model name, not a
reasoning toggle, so the caller expressed no reasoning-posture intent.
**Got:** `requestedVariant: "base"`.

**Root cause — in the code.** The exact-match path set
`requestedVariant: matchedSlug ? variant : null`. For a base-posture slug that
made `requestedVariant: "base"`, claiming the caller "asked for the base
variant" when they merely named a specific model. `requestedVariant` should
reflect *reasoning-posture intent*, which a base slug doesn't carry.

**Fix.** `requestedVariant: matchedSlug && variant !== "base" ? variant : null`.
Reasoning / non-reasoning exact slugs still report their posture; base-posture
slugs report null.

**Coverage added.** Scenario `distinct-model trailing word (Speciale)…`.

**Streak after fix:** restarted from 0.

## Failure 2 — stale test oracle: GPT-5.2 reasons by default

**Input:** `gpt-5.2 reasoning`

**Expected (as written):** fall back to primary, `fellBackToPrimary: true`, variant `base`.
**Got:** `gpt-5-2`, variant `reasoning`, `fellBackToPrimary: false`.

**Root cause — in the test, not the code.** GPT-5.2's family carries
`gpt-5-2` and `gpt-5-2-non-reasoning`. By the same sibling inference from
Failure 1, the unmarked `gpt-5-2` IS the reasoning-default variant (OpenAI
exposes non-reasoning as the explicit opt-out). The resolver correctly
resolved it; my hand-written expectation was the stale one.

**Fix.** Correct the `gpt-5.2 reasoning` scenario to expect `gpt-5-2` /
`reasoning` / no fallback. Add a *genuine* fallback scenario — `gpt-5
reasoning` — where the family (`gpt-5`, `gpt-5-low`, `gpt-5-medium`,
`gpt-5-minimal`, `gpt-5-codex`) has no reasoning slug and no `-non-reasoning`
sibling, so falling back to the primary with `fellBackToPrimary: true` is
the correct, coverage-preserving behavior.

**Streak after fix:** restarted from 0.
