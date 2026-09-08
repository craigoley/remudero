/**
 * test/a-deadlock-the-harness-cannot-count.test.ts — W1-T2654.
 *
 * This suite covers the observability half only: a scope stand-down still stands down, but when the
 * offending path is a failing gate's own remedy it now carries a named disposition, the gate, the
 * file, and whether FAST_GATE_STEPS already declares that remedy.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION,
  countGateRemedyScopeDeadlockLedgerMembers,
  fixRungScopeStandDownReason,
  runFixRung,
} from "../src/run-task.js";
import { remedyFilesForFailingChecks } from "../src/lib/ci-parity.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const COMMENT_LOAD_REMEDY = "scripts/comment-load-baseline.json";
const UNDECLARED_REMEDY = "scripts/unregistered-ratchet-baseline.json";
const PLAN_FILE = "plan/tasks.d/W1-T2654-fixture.yaml";
const SOURCE_FILE = "src/run-task.ts";

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
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

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function fixRungBaseOpts(task: { id: string; title: string; files?: string[] }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-deadlock-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-deadlock-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-deadlock-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-deadlock-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

function diffFileSequence(sequence: string[][]): () => Promise<string[]> {
  let i = 0;
  return async () => sequence[Math.min(i++, sequence.length - 1)];
}

function commentLoadFailure(path = COMMENT_LOAD_REMEDY): CiFailure {
  return {
    name: "comment-load-ratchet",
    logTail: `comment load grew past its recorded bucket\nTO FIX: record the reviewed result; edit ${path} and commit it`,
  };
}

test("acceptance 1: a declared gate remedy that still stands down is classified under the gate-remedy class", () => {
  const got = fixRungScopeStandDownReason(
    [PLAN_FILE, COMMENT_LOAD_REMEDY],
    [PLAN_FILE],
    [PLAN_FILE],
    remedyFilesForFailingChecks(["comment-load-ratchet"]),
    [commentLoadFailure()],
  );

  assert.ok(got);
  assert.equal(got.scopeKind, "plan");
  assert.equal(got.gateRemedyDeadlock?.disposition, FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION);
  assert.equal(got.gateRemedyDeadlock?.gate, "comment-load-ratchet");
  assert.equal(got.gateRemedyDeadlock?.file, COMMENT_LOAD_REMEDY);
  assert.equal(got.gateRemedyDeadlock?.declaringEntryExists, true);
});

test("acceptance 2: an ordinary out-of-scope path keeps the generic stand-down reason and no class payload", () => {
  const withoutFailures = fixRungScopeStandDownReason([SOURCE_FILE, "scripts/ordinary.json"], [SOURCE_FILE], [SOURCE_FILE]);
  const withUnrelatedFailure = fixRungScopeStandDownReason(
    [SOURCE_FILE, "scripts/ordinary.json"],
    [SOURCE_FILE],
    [SOURCE_FILE],
    remedyFilesForFailingChecks(["comment-load-ratchet"]),
    [commentLoadFailure()],
  );

  assert.ok(withoutFailures);
  assert.ok(withUnrelatedFailure);
  assert.equal(withUnrelatedFailure.reason, withoutFailures.reason);
  assert.equal(withUnrelatedFailure.gateRemedyDeadlock, undefined);
});

test("acceptance 3: the scope escalation names the gate, file, and existing declaring entry", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const issues = fakeIssueStore();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const failing = fakeReview("failure", [criterion({ claim: "comment load is green", met: false, reason: "red" })]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2654X", title: "fix plan-only comment load", files: [PLAN_FILE] }),
    strikeCap: 3,
    initialReview: failing,
    ciFailures: [commentLoadFailure()],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return workerResult({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [commentLoadFailure()],
      runReview: async () => failing,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      fetchPrDiffFiles: diffFileSequence([[PLAN_FILE], [PLAN_FILE], [PLAN_FILE, COMMENT_LOAD_REMEDY]]),
    },
  });

  assert.equal(spawnCalls.length, 1, "the refusal still stands down before spending strike 2");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(issues.calls.length, 1);
  assert.match(issues.calls[0].body, /failing gate comment-load-ratchet prescribes scripts\/comment-load-baseline\.json/);
  assert.match(issues.calls[0].body, /FAST_GATE_STEPS\[job="comment-load-ratchet"\]\.remedyFiles includes/);

  const stoodDown = logs.find((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.scope");
  assert.ok(stoodDown);
  assert.equal(stoodDown.extra?.disposition, FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION);
  assert.equal(stoodDown.extra?.gate, "comment-load-ratchet");
  assert.equal(stoodDown.extra?.file, COMMENT_LOAD_REMEDY);
  assert.equal(stoodDown.extra?.declaring_entry_exists, true);
});

test("acceptance 4: an output-named remedy with no registry entry is still the class and names the missing entry", () => {
  const got = fixRungScopeStandDownReason(
    [SOURCE_FILE, UNDECLARED_REMEDY],
    [SOURCE_FILE],
    [SOURCE_FILE],
    remedyFilesForFailingChecks(["comment-load-ratchet"]),
    [commentLoadFailure(UNDECLARED_REMEDY)],
  );

  assert.ok(got);
  assert.equal(got.gateRemedyDeadlock?.disposition, FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION);
  assert.equal(got.gateRemedyDeadlock?.gate, "comment-load-ratchet");
  assert.equal(got.gateRemedyDeadlock?.file, UNDECLARED_REMEDY);
  assert.equal(got.gateRemedyDeadlock?.declaringEntryExists, false);
  assert.match(got.gateRemedyDeadlock?.declaringEntry ?? "", /MISSING FAST_GATE_STEPS remedyFiles entry/);
});

test("acceptance 5: the class is countable from seeded ledger rows alone", () => {
  const lines: Array<Record<string, unknown>> = [
    { step: "fix.stood_down", disposition: FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION, gate: "source-size", file: "scripts/source-size-baseline.json" },
    { step: "fix.stood_down", disposition: FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION, gate: "comment-load-ratchet", file: "scripts/comment-load-baseline.json" },
    { step: "fix.stood_down", site: "rung.scope", reason: "ordinary scope drift" },
    { step: "fix.dispatch", disposition: FIX_RUNG_GATE_REMEDY_SCOPE_DEADLOCK_DISPOSITION, gate: "source-size", file: "scripts/source-size-baseline.json" },
  ];

  assert.equal(countGateRemedyScopeDeadlockLedgerMembers(lines), 2);
});
