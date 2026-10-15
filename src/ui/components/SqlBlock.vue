<script setup lang="ts">
import { computed, ref } from "vue";
import { highlightSql, prettySql } from "../highlight";
import { actions } from "../store";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    sql: string;
    /** Reformat single-line SQL from pg_stat_statements. */
    pretty?: boolean;
    /** Collapse to a few lines with a toggle. */
    collapsible?: boolean;
    actions?: boolean;
  }>(),
  { pretty: false, collapsible: false, actions: true },
);

const expanded = ref(false);
const text = computed(() => (props.pretty ? prettySql(props.sql) : props.sql.trim()));
const html = computed(() => highlightSql(text.value));
const long = computed(() => props.collapsible && text.value.split("\n").length > 6);
</script>

<template>
  <div class="sql-block">
    <pre class="sql" :class="{ clamp: long && !expanded }"><code v-html="html"></code></pre>
    <div class="tools">
      <button v-if="long" class="btn btn-sm btn-ghost" @click="expanded = !expanded">
        {{ expanded ? "Show less" : "Show all" }}
      </button>
      <template v-if="props.actions">
        <button class="icon-btn" title="Copy" @click="actions.copy(text)">
          <Icon name="copy" :size="14" />
        </button>
        <button class="icon-btn" title="Open in a query tab" @click="actions.openInEditor(text)">
          <Icon name="open" :size="14" />
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sql-block {
  position: relative;
  background: var(--c-code-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
}
pre {
  margin: 0;
  padding: 8px 10px;
  padding-right: 72px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-strong);
}
pre.clamp {
  max-height: 7.5em;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, #000 60%, transparent);
}
.tools {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  gap: 2px;
}
.tools .icon-btn {
  width: 24px;
  height: 24px;
}
</style>
