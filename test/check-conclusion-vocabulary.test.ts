// W1-T2274: two poll loops (`pollToGate`, `checkWaitStalled`, both `src/run-task.ts`) used to
// classify a GitHub check conclusion by a private `RED_CONCLUSIONS` set plus the literal string
// "SUCCESS" — a THIRD vocabulary, older than and inconsistent with the two `src/lib/sweep.ts`
// already exports for the exact same purpose (`REQUIRED_CHECK_OK`/`REQUIRED_CHECK_FAIL`,
// `checksStateFromRollup`'s own predicate). Four real conclusions fell through the gap:
//   - NEUTRAL and SKIPPED (a clean, concluded result) were in neither set, so a check that had
//     already finished read as `pending` FOREVER, because it never became the literal "SUCCESS"
//     (live incident: #2830/#2833, `osv-scanner` NEUTRAL read pending for hours after merging).
//   - CANCELLED ("nobody reached a verdict") was folded into the same bucket as FAILURE ("a
//     verdict came back bad") and `pollToGate` returns on the first red it finds — TERMINALLY,
//     unlike the sweep's own bounded, re-derived-every-pass read (live incident: #2794, a
//     CANCELLED `coverage-ratchet` attempt superseded 18 minutes later by SUCCESS the loop never
//     lived to see).
//   - STALE was — and, before this task, remained — in NEITHER set ANYWHERE in the tree,
//     including `checksStateFromRollup` itself, which held `checksState` at "pending" forever
//     for it: the one conclusion even the #1698 fix left unclassified.
//
// The remedy (design note (i)) is a DELETION, not an invention: `RED_CONCLUSIONS` is gone, and
// the poll loops now read `REQUIRED_CHECK_OK`/`REQUIRED_CHECK_FAIL` — `src/lib/sweep.ts`'s own
// sets — carving CANCELLED and STALE out of the poll loops' TERMINAL red return only (design note
// (ii): both mean "no verdict", so a poll loop must re-queue-or-wait on them, never end the wait
// naming a check that never ran to a verdict). `STALL_WINDOW` (5, unchanged) still bounds the
// wait regardless: this file's last test pins that down directly.
//
// Every predicate under test here is PURE — no I/O, no clock — so all assertions run in-process.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkWaitStalled,
  ciGateFromRollup,
  pollToGate,
  STALL_WINDOW,
} from "../src/run-task.js";
import {
  checksStateFromRollup,
  REQUIRED_CHECK_FAIL,
  REQUIRED_CHECK_OK,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";

const RUN_TASK_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "run-task.ts"),
  "utf8",
);

/** `STALL_WINDOW` identical copies of `reading` — the minimum a real caller would have
 *  accumulated before {@link checkWaitStalled} has enough evidence to conclude stalled. */
function identicalWindow(
  reading: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[],
) {
  return Array.from({ length: STALL_WINDOW }, () => reading);
}

// ── acceptance 1/2: a concluded, clean check is DONE, not pending ───────────────────────────

test("BITES (#2830/#2833 shape): a NEUTRAL check that concluded hours ago is classified done, never named in a stalled wait's still-pending list", () => {
  const rollup = [{ name: "osv-scanner", conclusion: "NEUTRAL" }];
  const result = checkWaitStalled(identicalWindow(rollup));
  assert.equal(result.stalled, true, "an unchanging rollup with nothing running is still a stall");
  assert.deepEqual(result.pending, [], "NEUTRAL is done — it must not be named as still pending");
});

test("BITES: a SKIPPED check (the same defect one conclusion over) is classified done, never pending", () => {
  const rollup = [{ name: "osv-scanner", conclusion: "SKIPPED" }];
  const result = checkWaitStalled(identicalWindow(rollup));
  assert.equal(result.stalled, true);
  assert.deepEqual(result.pending, [], "SKIPPED is done — it must not be named as still pending");
});

