import type { Check, Finding, IndexSuggestion, Row } from "@/core/types";
import { displayColumns, formatNumber, formatReduction, oneLine } from "@/core/format";
import type { PostgresEnvironment } from "../environment";
import { CatalogCache, explainQuery } from "../explain/explain";
import { relationKey } from "../explain/planAnalyzer";
import { SELF_MARKER, toQueryStat, topQueriesSql } from "../queryStats";
import { shortName, statementKind } from "../sql";

type PgCheck = Check<PostgresEnvironment>;

const SYSTEM_RE = /\b(pg_catalog|information_schema|pg_stat_\w+|pg_class|pg_namespace|pg_attribute|pg_index|pg_settings)\b/i;

interface Collected {
  suggestion: IndexSuggestion;
  queries: { query: string; totalTimeMs: number }[];
}

export const indexSuggestions: PgCheck = {
  id: "index-suggestions",
  category: "indexes",
  title: "Suggested indexes for your slowest queries",
  description:
    "Explains the queries that use the most time and looks for scans an index would avoid. With hypopg installed, each suggestion is checked with a hypothetical index first.",
  unavailableReason: (env) =>
    !env.pgss.readable
      ? "Needs pg_stat_statements to know which queries to examine."
      : null,
  async run({ runner, env, settings }) {
    const stats = (await runner.query(topQueriesSql(env, "total", settings.explainTopQueries * 2)))
      .map(toQueryStat)
      .filter((q) => !SYSTEM_RE.test(q.query) && !q.query.includes(SELF_MARKER))
      .filter((q) => {
        const kind = statementKind(q.query);
        return kind === "select" || kind === "dml";
      })
      .slice(0, settings.explainTopQueries);

    const cache = new CatalogCache();
    const collected = new Map<string, Collected>();
    const rows: Row[] = [];

    for (const q of stats) {
      const result = await explainQuery(runner, env, q.query, { analyze: false }, settings, cache);
      rows.push({
        query: oneLine(q.query, 300),
        total_time_ms: q.totalTimeMs,
        status: result.ok ? "explained" : "skipped",
        detail: result.ok
          ? `${result.suggestions.length} suggestion(s), ${result.issues.length} issue(s)`
          : result.error ?? "",
      });
      if (!result.ok) continue;
      for (const s of result.suggestions) {
        if (s.coveredBy) continue;
        if (s.validation && !s.validation.usedByPlanner) continue;
        const key = `${relationKey(s.schema, s.table)}|${s.method}|${s.columns.join(",")}`;
        const entry = collected.get(key) ?? { suggestion: s, queries: [] };
        entry.queries.push({ query: q.query, totalTimeMs: q.totalTimeMs });
        // Prefer the copy with the strongest validation.
        if (s.validation && (!entry.suggestion.validation || s.validation.costAfter / s.validation.costBefore <
          entry.suggestion.validation.costAfter / entry.suggestion.validation.costBefore)) {
          entry.suggestion = s;
        }
        collected.set(key, entry);
      }
    }

    const findings: Finding[] = [...collected.values()].map(({ suggestion: s, queries }) => {
      const v = s.validation;
      const saving = v && v.costBefore > 0 ? 1 - v.costAfter / v.costBefore : null;
      const table = shortName(s.schema, s.table);
      const totalTime = queries.reduce((sum, q) => sum + q.totalTimeMs, 0);
      return {
        key: `index-suggestions:${relationKey(s.schema, s.table)}:${s.columns.join(",")}`,
        checkId: "index-suggestions",
        category: "indexes",
        severity: (saving !== null && saving >= 0.5) || totalTime >= 60_000 ? "warning" : "info",
        title: `Add an index on ${table} (${displayColumns(s.columns)})`,
        groupKey: `index:${s.schema ?? ""}.${s.table}(${s.columns.map((c) => c.replace(/^\((.*)\)$/, "$1")).join(",")})`.toLowerCase(),
        description:
          `${s.reason}. Helps ${queries.length === 1 ? "one" : queries.length} of the most expensive queries.` +
          (v
            ? ` With a hypothetical index the planner uses it and the estimated cost drops ${formatReduction(saving ?? 0)} (${formatNumber(Math.round(v.costBefore))} → ${formatNumber(Math.round(v.costAfter))}).`
            : env.hypopg.available && !env.hypopg.installed
              ? " Install hypopg to have suggestions verified before you build them."
              : ""),
        target: { kind: "table", schema: s.schema, name: s.table },
        query: queries[0].query,
        metrics: [
          { label: "Queries helped", value: queries.length },
          { label: "Their total time", value: totalTime, format: "ms" },
          ...(v ? [{ label: "Est. cost reduction", value: (saving ?? 0) * 100, format: "percent" as const }] : []),
        ],
        fix: {
          title: "Create index",
          sql: `-- CONCURRENTLY builds without blocking writes; it can't run inside a transaction.\n${s.ddl}`,
          safety: "safe",
          notes: "Every index slows down writes a little. Check it's used afterwards.",
        },
      } satisfies Finding;
    });
    const skipped = rows.filter((r) => r.status !== "explained");
    let note: string | undefined;
    if (!stats.length) {
      note = "No application queries recorded in pg_stat_statements yet.";
    } else if (skipped.length) {
      const reason = String(skipped[0].detail ?? "").replace(/\.$/, "");
      note =
        `${skipped.length} of ${rows.length} queries couldn't be explained` +
        (reason ? ` (${reason})` : "") +
        ". Show the data for details, or analyze them by hand in the query analyzer.";
    }
    return { findings, rows, note, inconclusive: stats.length > 0 && skipped.length === rows.length };
  },
};
