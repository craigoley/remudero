import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bodyContradictsDiff } from "../src/lib/review.js";

// ── recon-GK: the implementation review must judge the PR BODY, not the worker's chat text ──
//
// #1156 — the FIRST task PR the autonomous loop produced end to end — failed review with
// `body contradicts its own diff: claimed "plan-only"`. Its 7,528-byte body contains ZERO
// occurrences of that phrase. The checker was right; it was handed the wrong document:
// `runTask` passed `fullText(impl)`, the worker's running narrative, which naturally says
// "plan-only" while DESCRIBING the job.
//
// HONESTY ABOUT WHAT THIS FILE CAN AND CANNOT DO. The first test is a SOURCE-LEVEL pin, which is
// the weak instrument class recon-GI measured: it asserts the call site's shape, not its runtime
// behaviour. Driving `runTask` to that line requires a real worker spawn, so an executing test is
// not available here. The second and third tests DO execute real code.

const SRC = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("recon-GK: the implementation review is fed the PR BODY, never the worker's chat text", () => {
  // The window between the CI-green gate and the runReview call — the site recon-GK identified.
  const at = SRC.indexOf("let review = await runReviewFn({");
  assert.notEqual(at, -1, "the implementation review call site must still exist");
  const window = SRC.slice(at, at + 400);

  assert.doesNotMatch(
    window,
    /report:\s*fullText\(impl\)/,
    "the review must NOT judge the worker's narrative — that is the #1156 defect",
  );
  assert.match(window, /report:\s*reviewReport/, "it must judge the fetched PR body");
  // And the fetch must actually be wired, not merely declared.
  assert.match(SRC, /const fetchPrBodyFn = opts\.fetchPrBody \?\? fetchPrBodyViaGh;/,
    "the body reader must resolve to the real gh read by default");
  assert.match(SRC, /reviewReport = await fetchPrBodyFn\(prUrl\)/,
    "and must actually be called with this PR's url");
});

test("recon-GK: a failed body read falls back to the worker text rather than blocking review", () => {
  // The degradation contract, asserted on the source because the surrounding function needs a
  // spawn: a throwing fetcher must be caught and ledgered, never propagate.
  const at = SRC.indexOf("reviewReport = await fetchPrBodyFn(prUrl)");
  assert.notEqual(at, -1);
  // Widened +300 -> +500 on 2026-08-25: the catch arm gained a cause assignment and the comment
  // explaining it, which pushed `review.body_fetch_error` to 348 chars past the fetch. The
  // CONTRACT below is unchanged -- a failed read is still caught and still ledgered.
  const window = SRC.slice(at - 200, at + 500);
  assert.match(window, /let reviewReport = fullText\(impl\)/, "the fallback value is the worker text");
  assert.match(window, /catch/, "a failed read is caught");
  assert.match(window, /review\.body_fetch_error/, "and is ledgered rather than silent");
});

test("recon-GK REGRESSION: the checker itself is innocent — #1156's real body yields NO contradiction", () => {
  // EXECUTING evidence, not a source pin. This is the reproduction that proved the diagnosis:
  // given the actual body and actual changed files, bodyContradictsDiff emits nothing. Any future
  // change that makes this body contradict would be a real regression in the checker.
  const body = [
    "## Summary",
    "Ports the daemon's bounded-degraded ceiling to the drain, which had the opposite polarity.",
    "Round-1 review found one unmet criterion: the drain's constant was only equal to the",
    "daemon's by coincidence (two independent `= 3` literals), not truly shared.",
    "This push fixes that by having src/lib/daemon.ts import the same headroom.ts export.",
  ].join("\n");
  const files = [
    "src/lib/daemon.ts", "src/lib/drain.ts", "src/lib/headroom.ts",
    "src/run-task.ts", "test/drain-unreadable-degraded.test.ts", "test/drain.test.ts",
  ];
  assert.deepEqual(bodyContradictsDiff(body, files), [], "an honest body must produce no verdict");

  // FALSIFIER for the checker: the same file list WITH the phrase must still be caught, so this
  // test cannot pass by the checker having been weakened.
  const lying = body + "\nThis change is plan-only.";
  const caught = bodyContradictsDiff(lying, files);
  assert.equal(caught.length, 1, "a genuine plan-only lie over src/ files must still be rejected");
  assert.equal(caught[0].claim, "plan-only");
});
