// test/the-sre-lanes-suspect-commit-read-runs-off-the-loop.test.ts — W1-T9637.
//
// MEASURED 2026-10-15 (core ledger, daemon.loop_lag sync_spawn_by_caller): every SRE lane filing ran
// `mergedPrsSince` as one synchronous `git log` plus one synchronous `git show` per merged commit —
// 256-259 spawns, 9-16 s of a held daemon loop per lag window. These tests hold the read to ONE awaited
// child, so a timer due while git runs still fires on time.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { listFeedback } from "../src/lib/feedback.js";
import { mergedPrsSince, runSreLanePass, type MergedPrFiles } from "../src/lib/sre-lane.js";
import { gitRepo } from "./helpers/git-repo.js";

const CHILD_MS = 800;

/** A `git` on PATH that sleeps, then prints one merged commit in the `git log --name-only` shape. */
function slowGitOnPath(): string {
  const bin = mkdtempSync(join(tmpdir(), "rmd-w9637-bin-"));
  const script = join(bin, "git");
  writeFileSync(script, `#!/bin/sh\nsleep ${CHILD_MS / 1000}\nprintf '\\000abc123\\001feat: slow (#4242)\\n\\nsrc/lib/sre-lane.ts\\n'\n`);
  chmodSync(script, 0o755);
  return bin;
}

test("W1-T9637: a slow git child in the suspect-commit read does not delay a concurrent timer", async () => {
  const bin = slowGitOnPath();
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
  try {
    const started = Date.now();
    let timerFiredAt: number | undefined;
    const timer = setTimeout(() => { timerFiredAt = Date.now() - started; }, 20);
    const merged = await mergedPrsSince("/nowhere", "o", "r", "dep1");
    const settledAt = Date.now() - started;
    clearTimeout(timer);
    assert.ok(settledAt >= CHILD_MS - 50, `the read settled at ${settledAt} ms, before the child's own ${CHILD_MS} ms sleep`);
    assert.ok(timerFiredAt !== undefined, `a 20 ms timer had not fired when the ${settledAt} ms read settled: the read held the loop`);
    assert.ok(timerFiredAt < settledAt, `the 20 ms timer fired at ${timerFiredAt} ms, after the read settled at ${settledAt} ms`);
    // Positive control: the PATH shim answered, so this measured the real default spawn.
    assert.deepEqual(merged, [{ url: "https://github.com/o/r/pull/4242", files: ["src/lib/sre-lane.ts"] }]);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("W1-T9637: the suspect-commit read names each merged PR and its files from one git log child", async () => {
  const repo = gitRepo({ kind: "w9637" });
  const base = repo.git("rev-parse", "HEAD");
  const commit = (rel: string, subject: string) => {
    mkdirSync(join(repo.dir, rel, ".."), { recursive: true });
    writeFileSync(join(repo.dir, rel), `${subject}\n`);
    repo.git("add", rel);
    repo.git("commit", "--quiet", "-m", subject);
  };
  commit("src/a.ts", "feat: one (#101)");
  commit("docs/torn.md", "a torn subject with no number");
  commit("src/lib/b.ts", "fix: two (#102)");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");

  const calls: string[][] = [];
  const merged = await mergedPrsSince(repo.dir, "o", "r", base, async (args) => {
    calls.push(args);
    return repo.git(...args.slice(2));
  });
  assert.deepEqual(merged, [
    { url: "https://github.com/o/r/pull/102", files: ["src/lib/b.ts"] },
    { url: "https://github.com/o/r/pull/101", files: ["src/a.ts"] },
  ] satisfies MergedPrFiles[]);
  assert.equal(calls.length, 1, "one git log child, never one git show per merged commit");
  assert.equal(calls[0][3], `${base}..origin/main`);

  // The real default, against the same repository, reads the same answer.
  assert.deepEqual(await mergedPrsSince(repo.dir, "o", "r", base), merged);
  // No deploy sha reads the last 24 hours, and git that cannot answer names no suspects.
  const window: string[][] = [];
  await mergedPrsSince(repo.dir, "o", "r", undefined, async (args) => { window.push(args); return ""; });
  assert.ok(window[0].includes("--since=24 hours ago"), "no deploy sha reads the last 24 hours");
  assert.deepEqual(await mergedPrsSince(mkdtempSync(join(tmpdir(), "rmd-w9637-norepo-")), "o", "r", "dep1"), []);
  repo.cleanup();
});

test("W1-T9637: an SRE pass names the suspect PRs an awaited reader returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w9637-lane-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const fingerprint = "c".repeat(64);
  const pass = await runSreLanePass({
    stateDir: join(root, "state"),
    root,
    readEvents: () => [{ fingerprint, ts: Date.parse("2026-10-15T06:00:00.000Z"), kind: "exception", name: "TypeError", message: "boom", instance: "core" }],
    hasOpenTask: () => false,
    framesFor: () => [{ file: "src/lib/sre-lane.ts", fn: "runSreLanePass" }],
    mergedPrsSince: async () => [{ url: "https://github.com/o/r/pull/101", files: ["src/lib/sre-lane.ts"] }],
    mergedLastDay: () => 10,
    log: () => {},
  });
  assert.equal(pass.filed, fingerprint);
  assert.ok(listFeedback(root)[0].raw.includes("https://github.com/o/r/pull/101"), "the filed incident names the awaited suspect PR");
});
