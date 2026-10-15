<script setup lang="ts">
import { computed } from "vue";
import { CATEGORIES, type CategoryId } from "@/core/types";
import { formatMetric } from "@/core/format";
import { categoryFindings, counts, dismissedCount, findings, setView, state } from "../store";
import FindingCard from "./FindingCard.vue";
import Icon, { type IconName } from "./Icon.vue";
import NoticeCard from "./NoticeCard.vue";

const top = computed(() => findings.value.filter((f) => f.severity !== "info").slice(0, 8));

const checkStats = computed(() => {
  const results = state.report?.results ?? [];
  return {
    passed: results.filter((r) => r.status === "passed").length,
    issues: results.filter((r) => r.status === "issues").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "error").length,
  };
});

function categoryCounts(id: CategoryId) {
  const list = categoryFindings(id);
  return {
    critical: list.filter((f) => f.severity === "critical").length,
    warning: list.filter((f) => f.severity === "warning").length,
    info: list.filter((f) => f.severity === "info").length,
  };
}
</script>

<template>
  <div class="overview">
    <div v-if="state.env?.notices.length" class="notices">
      <NoticeCard v-for="n in state.env.notices" :key="n.id" :notice="n" />
    </div>

    <dl class="facts" v-if="state.env">
      <div v-for="f in state.env.facts" :key="f.label">
        <dt>{{ f.label }}</dt>
        <dd>{{ formatMetric(f.value, f.format) }}</dd>
      </div>
    </dl>

    <div v-if="!state.report" class="empty card">
      <div class="row" style="justify-content: center">
        <span class="spinner" /> Running checks…
      </div>
    </div>

    <template v-else>
      <div class="tiles">
        <div class="tile sev-critical">
          <div class="num">{{ counts.critical }}</div>
          <div class="label"><Icon name="critical" :size="14" /> Critical</div>
        </div>
        <div class="tile sev-warning">
          <div class="num">{{ counts.warning }}</div>
          <div class="label"><Icon name="warning" :size="14" /> Warnings</div>
        </div>
        <div class="tile sev-info">
          <div class="num">{{ counts.info }}</div>
          <div class="label"><Icon name="info" :size="14" /> Suggestions</div>
        </div>
        <div class="tile checks">
          <div class="num">{{ checkStats.passed }}<span class="faint">/{{ state.report.results.length }}</span></div>
          <div class="label">
            Checks passed
            <span v-if="checkStats.skipped" class="faint">· {{ checkStats.skipped }} skipped</span>
            <span v-if="checkStats.failed" class="faint">· {{ checkStats.failed }} failed</span>
          </div>
        </div>
      </div>

      <div class="categories">
        <button
          v-for="c in CATEGORIES"
          :key="c.id"
          class="category card"
          @click="setView(c.id)"
        >
          <div class="row">
            <Icon :name="c.id as IconName" :size="16" class="cat-icon" />
            <span class="cat-title">{{ c.title }}</span>
            <span class="spacer" />
            <Icon name="chevron" :size="16" class="faint" />
          </div>
          <p class="muted">{{ c.description }}</p>
          <div class="row pills">
            <span v-if="categoryCounts(c.id).critical" class="pill sev-critical">{{ categoryCounts(c.id).critical }} critical</span>
            <span v-if="categoryCounts(c.id).warning" class="pill sev-warning">{{ categoryCounts(c.id).warning }} warning</span>
            <span v-if="categoryCounts(c.id).info" class="pill sev-info">{{ categoryCounts(c.id).info }} info</span>
            <span v-if="!categoryFindings(c.id).length" class="pill sev-success"><Icon name="check" :size="12" /> Looks good</span>
          </div>
        </button>
      </div>

      <section class="top">
        <div class="row">
          <h2>Most important</h2>
          <span class="spacer" />
          <span v-if="dismissedCount" class="faint">{{ dismissedCount }} dismissed</span>
        </div>
        <div v-if="top.length" class="list">
          <FindingCard v-for="f in top" :key="f.key" :finding="f" />
        </div>
        <div v-else class="empty card">
          <Icon name="check" :size="28" class="ok-icon" />
          <p>No critical problems or warnings.{{ counts.info ? " Check the categories above for smaller improvements." : "" }}</p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.notices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 24px;
  margin: 0;
}
.facts dt {
  font-size: 11px;
  color: var(--c-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.facts dd {
  margin: 0;
  color: var(--c-text-strong);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.tile {
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--c-border);
  background: var(--c-panel);
}
.tile .num {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--sev, var(--c-text-strong));
  font-variant-numeric: tabular-nums;
}
.tile .label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--c-text-muted);
}
.tile.checks .num {
  color: var(--c-text-strong);
}
.categories {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
}
.category {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.category:hover {
  background: color-mix(in srgb, var(--c-base) 4%, var(--c-panel));
}
.category p {
  margin: 0;
  font-size: 12px;
}
.cat-icon {
  color: var(--c-primary);
}
.cat-title {
  font-weight: 600;
  color: var(--c-text-strong);
}
.pills {
  flex-wrap: wrap;
  gap: 4px;
}
.top {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.top h2 {
  font-size: 15px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ok-icon {
  color: var(--c-success);
}
.empty p {
  margin: 8px 0 0;
}
</style>
