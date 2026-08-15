// test/human-verify-queue-surfaces.test.ts — W1-T507
//
// THE GAP THIS PROVES CLOSED. Every `verify: human` site in `src/` (`isDispatchEligible` in
// `src/lib/drain.ts`, `assertRunnable` in `src/lib/plan.ts`, three `task-linter.ts` predicates)
// treats `task.verify === "human"` as an EXCLUSION from machine dispatch and nothing else.
// `projectPlan` (`src/lib/status.ts`) used to set `needsHuman` from exactly one source — an OPEN
// escalation issue — so a `verify: human` task, which is never dispatched and therefore never
// escalates, set no flag anywhere and rendered in no section of the console. This file proves
// the new `verifyHumanPending` sparse field (status.ts) closes that gap on the projection layer,
// without widening `needsHuman` itself and without disturbing the escalation row it already
// backs — the two wrong fixes the task's own design section names and rejects.
//
// Self-contained fixtures: deliberately NOT importing test/status.test.ts's own `task`/
// `fakeGitHub` helpers (a shared corpus was the coverage-channel lesson this task's own plan
// record generalizes away from) — every fixture here is the minimum shape each assertion needs.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { deriveStatus, projectPlan, type GitHub, type PrRef } from "../src/lib/status.js";

/** A minimal task; fields not under test get sensible defaults, mirroring test/status.test.ts's
 *  own convention (`verify: "auto"` by default — a test opts into `verify: "human"` explicitly). */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — deriveStatus/projectPlan must NOT trust this
    attempts: 0,
    ...over,
  };
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** A minimal GitHub fixture — only the four REQUIRED GitHub methods, plus the optional
 *  trailer-credit/head/body maps the one merged-credit test needs. */
function fakeGitHub(
  opts: {
    byTrailer?: Record<string, PrRef>;
    headByUrl?: Record<string, string>;
    bodyByUrl?: Record<string, string>;
  } = {},
): GitHub {
  return {
    prByRef() {
      return null;
    },
    findMergedByTrailer(taskId) {
      return opts.byTrailer?.[taskId] ?? null;
    },
    headRefName(url) {
      return opts.headByUrl?.[url];
    },
    prBody(url) {
      return opts.bodyByUrl?.[url];
    },
  };
}

test("a verify human task appears in the needs-me projection", () => {
  const p = plan([task({ id: "W1-T900", verify: "human" })]);
  const deps = { ledgerPath: "/dev/null", github: fakeGitHub(), readLedger: () => [] };
  const byId = projectPlan(p, deps);
  assert.equal(
    byId.get("W1-T900")?.verifyHumanPending,
    true,
    "a task filed verify: human, uncredited, must reach the projection as pending",
  );
});

test("the projection names why a row needs a human", () => {
  const issueUrl = "https://github.com/o/r/issues/501";
  const p = plan([task({ id: "W1-T901", verify: "human" }), task({ id: "W1-T902", verify: "auto" })]);
  const lines = [
    { run_id: "r1", task_id: "W1-T902", step: "run.start" },
    { run_id: "r1", task_id: "W1-T902", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
  ];
  const deps = { ledgerPath: "/dev/null", github: fakeGitHub(), readLedger: () => lines };
  const byId = projectPlan(p, deps);
  const verifyRow = byId.get("W1-T901");
  const escalationRow = byId.get("W1-T902");
  // The two reasons a row needs a person are carried on two DISTINCT fields, never flattened
  // into the same `needsHuman` flag — a caller (the console) can tell them apart by NAME.
  assert.equal(verifyRow?.verifyHumanPending, true, "the verify:human row names its own reason");
  assert.equal(verifyRow?.needsHuman, undefined, "a verify:human row is never widened into needsHuman");
  assert.equal(escalationRow?.needsHuman, true, "the escalated task keeps naming ITS own reason");
  assert.equal(escalationRow?.verifyHumanPending, undefined, "an escalation row never carries the verify kind");
});

test("a merged verify human task is not offered as outstanding", () => {
  const mergedUrl = "https://github.com/o/r/pull/777";
  const github = fakeGitHub({
    byTrailer: { "W1-T903": { number: 777, url: mergedUrl, state: "MERGED" } },
    headByUrl: { [mergedUrl]: "run-W1-T903-1786800000000" },
    bodyByUrl: { [mergedUrl]: "Remudero-Task: W1-T903" },
  });
  const p = plan([task({ id: "W1-T903", verify: "human" })]);
  const deps = { ledgerPath: "/dev/null", github, readLedger: () => [] };
  const byId = projectPlan(p, deps);
  const row = byId.get("W1-T903");
  assert.equal(row?.merged, true, "sanity: the fixture actually credits the task merged, via the anchored trailer");
  assert.equal(row?.verifyHumanPending, undefined, "a credited-merged verify:human task is not outstanding work");
});

test("an escalation row keeps its existing affordance", () => {
  const issueUrl = "https://github.com/o/r/issues/502";
  const lines = [
    { run_id: "r1", task_id: "W1-T904", step: "run.start" },
    {
      run_id: "r1",
      task_id: "W1-T904",
      step: "escalation.issue_opened",
      issue_url: issueUrl,
      class: "BLOCKED",
      ts: "2026-08-15T00:00:00.000Z",
    },
  ];
  const p = plan([task({ id: "W1-T904", verify: "auto" })]);
  const deps = { ledgerPath: "/dev/null", github: fakeGitHub(), readLedger: () => lines };
  const byId = projectPlan(p, deps);
  const row = byId.get("W1-T904");
  // Byte-identical to the pre-W1-T507 fields the escalation row's own template
  // (serve.ts's needsMeTaskRowHtml, untouched by this task) renders "view issue"/"mark handled"
  // from — this task adds a NEW field elsewhere, it does not touch any of these.
  assert.equal(row?.needsHuman, true);
  assert.equal(row?.escalationIssueUrl, issueUrl);
  assert.equal(row?.escalationOpenedAt, "2026-08-15T00:00:00.000Z");
  assert.equal(row?.verifyHumanPending, undefined, "an escalation row never also carries the verify kind");

  // Cross-checked against the standalone deriveStatus path too (the same invariant
  // test/status.test.ts's own W1-T187 criterion 4 asserts for the non-escalation case) — the
  // escalation fields are set inside deriveStatus itself, untouched by this task's
  // projectPlan-level addition.
  const standalone = deriveStatus(task({ id: "W1-T904", verify: "auto" }), deps);
  assert.equal(standalone.needsHuman, true);
  assert.equal(standalone.escalationIssueUrl, issueUrl);
});
