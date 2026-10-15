// Dev harness: runs the built plugin outside Beekeeper Studio against a real
// PostgreSQL database. The harness page plays the part of the app, answering
// the plugin's postMessage requests; this server runs its queries.
//
//   yarn build && PG_URL=postgres://user:pass@localhost:5432/db node dev/server.mjs
//   open http://localhost:4600
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 4600);
const pgUrl = process.env.PG_URL;
if (!pgUrl) {
  console.error("Set PG_URL, e.g. PG_URL=postgres://postgres@localhost:5432/postgres");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

async function serveFile(res, file) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function runQuery(sql) {
  const client = await pool.connect();
  try {
    // Plain text query = simple protocol, so multiple statements run in one
    // implicit transaction, the same as in Beekeeper Studio.
    const res = await client.query(sql);
    const list = Array.isArray(res) ? res : [res];
    return {
      results: list.map((r) => ({
        fields: (r.fields ?? []).map((f) => ({ id: f.name, name: f.name })),
        rows: r.rows ?? [],
      })),
    };
  } finally {
    client.release();
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/query") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { query } = JSON.parse(body);
        const result = await runQuery(query);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/info") {
      const db = new URL(pgUrl).pathname.slice(1) || "postgres";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ databaseName: db }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile(res, path.join(root, "dev", "harness.html"));
    }
    if (url.pathname.startsWith("/plugin/")) {
      const rel = path.normalize(url.pathname.slice("/plugin/".length)).replace(/^(\.\.[/\\])+/, "");
      return serveFile(res, path.join(root, "dist", rel));
    }
    res.writeHead(404).end("not found");
  })
  .listen(port, () => console.log(`Harness on http://localhost:${port}`));
