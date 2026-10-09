import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { createReadModelTicker, readModelLaneViews, type ReadModelView, type ReadModelViewFactory, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";

const proof = "test/a-view-lane-constructs-only-the-views-it-owns.test.ts";

/** A lane's ticker over two instances, its views counted as each factory makes one. */
function laneFixture(t: { after(run: () => void): void }, lane: "fast" | "heavy", costs: Record<string, number> = {}) {
  const dir = makeTempDir("lane-owned-views");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "off", views: { per: "shadow", global: "shadow", odd: "shadow" } }));
  let ms = 0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const made: Array<{ name: string; memo: Map<string, number> }> = [];
  const legacyCalls: Array<{ key: string; owner: number }> = [];
  const factory = (name: string, perInstance: boolean): ReadModelViewFactory => ({
    name, ...(perInstance ? { perInstance: true as const } : {}),
    create: () => {
      const memo = new Map<string, number>();
      const owner = made.push({ name, memo }) - 1;
      const view: ReadModelView = {
        name, version: 1, ...(perInstance ? { perInstance: true } : {}),
        materialize: (ctx) => ctx.instances.map(({ state }) => {
          memo.set(state.instance, (memo.get(state.instance) ?? 0) + 1);
          ms += costs[`${name}@${state.instance}`] ?? 1;
          return { key: `instance=${state.instance}`, data: { instance: state.instance, builds: memo.get(state.instance) }, sources: [] };
        }),
        legacy: (key) => {
          legacyCalls.push({ key, owner });
          return undefined;
        },
      };
      return view;
    },
  });
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: dir, instances: ["core", "site"].map((name) => ({ name, ledgerDir: dir })), clock,
    views: [factory("per", true), factory("global", false)], viewsOnly: true, lane, oracle: "off", post: (msg) => void posted.push(msg) });
  t.after(() => void ticker.release());
  ticker.observe([]);
  const count = (name: string) => made.filter((view) => view.name === name).length;
  const held = () => posted.flatMap((msg) => msg.type === "log" && msg.step === "read_model.view_lane_held" ? [msg.extra] : []).at(-1);
  const bodies = () => posted.flatMap((msg) => msg.type === "body" ? [`${msg.entry.view}:${msg.entry.key}`] : []);
  return { ticker, made, count, held, bodies, posted, legacyCalls, advance: (by: number) => void (ms += by) };
}

test(`${proof}: a heavy lane constructs only the units moved to it, and a unit that leaves drops its view`, (t) => {
  const { ticker, count, made, held } = laneFixture(t, "heavy");
  ticker.tick();
  assert.equal(made.length, 0, "a heavy lane that owns nothing constructs no view at all");
  ticker.lane({ view: "per", instance: "core", heavy: true, dueAt: 0, costMs: 2000 });
  ticker.tick();
  assert.deepEqual(made.map((view) => [view.name, [...view.memo.keys()]]), [["per", ["core"]]],
    "only the moved unit's view is constructed, and it holds only its own instance");
  assert.equal(count("global"), 0);
  ticker.lane({ view: "per", instance: "core", heavy: false, dueAt: 0, costMs: 1 });
  assert.deepEqual(held(), { lane: "heavy", count: 0, units: [] }, "a unit that moved away is no longer held here");
  ticker.lane({ view: "per", instance: "core", heavy: true, dueAt: 0, costMs: 2000 });
  ticker.tick();
  assert.equal(count("per"), 2, "the unit came back to a fresh view: the first one was let go");
  assert.equal(made[1]!.memo.get("core"), 1);
  ticker.lane({ heavy: false, dueAt: 0 });
  ticker.tick();
  assert.equal(made.length, 2, "a reclaim by the fast lane constructs nothing more here");
});

test(`${proof}: a fast lane gives each per-instance unit its own view and lets go of the one that turns heavy`, (t) => {
  const { ticker, count, made, held, bodies, posted } = laneFixture(t, "fast", { "per@core": 2000 });
  // A unit never measured starts only in a pass that has spent nothing, so each tick here builds one.
  for (let i = 0; i < 4; i++) ticker.tick();
  assert.equal(count("per"), 2, "one view per instance unit");
  assert.equal(count("global"), 1);
  assert.deepEqual(new Set(bodies()), new Set(["per:instance=core", "per:instance=site", "global:instance=core", "global:instance=site"]));
  const moved = posted.find((msg) => msg.type === "view_lane");
  assert.ok(moved && moved.type === "view_lane" && moved.view === "per" && moved.instance === "core" && moved.heavy, "core's unit went heavy");
  assert.deepEqual(held(), { lane: "fast", count: 0, units: [] }, "the moved unit's view was dropped, not held");
  const site = made.find((view) => view.name === "per" && view.memo.has("site"))!;
  ticker.lane({ view: "per", instance: "site", heavy: false, dueAt: 0 });
  ticker.tick();
  assert.equal(site.memo.get("site"), 2, "the unit that stayed keeps its warm view");
  assert.equal(count("per"), 2, "nothing is constructed for a unit the lane did not build");
  ticker.lane({ heavy: false, dueAt: 0 });
  ticker.buildNow("per");
  assert.equal(count("per"), 3, "a reclaimed unit is built on a fresh view");
});

test(`${proof}: the shadow asks the view that published the body, and never constructs one to ask`, (t) => {
  const { ticker, legacyCalls, made } = laneFixture(t, "fast");
  for (let i = 0; i < 4; i++) ticker.tick();
  const before = made.length;
  assert.equal(ticker.shadow({ view: "per", key: "instance=site", requests: 1 }), false);
  assert.deepEqual(legacyCalls.map((call) => made[call.owner]!.name), ["per", "per"], "each made per-instance view is asked in turn");
  assert.equal(ticker.shadow({ view: "missing", key: "instance=site", requests: 1 }), false);
  assert.equal(made.length, before, "asking constructs nothing");
});

test(`${proof}: a factory whose view does not match what it declares is refused, and the lane carries on`, (t) => {
  const dir = makeTempDir("lane-owned-mismatch");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "off", views: { odd: "shadow" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: dir, instances: [], viewsOnly: true, lane: "fast", oracle: "off",
    clock: { now: () => 0, date: () => new Date(0), iso: () => new Date(0).toISOString() },
    views: [{ name: "odd", create: () => ({ name: "odd", version: 1, demand: true, materialize: () => [] }) }], post: (msg) => void posted.push(msg) });
  t.after(() => void ticker.release());
  ticker.observe([]);
  ticker.tick();
  const failed = posted.find((msg) => msg.type === "log" && msg.step === "read_model.materialize_failed");
  assert.ok(failed && failed.type === "log" && String(failed.extra.error).includes("odd factory made a view that does not match"));
});

test(`${proof}: every lane factory declares what its view is, in the order the lanes built them before`, (t) => {
  const dir = makeTempDir("lane-owned-list");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock: Clock = { now: () => 0, date: () => new Date(0), iso: () => new Date(0).toISOString() };
  const list = readModelLaneViews({ instances: [{ name: "core", ledgerDir: dir }] }, clock, () => {}, createDemandBook({ clock }));
  assert.deepEqual(list.map((view) => view.name), ["nav-badge", "repositories", "analytics", "read-model", "now", "instances", "task", "inbox-thread",
    "workstreams", "actions", "host", "agent", "incidents", "operator-agent-rows"]);
  for (const spec of list) {
    if (!("create" in spec)) continue;
    const view = spec.create();
    assert.deepEqual([view.name, view.perInstance, view.demand, view.snapshotSourced], [spec.name, spec.perInstance, spec.demand, spec.snapshotSourced], spec.name);
  }
});
