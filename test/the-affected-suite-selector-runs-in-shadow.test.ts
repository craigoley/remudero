/**
 * W1-T4404 — one affected-suite selector, run in SHADOW beside every full coverage run.
 *
 * src/lib/affected-suites.ts decides which suites a change affects; CI records, for each file that
 * really failed, whether the selection had it, and `rmd preflight --coverage` reports the same
 * selection from the same function. Nothing is skipped anywhere until that record earns it (W1-T4406).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  changedSymbols,
  defaultAffectedSuitesDeps,
  fullRunTrigger,
  selectAffectedSuites,
  selectAffectedSuitesSafely,
  shadowRecord,
  type AffectedSuitesDeps,
} from "../src/lib/affected-suites.js";
import { affectedSuitesStep } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A small tree: b imports a, a suite imports b, a census suite READS a by path, one is unrelated,
 *  and a suite spawns a script it names by path rather than importing it. */
const TREE: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": 'import { a } from "./a.js";\nexport const b = a + 1;\n',
  "scripts/tool.mjs": "console.log(1);\n",
  "test/b.test.ts": 'import { b } from "../src/b.js";\n',
  "test/census.test.ts": 'readFileSync(new URL("../src/a.ts", import.meta.url), "utf8");\n',
  "test/tool.test.ts": 'spawnSync(process.execPath, [join(ROOT, "scripts", "tool.mjs")]);\n',
  "test/unrelated.test.ts": "export {};\n",
};

function deps(over: Partial<AffectedSuitesDeps> = {}): AffectedSuitesDeps {
  return {
    listFiles: () => Object.keys(TREE),
    readFile: (p) => TREE[p]!,
    // The census's own rule, applied to the fixture: a suite that reads the changed path as text.
    pathReaders: (changed) => Object.keys(TREE).filter((f) => f.endsWith(".test.ts") && changed.some((c) => TREE[f]!.includes(`../${c}"`))),
    ...over,
  };
}

test("W1-T4404: the selector includes callers and path-reading suites of a changed module", () => {
  const sel = selectAffectedSuites(["src/a.ts"], deps());
  assert.equal(sel.fullRun, false);
  // b.test.ts reaches src/a.ts through src/b.ts (and TS's ".js" specifier); census.test.ts reads it.
  assert.deepEqual(sel.suites, ["test/b.test.ts", "test/census.test.ts"]);
  assert.ok(sel.reasons.includes("test/b.test.ts: reaches src/a.ts"));
  assert.ok(sel.reasons.includes("test/census.test.ts: reads a changed file by path"));
  // Falsifier: the import graph alone misses the census suite that greps the changed file.
  assert.deepEqual(selectAffectedSuites(["src/a.ts"], deps({ pathReaders: () => [] })).suites, ["test/b.test.ts"]);
  // A script a suite spawns by a joined path is an edge too; a changed suite selects itself.
  assert.deepEqual(selectAffectedSuites(["scripts/tool.mjs"], deps()).suites, ["test/tool.test.ts"]);
  assert.deepEqual(selectAffectedSuites(["test/unrelated.test.ts"], deps()).suites, ["test/unrelated.test.ts"]);
  // Recent failures stay selected; the narrow candidate swaps the graph for symbol reach.
  const narrow = selectAffectedSuites(["src/a.ts"], deps({ recentFailures: () => ["test/unrelated.test.ts"], symbolSuites: () => ["test/b.test.ts"] }));
  assert.ok(narrow.suites.includes("test/unrelated.test.ts"));
  assert.deepEqual(narrow.narrow, ["test/b.test.ts", "test/census.test.ts", "test/unrelated.test.ts"]);
  // Changed symbols come from the declarations a -U0 diff touches in the new tree.
  const diff = "+++ b/src/b.ts\n@@ -2 +2 @@\n-export const b = a;\n+export const b = a + 1;\n+++ b/docs/x.md\n@@ -1 +1 @@\n";
  assert.deepEqual(changedSymbols(diff, (p) => TREE[p]!), ["b"]);

  // On the REAL tree, with the production deps: a change to src/lib/tmp.ts reaches this very suite.
  const real = selectAffectedSuites(["src/lib/tmp.ts"], defaultAffectedSuitesDeps(REPO_ROOT));
  assert.ok(real.suites.includes("test/the-affected-suite-selector-runs-in-shadow.test.ts"));
  assert.ok(real.suites.length > 100, "a module every suite's tmp helper imports reaches many suites");
});

