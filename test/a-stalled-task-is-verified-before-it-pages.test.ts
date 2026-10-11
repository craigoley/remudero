import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchBreakerCache, DISPATCH_BREAKER_JUDGED_STEP, evaluateDispatchBreakerDetailed, readLedgerLines } from "../src/lib/status.js";
import { productionDispatchBreakJudge } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { appendLedger } from "../src/lib/ledger.js";
import { onCircuitBreakWithVerifier } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";
import {
  decideStallVerdict,
  fingerprintStallEvidence,
  STALL_VERIFIED_STEP,
  stallShardFingerprint,
  verifyStalledTask,
  type DispatchBreakInput,
  type StallEvidence,
} from "../src/lib/stall-verifier.js";

/**
 * W1-T4678 — "a circuit-broken task pages the operator with no diagnosis". These tests prove
 * the cheap-lane verifier's own contract: it reads the evidence (breaker counts, refusal
 * reasons, PR states, shard hash) and returns one of exactly four outcomes (design (i)), and it
 * runs at most once per new evidence fingerprint (design (ii)) rather than re-verifying —
 * and re-ledgering — identical evidence on every tick.
 */

function withLedger<T>(name: string, fn: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}`));
  try {
    return fn(join(dir, "ledger.ndjson"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ctx = (ledgerPath: string) => ({ repo: "r", ledgerPath, runId: "RUN-STALL" });

const baseEvidence: StallEvidence = {
  freshCount: 3,
  excludedByReason: {},
  hasNewOwnedPr: false,
  prStates: [],
  shardHash: "shard-a",
};

test("W1-T4678: the verifier returns one of its four outcomes from the evidence", () => {
  const cases: Array<{ name: string; evidence: StallEvidence; kind: "amend" | "retire" | "requeue" | "escalate" }> = [
    {
      name: "a merged PR the breaker's own scan missed",
      evidence: { ...baseEvidence, prStates: ["merged"] },
      kind: "amend",
    },
    {
      name: "every exclusion was an orphaned run, nothing fresh remains",
      evidence: { ...baseEvidence, freshCount: 0, excludedByReason: { orphaned_run: 4 } },
      kind: "requeue",
    },
    {
      name: "a closed unmerged PR with no open PR observed, nothing excluded",
      evidence: { ...baseEvidence, freshCount: 2, prStates: ["closed_unmerged"] },
      kind: "retire",
    },
    {
      name: "no cheap disposition applies",
      evidence: { ...baseEvidence, freshCount: 5, excludedByReason: { failed: 1 } },
      kind: "escalate",
    },
  ];
  const seen = new Set<string>();
  for (const c of cases) {
    const verdict = decideStallVerdict(c.evidence);
    assert.equal(verdict.kind, c.kind, `${c.name}: expected ${c.kind}, got ${verdict.kind}`);
    seen.add(verdict.kind);
  }
  // All four of design (i)'s outcomes are reachable from evidence alone, not just three of them.
  assert.deepEqual([...seen].sort(), ["amend", "escalate", "requeue", "retire"]);

  assert.equal(
    decideStallVerdict({ ...baseEvidence, hasNewOwnedPr: true }).kind,
    "escalate",
    "an old pr.opened row does not prove a merge or missed credit",
  );

  withLedger("all-verdicts", (ledgerPath) => {
    for (const [index, c] of cases.entries()) {
      const taskId = `W1-VERDICT-${index}`;
      const first = verifyStalledTask(taskId, c.evidence, ctx(ledgerPath));
      const second = verifyStalledTask(taskId, c.evidence, ctx(ledgerPath));
      assert.equal(first.alreadyVerified, false, `${c.name}: first decision is new`);
      assert.equal(second.alreadyVerified, true, `${c.name}: unchanged decision is reused`);
      assert.deepEqual(second.verdict, first.verdict, `${c.name}: the saved verdict survives reuse`);
    }
    assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === STALL_VERIFIED_STEP).length, 4);
  });

  // escalate is the only outcome that names an owner — the "escalate with a named owner and the
  // reason" half of design (i).
  const escalateVerdict = decideStallVerdict(cases[3].evidence);
  assert.equal(escalateVerdict.kind, "escalate");
  if (escalateVerdict.kind === "escalate") {
    assert.ok(escalateVerdict.owner.length > 0);
    assert.ok(escalateVerdict.reason.length > 0);
  }
});

test("W1-T4678: an unchanged fingerprint is never verified twice", () => {
  withLedger("unchanged-fp", (ledgerPath) => {
    const first = verifyStalledTask("W1-STALL", baseEvidence, ctx(ledgerPath));
    assert.equal(first.alreadyVerified, false);

    // Same task, byte-identical evidence, called again (e.g. the next daemon tick before
    // anything about the task has changed): the SAME fingerprint must not re-verify.
    const second = verifyStalledTask("W1-STALL", baseEvidence, ctx(ledgerPath));
    assert.equal(second.alreadyVerified, true);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.deepEqual(second.verdict, first.verdict);

    const rows = readLedgerLines(ledgerPath).filter((l) => l.step === STALL_VERIFIED_STEP);
    assert.equal(rows.length, 1, "exactly one verified row for an unchanged fingerprint, never two");

    // A genuinely NEW fingerprint (the shard changed — an amended proof) DOES verify again:
    // "once per new fingerprint" is not "once per task, ever".
    const changed: StallEvidence = { ...baseEvidence, shardHash: "shard-b" };
    assert.notEqual(fingerprintStallEvidence(changed), fingerprintStallEvidence(baseEvidence));
    const third = verifyStalledTask("W1-STALL", changed, ctx(ledgerPath));
    assert.equal(third.alreadyVerified, false);
    const rowsAfter = readLedgerLines(ledgerPath).filter((l) => l.step === STALL_VERIFIED_STEP);
    assert.equal(rowsAfter.length, 2);
  });
});

test("W1-T4678: a different task with the same evidence is verified independently", () => {
  withLedger("cross-task", (ledgerPath) => {
    verifyStalledTask("W1-A", baseEvidence, ctx(ledgerPath));
    const other = verifyStalledTask("W1-B", baseEvidence, ctx(ledgerPath));
    assert.equal(other.alreadyVerified, false, "a sibling task's identical evidence is its own fingerprint row, not borrowed dedup");
  });
});

test("W1-T4678: an incomplete marker cannot certify an unperformed verification", () => {
  withLedger("incomplete-marker", (ledgerPath) => {
    appendLedger(ledgerPath, {
      run_id: "aborted",
      task_id: "W1-INCOMPLETE",
      repo: "r",
      step: STALL_VERIFIED_STEP,
      fingerprint: fingerprintStallEvidence(baseEvidence),
      disposition: "escalate",
    });
    const result = verifyStalledTask("W1-INCOMPLETE", baseEvidence, ctx(ledgerPath));
    assert.equal(result.alreadyVerified, false);
    assert.equal(result.verdict.kind, "escalate");
    assert.equal(verifyStalledTask("W1-INCOMPLETE", baseEvidence, ctx(ledgerPath)).alreadyVerified, true);
    assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === STALL_VERIFIED_STEP).length, 2);
  });
});

test("W1-T4678: the fingerprint is a pure function of the evidence, order-independent", () => {
  const a: StallEvidence = { ...baseEvidence, excludedByReason: { failed: 1, orphaned_run: 2 } };
  const b: StallEvidence = { ...baseEvidence, excludedByReason: { orphaned_run: 2, failed: 1 } };
  assert.equal(fingerprintStallEvidence(a), fingerprintStallEvidence(b));
});

test("W1-T4678: the shard fingerprint changes when the task's own acceptance proof is amended", () => {
  const before = stallShardFingerprint({ acceptance: [{ claim: "x", proof: "y" }], files: ["a.ts"] } as never);
  const after = stallShardFingerprint({ acceptance: [{ claim: "x", proof: "z" }], files: ["a.ts"] } as never);
  assert.notEqual(before, after);
});

test("W1-T4678: provisional amend and retire verdicts keep the circuit-breaker page", () => {
  withLedger("offline-backstop", (ledgerPath) => {
    const pages: string[] = [];
    const issues = {
      create: (title: string) => {
        pages.push(title);
        return `https://github.com/acme/widgets/issues/${pages.length}`;
      },
    };
    const detail = {
      state: "tripped" as const,
      ledgerState: "tripped" as const,
      freshCount: 3,
      excludedDispatches: 0,
      excludedByReason: {},
      maxDispatches: 3,
      hasNewOwnedPr: true,
    };
    const gate = { detailFor: () => detail };
    const task = (id: string): Task => ({
      id,
      title: "offline verifier fixture",
      repo: "acme/widgets",
      depends_on: [],
      type: "implement",
      verify: "auto",
      risk: "medium",
      status: "blocked",
      attempts: 3,
    });
    const ctx = { owner: "acme", repo: "widgets", ledgerPath, runId: "offline-replay", issues };
    onCircuitBreakWithVerifier(gate, () => ({ merged: true }), ctx)(task("W1-AMEND"));
    onCircuitBreakWithVerifier(gate, () => ({ prState: "CLOSED" }), ctx)(task("W1-RETIRE"));

    assert.equal(pages.length, 2, "provisional diagnoses must not silently suppress the backstop");
    const rows = readLedgerLines(ledgerPath);
    assert.deepEqual(
      rows.filter((row) => row.step === STALL_VERIFIED_STEP).map((row) => row.disposition),
      ["amend", "retire"],
    );
    assert.equal(rows.filter((row) => row.step === "dispatch.circuit_broken.escalated").length, 2);
  });
});

