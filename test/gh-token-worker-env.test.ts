import assert from "node:assert/strict";
import { test } from "node:test";

import { billingMode, buildWorkerEnv, isBillingClean } from "../src/lib/env.js";

/**
 * `GH_TOKEN` ON THE WORKER ALLOWLIST — parity with the macOS worker, which already holds this
 * credential as a FILE.
 *
 * THE ASYMMETRY THIS CLOSES: `WORKER_HOME_SYMLINKS` (worker-home.ts) symlinks `~/.config/gh` into
 * every per-run worker HOME "so a worker can open/merge PRs". A container stores the same secret in
 * `$GH_TOKEN` instead, which this allowlist stripped — so the file form was granted and the
 * variable form denied, with nothing logging either. Measured before the fix: `GH_TOKEN` reached
 * the child env as `false` while the worker was being told to `git push` and `gh pr create`.
 *
 * BOTH DIRECTIONS, because the thing being changed is a SECURITY BOUNDARY: the token must reach a
 * worker that has one, must never be invented for a worker that does not, and the `ANTHROPIC_*`
 * refusal that makes this allowlist a billing boundary must still fire exactly as before.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every value below is an obvious fake.
 */

const FAKE_GH = "gho_FAKE_NOT_A_REAL_TOKEN_0000000000000000";

/** The production call shape: `spawnWorker` always passes `home` and `shell` from config. */
function productionEnv(parent: NodeJS.ProcessEnv) {
  return buildWorkerEnv({}, parent, { home: "/opt/rmd/worker-home-run1", shell: "/bin/bash" });
}

test("GH_TOKEN reaches the worker child through the production call shape", () => {
  const child = productionEnv({ PATH: "/usr/bin", HOME: "/home/node", GH_TOKEN: FAKE_GH });
  assert.equal(child.GH_TOKEN, FAKE_GH, "a container worker must carry the GitHub credential it is told to use");
});

test("nothing is invented: a parent with no GH_TOKEN yields a child with no GH_TOKEN", () => {
  // The other direction of the grant. An allowlist COPIES; it must never synthesise a credential,
  // or a macOS run (where the credential is a file, not a variable) would grow a phantom one.
  const child = productionEnv({ PATH: "/usr/bin", HOME: "/home/node" });
  assert.equal("GH_TOKEN" in child, false, "absent in the parent must stay absent in the child");
});

test("GH_TOKEN does NOT weaken the ANTHROPIC_* refusal — a stray ANTHROPIC_ key still throws", () => {
  // THE LOAD-BEARING SAFETY ASSERTION. This allowlist is the billing boundary, and its guarantee is
  // that no ANTHROPIC_* key except the sanctioned valve survives. Admitting a GitHub token must not
  // relax that, so the refusal is driven WITH a GH_TOKEN present.
  assert.throws(
    () => buildWorkerEnv({ ANTHROPIC_BASE_URL: "https://not-anthropic.example" }, { PATH: "/usr/bin", HOME: "/h", GH_TOKEN: FAKE_GH }),
    /ANTHROPIC/i,
    "a contaminating ANTHROPIC_* key must still fail loud at the boundary",
  );
});

test("GH_TOKEN never flips billing_mode, and leaves the child billing-clean", () => {
  const child = productionEnv({ PATH: "/usr/bin", HOME: "/home/node", GH_TOKEN: FAKE_GH });
  // `billingMode` keys off the sanctioned ANTHROPIC_API_KEY alone; a GitHub token is not a billing
  // signal and must not read as one.
  assert.equal(billingMode(Object.keys(child)), "subscription", "a GitHub token must never make a run bill to API");
  assert.equal(isBillingClean(child), true, "the child carries zero ANTHROPIC_* keys");
});

test("the ANTHROPIC_ pattern itself does not match GH_TOKEN — run, not read", () => {
  // CLAUDE.md's discipline: verify a pattern by executing it. A silent match here would mean the
  // new entry could never survive the assertion above, and the grant would be dead code.
  const ANTHROPIC_KEY = /^ANTHROPIC_/i;
  assert.equal(ANTHROPIC_KEY.test("GH_TOKEN"), false, "GH_TOKEN must not match the billing-boundary pattern");
  assert.equal(ANTHROPIC_KEY.test("ANTHROPIC_API_KEY"), true, "and the pattern must still match what it is for");
  assert.equal(ANTHROPIC_KEY.test("anthropic_base_url"), true, "including case-insensitively");
});
