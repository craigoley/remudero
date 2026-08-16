import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { drainCommand, readPushedRunBranchesOutput, type RunResult } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import {
  IDLE_REASON_ID_CAP,
  tallyDispatchFilters,
  applyCuratedSelection,
  buildDrainPreview,
  buildRundown,
  nextRunnable,
  plannedSequence,
  renderRundown,
  renderSummary,
  resumeCommand,
  runBranchTaskIds,
  runDrain,
  runnableCandidates,
  type CuratedSelection,
  type DrainDeps,
  type DrainSummary,
  type MergedSet,
  type OpenPrCheck,
} from "../src/lib/drain.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";
// W1-T343: runDaemon ADOPTS this file's own lane machinery (runnableCandidates,
// partitionByFileOverlap via drain.ts) rather than a second implementation — these tests drive
// the DAEMON'S tick, at laneCount >= 2, proving the WIRING; the underlying partition/candidate
// predicates are proven in isolation by the tests above (and in test/parallel-dispatch.test.ts,
// runDrain's own multi-lane pass) and are never re-derived here.
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";

// A small linear-ish plan: A → B → C (chain) + D (independent), all auto.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
  note: "b's rationale"
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: H
  title: human-only
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;
function mergedSetOf(...ids: string[]): MergedSet {
  const s = new Set(ids);
  return (id) => s.has(id);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const blockedResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: false, costUsd: 0.3, verdict: "blocked_review", prUrl: "https://github.com/o/r/pull/9" });

// ── next-runnable = the DAG logic (reuses unmetDependencies) ────────────────

test("nextRunnable: first in file order whose deps are merged; skips verify:human and merged", () => {
  const plan = fixturePlan();
  // Nothing merged: A and D are runnable; A wins (file order). H (human) is skipped.
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  // A merged: B and D runnable; B wins (file order before D).
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
  // A,B,C,D merged: only H left, and it is verify:human ⇒ nothing runnable.
  assert.equal(nextRunnable(plan, mergedSetOf("A", "B", "C", "D")), undefined);
});

// ── runnableCandidates: the multi-candidate generalization of nextRunnable
// (W1-T171) — the candidate source dispatch-overlap.ts's partitionByFileOverlap
// consumes. Must apply the EXACT SAME eligibility chain as nextRunnable (they
// share isDispatchEligible), only returning MORE than one task and honoring
// `limit`.

test("runnableCandidates: every runnable task in file order, capped at limit — skips verify:human and merged exactly like nextRunnable", () => {
  const plan = fixturePlan(); // A, B(dep A), C(dep B), D(no deps), H(verify:human)
  // Nothing merged: only A and D are eligible (B/C blocked on unmet deps, H is human-only).
  assert.deepEqual(
    runnableCandidates(plan, NONE_MERGED, 10).map((t) => t.id),
    ["A", "D"],
  );
  // limit=1 truncates to the first eligible candidate in file order.
  assert.deepEqual(
    runnableCandidates(plan, NONE_MERGED, 1).map((t) => t.id),
    ["A"],
  );
  // limit<=0 yields an empty array.
  assert.deepEqual(runnableCandidates(plan, NONE_MERGED, 0), []);
  // A merged: B (deps now met) and D are eligible.
  assert.deepEqual(
    runnableCandidates(plan, mergedSetOf("A"), 10).map((t) => t.id),
    ["B", "D"],
  );
});

test("runnableCandidates: an in-flight (open-PR) task is excluded, same as nextRunnable — the eligibility chains never drift", () => {
  const plan = fixturePlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 42 : undefined);
  assert.deepEqual(
    runnableCandidates(plan, NONE_MERGED, 10, { isOpenPr, onSkip: () => {} }).map((t) => t.id),
    ["D"],
  );
});

// ── W1-T76 (absorbs P21): creditability is LOAD-BEARING for the whole DAG,
// not just anti-orphan. The fix rung amends the SAME run-<taskId>-<epochMs>
// branch this run opened; once THAT branch merges, deriveStatus credits the
// task exactly as an unfixed merge would, and nextRunnable naturally unblocks
// its dependent — composing status.ts's existing ownership-assert with
// drain.ts's existing DAG walk, no new production code required.
test("W1-T76: once the fix rung's SAME-branch amendment merges, deriveStatus credits the fixed task AND nextRunnable unblocks its dependent", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const runId = "A-1730000000000"; // this run's OWN branch — never a fix/* head
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => (taskId === "A" ? { number: 50, url: "u/50", state: "MERGED" } : null),
    headRefName: (prUrl) => (prUrl === "u/50" ? `run-${runId}` : undefined),
    prBody: (prUrl) => (prUrl === "u/50" ? "Remudero-Task: A\n" : undefined),
  };
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-fixrung-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const isMerged: MergedSet = (taskId) => {
    const t = plan.tasks.find((x) => x.id === taskId);
    return t ? deriveStatus(t, { ledgerPath, github }).merged : false;
  };

  assert.equal(isMerged("A"), true, "the fixed task's SAME-branch merge is credited (source: trailer)");
  const next = nextRunnable(plan, isMerged);
  assert.equal(next?.id, "B", "A's dependent (B) is now runnable — the fix rung's merge unblocked it");
  assert.notEqual(next?.id, "A", "the already-merged/fixed task itself is EXCLUDED from runnable");
});

// ── W1-T80: dispatch dedup — an OPEN PR means IN-FLIGHT, never runnable ─────
// (the #143/#145 duplicate-build race: rmd review posted success on #143, the
// drain started seconds later — merging is async, so the task looked
// not-merged and a fresh worker rebuilt it end-to-end as #145, orphaning the
// reviewed-green #143).

test("W1-T80 canonical race fixture: a task whose latest PR is OPEN is excluded from nextRunnable, with a legible skip naming the PR", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
  });
  // A is IN-FLIGHT (open PR #143) — excluded, never re-dispatched as a duplicate build.
  assert.deepEqual(skips, [{ id: "A", prNumber: 143 }]);
  // D is the next runnable candidate in file order once A is skipped (B/C still
  // depend on the un-merged A).
  assert.equal(next?.id, "D");
});

test("W1-T80: a CLOSED (unmerged) PR does NOT block — an abandoned/superseded attempt leaves the task runnable", () => {
  const plan = fixturePlan();
  // A's latest PR is CLOSED (not open) — isOpenPr correctly reports "not open".
  const isOpenPr: OpenPrCheck = () => undefined;
  const next = nextRunnable(plan, NONE_MERGED, { isOpenPr, onSkip: () => assert.fail("no skip expected") });
  assert.equal(next?.id, "A", "a closed-unmerged PR leaves the task runnable — re-runs stay possible");
});

test("W1-T80: merged and correction-credited tasks are excluded exactly as today, isOpenPr never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const isOpenPr: OpenPrCheck = (id) => {
    consulted.push(id);
    return undefined;
  };
  const next = nextRunnable(plan, mergedSetOf("A"), { isOpenPr });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isOpenPr is ever asked");
});

test("W1-T80: no isOpenPr wired at all ⇒ nextRunnable behaves exactly as before this guard existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
});

// ── W1-T177: TERMINAL-STATE CHECK — the in-flight guard CONFIRMS a candidate
// open PR with a fresh live read before skipping it, rather than trusting the
// cached `isOpenPr` snapshot forever. FIXTURE: PR #388 merged at 20:24:44Z;
// `dispatch.skipped reason='open-pr' pr_number 388` still fired at 20:31:00,
// more than six minutes later — the cached in-flight read never re-checked. ──

