import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { basename, join } from "node:path";

import {
  buildFreshTreeReviewRunner,
  buildReviewerCodeFreshnessGate,
  spawnRmdReviewForFreshTree,
} from "#src/run-task.js";
import { ReviewerWorktreeLeasedError } from "#src/lib/reviewer-worktree-lease.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// ── W1-T3723 — A STALE REVIEWER REVIEWS FROM A FRESH TREE INSTEAD OF WAITING FOR A RESTART ────
//
// THE LOOP, MEASURED 2026-09-17. #5873 merged, touching src/lib/review.ts. The daemon's reviewer
// went 3 commits behind origin/main and refused to judge (W1-T228 — a stale judge is worse than a
// late one). Its checkout is DETACHED by the entrypoint's pin semantics, and self-sync refuses to
// fast-forward a detached HEAD (W1-T445). So the only recovery was a restart — and
// deploy/recycle-container.sh REFUSED it, because the host's instance registry declares instances
// and the self-restart names none. Seven `review.skipped_stale_reviewer_code` rows in 45 minutes
// naming #5883 and #5876; an hour with no reviews; every green PR reviewed by hand.
//
// Merging a fix to the reviewer stopped the reviewer, and nothing could start it again.

const STALE = { status: "stale" as const, codeSha: "aaaaaaaaaaaa", originMainSha: "bbbbbbbbbbbb", changedPaths: ["src/lib/review.ts"] };
const FRESH = { status: "fresh" as const, codeSha: "cccccccccccc", originMainSha: "cccccccccccc", advance: "none" as const };

function gateWith(freshness: typeof STALE | typeof FRESH, fresh?: (p: string, r: string[], f: never) => Promise<number | undefined>) {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let nextCalls = 0;
  const gate = buildReviewerCodeFreshnessGate(
    () => freshness,
    (step, extra) => { steps.push({ step, extra }); },
    async () => { nextCalls += 1; return 0; },
    fresh as never,
  );
  return { gate, steps, nextCalls: () => nextCalls };
}

test("a stale reviewer runs the review from a fresh tree instead of skipping it", async () => {
  const seen: string[] = [];
  const { gate, steps } = gateWith(STALE, async (pr) => { seen.push(pr); return 0; });
  const code = await gate.call("5883", [], {} as never);
  assert.equal(code, 0);
  assert.deepEqual(seen, ["5883"], "the fresh-tree runner must actually be asked to review this PR");
  assert.ok(steps.some((s) => s.step === "review.ran_from_fresh_tree"), "the run must be ledgered as such");
  assert.ok(!steps.some((s) => s.step === "review.skipped_stale_reviewer_code"), "a PR that WAS reviewed must not also report a skip");
});

test("a fresh reviewer still reviews in-process, so the ordinary path is untouched", async () => {
  const { gate, steps, nextCalls } = gateWith(FRESH, async () => 0);
  await gate.call("5883", [], {} as never);
  assert.equal(nextCalls(), 1, "a fresh reviewer must not pay for a worktree or a spawn");
  assert.deepEqual(steps, []);
});

test("a fresh tree that cannot be prepared falls back to the skip, never to a stale verdict", async () => {
  // THE DIRECTION THAT MATTERS. This may review with FRESH code or not at all; it must never
  // make a stale reviewer judge anyway.
  const { gate, steps, nextCalls } = gateWith(STALE, async () => undefined);
  const code = await gate.call("5883", [], {} as never);
  assert.equal(code, 0);
  assert.equal(nextCalls(), 0, "the in-process reviewer must NOT run with stale code");
  const skip = steps.find((s) => s.step === "review.skipped_stale_reviewer_code");
  assert.ok(skip, "W1-T3691's recurrence ladder must still see a skip it can escalate");
  assert.equal(skip?.extra?.fresh_tree, "unavailable");
});

test("with no runner wired at all the gate behaves exactly as it did before", async () => {
  const { gate, steps, nextCalls } = gateWith(STALE, undefined);
  assert.equal(await gate.call("5883", [], {} as never), 0);
  assert.equal(nextCalls(), 0);
  assert.equal(steps[0]?.step, "review.skipped_stale_reviewer_code");
  assert.equal(steps[0]?.extra?.fresh_tree, undefined, "the untouched path must not gain a field");
});

