<script setup lang="ts">
import { computed } from "vue";
import type { Row } from "@/core/types";
import { actions } from "../store";

const props = defineProps<{ rows: Row[] }>();

/** Rendering thousands of rows is slow and nobody reads them here; copy has everything. */
const LIMIT = 200;

const columns = computed(() => [...new Set(props.rows.flatMap((r) => Object.keys(r)))]);
const shown = computed(() => props.rows.slice(0, LIMIT));

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function csv(): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    columns.value.map(esc).join(","),
    ...props.rows.map((r) => columns.value.map((c) => esc(cell(r[c]))).join(",")),
  ].join("\n");
}
</script>

<template>
  <div class="raw">
    <div class="row bar">
      <span class="faint">{{ rows.length }} {{ rows.length === 1 ? "row" : "rows" }}{{ rows.length > LIMIT ? `, showing ${LIMIT}` : "" }}</span>
      <span class="spacer" />
      <button class="link" @click="actions.copy(csv())">Copy as CSV</button>
    </div>
    <div class="scroll">
      <table>
        <thead>
          <tr><th v-for="c in columns" :key="c">{{ c }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in shown" :key="i">
            <td v-for="c in columns" :key="c" :title="cell(r[c])">{{ cell(r[c]) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.raw {
  overflow: hidden;
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
}
.bar {
  padding: 6px 10px;
  border-bottom: 1px solid var(--c-border);
  font-size: 12px;
}
.scroll {
  max-height: 320px;
  overflow: auto;
}
table {
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
th,
td {
  padding: 3px 10px;
  border-bottom: 1px solid var(--c-border);
  text-align: left;
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}
th {
  position: sticky;
  top: 0;
  background: var(--c-panel);
  color: var(--c-text-muted);
  font-weight: 600;
}
td {
  color: var(--c-text-strong);
}
</style>
