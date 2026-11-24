// @census-reads: src/ — every log site of each NON_CALL_MODEL_STEPS step (criterion 7).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAnalyticsTimeSeries } from "#src/lib/analytics-timeseries.js";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { ReplayIdleSignal } from "#src/lib/golden-corpus.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { loadDefaultPolicy } from "#src/lib/policy.js";
import { SKILL_EVAL_MAX_SPEND_USD, SKILL_EVAL_STANDING_APPROVAL } from "#src/lib/skill-eval.js";
import { autoEvaluateSkillDrafts, SKILL_EVAL_AUTO_STEPS, type SkillEvalSpendFit } from "#src/lib/skill-eval-auto.js";
import { readSkillEvalSpendFit, skillEvalProductionInput } from "#src/lib/skill-eval-command.js";
import { isCashSpendProducer, isProducedSpendRow, NON_CALL_MODEL_STEPS, SPEND_STEP_ROLES, spendAmountUsd, spendRoleOf } from "#src/lib/spend-rows.js";
import { checkCostGovernor, DEFAULT_SWEEP_POLICY, deriveDayCostUsd, deriveDayUnpricedRows, deriveDayUnpricedSpendBound,
  deriveWindowCostUsd, utcDayWindowMs } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14631: a skill-draft eval waits on unpriced spend only for a real model call.

const NOW = "2026-11-24T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TS = "2026-11-24T06:00:00.000Z";
const YESTERDAY = "2026-11-23T06:00:00.000Z";
const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));

const STEPS = ["memory_budget.backtest", "review.follow_up_finding", "model.successor.read", "serve.feedback_expander_resolved",
  "queue_judge.prompt_bound", "pr.head_provider", "review.provider_provenance", "prompt_evolution.shadow", "retro.preflight_started",
  "retro.preflight_passed", "retro.preflight_failed", "retro.preflight_repair_stood_down", "judge.fallback"];
const nonCallRows = (): Record<string, unknown>[] =>
  STEPS.map((step, i) => ({ ts: TS, run_id: `NC-${i}`, step, model: "model-named-only" }));

// ── criterion 1 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T14631 criterion 1: a row of a step that calls no model is never produced spend; call rows stay produced", () => {
  assert.deepEqual([...NON_CALL_MODEL_STEPS].sort(), [...STEPS].sort());
  for (const row of nonCallRows()) {
    assert.equal(spendRoleOf(row), undefined, `${String(row.step)} with a model reads no role`);
    assert.equal(spendRoleOf({ ...row, spend_role: "produced" }), "produced", `${String(row.step)} labelled produced stays produced`);
  }
  const reviewer = { ts: TS, run_id: "PRE-1", step: "review.reviewer", model: "opus", total_cost_usd: 2.5 };
  const riskJudge = { ts: TS, run_id: "RJ-1", step: "risk_judge.decision", model: "judge-model" };
  const synthesized = { ts: TS, run_id: "IN-1", step: "inbox.draft_synthesized", model: "cash-model" };
  const draftError = { ts: TS, run_id: "IN-2", step: "inbox.draft_error", model: "cash-model" };
  for (const row of [reviewer, riskJudge, synthesized, draftError]) assert.equal(spendRoleOf(row), "produced", String(row.step));
  assert.equal(isProducedSpendRow(reviewer), true);
  assert.equal(deriveDayUnpricedRows([...nonCallRows(), reviewer, riskJudge, synthesized, draftError], NOW_MS), 3,
    "only the three unpriced call rows count");
});

