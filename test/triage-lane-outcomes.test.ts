import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  foldTriageLaneOutcomes,
  renderTriageLaneReport,
  triageOutcomesCommand,
  TRIAGE_LANE_MIN_TERMINAL_RUNS,
} from "../src/lib/triage-lane-outcomes.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

type Row = Record<string, unknown>;

function synthesized(runId: string, provider: string | undefined, extra: Row = {}): Row {
  return { run_id: runId, step: "triage.synthesized", attempt: 1, provider, model: `${provider}-model`, ...extra };
}

function run(runId: string, provider: string, terminal: string, extra: Row = {}): Row[] {
  return [
    { run_id: runId, step: "triage.start" },
    synthesized(runId, provider, { total_cost_usd: 0.5, billing_mode: provider === "cash" ? "api" : "subscription", ...extra }),
    { run_id: runId, step: "pr.opened", pr_url: `https://example.test/pull/${runId}`, action: terminal },
  ];
}

function group(rows: Row[], provider: string) {
  const found = foldTriageLaneOutcomes(rows).groups.find((g) => g.provider === provider);
  assert.ok(found, `a ${provider} group exists`);
  return found;
}

test("W1-T3547: a cash triage run is counted apart from a Claude one", () => {
  const report = foldTriageLaneOutcomes([...run("r1", "cash", "no_task"), ...run("r2", "claude", "propose"), ...run("r3", "claude", "propose")]);
  assert.deepEqual(report.groups.map((g) => [g.provider, g.runs, g.outcomes.no_task, g.outcomes.propose]), [
    ["cash", 1, 1, 0],
    ["claude", 2, 0, 2],
  ]);
  assert.equal(report.verdict, "none", "the report never declares a winner");
});

test("W1-T3547: a triage run with no terminal row is censored, never scored", () => {
  const g = group([...run("done", "cash", "propose"), { run_id: "open", step: "triage.start" }, synthesized("open", "cash")], "cash");
  assert.equal(g.runs, 2);
  assert.equal(g.censored, 1);
  assert.equal(g.terminalRuns, 1);
  assert.deepEqual(Object.values(g.outcomes).reduce((a, b) => a + b, 0), 1, "the censored run is in no outcome bucket");
});

test("W1-T3547: a missing cost is unknown, never zero", () => {
  const rows = [
    ...run("priced", "cash", "propose"),
    ...run("unpriced", "cash", "propose", { total_cost_usd: undefined }),
    ...run("sub", "claude", "propose"),
    { run_id: "nocost", step: "triage.start" },
    synthesized("nocost", "codex", { billing_mode: "subscription" }),
  ];
  const cash = group(rows, "cash");
  assert.equal(cash.cost.apiUsd, 0.5, "the unpriced run adds nothing to the api total");
  assert.equal(cash.cost.unknownCostRuns, 1);
  assert.equal(cash.cost.subscriptionNotionalUsd, null, "no subscription-billed cash run: unknown, not 0");
  const codex = group(rows, "codex");
  assert.equal(codex.cost.apiUsd, null);
  assert.equal(codex.cost.subscriptionNotionalUsd, null, "a run with no cost is unknown, not $0");
  assert.equal(codex.cost.unknownCostRuns, 1);
  const claude = group(rows, "claude");
  assert.equal(claude.cost.subscriptionNotionalUsd, 0.5, "subscription notional is kept apart from api spend");
  assert.equal(claude.cost.apiUsd, null);
  assert.match(renderTriageLaneReport(foldTriageLaneOutcomes(rows)).join("\n"), /api unknown, subscription notional \$0\.50/);
});

test("W1-T3547: fewer than 20 terminal runs is an insufficient sample, never a verdict", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => run(`r${i}`, "cash", i % 2 === 0 ? "propose" : "grill")).flat();
  const short = group(many(TRIAGE_LANE_MIN_TERMINAL_RUNS - 1), "cash");
  assert.equal(short.terminalRuns, 19);
  assert.equal(short.sample, "insufficient");
  assert.equal(short.rates, null);
  assert.match(renderTriageLaneReport(foldTriageLaneOutcomes(many(19))).join("\n"), /INSUFFICIENT SAMPLE \(19 of 20 terminal runs\)/);
  const enough = group(many(TRIAGE_LANE_MIN_TERMINAL_RUNS), "cash");
  assert.equal(enough.sample, "sufficient");
  assert.equal(enough.rates?.propose, 0.5);
  assert.equal(foldTriageLaneOutcomes(many(20)).verdict, "none", "even a full sample names no winner");
  assert.match(renderTriageLaneReport(foldTriageLaneOutcomes(many(20))).join("\n"), /rates propose 50%, no_task 0%, grill 50%/);
});

