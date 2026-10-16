import { describe, expect, it } from "vitest";
import type { Finding } from "@/core/types";
import { buildRecommendations, firstSentence } from "@/ui/recommendations";

const finding = (over: Partial<Finding>): Finding => ({
  key: over.key ?? `${over.checkId}:${over.title}`,
  checkId: "dead-tuples",
  category: "tables",
  severity: "warning",
  title: "t",
  description: "d",
  ...over,
});

describe("buildRecommendations", () => {
  it("orders by severity, then by what matters most within a severity", () => {
    const recs = buildRecommendations([
      finding({ checkId: "dead-tuples", title: "vacuum" }),
      finding({ checkId: "config-work-mem", title: "setting", severity: "info" }),
      finding({ checkId: "index-suggestions", title: "index" }),
      finding({ checkId: "sequence-exhaustion", title: "sequence", severity: "critical" }),
      finding({ checkId: "unused-indexes", title: "unused" }),
    ]);
    expect(recs.map((r) => r.finding.title)).toEqual(["sequence", "index", "unused", "vacuum", "setting"]);
  });

  it("merges findings that recommend the same change", () => {
    const fk = finding({ checkId: "unindexed-foreign-keys", title: "fk", groupKey: "index:public.orders(customer_id)" });
    const suggestion = finding({ checkId: "index-suggestions", title: "plan", groupKey: "index:public.orders(customer_id)" });
    const other = finding({ checkId: "index-suggestions", title: "other", groupKey: "index:public.orders(status)" });
    const recs = buildRecommendations([fk, other, suggestion]);
    expect(recs.map((r) => r.finding.title)).toEqual(["other", "plan"]);
    expect(recs[1].related).toEqual([fk]);
  });
});

describe("firstSentence", () => {
  it("stops at the end of the first sentence", () => {
    expect(firstSentence("The foreign key to customers has no index. Joins are slow.")).toBe(
      "The foreign key to customers has no index.",
    );
  });

  it("is not fooled by numbers and abbreviations", () => {
    expect(firstSentence("Uses 1.5 GB, e.g. for sorts. More text.")).toBe("Uses 1.5 GB, e.g. for sorts.");
  });

  it("returns text without a full stop as is", () => {
    expect(firstSentence("No full stop here")).toBe("No full stop here");
  });
});
