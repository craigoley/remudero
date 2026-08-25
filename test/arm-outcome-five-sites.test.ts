import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  armAndLogOutcome,
  armIfVerdictPermits,
  armReportPhrase,
  armAutoMerge,
  armAutoMergeDetailed,
  armFailureAction,
  sweepArmAttemptOutcome,
  type ArmDeps,
  type ArmOutcome,
} from "../src/run-task.js";
import { isInPlanScope, ORIENTATION_DOC } from "../src/lib/plan-architect.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

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

// W1-T1052: split by whether `attemptArm` was genuinely reached — an outcome returned before
// any attempt (never armed, never merged) versus one where the attempt was made and did not
// stick. `armOutcomeArmed`'s own doc comment (lib/sweep.ts) draws exactly this line.
const NEVER_ATTEMPTED: ArmOutcome[] = ["no-task-id", "head-unavailable", "ledger-refused"];
const ATTEMPTED_AND_FAILED: ArmOutcome[] = ["direct-merge-failed", "arm-error-ignored"];
const NON_ARMING: ArmOutcome[] = [...NEVER_ATTEMPTED, ...ATTEMPTED_AND_FAILED];

// ── 1a: an outcome that never reached an attempt ledgers the skip, never the arm ────
test("armAndLogOutcome ledgers automerge.arm_skipped for an outcome that never reached an attempt", () => {
  for (const outcome of NEVER_ATTEMPTED) {
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

// ── 1b: W1-T1052 — an outcome where the attempt was made and failed ledgers the NEW step ──
test("armAndLogOutcome ledgers automerge.arm_failed for an outcome where the attempt was made and did not stick (W1-T1052)", () => {
  for (const outcome of ATTEMPTED_AND_FAILED) {
    const r = recorder();

    const got = armAndLogOutcome("https://github.com/craigoley/remudero/pull/974", "RETRO-1785456064479", r.log, () => outcome);

    assert.equal(got, outcome, `${outcome}: the caller is handed the real outcome, not a boolean`);
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["automerge.arm_failed"],
      `${outcome}: an ATTEMPTED merge that failed must not be filed as automerge.arm_skipped`,
    );
    assert.equal(r.steps[0].extra?.outcome, outcome, `${outcome}: the reason travels on the line, not only to stdout`);
    assert.equal(r.steps[0].extra?.task_id, "RETRO-1785456064479", `${outcome}: attributable to the task it was refused for`);
  }
});

// ── W1-T1052 ACCEPTANCE — the record is renamed, not a new row added ────────────────
// Every proof below is named `arm step name: …` to match plan/tasks.d/W1-T1052's own acceptance
// criteria verbatim, so `remudero-review`'s `unit test:` dialect finds it by name.

test("arm step name: an attempted merge that failed is not recorded as skipped", () => {
  for (const outcome of ATTEMPTED_AND_FAILED) {
    const r = recorder();
    armAndLogOutcome("https://github.com/craigoley/remudero/pull/1052", "W1-T1052", r.log, () => outcome);
    assert.equal(
      r.steps.some((s) => s.step === "automerge.arm_skipped"),
      false,
      `${outcome}: an attempted-and-failed merge must never be filed under the step meaning it was skipped`,
    );
  }
});

test("arm step name: a genuine skip and a failed attempt no longer share one step", () => {
  const skipSteps = new Set<string>();
  for (const outcome of NEVER_ATTEMPTED) {
    const r = recorder();
    armAndLogOutcome("https://github.com/craigoley/remudero/pull/1052", "W1-T1052", r.log, () => outcome);
    r.steps.forEach((s) => skipSteps.add(s.step));
  }
  const failedSteps = new Set<string>();
  for (const outcome of ATTEMPTED_AND_FAILED) {
    const r = recorder();
    armAndLogOutcome("https://github.com/craigoley/remudero/pull/1052", "W1-T1052", r.log, () => outcome);
    r.steps.forEach((s) => failedSteps.add(s.step));
  }
  assert.deepEqual([...skipSteps], ["automerge.arm_skipped"], "sanity: every genuine skip files under one step");
  assert.deepEqual([...failedSteps], ["automerge.arm_failed"], "sanity: every failed attempt files under one step");
  for (const step of failedSteps) {
    assert.ok(!skipSteps.has(step), `"${step}" must not be shared between a genuine skip and a failed attempt`);
  }
});

test("arm step name: the outcome field and the step name agree on every outcome", () => {
  for (const outcome of NON_ARMING) {
    const r = recorder();
    armAndLogOutcome("https://github.com/craigoley/remudero/pull/1052", "W1-T1052", r.log, () => outcome);
    assert.equal(r.steps.length, 1, `${outcome}: exactly one ledger line`);
    assert.equal(r.steps[0].extra?.outcome, outcome, `${outcome}: the outcome field carries the real outcome`);
    const expectedStep = ATTEMPTED_AND_FAILED.includes(outcome) ? "automerge.arm_failed" : "automerge.arm_skipped";
    assert.equal(
      r.steps[0].step,
      expectedStep,
      `${outcome}: the step name must agree with what the outcome field says happened`,
    );
  }
  for (const outcome of ["armed", "direct-merged"] as ArmOutcome[]) {
    const r = recorder();
    armAndLogOutcome("https://github.com/craigoley/remudero/pull/1052", "W1-T1052", r.log, () => outcome);
    assert.equal(r.steps[0].step, "automerge.armed", `${outcome}: an arming outcome still agrees with automerge.armed`);
    assert.equal(r.steps[0].extra?.outcome, outcome);
  }
});

test("arm step name: no reader keyed on the old literal is left behind", () => {
  // NEGATIVE — neither the old nor the new arm-skip step name is ever READ (compared against)
  // by production code in run-task.ts: every occurrence left is a WRITE site or a comment.
  const readPattern = (step: string) =>
    new RegExp(`\\.step\\s*(?:===|!==)\\s*["']${step.replace(/\./g, "\\.")}["']|case\\s*["']${step.replace(/\./g, "\\.")}["']\\s*:`, "g");
  assert.deepEqual(
    SRC.match(readPattern("automerge.arm_skipped")) ?? [],
    [],
    "no production reader may decide anything off automerge.arm_skipped — it stayed write-only across the rename",
  );
  assert.deepEqual(
    SRC.match(readPattern("automerge.arm_failed")) ?? [],
    [],
    "the new automerge.arm_failed step must not have grown a reader either — it is write-only, like the step it split from",
  );

  // POSITIVE CONTROL — the same pattern DOES find a real read when one exists, proving the
  // negative checks above are not just matching nothing. automerge.armed is genuinely read by
  // lib/autonomy.ts and lib/receipt.ts (never in run-task.ts itself).
  const autonomySrc = readFileSync(new URL("../src/lib/autonomy.ts", import.meta.url), "utf8");
  const receiptSrc = readFileSync(new URL("../src/lib/receipt.ts", import.meta.url), "utf8");
  const armedReads = [...(autonomySrc.match(readPattern("automerge.armed")) ?? []), ...(receiptSrc.match(readPattern("automerge.armed")) ?? [])];
  assert.ok(armedReads.length > 0, "sanity: the read-pattern must actually catch a real consumer (automerge.armed)");
});

test("arm step name: the change adds no new ledger step", () => {
  // Each non-arming event still writes EXACTLY ONE ledger line — the rename never doubles a
  // line the way a genuinely NEW additional step (mirroring automerge.clean_status_direct_merge)
  // would have. Rotation groups by step name and caps retention per group
  // (MAX_RETAINED_LINES_PER_STEP), so one row per event, same as before the rename, is what
  // keeps rotation volume unchanged.
  for (const outcome of NON_ARMING) {
    const r = recorder();
    armAndLogOutcome("https://github.com/craigoley/remudero/pull/1052", "W1-T1052", r.log, () => outcome);
    assert.equal(r.steps.length, 1, `${outcome}: exactly one ledger line — the rename must not add a second row`);
  }
  // Neither the old nor the new step name is a member of DECISION_RELEVANT_LEDGER_STEPS — no
  // decision reads either back, so the rename creates no membership obligation on that set.
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("automerge.arm_skipped"), false);
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("automerge.arm_failed"), false);
});

