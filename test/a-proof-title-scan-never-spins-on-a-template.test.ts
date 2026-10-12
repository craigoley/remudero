// 2026-10-08 21:25Z: the core daemon's event loop pinned at 95% CPU for 77+ minutes inside a fix round's
// commit. declaresProofTitle (src/run-task.ts) scanned a worker's test file whose template literal held
// `${prefix}\n## Acceptance`; without re-scanning the template after `}`, `##` scanned as a zero-length
// PrivateIdentifier and the loop never advanced. The scan runs in a child with a hard timeout here, because
// a synchronous spin would block this process's own test timeout too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const RUN_TASK = pathToFileURL(join(process.cwd(), "src", "run-task.ts")).href;

function scan(content: string, titles: string[]): { status: number | null; signal: string | null; out: string; err: string } {
  const { NODE_TEST_CONTEXT: _omit, ...env } = process.env;
  const code = `const m = await import(${JSON.stringify(RUN_TASK)}); process.stdout.write(String(m.declaresProofTitle(${JSON.stringify(content)}, ${JSON.stringify(titles)})));`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", env, timeout: 10_000 });
  return { status: run.status, signal: run.signal, out: run.stdout, err: run.stderr.slice(-400) };
}

const HANG = 'for (const prefix of ["<!-- note"]) {\n  const body = `${prefix}\\n## Acceptance\\n${REAL}`;\n  assert.ok(body);\n}\n';

test("a proof-title scan finishes on a template whose text holds ## after an expression, and still finds a real title", () => {
  const stuck = scan(HANG, ["anything"]);
  assert.equal(stuck.signal, null, `the scan must terminate, not be killed by the timeout: ${stuck.err}`);
  assert.equal(stuck.out, "false");

  const found = scan(`${HANG}test("the real title", () => {});\n`, ["the real title"]);
  assert.equal(found.signal, null, found.err);
  assert.equal(found.out, "true", "a title declared after the template is still found");

  const inTemplate = scan('const t = `${a} test("only text", () => {})`;\n', ["only text"]);
  assert.equal(inTemplate.out, "false", "a title inside a template's text is not a declaration");
});
