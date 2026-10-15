import type { Check, Finding } from "@/core/types";
import { formatMs, formatPercent, oneLine, toNumber } from "@/core/format";
import type { PostgresEnvironment } from "../environment";
import { settingNumber } from "../environment";
import { SELF_MARKER } from "../queryStats";
import { activitySql } from "./queries";

type PgCheck = Check<PostgresEnvironment>;

export const connectionUsage: PgCheck = {
  id: "connection-usage",
  category: "connections",
  title: "Connection usage",
  description:
    "How close the server is to max_connections. When it runs out, new connections are refused.",
  async run({ runner, env }) {
    const [r] = await runner.query(`
      SELECT /* ${SELF_MARKER} */
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE state = 'idle') AS idle,
        COUNT(*) FILTER (WHERE state = 'active') AS active
      FROM pg_stat_activity
      WHERE backend_type = 'client backend'`);
    const max = settingNumber(env.settings["max_connections"]) ?? 100;
    const reserved = settingNumber(env.settings["superuser_reserved_connections"]) ?? 3;
    const available = Math.max(1, max - reserved);
    const total = toNumber(r?.total);
    const idle = toNumber(r?.idle);
    const usage = total / available;
    const findings: Finding[] = [];
    if (usage >= 0.75) {
      findings.push({
        key: "connection-usage:server",
        checkId: "connection-usage",
        category: "connections",
        severity: usage >= 0.9 ? "critical" : "warning",
        title: `${total} of ${available} available connections are in use (${formatPercent(usage * 100, 0)})`,
        description:
          `${idle} of them are idle. Each connection is a separate server process using memory even when idle. ` +
          "A connection pooler such as PgBouncer lets many clients share a few server connections.",
        target: { kind: "database", name: env.databaseName },
        metrics: [
          { label: "Connections", value: total },
          { label: "Idle", value: idle },
          { label: "max_connections", value: max },
        ],
        learnMoreUrl: "https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-MAX-CONNECTIONS",
      });
    } else if (max > 500) {
      findings.push({
        key: "connection-usage:max-connections",
        checkId: "connection-usage",
        category: "connections",
        severity: "info",
        title: `max_connections is ${max}`,
        description:
          "Very high connection limits usually mean the application opens a connection per request. Hundreds of active " +
          "connections compete for CPU and locks; a pooler (PgBouncer) with a lower limit is usually faster.",
        target: { kind: "setting", name: "max_connections" },
        metrics: [
          { label: "max_connections", value: max },
          { label: "In use", value: total },
        ],
      });
    }
    return { findings, rows: r ? [r] : [] };
  },
};

