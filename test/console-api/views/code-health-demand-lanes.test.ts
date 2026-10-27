import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "#src/lib/tmp.js";
import { fixedClock } from "#src/lib/clock.js";
import { createReadModelTicker, readModelBodyKey, readModelLaneViews, readModelSwitchesPath, type ReadModelBodyEntry, type ReadModelInstanceState, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import { CODE_HEALTH_SCOPE_KEY, CODE_HEALTH_VIEW_NAME, createCodeHealthView, validateCodeHealthRequest } from "#src/lib/code-health-view.js";
import { judgeSource } from "#src/lib/view-freshness.js";

function inventory(stateDir: string) {
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: "core", options: { controlRoot: stateDir, ledgerPath: join(stateDir, "ledger.ndjson") } }], improvementEvidence: { version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository: "acme/atlas", instanceIds: ["core"], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
}

test("code health remains readable after the second production view lane starts", async () => {
  await withTempDir("code-health-demand-lanes", stateDir => {
    inventory(stateDir);
    writeFileSync(join(stateDir, "ledger.ndjson"), "");
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "on", views: { [CODE_HEALTH_VIEW_NAME]: "serve" } }));
    const clock = fixedClock(Date.now()), holder = "code-health-demand-lanes", instances = [{ name: "core", ledgerDir: stateDir, repo: "acme/atlas" }];
    const states: ReadModelWorkerMessage[] = [], bodies = new Map<string, ReadModelBodyEntry>(), drops: string[] = [];
    const relay = (message: ReadModelWorkerMessage) => {
      if (message.type === "body") bodies.set(readModelBodyKey(message.entry.view, message.entry.key), message.entry);
      if (message.type === "drop") { drops.push(message.key); bodies.delete(readModelBodyKey(message.view, message.key)); }
    };
    const projector = createReadModelTicker({ stateDir, instances, views: [], oracle: "off", holder, clock, post: message => { states.push(message); } });
    const lanes: ReturnType<typeof createReadModelTicker>[] = [];
    try {
      projector.start(); projector.tick();
      const state = states.findLast(message => message.type === "state");
      assert.ok(state?.type === "state", "positive control: the production projector opened and reported the real fixture store");
      const start = (lane: "fast" | "heavy") => {
        const demand = createDemandBook({ clock });
        if (lane === "fast") demand.want(CODE_HEALTH_VIEW_NAME, "repository=all");
        const ticker = createReadModelTicker({ stateDir, instances, viewsOnly: true, lane, holder, clock, oracle: "off", demand, post: relay,
          views: [{ name: CODE_HEALTH_VIEW_NAME, demand: true, create: () => createCodeHealthView({ stateDir, keys: () => demand.keys(CODE_HEALTH_VIEW_NAME) }) }] });
        lanes.push(ticker); ticker.start(); ticker.observe(state.instances as ReadModelInstanceState[]); ticker.tick(); return ticker;
      };
      const source = { body: (view: string, key = "") => bodies.get(readModelBodyKey(view, key)), switches: () => ({ views: { [CODE_HEALTH_VIEW_NAME]: "serve" as const } }), judge: (sources: Parameters<typeof judgeSource>[0][]) => sources.map(value => judgeSource(value, clock.now())) };
      const fast = start("fast");
      assert.ok(bodies.has(readModelBodyKey(CODE_HEALTH_VIEW_NAME, CODE_HEALTH_SCOPE_KEY)), "positive control: fast built the real configured roster");
      assert.equal(validateCodeHealthRequest(new URLSearchParams("repository=all"), source, clock.now()), undefined, "positive control: the selected all-repository read was ready before the peer started");
      start("heavy"); fast.tick();
      assert.equal(validateCodeHealthRequest(new URLSearchParams("repository=all"), source, clock.now()), undefined, `starting the peer must preserve the ready scope and selected body; dropped keys: ${JSON.stringify(drops)}`);
    } finally { for (const lane of lanes) lane.release(); projector.release(); }
  });
});

test("code health production factory reads configured durable state before the projector store attaches", async () => {
  await withTempDir("code-health-before-store", stateDir => {
    inventory(stateDir); const clock = fixedClock(Date.now()), demand = createDemandBook({ clock });
    const factory = readModelLaneViews({ stateDir, instances: [] }, clock, () => undefined, demand).find(view => view.name === CODE_HEALTH_VIEW_NAME);
    assert.ok(factory, "positive control: the production lane registers Code health");
    const rows = factory.create().materialize({ now: clock.now(), instances: [] });
    assert.ok(rows.some(row => row.key === CODE_HEALTH_SCOPE_KEY), "configured repository scope must not depend on an attached projector database");
  });
});
