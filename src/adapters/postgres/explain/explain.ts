import type {
  ExplainOptions,
  ExplainResult,
  IndexSuggestion,
  OptimizerSettings,
  PlanNode,
  QueryRunner,
} from "@/core/types";
import { errorMessage, toNumber } from "@/core/format";
import type { PostgresEnvironment } from "../environment";
import type { IndexInfo } from "../indexCatalog";
import { loadIndexes } from "../indexCatalog";
import { SELF_MARKER } from "../queryStats";
import { toJson } from "../rows";
import {
  countStatements,
  parameterCount,
  quoteIdent,
  quoteLiteral,
  repairNormalizedQuery,
  statementKind,
  tagged,
} from "../sql";
import type { ColumnStats } from "./indexAdvisor";
import { hypotheticalDdl, suggestIndexes } from "./indexAdvisor";
import { analyzePlan, relationKey } from "./planAnalyzer";
import { findNodes, normalizePlan, planRelations, unwrapExplain } from "./planModel";

/** Catalog facts about the relations in a plan, cached across EXPLAINs in one run. */
export class CatalogCache {
  tableRows = new Map<string, number>();
  indexes = new Map<string, IndexInfo[]>();
  columnStats = new Map<string, ColumnStats>();
  private loaded = new Set<string>();

  async load(runner: QueryRunner, env: PostgresEnvironment, relations: { schema?: string; name: string }[]) {
    const missing = relations.filter((r) => !this.loaded.has(relationKey(r.schema, r.name)) && r.schema);
    if (!missing.length) return;
    const pairs = missing.map((r) => `(${quoteLiteral(r.schema!)}, ${quoteLiteral(r.name)})`).join(", ");

    const rows = await runner.query(`
      SELECT /* ${SELF_MARKER} */ n.nspname AS schema, c.relname AS table_name,
        COALESCE(NULLIF(GREATEST(c.reltuples, 0), 0), s.n_live_tup, 0)::float8 AS estimated_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE (n.nspname, c.relname) IN (${pairs})`);
    for (const r of rows) this.tableRows.set(relationKey(String(r.schema), String(r.table_name)), toNumber(r.estimated_rows));

    const indexes = await loadIndexes(runner, env.versionNum, `AND (n.nspname, t.relname) IN (${pairs})`);
    for (const ix of indexes) {
      const key = relationKey(ix.schema, ix.table);
      this.indexes.set(key, [...(this.indexes.get(key) ?? []), ix]);
    }

    const stats = await runner.query(`
      SELECT /* ${SELF_MARKER} */ schemaname AS schema, tablename AS table_name, attname AS column_name, null_frac, n_distinct
      FROM pg_stats
      WHERE (schemaname, tablename) IN (${pairs})`);
    for (const r of stats) {
      this.columnStats.set(`${relationKey(String(r.schema), String(r.table_name))}.${String(r.column_name).toLowerCase()}`, {
        nullFrac: toNumber(r.null_frac),
        nDistinct: toNumber(r.n_distinct),
      });
    }
    missing.forEach((r) => this.loaded.add(relationKey(r.schema, r.name)));
  }
}

interface ExplainPlanText {
  /** Statements to run, in order, as one batch. */
  statements: string[];
  /** Which statement's result holds the plan. */
  planIndex: number;
  mode: string;
}

/**
 * Work out how to EXPLAIN a query. Queries copied from pg_stat_statements
 * contain `$1` placeholders, which plain EXPLAIN rejects.
 */
export function buildExplain(
  env: PostgresEnvironment,
  sql: string,
  opts: ExplainOptions,
): ExplainPlanText | { error: string } {
  const query = repairNormalizedQuery(sql);
  if (!query) return { error: "Enter a query to analyze." };
  if (countStatements(query) > 1) return { error: "Analyze one statement at a time." };
  const kind = statementKind(query);
  if (kind === "utility" || kind === "unknown") {
    return { error: "Only SELECT, INSERT, UPDATE, DELETE and MERGE statements have query plans." };
  }
  const params = parameterCount(query);
  // Keep a trailing `-- comment` from swallowing the statement separator.
  const q = `${query}\n`;

  if (opts.analyze) {
    if (params > 0) {
      return { error: "This query has $1-style placeholders. Replace them with real values to run EXPLAIN ANALYZE." };
    }
    if (kind !== "select") {
      return { error: "EXPLAIN ANALYZE executes the query, so it is only allowed for read-only SELECT statements." };
    }
    // A read-only transaction makes sure nothing in the query can write. The
    // division fails the whole batch, before the EXPLAIN runs, if the guard
    // somehow didn't take effect (e.g. statements sent one by one).
    const guard = env.readOnly
      ? []
      : [
          "SET LOCAL transaction_read_only = on",
          "SET LOCAL statement_timeout = '120s'",
          "SELECT 1 / (current_setting('transaction_read_only') = 'on')::int AS read_only_guard",
        ];
    return {
      statements: [...guard, `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${q}`],
      planIndex: guard.length,
      mode: "Executed (EXPLAIN ANALYZE, read-only transaction)",
    };
  }

  if (params === 0) {
    return { statements: [`EXPLAIN (VERBOSE, FORMAT JSON) ${q}`], planIndex: 0, mode: "Estimated plan (EXPLAIN)" };
  }
  if (env.capabilities.genericPlans) {
    return {
      statements: [`EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${q}`],
      planIndex: 0,
      mode: "Generic plan for any parameter values (EXPLAIN GENERIC_PLAN)",
    };
  }
  if (env.capabilities.preparedGenericPlans) {
    const name = `bks_optimizer_${Math.random().toString(36).slice(2, 10)}`;
    const args = Array.from({ length: params }, () => "NULL").join(", ");
    return {
      statements: [
        "SET LOCAL plan_cache_mode = force_generic_plan",
        `PREPARE ${name} AS ${q}`,
        `EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE ${name}(${args})`,
        `DEALLOCATE ${name}`,
      ],
      planIndex: 2,
      mode: "Generic plan for any parameter values (PREPARE)",
    };
  }
  return {
    error: env.readOnly
      ? "Queries with $1 placeholders need PostgreSQL 16+ to explain in read-only mode. Replace the placeholders with real values."
      : "Queries with $1 placeholders need PostgreSQL 12+ to explain. Replace the placeholders with real values.",
  };
}

