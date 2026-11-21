import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { listFeedback } from "#src/lib/feedback.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import {
  deriveControlInterventions, interventionIncidentEvent, interventionKey, interventionLedgerLine, OPERATOR_INTERVENTION_STEP,
  type OperatorInterventionRow,
} from "#src/lib/operator-interventions.js";
import {
  aggregateIncidents, incidentEventFromLedgerRow, incidentFeedbackId, routeOperatorInterventions, runSreLanePass, sreLaneRoom, sreLaneStorePath,
  type IncidentLedgerEvent, type SreLaneInput,
} from "#src/lib/sre-lane.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The lane's read window (INTERVENTION_WINDOW_MS in src/lib/sre-lane.ts). */
const WINDOW = 7 * DAY;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const iso = (ms: number) => fixedClock(ms).iso();
const CAUSE = "own-red:fix-lane:required-checks-red-ci-log-fix-fix-round";

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}intervention-once-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"), { recursive: true });
  return dir;
}

/** A PR-surface hand push, as the fix-lane gardener records it. */
function pushRow(target: string, atMs: number, file = "src/lib/sweep.ts"): OperatorInterventionRow {
  return { at: iso(atMs), surface: "pr", action: "push", target, actor: "craigoley", cause_class: CAUSE, source: "fix-lane-gardener",
    evidence: { commit: "a".repeat(40), files: [file] } };
}

/**
 * One instance's rows in memory: what the union reader returns (a row timed before `sinceMs` is dropped, as
 * the union's own `since` rule drops it), and a writer that stamps each line with the pass's clock, as
 * appendLedger does. `nowMs` is the clock of the pass under way.
 */
function rowsAt() {
  const rows: Record<string, unknown>[] = [];
  let nowMs = NOW;
  return {
    rows,
    at(ms: number) { nowMs = ms; },
    add(row: OperatorInterventionRow, tsMs: number) { rows.push({ ...interventionLedgerLine(row), ts: iso(tsMs) }); },
    read: async (sinceMs: number, _now: number, asker: { inputs: readonly string[] }) =>
      rows.filter((r) => typeof r.ts === "string" && !(Date.parse(r.ts) < sinceMs) && asker.inputs.includes(String(r.step))),
    write: (line: LedgerLine) => { rows.push({ ...line, ts: iso(nowMs) }); },
    incidents: () => rows.filter((r) => r.step === "incident.event"),
    events: () => rows.flatMap((r) => r.step === "incident.event" ? [incidentEventFromLedgerRow(r, "core")!] : []),
  };
}

function memoryPath(root: string): string {
  return join(root, "state", "operator-interventions.json");
}

function memoryText(root: string): string {
  return existsSync(memoryPath(root)) ? readFileSync(memoryPath(root), "utf8") : "";
}

async function route(root: string, book: ReturnType<typeof rowsAt>, nowMs: number): Promise<LedgerLine[]> {
  book.at(nowMs);
  return routeOperatorInterventions({ stateDir: join(root, "state"), nowMs, readRows: book.read, writeEvent: book.write, detectors: [] });
}

/** One whole lane pass over `book`, its incident reader and routing history included, as the daemon runs it. The
 *  history is every incident row in `book` since the instant asked, as the ledger union returns it. */
function lanePass(root: string, book: ReturnType<typeof rowsAt>, nowMs: number, over: Partial<SreLaneInput> = {}) {
  book.at(nowMs);
  return runSreLanePass({
    stateDir: join(root, "state"), root, mergedLastDay: () => 0, clock: fixedClock(nowMs), detectors: [],
    readFlowRows: book.read, writeFlowEvent: book.write, readEvents: book.events, hasOpenTask: () => false,
    readRoutingHistory: async (sinceMs) => book.events().filter((e) => e.ts >= sinceMs),
    framesFor: () => [], mergedPrsSince: () => [], readLandedEntry: () => null, log: () => {}, ...over,
  });
}

/** An intervention's incident.event as origin/main's pass at `atMs` wrote it: no intervention key. */
function legacyEvent(row: OperatorInterventionRow, atMs: number): Record<string, unknown> {
  return { ...interventionIncidentEvent(row, atMs), ts: iso(atMs) };
}

