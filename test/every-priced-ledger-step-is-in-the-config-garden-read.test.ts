// @source-text-subject: this census's subject is the ledger writes in src/ — it reads each source file's text
// to find every step written with `pr_url` or `cost_usd`, the way the spend-role census finds cost rows.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_GARDEN_LEDGER_STEPS } from "../src/lib/config-gardener.js";

/**
 * W1-T5527 — EVERY PRICED LEDGER STEP IS IN THE CONFIG GARDEN'S READ.
 *
 * W1-T5474 (#8933) bounded the config gardener's 60-day ledger read to `CONFIG_GARDEN_LEDGER_STEPS`, a
 * hand-written list. With no verdict line, `gatherRuns` takes a run's FIRST `pr_url` row of any step, and
 * since W1-T5526 (#9008) prices the run from its DONE_STEPS worker rows. A new step that writes `pr_url`
 * or `cost_usd` under a worker's run_id and is not listed would be dropped by the filtered read, and the
 * gardener would credit or price that run differently from an unfiltered read with no test noticing.
 *
 * This census walks src/ for every ledger write whose payload names `pr_url` or `cost_usd` and requires
 * each step to be listed or to carry a reason below. THREE WRITE IDIOMS are read, because one alone misses
 * real steps: `log*("<step>", {…})`, `log*(STEP_CONST, {…})`, and any object literal holding
 * `step: "<step>"` or `step: STEP_CONST` (the `appendLedger(…, {…})` payloads and the pure line builders
 * such as `costAnomalyLine`). A constant resolves through its `const NAME = "<step>"` declaration in src/.
 *
 * MEASURED 2026-10-04 on the live 60-day union (290,466 rows of the scanned and listed steps, 2,825 runs
 * with a `run.start`): ZERO runs reach `gatherRuns`' pr_url fallback (no `pr.opened`, no `verdict`, some
 * `pr_url` row), and of the steps exempted below only the five W1-T5526 cost steps and
 * `fix.instrument_entangled` ever appeared inside a run that has a `run.start`.
 */

const DONE_STEPS_PRICE_THE_RUN =
  "cost_usd only, outside DONE_STEPS: not read by gatherRuns since W1-T5526, which prices an unverdicted run from its worker rows";
const A_LANE_RUN_ID =
  "written under a lane's own run_id (SWEEP-, DAEMON-, DRAIN-, GARDEN-, FIX-, review-PR, dep-review-PR, APPROVE-, INBOX-, " +
  "ALERT-FIX-, ONBOARDING-, worker-smoke-, a CI run): only runTask, retro and triage ledger run.start, and gatherRuns skips a run without one";
const BEFORE_RUN_START =
  "written on a path that returns before its run ledgers run.start (a refused dispatch, a skipped retro), so gatherRuns skips that run";
const AFTER_PR_OPENED =
  "inside a worker run it is written only after that run's pr.opened row (review, fix rung, arming, hand-off, shadow, " +
  "follow-ups with a PR), and gatherRuns reads pr.opened before any fallback row";
const ANOTHER_RUNS_PR =
  "its pr_url names an earlier, already-merged PR, never this run's own: reading it would credit the run with a merge it did not make";
const KNOWN_GAP =
  "KNOWN GAP: can be a worker run's first pr_url row before its pr.opened, like its listed siblings acceptance.repaired and " +
  "pr.head_provider; 0 rows in the live 60-day union on 2026-10-04, so the filtered read matches today. " +
  "Follow-up: list it in CONFIG_GARDEN_LEDGER_STEPS with a fallback row in the W1-T5474 corpus";