test("HOLDS: a genuinely unfinished check (QUEUED, never SUCCESS/NEUTRAL/SKIPPED) is still named pending", () => {
  const rollup = [{ name: "lint", status: "QUEUED" }];
  const result = checkWaitStalled(identicalWindow(rollup));
  assert.equal(result.stalled, true);
  assert.deepEqual(result.pending, ["lint"], "a check that never concluded must still show as pending");
});

// ── acceptance 3: CANCELLED is distinguished from FAILED, never folded into terminal red ─────

test("BITES (#2794 shape): ciGateFromRollup does not read a CANCELLED required check as red — that fold is the #2794 defect", () => {
  const rollup = [{ name: "coverage-ratchet", conclusion: "CANCELLED" }];
  assert.notEqual(
    ciGateFromRollup(rollup),
    "red",
    "CANCELLED means nobody reached a verdict, not that one came back bad — it must not gate red",
  );
});

test("CONTROL: ciGateFromRollup still reads a genuinely FAILED check as red — the fold is narrowed, not removed", () => {
  const rollup = [{ name: "ci", conclusion: "FAILURE" }];
  assert.equal(ciGateFromRollup(rollup), "red", "a real failure must still gate red");
});

test("BITES (#2794 shape, end to end): pollToGate never returns a terminal 'required check red' verdict for a CANCELLED check — it keeps polling toward the bounded stall path instead", async () => {
  let reads = 0;
  const rollup = [{ name: "coverage-ratchet", conclusion: "CANCELLED" }];
  const outcome = await pollToGate("u/2794", () => {}, 6, {
    readJson: async () => {
      reads++;
      return { state: "OPEN", statusCheckRollup: rollup };
    },
    sleep: async () => {},
  });
  assert.equal(outcome.merged, false);
  assert.doesNotMatch(
    outcome.reason,
    /required check red/,
    "a CANCELLED check must never produce the terminal red verdict — nobody reached a verdict on it",
  );
  assert.match(outcome.reason, /no progress/, "it must instead resolve via the bounded stall path");
  assert.ok(reads >= STALL_WINDOW, "the loop must actually keep polling CANCELLED rather than returning on the first read");
});

test("CONTROL: pollToGate still returns the terminal 'required check red' verdict immediately for a genuine FAILURE", async () => {
  let reads = 0;
  const outcome = await pollToGate("u/fail", () => {}, 6, {
    readJson: async () => {
      reads++;
      return { state: "OPEN", statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] };
    },
    sleep: async () => {},
  });
  assert.equal(outcome.merged, false);
  assert.match(outcome.reason, /required check red: ci/);
  assert.equal(reads, 1, "a genuine failure must short-circuit on the very first read, unlike CANCELLED");
});

// ── acceptance 4: STALE is classified, not left holding the wait open forever ────────────────

test("BITES: checksStateFromRollup no longer holds 'pending' forever for a STALE required check — the one conclusion even the #1698 fix left unclassified", () => {
  const rollup: RollupCheckEntry[] = [{ name: "ci-gate", conclusion: "STALE", startedAt: "2026-08-01T00:00:00Z" }];
  const state = checksStateFromRollup(rollup, ["ci-gate"]);
  assert.notEqual(state, "pending", "STALE must be classified, not left holding the arm gate open forever");
});

test("STALE is grouped with CANCELLED, not with a genuine failure's terminal poll-loop behaviour: pollToGate does not fold it into terminal red either", async () => {
  const outcome = await pollToGate("u/stale", () => {}, 6, {
    readJson: async () => ({ state: "OPEN", statusCheckRollup: [{ name: "ci-gate", conclusion: "STALE" }] }),
    sleep: async () => {},
  });
  assert.doesNotMatch(outcome.reason, /required check red/, "STALE means the reading is void, not that a verdict came back bad");
  assert.match(outcome.reason, /no progress/, "a run that will never conclude again is still caught by the bounded stall path");
});

// ── acceptance 5: the falsifier — an unrecognised conclusion never reaches green ──────────────