test("W1-T14005 criterion 1: a row written long after its intervention is routed as exactly one incident.event across any number of passes", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  // The fix-lane gardener can record a hand push days after it: this row is read by its ts, and its at is out of the window.
  const late = pushRow("pr#15368@c9c0b40f8", NOW - 13 * DAY);
  book.add(late, NOW - 5 * DAY);
  const ontime = pushRow("pr#16442@4dc3ce296", NOW - HOUR, "src/lib/review.ts");
  book.add(ontime, NOW - HOUR);
  const passes = [NOW, NOW + MIN, NOW + 15 * MIN, NOW + HOUR, NOW + DAY, NOW + 2 * DAY - MIN];
  const routedPerPass: string[][] = [];
  for (const at of passes) routedPerPass.push((await route(root, book, at)).map((e) => String(e.message)));
  const lateMessage = interventionIncidentEvent(late, NOW).message;
  assert.deepEqual(routedPerPass.map((m) => m.filter((x) => x === lateMessage).length), [1, 0, 0, 0, 0, 0],
    "the late row is routed in the first pass that reads it and never again while it is still read");
  assert.equal(book.incidents().filter((r) => r.message === lateMessage).length, 1, "exactly one incident.event for it on the ledger");
  assert.equal(book.incidents().length, 2, "one incident.event per distinct intervention, late or on time");
  // A daemon restart re-reads the same window with the same memory file: still nothing new.
  assert.deepEqual(await route(root, book, NOW + 2 * DAY - MIN), []);
});

test("W1-T14005 criterion 2: the lane's evidence counts distinct interventions, so repeat events never move its count, burn or re-filing", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  const a = pushRow("pr#16240@4dcacfa5e", NOW - 3 * HOUR);
  const b = pushRow("pr#16240@17cfcb412", NOW - 2 * HOUR);
  book.add(a, NOW - 3 * HOUR);
  book.add(b, NOW - 2 * HOUR);
  const fp = String(interventionIncidentEvent(a, NOW).fingerprint);
  let accepted = false;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pass = (nowMs: number) => {
    book.at(nowMs);
    const deps: SreLaneInput = {
      stateDir: join(root, "state"), root, mergedLastDay: () => 10, clock: fixedClock(nowMs), detectors: [],
      readFlowRows: book.read, writeFlowEvent: book.write, readEvents: book.events, hasOpenTask: () => accepted,
      framesFor: () => [], mergedPrsSince: () => [], readLandedEntry: () => null, log: (step, extra) => logs.push({ step, extra }),
    };
    return runSreLanePass(deps);
  };
  assert.equal((await pass(NOW)).filed, fp, "two hand pushes of one class on one file: one incident, filed");
  assert.equal(logs.find((l) => l.step === "sre_lane.filed")!.extra!.count, 2);
  accepted = true;
  const first = aggregateIncidents(book.events()).find((e) => e.fingerprint === fp)!;
  // Each pass loses the routing memory, and each pass both interventions are routed again (as when the incident rows
  // that would show the first routing are no longer read): events repeat, interventions do not.
  const routedOnce = book.incidents().slice();
  for (let i = 1; i <= 6; i++) {
    rmSync(memoryPath(root), { force: true });
    for (const r of routedOnce) book.rows.push({ ...r, ts: iso(NOW + i * 2 * MIN - 1) });
    assert.equal((await pass(NOW + i * 2 * MIN)).filed, undefined, `pass ${i}: no new intervention, nothing filed`);
  }
  assert.ok(book.incidents().length >= 8, "the passes did write repeat events (the condition under test is present)");
  const after = aggregateIncidents(book.events()).find((e) => e.fingerprint === fp)!;
  assert.deepEqual([after.count, after.burnPerHour, after.firstSeenMs, after.lastSeenMs], [first.count, first.burnPerHour, first.firstSeenMs, first.lastSeenMs],
    "count, burn per hour and span move only with new interventions");
  assert.equal(after.count, 2);
  assert.deepEqual(listFeedback(root).map((e) => e.id), [incidentFeedbackId(fp)], "no -n<count> re-filing from repeat events");

  // New interventions of the class do move it: a third is under double, a fourth doubles it and re-files.
  book.add(pushRow("pr#16240@aaaaaaaaa", NOW - HOUR), NOW + 20 * MIN);
  assert.equal((await pass(NOW + 21 * MIN)).filed, undefined);
  assert.equal(aggregateIncidents(book.events()).find((e) => e.fingerprint === fp)!.count, 3);
  book.add(pushRow("pr#16240@bbbbbbbbb", NOW - HOUR + MIN), NOW + 22 * MIN);
  assert.equal((await pass(NOW + 23 * MIN)).filed, fp, "the fourth distinct intervention doubles the filed count");
  assert.deepEqual(listFeedback(root).map((e) => e.id).sort(), [incidentFeedbackId(fp), `${incidentFeedbackId(fp)}-n4`].sort());

  // The rule directly: one key read many times is one; a row with no key counts by itself, as it always did.
  const keyed = (ts: number, key: string): IncidentLedgerEvent => ({ fingerprint: fp, ts, kind: "intervention", name: CAUSE, message: "m", instance: "core", interventionKey: key });
  const plain = (ts: number): IncidentLedgerEvent => ({ fingerprint: "e".repeat(64), ts, kind: "exception", name: "TypeError", message: "m", instance: "core" });
  const [one] = aggregateIncidents([keyed(NOW, "k1"), keyed(NOW + HOUR, "k1"), keyed(NOW + 5 * HOUR, "k1")]);
  assert.deepEqual([one.count, one.firstSeenMs, one.lastSeenMs, one.burnPerHour], [1, NOW, NOW, 1]);
  assert.equal(aggregateIncidents([keyed(NOW, "k1"), keyed(NOW + HOUR, "k2")])[0].count, 2);
  assert.equal(aggregateIncidents([plain(NOW), plain(NOW), plain(NOW + HOUR)])[0].count, 3);
  assert.equal(incidentEventFromLedgerRow({ ...book.incidents()[0] }, "core")!.interventionKey, interventionKey(a), "the routed row carries its key");
});

