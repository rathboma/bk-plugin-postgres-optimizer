<script setup lang="ts">
import { computed } from "vue";
import type { IndexSuggestion } from "@/core/types";
import { displayColumns, formatMs, formatNumber, formatPercent } from "@/core/format";
import { actions, analyze, state } from "../store";
import Icon from "./Icon.vue";
import PlanNodeView from "./PlanNodeView.vue";
import SeverityIcon from "./SeverityIcon.vue";
import SqlBlock from "./SqlBlock.vue";

const result = computed(() => state.analyzer.result);
const hasParams = computed(() => /\$\d+/.test(state.analyzer.sql));

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void analyze();
  }
}

function suggestionStatus(s: IndexSuggestion) {
  if (s.coveredBy) return { label: `Already covered by ${s.coveredBy}`, cls: "" };
  if (!s.validation) return { label: "Not verified", cls: "" };
  if (!s.validation.usedByPlanner) return { label: "Planner would not use it", cls: "sev-warning" };
  const saving = s.validation.costBefore > 0 ? 1 - s.validation.costAfter / s.validation.costBefore : 0;
  return { label: `Verified: cost −${formatPercent(saving * 100, 0)}`, cls: "sev-success" };
}
</script>

<template>
  <div class="analyzer">
    <header>
      <h2>Query analyzer</h2>
      <p class="muted">
        Shows the query plan, flags slow operations and suggests indexes. Queries from pg_stat_statements with
        <code>$1</code> placeholders are planned generically.
      </p>
    </header>

    <div class="editor card">
      <textarea
        v-model="state.analyzer.sql"
        rows="7"
        spellcheck="false"
        placeholder="SELECT * FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20"
        @keydown="onKey"
      />
      <div class="row bar">
        <label class="check" :class="{ disabled: hasParams }" :title="hasParams ? 'Replace the $1 placeholders with values to execute the query' : ''">
          <input v-model="state.analyzer.analyze" type="checkbox" :disabled="hasParams" />
          Execute the query (EXPLAIN ANALYZE)
        </label>
        <span v-if="state.analyzer.analyze && !hasParams" class="faint hint">
          Runs the query for real, inside a read-only transaction. SELECT only.
        </span>
        <span class="spacer" />
        <button class="btn btn-primary" :disabled="state.analyzer.running || !state.analyzer.sql.trim()" @click="analyze()">
          <span v-if="state.analyzer.running" class="spinner" />
          <Icon v-else name="play" :size="16" />
          Analyze
        </button>
      </div>
    </div>

    <div v-if="result && !result.ok" class="error-box">
      <Icon name="critical" :size="16" />
      <span>{{ result.error }}</span>
    </div>

    <template v-if="result && result.ok && result.plan">
      <div class="row summary">
        <span class="pill">{{ result.mode }}</span>
        <span v-if="result.executionMs !== undefined">Execution <strong>{{ formatMs(result.executionMs) }}</strong></span>
        <span v-if="result.planningMs !== undefined">Planning <strong>{{ formatMs(result.planningMs) }}</strong></span>
        <span>Estimated cost <strong>{{ formatNumber(result.totalCost) }}</strong></span>
      </div>

      <section v-if="result.suggestions.length">
        <h3><Icon name="bulb" :size="16" class="bulb" /> Index suggestions</h3>
        <div class="suggestions">
          <div v-for="s in result.suggestions" :key="s.ddl" class="suggestion card">
            <div class="row">
              <strong>{{ s.schema ? `${s.schema}.` : "" }}{{ s.table }} ({{ displayColumns(s.columns) }})</strong>
              <span class="spacer" />
              <span class="pill" :class="suggestionStatus(s).cls">{{ suggestionStatus(s).label }}</span>
            </div>
            <p class="muted">{{ s.reason }}.</p>
            <SqlBlock v-if="!s.coveredBy" :sql="s.ddl" />
            <p v-if="s.coveredBy" class="muted small">
              An existing index already starts with these columns, so a new one won't help. The planner may be skipping
              it because statistics are stale (run ANALYZE) or because the filter matches too many rows for an index to pay off.
            </p>
          </div>
        </div>
        <p v-if="!state.env?.capabilities.hypotheticalIndexes" class="faint small">
          Install the hypopg extension to have suggestions checked against the planner before building them.
        </p>
      </section>

      <section v-if="result.issues.length">
        <h3>Issues</h3>
        <div class="issues">
          <div v-for="(i, n) in result.issues" :key="n" class="issue card" :class="`sev-${i.severity}`">
            <SeverityIcon :severity="i.severity" />
            <div class="issue-body">
              <strong>{{ i.title }}</strong>
              <p class="muted">{{ i.description }}</p>
              <div v-if="i.fix" class="row">
                <button class="btn btn-sm" @click="actions.openInEditor(i.fix.sql)">
                  <Icon name="open" :size="14" /> {{ i.fix.title }}
                </button>
                <code class="faint">{{ i.fix.sql.split("\n")[0] }}</code>
              </div>
            </div>
          </div>
        </div>
      </section>
      <p v-else-if="!result.suggestions.length" class="ok row">
        <Icon name="check" :size="16" /> No problems spotted in this plan.
      </p>

      <section>
        <div class="row">
          <h3>Plan</h3>
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" @click="actions.copy(JSON.stringify(result.rawPlan, null, 2))">
            <Icon name="copy" :size="14" /> Copy JSON
          </button>
        </div>
        <div class="plan card">
          <PlanNodeView
            :node="result.plan"
            :depth="0"
            :total-ms="result.executionMs"
            :issues="result.issues"
          />
        </div>
        <p class="faint small">
          Click a step for its details.{{ result.executionMs !== undefined ? " The bar shows the time spent in each step itself." : " Run with EXPLAIN ANALYZE to see where the time goes." }}
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analyzer {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h2 {
  font-size: 17px;
}
h3 {
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
header p {
  margin: 4px 0 0;
}
.editor {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.editor textarea {
  width: 100%;
  min-height: 110px;
  border: none;
  background: var(--c-code-bg);
}
.bar {
  flex-wrap: wrap;
}
.check.disabled {
  opacity: 0.5;
}
.hint {
  font-size: 12px;
}
.error-box {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--c-danger) 12%, transparent);
  color: var(--c-danger);
  white-space: pre-wrap;
}
.summary {
  flex-wrap: wrap;
  gap: 6px 18px;
  color: var(--c-text-muted);
}
.summary strong {
  color: var(--c-text-strong);
}
.bulb {
  color: var(--c-primary);
}
.suggestions,
.issues {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.suggestion {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.suggestion p {
  margin: 0;
}
.issue {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-left: 3px solid var(--sev);
}
.issue-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.issue-body p {
  margin: 0;
  word-break: break-word;
}
.issue-body code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan {
  overflow-x: auto;
  padding: 2px 0;
}
.small {
  font-size: 12px;
  margin: 6px 0 0;
}
.ok {
  color: var(--c-success);
}
</style>
