import type { Finding } from "@/core/types";
import { SEVERITY_ORDER } from "@/core/types";

/**
 * Within a severity, what matters most first: the index and query advice
 * people come for, then things that will break, then housekeeping.
 */
const CHECK_PRIORITY = [
  "index-suggestions",
  "slow-queries",
  "unindexed-foreign-keys",
  "sequence-exhaustion",
  "xid-wraparound",
  "invalid-indexes",
  "high-impact-queries",
  "blocked-queries",
  "idle-in-transaction",
  "long-running-queries",
  "duplicate-indexes",
  "unused-indexes",
  "dead-tuples",
  "stale-statistics",
  "seq-scan-heavy-tables",
  "temp-spill-queries",
  "disk-read-queries",
];

const checkRank = (id: string) => {
  const i = CHECK_PRIORITY.indexOf(id);
  return i === -1 ? CHECK_PRIORITY.length : i;
};

export interface Recommendation {
  key: string;
  finding: Finding;
  /** Other findings recommending the same change. */
  related: Finding[];
}

/** Order findings by importance and merge the ones that recommend the same change. */
export function buildRecommendations(findings: Finding[]): Recommendation[] {
  const sorted = [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      checkRank(a.checkId) - checkRank(b.checkId),
  );
  const out: Recommendation[] = [];
  const byGroup = new Map<string, Recommendation>();
  for (const f of sorted) {
    const existing = f.groupKey ? byGroup.get(f.groupKey) : undefined;
    if (existing) {
      existing.related.push(f);
      continue;
    }
    const rec: Recommendation = { key: f.key, finding: f, related: [] };
    out.push(rec);
    if (f.groupKey) byGroup.set(f.groupKey, rec);
  }
  return out;
}

/** First sentence of a description, for one-line summaries. */
export function firstSentence(text: string): string {
  const m = text.match(/^(.*?[.!?])(?=\s+[A-Z(`"]|\s*$)/s);
  return (m ? m[1] : text).trim();
}
