<script setup lang="ts">
import { computed, onMounted } from "vue";
import { CATEGORIES, type CategoryId } from "@/core/types";
import AnalyzerView from "@/ui/components/AnalyzerView.vue";
import CategoryView from "@/ui/components/CategoryView.vue";
import Icon, { type IconName } from "@/ui/components/Icon.vue";
import OverviewView from "@/ui/components/OverviewView.vue";
import SettingsDialog from "@/ui/components/SettingsDialog.vue";
import TopQueriesView from "@/ui/components/TopQueriesView.vue";
import {
  categoryFindings,
  dismissedCount,
  init,
  runChecks,
  setView,
  state,
  supported,
  type View,
} from "@/ui/store";

onMounted(init);

const isCategory = (v: View): v is CategoryId => CATEGORIES.some((c) => c.id === v);

const nav = computed(() => [
  { id: "overview" as View, label: "Overview", icon: "overview" as IconName, badge: null },
  ...CATEGORIES.map((c) => {
    const list = categoryFindings(c.id);
    const sev = list.some((f) => f.severity === "critical")
      ? "critical"
      : list.some((f) => f.severity === "warning")
        ? "warning"
        : list.length
          ? "info"
          : null;
    return {
      id: c.id as View,
      label: c.title,
      icon: c.id as IconName,
      badge: list.length ? { count: list.length, sev } : null,
    };
  }),
]);

const tools = [
  { id: "top-queries" as View, label: "Top queries", icon: "list" as IconName },
  { id: "analyzer" as View, label: "Query analyzer", icon: "analyzer" as IconName },
];

const progressLabel = computed(() =>
  state.running && state.progress.total
    ? `${state.progress.current} (${state.progress.done + 1}/${state.progress.total})`
    : "",
);
const lastRun = computed(() =>
  state.report ? new Date(state.report.startedAt).toLocaleTimeString() : null,
);
</script>

<template>
  <div v-if="state.phase === 'loading'" class="center">
    <span class="spinner" /> Connecting…
  </div>

  <div v-else-if="state.phase === 'unsupported'" class="center column">
    <Icon name="speed" :size="40" class="logo" />
    <h2>{{ state.databaseType || "This database" }} isn't supported yet</h2>
    <p class="muted">The optimizer currently supports {{ supported.join(", ") }}.</p>
  </div>

  <div v-else-if="state.phase === 'error'" class="center column">
    <Icon name="critical" :size="36" class="error-icon" />
    <h2>Couldn't start the optimizer</h2>
    <pre class="error-text">{{ state.error }}</pre>
  </div>

  <div v-else class="layout">
    <header class="topbar row">
      <Icon name="speed" :size="20" class="logo" />
      <div class="title">
        <h1>Postgres Optimizer</h1>
        <span class="faint">{{ state.env?.databaseName }} · {{ state.env?.engine }} {{ state.env?.serverVersion.split(" ")[0] }}</span>
      </div>
      <span class="pill" :class="state.env?.capabilities.queryStats ? 'sev-success' : 'sev-warning'" title="Query statistics">
        pg_stat_statements {{ state.env?.capabilities.queryStats ? "on" : "off" }}
      </span>
      <span v-if="state.env?.capabilities.hypotheticalIndexes" class="pill sev-success" title="Index suggestions are verified with hypothetical indexes">hypopg on</span>
      <span v-if="state.env?.readOnly" class="pill">read-only connection</span>
      <span class="spacer" />
      <span v-if="state.running" class="row faint progress"><span class="spinner" />{{ progressLabel }}</span>
      <span v-else-if="lastRun" class="faint">Checked at {{ lastRun }}</span>
      <button class="icon-btn" title="Thresholds" @click="state.settingsOpen = true"><Icon name="settings" /></button>
      <button class="btn btn-primary" :disabled="state.running" @click="runChecks">
        <Icon name="refresh" :size="16" /> Run checks
      </button>
    </header>

    <nav class="sidebar">
      <button
        v-for="item in nav"
        :key="item.id"
        class="nav-item"
        :class="{ active: state.view === item.id }"
        @click="setView(item.id)"
      >
        <Icon :name="item.icon" :size="16" />
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.badge" class="pill" :class="`sev-${item.badge.sev}`">{{ item.badge.count }}</span>
      </button>
      <div class="nav-heading">Tools</div>
      <button
        v-for="item in tools"
        :key="item.id"
        class="nav-item"
        :class="{ active: state.view === item.id }"
        @click="setView(item.id)"
      >
        <Icon :name="item.icon" :size="16" />
        <span class="nav-label">{{ item.label }}</span>
      </button>
      <span class="spacer" />
      <label v-if="dismissedCount" class="check faint show-dismissed">
        <input v-model="state.showDismissed" type="checkbox" />
        Show {{ dismissedCount }} dismissed
      </label>
    </nav>

    <main class="content">
      <div class="content-inner">
        <OverviewView v-if="state.view === 'overview'" />
        <CategoryView v-else-if="isCategory(state.view)" :category="state.view" />
        <TopQueriesView v-else-if="state.view === 'top-queries'" />
        <AnalyzerView v-else-if="state.view === 'analyzer'" />
      </div>
    </main>

    <SettingsDialog v-if="state.settingsOpen" />
  </div>
</template>

<style scoped>
.center {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}
.center.column {
  flex-direction: column;
}
.center h2 {
  font-size: 17px;
}
.center p {
  margin: 0;
}
.error-icon {
  color: var(--c-danger);
}
.error-text {
  max-width: 640px;
  white-space: pre-wrap;
  color: var(--c-danger);
}
.layout {
  height: 100%;
  display: grid;
  grid-template-columns: 228px 1fr;
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "top top"
    "side main";
}
.topbar {
  grid-area: top;
  padding: 8px 14px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-panel);
  flex-wrap: wrap;
  gap: 10px;
}
.logo {
  color: var(--c-primary);
}
.title {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  margin-right: 8px;
}
.title h1 {
  font-size: 14px;
}
.title span {
  font-size: 12px;
}
.progress {
  font-size: 12px;
  max-width: 320px;
  overflow: hidden;
  white-space: nowrap;
}
.sidebar {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-right: 1px solid var(--c-border);
  background: var(--c-panel);
  overflow-y: auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--c-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover {
  background: var(--c-hover);
}
.nav-item.active {
  background: var(--c-hover);
  color: var(--c-text-strong);
  font-weight: 600;
}
.nav-item.active svg {
  color: var(--c-primary);
}
.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-heading {
  margin: 14px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--c-text-faint);
}
.show-dismissed {
  padding: 6px 8px;
  font-size: 12px;
}
.content {
  grid-area: main;
  overflow-y: auto;
  min-width: 0;
}
.content-inner {
  max-width: 1100px;
  padding: 16px 20px 40px;
}

@media (max-width: 720px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto 1fr;
    grid-template-areas:
      "top"
      "side"
      "main";
  }
  .sidebar {
    flex-direction: row;
    flex-wrap: wrap;
    border-right: none;
    border-bottom: 1px solid var(--c-border);
  }
  .nav-heading,
  .sidebar .spacer {
    display: none;
  }
}
</style>
