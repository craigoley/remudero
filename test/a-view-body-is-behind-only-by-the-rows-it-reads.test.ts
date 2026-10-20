import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createInstancesView } from "#src/lib/instances-view.js";
import {
  builtLedgerSource, createReadModelTicker, createReadModelWorker, ledgerSource, readModelSwitchesPath,
  type ReadModelInstanceState, type ReadModelView, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { ViewSource } from "#src/lib/views.js";

const START = Date.parse("2026-10-18T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function fixture(t: TestContext, declared = true, heartbeat = true) {
  const dir = makeTempDir("view-ledger-reads");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "read-model"), { recursive: true });
  const repoPath = join(dir, "instances.yaml");
  writeFileSync(repoPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n    project: remudero\n");
  const ledger = join(dir, "ledger.ndjson");
  const append = (step: string, ms: number) => appendFileSync(ledger, `${JSON.stringify({ ts: iso(ms), step })}\n`);
  writeFileSync(ledger, "");
  if (heartbeat) append("daemon.tick", START - 60_000);
  append("unrelated.initial", START);
  const instances = [{ name: "core", ledgerDir: dir }];
  const view: ReadModelView = createInstancesView({ instances, repoPath, ledgerSource });
  if (!declared) delete view.ledgerReads;
  let now = START;
  const messages: ReadModelWorkerMessage[] = [];
  writeFileSync(readModelSwitchesPath(dir), JSON.stringify({ views: { instances: "serve" } }));
  const ticker = createReadModelTicker({
    stateDir: dir, instances, views: [view], oracle: "off", holder: "view-reads-test",
    clock: { now: () => now, date: () => new Date(now), iso: () => iso(now) },
    post: (message) => messages.push(message),
  });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const body = messages.flatMap((m) => m.type === "body" ? [m.entry.body] : [])[0];
  assert.ok(body, "the real projector and view built a body");
  const built = body.sources.find((s) => s.name === "ledger:core")!;
  ticker.lane({ view: "instances", heavy: false, dueAt: Number.POSITIVE_INFINITY, costMs: 0 });
  const advance = (ms: number, step?: string) => {
    now = ms;
    if (step) append(step, ms);
    ticker.tick();
  };
  const state = (): ReadModelInstanceState => {
    const latest = messages.filter((m) => m.type === "state").at(-1);
    assert.ok(latest?.type === "state");
    return latest.instances[0];
  };
  const judge = (at = now, projector = state()): ViewSource => {
    const latest = messages.filter((m) => m.type === "sources").at(-1);
    const reads = latest?.type === "sources" ? latest.ledgerReads?.instances?.[built.name] : undefined;
    return builtLedgerSource(built, projector, at, undefined, reads);
  };
  return { advance, built, body, judge, state, messages };
}

test("W1-T10076: an instances body built before unrelated rows landed stays fresh", (t) => {
  const f = fixture(t);
  f.advance(START + 30_000, "unrelated.later");
  assert.equal(f.state().newestTs, iso(START + 30_000));
  assert.equal(f.built.asOf, iso(START - 60_000), "the worker stamps the heartbeat, not the global ledger head");
  assert.equal(f.messages.filter((m) => m.type === "body").length, 1, "the body was not rebuilt");
  assert.equal(f.judge().state, "fresh");
  assert.equal(f.judge().asOf, f.built.asOf);
  assert.equal(f.body.sources[0].name, "registry:repo");
});

test("W1-T10076: an instances body built before a newer daemon heartbeat goes stale past the budget", (t) => {
  const f = fixture(t);
  f.advance(START + 30_000, "daemon.tick");
  assert.equal(f.judge().state, "fresh", "a newly missed heartbeat gets the full tick budget");
  assert.equal(f.judge(START + 40_000, { ...f.state(), tickedAt: START + 40_000 }).state, "fresh");
  f.advance(START + 40_001, "unrelated.after-heartbeat");
  const stale = f.judge();
  assert.deepEqual([stale.state, stale.phase, stale.asOf, stale.lagMs, stale.budgetMs],
    ["stale", "behind", f.built.asOf, 10_001, 10_000]);
  assert.match(stale.reason!, /newer rows/);
});

