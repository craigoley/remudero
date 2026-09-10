/**
 * W1-T3325 — A RETRO THAT CANNOT READ GITHUB DECLINED IN SILENCE.
 *
 * `retroTriggerCheck` returned `undefined` on `github.unavailable?.()` and NOTHING was written:
 * `daemon.retro_trigger.check_failed` logs only on a THROW, so an outage and "nothing qualified"
 * rendered identically on every signal the fleet emits.
 *
 * MEASURED 2026-09-10: last `retro.start` anywhere in the three-form ledger union was
 * 2026-09-08T09:12:26Z (~49h), the marker `state/last-retro.json` read 2026-09-03 (five days behind
 * even that), and the daemon log carried 16 `Bad credentials (HTTP 401)` lines since midnight.
 *
 * THE REFUSAL IS CORRECT AND IS NOT TOUCHED. A retro synthesised over an unreadable corpus would be
 * worse than none. Only its silence is the defect.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "../src/lib/tmp.js";

import { retroTriggerCheck } from "../src/run-task.js";

function rootWithMarker(markerTs: string | undefined): string {
  const root = makeTempDir("w1t3325-");
  mkdirSync(join(root, "state"), { recursive: true });
  if (markerTs !== undefined) {
    writeFileSync(join(root, "state", "last-retro.json"), JSON.stringify({ ts: markerTs, learnings_count: 0, runs_seen: 0 }));
  }
  return root;
}

function rowsFrom(root: string): Array<Record<string, unknown>> {
  const p = join(root, "state", "ledger.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const UNAVAILABLE = { unavailable: () => true } as never;
const READABLE = { unavailable: () => false, mergedCommits: () => [] } as never;

test("W1-T3325: an unavailable gateway writes a decline row, where today it writes nothing", () => {
  const root = rootWithMarker("2026-09-03T02:24:39.835Z");
  const decision = retroTriggerCheck(new Date("2026-09-10T10:00:00.000Z"), {
    config: { root } as never,
    github: UNAVAILABLE,
  });

  assert.equal(decision, undefined, "the refusal itself must be unchanged — an unreadable corpus never fires a retro");
  const declines = rowsFrom(root).filter((r) => String(r.step).includes("retro") && String(r.step).includes("declin"));
  assert.equal(declines.length, 1, `exactly one decline row must be written, got ${JSON.stringify(rowsFrom(root).map((r) => r.step))}`);
});

test("W1-T3325: the decline row carries the marker's age, so a routine decline and a multi-day stall differ", () => {
  const root = rootWithMarker("2026-09-03T02:24:39.835Z");
  retroTriggerCheck(new Date("2026-09-10T10:00:00.000Z"), { config: { root } as never, github: UNAVAILABLE });

  const row = rowsFrom(root).find((r) => String(r.step).includes("declin"))!;
  assert.notEqual(row, undefined, "control: a decline row exists to inspect");
  const age = Number(row.days_since_marker);
  assert.ok(Number.isFinite(age), `days_since_marker must be a number, got ${JSON.stringify(row.days_since_marker)}`);
  assert.ok(age > 6 && age < 8, `a marker five days before a two-day-old stall must read ~7 days, got ${age}`);
});

test("W1-T3325: an ABSENT marker declines with an unbounded age rather than a silent zero", () => {
  // A marker that was never written and one written a minute ago are different facts. Reading the
  // absence as 0 would render the most-stalled case as the freshest.
  const root = rootWithMarker(undefined);
  retroTriggerCheck(new Date("2026-09-10T10:00:00.000Z"), { config: { root } as never, github: UNAVAILABLE });

  const row = rowsFrom(root).find((r) => String(r.step).includes("declin"))!;
  assert.notEqual(row, undefined);
  assert.notEqual(row.days_since_marker, 0, "an absent marker must never read as a zero-day-old one");
});

test("W1-T3325: a readable gateway writes NO decline row — the healthy path is unchanged", () => {
  const root = rootWithMarker("2026-09-10T09:00:00.000Z");
  retroTriggerCheck(new Date("2026-09-10T10:00:00.000Z"), { config: { root } as never, github: READABLE });

  const declines = rowsFrom(root).filter((r) => String(r.step).includes("declin"));
  assert.deepEqual(declines, [], "a healthy read must add no row — this is a diagnostic, not new chatter");
});