// ── W1-T7742: THE BREAKER SPENDS ITS BUDGET ONLY ON WORKER FAILURES, AND ITS BOUND ASKS A JUDGE ──────────────
// MEASURED 2026-10-11 on the live ledger: W1-T7742 tripped at freshCount 5 with seven runs, none of them a
// worker failing the task — two node_modules refusals, an orphan-free run killed by a restart, a claim race,
// the harness's pre-push gate refusing its checkpoint push, and two restart yields.
function w1t7742History(taskId: string): Record<string, unknown>[] {
  const runs: Array<[string, Record<string, unknown> | undefined]> = [
    ["1", { verdict: "failed", stage: "worktree.node_modules" }],
    ["2", { verdict: "failed", stage: "worktree.node_modules" }],
    ["3", undefined], // started, recon ran, killed by a restart before any verdict
    ["4", { verdict: "blocked_inflight", reason: "already claimed by another lane" }],
    ["5", { verdict: "no_pr", reason: "restart_checkpoint_failed" }],
    ["6", { verdict: "handed_off", reason: "freshness_yield" }],
    ["7", { verdict: "handed_off", reason: "freshness_yield" }],
  ];
  const rows: Record<string, unknown>[] = [];
  runs.forEach(([n, verdict], i) => {
    const runId = `${taskId}-${n}`;
    const ts = (minute: number) => new Date(Date.UTC(2026, 9, 11, 0, i * 10 + minute)).toISOString();
    rows.push({ ts: ts(0), run_id: runId, task_id: taskId, step: "run.start" });
    rows.push({ ts: ts(1), run_id: runId, task_id: taskId, step: "recon.done" });
    if (verdict) rows.push({ ts: ts(2), run_id: runId, task_id: taskId, step: "verdict", ...verdict });
  });
  return rows;
}

