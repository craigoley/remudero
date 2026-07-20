import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import {
  feedbackOriginTag,
  renderTraceChain,
  runsForTask,
  traceForward,
  traceReverse,
  type TraceGithub,
  type TracePrView,
} from "../src/lib/trace.js";

/** A fake TraceGithub driven by a fixture map, keyed by whatever ref was passed. */
function fakeGithub(byRef: Record<string, TracePrView>): TraceGithub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prView(ref) {
      calls.push(String(ref));
      return byRef[String(ref)] ?? null;
    },
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T43",
    title: "rmd trace <id>",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function feedback(over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: "fb-1000-abc123",
    ts: "2026-07-18T00:00:00.000Z",
    raw: "the drain retry banner overlaps the status pill",
    attachments: [],
    origin: "cli",
    status: "proposed",
    proposal_pr: null,
    ...over,
  };
}

function plan(tasks: Task[]) {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

// ── runsForTask ──────────────────────────────────────────────────────────────────

test("runsForTask: groups ledger lines by run_id, oldest first, and resolves each run's PR/sha", () => {
  const github = fakeGithub({
    "https://github.com/o/r/pull/10": { number: 10, url: "https://github.com/o/r/pull/10", state: "MERGED", mergeCommitSha: "deadbeef" },
  });
  const lines = [
    { run_id: "W1-T43-1", task_id: "W1-T43", step: "run.start" },
    { run_id: "W1-T43-1", task_id: "W1-T43", step: "verdict", verdict: "failed" },
    { run_id: "OTHER-TASK-1", task_id: "W1-T99", step: "verdict", verdict: "merged" }, // must not leak in
    { run_id: "W1-T43-2", task_id: "W1-T43", step: "pr.opened", pr_url: "https://github.com/o/r/pull/10" },
    { run_id: "W1-T43-2", task_id: "W1-T43", step: "verdict", verdict: "merged" },
  ];
  const runs = runsForTask(lines, "W1-T43", github);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, "W1-T43-1");
  assert.equal(runs[0].verdict, "failed");
  assert.equal(runs[0].prUrl, undefined);
  assert.equal(runs[1].runId, "W1-T43-2");
  assert.equal(runs[1].verdict, "merged");
  assert.equal(runs[1].prUrl, "https://github.com/o/r/pull/10");
  assert.equal(runs[1].prState, "MERGED");
  assert.equal(runs[1].mergeSha, "deadbeef");
});

test("runsForTask: a run with no verdict/pr.opened line still surfaces (verdict/prUrl undefined)", () => {
  const github = fakeGithub({});
  const lines = [{ run_id: "W1-T1-1", task_id: "W1-T1", step: "run.start" }];
  const runs = runsForTask(lines, "W1-T1", github);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].verdict, undefined);
  assert.equal(runs[0].prUrl, undefined);
});

test("runsForTask: an unresolvable pr_url (gh returns nothing) leaves prState/mergeSha undefined, never throws", () => {
  const github = fakeGithub({});
  const lines = [{ run_id: "W1-T1-1", task_id: "W1-T1", step: "pr.opened", pr_url: "https://github.com/o/r/pull/404" }];
  const runs = runsForTask(lines, "W1-T1", github);
  assert.equal(runs[0].prUrl, "https://github.com/o/r/pull/404");
  assert.equal(runs[0].prState, undefined);
  assert.equal(runs[0].mergeSha, undefined);
});

// ── traceForward ─────────────────────────────────────────────────────────────────

