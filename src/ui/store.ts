import { computed, reactive } from "vue";
import type {
  BaseEnvironment,
  CategoryId,
  DatabaseAdapter,
  ExplainResult,
  Finding,
  OptimizerSettings,
  QuerySort,
  QueryStatsResult,
} from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { allFindings, runAnalysis, type AnalysisReport } from "@/core/engine";
import { errorMessage } from "@/core/format";
import { findAdapter, supportedEngines } from "@/core/registry";
import * as host from "@/host/beekeeper";
import { buildRecommendations, type Recommendation } from "./recommendations";

export type { Recommendation };

export type View = "recommendations" | "queries" | "analyze" | "checks";
const VIEWS: View[] = ["recommendations", "queries", "analyze", "checks"];

interface PersistedViewState {
  view?: View;
  analyzerSql?: string;
}

export const state = reactive({
  phase: "loading" as "loading" | "unsupported" | "error" | "ready",
  error: null as string | null,
  databaseType: "",
  connectionKey: "",
  adapter: null as DatabaseAdapter<BaseEnvironment> | null,
  env: null as BaseEnvironment | null,
  settings: { ...DEFAULT_SETTINGS } as OptimizerSettings,
  report: null as AnalysisReport | null,
  running: false,
  view: "recommendations" as View,
  dismissed: [] as string[],
  showDismissed: false,
  settingsOpen: false,
  topQueries: {
    sort: "total" as QuerySort,
    loading: false,
    result: null as QueryStatsResult | null,
    error: null as string | null,
  },
  analyzer: {
    sql: "",
    analyze: false,
    running: false,
    result: null as ExplainResult | null,
  },
});

export const supported = supportedEngines();

const isDismissed = (f: Finding) => state.dismissed.includes(f.key);

export function isFindingDismissed(f: Finding) {
  return isDismissed(f);
}

/** Every finding as one prioritized list, with duplicate advice merged. */
export const recommendations = computed<Recommendation[]>(() =>
  buildRecommendations(allFindings(state.report).filter((f) => state.showDismissed || !isDismissed(f))),
);

export const dismissedCount = computed(() => allFindings(state.report).filter(isDismissed).length);

export const checkSummary = computed(() => {
  const results = state.report?.results ?? [];
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "error").length,
  };
});

export function categoryResults(id: CategoryId) {
  return (state.report?.results ?? []).filter((r) => r.category === id);
}

// ---------------------------------------------------------------------------

export async function init() {
  try {
    const conn = await host.connectionInfo();
    state.databaseType = conn.databaseType;
    state.connectionKey = `${conn.workspaceId ?? 0}:${conn.id}:${conn.databaseName}`;
    const adapter = findAdapter(conn.databaseType);
    if (!adapter) {
      state.phase = "unsupported";
      return;
    }
    state.adapter = adapter;

    const [savedSettings, dismissed, viewState, ctx] = await Promise.all([
      host.loadItem<Partial<OptimizerSettings>>("settings"),
      host.loadItem<string[]>(`dismissed:${state.connectionKey}`),
      host.loadViewState<PersistedViewState>(),
      host.viewContext(),
    ]);
    state.settings = { ...DEFAULT_SETTINGS, ...(savedSettings ?? {}) };
    state.dismissed = Array.isArray(dismissed) ? dismissed : [];
    if (viewState?.view && VIEWS.includes(viewState.view)) state.view = viewState.view;
    if (viewState?.analyzerSql) state.analyzer.sql = viewState.analyzerSql;

    state.env = await adapter.detectEnvironment(host.runner, { readOnly: conn.readOnlyMode });
    state.phase = "ready";
    void host.setTitle(`Optimizer: ${state.env.databaseName}`);

    if (ctx.command === "analyze-query" && ctx.sql) {
      state.analyzer.sql = ctx.sql;
      setView("analyze");
      void analyze();
    } else if (state.view === "queries") {
      void loadTopQueries();
    }
    await runChecks();
  } catch (e) {
    state.error = errorMessage(e);
    state.phase = "error";
  }
}

export async function runChecks() {
  if (!state.adapter || !state.env || state.running) return;
  state.running = true;
  try {
    // Re-detect so notices reflect extensions installed since the last run.
    state.env = await state.adapter.detectEnvironment(host.runner, { readOnly: state.env.readOnly });
    state.report = await runAnalysis({
      adapter: state.adapter,
      runner: host.runner,
      env: state.env,
      settings: state.settings,
    });
    if (state.view === "queries") void loadTopQueries();
  } catch (e) {
    void host.notifyError(`Analysis failed: ${errorMessage(e)}`);
  } finally {
    state.running = false;
  }
}

export async function loadTopQueries(sort: QuerySort = state.topQueries.sort) {
  if (!state.adapter?.topQueries || !state.env) return;
  state.topQueries.sort = sort;
  state.topQueries.loading = true;
  state.topQueries.error = null;
  try {
    state.topQueries.result = await state.adapter.topQueries(host.runner, state.env, { sort, limit: 50 });
  } catch (e) {
    state.topQueries.error = errorMessage(e);
  } finally {
    state.topQueries.loading = false;
  }
}

export async function analyze(sql: string = state.analyzer.sql) {
  if (!state.adapter?.explain || !state.env) return;
  state.analyzer.sql = sql;
  state.analyzer.running = true;
  persistViewState();
  try {
    state.analyzer.result = await state.adapter.explain(
      host.runner,
      state.env,
      sql,
      { analyze: state.analyzer.analyze },
      state.settings,
    );
  } catch (e) {
    state.analyzer.result = { ok: false, error: errorMessage(e), issues: [], suggestions: [] };
  } finally {
    state.analyzer.running = false;
  }
}

/** Jump to the analyzer with a query and explain it. */
export function analyzeQuery(sql: string) {
  state.analyzer.analyze = false;
  setView("analyze");
  void analyze(sql);
}

export function setView(view: View) {
  state.view = view;
  persistViewState();
  if (view === "queries" && !state.topQueries.result && !state.topQueries.loading) {
    void loadTopQueries();
  }
}

function persistViewState() {
  void host.saveViewState<PersistedViewState>({ view: state.view, analyzerSql: state.analyzer.sql });
}

export async function dismiss(f: Finding) {
  if (!state.dismissed.includes(f.key)) state.dismissed.push(f.key);
  await host.saveItem(`dismissed:${state.connectionKey}`, [...state.dismissed]);
}

export async function restore(f: Finding) {
  state.dismissed = state.dismissed.filter((k) => k !== f.key);
  await host.saveItem(`dismissed:${state.connectionKey}`, [...state.dismissed]);
}

export async function saveSettings(next: OptimizerSettings) {
  state.settings = { ...next };
  await host.saveItem("settings", { ...next });
  state.settingsOpen = false;
  await runChecks();
}

export const actions = {
  openInEditor: (sql: string) => host.openInEditor(sql),
  copy: (text: string) => host.copy(text),
  openLink: (url: string) => host.openLink(url),
};
