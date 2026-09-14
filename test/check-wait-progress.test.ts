// W1-T382: the worker's check-wait bound used to be an ITERATION COUNT — `waitForCiGreen`
// and `pollToGate` (src/run-task.ts) both gave up after a fixed `maxIters`, regardless of
// whether checks were still moving. Recon measured 21 of 21 PRs this repo ever booked as a
// check-wait timeout LATER MERGING (0 closed unmerged): the bound had a 100% false-positive
// rate. `checkWaitStalled` replaces it with a DERIVATIVE — stop only when the rollup shows
// no forward motion across `STALL_WINDOW` consecutive polls — never on elapsed polls.
//
// This file is deliberately separate from test/run-task.test.ts: that file intermittently
// crashes at FILE level under `--experimental-test-coverage`, which would make a
// coverage-load-bearing test for this predicate nondeterministically lose its own coverage.
//
// `checkWaitStalled` is PURE over `RollupEntry[]`-shaped readings — no I/O, no clock, nothing
// spawned — so all three falsifier directions below assert in-process.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkWaitStalled, STALL_WINDOW, waitForCiGreen, ciGateState, ciGateFromRollup } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/** `STALL_WINDOW` identical copies of `reading` — the minimum a real caller would have
 *  accumulated before {@link checkWaitStalled} has enough evidence to conclude stalled. */
function identicalWindow(
  reading: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[],
) {
  return Array.from({ length: STALL_WINDOW }, () => reading);
}

// AMENDED, DELIBERATELY. This assertion originally used a rollup with `ci` IN_PROGRESS and
// asserted it concluded stalled — i.e. it pinned, as correct, exactly the behaviour now
// identified as the defect: a job actively running for its normal duration read as a stall.
// The case it MEANT to cover — the detector bites on an unmoving rollup — is preserved here on
// a QUIESCENT one, which is the population the window was always sound for. The running case
// now has its own falsifier in test/check-wait-running-is-motion.test.ts.
test("BITES: a QUIESCENT rollup unchanged across the stall window concludes stalled and names which checks were pending", () => {
  const pending = [
    { name: "lint", status: "QUEUED" }, // queued behind a runner that never arrives
    { name: "remudero-review", state: "PENDING" }, // a required status nobody will ever post
  ];
  const result = checkWaitStalled(identicalWindow(pending));
  assert.equal(result.stalled, true, "STALL_WINDOW identical readings with NOTHING running must conclude stalled");
  assert.deepEqual(
    new Set(result.pending),
    new Set(["lint", "remudero-review"]),
    "the stalled verdict names every still-pending check, not just one",
  );
});

test("BITES (W1-T382): fewer than STALL_WINDOW identical readings is never enough evidence to conclude stalled", () => {
  // QUIESCENT on purpose: an IN_PROGRESS rollup here would now return false via the
  // running-check guard, so this would pass with the length guard deleted and prove nothing.
  const pending = [{ name: "lint", status: "QUEUED" }];
  const short = Array.from({ length: STALL_WINDOW - 1 }, () => pending);
  const result = checkWaitStalled(short);
  assert.equal(result.stalled, false, "one poll short of the window must keep waiting");
  assert.deepEqual(result.pending, []);
});