// ── criterion 2 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T14631 criterion 2: each unpriced call is charged at its step's p90 of today's priced calls, else the day's largest", () => {
  const priced = Array.from({ length: 10 }, (_, i) => ({ ts: TS, run_id: `A-${i}`, step: "risk_judge.decision", model: "m", cost_usd: i + 1 }));
  const rows = [
    ...priced,
    { ts: TS, run_id: "A-u1", step: "risk_judge.decision", model: "m" },
    { ts: TS, run_id: "A-u2", step: "risk_judge.decision", model: "m", cost_usd: -1 },
    { ts: TS, run_id: "B-u1", step: "inbox.draft_error", model: "m" },
    // A restated cost is not a priced call, and other days are outside the window.
    { ts: TS, run_id: "V-1", step: "verdict", model: "m", cost_usd: 1000, spend_role: "restated" },
    { ts: YESTERDAY, run_id: "Y-1", step: "risk_judge.decision", model: "m", cost_usd: 500 },
    { ts: YESTERDAY, run_id: "Y-2", step: "inbox.draft_error", model: "m" },
    ...nonCallRows(),
  ];
  const bound = deriveDayUnpricedSpendBound(rows, NOW_MS);
  assert.ok("boundUsd" in bound);
  assert.equal(bound.rows, 3);
  assert.equal(bound.rows, deriveDayUnpricedRows(rows, NOW_MS), "the bound counts the same rows as deriveDayUnpricedRows");
  assert.deepEqual(bound.steps, [
    { step: "inbox.draft_error", rows: 1, perCallUsd: 10, source: "day-max" },
    { step: "risk_judge.decision", rows: 2, perCallUsd: 9, source: "step-p90" },
  ]);
  assert.equal(bound.boundUsd, 2 * 9 + 10);
  const one = deriveDayUnpricedSpendBound([priced[4]!, { ts: TS, run_id: "U", step: "risk_judge.decision", model: "m" }], NOW_MS);
  assert.ok("boundUsd" in one);
  assert.equal(one.boundUsd, 5, "one priced row is its own p90");

  const unbounded = deriveDayUnpricedSpendBound([{ ts: TS, run_id: "U", step: "inbox.draft_error", model: "m" },
    { ts: YESTERDAY, run_id: "Y", step: "inbox.draft_error", model: "m", cost_usd: 3 }], NOW_MS);
  assert.ok("unbounded" in unbounded);
  assert.equal(unbounded.rows, 1);
  assert.match(unbounded.unbounded, /no priced model call/);
  assert.deepEqual(deriveDayUnpricedSpendBound([...priced, ...nonCallRows()], NOW_MS), { rows: 0, boundUsd: 0, steps: [] });
});

// ── the auto pass over a real registry and ledger ─────────────────────────────────────────────────────────────

const DRAFT_ID = "skill-draft:proc-bound";
const MARKDOWN = "---\nname: types-first\ndescription: run the type checker first\napplies-to: implement\n---\n\n## Procedure\n\n"
  + "- Run the type checker before the tests.\n";
const HEADROOM = { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 40 }] };
const IDLE: ReplayIdleSignal = { liveness: { state: "up", quiet: true }, headroom: HEADROOM };
const BUSY: ReplayIdleSignal = { liveness: { state: "up" }, headroom: { ...HEADROOM, session: { percentUsed: 99 } } };

function pass(fit: SkillEvalSpendFit | undefined, idle: ReplayIdleSignal = IDLE) {
  const stateDir = join(tmp("skill-eval-bound-"), "state");
  mkdirSync(stateDir, { recursive: true });
  writeLedger([{ ts: TS, run_id: "R-0", task_id: "W1-T1", step: "run.start" }], { dir: stateDir });
  const registryPath = join(stateDir, "inbox-proposals.json");
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id: DRAFT_ID, summary: "a staged draft", evidenceAnchors: [],
    skillFile: { name: "types-first", markdown: MARKDOWN }, skillFileStagedAt: TS }] }));
  const rows: LedgerLine[] = [];
  const evaluated: string[] = [];
  const state = { idle, fit };
  const input = {
    registryPath: () => registryPath, stateDir: () => stateDir, readIdle: async () => state.idle,
    ...(fit === undefined ? {} : { readSpendFit: () => state.fit! }), log: (row: LedgerLine) => { rows.push(row); }, clock: fixedClock(NOW_MS),
  };
  const run = () => autoEvaluateSkillDrafts(input, async (proposalId, approval) => {
    evaluated.push(`${proposalId}:${approval.standingApproval.ref}`);
    return { code: 0, refusedBeforeDispatch: false };
  });
  const step = (name: string) => rows.filter((row) => row.step === name);
  return { run, rows, evaluated, state, step, proposal: () => loadProposalRegistry(registryPath).find((p) => p.id === DRAFT_ID) };
}

const BOUND_STEPS = [{ step: "inbox.draft_error", rows: 12, perCallUsd: 8.734, source: "day-max" as const }];

