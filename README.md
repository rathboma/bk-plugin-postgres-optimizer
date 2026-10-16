# Postgres Optimizer for Beekeeper Studio

Find slow queries, missing indexes and other performance problems in PostgreSQL, and get the SQL to fix them, without leaving [Beekeeper Studio](https://www.beekeeperstudio.io).

![Postgres Optimizer running in Beekeeper Studio](docs/demo.gif)

*Recorded in Beekeeper Studio 6.1.5 against the demo database in [`dev/demo.sql`](dev/demo.sql). More [screenshots](#screenshots) below.*

It does what people usually piece together by hand from `pg_stat_statements`, `EXPLAIN`, the statistics views and tools like [PgHero](https://github.com/ankane/pghero):

**Slow and expensive queries**
- Slowest queries by average time, and the ones using the biggest share of total database time
- Queries spilling sorts and hashes to disk, and queries reading mostly from disk
- Queries running right now for longer than a threshold
- A sortable top-queries table from `pg_stat_statements`

**Missing and bad indexes**
- Index suggestions for your most expensive queries, found by reading their query plans. With [hypopg](https://github.com/HypoPG/hypopg) installed, every suggestion is tested with a hypothetical index first, so you only see indexes the planner would actually use
- Foreign keys without an index
- Large tables that are mostly read with sequential scans
- Unused, duplicate and redundant indexes
- Invalid indexes left behind by a failed `CREATE INDEX CONCURRENTLY`

**Other performance problems**
- Dead rows piling up, missing or stale planner statistics, autovacuum turned off
- Transaction ID wraparound risk, sequences running out of values
- Memory, planner, checkpoint and monitoring settings, judged against what the server is actually doing (e.g. `work_mem` is only flagged when queries write temp files)
- JIT compilation overhead, inactive replication slots
- Connection usage, sessions idle in a transaction, long transactions, lock waits, abandoned prepared transactions

**Query analyzer**

Paste a query to see its plan, the slow steps, row misestimates, disk spills and index suggestions. Queries copied from `pg_stat_statements` with `$1` placeholders are planned generically.

The plugin also adds **Analyze Query Performance** to the query editor's right-click menu. In Beekeeper Studio 6.1.5 that menu fails for every plugin item (the host calls the handler with the wrong arguments), so the entry does nothing until that is fixed in Beekeeper Studio.

## Safe by design

- The optimizer only reads. It queries the statistics views and catalogs and runs `EXPLAIN`.
- Fixes are never run for you. Each one opens in a query tab so you can review it, and is labelled *Safe to run*, *Review first* or *Destructive*.
- `EXPLAIN ANALYZE` executes the query, so it is opt-in, limited to `SELECT` statements, and runs inside a read-only transaction with a statement timeout. A function that tries to write fails instead of writing.
- hypopg indexes exist only inside the optimizer's own session and are never built.
- Works on read-only connections.

## Requirements

- Beekeeper Studio 5.4 or newer
- PostgreSQL 12 or newer (tested on 13, 16, 17 and 18)
- [`pg_stat_statements`](https://www.postgresql.org/docs/current/pgstatstatements.html) for the query checks. The optimizer tells you how to enable it if it isn't.
- Optional: [`hypopg`](https://hypopg.readthedocs.io/) to verify index suggestions
- A role that can read statistics. Superuser isn't needed; `pg_read_all_stats` (or `pg_monitor`) lets you see queries from every role.

## Usage

1. Connect to a PostgreSQL database.
2. Open **Tools → Postgres Optimizer**, or pick it from the new tab dropdown.
3. Checks run automatically. Click a finding for details, the suggested fix and actions.

Use the gear icon to change thresholds such as what counts as a slow query or a large table. Dismissed findings stay hidden for that connection until you restore them. The table icon next to each check shows the raw rows behind it, which you can copy as CSV.

## How it works

The plugin is built so other databases can be added later without touching the UI.

```
src/
  core/              database-agnostic model and engine
    types.ts         Check, Finding, DatabaseAdapter, QueryRunner, ...
    engine.ts        runs checks, isolating failures
    registry.ts      maps Beekeeper's databaseType to an adapter
  adapters/
    postgres/        the PostgreSQL adapter
      environment.ts version, extensions, privileges, settings
      queryStats.ts  pg_stat_statements, across extension versions
      checks/        one file per category
      explain/       plan parsing, plan analysis, index advice
  host/beekeeper.ts  the only file that talks to the plugin API
  ui/                Vue 3 components
```

A check is a small object with an id, a category and a `run()` that returns findings. Each finding has a severity, a description, metrics, and optionally a fix (SQL plus a safety label) and the query it is about. An adapter bundles checks for one engine with optional extras (top queries, live activity, EXPLAIN). To support MySQL, for example, write an adapter using `performance_schema` and the `sys` schema, and register it in `core/registry.ts`.

## Development

```bash
yarn install
yarn dev        # Vite dev server with hot reload
yarn build      # type check and build to dist/
yarn test       # unit tests
```

To load it in Beekeeper Studio, link the project into the plugins directory (the link name must match the `id` in `manifest.json`) and run `yarn dev`:

```bash
# Linux
ln -s "$(pwd)" ~/.config/beekeeper-studio/plugins/bk-plugin-postgres-optimizer
# macOS
ln -s "$(pwd)" ~/Library/Application\ Support/beekeeper-studio/plugins/bk-plugin-postgres-optimizer
```

### Demo data

[`dev/demo.sql`](dev/demo.sql) builds a small shop database with one of each problem the optimizer looks for, and [`dev/demo-workload.mjs`](dev/demo-workload.mjs) runs queries against it so `pg_stat_statements` has something to show. The video and screenshots in this README use it.

```bash
createdb shop
psql shop -f dev/demo.sql
PG_URL=postgres://localhost/shop node dev/demo-workload.mjs
```

The server needs `pg_stat_statements` in `shared_preload_libraries`, and the hypopg extension package installed.

### Integration tests

Integration tests run every check against a real server. They create and drop their own scratch databases.

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 \
  postgres:17 -c shared_preload_libraries=pg_stat_statements
PG_URL=postgres://postgres:postgres@localhost:5432/postgres yarn test:integration
```

If hypopg is installed on the server, suggestion validation is tested too.

### Dev harness

`dev/` contains a stand-in for Beekeeper Studio: a page that hosts the built plugin in an iframe, answers its API requests, and runs its queries against any database. It's handy for working on the UI without restarting the app.

```bash
yarn build
PG_URL=postgres://postgres:postgres@localhost:5432/mydb yarn harness
# open http://localhost:4600  (add ?theme=light, ?readonly=1, or ?sql=... to test the editor entry point)
```

## Releasing

Bump `version` in `manifest.json` and `package.json`, then push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow builds the plugin and creates a draft GitHub release with `manifest.json` and `bk-plugin-postgres-optimizer-<version>.zip`. Publish the draft to make it available.

## License

GPL-3.0

## Screenshots

**Overview:** every check, grouped by category and ranked by severity.

![Overview](docs/screenshots/01-overview.png)

**Index suggestions:** read from the plans of your most expensive queries and verified with a hypothetical index.

![Index suggestions](docs/screenshots/02-index-suggestions.png)

**Fixes open in a query tab:** review the SQL and run it yourself.

![Fix opened in a query tab](docs/screenshots/03-fix-in-query-tab.png)

**Top queries** from `pg_stat_statements`, sortable by total time, mean time, calls, disk reads and temp files.

![Top queries](docs/screenshots/04-top-queries.png)

**Query analyzer:** plan tree with time per step, issues and index suggestions, here after `EXPLAIN ANALYZE`.

![Query analyzer](docs/screenshots/05-query-analyzer.png)

**Tables & maintenance:** dead rows, stale statistics, sequences close to their limit, autovacuum settings.

![Tables and maintenance](docs/screenshots/06-maintenance.png)

**Configuration:** settings compared with what the server is actually doing.

![Configuration](docs/screenshots/07-configuration.png)

**Raw data:** the rows behind any check, ready to copy as CSV.

![Raw data behind a check](docs/screenshots/08-raw-data.png)
