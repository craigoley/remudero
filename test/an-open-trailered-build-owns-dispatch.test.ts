import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRunnable } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { projectPlan, type GitHub, type PrRef, type StatusProjection } from "../src/lib/status.js";

const TASK_ID = "W1-T3219";
const TASK_FILES = ["src/lib/status.ts", "test/an-open-trailered-build-owns-dispatch.test.ts"];

function task(): Task {
  return {
    id: TASK_ID,
    title: TASK_ID,
    repo: "remudero",
    type: "implement",
    verify: "auto",
    risk: "high",
    status: "queued",
    attempts: 0,
    depends_on: [],
    files: TASK_FILES,
  } as Task;
}

function plan(): Plan {
  const t = task();
  return { tasks: [t], byId: new Map([[t.id, t]]) } as Plan;
}

function project(openRows: PrRef[], changedFiles: string[] = TASK_FILES): {
  projection: StatusProjection;
  listCalls: number;
  changedFileCalls: number;
} {
  let listCalls = 0;
  let changedFileCalls = 0;
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
    changedFiles: () => {
      changedFileCalls++;
      return changedFiles;
    },
  } as GitHub;
  const projection = projectPlan(plan(), {
    ledgerPath: "/nonexistent/w1-t3219-ledger.ndjson",
    readLedger: () => [],
    github,
  }).get(TASK_ID)!;
  return { projection, listCalls, changedFileCalls };
}

function foreignPr(over: Partial<PrRef> = {}): PrRef {
  return {
    number: 4729,
    url: "https://github.com/craigoley/remudero/pull/4729",
    state: "OPEN",
    headRefName: "run-W1-T3219-build",
    title: "feat: build the task",
    body: `## Acceptance\n\nRemudero-Task: ${TASK_ID}`,
    ...over,
  };
}

function nextFrom(projection: StatusProjection): Task | undefined {
  return nextRunnable(plan(), () => false, {
    isOpenPr: (id) =>
      id === projection.taskId && projection.prState === "OPEN" ? projection.prNumber : undefined,
  });
}

test("W1-T3219 criterion 1 and W1-T3219 criterion 7: an exact trailer indexes an OPEN PR whose branch does not own the task", () => {
  const { projection, listCalls, changedFileCalls } = project([foreignPr()]);

  assert.equal(projection.prState, "OPEN");
  assert.equal(projection.prNumber, 4729);
  assert.equal(projection.source, "head-branch", "the existing open corroboration projection is reused");
  assert.equal(listCalls, 1, "the existing batched open-board read is the only list call");
  assert.equal(changedFileCalls, 0, "strong trailer ownership does not consult the weak file-overlap heuristic");
});

test("W1-T3219 criterion 2: the ordinary isOpenPr chain refuses a duplicate build", () => {
  const { projection } = project([foreignPr()]);
  assert.equal(nextFrom(projection), undefined, "#4729's exact trailer keeps W1-T3219 out of dispatch");
});

test("W1-T3219 criterion 3: prose, title and overlap without an exact trailer remain warning-only", () => {
  const { projection, changedFileCalls } = project([
    foreignPr({ body: `Work for ${TASK_ID} is under way, but this is not a trailer.` }),
  ]);

  assert.equal(projection.prState, undefined, "weak evidence does not become an OPEN ownership credit");
  assert.equal(projection.openSiblingBuild?.prNumber, 4729, "the existing W1-T2397 observation remains");
  assert.equal(changedFileCalls, 1, "only the weak overlap observation consults changed files");
  assert.equal(nextFrom(projection)?.id, TASK_ID, "warning-only evidence still dispatches");
});

test("W1-T3219 criterion 4: missing, malformed, prefix-sharing and mismatched trailers never own dispatch", () => {
  const bodies: Array<string | undefined> = [
    undefined,
    `prefix Remudero-Task: ${TASK_ID}`,
    `Remudero-Task: ${TASK_ID}-run-123`,
    "Remudero-Task: W1-T32190",
    "Remudero-Task: W1-T9999",
  ];

  for (const body of bodies) {
    const { projection } = project([foreignPr({ body })], []);
    assert.equal(projection.prState, undefined, `must not credit body ${JSON.stringify(body)}`);
    assert.equal(nextFrom(projection)?.id, TASK_ID);
  }
});

test("W1-T3219 criterion 5: closing the exact-trailered PR releases the task on the next projection", () => {
  const open = project([foreignPr()]).projection;
  const closed = project([foreignPr({ state: "CLOSED" })]).projection;

  assert.equal(nextFrom(open), undefined, "the open owner holds dispatch");
  assert.equal(closed.prState, undefined, "a closed owner creates no stale OPEN fact");
  assert.equal(nextFrom(closed)?.id, TASK_ID, "the next projection releases dispatch without a timer");
});

test("W1-T3219 criterion 6: branch and trailer naming the same task do not require another read", () => {
  const ownBranch = foreignPr({ headRefName: `run-${TASK_ID}-1788909796168` });
  const { projection, listCalls, changedFileCalls } = project([ownBranch]);

  assert.equal(projection.prNumber, 4729);
  assert.equal(listCalls, 1);
  assert.equal(changedFileCalls, 0);
});
