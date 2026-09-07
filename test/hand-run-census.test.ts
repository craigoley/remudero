import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  appendLedger,
  deriveLedgerActor,
  ledgerRowActor,
  markDaemonProcessActor,
  DECISION_RELEVANT_LEDGER_STEPS,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { WORKER_SCOPE_ENV } from "../src/lib/worker-containment.js";
import type { LedgerUnionResult } from "../src/lib/ledger-grep.js";
import {
  buildHandRunSessions,
  censusHandRuns,
  handRunCensus,
  handRunSequenceSignature,
  mineHandRunRecurrences,
  parseOperatorLedgerRows,
  alreadyProposedForSignature,
  HAND_RUN_CENSUS_PROPOSED_STEP,
  HAND_RUN_RECURRENCE_DAY_FLOOR,
  HAND_RUN_SESSION_GAP_MS,
  type HandRunLedgerRow,
} from "../src/lib/hand-run-census.js";
import { handRunsCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function operatorRow(ts: string, actorPid: number, step: string): HandRunLedgerRow {
  return { ts, actorPid, step };
}

function operatorLine(ts: string, actorPid: number, step: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, actor: "operator", actor_pid: actorPid, step, run_id: "r", task_id: "t", ...extra });
}

/** This SUITE ITSELF runs inside a real `rmd` worker subprocess, so `process.env` already
 *  carries `REMUDERO_WORKER_SCOPE` (and friends) — any test asserting the DEFAULT
 *  (real-`process.env`) "operator" outcome must clear them first, or it measures its own
 *  harness instead of the code under test. Restores whatever was there, even if a key was
 *  absent, so this suite never leaks env state to a sibling test file. */
function withClearedActorEnv<T>(fn: () => T): T {
  const keys = ["REMUDERO_WORKER_SCOPE", "REMUDERO_RUN_ID", "REMUDERO_TASK_ID", "REMUDERO_DAEMON_PROCESS"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── W1-T2697 claim 1: every new ledger row carries an actor derived from process context, and a
// pre-stamp row reports unknown rather than a guess ─────────────────────────────────────────────

test("deriveLedgerActor: worker marker wins over the daemon marker; neither present is operator", () => {
  assert.equal(deriveLedgerActor({}), "operator");
  assert.equal(deriveLedgerActor({ REMUDERO_DAEMON_PROCESS: "1" }), "daemon");
  assert.equal(deriveLedgerActor({ [WORKER_SCOPE_ENV]: "rmd-v1-abc" }), "worker");
  // A worker spawned FROM the daemon inherits BOTH markers — worker must win, never daemon.
  assert.equal(deriveLedgerActor({ REMUDERO_DAEMON_PROCESS: "1", [WORKER_SCOPE_ENV]: "rmd-v1-abc" }), "worker");
});

test("markDaemonProcessActor: sets the in-process marker deriveLedgerActor reads back", () => {
  withClearedActorEnv(() => {
    assert.equal(deriveLedgerActor(), "operator");
    markDaemonProcessActor();
    assert.equal(deriveLedgerActor(), "daemon");
  });
});

test("ledgerRowActor: a valid actor passes through; a missing or malformed one is unknown, never guessed", () => {
  assert.equal(ledgerRowActor({ actor: "operator" }), "operator");
  assert.equal(ledgerRowActor({ actor: "worker" }), "worker");
  assert.equal(ledgerRowActor({ actor: "daemon" }), "daemon");
  assert.equal(ledgerRowActor({}), "unknown");
  assert.equal(ledgerRowActor({ actor: "root" }), "unknown");
  assert.equal(ledgerRowActor({ actor: 7 }), "unknown");
});

test("appendLedger: stamps actor (via deriveLedgerActor by default, injectable) and actor_pid — a pre-stamp row on disk has neither", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-run-append-`));
  try {
    const path = join(dir, "ledger.ndjson");
    // A pre-stamp row, exactly as one written before this task shipped — no `actor` key at all.
    writeFileSync(path, '{"run_id":"r0","task_id":"t0","step":"legacy.step"}\n');

    appendLedger(path, { run_id: "r1", task_id: "t1", step: "operator.step" } as LedgerLine, {
      actor: () => "worker",
    });

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerRowActor(lines[0]), "unknown", "the pre-stamp row must report unknown, never a guess");
    assert.equal(lines[1].actor, "worker", "opts.actor overrides the process-derived default");
    assert.equal(lines[1].actor_pid, process.pid);

    withClearedActorEnv(() => {
      appendLedger(path, { run_id: "r2", task_id: "t2", step: "operator.step2" } as LedgerLine);
    });
    const lines2 = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines2[2].actor, "operator", "no injected actor and no worker/daemon marker set -> operator");
    assert.equal(lines2[2].actor_pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLedger: actor_pid never collides with an unrelated caller-supplied `pid` field (e.g. fix.spawn_reclaimed's candidate pid)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-run-pid-collision-`));
  try {
    const path = join(dir, "ledger.ndjson");
    appendLedger(
      path,
      { run_id: "r1", task_id: "t1", step: "fix.spawn_reclaimed", pid: 999999 } as unknown as LedgerLine,
      { actor: () => "operator" },
    );
    const [line] = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(line.pid, 999999, "the caller's own `pid` field (a different process entirely) must survive untouched");
    assert.equal(line.actor_pid, process.pid, "actor_pid is the WRITER's pid, under its own distinct key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HAND_RUN_CENSUS_PROPOSED_STEP is registered in DECISION_RELEVANT_LEDGER_STEPS — a rotation must never archive this module's own dedup marker", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(HAND_RUN_CENSUS_PROPOSED_STEP));
});

