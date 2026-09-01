import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateWeeklyBurnByModelClass,
  buildGather,
  gatherRuns,
  modelClassWeeklyBurnTable,
  parseLedger,
  renderGather,
} from "../src/lib/retro.js";
import { validateMounts, type Mounts } from "../src/lib/mounts.js";

/**
 * P34 clause (d), W1-T250: "per-class weekly-limit burn is accounted as a
 * SHARE of the weekly subscription window — the mounts.yaml class rows read
 * by the retro accounting, the single cross-file invariant." This file proves
 * exactly that ONE invariant: `.remudero/mounts.yaml`'s (task_type × risk ×
 * class) routing rows are the SOLE source retro.ts's weekly-burn accounting
 * consults to decide which model tier a run's burn lands on, and that burn is
 * expressed as a SHARE of the week's total (never imputed dollars).
 */

// A minimal, valid routing table (same shape test/mounts.test.ts's goodRaw()
// uses): `implement` at `low` risk routes `docs` -> haiku (cheap) and `src` ->
// sonnet (capable) — exactly the "cheap for plan-only/docs work, capable for
// implementation" objective this clause ratifies. Deliberately carries NO
// route for `weird_type` — an unrouted task_type is a config gap this task's
// design note requires the accounting to SURFACE, never crash on.
function fixtureMounts(): Mounts {
  return validateMounts({
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 400, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 400, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 400, context_budget: 180000 },
      triage: { model: "opus", effort: "low", max_turns: 400, context_budget: 180000 },
      inbox_draft: { model: "opus", effort: "high", max_turns: 400, context_budget: 180000 },
    },
    routes: {
      implement: {
        low: {
          src: { model: "sonnet", effort: "medium", max_turns: 400, context_budget: 120000 },
          docs: { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000 },
        },
      },
    },
  });
}

// The current UTC ISO week is Monday 2026-01-05T00:00:00.000Z through the
// following Monday (2026-01-12T00:00:00.000Z) — `now` sits inside it (Tuesday).
const NOW = Date.parse("2026-01-06T10:00:00.000Z");

// Run A (docs, low risk, IN this week): resolves to haiku per fixtureMounts's
// routes.implement.low.docs row — 4 turns.
// Run B (src, low risk, IN this week): resolves to sonnet — 20 turns.
// Run C (docs, low risk, OUT of this week — the PRIOR week): must be EXCLUDED
// from every total below, proving the week boundary is honored, not just the
// class/model join.
// Run D (weird_type, IN this week, no route in fixtureMounts at all): must
// bucket as "unresolved" rather than throwing — a config gap this read-only
// report surfaces, never crashes on (design note, W1-T250).
const LEDGER = [
  `{"ts":"2026-01-05T01:00:00.000Z","run_id":"A","task_id":"TA","step":"run.start","type":"implement","risk":"low","task_class":"docs"}`,
  `{"ts":"2026-01-05T01:01:00.000Z","run_id":"A","task_id":"TA","step":"implement.done","num_turns":4,"cost_usd":0.1}`,
  `{"ts":"2026-01-05T01:02:00.000Z","run_id":"A","task_id":"TA","step":"verdict","verdict":"merged","cost_usd":0.1}`,
  `{"ts":"2026-01-06T02:00:00.000Z","run_id":"B","task_id":"TB","step":"run.start","type":"implement","risk":"low","task_class":"src"}`,
  `{"ts":"2026-01-06T02:01:00.000Z","run_id":"B","task_id":"TB","step":"implement.done","num_turns":20,"cost_usd":3.0}`,
  `{"ts":"2026-01-06T02:02:00.000Z","run_id":"B","task_id":"TB","step":"verdict","verdict":"merged","cost_usd":3.0}`,
  `{"ts":"2025-12-30T00:00:00.000Z","run_id":"C","task_id":"TC","step":"run.start","type":"implement","risk":"low","task_class":"docs"}`,
  `{"ts":"2025-12-30T00:01:00.000Z","run_id":"C","task_id":"TC","step":"implement.done","num_turns":999,"cost_usd":999}`,
  `{"ts":"2025-12-30T00:02:00.000Z","run_id":"C","task_id":"TC","step":"verdict","verdict":"merged","cost_usd":999}`,
  `{"ts":"2026-01-07T03:00:00.000Z","run_id":"D","task_id":"TD","step":"run.start","type":"weird_type","risk":"low","task_class":"src"}`,
  `{"ts":"2026-01-07T03:01:00.000Z","run_id":"D","task_id":"TD","step":"implement.done","num_turns":5,"cost_usd":1.0}`,
  `{"ts":"2026-01-07T03:02:00.000Z","run_id":"D","task_id":"TD","step":"verdict","verdict":"merged","cost_usd":1.0}`,
].join("\n");

