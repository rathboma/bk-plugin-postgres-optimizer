import type { Check, Finding, Fix, Metric } from "@/core/types";
import { formatBytes, formatPercent, toNumber } from "@/core/format";
import type { PgSetting, PostgresEnvironment } from "../environment";
import { isDefault, settingBytes, settingNumber } from "../environment";
import { pgssExpressions, SELF_MARKER } from "../queryStats";
import { quoteIdent } from "../sql";

type PgCheck = Check<PostgresEnvironment>;

const MB = 1024 * 1024;
const GB = 1024 * MB;
const RESOURCE_DOCS = "https://www.postgresql.org/docs/current/runtime-config-resource.html";
const MANAGED_NOTE =
  "-- On managed services (RDS, Cloud SQL, Azure, ...) change this in the parameter group\n" +
  "-- or database flags instead; ALTER SYSTEM is usually not allowed there.\n";

function alterSystem(name: string, value: string, s: PgSetting | undefined, comment: string): Fix {
  const restart = s?.context === "postmaster";
  return {
    title: `Change ${name}`,
    sql:
      MANAGED_NOTE +
      (comment ? `-- ${comment}\n` : "") +
      `ALTER SYSTEM SET ${name} = '${value}';\n` +
      (restart ? "-- Takes effect after a server restart.\n" : "SELECT pg_reload_conf();\n"),
    safety: restart ? "caution" : "safe",
  };
}

function settingMetric(label: string, s: PgSetting | undefined): Metric {
  const bytes = settingBytes(s);
  if (bytes !== null && s?.unit) return { label, value: bytes, format: "bytes" };
  return { label, value: s ? `${s.setting}${s.unit ?? ""}` : null, format: "text" };
}

function settingFinding(
  env: PostgresEnvironment,
  checkId: string,
  name: string,
  f: Omit<Finding, "key" | "checkId" | "category" | "target">,
): Finding {
  return {
    key: `${checkId}:${name}`,
    checkId,
    category: "config",
    target: { kind: "setting", name },
    ...f,
    metrics: f.metrics ?? [settingMetric(name, env.settings[name])],
  };
}

