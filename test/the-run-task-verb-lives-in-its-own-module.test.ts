import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this task proves declaration ownership and import direction.
function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function topLevelFunction(text: string, header: string): string {
  const start = text.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const closing = /\n\}(?:[ \t]*\/\/[^\n]*)?(?:\n|$)/.exec(text.slice(start));
  assert.ok(closing, `${header} closes`);
  return text.slice(start, start + closing.index + closing[0].length);
}

test("W1-T9332: runTask is defined in its module and src/run-task.ts only delegates to it", () => {
  const entry = source("src/run-task.ts");
  const module = source("src/cli/commands/run-task-verb.ts");
  assert.match(module, /^export interface RunTaskCommandHost \{/m);
  for (const [name, minimumLines] of [["runTask", 500], ["runTaskBody", 2000]] as const) {
    const implementation = topLevelFunction(module, `export async function ${name}(`);
    assert.ok(implementation.split("\n").length > minimumLines, `${name} has its implementation`);
    const header = name === "runTask" ? "async function runTask(" : "export async function runTaskBody(";
    const wrapper = topLevelFunction(entry, header);
    assert.ok(wrapper.split("\n").length < 12, `${name} keeps a thin wrapper`);
    assert.match(wrapper, new RegExp(`return ${name}FromModule\\(`));
    assert.match(wrapper, /runTaskCommandHost\(\)/);
    assert.match(entry, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(entry.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "gm"))?.length, 1);
  }
});

test("W1-T9332: the run-task module imports nothing from src/run-task.ts", () => {
  const module = source("src/cli/commands/run-task-verb.ts");
  const imports = [...module.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(imports.length > 10, "the module imports its library collaborators directly");
  assert.deepEqual(imports.filter((path) => /(^|\/)run-task(?:\.[jt]s)?$/.test(path)), []);
});
