import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

/**
 * W1-T11170. A dirty fleet gardener or landing PR, and an operator-session hand branch nobody holds, gets a bounded
 * conflict round on any path: the deterministic tier (main's deletion, a generator, or main's blob where the PR's change
 * is already on main) before any worker, then the plan-scoped round or the merge-conflict fix mode, with the fix
 * progress judge deciding what follows a failed round. A session branch takes only a merge commit, pushed with no force
 * flag, and every write is followed by one PR comment.
 */

const LINES = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];
const HOUR = 3_600_000;
const FLEET = "remudero-fleet[bot]";
const OPERATOR = "cao825";
const REPLAY_FIXTURE = "test/fixtures/review-replay/sample.ndjson";
const SHARD = "plan/tasks.d/W1-T11078-product-plan-resolves-the-managed-target-checkout.yaml";

type Change = { head?: string[] | null; main?: string[] | null };

/**
 * A real origin and checkout. `base` seeds main; each path's `head` and `main` lines are the PR head's and main's own
 * edits (null deletes the path on that side). Both sides are pushed, so origin holds the dirty PR head and main.
 */
function dirtyPair(t: TestContext, branch: string, base: Record<string, string[]>, changes: Record<string, Change>) {
  const origin = gitRepo({ bare: true });
  const repo = gitRepo();
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.addRemote("origin", origin.dir);
  const write = (path: string, lines: string[] | null) => {
    const abs = join(repo.dir, path);
    if (lines === null) { rmSync(abs); return; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${lines.join("\n")}\n`);
  };
  for (const [path, lines] of Object.entries(base)) write(path, lines);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore(test): seed");
  repo.git("push", "-q", "origin", "HEAD:refs/heads/main");
  repo.git("checkout", "-qb", branch);
  for (const [path, change] of Object.entries(changes)) if (change.head !== undefined) write(path, change.head);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore(test): edit head");
  const headSha = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  repo.git("checkout", "-q", "main");
  for (const [path, change] of Object.entries(changes)) if (change.main !== undefined) write(path, change.main);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore(test): edit main");
  repo.git("push", "-q", "origin", "HEAD:refs/heads/main");
  const mainSha = repo.git("rev-parse", "HEAD");
  const pushes: string[][] = [];
  const git = (cwd: string, args: readonly string[]) => {
    if (args[0] === "push") pushes.push([...args]);
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  const remoteHead = () => origin.git("rev-parse", `refs/heads/${branch}`);
  return { repo, origin, branch, headSha, mainSha, git, pushes, remoteHead };
}

/** The PR's change to one line is already on main, beside a main-only edit to the next line: a real conflict. */
const redundantChange = (): Change => ({
  head: LINES.map((l) => l === "l5" ? "l5-pr" : l),
  main: LINES.map((l) => l === "l5" ? "l5-pr" : l === "l6" ? "l6-main" : l),
});
/** Both sides rewrite the same line differently: no deterministic tier resolves it. */
const genuineChange = (): Change => ({
  head: LINES.map((l) => l === "l3" ? "l3-pr" : l),
  main: LINES.map((l) => l === "l3" ? "l3-main" : l),
});

interface Harness {
  ledger: Record<string, unknown>[];
  deps: sweep.SweepDeps;
  calls: { regenerate: Array<{ mode?: string; kind?: string }>; dispatch: sweep.FixDispatchEvidence[]; planRounds: number;
    escalations: string[]; comments: string[]; judged: number };
  disposed: () => Record<string, unknown> | undefined;
  rows: (step: string) => Record<string, unknown>[];
  run: (pr: sweep.OpenPrView) => Promise<void>;
}

function harness(mainSha: string, opts: {
  facts?: sweep.PlanRepairFacts | (() => sweep.PlanRepairFacts);
  repo?: { dir: string; git: (cwd: string, args: readonly string[]) => string };
  regenerate?: sweep.SweepDeps["regenerateConflict"];
  ownership?: () => sweep.SessionOwnershipEvidence;
  judge?: sweep.SweepDeps["fixProgressJudge"];
  rows?: Record<string, unknown>[];
} = {}): Harness {
  const ledger: Record<string, unknown>[] = [...(opts.rows ?? [])];
  const calls: Harness["calls"] = { regenerate: [], dispatch: [], planRounds: 0, escalations: [], comments: [], judged: 0 };
  let resolution = 0;
  const deps: sweep.SweepDeps = {
    ledgerPath: "/nonexistent-for-this-fixture/ledger.ndjson", runId: "owned-conflict-test",
    readLedger: () => ledger, appendLine: (_path, row) => { ledger.push(row); },
    arm: () => assert.fail("a dirty PR cannot arm"), close: () => assert.fail("a dirty PR is not closed"),
    escalate: (_pr, reason) => { calls.escalations.push(reason); }, readMainTip: () => mainSha,
    // As production's rung does, a round that lands no new head records its dispatch and its refused commit.
    dispatchFix: (pr, evidence) => {
      calls.dispatch.push(evidence);
      const row = { task_id: `PR-${pr.prNumber}`, pr_number: pr.prNumber, head_sha: pr.headSha };
      ledger.push({ ...row, step: "fix.dispatch", mode: "merge-conflict" }, { ...row, step: "fix.commit_refused", reason: "conflict left" });
    },
    claimFixAdmission: () => ({ admitted: true }),
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    readPlanRepairFacts: () => typeof opts.facts === "function" ? opts.facts() : opts.facts ?? {},
    dispatchPlanGateRound: async () => { calls.planRounds++; return { outcome: "refused", reason: "fixture round" }; },
    regenerateConflict: opts.regenerate ?? (async (pr, main, mode, owned) => {
      calls.regenerate.push({ mode, kind: owned?.kind });
      if (!opts.repo) return { outcome: "fell-through", paths: [], reason: "no fixture repo" };
      return sweep.regenerateConflictViaGit(opts.repo.dir, join(opts.repo.dir, "..", `resolution-${process.pid}-${resolution++}`),
        pr, main, { git: opts.repo.git, ...(mode ? { mode } : {}), ...(owned ? { owned } : {}), worktreeRemoveImpl: (dir, path) => {
          execFileSync("git", ["-C", dir, "worktree", "remove", "--force", path]);
        } });
    }),
    postConflictComment: (_pr, body) => { calls.comments.push(body); },
    ...(opts.ownership ? { readConflictOwnership: opts.ownership } : {}),
    ...(opts.judge ? { fixProgressJudge: async (input) => { calls.judged++; return opts.judge!(input); } } : {}),
  };
  return {
    ledger, deps, calls,
    disposed: () => ledger.findLast((row) => row.step === "sweep.disposed"),
    rows: (step) => ledger.filter((row) => row.step === step),
    run: (pr) => withLiveWritesAllowed(async () => {
      await sweep.runSweep([pr], deps);
      await sweep.drainDetachedSweepActions();
    }),
  };
}

function view(prNumber: number, headRefName: string, headSha: string, paths: string[], extra: Partial<sweep.OpenPrView> = {}): sweep.OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/example/fixture/pull/${prNumber}`, headRefName, headSha,
    mergeState: "dirty", mergeableState: "dirty", checksState: "none", reviewState: "none", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(), createdAt: new Date().toISOString(), autoMergeArmed: false,
    mergeConflict: { files: paths.map((path) => ({ path, oursDeleted: 1, theirsDeleted: 1 })), oursLog: "head", theirsLog: "main" },
    ...extra,
  } as sweep.OpenPrView;
}

const fleetFacts: sweep.PlanRepairFacts = { authorLogin: FLEET, headRepoFork: false };
const operatorFacts: sweep.PlanRepairFacts = { authorLogin: OPERATOR, operatorAuthor: true, headRepoFork: false };
/** Nobody holds it: no claim, no lock, and the newest of three hourly pushes is eight hours old. */
const unheld = (now = Date.now()): sweep.SessionOwnershipEvidence =>
  ({ nowMs: now, claims: [], session: {}, pushesMs: [now - 10 * HOUR, now - 9 * HOUR, now - 8 * HOUR] });

test("W1-T11170 criterion 1: a dirty review-replay-garden head on a fixture conflict gets one bounded round per head and main, and a contributor head stays blocked-ambiguous", async (t) => {
  const branch = "review-replay-garden-1793300871628";
  const r = dirtyPair(t, branch, { [REPLAY_FIXTURE]: LINES }, { [REPLAY_FIXTURE]: redundantChange() });
  const h = harness(r.mainSha, { facts: fleetFacts, repo: { dir: r.repo.dir, git: r.git } });
  const pr = view(15551, branch, r.headSha, [REPLAY_FIXTURE]);
  await h.run(pr);
  assert.deepEqual(h.calls.regenerate, [{ mode: "owned", kind: "fleet" }], "the round ran in the owned mode");
  const disposed = h.disposed()!;
  assert.equal(disposed.disposition, "conflicted", String(disposed.reason));
  assert.doesNotMatch(String(disposed.reason), /head is not this PR task's rmd-owned run branch/);
  assert.match(String(disposed.reason), /deterministic tier/);
  assert.notEqual(r.remoteHead(), r.headSha, "the fleet head moved");
  assert.deepEqual(h.calls.dispatch, [], "no worker ran");
  // One round per head and main: the next pass at the same head and main does not run it again.
  await h.run(pr);
  assert.equal(h.calls.regenerate.length, 1);
  assert.deepEqual(h.calls.escalations, []);

  // A contributor's head, not fleet-owned and not a session branch, stays exactly as today.
  const c = harness(r.mainSha, { facts: { authorLogin: "someone", headRepoFork: true } });
  await c.run(view(15552, "feature/fixture-tweak", r.headSha, [REPLAY_FIXTURE]));
  assert.equal(c.disposed()!.disposition, "blocked-ambiguous");
  assert.match(String(c.disposed()!.reason), /head is not this PR task's rmd-owned run branch/);
  assert.deepEqual(c.calls.regenerate, []);
  assert.deepEqual(c.calls.dispatch, []);
  // A machine-lane head the fleet App did not author is foreign too.
  const f = harness(r.mainSha, { facts: { authorLogin: "someone", headRepoFork: false } });
  await f.run(view(15553, branch, r.headSha, [REPLAY_FIXTURE]));
  assert.equal(f.disposed()!.disposition, "blocked-ambiguous");
  assert.deepEqual(f.calls.regenerate, []);
});

test("W1-T11170 criterion 1: the ownership predicates admit fleet heads and session shapes and refuse forks, fleet-authored session shapes and other tasks' run branches", () => {
  assert.equal(sweep.fleetOwnedConflictHead({ headRefName: "backlog-garden-1793547598484" }, { authorLogin: FLEET }), true);
  assert.equal(sweep.fleetOwnedConflictHead({ headRefName: "backlog-garden-1793547598484" }, { authorLogin: OPERATOR }), false);
  assert.equal(sweep.fleetOwnedConflictHead({ headRefName: "run-unfiled-1793649420000" }, { authorLogin: FLEET }), false);
  for (const head of ["run-unfiled-1793649420000", "plan-file-1793666134000", "codex/fix-thing"]) {
    assert.equal(sweep.operatorSessionHead({ headRefName: head }, { authorLogin: "anyone", headRepoFork: false }), true, head);
    assert.equal(sweep.operatorSessionHead({ headRefName: head }, { authorLogin: "anyone", headRepoFork: true }), false, `${head} on a fork`);
    assert.equal(sweep.operatorSessionHead({ headRefName: head }, { authorLogin: "anyone" }), false, `${head} with an unread fork`);
  }
  assert.equal(sweep.OPERATOR_SESSION_HEAD_RE.test("run-unfiled-1793649420000"), true);
  assert.equal(sweep.OPERATOR_SESSION_HEAD_RE.test("run-unfiled-tail"), false);
  assert.equal(sweep.OPERATOR_SESSION_HEAD_RE.test("codex/"), false);
  assert.equal(sweep.operatorSessionHead({ headRefName: "hand-branch" }, operatorFacts), true, "any head the operator authored");
  assert.equal(sweep.operatorSessionHead({ headRefName: "hand-branch" }, { authorLogin: "someone", headRepoFork: false }), false);
  assert.equal(sweep.operatorSessionHead({ headRefName: "run-W1-T90001-1793666131000" }, operatorFacts), false, "another task's run- branch");
  assert.equal(sweep.operatorSessionHead({ headRefName: "backlog-garden-1793547598484" }, operatorFacts), false, "a fleet lane head");
});

test("W1-T11170 criterion 2: the deterministic tier takes main's deletion and main's blob for a PR change already on main, pushes one merge commit and writes a row per path", async (t) => {
  const branch = "backlog-garden-1793547598484";
  const gone = "docs/retired-note.md";
  const r = dirtyPair(t, branch, { [SHARD]: LINES, [gone]: LINES },
    { [SHARD]: redundantChange(), [gone]: { head: LINES.map((l) => l === "l2" ? "l2-pr" : l), main: null } });
  const h = harness(r.mainSha, { facts: fleetFacts, repo: { dir: r.repo.dir, git: r.git } });
  await h.run(view(16044, branch, r.headSha, [SHARD, gone], { isPlanFiling: true }));
  assert.deepEqual(h.calls.dispatch, [], "no worker before the deterministic tier");
  assert.equal(h.calls.planRounds, 0, "no plan-scoped worker round before the deterministic tier");
  const rows = h.rows("sweep.conflict_regenerated");
  assert.deepEqual(rows.map((row) => [row.path, row.mode, row.outcome, row.head_kind]).sort(),
    [[gone, "deleted-on-main", "pushed", "fleet"], [SHARD, "take-main", "pushed", "fleet"]].sort());
  const head = r.remoteHead();
  assert.deepEqual(r.origin.git("rev-list", "--parents", "-1", head).split(" "), [head, r.headSha, r.mainSha]);
  assert.equal(r.origin.git("show", `${head}:${SHARD}`), r.origin.git("show", `${r.mainSha}:${SHARD}`), "main's blob, byte for byte");
  assert.equal(r.origin.git("ls-tree", "-r", "--name-only", head, "--", gone), "", "main's deletion");
  assert.doesNotMatch(r.origin.git("show", "-s", "--format=%B", head), /Remudero-Task:/, "a PR with no task carries no trailer");
  assert.equal(h.calls.comments.length, 1, "the fleet head gets the comment too");
});

test("W1-T11170 criterion 2: a path no tier resolves aborts the whole merge and pushes nothing; a registry path is planned for its generator", async (t) => {
  const branch = "backlog-garden-1793547598485";
  const r = dirtyPair(t, branch, { [SHARD]: LINES, "src/x.ts": LINES },
    { [SHARD]: redundantChange(), "src/x.ts": genuineChange() });
  const result = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(r.repo.dir, join(r.repo.dir, "..", `res-${process.pid}-a`),
    { prNumber: 1, headRefName: branch, headSha: r.headSha }, r.mainSha, { git: r.git, mode: "owned", owned: { kind: "fleet" } }));
  assert.equal(result.outcome, "fell-through", String(result.reason));
  assert.match(String(result.reason), /src\/x\.ts/);
  assert.deepEqual(r.pushes, []);
  assert.equal(r.remoteHead(), r.headSha);

  // A REGENERABLE_ARTIFACT_GENERATORS path is planned for its generator (mode regenerate), whatever the host sandbox does.
  const artifact = Object.keys(sweep.REGENERABLE_ARTIFACT_GENERATORS)[0]!;
  const g = dirtyPair(t, "backlog-garden-1793547598486", { [artifact]: LINES }, { [artifact]: genuineChange() });
  const regenerated = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(g.repo.dir, join(g.repo.dir, "..", `res-${process.pid}-b`),
    { prNumber: 2, headRefName: g.branch, headSha: g.headSha }, g.mainSha, { git: g.git, mode: "owned", owned: { kind: "fleet" } }));
  assert.deepEqual(regenerated.paths.map((p) => [p.path, p.mode, p.action]),
    [[artifact, "regenerate", sweep.REGENERABLE_ARTIFACT_GENERATORS[artifact]]]);
  if (regenerated.outcome !== "pushed") assert.equal(g.remoteHead(), g.headSha, "an unfinished resolution pushes nothing");

  // Without an owned head kind the mode refuses a non-run head, as the run-branch modes do.
  const refused = await sweep.regenerateConflictViaGit(r.repo.dir, join(r.repo.dir, "..", `res-${process.pid}-c`),
    { prNumber: 1, headRefName: branch, headSha: r.headSha }, r.mainSha, { git: r.git, mode: "owned" });
  assert.equal(refused.outcome, "fell-through");
  assert.equal(existsSync(join(r.repo.dir, "..", `res-${process.pid}-c`)), false);
});

test("W1-T11170 criterion 2: prChangeAlreadyOnMain compares the PR's hunks to main byte for byte", () => {
  const diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5 +5 @@\n-l5\n+l5-pr\n";
  assert.equal(sweep.prChangeAlreadyOnMain(diff, "l4\nl5-pr\nl6-main\n"), true);
  assert.equal(sweep.prChangeAlreadyOnMain(diff, "l4\nl5-main\nl6\n"), false, "main carries a different change");
  assert.equal(sweep.prChangeAlreadyOnMain(diff, "l4\nl5\nl5-pr\n"), false, "main still carries the removed line");
  assert.equal(sweep.prChangeAlreadyOnMain(diff, "l4\nxl5-pr\n"), false, "a whole line, never a substring");
  assert.equal(sweep.prChangeAlreadyOnMain("Binary files a/f and b/f differ\n", "x"), false);
  assert.equal(sweep.prChangeAlreadyOnMain("", "x"), false);
  assert.equal(sweep.prChangeAlreadyOnMain("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n", "b"), true);
});

test("W1-T11170 criterion 3: an unresolved non-plan path goes to the merge-conflict fix mode, and after a failed round the judge decides, never a count", async (t) => {
  const branch = "review-replay-garden-1793300871629";
  const r = dirtyPair(t, branch, { [REPLAY_FIXTURE]: LINES }, { [REPLAY_FIXTURE]: genuineChange() });
  const verdicts: Array<Awaited<ReturnType<NonNullable<sweep.SweepDeps["fixProgressJudge"]>>>> = [
    { verdict: "change-approach", approach: "union the fixture rows and re-sort", reason: "the first round kept one side" },
    { verdict: "continue", reason: "the round is converging" },
    { verdict: "escalate", loop: "identical conflict", reason: "the same hunk conflicts every round" },
  ];
  const h = harness(r.mainSha, { facts: fleetFacts, repo: { dir: r.repo.dir, git: r.git }, judge: async () => verdicts.shift() });
  const pr = () => view(15560, branch, r.headSha, [REPLAY_FIXTURE]);
  await h.run(pr());
  assert.equal(h.rows("sweep.conflict_regenerated")[0]?.outcome, "fell-through", "the deterministic tier ran first");
  assert.equal(h.calls.dispatch.length, 1, "the merge-conflict fix mode took the path");
  assert.equal(h.calls.dispatch[0]!.mergeConflict?.files[0]?.path, REPLAY_FIXTURE);
  assert.deepEqual(h.calls.dispatch[0]!.ownedConflictHead, { kind: "fleet", push: "leased" });
  assert.equal(h.calls.judged, 0, "the first round needs no ruling");
  // The head did not move: the round failed. The judge rules a change of approach, and a round runs with it.
  await h.run(pr());
  assert.equal(h.calls.judged, 1);
  assert.equal(h.calls.dispatch.length, 2);
  assert.equal(h.calls.dispatch[1]!.progressApproach, "union the fixture rows and re-sort");
  // Past any former fixed ceiling, a continue still earns a round: no count ends the repair.
  await h.run(pr());
  assert.equal(h.calls.dispatch.length, 3);
  await h.run(pr());
  assert.equal(h.calls.judged, 3);
  assert.equal(h.calls.dispatch.length, 3, "an escalate verdict dispatches nothing");
  assert.equal(h.calls.escalations.length, 1);
  assert.match(h.calls.escalations[0]!, /identical conflict/);
  await h.run(pr());
  assert.equal(h.calls.escalations.length, 1, "one escalation per PR and head");
  assert.equal(h.calls.judged, 3, "an escalated head is not re-judged");
  assert.equal(h.calls.regenerate.length, 1, "the deterministic tier ran once for this head and main");
});

test("W1-T11170 criterion 3: an unresolved plan-scope path on a fleet plan filing goes to the plan-scoped round", async (t) => {
  const branch = "backlog-garden-1793547598490";
  const r = dirtyPair(t, branch, { [SHARD]: LINES }, { [SHARD]: genuineChange() });
  const h = harness(r.mainSha, { facts: fleetFacts, repo: { dir: r.repo.dir, git: r.git } });
  await h.run(view(16045, branch, r.headSha, [SHARD], { isPlanFiling: true }));
  assert.equal(h.rows("sweep.conflict_regenerated")[0]?.outcome, "fell-through", "the deterministic tier ran first");
  assert.equal(h.calls.planRounds, 1, "W1-T9289's plan-scoped round took the plan shard");
  assert.deepEqual(h.calls.dispatch, [], "not the code fix mode");
  assert.equal(r.remoteHead(), r.headSha, "a plan record is never edited by hand by the deterministic tier");
});

test("W1-T11170 criterion 4: a run-unfiled branch nobody holds gets the round; a held one keeps today's row, judged on its own cadence", async (t) => {
  const branch = "run-unfiled-1793649420000";
  const r = dirtyPair(t, branch, { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const now = Date.now();
  const h = harness(r.mainSha, { facts: operatorFacts, repo: { dir: r.repo.dir, git: r.git }, ownership: () => unheld(now) });
  await h.run(view(16236, branch, r.headSha, [SHARD], { isPlanFiling: true }));
  assert.deepEqual(h.calls.regenerate, [{ mode: "owned", kind: "session" }]);
  assert.equal(h.rows("sweep.conflict_regenerated")[0]?.head_kind, "session");
  assert.ok(h.rows("sweep.conflict_regenerated")[0]?.ownership, "the row carries the ownership evidence");
  assert.notEqual(r.remoteHead(), r.headSha);

  const held = async (evidence: sweep.SessionOwnershipEvidence, why: string) => {
    const k = harness(r.mainSha, { facts: operatorFacts, ownership: () => evidence });
    await k.run(view(14277, "run-unfiled-1792971504320", r.headSha, [SHARD], { isPlanFiling: true }));
    assert.deepEqual(k.calls.regenerate, [], why);
    assert.deepEqual(k.calls.dispatch, [], why);
    assert.equal(k.disposed()!.disposition, "blocked-ambiguous", why);
    assert.match(String(k.disposed()!.reason), /head is not this PR task's rmd-owned run branch/, why);
  };
  // A push ten minutes ago on a branch pushed hourly: the owner is active.
  await held({ ...unheld(now), pushesMs: [now - 2 * HOUR, now - HOUR, now - 10 * 60_000] }, "a recent push");
  // A branch pushed every two days, last pushed 30 h ago, is still inside its own cadence: no fixed age decides it.
  await held({ ...unheld(now), pushesMs: [now - 126 * HOUR, now - 78 * HOUR, now - 30 * HOUR] }, "inside its own push cadence");
  // A claim renewed every ten minutes, last five minutes ago.
  await held({ ...unheld(now), claims: [{ ref: "refs/rmd-dispatch/W1-T90001",
    renewalsMs: [now - 25 * 60_000, now - 15 * 60_000, now - 5 * 60_000] }] }, "a live dispatch claim");
  await held({ ...unheld(now), session: { inflightLock: "DAEMON-1" } }, "a live inflight lock");
  await held({ ...unheld(now), session: { operatorRunId: "OPERATOR-W10573-SOURCE15532-1" } }, "an OPERATOR- run");
  await held({ ...unheld(now), session: { fixClaimKey: "fix-branch--x" } }, "an open fix claim");
});

test("W1-T11170 criterion 4: an unreadable or contradictory ownership read escalates once per PR and head and writes nothing", async (t) => {
  const branch = "run-unfiled-1793649420001";
  const r = dirtyPair(t, branch, { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const now = Date.now();
  const cases: Array<[string, () => sweep.SessionOwnershipEvidence]> = [
    ["pushes unreadable", () => ({ nowMs: now, claims: [], session: {} })],
    ["claim unreadable", () => ({ nowMs: now, session: {}, pushesMs: unheld(now).pushesMs })],
    ["a stale claim beside a fresh push", () => ({ nowMs: now, session: {},
      claims: [{ ref: "refs/rmd-dispatch/W1-T90002", renewalsMs: [now - 30 * HOUR, now - 29 * HOUR] }],
      pushesMs: [now - 2 * HOUR, now - HOUR, now - 60_000] })],
    ["the reader threw", () => { throw new Error("ls-remote timed out"); }],
  ];
  let prNumber = 17000;
  for (const [why, ownership] of cases) {
    const h = harness(r.mainSha, { facts: operatorFacts, ownership });
    const pr = view(prNumber++, branch, r.headSha, [SHARD], { isPlanFiling: true });
    await h.run(pr);
    assert.deepEqual(h.calls.regenerate, [], why);
    assert.deepEqual(h.calls.dispatch, [], why);
    assert.equal(h.disposed()!.disposition, "wait", why);
    assert.match(String(h.disposed()!.reason), /ownership is ambiguous/, why);
    assert.match(String(h.disposed()!.reason), /nothing written/, why);
    assert.equal(h.calls.escalations.length, 1, why);
    await h.run(pr);
    assert.equal(h.calls.escalations.length, 1, `${why}: once per PR and head`);
  }
  assert.equal(r.remoteHead(), r.headSha, "nothing was written");
  assert.deepEqual(r.pushes, []);
});

test("W1-T11170 criterion 4: sessionBranchUnheld reads each claim on its own renewal cadence and pushes on the branch's p90 gap", () => {
  const now = 1_800_000_000_000;
  assert.equal(sweep.sessionBranchUnheld(unheld(now)).verdict, "unheld");
  // One renewal: the holder kind's median gap decides; without one the read is unreadable.
  const one = { ref: "refs/rmd-dispatch/W1-T1", renewalsMs: [now - 2 * HOUR] };
  assert.equal(sweep.sessionBranchUnheld({ ...unheld(now), claims: [{ ...one, holderKindMedianGapMs: 3 * HOUR }] }).verdict, "held");
  assert.equal(sweep.sessionBranchUnheld({ ...unheld(now), claims: [{ ...one, holderKindMedianGapMs: HOUR }] }).verdict, "unheld");
  assert.equal(sweep.sessionBranchUnheld({ ...unheld(now), claims: [one] }).verdict, "ambiguous");
  // Fewer than three pushes: the operator's p90 gap decides.
  const two = { ...unheld(now), pushesMs: [now - 5 * HOUR, now - 4 * HOUR] };
  assert.equal(sweep.sessionBranchUnheld({ ...two, operatorP90GapMs: 6 * HOUR }).verdict, "held");
  assert.equal(sweep.sessionBranchUnheld({ ...two, operatorP90GapMs: 2 * HOUR }).verdict, "unheld");
  assert.equal(sweep.sessionBranchUnheld(two).verdict, "ambiguous");
  assert.equal(sweep.pushGapP90([0, HOUR, 2 * HOUR, 12 * HOUR]), 10 * HOUR);
  const reads = sweep.sessionBranchUnheld(unheld(now)).reads;
  assert.match(reads.claim, /no dispatch claim/);
  assert.match(reads.pushes, /branch p90 gap 3600000 ms/);
});

test("W1-T11170 criterion 5: a session branch takes only a merge commit on its head, pushed with no force flag, then one comment naming main, each path and the ownership reads", async (t) => {
  const branch = "run-unfiled-1793649420002";
  const r = dirtyPair(t, branch, { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const now = Date.now();
  let reads = 0;
  const h = harness(r.mainSha, { facts: operatorFacts, repo: { dir: r.repo.dir, git: r.git },
    ownership: () => { reads++; return unheld(now); } });
  await h.run(view(16237, branch, r.headSha, [SHARD], { isPlanFiling: true }));
  assert.equal(reads, 2, "the ownership is read again right before the push");
  assert.deepEqual(r.pushes, [["push", "origin", `HEAD:refs/heads/${branch}`]], "a plain push");
  assert.ok(r.pushes.flat().every((arg) => !arg.startsWith("--force") && arg !== "-f" && !arg.startsWith("+")), "no force flag of any kind");
  const head = r.remoteHead();
  assert.deepEqual(r.origin.git("rev-list", "--parents", "-1", head).split(" "), [head, r.headSha, r.mainSha],
    "a merge commit whose first parent is the PR head");
  assert.equal(h.calls.comments.length, 1);
  const comment = h.calls.comments[0]!;
  assert.match(comment, new RegExp(`merged main ${r.mainSha}`));
  assert.match(comment, new RegExp(`${SHARD.replace(/[.]/g, "\\.")}\`: take-main`));
  assert.match(comment, /round \(deterministic\)/);
  assert.match(comment, /- claim: clear/);
  assert.match(comment, /- session: clear/);
  assert.match(comment, /- pushes: clear/);
  assert.match(comment, /no force flag/);
});

test("W1-T11170 criterion 5: an owner who pushes before the session write wins, a re-read that finds the branch held stops the push, and a worker round lands as a merge commit", async (t) => {
  const branch = "run-unfiled-1793649420003";
  const r = dirtyPair(t, branch, { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  // The owner pushes between the ls-remote re-check and the push: the plain push is refused, never forced over.
  const ownerSha = await (async () => {
    const result = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(r.repo.dir, join(r.repo.dir, "..", `res-${process.pid}-d`),
      { prNumber: 3, headRefName: branch, headSha: r.headSha }, r.mainSha, { git: r.git, mode: "owned", owned: { kind: "session",
        recheck: () => {
          r.repo.git("checkout", "-q", r.headSha);
          writeFileSync(join(r.repo.dir, "owner.txt"), "owner\n");
          r.repo.git("add", "owner.txt");
          r.repo.git("commit", "-qm", "chore(test): owner push");
          r.repo.git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
          return undefined;
        } } }));
    assert.equal(result.outcome, "lease-mismatch", String(result.reason));
    return r.repo.git("rev-parse", "HEAD");
  })();
  assert.equal(r.remoteHead(), ownerSha, "the owner's push stands");
  assert.ok(r.pushes.flat().every((arg) => !arg.startsWith("--force")));

  const s = dirtyPair(t, "run-unfiled-1793649420004", { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const stopped = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(s.repo.dir, join(s.repo.dir, "..", `res-${process.pid}-e`),
    { prNumber: 4, headRefName: s.branch, headSha: s.headSha }, s.mainSha,
    { git: s.git, mode: "owned", owned: { kind: "session", recheck: () => "held: a push landed" } }));
  assert.equal(stopped.outcome, "lease-mismatch");
  assert.match(String(stopped.reason), /ownership re-read before the push: held/);
  assert.deepEqual(s.pushes, []);

  // An unresolved path on a session branch goes to a worker round told to land a merge commit with no force flag,
  // and the round is followed by the comment.
  const w = dirtyPair(t, "run-unfiled-1793649420005", { "src/x.ts": LINES }, { "src/x.ts": genuineChange() });
  const now = Date.now();
  const h = harness(w.mainSha, { facts: operatorFacts, repo: { dir: w.repo.dir, git: w.git }, ownership: () => unheld(now) });
  await h.run(view(16238, w.branch, w.headSha, ["src/x.ts"]));
  assert.equal(h.calls.dispatch.length, 1);
  assert.equal(h.calls.dispatch[0]!.ownedConflictHead?.kind, "session");
  assert.equal(h.calls.dispatch[0]!.ownedConflictHead?.push, "merge-commit-no-force");
  assert.ok(h.calls.dispatch[0]!.ownedConflictHead?.ownership, "the worker gets the ownership evidence");
  assert.equal(h.calls.comments.length, 1);
  assert.match(h.calls.comments[0]!, /round \(worker\)/);
  assert.match(h.calls.comments[0]!, /src\/x\.ts`: resolved by the merge-conflict fix mode worker/);
  assert.deepEqual(w.pushes, [], "the sweep itself pushed nothing for the worker round");
});

test("W1-T11170 criterion 4: production's ownership reader reads the claim chain, the locks and the branch's push times from a real repo", async (t) => {
  const r = dirtyPair(t, "run-unfiled-1793649420006", { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const at = (iso: string) => ({ ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" });
  const raw = (args: string[], iso = "2026-11-03T00:00:00Z") =>
    execFileSync("git", ["-C", r.repo.dir, ...args], { encoding: "utf8", env: at(iso) }).trim();
  // A claim minted and renewed once, ten minutes apart, on refs/rmd-dispatch/W1-T90009.
  const tree = raw(["hash-object", "-t", "tree", "/dev/null"]);
  const anchor = raw(["commit-tree", tree, "-m", "rmd-dispatch claim 4242@host-a 2026-11-03T00:00:00.000Z"]);
  const renewed = raw(["commit-tree", tree, "-p", anchor, "-m",
    "rmd-dispatch claim 4242@host-a 2026-11-03T00:00:00.000Z\nrenewed 4242@host-a 2026-11-03T00:10:00.000Z"]);
  raw(["push", "-q", "origin", `${renewed}:refs/rmd-dispatch/W1-T90009`]);
  // Three more pushes an hour apart on the session branch.
  raw(["checkout", "-q", r.branch]);
  for (const [i, iso] of ["2026-11-03T01:00:00Z", "2026-11-03T02:00:00Z", "2026-11-03T03:00:00Z"].entries()) {
    writeFileSync(join(r.repo.dir, `push-${i}.txt`), `${i}\n`);
    raw(["add", `push-${i}.txt`], iso);
    raw(["commit", "-qm", `chore(test): push ${i}`], iso);
  }
  raw(["push", "-q", "origin", `HEAD:refs/heads/${r.branch}`]);
  const now = Date.now();
  const evidence = await sweep.readSessionOwnershipViaGit(r.repo.dir,
    { headRefName: r.branch, taskId: undefined, body: "hand work\n\nRemudero-Task: W1-T90009\n" },
    { nowMs: now, fixClaimKey: "fix-branch--x", readLock: (key) => key === "fix-branch--x" ? "OPERATOR-W1-SOURCE1-1" : undefined });
  assert.deepEqual(evidence.claims, [{ ref: "refs/rmd-dispatch/W1-T90009",
    renewalsMs: [Date.parse("2026-11-03T00:00:00.000Z"), Date.parse("2026-11-03T00:10:00.000Z")] }]);
  assert.deepEqual(evidence.session, { operatorRunId: "OPERATOR-W1-SOURCE1-1", fixClaimKey: "fix-branch--x" });
  assert.equal(evidence.pushesMs?.length, 4, "the head commit and three hourly pushes");
  for (const iso of ["2026-11-03T01:00:00Z", "2026-11-03T02:00:00Z", "2026-11-03T03:00:00Z"]) {
    assert.ok(evidence.pushesMs!.includes(Date.parse(iso)), `the committer time ${iso} is a push time`);
  }
  assert.equal(evidence.unreadable, undefined);
  const verdict = sweep.sessionBranchUnheld(evidence);
  assert.equal(verdict.verdict, "ambiguous", "a stale claim beside a live OPERATOR- run");

  // Each read that fails is absent, with its reason, and the verdict is ambiguous.
  const failed = await sweep.readSessionOwnershipViaGit(r.repo.dir,
    { headRefName: "run-unfiled-0000000000000", taskId: "W1-T90009" },
    { nowMs: now, fixClaimKey: "k", readLock: () => { throw new Error("lock dir unreadable"); },
      git: (_cwd, args) => {
        if (args[0] === "ls-remote") throw new Error("ls-remote refused");
        return execFileSync("git", ["-C", r.repo.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } });
  assert.equal(failed.claims, undefined);
  assert.equal(failed.session, undefined);
  assert.equal(failed.pushesMs, undefined, "a branch the remote does not have");
  assert.deepEqual(failed.unreadable?.map((reason) => reason.split(":")[0]), ["claim", "session", "pushes"]);
  assert.match(sweep.sessionBranchUnheld(failed).reason, /ls-remote refused/);

  // With fewer than three pushes the operator's p90 gap over the trailing window's session branches is read.
  const few = dirtyPair(t, "run-unfiled-1793649420007", { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const sparse = await sweep.readSessionOwnershipViaGit(few.repo.dir, { headRefName: few.branch },
    { nowMs: Date.now(), fixClaimKey: "k", readLock: () => undefined });
  assert.deepEqual(sparse.claims, []);
  assert.deepEqual(sparse.session, {});
  assert.equal(sparse.pushesMs?.length, 1);
});

test("W1-T11170 criterion 5: the production effects wire the ownership reader, the session facts and the comment writer, and a session push needs no injected git", async (t) => {
  const root = gitRepo({ seedCommit: false }).dir;
  const effects = sweep.buildSweepEffects({
    owner: "example", repo: "fixture", config: { root, operatorGithubLogins: [OPERATOR] } as never, repoRoot: root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "RUN-owned-effects", plan: { tasks: [], byId: new Map() } as never, log: () => {},
    fixBranchClaimKeyImpl: (_owner: string, _repo: string, branch: string) => `fix-branch--${branch}`,
    ghJsonImpl: () => ({ user: { login: "CAO825" }, title: "plan: hand filing", head: { sha: "a".repeat(40), ref: "run-unfiled-1",
      repo: { full_name: "Example/Fixture" } } }),
  } as never);
  const pr = view(16300, "run-unfiled-1793649420008", "a".repeat(40), [SHARD]);
  const facts = await effects.readPlanRepairFacts!(pr);
  assert.equal(facts.operatorAuthor, true, "the configured operator login, case-folded");
  assert.equal(facts.headRepoFork, false, "the head lives in this repository");
  const evidence = await effects.readConflictOwnership!(pr);
  assert.deepEqual(evidence.claims, [], "no task id names a claim");
  assert.deepEqual(evidence.session, {}, "no lock in an empty inflight directory");
  assert.equal(sweep.sessionBranchUnheld(evidence).verdict, "ambiguous", "the branch cannot be fetched from a checkout that is absent");
  await assert.rejects(async () => effects.postConflictComment!(pr, "body"), /live|write|guard/i, "a comment is a guarded live write");

  // The session write through the default push path (no injected git).
  const s = dirtyPair(t, "run-unfiled-1793649420009", { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const pushed = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(s.repo.dir, join(s.repo.dir, "..", `res-${process.pid}-f`),
    { prNumber: 5, headRefName: s.branch, headSha: s.headSha }, s.mainSha, { mode: "owned", owned: { kind: "session" } }));
  assert.equal(pushed.outcome, "pushed", String(pushed.reason));
  assert.deepEqual(s.origin.git("rev-list", "--parents", "-1", s.remoteHead()).split(" "), [s.remoteHead(), s.headSha, s.mainSha]);
});

test("W1-T11170 criterion 5: a throwing ownership re-read or a write that is not a merge commit pushes nothing, and a failed comment never stops the pass", async (t) => {
  const s = dirtyPair(t, "run-unfiled-1793649420010", { [SHARD]: LINES }, { [SHARD]: redundantChange() });
  const threw = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(s.repo.dir, join(s.repo.dir, "..", `res-${process.pid}-g`),
    { prNumber: 6, headRefName: s.branch, headSha: s.headSha }, s.mainSha,
    { git: s.git, mode: "owned", owned: { kind: "session", recheck: () => { throw new Error("lock directory unreadable"); } } }));
  assert.equal(threw.outcome, "lease-mismatch");
  assert.match(String(threw.reason), /the ownership re-read failed: .*lock directory unreadable/);
  // A write whose commit is not a two-parent merge on the PR head is refused before any ownership read or push.
  let rechecked = false;
  const single = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(s.repo.dir, join(s.repo.dir, "..", `res-${process.pid}-h`),
    { prNumber: 6, headRefName: s.branch, headSha: s.headSha }, s.mainSha, { mode: "owned",
      git: (cwd, args) => args[0] === "rev-list" && args[1] === "--parents" ? `${"f".repeat(40)} ${s.headSha}\n` : s.git(cwd, args),
      owned: { kind: "session", recheck: () => { rechecked = true; return undefined; } } }));
  assert.equal(single.outcome, "error");
  assert.match(String(single.reason), /not a merge commit/);
  assert.equal(rechecked, false);
  assert.deepEqual(s.pushes, []);
  assert.equal(s.remoteHead(), s.headSha);

  // A comment writer that throws is logged; the deterministic write and the worker round still stand.
  const logged: string[] = [];
  const d = dirtyPair(t, "backlog-garden-1793547598491", { [SHARD]: LINES, "src/x.ts": LINES }, { [SHARD]: redundantChange() });
  const h = harness(d.mainSha, { facts: fleetFacts, repo: { dir: d.repo.dir, git: d.git } });
  h.deps.postConflictComment = () => { throw new Error("gh refused"); };
  h.deps.log = (step) => { logged.push(step); };
  await h.run(view(16400, d.branch, d.headSha, [SHARD], { isPlanFiling: true }));
  assert.equal(h.rows("sweep.conflict_regenerated")[0]?.outcome, "pushed");
  const w = dirtyPair(t, "review-replay-garden-1793300871630", { "src/x.ts": LINES }, { "src/x.ts": genuineChange() });
  const k = harness(w.mainSha, { facts: fleetFacts, repo: { dir: w.repo.dir, git: w.git } });
  k.deps.postConflictComment = () => { throw new Error("gh refused"); };
  k.deps.log = (step) => { logged.push(step); };
  await k.run(view(16401, w.branch, w.headSha, ["src/x.ts"]));
  assert.equal(k.calls.dispatch.length, 1);
  assert.equal(logged.filter((step) => step === "sweep.owned_conflict.comment_failed").length, 2);
});
