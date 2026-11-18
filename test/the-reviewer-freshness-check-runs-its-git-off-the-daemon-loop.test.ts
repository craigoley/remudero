/**
 * W1-T13335 — THE REVIEWER FRESHNESS CHECK RUNS ITS GIT OFF THE DAEMON LOOP.
 *
 * Once main had advanced, the async freshness entry points classified the advance with synchronous git: 888
 * spawns and 211.8 s in about six hours on 2026-11-17. Each test builds a real origin and a real checkout of it,
 * and drives the entry points with their production defaults unless it has to make one read fail.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import type { GitRunner } from "#src/lib/git-fetch-retry.js";
import {
  SELF_SYNC_GUARD_ENV,
  checkReviewerCodeFreshness,
  checkReviewerCodeFreshnessAsync,
  probeReviewerCodeFreshnessAsync,
  reviewerCodeFreshnessAt,
  reviewerCodeJudge,
  reviewerGit,
  runTaskAdvanceTouchesReviewPath,
  type ReviewerCodeFreshness,
  type ReviewerCodeFreshnessOptions,
} from "#src/lib/self-sync.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type Files = Record<string, string>;
const TIMEOUT = { timeout: 240_000 };
const RUN_TASK = "src/run-task.ts";
const REVIEW = "src/lib/review.ts";
const PLAN = "src/lib/plan.ts";
/** The fixture's import specifier, built from its parts so this file carries no relative specifier of its own. */
const HELPER_SPECIFIER = [".", "lib", "review.js"].join("/");
const RUN_TASK_SOURCE = [
  `import { helper } from ${JSON.stringify(HELPER_SPECIFIER)};`,
  "",
  "async function runReview(pr: string): Promise<string> {",
  "  return `review ${pr} ${helper}`;",
  "}",
  "",
  "export async function reviewCommand(pr: string): Promise<number> {",
  "  return (await runReview(pr)).length;",
  "}",
  "",
  "export function buildFreshTreeReviewRunner(): string {",
  '  return "fresh";',
  "}",
  "",
  "export function spawnRmdReviewForFreshTree(): string {",
  '  return "spawn";',
  "}",
  "",
  "export function serveDashboard(): string {",
  '  return "served";',
  "}",
  "",
].join("\n");
const START: Files = { [RUN_TASK]: RUN_TASK_SOURCE, [REVIEW]: "export const helper = 1;\n", [PLAN]: "export const plan = 1;\n" };

/** The five advances of main, with the answer each must get. */
const ADVANCES: Array<{ label: string; change?: Files; expected: { status: string; advance?: string; changedPaths?: string[] } }> = [
  { label: "no advance", expected: { status: "fresh", advance: "none", changedPaths: undefined } },
  { label: "a comment-only .ts change", change: { [REVIEW]: "export const helper = 1;\n// only a comment\n" }, expected: { status: "fresh", advance: "immaterial", changedPaths: undefined } },
  { label: "a run-task hunk that avoids the review path", change: { [RUN_TASK]: RUN_TASK_SOURCE.replace('"served"', '"served again"') }, expected: { status: "fresh", advance: "immaterial", changedPaths: undefined } },
  { label: "a run-task hunk that meets the review path", change: { [RUN_TASK]: RUN_TASK_SOURCE.replace("`review ${pr}", "`judged ${pr}") }, expected: { status: "stale", advance: undefined, changedPaths: [RUN_TASK] } },
  { label: "a change to another material path", change: { [PLAN]: "export const plan = 2;\n" }, expected: { status: "stale", advance: undefined, changedPaths: [PLAN] } },
];
const [NONE, COMMENT, AVOIDS, MEETS, OTHER] = ADVANCES.map((advance) => advance.change);

function commit(origin: GitRepo, files: Files): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(origin.dir, path)), { recursive: true });
    writeFileSync(join(origin.dir, path), text);
  }
  origin.git("add", "-A");
  origin.git("commit", "-q", "-m", "edit");
  return origin.git("rev-parse", "HEAD");
}

/** An origin whose main is the start commit plus one change, and a checkout of it that still stands on the start commit. */
function world(t: TestContext, change: Files | undefined): { origin: GitRepo; local: GitRepo; dir: string; codeSha: string; mainSha: string } {
  const origin = gitRepo({ scope: t, kind: "freshness-origin" });
  const codeSha = commit(origin, START);
  const mainSha = change ? commit(origin, change) : codeSha;
  const local = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "freshness-local" });
  local.git("checkout", "-q", "--detach", codeSha);
  return { origin, local, dir: local.dir, codeSha, mainSha };
}
type World = ReturnType<typeof world>;

