import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSweepEffects, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import type { ArmReprobeFacts } from "../src/lib/arm-auto-merge.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";

const now = Date.parse("2026-10-04T12:00:00Z");
const pr: OpenPrView = {
  prNumber: 10, prUrl: "https://github.com/craigoley/remudero/pull/10", taskId: "W1-A",
  headSha: "head-a", reviewState: "success", checksState: "green", unmetCriteria: [],
  priorStrikes: 0, lastActivityAt: new Date(now).toISOString(), autoMergeArmed: false,
};

function facts(over: Partial<ArmReprobeFacts> = {}): ArmReprobeFacts {
  return {
    prNumber: pr.prNumber, headSha: pr.headSha, state: "open", autoMergeArmed: false,
    mergeable: true, mergeableState: "clean", baseSha: "base-a",
    reviewPublished: true, checksGreen: true, ...over,
  };
}

function fixture() {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-failed-arm-")), "ledger.ndjson");
  let current = facts({ mergeable: null, mergeableState: "unknown", reviewPublished: false });
  let calls = 0;
  const deps: SweepDeps = {
    ledgerPath, runId: "first", now: () => now,
    arm: () => { calls++; return { outcome: "arm-error-ignored", failureClass: "unknown" }; },
    readArmFacts: async () => current,
    close: () => {}, dispatchFix: () => {}, escalate: () => {},
  };
  return { deps, ledgerPath, calls: () => calls, set: (value: ArmReprobeFacts) => { current = value; } };
}

test("ambiguous or wrong-head evidence never reopens a failed arm", async (t) => {
  for (const over of [
    { mergeable: null }, { mergeable: false, mergeableState: "dirty" },
    { mergeableState: "unknown" }, { headSha: "other" }, { prNumber: 11 },
    { state: "closed" }, { checksGreen: false }, { reviewPublished: false },
  ]) await t.test(JSON.stringify(over), async () => {
    const f = fixture();
    await runSweep([pr], f.deps);
    f.set(facts(over));
    const result = await runSweep([pr], { ...f.deps, now: () => now + 60_000 });
    assert.equal(f.calls(), 1);
    assert.equal(result.actions[0].acted, false);
    const row = readLedgerLines(f.ledgerPath).at(-1)!;
    assert.match(String(row.stand_down_reason), /failed arm|evidence/);
    assert.equal(row.arm_outcome, undefined);
  });
});

test("changed attributable facts reopen one failed arm and survive restart", async () => {
  const f = fixture();
  await runSweep([pr], f.deps);
  await runSweep([pr], { ...f.deps, now: () => now + 60_000 });
  assert.equal(f.calls(), 1, "a clock change supplies no evidence");
  f.set(facts());
  await runSweep([pr], { ...f.deps, runId: "second" });
  assert.equal(f.calls(), 2, "fresh published review and resolved mergeability permit one attempt");
  await runSweep([pr], { ...f.deps, runId: "restarted" });
  assert.equal(f.calls(), 2);
  f.set(facts({ baseSha: "base-b" }));
  await runSweep([pr], f.deps);
  assert.equal(f.calls(), 3, "a changed base permits its own attempt");
  f.set(facts());
  await runSweep([pr], f.deps);
  assert.equal(f.calls(), 3, "returning to spent evidence does not spend again");
  const attempts = readLedgerLines(f.ledgerPath).filter(row => row.arm_outcome);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[1].arm_failure_class, "unknown");
  assert.ok(attempts[1].arm_reprobe_previous_failure);
  assert.ok(attempts[1].arm_evidence_fingerprint);
  writeFileSync(f.ledgerPath, JSON.stringify(attempts[0]) + "\n");
  await runSweep([pr], { ...f.deps, runId: "after-rotation" });
  assert.equal(f.calls(), 3, "durable evidence receipts survive loss of a later live ledger row");
});

