import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CENSUS_POPULATION, listRuleSuites, MIN_RULE_SUITE_COUNT } from "../src/lib/ci-parity.js";
import { gitRepo } from "./helpers/git-repo.js";

test("test/a-test-named-like-a-rule-suite-can-declare-it-is-not-one.test.ts", async (t) => {
  const repo = gitRepo({ seedCommit: false, kind: "rule-suite-marker" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "test"));
  const filler = Array.from({ length: MIN_RULE_SUITE_COUNT }, (_, i) => `test/filler-${i}-ratchet.test.ts`);
  for (const path of filler) writeFileSync(join(repo.dir, path), "");
  const path = "test/x-census.test.ts";
  const rosterPath = CENSUS_POPULATION[0]!.testFile;
  const marker = "// @not-a-rule-suite: exercises one function using fixtures\n";
  writeFileSync(join(repo.dir, path), marker);
  writeFileSync(join(repo.dir, rosterPath), marker);
  writeFileSync(join(repo.dir, "test/untracked-baseline.test.ts"), "");
  repo.git("add", "--", ...filler, path, rosterPath);

  await t.test("a reasoned header excludes a name match and preserves roster membership", () => {
    assert.deepEqual(listRuleSuites(repo.dir), [...filler, rosterPath].sort());
  });
  await t.test("the same tracked file without a marker is listed", () => {
    writeFileSync(join(repo.dir, path), "// ordinary test header\n");
    assert.deepEqual(listRuleSuites(repo.dir), [...filler, path, rosterPath].sort());
  });
  await t.test("a marker without a reason throws naming the file", () => {
    for (const header of ["// @not-a-rule-suite:\n", "/* @not-a-rule-suite:  */\n", "// @not-a-rule-suite\n"]) {
      writeFileSync(join(repo.dir, path), header);
      assert.throws(() => listRuleSuites(repo.dir), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        assert.match(error.message, /@not-a-rule-suite.*reason/);
        return true;
      });
    }
  });
  await t.test("block headers allow a reason while body comments and string literals do not opt out", () => {
    for (const header of ["/* @not-a-rule-suite: unit fixture */\n", "\uFEFF\n// preamble\n/**\n * @not-a-rule-suite: unit fixture\n */\n"]) {
      writeFileSync(join(repo.dir, path), `${header}export {};\n`);
      assert.ok(!listRuleSuites(repo.dir).includes(path));
    }
    for (const body of ["export {};\n// @not-a-rule-suite: body comment\n", 'const tag = "@not-a-rule-suite: fixture text";\n']) {
      writeFileSync(join(repo.dir, path), body);
      assert.ok(listRuleSuites(repo.dir).includes(path));
    }
  });
  await t.test("a roster member cannot opt out even with a reasonless marker", () => {
    writeFileSync(join(repo.dir, path), marker);
    writeFileSync(join(repo.dir, rosterPath), "// @not-a-rule-suite:\n");
    assert.deepEqual(listRuleSuites(repo.dir), [...filler, rosterPath].sort());
  });
});
