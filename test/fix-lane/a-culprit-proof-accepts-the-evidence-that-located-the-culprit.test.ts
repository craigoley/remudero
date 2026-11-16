import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BaseProbeOutcome, BaseProbeResult } from "#src/lib/base-reproduction.js";
import { appendLedger } from "#src/lib/ledger.js";
import { buildMainHealthRung, type MainRepairLane } from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";

// W1-T13136 — the culprit proof of a located red reads the probe evidence that located it, per failing
// test file. Each case writes a `main.repair.located` row in the shape the ledger held (2026-11-02 to
// 2026-11-16) and drives buildMainHealthRung to the stalled fix, where the revert is opened or withheld.

const GREEN = "a".repeat(40);
const PARENT = "b".repeat(40);
const CULPRIT = "c".repeat(40);
const RED = "d".repeat(40);
const HEAD = "e".repeat(40);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const result = (outcome: BaseProbeOutcome, files: readonly string[]): BaseProbeResult =>
  files.map((file) => ({ file, outcome, cached: false, duration_ms: 1 }));
const local = (sha: string, outcomes: BaseProbeResult, verdict: string) =>
  ({ sha, verdict, run_url: null, method: "local-test", files: outcomes.map((o) => o.file), outcomes });
const ci = (sha: string, verdict: string, runId: number) =>
  ({ sha, verdict, run_url: `https://github.com/o/r/actions/runs/${runId}` });

function stall(t: { after: (fn: () => void) => void }, shape: {
  checks: readonly string[];
  failing: readonly string[];
  testFiles: readonly string[];
  probeRuns: ReadonlyArray<Record<string, unknown>>;
  probeFailingChecks?: readonly string[];
}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-culprit-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const reverts: string[] = [];
  const reproduced: string[] = [];
  const chain = [GREEN, PARENT, CULPRIT, RED, HEAD];
  const histories = [HEAD, RED, CULPRIT, PARENT, GREEN].map((sha, i) => ({
    id: 100 + i, name: "CI", head_sha: sha, status: "completed",
    conclusion: sha === GREEN ? "success" : sha === PARENT || sha === CULPRIT ? "cancelled" : "failure",
  }));
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/"))?.replace("repos/o/r", "") ?? "";
    if (args.includes("--method")) return {};
    if (path === "") return { default_branch: "main" };
    if (path === "/commits/main") return { sha: HEAD };
    if (path.endsWith("/check-runs?per_page=100")) {
      return { check_runs: shape.checks.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "failure" })) };
    }
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.startsWith("/actions/runs?")) return { workflow_runs: histories };
    const id = Number(/\/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
    if (id) {
      const conclusion = histories.find((run) => run.id === id)?.conclusion;
      return { jobs: shape.checks.map((name, i) => ({ id: id * 10 + i, name, status: "completed", conclusion })) };
    }
    const sha = /^\/commits\/([a-f0-9]{40})$/.exec(path)?.[1];
    if (sha) return { parents: [{ sha: chain[chain.indexOf(sha) - 1] }], files: [{ filename: "src/lib/daemon.ts", additions: 1 }] };
    throw new Error(`unexpected API read ${path}`);
  }) as GhApiFetcher;
  const lane: MainRepairLane = {
    reproduceAt: async (sha, files) => { reproduced.push(sha); return result("passes", files); },
    openFixPr: async () => "https://github.com/o/r/pull/1",
    readPr: async () => ({ state: "closed" }),
    openRevertPr: async (request) => { reverts.push(request.offendingSha); return { prUrl: "https://github.com/o/r/pull/2" }; },
    probes: {
      dispatch: async (sha) => ({ sha, ref: `rmd-attribution/${sha}` }),
      read: async () => ({ status: "running" }),
      release: async () => {},
      readRunnerLoad: async () => ({ queuedJobs: 1, idleRunners: 0 }),
    },
  };
  appendLedger(ledgerPath, {
    task_id: "MAIN-HEALTH", run_id: "LOCATED", step: "main.repair.located", offending_sha: CULPRIT, method: "bisected-first-red",
    bisection_of: RED, parent_sha: PARENT, failing_checks: [...shape.checks], red_checks: [...shape.checks],
    test_files: [...shape.testFiles], probe_runs: shape.probeRuns, probe_failing_checks: [...(shape.probeFailingChecks ?? [])],
  });
  appendLedger(ledgerPath, { task_id: "MAIN-HEALTH", run_id: "LOCATED", step: "main.repair.fix_opened", offending_sha: CULPRIT, pr_url: "https://github.com/o/r/pull/1" });
  let clock = Date.now();
  const rung = buildMainHealthRung("o", "r", {
    fetch, ledgerPath, runId: "CULPRIT-PROOF", log: () => {}, now: () => clock,
    issues: { create: async () => "https://github.com/o/r/issues/1", listOpen: async () => [], comment: async () => {}, closeWithComment: async () => {} },
    readRequiredChecks: () => [...shape.checks],
    readCiFailures: () => shape.checks.map((name) => ({ name, conclusion: "FAILURE", logTail: shape.failing.join("\n") })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
  });
  return {
    reverts,
    reproduced,
    settle: async () => { for (let i = 0; i < 8; i++) { clock += 60_000; await rung(); await flush(); } },
    withheld: () => readLedgerLines(ledgerPath).filter((row) => row.step === "main.repair.revert_withheld"), // ledger-read-intent: live
  };
}

const file = (name: string) => `test/${name}.test.ts`;

