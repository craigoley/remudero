/**
 * W1-T4038 — the relint loop threads the preceding attempt's decision into the next run() call, so a
 * repair round that omits a fresh verdict line can carry the original PROPOSED scope forward.
 *
 * The end-to-end triage-lane regressions (driven through the real `triageCommand`) live in
 * test/relint-loop.test.ts, an existing importer of src/run-task.ts: the affected-suite reach
 * ratchet (test/the-affected-suite-reach-ratchet.test.ts) refuses a NEW direct importer of the
 * monolith, so this suite exercises only the shared loop in src/lib/relint.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runRelintLoop } from "#src/lib/relint.js";

test("the relint callback receives the preceding attempt's decision", async () => {
  const previous: Array<number | undefined> = [];
  await runRelintLoop<number>({
    lane: "triage", filedIds: ["W1-T1"], initialPrompt: "file the task",
    run: async (_prompt, attempt, prior) => { previous.push(prior); return attempt; },
    filed: () => true,
    lint: () => previous.length < 3 ? [{ check: "plan-load", severity: "block", message: "repair" }] : [],
    log: () => {},
  });
  assert.deepEqual(previous, [undefined, 1, 2]);
});
