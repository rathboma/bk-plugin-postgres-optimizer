import type { MetricFormat } from "./types";

export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = toNumber(value);
  return Number.isFinite(n) ? n : null;
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["t", "true", "on", "1", "yes"].includes(value.toLowerCase());
  if (typeof value === "number") return value !== 0;
  return false;
}

export function errorMessage(e: unknown): string {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  return formatSeconds(ms / 1000);
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${(hours / 24).toFixed(0)} days`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2);
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function formatDateTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "never";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

export function formatMetric(value: number | string | null, format: MetricFormat = "number"): string {
  if (value === null || value === undefined) return "—";
  if (format === "text") return String(value);
  if (format === "datetime") return formatDateTime(value);
  const n = typeof value === "number" ? value : toNumber(value);
  switch (format) {
    case "bytes":
      return formatBytes(n);
    case "ms":
      return formatMs(n);
    case "percent":
      return formatPercent(n);
    case "duration-s":
      return formatSeconds(n);
    default:
      return formatNumber(n);
  }
}

/** Collapse whitespace so long SQL fits on one line in lists. */
export function oneLine(sql: string, max = 200): string {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Index column list for display: `(lower(email))` reads better as `lower(email)`. */
export function displayColumns(columns: string[]): string {
  return columns.map((c) => c.replace(/^\((.*)\)$/, "$1")).join(", ");
}

/** `1 day`, `3 days`. */
export function plural(n: number, word: string): string {
  return `${formatNumber(n)} ${n === 1 ? word : `${word}s`}`;
}

/** A 0-1 reduction as a whole percent, never rounding a partial saving up to 100%. */
export function formatReduction(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `${fraction < 1 && pct >= 100 ? 99 : pct}%`;
}
