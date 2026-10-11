import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyShadowDiff, type ShadowEvidence } from "../src/lib/view-shadow.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const GAP_MS = 2_000;

/** Two sources read two seconds apart, with no ledger row in the gap naming anything. */
const TWO_SECONDS_APART: ShadowEvidence = {
  legacyAsOfMs: T0 - GAP_MS, viewAsOfMs: T0, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(),
  rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0,
};

const iso = (ms: number): string => new Date(ms).toISOString();

test("an …At diff three days apart while the sources are two seconds apart, with no row in the gap, is classified real", () => {
  const d = classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: iso(T0), view: iso(T0 - 3 * DAY), ids: [] }, TWO_SECONDS_APART);
  assert.equal(d.classification, "real");
  const epoch = classifyShadowDiff({ path: "tasks[0].finished_at", legacy: T0, view: T0 - 3 * DAY, ids: [] }, TWO_SECONDS_APART);
  assert.equal(epoch.classification, "real");
});

test("an …At diff whose values differ by less than the gap stays timing", () => {
  const iso1 = classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: iso(T0 - 1_500), view: iso(T0), ids: [] }, TWO_SECONDS_APART);
  assert.equal(iso1.classification, "timing");
  const epoch = classifyShadowDiff({ path: "tasks[0].started_at", legacy: T0 - GAP_MS, view: T0, ids: [] }, TWO_SECONDS_APART);
  assert.equal(epoch.classification, "timing", "a difference equal to the gap is explained by it");
});

test("an age or duration leaf is timing only when its difference is within the gap", () => {
  assert.equal(classifyShadowDiff({ path: "health.lastPollAgeMs", legacy: 5_000, view: 6_500, ids: [] }, TWO_SECONDS_APART).classification, "timing");
  assert.equal(classifyShadowDiff({ path: "health.lastPollAgeMs", legacy: 5_000, view: 5_000 + 3 * DAY, ids: [] }, TWO_SECONDS_APART).classification, "real");
});

test("a time leaf whose values are not both instants is not explained by the gap", () => {
  assert.equal(classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: null, view: iso(T0 - 3 * DAY), ids: [] }, TWO_SECONDS_APART).classification, "real");
  assert.equal(classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: "soon", view: iso(T0), ids: [] }, TWO_SECONDS_APART).classification, "real");
});

test("a value stamped inside the gap by the side read later is timing, however far it is from the other side's", () => {
  // The later read (the view, as-of T0) holds a reading stamped one second before it; the earlier read (legacy, T0 - 2 s) has the older one.
  const rewritten = classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: iso(T0 - 3 * DAY), view: iso(T0 - 1_000), ids: [] }, TWO_SECONDS_APART);
  assert.equal(rewritten.classification, "timing");
  const appeared = classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: null, view: iso(T0 - 1_000), ids: [] }, TWO_SECONDS_APART);
  assert.equal(appeared.classification, "timing", "a value the earlier read lacked, stamped inside the gap");
  const stale = classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: iso(T0 - 1_000), view: iso(T0 - 3 * DAY), ids: [] }, TWO_SECONDS_APART);
  assert.equal(stale.classification, "real", "the later read holding the OLDER value is not a reading landing in the gap");
});

test("a time leaf days apart is still timing when a row in the gap names its id", () => {
  const ev: ShadowEvidence = { ...TWO_SECONDS_APART, named: new Set(["W1-T1"]), namedInGap: new Set(["W1-T1"]), rowsInGap: 1 };
  const d = classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: iso(T0), view: iso(T0 - 3 * DAY), ids: ["W1-T1"] }, ev);
  assert.equal(d.classification, "timing");
});

test("equal as-of instants explain no time-leaf diff", () => {
  const same: ShadowEvidence = { ...TWO_SECONDS_APART, legacyAsOfMs: T0 };
  assert.equal(classifyShadowDiff({ path: "tasks[0].updatedAt", legacy: iso(T0), view: iso(T0 + 1_000), ids: [] }, same).classification, "real");
});
