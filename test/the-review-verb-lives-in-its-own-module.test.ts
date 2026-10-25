import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: declaration ownership and import direction are this extraction's contract.
// @census-reads: src/run-task.ts src/cli/commands/review.ts
function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function functionSource(text: string, name: string): string {
  const start = text.search(new RegExp(`^(?:export )?async function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `${name} is declared`);
  const end = /\n\}(?:\n|$)/.exec(text.slice(start));
  assert.ok(end, `${name} closes`);
  return text.slice(start, start + end.index + 2);
}

test("W1-T9339: reviewCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  const entry = source("src/run-task.ts");
  const module = source("src/cli/commands/review.ts");
  assert.match(module, /^export interface ReviewCommandHost \{/m);
  for (const name of ["reviewCommand", "runReview"]) {
    const implementation = functionSource(module, name);
    assert.ok(implementation.split("\n").length > 500, `${name} owns its implementation`);
    const wrapper = functionSource(entry, name);
    const delegation = new RegExp(`\\{\\n  return ${name}FromModule\\(reviewCommandHost\\(\\), [^\\n]+\\);\\n\\}$`);
    assert.match(wrapper, delegation, `${name} has only the delegation in its body`);
    assert.match(entry, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(entry.match(new RegExp(`^(?:export )?async function ${name}\\(`, "gm"))?.length, 1);
  }
});

test("W1-T9339: the review module imports nothing from src/run-task.ts", () => {
  const module = source("src/cli/commands/review.ts");
  const imports = [...module.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  assert.ok(imports.length > 0, "the module imports its collaborators");
  assert.deepEqual(imports.filter((path) => /(^|\/)run-task(?:\.[jt]s)?$/.test(path)), []);
});
