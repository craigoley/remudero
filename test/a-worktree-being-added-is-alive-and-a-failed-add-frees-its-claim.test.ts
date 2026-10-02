// test/a-worktree-being-added-is-alive-and-a-failed-add-frees-its-claim.test.ts — W1-T5280: the
// implement lane took its dispatch claim, then awaited `worktreeAddAsync` (5-10 minutes on the
// fleet host), and only wrote the run lock `pruneStaleRuns` honours once the add returned. A
// sibling lane's prune in the SAME daemon process therefore force-removed a worktree still being
// added (2026-10-01 17:28:16Z: run-W1-T5016-1790874544569, whose add failed 11s later), and the
// generic `worktree.add_failed` arm rethrew without releasing the claim, so the next four
// dispatches read `blocked_inflight` and tripped the breaker with $0 spent.
//
// Each test drives the REAL runTask against a real local git origin (the W1-T4701 harness shape).
// The mid-add prune is a REAL `pruneStaleRuns`, fired from inside the REAL add through the
// `worktreeBaseDeps.readRemoteHead` seam — the moment the worktree is registered and checked out
// but the add has not returned, which is exactly where the fleet's sibling prune landed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask, type RunResult } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { DEFAULT_PRUNE_GRACE_MS, pruneStaleRuns, type PruneSummary, type spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK_ID = "T-ADD-IS-ALIVE";
const ANCHOR = "t5280-anchor";
type Row = Record<string, unknown>;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** A bare origin, a seed, and the managed checkout at `<root>/repos/remudero`. `unreachable` points the
 *  checkout's origin at nothing, so the add's own `git fetch` fails with a plain Error. */
function buildFixture(shape: "reachable" | "unreachable") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}add-is-alive-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(
    planPath,
    [`- id: ${TASK_ID}`, "  title: a worktree being added is alive", "  repo: remudero", "  type: implement",
      "  verify: auto", "  risk: medium", "  files: [src/lib/daemon.ts]", "  origin: test", "  status: queued", ""].join("\n"),
  );
  const origin = gitRepo({ bare: true, kind: "add-is-alive-origin" });
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin.dir, seed], { stdio: "pipe" });
  git(seed, "config", "user.email", "t5280@example.invalid");
  git(seed, "config", "user.name", "t5280");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "t5280-core", version: "0.0.0" }));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir], { stdio: "pipe" });
  git(repoDir, "config", "user.email", "t5280@example.invalid");
  git(repoDir, "config", "user.name", "t5280");
  mkdirSync(join(repoDir, "node_modules"));
  const mainSha = git(repoDir, "rev-parse", "origin/main").trim();
  if (shape === "unreachable") git(repoDir, "remote", "set-url", "origin", join(root, "no-such-origin.git"));
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  return {
    root, planPath, config, repoDir, mainSha, worktreesRoot: join(root, "worktrees"),
    cleanup: () => (origin.cleanup(), rmSync(root, { recursive: true, force: true })),
  };
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A claim the run took (`created`). `drop` records its call and, through `onDrop`, lets a test read
 *  the ledger at the instant of release or make the release throw. */
function fakeReserver(onDrop: () => void = () => {}): DispatchClaimReserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mintAnchor: () => ANCHOR,
    attempt: () => "created",
    holder: () => undefined,
    drop: (taskId, o) => {
      calls.push(`drop:${taskId}:${o?.expect ?? "-"}`);
      onDrop();
      return true;
    },
  };
}

const holdingContainment = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const cleanIsolation = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

const NO_SPAWN = "t5280: no worker runs under test";

async function dispatch(
  fx: ReturnType<typeof buildFixture>,
  reserver: ReturnType<typeof fakeReserver>,
  worktreeBaseDeps?: { readRemoteHead: (repoDir: string, ref: string) => string },
): Promise<{ err: unknown; result: RunResult | undefined; ledger: Row[] }> {
  const spawn: typeof spawnWorker = async () => {
    throw new Error(NO_SPAWN);
  };
  let err: unknown;
  let result: RunResult | undefined;
  try {
    result = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainment,
        isolationExec: cleanIsolation,
        claimReserver: reserver,
        // The managed checkout's install is not under test; a real one fails offline and escalates through gh.
        managedCheckoutInstall: () => {},
        ...(worktreeBaseDeps ? { worktreeBaseDeps } : {}),
      }),
    );
  } catch (e) {
    err = e;
  }
  return { err, result, ledger: readLedger(fx.root) };
}

