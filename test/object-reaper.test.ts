import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  defaultCountPrunable,
  defaultLooseObjectCount,
  LOOSE_OBJECT_FLOOR,
  OBJECT_PRUNE_EXPIRY,
  defaultListInflightLocks,
  defaultListWorktrees,
  objectReapRefusal,
  reapGitObjects,
} from "../src/lib/object-reaper.js";

// W1-T3090 — the reap is a DESTRUCTIVE git operation inside an unattended loop, so every arm that
// keeps it from running is tested separately. One "malformed input" case would pass while the rest
// stayed dead, and the cost of a dead arm here is a corrupted worker checkout, not a failed test.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}obj-reaper-`));
}

/** A repo dir with a `.git` and a `gc.log`, so the ordering assertions have something to observe. */
function repoWithGcLog(): { repoDir: string; gcLog: string } {
  const repoDir = scratch();
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  const gcLog = join(repoDir, ".git", "gc.log");
  writeFileSync(gcLog, "warning: There are too many unreachable loose objects\n");
  return { repoDir, gcLog };
}

/** Deps that would ALLOW a prune, so each test can spoil exactly one thing. */
const quietDeps = {
  listWorktrees: () => [],
  listInflightLocks: () => [],
  openFileCount: () => 0,
  looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
};

// ── the refusal arms ──────────────────────────────────────────────────────────────────────────

test("W1-T3090: each refusal arm names its cause", () => {
  const registered = objectReapRefusal("/r", "/i", { ...quietDeps, listWorktrees: () => ["/w/a", "/w/b"] });
  assert.match(registered ?? "", /2 worktree\(s\) registered/, "a registered worktree refuses");
  assert.match(registered ?? "", /about to reference/, "and says why, in the operator's own terms");

  const locked = objectReapRefusal("/r", "/i", { ...quietDeps, listInflightLocks: () => ["W1-T1.lock"] });
  assert.match(locked ?? "", /1 inflight lock\(s\) held/, "an inflight lock refuses");

  const held = objectReapRefusal("/r", "/i", { ...quietDeps, openFileCount: () => 3 });
  assert.match(held ?? "", /3 open handle\(s\) under \.git/, "an open handle refuses");

  // THE POSITIVE CONTROL: the three arms above are arms, not a function that always refuses.
  assert.equal(objectReapRefusal("/r", "/i", quietDeps), undefined, "all clear proceeds");
});

test("W1-T3090: the liveness probe fails CLOSED — an absent probe refuses rather than authorising", () => {
  // openFileCount omitted entirely: the default must be "something holds it", never "nothing does".
  const r = objectReapRefusal("/r", "/i", { listWorktrees: () => [], listInflightLocks: () => [] });
  assert.match(r ?? "", /open handle\(s\)/, "no probe supplied must read as held, not as clear");
});

test("W1-T3090: an unreadable worktree list or lock dir is not an empty one", () => {
  assert.deepEqual(defaultListWorktrees("/no/such/repo/at/all"), ["<unreadable>"]);
  assert.deepEqual(defaultListInflightLocks(join(scratch(), "nope", "deeper")), [], "an ABSENT dir is genuinely empty");
  // ...but a path that exists and cannot be read as a directory is unreadable, not empty.
  const f = join(scratch(), "a-file");
  writeFileSync(f, "x");
  assert.deepEqual(defaultListInflightLocks(f), ["<unreadable>"]);
});

// ── gc.log ordering, which is load-bearing ────────────────────────────────────────────────────

test("W1-T3090: a refused pass leaves gc.log in place, so auto-gc stays suppressed", () => {
  const { repoDir, gcLog } = repoWithGcLog();
  const r = reapGitObjects(repoDir, "/i", {
    ...quietDeps,
    listWorktrees: () => ["/w/live"],
    runPrune: () => assert.fail("a refused pass must not prune"),
  });
  assert.equal(r.pruned, 0);
  assert.match(r.refusedBecause ?? "", /worktree/);
  assert.equal(existsSync(gcLog), true, "removing it here would re-arm the unsupervised auto-gc");
});

