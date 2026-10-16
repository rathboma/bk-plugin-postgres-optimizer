<script setup lang="ts">
import { computed, ref } from "vue";
import type { QuerySort } from "@/core/types";
import { formatDateTime, formatMs, formatNumber, formatPercent, oneLine } from "@/core/format";
import { analyzeQuery, loadTopQueries, state } from "../store";
import Callout from "./Callout.vue";
import Icon from "./Icon.vue";

const sorts: { id: QuerySort; label: string }[] = [
  { id: "total", label: "Total time" },
  { id: "mean", label: "Average time" },
  { id: "calls", label: "Calls" },
  { id: "io", label: "Disk reads" },
  { id: "temp", label: "Temp files" },
];

const TOP = 20;
const showAll = ref(false);
const queries = computed(() => state.topQueries.result?.queries ?? []);
const shown = computed(() => (showAll.value ? queries.value : queries.value.slice(0, TOP)));

const notices = computed(() => (state.env?.notices ?? []).filter((n) => n.id.startsWith("pgss")));
const since = computed(() => state.env?.facts.find((f) => f.label === "Stats since")?.value ?? null);
</script>

<template>
  <div class="slow-queries">
    <div class="view-header">
      <h1>Slow queries</h1>
      <p v-if="state.env?.capabilities.queryStats">
        The queries this database spends the most time on<template v-if="since">, since {{ formatDateTime(since) }}</template>.
        Click one to see why it's slow.
      </p>
      <p v-else>Needs pg_stat_statements, which records how long every query takes.</p>
    </div>

    <div v-if="notices.length" class="callouts">
      <Callout v-for="n in notices" :key="n.id" :notice="n" />
    </div>

    <template v-if="state.topQueries.result?.available !== false">
      <div class="row toolbar">
        <label class="row faint">
          Sort by
          <select :value="state.topQueries.sort" @change="loadTopQueries(($event.target as HTMLSelectElement).value as QuerySort)">
            <option v-for="s in sorts" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
        </label>
        <span class="spacer" />
        <span v-if="state.topQueries.loading" class="spinner" />
        <button class="icon-btn" title="Refresh" @click="loadTopQueries()"><Icon name="refresh" :size="16" /></button>
      </div>

      <p v-if="state.topQueries.error" class="error">{{ state.topQueries.error }}</p>

      <div v-if="state.topQueries.result" class="list">
        <table>
          <thead>
            <tr>
              <th class="q">Query</th>
              <th>Average</th>
              <th>Calls</th>
              <th class="share-col">Share of time</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="q in shown"
              :key="q.id"
              tabindex="0"
              title="Analyze this query"
              @click="analyzeQuery(q.query)"
              @keydown.enter="analyzeQuery(q.query)"
            >
              <td class="q mono">{{ oneLine(q.query, 200) }}</td>
              <td :class="{ slow: q.meanTimeMs >= state.settings.slowQueryMs }">{{ formatMs(q.meanTimeMs) }}</td>
              <td>{{ formatNumber(q.calls) }}</td>
              <td class="share-col">
                <span class="bar"><span :style="{ width: `${Math.min(100, q.percentOfTotal ?? 0)}%` }" /></span>
                <span class="pct">{{ formatPercent(q.percentOfTotal, 0) }}</span>
              </td>
            </tr>
            <tr v-if="!queries.length">
              <td colspan="4" class="empty">No queries recorded yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="!state.topQueries.error" class="empty"><span class="spinner" /></div>

      <button v-if="!showAll && queries.length > TOP" class="link more" @click="showAll = true">
        Show all {{ queries.length }}
      </button>
    </template>
    <p v-else-if="!notices.length" class="empty">{{ state.topQueries.result?.reason }}</p>
  </div>
</template>

<style scoped>
.callouts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.toolbar {
  margin-bottom: 10px;
}
.toolbar select {
  padding: 3px 6px;
}
.error {
  color: var(--c-critical);
  margin-bottom: 10px;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
th,
td {
  padding: 8px 12px;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
th {
  font-size: 12px;
  font-weight: 500;
  color: var(--c-text-muted);
  border-bottom: 1px solid var(--c-border);
}
th:nth-child(2),
th:nth-child(3) {
  width: 90px;
}
.share-col {
  width: 140px;
}
.q {
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
}
td.q {
  color: var(--c-text-strong);
  font-size: 11.5px;
}
tbody tr {
  cursor: pointer;
}
tbody tr + tr td {
  border-top: 1px solid var(--c-border);
}
tbody tr:hover {
  background: var(--c-subtle);
}
tbody tr:focus-visible {
  outline: 1px solid var(--c-text-muted);
  outline-offset: -1px;
}
.slow {
  color: var(--c-warning);
}
.bar {
  display: inline-block;
  width: 60px;
  height: 4px;
  margin-right: 4px;
  vertical-align: middle;
  border-radius: 2px;
  background: var(--c-hover);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--c-text-faint);
}
.pct {
  display: inline-block;
  width: 36px;
}
.more {
  margin-top: 10px;
}
</style>