function readLedger(root: string): Row[] {
  const path = join(root, "state", "ledger.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

const runLocks = (worktreesRoot: string): string[] =>
  existsSync(worktreesRoot) ? readdirSync(worktreesRoot).filter((name) => name.endsWith(".lock")) : [];

test("W1-T5280 criterion 1: a sibling prune firing while a run's worktree is still being added skips it, and the add completes", async () => {
  const fx = buildFixture("reachable");
  try {
    let midAdd: { worktreePath: string; summary: PruneSummary } | undefined;
    const o = await dispatch(fx, fakeReserver(), {
      readRemoteHead: (repoDir) => {
        if (!midAdd) {
          // The add has registered and checked out the worktree but not returned. A sibling lane's prune, ten
          // minutes into a slow add — past `pruneGraceMs`, which is all that protected a lockless path.
          const registered = git(repoDir, "worktree", "list", "--porcelain")
            .split("\n")
            .filter((line) => line.startsWith("worktree ") && line.includes(`${fx.worktreesRoot}/run-`))
            .map((line) => line.slice("worktree ".length));
          assert.equal(registered.length, 1, "the run's worktree is registered while its add is still in flight");
          const summary = pruneStaleRuns(repoDir, fx.worktreesRoot, {
            graceMs: DEFAULT_PRUNE_GRACE_MS,
            now: () => Date.now() + 10 * 60_000,
          });
          midAdd = { worktreePath: registered[0]!, summary };
        }
        return fx.mainSha;
      },
    });
    assert.ok(midAdd, "the mid-add prune fired");
    assert.deepEqual(midAdd.summary.worktrees, [], "the prune removed nothing");
    assert.ok(midAdd.summary.skipped.includes(midAdd.worktreePath), "the prune names the in-flight worktree as live");
    const failed = o.ledger.find((row) => row.step === "worktree.add_failed");
    assert.equal(failed, undefined, `the add was not cut out from under itself: ${JSON.stringify(failed)}`);
    assert.ok(o.ledger.find((row) => row.step === "worktree.add"), "the add completed and ledgered itself");
  } finally {
    fx.cleanup();
  }
});

test("W1-T5280 criterion 1: a worktree add that throws a plain Error releases the dispatch claim after its terminal row, and leaves no run lock", async () => {
  const fx = buildFixture("unreachable");
  try {
    let verdictBeforeRelease: boolean | undefined;
    const reserver = fakeReserver(() => {
      verdictBeforeRelease = readLedger(fx.root).some((row) => row.step === "verdict" && row.stage === "worktree.add");
    });
    const o = await dispatch(fx, reserver);
    assert.ok(o.err instanceof Error, `got: ${String(o.err)}`);
    const failed = o.ledger.find((row) => row.step === "worktree.add_failed");
    assert.equal(failed?.error, (o.err as Error).message, "the add's own failure still reaches the caller");
    assert.deepEqual(reserver.calls, [`drop:${TASK_ID}:${ANCHOR}`], "the claim this run holds is released, pinned to its anchor");
    assert.equal(verdictBeforeRelease, true, "the terminal row lands BEFORE the release (W1-T4708 order)");
    assert.deepEqual(runLocks(fx.worktreesRoot), [], "the liveness token written for the add does not outlive it");
  } finally {
    fx.cleanup();
  }
});

test("W1-T5280: a release that throws after a failed add is ledgered and never replaces the add's own error", async () => {
  const fx = buildFixture("unreachable");
  try {
    const reserver = fakeReserver(() => {
      throw new Error("t5280: update-ref refused");
    });
    const o = await dispatch(fx, reserver);
    assert.ok(o.err instanceof Error, `got: ${String(o.err)}`);
    const failed = o.ledger.find((row) => row.step === "worktree.add_failed");
    assert.equal(failed?.error, (o.err as Error).message, "the caller receives the add failure, not the release failure");
    assert.equal(reserver.calls.length, 1, "the release was attempted");
    const releaseError = o.ledger.find((row) => row.step === "dispatch.claim_release_error");
    assert.match(String(releaseError?.error), /update-ref refused/);
    assert.deepEqual(runLocks(fx.worktreesRoot), [], "the liveness token is still removed");
  } finally {
    fx.cleanup();
  }
});