test("W1-T3090: a pass that prunes removes gc.log first, so the suppressor comes off only with a fix", () => {
  const { repoDir, gcLog } = repoWithGcLog();
  let sawGcLogAtPruneTime: boolean | undefined;
  const r = reapGitObjects(repoDir, "/i", {
    ...quietDeps,
    runPrune: () => {
      sawGcLogAtPruneTime = existsSync(gcLog);
    },
  });
  assert.equal(sawGcLogAtPruneTime, false, "gc.log is gone BEFORE prune runs, not after");
  assert.equal(r.refusedBecause, undefined);
});

// ── the expiry, which is the second barrier ───────────────────────────────────────────────────

test("W1-T3090: prune always carries its expiry, and is never bare", () => {
  let argv: readonly string[] = [];
  reapGitObjects(repoWithGcLog().repoDir, "/i", { ...quietDeps, runPrune: (_d, a) => { argv = a; } });
  assert.deepEqual(argv, ["prune", `--expire=${OBJECT_PRUNE_EXPIRY}`]);
  assert.equal(argv.includes("prune"), true);
  assert.equal(
    argv.some((a) => a.startsWith("--expire=")),
    true,
    "the expiry is the second of two barriers — a bare prune collapses them into one",
  );
  assert.notEqual(OBJECT_PRUNE_EXPIRY, "now", "an expiry of now is a bare prune wearing a flag");
});

test("W1-T3090: only prune is ever spawned — no gc, no repack, no ref rewriting", () => {
  let argv: readonly string[] = [];
  reapGitObjects(repoWithGcLog().repoDir, "/i", { ...quietDeps, runPrune: (_d, a) => { argv = a; } });
  assert.equal(argv.includes("gc"), false, "gc repacks and can rewrite refs and reflogs");
  assert.equal(argv.includes("repack"), false);
  assert.equal(argv.includes("--prune=now"), false);
  assert.equal(argv[0], "prune", "the verb is prune and nothing else");
});

// ── the floor ─────────────────────────────────────────────────────────────────────────────────

test("W1-T3090: below the loose-object floor the reap skips, and says so rather than staying silent", () => {
  const r = reapGitObjects(repoWithGcLog().repoDir, "/i", {
    ...quietDeps,
    looseObjectCount: () => LOOSE_OBJECT_FLOOR - 1,
    runPrune: () => assert.fail("must not prune below the floor"),
  });
  assert.equal(r.pruned, 0);
  assert.match(r.refusedBecause ?? "", /below the \d+ floor/);
  assert.equal(r.looseBefore, LOOSE_OBJECT_FLOOR - 1, "and it reports what it measured");
});

test("W1-T3090: the floor is checked BEFORE the quiet probes, so a quiet repo with nothing to do costs no lsof", () => {
  let probed = false;
  reapGitObjects(repoWithGcLog().repoDir, "/i", {
    ...quietDeps,
    looseObjectCount: () => 0,
    openFileCount: () => { probed = true; return 0; },
    runPrune: () => assert.fail("nothing to do"),
  });
  assert.equal(probed, false, "the cheap check gates the expensive one");
});

// ── what it reports ───────────────────────────────────────────────────────────────────────────

test("W1-T3090: pruned counts the DROP in loose objects, and never goes negative", () => {
  let n = 0;
  const counts = [LOOSE_OBJECT_FLOOR + 100, LOOSE_OBJECT_FLOOR];
  const r = reapGitObjects(repoWithGcLog().repoDir, "/i", {
    ...quietDeps,
    looseObjectCount: () => counts[n++] ?? 0,
    runPrune: () => {},
  });
  assert.equal(r.pruned, 100);

  // A repo that GREW during the prune (a concurrent write) must report 0, not a negative.
  let m = 0;
  const grew = [LOOSE_OBJECT_FLOOR, LOOSE_OBJECT_FLOOR + 50];
  const r2 = reapGitObjects(repoWithGcLog().repoDir, "/i", {
    ...quietDeps,
    looseObjectCount: () => grew[m++] ?? 0,
    runPrune: () => {},
  });
  assert.equal(r2.pruned, 0);
});

