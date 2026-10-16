import type { PlanIssue, PlanNode } from "@/core/types";
import { formatNumber, formatPercent } from "@/core/format";
import { qualifiedName } from "../sql";
import type { Condition } from "./filterParser";
import { conditionsFor, parseSortKey } from "./filterParser";
import { rawString, walk } from "./planModel";

/** A place in the plan where an index on `relation` could help. */
export interface IndexCandidate {
  nodeId: number;
  schema?: string;
  table: string;
  /** Equality / IN / IS NULL conditions. */
  equality: Condition[];
  /** Range conditions (<, >, BETWEEN). At most one is used. */
  range: Condition[];
  /** ORDER BY columns that an index could return pre-sorted. */
  sort: { column: string; expression?: string; desc: boolean }[];
  /** Unanchored LIKE / ILIKE, only a trigram index helps. */
  trigram: Condition[];
  /** Columns already used by the index this node scans. */
  existingIndexColumns: string[];
  reason: string;
  /** Rows the node had to look at vs rows it produced, for ranking. */
  rowsExamined: number;
  rowsReturned: number;
}

export interface AnalyzeContext {
  /** Estimated rows per relation, keyed by `schema.table` (lowercase). */
  tableRows: Map<string, number>;
  largeTableRows: number;
}

export interface PlanAnalysis {
  issues: PlanIssue[];
  candidates: IndexCandidate[];
}

export function relationKey(schema: string | undefined, table: string): string {
  return `${schema ?? ""}.${table}`.toLowerCase();
}

function tableRowsFor(ctx: AnalyzeContext, node: PlanNode): number | undefined {
  if (!node.relation) return undefined;
  return (
    ctx.tableRows.get(relationKey(node.relation.schema, node.relation.name)) ??
    ctx.tableRows.get(relationKey(undefined, node.relation.name))
  );
}

function relName(node: PlanNode): string {
  return node.relation ? qualifiedName(node.relation.schema, node.relation.name) : node.label;
}

function splitConditions(conds: Condition[]) {
  return {
    equality: conds.filter((c) => c.kind === "eq" || c.kind === "null"),
    range: conds.filter((c) => c.kind === "range" || (c.kind === "like" && !c.leadingWildcard)),
    trigram: conds.filter((c) => c.kind === "like" && c.leadingWildcard),
  };
}

const SCAN_TYPES = new Set(["Seq Scan", "Parallel Seq Scan"]);
const INDEX_TYPES = new Set(["Index Scan", "Index Only Scan", "Bitmap Heap Scan"]);

/**
 * Rows a bitmap scan fetched and then discarded with its Filter, estimated
 * from the row estimate of its Bitmap Index Scan children.
 */
function rowsDiscardedAfterIndex(node: PlanNode): { removed: number; out: number } | null {
  if (node.nodeType !== "Bitmap Heap Scan" || !node.children.length) return null;
  const bitmapRows = (n: PlanNode): number =>
    n.nodeType === "BitmapAnd"
      ? Math.min(...n.children.map(bitmapRows))
      : n.nodeType === "BitmapOr"
        ? n.children.reduce((sum, c) => sum + bitmapRows(c), 0)
        : n.estimatedRows;
  const fetched = bitmapRows(node.children[0]);
  return { removed: Math.max(0, fetched - node.estimatedRows), out: node.estimatedRows };
}

/** Sort keys from a Sort node directly above `scan` under a Limit, if any. */
function topNSortKeys(scan: PlanNode, parents: Map<number, PlanNode | null>): IndexCandidate["sort"] {
  let p = parents.get(scan.id) ?? null;
  // Allow a Gather / Gather Merge between the sort and the scan.
  while (p && (p.nodeType === "Gather" || p.nodeType === "Gather Merge")) p = parents.get(p.id) ?? null;
  if (!p || (p.nodeType !== "Sort" && p.nodeType !== "Incremental Sort")) return [];
  // Parallel plans put a Gather Merge between the Limit and the Sort.
  let above = parents.get(p.id) ?? null;
  while (above && (above.nodeType === "Gather" || above.nodeType === "Gather Merge")) above = parents.get(above.id) ?? null;
  if (!above || above.nodeType !== "Limit") return [];
  const keys = (p.raw["Sort Key"] as string[] | undefined) ?? [];
  const out: IndexCandidate["sort"] = [];
  for (const k of keys) {
    const parsed = parseSortKey(k);
    const alias = scan.relation?.alias ?? scan.relation?.name;
    if (!parsed || (parsed.ref.qualifier && parsed.ref.qualifier !== alias)) return [];
    out.push({ column: parsed.ref.column, expression: parsed.ref.expression, desc: parsed.desc });
  }
  return out;
}

