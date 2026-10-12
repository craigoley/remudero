// W1-T5059 — the plan-complete re-measure instrument (scripts/arch-remeasure.mjs).
//
// The shard's falsifier: count only the live file and the dated archives, and a fixture holding merges only in
// the OTHER form reads a clean zero instead of refusing. The control is files-read-per-form against
// files-present-per-form, where PRESENT comes from one directory listing classified by form (discovery) and READ
// from the files the reader actually finished. A form absent from disk is reported, never refused.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { makeTempDir } from "../src/lib/tmp.js";

// @ts-expect-error — this executable .mjs intentionally has no declaration output; the seam this suite
// consumes is declared immediately below rather than left as any.
import * as remeasureModule from "../scripts/arch-remeasure.mjs";

type Form = "gz" | "plain" | "live";
interface FormCount { present: number; read: number; state?: string }
interface RecountLine {
  recount?: string; expected?: number | null; observed?: number | null; match?: boolean | null;
  forms?: Record<string, FormCount>; refused?: string; blindForms?: string[]; summary?: boolean; oracle_blind?: string[];
}
interface Remeasure {
  ORACLE_BLIND: string;
  ABSENT: string;
  discoverForms(names: string[]): Record<Form, string[]>;
  selectUnionFiles(names: string[]): string[];
  runRecounts(opts: {
    stateDir: string; nowBody: unknown; planIds: Set<string> | null; feedbackRoot?: string; nowMs: number;
    select?: (names: string[]) => string[];
  }): Promise<{ lines: RecountLine[]; exitCode: number }>;
  recountOpenGrill(entries: unknown[]): { count: number; ids: string[] };
  runProbe(opts: {
    routes: string[]; sweeps?: number; gapMs?: number; baseUrl: string; token?: string;
    fetchImpl: (url: string, init: unknown) => Promise<{ status: number; headers: { get(k: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
    readLagRows: () => Array<Record<string, unknown>>; sleep: (ms: number) => Promise<void>; now: () => number;
  }): Promise<{ aborted: boolean; reason?: string; samples: unknown[] }>;
}
const remeasure = remeasureModule as Remeasure;

const AS_OF = "2026-10-05T12:00:00.000Z";
const AS_OF_MS = Date.parse(AS_OF);
const nowBody = (mergedToday: number, running = 0) => ({
  generatedAt: AS_OF,
  data: { recent: { mergedToday: { count: mergedToday, day: "2026-10-05" } }, board: { counts: { running } }, decisions: [] },
});
const merge = (task: string, pr: number, ts: string) =>
  JSON.stringify({ ts, run_id: `run-${task}`, task_id: task, step: "verdict.merged", pr_url: `https://github.com/o/r/pull/${pr}` });
const noise = (ts: string) => JSON.stringify({ ts, run_id: "x", task_id: "INCIDENT", step: "daemon.pulse" });

/** A state dir holding the given files: `.gz` names are gzipped, everything else is written plain. */
function stateDirWith(files: Record<string, string[]>): string {
  const dir = makeTempDir("w1t5059-state");
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    const text = lines.map((l) => `${l}\n`).join("");
    writeFileSync(join(dir, name), name.endsWith(".gz") ? gzipSync(text) : text);
  }
  return dir;
}

const GZ = "ledger.2026-10-04T00-00-00-000Z.ndjson.gz";
const PLAIN = "ledger.2026-10-05T06-00-00-000Z.ndjson";
const LIVE = "ledger.ndjson";

test("W1-T5059: a recount refuses when one rotation form contributed zero files", async () => {
  // The merges live ONLY in the plain rotation; the reader's glob names the live file and the dated .gz archives.
  const stateDir = stateDirWith({
    [GZ]: [noise("2026-10-04T01:00:00.000Z")],
    [PLAIN]: [merge("W1-T1", 11, "2026-10-05T07:00:00.000Z"), merge("W1-T2", 12, "2026-10-05T08:00:00.000Z")],
    [LIVE]: [noise("2026-10-05T11:00:00.000Z")],
  });
  const twoPatternGlob = (names: string[]) => remeasure.selectUnionFiles(names).filter((n) => !/^ledger\..+\.ndjson$/.test(n));
  const { lines, exitCode } = await remeasure.runRecounts({ stateDir, nowBody: nowBody(2), planIds: null, nowMs: AS_OF_MS, select: twoPatternGlob });
  const merged = lines.find((l) => l.recount === "merged_today");
  assert.ok(merged, "the merged-today recount line is emitted");
  // Without the control this would read a clean, wrong zero against the view's 2.
  assert.equal(merged.observed, 0);
  assert.equal(merged.refused, remeasure.ORACLE_BLIND);
  assert.deepEqual(merged.blindForms, ["plain"]);
  assert.equal(merged.match, null, "a blind recount is never reported as a match or a mismatch");
  assert.deepEqual(merged.forms?.plain, { present: 1, read: 0, state: remeasure.ORACLE_BLIND });
  assert.deepEqual(lines.at(-1)?.oracle_blind, ["plain"]);
  assert.notEqual(exitCode, 0);
});

test("W1-T5059: merges split across the .gz, plain and live forms count each PR once and match the view", async () => {
  const shared = merge("W1-T1", 11, "2026-10-05T07:00:00.000Z"); // duplicated into every rotation, as rotations do
  const stateDir = stateDirWith({
    [GZ]: [shared, merge("W1-T9", 90, "2026-10-04T23:00:00.000Z") /* yesterday: not counted */],
    [PLAIN]: [shared, merge("W1-T2", 12, "2026-10-05T08:00:00.000Z")],
    [LIVE]: [shared, merge("W1-T3", 13, "2026-10-05T11:00:00.000Z"), merge("W1-T3", 13, "2026-10-05T11:00:01.000Z")],
    "ledger.ndjson.carried.json": ["{}"],
  });
  const { lines, exitCode } = await remeasure.runRecounts({ stateDir, nowBody: nowBody(3), planIds: null, nowMs: AS_OF_MS });
  const merged = lines.find((l) => l.recount === "merged_today");
  assert.equal(merged?.observed, 3);
  assert.equal(merged?.match, true);
  assert.deepEqual(merged?.forms, { gz: { present: 1, read: 1 }, plain: { present: 1, read: 1 }, live: { present: 1, read: 1 } });
  assert.equal(exitCode, 0);
});

test("W1-T5059: a form absent from disk is reported absent, not refused", async () => {
  // The production host's shape: .gz rotations and the live file, zero plain rotations.
  const stateDir = stateDirWith({ [GZ]: [merge("W1-T1", 11, "2026-10-05T01:00:00.000Z")], [LIVE]: [merge("W1-T2", 12, "2026-10-05T09:00:00.000Z")] });
  const { lines, exitCode } = await remeasure.runRecounts({ stateDir, nowBody: nowBody(2), planIds: null, nowMs: AS_OF_MS });
  const merged = lines.find((l) => l.recount === "merged_today");
  assert.deepEqual(merged?.forms?.plain, { present: 0, read: 0, state: remeasure.ABSENT });
  assert.equal(merged?.refused, undefined);
  assert.equal(merged?.observed, 2);
  assert.equal(exitCode, 0);
});

test("W1-T5059: the running recount closes a run on its terminal step and drops one quiet past the liveness bound", async () => {
  const row = (task: string, step: string, ts: string) => JSON.stringify({ ts, run_id: `run-${task}`, task_id: task, step });
  const stateDir = stateDirWith({
    [LIVE]: [
      row("W1-T1", "run.start", "2026-10-05T11:50:00.000Z"), // live: activity 10 min ago
      row("W1-T2", "run.start", "2026-10-05T11:40:00.000Z"), row("W1-T2", "verdict", "2026-10-05T11:45:00.000Z"), // closed
      row("W1-T3", "run.start", "2026-10-05T10:00:00.000Z"), // quiet for 2 h: stale dispatch
    ],
  });
  const { lines } = await remeasure.runRecounts({ stateDir, nowBody: nowBody(0, 1), planIds: null, nowMs: AS_OF_MS });
  const running = lines.find((l) => l.recount === "running");
  assert.equal(running?.observed, 1);
  assert.equal(running?.match, true);
});

test("W1-T5059: open grill entries are grilling entries with no answer and no non-empty reply", () => {
  const { count, ids } = remeasure.recountOpenGrill([
    { id: "a", status: "grilling" },
    { id: "b", status: "grilling", answered_by: "c" },
    { id: "d", status: "grilling" }, { id: "e", status: "captured", reply_to: "d", raw: "yes" },
    { id: "f", status: "grilling" }, { id: "g", status: "captured", reply_to: "f", raw: "  " },
    { id: "h", status: "answered" },
  ]);
  assert.equal(count, 2);
  assert.deepEqual(ids, ["a", "f"]);
});

test("W1-T5059: the probe aborts after two consecutive loop-lag windows over 10 s", async () => {
  let clock = AS_OF_MS;
  let minute = 0;
  const lagRows: Array<Record<string, unknown>> = [];
  const windows = [{ maxMs: 12_000 }, { maxMs: 3_000 }, { maxMs: 11_000 }, { maxMs: 15_000 }];
  let requests = 0;
  const result = await remeasure.runProbe({
    routes: ["/a", "/b", "/c", "/d", "/e", "/f"], baseUrl: "http://probe.invalid", token: "t",
    fetchImpl: async () => {
      requests += 1;
      return { status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode("{}").buffer as ArrayBuffer };
    },
    // One new lag window lands after each request; a reset (3 s) between two over-limit windows restarts the streak.
    readLagRows: () => lagRows,
    sleep: async (ms) => {
      clock += ms;
      const next = windows.shift();
      minute += 1;
      if (next) lagRows.push({ step: "runtime.loop_lag", ts: `2026-10-05T12:0${minute}:00.000Z`, ...next });
    },
    now: () => clock,
  });
  assert.equal(result.aborted, true);
  assert.match(result.reason ?? "", /2 consecutive windows/);
  assert.equal(requests, 4, "the 12 s window alone, then the reset, do not abort; the 11 s + 15 s pair does");
});
