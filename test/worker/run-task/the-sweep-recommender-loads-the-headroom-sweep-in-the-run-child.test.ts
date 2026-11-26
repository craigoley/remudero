import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

interface BuildChildEntries {
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers: string[]; outDir: string }): Promise<unknown>;
}

/** Two settled implement runs in one (type, risk, class) cell, so the sweep has one cell with one arm. */
function sweepRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [i, ts] of ["2026-11-01T00:00:00.000Z", "2026-11-01T01:00:00.000Z"].entries()) {
    const run = { run_id: `W1-T1-${i}`, task_id: "W1-T1", ts };
    rows.push({ ...run, step: "run.start", type: "implement", risk: "medium", task_class: "src" });
    rows.push({ ...run, step: "implement.done", num_turns: 10, provider: "claude", served_model: "claude-sonnet-5", effort: "high" });
    rows.push({ ...run, step: "verdict", verdict: "merged", cost_usd: 1 });
  }
  return rows;
}

test("W1-T14472 criterion 1: the bundled run child's mount recommender rung sweeps the ledger under plain node instead of failing on strip-only TypeScript", async (t) => {
  const build = createRequire(import.meta.url)(join(REPO_ROOT, "scripts", "build-child-entries.mjs")) as BuildChildEntries;
  const { dir: out } = ownedFixtureDir(t, "w14472-bundle");
  // Child-entry builds externalize packages, so the bundle needs node_modules at runtime.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(out, "node_modules"), "dir");
  await build.buildChildEntries({ root: REPO_ROOT, entries: [{ name: "run-task", source: "src/run-task.ts" }], workers: [], outDir: out });
  const { dir: instance } = ownedFixtureDir(t, "w14472-instance");
  writeLedger(sweepRows(), { dir: join(instance, "state") });

  // The bundle's CLI entry runs on import and exits once it has printed usage. W1-T14922 reads the sweep in a child
  // process, so the rung now outlives that exit: hold the entry's exit until the rung has answered.
  const code = `
let answered;
const done = new Promise((resolve) => { answered = resolve; });
const exit = process.exit.bind(process);
process.exit = (code) => { void done.then(() => exit(code)); };
const m = await import(${JSON.stringify(pathToFileURL(join(out, "run-task.mjs")).href)});
const rows = [];
const result = await m.runMountRecommenderRung({ root: ${JSON.stringify(instance)} }, "SWEEP-W1-T14472",
  (step, fields) => rows.push({ step, ...fields }), { root: ${JSON.stringify(REPO_ROOT)}, env: {} });
console.log(JSON.stringify({ result, rows }));
answered();`;
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_SELF_SYNC_DONE: "1", NODE_V8_COVERAGE: "" };
  delete env.NODE_OPTIONS;
  // A plain node child: no tsx loader and no --import flags, as the run child runs.
  const script = join(instance, "call-rung.mjs");
  writeFileSync(script, code);
  const run = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, env, encoding: "utf8" });
  // The bundle's own CLI entry also runs in this child and prints usage afterwards; the rung's answer is the JSON line.
  const answer = run.stdout.split("\n").find((line) => line.startsWith("{\"result\""));
  assert.ok(answer, `the child printed the rung's answer: ${run.stdout.slice(-400)} ${run.stderr.slice(-800)}`);
  const { result, rows } = JSON.parse(answer) as {
    result: { filed: number; refused: number }; rows: Array<{ step: string; cells?: number; error?: string }>;
  };
  assert.deepEqual(rows.filter((row) => row.step === "mount_recommendation.error"), [], "the rung reads the sweep without a strip-only failure");
  const swept = rows.find((row) => row.step === "mount_recommendation.swept");
  assert.ok(swept, `the rung writes its swept row: ${JSON.stringify(rows)}`);
  assert.equal(swept.cells, 1, "the sweep's one fixture cell reaches the recommender");
  assert.equal(result.filed + result.refused, 1, "the recommender judged that one cell");
});
