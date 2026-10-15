<script setup lang="ts">
import { computed, ref } from "vue";
import type { Finding } from "@/core/types";
import { actions, analyzeQuery, dismiss, isFindingDismissed, restore, state } from "../store";
import Icon from "./Icon.vue";
import MetricList from "./MetricList.vue";
import SeverityIcon from "./SeverityIcon.vue";
import SqlBlock from "./SqlBlock.vue";

const props = defineProps<{ finding: Finding; startOpen?: boolean; showCategory?: boolean }>();

const open = ref(props.startOpen ?? false);
const dismissed = computed(() => isFindingDismissed(props.finding));
const canAnalyze = computed(() => !!props.finding.query && !!state.adapter?.explain);
const tableTarget = computed(() => {
  const t = props.finding.target;
  if (!t) return null;
  if (t.kind === "table") return { name: t.name, schema: t.schema };
  if ((t.kind === "index" || t.kind === "constraint") && t.table) return { name: t.table, schema: t.schema };
  return null;
});
const safetyLabel: Record<string, string> = {
  safe: "Safe to run",
  caution: "Review first",
  destructive: "Destructive",
};
</script>

<template>
  <article class="finding" :class="[`sev-${finding.severity}`, { open, dismissed }]">
    <header class="head" role="button" tabindex="0" @click="open = !open" @keydown.enter.prevent="open = !open">
      <Icon name="chevron" :size="16" class="chev" />
      <SeverityIcon :severity="finding.severity" />
      <span class="title">{{ finding.title }}</span>
      <span v-if="dismissed" class="pill">Dismissed</span>
    </header>

    <div v-if="open" class="body">
      <p class="desc">{{ finding.description }}</p>
      <MetricList v-if="finding.metrics?.length" :metrics="finding.metrics" />

      <div v-if="finding.query" class="section">
        <div class="section-label">Query</div>
        <SqlBlock :sql="finding.query" pretty collapsible />
      </div>

      <div v-if="finding.fix" class="section">
        <div class="section-label row">
          <span>Suggested fix: {{ finding.fix.title }}</span>
          <span class="pill" :class="{
            'sev-success': finding.fix.safety === 'safe',
            'sev-warning': finding.fix.safety === 'caution',
            'sev-critical': finding.fix.safety === 'destructive',
          }">{{ safetyLabel[finding.fix.safety] }}</span>
        </div>
        <SqlBlock :sql="finding.fix.sql" />
        <p v-if="finding.fix.notes" class="muted note">{{ finding.fix.notes }}</p>
      </div>

      <footer class="row actions">
        <button v-if="canAnalyze" class="btn btn-sm" @click="analyzeQuery(finding.query!)">
          <Icon name="analyzer" :size="14" /> Analyze query
        </button>
        <button v-if="finding.fix" class="btn btn-sm" @click="actions.openInEditor(finding.fix.sql)">
          <Icon name="open" :size="14" /> Open fix in editor
        </button>
        <button v-if="tableTarget" class="btn btn-sm" @click="actions.openTable(tableTarget.name, tableTarget.schema)">
          <Icon name="table" :size="14" /> Table structure
        </button>
        <button v-if="finding.learnMoreUrl" class="btn btn-sm btn-ghost" @click="actions.openLink(finding.learnMoreUrl)">
          <Icon name="help" :size="14" /> Docs
        </button>
        <span class="spacer" />
        <button v-if="!dismissed" class="btn btn-sm btn-ghost" title="Hide this finding on future runs" @click="dismiss(finding)">
          <Icon name="hide" :size="14" /> Dismiss
        </button>
        <button v-else class="btn btn-sm btn-ghost" @click="restore(finding)">
          <Icon name="show" :size="14" /> Restore
        </button>
      </footer>
    </div>
  </article>
</template>

<style scoped>
.finding {
  border: 1px solid var(--c-border);
  border-left: 3px solid var(--sev);
  border-radius: var(--radius);
  background: var(--c-panel);
}
.finding.dismissed {
  opacity: 0.6;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
}
.head:hover {
  background: var(--c-subtle);
}
.head:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--c-primary) 70%, transparent);
  outline-offset: -2px;
}
.chev {
  color: var(--c-text-faint);
  transition: transform 0.12s;
}
.open .chev {
  transform: rotate(90deg);
}
.title {
  flex: 1;
  min-width: 0;
  color: var(--c-text-strong);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.open .title {
  white-space: normal;
  word-break: break-word;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 12px 12px 36px;
}
.desc {
  margin: 0;
  white-space: pre-line;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--c-text-muted);
}
.note {
  margin: 0;
  font-size: 12px;
}
.actions {
  flex-wrap: wrap;
}
</style>
