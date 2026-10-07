/**
 * W1-T6089 — a src module that SPAWNS or READS a src path keeps its graph edge to it; one that only
 * lists the path as DATA does not.
 *
 * @source-text-subject: source text is the selector's input. These tests pass fixture strings and
 * real modules to selectAffectedSuites and assert selected suites, rather than matching source prose.
 *
 * #9720's `namedEdges` dropped every src path string inside a src module, because the tables
 * (authority.ts, config-schema.ts, worktree-sites.ts, baked-runtime-inputs.ts) made 114 false edges.
 * That also dropped four real ones: serve-supervisor, operator-mcp and gate-gardener spawn
 * src/run-task.ts by a joined path, and measurement-cadence reads it as text — so a change to
 * run-task.ts no longer selected their suites through them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as affected from "../src/lib/affected-suites.js";

const REPO = join(import.meta.dirname, "..");

/** Each module beside a suite importing it; the suite is selected only through the module's edge. */
function world(modules: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>([["src/run-task.ts", "export const main = 1;\n"]]);
  for (const [path, content] of Object.entries(modules)) {
    files.set(path, content);
    const stem = path.replace(/^src\//, "").replace(/\.ts$/, "");
    files.set(`test/${stem.replace(/\//g, "-")}.test.ts`, `import "../${path.replace(/\.ts$/, ".js")}";\n`);
  }
  return files;
}

const selected = (files: Map<string, string>, changed = "src/run-task.ts") =>
  affected.selectAffectedSuites([changed], { files, pathReaders: [] }).suites;

const SPAWNERS: Record<string, string> = {
  // operator-mcp: a joined path inside the runBoundedSuite argv.
  "src/mcp.ts": 'const r = runBoundedSuite(process.execPath, ["--import", "tsx", join(deps.repoRoot, "src", "run-task.ts"), verb], {\n  cwd: deps.repoRoot });\n',
  // serve-supervisor: a joined path handed to cluster as its `exec:` field.
  "src/supervisor.ts": 'export const command = (slot) => ({\n  exec: join(slot.dir, "src", "run-task.ts"),\n  args: [],\n});\n',
  // gate-gardener: a joined path in an argv array assigned first and spawned later.
  "src/gardener.ts": 'const args = ["--import", "tsx", join(deps.repoRoot, "src/run-task.ts"), "next-task-id"];\nexecFileSync(process.execPath, args);\n',
  // a cwd-relative path straight in a spawn argv; a `)` inside an earlier string or regex is no bracket.
  "src/self.ts": 'spawnSync(which("node)", /[)]/), ["--import", "tsx", "src/run-task.ts"]);\n',
};

const READERS: Record<string, string> = {
  // measurement-cadence: the module reads the file as text.
  "src/cadence.ts": 'const text = readFileSync(join(opts.checkoutDir, "src", "run-task.ts"), "utf8");\n',
  "src/bare-read.ts": 'const text = readFileSync("src/run-task.ts", "utf8");\n',
};

const TABLES: Record<string, string> = {
  "src/table.ts": 'export const SITES = ["src/run-task.ts", "src/other.ts"];\n',
  "src/rows.ts": 'export const ROWS = [\n  { path: "src/run-task.ts", literal: "ENV" },\n  envEntry("X", "unlike readFileSync(", ["src/run-task.ts"]),\n];\n',
  "src/membership.ts": 'const pending = sourceRels.has("src/run-task.ts") ? ["src/run-task.ts"] : [];\n',
  "src/constant.ts": 'export const RUN_TASK = "src/run-task.ts";\nexport const SPLIT = join("src", "run-task.ts");\n',
  // A table inside a spawn call's options object is still data: the `{` ends the walk.
  "src/options.ts": 'spawnSync("node", [], { env: { ENTRY: "src/run-task.ts" } });\n',
};

test("a src module that spawns src/run-task.ts by a joined path is an importer of it", () => {
  const suites = selected(world(SPAWNERS));
  for (const suite of ["test/mcp.test.ts", "test/supervisor.test.ts", "test/gardener.test.ts", "test/self.test.ts"]) {
    assert.ok(suites.includes(suite), `${suite} imports a module that spawns src/run-task.ts`);
  }
});

test("a src module reading a src path with readFileSync keeps that edge", () => {
  assert.deepEqual(selected(world(READERS)), ["test/bare-read.test.ts", "test/cadence.test.ts"]);
});

test("a src module that lists the same path in a data table is not an importer of it", () => {
  assert.deepEqual(selected(world(TABLES)), [], "a table, array, membership test, constant or options object is data");
  // Control: the same world with one spawner added selects exactly that spawner's suite.
  assert.deepEqual(selected(world({ ...TABLES, "src/mcp.ts": SPAWNERS["src/mcp.ts"]! })), ["test/mcp.test.ts"]);
});

test("the real spawn and read sites keep their edge to src/run-task.ts and the real tables do not", () => {
  const real = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, readFileSync(join(REPO, p), "utf8")]));
  const users = ["src/lib/serve-supervisor.ts", "src/lib/operator-mcp.ts", "src/lib/gate-gardener.ts", "src/lib/measurement-cadence.ts"];
  const tables = ["src/lib/authority.ts", "src/lib/config-schema.ts", "src/lib/worktree-sites.ts", "src/lib/baked-runtime-inputs.ts"];
  assert.deepEqual(selected(world(real(users))), [
    "test/lib-gate-gardener.test.ts", "test/lib-measurement-cadence.test.ts", "test/lib-operator-mcp.test.ts", "test/lib-serve-supervisor.test.ts",
  ]);
  for (const [table, content] of Object.entries(real(tables))) {
    // Every src path the table names that it does not also import — each one held only as data.
    const named = [...new Set([...content.matchAll(/["'](src\/[\w./-]+\.ts)["']/g)].map((m) => m[1]!))]
      .filter((p) => p !== table && !content.includes(`/${p.split("/").pop()!.replace(/\.ts$/, ".js")}"`));
    assert.ok(named.length >= 5, `${table} lists src paths as data (found ${named.length})`);
    const sel = affected.selectAffectedSuites(named, { files: world({ [table]: content }), pathReaders: [] });
    assert.deepEqual(sel.suites, [], `${table} only lists ${named.length} src paths`);
  }
});
