import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { priorStrikesFor, runFixRung } from "../src/run-task.js";
import { isRealStrike, isSpawnInfraBlockedError, LEDGER_COST_TAG_INFRA } from "../src/lib/ledger.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * W1-T127 — STRIKE-ACCOUNTING INTEGRITY (the #212 fixture: PR #212/#213, a
 * spawn-ENOENT/autoupdater-race binary crash that debited a fix-rung strike —
 * and left the PR sitting 20h41m blocked — on a worker that never ran, because
 * the ledger's `fix.dispatch` line was written BEFORE `deps.spawn` was even
 * attempted, not after it was confirmed to have actually launched a worker).
 *
 * All four fixtures below drive `runFixRung` (never a hand-rolled reimplementation
 * of its accounting) so the proof is against the REAL dispatch loop, the same one
 * the daemon/sweep/drain paths all share.
 */

/** The exact duck-typed shape `isSpawnInfraBlockedError` classifies — mirrors
 *  worker.ts's `ClaudeToolchainBlockedError` without importing it (same idiom
 *  test/daemon.test.ts's own `toolchainBlockedError` fixture uses). */
function toolchainBlockedError(reason = "claude executable not found or not runnable — searched: npm-global=... (missing)") {
  return Object.assign(new Error(reason), { reasonClass: "blocked_toolchain" as const });
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(state: "success" | "failure", criteria: CriterionVerdict[]): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "deadbeef",
    reviewerOutcome: "success",
  };
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "W1-D",
    runId: "W1-D-1730000000000",
    task: { id: "W1-D", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/212",
    branch: "run-W1-D-1730000000000",
    worktreePath: "/tmp/rmd-strike-accounting-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-strike-accounting-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-strike-accounting-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-strike-accounting-")), "ledger.ndjson");
}

function fakeIssues(calls: Array<{ title: string; body: string; labels: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/213";
    },
  };
}

/** Collects every `log(step, extra)` call — the raw shape `priorStrikesFor` reads. */
function captureLog(): {
  lines: Array<{ task_id: string; step: string } & Record<string, unknown>>;
  log: (step: string, extra?: Record<string, unknown>) => void;
} {
  const lines: Array<{ task_id: string; step: string } & Record<string, unknown>> = [];
  return {
    lines,
    log: (step, extra) => lines.push({ task_id: "W1-D", step, ...(extra ?? {}) }),
  };
}

// ── claim 1: a blocked_toolchain spawn-infra failure increments neither the
// strike counter nor attempts-toward-escalation ──────────────────────────────

test("W1-T127: a blocked_toolchain spawn-infra refusal on the FIRST dispatch attempt leaves the strike counter and attempts-toward-escalation at zero (#212)", async () => {
  const { lines, log } = captureLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let spawnCalls = 0;

  await assert.rejects(
    () =>
      runFixRung({
        ...fixRungBaseOpts(),
        strikeCap: 2,
        initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]),
        deps: {
          spawn: async () => {
            spawnCalls++;
            throw toolchainBlockedError();
          },
          waitForCiGreen: async () => {
            throw new Error("must never be called — no worker ever ran to push anything");
          },
          runReview: async () => {
            throw new Error("must never be called — no worker ever ran to produce a report");
          },
          push: () => {
            throw new Error("must never be called — no worker ever ran to push anything");
          },
          issues: fakeIssues(issueCalls),
          ledgerPath: tmpLedgerPath(),
          log,
          say: () => {},
          account: (r) => r,
        },
      }),
    (e: unknown) => isSpawnInfraBlockedError(e),
    "the spawn-infra refusal propagates unchanged — the caller's own degrade-don't-die handling decides what happens next",
  );

  assert.equal(spawnCalls, 1, "the spawn was attempted exactly once");
  assert.ok(
    !lines.some((l) => l.step === "fix.dispatch"),
    "NO fix.dispatch line was written — nothing exists for priorStrikesFor to ever count as a strike",
  );
  assert.ok(!lines.some((l) => l.step === "fix.exhausted"), "the exhaustion/escalation path never fires for an infra refusal");
  assert.equal(issueCalls.length, 0, "no BLOCKED issue is opened — attempts-toward-escalation never moves");
  assert.equal(priorStrikesFor(lines, "W1-D"), 0, "the strike counter, read back from the ledger, is at its pre-crash value: zero");
});

