// projectFeedbackGates asked two questions of every row for every pending entry; on core that is 836,723 fact rows per
// now build (about 1.7 s, 2026-10-07 replay). It now walks the rows once per call and answers each entry from that pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import { projectFeedbackGates } from "../src/lib/human-gate.js";

const FROM = "2026-10-02T10:00:00.000Z";
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const at = (minutes: number): string => new Date(Date.parse(FROM) + minutes * 60_000).toISOString();
function entry(id: string, status: FeedbackEntry["status"], over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return { id, status, ts: FROM, raw: `Question for ${id}?`, attachments: [], origin: "cli", proposal_pr: null, ...over };
}

/** Rows that count every whole-array walk: iteration, some and findLast each add one. */
function countedRows(rows: Array<Record<string, unknown>>): { rows: Array<Record<string, unknown>>; walks: () => number } {
  let walks = 0;
  const counted = Object.assign([...rows], {
    [Symbol.iterator]() { walks++; return Array.prototype[Symbol.iterator].call(this); },
    some(...args: Parameters<Array<unknown>["some"]>) { walks++; return Array.prototype.some.apply(this, args as never); },
    findLast(...args: Parameters<Array<unknown>["findLast"]>) { walks++; return Array.prototype.findLast.apply(this, args as never); },
  });
  return { rows: counted, walks: () => walks };
}

test("a triage start inside the entry's window claims it, and one outside it, unparseable or for another entry does not", () => {
  const entries = [entry("in", "new"), entry("before", "new", { ts: at(30) }), entry("after", "new"), entry("garbled", "new"), entry("other", "new")];
  const rows = [
    { step: "triage.start", feedback_id: "in", ts: at(10) },
    { step: "triage.start", feedback_id: "before", ts: at(20) }, // before the entry was created
    { step: "triage.start", feedback_id: "after", ts: new Date(NOW + 60_000).toISOString() }, // after now
    { step: "triage.start", feedback_id: "garbled", ts: "not a time" },
    { step: "triage.start", feedback_id: 7, ts: at(10) }, // a non-string id names no entry
    { step: "triage.grill_opened", feedback_id: "other", ts: at(10) }, // another step
  ];
  const source = projectFeedbackGates({ instance: "core", entries, now: NOW, rows });
  assert.deepEqual(Object.fromEntries(source.backlog.map((b) => [b.entry.id, b.state])),
    { in: "claimed", before: "uncalibrated", after: "uncalibrated", garbled: "uncalibrated", other: "uncalibrated" });
});

test("a grill's url is the newest matching grill row's, as findLast answered", () => {
  const rows = [
    { step: "triage.grill_opened", task_id: "TRIAGE-ask", issue_url: "https://example.test/issues/1" },
    { step: "triage.grill_opened", task_id: "TRIAGE-ask", issue_url: "https://example.test/issues/2" },
    { step: "triage.grill_opened", task_id: "TRIAGE-ask", issue_url: 3 }, // not a string: skipped, as before
    { step: "triage.grill_opened", task_id: "TRIAGE-other", issue_url: "https://example.test/issues/9" },
  ];
  const source = projectFeedbackGates({ instance: "core", entries: [entry("ask", "grilling", { proposal_pr: "https://example.test/pr/2" })], now: NOW, rows });
  assert.equal(source.gates[0]!.url, "https://example.test/issues/2");
  const none = projectFeedbackGates({ instance: "core", entries: [entry("ask", "grilling", { proposal_pr: "https://example.test/pr/2" })], now: NOW });
  assert.equal(none.gates[0]!.url, "https://example.test/pr/2", "control: with no rows the proposal PR stands");
});

test("the rows are walked once per call however many entries are pending", () => {
  const pending = Array.from({ length: 40 }, (_, i) => entry(`e${i}`, i % 2 === 0 ? "new" : "grilling"));
  const filler = Array.from({ length: 1_000 }, (_, i) => ({ step: "sweep.pass", ts: at(i % 100) }));
  const { rows, walks } = countedRows([...filler, { step: "triage.start", feedback_id: "e0", ts: at(5) }]);
  const source = projectFeedbackGates({ instance: "core", entries: pending, now: NOW, rows });
  assert.equal(source.backlog.find((b) => b.entry.id === "e0")?.state, "claimed", "positive control: the one start row was found");
  assert.equal(walks(), 1, `the rows were walked ${walks()} times for ${pending.length} pending entries`);
});

test("with no rows nothing is claimed, and a non-string id is still asked of the rows the old way", () => {
  const bare = projectFeedbackGates({ instance: "core", entries: [entry("lonely", "new")], now: NOW });
  assert.equal(bare.backlog[0]?.state, "uncalibrated", "no rows: no triage start can claim it");
  // A malformed record without an id: the old scan compared `feedback_id === undefined`, so a start row with no id
  // claimed it. The index keys only strings, so this case keeps the scan and its answer.
  const malformed = { ...entry("x", "new"), id: undefined } as unknown as FeedbackEntry;
  const source = projectFeedbackGates({ instance: "core", entries: [malformed], now: NOW, rows: [{ step: "triage.start", ts: at(10) }] });
  assert.equal(source.backlog[0]?.state, "claimed");
});
