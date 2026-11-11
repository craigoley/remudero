import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import * as recovery from "#src/lib/stale-fix-dispatch-recovery.js";
import {
  STALE_FIX_DISPATCH_RECEIPT_STEP,
  decideStaleFixDispatchRecovery,
  staleFixDispatchRecoveryReceipt,
  type StaleFixDispatchExpected,
  type StaleFixDispatchFacts,
} from "#src/lib/stale-fix-dispatch-recovery.js";
import { derivePrOwnerVerdict, prOwnerCommand } from "#src/run-task.js";

const HEAD = "a".repeat(40);
const HEAD_PLUS_ONE = "b".repeat(40);
const BASE = "c".repeat(40);
const PRIOR_CLAIM = "SWEEP-1:fix-claim:4851:1794000000000";
const INVOCATION = "RECOVER-1";

function expected(over: Partial<StaleFixDispatchExpected> = {}): StaleFixDispatchExpected {
  return {
    repo: "acme/remudero",
    prNumber: 4851,
    taskId: "W1-TSTALE",
    dispatchRunId: "FIX-1",
    dispatchRoundId: "round-1",
    headSha: HEAD,
    baseSha: BASE,
    branch: "run-W1-TSTALE-1",
    authorizationId: "AUTH-1",
    recoveryInvocationRunId: INVOCATION,
    ...over,
  };
}

function facts(over: Partial<StaleFixDispatchFacts> = {}): StaleFixDispatchFacts {
  const { recoveryInvocationRunId: _i, priorFixBranchClaimRunId: _p, ...observed } = expected();
  return {
    observed,
    latestDispatch: { runId: "FIX-1", roundId: "round-1", ts: "2026-11-10T00:00:00.000Z" },
    process: { state: "dead", pid: 4242, host: "host-a", startedAt: "2026-11-10T00:00:00.000Z" },
    descendants: { state: "none" },
    cwdCensus: { state: "clear" },
    fixBranchClaim: { state: "clear" },
    dispatchClaim: { state: "clear" },
    preservation: { state: "published", recoveryRef: "refs/rmd-recovery/W1-TSTALE/1", sha: "d".repeat(40) },
    ledgerRead: { ok: true },
    ...over,
  };
}

const reclaimedPrior = (over: Record<string, unknown> = {}) => ({
  run_id: PRIOR_CLAIM,
  dispatchRunId: "FIX-1",
  claimMs: 1794000000000,
  host: "host-a",
  pid: 4242,
  startedAt: "2026-11-10T00:00:00.000Z",
  rawSha256: "e".repeat(64),
  compareAndReclaim: "matched" as const,
  ...over,
});

const observedWith = (over: Record<string, unknown>) => ({ ...facts().observed, ...over });

