import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan } from "#src/lib/plan.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { planSourceLoaded } from "#src/lib/serve-plan-reload.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const PLAN = `
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
    - claim: "single suite"
      proof: "unit test: single suite"
`;

test("W1-T10008: check:test:test/serve-plan-source-population.test.ts is prevented, not retried", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t10008-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, PLAN);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [{ id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] }],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const plan = loadPlan(planPath);
  const source = planSourceLoaded(undefined, "plan-files");
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => plan, readPlanSource: () => source,
  };
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildPanelGraphRoutes(deps, deps.readPlanSnapshot) });
  t.after(() => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/v1/inbox/attention-census`, { headers: { authorization: "Bearer r" } });
    const body = await res.json() as { counts: { decision: number }; items: Array<{ proposalId: string; attention: string }> };
    assert.equal(res.status, 200);
    assert.equal(body.counts.decision, 1, "the genuine human task is one operator decision on every read");
    assert.deepEqual(body.items.map(({ proposalId, attention }) => ({ proposalId, attention })), [
      { proposalId: "verify-human:W1-T216", attention: "decision" },
    ]);
  }
});