const GUARDED = { [SELF_SYNC_GUARD_ENV]: "1" };
const core = (answer: ReviewerCodeFreshness) => answer.status === "unreadable" ? answer
  : { status: answer.status, advance: "advance" in answer ? answer.advance : undefined, changedPaths: "changedPaths" in answer ? answer.changedPaths : undefined };
const mainReading = (fx: World) => (): ReviewerCodeFreshness => ({ status: "fresh", codeSha: fx.mainSha, originMainSha: fx.mainSha, advance: "none" });

/** The async entry points; `deps` is empty for the production defaults. */
const ASYNC_ENTRIES: Array<[string, (fx: World, deps?: ReviewerCodeFreshnessOptions) => Promise<ReviewerCodeFreshness>]> = [
  ["checkReviewerCodeFreshnessAsync, guarded", (fx, deps = {}) => checkReviewerCodeFreshnessAsync(fx.dir, GUARDED, deps)],
  ["checkReviewerCodeFreshnessAsync, assessed", (fx, deps = {}) => checkReviewerCodeFreshnessAsync(fx.dir, {}, deps)],
  ["probeReviewerCodeFreshnessAsync", (fx, deps = {}) => probeReviewerCodeFreshnessAsync(fx.codeSha, { ...deps, repoDir: fx.dir })],
  ["reviewerCodeJudge", (fx, deps = {}) => reviewerCodeJudge(mainReading(fx), fx.dir, deps)(fx.codeSha)],
];
const SYNC_ENTRIES: Array<[string, (fx: World) => ReviewerCodeFreshness]> = [
  ["reviewerCodeFreshnessAt", (fx) => reviewerCodeFreshnessAt(fx.codeSha, fx.mainSha, reviewerGit(fx.dir))],
  ["checkReviewerCodeFreshness, guarded", (fx) => checkReviewerCodeFreshness(fx.dir, GUARDED)],
  ["checkReviewerCodeFreshness, assessed", (fx) => checkReviewerCodeFreshness(fx.dir, {})],
];

type Spawn = { api: string; argv: string[] };
const isGit = (spawn: Spawn): boolean => spawn.argv[0] === "git";
const isSync = (spawn: Spawn): boolean => spawn.api.endsWith("Sync");
/** The reads that classify an advance: ancestry, diff, blob and head. */
const isCheckRead = (spawn: Spawn): boolean =>
  isGit(spawn) && (["merge-base", "diff", "show"].some((verb) => spawn.argv.includes(verb)) || (spawn.argv.includes("rev-parse") && spawn.argv.includes("HEAD")));
/** Records every child this process starts through node:child_process until `restore`. Each call still runs. */
function watchSpawns(): { spawns: () => Spawn[]; restore: () => void } {
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = ["execFileSync", "spawnSync", "execSync", "execFile", "spawn"].map((api) => [api, cp[api]!] as const);
  const seen: Spawn[] = [];
  for (const [api, real] of originals) {
    cp[api] = (...args: unknown[]) => {
      seen.push({ api, argv: [String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])] });
      return real(...args);
    };
  }
  syncBuiltinESMExports();
  return {
    spawns: () => [...seen],
    restore: () => {
      for (const [api, real] of originals) cp[api] = real;
      syncBuiltinESMExports();
    },
  };
}
async function watched<T>(run: () => T | Promise<T>): Promise<{ value: T; spawns: Spawn[] }> {
  const watch = watchSpawns();
  try {
    return { value: await run(), spawns: watch.spawns() };
  } finally {
    watch.restore();
  }
}

