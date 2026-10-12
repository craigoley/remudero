// test/a-detached-fix-dispatch-that-throws-before-fix-dispatch-is-not-dispatched.test.ts — W1-T5932.
//
// LIVE 2026-10-05: #9379 (W1-T5882, head 9c0fa1b) read "fix already dispatched for this head" from
// 22:53Z to 23:58Z with no fix.* row. Production dispatches with `detachFixWait`, so runSweep writes the
// acted:true `sweep.disposed` row before `dispatchFix` settles, and a throw before `fix.dispatch` was
// swallowed by `detachSweepAction`; W1-T1127's acted:false path never fired, and `prior.fixed` deduped
// the head with no worker. A detached rejection now writes `sweep.fix.dispatch_failed`, which voids the
// dedup by W1-T5919's rule, and FIX_DISPATCH_FAILED_BACKSTOP failures on one head escalate once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIX_CLAIM_DECLINE_BACKSTOP,
  FIX_DISPATCH_FAILED_BACKSTOP,
  drainDetachedSweepActions,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-05T23:00:00Z");
const RECENT = "2026-10-05T22:00:00Z";
const PR = 9379;
const TASK = "W1-T5882";
const HEAD = "9c0fa1b0aa";
const NEW_HEAD = "f00dfacecc";
const BRANCH = "run-W1-T5882-1791200000000";
const ERROR = "Command failed: git checkout -B run-W1-T5882 (.git/config.lock exists)";
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const DEDUPED = /fix already dispatched for this head/;
const FAILED_STEP = "sweep.fix.dispatch_failed";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: TASK,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: UNMET,
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: HEAD,
    headRefName: BRANCH,
    autoMergeArmed: false,
    ...over,
  };
}

function conflictedView(): OpenPrView {
  return view({
    reviewState: "success",
    unmetCriteria: [],
    mergeState: "dirty",
    mergeConflict: {
      files: [{ path: "src/a.ts", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "9c0fa1b ours",
      theirsLog: "f15dff6 theirs",
    },
  });
}

function disposed(head: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "sweep.disposed", acted: true, pr_number: PR, head_sha: head, disposition: "blocked-fixable", ...extra };
}

function failed(head: string, error = ERROR): Record<string, unknown> {
  return { step: FAILED_STEP, task_id: TASK, pr_number: PR, head_sha: head, error };
}

function decline(head: string): Record<string, unknown> {
  return {
    step: "sweep.fix.checkout_claim_declined",
    task_id: TASK,
    reason: "registered_worktree_owner",
    owner_recovery_reason: "owner_remove_failed",
    pr_number: PR,
    head_sha: head,
  };
}

const realDispatch = (head: string) => ({ step: "fix.dispatch", task_id: TASK, head_sha: head });
/** #9379's shape: the task's EARLIER head's dispatch keeps W1-T1210's no-dispatch re-arm from firing. */
const EARLIER = realDispatch("81c30d80bb");

type Pass = { row: Record<string, unknown>; rows: Array<Record<string, unknown>>; dispatched: number; escalations: string[]; ledgerPath: string };

async function pass(
  pr: OpenPrView,
  seed: Array<Record<string, unknown>>,
  over: Partial<SweepDeps> & { ledgerPath?: string } = {},
): Promise<Pass> {
  let ledgerPath = over.ledgerPath;
  if (!ledgerPath) {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5932-`));
    dirs.push(dir);
    ledgerPath = join(dir, "ledger.ndjson");
  }
  let dispatched = 0;
  const escalations: string[] = [];
  const inner = over.dispatchFix ?? (() => {});
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    escalate: (_pr, reason) => {
      escalations.push(reason);
    },
    runId: "SWEEP-W1-T5932",
    now: () => NOW,
    readLedger: () => [EARLIER, ...seed, ...readLedgerLines(ledgerPath)],
    ...over,
    dispatchFix: (p, e) => {
      dispatched++;
      return inner(p, e);
    },
    ledgerPath,
  };
  await runSweep([pr], deps);
  await drainDetachedSweepActions();
  const rows = readLedgerLines(ledgerPath);
  const disposedRows = rows.filter((l) => l.step === "sweep.disposed");
  return { row: disposedRows[disposedRows.length - 1], rows, dispatched, escalations, ledgerPath };
}

const rejecting: Partial<SweepDeps> = {
  detachFixWait: true,
  dispatchFix: async () => {
    throw new Error(ERROR);
  },
};

test("a detached fix dispatch that rejects before fix.dispatch writes sweep.fix.dispatch_failed and the next pass retries", async () => {
  for (const pr of [view(), conflictedView()]) {
    // Positive control: a detached dispatch that settles cleanly IS deduped on the next pass.
    const clean = await pass(pr, [], { detachFixWait: true });
    assert.equal(clean.dispatched, 1);
    assert.equal(clean.rows.some((l) => l.step === FAILED_STEP), false, "a clean dispatch writes no failure row");
    const deduped = await pass(pr, [], { ledgerPath: clean.ledgerPath });
    assert.equal(deduped.dispatched, 0);
    assert.match(String(deduped.row.stand_down_reason), DEDUPED);

    const first = await pass(pr, [], rejecting);
    assert.equal(first.dispatched, 1);
    assert.equal(first.row.acted, true, "the detached pass records acted:true before the dispatch settles");
    const failures = first.rows.filter((l) => l.step === FAILED_STEP);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].pr_number, PR);
    assert.equal(failures[0].head_sha, HEAD);
    assert.equal(failures[0].task_id, TASK);
    assert.equal(failures[0].error, ERROR);

    const second = await pass(pr, [], { ledgerPath: first.ledgerPath });
    assert.equal(second.dispatched, 1, "the next pass retries instead of deduping");
    assert.doesNotMatch(String(second.row.stand_down_reason), DEDUPED);
    assert.deepEqual(second.escalations, []);
  }
  // A non-Error rejection still names what it rejected with.
  const bare = await pass(view(), [], { detachFixWait: true, dispatchFix: () => Promise.reject("lock held") });
  assert.equal(bare.rows.find((l) => l.step === FAILED_STEP)?.error, "lock held");
});

test("a real fix.dispatch at that head still dedups, whatever order the failure row landed in", async () => {
  for (const seed of [
    [disposed(HEAD), failed(HEAD), realDispatch(HEAD)],
    [disposed(HEAD), realDispatch(HEAD), failed(HEAD)],
    [disposed(HEAD), { step: "fix.retrigger", task_id: TASK, head_sha: HEAD }, failed(HEAD)],
  ]) {
    const next = await pass(view(), seed);
    assert.equal(next.dispatched, 0);
    assert.match(String(next.row.stand_down_reason), DEDUPED);
  }
  // The failure row can land before the acted:true row it voids: the detached rejection settles mid-pass.
  const early = await pass(view(), [failed(HEAD), disposed(HEAD)]);
  assert.equal(early.dispatched, 1);
  // A failure row naming no head voids nothing.
  const legacy = await pass(view(), [disposed(HEAD), { ...failed(HEAD), head_sha: undefined }]);
  assert.equal(legacy.dispatched, 0);
  assert.match(String(legacy.row.stand_down_reason), DEDUPED);
});

test("FIX_DISPATCH_FAILED_BACKSTOP failures on one head stop the retries and escalate once, naming the error", async () => {
  assert.ok(Number.isInteger(FIX_DISPATCH_FAILED_BACKSTOP) && FIX_DISPATCH_FAILED_BACKSTOP >= 2);
  const failures = (n: number, head = HEAD) => Array.from({ length: n }, () => [disposed(head), failed(head)]).flat();

  const below = await pass(view(), failures(FIX_DISPATCH_FAILED_BACKSTOP - 1));
  assert.equal(below.dispatched, 1, "below the bound the dispatch is retried");
  assert.deepEqual(below.escalations, []);

  for (const pr of [view(), conflictedView()]) {
    const seed = failures(FIX_DISPATCH_FAILED_BACKSTOP);
    const at = await pass(pr, seed);
    assert.equal(at.dispatched, 0, "at the bound no further dispatch is attempted");
    assert.equal(at.escalations.length, 1);
    for (const named of [`#${PR}`, HEAD.slice(0, 7), ERROR, "FIX_DISPATCH_FAILED_BACKSTOP", String(FIX_DISPATCH_FAILED_BACKSTOP)]) {
      assert.ok(at.escalations[0].includes(named), `the escalation names ${named}: ${at.escalations[0]}`);
    }
    assert.equal(at.row.acted, false);
    assert.equal(at.row.fix_dispatch_failed_escalated, true);
    assert.doesNotMatch(String(at.row.stand_down_reason), DEDUPED);

    const again = await pass(pr, seed, { ledgerPath: at.ledgerPath });
    assert.equal(again.escalations.length, 0, "the escalation is written once per (PR, head)");
    assert.equal(again.dispatched, 0);
    assert.equal(again.row.fix_dispatch_failed_escalated, true);
  }
});

