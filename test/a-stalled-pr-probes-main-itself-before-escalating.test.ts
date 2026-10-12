import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { BASE_REPRODUCTION_MAX_FILES, type BaseProbeFile } from "../src/lib/base-reproduction.js";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const MAIN = "b".repeat(40);
const HEAD = "a".repeat(40);
const FILE = "test/operator-agent-scan-routes-never-block-the-loop.test.ts";
const PR = 6433;
type Row = Record<string, unknown>;

function redPr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "W1-T6433",
    headSha: HEAD, headRefName: "run-W1-T6433-1", reviewState: "pending", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(1), autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: `not ok 1 - ${FILE}` }], ...overrides,
  };
}

function stalled(pr = redPr()): Row {
  return { ts: ago(50), step: "sweep.disposed", pr_number: pr.prNumber, task_id: pr.taskId,
    head_sha: pr.headSha, disposition: "blocked-fixable", acted: false,
    blocker: "own-red", blocker_since: ago(50) };
}

function passing(file: string): BaseProbeFile {
  return { file, outcome: "passes", duration_ms: 9, cached: false };
}

function harness(history: Row[] = [stalled()], overrides: Partial<SweepDeps> = {}) {
  const rows = [...history];
  const probes: { pr: number; files: readonly string[]; sha: string }[] = [];
  const refreshed: number[] = [];
  const fixes: number[] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {}, actionable: () => false,
    dispatchFix: pr => { fixes.push(pr.prNumber); },
    escalate: (_pr, reason) => { escalations.push(reason); },
    updateBranch: pr => { refreshed.push(pr.prNumber); return "updated"; },
    readMainTip: () => MAIN, behindMainByPr: new Map([[PR, 3]]),
    reproduceFailingTestsOnMain: async (pr, files, sha) => {
      probes.push({ pr: pr.prNumber, files: [...files], sha });
      return files.map(passing);
    },
    ledgerPath: "/dev/null/w1-t6433.ndjson", runId: "W1-T6433-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, ...overrides,
  };
  return { rows, probes, refreshed, fixes, escalations, deps };
}

test("W1-T6433: a stalled PR with no cached probe probes main itself and refreshes when main fixed it", async () => {
  const h = harness();
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.probes, [{ pr: PR, files: [FILE], sha: MAIN }]);
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.escalations, []);
  assert.deepEqual(h.fixes, []);
  const probe = h.rows.find(row => row.step === "sweep.base_reproduction");
  assert.ok(probe);
  assert.equal(probe.pr_number, PR);
  assert.equal(probe.head_sha, HEAD);
  assert.equal(probe.main_sha, MAIN);
  assert.equal(probe.verdict, "clear");
  assert.deepEqual(probe.files, [passing(FILE)]);
  const refresh = h.rows.find(row => row.step === "sweep.base_fixed.refresh");
  assert.ok(refresh);
  assert.equal(refresh.main_sha, MAIN);
  assert.equal(refresh.outcome, "updated");
  assert.deepEqual(refresh.test_files, [FILE]);
  assert.equal(h.rows.find(row => row.step === "pr.stuck")?.diagnosis, "fixed-on-main");
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(h.probes.length, 1);
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.escalations, []);
});

test("W1-T6433: stalled stages and the fix rung share one current-main probe per file", async () => {
  const other = redPr({ prNumber: PR + 1, prUrl: `https://github.com/acme/remudero/pull/${PR + 1}`,
    taskId: "W1-T6434", headRefName: "run-W1-T6434-1" });
  const green = redPr({ prNumber: 6000, prUrl: "https://github.com/acme/remudero/pull/6000",
    taskId: "W1-T6000", headRefName: "run-W1-T6000-1", checksState: "green", reviewState: "success", ciFailures: [] });
  const h = harness([stalled(), stalled(other)], { behindMainByPr: new Map([[PR, 3], [other.prNumber, 3]]) });
  await runSweep([redPr(), other, green], h.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(h.probes.length, 1);
  assert.equal(h.refreshed.length, 1, "the existing refresh limit admits one PR per pass");
  await runSweep([other], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR, other.prNumber]);
  assert.equal(h.probes.length, 1, "the ledger survives the next pass");
  const fresh = redPr({ prNumber: PR + 2, prUrl: `https://github.com/acme/remudero/pull/${PR + 2}`,
    taskId: "W1-T6435", headRefName: "run-W1-T6435-1" });
  await runSweep([fresh], { ...h.deps, actionable: () => true,
    behindMainByPr: new Map([[fresh.prNumber, 3]]) }, DEFAULT_SWEEP_POLICY);
  assert.equal(h.probes.length, 1, "the fix rung also reuses the stalled-stage probe");
  assert.deepEqual(h.refreshed, [PR, other.prNumber, fresh.prNumber]);
  assert.deepEqual(h.fixes, []);
});

