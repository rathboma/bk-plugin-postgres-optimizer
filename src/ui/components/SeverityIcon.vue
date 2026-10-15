<script setup lang="ts">
import type { Severity } from "@/core/types";
import Icon from "./Icon.vue";

defineProps<{ severity: Severity; size?: number }>();
</script>

<template>
  <span class="sev-icon" :class="`sev-${severity}`" :title="severity">
    <Icon :name="severity" :size="size ?? 16" />
  </span>
</template>

<style scoped>
.sev-icon {
  display: inline-flex;
}
</style>
