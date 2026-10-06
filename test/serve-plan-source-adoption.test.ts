import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { adoptPlanSource, planSourceFailed, reloadServePlan, type PlanSourceHolder } from "../src/lib/serve-plan-reload.js";
import { fakeGitHub } from "./helpers/fake-github.js";

// W1-T5639: a source that was never read is repaired by the next successful read, in place: no restart,
// no rebuilt route, and no reply replay. The inbox memo is keyed by plan object identity, so a new plan reclassifies.

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
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-source-adoption-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, HUMAN);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [{ id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] }],
  }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const real = loadPlan(planPath);
  // What serve binds after a failed initial read: a placeholder with no tasks, beside an unavailable outcome.
  const board: PlanSourceHolder = { plan: { tasks: [], byId: new Map() }, planSource: planSourceFailed(undefined, new Error("EACCES: plan/tasks.yaml"), fixedClock(Date.parse("2026-10-06T09:00:00.000Z"))) };
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => board.plan, readPlanSource: () => board.planSource,
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps, deps.readPlanSnapshot) });
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    real, board, root, ledgerPath,
    get: async (path: string) => {
      await ready;
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { authorization: "Bearer read-token" } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    close: () => { server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a successful reload repairs source qualification and classification in place without a restart or reply replay", async () => {
  const fx = fixture();
  try {
    const before = await fx.get("/v1/inbox/attention-census");
    assert.equal(before.status, 503);
    assert.equal(before.body.error, "plan_source_unavailable");
    assert.equal("counts" in before.body, false, "no healthy-zero counts from a placeholder");
    assert.equal("items" in before.body, false, "no operator decision is invented from a placeholder");
    assert.equal((await fx.get("/v1/inbox")).status, 503);
    assert.equal((await fx.get("/v1/inbox/threads")).status, 503);
    const ledgerBefore = readFileSync(fx.ledgerPath, "utf8");

    const adopted = await reloadServePlan(fx.board, "/repo", "c".repeat(40), { read: async () => ({ plan: fx.real, quarantined: [] }), clock: fixedClock(Date.parse("2026-10-06T10:00:00.000Z")) });
    assert.equal(adopted, true);
    assert.equal(fx.board.planSource?.state, "loaded");
    assert.equal(fx.board.planSource?.generation, 1, "the first plan ever read is generation 1");

    const after = await fx.get("/v1/inbox/attention-census");
    assert.equal(after.status, 200, "the same server answers: nothing was restarted or rebuilt");
    assert.equal(after.body.sources.plan, "observed");
    assert.equal(after.body.planSource.state, "loaded");
    assert.equal(after.body.counts.decision, 1);
    assert.equal(after.body.items[0].proposalId, "verify-human:W1-T216");
    assert.equal(after.body.items[0].classification !== "unavailable", true, "the proposal is classified against the real plan");
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.body.progress.total, 1);
    assert.equal(view.body.planSource.generation, 1);
    assert.equal(readFileSync(fx.ledgerPath, "utf8"), ledgerBefore, "adoption writes no ledger row and replays no reply");
  } finally {
    fx.close();
  }
});

test("a reload that fails while the source is unavailable stays unavailable at generation 0 with the newest failure", async () => {
  const fx = fixture();
  try {
    const ok = await reloadServePlan(fx.board, "/repo", "c".repeat(40), { read: async () => { throw new Error("bad yaml"); }, clock: fixedClock(Date.parse("2026-10-06T10:30:00.000Z")) });
    assert.equal(ok, false);
    assert.deepEqual(fx.board.planSource, { state: "unavailable", generation: 0, failure: { reason: "bad yaml", failedAt: "2026-10-06T10:30:00.000Z" } });
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.planSource.state, "unavailable");
    assert.equal(view.body.progress.unknown, true);
    assert.equal("total" in view.body.progress, false, "unknown, never a healthy zero");
  } finally {
    fx.close();
  }
});

test("adoptPlanSource installs what serve read only while the source is unavailable", () => {
  const board: PlanSourceHolder = { plan: { tasks: [], byId: new Map() }, planSource: planSourceFailed(undefined, "first") };
  const logs: Array<[string, unknown]> = [];
  const real = { tasks: [], byId: new Map() };
  assert.equal(adoptPlanSource(board, () => { throw new Error("still bad"); }, { clock: fixedClock(5) }), false);
  assert.equal(board.planSource?.state === "unavailable" && board.planSource.failure.reason, "still bad");
  assert.equal(adoptPlanSource(board, () => ({ plan: real, identity: "ino:1" }), { clock: fixedClock(6), log: (step, extra) => logs.push([step, extra]) }), true);
  assert.equal(board.plan, real);
  assert.equal(board.planSource?.state === "loaded" && board.planSource.identity, "ino:1");
  assert.deepEqual(logs.map(([step]) => step), ["serve.plan_source_adopted"]);
  assert.equal(adoptPlanSource(board, () => { throw new Error("must not read a loaded source"); }), false, "a loaded source is never re-read");
  assert.equal(board.planSource?.state, "loaded");
});
