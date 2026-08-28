/**
 * W1-T2446: `decideDispatchClaimRelease`'s EVIDENCE arm (dispatch-claim.ts) is reachable in the
 * one case it was written for -- a dispatch claim whose task is credited MERGED.
 *
 * THE DEFECT. The evidence arm fired only where `claimReserver` was already in scope: the CAS
 * contention site 300 lines into `runTask` (`claimOutcome === "taken"`, run-task.ts). But the
 * ALREADY-MERGED guard (`if (isMerged(task))`, run-task.ts, ~300 lines EARLIER) returns
 * `task_already_merged` before that site is ever reached -- so a merged task's dispatch never
 * got far enough to drop its own stale claim. W1-T2424's claim survived its own merge until an
 * operator ran `git push origin :refs/rmd-dispatch/W1-T2424` by hand.
 *
 * THE FIX. The already-merged guard now hoists ONE reserver read + conditional drop, reusing
 * `isMerged(task)` (already computed) and `releaseDispatchClaim` (unchanged, unmodified) -- no
 * new probe, no new decision function, no timer. `status-board.ts`'s held-claim row is also
 * corrected: it asserted "no landed work observed" for EVERY held claim, unconditionally, even
 * one whose task was already merged; it now consults the same merge-credit projection every
 * other DERIVED section on the board already threads through.
 *
 * FOUR CLAIMS, FOUR TESTS BELOW:
 *   1. a claim whose task is credited merged is released without an operator
 *   2. a claim on a task that is not credited merged is never dropped automatically
 *   3. no wall-clock expiry and no pacing is introduced on any path
 *   4. the board no longer asserts "no landed work observed" without checking
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import { dispatchClaimRef, type DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import { buildStatusBoard, type StatusBoardDeps } from "../src/lib/status-board.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────

const MERGED_PR_URL = "https://github.com/acme/remudero/pull/777";

/** A GitHub gateway crediting exactly `mergedTaskId` merged, via the same
 *  trailer+head-ref+body ownership shape `run-task.test.ts`'s own `mergedGithubFixture`
 *  drives -- the real `deriveStatus` rung (c) ownership-assert requires all three. */
function mergedGithubFixture(mergedTaskId: string): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => (taskId === mergedTaskId ? { number: 777, url: MERGED_PR_URL, state: "MERGED" } : null),
    headRefName: (url) => (url === MERGED_PR_URL ? `run-${mergedTaskId}-1700000000000` : undefined),
    prBody: (url) => (url === MERGED_PR_URL ? `REPORT\n\nRemudero-Task: ${mergedTaskId}\n` : undefined),
  };
}

