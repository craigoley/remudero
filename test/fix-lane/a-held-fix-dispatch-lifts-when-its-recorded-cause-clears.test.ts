import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, fixDispatchHoldAtHead, fixDispatchHoldAtHeadAsync,
  installDetachedWorkHost, runSweep,
  type FixDispatchHoldOptions, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import * as sweep from "#src/lib/sweep.js";
import type { FixProgressInput, FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import type { ProcessCwdCensus } from "#src/lib/process-cwd-census.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const pr: OpenPrView = { prNumber: 15679, prUrl: "https://github.com/craigoley/remudero/pull/15679",
  taskId: "W1-T9796", headSha: "0a66a11", headRefName: "run-W1-T9796-1792983204646",
  reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false, mergeState: "dirty",
  mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" } };
const at = (ms: number) => new Date(ms).toISOString();
const failure = (ms = NOW, error = "transport failed 500") => ({ step: "sweep.fix.dispatch_failed",
  pr_number: pr.prNumber, task_id: pr.taskId, head_sha: pr.headSha, error, ts: at(ms) });
const dispatch = (ms: number, extra = {}) => ({ step: "fix.dispatch", pr_number: pr.prNumber,
  task_id: pr.taskId, head_sha: pr.headSha, ts: at(ms), ...extra });
const options = (extra: FixDispatchHoldOptions = {}): FixDispatchHoldOptions => ({ nowMs: NOW, sweepPassMs: 100, ...extra });
const hold = (rows: Record<string, unknown>[], extra: FixDispatchHoldOptions = {}) =>
  fixDispatchHoldAtHead(pr, rows, () => true, undefined, options(extra));

test("test/fix-lane/a-held-fix-dispatch-lifts-when-its-recorded-cause-clears.test.ts", async () => {
  for (const name of ["FIX_DISPATCH_FAILED_BACKSTOP", "FIX_CLAIM_DECLINE_BACKSTOP"]) assert.equal(name in sweep, false);
  for (const error of ["PAUSE held on refs/rmd-pause/hold", "PAUSE: cannot reach origin to read refs/rmd-pause/hold"]) {
    const rows = Array.from({ length: 126 }, (_, i) => failure(NOW - i, error));
    const held = hold(rows, { fleetHold: () => error });
    assert.ok(held);
    assert.equal(held.fields.probe_result, "present");
    assert.equal(hold(rows, { fleetHold: () => undefined }), undefined, "first clear probe lifts at the same head");
  }
  const owner = { step: "sweep.fix.checkout_claim_declined", pr_number: pr.prNumber, head_sha: pr.headSha,
    reason: "registered_worktree_owner", owner_recovery_reason: "process_cwd_owner", owner_recovery_decision: "keep",
    worktree_path: "/worktrees/sweep-W1-T10559-1792983204646", ts: at(NOW) };
  assert.ok(fixDispatchHoldAtHead(pr, [owner], () => true, () => false, options()));
  assert.equal(fixDispatchHoldAtHead(pr, [owner], () => true, () => true, options()), undefined, "dead owner is reclaimable");
  assert.equal(fixDispatchHoldAtHead(pr, [owner], () => false, () => false, options()), undefined, "removed owner lifts");
  let fleetHeld = true;
  let dispatched = 0;
  const rows: Record<string, unknown>[] = [failure(NOW, "PAUSE: cannot reach origin to read refs/rmd-pause/hold")];
  const deps: SweepDeps = { arm: () => {}, close: () => {}, dispatchFix: () => { dispatched++; }, escalate: () => {},
    runId: "held", ledgerPath: "/unused", now: () => NOW, readLedger: () => rows,
    appendLine: (_path, row) => { rows.push({ ts: at(NOW), ...row }); },
    workerAdmissionHold: () => fleetHeld ? "fleet PAUSE hold: origin unreadable" : undefined };
  await runSweep([pr], deps);
  const disposed = rows.findLast(row => row.step === "sweep.disposed")!;
  assert.equal(dispatched, 0);
  for (const field of ["cause", "probe_result", "next_retry_at", "backoff_ms", "judge_verdict"]) assert.ok(field in disposed, field);
  fleetHeld = false;
  await runSweep([pr], { ...deps, runId: "clear" });
  assert.equal(dispatched, 1, "dispatches again at the same head without a push");
});

test("a production owner probe releases a recorded process owner when its claim clears despite unreadable history", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-held-owner-"));
  const ownerPath = join(root, "worktrees", "sweep-W1-T9796-1792983204646");
  const branch = pr.headRefName!;
  const claimKey = "fix-owner-claim";
  const inflightDir = join(root, "state", "inflight");
  const lockPath = join(inflightDir, `${claimKey}.lock`);
  let census: ProcessCwdCensus = { state: "unknown", scanned: 1, reason: "cwd_unreadable" };
  let censusCalls = 0;
  try {
    mkdirSync(ownerPath, { recursive: true });
    mkdirSync(inflightDir, { recursive: true });
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), run_id: "live-owner",
      startedAt: new Date().toISOString() }));
    const built = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root }, ledgerPath,
      runId: "owner-probe", plan: { tasks: [], byId: new Map() }, policy: DEFAULT_SWEEP_POLICY,
      log: () => {},
      fixBranchClaimKeyImpl: () => claimKey,
      ownerProcessCwdCensusImpl: (path: string) => {
        assert.equal(path, ownerPath);
        censusCalls++;
        return census;
      },
      registeredOwnerRecovery: { capture: () => ({ path: ownerPath, pathState: "managed",
        attachmentState: "exact", treeState: "clean", remoteState: "exact", historyState: "unknown",
        claimState: "unknown", processState: "unknown", ageMs: 1000, localSha: pr.headSha,
        remoteSha: pr.headSha }), remove: () => {} } } as never);
    const owner = { step: "sweep.fix.checkout_claim_declined", pr_number: pr.prNumber, head_sha: pr.headSha,
      task_id: pr.taskId, branch, reason: "registered_worktree_owner", owner_recovery_reason: "process_cwd_owner",
      worktree_path: ownerPath, ts: at(NOW) };
    assert.ok(fixDispatchHoldAtHead(pr, [owner], () => true, built.fixOwnerReclaimableAtHold, options()),
      "the live claim holds despite unreadable git history");
    assert.equal(censusCalls, 0, "a live claim already establishes ownership");
    unlinkSync(lockPath);
    assert.equal(fixDispatchHoldAtHead(pr, [owner], () => true, built.fixOwnerReclaimableAtHold, options())?.fields.probe_result,
      "present", "a cleared claim with an unreadable process census still holds");
    assert.equal(censusCalls, 1);
    census = { state: "occupied", scanned: 1, pid: process.pid };
    assert.ok(fixDispatchHoldAtHead(pr, [owner], () => true, built.fixOwnerReclaimableAtHold, options()),
      "a live process still holds after its claim clears");
    assert.equal(censusCalls, 2);
    census = { state: "clear", scanned: 1 };
    assert.equal(fixDispatchHoldAtHead(pr, [owner], () => true, built.fixOwnerReclaimableAtHold, options()), undefined,
      "the production claim and process census release the recorded cause at this head");
    assert.equal(censusCalls, 3, "the process census is re-read each pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T11168 criterion 2: ledger median, doubling, success reset and one-pass first retry", () => {
  const history = [failure(NOW - 3000), dispatch(NOW - 2900), failure(NOW - 2000), dispatch(NOW - 1700)];
  const first = failure(NOW);
  assert.equal(hold([...history, first])?.fields.backoff_ms, 200);
  assert.equal(hold([...history, first], { nowMs: NOW + 200 }), undefined);
  const second = failure(NOW + 200);
  assert.equal(hold([...history, first, second], { nowMs: NOW + 200 })?.fields.backoff_ms, 400);
  assert.equal(hold([...history, first, second], { nowMs: NOW + 600 }), undefined);
  const reset = [...history, first, second, dispatch(NOW + 600), failure(NOW + 700)];
  assert.equal(hold(reset, { nowMs: NOW + 700 })?.fields.backoff_ms, 350);
  assert.equal(hold([first])?.fields.next_retry_at, at(NOW + 100));
  assert.equal(hold([first], { nowMs: NOW + 100 }), undefined);
  const many = Array.from({ length: 12 }, (_, i) => failure(NOW + i * 100));
  const waiting = hold(many, { nowMs: NOW + 1100 })!;
  assert.equal(waiting.fields.backoff_ms, 100 * 2 ** 11);
  assert.equal(hold(many, { nowMs: Date.parse(String(waiting.fields.next_retry_at)) }), undefined);
  assert.equal(hold([...many, failure(NOW + 1200, "different cause")], { nowMs: NOW + 1200 })?.fields.backoff_ms, 100);
  assert.equal(hold([...many, dispatch(NOW + 1200)]), undefined, "a success clears previous failures");
  assert.equal(hold([failure(NOW, "transport failed 501")])?.fields.cause, hold([first])?.fields.cause);
  const hosted = [failure(NOW - 2000, "hosted child refused"),
    dispatch(NOW - 1800, { pr_number: undefined }),
    { ...failure(NOW, "hosted child refused"), task_id: "SWEEP-123" }];
  assert.equal(hold(hosted)?.fields.backoff_ms, 200,
    "a hosted-child SWEEP task id joins the successful task-id-only dispatch by PR");
  const preserveFailure = { step: "sweep.fix.checkout_claim_declined", task_id: pr.taskId,
    pr_number: pr.prNumber, head_sha: pr.headSha, worktree_path: "/worktrees/sweep-W1-T9796-1",
    reason: "registered_worktree_owner",
    owner_recovery_reason: "owner_staged_residue_preserve_failed", ts: at(NOW) };
  assert.equal(hold([preserveFailure])?.fields.probe_result, "unprobed");
  assert.equal(hold([preserveFailure], { nowMs: NOW + 100 }), undefined,
    "a failed preservation retries after its backoff even while the checkout remains");
});