const tripped = (freshCount: number) => ({ state: "tripped" as const, ledgerState: "tripped" as const, freshCount,
  excludedDispatches: 0, excludedByReason: {}, maxDispatches: 5, hasNewOwnedPr: false });
const breakerTask = (id: string): Task => ({ id, title: "dispatch-break fixture", repo: "acme/widgets", depends_on: [],
  type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 5 });

test("W1-T7742: yields, claim races and refused checkpoints never spend the dispatch breaker", () => {
  withLedger("w1t7742-exclusions", (ledgerPath) => {
    for (const row of w1t7742History("W1-T7742")) appendLedger(ledgerPath, row as never);
    const detail = evaluateDispatchBreakerDetailed(ledgerPath, "W1-T7742", createDispatchBreakerCache());
    assert.equal(detail.freshCount, 1, "only the run a restart killed mid-attempt is left to count");
    assert.equal(detail.state, "clear");
    assert.deepEqual(detail.excludedByReason, { "worktree.node_modules": 2, blocked_inflight: 1,
      restart_checkpoint_failed: 1, handed_off: 2 });
  });
});

test("W1-T7742: a judge's continue ruling resets a tripped streak, even inside a live process", () => {
  withLedger("judge-continue", (ledgerPath) => {
    for (let i = 0; i < 5; i++) {
      appendLedger(ledgerPath, { run_id: `W1-LOOP-${i}`, task_id: "W1-LOOP", step: "run.start" } as never);
      appendLedger(ledgerPath, { run_id: `W1-LOOP-${i}`, task_id: "W1-LOOP", step: "verdict", verdict: "no_pr", reason: "worker_no_commit" } as never);
    }
    const cache = createDispatchBreakerCache();
    assert.equal(evaluateDispatchBreakerDetailed(ledgerPath, "W1-LOOP", cache).state, "tripped");
    appendLedger(ledgerPath, { run_id: "J", task_id: "W1-LOOP", step: DISPATCH_BREAKER_JUDGED_STEP, decision: "continue" } as never);
    const after = evaluateDispatchBreakerDetailed(ledgerPath, "W1-LOOP", cache);
    assert.equal(after.state, "clear", "the same cache reads the reset as the reset it is, never indeterminate");
    assert.equal(after.freshCount, 0);
  });
});

