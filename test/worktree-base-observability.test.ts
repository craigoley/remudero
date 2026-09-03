import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertWorktreeBaseCurrent,
  detectWorktreeBaseUncheckableStreak,
  WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND,
  WorktreeBaseStaleError,
  worktreeAdd,
} from "../src/lib/worker.js";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";

// W1-T2621: a worktree creation's ledger line used to name neither the base it cut from nor
// any remote reading -- `log("worktree.add", { branch, worktreePath })` (run-task.ts:11575,
// the FALSIFIER every claim below is checked against) -- and the currency check's ONE
// documented fail-open (an unreadable remote head) warned only to `console.error`, a channel
// nothing durable reads. A run on an UNVERIFIED base was therefore indistinguishable, in the
// record, from a run on a verified-current one: exactly the gap that let a 1553-commits-behind
// base go unexplained until a human dug for it by hand.
//
// These tests drive `worktreeAdd`/`assertWorktreeBaseCurrent` directly (unit-level, no second
// real remote -- same technique `test/worktree-base-currency*.test.ts` already established)
// PLUS two full `runTask()` behavioral runs proving run-task.ts's own call sites actually wire
// the ledger through, not just the library function in isolation.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedClone(clone: string): void {
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "seed.txt"), "x\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  // `worktreeAdd` fetches origin; point it at itself so that fetch (and the default
  // ls-remote) are both local no-ops, same convention as worktree-base-currency.test.ts.
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
}

type LoggedEvent = { step: string; extra?: Record<string, unknown> };

function captureLog(): { log: (step: string, extra?: Record<string, unknown>) => void; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { log: (step, extra) => events.push({ step, extra }), events };
}

// ── Part 1: the healthy `worktree.add` line carries the full three-way reading + behind ────

