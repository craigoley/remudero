import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execWhitelistedProof, nameFilteredOutcome, resolveNameFilteredCandidates, type WhitelistedProof } from "#src/lib/review.js";

test("native named proofs require an executed result without skip or pending directives", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-directives-"));
  const cases = [
    ["skip-option", "test('proof boundary',{skip:'missing prerequisite'},()=>{throw Error('must never execute')});", "no-match"],
    ["skip-context", "test('proof boundary',t=>{t.skip('missing prerequisite')});", "no-match"],
    ["todo-success", "test('proof boundary',{todo:'pending implementation'},()=>{});", "no-match"],
    ["todo-failure", "test('proof boundary',{todo:'pending implementation'},()=>{throw Error('pending')});", "no-match"],
    ["executed-pass", "test('proof boundary',()=>{});", "pass"],
    ["executed-failure", "test('proof boundary',()=>{throw Error('real assertion failed')});", "fail"],
    ["literal-hash-name", "test('proof boundary # SKIP is only a title',()=>{});", "pass"],
    ["skipped-suite", "describe('proof boundary',{skip:'missing prerequisite'},()=>{test('child',()=>{throw Error('must never execute')})});", "no-match"],
  ] as const;
  try {
    for (const [name, body, expected] of cases) {
      const file = join(dir, name + ".test.mjs");
      writeFileSync(file, "import{test,describe}from'node:test';" + body + "\n");
      // Explicit minimal env avoids recursive test context and shares no provider credentials.
      const child = spawnSync(process.execPath, ["--max-old-space-size=512", "--test", "--test-reporter=tap", "--test-concurrency=1",
        "--test-timeout=5000", "--test-name-pattern=^proof boundary", file], {
        cwd: dir, encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024,
        env: { PATH: process.env.PATH, TMPDIR: dir, NODE_OPTIONS: process.env.NODE_OPTIONS },
      });
      assert.equal(child.error, undefined, name);
      assert.equal(child.signal, null, name);
      assert.equal(child.status, name === "executed-failure" ? 1 : 0, child.stdout + child.stderr);
      assert.match(child.stdout, /^# tests \d+$/m);
      assert.match(child.stdout, /^# duration_ms /m);
      assert.equal(nameFilteredOutcome(child.stdout, child.stderr), expected, name + "\n" + child.stdout);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unqualified named proof output remains inconclusive until the native summary", () => {
  assert.throws(() => nameFilteredOutcome("ok 1 - proof boundary # SKIP missing prerequisite\n"), /truncated/);
  assert.throws(() => nameFilteredOutcome("not ok 1 - proof boundary # TODO pending\n"), /truncated/);
});

test("unqualified results cannot hide a real named proof failure or reject an escaped title", () => {
  const skipped = "ok 1 - skipped proof # SKIP missing prerequisite\n";
  const pending = "not ok 2 - pending proof # TODO incomplete\n";
  const summary = "# duration_ms 1\n";
  assert.equal(nameFilteredOutcome(skipped + pending + summary), "no-match");
  assert.equal(nameFilteredOutcome(skipped + "ok 3 - executed proof\n" + summary), "pass");
  assert.equal(nameFilteredOutcome(skipped + "not ok 3 - real failure\n" + summary), "fail");
  assert.equal(nameFilteredOutcome("ok 1 - real \\# SKIP title\n" + summary), "pass");
  assert.equal(nameFilteredOutcome("ok 1 - real \\# TODO title\n" + summary), "pass");
});

test("the maintained proof executor cannot accept a skipped or pending native named test", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-executor-directives-"));
  const file = "test/directives.test.ts";
  mkdirSync(join(dir, "test"));
  const cases = [
    ["{skip:'prerequisite unavailable'}", "throw Error('must never execute')", "no-match"],
    ["{}", "t.skip('prerequisite unavailable')", "no-match"],
    ["{todo:'pending implementation'}", "", "no-match"],
    ["{todo:'pending implementation'}", "throw Error('pending')", "no-match"],
    ["{}", "", "pass"],
    ["{}", "throw Error('real failure')", "fail"],
  ] as const;
  try {
    for (const [options, behavior, expected] of cases) {
      writeFileSync(join(dir, file), "import{test}from'node:test';test('proof boundary'," + options + ",t=>{" + behavior + "});\n");
      assert.deepEqual(resolveNameFilteredCandidates(dir, "proof boundary"), { status: "resolved", files: [file] });
      // Native syntax needs no install or copied setup. The real default spawner, candidate
      // resolver, inline completeness judge, child environment and verdict classifier all run.
      const proof: WhitelistedProof = { kind: "test", command: process.execPath, label: "proof boundary", nameFiltered: true,
        args: ["--max-old-space-size=512", "--experimental-strip-types", "--test", "--test-reporter=tap",
          "--test-concurrency=1", "--test-name-pattern", "^proof boundary", "test/**/*.test.ts"] };
      assert.equal(execWhitelistedProof(proof, dir, 5000), expected, options + " " + behavior);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
