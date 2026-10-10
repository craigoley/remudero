import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { checkReaderAgreement, type ReaderFigures } from "../src/lib/reader-agreement.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { ghShim } from "./helpers/gh-shim.js";
import { runSweep, type SweepDeps } from "./helpers/sweep-test.js";
import { buildBatchedGithub } from "../src/lib/status.js";

const figures: ReaderFigures = {
  dispatchStreaks: { "W1-T2982": 2 }, openPrCount: 3, queuedTaskCount: 4,
  healthyDeploys: { W1: "2026-09-29T12:00:00.000Z" },
};

test("W1-T4841: two readers that disagree raise a recorded disagreement", async () => {
  const rows: Record<string, unknown>[] = [];
  const result = await checkReaderAgreement({
    ledgerPath: "/unused/ledger.ndjson", runId: "SWEEP-test",
    boardReader: () => ({ ...figures, dispatchStreaks: { "W1-T2982": 1584 }, openPrCount: 6,
      queuedTaskCount: 8, healthyDeploys: { W1: null, W2: "old" } }),
    independentReader: () => figures,
    appendLine: (_path, row) => rows.push(row),
  });
  assert.equal(result.length, 5);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(row => [row.figure, row.subject, row.board_value, row.independent_value]), [
    ["dispatch_streak", "W1-T2982", 1584, 2], ["open_pr_count", "repository", 6, 3],
    ["queued_task_count", "repository", 8, 4],
    ["last_healthy_deploy", "W1", null, "2026-09-29T12:00:00.000Z"],
    ["last_healthy_deploy", "W2", "old", null],
  ]);
  assert.ok(rows.every(row => row.step === "reader.disagreement" && row.run_id === "SWEEP-test"));
});

test("W1-T4841: two readers that agree record nothing", async () => {
  const rows: Record<string, unknown>[] = [];
  assert.deepEqual(await checkReaderAgreement({
    ledgerPath: "/unused/ledger.ndjson", runId: "SWEEP-test",
    boardReader: () => figures, independentReader: () => structuredClone(figures),
    appendLine: (_path, row) => rows.push(row),
  }), []);
  assert.deepEqual(rows, []);
});

function corpus() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reader-agreement-"));
  const task_id = "W1-T2982";
  const row = (step: string, run_id: string, hour: number, fields = {}) =>
    ({ task_id, run_id, step, ts: `2026-09-29T${String(hour).padStart(2, "0")}:00:00.000Z`, ...fields });
  const old = [row("run.start", "before", 1), row("verdict", "before", 2, { verdict: "no_pr" }),
    row("dispatch.breaker_released", "release", 3)];
  const current = [row("run.start", "after-1", 4), row("verdict", "after-1", 5, { verdict: "no_pr" }),
    row("run.start", "after-2", 6), row("verdict", "after-2", 7, { verdict: "no_pr" }),
    row("deploy.ok", "deploy", 8, { instance: "W1" }),
    row("dispatch.circuit_broken", "halt", 9, { task: task_id })];
  const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(dir, "ledger.2026-09-29T09-00-00-000Z.ndjson"), encode([...current, ...old]));
  writeFileSync(join(dir, "ledger.2026-09-29T10-00-00-000Z.ndjson.gz"), gzipSync(encode([...old, ...current])));
  writeFileSync(join(dir, "ledger.ndjson"), encode(current));
  return { dir, path: join(dir, "ledger.ndjson"), row, encode };
}

test("W1-T4841: default readers agree across plain and gzip replays and out-of-order resets", async () => {
  const { path } = corpus();
  const rows: Record<string, unknown>[] = [];
  assert.deepEqual(await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test",
    appendLine: (_path, row) => rows.push(row) }), []);
  assert.deepEqual(rows, []);
});

test("W1-T4841: the independent default detects the historical inflated board streak", async () => {
  const { path } = corpus();
  const rows: Record<string, unknown>[] = [];
  const result = await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test",
    boardReader: () => ({ dispatchStreaks: { "W1-T2982": 1584 },
      healthyDeploys: { W1: "2026-09-29T08:00:00.000Z" } }),
    appendLine: (_path, row) => rows.push(row) });
  assert.deepEqual(result, [{ figure: "dispatch_streak", subject: "W1-T2982", board_value: 1584, independent_value: 2 }]);
  assert.equal(rows.length, 1);
});

