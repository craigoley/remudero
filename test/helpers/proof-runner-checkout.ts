import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "../../src/lib/tmp.js";

/**
 * The two checkout shapes W1-T3312's suite drives `ensureDeps` over.
 *
 * THEY LIVE UNDER test/helpers/ FOR A MEASURED REASON, not for tidiness. The fixture-copy census
 * counts distinct repo-builder function names across `test/*.test.ts` NON-RECURSIVELY, and refused
 * this PR at `repoBuilderFunctionNames: 71 > baseline 70`. `test/helpers/*.ts` is outside that
 * population by design, and sharing a builder is the census's own remedy rather than a baseline
 * bump — which is doubly unavailable here, because `scripts/fixture-copy-baseline.json` is on
 * INSTRUMENT_SURFACE and this PR changes `src/lib/review.ts`, so raising it would trip Standing
 * rule 25 as well.
 */

/** A checkout that has a `package.json` and nothing else — the "no node_modules at all" shape. */
export function checkoutWithPackage(): string {
  const cwd = makeTempDir("w1t3312-checkout-");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  return cwd;
}

/** The worker's normal linked-worktree shape: `node_modules` EXISTS as a symlink but the target
 *  lacks the dependency. Deliberately empty — no test here relies on a package manager or network. */
export function absentRunnerCheckout(): string {
  const cwd = checkoutWithPackage();
  const shared = makeTempDir("w1t3312-shared-node-modules-");
  symlinkSync(shared, join(cwd, "node_modules"), "dir");
  return cwd;
}
