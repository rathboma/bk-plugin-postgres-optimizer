import type { Check, Finding } from "@/core/types";
import { formatNumber, formatPercent, toNumber } from "@/core/format";
import type { PostgresEnvironment } from "../environment";
import { settingNumber } from "../environment";
import { SELF_MARKER } from "../queryStats";
import { qualifiedName, quoteIdent, shortName } from "../sql";
import { toStringArray } from "../rows";

type PgCheck = Check<PostgresEnvironment>;

const VACUUM_DOCS = "https://www.postgresql.org/docs/current/routine-vacuuming.html";

const userTables = (alias = "") => `
  ${alias}schemaname NOT IN ('pg_catalog', 'information_schema')
  AND ${alias}schemaname NOT LIKE 'pg_toast%'`;

export const deadTuples: PgCheck = {
  id: "dead-tuples",
  category: "tables",
  title: "Tables with many dead rows",
  description:
    "Tables where deleted and updated rows are piling up faster than autovacuum removes them. Dead rows bloat the table and slow down scans.",
  async run({ runner, settings }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        schemaname AS schema,
        relname AS table_name,
        n_live_tup,
        n_dead_tup,
        last_vacuum,
        last_autovacuum,
        pg_relation_size(relid) AS table_bytes
      FROM pg_stat_user_tables
      WHERE n_dead_tup >= ${Math.floor(settings.deadTupleMin)}
        AND ${userTables()}
      ORDER BY n_dead_tup DESC
      LIMIT 100`);

    const findings: Finding[] = [];
    for (const r of rows) {
      const dead = toNumber(r.n_dead_tup);
      const live = toNumber(r.n_live_tup);
      const ratio = dead / Math.max(1, dead + live);
      if (ratio < settings.deadTupleRatio) continue;
      const table = qualifiedName(String(r.schema), String(r.table_name));
      const lastVacuum = r.last_autovacuum ?? r.last_vacuum;
      findings.push({
        key: `dead-tuples:${r.schema}.${r.table_name}`,
        checkId: "dead-tuples",
        category: "tables",
        severity: ratio >= 0.5 ? "warning" : "info",
        title: `Vacuum ${shortName(String(r.schema), String(r.table_name))} (${formatPercent(ratio * 100, 0)} dead rows)`,
        description:
          `${formatNumber(dead)} dead rows vs ${formatNumber(live)} live rows. ` +
          (lastVacuum ? `Last vacuumed ${new Date(String(lastVacuum)).toLocaleString()}. ` : "It has never been vacuumed. ") +
          "If this keeps happening, make autovacuum more aggressive for this table, and look for long-running transactions that stop vacuum from removing rows.",
        target: { kind: "table", schema: String(r.schema), name: String(r.table_name) },
        metrics: [
          { label: "Dead rows", value: dead },
          { label: "Live rows", value: live },
          { label: "Last vacuum", value: lastVacuum ? String(lastVacuum) : null, format: "datetime" },
        ],
        fix: {
          title: "Vacuum table",
          sql:
            `VACUUM (ANALYZE, VERBOSE) ${table};\n\n` +
            `-- To have autovacuum keep up on its own, vacuum after 5% of rows change instead of 20%:\n` +
            `-- ALTER TABLE ${table} SET (autovacuum_vacuum_scale_factor = 0.05);`,
          safety: "safe",
        },
        learnMoreUrl: VACUUM_DOCS,
      });
    }
    return { findings, rows };
  },
};

export const staleStatistics: PgCheck = {
  id: "stale-statistics",
  category: "tables",
  title: "Missing or stale planner statistics",
  description:
    "Tables that have never been analyzed, or have changed a lot since. The planner relies on these statistics to pick indexes and join orders.",
  async run({ runner, settings }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        schemaname AS schema,
        relname AS table_name,
        n_live_tup,
        n_mod_since_analyze,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      WHERE n_live_tup >= 1000
        AND ${userTables()}
      ORDER BY n_mod_since_analyze DESC NULLS LAST
      LIMIT 200`);

    const findings: Finding[] = [];
    for (const r of rows) {
      const live = toNumber(r.n_live_tup);
      const modified = toNumber(r.n_mod_since_analyze);
      const lastAnalyze = r.last_autoanalyze ?? r.last_analyze;
      const never = !r.last_analyze && !r.last_autoanalyze;
      const stale = modified >= Math.max(10_000, live * 0.5);
      if (!never && !stale) continue;
      const table = qualifiedName(String(r.schema), String(r.table_name));
      findings.push({
        key: `stale-statistics:${r.schema}.${r.table_name}`,
        checkId: "stale-statistics",
        category: "tables",
        severity: live >= settings.largeTableRows ? "warning" : "info",
        title: `Analyze ${shortName(String(r.schema), String(r.table_name))} (${never ? "never analyzed" : "statistics are stale"})`,
        description: never
          ? `The planner has no statistics for this ${formatNumber(live)} row table and has to guess how many rows each filter matches, which often leads to bad plans.`
          : `${formatNumber(modified)} rows have changed since statistics were collected on ${new Date(String(lastAnalyze)).toLocaleString()}.`,
        target: { kind: "table", schema: String(r.schema), name: String(r.table_name) },
        metrics: [
          { label: "Live rows", value: live },
          { label: "Changed since analyze", value: modified },
          { label: "Last analyze", value: lastAnalyze ? String(lastAnalyze) : null, format: "datetime" },
        ],
        fix: { title: "Analyze table", sql: `ANALYZE VERBOSE ${table};`, safety: "safe" },
        learnMoreUrl: "https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-STATISTICS",
      });
    }
    return { findings, rows };
  },
};

