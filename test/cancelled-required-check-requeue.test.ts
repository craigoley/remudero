import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  cancelledCheckRequeueDecision,
  cancelledRequiredCheckNames,
  checksStateFromRollup,
  requeuedCheckKeysFromLedger,
  runSweep,
  type CancelledRequiredCheck,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { buildOpenPrViews, buildSweepEffects, cancelledRequiredChecks, fetchCiFailures } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { IssueGateway } from "../src/lib/escalate.js";

/**
 * W1-T1223 — a cancelled required check is indistinguishable from a genuine failure
 * (`checksStateFromRollup` returns "red" for both, by design — see that function's own doc), and
 * nothing re-queued it: measured live on #2434 and #2444, where `coverage-ratchet` alone was
 * cancelled while every sibling required check reported success, and a human re-queued it 47
 * minutes / 5h40m later because the sweep had no re-queue action at all.
 *
 * Four acceptance criteria, each proven below:
 *   1. a required check whose latest attempt is cancelled is named APART from one that failed.
 *   2. the sweep re-queues that check at most ONCE per head sha, bounded by a LEDGERED record.
 *   3. a SECOND cancellation on the same head re-queues nothing and escalates to a human instead.
 *   4. the re-queue targets the single JOB, never the workflow run that carries an already-green
 *      sibling (`ci`, sharing the #2434/#2444 workflow run with `coverage-ratchet`).
 */

