/**
 * test/worktree-reap-boot-nonblocking.test.ts — W1-T406 acceptance: a failure ANYWHERE in the
 * one-shot boot rung (`logWorktreeReapBootSurvey`, run-task.ts) is caught and never blocks the
 * dispatch that invoked it. Mirrors `logCloneReapSurvey`'s own best-effort shape point for
 * point (try/catch returning `null`, never re-thrown) — this exercises every seam that can
 * fail: the policy read, the root resolution, and the reaper call itself.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logWorktreeReapBootSurvey } from "../src/run-task.js";

const CONFIG = { root: "/nonexistent-repo-root-for-wiring-test" } as never;

describe("worktree reap boot rung never blocks the dispatch (W1-T406)", () => {
  it("a policy read that throws is caught — returns null, logs nothing", () => {
    const lines: string[] = [];
    const out = logWorktreeReapBootSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => {
        throw new Error("policy.yaml: malformed 'worktreeReapBoot' mapping");
      },
    });
    assert.equal(out, null);
    assert.deepEqual(lines, []);
  });

  it("a root resolution that throws (a malformed config.root) is caught — returns null, logs nothing", () => {
    const lines: string[] = [];
    const out = logWorktreeReapBootSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => ({ enabled: false }),
      root: () => {
        throw new Error("path.join: config.root is not a string");
      },
    });
    assert.equal(out, null);
    assert.deepEqual(lines, []);
  });

  it("the reaper itself throwing (a filesystem error the reaper's own try/catch didn't happen to swallow) is caught — returns null, logs nothing", () => {
    const lines: string[] = [];
    const out = logWorktreeReapBootSurvey(CONFIG, (s) => lines.push(s), {
      policy: () => ({ enabled: false }),
      root: () => "/fake-worktrees-root",
      reap: (() => {
        throw new Error("EIO: i/o error");
      }) as never,
    });
    assert.equal(out, null);
    assert.deepEqual(lines, []);
  });

  it("the ledger `log` callback itself throwing is caught too — returns null rather than propagating", () => {
    const out = logWorktreeReapBootSurvey(
      CONFIG,
      () => {
        throw new Error("ledger append failed: ENOSPC");
      },
      {
        policy: () => ({ enabled: false }),
        root: () => "/fake-worktrees-root",
        reap: (() => ({ reaped: ["run-x"], reapedLocks: [], kept: [], keptReasons: [] })) as never,
      },
    );
    assert.equal(out, null, "even a failure inside the ledger write must not escape the rung");
  });

  it("the happy path is NOT swallowed — a successful pass still returns its real summary", () => {
    const summary = logWorktreeReapBootSurvey(CONFIG, () => {}, {
      policy: () => ({ enabled: false }),
      root: () => "/fake-worktrees-root",
      reap: (() => ({ reaped: ["run-x"], reapedLocks: [], kept: [], keptReasons: [] })) as never,
    });
    assert.deepEqual(summary, { reaped: ["run-x"], reapedLocks: [], kept: [], keptReasons: [] });
  });

  it("defaults reach the real dependency chain end to end — an unreadable repo root still fails soft", () => {
    // No injected deps at all: loadPolicy(policyPath(config.root)) throws on a nonexistent root,
    // and that throw is what this whole rung exists to absorb.
    assert.doesNotThrow(() => logWorktreeReapBootSurvey(CONFIG, () => {}));
    assert.equal(logWorktreeReapBootSurvey(CONFIG, () => {}), null);
  });
});