// ── criterion 3 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T14631 criterion 3: a day whose unpriced calls fit under the ceiling claims and runs the eval; one that does not waits", async () => {
  const fit: SkillEvalSpendFit = { dayCostUsd: 78.90, unpricedRows: 39, unpricedBoundUsd: 125.18, unpricedBound: BOUND_STEPS, ceilingUsd: 500 };
  const open = pass(fit);
  await open.run();
  assert.deepEqual(open.evaluated, [`${DRAFT_ID}:${SKILL_EVAL_STANDING_APPROVAL.ref}`], "the eval is dispatched once");
  assert.equal(open.proposal()!.skillEvalAuto?.state, "claimed");
  const claimed = open.step(SKILL_EVAL_AUTO_STEPS.claimed);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.unpriced_rows, 39);
  assert.equal(claimed[0]!.unpriced_bound_usd, 125.18);
  assert.deepEqual(claimed[0]!.unpriced_bound, BOUND_STEPS);
  assert.equal(open.step(SKILL_EVAL_AUTO_STEPS.waiting).length, 0);

  const over = pass({ ...fit, dayCostUsd: 500 - SKILL_EVAL_MAX_SPEND_USD - 125.18 + 0.01 });
  await over.run();
  assert.equal(over.evaluated.length, 0);
  const waiting = over.step(SKILL_EVAL_AUTO_STEPS.waiting);
  assert.equal(waiting.length, 1);
  assert.match(String(waiting[0]!.reason), /^daily-cost-unpriced: .*\$125\.18 for 39 unpriced call\(s\)/);
  assert.equal(waiting[0]!.day_cost_usd, 500 - SKILL_EVAL_MAX_SPEND_USD - 125.18 + 0.01);
  assert.equal(waiting[0]!.unpriced_rows, 39);
  assert.equal(waiting[0]!.unpriced_bound_usd, 125.18);
  assert.equal(waiting[0]!.daily_cost_ceiling_usd, 500);

  const noBound = pass({ dayCostUsd: 10, unpricedRows: 4, ceilingUsd: 500 });
  await noBound.run();
  assert.equal(noBound.evaluated.length, 0);
  const unbounded = noBound.step(SKILL_EVAL_AUTO_STEPS.waiting);
  assert.match(String(unbounded[0]!.reason), /^daily-cost-unpriced: 4 unpriced model call\(s\) today and no priced call/);
  assert.equal(unbounded[0]!.unpriced_rows, 4);
  assert.equal("unpriced_bound_usd" in unbounded[0]!, false, "no bound was measured");
  assert.equal(unbounded[0]!.day_cost_usd, 10);
  assert.equal(unbounded[0]!.daily_cost_ceiling_usd, 500);
});

function spendRoot(rows: Record<string, unknown>[]): Config {
  const root = tmp("skill-eval-bound-fit-");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeLedger(rows, { dir: stateDir });
  writeFileSync(join(stateDir, "DAILY_COST_CEILING_OVERRIDE"), JSON.stringify({ usd: 500, setAt: TS }));
  return { root } as Config;
}

test("W1-T14631 criterion 3: the production reading charges an unpriced call at today's price, so a day near the ceiling waits", async () => {
  // $310 known; the unpriced risk_judge.decision costs its step's $30, so $310 + $30 + $180 is above $500.
  const config = spendRoot([
    { ts: TS, run_id: "R-1", task_id: "W1-T1", step: "verdict", cost_usd: 250, outcome: "merged" },
    { ts: TS, run_id: "R-2", task_id: "J", step: "risk_judge.decision", model: "m", cost_usd: 30 },
    { ts: TS, run_id: "R-3", task_id: "J", step: "risk_judge.decision", model: "m", cost_usd: 30 },
    { ts: TS, run_id: "R-4", task_id: "J", step: "risk_judge.decision", model: "m" },
  ]);
  const fit = readSkillEvalSpendFit(config, { billing: "subscription", model: "m" }, fixedClock(NOW_MS), loadDefaultPolicy());
  assert.equal(fit.dayCostUsd, 310);
  assert.equal(fit.unpricedBoundUsd, 30);
  const near = pass(fit);
  await near.run();
  assert.equal(near.evaluated.length, 0);
  assert.match(String(near.step(SKILL_EVAL_AUTO_STEPS.waiting)[0]!.reason), /^daily-cost-unpriced: today's cost \$310\.00 plus \$30\.00/);
});

// ── criterion 4 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T14631 criterion 4: readSkillEvalSpendFit counts only the unpriced call and bounds it from the same rows", () => {
  const rows = [
    { ts: TS, run_id: "M-1", task_id: "MEMORY-BUDGET", step: "memory_budget.backtest", model: "independent-empirical-convolution-v1" },
    { ts: TS, run_id: "F-1", task_id: "W1-T2", step: "review.follow_up_finding", model: "opus" },
    { ts: TS, run_id: "J-1", task_id: "J", step: "risk_judge.decision", model: "judge" },
    { ts: TS, run_id: "J-2", task_id: "J", step: "risk_judge.decision", model: "judge", cost_usd: 0.5 },
    { ts: TS, run_id: "J-3", task_id: "J", step: "risk_judge.decision", model: "judge", cost_usd: 1.5 },
  ];
  const config = spendRoot(rows);
  const input = skillEvalProductionInput(REPO_ROOT, undefined, async () => undefined, { loadConfig: () => config, clock: fixedClock(NOW_MS) });
  const fit = input.readSpendFit!();
  assert.equal(fit.unpricedRows, 1);
  const bound = deriveDayUnpricedSpendBound(rows, NOW_MS);
  assert.ok("boundUsd" in bound);
  assert.equal(fit.unpricedBoundUsd, bound.boundUsd);
  assert.equal(fit.unpricedBoundUsd, 1.5);
  assert.deepEqual(fit.unpricedBound, bound.steps);
});

