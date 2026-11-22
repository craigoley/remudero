/**
 * test/ci/suites/the-coverage-repair-child-runs-without-concurrent-compilation.test.ts — W1-T14306.
 *
 * #20139 gave the coverage shard's runner and file children `--no-concurrent-sparkplug
 * --no-concurrent-recompilation` (NODE_EXIT_DEADLOCK_WORKAROUND_ARGS): on Node 24.22.3 a process.exit after
 * allocation-heavy work can deadlock while a concurrent Sparkplug or Maglev compile job waits for a GC
 * (nodejs/node#64274). scripts/test-with-retry.mjs also starts a REPAIR child, `--rebuild-coverage`, after it
 * drops empty or truncated coverage files and after it drops deleted fixtures' source maps. That child builds
 * the whole coverage summary and then exits through process.exit, the same shape, and it carried neither flag.
 *
 * INVARIANT every-coverage-exit-runs-without-concurrent-compilation: each process the coverage shard starts
 * that ends in process.exit after the coverage summary runs with both workaround flags.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-expect-error — plain .mjs, no declaration file.
import * as tier from "#scripts/test-tier-manifest.mjs";
// @ts-expect-error — plain .mjs, no declaration file.
import * as wrapper from "#scripts/test-with-retry.mjs";

const WRAPPER = join(REPO_ROOT, "scripts", "test-with-retry.mjs");
const FLAGS = tier.NODE_EXIT_DEADLOCK_WORKAROUND_ARGS as readonly string[];
const childArgs = wrapper.rebuildCoverageChildArgs as ((rawDir: string, args: string[]) => string[]) | undefined;

/** The source text of the function declared as `name` in `text`: from its `function` keyword to the next
 *  top-level declaration, which is enough to say which function a call site sits in. */
function enclosingFunction(text: string, at: number): string | undefined {
  const declarations = [...text.slice(0, at).matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)];
  return declarations.at(-1)?.[1];
}

test("W1-T14306 criterion 1: the repair child's argv carries both NODE_EXIT_DEADLOCK_WORKAROUND_ARGS flags, and no --rebuild-coverage spawn in test-with-retry.mjs builds its argv outside rebuildCoverageChildArgs", () => {
  assert.equal(typeof childArgs, "function", "test-with-retry.mjs exports rebuildCoverageChildArgs");
  assert.deepEqual(FLAGS, ["--no-concurrent-sparkplug", "--no-concurrent-recompilation"], "the shard runner's own flags");
  const argv = childArgs!("raw-coverage", ["--test-reporter", "lcov"]);
  assert.deepEqual(argv, [...FLAGS, "--expose-internals", realpathSync(WRAPPER), "--rebuild-coverage", "raw-coverage", "--test-reporter", "lcov"]);
  // Each flag is a V8 option, so it must come before the script path, where node reads its own options.
  const script = argv.indexOf(realpathSync(WRAPPER));
  for (const flag of FLAGS) assert.ok(argv.indexOf(flag) >= 0 && argv.indexOf(flag) < script, `${flag} precedes the script`);

  // Every `--rebuild-coverage` literal in the wrapper is either the argv builder's own or main()'s dispatch
  // on its first argument; a spawn site that spelled its argv inline again would add a third.
  const text = readFileSync(WRAPPER, "utf8");
  const literals = [...text.matchAll(/"--rebuild-coverage"/g)].map((m) => ({
    fn: enclosingFunction(text, m.index),
    line: text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index)).trim(),
  }));
  for (const site of literals) {
    assert.ok(
      site.fn === "rebuildCoverageChildArgs" || /argv\[0\] === "--rebuild-coverage"/.test(site.line),
      `a --rebuild-coverage argv is built outside rebuildCoverageChildArgs, in ${site.fn}: ${site.line}`,
    );
  }
  assert.ok(literals.some((site) => site.fn === "rebuildCoverageChildArgs"), "POSITIVE CONTROL: the scan sees the builder's own literal");
  // Both repair sites spawn through the builder, named so a dropped one says which.
  const spawnSites = [...text.matchAll(/runChild\(process\.execPath, rebuildCoverageChildArgs\(/g)].map((m) => enclosingFunction(text, m.index));
  assert.deepEqual(spawnSites.sort(), ["recoverEmptyCoverage", "repairFixtureSourceMaps"]);
});

test("W1-T14306 criterion 2: the real repair child, spawned with that argv over a raw coverage directory, rebuilds the lcov and exits 0", (t) => {
  assert.equal(typeof childArgs, "function", "test-with-retry.mjs exports rebuildCoverageChildArgs");
  const fixture = ownedFixtureDir(t, "w1t14306-");
  const cwd = fixture.dir;
  const rawDir = join(cwd, "raw");
  const lcov = join(cwd, "lcov.info");
  writeFileSync(join(cwd, "covered.mjs"), "export function covered(n) {\n  return n > 0 ? n : -n;\n}\nconsole.log(covered(-2));\n");
  // A real V8 coverage run of one module, so the child rebuilds from what node itself wrote.
  const covered = spawnSync(process.execPath, ["covered.mjs"], { cwd, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: rawDir } });
  assert.equal(covered.status, 0, covered.stderr);
  assert.ok(readdirSync(rawDir).some((name) => /^coverage-\d+-\d+-\d+\.json$/.test(name)), "node wrote a raw coverage file");

  const args = ["--experimental-test-coverage", "--test-reporter", "lcov", "--test-reporter-destination", lcov];
  const child = spawnSync(process.execPath, childArgs!(rawDir, args), {
    cwd,
    encoding: "utf8",
    env: wrapper.coverageChildEnvironment({ ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: "" }),
  });
  assert.equal(child.status, 0, `the repair child exits 0: ${child.stderr}`);
  assert.ok(existsSync(lcov), "the repair child wrote the lcov");
  const report = readFileSync(lcov, "utf8");
  assert.match(report, /^SF:.*covered\.mjs$/m, "the lcov names the covered module");
  assert.match(report, /^DA:2,1$/m, "and counts the line that ran");
});
