import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, type ReadModelInstanceState, type ReadModelView } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createViewShadow, readShadowEvidence, viewShadowPath, type ShadowLegacy, type ViewShadowState } from "../src/lib/view-shadow.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;
const INSTANCE = "console-east";
const ID = "W1-T6017";
const VIEW = "evidence-fixture";
const data = [{ taskId: ID, status: "view" }];

function fixture(t: TestContext, rowMs: number, own = false) {
  const stateDir = makeTempDir("shadow-instance-evidence");
  const instances = ["core", INSTANCE].map((name, index) => {
    const ledgerDir = join(stateDir, `ledger-${index}`);
    mkdirSync(ledgerDir);
    const holdsRow = own ? name === INSTANCE : name === "core";
    writeFileSync(join(ledgerDir, "ledger.ndjson"), holdsRow
      ? `${JSON.stringify({ ts: new Date(rowMs).toISOString(), step: "run.start", task_id: ID })}\n` : "");
    return { name, ledgerDir };
  });
  const clock = fixedClock(NOW);
  let states: ReadModelInstanceState[] = [];
  const projector = createReadModelTicker({ stateDir, instances, clock, holder: "evidence-holder", views: [], oracle: "off",
    post: (message) => { if (message.type === "state") states = message.instances; } });
  let views: ReturnType<typeof createReadModelTicker> | undefined;
  t.after(() => {
    views?.release();
    projector.release();
    rmSync(stateDir, { recursive: true, force: true });
  });
  projector.start();
  projector.tick();
  assert.deepEqual(states.map((state) => state.lease), ["held", "held"]);
  const queries: string[] = [];
  const wrapped = new Set<ReadModelDb>();
  const keys = ["", "part=tasks", `id=${ID}&instance=%63onsole-east`, "instance=offline", "instance=unknown", "instance="];
  const view: ReadModelView = { name: VIEW, version: 1, materialize: ({ instances: slots }) => {
    for (const { state, db } of slots) {
      if (!db || wrapped.has(db)) continue;
      wrapped.add(db);
      const prepare = db.prepare.bind(db);
      db.prepare = (sql, opts) => {
        if (/\bFROM (fact|seen)\b/.test(sql)) queries.push(state.instance);
        return prepare(sql, opts);
      };
    }
    return keys.map((key) => ({ key, data, sources: [{ name: "fixture", asOf: new Date(NOW).toISOString(), state: "fresh" as const }] }));
  } };
  switchViewsOn(stateDir, [VIEW], "shadow");
  views = createReadModelTicker({ stateDir, instances: [...instances, { name: "offline", ledgerDir: join(stateDir, "offline") }],
    clock, holder: "evidence-holder", views: [view], viewsOnly: true, oracle: "off", post: () => {} });
  views.observe(states);
  views.tick();
  assert.equal(wrapped.size, 2, "both open stores are visible to the fixture; offline has no open database");
  return {
    compare(key: string, extra: Partial<ShadowLegacy> = {}) {
      queries.length = 0;
      assert.equal(views!.shadow({ view: VIEW, key, requests: 1, legacy: {
        data: [{ taskId: ID, status: "legacy" }], asOfMs: NOW, ...extra,
      } }), true);
      const state = (JSON.parse(readFileSync(viewShadowPath(stateDir), "utf8")) as Record<string, ViewShadowState>)[VIEW]!;
      return { diffs: state.diffs, queries: [...queries] };
    },
    instanceKey: keys[2]!,
  };
}

const cases = [
  { name: "before the legacy horizon", rowMs: NOW - 2 * HOUR, extra: { horizonMs: NOW - HOUR }, classification: "legacy_horizon", queries: 2 },
  { name: "missing from legacy's own rows", rowMs: NOW - HOUR / 2, extra: { horizonMs: NOW - HOUR, rows: {} }, classification: "legacy_horizon", queries: 3 },
  { name: "in the timing gap", rowMs: NOW - HOUR / 2, extra: { asOfMs: NOW - HOUR }, classification: "timing", queries: 3 },
] as const;

test("test/shadow-evidence-reads-only-the-key-s-own-instance.test.ts", async (t) => {
  for (const scenario of cases) {
    await t.test(`${scenario.name}: foreign rows leave the diff real and only the key's store is queried`, (t) => {
      const f = fixture(t, scenario.rowMs);
      const result = f.compare(f.instanceKey, scenario.extra);
      assert.deepEqual(result.diffs, { real: 1, legacy_horizon: 0, timing: 0, dedupe: 0 });
      assert.deepEqual(result.queries, Array(scenario.queries).fill(INSTANCE));
    });
    await t.test(`${scenario.name}: own rows explain the diff`, (t) => {
      const f = fixture(t, scenario.rowMs, true);
      const result = f.compare(f.instanceKey, scenario.extra);
      assert.equal(result.diffs.real, 0);
      assert.equal(result.diffs[scenario.classification], 1);
      assert.deepEqual(result.queries, Array(scenario.queries).fill(INSTANCE));
    });
  }
});

test("fleet keys keep reading every open database", (t) => {
  const f = fixture(t, NOW - 2 * HOUR);
  for (const key of ["", "part=tasks"]) {
    const result = f.compare(key, { horizonMs: NOW - HOUR });
    assert.equal(result.diffs.real, 0);
    assert.ok(result.diffs.legacy_horizon > 0);
    assert.deepEqual(result.queries, ["core", "core", INSTANCE, INSTANCE]);
  }
});

test("an instance with no open database never borrows another store", (t) => {
  const f = fixture(t, NOW - HOUR / 2);
  for (const key of ["instance=offline", "instance=unknown", "instance="]) {
    const result = f.compare(key, { asOfMs: NOW - HOUR, horizonMs: NOW - HOUR });
    assert.equal(result.diffs.timing, 0);
    assert.equal(result.diffs.legacy_horizon, 0);
    assert.ok(result.diffs.real > 0);
    assert.deepEqual(result.queries, []);
  }
});

test("the comparator passes the decoded key instance to its evidence callback", () => {
  const instance = "console +/east";
  const instances: Array<string | null> = [];
  const shadow = createViewShadow({ log: () => {}, evidence: (input) => {
    instances.push(input.instance);
    return readShadowEvidence([], input);
  } });
  for (const key of [new URLSearchParams({ id: ID, instance }).toString(), "part=tasks", "instance="]) {
    shadow.compare({ view: VIEW, key, requests: 1, legacy: { data: 1, asOfMs: NOW }, body: { data: 2, asOf: null } });
  }
  assert.deepEqual(instances, [instance, null, ""]);
});