test("W1-T4404: a config or lockfile change selects the full suite", () => {
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml", "test/helpers/git-repo.ts", "test/fixtures/x.json", ".nvmrc"]) {
    const sel = selectAffectedSuites(["src/a.ts", file], deps());
    assert.equal(sel.fullRun, true, file);
    assert.deepEqual(sel.suites, []);
    assert.match(sel.reasons[0]!, new RegExp(`full run: ${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  }
  // The controls: modelled areas select, they do not force a full run.
  for (const file of ["src/a.ts", "scripts/tool.mjs", "test/b.test.ts", "docs/x.md", "plan/tasks.d/x.yaml", "README.md", "bin/rmd"]) {
    assert.equal(fullRunTrigger([file]), undefined, file);
  }
  // A selector that cannot list its inputs runs everything rather than guessing narrower.
  const broken = selectAffectedSuitesSafely(["src/a.ts"], deps({ listFiles: () => { throw new Error("git ls-files failed"); } }));
  assert.equal(broken.fullRun, true);
  assert.match(broken.reasons[0]!, /could not list its inputs — git ls-files failed/);
  // A file listed but gone (ENOENT) imports nothing; any other read failure is real and forces a full run.
  const gone = (code: string) => (p: string) => {
    if (p === "src/b.ts") throw Object.assign(new Error(`${code} src/b.ts`), { code });
    return TREE[p]!;
  };
  assert.deepEqual(selectAffectedSuites(["src/a.ts"], deps({ readFile: gone("ENOENT") })).suites, ["test/census.test.ts"]);
  assert.match(selectAffectedSuitesSafely(["src/a.ts"], deps({ readFile: gone("EACCES") })).reasons[0]!, /EACCES src\/b\.ts/);
  assert.deepEqual(changedSymbols("+++ b/src/b.ts\n@@ -1 +1 @@\n", gone("ENOENT")), []);
  assert.throws(() => changedSymbols("+++ b/src/b.ts\n@@ -1 +1 @@\n", gone("EACCES")), /EACCES/);
});

test("W1-T4404: shadow mode records each real failure as selected or missed and skips nothing", () => {
  const sel = selectAffectedSuites(["src/a.ts"], deps({ symbolSuites: () => ["test/b.test.ts"] }));
  const record = shadowRecord(sel, ["test/census.test.ts", "test/unrelated.test.ts", "test/census.test.ts"]);
  assert.deepEqual(record.failures, [
    { file: "test/census.test.ts", floor: "selected", narrow: "selected" },
    { file: "test/unrelated.test.ts", floor: "missed", narrow: "missed" },
  ]);
  // A full-run selection misses nothing.
  const full = shadowRecord(selectAffectedSuites(["package.json"], deps()), ["test/unrelated.test.ts"]);
  assert.deepEqual(full.failures, [{ file: "test/unrelated.test.ts", floor: "selected" }]);

  // The real CLI, on the real tree: reads failures from a TAP log and prints the record; exit 0.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4404-`));
  writeFileSync(join(dir, "changed.txt"), "src/lib/tmp.ts\ndocs/comment-standard.md\n");
  writeFileSync(join(dir, "change.diff"), "+++ b/src/lib/tmp.ts\n@@ -1 +1 @@\n");
  writeFileSync(join(dir, "recent.txt"), "test/the-affected-suite-selector-runs-in-shadow.test.ts\n");
  writeFileSync(join(dir, "fail.log"), `not ok 1 - x\n  ---\n  location: '${REPO_ROOT}/test/the-affected-suite-selector-runs-in-shadow.test.ts:1:1'\n  ...\n`);
  const cli = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/select-affected-suites.mjs"), "--changed-files", join(dir, "changed.txt"), "--diff", join(dir, "change.diff"), "--recent-failures", join(dir, "recent.txt"), "--failed-from", join(dir, "fail.log")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /SHADOW — nothing skipped/);
  const json = JSON.parse(/^AFFECTED-SUITES-SHADOW: (.*)$/m.exec(cli.stdout)![1]!);
  // With a diff the narrow candidate is measured too; a recent failure stays in both selections.
  assert.deepEqual(json.failures, [{ file: "test/the-affected-suite-selector-runs-in-shadow.test.ts", floor: "selected", narrow: "selected" }]);
  assert.ok(json.narrowSize > 0 && json.narrowSize <= json.floorSize, `narrow ${json.narrowSize} vs floor ${json.floorSize}`);
  assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /W1-T4404 affected-suite selector/);
  const usage = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/select-affected-suites.mjs")], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(usage.status, 2);

  // In CI the selector runs AFTER the full suite in the coverage step, and its own failure cannot
  // change the step's verdict: drive the real step with a stub node whose selector call fails.
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  const body = doc.jobs["coverage-ratchet"]!.steps.find((s) => s.name?.startsWith("Test with coverage"))!.run!;
  const step = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4404-step-`));
  mkdirSync(join(step, "bin"));
  writeFileSync(
    join(step, "bin", "node"),
    `#!/usr/bin/env bash
echo "$*" >> "${step}/calls.log"
case "$*" in
  *--select-all*) echo "test/x.test.ts" ;;
  *test-with-retry.mjs*) mkdir -p coverage/raw; echo "SF:src/x.ts" > coverage/lcov.info; echo "{}" > coverage/raw/coverage-1.json; echo "# tests 1" ;;
  *select-affected-suites.mjs*) exit 3 ;;