const NOW = Date.parse("2026-08-22T20:15:54Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-check-requeue-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2434,
    prUrl: "https://github.com/craigoley/remudero/pull/2434",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "202d302",
    headRefName: "run-W1-TX-1785378652634",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }>;
  cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }> = [];
  const cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }> = [];
  return {
    fixed,
    escalated,
    requeued,
    cancelledEscalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    requeueCheck: async (p, check) => {
      requeued.push({ pr: p, check });
    },
    escalateCancelledCheck: async (p, check, reason) => {
      cancelledEscalated.push({ pr: p, check, reason });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-CHECKREQUEUE-1",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1 — CANCELLED is named apart from a genuine failure ─────────────────────────────

test("cancelledRequiredCheckNames: the #2434 fixture — coverage-ratchet cancelled, every sibling success — names ONLY coverage-ratchet", () => {
  const required = ["ci-gate", "coverage-ratchet"];
  const rollup: RollupCheckEntry[] = [
    { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-22T20:15:50Z" },
    { name: "coverage-ratchet", conclusion: "CANCELLED", startedAt: "2026-08-22T20:15:54Z" },
  ];
  assert.equal(checksStateFromRollup(rollup, required), "red", "checksState stays red — never widened");
  assert.deepEqual(cancelledRequiredCheckNames(rollup, required), ["coverage-ratchet"]);
});

test("cancelledRequiredCheckNames: a genuinely FAILING required check is never named here, even though checksState is red for it too", () => {
  const required = ["ci-gate"];
  const rollup: RollupCheckEntry[] = [{ name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-22T01:26:02Z" }];
  assert.equal(checksStateFromRollup(rollup, required), "red");
  assert.deepEqual(cancelledRequiredCheckNames(rollup, required), [], "a bad verdict is not an absent one");
});

test("run-task.ts's cancelledRequiredChecks and fetchCiFailures AGREE on which check is which, on the #2444 mixed fixture: ci-gate genuinely failed, coverage-ratchet was cancelled", () => {
  const required = ["ci-gate", "coverage-ratchet"];
  const rollup = [
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-22T01:26:02Z", detailsUrl: "https://github.com/x/y/actions/runs/1/job/11" },
    { name: "coverage-ratchet", conclusion: "CANCELLED", startedAt: "2026-08-22T01:26:04Z", detailsUrl: "https://github.com/x/y/actions/runs/1/job/22" },
  ];
  const failing = fetchCiFailures("craigoley", "remudero", rollup);
  // W1-T2296 CHANGED THIS ASSERTION, AND THE OLD ONE DESCRIBED THE DEFECT. It used to read
  // `["ci-gate", "coverage-ratchet"]` with the note "names BOTH -- it does not distinguish cause".
  // `ci-gate` is a downstream aggregator: on THIS fixture it is FAILURE only because
  // `coverage-ratchet` is CANCELLED. Naming both made `runSweep`'s own cancelled-check stand-down
  // MISS -- `genuineFailures` (lib/sweep.ts) subtracts the cancelled names from `ciFailures`, so it
  // was left holding `["ci-gate"]`, length 1, and the lane fell through to `dispatchFix` and spent a
  // strike on an aggregate no worker can repair. That is the #2434/#2444 shape this fixture is named
  // for. Filtered, `genuineFailures` is empty and the lane stands down as designed.
  assert.deepEqual(failing.map((f) => f.name), ["coverage-ratchet"], "the aggregate is dropped; its CAUSE is what the evidence names");

  const cancelled = cancelledRequiredChecks(rollup, required);
  assert.deepEqual(cancelled.map((c) => c.name), ["coverage-ratchet"], "the NEW observable names ONLY the absent verdict");
});

// ── acceptance 2 — bounded to ONE re-queue per head sha, read back from the ledger ──────────────

test("cancelledCheckRequeueDecision: no prior ledger record re-queues; a prior record escalates instead", () => {
  const first = cancelledCheckRequeueDecision(false);
  assert.equal(first.requeue, true);
  assert.equal(first.escalate, false);

  const second = cancelledCheckRequeueDecision(true);
  assert.equal(second.requeue, false);
  assert.equal(second.escalate, true);
});

test("runSweep: a PR red ONLY because coverage-ratchet was cancelled re-queues it exactly once, ledgered, and never spends a fix-rung strike", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "12345" }],
  });
  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 1, "the re-queue fired exactly once");
  assert.equal(deps.requeued[0].check.name, "coverage-ratchet");
  assert.equal(deps.fixed.length, 0, "a cancelled check has no diff defect — the fix rung never spends a strike on it");
  assert.equal(deps.escalated.length, 0, "no blocked-ambiguous escalation either — this is gate reconciliation, not a clarification");
  assert.equal(deps.cancelledEscalated.length, 0, "the FIRST cancellation never escalates");

  const line = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.check_requeued");
  assert.ok(line, "the re-queue must be ledgered before it can be repeated (design ii)");
  assert.equal(line!.head_sha, "202d302");
  assert.equal(line!.check_name, "coverage-ratchet");
  assert.equal(line!.pr_number, 2434);

  const keys = requeuedCheckKeysFromLedger(readLedgerLines(deps.ledgerPath));
  assert.ok(keys.has("202d302@coverage-ratchet"), "requeuedCheckKeysFromLedger reads the SAME row back");
});

test("runSweep: a SECOND pass over the SAME head sha, still cancelled, does NOT re-queue again", async () => {
  const first = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "12345" }],
  });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.requeued.length, 1);

  // Same ledger (so the prior re-queue is visible), same head sha — exactly what a real next
  // pass would observe if the RE-QUEUED job was ALSO cancelled (the #2434/#2444 shape, or a
  // concurrency-group fault).
  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.requeued.length, 0, "bounded — no second re-queue for the same (head sha, check) pair");
});

// ── acceptance 3 — a second cancellation on the same head escalates to a human ──────────────────

test("runSweep: a second cancellation on the SAME head sha re-queues nothing and raises a human-facing escalation naming the check", async () => {
  const first = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "12345" }],
  });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.requeued.length, 1);

  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.requeued.length, 0, "re-queueing cannot reach a second cancellation");
  assert.equal(second.cancelledEscalated.length, 1, "a human-facing escalation fires instead");
  assert.equal(second.cancelledEscalated[0].check.name, "coverage-ratchet", "the check is named");
  assert.match(second.cancelledEscalated[0].reason, /already re-queued once/);
  assert.equal(second.fixed.length, 0, "still never the fix rung's job — this PR carries no diff defect");
});

