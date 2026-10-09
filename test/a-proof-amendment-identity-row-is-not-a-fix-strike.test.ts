import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, fixLedgerRowsForHead, isProofAmendmentIdentityRow, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { Config } from "../src/lib/config-schema.js";
import { buildProofAmendmentWritePorts, deriveStrikeHistory, priorStrikesFor } from "../src/run-task.js";

// W1-T5032 — `recordIdentity` appends an UNNUMBERED `fix.dispatch` row (`kind: proof_amendment`) that exists only
// for idempotency. `fixLedgerRowsForHead` fed it to both strike tallies, so a worker strike plus the amendment's own
// row read 2 against a cap of 2. The row is now dropped at that one chokepoint; the row itself is untouched.

const TASK = "W1-T5032-FIXTURE";
const HEAD = "head-1111";
const NOW = Date.parse("2026-07-17T12:00:00Z");

/** Rows the REAL `recordIdentity` port logs, captured through its `log` seam. */
function identityRowsFromRealPort(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const ports = buildProofAmendmentWritePorts({
    taskId: TASK,
    worktreePath: "/repo",
    config: {} as Config,
    owner: "acme",
    repo: "remudero",
    prNumber: 77,
    ledgerLinesNow: rows,
    log: (step, extra) => {
      rows.push({ step, ...(extra ?? {}) });
    },
    gitOps: { gitAdd: () => {}, gitCommit: () => "sha" },
  });
  ports.recordIdentity("key-1", { amendmentUrl: "https://github.com/acme/remudero/pull/9001", amendmentNumber: 9001, merged: false });
  return rows;
}

function workerStrike(strike: number, head: string = HEAD, regime?: string): Record<string, unknown> {
  return { task_id: TASK, step: "fix.dispatch", strike, head_sha: head, ...(regime ? { verdict_regime: regime } : {}) };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-amend-id-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5032,
    prUrl: "https://github.com/o/r/pull/5032",
    taskId: TASK,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 1,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322: ..." }],
    ...over,
  };
}

function fakeDeps(lp: string): SweepDeps & { fixed: OpenPrView[] } {
  const fixed: OpenPrView[] = [];
  return {
    fixed,
    arm: () => {},
    close: () => {},
    dispatchFix: (p) => {
      fixed.push(p);
    },
    escalate: () => {},
    ledgerPath: lp,
    runId: "SWEEP-1",
    now: () => NOW,
  };
}

test("W1-T5032: the identity row a proof amendment writes leaves the strike tally below the cap", () => {
  const identity = identityRowsFromRealPort();
  assert.equal(identity.length, 1);
  assert.equal(identity[0]!.kind, "proof_amendment");
  assert.equal(identity[0]!.step, "fix.dispatch");
  const lines = [{ ...workerStrike(1) }, { task_id: TASK, step: "sweep.disposed", head_sha: HEAD }, ...identity];
  // The real writer's row carries no task_id when logged through a bare `log`, so stamp the ledger's own envelope.
  const stamped = lines.map((l) => ({ task_id: TASK, ...l }));
  assert.equal(priorStrikesFor(stamped, TASK, "keyword_only", HEAD), 1);
  assert.equal(priorStrikesFor(stamped, TASK, "keyword_only"), 1);
  assert.ok(priorStrikesFor(stamped, TASK, "keyword_only", HEAD) < DEFAULT_SWEEP_POLICY.strikeCap);
  assert.equal(deriveStrikeHistory(stamped, TASK, HEAD).length, 1);
});

test("W1-T5032: a proof-amendment identity row is not a strike under either regime", () => {
  const identity = identityRowsFromRealPort().map((l) => ({ task_id: TASK, ...l }));
  assert.equal(isProofAmendmentIdentityRow(identity[0]!), true);
  for (const regime of ["keyword_only", "executed"] as const) {
    for (const head of [undefined, HEAD] as const) {
      const lines = [workerStrike(1, HEAD, regime), ...identity, { ...identity[0]!, head_sha: HEAD }];
      assert.equal(priorStrikesFor(lines, TASK, regime, head), 1, `${regime} / head=${String(head)}`);
      assert.equal(fixLedgerRowsForHead(lines, TASK, head).length, 1, `${regime} / head=${String(head)} rows`);
    }
  }
  assert.equal(isProofAmendmentIdentityRow({ step: "fix.dispatch", strike: 1 }), false);
  assert.equal(isProofAmendmentIdentityRow({ step: "fix.review", kind: "proof_amendment" }), false);
});