test("the stale pass is still reported, so a fresh-tree review does not hide the lag", async () => {
  const { gate } = gateWith(STALE, async () => 0);
  await gate.call("5883", [], {} as never);
  assert.deepEqual(gate.staleThisPass(), { oldSha: STALE.codeSha, newSha: STALE.originMainSha });
});

// ── The runner ───────────────────────────────────────────────────────────────────────────────

function runnerWith(over: {
  git?: (a: string[]) => string;
  spawn?: (w: string, a: string[]) => Promise<number>;
  addWorktree?: (d: string, p: string, r: string) => void;
  inspectExistingWorktree?: (d: string, p: string, r: string) => "absent" | "reusable" | "unsafe";
  prepareWorktree?: (d: string, p: string) => boolean;
} = {}) {
  const gitCalls: string[][] = [];
  const spawns: Array<{ worktree: string; args: string[] }> = [];
  const created = new Set<string>();
  const runner = buildFreshTreeReviewRunner("/repo", {
    git: over.git ?? ((a) => { gitCalls.push(a); return ""; }),
    // Recorded through the SAME channel as the git calls, so the "no ref is moved" assertion sees
    // the worktree creation too rather than going blind to it.
    addWorktree: (d, p, r) => {
      (over.addWorktree ?? ((dir, path, revision) => { gitCalls.push(["-C", dir, "worktree", "add", "--detach", path, revision]); }))(d, p, r);
      created.add(p);
    },
    spawnReview: over.spawn ?? (async (worktree, args) => { spawns.push({ worktree, args }); return 0; }),
    inspectExistingWorktree: over.inspectExistingWorktree ?? ((_d, path) => created.has(path) ? "reusable" : "absent"),
    withWorktreeLease: async (_path, action) => action(),
    prepareWorktree: over.prepareWorktree ?? (() => true),
    worktreeRoot: "/wt",
  });
  return { runner, gitCalls, spawns };
}

test("the runner cuts a DETACHED worktree at origin/main and never moves an existing ref", async () => {
  // W1-T445 refuses self-sync on a detached HEAD because advancing it turns a base-vs-head diff
  // into head-vs-head. Adding a NEW tree cannot do that, and this asserts nothing else is moved.
  const { runner, gitCalls } = runnerWith();
  await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" });
  const joined = gitCalls.map((a) => a.join(" "));
  assert.ok(joined.some((c) => c.includes("worktree add --detach")), "the tree must be detached");
  assert.ok(joined.every((c) => !/\b(merge|reset|checkout|pull)\b/.test(c)), `no ref may be moved: ${joined.join(" | ")}`);
});

test("one worktree per code sha, reused across the PRs of a pass", async () => {
  const { runner, gitCalls, spawns } = runnerWith();
  for (const pr of ["5883", "5876", "5870"]) await runner(pr, [], { originMainSha: "bbbbbbbbbbbb" });
  assert.equal(gitCalls.filter((a) => a.includes("add")).length, 1, "six PRs behind one lag must pay one worktree");
  assert.equal(spawns.length, 3, "but every PR must still be reviewed");
  assert.equal(new Set(spawns.map((s) => s.worktree)).size, 1);
});

test("a different lag gets its own tree, so a later review cannot reuse an earlier sha's code", async () => {
  const { runner, gitCalls } = runnerWith();
  await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" });
  await runner("5884", [], { originMainSha: "dddddddddddd" });
  assert.equal(gitCalls.filter((a) => a.includes("add")).length, 2);
});

test("a git failure is undefined, not an exception and not a verdict", async () => {
  const { runner } = runnerWith({ git: () => { throw new Error("worktree add failed"); } });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), undefined);
});

test("a spawn failure is undefined too, so the caller falls back rather than inventing a code", async () => {
  const { runner } = runnerWith({ spawn: async () => { throw new Error("spawn failed"); } });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), undefined);
});

