// test/a-declined-fix-claim-is-not-a-dispatched-fix.test.ts — W1-T5919.
//
// LIVE 2026-10-05: #9362 (W1-T5285, head 83175eb) and #9379 (W1-T5882, head f251fd2) were disposed
// `blocked-fixable` acted:true, then `dispatchFix` declined at the checkout claim
// (`registered_worktree_owner`) and RETURNED. `priorActionsFromLedger` seeded `prior.fixed` from the
// acted:true row, the task's EARLIER head's `fix.dispatch` row left `fixRungStalledWithoutNewHead`
// false, and every later pass read "fix already dispatched for this head" for two hours with no
// `fix.dispatch` row at either head, no retry and no escalation.
//
// A declined claim is not a dispatched fix: the dedup counts only a real dispatch marker, the next
// pass re-attempts the claim, and FIX_CLAIM_DECLINE_BACKSTOP declines on one (PR, head) escalate once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  FIX_CLAIM_DECLINE_BACKSTOP,
  dispatchFixSpent,
  runSweep,
  type FixClaimDeclined,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import {
  buildSweepEffects,
  fixBranchClaimKey,
  type BuildSweepEffectsDeps,
  type RegisteredFixOwnerSnapshot,
} from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { ghShim } from "./helpers/gh-shim.js";

const NOW = Date.parse("2026-10-05T21:00:00Z");
const RECENT = "2026-10-05T20:00:00Z";
const PR = 9362;
const TASK = "W1-T5285";
const HEAD = "83175eb0aa";
const OLD_HEAD = "81c30d80bb";
const NEW_HEAD = "f00dfacecc";
const BRANCH = "run-W1-T5285-1791200000000";
// A REAL directory: the backstop holds only while the declined owner worktree still exists (#10551).
const OWNER = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}run-W1-T5285-`));
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const DECLINED_AT_HEAD = /fix already dispatched for this head/;

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
      oursLog: "83175eb ours",
      theirsLog: "f15dff6 theirs",
    },
  });
}

/** The pass that "dispatched": what `priorActionsFromLedger` folds into `prior.fixed`. */
function disposed(head: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "sweep.disposed", acted: true, pr_number: PR, head_sha: head, disposition: "blocked-fixable", ...extra };
}

/** The live decline row, now stamped with the head it declined at. */
function decline(head: string, reason = "owner_dirty_recovery_preserve_failed"): Record<string, unknown> {
  return {
    step: "sweep.fix.checkout_claim_declined",
    task_id: TASK,
    reason: "registered_worktree_owner",
    owner_recovery_reason: reason,
    pr_number: PR,
    head_sha: head,
    branch: BRANCH,
    worktree_path: OWNER,
  };
}

/** The task's EARLIER head's real dispatch — the row that masked W1-T1210's no-dispatch re-arm. */
const earlierHeadDispatch = { step: "fix.dispatch", task_id: TASK, head_sha: OLD_HEAD };

type Pass = {
  row: Record<string, unknown>;
  dispatched: number;
  escalations: string[];
  ledgerPath: string;
};

async function pass(
  pr: OpenPrView,
  seed: Array<Record<string, unknown>>,
  over: Partial<SweepDeps> & { ledgerPath?: string } = {},
): Promise<Pass> {
  const ledgerPath = over.ledgerPath ?? join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5919-`)), "ledger.ndjson");
  let dispatched = 0;
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {
      dispatched++;
    },
    escalate: (_pr, reason) => {
      escalations.push(reason);
    },
    runId: "SWEEP-W1-T5919",
    now: () => NOW,
    readLedger: () => [...seed, ...readLedgerLines(ledgerPath)],
    ...over,
    ledgerPath,
  };
  const wrapped = over.dispatchFix;
  if (wrapped) {
    deps.dispatchFix = (p, e) => {
      dispatched++;
      return wrapped(p, e);
    };
  }
  await runSweep([pr], deps);
  const rows = readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.disposed");
  return { row: rows[rows.length - 1], dispatched, escalations, ledgerPath };
}

test("a declined fix claim is not deduped as fix already dispatched, even behind an earlier head's fix.dispatch", async () => {
  // Positive control: without the decline row this exact seed IS deduped, so the setup reaches the
  // dedup the fix is about rather than passing on some earlier exit.
  const control = await pass(view(), [earlierHeadDispatch, disposed(HEAD)]);
  assert.match(String(control.row.stand_down_reason), DECLINED_AT_HEAD);
  assert.equal(control.dispatched, 0);

  // #9379's shape (earlier dispatch, no outcome row) and #9362's (earlier dispatch then fix.done).
  for (const earlier of [[earlierHeadDispatch], [earlierHeadDispatch, { step: "fix.done", task_id: TASK }]]) {
    const next = await pass(view(), [...earlier, disposed(HEAD), decline(HEAD)]);
    assert.equal(next.dispatched, 1, "the next pass re-attempts the declined claim");
    assert.doesNotMatch(String(next.row.stand_down_reason), DECLINED_AT_HEAD);
    assert.equal(next.row.acted, true);
    assert.deepEqual(next.escalations, [], "one decline is below the bound");
  }
});

