import type { Check, Finding, QueryRunner, Row } from "@/core/types";
import { formatBytes, formatNumber, formatPercent, toNumber } from "@/core/format";
import type { PostgresEnvironment } from "../environment";
import { findRedundantIndexes, loadIndexes, type IndexInfo } from "../indexCatalog";
import { SELF_MARKER, topQueriesSql, toQueryStat } from "../queryStats";
import { indexName, qualifiedName, quoteIdent } from "../sql";
import { toStringArray } from "../rows";

type PgCheck = Check<PostgresEnvironment>;

const MB = 1024 * 1024;

export const unindexedForeignKeys: PgCheck = {
  id: "unindexed-foreign-keys",
  category: "indexes",
  title: "Foreign keys without an index",
  description:
    "Foreign key columns with no index. Joins on them and deletes or updates of the referenced rows have to scan the whole table.",
  async run({ runner, env, settings }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        n.nspname AS schema,
        t.relname AS table_name,
        c.conname AS constraint_name,
        rn.nspname AS ref_schema,
        rt.relname AS ref_table,
        ARRAY(
          SELECT a.attname
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord
        ) AS columns,
        GREATEST(t.reltuples, 0)::float8 AS estimated_rows,
        pg_relation_size(t.oid) AS table_bytes,
        c.confdeltype::text AS on_delete
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class rt ON rt.oid = c.confrelid
      JOIN pg_namespace rn ON rn.oid = rt.relnamespace
      WHERE c.contype = 'f'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        ${env.versionNum >= 110000 ? "AND c.conparentid = 0" : ""}
        AND NOT EXISTS (
          SELECT 1
          FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND i.indpred IS NULL
            AND i.indisvalid
            AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
            AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey
        )
      ORDER BY t.reltuples DESC, n.nspname, t.relname`);

    const findings: Finding[] = rows.map((r) => {
      const columns = toStringArray(r.columns);
      const table = qualifiedName(String(r.schema), String(r.table_name));
      const refTable = qualifiedName(String(r.ref_schema), String(r.ref_table));
      const estRows = toNumber(r.estimated_rows);
      const cascades = r.on_delete === "c" || r.on_delete === "n" || r.on_delete === "d";
      const name = indexName(String(r.table_name), columns);
      return {
        key: `unindexed-foreign-keys:${r.schema}.${r.table_name}.${r.constraint_name}`,
        checkId: "unindexed-foreign-keys",
        category: "indexes",
        severity: estRows >= settings.largeTableRows ? "warning" : "info",
        title: `${table}(${columns.join(", ")}) references ${refTable} but has no index`,
        description:
          `Joining ${table} to ${refTable}, and every delete or key update on ${refTable}, ` +
          `has to scan ${table} to find matching rows` +
          (cascades ? " (the constraint also cascades, making deletes on the parent slower)." : ".") +
          (estRows < settings.largeTableRows ? " The table is small today, so this matters more as it grows." : ""),
        target: { kind: "constraint", schema: String(r.schema), name: String(r.constraint_name), table: String(r.table_name) },
        metrics: [
          { label: "Rows", value: estRows },
          { label: "Table size", value: toNumber(r.table_bytes), format: "bytes" },
        ],
        fix: {
          title: "Create the index",
          sql:
            `-- CONCURRENTLY builds without blocking writes; it can't run inside a transaction.\n` +
            `CREATE INDEX CONCURRENTLY ${quoteIdent(name)}\n  ON ${table} (${columns.map(quoteIdent).join(", ")});`,
          safety: "safe",
        },
        learnMoreUrl: "https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK",
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

/** Map lowercase table name → most expensive query mentioning it. */
async function queriesByTable(
  runner: QueryRunner,
  env: PostgresEnvironment,
  tables: string[],
): Promise<Map<string, { query: string; count: number }>> {
  const out = new Map<string, { query: string; count: number }>();
  if (!env.pgss.readable || !tables.length) return out;
  const stats = (await runner.query(topQueriesSql(env, "total", 500))).map(toQueryStat);
  for (const table of tables) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9_$])"?${escaped}"?($|[^a-z0-9_$])`, "i");
    const matches = stats.filter((q) => re.test(q.query));
    if (matches.length) out.set(table.toLowerCase(), { query: matches[0].query, count: matches.length });
  }
  return out;
}

export const seqScanHeavyTables: PgCheck = {
  id: "seq-scan-heavy-tables",
  category: "indexes",
  title: "Large tables read with sequential scans",
  description:
    "Large tables that are often read in full instead of through an index. Usually means queries filter on columns that aren't indexed.",
  async run({ runner, env, settings }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        schemaname AS schema,
        relname AS table_name,
        seq_scan,
        seq_tup_read,
        COALESCE(idx_scan, 0) AS idx_scan,
        n_live_tup,
        pg_relation_size(relid) AS table_bytes
      FROM pg_stat_user_tables
      WHERE n_live_tup >= ${Math.floor(settings.largeTableRows)}
        AND seq_scan >= 25
      ORDER BY seq_tup_read DESC
      LIMIT 50`);

    const flagged = rows.filter((r) => {
      const seq = toNumber(r.seq_scan);
      const idx = toNumber(r.idx_scan);
      return seq / Math.max(1, seq + idx) >= 0.05;
    });
    const related = await queriesByTable(runner, env, flagged.map((r) => String(r.table_name)));

    const findings: Finding[] = flagged.map((r) => {
      const seq = toNumber(r.seq_scan);
      const idx = toNumber(r.idx_scan);
      const live = toNumber(r.n_live_tup);
      const tupRead = toNumber(r.seq_tup_read);
      const seqPct = (100 * seq) / Math.max(1, seq + idx);
      const table = qualifiedName(String(r.schema), String(r.table_name));
      const rel = related.get(String(r.table_name).toLowerCase());
      return {
        key: `seq-scan-heavy-tables:${r.schema}.${r.table_name}`,
        checkId: "seq-scan-heavy-tables",
        category: "indexes",
        severity: tupRead >= 1e9 || (live >= 1e6 && seq >= 100) ? "warning" : "info",
        title: `${table} is read with a full scan ${formatPercent(seqPct, 0)} of the time`,
        description:
          `${formatNumber(seq)} sequential scans have read ${formatNumber(tupRead)} rows from this ` +
          `${formatNumber(live)} row table. ` +
          (rel
            ? `${rel.count} tracked ${rel.count === 1 ? "query mentions" : "queries mention"} it; analyze the most expensive one (attached) to find the missing index.`
            : "Find the queries filtering this table and analyze them to see which columns need an index."),
        target: { kind: "table", schema: String(r.schema), name: String(r.table_name) },
        query: rel?.query,
        metrics: [
          { label: "Seq scans", value: seq },
          { label: "Index scans", value: idx },
          { label: "Rows read by seq scans", value: tupRead },
          { label: "Live rows", value: live },
          { label: "Size", value: toNumber(r.table_bytes), format: "bytes" },
        ],
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

function indexRow(ix: IndexInfo): Row {
  return {
    schema: ix.schema,
    table: ix.table,
    index: ix.name,
    definition: ix.definition,
    size_bytes: ix.sizeBytes,
    scans: ix.scans,
    valid: ix.valid,
  };
}

function statsAgeDays(env: PostgresEnvironment): number | null {
  const since = env.statsReset ?? env.startedAt;
  if (!since) return null;
  const t = new Date(since).getTime();
  return Number.isNaN(t) ? null : (Date.now() - t) / 86_400_000;
}

export const unusedIndexes: PgCheck = {
  id: "unused-indexes",
  category: "indexes",
  title: "Unused indexes",
  description:
    "Indexes that have never been used to answer a query since statistics were last reset. They slow down every write and take up space.",
  async run({ runner, env, settings }) {
    const indexes = await loadIndexes(runner, env.versionNum);
    const age = statsAgeDays(env);
    const young = age !== null && age < 7;
    const candidates = indexes.filter(
      (ix) =>
        ix.scans === 0 &&
        ix.valid &&
        !ix.unique &&
        !ix.primary &&
        !ix.backsConstraint &&
        ix.sizeBytes >= settings.unusedIndexMinBytes,
    );
    const findings: Finding[] = candidates.map((ix) => ({
      key: `unused-indexes:${ix.schema}.${ix.name}`,
      checkId: "unused-indexes",
      category: "indexes",
      severity: !young && ix.sizeBytes >= 100 * MB ? "warning" : "info",
      title: `${qualifiedName(ix.schema, ix.name)} on ${ix.table} has never been used (${formatBytes(ix.sizeBytes)})`,
      description:
        `No query has used this index${age !== null ? ` in the ${Math.max(1, Math.round(age))} days since statistics were reset` : ""}. ` +
        "It still has to be updated on every insert and update. " +
        (young ? "Statistics are recent, so give it more time before dropping. " : "") +
        (env.isReplica
          ? "This is a replica: check the primary too."
          : "If you have read replicas, make sure they don't use it either."),
      target: { kind: "index", schema: ix.schema, name: ix.name, table: ix.table },
      metrics: [
        { label: "Size", value: ix.sizeBytes, format: "bytes" },
        { label: "Scans", value: ix.scans },
        { label: "Table rows", value: ix.tableRows },
      ],
      fix: {
        title: "Drop the index",
        sql:
          `-- To recreate it later:\n-- ${ix.definition};\n` +
          `DROP INDEX CONCURRENTLY ${qualifiedName(ix.schema, ix.name)};`,
        safety: "destructive",
      },
    }));
    return { findings, rows: candidates.map(indexRow) };
  },
};

export const duplicateIndexes: PgCheck = {
  id: "duplicate-indexes",
  category: "indexes",
  title: "Duplicate and redundant indexes",
  description:
    "Indexes that are identical to, or a leading subset of, another index on the same table. The other index can serve the same queries.",
  async run({ runner, env }) {
    const redundant = findRedundantIndexes(await loadIndexes(runner, env.versionNum));
    const findings: Finding[] = redundant.map(({ index: ix, coveredBy, exactDuplicate }) => ({
      key: `duplicate-indexes:${ix.schema}.${ix.name}`,
      checkId: "duplicate-indexes",
      category: "indexes",
      severity: exactDuplicate || ix.sizeBytes >= 100 * MB ? "warning" : "info",
      title: exactDuplicate
        ? `${qualifiedName(ix.schema, ix.name)} is a duplicate of ${coveredBy.name}`
        : `${qualifiedName(ix.schema, ix.name)} is covered by ${coveredBy.name}`,
      description: exactDuplicate
        ? `Both indexes on ${ix.table} index (${ix.keyColumns.join(", ")}). Keeping one is enough.`
        : `${coveredBy.name} on (${coveredBy.keyColumns.join(", ")}) starts with the same columns as ` +
          `${ix.name} (${ix.keyColumns.join(", ")}), so it can answer the same lookups.`,
      target: { kind: "index", schema: ix.schema, name: ix.name, table: ix.table },
      metrics: [
        { label: "Size", value: ix.sizeBytes, format: "bytes" },
        { label: "Scans", value: ix.scans },
        { label: `${coveredBy.name} scans`, value: coveredBy.scans },
      ],
      fix: {
        title: "Drop the redundant index",
        sql:
          `-- Kept: ${coveredBy.definition};\n-- To recreate the dropped index later:\n-- ${ix.definition};\n` +
          `DROP INDEX CONCURRENTLY ${qualifiedName(ix.schema, ix.name)};`,
        safety: "destructive",
      },
    }));
    return {
      findings,
      rows: redundant.map((r) => ({
        schema: r.index.schema,
        table: r.index.table,
        index: r.index.name,
        columns: r.index.keyColumns.join(", "),
        covered_by: r.coveredBy.name,
        covered_by_columns: r.coveredBy.keyColumns.join(", "),
        size_bytes: r.index.sizeBytes,
      })),
    };
  },
};

export const invalidIndexes: PgCheck = {
  id: "invalid-indexes",
  category: "indexes",
  title: "Invalid indexes",
  description:
    "Indexes left behind by a failed CREATE INDEX CONCURRENTLY. They are never used for queries but still slow down writes.",
  async run({ runner, env }) {
    const building = new Set<string>();
    if (env.versionNum >= 120000) {
      const progress = await runner.query(
        ` SELECT /* ${SELF_MARKER} */ index_relid::regclass::text AS name FROM pg_stat_progress_create_index`,
      );
      progress.forEach((r) => building.add(String(r.name)));
    }
    const indexes = (await loadIndexes(runner, env.versionNum)).filter(
      (ix) => !ix.valid && !building.has(ix.name) && !building.has(`${ix.schema}.${ix.name}`),
    );
    const findings: Finding[] = indexes.map((ix) => {
      const name = qualifiedName(ix.schema, ix.name);
      const rebuild =
        env.versionNum >= 120000
          ? `REINDEX INDEX CONCURRENTLY ${name};`
          : `DROP INDEX CONCURRENTLY ${name};\n${ix.definition.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX CONCURRENTLY ")};`;
      return {
        key: `invalid-indexes:${ix.schema}.${ix.name}`,
        checkId: "invalid-indexes",
        category: "indexes",
        severity: "warning",
        title: `${name} on ${ix.table} is invalid`,
        description:
          "The index build failed or was cancelled. PostgreSQL won't use it for reads but keeps updating it on writes. " +
          (ix.unique ? "It is a unique index, so the build most likely failed because of duplicate values. " : "") +
          "Rebuild it, or drop it if it's no longer needed.",
        target: { kind: "index", schema: ix.schema, name: ix.name, table: ix.table },
        metrics: [{ label: "Size", value: ix.sizeBytes, format: "bytes" }],
        fix: {
          title: "Rebuild the index",
          sql: `-- Or just drop it: DROP INDEX CONCURRENTLY ${name};\n${rebuild}`,
          safety: "caution",
        },
      } satisfies Finding;
    });
    return { findings, rows: indexes.map(indexRow) };
  },
};

export const indexChecks: PgCheck[] = [
  unindexedForeignKeys,
  seqScanHeavyTables,
  unusedIndexes,
  duplicateIndexes,
  invalidIndexes,
];