test("runSweep: a genuinely FAILING required check is untouched by this remedy — it still dispatches the fix rung, never re-queues", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "ci-gate", logTail: "line one\nline two\nline three\nassertion failed at line 42\n" }],
    cancelledRequiredChecks: [],
  });
  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.requeued.length, 0, "nothing was cancelled — nothing to re-queue");
  assert.equal(deps.fixed.length, 1, "a genuine failure still routes to the fix rung, unchanged");
});

// ── acceptance 4 — the re-queue targets the JOB, never the workflow run ─────────────────────────

test("run-task.ts's cancelledRequiredChecks parses the JOB id off the rollup's own detailsUrl (…/actions/runs/<run>/job/<job>)", () => {
  const rollup = [
    {
      name: "coverage-ratchet",
      conclusion: "CANCELLED",
      startedAt: "2026-08-22T20:15:54Z",
      detailsUrl: "https://github.com/craigoley/remudero/actions/runs/987654/job/123456",
    },
  ];
  const cancelled = cancelledRequiredChecks(rollup, ["coverage-ratchet"]);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].jobId, "123456", "the JOB id, not the run id (987654)");
});

test("GUARDED SITE sweep check re-queue: buildSweepEffects().requeueCheck calls the single job's own rerun endpoint, never the whole-run rerun-failed-jobs endpoint", async () => {
  const captured: string[][] = [];
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t1223-requeue-root-")) } as never,
    ledgerPath(),
    "SWEEP-REQUEUE-1",
    { tasks: [] } as never,
    () => {},
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    (file, args) => {
      captured.push([file, ...args]);
    },
  );

  await effects.requeueCheck?.(
    { prNumber: 2434, prUrl: "https://github.com/craigoley/remudero/pull/2434", headSha: "202d302" } as never,
    { name: "coverage-ratchet", jobId: "123456" },
  );

  assert.equal(captured.length, 1, `expected exactly one gh invocation, got ${JSON.stringify(captured)}`);
  const argv = captured[0].join(" ");
  assert.match(argv, /actions\/jobs\/123456\/rerun/, `must target the single job — argv was ${argv}`);
  assert.doesNotMatch(argv, /rerun-failed-jobs/, `must NEVER target the whole-run rerun-failed-jobs endpoint — argv was ${argv}`);
  assert.doesNotMatch(argv, /actions\/runs\/[^/]+\/rerun(?!-)/, `must never re-run the whole workflow run — argv was ${argv}`);
});

test("GUARDED SITE sweep check re-queue: buildSweepEffects().escalateCancelledCheck opens a real needs-human issue naming the check, via tryEscalate", async () => {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const fakeIssues: IssueGateway = {
    create: (title, body, labels) => {
      created.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/999";
    },
  };
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t1223-escalate-root-")) } as never,
    ledgerPath(),
    "SWEEP-REQUEUE-3",
    { tasks: [] } as never,
    () => {},
    undefined, undefined, undefined, undefined, fakeIssues,
    undefined, undefined, undefined, undefined, undefined,
  );

  await effects.escalateCancelledCheck?.(
    { prNumber: 2434, prUrl: "https://github.com/craigoley/remudero/pull/2434", headSha: "202d302" } as never,
    { name: "coverage-ratchet", jobId: "123456" },
    "already re-queued once on this head sha",
  );

  assert.equal(created.length, 1, "escalateCancelledCheck must reach the real issue gateway via tryEscalate");
  assert.match(created[0].title, /coverage-ratchet/, "the check name is named in the escalation");
  assert.match(created[0].body, /coverage-ratchet/);
  assert.match(created[0].body, /already re-queued once/, "the caller-supplied reason rides along");
  assert.equal(created[0].body.includes("undefined"), false, "every interpolated field resolved — nothing stringified as undefined");
});

