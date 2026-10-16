import type {
  BaseEnvironment,
  Check,
  CheckResult,
  DatabaseAdapter,
  Finding,
  OptimizerSettings,
  QueryRunner,
} from "./types";
import { SEVERITY_ORDER } from "./types";
import { errorMessage } from "./format";

export interface AnalysisReport {
  startedAt: string;
  durationMs: number;
  results: CheckResult[];
}

export interface RunAnalysisOptions<E extends BaseEnvironment> {
  adapter: DatabaseAdapter<E>;
  runner: QueryRunner;
  env: E;
  settings: OptimizerSettings;
  /** Only run these checks. Runs everything when omitted. */
  checkIds?: string[];
  onProgress?: (done: number, total: number, current: Check<E>) => void;
}

export async function runCheck<E extends BaseEnvironment>(
  check: Check<E>,
  runner: QueryRunner,
  env: E,
  settings: OptimizerSettings,
): Promise<CheckResult> {
  const base = {
    checkId: check.id,
    category: check.category,
    title: check.title,
    description: check.description,
  };
  const skipReason = check.unavailableReason?.(env) ?? null;
  if (skipReason) {
    return { ...base, status: "skipped", findings: [], rows: [], message: skipReason, durationMs: 0 };
  }

  const started = performance.now();
  try {
    const output = await check.run({ runner, env, settings });
    const findings = sortFindings(output.findings);
    return {
      ...base,
      status: findings.length ? "issues" : output.inconclusive ? "skipped" : "passed",
      findings,
      rows: output.rows ?? [],
      message: output.note,
      durationMs: performance.now() - started,
    };
  } catch (e) {
    // One broken check (permissions, an odd server version) must not take
    // down the whole report.
    return {
      ...base,
      status: "error",
      findings: [],
      rows: [],
      message: errorMessage(e),
      durationMs: performance.now() - started,
    };
  }
}

/**
 * Runs checks one at a time. Running them in parallel would be faster but they
 * share the app's connection pool with the user's own tabs.
 */
export async function runAnalysis<E extends BaseEnvironment>(
  opts: RunAnalysisOptions<E>,
): Promise<AnalysisReport> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const checks = opts.checkIds
    ? opts.adapter.checks.filter((c) => opts.checkIds!.includes(c.id))
    : opts.adapter.checks;

  const results: CheckResult[] = [];
  for (const [i, check] of checks.entries()) {
    opts.onProgress?.(i, checks.length, check);
    results.push(await runCheck(check, opts.runner, opts.env, opts.settings));
  }

  return { startedAt, durationMs: performance.now() - started, results };
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

export function allFindings(report: AnalysisReport | null | undefined): Finding[] {
  if (!report) return [];
  return sortFindings(report.results.flatMap((r) => r.findings));
}
