import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: the claim under test IS where a declaration lives and what a module imports, which no
// behaviour of the verb exposes. The verb's behaviour is held by its existing tests, which run untouched.
const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
const daemonSrc = readFileSync(join(REPO_ROOT, "src", "cli", "commands", "daemon.ts"), "utf8");

/** The text of the top-level function starting at `header`, up to its closing brace in column 0. */
function topLevelFunction(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${header} closes`);
  return source.slice(start, end + 2);
}

test("W1-T9333: daemonCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(daemonSrc, /^export async function daemonCommand\(/m, "the module declares the handler");
  const body = topLevelFunction(daemonSrc, "export async function daemonCommand(");
  assert.ok(body.split("\n").length > 1000, "the module holds the real body, not a stub");
  assert.match(daemonSrc, /^export interface DaemonCommandHost \{/m, "the collaborators arrive through a host");

  const wrapper = topLevelFunction(runTaskSrc, "export async function daemonCommand(");
  assert.ok(wrapper.split("\n").length < 12, `run-task.ts keeps a thin function, got ${wrapper.split("\n").length} lines`);
  assert.match(wrapper, /return daemonCommandFromModule\(rest, deps, daemonCommandHost\(\)\)/, "and it delegates through the host");
  assert.match(runTaskSrc, /import \{ daemonCommand as daemonCommandFromModule, /, "under the FromModule alias");
  assert.equal(runTaskSrc.match(/^(?:export )?(?:async )?function daemonCommand\(/gm)?.length, 1, "defined once in run-task.ts");
});

test("W1-T9333: the daemon module imports nothing from src/run-task.ts", () => {
  const specifiers = [...daemonSrc.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
  assert.ok(specifiers.length > 10, "the module's imports were read");
  const offending = specifiers.filter((s) => /(^|\/)run-task(\.[jt]s)?$/.test(s));
  assert.deepEqual(offending, [], "cli-no-run-task: a verb module takes run-task.ts symbols through its host");
});
