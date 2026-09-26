import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { WorktreeBaseStaleError, readWorktreeBase, worktreeAdd, worktreeAddAsync } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

function seededRepo() {
  const repo = gitRepo({ kind: "worktree-add-async" });
  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin", "--quiet");
  return repo;
}

test("a timer fires while an async worktree add waits on git", async () => {
  const repo = seededRepo();
  // A real checkout filter makes Git's worktree add take time. The timer must run before
  // that subprocess completes; a sync execFileSync call would prevent this observation.
  writeFileSync(join(repo.dir, ".gitattributes"), "slow.txt filter=delay\n");
  writeFileSync(join(repo.dir, "slow.txt"), "slow checkout\n");
  repo.git("config", "filter.delay.smudge", "sleep 0.25; cat");
  repo.git("add", ".gitattributes", "slow.txt");
  repo.git("commit", "--no-verify", "--quiet", "-m", "chore: add slow checkout fixture");
  const worktree = `${repo.dir}-timer`;
  let finished = false;
  let timerSawPending = false;
  const timer = new Promise<void>((resolve) => setTimeout(() => {
    timerSawPending = !finished;
    resolve();
  }, 20));
  await worktreeAddAsync(repo.dir, worktree, "run-timer", "origin/main");
  finished = true;
  await timer;
  assert.equal(timerSawPending, true);
  assert.equal(repo.git("-C", worktree, "rev-parse", "HEAD"), repo.git("rev-parse", "HEAD"));
});

test("the async worktree add ledgers the same row as the sync add", async () => {
  const repo = seededRepo();
  const syncRows: Array<[string, Record<string, unknown> | undefined]> = [];
  const asyncRows: Array<[string, Record<string, unknown> | undefined]> = [];
  const syncPath = `${repo.dir}-sync`;
  const asyncPath = `${repo.dir}-async`;
  worktreeAdd(repo.dir, syncPath, "run-sync", "origin/main", { log: (step, extra) => syncRows.push([step, extra]) });
  await worktreeAddAsync(repo.dir, asyncPath, "run-async", "origin/main", {
    log: (step, extra) => asyncRows.push([step, extra]),
  });
  const syncAdd = syncRows.find(([step]) => step === "worktree.add")?.[1];
  const asyncAdd = asyncRows.find(([step]) => step === "worktree.add")?.[1];
  assert.ok(syncAdd);
  assert.ok(asyncAdd);
  assert.deepEqual({ ...asyncAdd, branch: "run-sync", worktreePath: syncPath }, syncAdd);
  assert.deepEqual(asyncRows.map(([step]) => step), syncRows.map(([step]) => step));
});

test("the async worktree add still refuses a stale base", async () => {
  const repo = seededRepo();
  const worktree = `${repo.dir}-stale`;
  const rows: string[] = [];
  await assert.rejects(
    worktreeAddAsync(repo.dir, worktree, "run-stale", "origin/main", {
      readRemoteHead: () => "0".repeat(40),
      log: (step) => rows.push(step),
    }),
    (error: unknown) => error instanceof WorktreeBaseStaleError,
  );
  assert.match(readWorktreeBase(worktree) ?? "", /^[0-9a-f]{40}$/);
  assert.ok(!rows.includes("worktree.add"));
});

test("an unreadable remote head keeps the async add's warning and ledger distinction", async () => {
  const repo = seededRepo();
  const warnings: string[] = [];
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  await worktreeAddAsync(repo.dir, `${repo.dir}-unreadable`, "run-unreadable", "origin/main", {
    readRemoteHead: () => { throw new Error("remote unavailable"); },
    warn: (message) => warnings.push(message),
    log: (step, extra) => rows.push([step, extra]),
  });
  assert.match(warnings[0] ?? "", /remote unavailable/);
  assert.equal(rows.find(([step]) => step === "worktree.base_uncheckable")?.[1]?.error, "remote unavailable");
  assert.equal(rows.find(([step]) => step === "worktree.add")?.[1]?.remote_head, "unreadable");
});

test("an async Git failure relays both output streams and still rejects", () => {
  const repo = seededRepo();
  const shimDir = join(repo.dir, "git-shim");
  mkdirSync(shimDir);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(shimDir, "git"), [
    "#!/bin/sh",
    "if [ \"$3\" = worktree ] && [ \"$4\" = add ]; then",
    "  printf 'stdout before git failure\\n'",
    "  printf 'stderr before git failure\\n' >&2",
    "  exit 23",
    "fi",
    'exec "$REAL_GIT" "$@"',
    "",
  ].join("\n"));
  chmodSync(join(shimDir, "git"), 0o755);

  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", [
    'import { worktreeAddAsync } from "./src/lib/worker.js";',
    `try { await worktreeAddAsync(${JSON.stringify(repo.dir)}, ${JSON.stringify(`${repo.dir}-git-failure`)}, "run-git-failure"); process.exitCode = 2; }`,
    'catch (error) { if (error.code !== 23) process.exitCode = 3; }',
  ].join("\n")], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}`, REAL_GIT: realGit },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /stdout before git failure/);
  assert.match(child.stderr, /stderr before git failure/);
  assert.doesNotMatch(child.stdout, /before git failure/);
});

test("an absent tracking ref is reported as unreadable without blocking the async add", async () => {
  const repo = seededRepo();
  repo.git("branch", "other");
  repo.git("remote", "set-branches", "origin", "other");
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const worktree = `${repo.dir}-missing-tracking-ref`;
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const warnings: string[] = [];

  // Fetch can succeed while leaving origin/main absent. The local main and independently
  // read remote main still agree, so only the observability reads may degrade.
  await worktreeAddAsync(repo.dir, worktree, "run-missing-tracking-ref", "main", {
    log: (step, extra) => rows.push([step, extra]),
    warn: (message) => warnings.push(message),
  });
  const added = rows.find(([step]) => step === "worktree.add")?.[1];
  assert.ok(added);
  assert.equal(added.local_ref_head, "unreadable");
  assert.equal(added.remote_head, repo.git("rev-parse", "HEAD"));
  assert.equal(readWorktreeBase(worktree), added.remote_head);
  assert.deepEqual(warnings, []);
});
