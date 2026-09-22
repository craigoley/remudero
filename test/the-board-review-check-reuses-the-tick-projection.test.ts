// test/the-board-review-check-reuses-the-tick-projection.test.ts — W1-T4051.
//
// THE DEFECT, MEASURED 2026-09-22 IN THE DAEMON CONTAINER. `checkBoardReview` runs synchronously on
// every daemon iteration, and its items read re-derived the WHOLE plan projection on a freshly built
// `buildBatchedGithub(owner, repo)` — no snapshot cache, so every memo empty:
//
//   projectPlan  118-122 s   213 × pulls/N/files, 55 closed-PR pages, 15 issue pages (all spawnSync)
//
// That froze every timer for ~140 s on 116 of 312 checks over two days. `daemonCommand` already derives
// the same projection once per tick on one warm gateway (`lastProj`); every other reader uses it.
//
// These tests pin that the check reads the tick's projection and plan instead of deriving its own, that
// escalations still arrive from it, that a tick with no projection degrades only the escalation arm (the
// reconciler still sees the whole open board — W1-T2464's quiet-tick retirement depends on that), and
// that the daemon actually wires it.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBoardReviewDaemonHooks, type BoardReviewItemsIo } from "../src/run-task.js";
import type { BoardItem } from "../src/lib/board-review.js";
import type { Config } from "../src/lib/config.js";
import type { OpenPrRest } from "../src/lib/open-prs-rest.js";
import type { Plan } from "../src/lib/plan.js";
import type { Policy } from "../src/lib/policy.js";
import type { StatusProjection } from "../src/lib/status.js";

const NOW = new Date("2026-09-22T18:30:00Z");
const POLICY = { values: { boardReview: { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 } } } as unknown as Policy;

function pr(number: number, createdAt: string): OpenPrRest {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: `run-T${number}`,
    headRefOid: "a".repeat(40),
    updatedAt: createdAt,
    body: "",
    autoMergeRequest: null,
    statusCheckRollup: [],
    isDraft: false,
    createdAt,
  };
}

const OPEN_PRS = [pr(6612, "2026-09-22T17:58:00Z"), pr(6623, "2026-09-22T18:41:00Z")];

const TICK_PLAN: Plan = { tasks: [], byId: new Map() };

function tickProjection(): Map<string, StatusProjection> {
  return new Map<string, StatusProjection>([
    [
      "W1-T4024",
      { taskId: "W1-T4024", prNumber: 6612, needsHuman: true, escalationTitle: "needs a human: headroom card" } as unknown as StatusProjection,
    ],
  ]);
}

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "rmd-w1t4051-"));
  mkdirSync(join(d, "state"), { recursive: true });
  return d;
}

/** Hooks over a synthetic board, with the heavy seams replaced by spies that COUNT. The spies stand
 *  for the cold path: if the check ever reaches them, it derived its own projection or loaded its own
 *  plan — the ~120 s the tick had already paid. */
function harness(root: string, projection: () => Map<string, StatusProjection> | undefined) {
  const calls = { projectPlan: 0, loadPlan: 0, projection: 0 };
  let reconciled: readonly BoardItem[] | undefined;
  const itemsIo: BoardReviewItemsIo = {
    resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
    fetchOpenPrs: () => OPEN_PRS,
    projectPlan: () => {
      calls.projectPlan++;
      return new Map();
    },
    loadPlan: () => {
      calls.loadPlan++;
      return TICK_PLAN;
    },
    now: () => NOW,
  };
  const hooks = buildBoardReviewDaemonHooks({
    config: { root } as unknown as Config,
    policy: POLICY,
    now: () => NOW,
    itemsIo,
    projection: () => {
      calls.projection++;
      return projection();
    },
    plan: () => TICK_PLAN,
    reconcile: (opts) => {
      reconciled = opts.items;
      return { retiredProposalIds: [], retired: [] };
    },
  });
  return { hooks, calls, reconciledItems: () => reconciled };
}

void test("W1-T4051: the board-review check reuses the tick projection and plan", () => {
  const root = tmpRoot();
  try {
    const { hooks, calls } = harness(root, tickProjection);
    hooks.checkBoardReview();
    assert.equal(calls.projectPlan, 0, "the check must not derive a projection of its own");
    assert.equal(calls.loadPlan, 0, "the check must not load the plan from disk");
    assert.equal(calls.projection, 1, "the tick's projection is read exactly once per check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T4051: escalations come from the tick projection", () => {
  const root = tmpRoot();
  try {
    const { hooks, reconciledItems } = harness(root, tickProjection);
    hooks.checkBoardReview();
    const items = reconciledItems() ?? [];
    const escalated = items.find((item) => item.id === "#6612");
    assert.equal(escalated?.unhandledEscalations, 1);
    assert.equal(escalated?.escalationTitle, "needs a human: headroom card");
    assert.equal(items.find((item) => item.id === "#6623")?.unhandledEscalations, 0, "control: a PR with no escalation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T4051: no projection degrades escalations, not reconciliation", () => {
  const root = tmpRoot();
  try {
    const { hooks, reconciledItems, calls } = harness(root, () => undefined);
    assert.doesNotThrow(() => hooks.checkBoardReview());
    const items = reconciledItems() ?? [];
    // The WHOLE open board still reaches the reconciler — an empty list here would silently stop
    // W1-T2464's quiet-tick retirement, and an outage-shaped [] would read as "every referent gone".
    assert.deepEqual(items.map((item) => item.id).sort(), ["#6612", "#6623"]);
    assert.ok(items.every((item) => item.unhandledEscalations === 0), "only the escalation arm degrades");
    assert.equal(calls.projectPlan, 0, "a missing projection is not a licence to derive one cold");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("W1-T4051: the daemon wires the board review to its tick projection", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function daemonCommand(");
  assert.ok(start >= 0, "control: daemonCommand is in run-task.ts");
  const body = source.slice(start, source.indexOf("\nexport ", start + 1));
  const call = body.slice(body.indexOf("buildBoardReviewDaemonHooks("), body.indexOf("buildBoardReviewDaemonHooks(") + 200);
  assert.ok(call.startsWith("buildBoardReviewDaemonHooks("), "control: daemonCommand builds the board-review hooks");
  assert.match(call, /projection: \(\) => lastProj\b/);
  assert.match(call, /plan: \(\) => activePlanRef\.current\b/);
});
