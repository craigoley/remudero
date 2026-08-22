// test/proof-env-git-config-triple.test.ts — W1-T1096
//
// THE DEFECT THIS CLOSES: `PROOF_ENV_ALLOWLIST` (src/lib/review.ts) names `GIT_CONFIG_COUNT`,
// `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` — index 0 and nothing higher. Before this task,
// `buildProofEnv` copied each allowlisted key present on the parent independently, so a parent
// carrying `GIT_CONFIG_COUNT=2` (or higher) crossed VERBATIM while the pair above index 0 was
// silently dropped. Git reads `GIT_CONFIG_COUNT` first and then demands every
// `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` it names — an unsatisfiable count makes git print
// `missing config key GIT_CONFIG_KEY_1` and exit 128 BEFORE doing any work, which is strictly
// worse than forwarding no count at all (git's no-count fallback is its normal, working
// resolution — see this task's rationale (2)).
//
// This is a pure-function suite over `buildProofEnv` — no git subprocess. A falsifier that
// shelled git to prove a git-config defect would be testing the very thing that is broken (see
// this task's `note:`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProofEnv } from "../src/lib/review.js";

/** A minimal, otherwise-empty parent env carrying only the fields under test, so every
 *  assertion below is about the git-config triple specifically — never diluted by whatever this
 *  process's own `process.env` happens to hold. */
function parentEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin", HOME: "/home/test", ...overrides };
}

test("a parent count larger than the pairs actually forwarded yields a child env carrying none of the three git-config variables", () => {
  const parent = parentEnv({
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Proof Bot",
  });
  const child = buildProofEnv(parent);
  assert.equal(child.GIT_CONFIG_COUNT, undefined, "an unsatisfiable count must not cross — git would exit 128 before running");
  assert.equal(child.GIT_CONFIG_KEY_0, undefined, "the index-0 key must not cross alone once the count it implies is unsatisfiable");
  assert.equal(child.GIT_CONFIG_VALUE_0, undefined, "the index-0 value must not cross alone once the count it implies is unsatisfiable");
});

test("a parent carrying exactly one consistent pair still forwards that pair and its count unchanged", () => {
  const parent = parentEnv({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Proof Bot",
  });
  const child = buildProofEnv(parent);
  assert.equal(child.GIT_CONFIG_COUNT, "1", "a consistent count of exactly 1 must cross unchanged");
  assert.equal(child.GIT_CONFIG_KEY_0, "user.name", "the index-0 key must cross unchanged when the triple is consistent");
  assert.equal(child.GIT_CONFIG_VALUE_0, "Proof Bot", "the index-0 value must cross unchanged when the triple is consistent");
});

test("a parent with a count but no index-zero pair forwards no count rather than an unsatisfiable one", () => {
  const parent = parentEnv({ GIT_CONFIG_COUNT: "1" });
  const child = buildProofEnv(parent);
  assert.equal(child.GIT_CONFIG_COUNT, undefined, "a count with no pair behind it must not cross — forwarding it alone is unsatisfiable");
  assert.equal(child.GIT_CONFIG_KEY_0, undefined);
  assert.equal(child.GIT_CONFIG_VALUE_0, undefined);
});

test("the other allowlisted variables cross unchanged in every one of those cases", () => {
  const cases: NodeJS.ProcessEnv[] = [
    parentEnv({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Proof Bot",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    }),
    parentEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Proof Bot",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    }),
    parentEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }),
  ];
  for (const parent of cases) {
    const child = buildProofEnv(parent);
    assert.equal(child.PATH, parent.PATH, "PATH must cross unchanged regardless of the git-config triple's shape");
    assert.equal(child.HOME, parent.HOME, "HOME must cross unchanged regardless of the git-config triple's shape");
    assert.equal(
      child.GIT_CONFIG_NOSYSTEM,
      parent.GIT_CONFIG_NOSYSTEM,
      "GIT_CONFIG_NOSYSTEM must cross unchanged regardless of the git-config triple's shape",
    );
    assert.equal(
      child.GIT_TERMINAL_PROMPT,
      parent.GIT_TERMINAL_PROMPT,
      "GIT_TERMINAL_PROMPT must cross unchanged regardless of the git-config triple's shape",
    );
  }
});
