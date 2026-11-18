import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  boundGitCall,
  fetchOriginRetryingRefLock,
  fetchOriginRetryingRefLockAsync,
  retryAfterDanglingRefRepair,
  retryAfterDanglingRefRepairAsync,
  setDanglingRefRepairLog,
  type AsyncGitRunner,
} from "#src/lib/git-fetch-retry.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { GIT_REPO_FIXTURE_IDENTITY, originWithClone } from "#test/helpers/git-repo.js";

// W1-T13409. On 2026-11-17 the heartbeat left refs/remotes/origin/heartbeat-azure naming an object the shared clone
// lacked, and every fetch failed with "bad object refs/..." for hours. These fixtures build that state the way the
// heartbeat did: a parentless commit pushed from a private object directory, which is then deleted.

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAIN = ["fetch", "origin", "main"];

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = ENV): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture { clone: string; origin: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-dangling-"));
  const { origin, clone } = originWithClone(join(root, "clone"));
  git(clone.dir, ["tag", "light"]);
  git(clone.dir, ["update-ref", "refs/rmd-dispatch/healthy", "HEAD"]);
  return { clone: clone.dir, origin: origin.dir };
}

/** The heartbeat's way: commits that only a private object directory holds, pushed through origin, then the
 *  directory is deleted. Origin has each object; the clone's tracking refs name objects it lacks. */
function pushDangling(fx: Fixture, branches: string[]): string[] {
  const priv = mkdtempSync(join(tmpdir(), "rmd-dangling-objects-"));
  const env = { ...ENV, GIT_OBJECT_DIRECTORY: priv, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(fx.clone, ".git", "objects") };
  const ids = branches.map((b) => git(fx.clone, ["commit-tree", EMPTY_TREE, "-m", `beat ${b}`], env));
  git(fx.clone, ["push", "--quiet", "origin", ...branches.map((b, i) => `${ids[i]}:refs/heads/${b}`)], env);
  rmSync(priv, { recursive: true, force: true });
  return ids;
}

/** A ref of the clone's own (branch, tag, dispatch ref) naming a commit whose loose object is then deleted. */
function danglingOwnRef(fx: Fixture, ref: string): string {
  const id = git(fx.clone, ["commit-tree", EMPTY_TREE, "-m", `own ${ref}`]);
  git(fx.clone, ["update-ref", ref, id]);
  rmSync(join(fx.clone, ".git", "objects", id.slice(0, 2), id.slice(2)));
  return id;
}

function refLines(fx: Fixture): string {
  return git(fx.clone, ["for-each-ref", "--format=%(objectname) %(refname)"]);
}

function everyRefIsPresent(fx: Fixture): boolean {
  return refLines(fx).split("\n").every((line) => {
    try {
      git(fx.clone, ["cat-file", "-e", line.split(" ")[0]!]);
      return true;
    } catch (error) {
      // cat-file -e exits 1 for a missing object: the answer this check asks for.
      void error;
      return false;
    }
  });
}

interface Row { step: string; extra: Record<string, unknown> }
let rows: Row[] = [];
setDanglingRefRepairLog((step, extra) => rows.push({ step, extra }));
afterEach(() => {
  rows = [];
});

/** A `git` first on PATH that records each argv, for the leaf, which spawns `git` by name. */
function withGitShim<T>(run: () => T): { result: T; calls: string[] } | { error: unknown; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-git-shim-"));
  const log = join(dir, "calls.log");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  writeFileSync(log, "");
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const calls = (): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);
  try {
    return { result: run(), calls: calls() };
  } catch (error) {
    return { error, calls: calls() };
  } finally {
    process.env.PATH = path;
  }
}

async function withGitShimAsync<T>(run: () => Promise<T>): Promise<{ result?: T; error?: unknown; calls: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-git-shim-"));
  const log = join(dir, "calls.log");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  writeFileSync(log, "");
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const calls = (): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);
  try {
    return { result: await run(), calls: calls() };
  } catch (error) {
    return { error, calls: calls() };
  } finally {
    process.env.PATH = path;
  }
}

