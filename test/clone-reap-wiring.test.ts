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
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
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
    assert.equal(lines[0][1].roots_surveyed, 1, "the count of roots the survey itself passed to the reaper");
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

  it("still writes one line when nothing is actionable, naming why via the disposition tally", () => {
    // W1-T1086 re-ruling: this used to assert silence (`assert.deepEqual(lines, [])`) on this
    // exact fixture. A survey whose predicate rejects every candidate is now REQUIRED to speak —
    // silence here was indistinguishable from an empty root, a wrong root, or a throw.
    const lines: Array<[string, Record<string, unknown>]> = [];
    logCloneReapSurvey(CONFIG, (s, f) => lines.push([s, f]), {
      policy: () => ({ enabled: false, maxAgeHours: 24 }),
      roots: () => ["/fake-root"],
      reap: (() =>
        summaryOf([
          { path: "/fake-root/podcast-cache", disposition: "not-a-fleet-clone", bytes: 0, ageMs: 0 },
          { path: "/fake-root/link", disposition: "symlink", bytes: 0, ageMs: 0 },
        ])) as never,
    });
    assert.equal(lines.length, 1, "a completed survey always writes exactly one line");
    assert.equal(lines[0][0], "daemon.clone_reap");
    assert.equal(lines[0][1].reaped, 0);
    assert.equal(lines[0][1].bytes_reclaimed, 0);
    assert.equal(lines[0][1].candidate_bytes, 0, "no candidate here is actionable, so the sum stays 0");
    assert.deepEqual(
      lines[0][1].dispositions,
      { "not-a-fleet-clone": 1, symlink: 1 },
      "the tally names WHY nothing was actionable",
    );
    assert.equal(lines[0][1].roots_surveyed, 1);
  });

  it("an empty-roots survey is distinguishable in the ledger from an empty-disk one", () => {
    const emptyRootsLines: Array<Record<string, unknown>> = [];
    logCloneReapSurvey(CONFIG, (_s, f) => emptyRootsLines.push(f), {
      policy: () => ({ enabled: false, maxAgeHours: 24 }),
      roots: () => [],
      reap: (() => summaryOf([])) as never,
    });

    const emptyDiskLines: Array<Record<string, unknown>> = [];
    logCloneReapSurvey(CONFIG, (_s, f) => emptyDiskLines.push(f), {
      policy: () => ({ enabled: false, maxAgeHours: 24 }),
      roots: () => ["/fake-root"],
      reap: (() => summaryOf([])) as never,
    });

    assert.equal(emptyRootsLines.length, 1);
    assert.equal(emptyDiskLines.length, 1);
    assert.deepEqual(emptyRootsLines[0].dispositions, {});
    assert.deepEqual(emptyDiskLines[0].dispositions, {});
    assert.equal(emptyRootsLines[0].roots_surveyed, 0, "no roots were passed to the reaper at all");
    assert.equal(emptyDiskLines[0].roots_surveyed, 1, "one root was surveyed and found empty");
    assert.notEqual(
      emptyRootsLines[0].roots_surveyed,
      emptyDiskLines[0].roots_surveyed,
      "the two zero-candidate cases must be distinguishable from each other",
    );
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
    assert.equal(lines[0].roots_surveyed, 1, "existing fields are unchanged; roots_surveyed is additive");
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
    assert.equal(
      DECISION_RELEVANT_LEDGER_STEPS.has("daemon.clone_reap"),
      false,
      "a ledger line every boot is not the same as a load-bearing one — nothing reads this step to decide anything",
    );
  });

  it("defaults reach the real policy loader — an absent repo root fails soft", () => {
    // No `policy` dep: the default path runs loadPolicy(policyPath(config.root)) for real.
    assert.equal(logCloneReapSurvey(CONFIG, () => {}), null);
  });
});
