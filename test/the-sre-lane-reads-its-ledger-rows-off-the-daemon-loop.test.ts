/**
 * W1-T13367 — the SRE lane reads its ledger rows off the daemon loop.
 *
 * MEASURED 2026-11-17 (core ledger, daemon.loop_stall_profile): runSreLanePass was in 16 of 115 stall rows, 85.6 s
 * of lag in 22 minutes. Each pass ran five synchronous union reads that parsed the whole 15.9 MB live file, and
 * four whole reads of that file. The daemon now gives the lane one slice reader (rotations loaded off the loop,
 * a durable digest for each, the live file read from where the last pass stopped), and the lane's live reads use
 * the live file's tail.
 *
 * Every test builds the lane's input as src/cli/commands/daemon.ts does: daemonSreLaneInput with a reader from
 * createEscalationTriageHistoryReader({ slice: SRE_LANE_FLOW_SLICE }). The state dirs hold real gzip rotations.
 */
import assert from "node:assert/strict";
import fs, { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

import { fixedClock } from "#src/lib/clock.js";
import { queuedFeedbackLandings } from "#src/lib/feedback-landing.js";
import type { FleetFlowDetector } from "#src/lib/fleet-flow-detectors.js";
import { foreignPauseDetector, parsePausePolicy } from "#src/lib/foreign-pause-detector.js";
import { ALL_CAUSE_IDLE_POPULATION, idleCapacityDetector } from "#src/lib/idle-capacity-detector.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { ledgerRotationEntries } from "#src/lib/ledger-union.js";
import { daemonSreLaneInput, runSreLanePass, SRE_LANE_FLOW_SLICE, type SreLaneInput } from "#src/lib/sre-lane.js";
import { daemonSreGovernorEnforcer, readGovernorIncidents, readRunbookReceipts } from "#src/lib/sre-runbooks.js";
import { readLedgerLines } from "#src/lib/status.js";
import { strandedTaskDetector } from "#src/lib/stranded-task-detector.js";
import { createEscalationTriageHistoryReader } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

type Row = Record<string, unknown>;

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;
const NOW = at("2026-10-11T19:00:00.000Z");
/** A whole-second mtime, so restoring it reproduces the size:mtime key a digest is bound to. */
const MTIME_S = 1_794_000_000;
const LEDGER_FILE = /^ledger(\.[^/\\]+)?\.ndjson(\.gz)?$/;

// ── the corpus: rows that make each detector and the router write ───────────────────────────────

const start = (ms: number, task: string): Row => ({ ts: iso(ms), run_id: `R-${ms}`, task_id: task, step: "run.start", type: "implement" });
const verdict = (ms: number, task: string, fields: Row): Row => ({ ts: iso(ms), run_id: `R-${ms}`, task_id: task, step: "verdict", ...fields });
const yielded = (ms: number, task: string): Row => verdict(ms, task, { verdict: "handed_off", reason: "freshness_yield" });

/** The stranded-task detector's own history: six tasks that reached a PR, six that were handed off and resumed. */
function strandedBaseline(origin: number): Row[] {
  const rows: Row[] = [];
  [0, 1, 1, 2, 2, 3].forEach((gap, i) => {
    const t0 = origin + i * 300 * MIN;
    const task = `BASE-${i}`;
    rows.push(start(t0, task), yielded(t0 + 10 * MIN, task));
    for (let k = 0; k < gap; k++) rows.push(start(t0 + (11 + k) * MIN, `FILL-${i}-${k}`));
    rows.push(start(t0 + 30 * MIN, task), { ts: iso(t0 + (60 + i * 10) * MIN), run_id: `R-${t0}`, task_id: task, step: "pr.opened" });
  });
  return rows;
}

/** W1-T7742 on 2026-10-10/11: interrupted only by the harness, never reaching a PR. */
function strandedTask(): Row[] {
  const task = "W1-T7742";
  return [
    start(at("2026-10-10T20:50:00Z"), task),
    verdict(at("2026-10-10T21:13:34Z"), task, { verdict: "no_pr", reason: "restart_checkpoint_failed" }),
    start(at("2026-10-11T04:40:00Z"), task),
    yielded(at("2026-10-11T04:49:28Z"), task),
    start(at("2026-10-11T06:20:00Z"), task),
    verdict(at("2026-10-11T06:25:00Z"), task, { verdict: "failed", stage: "worktree.node_modules" }),
    start(at("2026-10-11T06:50:00Z"), task),
    verdict(at("2026-10-11T06:52:00Z"), task, { verdict: "blocked_inflight" }),
    yielded(at("2026-10-11T07:03:40Z"), task),
  ];
}

const idle = (ms: number, fields: Row): Row => ({ ts: iso(ms), step: "lane.idle_changed", at_ms: ms, capacity: 3, ...fields });
const free = (ms: number): Row => idle(ms, { cause: null, idle_slots: 0, dispatchable: 0, hold: null });
const RECYCLE_REASON = "PAUSE requested: container recycle (deploy/recycle-container.sh)";
const PAUSE_REASON = "maintenance: supervised serve restoration window (core only)";
const PAUSE_SESSION = "operator-serve-restoration-20261011-supervised-v4";
const PAUSE_AT = at("2026-10-11T18:20:00Z");

/** Six host-recycle drains that left no pause row (the automation's own history), then a pause set from outside
 *  the fleet that is still in force at NOW, with two slots idle behind it. */
function pauseRows(): Row[] {
  const history = [1, 1, 2, 2, 2, 2].flatMap((minutes, i) => {
    const t0 = at("2026-10-10T20:00:00Z") + i * 3 * 60 * MIN;
    return [idle(t0, { cause: "recycle_drain", idle_slots: 3, dispatchable: 9, hold: { reason: RECYCLE_REASON } }), free(t0 + minutes * MIN)];
  });
  const actorEvidence = {
    kind: "human", os_user: "codex", host: "Remudero", agent_markers: [], tty: { stdin: false, stdout: false },
    parents: ["sshd"], caller_class: "remote non-interactive", ssh: { client_address: "10.0.0.9", pty: false },
  };
  return [
    ...history,
    { ts: iso(PAUSE_AT), step: "fleet.pause", task_id: "FLEET", scope: "instance", instance: "core", reason: PAUSE_REASON,
      session_id: PAUSE_SESSION, actor: "unknown", actor_evidence: actorEvidence, expires_at: "2026-10-11T22:20:00.000Z", run_id: "FLEET-9" },
    idle(PAUSE_AT + 1000, { cause: "operator_pause", idle_slots: 2, dispatchable: 9, hold: { reason: PAUSE_REASON, session_id: PAUSE_SESSION } }),
  ];
}

/** The 2026-10-11 hand actions: pauses and resumes by hand, a breaker trip and its hand release, a CLI release. */
function handActions(): Row[] {
  const T = (hhmm: string): string => `2026-10-11T${hhmm}:00.000Z`;
  return [
    { ts: T("12:05"), step: "fleet.pause", scope: "instance", instance: "core", reason: "codex supervisor pausing for 3 tasks", actor: "operator_ai", run_id: "FLEET-1" },
    { ts: T("12:29"), step: "fleet.resume", scope: "instance", instance: "core", actor: "operator_human", run_id: "FLEET-2" },
    { ts: T("13:00"), step: "fleet.pause", scope: "instance", instance: "core", reason: "recycle for deploy", actor: "daemon", run_id: "FLEET-5" },
    { ts: T("13:10"), step: "fleet.resume", scope: "instance", instance: "core", actor: "operator_human", run_id: "FLEET-6" },
    { ts: T("14:00"), step: "cli.invoked", verb: "release", actor: "operator_human", run_id: "C1" },
    { ts: T("15:00"), step: "dispatch.circuit_broken", task: "W1-T7001", task_id: "W1-T7001", actor: "daemon", run_id: "R-1" },
    { ts: T("15:30"), step: "dispatch.circuit_broken.verified", task_id: "W1-T7001", disposition: "requeue", actor: "daemon", run_id: "R-2" },
    { ts: T("16:07"), step: "dispatch.breaker_released", task_id: "W1-T7001", task: "W1-T7001", reason: "hand", actor: "operator_ai", run_id: "RELEASE-1" },
  ];
}

const incident = (ms: number, fingerprint: string, step = "incident.event"): Row =>
  ({ ts: iso(ms), task_id: "INCIDENT", step, fingerprint, kind: "exception", name: "TypeError", message: "boom" });
const noise = (ms: number, i: number): Row => ({ ts: iso(ms), run_id: "DAEMON-1", task_id: "W1-T1", step: "noise.row", i });
const OLD_INCIDENT = "0".repeat(64);
const LIVE_INCIDENT = "1".repeat(64);

function corpusRows(): Row[] {
  const rows = [
    // Before every detector's window: a pass must not count these.
    start(at("2026-09-20T00:00:00Z"), "ANCIENT-1"),
    { ts: "2026-09-20T01:00:00.000Z", step: "fleet.pause", scope: "instance", instance: "core", reason: "ancient hold", actor: "operator_ai", run_id: "FLEET-0" },
    ...strandedBaseline(at("2026-10-05T00:00:00Z")),
    ...strandedTask(),
    ...pauseRows(),
    ...handActions(),
    incident(at("2026-10-09T06:00:00Z"), OLD_INCIDENT),
    incident(at("2026-10-11T18:30:00Z"), LIVE_INCIDENT),
    incident(at("2026-10-11T18:40:00Z"), LIVE_INCIDENT, "incident.sampled"),
    { ts: "2026-10-11T18:41:00.000Z", task_id: "INCIDENT", step: "sre.runbook", id: "resume-idle-lane", fingerprint: LIVE_INCIDENT, mode: "shadow", outcome: "would_act" },
    { ts: "2026-10-11T18:42:00.000Z", task_id: "INCIDENT", step: "sre.governor", runbook: "resume-idle-lane", from: "none", to: "shadow", reason: "new" },
    ...Array.from({ length: 300 }, (_, i) => noise(at("2026-10-04T00:00:00Z") + i * 37 * MIN, i)),
  ];
  return rows.sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
}

interface Fixture {
  /** The daemon's state root: `state/` holds the ledger, and the landing queue sits beside it. */
  home: string;
  stateDir: string;
  ledgerPath: string;
  /** The checkout the lane files into. */
  root: string;
}

const ROTATION_STAMPS = ["2026-10-01T00:00:00.000Z", "2026-10-09T12:00:00.000Z", "2026-10-11T10:00:00.000Z"];

function archives(stateDir: string): string[] {
  return ledgerRotationEntries(readdirSync(stateDir), stateDir).map((entry) => entry.path);
}

function pinMtimes(stateDir: string): void {
  for (const path of archives(stateDir)) utimesSync(path, MTIME_S, MTIME_S);
}

/** A state dir of three rotations (one plain, two gzip) and a live file, and the idle detector's learned history. */
function fixture(kind: string, rows: Row[] = corpusRows()): Fixture {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13367-${kind}-`));
  const stateDir = join(home, "state");
  const root = join(home, "checkout");
  mkdirSync(root, { recursive: true });
  const before = (stamp: string | undefined, after: string | undefined): Row[] =>
    rows.filter((row) => (after === undefined || String(row.ts) >= after) && (stamp === undefined || String(row.ts) < stamp));
  writeLedger(before(undefined, ROTATION_STAMPS[2]), {
    dir: stateDir,
    rotations: ROTATION_STAMPS.map((stamp, i) => ({ at: stamp, rows: before(stamp, ROTATION_STAMPS[i - 1]), gz: i > 0 })),
  });
  pinMtimes(stateDir);
  writeFileSync(join(stateDir, "fleet-flow-detectors.json"), JSON.stringify({
    detectors: { "idle-capacity": { history: [1, 2, 3, 2, 4, 3].map((measured, i) => ({ population: ALL_CAUSE_IDLE_POPULATION, measured, ts: NOW - 86_400_000 + i })), emitted: [] } },
  }));
  return { home, stateDir, ledgerPath: join(stateDir, LEDGER_FILENAME), root };
}

function copyOf(source: Fixture, kind: string): Fixture {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13367-${kind}-`));
  cpSync(source.home, home, { recursive: true });
  const stateDir = join(home, "state");
  pinMtimes(stateDir);
  return { home, stateDir, ledgerPath: join(stateDir, LEDGER_FILENAME), root: join(home, "checkout") };
}

