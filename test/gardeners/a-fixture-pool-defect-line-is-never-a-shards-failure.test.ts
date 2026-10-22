/**
 * W1-T10171 — 2026-10-19, #12892's coverage-shard (8/8) (job 117963751028): the only real failure was
 * route-wiring's `not ok 2631`, yet ciFailureSignature signed the round "pool defect: test/b.test.ts leaks
 * into test/c.test.ts". Neither file exists: the line is the fixture verdict the PASSING test "W1-T9426: the
 * fast tier hands every locate probe a SIGKILL deadline" printed, once plain and once as a `# pure-test-pool:`
 * TAP diagnostic (log lines 4767-4794). The sweep read the same line on a cancelled shard as a deterministic
 * pool defect and left it un-requeued (#13338, 2026-10-21T12:13:04Z).
 *
 * Pinned here: a POOL DEFECT line counts only when it is the shard runner's own verdict, printed after every
 * test run it streams has ended — never one a test point follows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFailureSignature } from "#src/lib/ci-friction-gardener.js";
import { deterministicTimeoutSignature } from "#src/lib/sweep.js";

const stamp = (i: number) => `2026-10-19T10:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.1234567Z `;

/** The fixture's own pool ladder, as test/a-hung-leak-locate-probe-ends-inside-the-shard-budget.test.ts printed it. */
const FIXTURE_POOL_LINES = [
  "pure-test-pool: pool run complete — 4/4 file(s) reported, # tests 4, # fail 0.",
  "pure-test-pool: the pool of 4 file(s) failed (status 1); re-running them isolated once.",
  "pure-test-pool: rerun run complete — 4/4 file(s) reported, # tests 4, # fail 0.",
  "pure-test-pool: every pooled file passes isolated; locating the leak among 4 file(s) (shard status 0 is already final).",
  "pure-test-pool: locate run complete — 2/2 file(s) reported, # tests 2, # fail 0.",
  "pure-test-pool: locate probe 1: 2 file(s) ending test/b.test.ts -> status 0",
  "pure-test-pool: locate run complete — 3/3 file(s) reported, # tests 3, # fail 0.",
  "pure-test-pool: locate probe 2: 3 file(s) ending test/c.test.ts -> status 1",
  "pure-test-pool: locate run complete — 3/3 file(s) reported, # tests 3, # fail 0.",
  "pure-test-pool: locate probe 3: 3 file(s) ending test/c.test.ts -> status 1",
  "pure-test-pool: locate run complete — 1/1 file(s) reported, # tests 1, # fail 0.",
  "pure-test-pool: locate probe 4: 1 file(s) ending test/c.test.ts -> status 0",
  "pure-test-pool: locate run complete — 2/2 file(s) reported, # tests 2, # fail 0.",
  "pure-test-pool: locate probe 5: 2 file(s) ending test/c.test.ts -> status 0",
  "pure-test-pool: POOL DEFECT — every pooled file passes isolated but the pool failed; leaking file: test/b.test.ts " +
    "(first failing alongside it: test/c.test.ts) after 5 probe(s). Add the leak to the census in scripts/pure-test-pool.mjs.",
];

/** The doubled block inside passing subtests: plain from the pooled run, then echoed as TAP diagnostics. */
const FIXTURE_BLOCK = [
  "# Subtest: W1-T9426: a judged run still going at its deadline is killed and reported past its deadline",
  "ok 1803 - W1-T9426: a judged run still going at its deadline is killed and reported past its deadline",
  "  ---",
  "  duration_ms: 1540.2",
  "  ...",
  "# Subtest: W1-T9426: the fast tier hands every locate probe a SIGKILL deadline",
  ...FIXTURE_POOL_LINES,
  ...FIXTURE_POOL_LINES.map((l) => `# ${l.replace(/#/g, "\\#")}`),
  "ok 1804 - W1-T9426: the fast tier hands every locate probe a SIGKILL deadline",
  "  ---",
  "  duration_ms: 21.7",
  "  ...",
];

const ROUTE_WIRING_NOT_OK = [
  "# Subtest: every declared write route is either wiring-tested here or listed as explicit debt",
  "not ok 2631 - every declared write route is either wiring-tested here or listed as explicit debt",
  "  ---",
  "  duration_ms: 12.4",
  "  type: 'test'",
  "  location: '/home/runner/work/remudero/remudero/test/route-wiring.test.ts:480:1'",
  "  failureType: 'testCodeFailure'",
  "  error: 'POST /api/x is neither wiring-tested nor listed as debt'",
  "  ...",
  "# tests 2632",
  "# pass 2631",
  "# fail 1",
];

const log = (lines: readonly string[]) => lines.map((l, i) => `${stamp(i)}${l}`).join("\n");

test("W1-T10171: a fixture POOL DEFECT line beside a runner not ok signs as the runner failing test", () => {
  const signature = ciFailureSignature(log([...FIXTURE_BLOCK, "ok 1805 - a later passing test", ...ROUTE_WIRING_NOT_OK]));
  assert.equal(signature, "test/route-wiring.test.ts", "the runner's own failing test names the round");
  // Control: the same runner failure with no fixture block signs the same, so the block changed nothing.
  assert.equal(ciFailureSignature(log(ROUTE_WIRING_NOT_OK)), signature);
});

test("W1-T10171: a cancelled shard whose only POOL DEFECT line is test fixture output is re-queued", () => {
  const cancelled = log([
    ...FIXTURE_BLOCK,
    "ok 1805 - a later passing test",
    "The job running on runner GitHub Actions 7 has exceeded the maximum execution time of 35 minutes.",
    "##[error]The operation was canceled.",
  ]);
  assert.equal(deterministicTimeoutSignature(cancelled), undefined, "no deterministic signature, so W1-T1223's one requeue applies");
  assert.doesNotMatch(ciFailureSignature(cancelled) ?? "", /pool (?:defect|failure)/, "the gardener reads it as a timeout, not a pool defect");
});

test("W1-T10171: the runner's own POOL DEFECT verdict, which no test point follows, still names its files", () => {
  // The verdict sits after the runner's last streamed test run; a fixture block earlier in the log changes nothing.
  const real = log([
    ...FIXTURE_BLOCK,
    "not ok 1900 - test/the-victim.test.ts",
    "pure-test-pool: the pool of 40 file(s) failed (status 1); re-running them isolated once.",
    "ok 1901 - test/the-victim.test.ts",
    "pure-test-pool: rerun run complete — 40/40 file(s) reported, # tests 812, # fail 0.",
    "pure-test-pool: every pooled file passes isolated; locating the leak among 40 file(s) (shard status 0 is already final).",
    "pure-test-pool: locate probe 1: 20 file(s) ending test/x.test.ts -> status 1",
    "pure-test-pool: POOL DEFECT — every pooled file passes isolated but the pool failed; leaking file: test/the-leaker.test.ts " +
      "(first failing alongside it: test/the-victim.test.ts) after 6 probe(s).",
    "##[error]The operation was canceled.",
  ]);
  assert.equal(ciFailureSignature(real), "pool defect: test/the-leaker.test.ts leaks into test/the-victim.test.ts");
  assert.equal(deterministicTimeoutSignature(real), "pool defect: test/the-leaker.test.ts leaks");
});
