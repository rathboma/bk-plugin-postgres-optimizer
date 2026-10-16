import type { PlanIssue, PlanNode } from "@/core/types";
import { formatBytes, formatMs, formatNumber, formatPercent } from "@/core/format";
import { qualifiedName, quoteIdent } from "../sql";
import type { Condition } from "./filterParser";
import { conditionsFor, parseSortKey } from "./filterParser";
import type { RawExplain } from "./planModel";
import { rawNumber, rawString, walk } from "./planModel";

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
  analyzed: boolean;
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

/** Rows produced by a node across all loops. */
function rowsOut(node: PlanNode, analyzed: boolean): number {
  return analyzed && node.actualRows !== undefined ? node.actualRows * (node.loops || 1) : node.estimatedRows;
}

/** Rows a filtering node threw away across all loops (only known after ANALYZE). */
function rowsRemoved(node: PlanNode): number {
  return (rawNumber(node, "Rows Removed by Filter") ?? 0) * (node.loops || 1);
}

/**
 * Rows an index-driven scan fetched and then discarded with its Filter.
 * Known exactly after ANALYZE; for estimated plans only bitmap scans tell us,
 * through the row estimate of their Bitmap Index Scan children.
 */
function rowsDiscardedAfterIndex(node: PlanNode, analyzed: boolean): { removed: number; out: number } | null {
  if (analyzed) return { removed: rowsRemoved(node), out: rowsOut(node, true) };
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

export function analyzePlan(root: PlanNode, explain: RawExplain, ctx: AnalyzeContext): PlanAnalysis {
  const issues: PlanIssue[] = [];
  const candidates: IndexCandidate[] = [];
  const parents = new Map<number, PlanNode | null>();
  walk(root, (n, parent) => parents.set(n.id, parent));
  const executionMs = explain["Execution Time"];

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
      // Parallel workers each scan part of the table, so their loops aren't repeated scans.
      const parallel = node.raw["Parallel Aware"] === true;
      const loops = parallel
        ? 1
        : node.loops ?? (innerOfLoop ? Math.max(1, Math.round(innerOfLoop.children[0].estimatedRows)) : 1);
      // Per loop: rows produced vs rows looked at.
      let out = ctx.analyzed && node.actualRows !== undefined ? node.actualRows : node.estimatedRows;
      let examined = ctx.analyzed
        ? out + (rawNumber(node, "Rows Removed by Filter") ?? 0)
        : tableRows ?? 0;
      if (innerOfLoop && joinFilter) {
        // Rows that survive the join filter, per outer row.
        out = (ctx.analyzed && innerOfLoop.actualRows !== undefined ? innerOfLoop.actualRows : innerOfLoop.estimatedRows) / loops;
        examined = ctx.analyzed && node.actualRows !== undefined ? node.actualRows : examined;
      }
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
          nodeId: node.id,
        });
      }
    }

    // --- Index scans that still throw away most rows -----------------------
    const indexFilterRows =
      large && INDEX_TYPES.has(node.nodeType) && node.relation ? rowsDiscardedAfterIndex(node, ctx.analyzed) : null;
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
            `The index narrows the search to ${ctx.analyzed ? "" : "an estimated "}${formatNumber(out + removed)} rows, ` +
            `then the filter (${filter}) throws away ${formatNumber(removed)}. ` +
            "A multicolumn index that also covers the filtered columns avoids reading them.",
          nodeId: node.id,
        });
      }
    }

    // --- Misestimates -------------------------------------------------------
    if (ctx.analyzed && node.actualRows !== undefined && node.relation) {
      const est = Math.max(1, node.estimatedRows);
      const act = Math.max(1, node.actualRows);
      const factor = Math.max(est / act, act / est);
      if (factor >= 10 && Math.max(est, act) >= 1000) {
        const table = relName(node);
        const filterCols = conditionsFor(rawString(node, "Filter") ?? rawString(node, "Index Cond"), alias)
          .map((c) => c.column);
        const uniqueCols = [...new Set(filterCols)];
        issues.push({
          severity: "warning",
          title: `Row estimate for ${table} is off by ${formatNumber(Math.round(factor))}x`,
          description:
            `The planner expected ${formatNumber(node.estimatedRows)} rows but got ${formatNumber(node.actualRows)}. ` +
            "Bad estimates lead to bad join orders and the wrong scan types. Refresh statistics first" +
            (uniqueCols.length > 1 ? "; if the filtered columns are correlated, extended statistics can help." : "."),
          nodeId: node.id,
          fix: {
            title: "Refresh statistics",
            sql:
              `ANALYZE ${table};` +
              (uniqueCols.length > 1
                ? `\n\n-- If the estimate is still off, tell the planner these columns are correlated:\n` +
                  `CREATE STATISTICS ON ${uniqueCols.map(quoteIdent).join(", ")} FROM ${table};\nANALYZE ${table};`
                : ""),
            safety: "safe",
          },
        });
      }
    }

    // --- Memory spills ------------------------------------------------------
    if (rawString(node, "Sort Space Type") === "Disk") {
      const kb = rawNumber(node, "Sort Space Used") ?? 0;
      const mb = Math.max(4, Math.ceil((kb * 2) / 1024));
      issues.push({
        severity: "warning",
        title: `Sort spilled ${formatBytes(kb * 1024)} to disk`,
        description:
          `The sort (${rawString(node, "Sort Key") ?? ""}) didn't fit in work_mem. An index that returns rows in this order ` +
          "avoids the sort entirely; otherwise give the query more memory.",
        nodeId: node.id,
        fix: { title: "Raise work_mem for this session", sql: `SET work_mem = '${mb}MB';`, safety: "safe" },
      });
    }
    const batches = rawNumber(node, "Hash Batches");
    if (node.nodeType === "Hash" && batches !== undefined && batches > 1) {
      const peak = rawNumber(node, "Peak Memory Usage") ?? 0;
      issues.push({
        severity: batches >= 8 ? "warning" : "info",
        title: `Hash table split into ${batches} batches`,
        description: "The hash didn't fit in work_mem, so it was written to disk in batches.",
        nodeId: node.id,
        fix: {
          title: "Raise work_mem for this session",
          sql: `SET work_mem = '${Math.max(8, Math.ceil((peak * batches * 1.5) / 1024))}MB';`,
          safety: "safe",
        },
      });
    }
    if ((rawNumber(node, "Lossy Heap Blocks") ?? 0) > 0) {
      issues.push({
        severity: "info",
        title: "Bitmap scan went lossy",
        description:
          "The bitmap didn't fit in work_mem, so PostgreSQL had to recheck every row on some pages.",
        nodeId: node.id,
      });
    }

    // --- Index-only scans that hit the heap ---------------------------------
    const heapFetches = rawNumber(node, "Heap Fetches");
    if (node.nodeType === "Index Only Scan" && heapFetches !== undefined && ctx.analyzed) {
      const out = rowsOut(node, true);
      if (heapFetches >= 1000 && heapFetches >= out * 0.5) {
        issues.push({
          severity: "info",
          title: `Index-only scan on ${relName(node)} still read the table ${formatNumber(heapFetches)} times`,
          description:
            "The visibility map is out of date, so PostgreSQL has to check the table anyway. Vacuuming more often fixes this.",
          nodeId: node.id,
          fix: { title: "Vacuum the table", sql: `VACUUM (ANALYZE) ${relName(node)};`, safety: "safe" },
        });
      }
    }

    // --- Parallel workers that never started --------------------------------
    const planned = rawNumber(node, "Workers Planned");
    const launched = rawNumber(node, "Workers Launched");
    if (planned !== undefined && launched !== undefined && launched < planned) {
      issues.push({
        severity: "info",
        title: `Only ${launched} of ${planned} parallel workers started`,
        description:
          "The server ran out of background workers (max_parallel_workers / max_worker_processes) so the query ran with less parallelism than planned.",
        nodeId: node.id,
      });
    }
  });

  // --- Whole-query issues ----------------------------------------------------
  const jitTotal = Number((explain.JIT?.["Timing"] as Record<string, unknown> | undefined)?.["Total"] ?? 0);
  if (executionMs !== undefined && jitTotal > 0 && jitTotal >= executionMs * 0.3 && jitTotal >= 20) {
    issues.push({
      severity: "warning",
      title: `JIT compilation took ${formatMs(jitTotal)} of ${formatMs(executionMs)}`,
      description: "Compiling this query took longer than it saved. Turning JIT off for short queries is usually faster.",
      fix: { title: "Turn JIT off for this session", sql: "SET jit = off;", safety: "safe" },
    });
  }
  const planningMs = explain["Planning Time"];
  if (planningMs !== undefined && executionMs !== undefined && planningMs > 50 && planningMs > executionMs * 2) {
    issues.push({
      severity: "info",
      title: `Planning took ${formatMs(planningMs)}, longer than execution`,
      description:
        "Large IN lists, many joined tables or many partitions make planning expensive. Prepared statements let PostgreSQL reuse a plan.",
    });
  }

  return { issues, candidates };
}
