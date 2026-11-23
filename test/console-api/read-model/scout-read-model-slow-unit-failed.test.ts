import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { runSlowLaneWorker, SLOW_LANE_CATALOG_WAIT_MS, type SlowLaneMessage } from "#src/lib/read-model-slow-lane.js";
import { BOARD_CATALOG_WIRE_VERSION, type BoardCatalogRequest } from "#src/lib/serve-plan-reload.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function instanceLane(t: TestContext, registry: string) {
  const { dir: root } = gitRepo({ scope: t });
  const state = join(root, "state");
  const planPath = join(root, "plan.yaml"), ledgerPath = join(state, "ledger.ndjson");
  const classification = join(state, "inbox-classification.json");
  mkdirSync(state);
  writeFileSync(planPath, "[]\n");
  writeFileSync(ledgerPath, "");
  writeFileSync(join(state, "inbox-proposals.json"), registry);
  writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository: "owner/ops", kinds: [] }));

  const clock = fixedClock(Date.UTC(2026, 10, 16));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: SlowLaneMessage[] = [];
  let send: (message: { type: "lease"; held: boolean; instances: string[] }) => void;
  let requestedCatalog = false;
  let passComplete = Promise.withResolvers<void>();
  const lane = runSlowLaneWorker({
    on: (_event, handler) => { send = handler; },
    postMessage: (value) => {
      const message = value as SlowLaneMessage | BoardCatalogRequest;
      if (message.type === "ops_catalog_read") {
        assert.equal(message.root, state);
        requestedCatalog = true;
      } else {
        messages.push(message);
      }
    },
  }, {
    catalogBridgeVersion: BOARD_CATALOG_WIRE_VERSION,
    instanceInboxes: [{ instance: "site", repository: "owner/site", planPath, ledgerPath, root, inboxRoot: root }],
  }, {
    clock,
    schedule: () => {
      passComplete.resolve();
      return () => {};
    },
  });
  t.after(() => lane.stop());

  return {
    lease(held: boolean) {
      if (held) passComplete = Promise.withResolvers<void>();
      send({ type: "lease", held, instances: held ? ["site"] : [] });
      return passComplete.promise;
    },
    elapseCatalogWait() {
      assert.ok(requestedCatalog, "the worker requested a catalog");
      t.mock.timers.tick(SLOW_LANE_CATALOG_WAIT_MS);
    },
    classification,
    failures: () => messages.filter(message => message.type === "log" && message.step === "read_model.slow_unit_failed"),
  };
}

test("W1-T13095: read_model.slow_unit_failed no longer recurs", async (t) => {
  const lane = instanceLane(t, '{"proposals":[]}');
  const displacedPass = lane.lease(true);
  void lane.lease(false);
  lane.elapseCatalogWait();
  await displacedPass;
  assert.deepEqual(lane.failures(), []);
  assert.equal(existsSync(lane.classification), false, "the displaced pass did not publish");

  const ownedPass = lane.lease(true);
  lane.elapseCatalogWait();
  await ownedPass;
  assert.equal(existsSync(lane.classification), true, "the next owned pass publishes");
  assert.deepEqual(lane.failures(), []);
});

test("W1-T13095: the symptom is still recorded when its failure occurs", async (t) => {
  const lane = instanceLane(t, "{broken");
  const pass = lane.lease(true);
  lane.elapseCatalogWait();
  await pass;
  assert.equal(existsSync(lane.classification), false);
  assert.deepEqual(lane.failures(), [{
    type: "log", step: "read_model.slow_unit_failed",
    extra: { unit: "inbox:site", error: "instance inbox registry is unavailable" },
  }]);
});