// ── criterion 5 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T14631 criterion 5: invariant:spend-dollars-unchanged every dollar figure is as on origin/main; only non-call rows leave the unpriced counts", () => {
  const rows: Record<string, unknown>[] = [
    ...nonCallRows(),
    ...Object.keys(SPEND_STEP_ROLES).map((step, i) => ({ ts: TS, run_id: `S-${i}`, step, model: "sonnet", cost_usd: (i + 1) * 0.25 })),
    { ts: TS, run_id: "PRE-1", step: "review.reviewer", model: "opus", total_cost_usd: 2.5 },
    { ts: TS, run_id: "CASH-1", step: "inbox.draft_synthesized", provider: "cash", model: "cash-model", cost_usd: 0.75 },
    { ts: TS, run_id: "CASH-2", step: "inbox.draft_synthesized", provider: "cash", model: "cash-model", token_usage_state: "unavailable", cost_usd: 0.5 },
    { ts: TS, run_id: "ERR-1", step: "inbox.draft_error", model: "cash-model" },
  ];
  // The literals below are the origin/main values of the same functions over this fixture.
  assert.equal(rows.length, 45);
  assert.deepEqual(rows.filter(isProducedSpendRow).map((r) => r.run_id),
    [...Array.from({ length: 24 }, (_, i) => `S-${i + 4}`), "PRE-1", "CASH-1"]);
  assert.deepEqual(rows.map((r) => spendAmountUsd(r) ?? null), [...Array(13).fill(null),
    ...Array.from({ length: 28 }, (_, i) => (i + 1) * 0.25), 2.5, 0.75, null, null]);
  assert.deepEqual(rows.filter((r) => spendAmountUsd(r) !== undefined && isCashSpendProducer(r)).map((r) => r.run_id), ["CASH-1"]);
  assert.equal(deriveDayCostUsd(rows, NOW_MS), 102.75);
  const [start, end] = utcDayWindowMs(NOW_MS);
  assert.equal(deriveWindowCostUsd(rows, start, end), 102.75);
  const point = buildAnalyticsTimeSeries(rows, NOW).find((s) => s.id === "cost.modeled.usd")!.points.find((p) => p.t === "2026-11-24T00:00:00.000Z")!;
  assert.equal(point.value, 102.25);
  // origin/main counted 15 unpriced rows: the 13 non-call rows, CASH-2 and ERR-1.
  assert.equal(deriveDayUnpricedRows(rows, NOW_MS), 15 - NON_CALL_MODEL_STEPS.size);
  assert.equal(point.unpricedRows, 15 - NON_CALL_MODEL_STEPS.size);
});

