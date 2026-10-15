import pg from "pg";
import type { QueryRunner, Row } from "@/core/types";

/**
 * Integration tests run against the server in PG_URL, e.g.
 *   PG_URL=postgres://postgres:postgres@localhost:5432/postgres yarn test:integration
 * The server needs pg_stat_statements in shared_preload_libraries.
 * Each spec file drops and recreates its own scratch database.
 */
export const PG_URL = process.env.PG_URL;

export function testDbUrl(db: string, user?: { name: string; password: string }): string {
  const url = new URL(PG_URL!);
  url.pathname = `/${db}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

/** Same result shape Beekeeper Studio's runQuery produces: one row array per statement. */
export class PgRunner implements QueryRunner {
  readonly statements: string[] = [];
  constructor(readonly client: pg.Client) {}

  async query<T = Row>(sql: string): Promise<T[]> {
    const results = await this.queryMulti(sql);
    return (results[results.length - 1] ?? []) as T[];
  }

  async queryMulti(sql: string): Promise<Row[][]> {
    this.statements.push(sql);
    const res = (await this.client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    const list = Array.isArray(res) ? res : [res];
    return list.map((r) => r.rows as Row[]);
  }
}

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function recreateTestDatabase(db: string): Promise<void> {
  const admin = await connect(PG_URL!);
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`,
    );
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }
}

export async function serverVersionNum(client: pg.Client): Promise<number> {
  const r = await client.query("SELECT current_setting('server_version_num')::int AS v");
  return Number(r.rows[0].v);
}

/** Make cumulative statistics visible right away instead of after the next flush. */
export async function flushStats(client: pg.Client): Promise<void> {
  if ((await serverVersionNum(client)) >= 150000) {
    await client.query("SELECT pg_stat_force_next_flush()");
  } else {
    // The stats collector sends updates every 500ms on older versions.
    await new Promise((r) => setTimeout(r, 1200));
  }
  await client.query("SELECT pg_stat_clear_snapshot()");
}

/**
 * Builds a small schema with one of each problem the checks look for.
 * Keep table sizes modest so the suite stays fast.
 */
export async function seedProblems(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

    CREATE TABLE customers (
      id serial PRIMARY KEY,
      email text NOT NULL,
      region text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO customers (email, region, created_at)
    SELECT 'user' || g || '@example.com', (ARRAY['eu','us','apac'])[1 + g % 3], now() - (g || ' minutes')::interval
    FROM generate_series(1, 30000) g;

    -- Foreign key without an index on customer_id.
    CREATE TABLE orders (
      id bigserial PRIMARY KEY,
      customer_id int NOT NULL REFERENCES customers (id),
      status text NOT NULL,
      total numeric NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO orders (customer_id, status, total, created_at)
    SELECT 1 + (g % 30000), (ARRAY['new','paid','shipped','cancelled'])[1 + g % 4], (g % 500)::numeric,
           now() - (g || ' seconds')::interval
    FROM generate_series(1, 120000) g;

    -- Redundant: both are prefixes of orders_status_created_idx, and identical to each other.
    CREATE INDEX orders_status_idx ON orders (status);
    CREATE INDEX orders_status_copy_idx ON orders (status);
    CREATE INDEX orders_status_created_idx ON orders (status, created_at);

    -- Never used.
    CREATE INDEX customers_created_at_idx ON customers (created_at);

    -- Never validated.
    ALTER TABLE orders ADD CONSTRAINT orders_total_positive CHECK (total >= 0) NOT VALID;

    -- Dead rows and no statistics: autovacuum is off, so nothing cleans up.
    CREATE TABLE events (id serial PRIMARY KEY, kind text, payload text) WITH (autovacuum_enabled = false);
    INSERT INTO events (kind, payload) SELECT 'click', repeat('x', 50) FROM generate_series(1, 20000);
    UPDATE events SET payload = repeat('y', 50);

    -- Sequence close to the int4 limit.
    CREATE TABLE tickets (id serial PRIMARY KEY, title text);
    SELECT setval('tickets_id_seq', 2000000000);
    INSERT INTO tickets (title) VALUES ('nearly out');

    -- No primary key.
    CREATE TABLE audit_log (at timestamptz DEFAULT now(), message text);
    INSERT INTO audit_log (message) SELECT 'm' || g FROM generate_series(1, 100) g;

    -- Duplicate emails, so a unique index build fails and leaves an invalid index.
    CREATE TABLE signups (email text);
    INSERT INTO signups VALUES ('a@example.com'), ('a@example.com');

    ANALYZE customers;
    ANALYZE orders;
    ANALYZE tickets;
  `);

  // CONCURRENTLY can't run in the multi-statement block above (implicit transaction).
  await client.query("CREATE UNIQUE INDEX CONCURRENTLY signups_email_idx ON signups (email)").catch(() => {});
}

/** Run a workload so pg_stat_statements and table stats have something to report. */
export async function runWorkload(client: pg.Client): Promise<void> {
  await client.query("SELECT pg_stat_statements_reset()");
  for (let i = 0; i < 40; i++) {
    await client.query("SELECT * FROM orders WHERE customer_id = $1", [1 + i]);
    await client.query("SELECT id, email FROM customers WHERE lower(email) = $1", [`user${i}@example.com`]);
  }
  for (let i = 0; i < 30; i++) {
    await client.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 10");
  }
  await flushStats(client);
}
