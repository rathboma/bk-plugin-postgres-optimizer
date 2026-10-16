import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { postgresAdapter, type PostgresEnvironment } from "@/adapters/postgres";
import { runAnalysis, runCheck } from "@/core/engine";
import { DEFAULT_SETTINGS, type CheckResult, type OptimizerSettings } from "@/core/types";
import {
  connect,
  PG_URL,
  PgRunner,
  recreateTestDatabase,
  runWorkload,
  seedProblems,
  testDbUrl,
} from "./support";

const settings: OptimizerSettings = {
  ...DEFAULT_SETTINGS,
  slowQueryMs: 1,
  minCalls: 5,
  largeTableRows: 5000,
  unusedIndexMinBytes: 0,
  deadTupleMin: 1000,
};

const DB = "bks_optimizer_checks";

describe.skipIf(!PG_URL)("PostgreSQL checks", () => {
  let client: pg.Client;
  let runner: PgRunner;
  let env: PostgresEnvironment;
  let results: Map<string, CheckResult>;

  beforeAll(async () => {
    await recreateTestDatabase(DB);
    client = await connect(testDbUrl(DB));
    await seedProblems(client);
    await runWorkload(client);
    runner = new PgRunner(client);
    env = await postgresAdapter.detectEnvironment(runner, { readOnly: false });
    const report = await runAnalysis({ adapter: postgresAdapter, runner, env, settings });
    results = new Map(report.results.map((r) => [r.checkId, r]));
  });

  afterAll(async () => {
    await client?.end();
  });

  const findingTitles = (id: string) => results.get(id)!.findings.map((f) => f.title);

  it("detects the environment", () => {
    expect(env.versionNum).toBeGreaterThan(100000);
    expect(env.pgss.installed).toBe(true);
    expect(env.pgss.readable).toBe(true);
    expect(env.pgss.columns).toContain("calls");
    expect(env.isSuperuser).toBe(true);
  });

  it("runs every check without errors", () => {
    const errors = [...results.values()].filter((r) => r.status === "error");
    expect(errors.map((e) => `${e.checkId}: ${e.message}`)).toEqual([]);
  });

  it("finds slow queries", () => {
    const queries = results.get("slow-queries")!.findings.map((f) => f.query ?? "");
    expect(queries.some((q) => q.includes("orders WHERE customer_id"))).toBe(true);
  });

  it("finds the foreign key without an index", () => {
    const r = results.get("unindexed-foreign-keys")!;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toBe("Add an index on orders (customer_id)");
    expect(r.findings[0].fix?.sql).toContain("CREATE INDEX CONCURRENTLY orders_customer_id_idx");
  });

  it("finds duplicate and redundant indexes", () => {
    const names = results.get("duplicate-indexes")!.findings.map((f) => f.target?.name).sort();
    expect(names).toEqual(["orders_status_copy_idx", "orders_status_idx"]);
  });

  it("finds the unused index", () => {
    const names = results.get("unused-indexes")!.findings.map((f) => f.target?.name);
    expect(names).toContain("customers_created_at_idx");
    // Primary keys and unique indexes are never reported as unused.
    expect(names).not.toContain("customers_pkey");
  });

  it("finds the invalid index", () => {
    const names = results.get("invalid-indexes")!.findings.map((f) => f.target?.name);
    expect(names).toEqual(["signups_email_idx"]);
  });

  it("finds tables read with sequential scans and links a query", () => {
    const f = results.get("seq-scan-heavy-tables")!.findings.find((x) => x.target?.name === "orders");
    expect(f).toBeDefined();
    expect(f!.query).toMatch(/orders/);
  });

  it("suggests indexes from query plans", () => {
    const titles = findingTitles("index-suggestions");
    expect(titles).toContain("Add an index on orders (customer_id)");
    expect(titles.some((t) => t.includes("customers") && t.includes("lower(email)"))).toBe(true);
    expect(titles.some((t) => t.includes("orders") && t.includes("created_at DESC"))).toBe(true);
  });

  it("gives the foreign key index and the matching suggestion the same group key", () => {
    const fk = results.get("unindexed-foreign-keys")!.findings[0];
    const suggestion = results
      .get("index-suggestions")!
      .findings.find((f) => f.title === "Add an index on orders (customer_id)");
    expect(fk.groupKey).toBe("index:public.orders(customer_id)");
    expect(suggestion?.groupKey).toBe(fk.groupKey);
  });

  it("validates suggestions with hypopg when it is installed", async () => {
    const hypo = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'hypopg'");
    if (!hypo.rowCount) return;
    await client.query("CREATE EXTENSION IF NOT EXISTS hypopg");
    const env2 = await postgresAdapter.detectEnvironment(runner, { readOnly: false });
    const res = await runCheck(postgresAdapter.checks.find((c) => c.id === "index-suggestions")!, runner, env2, settings);
    const f = res.findings.find((x) => x.title === "Add an index on orders (customer_id)");
    expect(f?.description).toContain("estimated cost drops");
    await client.query("DROP EXTENSION hypopg");
  });

  it("finds dead rows and missing statistics", () => {
    expect(results.get("dead-tuples")!.findings.map((f) => f.target?.name)).toContain("events");
    expect(results.get("stale-statistics")!.findings.map((f) => f.target?.name)).toContain("events");
  });

  it("finds the nearly exhausted sequence", () => {
    const f = results.get("sequence-exhaustion")!.findings[0];
    expect(f.target?.name).toBe("tickets_id_seq");
    expect(f.severity).toBe("critical");
    expect(f.fix?.sql).toContain("TYPE bigint");
  });

  it("finds table level problems", () => {
    expect(results.get("tables-without-primary-key")!.findings.map((f) => f.target?.name)).toEqual(
      expect.arrayContaining(["audit_log", "signups"]),
    );
    expect(results.get("invalid-constraints")!.findings.map((f) => f.target?.name)).toEqual(["orders_total_positive"]);
    expect(results.get("autovacuum-disabled")!.findings.map((f) => f.target?.name)).toEqual(["events"]);
  });

  it("leaves the optimizer's own queries out of top queries", async () => {
    const top = await postgresAdapter.topQueries!(runner, env, { sort: "total", limit: 500 });
    expect(top.queries.length).toBeGreaterThan(0);
    const own = top.queries.filter((q) =>
      /boot_val|installed_version|pg_stat_activity|hypopg_|EXPLAIN|pg_index i|pg_constraint c/i.test(q.query),
    );
    expect(own.map((q) => q.query.slice(0, 80))).toEqual([]);
  });

  it("only sends read-only statements during analysis", () => {
    const statements = runner.statements.flatMap((batch) => batch.split("\n;\n"));
    const unexpected = statements
      .map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim())
      .filter(
        (s) =>
          !/^(SELECT|WITH)\b/i.test(s) &&
          !/^EXPLAIN \((?![^)]*ANALYZE)[^)]*\)/i.test(s) &&
          !/^(SET LOCAL plan_cache_mode|PREPARE bks_optimizer_\w+ AS|DEALLOCATE bks_optimizer_)/i.test(s),
      );
    expect(unexpected).toEqual([]);
  });
});
