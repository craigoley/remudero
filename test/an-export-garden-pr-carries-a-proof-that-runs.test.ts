/**
 * W1-T5278: the export gardener's PR body carried the prose proof `the required CI checks pass on
 * this PR`, which names no dialect — acceptance-author-gate refused every PR it opened (#8540, #7441,
 * each hand-repaired). A deletion cannot be proven by `grep:` (the deleted text matches only at
 * base), so the gardener now appends one test per deletion that fails at base, and the body names it
 * as a `unit test:` proof. A deletion whose test cannot be written is withdrawn, never shipped bare.
 *
 * @source-text-subject — this gardener's OUTPUT is source text (a deleted declaration and an appended
 * test). Every read below is of a throwaway fixture checkout the gardener itself rewrote, never this
 * repository's own `src/` or `test/`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { applyExportDeletions, exportGardenCandidates, exportGardenSpec, exportInventory } from "../src/lib/export-gardener.js";
import { writeAtomic } from "../src/lib/fs-race-safe.js";
import { adoptionLatestPath, adoptionProposalId } from "../src/lib/measurement-cadence.js";
import { acceptanceAuthorTimeCheck, parseAcceptanceBlock, parseWhitelistedProof } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const TESTS = "test/export-gardener-removes-unreferenced-exports.test.ts";
const SOURCE = "src/lib/dead-thing.ts";
const DEAD_TEXT = `import { join } from "node:path";\n\nexport function used(): string {\n  return join("a", "b");\n}\n\n/** deadA: nothing calls this. */\nexport function deadA(): number {\n  return 1;\n}\n`;
const SEEDED_TESTS = `import assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("earlier is not exported from elsewhere", () => {\n  assert.ok(true);\n});\n`;
const TITLE = "deadA is not exported from dead-thing";

function fixture(files: Record<string, string>): { repo: GitRepo; stateDir: string } {
  const repo = gitRepo({ kind: "w1t5278" });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5278-state-`));
  return { repo, stateDir };
}

/** Two scans in a row report `deadA`, so it is a candidate. */
function candidatesFor(repo: GitRepo, stateDir: string) {
  for (const generatedAt of ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]) {
    const proposalIds = [adoptionProposalId({ shape: "symbol-no-caller", definedIn: SOURCE, mechanism: "deadA" })];
    writeFileSync(adoptionLatestPath(stateDir), JSON.stringify({ generatedAt, proposalIds, shapesObserved: ["symbol-no-caller"] }));
    exportInventory(repo.dir, stateDir);
  }
  const candidates = exportGardenCandidates(exportInventory(repo.dir, stateDir), repo.dir);
  assert.deepEqual(
    candidates.map((c) => c.name),
    ["deadA"],
  );
  return candidates;
}

function applyOnce(repo: GitRepo, stateDir: string) {
  const actions = candidatesFor(repo, stateDir);
  const spec = exportGardenSpec({ stateDir, repoRoot: repo.dir, openWorkspace: () => assert.fail("unused"), log: () => {} });
  return spec.apply({ root: repo.dir, land: () => undefined, dispose: () => {} }, { actions, acting: ["delete-unreferenced-export"] }, {});
}

