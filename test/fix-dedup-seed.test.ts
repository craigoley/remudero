/**
 * test/fix-dedup-seed.test.ts — W1-T1127.
 *
 * THE DEFECT (see plan/tasks.d/W1-T1127-*.yaml's rationale for the full measured incident).
 * `runSweep`'s dedup gate (`prior.fixed`, sweep.ts's `priorActionsFromLedger`) is seeded from a
 * `sweep.disposed` row carrying `acted: true` — never from a real fix-rung ledger row. It is only
 * ever CLEARED by `fixRungStalledWithoutNewHead`, which reads the fix rung's OWN rows
 * (`fix.dispatch`/`fix.ci_not_green`/`fix.review`/`fix.resolved`), keyed by `task_id`, and its
 * documented contract is "no matching lines means false" (permanently gated, never re-armed).
 *
 * Before this task, `buildSweepEffects`'s `dispatchFix` (run-task.ts) wrapped its ENTIRE body —
 * preflight, `gh pr view`, `git worktree add`/`checkout`, mounts, settings, and the fix-rung
 * dispatch itself — in one `try` whose `catch` logged `sweep.fix.error` and returned NORMALLY,
 * unconditionally. `runSweep` therefore always saw a clean return from `dispatchFix` and recorded
 * `acted: true` regardless of WHERE the throw happened — including a throw before the fix rung
 * ever wrote a single `fix.*` row (the measured incident: `git checkout -B` racing a
 * `.git/config` lock). That seeds `prior.fixed` for a head `fixRungStalledWithoutNewHead` can
 * never re-arm, because it has nothing of its own to read — the gate is stuck forever.
 *
 * THE FIX. `dispatchFix` now tracks whether `runFixRung` demonstrably wrote its own `fix.dispatch`
 * row (`dispatchStarted`, flipped by the `log` closure passed into `runFixRung`'s deps). A throw
 * BEFORE that line propagates out of `dispatchFix` instead of being swallowed, so it reaches
 * `runSweep`'s own `catch` (sweep.ts) — which ALREADY sets `acted = false` there, untouched by
 * this task. A throw AFTER `fix.dispatch` is unchanged: still swallowed, still `acted: true`,
 * because that strike is real.
 *
 * Every test below drives the REAL `buildSweepEffects(...).dispatchFix` wired into a REAL
 * `runSweep` call over a REAL ledger file (never a hand-rolled reimplementation of the dedup
 * fold) — the same discipline test/fix-rung-no-task.test.ts and
 * test/live-write-guard-command-sites.test.ts already established for this exact closure. `gh` is
 * a STUB shell script on PATH (never the live gateway); the "reaches the worker" tests use a real
 * throwaway bare git repo as `origin` (never a live push).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView } from "../src/lib/sweep.js";
import { buildSweepEffects } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

/** The full envelope `workerLedgerFields` reads — an incomplete one throws before the fix rung
 *  can log `fix.dispatch`, which would silently defeat the "reaches the worker" fixtures below. */
function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "W1T1127-SESSION",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    model: "claude-opus-5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0,
    billingMode: "subscription",
    verdict: "success",
    qualitySuspect: false,
    compactionEvents: [],
    childEnvKeys: [],
  } as unknown as WorkerResult;
}

const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function ghShim(dir: string, headRefName: string): void {
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"headRefName"*) printf \'{"headRefName":"%s","body":""}\\n\' ' + JSON.stringify(headRefName) + " ;;",
      '  *"statusCheckRollup"*) echo \'{"statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}]}\' ;;',
      // The REST live-state read `ghLiveState`/`dispatchFixPreflightStandDown` both use
      // (`gh api repos/{owner}/{repo}/pulls/{n}`) — an OPEN, unmerged PR every time, so the
      // preflight never stands the dispatch down for either fixture below.
      '  *"api"*"pulls/"*) echo \'{"state":"open","merged":false}\' ;;',
      "  *) echo '{}' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/acme/w1t1127-repo/pull/1",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "cafe0001",
    autoMergeArmed: false,
    ...over,
  } as OpenPrView;
}

// ── acceptance 1/2/4 (the negative case): a dispatch that throws BEFORE the worker starts ──────

