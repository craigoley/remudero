/**
 * WHY THIS FILE EXISTS. The open-weight lane's fixed `unit_test` check shipped as
 * `node --import tsx --test`, while package.json's `test` and `test:ci` load a SECOND import,
 * test/setup/tmp-hygiene.ts, which installs the temp-dir reaper and the no-live-remote guards.
 * Nothing compared the two, so the lane ran the whole suite with every fixture unguarded.
 *
 * This reads the import chain OUT OF package.json rather than restating it, so a guard added to
 * the scripts later reddens here until the check carries it too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// A NAMESPACE import, so the file still LOADS on a tree without the shared constant and fails by
// assertion there: a load error would read as an environment gap, not a red.
import * as workerProvider from "../src/lib/worker-provider.js";

const { OPENWEIGHT_CHECKS } = workerProvider;

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The `--import <specifier>` values an argv carries, in load order. */
function importsOf(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--import" && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
    else if (argv[i]!.startsWith("--import=")) out.push(argv[i]!.slice("--import=".length));
  }
  return out;
}

function scriptImports(name: string): string[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = pkg.scripts[name];
  assert.ok(script, `package.json must declare a ${name} script`);
  return importsOf(script.split(/\s+/));
}

test("the open-weight unit_test check loads every import the test:ci script loads, in order", () => {
  const ci = scriptImports("test:ci");
  // A census over an empty chain compares nothing: the guard import must be there to be matched.
  assert.ok(ci.length >= 2, `test:ci must carry tsx and the setup import, got ${JSON.stringify(ci)}`);
  assert.ok(ci.includes("./test/setup/tmp-hygiene.ts"), "test:ci must load the suite's setup guards");
  assert.deepEqual(scriptImports("test"), ci, "test and test:ci must load the same setup chain");

  assert.deepEqual(importsOf(OPENWEIGHT_CHECKS["unit_test"]!), ci);
  const shared = (workerProvider as { TEST_PROCESS_GUARD_IMPORTS?: readonly string[] }).TEST_PROCESS_GUARD_IMPORTS ?? [];
  assert.deepEqual(importsOf(shared), ci);
  assert.equal(shared.length, 2 * ci.length, "the shared chain carries only --import pairs");
});

test("every relative import the open-weight unit_test check loads resolves from the worktree root", () => {
  // The sandbox runs the check with `--chdir <worktree>`, so a `./` specifier resolves there.
  const relative = importsOf(OPENWEIGHT_CHECKS["unit_test"]!).filter((s) => s.startsWith("./"));
  assert.ok(relative.length > 0, "the check must load at least one repo-relative setup file");
  for (const specifier of relative) {
    assert.ok(existsSync(join(repoRoot, specifier)), `${specifier} must exist at the repo root`);
  }
});