test("the child's exit code is returned verbatim, so a real review failure still fails", async () => {
  const { runner } = runnerWith({ spawn: async () => 1 });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), 1);
});

test("W1-T3962 fresh reviewer dependency link control: preparation happens after adding and before the review child, without an install", async () => {
  const events: string[] = [];
  const { runner } = runnerWith({
    addWorktree: () => { events.push("add"); },
    prepareWorktree: () => { events.push("link-and-exclude"); return true; },
    spawn: async () => { events.push("spawn"); return 0; },
  });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), 0);
  assert.deepEqual(events, ["add", "link-and-exclude", "spawn"], "a reviewer may spawn only after its canonical dependencies are ready");
  assert.ok(events.every((event) => !event.includes("install")), "a fresh reviewer tree must link dependencies, never install them");
});

test("W1-T3962 fresh reviewer preparation refusal never spawns an incomplete tree", async () => {
  let spawns = 0;
  const { runner } = runnerWith({
    prepareWorktree: () => false,
    spawn: async () => {
      spawns += 1;
      return 0;
    },
  });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), undefined);
  assert.equal(spawns, 0, "a reviewer with no proven dependency link must not run");
});

test("W1-T3962 fresh reviewer unproven tree control, W1-T14066 criterion 4: a mismatched or dirty shared tree is never added over or reviewed in; a missing or unreadable one never adds or spawns", async () => {
  for (const reason of ["mismatched", "dirty", "missing", "unreadable"]) {
    const added: string[] = [];
    const removed: string[] = [];
    const spawns: string[] = [];
    const revision = "bbbbbbbbbbbb";
    const worktree = `/wt/reviewer-${revision}`;
    const runner = buildFreshTreeReviewRunner("/repo", {
      git: (args) => {
        if (args.includes("fetch")) return "";
        if (args.includes("worktree") && args.includes("list")) {
          if (reason === "unreadable") throw new Error("registry unreadable");
          const own = added.map((path) => `worktree ${path}\nHEAD ${revision}\ndetached\n\n`).join("");
          return `worktree ${worktree}\nHEAD ${reason === "mismatched" ? "aaaaaaaaaaaa" : revision}\ndetached\n\n${own}`;
        }
        const ownTree = added.includes(args[1] ?? "");
        if (args.includes("rev-parse")) {
          if (reason === "missing" && !ownTree) throw new Error("registered checkout missing");
          return `${revision}\n`;
        }
        if (args.includes("status")) return reason === "dirty" && !ownTree ? " M tracked.ts\n" : "";
        throw new Error(`unexpected git read: ${args.join(" ")}`);
      },
      addWorktree: (_dir, path) => { added.push(path); },
      // This control isolates the trust boundary: the unsafe-tree guard, not an unrelated
      // dependency-source absence, must be what prevents mismatched/dirty trees reaching a child.
      prepareWorktree: () => true,
      withWorktreeLease: async (_path, action) => action(),
      removeWorktree: (_dir, path) => { removed.push(path); },
      spawnReview: async (tree) => { spawns.push(tree); return 0; },
      worktreeRoot: "/wt",
    });
    const code = await runner("5883", [], { originMainSha: revision });
    assert.ok(!added.includes(worktree), `${reason}: an unproven collision must not be replaced`);
    assert.ok(!spawns.includes(worktree), `${reason}: an unproven checkout must not judge`);
    if (reason === "mismatched" || reason === "dirty") {
      assert.equal(code, 0, `${reason}: the review runs from its own tree`);
      assert.equal(added.length, 1, reason);
      assert.match(added[0]!, new RegExp(`^/wt/reviewer-${revision}-${process.pid}-[0-9a-f]{8}$`), reason);
      assert.deepEqual(spawns, added, `${reason}: the review runs only in the tree it cut`);
      assert.deepEqual(removed, added, `${reason}: the own tree is removed once the review settles`);
    } else {
      assert.equal(code, undefined, reason);
      assert.equal(added.length, 0, `${reason}: no tree is cut`);
      assert.equal(spawns.length, 0, `${reason}: no review runs`);
      assert.equal(removed.length, 0, reason);
    }
  }
});

