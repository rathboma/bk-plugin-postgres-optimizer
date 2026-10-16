import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePlan, relationKey } from "@/adapters/postgres/explain/planAnalyzer";
import { normalizePlan, unwrapExplain } from "@/adapters/postgres/explain/planModel";
import { chooseColumns, equalityRows, findCoveringIndex, suggestIndexes } from "@/adapters/postgres/explain/indexAdvisor";
import type { IndexInfo } from "@/adapters/postgres/indexCatalog";

// Real EXPLAIN (VERBOSE, FORMAT JSON) output captured from PostgreSQL 16
// against the integration test schema (orders: 120K rows, customers: 30K rows).
function load(name: string) {
  const raw = unwrapExplain(JSON.parse(readFileSync(path.join(__dirname, "fixtures/plans", `${name}.json`), "utf8")));
  return { raw, root: normalizePlan(raw.Plan) };
}

const tableRows = new Map([
  [relationKey("public", "orders"), 120_000],
  [relationKey("public", "customers"), 30_000],
  [relationKey("public", "events"), 20_000],
]);
const ctx = { tableRows, largeTableRows: 10_000 };

const advisor = (indexes: IndexInfo[] = []) => ({
  indexes: new Map([[relationKey("public", "orders"), indexes]]),
  columnStats: new Map([
    ["public.orders.customer_id", { nullFrac: 0, nDistinct: 30_000 }],
    ["public.orders.status", { nullFrac: 0, nDistinct: 4 }],
  ]),
  tableRows,
});

describe("analyzePlan", () => {
  it("flags a filtered seq scan and proposes its columns", () => {
    const { root } = load("seq-scan-filter");
    const { issues, candidates } = analyzePlan(root, ctx);
    expect(issues[0].title).toBe("Sequential scan on public.orders");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].equality.map((c) => c.column)).toEqual(["customer_id"]);
    expect(candidates[0].range.map((c) => c.column)).toEqual(["total"]);
  });

  it("flags a bitmap scan whose filter discards most of what the index found", () => {
    const { root } = load("bitmap-filter");
    const { issues, candidates } = analyzePlan(root, ctx);
    expect(issues[0].title).toBe("Bitmap Heap Scan on public.orders discards most rows it reads");
    expect(candidates[0].equality.map((c) => c.column).sort()).toEqual(["customer_id", "status"]);
  });

  it("orders equality columns by selectivity and stops once rows are few", () => {
    const { root } = load("bitmap-filter");
    const [suggestion] = suggestIndexes(analyzePlan(root, ctx).candidates, advisor());
    // customer_id narrows 120K rows to ~4, so status adds nothing.
    expect(suggestion.columns).toEqual(["customer_id"]);
    expect(suggestion.ddl).toBe("CREATE INDEX CONCURRENTLY orders_customer_id_idx\n  ON public.orders (customer_id);");
  });

  it("marks a suggestion covered by an existing index", () => {
    const { root } = load("bitmap-filter");
    const existing = {
      name: "orders_customer_id_status_idx",
      valid: true,
      predicate: null,
      method: "btree",
      keyColumns: ["customer_id", "status"],
    } as unknown as IndexInfo;
    const [suggestion] = suggestIndexes(analyzePlan(root, ctx).candidates, advisor([existing]));
    expect(suggestion.coveredBy).toBe("orders_customer_id_status_idx");
  });

  it("suggests an index for ORDER BY ... LIMIT over a full sort", () => {
    const { root } = load("top-n-sort");
    const { candidates } = analyzePlan(root, ctx);
    expect(candidates[0].sort).toEqual([{ column: "created_at", expression: undefined, desc: true }]);
    expect(suggestIndexes(candidates, advisor())[0].columns).toEqual(["created_at DESC"]);
  });

  it("sees through Gather Merge in parallel ORDER BY ... LIMIT plans", () => {
    const { root } = load("parallel-top-n");
    const [s] = suggestIndexes(analyzePlan(root, ctx).candidates, advisor());
    expect(s.columns).toEqual(["customer_id", "created_at DESC"]);
  });

  it("suggests an expression index for lower(column)", () => {
    const { root } = load("lower-email");
    const [s] = suggestIndexes(analyzePlan(root, ctx).candidates, advisor());
    expect(s.columns).toEqual(["(lower(email))"]);
    expect(s.ddl).toContain("ON public.customers ((lower(email)))");
  });

  it("suggests a trigram index for LIKE with a leading wildcard", () => {
    const { root } = load("trigram");
    const [s] = suggestIndexes(analyzePlan(root, ctx).candidates, advisor());
    expect(s.method).toBe("gin");
    expect(s.ddl).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(s.ddl).toContain("USING gin (email gin_trgm_ops)");
  });

  it("uses the nested loop's join filter for the inner scan", () => {
    const { root } = load("nested-loop");
    const { candidates } = analyzePlan(root, ctx);
    const orders = candidates.find((c) => c.table === "orders");
    expect(orders?.equality.map((c) => c.column)).toEqual(["customer_id"]);
  });

  it("does not suggest indexes for small tables", () => {
    for (const name of ["seq-scan-filter", "bitmap-filter"]) {
      const { root } = load(name);
      const { candidates, issues } = analyzePlan(root, { ...ctx, largeTableRows: 1_000_000 });
      expect(candidates).toEqual([]);
      expect(issues).toEqual([]);
    }
  });
});

describe("plan model", () => {
  it("labels nodes", () => {
    const { root } = load("hash-batches");
    expect(root.label).toBe("Hash Join");
    expect(root.children[0].label).toBe("Seq Scan on public.orders o");
  });
});

describe("index advisor helpers", () => {
  it("estimates equality matches like the planner", () => {
    expect(equalityRows({ nullFrac: 0, nDistinct: 4 }, 100)).toBe(25);
    expect(equalityRows({ nullFrac: 0.5, nDistinct: -1 }, 100)).toBe(0.5);
    expect(equalityRows(undefined, 100)).toBe(10);
  });

  it("puts one range column after the equality columns", () => {
    const keys = chooseColumns(
      {
        nodeId: 0,
        schema: "public",
        table: "orders",
        equality: [{ column: "status", op: "=", kind: "eq" }],
        range: [{ column: "created_at", op: ">", kind: "range" }, { column: "total", op: "<", kind: "range" }],
        sort: [],
        trigram: [],
        existingIndexColumns: [],
        reason: "",
        rowsExamined: 0,
        rowsReturned: 0,
      },
      advisor(),
    );
    expect(keys.map((k) => k.key)).toEqual(["status", "created_at"]);
  });

  it("matches equality columns in any order when checking coverage", () => {
    const ix = { name: "i", valid: true, predicate: null, method: "btree", keyColumns: ["b", "a", "c"] } as unknown as IndexInfo;
    expect(findCoveringIndex([{ key: "a", sql: "a" }, { key: "b", sql: "b" }], [ix], 2)?.name).toBe("i");
    expect(findCoveringIndex([{ key: "a", sql: "a" }, { key: "c", sql: "c" }], [ix], 2)).toBeUndefined();
  });
});
