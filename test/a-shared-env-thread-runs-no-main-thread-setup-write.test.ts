/**
 * test/a-shared-env-thread-runs-no-main-thread-setup-write.test.ts — W1-T5744.
 *
 * A Worker inherits the runner's `--import` execArgv, so the test setup re-runs in each thread. Under
 * `env: SHARE_ENV` (the read plane, the read-model threads) that thread's `process.env` IS the parent's,
 * so any setup write lands in the test process. The setup makes no write in a thread that overwrites
 * the parent: no GIT_CONFIG growth, and no sentinel over a GH_TOKEN the daemon refreshed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = pathToFileURL(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts")).href;

/** Every env entry the setup could write: GIT_CONFIG_*, the tokens, the scratch switch, the prompt flag. */
function snapshot(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("GIT_CONFIG_")) out[k] = v;
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "RMD_SCRATCH_SWITCH", "GIT_TERMINAL_PROMPT", "RMD_TEST_LIVE_DENY_ROOT", "HOME", "PATH"]) out[k] = process.env[k];
  return out;
}

test("a SHARE_ENV worker thread started under the test setup leaves the parent's GIT_CONFIG_COUNT and GIT_CONFIG entries unchanged", { timeout: 60_000 }, async (t) => {
  const scripts = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5744-src-`));
  // A FILE worker: an `eval: true` worker skips the `--import`s, so it would prove nothing.
  const script = join(scripts, "worker.mjs");
  writeFileSync(script, "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ setup: process.env.NODE_TEST_CONTEXT });\nsetInterval(() => {}, 1000);\n");
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  // The daemon's refreshed token: the setup must not write the sentinel over it from a thread.
  process.env.GH_TOKEN = "refreshed-by-the-daemon";
  process.env.GITHUB_TOKEN = "refreshed-by-the-daemon";
  delete process.env.RMD_ALLOW_LIVE_WRITES;
  delete process.env.RMD_SELF_SYNC_DONE;
  const before = snapshot();
  const worker = new Worker(script, { execArgv: ["--import", "tsx", "--import", SETUP], env: SHARE_ENV });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited (${code}) before reporting`)));
    });
    assert.deepEqual(snapshot(), before, "the thread's setup wrote nothing into the parent's env");
    assert.equal(process.env.GH_TOKEN, "refreshed-by-the-daemon");
    assert.equal(process.env.GIT_CONFIG_COUNT, before.GIT_CONFIG_COUNT);
  } finally {
    await worker.terminate();
  }
});
