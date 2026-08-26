// test/boot-board-walk-is-open-only.test.ts — W1-T2318: the boot-time caller must not pay for the
// board walk before anything reads it.
//
// THE DEFECT, MEASURED 2026-08-26 IN THE DAEMON'S OWN CONTAINER. `listOpenHeadBranches()` costs a
// full board walk: 26 sequential REST calls, 22.2s total, of which the ONE open page its consumers
// actually read took 432ms and the other 25 pages enumerated 2,400 closed rows. `daemonCommand` and
// `drainCommand` both computed it EAGERLY at boot, synchronously, on the event loop — where it
// blocked past `refreshInstallationToken`'s 20s abort timer (margin 215ms) and made 142 of 142
// token exchanges fail on their first attempt.
//
// WHAT THIS CHANGE DOES AND DOES NOT DO. It moves WHEN the value is computed, not WHAT it is. The
// closed half of the walk is still built and still shared with findMergedByTrailer,
// findMergedByTrailerAll and findMergedByHeadBranch — W1-T377's design, deliberately untouched, and
// a change that removed or truncated it would break three consumers to fix one caller.
//
// THE CONSTRAINT THAT MAKES DEFERRAL SAFE, verified below rather than asserted: the list is read
// ONLY when a task's ledger breaker is already tripped (evaluateDispatchBreakerCorroboratedDetailed
// returns before touching it otherwise), and an absent list is ALREADY a defined, fail-closed state
// — corroboratesForwardProgress answers "unreadable", which is not "corroborated", so the task
// stays "tripped".

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { breakerGateFor } from "../src/run-task.js";
import { corroboratesForwardProgress, type PrRef } from "../src/lib/status.js";
import { EXCHANGE_TIMEOUT_MS } from "../src/lib/github-app.js";

const CLEAR = "W1-CLEAR";
const TRIPPED = "W1-TRIPPED";

/** A ledger where TRIPPED has spent its dispatches and CLEAR has not. `run.start` is the step
 *  `dispatchesWithoutNewOwnedPr` counts; `pr.opened` and a merge credit reset the streak. */
function ledgerWith(maxDispatches: number): string {
  const root = mkdtempSync(join(tmpdir(), "boot-walk-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const lines = [
    ...Array.from({ length: maxDispatches + 2 }, () => JSON.stringify({ step: "run.start", task_id: TRIPPED })),
    JSON.stringify({ step: "run.start", task_id: CLEAR }),
  ].join("\n");
  const p = join(root, "state", "ledger.ndjson");
  writeFileSync(p, lines + "\n");
  return p;
}

function openPr(headRefName: string, number = 1): PrRef {
  return { number, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", headRefName };
}

/** A thunk that counts how many board walks it was asked for. */
function countingThunk(value: ReadonlyArray<PrRef> | null) {
  const calls = { n: 0 };
  return { calls, thunk: () => { calls.n += 1; return value; } };
}

// ── the defect itself: nothing is walked until something reads it ──────────────────────────────

test("constructing the gate walks the board ZERO times — the boot cost is gone, not merely smaller", () => {
  const ledgerPath = ledgerWith(5);
  const { calls, thunk } = countingThunk([openPr("run-W1-TRIPPED-1785957031821")]);
  breakerGateFor(ledgerPath, thunk);
  assert.equal(calls.n, 0, "building the gate must not force the walk — that IS the boot-path defect");
});

test("a CLEAR task never walks the board at all, because the breaker returns before reading it", () => {
  const ledgerPath = ledgerWith(5);
  const { calls, thunk } = countingThunk([openPr("run-W1-CLEAR-1785957031821")]);
  const gate = breakerGateFor(ledgerPath, thunk);
  gate.isTripped(CLEAR);
  assert.equal(calls.n, 0, "for every clear task the 22s walk is a value computed and never read");
});

test("the walk happens on the FIRST read, and exactly once however many reads follow", () => {
  const ledgerPath = ledgerWith(5);
  const { calls, thunk } = countingThunk([openPr("run-W1-TRIPPED-1785957031821")]);
  const gate = breakerGateFor(ledgerPath, thunk);
  gate.isTripped(TRIPPED);
  assert.equal(calls.n, 1, "the first read of a tripped task resolves it");
  gate.isTripped(TRIPPED);
  gate.isTripped(CLEAR);
  gate.isTripped(TRIPPED);
  assert.equal(calls.n, 1, "memoised — a thunk called twice would be two board walks, which is worse");
});

// ── the value is unchanged: only WHEN it is computed moves ─────────────────────────────────────

test("a tripped task with an owned open branch still clears, exactly as when the value was eager", () => {
  const ledgerPath = ledgerWith(5);
  const branches = [openPr("run-W1-TRIPPED-1785957031821")];
  const eager = breakerGateFor(ledgerPath, branches);
  const deferred = breakerGateFor(ledgerPath, () => branches);
  assert.equal(deferred.isTripped(TRIPPED), eager.isTripped(TRIPPED), "same verdict, deferred or not");
  assert.equal(eager.isTripped(TRIPPED), false, "an owned open branch corroborates forward progress");
});

test("an ARRAY, null and undefined all still pass straight through — every existing caller is untouched", () => {
  const ledgerPath = ledgerWith(5);
  const branches = [openPr("run-W1-TRIPPED-1785957031821")];
  assert.equal(breakerGateFor(ledgerPath, branches).isTripped(TRIPPED), false);
  assert.equal(breakerGateFor(ledgerPath, null).isTripped(TRIPPED), true);
  assert.equal(breakerGateFor(ledgerPath, undefined).isTripped(TRIPPED), true);
});

// ── the fail-closed path is NOT weakened ───────────────────────────────────────────────────────

test("a null list still answers \"unreadable\", which is not \"corroborated\", so the task stays tripped", () => {
  assert.equal(corroboratesForwardProgress(null, TRIPPED), "unreadable");
  assert.equal(corroboratesForwardProgress(undefined, TRIPPED), "unreadable");
  assert.notEqual(corroboratesForwardProgress(null, TRIPPED), "corroborated");
  const ledgerPath = ledgerWith(5);
  assert.equal(breakerGateFor(ledgerPath, () => null).isTripped(TRIPPED), true, "fail CLOSED, unchanged");
});

// ── the things this task must NOT have changed ─────────────────────────────────────────────────

test("the abort timeout constant is not raised by this task", () => {
  assert.equal(EXCHANGE_TIMEOUT_MS, 20_000, "raising it converts a fast loud failure into a slow one");
});

test("nothing added paces, throttles or sleeps — W1-T1066's lockout is why", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("export function breakerGateFor"), src.indexOf("const stateFor = (taskId: string)"));
  assert.ok(gate.length > 0, "located breakerGateFor");
  for (const banned of ["setTimeout", "setInterval", "sleep(", "await new Promise"]) {
    assert.ok(!gate.includes(banned), `breakerGateFor must not ${banned} — nothing paces a call`);
  }
});

test("the reporting defect is SEPARATE and still open — this task does not close it", () => {
  const app = readFileSync(new URL("../src/lib/github-app.js".replace(".js", ".ts"), import.meta.url), "utf8");
  assert.ok(
    app.includes("timeoutController.signal.aborted"),
    "refreshInstallationToken still reads the abort signal rather than the error, so it still writes " +
      "`exchange timed out` for more than one cause. Closing W1-T2318 must not be read as closing that.",
  );
});