test("traceForward: feedback -> proposal PR -> task(s) carrying origin: feedback#<id> -> run(s) -> PR -> sha", () => {
  const entry = feedback({ id: "fb-1", proposal_pr: "https://github.com/o/r/pull/1" });
  const p = plan([
    task({ id: "W1-T50", origin: feedbackOriginTag("fb-1") }),
    task({ id: "W1-T51", origin: "architect" }), // must NOT be pulled into fb-1's chain
  ]);
  const github = fakeGithub({
    "https://github.com/o/r/pull/1": { number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED", mergeCommitSha: "propsha" },
    "https://github.com/o/r/pull/2": { number: 2, url: "https://github.com/o/r/pull/2", state: "MERGED", mergeCommitSha: "tasksha" },
  });
  const ledgerLines = [
    { run_id: "W1-T50-1", task_id: "W1-T50", step: "pr.opened", pr_url: "https://github.com/o/r/pull/2" },
    { run_id: "W1-T50-1", task_id: "W1-T50", step: "verdict", verdict: "merged" },
  ];
  const chain = traceForward(entry, { plan: p, ledgerLines, github });

  assert.equal(chain.direction, "forward");
  assert.equal(chain.feedback?.id, "fb-1");
  assert.equal(chain.feedback?.proposalPr, "https://github.com/o/r/pull/1");
  assert.equal(chain.feedback?.proposalPrState, "MERGED");
  assert.equal(chain.feedback?.proposalMergeSha, "propsha");
  assert.equal(chain.tasks.length, 1);
  assert.equal(chain.tasks[0].id, "W1-T50");
  assert.equal(chain.tasks[0].runs[0].mergeSha, "tasksha");
});

test("traceForward: a not-yet-triaged feedback entry (no proposal_pr, no tasks) renders an empty-but-valid chain", () => {
  const entry = feedback({ id: "fb-2", proposal_pr: null });
  const chain = traceForward(entry, { plan: plan([]), ledgerLines: [], github: fakeGithub({}) });
  assert.equal(chain.feedback?.proposalPr, undefined);
  assert.equal(chain.tasks.length, 0);
});

test("traceForward: only tasks whose origin is the EXACT feedback#<id> tag are pulled in (no prefix-sharing false credit)", () => {
  const entry = feedback({ id: "fb-1" });
  const p = plan([
    task({ id: "W1-T1", origin: "feedback#fb-1" }),
    task({ id: "W1-T2", origin: "feedback#fb-10" }), // shares a prefix — must not match
  ]);
  const chain = traceForward(entry, { plan: p, ledgerLines: [], github: fakeGithub({}) });
  assert.deepEqual(chain.tasks.map((t) => t.id), ["W1-T1"]);
});

// ── traceReverse ─────────────────────────────────────────────────────────────────

test("traceReverse: a feedback-originated task resolves back through origin: to its feedback entry + proposal PR", () => {
  const t = task({ id: "W1-T40", origin: feedbackOriginTag("fb-9") });
  const entry = feedback({ id: "fb-9", proposal_pr: "https://github.com/o/r/pull/9" });
  const github = fakeGithub({
    "https://github.com/o/r/pull/9": { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN" },
  });
  const chain = traceReverse(t, { plan: plan([t]), ledgerLines: [], github }, entry);
  assert.equal(chain.direction, "reverse");
  assert.equal(chain.feedback?.id, "fb-9");
  assert.equal(chain.feedback?.proposalPrState, "OPEN");
  assert.equal(chain.tasks.length, 1);
  assert.equal(chain.tasks[0].id, "W1-T40");
});

test("traceReverse: an architect-originated task has no feedback entry to resolve — chain.feedback stays undefined", () => {
  const t = task({ id: "W1-T41", origin: "architect" });
  const chain = traceReverse(t, { plan: plan([t]), ledgerLines: [], github: fakeGithub({}) });
  assert.equal(chain.feedback, undefined);
  assert.equal(chain.tasks[0].origin, "architect");
});

// ── renderTraceChain ─────────────────────────────────────────────────────────────

test("renderTraceChain: forward — prints feedback, proposal PR, task, run, PR, sha in order", () => {
  const chain = traceForward(
    feedback({ id: "fb-1", raw: "banner overlap", proposal_pr: "https://github.com/o/r/pull/1" }),
    {
      plan: plan([task({ id: "W1-T50", origin: feedbackOriginTag("fb-1") })]),
      ledgerLines: [
        { run_id: "W1-T50-1", task_id: "W1-T50", step: "pr.opened", pr_url: "https://github.com/o/r/pull/2" },
        { run_id: "W1-T50-1", task_id: "W1-T50", step: "verdict", verdict: "merged" },
      ],
      github: fakeGithub({
        "https://github.com/o/r/pull/1": { number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED", mergeCommitSha: "propsha" },
        "https://github.com/o/r/pull/2": { number: 2, url: "https://github.com/o/r/pull/2", state: "MERGED", mergeCommitSha: "tasksha" },
      }),
    },
  );
  const out = renderTraceChain(chain);
  const feedbackIdx = out.indexOf("feedback#fb-1");
  const proposalIdx = out.indexOf("proposal PR: https://github.com/o/r/pull/1");
  const propShaIdx = out.indexOf("sha propsha");
  const taskIdx = out.indexOf("task W1-T50");
  const runIdx = out.indexOf("run W1-T50-1");
  const prIdx = out.indexOf("PR https://github.com/o/r/pull/2");
  const shaIdx = out.indexOf("sha tasksha");
  assert.ok(out.includes('"banner overlap"'));
  assert.ok(
    feedbackIdx < proposalIdx &&
      proposalIdx < propShaIdx &&
      propShaIdx < taskIdx &&
      taskIdx < runIdx &&
      runIdx < prIdx &&
      prIdx < shaIdx,
    `expected feedback -> proposal PR -> sha -> task -> run -> PR -> sha order, got:\n${out}`,
  );
});

test("renderTraceChain: reverse — prints the task, its origin:, the resolved feedback entry, then its own runs", () => {
  const t = task({ id: "W1-T40", title: "some task", origin: feedbackOriginTag("fb-9") });
  const entry = feedback({ id: "fb-9", raw: "raw text", proposal_pr: "https://github.com/o/r/pull/9" });
  const chain = traceReverse(
    t,
    {
      plan: plan([t]),
      ledgerLines: [{ run_id: "W1-T40-1", task_id: "W1-T40", step: "verdict", verdict: "merged" }],
      github: fakeGithub({ "https://github.com/o/r/pull/9": { number: 9, url: "https://github.com/o/r/pull/9", state: "MERGED", mergeCommitSha: "sha9" } }),
    },
    entry,
  );
  const out = renderTraceChain(chain);
  const taskIdx = out.indexOf("task W1-T40");
  const originIdx = out.indexOf("origin: feedback#fb-9");
  const feedbackIdx = out.indexOf("feedback#fb-9");
  const runIdx = out.indexOf("run W1-T40-1");
  assert.ok(taskIdx < originIdx && originIdx < feedbackIdx && feedbackIdx < runIdx, `expected task -> origin -> feedback -> run order, got:\n${out}`);
});

test("renderTraceChain: reverse — a task with no origin: renders the provenance violation plainly, never guesses", () => {
  const t = task({ id: "W1-TX", origin: undefined });
  const chain = traceReverse(t, { plan: plan([t]), ledgerLines: [], github: fakeGithub({}) });
  const out = renderTraceChain(chain);
  assert.ok(out.includes("none recorded"));
});

test("renderTraceChain: an undispatched task (no runs) says so rather than printing an empty section", () => {
  const t = task({ id: "W1-TX", origin: "architect" });
  const chain = traceReverse(t, { plan: plan([t]), ledgerLines: [], github: fakeGithub({}) });
  const out = renderTraceChain(chain);
  assert.ok(out.includes("no runs yet"));
});