test("W1-T4841: independent defaults exclude infrastructure refusals and stale orphan starts", async () => {
  const { path, row, encode } = corpus();
  writeFileSync(path, encode([row("run.start", "infra", 10),
    row("verdict", "infra", 11, { verdict: "blocked_containment" }),
    row("run.start", "orphan", 12), row("cost.anomaly", "orphan", 13),
    row("deploy.ok", "new-deploy", 14)]));
  const result = await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test",
    appendLine: () => {} });
  assert.deepEqual(result, []);
});

test("W1-T4841: real append default persists a disagreement", async () => {
  const { path } = corpus();
  await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-persist",
    boardReader: () => ({ ...figures, openPrCount: 5 }), independentReader: () => figures });
  const { readLedgerLines } = await import("../src/lib/status.js");
  const row = readLedgerLines(path).find(row => row.step === "reader.disagreement");
  assert.equal(row?.run_id, "SWEEP-persist");
  assert.equal(row?.board_value, 5);
  assert.equal(row?.independent_value, 3);
});

test("W1-T4841: defaults compare cached queue with a fresh projection and count every PR page", async () => {
  const { dir, path } = corpus();
  writeFileSync(join(dir, "status.json"), JSON.stringify({ tasks: { stale: { status: "queued" } } }));
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  try {
    const argsSeen: string[][] = [];
    const result = await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test",
      owner: "owner", repo: "repo", plan: loadPlanFromYaml("[]\n", "fixture"), openPrCount: 2,
      readJson: async args => { argsSeen.push(args); return [[{ number: 1 }], [{ number: 2 }, { number: 1 }]]; },
      queueGithub: () => buildBatchedGithub("owner", "repo", { fetchAll: () => [], fetchAllIssues: () => [] }),
      appendLine: () => {} });
    assert.deepEqual(result, [{ figure: "queued_task_count", subject: "repository", board_value: 1, independent_value: 0 }]);
    assert.deepEqual(argsSeen, [["api", "repos/owner/repo/pulls?state=open&per_page=100", "--paginate", "--slurp"]]);
    assert.equal(shim.calls().length, 0, "the queue projection shells no gh of its own");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("W1-T4841: the sweep records disagreements and dry-run writes nothing", async () => {
  const { path } = corpus();
  const rows: Record<string, unknown>[] = [];
  const deps: SweepDeps = {
    ledgerPath: path, runId: "SWEEP-test", arm: () => {}, close: () => {}, dispatchFix: () => {},
    escalate: () => {}, appendLine: (_path, row) => rows.push(row),
    readerAgreement: { boardReader: () => ({ ...figures, openPrCount: 5 }), independentReader: () => figures },
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() }),
  };
  await runSweep([], deps);
  assert.equal(rows.filter(row => row.step === "reader.disagreement").length, 1);
  rows.length = 0;
  await runSweep([], { ...deps, dryRun: true });
  assert.equal(rows.length, 0);
  await runSweep([], { ...deps, now: () => 0 });
  assert.equal(rows.length, 0);
});

test("W1-T4841: unavailable readers are reported and do not fail reconciliation", async () => {
  const { path } = corpus();
  const logs: Array<{ step: string; reason?: unknown }> = [];
  const rows: Record<string, unknown>[] = [];
  await runSweep([], {
    ledgerPath: path, runId: "SWEEP-test", arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    readerAgreement: { boardReader: () => { throw new Error("reader transport failed"); } },
    appendLine: (_path, row) => rows.push(row), log: (step, extra) => logs.push({ step, reason: extra?.reason }),
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() }),
  });
  assert.deepEqual(logs.filter(log => log.step === "reader.agreement.unavailable"),
    [{ step: "reader.agreement.unavailable", reason: "Error: reader transport failed" }]);
  assert.ok(!rows.some(row => row.step === "reader.disagreement"));
});