test("a fresh arm fact does not bypass a standing refusal", async (t) => {
  for (const kind of ["hold", "risk", "capped", "stack", "irreversible", "author"] as const) {
    await t.test(kind, async () => {
      const f = fixture();
      await runSweep([pr], f.deps);
      f.set(facts());
      if (kind === "hold") appendLedger(f.ledgerPath, {
        step: "automerge.hold_engaged", pr_number: pr.prNumber, reason: "operator hold", task_id: "W1-A",
        authority: "interactive-cli", by: "operator", run_id: "hold",
      });
      if (kind === "risk") appendLedger(f.ledgerPath, {
        step: "risk_judge.escalated", pr_number: pr.prNumber, head_sha: pr.headSha,
        task_id: "W1-A", run_id: "risk",
      });
      if (kind === "capped") appendLedger(f.ledgerPath, {
        step: "review.posted", task_id: "W1-A", run_id: "review", head_sha: pr.headSha, state: "success",
        capped: true, proof_exec: ["exec_error"],
      });
      const deps: SweepDeps = { ...f.deps };
      if (kind === "stack") deps.stackPrerequisite = () => ({ state: "blocked", parentNumbers: [9], openParentNumbers: [9] });
      if (kind === "irreversible" || kind === "author") deps.arm = () =>
        kind === "irreversible" ? "irreversible-refused" : "hold-refused";
      const result = await runSweep([pr], deps);
      assert.equal(f.calls(), 1);
      assert.equal(result.actions[0].acted, false);
    });
  }
});

test("publish-complete evidence recovers an actual arm and records success separately from failure", async () => {
  const f = fixture();
  await runSweep([pr], f.deps);
  f.set(facts());
  let calls = 0;
  const deps: SweepDeps = { ...f.deps, arm: () => { calls++; return "armed"; } };
  const result = await runSweep([pr], deps);
  assert.equal(result.actions[0].acted, true);
  await runSweep([pr], deps);
  assert.equal(calls, 1);
  const rows = readLedgerLines(f.ledgerPath).filter(row => row.arm_attempted);
  assert.equal(rows[0].arm_armed, false);
  assert.equal(rows[1].arm_armed, true);
  assert.equal(rows[1].arm_outcome, "armed");
});

test("a review-publication race and concurrent sweep readers spend one evidence state", async () => {
  const f = fixture();
  f.set(facts({ reviewPublished: false }));
  await runSweep([pr], f.deps);
  f.set(facts());
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let reprobes = 0;
  const deps = { ...f.deps, arm: async () => {
    reprobes++; await waiting;
    return { outcome: "arm-error-ignored" as const, failureClass: "unknown" as const };
  } };
  const first = runSweep([pr], deps);
  const second = runSweep([pr], { ...deps, runId: "concurrent" });
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await Promise.all([first, second]);
  assert.equal(reprobes, 1);
  await runSweep([pr], { ...f.deps, runId: "restart" });
  assert.equal(f.calls(), 1);
});

test("the same successful read, an unreadable read and an observed arm cannot spend a reprobe", async () => {
  const f = fixture();
  f.set(facts());
  await runSweep([pr], f.deps);
  await runSweep([pr], f.deps);
  assert.equal(f.calls(), 1);
  await runSweep([pr], { ...f.deps, readArmFacts: async () => undefined });
  await runSweep([pr], { ...f.deps, readArmFacts: async () => { throw new Error("offline"); } });
  f.set(facts({ autoMergeArmed: true }));
  await runSweep([pr], f.deps);
  assert.equal(f.calls(), 1);
  assert.match(String(readLedgerLines(f.ledgerPath).at(-1)?.stand_down_reason), /fresh GitHub observation/);
});

test("transport and base-race failures keep their ordinary retries even with fresh fact reads", async () => {
  for (const failureClass of ["transient", "retryable"] as const) {
    const f = fixture();
    let calls = 0;
    const deps: SweepDeps = { ...f.deps, arm: () => {
      calls++; return { outcome: "arm-error-ignored", failureClass };
    } };
    await runSweep([pr], deps);
    await runSweep([pr], deps);
    assert.equal(calls, 2);
  }
});

test("legacy unknown attempts require a newly delivered exact-input publication", async () => {
  const f = fixture();
  const reviewed = { ...pr, reviewInputDigest: "input-a" };
  appendLedger(f.ledgerPath, { run_id: "legacy", task_id: "W1-A", step: "sweep.disposed",
    pr_number: pr.prNumber, head_sha: pr.headSha, disposition: "mergeable", acted: true,
    arm_outcome: "arm-error-ignored" });
  f.set(facts());
  await runSweep([reviewed], f.deps);
  assert.equal(f.calls(), 0);
  const publication = { run_id: "published", task_id: "W1-A", step: "review.posted",
    pr_url: pr.prUrl, head_sha: pr.headSha, state: "success", proof_exec: ["executed_pass"] };
  appendLedger(f.ledgerPath, { ...publication, review_input_digest: "other-input" });
  await runSweep([reviewed], f.deps);
  assert.equal(f.calls(), 0);
  appendLedger(f.ledgerPath, { ...publication, review_input_digest: "input-a" });
  await runSweep([reviewed], f.deps);
  assert.equal(f.calls(), 1);
});

