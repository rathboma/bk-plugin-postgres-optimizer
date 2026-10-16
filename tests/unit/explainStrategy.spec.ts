import { describe, expect, it } from "vitest";
import { buildExplain } from "@/adapters/postgres/explain/explain";
import type { PostgresEnvironment } from "@/adapters/postgres/environment";

function env(versionNum: number, readOnly = false): PostgresEnvironment {
  return {
    versionNum,
    readOnly,
    capabilities: {
      genericPlans: versionNum >= 160000,
      preparedGenericPlans: versionNum >= 120000 && !readOnly,
    },
  } as unknown as PostgresEnvironment;
}

const plan = (r: ReturnType<typeof buildExplain>) => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("buildExplain", () => {
  it("uses plain EXPLAIN for queries without placeholders", () => {
    const r = plan(buildExplain(env(160000), "SELECT * FROM t WHERE a = 1"));
    expect(r.statements).toEqual(["EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM t WHERE a = 1\n"]);
  });

  it("uses GENERIC_PLAN on PostgreSQL 16+", () => {
    const r = plan(buildExplain(env(160000), "SELECT * FROM t WHERE a = $1"));
    expect(r.statements[0]).toMatch(/^EXPLAIN \(GENERIC_PLAN, VERBOSE, FORMAT JSON\)/);
  });

  it("uses PREPARE with a forced generic plan on PostgreSQL 12-15", () => {
    const r = plan(buildExplain(env(130000), "SELECT * FROM t WHERE a = $1 AND b = $2"));
    expect(r.statements[0]).toBe("SET LOCAL plan_cache_mode = force_generic_plan");
    expect(r.statements[1]).toMatch(/^PREPARE bks_optimizer_\w+ AS SELECT/);
    expect(r.statements[2]).toMatch(/EXECUTE bks_optimizer_\w+\(NULL, NULL\)$/);
    expect(r.statements[3]).toMatch(/^DEALLOCATE bks_optimizer_/);
    expect(r.planIndex).toBe(2);
  });

  it("explains placeholders on old servers only when it can PREPARE", () => {
    expect(buildExplain(env(130000, true), "SELECT $1")).toHaveProperty("error");
    expect(buildExplain(env(110000), "SELECT $1")).toHaveProperty("error");
  });

  it("refuses multiple statements and utility commands", () => {
    expect(buildExplain(env(160000), "SELECT 1; DROP TABLE t")).toHaveProperty("error");
    expect(buildExplain(env(160000), "CREATE INDEX ON t (a)")).toHaveProperty("error");
    expect(buildExplain(env(160000), "   ")).toHaveProperty("error");
  });

  it("keeps a trailing line comment from swallowing the separator", () => {
    const r = plan(buildExplain(env(130000), "SELECT * FROM t WHERE a = $1 -- note"));
    expect(r.statements[1].endsWith("-- note\n")).toBe(true);
  });
});
