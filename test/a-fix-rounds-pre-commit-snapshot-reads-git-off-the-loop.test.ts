import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
import * as harness from "../src/run-task.js";
import { hostWorktreeGitAsync } from "../src/lib/worktree-git.js";
// @ts-ignore executable census module has no declaration file.
import { readCensusSnapshot } from "../scripts/census-precheck.mjs";

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: "async-daemon-inputs" });
  t.after(() => repo.cleanup());
  for (const area of ["src", "scripts", "plan", "state"]) mkdirSync(join(repo.dir, area), { recursive: true });
  writeFileSync(join(repo.dir, ".gitignore"), "state/\n");
  writeFileSync(join(repo.dir, "src/input.ts"), "export const input = 1;\n");
  writeFileSync(join(repo.dir, "scripts/unicode.json"), '{"text":"café 🐾"}\n');
  writeFileSync(join(repo.dir, "scripts/example-baseline.json"), "{}\n");
  writeFileSync(join(repo.dir, "plan/policy.yaml"), "rules: []\n");
  repo.git("add", ".gitignore", "src", "scripts", "plan");
  repo.git("commit", "-m", "fixture: daemon input readers");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { repo, stateDir: join(repo.dir, "state") };
}

async function withoutSyncChildren<T>(run: () => Promise<T>): Promise<{ value: T; beats: number }> {
  const names = ["execFileSync", "execSync", "spawnSync"] as const;
  const original = Object.fromEntries(names.map((name) => [name, childProcess[name]]));
  for (const name of names) childProcess[name] = (() => { throw new Error("synchronous child was reached"); }) as never;
  syncBuiltinESMExports();
  let beats = 0;
  const timer = setInterval(() => beats++, 1);
  try { return { value: await run(), beats }; }
  finally {
    clearInterval(timer);
    for (const name of names) childProcess[name] = original[name] as never;
    syncBuiltinESMExports();
  }
}

function api() { assert.equal(typeof harness.writeFixCensusSnapshotAsync, "function"); }

test("W1-T9550: the census snapshot is written with sync spawns trapped and matches the sync bytes", async (t) => {
  api();
  const { repo } = fixture(t);
  const sync = harness.writeFixCensusSnapshot(repo.dir, () => {});
  assert.ok(sync);
  const receipts: unknown[] = [];
  const result = await withoutSyncChildren(() => harness.writeFixCensusSnapshotAsync(repo.dir, (step, extra) => { receipts.push({ step, extra }); }));
  assert.ok(result.value, JSON.stringify(receipts));
  assert.ok(result.beats > 0, "heartbeats advance while the real Git children run");
  assert.equal(statSync(result.value).mode & 0o777, 0o444);
  assert.deepEqual(readCensusSnapshot(result.value), readCensusSnapshot(sync));
  assert.equal(readCensusSnapshot(result.value).baseBlobs["scripts/unicode.json"], '{"text":"café 🐾"}\n');
});

test("W1-T9550: a failed census snapshot read is unavailable", async (t) => {
  api();
  const { repo } = fixture(t);
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, extra }); };
  assert.equal(await harness.writeFixCensusSnapshotAsync(join(repo.dir, "missing"), log), undefined);
  for (const output of ["invalid header", "0".repeat(40) + " blob 1\nx"]) {
    const fake = async (_root: string, args: string[]) => {
      if (args[0] === "rev-parse") return "head";
      if (args[0] === "merge-base") return "base";
      if (args[0] === "cat-file") return output;
      return "src/input.ts\n";
    };
    assert.equal(await harness.writeFixCensusSnapshotAsync(repo.dir, log, fake), undefined);
  }
  assert.equal(rows.filter((r) => r.extra.outcome === "unavailable").length, 3);
  assert.ok(rows.some((r) => String(r.extra.reason).includes("unreadable")));
  assert.ok(rows.some((r) => String(r.extra.reason).includes("truncated")));
});

test("daemon input reads: a symlinked census state is refused before any snapshot write", async (t) => {
  api();
  const { repo, stateDir } = fixture(t);
  const target = mkdtempSync(join(tmpdir(), "rmd-census-state-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  rmSync(stateDir, { recursive: true });
  symlinkSync(target, stateDir, "dir");
  const reasons: string[] = [];
  assert.equal(await harness.writeFixCensusSnapshotAsync(repo.dir, (_step, extra) => { reasons.push(String(extra?.reason)); }), undefined);
  assert.ok(reasons.some((r) => r.includes("symlink")), JSON.stringify(reasons));
  assert.deepEqual(readdirSync(target), []);
});

test("daemon input reads: async Git stdin retains output bounds and rejects a closed input pipe", async (t) => {
  const { repo } = fixture(t);
  const batch = await hostWorktreeGitAsync(repo.dir, ["cat-file", "--batch"], { input: "HEAD:scripts/unicode.json\n", encoding: "latin1" });
  assert.ok(batch.includes(Buffer.from('{"text":"café 🐾"}\n', "utf8").toString("latin1")));
  await assert.rejects(hostWorktreeGitAsync(repo.dir, ["cat-file", "--batch"], { input: "HEAD:scripts/unicode.json\n", maxBuffer: 1 }), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  await assert.rejects(hostWorktreeGitAsync(repo.dir, ["--version"], { input: "x".repeat(16 * 1024 * 1024) }), { code: "EPIPE" });
  await assert.rejects(hostWorktreeGitAsync(repo.dir, ["cat-file", "--batch"], { timeout: 25 }), (error: unknown) => {
    assert.equal((error as { killed: boolean }).killed, true);
    return true;
  });
});

test("W1-T9550: a slow git during the census snapshot does not delay a concurrent timer", async (t) => {
  api();
  const { repo } = fixture(t);
  const bin = mkdtempSync(join(tmpdir(), "rmd-snapshot-slow-git-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = childProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const quotedGit = "'" + realGit.replace(/'/g, "'\"'\"'") + "'";
  const shim = join(bin, "git");
  writeFileSync(shim, "#!/bin/sh\n/bin/sleep 0.04\nexec " + quotedGit + " \"$@\"\n");
  chmodSync(shim, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = bin + ":" + savedPath;
  let beats = 0;
  const timer = setInterval(() => beats++, 1);
  try {
    assert.ok(await harness.writeFixCensusSnapshotAsync(repo.dir, () => {}));
    assert.ok(beats > 0, "the timer advances while the real slow Git child is running");
  } finally {
    clearInterval(timer);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});
