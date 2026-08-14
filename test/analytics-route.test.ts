import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import {
  ANALYTICS_COLLECTION_STARTED_AT,
  ANALYTICS_SCOPE_NOTE,
  buildAnalyticsRoute,
  deriveAnalyticsSnapshot,
  readAnalyticsLedgerLines,
  type AnalyticsSnapshot,
} from "../src/lib/analytics-route.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function writePlainArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), lines.join("\n") + "\n");
}

function writeLive(stateDir: string, lines: string[]): void {
  writeFileSync(join(stateDir, "ledger.ndjson"), lines.join("\n") + "\n");
}

function sortedTaskIds(lines: Array<Record<string, unknown>>): string[] {
  return lines.map((l) => String(l.task_id)).sort();
}

// ── falsifier (v), direction 1: the rotation union must equal the single-file aggregate ───────

test("readAnalyticsLedgerLines: rows split across the live file and TWO rotation archives (one gzip, one plain) aggregate IDENTICALLY to the same rows collapsed into one file", () => {
  const split = tmpStateDir("rmd-analytics-split-");
  const single = tmpStateDir("rmd-analytics-single-");
  try {
    writeGzArchive(split, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","task_id":"W1-T1","run_id":"R1","step":"run.start"}',
    ]);
    writePlainArchive(split, "ledger.2026-07-02T00-00-00-000Z.ndjson", [
      '{"ts":"2026-07-02T00:00:00.000Z","task_id":"W1-T2","run_id":"R2","step":"run.start"}',
    ]);
    writeLive(split, ['{"ts":"2026-08-01T00:00:00.000Z","task_id":"W1-T3","run_id":"R3","step":"run.start"}']);

    writeLive(single, [
      '{"ts":"2026-07-01T00:00:00.000Z","task_id":"W1-T1","run_id":"R1","step":"run.start"}',
      '{"ts":"2026-07-02T00:00:00.000Z","task_id":"W1-T2","run_id":"R2","step":"run.start"}',
      '{"ts":"2026-08-01T00:00:00.000Z","task_id":"W1-T3","run_id":"R3","step":"run.start"}',
    ]);

    const splitLines = readAnalyticsLedgerLines(split);
    const singleLines = readAnalyticsLedgerLines(single);
    assert.equal(splitLines.length, 3, "one row per archive plus the live row");
    assert.deepEqual(
      sortedTaskIds(splitLines),
      sortedTaskIds(singleLines),
      "the union read must reach every row a single-file read of the identical rows would",
    );

    // A LIVE-ONLY reader (never lists rotations at all) FAILS this falsifier: it reaches only the
    // one row that lives in the live file, proving the union read above is doing real work, not
    // trivially equal because the archives were empty.
    const liveOnlyFsDeps = {
      readdirSync: () => [] as string[],
      existsSync: (p: string) => existsSync(p),
      readFileSync: (p: string) => readFileSync(p),
      gunzipSync: (b: Buffer) => gunzipSync(b),
    };
    const liveOnlyLines = readAnalyticsLedgerLines(split, liveOnlyFsDeps);
    assert.equal(liveOnlyLines.length, 1, "a live-only reader must undercount — this is the rotation hazard made structural");
  } finally {
    rmSync(split, { recursive: true, force: true });
    rmSync(single, { recursive: true, force: true });
  }
});

// ── falsifier (v), direction 2: dedupe is on the FULL LINE, never ts+task_id ───────────────────

