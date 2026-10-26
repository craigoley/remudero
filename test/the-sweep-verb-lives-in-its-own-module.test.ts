import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this extraction's subject is declaration ownership and import direction.
const runTaskSrc = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
const modulePath = join(REPO_ROOT, "src/cli/commands/sweep.ts");
const sweepSrc = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";

function topLevelFunction(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${header} closes`);
  return source.slice(start, end + 2);
}

test("W1-T9338: sweepCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(sweepSrc, /^export interface SweepCommandHost \{/m);
  for (const [name, declaration, minimumLines] of [
    ["sweepCommand", "export async function", 100],
    ["buildSweepEffects", "export function", 300],
    ["buildSweepHook", "export function", 250],
    ["buildSweepLightHook", "export function", 150],
  ] as const) {
    const header = `${declaration} ${name}(`;
    const implementation = topLevelFunction(sweepSrc, header);
    assert.ok(implementation.split("\n").length > minimumLines, `${name} holds its real body`);
    const wrapper = topLevelFunction(runTaskSrc, header).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const bodyStart = wrapper.lastIndexOf(" {\n");
    assert.notEqual(bodyStart, -1, `${name} has a function body`);
    const body = wrapper.slice(bodyStart + 3).trim();
    assert.match(body, new RegExp(`^return ${name}FromModule\\(sweepCommandHost\\([^;]+;\\s*\\}$`));
    assert.equal(body.split("\n").filter((line) => line.trim()).length, 2, `${name} only delegates`);
    assert.match(runTaskSrc, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(runTaskSrc.match(new RegExp(`^${declaration} ${name}\\(`, "gm"))?.length, 1);
  }
});

test("W1-T9338: the sweep module imports nothing from src/run-task.ts", () => {
  const specifiers = [...sweepSrc.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1]!);
  assert.ok(specifiers.length > 10, "the module's imports were read");
  assert.deepEqual(specifiers.filter((specifier) => /(^|\/)run-task(?:\.[jt]s)?$/.test(specifier)), []);
});