export const cacheHitRatio: PgCheck = {
  id: "cache-hit-ratio",
  category: "config",
  title: "Cache hit rate",
  description:
    "How often table and index reads are served from shared buffers instead of disk. Busy OLTP databases should stay above 99%.",
  async run({ runner, env }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        (SELECT SUM(heap_blks_hit)::float8 FROM pg_statio_user_tables) AS table_hit,
        (SELECT SUM(heap_blks_read)::float8 FROM pg_statio_user_tables) AS table_read,
        (SELECT SUM(idx_blks_hit)::float8 FROM pg_statio_user_indexes) AS index_hit,
        (SELECT SUM(idx_blks_read)::float8 FROM pg_statio_user_indexes) AS index_read`);
    const r = rows[0] ?? {};
    const findings: Finding[] = [];
    for (const kind of ["table", "index"] as const) {
      const hit = toNumber(r[`${kind}_hit`]);
      const read = toNumber(r[`${kind}_read`]);
      const total = hit + read;
      if (total < 1_000_000) continue;
      const ratio = hit / total;
      if (ratio >= 0.99) continue;
      findings.push({
        key: `cache-hit-ratio:${kind}`,
        checkId: "cache-hit-ratio",
        category: "config",
        severity: ratio < 0.9 ? "warning" : "info",
        title: `${kind === "table" ? "Table" : "Index"} cache hit rate is ${formatPercent(ratio * 100)}`,
        description:
          `${formatPercent((1 - ratio) * 100)} of ${kind} block reads had to go to the operating system or disk. ` +
          "Either the frequently used data doesn't fit in shared_buffers, or queries are scanning more than they need to " +
          "(check the slow query and sequential scan findings first).",
        target: { kind: "database", name: env.databaseName },
        metrics: [
          { label: "Hit rate", value: ratio * 100, format: "percent" },
          { label: "Blocks read", value: read },
          { label: "Blocks hit", value: hit },
        ],
      });
    }
    return { findings, rows };
  },
};

export const memorySettings: PgCheck = {
  id: "memory-settings",
  category: "config",
  title: "Memory settings",
  description:
    "shared_buffers, work_mem, maintenance_work_mem and effective_cache_size compared with their defaults and with what the server is doing.",
  async run({ runner, env }) {
    const findings: Finding[] = [];
    const s = env.settings;
    const sharedBuffers = settingBytes(s["shared_buffers"]);
    if (sharedBuffers !== null && sharedBuffers <= 128 * MB) {
      findings.push(
        settingFinding(env, "memory-settings", "shared_buffers", {
          severity: "warning",
          title: `shared_buffers is only ${formatBytes(sharedBuffers)}`,
          description:
            "This is PostgreSQL's built-in default, sized to start on almost any machine. A common starting point is " +
            "25% of the server's RAM (for example 4GB on a 16GB server).",
          fix: alterSystem("shared_buffers", "4GB", s["shared_buffers"], "About 25% of RAM. 4GB assumes a 16GB server; adjust to yours."),
          learnMoreUrl: `${RESOURCE_DOCS}#GUC-SHARED-BUFFERS`,
        }),
      );
    }

    const [db] = await runner.query(`
      SELECT /* ${SELF_MARKER} */ temp_files, temp_bytes, stats_reset FROM pg_stat_database WHERE datname = current_database()`);
    const tempFiles = toNumber(db?.temp_files);
    const tempBytes = toNumber(db?.temp_bytes);
    const workMem = settingBytes(s["work_mem"]);
    if (workMem !== null && tempFiles > 0 && tempBytes >= GB) {
      findings.push(
        settingFinding(env, "memory-settings", "work_mem", {
          severity: workMem <= 4 * MB ? "warning" : "info",
          title: `Queries have written ${formatBytes(tempBytes)} of temporary files`,
          description:
            `${tempFiles.toLocaleString("en-US")} temp files were created because sorts and hashes didn't fit in work_mem (${formatBytes(workMem)}). ` +
            "work_mem applies per sort/hash node per connection, so raise it carefully, or only for the roles or queries that need it " +
            "(see the 'Queries spilling to disk' check).",
          metrics: [
            settingMetric("work_mem", s["work_mem"]),
            { label: "Temp files", value: tempFiles },
            { label: "Temp bytes", value: tempBytes, format: "bytes" },
          ],
          fix: alterSystem("work_mem", workMem <= 4 * MB ? "16MB" : `${Math.round((workMem * 2) / MB)}MB`, s["work_mem"],
            "Multiplied by sorts per query and by connections: keep (work_mem x max_connections) well below RAM."),
          learnMoreUrl: `${RESOURCE_DOCS}#GUC-WORK-MEM`,
        }),
      );
    }

    const maint = settingBytes(s["maintenance_work_mem"]);
    if (maint !== null && maint <= 64 * MB && isDefault(s["maintenance_work_mem"])) {
      findings.push(
        settingFinding(env, "memory-settings", "maintenance_work_mem", {
          severity: "info",
          title: `maintenance_work_mem is at the default ${formatBytes(maint)}`,
          description:
            "VACUUM, CREATE INDEX and ALTER TABLE ADD FOREIGN KEY use this. Larger values (256MB-1GB) make vacuum and index builds much faster.",
          fix: alterSystem("maintenance_work_mem", "512MB", s["maintenance_work_mem"], ""),
          learnMoreUrl: `${RESOURCE_DOCS}#GUC-MAINTENANCE-WORK-MEM`,
        }),
      );
    }

    const ecs = settingBytes(s["effective_cache_size"]);
    if (ecs !== null && isDefault(s["effective_cache_size"])) {
      findings.push(
        settingFinding(env, "memory-settings", "effective_cache_size", {
          severity: "info",
          title: `effective_cache_size is at the default ${formatBytes(ecs)}`,
          description:
            "This tells the planner how much memory is available for caching (shared_buffers plus the OS cache). " +
            "It allocates nothing; setting it to 50-75% of RAM makes the planner more willing to use indexes.",
          fix: alterSystem("effective_cache_size", "12GB", s["effective_cache_size"], "About 75% of RAM. 12GB assumes a 16GB server."),
          learnMoreUrl: "https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-EFFECTIVE-CACHE-SIZE",
        }),
      );
    }
    return { findings, rows: db ? [db] : [] };
  },
};

