import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { measurementWorkerOptions } from "../src/lib/config-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5725 (#9111): garden-registry starts each gardener child with --max-old-space-size=<mb>, and the
// config gardener handed that execArgv to `new Worker`, which refuses V8 heap flags — so most config
// passes failed with "Initiated Worker with invalid execArgv flags".

const GARDENER = pathToFileURL(resolve("src/lib/config-gardener.ts")).href;

test("W1-T5725: the heap budget is parsed from every heap flag form", () => {
  assert.deepEqual(measurementWorkerOptions(["--import", "tsx", "--max-old-space-size=2048"]), { resourceLimits: { maxOldGenerationSizeMb: 2048 } });
  assert.deepEqual(measurementWorkerOptions(["--max-old-space-size", "1536", "--import", "tsx"]), { resourceLimits: { maxOldGenerationSizeMb: 1536 } });
  assert.deepEqual(measurementWorkerOptions(["--max_old_space_size=1024"]), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  assert.deepEqual(measurementWorkerOptions(["--max-old-space-size=512", "--max-old-space-size=4096"]), { resourceLimits: { maxOldGenerationSizeMb: 4096 } }, "the last flag wins, as in V8");
  assert.deepEqual(measurementWorkerOptions(["--import", "tsx", "--max-semi-space-size=64", "--max_semi_space_size", "32"]), {}, "a semi-space flag carries no old-generation budget");
  assert.deepEqual(measurementWorkerOptions(["--import", "tsx"]), {});
  // The options never carry an execArgv: the worker inherits the loader, and no heap flag is forwarded.
  assert.equal("execArgv" in measurementWorkerOptions(["--import", "tsx", "--max-old-space-size=2048"]), false);
});

test("W1-T5725: a gardener child with a heap flag runs its config measurement on a real worker", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}config-worker-flags-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");

  // The garden child's own shape (garden-registry): the loader plus a heap flag, outside any test runner,
  // driving the real configMeasurementOffLoop wiring and a real Worker started with the same options.
  const script = `
    import { Worker } from "node:worker_threads";
    import { configMeasurementOffLoop, measurementWorkerOptions } from ${JSON.stringify(GARDENER)};
    const inventory = await configMeasurementOffLoop({ kind: "inventory", repoRoot: ${JSON.stringify(root)}, stateDir: ${JSON.stringify(stateDir)}, nowMs: Date.now(), rows: [], recommendations: [] });
    const heapMb = await new Promise((resolve, reject) => {
      const w = new Worker("const v8 = require('node:v8'); require('node:worker_threads').parentPort.postMessage(Math.round(v8.getHeapStatistics().heap_size_limit / 1048576));", { eval: true, ...measurementWorkerOptions(process.execArgv) });
      w.once("message", (mb) => { void w.terminate(); resolve(mb); });
      w.once("error", reject);
    });
    process.stdout.write(JSON.stringify({ inventory: typeof inventory, heapMb }));
  `;
  const child = join(root, "garden-child.mts");
  writeFileSync(child, script);
  const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--max-old-space-size=2048", child], {
    cwd: resolve("."), encoding: "utf8", env,
  });
  const result = JSON.parse(out) as { inventory: string; heapMb: number };
  assert.equal(result.inventory, "object", "the measurement worker answered with an inventory");
  assert.ok(result.heapMb >= 2048 && result.heapMb < 2048 + 512, `the worker keeps the child's 2048 MB old-generation budget (heap limit ${result.heapMb} MB)`);
});