test("worktreeAdd, given a log dep, ledgers worktree.add with base, local_ref_head, remote_head, ref, AND behind on a genuinely current creation -- today's line (run-task.ts:11575) carries none of the four", () => {
  const root = tmp("rmd-wt-obs-healthy-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    const { log, events } = captureLog();
    worktreeAdd(clone, wt, "run-obs-healthy-probe", "origin/main", { log });

    const addLine = events.find((e) => e.step === "worktree.add");
    assert.ok(addLine, "worktreeAdd must ledger its own creation when given a log dep");
    const actualHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(addLine!.extra!.branch, "run-obs-healthy-probe");
    assert.equal(addLine!.extra!.worktreePath, wt);
    assert.equal(addLine!.extra!.base, actualHead, "the created base");
    assert.equal(addLine!.extra!.local_ref_head, actualHead, "the LOCAL origin/<ref> read right after the fetch");
    assert.equal(addLine!.extra!.remote_head, actualHead, "the INDEPENDENT remote read (real ls-remote here)");
    assert.equal(addLine!.extra!.ref, "main");
    assert.equal(addLine!.extra!.behind, 0, "current -- zero commits behind, never omitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeAdd with NO log dep behaves byte-identically to before this option existed -- no throw, no crash on the missing logger", () => {
  const root = tmp("rmd-wt-obs-no-log-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    assert.doesNotThrow(() => worktreeAdd(clone, wt, "run-obs-no-log-probe", "origin/main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a `base` that is NOT an origin/<ref> tracking start point (a raw sha, here) has no refs/remotes/origin/<ref> to read at all -- local_ref_head degrades to the literal 'unreadable' (readLocalOriginRefHead's own catch), never a crash, independent of whatever the (also-unreadable, same reason) remote-head reading does", () => {
  const root = tmp("rmd-wt-obs-local-ref-unreadable-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    const sha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const { log, events } = captureLog();
    // `base` here is a raw commit sha, not "origin/<ref>" -- a valid `git worktree add`
    // start point, but `ref` (base with no "origin/" prefix to strip) is then the sha
    // itself, which neither `refs/remotes/origin/<sha>` (readLocalOriginRefHead) nor
    // `refs/heads/<sha>` (defaultReadRemoteHead's ls-remote) ever resolves to -- both
    // readings degrade independently, and the run still proceeds (fail-open).
    assert.doesNotThrow(() =>
      worktreeAdd(clone, wt, "run-obs-local-ref-unreadable-probe", sha, { warn: () => {}, log }),
    );

    const addLine = events.find((e) => e.step === "worktree.add");
    assert.ok(addLine, "worktreeAdd still proceeds and still ledgers -- a missing tracking ref is not a refusal");
    assert.equal(addLine!.extra!.local_ref_head, "unreadable", "no refs/remotes/origin/<sha> exists to read");
    assert.equal(addLine!.extra!.base, sha, "the created base reading is unaffected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Part 2: the fail-open becomes a ledger line, IN ADDITION to the existing warning ────────

test("an unreadable remote head ledgers worktree.base_uncheckable (ref, base, error) through the injected logger, on top of the unchanged warn, and the resulting worktree.add records the head as unreadable -- never as verified", () => {
  const root = tmp("rmd-wt-obs-unreadable-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    const { log, events } = captureLog();
    const warnings: string[] = [];
    assert.doesNotThrow(() =>
      worktreeAdd(clone, wt, "run-obs-unreadable-probe", "origin/main", {
        readRemoteHead: () => {
          throw new Error("ETIMEDOUT: could not reach the forge");
        },
        warn: (m) => warnings.push(m),
        log,
      }),
    );
    // The pre-existing warn() channel is UNTOUCHED -- this task adds a ledger line, it does
    // not remove the operator-facing one.
    assert.equal(warnings.length, 1, "warn still fires exactly once");

    const uncheckable = events.find((e) => e.step === "worktree.base_uncheckable");
    assert.ok(uncheckable, "the fail-open must ledger worktree.base_uncheckable");
    assert.equal(uncheckable!.extra!.ref, "main");
    assert.match(String(uncheckable!.extra!.base), /^[0-9a-f]{40}$/);
    assert.match(String(uncheckable!.extra!.error), /ETIMEDOUT|could not reach/);

    const addLine = events.find((e) => e.step === "worktree.add");
    assert.ok(addLine, "the run still proceeds (fail-open), so worktree.add is still ledgered");
    assert.equal(addLine!.extra!.remote_head, "unreadable", "never rendered as a verified match");
    assert.equal(addLine!.extra!.behind, "unknown", "never a guessed number when the remote head itself is unreadable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Part 2b: N consecutive unreadable outcomes are a DISTINGUISHABLE degraded posture -----
// (design note (iii)) -- pure unit coverage of detectWorktreeBaseUncheckableStreak, the
// ledger-derived detector, before Part 5 below proves runTask's own dispatch site wires it.

function addLine(remoteHead: string, ts = "2026-01-01T00:00:00.000Z"): LoggedEvent {
  return { step: "worktree.add", extra: { remote_head: remoteHead, ts } };
}

/** {@link detectWorktreeBaseUncheckableStreak} reads plain ledger-shaped records, so the ledger's
 *  own top-level `ts` (see appendLedger) is folded into `extra` here to keep this file's one
 *  `LoggedEvent` shape -- the function itself only cares about `step`/`remote_head`/`ts` being
 *  present on the SAME object, which `flattenForDetector` below reproduces. */
function flattenForDetector(events: LoggedEvent[]): Array<Record<string, unknown>> {
  return events.map((e) => ({ step: e.step, ...e.extra }));
}

test("detectWorktreeBaseUncheckableStreak: an empty ledger is not degraded and counts zero", () => {
  const verdict = detectWorktreeBaseUncheckableStreak([]);
  assert.equal(verdict.degraded, false);
  assert.equal(verdict.consecutiveUnreadable, 0);
  assert.equal(verdict.newestTs, undefined);
  assert.equal(verdict.oldestTs, undefined);
});

test("detectWorktreeBaseUncheckableStreak: fewer than the bound consecutive unreadable creations count but do not degrade -- N is a stated bound, never a hair-trigger on one flaky read", () => {
  const lines = flattenForDetector([addLine("unreadable", "t1"), addLine("unreadable", "t2")]);
  const verdict = detectWorktreeBaseUncheckableStreak(lines);
  assert.equal(WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND, 3, "the stated bound this test asserts against");
  assert.equal(verdict.degraded, false, "2 < the stated bound of 3");
  assert.equal(verdict.consecutiveUnreadable, 2);
});

test("detectWorktreeBaseUncheckableStreak: exactly N consecutive unreadable creations ARE a distinguishable degraded posture, naming the oldest and newest timestamps in the run", () => {
  const lines = flattenForDetector([addLine("unreadable", "t1"), addLine("unreadable", "t2"), addLine("unreadable", "t3")]);
  const verdict = detectWorktreeBaseUncheckableStreak(lines);
  assert.equal(verdict.degraded, true);
  assert.equal(verdict.consecutiveUnreadable, 3);
  assert.equal(verdict.oldestTs, "t1");
  assert.equal(verdict.newestTs, "t3");
});

test("detectWorktreeBaseUncheckableStreak: a single READABLE creation resets the run -- this is 'is it degraded NOW', never a lifetime tally that latches after one bad day", () => {
  const lines = flattenForDetector([
    addLine("unreadable", "t1"),
    addLine("unreadable", "t2"),
    addLine("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "t3"), // a real, readable sha
    addLine("unreadable", "t4"),
  ]);
  const verdict = detectWorktreeBaseUncheckableStreak(lines);
  assert.equal(verdict.degraded, false, "only ONE unreadable creation since the readable reset at t3");
  assert.equal(verdict.consecutiveUnreadable, 1);
  assert.equal(verdict.oldestTs, "t4");
  assert.equal(verdict.newestTs, "t4");
});

test("detectWorktreeBaseUncheckableStreak: non-worktree.add lines (including its own worktree.base_uncheckable companion) never count -- one creation's fail-open is not two", () => {
  const lines: Array<Record<string, unknown>> = [
    { step: "worktree.base_uncheckable", ref: "main", base: "x", error: "ETIMEDOUT", ts: "t0" },
    ...flattenForDetector([addLine("unreadable", "t1"), addLine("unreadable", "t2")]),
    { step: "worktree.stale_base", base: "x", remote_head: "y", ts: "t3" },
  ];
  const verdict = detectWorktreeBaseUncheckableStreak(lines);
  assert.equal(verdict.consecutiveUnreadable, 2, "exactly the 2 worktree.add lines -- the sibling steps are ignored");
});

test("detectWorktreeBaseUncheckableStreak: the threshold is an injectable parameter, not hardwired to the exported bound", () => {
  const lines = flattenForDetector([addLine("unreadable", "t1"), addLine("unreadable", "t2")]);
  assert.equal(detectWorktreeBaseUncheckableStreak(lines, 2).degraded, true, "a caller-supplied lower bound still degrades");
  assert.equal(detectWorktreeBaseUncheckableStreak(lines, 5).degraded, false, "a caller-supplied higher bound still does not");
});

// ── Part 3: the refusal path names a REAL distance when it can, "unknown" -- never zero --
//    when it cannot, and the local tracking ref discriminates "the fetch didn't move it" from
//    "the add cut from the wrong ref" ────────────────────────────────────────────────────────

/** Seeds `clone` with a first commit on `main` (what `worktreeAdd` will actually cut from) and
 *  a SECOND commit on a sibling branch `future` -- present in `clone`'s own object database,
 *  but never reachable from `origin/main` (main never advances). Returns both commit shas. */
function seedCloneWithForeignFutureCommit(clone: string): { mainSha: string; futureSha: string } {
  seedClone(clone);
  const mainSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", "future"]);
  writeFileSync(join(clone, "future.txt"), "y\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: future"]);
  const futureSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", clone, "checkout", "-q", "main"]);
  return { mainSha, futureSha };
}

test("a stale base whose independent remote head IS a real, locally-present commit computes the ACTUAL commit distance -- a one-commit race and a 1553-commit gap no longer render as the same line", () => {
  const root = tmp("rmd-wt-obs-real-distance-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    const { mainSha, futureSha } = seedCloneWithForeignFutureCommit(clone);
    let thrown: WorktreeBaseStaleError | undefined;
    try {
      worktreeAdd(clone, wt, "run-obs-real-distance-probe", "origin/main", {
        // Independently "observes" the foreign commit as the true remote head -- its object
        // is already present in `clone` (same repo, other branch), so the distance below is
        // computed from real local objects, never a second network call.
        readRemoteHead: () => futureSha,
      });
      assert.fail("expected a WorktreeBaseStaleError");
    } catch (e) {
      assert.ok(e instanceof WorktreeBaseStaleError);
      thrown = e;
    }
    assert.equal(thrown!.base, mainSha);
    assert.equal(thrown!.remoteHead, futureSha);
    assert.equal(thrown!.behind, 1, "exactly one commit sits between main and future here -- a real, measured number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale base whose independent remote head's object is NOT present locally renders behind 'unknown', never zero -- AND the local origin/<ref> matches the created base, naming the fetch (not a wrong-ref cut) as the mechanism", () => {
  const root = tmp("rmd-wt-obs-unknown-distance-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    let thrown: WorktreeBaseStaleError | undefined;
    try {
      worktreeAdd(clone, wt, "run-obs-unknown-distance-probe", "origin/main", {
        // A fake sha whose object was never fetched into `clone` at all -- the "a narrowed
        // refspec / a mirror / a ref-lock the fetch survived" shape design note (iii) names,
        // the systemic-provisioning answer the harvest that filed this task was asking for.
        readRemoteHead: () => "9999999999999999999999999999999999999a",
      });
      assert.fail("expected a WorktreeBaseStaleError");
    } catch (e) {
      assert.ok(e instanceof WorktreeBaseStaleError);
      thrown = e;
    }
    assert.equal(thrown!.behind, "unknown", "an absent object must never render as a guessed number, let alone zero");

    // base == local tracking ref (design note (ii)/(iii)): the worktree really was cut from
    // exactly what `origin/main` pointed to right after the fetch -- ruling out "the add cut
    // from a ref other than the one it was told to" (a genuine surprise, impossible from
    // source as written) and leaving "the fetch is not moving the ref" as the read.
    const createdBase = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const localRefHead = execFileSync("git", ["-C", clone, "rev-parse", "refs/remotes/origin/main"], {
      encoding: "utf8",
    }).trim();
    assert.equal(thrown!.base, createdBase);
    assert.equal(createdBase, localRefHead, "base == local origin/main -- the add cut from the ref it was told to");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Part 4: polarity and network cost are unchanged ─────────────────────────────────────────

test("polarity is unchanged: a current base still proceeds untouched, an unreadable head still proceeds, and a behind base still throws -- exactly as before this task", () => {
  const root = tmp("rmd-wt-obs-polarity-");
  const clone = join(root, "clone");
  try {
    seedClone(clone);

    assert.doesNotThrow(() =>
      assertWorktreeBaseCurrent("deadbeef", "main", { readRemoteHead: () => "deadbeef" }),
    );
    assert.doesNotThrow(() =>
      assertWorktreeBaseCurrent("deadbeef", "main", {
        readRemoteHead: () => {
          throw new Error("network unreachable");
        },
      }),
    );
    assert.throws(
      () => assertWorktreeBaseCurrent("deadbeef", "main", { readRemoteHead: () => "otherhead" }),
      (e: unknown) => e instanceof WorktreeBaseStaleError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exactly ONE ls-remote (one readRemoteHead call) is issued per creation -- this task adds no second network call", () => {
  const root = tmp("rmd-wt-obs-one-remote-read-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    let calls = 0;
    const actualHead = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    worktreeAdd(clone, wt, "run-obs-one-read-probe", "origin/main", {
      readRemoteHead: () => {
        calls += 1;
        return actualHead;
      },
    });
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeAdd never emits worktree.add on a refusal -- the stale path's only ledger line is the caller's own worktree.stale_base", () => {
  const root = tmp("rmd-wt-obs-no-double-log-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    const { log, events } = captureLog();
    assert.throws(() =>
      worktreeAdd(clone, wt, "run-obs-no-double-log-probe", "origin/main", {
        readRemoteHead: () => "8888888888888888888888888888888888888a",
        log,
      }),
    );
    assert.ok(!events.some((e) => e.step === "worktree.add"), "a refusal must never also read as a verified creation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Part 5: BEHAVIORAL -- a REAL runTask() actually wires the ledger through ────────────────
// Mirrors test/already-satisfied-exit.test.ts's own technique: a real, throwaway bare "origin"
// + a real clone, a faked worker spawn (zero real Claude process), an injected board gateway
// (zero network). Neither path below needs a `gh` binary on PATH.

function workerResult(over: Partial<WorkerResult>): WorkerResult {
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

function behavioralPlan(id: string): string {
  return [
    `- id: ${id}`,
    "  title: worktree base observability wiring probe",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  files: [src/lib/daemon.ts]",
    "  origin: architect",
    "  status: queued",
    "",
  ].join("\n");
}

/** A real, throwaway BARE "origin" + a real clone at `repoDir` -- `runTask`'s own `git
 *  worktree add` runs for real, entirely offline (mirrors already-satisfied-exit.test.ts's
 *  `gitFixture`). */
function behavioralGitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "worktree-obs-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "worktree-obs-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "worktree-obs-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "worktree-obs-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "worktree-obs-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "worktree-obs-test"]);
  return { repoDir };
}

const behavioralHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const behavioralCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function creditingGithub(taskId: string, credited: PrRef | null): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: (id) => (id === taskId ? credited : null),
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const RECON_TEXT = "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n";

test("BEHAVIORAL: a REAL runTask() ledgers worktree.add with the three-way base reading + behind -- run-task.ts's own call site, not just worktreeAdd in isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-obs-healthy-root-"));
  const TASK_ID = "T-WORKTREE-OBS-HEALTHY";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, behavioralPlan(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  behavioralGitFixture(root);

  const CREDIT_PR: PrRef = { number: 7, url: "https://github.com/acme/remudero/pull/7", state: "MERGED" };
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return workerResult({ sessionId: "s-recon", text: RECON_TEXT });
    // ALREADY_SATISFIED needs no PR open/push -- reaches a clean terminal verdict with no `gh`
    // binary required, same technique already-satisfied-exit.test.ts uses.
    return workerResult({ sessionId: "s-implement", text: "REPORT\nALREADY_SATISFIED: #7\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: creditingGithub(TASK_ID, CREDIT_PR),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
      }),
    );
    assert.equal(res.verdict, "already_satisfied");

    const ledger = readLedger(root);
    const addLine = ledger.find((l) => l.step === "worktree.add");
    assert.ok(addLine, "run-task.ts's own worktreeAdd call site must ledger worktree.add");
    assert.match(String(addLine?.base), /^[0-9a-f]{40}$/);
    assert.equal(addLine?.local_ref_head, addLine?.base);
    assert.equal(addLine?.remote_head, addLine?.base);
    assert.equal(addLine?.ref, "main");
    assert.equal(addLine?.behind, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: a REAL runTask() refusal ledgers worktree.stale_base WITH a behind field -- a one-commit race and a 1553-commit gap are no longer the identical line", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-obs-stale-root-"));
  const TASK_ID = "T-WORKTREE-OBS-STALE";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, behavioralPlan(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  behavioralGitFixture(root);

  const spawn: typeof spawnWorker = async () => {
    throw new Error("must never spawn a worker — a stale base refuses before recon/implement/commit spend anything");
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: creditingGithub(TASK_ID, null),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
        // Same injection test/worktree-base-currency.test.ts and dispatch-claim.test.ts's own
        // stale test use, threaded here so the REAL WorktreeBaseStaleError catch branch runs.
        worktreeBaseDeps: { readRemoteHead: () => "0".repeat(40) },
      }),
    );
    assert.equal(res.verdict, "failed");

    const ledger = readLedger(root);
    const staleLine = ledger.find((l) => l.step === "worktree.stale_base");
    assert.ok(staleLine, "the refusal must still ledger worktree.stale_base");
    assert.ok("behind" in (staleLine ?? {}), "the refusal path must carry the distance too (design note (v))");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: a REAL runTask(), dispatched for 3 DIFFERENT tasks sharing one host ledger, each with an unreadable remote head, ledgers worktree.base_check_degraded on the 3rd creation -- never on the 1st or 2nd -- proving run-task.ts's own dispatch site (not just the library function) wires design note (iii)", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-obs-degraded-root-"));
  const TASK_IDS = ["T-WORKTREE-OBS-DEGRADED-1", "T-WORKTREE-OBS-DEGRADED-2", "T-WORKTREE-OBS-DEGRADED-3"];
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, TASK_IDS.map(behavioralPlan).join(""));
  const config: Config = { claudeBin: "/bin/true", root };
  behavioralGitFixture(root);

  const CREDIT_PR: PrRef = { number: 7, url: "https://github.com/acme/remudero/pull/7", state: "MERGED" };
  // A running counter ACROSS all 3 runTask() calls below (recon, then implement, per call) --
  // deliberately not reset per call, since the point of this test is that the DEGRADED verdict
  // itself accumulates across separately-dispatched tasks sharing one host's ledger.
  let spawnCount = 0;
  const spawn: typeof spawnWorker = async () => {
    spawnCount += 1;
    if (spawnCount % 2 === 1) return workerResult({ sessionId: "s-recon", text: RECON_TEXT });
    // ALREADY_SATISFIED needs no PR open/push -- same technique the healthy test above uses.
    return workerResult({ sessionId: "s-implement", text: "REPORT\nALREADY_SATISFIED: #7\n" });
  };

  try {
    for (const [i, taskId] of TASK_IDS.entries()) {
      const res = await withLiveWritesAllowed(() =>
        runTask(taskId, {
          skipGitSync: true,
          planPath,
          config,
          github: creditingGithub(taskId, CREDIT_PR),
          spawn,
          containmentExec: behavioralHoldingContainmentExec,
          isolationExec: behavioralCleanIsolationExec,
          worktreeBaseDeps: {
            // The FAIL-OPEN branch, not the refusal one: readRemoteHead throws, so
            // assertWorktreeBaseCurrent's catch fires and worktreeAdd still proceeds --
            // "unreadable" every time, never "stale".
            readRemoteHead: () => {
              throw new Error("ETIMEDOUT: forge unreachable");
            },
          },
        }),
      );
      assert.equal(res.verdict, "already_satisfied");

      const ledger = readLedger(root);
      const degradedLines = ledger.filter((l) => l.step === "worktree.base_check_degraded");
      if (i < 2) {
        assert.equal(degradedLines.length, 0, `no degraded line expected after only ${i + 1} unreadable creation(s)`);
      } else {
        assert.equal(degradedLines.length, 1, "exactly one degraded line, ledgered on the 3rd unreadable creation");
        assert.equal(degradedLines[0]?.consecutive_unreadable, 3);
        assert.equal(degradedLines[0]?.threshold, WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
