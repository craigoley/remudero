/**
 * test/arm-auto-merge.test.ts — W1-T2887.
 *
 * The auto-merge arm cluster (`armAutoMerge`, `armAutoMergeDetailed`, `attemptArm`,
 * `armAutoMergeAtOpen`, `disarmAutoMerge`, `armIfVerdictPermits`, `realArmDeps` and their
 * classifiers) moved from `src/run-task.ts` to `src/lib/arm-auto-merge.ts` — the effectful half
 * of one seam whose pure half (`decideAutoMergeArm`) already lived in `src/lib/review.ts`.
 *
 * This file drives `armAutoMerge` — imported DIRECTLY from the new lib module, not the
 * `run-task.js` re-export — through a REAL ledger file (the same `appendLedger`/`readLedgerLines`
 * pair production uses) and a RECORDING `ArmDeps`, and asserts both the gh-shaped calls the
 * recorder captured and the ledger rows `logArmAttribution`/`armIfVerdictPermits` write. Same
 * fixture shape as the pre-move `test/arm-ordering.test.ts`, so "arming through the lib module
 * issues the same gh calls and ledger rows as before the move" is a like-for-like comparison, not
 * a new behavioural claim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  armAutoMerge,
  armIfVerdictPermits,
  attemptArm,
  disarmAutoMerge,
  fixRebaseMergeFactsFromRest,
  ghUpdateBranch,
  readHeadShaRest,
  type ArmDeps,
} from "../src/lib/arm-auto-merge.js";

const HEAD = "5596ab04802a916c740858e75bc950774d38c504";
const PR = "https://github.com/craigoley/remudero/pull/2887";
const TASK_ID = "W1-T2887";

/** A real ledger file on disk plus a RECORDING ArmDeps — the same harness shape
 *  test/arm-ordering.test.ts already drives the pre-move cluster through. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-arm-auto-merge-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const said: string[] = [];
  const ghCalls: Array<{ verb: "armAuto" | "mergeDirect" | "disableAuto"; prUrl: string }> = [];

  const log = (step: string, extra: Record<string, unknown> = {}) => {
    appendLedger(ledgerPath, { run_id: "arm-auto-merge-test", task_id: TASK_ID, step, ...extra });
  };
  const writeReviewPosted = (state: "success" | "failure" = "success", headSha = HEAD) =>
    log("review.posted", { context: "remudero-review", state, head_sha: headSha });

  const armDeps: ArmDeps = {
    headSha: () => HEAD,
    ledgerLines: () => readLedgerLines(ledgerPath),
    armAuto: (prUrl) => void ghCalls.push({ verb: "armAuto", prUrl }),
    mergeDirect: (prUrl) => void ghCalls.push({ verb: "mergeDirect", prUrl }),
    disableAuto: (prUrl) => void ghCalls.push({ verb: "disableAuto", prUrl }),
    say: (m) => void said.push(m),
  };

  return {
    dir,
    ledgerPath,
    said,
    ghCalls,
    writeReviewPosted,
    ledgerRows: () => readLedgerLines(ledgerPath),
    log,
    armDeps,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("armAutoMerge, driven through the lib module directly: a PASSING ledgered verdict issues the SAME gh armAuto call it always did", () => {
  const h = harness();
  h.writeReviewPosted("success");

  const outcome = armAutoMerge(PR, TASK_ID, h.armDeps);

  assert.equal(outcome, "armed", "the W1-T230 ledger gate reads the review.posted row and permits arming");
  assert.deepEqual(h.ghCalls, [{ verb: "armAuto", prUrl: PR }], "exactly one gh armAuto call, for this PR, and no other gh verb");
  h.cleanup();
});

test("armAutoMerge fails closed with NO gh call when no review.posted row exists for this task/head", () => {
  const h = harness();

  const outcome = armAutoMerge(PR, TASK_ID, h.armDeps);

  assert.equal(outcome, "ledger-refused");
  assert.deepEqual(h.ghCalls, [], "no gh call may be issued for a head with no ledgered verdict");
  h.cleanup();
});

test("armAutoMerge fails closed with NO gh call when the ledgered verdict is for a DIFFERENT head (a push after the verdict)", () => {
  const h = harness();
  h.writeReviewPosted("success", "0000000deadbeef0000000deadbeef0000000dead");

  const outcome = armAutoMerge(PR, TASK_ID, h.armDeps);

  assert.equal(outcome, "ledger-refused");
  assert.deepEqual(h.ghCalls, [], "a stale verdict must not arm the current head");
  h.cleanup();
});

test("armAutoMerge with no task id refuses before any ledger read, issuing no gh call", () => {
  const h = harness();
  h.writeReviewPosted("success");

  const outcome = armAutoMerge(PR, undefined, h.armDeps);

  assert.equal(outcome, "no-task-id");
  assert.deepEqual(h.ghCalls, []);
  h.cleanup();
});

// ── the entry point IS exercised through the lib module — armAutoMerge( above proves it; this
// test additionally proves the LEDGER ROW it produces, via armIfVerdictPermits (the review-lane
// caller every existing arm-ordering/arm-outcome-five-sites test already exercises the same way).
test("armIfVerdictPermits, wired to armAutoMerge, writes the SAME automerge.armed ledger row the pre-move cluster wrote", () => {
  const h = harness();
  h.writeReviewPosted("success");

  const outcome = armIfVerdictPermits(
    { state: "success", capped: false, planOnly: false },
    { prUrl: PR, taskId: TASK_ID, headSha: HEAD, ledgerPath: h.ledgerPath, log: h.log },
    { arm: (prUrl, taskId) => armAutoMerge(prUrl, taskId, h.armDeps) },
  );

  assert.equal(outcome, "armed");
  assert.deepEqual(h.ghCalls, [{ verb: "armAuto", prUrl: PR }]);
  const row = h.ledgerRows().find((l) => l.step === "automerge.armed");
  assert.ok(row, "the arm is ledgered under automerge.armed, not merely returned");
  assert.equal(row?.task_id, TASK_ID);
  assert.equal(row?.pr_url, PR);
  assert.equal(row?.lane, "review");
  h.cleanup();
});

test("armIfVerdictPermits writes automerge.arm_skipped, never automerge.armed, when the semantic gate refuses — and issues no gh call", () => {
  const h = harness();
  h.writeReviewPosted("failure");

  const outcome = armIfVerdictPermits(
    { state: "failure", capped: false, planOnly: false },
    { prUrl: PR, taskId: TASK_ID, headSha: HEAD, ledgerPath: h.ledgerPath, log: h.log },
    { arm: (prUrl, taskId) => armAutoMerge(prUrl, taskId, h.armDeps) },
  );

  assert.equal(outcome, "skipped");
  assert.deepEqual(h.ghCalls, []);
  assert.deepEqual(h.ledgerRows().filter((l) => l.step === "automerge.armed"), []);
  assert.ok(h.ledgerRows().some((l) => l.step === "automerge.arm_skipped"));
  h.cleanup();
});

test("disarmAutoMerge, driven through the lib module directly, issues the SAME gh disableAuto call and reports the withdrawal", () => {
  const h = harness();

  const outcome = disarmAutoMerge(PR, { disableAuto: h.armDeps.disableAuto, say: h.armDeps.say });

  assert.equal(outcome, "disarmed");
  assert.deepEqual(h.ghCalls, [{ verb: "disableAuto", prUrl: PR }]);
  h.cleanup();
});

// ── W1-T2887 round 1: the three PRIVATE REST mirrors realArmDeps() wires with no injectable
// fetch/exec of their own — see this module's own header comment for why they are duplicates
// rather than imports. Each is exported for exactly this reason: their fail-soft/fail-loud
// branches are otherwise unreachable from a test, since realArmDeps()'s closures never forward an
// override to them (they always call the module-default `ghJson`/`execFileSync`).

test("fixRebaseMergeFactsFromRest fails soft to {} when the REST fetch throws — readMergeFacts must degrade, never crash, on an unreadable read", () => {
  const facts = fixRebaseMergeFactsFromRest("craigoley", "remudero", 2887, () => {
    throw new Error("simulated REST outage");
  });

  assert.deepEqual(facts, {}, "an unreadable pr/compare read must yield no facts, not a thrown error");
});

test("ghUpdateBranch reports ok:false with the caught error text when the update-branch exec throws", () => {
  const result = withLiveWritesAllowed(() =>
    ghUpdateBranch("craigoley", "remudero", 2887, () => {
      throw new Error("simulated gh api failure");
    }),
  );

  assert.deepEqual(result, { ok: false, error: "simulated gh api failure" });
});

test("readHeadShaRest refuses an empty head sha rather than reporting one", () => {
  assert.throws(() => readHeadShaRest(PR, () => ({ head: {} })), /returned no head sha/);
});

test("attemptArm's direct-merge-preflight update-branch write: a throwing updateBranch is caught and reported as direct-merge-update-failed, never an uncaught throw", () => {
  const said: string[] = [];
  const ghCalls: Array<{ verb: string; prUrl: string }> = [];
  const result = attemptArm(PR, {
    armAuto: () => {
      throw { stderr: "Pull request is in clean status" };
    },
    mergeDirect: (prUrl) => void ghCalls.push({ verb: "mergeDirect", prUrl }),
    isMerged: () => false,
    say: (m) => void said.push(m),
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 3 }),
    updateBranch: () => {
      throw new Error("simulated update-branch outage");
    },
  });

  assert.equal(result.outcome, "direct-merge-update-failed");
  assert.deepEqual(ghCalls, [], "an updateBranch that throws must never fall through to mergeDirect");
  assert.equal(result.directMergePreflight?.error, "simulated update-branch outage");
  assert.ok(said.some((m) => m.includes("automerge.direct_merge_update_failed")));
});
