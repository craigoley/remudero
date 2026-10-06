import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan } from "../src/lib/plan.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { planSourceLoaded, type PlanSourceHolder } from "../src/lib/serve-plan-reload.js";
import { fakeGitHub } from "./helpers/fake-github.js";

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

async function serveFixture(planYaml: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-source-population-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, planYaml);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [
      { id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] },
      { id: "verify-human:W1-T1041", summary: "Choose a CI harness", evidenceAnchors: [] },
    ],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
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

test("a nonempty plan keeps its counts, its retirement history and a genuine human task", async () => {
  const fx = await serveFixture(HUMAN);
  try {
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.progress.total, 2);
    assert.equal(view.body.planSource.state, "loaded");
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal(census.body.sources.plan, "observed");
    assert.equal(census.body.counts.decision, 1, "the genuine human task is still an operator decision");
    assert.equal(census.body.counts.history, 1, "the retired task stays in history");
    const items = census.body.items as Array<{ proposalId: string; attention: string }>;
    assert.equal(items.find((i) => i.proposalId === "verify-human:W1-T216")?.attention, "decision");
    assert.equal(items.find((i) => i.proposalId === "verify-human:W1-T1041")?.attention, "history");
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
    assert.equal(census.body.counts.decision, 1);
  } finally {
    fx.close();
  }
});
