// test/the-codeql-blocker-repair-records-a-detached-dispatch-that-fails.test.ts — W1-T5951.
//
// W1-T5932 ledgered a detached fix dispatch that rejects before `fix.dispatch`, but the W1-T3980
// CodeQL-blocker arm still detached `dispatchFix` through a bare `detachSweepAction`: the rejection was
// swallowed and the pre-dispatch CODEQL_BLOCKER_DISPATCH_STEP row's dedupe key held the PR with no worker.
// The arm now writes `sweep.fix.dispatch_failed` carrying that key, the key's dedup honours it, and
// FIX_DISPATCH_FAILED_BACKSTOP bounds the retries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyScannerBlocker, type ScannerBlockerCandidate } from "../src/lib/open-prs-rest.js";
import {
  CODEQL_BLOCKER_DISPATCH_STEP,
  DEFAULT_SWEEP_POLICY,
  FIX_DISPATCH_FAILED_BACKSTOP,
  codeqlBlockerDedupeKey,
  drainDetachedSweepActions,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

const PR = 7495;
const TASK = "W1-T3980";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NEW_HEAD = "9".repeat(40);
const MERGE = "f0e1d2c3b4a5968778695a4b3c2d1e0f98765432";
const ALERT = 42;
const NOW = Date.parse("2026-09-27T12:00:00Z");
const ERROR = "Command failed: git checkout -B run-W1-T3980 (.git/config.lock exists)";
const FAILED_STEP = "sweep.fix.dispatch_failed";
const DEDUPED = /CodeQL blocker repair already dispatched/;
const KEY = codeqlBlockerDedupeKey({ prNumber: PR, headSha: HEAD }, { alertNumber: ALERT });

function blockedPr(head = HEAD): OpenPrView {
  const candidate: ScannerBlockerCandidate = {
    number: PR,
    headSha: head,
    merge: { mergeable: true, mergeableState: "blocked", state: "clean", mergeCommitSha: MERGE, headSha: head },
  };
  const alert = {
    number: ALERT,
    rule: { id: "js/file-system-race" },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      ref: `refs/pull/${PR}/merge`,
      commit_sha: MERGE,
      message: { text: "The file may have changed since it was checked." },
      location: { path: "src/lib/state.ts", start_line: 88 },
    },
  };
  const thread = {
    body: `[Show more details](https://github.com/craigoley/remudero/security/code-scanning/${ALERT})`,
    user: { login: "github-advanced-security[bot]", type: "Bot" },
  };
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-27T11:00:00Z", // expiring-fixture: exempt -- compared only against the injected NOW
    headSha: head,
    headRefName: `run-${TASK}-1790553732270`,
    autoMergeArmed: true,
    isDraft: false,
    mergeState: "clean",
    mergeable: true,
    mergeableState: "blocked",
    scannerBlocker: classifyScannerBlocker(candidate, [alert], [thread]),
  };
}

const dispatchRow = (key = KEY) => ({ step: CODEQL_BLOCKER_DISPATCH_STEP, task_id: TASK, pr_number: PR, head_sha: HEAD, dedupe_key: key });
const failed = (key = KEY, head = HEAD) =>
  ({ step: FAILED_STEP, task_id: TASK, pr_number: PR, head_sha: head, dedupe_key: key, error: ERROR });

type Pass = { row: Record<string, unknown>; rows: Array<Record<string, unknown>>; dispatched: number; escalations: string[] };

async function pass(pr: OpenPrView, seed: Array<Record<string, unknown>>, over: Partial<SweepDeps> = {}): Promise<Pass> {
  const rows: Array<Record<string, unknown>> = [];
  const escalations: string[] = [];
  let dispatched = 0;
  const inner = over.dispatchFix ?? (() => {});
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    escalate: (_pr, reason) => {
      escalations.push(reason);
    },
    ledgerPath: "/nonexistent/rmd-w1-t5951/rows.ndjson",
    runId: "SWEEP-W1-T5951",
    now: () => NOW,
    readLedger: () => [...seed, ...rows],
    appendLine: (_path, row) => {
      rows.push(row);
    },
    ...over,
    dispatchFix: (p, e) => {
      dispatched++;
      return inner(p, e);
    },
  };
  await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  await drainDetachedSweepActions();
  const disposedRows = rows.filter((l) => l.step === "sweep.disposed");
  return { row: disposedRows[disposedRows.length - 1], rows, dispatched, escalations };
}

const rejecting: Partial<SweepDeps> = {
  detachFixWait: true,
  dispatchFix: async () => {
    throw new Error(ERROR);
  },
};

