import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBoardReviewDaemonHooks, type BoardReviewItemsIo } from "../src/run-task.js";
import type { BoardItem } from "../src/lib/board-review.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import type { Policy } from "../src/lib/policy.js";
import type { StatusProjection } from "../src/lib/status.js";

const NOW = new Date("2026-09-22T18:30:00Z");
const POLICY = { values: { boardReview: { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 } } } as unknown as Policy;
const PLAN: Plan = { tasks: [], byId: new Map() };
const OPEN_PRS = [{
  number: 6612,
  url: "https://github.com/o/r/pull/6612",
  headRefName: "run-W1-T4024",
  headRefOid: "a".repeat(40),
  updatedAt: NOW.toISOString(),
  body: "",
  autoMergeRequest: null,
  statusCheckRollup: [],
  isDraft: false,
  createdAt: "2026-09-22T17:58:00Z",
}];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4051-freeze-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

void test("board-review check consumes the tick projection without a cold plan walk", () => {
  const root = tempRoot();
  try {
    let projectPlanCalls = 0;
    let loadPlanCalls = 0;
    let projectionCalls = 0;
    let checkedItems: readonly BoardItem[] = [];
    const projection = new Map<string, StatusProjection>([
      ["W1-T4024", { taskId: "W1-T4024", prNumber: 6612, needsHuman: true, escalationTitle: "needs a human" } as unknown as StatusProjection],
    ]);
    const itemsIo: BoardReviewItemsIo = {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      fetchOpenPrs: () => OPEN_PRS,
      projectPlan: () => {
        projectPlanCalls += 1;
        throw new Error("the board check must not build a second projection");
      },
      loadPlan: () => {
        loadPlanCalls += 1;
        throw new Error("the board check must not load a second plan");
      },
      now: () => NOW,
    };
    const hooks = buildBoardReviewDaemonHooks({
      config: { root } as unknown as Config,
      policy: POLICY,
      now: () => NOW,
      itemsIo,
      projection: () => {
        projectionCalls += 1;
        return projection;
      },
      plan: () => PLAN,
      reconcile: ({ items }) => {
        checkedItems = items;
        return { retiredProposalIds: [], retired: [] };
      },
    });

    const decision = hooks.checkBoardReview();

    assert.equal(decision.fire, true, "the projection's escalation is a control: the check completed its cadence decision");
    assert.equal(projectionCalls, 1, "the check reads the projection produced by this tick");
    assert.equal(projectPlanCalls, 0, "no synchronous cold projectPlan walk runs inside the check");
    assert.equal(loadPlanCalls, 0, "no synchronous plan load runs inside the check");
    assert.equal(checkedItems[0]?.unhandledEscalations, 1, "the reused projection still supplies escalation data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
