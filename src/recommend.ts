import type { SnapshotBenchmark } from "./types.js";

export type ScoredBenchmark = SnapshotBenchmark & {
  score: number;
  matchReason: string;
};

/**
 * Map of task archetype keywords → benchmark categories.
 * When a query matches an archetype, benchmarks in those categories get a boost.
 */
export const TASK_DOMAIN_MAP: Record<string, string[]> = {
  "coding": ["coding", "agents"],
  "programming": ["coding", "agents"],
  "software engineering": ["coding", "agents"],
  "code review": ["coding", "agents"],
  "chatbot": ["quality", "safety"],
  "customer support": ["quality", "safety"],
  "research": ["reasoning", "knowledge"],
  "math": ["math", "reasoning"],
  "data science": ["coding", "math", "reasoning"],
  "writing": ["quality"],
  "summarization": ["quality", "long-context"],
  "agent": ["agents", "coding"],
  "automation": ["agents", "coding"],
  "factual": ["safety", "knowledge"],
  "hallucination": ["safety"],
};

const WEIGHT_USE_CASE = 3;
const WEIGHT_DESCRIPTION = 1;
const WEIGHT_CATEGORY = 1.5;
const WEIGHT_NAME = 1;
const DOMAIN_BOOST = 2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function fieldMatches(tokens: string[], text: string): string[] {
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token));
}

function resolveAffinityDomains(query: string): string[] {
  const lower = query.toLowerCase();
  const domains = new Set<string>();
  for (const [archetype, archetypeDomains] of Object.entries(TASK_DOMAIN_MAP)) {
    if (lower.includes(archetype)) {
      for (const domain of archetypeDomains) {
        domains.add(domain);
      }
    }
  }
  return [...domains];
}

/**
 * Score benchmarks against a natural-language task query.
 *
 * Scoring:
 * - Token overlap against relevantUseCases (weight 3)
 * - Token overlap against description (weight 1)
 * - Token overlap against category (weight 1.5)
 * - Token overlap against name (weight 1)
 * - Domain affinity boost when task matches a TASK_DOMAIN_MAP archetype (weight 2)
 *
 * Returns benchmarks with score > 0, sorted descending by score.
 */
export function scoreBenchmarks(
  task: string,
  benchmarks: SnapshotBenchmark[],
  limit: number = 10,
): ScoredBenchmark[] {
  const tokens = tokenize(task);
  if (tokens.length === 0) return [];

  const affinityDomains = resolveAffinityDomains(task);

  const scored: ScoredBenchmark[] = [];

  for (const benchmark of benchmarks) {
    let score = 0;
    const reasons: string[] = [];

    // Match against relevantUseCases
    for (const useCase of benchmark.relevantUseCases) {
      const matches = fieldMatches(tokens, useCase);
      if (matches.length > 0) {
        score += matches.length * WEIGHT_USE_CASE;
        reasons.push(`matched '${matches.join("', '")}' in useCases`);
      }
    }

    // Match against description
    if (benchmark.description) {
      const matches = fieldMatches(tokens, benchmark.description);
      if (matches.length > 0) {
        score += matches.length * WEIGHT_DESCRIPTION;
        reasons.push(`matched '${matches.join("', '")}' in description`);
      }
    }

    // Match against category
    const categoryMatches = fieldMatches(tokens, benchmark.category);
    if (categoryMatches.length > 0) {
      score += categoryMatches.length * WEIGHT_CATEGORY;
      reasons.push(`matched '${categoryMatches.join("', '")}' in category`);
    }

    // Match against name
    const nameMatches = fieldMatches(tokens, benchmark.name);
    if (nameMatches.length > 0) {
      score += nameMatches.length * WEIGHT_NAME;
      reasons.push(`matched '${nameMatches.join("', '")}' in name`);
    }

    // Domain affinity boost
    if (affinityDomains.length > 0 && affinityDomains.includes(benchmark.category)) {
      score += DOMAIN_BOOST;
      reasons.push(`boosted by '${benchmark.category}' domain affinity`);
    }

    if (score > 0) {
      scored.push({
        ...benchmark,
        score,
        matchReason: reasons.join("; "),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
