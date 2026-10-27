import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "#src/lib/tmp.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { createReadModelTicker, readModelBodyKey, readModelLaneViews, readModelSwitchesPath, type ReadModelBodyEntry, type ReadModelInstanceState, type ReadModelView, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { createDemandBook, VIEW_DEMAND_EVICT_MS } from "#src/lib/view-demand.js";
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

test("demand lane ownership preserves expiry and key limits", async () => {
  await withTempDir("demand-key-ownership", stateDir => {
    let now = Date.now();
    const clock = clockFromMillisFn(() => now), holder = "demand-key-ownership";
    writeFileSync(join(stateDir, "ledger.ndjson"), "");
    mkdirSync(join(stateDir, "read-model"), { recursive: true });
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "on", views: { task: "serve", "peer-view": "serve" } }));
    const instances = ["core", "site"].map(name => ({ name, ledgerDir: stateDir, repo: `acme/${name}` }));
    const states: ReadModelWorkerMessage[] = [], bodies = new Map<string, ReadModelBodyEntry>();
    const tickers: ReturnType<typeof createReadModelTicker>[] = [];
    const relay = (message: ReadModelWorkerMessage) => {
      if (message.type === "body") bodies.set(readModelBodyKey(message.entry.view, message.entry.key), message.entry);
      if (message.type === "drop") bodies.delete(readModelBodyKey(message.view, message.key));
    };
    const projector = createReadModelTicker({ stateDir, instances, views: [], oracle: "off", holder, clock, post: message => states.push(message) });
    const observe = (ticker: ReturnType<typeof createReadModelTicker>) => {
      const state = states.findLast(message => message.type === "state");
      assert.ok(state?.type === "state", "positive control: the real projector reported both fixture stores");
      ticker.observe(state.instances);
    };
    const start = (book: ReturnType<typeof createDemandBook>, selected = instances, withPeer = false) => {
      const views: ReadModelView[] = [{ name: "task", version: 1, perInstance: true, demand: true, materialize: ctx =>
        book.keys("task").filter(key => new URLSearchParams(key).get("instance") === ctx.instances[0]?.state.instance)
          .map(key => ({ key, data: { fixture: key }, sources: [] })) }];
      if (withPeer) views.push({ name: "peer-view", version: 1, demand: true, materialize: () =>
        book.keys("peer-view").map(key => ({ key, data: { fixture: key }, sources: [] })) });
      const ticker = createReadModelTicker({ stateDir, instances: selected, views, viewsOnly: true, lane: "fast", holder, clock, oracle: "off", demand: book, post: relay });
      tickers.push(ticker); ticker.start(); observe(ticker); ticker.tick(); return ticker;
    };
    const has = (view: string, key: string) => bodies.has(readModelBodyKey(view, key));
    const old = "instance=core&id=old", site = "instance=site&id=old", keep = "instance=core&id=keep", next = "instance=core&id=next", peer = "id=peer";
    try {
      projector.start(); projector.tick();
      const seed = createDemandBook({ clock }); seed.want("task", old); seed.want("task", site); seed.want("peer-view", peer);
      start(seed, instances, true);
      assert.ok(has("task", old) && has("task", site) && has("peer-view", peer), "positive control: actual producer tickers persisted all three scopes");

      const book = createDemandBook({ clock, maxKeys: 1 }); book.want("task", keep);
      const core = start(book, instances.filter(instance => instance.name === "core"));
      assert.equal(has("task", old), false, "startup still invalidates this owner's unread persisted key");
      assert.ok(has("task", keep), "the wanted owned key is built");
      assert.ok(has("task", site), "another instance's persisted key is not this owner's to invalidate");
      assert.ok(has("peer-view", peer), "another view's persisted key survives");

      core.want("task", next); core.buildNow("task");
      assert.equal(has("task", keep), false, "the real demand-book key cap still evicts an owned body");
      assert.ok(has("task", next), "the newest wanted body remains available");
      for (const [view, key] of [["task", site], ["peer-view", peer]]) {
        book.want(view!, key!); core.want("task", next); core.buildNow("task");
        assert.ok(has(view!, key!), "overflow from a foreign scope must not delete its existing body");
        assert.ok(has("task", next), "the owned body can still rebuild after overflow");
      }

      now += VIEW_DEMAND_EVICT_MS; projector.tick(); observe(core); core.tick();
      assert.equal(has("task", next), false, "ten-minute expiry still removes an unread owned body");
      assert.ok(has("task", site) && has("peer-view", peer), "expiry cannot erase a peer's scopes");

      core.want("task", next); core.buildNow("task");
      assert.ok(has("task", next), "positive control: an actual wanted body exists before lane transfer");
      core.lane({ view: "task", instance: "core", heavy: true, dueAt: clock.now(), costMs: 0 });
      now += VIEW_DEMAND_EVICT_MS; projector.tick(); observe(core); core.tick();
      assert.ok(has("task", next), "a lane that lost this unit cannot expire its body");
      core.lane({ view: "task", instance: "core", heavy: false, dueAt: clock.now(), costMs: 0 }); core.tick();
      assert.equal(has("task", next), false, "regaining the unit invalidates the old key absent from this owner's demand book");
      core.want("task", next); core.buildNow("task");
      assert.ok(has("task", next), "a new read is served after the genuine invalidation");
    } finally { for (const ticker of tickers) ticker.release(); projector.release(); }
  });
});