test("W1-T12113 identity mismatch holds", () => {
  assert.deepEqual(decideStaleFixDispatchRecovery(expected(), facts()), { kind: "recover" });
  assert.deepEqual(
    decideStaleFixDispatchRecovery(expected(), facts({ preservation: { state: "nothing_to_preserve", headContained: true } })),
    { kind: "recover" },
  );
  // An exact new claim owned by this invocation recovers.
  assert.deepEqual(
    decideStaleFixDispatchRecovery(expected(), facts({ fixBranchClaim: { state: "held", holderRunId: INVOCATION } })),
    { kind: "recover" },
  );
  // A dead same-host claim for the exact prior dispatch, compare-and-reclaimed, recovers.
  const reclaiming = expected({ priorFixBranchClaimRunId: PRIOR_CLAIM });
  assert.deepEqual(
    decideStaleFixDispatchRecovery(reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior() },
    })),
    { kind: "recover" },
  );

  const cases: Array<[string, StaleFixDispatchExpected, StaleFixDispatchFacts]> = [
    ["ledger_unreadable", expected(), facts({ ledgerRead: { ok: false, unread: ["ledger.x.ndjson.gz"] } })],
    ["ledger_unreadable", expected(), facts({ latestDispatch: undefined })],
    ["authorization_missing", expected({ authorizationId: undefined }), facts()],
    ["identity_mismatch:repo", expected(), facts({ observed: observedWith({ repo: "acme/other" }) })],
    ["identity_mismatch:pr", expected(), facts({ observed: observedWith({ prNumber: 4852 }) })],
    ["identity_mismatch:task", expected(), facts({ observed: observedWith({ taskId: "W1-TOTHER" }) })],
    ["identity_mismatch:run", expected(), facts({ observed: observedWith({ dispatchRunId: "FIX-2" }) })],
    ["identity_mismatch:round", expected(), facts({ observed: observedWith({ dispatchRoundId: "round-2" }) })],
    ["identity_mismatch:head", expected(), facts({ observed: observedWith({ headSha: HEAD_PLUS_ONE }) })],
    ["identity_mismatch:head", expected({ headSha: "abc123" }), facts({ observed: observedWith({ headSha: "abc123" }) })],
    ["identity_mismatch:base", expected(), facts({ observed: observedWith({ baseSha: "f".repeat(40) }) })],
    ["identity_mismatch:branch", expected(), facts({ observed: observedWith({ branch: "run-W1-TSTALE-2" }) })],
    ["identity_mismatch:authorization", expected(), facts({ observed: observedWith({ authorizationId: "AUTH-2" }) })],
    ["newer_dispatch", expected(), facts({ latestDispatch: { runId: "FIX-2", ts: "2026-11-10T01:00:00.000Z" } })],
    ["process_alive", expected(), facts({ process: { state: "alive", pid: 4242, host: "host-a" } })],
    ["process_reused", expected(), facts({ process: { state: "reused", pid: 4242, host: "host-a" } })],
    ["process_unknown", expected(), facts({ process: { state: "unknown", pid: 4242 } })],
    ["process_foreign_host", expected(), facts({ process: { state: "foreign_host", pid: 4242, host: "host-b" } })],
    ["liveness_unrecorded", expected(), facts({ process: { state: "unrecorded" } })],
    ["liveness_unrecorded", expected(), facts({ process: { state: "dead" } })],
    ["descendants_present", expected(), facts({ descendants: { state: "present", pids: [4243] } })],
    ["descendants_unknown", expected(), facts({ descendants: { state: "unknown" } })],
    ["cwd_occupied", expected(), facts({ cwdCensus: { state: "occupied" } })],
    ["cwd_unknown", expected(), facts({ cwdCensus: { state: "unknown" } })],
    ["competing_branch_claim_held", expected(), facts({ fixBranchClaim: { state: "held", holderRunId: "OTHER-RUN" } })],
    ["branch_claim_unknown", expected(), facts({ fixBranchClaim: { state: "unknown" } })],
    ["stale_claim_identity_mismatch", expected(), facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior() },
    })],
    ["stale_claim_identity_mismatch", reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior({ compareAndReclaim: "mismatch" }) },
    })],
    ["stale_claim_identity_mismatch", reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior({ claimMs: 1 }) },
    })],
    ["stale_claim_identity_mismatch", reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior({ dispatchRunId: "FIX-0" }) },
    })],
    ["stale_claim_liveness_unknown", reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior({ host: "host-b" }) },
    })],
    ["stale_claim_liveness_unknown", reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior({ pid: 9999 }) },
    })],
    ["stale_claim_liveness_unknown", reclaiming, facts({
      fixBranchClaim: { state: "held", holderRunId: INVOCATION, reclaimedPrior: reclaimedPrior({ startedAt: "2026-11-10T05:00:00.000Z" }) },
    })],
    ["dispatch_claim_held", expected(), facts({ dispatchClaim: { state: "held", holder: "refs/rmd-dispatch/W1-TSTALE" } })],
    ["dispatch_claim_unknown", expected(), facts({ dispatchClaim: { state: "unknown" } })],
    ["preservation_failed", expected(), facts({ preservation: { state: "failed", reason: "push refused" } })],
    ["preservation_unknown", expected(), facts({ preservation: { state: "unknown", reason: "not gathered" } })],
    ["preservation_unknown", expected(), facts({ preservation: { state: "published", recoveryRef: "refs/heads/x", sha: HEAD } })],
  ];
  for (const [reason, exp, fact] of cases) {
    assert.deepEqual(decideStaleFixDispatchRecovery(exp, fact), { kind: "hold", reason }, reason);
  }
});