test("W1-T13136 criterion 1: a culprit that fails a file its parent passes is proven when the runs name other files too", async (t) => {
  const [a, b, c, d, e, f] = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(file);
  const shapes = [
    // 5e3cabf0b: located test_files 3 files, both probe runs 4 files; the current failures name one more.
    { failing: [a, file("unprobed")], testFiles: [a, b, c],
      culprit: [...result("fails", [a]), ...result("passes", [b, c]), ...result("fails", [d])],
      parent: [...result("passes", [a, b, c]), ...result("unrunnable", [e])] },
    // dc74720ea: test_files 5 files, culprit probe 6 files, parent probe 5 files.
    { failing: [a, b, c, d, e], testFiles: [a, b, c, d, e],
      culprit: [...result("unrunnable", [a]), ...result("fails", [b]), ...result("passes", [c, d, e]), ...result("fails", [f])],
      parent: [...result("passes", [b, c, d, e]), ...result("unrunnable", [a])] },
  ];
  for (const shape of shapes) {
    const run = stall(t, {
      checks: ["ci"], failing: shape.failing, testFiles: shape.testFiles,
      probeRuns: [local(CULPRIT, shape.culprit, "red"), local(PARENT, shape.parent, "inconclusive")],
    });
    await run.settle();
    assert.deepEqual(run.reverts, [CULPRIT], JSON.stringify(run.withheld()));
    assert.equal(run.withheld().length, 0);
    assert.deepEqual(run.reproduced, [], "the proof reads the located row; it runs nothing");
  }
});

test("W1-T13136 criterion 2: a CI probe red on this red stands in for the culprit's unrunnable local run", async (t) => {
  // 580877d7c: the culprit's local run timed out (LoopBoundedChildTimeout after 412 s), so the lane probed
  // in CI; run 43728060756 read red on coverage-ratchet and test-slow; the parent's local run of 2 files passed.
  const tick = file("the-tick-reads-run-off-the-event-loop");
  const run = stall(t, {
    checks: ["coverage-ratchet", "test-slow"], failing: [tick], testFiles: [tick],
    probeRuns: [ci(CULPRIT, "red", 43728060756), local(PARENT, result("passes", [tick, file("a-neighbour")]), "green")],
    probeFailingChecks: ["coverage-ratchet", "test-slow"],
  });
  await run.settle();
  assert.deepEqual(run.reverts, [CULPRIT], JSON.stringify(run.withheld()));
  assert.equal(run.withheld().length, 0);
});

test("W1-T13136 criterion 3: invariant:same-file-contrast withholds the revert and names each file's two outcomes", async (t) => {
  const [a, b] = [file("alpha"), file("bravo")];
  const cases = [
    { why: "red at both", checks: ["ci"], probeFailingChecks: [] as string[],
      runs: [local(CULPRIT, result("fails", [a]), "red"), local(PARENT, result("fails", [a]), "red")],
      names: [`${a}: culprit local fails, first parent local fails`, `${b}: culprit no run, first parent no run`] },
    { why: "the parent passes another file", checks: ["ci"], probeFailingChecks: [] as string[],
      runs: [local(CULPRIT, [...result("fails", [a]), ...result("passes", [b])], "red"), local(PARENT, result("passes", [b]), "green")],
      names: [`${a}: culprit local fails, first parent no run`, `${b}: culprit local passes, first parent local passes`] },
    { why: "the CI probe is red on another red", checks: ["ci"], probeFailingChecks: ["lint"],
      runs: [ci(CULPRIT, "red", 7), local(PARENT, result("passes", [a, b]), "green")],
      names: [`${a}: culprit CI probe red on lint (not this repair's ci`, `${b}: culprit CI probe red on lint`] },
    { why: "a local fail elsewhere hides the CI red", checks: ["ci"], probeFailingChecks: ["ci"],
      runs: [ci(CULPRIT, "red", 8), local(CULPRIT, [...result("fails", [b]), ...result("unrunnable", [a])], "red"),
        local(PARENT, [...result("passes", [a]), ...result("fails", [b])], "red")],
      names: [`${a}: culprit local unrunnable, first parent local passes`, `${b}: culprit local fails, first parent local fails`] },
  ];
  for (const shape of cases) {
    const run = stall(t, { checks: shape.checks, failing: [a, b], testFiles: [a], probeRuns: shape.runs, probeFailingChecks: shape.probeFailingChecks });
    await run.settle();
    assert.deepEqual(run.reverts, [], shape.why);
    const reason = String(run.withheld()[0]?.reason);
    assert.match(reason, /local culprit proof needs one failing test file red at the culprit/, shape.why);
    for (const said of shape.names) assert.ok(reason.includes(said), `${shape.why}: ${reason} names ${said}`);
  }
});

test("W1-T13136 criterion 4: invariant:timeout-is-not-a-fail, an unrunnable culprit with no CI probe run is not proven", async (t) => {
  const [a, b] = [file("the-tick-reads-run-off-the-event-loop"), file("bravo")];
  for (const culprit of [result("unrunnable", [a]), [...result("unrunnable", [a]), ...result("passes", [b])], result("absent", [a, b])]) {
    const run = stall(t, {
      checks: ["ci"], failing: [a], testFiles: [a, b],
      probeRuns: [local(CULPRIT, culprit, "inconclusive"), local(PARENT, result("passes", [a, b]), "green")],
    });
    await run.settle();
    assert.deepEqual(run.reverts, [], JSON.stringify(culprit));
    const reason = String(run.withheld()[0]?.reason);
    assert.ok(reason.includes(`${a}: culprit local ${culprit[0]!.outcome}, first parent local passes`), reason);
  }
});
