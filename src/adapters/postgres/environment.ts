import type { BaseEnvironment, Metric, Notice, QueryRunner } from "@/core/types";
import { errorMessage, toBool, toNumber } from "@/core/format";
import { quoteIdent, quoteLiteral, tagged } from "./sql";

export interface PgSetting {
  name: string;
  setting: string;
  unit: string | null;
  vartype: string;
  context: string;
  source: string;
  bootVal: string | null;
}

export interface ExtensionState {
  installed: boolean;
  available: boolean;
  schema?: string;
  version?: string;
}

export interface PostgresEnvironment extends BaseEnvironment {
  isSuperuser: boolean;
  /** Can see other roles' queries in pg_stat_activity / pg_stat_statements. */
  canReadAllStats: boolean;
  isReplica: boolean;
  statsReset: string | null;
  startedAt: string | null;
  pgss: ExtensionState & {
    /** The view can actually be queried (library loaded, privileges OK). */
    readable: boolean;
    /** Column names of the pg_stat_statements view. */
    columns: string[];
    error?: string;
  };
  hypopg: ExtensionState;
  /** Selected server settings, keyed by name. */
  settings: Record<string, PgSetting>;
}

/** Settings read once up front and shared by the checks. */
export const TRACKED_SETTINGS = [
  "shared_buffers",
  "effective_cache_size",
  "work_mem",
  "maintenance_work_mem",
  "random_page_cost",
  "effective_io_concurrency",
  "max_connections",
  "superuser_reserved_connections",
  "checkpoint_completion_target",
  "max_wal_size",
  "default_statistics_target",
  "autovacuum",
  "autovacuum_freeze_max_age",
  "autovacuum_vacuum_scale_factor",
  "autovacuum_analyze_scale_factor",
  "track_io_timing",
  "track_counts",
  "track_activity_query_size",
  "log_min_duration_statement",
  "idle_in_transaction_session_timeout",
  "statement_timeout",
  "jit",
  "shared_preload_libraries",
  "pg_stat_statements.track",
  "pg_stat_statements.max",
  "server_version_num",
];

export function setting(env: PostgresEnvironment, name: string): PgSetting | undefined {
  return env.settings[name];
}

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  kB: 1024,
  "8kB": 8192,
  "16kB": 16384,
  "32kB": 32768,
  "64kB": 65536,
  MB: 1024 ** 2,
  "16MB": 16 * 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

/** Convert a memory setting (value + pg_settings unit) to bytes. */
export function settingBytes(s: PgSetting | undefined): number | null {
  if (!s) return null;
  const n = Number(s.setting);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!s.unit) return n;
  const factor = UNIT_BYTES[s.unit];
  return factor ? n * factor : null;
}

export function settingNumber(s: PgSetting | undefined): number | null {
  if (!s) return null;
  const n = Number(s.setting);
  return Number.isFinite(n) ? n : null;
}

/** Was the setting left at its compiled-in default? */
export function isDefault(s: PgSetting | undefined): boolean {
  if (!s) return false;
  return s.source === "default" || (s.bootVal !== null && s.setting === s.bootVal);
}

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

