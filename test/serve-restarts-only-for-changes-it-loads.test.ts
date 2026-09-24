import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assessGatewayCheckout, gateStaleCodeExit, type StaleCodeExitDeps } from "../src/lib/serve.js";
import { changedPathsSince, serveRestartRelevant, type ChangedPathsRead } from "../src/lib/serve-restart-relevance.js";
import { gitRepo } from "./helpers/git-repo.js";

// W1-T4463: serve restarts only when the move from its boot sha touches a path it loads.

const BOOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function staleGate(read: ChangedPathsRead | Promise<ChangedPathsRead>, extra: Partial<StaleCodeExitDeps> = {}) {
  const exits: number[] = [];
  const logs: string[] = [];
  const reads: string[] = [];
  const gate = gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => NEW,
    exit: (code) => exits.push(code),
    log: (step) => logs.push(step),
    scheduleRecheck: () => () => {},
    resolveCommitsBehind: () => 1,
    changedPathsSince: (boot, target) => {
      reads.push(`${boot}..${target}`);
      return read;
    },
    ...extra,
  });
  return { gate, exits, logs, reads };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a docs-only merge does not make serve restart", async () => {
  const rec = staleGate(Promise.resolve({ changedPaths: ["docs/serve.md", "test/serve.test.ts", "learnings/serve.yaml"] }));
  await rec.gate.recheck();
  await settle();
  await rec.gate.recheck();
  assert.deepEqual(rec.exits, [], "nothing serve loads moved, so the restart buys a cold read and nothing else");
  assert.deepEqual(rec.reads, [`${BOOT}..${NEW}`], "the diff is read once per sha, not once a minute");
  assert.ok(rec.logs.includes("serve.stale_code_not_loaded"), "the skipped restart is named in the ledger");
});

test("a src merge still makes serve restart", async () => {
  const rec = staleGate(Promise.resolve({ changedPaths: ["docs/serve.md", "src/lib/serve.ts"] }));
  await rec.gate.recheck();
  await settle();
  assert.deepEqual(rec.exits, [0]);
});

test("an unreadable restart diff still restarts serve", async () => {
  const rec = staleGate(Promise.resolve({ diffUnreadable: "fatal: bad object aaaaaaa" }));
  await rec.gate.recheck();
  await settle();
  assert.deepEqual(rec.exits, [0], "a read failure never costs a restart");
  assert.ok(rec.logs.includes("serve.restart_diff_unreadable"));
  const rejected = staleGate(Promise.reject(new Error("git exploded")));
  await rejected.gate.recheck();
  await settle();
  assert.deepEqual(rejected.exits, [0], "a rejecting reader is unreadable too");
});

test("a synchronous changed-paths reader decides at the same edge", () => {
  const skip = staleGate({ changedPaths: ["doctrine/a.md"] });
  void skip.gate.recheck();
  assert.deepEqual(skip.exits, []);
  const restart = staleGate({ changedPaths: ["hooks/pre-commit"] });
  void restart.gate.recheck();
  assert.deepEqual(restart.exits, [0]);
});

test("serve-only trees and the daemon's list are both relevant while docs are not", () => {
  for (const path of ["src/x.ts", "bin/rmd", "package.json", "package-lock.json", "tsconfig.json", "hooks/a", "settings/b.json", "deploy/entrypoint.sh", ".remudero/managed-repos.json", "plan/tasks.d/W1-T1.yaml"]) {
    assert.equal(serveRestartRelevant(["docs/a.md", path]), true, path);
  }
  assert.equal(serveRestartRelevant(["docs/a.md", "test/b.test.ts", "learnings/c.yaml", "doctrine/d.md"]), false);
  assert.equal(serveRestartRelevant(undefined), true, "unreadable is relevant");
  assert.equal(serveRestartRelevant([]), true, "empty is relevant");
});

test("changedPathsSince reads a real diff and reports an unreadable one", async () => {
  const repo = gitRepo({ kind: "serve-restart" });
  const boot = repo.git("rev-parse", "HEAD");
  mkdirSync(join(repo.dir, "docs"));
  writeFileSync(join(repo.dir, "docs", "a.md"), "a\n");
  repo.git("add", "docs/a.md");
  repo.git("commit", "--quiet", "-m", "docs");
  const head = repo.git("rev-parse", "HEAD");
  assert.deepEqual(await changedPathsSince(boot, head, repo.dir), { changedPaths: ["docs/a.md"] });
  const bad = await changedPathsSince(BOOT, head, repo.dir);
  assert.equal(bad.changedPaths, undefined);
  assert.match(bad.diffUnreadable ?? "", /\S/);
});

test("the default reader shells to git from serve's own checkout", async () => {
  const exits: number[] = [];
  const logs: string[] = [];
  const gate = gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => NEW,
    exit: (code) => exits.push(code),
    log: (step) => logs.push(step),
    scheduleRecheck: () => () => {},
    resolveCommitsBehind: () => 1,
  });
  await gate.recheck();
  for (let i = 0; i < 200 && exits.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(exits, [0], "fabricated shas are unreadable, which restarts");
  assert.ok(logs.includes("serve.restart_diff_unreadable"));
});

test("a docs-only advance of the gateway checkout is not a restart", async () => {
  const assess = (diff: string) =>
    assessGatewayCheckout({
      repoDir: "/nonexistent",
      env: {},
      fetch: async () => {},
      git: (args) => {
        if (args[0] === "rev-parse") return args[1] === "HEAD" ? `${BOOT}\n` : `${NEW}\n`;
        if (args[0] === "status") return "";
        if (args[0] === "diff") return diff;
        if (args[0] === "rev-list") return "1\n";
        return "";
      },
    });
  assert.equal((await assess("docs/a.md\ntest/b.test.ts\n")).restartDue, false);
  assert.equal((await assess("docs/a.md\nsrc/lib/serve.ts\n")).restartDue, true);
});