test("W1-T14005 criterion 3: the routing memory keeps a key while its row can be read and drops it after; a bad memory file still throws", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  const late = pushRow("pr#15368@c9c0b40f8", NOW - 13 * DAY);
  const lateTs = NOW - 5 * DAY;
  book.add(late, lateTs);
  const fresh = pushRow("pr#19000@ccccccccc", NOW - 6 * DAY);
  book.add(fresh, NOW - 6 * DAY);
  await route(root, book, NOW);
  const key = interventionKey(late);
  assert.ok(memoryText(root).includes(JSON.stringify(key)), "kept: the row that carried it is still inside the read window");
  await route(root, book, lateTs + WINDOW - MIN);
  assert.ok(memoryText(root).includes(JSON.stringify(key)), "still kept the minute before its row leaves the window");
  assert.ok(!memoryText(root).includes(JSON.stringify(interventionKey(fresh))), "dropped: that row is no longer read");
  await route(root, book, lateTs + WINDOW + MIN);
  assert.ok(!memoryText(root).includes(JSON.stringify(key)), "dropped once its row can no longer be read");
  assert.equal(book.incidents().length, 2, "and a dropped key is never routed again: its row is not read");
  // Bounded: many interventions, all out of the window, leave nothing behind.
  const lastTs = NOW + 2 * DAY + 19 * MIN;
  for (let i = 0; i < 20; i++) book.add(pushRow(`pr#${17000 + i}@ddddddddd`, NOW - 20 * DAY + i * MIN), lastTs - (19 - i) * MIN);
  assert.equal((await route(root, book, NOW + 3 * DAY)).length, 20);
  assert.equal(JSON.parse(memoryText(root)).routed.length, 20, "each key kept while its row is read");
  assert.deepEqual(await route(root, book, lastTs + WINDOW - MIN), [], "and none routed twice");
  await route(root, book, lastTs + WINDOW + MIN);
  assert.equal(JSON.parse(memoryText(root)).routed.length, 0, "every key's row left the window, so the memory is empty");
  assert.equal(book.incidents().length, 22);

  // An absent memory is an empty one; an unreadable or malformed one throws, as on origin/main.
  const absent = tmp(t);
  assert.equal((await route(absent, book, lastTs + WINDOW + MIN)).length, 0);
  for (const bad of ["{not json", JSON.stringify({ routed: "k" }), JSON.stringify({ routed: [42] })]) {
    const dir = tmp(t);
    writeFileSync(memoryPath(dir), bad);
    await assert.rejects(route(dir, book, NOW), Error, `memory ${bad} must throw`);
  }
  // A memory written before this change (bare keys) still dedupes what it names.
  const legacy = tmp(t);
  const old = rowsAt();
  const recent = pushRow("pr#19100@eeeeeeeee", NOW - HOUR);
  old.add(recent, NOW - HOUR);
  writeFileSync(memoryPath(legacy), JSON.stringify({ routed: [interventionKey(recent)] }) + "\n");
  assert.deepEqual(await route(legacy, old, NOW), [], "a key the old memory holds is not routed again");
  assert.ok(memoryText(legacy).includes(JSON.stringify(interventionKey(recent))));
});

