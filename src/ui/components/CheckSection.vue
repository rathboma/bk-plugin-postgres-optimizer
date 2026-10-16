<script setup lang="ts">
import { computed, ref } from "vue";
import type { CheckResult } from "@/core/types";
import { isFindingDismissed, state } from "../store";
import RawDataTable from "./RawDataTable.vue";
import RecommendationRow from "./RecommendationRow.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ result: CheckResult }>();

const open = ref(false);
const showData = ref(false);

const findings = computed(() =>
  props.result.findings.filter((f) => state.showDismissed || !isFindingDismissed(f)),
);

const status = computed(() => {
  const r = props.result;
  switch (r.status) {
    case "error":
      return { label: "Failed", dot: "critical" };
    case "skipped":
      return { label: "Skipped", dot: "" };
    case "passed":
      return { label: "Passed", dot: "good" };
    default: {
      const n = findings.value.length;
      if (!n) return { label: "Dismissed", dot: "" };
      const worst = findings.value.some((f) => f.severity === "critical")
        ? "critical"
        : findings.value.some((f) => f.severity === "warning")
          ? "warning"
          : "";
      return { label: `${n} ${n === 1 ? "issue" : "issues"}`, dot: worst };
    }
  }
});
</script>

<template>
  <div class="check" :class="{ open }">
    <div
      class="head"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
    >
      <span class="dot" :class="status.dot" />
      <span class="title">{{ result.title }}</span>
      <span class="spacer" />
      <span class="faint status">{{ status.label }}</span>
      <Icon name="chevron" :size="16" class="chev" />
    </div>

    <div v-if="open" class="body">
      <p class="muted">{{ result.description }}</p>
      <p v-if="result.message" class="message">{{ result.message }}</p>
      <div v-if="findings.length" class="list">
        <RecommendationRow v-for="f in findings" :key="f.key" :rec="{ key: f.key, finding: f, related: [] }" />
      </div>
      <template v-if="result.rows.length">
        <button class="link" @click="showData = !showData">
          {{ showData ? "Hide data" : `Show the data behind this check (${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"})` }}
        </button>
        <RawDataTable v-if="showData" :rows="result.rows" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px 9px 14px;
  cursor: pointer;
}
.head:hover {
  background: var(--c-subtle);
}
.title {
  color: var(--c-text-strong);
}
.status {
  font-size: 12px;
}
.chev {
  color: var(--c-text-faint);
  transition: transform 0.12s;
}
.open .chev {
  transform: rotate(90deg);
}
.body {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 2px 14px 14px 33px;
}
.body > .link {
  align-self: flex-start;
}
.message {
  padding: 6px 10px;
  border-left: 2px solid var(--c-border);
  color: var(--c-text);
  word-break: break-word;
}
</style>