test("aggregateWeeklyBurnByModelClass: mounts.yaml's per-class rows are the SOLE source of which model a run's burn lands on", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const byModel = aggregateWeeklyBurnByModelClass(runs, fixtureMounts(), NOW);

  const haiku = byModel.find((m) => m.model === "haiku")!;
  const sonnet = byModel.find((m) => m.model === "sonnet")!;
  const unresolved = byModel.find((m) => m.model === "unresolved")!;

  // Run C (out-of-week) contributes to NEITHER haiku's turns nor the total —
  // the week boundary, not just the class/model join, is honored.
  assert.equal(haiku.runs, 1);
  assert.equal(haiku.turnsThisWeek, 4);
  assert.equal(sonnet.runs, 1);
  assert.equal(sonnet.turnsThisWeek, 20);
  // An unrouted task_type surfaces as "unresolved", never a thrown exception —
  // this whole test would otherwise never reach an assertion.
  assert.equal(unresolved.runs, 1);
  assert.equal(unresolved.turnsThisWeek, 5);

  // SHARE of the weekly subscription window: this week's total burn (turns,
  // never dollars) is 4 + 20 + 5 = 29 across every resolved model.
  assert.equal(haiku.shareOfWeeklyBurn, 0.138); // 4/29, rounded to 3 decimals
  assert.equal(sonnet.shareOfWeeklyBurn, 0.69); // 20/29
  assert.equal(unresolved.shareOfWeeklyBurn, 0.172); // 5/29
  const totalShare = Math.round((haiku.shareOfWeeklyBurn + sonnet.shareOfWeeklyBurn + unresolved.shareOfWeeklyBurn) * 1000) / 1000;
  assert.equal(totalShare, 1); // shares partition the week's total burn exactly
});

test("aggregateWeeklyBurnByModelClass: costUsd rides along for context only, never drives the share (clause c — never imputed dollars)", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const byModel = aggregateWeeklyBurnByModelClass(runs, fixtureMounts(), NOW);
  const haiku = byModel.find((m) => m.model === "haiku")!;
  const sonnet = byModel.find((m) => m.model === "sonnet")!;
  // sonnet burns 30x haiku's DOLLARS ($3.0 vs $0.1) but the TURNS-derived share
  // (0.69 vs 0.138, a ~5x ratio matching 20 vs 4 turns) is what the routing
  // objective measures — dollars never enter the share computation.
  assert.equal(haiku.costUsdThisWeek, 0.1);
  assert.equal(sonnet.costUsdThisWeek, 3.0);
});

test("aggregateWeeklyBurnByModelClass: changing mounts.yaml's routing row changes which model a class's burn is attributed to (the cross-file invariant)", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const flipped = validateMounts({
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 400, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 400, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 400, context_budget: 180000 },
      triage: { model: "opus", effort: "low", max_turns: 400, context_budget: 180000 },
      inbox_draft: { model: "opus", effort: "high", max_turns: 400, context_budget: 180000 },
    },
    routes: {
      implement: {
        // docs now rides sonnet too — a routing-table edit ALONE (no code
        // change) must move run A's burn out of haiku and into sonnet.
        low: {
          src: { model: "sonnet", effort: "medium", max_turns: 400, context_budget: 120000 },
          docs: { model: "sonnet", effort: "low", max_turns: 400, context_budget: 60000 },
        },
      },
    },
  });
  const byModel = aggregateWeeklyBurnByModelClass(runs, flipped, NOW);
  assert.equal(byModel.find((m) => m.model === "haiku"), undefined);
  const sonnet = byModel.find((m) => m.model === "sonnet")!;
  assert.equal(sonnet.turnsThisWeek, 4 + 20); // run A (docs) joins run B (src) under sonnet
});

test("aggregateWeeklyBurnByModelClass: an empty week reports 0 share, not a divide-by-zero", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const distantNow = Date.parse("2030-06-01T00:00:00.000Z"); // no run in scope
  const byModel = aggregateWeeklyBurnByModelClass(runs, fixtureMounts(), distantNow);
  assert.deepEqual(byModel, []);
});

test("modelClassWeeklyBurnTable renders a markdown row per model, with the share as a percentage", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const table = modelClassWeeklyBurnTable(aggregateWeeklyBurnByModelClass(runs, fixtureMounts(), NOW));
  assert.match(table, /model \| runs \| turns this week \| share of weekly burn/);
  assert.match(table, /\| haiku \| 1 \| 4 \| 13\.8%/);
  assert.match(table, /\| sonnet \| 1 \| 20 \| 69\.0%/);
});

test("buildGather + renderGather: wired live — omitted without a mounts table, present (and reflecting mounts.yaml) when given one", () => {
  const withoutMounts = buildGather({ ledgerNdjson: LEDGER, learningsMd: "# L\n" });
  assert.equal(withoutMounts.weeklyBurnByModelClass, undefined);
  assert.doesNotMatch(renderGather(withoutMounts), /Weekly burn BY MODEL CLASS/);

  const withMounts = buildGather({ ledgerNdjson: LEDGER, learningsMd: "# L\n", mounts: fixtureMounts(), now: NOW });
  assert.ok(withMounts.weeklyBurnByModelClass);
  const haiku = withMounts.weeklyBurnByModelClass!.find((m) => m.model === "haiku")!;
  assert.equal(haiku.turnsThisWeek, 4);
  const rendered = renderGather(withMounts);
  assert.match(rendered, /Weekly burn BY MODEL CLASS \(P34 clause \(d\), W1-T250\)/);
  assert.match(rendered, /\| haiku \| 1 \| 4 \| 13\.8%/);
});
