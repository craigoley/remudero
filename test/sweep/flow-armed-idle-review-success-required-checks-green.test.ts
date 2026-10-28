import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

function harness(t: TestContext, outcome: "armed" | "direct-merged" | "arm-error-ignored" | undefined = "armed") {
  const root = mkdtempSync(join(tmpdir(), "rmd-flow-armed-idle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const calls: Array<string | undefined> = [];
  const pr: OpenPrView = {
    prNumber: 10620, prUrl: "https://github.com/acme/remudero/pull/10620",
    taskId: "W1-T10620", headSha: "a".repeat(40), autoMergeArmed: false,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
  };
  const deps: SweepDeps = {
    ledgerPath, runId: "flow-armed-idle", readLedgerUnion: () => ({ complete: false, lines: [] }),
    arm: (_pr, mode) => { calls.push(mode); return mode === "armed-idle" ? "direct-merged" : outcome; },
    close: () => {}, dispatchFix: () => {}, escalate: () => {},
  };
  return {
    calls, pr,
    pass: (view = pr, overrides: Partial<SweepDeps> = {}) => runSweep([view], { ...deps, ...overrides }),
    rows: (step: string): Array<Record<string, unknown>> => readFileSync(ledgerPath, "utf8")
      .trim().split("\n").map(line => JSON.parse(line)).filter(row => row.step === step),
  };
}

test("W1-T10620: flow-armed-idle-review-success-required-checks-green clears without a person", async t => {
  const h = harness(t);
  await h.pass();
  assert.deepEqual(h.calls, [undefined]);
  assert.equal(h.rows("automerge.armed_idle").length, 1);
  assert.equal(h.rows("automerge.arm_skipped")[0].armed_idle_observed, true);
  const armed = { ...h.pr, autoMergeArmed: true };
  await h.pass(armed, { repairAdmissionSurface: "light" });
  assert.deepEqual(h.calls, [undefined], "a light pass cannot complete the idle arm");
  const completed = await h.pass(armed);
  assert.deepEqual(h.calls, [undefined, "armed-idle"]);
  assert.equal(completed.actionsTaken, 1);
  assert.equal(h.rows("automerge.armed_idle_merged")[0].head_sha, h.pr.headSha);
});

for (const outcome of ["direct-merged", "arm-error-ignored", undefined] as const) {
  test(`a ${String(outcome)} arm outcome does not earn an idle sighting`, async t => {
    const h = harness(t, outcome);
    // Explicitly supply a legacy void result; an omitted harness argument defaults to armed.
    await h.pass(h.pr, outcome === undefined ? { arm: () => {} } : {});
    assert.equal(h.rows("automerge.armed_idle").length, 0);
  });
}

test("a successful light-pass arm does not earn a full-pass idle sighting", async t => {
  const h = harness(t);
  await h.pass(h.pr, { repairAdmissionSurface: "light" });
  assert.deepEqual(h.calls, [undefined]);
  assert.equal(h.rows("automerge.armed_idle").length, 0);
});