test("W1-T14005 criterion 4: each intervention routes once with origin/main's event, a new one routes at once, and pacing, the open-feedback skip and the runbook step hold", async (t) => {
  // The event: every field origin/main wrote, plus the key it was routed under.
  const root = tmp(t);
  const book = rowsAt();
  const a = pushRow("pr#16213@5c177ab9a", NOW - 2 * HOUR, "src/lib/review.ts");
  book.add(a, NOW - 2 * HOUR);
  const [event] = await route(root, book, NOW);
  const { intervention_key: _key, ...rest } = event as LedgerLine & { intervention_key?: string };
  assert.deepEqual(rest, interventionIncidentEvent(a, NOW), "name, fingerprint, subject and message as on origin/main");
  // A new intervention routes in the pass that first reads it.
  const b = pushRow("pr#16213@merge", NOW + MIN);
  book.add(b, NOW + 2 * MIN);
  assert.deepEqual((await route(root, book, NOW + 3 * MIN)).map((e) => e.message), [interventionIncidentEvent(b, NOW).message]);
  assert.deepEqual(await route(root, book, NOW + 4 * MIN), []);

  // Control-surface derivation: each hand pause is written once as origin/main writes it, and routed once.
  const ctl = tmp(t);
  const cbook = rowsAt();
  cbook.rows.push({ ts: iso(NOW - HOUR), step: "fleet.pause", scope: "instance", instance: "core", reason: "hand hold", actor: "operator_human", run_id: "FLEET-1" });
  const derived = deriveControlInterventions(cbook.rows);
  assert.equal(derived.length, 1);
  await route(ctl, cbook, NOW);
  await route(ctl, cbook, NOW + MIN);
  const written = cbook.rows.filter((r) => r.step === OPERATOR_INTERVENTION_STEP).map(({ ts: _ts, ...r }) => r);
  assert.deepEqual(written, [interventionLedgerLine(derived[0]!)]);
  assert.deepEqual(cbook.incidents().map((r) => r.message), [interventionIncidentEvent(derived[0]!, NOW).message]);

  // Pacing, the open-feedback skip and the runbook step, on the lane's own pass.
  const lane = tmp(t);
  const lbook = rowsAt();
  lbook.add(pushRow("pr#16275@a6e78257f", NOW - HOUR), NOW - HOUR);
  const fp = String(interventionIncidentEvent(pushRow("pr#16275@a6e78257f", NOW - HOUR), NOW).fingerprint);
  let merged = 0;
  let runbook: SreLaneInput["runbookPass"];
  const seen: string[] = [];
  const pass = (nowMs: number) => {
    lbook.at(nowMs);
    return runSreLanePass({
      stateDir: join(lane, "state"), root: lane, mergedLastDay: () => merged, clock: fixedClock(nowMs), detectors: [],
      readFlowRows: lbook.read, writeFlowEvent: lbook.write, readEvents: lbook.events, hasOpenTask: () => false,
      framesFor: () => [], mergedPrsSince: () => [], readLandedEntry: () => null, log: () => {}, runbookPass: runbook,
    });
  };
  assert.deepEqual(await pass(NOW), { room: 0 }, "a fleet that merged nothing files nothing");
  merged = 1;
  runbook = async (incident) => { seen.push(incident.fingerprint); return { outcome: "held", fileFeedback: false }; };
  assert.deepEqual(await pass(NOW + MIN), { room: 1, runbook: { outcome: "held", fileFeedback: false } }, "a runbook that owns it holds the filing");
  assert.deepEqual(seen, [fp]);
  runbook = undefined;
  const filed = await pass(NOW + 2 * MIN);
  assert.deepEqual([filed.filed, filed.room], [fp, 0]);
  assert.equal(sreLaneRoom(1, 1), 0);
  merged = 5;
  assert.deepEqual(await pass(NOW + 3 * MIN), { room: 4 }, "its own open feedback skips it; one filing today leaves four");
  assert.deepEqual(listFeedback(lane).map((e) => e.id), [incidentFeedbackId(fp)]);
  assert.equal(Object.keys(JSON.parse(readFileSync(sreLaneStorePath(join(lane, "state")), "utf8"))).length, 1);
  assert.equal(lbook.incidents().length, 1, "one routed event across all four passes");
});