// ── W1-T2697 claim 2: the miner reads the ledger union, groups operator rows into sessions, and
// reports a sequence only when it recurs across the floor of distinct days ─────────────────────

test("parseOperatorLedgerRows: keeps only actor:operator rows with actor_pid/step/ts, skips foreign/malformed lines", () => {
  const rows = parseOperatorLedgerRows([
    operatorLine("2026-09-01T10:00:00.000Z", 111, "status"),
    JSON.stringify({ ts: "2026-09-01T10:01:00.000Z", actor: "worker", actor_pid: 222, step: "run.start" }),
    JSON.stringify({ ts: "2026-09-01T10:02:00.000Z", actor: "operator", step: "no.pid" }),
    "not json at all",
    "",
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, "status");
  assert.equal(rows[0].actorPid, 111);
});

test("buildHandRunSessions: groups consecutive same-pid rows into one session, splits on a >30 minute gap", () => {
  const rows: HandRunLedgerRow[] = [
    operatorRow("2026-09-01T10:00:00.000Z", 111, "status"),
    operatorRow("2026-09-01T10:05:00.000Z", 111, "triage"),
    // gap > 30min from the row above -> a NEW session, same pid (OS pid reuse guard)
    operatorRow("2026-09-01T11:00:00.001Z", 111, "status"),
  ];
  const sessions = buildHandRunSessions(rows);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0].sequence, ["status", "triage"]);
  assert.deepEqual(sessions[1].sequence, ["status"]);
});

test("buildHandRunSessions: a gap of exactly the threshold stays in one session; one tick over splits", () => {
  const boundary = new Date(Date.parse("2026-09-01T10:00:00.000Z") + HAND_RUN_SESSION_GAP_MS).toISOString();
  const overBoundary = new Date(Date.parse("2026-09-01T10:00:00.000Z") + HAND_RUN_SESSION_GAP_MS + 1).toISOString();
  const atFloor = buildHandRunSessions([operatorRow("2026-09-01T10:00:00.000Z", 5, "a"), operatorRow(boundary, 5, "b")]);
  assert.equal(atFloor.length, 1, "exactly 30 minutes is still the same session");
  const overFloor = buildHandRunSessions([operatorRow("2026-09-01T10:00:00.000Z", 5, "a"), operatorRow(overBoundary, 5, "b")]);
  assert.equal(overFloor.length, 2, "one millisecond past 30 minutes splits");
});

