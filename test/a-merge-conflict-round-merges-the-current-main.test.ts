/**
 * test/a-merge-conflict-round-merges-the-current-main.test.ts — W1-T5864.
 *
 * LIVE 2026-10-05 on #9301: a shell-less merge-conflict round ran `git merge --no-commit --no-ff
 * origin/main` against the worktree's UNFETCHED origin/main. That stale ref was already in the
 * branch, so git said "Already up to date" and left no MERGE_HEAD; the round still spent a worker,
 * and the harness wrote a single-parent "merge" it logged FIXED while GitHub kept the PR dirty.
 * Later rounds changed nothing and the PR stranded without an escalation.
 *
 * Every fixture here is the live shape in REAL git: a bare origin, a clone whose branch was cut
 * from an older main, main advanced on origin with a conflicting edit (plus one file only main
 * touches), and the clone's origin/main left stale — an ancestor of the branch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  currentStrikeRegimeFor,
  harnessCommitForShellLessWorker,
  priorStrikesFor,
  runFixRung,
  startShellLessMergeConflictMerge,
} from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

const MOUNT = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const CONFLICT_FILE = "conflict.txt";
const MAIN_ONLY_FILE = "main-only.txt";
const BRANCH = "run-W1-T5864X-1";
const TASK_ID = "W1-T5864X";
type Row = { step: string } & Record<string, unknown>;
type Run = Parameters<typeof runFixRung>[0];

interface StaleMain {
  wt: GitRepo;
  root: string;
  branchSha: string;
  staleMainSha: string;
  mainSha: string;
}

/** The live shape. `advanceMain: false` leaves origin's main where the branch was cut from it,
 *  so a fetched merge is genuinely "already up to date". */