// ── 2: REGRESSION LOCK — an arming outcome still logs the arm ───────────────────────
test("armAndLogOutcome ledgers automerge.armed only when the outcome actually armed", () => {
  for (const outcome of ["armed", "direct-merged"] as ArmOutcome[]) {
    const r = recorder();

    const got = armAndLogOutcome("https://github.com/craigoley/remudero/pull/974", "W1-T195", r.log, () => outcome);

    assert.equal(got, outcome);
    assert.deepEqual(
      // W1-T449: a `direct-merged` outcome is a COMPLETION, not an arm. `armOutcomeArmed` counts it
      // as armed (correctly — it succeeded), so it still writes `automerge.armed`, but it now ALSO
      // writes its own step. Folding a merge into "armed" is the conflation that step exists to end.
      r.steps.map((s) => s.step),
      outcome === "direct-merged" ? ["automerge.armed", "automerge.clean_status_direct_merge"] : ["automerge.armed"],
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

  // W1-T2258: this lane already held `view.headRefOid` (the SAME head its own review.posted
  // line just above was keyed to) — threaded onto the arm row as the 6th positional arg so
  // lib/verdict-calibration.ts's join stops being structurally review-lane-only.
  assert.match(
    w,
    /armAndLogOutcome\(view\.url, taskId, log, deps\.arm, "operator", view\.headRefOid\)/,
    "the dep-review lane arms through the reporting wrapper, carrying the head it already has",
  );
  assert.doesNotMatch(w, /armAutoMerge\(view\.url/, "and no longer calls armAutoMerge with its outcome dropped");
});

test("SITE retro reads the arm outcome and passes runId, never the literal RETRO", () => {
  const w = laneWindow("`retro PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`", 30);

  assert.match(
    w,
    /armAndLogOutcome\(prUrl, runId, log, undefined, undefined, armHeadSha\)/,
    "the id passed is runId — the one the trailer and the verdict agree on",
  );
  // W1-T2258: this lane holds no headSha variable of its own — a best-effort live REST read
  // (the SAME one reviewCommand just above already made) supplies the 6th positional arg.
  assert.match(w, /armHeadSha = readHeadShaRest\(prUrl\)/, "the head sha is recovered from the PR that already exists, not guessed");
  assert.equal(SRC.includes('armAutoMerge(prUrl, "RETRO")'), false, "the hardcoded literal that never matched a verdict is gone");
  assert.equal(SRC.includes('ensureTaskTrailer(prUrl, "RETRO")'), false, "and the fallback trailer stamp uses the same id");
});

test("SITE triage reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`triage PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`", 22);

  assert.match(w, /armAndLogOutcome\(prUrl, taskId, log, undefined, undefined, armHeadSha\)/);
  assert.match(w, /armHeadSha = readHeadShaRest\(prUrl\)/, "W1-T2258: the head sha is recovered, not guessed");
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

test("SITE plan reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`plan PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`", 22);

  assert.match(w, /armAndLogOutcome\(prUrl, taskId, log, undefined, undefined, armHeadSha\)/);
  assert.match(w, /armHeadSha = readHeadShaRest\(prUrl\)/, "W1-T2258: the head sha is recovered, not guessed");
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

test("SITE approve reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`rmd approve: ${proposalId} gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${result.prUrl}`", 26);

  assert.match(w, /armAndLogOutcome\(result\.prUrl, `PR-\$\{prNum\}`, log, undefined, undefined, armHeadSha\)/);
  assert.match(w, /armHeadSha = readHeadShaRest\(result\.prUrl\)/, "W1-T2258: the head sha is recovered, not guessed");
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

// ── 9: the SIXTH site the brief did not name — #968 was inert without it ────────────
test("SITE sweep adapter returns the arm outcome so the sweep can read it at all", () => {
  // W1-T1117: the adapter grew a braced body (to also classify a failed arm's `error` text for
  // the sweep's dedup — see lib/sweep.ts's "mergeable" arm), so the single-expression regex this
  // test used to lock no longer matches. The invariant it actually guards — EVERY path through
  // this effect returns something armOutcomeArmed can read, never an implicit `undefined` — is
  // checked directly against the site's own window instead of one regex over the whole file.
  //
  // AND THE FOLD ITSELF MOVED OUT. `diff-coverage` blocked the braced body: its narrowing guard
  // was reachable only by driving a whole sweep pass, so no test could reach that line. The
  // decision now lives in `sweepArmAttemptOutcome`, a pure function with a fixture per arm — so
  // this test asserts the invariant across BOTH halves rather than pinning literals to whichever
  // half currently holds them. Pinning a literal to a location is what made it stale here twice.
  const anchor = "arm: (pr) => {";
  const at = SRC.indexOf(anchor);
  assert.ok(at > 0, `anchor not found, the test is stale: ${anchor}`);
  const w = SRC.slice(at, at + 1400);
  assert.match(w, /const outcome = armAndLogOutcome\(\s*pr\.prUrl,\s*pr\.taskId,\s*log,/, "still calls the SAME shared wrapper with the SAME prUrl/taskId/log every other lane uses");
  assert.match(w, /return sweepArmAttemptOutcome\(outcome, attemptError\);/, "the adapter's LAST statement is a return — no path falls off the end into an implicit undefined");
  assert.equal(
    SRC.includes("arm: (pr) => {\n      armAutoMerge(pr.prUrl, pr.taskId);\n    },"),
    false,
    "the original discarding form (no return at all) is gone",
  );

  // The fold it delegates to is total: both of its returns are present, so neither the bare
  // outcome nor the richer classified shape can be dropped on the way back to the sweep.
  const foldAt = SRC.indexOf("export function sweepArmAttemptOutcome(");
  assert.ok(foldAt > 0, "the extracted fold is gone — the adapter now delegates to nothing");
  const fold = SRC.slice(foldAt, foldAt + 700);
  assert.match(fold, /if \(outcome !== "arm-error-ignored" \|\| attemptError === undefined\) return outcome;/, "the base outcome is returned, never discarded");
  assert.match(fold, /return \{ outcome, failureClass \};/, "a classified failure is returned as the richer shape, never discarded either");

  // AND THE PROPERTY, DRIVEN — not just grepped. Every shape the adapter can hand the fold comes
  // back as something `armOutcomeArmed` can read; none returns undefined.
  for (const [outcome, err] of [
    ["armed", undefined],
    ["arm-error-ignored", undefined],
    ["arm-error-ignored", "Base branch was modified."],
    ["arm-error-ignored", "Pull request is in clean status"],
    ["arm-error-ignored", "something unclassifiable"],
  ] as const) {
    const folded = sweepArmAttemptOutcome(outcome, err);
    assert.notEqual(folded, undefined, `${outcome}/${String(err)} must never fold to undefined`);
  }
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

// ── W1-T1079 — a failed arm no longer discards the error text it received ───────────
// Same "one ledger, permits the arm" fixture THE KEY test above already proves reaches
// `attemptArm` for real; here `armAuto` throws instead of succeeding, driving the exact catch
// branch that used to return the bare string "arm-error-ignored" with `msg` going nowhere.
function permittingArmDeps(headSha: string, taskId: string, overrides: Partial<ArmDeps> = {}): ArmDeps {
  return {
    headSha: () => headSha,
    ledgerLines: () => [{ step: "review.posted", task_id: taskId, head_sha: headSha, state: "success" }],
    armAuto: () => {
      throw { stderr: "should be overridden by the test" };
    },
    mergeDirect: () => assert.fail("no direct merge should be reached by this fixture"),
    disableAuto: () => assert.fail("nothing is disarmed here"),
    say: () => {},
    ...overrides,
  };
}

test("W1-T1079: a failed arm records the error text it received", () => {
  const HEAD = "beefcafe1234beefcafe1234beefcafe1234bee";
  const TASK_ID = "W1-T1079";
  // A REAL non-clean-status refusal shape (a missing review), not a network blip and not the
  // clean-status case — exactly the shape that used to vanish into "arm-error-ignored" with no
  // trace of what gh actually said.
  const ERROR_TEXT = "GraphQL: Pull request Review Decision is required before merging (mergePullRequest)";
  const said: string[] = [];
  const deps = permittingArmDeps(HEAD, TASK_ID, {
    armAuto: () => {
      throw { stderr: ERROR_TEXT };
    },
    say: (m) => void said.push(m),
  });
  const r = recorder();

  const outcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/1079",
    TASK_ID,
    r.log,
    (prUrl, taskId) => armAutoMergeDetailed(prUrl, taskId, deps),
  );

  assert.equal(outcome, "arm-error-ignored", "sanity: this is still the outcome the classifier not matching direct-merge produces");
  assert.equal(r.steps.length, 1, "exactly one ledger line for this attempt");
  assert.equal(r.steps[0].step, "automerge.arm_failed", "W1-T1052: an attempted-and-failed arm files under arm_failed");
  assert.equal(
    r.steps[0].extra?.error,
    ERROR_TEXT,
    "the row carries the RAW text gh returned, not a summary or the classifier's own label",
  );
  assert.ok(
    said.some((m) => m.includes(ERROR_TEXT)),
    "the console line also names it (deps.say), same as the direct-merge-failed branch already did for msg2",
  );
});

// ── W1-T1079 — armFailureAction no longer assumes transience by default ─────────────
test("W1-T1079: a non clean-status failure is not classified transient by default", () => {
  const PERMANENT_LOOKING = "GraphQL: Pull request Review Decision is required before merging (mergePullRequest)";

  // W1-T1117 renamed the catch-all from "permanent" to "unknown" — this classifier reads stderr
  // PROSE and can never actually prove a refusal is permanent, only that it did not recognize it.
  assert.equal(
    armFailureAction(PERMANENT_LOOKING),
    "unknown",
    "an ordinary refusal with no network/rate-limit/base-branch-race signature must not default to transient",
  );
  assert.notEqual(armFailureAction(PERMANENT_LOOKING), "transient");

  // POSITIVE CONTROL — the third case is genuinely reachable, not just a renamed always-unknown
  // default: a signature that plausibly IS a blip still classifies as transient.
  assert.equal(
    armFailureAction("connect ETIMEDOUT 140.82.112.3:443"),
    "transient",
    "sanity: a genuine network blip still has somewhere to land other than unknown",
  );
});

// ── W1-T1079 — the clean-status case is an unchanged regression lock ────────────────
test("W1-T1079: the clean-status case still routes to the direct merge", () => {
  // The classifier itself, byte for byte the pre-existing behavior.
  assert.equal(armFailureAction("GraphQL: Pull request is in clean status"), "direct-merge");

  // And the BEHAVIOR: attemptArm still falls through to the direct-merge completion, unaffected
  // by the classifier gaining a third answer for the branch it does NOT take here.
  const HEAD = "cafebabe1234cafebabe1234cafebabe1234caf";
  const TASK_ID = "W1-T1079-direct";
  const said: string[] = [];
  const deps = permittingArmDeps(HEAD, TASK_ID, {
    armAuto: () => {
      throw { stderr: "GraphQL: Pull request is in clean status" };
    },
    mergeDirect: () => {},
    say: (m) => void said.push(m),
  });
  const r = recorder();

  const outcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/1079",
    TASK_ID,
    r.log,
    (prUrl, taskId) => armAutoMergeDetailed(prUrl, taskId, deps),
  );

  assert.equal(outcome, "direct-merged");
  assert.deepEqual(r.steps.map((s) => s.step), ["automerge.armed", "automerge.clean_status_direct_merge"]);
  assert.equal(r.steps[0].extra?.error, undefined, "a completed direct merge is a success, not an ignored error");
  assert.ok(said.some((m) => m.includes("clean_status_direct_merge")));
});

// ── W1-T1079 — a successful arm stays exactly as before ─────────────────────────────
test("W1-T1079: a successful arm is unchanged and records no error", () => {
  const HEAD = "decafbad1234decafbad1234decafbad1234dec";
  const TASK_ID = "W1-T1079-armed";
  const deps = permittingArmDeps(HEAD, TASK_ID, { armAuto: () => {} });
  const r = recorder();

  const outcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/1079",
    TASK_ID,
    r.log,
    (prUrl, taskId) => armAutoMergeDetailed(prUrl, taskId, deps),
  );

  assert.equal(outcome, "armed");
  assert.deepEqual(r.steps.map((s) => s.step), ["automerge.armed"]);
  assert.equal(r.steps[0].extra?.error, undefined, "a real arm never had an error to lose in the first place");
  assert.ok(!("error" in (r.steps[0].extra ?? {})), "no error key at all, not merely an undefined one");
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

// ── 14: dep-review's ARM BRANCH, driven for real ────────────────────────────────────
// The one lane this PR touched that no test could previously reach: `ghJson`, `gh pr diff` and
// `postReviewStatusGuarded` were all hardcoded, so `diff-coverage` correctly reported the changed
// arm lines as adding uncovered source. impl-BI gave it the same optional-deps seam PR #964 gave
// triage/plan. Nothing here touches the network: every effect is injected, and `config` is passed
// because `loadConfig()` shells `which claude`, which no CI runner has (W1-T2 / PR #18).
test("dep-review drives its arm branch to a real outcome and reports that outcome, not a fixed string", async () => {
  const { depReviewCommand } = await import("../src/run-task.js");
  const tmp = mkdtempSync(join(tmpdir(), "rmd-bi-depreview-"));
  // ledgerPathFor(config) is `<root>/state/ledger.ndjson` — read the real path, do not guess it.
  const ledgerPath = join(tmp, "state", "ledger.ndjson");
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));

  let code: number;
  try {
    code = await depReviewCommand("80", ["--repo", "remudero"], {
      config: { root: tmp, ledger: ledgerPath } as never,
      gh: () => ({
        number: 80,
        url: "https://github.com/craigoley/remudero/pull/80",
        title: "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to 0.3.210 in the npm-minor-and-patch group",
        body: "Updates `@anthropic-ai/claude-agent-sdk` from 0.3.209 to 0.3.210",
        headRefOid: "beefcafe1234",
        author: { login: "app/dependabot" },
        statusCheckRollup: [
          { name: "ci", conclusion: "SUCCESS" },
          { name: "Review", conclusion: "SUCCESS" },
          { name: "scan-pr", conclusion: "SKIPPED" },
        ],
      }),
      prDiff: () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n",
      postStatus: (async () => ({ posted: true })) as never,
      // THE ARM IS REFUSED — the shape that used to print "auto-merge armed" regardless.
      arm: () => "ledger-refused",
      // impl-FR: a refused arm now ALSO escalates (nothing else can arm a Dependabot PR), so this
      // test needs a gateway or it would file a real issue — the live-write-guard caught exactly
      // that. Injecting one keeps the assertions below unchanged and the boundary offline.
      issues: { create: () => "https://github.com/craigoley/remudero/issues/999", ensureLabel: () => true } as never,
    });
  } finally {
    console.log = realLog;
  }

  assert.equal(code, 0, "the lane still completes — reporting the refusal is not the same as failing");
  const steps = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const armLines = steps.filter((s) => String(s.step).startsWith("automerge."));
  assert.deepEqual(
    armLines.map((s) => s.step),
    ["automerge.arm_skipped"],
    "the refusal is ledgered as a skip — this lane wrote automerge.armed here whatever happened",
  );
  assert.equal(armLines[0].outcome, "ledger-refused", "carrying the branch armAutoMerge actually took");
  const line = printed.find((p) => p.includes("remudero-review=success posted"));
  assert.match(String(line), /NOT armed \(ledger-refused\)/, "and the console says so too");
  assert.doesNotMatch(String(line), /auto-merge armed:/, "never the old fixed claim");
  rmSync(tmp, { recursive: true, force: true });
});

// ── impl-FR: the arm-unreachable DETECTOR ───────────────────────────────────────────
// A Dependabot PR has no independent arm path (sweep's first-match-wins DISPOSITION_RULES put
// `dep-review` above both arming rows; the review lane refuses `dependabot/` heads by name), so an
// arm that does not take leaves the PR green and permanently unmerged with nothing to rescue it.
// These extend test 14 above through the SAME injected seams rather than adding a parallel harness.

/** A stateful issue gateway: `create` records, `listOpen` returns what was created — which is what
 *  makes escalate()'s (taskId, PR, headSha) dedup observable across repeated invocations. */
function issueRecorder() {
  const created: Array<{ title: string; body: string }> = [];
  const comments: string[] = [];
  return {
    created,
    comments,
    gateway: {
      create(title: string, body: string) {
        created.push({ title, body });
        return `https://github.com/craigoley/remudero/issues/${900 + created.length}`;
      },
      listOpen() {
        return created.map((c, i) => ({
          url: `https://github.com/craigoley/remudero/issues/${901 + i}`,
          title: c.title,
          body: c.body,
        }));
      },
      comment(url: string) {
        comments.push(url);
      },
      ensureLabel: () => true,
    },
  };
}

const MANIFEST_DIFF = "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n";
const GREEN_CHECKS = [
  { name: "ci", conclusion: "SUCCESS" },
  { name: "Review", conclusion: "SUCCESS" },
];

async function driveDepReview(opts: {
  title: string;
  body?: string;
  diff?: string;
  headSha?: string;
  arm?: () => string;
  issues?: unknown;
  tmp?: string;
}) {
  const { depReviewCommand } = await import("../src/run-task.js");
  const tmp = opts.tmp ?? mkdtempSync(join(tmpdir(), "rmd-fr-"));
  const ledgerPath = join(tmp, "state", "ledger.ndjson");
  const armCalls: string[] = [];
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  let code: number;
  try {
    code = await (depReviewCommand as never as (p: string, r: string[], d: unknown) => Promise<number>)(
      "80",
      ["--repo", "remudero"],
      {
        config: { root: tmp, ledger: ledgerPath },
        gh: () => ({
          number: 80,
          url: "https://github.com/craigoley/remudero/pull/80",
          title: opts.title,
          body: opts.body ?? "",
          headRefOid: opts.headSha ?? "beefcafe1234",
          author: { login: "app/dependabot" },
          statusCheckRollup: GREEN_CHECKS,
        }),
        prDiff: () => opts.diff ?? MANIFEST_DIFF,
        postStatus: async () => ({ posted: true }),
        arm: () => {
          armCalls.push("called");
          return (opts.arm ?? (() => "ledger-refused"))();
        },
        issues: opts.issues,
      },
    );
  } finally {
    console.log = realLog;
  }
  const steps = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { code, steps, printed, armCalls, tmp, ledgerPath };
}

test("impl-FR: a minor/patch bump whose arm did NOT take is detected and escalated", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to 0.3.210 in the npm-minor-and-patch group",
    arm: () => "ledger-refused",
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 1, "the real arm path was driven, not stubbed around");
  const detector = r.steps.filter((s) => s.step === "dep-review.arm_unreachable");
  assert.equal(detector.length, 1, "the unreachable PR must be reported exactly once");
  assert.equal(detector[0].outcome, "ledger-refused", "carrying the outcome that actually occurred");
  assert.equal(detector[0].head_sha, "beefcafe1234");
  assert.equal(rec.created.length, 1, "and a human-visible issue was opened");
  assert.match(rec.created[0].title, /auto-merge did not arm/);
  assert.match(String(r.printed.join("\n")), /NOTHING ELSE CAN ARM THIS PR/);
  rmSync(r.tmp, { recursive: true, force: true });
});

test("impl-FR: a successful arm emits NO detector signal — the notifier must stay silent when fine", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
    arm: () => "armed",
    issues: rec.gateway,
  });
  assert.equal(r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length, 0);
  assert.equal(rec.created.length, 0, "a signal that also fires on success is one you learn to ignore");
  rmSync(r.tmp, { recursive: true, force: true });
});