test("W1-T11168 criterion 3: failed retries ask the judge and escalate once per head and cause", async () => {
  const seed = [failure(NOW - 1000), failure(NOW)];
  let calls = 0;
  const receipts: Record<string, unknown>[] = [];
  const judge: FixProgressJudge = async (input: FixProgressInput) => {
    calls++;
    assert.deepEqual(input.remedyHistory, seed);
    return { verdict: "escalate", loop: "transport", reason: "repeated transport failure" };
  };
  const opts = options({ judge, record: row => receipts.push(row) });
  const held = await fixDispatchHoldAtHeadAsync(pr, seed, () => true, undefined, opts);
  assert.equal(calls, 1);
  assert.equal(held?.fields.judge_verdict, "escalate");
  assert.equal(held?.escalated, false);
  assert.equal(receipts[0].site, "fix-dispatch-cause");
  const disposed = { step: "sweep.disposed", pr_number: pr.prNumber, head_sha: pr.headSha, ...held!.fields, dispatch_cause_escalated: held!.fields.dispatch_cause_key };
  const again = await fixDispatchHoldAtHeadAsync(pr, [...seed, ...receipts, disposed], () => true, undefined, opts);
  assert.equal(calls, 1, "one judgment per failed retry");
  assert.equal(again?.escalated, true);
  const unavailable = await fixDispatchHoldAtHeadAsync(pr, seed, () => true, undefined, options({ judge: async () => undefined }));
  assert.equal(unavailable?.fields.judge_verdict, "unavailable");
  assert.equal(unavailable?.fields.fix_dispatch_failed_escalated, undefined);
  assert.equal(await fixDispatchHoldAtHeadAsync(pr, seed, () => true, undefined,
    options({ nowMs: NOW + 200, judge: async () => undefined })), undefined, "unavailable keeps the retry schedule");
});

