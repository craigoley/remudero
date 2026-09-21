// W1-T3688 — PORTAL-T12 was dispatched a SECOND time while its first pull request was open on a
// canonical `run-<taskId>-<epochMs>` branch: the head form `projectPlan` indexes was present and
// correct (13:50:38 PR #43 opened; 13:55:25 a second run dispatched, #43 still open), and two
// lanes built the same module independently. This suite proves the fix end to end through the
// REAL `projectPlan` attribution (never a hand-rolled `isOpenPr` stub) — the same composition
// `run-task.ts`'s drain/daemon wiring builds `isOpenPr` from (`p?.prState === "OPEN" ? p.prNumber
// : undefined`) — so a gap in that wiring, not just in `isDispatchEligible` itself, would redden
// here exactly as it would have on 2026-09-16.
//
// W1-T3722 later corrected this task's DIAGNOSIS (not its incident): the hold this suite proves
// has existed since 2026-07-17 (#159), and PR #5843 measured this exact suite passing 4 of 4 on
// unmodified main. What actually let PORTAL-T12 through was a narrower mid-cycle window, closed
// separately under W1-T3722 (see test/drain.test.ts's "mid-cycle" cases). This suite is kept as
// the honest, direct characterization of the hold W1-T3688's acceptance criteria name — none of
// its four proof strings existed anywhere in the tree before this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRunnable, type OpenPrCheck } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { projectPlan, type GitHub, type PrRef, type StatusProjection } from "../src/lib/status.js";

const TASK_ID = "W1-T3688";
const RUN_BRANCH = `run-${TASK_ID}-1789566397746`;

function task(): Task {
  return {
    id: TASK_ID,
    title: TASK_ID,
    repo: "remudero",
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    depends_on: [],
    files: ["src/lib/drain.ts"],
  } as Task;
}

function plan(): Plan {
  const t = task();
  return { tasks: [t], byId: new Map([[t.id, t]]) } as Plan;
}

/** Projects `TASK_ID` the same way `run-task.ts`'s drain/daemon wiring does: one batched
 *  `listOpenHeadBranches` read, corroborated by the canonical run-shaped head, never a trailer. */
function project(openRows: PrRef[]): { projection: StatusProjection; listCalls: number } {
  let listCalls = 0;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => {
      listCalls++;
      return openRows;
    },
    headRefName: (url) => openRows.find((pr) => pr.url === url)?.headRefName,
    prBody: (url) => openRows.find((pr) => pr.url === url)?.body,
    changedFiles: () => [],
  } as GitHub;
  const projection = projectPlan(plan(), {
    ledgerPath: "/nonexistent/w1-t3688-ledger.ndjson",
    readLedger: () => [],
    github,
  }).get(TASK_ID)!;
  return { projection, listCalls };
}

function ownRunBranchPr(over: Partial<PrRef> = {}): PrRef {
  return {
    number: 43,
    url: "https://github.com/craigoley/remudero/pull/43",
    state: "OPEN",
    headRefName: RUN_BRANCH,
    title: "feat: build the task",
    body: "## Acceptance\n\nsome PR body with no trailer at all",
    ...over,
  };
}

/** The SAME derivation `run-task.ts`'s `drainCommand`/`daemonCommand` use to build `isOpenPr` from
 *  a `projectPlan` snapshot (`p?.prState === "OPEN" ? p.prNumber : undefined`) — no second matcher. */
function isOpenPrFrom(projection: StatusProjection): OpenPrCheck {
  return (id) => (id === projection.taskId && projection.prState === "OPEN" ? projection.prNumber : undefined);
}

test("unit test: a task with an open run branch pr is not dispatched", () => {
  const { projection, listCalls } = project([ownRunBranchPr()]);

  assert.equal(projection.prState, "OPEN", "the canonical run-shaped head is indexed as an OPEN credit");
  assert.equal(projection.prNumber, 43);
  assert.equal(listCalls, 1, "one batched open-board read, no second matcher");

  const next = nextRunnable(plan(), () => false, {
    isOpenPr: isOpenPrFrom(projection),
    onSkip: () => {},
  });
  assert.equal(next, undefined, "PORTAL-T12's own open PR holds the task out of dispatch — no second lane");
});

test("unit test: a closed unmerged pr releases its task", () => {
  const open = project([ownRunBranchPr()]).projection;
  const closed = project([ownRunBranchPr({ state: "CLOSED" })]).projection;

  assert.equal(
    nextRunnable(plan(), () => false, { isOpenPr: isOpenPrFrom(open), onSkip: () => {} }),
    undefined,
    "the open PR holds dispatch",
  );
  assert.equal(closed.prState, undefined, "a closed-unmerged PR creates no stale OPEN credit");
  assert.equal(
    nextRunnable(plan(), () => false, { isOpenPr: isOpenPrFrom(closed), onSkip: () => assert.fail("no skip expected") })
      ?.id,
    TASK_ID,
    "the hold ends the moment the pull request does, with no timer and no threshold",
  );
});

test("unit test: the hold refusal names the pull request", () => {
  const { projection } = project([ownRunBranchPr()]);
  const skips: Array<{ id: string; prNumber: number }> = [];

  const next = nextRunnable(plan(), () => false, {
    isOpenPr: isOpenPrFrom(projection),
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
  });

  assert.equal(next, undefined);
  assert.deepEqual(
    skips,
    [{ id: TASK_ID, prNumber: 43 }],
    "the refusal names #43 — a held task is distinguishable from a broken queue, never a bare decline",
  );
});

test("unit test: a task with no open pr is unaffected", () => {
  const { projection, listCalls } = project([]);

  assert.equal(projection.prState, undefined, "no PR at all ⇒ no OPEN credit");
  assert.equal(listCalls, 1, "the ordinary path takes no read beyond the projection dispatch already builds");

  const next = nextRunnable(plan(), () => false, {
    isOpenPr: isOpenPrFrom(projection),
    onSkip: () => assert.fail("no skip expected — nothing holds this task"),
  });
  assert.equal(next?.id, TASK_ID, "dispatches exactly as it does today");
});
