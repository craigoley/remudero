import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";

function vitestCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-vitest-proof-"));
  mkdirSync(join(dir, "tests", "unit"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(dir, "tests", "unit", "sample.test.ts"),
    'test("site proof title", () => {})\n');
  // A pinned local runner emits the measured Vitest TAP shape. The test exercises the
  // command and its real process boundary without installing dependencies or using a peer repo.
  writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), `
const selected = process.argv[process.argv.indexOf("-t") + 1] === "site proof title";
process.stdout.write("TAP version 13\\n1..1\\nok 1 - tests/unit/sample.test.ts # time=1ms {\\n" +
  "    1..1\\n    ok 1 - site proof title " + (selected ? "# time=1ms" : "# SKIP") + "\\n}\\n");
`);
  return dir;
}

function check(dir: string, title: string, repo = "craigoley/remudero-site"): { code: number; out: string } {
  const original = process.cwd();
  const log = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    process.chdir(dir);
    return { code: checkProofCommand(["unit test:", title, "--repo", repo]),
      out: lines.join("\n") };
  } finally { console.log = log; process.chdir(original); }
}

test("check-proof runs a registered Vitest title without a core test/ corpus", () => {
  const dir = vitestCheckout();
  try {
    assert.equal(existsSync(join(dir, "test")), false, "positive control: only tests/ exists");
    const result = check(dir, "site proof title");
    assert.equal(result.code, CHECK_PROOF_EXIT.pass, result.out);
    assert.match(result.out, /candidates: delegated to the registered Vitest suite root/);
    assert.match(result.out, /argv:.*--reporter=tap -t site proof title tests\//);
    assert.doesNotMatch(result.out, /NOT EXECUTED|test\/\*\*\/\*\.test\.ts/);
    assert.match(result.out, /verdict:\s+pass/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registered Vitest still reports an unmatched title as no-match", () => {
  const dir = vitestCheckout();
  try {
    const result = check(dir, "another title");
    assert.equal(result.code, CHECK_PROOF_EXIT.noMatch, result.out);
    assert.match(result.out, /verdict:\s+no-match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the console's registered Vitest root reaches the same proof executor", () => {
  const dir = vitestCheckout();
  try {
    const result = check(dir, "site proof title", "craigoley/remudero-console");
    assert.equal(result.code, CHECK_PROOF_EXIT.pass, result.out);
    assert.match(result.out, /candidates: delegated to the registered Vitest suite root/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
