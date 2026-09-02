import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { gitPushRunBranch, LanePushForeignHeadError, type PushExec, type GitCapture } from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { runFixRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * W1-T2610 — `gitPushRunBranch` CANNOT TELL "I PUSHED MY COMMIT" FROM "I HAD NOTHING TO PUSH".
 *
 * THE INCIDENT (DAEMON-1788016810368 / PR #3261): a fix round's own local commit went missing
 * BETWEEN `git commit` and `git push`. `git -C <wt> push origin HEAD` against a worktree whose
 * ref was rewound back to the remote tip is a LEGAL, zero-ref fast-forward — exit 0, nothing
 * transferred, nothing read (the two fix-rung sites run with `stdio: "ignore"`) — so the round
 * proceeded as though its work had landed. A plain non-fast-forward check can never catch this:
 * the whole point is that pushing nothing is not a disagreement, it is an agreement on the wrong
 * sha (`gitPushEmptyCommit`'s own W1-T1288 header names the same trap on the read side).
 *
 * Part A exercises the LEAF (`gitPushRunBranch`) directly with injected `capture`/`exec`, the
 * same style `test/lane-push-foreign-head.test.ts` already uses for its sibling
 * `gitPushEmptyCommit`. Part B drives the REAL `runFixRung` — the shared function both fix-rung
 * call sites (`src/run-task.ts`'s run-loop and sweep `push:` closures) route through — over a
 * real bare-origin git repo, reproducing the incident's own timing: a commit lands, the ref gets
 * rewound during the rung's own dead time (the `readRoundCommits` read, ledger writes, follow-up
 * harvest — all of it BETWEEN the worker returning and the push), and the push must refuse
 * rather than silently report success.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname; // no fixtures under test/ needed; kept for parity with sibling command-site tests

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

// ══════════════════════════════════════════════════════════════════════════════════════
// PART A — THE LEAF: gitPushRunBranch's own post-condition
// ══════════════════════════════════════════════════════════════════════════════════════

function spies(): { pushed: string[][]; captured: string[][] } {
  return { pushed: [], captured: [] };
}

// ── claim 1 — ZERO REFS PUSHED (the rewound-ref case) RAISES, NAMING BOTH SHAS ──────────────

test("W1-T2610: a rewound worktree (HEAD no longer the committed sha) RAISES LanePushForeignHeadError naming expected+observed, and never runs the push", () => {
  const { pushed, captured } = spies();
  const committedSha = "newsha0000000000000000000000000000000000";
  const rewoundHeadSha = "oldsha0000000000000000000000000000000000"; // the remote tip it got reset to
  const capture: GitCapture = (_file, args) => {
    captured.push(args);
    assert.deepEqual(args, ["-C", "/wt", "rev-parse", "HEAD"], "reads the worktree's own HEAD, nothing else");
    return `${rewoundHeadSha}\n`;
  };
  const exec: PushExec = (_file, args) => {
    pushed.push(args);
  };

  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        gitPushRunBranch("/wt", { stdio: "ignore", expectedHeadSha: committedSha, capture, exec }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof LanePushForeignHeadError, "reuses the module's existing error class");
      assert.equal(err.expectedHeadSha, committedSha, "names the sha the caller believed it was landing");
      assert.match(err.message, new RegExp(committedSha), "the message names the expected sha");
      assert.match(err.message, new RegExp(rewoundHeadSha), "the message names the observed (rewound) sha");
      return true;
    },
  );
  assert.equal(pushed.length, 0, "a mismatch is caught BEFORE the push runs — nothing is transferred at all");
  assert.equal(captured.length, 1, "exactly one local HEAD read — no retry, no second guess");
});

// ── claim 2a — A GENUINE MATCH RETURNS EXACTLY AS TODAY ─────────────────────────────────────

test("W1-T2610: a worktree whose HEAD IS the committed sha pushes normally and returns void, unchanged from before this task", () => {
  const { pushed, captured } = spies();
  const committedSha = "abc1230000000000000000000000000000000000";
  const capture: GitCapture = (_file, args) => {
    captured.push(args);
    return `${committedSha}\n`;
  };
  const exec: PushExec = (_file, args) => {
    pushed.push(args);
  };

  const result = withLiveWritesAllowed(() =>
    gitPushRunBranch("/wt", { expectedHeadSha: committedSha, capture, exec }),
  );

  assert.equal(result, undefined, "still returns void — no new success-path return value was invented");
  assert.equal(captured.length, 1, "the post-condition read happened");
  assert.deepEqual(pushed[0], ["-C", "/wt", "push", "origin", "HEAD"], "the argv git actually runs is unchanged");
});

// ── claim 2b — OMITTING expectedHeadSha IS BYTE-IDENTICAL TO PRE-W1-T2610 BEHAVIOUR ─────────

test("W1-T2610: omitting expectedHeadSha never reads the worktree's HEAD at all — the seven non-fix call sites are untouched", () => {
  const { pushed, captured } = spies();
  const exec: PushExec = (_file, args, opts) => {
    pushed.push(args);
    assert.equal(opts.stdio, "inherit", "default stdio is unchanged when no expectedHeadSha is supplied");
  };

  const result = withLiveWritesAllowed(() =>
    gitPushRunBranch("/wt", { exec, capture: () => assert.fail("capture must never run when expectedHeadSha is omitted") }),
  );

  assert.equal(result, undefined);
  assert.equal(captured.length, 0, "no HEAD read at all — zero added cost/behaviour for every caller that doesn't opt in");
  assert.deepEqual(pushed[0], ["-C", "/wt", "push", "origin", "HEAD"], "argv exactly matches the pre-W1-T2610 shape");
});

test("W1-T2610: setUpstream/force still compose with an omitted expectedHeadSha exactly as before (spike.ts's push-fallback, the two amend sites)", () => {
  const { pushed } = spies();
  const exec: PushExec = (_file, args) => pushed.push(args);
  withLiveWritesAllowed(() => gitPushRunBranch("/wt", { setUpstream: true, force: true, exec }));
  assert.deepEqual(pushed[0], ["-C", "/wt", "push", "-u", "--force", "origin", "HEAD"]);
});

// ── claim 3 — REUSES LanePushForeignHeadError, NEVER A SECOND CLASS FOR THE SAME FACT ───────
// (also proven structurally: `grep LanePushForeignHeadError src/lib/git-push.ts` — this test
// pins the RUNTIME behaviour the grep's static claim depends on.)

test("W1-T2610: the raised error IS gitPushEmptyCommit's own LanePushForeignHeadError, not a lookalike", () => {
  let caught: unknown;
  try {
    withLiveWritesAllowed(() =>
      gitPushRunBranch("/wt", {
        expectedHeadSha: "a",
        capture: () => "b\n",
        exec: () => assert.fail("must not push on a mismatch"),
      }),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LanePushForeignHeadError);
  assert.equal((caught as Error).name, "LanePushForeignHeadError");
});

// ── claim 5 — HOLDS WITH stdio IGNORED, THE FIX-RUNG SITES' OWN OPTION ───────────────────────

test("W1-T2610: the post-condition holds with stdio: 'ignore' — it never reads the push's own (discarded) output", () => {
  const { pushed, captured } = spies();
  const capture: GitCapture = (_file, args) => {
    captured.push(args);
    return "rewound-to-remote-tip\n";
  };
  const exec: PushExec = (_file, args, opts) => {
    // If this ran at all, it means the guard failed to fire before the push — but assert its
    // own stdio too, so a future refactor that starts reading push output can't silently
    // reintroduce the dependency this claim rules out.
    assert.equal(opts.stdio, "ignore");
    pushed.push(args);
  };
  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        gitPushRunBranch("/wt", { stdio: "ignore", expectedHeadSha: "committed-sha", capture, exec }),
      ),
    LanePushForeignHeadError,
  );
  assert.equal(pushed.length, 0, "exec (whose stdio is ignored) never ran — the detection lives entirely in `capture`");
  assert.equal(captured.length, 1, "one capture call is the whole mechanism");
});