test("W1-T5032: a worker strike plus an amendment identity row still dispatches under the claim", async () => {
  const lp = ledgerPath();
  appendLedger(lp, { run_id: "SWEEP-0", task_id: TASK, step: "fix.dispatch", strike: 1, head_sha: HEAD });
  appendLedger(lp, { run_id: "SWEEP-0", task_id: TASK, step: "sweep.disposed", head_sha: HEAD, pr_number: 5032 });
  appendLedger(lp, { run_id: "SWEEP-0", task_id: TASK, step: "fix.dispatch", kind: "proof_amendment", pr_number: 5032, identity_key: "k", amendment_url: "u", amendment_number: 9001 });
  const deps = fakeDeps(lp);
  const summary = await runSweep([pr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.fixed.length, 1, "the fix worker is dispatched, the amendment row spent no strike");
  assert.equal(summary.actions[0]!.acted, true);
});

test("W1-T5032: a real worker dispatch still counts toward the cap", async () => {
  const lp = ledgerPath();
  for (let i = 1; i <= DEFAULT_SWEEP_POLICY.strikeCap; i++) {
    appendLedger(lp, { run_id: "SWEEP-0", task_id: TASK, step: "fix.dispatch", strike: i, head_sha: HEAD });
  }
  appendLedger(lp, { run_id: "SWEEP-0", task_id: TASK, step: "fix.dispatch", kind: "proof_amendment", identity_key: "k" });
  const lines = readLedgerLines(lp);
  assert.equal(priorStrikesFor(lines, TASK, "keyword_only", HEAD), DEFAULT_SWEEP_POLICY.strikeCap);
  const deps = fakeDeps(lp);
  const summary = await runSweep([pr({ priorStrikes: 0 })], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.fixed.length, 0);
  assert.equal(summary.actions[0]!.acted, false);
  const rows = readLedgerLines(lp).filter((l) => l.step === "sweep.disposed" && l.pr_number === 5032);
  assert.match(String(rows[rows.length - 1]?.stand_down_reason), /fix progress loop: fix strikes exhausted at former ceiling 2/);
});

test("W1-T5032: the identity row is still written and resolved by its key", () => {
  const rows: Array<Record<string, unknown>> = [];
  const ports = buildProofAmendmentWritePorts(
    {
      taskId: TASK,
      worktreePath: "/repo",
      config: {} as Config,
      owner: "acme",
      repo: "remudero",
      prNumber: 77,
      get ledgerLinesNow() {
        return rows;
      },
      log: (step, extra) => {
        rows.push({ step, ...(extra ?? {}) });
      },
      gitOps: { gitAdd: () => {}, gitCommit: () => "sha" },
    },
    { isPrMergedNowFn: () => false },
  );
  assert.equal(ports.lookupIdentity("key-1"), undefined);
  ports.recordIdentity("key-1", { amendmentUrl: "https://github.com/acme/remudero/pull/9001", amendmentNumber: 9001, merged: false });
  assert.equal(rows.length, 1, "the row is still written");
  assert.deepEqual(
    { step: rows[0]!.step, kind: rows[0]!.kind, identity_key: rows[0]!.identity_key },
    { step: "fix.dispatch", kind: "proof_amendment", identity_key: "key-1" },
  );
  assert.deepEqual(ports.lookupIdentity("key-1"), { amendmentUrl: "https://github.com/acme/remudero/pull/9001", amendmentNumber: 9001, merged: false });
  assert.equal(ports.lookupIdentity("other-key"), undefined);
});