test("W1-T177: a task whose cached in-flight PR has actually MERGED (fresh live read) is NOT skipped — the stale snapshot is overturned, and onStoodDown names the state rather than 'open-pr' (the #388 falsifier)", () => {
  const plan = fixturePlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 388 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const stoodDown: Array<{ id: string; prNumber: number; state: string }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
    readLiveState: (id, prNumber) => (id === "A" && prNumber === 388 ? "MERGED" : "OPEN"),
    onStoodDown: (t, prNumber, state) => stoodDown.push({ id: t.id, prNumber, state }),
  });
  assert.deepEqual(skips, [], "A must NOT be reported as in-flight from a cached snapshot");
  assert.deepEqual(stoodDown, [{ id: "A", prNumber: 388, state: "MERGED" }]);
  assert.equal(next?.id, "A", "A is actually runnable — its cached in-flight PR already merged");
});

test("W1-T177: readLiveState CONFIRMS a genuinely still-open PR — the task is skipped exactly as before, onStoodDown never fires", () => {
  const plan = fixturePlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
    readLiveState: () => "OPEN",
    onStoodDown: () => assert.fail("onStoodDown must not fire on a genuinely still-open PR"),
  });
  assert.deepEqual(skips, [{ id: "A", prNumber: 143 }]);
  assert.equal(next?.id, "D");
});

test("W1-T177: a FAILED/INDETERMINATE live-state read (undefined) does NOT overturn the skip — fail OPEN, never a false dispatch on an unreadable state", () => {
  const plan = fixturePlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
    readLiveState: () => undefined,
    onStoodDown: () => assert.fail("onStoodDown must not fire on an indeterminate read"),
  });
  assert.deepEqual(skips, [{ id: "A", prNumber: 143 }]);
  assert.equal(next?.id, "D");
});

test("W1-T177: readLiveState omitted ⇒ nextRunnable behaves EXACTLY as before this check existed", () => {
  const plan = fixturePlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
    // readLiveState deliberately omitted.
  });
  assert.deepEqual(skips, [{ id: "A", prNumber: 143 }]);
  assert.equal(next?.id, "D");
});

test("W1-T80 runDrain integration: the #143 state is skipped with a dispatch.skipped ledger line (task + PR number), and the drain proceeds to the next runnable task instead of halting", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // A's most recent PR (#143) is OPEN — reviewed-green but not yet merged
      // (merge is async). It must never be re-dispatched as a fresh build.
      isOpenPr: (id) => (id === "A" ? 143 : undefined),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (in-flight under open PR #143) was never re-dispatched as a duplicate build");
  // D is the only other runnable candidate (B/C depend on the still-open A).
  assert.deepEqual(ran, ["D"]);
  assert.equal(s.stopReason, "max_reached");
  const skipLine = lines.find((l) => l.step === "dispatch.skipped");
  assert.ok(skipLine, "a dispatch.skipped ledger line was emitted");
  assert.equal(skipLine?.extra.task, "A");
  assert.equal(skipLine?.extra.pr_number, 143);
  assert.equal(skipLine?.extra.reason, "open-pr");
});

test("W1-T177 runDrain integration: a task whose cached in-flight PR has actually MERGED dispatches instead of being skipped, ledgering dispatch.stood_down rather than a misleading dispatch.skipped 'open-pr' (the #388 falsifier)", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // The cached in-flight snapshot still reports A's PR #388 as open, but a
      // fresh live read shows it already merged (the exact #388 fixture shape:
      // `dispatch.skipped reason='open-pr'` six-plus minutes post-merge).
      isOpenPr: (id) => (id === "A" ? 388 : undefined),
      readLiveState: (id, prNumber) => (id === "A" && prNumber === 388 ? "MERGED" : "OPEN"),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.deepEqual(ran, ["A"], "A dispatches — the cached 'in-flight' snapshot was stale, the live read overturned it");
  assert.equal(s.stopReason, "max_reached");
  assert.ok(!lines.some((l) => l.step === "dispatch.skipped"), "no misleading dispatch.skipped 'open-pr' line");
  const stoodDownLine = lines.find((l) => l.step === "dispatch.stood_down");
  assert.ok(stoodDownLine, "a dispatch.stood_down ledger line was emitted, naming the corrected state");
  assert.equal(stoodDownLine?.extra.task, "A");
  assert.equal(stoodDownLine?.extra.pr_number, 388);
  assert.equal(stoodDownLine?.extra.state, "MERGED");
});

test("W1-T177 runDrain integration: a FAILED/INDETERMINATE live-state read at the in-flight guard does NOT overturn the skip — A stays skipped exactly as today, AND the indeterminate read is ledgered distinctly from an ordinary dispatch.skipped", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isOpenPr: (id) => (id === "A" ? 143 : undefined),
      // A genuine read failure (rate-limited/network/auth) — undefined.
      readLiveState: () => undefined,
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.deepEqual(ran, ["D"], "A stays skipped — an unreadable state is never treated as terminal, fail OPEN toward the pre-existing skip");
  assert.equal(s.stopReason, "max_reached");
  assert.ok(!lines.some((l) => l.step === "dispatch.stood_down"), "no false stand-down on an unreadable state");
  const skipLine = lines.find((l) => l.step === "dispatch.skipped");
  assert.ok(skipLine, "A is still reported dispatch.skipped, exactly as before this check existed");
  const indeterminateLine = lines.find((l) => l.step === "dispatch.live_state_indeterminate");
  assert.ok(indeterminateLine, "the failed/indeterminate read is LEDGERED — never a silent swallow");
  assert.equal(indeterminateLine?.extra.task, "A");
  assert.equal(indeterminateLine?.extra.pr_number, 143);
});

// ── W1-T534: the STALE-ABSENT window `isOpenPr` cannot see. `isOpenPr` reads a cached
// projection, so a PR opened (or a branch merely pushed ahead of its PR) after that snapshot
// was taken is invisible to it. `hasPushedRunBranch` closes that window with one ref sweep per
// pass, parsed by `runBranchTaskIds`/`taskIdFromRunBranch` (status.ts) — never a second regex.

test("W1-T534: runBranchTaskIds parses a raw `git ls-remote --heads origin 'run-*'` line into the task id it names", () => {
  const sweep = runBranchTaskIds(
    ["abc123\trefs/heads/run-W1-T534-1786886488695", "", "def456\trefs/heads/run-W1-T80-1700000000000"].join("\n"),
  );
  assert.deepEqual([...sweep].sort(), ["W1-T534", "W1-T80"]);
});

test("W1-T534: a candidate with an existing run branch is refused", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const skipped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    // isOpenPr deliberately omitted/blind here — the cached projection never saw this PR/branch,
    // which is exactly the window this probe exists to close.
    hasPushedRunBranch: (id) => id === "A",
    onSkipRunBranch: (t) => skipped.push(t.id),
  });
  assert.deepEqual(skipped, ["A"]);
  assert.equal(next?.id, "D", "A is refused by the ref sweep alone; D is the next runnable candidate");
});

test("W1-T534: a candidate with no run branch still dispatches", () => {
  const plan = fixturePlan();
  const next = nextRunnable(plan, NONE_MERGED, {
    hasPushedRunBranch: () => false,
    onSkipRunBranch: () => assert.fail("no skip expected — no run branch exists on origin"),
  });
  assert.equal(next?.id, "A", "an empty sweep changes nothing — dispatch proceeds exactly as before this check existed");
});

test("W1-T534: hasPushedRunBranch omitted ⇒ nextRunnable behaves EXACTLY as before this check existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
});

