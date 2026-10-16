import type { QueryRunner, Row } from "@/core/types";
import { toBool, toNumber } from "@/core/format";
import { SELF_MARKER } from "./queryStats";
import { toStringArray } from "./rows";

export interface IndexInfo {
  schema: string;
  table: string;
  name: string;
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  /** Key columns (names, or expressions as text). */
  keyColumns: string[];
  /** INCLUDE columns. */
  includeColumns: string[];
  /** Raw catalog values used to compare indexes exactly. */
  keyAttnums: number[];
  keyOpclasses: string[];
  keyCollations: string[];
  keyOptions: string[];
  expressions: string | null;
  predicate: string | null;
  definition: string;
  sizeBytes: number;
  scans: number;
  /** A constraint (primary key, unique, exclusion, or a foreign key's referenced key) relies on it. */
  backsConstraint: boolean;
  tableRows: number;
}

export function indexCatalogSql(versionNum: number, extraWhere = ""): string {
  // INCLUDE columns (indnkeyatts) arrived in PostgreSQL 11.
  const keyCount = versionNum >= 110000 ? "i.indnkeyatts" : "i.indnatts";
  return `
    SELECT /* ${SELF_MARKER} */
      n.nspname AS schema,
      t.relname AS table_name,
      ic.relname AS index_name,
      am.amname AS method,
      i.indisunique AS is_unique,
      i.indisprimary AS is_primary,
      i.indisvalid AS is_valid,
      ${keyCount} AS key_count,
      i.indnatts AS att_count,
      i.indkey::text AS indkey,
      i.indclass::text AS indclass,
      i.indcollation::text AS indcollation,
      i.indoption::text AS indoption,
      pg_get_expr(i.indexprs, i.indrelid) AS expressions,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      pg_get_indexdef(i.indexrelid) AS definition,
      ARRAY(
        SELECT pg_get_indexdef(i.indexrelid, k, true)
        FROM generate_series(1, i.indnatts) AS k
        ORDER BY k
      ) AS columns,
      pg_relation_size(i.indexrelid) AS size_bytes,
      COALESCE(s.idx_scan, 0) AS scans,
      EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) AS backs_constraint,
      GREATEST(t.reltuples, 0)::float8 AS table_rows
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = ic.relam
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
      ${extraWhere}
    ORDER BY n.nspname, t.relname, ic.relname`;
}

function splitVector(value: unknown): string[] {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean);
}

export function toIndexInfo(r: Row): IndexInfo {
  const keyCount = toNumber(r.key_count);
  const columns = toStringArray(r.columns);
  const attnums = splitVector(r.indkey).map(Number);
  return {
    schema: String(r.schema),
    table: String(r.table_name),
    name: String(r.index_name),
    method: String(r.method),
    unique: toBool(r.is_unique),
    primary: toBool(r.is_primary),
    valid: toBool(r.is_valid),
    keyColumns: columns.slice(0, keyCount),
    includeColumns: columns.slice(keyCount),
    keyAttnums: attnums.slice(0, keyCount),
    keyOpclasses: splitVector(r.indclass).slice(0, keyCount),
    keyCollations: splitVector(r.indcollation).slice(0, keyCount),
    keyOptions: splitVector(r.indoption).slice(0, keyCount),
    expressions: (r.expressions as string | null) ?? null,
    predicate: (r.predicate as string | null) ?? null,
    definition: String(r.definition ?? ""),
    sizeBytes: toNumber(r.size_bytes),
    scans: toNumber(r.scans),
    backsConstraint: toBool(r.backs_constraint),
    tableRows: toNumber(r.table_rows),
  };
}

export async function loadIndexes(runner: QueryRunner, versionNum: number, extraWhere = ""): Promise<IndexInfo[]> {
  const rows = await runner.query(indexCatalogSql(versionNum, extraWhere));
  return rows.map(toIndexInfo);
}

function keyParts(ix: IndexInfo): string[] {
  return ix.keyAttnums.map(
    (attnum, i) => `${attnum}/${ix.keyOpclasses[i]}/${ix.keyCollations[i]}/${ix.keyOptions[i]}`,
  );
}

function isPrefix(shorter: string[], longer: string[]): boolean {
  return shorter.length <= longer.length && shorter.every((p, i) => longer[i] === p);
}

function sameKeys(a: IndexInfo, b: IndexInfo): boolean {
  const ka = keyParts(a);
  const kb = keyParts(b);
  return ka.length === kb.length && isPrefix(ka, kb);
}

export interface RedundantIndex {
  index: IndexInfo;
  coveredBy: IndexInfo;
  exactDuplicate: boolean;
}

/** Can index `a` be dropped because `b` already serves every query `a` can? */
export function isCoveredBy(a: IndexInfo, b: IndexInfo): boolean {
  if (a === b || a.name === b.name) return false;
  if (a.schema !== b.schema || a.table !== b.table) return false;
  if (!a.valid || !b.valid || a.primary) return false;
  if (a.method !== b.method) return false;
  if ((a.predicate ?? "") !== (b.predicate ?? "")) return false;
  if ((a.expressions ?? "") !== (b.expressions ?? "")) return false;

  const ka = keyParts(a);
  const kb = keyParts(b);
  // Only btree can use a prefix of its columns on its own.
  const covered = a.method === "btree" ? isPrefix(ka, kb) : sameKeys(a, b);
  if (!covered) return false;

  // Columns `a` returns for index-only scans must also be in `b`.
  const bColumns = new Set([...b.keyColumns, ...b.includeColumns]);
  if (!a.includeColumns.every((c) => bColumns.has(c))) return false;

  // A unique index enforces something, it is only redundant next to an identical unique index.
  if (a.unique) return b.unique && sameKeys(a, b);
  return true;
}

/**
 * Find indexes another index on the same table makes redundant.
 * For identical pairs only one of the two is reported.
 */
export function findRedundantIndexes(indexes: IndexInfo[]): RedundantIndex[] {
  const out: RedundantIndex[] = [];
  const byTable = new Map<string, IndexInfo[]>();
  for (const ix of indexes) {
    const key = `${ix.schema}.${ix.table}`;
    byTable.set(key, [...(byTable.get(key) ?? []), ix]);
  }

  for (const group of byTable.values()) {
    const reported = new Set<string>();
    for (const a of group) {
      for (const b of group) {
        if (!isCoveredBy(a, b)) continue;
        const exact = sameKeys(a, b) && a.unique === b.unique &&
          a.includeColumns.length === b.includeColumns.length;
        if (exact) {
          // Keep whichever one matters more; drop the other one once.
          if (reported.has(b.name) || reported.has(a.name)) continue;
          if (keeperRank(a) < keeperRank(b)) continue;
        }
        if (a.backsConstraint) continue;
        // If queries use `a` but never `b`, the unused-index check will suggest
        // dropping `b`; suggesting to drop `a` as well would leave neither.
        if (a.scans > 0 && b.scans === 0) continue;
        out.push({ index: a, coveredBy: b, exactDuplicate: exact });
        reported.add(a.name);
        break;
      }
    }
  }
  return out;
}

/** Lower rank = more important to keep. */
function keeperRank(ix: IndexInfo): number {
  return (ix.primary ? 0 : 1000) + (ix.backsConstraint ? 0 : 100) + (ix.scans > 0 ? 0 : 10);
}
