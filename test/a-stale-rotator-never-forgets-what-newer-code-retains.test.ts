import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  LEDGER_ROTATION_BACKSTOP_MULTIPLIER,
  ledgerRetainedStepsPath,
  rotateLedger,
} from "../src/lib/ledger.js";
import { makeTempDir } from "../src/lib/tmp.js";

// MEASURED 2026-10-01: every `dispatch.breaker_released` row written 2026-09-29/30 sat in an archive while the
// 09-28 `dispatch.circuit_broken` rows they cancel stayed live. A rotation is done by whichever process crosses the
// ceiling, and the 09-30 11:06 one was an operator CLI on the host running a checkout that predated the step joining
// DECISION_RELEVANT_LEDGER_STEPS. The breaker re-seeded from the trip and held four released tasks indeterminate.

const CEILING = 20_000;
const RELEASED = "dispatch.breaker_released";

function dir(t: { after: (fn: () => void) => void }): string {
  const d = makeTempDir("stale-rotator");
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function row(step: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, run_id: `r-${step}-${ts}`, task_id: "W1-T1", step, ...extra });
}

function oversized(path: string, keep: string[], factor = 2): void {
  const lines = [...keep];
  let n = 0;
  while (Buffer.byteLength(lines.join("\n") + "\n", "utf8") <= CEILING * factor) {
    lines.push(row("noise.row", "2026-09-30T11:00:00.000Z", { n: n++, pad: "x".repeat(120) }));
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

const staleSteps = new Set([...DECISION_RELEVANT_LEDGER_STEPS].filter((s) => s !== RELEASED));

test("W1-T5041: every rotation persists the union of retained steps", (t) => {
  const d = dir(t);
  const ledger = join(d, "ledger.ndjson");
  writeFileSync(ledgerRetainedStepsPath(ledger), JSON.stringify({ steps: ["a.step.only.newer.code.knows"] }));
  oversized(ledger, [row(RELEASED, "2026-09-29T18:45:00.000Z")]);
  // A rotator whose own set already covers the persisted one is current — but here it lacks the
  // persisted step, so make it current by giving it that step too.
  const steps = new Set([...DECISION_RELEVANT_LEDGER_STEPS, "a.step.only.newer.code.knows"]);
  const result = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0, retainedSteps: steps });
  assert.equal(result.rotated, true);
  const persisted = JSON.parse(readFileSync(ledgerRetainedStepsPath(ledger), "utf8")) as { steps: string[]; lastFullRotationMs: number };
  assert.ok(persisted.steps.includes(RELEASED), "this rotator's own steps are recorded");
  assert.ok(persisted.steps.includes("a.step.only.newer.code.knows"), "a step already recorded is never dropped");
  assert.equal(typeof persisted.lastFullRotationMs, "number");
});

test("W1-T5041: a rotator missing a retained step skips the rotation", (t) => {
  const d = dir(t);
  const ledger = join(d, "ledger.ndjson");
  writeFileSync(ledgerRetainedStepsPath(ledger), JSON.stringify({ steps: [...DECISION_RELEVANT_LEDGER_STEPS] }));
  oversized(ledger, [row(RELEASED, "2026-09-29T18:45:00.000Z")]);
  const result = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0, retainedSteps: staleSteps });
  assert.equal(result.rotated, false, "the stale rotator leaves rotation to current code");
  assert.deepEqual(result.deferredMissingSteps, [RELEASED]);
  const live = readFileSync(ledger, "utf8");
  assert.ok(live.includes(`"step":"${RELEASED}"`), "the release row is still live");
  assert.ok(live.includes('"step":"ledger.rotation_deferred"'), "the deferral is ledgered");
  assert.equal(readdirSync(d).filter((f) => /^ledger\.\d/.test(f)).length, 0, "no archive was written");
  // A second deferral with the same missing set inside the pacing window is not ledgered again.
  rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0, retainedSteps: staleSteps });
  assert.equal(readFileSync(ledger, "utf8").split('"step":"ledger.rotation_deferred"').length - 1, 1);
});

test("W1-T5041: a stale rotator past the backstop rotates but keeps every persisted step", (t) => {
  const d = dir(t);
  const ledger = join(d, "ledger.ndjson");
  writeFileSync(ledgerRetainedStepsPath(ledger), JSON.stringify({ steps: [...DECISION_RELEVANT_LEDGER_STEPS] }));
  oversized(ledger, [row(RELEASED, "2026-09-29T18:45:00.000Z")], LEDGER_ROTATION_BACKSTOP_MULTIPLIER + 1);
  const result = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0, retainedSteps: staleSteps });
  assert.equal(result.rotated, true, "growth stays bounded by the backstop");
  assert.ok(readFileSync(ledger, "utf8").includes(`"step":"${RELEASED}"`), "the persisted step is retained anyway");
});

