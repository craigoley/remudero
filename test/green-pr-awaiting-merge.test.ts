import assert from "node:assert/strict";
import { test } from "node:test";

import { reasonAboutBlock, verdictIsFixable } from "../src/lib/block-reason.js";
import { haltsDrain, NON_HALTING_VERDICTS, runDrain, type MergedSet } from "../src/lib/drain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml, unmetDependencies, type Plan, type Task } from "../src/lib/plan.js";
import { pollToGate, STALL_WINDOW, type RunResult } from "../src/run-task.js";

const PR_URL = "https://github.com/acme/remudero/pull/3662";
const HEAD_SHA = "abc3662";

type LoggedLine = { step: string; extra: Record<string, unknown> };

function planYaml(tasks: string): Plan {
  return loadPlanFromYaml(tasks, "green-pr-awaiting-merge-fixture");
}

function task(id: string, depends_on: string[] = []): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on,
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
    files: [],
    acceptance: [],
  } as unknown as Task;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

function fakeRestPoll(opts: {
  checkRuns: Array<{ name: string; status: string; conclusion?: string | null }>;
  statuses?: Array<{ context: string; state: string }>;
  pullStates?: string[];
}): { readJson: (args: string[]) => Promise<unknown>; calls: string[] } {
  const calls: string[] = [];
  let pullReads = 0;
  return {
    calls,
    readJson: async (args: string[]) => {
      const route = args[1] ?? "";
      calls.push(route);
      if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(route)) {
        const state = opts.pullStates?.[Math.min(pullReads, opts.pullStates.length - 1)] ?? "open";
        pullReads += 1;
        const merged = state === "merged";
        return {
          number: 3662,
          html_url: PR_URL,
          state: merged ? "closed" : state,
          merged,
          merged_at: merged ? "2026-09-02T14:14:53Z" : null,
          updated_at: "2026-09-02T14:14:23Z",
          head: { ref: "run-W1-T2714-1788811315024", sha: HEAD_SHA },
        };
      }
      if (/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs/.test(route)) {
        return { check_runs: opts.checkRuns };
      }
      if (/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/.test(route)) {
        return { statuses: opts.statuses ?? [{ context: "remudero-review", state: "success" }] };
      }
      throw new Error(`unexpected fake gh route: ${route}`);
    },
  };
}

test("pollToGate: five unchanged green terminal polls with no pending checks return awaiting_merge, not blocked_ci", async () => {
  const logs: LoggedLine[] = [];
  const fake = fakeRestPoll({
    checkRuns: [
      { name: "ci", status: "completed", conclusion: "success" },
      { name: "osv-scanner", status: "completed", conclusion: "neutral" },
    ],
  });

  const outcome = await pollToGate(
    PR_URL,
    (step, extra = {}) => logs.push({ step, extra }),
    0,
    { readJson: fake.readJson, sleep: async () => {} },
  );

  assert.equal(outcome.merged, false, "an armed green open PR is not credited as merged");
  assert.equal(outcome.verdict, "awaiting_merge");
  assert.equal(outcome.reason, `all observed checks terminal green for ${STALL_WINDOW} consecutive polls; awaiting GitHub merge`);
  assert.equal(outcome.headSha, HEAD_SHA);
  assert.deepEqual(outcome.checks, ["ci:SUCCESS", "osv-scanner:NEUTRAL", "remudero-review:SUCCESS"]);
  assert.equal(fake.calls.filter((route) => /pulls\/3662$/.test(route)).length, STALL_WINDOW);

  const stalled = logs.find((l) => l.step === "pr.stalled");
  assert.ok(stalled, "the terminal poll evidence is ledgered");
  assert.deepEqual(stalled.extra.pending, []);
  assert.equal(stalled.extra.verdict, "awaiting_merge");
  assert.equal(stalled.extra.reason, outcome.reason);
  assert.equal(stalled.extra.head_sha, HEAD_SHA);
  assert.deepEqual(stalled.extra.checks, outcome.checks);
  assert.equal(JSON.stringify(stalled.extra).includes("token"), false, "bounded evidence carries no credential-looking field");
});

test("pollToGate: a pending quiescent rollup and a red terminal check still return blocked_ci", async () => {
  const pending = fakeRestPoll({
    checkRuns: [{ name: "ci", status: "queued", conclusion: null }],
    statuses: [{ context: "remudero-review", state: "success" }],
  });
  const pendingOutcome = await pollToGate(PR_URL, () => {}, 0, { readJson: pending.readJson, sleep: async () => {} });
  assert.equal(pendingOutcome.merged, false);
  assert.equal(pendingOutcome.verdict, "blocked_ci");
  assert.equal(pendingOutcome.reason, `no progress for ${STALL_WINDOW} consecutive polls — still pending: ci`);

  const red = fakeRestPoll({
    checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }],
    statuses: [{ context: "remudero-review", state: "success" }],
  });
  const redOutcome = await pollToGate(PR_URL, () => {}, 0, { readJson: red.readJson, sleep: async () => {} });
  assert.equal(redOutcome.merged, false);
  assert.equal(redOutcome.verdict, "blocked_ci");
  assert.equal(redOutcome.reason, "required check red: ci");
  assert.equal(red.calls.filter((route) => /pulls\/3662$/.test(route)).length, 1, "red still blocks immediately");
});