test("a CodeQL-blocker repair whose detached dispatch rejects writes sweep.fix.dispatch_failed and the next pass retries", async () => {
  // Positive control: a detached repair that settles cleanly IS deduped on its key by the next pass.
  const clean = await pass(blockedPr(), [], { detachFixWait: true });
  assert.equal(clean.dispatched, 1);
  assert.equal(clean.rows.some((l) => l.step === FAILED_STEP), false, "a clean dispatch writes no failure row");
  const deduped = await pass(blockedPr(), clean.rows);
  assert.equal(deduped.dispatched, 0);
  assert.match(String(deduped.row.stand_down_reason), DEDUPED);

  const first = await pass(blockedPr(), [], rejecting);
  assert.equal(first.dispatched, 1);
  assert.equal(first.row.acted, true);
  const failures = first.rows.filter((l) => l.step === FAILED_STEP);
  assert.equal(failures.length, 1);
  assert.deepEqual(
    { pr: failures[0].pr_number, head: failures[0].head_sha, task: failures[0].task_id, key: failures[0].dedupe_key, error: failures[0].error },
    { pr: PR, head: HEAD, task: TASK, key: KEY, error: ERROR },
  );
  assert.ok(
    first.rows.findIndex((l) => l.step === CODEQL_BLOCKER_DISPATCH_STEP) < first.rows.findIndex((l) => l.step === FAILED_STEP),
    "the key is still ledgered before the worker starts",
  );

  const second = await pass(blockedPr(), first.rows);
  assert.equal(second.dispatched, 1, "the next pass retries instead of deduping on the key");
  assert.doesNotMatch(String(second.row.stand_down_reason), DEDUPED);
  assert.deepEqual(second.escalations, []);

  // A non-Error rejection still names what it rejected with.
  const bare = await pass(blockedPr(), [], { detachFixWait: true, dispatchFix: () => Promise.reject("lock held") });
  assert.equal(bare.rows.find((l) => l.step === FAILED_STEP)?.error, "lock held");
});

test("a CodeQL repair dispatch that started still dedups on its codeql key", async () => {
  for (const seed of [
    [dispatchRow()],
    // A retry after a failure that then started is the latest row for the key.
    [dispatchRow(), failed(), dispatchRow()],
    // A failure of a different alert's repair, or of the ordinary fix arm (no key), voids nothing here.
    [dispatchRow(), failed(`${PR}@${HEAD}#43`)],
    [dispatchRow(), { ...failed(), dedupe_key: undefined }],
  ]) {
    const next = await pass(blockedPr(), seed);
    assert.equal(next.dispatched, 0, JSON.stringify(seed));
    assert.match(String(next.row.stand_down_reason), DEDUPED);
  }
});

test("FIX_DISPATCH_FAILED_BACKSTOP failed CodeQL repairs on one head stop the retries and escalate once", async () => {
  const failures = (n: number) => Array.from({ length: n }, () => [dispatchRow(), failed()]).flat();

  const below = await pass(blockedPr(), failures(FIX_DISPATCH_FAILED_BACKSTOP - 1));
  assert.equal(below.dispatched, 1, "below the bound the repair is retried");
  assert.deepEqual(below.escalations, []);

  const seed = failures(FIX_DISPATCH_FAILED_BACKSTOP);
  const at = await pass(blockedPr(), seed);
  assert.equal(at.dispatched, 0, "at the bound no further repair is attempted");
  assert.equal(at.rows.some((l) => l.step === CODEQL_BLOCKER_DISPATCH_STEP), false, "no key is spent at the bound");
  assert.equal(at.escalations.length, 1);
  for (const named of [`#${PR}`, HEAD.slice(0, 7), ERROR, "FIX_DISPATCH_FAILED_BACKSTOP"]) {
    assert.ok(at.escalations[0].includes(named), `the escalation names ${named}: ${at.escalations[0]}`);
  }
  assert.equal(at.row.acted, false);
  assert.equal(at.row.fix_dispatch_failed_escalated, true);

  const again = await pass(blockedPr(), [...seed, ...at.rows]);
  assert.equal(again.escalations.length, 0, "the escalation is written once per (PR, head)");
  assert.equal(again.dispatched, 0);
});

test("a new head resets the CodeQL repair failure count", async () => {
  const old = Array.from({ length: FIX_DISPATCH_FAILED_BACKSTOP }, () => [dispatchRow(), failed()]).flat();
  const escalated = { step: "sweep.disposed", acted: false, pr_number: PR, head_sha: HEAD, fix_dispatch_failed_escalated: true };
  const next = await pass(blockedPr(NEW_HEAD), [...old, escalated]);
  assert.equal(next.dispatched, 1, "the new head's repair is attempted");
  assert.deepEqual(next.escalations, []);
});
