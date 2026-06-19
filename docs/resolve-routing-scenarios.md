# resolve_routing_name — scenario hardening log

Tracks the realistic-scenario streak for `resolveRoutingName` (agmodb-dhu.2).
Each failure is documented here, gets a regression test in `src/resolve.test.ts`,
is fixed, then the streak restarts. Target: 10 consecutive passing scenarios.

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