test("holds arriving during a fresh read are rechecked before claiming evidence", async () => {
  const f = fixture();
  await runSweep([pr], f.deps);
  await runSweep([pr], { ...f.deps, readArmFacts: async () => {
    appendLedger(f.ledgerPath, { run_id: "late-hold", task_id: "W1-A", step: "automerge.hold_engaged",
      pr_number: pr.prNumber, authority: "console-confirmed", by: "operator", reason: "wait" });
    return facts();
  } });
  assert.equal(f.calls(), 1);
  appendLedger(f.ledgerPath, { run_id: "release", task_id: "W1-A", step: "automerge.hold_released",
    pr_number: pr.prNumber, authority: "console-confirmed" });
  f.set(facts());
  await runSweep([pr], { ...f.deps, stackPrerequisite: () => ({ state: "unstacked", parentNumbers: [] }) });
  assert.equal(f.calls(), 2, "the refused hold consumed no evidence claim");
});

test("an unwritable evidence receipt refuses the attempt and carries its error", async () => {
  const f = fixture();
  await runSweep([pr], f.deps);
  f.set(facts());
  const receiptDir = join(f.ledgerPath, "..", "arm-reprobe-evidence");
  rmSync(receiptDir, { recursive: true });
  writeFileSync(receiptDir, "unwritable directory");
  const result = await runSweep([pr], f.deps);
  assert.equal(f.calls(), 1);
  assert.match(result.actions[0].actionError!, /EEXIST/);
});

test("the production fact reader rejects missing checks and superseded failures resolve only on the exact head", async (t) => {
  const f = fixture();
  let published = false;
  let missing = false;
  let unreadable = false;
  let malformed = false;
  let capped = false;
  const logs: Array<Record<string, unknown>> = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root: join(f.ledgerPath, "..") } as Config,
    ledgerPath: f.ledgerPath, runId: "production", plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: (step, extra) => { logs.push({ step, ...extra }); },
    armImpl: () => ({ outcome: "arm-error-ignored", error: "GraphQL: Pull Request is not mergeable" }),
    readJsonImpl: async (args) => {
      if (unreadable) throw new Error("read offline");
      const path = args[1];
      if (path.endsWith("/pulls/10")) return {
        number: 10, state: "open", auto_merge: null, merged: false, draft: false,
        head: { sha: pr.headSha }, base: { sha: "base-a", ref: "main" },
        mergeable: true, mergeable_state: "clean",
      };
      if (path.includes("/protection/")) return { contexts: ["ci-gate", "remudero-review", "extra-required"] };
      if (path.includes("/check-runs?")) return { total_count: capped ? 101 : 3, check_runs: [
        { name: "ci-gate", status: "completed", conclusion: "failure", started_at: "2026-10-04T10:00:00Z", id: 1 },
        { name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-10-04T11:00:00Z", id: 2 },
        ...(missing ? [] : [{ name: "extra-required", status: "completed", conclusion: "success", id: 3 }]),
      ], ...(!capped && missing ? { total_count: 2 } : {}) };
      if (path.endsWith("/status")) return malformed ? {} : {
        sha: pr.headSha, total_count: 1, statuses: [{ context: "remudero-review", state: published ? "success" : "pending" }],
      };
      throw new Error(`unexpected read ${path}`);
    },
  });
  const deps = { ...f.deps, readArmFacts: effects.readArmFacts };
  await runSweep([pr], deps);
  published = true;
  missing = true;
  await runSweep([pr], deps);
  assert.equal(f.calls(), 1, "an absent required context is never successful");
  missing = false;
  await runSweep([pr], deps);
  assert.equal(f.calls(), 2, "the latest successful check and newly published review recover the handoff");
  assert.equal((await effects.arm(pr) as { failureClass: string }).failureClass, "unknown");
  for (const kind of ["transport", "malformed", "truncated"] as const) await t.test(kind, async () => {
    unreadable = kind === "transport";
    malformed = kind === "malformed";
    capped = kind === "truncated";
    assert.equal(await effects.readArmFacts!(pr), undefined);
    assert.match(String(logs.at(-1)?.reason), /read offline|incomplete/);
  });
});