test("W1-T6433: only missing files at the current main tip are probed", async () => {
  const second = "test/second.test.ts";
  const h = harness([stalled(),
    { step: "sweep.base_reproduction", main_sha: MAIN, files: [passing(FILE)] },
    { step: "sweep.base_reproduction", main_sha: "c".repeat(40), files: [passing(second)] },
  ]);
  await runSweep([redPr({ ciFailures: [{ name: "ci", logTail: `${FILE}\n${second}` }] })], h.deps);
  assert.deepEqual(h.probes, [{ pr: PR, files: [second], sha: MAIN }]);
  const probe = h.rows.findLast(row => row.step === "sweep.base_reproduction");
  assert.deepEqual(probe?.files, [{ ...passing(FILE), cached: true }, passing(second)]);
  assert.deepEqual(h.refreshed, [PR]);
});

test("W1-T6433: cached fix-rung results do not run another stalled-stage probe", async () => {
  const h = harness([stalled(), { step: "sweep.base_reproduction", main_sha: MAIN, files: [passing(FILE)] }]);
  await runSweep([redPr()], h.deps);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.escalations, []);
});

test("W1-T6433: a failing or partial main probe keeps the stalled-stage escalation", async () => {
  for (const outcomes of [["fails"], ["fails", "passes"]] as const) {
    const files = outcomes.map((_outcome, i) => `test/failure-${i}.test.ts`);
    const h = harness(undefined, { reproduceFailingTestsOnMain: async () =>
      outcomes.map((outcome, i) => ({ ...passing(files[i]), outcome })) });
    await runSweep([redPr({ ciFailures: [{ name: "ci", logTail: files.join("\n") }] })], h.deps);
    assert.deepEqual(h.refreshed, []);
    assert.equal(h.escalations.length, 1);
    assert.equal(h.rows.find(row => row.step === "sweep.base_reproduction")?.verdict,
      outcomes.length === 1 ? "reproduced" : "partial");
  }
});

test("W1-T6433: an unrunnable probe escalates with its reason and never refreshes", async () => {
  for (const reproduce of [
    async () => { throw new Error("checkout denied"); },
    async () => [{ ...passing(FILE), outcome: "unrunnable" as const, reason: "proof timeout" }],
    async () => [{ ...passing(FILE), outcome: "unrunnable" as const }],
    async () => [],
    async () => Object.assign([], { reason: "probe refused" }),
  ]) {
    const h = harness(undefined, { reproduceFailingTestsOnMain: reproduce });
    await runSweep([redPr()], h.deps);
    assert.deepEqual(h.refreshed, []);
    assert.equal(h.escalations.length, 1);
    assert.match(h.escalations[0], /main reproduction unrunnable/);
    const probe = h.rows.find(row => row.step === "sweep.base_reproduction");
    assert.ok(probe);
    assert.equal(probe.verdict, "unrunnable");
    assert.match(h.escalations[0], /checkout denied|proof timeout|probe returned no outcome|probe refused/);
  }
});

test("W1-T6433: partial probes preserve the reason a file could not run", async () => {
  const second = "test/second.test.ts";
  const h = harness(undefined, { reproduceFailingTestsOnMain: async () => [
    { ...passing(FILE), outcome: "fails" },
    { ...passing(second), outcome: "unrunnable", reason: "proof timeout" },
  ] });
  await runSweep([redPr({ ciFailures: [{ name: "ci", logTail: `${FILE}\n${second}` }] })], h.deps);
  assert.deepEqual(h.refreshed, []);
  assert.equal(h.rows.find(row => row.step === "sweep.base_reproduction")?.verdict, "partial");
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0], /main reproduction unrunnable \(proof timeout\)/);
});

test("W1-T6433: a missing probe seam is named in the escalation", async () => {
  const h = harness(undefined, { reproduceFailingTestsOnMain: undefined });
  await runSweep([redPr()], h.deps);
  assert.deepEqual(h.refreshed, []);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0], /main reproduction unavailable/);
});

test("W1-T6433: oversized stalled-stage probes stay bounded and name the refusal", async () => {
  const files = Array.from({ length: BASE_REPRODUCTION_MAX_FILES + 1 }, (_value, i) => `test/file-${i}.test.ts`);
  const h = harness();
  await runSweep([redPr({ ciFailures: [{ name: "ci", logTail: files.join("\n") }] })], h.deps);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.refreshed, []);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0], /too many test files/);
  const probe = h.rows.find(row => row.step === "sweep.base_reproduction");
  assert.ok(probe);
  assert.equal(probe.verdict, "unrunnable");
  assert.deepEqual(probe.files, []);
});

test("W1-T6433: heads without evidence of being behind main keep their escalation", async () => {
  for (const overrides of [
    { behindMainByPr: new Map([[PR, 0]]) },
    { behindMainByPr: undefined },
    { readMainTip: undefined },
  ]) {
    const h = harness(undefined, overrides);
    await runSweep([redPr()], h.deps);
    assert.deepEqual(h.probes, []);
    assert.deepEqual(h.refreshed, []);
    assert.equal(h.escalations.length, 1);
    assert.match(h.escalations[0], /unknown signature/);
  }
});
