/**
 * W1-T9703 — THE GARDEN MINT'S RESERVATION CHILD IS BOUNDED BY LOOP-AVAILABLE TIME.
 *
 * `ciLearningTaskIdMinter(...).async` used to race its child against a wall-clock setTimeout that called
 * `controller.abort()`, then re-checked `performance.now()` after a SUCCESS, so a held loop turned a reservation
 * the child had already made into a GardenMintTimedOutError. The child alone is awaited now; the default
 * executeAsync arms the loop-available bound (src/lib/loop-bounded-child.ts). These drive the real default
 * executeAsync with real children: a NODE_OPTIONS preload stands in for the reservation work the child would do.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { GardenMintBudget, GardenMintTimedOutError } from "#src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ciLearningTaskIdMinter } from "#src/run-task.js";

const SHA = "b".repeat(40);

/** Holds the event loop the way the daemon's synchronous spawns did. */
function holdLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* held */ }
}

/** Runs the spawned reservation child through `preload` instead of its own reservation work. */
function withChildPreload(t: TestContext, preloadSource: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-mint-held-`));
  const preload = join(root, "reservation-child.mjs");
  writeFileSync(preload, preloadSource);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("W1-T9703: a held loop never turns a finished garden mint into a timeout", async (t) => {
  // The child prints its reservation and exits at once.
  const root = withChildPreload(t, `process.stdout.write(JSON.stringify({ id: "W1-T9001", sha: "${SHA}", rows: [] }));
    process.exit(0);`);
  const budget = new GardenMintBudget(() => 300);
  const mint = ciLearningTaskIdMinter(root, undefined, undefined, { budget });
  const pending = mint.async("fixture");
  holdLoop(1200); // four times the bound, with the child's exit and stdout still unread
  assert.equal(await pending, "W1-T9001", "the id the child reserved is returned");
  assert.equal(mint.heldSha("W1-T9001"), SHA, "and held, so a refused filing can still release it");
  assert.ok(budget.boundMs() > 0 && budget.boundMs() !== 300, "the finished mint is observed by the learner");
});

test("W1-T9703: a garden mint stopped at its loop-available budget is a GardenMintTimedOutError", async (t) => {
  // The child never answers, on a loop that stays free: only then does the budget expire.
  const root = withChildPreload(t, `setInterval(() => {}, 1000);
    await new Promise(() => {});`);
  const budget = new GardenMintBudget(() => 400);
  const mint = ciLearningTaskIdMinter(root, undefined, undefined, { budget });
  await assert.rejects(mint.async("fixture"), (error: unknown) => {
    assert.ok(error instanceof GardenMintTimedOutError);
    assert.equal(error.boundMs, 400);
    return true;
  });
  assert.equal(mint.heldSha("W1-T9001"), undefined, "a stopped mint holds nothing");
  assert.equal(budget.boundMs(), 400, "a stopped mint cannot train the learned bound");
});
