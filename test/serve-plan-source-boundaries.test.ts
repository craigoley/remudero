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
import { planSourceFailed, planSourceLoaded, type PlanSourceHolder } from "../src/lib/serve-plan-reload.js";
import { fakeGitHub } from "./helpers/fake-github.js";

// W1-T5639: the plan source is one qualified input among several. GitHub and the archived ledger stay
// independently unknown, and a refused read exposes nothing private to a caller that was never authorised.

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

const SECRET_PATH = "/home/operator/private/plan/tasks.yaml";

function fixture(options: { githubDown?: boolean; sourceFailed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-source-boundaries-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, HUMAN);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [{ id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] }],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const board: PlanSourceHolder = options.sourceFailed
    ? { plan: { tasks: [], byId: new Map() }, planSource: planSourceFailed(undefined, new Error(`EACCES: permission denied, open '${SECRET_PATH}'`), fixedClock(0)) }
    : { plan: loadPlan(planPath), planSource: planSourceLoaded(undefined, "plan-files", fixedClock(0)) };
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: fakeGitHub(options.githubDown ? { readFailed: () => true, readFailureReason: () => "rate_limit" } : {}),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => board.plan, readPlanSource: () => board.planSource,
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps, deps.readPlanSnapshot) });
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = async (path: string) => {
    await ready;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
  };
  return {
    url,
    get: async (path: string, token = "read-token") => {
      const response = await fetch(await url(path), { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
    },
    close: () => { server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("an unavailable GitHub read leaves the plan source observed and is reported on its own source", async () => {
  const fx = fixture({ githubDown: true });
  try {
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 200);
    assert.equal(census.body.sources.plan, "observed", "GitHub unknown must not demote a plan that loaded");
    assert.equal(census.body.planSource.state, "loaded");
    assert.equal(census.body.sources.githubProjection, "partial", "GitHub stays independently unknown");
    assert.equal(census.body.state, "partial");
    assert.equal(census.body.sources.archiveLedger, "unavailable", "the archive is judged by its own evidence, not by the plan");
  } finally {
    fx.close();
  }
});

test("an unavailable plan source does not claim GitHub or the archive are observed", async () => {
  const fx = fixture({ sourceFailed: true, githubDown: true });
  try {
    const view = await fx.get("/v1/plan/view");
    assert.equal(view.status, 200);
    assert.equal(view.body.progress.unknown, true);
    assert.match(view.body.progress.unavailableReason, /plan_source_unavailable/);
    assert.deepEqual(view.body.sections, []);
    assert.equal(view.body.planSource.state, "unavailable");
    const census = await fx.get("/v1/inbox/attention-census");
    assert.equal(census.status, 503);
    assert.equal(census.body.error, "plan_source_unavailable");
    assert.equal("sources" in census.body, false, "a refusal certifies no source as observed");
    assert.equal("counts" in census.body, false);
  } finally {
    fx.close();
  }
});

test("an unauthenticated or wrongly authenticated caller gets no plan-source payload from a refused read", async () => {
  const fx = fixture({ sourceFailed: true });
  try {
    for (const path of ["/v1/plan/view", "/v1/inbox", "/v1/inbox/threads", "/v1/inbox/attention-census", "/v1/inbox/thread?id=thread:x"]) {
      for (const token of ["", "not-a-token"]) {
        const refused = await fx.get(path, token);
        assert.equal(refused.status, 401, `${path} with token ${JSON.stringify(token)}`);
        assert.equal(refused.text.includes("planSource"), false, `${path} leaks the source outcome`);
        assert.equal(refused.text.includes(SECRET_PATH), false, `${path} leaks the failure reason`);
      }
    }
    const authorised = await fx.get("/v1/inbox/attention-census");
    assert.equal(authorised.status, 503);
    assert.equal(authorised.body.planSource.failure.reason.includes(SECRET_PATH), true, "the authorised operator sees the cause");
  } finally {
    fx.close();
  }
});