// ── claim 2: its cost line is tagged infra rather than task ──────────────────

test("W1-T127: a blocked_toolchain refusal's ledger line is a $0 line tagged infra, never task, so budget forensics can tell 'the host was broken' apart from 'the task was expensive'", async () => {
  const { lines, log } = captureLog();

  await assert.rejects(() =>
    runFixRung({
      ...fixRungBaseOpts(),
      strikeCap: 2,
      initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]),
      deps: {
        spawn: async () => {
          throw toolchainBlockedError("claude executable vanished mid-fleet");
        },
        waitForCiGreen: async () => {
          throw new Error("must never be called");
        },
        runReview: async () => {
          throw new Error("must never be called");
        },
        push: () => {
          throw new Error("must never be called");
        },
        issues: fakeIssues([]),
        ledgerPath: tmpLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
      },
    }),
  );

  const infraLine = lines.find((l) => l.step === "fix.spawn_infra_blocked");
  assert.ok(infraLine, "a ledger line was written recording the refusal, even though it does not count as a strike");
  assert.equal(infraLine?.cost_tag, LEDGER_COST_TAG_INFRA, "tagged infra, not task");
  assert.notEqual(infraLine?.cost_tag, "task");
  assert.equal(infraLine?.cost_usd, 0, "nothing was billed — the SDK subprocess never launched");
  assert.match(String(infraLine?.reason ?? ""), /claude executable vanished mid-fleet/);
});

// ── claim 3: a strike is recorded only where a worker ran AND a judgment was
// posted — the conjunction, with each half alone proven insufficient ─────────

test("W1-T127: isRealStrike is the conjunction — worker-ran alone is insufficient", () => {
  assert.equal(isRealStrike({ workerRan: true, judgmentPosted: false }), false);
});

test("W1-T127: isRealStrike is the conjunction — judgment-posted alone is insufficient", () => {
  assert.equal(isRealStrike({ workerRan: false, judgmentPosted: true }), false);
});

test("W1-T127: isRealStrike is the conjunction — neither half is obviously insufficient too", () => {
  assert.equal(isRealStrike({ workerRan: false, judgmentPosted: false }), false);
});

test("W1-T127: isRealStrike is the conjunction — ONLY both halves together are a real strike", () => {
  assert.equal(isRealStrike({ workerRan: true, judgmentPosted: true }), true);
});

// ── claim 4: replaying the #212 fixture leaves the strike counter at its
// pre-crash value and does NOT escalate ───────────────────────────────────────

test("W1-T127: the #212 replay — strike 1 is real and judged, strike 2 is a spawn-infra crash — leaves the counter at 1 (its pre-crash value) and never escalates", async () => {
  const { lines, log } = captureLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const failingBoth = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })]);
  let spawnCalls = 0;

  await assert.rejects(
    () =>
      runFixRung({
        ...fixRungBaseOpts(),
        strikeCap: 2,
        initialReview: failingBoth,
        deps: {
          spawn: async () => {
            spawnCalls++;
            // Strike 1: a real worker runs. Strike 2 (and only strike 2): the
            // #212 binary-crash replay — the toolchain vanishes mid-fleet.
            if (spawnCalls === 1) return result({ sessionId: "fix-session-1" });
            throw toolchainBlockedError();
          },
          waitForCiGreen: async () => "green",
          // Strike 1's judgment: still failing — the rung would normally loop
          // to strike 2 (strikeCap 2), which is exactly where #212's crash hit.
          runReview: async () => failingBoth,
          push: () => {},
          issues: fakeIssues(issueCalls),
          ledgerPath: tmpLedgerPath(),
          log,
          say: () => {},
          account: (r) => r,
        },
      }),
    (e: unknown) => isSpawnInfraBlockedError(e),
  );

  assert.equal(spawnCalls, 2, "strike 1 ran for real; strike 2 was attempted and crashed at spawn");
  assert.equal(
    priorStrikesFor(lines, "W1-D"),
    1,
    "the strike counter sits at its PRE-CRASH value (1) — strike 2's dispatch never happened, so it was never fictionally counted",
  );
  assert.ok(!lines.some((l) => l.step === "fix.exhausted"), "the rung never reports itself exhausted over a crash it never dispatched");
  assert.equal(issueCalls.length, 0, "no 'fix strikes exhausted' issue is opened — the #213 fiction never gets a chance to be filed");
});
