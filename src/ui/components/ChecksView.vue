<script setup lang="ts">
import { computed } from "vue";
import { CATEGORIES } from "@/core/types";
import { categoryResults, checkSummary, dismissedCount, setView, state } from "../store";
import CheckSection from "./CheckSection.vue";

const groups = computed(() =>
  CATEGORIES.map((c) => ({ ...c, results: categoryResults(c.id) })).filter((g) => g.results.length),
);
</script>

<template>
  <div class="checks">
    <button class="link back" @click="setView('recommendations')">← Recommendations</button>
    <div class="view-header">
      <h1>All checks</h1>
      <p>
        {{ checkSummary.total }} checks, {{ checkSummary.passed }} passed{{ checkSummary.skipped ? `, ${checkSummary.skipped} skipped` : "" }}{{ checkSummary.failed ? `, ${checkSummary.failed} failed` : "" }}.
        Open a check to see what it looks at and the data behind it.
      </p>
    </div>

    <div v-if="!state.report" class="empty row loading"><span class="spinner" /> Running checks…</div>

    <section v-for="g in groups" :key="g.id">
      <h2>{{ g.title }}</h2>
      <div class="list">
        <CheckSection v-for="r in g.results" :key="r.checkId" :result="r" />
      </div>
    </section>

    <label v-if="dismissedCount" class="check faint dismissed">
      <input v-model="state.showDismissed" type="checkbox" />
      Show {{ dismissedCount }} dismissed
    </label>
  </div>
</template>

<style scoped>
.back {
  margin-bottom: 14px;
}
.loading {
  justify-content: center;
}
section + section {
  margin-top: 22px;
}
h2 {
  margin-bottom: 8px;
}
.dismissed {
  margin-top: 20px;
  font-size: 12px;
}
</style>
