import type { PlanNode, Row } from "@/core/types";
import { toNumber } from "@/core/format";

export interface RawExplain {
  Plan: Row;
}

/** EXPLAIN (FORMAT JSON) returns a one-element array. */
export function unwrapExplain(value: unknown): RawExplain {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || typeof v !== "object" || !("Plan" in (v as object))) {
    throw new Error("Unexpected EXPLAIN output");
  }
  return v as RawExplain;
}

function describe(raw: Row): string {
  const type = String(raw["Node Type"] ?? "Unknown");
  const parts = [type];
  if (raw["Join Type"] && raw["Join Type"] !== "Inner") parts[0] = `${type} (${raw["Join Type"]})`;
  if (raw["Strategy"] && type === "Aggregate") parts[0] = `${raw["Strategy"]} Aggregate`;
  if (raw["Index Name"]) parts.push(`using ${raw["Index Name"]}`);
  if (raw["Relation Name"]) {
    const rel = raw["Schema"] ? `${raw["Schema"]}.${raw["Relation Name"]}` : String(raw["Relation Name"]);
    const alias = raw["Alias"] && raw["Alias"] !== raw["Relation Name"] ? ` ${raw["Alias"]}` : "";
    parts.push(`on ${rel}${alias}`);
  } else if (raw["CTE Name"]) {
    parts.push(`on ${raw["CTE Name"]}`);
  } else if (raw["Function Name"]) {
    parts.push(`on ${raw["Function Name"]}()`);
  }
  return parts.join(" ");
}

/** Convert one raw EXPLAIN JSON node (and its children) into a PlanNode. */
export function normalizePlan(raw: Row, counter = { next: 0 }): PlanNode {
  const id = counter.next++;
  const children = ((raw["Plans"] as Row[] | undefined) ?? []).map((c) => normalizePlan(c, counter));
  return {
    id,
    nodeType: String(raw["Node Type"] ?? "Unknown"),
    label: describe(raw),
    relation: raw["Relation Name"]
      ? {
          schema: raw["Schema"] ? String(raw["Schema"]) : undefined,
          name: String(raw["Relation Name"]),
          alias: raw["Alias"] ? String(raw["Alias"]) : undefined,
        }
      : undefined,
    indexName: raw["Index Name"] ? String(raw["Index Name"]) : undefined,
    estimatedRows: toNumber(raw["Plan Rows"]),
    totalCost: toNumber(raw["Total Cost"]),
    children,
    raw,
  };
}

export function walk(node: PlanNode, visit: (node: PlanNode, parent: PlanNode | null) => void, parent: PlanNode | null = null) {
  visit(node, parent);
  node.children.forEach((c) => walk(c, visit, node));
}

export function findNodes(root: PlanNode, predicate: (n: PlanNode) => boolean): PlanNode[] {
  const out: PlanNode[] = [];
  walk(root, (n) => {
    if (predicate(n)) out.push(n);
  });
  return out;
}

export function rawString(node: PlanNode, key: string): string | undefined {
  const v = node.raw[key];
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v.join(", ") : String(v);
}

export function rawNumber(node: PlanNode, key: string): number | undefined {
  const v = node.raw[key];
  return v === undefined || v === null ? undefined : toNumber(v);
}

/** Relations scanned anywhere in the plan, as `schema.name` (schema may be empty). */
export function planRelations(root: PlanNode): { schema?: string; name: string }[] {
  const seen = new Map<string, { schema?: string; name: string }>();
  walk(root, (n) => {
    if (n.relation) seen.set(`${n.relation.schema ?? ""}.${n.relation.name}`, { schema: n.relation.schema, name: n.relation.name });
  });
  return [...seen.values()];
}
