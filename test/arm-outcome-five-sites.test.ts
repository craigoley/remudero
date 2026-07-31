import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  armAndLogOutcome,
  armIfVerdictPermits,
  armReportPhrase,
  armAutoMerge,
  type ArmDeps,
  type ArmOutcome,
} from "../src/run-task.js";
import { isInPlanScope, ORIENTATION_DOC } from "../src/lib/plan-architect.js";

// ── THE DEFECT ────────────────────────────────────────────────────────────────────────
// `armAutoMerge` RETURNS which of its seven branches it took; it never throws. Five of the
// seven armed NOTHING. PR #968 taught the SWEEP to read that value. Five Architect lanes —
// dep-review, retro, triage, plan, approve — each still did `armAutoMerge(...)` followed by
// an unconditional `log("automerge.armed", {})`, so the ledger recorded an arm for PRs that
// had been explicitly refused, and the console printed "gated + armed" on a refusal.
//
// The worst instance was not intermittent, it was total: `retroCommand` armed with the
// hardcoded literal "RETRO" while `reviewCommand` keyed its verdict to the full run id off
// the PR trailer. Counted over the live ledger unioned with all 660 rotations, `review.posted`
// rows keyed exactly "RETRO" = 0 and rows keyed RETRO* = 7795 — the literal never matched a
// verdict once, so every retro PR in this repo's history was refused and then logged as armed.

const SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

/** The window of source around a lane's own console line — where that lane's arm site lives. */
function laneWindow(anchor: string, before = 14): string {
  const at = SRC.indexOf(anchor);
  assert.ok(at > 0, `anchor not found, the test is stale: ${anchor}`);
  const head = SRC.slice(0, at).split("\n");
  return head.slice(Math.max(0, head.length - before)).join("\n") + "\n" + anchor;
}

/** Records every ledger step a site emitted, so a test asserts the CALL, not that code ran. */
function recorder() {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { steps, log: (step: string, extra?: Record<string, unknown>) => void steps.push({ step, extra }) };
}

const NON_ARMING: ArmOutcome[] = [
  "no-task-id",
  "head-unavailable",
  "ledger-refused",
  "direct-merge-failed",
  "arm-error-ignored",
];

// ── 1: a non-arming outcome ledgers the skip, never the arm ─────────────────────────
test("armAndLogOutcome ledgers automerge.arm_skipped with the outcome when the arm refused", () => {
  for (const outcome of NON_ARMING) {
    const r = recorder();

    const got = armAndLogOutcome("https://github.com/craigoley/remudero/pull/974", "RETRO-1785456064479", r.log, () => outcome);

    assert.equal(got, outcome, `${outcome}: the caller is handed the real outcome, not a boolean`);
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["automerge.arm_skipped"],
      `${outcome}: exactly one line, and it is the SKIP — logging automerge.armed here is what made that step meaningless`,
    );
    assert.equal(r.steps[0].extra?.outcome, outcome, `${outcome}: the reason travels on the line, not only to stdout`);
    assert.equal(r.steps[0].extra?.task_id, "RETRO-1785456064479", `${outcome}: attributable to the task it was refused for`);
  }
});

// ── 2: REGRESSION LOCK — an arming outcome still logs the arm ───────────────────────
test("armAndLogOutcome ledgers automerge.armed only when the outcome actually armed", () => {
  for (const outcome of ["armed", "direct-merged"] as ArmOutcome[]) {
    const r = recorder();

    const got = armAndLogOutcome("https://github.com/craigoley/remudero/pull/974", "W1-T195", r.log, () => outcome);

    assert.equal(got, outcome);
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["automerge.armed"],
      `${outcome}: this did NOT turn every lane into a reporter of failure — a real arm still reads as one`,
    );
    assert.equal(r.steps[0].extra?.outcome, outcome);
  }
});

// ── 3: no site anywhere still logs the unconditional bare line ──────────────────────
test("no lane logs a bare unconditional automerge.armed anywhere across run-task", () => {
  const bare = SRC.split('log("automerge.armed", {});').length - 1;

  assert.equal(bare, 0, "every one of the five sites used this exact pair; none may remain");
});

// ── 4-8: PER SITE — each lane reads the outcome ─────────────────────────────────────
test("SITE dep-review reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`remudero-review=success posted + auto-merge ${armReportPhrase(armOutcome)}: ${view.url}`");

  assert.match(w, /armAndLogOutcome\(view\.url, taskId, log\)/, "the dep-review lane arms through the reporting wrapper");
  assert.doesNotMatch(w, /armAutoMerge\(view\.url/, "and no longer calls armAutoMerge with its outcome dropped");
});

test("SITE retro reads the arm outcome and passes runId, never the literal RETRO", () => {
  const w = laneWindow("`retro PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`", 20);

  assert.match(w, /armAndLogOutcome\(prUrl, runId, log\)/, "the id passed is runId — the one the trailer and the verdict agree on");
  assert.equal(SRC.includes('armAutoMerge(prUrl, "RETRO")'), false, "the hardcoded literal that never matched a verdict is gone");
  assert.equal(SRC.includes('ensureTaskTrailer(prUrl, "RETRO")'), false, "and the fallback trailer stamp uses the same id");
});

test("SITE triage reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`triage PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`");

  assert.match(w, /armAndLogOutcome\(prUrl, taskId, log\)/);
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

test("SITE plan reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`plan PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`");

  assert.match(w, /armAndLogOutcome\(prUrl, taskId, log\)/);
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