test("a cause judge's change of approach reaches the next dispatch", async () => {
  const rows: Record<string, unknown>[] = [failure(NOW - 1000), failure(NOW - 500)];
  let approach: string | undefined;
  await runSweep([pr], { arm: () => {}, close: () => {}, escalate: () => { assert.fail("no escalation"); },
    dispatchFix: (_pr, evidence) => { approach = evidence.progressApproach; },
    runId: "approach", ledgerPath: "/unused", now: () => NOW + 1000000,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: at(NOW), ...row }); },
    fixProgressJudge: async () => ({ verdict: "change-approach", reason: "different transport", approach: "refresh credentials first" }) });
  assert.equal(approach, "refresh credentials first");
});

test("a change-approach constraint reaches the hosted fix child envelope", async () => {
  const rows: Record<string, unknown>[] = [failure(NOW - 1000), failure(NOW - 500)];
  let envelopeApproach: string | undefined;
  installDetachedWorkHost({ hosts: new Set(["review", "fix-dispatch"]), mode: () => "on",
    spawnReview: async () => undefined,
    spawnFix: async ({ envelope }) => { envelopeApproach = envelope.evidence.progressApproach; return undefined; } });
  try {
    await runSweep([pr], { arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => {},
      runId: "hosted-approach", ledgerPath: "/unused", now: () => NOW + 1000000,
      detachFixWait: true,
      readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: at(NOW), ...row }); },
      fixProgressJudge: async () => ({ verdict: "change-approach", reason: "different transport",
        approach: "refresh credentials first" }) });
    assert.equal(envelopeApproach, "refresh credentials first");
  } finally { installDetachedWorkHost(undefined); }
});