test("W1-T534: a shorter task id does not match a longer branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "drain-w1t534-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    `
- id: W1-T51
  title: shorter id
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: W1-T512
  title: longer id, same prefix
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`,
  );
  const plan = loadPlan(f);
  // ONE branch exists on origin, naming the LONGER id only. A naive `branchName.includes(taskId)`
  // check would wrongly match "W1-T51" too — "run-W1-T512-..." contains "W1-T51" as its first
  // eleven characters. runBranchTaskIds/taskIdFromRunBranch's anchored, greedy-ordinal parse never
  // makes that mistake: it names exactly W1-T512.
  const sweep = runBranchTaskIds("abc123\trefs/heads/run-W1-T512-1690000000000\n");
  assert.deepEqual([...sweep], ["W1-T512"], "the sweep names the FULL ordinal, never a truncated prefix");

  const skipped: string[] = [];
  const candidates = runnableCandidates(plan, NONE_MERGED, 10, {
    hasPushedRunBranch: (id) => sweep.has(id),
    onSkipRunBranch: (t) => skipped.push(t.id),
  }).map((t) => t.id);
  assert.deepEqual(skipped, ["W1-T512"], "only the id the branch actually names is refused");
  assert.deepEqual(candidates, ["W1-T51"], "the shorter id is untouched by the longer branch and still dispatches");
});

test("W1-T534: a refused candidate stays eligible and burns no strike", () => {
  const plan = fixturePlan();
  const broken: string[] = [];
  const lifetimeCapped: string[] = [];
  const skipped: string[] = [];
  const opts = {
    hasPushedRunBranch: (id: string) => id === "A",
    onSkipRunBranch: (t: { id: string }) => skipped.push(t.id),
    onCircuitBreak: (t: { id: string }) => broken.push(t.id),
    onLifetimeCapExceeded: (t: { id: string }) => lifetimeCapped.push(t.id),
  };
  const firstPass = nextRunnable(plan, NONE_MERGED, opts);
  assert.deepEqual(skipped, ["A"]);
  assert.equal(firstPass?.id, "D", "A is skipped this pass, not treated as blocked/merged");
  assert.deepEqual(broken, [], "a ref-sweep refusal never trips the circuit breaker");
  assert.deepEqual(lifetimeCapped, [], "a ref-sweep refusal never burns the lifetime dispatch cap");

  // Once the branch is gone (reap-branches has swept it, or it never existed on this later pass),
  // the SAME task is offered again — this was a SKIP, never a terminal state (design (iv)).
  const secondPass = nextRunnable(plan, NONE_MERGED, { hasPushedRunBranch: () => false });
  assert.equal(secondPass?.id, "A", "A is runnable again on the next pass once its branch is gone");
});

// ── P29(ii): the per-task dispatch CIRCUIT BREAKER — the backstop that makes
// P29(i)'s sibling-credit fix safe to get wrong (MASTER-PLAN P29).

test("P29(ii): a task whose circuit breaker is tripped is excluded from nextRunnable, with a legible callback naming it", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const broken: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isCircuitTripped: (id) => id === "A",
    onCircuitBreak: (t) => broken.push(t.id),
  });
  assert.deepEqual(broken, ["A"]);
  // D is the next runnable candidate once A is halted (B/C still depend on the
  // un-merged, circuit-broken A).
  assert.equal(next?.id, "D");
});

test("P29(ii): the circuit breaker is checked BEFORE the in-flight (open-PR) guard — a tripped task halts regardless of its latest PR's state", () => {
  const plan = fixturePlan();
  const broken: string[] = [];
  const skipped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isCircuitTripped: (id) => id === "A",
    onCircuitBreak: (t) => broken.push(t.id),
    isOpenPr: (id) => (id === "A" ? 143 : undefined), // A ALSO looks in-flight — the breaker must still win
    onSkip: (t) => skipped.push(t.id),
  });
  assert.deepEqual(broken, ["A"]);
  assert.deepEqual(skipped, [], "onSkip must never fire for a task the breaker already halted");
  assert.equal(next?.id, "D");
});

test("P29(ii): merged and correction-credited tasks are excluded exactly as today, isCircuitTripped never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const next = nextRunnable(plan, mergedSetOf("A"), {
    isCircuitTripped: (id) => {
      consulted.push(id);
      return false;
    },
  });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isCircuitTripped is ever asked");
});

test("P29(ii): no isCircuitTripped wired at all ⇒ nextRunnable behaves exactly as before this breaker existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
});

// ── W1-T119: an INDETERMINATE read (GitHub could not be consulted — rate
// limit/network/auth failure) must suppress dispatch, distinct from an
// ordinary `queued` task (whose read genuinely resolved to "no evidence"),
// which dispatches normally. This is the dispatch-gating caller half of the
// task's acceptance criterion; applyCorrection (correct.ts) is the other half.

test("W1-T119: a task whose own GitHub read is INDETERMINATE is excluded from nextRunnable, with a legible callback naming it", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const indeterminate: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isIndeterminate: (id) => id === "A",
    onIndeterminate: (t) => indeterminate.push(t.id),
  });
  assert.deepEqual(indeterminate, ["A"]);
  // D is the next runnable candidate once A is deferred (B/C still depend on
  // the un-merged, indeterminate A).
  assert.equal(next?.id, "D");
});

test("W1-T119: the SAME task dispatches normally when its read is an ordinary queued (not indeterminate) — the two must read as distinct", () => {
  const plan = fixturePlan();
  // No isIndeterminate wired at all ⇒ A is ordinary queued, and dispatches.
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  // Same task, isIndeterminate explicitly false for it ⇒ still dispatches.
  assert.equal(nextRunnable(plan, NONE_MERGED, { isIndeterminate: () => false })?.id, "A");
});

test("W1-T119: indeterminate is checked BEFORE the circuit breaker and the in-flight guard — an indeterminate task halts regardless of either", () => {
  const plan = fixturePlan();
  const indeterminate: string[] = [];
  const broken: string[] = [];
  const skipped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isIndeterminate: (id) => id === "A",
    onIndeterminate: (t) => indeterminate.push(t.id),
    isCircuitTripped: (id) => id === "A", // A ALSO looks circuit-broken — indeterminate must still win
    onCircuitBreak: (t) => broken.push(t.id),
    isOpenPr: (id) => (id === "A" ? 143 : undefined), // A ALSO looks in-flight — indeterminate must still win
    onSkip: (t) => skipped.push(t.id),
  });
  assert.deepEqual(indeterminate, ["A"]);
  assert.deepEqual(broken, [], "onCircuitBreak must never fire for a task indeterminate already halted");
  assert.deepEqual(skipped, [], "onSkip must never fire for a task indeterminate already halted");
  assert.equal(next?.id, "D");
});

test("W1-T119: merged and correction-credited tasks are excluded exactly as today, isIndeterminate never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const next = nextRunnable(plan, mergedSetOf("A"), {
    isIndeterminate: (id) => {
      consulted.push(id);
      return false;
    },
  });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isIndeterminate is ever asked");
});

test("W1-T119 runDrain integration: an indeterminate task is skipped with a dispatch.indeterminate ledger line, the drain proceeds to the next runnable task, and the caller's onIndeterminate fires", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const indeterminate: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isIndeterminate: (id) => id === "A",
      onIndeterminate: (t) => indeterminate.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    },
    { max: 3 },
  );
  // onIndeterminate carries NO escalation side effect (unlike onCircuitBreak,
  // which dedupes because it opens a needs-human issue) — it fires every tick
  // A is consulted, same as onSkip: once dispatching D (tick 1), once more
  // when A is still indeterminate and nothing else is left to run (tick 2,
  // "no_runnable").
  assert.deepEqual(indeterminate, ["A", "A"]);
  // A is deferred every tick (still un-merged, still indeterminate) — D runs
  // instead, and the drain never touches B/C (blocked on the deferred A).
  assert.deepEqual(ran, ["D"]);
  assert.equal(s.stopReason, "no_runnable");
  const indeterminateLine = lines.find((l) => l.step === "dispatch.indeterminate");
  assert.equal(indeterminateLine?.extra.task, "A");
});

