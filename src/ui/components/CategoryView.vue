<script setup lang="ts">
import { computed } from "vue";
import { CATEGORIES, type CategoryId } from "@/core/types";
import { categoryResults, state } from "../store";
import CheckSection from "./CheckSection.vue";

const props = defineProps<{ category: CategoryId }>();

const info = computed(() => CATEGORIES.find((c) => c.id === props.category)!);
const results = computed(() => {
  // Checks with findings first, then passed, then skipped.
  const order = { error: 1, issues: 0, passed: 2, skipped: 3 } as const;
  return [...categoryResults(props.category)].sort((a, b) => order[a.status] - order[b.status]);
});
</script>

<template>
  <div class="category-view">
    <header>
      <h2>{{ info.title }}</h2>
      <p class="muted">{{ info.description }}</p>
    </header>
    <div v-if="!state.report" class="empty"><span class="spinner" /> Running checks…</div>
    <CheckSection v-for="r in results" v-else :key="r.checkId" :result="r" />
  </div>
</template>

<style scoped>
header h2 {
  font-size: 17px;
}
header p {
  margin: 4px 0 0;
}
.empty {
  display: flex;
  justify-content: center;
  gap: 8px;
}
</style>
