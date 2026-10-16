<script setup lang="ts">
import { computed, ref } from "vue";
import { checkSummary, dismissedCount, recommendations, setView, state } from "../store";
import Callout from "./Callout.vue";
import RecommendationRow from "./RecommendationRow.vue";

/** Show the few that matter most; the rest are a click away. */
const TOP = 6;
const showAll = ref(false);
const shown = computed(() => (showAll.value ? recommendations.value : recommendations.value.slice(0, TOP)));
const hidden = computed(() => recommendations.value.length - shown.value.length);

// Setup problems that hide whole features go first; tips go under the list.
const blockers = computed(() => (state.env?.notices ?? []).filter((n) => n.severity !== "info"));
const tips = computed(() =>
  (state.env?.notices ?? []).filter((n) => n.severity === "info" && n.id !== "pgss-own-queries-only"),
);

const heading = computed(() => {
  const n = recommendations.value.length;
  if (!n) return "Nothing to fix right now";
  return `${n} ${n === 1 ? "recommendation" : "recommendations"} for ${state.env?.databaseName}`;
});

const summary = computed(() => {
  const s = checkSummary.value;
  return [
    `${s.total} checks`,
    `${s.passed} passed`,
    s.skipped ? `${s.skipped} skipped` : "",
    s.failed ? `${s.failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
});
</script>

<template>
  <div class="recommendations">
    <div v-if="!state.report" class="empty row loading">
      <span class="spinner" /> Running checks…
    </div>

    <template v-else>
      <div class="view-header">
        <h1>{{ heading }}</h1>
        <p v-if="recommendations.length">Most important first. Fixes open in a query tab so you can review them before running.</p>
        <p v-else>{{ checkSummary.passed }} of {{ checkSummary.total }} checks passed.</p>
      </div>

      <div v-if="blockers.length" class="callouts">
        <Callout v-for="n in blockers" :key="n.id" :notice="n" />
      </div>

      <div v-if="recommendations.length" class="list">
        <RecommendationRow v-for="r in shown" :key="r.key" :rec="r" />
      </div>
      <button v-if="hidden > 0" class="link more" @click="showAll = true">Show {{ hidden }} more</button>

      <footer class="row footer">
        <span class="faint">{{ summary }}</span>
        <button class="link" @click="setView('checks')">See all checks</button>
        <span class="spacer" />
        <label v-if="dismissedCount" class="check faint">
          <input v-model="state.showDismissed" type="checkbox" />
          Show {{ dismissedCount }} dismissed
        </label>
      </footer>

      <div v-if="tips.length" class="callouts tips">
        <Callout v-for="n in tips" :key="n.id" :notice="n" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.loading {
  justify-content: center;
}
.callouts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.more {
  margin-top: 10px;
}
.footer {
  margin-top: 20px;
  font-size: 12px;
  gap: 12px;
}
.tips {
  margin-top: 28px;
}
</style>
