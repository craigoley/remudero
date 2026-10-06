import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { planSourceFailed, planSourceLoaded, reloadServePlan, type PlanRead, type PlanSourceHolder } from "../src/lib/serve-plan-reload.js";
import { fakeGitHub } from "./helpers/fake-github.js";

// W1-T5639: a refresh that fails keeps the plan it had, dated, and never certifies a newer generation.

const REF = "b".repeat(40);
const HUMAN = `
- id: W1-T216
  title: "A controlled security drill"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: queued
  attempts: 0
  files: [test/controlled-task.test.ts]
  acceptance:
    - claim: "a controlled check"
      proof: "unit test: controlled check"
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-source-refresh-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, HUMAN);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [{ id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] }],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const plan = loadPlan(planPath);
  const board: PlanSourceHolder = { plan, planSource: planSourceLoaded(undefined, "plan-files", fixedClock(Date.parse("2026-10-06T10:00:00.000Z"))) };
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => board.plan, readPlanSource: () => board.planSource,
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps, deps.readPlanSnapshot) });
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    plan, board, ready,
    get: async (path: string) => {
      await ready;
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { authorization: "Bearer read-token" } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    close: () => { server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a failed refresh keeps the prior plan as dated stale evidence and does not advance the generation", async () => {
  const fx = fixture();
  try {
    const refreshAt = fixedClock(Date.parse("2026-10-06T11:00:00.000Z"));
    const logs: string[] = [];
    const adopted = await reloadServePlan(fx.board, "/repo", REF, {
      read: async () => { throw new Error("git show: bad object"); }, clock: refreshAt, log: (step) => logs.push(step),
    });
    assert.equal(adopted, false);
    assert.deepEqual(logs, ["serve.plan_reload_failed"]);
    assert.deepEqual(fx.board.planSource, {
      state: "stale", generation: 1, identity: "plan-files", observedAt: "2026-10-06T10:00:00.000Z",
      failure: { reason: "git show: bad object", failedAt: "2026-10-06T11:00:00.000Z" },
    });
    assert.equal(fx.board.plan, fx.plan, "the prior plan keeps serving");
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.planSource.state, "stale");
    assert.equal(view.body.planSource.observedAt, "2026-10-06T10:00:00.000Z", "the evidence is dated at the read that produced it, not at the failure");
    assert.equal(view.body.planSource.generation, 1);
    assert.equal(view.body.progress.total, 1, "the dated prior plan is still readable");
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal(census.body.sources.plan, "partial", "a stale plan is never an observed one");
    assert.equal(census.body.state, "partial");
    assert.equal(census.body.verifiedCounts.decision, 0);
    assert.equal(census.body.planSource.state, "stale");
    const inbox = await fx.get("/v1/inbox");
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.planSource.state, "stale");
  } finally {
    fx.close();
  }
});

test("a later successful refresh replaces the stale outcome with the next generation", async () => {
  const fx = fixture();
  try {
    await reloadServePlan(fx.board, "/repo", REF, { read: async () => { throw new Error("transient"); }, clock: fixedClock(Date.parse("2026-10-06T11:00:00.000Z")) });
    const next: PlanRead = { plan: fx.plan, quarantined: [] };
    const ok = await reloadServePlan(fx.board, "/repo", REF, { read: async () => next, clock: fixedClock(Date.parse("2026-10-06T12:00:00.000Z")) });
    assert.equal(ok, true);
    assert.deepEqual(fx.board.planSource, { state: "loaded", generation: 2, identity: `ref:/repo@${REF}`, observedAt: "2026-10-06T12:00:00.000Z" });
    assert.equal((await fx.get("/v1/plan/view")).body.planSource.state, "loaded");
  } finally {
    fx.close();
  }
});

test("a failure reason is bounded text, and a board without an outcome records none", async () => {
  const long = planSourceFailed(undefined, new Error("x".repeat(5_000)), fixedClock(0));
  assert.equal(long.state, "unavailable");
  assert.equal(long.state === "unavailable" && long.failure.reason.length, 240);
  const untracked: PlanSourceHolder = { plan: { tasks: [], byId: new Map() } };
  assert.equal(await reloadServePlan(untracked, "/repo", REF, { read: async () => { throw new Error("x"); } }), false);
  assert.equal(untracked.planSource, undefined, "an untracked board is not qualified retroactively");
});
