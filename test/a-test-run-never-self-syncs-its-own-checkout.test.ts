import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCliFreshness, testRunnerOnItsOwnCheckout } from "../src/lib/self-sync.js";
import { makeTempDir } from "../src/lib/tmp.js";

// 2026-10-09: on a Mac, a local run of test/cli-verbs-mint-the-app-token.test.ts drove the real
// main(), whose CLI freshness check fetched origin, fast-forwarded the checkout under test (twice in
// one full-suite run) and re-executed the test process with RMD_SELF_SYNC_DONE=1, which the test
// setup refuses. The suite then failed with "generated asynchronous activity after the test ended".
// CI never reached that path only because its CI=true guard fires first.

const OWN_CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

test("under the test runner, the CLI freshness check on its own checkout is guarded: no fetch, no fast-forward, no re-exec", () => {
  let reexecs = 0;
  const said: string[] = [];
  // No CI variables in the injected env, so only the test-runner guard can stop the real git.
  const result = checkCliFreshness(OWN_CHECKOUT, {}, {
    reexec: () => { reexecs += 1; },
    say: (msg) => said.push(msg),
    warn: (msg) => said.push(msg),
  });
  assert.deepEqual(result, { status: "guarded" });
  assert.equal(reexecs, 0);
  assert.deepEqual(said, []);
});

test("the guard names only the running checkout under the node test runner", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "positive control: this file runs under node --test");
  assert.equal(testRunnerOnItsOwnCheckout(OWN_CHECKOUT), true);
  assert.equal(testRunnerOnItsOwnCheckout(`${OWN_CHECKOUT}/.`), true, "the same tree by another spelling");
  const elsewhere = makeTempDir("own-checkout");
  try {
    assert.equal(testRunnerOnItsOwnCheckout(elsewhere), false, "a fixture repository is still synced for real");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
  assert.equal(testRunnerOnItsOwnCheckout(OWN_CHECKOUT, {}), false, "an operator's rmd is never guarded by it");
});

test("an injected git on the running checkout still reaches the real freshness logic", () => {
  const sha = "a".repeat(40);
  const git = (args: string[]): string => (args[0] === "rev-parse" ? `${sha}\n` : "");
  assert.deepEqual(checkCliFreshness(OWN_CHECKOUT, {}, { git }), { status: "up-to-date" });
});
