import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StarvationCensus } from "../src/lib/daemon.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { appendLedger } from "../src/lib/ledger.js";
import type { Task } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  escalateCircuitBreak,
  escalateCrashLoop,
  escalateDiskHeadroomBreach,
  escalateHeadroomParkCeiling,
  escalateHeadroomReserve,
  escalateLifetimeCapExceeded,
  escalatePostReviewStall,
  escalateQuotaExhaustion,
  escalateStarvation,
  escalateStarvationCleared,
} from "../src/lib/escalation-catalogue.js";

interface CreatedIssue {
  title: string;
  body: string;
  labels: string[];
}

function withLedger<T>(name: string, fn: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}`));
  try {
    return fn(join(dir, "ledger.ndjson"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordingGateway(): IssueGateway & {
  created: CreatedIssue[];
  closed: Array<{ url: string; comment: string }>;
} {
  const created: CreatedIssue[] = [];
  const closed: Array<{ url: string; comment: string }> = [];
  return {
    created,
    closed,
    create(title, body, labels) {
      created.push({ title, body, labels });
      return `https://github.com/o/r/issues/${created.length}`;
    },
    closeWithComment(url, comment) {
      closed.push({ url, comment });
    },
  };
}

const task = { id: "W1-CAT", title: "catalogue", repo: "remudero" } as Task;
const ctx = (ledgerPath: string, issues: IssueGateway) => ({
  owner: "o",
  repo: "r",
  ledgerPath,
  runId: "RUN-CAT",
  issues,
});

const blockedAction = ["needs-human", "escalation-blocked", "needs-action"];

const starvationCensus: StarvationCensus = {
  circuitBroken: { count: 1, ids: ["W1-CB"], truncated: 0 },
  blocked: { count: 0, ids: [], truncated: 0 },
  unmetDeps: { count: 1, ids: ["W1-DEP"], truncated: 0 },
  retired: { count: 0, ids: [], truncated: 0 },
};

