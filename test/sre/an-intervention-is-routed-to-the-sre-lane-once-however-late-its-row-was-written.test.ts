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
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

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
  // Each pass loses the routing memory, so each re-routes both interventions: events repeat, interventions do not.
  for (let i = 1; i <= 6; i++) {
    rmSync(memoryPath(root), { force: true });
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
