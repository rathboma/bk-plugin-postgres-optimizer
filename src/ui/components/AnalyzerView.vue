<script setup lang="ts">
import { computed } from "vue";
import type { IndexSuggestion } from "@/core/types";
import { displayColumns, formatNumber, formatReduction } from "@/core/format";
import { actions, analyze, setView, state } from "../store";
import Icon from "./Icon.vue";

const result = computed(() => state.analyzer.result);

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void analyze();
  }
}

function tableName(s: IndexSuggestion) {
  return s.schema && s.schema !== "public" ? `${s.schema}.${s.table}` : s.table;
}

function verdict(s: IndexSuggestion) {
  if (s.coveredBy) return `An existing index (${s.coveredBy}) already covers this, so a new one won't help. Stale statistics or a filter matching too many rows can keep the planner from using it.`;
  if (!s.validation) return "Not verified.";
  if (!s.validation.usedByPlanner) return "The planner would not use it.";
  const saving = s.validation.costBefore > 0 ? 1 - s.validation.costAfter / s.validation.costBefore : 0;
  return `Verified with a hypothetical index: estimated cost ${formatReduction(saving)} lower.`;
}

const summary = computed(() => {
  const r = result.value;
  return r?.ok ? `${r.mode} · estimated cost ${formatNumber(r.totalCost)}` : "";
});
</script>

<template>
  <div class="analyzer">
    <div class="view-header">
      <h1>Analyze a query</h1>
      <p>See what makes a query slow and which index would help. The query is planned, never run.</p>
    </div>

    <div class="editor">
      <textarea
        v-model="state.analyzer.sql"
        rows="6"
        spellcheck="false"
        placeholder="SELECT * FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20"
        @keydown="onKey"
      />
      <div class="row bar">
        <button class="btn btn-primary" :disabled="state.analyzer.running || !state.analyzer.sql.trim()" @click="analyze()">
          <span v-if="state.analyzer.running" class="spinner" />
          Analyze
        </button>
        <span class="spacer" />
        <span class="faint kbd">Ctrl+Enter</span>
      </div>
    </div>

    <p v-if="!result && !state.analyzer.running" class="faint hint">
      Or pick one from <button class="link inline" @click="setView('queries')">Slow queries</button>.
    </p>

    <p v-if="result && !result.ok" class="error">{{ result.error }}</p>

    <template v-if="result && result.ok">
      <p class="faint summary">{{ summary }}</p>

      <section v-if="result.suggestions.length">
        <h2>Suggested indexes</h2>
        <div class="list">
          <div v-for="s in result.suggestions" :key="s.ddl" class="item">
            <div class="text">
              <div class="title">Add an index on {{ tableName(s) }} ({{ displayColumns(s.columns) }})</div>
              <p class="muted">{{ s.reason }}. {{ verdict(s) }}</p>
              <code class="ddl faint">{{ s.ddl }}</code>
            </div>
            <button
              v-if="!s.coveredBy"
              class="btn btn-sm"
              :class="{ 'btn-primary': s.validation?.usedByPlanner }"
              @click="actions.openInEditor(s.ddl)"
            >
              Create index <Icon name="open" :size="13" />
            </button>
          </div>
        </div>
        <p v-if="!state.env?.capabilities.hypotheticalIndexes" class="faint small">
          Install the hypopg extension to have suggestions checked against the planner before building them.
        </p>
      </section>

      <section v-if="result.issues.length">
        <h2>What's slow</h2>
        <div class="list">
          <div v-for="(i, n) in result.issues" :key="n" class="item">
            <span class="dot" :class="i.severity === 'info' ? '' : i.severity" />
            <div class="text">
              <div class="title">{{ i.title }}</div>
              <p class="muted">{{ i.description }}</p>
            </div>
          </div>
        </div>
      </section>
      <p v-else-if="!result.suggestions.length" class="row ok">
        <span class="dot good" /> No missing indexes or slow scans found in this plan.
      </p>
    </template>
  </div>
</template>

<style scoped>
.analyzer {
  display: flex;
  flex-direction: column;
}
.view-header {
  margin-bottom: 14px;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.editor textarea {
  width: 100%;
  min-height: 110px;
  padding: 10px 12px;
}
.bar {
  flex-wrap: wrap;
  gap: 14px;
}
.kbd {
  font-size: 11px;
}
.hint {
  margin-top: 16px;
}
.link.inline {
  font-size: inherit;
  text-decoration: underline;
}
.error {
  margin-top: 16px;
  padding: 10px 12px;
  border-left: 2px solid var(--c-critical);
  background: var(--c-subtle);
  color: var(--c-text-strong);
  white-space: pre-wrap;
}
.summary {
  margin-top: 18px;
  font-size: 12px;
}
section {
  margin-top: 20px;
}
h2 {
  margin-bottom: 8px;
}
.item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px 10px 14px;
}
.item .dot {
  margin-top: 6px;
}
.item .btn {
  flex-shrink: 0;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title {
  color: var(--c-text-strong);
  font-weight: 500;
}
.text p {
  word-break: break-word;
}
.ddl {
  margin-top: 4px;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ok {
  margin-top: 20px;
  color: var(--c-text-muted);
}
.small {
  font-size: 12px;
  margin-top: 6px;
}
</style>
