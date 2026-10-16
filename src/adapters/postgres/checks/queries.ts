import type { Check, Finding, Row } from "@/core/types";
import { formatBytes, formatMs, formatPercent, toNumber } from "@/core/format";
import type { PostgresEnvironment } from "../environment";
import { SELF_MARKER, toQueryStat, topQueriesSql } from "../queryStats";

type PgCheck = Check<PostgresEnvironment>;

const PGSS_DOCS = "https://www.postgresql.org/docs/current/pgstatstatements.html";

function needsQueryStats(env: PostgresEnvironment): string | null {
  if (env.pgss.readable) return null;
  return env.pgss.installed
    ? "pg_stat_statements is installed but can't be read (see setup notices)."
    : "Needs the pg_stat_statements extension (see setup notices).";
}

const BLOCK_SIZE = 8192;

export const slowQueries: PgCheck = {
  id: "slow-queries",
  category: "queries",
  title: "Slow queries",
  description:
    "Queries whose average execution time is above the slow query threshold, from pg_stat_statements.",
  unavailableReason: needsQueryStats,
  async run({ runner, env, settings }) {
    const rows = await runner.query(topQueriesSql(env, "mean", 200));
    const findings: Finding[] = [];
    const critical = Math.max(1000, settings.slowQueryMs * 10);
    for (const row of rows) {
      const q = toQueryStat(row);
      if (q.calls < settings.minCalls || q.meanTimeMs < settings.slowQueryMs) continue;
      findings.push({
        key: `slow-queries:${q.id}`,
        checkId: "slow-queries",
        category: "queries",
        severity: q.meanTimeMs >= critical && q.calls >= 100 ? "critical" : "warning",
        title: `Slow query averaging ${formatMs(q.meanTimeMs)}`,
        description:
          `Called ${q.calls.toLocaleString("en-US")} times, ${formatMs(q.totalTimeMs)} in total. ` +
          "Analyze it to see the plan and any missing indexes.",
        target: { kind: "query", name: q.id },
        query: q.query,
        metrics: [
          { label: "Mean", value: q.meanTimeMs, format: "ms" },
          { label: "Max", value: q.maxTimeMs ?? null, format: "ms" },
          { label: "Calls", value: q.calls },
          { label: "Total", value: q.totalTimeMs, format: "ms" },
          { label: "Rows / call", value: q.calls ? q.rows / q.calls : 0 },
        ],
        learnMoreUrl: PGSS_DOCS,
      });
    }
    return { findings, rows };
  },
};

export const highImpactQueries: PgCheck = {
  id: "high-impact-queries",
  category: "queries",
  title: "Queries using the most database time",
  description:
    "Queries that account for a large share of all execution time. Even fast queries add up when they run constantly.",
  unavailableReason: needsQueryStats,
  async run({ runner, env, settings }) {
    const rows = await runner.query(topQueriesSql(env, "total", 25));
    const findings: Finding[] = [];
    for (const row of rows) {
      const q = toQueryStat(row);
      const pct = q.percentOfTotal ?? 0;
      // Ignore tiny workloads where percentages are meaningless.
      if (pct < 20 || q.totalTimeMs < 60_000 || q.calls < settings.minCalls) continue;
      findings.push({
        key: `high-impact-queries:${q.id}`,
        checkId: "high-impact-queries",
        category: "queries",
        severity: pct >= 50 ? "warning" : "info",
        title: `Query using ${formatPercent(pct, 0)} of all database time`,
        description:
          `This query has run ${q.calls.toLocaleString("en-US")} times for ${formatMs(q.totalTimeMs)} in total. ` +
          "Speeding it up, calling it less often or caching its result has the biggest payoff.",
        target: { kind: "query", name: q.id },
        query: q.query,
        metrics: [
          { label: "Share of time", value: pct, format: "percent" },
          { label: "Total", value: q.totalTimeMs, format: "ms" },
          { label: "Calls", value: q.calls },
          { label: "Mean", value: q.meanTimeMs, format: "ms" },
        ],
        learnMoreUrl: PGSS_DOCS,
      });
    }
    return { findings, rows };
  },
};

export const tempSpillQueries: PgCheck = {
  id: "temp-spill-queries",
  category: "queries",
  title: "Queries spilling to disk",
  description:
    "Queries that write temporary files because sorts or hashes don't fit in work_mem.",
  unavailableReason: needsQueryStats,
  async run({ runner, env, settings }) {
    const rows = await runner.query(topQueriesSql(env, "temp", 50));
    const findings: Finding[] = [];
    for (const row of rows) {
      const q = toQueryStat(row);
      const tempBytes = (q.tempBlocksWritten ?? 0) * BLOCK_SIZE;
      const perCall = q.calls ? tempBytes / q.calls : 0;
      if (perCall < 1024 * 1024 || q.calls < Math.min(settings.minCalls, 2)) continue;
      const suggestedMb = Math.min(1024, Math.max(16, Math.ceil((perCall * 2) / (1024 * 1024))));
      findings.push({
        key: `temp-spill-queries:${q.id}`,
        checkId: "temp-spill-queries",
        category: "queries",
        severity: perCall >= 64 * 1024 * 1024 ? "warning" : "info",
        title: `Query spills ${formatBytes(perCall)} to disk on every call`,
        description:
          "Sorting or hashing this query's rows doesn't fit in work_mem, so PostgreSQL spills to disk. " +
          "An index that returns rows already sorted, fewer rows, or more work_mem for this query avoids it.",
        target: { kind: "query", name: q.id },
        query: q.query,
        metrics: [
          { label: "Temp / call", value: perCall, format: "bytes" },
          { label: "Temp total", value: tempBytes, format: "bytes" },
          { label: "Calls", value: q.calls },
          { label: "Mean", value: q.meanTimeMs, format: "ms" },
        ],
        fix: {
          title: "Raise work_mem",
          sql:
            `-- Applies only to the current transaction. Raising work_mem globally multiplies\n` +
            `-- across every sort and hash in every connection, so prefer this or a per-role setting.\n` +
            `BEGIN;\nSET LOCAL work_mem = '${suggestedMb}MB';\n-- run the query here\nCOMMIT;`,
          safety: "safe",
        },
        learnMoreUrl: "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-WORK-MEM",
      });
    }
    return { findings, rows };
  },
};