test("W1-T14005 criterion 1: on the upgrade, a late row origin/main already routed is not routed again, and one it never read routes once", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  const late = pushRow("pr#15368@c9c0b40f8", NOW - 13 * DAY);
  book.add(late, NOW - 5 * DAY);
  const ontime = pushRow("pr#16442@4dc3ce296", NOW - HOUR, "src/lib/review.ts");
  book.add(ontime, NOW - HOUR);
  // origin/main's last passes: each routed the late row again (its key pruned by at) and the on-time one once, keyless,
  // and left a memory of bare keys without the late one.
  const basePasses = [NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN];
  for (const at of basePasses) book.rows.push(legacyEvent(late, at));
  book.rows.push(legacyEvent(ontime, basePasses[0]));
  writeFileSync(memoryPath(root), JSON.stringify({ routed: [interventionKey(ontime)] }) + "\n");
  // Written after origin/main's last pass, so none of its passes read them: a late row of its own, and a second
  // record of the same push under another at (same message, so only its row's ts tells it from the routed one).
  const unread = pushRow("pr#16452@1b2c3d4e5", NOW - 10 * DAY);
  book.add(unread, NOW - 30_000);
  const twin = pushRow(late.target, NOW - 12 * DAY);
  book.add(twin, NOW - 20_000);
  const legacyBefore = book.incidents().length;
  for (const at of [NOW, NOW + MIN, NOW + HOUR]) await lanePass(root, book, at);
  const keyed = book.incidents().filter((r) => r.intervention_key !== undefined).map((r) => r.intervention_key);
  assert.deepEqual(keyed, [interventionKey(twin), interventionKey(unread)],
    "the new code routes only what origin/main never routed, each once; the late row base routed is not routed again");
  assert.equal(book.incidents().length, legacyBefore + 2);
  assert.ok(memoryText(root).includes(JSON.stringify(interventionKey(late))), "the late key is remembered from then on");
});

