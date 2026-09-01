// test/mount-headroom-sweep.test.ts
//
// W1-T2560 — NOTHING MEASURES WHICH TASK CLASSES COULD TAKE A CHEAPER MOUNT. This suite proves
// scripts/mount-headroom-sweep.mjs's `buildMountHeadroomSweep` is that measurement: a PURE reader
// over the retained ledger's three rotation forms, reduced per `task_class` into turn/cost
// percentiles (never a mean), an outcome split, and a cost-per-completed-task figure that divides
// by SETTLED runs — with its own controls (forms opened, row:run dedup ratio, newest timestamp)
// printed beside every number, and a REFUSAL rather than a silent zero when the corpus is empty.
//
// WHAT IS REAL HERE: every function under test is imported straight from the script itself (a
// dynamic import, per this repo's own established pattern for `scripts/**`, which sits outside
// tsconfig's `include` — see test/credit-surface-gate.test.ts's identical comment) — no seam, no
// mock, no shadow copy of the reduction logic.

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mount-headroom-sweep.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  buildMountHeadroomSweep: (stateDir: string, fsDeps?: unknown) => {
    corpus: {
      stateDir: string;
      formsOpened: string[];
      archiveCount: number;
      liveFileRead: boolean;
      unread: string[];
      rawRowsWithRunId: number;
      distinctRunCount: number;
      rowToRunRatio: number;
      newestTs: string | undefined;
    };
    classes: Array<{
      taskClass: string;
      totalRuns: number;
      settledRuns: number;
      turnsP50: number | null;
      turnsP90: number | null;
      turnsMax: number | null;
      costP50: number | null;
      costP90: number | null;
      costMax: number | null;
      outcomes: { passing: number; blockedCi: number; redispatched: number };
      totalSettledCostUsd: number;
      distinctSettledTasks: number;
      costPerCompletedTaskUsd: number | null;
    }>;
  };
  computeClassSweep: (runs: unknown[]) => unknown[];
  percentile: (values: number[], p: number) => number | null;
  redispatchedRunIds: (runs: Array<{ runId: string; taskId: string; startTs: string }>) => Set<string>;
  readLedgerCorpus: (stateDir: string, fsDeps?: unknown) => unknown;
  parseAndDedupeLedgerLines: (rawLines: string[]) => { records: unknown[]; rawRowsWithRunId: number };
  renderMountHeadroomReport: (report: unknown) => string;
  MountHeadroomSweepError: new (message: string) => Error;
};
const {
  buildMountHeadroomSweep,
  percentile,
  redispatchedRunIds,
  renderMountHeadroomReport,
  MountHeadroomSweepError,
} = mod;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mount-headroom-sweep-"));
}

/** One run's `run.start` + `implement.done` + `verdict` ndjson lines. */
function runLines(opts: {
  runId: string;
  taskId: string;
  taskClass: string;
  turns: number;
  costUsd: number;
  verdict: string;
  ts: string;
}): string {
  const start = JSON.stringify({
    ts: opts.ts,
    run_id: opts.runId,
    task_id: opts.taskId,
    step: "run.start",
    type: "implement",
    task_class: opts.taskClass,
  });
  const done = JSON.stringify({
    ts: opts.ts,
    run_id: opts.runId,
    task_id: opts.taskId,
    step: "implement.done",
    num_turns: opts.turns,
  });
  const verdict = JSON.stringify({
    ts: opts.ts,
    run_id: opts.runId,
    task_id: opts.taskId,
    step: "verdict",
    verdict: opts.verdict,
    cost_usd: opts.costUsd,
  });
  return [start, done, verdict].join("\n");
}

function writeLive(dir: string, lines: string[]): void {
  writeFileSync(join(dir, "ledger.ndjson"), `${lines.join("\n")}\n`);
}