export const diskReadQueries: PgCheck = {
  id: "disk-read-queries",
  category: "queries",
  title: "Queries reading from disk",
  description:
    "Queries that read a lot of data that wasn't in shared buffers. Often a sign of a missing index or too little memory.",
  unavailableReason: needsQueryStats,
  async run({ runner, env, settings }) {
    const rows = await runner.query(topQueriesSql(env, "io", 25));
    const findings: Finding[] = [];
    for (const row of rows) {
      const q = toQueryStat(row);
      const readBytes = (q.blocksRead ?? 0) * BLOCK_SIZE;
      if (q.cacheHitRatio === null || q.cacheHitRatio === undefined) continue;
      if (q.cacheHitRatio >= 0.95 || readBytes < 1024 ** 3 || q.calls < settings.minCalls) continue;
      findings.push({
        key: `disk-read-queries:${q.id}`,
        checkId: "disk-read-queries",
        category: "queries",
        severity: "info",
        title: `Query reads mostly from disk (${formatPercent(q.cacheHitRatio * 100, 0)} cache hits)`,
        description:
          "This query reads a lot of data from disk (or the OS cache). If it should touch only a few rows, " +
          "an index is probably missing. Otherwise the working set may not fit in shared_buffers.",
        target: { kind: "query", name: q.id },
        query: q.query,
        metrics: [
          { label: "Read from disk", value: readBytes, format: "bytes" },
          { label: "Cache hit", value: q.cacheHitRatio * 100, format: "percent" },
          { label: "I/O time", value: q.ioTimeMs ?? null, format: "ms" },
          { label: "Calls", value: q.calls },
        ],
      });
    }
    return { findings, rows };
  },
};

export function activitySql(): string {
  return `
    SELECT /* ${SELF_MARKER} */
      pid,
      usename AS username,
      application_name,
      state,
      wait_event_type,
      wait_event,
      EXTRACT(EPOCH FROM now() - query_start)::float8 AS duration_s,
      EXTRACT(EPOCH FROM now() - xact_start)::float8 AS xact_duration_s,
      EXTRACT(EPOCH FROM now() - state_change)::float8 AS state_duration_s,
      array_to_string(pg_blocking_pids(pid), ',') AS blocked_by,
      query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND backend_type = 'client backend'
    ORDER BY query_start NULLS LAST`;
}

export const longRunningQueries: PgCheck = {
  id: "long-running-queries",
  category: "queries",
  title: "Long-running queries",
  description: "Queries that are running right now and have been for longer than the threshold.",
  async run({ runner, settings }) {
    const rows = (await runner.query(activitySql())).filter(
      (r) => r.state === "active" && toNumber(r.duration_s) >= settings.longRunningQueryS,
    );
    const findings: Finding[] = rows.map((r: Row) => {
      const seconds = toNumber(r.duration_s);
      return {
        key: `long-running-queries:${r.pid}`,
        checkId: "long-running-queries",
        category: "queries",
        severity: seconds >= settings.longRunningQueryS * 10 ? "critical" : "warning",
        title: `Query running for ${formatMs(seconds * 1000)} (pid ${r.pid})`,
        description:
          `Started by ${r.username ?? "unknown"}${r.application_name ? ` from ${r.application_name}` : ""}. ` +
          (r.wait_event ? `Currently waiting on ${r.wait_event_type}: ${r.wait_event}. ` : "") +
          "Long queries hold locks and stop vacuum from cleaning up rows changed since they started.",
        target: { kind: "session", name: String(r.pid) },
        query: String(r.query ?? ""),
        metrics: [
          { label: "Running for", value: seconds, format: "duration-s" },
          { label: "User", value: String(r.username ?? ""), format: "text" },
          { label: "Waiting on", value: r.wait_event ? String(r.wait_event) : "—", format: "text" },
        ],
        fix: {
          title: "Cancel query",
          sql: `-- Cancels the running statement; the session stays connected.\nSELECT pg_cancel_backend(${toNumber(r.pid)});`,
          safety: "caution",
        },
      };
    });
    return { findings, rows };
  },
};

export const queryChecks: PgCheck[] = [
  slowQueries,
  highImpactQueries,
  tempSpillQueries,
  diskReadQueries,
  longRunningQueries,
];
