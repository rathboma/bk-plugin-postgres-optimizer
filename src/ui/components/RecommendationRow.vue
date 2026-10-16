<script setup lang="ts">
import { computed, ref } from "vue";
import { formatMetric, oneLine } from "@/core/format";
import { firstSentence, type Recommendation } from "../recommendations";
import { actions, analyzeQuery, dismiss, isFindingDismissed, restore, state } from "../store";
import Icon from "./Icon.vue";
import SqlBlock from "./SqlBlock.vue";

const props = defineProps<{ rec: Recommendation }>();

const open = ref(false);
const f = computed(() => props.rec.finding);
const dismissed = computed(() => isFindingDismissed(f.value));
const canAnalyze = computed(() => !!f.value.query && !!state.adapter?.explain);

/** One obvious next step per row: apply the fix, or else look at the query. */
const cta = computed(() => {
  const fix = f.value.fix;
  if (fix) return { label: fix.title, icon: "open" as const, run: () => actions.openInEditor(fix.sql) };
  if (canAnalyze.value) return { label: "Analyze", icon: null, run: () => analyzeQuery(f.value.query!) };
  return null;
});

const subtitle = computed(() =>
  f.value.query ? oneLine(f.value.query, 160) : firstSentence(f.value.description),
);
const metrics = computed(() =>
  (f.value.metrics ?? []).map((m) => `${m.label} ${formatMetric(m.value, m.format)}`).join("  ·  "),
);
const related = computed(() =>
  props.rec.related.map((r) => r.description).filter((d) => d !== f.value.description),
);
const safety: Record<string, string> = {
  safe: "Safe to run",
  caution: "Review before running",
  destructive: "Destructive",
};
</script>

<template>
  <div class="rec" :class="{ open, dismissed }">
    <div
      class="head"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      @click="open = !open"
      @keydown.enter.self.prevent="open = !open"
    >
      <span class="dot" :class="f.severity === 'info' ? '' : f.severity" />
      <div class="text">
        <div class="title">{{ f.title }}<span v-if="dismissed" class="faint"> · dismissed</span></div>
        <div class="sub" :class="{ mono: f.query }">{{ subtitle }}</div>
      </div>
      <button v-if="cta" class="btn btn-sm cta" @click.stop="cta.run">
        {{ cta.label }} <Icon v-if="cta.icon" :name="cta.icon" :size="13" />
      </button>
      <Icon name="chevron" :size="16" class="chev" />
    </div>

    <div v-if="open" class="body">
      <p>{{ f.description }}</p>
      <p v-for="(d, i) in related" :key="i">{{ d }}</p>
      <p v-if="metrics" class="faint metrics">{{ metrics }}</p>

      <template v-if="f.query">
        <div class="label">Query</div>
        <SqlBlock :sql="f.query" pretty collapsible />
      </template>

      <template v-if="f.fix">
        <div class="label">
          {{ f.fix.title }}
          <span :class="{ destructive: f.fix.safety === 'destructive' }">· {{ safety[f.fix.safety] }}</span>
        </div>
        <SqlBlock :sql="f.fix.sql" />
        <p v-if="f.fix.notes" class="muted">{{ f.fix.notes }}</p>
      </template>

      <div class="row links">
        <button v-if="canAnalyze && f.fix" class="link" @click="analyzeQuery(f.query!)">Analyze query</button>
        <button v-if="f.learnMoreUrl" class="link" @click="actions.openLink(f.learnMoreUrl)">Docs</button>
        <span class="spacer" />
        <button v-if="!dismissed" class="link" title="Hide this until restored" @click="dismiss(f)">Dismiss</button>
        <button v-else class="link" @click="restore(f)">Restore</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 14px;
  cursor: pointer;
}
.head:hover {
  background: var(--c-subtle);
}
.text {
  flex: 1;
  min-width: 0;
}
.title {
  color: var(--c-text-strong);
  font-weight: 500;
}
.sub {
  color: var(--c-text-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub.mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.cta {
  flex-shrink: 0;
}
.chev {
  color: var(--c-text-faint);
  transition: transform 0.12s;
}
.open .chev {
  transform: rotate(90deg);
}
.dismissed .text {
  opacity: 0.6;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 14px 14px 33px;
}
.body p {
  word-break: break-word;
}
.metrics {
  font-size: 12px;
}
.label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--c-text-muted);
}
.label .destructive {
  color: var(--c-critical);
}
.links {
  gap: 16px;
  margin-top: 2px;
}
</style>