test("W1-T14005 criterion 2: events origin/main routed without a key count once per intervention they name, so the upgrade re-files nothing", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  // Two late hand pushes of one class on one file: origin/main routed both on every pass, keyless (every 10 minutes here).
  const a = pushRow("pr#16240@4dcacfa5e", NOW - 10 * DAY);
  const b = pushRow("pr#16240@17cfcb412", NOW - 9 * DAY);
  book.add(a, NOW - 3 * HOUR);
  book.add(b, NOW - 2 * HOUR);
  for (let at = NOW - 3 * HOUR; at < NOW; at += 10 * MIN) book.rows.push(legacyEvent(a, at));
  for (let at = NOW - 2 * HOUR; at < NOW; at += 10 * MIN) book.rows.push(legacyEvent(b, at));
  const fp = String(interventionIncidentEvent(a, NOW).fingerprint);
  const state = join(root, "state");
  // origin/main filed it at its first count, 2, and its task is open.
  writeFileSync(sreLaneStorePath(state), JSON.stringify({ [fp]: { ts: iso(NOW - 3 * HOUR), count: 2 } }) + "\n");
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const over: Partial<SreLaneInput> = { mergedLastDay: () => 10, hasOpenTask: () => true, log: (step, extra) => logs.push({ step, extra }) };
  assert.ok(book.incidents().length >= 30, "the repeat events are present (the condition under test)");
  for (const at of [NOW, NOW + MIN, NOW + 15 * MIN]) assert.equal((await lanePass(root, book, at, over)).filed, undefined, `pass at +${(at - NOW) / MIN} min: no new intervention, nothing filed`);
  assert.deepEqual(listFeedback(root).map((e) => e.id), [], "no -n<count> re-filing from origin/main's repeat events");
  // New interventions do move it: a third is under double, a fourth doubles the filed 2 and re-files at exactly 4.
  book.add(pushRow("pr#16240@aaaaaaaaa", NOW + 16 * MIN), NOW + 16 * MIN);
  assert.equal((await lanePass(root, book, NOW + 17 * MIN, over)).filed, undefined);
  book.add(pushRow("pr#16240@bbbbbbbbb", NOW + 18 * MIN), NOW + 18 * MIN);
  assert.equal((await lanePass(root, book, NOW + 19 * MIN, over)).filed, fp);
  assert.deepEqual(listFeedback(root).map((e) => e.id), [`${incidentFeedbackId(fp)}-n4`]);
  assert.deepEqual(logs.filter((l) => l.step === "sre_lane.filed").map((l) => [l.extra!.count, l.extra!.prior_count]), [[4, 2]]);
  // Round 3: a keyless event is told apart by its own fields, never by the rows read now. Three passes' repeats of one
  // message are one intervention; two events of one message in one pass are two.
  assert.equal(aggregateIncidents([0, 1, 2].map((i) => incidentEventFromLedgerRow(legacyEvent(a, NOW + i * MIN), "core")!))[0].count, 1);
  assert.equal(aggregateIncidents([0, 0, 1, 1].map((i) => incidentEventFromLedgerRow(legacyEvent(a, NOW + i * MIN), "core")!))[0].count, 2);
});

test("W1-T14005 criterion 3: a structured memory entry without a readable seen instant throws, so it never suppresses a routing", async (t) => {
  const book = rowsAt();
  const row = pushRow("pr#19200@fffffffff", NOW - HOUR);
  book.add(row, NOW - HOUR);
  const key = interventionKey(row);
  for (const entry of [{ key, seen: "not a time" }, { key }, { key, seen: NOW - HOUR }, { key, seen: null }]) {
    const dir = tmp(t);
    writeFileSync(memoryPath(dir), JSON.stringify({ routed: [entry] }) + "\n");
    await assert.rejects(route(dir, book, NOW), /Invalid operator-intervention memory/, `memory entry ${JSON.stringify(entry)} must throw`);
  }
  assert.equal(book.incidents().length, 0, "nothing was routed past a malformed memory");
  // The control: the same entry with a readable seen instant is read, and dedupes.
  const ok = tmp(t);
  writeFileSync(memoryPath(ok), JSON.stringify({ routed: [{ key, seen: iso(NOW - HOUR) }] }) + "\n");
  assert.deepEqual(await route(ok, book, NOW), []);
});

// ── Round 3 (review 2026-11-21T03:52Z on fcfe364285) ──────────────────────────────────────────

