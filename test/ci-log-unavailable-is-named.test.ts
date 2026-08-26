// test/ci-log-unavailable-is-named.test.ts — a denied CI-log read must be
// DISTINGUISHABLE from a clean job.
//
// THE DEFECT. `fetchCiFailures` (src/run-task.ts) wraps its `gh run view --job <id> --log-failed`
// call in a catch commented "best-effort — degrades to an empty tail, never throws" and returns
// `logTail: ""`. That is the correct FAILURE POLICY and this suite does not change it. What it
// changes is that the empty tail used to carry NO record that a read was attempted and failed —
// so a denied read, a job that reported no Actions job id, and a check that genuinely printed
// nothing were all byte-identical downstream, and a fix worker handed a denial behaved exactly
// as if nothing had failed.
//
// THE COST, measured on this repo: every row in `DEFAULT_FIX_CLASSES`
// (`ci-gate-required-check-timeout`, `coverage-ratchet-stale-floor`, `capability-snapshot-stale`)
// matches by running a REGEX OVER `logTail`. An empty tail satisfies none of them, so an
// unexplained empty tail silently disabled the entire auto-resolve table — no row could ever fire,
// and nothing anywhere said why.
//
// WHAT THIS SUITE PINS. Both directions, on all three surfaces (producer, fix prompt, escalation
// body): a denial can never render as silence, and silence can never render as a denial. The
// negative assertions are the load-bearing half — a change that made every empty tail say
// "log NOT read" would pass the positive assertions alone while reintroducing the same
// indistinguishability in the opposite direction.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchCiFailures, renderFixPrompt } from "../src/run-task.js";
import {
  CI_LOG_FENCE_CLOSE,
  CI_LOG_FENCE_OPEN,
} from "../src/lib/fix-fence.js";
import {
  describeCiLogUnavailable,
  renderClarificationQuestion,
  type CiFailure,
  type OpenPrView,
} from "../src/lib/sweep.js";

const JOB_URL = "https://github.com/craigoley/remudero/actions/runs/1/job/97999587744";

/** Put a fake `gh` first on PATH for one call, so the producer's REAL `execFileSync` path runs
 *  (never a stubbed dep) — the denial has to be observed through the same catch production uses. */
