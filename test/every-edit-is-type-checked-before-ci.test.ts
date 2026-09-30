import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  defaultTypeCheckRunner,
  diagnosticKey,
  editTypeCheckFeedback,
  parseTscDiagnostics,
  postToolUseHookOutput,
  type TypeCheckRunner,
} from "../src/lib/containment.js";

const fake =
  (output: string, timedOut = false): TypeCheckRunner =>
  () => ({ output, timedOut });

const hookInput = (cwd: string, file: string) => ({
  tool_name: "Edit",
  tool_input: { file_path: file },
  cwd,
});

/** A throwaway project that uses the repo's real compiler, so the default runner is exercised. */
function project(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t4686-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  symlinkSync(resolve("node_modules/.bin/tsc"), join(dir, "node_modules", ".bin", "tsc"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["src/**/*.ts"] }),
  );
  writeFileSync(join(dir, "src", "a.ts"), source);
  return dir;
}

test("W1-T4686: an edit that introduces a type error returns it to the worker in the same turn", () => {
  const dir = project('export const n: number = "not a number";\n');
  const feedback = editTypeCheckFeedback({ hookInput: hookInput(dir, join(dir, "src", "a.ts")) });
  assert.ok(feedback, "a real type error in the edited file must come back");
  assert.match(feedback, /src\/a\.ts\(1,\d+\): TS2322/);
  const out = JSON.parse(postToolUseHookOutput(feedback));
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /TS2322/);

  // Only the edited file's errors, and only the new ones: a pre-existing error is not re-reported
  // even after an unrelated insertion shifts its line.
  const raw = "src/a.ts(9,1): error TS2322: old\nsrc/b.ts(1,1): error TS2304: elsewhere\nsrc/a.ts(2,1): error TS2304: fresh\n";
  const baseline = new Set([diagnosticKey({ file: "src/a.ts", code: "TS2322", message: "old" })]);
  const scoped = editTypeCheckFeedback({ hookInput: hookInput("/w", "/w/src/a.ts"), baseline, run: fake(raw) });
  assert.ok(scoped);
  assert.match(scoped, /fresh/);
  assert.doesNotMatch(scoped, /old|elsewhere/);
});

test("W1-T4686: an edit with no new error returns nothing", () => {
  const dir = project("export const n: number = 1;\n");
  assert.equal(editTypeCheckFeedback({ hookInput: hookInput(dir, join(dir, "src", "a.ts")) }), null);
  assert.equal(postToolUseHookOutput(null), "");

  const raw = "src/a.ts(9,1): error TS2322: old\n";
  const baseline = new Set([diagnosticKey({ file: "src/a.ts", code: "TS2322", message: "old" })]);
  assert.equal(editTypeCheckFeedback({ hookInput: hookInput("/w", "src/a.ts"), baseline, run: fake(raw) }), null);
  // Errors in other files are not this edit's to fix.
  assert.equal(
    editTypeCheckFeedback({ hookInput: hookInput("/w", "src/a.ts"), run: fake("src/b.ts(1,1): error TS2304: x\n") }),
    null,
  );
  // Fail open: a timed-out check and a non-TypeScript file both say nothing.
  assert.equal(
    editTypeCheckFeedback({ hookInput: hookInput("/w", "src/a.ts"), run: fake("src/a.ts(1,1): error TS2304: x\n", true) }),
    null,
  );
  assert.equal(
    editTypeCheckFeedback({ hookInput: hookInput("/w", "README.md"), run: fake("README.md(1,1): error TS1: x\n") }),
    null,
  );
});

test("W1-T4686: parseTscDiagnostics reads file, position, code and message", () => {
  assert.deepEqual(parseTscDiagnostics("src/a.ts(3,7): error TS2322: Type 'x' is not assignable.\nnoise\n"), [
    { file: "src/a.ts", line: 3, column: 7, code: "TS2322", message: "Type 'x' is not assignable." },
  ]);
});

test("W1-T4686: the default runner reports a missing compiler as clean rather than throwing", () => {
  assert.deepEqual(defaultTypeCheckRunner(mkdtempSync(join(tmpdir(), "rmd-t4686-none-")), 1000), {
    output: "",
    timedOut: false,
  });
});