async function until(done: () => boolean, stop: () => boolean = () => false): Promise<void> {
  while (!done() && !stop()) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("W1-T13335 criterion 1: the async entry points give the answers of the synchronous ones for five advances of main", TIMEOUT, async (t) => {
  for (const advance of ADVANCES) {
    const fx = world(t, advance.change);
    const direct = core(reviewerCodeFreshnessAt(fx.codeSha, fx.mainSha, reviewerGit(fx.dir)));
    assert.deepEqual(direct, advance.expected, advance.label);
    for (const [name, read] of SYNC_ENTRIES) assert.deepEqual(core(read(fx)), direct, `${advance.label}: ${name}`);
    for (const [name, read] of ASYNC_ENTRIES) assert.deepEqual(core(await read(fx)), direct, `${advance.label}: ${name}`);
  }
});

test("W1-T13335 criterion 2: invariant:no-sync-git-in-the-async-freshness-check — the production defaults spawn no synchronous git for the check's reads, and a 20 ms timer fires through a held git child", TIMEOUT, async (t) => {
  // Each entry point reads a checkout of its own, so none answers from what another kept.
  for (const [name, read] of ASYNC_ENTRIES) {
    const fx = world(t, MEETS);
    const { value, spawns } = await watched(() => read(fx));
    assert.equal(value.status, "stale", name);
    assert.deepEqual(spawns.filter((spawn) => isSync(spawn) && isCheckRead(spawn)), [], `${name}: no synchronous ancestry, diff, blob or head read`);
    assert.ok(spawns.some((spawn) => !isSync(spawn) && spawn.argv.includes("show")), `${name}: the blobs were read by an awaited git`);
    if (!name.endsWith("assessed")) assert.ok(spawns.some((spawn) => !isSync(spawn) && spawn.argv.includes("merge-base")), `${name}: the ancestry was read by an awaited git`);
  }
  // The head read of a checkout that is not behind.
  const level = world(t, NONE);
  const head = await watched(() => checkReviewerCodeFreshnessAsync(level.dir, {}));
  assert.deepEqual(core(head.value), ADVANCES[0]!.expected);
  assert.deepEqual(head.spawns.filter((spawn) => isSync(spawn) && isGit(spawn)), [], "no synchronous git at all");
  assert.ok(head.spawns.some((spawn) => !isSync(spawn) && isCheckRead(spawn)), "the head was read by an awaited git");

  // A git on PATH that holds every merge-base until the release file is there (ten seconds at most).
  const fx = world(t, MEETS);
  const shim = ownedFixtureDir(t, "freshness-held-git").dir;
  const [held, released] = [join(shim, "held"), join(shim, "release")];
  const realGit = process.env.PATH!.split(":").map((dir) => join(dir, "git")).find((path) => existsSync(path))!;
  writeFileSync(join(shim, "git"), [
    "#!/bin/sh",
    'case " $* " in *" merge-base "*)',
    `  : > '${held}'`,
    "  n=0",
    `  while [ ! -e '${released}' ] && [ "$n" -lt 200 ]; do sleep 0.05; n=$((n+1)); done;;`,
    "esac",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const path = process.env.PATH;
  let fires = 0;
  const timer = setInterval(() => { fires += 1; }, 20);
  process.env.PATH = `${shim}:${path}`;
  try {
    let settled = false;
    const check = reviewerCodeJudge(mainReading(fx), fx.dir)(fx.codeSha).finally(() => { settled = true; });
    await until(() => existsSync(held), () => settled);
    const atHold = fires;
    // Fifty fires of a 20 ms timer span at least one second of the held child.
    await until(() => fires - atHold >= 50, () => settled);
    assert.equal(settled, false, "the check waits on its held git child");
    assert.ok(fires - atHold >= 50, `the timer fired ${fires - atHold} times while the child was held`);
    writeFileSync(released, "");
    assert.equal((await check).status, "stale");
  } finally {
    process.env.PATH = path;
    clearInterval(timer);
    writeFileSync(released, "");
  }
});

test("W1-T13335 criterion 3: invariant:an-unreadable-read-still-refuses — a failed read gives the synchronous path's unreadable, material or stale answer", TIMEOUT, async (t) => {
  const failure = "fixture: this git read failed";
  /** Real git in the checkout, except the reads `fails` picks. An injected synchronous git runs on the async path too. */
  const failing = (fx: World, fails: (args: string[]) => boolean): GitRunner => (args) => {
    if (fails(args)) throw new Error(failure);
    return reviewerGit(fx.dir)(args);
  };
  const cases: Array<{ label: string; change: Files | undefined; fails: (args: string[]) => boolean; expected: ReviewerCodeFreshness | { status: "stale"; changedPaths: string[] } }> = [
    { label: "a failing merge-base", change: MEETS, fails: (args) => args[0] === "merge-base", expected: { status: "unreadable", reason: `could not inspect reviewer code ancestry: Error: ${failure}` } },
    { label: "a failing diff", change: MEETS, fails: (args) => args.includes("--name-only"), expected: { status: "unreadable", reason: `could not inspect reviewer code advance: Error: ${failure}` } },
    { label: "a failing show of a changed .ts path", change: COMMENT, fails: (args) => args[0] === "show" && args[1]!.endsWith(`:${REVIEW}`), expected: { status: "stale", changedPaths: [REVIEW] } },
    { label: "a failing show of src/run-task.ts", change: AVOIDS, fails: (args) => args[0] === "show" && args[1]!.endsWith(`:${RUN_TASK}`), expected: { status: "stale", changedPaths: [RUN_TASK] } },
    { label: "a failing hunk diff of src/run-task.ts", change: AVOIDS, fails: (args) => args.includes("-U0"), expected: { status: "stale", changedPaths: [RUN_TASK] } },
  ];
  for (const { label, change, fails, expected } of cases) {
    const fx = world(t, change);
    const direct = reviewerCodeFreshnessAt(fx.codeSha, fx.mainSha, failing(fx, fails));
    assert.deepEqual(direct, expected.status === "stale" ? { ...expected, codeSha: fx.codeSha, originMainSha: fx.mainSha } : expected, label);
    for (const [name, read] of ASYNC_ENTRIES) {
      // The assessed check takes the changed paths from its service read, so it runs no diff that could fail.
      if (name.endsWith("assessed") && label === "a failing diff") continue;
      assert.deepEqual(core(await read(fx, { git: failing(fx, fails) })), core(direct), `${label}: ${name}`);
    }
  }

  // The production defaults over a checkout whose git objects are really gone: the awaited git fails by itself.
  const objectPath = (fx: World, rev: string): string => {
    const oid = fx.local.git("rev-parse", rev);
    return join(fx.dir, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  };
  const lost: Array<{ label: string; change: Files; rev: (fx: World) => string; expected: { status: string; changedPaths?: string[]; reason?: RegExp } }> = [
    { label: "the blob of a changed .ts path is gone", change: COMMENT!, rev: (fx) => `${fx.mainSha}:${REVIEW}`, expected: { status: "stale", changedPaths: [REVIEW] } },
    { label: "the blob of src/run-task.ts is gone", change: AVOIDS!, rev: (fx) => `${fx.mainSha}:${RUN_TASK}`, expected: { status: "stale", changedPaths: [RUN_TASK] } },
    { label: "the tree of main is gone", change: MEETS!, rev: (fx) => `${fx.mainSha}^{tree}`, expected: { status: "unreadable", reason: /^could not inspect reviewer code advance: / } },
    { label: "the commit of main is gone", change: MEETS!, rev: (fx) => fx.mainSha, expected: { status: "unreadable", reason: /^could not inspect reviewer code ancestry: / } },
  ];
  for (const { label, change, rev, expected } of lost) {
    for (const [name, read] of ASYNC_ENTRIES.filter(([entry]) => entry === "probeReviewerCodeFreshnessAsync" || entry === "reviewerCodeJudge")) {
      const fx = world(t, change);
      const object = objectPath(fx, rev(fx));
      assert.ok(existsSync(object), `${label}: the checkout holds the object as a loose file`);
      rmSync(object);
      const direct = reviewerCodeFreshnessAt(fx.codeSha, fx.mainSha, reviewerGit(fx.dir));
      const answer = await read(fx);
      assert.equal(answer.status, expected.status, `${label}: ${name}`);
      assert.equal(direct.status, expected.status, `${label}: the synchronous path`);
      if (expected.reason) {
        assert.match((answer as { reason: string }).reason, expected.reason, `${label}: ${name}`);
        assert.match((direct as { reason: string }).reason, expected.reason, `${label}: the synchronous path`);
      } else {
        assert.deepEqual(core(answer), core(direct), `${label}: ${name}`);
        assert.deepEqual((answer as { changedPaths?: string[] }).changedPaths, expected.changedPaths, `${label}: ${name}`);
      }
    }
  }
});

test("W1-T13335 criterion 4: invariant:only-a-decided-answer-is-kept — a decided pair of shas is not read again, an unreadable one is, and a new main sha is", TIMEOUT, async (t) => {
  const origin = gitRepo({ scope: t, kind: "freshness-origin" });
  const codeSha = commit(origin, START);
  const local = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "freshness-local" });
  local.git("checkout", "-q", "--detach", codeSha);
  const judge = (mainSha: string) => watched(() => reviewerCodeJudge(mainReading({ mainSha } as World), local.dir)(codeSha));
  const gitSpawns = (spawns: Spawn[]): number => spawns.filter(isGit).length;

  // Main advances by a comment, and the checkout has not fetched that commit: the ancestry is unreadable.
  const commentSha = commit(origin, COMMENT!);
  for (const attempt of ["first", "repeat"]) {
    const unread = await judge(commentSha);
    assert.equal(unread.value.status, "unreadable", attempt);
    assert.match((unread.value as { reason: string }).reason, /^could not inspect reviewer code ancestry: /);
    assert.ok(gitSpawns(unread.spawns) > 0, `${attempt}: an unreadable answer is read again, never kept`);
  }
  // Once the commit is there, the same pair is read and gets the real answer.
  local.git("fetch", "-q", "origin");
  const fresh = await judge(commentSha);
  assert.deepEqual(fresh.value, { status: "fresh", codeSha, originMainSha: commentSha, advance: "immaterial" });
  assert.ok(gitSpawns(fresh.spawns) > 0);
  const again = await judge(commentSha);
  assert.deepEqual(again.value, fresh.value);
  assert.equal(gitSpawns(again.spawns), 0, "a second check of the same pair spawns no git");
  // The other entry points answer the same pair from the kept answer: no ancestry, diff or blob read.
  const fx = { dir: local.dir, codeSha, mainSha: commentSha } as World;
  for (const [name, read] of ASYNC_ENTRIES.filter(([entry]) => !entry.endsWith("assessed"))) {
    const kept = await watched(() => read(fx));
    assert.deepEqual(core(kept.value), core(fresh.value), name);
    assert.deepEqual(kept.spawns.filter((spawn) => ["merge-base", "diff", "show"].some((verb) => spawn.argv.includes(verb))), [], name);
  }

  // A new main sha is read again, and its stale answer is kept in turn.
  const otherSha = commit(origin, OTHER!);
  local.git("fetch", "-q", "origin");
  const stale = await judge(otherSha);
  assert.deepEqual(stale.value, { status: "stale", codeSha, originMainSha: otherSha, changedPaths: [PLAN, REVIEW] });
  assert.ok(gitSpawns(stale.spawns) > 0);
  // A caller that changes the answer it got does not change the kept one.
  (stale.value as { changedPaths: string[] }).changedPaths.push("changed by a caller");
  const staleAgain = await judge(otherSha);
  assert.deepEqual(staleAgain.value, { status: "stale", codeSha, originMainSha: otherSha, changedPaths: [PLAN, REVIEW] });
  assert.equal(gitSpawns(staleAgain.spawns), 0);
  // The answers for the earlier main sha were dropped: that pair is read again.
  const back = await judge(commentSha);
  assert.deepEqual(back.value, fresh.value);
  assert.ok(gitSpawns(back.spawns) > 0);
});

test("W1-T13335 criterion 5: the synchronous entry points keep their signatures and their answers for the five advances", TIMEOUT, (t) => {
  // The signatures, checked by the compiler.
  const at: (codeSha: unknown, originMainSha: string, git: GitRunner) => ReviewerCodeFreshness = reviewerCodeFreshnessAt;
  const check: (repoDir: string, env: Record<string, string | undefined>, deps?: ReviewerCodeFreshnessOptions) => ReviewerCodeFreshness = checkReviewerCodeFreshness;
  const touches: (git: GitRunner, codeSha: string, originMainSha: string) => { touchesReviewPath: boolean; reason: string } = runTaskAdvanceTouchesReviewPath;
  assert.deepEqual([at.length, check.length, touches.length], [3, 2, 3]);
  for (const advance of ADVANCES) {
    const fx = world(t, advance.change);
    // An injected synchronous git that records what it ran.
    const ran: string[] = [];
    const git: GitRunner = (args) => { ran.push(args[0]!); return reviewerGit(fx.dir)(args); };
    assert.deepEqual(core(at(fx.codeSha, fx.mainSha, git)), advance.expected, advance.label);
    assert.equal(ran.length > 0, advance.change !== undefined, `${advance.label}: the injected git ran the reads`);
    assert.deepEqual(core(check(fx.dir, GUARDED, { git })), advance.expected, `${advance.label}: guarded`);
    assert.deepEqual(core(check(fx.dir, {})), advance.expected, `${advance.label}: assessed`);
    if (advance.change?.[RUN_TASK] !== undefined) {
      const verdict = touches(git, fx.codeSha, fx.mainSha);
      assert.equal(verdict.touchesReviewPath, advance.expected.status === "stale", verdict.reason);
      assert.match(verdict.reason, advance.expected.status === "stale" ? /meets the review path$/ : /^1 src\/run-task\.ts hunk\(s\) avoid the review path$/);
    }
  }
});
