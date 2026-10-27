import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import * as shapes from "../scripts/lib/git-spawn-shapes.mjs";

const SKILL = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const CENSUS = "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts";
const SOURCE = "src/lib/sweep-plan.ts";
const BASE = 'export function status(dir: string) {\n  return dir;\n}\n';

function joined(head: string, base: string = BASE, changed: string[] = [SOURCE]): string[] {
  const runs: string[][] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed,
    readHead: (path: string) => (path === SOURCE ? head : null),
    readBase: (path: string) => (path === SOURCE ? base : null),
    loadMembers: () => [],
    runSuites: (files: string[]) => { runs.push(files); return []; },
  });
  assert.equal(result.unmeasured, null);
  const selected = runs.flat();
  assert.equal(selected.filter((file) => file === SKILL).length, changed.length > 0 ? 1 : 0,
    "the mandatory skill census is selected independently of git-spawn detection");
  return selected.filter((file) => file !== SKILL);
}

test("unit test: test/the-local-precheck-runs-the-git-leaf-suite-on-any-git-spawn.test.ts — joins an unlisted positional -C, a cwd-option spawn and a run(\"git\") helper; nothing for a diff with no git spawn", () => {
  const positional = BASE + 'const args = ["-C", someOtherDir, "status"];\n';
  const cwdOption = BASE + 'spawnSync("git", ["status"], { cwd: dir });\n';
  const helper = BASE + 'const out = run("git", ["rev-parse", "HEAD"]);\n';
  for (const [name, head] of [["positional -C", positional], ["cwd option", cwdOption], ["helper call", helper]] as const) {
    assert.deepEqual(joined(head), [CENSUS], `${name} must join the git-leaf suite`);
  }
  assert.deepEqual(joined(BASE + "export const unrelated = 1;\n"), [], "a src diff adding no git spawn joins nothing");
  assert.deepEqual(joined(BASE + 'super("git", "failed");\n'), [], "super(\"git\", …) is not a spawn");
  assert.deepEqual(joined(positional, positional), [], "a pre-existing spawn is not an added one");
});

test("unit test: test/the-local-precheck-runs-the-git-leaf-suite-on-any-git-spawn.test.ts — the leaf, the census and the shared shapes joining by path", () => {
  for (const path of ["src/lib/worktree-git.ts", CENSUS, "scripts/lib/git-spawn-shapes.mjs"]) {
    assert.deepEqual(joined(BASE, BASE, [path]), [CENSUS], path);
  }
});

test("unit test: test/the-local-precheck-runs-the-git-leaf-suite-on-any-git-spawn.test.ts — the shared shapes count a positional -C and a git call, once each", () => {
  const text = 'a(["-C", x]); b("git", []);';
  assert.equal(shapes.gitSpawnShapeMatches(text).length, 2);
});

test("unit test: test/the-local-precheck-runs-the-git-leaf-suite-on-any-git-spawn.test.ts — reports unmeasured rather than skipping when the census detector cannot be loaded", () => {
  const entry = precheck.PRECHECK_TRIGGERED_SUITES.find((m: { script: string }) => m.script === "census:host-worktree-git");
  const original = entry.trigger;
  let runs = 0;
  try {
    entry.trigger = (input: unknown) => precheck.gitSpawnTrigger(input, () => { throw new Error("cannot load git-spawn-shapes"); });
    const result = precheck.evaluateAdmittedCensusSuites({
      changed: [SOURCE],
      readHead: () => BASE + 'spawnSync("git", ["status"], { cwd: dir });\n',
      readBase: () => BASE,
      loadMembers: () => [],
      runSuites: () => { runs += 1; return []; },
    });
    assert.deepEqual(result.violations, []);
    assert.match(result.unmeasured, /cannot load git-spawn-shapes/);
    assert.equal(runs, 0);
  } finally {
    entry.trigger = original;
  }
});
