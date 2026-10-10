/**
 * test/a-ready-pr-is-armed-and-its-review-admitted-on-the-next-light-pass.test.ts — W1-T5922.
 *
 * THE DEFECT. `lightPassActionable` refused `mergeable`, so a green, reviewed code PR waited for the
 * next FULL sweep to be armed (measured gap p50 13 min, p90 28 min). W1-T5901 opened the light pass
 * to ONE plan PR's direct merge per pass; code PRs still waited.
 *
 * THE FIX. The ordinary light pass admits `mergeable` and runs the full sweep's own arm path —
 * decideSweepArm, the W1-T5403 risk judge, operator holds and every dedup stand where they stood —
 * and the row it writes names the surface. A review-only pass still arms nothing.
 *
 * REVIEW ADMISSION was already a light-pass action (349 of 408 `sweep.review_admitted` rows on
 * 2026-10-05 read `surface: light`). A PR that waited for a full pass had LOST the light pass's
 * bounded admission; the tests below pin that bound rather than widen it.
 *
 * The harness wires `actionable` to production's own `lightPassActionable`, with the arguments
 * `buildSweepLightHook` passes, so the composition is proven rather than paraphrased.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  decideSweepArm,
  handedOffHeadJudgmentPool,
  runSweep,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { lightPassActionable } from "../src/run-task.js";

const NOW = Date.parse("2026-10-05T18:00:00Z");
const DEFERRED = "deferred to full sweep (light pass)";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5922-`)), "ledger.ndjson");
}

/** A green, reviewed code PR: disposition `mergeable`. */
function readyPr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: false,
    ...over,
  };
}

/** Green with no review yet: disposition `post-review`. */
function eligiblePr(prNumber: number, createdAt: string): OpenPrView {
  return readyPr(prNumber, { reviewState: "none", createdAt });
}

interface Harness {
  deps: SweepDeps;
  armed: Array<{ pr: number; mode?: string }>;
  reviewed: number[];
}