test("W1-T5041: a current rotation re-carries a decision row an older rotation archived", (t) => {
  const d = dir(t);
  const ledger = join(d, "ledger.ndjson");
  const lastFull = Date.now() - 60 * 60_000;
  writeFileSync(ledgerRetainedStepsPath(ledger), JSON.stringify({ steps: [...DECISION_RELEVANT_LEDGER_STEPS], lastFullRotationMs: lastFull }));
  // An archive a pre-feature checkout wrote AFTER the last current rotation: it holds the release row it failed to keep.
  const released = row(RELEASED, "2026-09-29T18:45:00.000Z");
  const inWindow = new Date(lastFull + 30 * 60_000);
  const staleArchive = join(d, `ledger.${inWindow.toISOString().replace(/[:.]/g, "-")}.ndjson.gz`);
  writeFileSync(staleArchive, gzipSync(Buffer.from([released, row("noise.row", "2026-09-29T18:46:00.000Z")].join("\n") + "\n")));
  utimesSync(staleArchive, inWindow, inWindow);
  // A torn archive in the same window is skipped, never fatal to the rotation.
  const torn = new Date(lastFull + 31 * 60_000);
  const tornArchive = join(d, `ledger.${torn.toISOString().replace(/[:.]/g, "-")}.ndjson.gz`);
  writeFileSync(tornArchive, "not gzip");
  utimesSync(tornArchive, torn, torn);
  // An archive OLDER than the last current rotation is never re-read.
  const oldRow = row(RELEASED, "2026-09-01T00:00:00.000Z", { task: "W1-T-OLD" });
  const oldArchive = join(d, "ledger.2026-09-01T00-00-00-000Z.ndjson");
  writeFileSync(oldArchive, oldRow + "\n");
  const before = new Date(lastFull - 60_000);
  utimesSync(oldArchive, before, before);
  oversized(ledger, [row("dispatch.circuit_broken", "2026-09-28T14:46:11.366Z", { task: "W1-T1", freshCount: 5 })]);
  const result = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0 });
  assert.equal(result.rotated, true);
  assert.equal(result.recarriedLineCount, 1);
  const live = readFileSync(ledger, "utf8");
  assert.ok(live.includes(released), "the archived release row is live again");
  assert.ok(!live.includes("W1-T-OLD"), "an archive from before the last current rotation is not re-read");
  assert.ok(live.includes('"step":"ledger.recarried"'), "the re-carry is ledgered");
  assert.ok(live.indexOf(released) < live.indexOf('"step":"ledger.recarried"'));
  // The next current rotation finds the row already live and re-carries nothing twice.
  oversized(ledger, live.trim().split("\n"));
  const again = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0 });
  assert.equal(again.recarriedLineCount ?? 0, 0);
  assert.equal(readFileSync(ledger, "utf8").split(released).length - 1, 1, "never duplicated");
});

test("W1-T5041: an unreadable retained-steps file behaves as today and is ledgered", (t) => {
  const d = dir(t);
  const ledger = join(d, "ledger.ndjson");
  writeFileSync(ledgerRetainedStepsPath(ledger), "{not json");
  oversized(ledger, [row(RELEASED, "2026-09-29T18:45:00.000Z")]);
  const result = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0, retainedSteps: staleSteps });
  assert.equal(result.rotated, true, "no persisted set to honour, so the rotation proceeds as it always did");
  assert.ok(readFileSync(ledger, "utf8").includes('"step":"ledger.retained_steps_unreadable"'));
  assert.ok(existsSync(ledgerRetainedStepsPath(ledger)));
});

test("W1-T5041: the helper reads a missing or malformed retained-steps record as absent or unreadable", (t) => {
  const d = dir(t);
  const ledger = join(d, "ledger.ndjson");
  writeFileSync(ledgerRetainedStepsPath(ledger), JSON.stringify({ steps: "not-a-list" }));
  oversized(ledger, [row(RELEASED, "2026-09-29T18:45:00.000Z")]);
  const result = rotateLedger(ledger, { ceilingBytes: CEILING, smoothingWindowMs: 0 });
  assert.equal(result.rotated, true);
  assert.ok(readFileSync(ledger, "utf8").includes('"step":"ledger.retained_steps_unreadable"'));
});
