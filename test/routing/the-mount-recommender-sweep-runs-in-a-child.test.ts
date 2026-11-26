// W1-T14922 — the daily mount-recommender sweep reads the ledger in a child process, never on the daemon's loop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadMountHeadroomCells, mountSweepTimingPath, MountSweepChildError } from "#src/lib/mount-exploration.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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

interface BuildChildEntries {
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers: string[]; outDir: string }): Promise<unknown>;
}

/** The rung as the run child runs it: bundled run-task.mjs under plain node, its CLI entry's exit held until it answers. */
function callBundledRung(bundle: string, instance: string, root: string): { result: unknown; rows: Array<Record<string, unknown>> } {
  const code = `
let answered;
const done = new Promise((resolve) => { answered = resolve; });
const exit = process.exit.bind(process);
process.exit = (code) => { void done.then(() => exit(code)); };
const m = await import(${JSON.stringify(pathToFileURL(bundle).href)});
const rows = [];
const result = await m.runMountRecommenderRung({ root: ${JSON.stringify(instance)} }, "SWEEP-W1-T14922",
  (step, fields) => rows.push({ step, ...fields }), { root: ${JSON.stringify(root)}, env: {} });
console.log(JSON.stringify({ result, rows }));
answered();`;
  const script = join(instance, "call-rung.mjs");
  writeFileSync(script, code);
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_SELF_SYNC_DONE: "1", NODE_V8_COVERAGE: "" };
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, env, encoding: "utf8" });
  const answer = run.stdout.split("\n").find((line) => line.startsWith("{\"result\""));
  assert.ok(answer, `the child printed the rung's answer: ${run.stdout.slice(-400)} ${run.stderr.slice(-800)}`);
  return JSON.parse(answer) as { result: unknown; rows: Array<Record<string, unknown>> };
}

/** A repo root whose sweep script is `body`, with the real node_modules so the child's `--import tsx` resolves. */
function fakeRoot(t: Parameters<typeof ownedFixtureDir>[0], body: string): string {
  const { dir } = ownedFixtureDir(t, "w14922-root");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "scripts", "mount-headroom-sweep.mjs"), body);
  return dir;
}

test("W1-T14922 the sweep runs in a child process", async (t) => {
  const marker = `__w14922_sweep_imported_${process.pid}`;
  // The script marks this process if it is ever imported here, and prints its report only when run as a program.
  const root = fakeRoot(t, [
    `globalThis[${JSON.stringify(marker)}] = true;`,
    `export function buildMountHeadroomSweep() { return { cells: [{ key: "imported" }] }; }`,
    `if (process.argv.includes("--json")) console.log(JSON.stringify({ cells: [{ key: "child", pid: process.pid }] }));`,
  ].join("\n"));
  const { dir: state } = ownedFixtureDir(t, "w14922-state");
  const cells = (await loadMountHeadroomCells(root, state)) as unknown as Array<{ key: string; pid: number }>;
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined, "the sweep is never imported into the calling process");
  assert.equal(cells.length, 1);
  assert.equal(cells[0]?.key, "child", "the cells came from the script run as a program");
  assert.notEqual(cells[0]?.pid, process.pid, "the script ran in another process");
  assert.ok(existsSync(mountSweepTimingPath(state)), "the child's measured duration is kept to size the next budget");
});

test("W1-T14922 child cells equal in-process cells", async (t) => {
  const ledger = writeLedger(sweepRows(), { scope: t });
  const sweep = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "mount-headroom-sweep.mjs")).href)) as {
    buildMountHeadroomSweep: (stateDir: string) => { cells: unknown[] };
  };
  const inProcess = sweep.buildMountHeadroomSweep(ledger.dir).cells;
  assert.ok(inProcess.length > 0, "the fixture has a cell");
  const child = await loadMountHeadroomCells(REPO_ROOT, ledger.dir);
  assert.deepEqual(child, JSON.parse(JSON.stringify(inProcess)), "the child's --json cells are the in-process cells");
});

test("W1-T14922 a failed sweep child is a named refusal", async (t) => {
  const build = createRequire(import.meta.url)(join(REPO_ROOT, "scripts", "build-child-entries.mjs")) as BuildChildEntries;
  const { dir: out } = ownedFixtureDir(t, "w14922-bundle");
  // Child-entry builds externalize packages, so the bundle needs node_modules at runtime.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(out, "node_modules"), "dir");
  await build.buildChildEntries({ root: REPO_ROOT, entries: [{ name: "run-task", source: "src/run-task.ts" }], workers: [], outDir: out });
  for (const [body, reason] of [
    ["process.exitCode = 3;", "sweep_child_exit"],
    ['console.log("not a report");', "sweep_child_unparseable"],
    ['console.log(JSON.stringify({ table: [] }));', "sweep_child_unparseable"],
  ] as const) {
    const root = fakeRoot(t, body);
    const { dir: state } = ownedFixtureDir(t, "w14922-state");
    await assert.rejects(loadMountHeadroomCells(root, state),
      (error: unknown) => error instanceof MountSweepChildError && error.reason === reason, `${body} -> ${reason}`);

    // The rung: one named refusal row, nothing filed, no proposal registry written.
    const { dir: instance } = ownedFixtureDir(t, "w14922-instance");
    const { result, rows } = callBundledRung(join(out, "run-task.mjs"), instance, root);
    assert.deepEqual(result, { filed: 0, refused: 0 }, `${reason}: the rung files nothing`);
    const refusal = rows.find((row) => row.step === "mount_recommendation.error");
    assert.equal(refusal?.reason, reason, `${reason}: the rung's refusal names the reason: ${JSON.stringify(rows)}`);
    assert.equal(rows.some((row) => row.step === "mount_recommendation.swept"), false);
    assert.equal(existsSync(join(instance, "state", "inbox-proposals.json")), false, "no proposal is filed");
  }
});