// ══════════════════════════════════════════════════════════════════════════════════════
// PART B — THE WIRING: the two fix-rung call sites actually pass the committed sha
// ══════════════════════════════════════════════════════════════════════════════════════

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    testTheater: false,
    summary: "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function workerResult(): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 0,
    numTurns: 1,
    text: "fix applied",
    blocks: ["fix applied"],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** The EXACT shape both `src/run-task.ts` `push:` closures use — literal duplicate so this test
 *  proves what production actually runs, not a paraphrase of it. */
function productionShapedPush(pushed: Array<{ wt: string; branch: string; expectedHeadSha?: string }>) {
  return (wt: string, branch: string, expectedHeadSha?: string): void => {
    pushed.push({ wt, branch, expectedHeadSha });
    try {
      gitPushRunBranch(wt, { stdio: "ignore", expectedHeadSha });
    } catch (err) {
      if (err instanceof LanePushForeignHeadError) throw err;
      // best-effort — the fix worker may already have pushed itself; nothing new to push is
      // not an error. (Same catch shape as both production call sites.)
    }
  };
}

/** A throwaway bare origin + a real worktree cloned from it, seeded with one commit on `branch`
 *  ahead of `main` — the state a fix-rung dispatch always starts from. Returns the branch's own
 *  sha at that point (`oldSha`, what a rewind lands back on) and the worktree path. */