test("FALSIFIER (design note (iv)): a conclusion no set names never reaches green, anywhere in the vocabulary", () => {
  const unknown = "GITHUB_INVENTS_THIS_TOMORROW";
  assert.ok(!REQUIRED_CHECK_OK.has(unknown) && !REQUIRED_CHECK_FAIL.has(unknown), "test fixture sanity: must be unrecognised");

  // checkWaitStalled: an unrecognised conclusion must still be named pending, never silently
  // treated as done.
  const stallResult = checkWaitStalled(identicalWindow([{ name: "mystery", conclusion: unknown }]));
  assert.deepEqual(stallResult.pending, ["mystery"], "an unrecognised conclusion must read as pending, never as done");

  // ciGateFromRollup: the named `ci` check reporting an unrecognised conclusion must never gate
  // green.
  assert.notEqual(ciGateFromRollup([{ name: "ci", conclusion: unknown }]), "green");

  // checksStateFromRollup: the sweep's own arm gate must not manufacture a green either.
  const rollup: RollupCheckEntry[] = [{ name: "ci-gate", conclusion: unknown, startedAt: "2026-08-01T00:00:00Z" }];
  assert.notEqual(checksStateFromRollup(rollup, ["ci-gate"]), "green");
});

// ── acceptance 6: the progress bound (STALL_WINDOW, unchanged) still stops the wait ───────────

test("HOLDS (W1-T382, unchanged by this task): five identical readings with nothing running still stops the wait, even after widening the done-set", () => {
  const pending = [
    { name: "lint", status: "QUEUED" },
    { name: "remudero-review", state: "PENDING" },
  ];
  const result = checkWaitStalled(identicalWindow(pending));
  assert.equal(result.stalled, true, "STALL_WINDOW identical readings with nothing running must still conclude stalled");
  assert.deepEqual(new Set(result.pending), new Set(["lint", "remudero-review"]));
});

test("HOLDS: fewer than STALL_WINDOW identical readings is still never enough evidence to conclude stalled", () => {
  const short = Array.from({ length: STALL_WINDOW - 1 }, () => [{ name: "lint", status: "QUEUED" }]);
  const result = checkWaitStalled(short);
  assert.equal(result.stalled, false);
});

// ── acceptance 7: the poll loops read the SAME conclusion sets the sweep reads ────────────────

test("WIRING: run-task.ts no longer defines its own private red-conclusion vocabulary", () => {
  assert.doesNotMatch(
    RUN_TASK_SRC,
    /const RED_CONCLUSIONS/,
    "the third, private vocabulary must be deleted, not merely supplemented",
  );
  assert.match(
    RUN_TASK_SRC,
    /REQUIRED_CHECK_OK/,
    "the poll loops must read the sweep's own REQUIRED_CHECK_OK, imported rather than re-invented",
  );
  assert.match(
    RUN_TASK_SRC,
    /REQUIRED_CHECK_FAIL/,
    "the poll loops must read the sweep's own REQUIRED_CHECK_FAIL, imported rather than re-invented",
  );
});

test("BEHAVIORAL: every REQUIRED_CHECK_OK conclusion is classified done by checkWaitStalled, not just the literal SUCCESS this used to test alone", () => {
  for (const conclusion of REQUIRED_CHECK_OK) {
    const result = checkWaitStalled(identicalWindow([{ name: "x", conclusion }]));
    assert.deepEqual(result.pending, [], `${conclusion} is in REQUIRED_CHECK_OK and must be classified done`);
  }
});

test("BEHAVIORAL: every REQUIRED_CHECK_FAIL conclusion EXCEPT the no-verdict pair (CANCELLED/STALE) gates ciGateFromRollup red immediately", () => {
  for (const conclusion of REQUIRED_CHECK_FAIL) {
    const isRed = ciGateFromRollup([{ name: "ci", conclusion }]) === "red";
    if (conclusion === "CANCELLED" || conclusion === "STALE") {
      assert.equal(isRed, false, `${conclusion} means no verdict was reached — it must not gate red`);
    } else {
      assert.equal(isRed, true, `${conclusion} is a real failure in REQUIRED_CHECK_FAIL and must gate red`);
    }
  }
});