/** The rows of the live ledger file under `state`. */
function liveRows(state: string): Record<string, unknown>[] {
  const path = join(state, LEDGER_FILENAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The lane on real ledger files, as the daemon runs it: the intervention rows, the routing history and the writes go
 *  through the ledger under `state`; `readEvents` reads the live file only, as daemonSreLaneInput's does. */
function filePass(root: string, nowMs: number, over: Partial<SreLaneInput> = {}) {
  const state = join(root, "state");
  return runSreLanePass({
    stateDir: state, root, mergedLastDay: () => 0, clock: fixedClock(nowMs), detectors: [],
    readEvents: () => liveRows(state).flatMap((r) => r.step === "incident.event" ? [incidentEventFromLedgerRow(r, "core")!] : []),
    hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], readLandedEntry: () => null, log: () => {}, ...over,
  });
}

test("W1-T14005 criterion 1: on the upgrade, a late row whose earlier routings rotated out of the live file is not routed again", async (t) => {
  const root = tmp(t);
  const state = join(root, "state");
  // The review's case: at 12 days old, ts one day old. origin/main routed it on every pass, keyless, and those events
  // and the row itself are now in a rotation, not in the live file.
  const late = pushRow("pr#15368@c9c0b40f8", NOW - 12 * DAY);
  const lateRow = { ...interventionLedgerLine(late), ts: iso(NOW - DAY) };
  const routings = [NOW - DAY + 10 * MIN, NOW - DAY + 20 * MIN, NOW - 2 * HOUR].map((at) => legacyEvent(late, at));
  // Written after origin/main's last pass, in the live file: one it never read, which must route once.
  const unread = pushRow("pr#16452@1b2c3d4e5", NOW - 10 * DAY);
  writeLedger([{ ...interventionLedgerLine(unread), ts: iso(NOW - 30_000) }], {
    dir: state, rotations: [{ at: iso(NOW - HOUR), rows: [lateRow, ...routings], gz: true }],
  });
  // origin/main's memory: bare keys, the late one pruned by its at.
  writeFileSync(memoryPath(root), JSON.stringify({ routed: [] }) + "\n");
  assert.equal(liveRows(state).filter((r) => r.step === "incident.event").length, 0, "fixture: no earlier routing is in the live file");
  for (const at of [NOW, NOW + MIN, NOW + HOUR]) await filePass(root, at);
  const routed = liveRows(state).filter((r) => r.step === "incident.event");
  assert.deepEqual(routed.map((r) => r.intervention_key), [interventionKey(unread)],
    "only the row origin/main never read is routed, once; the late row's rotated routings show it was routed");
  assert.ok(memoryText(root).includes(JSON.stringify(interventionKey(late))), "the late key is remembered from then on");
});

test("W1-T14005 criterion 1: an unreadable routing history routes nothing and writes nothing, and the pass rejects naming it", async (t) => {
  const root = tmp(t);
  const state = join(root, "state");
  const late = pushRow("pr#15368@c9c0b40f8", NOW - 12 * DAY);
  writeLedger([], { dir: state, rotations: [{ at: iso(NOW - HOUR), rows: [legacyEvent(late, NOW - 2 * HOUR)], gz: true }] });
  const broken = join(state, "ledger." + iso(NOW - HOUR).replace(/[:.]/g, "-") + ".ndjson.gz");
  assert.ok(existsSync(broken), "fixture: the rotation is where the union looks");
  writeFileSync(broken, Buffer.alloc(64, 0x21));
  const book = rowsAt();
  book.add(late, NOW - DAY);
  const pass = () => filePass(root, NOW, { readFlowRows: book.read });
  await assert.rejects(pass(), /Operator-intervention routing history unreadable: .*\.ndjson\.gz/);
  assert.deepEqual(liveRows(state), [], "no incident.event: what was routed is unknown, so nothing is routed again");
  assert.equal(memoryText(root), "", "and the memory is not written");
});

test("W1-T14005 criterion 2: a keyless event counts the same at its row's window boundary and after the row expires", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  const late = pushRow("pr#15368@c9c0b40f8", NOW - 13 * DAY);
  const rowTs = NOW - 7 * DAY + 10 * MIN;
  book.add(late, rowTs);
  // origin/main routed it on four passes, keyless.
  for (const at of [rowTs + MIN, rowTs + 2 * MIN, rowTs + 3 * MIN, rowTs + 4 * MIN]) book.rows.push(legacyEvent(late, at));
  const seen: Array<[number, number]> = [];
  const runbookPass: SreLaneInput["runbookPass"] = async (incident) => { seen.push([incident.count, incident.burnPerHour]); return { outcome: "held", fileFeedback: false }; };
  // Its row is still read the minute before it leaves the window, and is not read the minute after.
  await lanePass(root, book, rowTs + WINDOW - MIN, { runbookPass });
  await lanePass(root, book, rowTs + WINDOW + MIN, { runbookPass });
  assert.equal(book.incidents().length, 4, "no pass routed anything new: the condition under test is only the row's expiry");
  assert.deepEqual(seen, [[1, 1], [1, 1]], "one intervention, at the boundary and after its row expired: count and burn do not move");
});

