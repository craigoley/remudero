import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import * as triage from "#src/lib/auto-triage.js";
import { autoTriageCheck } from "#src/run-task.js";
import { loadPolicy, policyPath } from "#src/lib/policy.js";
import type { Config } from "#src/lib/config.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const start = Date.parse("2026-10-16T00:00:00Z");
const at = (minutes: number) => new Date(start + minutes * 60_000);
const failure = (minutes: number, id = "fb-old") => ({
  step: "auto_triage.run_failed", feedback: id, ts: at(minutes).toISOString(),
});
const end = (step: string, minutes: number, id = "fb-old") => ({
  step, task_id: `TRIAGE-${id}`, ts: at(minutes).toISOString(),
});
const shipped = loadPolicy(policyPath(REPO_ROOT));
const policy = { ...shipped, values: { ...shipped.values,
  autoTriage: { enabled: true, minIntervalMinutes: 60, maxPerDay: 50 },
} };

function commitFeedback(repo: GitRepo, minutes: number) {
  repo.git("add", "plan");
  execFileSync("git", ["-C", repo.dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "feedback content"], {
    env: { ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_AUTHOR_DATE: at(minutes).toISOString(), GIT_COMMITTER_DATE: at(minutes).toISOString() },
  });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
}

function fixture(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "triage-backoff" });
  const root = join(repo.dir, "runtime");
  const dir = join(repo.dir, "plan", "feedback");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  for (const [i, id] of ["fb-old", "fb-next"].entries()) {
    writeFileSync(join(dir, `${id}.yaml`), `status: new\nts: ${at(i).toISOString()}\n`);
  }
  commitFeedback(repo, -1);
  const args = {
    config: { root, claudeBin: "/bin/true" } as Config,
    feedbackRoot: repo.dir, policy, ratifications: new Map(), now: at(60),
    readRefusalRows: () => [failure(0)],
    readFeedbackChangedAt: async () => at(-1).toISOString(),
    claimReserver: {
      mintAnchor: () => "unused", attempt: () => "created" as const,
      holder: () => undefined, drop: () => false, claimedIds: () => new Map<string, string>(),
    },
  };
  return { repo, root, args };
}