export const plannerSettings: PgCheck = {
  id: "planner-settings",
  category: "config",
  title: "Planner cost settings",
  description: "Planner settings that still assume spinning disks.",
  async run({ env }) {
    const findings: Finding[] = [];
    const s = env.settings;
    const rpc = settingNumber(s["random_page_cost"]);
    if (rpc !== null && rpc >= 4) {
      findings.push(
        settingFinding(env, "planner-settings", "random_page_cost", {
          severity: "info",
          title: `random_page_cost is ${rpc}, tuned for spinning disks`,
          description:
            "On SSDs and most cloud storage, random reads cost about the same as sequential ones. Lowering this to 1.1-2 " +
            "makes the planner choose index scans where they really are faster.",
          fix: alterSystem("random_page_cost", "1.1", s["random_page_cost"], "Only for SSD / network storage."),
          learnMoreUrl: "https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-RANDOM-PAGE-COST",
        }),
      );
    }
    const eic = settingNumber(s["effective_io_concurrency"]);
    if (eic !== null && eic <= 1) {
      findings.push(
        settingFinding(env, "planner-settings", "effective_io_concurrency", {
          severity: "info",
          title: `effective_io_concurrency is ${eic}`,
          description:
            "SSDs handle many concurrent reads. Raising this (e.g. 200 on SSD) speeds up bitmap heap scans by prefetching.",
          fix: alterSystem("effective_io_concurrency", "200", s["effective_io_concurrency"], "Only for SSD / network storage."),
          learnMoreUrl: `${RESOURCE_DOCS}#GUC-EFFECTIVE-IO-CONCURRENCY`,
        }),
      );
    }
    return { findings };
  },
};

export const checkpoints: PgCheck = {
  id: "checkpoints",
  category: "config",
  title: "Checkpoint frequency",
  description:
    "Checkpoints forced by WAL volume rather than by the timer. Frequent forced checkpoints cause I/O spikes and extra WAL from full-page writes.",
  async run({ runner, env }) {
    const sql =
      env.versionNum >= 170000
        ? `SELECT num_timed::float8 AS timed, num_requested::float8 AS requested FROM pg_stat_checkpointer`
        : `SELECT checkpoints_timed::float8 AS timed, checkpoints_req::float8 AS requested FROM pg_stat_bgwriter`;
    const [r] = await runner.query(`/* ${SELF_MARKER} */ ${sql}`);
    const timed = toNumber(r?.timed);
    const requested = toNumber(r?.requested);
    const total = timed + requested;
    const findings: Finding[] = [];
    if (total >= 20 && requested / total >= 0.2) {
      const maxWal = settingBytes(env.settings["max_wal_size"]);
      const next = maxWal ? `${Math.round((maxWal * 2) / GB) || 2}GB` : "4GB";
      findings.push(
        settingFinding(env, "checkpoints", "max_wal_size", {
          severity: requested / total >= 0.5 ? "warning" : "info",
          title: `${formatPercent((100 * requested) / total, 0)} of checkpoints were forced by WAL volume`,
          description:
            `max_wal_size (${maxWal ? formatBytes(maxWal) : "unknown"}) fills up before checkpoint_timeout, so writes trigger extra checkpoints. ` +
            "Raising max_wal_size spreads checkpoints out.",
          metrics: [
            { label: "Requested", value: requested },
            { label: "Timed", value: timed },
            settingMetric("max_wal_size", env.settings["max_wal_size"]),
          ],
          fix: alterSystem("max_wal_size", next, env.settings["max_wal_size"], "Needs that much free disk space for WAL."),
          learnMoreUrl: "https://www.postgresql.org/docs/current/wal-configuration.html",
        }),
      );
    }
    const cct = settingNumber(env.settings["checkpoint_completion_target"]);
    if (cct !== null && cct < 0.9) {
      findings.push(
        settingFinding(env, "checkpoints", "checkpoint_completion_target", {
          severity: "info",
          title: `checkpoint_completion_target is ${cct}`,
          description: "0.9 (the default since PostgreSQL 14) spreads checkpoint writes over more time and smooths out I/O.",
          fix: alterSystem("checkpoint_completion_target", "0.9", env.settings["checkpoint_completion_target"], ""),
        }),
      );
    }
    return { findings, rows: r ? [r] : [] };
  },
};

