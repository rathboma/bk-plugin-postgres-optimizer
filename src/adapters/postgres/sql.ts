/** Small SQL helpers for building PostgreSQL statements safely. */

/**
 * Comment prefixed to every statement the optimizer sends, so its own queries
 * can be left out of pg_stat_statements results.
 */
export const SELF_MARKER = "bks-optimizer";

export function tagged(sql: string): string {
  // After the first keyword, not before it: pg_stat_statements drops leading
  // comments on some versions (PostgreSQL 18).
  return sql.trim().replace(/^([A-Za-z]+)/, `$1 /* ${SELF_MARKER} */`);
}

const RESERVED = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "both", "case", "cast", "check", "collate", "column", "constraint", "create",
  "current_catalog", "current_date", "current_role", "current_time",
  "current_timestamp", "current_user", "default", "deferrable", "desc",
  "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign",
  "from", "grant", "group", "having", "in", "initially", "intersect", "into",
  "lateral", "leading", "limit", "localtime", "localtimestamp", "not", "null",
  "offset", "on", "only", "or", "order", "placing", "primary", "references",
  "returning", "select", "session_user", "some", "symmetric", "system_user",
  "table", "then", "to", "trailing", "true", "union", "unique", "user", "using",
  "variadic", "when", "where", "window", "with",
]);

/** Quote an identifier only when PostgreSQL requires it. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  const escaped = value.replace(/'/g, "''");
  return value.includes("\\") ? `E'${escaped.replace(/\\/g, "\\\\")}'` : `'${escaped}'`;
}

export function qualifiedName(schema: string | undefined | null, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/** PostgreSQL truncates identifiers at 63 bytes. */
const MAX_IDENT = 63;

/**
 * Build an index name like `orders_customer_id_idx`, trimmed to the 63 byte
 * identifier limit the same way PostgreSQL's own naming does.
 */
export function indexName(table: string, columns: string[], suffix = "idx"): string {
  const cols = columns
    .map((c) => c.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join("_");
  let tablePart = table.replace(/[^a-zA-Z0-9_]+/g, "_");
  let colPart = cols || "expr";
  const budget = MAX_IDENT - suffix.length - 2;
  while (tablePart.length + colPart.length > budget) {
    if (tablePart.length >= colPart.length) tablePart = tablePart.slice(0, -1);
    else colPart = colPart.slice(0, -1);
  }
  return `${tablePart}_${colPart}_${suffix}`.toLowerCase();
}

/** Remove comments and string literals so keyword checks can't be fooled. */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out += " ";
    } else if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (ch === "$" && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += "''";
    } else if (ch === '"') {
      // Keep quoted identifiers, they are not keywords.
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Split on semicolons that are not inside strings or comments. */
export function countStatements(sql: string): number {
  return stripSqlNoise(sql)
    .split(";")
    .filter((s) => s.trim().length > 0).length;
}

export type StatementKind = "select" | "dml" | "utility" | "unknown";

const DML_RE = /\b(insert|update|delete|merge)\b/i;

/**
 * Classify a statement for EXPLAIN purposes.
 * `select` statements can be executed safely with EXPLAIN ANALYZE.
 */
export function statementKind(sql: string): StatementKind {
  const clean = stripSqlNoise(sql).trim().replace(/^\(+\s*/, "");
  const first = clean.match(/^([a-zA-Z]+)/)?.[1]?.toLowerCase();
  if (!first) return "unknown";
  if (["select", "values", "table"].includes(first)) {
    // SELECT ... INTO creates a table.
    return /\binto\b/i.test(clean) ? "utility" : "select";
  }
  if (first === "with") return DML_RE.test(clean) ? "dml" : "select";
  if (["insert", "update", "delete", "merge"].includes(first)) return "dml";
  return "utility";
}

/** Highest `$n` placeholder in a normalized query, or 0. */
export function parameterCount(sql: string): number {
  const clean = stripSqlNoise(sql);
  let max = 0;
  for (const m of clean.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * pg_stat_statements text sometimes contains `interval $1`, which is not valid
 * SQL once the literal is gone. Rewrite it to a cast so it can be explained.
 */
export function repairNormalizedQuery(sql: string): string {
  return sql.replace(/\binterval\s+(\$\d+)/gi, "$1::interval").trim().replace(/;+\s*$/, "");
}