test("a new head resets the failure count and re-earns its own escalation", async () => {
  const old = Array.from({ length: FIX_DISPATCH_FAILED_BACKSTOP }, () => [disposed(HEAD), failed(HEAD)]).flat();
  const escalated = disposed(HEAD, { acted: false, fix_dispatch_failed_escalated: true });
  const next = await pass(view({ headSha: NEW_HEAD }), [...old, escalated]);
  assert.equal(next.dispatched, 1, "the new head's first dispatch is attempted");
  assert.deepEqual(next.escalations, []);
});

test("a dispatch failure and a W1-T5919 claim decline void the dedup by one rule and keep separate bounds", async () => {
  // A decline written before its acted:true row voids it too, as the failure row does.
  const earlyDecline = await pass(view(), [decline(HEAD), disposed(HEAD)]);
  assert.equal(earlyDecline.dispatched, 1);
  const declineThenReal = await pass(view(), [decline(HEAD), disposed(HEAD), realDispatch(HEAD)]);
  assert.equal(declineThenReal.dispatched, 0);

  // Below each bound, a mix of both still retries and escalates nothing.
  const mixed = Array.from({ length: Math.min(FIX_CLAIM_DECLINE_BACKSTOP, FIX_DISPATCH_FAILED_BACKSTOP) - 1 }, () => [
    disposed(HEAD), decline(HEAD), disposed(HEAD), failed(HEAD),
  ]).flat();
  const both = await pass(view(), mixed);
  assert.equal(both.dispatched, 1);
  assert.deepEqual(both.escalations, []);

  // The decline bound keeps its own escalation and wording.
  const declines = Array.from({ length: FIX_CLAIM_DECLINE_BACKSTOP }, () => [disposed(HEAD), decline(HEAD)]).flat();
  const declined = await pass(view(), declines);
  assert.equal(declined.dispatched, 0);
  assert.equal(declined.escalations.length, 1);
  assert.match(declined.escalations[0], /FIX_CLAIM_DECLINE_BACKSTOP/);
  assert.equal(declined.row.fix_dispatch_failed_escalated, undefined);
});

test("the dispatch-failed row is retained across ledger rotation", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(FAILED_STEP));
});
