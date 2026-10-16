<script setup lang="ts">
import { ref } from "vue";
import type { QuerySort, QueryStat } from "@/core/types";
import { formatBytes, formatMs, formatNumber, formatPercent, oneLine } from "@/core/format";
import { actions, analyzeQuery, loadTopQueries, state } from "../store";
import Icon from "./Icon.vue";
import NoticeCard from "./NoticeCard.vue";
import SqlBlock from "./SqlBlock.vue";

const sorts: { id: QuerySort; label: string }[] = [
  { id: "total", label: "Total time" },
  { id: "mean", label: "Mean time" },
  { id: "calls", label: "Calls" },
  { id: "io", label: "Disk reads" },
  { id: "temp", label: "Temp files" },
];
const expanded = ref<string | null>(null);

function toggle(q: QueryStat) {
  expanded.value = expanded.value === q.id ? null : q.id;
}

function slowClass(q: QueryStat) {
  if (q.meanTimeMs >= Math.max(1000, state.settings.slowQueryMs * 10)) return "sev-critical";
  if (q.meanTimeMs >= state.settings.slowQueryMs) return "sev-warning";
  return "";
}

</script>

<template>
  <div class="top-queries">
    <header class="row">
      <div>
        <h2>Top queries</h2>
        <p class="muted">Statistics from pg_stat_statements, normalized so the same query with different values counts once.</p>
      </div>
    </header>

    <div class="row toolbar">
      <div class="segmented" role="tablist">
        <button
          v-for="s in sorts"
          :key="s.id"
          role="tab"
          :aria-selected="state.topQueries.sort === s.id"
          :class="{ active: state.topQueries.sort === s.id }"
          @click="loadTopQueries(s.id)"
        >
          {{ s.label }}
        </button>
      </div>
      <span class="spacer" />
      <span v-if="state.topQueries.loading" class="spinner" />
      <button class="icon-btn" title="Refresh" @click="loadTopQueries()"><Icon name="refresh" :size="16" /></button>
    </div>

    <p v-if="state.topQueries.error" class="error">{{ state.topQueries.error }}</p>

    <template v-if="state.topQueries.result && !state.topQueries.result.available">
      <NoticeCard v-for="n in state.env?.notices.filter((n) => n.id.startsWith('pgss'))" :key="n.id" :notice="n" />
      <p v-if="!state.env?.notices.some((n) => n.id.startsWith('pgss'))" class="empty">{{ state.topQueries.result.reason }}</p>
    </template>

    <div v-else-if="state.topQueries.result" class="table-wrap card">
      <table>
        <thead>
          <tr>
            <th class="q">Query</th>
            <th>Calls</th>
            <th>Total</th>
            <th>Mean</th>
            <th>% time</th>
            <th>Rows/call</th>
            <th>Cache hit</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="q in state.topQueries.result.queries" :key="q.id">
            <tr class="query-row" :class="{ expanded: expanded === q.id }" @click="toggle(q)">
              <td class="q mono" :title="q.query">
                <Icon name="chevron" :size="14" class="chev" />{{ oneLine(q.query, 160) }}
              </td>
              <td>{{ formatNumber(q.calls) }}</td>
              <td>{{ formatMs(q.totalTimeMs) }}</td>
              <td><span :class="slowClass(q)" class="mean">{{ formatMs(q.meanTimeMs) }}</span></td>
              <td>
                <div class="bar-cell">
                  <div class="bar" :style="{ width: `${Math.min(100, q.percentOfTotal ?? 0)}%` }" />
                  <span>{{ formatPercent(q.percentOfTotal) }}</span>
                </div>
              </td>
              <td>{{ formatNumber(q.calls ? q.rows / q.calls : 0) }}</td>
              <td>{{ q.cacheHitRatio === null || q.cacheHitRatio === undefined ? "—" : formatPercent(q.cacheHitRatio * 100) }}</td>
            </tr>
            <tr v-if="expanded === q.id" class="detail-row">
              <td colspan="7">
                <div class="detail">
                  <SqlBlock :sql="q.query" pretty />
                  <div class="row stats">
                    <span>Max {{ formatMs(q.maxTimeMs) }}</span>
                    <span>Std dev {{ formatMs(q.stddevTimeMs) }}</span>
                    <span>Disk reads {{ formatBytes((q.blocksRead ?? 0) * 8192) }}</span>
                    <span>Temp written {{ formatBytes((q.tempBlocksWritten ?? 0) * 8192) }}</span>
                    <span v-if="q.ioTimeMs">I/O time {{ formatMs(q.ioTimeMs) }}</span>
                    <span v-if="q.user">User {{ q.user }}</span>
                  </div>
                  <div class="row">
                    <button class="btn btn-sm btn-primary" @click="analyzeQuery(q.query)">
                      <Icon name="analyzer" :size="14" /> Analyze query
                    </button>
                    <button class="btn btn-sm" @click="actions.openInEditor(q.query)">
                      <Icon name="open" :size="14" /> Open in editor
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!state.topQueries.result.queries.length">
            <td colspan="7" class="empty">No queries recorded yet.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty"><span class="spinner" /></div>
  </div>
</template>

<style scoped>
.top-queries {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h2 {
  font-size: 17px;
}
header p {
  margin: 4px 0 0;
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  overflow: hidden;
}
.segmented button {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--c-border);
  color: var(--c-text);
  cursor: pointer;
}
.segmented button:last-child {
  border-right: none;
}
.segmented button.active {
  background: var(--c-hover);
  color: var(--c-text-strong);
  font-weight: 600;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
th {
  text-align: right;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--c-text-muted);
  padding: 8px 10px;
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
td {
  text-align: right;
  padding: 6px 10px;
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
  color: var(--c-text-strong);
}
th.q,
td.q {
  text-align: left;
}
td.q {
  max-width: 0;
  width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--c-text);
}
.query-row {
  cursor: pointer;
}
.query-row:hover,
.query-row.expanded {
  background: var(--c-subtle);
}
.chev {
  color: var(--c-text-faint);
  margin-right: 4px;
  transition: transform 0.12s;
}
.expanded .chev {
  transform: rotate(90deg);
}
.mean.sev-warning,
.mean.sev-critical {
  color: var(--sev);
  font-weight: 600;
}
.bar-cell {
  position: relative;
  display: flex;
  justify-content: flex-end;
  min-width: 64px;
}
.bar {
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--c-primary) 25%, transparent);
}
.bar-cell span {
  position: relative;
}
.detail-row td {
  text-align: left;
  white-space: normal;
  background: var(--c-subtle);
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0 6px;
}
.stats {
  flex-wrap: wrap;
  gap: 4px 18px;
  color: var(--c-text-muted);
}
.error {
  color: var(--c-danger);
}
</style>
