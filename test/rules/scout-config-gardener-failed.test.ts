import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

test("W1-T10141: config.gardener_failed no longer recurs", async (t) => {
  const repo = resolve(import.meta.dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "rmd-config-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["src", "scripts", "packages/api-client/src", ".remudero", "package.json", "tsconfig.json"]) {
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  for (const path of ["state", "plan/tasks.d"]) mkdirSync(join(root, path), { recursive: true });
  cpSync(join(repo, "plan/policy.yaml"), join(root, "plan/policy.yaml"));
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  const now = new Date().toISOString();
  writeFileSync(join(root, "state/ledger.ndjson"), [
    { step: "run.start", run_id: "control", task_id: "W1-T1", type: "implement", risk: "low", task_class: "src", ts: now },
    { step: "implement.done", run_id: "control", model: "sonnet", effort: "high", cost_usd: 3, num_turns: 4, ts: now },
    { step: "verdict", run_id: "control", verdict: "merged", cost_usd: 3, ts: now },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(root, "src/config-regression-main.ts"), `
    import { buildRegisteredGarden } from "#src/run-task.js";
    import { readFileSync } from "node:fs";
    const root = process.cwd();
    const events = [];
    const pass = await buildRegisteredGarden("config", {
      config: { root, claudeBin: "/bin/true", overflow: "none" }, repoRoot: root,
      owner: "fixture", repo: "remudero", raiseDuplicate: () => "",
      log: (step, extra) => events.push({ step, extra }),
    });
    await pass();
    let cells;
    try { cells = JSON.parse(readFileSync(root + "/state/config-mount-headroom-sweep.json", "utf8")).cells; }
    catch (error) { events.push({ step: "fixture.cache_unread", extra: { error: String(error) } }); }
    console.log(JSON.stringify({ events, cells, execArgv: process.execArgv }));
  `);
  const builder = await import(pathToFileURL(join(repo, "scripts/build-child-entries.mjs")).href);
  await builder.buildChildEntries({ root, entries: [{ name: "config-regression", source: "src/config-regression-main.ts" }], workers: ["src/lib/config-gardener.ts"] });
  const child = await promisify(execFile)(process.execPath, ["--max-old-space-size=512", join(root, "dist/child-entries/config-regression.mjs")], {
    cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: "" }, timeout: 60_000,
  });
  const result = JSON.parse(child.stdout.trim());
  assert.deepEqual(result.execArgv, ["--max-old-space-size=512"], "the garden starts without a tsx preload");
  assert.ok(result.events.some((event: { step: string }) => event.step === "config.scorecard"), child.stdout);
  assert.deepEqual(result.events.filter((event: { step: string }) => /gardener_failed|mount_recommendations_unread|cache_unread/.test(event.step)), [], child.stdout);
  assert.equal(result.cells.length, 1, "the real mount sweep completed in the bundled measurement worker");
  assert.equal(result.cells[0].arms[0].n, 1, "positive control: the sweep priced the fixture run");
});
