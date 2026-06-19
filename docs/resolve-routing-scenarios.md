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