// ── THE SAFETY LOCK. The most important test here. ──────────────────────────────────
test("impl-FR SAFETY: a MAJOR bump is never armed and never reaches the detector", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump @types/node from 25.4.1 to 26.1.2",
    body: "Updates `@types/node` from 25.4.1 to 26.1.2",
    arm: () => "armed", // even if arming WOULD succeed, it must never be attempted
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 0, "a major bump must never reach the arm at all");
  assert.equal(
    r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length,
    0,
    "and the detector must not fire for it — that would be the rescue path this design refuses to build",
  );
  assert.deepEqual(
    r.steps.filter((s) => String(s.step).startsWith("automerge.")).map((s) => s.step),
    [],
    "no arm line of any kind for a major bump",
  );
  const decided = r.steps.filter((s) => s.step === "dep-review.decided");
  assert.equal(decided[0].decision, "escalate", "the lane's own policy still owns this outcome");
  rmSync(r.tmp, { recursive: true, force: true });
});

test("impl-FR SAFETY: an unparseable version is likewise never armed and never detected", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump some-package to the latest release",
    body: "no parseable semver pair here",
    arm: () => "armed",
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 0, "an unparseable bump must never reach the arm");
  assert.equal(r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length, 0);
  assert.notEqual(r.steps.filter((s) => s.step === "dep-review.decided")[0].decision, "arm");
  rmSync(r.tmp, { recursive: true, force: true });
});

