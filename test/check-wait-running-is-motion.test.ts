import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkWaitStalled, rollupHasRunningCheck, STALL_WINDOW, waitForCiGreen } from "../src/run-task.js";

/**
 * A RUNNING CHECK IS MOTION. W1-T382 correctly replaced a DEADLINE with a DERIVATIVE, then
 * sampled the derivative faster than the signal changes: `STALL_WINDOW × everySec` is 5 × 6s =
 * THIRTY SECONDS, against a `ci` job that needs ~9 minutes. A healthy long job has a derivative
 * of exactly zero by construction — `IN_PROGRESS` is a constant string — so the detector fired
 * about seven minutes before `ci` went green, on PRs that then passed everything.
 *
 * BOTH DIRECTIONS, ONE VARIABLE APART. Every pair below holds the rollup shape, the window
 * length and the poll count fixed and changes ONLY whether a check is running. A test asserting
 * only "a running rollup does not stall" would pass on a change that deleted the detector
 * outright, which would reintroduce the unbounded wait W1-T382 was careful to bound — so the
 * quiescent twin, which MUST still stall, sits beside it in the same test.
 *
 * `checkWaitStalled` and `rollupHasRunningCheck` are PURE over `RollupEntry[]`-shaped readings,
 * so the predicate-level pairs assert in-process; the last test drives the real `waitForCiGreen`
 * so the integration is proven to execute rather than assumed.
 */

type Reading = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[];

/** `STALL_WINDOW` identical copies — the minimum evidence `checkWaitStalled` will act on. */
function identicalWindow(reading: Reading): Reading[] {
  return Array.from({ length: STALL_WINDOW }, () => reading);
}

test("rollupHasRunningCheck: IN_PROGRESS is running and QUEUED or PENDING is not", () => {
  assert.equal(rollupHasRunningCheck([{ name: "ci", status: "IN_PROGRESS" }]), true);
  // The three shapes of "waiting for something that may never come" — none is evidence of work.
  assert.equal(rollupHasRunningCheck([{ name: "lint", status: "QUEUED" }]), false, "queued is not running");
  assert.equal(
    rollupHasRunningCheck([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]),
    false,
    "a finished check is not running",
  );
  assert.equal(
    rollupHasRunningCheck([{ context: "remudero-review", state: "PENDING" }]),
    false,
    "a status context has no lifecycle — PENDING may never be updated by anyone",
  );
  assert.equal(rollupHasRunningCheck([]), false, "an empty rollup has nothing running");
  assert.equal(rollupHasRunningCheck(undefined), false, "an absent rollup has nothing running");
});

test("rollupHasRunningCheck reads status and never conclusion, and accepts REST casing", () => {
  // `IN_PROGRESS` is a status on the wire and never a conclusion, so consulting the conclusion
  // could only match a shape GitHub does not emit — this pins that it does not.
  assert.equal(
    rollupHasRunningCheck([{ name: "ci", conclusion: "IN_PROGRESS" }]),
    false,
    "IN_PROGRESS parked in `conclusion` is not a wire shape and must not count as running",
  );
  // REST spells these lowercase where GraphQL spells them upper; both doors, same answer.
  assert.equal(rollupHasRunningCheck([{ name: "ci", status: "in_progress" }]), true, "REST casing still resolves");
});

test("BOTH DIRECTIONS: an unmoving window with ci running does not stall but quiescent does", () => {
  // One variable. Same two checks, same STALL_WINDOW identical readings, same everything —
  // `ci` is IN_PROGRESS in the first and COMPLETED in the second.
  const running: Reading = [
    { name: "ci", status: "IN_PROGRESS" },
    { name: "lint", status: "QUEUED" },
  ];
  const quiescent: Reading = [
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "lint", status: "QUEUED" },
  ];

  const whileRunning = checkWaitStalled(identicalWindow(running));
  assert.equal(whileRunning.stalled, false, "a nine-minute job holding IN_PROGRESS is working, not stalled");
  assert.deepEqual(whileRunning.pending, [], "a non-stall names nothing pending");

  const whileQuiescent = checkWaitStalled(identicalWindow(quiescent));
  assert.equal(whileQuiescent.stalled, true, "nothing running and nothing changing is STILL a stall");
  assert.deepEqual(whileQuiescent.pending, ["lint"], "and it still names what it was waiting on");
});

test("THE REAL STALL still fires: a check stuck QUEUED forever, with no workflow ever starting", () => {
  // The population the detector exists for, and the one it must never stop catching: a runner
  // that never arrives. Nothing is IN_PROGRESS, so the running guard does not apply and the
  // window governs exactly as before.
  const stuck: Reading = [{ name: "ci", status: "QUEUED" }];
  const result = checkWaitStalled(identicalWindow(stuck));
  assert.equal(result.stalled, true, "queued forever is a stall — QUEUED must never count as motion");
  assert.deepEqual(result.pending, ["ci"]);
});