test("W1-T3962 fresh reviewer restart reuse control: the production defaults reuse an exact clean detached tree and link its canonical dependencies", async () => {
  const root = makeTempDir("t3962-fresh-reviewer-restart");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const sourceStore = gitRepo({ kind: "t3962-source" });
  const remoteStore = gitRepo({ bare: true, kind: "t3962-remote" });
  const repo = sourceStore.dir;
  const remote = remoteStore.dir;
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  mkdirSync(join(repo, "node_modules"));
  sourceStore.git("add", "tracked.txt");
  sourceStore.git("commit", "--quiet", "-m", "base");
  sourceStore.addRemote("origin", remote);
  sourceStore.git("push", "--quiet", "-u", "origin", "HEAD:main");
  const sha = sourceStore.git("rev-parse", "origin/main");
  let adds = 0;
  const spawns: string[] = [];
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).toString();
  const addTree = (dir: string, path: string, revision: string) => {
    adds += 1;
    execFileSync("git", ["-C", dir, "worktree", "add", "--detach", path, revision], { stdio: "pipe" });
  };
  const build = () => buildFreshTreeReviewRunner(repo, {
    git,
    addWorktree: addTree,
    spawnReview: async (worktree) => { spawns.push(worktree); return 0; },
    worktreeRoot,
  });
  const first = build();
  assert.equal(await first("5883", [], { originMainSha: sha }), 0);
  const reviewerTree = join(worktreeRoot, `reviewer-${sha.slice(0, 12)}`);
  assert.ok(lstatSync(join(reviewerTree, "node_modules")).isSymbolicLink(), "the canonical dependency source must be linked into a new reviewer tree");
  assert.doesNotThrow(() => execFileSync("git", ["-C", reviewerTree, "check-ignore", "-q", "node_modules"]), "the generated dependency link must be excluded from git status");
  // A new runner is the restart boundary: its in-memory map is empty, so only the real worktree
  // registry, detached SHA, and clean porcelain proof can authorize reuse.
  const afterRestart = build();
  assert.equal(await afterRestart("5884", [], { originMainSha: sha }), 0);
  assert.equal(adds, 1, "the stable path must be reused after restart instead of colliding on git worktree add");
  assert.deepEqual(spawns, [reviewerTree, reviewerTree]);
});

// ── The real spawnReview seam (W1-T3723) — the fake above stands in for this in every test up to
// here; this drives the PRODUCTION wiring itself so it is not left an uncalled construction-only
// closure (the shape diff-coverage.mjs flags on an added line lcov never sees hit).

test("spawnRmdReviewForFreshTree executes the fresh tree's bash rmd wrapper and resolves to its exit code", async () => {
  const dir = makeTempDir("t3723-fresh-tree-spawn");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const wrapper = join(dir, "bin", "rmd");
  // The shell grammar deliberately makes the old `process.execPath <bin/rmd>` form fail:
  // the real wrapper must be executed directly and receive the fixed `review` subcommand.
  writeFileSync(wrapper, '#!/usr/bin/env bash\nif [ "$1" != "review" ]; then exit 41; fi\nif [ "$2" != "5883" ]; then exit 42; fi\nexit "$3"\n');
  chmodSync(wrapper, 0o755);
  const code = await spawnRmdReviewForFreshTree(dir, ["5883", "7"]);
  assert.equal(code, 7, "the executable wrapper's own exit code must come back verbatim");
});

