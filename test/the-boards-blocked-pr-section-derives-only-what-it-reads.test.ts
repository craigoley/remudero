import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { computeBoardSnapshot } from "../src/lib/board.js";
import type { Plan } from "../src/lib/plan.js";
import * as statusBoard from "../src/lib/status-board.js";
import type { GitHub } from "../src/lib/status.js";

const ROOT = "/nonexistent-rmd-board-root";
const plan: Plan = { tasks: [], byId: new Map() };
const now = () => Date.parse("2026-10-07T12:00:00Z");
type Line = Record<string, unknown>;

function gateway(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: (ref) => ({ number: Number(ref), url: `https://github.com/o/r/pull/${ref}`, state: "OPEN" }),
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

function disposed(prNumber: number, extra: Line = {}): Line {
  return {
    step: "sweep.disposed", pr_number: prNumber, task_id: `W1-T${prNumber}`,
    pr_url: `https://github.com/o/r/pull/${prNumber}`, disposition: "conflicted",
    reason: "resolve the conflict", ts: "2026-10-07T11:00:00Z", ...extra,
  };
}

function hold(extra: Line = {}): Line {
  return {
    step: "automerge.hold_engaged", task_id: "W1-T10", pr_number: 10,
    by: "operator", reason: "manual review", authority: "console-confirmed", ...extra,
  };
}

function fullSections(lines: Line[], github?: GitHub, limit = 5) {
  const full = statusBoard.buildStatusBoard(ROOT, `${ROOT}/ledger.ndjson`, {
    plan, github, now, queueHeadLimit: limit, repoDir: ROOT,
    readLedger: () => lines, queryService: () => ({ running: false, pid: null }),
    resolveOriginMainSha: () => undefined, readPushedRunBranches: () => "",
    grepAnchorTrue: () => false, readProposalRegistry: () => [], readDraftCache: () => ({}),
  });
  return {
    blockedPrs: full.blockers.rows.filter((row) => row.kind === "blocked_pr"),
    blockedPrsUnverifiedReason: full.blockers.blockedPrsUnverifiedReason,
    mergeHeld: full.needsMe.mergeHeld,
  };
}

test("test/the-boards-blocked-pr-section-derives-only-what-it-reads.test.ts: narrow and full sections agree across live PR states, outages and holds", () => {
  assert.equal(typeof statusBoard.deriveBlockedPrSections, "function");
  const fixtures: Array<{ name: string; lines: Line[]; github?: GitHub; limit?: number }> = [
    { name: "quiet", lines: [], github: gateway() },
    {
      name: "open, closed, merged and absent PRs", lines: [1, 2, 3, 4].map((n) => disposed(n)),
      github: gateway({ prByRef: (ref) => Number(ref) === 4 ? null : {
        number: Number(ref), url: `https://github.com/o/r/pull/${ref}`,
        state: Number(ref) === 1 ? "OPEN" : Number(ref) === 2 ? "closed" : "merged",
      } }),
    },
    { name: "latest disposition wins", lines: [disposed(1), disposed(1, { disposition: "wait" })], github: gateway() },
    { name: "default limit and ordering", lines: Array.from({ length: 7 }, (_, i) => disposed(i + 1, { ts: `2026-10-07T11:00:0${i}Z` })), github: gateway() },
    { name: "custom limit", lines: [disposed(1), disposed(2)], github: gateway(), limit: 1 },
    { name: "zero limit", lines: [disposed(1)], github: gateway(), limit: 0 },
    { name: "GitHub failed", lines: [disposed(1), disposed(2), hold()], github: gateway({ readFailed: () => true, readFailureReason: () => "rate_limit" }) },
    { name: "unknown failure", lines: [disposed(1)], github: gateway({ readFailed: () => true }) },
    { name: "no gateway", lines: [disposed(1)] },
    { name: "hold engaged", lines: [disposed(10), hold()], github: gateway() },
    { name: "hold released", lines: [hold(), hold({ step: "automerge.hold_released" })], github: gateway() },
    { name: "fleet hold", lines: [hold({ pr_number: undefined })], github: gateway() },
    { name: "fleet release", lines: [hold({ pr_number: undefined }), hold({ step: "automerge.hold_released", pr_number: undefined })], github: gateway() },
  ];
  for (const fixture of fixtures) {
    const narrow = statusBoard.deriveBlockedPrSections(fixture.lines, fixture.github, fixture.limit);
    assert.deepEqual(narrow, fullSections(fixture.lines, fixture.github, fixture.limit), fixture.name);
    const board = computeBoardSnapshot({ plan, ledgerPath: `${ROOT}/ledger.ndjson`, now,
      github: fixture.github ?? gateway({ readFailed: () => true }), readLedger: () => fixture.lines });
    if (fixture.github && fixture.limit === undefined) {
      assert.deepEqual({ blockedPrs: board.blockedPrs, blockedPrsUnverifiedReason: board.blockedPrsUnverifiedReason,
        mergeHeld: board.mergeHeld }, narrow, `${fixture.name}: board snapshot`);
    }
  }
  assert.deepEqual(statusBoard.deriveBlockedPrSections([disposed(1), disposed(2)], gateway()).blockedPrs.map((row) => row.prNumber), [1, 2]);
  assert.deepEqual(statusBoard.deriveBlockedPrSections([hold()]).mergeHeld,
    [{ prNumber: 10, taskId: "W1-T10", by: "operator", reason: "manual review" }]);
  assert.deepEqual(statusBoard.deriveBlockedPrSections([hold(), hold({ step: "automerge.hold_released" })]).mergeHeld, []);
  const unavailable = statusBoard.deriveBlockedPrSections([disposed(1)], gateway({ readFailed: () => true, readFailureReason: () => "rate_limit" }));
  assert.deepEqual(unavailable.blockedPrs, []);
  assert.match(unavailable.blockedPrsUnverifiedReason!, /1 blocked-PR ledger entry.*rate_limit/);
});

test("test/the-boards-blocked-pr-section-derives-only-what-it-reads.test.ts: deriving narrow sections and the board snapshot spawns no process", (t) => {
  const calls: string[] = [];
  for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"] as const) {
    t.mock.method(childProcess, method, () => { calls.push(method); throw new Error(`unexpected ${method}`); });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const lines = [disposed(10), hold()];
  const github = gateway();
  const snapshot = computeBoardSnapshot({ plan, github, now, ledgerPath: `${ROOT}/ledger.ndjson`, readLedger: () => lines });
  assert.deepEqual(calls, [], "the board path must never spawn, including a caught failed git invocation");
  const narrow = statusBoard.deriveBlockedPrSections(lines, github);
  assert.deepEqual({ blockedPrs: snapshot.blockedPrs, blockedPrsUnverifiedReason: snapshot.blockedPrsUnverifiedReason,
    mergeHeld: snapshot.mergeHeld }, narrow);
  assert.deepEqual(calls, [], "the narrow derivation must never spawn");
  statusBoard.buildStatusBoard(ROOT, `${ROOT}/ledger.ndjson`, {
    plan, github, now, repoDir: ROOT, readLedger: () => lines,
    queryService: () => ({ running: false, pid: null }), resolveOriginMainSha: () => undefined,
  });
  assert.deepEqual(calls, ["execFileSync"], "positive control: the full builder still invokes its pushed-branch reader");
});