test("awaiting_merge is non-crediting and does not release dependents until a later material merge projection", async () => {
  const p = plan([task("A"), task("B", ["A"])]);
  const awaiting: RunResult = {
    taskId: "A",
    runId: "R-A",
    merged: false,
    verdict: "awaiting_merge",
    prUrl: PR_URL,
    costUsd: 0.5,
  };

  assert.equal(awaiting.merged, false);
  assert.equal(haltsDrain(awaiting), false);
  assert.equal(NON_HALTING_VERDICTS.has("awaiting_merge"), true);
  assert.deepEqual(unmetDependencies(p, p.byId.get("B")!, () => false), ["A"]);
  assert.deepEqual(unmetDependencies(p, p.byId.get("B")!, (t) => t.id === "A"), []);
});

test("single-lane and parallel drain continue past awaiting_merge without re-offering or crediting it", async () => {
  const p = plan([task("A"), task("C")]);
  const merged = new Set<string>();
  const calls: string[] = [];
  const deps = {
    refreshMerged: (): MergedSet => (id) => merged.has(id),
    runOne: async (id: string): Promise<RunResult> => {
      calls.push(id);
      if (id === "A") {
        return { taskId: id, runId: "R-A", merged: false, verdict: "awaiting_merge", prUrl: PR_URL, costUsd: 0.5 };
      }
      merged.add(id);
      return { taskId: id, runId: "R-C", merged: true, verdict: "merged", costUsd: 0.5 };
    },
    log: () => {},
  };

  const single = await runDrain(p, deps, { max: 3 });
  assert.deepEqual(calls, ["A", "C"]);
  assert.deepEqual(single.merged, ["C"]);
  assert.deepEqual(single.continued, [{ taskId: "A", verdict: "awaiting_merge", prUrl: PR_URL }]);

  const laneCalls: string[] = [];
  const laneMerged = new Set<string>();
  const laneDeps = {
    refreshMerged: (): MergedSet => (id) => laneMerged.has(id),
    runOne: async (id: string): Promise<RunResult> => {
      laneCalls.push(id);
      if (id === "A") {
        return { taskId: id, runId: "R-A", merged: false, verdict: "awaiting_merge", prUrl: PR_URL, costUsd: 0.5 };
      }
      laneMerged.add(id);
      return { taskId: id, runId: "R-C", merged: true, verdict: "merged", costUsd: 0.5 };
    },
    log: () => {},
  };
  const parallel = await runDrain(p, laneDeps, { max: 2, laneCount: 2 });
  assert.deepEqual(laneCalls.sort(), ["A", "C"]);
  assert.equal(parallel.stopReason, "max_reached");
  assert.deepEqual(parallel.merged, ["C"]);
  assert.deepEqual(parallel.continued, [{ taskId: "A", verdict: "awaiting_merge", prUrl: PR_URL }]);
});

test("daemon processing continues past awaiting_merge without retrying implementation or spending a fix strike", async () => {
  const p = planYaml(`
- id: A
  title: awaiting
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: C
  title: independent
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`);
  const calls: string[] = [];
  const merged = new Set<string>();
  const logs: LoggedLine[] = [];
  let fixDispatches = 0;

  const summary = await runDaemon(
    p,
    {
      refreshMerged: () => (id) => merged.has(id),
      isOpenPr: (id) => (id === "A" && calls.includes("A") ? 3662 : undefined),
      runOne: async (id): Promise<RunResult> => {
        calls.push(id);
        if (id === "A") {
          return { taskId: id, runId: "R-A", merged: false, verdict: "awaiting_merge", prUrl: PR_URL, costUsd: 0.5 };
        }
        merged.add(id);
        return { taskId: id, runId: "R-C", merged: true, verdict: "merged", costUsd: 0.5 };
      },
      dispatchFix: async () => {
        fixDispatches += 1;
      },
      sleep: async () => {},
      log: (step, extra = {}) => logs.push({ step, extra }),
    },
    { max: 2 },
  );

  assert.deepEqual(calls, ["A", "C"], "the awaiting task is not retried in the next tick once the open PR projection sees it");
  assert.equal(fixDispatches, 0, "awaiting_merge never spends the blocked_ci fix rung");
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(summary.merged, ["C"]);
  assert.ok(logs.some((l) => l.step === "daemon.block.awaiting_merge"));
  assert.equal(logs.some((l) => l.step === "daemon.block.fixable_dispatch"), false);
  assert.equal(verdictIsFixable("awaiting_merge"), false);
  assert.deepEqual(reasonAboutBlock(p, "A", "awaiting_merge"), { kind: "awaiting_merge" });
});
