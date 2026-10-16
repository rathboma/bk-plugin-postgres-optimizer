/**
 * Pulls indexable conditions out of the expressions PostgreSQL prints in plans,
 * e.g. `((o.status)::text = 'paid'::text) AND (o.created_at > $1)`.
 *
 * This is deliberately not a full SQL parser: it understands the shapes the
 * planner prints for simple column comparisons and ignores everything else.
 */

export type ConditionKind = "eq" | "range" | "like" | "null" | "other";

export interface Condition {
  /** Table alias the column was qualified with, if any. */
  qualifier?: string;
  column: string;
  /** Set for expression conditions like lower(email). Index this instead of the column. */
  expression?: string;
  op: string;
  kind: ConditionKind;
  /** LIKE pattern starting with a wildcard; btree can't help. */
  leadingWildcard?: boolean;
  /** The other side is a column of another relation (a join condition). */
  joinTo?: { qualifier?: string; column: string };
}

/** Index of the closing paren matching the open paren at `start`, or -1. */
function matchParen(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) {
        if (s[i] === "'" && s[i + 1] === "'") i++;
        i++;
      }
    } else if (ch === '"') {
      i = s.indexOf('"', i + 1);
      if (i === -1) return -1;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function stripOuterParens(s: string): string {
  let out = s.trim();
  while (out.startsWith("(") && matchParen(out, 0) === out.length - 1) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * Split on a keyword (`AND` / `OR`) at paren depth 0, outside quotes.
 * Returns a single element when the keyword doesn't occur at the top level.
 */
export function splitTopLevel(s: string, keyword: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const kw = ` ${keyword} `;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) {
        if (s[i] === "'" && s[i + 1] === "'") i++;
        i++;
      }
    } else if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      i = end === -1 ? s.length : end;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && s.slice(i, i + kw.length).toUpperCase() === kw) {
      parts.push(s.slice(last, i));
      last = i + kw.length;
      i += kw.length - 1;
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const COLREF_RE = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})$`);
const CAST_RE = /::[A-Za-z_][A-Za-z0-9_ ]*(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?$/;
const CONSTANT_WORDS = new Set([
  "true", "false", "null", "current_date", "current_timestamp", "current_time",
  "localtimestamp", "localtime", "current_user", "session_user", "current_role",
]);
const EXPRESSION_FUNCS = new Set(["lower", "upper"]);

function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident;
}

export interface ColumnRef {
  qualifier?: string;
  column: string;
  expression?: string;
}

/** Parse `o.status`, `(status)::text`, `lower((email)::text)` and similar. */
export function parseColumnRef(input: string): ColumnRef | null {
  let s = input.trim();
  for (let guard = 0; guard < 5; guard++) {
    const before = s;
    s = stripOuterParens(s.replace(CAST_RE, "").trim());
    if (s === before) break;
  }

  const fn = s.match(/^([A-Za-z_]+)\((.*)\)$/s);
  if (fn && EXPRESSION_FUNCS.has(fn[1].toLowerCase()) && matchParen(s, fn[1].length) === s.length - 1) {
    const inner = parseColumnRef(fn[2]);
    if (!inner || inner.expression) return null;
    return { ...inner, expression: `${fn[1].toLowerCase()}(${quoteIfNeeded(inner.column)})` };
  }

  const m = s.match(COLREF_RE);
  if (!m) return null;
  const column = unquote(m[2]);
  if (!m[1] && CONSTANT_WORDS.has(column.toLowerCase())) return null;
  return { qualifier: m[1] ? unquote(m[1]) : undefined, column };
}

function quoteIfNeeded(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

const OPERATORS: { op: string; kind: ConditionKind; flipped: string }[] = [
  { op: "= ANY", kind: "eq", flipped: "= ANY" },
  { op: "<> ALL", kind: "other", flipped: "<> ALL" },
  { op: "~~*", kind: "like", flipped: "~~*" },
  { op: "!~~*", kind: "other", flipped: "!~~*" },
  { op: "!~~", kind: "other", flipped: "!~~" },
  { op: "~~", kind: "like", flipped: "~~" },
  { op: "<=", kind: "range", flipped: ">=" },
  { op: ">=", kind: "range", flipped: "<=" },
  { op: "<>", kind: "other", flipped: "<>" },
  { op: "!=", kind: "other", flipped: "!=" },
  { op: "=", kind: "eq", flipped: "=" },
  { op: "<", kind: "range", flipped: ">" },
  { op: ">", kind: "range", flipped: "<" },
];

/** Find ` <op> ` at depth 0 outside quotes. Returns [left, op, right]. */
function splitBinary(s: string): [string, (typeof OPERATORS)[number], string] | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) {
        if (s[i] === "'" && s[i + 1] === "'") i++;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === " ") {
      for (const o of OPERATORS) {
        const token = ` ${o.op} `;
        if (s.slice(i, i + token.length).toUpperCase() === token) {
          return [s.slice(0, i), o, s.slice(i + token.length)];
        }
      }
    }
  }
  return null;
}

function isLeadingWildcard(literal: string): boolean {
  const m = literal.trim().match(/^'((?:[^']|'')*)'/);
  return !!m && (m[1].startsWith("%") || m[1].startsWith("_"));
}

function parseConjunct(raw: string): Condition | null {
  const s = stripOuterParens(raw);

  const nullTest = s.match(/^(.*) IS (NOT )?NULL$/is);
  if (nullTest) {
    const ref = parseColumnRef(nullTest[1]);
    if (!ref) return null;
    return nullTest[2]
      ? { ...ref, op: "IS NOT NULL", kind: "other" }
      : { ...ref, op: "IS NULL", kind: "null" };
  }

  const bin = splitBinary(s);
  if (!bin) return null;
  const [left, o, right] = bin;
  const l = parseColumnRef(left);
  const r = parseColumnRef(right);

  if (l && r) {
    // Column compared with another column: a join condition, report from the left.
    return { ...l, op: o.op, kind: o.kind, joinTo: { qualifier: r.qualifier, column: r.column } };
  }
  if (l) {
    return {
      ...l,
      op: o.op,
      kind: o.kind,
      leadingWildcard: o.kind === "like" ? isLeadingWildcard(right) : undefined,
    };
  }
  if (r) return { ...r, op: o.flipped, kind: o.kind };
  return null;
}

/** All simple conditions ANDed together in an expression. ORed expressions yield nothing. */
export function parseConditions(expression: string | undefined): Condition[] {
  if (!expression) return [];
  const body = stripOuterParens(expression);
  if (splitTopLevel(body, "OR").length > 1) return [];
  const out: Condition[] = [];
  for (const part of splitTopLevel(body, "AND")) {
    const inner = stripOuterParens(part);
    if (splitTopLevel(inner, "AND").length > 1) {
      out.push(...parseConditions(inner));
      continue;
    }
    if (splitTopLevel(inner, "OR").length > 1) continue;
    const c = parseConjunct(inner);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Conditions on one relation. A join condition counts for whichever side
 * belongs to the relation, so `(c.id = o.customer_id)` on alias `o` yields
 * `customer_id`.
 */
export function conditionsFor(expression: string | undefined, alias: string | undefined): Condition[] {
  const out: Condition[] = [];
  for (const c of parseConditions(expression)) {
    const mine = (q?: string) => !q || !alias || q === alias;
    if (c.joinTo) {
      if (mine(c.qualifier) && c.qualifier !== undefined) out.push(c);
      else if (mine(c.joinTo.qualifier) && c.joinTo.qualifier !== undefined) {
        const flipped = OPERATORS.find((o) => o.op === c.op)?.flipped ?? c.op;
        out.push({
          qualifier: c.joinTo.qualifier,
          column: c.joinTo.column,
          op: flipped,
          kind: c.kind,
          joinTo: { qualifier: c.qualifier, column: c.column },
        });
      }
    } else if (mine(c.qualifier)) {
      out.push(c);
    }
  }
  return out;
}

/** Column names from a `Sort Key` entry such as `o.created_at DESC`. */
export function parseSortKey(key: string): { ref: ColumnRef; desc: boolean } | null {
  const m = key.trim().match(/^(.*?)(\s+DESC)?(\s+NULLS (?:FIRST|LAST))?$/is);
  if (!m) return null;
  const ref = parseColumnRef(m[1]);
  return ref ? { ref, desc: !!m[2] } : null;
}