test("W1-T7742: a tripped breaker pages only when its judge rules escalate", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-route`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    for (let i = 0; i < 5; i++) {
      appendLedger(ledgerPath, { run_id: `W1-J-${i}`, task_id: "W1-J", step: "verdict", verdict: "no_pr", reason: `attempt ${i}` } as never);
    }
    const pages: string[] = [];
    const issues = { create: (title: string) => { pages.push(title); return `https://github.com/acme/widgets/issues/${pages.length}`; } };
    const gate = { detailFor: () => tripped(5) };
    const inputs: DispatchBreakInput[] = [];
    const base = { owner: "acme", repo: "widgets", ledgerPath, runId: "judge-route", issues };

    await onCircuitBreakWithVerifier(gate, () => undefined, { ...base,
      judge: async (input) => { inputs.push(input); return { verdict: "continue", reason: "each attempt got further" }; } })(breakerTask("W1-J"));
    assert.equal(pages.length, 0, "a continue ruling never pages");
    assert.equal(inputs[0]?.attempts.length, 5, "the judge reads every attributable attempt");
    const judged = readLedgerLines(ledgerPath).filter((row) => row.step === DISPATCH_BREAKER_JUDGED_STEP);
    assert.deepEqual(judged.map((row) => row.decision), ["continue"]);

    await onCircuitBreakWithVerifier(gate, () => undefined, { ...base,
      judge: async () => ({ verdict: "escalate", loop: "the same proof fails", reason: "no progress" }) })(breakerTask("W1-K"));
    await onCircuitBreakWithVerifier(gate, () => undefined, { ...base,
      judge: async () => { throw new Error("provider down"); } })(breakerTask("W1-L"));
    await onCircuitBreakWithVerifier(gate, () => undefined, { ...base, judge: async () => undefined })(breakerTask("W1-M"));
    assert.equal(pages.length, 3, "escalate, a throwing judge and an unparseable ruling each keep the page");
    const rulings = readLedgerLines(ledgerPath).filter((row) => row.step === DISPATCH_BREAKER_JUDGED_STEP).map((row) => row.decision);
    assert.deepEqual(rulings, ["continue", "escalate", "unavailable", "unavailable"]);

    let asked = 0;
    await onCircuitBreakWithVerifier(gate, () => undefined, { ...base,
      judge: async () => { asked++; return { verdict: "continue", reason: "late" }; } })(breakerTask("W1-K"));
    assert.equal(asked, 0, "a settled escalate ruling for an unchanged state is never re-asked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7742: the production dispatch-break judge asks the risk mount with no tools", async () => {
  let prompt = "";
  const judge = productionDispatchBreakJudge({ cwd: ".", settingsFile: "settings/worker.json",
    mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn: async (args) => {
      prompt = args.prompt;
      assert.deepEqual(args.tools, []);
      return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"progress"}' } as never;
    } });
  const input: DispatchBreakInput = { taskId: "W1-P", freshCount: 5, excludedByReason: {}, attempts: [], priorRulings: [],
    stall: { kind: "escalate", owner: "operator", reason: "none" } };
  assert.equal((await judge(input))?.verdict, "continue");
  assert.match(prompt, /no hard attempt ceiling/);
  const failed = productionDispatchBreakJudge({ cwd: ".", settingsFile: "settings/worker.json",
    mount: { model: "m", effort: "low", maxTurns: 1, contextBudget: 1 }, spawn: async () => ({ text: "", subtype: "error_max_turns" }) as never });
  assert.equal(await failed(input), undefined);
});