export const idleInTransaction: PgCheck = {
  id: "idle-in-transaction",
  category: "connections",
  title: "Sessions idle in a transaction",
  description:
    "Sessions that opened a transaction and stopped doing anything. They hold their locks and stop vacuum from cleaning up.",
  async run({ runner, env, settings }) {
    const rows = (await runner.query(activitySql())).filter(
      (r) =>
        String(r.state ?? "").startsWith("idle in transaction") &&
        toNumber(r.state_duration_s) >= settings.idleInTransactionS,
    );
    const timeoutOff = env.settings["idle_in_transaction_session_timeout"]?.setting === "0";
    const findings: Finding[] = rows.map((r) => {
      const idleFor = toNumber(r.state_duration_s);
      return {
        key: `idle-in-transaction:${r.pid}`,
        checkId: "idle-in-transaction",
        category: "connections",
        severity: idleFor >= 3600 ? "critical" : "warning",
        title: `pid ${r.pid} has been idle in a transaction for ${formatMs(idleFor * 1000)}`,
        description:
          `Opened by ${r.username ?? "unknown"}${r.application_name ? ` (${r.application_name})` : ""}. ` +
          "Usually an application bug: a transaction that was never committed or rolled back. " +
          (timeoutOff ? "Setting idle_in_transaction_session_timeout ends these automatically." : ""),
        target: { kind: "session", name: String(r.pid) },
        query: String(r.query ?? ""),
        metrics: [
          { label: "Idle for", value: idleFor, format: "duration-s" },
          { label: "Transaction age", value: toNumber(r.xact_duration_s), format: "duration-s" },
          { label: "Last query", value: oneLine(String(r.query ?? ""), 60), format: "text" },
        ],
        fix: {
          title: "End the session",
          sql:
            `-- Rolls back the open transaction and disconnects the session.\nSELECT pg_terminate_backend(${toNumber(r.pid)});` +
            (timeoutOff
              ? "\n\n-- End such sessions automatically in future:\n-- ALTER SYSTEM SET idle_in_transaction_session_timeout = '10min';\n-- SELECT pg_reload_conf();"
              : ""),
          safety: "destructive",
        },
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const longTransactions: PgCheck = {
  id: "long-transactions",
  category: "connections",
  title: "Long-running transactions",
  description:
    "Transactions open for over an hour. Vacuum can't remove any row version they might still see, so tables bloat while they run.",
  async run({ runner }) {
    const rows = (await runner.query(activitySql())).filter(
      (r) =>
        !String(r.state ?? "").startsWith("idle in transaction") &&
        toNumber(r.xact_duration_s) >= 3600,
    );
    const findings: Finding[] = rows.map((r) => {
      const age = toNumber(r.xact_duration_s);
      return {
        key: `long-transactions:${r.pid}`,
        checkId: "long-transactions",
        category: "connections",
        severity: age >= 6 * 3600 ? "critical" : "warning",
        title: `pid ${r.pid} has had a transaction open for ${formatMs(age * 1000)}`,
        description:
          `Opened by ${r.username ?? "unknown"}${r.application_name ? ` (${r.application_name})` : ""}, currently ${r.state}. ` +
          "Break long batch jobs into smaller transactions where possible.",
        target: { kind: "session", name: String(r.pid) },
        query: String(r.query ?? ""),
        metrics: [
          { label: "Transaction age", value: age, format: "duration-s" },
          { label: "State", value: String(r.state ?? ""), format: "text" },
        ],
        fix: {
          title: "Cancel the current query",
          sql: `SELECT pg_cancel_backend(${toNumber(r.pid)});\n-- Or end the session entirely:\n-- SELECT pg_terminate_backend(${toNumber(r.pid)});`,
          safety: "caution",
        },
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const blockedQueries: PgCheck = {
  id: "blocked-queries",
  category: "connections",
  title: "Queries waiting on locks",
  description: "Queries that are blocked right now, waiting for another session to release a lock.",
  async run({ runner }) {
    const all = await runner.query(activitySql());
    const byPid = new Map(all.map((r) => [String(r.pid), r]));
    const rows = all.filter((r) => String(r.blocked_by ?? "").trim() !== "");
    const findings: Finding[] = rows.map((r) => {
      const blockers = String(r.blocked_by).split(",").map((p) => p.trim()).filter(Boolean);
      const first = byPid.get(blockers[0]);
      const waited = toNumber(r.duration_s);
      return {
        key: `blocked-queries:${r.pid}`,
        checkId: "blocked-queries",
        category: "connections",
        severity: waited >= 60 ? "warning" : "info",
        title: `pid ${r.pid} has been waiting ${formatMs(waited * 1000)} on pid ${blockers.join(", ")}`,
        description:
          `Blocked query: ${oneLine(String(r.query ?? ""), 120)}` +
          (first ? `\nBlocking session (${first.state}): ${oneLine(String(first.query ?? ""), 120)}` : ""),
        target: { kind: "session", name: String(r.pid) },
        query: String(r.query ?? ""),
        metrics: [
          { label: "Waiting for", value: waited, format: "duration-s" },
          { label: "Blocked by", value: blockers.join(", "), format: "text" },
          { label: "Wait event", value: String(r.wait_event ?? "—"), format: "text" },
        ],
        fix: {
          title: "Cancel the blocking query",
          sql: blockers.map((p) => `SELECT pg_cancel_backend(${Number(p)});`).join("\n"),
          safety: "caution",
          notes: "Cancelling the blocker lets the waiting query continue.",
        },
      } satisfies Finding;
    });
    return { findings, rows };
  },
};

export const preparedTransactions: PgCheck = {
  id: "prepared-transactions",
  category: "connections",
  title: "Abandoned prepared transactions",
  description:
    "Two-phase-commit transactions that were prepared but never committed or rolled back. They hold locks and block vacuum indefinitely, even across restarts.",
  async run({ runner }) {
    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */ gid, owner, database, prepared,
        EXTRACT(EPOCH FROM now() - prepared)::float8 AS age_s
      FROM pg_prepared_xacts
      WHERE prepared < now() - interval '5 minutes'`);
    const findings: Finding[] = rows.map((r) => ({
      key: `prepared-transactions:${r.gid}`,
      checkId: "prepared-transactions",
      category: "connections",
      severity: "critical",
      title: `Prepared transaction '${r.gid}' has been pending for ${formatMs(toNumber(r.age_s) * 1000)}`,
      description: "If the transaction manager that created it is gone, finish it by hand.",
      target: { kind: "session", name: String(r.gid) },
      metrics: [
        { label: "Owner", value: String(r.owner), format: "text" },
        { label: "Database", value: String(r.database), format: "text" },
        { label: "Age", value: toNumber(r.age_s), format: "duration-s" },
      ],
      fix: {
        title: "Roll it back",
        sql: `ROLLBACK PREPARED '${String(r.gid).replace(/'/g, "''")}';`,
        safety: "destructive",
      },
    }));
    return { findings, rows };
  },
};

export const connectionChecks: PgCheck[] = [
  connectionUsage,
  idleInTransaction,
  longTransactions,
  blockedQueries,
  preparedTransactions,
];
