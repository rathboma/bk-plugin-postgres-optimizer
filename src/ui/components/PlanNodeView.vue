<script setup lang="ts">
import { computed, ref } from "vue";
import type { PlanIssue, PlanNode } from "@/core/types";
import { formatMs, formatNumber } from "@/core/format";
import Icon from "./Icon.vue";
import SeverityIcon from "./SeverityIcon.vue";

const props = defineProps<{
  node: PlanNode;
  depth: number;
  /** Total execution time, to size the self-time bar. */
  totalMs?: number;
  issues: PlanIssue[];
}>();

const open = ref(false);
const nodeIssues = computed(() => props.issues.filter((i) => i.nodeId === props.node.id));
const worst = computed(() =>
  nodeIssues.value.find((i) => i.severity === "critical") ??
  nodeIssues.value.find((i) => i.severity === "warning") ??
  nodeIssues.value[0],
);
const executed = computed(() => props.node.actualRows !== undefined);
// Only executed plans have a meaningful per-step share: estimated costs are
// inclusive, per loop, and a Limit costs less than the steps under it.
const share = computed(() =>
  executed.value && props.totalMs && props.node.selfMs !== undefined ? props.node.selfMs / props.totalMs : 0,
);
const misestimate = computed(() => {
  if (!executed.value) return null;
  const est = Math.max(1, props.node.estimatedRows);
  const act = Math.max(1, props.node.actualRows!);
  const f = Math.max(est / act, act / est);
  return f >= 10 ? Math.round(f) : null;
});
</script>

<template>
  <div class="plan-node">
    <div
      class="line"
      :class="{ hot: share >= 0.3, open }"
      :style="{ paddingLeft: `${8 + depth * 18}px` }"
      role="button"
      tabindex="0"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
    >
      <Icon name="chevron" :size="14" class="chev" :class="{ invisible: !node.details.length }" />
      <SeverityIcon v-if="worst" :severity="worst.severity" :size="14" />
      <span class="label">{{ node.label }}</span>
      <span class="spacer" />
      <span class="stat" :title="executed ? 'Actual rows (per loop) / estimated rows' : 'Estimated rows'">
        <template v-if="executed">
          {{ formatNumber(node.actualRows) }}
          <span class="faint">/ {{ formatNumber(node.estimatedRows) }} est</span>
          <span v-if="misestimate" class="pill sev-warning">{{ misestimate }}x off</span>
        </template>
        <template v-else>{{ formatNumber(node.estimatedRows) }} rows</template>
      </span>
      <span v-if="node.loops && node.loops > 1" class="stat faint">× {{ formatNumber(node.loops) }}</span>
      <span class="stat time">
        <span v-if="executed" class="share" :style="{ width: `${Math.round(Math.min(1, share) * 100)}%` }" />
        <span class="value">{{ executed ? formatMs(node.selfMs) : `cost ${formatNumber(node.totalCost)}` }}</span>
      </span>
    </div>
    <div v-if="open && node.details.length" class="details" :style="{ marginLeft: `${34 + depth * 18}px` }">
      <div v-for="d in node.details" :key="d.label" class="detail">
        <span class="faint">{{ d.label }}</span>
        <code>{{ d.value }}</code>
      </div>
    </div>
    <PlanNodeView
      v-for="c in node.children"
      :key="c.id"
      :node="c"
      :depth="depth + 1"
      :total-ms="totalMs"
      :issues="issues"
    />
  </div>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--c-border) 60%, transparent);
  cursor: pointer;
}
.line:hover {
  background: var(--c-subtle);
}
.line.hot .label {
  color: var(--c-warning);
}
.chev {
  color: var(--c-text-faint);
  transition: transform 0.12s;
}
.chev.invisible {
  visibility: hidden;
}
.open .chev {
  transform: rotate(90deg);
}
.label {
  color: var(--c-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.stat {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.time {
  position: relative;
  width: 96px;
  justify-content: flex-end;
}
.share {
  position: absolute;
  left: 0;
  top: 1px;
  bottom: 1px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--c-warning) 28%, transparent);
}
.value {
  position: relative;
}
.details {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 10px;
  margin-top: 2px;
  margin-bottom: 4px;
  margin-right: 8px;
  border-radius: var(--radius);
  background: var(--c-code-bg);
}
.detail {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 8px;
}
.detail code {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-strong);
}
</style>
