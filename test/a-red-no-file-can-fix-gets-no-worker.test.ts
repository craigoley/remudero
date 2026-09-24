import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { prMetadataRestArgs, repairPrMetadata, scopeAmendmentFromFixReport } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

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
    assert.ok(h.rows.some((row) => row.step === "sweep.disposed" && row.metadata_repair_outcome === "repaired"));
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
    // W1-T4459: the attempted red set rides the dispatch pass's OWN "sweep.disposed" row (an
    // already decision-relevant step) rather than a separate "sweep.fix_attempt" step.
    { task_id: "W1-T4459", step: "sweep.disposed", pr_number: 4459, head_sha: "head-a", disposition: "blocked-fixable", acted: true, red_checks: ["ci"] },
    { task_id: "W1-T4459", step: "fix.commit_refused", head_sha: "head-a", reason: "the worker changed nothing" },
  );
  await runSweep([subject(["ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, []);
  assert.ok(h.rows.some((row) =>
    row.step === "sweep.disposed" && typeof row.stand_down_reason === "string" &&
    row.stand_down_reason.includes("the worker changed nothing")));

  await runSweep([subject(["test:ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, ["head-a"], "a changed red check re-earns a worker");

  const changedHead = harness();
  changedHead.rows.push(...h.rows.slice(0, 2));
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
    { task_id: "W1-T4459", step: "sweep.disposed", pr_number: 4459, head_sha: "head-a", disposition: "blocked-fixable", acted: true, red_checks: ["ci"] },
    { task_id: "W1-T4459", step: "fix.commit_refused", head_sha: "head-a", reason: "scope refused", scope_amendment_detail: "src/lib/needed.ts is needed" },
  );
  await runSweep([subject(["ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, []);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0], /scope amendment.*src\/lib\/needed.ts/);
  await runSweep([subject(["ci"])], h.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(h.escalations.length, 1);
});

test("metadata repair refuses every edit it cannot derive safely, naming why", async () => {
  const cases: Array<[string[], { title?: string; body?: string }, RegExp]> = [
    [["commitlint"], { body: "b" }, /title is unavailable/],
    [["commitlint"], { title: "  " }, /title is unavailable/],
    [["commitlint"], { title: "fix(pr): already valid" }, /already satisfies commitlint/],
    [["commitlint"], { title: "fix: ." }, /candidate PR title did not satisfy commitlint/],
    [["acceptance-author-gate"], { title: "fix(pr): valid" }, /body is unavailable/],
    [[], { title: "Broken title", body: "b" }, /no title or body edit was derived/],
  ];
  for (const [checks, live, reason] of cases) {
    let writes = 0;
    const result = await repairPrMetadata(subject(checks), checks, () => { writes++; }, () => live);
    assert.equal(result.repaired, false, JSON.stringify(live));
    assert.match(result.reason, reason);
    assert.equal(writes, 0, "a refused repair must never write metadata");
  }
});

test("metadata repair's default seams read and write the live PR through the real gh", async () => {
  const shim = ghShim(
    [{ when: "pulls/4459", stdout: JSON.stringify({ title: "Broken title", body: "b" }) }],
    { kind: "metadata-repair-gh" },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    const result = await repairPrMetadata(subject(), ["commitlint"]);
    assert.equal(result.repaired, true);
    const calls = shim.calls();
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^api repos\/acme\/remudero\/pulls\/4459/);
    assert.equal(calls[1], "api -X PATCH repos/acme/remudero/pulls/4459 -f title=fix(pr): broken title");
    await assert.rejects(() => repairPrMetadata({ prUrl: "not a pr url" }, ["commitlint"]), /cannot resolve PR URL/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("the sweep's metadata-repair effect reports an unwired implementation instead of editing", async () => {
  const base = {
    owner: "acme",
    repo: "remudero",
    config: { root: "/nonexistent" } as Config,
    ledgerPath: "/nonexistent/ledger.ndjson",
    runId: "SWEEP-W1-T4459-effects",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {},
  };
  const unwired = buildSweepEffects(base).repairMetadata;
  assert.ok(unwired, "the builder must always expose the effect");
  assert.deepEqual(await unwired(subject(), ["commitlint"]), {
    repaired: false,
    reason: "metadata repair implementation is not wired",
  });
  const seen: string[][] = [];
  const wired = buildSweepEffects({
    ...base,
    repairMetadataImpl: async (_pr, checks) => { seen.push([...checks]); return { repaired: true, reason: "edited title" }; },
  }).repairMetadata;
  assert.ok(wired);
  assert.deepEqual(await wired(subject(), ["commitlint"]), { repaired: true, reason: "edited title" });
  assert.deepEqual(seen, [["commitlint"]]);
});