const openingCases: Array<{
  name: string;
  run: (ledgerPath: string, issues: IssueGateway) => void;
  title: string;
  labels: string[];
}> = [
  {
    name: "escalateCircuitBreak",
    run: (ledgerPath, issues) => escalateCircuitBreak(task, ctx(ledgerPath, issues)),
    title: "[BLOCKED] W1-CAT: W1-CAT: dispatch circuit breaker tripped — repeated dispatch with no new owned PR",
    labels: blockedAction,
  },
  {
    name: "escalateLifetimeCapExceeded",
    run: (ledgerPath, issues) => escalateLifetimeCapExceeded(task, ctx(ledgerPath, issues)),
    title: "[BLOCKED] W1-CAT: W1-CAT: lifetime dispatch cap exceeded — dispatched 10+ times, ever",
    labels: blockedAction,
  },
  {
    name: "escalateCrashLoop",
    run: (ledgerPath, issues) =>
      escalateCrashLoop(
        {
          breached: true,
          windowBoots: ["2026-09-08T00:00:00.000Z", "2026-09-08T00:05:00.000Z"],
          windowMs: 10 * 60_000,
          maxBoots: 1,
        },
        ctx(ledgerPath, issues),
      ),
    title: "[BLOCKED] DAEMON: daemon crash-loop: 2 boots inside 10 minutes",
    labels: blockedAction,
  },
  {
    name: "escalatePostReviewStall",
    run: (ledgerPath, issues) =>
      escalatePostReviewStall(
        {
          stalled: true,
          consecutiveFailures: 8,
          oldestFailureTs: "2026-09-08T00:00:00.000Z",
          newestFailureTs: "2026-09-08T00:07:00.000Z",
          normalisedError: "GraphQL rate limit for PR <N>",
          rateLimited: true,
        },
        ctx(ledgerPath, issues),
      ),
    title: "[BLOCKED] DAEMON: post-review stalled: 8 consecutive failures, no review posted",
    labels: blockedAction,
  },
  {
    name: "escalateHeadroomReserve",
    run: (ledgerPath, issues) =>
      escalateHeadroomReserve(
        { window: "session (5h)", percentUsed: 99, limitPct: 95, resetsAt: "2026-09-08T05:00:00.000Z" },
        ctx(ledgerPath, issues),
      ),
    title: "[HARD_STOP] daemon: session (5h) headroom reserve reached — dispatch paused until 2026-09-08T05:00:00.000Z",
    labels: ["needs-human", "escalation-hard-stop", "needs-question"],
  },
  {
    name: "escalateDiskHeadroomBreach",
    run: (ledgerPath, issues) =>
      escalateDiskHeadroomBreach(
        { freeBytes: 1024 * 1024 * 1024, verdict: "WARN", ts: "2026-09-08T00:00:00.000Z" },
        ctx(ledgerPath, issues),
      ),
    title: "[BLOCKED] DAEMON: disk headroom WARN: 1.0GiB free",
    labels: blockedAction,
  },
  {
    name: "escalateHeadroomParkCeiling",
    run: (ledgerPath, issues) =>
      escalateHeadroomParkCeiling({ consecutiveUnreadable: 3, parkedMs: 30 * 60_000, ceilingMs: 30 * 60_000 }, ctx(ledgerPath, issues)),
    title: "[MANUAL] daemon: headroom unreadable for 30m — dispatching BLIND past the park ceiling",
    labels: ["needs-human", "escalation-manual", "needs-action"],
  },
  {
    name: "escalateQuotaExhaustion",
    run: (ledgerPath, issues) =>
      escalateQuotaExhaustion({ bucket: "graphql", remaining: 0, resetsAt: "2026-09-08T01:00:00.000Z" }, ctx(ledgerPath, issues)),
    title: "[HARD_STOP] daemon: gh api rate_limit graphql bucket exhausted — resets 2026-09-08T01:00:00.000Z",
    labels: ["needs-human", "escalation-hard-stop", "needs-action"],
  },
  {
    name: "escalateStarvation",
    run: (ledgerPath, issues) => escalateStarvation(starvationCensus, ctx(ledgerPath, issues)),
    title: "[BLOCKED] daemon: dispatch queue starved — zero dispatchable, 2 recoverable class(es) blocking",
    labels: blockedAction,
  },
];

for (const c of openingCases) {
  test(`${c.name}: renders the moved catalogue title and labels through a recording gateway`, () => {
    withLedger(`rmd-escalation-catalogue-${c.name}-`, (ledgerPath) => {
      const issues = recordingGateway();

      c.run(ledgerPath, issues);

      assert.equal(issues.created.length, 1);
      assert.equal(issues.created[0].title, c.title);
      assert.deepEqual(issues.created[0].labels, c.labels);
      assert.match(issues.created[0].body, /\*\*Run:\*\* RUN-CAT/);
    });
  });
}

test("escalateStarvationCleared: closes the moved catalogue issue through a recording gateway", () => {
  withLedger("rmd-escalation-catalogue-cleared-", (ledgerPath) => {
    const issues = recordingGateway();
    appendLedger(ledgerPath, {
      run_id: "RUN-OLD",
      task_id: "daemon",
      step: "dispatch.starvation.escalated",
      issue_url: "https://github.com/o/r/issues/99",
    });

    escalateStarvationCleared({ reason: "dispatchable-task", taskId: "W1-NEXT" }, ctx(ledgerPath, issues));

    assert.deepEqual(issues.created, []);
    assert.equal(issues.closed.length, 1);
    assert.deepEqual(issues.closed[0], {
      url: "https://github.com/o/r/issues/99",
      comment:
        "oper#queue-starvation-2026-08-03: this starvation episode has ended — " +
        "a dispatchable task appeared (W1-NEXT) and ended the episode. Closing automatically; " +
        "a fresh episode opens its own issue if the queue starves again.",
    });
  });
});
