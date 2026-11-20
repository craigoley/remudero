/**
 * W1-T13955 — the export gardener's appended proof imports the source through `#src` when the root maps that alias.
 * OBSERVED 2026-11-19/20 on #19731: the gardener appended a dynamic import of the source by a path relative to the test, and
 * test/a-test-imports-through-the-subpath-alias.test.ts (W1-T9864) failed coverage-shard 12/12 on it for 14 hours.
 *
 * @source-text-subject — every read below is of a throwaway fixture checkout the gardener itself rewrote, never this
 * repository's own `src/` or `test/`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { exportGardenCandidates, exportGardenSpec, exportInventory } from "#src/lib/export-gardener.js";
import { adoptionLatestPath, adoptionProposalId } from "#src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const TESTS = "test/export-gardener-removes-unreferenced-exports.test.ts";
const SOURCE = "src/lib/dead-thing.ts";
const DEAD_TEXT = `import { join } from "node:path";\n\nexport function used(): string {\n  return join("a", "b");\n}\n\n/** deadA: nothing calls this. */\nexport function deadA(): number {\n  return 1;\n}\n`;
const SEEDED_TESTS = `import assert from "node:assert/strict";\nimport { join } from "node:path";\nimport { test } from "node:test";\nimport { used } from "#src/lib/dead-thing.js";\n\ntest("used still joins its path components", () => {\n  assert.equal(used(), join("a", "b"));\n});\n`;
const TITLE = "deadA is not exported from dead-thing";
const ALIASED_PACKAGE = `${JSON.stringify({ type: "module", imports: { "#src/*": "./src/*" } })}\n`;

function fixture(files: Record<string, string>): { repo: GitRepo; stateDir: string } {
  const repo = gitRepo({ kind: "w1t13955" });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return { repo, stateDir: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13955-state-`)) };
}

/** Two scans in a row report `deadA`, so it is a candidate; then the gardener applies it once. */
function applyOnce(repo: GitRepo, stateDir: string) {
  for (const generatedAt of ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]) {
    const proposalIds = [adoptionProposalId({ shape: "symbol-no-caller", definedIn: SOURCE, mechanism: "deadA" })];
    writeFileSync(adoptionLatestPath(stateDir), JSON.stringify({ generatedAt, proposalIds, shapesObserved: ["symbol-no-caller"] }));
    exportInventory(repo.dir, stateDir);
  }
  const actions = exportGardenCandidates(exportInventory(repo.dir, stateDir), repo.dir);
  assert.deepEqual(actions.map((c) => c.name), ["deadA"]);
  const spec = exportGardenSpec({ stateDir, repoRoot: repo.dir, openWorkspace: () => assert.fail("unused"), log: () => {} });
  return spec.apply({ root: repo.dir, land: () => undefined, dispose: () => {} }, { actions, acting: ["delete-unreferenced-export"] }, {});
}

/** Run the fixture's appended test the way review would: by its title, under tsx, with a TAP summary. */
function runTitle(root: string): string {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` would otherwise report to THIS runner, not to stdout
  env.NODE_V8_COVERAGE = undefined; // W1-T2732: a fixture run enrolled in this suite's coverage leaves the parent's lcov empty
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", "--test-reporter=tap", "--test-name-pattern", TITLE, TESTS], {
    cwd: root, encoding: "utf8", env,
  });
  return `${r.stdout}\n${r.stderr}`;
}

test("W1-T13955 criterion 1: a root that maps #src/* gets a proof importing through the alias, and the proof still discriminates", () => {
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT, [TESTS]: SEEDED_TESTS, "package.json": ALIASED_PACKAGE });
  assert.ok(applyOnce(repo, stateDir), "the deletion lands");
  const tests = readFileSync(join(repo.dir, TESTS), "utf8");
  assert.equal(tests, `${SEEDED_TESTS}\ntest("${TITLE}", async () => {\n  const module = await import("#src/lib/dead-thing.js");\n  assert.equal(Object.hasOwn(module, "deadA"), false);\n});\n`);
  const head = runTitle(repo.dir);
  assert.match(head, /^# pass 1$/m, head);
  assert.match(head, /^# fail 0$/m, head);
  writeFileSync(join(repo.dir, SOURCE), DEAD_TEXT);
  const base = runTitle(repo.dir);
  assert.match(base, /^# fail 1$/m, base);
});

test("W1-T13955 criterion 2: a root whose package.json does not parse keeps the location-relative proof", () => {
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT, [TESTS]: SEEDED_TESTS, "package.json": "{ not json\n" });
  assert.ok(applyOnce(repo, stateDir), "the deletion lands");
  const tests = readFileSync(join(repo.dir, TESTS), "utf8");
  // The relative specifier is assembled, so this file itself carries none (W1-T9864 reads test text).
  const relative = [".", ".", "/src/lib/dead-thing.js"].join("");
  assert.ok(tests.endsWith(`  const module = await import("${relative}");\n  assert.equal(Object.hasOwn(module, "deadA"), false);\n});\n`), tests);
});
