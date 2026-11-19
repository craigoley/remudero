// W1-T13753: a name-filtered Vitest proof runs the file that holds its title, not the diff's own test file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execWhitelistedProof, parseWhitelistedProof } from "#src/lib/review.js";

test("W1-T13753 criterion 1: a guard proof naming another file's title runs that file, not the diff's own", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-guard-scope-"));
  try {
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "// fixture\n");
    writeFileSync(join(dir, "tests", "unit", "new-task.test.ts"), 'test("NEW-T2 criterion 1", () => {})\n');
    writeFileSync(join(dir, "tests", "unit", "earlier-task.test.ts"), 'test("OLD-T1 criterion 1: the guarded behavior", () => {})\n');
    const proof = parseWhitelistedProof("unit test: OLD-T1 criterion 1", { owner: "craigoley", repo: "remudero-console" })!;
    proof.diffTestFiles = ["tests/unit/new-task.test.ts"];
    let selected: readonly string[] = [];
    const outcome = execWhitelistedProof(proof, dir, 1000, (_command, args) => {
      selected = args;
      return args.includes("tests/unit/earlier-task.test.ts")
        ? "TAP version 13\n1..1\nok 1 - tests/unit/earlier-task.test.ts # time=1ms {\n    ok 1 - OLD-T1 criterion 1: the guarded behavior # time=1ms\n}\n"
        : "TAP version 13\n1..1\nok 1 - tests/unit/new-task.test.ts # time=1ms {\n    1..0\n}\n";
    }, { preflightBrowsers: () => {} });
    assert.deepEqual(selected.filter((arg) => arg.endsWith(".test.ts")), ["tests/unit/earlier-task.test.ts"]);
    assert.equal(outcome, "pass");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