test("THE REAL STALL still fires: a required status nobody will ever post", () => {
  // The second stuck shape — a StatusContext sitting PENDING with no check run behind it to
  // ever move it. Deliberately paired with the queued case: both must remain catchable, or the
  // fix would have traded a false stall for an unbounded wait.
  const neverPosted: Reading = [{ context: "remudero-review", state: "PENDING" }];
  const result = checkWaitStalled(identicalWindow(neverPosted));
  assert.equal(result.stalled, true, "a status that will never be posted is a stall");
  assert.deepEqual(result.pending, ["remudero-review"]);
});

test("THE REAL STALL still fires: an EMPTY rollup — no workflow ever started at all", () => {
  // The third stuck shape, and the one an over-eager running guard would most easily swallow:
  // there is nothing to inspect, so "is anything running?" and "did anything change?" both have
  // to answer no. An empty rollup must remain a stall rather than an excuse to wait forever.
  const result = checkWaitStalled(identicalWindow([]));
  assert.equal(result.stalled, true, "no checks at all is a stall, not motion");
  assert.deepEqual(result.pending, [], "and there is nothing to name as pending");
});

test("the running guard outranks the window: many identical polls still do not stall while ci runs", () => {
  // The measured shape: ~7 minutes of byte-identical readings during a healthy `ci`. At a
  // six-second cadence that is ~73 polls, an order of magnitude past the window — and the
  // elapsed count must remain irrelevant while something is executing.
  const running: Reading = [{ name: "ci", status: "IN_PROGRESS" }];
  const history = Array.from({ length: STALL_WINDOW * 15 }, () => running);
  assert.equal(
    checkWaitStalled(history).stalled,
    false,
    "no number of identical readings concludes stalled while a check is genuinely running",
  );
});

test("BEHAVIORAL: the real waitForCiGreen waits through a long-running ci and returns green", async () => {
  // The integration, not just the predicate. Before this change, a `ci` reported IN_PROGRESS for
  // STALL_WINDOW consecutive polls returned "timeout" — this drives that exact sequence and
  // requires "green" instead. The fake counts its own invocations, so the run genuinely crosses
  // the old bound (STALL_WINDOW identical readings) before `ci` resolves.
  const fakeBinDir = mkdtempSync(join(tmpdir(), "wait-ci-green-running-bin-"));
  // W1-T2268: `waitForCiGreen` now reads REST (`gh api …`), never `gh pr view` — one poll
  // iteration is now a PR-row read (the poll counter, incremented here) plus the two
  // `rollupFor` reads (check-runs, combined-status), which consult the SAME counter without
  // advancing it so all three reads in one iteration agree on running-vs-green.
  const counter = join(fakeBinDir, "calls");
  writeFileSync(
    join(fakeBinDir, "gh"),
    [
      "#!/bin/bash",
      `if [[ "$1" == "api" ]]; then`,
      '  case "$2" in',
      "    */pulls/*)",
      `      n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "      n=$((n+1))",
      `      echo "$n" > ${counter}`,
      '      echo \'{"number":1,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}\'',
      "      exit 0 ;;",
      "    */check-runs*)",
      `      n=$(cat ${counter} 2>/dev/null || echo 0)`,
      // Well past STALL_WINDOW identical polls, then green.
      `      if (( n > ${STALL_WINDOW * 3} )); then`,
      '        echo \'{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}\'',
      "      else",
      '        echo \'{"check_runs":[{"name":"ci","status":"in_progress"}]}\'',
      "      fi",
      "      exit 0 ;;",
      '    */status) echo \'{"statuses":[]}\'; exit 0 ;;',
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBinDir, "gh"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  try {
    const outcome = await waitForCiGreen(
      "https://github.com/acme/remudero/pull/1",
      (step, extra) => logs.push({ step, extra }),
      0,
    );
    assert.equal(outcome, "green", "a long-running ci that eventually succeeds must return green, never timeout");
    assert.equal(
      logs.find((l) => l.step === "ci.stalled"),
      undefined,
      "and it must never have logged ci.stalled on the way",
    );
    // PROVES THE FIXTURE REACHED THE PREDICATE rather than resolving before it mattered: the
    // recorded poll count must exceed STALL_WINDOW, so `checkWaitStalled` was called with a full
    // window of byte-identical readings and declined to stall. Without this, a fixture that went
    // green on its first poll would pass this test having exercised nothing.
    const polls = Number(readFileSync(counter, "utf8").trim());
    assert.ok(
      polls > STALL_WINDOW,
      `the wait must poll past the old bound to reach the predicate — polled ${polls}, window ${STALL_WINDOW}`,
    );
    assert.ok(logs.filter((l) => l.step === "ci.polling").length > 0, "the wait must actually have polled");
  } finally {
    process.env.PATH = savedPath;
  }
});
