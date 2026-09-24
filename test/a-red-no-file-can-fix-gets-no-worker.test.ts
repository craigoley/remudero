import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { prMetadataRestArgs, repairPrMetadata, scopeAmendmentFromFixReport } from "../src/run-task.js";

function subject(checks: string[] = ["commitlint"], headSha = "head-a"): OpenPrView {
  return {
    prNumber: 4459,
    prUrl: "https://github.com/acme/remudero/pull/4459",
    taskId: "W1-T4459",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    headSha,
    autoMergeArmed: false,
    body: "## Acceptance\n\n- a claim | unit test: a proof\n",
    ciFailures: checks.map((name) => ({ name, logTail: "failed" })),
    redRequiredChecks: checks,
  };
}

function harness() {
  const rows: Array<Record<string, unknown>> = [];
  const dispatched: string[] = [];
  const repairs: string[][] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr) => { dispatched.push(pr.headSha); },
    repairMetadata: (_pr, checks) => { repairs.push([...checks]); return { repaired: true, reason: "edited title" }; },
    escalate: (_pr, reason) => { escalations.push(reason); },
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-metadata-red-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T4459",
    readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); },
    log: () => {},
  };
  return { deps, rows, dispatched, repairs, escalations };
}

test("W1-T4459: a title or body red is repaired without a fix worker", async () => {
  for (const checks of [["commitlint"], ["acceptance-author-gate"], ["proof-discrimination"]]) {
    const h = harness();
    await runSweep([subject(checks)], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.repairs, [checks]);
    assert.deepEqual(h.dispatched, []);
    assert.ok(h.rows.some((row) => row.step === "sweep.metadata_repair" && row.outcome === "repaired"));
    await runSweep([subject(checks)], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.repairs, [checks], "a stale red at the unchanged head must not repeat the edit");
  }
  const pendingAggregate = harness();
  await runSweep([{ ...subject(["commitlint"]), checksState: "pending" }], pendingAggregate.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(pendingAggregate.repairs, [["commitlint"]], "an observed required child red wins over a pending aggregate");
  assert.deepEqual(pendingAggregate.dispatched, []);
  const mixed = harness();
  await runSweep([{
    ...subject(["commitlint"]),
    reviewState: "failure",
    unmetCriteria: [{ claim: "implementation works", proof: "unit test: implementation works", met: false, reason: "failed", proof_exec: "executed_fail" }],
  }], mixed.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(mixed.repairs, [], "a failing review is another required red and must not be treated as metadata-only");
});

test("W1-T4459: a refused round is not re-dispatched at the same head and red", async () => {
  const h = harness();
  h.rows.push(
    { task_id: "W1-T4459", step: "sweep.fix_attempt", pr_number: 4459, head_sha: "head-a", red_checks: ["ci"] },
    { task_id: "W1-T4459", step: "fix.commit_refused", head_sha: "head-a", reason: "the worker changed nothing" },
    { task_id: "W1-T4459", step: "sweep.disposed", pr_number: 4459, head_sha: "head-a", disposition: "blocked-fixable", acted: true },
  );
  await runSweep([subject(["ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, []);
  assert.ok(h.rows.some((row) => row.step === "sweep.fix_refusal_stand_down" && row.reason === "the worker changed nothing"));

  await runSweep([subject(["test:ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, ["head-a"], "a changed red check re-earns a worker");

  const changedHead = harness();
  changedHead.rows.push(...h.rows.slice(0, 3));
  await runSweep([subject(["ci"], "head-b")], changedHead.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(changedHead.dispatched, ["head-b"], "a changed head re-earns a worker");
});

test("metadata repair writes a live title and body in one PR edit", async () => {
  const writes: Array<{ title?: string; body?: string }> = [];
  const result = await repairPrMetadata(
    subject(),
    ["commitlint", "acceptance-author-gate"],
    (_url, fields) => { writes.push(fields); },
    () => ({ title: "Broken title", body: "A short summary." }),
  );
  assert.equal(result.repaired, true);
  assert.match(writes[0].title ?? "", /^fix\(pr\): broken title$/);
  assert.match(writes[0].body ?? "", /Acceptance:/);
  assert.deepEqual(prMetadataRestArgs(subject().prUrl, writes[0]), [
    "api", "-X", "PATCH", "repos/acme/remudero/pulls/4459",
    "-f", `title=${writes[0].title}`, "-f", `body=${writes[0].body}`,
  ]);
});

test("a body red with no safe mechanical repair escalates without writing metadata", async () => {
  let writes = 0;
  const result = await repairPrMetadata(
    subject(["proof-discrimination"]),
    ["proof-discrimination"],
    () => { writes++; },
    () => ({ title: "fix(pr): valid title", body: "## Acceptance\n\n- a claim | unit test: existing proof\n" }),
  );
  assert.equal(result.repaired, false);
  assert.equal(writes, 0);
});

test("a refused report requesting an out-of-scope file routes to a scope amendment", async () => {
  assert.equal(
    scopeAmendmentFromFixReport("REPORT\nREFUSED:\n1. [outside-declared-files] src/lib/needed.ts is needed\n"),
    "src/lib/needed.ts is needed",
  );
  assert.equal(
    scopeAmendmentFromFixReport("## Follow-ups\ntask: amend declared files to include src/lib/needed.ts\n"),
    "amend declared files to include src/lib/needed.ts",
  );
  const h = harness();
  h.rows.push(
    { task_id: "W1-T4459", step: "sweep.fix_attempt", pr_number: 4459, head_sha: "head-a", red_checks: ["ci"] },
    { task_id: "W1-T4459", step: "fix.commit_refused", head_sha: "head-a", reason: "scope refused", scope_amendment_detail: "src/lib/needed.ts is needed" },
    { task_id: "W1-T4459", step: "sweep.disposed", pr_number: 4459, head_sha: "head-a", disposition: "blocked-fixable", acted: true },
  );
  await runSweep([subject(["ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, []);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0], /scope amendment.*src\/lib\/needed.ts/);
  await runSweep([subject(["ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(h.escalations.length, 1);
});