/** Each step the scan finds that the gardener deliberately does not read, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  // The five W1-T5526 removed from the read, and the three other cost-only rows.
  "cost.anomaly": DONE_STEPS_PRICE_THE_RUN,
  "containment.probe": DONE_STEPS_PRICE_THE_RUN,
  "isolation.probe": DONE_STEPS_PRICE_THE_RUN,
  "risk_judge.decision": DONE_STEPS_PRICE_THE_RUN,
  "budget.warning": DONE_STEPS_PRICE_THE_RUN,
  "fix.spawn_infra_blocked": DONE_STEPS_PRICE_THE_RUN,
  worker_smoke: DONE_STEPS_PRICE_THE_RUN,
  "sweep.plan_round.worker": DONE_STEPS_PRICE_THE_RUN,
  // The sweep.
  "sweep.absent_repush": A_LANE_RUN_ID,
  "sweep.action_failed": A_LANE_RUN_ID,
  "sweep.armed_stalled": A_LANE_RUN_ID,
  "sweep.check_requeued": A_LANE_RUN_ID,
  "sweep.ci_gate_reaggregated": A_LANE_RUN_ID,
  "sweep.codeql_blocker.dispatch": A_LANE_RUN_ID,
  "sweep.credit_backfill": A_LANE_RUN_ID,
  "sweep.disposed": A_LANE_RUN_ID,
  "sweep.escalation_closed": A_LANE_RUN_ID,
  "sweep.missing_task_trailer_repaired": A_LANE_RUN_ID,
  "sweep.post_fix_redriven": A_LANE_RUN_ID,
  "sweep.red_base_refresh.attempted": A_LANE_RUN_ID,
  "sweep.red_base_refresh.error": A_LANE_RUN_ID,
  "sweep.stale_red_redrive.attempted": A_LANE_RUN_ID,
  "sweep.stale_red_redrive.local_route": A_LANE_RUN_ID,
  "sweep.stale_red_redrive.released": A_LANE_RUN_ID,
  "sweep.update_branch.attempted": A_LANE_RUN_ID,
  "sweep.update_branch.error": A_LANE_RUN_ID,
  "automerge.hold_withdrawal": A_LANE_RUN_ID,
  "automerge.shadow_refused": A_LANE_RUN_ID,
  "refusal_amendment.drafted": A_LANE_RUN_ID,
  "plan_repair.dispatch": A_LANE_RUN_ID,
  // The daemon and drain.
  "daemon.block.awaiting_merge": A_LANE_RUN_ID,
  "daemon.block.independent_failure": A_LANE_RUN_ID,
  "daemon.block.parked": A_LANE_RUN_ID,
  "daemon.block.rearmed": A_LANE_RUN_ID,
  "daemon.blocked": A_LANE_RUN_ID,
  "feedback.landing_review.failed": A_LANE_RUN_ID,
  "drain.blocked": A_LANE_RUN_ID,
  "drain.continued": A_LANE_RUN_ID,
  // Gardeners.
  "feedback.landing_sweep": A_LANE_RUN_ID,
  "machine_judge.landed": A_LANE_RUN_ID,
  "machine_judge.waiting": A_LANE_RUN_ID,
  "selector-shadow.miss_filed": A_LANE_RUN_ID,
  "selector-shadow.structural_filed": A_LANE_RUN_ID,
  "plan.shard_repair_opened": A_LANE_RUN_ID,
  "plan.shard_repair_skipped": A_LANE_RUN_ID,
  "test.pass": A_LANE_RUN_ID,
  // Command lanes: review, dep-review, approve/inbox, alert-fix, onboarding, the CI mutation ratchet.
  "automerge.capped_override_granted": A_LANE_RUN_ID,
  "dep-review.arm_unreachable": A_LANE_RUN_ID,
  "dep-review.decided": A_LANE_RUN_ID,
  "dep-review.migrate.capture_failed": A_LANE_RUN_ID,
  "dep-review.migrate.closed": A_LANE_RUN_ID,
  "dep-review.migrate.completed": A_LANE_RUN_ID,
  "dep-review.migrate.feedback_captured": A_LANE_RUN_ID,
  "dep-review.migrate.ignore_commented": A_LANE_RUN_ID,
  "dep-review.migrate.incomplete": A_LANE_RUN_ID,
  "approve.join_body_refreshed": A_LANE_RUN_ID,
  "approve.join_body_stale": A_LANE_RUN_ID,
  "ratify.approved": A_LANE_RUN_ID,
  "alert-fix.acceptance_check_error": A_LANE_RUN_ID,
  "alert-fix.acceptance_defect": A_LANE_RUN_ID,
  "alert-fix.pr_opened": A_LANE_RUN_ID,
  "onboarding.go_live_requested": A_LANE_RUN_ID,
  "mutation.ratchet_verdict": A_LANE_RUN_ID,
  // Returns before run.start.
  "dispatch.refused_already_merged": BEFORE_RUN_START,
  "daemon.merge_credit_correction": BEFORE_RUN_START,
  "retro.skipped_open_pr": BEFORE_RUN_START,
  // After the run's own pr.opened.
  "automerge.rate_limit_refused": AFTER_PR_OPENED,
  "fix.instrument_entangled": AFTER_PR_OPENED,
  "fix.prerequisite_opened": AFTER_PR_OPENED,
  "followup_write_suppressed": AFTER_PR_OPENED,
  "review.cannot_evaluate_escalated": AFTER_PR_OPENED,
  "review.diff_local_fallback": AFTER_PR_OPENED,
  "review.diff_unreadable": AFTER_PR_OPENED,
  "review.finding": AFTER_PR_OPENED,
  "review.post_failed": AFTER_PR_OPENED,
  "review.posted_reappended": AFTER_PR_OPENED,
  "review.verdict_conflict": AFTER_PR_OPENED,
  "run.handoff_declined": AFTER_PR_OPENED,
  "shadow.verdict": AFTER_PR_OPENED,
  // Another run's PR.
  "dispatch.rerun_override": ANOTHER_RUNS_PR,
  "fix.remeasured": ANOTHER_RUNS_PR,
  // Known gaps, named for a follow-up rather than hidden.
  "acceptance.repair.unrepresentable": KNOWN_GAP,
  "changeset_claim.repaired": KNOWN_GAP,
  "retro.pr.recovered": KNOWN_GAP,
  "pr.body_normalize.error": KNOWN_GAP,
};

const PRICED = /\b(?:pr_url|cost_usd)\b/;
const STEP_NAME = "[A-Za-z0-9_.:-]+";
const CONST_NAME = "[A-Z][A-Z0-9_]*";

/** The text from `open` (an opening `(` or `{`) through its matching close, matched by depth. */
function balanced(text: string, open: number): string {
  const [up, down] = text[open] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === up) depth++;
    else if (text[i] === down && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** The innermost object literal enclosing `at`: walk back to its unmatched `{`, then forward to its `}`. */
function enclosingObject(text: string, at: number): string {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{" && depth-- === 0) return balanced(text, i);
  }
  return "";
}

/** Every step a source tree writes to the ledger with `pr_url` or `cost_usd` in the same payload, mapped
 *  to the files that write it. `sources` maps a path to its text. */
export function stepsWrittenWithAPrice(sources: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const constants = new Map<string, Set<string>>();
  for (const text of sources.values()) {
    for (const m of text.matchAll(new RegExp(`\\bconst (${CONST_NAME})\\s*(?::\\s*string\\s*)?=\\s*(["'])(${STEP_NAME})\\2`, "g"))) {
      constants.set(m[1], (constants.get(m[1]) ?? new Set()).add(m[3]));
    }
  }
  const found = new Map<string, Set<string>>();
  const add = (steps: Iterable<string>, file: string) => {
    for (const step of steps) found.set(step, (found.get(step) ?? new Set()).add(file));
  };
  const resolve = (literal: string | undefined, name: string | undefined): Iterable<string> =>
    literal !== undefined ? [literal] : (constants.get(name!) ?? []);
  for (const [file, text] of sources) {
    const logCall = new RegExp(`\\blog\\w*\\(\\s*(?:(["'])(${STEP_NAME})\\1|(${CONST_NAME}))\\s*,`, "g");
    for (const m of text.matchAll(logCall)) {
      if (PRICED.test(balanced(text, text.indexOf("(", m.index)))) add(resolve(m[2], m[3]), file);
    }
    const stepKey = new RegExp(`\\bstep:\\s*(?:(["'])(${STEP_NAME})\\1|(${CONST_NAME})\\b)`, "g");
    for (const m of text.matchAll(stepKey)) {
      if (PRICED.test(enclosingObject(text, m.index))) add(resolve(m[2], m[3]), file);
    }
  }
  return found;
}

function srcTree(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) srcTree(path, out);
    else if (path.endsWith(".ts")) out.set(path, readFileSync(path, "utf8"));
  }
  return out;
}

