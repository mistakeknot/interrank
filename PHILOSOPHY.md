# interrank Philosophy

## Purpose
Snapshot-backed model/benchmark ranking MCP server for AgMoDB. Surfaces the best model for any given task by maintaining fresh, diverse rankings across benchmarks.

## North Star
Surface the best model for the job — ranking accuracy across benchmarks and tasks.

## Working Priorities
- Ranking freshness (new models ranked quickly)
- Benchmark diversity (no single-metric bias)
- Query latency

## Brainstorming Doctrine
1. Start from outcomes and failure modes, not implementation details.
2. Generate at least three options: conservative, balanced, and aggressive.
3. Explicitly call out assumptions, unknowns, and dependency risk across modules.
4. Prefer ideas that improve clarity, reversibility, and operational visibility.

## Planning Doctrine
1. Convert selected direction into small, testable, reversible slices.
2. Define acceptance criteria, verification steps, and rollback path for each slice.
3. Sequence dependencies explicitly and keep integration contracts narrow.
4. Reserve optimization work until correctness and reliability are proven.

## Decision Filters
- Does this improve model selection decisions?
- Does this resist benchmark gaming?
- Is the data provenance clear?
- Can stale rankings be identified and refreshed?
