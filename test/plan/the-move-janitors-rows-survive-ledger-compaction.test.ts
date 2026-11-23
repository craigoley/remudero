/**
 * W1-T14448: the move janitor's rows survive ledger compaction and a restart.
 *
 * OBSERVED 2026-11-23: compaction archived every plan.move row within 35 minutes, so the live ledger showed none for
 * 5 h, and the janitor kept the step pull request it opened last in process memory only. Here a real rotation runs
 * over a real ledger file; the janitor's ports are fakes that record the order of their calls.
 */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { ledgerExceedsRotationCeiling, rotateLedger } from "#src/lib/ledger.js";
import { readReleaseLedgerLines } from "#src/lib/operator-release.js";
import {
  createPlanTaskMover, planTaskMovePorts, runPlanTaskMoveTick, PLAN_MOVE_JANITOR_STEP, PLAN_MOVE_STAND_DOWN,
  type MovePin, type MoverPull, type PlanTaskMover, type PlanTaskMovePorts, type PlanTaskMoveSwitch,
} from "#src/lib/plan-task-move-janitor.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

type Json = Record<string, unknown>;
const PUBLIC = "acme/remudero", OPS = "acme/remudero-ops";
const ON: PlanTaskMoveSwitch = { move: { outcome: "on", repository: OPS, checkoutDir: "/ops" }, dispatch: { outcome: "on", repository: OPS, checkoutDir: "/ops" } };
const NOW = new Date("2030-01-02T00:00:00.000Z");
const TS = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
const MOVE_STEP_ROW = "plan.move.step"; // src/lib/plan-task-move.ts MOVE_STEP, the mover's own row

const line = (row: Json) => JSON.stringify(row) + "\n";
const noise = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: TS, run_id: `noise-${i}`, task_id: "DAEMON", step: "ci.polling", i }));

