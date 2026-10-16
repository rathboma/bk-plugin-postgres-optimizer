/**
 * Database-agnostic model for the optimizer.
 *
 * Every database engine plugs in through a `DatabaseAdapter`. The UI only ever
 * talks to these types, so adding MySQL or SQL Server later means writing a new
 * adapter, not touching the UI.
 */

export type Row = Record<string, unknown>;

/**
 * Runs SQL against the connected database. In the app this goes through the
 * Beekeeper Studio plugin API, in tests it goes straight to a `pg` client.
 */
export interface QueryRunner {
  /** Run one statement and return its rows. */
  query<T = Row>(sql: string): Promise<T[]>;
  /**
   * Run several statements in one round trip, on one connection, and return
   * the rows of each statement. Needed for session-scoped tricks like hypopg.
   */
  queryMulti(sql: string): Promise<Row[][]>;
}

export type Severity = "critical" | "warning" | "info";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export type CategoryId =
  | "queries"
  | "indexes"
  | "tables"
  | "config"
  | "connections";

export interface Category {
  id: CategoryId;
  title: string;
  description: string;
}

export const CATEGORIES: Category[] = [
  {
    id: "queries",
    title: "Queries",
    description: "Slow, expensive and long-running queries.",
  },
  {
    id: "indexes",
    title: "Indexes",
    description: "Missing, unused, duplicate and broken indexes.",
  },
  {
    id: "tables",
    title: "Tables & Maintenance",
    description: "Vacuum, statistics, bloat and other table health problems.",
  },
  {
    id: "config",
    title: "Configuration",
    description: "Server settings and resource usage.",
  },
  {
    id: "connections",
    title: "Connections & Locks",
    description: "Connection usage, idle transactions and lock contention.",
  },
];

/** What a finding is about. Used for display and for "open table" actions. */
export interface TargetRef {
  kind:
    | "table"
    | "index"
    | "query"
    | "setting"
    | "sequence"
    | "constraint"
    | "session"
    | "database"
    | "replication-slot";
  schema?: string;
  name: string;
  table?: string;
}

export type MetricFormat =
  | "number"
  | "bytes"
  | "ms"
  | "percent"
  | "text"
  | "datetime"
  | "duration-s";

export interface Metric {
  label: string;
  value: number | string | null;
  format?: MetricFormat;
}

/**
 * A suggested change. The optimizer never runs these itself, they are opened
 * in a query tab so the user can review and run them.
 */
export interface Fix {
  title: string;
  sql: string;
  /**
   * `safe`: read-only or trivially reversible (ANALYZE, CREATE INDEX CONCURRENTLY).
   * `caution`: takes locks, rewrites data or needs a restart.
   * `destructive`: drops something.
   */
  safety: "safe" | "caution" | "destructive";
  notes?: string;
}

export interface Finding {
  /** Stable across runs so users can dismiss a finding. */
  key: string;
  checkId: string;
  category: CategoryId;
  severity: Severity;
  title: string;
  /**
   * Findings with the same group key recommend the same change (e.g. two checks
   * both suggesting an index on orders(customer_id)) and are shown as one.
   */
  groupKey?: string;
  /** Why this matters / what was observed. Plain text. */
  description: string;
  target?: TargetRef;
  metrics?: Metric[];
  /** SQL text of the query this finding is about, if any. */
  query?: string;
  fix?: Fix;
  learnMoreUrl?: string;
}

export interface CheckContext<E extends BaseEnvironment = BaseEnvironment> {
  runner: QueryRunner;
  env: E;
  settings: OptimizerSettings;
}

export interface CheckOutput {
  findings: Finding[];
  /** Raw rows behind the check, shown in the result panel on request. */
  rows?: Row[];
  /** Caveat to show with the result, e.g. when part of the input couldn't be examined. */
  note?: string;
  /** Nothing could actually be examined; report the check as skipped, not passed. */
  inconclusive?: boolean;
}

export interface Check<E extends BaseEnvironment = BaseEnvironment> {
  id: string;
  category: CategoryId;
  title: string;
  /** What the check looks for, shown in the UI. */
  description: string;
  /** Return a reason to skip the check in this environment, or null to run it. */
  unavailableReason?(env: E): string | null;
  run(ctx: CheckContext<E>): Promise<CheckOutput>;
}

export type CheckStatus = "passed" | "issues" | "skipped" | "error";

export interface CheckResult {
  checkId: string;
  category: CategoryId;
  title: string;
  description: string;
  status: CheckStatus;
  findings: Finding[];
  rows: Row[];
  message?: string;
  durationMs: number;
}