test("a dispatch that wrote fix.dispatch at this head stays deduped, even if a later claim at it was declined", async () => {
  const realDispatch = { step: "fix.dispatch", task_id: TASK, head_sha: HEAD };
  for (const seed of [[disposed(HEAD), realDispatch], [disposed(HEAD), realDispatch, decline(HEAD)]]) {
    const next = await pass(view(), seed);
    assert.equal(next.dispatched, 0);
    assert.match(String(next.row.stand_down_reason), DECLINED_AT_HEAD);
  }
  // `fix.retrigger` is the other real-dispatch marker `dispatchFix`'s log wrapper names.
  const retriggered = await pass(view(), [earlierHeadDispatch, disposed(HEAD), { step: "fix.retrigger", task_id: TASK, head_sha: HEAD }, decline(HEAD)]);
  assert.equal(retriggered.dispatched, 0);
  // A decline row naming no head (pre-W1-T5919) or another reason voids nothing.
  const legacy = { ...decline(HEAD), head_sha: undefined };
  const inflight = { ...decline(HEAD), reason: "inflight_lock_owner" };
  for (const row of [legacy, inflight]) {
    const next = await pass(view(), [earlierHeadDispatch, disposed(HEAD), row]);
    assert.equal(next.dispatched, 0);
    assert.match(String(next.row.stand_down_reason), DECLINED_AT_HEAD);
  }
});

test("an awaited declined dispatch records acted:false naming the decline, and the next pass retries", async () => {
  const declined: FixClaimDeclined = { claimDeclined: true, ownerRecoveryReason: "owner_dirty_recovery_preserve_failed" };
  assert.equal(dispatchFixSpent(declined), false, "a declined claim spent no strike");
  for (const pr of [view(), conflictedView()]) {
    const first = await pass(pr, [earlierHeadDispatch], { dispatchFix: () => declined });
    assert.equal(first.dispatched, 1);
    assert.equal(first.row.acted, false);
    assert.equal(first.row.spent, false);
    assert.match(String(first.row.stand_down_reason), /declined at the checkout claim/);
    assert.match(String(first.row.stand_down_reason), /owner_dirty_recovery_preserve_failed/);
    assert.doesNotMatch(String(first.row.stand_down_reason), DECLINED_AT_HEAD);
    const second = await pass(pr, [earlierHeadDispatch], { ledgerPath: first.ledgerPath });
    assert.equal(second.dispatched, 1, "the acted:false row seeds no dedup");
  }
});

test("FIX_CLAIM_DECLINE_BACKSTOP declines on one PR head escalate needs-human exactly once, naming owner and reason", async () => {
  assert.ok(Number.isInteger(FIX_CLAIM_DECLINE_BACKSTOP) && FIX_CLAIM_DECLINE_BACKSTOP >= 2);
  const declines = (n: number, head = HEAD, reason?: string) =>
    Array.from({ length: n }, () => [disposed(head), decline(head, reason)]).flat();

  const below = await pass(view(), [earlierHeadDispatch, ...declines(FIX_CLAIM_DECLINE_BACKSTOP - 1)]);
  assert.equal(below.dispatched, 1, "below the bound the claim is re-attempted");
  assert.deepEqual(below.escalations, []);

  for (const pr of [view(), conflictedView()]) {
    const seed = [earlierHeadDispatch, ...declines(FIX_CLAIM_DECLINE_BACKSTOP)];
    const at = await pass(pr, seed);
    assert.equal(at.dispatched, 0, "at the bound no further claim is attempted");
    assert.equal(at.escalations.length, 1);
    const reason = at.escalations[0];
    for (const named of [`#${PR}`, HEAD.slice(0, 7), OWNER, "owner_dirty_recovery_preserve_failed", String(FIX_CLAIM_DECLINE_BACKSTOP)]) {
      assert.ok(reason.includes(named), `the escalation names ${named}: ${reason}`);
    }
    assert.equal(at.row.acted, false);
    assert.equal(at.row.fix_claim_decline_escalated, "owner_dirty_recovery_preserve_failed");
    assert.match(String(at.row.stand_down_reason), /declined/);
    assert.doesNotMatch(String(at.row.stand_down_reason), DECLINED_AT_HEAD);

    const again = await pass(pr, seed, { ledgerPath: at.ledgerPath });
    assert.equal(again.escalations.length, 0, "the escalation is deduped per (PR, head, reason)");
    assert.equal(again.dispatched, 0);
    assert.equal(again.row.acted, false);
    assert.equal(again.row.fix_claim_decline_escalated, "owner_dirty_recovery_preserve_failed");
  }

  // A changed reason re-earns the escalation at the same head.
  const escalatedA = disposed(HEAD, { acted: false, fix_claim_decline_escalated: "owner_remove_failed" });
  const changed = await pass(view(), [...declines(FIX_CLAIM_DECLINE_BACKSTOP), escalatedA]);
  assert.equal(changed.escalations.length, 1);
});

