import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DAEMON_EXIT_BLOCKED,
  DAEMON_EXIT_ENVIRONMENTAL,
  DAEMON_EXIT_STALE,
  PER_TASK_FAILURE_RE,
  daemonExitCode,
  daemonExitCodeForSummary,
} from "../src/lib/daemon.js";

// ── W1-T3319 — ONE TASK'S FAILURE IS NOT THE DAEMON'S CRASH ───────────────────────────────────
//
// The operator's 2026-09-10 ruling applied to the daemon itself: get the work through, do not stop.
// MEASURED, five error stops on the live fleet host taking RestartCount to 4 of 5 — four pre-push
// refusals and one failed GitHub check-runs read. W1-T3310 caught the first shape by its banner and
// was blind to the second. This keys on WHOSE failure it is instead.

/** The five real stop details, verbatim from the fleet host's own drain summaries. */
const MEASURED_STOPS = [
  "W1-T3226: Command failed: git -C /home/node/Remudero/worktrees/run-W1-T3226-1788951619963 push origin HEAD",
  "W1-T3242: Command failed: git -C /home/node/Remudero/worktrees/run-W1-T3242-1788990448483 push origin HEAD",
  "W1-T3274: Command failed: git -C /home/node/Remudero/worktrees/run-W1-T3274-1789006306269 push origin HEAD",
  "W1-T3274: Command failed: git -C /home/node/Remudero/worktrees/run-W1-T3274-1789010504658 push origin HEAD",
  "W1-T3290: Command failed: gh api repos/craigoley/remudero/commits/05e5077/check-runs?per_page=100",
];

test("W1-T3319: every one of the five measured crashes now routes to blocked, including the one the banner rule could not see", () => {
  for (const detail of MEASURED_STOPS) {
    assert.equal(
      daemonExitCodeForSummary({ stopReason: "error", stopDetail: detail }),
      DAEMON_EXIT_BLOCKED,
      `still a crash: ${detail.slice(0, 70)}`,
    );
  }
  // THE FIFTH IS THE POINT. It carries no pre-push banner, so W1-T3310's rule left it at 1 — and it
  // was the very next crash after that fix shipped.
  const ghStop = MEASURED_STOPS[4] as string;
  assert.ok(!/pre-push REFUSED/.test(ghStop), "fixture drifted: the gh stop must carry no banner");
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: ghStop }), DAEMON_EXIT_BLOCKED);
});

test("W1-T3319: a detail that names no task still exits 1, so docker's crash budget still means something", () => {
  // THE FAIL-CLOSED ARM. Without it this change deletes the crash budget rather than bounding it,
  // and a genuinely broken daemon spins quietly forever.
  for (const detail of [
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "FATAL: JavaScript heap out of memory",
    "Command failed: git push origin HEAD", // names no task
    "error: something went wrong",
    "",
    // AND THE HALF W1-T2546 FORCED: a task-prefixed IN-PROCESS error is rmd's own defect, not the
    // task's. It will recur on every task, which is the regression a stop still exists for.
    "W1-T1: TypeError: Cannot read properties of undefined (reading 'id')",
    "W1-T2: AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
    "W1-T3: SyntaxError: Unexpected end of input",
  ]) {
    assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: detail }), 1, detail.slice(0, 50));
  }
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: undefined }), 1);
});

test("W1-T3319: environmental keeps precedence, so a task failure caused by a network fault is still 77", () => {
  // ORDER: the remedy differs. 77 waits; 76 re-dispatches on the poll interval.
  const rateLimited = "W1-T3290: Command failed: gh api ...\nremote: You have exceeded a secondary rate limit";
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: rateLimited }), DAEMON_EXIT_ENVIRONMENTAL);
});

test("W1-T3319: the stale, blocked and environmental mappings are unchanged, so this is additive", () => {
  assert.equal(daemonExitCode("stopped"), 0);
  assert.equal(daemonExitCode("max_reached"), 0);
  assert.equal(daemonExitCode("stale"), DAEMON_EXIT_STALE);
  assert.equal(daemonExitCode("blocked"), DAEMON_EXIT_BLOCKED);
  assert.equal(daemonExitCode("error"), 1);
  assert.equal(daemonExitCodeForSummary({ stopReason: "stale" }), DAEMON_EXIT_STALE);
  assert.equal(daemonExitCodeForSummary({ stopReason: "blocked" }), DAEMON_EXIT_BLOCKED);
});

// @source-text-subject — the census's own remedy (2). This suite's SUBJECT is drain.ts's text: it
// counts the `summary("error", …)` call sites and asserts every one leads with a task id, so a
// third site that does not is caught here rather than silently classifying a real crash as blocked.
// Importing the symbol cannot answer "how many call sites are there and do all of them conform".
test("W1-T3319: the discriminator matches the shape drain.ts really emits — asserted against drain.ts itself", () => {
  // THE CLAIM THIS WHOLE CHANGE RESTS ON: both `summary("error", ...)` sites build their detail as
  // `${taskId}: ${message}`. If a third site is added that does NOT, this fails here rather than
  // silently classifying a real crash as blocked.
  const drain = readFileSync(new URL("../src/lib/drain.ts", import.meta.url), "utf8");
  const errorSites = [...drain.matchAll(/summary\("error",\s*`([^`]*)`/g)].map((m) => m[1] ?? "");
  assert.equal(errorSites.length, 2, `drain.ts's error sites changed: ${JSON.stringify(errorSites)}`);
  for (const tpl of errorSites) {
    assert.match(tpl, /^\$\{\w+(?:\.\w+)*\}: /, `an error detail that does not lead with a task id: ${tpl}`);
  }
});

test("W1-T3319: the pattern is driven DIRECTLY, both arms — where it matches and where it stops", () => {
  // negative-reachability-ratchet: a regex surface asserted only through a caller proves nothing
  // about where it STOPS, and stopping is what keeps a real crash countable.
  for (const matching of [
    "W1-T3274: Command failed: git push",
    "W1-T9: Command failed: anything the spawn reported",
    "W12-T3a: Command failed: alphanumeric task suffixes are legal",
  ]) {
    assert.equal(PER_TASK_FAILURE_RE.test(matching), true, `expected a match: ${JSON.stringify(matching)}`);
  }
  for (const stopping of [
    "TypeError: undefined is not a function",
    " W1-T9: a leading space breaks the anchor",
    "see W1-T9: mid-string is not the emitter's shape",
    "W1-T9 no colon",
    "W1-T9:Command failed: no space after the colon", // the emitter writes `${taskId}: `
    "error: NOT anything-with-a-colon",
    "W1-T9: TypeError: rmd's own defect, not the task's",
    "",
  ]) {
    assert.equal(PER_TASK_FAILURE_RE.test(stopping), false, `expected NO match: ${JSON.stringify(stopping)}`);
  }
});
