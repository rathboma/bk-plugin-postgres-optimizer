<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AnalyzerView from "@/ui/components/AnalyzerView.vue";
import ChecksView from "@/ui/components/ChecksView.vue";
import Icon from "@/ui/components/Icon.vue";
import RecommendationsView from "@/ui/components/RecommendationsView.vue";
import SettingsDialog from "@/ui/components/SettingsDialog.vue";
import SlowQueriesView from "@/ui/components/SlowQueriesView.vue";
import { init, recommendations, runChecks, setView, state, supported, type View } from "@/ui/store";

onMounted(init);

// Start each view at the top instead of wherever the last one was scrolled to.
const content = ref<HTMLElement | null>(null);
watch(
  () => state.view,
  () => content.value?.scrollTo({ top: 0 }),
);

const tabs = computed(() => [
  { id: "recommendations" as View, label: "Recommendations", count: state.report ? recommendations.value.length : null },
  { id: "queries" as View, label: "Slow queries", count: null },
  { id: "analyze" as View, label: "Analyze a query", count: null },
]);
// The full check list is a page of Recommendations.
const activeTab = computed(() => (state.view === "checks" ? "recommendations" : state.view));

// Tick so "Checked 2 min ago" stays current.
const now = ref(Date.now());
const timer = window.setInterval(() => (now.value = Date.now()), 30_000);
onBeforeUnmount(() => window.clearInterval(timer));

const lastChecked = computed(() => {
  if (!state.report) return "";
  const s = Math.max(0, (now.value - new Date(state.report.startedAt).getTime()) / 1000);
  if (s < 60) return "Checked just now";
  if (s < 3600) return `Checked ${Math.floor(s / 60)} min ago`;
  return `Checked at ${new Date(state.report.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
});
</script>

<template>
  <div v-if="state.phase === 'loading'" class="center">
    <span class="spinner" /> Connecting…
  </div>

  <div v-else-if="state.phase === 'unsupported'" class="center column">
    <h2>{{ state.databaseType || "This database" }} isn't supported yet</h2>
    <p class="muted">The optimizer currently supports {{ supported.join(", ") }}.</p>
  </div>

  <div v-else-if="state.phase === 'error'" class="center column">
    <h2>Couldn't start the optimizer</h2>
    <pre class="error-text">{{ state.error }}</pre>
  </div>

  <div v-else class="layout">
    <header class="topbar">
      <nav class="tabs" role="tablist">
        <button
          v-for="t in tabs"
          :key="t.id"
          role="tab"
          class="tab"
          :class="{ active: activeTab === t.id }"
          :aria-selected="activeTab === t.id"
          @click="setView(t.id)"
        >
          {{ t.label }}
          <span v-if="t.count" class="count">{{ t.count }}</span>
        </button>
      </nav>
      <span class="spacer" />
      <span class="status faint">
        <template v-if="state.running"><span class="spinner" /> Checking…</template>
        <template v-else>{{ lastChecked }}</template>
      </span>
      <button class="icon-btn" title="Check again" :disabled="state.running" @click="runChecks">
        <Icon name="refresh" />
      </button>
      <button class="icon-btn" title="Thresholds" @click="state.settingsOpen = true">
        <Icon name="settings" />
      </button>
    </header>

    <main ref="content" class="content">
      <div class="content-inner">
        <RecommendationsView v-if="state.view === 'recommendations'" />
        <SlowQueriesView v-else-if="state.view === 'queries'" />
        <AnalyzerView v-else-if="state.view === 'analyze'" />
        <ChecksView v-else-if="state.view === 'checks'" />
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
  color: var(--c-text-muted);
}
.center.column {
  flex-direction: column;
}
.error-text {
  max-width: 640px;
  margin: 0;
  white-space: pre-wrap;
  color: var(--c-text);
}
.layout {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.tabs {
  display: flex;
  gap: 20px;
  min-width: 0;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: none;
  color: var(--c-text-muted);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.tab:hover {
  color: var(--c-text-strong);
}
.tab.active {
  color: var(--c-text-strong);
  border-bottom-color: var(--c-text-strong);
}
.tab:focus-visible {
  outline: 1px solid var(--c-text-muted);
}
.count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--c-hover);
  color: var(--c-text);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 4px;
  font-size: 12px;
  white-space: nowrap;
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.content-inner {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 24px 48px;
}

@media (max-width: 560px) {
  .status {
    display: none;
  }
  .tabs {
    gap: 14px;
  }
}
</style>
