// W1-T10148: a proof runner that cannot collect the named test used to refuse the PR, count as a
// worker strike, and dispatch again against the unchanged runner. Keep the refusal evidence, but
// hold that task until its runner config or its filed contract changes.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EscalateDeps } from "#src/lib/escalate.js";
import {
  preDispatchContractRevision,
  runnerConfigDigest,
  terminalPreDispatchRefusalRevisions,
  writePriorRefusal,
} from "#src/lib/dispatch-repair.js";
import { runnableCandidates } from "#src/lib/drain.js";
import { streakRefusal } from "#src/lib/non-worker-verdict.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { PrOpenRefusedError, recordRefusedPrOpen } from "#src/lib/pr-open.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const TASK: Task = {
  id: "W1-T10148", title: "a scout refusal task", repo: "remudero", type: "implement", verify: "auto", risk: "low",
  attempts: 0, depends_on: [], status: "queued",
} as Task;

test("W1-T10148: pr.open_refused no longer recurs", (t: TestContext) => {
  const origin = gitRepo({ kind: "scout-refusal-origin", scope: t });
  const initialConfig = 'export default { test: { include: ["tests/**/*.test.ts"] } };\n';
  mkdirSync(join(origin.dir, "tests", "unit"), { recursive: true });
  writeFileSync(join(origin.dir, "vitest.config.cts"), initialConfig);
  writeFileSync(join(origin.dir, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
  writeFileSync(join(origin.dir, "tests", "unit", "timeline.test.tsx"),
    'test("W1-T10148: fixture leaf", () => {});\n');
  origin.git("add", "-A");
  origin.git("commit", "-qm", "chore: runner cannot collect the named test");

  const checkout = gitRepo({ kind: "scout-refusal-checkout", cloneFrom: origin.dir, scope: t });
  const state = ownedFixtureDir(t, "scout-refusal-state").dir;
  const originalDigest = runnerConfigDigest(checkout.dir);
  assert.ok(originalDigest, "the refused run records the runner config it used");

  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const issueUrl = recordRefusedPrOpen(
    new PrOpenRefusedError(
      "proof-collected-nothing",
      "the runner collected no tests from tests/unit/timeline.test.tsx",
      undefined,
      undefined,
      originalDigest,
      { proof: "unit test: W1-T10148: fixture leaf", status: 3, detail: "1..0" },
    ),
    { taskId: TASK.id, branch: "run-W1-T10148-1", headSha: "abc123" },
    (step, extra) => rows.push({ step, extra }),
    {} as EscalateDeps,
  );

  assert.equal(issueUrl, null);
  assert.equal(rows.length, 1, "the initial refusal stays visible");
  assert.equal(rows[0]?.step, "pr.open_refused");
  assert.equal(rows[0]?.extra?.refusal_class, "proof-collected-nothing");
  assert.equal(rows[0]?.extra?.runner_config_digest, originalDigest);
  assert.equal(streakRefusal({
    task_id: TASK.id,
    stage: "pr_open.refused",
    cause: "base-proof-refused",
    refusal_class: "proof-collected-nothing",
  }), undefined, "runner scope is not counted as a worker strike");

  writePriorRefusal(state, TASK.id, {
    verdict: "proof-collected-nothing: tests/unit/timeline.test.tsx",
    attempts: 1,
    escalated: true,
    preDispatchContractRevision: preDispatchContractRevision(TASK),
    runnerConfigDigest: originalDigest,
  });
  const select = () => {
    const held = terminalPreDispatchRefusalRevisions(state, () => runnerConfigDigest(checkout.dir, "origin/main"));
    const plan: Plan = { tasks: [TASK], byId: new Map([[TASK.id, TASK]]) };
    const filtered: string[] = [];
    const candidates = runnableCandidates(plan, () => false, 1, {
      isTerminalPreDispatchRefusalHeld: (candidate) => held.get(candidate.id) === preDispatchContractRevision(candidate),
      onFiltered: (_candidate, reason) => filtered.push(reason),
    });
    return { tasks: candidates.map((candidate) => candidate.id), filtered };
  };

  assert.deepEqual(select(), { tasks: [], filtered: ["held-pre-dispatch-refusal"] },
    "the unchanged runner cannot produce another refused PR on the next dispatch pass");

  writeFileSync(join(origin.dir, "vitest.config.cts"), 'export default { test: { include: ["tests/**/*.test.{ts,tsx}"] } };\n');
  origin.git("add", "vitest.config.cts");
  origin.git("commit", "-qm", "fix: include the task's test extension");
  checkout.git("fetch", "-q", "origin");
  assert.notEqual(runnerConfigDigest(checkout.dir, "origin/main"), originalDigest,
    "the fixed main runner has a new cause-specific digest");
  assert.deepEqual(select(), { tasks: [TASK.id], filtered: [] },
    "the task is released when main fixes the runner scope, without hiding the refusal row");
});
