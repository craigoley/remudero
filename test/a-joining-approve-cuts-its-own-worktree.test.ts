// test/a-joining-approve-cuts-its-own-worktree.test.ts — W1-T9161: on 2026-10-13, 4 of the 17 fleet approves started
// from 14:10Z to 14:29:30Z died at the add itself. `joinRatificationBranch` and `completeRatificationBranch` added
// their worktree at `worktrees/<the open plan PR's branch>` with `worktree add -b <that branch>`, so any approve
// started while another run still held that branch failed with git's own "a branch named ... already exists".
//
// Each join and resume now cuts its OWN tree on its own branch, `approveRunBranch(runId)`, from the PR branch's
// remote tip. The join pushes HEAD to the PR branch as a plain fast-forward. When another approve moved the tip
// first, git's own fast-forward rule rejects that push, and the run files its own PR instead. It never retries the
// join. A PR whose approving process is still alive on this host is not joined at all.
//
// EVERYTHING GIT IS REAL: a bare fixture origin, a managed clone, `git worktree add`, and the pushes. Only GitHub
// is a `gh` shim on PATH. Its PR head is the open PR's branch, so only a JOINED run clears the run-ownership guard,
// and its CI answers red on the first poll: no wait, no review.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitPushRunBranch } from "#src/lib/git-push.js";
import { approveRunBranch, mostRecentApprovePr } from "#src/lib/inbox.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { taskIdReservationsDir } from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { approveCommand } from "#src/run-task.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIOR_RUN_ID = "APPROVE-P-FIRST-1791000000000";
const PRIOR_PR_URL = "https://github.com/craigoley/remudero/pull/9161";
const OWN_PR_URL = "https://github.com/craigoley/remudero/pull/9162";
type Row = Record<string, unknown>;

