import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPlan, loadPlanAtRef, readBlobsAtRef, type Plan } from "../src/lib/plan.js";
import {
  GitFetchError,
  materializeOriginShards,
  readOriginShardsAtRef,
  syncPlanFromOrigin,
  type GitRunner,
} from "../src/run-task.js";

/**
 * test/plan-sync-spawn-count.test.ts — THE PLAN IS READ IN A CONSTANT NUMBER OF GIT CALLS.
 *
 * DEFECT (measured 2026-09-05 at f7ceb86, 1,079 shards): `materializeOriginShards` and
 * `loadPlanAtRef` each spawned ONE `git show <ref>:<shard>` PER SHARD — 1,079 spawns, 4,258 ms
 * (3.95 ms each), plus 1,079 temp-file writes on the sync path that existed only to give
 * `loadPlan` a directory to glob. One `git cat-file --batch` over the same paths returns
 * identical bytes in 208 ms. That loop ran on every dispatching daemon tick and every
 * `POST /v1/inbox/approve`, so its cost grew with every task ever filed and, at 10x shards,
 * exceeded the daemon's own 60 s poll.
 *
 * WHAT THESE TESTS PIN. (1) The git-call count is CONSTANT in the shard count, asserted through
 * each function's own injected `runGit` seam at 50 shards — a per-shard loop scores 51/52 here
 * and fails by two orders of magnitude, not by a margin. (2) The Plan is UNCHANGED: a real
 * 50-shard git fixture is loaded three ways — `loadPlan` off the working tree (untouched by this
 * change and therefore the independent oracle), `syncPlanFromOrigin` off origin/main, and
 * `loadPlanAtRef` off a committed ref — and all three must be deep-equal. (3) The batch framing
 * is parsed by BYTES: the fixture carries multi-byte text in an EARLY shard, so a char-sliced
 * parse mis-positions every later blob instead of failing on the one that contains it.
 * (4) A shard that lists but cannot be read still throws loudly, never a silently short plan.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const SHARD_COUNT = 50;

/** A schema-v1 record. `title` carries the em dash the corpus is full of when `wide` is set —
 *  three UTF-8 bytes for one character, which is what makes a char-sliced batch parse wrong. */
function task(id: string, wide = false): string {
  return (
    `- id: ${id}\n` +
    `  title: "${id}${wide ? " — a wide title with an em dash and ✓ a check mark" : " plain"}"\n` +
    `  repo: remudero\n` +
    `  depends_on: []\n` +
    `  type: implement\n` +
    `  verify: auto\n` +
    `  status: queued\n`
  );
}

function shardName(i: number): string {
  return `W9-T${String(i).padStart(3, "0")}-shard.yaml`;
}

/** `git ls-tree --name-only <ref> plan/tasks.d/` output for the fixture's shard set. */
function listing(): string {
  return Array.from({ length: SHARD_COUNT }, (_, i) => `plan/tasks.d/${shardName(i)}`).join("\n") + "\n";
}

/** A faithful `git cat-file --batch` responder: `<oid> blob <byteLength>\n<contents>\n` per
 *  requested object, in request order — the framing the real git emits. */
function batchReply(request: string): string {
  return request
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const relPath = line.slice(line.indexOf(":") + 1);
      const i = Number(/W9-T(\d+)-shard\.yaml$/.exec(relPath)?.[1] ?? "-1");
      const body = task(`W9-T${String(i).padStart(3, "0")}`, i === 0);
      return `${"0".repeat(40)} blob ${Buffer.byteLength(body, "utf8")}\n${body}\n`;
    })
    .join("");
}

/** Records every git invocation so the COUNT, not just the result, is assertable. */
function countingRunner(): { calls: string[][]; runGit: GitRunner } {
  const calls: string[][] = [];
  const runGit: GitRunner = (args, stdin) => {
    calls.push(args);
    if (args[0] === "ls-tree") return listing();
    if (args[0] === "show") return task("W9-MONO");
    if (args[0] === "cat-file") return batchReply(stdin ?? "");
    throw new Error(`unexpected git verb: ${args.join(" ")}`);
  };
  return { calls, runGit };
}