test("P29(ii) runDrain integration: a circuit-broken task is skipped with a dispatch.circuit_broken ledger line, the drain proceeds to the next runnable task, and the caller's onCircuitBreak fires", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const broken: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched");
  assert.deepEqual(ran, ["D"]);
  assert.deepEqual(broken, ["A"], "the caller's onCircuitBreak fired exactly once for A");
  assert.equal(s.stopReason, "max_reached");
  const brokenLine = lines.find((l) => l.step === "dispatch.circuit_broken");
  assert.ok(brokenLine, "a dispatch.circuit_broken ledger line was emitted");
  assert.equal(brokenLine?.extra.task, "A");
});

test("P29(ii) the W1-T29 x10 spin shape: a task at N+1 dispatches with no owned PR HALTS with EXACTLY ONE escalation and ZERO further dispatches, across MULTIPLE ticks of the SAME drain run", async () => {
  // `nextRunnable` is re-invoked on EVERY tick of the loop — a naive wiring
  // re-observes (and re-escalates) a still-tripped task on every tick it
  // remains the only thing left to look at, not just the first. This plan
  // (A tripped; D independent) forces a SECOND tick after D dispatches
  // successfully: tick 1 observes A tripped then dispatches D; tick 2 (D is
  // now merged) observes A tripped AGAIN with nothing else left to run. A
  // wiring that escalates once per OBSERVATION (rather than once per TASK
  // for the whole run) fails this — the exact regression this test guards.
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const broken: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    // No --max ⇒ DEFAULT_MAX (10): enough headroom for a SECOND tick to occur
    // after D merges, so the drain runs to "no_runnable" on its own rather
    // than being cut short at exactly one tick (which would hide this bug).
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched, at N or at N+1");
  assert.deepEqual(ran, ["D"], "D is the only task ever dispatched — B/C stay unmet-dependency-blocked on the tripped A");
  assert.equal(s.stopReason, "no_runnable", "the drain ran a SECOND tick (proving A was re-observed, not just observed once)");
  assert.deepEqual(broken, ["A"], "onCircuitBreak fired EXACTLY ONCE for A, even though nextRunnable re-observed it tripped on a later tick too");
  const brokenLines = lines.filter((l) => l.step === "dispatch.circuit_broken");
  assert.ok(brokenLines.length >= 2, "sanity: A really was re-observed tripped on a second tick (the ledger line legibly re-logs every observation)");
});

// ── W1-T316: the LIFETIME dispatch cap, wired into runDrain's single-lane loop ──
// (mirrors P29(ii)'s onCircuitBreak coverage immediately above, one field over)

test("W1-T316 runDrain integration: a lifetime-capped task is skipped with a dispatch.lifetime_capped ledger line, the drain proceeds to the next runnable task, and the caller's onLifetimeCapExceeded fires", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const capped: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isLifetimeCapExceeded: (id) => id === "A",
      onLifetimeCapExceeded: (t) => capped.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (lifetime-capped) was never dispatched");
  assert.deepEqual(ran, ["D"]);
  assert.deepEqual(capped, ["A"], "the caller's onLifetimeCapExceeded fired exactly once for A");
  assert.equal(s.stopReason, "max_reached");
  const cappedLine = lines.find((l) => l.step === "dispatch.lifetime_capped");
  assert.ok(cappedLine, "a dispatch.lifetime_capped ledger line was emitted");
  assert.equal(cappedLine?.extra.task, "A");
});

test("W1-T316 the W1-T29 x10 spin shape: a lifetime-capped task stays skipped with EXACTLY ONE escalation across MULTIPLE ticks of the SAME drain run", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const capped: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isLifetimeCapExceeded: (id) => id === "A",
      onLifetimeCapExceeded: (t) => capped.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    // No --max ⇒ DEFAULT_MAX (10): enough headroom for a SECOND tick to occur
    // after D merges, so the drain runs to "no_runnable" on its own.
  );
  assert.ok(!ran.includes("A"), "A (lifetime-capped) was never dispatched, at N or at N+1");
  assert.deepEqual(ran, ["D"], "D is the only task ever dispatched — B/C stay unmet-dependency-blocked on the capped A");
  assert.equal(s.stopReason, "no_runnable", "the drain ran a SECOND tick (proving A was re-observed, not just observed once)");
  assert.deepEqual(capped, ["A"], "onLifetimeCapExceeded fired EXACTLY ONCE for A, even though nextRunnable re-observed it capped on a later tick too");
  const cappedLines = lines.filter((l) => l.step === "dispatch.lifetime_capped");
  assert.ok(cappedLines.length >= 2, "sanity: A really was re-observed capped on a second tick (the ledger line legibly re-logs every observation)");
});

test("plannedSequence (--dry-run order): simulates merges forward, honouring deps + --max + --until", () => {
  const plan = fixturePlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C", "D"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { max: 2 }), ["A", "B"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { until: "B" }), ["A", "B"]);
  // --until already satisfied ⇒ empty.
  assert.deepEqual(plannedSequence(plan, mergedSetOf("A", "B"), { until: "B" }), []);
});

// ── the loop: stop-on-block, --max, headroom, until, no-runnable ────────────

test("stop-on-block: a blocked task HALTS the drain and does NOT run its dependents", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        // A merges; B blocks; C (B's dependent) must NEVER run.
        if (id === "B") return blockedResult(id);
        merged.add(id);
        return okResult(id);
      },
    },
  );
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(ran, ["A", "B"]); // C was NOT attempted
  assert.ok(!ran.includes("C"), "the blocked task's dependent must not run");
  assert.match(s.resumeCommand, /^rmd drain/);
});

test("--max N halts after N successful tasks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B"]);
  assert.equal(s.attempted.length, 2);
});

test("headroom: a near-limit reading STOPS with reason=headroom_exhausted BEFORE spawning", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Monday" }],
  };
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => nearLimit,
    },
  );
  assert.equal(s.stopReason, "headroom_exhausted");
  assert.match(s.stopDetail ?? "", /weekly \(all models\) at 98% — resets Monday/);
  assert.equal(spawned, 0, "no task is spawned when a window is at/near its limit");
});

// W1-T290: this used to assert UNBOUNDED continuation on an unreadable read — the
// fail-open polarity the daemon's bounded-degraded ceiling was explicitly ported here
// to close. Retargeted to prove the BOUNDED allowance instead: 3 consecutive
// unreadable ticks (the default `UNREADABLE_DEGRADED_LIMIT`) still dispatch, every one
// of them, without the drain stopping early. The "beyond the allowance it stops"
// half of this same defect, the multi-lane parity, the consecutive-count reset, and
// the governor-disabled carve-out all live in test/drain-unreadable-degraded.test.ts.
test("headroom unreadable (undefined): WITHIN the bounded allowance the drain keeps dispatching", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: 3 }, // == the default UNREADABLE_DEGRADED_LIMIT: every tick is still within bounds.
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B", "C"]);
});

test("--until: drains until the target merges, then stops", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { until: "B", max: 10 },
  );
  assert.equal(s.stopReason, "until_reached");
  assert.deepEqual(s.merged, ["A", "B"]); // C, D not run
});