test("GUARDED SITE sweep check re-queue: buildSweepEffects().requeueCheck logs and swallows a throwing gh call, rather than crashing the sweep pass", async () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t1223-requeue-throw-")) } as never,
    ledgerPath(),
    "SWEEP-REQUEUE-4",
    { tasks: [] } as never,
    (step, extra) => {
      logged.push({ step, extra });
    },
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    () => {
      throw new Error("gh: rate limited");
    },
  );

  await effects.requeueCheck?.(
    { prNumber: 2434, prUrl: "https://github.com/craigoley/remudero/pull/2434", headSha: "202d302" } as never,
    { name: "coverage-ratchet", jobId: "123456" },
  );

  const errorLine = logged.find((l) => l.step === "sweep.check_requeue.error");
  assert.ok(errorLine, "a throwing gh call is caught and logged, never left to crash the sweep pass");
  assert.equal(errorLine!.extra?.check_name, "coverage-ratchet");
  assert.match(String(errorLine!.extra?.error), /rate limited/);
});

test("GUARDED SITE gateway wiring: buildOpenPrViews populates OpenPrView.cancelledRequiredChecks off the SAME rollup that reads checksState red, naming ONLY the cancelled required check", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openprviews-cancelled-"));
  const ledgerFile = join(dir, "ledger.ndjson");
  writeFileSync(ledgerFile, "");

  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/\/pulls\?/.test(path) || /state=open/.test(path)) {
      return [
        {
          number: 2434,
          html_url: "https://github.com/craigoley/remudero/pull/2434",
          head: { ref: "run-W1-TX-1785378652634", sha: "202d302" },
          updated_at: "2026-08-22T20:15:54Z",
          body: "Remudero-Task: W1-TX",
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/check-runs/.test(path)) {
      return {
        check_runs: [
          { name: "ci-gate", status: "completed", conclusion: "success" },
          {
            name: "coverage-ratchet",
            status: "completed",
            conclusion: "cancelled",
            details_url: "https://github.com/craigoley/remudero/actions/runs/987654/job/123456",
          },
        ],
      };
    }
    if (/\/status/.test(path)) return { statuses: [] };
    return []; // merge-state / conflict follow-ups
  };

  const views = buildOpenPrViews("craigoley", "remudero", ledgerFile, {
    fetch,
    requiredContexts: () => ["ci-gate", "coverage-ratchet"],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].checksState, "red", "checksState stays red — this producer never widens it");
  assert.deepEqual(
    (views[0].cancelledRequiredChecks ?? []).map((c) => c.name),
    ["coverage-ratchet"],
    "the real gateway wires cancelledRequiredChecks off the SAME rollup, naming only the absent verdict",
  );
  assert.equal(views[0].cancelledRequiredChecks?.[0]?.jobId, "123456", "the job id parsed off detailsUrl rides along");
});

test("buildSweepEffects().requeueCheck is a NAMED no-op when the rollup carried no job id — never a guessed target", async () => {
  const captured: string[][] = [];
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t1223-requeue-nojob-")) } as never,
    ledgerPath(),
    "SWEEP-REQUEUE-2",
    { tasks: [] } as never,
    () => {},
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    (file, args) => {
      captured.push([file, ...args]);
    },
  );

  await effects.requeueCheck?.(
    { prNumber: 2434, prUrl: "https://github.com/craigoley/remudero/pull/2434", headSha: "202d302" } as never,
    { name: "coverage-ratchet" },
  );

  assert.equal(captured.length, 0, "no jobId — no gh call at all");
});


test("W1-T2296: on that same #2444 fixture the cancelled-check stand-down has nothing left over -- no strike is spent on the aggregate", () => {
  const rollup = [
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-22T01:26:02Z", detailsUrl: "https://github.com/x/y/actions/runs/1/job/11" },
    { name: "coverage-ratchet", conclusion: "CANCELLED", startedAt: "2026-08-22T01:26:04Z", detailsUrl: "https://github.com/x/y/actions/runs/1/job/22" },
  ];
  const ciFailures = fetchCiFailures("craigoley", "remudero", rollup);
  const cancelled = cancelledRequiredChecks(rollup, ["ci-gate", "coverage-ratchet"]);
  // The exact subtraction `runSweep` performs before deciding whether to spend a fix-rung strike.
  const genuineFailures = ciFailures.filter((f) => !cancelled.some((c) => c.name === f.name));
  assert.deepEqual(genuineFailures, [], "nothing genuine remains, so the lane stands down instead of dispatching");
});