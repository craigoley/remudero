import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { judgeReview, type ReviewVerdict } from "../src/lib/review.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { OpenPrView, ReviewReuseInputs } from "../src/lib/sweep.js";
import { ghExec, type GhAsyncExecutor } from "../src/lib/github-transport.js";
import type { AsyncGitRunner } from "../src/lib/git-fetch-retry.js";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as prDiffLib from "../src/lib/pr-diff.js";
import * as runTaskLib from "../src/run-task.js";
import { ghShim, type GhShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const fetchPrDiff = (...a: Parameters<typeof prDiffLib.fetchPrDiff>) => Promise.resolve(prDiffLib.fetchPrDiff(...a));
const ghPrDiffAsync: typeof prDiffLib.ghPrDiffAsync = (...a) => prDiffLib.ghPrDiffAsync(...a);
const localPrDiffAsync: typeof prDiffLib.localPrDiffAsync = (...a) => prDiffLib.localPrDiffAsync(...a);
const prDiffSourceAsync: typeof prDiffLib.prDiffSourceAsync = (...a) => prDiffLib.prDiffSourceAsync(...a);

// MEASURED 2026-10-06 (daemon.loop_lag since boot at 0d90c2a98): a sync `gh pr …` through
// ghExecFile held the daemon loop 3.5 s right after `sweep.fix_capacity` — the light pass's
// review-reuse `gh pr diff`, the only `gh pr` read on that path — and runReview read its diff the
// same way. These pin the awaited replacement: the loop keeps running while `gh pr diff` is
// pending, a hung read is killed and the outcome names the timeout, and the awaited reads return
// exactly what the sync ones did. Every `gh` here is a PATH shim or an injected executor.

const URL = "https://github.com/acme/scratch/pull/3704";
const DIFF = "diff --git a/src/review-reuse.ts b/src/review-reuse.ts\n+W1-T3901\n";
const TOO_LARGE = "HTTP 406: Sorry, the diff exceeded the maximum number of files (300).";
const execFileAsync = promisify(execFile);

/** Counts interval ticks while `pending` settles — a loop held by a sync spawn counts almost none. */
async function ticksWhile<T>(pending: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    const value = await pending();
    return { value, ticks };
  } finally {
    clearInterval(timer);
  }
}

/** A `gh` on PATH whose `pr diff` answers DIFF after `delaySeconds`; every other call answers `{}`. */
function onPath(delaySeconds: number): { shim: GhShim; restore(): void } {
  const shim = ghShim([
    { when: "pulls/3704", stdout: '{"state":"open","merged":false}\n' },
    // The shim prints its own trailing newline, so this answers exactly DIFF.
    { when: "pr diff", stdout: DIFF.slice(0, -1), delaySeconds },
    { when: "", stdout: "{}\n" },
  ], { kind: "prdiff-gh" });
  const saved = process.env.PATH;
  process.env.PATH = `${shim.dir}:${saved}`;
  return { shim, restore: () => { process.env.PATH = saved; rmSync(shim.dir, { recursive: true, force: true }); } };
}

/** A shell script standing in for a binary: writes its pid, then hangs. */
function hungBin(name: string): { dir: string; bin: string; pid(): number } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prdiff-hung-"));
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${join(dir, "pid")}\nexec sleep 30\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, pid: () => Number(readFileSync(join(dir, "pid"), "utf8").trim()) };
}