test("no_runnable: an empty/blocked-out plan stops cleanly", async () => {
  const plan = fixturePlan();
  const s = await runDrain(
    plan,
    { refreshMerged: () => mergedSetOf("A", "B", "C", "D"), runOne: async (id) => okResult(id) },
  );
  assert.equal(s.stopReason, "no_runnable"); // only H left (verify:human)
  assert.deepEqual(s.attempted, []);
});

// ── fleet control (W1-T11): STOP / Pause (drain-and-hold) / Resume ─────────

test("PAUSE (drain-and-hold): issued mid-run, the in-flight task still reaches merged; no new spawn follows", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "fleet-pause-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        // Simulate an operator pausing WHILE task A is in flight — the flag
        // appears mid-run, before A resolves.
        if (id === "A") requestPause(root, "quiet hours");
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
  );
  assert.equal(s.stopReason, "paused");
  // A was in flight when pause was requested — it still reaches merged (drain-and-hold).
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(s.attempted, ["A"]); // B (A's dependent) never spawns
  assert.ok(lines.some((l) => l.step === "drain.pause"), "a drain.pause ledger line was emitted");
});

test("STOP: kills within one tick — ledger stop line + no subsequent spawns", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        requestStop(root, "operator hard-stop");
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
  );
  assert.equal(s.stopReason, "stopped");
  assert.deepEqual(ran, ["A"]); // STOP is checked at the very next tick — no B/C/D spawn
  assert.ok(
    lines.some((l) => l.step === "drain.stop" && /operator hard-stop/.test(String(l.extra.detail))),
    "a drain.stop ledger line, carrying the reason, was emitted",
  );
});

test("STOP set BEFORE a drain even starts: zero tasks attempted (a fresh drain also refuses to spawn)", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-pre-"));
  requestStop(root, "pre-armed");
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
    },
  );
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0);
  assert.deepEqual(s.attempted, []);
});

test("STOP takes precedence over PAUSE when both flags are set", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "fleet-both-"));
  requestPause(root, "b");
  requestStop(root, "a");
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
    },
  );
  assert.equal(s.stopReason, "stopped");
});

// ── W1-T140: drain preview + curation panel ─────────────────────────────────

test("buildDrainPreview: renders plannedSequence's order as task cards, each carrying id/title/description + direct dependency edges both ways", () => {
  const plan = fixturePlan(); // A -> B -> C (chain, B carries a note), D independent, H human-only
  const cards = buildDrainPreview(plan, NONE_MERGED);

  assert.deepEqual(cards.map((c) => c.id), plannedSequence(plan, NONE_MERGED), "card order equals plannedSequence's order exactly");

  const [a, b, c, d] = cards;
  assert.equal(a.title, "a");
  assert.equal(a.description, "", "no note on A -> empty description, never undefined");
  assert.deepEqual(a.dependsOn, [], "A has no incoming edges");
  assert.deepEqual(a.dependents, [{ id: "B", title: "b" }], "A's only direct dependent is B");

  assert.equal(b.description, "b's rationale", "B's note surfaces as its card description");
  assert.deepEqual(b.dependsOn, [{ id: "A", title: "a" }]);
  assert.deepEqual(b.dependents, [{ id: "C", title: "c" }]);

  assert.deepEqual(c.dependsOn, [{ id: "B", title: "b" }]);
  assert.deepEqual(c.dependents, [], "nothing in the plan depends on C");

  assert.deepEqual(d.dependsOn, [], "D is independent");
  assert.deepEqual(d.dependents, [], "nothing depends on D either");
});

test("buildDrainPreview: honors --max/--until exactly like plannedSequence (it IS plannedSequence, resolved to cards)", () => {
  const plan = fixturePlan();
  assert.deepEqual(buildDrainPreview(plan, NONE_MERGED, { max: 2 }).map((c) => c.id), ["A", "B"]);
  assert.deepEqual(buildDrainPreview(plan, NONE_MERGED, { until: "B" }).map((c) => c.id), ["A", "B"]);
  assert.deepEqual(buildDrainPreview(plan, mergedSetOf("A", "B"), { until: "B" }), [], "--until already satisfied -> no cards");
});

