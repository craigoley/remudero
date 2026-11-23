import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { GARDEN_FILING_RETRY_BASE_MS, readGardenState } from "#src/lib/gardener.js";
import { GARDEN_ACTION_CLASSES, gardenerStatePath, runGardenPass } from "#src/lib/knowledge-gardener.js";

test("W1-T12445: knowledge.garden_filing_failed no longer recurs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-knowledge-filing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repoRoot);
  mkdirSync(stateDir);

  const reason = "the filing transport is temporarily unavailable";
  const prUrl = "https://github.com/acme/remudero/pull/1";
  let now = Date.UTC(2026, 10, 14);
  const failures: Array<Record<string, unknown> | undefined> = [];
  const drafts: string[][] = [];
  const deps = {
    repoRoot,
    stateDir,
    seed: 1,
    clock: clockFromMillisFn(() => now),
    log: (step: string, fields?: Record<string, unknown>) => {
      if (step === "knowledge.garden_filing_failed") failures.push(fields);
    },
    mergedPlanLint: () => undefined,
    openWorkspace: () => {
      const checkout = mkdtempSync(join(root, "checkout-"));
      mkdirSync(join(checkout, "docs"));
      return {
        root: checkout,
        refreshAssertions: () => {
          writeFileSync(join(checkout, "assertions.json"), "{}\n");
          return ["assertions.json"];
        },
        land: ({ paths }: { paths: string[] }) => {
          drafts.push(paths);
          if (drafts.length === 1) throw new Error(reason);
          return prUrl;
        },
        dispose: () => rmSync(checkout, { recursive: true, force: true }),
      };
    },
  };

  const state = () => readGardenState(gardenerStatePath(stateDir), GARDEN_ACTION_CLASSES);
  const failed = await runGardenPass(deps);
  assert.deepEqual(failed.plan?.acting, ["refresh"]);
  assert.equal(failed.prUrl, undefined);
  assert.deepEqual(failures, [{ reason, attempt: 1, retry_after_ms: GARDEN_FILING_RETRY_BASE_MS }]);
  assert.equal(state().filingFailures?.reason, reason);

  now += GARDEN_FILING_RETRY_BASE_MS - 1;
  assert.equal((await runGardenPass(deps)).ran, false);
  assert.equal(drafts.length, 1);

  now += 1;
  assert.equal((await runGardenPass(deps)).prUrl, prUrl);
  assert.equal(drafts.length, 2);
  assert.ok(drafts[0]?.includes("assertions.json"));
  assert.deepEqual(drafts[1], drafts[0]);
  assert.equal(state().pending?.prUrl, prUrl);
  assert.equal(state().filingFailures, undefined);
  assert.equal(failures.length, 1);
});
