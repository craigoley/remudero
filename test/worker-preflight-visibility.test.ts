/**
 * The implement worker's own preflight verdict reaches the orchestrator.
 *
 * THE GAP. `rmd preflight` writes a machine-readable verdict to
 * `<repoRoot>/coverage/preflight-summary.json` — unconditionally, on FAIL as well as PASS
 * (`preflightCommand`, src/run-task.ts). But `repoRoot` for a worker is ITS worktree, and nothing
 * ever read that file back. So a worker that burned its turns fighting a failing check printed the
 * step name into a transcript the orchestrator never parses, and the run ended `no_pr`/`failed`
 * with the single most diagnostic fact about it discarded.
 *
 * THE FACT THE DESIGN RESTS ON, established from source and re-proved behaviourally below: THE
 * WORKTREE OUTLIVES THE SPAWN. `runTask` calls `worktreeAdd` before its try block; every
 * `worktreeRemove` in it sits inside a verdict branch — `failOnWorkerError`, `blocked_transient`,
 * `already_satisfied`, `no_pr`, `merged`, the `run.error` catch — all BELOW the implement dispatch;
 * and the `finally` drops only the run lock. `spawnWorker`'s own `finally` reaps its per-spawn HOME
 * (`reapWorkerHome`), never `args.cwd`. The wiring tests below read a file the fake worker wrote
 * into its worktree and would fail outright if any of that were wrong, so the lifecycle claim is
 * asserted rather than asserted-about.
 *
 * BOTH DIRECTIONS, because a reader that spoke unconditionally would pass a one-sided test. A
 * failing summary must produce a line NAMING the step; a passing one must produce NOTHING; and a
 * worker that never ran preflight must produce nothing and must not throw on the dispatch path.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts, which
 * intermittently crashes at FILE level under --experimental-test-coverage.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/run-task.js";
import { preflightFailureNotice, preflightSummaryPath } from "../src/lib/ci-parity.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── The pure reader ───────────────────────────────────────────────────────────

/** A summary as `buildPreflightSummary` writes it, with the caller choosing which steps fail. */
function summaryJson(steps: Array<{ name: string; ok: boolean }>, over: Record<string, unknown> = {}): string {
  const failed = steps.filter((s) => !s.ok);
  return JSON.stringify({
    ok: failed.length === 0,
    finishedAt: "2026-08-10T12:00:00.000Z",
    durationMs: 1234,
    headSha: "abc1234",
    args: ["--fast"],
    passed: steps.length - failed.length,
    failed: failed.length,
    steps: steps.map((s) => ({ ...s, detail: `### ${s.name}: ${s.ok ? "PASS" : "FAIL"}` })),
    ...over,
  });
}

test("a FAILING summary names every failing step, and no passing one", () => {
  const notice = preflightFailureNotice("/anywhere", () =>
    summaryJson([
      { name: "commitlint", ok: false },
      { name: "typecheck", ok: true },
      { name: "coverage-ratchet:diff-coverage", ok: false },
    ]),
  );
  assert.ok(notice, "a failed preflight must speak");
  assert.match(notice, /commitlint/);
  assert.match(notice, /coverage-ratchet:diff-coverage/);
  assert.doesNotMatch(notice, /typecheck/, "a passing step is not a finding");
  assert.match(notice, /2 of 3 step\(s\) failed/);
  assert.match(notice, /abc1234/, "the sha names the commit the verdict is about");
  assert.match(notice, /rmd preflight --fast/, "the argv names which run produced it");
});

test("a PASSING summary emits NOTHING — the reader is silent on the ordinary case", () => {
  const notice = preflightFailureNotice("/anywhere", () =>
    summaryJson([
      { name: "commitlint", ok: true },
      { name: "typecheck", ok: true },
    ]),
  );
  assert.equal(notice, undefined);
});

test("a MISSING summary file is silence, not an exception", () => {
  // The real default reader against a real directory with no file in it — not an injected fake,
  // because the failure mode being ruled out is `readFileSync` throwing ENOENT on the dispatch path.
  const empty = mkdtempSync(join(tmpdir(), "preflight-missing-"));
  let notice: string | undefined = "unset";
  assert.doesNotThrow(() => {
    notice = preflightFailureNotice(empty);
  });
  assert.equal(notice, undefined);
  assert.equal(preflightSummaryPath(empty), join(empty, "coverage", "preflight-summary.json"));
});

test("an unreadable or malformed summary is silence, not an exception", () => {
  assert.equal(
    preflightFailureNotice("/anywhere", () => "{not json"),
    undefined,
  );
  assert.equal(
    preflightFailureNotice("/anywhere", () => "null"),
    undefined,
  );
  assert.equal(
    preflightFailureNotice("/anywhere", () => {
      throw new Error("EACCES");
    }),
    undefined,
  );
});

test("a run that called itself FAILED still speaks even with no failing step recorded", () => {
  // `ok: false` is honoured on its own. A verdict is never dropped for want of a name to print.
  const notice = preflightFailureNotice("/anywhere", () => summaryJson([], { ok: false, failed: 1 }));
  assert.ok(notice);
  assert.match(notice, /FAILED/);
});

// ── The wiring, through a real `runTask` ──────────────────────────────────────

const FIXTURE_PLAN = [
  "- id: T-PREFLIGHT-VIS",
  "  title: surface the worker's preflight verdict",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function gitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "preflight-vis-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "preflight-vis-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "preflight-vis@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "preflight-vis"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "preflight-vis@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "preflight-vis"]);
}

/** A fake `gh` answering ownership/trailer/CI, the shape the sibling runTask suites use. These
 *  runs end before `gh pr create` — the worker reports no PR_URL. */
function fakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "preflight-vis-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then",
      "    echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'",
      "    exit 0",
      "  fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'merge' ]]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
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
    ...over,
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const RECON_TEXT = "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n";
const FIXED_TS = 1785000000000;

/**
 * Drive a real dispatch whose implement worker leaves `writeSummary` behind in ITS worktree —
 * exactly what `rmd preflight` does — and return the ledger plus the worktree the worker ran in.
 */
async function runFixture(
  t: { mock: { method: typeof import("node:test").mock.method } },
  label: string,
  writeSummary: ((worktree: string) => void) | undefined,
): Promise<{ verdict: string; ledger: Array<Record<string, unknown>>; worktree: string }> {
  const root = mkdtempSync(join(tmpdir(), `preflight-vis-${label}-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  t.mock.method(Date, "now", () => FIXED_TS);
  const fakeBinDir = fakeGh(`run-T-PREFLIGHT-VIS-${FIXED_TS}`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  let worktree = "";
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: RECON_TEXT });
    // The implement worker: cwd IS its worktree, and this is where `rmd preflight` would write.
    worktree = args.cwd;
    writeSummary?.(args.cwd);
    return result({ sessionId: "s-implement", text: "REPORT\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-PREFLIGHT-VIS", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    return { verdict: res.verdict, ledger: readLedger(root), worktree };
  } finally {
    process.env.PATH = savedPath;
  }
}

/** Write a summary the way `preflightCommand` does — into `<cwd>/coverage/`. */
function writePreflightSummary(worktree: string, steps: Array<{ name: string; ok: boolean }>): void {
  const path = preflightSummaryPath(worktree);
  mkdirSync(join(worktree, "coverage"), { recursive: true });
  writeFileSync(path, summaryJson(steps) + "\n");
}

test("a worker that failed preflight has the FAILING STEP named in the orchestrator's ledger", async (t) => {
  const { verdict, ledger, worktree } = await runFixture(t, "fail", (wt) =>
    writePreflightSummary(wt, [
      { name: "commitlint", ok: false },
      { name: "typecheck", ok: true },
    ]),
  );

  // Reaching the path is asserted before anything is read off it, or the rest is vacuous.
  assert.equal(verdict, "no_pr", "the fixture must reach a real terminal verdict");
  assert.ok(worktree, "the implement spawn must have run with a worktree cwd");

  const lines = ledger.filter((l) => l.step === "preflight.failed");
  assert.equal(lines.length, 1, "exactly one notice per dispatch");
  assert.match(String(lines[0].detail), /commitlint/, "the failing step is NAMED, not merely counted");
  assert.doesNotMatch(String(lines[0].detail), /typecheck/);
  assert.equal(lines[0].worktree, worktree, "the notice records which worktree it was read from");

  // THE LIFECYCLE FACT, PROVED RATHER THAN ASSERTED ABOUT: the file the worker wrote was read
  // AFTER `spawn()` returned, so the worktree was still on disk at that moment. And the notice
  // lands BEFORE the verdict that ends the run — a diagnosis after the fact helps nobody.
  const steps = ledger.map((l) => l.step);
  assert.ok(
    steps.indexOf("preflight.failed") < steps.lastIndexOf("verdict"),
    "the failing step is on record before the verdict",
  );
  assert.ok(
    steps.indexOf("preflight.failed") < steps.indexOf("worktree.remove"),
    "and before the worktree it was read from is reclaimed",
  );
});

test("a worker that PASSED preflight produces no notice at all", async (t) => {
  // The control, differing in ONE variable: every step in the summary is ok.
  const { verdict, ledger } = await runFixture(t, "pass", (wt) =>
    writePreflightSummary(wt, [
      { name: "commitlint", ok: true },
      { name: "typecheck", ok: true },
    ]),
  );

  assert.equal(verdict, "no_pr", "the same path as the failing case — only the summary differs");
  assert.equal(
    ledger.filter((l) => l.step === "preflight.failed").length,
    0,
    "a passing preflight is not news",
  );
});

test("a worker that never ran preflight produces no notice, and the dispatch does not throw", async (t) => {
  // No summary file is written at all — the ordinary case for most dispatches. If the reader threw
  // ENOENT here, `runTask` would end `run.error` instead of reaching its verdict.
  const { verdict, ledger } = await runFixture(t, "absent", undefined);

  assert.equal(verdict, "no_pr", "an absent summary must not derail the run");
  assert.equal(ledger.filter((l) => l.step === "run.error").length, 0, "and must not throw");
  assert.equal(ledger.filter((l) => l.step === "preflight.failed").length, 0);
});

test("MUTANT: the read is wired ONCE, and ABOVE every verdict branch that reclaims the worktree", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

  const call = "preflightFailureNotice(worktreePath)";
  assert.equal(src.split(call).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // The design fact, pinned in source as well as behaviourally above: the read precedes every
  // verdict branch that could reclaim the worktree out from under it. `failOnWorkerError`'s CALL
  // is the earliest of those (its body is defined further up the file, which is why the call site
  // and not the removal string is the landmark), and `no_pr` is the one these fixtures take.
  const readAt = src.indexOf(call);
  const errorBranch = src.indexOf('const implFail = failOnWorkerError(impl, "implement")');
  const noPrRemoval = src.indexOf('log("worktree.remove", { on: "no_pr" })');
  assert.ok(errorBranch > 0 && noPrRemoval > 0, "both landmarks must still be findable, or this proves nothing");
  assert.ok(readAt > 0 && readAt < errorBranch, "the read must precede the worker-error verdict branch");
  assert.ok(readAt < noPrRemoval, "and precede the no_pr branch that removes the worktree");
});
