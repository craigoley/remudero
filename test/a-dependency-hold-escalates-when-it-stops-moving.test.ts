import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { depReviewCommand, type DepReviewDeps } from "#test/helpers/run-task-test.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-hold-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = join(root, "state", "ledger.ndjson");
  const statePath = join(dirname(ledger), "dep-review-holds", "craigoley", "remudero", "PR9818.json");
  let now = Date.now(), attempt = 1, head = "a".repeat(40), red = true;
  let prNumber = 9818;
  let taskPrState = "OPEN", taskAttempt = 1, refreshAllowed = true;
  const opened: string[] = [], closed: string[] = [], captured: string[] = [];
  const deps: DepReviewDeps = {
    root, config: { root, ledger } as never, clock: clockFromMillisFn(() => now),
    prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    issues: {
      create: (_title, body) => { opened.push(body); return `https://github.com/craigoley/remudero/issues/${9818 + opened.length}`; },
      listOpen: () => [], closeWithComment: (url) => { closed.push(url); },
    },
    postStatus: (async () => ({ posted: true })) as DepReviewDeps["postStatus"], arm: () => "armed",
    prMutations: { comment: () => assert.fail("unexpected comment"), close: () => assert.fail("unexpected close"),
      updateBranch: async () => ({ ok: refreshAllowed, error: "refresh refused" }) },
    captureMigrationFeedback: ({ id }) => { captured.push(id); return { id } as never; },
  };
  // A check's completion timestamp belongs to its attempt, not to a review pass.
  const started = now;
  deps.gh = (args) => args.includes("state,headRefOid,statusCheckRollup")
    ? { state: taskPrState, headRefOid: "repair-head", statusCheckRollup: [{ name: "ci-gate", checkRunId: taskAttempt }] }
    : ({ number: prNumber, url: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    title: "build(deps): bump example from 1.0.0 to 1.0.1", body: "", headRefOid: head,
    author: { login: "app/dependabot" }, statusCheckRollup: [{ name: "ci-gate",
      conclusion: red ? "FAILURE" : "SUCCESS", checkRunId: attempt,
      externalId: `run:100:${attempt}:job:${attempt}`, completedAt: new Date(started + attempt).toISOString() }] });
  const state = (number = 9818) => JSON.parse(readFileSync(join(dirname(statePath), `PR${number}.json`), "utf8"));
  return { root, statePath, opened, closed, captured, state,
    task: (feedbackId = "fb-repair") => {
      mkdirSync(join(root, "plan"), { recursive: true });
      writeFileSync(join(root, "plan", "tasks.yaml"), JSON.stringify([{
        id: "W1-T1", title: "repair example", repo: "remudero", type: "implement", files: [],
        origin: `feedback#${feedbackId}`, depends_on: [], status: "queued", attempts: 0,
      }]));
    },
    taskEvent: (step: string, extra = {}) => appendFileSync(ledger, JSON.stringify({
      ts: new Date(now).toISOString(), task_id: "W1-T1", run_id: "repair-run", step, ...extra,
    }) + "\n"),
    taskPr: (state: string) => { taskPrState = state; }, taskRetry: () => { taskAttempt++; },
    refuseRefresh: () => { refreshAllowed = false; },
    run: (...flags: string[]) => depReviewCommand(String(prNumber), ["--repo", "remudero", ...flags], deps),
    selectPr: (number: number) => { prNumber = number; },
    advance: (ms = 600_000) => { now += ms; }, retry: () => { attempt++; },
    recover: () => { red = false; }, failChecks: () => { red = true; }, newHead: () => { head = "b".repeat(40); },
    patch: (extra: object) => writeFileSync(statePath, JSON.stringify({ ...state(), ...extra })),
    proposal: (status = "new") => {
      mkdirSync(join(root, "plan", "feedback"), { recursive: true });
      writeFileSync(join(root, "plan", "feedback", "fb-repair.yaml"),
        `id: fb-repair\nstatus: ${status}\nraw: repair\nts: 2026-10-30T00:00:00Z\nattachments: []\nproposal_pr: null\n`);
      writeFileSync(join(dirname(statePath), "own-red-proposals.json"), JSON.stringify({ proposals: [{
        feedbackId: "fb-repair", submissionKey: "repair", bumps: ["example@1.0.1"], prNumbers: [9818], filedAtMs: now,
      }] }));
    },
  };
}