/** The detectors the daemon registers, for instance `core`, with a pause policy the test owns. */
const DETECTORS: readonly FleetFlowDetector[] = [
  idleCapacityDetector("core"),
  strandedTaskDetector(),
  foreignPauseDetector("core", { policy: parsePausePolicy({ core: { automationSetters: ["daemon", "host-recycle"], origin: "test" } }) }),
];

type FlowHistory = NonNullable<SreLaneInput["flowHistory"]>;

/** The daemon's reader: one for a daemon's lifetime (src/cli/commands/daemon.ts). */
const daemonReader = (): ReturnType<typeof createEscalationTriageHistoryReader> => createEscalationTriageHistoryReader({ slice: SRE_LANE_FLOW_SLICE });

/** The lane's input as the daemon builds it. `flowHistory` absent is the lane at origin/main: each detector's own reader. */
async function laneInput(fx: Fixture, nowMs: number, flowHistory?: FlowHistory, extra: Partial<SreLaneInput> = {}): Promise<SreLaneInput> {
  const input = await daemonSreLaneInput({
    stateDir: fx.stateDir, root: fx.root, ledgerPath: fx.ledgerPath, owner: "o", repo: "r", mergedLastDay: () => 10, log: () => {},
    ...(flowHistory ? { flowHistory } : {}),
  });
  return { ...input, clock: fixedClock(nowMs), mergedPrsSince: () => [], ...extra };
}