test("a new head resets the decline count and re-earns its own escalation", async () => {
  const oldDeclines = Array.from({ length: FIX_CLAIM_DECLINE_BACKSTOP }, () => [disposed(HEAD), decline(HEAD)]).flat();
  const escalated = disposed(HEAD, { acted: false, fix_claim_decline_escalated: "owner_dirty_recovery_preserve_failed" });
  const next = await pass(view({ headSha: NEW_HEAD }), [earlierHeadDispatch, ...oldDeclines, escalated]);
  assert.equal(next.dispatched, 1, "the new head's first claim is attempted");
  assert.deepEqual(next.escalations, []);
});

test("the decline row and both real-dispatch markers are retained across ledger rotation", () => {
  for (const step of ["sweep.fix.checkout_claim_declined", "fix.dispatch", "fix.retrigger"]) {
    assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(step), step);
  }
});

// ── The REAL `dispatchFix` closure: every registered-owner decline stamps the head and reports itself ──

const T = (id: string): Task =>
  ({ id, title: id, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" }) as unknown as Task;
const PLAN: Plan = (() => {
  const tasks = [T("W1-T500")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();
const REAL_HEAD = "cafe1234";
const SAFE: RegisteredFixOwnerSnapshot = {
  path: "/fleet/worktrees/sweep-W1-T500-1785600000003",
  pathState: "managed",
  attachmentState: "exact",
  treeState: "clean",
  remoteState: "exact",
  historyState: "contained",
  claimState: "clear",
  processState: "clear",
  ageMs: 60_000,
  localSha: "a".repeat(40),
  remoteSha: "b".repeat(40),
};

type Drive = { logs: Array<{ step: string; extra?: Record<string, unknown> }>; threw: unknown; outcome: unknown };

async function driveDispatchFix(
  root: string,
  branch: string,
  owner: () => string | undefined,
  recovery?: BuildSweepEffectsDeps["registeredOwnerRecovery"],
): Promise<Drive> {
  const shim = ghShim(
    [
      { when: "headRefName", stdout: JSON.stringify({ headRefName: branch, headRefOid: REAL_HEAD, body: "" }) },
      {
        when: "pulls/9001",
        stdout: JSON.stringify({ state: "open", merged: false, head: { sha: REAL_HEAD, ref: branch }, base: { sha: "deadbeef" } }),
      },
      { when: "", stdout: "{}" },
    ],
    { kind: "t5919-gh" },
  );
  const bin = shim.dir;
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Drive["logs"] = [];
  let threw: unknown;
  let outcome: unknown;
  try {
    const effects = buildSweepEffects({
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
      owner: "acme",
      repo: "scratch-t5919-repo",
      config: { root } as never,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "SWEEP-T5919",
      plan: PLAN,
      log: (step, extra) => void logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: undefined,
      spawnImpl: (async () => {
        throw new Error("a declined claim must never reach worker dispatch");
      }) as never,
      pushEmptyCommit: undefined,
      issuesImpl: undefined,
      stallNotice: undefined,
      armImpl: undefined,
      armSessionPrsOverride: undefined,
      updateBranchImpl: undefined,
      captureRepairFeedbackImpl: undefined,
      ghRunImpl: undefined,
      spawnWallClockBoundMsOverride: undefined,
      reclaimWorkerImpl: undefined,
      disarmImpl: undefined,
      readJsonImpl: undefined,
      registeredWorktreeOwnerImpl: () => owner(),
      registeredOwnerRecovery: recovery,
    });
    const pr = {
      prNumber: 9001,
      prUrl: "https://github.com/acme/scratch-t5919-repo/pull/9001",
      headSha: REAL_HEAD,
      headRefName: branch,
      taskId: "W1-T500",
      reviewState: "none",
      checksState: "red",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
    } as unknown as OpenPrView;
    outcome = await effects.dispatchFix(pr, { unmetCriteria: [], ciFailures: [] } as never);
  } catch (e) {
    threw = e;
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
  return { logs, threw, outcome };
}

const fails = (what: string) => () => {
  throw new Error(`${what} failed`);
};

test("every registered-owner decline in the real dispatchFix stamps head_sha and reports a declined claim", async () => {
  const arms: Array<{ reason: string; owner: () => string | undefined; recovery: BuildSweepEffectsDeps["registeredOwnerRecovery"] }> = [
    { reason: "owner_snapshot_unreadable", owner: () => SAFE.path, recovery: { capture: fails("capture"), remove: fails("remove") } },
    { reason: "process_cwd_owner", owner: () => SAFE.path, recovery: { capture: () => ({ ...SAFE, processState: "occupied" }), remove: fails("remove") } },
    {
      reason: "owner_dirty_recovery_identity_unreadable",
      owner: () => SAFE.path,
      recovery: { capture: () => ({ ...SAFE, treeState: "tracked_dirty", localSha: null }), remove: fails("remove") },
    },
    {
      reason: "owner_dirty_recovery_preserve_failed",
      owner: () => SAFE.path,
      recovery: { capture: () => ({ ...SAFE, treeState: "tracked_dirty" }), preserveTrackedDirty: fails("preserve"), remove: fails("remove") },
    },
    {
      reason: "owner_dirty_recovery_reset_failed",
      owner: () => SAFE.path,
      recovery: {
        capture: () => ({ ...SAFE, treeState: "tracked_dirty" }),
        preserveTrackedDirty: () => "refs/rmd-recovery/fix-dirty/x",
        resetTrackedDirty: fails("reset"),
        remove: fails("remove"),
      },
    },
    {
      reason: "owner_salvage_identity_unreadable",
      owner: () => SAFE.path,
      recovery: { capture: () => ({ ...SAFE, historyState: "ahead", remoteSha: null }), remove: fails("remove") },
    },
    {
      reason: "owner_ahead_publish_failed",
      owner: () => SAFE.path,
      recovery: { capture: () => ({ ...SAFE, historyState: "ahead" }), publishAhead: fails("publish"), remove: fails("remove") },
    },
    { reason: "owner_remove_failed", owner: () => SAFE.path, recovery: { capture: () => SAFE, remove: fails("remove") } },
  ];
  // Re-read arms: the owner lookup answers per call — first the owner, then the re-read.
  const sequence = (...answers: Array<string | undefined | Error>) => {
    let n = 0;
    return () => {
      const a = answers[Math.min(n++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    };
  };
  arms.push(
    { reason: "worktree_registry_reread_failed", owner: sequence(SAFE.path, new Error("reread")), recovery: { capture: () => SAFE, remove: () => {} } },
    { reason: "owner_registration_remained", owner: sequence(SAFE.path, SAFE.path), recovery: { capture: () => SAFE, remove: () => {} } },
    { reason: "owner_registration_changed", owner: sequence(SAFE.path, "/fleet/worktrees/other"), recovery: { capture: () => SAFE, remove: () => {} } },
  );
  for (const [i, arm] of arms.entries()) {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5919-arm-`));
    try {
      mkdirSync(join(root, "repos"), { recursive: true });
      const { logs, threw, outcome } = await driveDispatchFix(root, `run-W1-T500-17856000001${String(i).padStart(2, "0")}`, arm.owner, arm.recovery);
      assert.equal(threw, undefined, arm.reason);
      const row = logs.find((l) => l.step === "sweep.fix.checkout_claim_declined");
      assert.ok(row, `${arm.reason}: steps were ${JSON.stringify(logs.map((l) => l.step))}`);
      assert.equal(row.extra?.owner_recovery_reason, arm.reason);
      assert.equal(row.extra?.head_sha, REAL_HEAD, `${arm.reason} stamps the declined head`);
      assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: arm.reason });
      assert.ok(!logs.some((l) => l.step === "fix.dispatch"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an unreadable worktree registry still throws, and its decline row names the head", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5919-registry-`));
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const { logs, threw } = await driveDispatchFix(root, "run-W1-T500-1785600000200", fails("registry"));
    assert.match(String((threw as Error)?.message), /registry failed/);
    const row = logs.find((l) => l.step === "sweep.fix.checkout_claim_declined");
    assert.equal(row?.extra?.owner_recovery_reason, "worktree_registry_unreadable");
    assert.equal(row?.extra?.head_sha, REAL_HEAD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live branch-claim holder still stands down as before, and its decline row names the head", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5919-inflight-`));
  const branch = "run-W1-T500-1785600000201";
  const holder = acquireInflightLock(join(root, "state", "inflight"), fixBranchClaimKey("acme", "scratch-t5919-repo", branch), {
    run_id: "OTHER-RUN",
  });
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const { logs, threw, outcome } = await driveDispatchFix(root, branch, () => undefined);
    assert.equal(threw, undefined);
    assert.equal(outcome, undefined, "an in-flight holder is not a declined claim");
    const row = logs.find((l) => l.step === "sweep.fix.checkout_claim_declined");
    assert.equal(row?.extra?.reason, "inflight_lock_owner");
    assert.equal(row?.extra?.head_sha, REAL_HEAD);
  } finally {
    holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});
