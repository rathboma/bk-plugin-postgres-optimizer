import type { IndexSuggestion } from "@/core/types";
import type { IndexInfo } from "../indexCatalog";
import { indexName, qualifiedName, quoteIdent } from "../sql";
import type { Condition } from "./filterParser";
import type { IndexCandidate } from "./planAnalyzer";
import { relationKey } from "./planAnalyzer";

export interface ColumnStats {
  nullFrac: number;
  /** pg_stats.n_distinct: positive = count, negative = fraction of rows. */
  nDistinct: number;
}

export interface AdvisorContext {
  /** Existing indexes keyed by `schema.table` (lowercase). */
  indexes: Map<string, IndexInfo[]>;
  /** Column statistics keyed by `schema.table.column` (lowercase). */
  columnStats: Map<string, ColumnStats>;
  tableRows: Map<string, number>;
}

/** Most columns we'll put in one suggested index. */
const MAX_COLUMNS = 4;

/** Rows matching `column = <value>`, estimated the way PostgreSQL does. */
export function equalityRows(stats: ColumnStats | undefined, totalRows: number): number {
  if (!stats) return totalRows / 10;
  const distinct = stats.nDistinct < 0 ? -stats.nDistinct * totalRows : stats.nDistinct;
  if (distinct <= 0) return totalRows;
  return (totalRows * (1 - stats.nullFrac)) / distinct;
}

interface IndexKey {
  /** The thing to index: a column name or an expression like lower(email). */
  key: string;
  /** SQL for the index column list. */
  sql: string;
  desc?: boolean;
}

function keyFor(c: { column: string; expression?: string }): IndexKey {
  return c.expression
    ? { key: c.expression, sql: `(${c.expression})` }
    : { key: c.column, sql: quoteIdent(c.column) };
}

function dedupe(keys: IndexKey[]): IndexKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    if (seen.has(k.key)) return false;
    seen.add(k.key);
    return true;
  });
}

/**
 * Order the index columns: equality columns first, most selective first,
 * then a single range column or the ORDER BY columns.
 */
export function chooseColumns(candidate: IndexCandidate, ctx: AdvisorContext): IndexKey[] {
  const rel = relationKey(candidate.schema, candidate.table);
  const total = ctx.tableRows.get(rel) ?? 0;
  const stat = (c: Condition) => ctx.columnStats.get(`${rel}.${c.column}`.toLowerCase());

  const eq = [...candidate.equality].sort((a, b) => equalityRows(stat(a), total) - equalityRows(stat(b), total));
  const keys: IndexKey[] = [];
  let remaining = total;
  for (const c of eq) {
    if (keys.length >= MAX_COLUMNS - 1) break;
    keys.push(keyFor(c));
    remaining = total > 0 ? remaining * (equalityRows(stat(c), total) / total) : remaining;
    // Once the equality columns narrow it down to a handful of rows, more columns don't help.
    if (remaining <= 10 && !candidate.sort.length) break;
  }

  if (candidate.sort.length) {
    for (const s of candidate.sort) keys.push({ ...keyFor(s), desc: s.desc });
  } else if (candidate.range.length) {
    keys.push(keyFor(candidate.range[0]));
  }
  return dedupe(keys).slice(0, MAX_COLUMNS);
}

/** Does an existing index already start with these columns? */
export function findCoveringIndex(keys: IndexKey[], existing: IndexInfo[], equalityCount: number): IndexInfo | undefined {
  const want = keys.map((k) => k.key.toLowerCase());
  return existing.find((ix) => {
    if (!ix.valid || ix.predicate || ix.method !== "btree") return false;
    const have = ix.keyColumns.map((c) => c.toLowerCase().replace(/^\((.*)\)$/, "$1"));
    if (have.length < want.length) return false;
    // Equality columns can come in any order; the rest must follow in order.
    const eqWant = new Set(want.slice(0, equalityCount));
    const eqHave = new Set(have.slice(0, equalityCount));
    if ([...eqWant].some((c) => !eqHave.has(c))) return false;
    return want.slice(equalityCount).every((c, i) => have[equalityCount + i] === c);
  });
}

function suggestionDdl(schema: string | undefined, table: string, keys: IndexKey[], method = "btree", concurrently = true): string {
  const name = indexName(table, keys.map((k) => k.key.replace(/\W+/g, "_")));
  const cols = keys.map((k) => `${k.sql}${k.desc ? " DESC" : ""}`).join(", ");
  const using = method === "btree" ? "" : ` USING ${method}`;
  return `CREATE INDEX${concurrently ? " CONCURRENTLY" : ""} ${quoteIdent(name)}\n  ON ${qualifiedName(schema, table)}${using} (${cols});`;
}

/** The statement hypopg needs: no name, no CONCURRENTLY. */
export function hypotheticalDdl(s: IndexSuggestion): string {
  return `CREATE INDEX ON ${qualifiedName(s.schema, s.table)}${s.method === "btree" ? "" : ` USING ${s.method}`} (${s.columns.join(", ")})`;
}

export function suggestIndexes(candidates: IndexCandidate[], ctx: AdvisorContext): IndexSuggestion[] {
  const out = new Map<string, IndexSuggestion>();
  for (const c of candidates) {
    const rel = relationKey(c.schema, c.table);
    const existing = ctx.indexes.get(rel) ?? [];

    if (!c.equality.length && !c.range.length && !c.sort.length && c.trigram.length) {
      const t = c.trigram[0];
      const target = t.expression ? `(${t.expression})` : quoteIdent(t.column);
      const key = `${rel}|trgm|${target}`;
      if (!out.has(key)) {
        out.set(key, {
          schema: c.schema,
          table: c.table,
          columns: [`${target} gin_trgm_ops`],
          method: "gin",
          ddl:
            "-- Trigram indexes need the pg_trgm extension.\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n" +
            `CREATE INDEX CONCURRENTLY ${quoteIdent(indexName(c.table, [t.column, "trgm"]))}\n` +
            `  ON ${qualifiedName(c.schema, c.table)} USING gin (${target} gin_trgm_ops);`,
          reason: `${c.reason}. The pattern starts with a wildcard, which only a trigram index can search.`,
        });
      }
      continue;
    }

    const keys = chooseColumns(c, ctx);
    if (!keys.length) continue;
    const equalityCount = Math.min(keys.length, c.equality.length);
    const covering = findCoveringIndex(keys, existing, equalityCount);
    const columns = keys.map((k) => `${k.sql}${k.desc ? " DESC" : ""}`);
    const key = `${rel}|btree|${columns.join(",")}`;
    if (out.has(key)) continue;
    out.set(key, {
      schema: c.schema,
      table: c.table,
      columns,
      method: "btree",
      ddl: suggestionDdl(c.schema, c.table, keys),
      reason: c.reason,
      coveredBy: covering?.name,
    });
  }
  return [...out.values()];
}
