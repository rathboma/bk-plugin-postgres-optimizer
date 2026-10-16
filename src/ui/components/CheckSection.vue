<script setup lang="ts">
import { computed, ref } from "vue";
import type { CheckResult } from "@/core/types";
import { formatMs } from "@/core/format";
import { isFindingDismissed, state } from "../store";
import FindingCard from "./FindingCard.vue";
import Icon from "./Icon.vue";
import RawDataTable from "./RawDataTable.vue";

const props = defineProps<{ result: CheckResult }>();

const showData = ref(false);

const visible = computed(() =>
  props.result.findings.filter((f) => state.showDismissed || !isFindingDismissed(f)),
);
const hiddenCount = computed(() => props.result.findings.length - visible.value.length);

const status = computed(() => {
  const r = props.result;
  if (r.status === "error") return { label: "Failed", cls: "sev-critical", icon: "critical" as const };
  if (r.status === "skipped") return { label: "Skipped", cls: "", icon: "skipped" as const };
  if (!visible.value.length) return { label: hiddenCount.value ? "All dismissed" : "No issues", cls: "sev-success", icon: "check" as const };
  return {
    label: `${visible.value.length} ${visible.value.length === 1 ? "issue" : "issues"}`,
    cls: visible.value.some((f) => f.severity === "critical")
      ? "sev-critical"
      : visible.value.some((f) => f.severity === "warning")
        ? "sev-warning"
        : "sev-info",
    icon: null,
  };
});
</script>

<template>
  <section class="check">
    <header class="row head">
      <h3>{{ result.title }}</h3>
      <span class="pill" :class="status.cls">
        <Icon v-if="status.icon" :name="status.icon" :size="12" />
        {{ status.label }}
      </span>
      <span class="spacer" />
      <span class="faint duration" v-if="result.durationMs > 0">{{ formatMs(result.durationMs) }}</span>
      <button
        v-if="result.rows.length"
        class="icon-btn"
        :class="{ on: showData }"
        :title="showData ? 'Hide the raw data' : 'Show the raw data behind this check'"
        @click="showData = !showData"
      >
        <Icon name="data" :size="15" />
      </button>
    </header>
    <p class="muted desc">{{ result.description }}</p>
    <p v-if="result.message" class="message" :class="{ error: result.status === 'error' }">{{ result.message }}</p>
    <RawDataTable v-if="showData" :rows="result.rows" />
    <div v-if="visible.length" class="list">
      <FindingCard v-for="f in visible" :key="f.key" :finding="f" />
    </div>
  </section>
</template>

<style scoped>
.check {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 0;
  border-bottom: 1px solid var(--c-border);
}
.check:last-child {
  border-bottom: none;
}
.head h3 {
  font-size: 14px;
}
.desc {
  margin: 0;
}
.icon-btn.on {
  background: var(--c-hover);
  color: var(--c-text-strong);
}
.duration {
  font-size: 11px;
}
.message {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--radius);
  background: var(--c-subtle);
  color: var(--c-text-muted);
}
.message.error {
  background: color-mix(in srgb, var(--c-danger) 12%, transparent);
  color: var(--c-danger);
  font-family: var(--font-mono);
  font-size: 12px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
</style>
