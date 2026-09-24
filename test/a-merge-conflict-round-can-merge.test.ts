/**
 * test/a-merge-conflict-round-can-merge.test.ts — W1-T4458.
 *
 * THE DEFECT (MEASURED 2026-09-24, the fix.done rows since 2026-09-23T15:59Z). A shell-less
 * merge-conflict fix round was told TWO contradictory things in the SAME prompt: its mode-
 * specific paragraph said "your target: MERGE origin/main into this SAME branch ... resolve the
 * conflicting file(s) below, then push", while the harnessCommits footer said "Do NOT run git or
 * gh — you have no shell on this round". Nothing in the worktree ever actually started a merge,
 * so a worker that obeyed "no shell" (W1-T4430's 10:24Z/11:09Z rounds) had no conflict markers to
 * resolve and left the tree untouched ("the worker changed nothing"); a worker that kept `Bash`
 * in its tool list despite the footer (W1-T4100 22:11Z, FIX_WORKER_TOOLS unconditionally includes
 * it) merged and committed ITSELF — and the harness, calling `harnessCommitForShellLessWorker`
 * with `commitCount` HARDCODED to 0, read the now-clean tree as "the worker changed nothing" too
 * and silently discarded a real commit: the refusal's early return in `runFixRung` never reaches
 * `deps.push`.
 *
 * THE FIX, THREE DESIGN POINTS (the task's own `design:` field).
 *   (i)   The harness runs `git merge --no-commit --no-ff origin/main` in the worktree BEFORE the
 *         worker is spawned (`startShellLessMergeConflictMerge`) — so the worker's Read/Write/Edit
 *         turn only ever resolves real conflict markers already in the tree, and the harness's own
 *         commit step completes the pending two-parent merge once those edits land.
 *   (ii)  `commitCount` fed into `harnessCommitForShellLessWorker` is the REAL commits-ahead of
 *         this round's own starting head (read fresh, right before the worker runs), never a
 *         hardcoded 0 — so a commit the worker made (worker-committed or harness-committed) is
 *         recognised and pushed, never mistaken for a clean tree and dropped.
 *   (iii) `Bash` is dropped from the fix rung's PRIMARY tool surface (`tools:`, not only the
 *         auction-divert `cashTools:`) whenever the harness owns this round's commit — so the
 *         prompt ("you have no shell") and the actual tool list can never disagree again.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  commitWorkerEdits,
  runFixRung,
  startShellLessMergeConflictMerge,
} from "../src/run-task.js";
import { FIX_WORKER_TOOLS, FIX_WORKER_TOOLS_HARNESS_COMMITS } from "../src/lib/fix-fence.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const CONFLICT_FILE = "conflict.txt";

/**
 * A PR branch checkout genuinely diverged from `origin/main` on the SAME lines of the SAME file —
 * `upstream` plays the role of `origin`, `wt` the role of this round's `opts.worktreePath`, and
 * `wt`'s `origin/main` remote-tracking ref (set up by `git clone`, then refreshed by one `fetch`)
 * really does disagree with `wt`'s own `HEAD`, so `git merge` on it produces a REAL conflict —
 * never a synthetic file with conflict markers typed in by the fixture.
 */
function conflictedCheckout(kind: string): { upstream: GitRepo; wt: GitRepo } {
  const upstream = gitRepo({ kind: `${kind}-upstream`, seedCommit: true, branch: "main" });
  writeFileSync(join(upstream.dir, CONFLICT_FILE), "base line\n");
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "seed conflict file");

  const wt = gitRepo({ kind: `${kind}-branch`, cloneFrom: upstream.dir });

  // This branch's OWN change (what a task's earlier rounds committed).
  writeFileSync(join(wt.dir, CONFLICT_FILE), "base line\nours\n");
  wt.git("add", "-A");
  wt.git("commit", "-m", "branch: our own change");

  // origin/main ADVANCES concurrently, on the SAME line.
  writeFileSync(join(upstream.dir, CONFLICT_FILE), "base line\ntheirs\n");
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "main: a concurrent change");

  // Refresh the local remote-tracking ref — the one git command a real fix rung's own
  // pre-dispatch fetch already performs, kept explicit here rather than assumed.
  wt.git("fetch", "origin");

  return { upstream, wt };
}