export async function detectEnvironment(
  runner: QueryRunner,
  opts: { readOnly: boolean },
): Promise<PostgresEnvironment> {
  const [info] = await runner.query(tagged(`
    SELECT
      current_setting('server_version_num')::int AS version_num,
      current_setting('server_version') AS version,
      current_database() AS database,
      current_user AS current_user,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
      pg_is_in_recovery() AS is_replica,
      pg_postmaster_start_time() AS started_at,
      (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
  `));

  const versionNum = toNumber(info.version_num);

  // pg_read_all_stats arrived in PostgreSQL 10.
  let canReadAllStats = toBool(info.is_superuser);
  if (!canReadAllStats && versionNum >= 100000) {
    const [r] = await runner.query(
      tagged(`SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS ok`),
    );
    canReadAllStats = toBool(r?.ok);
  }

  const extensions = await runner.query(tagged(`
    SELECT a.name, a.installed_version, n.nspname AS schema
    FROM pg_available_extensions a
    LEFT JOIN pg_extension e ON e.extname = a.name
    LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE a.name IN ('pg_stat_statements', 'hypopg')
  `));
  const ext = (name: string): ExtensionState => {
    const row = extensions.find((r) => r.name === name);
    return {
      available: !!row,
      installed: !!row?.installed_version,
      schema: str(row?.schema),
      version: str(row?.installed_version),
    };
  };

  const settingRows = await runner.query(tagged(`
    SELECT name, setting, unit, vartype, context, source, boot_val
    FROM pg_settings
    WHERE name IN (${TRACKED_SETTINGS.map(quoteLiteral).join(", ")})
  `));
  const settings: Record<string, PgSetting> = {};
  for (const r of settingRows) {
    settings[String(r.name)] = {
      name: String(r.name),
      setting: String(r.setting ?? ""),
      unit: (r.unit as string | null) ?? null,
      vartype: String(r.vartype ?? ""),
      context: String(r.context ?? ""),
      source: String(r.source ?? ""),
      bootVal: (r.boot_val as string | null) ?? null,
    };
  }

  const pgssBase = ext("pg_stat_statements");
  const pgss: PostgresEnvironment["pgss"] = { ...pgssBase, readable: false, columns: [] };
  if (pgss.installed && pgss.schema) {
    try {
      const view = `${quoteIdent(pgss.schema)}.pg_stat_statements`;
      const cols = await runner.query(tagged(`
        SELECT attname FROM pg_attribute
        WHERE attrelid = ${quoteLiteral(view)}::regclass AND attnum > 0 AND NOT attisdropped
      `));
      pgss.columns = cols.map((c) => String(c.attname));
      // Fails when the library is not in shared_preload_libraries.
      await runner.query(tagged(`SELECT 1 FROM ${view} LIMIT 1`));
      pgss.readable = true;
    } catch (e) {
      pgss.error = errorMessage(e);
    }
  }

  const env: PostgresEnvironment = {
    engine: "PostgreSQL",
    databaseName: String(info.database),
    serverVersion: String(info.version),
    versionNum,
    user: String(info.current_user),
    readOnly: opts.readOnly,
    isSuperuser: toBool(info.is_superuser),
    canReadAllStats,
    isReplica: toBool(info.is_replica),
    statsReset: str(info.stats_reset) ?? null,
    startedAt: str(info.started_at) ?? null,
    pgss,
    hypopg: ext("hypopg"),
    settings,
    notices: [],
    capabilities: {},
    facts: [],
  };

  env.capabilities = {
    queryStats: pgss.readable,
    hypotheticalIndexes: env.hypopg.installed,
    genericPlans: versionNum >= 160000,
    // PREPARE + plan_cache_mode, used for generic plans before PostgreSQL 16.
    preparedGenericPlans: versionNum >= 120000 && !opts.readOnly,
  };
  env.notices = buildNotices(env);
  env.facts = buildFacts(env);
  return env;
}

function buildFacts(env: PostgresEnvironment): Metric[] {
  const facts: Metric[] = [
    { label: "Version", value: env.serverVersion.split(" ")[0], format: "text" },
    { label: "Database", value: env.databaseName, format: "text" },
    { label: "User", value: env.user, format: "text" },
  ];
  if (env.startedAt) facts.push({ label: "Server started", value: env.startedAt, format: "datetime" });
  facts.push({ label: "Stats since", value: env.statsReset ?? env.startedAt, format: "datetime" });
  if (env.isReplica) facts.push({ label: "Role", value: "Read replica", format: "text" });
  return facts;
}

/** ALTER SYSTEM statement that adds pg_stat_statements to the preload list. */
function preloadSql(current: string | undefined): string {
  const header =
    "-- Requires a server restart afterwards. On managed services (RDS, Cloud SQL, Azure)\n" +
    "-- set shared_preload_libraries in the parameter group / flags instead.\n";
  if (current === undefined) {
    return (
      header +
      "-- Keep any libraries already listed: check SHOW shared_preload_libraries first.\n" +
      "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';"
    );
  }
  const libs = current.split(",").map((s) => s.trim()).filter(Boolean);
  if (!libs.includes("pg_stat_statements")) libs.push("pg_stat_statements");
  return `${header}ALTER SYSTEM SET shared_preload_libraries = ${quoteLiteral(libs.join(","))};`;
}

