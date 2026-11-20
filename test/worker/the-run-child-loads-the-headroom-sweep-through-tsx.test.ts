import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Config } from "#src/lib/config.js";
import { loadMountHeadroomCells, resolveMountExplorationDispatch } from "#src/lib/mount-exploration.js";
import { loadMounts, mountsPath, type Mount } from "#src/lib/mounts.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

interface BuildChildEntries {
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers: string[]; outDir: string }): Promise<unknown>;
}

/** Two settled implement runs in one (type, risk, class) cell, so the sweep has a cell with an arm. */
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

/** Import a bundle in a plain `node` child (no tsx loader, no --import flags) and call one export on the fixture. */
function callInPlainNode(bundle: string, exportName: string, stateDir: string): { ok: boolean; cells?: unknown[]; code?: string; message?: string } {
  const code = `
const m = await import(${JSON.stringify(pathToFileURL(bundle).href)});
try {
  const cells = await m[${JSON.stringify(exportName)}](${JSON.stringify(REPO_ROOT)}, ${JSON.stringify(stateDir)});
  console.log(JSON.stringify({ ok: true, cells }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code, message: String(error?.message ?? error) }));
}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  env.NODE_V8_COVERAGE = "";
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: REPO_ROOT, env, encoding: "utf8" });
  assert.equal(run.status, 0, `the plain node child exits cleanly: ${run.stderr}`);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
}

test("W1-T13791 criterion 1: a bundled loadMountHeadroomCells returns cells under plain node, where a plain import() fails", async (t) => {
  const build = createRequire(import.meta.url)(join(REPO_ROOT, "scripts", "build-child-entries.mjs")) as BuildChildEntries;
  const { dir: out } = ownedFixtureDir(t, "w13791-bundle");
  // Child-entry builds externalize packages, so the bundle needs node_modules at runtime.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(out, "node_modules"), "dir");
  const ledger = writeLedger(sweepRows(), { scope: t });
  // The loader as main had it: a plain import() of the sweep, bundled the same way as a second tiny entry.
  const plainEntry = join(out, "plain-import-entry.mjs");
  writeFileSync(plainEntry, [
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "export async function loadByPlainImport(repoRoot, stateDir) {",
    '  const sweep = await import(pathToFileURL(join(repoRoot, "scripts", "mount-headroom-sweep.mjs")).href);',
    "  return sweep.buildMountHeadroomSweep(stateDir).cells;",
    "}",
    "",
  ].join("\n"));
  await build.buildChildEntries({
    root: REPO_ROOT,
    entries: [
      { name: "mount-exploration", source: "src/lib/mount-exploration.ts" },
      { name: "plain-import", source: plainEntry },
    ],
    workers: [],
    outDir: out,
  });

  const loaded = callInPlainNode(join(out, "mount-exploration.mjs"), "loadMountHeadroomCells", ledger.dir);
  assert.equal(loaded.ok, true, `the bundled loader reads the sweep with no tsx loader: ${loaded.code} ${loaded.message}`);
  assert.ok(Array.isArray(loaded.cells) && loaded.cells.length > 0, "the loader returns the sweep's cells");
  const cell = (loaded.cells as Array<{ cellKey: string; arms: Array<{ provider: string; n: number }> }>)[0]!;
  assert.match(cell.cellKey, /^implement::medium::src$/);
  assert.equal(cell.arms[0]?.provider, "claude");
  assert.equal(cell.arms[0]?.n, 2);

  const plain = callInPlainNode(join(out, "plain-import.mjs"), "loadByPlainImport", ledger.dir);
  assert.equal(plain.ok, false, "a plain import() of the sweep fails in the same child");
  assert.equal(plain.code, "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", plain.message);
});

test("W1-T13791 criterion 2: a sweep that cannot be read is ledgered as mount.exploration.error and keeps the on-policy mount", async (t) => {
  const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13791-empty-state-`));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const currentMount: Mount = { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 160000 };
  const config = { root: empty, workerProviders: { enabled: ["claude", "codex"] } } as unknown as Config;
  const input = {
    taskType: "implement", risk: "medium", taskClass: "src", currentMount, config,
    runId: "W1-T1-1", taskId: "W1-T1", enabledProviders: ["claude" as const, "codex" as const],
  };
  for (const loadCells of [
    () => loadMountHeadroomCells(REPO_ROOT, empty),
    async () => { throw new Error("sweep unavailable"); },
  ]) {
    const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const result = await resolveMountExplorationDispatch(input, {
      loadCells,
      loadMountsTable: () => loadMounts(mountsPath(REPO_ROOT)),
      log: (step, fields) => logged.push({ step, fields }),
    });
    assert.deepEqual(logged.map((row) => row.step), ["mount.exploration.error"]);
    assert.match(String(logged[0]?.fields.reason), /zero distinct runs|sweep unavailable/);
    assert.equal(result.mount, currentMount, "the run keeps its on-policy mount");
    assert.equal(result.config, config, "the run keeps its on-policy config");
  }
});
