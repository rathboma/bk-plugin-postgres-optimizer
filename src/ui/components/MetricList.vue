<script setup lang="ts">
import type { Metric } from "@/core/types";
import { formatMetric } from "@/core/format";

defineProps<{ metrics: Metric[] }>();
</script>

<template>
  <dl class="metrics">
    <div v-for="m in metrics" :key="m.label" class="metric">
      <dt>{{ m.label }}</dt>
      <dd :title="String(m.value ?? '')">{{ formatMetric(m.value, m.format) }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin: 0;
}
.metric {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
dt {
  font-size: 11px;
  color: var(--c-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
dd {
  margin: 0;
  color: var(--c-text-strong);
  font-variant-numeric: tabular-nums;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