const MAX_XID_AGE = 2_147_483_647;

export const transactionIdWraparound: PgCheck = {
  id: "xid-wraparound",
  category: "tables",
  title: "Transaction ID wraparound risk",
  description:
    "Tables whose oldest unfrozen row is getting close to the transaction ID limit. If it is reached, PostgreSQL stops accepting writes until the table is vacuumed.",
  async run({ runner, env }) {
    const freezeMaxAge = settingNumber(env.settings["autovacuum_freeze_max_age"]) ?? 200_000_000;
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        n.nspname AS schema,
        c.relname AS table_name,
        GREATEST(age(c.relfrozenxid), COALESCE(age(t.relfrozenxid), 0))::bigint AS xid_age,
        pg_total_relation_size(c.oid) AS total_bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
      WHERE c.relkind IN ('r', 'm')
        AND GREATEST(age(c.relfrozenxid), COALESCE(age(t.relfrozenxid), 0)) > ${Math.floor(freezeMaxAge * 0.75)}
      ORDER BY 3 DESC
      LIMIT 50`);

    const findings: Finding[] = rows.map((r) => {
      const age = toNumber(r.xid_age);
      const left = MAX_XID_AGE - age;
      const table = qualifiedName(String(r.schema), String(r.table_name));
      return {
        key: `xid-wraparound:${r.schema}.${r.table_name}`,
        checkId: "xid-wraparound",
        category: "tables",
        severity: left < 100_000_000 ? "critical" : age > freezeMaxAge ? "warning" : "info",
        title: `Freeze ${shortName(String(r.schema), String(r.table_name))} before transaction IDs run out`,
        description:
          `About ${formatNumber(left)} transactions remain before wraparound protection forces the database read-only. ` +
          (age > freezeMaxAge
            ? "Autovacuum should already be running an aggressive vacuum on it; check that nothing (long transactions, abandoned replication slots or prepared transactions) is blocking it."
            : "Autovacuum will start an aggressive vacuum at autovacuum_freeze_max_age; freezing it now during a quiet period avoids that happening at a bad time."),
        target: { kind: "table", schema: String(r.schema), name: String(r.table_name) },
        metrics: [
          { label: "XID age", value: age },
          { label: "Remaining", value: left },
          { label: "Freeze max age", value: freezeMaxAge },
          { label: "Size", value: toNumber(r.total_bytes), format: "bytes" },
        ],
        fix: { title: "Freeze table", sql: `VACUUM (FREEZE, VERBOSE) ${table};`, safety: "safe" },
        learnMoreUrl: `${VACUUM_DOCS}#VACUUM-FOR-WRAPAROUND`,
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const sequenceExhaustion: PgCheck = {
  id: "sequence-exhaustion",
  category: "tables",
  title: "Sequences running out of values",
  description:
    "Sequences (serial and identity columns) that have used a large share of their range, or of the column type they feed. Inserts fail once they run out.",
  unavailableReason: (env) => (env.versionNum < 100000 ? "Needs PostgreSQL 10 or newer." : null),
  async run({ runner }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        s.schemaname AS schema,
        s.sequencename AS sequence_name,
        s.last_value,
        s.max_value AS sequence_max,
        s.increment_by,
        t.relname AS table_name,
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS column_type,
        CASE a.atttypid
          WHEN 'int2'::regtype THEN 32767
          WHEN 'int4'::regtype THEN 2147483647
          ELSE NULL
        END AS column_max
      FROM pg_sequences s
      JOIN pg_namespace sn ON sn.nspname = s.schemaname
      JOIN pg_class sc ON sc.relname = s.sequencename AND sc.relnamespace = sn.oid
      LEFT JOIN pg_depend d ON d.objid = sc.oid
        AND d.classid = 'pg_class'::regclass
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype IN ('a', 'i')
      LEFT JOIN pg_class t ON t.oid = d.refobjid
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE s.last_value IS NOT NULL AND s.increment_by > 0`);

    const findings: Finding[] = [];
    for (const r of rows) {
      const last = toNumber(r.last_value);
      const seqMax = toNumber(r.sequence_max);
      const colMax = r.column_max === null || r.column_max === undefined ? null : toNumber(r.column_max);
      const limit = colMax !== null ? Math.min(colMax, seqMax) : seqMax;
      const used = last / limit;
      if (used < 0.5) continue;
      const seqName = qualifiedName(String(r.schema), String(r.sequence_name));
      const table = r.table_name ? qualifiedName(String(r.schema), String(r.table_name)) : null;
      // An int2/int4 column caps the sequence even if the sequence itself is bigint.
      const smallColumn = colMax !== null && table !== null;
      const smallSequence = seqMax <= 2_147_483_647;
      let fix: Finding["fix"];
      if (smallColumn) {
        fix = {
          title: "Change to bigint",
          sql:
            `-- Rewrites the whole table under an ACCESS EXCLUSIVE lock. On large tables, consider\n` +
            `-- adding a new bigint column, backfilling it in batches and swapping it in instead.\n` +
            `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(String(r.column_name))} TYPE bigint;\n` +
            (smallSequence ? `ALTER SEQUENCE ${seqName} AS bigint;` : ""),
          safety: "caution",
        };
      } else if (smallSequence) {
        fix = {
          title: "Widen sequence",
          sql: `ALTER SEQUENCE ${seqName} AS bigint;`,
          safety: "safe",
        };
      }
      findings.push({
        key: `sequence-exhaustion:${r.schema}.${r.sequence_name}`,
        checkId: "sequence-exhaustion",
        category: "tables",
        severity: used >= 0.85 ? "critical" : used >= 0.7 ? "warning" : "info",
        title: `Sequence ${shortName(String(r.schema), String(r.sequence_name))} is ${formatPercent(used * 100, 0)} used up`,
        description: smallColumn
          ? `It feeds ${table}.${r.column_name}, ${/^[aeiou]/i.test(String(r.column_type)) ? "an" : "a"} ${r.column_type} column that tops out at ${formatNumber(colMax)}. ` +
            "Inserts will fail once it gets there. Changing the column to bigint rewrites the table and locks it, so plan ahead."
          : `The sequence stops at ${formatNumber(seqMax)}; nextval() fails after that.`,
        target: { kind: "sequence", schema: String(r.schema), name: String(r.sequence_name) },
        metrics: [
          { label: "Last value", value: last },
          { label: "Limit", value: limit },
          { label: "Used", value: used * 100, format: "percent" },
        ],
        fix,
      });
    }
    return { findings, rows };
  },
};

export const tablesWithoutPrimaryKey: PgCheck = {
  id: "tables-without-primary-key",
  category: "tables",
  title: "Tables without a primary key",
  description:
    "Tables with no primary key. Rows can't be reliably identified, which breaks logical replication of updates and deletes and makes duplicates easy to create.",
  async run({ runner }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */ n.nspname AS schema, c.relname AS table_name, GREATEST(c.reltuples, 0)::float8 AS estimated_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'e'
        )
      ORDER BY c.reltuples DESC
      LIMIT 100`);
    const findings: Finding[] = rows.map((r) => {
      const table = qualifiedName(String(r.schema), String(r.table_name));
      return {
        key: `tables-without-primary-key:${r.schema}.${r.table_name}`,
        checkId: "tables-without-primary-key",
        category: "tables",
        severity: "info",
        title: `${shortName(String(r.schema), String(r.table_name))} has no primary key`,
        description:
          "Add a primary key on the column(s) that uniquely identify a row, or an identity column if there is none.",
        target: { kind: "table", schema: String(r.schema), name: String(r.table_name) },
        metrics: [{ label: "Rows", value: toNumber(r.estimated_rows) }],
        fix: {
          title: "Add primary key",
          sql:
            `-- Adding a column with an identity rewrites the table under an exclusive lock.\n` +
            `ALTER TABLE ${table} ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;`,
          safety: "caution",
        },
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const invalidConstraints: PgCheck = {
  id: "invalid-constraints",
  category: "tables",
  title: "Constraints that were never validated",
  description:
    "Constraints added with NOT VALID that were never validated. Existing rows may break them, and the planner can't rely on them.",
  async run({ runner }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */ n.nspname AS schema, t.relname AS table_name, c.conname AS constraint_name, c.contype::text AS type
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE NOT c.convalidated
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`);
    const findings: Finding[] = rows.map((r) => {
      const table = qualifiedName(String(r.schema), String(r.table_name));
      return {
        key: `invalid-constraints:${r.schema}.${r.table_name}.${r.constraint_name}`,
        checkId: "invalid-constraints",
        category: "tables",
        severity: "info",
        title: `Validate constraint ${r.constraint_name} on ${shortName(String(r.schema), String(r.table_name))}`,
        description:
          "New rows are checked, but existing rows never were. Validating takes a lighter lock than adding the constraint did, so it is safe to run on a live table.",
        target: { kind: "constraint", schema: String(r.schema), name: String(r.constraint_name), table: String(r.table_name) },
        fix: {
          title: "Validate",
          sql: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${quoteIdent(String(r.constraint_name))};`,
          safety: "safe",
        },
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const autovacuumDisabled: PgCheck = {
  id: "autovacuum-disabled",
  category: "tables",
  title: "Autovacuum turned off",
  description: "Autovacuum disabled for the whole server or for individual tables.",
  async run({ runner, env }) {
    const findings: Finding[] = [];
    if (env.settings["autovacuum"]?.setting === "off") {
      findings.push({
        key: "autovacuum-disabled:server",
        checkId: "autovacuum-disabled",
        category: "tables",
        severity: "critical",
        title: "Autovacuum is off for the whole server",
        description:
          "Without autovacuum, dead rows are never cleaned up, statistics go stale and the database will eventually stop accepting writes to prevent transaction ID wraparound.",
        target: { kind: "setting", name: "autovacuum" },
        fix: {
          title: "Turn on autovacuum",
          sql: "ALTER SYSTEM SET autovacuum = on;\nSELECT pg_reload_conf();",
          safety: "safe",
        },
        learnMoreUrl: `${VACUUM_DOCS}#AUTOVACUUM`,
      });
    }
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */ n.nspname AS schema, c.relname AS table_name, c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'm')
        AND c.reloptions IS NOT NULL
        AND 'autovacuum_enabled=false' = ANY (c.reloptions)
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`);
    for (const r of rows) {
      const table = qualifiedName(String(r.schema), String(r.table_name));
      findings.push({
        key: `autovacuum-disabled:${r.schema}.${r.table_name}`,
        checkId: "autovacuum-disabled",
        category: "tables",
        severity: "warning",
        title: `Autovacuum is off for ${shortName(String(r.schema), String(r.table_name))}`,
        description:
          "Dead rows in this table are only removed by manual VACUUM. Anti-wraparound vacuums still run, but bloat and stale statistics are likely.",
        target: { kind: "table", schema: String(r.schema), name: String(r.table_name) },
        metrics: [{ label: "Options", value: toStringArray(r.reloptions).join(", "), format: "text" }],
        fix: {
          title: "Turn on autovacuum",
          sql: `ALTER TABLE ${table} RESET (autovacuum_enabled);`,
          safety: "safe",
        },
      });
    }
    return { findings, rows };
  },
};

export const tableChecks: PgCheck[] = [
  deadTuples,
  staleStatistics,
  transactionIdWraparound,
  sequenceExhaustion,
  autovacuumDisabled,
  invalidConstraints,
  tablesWithoutPrimaryKey,
];
