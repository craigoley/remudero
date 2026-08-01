/**
 * test/clone-reap-wiring.test.ts — run-task.ts's boot rung for the clone reaper.
 *
 * Separate file per the CLAUDE.md rule: a coverage-load-bearing test must never be appended
 * to test/run-task.test.ts, which intermittently crashes at the FILE level under
 * --experimental-test-coverage and would zero this test's coverage record nondeterministically.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CloneReapSummary } from "../src/lib/clone-reaper.js";
import { logCloneReapSurvey } from "../src/run-task.js";

const CONFIG = { root: "/nonexistent-repo-root-for-wiring-test" } as never;

function summaryOf(candidates: CloneReapSummary["candidates"], over: Partial<CloneReapSummary> = {}): CloneReapSummary {
  return { candidates, reaped: [], bytesReclaimed: 0, dryRun: true, ...over };
}

describe("clone reap wiring", () => {
  it("ships DISABLED: the boot rung surveys in dry-run and deletes nothing", () => {
    let sawDryRun: boolean | undefined;
    const lines: Array<[string, Record<string, unknown>]> = [];

    logCloneReapSurvey(CONFIG, (s, f) => lines.push([s, f]), {
      policy: () => ({ enabled: false, maxAgeHours: 24 }),
      roots: () => ["/fake-root"],
      reap: ((_roots: readonly string[], opts: { dryRun?: boolean }) => {
        sawDryRun = opts.dryRun;
        return summaryOf([{ path: "/fake-root/review-x", disposition: "would-reap", bytes: 512, ageMs: 99 }]);
      }) as never,
    });

    assert.equal(sawDryRun, true, "with the policy off the reaper MUST be called in dry-run");
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], "daemon.clone_reap");
    assert.equal(lines[0][1].dry_run, true);
    assert.equal(lines[0][1].reaped, 0);
    assert.equal(lines[0][1].candidate_bytes, 512);
    assert.deepEqual(lines[0][1].dispositions, { "would-reap": 1 });
  });

  it("the policy flag is what authorises deletion, and the age ceiling reaches the reaper", () => {
    let opts: { dryRun?: boolean; maxAgeMs?: number } = {};
    logCloneReapSurvey(CONFIG, () => {}, {
      policy: () => ({ enabled: true, maxAgeHours: 48 }),
      roots: () => ["/fake-root"],
      reap: ((_r: readonly string[], o: typeof opts) => {
        opts = o;
        return summaryOf([], { dryRun: false });
      }) as never,
    });
    assert.equal(opts.dryRun, false, "enabled policy must clear dry-run");
    assert.equal(opts.maxAgeMs, 48 * 60 * 60 * 1000, "hours must be converted to ms");
  });

  it("stays silent when there is nothing actionable", () => {
    const lines: string[] = [];
    logCloneReapSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => ({ enabled: false, maxAgeHours: 24 }),
      roots: () => ["/fake-root"],
      reap: (() =>
        summaryOf([
          { path: "/fake-root/podcast-cache", disposition: "not-a-fleet-clone", bytes: 0, ageMs: 0 },
          { path: "/fake-root/link", disposition: "symlink", bytes: 0, ageMs: 0 },
        ])) as never,
    });
    assert.deepEqual(lines, [], "a survey that found only foreign paths writes no ledger line");
  });

  it("reports a live reap's reclamation, and counts an in-use clone as actionable", () => {
    const lines: Array<Record<string, unknown>> = [];
    logCloneReapSurvey(CONFIG, (_s, f) => lines.push(f), {
      policy: () => ({ enabled: true, maxAgeHours: 24 }),
      roots: () => ["/fake-root"],
      reap: (() =>
        summaryOf(
          [
            { path: "/fake-root/a", disposition: "reaped", bytes: 1024, ageMs: 1 },
            { path: "/fake-root/b", disposition: "in-use", bytes: 2048, ageMs: 1 },
          ],
          { reaped: ["/fake-root/a"], bytesReclaimed: 1024, dryRun: false },
        )) as never,
    });
    assert.equal(lines[0].bytes_reclaimed, 1024);
    assert.equal(lines[0].reaped, 1);
    assert.equal(lines[0].candidate_bytes, 3072, "an in-use clone is still reported as pending bytes");
  });

  it("never blocks boot: a failing policy read returns null and logs nothing", () => {
    const lines: string[] = [];
    const out = logCloneReapSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => {
        throw new Error("policy.yaml unreadable");
      },
    });
    assert.equal(out, null);
    assert.deepEqual(lines, []);
  });

  it("defaults reach the real policy loader — an absent repo root fails soft", () => {
    // No `policy` dep: the default path runs loadPolicy(policyPath(config.root)) for real.
    assert.equal(logCloneReapSurvey(CONFIG, () => {}), null);
  });
});
