<script setup lang="ts">
import type { Notice } from "@/core/types";
import { actions } from "../store";
import Icon from "./Icon.vue";
import SeverityIcon from "./SeverityIcon.vue";
import SqlBlock from "./SqlBlock.vue";

defineProps<{ notice: Notice }>();
</script>

<template>
  <div class="notice" :class="`sev-${notice.severity}`">
    <SeverityIcon :severity="notice.severity" :size="18" />
    <div class="content">
      <h4>{{ notice.title }}</h4>
      <p>{{ notice.body }}</p>
      <SqlBlock v-if="notice.fix" :sql="notice.fix.sql" />
      <div class="row" v-if="notice.fix || notice.learnMoreUrl">
        <button v-if="notice.fix" class="btn btn-sm" @click="actions.openInEditor(notice.fix.sql)">
          <Icon name="open" :size="14" /> {{ notice.fix.title }}
        </button>
        <button v-if="notice.learnMoreUrl" class="btn btn-sm btn-ghost" @click="actions.openLink(notice.learnMoreUrl)">
          <Icon name="help" :size="14" /> Learn more
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--sev) 35%, transparent);
  background: color-mix(in srgb, var(--sev) 7%, var(--c-panel));
}
.content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
h4 {
  font-size: 13px;
}
p {
  margin: 0;
}
</style>