test("SITE approve reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`rmd approve: ${proposalId} gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${result.prUrl}`", 18);

  assert.match(w, /armAndLogOutcome\(result\.prUrl, `PR-\$\{prNum\}`, log\)/);
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

// ── 9: the SIXTH site the brief did not name — #968 was inert without it ────────────
test("SITE sweep adapter returns the arm outcome so the sweep can read it at all", () => {
  assert.match(
    SRC,
    /arm: \(pr\) => armAutoMerge\(pr\.prUrl, pr\.taskId\),/,
    "the adapter RETURNS the outcome — as a braced body it resolved to undefined, which armOutcomeArmed treats as armed, so the sweep's own check could never fire",
  );
  assert.equal(
    SRC.includes("arm: (pr) => {\n      armAutoMerge(pr.prUrl, pr.taskId);\n    },"),
    false,
    "the discarding form is gone",
  );
});

// ── 10: THE KEY — the same ledger, two ids, opposite outcomes ───────────────────────
test("THE KEY: the literal RETRO is refused where runId arms, against one identical ledger", () => {
  const HEAD = "5596ab04802a916c740858e75bc950774d38c504";
  const RUN_ID = "RETRO-1785456064479";
  // The shape PR #974 actually wrote: `reviewCommand` keyed the verdict to the full run id.
  const ledger = [{ step: "review.posted", task_id: RUN_ID, head_sha: HEAD, state: "success" }];
  const said: string[] = [];
  let armCalls = 0;
  const deps: ArmDeps = {
    headSha: () => HEAD,
    ledgerLines: () => ledger,
    armAuto: () => void armCalls++,
    mergeDirect: () => assert.fail("no direct merge should be reached by this fixture"),
    disableAuto: () => assert.fail("nothing is disarmed here"),
    say: (m) => void said.push(m),
  };

  const withLiteral = armAutoMerge("https://github.com/craigoley/remudero/pull/974", "RETRO", deps);
  const armsAfterLiteral = armCalls;
  const withRunId = armAutoMerge("https://github.com/craigoley/remudero/pull/974", RUN_ID, deps);

  assert.equal(withLiteral, "ledger-refused", "the literal finds no verdict — this is every retro PR ever opened");
  assert.equal(armsAfterLiteral, 0, "and nothing was armed on that path, whatever the ledger line claimed");
  assert.match(said[0], /no ledgered review.posted verdict found/, "the refusal names itself, to stdout only");
  assert.equal(withRunId, "armed", "the id the trailer actually carries finds the verdict and arms");
  assert.equal(armCalls, 1, "exactly one real arm was issued — the key repair proven against one unchanged ledger");
});

// ── 11: the console string ──────────────────────────────────────────────────────────
test("the console phrase on a refusal never claims the PR was armed", () => {
  for (const outcome of NON_ARMING) {
    const phrase = armReportPhrase(outcome);

    assert.equal(phrase, `NOT armed (${outcome})`, `${outcome}: says what happened, and names which branch`);
    assert.doesNotMatch(phrase, /^armed/, `${outcome}: cannot be read as an arm`);
  }
  assert.equal(armReportPhrase("armed"), "armed (armed)");
  assert.equal(armReportPhrase("direct-merged"), "armed (direct-merged)", "a clean-status direct merge IS a success");
});

// ── 12: the seventh site — #975's own post-verdict arm named its step unconditionally ─
test("armIfVerdictPermits names its ledger step from the outcome rather than always the arm", () => {
  const ctx = {
    prUrl: "https://github.com/craigoley/remudero/pull/974",
    taskId: "PR-974",
    headSha: "5596ab0",
    ledgerPath: "/dev/null",
    log: recorder().log,
  };
  const refusedSteps = recorder();
  const armedSteps = recorder();

  armIfVerdictPermits({ state: "success", capped: false, planOnly: false }, { ...ctx, log: refusedSteps.log }, {
    arm: () => "ledger-refused",
    ledgerLines: () => [],
  });
  armIfVerdictPermits({ state: "success", capped: false, planOnly: false }, { ...ctx, log: armedSteps.log }, {
    arm: () => "armed",
    ledgerLines: () => [],
  });

  assert.deepEqual(
    refusedSteps.steps.map((s) => s.step),
    ["automerge.arm_skipped"],
    "a head-drift or missing-verdict refusal here used to still read as automerge.armed",
  );
  assert.deepEqual(armedSteps.steps.map((s) => s.step), ["automerge.armed"], "a real arm is unchanged");
});

// ── 13: the plan-scope half, proven to be exactly one named path ────────────────────
test("plan scope admits the regenerated ORIENTATION doc as one named path, never a docs prefix", () => {
  assert.equal(ORIENTATION_DOC, "docs/ORIENTATION.md");

  assert.equal(isInPlanScope(ORIENTATION_DOC), true, "the file rmd retro regenerates on every run is plan scope");
  assert.equal(isInPlanScope("MASTER-PLAN.md"), true, "unchanged");
  assert.equal(isInPlanScope("plan/tasks.yaml"), true, "unchanged");
  // NO PREFIX WIDENING. A `docs/` prefix would hand the W1-T205 arm-without-proof carve-out to
  // every documentation change; only this one regenerated projection is admitted.
  assert.equal(isInPlanScope("docs/README.md"), false, "a sibling doc stays out of scope");
  assert.equal(isInPlanScope("docs/orientation.md"), false, "the match is exact, not case-folded");
  assert.equal(isInPlanScope("docs/ORIENTATION.md.bak"), false, "and not a prefix of the named path");
  assert.equal(isInPlanScope("src/run-task.ts"), false, "code is still never plan scope");
});