const SAVED = { HOME: process.env.HOME, PATH: process.env.PATH };
const children: ChildProcess[] = [];
afterEach(() => {
  process.env.HOME = SAVED.HOME;
  process.env.PATH = SAVED.PATH;
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** A process that stays alive until the test ends: a run that has not exited. Not node, so it writes no coverage. */
function liveChild(): number {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  children.push(child);
  assert.ok(child.pid, "the live child started");
  return child.pid;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid!;
}

function planTask(id: string, title: string): string {
  return `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n`;
}

function rowsOf(path: string): Row[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

interface JoinWorld {
  origin: GitRepo;
  seed: GitRepo;
  repoDir: string;
  worktreesRoot: string;
  root: string;
  priorBranch: string;
  priorSha: string;
  ledgerFile: string;
  shim: GhShim;
  /** Run `rmd approve <id>` in THIS process through the real gateway; what it throws is not under test. */
  approve(id: string): Promise<Row[]>;
  /** Every `run-*` branch on the origin. */
  runBranches(): string[];
}

/**
 * A pass with ONE open approve PR: P-FIRST's branch is pushed to a bare origin and the ledger holds its
 * `ratify.approved` row (`approver` sets that row's `actor_pid` and `host`). Every proposal in `ids` is READY with
 * one drafted task. `routes` go ahead of the default `gh` table.
 */
function joinWorld(kind: string, opts: { ids: string[]; approver?: { pid?: number; host?: string }; routes?: GhShimRoute[]; seeded?: Row[] }): JoinWorld {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), planTask("W1-T4", "a seed task the plan loader accepts"));
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  mkdirSync(join(seed.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(seed.dir, "src", "lib", "plan.ts"), "");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed plan");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  // The FIRST approval of the pass: its branch is pushed and its PR (per the shim) open.
  const priorBranch = approveRunBranch(PRIOR_RUN_ID);
  seed.git("checkout", "--quiet", "-b", priorBranch);
  appendFileSync(join(seed.dir, "plan", "tasks.yaml"), planTask("W1-T50", "filed by the first approval of the pass"));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore(plan): ratify P-FIRST via rmd approve");
  seed.git("push", "--quiet", "origin", priorBranch);
  const priorSha = seed.git("rev-parse", "HEAD");

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-home-`));
  // The managed clone the gateway worktrees from, at the path approveCommand derives from this checkout's own remote.
  // Its identity is in its own config, so the gateway's `git commit` (and every worktree's) has one in CI too.
  const remoteUrl = execGit(REPO_ROOT, "config", "--get", "remote.origin.url");
  const repoDir = join(root, "repos", remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]!);
  const managed = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-managed` });
  managed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  managed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  mkdirSync(dirname(repoDir), { recursive: true });
  renameSync(managed.dir, repoDir);

  const config = { claudeBin: "/usr/bin/true", root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: opts.ids.map((id) => ({ id, summary: `approve ${id}`, evidenceAnchors: [] })) }),
  );
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify(
      Object.fromEntries(
        opts.ids.map((id) => [
          id,
          {
            proposalId: id,
            fragmentYaml: `- id: NEW-1\n  title: ${id.toLowerCase()} lands its own shard\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/plan.ts]\n`,
            stampLine: `- ${id} (plan) — RATIFIED -> NEW-1.`,
            anchorFingerprint: "",
          },
        ]),
      ),
    ),
  );
  const ledgerFile = join(root, "state", "ledger.ndjson");
  const approved: Row = { run_id: PRIOR_RUN_ID, task_id: "P-FIRST", step: "ratify.approved", branch: priorBranch, pr_url: PRIOR_PR_URL, pr_number: 9161 };
  if (opts.approver?.pid !== undefined) approved.actor_pid = opts.approver.pid;
  if (opts.approver?.host !== undefined) approved.host = opts.approver.host;
  writeFileSync(ledgerFile, [approved, ...(opts.seeded ?? [])].map((row) => JSON.stringify(row) + "\n").join(""));

  // `--method POST` is first because the create call's argv carries the whole PR body.
  const shim = ghShim(
    [
      { when: "--method POST", stdout: JSON.stringify({ html_url: OWN_PR_URL, number: 9162 }) },
      ...(opts.routes ?? []),
      { when: "headRefName", stdout: JSON.stringify({ headRefName: priorBranch }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
      { when: "pulls?state=open", stdout: "[]" },
      { when: "pulls?head=", stdout: JSON.stringify([{ html_url: PRIOR_PR_URL, number: 9161 }]) },
      {
        when: "/pulls/",
        stdout: JSON.stringify({ number: 9161, html_url: PRIOR_PR_URL, state: "open", merged_at: null, head: { ref: priorBranch, sha: priorSha } }),
      },
    ],
    { kind: `${kind}-gh` },
  );

  const approve = async (id: string): Promise<Row[]> => {
    process.env.HOME = home;
    process.env.PATH = `${shim.dir}:${SAVED.PATH}`;
    try {
      await withLiveWritesAllowed(() => approveCommand([id], { config: config as never })).catch(() => undefined);
    } finally {
      process.env.HOME = SAVED.HOME;
      process.env.PATH = SAVED.PATH;
    }
    return rowsOf(ledgerFile);
  };
  const runBranches = (): string[] => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads/run-*").split("\n").filter(Boolean);
  return { origin, seed, repoDir, worktreesRoot: join(root, "worktrees"), root, priorBranch, priorSha, ledgerFile, shim, approve, runBranches };
}

function execGit(dir: string, ...args: string[]): string {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();
}

/** The `ratify.approved` row this proposal's approve wrote, with every step as context for a failure. */
function approvedRow(rows: Row[], id: string): { row: Row | undefined; steps: string } {
  const steps = JSON.stringify(rows.filter((r) => r.task_id === id).map((r) => (r.step === "approve.error" ? `approve.error: ${String(r.error)}` : r.step)));
  return { row: rows.find((r) => r.step === "ratify.approved" && r.task_id === id), steps };
}

/** The join landed: one more commit on the open PR's branch, its parent the tip the PR had, carrying `id`'s shard. */
function assertJoined(w: JoinWorld, rows: Row[], id: string): void {
  const { row, steps } = approvedRow(rows, id);
  assert.equal(row?.joined, true, `${id} joined the open PR; steps=${steps}`);
  assert.equal(row?.branch, w.priorBranch, "the row names the PR's branch, the PR's head");
  assert.equal(row?.pr_url, PRIOR_PR_URL, "it names the already-open PR, never a new one");
  const tip = w.origin.git("rev-parse", w.priorBranch);
  assert.equal(w.origin.git("rev-parse", `${tip}^`), w.priorSha, "exactly one commit on top of the tip the PR had: a fast-forward");
  assert.match(w.origin.git("log", "-1", "--format=%s", tip), new RegExp(`ratify ${id} via rmd approve`));
  assert.deepEqual(w.runBranches(), [w.priorBranch], "the join's own local branch never reaches the origin");
  const added = rows.find((r) => r.step === "worktree.add" && r.task_id === id);
  assert.ok(added, `${id}'s add was ledgered; steps=${steps}`);
  const ownRunId = String(added.run_id);
  assert.equal(added.branch, approveRunBranch(ownRunId), "the join cut its own branch, named for its own run");
  assert.equal(added.worktreePath, join(w.worktreesRoot, approveRunBranch(ownRunId)), "at its own path");
}

test("W1-T9161: a retried approve with a leftover run-APPROVE branch succeeds", async () => {
  // P-RETRY's first attempt died at the add, as four fleet approves did at 14:10Z-14:23Z.
  const w = joinWorld("t9161-retry", {
    ids: ["P-RETRY"],
    approver: { pid: deadPid(), host: hostname() },
    seeded: [
      {
        run_id: "APPROVE-P-RETRY-1791000000500",
        task_id: "P-RETRY",
        step: "approve.error",
        error: `fatal: a branch named '${approveRunBranch(PRIOR_RUN_ID)}' already exists`,
      },
    ],
  });
  // The leftover: a local branch named for the open PR, checked out in a lockless tree a crashed run left at the PR
  // branch's path. It is younger than the prune grace, so the start-of-run prune keeps it, and so does the branch.
  const leftover = join(w.worktreesRoot, w.priorBranch);
  mkdirSync(w.worktreesRoot, { recursive: true });
  execGit(w.repoDir, "fetch", "--quiet", "origin");
  execGit(w.repoDir, "worktree", "add", "--quiet", "-b", w.priorBranch, leftover, `origin/${w.priorBranch}`);
  assert.equal(execGit(w.repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${w.priorBranch}`), w.priorSha, "the leftover branch exists");

  const rows = await w.approve("P-RETRY");

  assertJoined(w, rows, "P-RETRY");
  assert.ok(!rows.some((r) => r.task_id === "P-RETRY" && r.step === "approve.error" && r.run_id !== "APPROVE-P-RETRY-1791000000500"), "the retry raised no error");
  assert.equal(execGit(leftover, "rev-parse", "HEAD"), w.priorSha, "the leftover tree is untouched");
});

test("W1-T9161: a join while another run holds the PR branch succeeds", async () => {
  const w = joinWorld("t9161-held", { ids: ["P-HELD"], approver: { pid: deadPid(), host: hostname() } });
  // Another LIVE run holds the PR branch's worktree and its lock: the PR's creating approve, or another joiner.
  const held = join(w.worktreesRoot, w.priorBranch);
  mkdirSync(w.worktreesRoot, { recursive: true });
  execGit(w.repoDir, "fetch", "--quiet", "origin");
  execGit(w.repoDir, "worktree", "add", "--quiet", "-b", w.priorBranch, held, `origin/${w.priorBranch}`);
  const holderLock = JSON.stringify({ pid: liveChild(), run_id: "APPROVE-P-OTHER-1791000000700", startedAt: new Date().toISOString() });
  writeFileSync(`${held}.lock`, holderLock);

  const rows = await w.approve("P-HELD");

  assertJoined(w, rows, "P-HELD");
  assert.equal(readFileSync(`${held}.lock`, "utf8"), holderLock, "the holder's lock is byte-for-byte untouched");
  assert.equal(execGit(held, "rev-parse", "HEAD"), w.priorSha, "the holder's tree is untouched");
});

test("W1-T9161: the join that loses the push opens its own PR", async () => {
  const w = joinWorld("t9161-race", { ids: ["P-LOSER"], approver: { pid: deadPid(), host: hostname() } });
  // The rival joiner's commit on the PR's tip, already on the origin under a ref no fetch copies. The open-PR read
  // the mint makes runs AFTER this approve cut its tree, and it moves the PR branch to the rival's commit: another
  // approve pushed first.
  w.seed.git("checkout", "--quiet", w.priorBranch);
  writeFileSync(join(w.seed.dir, "plan", "tasks.d", "W1-T60-the-rival-joiner.yaml"), planTask("W1-T60", "filed by the rival joiner"));
  w.seed.git("add", "-A");
  w.seed.git("commit", "--quiet", "-m", "chore(plan): ratify P-RIVAL via rmd approve");
  const rivalSha = w.seed.git("rev-parse", "HEAD");
  w.seed.git("push", "--quiet", "origin", `${rivalSha}:refs/rival/joiner`);
  w.shim.addRoute({
    when: "pulls?state=open",
    stdout: "[]",
    writes: { path: join(w.origin.dir, "refs", "heads", w.priorBranch), content: `${rivalSha}\n` },
  });

  const rows = await w.approve("P-LOSER");
  const { row, steps } = approvedRow(rows, "P-LOSER");

  assert.equal(w.origin.git("rev-parse", w.priorBranch), rivalSha, "the rival's commit is still the PR's tip: nothing was forced over it");
  assert.ok(rows.some((r) => r.step === "approve.join_lost" && r.task_id === "P-LOSER"), `the lost push is ledgered; steps=${steps}`);
  assert.ok(row, `the loser still filed; steps=${steps}`);
  assert.equal(row.joined, undefined, "it did not join");
  assert.equal(row.pr_url, OWN_PR_URL, "it opened its own PR");
  const own = String(row.branch);
  assert.notEqual(own, w.priorBranch);
  assert.ok(w.runBranches().includes(own), "its own branch is on the origin");
  assert.equal(w.origin.git("merge-base", "main", own), w.origin.git("rev-parse", "main"), "its own branch is cut from main");
  assert.match(w.origin.git("log", "-1", "--format=%s", own), /ratify P-LOSER via rmd approve/);
  const reservations = taskIdReservationsDir(w.root);
  assert.deepEqual(existsSync(reservations) ? readdirSync(reservations) : [], [], "every id it reserved, for the join and for its own PR, came back");
});

test("W1-T9161: a PR whose approve is still running is not joinable", async () => {
  // mostRecentApprovePr names the approving process as well as the PR.
  assert.deepEqual(
    mostRecentApprovePr([{ step: "ratify.approved", branch: "run-APPROVE-P-A-1", pr_url: PRIOR_PR_URL, pr_number: 9161, actor_pid: 42, host: "h1" }]),
    { branch: "run-APPROVE-P-A-1", prUrl: PRIOR_PR_URL, prNumber: 9161, actorPid: 42, host: "h1" },
  );

  // The PR's own approve is alive on this host: it may still merge the PR or arm it.
  const live = joinWorld("t9161-live", { ids: ["P-LATER"], approver: { pid: liveChild(), host: hostname() } });
  const rows = await live.approve("P-LATER");
  const { row, steps } = approvedRow(rows, "P-LATER");
  assert.equal(live.origin.git("rev-parse", live.priorBranch), live.priorSha, "the PR its live approve is deciding is never written to");
  assert.ok(row, `the approve still filed; steps=${steps}`);
  assert.equal(row.joined, undefined, "it did not join");
  assert.equal(row.pr_url, OWN_PR_URL, "it opened its own PR");

  // CONTROL: the same live pid on ANOTHER host names no process here, so the join goes ahead as it does today.
  const foreign = joinWorld("t9161-foreign", { ids: ["P-ELSEWHERE"], approver: { pid: liveChild(), host: `not-${hostname()}` } });
  assertJoined(foreign, await foreign.approve("P-ELSEWHERE"), "P-ELSEWHERE");
});

test("W1-T9161: a destination push is a plain fast-forward to that branch", () => {
  const calls: string[][] = [];
  withLiveWritesAllowed(() => gitPushRunBranch("/wt", { destination: "run-APPROVE-P-A-1", exec: (_file, args) => void calls.push(args) }));
  assert.deepEqual(calls, [["-C", "/wt", "push", "origin", "HEAD:refs/heads/run-APPROVE-P-A-1"]], "no force, no lease: git's own fast-forward rule decides");
  assert.throws(
    () => withLiveWritesAllowed(() => gitPushRunBranch("/wt", { destination: "run-APPROVE-P-A-1", force: true, exec: () => {} })),
    /destination/,
    "a destination is never forced",
  );
});

/** Each refs/rmd-id/* ref on the origin, with the holder branch its newest commit names. */
function reservationHolders(origin: GitRepo): Array<[string, string]> {
  return origin.git("for-each-ref", "--format=%(refname:short) %(contents:body)", "refs/rmd-id/").split("\n")
    .map((line) => /^(rmd-id\/\S+) rmd-id holder branch=(\S+)/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]);
}

test("the join that loses its push gives back the remote reservation it took for the join", async () => {
  const w = joinWorld("rmd-release-join", { ids: ["P-LOSER"], approver: { pid: deadPid(), host: hostname() } });
  w.seed.git("checkout", "--quiet", w.priorBranch);
  writeFileSync(join(w.seed.dir, "plan", "tasks.d", "W1-T60-the-rival-joiner.yaml"), planTask("W1-T60", "filed by the rival joiner"));
  w.seed.git("add", "-A");
  w.seed.git("commit", "--quiet", "-m", "chore(plan): ratify P-RIVAL via rmd approve");
  const rivalSha = w.seed.git("rev-parse", "HEAD");
  w.seed.git("push", "--quiet", "origin", `${rivalSha}:refs/rival/joiner`);
  w.shim.addRoute({ when: "pulls?state=open", stdout: "[]", writes: { path: join(w.origin.dir, "refs", "heads", w.priorBranch), content: `${rivalSha}\n` } });

  const rows = await w.approve("P-LOSER");
  const { row, steps } = approvedRow(rows, "P-LOSER");
  assert.ok(row, `the loser still filed its own PR; steps=${steps}`);
  const released = rows.filter((r) => r.step === "task_id.reservation_released");
  assert.equal(released.length, 1, `the join's claim was released; steps=${steps}`);
  assert.match(String(released[0]!.reason), /rejected as non-fast-forward/);
  assert.equal(released[0]!.outcome, "released");
  assert.deepEqual(reservationHolders(w.origin).map(([, holder]) => holder), [String(row.branch)], "only the claim its own PR files is still held");
});

test("an approve that fails before its branch is pushed gives back every remote reservation it took", async () => {
  const w = joinWorld("rmd-release-refused", { ids: ["P-BROKEN"], approver: { pid: liveChild(), host: hostname() } });
  // main loses MASTER-PLAN.md, so the stamp write fails AFTER the ids are reserved and BEFORE anything is pushed.
  w.seed.git("checkout", "--quiet", "main");
  w.seed.git("rm", "--quiet", "MASTER-PLAN.md");
  w.seed.git("commit", "--quiet", "-m", "chore: drop the master plan");
  w.seed.git("push", "--quiet", "origin", "main");
  execGit(w.repoDir, "fetch", "--quiet", "origin");

  const rows = await w.approve("P-BROKEN");
  const steps = JSON.stringify(rows.filter((r) => r.task_id === "P-BROKEN").map((r) => r.step));
  assert.ok(rows.some((r) => r.step === "approve.id_materialized" && r.task_id === "P-BROKEN"), `positive control: it reserved before it failed; steps=${steps}`);
  assert.ok(rows.some((r) => r.step === "approve.error" && r.task_id === "P-BROKEN"), `it failed; steps=${steps}`);
  const released = rows.filter((r) => r.step === "task_id.reservation_released");
  assert.equal(released.length, 1, `steps=${steps}`);
  assert.match(String(released[0]!.reason), /^rmd approve P-BROKEN: failed before its branch was pushed: /);
  assert.deepEqual(reservationHolders(w.origin), [], "no refs/rmd-id ref outlives the refused filing");
  assert.deepEqual(w.runBranches(), [w.priorBranch], "and no branch was pushed");
});
