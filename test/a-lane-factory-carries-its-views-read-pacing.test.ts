import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { createReadModelTicker, readModelLaneViews, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";

const proof = "test/a-lane-factory-carries-its-views-read-pacing.test.ts";
const clock: Clock = { now: () => 0, date: () => new Date(0), iso: () => new Date(0).toISOString() };

test(`${proof}: the lane's now factory is read-paced, as the view it makes is`, (t) => {
  const dir = makeTempDir("lane-read-paced");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const list = readModelLaneViews({ instances: [{ name: "core", ledgerDir: dir }] }, clock, () => {}, createDemandBook({ clock }));
  const now = list.find((spec) => spec.name === "now");
  assert.ok(now && "create" in now, "the lane builds now from a factory");
  assert.equal(now.readPaced, true, "the factory the ticker paces by declares the now view read-paced");
  for (const spec of list) {
    if (!("create" in spec)) continue;
    assert.equal(!!spec.create().readPaced, !!spec.readPaced, spec.name);
  }
});

test(`${proof}: a factory that hides its view's read pacing is refused, and the lane carries on`, (t) => {
  const dir = makeTempDir("lane-read-paced-mismatch");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "off", views: { paced: "shadow" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: dir, instances: [], viewsOnly: true, lane: "fast", oracle: "off", clock,
    views: [{ name: "paced", create: () => ({ name: "paced", version: 1, readPaced: true, materialize: () => [] }) }], post: (msg) => void posted.push(msg) });
  t.after(() => void ticker.release());
  ticker.observe([]);
  ticker.tick();
  const failed = posted.find((msg) => msg.type === "log" && msg.step === "read_model.materialize_failed");
  assert.ok(failed && failed.type === "log" && String(failed.extra.error).includes("paced factory made a view that does not match"));
});
