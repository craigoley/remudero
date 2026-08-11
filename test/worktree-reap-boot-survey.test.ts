/**
 * test/worktree-reap-boot-survey.test.ts — run-task.ts's `logWorktreeReapBootSurvey`, the
 * W1-T406 one-shot-container boot rung, SHIPS DRY: while `worktreeReapBoot.enabled` is false
 * (its default) the rung surveys and ledgers what it would reclaim, deleting nothing.
 *
 * Mirrors test/clone-reap-wiring.test.ts's own wiring-test shape for the sibling
 * `logCloneReapSurvey` rung — same "inject the reaper itself, assert what dryRun it was
 * called with" technique, so the reaper's own real-filesystem behaviour is out of scope here
 * (reapStaleWorktrees's dryRun opt is covered directly by test/worktree-reap-boot-rung.test.ts).
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorktreeReapSummary } from "../src/lib/worker.js";
import { logWorktreeReapBootSurvey } from "../src/run-task.js";

const CONFIG = { root: "/nonexistent-repo-root-for-wiring-test" } as never;

function summaryOf(over: Partial<WorktreeReapSummary> = {}): WorktreeReapSummary {
  return { reaped: [], reapedLocks: [], kept: [], keptReasons: [], ...over };
}

describe("worktree reap boot survey (W1-T406)", () => {
  it("ships DISABLED: the boot rung reaps in dry-run and deletes nothing", () => {
    let sawDryRun: boolean | undefined;
    const lines: Array<[string, Record<string, unknown>]> = [];

    logWorktreeReapBootSurvey(CONFIG, (s, f) => lines.push([s, f]), {
      policy: () => ({ enabled: false }),
      root: () => "/fake-worktrees-root",
      reap: ((_root: string, opts: { dryRun?: boolean }) => {
        sawDryRun = opts.dryRun;
        return summaryOf({ reaped: ["run-W1-old"] });
      }) as never,
    });

    assert.equal(sawDryRun, true, "with the policy off the reaper MUST be called in dry-run");
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], "worktree.reap_boot");
    assert.equal(lines[0][1].dry_run, true);
    assert.equal(lines[0][1].reaped, 1, "the survey still COUNTS what it would reclaim");
  });

  it("the policy flag is what authorises deletion — enabled clears dry-run", () => {
    let opts: { dryRun?: boolean } = {};
    logWorktreeReapBootSurvey(CONFIG, () => {}, {
      policy: () => ({ enabled: true }),
      root: () => "/fake-worktrees-root",
      reap: ((_r: string, o: typeof opts) => {
        opts = o;
        return summaryOf();
      }) as never,
    });
    assert.equal(opts.dryRun, false, "enabled policy must clear dry-run");
  });

  it("stays silent when nothing was reaped and nothing is undecidable", () => {
    const lines: string[] = [];
    logWorktreeReapBootSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => ({ enabled: false }),
      root: () => "/fake-worktrees-root",
      reap: (() => summaryOf({ kept: ["run-alive"], keptReasons: [{ name: "run-alive", reason: "live-pid" }] })) as never,
    });
    assert.deepEqual(lines, [], "an ordinary live-pid keep writes no ledger line");
  });

  it("ledgers an undecidable (activity-unknown) keep even though nothing was reaped", () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    logWorktreeReapBootSurvey(CONFIG, (s, f) => lines.push([s, f]), {
      policy: () => ({ enabled: false }),
      root: () => "/fake-worktrees-root",
      reap: (() =>
        summaryOf({ kept: ["run-blind"], keptReasons: [{ name: "run-blind", reason: "activity-unknown" }] })) as never,
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], "worktree.reap_boot.undecidable");
    assert.deepEqual(lines[0][1].kept, ["run-blind"]);
  });

  it("never blocks the dispatch: a failing policy read returns null and logs nothing", () => {
    const lines: string[] = [];
    const out = logWorktreeReapBootSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => {
        throw new Error("policy.yaml unreadable");
      },
    });
    assert.equal(out, null);
    assert.deepEqual(lines, []);
  });

  it("defaults reach the real policy loader — an absent repo root fails soft", () => {
    // No `policy` dep: the default path runs loadPolicy(policyPath(config.root)) for real.
    assert.equal(logWorktreeReapBootSurvey(CONFIG, () => {}), null);
  });

  it("defaults isPidAlive to worktreeLockIsPidAlive, not the reaper's own bare pid check", () => {
    let sawIsPidAlive: unknown;
    logWorktreeReapBootSurvey(CONFIG, () => {}, {
      policy: () => ({ enabled: false }),
      root: () => "/fake-worktrees-root",
      reap: ((_r: string, opts: { isPidAlive?: unknown }) => {
        sawIsPidAlive = opts.isPidAlive;
        return summaryOf();
      }) as never,
    });
    assert.equal(typeof sawIsPidAlive, "function");
    // The pid-reuse-aware predicate takes TWO arguments (pid, info) — the reaper's own
    // pre-W1-T406 default (defaultIsPidAlive) takes only one. This is a cheap, honest structural
    // proof that the wiring did not silently fall back to the old bare-pid predicate.
    assert.equal((sawIsPidAlive as (...a: unknown[]) => unknown).length, 2);
  });
});