test("an App-backed fresh-tree review starts with a new token while a non-App review keeps its caller token", async () => {
  const dir = makeTempDir("fresh-tree-review-token");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const wrapper = join(dir, "bin", "rmd");
  writeFileSync(wrapper, '#!/usr/bin/env bash\n[ "$RMD_SELF_SYNC_DONE" = "1" ] || exit 41\nif [ "$2" = app ]; then [ -z "${GH_TOKEN:-}" ] || exit 42; else [ "$GH_TOKEN" = operator ] || exit 43; fi\n');
  chmodSync(wrapper, 0o755);
  const appEnv = { ...process.env, GH_TOKEN: "inherited-installation-token", GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/mounted/key" };
  assert.equal(await spawnRmdReviewForFreshTree(dir, ["app"], undefined, appEnv), 0);
  assert.equal(appEnv.GH_TOKEN, "inherited-installation-token", "the daemon's own token is untouched");
  const operatorEnv = { ...process.env, GH_TOKEN: "operator", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "" };
  assert.equal(await spawnRmdReviewForFreshTree(dir, ["operator"], undefined, operatorEnv), 0);
});

// ── W1-T14066 — A BUSY SHARED REVIEWER TREE: THE REVIEW CUTS ITS OWN TREE AT THE SAME SHA ────────
//
// 2026-11-19T18:00Z to 2026-11-20T18:50Z: 29 review.skipped_stale_reviewer_code rows said "reviewer
// worktree is leased by another owner". Each review child is its own process, so a second child at
// one origin/main sha could not borrow the tree the first child held, and the review was skipped.

const BUSY_SHA = "bbbbbbbbbbbb";
const SHARED = `/wt/reviewer-${BUSY_SHA}`;
const OWN_TREE = new RegExp(`^/wt/reviewer-${BUSY_SHA}-${process.pid}-[0-9a-f]{8}$`);

/** The shared tree exists and is proven, but its lease is held by a review in another process. */
function busyRunner(over: {
  git?: (a: string[]) => string;
  lease?: (path: string) => Error | undefined;
  addWorktree?: (path: string) => void;
  inspectOwn?: "reusable" | "unsafe";
  prepareWorktree?: (path: string) => boolean;
  removeWorktree?: (path: string) => void;
  spawn?: (w: string) => Promise<number>;
} = {}) {
  const events: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const spawns: string[] = [];
  const failures: string[] = [];
  const inspected: Array<{ path: string; revision: string }> = [];
  const runner = buildFreshTreeReviewRunner("/repo", {
    git: over.git ?? (() => ""),
    addWorktree: (_d, path) => { over.addWorktree?.(path); added.push(path); events.push(`add ${path}`); },
    inspectExistingWorktree: (_d, path, revision) => {
      inspected.push({ path, revision });
      if (path === SHARED) return "reusable";
      return added.includes(path) ? over.inspectOwn ?? "reusable" : "absent";
    },
    prepareWorktree: (_d, path) => over.prepareWorktree?.(path) ?? true,
    withWorktreeLease: async (path, action) => {
      const refusal = over.lease ? over.lease(path) : path === SHARED ? new ReviewerWorktreeLeasedError() : undefined;
      if (refusal) throw refusal;
      return action();
    },
    removeWorktree: (_d, path) => { events.push(`remove ${path}`); removed.push(path); over.removeWorktree?.(path); },
    spawnReview: async (tree) => {
      events.push(`spawn ${tree}`);
      spawns.push(tree);
      try { return await (over.spawn ?? (async () => 0))(tree); }
      finally { events.push(`settled ${tree}`); }
    },
    worktreeRoot: "/wt",
  });
  const run = () => runner("5883", [], { originMainSha: BUSY_SHA }, (failure) => { failures.push(failure); });
  return { run, events, added, removed, spawns, failures, inspected };
}

test("W1-T14066 criterion 1: a shared tree leased by another owner sends the review to its own proven tree at the same sha, removed once after the child settles", async () => {
  const rig = busyRunner({ spawn: async () => 3 });
  assert.equal(await rig.run(), 3, "the own tree's child exit code is returned verbatim");
  assert.equal(rig.added.length, 1, "exactly one own tree is cut");
  const own = rig.added[0]!;
  assert.match(own, OWN_TREE);
  assert.deepEqual(rig.spawns, [own], "spawnReview runs only in the own tree");
  assert.ok(!rig.spawns.includes(SHARED), "the busy shared tree is never reviewed in");
  assert.ok(rig.inspected.some((entry) => entry.path === own && entry.revision === BUSY_SHA), "the own tree is proven at the sha");
  assert.deepEqual(rig.removed, [own], "the own tree is removed exactly once");
  assert.deepEqual(rig.events, [`add ${own}`, `spawn ${own}`, `settled ${own}`, `remove ${own}`], "removal waits for the child");
  assert.equal(rig.failures.length, 0);

  // An own tree that is not proven an exact clean detached checkout never judges.
  const unproven = busyRunner({ inspectOwn: "unsafe" });
  assert.equal(await unproven.run(), undefined);
  assert.equal(unproven.spawns.length, 0, "an unproven own tree must not judge");
  assert.deepEqual(unproven.removed, unproven.added, "the unproven own tree is still removed");
  assert.match(unproven.failures.join("\n"), /no longer an exact clean detached checkout/);
});

test("W1-T14066 criterion 2: the own tree is removed when spawnReview rejects, and a failed removal never changes the exit code", async () => {
  const rejected = busyRunner({ spawn: async () => { throw new Error("spawn failed"); } });
  assert.equal(await rejected.run(), undefined, "a rejected child is undefined, as on origin/main");
  assert.equal(rejected.removed.length, 1, "the removal runs after a rejected child too");
  assert.deepEqual(rejected.removed, rejected.added);
  assert.match(rejected.failures.join("\n"), /spawn failed/);

  for (const exit of [0, 4]) {
    const brokenRemoval = busyRunner({ spawn: async () => exit, removeWorktree: () => { throw new Error("worktree remove failed"); } });
    assert.equal(await brokenRemoval.run(), exit, `a removal that throws leaves exit ${exit} unchanged`);
    assert.equal(brokenRemoval.removed.length, 1);
    assert.equal(brokenRemoval.failures.length, 0, "a failed removal is not a review failure");
  }
});

test("W1-T14066 criterion 3: with the production lease and a real repository, a shared tree held by a live process of this host is left alone and the review runs from its own tree", async () => {
  const root = makeTempDir("t14066-busy-reviewer-tree");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const sourceStore = gitRepo({ kind: "t14066-source" });
  const remoteStore = gitRepo({ bare: true, kind: "t14066-remote" });
  const repo = sourceStore.dir;
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  mkdirSync(join(repo, "node_modules"));
  sourceStore.git("add", "tracked.txt");
  sourceStore.git("commit", "--quiet", "-m", "base");
  sourceStore.addRemote("origin", remoteStore.dir);
  sourceStore.git("push", "--quiet", "-u", "origin", "HEAD:main");
  const sha = sourceStore.git("rev-parse", "origin/main");
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).toString();
  const shared = join(worktreeRoot, `reviewer-${sha.slice(0, 12)}`);
  git(["-C", repo, "worktree", "add", "--detach", shared, sha]);
  // The W1-T13991 review that held reviewer-e200819f2e11 at 18:47Z: a live process, not this one.
  const lock = `${shared}.lock`;
  const holder = JSON.stringify({ version: "reviewer-worktree-lease-v1", pid: process.ppid, host: hostname(),
    startedAt: new Date().toISOString(), run_id: "work-review-W1-T13991-1795200190867-d6e3" });
  writeFileSync(lock, holder);
  const seen: Array<{ tree: string; head: string; tracked: boolean }> = [];
  const runner = buildFreshTreeReviewRunner(repo, {
    git,
    addWorktree: (dir, path, revision) => { git(["-C", dir, "worktree", "add", "--detach", path, revision]); },
    removeWorktree: (dir, path) => { git(["-C", dir, "worktree", "remove", "--force", path]); },
    spawnReview: async (tree) => {
      seen.push({ tree, head: git(["-C", tree, "rev-parse", "HEAD"]).trim(), tracked: existsSync(join(tree, "tracked.txt")) });
      return 0;
    },
    worktreeRoot,
  });
  assert.equal(await runner("19515", [], { originMainSha: sha }), 0);
  assert.equal(seen.length, 1, "the review ran");
  const own = seen[0]!.tree;
  assert.notEqual(own, shared, "the leased shared tree is never reviewed in");
  assert.match(basename(own), new RegExp(`^reviewer-${sha.slice(0, 12)}-${process.pid}-[0-9a-f]{8}$`));
  assert.equal(seen[0]!.head, sha, "the own tree is at the origin/main sha");
  assert.ok(seen[0]!.tracked, "the own tree is a real checkout");
  assert.equal(readFileSync(lock, "utf8"), holder, "the holder's lease is byte-for-byte unchanged");
  assert.ok(existsSync(join(shared, "tracked.txt")), "the shared tree is not removed");
  assert.ok(!existsSync(own), "the own tree is gone from disk");
  assert.ok(!existsSync(`${own}.lock`), "the own tree's lease is released");
  const listed = git(["-C", repo, "worktree", "list", "--porcelain"]);
  assert.ok(listed.includes(basename(shared)), "the shared tree stays registered");
  assert.ok(!listed.includes(basename(own)), "the own tree is gone from git worktree list");
});