test("W1-T9853: a failed fire passes the oldest entry over for the next one", async (t) => {
  const { args } = fixture(t);
  const decision = await autoTriageCheck(args);
  assert.equal(decision.fire && decision.feedbackId, "fb-next");
  assert.match(decision.reason, /fb-old.*backoff/);
  const retry = await autoTriageCheck({ ...args, now: at(120) });
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

test("backed-off and held candidates are skipped with the soonest retry named", async (t) => {
  const { args } = fixture(t);
  const blocked = await autoTriageCheck({ ...args, readRefusalRows: () => [failure(0), failure(10, "fb-next")] });
  assert.equal(blocked.fire, false);
  assert.match(blocked.reason, /2.*backoff/);
  assert.ok(blocked.reason.includes(at(120).toISOString()));
  const mixed = triage.decideAutoTriage({
    policy: policy.values.autoTriage, deferralPending: true, dispatchCount: 0, laneBudget: 1,
    lockHeld: false, marker: { kind: "absent" }, now: at(60),
    candidates: ["fb-held", "fb-old", "fb-next"], heldCandidates: ["fb-held"],
    backedOffCandidates: new Map([["fb-old", at(120).getTime()]]),
  });
  assert.equal(mixed.fire && mixed.feedbackId, "fb-next");
  assert.match(mixed.reason, /held by a live claim/);
  assert.match(mixed.reason, /fb-old.*backoff/);
});

test("unreadable history preserves FIFO and normal cadence still refuses before history reads", async (t) => {
  const { root, args } = fixture(t);
  const unknown = await autoTriageCheck({ ...args, readRefusalRows: () => undefined });
  assert.equal(unknown.fire && unknown.feedbackId, "fb-old");
  writeFileSync(join(root, "state", "last-auto-triage.json"), JSON.stringify({ fires: [at(59).toISOString()] }));
  const floor = await autoTriageCheck({ ...args, readRefusalRows: () => { throw new Error("must not read"); } });
  assert.equal(floor.fire, false);
  assert.match(floor.reason, /minInterval/);
});

test("default ledger and main-commit readers observe failures across rotations and content resets", async (t) => {
  const { repo, root, args } = fixture(t);
  const committed = Date.parse(repo.git("log", "-1", "--format=%cI", "origin/main", "--", "plan/feedback/fb-old.yaml"));
  const failedAt = committed + 60_000;
  const row = { ...failure(0), ts: new Date(failedAt).toISOString() };
  writeFileSync(join(root, "state", "ledger.2026-10-16.ndjson.gz"), gzipSync(JSON.stringify(row) + "\n"));
  writeFileSync(join(root, "state", "ledger.2026-10-17.ndjson"), JSON.stringify(end("verdict", 0, "fb-other")) + "\n");
  writeFileSync(join(root, "state", "ledger.ndjson"), JSON.stringify({ step: "daemon.alive", ts: row.ts }) + "\n");
  const defaults = { ...args, now: new Date(failedAt + 60 * 60_000),
    readRefusalRows: undefined, readFeedbackChangedAt: undefined };
  const skipped = await autoTriageCheck(defaults);
  assert.equal(skipped.fire && skipped.feedbackId, "fb-next");
  const terminal = { step: "verdict", task_id: "TRIAGE-fb-old", ts: new Date(failedAt + 1_000).toISOString() };
  writeFileSync(join(root, "state", "ledger.2026-10-17.ndjson"), JSON.stringify(terminal) + "\n");
  const completed = await autoTriageCheck(defaults);
  assert.equal(completed.fire && completed.feedbackId, "fb-old");
  writeFileSync(join(root, "state", "ledger.2026-10-17.ndjson"), JSON.stringify(end("verdict", 0, "fb-other")) + "\n");
  writeFileSync(join(repo.dir, "plan", "feedback", "fb-old.yaml"), "status: new\nts: 2026-10-16T00:00:00Z\nbody: changed\n");
  commitFeedback(repo, 1);
  const reset = await autoTriageCheck(defaults);
  assert.equal(reset.fire && reset.feedbackId, "fb-old");
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const unreadable = await autoTriageCheck(defaults);
  assert.equal(unreadable.fire && unreadable.feedbackId, "fb-next");
  rmSync(join(root, "state", "ledger.2026-10-16.ndjson.gz"));
});

test("unreadable commit dates retain failures while unsafe worktree pointers propagate", async (t) => {
  const { repo } = fixture(t);
  assert.equal(await triage.feedbackChangedAtOnMain(repo.dir, "fb-missing"), undefined);
  const unsafe = join(repo.dir, "unsafe");
  mkdirSync(unsafe);
  writeFileSync(join(unsafe, ".git"), "gitdir: /nonexistent-triage-backoff-gitdir\n");
  await assert.rejects(triage.feedbackChangedAtOnMain(unsafe, "fb-old"), { name: "WorktreePointerRefusedError" });
});

test("long failure streaks have no retry cap and never throw when formatting a re-offer", () => {
  const backoff = triage.failedFireBackoff(Array.from({ length: 1100 }, () => failure(0)), "fb-old", 60, at(60));
  assert.equal(backoff.failures, 1100);
  assert.equal(backoff.backedOff, true);
  assert.equal(backoff.retryAtMs, Infinity);
  const decision = triage.decideAutoTriage({
    policy: policy.values.autoTriage, deferralPending: true, dispatchCount: 0, laneBudget: 1,
    lockHeld: false, marker: { kind: "absent" }, now: at(60), candidates: ["fb-old"],
    backedOffCandidates: new Map([["fb-old", backoff.retryAtMs!]]),
  });
  assert.equal(decision.fire, false);
  assert.match(decision.reason, /beyond the representable date range/);
});
