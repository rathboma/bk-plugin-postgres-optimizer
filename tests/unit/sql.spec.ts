import { describe, expect, it } from "vitest";
import {
  countStatements,
  indexName,
  parameterCount,
  qualifiedName,
  quoteIdent,
  quoteLiteral,
  repairNormalizedQuery,
  statementKind,
  stripSqlNoise,
  tagged,
} from "@/adapters/postgres/sql";
import { parsePgArray, toStringArray } from "@/adapters/postgres/rows";
import { pgssExpressions } from "@/adapters/postgres/queryStats";

describe("identifiers and literals", () => {
  it("quotes only when needed", () => {
    expect(quoteIdent("orders")).toBe("orders");
    expect(quoteIdent("Orders")).toBe('"Orders"');
    expect(quoteIdent("order")).toBe('"order"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(qualifiedName("public", "user")).toBe('public."user"');
  });

  it("escapes literals", () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral("a\\b")).toBe("E'a\\\\b'");
  });

  it("builds index names within the 63 byte limit", () => {
    expect(indexName("orders", ["customer_id"])).toBe("orders_customer_id_idx");
    const long = indexName("a_really_long_table_name_for_testing_purposes", ["first_long_column_name", "second_long_column_name"]);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("_idx")).toBe(true);
  });

  it("tags statements after the first keyword", () => {
    expect(tagged("  SELECT 1")).toBe("SELECT /* bks-optimizer */ 1");
    expect(tagged("EXPLAIN (FORMAT JSON) SELECT 1")).toBe("EXPLAIN /* bks-optimizer */ (FORMAT JSON) SELECT 1");
  });
});

describe("statement inspection", () => {
  it("strips comments and strings", () => {
    expect(stripSqlNoise("SELECT 'DELETE' -- DELETE\n/* UPDATE */ FROM t")).toBe("SELECT ''  \n  FROM t");
    expect(stripSqlNoise("SELECT $$ DROP TABLE x $$")).toBe("SELECT ''");
  });

  it("counts statements ignoring semicolons in strings and comments", () => {
    expect(countStatements("SELECT ';'; -- ;\n")).toBe(1);
    expect(countStatements("SELECT 1; SELECT 2;")).toBe(2);
  });

  it.each([
    ["SELECT * FROM t", "select"],
    ["  (SELECT 1)", "select"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "select"],
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "dml"],
    ["SELECT 'delete from t'", "select"],
    ["UPDATE t SET a = 1", "dml"],
    ["SELECT * INTO new_table FROM t", "utility"],
    ["VACUUM t", "utility"],
    ["", "unknown"],
  ])("%s → %s", (sql, kind) => {
    expect(statementKind(sql)).toBe(kind);
  });

  it("finds the highest placeholder", () => {
    expect(parameterCount("SELECT * FROM t WHERE a = $1 AND b IN ($2, $10)")).toBe(10);
    expect(parameterCount("SELECT '$1'")).toBe(0);
  });

  it("repairs normalized interval literals", () => {
    expect(repairNormalizedQuery("SELECT now() - interval $1;")).toBe("SELECT now() - $1::interval");
  });
});

describe("array parsing", () => {
  it("handles every shape drivers return", () => {
    expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(toStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(toStringArray("{a,b}")).toEqual(["a", "b"]);
    expect(parsePgArray('{"a,b","c\\"d",NULL,e}')).toEqual(["a,b", 'c"d', "e"]);
    expect(toStringArray(null)).toEqual([]);
  });
});

describe("pg_stat_statements column compatibility", () => {
  it("uses exec + plan time on PostgreSQL 13+", () => {
    const e = pgssExpressions(["total_exec_time", "total_plan_time", "mean_exec_time", "toplevel", "queryid", "shared_blk_read_time"]);
    expect(e.totalTime).toBe("(s.total_exec_time + s.total_plan_time)");
    expect(e.meanTime).toBe("s.mean_exec_time");
    expect(e.toplevel).toBe("AND s.toplevel");
    expect(e.ioTime).toBe("s.shared_blk_read_time");
  });

  it("falls back to the pre-13 column names", () => {
    const e = pgssExpressions(["total_time", "mean_time", "blk_read_time", "blk_write_time", "queryid"]);
    expect(e.totalTime).toBe("s.total_time");
    expect(e.meanTime).toBe("s.mean_time");
    expect(e.ioTime).toBe("s.blk_read_time + s.blk_write_time");
    expect(e.toplevel).toBe("");
    expect(e.jitTime).toBeNull();
  });
});