export interface Notice {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  fix?: Fix;
  learnMoreUrl?: string;
}

/** Facts about the server every adapter can report. */
export interface BaseEnvironment {
  engine: string;
  databaseName: string;
  serverVersion: string;
  /** Numeric version for comparisons, e.g. 160004. */
  versionNum: number;
  user: string;
  readOnly: boolean;
  /** Setup problems that limit what the optimizer can see. */
  notices: Notice[];
  /** Capability flags, e.g. `queryStats`, `hypotheticalIndexes`. */
  capabilities: Record<string, boolean>;
  /** Short facts for the overview header, e.g. uptime, stats reset time. */
  facts: Metric[];
}

/** Aggregated statistics for one normalized query. */
export interface QueryStat {
  id: string;
  query: string;
  user?: string;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  maxTimeMs?: number;
  stddevTimeMs?: number;
  rows: number;
  /** Share of total execution time across all tracked queries, 0-100. */
  percentOfTotal?: number;
  /** Fraction of blocks served from cache, 0-1. */
  cacheHitRatio?: number | null;
  blocksRead?: number;
  tempBlocksWritten?: number;
  ioTimeMs?: number;
}

export type QuerySort = "total" | "mean" | "calls" | "io" | "temp";

export interface QueryStatsResult {
  available: boolean;
  /** Why stats are unavailable, when they are. */
  reason?: string;
  queries: QueryStat[];
}

/** A node of an estimated query plan (EXPLAIN without ANALYZE, so nothing runs). */
export interface PlanNode {
  id: number;
  nodeType: string;
  /** Short one-line description, e.g. "Seq Scan on orders". */
  label: string;
  relation?: { schema?: string; name: string; alias?: string };
  indexName?: string;
  estimatedRows: number;
  totalCost: number;
  children: PlanNode[];
  raw: Row;
}

export interface PlanIssue {
  severity: Severity;
  title: string;
  description: string;
}

export interface IndexSuggestion {
  schema?: string;
  table: string;
  columns: string[];
  method: string;
  ddl: string;
  reason: string;
  /** Existing index that already covers these columns, if any. */
  coveredBy?: string;
  /** Hypothetical-index validation, when available. */
  validation?: {
    costBefore: number;
    costAfter: number;
    usedByPlanner: boolean;
  };
}

export interface ExplainResult {
  ok: boolean;
  error?: string;
  /** How the plan was produced, e.g. "Generic plan (EXPLAIN GENERIC_PLAN)". */
  mode?: string;
  plan?: PlanNode;
  totalCost?: number;
  issues: PlanIssue[];
  suggestions: IndexSuggestion[];
}

export interface OptimizerSettings {
  /** A query is slow when its mean time is at least this many ms. */
  slowQueryMs: number;
  /** Ignore queries called fewer times than this. */
  minCalls: number;
  /** Tables smaller than this are not worth indexing advice. */
  largeTableRows: number;
  /** Unused indexes smaller than this are not reported. */
  unusedIndexMinBytes: number;
  /** Report dead tuples once a table has at least this many. */
  deadTupleMin: number;
  /** ... and they are at least this fraction of the table. */
  deadTupleRatio: number;
  /** Queries running longer than this many seconds are reported. */
  longRunningQueryS: number;
  /** Sessions idle in a transaction longer than this many seconds are reported. */
  idleInTransactionS: number;
  /** How many top queries to EXPLAIN when looking for missing indexes. */
  explainTopQueries: number;
}

export const DEFAULT_SETTINGS: OptimizerSettings = {
  slowQueryMs: 100,
  minCalls: 5,
  largeTableRows: 10_000,
  unusedIndexMinBytes: 1024 * 1024,
  deadTupleMin: 10_000,
  deadTupleRatio: 0.2,
  longRunningQueryS: 60,
  idleInTransactionS: 300,
  explainTopQueries: 20,
};

/**
 * One implementation per database engine. Optional members light up optional
 * parts of the UI (top queries table, query analyzer).
 */
export interface DatabaseAdapter<E extends BaseEnvironment = BaseEnvironment> {
  id: string;
  name: string;
  /** Beekeeper Studio `databaseType` values this adapter handles. */
  databaseTypes: string[];
  detectEnvironment(runner: QueryRunner, opts: { readOnly: boolean }): Promise<E>;
  checks: Check<E>[];
  topQueries?(
    runner: QueryRunner,
    env: E,
    opts: { sort: QuerySort; limit: number },
  ): Promise<QueryStatsResult>;
  explain?(
    runner: QueryRunner,
    env: E,
    sql: string,
    settings: OptimizerSettings,
  ): Promise<ExplainResult>;
}
