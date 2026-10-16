// Runs a small application-like workload against the demo database
// (dev/demo.sql) so pg_stat_statements and the table statistics have
// something to report.
//
//   PG_URL=postgres://user:pass@localhost:5432/shop node dev/demo-workload.mjs
import pg from "pg";

const pgUrl = process.env.PG_URL;
if (!pgUrl) {
  console.error("Set PG_URL to the demo database");
  process.exit(1);
}

const client = new pg.Client({ connectionString: pgUrl });
await client.connect();

// CONCURRENTLY can't run inside the multi-statement demo.sql; it fails on the
// duplicate emails and leaves an invalid index behind, which is the point.
await client
  .query("CREATE UNIQUE INDEX CONCURRENTLY newsletter_signups_email_idx ON newsletter_signups (email)")
  .catch(() => {});

await client.query("SELECT extensions.pg_stat_statements_reset()");

const run = (sql, params = []) => client.query(sql, params);
for (let i = 1; i <= 30; i++) {
  await run("SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC", [i * 37]);
  await run("SELECT id, name FROM customers WHERE lower(email) = $1", [`customer${i}@example.com`]);
  await run("SELECT * FROM orders ORDER BY created_at DESC LIMIT $1", [20]);
  await run(
    "SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = $1 AND o.total > $2 ORDER BY o.total DESC LIMIT $3",
    ["paid", 800, 50],
  );
  await run("SELECT count(*) FROM order_items WHERE product_id = $1", [i]);
  if (i % 3 === 0) {
    await run(
      "SELECT date_trunc('day', created_at) AS day, sum(total) FROM orders WHERE created_at > now() - $1::interval GROUP BY 1 ORDER BY 1",
      ["10 days"],
    );
    await run("SELECT id, name FROM customers WHERE email LIKE $1", [`%${i}9%`]);
  }
}

if ((await client.query("SELECT current_setting('server_version_num')::int AS v")).rows[0].v >= 150000) {
  await client.query("SELECT pg_stat_force_next_flush()");
}
await client.end();
console.log("Workload done");
