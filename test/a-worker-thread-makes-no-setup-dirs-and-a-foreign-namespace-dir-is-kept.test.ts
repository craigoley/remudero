/**
 * test/a-worker-thread-makes-no-setup-dirs-and-a-foreign-namespace-dir-is-kept.test.ts — W1-T5624.
 *
 * Two gaps W1-T5550's setup-dir reap (test/setup/no-live-remote.ts `reapDeadOwnerDirs`) left:
 *
 *  1. WORKER THREADS. A file `new Worker(...)` given the runner's execArgv re-runs both `--import`s,
 *     so test/setup ran a second time per worker: two more `rmd-test-gh-*` dirs, named with the
 *     PARENT's pid, that a `worker.terminate()` (no `exit` event in the worker) leaves behind. The
 *     worker's env copy already holds GH_CONFIG_DIR and the stub on PATH, so it now makes neither.
 *  2. PID NAMESPACES. Liveness was judged by pid alone, behind a 60 s age read from a dir mtime that
 *     never moves, so a live run in another container sharing the tmp lost its gh refusal stub after
 *     a minute. Each setup dir now carries the owner's pid-namespace id, and a dir from another
 *     namespace is kept for 24 h whatever its pid reads as here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Namespace imports, not named ones: this file must LOAD on the base tree (where the new exports do
// not exist) so its assertions, not a module-load error, are what fail there.
import * as noLiveRemote from "./setup/no-live-remote.js";
import * as tmpHygiene from "./setup/tmp-hygiene.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = pathToFileURL(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts")).href;
const { GH_CONFIG_DIR_PREFIX, reapDeadOwnerDirs } = noLiveRemote;
const { GH_REFUSE_DIR_PREFIX } = tmpHygiene;
const ns = noLiveRemote as unknown as {
  pidNamespaceId?: (readlink?: (path: string) => string) => string;
  FOREIGN_NAMESPACE_MAX_AGE_MS?: number;
};

/** Every `rmd-test-gh-*` dir directly under `root`. */
function ghSetupDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith("rmd-test-gh-")).sort();
}

test("W1-T5624: a worker thread loading the test setup creates no rmd-test-gh-* dir and keeps the parent's containment", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5624-worker-root-`));
  const scripts = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5624-worker-src-`));
  // A FILE worker, as every src call site uses: an `eval: true` worker skips the `--import`s
  // entirely, so it would pass this test on the base tree and prove nothing.
  const script = join(scripts, "worker.mjs");
  writeFileSync(script, [
    "import { parentPort } from 'node:worker_threads';",
    "const head = (process.env.PATH ?? '').split(':')[0];",
    "parentPort.postMessage({ config: process.env.GH_CONFIG_DIR, refuse: head, home: process.env.HOME });",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root };
  delete env.RMD_ALLOW_LIVE_WRITES;
  delete env.RMD_SELF_SYNC_DONE;
  // The runner's own two `--import`s, spelled out rather than read from process.execArgv, so the
  // worker loads the setup however this file was launched.
  const worker = new Worker(script, { execArgv: ["--import", "tsx", "--import", SETUP], env });
  try {
    const seen = await new Promise<{ config?: string; refuse: string; home?: string }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited (${code}) before reporting`)));
    });
    // Positive control: the worker DID load the setup under `root` — its HOME is the setup's own
    // `rmd-test-home-` dir, minted there. Without this, a worker that skipped the `--import`s would
    // pass the assertion below by never running the code under test.
    assert.equal(dirname(seen.home ?? ""), root, `the worker loaded the setup with TMPDIR=${root}`);
    assert.ok(basename(seen.home ?? "").startsWith("rmd-test-home-"), String(seen.home));

    assert.deepEqual(ghSetupDirs(root), [], "a worker thread mints no gh config or refusal-stub dir");
    assert.equal(seen.config, process.env.GH_CONFIG_DIR, "it keeps the parent's GH_CONFIG_DIR");
    assert.equal(seen.refuse, (process.env.PATH ?? "").split(":")[0], "and the parent's refusal stub heads its PATH");
  } finally {
    await worker.terminate();
  }
  assert.deepEqual(ghSetupDirs(root), [], "so a terminate() leaves no setup dir behind");
});

test("W1-T5624: the main thread's setup dirs carry its pid and pid-namespace id", () => {
  assert.equal(typeof ns.pidNamespaceId, "function", "no-live-remote exports pidNamespaceId");
  const id = ns.pidNamespaceId?.() ?? "";
  assert.match(id, /^\d+$/);
  const config = basename(process.env.GH_CONFIG_DIR ?? "");
  const refuse = basename((process.env.PATH ?? "").split(":")[0]);
  assert.ok(config.startsWith(`${GH_CONFIG_DIR_PREFIX}${process.pid}-${id}-`), config);
  assert.ok(refuse.startsWith(`${GH_REFUSE_DIR_PREFIX}${process.pid}-${id}-`), refuse);
});

test("W1-T5624: pidNamespaceId reads the inode from /proc/self/ns/pid, and 0 where it cannot", () => {
  assert.equal(ns.pidNamespaceId?.(() => "pid:[4026531836]"), "4026531836");
  assert.equal(ns.pidNamespaceId?.(() => {
    throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
  }), "0", "no /proc (macOS): every dir reads as this namespace");
  assert.equal(ns.pidNamespaceId?.(() => "something else"), "0", "an unreadable link is not a namespace id");
});

test("W1-T5624: a dead-pid setup dir from another pid namespace is kept as foreign-namespace until it is 24 h old", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5624-reap-`));
  const make = (name: string) => {
    mkdirSync(join(root, name));
    return statSync(join(root, name)).mtimeMs;
  };
  const foreignName = `${GH_CONFIG_DIR_PREFIX}424242-111-aaaaaa`;
  const ownName = `${GH_CONFIG_DIR_PREFIX}434343-222-bbbbbb`;
  const legacyName = `${GH_CONFIG_DIR_PREFIX}444444-cccccc`; // a W1-T5550 name with no namespace id
  const mtime = make(foreignName);
  make(ownName);
  make(legacyName);
  const deps = { root, isAlive: () => false, namespaceId: () => "222" };

  const day = ns.FOREIGN_NAMESPACE_MAX_AGE_MS ?? 0;
  assert.equal(day, 24 * 60 * 60 * 1000, "the foreign-namespace guard is 24 h");

  const stale = reapDeadOwnerDirs(GH_CONFIG_DIR_PREFIX, { ...deps, clock: fixedClock(mtime + 61_000) });
  assert.deepEqual(stale.removed.sort(), [legacyName, ownName].sort(), "this namespace's dead dirs go after a minute");
  assert.deepEqual(
    stale.kept.map((k) => `${k.name}:${k.reason}`),
    [`${foreignName}:foreign-namespace`],
    "a dead-reading pid from another namespace may be a live run there",
  );

  const old = reapDeadOwnerDirs(GH_CONFIG_DIR_PREFIX, { ...deps, isAlive: () => true, clock: fixedClock(mtime + day + 1_000) });
  assert.deepEqual(old.removed, [foreignName], "past 24 h a foreign dir goes whatever its pid reads as here");
  assert.deepEqual(readdirSync(root), []);
});