/** A recording runner over real git in the clone, the shape the fetch retry's callers pass. */
function recordingGit(fx: Fixture) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    return execFileSync("git", ["-C", fx.clone, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  };
  const runAsync: AsyncGitRunner = (args, signal, env) => {
    calls.push(args);
    return new Promise((resolve, reject) => {
      execFile("git", ["-C", fx.clone, ...args], { encoding: "utf8", env: { ...ENV, ...env }, signal }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  };
  return { calls, run, runAsync };
}

const isOriginalFetch = (line: string): boolean => /(^| )fetch origin main$/.test(line) || / fetch --quiet --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main$/.test(` ${line}`);
const count = (calls: readonly string[], pattern: RegExp): number => calls.filter((c) => pattern.test(c)).length;

function assertOneRefetchedRow(fx: Fixture, ref: string): void {
  assert.deepEqual(rows.map((r) => r.step), ["git.dangling_ref_repaired"], JSON.stringify(rows));
  const [row] = rows;
  assert.equal(row!.extra.ref, ref);
  assert.equal(row!.extra.how, "refetched");
  assert.equal(typeof row!.extra.ms, "number");
  assert.equal(realpathSync(String(row!.extra.clone)), realpathSync(join(fx.clone, ".git")));
}

test("W1-T13409 criterion 1: invariant:a-dangling-tracking-ref-is-repaired-at-the-fetch — each seam repairs the dangling tracking ref and its fetch succeeds", async () => {
  // The async leaf.
  let fx = fixture();
  pushDangling(fx, ["beat"]);
  assert.throws(() => git(fx.clone, MAIN), /bad object refs\/remotes\/origin\/beat/, "the fixture breaks a plain fetch");
  const asyncLeaf = await withGitShimAsync(() => hostWorktreeGitAsync(fx.clone, MAIN));
  assert.equal(asyncLeaf.error, undefined, String(asyncLeaf.error));
  assert.equal(count(asyncLeaf.calls, /fetch origin main$/), 2, asyncLeaf.calls.join("\n"));
  assertOneRefetchedRow(fx, "refs/remotes/origin/beat");
  assert.ok(everyRefIsPresent(fx));
  rows = [];

  // The sync leaf.
  fx = fixture();
  pushDangling(fx, ["beat"]);
  const syncLeaf = withGitShim(() => hostWorktreeGit(fx.clone, MAIN));
  assert.ok(!("error" in syncLeaf), String("error" in syncLeaf && syncLeaf.error));
  assert.equal(count(syncLeaf.calls, /fetch origin main$/), 2);
  assertOneRefetchedRow(fx, "refs/remotes/origin/beat");
  assert.ok(everyRefIsPresent(fx));
  rows = [];

  // The fetch retry, sync.
  fx = fixture();
  pushDangling(fx, ["beat"]);
  const sync = recordingGit(fx);
  fetchOriginRetryingRefLock(sync.run, () => assert.fail("a dangling ref is not a ref lock"), 3, "main");
  assert.equal(sync.calls.filter((c) => isOriginalFetch(c.join(" "))).length, 2);
  assertOneRefetchedRow(fx, "refs/remotes/origin/beat");
  assert.ok(everyRefIsPresent(fx));
  rows = [];

  // The fetch retry, async.
  fx = fixture();
  pushDangling(fx, ["beat"]);
  const awaited = recordingGit(fx);
  await fetchOriginRetryingRefLockAsync(awaited.runAsync, async () => assert.fail("a dangling ref is not a ref lock"), 3, 60_000, "main");
  assert.equal(awaited.calls.filter((c) => isOriginalFetch(c.join(" "))).length, 2);
  assertOneRefetchedRow(fx, "refs/remotes/origin/beat");
  assert.ok(everyRefIsPresent(fx));
});

test("W1-T13409 criterion 2: invariant:the-success-path-costs-nothing — a fetch that succeeds starts only its own git processes and writes no row", async () => {
  const fx = fixture();
  const sync = withGitShim(() => hostWorktreeGit(fx.clone, MAIN));
  assert.deepEqual(sync.calls.map((c) => c.split(" ").find((w) => !w.startsWith("-") && !w.startsWith("/")) ?? c), ["config", "fetch"],
    "the sync leaf: its config read and the fetch, as at origin/main");
  const awaited = await withGitShimAsync(() => hostWorktreeGitAsync(fx.clone, MAIN));
  assert.equal(awaited.calls.length, 2, awaited.calls.join("\n"));
  for (const calls of [sync.calls, awaited.calls]) {
    assert.equal(count(calls, /for-each-ref|cat-file|rev-list|ls-remote|rev-parse/), 0);
  }
  const retry = recordingGit(fx);
  fetchOriginRetryingRefLock(retry.run, () => {}, 3, "main");
  await fetchOriginRetryingRefLockAsync(retry.runAsync, async () => {}, 3, 60_000, "main");
  assert.equal(retry.calls.length, 2, "one fetch each");
  assert.deepEqual(rows, []);

  // A command that is not a fetch and fails with the same words is not repaired.
  pushDangling(fx, ["beat"]);
  const notFetch = withGitShim(() => hostWorktreeGit(fx.clone, ["rev-list", "refs/remotes/origin/beat"]));
  assert.ok("error" in notFetch);
  assert.match(String((notFetch.error as { stderr?: unknown }).stderr), /bad object refs\/remotes\/origin\/beat/);
  assert.equal(notFetch.calls.length, 2, notFetch.calls.join("\n"));
  const words = Object.assign(new Error("Command failed"), { stderr: "fatal: bad object refs/remotes/origin/beat" });
  assert.throws(() => retryAfterDanglingRefRepair(() => assert.fail("no git call"), ["log", "origin/beat"], words, () => "retried"),
    (e) => e === words);
  assert.deepEqual(rows, []);
});

test("W1-T13409 criterion 3: invariant:only-a-missing-tracking-ref-is-touched — local branches, tags and dispatch refs are reported, never written", () => {
  const fx = fixture();
  pushDangling(fx, ["beat"]);
  danglingOwnRef(fx, "refs/heads/lost");
  danglingOwnRef(fx, "refs/tags/lost");
  danglingOwnRef(fx, "refs/rmd-dispatch/lost");
  const before = refLines(fx).split("\n").filter((l) => !l.endsWith(" refs/remotes/origin/beat"));
  assert.throws(() => hostWorktreeGit(fx.clone, MAIN), /bad object refs\//);
  const after = refLines(fx).split("\n").filter((l) => !l.endsWith(" refs/remotes/origin/beat"));
  assert.deepEqual(after, before, "every ref but the dangling tracking ref keeps its value");
  for (const ref of ["refs/heads/lost", "refs/tags/lost", "refs/rmd-dispatch/lost"]) {
    const named = rows.filter((r) => r.extra.ref === ref);
    assert.equal(named.length, 1, ref);
    assert.equal(named[0]!.step, "git.dangling_ref_unrepaired");
    assert.equal(named[0]!.extra.why, "not_a_tracking_ref");
  }
  assert.equal(rows.filter((r) => r.step === "git.dangling_ref_repaired" && r.extra.ref !== "refs/remotes/origin/beat").length, 0);

  // A tracking ref whose branch the remote no longer has is removed, by compare-and-swap.
  rows = [];
  const gone = fixture();
  const [goneId] = pushDangling(gone, ["gone"]);
  git(gone.origin, ["update-ref", "-d", "refs/heads/gone"]);
  const keep = refLines(gone).split("\n").filter((l) => !l.endsWith(" refs/remotes/origin/gone"));
  hostWorktreeGit(gone.clone, MAIN);
  assert.deepEqual(refLines(gone).split("\n"), keep);
  assert.deepEqual(rows.map((r) => [r.step, r.extra.ref, r.extra.how]), [["git.dangling_ref_repaired", "refs/remotes/origin/gone", "removed"]]);

  // A ref that another process moved after the listing is left alone.
  rows = [];
  const moved = fixture();
  pushDangling(moved, ["gone"]);
  git(moved.origin, ["update-ref", "-d", "refs/heads/gone"]);
  const head = git(moved.clone, ["rev-parse", "HEAD"]);
  const runner = recordingGit(moved);
  const original = (() => {
    try {
      runner.run(MAIN);
    } catch (error) {
      return error;
    }
    return assert.fail("the fixture breaks a plain fetch");
  })();
  assert.throws(() => retryAfterDanglingRefRepair((args) => {
    if (args[0] === "update-ref") git(moved.clone, ["update-ref", "refs/remotes/origin/gone", head]);
    return runner.run(args);
  }, MAIN, original, () => runner.run(MAIN)), (e) => e === original);
  assert.equal(git(moved.clone, ["rev-parse", "refs/remotes/origin/gone"]), head);
  assert.deepEqual(rows.map((r) => [r.step, r.extra.ref, r.extra.why]), [["git.dangling_ref_unrepaired", "refs/remotes/origin/gone", "repair_failed"]]);
  assert.match(goneId!, /^[0-9a-f]{40}$/);
});

test("W1-T13409 criterion 4: invariant:another-failure-is-unchanged — other failures get no listing, no repair and no retry, and keep their error", async () => {
  const lock = Object.assign(new Error("Command failed: git fetch"), {
    stderr: "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '.git/refs/remotes/origin/main.lock': File exists.",
  });
  const unreachable = Object.assign(new Error("Command failed: git fetch"), { stderr: "fatal: '/nowhere' does not appear to be a git repository" });
  for (const failure of [lock, unreachable]) {
    const calls: string[] = [];
    assert.throws(() => retryAfterDanglingRefRepair((a) => (calls.push(a.join(" ")), ""), MAIN, failure, () => "retried"), (e) => e === failure);
    assert.deepEqual(calls, []);
  }

  // The ref lock is still retried as at origin/main.
  const calls: string[] = [];
  const slept: number[] = [];
  let left = 1;
  fetchOriginRetryingRefLock((args) => {
    calls.push(args.join(" "));
    if (left-- > 0) throw lock;
    return "";
  }, (ms) => slept.push(ms));
  assert.deepEqual([calls.length, slept], [2, [1_000]]);
  assert.equal(count(calls, /for-each-ref|rev-list|ls-remote/), 0);
  calls.length = 0;
  slept.length = 0;
  left = 1;
  await fetchOriginRetryingRefLockAsync(async (args) => {
    calls.push(args.join(" "));
    if (left-- > 0) throw lock;
    return "";
  }, async (ms) => {
    slept.push(ms);
  });
  assert.deepEqual([calls.length, slept], [2, [1_000]]);

  // An unreachable remote through the leaf.
  const fx = fixture();
  git(fx.clone, ["remote", "set-url", "origin", join(fx.origin, "missing")]);
  const leaf = withGitShim(() => hostWorktreeGit(fx.clone, MAIN));
  assert.ok("error" in leaf);
  assert.equal(leaf.calls.length, 2, leaf.calls.join("\n"));
  assert.equal("danglingRefRepair" in (leaf.error as object), false);

  // A fetch stopped at its time bound.
  const hung: AsyncGitRunner = (args, signal) => {
    calls.push(args.join(" "));
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  calls.length = 0;
  await assert.rejects(fetchOriginRetryingRefLockAsync(hung, async () => {}, 1, 50, "main"), /exceeded its 50ms bound/);
  assert.equal(calls.length, 1);
  assert.deepEqual(rows, []);
});

test("W1-T13409 criterion 5: invariant:a-failed-repair-changes-nothing — a repair that fails leaves every ref and throws the original error", () => {
  const fx = fixture();
  pushDangling(fx, ["beat", "gone"]);
  git(fx.origin, ["update-ref", "-d", "refs/heads/gone"]);
  const runner = recordingGit(fx);
  const original = (() => {
    try {
      runner.run(MAIN);
    } catch (error) {
      return error as Error & { stderr: string; status: number };
    }
    return assert.fail("the fixture breaks a plain fetch");
  })();
  const facts = [original.message, String(original.stderr), original.status];
  const before = refLines(fx);
  const refetchFails = (args: string[]): string => {
    if (args.includes("--refetch")) throw Object.assign(new Error("Command failed: git fetch --refetch"), { stderr: "fatal: the remote hung up" });
    return runner.run(args);
  };
  assert.throws(() => retryAfterDanglingRefRepair(refetchFails, MAIN, original, () => runner.run(MAIN)), (e) => e === original);
  assert.equal(refLines(fx), before, "the gone ref was not removed before a refetch that failed");
  assert.deepEqual([original.message, String(original.stderr), original.status], facts);
  const finding = (original as unknown as { danglingRefRepair: { dangling: string[]; repairError: Error } }).danglingRefRepair;
  assert.match(finding.repairError.message, /--refetch/);
  assert.deepEqual(finding.dangling.sort(), ["refs/remotes/origin/beat", "refs/remotes/origin/gone"]);
  const named = rows.filter((r) => r.extra.ref === "refs/remotes/origin/beat");
  assert.equal(named.length, 1);
  assert.deepEqual([named[0]!.step, named[0]!.extra.why], ["git.dangling_ref_unrepaired", "repair_failed"]);

  // An outer helper that sees that error does not repair again: the fetch retry over the leaf, with a real failed
  // refetch (a dangling local branch fails it, MEASURED d).
  rows = [];
  const nested = fixture();
  pushDangling(nested, ["beat"]);
  danglingOwnRef(nested, "refs/heads/lost");
  const lines = refLines(nested);
  const outer = withGitShim(() => fetchOriginRetryingRefLock((args) => hostWorktreeGit(nested.clone, args), () => {}, 3, "main"));
  assert.ok("error" in outer);
  assert.equal(count(outer.calls, /for-each-ref/), 1, outer.calls.join("\n"));
  assert.equal(refLines(nested), lines);
  assert.ok((outer.error as { danglingRefRepair?: { repairError?: unknown } }).danglingRefRepair?.repairError);

  // The words, but no ref with a missing object: nothing to repair, the original error, one row saying so.
  rows = [];
  const healthy = fixture();
  const real = recordingGit(healthy);
  const words = Object.assign(new Error("Command failed: git fetch"), { stderr: "error: origin did not send all necessary objects" });
  assert.throws(() => retryAfterDanglingRefRepair((args) => real.run(args), MAIN, words, () => assert.fail("no retry")), (e) => e === words);
  assert.deepEqual(rows.map((r) => r.extra.why), ["no_dangling_ref"]);
  assert.equal(count(real.calls.map((c) => c.join(" ")), /ls-remote|--refetch/), 0);
});

test("W1-T13409 criterion 6: invariant:the-repair-is-bounded-and-never-loops — one listing, one pass, one retry, inside its BACKSTOPs", async () => {
  // Counted on a real repair.
  const fx = fixture();
  pushDangling(fx, ["beat"]);
  const counted = withGitShim(() => hostWorktreeGit(fx.clone, MAIN));
  assert.ok(!("error" in counted));
  for (const [pattern, n] of [[/for-each-ref/, 1], [/rev-list/, 1], [/ls-remote/, 1], [/--refetch/, 1], [/fetch origin main$/, 2]] as const) {
    assert.equal(count(counted.calls, pattern), n, `${pattern}: ${counted.calls.join("\n")}`);
  }

  // More dangling refs than the ref BACKSTOP (16): reported with the count, not repaired.
  rows = [];
  const many = fixture();
  pushDangling(many, Array.from({ length: 17 }, (_, i) => `beat-${i}`));
  const over = withGitShim(() => hostWorktreeGit(many.clone, MAIN));
  assert.ok("error" in over);
  assert.equal(count(over.calls, /ls-remote|--refetch|update-ref/), 0);
  assert.deepEqual(rows.map((r) => [r.extra.why, r.extra.count]), [["over_the_bound", 17]]);

  // The time BACKSTOPs: the listing gets 30 s and the repair 120 s, and a call past its bound is a failed repair.
  rows = [];
  const bounded = fixture();
  pushDangling(bounded, ["beat"]);
  const runner = recordingGit(bounded);
  const timeouts = new Map<string, number>();
  const original = (() => {
    try {
      runner.run(MAIN);
    } catch (error) {
      return error;
    }
    return assert.fail("the fixture breaks a plain fetch");
  })();
  retryAfterDanglingRefRepair((args, ms) => {
    timeouts.set(args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "", ms);
    return runner.run(args);
  }, MAIN, original, () => runner.run(MAIN));
  assert.ok(timeouts.get("for-each-ref")! <= 30_000 && timeouts.get("for-each-ref")! > 25_000);
  assert.ok(timeouts.get("ls-remote")! <= 120_000 && timeouts.get("ls-remote")! > 100_000);
  for (const stall of ["for-each-ref", "ls-remote"]) {
    rows = [];
    const stalled = fixture();
    pushDangling(stalled, ["beat"]);
    const real = recordingGit(stalled);
    const failure = (() => {
      try {
        real.run(MAIN);
      } catch (error) {
        return error;
      }
      return assert.fail("the fixture breaks a plain fetch");
    })();
    const hang: AsyncGitRunner = (args, signal, env) => args.includes(stall)
      ? new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))))
      : real.runAsync(args, signal, env);
    await assert.rejects(retryAfterDanglingRefRepairAsync((args, ms) => boundGitCall(hang, args, ms), MAIN, failure,
      () => real.runAsync(MAIN), { maxRefs: 16, listMs: 200, repairMs: 200 }), (e) => e === failure);
    assert.match(String((failure as { danglingRefRepair: { repairError: Error } }).danglingRefRepair.repairError.message), /exceeded its \d+ms bound/);
    assert.equal(rows.filter((r) => r.extra.why === "repair_failed").length, 1);
    assert.equal(count(real.calls.map((c) => c.join(" ")), /--refetch/), 0);
  }

  // A retry that fails with the same words is thrown, with no second repair.
  rows = [];
  const calls: string[] = [];
  const words = (): Error => Object.assign(new Error("Command failed: git fetch"), { stderr: "fatal: bad object refs/remotes/origin/beat" });
  const id = "1".repeat(40);
  const scripted = (args: string[]): string => {
    calls.push(args.join(" "));
    if (args[0] === "for-each-ref") return `${id} refs/remotes/origin/beat \n`;
    if (args[0] === "ls-remote") return `${id}\trefs/heads/beat\n`;
    return "";
  };
  let fetches = 1;
  const first = words();
  assert.throws(() => retryAfterDanglingRefRepair(scripted, MAIN, first, () => {
    fetches++;
    throw words();
  }), (e) => e !== first && "danglingRefRepair" in (e as object));
  assert.equal(fetches, 2);
  assert.equal(count(calls, /for-each-ref/), 1);
  assert.equal(count(calls, /--refetch/), 1);
  calls.length = 0;
  const firstAsync = words();
  await assert.rejects(retryAfterDanglingRefRepairAsync(async (args) => scripted(args), MAIN, firstAsync, async () => {
    fetches++;
    throw words();
  }), (e) => e !== firstAsync && "danglingRefRepair" in (e as object));
  assert.equal(fetches, 3);
  assert.equal(count(calls, /for-each-ref/), 1);
});

test("W1-T13409 criterion 7: meaningOfStep names both repair steps and the function that writes them", () => {
  for (const step of ["git.dangling_ref_repaired", "git.dangling_ref_unrepaired"]) {
    const row = meaningOfStep(step);
    assert.ok(row, step);
    assert.deepEqual(row.writer, ["danglingRefRepairPlan"]);
    assert.ok(row.outcomes.length > 0);
  }
  assert.deepEqual(meaningOfStep("git.dangling_ref_repaired")!.outcomes, ["refetched", "removed"]);
});