test("W1-T9818: a dependency hold that stops moving asks at once", async (t) => {
  const f = fixture(t);
  await f.run();
  assert.equal(f.opened.length, 0);
  f.advance();
  await f.run();
  assert.equal(f.opened.length, 1);
  assert.match(f.opened[0], /fingerprint unchanged since/i);
  assert.match(f.opened[0], /remedy state: none/i);
  assert.equal(typeof f.state().progress.fingerprint, "string");
  await f.run();
  assert.equal(f.opened.length, 1);
  f.recover();
  await f.run();
  assert.equal(f.closed.length, 1);
});

test("W1-T9818: a moving dependency hold is not escalated", async (t) => {
  const f = fixture(t);
  await f.run();
  const initial = f.state().progress.fingerprint;
  f.advance(2 * 86_400_000);
  f.retry();
  await f.run();
  assert.equal(f.opened.length, 0);
  assert.notEqual(f.state().progress.fingerprint, initial);
  await f.run("--dependabot-refresh", "base-red-recovered");
  assert.equal(f.opened.length, 0, "a refresh requested on this pass holds the ask");
  f.advance(2 * 86_400_000);
  await f.run();
  assert.equal(f.opened.length, 0, "no recovered history means no guessed timeout");
  assert.equal(f.state().progress.remedies.refresh.active, true);

  const p = fixture(t);
  await p.run();
  p.proposal();
  p.advance();
  await p.run();
  p.advance(2 * 86_400_000);
  await p.run();
  assert.equal(p.opened.length, 0);
  assert.equal(p.state().progress.remedies.proposal.active, true);
  p.proposal("rejected");
  await p.run();
  await p.run();
  assert.equal(p.opened.length, 1, "terminal proposal evidence releases the ask");

  await t.test("a later PR folded into a running owned build tracks that build through termination", async (t) => {
    const f = fixture(t);
    const ownRed = () => f.run("--dependabot-own-red", "main-passes");
    await ownRed();
    await ownRed();
    assert.equal(f.captured.length, 1, "the first PR captures a real shared proposal registry entry");
    f.task(f.captured[0]);
    f.taskEvent("run.start");
    f.selectPr(9819);
    f.newHead();
    await ownRed();
    await ownRed();
    assert.equal(f.state(9819).ownRed.feedbackId, f.captured[0], "the later PR folds into the saved proposal");
    assert.equal(f.captured.length, 1, "folding does not create another proposal");
    assert.equal(f.opened.length, 0, "folding itself must hold the ask");
    await f.run();
    assert.equal(f.opened.length, 0, "the folded binding survives a pass without the own-red flag");
    const initial = f.state(9819).progress.fingerprint;
    f.advance(2 * 86_400_000);
    f.taskEvent("pr.opened", { pr_url: "https://github.com/craigoley/remudero/pull/1" });
    await f.run();
    assert.notEqual(f.state(9819).progress.fingerprint, initial, "the folded PR observes its owned build's progress");
    const building = f.state(9819).progress.fingerprint;
    f.advance();
    f.taskRetry();
    await f.run();
    assert.notEqual(f.state(9819).progress.fingerprint, building, "an owned-build check attempt is progress");
    f.advance(2 * 86_400_000);
    await f.run();
    assert.equal(f.state(9819).progress.remedies.proposal.active, true);
    assert.equal(f.opened.length, 0, "without recovered history an active folded build has no guessed timeout");
    f.taskPr("MERGED");
    await f.run();
    assert.equal(f.opened.length, 0, "terminal evidence starts a fresh progress observation");
    await f.run();
    assert.equal(f.opened.length, 1, "a terminal build releases the folded PR's unchanged hold");
    assert.match(f.opened[0], /proposal terminal/);
    await f.run();
    assert.equal(f.opened.length, 1, "the folded head still asks only once");
  });
});