test("HOLDS (W1-T382, the defect reduced): a rollup whose pending set shrinks by one keeps waiting however many polls have elapsed", () => {
  // Simulates the shape of all 21 historically-false-blocked PRs: `ci` resolves partway
  // through a long run of otherwise-identical polls. Many more than STALL_WINDOW readings
  // are accumulated in total; the shrink sits inside the most recent window.
  const stillTwoPending = [{ name: "ci", status: "IN_PROGRESS" }, { name: "lint", status: "QUEUED" }];
  const oneResolved = [{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", status: "QUEUED" }];
  const history = [
    ...Array.from({ length: 20 }, () => stillTwoPending), // 20 identical polls — way past STALL_WINDOW on its own
    oneResolved, // the pending set just shrank by one
    oneResolved,
    oneResolved,
  ];
  const result = checkWaitStalled(history);
  assert.equal(
    result.stalled,
    false,
    "the shrink inside the last STALL_WINDOW readings must keep this waiting, not conclude stalled",
  );
});

test("HOLDS (W1-T382, the defect reduced): a check flipping state keeps waiting however many polls have elapsed", () => {
  const pending = [{ name: "ci", status: "QUEUED" }];
  const inProgress = [{ name: "ci", status: "IN_PROGRESS" }];
  // Every poll differs from the last — real forward motion, never two identical readings in
  // a row — sustained well past STALL_WINDOW polls.
  const history: { name: string; status: string }[][] = [];
  for (let i = 0; i < STALL_WINDOW * 4; i++) {
    history.push(i % 2 === 0 ? pending : inProgress);
  }
  const result = checkWaitStalled(history);
  assert.equal(result.stalled, false, "alternating state every poll is continuous motion, never a stall");
});

test("HOLDS (W1-T382): a required check going red is never reported as merely pending, so the derivative adds no delay on top of the caller's own red short-circuit", () => {
  const pending = [{ name: "ci", status: "IN_PROGRESS" }];
  const wentRed = [{ name: "ci", conclusion: "FAILURE" }];

  // (a) the transition to red is itself a state change — checkWaitStalled reads it as
  // forward motion (not a stall), so nothing here would make a caller wait an extra
  // STALL_WINDOW polls before it could act on the red conclusion it already has.
  const atTransition = [...Array.from({ length: STALL_WINDOW - 1 }, () => pending), wentRed];
  assert.equal(
    checkWaitStalled(atTransition).stalled,
    false,
    "the poll where a check turns red must never be reported as a stall",
  );

  // (b) even if a red conclusion persisted long enough to fill the whole window, the
  // derivative excludes it from `pending` — a red check is a failure, never miscategorized
  // as "still waiting on it".
  const allRed = checkWaitStalled(identicalWindow(wentRed));
  assert.equal(allRed.stalled, true, "a persisted rollup is still a stall by the pure signature comparison");
  assert.deepEqual(allRed.pending, [], "a red check must never be named in `pending` — it already failed, it is not waiting");
});

// The three tests above cover `checkWaitStalled` PURELY, but W1-T382 also rewired its TWO
// real callers (`pollToGate`/`waitForCiGreen` in src/run-task.ts) to accumulate readings
// and act on the derivative INSTEAD of a `maxIters` bound. `waitForCiGreen` is the exported
// one of the two (`pollToGate` is only reachable through a full `runTask` run, covered
// separately in test/run-task.test.ts), so this drives it for real — a PATH-stubbed `gh`
// answering the identical pending rollup on every poll, `everySec: 0` so the loop's own
// `execFileSync("sleep", ...)` calls cost nothing — to prove the integration itself (the
// readings array, the `checkWaitStalled` call, and the `stalled` branch's `"timeout"`
// return + `ci.stalled` log line) actually executes, not just the pure predicate it calls.
// AMENDED (W1-T3584): this assertion originally named `remudero-review` alongside `lint` in the
// stalled `pending` evidence. That was itself the shape of the defect this task exists to fix —
// `remudero-review` is this rung's OWN judge, not yet given a chance to run, and was never a real
// CI dependency to report as stalled. `waitForCiGreen` now feeds `checkWaitStalled` the SAME
// pre-review view `ciGateFromRollup` judges from (`ciGatePreReviewView`), which excludes
// `remudero-review` unconditionally — so only `lint`, the genuinely still-pending check, remains.
test("BEHAVIORAL (W1-T382): the real waitForCiGreen stalls on an unmoving rollup and returns timeout, logging which check(s) were still pending", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "wait-ci-green-stall-bin-"));
  writeFileSync(
    join(fakeBinDir, "gh"),
    [
      "#!/bin/bash",
      // W1-T2268: `waitForCiGreen` now reads REST (`gh api …`), never `gh pr view`. The PR row's
      // head sha is fixed, so the two check endpoints below answer the SAME rollup every poll —
      // QUIESCENT, and it must stay that way: with any check IN_PROGRESS this fake answers the
      // same running rollup forever, and the wait would (correctly, now) never give up — an
      // infinite loop in the suite rather than a failing assertion.
      'if [[ "$1" == "api" ]]; then',
      '  case "$2" in',
      '    */pulls/*) echo \'{"number":1,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}\'; exit 0 ;;',
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"lint\",\"status\":\"queued\"}]}'; exit 0 ;;",
      "    */status) echo '{\"statuses\":[{\"context\":\"remudero-review\",\"state\":\"pending\"}]}'; exit 0 ;;",
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
    assert.equal(ciGateState(outcome), "timeout", "an unmoving rollup must conclude timeout via the stall derivative");
    const stalledLog = logs.find((l) => l.step === "ci.stalled");
    assert.ok(stalledLog, "the stalled branch must log ci.stalled, not just return silently");
    assert.deepEqual(
      new Set(stalledLog?.extra?.pending as string[]),
      new Set(["lint"]),
      "the timeout names the genuinely still-pending check, but never remudero-review — this " +
        "rung's own not-yet-run judge is excluded from CI-stall evidence unconditionally (W1-T3584)",
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

// ── W1-T3584 (the console PR #22 false ci.stalled/fix.ci_not_green strikes): the shared
// `ci` gate required a rollup entry literally NAMED `ci` to ever return green, so a target whose
// branch protection names its own checks (console-ci, ci-gate, Vercel, …) could never release the
// gate no matter how healthy those checks were — and a pending `remudero-review` sitting beside
// them got read as a stalled CI dependency. `ciGateFromRollup`/`ciGatePreReviewView` now derive
// BOTH verdicts from the target's own required-context set when it is readable, falling back to
// the unchanged `ci`-named-check rule only when it is not. ──

test("W1-T3584 target required checks release pre-review gate: when a target's readable required pre-review contexts are all successful and remudero-review is pending, the shared CI gate returns green even if no context is named ci", () => {
  const rollup = [
    { name: "console-ci", conclusion: "SUCCESS" },
    { name: "ci-gate", conclusion: "SUCCESS" },
    { context: "Vercel", state: "SUCCESS" },
    { context: "remudero-review", state: "PENDING" },
  ];
  const required = ["console-ci", "ci-gate", "Vercel", "remudero-review"];
  assert.equal(
    ciGateFromRollup(rollup, required),
    "green",
    "every required NON-REVIEW context is a success — no entry is literally named `ci`",
  );
});

test("W1-T3584 target required checks release pre-review gate: SKIPPED/NEUTRAL required contexts (GitHub's own merge-eligibility ok-set) still release green, not just SUCCESS", () => {
  const rollup = [
    { name: "console-ci", conclusion: "SUCCESS" },
    { name: "ci-gate", conclusion: "NEUTRAL" },
    { context: "Vercel", state: "SKIPPED" },
  ];
  const required = ["console-ci", "ci-gate", "Vercel"];
  assert.equal(ciGateFromRollup(rollup, required), "green");
});

test("W1-T3584 target required checks release pre-review gate: a required context reporting a current terminal-red conclusion still gates red, scoped to the required set", () => {
  const rollup = [
    { name: "console-ci", conclusion: "SUCCESS" },
    { name: "ci-gate", conclusion: "FAILURE" },
    { context: "Vercel", state: "SUCCESS" },
  ];
  const required = ["console-ci", "ci-gate", "Vercel"];
  assert.equal(ciGateFromRollup(rollup, required), "red");
});

test("W1-T3584 target required checks release pre-review gate: a NON-required check going red never gates red once the required set is known — only the required contexts vote", () => {
  const rollup = [
    { name: "console-ci", conclusion: "SUCCESS" },
    { name: "ci-gate", conclusion: "SUCCESS" },
    { context: "Vercel", state: "SUCCESS" },
    { name: "unrelated-advisory-check", conclusion: "FAILURE" },
  ];
  const required = ["console-ci", "ci-gate", "Vercel"];
  assert.equal(ciGateFromRollup(rollup, required), "green");
});

test("W1-T3584 absent target gate stays fail closed: a missing, unreadable, empty, queued, cancelled, or terminal-red required context cannot manufacture green; the existing ci-only fallback remains fail-closed", () => {
  const consoleShaped = [
    { name: "console-ci", conclusion: "SUCCESS" },
    { name: "ci-gate", conclusion: "SUCCESS" },
    { context: "Vercel", state: "SUCCESS" },
  ];
  // (a) no requiredContexts argument at all (the pre-W1-T3584 call shape) — unreadable/absent.
  assert.equal(
    ciGateFromRollup(consoleShaped),
    "pending",
    "with no required-context list, the console-shaped rollup stays pending — no context named `ci`",
  );
  // (b) an explicitly EMPTY required-context list reads identically to absent.
  assert.equal(ciGateFromRollup(consoleShaped, []), "pending");
  // (c) a required context that has not yet registered on this head at all (absent from the
  // rollup entirely) must not be treated as satisfied.
  assert.equal(
    ciGateFromRollup([{ name: "console-ci", conclusion: "SUCCESS" }], ["console-ci", "ci-gate"]),
    "pending",
    "a required context absent from the rollup entirely is neither green nor red — still pending",
  );
  // (d) a required context still QUEUED keeps the gate pending, never green.
  assert.equal(
    ciGateFromRollup(
      [
        { name: "console-ci", conclusion: "SUCCESS" },
        { name: "ci-gate", status: "QUEUED" },
      ],
      ["console-ci", "ci-gate"],
    ),
    "pending",
  );
  // (e) a required context whose latest attempt is CANCELLED is a VOID verdict, not a bad one
  // (W1-T2274/NO_VERDICT_CONCLUSIONS) — still pending, never red and never green.
  assert.equal(
    ciGateFromRollup(
      [
        { name: "console-ci", conclusion: "SUCCESS" },
        { name: "ci-gate", conclusion: "CANCELLED" },
      ],
      ["console-ci", "ci-gate"],
    ),
    "pending",
  );
  // (f) the unchanged ci-only fallback: no `ci`-named entry at all, unreadable required contexts —
  // stays pending, exactly as it did before this task, never a false green from an unrelated
  // successful check.
  assert.equal(
    ciGateFromRollup([{ name: "lint", conclusion: "SUCCESS" }]),
    "pending",
    "a healthy but non-`ci`-named check, with no required-context list, must never manufacture green",
  );
  // (g) the fallback's RED direction is unchanged too: any reported terminal-red entry still
  // vetoes, even though no required-context list narrows the voters.
  assert.equal(
    ciGateFromRollup([
      { name: "ci", conclusion: "SUCCESS" },
      { name: "test", conclusion: "FAILURE" },
    ]),
    "red",
  );
});

test("W1-T3584 console wait ignores pending self review: the real REST-backed wait resolves a console-shaped protection response once, returns green before the stall window, and does not report its pending remudero-review as ci.stalled", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wait-ci-green-console-bin-`));
  writeFileSync(
    join(fakeBinDir, "gh"),
    [
      "#!/bin/bash",
      // W1-T2268: REST only. The head sha is fixed, so both rollup endpoints answer the SAME
      // console-shaped rollup on every poll — console-ci/ci-gate/Vercel SUCCESS, remudero-review
      // still PENDING, exactly the #22 shape this task exists to release.
      'if [[ "$1" == "api" ]]; then',
      '  case "$2" in',
      '    */pulls/*) echo \'{"number":22,"state":"open","merged":false,"merged_at":null,"head":{"sha":"c0ffee"}}\'; exit 0 ;;',
      '    */check-runs*) echo \'{"check_runs":[{"name":"console-ci","status":"completed","conclusion":"success"},{"name":"ci-gate","status":"completed","conclusion":"success"}]}\'; exit 0 ;;',
      '    */status) echo \'{"statuses":[{"context":"Vercel","state":"success"},{"context":"remudero-review","state":"pending"}]}\'; exit 0 ;;',
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBinDir, "gh"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  let requiredContextsCalls = 0;
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  try {
    const outcome = await waitForCiGreen(
      "https://github.com/acme/remudero-console/pull/22",
      (step, extra) => logs.push({ step, extra }),
      0,
      {
        requiredContexts: (owner, repo) => {
          requiredContextsCalls++;
          assert.equal(owner, "acme");
          assert.equal(repo, "remudero-console");
          return ["console-ci", "ci-gate", "Vercel", "remudero-review"];
        },
      },
    );
    assert.equal(
      ciGateState(outcome),
      "green",
      "console-ci/ci-gate/Vercel all SUCCESS must release the gate on the FIRST poll — before STALL_WINDOW is ever reached",
    );
    assert.equal(
      requiredContextsCalls,
      1,
      "the target's required contexts are resolved ONCE per wait, never re-read on every poll",
    );
    assert.ok(
      !logs.some((l) => l.step === "ci.stalled"),
      "a pending remudero-review must never be recorded as a stalled CI dependency (the #22 false-timeout shape)",
    );
  } finally {
    process.env.PATH = savedPath;
  }
});