/** Run the fixture's appended test the way review would: by its title, under tsx, with a TAP summary. */
function runTitle(root: string): string {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` would otherwise report to THIS runner, not to stdout
  // W1-T2732: blanked, not deleted — node re-injects it into every child, and a fixture run enrolled
  // in this suite's coverage session leaves the parent's lcov EMPTY (measured under diff-coverage-local).
  env.NODE_V8_COVERAGE = undefined;
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", "--test-reporter=tap", "--test-name-pattern", TITLE, TESTS], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return `${r.stdout}\n${r.stderr}`;
}

test("W1-T5278 criterion 1: an export-garden PR body carries one runnable unit test proof per deletion, and the test is written beside it", () => {
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT, [TESTS]: SEEDED_TESTS });
  const pr = applyOnce(repo, stateDir);
  assert.ok(pr, "the deletion lands");
  assert.deepEqual(pr.paths, [SOURCE, TESTS], "the appended test is committed with the deletion");

  const criteria = parseAcceptanceBlock(pr.body);
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.claim, TITLE);
  assert.equal(criteria[0]!.proof, `unit test: ${TITLE}`);
  const parsed = parseWhitelistedProof(criteria[0]!.proof);
  assert.equal(parsed?.kind, "test");
  assert.equal(parsed?.nameFiltered, true);
  assert.deepEqual(acceptanceAuthorTimeCheck(pr.body), { ok: true, message: "Acceptance block is judgeable" }, "no proof is inert");

  const tests = readFileSync(join(repo.dir, TESTS), "utf8");
  assert.equal(
    tests,
    `${SEEDED_TESTS}\ntest("${TITLE}", async () => {\n  const module = await import("../src/lib/dead-thing.js");\n  assert.equal(Object.hasOwn(module, "deadA"), false);\n});\n`,
  );
  assert.doesNotMatch(readFileSync(join(repo.dir, SOURCE), "utf8"), /deadA/);

  // The proof discriminates: it passes at head and fails once the deleted export is restored.
  const head = runTitle(repo.dir);
  assert.match(head, /^# pass 1$/m, head);
  assert.match(head, /^# fail 0$/m, head);
  writeFileSync(join(repo.dir, SOURCE), DEAD_TEXT);
  const base = runTitle(repo.dir);
  assert.match(base, /^# fail 1$/m, base);
});

test("W1-T5278: a deletion whose test title already exists is withdrawn, not shipped without a proof", () => {
  const already = `${SEEDED_TESTS}\ntest("${TITLE}", () => {});\n`;
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT });
  // Written after the seed commit: a TRACKED mention of the name is a reference, and the export
  // would never be a candidate; an untracked one is invisible to `git grep`, so only the title
  // check stands between it and a second test of the same name.
  mkdirSync(dirname(join(repo.dir, TESTS)), { recursive: true });
  writeFileSync(join(repo.dir, TESTS), already);
  assert.equal(applyOnce(repo, stateDir), undefined, "nothing lands");
  assert.equal(readFileSync(join(repo.dir, SOURCE), "utf8"), DEAD_TEXT, "the export is not deleted");
  assert.equal(readFileSync(join(repo.dir, TESTS), "utf8"), already, "the test file is untouched");
});

test("W1-T5278: a deletion whose test file cannot be read is withdrawn", () => {
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT, [`${TESTS}/occupied`]: "a directory where the test file should be\n" });
  assert.equal(applyOnce(repo, stateDir), undefined, "nothing lands");
  assert.equal(readFileSync(join(repo.dir, SOURCE), "utf8"), DEAD_TEXT, "the export is not deleted");
});

test("W1-T5278: a missing test file is started with its imports, so the test it carries can run", () => {
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT });
  const pr = applyOnce(repo, stateDir);
  assert.deepEqual(pr?.paths, [SOURCE, TESTS]);
  const head = runTitle(repo.dir);
  assert.match(head, /^# pass 1$/m, head);
});

test("W1-T5278: a test append withdrawn by a concurrent edit restores the deleted export", () => {
  const { repo, stateDir } = fixture({ [SOURCE]: DEAD_TEXT, [TESTS]: SEEDED_TESTS });
  const actions = candidatesFor(repo, stateDir);
  const concurrent = `${SEEDED_TESTS}// concurrent edit\n`;
  const deleted = applyExportDeletions(repo.dir, actions, (target, content, options) => {
    if (target === join(repo.dir, TESTS)) writeAtomic(target, concurrent);
    return writeAtomic(target, content, options);
  });
  assert.deepEqual(deleted, [], "the deletion is not reported as applied");
  assert.equal(readFileSync(join(repo.dir, SOURCE), "utf8"), DEAD_TEXT, "the deleted export is written back");
  assert.equal(readFileSync(join(repo.dir, TESTS), "utf8"), concurrent, "the concurrent edit is preserved");
});