test("readAnalyticsLedgerLines: two DAEMON rows sharing one ts (but a different step) plus one distinct row count THREE, not two", () => {
  const dir = tmpStateDir("rmd-analytics-dedupe-");
  try {
    // Two rows that are genuinely DIFFERENT events (different `step`) but share the SAME ts and
    // the SAME pseudo task_id — the rejected key this task's rationale names ("ts+task_id
    // collapsed simultaneous DAEMON rows") would wrongly treat these as ONE row.
    writeLive(dir, [
      '{"ts":"2026-08-01T00:00:00.000Z","task_id":"DAEMON","run_id":"DAEMON-1","step":"daemon.target"}',
      '{"ts":"2026-08-01T00:00:00.000Z","task_id":"DAEMON","run_id":"DAEMON-1","step":"daemon.tree_dirty"}',
      '{"ts":"2026-08-01T00:00:05.000Z","task_id":"DAEMON","run_id":"DAEMON-1","step":"daemon.install_freshness"}',
    ]);
    const lines = readAnalyticsLedgerLines(dir);
    assert.equal(lines.length, 3, "full-line dedupe: three DISTINCT lines survive, even though two share ts+task_id");

    // Demonstrate the rejected key really would have undercounted, on these exact rows.
    const naiveKeyed = new Map<string, unknown>();
    for (const l of lines) naiveKeyed.set(`${l.ts}:${l.task_id}`, l);
    assert.equal(naiveKeyed.size, 2, "ts+task_id collapses the two simultaneous-but-different rows — the collapsed-deferral hazard");

    // And a genuine BYTE-IDENTICAL repeat (the real union-overlap case: the same physical line
    // observed once in an archive and once in the live file) must still collapse to one, not grow
    // the count to four.
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-08-01T00:00:00.000Z","task_id":"DAEMON","run_id":"DAEMON-1","step":"daemon.target"}',
    ]);
    const withOverlap = readAnalyticsLedgerLines(dir);
    assert.equal(withOverlap.length, 3, "a byte-identical repeat of an already-seen line must not grow the count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAnalyticsLedgerLines: a state dir with ZERO rotations is not a refusal — a fresh instance's live file still reads", () => {
  const dir = tmpStateDir("rmd-analytics-fresh-instance-");
  try {
    writeLive(dir, ['{"ts":"2026-08-14T00:00:00.000Z","task_id":"CLI","run_id":"CLI-1","step":"cli.invoked","verb":"status"}']);
    const lines = readAnalyticsLedgerLines(dir);
    assert.equal(lines.length, 1, "unlike resolveLedgerUnion (ledger-grep.ts), zero archives must not empty out a real live-file read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAnalyticsLedgerLines: a corrupt archive is skipped, best-effort, never a crash and never a refusal", () => {
  const dir = tmpStateDir("rmd-analytics-corrupt-");
  try {
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), "not actually gzip");
    writeLive(dir, ['{"ts":"2026-08-01T00:00:00.000Z","task_id":"W1-T1","run_id":"R1","step":"run.start"}']);
    const lines = readAnalyticsLedgerLines(dir);
    assert.equal(lines.length, 1, "the live row still reads even though the corrupt archive could not be opened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── deriveAnalyticsSnapshot: the four operator questions ────────────────────────────────────

test("deriveAnalyticsSnapshot: question 1 — invocation counts per verb, from cli.invoked rows only", () => {
  const snap = deriveAnalyticsSnapshot(
    [
      { step: "cli.invoked", verb: "status" },
      { step: "cli.invoked", verb: "status" },
      { step: "cli.invoked", verb: "sweep" },
      { step: "run.start", task_id: "W1-T1" }, // a different step — must not pollute the counts
    ],
    "2026-08-14T00:00:00.000Z",
  );
  assert.deepEqual(snap.invocationsByVerb, { status: 2, sweep: 1 });
  assert.equal(snap.invocationsUnmeasuredBefore, undefined, "the signal IS present here, so no unmeasured marker");
});

test("deriveAnalyticsSnapshot: invocationsUnmeasuredBefore renders, never a false zero, when no cli.invoked row exists anywhere", () => {
  const snap = deriveAnalyticsSnapshot([{ step: "run.start", task_id: "W1-T1" }], "2026-08-14T00:00:00.000Z");
  assert.deepEqual(snap.invocationsByVerb, {}, "empty, not fabricated");
  assert.equal(snap.invocationsUnmeasuredBefore, ANALYTICS_COLLECTION_STARTED_AT, "an empty {} alone would misread as zero calls");
});

test("deriveAnalyticsSnapshot: question 2 — worker rows grouped by lane and model, cost summed off total_cost_usd (never the cost_usd typo)", () => {
  const snap = deriveAnalyticsSnapshot(
    [
      { step: "verdict", lane: "run-task", model: "sonnet", total_cost_usd: 1.5, cost_usd: 999 },
      { step: "verdict", lane: "run-task", model: "sonnet", total_cost_usd: 0.5 },
      { step: "verdict", lane: "triage", model: "opus", total_cost_usd: 2 },
      { step: "run.start", task_id: "W1-T1" }, // no `model` field at all — not a worker row
    ],
    "2026-08-14T00:00:00.000Z",
  );
  const runTaskSonnet = snap.workersByLaneModel.find((b) => b.lane === "run-task" && b.model === "sonnet");
  assert.ok(runTaskSonnet, "run-task/sonnet bucket must exist");
  assert.equal(runTaskSonnet?.count, 2);
  assert.equal(runTaskSonnet?.totalCostUsd, 2, "1.5 + 0.5 off total_cost_usd — the bogus cost_usd field must never be read");
  const triageOpus = snap.workersByLaneModel.find((b) => b.lane === "triage" && b.model === "opus");
  assert.equal(triageOpus?.count, 1);
  assert.equal(snap.workersByLaneModel.length, 2, "the non-worker run.start row must not create a third bucket");
});

test("deriveAnalyticsSnapshot: a pre-W1-T477 worker row with no lane field groups under 'unknown', not dropped", () => {
  const snap = deriveAnalyticsSnapshot(
    [{ step: "verdict", model: "sonnet", total_cost_usd: 1 }],
    "2026-08-14T00:00:00.000Z",
  );
  assert.equal(snap.workersByLaneModel.length, 1);
  assert.equal(snap.workersByLaneModel[0].lane, "unknown");
});

test("deriveAnalyticsSnapshot: question 3 — run.start-to-verdict join per run_id, no-terminal counted explicitly, never dropped", () => {
  const snap = deriveAnalyticsSnapshot(
    [
      { step: "run.start", run_id: "R1", task_id: "W1-T1", ts: "2026-08-14T00:00:00.000Z" },
      { step: "verdict", run_id: "R1", task_id: "W1-T1", ts: "2026-08-14T00:05:00.000Z" },
      { step: "run.start", run_id: "R2", task_id: "W1-T2", ts: "2026-08-14T01:00:00.000Z" },
      // R2 never gets a verdict line — a gate-side merge / no-terminal run, per the rationale.
      { step: "retro.start", run_id: "RETRO-1", task_id: "RETRO", ts: "2026-08-14T02:00:00.000Z" },
      { step: "verdict", run_id: "RETRO-1", task_id: "RETRO", ts: "2026-08-14T02:05:00.000Z" },
    ],
    "2026-08-14T03:00:00.000Z",
  );
  assert.equal(snap.taskDurationsMs.length, 1, "only R1 has BOTH a run.start and a verdict line");
  assert.equal(snap.taskDurationsMs[0].runId, "R1");
  assert.equal(snap.taskDurationsMs[0].durationMs, 5 * 60 * 1000);
  assert.equal(snap.noTerminalTaskCount, 1, "R2 is counted, never silently dropped");
  // RETRO-1's verdict has no run.start (retro self-ledgers "retro.start", a different step) — its
  // verdict is correctly excluded from this join rather than miscounted.
});

test("deriveAnalyticsSnapshot: question 4 — worker duration grouped by lane, unmeasured-before when the signal is absent", () => {
  const measured = deriveAnalyticsSnapshot(
    [
      { step: "verdict", lane: "run-task", worker_duration_ms: 1000 },
      { step: "verdict", lane: "run-task", worker_duration_ms: 3000 },
      { step: "verdict", lane: "triage", worker_duration_ms: 2000 },
    ],
    "2026-08-14T00:00:00.000Z",
  );
  const runTask = measured.workerDurationsByLane.find((b) => b.lane === "run-task");
  assert.equal(runTask?.count, 2);
  assert.equal(runTask?.totalDurationMs, 4000);
  assert.equal(runTask?.avgDurationMs, 2000);
  assert.equal(measured.workerDurationsUnmeasuredBefore, undefined);

  const unmeasured = deriveAnalyticsSnapshot([{ step: "verdict", lane: "run-task", model: "sonnet" }], "2026-08-14T00:00:00.000Z");
  assert.deepEqual(unmeasured.workerDurationsByLane, []);
  assert.equal(unmeasured.workerDurationsUnmeasuredBefore, ANALYTICS_COLLECTION_STARTED_AT);
});

test("deriveAnalyticsSnapshot: the scope note and asOf always ride the payload", () => {
  const snap = deriveAnalyticsSnapshot([], "2026-08-14T00:00:00.000Z");
  assert.equal(snap.measures, ANALYTICS_SCOPE_NOTE);
  assert.equal(snap.asOf, "2026-08-14T00:00:00.000Z");
});

// ── the route itself ─────────────────────────────────────────────────────────────────────────

test("GET /v1/analytics is read-scoped and answers 200 from its real default reader, aggregating the real rotation union", () => {
  const dir = tmpStateDir("rmd-analytics-route-");
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","task_id":"CLI","run_id":"CLI-1","step":"cli.invoked","verb":"status"}',
    ]);
    writeLive(dir, ['{"ts":"2026-08-14T00:00:00.000Z","task_id":"CLI","run_id":"CLI-2","step":"cli.invoked","verb":"sweep"}']);

    const route = buildAnalyticsRoute({ ledgerPath, now: () => "2026-08-14T00:00:00.000Z" });
    assert.equal(route.method, "GET");
    assert.equal(route.path, "/v1/analytics");
    assert.equal(route.scope, "read", "read-scoped: the console's own aggregate, no write surface");

    let status = 0;
    let body = "";
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(chunk: string) {
        body = chunk;
      },
    } as unknown as ServerResponse;
    route.handler({} as never, res, { params: {} });

    assert.equal(status, 200);
    const parsed = JSON.parse(body) as AnalyticsSnapshot;
    assert.deepEqual(parsed.invocationsByVerb, { status: 1, sweep: 1 }, "the route's default reader ran the real rotation union, not just the live file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
