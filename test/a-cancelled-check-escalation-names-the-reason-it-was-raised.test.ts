// test/a-cancelled-check-escalation-names-the-reason-it-was-raised.test.ts — W1-T5942.
//
// Since W1-T5920 `escalateCancelledCheck` fires for TWO reasons: a second cancellation of the same
// required check on the same head (W1-T1223), and CHECK_REQUEUE_DEFERRAL_BACKSTOP job reruns GitHub
// refused with a 403 while the check's run was in flight. Its summary — the issue TITLE — always
// read "cancelled twice on the same head", so a backstop escalation told the operator the wrong
// story; the true cause sat only in the body. The summary now names the reason it was raised.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHECK_REQUEUE_DEFERRAL_BACKSTOP,
  CHECK_REQUEUE_DEFERRED_STEP,
  CHECK_REQUEUE_STEP,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { buildSweepEffects } from "../src/run-task.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-06T05:30:00Z");
const PR = 9438;
const TASK = "W1-T5920";
const HEAD = "9d5ff72b0c";
const GATE = "squash-trailer-gate";
const TWICE = "cancelled twice on the same head";

const tmp = (label: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5942-${label}-`));

function view(): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: TASK,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-06T05:29:00Z",
    headSha: HEAD,
    headRefName: "run-W1-T5920-1791250000000",
    autoMergeArmed: false,
    ciFailures: [{ name: GATE, logTail: "" }],
    cancelledRequiredChecks: [{ name: GATE, jobId: "111989995761" }],
  };
}

/** The production escalation effect, over an issue gateway that records (or refuses) each create. */
function realEffect(ledgerPath: string, create: IssueGateway["create"]) {
  return buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    config: { claudeBin: "/usr/bin/true", root: tmp("root") } as never,
    ledgerPath,
    runId: "SWEEP-W1-T5942",
    plan: { tasks: [] } as never,
    log: () => {},
    policy: undefined,
    reviewRunner: undefined,
    spawnImpl: undefined,
    pushEmptyCommit: undefined,
    issuesImpl: { create },
    stallNotice: undefined,
    armImpl: undefined,
    armSessionPrsOverride: undefined,
    updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined,
  }).escalateCancelledCheck!;
}

/** `n` deferred attempts: each bounding row followed by its 403 deferral (W1-T5920's shape). */
function deferrals(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => [
    { step: CHECK_REQUEUE_STEP, task_id: TASK, pr_number: PR, head_sha: HEAD, check_name: GATE },
    { step: CHECK_REQUEUE_DEFERRED_STEP, task_id: TASK, pr_number: PR, head_sha: HEAD, check_name: GATE,
      job_id: String(100 + i), refusal: "already_running", outcome: "deferred" },
  ]).flat();
}

/** One real sweep pass whose cancelled-check escalation goes through the production effect. */
async function pass(seed: Array<Record<string, unknown>>, create: IssueGateway["create"]) {
  const ledgerPath = join(tmp("ledger"), "ledger.ndjson");
  const requeued: string[] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => assert.fail("a cancelled check never spends a fix strike"),
    escalate: () => {},
    requeueCheck: (_pr, check) => {
      requeued.push(check.name);
      return true;
    },
    escalateCancelledCheck: realEffect(ledgerPath, create),
    readLedger: (p: string) => [...seed, ...readLedgerLines(p)],
    ledgerPath,
    runId: "SWEEP-W1-T5942",
    now: () => NOW,
  };
  await runSweep([view()], deps);
  return { requeued, rows: readLedgerLines(ledgerPath) };
}

function recorder() {
  const created: Array<{ title: string; body: string }> = [];
  const create: IssueGateway["create"] = (title, body) => {
    created.push({ title, body });
    return `https://github.com/craigoley/remudero/issues/${9500 + created.length}`;
  };
  return { created, create };
}

test("an escalation raised at the requeue-deferral backstop names the in-flight refusals in its title, not a second cancellation", async () => {
  const { created, create } = recorder();
  const { requeued } = await pass(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP), create);
  assert.deepEqual(requeued, [], "at the backstop nothing is POSTed");
  assert.equal(created.length, 1, "exactly one issue");
  const { title, body } = created[0];
  assert.ok(!title.includes(TWICE), `a backstop escalation must not claim a second cancellation — title was ${title}`);
  assert.match(title, new RegExp(`required check "${GATE}" requeue refused ${CHECK_REQUEUE_DEFERRAL_BACKSTOP} times while its run was in flight`));
  assert.ok(title.endsWith(`pull/${PR}`), "the PR stays named");
  assert.match(body, /GitHub refused the job rerun/, "the detail still carries the caller's reason");
  assert.match(body, /already_running/);
});

test("an escalation raised for a second cancellation keeps today's cancelled-twice title", async () => {
  const { created, create } = recorder();
  const spent = [{ step: CHECK_REQUEUE_STEP, task_id: TASK, pr_number: PR, head_sha: HEAD, check_name: GATE }];
  const { requeued } = await pass(spent, create);
  assert.deepEqual(requeued, [], "the one bounded requeue is already spent");
  assert.equal(created.length, 1);
  assert.equal(created[0].title, `[BLOCKED] ${TASK}: required check "${GATE}" ${TWICE} — https://github.com/craigoley/remudero/pull/${PR}`);
  assert.match(created[0].body, /already re-queued once/);
});

test("a caller naming no reason kind keeps the cancelled-twice summary", async () => {
  const { created, create } = recorder();
  await realEffect(join(tmp("legacy"), "ledger.ndjson"), create)(view(), { name: GATE, jobId: "1" }, "already re-queued once on this head sha");
  assert.equal(created.length, 1);
  assert.ok(created[0].title.includes(`"${GATE}" ${TWICE}`), created[0].title);
});

test("a backstop escalation whose issue create throws degrades to an escalation.failed row, never a thrown pass", async () => {
  const { rows } = await pass(deferrals(CHECK_REQUEUE_DEFERRAL_BACKSTOP), () => {
    throw new Error("gh issue create: HTTP 502");
  });
  const failed = rows.filter((r) => r.step === "escalation.failed");
  assert.equal(failed.length, 1, "the delivery failure is ledgered once");
  assert.equal(failed[0].task_id, TASK);
  assert.match(String(failed[0].error), /HTTP 502/);
  assert.ok(rows.some((r) => r.step === CHECK_REQUEUE_DEFERRED_STEP && r.outcome === "escalated"), "the bound still records it escalated");
  assert.ok(rows.some((r) => r.step === "sweep.disposed"), "the pass completed its disposition");
});