async function runExplain(runner: QueryRunner, plan: ExplainPlanText, prefix: string[] = [], suffix: string[] = []) {
  const statements = [...prefix, ...plan.statements, ...suffix];
  const results = await runner.queryMulti(statements.map(tagged).join("\n;\n"));
  const rows = results[prefix.length + plan.planIndex] ?? [];
  const value = rows[0] ? Object.values(rows[0])[0] : undefined;
  return unwrapExplain(toJson(value));
}

function usesHypotheticalIndex(root: PlanNode): boolean {
  return findNodes(root, (n) => !!n.indexName && /^<\d+>/.test(n.indexName)).length > 0;
}

/** Re-plan with each suggested index as a hypothetical (hypopg) index. */
async function validateSuggestions(
  runner: QueryRunner,
  env: PostgresEnvironment,
  plan: ExplainPlanText,
  costBefore: number,
  suggestions: IndexSuggestion[],
) {
  const hypo = quoteIdent(env.hypopg.schema ?? "public");
  for (const s of suggestions) {
    if (s.coveredBy || s.method !== "btree") continue;
    try {
      const raw = await runExplain(
        runner,
        plan,
        [`SELECT ${hypo}.hypopg_reset()`, `SELECT * FROM ${hypo}.hypopg_create_index(${quoteLiteral(hypotheticalDdl(s))})`],
        [`SELECT ${hypo}.hypopg_reset()`],
      );
      const root = normalizePlan(raw.Plan);
      s.validation = { costBefore, costAfter: root.totalCost, usedByPlanner: usesHypotheticalIndex(root) };
    } catch {
      // Validation is best effort; the suggestion stands on its own.
    }
  }
}

export async function explainQuery(
  runner: QueryRunner,
  env: PostgresEnvironment,
  sql: string,
  opts: ExplainOptions,
  settings: OptimizerSettings,
  cache = new CatalogCache(),
): Promise<ExplainResult> {
  const built = buildExplain(env, sql, opts);
  if ("error" in built) return { ok: false, error: built.error, issues: [], suggestions: [] };

  let raw;
  try {
    raw = await runExplain(runner, built);
  } catch (e) {
    return { ok: false, error: errorMessage(e), mode: built.mode, issues: [], suggestions: [] };
  }

  const root = normalizePlan(raw.Plan);
  await cache.load(runner, env, planRelations(root));
  const { issues, candidates } = analyzePlan(root, raw, {
    analyzed: opts.analyze,
    tableRows: cache.tableRows,
    largeTableRows: settings.largeTableRows,
  });
  const suggestions = suggestIndexes(candidates, {
    indexes: cache.indexes,
    columnStats: cache.columnStats,
    tableRows: cache.tableRows,
  });

  if (env.hypopg.installed && suggestions.length) {
    // ANALYZE plans can't be validated (hypopg indexes are planner-only), so
    // validate against the estimated plan of the same query.
    const estimatePlan = opts.analyze ? buildExplain(env, sql, { analyze: false }) : built;
    if (!("error" in estimatePlan)) {
      const before = opts.analyze ? normalizePlan((await runExplain(runner, estimatePlan)).Plan).totalCost : root.totalCost;
      await validateSuggestions(runner, env, estimatePlan, before, suggestions);
    }
  }

  // Suggestions hypopg proved useful first, ones the planner would ignore last.
  const rank = (s: IndexSuggestion) =>
    s.coveredBy ? 3 : !s.validation ? 1 : s.validation.usedByPlanner ? 0 : 2;
  suggestions.sort((a, b) => rank(a) - rank(b));

  return {
    ok: true,
    mode: built.mode,
    plan: root,
    planningMs: raw["Planning Time"],
    executionMs: raw["Execution Time"],
    totalCost: root.totalCost,
    issues,
    suggestions,
    rawPlan: raw,
  };
}