test("impl-FR SAFETY: a diff touching source outside the manifests is refused, never armed or detected", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
    diff: "diff --git a/src/run-task.ts b/src/run-task.ts\n--- a/src/run-task.ts\n+++ b/src/run-task.ts\n",
    arm: () => "armed",
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 0, "a bump carrying source changes must never reach the arm");
  assert.equal(r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length, 0);
  assert.equal(r.steps.filter((s) => s.step === "dep-review.decided")[0].decision, "refuse");
  assert.equal(rec.created.length, 0);
  rmSync(r.tmp, { recursive: true, force: true });
});

// ── THE BOUND (trap 3). The ticks are made distinguishable by HEAD SHA, which is the
// dimension escalate()'s composite key actually reads — not by wall-clock, which it ignores.
test("impl-FR: repeated dispositions of the SAME unchanged PR open exactly one issue", async () => {
  const rec = issueRecorder();
  const tmp = mkdtempSync(join(tmpdir(), "rmd-fr-bound-"));
  for (let i = 0; i < 3; i++) {
    await driveDepReview({
      title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
      arm: () => "ledger-refused",
      issues: rec.gateway,
      headSha: "sameshaAAAA",
      tmp,
    });
  }
  assert.equal(rec.created.length, 1, "three polls of one stuck PR must not open three issues");
  assert.equal(rec.comments.length, 2, "the later polls append to the open issue instead");

  // A NEW PUSH is a genuinely different state and must NOT be suppressed by the stale issue.
  await driveDepReview({
    title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
    arm: () => "ledger-refused",
    issues: rec.gateway,
    headSha: "differentshaBBBB",
    tmp,
  });
  assert.equal(rec.created.length, 2, "a new head sha is a distinct state and gets its own issue");
  rmSync(tmp, { recursive: true, force: true });
});