function writeGzipArchive(dir: string, stamp: string, lines: string[]): void {
  writeFileSync(join(dir, `ledger.${stamp}.ndjson.gz`), gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf8")));
}

function writePlainArchive(dir: string, stamp: string, lines: string[]): void {
  writeFileSync(join(dir, `ledger.${stamp}.ndjson`), `${lines.join("\n")}\n`);
}

// ── ACCEPTANCE 1: per-task_class turn/cost distributions, spawning nothing ────────────────────

test("buildMountHeadroomSweep: reports turn and cost distributions per task_class from the retained ledger", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", turns: 10, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R2", taskId: "T2", taskClass: "src", turns: 20, costUsd: 2, verdict: "merged", ts: "2026-08-01T01:00:00.000Z" }),
      runLines({ runId: "R3", taskId: "T3", taskClass: "docs", turns: 3, costUsd: 0.5, verdict: "merged", ts: "2026-08-01T02:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const src = report.classes.find((c) => c.taskClass === "src");
    const docs = report.classes.find((c) => c.taskClass === "docs");
    assert.ok(src, "the src class is reported");
    assert.ok(docs, "the docs class is reported, separately from src");
    assert.equal(src!.settledRuns, 2);
    assert.equal(docs!.settledRuns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mount-headroom-sweep.mjs imports no process-spawning module — it reports, it never spawns", () => {
  const source = readFileSync(join(__dirname, "..", "scripts", "mount-headroom-sweep.mjs"), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:child_process["']|execFileSync|spawnSync|\bspawn\(/);
});

// ── ACCEPTANCE 2: percentiles, never a mean ────────────────────────────────────────────────────

test("percentile: p50/p90/max over a skewed sample, never the mean the outlier would drag", () => {
  const values = [1, 1, 1, 1, 100]; // mean is 20.8 — miles from any real percentile below
  assert.equal(percentile(values, 50), 1);
  assert.equal(percentile(values, 90), 100);
  assert.equal(Math.max(...values), 100);
});

test("buildMountHeadroomSweep: a class row carries percentile fields only — no mean/avg field to drag", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", turns: 1, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R2", taskId: "T2", taskClass: "src", turns: 1, costUsd: 1, verdict: "merged", ts: "2026-08-01T01:00:00.000Z" }),
      runLines({ runId: "R3", taskId: "T3", taskClass: "src", turns: 1, costUsd: 1, verdict: "merged", ts: "2026-08-01T02:00:00.000Z" }),
      runLines({ runId: "R4", taskId: "T4", taskClass: "src", turns: 1, costUsd: 1, verdict: "merged", ts: "2026-08-01T03:00:00.000Z" }),
      runLines({ runId: "R5", taskId: "T5", taskClass: "src", turns: 100, costUsd: 100, verdict: "merged", ts: "2026-08-01T04:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const src = report.classes.find((c) => c.taskClass === "src")!;
    // p50 sits on the four ordinary runs, never dragged toward the one outlier a mean would show.
    assert.equal(src.turnsP50, 1);
    assert.equal(src.turnsMax, 100);
    assert.equal(src.costP50, 1);
    assert.equal(src.costMax, 100);
    const keys = Object.keys(src).join(",").toLowerCase();
    assert.doesNotMatch(keys, /mean|average|\bavg\b/, "no mean/avg field exists to report instead of a percentile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 3: outcome split — passing / blocked_ci / re-dispatched, per class ──────────────

test("buildMountHeadroomSweep: outcome split names passing, blocked_ci, and re-dispatched counts separately", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      // T1: one clean merge.
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      // T2: first attempt blocked_ci, SECOND attempt (later startTs, same task) is the re-dispatch.
      runLines({ runId: "R2a", taskId: "T2", taskClass: "src", turns: 5, costUsd: 1, verdict: "blocked_ci", ts: "2026-08-01T01:00:00.000Z" }),
      runLines({ runId: "R2b", taskId: "T2", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T02:00:00.000Z" }),
      // T3: still running — excluded from the settled outcome split entirely.
      runLines({ runId: "R3", taskId: "T3", taskClass: "src", turns: 5, costUsd: 1, verdict: "incomplete", ts: "2026-08-01T03:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const src = report.classes.find((c) => c.taskClass === "src")!;
    assert.equal(src.settledRuns, 3, "the in-flight run is excluded from the settled count");
    assert.equal(src.outcomes.passing, 2, "R1 and R2b both reached a passing verdict");
    assert.equal(src.outcomes.blockedCi, 1, "R2a ended blocked_ci");
    assert.equal(src.outcomes.redispatched, 1, "R2b is T2's second attempt — a re-dispatch, R2a is not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildMountHeadroomSweep: a class that is cheap because it fails early is still visible as cheap-but-failing", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "fast-fail", turns: 1, costUsd: 0.1, verdict: "blocked_illformed", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R2", taskId: "T2", taskClass: "fast-fail", turns: 1, costUsd: 0.1, verdict: "blocked_illformed", ts: "2026-08-01T01:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const ff = report.classes.find((c) => c.taskClass === "fast-fail")!;
    assert.equal(ff.costP50, 0.1, "the raw cost figure alone looks cheap");
    assert.equal(ff.outcomes.passing, 0, "but zero of its settled runs actually passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 4: cost per COMPLETED TASK divides by SETTLED runs, never per-request ───────────

test("buildMountHeadroomSweep: costPerCompletedTaskUsd sums BOTH attempts' cost over the ONE completed task, never a per-run average", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      // T1 needed two attempts to land: $2 blocked_ci, then $3 merged — real price is $5 for ONE
      // completed task, never ($2+$3)/2 = $2.50 per request, which would hide the re-dispatch.
      runLines({ runId: "R1a", taskId: "T1", taskClass: "src", turns: 10, costUsd: 2, verdict: "blocked_ci", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R1b", taskId: "T1", taskClass: "src", turns: 15, costUsd: 3, verdict: "merged", ts: "2026-08-01T01:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const src = report.classes.find((c) => c.taskClass === "src")!;
    assert.equal(src.distinctSettledTasks, 1, "both runs belong to the SAME task");
    assert.equal(src.totalSettledCostUsd, 5);
    assert.equal(src.costPerCompletedTaskUsd, 5, "never 2.5 — the per-run average that hides the re-dispatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redispatchedRunIds: the earliest run of a task is never itself flagged as a re-dispatch", () => {
  const runs = [
    { runId: "A", taskId: "T", startTs: "2026-08-01T00:00:00.000Z" },
    { runId: "B", taskId: "T", startTs: "2026-08-01T01:00:00.000Z" },
    { runId: "C", taskId: "T", startTs: "2026-08-01T02:00:00.000Z" },
  ];
  const flagged = redispatchedRunIds(runs);
  assert.equal(flagged.has("A"), false);
  assert.equal(flagged.has("B"), true);
  assert.equal(flagged.has("C"), true);
});

// ── ACCEPTANCE 5: all three rotation forms are read, and the report names which ────────────────

test("buildMountHeadroomSweep: reads a gzip archive, a plain archive, AND the live file, naming all three forms opened", () => {
  const dir = tmpDir();
  try {
    writeGzipArchive(dir, "2026-08-01T00-00-00-000Z", [
      runLines({ runId: "G1", taskId: "TG", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
    ]);
    writePlainArchive(dir, "2026-08-02T00-00-00-000Z", [
      runLines({ runId: "P1", taskId: "TP", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-02T00:00:00.000Z" }),
    ]);
    writeLive(dir, [
      runLines({ runId: "L1", taskId: "TL", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-03T00:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    assert.deepEqual([...report.corpus.formsOpened].sort(), ["gzip", "live", "plain"]);
    assert.equal(report.corpus.archiveCount, 2);
    assert.equal(report.corpus.liveFileRead, true);
    assert.equal(report.corpus.distinctRunCount, 3, "one run recovered from each of the three forms");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderMountHeadroomReport: the rendered text names which forms were opened", () => {
  const dir = tmpDir();
  try {
    writeGzipArchive(dir, "2026-08-01T00-00-00-000Z", [
      runLines({ runId: "G1", taskId: "TG", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
    ]);
    writeLive(dir, [
      runLines({ runId: "L1", taskId: "TL", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-03T00:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const text = renderMountHeadroomReport(report);
    assert.match(text, /forms opened: gzip, live/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 6: rows deduped by run_id, and the row:run ratio is printed ─────────────────────

test("buildMountHeadroomSweep: the SAME run duplicated across two archives is counted ONCE, and the row:run ratio names the duplication", () => {
  const dir = tmpDir();
  try {
    const lines = [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", turns: 10, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
    ];
    // Two archives holding the exact SAME lines — an overlapping rotation window, byte-identical.
    writeGzipArchive(dir, "2026-08-01T00-00-00-000Z", lines);
    writePlainArchive(dir, "2026-08-01T01-00-00-000Z", lines);
    const report = buildMountHeadroomSweep(dir);
    assert.equal(report.corpus.distinctRunCount, 1, "one run, never double-counted across the two archives");
    assert.equal(report.corpus.rawRowsWithRunId, 6, "3 lines x 2 archives, BEFORE dedup");
    assert.equal(report.corpus.rowToRunRatio, 6, "the ratio names the exact duplication factor");
    // And the reduction itself is correct, not merely the display count: a duplicated
    // implement.done line must never double-count that run's own turns.
    const src = report.classes.find((c) => c.taskClass === "src")!;
    assert.equal(src.turnsP50, 10, "never 20 — a duplicated implement.done line must not double-sum turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 7: the corpus's newest timestamp is printed ─────────────────────────────────────

test("buildMountHeadroomSweep: corpus.newestTs is the newest ts seen across every form, not just the live file's own", () => {
  const dir = tmpDir();
  try {
    writeGzipArchive(dir, "2026-08-01T00-00-00-000Z", [
      runLines({ runId: "G1", taskId: "TG", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
    ]);
    writeLive(dir, [
      runLines({ runId: "L1", taskId: "TL", taskClass: "src", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-09-01T12:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    assert.equal(report.corpus.newestTs, "2026-09-01T12:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 8: an empty or unreadable corpus REFUSES rather than reporting zeros ────────────

test("buildMountHeadroomSweep: an empty state dir REFUSES — never a report reading zero across every class", () => {
  const dir = tmpDir();
  try {
    mkdirSync(dir, { recursive: true }); // exists, but holds no ledger files at all
    assert.throws(
      () => buildMountHeadroomSweep(dir),
      (e: unknown) => e instanceof MountHeadroomSweepError && /REFUSED — zero distinct runs/.test((e as Error).message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildMountHeadroomSweep: a nonexistent state dir REFUSES the same way as an empty one", () => {
  const dir = join(tmpdir(), "mount-headroom-sweep-does-not-exist-at-all");
  assert.throws(
    () => buildMountHeadroomSweep(dir),
    (e: unknown) => e instanceof MountHeadroomSweepError,
  );
});

test("buildMountHeadroomSweep: a corpus with rows carrying no run_id at all (never a real run.start) REFUSES rather than reporting an empty table", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [JSON.stringify({ ts: "2026-08-01T00:00:00.000Z", step: "ci.polling", detail: "noise, no run_id at all" })]);
    assert.throws(
      () => buildMountHeadroomSweep(dir),
      (e: unknown) => e instanceof MountHeadroomSweepError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
