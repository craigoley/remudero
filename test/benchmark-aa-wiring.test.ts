// test/benchmark-aa-wiring.test.ts — W1-T4575: `rmd benchmark-aa` reaches the A/A builder through the
// command registry, refuses bad input by name, and keeps a stale report when its sources fail.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkAaCommand, buildBenchmarkAaReport, type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import { COMMANDS, HANDLERS } from "../src/run-task.js";

const SHA = "d".repeat(40);
const NOW = "2026-09-27T12:10:00.000Z";

function trialManifest(trialId = "aa-wiring-1"): Record<string, unknown> {
  return {
    version: "benchmark-aa-trial-v1", trialId, cohort: { kind: "public-fixture" },
    stack: { provider: "claude", model: "claude-sonnet-5", effort: "high", harnessRevision: SHA, promptRevision: SHA,
      toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA },
    strataRevision: "strata-v1",
    tasks: [{ taskId: "WX-T1", taskClass: "fix", risk: "low" }, { taskId: "WX-T2", taskClass: "fix", risk: "low" }],
  };
}

function trialRows(): string {
  const rows = ["WX-T1", "WX-T2"].flatMap((taskId, i) => [
    { ts: `2026-09-27T11:0${i}:00.000Z`, step: "worker.assignment", task_id: taskId, run_id: `${taskId}-1`,
      worker_assignment: { id: `${taskId}-a1`, requested: { model: "claude-sonnet-5", effort: "high" },
        selected: { provider: "claude", model: "claude-sonnet-5", effort: "high" } } },
    { ts: `2026-09-27T11:0${i}:30.000Z`, step: "verdict", task_id: taskId, run_id: `${taskId}-1`,
      selection_assignment_id: `${taskId}-a1`, success: true, served_model: "claude-sonnet-5", billing_mode: "subscription",
      total_cost_usd: 0.1 },
  ]);
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function withHome<T>(body: (home: string, stateDir: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "rmd-benchmark-aa-wiring-"));
  const savedHome = process.env.HOME;
  try {
    const root = join(home, "Remudero");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
    mkdirSync(join(root, "state"), { recursive: true });
    process.env.HOME = home;
    return await body(home, join(root, "state"));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("rmd benchmark-aa is a registered operator verb that reaches the A/A report builder", async () => {
  assert.ok(COMMANDS.some((spec) => spec.name === "benchmark-aa" && spec.syntax.includes("--trial")));
  await withHome(async (home, stateDir) => {
    writeFileSync(join(stateDir, "ledger.ndjson"), trialRows());
    const manifestPath = join(home, "trial.json");
    writeFileSync(manifestPath, JSON.stringify(trialManifest()));
    const printed: string[] = [];
    const savedLog = console.log;
    console.log = (line: string) => { printed.push(line); };
    let code: number;
    let textCode: number;
    try {
      code = await HANDLERS.get("benchmark-aa")!(["--trial", manifestPath, "--json"]);
      textCode = await HANDLERS.get("benchmark-aa")!(["--trial", manifestPath]);
    } finally { console.log = savedLog; }
    assert.equal(code, 0);
    const report = JSON.parse(printed[0]!) as BenchmarkAaReport;
    assert.equal(report.version, "benchmark-aa-v1");
    assert.equal(report.state, "observed");
    assert.equal(report.winnerDeclared, false);
    assert.equal(report.receipt.version, "benchmark-aa-receipt-v1");
    assert.equal(report.sources.forms.live, 1);
    assert.equal(report.cohortReconciliation.state, "reconciled", "the default cohort projection reconciles with the union");
    const saved = join(stateDir, "benchmark-aa-v1.aa-wiring-1.json");
    assert.ok(existsSync(saved), "the dated report is persisted under the configured state dir");
    assert.equal(textCode, 0);
    assert.ok(printed.some((line) => line.includes("no winner is declared")));
    assert.ok(printed.some((line) => /receipt benchmark-aa-receipt-v1 [0-9a-f]{16} written to /.test(line)));
    assert.equal(JSON.parse(readFileSync(saved, "utf8")).lateEvidence.state, "none", "the second run read the first as its prior");
  });
});

test("rmd benchmark-aa refuses bad input by name before reading any ledger", async () => {
  await withHome(async (home) => {
    const lines: string[] = [];
    const print = (line: string) => { lines.push(line); };
    const run = (args: string[]) => benchmarkAaCommand(args, buildBenchmarkAaReport, { print, nowIso: NOW,
      readEvidence: async () => { throw new Error("must not read"); } });
    assert.equal(await run(["--bogus"]), 2);
    assert.match(lines.at(-1)!, /arguments-invalid/);
    assert.equal(await run([]), 2);
    assert.match(lines.at(-1)!, /^usage: rmd benchmark-aa --trial/);
    assert.equal(await run(["--trial", join(home, "missing.json")]), 2);
    assert.match(lines.at(-1)!, /refused \(trial-manifest-unreadable\)/);
    const bad = join(home, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...trialManifest(), cohort: { kind: "live-fleet" } }));
    assert.equal(await run(["--trial", bad]), 2);
    assert.match(lines.at(-1)!, /cohort-not-public-fixture-or-opted-in/);
    const good = join(home, "good.json");
    writeFileSync(good, JSON.stringify(trialManifest()));
    assert.equal(await run(["--trial", good, "--case-files", join(home, "none.json")]), 2);
    assert.match(lines.at(-1)!, /case-file-snapshot-unreadable/);
    const invalid = join(home, "cases.json");
    writeFileSync(invalid, JSON.stringify([{ version: "task-case-file-v0" }]));
    assert.equal(await run(["--trial", good, "--case-files", invalid]), 2);
    assert.match(lines.at(-1)!, /case-file-snapshot-invalid/);
  });
});

