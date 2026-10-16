<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from "vue";
import { DEFAULT_SETTINGS, type OptimizerSettings } from "@/core/types";
import { saveSettings, state } from "../store";
import Icon from "./Icon.vue";

const MB = 1024 * 1024;
const form = reactive({
  ...state.settings,
  unusedIndexMinMb: state.settings.unusedIndexMinBytes / MB,
  deadTuplePercent: Math.round(state.settings.deadTupleRatio * 100),
});

const fields: { key: keyof typeof form; label: string; hint: string; unit: string }[] = [
  { key: "slowQueryMs", label: "Slow query threshold", hint: "Queries averaging at least this long are reported as slow.", unit: "ms" },
  { key: "minCalls", label: "Minimum calls", hint: "Ignore queries that have run fewer times than this.", unit: "calls" },
  { key: "largeTableRows", label: "Large table", hint: "Tables with fewer rows don't get index advice.", unit: "rows" },
  { key: "unusedIndexMinMb", label: "Unused index minimum size", hint: "Smaller unused indexes aren't reported.", unit: "MB" },
  { key: "deadTupleMin", label: "Dead rows", hint: "Report tables with at least this many dead rows…", unit: "rows" },
  { key: "deadTuplePercent", label: "Dead row share", hint: "…that make up at least this share of the table.", unit: "%" },
  { key: "longRunningQueryS", label: "Long-running query", hint: "Queries running longer than this are reported.", unit: "s" },
  { key: "idleInTransactionS", label: "Idle in transaction", hint: "Sessions idle in a transaction longer than this are reported.", unit: "s" },
  { key: "explainTopQueries", label: "Queries to examine for indexes", hint: "How many of the most expensive queries to EXPLAIN.", unit: "queries" },
];

function toSettings(): OptimizerSettings {
  const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  return {
    slowQueryMs: n(form.slowQueryMs, DEFAULT_SETTINGS.slowQueryMs),
    minCalls: n(form.minCalls, DEFAULT_SETTINGS.minCalls),
    largeTableRows: n(form.largeTableRows, DEFAULT_SETTINGS.largeTableRows),
    unusedIndexMinBytes: n(form.unusedIndexMinMb, 1) * MB,
    deadTupleMin: n(form.deadTupleMin, DEFAULT_SETTINGS.deadTupleMin),
    deadTupleRatio: n(form.deadTuplePercent, 20) / 100,
    longRunningQueryS: n(form.longRunningQueryS, DEFAULT_SETTINGS.longRunningQueryS),
    idleInTransactionS: n(form.idleInTransactionS, DEFAULT_SETTINGS.idleInTransactionS),
    explainTopQueries: Math.min(100, n(form.explainTopQueries, DEFAULT_SETTINGS.explainTopQueries)),
  };
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") state.settingsOpen = false;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

function reset() {
  Object.assign(form, {
    ...DEFAULT_SETTINGS,
    unusedIndexMinMb: DEFAULT_SETTINGS.unusedIndexMinBytes / MB,
    deadTuplePercent: Math.round(DEFAULT_SETTINGS.deadTupleRatio * 100),
  });
}
</script>

<template>
  <div class="backdrop" @click.self="state.settingsOpen = false">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="row">
        <h2 id="settings-title">Thresholds</h2>
        <span class="spacer" />
        <button class="icon-btn" title="Close" @click="state.settingsOpen = false"><Icon name="close" /></button>
      </header>
      <form @submit.prevent="saveSettings(toSettings())">
        <div v-for="f in fields" :key="f.key" class="field">
          <label :for="`setting-${f.key}`">
            <span class="label">{{ f.label }}</span>
            <span class="faint hint">{{ f.hint }}</span>
          </label>
          <div class="row">
            <input :id="`setting-${f.key}`" v-model.number="(form as any)[f.key]" type="number" min="0" step="any" />
            <span class="faint unit">{{ f.unit }}</span>
          </div>
        </div>
        <footer class="row">
          <button type="button" class="link" @click="reset">Reset to defaults</button>
          <span class="spacer" />
          <button type="button" class="btn" @click="state.settingsOpen = false">Cancel</button>
          <button type="submit" class="btn btn-primary">Save and re-run</button>
        </footer>
      </form>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  z-index: 10;
  overflow-y: auto;
}
.dialog {
  width: 100%;
  max-width: 560px;
  padding: 18px 20px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  background: var(--c-panel);
  box-shadow: var(--menu-shadow, 0 8px 30px rgba(0, 0, 0, 0.4));
}
header h2 {
  font-size: 15px;
}
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.field label {
  display: flex;
  flex-direction: column;
}
.label {
  color: var(--c-text-strong);
}
.hint {
  font-size: 12px;
}
.field input {
  width: 110px;
  text-align: right;
}
.unit {
  width: 52px;
  font-size: 12px;
}
footer {
  margin-top: 10px;
}
</style>
