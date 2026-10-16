<script setup lang="ts">
import type { Notice } from "@/core/types";
import { actions } from "../store";
import Icon from "./Icon.vue";

defineProps<{ notice: Notice }>();
</script>

<template>
  <div class="callout">
    <span class="dot" :class="notice.severity === 'info' ? '' : notice.severity" />
    <div class="text">
      <strong>{{ notice.title }}</strong>
      <p class="muted">{{ notice.body }}</p>
      <button v-if="notice.learnMoreUrl" class="link" @click="actions.openLink(notice.learnMoreUrl)">Learn more</button>
    </div>
    <button v-if="notice.fix" class="btn btn-sm" @click="actions.openInEditor(notice.fix.sql)">
      {{ notice.fix.title }} <Icon name="open" :size="13" />
    </button>
  </div>
</template>

<style scoped>
.callout {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  background: var(--c-subtle);
}
.dot {
  margin-top: 6px;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
strong {
  color: var(--c-text-strong);
  font-weight: 600;
}
.link {
  margin-top: 4px;
}
</style>