// A dedicated 3-node chain (A -> B -> C, no independent siblings) so the curated-
// selection tests below match the acceptance bar's own language exactly: "natural
// order is [A, B, C]".
const CHAIN_ABC = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
`;

function chainAbcPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-curated-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, CHAIN_ABC);
  return loadPlan(f);
}

test("curated selection: [B, A] (depth 2) drives runOne to fire for exactly B then A, in that order — the natural order (A, B, C) is overridden entirely", async () => {
  const plan = chainAbcPlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C"], "sanity: the natural order is A, B, C");

  const selection: CuratedSelection = { taskIds: ["B", "A"], depth: 2 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
    },
    opts,
  );
  assert.deepEqual(ran, ["B", "A"], "runOne fired for exactly B then A, in the curated order");
  assert.equal(s.stopReason, "max_reached");
});

test("curated selection: unselected tasks are never dispatched — no runOne call, no ledger line, and the summary's attempted excludes them", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["B", "A"], depth: 2 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    opts,
  );
  assert.ok(!ran.includes("C"), "C was never passed to runOne — the falsifier: pre-fix drain ran the full plannedSequence, ignoring the selection");
  assert.ok(!s.attempted.includes("C"), "the drain summary's attempted excludes the unselected task");
  assert.ok(!lines.some((l) => l.extra.task === "C" || l.extra.id === "C"), "no ledger line names the unselected task");
  assert.deepEqual(s.attempted, ["B", "A"]);
});

test("curated selection: an id already merged or in-flight (open PR) is skipped, never re-dispatched, without derailing the rest of the curated order", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["A", "B", "C"], depth: 3 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const skips: Array<{ id: string; prNumber: number }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => mergedSetOf("A"), // A already landed before this drain started
      isOpenPr: (id) => (id === "B" ? 77 : undefined), // B is in-flight under an open PR
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
      log: (step, extra = {}) => {
        if (step === "dispatch.skipped") skips.push({ id: String(extra.task), prNumber: Number(extra.pr_number) });
      },
    },
    opts,
  );
  assert.deepEqual(ran, ["C"], "A is already merged (skipped) and B is in-flight (skipped) — only C actually dispatches");
  // The loop re-evaluates the curated list fresh every tick (same as the natural
  // path), so a still-open B is re-logged on each subsequent tick until the drain
  // concludes — assert every logged skip names B's open PR, never A or C.
  assert.ok(skips.length >= 1, "B's in-flight skip is legible on the ledger, same shape as the natural path's W1-T80 guard");
  assert.ok(skips.every((s) => s.id === "B" && s.prNumber === 77), "every skip logged names B's open PR #77 — never A or C");
});

test("P29(ii) curated selection: a circuit-broken id is skipped, never re-dispatched, without derailing the rest of the curated order", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["A", "B", "C"], depth: 3 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const broken: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
    },
    opts,
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched despite being first in the curated order");
  assert.ok(broken.length >= 1 && broken.every((id) => id === "A"), "onCircuitBreak fired only for A");
  assert.deepEqual(s.attempted.filter((id) => id !== "A"), ran.filter((id) => id !== "A"));
});

test("applyCuratedSelection: truncates to depth and caps max to the same bound, regardless of a larger caller-supplied max", () => {
  const opts = applyCuratedSelection({ max: 10, until: "C" }, { taskIds: ["B", "A", "D"], depth: 2 });
  assert.deepEqual(opts.curated, ["B", "A"]);
  assert.equal(opts.max, 2);
  assert.equal(opts.until, "C", "unrelated opts fields pass through untouched");
});

// ── W1-T141: post-drain rundown ─────────────────────────────────────────────

test("buildRundown: classifies every attempted task from a DrainSummary — merged tasks 'merged', the halting task 'blocked' carrying stopDetail when nothing escalated it", () => {
  const summary: DrainSummary = {
    attempted: ["A", "B", "C"],
    merged: ["A", "B"],
    stopReason: "blocked",
    stopDetail: "C → blocked_review (https://github.com/o/r/pull/9)",
    costUsd: 0.9,
    resumeCommand: "rmd drain",
  };
  assert.deepEqual(buildRundown(summary), [
    { taskId: "A", outcome: "merged" },
    { taskId: "B", outcome: "merged" },
    { taskId: "C", outcome: "blocked", detail: "C → blocked_review (https://github.com/o/r/pull/9)" },
  ]);
});

test("buildRundown: a halting task with an escalation.issue_opened ledger line classifies 'escalated', carrying the issue ref instead of stopDetail", () => {
  const summary: DrainSummary = {
    attempted: ["A", "B"],
    merged: ["A"],
    stopReason: "blocked",
    stopDetail: "B → blocked_review",
    costUsd: 0.5,
    resumeCommand: "rmd drain",
  };
  const ledgerLines = [{ step: "escalation.issue_opened", task_id: "B", issue_url: "https://github.com/o/r/issues/42", class: "BLOCKED" }];
  assert.deepEqual(buildRundown(summary, ledgerLines), [
    { taskId: "A", outcome: "merged" },
    { taskId: "B", outcome: "escalated", escalation: { issueUrl: "https://github.com/o/r/issues/42", class: "BLOCKED" } },
  ]);
});

test("buildRundown: an escalation.issue_opened line naming a DIFFERENT task never mislabels the halting task escalated (falsifier)", () => {
  const summary: DrainSummary = {
    attempted: ["A"],
    merged: [],
    stopReason: "blocked",
    stopDetail: "A → blocked_ci",
    costUsd: 0.1,
    resumeCommand: "rmd drain",
  };
  const ledgerLines = [{ step: "escalation.issue_opened", task_id: "Z", issue_url: "https://x/1", class: "MANUAL" }];
  assert.deepEqual(buildRundown(summary, ledgerLines), [{ taskId: "A", outcome: "blocked", detail: "A → blocked_ci" }]);
});

test("buildRundown: nothing attempted -> an empty rundown", () => {
  const summary: DrainSummary = { attempted: [], merged: [], stopReason: "no_runnable", costUsd: 0, resumeCommand: "rmd drain" };
  assert.deepEqual(buildRundown(summary), []);
});

test("renderRundown: one line per task — merged, blocked (with detail), escalated (with the issue ref)", () => {
  const text = renderRundown([
    { taskId: "A", outcome: "merged" },
    { taskId: "B", outcome: "blocked", detail: "B → blocked_review" },
    { taskId: "C", outcome: "escalated", escalation: { issueUrl: "https://github.com/o/r/issues/7", class: "BLOCKED" } },
  ]);
  assert.match(text, /merged {5}: A/);
  assert.match(text, /blocked {4}: B — B → blocked_review/);
  assert.match(text, /escalated {2}: C — \[BLOCKED\] https:\/\/github\.com\/o\/r\/issues\/7/);
});

test("renderRundown: no tasks attempted renders a clear empty state, not a blank block", () => {
  assert.match(renderRundown([]), /\(no tasks attempted\)/);
});

test("renderSummary + resumeCommand: 'what happened while away' is reconstructable", () => {
  const line = renderSummary({
    attempted: ["A", "B"], merged: ["A"], stopReason: "blocked",
    stopDetail: "B → blocked_review", costUsd: 0.8, resumeCommand: resumeCommand({ until: "C" }),
  });
  assert.match(line, /attempted : A, B/);
  assert.match(line, /merged    : A/);
  assert.match(line, /stopped   : blocked — B → blocked_review/);
  assert.match(line, /resume    : rmd drain --until C/);
});

// ── WHY THE DAEMON IS IDLE (impl-DF) ────────────────────────────────────────────────────────
//
// `isDispatchEligible` declined on FOUR conditions with no ledger line at all, so a ten-hour idle
// on 2026-08-01 emitted ~390 bare `daemon.idle` lines and ZERO `dispatch.*`. The record could not
// distinguish "starved of work" from "everything filtered", and neither could the operator.
// These lock the tally AND, above all, lock that eligibility itself did not move.

const IDLE_YAML = `- id: ELIGIBLE
  title: eligible
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: MERGED_ONE
  title: already merged
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: HUMAN_ONE
  title: human verify
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
- id: BLOCKED_ONE
  title: blocked
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
- id: DEPS_ONE
  title: unmet deps
  repo: remudero
  type: implement
  depends_on: [ELIGIBLE]
  status: queued
