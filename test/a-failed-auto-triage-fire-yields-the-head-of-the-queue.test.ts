import assert from "node:assert/strict";
import { test } from "node:test";
import * as triage from "#src/lib/auto-triage.js";
import { WorktreePointerRefusedError } from "#src/lib/worktree-git.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const start = Date.parse("2026-10-16T00:00:00Z");
const at = (minutes: number) => new Date(start + minutes * 60_000);
const failure = (minutes: number, id = "fb-old") => ({
  step: "auto_triage.run_failed", feedback: id, ts: at(minutes).toISOString(),
});
const end = (step: string, minutes: number, id = "fb-old") => ({
  step, task_id: `TRIAGE-${id}`, ts: at(minutes).toISOString(),
});
const policy = { enabled: true, minIntervalMinutes: 60, maxPerDay: 50 };

test("W1-T9853: a failed fire passes the oldest entry over for the next one", () => {
  const backoff = triage.failedFireBackoff([failure(0)], "fb-old", policy.minIntervalMinutes, at(60));
  const inputs = {
    policy, deferralPending: true, dispatchCount: 0, laneBudget: 1,
    lockHeld: false, marker: { kind: "absent" as const }, now: at(60),
    candidates: ["fb-old", "fb-next"],
  };
  const decision = triage.decideAutoTriage({ ...inputs,
    backedOffCandidates: new Map([["fb-old", backoff.retryAtMs!]]),
  });
  assert.equal(decision.fire && decision.feedbackId, "fb-next");
  assert.match(decision.reason, /fb-old.*backoff/);
  const expired = triage.failedFireBackoff([failure(0)], "fb-old", policy.minIntervalMinutes, at(120));
  assert.equal(expired.backedOff, false);
  const retry = triage.decideAutoTriage({ ...inputs, now: at(120),
    backedOffCandidates: expired.backedOff ? new Map([["fb-old", expired.retryAtMs!]]) : new Map(),
  });
  assert.equal(retry.fire && retry.feedbackId, "fb-old");
});

test("W1-T9853: each repeat failure doubles the pass-over", () => {
  for (const n of [1, 2, 3, 12]) {
    const rows = Array.from({ length: n }, (_, i) => failure(i));
    const retryMinutes = n - 1 + 60 * 2 ** n;
    const pending = triage.failedFireBackoff(rows, "fb-old", 60, at(retryMinutes - 1));
    assert.equal(pending.failures, n);
    assert.equal(pending.retryAtMs, at(retryMinutes).getTime());
    assert.equal(pending.backedOff, true);
    assert.equal(triage.failedFireBackoff(rows, "fb-old", 60, at(retryMinutes)).backedOff, false);
  }
});

test("W1-T9853: a triage end resets the backoff", () => {
  for (const step of ["pr.opened", "triage.grill_opened", "triage.relint_refused", "verdict"]) {
    const rows = [failure(0), end(step, 1)];
    assert.equal(triage.failedFireBackoff(rows, "fb-old", 60, at(2)).failures, 0, step);
    rows.push(failure(3));
    const retry = triage.failedFireBackoff(rows.reverse(), "fb-old", 60, at(4));
    assert.equal(retry.failures, 1, step);
    assert.equal(retry.retryAtMs, at(123).getTime(), step);
  }
});

test("backoff ignores unrelated and malformed rows and resets on content changes", () => {
  const rows = [failure(0), failure(2), failure(3, "fb-other"), end("verdict", 4, "fb-other"),
    end("triage.start", 4), { ...failure(0), ts: "bad" }, {}];
  assert.equal(triage.failedFireBackoff(rows, "fb-old", 60, at(5)).failures, 2);
  assert.equal(triage.failedFireBackoff(rows, "fb-old", 60, at(5), at(1).toISOString()).failures, 1);
  assert.equal(triage.failedFireBackoff(rows, "fb-old", 60, at(5), at(3).toISOString()).backedOff, false);
});

test("long failure streaks have no retry cap and never throw when formatting a re-offer", () => {
  const backoff = triage.failedFireBackoff(Array.from({ length: 1100 }, () => failure(0)), "fb-old", 60, at(60));
  assert.equal(backoff.failures, 1100);
  assert.equal(backoff.backedOff, true);
  assert.equal(backoff.retryAtMs, Infinity);
  const decision = triage.decideAutoTriage({
    policy, deferralPending: true, dispatchCount: 0, laneBudget: 1,
    lockHeld: false, marker: { kind: "absent" }, now: at(60), candidates: ["fb-old"],
    backedOffCandidates: new Map([["fb-old", backoff.retryAtMs!]]),
  });
  assert.equal(decision.fire, false);
  assert.match(decision.reason, /beyond the representable date range/);
});

test("feedback content history reads the last origin/main commit for the candidate", async () => {
  const calls: unknown[][] = [];
  const timestamp = at(1).toISOString();
  const changedAt = await triage.feedbackChangedAtOnMain("/feedback-root", "fb-old", async (...args) => {
    calls.push(args);
    return `  ${timestamp}\n`;
  });
  assert.equal(changedAt, timestamp);
  assert.deepEqual(calls, [["/feedback-root",
    ["log", "-1", "--format=%cI", "origin/main", "--", "plan/feedback/fb-old.yaml"],
    { timeout: 10_000 }]]);
  assert.equal(triage.failedFireBackoff([failure(0)], "fb-old", 60, at(2), changedAt).failures, 0);
});

test("missing or malformed content history retains the failed fire", async () => {
  for (const output of ["", " \n", "not a timestamp\n"]) {
    const changedAt = await triage.feedbackChangedAtOnMain("/feedback-root", "fb-old", async () => output);
    assert.equal(changedAt, undefined);
    assert.equal(triage.failedFireBackoff([failure(0)], "fb-old", 60, at(2), changedAt).backedOff, true);
  }
});

test("content history command failures retain the failed fire", async () => {
  for (const error of [Object.assign(new Error("git exited"), { status: 128 }),
    Object.assign(new Error("git unavailable"), { code: "ENOENT" })]) {
    const changedAt = await triage.feedbackChangedAtOnMain("/feedback-root", "fb-old", async () => { throw error; });
    assert.equal(changedAt, undefined);
    assert.equal(triage.failedFireBackoff([failure(0)], "fb-old", 60, at(2), changedAt).backedOff, true);
  }
});

test("content history propagates failures without a command error code or status", async () => {
  for (const error of [new Error("security refusal"), null, "refused"]) {
    await assert.rejects(
      triage.feedbackChangedAtOnMain("/feedback-root", "fb-old", async () => { throw error; }),
      (observed: unknown) => { assert.equal(observed, error); return true; },
    );
  }
});

test("the default content history reader propagates the hardened leaf's pointer refusal", async (t) => {
  const { dir } = ownedFixtureDir(t, "failed-fire-history");
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(triage.feedbackChangedAtOnMain(dir, "fb-old"), (error: unknown) => {
    assert.ok(error instanceof WorktreePointerRefusedError);
    assert.equal(error.worktree, dir);
    assert.equal(error.observed, "<absent>");
    return true;
  });
  assert.equal(log.mock.callCount(), 1);
  const row = JSON.parse(log.mock.calls[0]!.arguments[0] as string);
  assert.equal(row.event, "worktree_git.pointer_refused");
  assert.equal(row.worktree, dir);
});