test("W1-T14005 criterion 2: two late rows sharing one message count as two, so an open task filed at 2 is not re-filed", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  // Two records of one push target under two `at`s: one message, two interventions. origin/main routed both on each
  // of four passes, keyless: eight events.
  const one = pushRow("pr#16240@4dcacfa5e", NOW - 12 * DAY);
  const two = pushRow("pr#16240@4dcacfa5e", NOW - 11 * DAY);
  book.add(one, NOW - 3 * HOUR);
  book.add(two, NOW - 3 * HOUR + MIN);
  for (const at of [NOW - 2 * HOUR, NOW - 90 * MIN, NOW - HOUR, NOW - 30 * MIN]) book.rows.push(legacyEvent(one, at), legacyEvent(two, at));
  assert.equal(book.incidents().length, 8, "fixture: eight keyless events of one message");
  const fp = String(interventionIncidentEvent(one, NOW).fingerprint);
  writeFileSync(sreLaneStorePath(join(root, "state")), JSON.stringify({ [fp]: { ts: iso(NOW - 3 * HOUR), count: 2 } }) + "\n");
  const counts: number[] = [];
  const logs: string[] = [];
  const over: Partial<SreLaneInput> = {
    mergedLastDay: () => 10, hasOpenTask: () => true, log: (step) => logs.push(step),
    runbookPass: async (incident) => { counts.push(incident.count); return { outcome: "held", fileFeedback: true }; },
  };
  for (const at of [NOW, NOW + MIN]) assert.equal((await lanePass(root, book, at, over)).filed, undefined, "no new intervention: nothing filed");
  assert.deepEqual(listFeedback(root).map((e) => e.id), [], "no -n<count> re-filing");
  assert.equal(book.incidents().length, 8, "nothing routed again");
  // The control: the count the doubling rule reads is 2. Two new interventions double it and re-file at 4.
  book.add(pushRow("pr#16240@aaaaaaaaa", NOW + 2 * MIN), NOW + 2 * MIN);
  book.add(pushRow("pr#16240@bbbbbbbbb", NOW + 2 * MIN), NOW + 2 * MIN);
  assert.equal((await lanePass(root, book, NOW + 3 * MIN, over)).filed, fp);
  assert.deepEqual(counts.slice(-1), [4]);
  assert.deepEqual(listFeedback(root).map((e) => e.id), [`${incidentFeedbackId(fp)}-n4`]);
});

test("W1-T14005 criterion 4: a new row sharing its message and ts with an expired keyless event routes on its first read", async (t) => {
  const root = tmp(t);
  const book = rowsAt();
  // origin/main routed an earlier record of this push at T, keyless; that record's row has left the window.
  const T = NOW - 10 * MIN;
  const old = pushRow("pr#16213@5c177ab9a", NOW - 20 * DAY);
  book.rows.push(legacyEvent(old, T));
  // A new record of the same push, written at the same instant: same message, same ts. The old event is not its routing.
  const fresh = pushRow("pr#16213@5c177ab9a", T - MIN);
  book.add(fresh, T);
  const first = await lanePass(root, book, T + MIN);
  assert.equal(first.filed, undefined);
  const keyed = () => book.incidents().filter((r) => r.intervention_key !== undefined).map((r) => r.intervention_key);
  assert.deepEqual(keyed(), [interventionKey(fresh)], "routed in the pass that first reads it");
  await lanePass(root, book, T + 2 * MIN);
  await lanePass(root, book, T + HOUR);
  assert.deepEqual(keyed(), [interventionKey(fresh)], "and never again");
  // The rule directly: an event written after a row's first read, at or after its at, shows it; one at its ts does not.
  const seenBefore = tmp(t);
  const sb = rowsAt();
  sb.add(fresh, T);
  sb.rows.push(legacyEvent(old, T + 30_000));
  await lanePass(seenBefore, sb, T + MIN);
  assert.equal(sb.incidents().filter((r) => r.intervention_key !== undefined).length, 0, "origin/main's pass after the row was written routed it");
});