test("a dependency hold learns only recovered remedy gaps across restarts and sibling holds", async (t) => {
  const f = fixture(t);
  await f.run("--dependabot-refresh", "base-red-recovered");
  f.advance(100);
  f.retry();
  await f.run();
  f.advance(200);
  f.recover();
  await f.run();
  assert.equal(f.state().recoveredGaps.refresh, 200);
  // Leave the recovered sample in a sibling's durable state, as another PR would read it.
  writeFileSync(join(dirname(f.statePath), "PR1.json"), JSON.stringify(f.state()));
  rmSync(f.statePath);
  f.newHead();
  f.failChecks();
  await f.run("--dependabot-refresh", "base-red-recovered");
  f.advance(200);
  await f.run();
  assert.equal(f.opened.length, 0, "the observed maximum is still allowed");
  f.advance(1);
  await f.run();
  assert.equal(f.opened.length, 1, "a stalled request exceeds the recovered kind's longest gap");
  assert.match(f.opened[0], /refresh stalled.*200 ms/);
});

test("an owned build defers its dependency ask until the task or its PR reaches a terminal outcome", async (t) => {
  for (const terminal of ["failed", "MERGED", "CLOSED"]) {
    const f = fixture(t);
    await f.run();
    f.proposal("accepted");
    f.task();
    f.taskEvent("run.start");
    await f.run();
    f.advance(2 * 86_400_000);
    await f.run();
    assert.equal(f.opened.length, 0);
    f.taskEvent("pr.opened", { pr_url: "https://github.com/craigoley/remudero/pull/1" });
    await f.run();
    f.taskRetry();
    await f.run();
    assert.equal(f.opened.length, 0);
    if (terminal === "failed") {
      f.taskEvent("verdict", { verdict: "failed" });
      f.taskEvent("run.end");
    }
    else f.taskPr(terminal);
    await f.run();
    await f.run();
    assert.equal(f.opened.length, 1, terminal);
  }
});

test("a dependency hold refuses corrupt progress without forgetting its asks", async (t) => {
  const f = fixture(t);
  await f.run();
  await f.run();
  const asks = f.state().asks;
  for (const extra of [
    { progress: { fingerprint: "x", lastChangedMs: "yesterday", remedies: {} } },
    { progress: { fingerprint: "x", lastChangedMs: 1, remedies: { refresh: null } } },
    { recoveredGaps: { refresh: -1 } },
  ]) {
    f.patch(extra);
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.state().asks, asks);
    assert.equal(f.opened.length, 1);
  }
});


test("a refreshed head that remains red cannot teach a recovered hold gap", async (t) => {
  const f = fixture(t);
  await f.run("--dependabot-refresh", "base-red-recovered");
  f.advance(700);
  f.newHead();
  await f.run();
  assert.equal(f.state().recoveredGaps, undefined);
  assert.equal(f.state().pendingRecoveryGaps.refresh, 700);
  f.advance(100);
  f.recover();
  await f.run();
  assert.equal(f.state().recoveredGaps.refresh, 700);
  assert.equal(f.state().pendingRecoveryGaps, undefined);
});


test("a remedy's delivered ask prevents a second generic dependency hold issue", async (t) => {
  const f = fixture(t);
  f.refuseRefresh();
  await f.run("--dependabot-refresh", "base-red-recovered");
  assert.equal(f.opened.length, 1);
  await f.run();
  await f.run();
  assert.equal(f.opened.length, 1);
});

test("an unreadable owned-build PR cannot release a dependency hold's remedy", async (t) => {
  const f = fixture(t);
  await f.run();
  f.proposal("accepted");
  f.task();
  f.taskEvent("pr.opened", { pr_url: "https://github.com/craigoley/remudero/pull/1" });
  f.taskPr("UNKNOWN");
  await f.run();
  await f.run();
  assert.equal(f.opened.length, 0);
  f.taskPr("OPEN");
  await f.run();
  assert.equal(f.state().progress.remedies.proposal.active, true);
});