export function analyzePlan(root: PlanNode, ctx: AnalyzeContext): PlanAnalysis {
  const issues: PlanIssue[] = [];
  const candidates: IndexCandidate[] = [];
  const parents = new Map<number, PlanNode | null>();
  walk(root, (n, parent) => parents.set(n.id, parent));

  walk(root, (node) => {
    const alias = node.relation?.alias ?? node.relation?.name;
    const tableRows = tableRowsFor(ctx, node);
    const large = tableRows !== undefined && tableRows >= ctx.largeTableRows;

    // --- Sequential scans that filter out most of a large table -------------
    if (SCAN_TYPES.has(node.nodeType) && node.relation) {
      const parent = parents.get(node.id) ?? null;
      // The inner side of a nested loop is rescanned once per outer row, and the
      // join condition often sits on the loop as a Join Filter.
      const innerOfLoop = parent?.nodeType === "Nested Loop" && parent.children[1] === node ? parent : null;
      const joinFilter = innerOfLoop ? rawString(innerOfLoop, "Join Filter") : undefined;
      const filter = [rawString(node, "Filter"), joinFilter].filter(Boolean).join(" AND ") || undefined;
      const conds = [
        ...conditionsFor(rawString(node, "Filter"), alias),
        ...conditionsFor(joinFilter, alias),
      ];
      // Parallel workers each scan part of the table, so their scans aren't repeated.
      const loops =
        innerOfLoop && node.raw["Parallel Aware"] !== true
          ? Math.max(1, Math.round(innerOfLoop.children[0].estimatedRows))
          : 1;
      // Per loop: rows produced vs rows looked at.
      let out = node.estimatedRows;
      const examined = tableRows ?? 0;
      // Rows that survive the join filter, per outer row.
      if (innerOfLoop && joinFilter) out = innerOfLoop.estimatedRows / loops;
      const selectivity = examined > 0 ? out / examined : 1;
      const sort = topNSortKeys(node, parents);

      if (large && (conds.length || sort.length) && (selectivity <= 0.1 || sort.length)) {
        const { equality, range, trigram } = splitConditions(conds);
        if (equality.length || range.length || trigram.length || sort.length) {
          const repeated = loops > 1 ? ` ${formatNumber(loops)} times` : "";
          candidates.push({
            nodeId: node.id,
            schema: node.relation.schema,
            table: node.relation.name,
            equality,
            range,
            trigram,
            sort,
            existingIndexColumns: [],
            reason: sort.length && selectivity > 0.1
              ? `Sorts all of ${relName(node)} to return the first few rows`
              : `Scans all ${formatNumber(tableRows)} rows of ${relName(node)}${repeated} to return ${formatNumber(out)}`,
            rowsExamined: examined,
            rowsReturned: out,
          });
        }
        issues.push({
          severity: (tableRows ?? 0) >= ctx.largeTableRows * 10 || loops > 1 ? "warning" : "info",
          title: `Sequential scan on ${relName(node)}${loops > 1 ? ` repeated ${formatNumber(loops)} times` : ""}`,
          description:
            `Reads every row of a ${formatNumber(tableRows)} row table` +
            (filter ? ` and keeps ${formatPercent(selectivity * 100, selectivity < 0.01 ? 2 : 1)} of them (filter: ${filter}).` : ".") +
            " An index on the filtered columns lets PostgreSQL jump straight to the matching rows.",
        });
      }
    }

    // --- Index scans that still throw away most rows -----------------------
    const indexFilterRows =
      large && INDEX_TYPES.has(node.nodeType) && node.relation ? rowsDiscardedAfterIndex(node) : null;
    if (indexFilterRows && node.relation) {
      const { removed, out } = indexFilterRows;
      const filter = rawString(node, "Filter");
      if (filter && removed >= 1000 && removed >= out * 10) {
        const conds = conditionsFor(filter, alias);
        const { equality, range, trigram } = splitConditions(conds);
        const indexCond = rawString(node, "Index Cond") ?? rawString(node, "Recheck Cond");
        const indexCols = conditionsFor(indexCond, alias);
        if (equality.length || range.length) {
          const existing = splitConditions(indexCols);
          candidates.push({
            nodeId: node.id,
            schema: node.relation.schema,
            table: node.relation.name,
            equality: [...existing.equality, ...equality],
            range: [...range, ...existing.range],
            trigram,
            sort: [],
            existingIndexColumns: indexCols.map((c) => c.column),
            reason: `${node.indexName ?? "The index"} finds ${formatNumber(out + removed)} rows but the filter discards ${formatNumber(removed)} of them`,
            rowsExamined: out + removed,
            rowsReturned: out,
          });
        }
        issues.push({
          severity: "warning",
          title: `${node.nodeType} on ${relName(node)} discards most rows it reads`,
          description:
            `The index narrows the search to an estimated ${formatNumber(out + removed)} rows, ` +
            `then the filter (${filter}) throws away ${formatNumber(removed)}. ` +
            "A multicolumn index that also covers the filtered columns avoids reading them.",
        });
      }
    }
  });

  return { issues, candidates };
}