// ── (1) THE CALL COUNT IS CONSTANT IN THE SHARD COUNT ────────────────────────────────────────

test("readOriginShardsAtRef reads 50 shards in exactly two git calls — one ls-tree, one cat-file --batch", () => {
  const { calls, runGit } = countingRunner();
  const shards = readOriginShardsAtRef("/repo", "plan", runGit, "origin/main");

  assert.equal(shards.length, SHARD_COUNT, "the fixture must actually supply 50 shards, or the count below is vacuous");
  assert.equal(
    calls.length,
    2,
    `50 shards must cost 2 git calls, not 1 per shard — got ${calls.length}: ${calls.map((a) => a[0]).join(",")}`,
  );
  assert.deepEqual(calls.map((a) => a[0]), ["ls-tree", "cat-file"]);
  assert.equal(calls.filter((a) => a[0] === "show").length, 0, "no per-shard `git show` may survive");
  assert.deepEqual(calls[1], ["cat-file", "--batch"], "the batch form is the one that takes its object list on stdin");
});

test("materializeOriginShards writes 50 shards to disk from the same two git calls, byte-for-byte", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rmd-spawncount-mat-"));
  const { calls, runGit } = countingRunner();
  const got = materializeOriginShards("/repo", "plan", tmpDir, runGit, "origin/main");

  assert.equal(got.length, SHARD_COUNT);
  assert.equal(calls.length, 2, `writing 50 shards must still cost 2 git calls — got ${calls.length}`);
  // The multi-byte shard is FIRST, so a char-sliced batch parse corrupts the ones after it.
  assert.equal(readFileSync(join(tmpDir, "tasks.d", shardName(0)), "utf8"), task("W9-T000", true));
  assert.equal(readFileSync(join(tmpDir, "tasks.d", shardName(SHARD_COUNT - 1)), "utf8"), task("W9-T049"));
  rmSync(tmpDir, { recursive: true, force: true });
});

test("loadPlanAtRef reads a 50-shard plan in exactly three git calls — show, ls-tree, cat-file --batch", () => {
  const { calls, runGit } = countingRunner();
  const plan = loadPlanAtRef("/repo", "plan/tasks.yaml", "HEAD", runGit);

  assert.equal(plan.tasks.length, SHARD_COUNT + 1, "one monolith task plus 50 shard tasks");
  assert.equal(
    calls.length,
    3,
    `50 shards must cost 3 git calls, not 52 — got ${calls.length}: ${calls.map((a) => a[0]).join(",")}`,
  );
  assert.deepEqual(calls.map((a) => a[0]), ["show", "ls-tree", "cat-file"]);
});

// ── (2)+(3) THE PLAN IS UNCHANGED, AND THE BYTES SURVIVE THE FRAMING ─────────────────────────

/** A real bare origin + clone whose plan is one monolith task and 50 shards, the first of them
 *  carrying multi-byte text. Returns the clone (which has `origin/main` to sync from). */
function seedRepo(): { root: string; repoDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-spawncount-repo-"));
  const origin = join(root, "origin.git");
  const repoDir = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", origin, repoDir], { stdio: "pipe", env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "t@t"], { env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "t"], { env: GIT_ENV });

  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repoDir, "plan", "tasks.yaml"), task("W9-MONO"), "utf8");
  for (let i = 0; i < SHARD_COUNT; i++) {
    writeFileSync(join(repoDir, "plan", "tasks.d", shardName(i)), task(`W9-T${String(i).padStart(3, "0")}`, i === 0), "utf8");
  }
  execFileSync("git", ["-C", repoDir, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "seed"], { env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "push", "-q", "origin", "main"], { stdio: "pipe", env: GIT_ENV });
  return { root, repoDir };
}