`;

function idlePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "idle-reasons-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, IDLE_YAML);
  return loadPlan(f);
}

test("idle reasons: each of the four formerly-silent conditions lands in its OWN bucket, with ids", () => {
  const plan = idlePlan();
  const tally = tallyDispatchFilters();
  const merged = mergedSetOf("MERGED_ONE");

  runnableCandidates(plan, merged, 99, { onFiltered: tally.onFiltered });
  const t = tally.snapshot();

  assert.deepEqual(t["already-merged"].ids, ["MERGED_ONE"]);
  assert.equal(t["already-merged"].count, 1);
  assert.deepEqual(t["verify-not-auto"].ids, ["HUMAN_ONE"]);
  assert.deepEqual(t.blocked.ids, ["BLOCKED_ONE"]);
  assert.deepEqual(t["unmet-deps"].ids, ["DEPS_ONE"]);
  // ELIGIBLE is in NO bucket -- it was not declined.
  const everyId = Object.values(t).flatMap((b) => b.ids);
  assert.ok(!everyId.includes("ELIGIBLE"), "an eligible task must never be tallied as declined");
});

test("idle reasons: the ELIGIBILITY SET is byte-identical with and without the tally wired", () => {
  // THE MOST IMPORTANT TEST IN THIS CHANGE. This is pure observability; if one task's
  // dispatchability moved, the PR is a behaviour change wearing an observability change's clothes.
  const plan = idlePlan();
  const merged = mergedSetOf("MERGED_ONE");

  const withoutTally = runnableCandidates(plan, merged, 99).map((t) => t.id);
  const withTally = runnableCandidates(plan, merged, 99, { onFiltered: tallyDispatchFilters().onFiltered }).map((t) => t.id);
  assert.deepEqual(withTally, withoutTally, "the candidate set must not move");
  assert.deepEqual(withoutTally, ["ELIGIBLE"], "and it is still exactly the one eligible task");

  // nextRunnable shares the same filter -- lock it too, both directions.
  assert.equal(nextRunnable(plan, merged)?.id, "ELIGIBLE");
  assert.equal(nextRunnable(plan, merged, { onFiltered: tallyDispatchFilters().onFiltered })?.id, "ELIGIBLE");
});

test("idle reasons: buckets are FIRST-MATCH — a task that is both merged and human counts once, under the condition that stopped it", () => {
  const plan = idlePlan();
  const tally = tallyDispatchFilters();
  // HUMAN_ONE is verify:human AND now also merged. `isMerged` is checked first.
  runnableCandidates(plan, mergedSetOf("HUMAN_ONE"), 99, { onFiltered: tally.onFiltered });
  const t = tally.snapshot();

  assert.deepEqual(t["already-merged"].ids, ["HUMAN_ONE"], "reported under the FIRST condition hit");
  assert.equal(t["verify-not-auto"].count, 0, "and NOT double-counted under the later one");
});

test("idle reasons: the id list is bounded and reports how many it truncated", () => {
  const many = Array.from({ length: 12 }, (_, i) => `- id: H${i}\n  title: h\n  repo: remudero\n  type: implement\n  verify: human\n  depends_on: []\n  status: queued\n`).join("");
  const dir = mkdtempSync(join(tmpdir(), "idle-cap-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, many);
  const plan = loadPlan(f);

  const tally = tallyDispatchFilters();
  runnableCandidates(plan, NONE_MERGED, 99, { onFiltered: tally.onFiltered });
  const b = tally.snapshot()["verify-not-auto"];

  assert.equal(b.count, 12, "the COUNT is complete");
  assert.equal(b.ids.length, IDLE_REASON_ID_CAP, "the ids are capped");
  assert.equal(b.truncated, 12 - IDLE_REASON_ID_CAP, "and the line says how many it did not name");
});

test("idle reasons: the signature is stable for an unchanged picture and moves when it changes", () => {
  // THE CADENCE LOCK. The daemon re-emits only when this differs; a stable signature is what
  // stops ~390 identical lines.
  const plan = idlePlan();
  const merged = mergedSetOf("MERGED_ONE");

  const a = tallyDispatchFilters();
  runnableCandidates(plan, merged, 99, { onFiltered: a.onFiltered });
  const b = tallyDispatchFilters();
  runnableCandidates(plan, merged, 99, { onFiltered: b.onFiltered });
  assert.equal(a.signature(), b.signature(), "an unchanged picture must NOT re-emit");

  const c = tallyDispatchFilters();
  runnableCandidates(plan, mergedSetOf("MERGED_ONE", "ELIGIBLE"), 99, { onFiltered: c.onFiltered });
  assert.notEqual(c.signature(), a.signature(), "a changed picture MUST emit");
});

// ── W1-T343: runDaemon ADOPTS drain's lane machinery (laneCount >= 2) ───────────────────────
// The daemon's tick loop, not runDrain — proving `runDaemon` reaches the SAME
// `runnableCandidates`/`partitionByFileOverlap` composition `runDrainLanes` already uses,
// never a second dispatch-set implementation for the persistent loop.

function twoDisjointFilesPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-lanes-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/b.ts]\n",
  );
  return loadPlan(f);
}

test("W1-T343 acceptance: runDaemon at laneCount 2 dispatches two DISJOINT-files tasks CONCURRENTLY through drain's existing lane machinery — both started before either resolves, and dispatch.concurrent_set names the co-dispatched pair", async () => {
  const merged = new Set<string>();
  const started: string[] = [];
  const deferreds = new Map<string, { resolve: (r: RunResult) => void }>();
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const runOne = (id: string) =>
    new Promise<RunResult>((resolve) => {
      started.push(id);
      deferreds.set(id, { resolve });
    });

  const daemonPromise = runDaemon(
    twoDisjointFilesPlan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 2, laneCount: 2 },
  );

  // Let the tick's synchronous dispatch-set construction (the `.map` that calls `runOne` for
  // every admitted lane) run before either lane's promise settles — the SAME idiom
  // test/parallel-dispatch.test.ts's own W1-T172 acceptance 1 uses for runDrainLanes.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["A", "B"], "both admitted lanes are started before either resolves — true concurrency, not a sequential tick");

  deferreds.get("A")!.resolve(okResult("A"));
  deferreds.get("B")!.resolve(okResult("B"));
  const s = await daemonPromise;
  assert.deepEqual(s.merged.sort(), ["A", "B"]);
  const concurrentSet = steps.find((l) => l.step === "dispatch.concurrent_set");
  assert.ok(concurrentSet, "the co-dispatched set is ledgered — the evidence trail P19's banked rung 2 needs");
  assert.deepEqual((concurrentSet!.extra as { tasks: string[] }).tasks.sort(), ["A", "B"]);
});

test("W1-T343 acceptance: runDaemon at laneCount 2 NEVER co-batches a file-overlapping pair, or a task declaring NO files at all (fail-closed) — each dispatches on its own later pass instead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-lanes-overlap-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: C\n  title: c\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: D\n  title: d\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
  const plan = loadPlan(f);
  const merged = new Set<string>();
  const ran: string[] = [];
  const concurrentSets: string[][] = [];
  const serialized: Array<{ task: string; blocked_by: string }> = [];
  let ticks = 0;
  const summary = await runDaemon(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 6 ? "tick cap" : undefined),
      log: (step: string, extra?: Record<string, unknown>) => {
        if (step === "dispatch.concurrent_set") concurrentSets.push((extra as { tasks: string[] }).tasks);
        if (step === "dispatch.serialized") serialized.push(extra as { task: string; blocked_by: string });
      },
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2 },
  );
  assert.equal(summary.merged.length, 3, "all three eventually dispatch — deferred, never dropped");
  assert.deepEqual(ran, ["A", "C", "D"], "each dispatches on its OWN pass, never co-batched with its collision");
  assert.equal(concurrentSets.length, 0, "no pass EVER held more than one of these three — each collided with the other two");
  const blockedIds = serialized.map((s) => s.task);
  assert.ok(blockedIds.includes("C"), "C (files: overlapping A's) was deferred at least once (dispatch.serialized)");
  assert.ok(blockedIds.includes("D"), "D (declares NO files: at all — fail-closed) was deferred at least once (dispatch.serialized)");
});

test("W1-T343: laneCount 2 with ZERO WIP headroom this tick ledgers dispatch.wip_deferred and dispatches NOTHING — distinct from an ordinary idle tick, since runnable work exists and is only held back", async () => {
  const merged = new Set<string>();
  const ran: string[] = [];
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  // == wipLimit ⇒ laneDispatchBudget({ laneCount: 2, wipLimit: 4, openPrCount: 4 }) === 0.
  let openCount = 4;
  let sleepCalls = 0;
  let ticks = 0;
  const summary = await runDaemon(
    twoDisjointFilesPlan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      openPrCount: () => openCount,
      checkStop: () => (++ticks > 5 ? "tick cap" : undefined),
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      sleep: async () => {
        sleepCalls++;
        // Headroom frees up between this deferred tick and the next — the SAME runnable work
        // (A, B) must dispatch then, proving the governor only HELD it back, never dropped it.
        if (sleepCalls === 1) openCount = 0;
      },
    } as unknown as DaemonDeps,
    { max: 2, laneCount: 2, wipLimit: 4 },
  );
  const deferred = steps.find((l) => l.step === "dispatch.wip_deferred");
  assert.ok(deferred, "the governor-sized-to-zero tick ledgers dispatch.wip_deferred");
  assert.deepEqual(deferred!.extra, { lane_count: 2, wip_limit: 4, observed_open_count: 4 });
  assert.deepEqual(ran.sort(), ["A", "B"], "once headroom frees up, the SAME runnable work dispatches");
  assert.deepEqual(summary.merged.sort(), ["A", "B"]);
});

// ── W1-T916 — THE SUPPLIER W1-T534 DECLARED AND NOBODY PASSED ────────────────────────────────
//
// WHY THESE ARE runDrain INTEGRATION TESTS AND NOT MORE nextRunnable UNITS. The W1-T534 tests
// above inject `hasPushedRunBranch` into `nextRunnable` by hand, and EVERY ONE OF THEM PASSED
// AGAINST THE BROKEN PRODUCTION WIRING — because they supplied precisely what production omitted.
// A test of that shape cannot see this defect at all. These drive `runDrain` with the real
// `DrainDeps` and assert the argument REACHES the predicate, which is the only thing that was
// ever missing.
//
// The failure mode is why it survived review: `opts.hasPushedRunBranch?.(t.id)` short-circuits to
// `undefined` when unsupplied, which is falsy, so the guard silently never fired; and the field is
// optional, so omitting it is legal at type-check. Nothing raised, nothing failed, nothing warned.

/** Raw `git ls-remote --heads origin 'run-*'` output naming exactly the given task ids. */
function lsRemoteRunBranches(...taskIds: string[]): string {
  return taskIds.map((id, i) => `${"abc123def456"}${i}\trefs/heads/run-${id}-178688648869${i}`).join("\n");
}

test("W1-T916: the real dispatch options carry a pushed-branch supplier", async () => {
  // THE ONE TEST THAT COULD HAVE CAUGHT THIS. It does not build DrainDeps itself — it drives the
  // PRODUCTION construction in `drainCommand` and captures what that passes. Every other test in
  // this file supplies the dep by hand, which is exactly why none of them saw the defect: the
  // predicate was always fine, the argument was never sent.
  const root = mkdtempSync(join(tmpdir(), "w1t916-supplier-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const planDir = mkdtempSync(join(tmpdir(), "w1t916-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T916F\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let captured: DrainDeps | undefined;
  try {
    // `runDrain` is injected so the loop never runs — a wiring test must not be able to spawn a
    // worker against a nonexistent claudeBin.
    await drainCommand([], {
      config: { claudeBin: "/nonexistent/claude-not-installed", root } as Config,
      planPath,
      skipGitSync: true,
      notifyChannel: { send: () => true } as never,
      runDrain: async (_plan: Plan, deps: DrainDeps): Promise<DrainSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
      },
    });
    assert.ok(captured, "runDrain was reached and its DrainDeps captured");
    assert.equal(
      typeof captured.readPushedRunBranches,
      "function",
      "FALSIFIER: this is the assertion that fails if the supplier is dropped from drainCommand again",
    );
    // And it must actually return ls-remote-shaped output the parser can consume, not merely exist.
    const parsed = runBranchTaskIds(captured.readPushedRunBranches!());
    assert.ok(parsed instanceof Set, "the reader's output is what runBranchTaskIds parses");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("W1-T916: a task with a pushed run branch is refused a second dispatch", async () => {
  const plan = fixturePlan();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => () => false,
      // isOpenPr deliberately omitted — the cached projection is blind to a branch pushed ahead of
      // its PR, which is exactly the window this guard closes.
      readPushedRunBranches: () => lsRemoteRunBranches("A"),
      runOne: async (id) => {
        ran.push(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "the duplicate build never started");
  assert.deepEqual(ran, ["D"], "D is the next runnable candidate once A is refused");
  const skip = lines.find((l) => l.step === "dispatch.skipped" && l.extra.reason === "run-branch-already-pushed");
  assert.ok(skip, "the refusal rides the EXISTING dispatch.skipped row — no new step was minted");
  assert.equal(skip?.extra.task, "A");
  assert.ok(
    !lines.some((l) => l.step === "dispatch.stood_down"),
    "and never dispatch.stood_down, which has three emitters and no reader",
  );
});

test("W1-T916: dropping the supplier lets the same task dispatch", async () => {
  // THE FALSIFIER. Byte-identical to the test above except that `readPushedRunBranches` is gone.
  // If this dispatched A in both cases the guard would be inert; if it refused A in both the test
  // would be asserting nothing about the wiring. Only the pair discriminates.
  const plan = fixturePlan();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => () => false,
      // readPushedRunBranches deliberately omitted — this IS production before this change.
      runOne: async (id) => {
        ran.push(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.deepEqual(ran, ["A"], "with no supplier the guard cannot fire and the duplicate build starts");
  assert.ok(
    !lines.some((l) => l.extra.reason === "run-branch-already-pushed"),
    "and no refusal is recorded, because nothing was ever asked",
  );
});

test("W1-T916: a refused task stays eligible and burns no strike", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  // Pass 1: A's branch is on origin, so A is refused.
  await runDrain(
    plan,
    {
      refreshMerged: () => () => false,
      readPushedRunBranches: () => lsRemoteRunBranches("A"),
      runOne: async (id) => okResult(id),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(
    !lines.some((l) => l.step === "dispatch.circuit_broken" || l.step === "dispatch.stood_down"),
    "a refusal is a SKIP — it escalates nothing and trips no breaker",
  );
  // Pass 2, same plan, branch now gone: A is offered again. A terminal state would have kept it
  // out; a skip does not.
  const ran2: string[] = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => () => false,
      readPushedRunBranches: () => "",
      runOne: async (id) => {
        ran2.push(id);
        return okResult(id);
      },
      log: () => {},
    },
    { max: 1 },
  );
  assert.deepEqual(ran2, ["A"], "once the branch is gone the task is dispatched — it was never marked done");
});

test("W1-T916: the ref reader fails open so a git outage never blocks dispatch", () => {
  // BOTH ARMS. The happy path returns the raw output verbatim for `runBranchTaskIds` to parse; the
  // throw path returns "" — an EMPTY set — so nothing is refused. That direction is deliberate: a
  // guard deciding whether work starts at all must degrade to "no improvement", never to "dispatch
  // wrongly blocked". The catch arm is unreachable without this injected exec, which is the same
  // class of gap — a seam nothing supplied — that this whole task exists to close.
  const raw = "abc\trefs/heads/run-W1-T916-1786886488695";
  assert.equal(readPushedRunBranchesOutput(() => raw), raw, "the happy path returns output verbatim");
  assert.deepEqual([...runBranchTaskIds(readPushedRunBranchesOutput(() => raw))], ["W1-T916"]);
  const thrown = readPushedRunBranchesOutput(() => {
    throw new Error("ls-remote: could not read from remote repository");
  });
  assert.equal(thrown, "", "a throw yields empty output");
  assert.equal(runBranchTaskIds(thrown).size, 0, "which parses to an empty set — nothing is refused");
});

test("W1-T916: the lane dispatch path refuses a pushed run branch too", async () => {
  // runDrainLanes is a SEPARATE pass loop from runDrain's, with its own options object. Wiring one
  // and not the other would leave the guard inert on exactly the path the daemon uses under
  // concurrency, and no single-lane test would notice.
  const plan = fixturePlan();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => () => false,
      readPushedRunBranches: () => lsRemoteRunBranches("A"),
      runOne: async (id) => {
        ran.push(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1, laneCount: 2 },
  );
  assert.ok(!ran.includes("A"), "A is refused on the LANES path as well as the single-lane one");
  const skip = lines.find((l) => l.extra.reason === "run-branch-already-pushed");
  assert.ok(skip, "and the same existing dispatch.skipped row carries it");
  assert.equal(skip?.extra.task, "A");
});

test("W1-T916: the daemon dispatch path carries the same supplier", async () => {
  // The daemon builds its OWN NextRunnableOpts and calls nextRunnable directly, so drainCommand
  // being wired proves nothing about it. Wiring one loop and not the other would leave the guard
  // inert on the path that actually runs in production.
  const plan = fixturePlan();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      readPushedRunBranches: () => lsRemoteRunBranches("A"),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
      sleep: async () => {},
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A carries a pushed run branch and the daemon refuses it too");
  const skip = lines.find((l) => l.extra.reason === "run-branch-already-pushed");
  assert.ok(skip, "riding the same existing dispatch.skipped row, not a new step");
  assert.equal(skip?.extra.task, "A");
});