test("W1-T14066 criterion 5: a corrupt lease, a failed fetch, a failed own cut, or an own tree that cannot be made runnable skips with the cause named", async () => {
  // A corrupt or unknown lease on the shared tree, through the production lease: never a reason to cut.
  for (const raw of ["{not json", JSON.stringify({ version: "reviewer-worktree-lease-v0", pid: process.ppid })]) {
    const root = makeTempDir("t14066-corrupt-lease");
    const shared = join(root, `reviewer-${BUSY_SHA}`);
    mkdirSync(shared);
    writeFileSync(`${shared}.lock`, raw);
    const added: string[] = [];
    const removed: string[] = [];
    let spawns = 0;
    const failures: string[] = [];
    const runner = buildFreshTreeReviewRunner("/repo", {
      git: () => "",
      addWorktree: (_d, path) => { added.push(path); },
      inspectExistingWorktree: (_d, path) => path === shared ? "reusable" : "absent",
      prepareWorktree: () => true,
      removeWorktree: (_d, path) => { removed.push(path); },
      spawnReview: async () => { spawns += 1; return 0; },
      worktreeRoot: root,
    });
    assert.equal(await runner("5883", [], { originMainSha: BUSY_SHA }, (f) => { failures.push(f); }), undefined, raw);
    assert.equal(added.length, 0, `${raw}: a corrupt lease is no reason to cut a tree`);
    assert.equal(spawns, 0, raw);
    assert.equal(removed.length, 0, raw);
    assert.equal(readFileSync(`${shared}.lock`, "utf8"), raw, `${raw}: the corrupt lease is preserved`);
    assert.equal(failures.length, 1, raw);
    assert.match(failures[0]!, /JSON|unknown or corrupt lease/, raw);
  }

  const fetchFails = busyRunner({ git: (args) => { if (args.includes("fetch")) throw new Error("fetch refused: origin unreachable"); return ""; } });
  assert.equal(await fetchFails.run(), undefined);
  assert.deepEqual([fetchFails.added.length, fetchFails.spawns.length, fetchFails.removed.length], [0, 0, 0]);
  assert.match(fetchFails.failures.join("\n"), /fetch refused: origin unreachable/);

  const cutFails = busyRunner({ addWorktree: (path) => { if (path !== SHARED) throw new Error("own worktree add failed: disk full"); } });
  assert.equal(await cutFails.run(), undefined);
  assert.equal(cutFails.spawns.length, 0);
  assert.equal(cutFails.removed.length, 0, "a path whose add failed is never removed");
  assert.match(cutFails.failures.join("\n"), /own worktree add failed: disk full/);

  const notRunnable = busyRunner({ prepareWorktree: (path) => path === SHARED });
  assert.equal(await notRunnable.run(), undefined);
  assert.equal(notRunnable.spawns.length, 0);
  assert.equal(notRunnable.added.length, 1);
  assert.deepEqual(notRunnable.removed, notRunnable.added, "an own tree whose add succeeded is removed");
  assert.match(notRunnable.failures.join("\n"), /no runnable canonical node_modules link/);
});