function seedFixRungRepo(branch: string): { bare: string; wt: string; oldSha: string; cleanup: () => void } {
  const bare = mkdtempSync(join(tmpdir(), "headconfirm-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "headconfirm-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(seed, "work.txt"), "pre-existing work\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "pre-existing fix-rung work");
  git(seed, "push", "--quiet", "origin", branch);
  const oldSha = git(seed, "rev-parse", "HEAD").trim();
  rmSync(seed, { recursive: true, force: true });

  const wt = mkdtempSync(join(tmpdir(), "headconfirm-wt-"));
  execFileSync("git", ["clone", "--quiet", "-b", branch, bare, wt], { encoding: "utf8", env: GIT_ENV });
  git(wt, "config", "user.name", "t");
  git(wt, "config", "user.email", "t@t");

  return {
    bare,
    wt,
    oldSha,
    cleanup: () => {
      for (const d of [bare, wt]) rmSync(d, { recursive: true, force: true });
    },
  };
}

function fixRungOpts(branch: string, worktreePath: string) {
  return {
    taskId: "W1-XREW",
    runId: "W1-XREW-1788000000000",
    task: { id: "W1-XREW", title: "fixture" },
    prUrl: "https://github.com/acme/remudero/pull/9001",
    branch,
    worktreePath,
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/headconfirm-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 1,
    retriggerCap: 1,
    // ci-log mode (noReviewYet = ciFailures !== undefined) — the shape a fix-rung round takes
    // when dispatched off a red required check, one of the two modes both real call sites serve.
    ciFailures: [{ name: "ci", logTail: "build failed" }],
    initialReview: fakeReview("sha-0"),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktreePath, reviewerMount: FIX_RUNG_MOUNT },
  };
}

function fakeIssues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/9002" };
}

// ── claim 4 — THE COMMITTED SHA IS WIRED THROUGH, NOT MERELY ACCEPTED ───────────────────────