export const monitoringSettings: PgCheck = {
  id: "monitoring-settings",
  category: "config",
  title: "Monitoring settings",
  description: "Settings that make slow queries easier to find and diagnose.",
  async run({ env }) {
    const findings: Finding[] = [];
    const s = env.settings;
    if (s["track_io_timing"]?.setting === "off") {
      findings.push(
        settingFinding(env, "monitoring-settings", "track_io_timing", {
          severity: "info",
          title: "track_io_timing is off",
          description:
            "Without it, pg_stat_statements and EXPLAIN (ANALYZE, BUFFERS) can't tell you how much time queries spend waiting on disk. " +
            "The overhead is small on modern hardware (check with pg_test_timing).",
          fix: alterSystem("track_io_timing", "on", s["track_io_timing"], ""),
          learnMoreUrl: "https://www.postgresql.org/docs/current/runtime-config-statistics.html#GUC-TRACK-IO-TIMING",
        }),
      );
    }
    if (s["log_min_duration_statement"]?.setting === "-1") {
      findings.push(
        settingFinding(env, "monitoring-settings", "log_min_duration_statement", {
          severity: "info",
          title: "Slow queries are not logged",
          description:
            "Logging statements slower than a threshold records the actual parameter values, which pg_stat_statements leaves out. " +
            "Log analyzers like pgBadger use these logs.",
          fix: alterSystem("log_min_duration_statement", "1000", s["log_min_duration_statement"], "Log statements slower than 1 second."),
          learnMoreUrl: "https://www.postgresql.org/docs/current/runtime-config-logging.html#GUC-LOG-MIN-DURATION-STATEMENT",
        }),
      );
    }
    const tqs = settingNumber(s["track_activity_query_size"]);
    if (tqs !== null && tqs <= 1024) {
      findings.push(
        settingFinding(env, "monitoring-settings", "track_activity_query_size", {
          severity: "info",
          title: "Running queries are cut off after 1KB",
          description:
            "pg_stat_activity only keeps the first 1024 bytes of each query, so long queries can't be identified while they run.",
          fix: alterSystem("track_activity_query_size", "4096", s["track_activity_query_size"], ""),
        }),
      );
    }
    if (s["track_counts"]?.setting === "off") {
      findings.push(
        settingFinding(env, "monitoring-settings", "track_counts", {
          severity: "critical",
          title: "track_counts is off",
          description:
            "Autovacuum relies on these statistics to decide which tables to vacuum and analyze. Most checks here rely on them too.",
          fix: alterSystem("track_counts", "on", s["track_counts"], ""),
        }),
      );
    }
    return { findings };
  },
};