// ── the real thing, against a real repo ───────────────────────────────────────────────────────

test("W1-T3090: against a REAL git repo the default probes agree it is quiet and prune runs clean", () => {
  const repoDir = scratch();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", "-b", "main", repoDir], { env });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"], { env });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "t"], { env });
  writeFileSync(join(repoDir, "f.txt"), "x\n");
  execFileSync("git", ["-C", repoDir, "add", "."], { env });
  execFileSync("git", ["-C", repoDir, "commit", "-qm", "c"], { env });

  // A fresh repo has ONE worktree (itself), which must NOT be read as a reason to refuse.
  assert.deepEqual(defaultListWorktrees(repoDir), [], "the repo's own entry is not a registered worktree");

  // Drive the real prune path, but keep the floor from short-circuiting it.
  const r = reapGitObjects(repoDir, join(repoDir, "no-inflight"), {
    looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
    openFileCount: () => 0,
  });
  assert.equal(r.refusedBecause, undefined, "a real quiet repo is not refused");
  assert.equal(existsSync(join(repoDir, ".git")), true, "and the repo survives its own reap");
  execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { env, stdio: "ignore" });
});

// ── W1-T3090: the UN-INJECTED default, which every other test in this file replaces ─────────
//
// `defaultLooseObjectCount` is the real leaf: it shells `git count-objects -v`. Every test above
// supplies its own counter, so the default and its catch arm were never executed and `diff-coverage`
// named them as added-and-uncovered. That is the shape CLAUDE.md records — "when every test injects
// a fake, the seam's DEFAULT implementation and each catch arm are unreachable" — so these two
// exercise the real thing against a real repository and a real non-repository.

test("W1-T3090: the default counter reads a REAL repository rather than being replaced by a fake", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}loose-count-`));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
    });
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // A fresh commit leaves loose objects (blob, tree, commit) — unpacked until a gc runs.
  assert.ok(defaultLooseObjectCount(dir) > 0, "a just-committed repo has loose objects to count");
});

test("W1-T3092: the default PRUNABLE counter shells out to a REAL repository rather than being replaced by a fake", () => {
  // The survey seam's own default. Every other test here supplies `countPrunable`, so without this
  // case `defaultCountPrunable` never executes at all — the all-fakes shape CLAUDE.md records, and
  // the same gap #4527's review closed for `defaultLooseObjectCount` directly above.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prunable-count-`));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
    });
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // An unreferenced blob is exactly what a prune removes; `--expire=now` makes it eligible at once.
  const dangling = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { encoding: "utf8", input: "orphan\n" }).trim();
  assert.match(dangling, /^[0-9a-f]{40}$/, "the fixture really wrote a loose object");
  assert.ok(
    defaultCountPrunable(dir, ["prune", "-n", "--expire=now"]) > 0,
    "a repo holding an unreferenced object reports a non-zero would-prune count",
  );
});

test("W1-T3092: an unreadable PRUNABLE count reads as 0, never a throw — the safe direction for a survey", () => {
  // The catch arm. 0 is what a survey reports when it cannot measure; the value is ledgered and
  // never compared against a threshold, so reporting nothing can never authorise a prune.
  const notARepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prunable-norepo-`));
  assert.equal(defaultCountPrunable(notARepo, ["prune", "-n", "--expire=now"]), 0);
  assert.equal(defaultCountPrunable("/no/such/path/at/all", ["prune", "-n"]), 0, "a missing path is unreadable, not a throw");
});

test("W1-T3090: an unreadable count reads as 0, which can only ever cause a SKIP", () => {
  // The catch arm, and its direction is the safety property: 0 is BELOW the prune floor, so an
  // unreadable count can never authorise a prune. A throw here would fail the whole rung instead.
  const notARepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}loose-count-norepo-`));
  assert.equal(defaultLooseObjectCount(notARepo), 0);
  assert.equal(defaultLooseObjectCount("/no/such/path/at/all"), 0, "a missing path is unreadable, not a throw");
});
