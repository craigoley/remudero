import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import * as harness from "#src/run-task.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
// @ts-ignore executable census module has no declaration file.
import { readCensusSnapshot, main as censusMain } from "#scripts/census-precheck.mjs";

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


test("the snapshot controller reports its nested deadline budget without running a census", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { lines.push(String(line)); });
  t.mock.method(console, "error", () => {});
  const code = censusMain(["--snapshot-budget"], {
    measure: () => assert.fail("budget inspection must not measure a tree"),
    admitted: () => assert.fail("budget inspection must not load a worker's admission table"),
    runSuites: () => assert.fail("budget inspection must not run suites"),
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  const budget = JSON.parse(lines[0]!);
  assert.equal(budget.version, 1);
  assert.equal(budget.childTimeBoundMs, 60_000);
  assert.ok(budget.timeoutMs > budget.childTimeBoundMs);
  assert.equal(budget.timeoutMs, Object.values(budget.stages).reduce((sum: number, value) => sum + Number(value), 0) * budget.childTimeBoundMs);
});

const nestedBudget = { version: 1, childTimeBoundMs: 60_000,
  stages: { setup: 1, admission: 1, reach: 2, joinedGitFree: 2, structuralGitFree: 4 }, timeoutMs: 600_000 };

test("the native snapshot controller can collect bounded child outcomes without inheriting their single-child deadline", async () => {
  const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
  const checked = await harness.checkFixCensusSnapshotAsync("/fixture/worker", "/fixture/snapshot", () => {}, async (_file, args, opts) => {
    calls.push({ args, timeout: opts.timeout });
    if (args.includes("--snapshot-budget")) return { status: 0, signal: null, stdout: JSON.stringify(nestedBudget), stderr: "" };
    if (args[0]!.endsWith("census-precheck.mjs")) {
      if ((opts.timeout ?? 0) <= 61_000) return { status: null, signal: "SIGTERM" as NodeJS.Signals, stdout: "partial child progress", stderr: "" };
      return { status: 2, signal: null, stdout: "census-precheck: retained source-reader capability UNKNOWN", stderr: "" };
    }
    return { status: 0, signal: null, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
  });
  assert.equal(checked?.refusal, undefined);
  assert.match(checked?.unmeasured ?? "", /capability UNKNOWN/);
  assert.equal(calls.length, 3);
  assert.ok(calls[0]!.args.includes("--snapshot-budget"));
  assert.equal(calls[0]!.timeout, 60_000);
  assert.equal(calls[1]!.timeout, nestedBudget.timeoutMs);
  assert.equal(calls[2]!.timeout, 60_000, "the independent reach child retains its original bound");
});

test("an unreadable snapshot deadline budget refuses before running the controller", async () => {
  for (const stdout of ["not-json", "{}", JSON.stringify({ ...nestedBudget, version: 2 }),
    JSON.stringify({ ...nestedBudget, timeoutMs: 0 }), JSON.stringify({ ...nestedBudget, timeoutMs: 600_001 }),
    JSON.stringify({ ...nestedBudget, stages: { ...nestedBudget.stages, structuralGitFree: -1 } }),
    JSON.stringify({ ...nestedBudget, stages: { ...nestedBudget.stages, extra: 1 } })]) {
    let calls = 0;
    const checked = await harness.checkFixCensusSnapshotAsync("/fixture/worker", "/fixture/snapshot", () => {}, async () => {
      calls++; return { status: 0, signal: null, stdout, stderr: "" };
    });
    assert.match(checked?.refusal?.text ?? "", /controller budget.*UNKNOWN/i);
    assert.equal(calls, 1, "no guessed deadline or controller execution follows malformed policy");
  }
});


test("a failed or interrupted budget inspector cannot certify a controller deadline", async () => {
  for (const native of [{ status: 1, signal: null }, { status: null, signal: "SIGTERM" as NodeJS.Signals }]) {
    let calls = 0;
    const checked = await harness.checkFixCensusSnapshotAsync("/fixture/worker", "/fixture/snapshot", () => {}, async () => {
      calls++; return { ...native, stdout: JSON.stringify(nestedBudget), stderr: "" };
    });
    assert.match(checked?.refusal?.text ?? "", /controller budget.*UNKNOWN/i);
    assert.equal(calls, 1, "a complete-looking payload cannot erase the inspector's native failure");
  }
});
