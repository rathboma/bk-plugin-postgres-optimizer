import { describe, expect, it } from "vitest";
import { findRedundantIndexes, isCoveredBy, type IndexInfo } from "@/adapters/postgres/indexCatalog";

let n = 0;
function ix(name: string, cols: number[], extra: Partial<IndexInfo> = {}): IndexInfo {
  return {
    schema: "public",
    table: "orders",
    name,
    method: "btree",
    unique: false,
    primary: false,
    valid: true,
    keyColumns: cols.map((c) => `col${c}`),
    includeColumns: [],
    keyAttnums: cols,
    keyOpclasses: cols.map(() => "3126"),
    keyCollations: cols.map(() => "0"),
    keyOptions: cols.map(() => "0"),
    expressions: null,
    predicate: null,
    definition: `CREATE INDEX ${name} ON public.orders (...)`,
    sizeBytes: 8192 * ++n,
    scans: 0,
    backsConstraint: false,
    tableRows: 1000,
    ...extra,
  };
}

const names = (indexes: IndexInfo[]) => findRedundantIndexes(indexes).map((r) => r.index.name).sort();

describe("findRedundantIndexes", () => {
  it("reports a leading-column prefix of another btree index", () => {
    const result = findRedundantIndexes([ix("a", [1]), ix("ab", [1, 2])]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ index: { name: "a" }, coveredBy: { name: "ab" }, exactDuplicate: false });
  });

  it("does not contradict the unused-index check", () => {
    // The covering index is never used but the smaller one is: keep the smaller one.
    expect(names([ix("a", [1], { scans: 50 }), ix("ab", [1, 2], { scans: 0 })])).toEqual([]);
    expect(names([ix("a", [1], { scans: 50 }), ix("ab", [1, 2], { scans: 5 })])).toEqual(["a"]);
  });

  it("does not report a non-leading subset", () => {
    expect(names([ix("b", [2]), ix("ab", [1, 2])])).toEqual([]);
  });

  it("reports only one of two identical indexes", () => {
    const result = findRedundantIndexes([ix("x", [1, 2]), ix("y", [1, 2])]);
    expect(result).toHaveLength(1);
    expect(result[0].exactDuplicate).toBe(true);
  });

  it("keeps the index that backs a constraint", () => {
    const result = findRedundantIndexes([
      ix("orders_code_key", [3], { unique: true, backsConstraint: true }),
      ix("orders_code_uniq", [3], { unique: true }),
    ]);
    expect(result.map((r) => r.index.name)).toEqual(["orders_code_uniq"]);
  });

  it("never reports primary keys or unique indexes covered by non-unique ones", () => {
    expect(names([ix("pk", [1], { primary: true, unique: true }), ix("ab", [1, 2])])).toEqual([]);
    expect(names([ix("u", [1], { unique: true }), ix("ab", [1, 2])])).toEqual([]);
  });

  it("requires the same predicate, expressions, method and sort options", () => {
    expect(names([ix("a", [1], { predicate: "(status = 'x')" }), ix("ab", [1, 2])])).toEqual([]);
    expect(names([ix("e", [0], { expressions: "lower(email)" }), ix("ab", [0, 2])])).toEqual([]);
    expect(names([ix("h", [1], { method: "hash" }), ix("ab", [1, 2])])).toEqual([]);
    expect(names([ix("desc", [1], { keyOptions: ["3"] }), ix("ab", [1, 2])])).toEqual([]);
  });

  it("ignores invalid indexes on either side", () => {
    expect(names([ix("a", [1]), ix("ab", [1, 2], { valid: false })])).toEqual([]);
  });

  it("requires INCLUDE columns to be available in the covering index", () => {
    const a = ix("a_inc", [1], { includeColumns: ["col9"] });
    expect(isCoveredBy(a, ix("ab", [1, 2]))).toBe(false);
    expect(isCoveredBy(a, ix("ab_inc", [1, 2], { includeColumns: ["col9"] }))).toBe(true);
  });

  it("only compares indexes on the same table", () => {
    expect(names([ix("a", [1]), ix("ab", [1, 2], { table: "customers" })])).toEqual([]);
  });

  it("for non-btree methods only identical keys count", () => {
    expect(names([ix("g1", [1], { method: "gist" }), ix("g12", [1, 2], { method: "gist" })])).toEqual([]);
    expect(names([ix("g1", [1], { method: "gist" }), ix("g1b", [1], { method: "gist" })])).toHaveLength(1);
  });
});
