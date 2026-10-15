import { describe, expect, it } from "vitest";
import { highlightSql, prettySql } from "@/ui/highlight";
import { displayColumns, formatBytes, formatMetric, formatMs, formatNumber, oneLine } from "@/core/format";
import { runCheck, sortFindings } from "@/core/engine";
import { DEFAULT_SETTINGS, type Check, type Finding } from "@/core/types";

describe("highlightSql", () => {
  it("escapes HTML in query text (it is rendered with v-html)", () => {
    const html = highlightSql(`SELECT '<img src=x onerror=alert(1)>' AS "<b>", 1 -- </pre><script>`);
    expect(html).not.toMatch(/<img|<b>|<script|<\/pre>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  it("marks keywords, strings, numbers, params and comments", () => {
    const html = highlightSql("SELECT 'a', 1, $1 -- c");
    expect(html).toBe(
      '<span class="kw">SELECT</span> <span class="str">\'a\'</span>, <span class="num">1</span>, ' +
        '<span class="param">$1</span> <span class="cmt">-- c</span>',
    );
  });
});

describe("prettySql", () => {
  it("breaks one-line queries at clauses", () => {
    expect(prettySql("SELECT a FROM t WHERE x = $1 AND y = $2 ORDER BY a LIMIT $3")).toBe(
      "SELECT a\nFROM t\nWHERE x = $1\n  AND y = $2\nORDER BY a\nLIMIT $3",
    );
  });

  it("leaves multi-line queries alone", () => {
    expect(prettySql("SELECT 1\nFROM t ")).toBe("SELECT 1\nFROM t");
  });
});

describe("formatting", () => {
  it("formats values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.00 GB");
    expect(formatMs(0.5)).toBe("0.50 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(90_000)).toBe("1.5 min");
    expect(formatNumber(1_234_567)).toBe("1.2M");
    expect(formatMetric(null)).toBe("—");
    expect(formatMetric("2026-01-01T00:00:00Z", "datetime")).not.toBe("never");
    expect(oneLine("SELECT\n  1,\n  2", 10)).toBe("SELECT 1,…");
    expect(displayColumns(["(lower(email))", "created_at DESC"])).toBe("lower(email), created_at DESC");
  });
});

describe("engine", () => {
  const base = { category: "queries" as const, title: "t", description: "d" };
  const runner = { query: async () => [], queryMulti: async () => [] };

  it("isolates a failing check", async () => {
    const check: Check = { ...base, id: "boom", run: async () => { throw new Error("permission denied for view x"); } };
    const r = await runCheck(check, runner, {} as never, DEFAULT_SETTINGS);
    expect(r.status).toBe("error");
    expect(r.message).toBe("permission denied for view x");
  });

  it("skips checks that can't run in this environment", async () => {
    const check: Check = { ...base, id: "skip", unavailableReason: () => "Needs X", run: async () => ({ findings: [] }) };
    const r = await runCheck(check, runner, {} as never, DEFAULT_SETTINGS);
    expect(r).toMatchObject({ status: "skipped", message: "Needs X" });
  });

  it("reports a check that couldn't examine anything as skipped", async () => {
    const check: Check = { ...base, id: "inc", run: async () => ({ findings: [], inconclusive: true, note: "why" }) };
    const r = await runCheck(check, runner, {} as never, DEFAULT_SETTINGS);
    expect(r).toMatchObject({ status: "skipped", message: "why" });
  });

  it("sorts findings by severity", () => {
    const f = (severity: Finding["severity"]) => ({ severity }) as Finding;
    expect(sortFindings([f("info"), f("critical"), f("warning")]).map((x) => x.severity)).toEqual([
      "critical",
      "warning",
      "info",
    ]);
  });
});