test("W1-T10076: a stalled projector still makes the instances body stale", (t) => {
  const f = fixture(t);
  assert.equal(f.judge(START + 10_001).state, "stale");
  assert.equal(f.judge(START + 10_001).phase, "behind");
  for (const [change, phase] of [
    [{ failures: 1, reason: "projection failed" }, "failed"],
    [{ lease: "elsewhere", reason: "lease held elsewhere" }, "elsewhere"],
    [{ tickedAt: undefined }, "warming"],
    [{ catchUp: { at: START, etaMs: 60_000, rowsBehind: 1 }, reason: "catching up" }, "catching_up"],
  ] as const) {
    const stale = f.judge(START, { ...f.state(), ...change });
    assert.equal(stale.state, "stale");
    assert.equal(stale.phase, phase);
  }
});

test("W1-T10076: a view that declares no ledger reads is judged as before", (t) => {
  const f = fixture(t, false);
  assert.equal(f.built.asOf, iso(START));
  assert.equal(f.judge(START + 30_000, { ...f.state(), tickedAt: START + 30_000 }).state, "fresh");
  f.advance(START + 30_000, "unrelated.later");
  const stale = f.judge();
  assert.deepEqual([stale.state, stale.asOf, stale.lagMs], ["stale", iso(START), 30_000]);
});

test("a first daemon heartbeat invalidates a body built without one", (t) => {
  const f = fixture(t, true, false);
  assert.equal(f.built.asOf, null);
  assert.equal(f.judge().state, "fresh");
  f.advance(START + 30_000, "daemon.tick");
  f.advance(START + 40_001);
  assert.equal(f.judge().state, "stale");
});

test("serve judges the real instances worker's heartbeat readings without changing the source shape", async (t) => {
  const dir = makeTempDir("served-ledger-reads");
  mkdirSync(join(dir, "read-model"), { recursive: true });
  const repoPath = join(dir, "instances.yaml");
  writeFileSync(repoPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n    project: remudero\n");
  const now = Date.now();
  writeFileSync(join(dir, "ledger.ndjson"), [
    { ts: iso(now - 60_000), step: "daemon.tick" },
    { ts: iso(now), step: "unrelated.later" },
  ].map((row) => JSON.stringify(row) + "\n").join(""));
  writeFileSync(readModelSwitchesPath(dir), JSON.stringify({ views: { instances: "serve" } }));
  let readReceived = false;
  const handle = createReadModelWorker({
    stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], registry: { repoPath },
    every: () => () => {},
    observe: (m) => {
      if (m.type === "sources" && m.ledgerReads?.instances?.["ledger:core"] === iso(now - 60_000)) readReceived = true;
    },
  });
  t.after(() => { handle.stop(); rmSync(dir, { recursive: true, force: true }); });
  handle.start();
  const deadline = Date.now() + 20_000;
  while ((!readReceived || !handle.body("instances") || !handle.state().instances.get("core")?.tickedAt) && Date.now() < deadline) await sleep(10);
  assert.equal(readReceived, true, "the real worker sent its declared read head");
  const body = handle.body("instances")!;
  assert.ok(body);
  const judged = handle.judge(body.body.sources, Date.now(), { view: "instances", key: "" });
  const source = judged.find((s) => s.name === "ledger:core")!;
  assert.deepEqual([source.state, source.asOf], ["fresh", iso(now - 60_000)]);
  assert.deepEqual(Object.keys(source).sort(), ["asOf", "budgetMs", "instance", "kind", "lagMs", "name", "state"]);
  assert.equal(judged.find((s) => s.name === "registry:repo")?.state, "fresh");
  assert.equal(handle.judge(body.body.sources, Date.now() + 10_001, { view: "instances", key: "" })
    .find((s) => s.name === "ledger:core")?.state, "stale");
});