/** The name a test gives the live file when it rotates it away. */
const TEST_ROTATION = "ledger.2026-10-11T19-06-00-000Z.ndjson";

/** Every row a pass can have written: the live file's, and those of the file a test rotated away. */
function liveRows(stateDir: string): Row[] {
  const rows: Row[] = [];
  for (const path of [join(stateDir, TEST_ROTATION), join(stateDir, LEDGER_FILENAME)]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) rows.push(JSON.parse(line) as Row);
  }
  return rows;
}

/** What a pass leaves behind: the rows it wrote, each detector's memory file, and the filings it staged. */
function laneOutput(fx: Fixture): { written: Row[]; memory: Record<string, string>; queued: string[] } {
  const memory: Record<string, string> = {};
  for (const name of readdirSync(fx.stateDir).filter((n) => n.endsWith(".json")).sort()) memory[name] = readFileSync(join(fx.stateDir, name), "utf8");
  return {
    written: liveRows(fx.stateDir).filter((row) => row.step === "operator.intervention" ||
      (row.step === "incident.event" && (row.kind === "flow" || row.kind === "intervention"))),
    memory,
    queued: queuedFeedbackLandings(fx.home),
  };
}

// ── what a pass reads, observed process-wide ────────────────────────────────────────────────────

interface LedgerReads {
  /** Whole synchronous reads (readFileSync) of a ledger file, live or rotated. */
  whole: string[];
  /** Positioned synchronous reads of a ledger file: where each started and how many bytes it returned. */
  ranges: Array<{ file: string; position: number; bytes: number }>;
  /** Streams and promise reads of a ledger file: the off-loop load. */
  offLoop: string[];
  /** Synchronous gunzip calls, whatever their input. */
  gunzips: number;
  /** JSON.parse calls whose text is one ledger row. */
  parsedRows: number;
}