function withFakeGh<T>(body: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  const prior = process.env.PATH;
  process.env.PATH = `${dir}:${prior ?? ""}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

function failingRollup(detailsUrl?: string) {
  return [{ name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-13T13:48:42Z", detailsUrl }];
}

function one(rollup: ReturnType<typeof failingRollup>): CiFailure {
  const failures = fetchCiFailures("craigoley", "remudero", rollup);
  assert.equal(failures.length, 1, "fixture must produce exactly one failing check");
  return failures[0];
}

// ── the producer: three ways to get an empty tail, three DIFFERENT names ───────────────────────

test("a log fetch that FAILS yields an empty tail that names the failure, and carries the underlying error", () => {
  const f = withFakeGh('echo "denied by proxy" >&2; exit 1', () => one(failingRollup(JOB_URL)));

  assert.equal(f.logTail, "", "the failure policy is unchanged: still an empty tail");
  assert.equal(f.logUnavailable?.kind, "fetch-failed", "but the empty tail now says WHY");
  assert.ok(
    f.logUnavailable?.kind === "fetch-failed" && f.logUnavailable.detail.length > 0,
    "the underlying error is carried, not discarded — this is the detail nobody had",
  );
});

test("a log fetch that SUCCEEDS with output carries a real tail and NAMES NOTHING — silence is never invented", () => {
  const f = withFakeGh('echo "AssertionError: expected 3 to equal 4"', () => one(failingRollup(JOB_URL)));

  assert.match(f.logTail, /AssertionError/, "the real tail is captured exactly as before");
  assert.equal(
    f.logUnavailable,
    undefined,
    "a successful read must leave the cause ABSENT — otherwise `logUnavailable !== undefined` " +
      "would stop being a sound test for 'the log could not be read'",
  );
});

test("a log fetch that SUCCEEDS but prints NOTHING is named as a quiet job, never as a failed read", () => {
  const f = withFakeGh("exit 0", () => one(failingRollup(JOB_URL)));

  assert.equal(f.logTail.trim(), "");
  assert.equal(f.logUnavailable?.kind, "empty-log", "the one case where an empty tail is honest");
  assert.notEqual(f.logUnavailable?.kind, "fetch-failed", "silence must not be reported as a denial");
});

test("a check with no Actions job id is named as never-attempted, never as a failed read", () => {
  const f = one(failingRollup(undefined));

  assert.equal(f.logUnavailable?.kind, "no-job-id");
  assert.notEqual(f.logUnavailable?.kind, "fetch-failed", "no read was attempted — saying one failed would be false");
});

test("the fetch is STILL best-effort: a failing log read never throws out of the producer", () => {
  assert.doesNotThrow(() => {
    withFakeGh("exit 42", () => fetchCiFailures("craigoley", "remudero", failingRollup(JOB_URL)));
  }, "a log read failing must never take down the fix attempt that needed it");
});

test("the three causes render as three DIFFERENT sentences — a shared renderer, so the two consumers cannot drift", () => {
  const rendered = [
    describeCiLogUnavailable({ kind: "no-job-id" }),
    describeCiLogUnavailable({ kind: "fetch-failed", detail: "ENOBUFS" }),
    describeCiLogUnavailable({ kind: "empty-log" }),
  ];
  assert.equal(new Set(rendered).size, 3, "each cause must be distinguishable from the other two");
  assert.match(rendered[1], /ENOBUFS/, "the observed detail reaches the reader verbatim");
  // The quiet-job branch is the ONE that must not claim a read failed.
  assert.doesNotMatch(rendered[2], /NOT read|FAILED/, "a job that printed nothing did not fail to be read");
});

// ── surface 1: the fix prompt the worker actually receives ─────────────────────────────────────

function ciLogPrompt(failure: CiFailure): string {
  return renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { ciFailures: [failure] },
  });
}

test("fix prompt: a denied read and a captured log render DIFFERENTLY", () => {
  const denied = ciLogPrompt(withFakeGh("exit 1", () => one(failingRollup(JOB_URL))));
  const captured = ciLogPrompt(withFakeGh('echo "expected 3 to equal 4"', () => one(failingRollup(JOB_URL))));

  assert.notEqual(denied, captured, "if these were equal the worker could not tell the two apart at all");
});

test("fix prompt: a DENIAL cannot render as silence — it says the log was not read, and offers no empty log tail to read as 'nothing failed'", () => {
  const prompt = ciLogPrompt(withFakeGh("exit 1", () => one(failingRollup(JOB_URL))));

  assert.match(prompt, /log NOT read/, "the worker is told the log could not be read");
  assert.match(prompt, /CANNOT SEE WHY THIS FAILED/, "and told what that means for its own confidence");
  assert.ok(
    !prompt.includes("log tail:"),
    "an EMPTY `log tail:` is exactly the rendering that reads as 'this check printed nothing' — " +
      "the denial branch must replace that line, not sit beside it",
  );
});

test("fix prompt: SILENCE cannot render as a denial — a captured log carries no unavailability wording at all", () => {
  const prompt = ciLogPrompt(withFakeGh('echo "expected 3 to equal 4"', () => one(failingRollup(JOB_URL))));

  assert.match(prompt, /log tail:/, "a real tail is still rendered under its own label, exactly as before");
  assert.match(prompt, /expected 3 to equal 4/);
  assert.doesNotMatch(prompt, /log NOT read/, "nothing failed to be read here");
  assert.doesNotMatch(prompt, /CANNOT SEE WHY THIS FAILED/, "the worker CAN see why — telling it otherwise would be its own defect");
});

test("fix prompt: the unavailability sentence stays INSIDE the untrusted-output fence, beside the attacker-influenceable check name", () => {
  const prompt = ciLogPrompt(withFakeGh("exit 1", () => one(failingRollup(JOB_URL))));

  const openIdx = prompt.indexOf(CI_LOG_FENCE_OPEN);
  const closeIdx = prompt.indexOf(CI_LOG_FENCE_CLOSE);
  const causeIdx = prompt.indexOf("log NOT read");
  assert.ok(openIdx >= 0 && closeIdx > openIdx, "the fence is still rendered");
  assert.ok(causeIdx > openIdx && causeIdx < closeIdx, "the cause must not be spliced bare into instruction context");
});

// ── surface 2: the escalation body a human reads ───────────────────────────────────────────────

function escalationText(failure: CiFailure): string {
  const view: OpenPrView = {
    prNumber: 13,
    prUrl: "url/13",
    taskId: "W1-TX",
    reviewState: "failure",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 2,
    lastActivityAt: "2026-08-13T13:48:42Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ciFailures: [failure],
  };
  return JSON.stringify(renderClarificationQuestion(view, "strikes exhausted — escalating", []));
}

test("escalation body: a DENIAL says the log was not read, in the same sentence that names the check", () => {
  const body = escalationText(withFakeGh("exit 1", () => one(failingRollup(JOB_URL))));

  assert.match(body, /ci-gate failed on/, "the check is still named exactly as before");
  assert.match(body, /log NOT read/, "and the reader is told the reason was never obtained");
});

test("escalation body: a CAPTURED log adds no unavailability wording — the escalation is unchanged when the read worked", () => {
  const body = escalationText(withFakeGh('echo "expected 3 to equal 4"', () => one(failingRollup(JOB_URL))));

  assert.match(body, /ci-gate failed on/);
  assert.doesNotMatch(body, /log NOT read/, "nothing failed to be read");
  assert.doesNotMatch(body, /printed no failing output/, "and the job was not quiet either");
});

// ── the cost this restores sight to (NOT changed by this suite, only witnessed) ────────────────

test("the auto-resolve table is regex-over-logTail, so an empty tail matches NO row — the cost an unexplained empty tail hid", async () => {
  const { DEFAULT_FIX_CLASSES } = await import("../src/lib/sweep.js");
  const denied = withFakeGh("exit 1", () => one(failingRollup(JOB_URL)));
  const view = { ciFailures: [{ ...denied, name: "ci-gate" }] } as unknown as OpenPrView;

  const matched = DEFAULT_FIX_CLASSES.filter((c) => c.matchesFailure(view));
  assert.equal(matched.length, 0, "no class can fire on an empty tail — this is the disabling, witnessed");
  assert.ok(DEFAULT_FIX_CLASSES.length >= 3, "and it disables the WHOLE table, not one row");
});