// ── criterion 6 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T14631 criterion 6: invariant:other-spend-gates-unchanged with no unpriced rows every other gate opens and waits as before", async () => {
  const at = pass({ dayCostUsd: 500 - SKILL_EVAL_MAX_SPEND_USD, unpricedRows: 0, ceilingUsd: 500 });
  await at.run();
  assert.equal(at.evaluated.length, 1, "at the ceiling exactly, the eval fits");
  assert.equal(at.step(SKILL_EVAL_AUTO_STEPS.claimed)[0]!.approval, SKILL_EVAL_STANDING_APPROVAL.ref, "the standing approval");
  assert.equal(at.step(SKILL_EVAL_AUTO_STEPS.claimed)[0]!.unpriced_bound_usd, undefined);
  const again = await at.run();
  assert.equal(at.evaluated.length, 1, "one eval per text");
  assert.match(again.reason, /no skill draft is waiting/);

  const waits = async (fit: SkillEvalSpendFit | undefined, pattern: RegExp, idle?: ReplayIdleSignal): Promise<void> => {
    const fx = pass(fit, idle);
    await fx.run();
    assert.equal(fx.evaluated.length, 0);
    assert.match(String(fx.step(SKILL_EVAL_AUTO_STEPS.waiting)[0]!.reason), pattern);
  };
  await waits({ dayCostUsd: 500 - SKILL_EVAL_MAX_SPEND_USD + 0.01, unpricedRows: 0, ceilingUsd: 500 }, /^daily-cost-ceiling/);
  await waits({ dayCostUsd: 10, unpricedRows: 0, ceilingUsd: 500, cash: { remainingUsd: SKILL_EVAL_MAX_SPEND_USD - 1 } }, /^cash-allowance:/);
  await waits({ dayCostUsd: 10, unpricedRows: 0, ceilingUsd: 500, cash: { unreadable: "no dailyCapUsd" } }, /^cash-allowance-unreadable/);
  await waits(undefined, /^spend-not-measured/);
  await waits({ dayCostUsd: 10, unpricedRows: 0, ceilingUsd: 500 }, /session \(5h\) is at 99%/, BUSY);
  // With a bound that fits, the ceiling and the cash checks still run after it.
  await waits({ dayCostUsd: 10, unpricedRows: 2, unpricedBoundUsd: 1, ceilingUsd: 500, cash: { remainingUsd: 1 } }, /^cash-allowance:/);

  const ceiling = DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd;
  for (const unpriced of [0, 1, 39]) {
    assert.equal(checkCostGovernor(ceiling - 0.01, DEFAULT_SWEEP_POLICY, unpriced).deferred, false);
    assert.equal(checkCostGovernor(ceiling, DEFAULT_SWEEP_POLICY, unpriced).deferred, true);
  }
});

// ── criterion 7 ───────────────────────────────────────────────────────────────────────────────────────────────

const COST_FIELD = /\b(cost_usd|total_cost_usd|notional_cost_usd|token_usage_state)\b|workerLedgerFields\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The text of the call that encloses `at`: from its unmatched `(` to the matching `)`. */
function enclosingCall(text: string, at: number): string {
  let start = at;
  for (let depth = 0; start > 0; start--) {
    if (text[start] === ")") depth++;
    else if (text[start] === "(" && depth-- === 0) break;
  }
  let end = start;
  for (let depth = 0; end < text.length; end++) {
    if (text[end] === "(") depth++;
    else if (text[end] === ")" && --depth === 0) break;
  }
  return text.slice(start, end + 1);
}

/** Every write site of `step` in src: `log…("step", …)` or `step: "step"`, directly or through a const that names it. */
function writeSites(files: ReadonlyArray<{ path: string; text: string }>, step: string): Array<{ path: string; call: string }> {
  const quoted = `"${step.replace(/\./g, "\\.")}"`;
  const names = [quoted];
  for (const { text } of files) {
    for (const m of text.matchAll(new RegExp(`\\bconst\\s+([A-Z][A-Z0-9_]*)\\s*=\\s*${quoted}`, "g"))) names.push(`\\b${m[1]}\\b`);
  }
  const sites: Array<{ path: string; call: string }> = [];
  for (const { path, text } of files) {
    for (const name of names) {
      for (const m of text.matchAll(new RegExp(`\\blog\\w*\\??\\.?\\(\\s*${name}\\s*,|\\bstep:\\s*${name}`, "g"))) {
        sites.push({ path, call: enclosingCall(text, m.index + m[0].length - 1) });
      }
    }
  }
  return sites;
}

test("W1-T14631 criterion 7: invariant:non-call-steps-are-checked no listed step writes a cost or token field or has a spend role", () => {
  const files = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));
  // Positive control: the same census sees the cost fields of a priced step.
  assert.ok(writeSites(files, "fix.done").some((site) => COST_FIELD.test(site.call)), "the census reads fix.done's cost");
  for (const step of NON_CALL_MODEL_STEPS) {
    assert.equal(Object.hasOwn(SPEND_STEP_ROLES, step), false, `${step} is also in SPEND_STEP_ROLES`);
    const sites = writeSites(files, step);
    assert.ok(sites.length > 0, `${step} is a literal ledger step in src`);
    for (const site of sites) assert.doesNotMatch(site.call, COST_FIELD, `${step} at ${site.path} writes a cost or token field`);
  }
});
