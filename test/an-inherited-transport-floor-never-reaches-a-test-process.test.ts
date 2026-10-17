/**
 * A TEST'S OUTCOME MUST NOT DEPEND ON THE OPERATOR'S ENVIRONMENT.
 *
 * RMD_GH_TRANSPORT_FLOOR=enforce is exported by an operator's cadence wrapper for every command it
 * runs, and a developer or CI shell may export it too. A test process that inherited it refused its
 * own fixture's second gh-shim read with GhReadCadenceRefusal: the W1-T7719 suite
 * (test/a-stale-dirty-fix-owner-is-preserved-and-reclaimed.test.ts) passed 11/11 without the variable
 * and failed 5 of 11 with it. test/setup/tmp-hygiene.ts now drops the inherited mode in every test
 * process's main thread; a suite that exercises a mode sets it itself, after the setup has run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

const REPO_ROOT = findRepoRoot();
const SETUP = pathToFileURL(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts")).href;
const TRANSPORT = pathToFileURL(join(REPO_ROOT, "src", "lib", "github-transport.ts")).href;

/** Run a probe that prints the floor mode the transport resolves, with or without the test setup. */
function probeMode(t: { after: (fn: () => void) => void }, withSetup: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inherited-floor-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, `import { resolveGhTransportFloorMode } from ${JSON.stringify(TRANSPORT)};\n` +
    "process.stdout.write(resolveGhTransportFloorMode());\n");
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_GH_TRANSPORT_FLOOR: "enforce" };
  delete env.RMD_SELF_SYNC_DONE;
  const imports = withSetup ? ["--import", "tsx", "--import", SETUP] : ["--import", "tsx"];
  const run = spawnSync(process.execPath, [...imports, probe], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("a test process started under an inherited RMD_GH_TRANSPORT_FLOOR=enforce resolves the advisory default", { timeout: 120_000 }, (t) => {
  // Positive control: the same probe without the setup reads the inherited enforce, so the advisory
  // answer below is the setup's doing, not a probe that could never see the variable.
  assert.equal(probeMode(t, false), "enforce");
  assert.equal(probeMode(t, true), "advisory");
});

test("a SHARE_ENV worker thread's setup leaves a floor mode its parent test chose", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inherited-floor-worker-`));
  const previous = process.env.RMD_GH_TRANSPORT_FLOOR;
  t.after(() => {
    if (previous === undefined) delete process.env.RMD_GH_TRANSPORT_FLOOR;
    else process.env.RMD_GH_TRANSPORT_FLOOR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  // A FILE worker: an `eval: true` worker skips the `--import`s, so it would prove nothing.
  const script = join(dir, "worker.mjs");
  writeFileSync(script, "import { parentPort } from 'node:worker_threads';\n" +
    "parentPort.postMessage(process.env.RMD_GH_TRANSPORT_FLOOR ?? 'unset');\n");
  process.env.RMD_GH_TRANSPORT_FLOOR = "enforce";
  const worker = new Worker(script, { execArgv: ["--import", "tsx", "--import", SETUP], env: SHARE_ENV });
  try {
    const seen = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited (${code}) before reporting`)));
    });
    assert.equal(seen, "enforce", "the thread ran its setup and still saw the parent's mode");
    assert.equal(process.env.RMD_GH_TRANSPORT_FLOOR, "enforce", "the thread's setup cleared nothing in the parent");
  } finally {
    await worker.terminate();
  }
});
