// W1-T14905: a relint refusal or triage error on unchanged feedback is a failed fire, so the entry backs off.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as triage from "#src/lib/auto-triage.js";

const start = Date.parse("2026-11-25T00:00:00Z");
const at = (minutes: number) => new Date(start + minutes * 60_000);
const refused = (minutes: number, checks: string[] = ["design-invariant-proof"], id = "fb-old") => ({
  step: "triage.relint_refused", task_id: `TRIAGE-${id}`, ts: at(minutes).toISOString(), stop: "exhausted", checks,
});
const errored = (minutes: number, id = "fb-old") => ({
  step: "triage.error", task_id: `TRIAGE-${id}`, ts: at(minutes).toISOString(),
  error: `AMBIGUOUS but files were changed: plan/tasks.d/W1-T${14_000 + minutes}-x.yaml`,
});
const policy = { enabled: true, minIntervalMinutes: 30, maxPerDay: 50 };
const inputs = (now: Date) => ({ policy, deferralPending: true, dispatchCount: 0, laneBudget: 1,
  lockHeld: false, marker: { kind: "absent" as const }, now, candidates: ["fb-old", "fb-next"] });

test("W1-T14905 repeated relint refusals back off", () => {
  for (const n of [1, 2, 3, 6]) {
    const rows = Array.from({ length: n }, (_, i) => refused(i * 40));
    const newest = (n - 1) * 40;
    const retry = newest + 30 * 2 ** n;
    const pending = triage.failedFireBackoff(rows, "fb-old", 30, at(retry - 1));
    assert.equal(pending.failures, n, `${n} refusals count as ${n} failed fires`);
    assert.equal(pending.retryAtMs, at(retry).getTime(), "the pass-over doubles with each refusal");
    assert.equal(pending.backedOff, true);
    assert.equal(triage.failedFireBackoff(rows, "fb-old", 30, at(retry)).backedOff, false);
  }
  const errors = [errored(0), errored(40)];
  assert.equal(triage.failedFireBackoff(errors, "fb-old", 30, at(41)).failures, 2, "a triage.error end counts the same way");
  const backoff = triage.failedFireBackoff([refused(0), refused(40)], "fb-old", 30, at(60));
  const decision = triage.decideAutoTriage({ ...inputs(at(60)), backedOffCandidates: new Map([["fb-old", backoff.retryAtMs!]]) });
  assert.equal(decision.fire && decision.feedbackId, "fb-next", "the backed-off entry yields the head of the queue");
  const thrownFire = [
    { ...errored(0), run_id: "fire-1" }, { ...errored(0), run_id: "fire-1", error: "private status write failed" },
    { step: "auto_triage.run_failed", feedback: "fb-old", ts: at(1).toISOString() },
  ];
  assert.equal(triage.failedFireBackoff(thrownFire, "fb-old", 30, at(2)).failures, 1,
    "multiple triage errors and the daemon's trailing failure are one fire");
  assert.equal(triage.failedFireBackoff([
    { ...errored(0), run_id: "fire-1" },
    { step: "auto_triage.run_failed", feedback: "fb-old", ts: at(3).toISOString() },
  ], "fb-old", 30, at(4)).failures, 2,
  "a later daemon failure without an immediately preceding triage end remains its own fire");
});

test("W1-T14905 edited feedback is retried at the floor interval", () => {
  const rows = [refused(0), refused(40), refused(80)];
  const edited = at(90).toISOString();
  const backoff = triage.failedFireBackoff(rows, "fb-old", 30, at(120), edited);
  assert.equal(backoff.failures, 0, "refusals before the last content commit do not count");
  assert.equal(backoff.backedOff, false, "edited feedback fires again at the floor interval");
  const after = triage.failedFireBackoff([...rows, refused(130)], "fb-old", 30, at(140), edited);
  assert.equal(after.failures, 1, "a refusal after the edit starts a fresh count");
  assert.equal(after.retryAtMs, at(130 + 60).getTime());
  assert.equal(triage.repeatedTriageRefusal(rows, "fb-old", edited), undefined, "an edit clears a repeated run");
});

test("W1-T14905 a repeated refusal check yields the entry once", () => {
  const two = [refused(0), refused(40)];
  assert.equal(triage.repeatedTriageRefusal(two, "fb-old"), undefined, "two refusals are not yet a repeat");
  const three = [...two, refused(80)];
  assert.deepEqual(triage.repeatedTriageRefusal(three, "fb-old"), { check: "design-invariant-proof", since: at(0).toISOString() });
  const noted = [...three, { step: triage.AUTO_TRIAGE_REFUSAL_REPEATED_STEP, task_id: "daemon", feedback: "fb-old",
    check: "design-invariant-proof", ts: at(81).toISOString() }];
  assert.equal(triage.repeatedTriageRefusal(noted, "fb-old"), undefined, "one row per repeated run, not one per pass");
  const mixed = [refused(0), refused(40, ["plan-load"]), refused(80)];
  assert.equal(triage.repeatedTriageRefusal(mixed, "fb-old"), undefined, "three ends with different checks are not one repeat");
  const errors = [errored(0), errored(40), errored(80)];
  assert.deepEqual(triage.repeatedTriageRefusal(errors, "fb-old")?.check, "triage.error:AMBIGUOUS but files were changed",
    "triage errors repeat on their text before the first colon, so changing file names do not hide the repeat");
  const ended = [...three, { step: "verdict", task_id: "TRIAGE-fb-old", ts: at(90).toISOString() }];
  assert.equal(triage.repeatedTriageRefusal(ended, "fb-old"), undefined, "a real triage end clears the run");
  const interleaved = [refused(0), refused(40),
    { step: "pr.opened", task_id: "TRIAGE-fb-other", ts: at(60).toISOString() }, refused(80)];
  assert.deepEqual(triage.repeatedTriageRefusal(interleaved, "fb-old")?.check, "design-invariant-proof",
    "another entry's success between refusals does not break this entry's streak");
  assert.equal(triage.repeatedTriageRefusal([...three, refused(120, ["x"], "fb-other")], "fb-other"), undefined);
  assert.ok(triage.AUTO_TRIAGE_FAILURE_STEPS.includes(triage.AUTO_TRIAGE_REFUSAL_REPEATED_STEP),
    "the refusal history the daemon reads carries the repeated row, so it is written once");
  const privateFailure = (minutes: number, runId: string, error: string) => ({
    ...errored(minutes), run_id: runId, error,
  });
  const multiRowFires = [0, 40, 80].flatMap((m, i) => [
    privateFailure(m, `fire-${i}`, "private feedback status write failed"),
    privateFailure(m, `fire-${i}`, "public task write failed or unknown"),
  ]);
  assert.deepEqual(triage.repeatedTriageRefusal(multiRowFires, "fb-old")?.check,
    "triage.error:private feedback status write failed,triage.error:public task write failed or unknown",
    "multiple terminal error rows from each fire form one stable repeated check");
  const nine = Array.from({ length: 9 }, (_, i) => refused(i * 40));
  const namedOnce = [...nine, { step: triage.AUTO_TRIAGE_REFUSAL_REPEATED_STEP, feedback: "fb-old",
    check: "design-invariant-proof", ts: at(321).toISOString() },
    { step: "pr.opened", task_id: "TRIAGE-fb-other", ts: at(322).toISOString() },
    refused(360), refused(400), refused(440)];
  assert.equal(triage.repeatedTriageRefusal(namedOnce, "fb-old"), undefined,
    "an unrelated success cannot restart an already named streak");
});