test("rmd benchmark-aa keeps the last dated report stale when a refresh cannot read its sources", async () => {
  await withHome(async (home, stateDir) => {
    writeFileSync(join(stateDir, "ledger.ndjson"), trialRows());
    const manifestPath = join(home, "trial.json");
    writeFileSync(manifestPath, JSON.stringify(trialManifest()));
    const cases = join(home, "cases.json");
    writeFileSync(cases, "[]");
    const out = join(home, "report.json");
    const lines: string[] = [];
    const print = (line: string) => { lines.push(line); };
    const failing = async () => { throw new Error("archive vanished"); };
    const base = { print, nowIso: NOW, resolveStateDir: () => stateDir };

    assert.equal(await benchmarkAaCommand(["--trial", manifestPath, "--out", out, "--no-cohort"], buildBenchmarkAaReport,
      { ...base, readEvidence: failing }), 1, "a first refresh with no readable source is unavailable");
    assert.ok(lines.some((line) => line === "  A1: unavailable"));
    assert.equal(JSON.parse(readFileSync(out, "utf8")).arms, null);

    lines.length = 0;
    assert.equal(await benchmarkAaCommand(["--trial", manifestPath, "--out", out, "--case-files", cases, "--json"],
      buildBenchmarkAaReport, { ...base, readCohort: failing }), 0);
    const good = JSON.parse(lines[0]!) as BenchmarkAaReport;
    assert.equal(good.state, "observed");
    assert.deepEqual(good.cohortReconciliation, { state: "unavailable", reason: "cohort-projection-failed", lastGoodAt: null });
    assert.equal(good.arms!.A1!.outcomes.unavailable + good.arms!.A2!.outcomes.unavailable, 2, "an empty case-file snapshot is a join gap");

    lines.length = 0;
    assert.equal(await benchmarkAaCommand(["--trial", manifestPath, "--out", out, "--no-cohort", "--json"], buildBenchmarkAaReport,
      { ...base, nowIso: "2026-09-28T00:00:00.000Z", readEvidence: failing }), 1);
    const stale = JSON.parse(lines[0]!) as BenchmarkAaReport;
    assert.equal(stale.state, "stale");
    assert.equal(stale.lastGoodAt, NOW);
    assert.deepEqual(stale.arms, good.arms);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).state, "stale");

    lines.length = 0;
    const unwritable = join(home, "no-such-dir", "report.json");
    assert.equal(await benchmarkAaCommand(["--trial", manifestPath, "--out", unwritable, "--no-cohort"], buildBenchmarkAaReport,
      base), 0);
    assert.ok(lines.includes(`benchmark-aa: report-not-persisted (${unwritable})`));
    assert.ok(lines.every((line) => !line.includes("written to")));

    writeFileSync(out, JSON.stringify({ ...good, trialId: "another-trial" }));
    lines.length = 0;
    assert.equal(await benchmarkAaCommand(["--trial", manifestPath, "--out", out, "--no-cohort", "--json"], buildBenchmarkAaReport,
      { ...base, readEvidence: failing }), 1);
    assert.equal((JSON.parse(lines[0]!) as BenchmarkAaReport).state, "unavailable", "another trial's report is never this trial's prior");
  });
});