/** A GitHub gateway that credits nothing merged, ever -- the ordinary "no evidence" shape. */
function unmergedGithubFixture(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function fixtureRoot(planYaml: string): { root: string; planPath: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "dispatch-claim-evidence-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, planYaml);
  return { root, planPath, config: { claudeBin: "/bin/true", root } };
}

function readLedgerLinesFor(root: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  } catch {
    return []; // a run that threw before its first log() line never created the file
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** A `DispatchClaimReserver` that never touches git -- every call is recorded so a test can
 *  assert exactly what the new merged-guard release DID and DID NOT do. */
function fakeReserver(holderSha: string | undefined): DispatchClaimReserver & {
  holderCalls: string[];
  dropCalls: Array<{ taskId: string; opts?: { expect?: string } }>;
  attemptCalls: string[];
} {
  const holderCalls: string[] = [];
  const dropCalls: Array<{ taskId: string; opts?: { expect?: string } }> = [];
  const attemptCalls: string[] = [];
  return {
    holderCalls,
    dropCalls,
    attemptCalls,
    mintAnchor: () => "test-anchor",
    attempt: (taskId) => {
      attemptCalls.push(taskId);
      return "created";
    },
    holder: (taskId) => {
      holderCalls.push(taskId);
      return holderSha;
    },
    drop: (taskId, opts) => {
      dropCalls.push({ taskId, opts });
      return true;
    },
  };
}

// ── claim 1: a claim whose task is credited merged is released without an operator ─────────────

test("W1-T2446 ACCEPTANCE 1: a stale claim on an already-merged task is dropped through the evidence arm, with no operator involved", async () => {
  const planYaml = [
    "- id: T-MERGED-CLAIM",
    "  title: already-merged task whose claim never got dropped",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  depends_on: []",
    "  status: queued",
    "",
  ].join("\n");
  const { root, planPath, config } = fixtureRoot(planYaml);
  const github = mergedGithubFixture("T-MERGED-CLAIM");
  const reserver = fakeReserver("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"); // a claim IS held

  try {
    const res = await runTask("T-MERGED-CLAIM", { skipGitSync: true, planPath, config, github, claimReserver: reserver });

    assert.equal(res.verdict, "task_already_merged");

    // The reserver was read, and the held claim was dropped -- automatically, no `attempt`
    // (this run never took the claim itself) and no human ran `git push origin :<ref>`.
    assert.deepEqual(reserver.holderCalls, ["T-MERGED-CLAIM"]);
    assert.equal(reserver.attemptCalls.length, 0, "this run never attempted the CAS -- it only released what was already stale");
    assert.equal(reserver.dropCalls.length, 1);
    assert.equal(reserver.dropCalls[0]!.taskId, "T-MERGED-CLAIM");

    const released = readLedgerLinesFor(root).filter((l) => l.step === "dispatch.claim_released");
    assert.equal(released.length, 1);
    assert.equal(released[0]!.ref, dispatchClaimRef("T-MERGED-CLAIM"));
    assert.equal(released[0]!.arm, "evidence");
    assert.equal(released[0]!.release, true);
    assert.equal(released[0]!.dropped, true);
    assert.match(String(released[0]!.reason), /any host may drop it/, "the evidence arm's own reason, unedited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2446: a merged task with NO held claim reads the reserver but drops nothing (nothing to release)", async () => {
  const planYaml = [
    "- id: T-MERGED-NOCLAIM",
    "  title: already-merged task with no claim ever taken",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  depends_on: []",
    "  status: queued",
    "",
  ].join("\n");
  const { root, planPath, config } = fixtureRoot(planYaml);
  const github = mergedGithubFixture("T-MERGED-NOCLAIM");
  const reserver = fakeReserver(undefined); // no claim held

  try {
    const res = await runTask("T-MERGED-NOCLAIM", { skipGitSync: true, planPath, config, github, claimReserver: reserver });
    assert.equal(res.verdict, "task_already_merged");
    assert.deepEqual(reserver.holderCalls, ["T-MERGED-NOCLAIM"]);
    assert.equal(reserver.dropCalls.length, 0, "nothing was held, so nothing was dropped");
    assert.equal(readLedgerLinesFor(root).filter((l) => l.step === "dispatch.claim_released").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── claim 2: a claim on a task that is not credited merged is never dropped automatically ──────

test("W1-T2446 ACCEPTANCE 2: a claim on a NOT-merged task is never touched by the merged-guard release -- the guard never even runs", async () => {
  const planYaml = [
    "- id: T-DEP",
    "  title: unmet dependency, never merged",
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  status: queued",
    "- id: T-NOT-MERGED",
    "  title: not merged, with an unmet dependency so assertRunnable throws before real dispatch",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  depends_on: [T-DEP]",
    "  status: queued",
    "",
  ].join("\n");
  const { root, planPath, config } = fixtureRoot(planYaml);
  const github = unmergedGithubFixture(); // credits NEITHER task merged
  const reserver = fakeReserver("livesha00livesha00livesha00livesha00live0"); // a claim IS held

  try {
    // `T-DEP` is unmerged, so `assertRunnable` throws (a PlanError, uncaught) -- the SAME
    // short-circuit W1-T319's own dependency test exercises. This proves the reserver is
    // reached ONLY through `isMerged(task)`, never unconditionally.
    await assert.rejects(() => runTask("T-NOT-MERGED", { skipGitSync: true, planPath, config, github, claimReserver: reserver }));

    assert.equal(reserver.holderCalls.length, 0, "a not-merged task's claim is never even read by this guard");
    assert.equal(reserver.dropCalls.length, 0, "and so never dropped");
    assert.equal(readLedgerLinesFor(root).filter((l) => l.step === "dispatch.claim_released").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── claim 3: no wall-clock expiry and no pacing is introduced on any path ──────────────────────

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const dispatchClaimSrc = readFileSync(fileURLToPath(new URL("../src/lib/dispatch-claim.ts", import.meta.url)), "utf8");

test("W1-T2446 ACCEPTANCE 3: the hoisted release reuses releaseDispatchClaim verbatim and introduces no clock read of any kind", () => {
  const markerStart = runTaskSrc.indexOf("W1-T2446: EVIDENCE ARM, HOISTED HERE");
  assert.notEqual(markerStart, -1, "the new merged-guard release block is present");
  const blockEnd = runTaskSrc.indexOf('verdict: "task_already_merged" };', markerStart);
  assert.notEqual(blockEnd, -1);
  const block = runTaskSrc.slice(markerStart, blockEnd);

  // Reuses the EXISTING pure decision/apply function -- no bespoke drop logic invented here.
  assert.match(block, /releaseDispatchClaim\(/);
  assert.match(block, /evidenceObserved:\s*true/);

  // NO timer, NO clock, NO pacing knob anywhere in the new block.
  for (const forbidden of ["Date.now", "new Date(", "setTimeout", "setInterval", "ageMs", "clockBound", "expiresAt", "expiryMs"]) {
    assert.ok(!block.includes(forbidden), `new release block must not reference ${forbidden}`);
  }
});

test("W1-T2446: decideDispatchClaimRelease itself still takes no clock input -- three arms, no timer, unmodified by this task", () => {
  const fnStart = dispatchClaimSrc.indexOf("export function decideDispatchClaimRelease(");
  assert.notEqual(fnStart, -1);
  const fnEnd = dispatchClaimSrc.indexOf("\n}", fnStart);
  const fn = dispatchClaimSrc.slice(fnStart, fnEnd);
  assert.match(fn, /heldByThisRun: boolean; evidenceObserved: boolean; taskId: string/, "the parameter shape is unchanged -- no time field added");
  for (const forbidden of ["Date.now", "new Date(", "setTimeout", "setInterval", "ageMs", "expiresAt", "expiryMs"]) {
    assert.ok(!fn.includes(forbidden), `decideDispatchClaimRelease must not reference ${forbidden}`);
  }
});

// ── claim 4: the board no longer asserts "no landed work observed" without checking ────────────

function boardDeps(overrides: Partial<StatusBoardDeps>): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    readSharedPauseState: () => "absent",
    ...overrides,
  } as StatusBoardDeps;
}

function singleTaskPlan(id: string): Plan {
  return loadPlanFromYaml(
    ["- id: " + id, "  title: single task", "  repo: remudero", "  type: implement", "  verify: auto", "  depends_on: []", "  status: queued", ""].join(
      "\n",
    ),
    "fixture",
  );
}

test("W1-T2446 ACCEPTANCE 4a: a held claim on a CREDITED-MERGED task no longer says 'no landed work observed'", () => {
  const held = { status: "held" as const, claims: [{ taskId: "W1-T9001", holder: "sha-merged-9001" }] };
  const model = buildStatusBoard(
    mkdtempSync(join(tmpdir(), "status-board-evidence-")),
    join(tmpdir(), "no-such-ledger.ndjson"),
    boardDeps({ plan: singleTaskPlan("W1-T9001"), github: mergedGithubFixture("W1-T9001"), readDispatchClaims: () => held }),
  );
  const row = model.latches.rows.find((r) => r.name === "dispatch-claim:W1-T9001");
  assert.ok(row, "the held claim still renders a row");
  assert.doesNotMatch(row!.consequence, /no landed work observed/, "no longer asserted for a task actually credited merged");
  assert.match(row!.consequence, /credited MERGED/i);
  assert.ok(row!.consequence.includes(dispatchClaimRef("W1-T9001")), "the ref itself is still named");
  assert.match(row!.consequence, /git push origin :/, "the operator remedy still stands -- the board still only reports");
});

test("W1-T2446 ACCEPTANCE 4b: a held claim on a task that is NOT credited merged still says so -- regression guard, unchanged wording", () => {
  const held = { status: "held" as const, claims: [{ taskId: "W1-T9002", holder: "sha-live-9002" }] };
  const model = buildStatusBoard(
    mkdtempSync(join(tmpdir(), "status-board-evidence-")),
    join(tmpdir(), "no-such-ledger.ndjson"),
    boardDeps({ plan: singleTaskPlan("W1-T9002"), github: unmergedGithubFixture(), readDispatchClaims: () => held }),
  );
  const row = model.latches.rows.find((r) => r.name === "dispatch-claim:W1-T9002");
  assert.ok(row);
  assert.match(row!.consequence, /no landed work observed/, "still honest for a claim with no merge credit");
  assert.doesNotMatch(row!.consequence, /credited MERGED/i);
});

test("W1-T2446: with no plan/github supplied at all (today's every other caller), the held-claim row keeps its EXACT prior wording", () => {
  const held = { status: "held" as const, claims: [{ taskId: "W1-T9003", holder: "sha-unknown-9003" }] };
  const model = buildStatusBoard(
    mkdtempSync(join(tmpdir(), "status-board-evidence-")),
    join(tmpdir(), "no-such-ledger.ndjson"),
    boardDeps({ readDispatchClaims: () => held }),
  );
  const row = model.latches.rows.find((r) => r.name === "dispatch-claim:W1-T9003");
  assert.ok(row);
  assert.equal(
    row!.consequence,
    "W1-T9003's dispatch claim refs/rmd-dispatch/W1-T9003 is held (holder sha-unknown-9003) with no landed work observed — " +
      "a new dispatch of W1-T9003 is refused until an operator drops it: git push origin :refs/rmd-dispatch/W1-T9003",
  );
});
