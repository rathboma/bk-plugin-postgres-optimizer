import { describe, expect, it } from "vitest";
import {
  conditionsFor,
  parseColumnRef,
  parseConditions,
  parseSortKey,
  splitTopLevel,
  stripOuterParens,
} from "@/adapters/postgres/explain/filterParser";

describe("parseColumnRef", () => {
  it.each([
    ["status", { column: "status" }],
    ["o.status", { qualifier: "o", column: "status" }],
    ["(status)::text", { column: "status" }],
    ["((o.email)::text)", { qualifier: "o", column: "email" }],
    ['"Order Items"."Price"', { qualifier: "Order Items", column: "Price" }],
    ["created_at::timestamp without time zone", { column: "created_at" }],
    ["(name)::character varying(255)", { column: "name" }],
  ])("%s", (input, expected) => {
    expect(parseColumnRef(input)).toEqual(expected);
  });

  it("recognizes lower()/upper() expressions", () => {
    expect(parseColumnRef("lower((c.email)::text)")).toEqual({
      qualifier: "c",
      column: "email",
      expression: "lower(email)",
    });
  });

  it("rejects literals, parameters and other functions", () => {
    expect(parseColumnRef("'active'::text")).toBeNull();
    expect(parseColumnRef("$1")).toBeNull();
    expect(parseColumnRef("42")).toBeNull();
    expect(parseColumnRef("now()")).toBeNull();
    expect(parseColumnRef("CURRENT_DATE")).toBeNull();
    expect(parseColumnRef("(SubPlan 1)")).toBeNull();
  });
});

describe("parseConditions", () => {
  it("splits ANDed conditions and classifies operators", () => {
    const conds = parseConditions(
      "(((o.status)::text = 'paid'::text) AND (o.created_at >= $1) AND (o.deleted_at IS NULL))",
    );
    expect(conds.map((c) => [c.column, c.op, c.kind])).toEqual([
      ["status", "=", "eq"],
      ["created_at", ">=", "range"],
      ["deleted_at", "IS NULL", "null"],
    ]);
  });

  it("treats = ANY as equality", () => {
    const [c] = parseConditions("((status)::text = ANY ('{new,paid}'::text[]))");
    expect(c).toMatchObject({ column: "status", op: "= ANY", kind: "eq" });
  });

  it("flags LIKE patterns with a leading wildcard", () => {
    expect(parseConditions("((name)::text ~~ '%smith%'::text)")[0]).toMatchObject({ kind: "like", leadingWildcard: true });
    expect(parseConditions("((name)::text ~~ 'smi%'::text)")[0]).toMatchObject({ kind: "like", leadingWildcard: false });
  });

  it("flips reversed comparisons", () => {
    expect(parseConditions("(42 < o.total)")[0]).toMatchObject({ column: "total", op: ">", kind: "range" });
  });

  it("ignores OR expressions, which a single btree index can't serve", () => {
    expect(parseConditions("((a = 1) OR (b = 2))")).toEqual([]);
  });

  it("keeps ANDed conditions next to a nested OR", () => {
    const conds = parseConditions("((tenant_id = 7) AND ((a = 1) OR (b = 2)))");
    expect(conds.map((c) => c.column)).toEqual(["tenant_id"]);
  });

  it("is not fooled by AND inside string literals", () => {
    const conds = parseConditions("((note)::text = 'this AND that'::text)");
    expect(conds).toHaveLength(1);
    expect(conds[0].column).toBe("note");
  });

  it("reports column-to-column comparisons as joins", () => {
    const [c] = parseConditions("(o.customer_id = c.id)");
    expect(c).toMatchObject({ qualifier: "o", column: "customer_id", joinTo: { qualifier: "c", column: "id" } });
  });

  it("returns nothing for empty input", () => {
    expect(parseConditions(undefined)).toEqual([]);
    expect(parseConditions("")).toEqual([]);
  });
});

describe("conditionsFor", () => {
  it("keeps only the conditions on the given alias", () => {
    const conds = conditionsFor("((o.status = 'x'::text) AND (c.region = 'eu'::text))", "o");
    expect(conds.map((c) => c.column)).toEqual(["status"]);
  });

  it("picks the side of a join condition that belongs to the alias", () => {
    const [c] = conditionsFor("(c.id = o.customer_id)", "o");
    expect(c).toMatchObject({ qualifier: "o", column: "customer_id", kind: "eq" });
  });
});

describe("helpers", () => {
  it("strips only parens that wrap the whole expression", () => {
    expect(stripOuterParens("((a = 1))")).toBe("a = 1");
    expect(stripOuterParens("(a = 1) AND (b = 2)")).toBe("(a = 1) AND (b = 2)");
  });

  it("splits at the top level only", () => {
    expect(splitTopLevel("(a AND b) AND c", "AND")).toEqual(["(a AND b)", "c"]);
  });

  it("parses sort keys", () => {
    expect(parseSortKey("o.created_at DESC")).toEqual({ ref: { qualifier: "o", column: "created_at" }, desc: true });
    expect(parseSortKey("name NULLS FIRST")).toEqual({ ref: { column: "name" }, desc: false });
  });
});
