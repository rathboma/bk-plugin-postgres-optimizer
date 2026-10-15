import type { PlanNode, Row } from "@/core/types";
import { toNumber } from "@/core/format";

export interface RawExplain {
  Plan: Row;
  "Planning Time"?: number;
  "Execution Time"?: number;
  JIT?: Row;
}

/** EXPLAIN (FORMAT JSON) returns a one-element array. */
export function unwrapExplain(value: unknown): RawExplain {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || typeof v !== "object" || !("Plan" in (v as object))) {
    throw new Error("Unexpected EXPLAIN output");
  }
  return v as RawExplain;
}

const DETAIL_KEYS: [string, string][] = [
  ["Index Cond", "Index Cond"],
  ["Recheck Cond", "Recheck Cond"],
  ["Filter", "Filter"],
  ["Rows Removed by Filter", "Rows Removed by Filter"],
  ["Rows Removed by Index Recheck", "Rows Removed by Index Recheck"],
  ["Join Filter", "Join Filter"],
  ["Rows Removed by Join Filter", "Rows Removed by Join Filter"],
  ["Hash Cond", "Hash Cond"],
  ["Merge Cond", "Merge Cond"],
  ["Sort Key", "Sort Key"],
  ["Presorted Key", "Presorted Key"],
  ["Sort Method", "Sort Method"],
  ["Group Key", "Group Key"],
  ["Heap Fetches", "Heap Fetches"],
  ["Hash Batches", "Hash Batches"],
  ["Peak Memory Usage", "Peak Memory (kB)"],
  ["Lossy Heap Blocks", "Lossy Heap Blocks"],
  ["Workers Planned", "Workers Planned"],
  ["Workers Launched", "Workers Launched"],
  ["Shared Hit Blocks", "Shared Hit Blocks"],
  ["Shared Read Blocks", "Shared Read Blocks"],
  ["Temp Written Blocks", "Temp Written Blocks"],
];

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

function detailValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Convert one raw EXPLAIN JSON node (and its children) into a PlanNode. */
export function normalizePlan(raw: Row, counter = { next: 0 }): PlanNode {
  const id = counter.next++;
  const children = ((raw["Plans"] as Row[] | undefined) ?? []).map((c) => normalizePlan(c, counter));
  const loops = raw["Actual Loops"] === undefined ? undefined : toNumber(raw["Actual Loops"]);
  const actualTotalMs =
    raw["Actual Total Time"] === undefined ? undefined : toNumber(raw["Actual Total Time"]) * (loops || 1);

  const details: PlanNode["details"] = [];
  for (const [key, label] of DETAIL_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") {
      details.push({ label, value: detailValue(raw[key]) });
    }
  }
  if (raw["Sort Space Used"] !== undefined) {
    details.push({ label: "Sort Space", value: `${raw["Sort Space Used"]} kB (${raw["Sort Space Type"]})` });
  }

  const node: PlanNode = {
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
    actualRows: raw["Actual Rows"] === undefined ? undefined : toNumber(raw["Actual Rows"]),
    loops,
    totalCost: toNumber(raw["Total Cost"]),
    actualTotalMs,
    details,
    children,
    raw,
  };

  if (actualTotalMs !== undefined) {
    // CTE scans and InitPlans are reported as children but run separately; clamp at 0.
    const childMs = children.reduce((sum, c) => sum + (c.actualTotalMs ?? 0), 0);
    node.selfMs = Math.max(0, actualTotalMs - childMs);
  }
  return node;
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