/** Pad the ledger with unretained rows past the ceiling `rotateLedger` is handed, then really rotate it. */
function compact(path: string): { live: Json[]; archived: Json[] } {
  appendFileSync(path, noise(400).map(line).join(""));
  const ceilingBytes = Math.floor(readFileSync(path).length / 2);
  assert.ok(ledgerExceedsRotationCeiling(path, ceilingBytes), "sanity: the ledger is over its ceiling");
  const result = rotateLedger(path, { ceilingBytes, now: () => NOW });
  assert.equal(result.rotated, true, "sanity: the rotation ran");
  assert.ok(result.archivePath);
  const bytes = readFileSync(result.archivePath);
  const archived = (result.archivePath.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8").trim().split("\n").map(row => JSON.parse(row) as Json);
  const live = readReleaseLedgerLines(path).map(row => JSON.parse(row) as Json);
  assert.ok(live.filter(row => row.step === "ci.polling").length < 50, "sanity: the rotation archived the noise");
  return { live, archived };
}

interface Fake { mover: PlanTaskMover; calls: string[]; set(over: { pull?: MoverPull; dry?: Json; apply?: Json }): void }
/** The janitor over fake ports; `calls` names every pull read and mover run in order. Each heads read is a new pin,
 *  so a dry-run answer is never kept between ticks. */
function fakeMover(readLedgerLines?: PlanTaskMovePorts["readLedgerLines"]): Fake {
  const calls: string[] = [];
  let pull: MoverPull = { state: "OPEN" }, dry: Json = { step: "none" }, apply: Json = { step: "copy", applied: false };
  let heads = 0;
  const ports: PlanTaskMovePorts = {
    readSwitch: () => ON, readOpsCatalog: () => "ok",
    readHeads: async ops => ({ ops, publicRepository: PUBLIC, publicCommit: "a".repeat(40), opsCommit: "b".repeat(40), key: `pin-${++heads}` } satisfies MovePin),
    move: async (_pin, applying) => { calls.push(applying ? "apply" : "dry"); return { status: 0, out: applying ? apply : dry }; },
    readPull: async (_pin, side, number) => { calls.push(`readPull ${side} #${number}`); return pull; },
    onMain: async () => true,
    ...(readLedgerLines ? { readLedgerLines } : {}),
  };
  return { mover: createPlanTaskMover(ports), calls, set: over => { pull = over.pull ?? pull; dry = over.dry ?? dry; apply = over.apply ?? apply; } };
}
/** One tick whose rows are appended to `path` the way the daemon's own log writes them, and to `rows`. */
const tickInto = (fake: Fake, rows: Json[], path?: string) => runPlanTaskMoveTick({ opsDispatchHold: undefined, log: (step, data) => {
  const row = { ts: TS, run_id: "daemon", task_id: "DAEMON", step, ...data };
  rows.push(row);
  if (path) appendFileSync(path, line(row));
} }, fake.mover);
const standDowns = (rows: Json[]) => rows.filter(row => row.step === PLAN_MOVE_STAND_DOWN);

test("W1-T14448 criterion 1: ledger compaction keeps plan.move.janitor_step, plan.move.stand_down and plan.move.step rows in the live ledger", t => {
  const kept = [
    { ts: TS, run_id: "daemon", task_id: "DAEMON", step: PLAN_MOVE_STAND_DOWN, reason: "preview_unknown", detail: "ownership_changed" },
    { ts: TS, run_id: "run-move-1", task_id: "W1-T1", step: MOVE_STEP_ROW, move_step: "copy", outcome: "ref_moved" },
    { ts: TS, run_id: "daemon", task_id: "DAEMON", step: PLAN_MOVE_JANITOR_STEP, move_step: "copy", applied: false, side: null, pull_request: null, exit: 1 },
    { ts: TS, run_id: "daemon", task_id: "DAEMON", step: PLAN_MOVE_STAND_DOWN, reason: "step_not_applied", detail: "ref_moved", previous_ticks: 2 },
  ];
  const telemetry = { ts: TS, run_id: "telemetry", task_id: "DAEMON", step: "ci.polling" };
  const { path } = writeLedger([...kept, telemetry], { scope: t });
  const { live, archived } = compact(path);
  assert.deepEqual(live.filter(row => String(row.step).startsWith("plan.move.")), kept, "every plan.move row is still live, in order, whole");
  assert.ok(!live.some(row => row.run_id === "telemetry"), "a row of the same age that no reader reads is archived");
  assert.deepEqual(archived.find(row => row.run_id === "telemetry"), telemetry);
});

test("W1-T14448 criterion 2: a janitor created in a new process resumes the wait on the step pull request the last process opened, by a direct pull read before any dry run", async t => {
  const { path } = writeLedger([], { scope: t });
  // The process that opens the step: its janitor_step row goes to the ledger, and its next tick waits on the pull.
  const first = fakeMover(() => readReleaseLedgerLines(path));
  assert.equal(first.mover.memory.lastStep, undefined, "an empty ledger seeds nothing");
  first.set({ dry: { step: "copy" }, apply: { step: "copy", applied: true, repository: OPS, pullRequest: 42, id: "W1-T1" } });
  const rows: Json[] = [];
  assert.deepEqual(await tickInto(first, rows, path), { outcome: "step", step: "copy" });
  first.calls.length = 0;
  const waited = await tickInto(first, rows);
  assert.deepEqual(waited, { outcome: "stand_down", reason: "mover_pull_request_open" });
  assert.deepEqual(first.calls, ["readPull ops #42"], "the opening process waits on its pull and runs no dry run");

  // A restart after compaction: the new process reads the same wait from the retained row.
  compact(path);
  const restarted = fakeMover(() => readReleaseLedgerLines(path));
  assert.deepEqual(restarted.mover.memory.lastStep, { side: "ops", number: 42 });
  assert.deepEqual(await tickInto(restarted, []), waited, "exactly as the process that opened it");
  assert.deepEqual(restarted.calls, ["readPull ops #42"], "a direct pull read, before any dry run");
  restarted.set({ pull: { state: "MERGED", mergeCommit: "c".repeat(40) } });
  restarted.calls.length = 0;
  assert.deepEqual(await tickInto(restarted, []), { outcome: "stand_down", reason: "nothing_to_move" });
  assert.deepEqual(restarted.calls, ["readPull ops #42", "dry"], "once that step lands, the next tick reads the mover");
  assert.equal(restarted.mover.memory.lastStep, undefined);

  // Only the newest janitor_step row decides, and only when it names an applied step with its side and pull request.
  const janitorRow = (data: Json) => JSON.stringify({ ts: TS, run_id: "daemon", task_id: "DAEMON", step: PLAN_MOVE_JANITOR_STEP, move_step: "copy", exit: 0, ...data });
  const applied = janitorRow({ applied: true, side: "public", pull_request: 7 });
  const seed = (lines: string[]) => fakeMover(() => lines).mover.memory.lastStep;
  assert.deepEqual(seed([applied, JSON.stringify({ step: PLAN_MOVE_STAND_DOWN, reason: "mover_pull_request_open" })]), { side: "public", number: 7 });
  assert.equal(seed([applied, janitorRow({ applied: false, side: null, pull_request: null })]), undefined,
    "a newest row whose apply opened nothing means the last opened step was already resolved");
  assert.equal(seed([applied, `{"ts":"${TS}","step":"${PLAN_MOVE_JANITOR_STEP}","applied":tr`]), undefined, "an unreadable newest row seeds nothing");
  assert.equal(seed([janitorRow({ applied: true, side: "sideways", pull_request: 7 })]), undefined, "a row naming no side seeds nothing");
  assert.equal(seed([janitorRow({ applied: true, side: "ops", pull_request: "7" })]), undefined, "a row naming no pull request seeds nothing");
  assert.deepEqual(seed([applied, JSON.stringify(["a", PLAN_MOVE_JANITOR_STEP])]), { side: "public", number: 7 },
    "a row that merely mentions the step is not a janitor_step row");
  assert.equal(fakeMover(() => { throw new Error("EACCES"); }).mover.memory.lastStep, undefined, "an unreadable ledger seeds nothing, and creation never throws");
  assert.equal(fakeMover().mover.memory.lastStep, undefined, "no ledger reader, no seed");

  // The host's ports carry the daemon's ledger reader to the mover it creates.
  const reader = () => [applied];
  const host = planTaskMovePorts({ publicRoot: "/public", publicRepository: PUBLIC, readSwitch: () => ON, readOpsCatalog: () => "ok", cliEntry: "unused", readLedgerLines: reader });
  assert.equal(host.readLedgerLines, reader);
  assert.deepEqual(createPlanTaskMover(host).memory.lastStep, { side: "public", number: 7 });
});

test("W1-T14448 criterion 3: a stand_down row written on a change of reason carries previous_ticks, the ticks the replaced reason held; the first of a process carries none", async () => {
  const fake = fakeMover();
  const rows: Json[] = [];
  for (let i = 0; i < 3; i++) await tickInto(fake, rows);
  fake.set({ dry: { step: "held", reason: "ops_copy_differs" } });
  for (let i = 0; i < 2; i++) await tickInto(fake, rows);
  fake.set({ dry: { step: "none" } });
  await tickInto(fake, rows);
  const written = standDowns(rows);
  assert.deepEqual(written.map(row => [row.reason, row.detail ?? null, row.previous_ticks ?? null]), [
    ["nothing_to_move", null, null], ["move_held", "ops_copy_differs", 3], ["nothing_to_move", null, 2]]);
  assert.ok(!("previous_ticks" in written[0]!), "the first stand-down of a process carries no previous_ticks");
  // A step clears the held reason: the stand-down after it replaces none, so it carries none.
  fake.set({ dry: { step: "copy" }, apply: { step: "copy", applied: false, outcome: "ref_moved" } });
  await tickInto(fake, rows);
  const afterStep = standDowns(rows).at(-1)!;
  assert.deepEqual([afterStep.reason, afterStep.detail], ["step_not_applied", "ref_moved"]);
  assert.ok(!("previous_ticks" in afterStep), "no reason was held when the step ran");
});

test("W1-T14448 criterion 4: invariant:one-row-per-change-of-reason — a tick that repeats the current reason still writes no row", async () => {
  const fake = fakeMover();
  const rows: Json[] = [];
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(await tickInto(fake, rows), { outcome: "stand_down", reason: "nothing_to_move" });
  }
  assert.equal(standDowns(rows).length, 1, "ten ticks of one reason write one row");
  fake.set({ dry: { step: "held", reason: "a" } });
  await tickInto(fake, rows);
  fake.set({ dry: { step: "held", reason: "b" } });
  await tickInto(fake, rows);
  await tickInto(fake, rows);
  assert.deepEqual(standDowns(rows).map(row => [row.reason, row.detail ?? null]),
    [["nothing_to_move", null], ["move_held", "a"], ["move_held", "b"]], "a changed detail is a change of reason; a repeat is not");
  assert.equal(rows.length, 3, "no other row was written");
});