test("the batch-read plan is deep-equal to loadPlan over the same tree on disk (real git, 50 shards)", () => {
  const { root, repoDir } = seedRepo();
  try {
    // loadPlan is untouched by this change, reads the WORKING TREE with its own directory glob,
    // and is therefore an independent oracle for what the merged view must be.
    const onDisk: Plan = loadPlan(join(repoDir, "plan", "tasks.yaml"));
    assert.equal(onDisk.tasks.length, SHARD_COUNT + 1, "the fixture must hold 51 tasks, or every comparison below is vacuous");
    assert.ok(
      onDisk.byId.get("W9-T000")!.title.includes("—"),
      "the fixture's multi-byte title must survive to the oracle, or the byte-framing claim is untested",
    );

    assert.deepEqual(
      syncPlanFromOrigin(repoDir, "plan/tasks.yaml", {}).plan,
      onDisk,
      "syncPlanFromOrigin's in-memory merge must equal loadPlan over the same content on disk",
    );
    assert.deepEqual(
      loadPlanAtRef(repoDir, "plan/tasks.yaml", "HEAD"),
      onDisk,
      "loadPlanAtRef's batch read must equal loadPlan over the same content on disk",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (4) FAIL LOUD, NEVER A SILENTLY SHORT PLAN ───────────────────────────────────────────────

test("a shard that LISTS but that cat-file reports `missing` throws GitFetchError naming the ref", () => {
  const runGit: GitRunner = (args) => {
    if (args[0] === "ls-tree") return "plan/tasks.d/W9-T9.yaml\n";
    if (args[0] === "cat-file") return "origin/main:plan/tasks.d/W9-T9.yaml missing\n";
    throw new Error("unexpected");
  };
  assert.throws(
    () => readOriginShardsAtRef("/repo", "plan", runGit, "origin/main"),
    (e: unknown) =>
      e instanceof GitFetchError && /plan\/tasks\.d\/W9-T9\.yaml/.test((e as Error).message),
    "a torn read must never silently drop a task",
  );
});

test("loadPlanAtRef turns an unreadable shard batch into a named PlanError, not a short plan", () => {
  const runGit: GitRunner = (args) => {
    if (args[0] === "show") return task("W9-MONO");
    if (args[0] === "ls-tree") return "plan/tasks.d/W9-T9.yaml\n";
    throw new Error("fatal: cat-file exploded");
  };
  assert.throws(
    () => loadPlanAtRef("/repo", "plan/tasks.yaml", "HEAD", runGit),
    /cannot read plan shard at HEAD/,
  );
});

test("readBlobsAtRef spawns nothing at all for an empty path list", () => {
  let called = 0;
  const texts = readBlobsAtRef(() => { called++; return ""; }, "HEAD", []);
  assert.deepEqual(texts, []);
  assert.equal(called, 0, "no paths means no git call — the cheapest correct answer");
});

test("readBlobsAtRef refuses a truncated batch stream and a nonsense size, naming the path", () => {
  assert.throws(
    () => readBlobsAtRef(() => "", "HEAD", ["plan/tasks.d/a.yaml"]),
    /output ended before HEAD:plan\/tasks\.d\/a\.yaml/,
  );
  assert.throws(
    () => readBlobsAtRef(() => "deadbeef blob notanumber\nbody\n", "HEAD", ["plan/tasks.d/a.yaml"]),
    /unusable size for HEAD:plan\/tasks\.d\/a\.yaml/,
  );
  assert.throws(
    () => readBlobsAtRef(() => "deadbeef blob 9999\nshort\n", "HEAD", ["plan/tasks.d/a.yaml"]),
    /unusable size for HEAD:plan\/tasks\.d\/a\.yaml/,
  );
  assert.throws(
    () => readBlobsAtRef(() => "deadbeef tree 4\nabcd\n", "HEAD", ["plan/tasks.d/a.yaml"]),
    /could not read HEAD:plan\/tasks\.d\/a\.yaml/,
  );
});