test("W1-T2610: a ref rewound during the fix rung's own dead time (between the worker returning and the push) is caught — the round throws, nothing reaches origin", async () => {
  const branch = "run-W1-XREW-1788000000001";
  const repo = seedFixRungRepo(branch);
  let committedSha = "";
  const pushed: Array<{ wt: string; branch: string; expectedHeadSha?: string }> = [];
  try {
    const rung = withLiveWritesAllowed(() =>
      runFixRung({
        ...fixRungOpts(branch, repo.wt),
        deps: {
          spawn: async () => {
            // THE FIX WORKER'S OWN COMMIT — real git, in the real worktree.
            writeFileSync(join(repo.wt, "work.txt"), "the actual fix\n");
            git(repo.wt, "add", "-A");
            git(repo.wt, "commit", "--quiet", "-m", "fix: repair the regression");
            committedSha = git(repo.wt, "rev-parse", "HEAD").trim();
            return workerResult();
          },
          // THE INCIDENT ITSELF, reproduced deterministically: something rewinds the local ref
          // back to the remote tip DURING this rung's own dead time — readRoundCommits is the
          // read that sits in exactly that window (see run-task.ts's own W1-T2610 comment).
          readRoundCommits: async () => {
            git(repo.wt, "reset", "--hard", repo.oldSha);
            return [];
          },
          waitForCiGreen: async () => "red",
          runReview: async () => {
            throw new Error("must never be called — CI never went green in this fixture");
          },
          push: productionShapedPush(pushed),
          issues: fakeIssues(),
          ledgerPath: join(mkdtempSync(join(tmpdir(), "headconfirm-ledger-")), "ledger.ndjson"),
          log: () => {},
          say: () => {},
          account: (r) => r,
        },
      }),
    );
    await assert.rejects(rung, (err: unknown) => {
      assert.ok(err instanceof LanePushForeignHeadError, `expected LanePushForeignHeadError, got ${err}`);
      assert.equal(err.expectedHeadSha, committedSha, "the sha threaded to the leaf is the ROUND's own committed sha");
      return true;
    });

    assert.equal(pushed.length, 1, "the push closure ran exactly once");
    assert.equal(pushed[0]?.expectedHeadSha, committedSha, "run-task.ts wired the just-committed sha, not an omitted/stale one");
    assert.notEqual(committedSha, repo.oldSha, "sanity: the worker's commit really did move HEAD before the rewind");

    const originHead = git(repo.bare, "rev-parse", `refs/heads/${branch}`).trim();
    assert.equal(originHead, repo.oldSha, "nothing reached origin — the raise fired BEFORE any push executed");
  } finally {
    repo.cleanup();
  }
});

// ── claim 2 (wiring control) — AN UNDISTURBED ROUND STILL PUSHES NORMALLY ───────────────────

test("W1-T2610: control — with no rewind, the same wiring pushes normally and origin ends up at the committed sha", async () => {
  const branch = "run-W1-XREW-1788000000002";
  const repo = seedFixRungRepo(branch);
  let committedSha = "";
  const pushed: Array<{ wt: string; branch: string; expectedHeadSha?: string }> = [];
  try {
    let threw: unknown;
    try {
      await withLiveWritesAllowed(() =>
        runFixRung({
          ...fixRungOpts(branch, repo.wt),
          deps: {
            spawn: async () => {
              writeFileSync(join(repo.wt, "work.txt"), "the actual fix\n");
              git(repo.wt, "add", "-A");
              git(repo.wt, "commit", "--quiet", "-m", "fix: repair the regression");
              committedSha = git(repo.wt, "rev-parse", "HEAD").trim();
              return workerResult();
            },
            readRoundCommits: async () => [], // nothing disturbs the ref this round
            waitForCiGreen: async () => "red",
            runReview: async () => {
              throw new Error("must never be called — CI never went green in this fixture");
            },
            push: productionShapedPush(pushed),
            issues: fakeIssues(),
            ledgerPath: join(mkdtempSync(join(tmpdir(), "headconfirm-ledger-")), "ledger.ndjson"),
            log: () => {},
            say: () => {},
            account: (r) => r,
          },
        }),
      );
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, undefined, `an undisturbed round must not raise; got ${threw}`);
    assert.equal(pushed[0]?.expectedHeadSha, committedSha);
    const originHead = git(repo.bare, "rev-parse", `refs/heads/${branch}`).trim();
    assert.equal(originHead, committedSha, "the committed sha actually landed on origin — the guard is not a false-positive trap");
  } finally {
    repo.cleanup();
  }
});

// ── claim 4 (structural) — BOTH literal call sites carry the wiring, not just one ───────────

test("W1-T2610: both fix-rung push closures in src/run-task.ts pass expectedHeadSha to gitPushRunBranch (grep-verifiable)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  const matches = src.match(/gitPushRunBranch\(wt, \{ stdio: "ignore", expectedHeadSha \}\);/g) ?? [];
  assert.equal(
    matches.length,
    2,
    `expected exactly the two fix-rung call sites (run-loop + sweep) to wire expectedHeadSha, found ${matches.length}`,
  );
});
