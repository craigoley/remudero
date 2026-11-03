import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalFixDesignHandoff } from "#src/lib/sweep.js";

const HEAD = "7c6f773".padEnd(40, "a");
const URL = "https://github.com/craigoley/remudero/pull/15065";
const TASK = "W1-T10781";
const pr = { taskId: TASK, prNumber: 15065, prUrl: URL, headSha: HEAD };
const who = { run_id: "DAEMON-1", host: "h", actor_pid: 42 };
const base = { task_id: TASK, head_sha: HEAD, ...who, pr_number: 15065, repair_pr_url: URL };
const dispatch = { ...base, ts: "2026-10-28T08:20:00.000Z", step: "fix.dispatch", round_id: "r1" };
const done = { ...base, ts: "2026-10-28T08:20:27.000Z", step: "fix.done", fix_outcome: "NEEDS_DESIGN", round_id: "r1" };
const held = { ...base, ts: "2026-10-28T08:20:20.000Z", step: "fix.needs_design", reason: "needs a design call" };

test("W1-T11013: flow-review-failed-terminal-design-handoff-context-unavailable clears without a person", () => {
  // Rotation dropped the round's dispatch and done rows; only fix.needs_design survives in the live file.
  const live = [held];
  assert.equal(terminalFixDesignHandoff(pr, live).kind, "unavailable");
  const resolved = terminalFixDesignHandoff(pr, live, () => [dispatch, held, done]);
  assert.equal(resolved.kind, "handoff");
  if (resolved.kind === "handoff") assert.equal(resolved.roundId, "r1");
  // Rows truly absent from the union still read unavailable.
  assert.equal(terminalFixDesignHandoff(pr, live, () => [held]).kind, "unavailable");
  // An incomplete archive corpus stays unavailable.
  assert.equal(terminalFixDesignHandoff(pr, live, () => undefined).kind, "unavailable");
});