test("handRunSequenceSignature: order-preserving, so a reordered sequence is a DIFFERENT signature", () => {
  assert.equal(handRunSequenceSignature(["a", "b"]), "a|b");
  assert.notEqual(handRunSequenceSignature(["a", "b"]), handRunSequenceSignature(["b", "a"]));
});

test("mineHandRunRecurrences: a sequence recurring on >=2 distinct days is a recurrence; a single day is not, however many sessions", () => {
  const rows: HandRunLedgerRow[] = [
    // pid 1, day 1: two sessions of the SAME two-step sequence, still only ONE distinct day
    operatorRow("2026-09-01T09:00:00.000Z", 1, "status"),
    operatorRow("2026-09-01T09:01:00.000Z", 1, "triage"),
    operatorRow("2026-09-01T12:00:00.000Z", 2, "status"),
    operatorRow("2026-09-01T12:01:00.000Z", 2, "triage"),
    // pid 3, day 2: the SAME sequence again, a SECOND distinct day -> recurrence
    operatorRow("2026-09-02T09:00:00.000Z", 3, "status"),
    operatorRow("2026-09-02T09:01:00.000Z", 3, "triage"),
    // a different, single-day-only sequence must not appear
    operatorRow("2026-09-01T15:00:00.000Z", 4, "sweep"),
    operatorRow("2026-09-01T15:01:00.000Z", 4, "review"),
  ];
  const recurrences = mineHandRunRecurrences(rows);
  assert.equal(recurrences.length, 1);
  assert.deepEqual(recurrences[0].sequence, ["status", "triage"]);
  assert.deepEqual(recurrences[0].distinctDays, ["2026-09-01", "2026-09-02"]);
  assert.equal(recurrences[0].sessionCount, 3);
  assert.equal(recurrences[0].evidenceRows.length, 6);
});

test("mineHandRunRecurrences: a single-row session (sequence length 1) never counts, even repeated across many days", () => {
  const rows: HandRunLedgerRow[] = [
    operatorRow("2026-09-01T09:00:00.000Z", 1, "status"),
    operatorRow("2026-09-02T09:00:00.000Z", 2, "status"),
    operatorRow("2026-09-03T09:00:00.000Z", 3, "status"),
  ];
  assert.deepEqual(mineHandRunRecurrences(rows), []);
});

test("mineHandRunRecurrences: dayFloor is overridable (a floor of 3 refuses a two-day recurrence)", () => {
  const rows: HandRunLedgerRow[] = [
    operatorRow("2026-09-01T09:00:00.000Z", 1, "a"),
    operatorRow("2026-09-01T09:01:00.000Z", 1, "b"),
    operatorRow("2026-09-02T09:00:00.000Z", 2, "a"),
    operatorRow("2026-09-02T09:01:00.000Z", 2, "b"),
  ];
  assert.equal(mineHandRunRecurrences(rows).length, 1, "default floor (2) accepts it");
  assert.equal(mineHandRunRecurrences(rows, { dayFloor: 3 }).length, 0, "a floor of 3 refuses the same evidence");
});

test("HAND_RUN_RECURRENCE_DAY_FLOOR is the default mineHandRunRecurrences applies", () => {
  assert.equal(HAND_RUN_RECURRENCE_DAY_FLOOR, 2);
});

// ── censusHandRuns: the read-only union-backed entry point ──────────────────────────────────