const PGSS_DOCS = "https://www.postgresql.org/docs/current/pgstatstatements.html";

function buildNotices(env: PostgresEnvironment): Notice[] {
  const notices: Notice[] = [];
  const preload = env.settings["shared_preload_libraries"]?.setting;
  const preloaded = preload === undefined ? null : preload.split(",").map((s) => s.trim()).includes("pg_stat_statements");

  if (!env.pgss.available) {
    notices.push({
      id: "pgss-not-available",
      severity: "warning",
      title: "pg_stat_statements is not available",
      body:
        "Slow query analysis needs the pg_stat_statements extension, which ships with PostgreSQL " +
        "but is not installed on this server. Install the postgresql-contrib package (or enable it " +
        "in your cloud provider's settings), add it to shared_preload_libraries and restart.",
      learnMoreUrl: PGSS_DOCS,
    });
  } else if (!env.pgss.installed) {
    notices.push({
      id: "pgss-not-installed",
      severity: "warning",
      title: "pg_stat_statements is not enabled in this database",
      body:
        (preloaded === false
          ? "Add pg_stat_statements to shared_preload_libraries and restart the server, then create the extension. "
          : "Create the extension to start collecting query statistics. ") +
        "Statistics are collected from that point on, so check back after the database has handled some traffic.",
      fix: {
        title: "Enable pg_stat_statements",
        sql:
          (preloaded === false
            ? `${preloadSql(preload)}\n\n`
            : "") + "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
        safety: preloaded === false ? "caution" : "safe",
      },
      learnMoreUrl: PGSS_DOCS,
    });
  } else if (!env.pgss.readable) {
    const notLoaded = /shared_preload_libraries/i.test(env.pgss.error ?? "");
    notices.push({
      id: "pgss-not-readable",
      severity: "warning",
      title: notLoaded ? "pg_stat_statements is installed but not loaded" : "pg_stat_statements can't be read",
      body: notLoaded
        ? "The extension exists but the server was not started with it in shared_preload_libraries. Add it and restart the server."
        : `Reading pg_stat_statements failed: ${env.pgss.error ?? "unknown error"}`,
      fix: notLoaded
        ? {
            title: "Load pg_stat_statements at startup",
            sql: preloadSql(preload),
            safety: "caution",
          }
        : undefined,
      learnMoreUrl: PGSS_DOCS,
    });
  }

  if (env.pgss.readable && !env.canReadAllStats) {
    notices.push({
      id: "pgss-own-queries-only",
      severity: "info",
      title: "Only your own queries are visible",
      body:
        `${env.user} can't see the text of queries run by other roles. Grant pg_read_all_stats ` +
        "(or pg_monitor) to see every query.",
      fix: {
        title: "Grant read access to statistics",
        sql: `GRANT pg_read_all_stats TO ${quoteIdent(env.user)};`,
        safety: "safe",
      },
    });
  }

  if (env.hypopg.available && !env.hypopg.installed && !env.readOnly) {
    notices.push({
      id: "hypopg-available",
      severity: "info",
      title: "Enable hypopg to test index suggestions",
      body:
        "hypopg lets the optimizer check whether a suggested index would actually be used, " +
        "without building it. Hypothetical indexes only exist in the optimizer's session.",
      fix: { title: "Enable hypopg", sql: "CREATE EXTENSION IF NOT EXISTS hypopg;", safety: "safe" },
      learnMoreUrl: "https://hypopg.readthedocs.io/",
    });
  }

  if (env.isReplica) {
    notices.push({
      id: "replica",
      severity: "info",
      title: "Connected to a read replica",
      body:
        "Index usage and table statistics on a replica only reflect queries run on the replica. " +
        "Don't drop an index as unused without checking the primary too.",
    });
  }

  if (env.versionNum < 120000) {
    notices.push({
      id: "old-version",
      severity: "warning",
      title: `PostgreSQL ${env.serverVersion} is no longer supported`,
      body:
        "This version no longer receives security or bug fixes, and some checks need PostgreSQL 12 or newer. " +
        "Upgrading also brings significant planner and vacuum improvements.",
      learnMoreUrl: "https://www.postgresql.org/support/versioning/",
    });
  }
  return notices;
}