test("W1-T3547: the first terminal row in ledger order is the run's outcome", () => {
  const rows: Row[] = [
    { run_id: "g", step: "triage.start" },
    synthesized("g", "claude"),
    { run_id: "g", step: "triage.grill_opened" },
    { run_id: "g", step: "pr.opened", action: "grill" },
    { run_id: "g", step: "triage.error", error: "late failure" },
    { run_id: "e", step: "triage.start" },
    { run_id: "e", step: "triage.error", error: "not status:new" },
    { run_id: "x", step: "triage.start" },
    synthesized("x", "claude", { attempt: 1 }),
    { run_id: "x", step: "triage.relint", attempt: 1 },
    synthesized("x", "claude", { attempt: 2 }),
    synthesized("x", "claude", { attempt: 2 }),
    { run_id: "x", step: "triage.relint_refused" },
    { run_id: "x", step: "pr.opened", action: "unknown-action" },
    { run_id: "other", step: "pr.opened", action: "propose" },
    { step: "triage.start" },
  ];
  const report = foldTriageLaneOutcomes(rows);
  const claude = report.groups.find((g) => g.provider === "claude")!;
  assert.equal(claude.outcomes.grill, 1);
  assert.equal(claude.outcomes.relint_refused, 1);
  assert.equal(claude.relints, 1);
  assert.equal(claude.attempts, 3, "attempt 2 was written twice and counts once");
  assert.equal(claude.attemptsPerRun, 1.5);
  const noWorker = report.groups.find((g) => g.provider === "no-worker")!;
  assert.equal(noWorker.model, "none");
  assert.equal(noWorker.outcomes.error, 1);
  assert.equal(report.runs, 3, "a pr.opened from a run that never started triage is not a triage run");
});

test("W1-T3547: a worker row with no provider or model reads unknown, never a guessed Claude", () => {
  const g = group(run("old", undefined as unknown as string, "propose", { model: undefined, total_cost_usd: undefined, cost_usd: 1.25, billing_mode: "api" }), "unknown");
  assert.equal(g.model, "unknown");
  assert.equal(g.cost.apiUsd, 1.25, "the older cost_usd field is read when total_cost_usd is absent");
});

function stateDirWith(rows: Row[]): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}triage-outcomes-`));
  return writeLedger(rows, { dir: join(root, "state") }).dir;
}

function captured(rest: string[], stateDir: string): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const priorError = console.error;
  console.error = (line: unknown) => { err.push(String(line)); };
  try {
    const code = triageOutcomesCommand(rest, (rows) => foldTriageLaneOutcomes(rows), { stateDir, write: (line) => out.push(line) });
    return { code, out, err };
  } finally {
    console.error = priorError;
  }
}

test("W1-T3547: the verb reads the ledger union, reports text and json, and skips a torn row", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}triage-outcomes-union-`));
  const ledger = writeLedger([{ step: "noise" }, ...run("a", "cash", "propose"), ...run("b", "claude", "no_task")], {
    dir: join(root, "state"),
    rotations: [{ at: "2026-09-01T00:00:00.000Z", rows: run("c", "claude", "propose"), gz: true }],
  });
  appendFileSync(ledger.path, '{"step":"triage.start", torn\n');
  const dir = ledger.dir;
  const text = captured([], dir);
  assert.equal(text.code, 0);
  assert.match(text.out.join("\n"), /3 triage runs, 0 censored/);
  assert.match(text.out.join("\n"), /1 unparseable row\(s\) skipped/);
  const json = captured(["--json"], dir);
  const parsed = JSON.parse(json.out.join("")) as { tornRows: number; groups: Array<{ provider: string; runs: number }> };
  assert.equal(parsed.tornRows, 1);
  assert.deepEqual(parsed.groups.map((g) => [g.provider, g.runs]), [["cash", 1], ["claude", 2]]);
  assert.equal(captured(["--bogus"], dir).code, 2);
});

test("W1-T3547: an incomplete ledger read is refused rather than counted", () => {
  const dir = stateDirWith(run("a", "cash", "propose"));
  writeFileSync(join(dir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz"), "not gzip at all");
  const refused = captured([], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /refusing to count a partial corpus/);
  assert.deepEqual(refused.out, []);
  const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}triage-outcomes-empty-`));
  mkdirSync(join(empty, "state"));
  assert.equal(captured([], join(empty, "state")).code, 1, "no live ledger is no measurement, not a zero");
});

test("W1-T3547: rmd triage-outcomes is registered and reads the host ledger it is run against", async () => {
  const { HANDLERS } = await import("../src/run-task.js");
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}triage-outcomes-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeLedger(run("a", "cash", "propose"), { dir: join(root, "state") });
  const printed: string[] = [];
  const priorHome = process.env.HOME;
  const priorLog = console.log;
  process.env.HOME = home;
  console.log = (line: unknown) => { printed.push(String(line)); };
  try {
    assert.equal(await HANDLERS.get("triage-outcomes")!(["--json"]), 0);
  } finally {
    process.env.HOME = priorHome;
    console.log = priorLog;
  }
  const report = JSON.parse(printed.join("")) as { runs: number; groups: Array<{ provider: string }> };
  assert.equal(report.runs, 1);
  assert.equal(report.groups[0].provider, "cash");
});