test("W1-T1127: a fix dispatch whose own failure is swallowed no longer records the strike as spent, and it is still ledgered", async () => {
  const root = mkdtempSync(join(tmpdir(), "w1t1127-precrash-"));
  const bin = mkdtempSync(join(tmpdir(), "w1t1127-gh-"));
  const owner = "acme";
  const repo = "w1t1127-precrash-repo"; // never created under root/repos — `git fetch` throws
  const branch = "fix/w1t1127-precrash";
  ghShim(bin, branch);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    // `repos/` exists but the specific repo dir does not — `git -C <missing> fetch` fails
    // synchronously, LOCAL, no network — this IS the measured incident's shape (a git side
    // effect throwing before `runFixRung` is ever reached, i.e. before `fix.dispatch` exists).
    mkdirSync(join(root, "repos"), { recursive: true });
    const ledgerPath = join(root, "ledger.ndjson");
    const runId = "SWEEP-W1T1127-PRECRASH";
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendLedger(ledgerPath, { run_id: runId, task_id: "SWEEP", step, lane: "sweep", ...extra });
    const plan = { tasks: [], byId: new Map() };
    const effects = buildSweepEffects(owner, repo, { root } as never, ledgerPath, runId, plan as never, log, DEFAULT_SWEEP_POLICY);

    const candidate = pr({
      prNumber: 501,
      prUrl: `https://github.com/${owner}/${repo}/pull/501`,
      taskId: undefined, // no plan task -> resolves to a synthetic id, same as a real agent PR
      headSha: "deadbeef01",
    });

    const summary1 = await runSweep([candidate], { ...effects, ledgerPath, runId, log, dryRun: false }, DEFAULT_SWEEP_POLICY);
    assert.equal(summary1.actions[0].acted, false, "the strike must NOT be recorded as spent — this is the fix");
    assert.equal(summary1.actions[0].disposition, "blocked-fixable");

    const lines1 = readLedgerLines(ledgerPath);
    const error1 = lines1.filter((l) => l.step === "sweep.fix.error");
    assert.equal(error1.length, 1, `the failure is still ledgered exactly once; got ${JSON.stringify(lines1.map((l) => l.step))}`);
    assert.ok(typeof error1[0].error === "string" && error1[0].error.length > 0, "the row names the real error");

    const disposed1 = lines1.filter((l) => l.step === "sweep.disposed" && l.pr_number === 501);
    assert.equal(disposed1.length, 1);
    assert.equal(disposed1[0].acted, false, "sweep.disposed carries acted:false — nothing is repaired by going quiet");
    assert.ok(typeof disposed1[0].action_error === "string" && disposed1[0].action_error.length > 0);
    assert.ok(
      lines1.some((l) => l.step === "sweep.action_failed" && l.pr_number === 501),
      "the SAME failure path sweep.ts already used for a genuine throw — untouched by this task",
    );
    assert.ok(
      !lines1.some((l) => l.step === "fix.dispatch"),
      "no fix-rung row exists — the dispatch never reached the worker",
    );

    // THE ACTUAL REGRESSION LOCK: a second pass over the SAME unchanged head must retry, not
    // stand down deduped. Before this fix, `prior.fixed` was seeded by pass 1's (wrongly)
    // `acted:true` row and `fixRungStalledWithoutNewHead` had nothing of its own to read, so
    // this second pass would have read `alreadyDone: true` forever and dispatchFix would never
    // run again — zero further `sweep.fix.error` rows, silently, on every future pass too.
    const summary2 = await runSweep([candidate], { ...effects, ledgerPath, runId, log, dryRun: false }, DEFAULT_SWEEP_POLICY);
    assert.equal(summary2.actions[0].acted, false);
    const lines2 = readLedgerLines(ledgerPath);
    const error2 = lines2.filter((l) => l.step === "sweep.fix.error");
    assert.equal(error2.length, 2, "the dispatch was attempted again — the head was never permanently gated");
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── acceptance 3/4 (the positive case): a dispatch that reaches the worker ──────────────────────

function realRepoFixture(): { bare: string; root: string; bin: string; repo: string; branch: string; owner: string } {
  const owner = "acme";
  const repo = "w1t1127-live-repo";
  const branch = "run-W1T1127FIX-1786500000000";
  const bare = mkdtempSync(join(tmpdir(), "w1t1127-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "w1t1127-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(seed, "work.txt"), "work\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "work");
  git(seed, "push", "--quiet", "origin", branch);
  rmSync(seed, { recursive: true, force: true });

  const root = mkdtempSync(join(tmpdir(), "w1t1127-root-"));
  const bin = mkdtempSync(join(tmpdir(), "w1t1127-gh-"));
  const repoDir = join(root, "repos", repo);
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });
  ghShim(bin, branch);
  return { bare, root, bin, repo, branch, owner };
}

test("W1-T1127: a dispatch that reaches the worker still seeds the dedup exactly as it does today, and two passes over one unchanged head still dispatch only once", async () => {
  const { bare, root, bin, repo, branch, owner } = realRepoFixture();
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    const TASK = "W1T1127FIX";
    const ledgerPath = join(root, "ledger.ndjson");
    const runId = "SWEEP-W1T1127-LIVE";
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendLedger(ledgerPath, { run_id: runId, task_id: "SWEEP", step, lane: "sweep", ...extra });
    const plan = {
      tasks: [{ id: TASK, title: "w1t1127 fixture", repo, type: "implement", risk: "low", verify: "auto", status: "queued", attempts: 0, depends_on: [] }],
      byId: new Map([[TASK, { id: TASK, title: "w1t1127 fixture" }]]),
    };
    let spawnCalls = 0;
    const effects = buildSweepEffects(
      owner,
      repo,
      { claudeBin: "/usr/bin/true", root } as never,
      ledgerPath,
      runId,
      plan as never,
      log,
      DEFAULT_SWEEP_POLICY,
      undefined,
      async () => {
        spawnCalls += 1;
        return fakeWorker("REPORT\nw1t1127 fix applied\n");
      },
    );

    const candidate = pr({
      prNumber: 77,
      prUrl: `https://github.com/${owner}/${repo}/pull/77`,
      taskId: TASK,
      headSha: "cafefeed77",
    });

    const summary1 = await withLiveWritesAllowed(() =>
      runSweep([candidate], { ...effects, ledgerPath, runId, log, dryRun: false }, DEFAULT_SWEEP_POLICY),
    );
    assert.equal(summary1.actions[0].disposition, "blocked-fixable");
    assert.equal(summary1.actions[0].acted, true, "the dispatch reached the worker, so the strike IS recorded as spent — unchanged");
    assert.equal(spawnCalls, 1, "the fix worker was spawned exactly once");

    const lines1 = readLedgerLines(ledgerPath);
    assert.ok(
      lines1.some((l) => l.step === "fix.dispatch" && l.task_id === TASK),
      `a real fix.dispatch row now exists; got ${JSON.stringify(lines1.map((l) => l.step))}`,
    );
    const disposed1 = lines1.filter((l) => l.step === "sweep.disposed" && l.pr_number === 77);
    assert.equal(disposed1.length, 1);
    assert.equal(disposed1[0].acted, true);

    // Second pass, SAME PR object (unchanged headSha) — the dedup gate this task repairs must
    // still hold for the case it was always meant for: a dispatch that genuinely ran.
    const summary2 = await withLiveWritesAllowed(() =>
      runSweep([candidate], { ...effects, ledgerPath, runId, log, dryRun: false }, DEFAULT_SWEEP_POLICY),
    );
    assert.equal(spawnCalls, 1, "no second spawn — the unchanged head deduped exactly as it does today");
    assert.equal(summary2.actions[0].acted, false, "the second pass stands down on the dedup, not a fresh strike");
  } finally {
    process.env.PATH = savedPath;
    for (const d of [bare, root, bin]) rmSync(d, { recursive: true, force: true });
  }
});

// ── acceptance 5: a preflight stand-down is distinguishable from a failed dispatch ──────────────

test("W1-T1127: a preflight stand-down (PR already terminal) is distinguishable on the disposed row from a failed dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "w1t1127-standdown-"));
  const bin = mkdtempSync(join(tmpdir(), "w1t1127-gh-standdown-"));
  const owner = "acme";
  const repo = "w1t1127-standdown-repo";
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      // The preflight's live-state read reports MERGED — a positive terminal reading, the ONE
      // thing `dispatchFixPreflightStandDown` stands down on. No git side effect ever runs.
      '  *"api"*"pulls/"*) echo \'{"state":"merged","merged":true}\' ;;',
      "  *) echo '{}' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const ledgerPath = join(root, "ledger.ndjson");
    const runId = "SWEEP-W1T1127-STANDDOWN";
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendLedger(ledgerPath, { run_id: runId, task_id: "SWEEP", step, lane: "sweep", ...extra });
    const plan = { tasks: [], byId: new Map() };
    const effects = buildSweepEffects(owner, repo, { root } as never, ledgerPath, runId, plan as never, log, DEFAULT_SWEEP_POLICY);

    const candidate = pr({
      prNumber: 902,
      prUrl: `https://github.com/${owner}/${repo}/pull/902`,
      taskId: undefined,
      headSha: "aaaa9020",
    });

    const summary = await runSweep([candidate], { ...effects, ledgerPath, runId, log, dryRun: false }, DEFAULT_SWEEP_POLICY);
    // The sweep's OWN pre-strike terminal check (W1-T177) reads the SAME live state before ever
    // calling dispatchFix — this PR never reaches dispatchFix's preflight at all, and that is the
    // distinguishing shape this criterion asks for: the disposed row's `stand_down_reason` names
    // the terminal state, there is no `actionError` on the returned action, and no
    // `sweep.fix.error`/`sweep.action_failed` row exists (dispatchFix itself was never called).
    assert.equal(summary.actions[0].acted, false);
    assert.equal(summary.actions[0].actionError, undefined, "a stand-down carries NO action error — the failed-dispatch shape's own marker");

    const lines = readLedgerLines(ledgerPath);
    const disposed = lines.filter((l) => l.step === "sweep.disposed" && l.pr_number === 902);
    assert.equal(disposed.length, 1);
    assert.equal(disposed[0].acted, false);
    assert.equal(disposed[0].action_error, undefined, "no action_error field at all — distinct from a failed-dispatch row's non-empty one");
    assert.ok(typeof disposed[0].stand_down_reason === "string" && /MERGED/.test(disposed[0].stand_down_reason as string));
    assert.ok(!lines.some((l) => l.step === "sweep.fix.error"), "dispatchFix's own error step never fires — it was never called");
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
