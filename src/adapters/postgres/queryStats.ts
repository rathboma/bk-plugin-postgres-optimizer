import type { QueryRunner, QuerySort, QueryStat, QueryStatsResult, Row } from "@/core/types";
import { toNullableNumber, toNumber } from "@/core/format";
import type { PostgresEnvironment } from "./environment";
import { quoteIdent, SELF_MARKER } from "./sql";

export { SELF_MARKER };

/**
 * Column names in pg_stat_statements depend on the extension version, not the
 * server version (an old extension can stay installed after an upgrade), so
 * build expressions from the columns that actually exist.
 */
export function pgssExpressions(columns: string[]) {
  const has = (c: string) => columns.includes(c);
  const first = (...names: string[]) => names.find(has);

  const exec = first("total_exec_time", "total_time") ?? "0";
  const totalTime = has("total_plan_time") ? `(s.${exec} + s.total_plan_time)` : `s.${exec}`;
  const mean = first("mean_exec_time", "mean_time");
  const max = first("max_exec_time", "max_time");
  const stddev = first("stddev_exec_time", "stddev_time");
  const readTime = first("shared_blk_read_time", "blk_read_time");
  const writeTime = first("shared_blk_write_time", "blk_write_time");
  const jit = ["jit_generation_time", "jit_inlining_time", "jit_optimization_time", "jit_emission_time"].filter(has);

  return {
    totalTime,
    meanTime: mean ? `s.${mean}` : `(${totalTime} / NULLIF(s.calls, 0))`,
    maxTime: max ? `s.${max}` : "NULL::float8",
    stddevTime: stddev ? `s.${stddev}` : "NULL::float8",
    ioTime:
      readTime || writeTime
        ? [readTime, writeTime].filter(Boolean).map((c) => `s.${c}`).join(" + ")
        : "NULL::float8",
    jitTime: jit.length ? jit.map((c) => `s.${c}`).join(" + ") : null,
    toplevel: has("toplevel") ? "AND s.toplevel" : "",
    queryId: has("queryid") ? "s.queryid::text" : "md5(s.query)",
  };
}

const SORT_COLUMNS: Record<QuerySort, string> = {
  total: "total_time_ms",
  mean: "mean_time_ms",
  calls: "calls",
  io: "shared_blks_read",
  temp: "temp_blks_written",
};

export function topQueriesSql(env: PostgresEnvironment, sort: QuerySort, limit: number): string {
  const e = pgssExpressions(env.pgss.columns);
  const view = `${quoteIdent(env.pgss.schema ?? "public")}.pg_stat_statements`;
  return `
    WITH /* ${SELF_MARKER} */ stats AS (
      SELECT
        ${e.queryId} AS query_id,
        r.rolname AS username,
        s.query,
        s.calls,
        s.rows,
        ${e.totalTime} AS total_time_ms,
        ${e.meanTime} AS mean_time_ms,
        ${e.maxTime} AS max_time_ms,
        ${e.stddevTime} AS stddev_time_ms,
        s.shared_blks_hit,
        s.shared_blks_read,
        s.temp_blks_written,
        ${e.ioTime} AS io_time_ms,
        ${e.jitTime ?? "NULL::float8"} AS jit_time_ms
      FROM ${view} s
      JOIN pg_database d ON d.oid = s.dbid AND d.datname = current_database()
      LEFT JOIN pg_roles r ON r.oid = s.userid
      WHERE s.calls > 0 ${e.toplevel}
    ),
    filtered AS (
      SELECT * FROM stats
      WHERE query NOT LIKE '%${SELF_MARKER}%'
        AND query NOT IN ('<insufficient privilege>', 'BEGIN', 'COMMIT', 'ROLLBACK')
    )
    SELECT *,
      100.0 * total_time_ms / NULLIF(SUM(total_time_ms) OVER (), 0) AS percent_of_total
    FROM filtered
    ORDER BY ${SORT_COLUMNS[sort]} DESC NULLS LAST
    LIMIT ${Math.max(1, Math.floor(limit))}`;
}

export function toQueryStat(r: Row): QueryStat {
  const hit = toNumber(r.shared_blks_hit);
  const read = toNumber(r.shared_blks_read);
  return {
    id: String(r.query_id ?? ""),
    query: String(r.query ?? ""),
    user: r.username ? String(r.username) : undefined,
    calls: toNumber(r.calls),
    rows: toNumber(r.rows),
    totalTimeMs: toNumber(r.total_time_ms),
    meanTimeMs: toNumber(r.mean_time_ms),
    maxTimeMs: toNullableNumber(r.max_time_ms) ?? undefined,
    stddevTimeMs: toNullableNumber(r.stddev_time_ms) ?? undefined,
    percentOfTotal: toNullableNumber(r.percent_of_total) ?? undefined,
    cacheHitRatio: hit + read > 0 ? hit / (hit + read) : null,
    blocksRead: read,
    tempBlocksWritten: toNumber(r.temp_blks_written),
    ioTimeMs: toNullableNumber(r.io_time_ms) ?? undefined,
  };
}

export async function topQueries(
  runner: QueryRunner,
  env: PostgresEnvironment,
  opts: { sort: QuerySort; limit: number },
): Promise<QueryStatsResult> {
  if (!env.pgss.readable) {
    return {
      available: false,
      reason: env.pgss.installed
        ? "pg_stat_statements is installed but can't be read."
        : "pg_stat_statements is not enabled.",
      queries: [],
    };
  }
  const rows = await runner.query(topQueriesSql(env, opts.sort, opts.limit));
  return { available: true, queries: rows.map(toQueryStat) };
}