function worker(text: string, over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 1,
    numTurns: 2,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha: string,
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "the conflict resolved cleanly" : "still conflicted",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

test("W1-T4458: the harness starts the merge a shell-less conflict round resolves", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4458-start-"));
  const { wt } = conflictedCheckout("w1t4458-start");
  try {
    const before = wt.git("rev-parse", "HEAD");

    // (i) THE HARNESS STARTS THE MERGE, not the worker.
    const started = startShellLessMergeConflictMerge(wt.dir);
    assert.equal(started.started, true, started.reason);
    // HEAD never moves — only a `git commit` (the harness's own step, below) creates a new one.
    assert.equal(wt.git("rev-parse", "HEAD"), before, "starting the merge must not itself commit");

    // A live MERGE_HEAD — the ONE fact a shell-less worker's plain Read/Write/Edit turn can rely
    // on without ever running `git status`/`git diff` itself.
    assert.doesNotThrow(() => wt.git("rev-parse", "--verify", "-q", "MERGE_HEAD"));

    // Real conflict markers, not evidence text the prompt merely described.
    const conflicted = readFileSync(join(wt.dir, CONFLICT_FILE), "utf8");
    assert.match(conflicted, /^<<<<<<< /m);
    assert.match(conflicted, /^=======$/m);
    assert.match(conflicted, /^>>>>>>> /m);

    // IDEMPOTENT: a resumed strike that finds the merge already started never re-merges onto it.
    const again = startShellLessMergeConflictMerge(wt.dir);
    assert.equal(again.started, true);
    assert.equal(
      readFileSync(join(wt.dir, CONFLICT_FILE), "utf8"),
      conflicted,
      "re-invoking must be a no-op, never a second merge attempt",
    );

    // The WORKER'S turn: Read/Write/Edit only — resolve the markers by hand, no git tool needed.
    writeFileSync(join(wt.dir, CONFLICT_FILE), "base line\nresolved by the worker\n");

    // THE HARNESS COMPLETES THE PENDING MERGE — a genuine two-parent commit, not a squash of
    // either side, because `git commit` picks up the live `MERGE_HEAD` `startShellLessMergeConflictMerge`
    // left behind.
    const landed = commitWorkerEdits(wt.dir, [CONFLICT_FILE], "fix(x): resolve the merge conflict");
    assert.equal(landed.committed, true, landed.reason);
    const parents = wt.git("log", "-1", "--format=%P", "HEAD").split(/\s+/).filter(Boolean);
    assert.equal(parents.length, 2, "the harness's commit must carry BOTH parents — a real merge, not a squash");
    assert.equal(
      readFileSync(join(wt.dir, CONFLICT_FILE), "utf8"),
      "base line\nresolved by the worker\n",
      "the committed tree is the worker's resolved content, no markers left behind",
    );
  } finally {
    wt.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4458: a real conflict that never happened is refused, never invented", () => {
  // Control for the test above: on a CLEAN clone with nothing to merge, `startShellLessMergeConflictMerge`
  // either fast-forwards (git refuses --no-ff, `started: false`) or reports a real failure — it
  // must never fabricate a MERGE_HEAD/conflict where none exists.
  const clean = gitRepo({ kind: "w1t4458-clean", seedCommit: true });
  try {
    clean.git("remote", "add", "origin", clean.dir);
    clean.git("fetch", "origin");
    const result = startShellLessMergeConflictMerge(clean.dir);
    // Either arm is acceptable — the falsifier is a fabricated MERGE_HEAD, which the assertion
    // below rules out unconditionally.
    assert.doesNotThrow(() => {
      try {
        clean.git("rev-parse", "--verify", "-q", "MERGE_HEAD");
        assert.fail("a no-op merge (branch already == origin/main) must never leave a live MERGE_HEAD");
      } catch (e) {
        if ((e as Error).message.includes("must never leave")) throw e;
        // expected: MERGE_HEAD really is absent
      }
    });
    assert.equal(typeof result.started, "boolean");
  } finally {
    clean.cleanup();
  }
});

test("W1-T4458: the fix rung's tools and prompt agree about who holds git", () => {
  // (iii) Bash is dropped from the PRIMARY surface, not only the auction-divert `cashTools`.
  assert.ok(FIX_WORKER_TOOLS.includes("Bash"), "sanity: the shell-bearing surface really carries Bash");
  assert.equal(FIX_WORKER_TOOLS_HARNESS_COMMITS.includes("Bash"), false, "a harness-commits round must lose Bash");
  for (const tool of FIX_WORKER_TOOLS) {
    if (tool === "Bash") continue;
    assert.ok(FIX_WORKER_TOOLS_HARNESS_COMMITS.includes(tool), `${tool} must not be dropped by narrowing to no-shell`);
  }

  // The prompt agrees: a harnessCommits merge-conflict round is never told to run `git merge`
  // itself, and a shell-bearing one keeps the original instruction unchanged.
  const evidence = {
    mergeConflict: { files: [{ path: CONFLICT_FILE, oursDeleted: 1, theirsDeleted: 1 }], oursLog: "abc", theirsLog: "def" },
  };
  const shellPrompt = renderFixPrompt({ task: { id: "W1-T4458X", title: "t" }, round: 1, branch: "run-x", evidence } as never);
  assert.match(shellPrompt, /Your target: MERGE origin\/main into this SAME branch/);
  assert.doesNotMatch(shellPrompt, /Do NOT run git or gh/);

  const harnessPrompt = renderFixPrompt({
    task: { id: "W1-T4458X", title: "t" },
    round: 1,
    branch: "run-x",
    evidence,
    harnessCommits: true,
  } as never);
  assert.doesNotMatch(harnessPrompt, /Your target: MERGE origin\/main into this SAME branch/, "never told to run git merge itself");
  assert.match(harnessPrompt, /the harness has already run `git merge --no-commit`/);
  assert.match(harnessPrompt, /Do NOT run git or gh/);
});

test("W1-T4458: a commit the worker made is pushed, not discarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4458-push-"));
  const { wt } = conflictedCheckout("w1t4458-push");
  try {
    const startSha = wt.git("rev-parse", "HEAD");
    const spawnArgs: SpawnWorkerArgs[] = [];
    const pushed: Array<{ worktreePath: string; branch: string; sha?: string }> = [];
    const lines: Array<{ step: string } & Record<string, unknown>> = [];
    let workerCommitSha: string | undefined;

    const run = {
      taskId: "W1-T4458X",
      runId: "W1-T4458X-run",
      task: { id: "W1-T4458X", title: "resolve the conflict", files: [CONFLICT_FILE] },
      prUrl: "https://github.com/acme/remudero/pull/4458",
      branch: "run-W1-T4458X-1",
      worktreePath: wt.dir,
      initialSessionId: "initial-session",
      mount: MOUNT,
      settingsFile: join(root, "settings.json"),
      config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10,
      strikeCap: 1,
      initialReview: fakeReview("failure", [criterion({ claim: "the conflict resolves", met: false, reason: "dirty merge state" })], startSha),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
      mergeConflict: { files: [{ path: CONFLICT_FILE, oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" },
      deps: {
        spawn: async (args: SpawnWorkerArgs) => {
          spawnArgs.push(args);
          // (i) The harness must have ALREADY started the merge before this worker ever ran.
          assert.doesNotThrow(() => wt.git("rev-parse", "--verify", "-q", "MERGE_HEAD"));
          const conflicted = readFileSync(join(wt.dir, CONFLICT_FILE), "utf8");
          assert.match(conflicted, /^<<<<<<< /m, "the worker must see real conflict markers");

          // Resolve it (Read/Write/Edit shape).
          writeFileSync(join(wt.dir, CONFLICT_FILE), "base line\nresolved together\n");

          // THE BUG THIS TEST REPRODUCES: `Bash` is STILL in this round's tools on a misconfigured
          // mount, so the worker merges and commits ITSELF despite being told it has no shell —
          // exactly the W1-T4100 22:11Z shape. This is what the harness's own commit step, reading
          // the REAL commits-ahead of `startSha` rather than a hardcoded 0, must now recognise and
          // push rather than discard as "the worker changed nothing".
          wt.git("add", "-A");
          wt.git("commit", "-m", "fix: worker self-committed the merge (leftover Bash)");
          workerCommitSha = wt.git("rev-parse", "HEAD");

          // Deliberately NO `COMMIT_MESSAGE:` line — if the harness ever fell through to
          // `commitWorkerEdits` (the pre-fix, hardcoded-0 path) it could not even ask for one.
          return worker("REPORT\nresolved the conflict via a local merge.\nPR_URL: (unchanged)");
        },
        waitForCiGreen: async () => "green" as const,
        fetchPrBody: async () => "REPORT\nresolved the conflict via a local merge.",
        runReview: async () => fakeReview("success", [criterion({ claim: "the conflict resolves", met: true })], workerCommitSha!),
        push: (worktreePath: string, branch: string, sha?: string) => {
          pushed.push({ worktreePath, branch, sha });
        },
        issues: issues(),
        ledgerPath: join(root, "ledger.ndjson"),
        log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, ...(extra ?? {}) }),
        say: () => {},
        account: (result: WorkerResult) => result,
      },
    };

    const outcome = await runFixRung(run as never);

    // (i) The harness really did start the merge before dispatch.
    assert.ok(lines.some((l) => l.step === "fix.merge_started"), "the merge-start step must be ledgered");

    // (ii) THE WHOLE POINT: the worker's own commit was recognised and PUSHED, never discarded.
    assert.equal(pushed.length, 1, "a refused/discarded commit never reaches deps.push");
    assert.equal(pushed[0]!.sha, workerCommitSha, "the pushed sha is the worker's own merge commit");
    assert.equal(
      lines.some((l) => l.step === "fix.commit_refused"),
      false,
      "the round must never read this as a refusal",
    );
    assert.equal(
      lines.some((l) => l.step === "implement.harness_commit_refused"),
      false,
      "the pre-fix bug: hardcoded commitCount:0 re-reads the now-clean tree as 'changed nothing'",
    );
    assert.notEqual(outcome.outcome, "stood_down", "a discarded commit used to stand the rung down silently");
    assert.equal(outcome.outcome, "fixed");

    // (iii) The tools this round actually got agree with what it was told — no leftover Bash on
    // the NEXT round this fixture would dispatch, closing the exact gap that let this one happen.
    assert.equal(spawnArgs[0]!.tools?.includes("Bash"), false, "a harness-commits round must never be handed Bash");
  } finally {
    wt.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