/** Records every read of a ledger file under `stateDir`, every synchronous gunzip and every parsed ledger row. */
async function watchLedgerReads<T>(stateDir: string, body: () => Promise<T>): Promise<{ value: T; reads: LedgerReads }> {
  const reads: LedgerReads = { whole: [], ranges: [], offLoop: [], gunzips: 0, parsedRows: 0 };
  const ledgerFile = (path: unknown): path is string =>
    typeof path === "string" && path.startsWith(stateDir) && LEDGER_FILE.test(basename(path)) && path === join(stateDir, basename(path));
  const open = new Map<number, string>();
  const original = {
    readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync,
    createReadStream: fs.createReadStream, readFile: fs.promises.readFile, gunzipSync: zlib.gunzipSync, parse: JSON.parse,
  };
  const call = (fn: unknown, args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown)(...args);
  fs.readFileSync = ((...args: unknown[]) => {
    if (ledgerFile(args[0])) reads.whole.push(basename(args[0]));
    return call(original.readFileSync, args);
  }) as typeof fs.readFileSync;
  fs.openSync = ((...args: unknown[]) => {
    const fd = call(original.openSync, args) as number;
    if (ledgerFile(args[0])) open.set(fd, basename(args[0]));
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((...args: unknown[]) => {
    const bytes = call(original.readSync, args) as number;
    const file = open.get(args[0] as number);
    if (file !== undefined) reads.ranges.push({ file, position: Number(args[4] ?? 0), bytes });
    return bytes;
  }) as typeof fs.readSync;
  fs.closeSync = ((...args: unknown[]) => {
    open.delete(args[0] as number);
    return call(original.closeSync, args);
  }) as typeof fs.closeSync;
  fs.createReadStream = ((...args: unknown[]) => {
    if (ledgerFile(args[0])) reads.offLoop.push(basename(args[0]));
    return call(original.createReadStream, args);
  }) as typeof fs.createReadStream;
  fs.promises.readFile = ((...args: unknown[]) => {
    if (ledgerFile(args[0])) reads.offLoop.push(basename(args[0]));
    return call(original.readFile, args);
  }) as typeof fs.promises.readFile;
  zlib.gunzipSync = ((...args: unknown[]) => {
    reads.gunzips += 1;
    return call(original.gunzipSync, args);
  }) as typeof zlib.gunzipSync;
  JSON.parse = ((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith('{"ts":"')) reads.parsedRows += 1;
    return call(original.parse, args);
  }) as typeof JSON.parse;
  syncBuiltinESMExports();
  try {
    return { value: await body(), reads };
  } finally {
    fs.readFileSync = original.readFileSync;
    fs.openSync = original.openSync;
    fs.readSync = original.readSync;
    fs.closeSync = original.closeSync;
    fs.createReadStream = original.createReadStream;
    fs.promises.readFile = original.readFile;
    zlib.gunzipSync = original.gunzipSync;
    JSON.parse = original.parse;
    syncBuiltinESMExports();
  }
}

/** One daemon pass over the lane's ledger readers: the lane's own pass, then the runbook receipts, the governor
 *  incidents and the governor enforcer's read, which the runbook pass and the core governor step make. */
async function daemonPass(fx: Fixture, input: SreLaneInput): Promise<void> {
  await runSreLanePass(input);
  readRunbookReceipts(fx.ledgerPath);
  readGovernorIncidents(fx.ledgerPath);
  daemonSreGovernorEnforcer({ ledgerPath: fx.ledgerPath, laneOffPath: join(fx.stateDir, "SRE_LANE_OFF") }).readLedger();
}

/** The live tail's guard against a rewrite in place (W1-T11210): after an append it reads this many bytes before
 *  its offset, in the same read as the new bytes (src/lib/live-ledger-tail.ts ANCHOR_BYTES). */
const TAIL_GUARD_BYTES = 64;

test("W1-T13367 criterion 1: invariant:a-pass-reads-only-new-ledger-bytes — a pass over an unchanged state dir parses no ledger row, and after an append a pass reads only the new bytes and the 64-byte anchor before them", async () => {
  const fx = fixture("bytes");
  const reader = daemonReader();
  const pass = async (minute: number) => watchLedgerReads(fx.stateDir, async () => daemonPass(fx, await laneInput(fx, NOW + minute * MIN, reader)));

  // The first pass loads the rotations off the loop. The second reads what the first one wrote.
  const first = await pass(0);
  assert.deepEqual([...new Set(first.reads.offLoop)].sort(), archives(fx.stateDir).map((p) => basename(p)).sort(), "positive control: the first pass loads each rotation, off the loop");
  assert.ok(first.reads.parsedRows > 0, "positive control: the watcher counts parsed ledger rows");
  assert.ok(liveRows(fx.stateDir).some((row) => row.step === "operator.intervention"), "positive control: the first pass wrote rows");
  await pass(1);

  // Unchanged: nothing was written since the second pass.
  const liveSize = statSync(fx.ledgerPath).size;
  const unchanged = await pass(2);
  assert.equal(statSync(fx.ledgerPath).size, liveSize, "fixture: the third pass writes nothing either");
  assert.deepEqual(reader.lastPass(), { readBytes: 0, parsedLines: 0, seededRotations: 0 }, "the slice reader's own counters: no byte read, no line parsed");
  assert.equal(unchanged.reads.parsedRows, 0, "no ledger row is parsed on the daemon thread");
  assert.deepEqual(unchanged.reads.whole, [], "no ledger file is read whole: no readLedgerLines, no union read of a rotation");
  assert.deepEqual(unchanged.reads.offLoop, [], "no rotation is loaded again");
  assert.equal(unchanged.reads.gunzips, 0, "no rotation is decompressed");
  // The live tail sees the same dev, ino, size, mtime and ctime as its last read: it reads no byte at all.
  assert.deepEqual(unchanged.reads.ranges, [], "no byte of any ledger file is read");

  // k rows appended: the next pass reads from the old end of the file, and parses only those rows.
  const appended = [
    incident(NOW + 2 * MIN + 1000, LIVE_INCIDENT),
    noise(NOW + 2 * MIN + 2000, 9001),
    { ts: iso(NOW + 2 * MIN + 3000), step: "cli.invoked", verb: "status", actor: "operator_human", run_id: "C9" },
  ];
  appendFileSync(fx.ledgerPath, appended.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const after = await pass(3);
  assert.deepEqual(after.reads.whole, [], "no ledger file is read whole");
  assert.deepEqual(after.reads.offLoop, []);
  assert.equal(after.reads.gunzips, 0);
  // Each live tail reads once: the new bytes and the 64-byte anchor immediately before them, and never the file's start.
  const newBytes = statSync(fx.ledgerPath).size - liveSize;
  assert.ok(after.reads.ranges.length > 0, "positive control: the pass reads the appended rows");
  assert.deepEqual(after.reads.ranges.filter((r) => !(r.file === LEDGER_FILENAME && r.position === liveSize - TAIL_GUARD_BYTES &&
    r.bytes === newBytes + TAIL_GUARD_BYTES)), [], `each read is the 64-byte anchor and the ${newBytes} new bytes: ${JSON.stringify(after.reads.ranges)}`);
  // The tail parses each new row once; the slice reader parses only the rows that name one of its steps.
  assert.ok(after.reads.parsedRows >= appended.length && after.reads.parsedRows <= 2 * appended.length, `parsed ${after.reads.parsedRows} rows for ${appended.length} appended`);
});

test("W1-T13367 criterion 2: invariant:the-lane-sees-the-same-rows — the detectors and the router write the same rows and leave the same memory as the readers at origin/main, on a first pass, a repeat pass and a pass after a rotation", async () => {
  const sliced = fixture("same-sliced");
  const own = copyOf(sliced, "same-own");
  const reader = daemonReader();
  let sliceReads = 0;
  const counted: FlowHistory = (stateDir) => { sliceReads += 1; return reader(stateDir); };
  const both = async (minute: number): Promise<ReturnType<typeof laneOutput>> => {
    const nowMs = NOW + minute * MIN;
    await runSreLanePass(await laneInput(own, nowMs, undefined, { detectors: DETECTORS }));
    await runSreLanePass(await laneInput(sliced, nowMs, counted, { detectors: DETECTORS }));
    const want = laneOutput(own);
    assert.deepEqual(laneOutput(sliced), want, `minute ${minute}: the sliced lane leaves what the lane at origin/main leaves`);
    return want;
  };

  const first = await both(0);
  // Positive controls: each detector and the router wrote, so an empty answer on both sides cannot pass.
  const names = first.written.map((row) => String(row.name ?? row.step));
  for (const name of ["idle-capacity:", "stranded-task", "foreign-pause"]) assert.ok(names.some((n) => n.startsWith(name)), `${name} wrote an incident: ${names.join(", ")}`);
  assert.ok(first.written.some((row) => row.step === "operator.intervention"), "the router wrote an intervention row");
  assert.ok(first.written.some((row) => row.kind === "intervention"), "the router routed an intervention incident");
  assert.ok(Object.keys(first.memory).length >= 4, `each memory file is compared: ${Object.keys(first.memory).join(", ")}`);
  assert.ok(reader.lastLoad().rotations > 0, "the sliced lane read through the daemon's reader");
  assert.equal(sliceReads, 1, "one pass reads the slice once for its three detectors and the router");

  // Two minutes on, every finding is inside its detector's own quiet window.
  const repeat = await both(2);
  assert.deepEqual(repeat.written, first.written, "a repeat pass writes nothing twice");

  // A rotation: the live file is renamed to an archive and a new one starts, with a new hand action in it.
  for (const fx of [own, sliced]) {
    renameSync(fx.ledgerPath, join(fx.stateDir, TEST_ROTATION));
    writeFileSync(fx.ledgerPath, [
      { ts: iso(NOW + 7 * MIN), step: "fleet.resume", scope: "instance", instance: "core", actor: "operator_human", run_id: "FLEET-10" },
      idle(NOW + 7 * MIN, { cause: null, idle_slots: 0, dispatchable: 0, hold: null }),
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  const rotated = await both(10);
  assert.ok(rotated.written.length > repeat.written.length, "the pass after the rotation wrote the new hand action's rows");

  // A detector whose input the slice does not name keeps its own reader: the slice is not asked, and it still gets its rows.
  const seen: number[] = [];
  const unsliced: FleetFlowDetector = {
    id: "noise-flow", inputs: ["noise.row"], policy: { minSamples: 5, maxSamples: 20, longMs: 30 * 24 * 60 * MIN },
    evaluate: (rows) => { seen.push(rows.length); return []; },
  };
  sliceReads = 0;
  await runSreLanePass(await laneInput(sliced, NOW + 11 * MIN, counted, { detectors: [unsliced] }));
  assert.equal(sliceReads, 0, "the slice reader is not asked for a step it does not hold");
  assert.ok(Math.max(...seen) > 0, "the detector read its rows through its own reader");
});

test("W1-T13367 criterion 3: invariant:an-unreadable-history-stops-the-pass — each detector rejects with its own text, and the pass writes nothing, files nothing and leaves every memory file", async (t) => {
  t.mock.method(console, "error", () => {});
  const sliced = fixture("broken-sliced");
  // One rotation inside every detector's window cannot be read: same size, same mtime, not gzip.
  const broken = archives(sliced.stateDir).find((path) => path.endsWith("2026-10-11T10-00-00-000Z.ndjson.gz"))!;
  writeFileSync(broken, Buffer.alloc(statSync(broken).size, 0x21));
  utimesSync(broken, MTIME_S, MTIME_S);
  const own = copyOf(sliced, "broken-own");
  const before = laneOutput(sliced);

  const fleetFlow: FleetFlowDetector = { id: "plain-flow", inputs: ["lane.idle_summary"], policy: { minSamples: 5, maxSamples: 20, longMs: 7 * 24 * 60 * MIN }, evaluate: () => [] };
  const cases: Array<[string, readonly FleetFlowDetector[]]> = [
    ["Fleet-flow ledger unreadable", [fleetFlow]],
    ["Idle-capacity ledger unreadable", DETECTORS],
    ["Stranded-task ledger unreadable", [DETECTORS[1]!]],
    ["Foreign-pause ledger unreadable", [DETECTORS[2]!]],
    ["Operator-intervention ledger unreadable", []],
  ];
  for (const [text, detectors] of cases) {
    const rejection = async (fx: Fixture, flowHistory?: FlowHistory): Promise<string> => {
      const error = await runSreLanePass(await laneInput(fx, NOW, flowHistory, { detectors })).then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof Error, `${text}: the pass rejects`);
      return error.message.replaceAll(fx.stateDir, "<state>");
    };
    const today = await rejection(own);
    assert.equal(today, `${text}: <state>/${basename(broken)}`, "fixture: the lane at origin/main rejects with this text");
    assert.equal(await rejection(sliced, daemonReader()), today, `${text}: the sliced lane rejects with the same text`);
  }
  assert.deepEqual(laneOutput(sliced), before, "no incident.event or operator.intervention row, no filing, and every memory file unchanged");
  assert.deepEqual(queuedFeedbackLandings(sliced.home), [], "nothing is filed");
});

test("W1-T13367 criterion 4: the lane's incident events, the runbook receipts and the governor incidents come from the live file's tail: the same rows as a whole read after each append, a rotation and a torn last line", async (t) => {
  t.mock.method(console, "error", () => {});
  const fx = fixture("tail");
  const input = await laneInput(fx, NOW, daemonReader());
  const enforcer = daemonSreGovernorEnforcer({ ledgerPath: fx.ledgerPath, laneOffPath: join(fx.stateDir, "SRE_LANE_OFF") });
  /** Each consumer's answer, and the same reduction over a whole read of the live file. */
  const assertSameAsWholeRead = (label: string): void => {
    const whole = readLedgerLines(fx.ledgerPath); // ledger-read-intent: live — the reference the tail must equal.
    const wholeEvents = whole.filter((row) => row.task_id === "INCIDENT" && (row.step === "incident.event" || row.step === "incident.sampled"));
    assert.deepEqual(input.readEvents().map((e) => [e.fingerprint, e.ts]), wholeEvents.map((row) => [row.fingerprint, Date.parse(String(row.ts))]), `${label}: the lane's incident events`);
    assert.deepEqual(readRunbookReceipts(fx.ledgerPath).map((r) => [r.id, r.ts_ms]), whole.filter((row) => row.step === "sre.runbook").map((row) => [row.id, Date.parse(String(row.ts))]), `${label}: the runbook receipts`);
    assert.deepEqual(readGovernorIncidents(fx.ledgerPath).map((e) => [e.fingerprint, e.ts]), wholeEvents.map((row) => [row.fingerprint, Date.parse(String(row.ts))]), `${label}: the governor incidents`);
    assert.deepEqual(enforcer.readLedger(), [...whole], `${label}: the governor enforcer's rows`);
  };

  assertSameAsWholeRead("first read");
  assert.equal(input.readEvents().length, 2, "positive control: the live file holds two incident rows");
  assert.ok(!input.readEvents().some((e) => e.fingerprint === OLD_INCIDENT), "the incident row in an old rotation is not read: the live file only, never the union");
  assert.equal(readRunbookReceipts(fx.ledgerPath).length, 1, "positive control: one receipt");

  for (let i = 0; i < 3; i++) {
    appendFileSync(fx.ledgerPath, [incident(NOW + i * 1000, LIVE_INCIDENT), noise(NOW + i * 1000, i),
      { ts: iso(NOW + i * 1000), task_id: "INCIDENT", step: "sre.runbook", id: "resume-idle-lane", fingerprint: LIVE_INCIDENT, mode: "shadow", outcome: "would_act" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    assertSameAsWholeRead(`append ${i}`);
  }
  assert.equal(input.readEvents().length, 5);

  // A last line still being written is not a row until its newline arrives.
  const torn = JSON.stringify(incident(NOW + 60_000, LIVE_INCIDENT));
  appendFileSync(fx.ledgerPath, torn.slice(0, 40));
  assert.equal(input.readEvents().length, 5, "the torn last line is not returned");
  appendFileSync(fx.ledgerPath, torn.slice(40) + "\n");
  assertSameAsWholeRead("the torn line's newline arrived");
  assert.equal(input.readEvents().length, 6);

  // Rotated away and replaced: the tail starts again at the first byte and returns exactly the new file's rows.
  renameSync(fx.ledgerPath, join(fx.stateDir, TEST_ROTATION));
  writeFileSync(fx.ledgerPath, JSON.stringify(incident(NOW + 120_000, "2".repeat(64))) + "\n");
  assertSameAsWholeRead("after the rotation");
  assert.deepEqual(input.readEvents().map((e) => e.fingerprint), ["2".repeat(64)]);
});

test("W1-T13367 criterion 5: the first pass loads its rotations off the loop while a 20 ms timer keeps firing, and a second process answers them from their durable digests", async () => {
  const fx = fixture("load");
  // The load of one rotation is held for one second; `holding` is true only inside that second.
  let holding = false;
  let held = 0;
  const reader = createEscalationTriageHistoryReader({
    slice: SRE_LANE_FLOW_SLICE,
    readFile: async (path) => {
      if (held++ === 0) {
        holding = true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        holding = false;
      }
      return fs.promises.readFile(path);
    },
  });
  let ticksWhileHeld = 0;
  const timer = setInterval(() => { if (holding) ticksWhileHeld += 1; }, 20);
  try {
    await runSreLanePass(await laneInput(fx, NOW, reader, { detectors: DETECTORS }));
  } finally {
    clearInterval(timer);
  }
  const first = laneOutput(fx);
  assert.equal(held, archives(fx.stateDir).length, "positive control: each rotation was loaded through the held read");
  assert.ok(ticksWhileHeld >= 2, `the 20 ms timer fired ${ticksWhileHeld} times while the rotation load was held`);
  assert.ok(first.written.length > 0, "the pass still wrote its rows");

  // A second process: a state dir no reader of this process has loaded, holding the digests the first one left,
  // and rotations replaced by bytes that cannot be decompressed (same size, same mtime).
  const restarted = fixture("load-restarted");
  cpSync(join(fx.stateDir, "cache"), join(restarted.stateDir, "cache"), { recursive: true });
  for (const path of archives(restarted.stateDir)) writeFileSync(path, Buffer.alloc(statSync(path).size, 0x21));
  pinMtimes(restarted.stateDir);
  const second = daemonReader();
  const watched = await watchLedgerReads(restarted.stateDir, async () => runSreLanePass(await laneInput(restarted, NOW, second, { detectors: DETECTORS })));
  assert.equal(second.lastLoad().digestHits, archives(restarted.stateDir).length, "every rotation came from its digest");
  assert.equal(second.lastLoad().digestMisses, 0, "no rotation was decompressed");
  assert.equal(watched.reads.gunzips, 0, "no synchronous gunzip either");
  assert.deepEqual(laneOutput(restarted).written, first.written, "and the pass writes the same rows from the digests");
});