test("W1-T4841: malformed PR responses cannot look like an empty list", async () => {
  const { path } = corpus();
  for (const response of [{}, [[{ number: "1" }]]]) {
    await assert.rejects(checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test", owner: "owner", repo: "repo",
      openPrCount: 0, readJson: async () => response,
      appendLine: () => assert.fail("unavailable is not disagreement") }), /independent PR listing/);
  }
});

test("W1-T4841: default board PR count reads the complete board list", async () => {
  const { path } = corpus();
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  try {
    const findings = await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test", owner: "owner", repo: "repo",
      readJson: async () => [[{ number: 1 }]], appendLine: () => {} });
    assert.deepEqual(findings, [{ figure: "open_pr_count", subject: "repository", board_value: 0, independent_value: 1 }]);
    assert.ok(shim.calls().some(call => call.includes("state=open")));
  } finally {
    process.env.PATH = previousPath;
  }
});

test("W1-T4841: missing and malformed source data stay unavailable", async () => {
  const { dir, path } = corpus();
  const options = { ledgerPath: path, runId: "SWEEP-test", appendLine: () => assert.fail("must not record false agreement") };
  writeFileSync(join(dir, "status.json"), "{}");
  await assert.rejects(checkReaderAgreement(options), /board status cache has no task projection/);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ tasks: { invalid: { status: "invalid" } } }));
  await assert.rejects(checkReaderAgreement(options), /board status cache has an invalid task status/);
  rmSync(join(dir, "status.json"));
  writeFileSync(path, "null\n");
  await assert.rejects(checkReaderAgreement({ ...options, boardReader: () => figures }), /independent ledger row is not an object/);
  writeFileSync(path, "broken\n");
  await assert.rejects(checkReaderAgreement(options), /board ledger is missing or contains malformed rows/);
  writeFileSync(path, "");
  writeFileSync(join(dir, "ledger.unrecognised"), "data");
  await assert.rejects(checkReaderAgreement({ ...options, boardReader: () => figures }), /independent ledger corpus is incomplete/);
  rmSync(path);
  await assert.rejects(checkReaderAgreement(options), /board ledger is missing or contains malformed rows/);
});

test("W1-T4841: per-task reverse counts keep legacy starts and respect every reset", async () => {
  const { path, row, encode } = corpus();
  for (const reset of [row("pr.opened", "reset", 10), row("verdict.merged", "reset", 10),
    row("verdict", "reset", 10, { verdict: "merged" })]) {
    writeFileSync(path, encode([reset, { task_id: "W1-T2982", step: "run.start" },
      { task_id: "W1-T2982", run_id: "legacy", step: "run.start" }]));
    const result = await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test", appendLine: () => {} });
    assert.deepEqual(result, []);
    const finding = await checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-test",
      boardReader: () => ({ dispatchStreaks: { "W1-T2982": 3 }, healthyDeploys: { W1: "2026-09-29T08:00:00.000Z" } }),
      appendLine: () => {} });
    assert.equal(finding[0]?.independent_value, 2);
  }
});

test("W1-T4841: full sweeps repeat the check only when due and light sweeps skip it", async () => {
  const { path } = corpus();
  let reads = 0;
  const rows: Record<string, unknown>[] = [];
  const deps: SweepDeps = {
    ledgerPath: path, runId: "SWEEP-test", arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    readerAgreement: { boardReader: () => { reads++; return figures; }, independentReader: () => figures },
    appendLine: (_path, row) => rows.push(row),
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() }),
  };
  await runSweep([], { ...deps, now: () => 0, repairAdmissionSurface: "light" });
  assert.equal(reads, 0);
  await runSweep([], { ...deps, now: () => 0 });
  await runSweep([], { ...deps, now: () => 14 * 60_000 });
  assert.equal(reads, 1);
  await runSweep([], { ...deps, now: () => 15 * 60_000 });
  assert.equal(reads, 2);
  assert.equal(rows.filter(row => row.step === "reader.disagreement").length, 0);
});