esac
`,
  );
  chmodSync(join(step, "bin", "node"), 0o755);
  writeFileSync(join(step, "changed-files.txt"), "src/lib/tmp.ts\n");
  const mapfileCompat = 'if ! type mapfile >/dev/null 2>&1; then\nmapfile() {\n  local _flag="$1" _name="$2" _line\n  eval "${_name}=()"\n  while IFS= read -r _line; do\n    eval "${_name}+=(\\"${_line}\\")"\n  done\n}\nfi\n';
  writeFileSync(join(step, "run.sh"), mapfileCompat + body.replaceAll("${{ steps.classify.outputs.class }}", "SOURCE").replaceAll("${{ matrix.shard }}", "1"));
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(step, "run.sh")], {
    cwd: step,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(step, "bin")}:${process.env.PATH}`, GITHUB_EVENT_NAME: "pull_request", GITHUB_STEP_SUMMARY: join(step, "summary.md"), RUNNER_TEMP: step },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = readFileSync(join(step, "calls.log"), "utf8").split("\n");
  const fullSuite = calls.findIndex((c) => c.includes("test-with-retry.mjs --coverage-first-pass"));
  const shadow = calls.findIndex((c) => c.includes("select-affected-suites.mjs --changed-files changed-files.txt"));
  assert.ok(fullSuite >= 0 && shadow > fullSuite, "the full suite runs, and the shadow selector only after it");
  assert.match(r.stdout, /the shadow selector itself failed; nothing depends on it/);

  // Preflight reports the same selection and never narrows its own run.
  const pf = affectedSuitesStep(REPO_ROOT, ["package.json"]);
  assert.equal(pf.ok, true);
  assert.match(pf.detail, /would run the FULL suite \(full run: package\.json/);
  const pfBroken = affectedSuitesStep(REPO_ROOT, ["src/a.ts"], deps({ listFiles: () => { throw new Error("no git"); } }));
  assert.equal(pfBroken.ok, true);
  assert.match(pfBroken.detail, /could not list its inputs \(no git\); it would run the FULL suite/);
  assert.match(affectedSuitesStep(REPO_ROOT, ["src/a.ts"], deps()).detail, /would run 2 suite\(s\); this mode still runs everything/);
});