test("censusHandRuns: refused when the ledger union cannot be trusted (never a live-file-only answer, W1-T1013)", () => {
  const fakeUnion = (): LedgerUnionResult => ({
    stateDir: "/state",
    archiveFiles: [],
    archiveCount: 0,
    liveFileRead: true,
    unread: [],
    ok: false,
    matches: [],
  });
  const result = censusHandRuns("/state", fakeUnion);
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.match(result.refusedReason, /ledger corpus incomplete/);
});

test("censusHandRuns: refused when the union is trustworthy but carries no actor-stamped operator row yet", () => {
  const fakeUnion = (): LedgerUnionResult => ({
    stateDir: "/state",
    archiveFiles: ["a.gz"],
    archiveCount: 1,
    liveFileRead: true,
    unread: [],
    ok: true,
    matches: ['{"actor":"worker","actor_pid":1,"step":"run.start","ts":"2026-09-01T00:00:00.000Z"}'],
  });
  const result = censusHandRuns("/state", fakeUnion);
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.match(result.refusedReason, /no actor-stamped operator row/);
});

test("censusHandRuns: measured, over a real gzipped-archive + live-file union", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-run-census-union-`));
  try {
    writeGzArchive(dir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz", [
      operatorLine("2026-09-01T09:00:00.000Z", 100, "status"),
      operatorLine("2026-09-01T09:01:00.000Z", 100, "triage"),
    ]);
    writeFileSync(
      join(dir, "ledger.ndjson"),
      [operatorLine("2026-09-02T09:00:00.000Z", 200, "status"), operatorLine("2026-09-02T09:01:00.000Z", 200, "triage")].join("\n") + "\n",
    );
    const result = censusHandRuns(dir);
    assert.equal(result.status, "measured");
    if (result.status === "measured") {
      assert.equal(result.operatorRowCount, 4);
      assert.equal(result.recurrences.length, 1);
      assert.deepEqual(result.recurrences[0].sequence, ["status", "triage"]);
      assert.deepEqual(result.recurrences[0].distinctDays, ["2026-09-01", "2026-09-02"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T2697 claim 3: a recurrence becomes exactly one inbox entry with its evidence, deduped
// against the union, and never a rung ────────────────────────────────────────────────────────

const MEASURED_UNION = (matches: string[] = []): LedgerUnionResult => ({
  stateDir: "/state",
  archiveFiles: ["a.gz"],
  archiveCount: 1,
  liveFileRead: true,
  unread: [],
  ok: true,
  matches,
});

function twoDayRecurrenceRows(): string[] {
  return [
    operatorLine("2026-09-01T09:00:00.000Z", 100, "status"),
    operatorLine("2026-09-01T09:01:00.000Z", 100, "triage"),
    operatorLine("2026-09-02T09:00:00.000Z", 200, "status"),
    operatorLine("2026-09-02T09:01:00.000Z", 200, "triage"),
  ];
}

test("handRunCensus: refused propagates straight from censusHandRuns — capture is never called", () => {
  let captured = 0;
  const result = handRunCensus({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-1",
    ledgerUnion: () => ({ stateDir: "/state", archiveFiles: [], archiveCount: 0, liveFileRead: true, unread: [], ok: false, matches: [] }),
    capture: () => {
      captured++;
      return { id: "fb-x" } as never;
    },
  });
  assert.equal(result.status, "refused");
  assert.equal(captured, 0);
});

test("handRunCensus: an unproposed recurrence files EXACTLY ONE feedback entry naming the sequence and days, and appends the dedup marker", () => {
  const captures: { root: string; raw: string }[] = [];
  const written: { path: string; line: LedgerLine }[] = [];
  const result = handRunCensus({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-1",
    ledgerUnion: (_stateDir, pattern) => {
      const patternStr = String(pattern);
      // The first call is censusHandRuns' own operator-row read; the second is the dedup marker
      // read. Route by what the pattern is actually anchored on, mirroring the real regexes.
      if (patternStr.includes("census_proposed")) return MEASURED_UNION([]);
      return MEASURED_UNION(twoDayRecurrenceRows());
    },
    capture: (root, opts) => {
      captures.push({ root, raw: opts.raw });
      return { id: "fb-1" } as never;
    },
    writeLedgerLine: (path, line) => {
      written.push({ path, line });
    },
  });
  assert.equal(result.status, "measured");
  if (result.status === "measured") {
    assert.equal(result.recurrenceCount, 1);
    assert.deepEqual(result.proposedSignatures, ["status|triage"]);
    assert.deepEqual(result.skippedDuplicateSignatures, []);
  }
  assert.equal(captures.length, 1, "exactly one inbox entry per recurrence");
  assert.match(captures[0].raw, /status → triage/);
  assert.match(captures[0].raw, /2026-09-01, 2026-09-02/);
  assert.equal(written.length, 1);
  assert.equal(written[0].line.step, HAND_RUN_CENSUS_PROPOSED_STEP);
  assert.equal((written[0].line as unknown as { signature: string }).signature, "status|triage");
});

test("handRunCensus: a recurrence already proposed (its signature is in the ledger union) is skipped — capture never called again", () => {
  const captures: unknown[] = [];
  const result = handRunCensus({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-1",
    ledgerUnion: (_stateDir, pattern) => {
      const patternStr = String(pattern);
      if (patternStr.includes("census_proposed")) {
        return MEASURED_UNION([JSON.stringify({ step: HAND_RUN_CENSUS_PROPOSED_STEP, signature: "status|triage" })]);
      }
      return MEASURED_UNION(twoDayRecurrenceRows());
    },
    capture: () => {
      captures.push(1);
      return { id: "fb-1" } as never;
    },
    writeLedgerLine: () => {},
  });
  assert.equal(result.status, "measured");
  if (result.status === "measured") {
    assert.deepEqual(result.proposedSignatures, []);
    assert.deepEqual(result.skippedDuplicateSignatures, ["status|triage"]);
  }
  assert.equal(captures.length, 0);
});

test("handRunCensus: the dedup union cannot confirm (ok:false) -> fails OPEN and proposes anyway, the same W1-T470 discipline coverage-improvement.ts uses", () => {
  let captured = 0;
  const result = handRunCensus({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-1",
    ledgerUnion: (_stateDir, pattern) => {
      const patternStr = String(pattern);
      if (patternStr.includes("census_proposed")) {
        return { stateDir: "/state", archiveFiles: [], archiveCount: 0, liveFileRead: true, unread: [], ok: false, matches: [] };
      }
      return MEASURED_UNION(twoDayRecurrenceRows());
    },
    capture: () => {
      captured++;
      return { id: "fb-1" } as never;
    },
    writeLedgerLine: () => {},
  });
  assert.equal(result.status, "measured");
  assert.equal(captured, 1);
});

test("alreadyProposedForSignature: true only for an exact signature match, ignoring unrelated/malformed lines", () => {
  const lines = [
    JSON.stringify({ step: HAND_RUN_CENSUS_PROPOSED_STEP, signature: "a|b" }),
    JSON.stringify({ step: "something.else", signature: "a|b" }),
    "not json",
  ];
  assert.equal(alreadyProposedForSignature(lines, "a|b"), true);
  assert.equal(alreadyProposedForSignature(lines, "c|d"), false);
});

// ── W1-T2697 claim 4 (measurement-cadence.ts side): grep: handRunCensus( in
// src/lib/measurement-cadence.ts, verified directly rather than re-implemented here ──────────

// @source-text-subject — this test's SUBJECT genuinely is the source text: the task's own
// acceptance criterion is `grep: handRunCensus( in src/lib/measurement-cadence.ts` (W1-T2905's
// census would otherwise count this as a behaviour test standing in for a prose read).
test("measurement-cadence.ts calls handRunCensus( — the wiring grep this task's acceptance names", () => {
  const src = readFileSync(new URL("../src/lib/measurement-cadence.ts", import.meta.url), "utf8");
  assert.match(src, /handRunCensus\(/);
});

// ── `rmd hand-runs`: prints the census on demand, read-only ─────────────────────────────────

test("handRunsCommand: an unexpected argument is refused (exit 2)", () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(handRunsCommand(["--bogus"]), 2);
  } finally {
    console.error = realErr;
  }
});

test("handRunsCommand: a refused census exits non-zero and names the reason, printing no result line", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-runs-cli-refused-`));
  const logs: string[] = [];
  const errs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  try {
    // no archives under dir -> resolveLedgerUnion refuses
    const code = handRunsCommand([], { stateDir: dir });
    assert.equal(code, 1);
    assert.match(errs.join("\n"), /rmd hand-runs: refused/);
    assert.doesNotMatch(logs.join("\n"), /recurrences:/);
  } finally {
    console.log = realLog;
    console.error = realErr;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handRunsCommand: a measured census exits 0 and prints each recurrence's sequence, days and session count", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-runs-cli-measured-`));
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    writeGzArchive(dir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz", [
      operatorLine("2026-09-01T09:00:00.000Z", 100, "status"),
      operatorLine("2026-09-01T09:01:00.000Z", 100, "triage"),
    ]);
    writeFileSync(
      join(dir, "ledger.ndjson"),
      [operatorLine("2026-09-02T09:00:00.000Z", 200, "status"), operatorLine("2026-09-02T09:01:00.000Z", 200, "triage")].join("\n") + "\n",
    );
    const code = handRunsCommand([], { stateDir: dir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /operator rows: 4/);
    assert.match(out, /recurrences:\s+1/);
    assert.match(out, /status → triage/);
    assert.match(out, /2026-09-01, 2026-09-02/);
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the stateDir seam's DEFAULT arm, which every other test bypasses ─────────────────────────────

/*
 * diff-coverage flagged run-task.ts:17829-17833 — the `opts.stateDir ?? (…loadConfig()…)` default
 * and its catch. Every test above supplies `opts.stateDir`, so the arm that runs IN PRODUCTION was
 * the one arm nothing drove: exactly the seam pattern CLAUDE.md names, where a deps object
 * supplying the fake leaves the real default unreachable. Both arms are reached here by redirecting
 * HOME, which is what `loadConfig` resolves its config path from — the same idiom
 * test/a-github-check-fanout-is-a-sweep-storm.test.ts uses.
 */

function withHome<T>(home: string, run: () => T): T {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

test("handRunsCommand: with no stateDir supplied it resolves one from the config's own root", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-runs-default-statedir-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const errs: string[] = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  console.log = () => {};
  try {
    // The state dir exists but holds no archives, so the census refuses — which is the point: the
    // refusal proves the DEFAULT resolution ran and handed it a real path, rather than the
    // "cannot resolve a state dir" the catch arm below produces.
    const code = withHome(home, () => handRunsCommand([]));
    assert.equal(code, 1);
    assert.match(errs.join("\n"), /refused/, "the census must have been reached with a resolved dir");
    assert.doesNotMatch(errs.join("\n"), /cannot resolve a state dir/, "the catch arm must NOT have fired");
  } finally {
    console.error = realErr;
    console.log = realLog;
    rmSync(home, { recursive: true, force: true });
  }
});

test("handRunsCommand: an unreadable config is reported by name, never guessed at", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-runs-bad-config-`));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  // Malformed JSON: loadConfig throws rather than returning a root to join onto.
  writeFileSync(join(home, ".config", "remudero", "config.json"), "{ not json\n");
  const errs: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  try {
    const code = withHome(home, () => handRunsCommand([]));
    assert.equal(code, 1);
    assert.match(errs.join("\n"), /cannot resolve a state dir/, "the catch arm must name the failure");
  } finally {
    console.error = realErr;
    rmSync(home, { recursive: true, force: true });
  }
});