test("W1-T12113 recovery receipt is stable", () => {
  const meta = { actor: "operator", nowIso: "2026-11-11T00:00:00.000Z", reason: "worker gone" };
  const held = staleFixDispatchRecoveryReceipt(expected(), facts({ process: { state: "alive", pid: 4242, host: "host-a" } }), meta);
  const released = staleFixDispatchRecoveryReceipt(expected(), facts(), { ...meta, nowIso: "2026-11-11T01:00:00.000Z" });
  assert.equal(held.outcome, "held");
  assert.equal(held.hold_reason, "process_alive");
  assert.equal(released.outcome, "released");
  assert.equal(released.hold_reason, undefined);
  assert.match(released.recovery_id, /^[0-9a-f]{64}$/);
  assert.equal(held.recovery_id, released.recovery_id);
  assert.notEqual(
    staleFixDispatchRecoveryReceipt(expected({ authorizationId: "AUTH-2" }), facts(), meta).recovery_id,
    released.recovery_id,
  );
  assert.notEqual(
    staleFixDispatchRecoveryReceipt(expected({ dispatchRunId: "FIX-2" }), facts(), meta).recovery_id,
    released.recovery_id,
  );
  assert.deepEqual(
    { ...released, liveness: undefined, preservation: undefined },
    {
      step: STALE_FIX_DISPATCH_RECEIPT_STEP,
      recovery_id: released.recovery_id,
      repo: "acme/remudero",
      pr_number: 4851,
      task_id: "W1-TSTALE",
      prior_run_id: "FIX-1",
      prior_round_id: "round-1",
      prior_dispatch_ts: "2026-11-10T00:00:00.000Z",
      head_sha: HEAD,
      base_sha: BASE,
      branch: "run-W1-TSTALE-1",
      authorization_id: "AUTH-1",
      liveness: undefined,
      preservation: undefined,
      actor: "operator",
      ts: "2026-11-11T01:00:00.000Z",
      reason: "worker gone",
      outcome: "released",
    },
  );
  assert.equal(STALE_FIX_DISPATCH_RECEIPT_STEP, "pr_owner.recovery_receipt");
  assert.equal(released.liveness.process.state, "dead");
  assert.equal(released.liveness.cwd_census.state, "clear");
  assert.equal(released.preservation.state, "published");

  // A plan-only PR (changed paths only under plan/) decides and builds a receipt exactly like a code PR.
  const plan = { taskId: "W1-TPLANONLY", branch: "run-W1-TPLANONLY-1", changedPaths: ["plan/tasks.d/W1-TPLANONLY.yaml"] };
  const planOnly = expected({ taskId: plan.taskId, branch: plan.branch });
  const planFacts = facts({ observed: observedWith({ taskId: plan.taskId, branch: plan.branch }) });
  assert.ok(plan.changedPaths.every((path) => path.startsWith("plan/")));
  assert.deepEqual(decideStaleFixDispatchRecovery(planOnly, planFacts), { kind: "recover" });
  assert.deepEqual(
    decideStaleFixDispatchRecovery(planOnly, { ...planFacts, process: { state: "alive", pid: 4242, host: "host-a" } }),
    { kind: "hold", reason: "process_alive" },
  );
  const planReceipt = staleFixDispatchRecoveryReceipt(planOnly, planFacts, meta);
  assert.deepEqual(Object.keys(planReceipt).sort(), Object.keys(staleFixDispatchRecoveryReceipt(expected(), facts(), meta)).sort());
  assert.equal(planReceipt.outcome, "released");
  assert.equal(planReceipt.task_id, plan.taskId);
  for (const receipt of [held, released, planReceipt]) {
    for (const forbidden of ["credit", "credited", "merge", "merged", "fix.done", "fix_done", "status"]) {
      assert.equal(Object.hasOwn(receipt, forbidden), false, forbidden);
    }
  }
});

test("W1-T12113 decision export exists", () => {
  assert.equal(typeof recovery.decideStaleFixDispatchRecovery, "function");
  assert.equal(typeof recovery.staleFixDispatchRecoveryReceipt, "function");
  assert.equal(recovery.STALE_FIX_DISPATCH_RECEIPT_STEP, "pr_owner.recovery_receipt");
});

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    try {
      out[name] = readFileSync(join(dir, name)).toString("base64");
    } catch (error) {
      out[name] = `unreadable:${(error as NodeJS.ErrnoException).code ?? "?"}`;
    }
  }
  return out;
}

test("W1-T12113 pr-owner shadow preserves owner and receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-stale-fix-recovery-"));
  try {
    mkdirSync(join(dir, "inflight"), { recursive: true });
    const dispatch = {
      ts: "2026-11-10T00:00:00.000Z", step: "fix.dispatch", task_id: "W1-TSTALE", run_id: "FIX-1",
      pr_number: 4851, strike: 1, strike_cap: 2, mode: "ci-log", head_sha: HEAD,
    };
    writeFileSync(join(dir, "ledger.2026-11-10T00-01-00-000Z.ndjson.gz"), gzipSync(Buffer.from(JSON.stringify(dispatch) + "\n")));
    writeFileSync(join(dir, "ledger.ndjson"), "");
    const before = snapshot(dir);

    const out: string[] = [];
    assert.equal(await prOwnerCommand(["4851"], { stateDir: dir, write: (text) => out.push(text) }), 0);
    const text = out.join("\n");
    assert.match(text, /rmd pr-owner #4851 .+ OWNED/);
    assert.match(text, /reason: fix\.dispatch found for this pull request/);
    assert.match(text, /recovery_shadow: HOLD reason=authorization_missing/);
    assert.deepEqual(snapshot(dir), before, "the shadow writes no receipt file and no ledger row");

    const corpus = {
      rows: [dispatch], archiveFiles: [join(dir, "ledger.2026-11-10T00-01-00-000Z.ndjson.gz")],
      liveFileRead: true, ok: true, unread: [], filesRead: 2,
    };
    const verdict = derivePrOwnerVerdict(4851, corpus);
    assert.equal(verdict.verdict, "OWNED");
    assert.deepEqual(verdict.recoveryShadow, { outcome: "hold", reason: "authorization_missing" });
    const { recoveryShadow: _shadow, ...owner } = verdict;
    const free = derivePrOwnerVerdict(4851, { ...corpus, rows: [] });
    assert.equal(free.verdict, "FREE");
    assert.equal(free.recoveryShadow, undefined, "no latest fix.dispatch emits no shadow field");
    assert.equal(owner.reason, "fix.dispatch found for this pull request");
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