export const jitOverhead: PgCheck = {
  id: "jit-overhead",
  category: "config",
  title: "JIT compilation overhead",
  description:
    "Time spent compiling queries with JIT. For short OLTP queries, compiling can take longer than running the query.",
  unavailableReason: (env) =>
    !env.pgss.readable
      ? "Needs pg_stat_statements."
      : !env.pgss.columns.includes("jit_generation_time")
        ? "Needs pg_stat_statements 1.10 (PostgreSQL 15) or newer."
        : null,
  async run({ runner, env }) {
    const e = pgssExpressions(env.pgss.columns);
    const view = `${quoteIdent(env.pgss.schema ?? "public")}.pg_stat_statements`;
    const [r] = await runner.query(`
      SELECT /* ${SELF_MARKER} */ SUM(${e.jitTime})::float8 AS jit_ms, SUM(${e.totalTime})::float8 AS total_ms,
             COUNT(*) FILTER (WHERE s.jit_functions > 0) AS jit_queries
      FROM ${view} s
      JOIN pg_database d ON d.oid = s.dbid AND d.datname = current_database()`);
    const jit = toNumber(r?.jit_ms);
    const total = toNumber(r?.total_ms);
    const findings: Finding[] = [];
    if (env.settings["jit"]?.setting === "on" && jit >= 10_000 && total > 0 && jit / total >= 0.05) {
      findings.push(
        settingFinding(env, "jit-overhead", "jit", {
          severity: jit / total >= 0.2 ? "warning" : "info",
          title: `JIT compilation takes ${formatPercent((100 * jit) / total)} of query time`,
          description:
            `${toNumber(r?.jit_queries)} query shapes triggered JIT. If the workload is mostly short queries, turning JIT off ` +
            "(or raising jit_above_cost) usually makes them faster.",
          metrics: [
            { label: "JIT time", value: jit, format: "ms" },
            { label: "Total time", value: total, format: "ms" },
          ],
          fix: alterSystem("jit", "off", env.settings["jit"], "Or raise jit_above_cost so only very expensive queries are compiled."),
          learnMoreUrl: "https://www.postgresql.org/docs/current/jit-decision.html",
        }),
      );
    }
    return { findings, rows: r ? [r] : [] };
  },
};

export const replicationSlots: PgCheck = {
  id: "replication-slots",
  category: "config",
  title: "Inactive replication slots",
  description:
    "Replication slots nobody is reading from. They make the server keep WAL forever (until the disk fills) and can stop vacuum from cleaning up.",
  unavailableReason: (env) => (env.versionNum < 100000 ? "Needs PostgreSQL 10 or newer." : null),
  async run({ runner }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        slot_name,
        slot_type,
        database,
        active,
        CASE WHEN pg_is_in_recovery() THEN NULL
             ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8 END AS retained_bytes,
        GREATEST(age(xmin), age(catalog_xmin))::bigint AS xmin_age
      FROM pg_replication_slots
      WHERE NOT active`);
    const findings: Finding[] = rows.map((r) => {
      const retained = r.retained_bytes === null ? null : toNumber(r.retained_bytes);
      return {
        key: `replication-slots:${r.slot_name}`,
        checkId: "replication-slots",
        category: "config",
        severity: retained !== null && retained >= 10 * GB ? "critical" : retained !== null && retained >= GB ? "warning" : "info",
        title: `Replication slot ${r.slot_name} is inactive${retained !== null ? ` and holding ${formatBytes(retained)} of WAL` : ""}`,
        description:
          "Nothing is consuming this slot, but the server keeps every WAL file the slot hasn't read. " +
          "If the consumer is gone for good, drop the slot.",
        target: { kind: "replication-slot", name: String(r.slot_name) },
        metrics: [
          { label: "Type", value: String(r.slot_type), format: "text" },
          { label: "WAL retained", value: retained, format: "bytes" },
          { label: "xmin age", value: r.xmin_age === null ? null : toNumber(r.xmin_age) },
        ],
        fix: {
          title: "Drop the slot",
          sql: `SELECT pg_drop_replication_slot('${String(r.slot_name).replace(/'/g, "''")}');`,
          safety: "destructive",
        },
        learnMoreUrl: "https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS",
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const configChecks: PgCheck[] = [
  cacheHitRatio,
  memorySettings,
  plannerSettings,
  checkpoints,
  monitoringSettings,
  jitOverhead,
  replicationSlots,
];
