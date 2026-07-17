import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// Invoke the local jscpd binary directly, not `npx jscpd` — see
// ts-strict-probe.test.ts (same directory) for the general reasoning: keep
// these integration tests' external-tool invocations as direct and
// dependency-free as possible.
const jscpd = fileURLToPath(new URL("../../node_modules/.bin/jscpd", import.meta.url));

// W1-T25 acceptance: "the jscpd duplication threshold BLOCKS a planted
// duplicate — the jscpd gate exits non-zero over a duplicate above
// threshold" / "a below-threshold fixture exits zero."
//
// LIVES IN test/integration/ (see ts-strict-probe.test.ts in this same
// directory for why: excluded from "test:unit", the command
// stryker.conf.mjs's dry run uses, alongside the tsc-shelling probe this
// test shares the directory with — kept together defensively as the same
// risk class of "shells out to an external tool binary", even though the
// specific nested-execution flakiness verified for tsc was not separately
// reproduced here). Still runs under the real per-PR "npm test"
// (test/**/*.test.ts is recursive) and the real per-PR dup-check gate
// (.github/workflows/quality.yml).
function runJscpd(fixtureDir: string) {
  return spawnSync(
    jscpd,
    [".", "--threshold", "3", "--reporters", "silent", "--exit-code"],
    { cwd: fileURLToPath(new URL(`../../fixtures/jscpd/${fixtureDir}`, import.meta.url)), encoding: "utf8" },
  );
}

test("jscpd: a fixture with duplication ABOVE the threshold exits non-zero (the falsifier — a planted duplicate)", () => {
  const result = runJscpd("above-threshold");
  assert.notEqual(result.status, 0, `expected non-zero exit; got ${result.status}\n${result.stdout}\n${result.stderr}`);
});

test("jscpd: a fixture with duplication BELOW the threshold exits zero", () => {
  const result = runJscpd("below-threshold");
  assert.equal(result.status, 0, `expected zero exit; got ${result.status}\n${result.stdout}\n${result.stderr}`);
});

test("jscpd: the real repo-wide config (.jscpd.json) excludes fixtures/** — the fixtures never pollute the actual per-PR scan", () => {
  const result = spawnSync(jscpd, [".", "--config", ".jscpd.json", "--reporters", "silent"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `real repo-wide dup-check should still pass with W1-T25's own additions in place\n${result.stdout}\n${result.stderr}`);
});