/** `armAllowed` mirrors `buildSweepLightHook`: true on the ordinary pass, false on a review-only one. */
function harness(over: Partial<SweepDeps> = {}, armAllowed = true): Harness {
  const armed: Harness["armed"] = [];
  const reviewed: number[] = [];
  const deps: SweepDeps = {
    log: () => {},
    arm: (p, mode) => {
      armed.push({ pr: p.prNumber, ...(mode ? { mode } : {}) });
      return "armed";
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (p) => {
      reviewed.push(p.prNumber);
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-T5922-1",
    now: () => NOW,
    actionable: (d) => lightPassActionable(d, false, false, armAllowed),
    ...over,
  };
  return { deps, armed, reviewed };
}

function disposed(deps: SweepDeps, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(deps.ledgerPath).findLast((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── (1) the arm ──────────────────────────────────────────────────────────────────────────────────

test("lightPassActionable admits mergeable only when the ordinary light pass says so", () => {
  assert.equal(lightPassActionable("mergeable", false), false, "every 2-argument caller keeps the original shape");
  assert.equal(lightPassActionable("mergeable", true, true), false, "the requeue batch never arms");
  assert.equal(lightPassActionable("mergeable", false, false, true), true, "the ordinary light pass arms");
  assert.equal(lightPassActionable("mergeable", false, false, false), false, "a review-only pass does not");
  assert.equal(lightPassActionable("post-review", false, false, false), true);
  assert.equal(lightPassActionable("blocked-fixable", false, false, true), false, "the fix lane is untouched");
  assert.equal(lightPassActionable("stale", false, false, true), false, "close stays a full-sweep lane");
});

test("a light pass arms a green, reviewed, mergeable code PR and names the light surface on its row", async () => {
  const h = harness();
  await runSweepLightPass([readyPr(9101)], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, [{ pr: 9101 }], "armed once, through deps.arm");
  const row = disposed(h.deps, 9101);
  assert.equal(row?.disposition, "mergeable");
  assert.equal(row?.acted, true);
  assert.equal(row?.arm_outcome, "armed");
  assert.equal(row?.arm_surface, "light");
  assert.notEqual(row?.stand_down_reason, DEFERRED);
});

test("a review-only light pass still leaves the arm to the ordinary pass", async () => {
  const h = harness({}, false);
  await runSweepLightPass([readyPr(9102)], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, []);
  assert.equal(disposed(h.deps, 9102)?.stand_down_reason, DEFERRED);
});

test("decideSweepArm still stands a capped verdict down on a light pass, with its own reason", async () => {
  const h = harness();
  const pr = readyPr(9103);
  appendLedger(h.deps.ledgerPath, {
    run_id: "R", task_id: String(pr.taskId), step: "review.posted", pr_url: pr.prUrl, head_sha: pr.headSha,
    state: "success", capped: true,
  });
  const expected = decideSweepArm(pr, readLedgerLines(h.deps.ledgerPath));
  assert.equal(expected.arm, false, "control: the fixture is a refusal");
  await runSweepLightPass([pr], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, []);
  assert.equal(disposed(h.deps, 9103)?.acted, false);
  assert.equal(disposed(h.deps, 9103)?.stand_down_reason, expected.reason);
});

test("a risk-refused head stands down on a light pass, naming the risk judge", async () => {
  const h = harness();
  const pr = readyPr(9104);
  appendLedger(h.deps.ledgerPath, {
    run_id: "R", task_id: String(pr.taskId), step: "risk_judge.escalated", pr_number: pr.prNumber, head_sha: pr.headSha,
    issue_url: "https://github.com/craigoley/remudero/issues/1",
  });
  await runSweepLightPass([pr], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, []);
  assert.match(String(disposed(h.deps, 9104)?.stand_down_reason), /^risk judge escalated this head/);
});

test("a handed-off head is judged by the W1-T5403 risk judge before a light pass arms it", async () => {
  const escalating = harness({
    judgeHandedOffHead: async () => ({ action: "escalate", reason: "too risky", issueUrl: "https://x/issues/2" }),
    handedOffHeadJudgments: handedOffHeadJudgmentPool(),
  });
  const pr = readyPr(9105);
  appendLedger(escalating.deps.ledgerPath, {
    run_id: "R", task_id: String(pr.taskId), step: "verdict", verdict: "handed_off", pr_url: pr.prUrl, reason: "pr_open_yield",
  });
  await runSweepLightPass([pr], escalating.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(escalating.armed, [], "the judge's escalation holds the arm");
  assert.match(String(disposed(escalating.deps, 9105)?.stand_down_reason), /risk judge escalated this handed-off head/);
});

test("an operator merge hold stands the light-pass arm down", async () => {
  const h = harness();
  const pr = readyPr(9106);
  appendLedger(h.deps.ledgerPath, {
    run_id: "R", task_id: String(pr.taskId), step: "automerge.hold_engaged", pr_number: pr.prNumber, authority: "interactive-cli",
    by: "operator", reason: "hold for a decision",
  });
  await runSweepLightPass([pr], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, []);
  assert.match(String(disposed(h.deps, 9106)?.stand_down_reason), /operator merge hold/);
});

test("an already-armed PR is deduped on a light pass, by GitHub's bit and by a prior pass", async () => {
  const h = harness();
  const onGitHub = readyPr(9107, { autoMergeArmed: true });
  const byPriorPass = readyPr(9108);
  appendLedger(h.deps.ledgerPath, {
    run_id: "R", task_id: String(byPriorPass.taskId), step: "sweep.disposed", pr_number: byPriorPass.prNumber,
    head_sha: byPriorPass.headSha, disposition: "mergeable", acted: true, arm_outcome: "armed",
  });
  await runSweepLightPass([onGitHub, byPriorPass], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, []);
  assert.match(String(disposed(h.deps, 9107)?.stand_down_reason), /^auto-merge already armed \(observed on GitHub\)/);
  assert.match(String(disposed(h.deps, 9108)?.stand_down_reason), /^auto-merge already armed by a prior sweep pass/);
});

test("the armed-idle completion stays on the full pass: a light pass never attempts it", async () => {
  const pr = readyPr(9109, { autoMergeArmed: true });
  const seed = (deps: SweepDeps) => appendLedger(deps.ledgerPath, {
    run_id: "R", task_id: String(pr.taskId), step: "automerge.arm_skipped", pr_number: pr.prNumber, head_sha: pr.headSha,
    armed_idle_observed: true,
  });
  const light = harness();
  seed(light.deps);
  await runSweepLightPass([pr], light.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(light.armed, [], "no guarded completion from a 60-second pass");

  const full = harness({ actionable: undefined });
  seed(full.deps);
  await runSweep([pr], full.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(full.armed, [{ pr: 9109, mode: "armed-idle" }], "control: the full pass completes it");
});

test("a light pass reads the live head for its arm and stands down when the head moved", async () => {
  const reads: number[] = [];
  const h = harness({
    readLiveHeadSha: async (p) => {
      reads.push(p.prNumber);
      return p.prNumber === 9110 ? "movedsha" : p.headSha;
    },
  });
  await runSweepLightPass(
    [readyPr(9110), readyPr(9111), eligiblePr(9112, "2026-10-05T17:00:00Z")],
    h.deps,
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(h.armed, [{ pr: 9111 }]);
  assert.match(String(disposed(h.deps, 9110)?.stand_down_reason), /^head moved from/);
  assert.deepEqual(h.reviewed, [9112], "the review lane is unchanged");
  assert.deepEqual(reads.sort(), [9110, 9111], "only the arm reads the live head on a light pass");
});

test("one plan PR direct-merges per light pass (W1-T5901) while a code PR beside it is armed", async () => {
  const h = harness();
  const code = readyPr(9113);
  const firstPlan = readyPr(9114, { isPlanFiling: true });
  const secondPlan = readyPr(9115, { isPlanFiling: true });
  await runSweepLightPass([code, firstPlan, secondPlan], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed.map((a) => a.pr).sort(), [9113, 9114], "the code PR and ONE plan PR");
  assert.equal(disposed(h.deps, 9115)?.acted, false);
  assert.match(String(disposed(h.deps, 9115)?.stand_down_reason), /one plan PR direct-merges per light pass/);
});

test("two passes never arm one head at once: the second names the arm in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const light = harness({
    arm: async (p) => {
      light.armed.push({ pr: p.prNumber });
      await gate;
      return "armed" as const;
    },
  });
  const pr = readyPr(9116);
  const lightPass = runSweepLightPass([pr], light.deps, DEFAULT_SWEEP_POLICY);
  for (let i = 0; i < 100 && light.armed.length === 0; i++) await settle();
  assert.equal(light.armed.length, 1, "precondition: the light arm is in flight");

  const full = harness({ actionable: undefined, ledgerPath: light.deps.ledgerPath, runId: "SWEEP-T5922-full" });
  await runSweep([pr], full.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(full.armed, [], "the overlapping full pass does not arm the same head");
  const fullRow = readLedgerLines(light.deps.ledgerPath)
    .find((l) => l.step === "sweep.disposed" && l.run_id === "SWEEP-T5922-full");
  assert.match(String(fullRow?.stand_down_reason), /arm for this head is already in flight/);
  release();
  await lightPass;
  assert.equal(disposed(light.deps, 9116)?.arm_outcome, "armed");
});

test("a throwing arm releases its in-flight claim, so the next pass arms", async () => {
  let calls = 0;
  const h = harness({
    arm: () => {
      calls++;
      if (calls === 1) throw new Error("gh: 502");
      return "armed";
    },
  });
  const pr = readyPr(9117);
  await runSweepLightPass([pr], h.deps, DEFAULT_SWEEP_POLICY);
  assert.match(String(disposed(h.deps, 9117)?.action_error), /gh: 502/);
  await runSweepLightPass([pr], h.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls, 2, "the claim did not outlive the throw");
  assert.equal(disposed(h.deps, 9117)?.arm_outcome, "armed");
});

test("a full pass arms exactly as before: no surface field and the same outcome", async () => {
  const h = harness({ actionable: undefined });
  await runSweep([readyPr(9118)], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.armed, [{ pr: 9118 }]);
  const row = disposed(h.deps, 9118);
  assert.equal(row?.acted, true);
  assert.equal(row?.arm_outcome, "armed");
  assert.equal("arm_surface" in (row ?? {}), false, "a full pass row is unchanged");
});

// ── (2) review admission: already a light-pass action, under its bound ────────────────────────────

test("a light pass admits a review-eligible PR under the admission bound and names the loser's bound", async () => {
  const h = harness();
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
  const older = eligiblePr(9119, "2026-10-05T16:00:00Z");
  const younger = eligiblePr(9120, "2026-10-05T17:00:00Z");
  await runSweepLightPass([younger, older], h.deps, policy);
  assert.deepEqual(h.reviewed, [9119], "oldest first, one admission at width 1");
  const admitted = readLedgerLines(h.deps.ledgerPath).find((l) => l.step === "sweep.review_admitted");
  assert.equal(admitted?.pr_number, 9119);
  assert.equal(admitted?.surface, "light");
  assert.match(
    String(disposed(h.deps, 9120)?.stand_down_reason),
    /^not admitted this pass: semantic post-review admission bound 1; admitted #9119 ahead/,
  );
});

test("a full admission bound stands a light-pass review down while the admitted review runs", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({
    postReview: async (p) => {
      h.reviewed.push(p.prNumber);
      await gate;
    },
  });
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
  await runSweepLightPass([eligiblePr(9121, "2026-10-05T16:00:00Z")], h.deps, policy);
  assert.deepEqual(h.reviewed, [9121], "the first review is admitted and detached");
  await runSweepLightPass([eligiblePr(9122, "2026-10-05T17:00:00Z")], h.deps, policy);
  assert.deepEqual(h.reviewed, [9121], "no second review while the bound is spent");
  assert.match(String(disposed(h.deps, 9122)?.stand_down_reason), /^not admitted this pass: semantic post-review admission bound 0/);
  release();
  for (let i = 0; i < 10; i++) await settle();
});