function staleOriginMain(kind: string, advanceMain = true): StaleMain {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5864-${kind}-`));
  const origin = gitRepo({ kind: `w1t5864-${kind}-origin`, bare: true });
  const author = gitRepo({ kind: `w1t5864-${kind}-author`, seedCommit: true });
  writeFileSync(join(author.dir, CONFLICT_FILE), "base line\n");
  author.git("add", "-A");
  author.git("commit", "-qm", "seed the conflict file");
  author.git("remote", "add", "origin", origin.dir);
  author.git("push", "-q", "origin", "main");

  const wt = gitRepo({ kind: `w1t5864-${kind}-wt`, cloneFrom: origin.dir });
  // The code under test shells git without the fixture's env (the #1971 shape).
  wt.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  wt.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  wt.git("checkout", "-q", "-b", BRANCH);
  writeFileSync(join(wt.dir, CONFLICT_FILE), "base line\nours\n");
  wt.git("add", "-A");
  wt.git("commit", "-qm", "branch: our own change");
  const staleMainSha = wt.git("rev-parse", "origin/main");

  let mainSha = staleMainSha;
  if (advanceMain) {
    writeFileSync(join(author.dir, CONFLICT_FILE), "base line\ntheirs\n");
    writeFileSync(join(author.dir, MAIN_ONLY_FILE), "landed on main\n");
    author.git("add", "-A");
    author.git("commit", "-qm", "main: a conflicting change");
    author.git("push", "-q", "origin", "main");
    mainSha = author.git("rev-parse", "HEAD");
  }
  return { wt, root, branchSha: wt.git("rev-parse", "HEAD"), staleMainSha, mainSha };
}

/** The strike count the sweep reads back before its next dispatch, with the sweep's own regime. */
function sweepStrikes(rows: Row[], headSha: string): number {
  return priorStrikesFor(rows, TASK_ID, currentStrikeRegimeFor(rows, TASK_ID), headSha);
}

function mergeHead(wt: GitRepo): string | undefined {
  try {
    return wt.git("rev-parse", "--verify", "-q", "MERGE_HEAD");
  } catch {
    return undefined;
  }
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, provider: "claude",
  };
}

function review(state: "success" | "failure", headSha: string): Run["initialReview"] {
  return {
    state, criteria: [{ claim: "the merge state resolves", proof: "proof", met: state === "success", reason: "dirty",
      proof_exec: "not_executable" }], testTheater: false, summary: state, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "success",
  } as Run["initialReview"];
}

function mergeRound(f: StaleMain, opts: { strikeCap?: number; guardRoundHead?: boolean; resolve?: () => void } = {}) {
  const rows: Row[] = [];
  const pushes: Array<string | undefined> = [];
  const issuesFiled: string[] = [];
  let spawns = 0;
  const run: Run = {
    taskId: TASK_ID, runId: `${TASK_ID}-run`, task: { id: TASK_ID, title: "merge main", files: [CONFLICT_FILE] },
    prUrl: "https://github.com/acme/remudero/pull/9301", branch: BRANCH, worktreePath: f.wt.dir,
    initialSessionId: "initial", mount: MOUNT, settingsFile: join(f.root, "settings.json"),
    config: { root: f.root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: opts.strikeCap ?? 1, initialReview: review("failure", f.branchSha),
    ...(opts.guardRoundHead ? { guardRoundHead: true } : {}),
    mergeConflict: { files: [{ path: CONFLICT_FILE, oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: f.root, reviewerMount: MOUNT },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => {
        spawns++;
        (opts.resolve ?? (() => writeFileSync(join(f.wt.dir, CONFLICT_FILE), "base line\nours\ntheirs\n")))();
        return worker("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(merge): merge origin/main into the branch");
      },
      waitForCiGreen: async () => "green" as const,
      runReview: async () => review("success", f.wt.git("rev-parse", `refs/heads/${BRANCH}`)),
      fetchPrBody: async () => "REPORT",
      push: (_worktree: string, _branch: string, sha?: string) => { pushes.push(sha); },
      issues: {
        create: (title: string) => { issuesFiled.push(title); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [],
        comment: () => {},
      },
      ledgerPath: join(f.root, "ledger.ndjson"),
      ledgerLines: () => rows,
      log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, task_id: TASK_ID, ...(extra ?? {}) }),
      say: () => {},
      account: (r: WorkerResult) => r,
    } as Run["deps"],
  };
  return { run, rows, pushes, issuesFiled, spawns: () => spawns };
}

test("W1-T5864: a merge-conflict round on a stale origin/main fetches current main and starts a real merge", () => {
  const f = staleOriginMain("start");
  // The live shape: the worktree's origin/main is stale and already inside the branch.
  assert.notEqual(f.wt.git("rev-parse", "origin/main"), f.mainSha);
  assert.doesNotThrow(() => f.wt.git("merge-base", "--is-ancestor", "origin/main", "HEAD"));

  const started = startShellLessMergeConflictMerge(f.wt.dir);

  assert.equal(started.started, true, started.reason);
  assert.equal(f.wt.git("rev-parse", "origin/main"), f.mainSha, "the round fetched current main");
  assert.equal(mergeHead(f.wt), f.mainSha, "MERGE_HEAD is current main, never the stale ref");
  assert.match(readFileSync(join(f.wt.dir, CONFLICT_FILE), "utf8"), /^<<<<<<< /m, "real conflict markers to resolve");
  assert.equal(f.wt.git("rev-parse", "HEAD"), f.branchSha, "starting the merge never commits");
});

test("W1-T5864: the harness commit of a resolved merge-conflict round has current main as its second parent", async () => {
  for (const guardRoundHead of [false, true]) {
    const f = staleOriginMain(`commit-${guardRoundHead}`);
    const round = mergeRound(f, { guardRoundHead });

    const outcome = await runFixRung(round.run);

    assert.equal(outcome.outcome, "fixed", `guardRoundHead=${guardRoundHead}`);
    assert.equal(round.spawns(), 1);
    assert.ok(round.rows.some((r) => r.step === "fix.merge_started"));
    const head = f.wt.git("rev-parse", `refs/heads/${BRANCH}`);
    assert.deepEqual(round.pushes, [head], "the merge commit is what the round pushes");
    const parents = f.wt.git("log", "-1", "--format=%P", head).split(/\s+/).filter(Boolean);
    assert.deepEqual(parents, [f.branchSha, f.mainSha], `two parents, current main second (guardRoundHead=${guardRoundHead})`);
    assert.equal(f.wt.git("show", `${head}:${CONFLICT_FILE}`), "base line\nours\ntheirs");
    assert.equal(f.wt.git("show", `${head}:${MAIN_ONLY_FILE}`), "landed on main", "main's own changes ride the merge");
    assert.equal(mergeHead(f.wt), undefined, "the worktree is no longer mid-merge");
    assert.equal(f.wt.git("status", "--porcelain"), "", "the worktree matches the merge commit");
  }
});

test("W1-T5864: an already-up-to-date merge reports not started and spends no worker", async () => {
  const fresh = staleOriginMain("uptodate-direct", false);
  const direct = startShellLessMergeConflictMerge(fresh.wt.dir);
  assert.equal(direct.started, false);
  assert.match(direct.reason ?? "", /no MERGE_HEAD/);
  assert.equal(mergeHead(fresh.wt), undefined);

  for (const strikeCap of [1, 2]) {
    const f = staleOriginMain(`uptodate-${strikeCap}`, false);
    const round = mergeRound(f, { strikeCap });

    const outcome = await runFixRung(round.run);

    assert.equal(round.spawns(), 0, "no worker is spent on a merge that never began");
    assert.deepEqual(round.pushes, []);
    const failed = round.rows.filter((r) => r.step === "fix.merge_start_failed");
    assert.equal(failed.length, strikeCap);
    assert.match(String(failed[0]!.reason), /no MERGE_HEAD/);
    const strikes = round.rows.filter((r) => r.step === "fix.dispatch");
    assert.deepEqual(strikes.map((r) => r.strike), Array.from({ length: strikeCap }, (_, i) => i + 1));
    assert.match(String(strikes[0]!.reason), /no MERGE_HEAD/, "the failed strike carries the reason");
    assert.equal(outcome.outcome, "escalated", "a failed strike escalates at the cap, never a silent stand-down");
    assert.equal(outcome.reason, "merge_conflict_unresolved");
    assert.equal(outcome.strikes, strikeCap);
    assert.equal(round.issuesFiled.length, 1);
    // W1-T7096 (ruling 2026-10-09): a merge that never started is a REFUSED round the progress judge sees,
    // not a strike toward a fixed cap (W1-T5542: refused rounds are never strikes).
    assert.equal(round.rows.filter((r) => r.step === "fix.commit_refused").length, strikeCap, "the ledger records each as a refused round");
    assert.equal(sweepStrikes(round.rows, f.branchSha), 0, "and never as a strike");
  }
});

test("W1-T5864: a fetch of origin main that fails reports not started with its reason", () => {
  const f = staleOriginMain("fetch-fails");
  const origin = f.wt.git("remote", "get-url", "origin");
  f.wt.git("remote", "set-url", "origin", join(f.root, "no-such-origin"));

  const refused = startShellLessMergeConflictMerge(f.wt.dir);

  assert.equal(refused.started, false);
  assert.match(refused.reason ?? "", /fetch/);
  assert.equal(mergeHead(f.wt), undefined, "no merge of the stale ref is started instead");
  f.wt.git("remote", "set-url", "origin", origin);
  assert.equal(startShellLessMergeConflictMerge(f.wt.dir).started, true, "control: the same worktree starts once origin answers");
});

test("W1-T5864: a merge-mode commit without MERGE_HEAD is refused by name and counts as a failed strike", async () => {
  const f = staleOriginMain("no-merge-head");
  writeFileSync(join(f.wt.dir, CONFLICT_FILE), "base line\nours\nhand-edited\n");
  const rows: Row[] = [];
  const refusals: string[] = [];
  const commit = (requireMergeHead: boolean) => harnessCommitForShellLessWorker({
    harnessOwnsGit: true, commitCount: 0, report: "COMMIT_MESSAGE: fix(merge): merge origin/main",
    worktreePath: f.wt.dir, declaredPaths: [CONFLICT_FILE], requireMergeHead,
    log: (step, extra) => rows.push({ step, ...(extra ?? {}) }), say: () => {},
    onRefusal: (reason) => refusals.push(reason),
  });

  assert.equal(commit(true), 0);
  assert.equal(f.wt.git("rev-parse", "HEAD"), f.branchSha, "no single-parent 'merge' is written");
  assert.match(refusals[0] ?? "", /MERGE_HEAD/);
  assert.equal(rows.find((r) => r.step === "implement.harness_commit_refused")?.reason, refusals[0]);
  assert.ok(commit(false) > 0, "control: the same edit commits outside a merge-conflict round");

  const g = staleOriginMain("no-merge-head-round");
  const round = mergeRound(g, { strikeCap: 1 });
  round.run.deps.startShellLessMergeConflictMerge = () => ({ started: true });

  const outcome = await runFixRung(round.run);

  assert.equal(round.spawns(), 1);
  assert.deepEqual(round.pushes, [], "nothing is pushed for a refused merge commit");
  assert.equal(g.wt.git("rev-parse", `refs/heads/${BRANCH}`), g.branchSha);
  assert.match(String(round.rows.find((r) => r.step === "fix.commit_refused")?.reason), /MERGE_HEAD/);
  assert.equal(outcome.outcome, "escalated", "the refusal is a failed strike that escalates at the cap");
  assert.equal(outcome.strikes, 1);
  // W1-T7096: the refused merge commit is a refused round the progress judge sees (fix.commit_refused above).
  assert.equal(round.rows.filter((r) => r.step === "fix.commit_refused").length, 1, "the ledger records it as a refused round");
});
