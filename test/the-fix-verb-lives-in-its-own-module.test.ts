import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this extraction's subject is declaration ownership and import direction.
const runTaskSrc = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
const modulePath = join(REPO_ROOT, "src/cli/commands/fix.ts");
const fixSrc = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";

function topLevelFunction(source: string, name: string, declaration = "export async function"): string {
  const header = `${declaration} ${name}(`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${header} closes`);
  return source.slice(start, end + 2);
}

test("W1-T9337: runFixRung is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(fixSrc, /^export interface FixCommandHost \{/m);
  for (const [name, minimumLines] of [["runFixRung", 3000], ["fixCommand", 150]] as const) {
    const body = topLevelFunction(fixSrc, name);
    assert.ok(body.split("\n").length > minimumLines, `${name} has its real body in the module`);
    const wrapper = topLevelFunction(runTaskSrc, name);
    assert.ok(wrapper.split("\n").length < 12, `${name} keeps a thin wrapper`);
    assert.match(wrapper, new RegExp(`return ${name}FromModule\\(`));
    assert.match(wrapper, /fixCommandHost\(\)/);
    assert.match(runTaskSrc, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(runTaskSrc.match(new RegExp(`^export async function ${name}\\(`, "gm"))?.length, 1);
  }
  const requeueWrapper = topLevelFunction(runTaskSrc, "requeueActionsJobOutcome", "export function");
  const requeueImplementation = topLevelFunction(fixSrc, "requeueActionsJobOutcome", "function");
  assert.doesNotMatch(requeueWrapper, /\bghExec\b/, "the wrapper leaves the synchronous default in its source owner");
  assert.match(requeueImplementation, /\bexec\s*:[^\n]*=\s*ghExec\s*,/, "the module retains the real executor default");
  assert.match(requeueWrapper, /return fixCommandHelpers\(fixCommandHost\(\)\)\.requeueActionsJobOutcome\(/);
});

test("W1-T9337: the fix module imports nothing from src/run-task.ts", () => {
  const specifiers = [...fixSrc.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 10, "the module's imports were read");
  assert.deepEqual(specifiers.filter((s) => /(^|\/)run-task(?:\.[jt]s)?$/.test(s!)), []);
});

