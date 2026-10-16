import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { postgresAdapter, type PostgresEnvironment } from "@/adapters/postgres";
import { explainQuery } from "@/adapters/postgres/explain/explain";
import { DEFAULT_SETTINGS } from "@/core/types";
import { connect, flushStats, PG_URL, PgRunner, recreateTestDatabase, seedProblems, testDbUrl } from "./support";

const settings = { ...DEFAULT_SETTINGS, largeTableRows: 5000 };

const DB = "bks_optimizer_explain";

describe.skipIf(!PG_URL)("Query analyzer (EXPLAIN)", () => {
  let client: pg.Client;
  let runner: PgRunner;
  let env: PostgresEnvironment;

  beforeAll(async () => {
    await recreateTestDatabase(DB);
    client = await connect(testDbUrl(DB));
    await seedProblems(client);
    await flushStats(client);
    runner = new PgRunner(client);
    env = await postgresAdapter.detectEnvironment(runner, { readOnly: false });
  });

  afterAll(async () => {
    await client?.end();
  });

  it("explains a query and suggests an index for a filtered seq scan", async () => {
    const r = await explainQuery(runner, env, "SELECT * FROM orders WHERE customer_id = 42", settings);
    expect(r.ok).toBe(true);
    expect(r.plan?.nodeType).toMatch(/Seq Scan|Gather/);
    expect(r.issues.some((i) => i.title.includes("Sequential scan on public.orders"))).toBe(true);
    expect(r.suggestions[0].columns).toEqual(["customer_id"]);
    expect(r.suggestions[0].ddl).toContain("CREATE INDEX CONCURRENTLY orders_customer_id_idx");
  });

  it("explains queries with $1 placeholders from pg_stat_statements", async () => {
    const r = await explainQuery(
      runner,
      env,
      "SELECT * FROM orders WHERE customer_id = $1 AND status = $2",
      settings,
    );
    expect(r.ok, r.error).toBe(true);
    expect(r.mode).toMatch(/Generic plan/);
    // status is covered by existing indexes, so the planner may pick those;
    // either way the suggestion leads with the selective customer_id.
    expect(r.suggestions.some((s) => s.columns[0] === "customer_id")).toBe(true);
  });

  it("never runs the query", async () => {
    await client.query(
      "CREATE OR REPLACE FUNCTION sneaky() RETURNS int LANGUAGE sql AS $$ DELETE FROM orders RETURNING 1 $$",
    );
    const r = await explainQuery(runner, env, "SELECT sneaky()", settings);
    expect(r.ok, r.error).toBe(true);
    const count = await client.query("SELECT count(*)::int AS n FROM orders");
    expect(count.rows[0].n).toBe(120000);
  });

  it("estimates DML plans without running them", async () => {
    const r = await explainQuery(runner, env, "UPDATE orders SET total = 0 WHERE customer_id = 7", settings);
    expect(r.ok, r.error).toBe(true);
    const n = await client.query("SELECT count(*)::int AS n FROM orders WHERE total = 0 AND customer_id = 7");
    expect(n.rows[0].n).toBe(0);
  });

  it("rejects multiple statements and utility commands", async () => {
    expect((await explainQuery(runner, env, "SELECT 1; SELECT 2", settings)).error).toMatch(/one statement/);
    expect((await explainQuery(runner, env, "VACUUM orders", settings)).error).toMatch(/have query plans/);
  });

  it("handles a trailing line comment", async () => {
    const r = await explainQuery(runner, env, "SELECT * FROM customers WHERE id = $1 -- by id", settings);
    expect(r.ok, r.error).toBe(true);
  });

  it("leaves the session clean after a failed EXPLAIN", async () => {
    const bad = await explainQuery(runner, env, "SELECT * FROM no_such_table WHERE id = $1", settings);
    expect(bad.ok).toBe(false);
    const prepared = await client.query("SELECT count(*)::int AS n FROM pg_prepared_statements");
    expect(prepared.rows[0].n).toBe(0);
    const mode = await client.query("SELECT current_setting('transaction_read_only') AS ro");
    expect(mode.rows[0].ro).toBe("off");
  });

  it("works for a role without superuser or stats privileges", async () => {
    await client.query("DROP ROLE IF EXISTS bks_plain; CREATE ROLE bks_plain LOGIN PASSWORD 'plain'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO bks_plain");
    const plain = await connect(testDbUrl(DB, { name: "bks_plain", password: "plain" }));
    try {
      const plainRunner = new PgRunner(plain);
      const plainEnv = await postgresAdapter.detectEnvironment(plainRunner, { readOnly: false });
      expect(plainEnv.isSuperuser).toBe(false);
      expect(plainEnv.canReadAllStats).toBe(false);
      expect(plainEnv.notices.map((n) => n.id)).toContain("pgss-own-queries-only");
      const r = await explainQuery(plainRunner, plainEnv, "SELECT * FROM orders WHERE customer_id = 1", settings);
      expect(r.ok, r.error).toBe(true);
    } finally {
      await plain.end();
      await client.query("DROP OWNED BY bks_plain; DROP ROLE bks_plain");
    }
  });
});
