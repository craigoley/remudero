import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { readLedgerUnionRawLinesSync, readLedgerUnionRecordsSync, type LedgerRotationRecords } from "#src/lib/ledger-union.js";
import { loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import * as agreement from "#src/lib/reader-agreement.js";
import * as status from "#src/lib/status.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

/**
 * W1-T9981 — THE READER-AGREEMENT CHECK PARSES ONLY THE ROWS ITS FIGURES READ. Both readers parsed the whole 7-day
 * window (~740 MB raw on the core host), and the independent one held its raw lines beside the parsed copy: the
 * daemon's post-boot heap went from 625 MiB to 2,417 MiB inside this one stage. The figures read two steps, the
 * halted tasks' own rows and the window's newest `ts`.
 *
 * FIXTURES ONLY: every corpus is a throwaway state dir. Rows marked `"unrelated"` are ones no figure reads.
 */

type Row = Record<string, unknown>;
const HALTED = "W1-T5902";
const UNRELATED_TASK = "W1-T7000";
const BLOCKED_PLAN_TASK = "W1-T8000";
const UNRELATED_ROWS = 1_000;
const at = (hour: number, minute = 0): string => `2026-10-10T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
// `ts` leads, as every ledger writer puts it.
const line = (ts: string, fields: Row): Row => ({ ts, ...fields });

function corpusRows() {
  const halted = (ts: string, step: string, run_id: string, fields: Row = {}) => line(ts, { task_id: HALTED, run_id, step, ...fields });
  const older = [
    halted(at(1), "run.start", "h-1"), halted(at(1, 10), "verdict", "h-1", { verdict: "no_pr" }),
    halted(at(2), "pr.opened", "h-reset", { pr_url: "https://github.com/o/r/pull/9" }),
    halted(at(2, 30), "run.start", "h-2"), halted(at(2, 40), "verdict", "h-2", { verdict: "no_pr" }),
    halted(at(3), "run.start", "h-2b"), halted(at(3, 10), "verdict", "h-2b", { verdict: "no_pr" }),
    halted(at(3, 30), "run.start", "h-3"), halted(at(3, 40), "verdict", "h-3", { verdict: "blocked_containment" }),
    line(at(3), { task_id: "DEPLOY", run_id: "d-0", step: "deploy.ok" }),
    line(at(1), { task_id: BLOCKED_PLAN_TASK, run_id: "p-1", step: "run.start" }),
    line(at(1, 10), { task_id: BLOCKED_PLAN_TASK, run_id: "p-1", step: "verdict", verdict: "no_pr" }),
    line(at(1, 15), { task_id: BLOCKED_PLAN_TASK, run_id: "p-1", step: "dispatch.blocked_independent", verdict: "no_pr" }),
  ];
  // The orphan's start is only stale against the window's newest row, an unrelated one: "now" must come from it.
  const newer = [
    halted(at(5), "run.start", "h-orphan"), halted(at(5, 10), "cost.anomaly", "h-orphan"),
    line(at(5, 20), { task_id: HALTED, task: HALTED, run_id: "halt", step: "dispatch.circuit_broken" }),
    line(at(6), { task_id: "DEPLOY", run_id: "d-1", step: "deploy.ok", instance: "W1" }),
    line(at(7), { task_id: "DEPLOY", run_id: "d-2", step: "deploy.ok", instance: "W1" }),
    line(at(7, 5), { task_id: UNRELATED_TASK, run_id: "u-merge", step: "verdict", verdict: "merged", fixture: "main-moved" }),
  ];
  const unrelated = Array.from({ length: UNRELATED_ROWS }, (_, i) => line(at(i % 8, i % 60), {
    task_id: i % 2 ? UNRELATED_TASK : "DAEMON", run_id: `u-${i}`, step: i % 3 ? "worker.turn" : "daemon.alive", fixture: "unrelated",
  }));
  const live = [
    line(at(8), { task_id: "DEPLOY", run_id: "d-3", step: "deploy.ok", instance: "W2" }),
    { step: "daemon.legacy", task_id: "DAEMON", ts: at(8, 30), fixture: "legacy" },
    line(at(9), { task_id: "DAEMON", run_id: "newest", step: "daemon.alive", fixture: "newest" }),
  ];
  return { older, newer, unrelated, live };
}

function corpus(t: TestContext): { dir: string; path: string } {
  const { dir } = ownedFixtureDir(t, "w1-t9981-agreement");
  const { older, newer, unrelated, live } = corpusRows();
  const encode = (rows: Row[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const half = UNRELATED_ROWS / 2;
  writeFileSync(join(dir, "ledger.2026-10-10T04-30-00-000Z.ndjson.gz"), gzipSync(encode([...older, ...unrelated.slice(0, half)])));
  // A rotation replays the retained rows of the one before it.
  writeFileSync(join(dir, "ledger.2026-10-10T07-30-00-000Z.ndjson"), encode([...older, ...newer, ...unrelated.slice(half)]));
  writeFileSync(join(dir, "ledger.ndjson"), encode([...newer.slice(-2), ...unrelated.slice(-10), ...live]));
  return { dir, path: join(dir, "ledger.ndjson") };
}

/** Every `JSON.parse` of a text holding `marker` while `run` runs: what was parsed, not what was kept. */
async function parsesOf<T>(marker: string, run: () => Promise<T>): Promise<{ result: T; parsed: number }> {
  const original = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (typeof text === "string" && text.includes(marker)) parsed++;
    return original(text, reviver);
  }) as typeof JSON.parse;
  try {
    return { result: await run(), parsed };
  } finally {
    JSON.parse = original;
  }
}

/** Figures nothing real can equal, so every real figure surfaces as a disagreement carrying its value. */
const sentinel: agreement.ReaderFigures = {
  dispatchStreaks: { [HALTED]: -1 }, queuedTaskCount: -1,
  healthyDeploys: { local: "sentinel", W1: "sentinel", W2: "sentinel" },
};

/** The unfiltered readers: each filter still sees every line, and every line is kept. */
const keepAll = {
  boardCorpus: ((path, opts = {}) => status.readLedgerUnionBounded(path, {
    ...opts, keep: (raw) => { opts.keep?.(raw); return true; },
  })) as typeof status.readLedgerUnionBounded,
  independentCorpus: ((dir, opts = {}, fs) => readLedgerUnionRawLinesSync(dir, {
    ...opts, keep: (raw) => { opts.keep?.(raw); return true; },
  }, fs)) as typeof readLedgerUnionRawLinesSync,
};

const plan = (): Plan => loadPlanFromYaml(["W1-T5902", BLOCKED_PLAN_TASK, "W1-T8001"].map(id => `
- id: ${id}
  title: fixture task ${id}
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`).join(""), "fixture");

const freshGateway = () => status.buildBatchedGithub("o", `w1-t9981-${process.pid}`, {
  fetchAll: () => [], fetchAllIssues: () => [], commitTrailerIndex: () => new Map(), ttlMs: 3_600_000,
});

test("W1-T9981: neither reader parses a row no figure reads", async (t) => {
  const { path } = corpus(t);
  const { result, parsed } = await parsesOf('"unrelated"', () => agreement.checkReaderAgreement({
    ledgerPath: path, runId: "SWEEP-t9981", appendLine: () => {} }));
  assert.deepEqual(result, [], "the two filtered readers agree");
  assert.equal(parsed, 0, `${parsed} lines no figure reads were parsed`);
  // Each side, alone, against a sentinel: its real figures are read, so the zero above is not an empty read.
  for (const side of ["boardReader", "independentReader"] as const) {
    const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t9981",
      [side]: () => sentinel, appendLine: () => {} });
    const real = side === "boardReader" ? "independent_value" : "board_value";
    assert.equal(findings.find(f => f.figure === "dispatch_streak")?.[real], 2, side);
  }
});

test("W1-T9981: the filtered readers return the same findings as the unfiltered ones", async (t) => {
  const { path } = corpus(t);
  for (const side of ["boardReader", "independentReader"] as const) {
    const options = { ledgerPath: path, runId: "SWEEP-t9981", [side]: () => sentinel, appendLine: () => {} };
    const filtered = await agreement.checkReaderAgreement(options);
    const unfiltered = await agreement.checkReaderAgreement({ ...options, ...keepAll });
    assert.deepEqual(filtered, unfiltered, side);
    const real = side === "boardReader" ? "independent_value" : "board_value";
    assert.deepEqual(Object.fromEntries(filtered.map(f => [`${f.figure}:${f.subject}`, f[real]])), {
      [`dispatch_streak:${HALTED}`]: 2,
      "last_healthy_deploy:W1": at(7), "last_healthy_deploy:W2": at(8), "last_healthy_deploy:local": at(3),
    }, side);
  }
});

test("W1-T9981: the queued-task figure never parses the whole window", async (t) => {
  const { dir, path } = corpus(t);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ tasks: {} }));
  const passes: string[][] = [];
  const options = {
    ledgerPath: path, runId: "SWEEP-t9981", owner: "o", repo: "r", plan: plan(), boardReader: () => sentinel,
    queueGithub: freshGateway, appendLine: () => {},
    independentCorpus: ((root, opts, fs) => {
      const read = readLedgerUnionRawLinesSync(root, opts, fs);
      passes.push(read.rawLines);
      return read;
    }) as typeof readLedgerUnionRawLinesSync,
  };
  const { result, parsed } = await parsesOf('"unrelated"', () => agreement.checkReaderAgreement(options));
  const queued = result.find(f => f.figure === "queued_task_count");
  assert.equal(typeof queued?.independent_value, "number", "the projection ran");
  assert.equal(parsed, 0, `${parsed} lines no figure reads were parsed`);
  const projected = passes.at(-1)!;
  assert.equal(passes.length, 3, "steps, then the halted task, then the projection");
  assert.ok(projected.some(raw => raw.includes(`"${BLOCKED_PLAN_TASK}"`)) && projected.some(raw => raw.includes('"main-moved"')),
    "the projection keeps a plan task's rows and a row it reads by step");
  const unfiltered = await agreement.checkReaderAgreement({ ...options, ...keepAll });
  assert.equal(unfiltered.find(f => f.figure === "queued_task_count")?.independent_value, queued?.independent_value);
  // Positive control: the queued count really depends on the other task's merge, a row read by step.
  const withoutMerge = (lines: string[]) => lines.filter(raw => !raw.includes('"main-moved"'));
  const control = await agreement.checkReaderAgreement({ ...options, independentCorpus: ((root, opts, fs) => {
    const read = readLedgerUnionRawLinesSync(root, opts, fs);
    return { ...read, rawLines: withoutMerge(read.rawLines) };
  }) as typeof readLedgerUnionRawLinesSync });
  assert.notEqual(control.find(f => f.figure === "queued_task_count")?.independent_value, queued?.independent_value);
});

test("W1-T9981: a row of a step the projection does not list never moves its queued count", async (t) => {
  const { path } = corpus(t);
  // @source-text-subject: src/lib/status.ts — the census population IS the step literals its reducers compare.
  const source = readFileSync(fileURLToPath(new URL("../src/lib/status.ts", import.meta.url)), "utf8");
  const steps = [...new Set([...source.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)"/g)].map(m => m[1]!))]
    .filter(step => !status.PROJECTION_STEP_READS.has(step));
  assert.ok(steps.length >= 50, `the census walked only ${steps.length} step literals`);
  // Without the other task's merge the plan task stays latched, so a merge row of an unlisted step would release it.
  const rows = readLedgerUnionRawLinesSync(join(path, "..")).rawLines.map(raw => JSON.parse(raw) as Row)
    .filter(row => row.fixture !== "main-moved");
  const other = steps.map(step => line(at(8, 45), {
    step, task_id: "OTHER-T1", task: "OTHER-T1", run_id: "other", pr_url: "https://github.com/o/r/pull/1", verdict: "merged",
    plan_only: true, head_sha: "abc", provider: "claude", host: "elsewhere", decision: "continue",
  }));
  const queued = (ledger: Row[]) => [...status.projectPlan(plan(), {
    ledgerPath: path, readLedger: () => ledger as never, github: freshGateway(), writeCreditStore: () => {},
  }).entries()].map(([id, p]) => `${id}:${p.status}`);
  assert.deepEqual(queued([...rows, ...other]), queued(rows));
});

test("W1-T9981: every check writes its scanned and kept counts and its heap use", async (t) => {
  const { path } = corpus(t);
  const written: Row[] = [];
  assert.deepEqual(await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t9981",
    appendLine: (_path, row) => written.push(row) }), []);
  const rows = written.filter(row => row.step === "reader.agreement");
  assert.equal(rows.length, 1, "a check whose figures agree still writes its row");
  const row = rows[0]!;
  const scanned = row.lines_scanned as Record<string, number>;
  const kept = row.rows_kept as Record<string, number>;
  for (const side of ["board", "independent"]) {
    assert.ok(scanned[side]! > UNRELATED_ROWS, `${side} scanned ${scanned[side]}`);
    assert.ok(kept[side]! > 0 && kept[side]! < 60, `${side} kept ${kept[side]}`);
  }
  for (const key of ["heap_used_before_bytes", "heap_used_after_bytes", "duration_ms"]) {
    assert.ok(Number.isInteger(row[key]) && (row[key] as number) >= 0, key);
  }
  assert.ok((row.heap_used_before_bytes as number) > 0);
  assert.equal(row.disagreements, 0);
  assert.equal(row.run_id, "SWEEP-t9981");
});

test("W1-T9981: the default readers read a real state dir", async (t) => {
  const { dir, path } = corpus(t);
  writeFileSync(join(dir, "ledger.ndjson"), readFileSync(path, "utf8") + "not json\n");
  const unavailable = { ledgerPath: path, runId: "SWEEP-t9981", appendLine: () => assert.fail("no row for an unread check") };
  await assert.rejects(agreement.checkReaderAgreement(unavailable), /board ledger is missing or contains malformed rows/);
  await assert.rejects(agreement.checkReaderAgreement({ ...unavailable, boardReader: () => sentinel }), SyntaxError);
  const { path: clean } = corpus(t);
  const findings = await agreement.checkReaderAgreement({ ledgerPath: clean, runId: "SWEEP-t9981",
    independentReader: () => sentinel, appendLine: () => {} });
  assert.equal(findings.find(f => f.subject === HALTED)?.board_value, 2);
  assert.equal(findings.find(f => f.subject === "W2")?.board_value, at(8));
});

test("W1-T9981: a keep filter narrows the lines a union read scans, never what a rotation memo holds", async (t) => {
  const { dir } = corpus(t);
  const keep = (raw: string) => raw.includes('"deploy.ok"');
  const read = readLedgerUnionRecordsSync(dir, { keep });
  assert.deepEqual([...new Set(read.rows.map(row => row.step))], ["deploy.ok"]);
  const held: LedgerRotationRecords[] = [];
  readLedgerUnionRecordsSync(dir, { keep, rotationRecords: (_entry, parse) => { const records = parse(); held.push(records); return records; } });
  assert.equal(held.length, 2);
  assert.ok(held.every(records => records.rows.some(row => row.fixture === "unrelated")), "a memo serves other readers whole");
});