let scanned: Map<string, Set<string>> | undefined;
const srcPricedSteps = (): Map<string, Set<string>> => (scanned ??= stepsWrittenWithAPrice(srcTree("src")));

test("test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts: every ledger step written with pr_url or cost_usd is in CONFIG_GARDEN_LEDGER_STEPS or a reasoned exemption", () => {
  const found = srcPricedSteps();
  // Positive control: the known members, and one step per idiom, so a scanner that finds nothing fails.
  for (const known of ["pr.opened", "implement.done", "cost.anomaly", "verdict.merged", "refusal_amendment.drafted"]) {
    assert.ok(found.has(known), `the census reads ${known} out of src`);
  }
  const listed = new Set(CONFIG_GARDEN_LEDGER_STEPS);
  const unaccounted = [...found]
    .filter(([step]) => !listed.has(step) && !Object.hasOwn(EXEMPT, step))
    .map(([step, files]) => `${step} (${[...files].sort().join(", ")})`);
  assert.deepEqual(
    unaccounted,
    [],
    "a step written with pr_url or cost_usd is dropped by the config gardener's filtered read unless it is in " +
      "CONFIG_GARDEN_LEDGER_STEPS (src/lib/config-gardener.ts) or exempted with a reason in this census",
  );
});

test("every exemption names a step the census still finds and the gardener does not read", () => {
  const found = srcPricedSteps();
  const listed = new Set(CONFIG_GARDEN_LEDGER_STEPS);
  assert.deepEqual(Object.keys(EXEMPT).filter((step) => !found.has(step)), [], "a stale exemption: the scan no longer finds the step");
  assert.deepEqual(Object.keys(EXEMPT).filter((step) => listed.has(step)), [], "an exemption for a step the gardener reads");
  assert.ok(Object.values(EXEMPT).every((reason) => reason.length > 40), "every exemption gives its reason");
});

test("the census reads each write idiom and ignores an unpriced or total-only row", () => {
  const found = stepsWrittenWithAPrice(new Map([
    ["a.ts", [
      `log("a.literal_log", { pr_url: url, n: f(1, (2)) });`,
      `deps.log("a.unpriced", { reason: "x" });`,
      `log("a.total_only", { total_cost_usd: 3 });`,
      `appendLedger(p, { run_id: id, step: "a.appended", nested: { k: 1 }, cost_usd: 0 });`,
      `appendLedger(p, { run_id: id, step: "a.appended_unpriced" }); const row = { pr_url: url };`,
    ].join("\n")],
    ["b.ts", [
      `export const B_STEP = "b.constant_object";`,
      `const B_LOG_STEP: string = "b.constant_log";`,
      `export function line(f) { return { run_id: f.runId, step: B_STEP, ...(f.url ? { pr_url: f.url } : {}) }; }`,
      `log(B_LOG_STEP, { cost_usd: 0.1 });`,
    ].join("\n")],
  ]));
  assert.deepEqual([...found.keys()].sort(), ["a.appended", "a.literal_log", "b.constant_log", "b.constant_object"]);
  assert.deepEqual([...found.get("b.constant_object")!], ["b.ts"]);
});
