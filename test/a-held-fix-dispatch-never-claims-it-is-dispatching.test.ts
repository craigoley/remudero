// test/a-held-fix-dispatch-never-claims-it-is-dispatching.test.ts
//
// LIVE 2026-10-10: #10551 (W1-T7243, head 3644414) was disposed `conflicted`, blocker_owner
// `conflict-rebase`, every ~2 minutes for hours with the reason "… dispatching the bounded
// merge-conflict fix worker …" — yet no fix.dispatch row followed. The stand-down was
// FIX_CLAIM_DECLINE_BACKSTOP: three `sweep.fix.checkout_claim_declined` rows at that head
// (registered owner /home/node/Remudero/worktrees/sweep-W1-T7243-1791611477902, dirty_worktree)
// held every later pass, and a light pass hid even that behind "deferred to full sweep". The
// stuck lane then escalated the stage as "unknown signature", and nothing could lift the hold:
// it counted ledger rows, never re-probed the owner, and only a new head reset it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIX_CLAIM_DECLINE_BACKSTOP,
  fixDispatchHoldAtHead,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { finalBlocker } from "../src/lib/pr-blocker.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-10T11:13:00Z");
const PR = 10551;
const TASK = "W1-T7243";
const HEAD = "3644414a477332f299d3c25d9554c8d46be96ea7";
const BRANCH = "run-W1-T7243-1791596280195";

function conflicted(): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-10T10:00:00Z",
    headSha: HEAD,
    headRefName: BRANCH,
    autoMergeArmed: false,
    mergeState: "dirty",
    mergeConflict: {
      files: [{ path: "src/lib/sweep.ts", oursDeleted: 79, theirsDeleted: 100 }],
      oursLog: "3644414 ours",
      theirsLog: "a495e78 theirs",
    },
  };
}

function decline(owner: string): Record<string, unknown> {
  return {
    step: "sweep.fix.checkout_claim_declined", task_id: TASK, reason: "registered_worktree_owner",
    owner_recovery_reason: "dirty_worktree", pr_number: PR, head_sha: HEAD, branch: BRANCH, worktree_path: owner,
  };
}

const declines = (owner: string) => Array.from({ length: FIX_CLAIM_DECLINE_BACKSTOP }, () => decline(owner));

function ownerDir(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sweep-${TASK}-`));
}

async function pass(seed: Array<Record<string, unknown>>, over: Partial<SweepDeps> = {}) {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-fix-`)), "ledger.ndjson");
  let dispatched = 0;
  const escalations: string[] = [];
  await runSweep([conflicted()], {
    arm: () => {},
    close: () => {},
    dispatchFix: () => { dispatched++; },
    escalate: (_pr, reason) => { escalations.push(reason); },
    runId: "SWEEP-10551",
    now: () => NOW,
    readLedger: () => [...seed, ...readLedgerLines(ledgerPath)],
    policy: { mergeConflictAdmissionEnabled: true },
    ...over,
    ledgerPath,
  } as SweepDeps);
  const rows = readLedgerLines(ledgerPath);
  const disposed = rows.filter((l) => l.step === "sweep.disposed");
  return { row: disposed[disposed.length - 1], rows, dispatched, escalations };
}

test("a conflicted PR held at the claim-decline backstop never records dispatching and is escalated, not conflict-rebase", async () => {
  const owner = ownerDir();
  try {
    // Positive control: below the backstop the same PR does dispatch, so the reason is truthful.
    const control = await pass([decline(owner)]);
    assert.equal(control.row.disposition, "conflicted");
    assert.equal(control.dispatched, 1);
    assert.match(String(control.row.reason), /dispatching the bounded merge-conflict fix worker/);
    assert.equal(control.row.blocker_owner, "conflict-rebase");

    for (const over of [{}, { actionable: (d: string) => d === "post-review" }] as Partial<SweepDeps>[]) {
      const held = await pass(declines(owner), over);
      assert.equal(held.dispatched, 0);
      assert.equal(held.row.acted, false);
      assert.doesNotMatch(String(held.row.reason), /\bdispatching\b/, String(held.row.reason));
      assert.match(String(held.row.reason), /NOT DISPATCHED this pass: fix checkout claim declined/);
      assert.match(String(held.row.reason), /FIX_CLAIM_DECLINE_BACKSTOP/);
      assert.equal(held.row.blocker, "escalated");
      assert.equal(held.row.blocker_owner, "NONE");
      assert.equal(held.row.dispatch_held, "fix_claim_decline");
    }
  } finally {
    rmSync(owner, { recursive: true, force: true });
  }
});

test("the claim-decline hold lifts once the declined owner worktree is gone, and the claim is re-attempted", async () => {
  const owner = ownerDir();
  const atBound = fixDispatchHoldAtHead(conflicted(), declines(owner));
  assert.ok(atBound, "an existing owner worktree holds at the backstop");
  rmSync(owner, { recursive: true, force: true });
  assert.equal(fixDispatchHoldAtHead(conflicted(), declines(owner)), undefined);
  const after = await pass(declines(owner));
  assert.equal(after.dispatched, 1, "the cleared owner no longer blocks the dispatch");
  assert.equal(after.row.acted, true);
  assert.equal(after.row.blocker_owner, "conflict-rebase");
  assert.deepEqual(after.escalations, []);
  // A decline that named no path cannot be re-probed, so it still holds.
  const unnamed = declines(owner).map((row) => ({ ...row, worktree_path: undefined }));
  assert.match(String(fixDispatchHoldAtHead(conflicted(), unnamed)?.reason), /path unread/);
});

test("finalBlocker routes a held dispatch to escalated, below a strikes-exhausted ruling", () => {
  assert.equal(finalBlocker("conflict", { dispatchHeld: true }), "escalated");
  assert.equal(finalBlocker("conflict", {}), "conflict");
  assert.equal(finalBlocker("conflict", { dispatchHeld: true, strikesExhausted: true }), "strikes-exhausted");
});
