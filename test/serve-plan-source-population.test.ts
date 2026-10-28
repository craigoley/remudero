import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan } from "#src/lib/plan.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { planSourceLoaded, type PlanSourceHolder } from "#src/lib/serve-plan-reload.js";
import { proposalFromJudgedShard } from "#src/lib/verify-human-judge.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

// W1-T5639: a plan that LOADS is trusted exactly as before, whatever it holds. The qualified outcome
// separates "read and empty" from "never read"; it must not turn a valid empty or populated plan into a refusal.

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
- id: W1-T1041
  title: "The duplicate CI harness was resolved"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: blocked
  retirement: closed
  attempts: 0
  files: [test/workflow-single-suite-run.test.ts]
  acceptance:
    - claim: "single suite"
      proof: "unit test: single suite"
`;

async function serveFixture(planYaml: string, released = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-source-population-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, planYaml);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [
      { id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] },
      released ? proposalFromJudgedShard({ id: "W1-T1041", title: "Choose a CI harness", rationale: "operator release",
        acceptance: ["single suite"], ageDays: 1, depsAllMerged: true, citedInSrc: false },
      { decision: "needs_operator", reason: "The operator owns this release" })
        : { id: "verify-human:W1-T1041", summary: "Choose a CI harness", evidenceAnchors: [] },
    ],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), released
    ? JSON.stringify({ step: "ratify.approved", task_id: "W1-T1041", released: "verify-human", run_id: "RELEASE-1041" }) + "\n" : "");
  const board: PlanSourceHolder = { plan: loadPlan(planPath), planSource: planSourceLoaded(undefined, "plan-files") };
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => board.plan, readPlanSource: () => board.planSource,
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps, deps.readPlanSnapshot) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: "Bearer read-token" } });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { board, get, close: () => { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a valid empty plan reads as a loaded source with exact zero counts, not as an unavailable one", async () => {
  const fx = await serveFixture("[]\n");
  try {
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.planSource.state, "loaded");
    assert.equal(view.body.planSource.generation, 1);
    assert.equal(view.body.progress.unknown, false);
    assert.equal(view.body.progress.total, 0, "an intentionally empty plan IS a healthy zero");
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal(census.body.sources.plan, "observed");
    assert.equal(census.body.planSource.state, "loaded");
    const inbox = await fx.get("/v1/inbox");
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.planSource.state, "loaded");
  } finally {
    fx.close();
  }
});

test("a nonempty loaded plan preserves its counts and unanswered asks after task retirement", async () => {
  const fx = await serveFixture(HUMAN);
  try {
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.progress.total, 2);
    assert.equal(view.body.planSource.state, "loaded");
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal(census.body.sources.plan, "observed");
    assert.equal(census.body.counts.decision, 2, "plan closure does not answer either human ask");
    assert.equal(census.body.counts.history, 0, "task retirement alone cannot retire an untyped ask");
    const items = census.body.items as Array<{ proposalId: string; attention: string; sourceFacts: Array<{ source: string; detail: string }> }>;
    assert.equal(items.find((i) => i.proposalId === "verify-human:W1-T216")?.attention, "decision");
    const closed = items.find((i) => i.proposalId === "verify-human:W1-T1041");
    assert.equal(closed?.attention, "decision");
    assert.ok(closed?.sourceFacts.some((fact) => fact.source === "plan-lifecycle" && fact.detail.includes("retirement closed")));
  } finally {
    fx.close();
  }
});

test("a board that carries no outcome is served exactly as before, with no planSource field", async () => {
  const fx = await serveFixture(HUMAN);
  try {
    fx.board.planSource = undefined;
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal("planSource" in view.body, false);
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal("planSource" in census.body, false);
    assert.equal(census.body.counts.decision, 2);
    assert.equal(census.body.counts.history, 0);
    assert.deepEqual(census.body.items.map((item: { proposalId: string; attention: string }) => [item.proposalId, item.attention]).sort(), [
      ["verify-human:W1-T1041", "decision"], ["verify-human:W1-T216", "decision"],
    ]);
  } finally {
    fx.close();
  }
});

test("a loaded plan retains receipt-backed ask history beside an unanswered human task", async () => {
  const fx = await serveFixture(HUMAN, true);
  try {
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.progress.total, 2);
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal(census.body.sources.plan, "observed");
    assert.equal(census.body.planSource.state, "loaded");
    assert.equal(census.body.counts.decision, 1);
    assert.equal(census.body.counts.history, 1);
    const items = census.body.items as Array<{ proposalId: string; attention: string; sourceFacts: Array<{ source: string; detail: string }> }>;
    assert.equal(items.find((i) => i.proposalId === "verify-human:W1-T216")?.attention, "decision");
    const released = items.find((i) => i.proposalId === "verify-human:W1-T1041");
    assert.equal(released?.attention, "history");
    assert.ok(released?.sourceFacts.some((fact) => fact.source === "ledger" && fact.detail.includes("RELEASE-1041")));
  } finally {
    fx.close();
  }
});
