/** Helpers for reading values that may arrive in different shapes. */

/** Accepts a JS array, a JSON array string or a PostgreSQL array literal. */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  const s = String(value).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fall through
    }
  }
  if (s.startsWith("{") && s.endsWith("}")) return parsePgArray(s);
  return s.split(",").map((v) => v.trim()).filter(Boolean);
}

/** Minimal parser for one-dimensional PostgreSQL array literals. */
export function parsePgArray(literal: string): string[] {
  const body = literal.slice(1, -1);
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '"') {
      let item = "";
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        item += body[i];
        i++;
      }
      out.push(item);
      i += 2; // closing quote and comma
    } else {
      const end = body.indexOf(",", i);
      const stop = end === -1 ? body.length : end;
      const item = body.slice(i, stop);
      if (item !== "NULL") out.push(item);
      i = stop + 1;
    }
  }
  return out;
}

export function toNumberArray(value: unknown): number[] {
  return toStringArray(value)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

/** EXPLAIN (FORMAT JSON) arrives parsed or as a string depending on the driver. */
export function toJson<T = unknown>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