/** True once `pid` is gone (killed AND reaped), polling up to two seconds. */
async function reaped(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH: no such process
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** The sweep's review effects over a ledger holding a prior verdict, so a moved head takes the reuse path. */
function sweepReuse() {
  const root = mkdtempSync(join(tmpdir(), "rmd-prdiff-sweep-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const taskId = "W1-T3901";
  const priorHead = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
  const criterion = { claim: "W1-T3901 proof discrimination observes the current head", proof: "grep: W1-T3901 in src/review-reuse.ts" };
  const prior: ReviewVerdict = judgeReview([criterion], { diff: DIFF, report: "W1-T3901.", headCheckoutDir: "/head", execProof: () => "pass" });
  appendLedger(ledgerPath, { run_id: "prior", task_id: taskId, step: "review.posted", state: prior.state, head_sha: priorHead, pr_url: URL, decision_verdict: prior });
  const effects = runTaskLib.buildSweepEffects({
    owner: "acme",
    repo: "scratch",
    localRepoName: "not-scratch",
    config: { root } as never,
    ledgerPath,
    runId: "prdiff-reuse",
    plan: { tasks: [], byId: new Map([[taskId, { id: taskId, files: [] }]]) } as never,
    log: () => undefined,
    reviewRunner: async () => 0,
    materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
    buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set<string>(), baseIsCheckout: true, addedTestFiles: new Set<string>() }),
    reviewReuseExecProofImpl: (_proof, cwd) => (cwd === "/head" ? "pass" : "fail"),
    worktreeRemoveImpl: () => undefined,
  });
  const pr = {
    prNumber: 3704, prUrl: URL, taskId, reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    // expiring-fixture: exempt -- direct postReview adapter call bypasses stale-days disposition.
    lastActivityAt: "2026-10-06T00:00:00Z",
    headSha: "cafef00dcafef00dcafef00dcafef00dcafef00d", autoMergeArmed: false, body: "W1-T3901.",
    currentOwnDiffDigest: "sha256:current", currentMergeBaseSha: "base-current",
  } as OpenPrView & Partial<ReviewReuseInputs>;
  return { effects, pr, ledgerPath, priorHead, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the sweep's review-reuse diff read keeps a timer firing while gh pr diff is pending", async () => {
  const gh = onPath(0.6);
  const f = sweepReuse();
  try {
    const { ticks } = await ticksWhile(() =>
      withLiveWritesAllowed(async () => {
        await f.effects.postReview!(f.pr, { kind: "discriminate-only", judgedHeadSha: f.priorHead });
      }));
    const posted = readLedgerLines(f.ledgerPath).filter((line) => line.step === "review.posted").at(-1);
    assert.equal(posted?.effective_review_mode, "proof-only-discrimination", "the reuse read its diff and posted its verdict");
    assert.ok(gh.shim.calls().some((c) => c === `pr diff ${URL}`), "the diff came from `gh pr diff`");
    assert.ok(ticks >= 15, `the loop must keep servicing timers while gh pr diff is pending (ticked ${ticks})`);
  } finally {
    gh.restore();
    f.cleanup();
  }
});

test("the review's diff read keeps a timer firing while gh pr diff is pending", async () => {
  const gh = onPath(0.6);
  try {
    const { value, ticks } = await ticksWhile(() => fetchPrDiff(URL, "cafef00d", prDiffSourceAsync("/nonexistent-checkout")));
    assert.deepEqual(value, { kind: "ok", diff: DIFF, source: "api" });
    assert.ok(ticks >= 15, `the loop must keep servicing timers while gh pr diff is pending (ticked ${ticks})`);
  } finally {
    gh.restore();
  }
});

test("a pr diff read killed at its bound refuses the review naming the timeout", async () => {
  const gh = hungBin("hung-gh-cli");
  const git = hungBin("hung-git-cli");
  try {
    const execAsync = ((_file: string, args: readonly string[], opts: Parameters<GhAsyncExecutor>[2]) =>
      execFileAsync(gh.bin, [...args], opts)) as unknown as GhAsyncExecutor;
    const outcome = await fetchPrDiff(URL, "cafef00d", {
      api: (u) => ghPrDiffAsync(u, { timeoutMs: 150, execAsync }),
      local: () => assert.fail("a timed-out API read is not the size cap and must not reach the local fallback"),
    });
    assert.deepEqual(outcome, { kind: "refused", reason: `could not read the diff for ${URL}: gh pr diff timed out after 150ms and was killed` });
    assert.throws(() => process.kill(gh.pid(), 0), /ESRCH/, "the hung gh was killed, not abandoned");

    const hungGit: AsyncGitRunner = (args, signal) =>
      new Promise((resolve, reject) => {
        execFile(git.bin, args, { signal }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
      });
    const local = await fetchPrDiff(URL, "cafef00d", {
      api: () => { throw new Error(TOO_LARGE); },
      local: (sha) => localPrDiffAsync("/nonexistent-checkout", sha, { timeoutMs: 150, git: hungGit }),
    });
    assert.equal(local.kind, "refused");
    assert.match(local.kind === "refused" ? local.reason : "", /local fallback failed \(git diff origin\/main\.\.\.cafef00d exceeded its 150ms bound and was killed/);
    assert.equal(await reaped(git.pid()), true, "the hung git was killed, not abandoned");
  } finally {
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(git.dir, { recursive: true, force: true });
  }
});

test("the awaited and sync pr diff reads answer identically", async () => {
  const gh = onPath(0);
  const origin = gitRepo({ bare: true, kind: "prdiff-origin" });
  const work = gitRepo({ kind: "prdiff-work" });
  try {
    const sync = String(ghExec(["pr", "diff", URL], { encoding: "utf8", maxBuffer: 1 << 26 }));
    const awaited = await ghPrDiffAsync(URL);
    assert.equal(awaited, sync);
    assert.equal(awaited, DIFF);
    assert.deepEqual(gh.shim.calls(), [`pr diff ${URL}`, `pr diff ${URL}`], "the same argv, both ways");

    // The local fallback on a real checkout: origin/main, and a head commit past it.
    work.addRemote("origin", origin.dir);
    work.git("push", "--quiet", "origin", "main");
    work.git("fetch", "--quiet", "origin");
    writeFileSync(join(work.dir, "change.txt"), "a change — wide ✓\n");
    work.git("add", "change.txt");
    work.git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--quiet", "-m", "head");
    const sha = work.git("rev-parse", "HEAD");
    const syncLocal = execFileSync("git", ["-C", work.dir, "diff", `origin/main...${sha}`], { encoding: "utf8", maxBuffer: 1 << 26 });
    assert.match(syncLocal, /\+a change — wide ✓/, "the fixture's diff must be non-empty, or the comparison is vacuous");
    assert.equal(await localPrDiffAsync(work.dir, sha), syncLocal);
    const viaSource = await fetchPrDiff(URL, sha, { ...prDiffSourceAsync(work.dir), api: () => { throw new Error(TOO_LARGE); } });
    assert.deepEqual(viaSource, { kind: "ok", diff: syncLocal, source: "local" });
  } finally {
    gh.restore();
    origin.cleanup();
    work.cleanup();
  }
});
