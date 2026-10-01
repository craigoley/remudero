// W1-T5074: the push coverage precheck ran as a spawnSync inside runTask, which runs in the DAEMON process, so for
// its whole duration no sweep, tick, ledger write or token-refresh timer could fire (42 minutes, observed
// 2026-10-01). These tests drive the REAL default runner (no injected `run`) against a stand-in
// scripts/diff-coverage-local.mjs, so a restored spawnSync is what turns the first one red.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AffectedSelection } from "../src/lib/affected-suites.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { coveragePrecheck, type CoveragePrecheck, type CoveragePrecheckPorts } from "../src/run-task.js";

const SUITE = "test/feature.test.ts";

function realRunPorts(thresholdMs: number): CoveragePrecheckPorts {
  const selection: AffectedSelection = { suites: [SUITE], fullRun: false, reasons: [], recentOnly: { floor: [] } };
  return {
    changedFiles: () => ["src/feature.ts"],
    select: () => selection,
    manifest: () => ({ thresholdMs, files: { [SUITE]: 1 } }),
  };
}

/** A worktree whose diff-coverage-local.mjs runs `body`; the precheck's real runner spawns it. */
function withWorktree<T>(body: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}precheck-async-`));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "diff-coverage-local.mjs"), body);
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const SLEEPS_THEN_COVERED = `await new Promise((r) => setTimeout(r, 600));\nprocess.stdout.write("diff-coverage: OK\\n");\n`;

test("W1-T5074: the daemon loop keeps running while a coverage precheck is in flight", async () => {
  await withWorktree(SLEEPS_THEN_COVERED, async (root) => {
    const events: string[] = [];
    let ticks = 0;
    // Scheduled BEFORE the precheck starts, exactly as the installation-token refresh timer is.
    const refresh = setTimeout(() => events.push("timer"), 50);
    const interval = setInterval(() => void ticks++, 20);
    try {
      const result = await coveragePrecheck(root, realRunPorts(30_000));
      events.push("precheck-returned");
      assert.equal(result.outcome, "covered", JSON.stringify(result));
      assert.deepEqual(events, ["timer", "precheck-returned"], "the timer fired while the child ran, not after the precheck returned");
      assert.ok(ticks >= 5, `the event loop kept turning during the ~600ms child (ticks=${ticks})`);
    } finally {
      clearTimeout(refresh);
      clearInterval(interval);
    }
  });
});

test("W1-T5074: a precheck outcome is unchanged by the async conversion", async () => {
  const run = (body: string, thresholdMs = 30_000): Promise<CoveragePrecheck> => withWorktree(body, (root) => coveragePrecheck(root, realRunPorts(thresholdMs)));

  const covered = await run(`process.stdout.write("diff-coverage: OK\\n");\n`);
  assert.equal(covered.outcome, "covered");
  assert.equal((covered as { suites: number }).suites, 1);

  const uncovered = await run(
    `process.stdout.write("diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:\\n  - src/feature.ts:2\\n");\nprocess.exit(1);\n`,
  );
  assert.equal(uncovered.outcome, "uncovered");
  assert.match((uncovered as { text: string }).text, /src\/feature\.ts:2/);

  const failed = await run(`process.stderr.write("diff-coverage-local: no lcov produced -- FAILING.\\n");\nprocess.exit(2);\n`);
  assert.equal(failed.outcome, "unavailable");
  assert.match((failed as { reason: string }).reason, /no lcov produced/);

  const timedOut = await run(`await new Promise((r) => setTimeout(r, 20_000));\n`, 150);
  assert.equal(timedOut.outcome, "unavailable");
  assert.match((timedOut as { reason: string }).reason, /timed out over its \d+ms bound/);

  const noWorktree = await coveragePrecheck(join(tmpdir(), `${RMD_TMP_PREFIX}precheck-async-absent-${process.pid}`), realRunPorts(30_000));
  assert.equal(noWorktree.outcome, "unavailable");
  assert.match((noWorktree as { reason: string }).reason, /spawn failed: /);
});
