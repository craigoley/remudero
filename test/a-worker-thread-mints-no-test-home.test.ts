import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { LIVE_WRITE_SENTINEL_TOKEN } from "../src/lib/live-write-guard.js";
import { pidIsAlive, pidNamespaceId, setupDirOwnerTag } from "./setup/no-live-remote.js";

const SETUP = new URL("./setup/tmp-hygiene.ts", import.meta.url).href;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOME_PREFIX = "rmd-test-home-";

test("test/a-worker-thread-mints-no-test-home.test.ts: a terminated file worker keeps HOME and leaves no test home", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-test-t5678-worker-"));
  const script = join(root, "worker.mjs");
  writeFileSync(script, [
    "import { parentPort } from 'node:worker_threads';",
    "parentPort.postMessage({ home: process.env.HOME, token: process.env.GH_TOKEN });",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root };
  delete env.GH_TOKEN;
  delete env.RMD_ALLOW_LIVE_WRITES;
  delete env.RMD_SELF_SYNC_DONE;
  // A file worker executes the setup preloads; an eval worker would skip them.
  const worker = new Worker(pathToFileURL(script), { execArgv: ["--import", "tsx", "--import", SETUP], env });
  let workerHome: string | undefined;
  try {
    const seen = await new Promise<{ home: string; token: string }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited (${code}) before reporting`)));
    });
    assert.equal(seen.token, LIVE_WRITE_SENTINEL_TOKEN, "control: the setup preload ran");
    workerHome = seen.home;
  } finally {
    await worker.terminate();
  }
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(HOME_PREFIX)), [],
    "termination leaves no worker-owned test home");
  assert.equal(workerHome, process.env.HOME, "the worker inherits its parent's HOME");
});

test("test/a-worker-thread-mints-no-test-home.test.ts: the main thread names HOME with its namespace", () => {
  const home = process.env.HOME;
  assert.ok(home);
  assert.ok(basename(home).startsWith(`${HOME_PREFIX}${setupDirOwnerTag()}`), home);
});

test("test/a-worker-thread-mints-no-test-home.test.ts: a main-thread load reaps dead homes before minting and keeps live, fresh and foreign homes", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-test-t5678-reap-"));
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 30_000 });
  assert.equal(exited.status, 0);
  assert.equal(pidIsAlive(exited.pid), false, "control: the fixture's owner has exited");
  const namespace = pidNamespaceId();
  const dead = [`${HOME_PREFIX}${exited.pid}-legacy`, `${HOME_PREFIX}${exited.pid}-${namespace}-owned`];
  const kept = [
    `${HOME_PREFIX}${process.pid}-${namespace}-live`,
    `${HOME_PREFIX}${exited.pid}-${namespace}-fresh`,
    `${HOME_PREFIX}${exited.pid}-${namespace === "1" ? "2" : "1"}-foreign`,
  ];
  for (const name of [...dead, ...kept]) mkdirSync(join(root, name));
  for (const name of [...dead, kept[0]]) utimesSync(join(root, name), 1_000_000_000, 1_000_000_000);
  assert.deepEqual(readdirSync(root).sort(), [...dead, ...kept].sort(), "control: all fixture homes exist");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, NODE_TEST_CONTEXT: "child" };
  delete env.RMD_ALLOW_LIVE_WRITES;
  delete env.RMD_SELF_SYNC_DONE;
  // Observe the directory listing at the actual mkdtemp call, before the new HOME exists.
  const script = [
    "import fs from 'node:fs';",
    "import { basename, join } from 'node:path';",
    "const original = fs.mkdtempSync;",
    "let beforeMint;",
    `fs.mkdtempSync = (...args) => { if (basename(args[0]).startsWith('${HOME_PREFIX}')) beforeMint = fs.readdirSync(process.env.TMPDIR).filter(n => n.startsWith('${HOME_PREFIX}')).sort(); return original(...args); };`,
    `await import(${JSON.stringify(SETUP)});`,
    "console.log(JSON.stringify({ home: process.env.HOME, beforeMint, pid: process.pid, config: JSON.parse(fs.readFileSync(join(process.env.HOME, '.config/remudero/config.json'), 'utf8')) }));",
  ].join("\n");
  const next = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(next.status, 0, next.stderr);
  const seen = JSON.parse(next.stdout) as {
    home: string; beforeMint: string[]; pid: number; config: { claudeBin: string; root: string };
  };
  assert.deepEqual(seen.beforeMint, kept.sort(), "dead homes are gone before the new HOME is minted");
  assert.equal(dirname(seen.home), root);
  assert.ok(basename(seen.home).startsWith(`${HOME_PREFIX}${seen.pid}-${namespace}-`), seen.home);
  assert.deepEqual(seen.config, { claudeBin: process.execPath, root: join(seen.home, "Remudero") });
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(HOME_PREFIX)).sort(), kept.sort(),
    "normal exit cleans up the newly minted HOME");
});
