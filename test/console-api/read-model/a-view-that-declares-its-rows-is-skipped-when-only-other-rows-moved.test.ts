import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { coldAnalyticsSnapshot } from "#src/lib/analytics-route.js";
import { analyticsSourceBodies, ANALYTICS_STALE_AFTER_MS, type AnalyticsViewData } from "#src/lib/analytics-view.js";
import { fixedClock } from "#src/lib/clock.js";
import { captureRepositoryFlow, type RepositoryFlow } from "#src/lib/repository-flow.js";
import { AGENT_CLOCK_MS } from "#src/lib/agent-view.js";
import { INSTANCE_LIVENESS_BOUND_MS, type InstancesData } from "#src/lib/instances-view.js";
import { navBadgeAnalyticsSlice, navBadgeSourcesPath, INBOX_STALE_AFTER_MS, NAV_BADGE_CLOCK_MS } from "#src/lib/nav-badge-view.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import type { ViewSource } from "#src/lib/views.js";
import {
  createReadModelTicker, readModelLaneViews, readModelSwitchesPath,
  type ReadModelView, type ReadModelViewContext, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

function fixture(t: TestContext) {
  const dir = readModelFixtureDir(t, "declared-view");
  const planPath = join(dir, "plan.yaml");
  writeFileSync(planPath, "tasks: []\n");
  const ledgerDir = join(dir, "core");
  mkdirSync(ledgerDir);
  let now = Date.now();
  const start = now;
  const iso = () => new Date(now).toISOString();
  writeFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: iso(), step: "daemon.tick" }) + "\n");
  mkdirSync(join(dir, "read-model"));
  const switches = (push = "off") => writeFileSync(readModelSwitchesPath(dir), JSON.stringify({
    projector: "on", views: { declared: "serve" }, push,
  }));
  switches();
  const messages: ReadModelWorkerMessage[] = [];
  let builds = 0;
  let value = 1;
  let key = "";
  let fresh = true;
  let source: Pick<ViewSource, "name" | "budgetMs"> = { name: "file:fixture" };
  let context: ReadModelViewContext;
  const view: ReadModelView & { inputsFingerprint?: (ctx: ReadModelViewContext) => string | undefined } = {
    name: "declared", version: 1,
    inputsFingerprint: () => "own-input",
    materialize: ctx => {
      context = ctx;
      builds++;
      return [{ key, data: { value }, sources: [{ ...source, asOf: iso(), state: fresh ? "fresh" : "stale" }] }];
    },
  };
  const ticker = createReadModelTicker({ stateDir: dir, instances: [{ name: "core", ledgerDir, planPath }],
    views: [view], oracle: "off", holder: "declared-test",
    clock: { now: () => now, date: () => new Date(now), iso }, post: message => { messages.push(message); },
  });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start();
  const build = () => ticker.buildNow(view.name);
  const tick = (ms = 0) => { now += ms; ticker.tick(); };
  const append = (step = "run.start") => appendFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: iso(), step }) + "\n");
  const body = () => {
    const last = messages.filter(m => m.type === "body").at(-1);
    assert.ok(last?.type === "body");
    return last.entry;
  };
  return { ticker, view, planPath, dir, tick, append, build, body, switches, messages,
    start, count: () => builds, context: () => context!, iso,
    value: (n: number) => { value = n; }, key: (s: string) => { key = s; }, fresh: (b: boolean) => { fresh = b; },
    source: (next: typeof source) => { source = next; },
  };
}

test("W1-T11975 criterion 1: own inputs replace generations and undeclared snapshots, preserving guards", t => {
  const f = fixture(t);
  f.view.legacy = (_key, asOfMs, data) => ({ data, asOfMs });
  f.tick();
  f.build(); // First would-be skip is audited.
  assert.equal(f.count(), 2);
  f.view.digestReads = () => { throw new Error("superseded digest must not run"); };
  f.build();
  assert.equal(f.count(), 2, "a whole-input declaration supersedes digestReads");
  const db = f.context().instances[0].db!;
  const generation = db.meta("generation");
  f.append();
  f.tick();
  assert.notEqual(db.meta("generation"), generation, "positive control: unrelated row moved the generation");
  assert.equal(f.count(), 2);
  assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: false, names: ["unread"], error: "unrelated failure", atMs: f.start }), true);
  f.build();
  assert.equal(f.count(), 2, "undeclared snapshots, including failures, cannot invalidate");
  f.view.inputsFingerprint = () => "moved";
  f.build();
  assert.equal(f.count(), 3, "the declared fingerprint is part of the digest");
  writeFileSync(f.planPath, "tasks: []\n# changed\n");
  f.build();
  assert.equal(f.count(), 4, "plan identity is retained");
  f.switches("on");
  f.tick(5_001);
  assert.equal(f.count(), 5, "switches are retained");
  assert.equal(f.ticker.shadow({ view: "declared", key: "", requests: 1 }), true);
  f.build();
  assert.equal(f.count(), 6, "shadow readiness is retained");
  const state = f.context().instances[0].state;
  f.ticker.observe([{ ...state, heldBy: "new-holder" }]);
  f.build();
  assert.equal(f.count(), 7, "lease holder is retained");
  f.ticker.observe([{ ...state, reason: "failed projection", failures: 1 }]);
  f.build(); f.build();
  assert.equal(f.count(), 9, "unhealthy stores cannot certify reuse");
});

test("W1-T11975 criterion 4: undeclared views retain the generation and snapshot digest", t => {
  const f = fixture(t);
  f.tick(); f.build(); f.build();
  assert.equal(f.count(), 2, "a declaration enables reuse of the same file-backed sources");
  delete f.view.inputsFingerprint;
  f.view.ledgerReads = () => null;
  f.tick(); f.build();
  assert.equal(f.count(), 4, "file-backed sources remain unreusable without a declaration");
  let builds = 0;
  f.view.materialize = ctx => {
    builds++;
    return [{ key: "", data: { oldDigest: true }, sources: [{ name: "plan:core", asOf: new Date(ctx.now).toISOString(), state: "fresh" }] }];
  };
  f.build(); f.build();
  const before = f.body();
  f.build();
  assert.equal(f.body(), before);
  f.append(); f.tick();
  assert.equal(builds, 3, "an undeclared view still rebuilds when its store generation moves");
});

/**
 * Every reading of source `name` the worker has posted, oldest first. A reading is posted whenever a source's
 * stamp moves (the clock list and the per-body list), so a skip that restamped a source as of the clock would
 * add a reading with a newer as-of here, while a faithful republish adds none or repeats the built one.
 */
function readingsOf(messages: ReadModelWorkerMessage[], name: string): Array<ViewSource> {
  return messages.flatMap(m => m.type === "sources" ? [...m.sources, ...(m.bodies ?? []).flatMap(b => b.sources)] : [])
    .filter(source => source.name === name);
}

test("W1-T11975 criterion 6: a skip republishes a non-ledger source as its last build stamped it, not as of the clock", t => {
  const f = fixture(t);
  f.tick(); // The first build stamps file:fixture as of t0.
  const builtAsOf = f.body().body.sources.find(source => source.name === "file:fixture")!.asOf!;
  f.build(); // The first would-be skip is audited: a build at the same instant.
  assert.equal(f.count(), 2);
  assert.equal(readingsOf(f.messages, "file:fixture").at(-1)?.asOf, builtAsOf,
    "positive control: the posted readings carry the built stamp");
  const mark = f.messages.length;
  const calls = f.count();
  f.tick(1_000); // Past the unit's rebuild interval (its measured cost is zero), so the unit is due.
  f.build();
  assert.ok(Date.parse(f.iso()) > Date.parse(builtAsOf), "the clock is past the build");
  assert.equal(f.count(), calls, "the build function was not called: both passes skipped");
  assert.equal(f.messages.filter(m => m.type === "log" && m.step === "read_model.materialize_failed").length, 0);
  const after = readingsOf(f.messages.slice(mark), "file:fixture");
  assert.ok(after.every(source => source.asOf === builtAsOf), "no skip posted a reading stamped as of the clock");
  assert.equal(readingsOf(f.messages, "file:fixture").at(-1)?.asOf, builtAsOf, "the latest reading is still the build's");
  assert.notEqual(readingsOf(f.messages, "file:fixture").at(-1)?.asOf, f.iso());
  f.tick(600_000);
  const tally = f.messages.find(m => m.type === "log" && m.step === "read_model.view_builds");
  assert.ok(tally?.type === "log");
  assert.ok(Number(tally.extra.skipped) >= 1, "the tally counts the skips");
  // Responsiveness: when the unit does build at the later clock, the same channel reports the newer stamp.
  const beforeMoved = f.count();
  f.view.inputsFingerprint = () => "moved";
  f.build();
  assert.equal(f.count(), beforeMoved + 1, "a moved fingerprint calls the build function");
  assert.equal(readingsOf(f.messages, "file:fixture").at(-1)?.asOf, f.iso(), "a real build is observable as a newer stamp");
  assert.notEqual(f.iso(), builtAsOf);
});

test("W1-T11975 criterion 6: a last body with a source that is not fresh is always rebuilt", t => {
  const f = fixture(t);
  f.fresh(false);
  f.tick();
  f.tick(1_000);
  f.build(); f.build();
  assert.equal(f.count(), 4, "an unchanged fingerprint cannot skip while the last body has a stale source");
  assert.equal(f.body().body.stale, true);
  f.tick(600_000);
  const tally = f.messages.find(m => m.type === "log" && m.step === "read_model.view_builds");
  assert.ok(tally?.type === "log");
  assert.equal(tally.extra.skipped, undefined, "nothing was skipped");
  assert.ok((tally.extra.not_skipped as Record<string, number>).sources >= 3, "each rebuild is counted under sources");
});

test("W1-T11975 criterion 6: positive control, the same sequence with a fresh source skips", t => {
  const f = fixture(t);
  f.tick();
  f.tick(1_000);
  f.build(); f.build();
  assert.equal(f.count(), 2, "only the first build and the audit call the build function");
});

test("W1-T11975 criterion 6: a fresh source that ages past its budget between builds is rebuilt, not republished", t => {
  const f = fixture(t);
  f.source({ name: "github:fixture", budgetMs: 2_000 });
  f.tick();
  f.build();
  const builtAsOf = f.body().body.sources[0].asOf!;
  assert.equal(f.count(), 2);
  f.tick(1_000);
  assert.equal(f.count(), 2, "inside the budget the body is skipped");
  f.tick(3_000); // The built source is now 4 s old against a 2 s budget: judged stale, though its producer called it fresh.
  assert.equal(f.count(), 3, "past the budget the body is rebuilt");
  assert.equal(readingsOf(f.messages, "github:fixture").at(-1)?.asOf, f.iso());
  assert.notEqual(f.iso(), builtAsOf);
  f.build();
  assert.equal(f.count(), 3, "positive control: freshly stamped, the next pass skips again");
});

test("W1-T11975 criterion 7: first and twentieth skips audit, mismatch disables only that unit", t => {
  const f = fixture(t);
  f.tick(); f.build();
  assert.equal(f.count(), 2, "first would-be skip builds");
  for (let i = 0; i < 19; i++) f.build();
  assert.equal(f.count(), 2);
  f.value(2);
  f.build();
  assert.equal(f.count(), 3, "twenty would-be skips after the first, audit runs again");
  assert.deepEqual(f.body().body.data, { value: 2 });
  const rows = f.messages.filter(m => m.type === "log" && m.step === "read_model.view_skip_mismatch");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].type === "log");
  assert.equal(rows[0].extra.view, "declared");
  assert.equal(rows[0].extra.differing_keys, 1);
  f.build(); f.build();
  assert.equal(f.count(), 5, "the mismatch permanently disables reuse");
  f.tick(600_000);
  const tally = f.messages.find(m => m.type === "log" && m.step === "read_model.view_builds");
  assert.ok(tally?.type === "log");
  const reasons = tally.extra.not_skipped as Record<string, number>;
  assert.equal(reasons.audit, 2);
  assert.ok(reasons.mismatch >= 2);
  assert.equal(Object.values(reasons).reduce((a, b) => a + b, 0) + Number(tally.extra.skipped), tally.extra.calls);
});

test("W1-T11975 criterion 7: an audited key replacement publishes and retires the previous key", t => {
  const f = fixture(t);
  f.tick();
  f.key("replacement"); f.build();
  assert.equal(f.body().key, "replacement");
  assert.ok(f.messages.some(m => m.type === "drop" && m.view === "declared" && m.key === ""));
  const row = f.messages.find(m => m.type === "log" && m.step === "read_model.view_skip_mismatch");
  assert.ok(row?.type === "log");
  assert.equal(row.extra.differing_keys, 2);
});

test("W1-T11975 criterion 1: undefined, throwing and unfenced inputs build conservatively", t => {
  const f = fixture(t);
  f.tick(); f.build(); f.build();
  assert.equal(f.count(), 2);
  f.view.inputsFingerprint = () => undefined;
  f.build(); f.build();
  assert.equal(f.count(), 4);
  f.view.inputsFingerprint = () => { throw new Error("input unavailable"); };
  f.build();
  assert.equal(f.count(), 5);
  assert.ok(f.messages.some(m => m.type === "log" && m.step === "read_model.view_digest_unreadable" && m.extra.error === "input unavailable"));
  f.view.inputsFingerprint = () => "own-input";
  const db = f.context().sourceStore!;
  db.prepare("UPDATE lease SET holder = 'someone-else', expires_ms = ?").run(f.start + 60_000);
  f.build(); f.build();
  assert.equal(f.count(), 7, "a live foreign holder cannot certify reuse");
  db.prepare("UPDATE lease SET holder = 'someone-else', expires_ms = 0").run();
  f.build(); f.build();
  assert.equal(f.count(), 9, "expired home ownership cannot certify reuse");
  f.tick(600_000);
  const row = f.messages.find(m => m.type === "log" && m.step === "read_model.view_builds");
  assert.ok(row?.type === "log");
  assert.ok((row.extra.not_skipped as Record<string, number>).inputs >= 7);
});

const DECLARED = ["instances", "agent", "analytics", "nav-badge"];

function production(t: TestContext, raw = false) {
  const dir = readModelFixtureDir(t, "production-fingerprints");
  let now = Math.floor(Date.now() / AGENT_CLOCK_MS) * AGENT_CLOCK_MS + 1_000;
  const start = now;
  const iso = () => new Date(now).toISOString();
  const clock = { now: () => now, date: () => new Date(now), iso };
  const planPath = join(dir, "plan.yaml");
  writeFileSync(planPath, "tasks: []\n");
  const instances = ["core", "console"].map(name => {
    const ledgerDir = name === "core" ? dir : join(dir, name);
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: iso(), step: "daemon.tick" }) + "\n");
    writeFileSync(join(ledgerDir, "inbox-proposals.json"), "[]");
    return { name, repo: `owner/${name}`, ledgerDir, planPath };
  });
  const repoPath = join(dir, "registry.yaml"), hostPath = join(dir, "host.yaml");
  const registry = "instances:\n" + instances.map(i => `  ${i.name}:\n    github_repo: ${i.repo}\n    project: example\n`).join("");
  writeFileSync(repoPath, registry); writeFileSync(hostPath, registry);
  mkdirSync(join(dir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(dir), JSON.stringify({ views: Object.fromEntries(DECLARED.map(name => [name, "serve"])) }));
  const snapshot = { ...structuredClone(coldAnalyticsSnapshot()), asOf: iso() };
  snapshot.consoleV1.metrics = [
    { key: "runs.completed", class: "observed", value: 10 },
    { key: "tokens.total", class: "provider_reported", value: 1_000_000 },
  ];
  const publish = () => writeFileSync(navBadgeSourcesPath(dir), JSON.stringify({ inboxStateDir: dir,
    instances: instances.map(i => ({ instanceId: i.name, repository: i.repo, analytics: navBadgeAnalyticsSlice(snapshot) })),
  }));
  publish();
  const classify = (states = {}) => writeFileSync(join(dir, "inbox-classified.json"), JSON.stringify({ generatedAt: iso(), states }));
  classify();
  const messages: ReadModelWorkerMessage[] = [];
  const counts = new Map<string, number>();
  const contexts = new Map<string, ReadModelViewContext>();
  const output = new Map<string, ReturnType<ReadModelView["materialize"]>>();
  const originals = new Map<string, ReadModelView>();
  const lane = readModelLaneViews({ stateDir: dir, instances, registry: { repoPath, hostPath } }, clock, () => {}, createDemandBook({ clock }))
    .filter(v => DECLARED.includes(v.name));
  const views = raw ? lane : lane.map(spec => {
    const view = "create" in spec ? spec.create() : spec;
    const materialize = view.materialize;
    view.materialize = ctx => {
      contexts.set(view.name, ctx);
      counts.set(view.name, (counts.get(view.name) ?? 0) + 1);
      const built = materialize(ctx);
      output.set(view.name, built);
      return built;
    };
    originals.set(view.name, view);
    return view;
  });
  const ticker = createReadModelTicker({ stateDir: dir, instances, views, clock, oracle: "off", holder: "production-test",
    post: message => { messages.push(message); },
  });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start(); ticker.tick();
  for (const instance of instances) assert.equal(ticker.acceptSnapshot({ instance: instance.name, ok: true, asOf: iso(),
    bodies: analyticsSourceBodies(snapshot, instance.repo) }), true);
  ticker.tick();
  const build = (name: string) => ticker.buildNow(name);
  for (let i = 0; i < 3; i++) for (const name of DECLARED) build(name);
  const append = (step: string, extra = {}, instance = "core") => {
    const dir = instances.find(i => i.name === instance)!.ledgerDir;
    appendFileSync(join(dir, "ledger.ndjson"), JSON.stringify({ ts: iso(), step, ...extra }) + "\n");
  };
  const tick = (ms = 0) => { now += ms; ticker.tick(); };
  const fingerprint = (name: string) => {
    const view = originals.get(name)!;
    assert.equal(typeof view.inputsFingerprint, "function", `${name} declares its inputs`);
    return view.inputsFingerprint!(contexts.get(name)!);
  };
  const equalFullBuild = (name: string) => {
    build(name);
    const built = output.get(name);
    const view = originals.get(name)!;
    const declaration = view.inputsFingerprint;
    view.inputsFingerprint = () => undefined;
    build(name);
    view.inputsFingerprint = declaration;
    assert.deepEqual(output.get(name), built, `${name}'s changed body equals the skip-disabled build`);
  };
  return { ticker, dir, instances, messages, originals, contexts, counts, output, build, tick, append, classify,
    fingerprint, equalFullBuild, start, iso, snapshot, publish, repoPath, hostPath,
  };
}

test("W1-T11975 criterion 2: all four declarations skip unrelated diagnostics and snapshot failures", t => {
  const f = production(t);
  const before = new Map(f.counts);
  f.append("read_model.slow_view");
  f.tick();
  assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: false, names: ["unread"], error: "unrelated", atMs: f.start }), true);
  for (const name of DECLARED) {
    assert.equal(typeof f.fingerprint(name), "string", `${name} has a readable declaration`);
    f.build(name);
    assert.equal(f.counts.get(name), before.get(name), `${name} skips unrelated changes`);
  }
  const generation = f.contexts.get("agent")!.sourceStore!.meta("generation");
  f.append("run.start"); f.tick();
  assert.notEqual(f.contexts.get("agent")!.sourceStore!.meta("generation"), generation);
  // W1-T13835: instances no longer publishes the projector generation, so it skips this row too.
  for (const name of DECLARED) assert.equal(f.counts.get(name), before.get(name), `${name} also ignores a generation-moving unread row`);
  const analytics = f.originals.get("analytics")!;
  f.snapshot.asOf = new Date(f.start + 1).toISOString();
  const bodies = analyticsSourceBodies(f.snapshot, "owner/core");
  Object.assign(bodies[0].body as object, { repositoryFlow: { invalid: true } });
  f.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: f.snapshot.asOf, bodies });
  f.build("analytics");
  assert.equal(f.fingerprint("analytics"), undefined,
    "analytics with a repositoryFlow input stays uncertified: invalid-source fallback stamps materializedAt on every build");
  const count = f.counts.get("analytics")!;
  f.build("analytics"); f.build("analytics");
  assert.equal(f.counts.get("analytics"), count + 2);
  assert.ok(analytics.inputsFingerprint);
});

test("W1-T11975 criterion 3: relevant rows, home snapshots and files change fingerprints and equal full builds", t => {
  const f = production(t);
  assert.equal((f.output.get("nav-badge")![0].data as { agent: { count: number } }).agent.count, 2,
    "positive control: the fold and sidecar produce real proposals before either input moves");
  const changed = (name: string, mutate: () => void) => {
    const before = f.fingerprint(name);
    assert.equal(typeof before, "string");
    mutate();
    assert.notEqual(f.fingerprint(name), before, `${name}'s input is represented`);
    f.equalFullBuild(name);
  };
  changed("agent", () => {
    f.append("panel.operator_agent_settings", { settings: { enabled: false, confidenceThreshold: 0.99 },
      scope: { kind: "repository", repository: "owner/console" } }, "console");
    f.tick();
  });
  changed("nav-badge", () => { f.classify({ "ruling:one": "ready" }); });
  changed("nav-badge", () => {
    f.append("panel.operator_agent_settings", { settings: { enabled: false, confidenceThreshold: 0.99 },
      scope: { kind: "repository", repository: "owner/core" } });
    f.tick();
  });
  assert.equal((f.output.get("nav-badge")![0].data as { agent: { count: number } }).agent.count, 0);
  changed("nav-badge", () => { f.snapshot.asOf = new Date(f.start + 1).toISOString(); f.publish(); });
  changed("instances", () => { writeFileSync(f.hostPath, "instances:\n"); });
  changed("instances", () => { appendFileSync(f.repoPath, "# registry observation changed\n"); });
  changed("instances", () => { writeFileSync(join(f.dir, "inbox-proposals.json"), "{}"); });
  // W1-T13873: a heartbeat with the instance up is no longer an instances input (see "W1-T13873 liveness"); the
  // analytics case still needs the clock a second on, so its snapshot as_of moves.
  changed("analytics", () => {
    f.tick(1_000);
    f.snapshot.asOf = f.iso();
    f.snapshot.consoleV1.metrics[0] = { key: "runs.completed", class: "observed", value: 42 };
    assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: f.iso(), bodies: analyticsSourceBodies(f.snapshot, "owner/core") }), true);
  });
  changed("agent", () => {
    assert.equal(f.ticker.acceptSnapshot({ instance: "console", ok: false, names: ["signals"], error: "home source failed", atMs: f.start + 2 }), true);
  });
});

test("W1-T13873 liveness: a heartbeat that brings a down instance back up changes the instances fingerprint and equals a full build", t => {
  const f = production(t);
  f.tick(INSTANCE_LIVENESS_BOUND_MS + 1);
  f.build("instances");
  const down = f.output.get("instances")![0].data as InstancesData;
  assert.ok(down.instances.filter(entry => entry.served).every(entry => entry.liveness.state === "down"), "positive control: every served instance is down");
  const before = f.counts.get("instances")!;
  const fingerprint = f.fingerprint("instances");
  f.append("daemon.tick"); f.append("daemon.tick", {}, "console"); f.tick();
  assert.notEqual(f.fingerprint("instances"), fingerprint, "W1-T13873 liveness: a beat that changes liveness is an input");
  f.build("instances");
  assert.equal(f.counts.get("instances"), before + 1, "instances rebuilds");
  const up = f.output.get("instances")![0].data as InstancesData;
  assert.ok(up.instances.filter(entry => entry.served).every(entry => entry.liveness.state === "up"), "every served instance is up again");
  f.equalFullBuild("instances");
});

test("W1-T11975 criterion 5: a skipped instances body crosses the liveness bound without a new row", t => {
  const f = production(t);
  const before = f.counts.get("instances");
  f.build("instances");
  assert.equal(f.counts.get("instances"), before, "positive control: instances was skipped");
  const fingerprint = f.fingerprint("instances");
  f.tick(INSTANCE_LIVENESS_BOUND_MS + 1);
  f.build("instances");
  assert.notEqual(f.fingerprint("instances"), fingerprint);
  const data = f.output.get("instances")![0].data as InstancesData;
  assert.ok(data.instances.every(instance => instance.liveness.state === "down"));
  f.equalFullBuild("instances");
});

test("W1-T11975 criterion 3: clock buckets and snapshot stale comparisons invalidate without rows", t => {
  const f = production(t);
  const agent = f.fingerprint("agent");
  f.tick(AGENT_CLOCK_MS);
  assert.notEqual(f.fingerprint("agent"), agent);
  f.equalFullBuild("agent");
  const badge = f.fingerprint("nav-badge");
  f.tick(INBOX_STALE_AFTER_MS);
  assert.notEqual(f.fingerprint("nav-badge"), badge);
  f.equalFullBuild("nav-badge");
  const analytics = f.fingerprint("analytics");
  f.tick(ANALYTICS_STALE_AFTER_MS);
  assert.notEqual(f.fingerprint("analytics"), analytics);
  f.equalFullBuild("analytics");
});

test("W1-T11975 criterion 3: a nav-badge proposal expiring with no row moving rebuilds and equals the skip-disabled build", t => {
  const f = production(t);
  const agent = () => (f.output.get("nav-badge")![0].data as { agent: { count: number; proposalIds: string[] } }).agent;
  const id = agent().proposalIds.find(candidate => candidate.includes(":core-"));
  assert.ok(id, "positive control: the core instance has a candidate proposal");
  assert.equal(NAV_BADGE_CLOCK_MS, AGENT_CLOCK_MS, "the badge's expiry bucket is the agent view's");
  const expiresAt = new Date(f.start + AGENT_CLOCK_MS / 2).toISOString();
  f.append("panel.operator_agent_proposal", { proposal: {
    proposalId: id, repo: "owner/core", proposalText: "Review token usage", reasoning: "measured usage", category: "optimize",
    status: "pending", createdAt: f.iso(), expiresAt, confidence: 0.9, evidence: [],
  } });
  f.tick();
  f.build("nav-badge");
  assert.equal(agent().count, 2, "the proposal is pending before its expiry");
  const built = f.counts.get("nav-badge");
  const fingerprint = f.fingerprint("nav-badge");
  f.build("nav-badge");
  assert.equal(f.counts.get("nav-badge"), built, "positive control: nothing moved, so the badge is skipped");
  f.tick(AGENT_CLOCK_MS);
  assert.ok(Date.parse(expiresAt) <= f.start + AGENT_CLOCK_MS, "the clock is past the proposal's expiresAt");
  assert.notEqual(f.fingerprint("nav-badge"), fingerprint, "the expiry comparison moves the fingerprint with no row moving");
  f.build("nav-badge");
  assert.equal(f.counts.get("nav-badge"), built! + 1, "the expiry forces a build");
  assert.equal(agent().count, 1, "the expired proposal leaves the count");
  assert.ok(!agent().proposalIds.includes(id!));
  f.equalFullBuild("nav-badge");
});

test("W1-T11975 criterion 8: production lane declarations skip unrelated rows and tally real audits", t => {
  const f = production(t, true);
  for (let i = 0; i < 5; i++) {
    f.append("read_model.slow_view"); f.tick();
    for (const name of DECLARED) f.build(name);
  }
  f.tick(600_000);
  for (const name of DECLARED) {
    const rows = f.messages.filter(m => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === name);
    assert.ok(rows.length > 0, `${name} is registered in production`);
    for (const row of rows) {
      assert.ok(row.type === "log");
      assert.ok(Number(row.extra.skipped) > 0, `${name} skips with the production declaration`);
      const reasons = row.extra.not_skipped as Record<string, number>;
      assert.ok(reasons.audit > 0, `${name} counts production audit builds`);
      assert.equal(Object.values(reasons).reduce((a, b) => a + b, 0) + Number(row.extra.skipped), row.extra.calls);
    }
  }
  assert.equal(f.messages.filter(m => m.type === "log" && m.step === "read_model.view_skip_mismatch").length, 0);
});

test("W1-T11975 criterion 6: a skipped production instances body republishes registry:repo and inbox-capability as built", t => {
  const f = production(t);
  const built = f.output.get("instances")![0].sources;
  const names = ["registry:repo", ...f.instances.map(i => `inbox-capability:${i.name}`)];
  const stamps = new Map(names.map(name => {
    const source = built.find(candidate => candidate.name === name);
    assert.ok(source, `${name} is a source of the built instances body`);
    assert.equal(source.state, "fresh", `${name} is fresh, so the declared body may be reused`);
    return [name, source.asOf] as const;
  }));
  assert.equal(stamps.get("inbox-capability:core"), f.iso(), "the capability source is stamped as of the build's clock");
  for (const name of names) {
    assert.equal(readingsOf(f.messages, name).at(-1)?.asOf, stamps.get(name), `positive control: ${name}'s posted reading is the built stamp`);
  }
  const mark = f.messages.length;
  const calls = f.counts.get("instances");
  f.tick(1_000); // Inside the capability stamp's bucket and the liveness bound, so only the clock moves.
  f.build("instances");
  assert.notEqual(f.iso(), stamps.get("inbox-capability:core"), "the clock is past the build");
  assert.equal(f.counts.get("instances"), calls, "the instances build function was not called: both passes skipped");
  for (const name of names) {
    assert.ok(readingsOf(f.messages.slice(mark), name).every(source => source.asOf === stamps.get(name)),
      `no skip posted ${name} stamped as of the clock`);
    assert.equal(readingsOf(f.messages, name).at(-1)?.asOf, stamps.get(name), `${name} is still republished as built`);
  }
});

/** Publish each instance's console-v1 snapshot carrying the repositoryFlow the production writer attaches. */
async function acceptFlowSnapshots(f: ReturnType<typeof production>, mutate: (flow: RepositoryFlow) => unknown = flow => flow) {
  f.snapshot.asOf = new Date(f.start + 1).toISOString();
  for (const instance of f.instances) {
    const flow = await captureRepositoryFlow(f.dir, f.dir, instance.repo, fixedClock(f.start));
    assert.ok(flow, "the production capture reports a flow for a repository-bearing instance");
    const bodies = analyticsSourceBodies(f.snapshot, instance.repo);
    Object.assign(bodies[0].body as object, { repositoryFlow: mutate(flow) });
    assert.equal(f.ticker.acceptSnapshot({ instance: instance.name, ok: true, asOf: f.snapshot.asOf, bodies }), true);
  }
  f.ticker.tick();
}

test("W1-T11975 criterion 8: analytics with a valid repositoryFlow in every snapshot is fingerprinted and skipped", async t => {
  const f = production(t);
  await acceptFlowSnapshots(f);
  for (let i = 0; i < 3; i++) f.build("analytics");
  const flowOf = () => (f.output.get("analytics")![0].data as AnalyticsViewData).instances.map(instance => instance.repositoryFlow);
  assert.ok(flowOf().every(flow => flow?.version === "repository-flow-v1"), "positive control: the body publishes the stored flows");
  assert.equal(typeof f.fingerprint("analytics"), "string", "a valid flow does not make analytics undeclared");
  const stamped = flowOf().map(flow => flow!.materializedAt);
  const calls = f.counts.get("analytics");
  f.append("read_model.slow_view"); f.tick();
  f.build("analytics"); f.build("analytics");
  assert.equal(f.counts.get("analytics"), calls, "an unrelated row does not rebuild analytics with a valid flow");
  const fingerprint = f.fingerprint("analytics");
  f.tick(ANALYTICS_STALE_AFTER_MS + 1);
  assert.notEqual(f.fingerprint("analytics"), fingerprint, "the stale comparison still moves the fingerprint");
  f.equalFullBuild("analytics");
  assert.deepEqual(flowOf().map(flow => flow!.materializedAt), stamped, "a valid flow is published as stored, not stamped as of the clock");
});

test("W1-T11975 criterion 8: a changed repositoryFlow moves the fingerprint and equals the skip-disabled build", async t => {
  const f = production(t);
  await acceptFlowSnapshots(f);
  for (let i = 0; i < 3; i++) f.build("analytics");
  const before = f.fingerprint("analytics");
  assert.equal(typeof before, "string");
  f.snapshot.asOf = new Date(f.start + 2).toISOString();
  for (const instance of f.instances) {
    const flow = await captureRepositoryFlow(f.dir, f.dir, instance.repo, fixedClock(f.start));
    const bodies = analyticsSourceBodies(f.snapshot, instance.repo);
    Object.assign(bodies[0].body as object, { repositoryFlow: { ...flow!, state: "partial", gaps: ["a new gap"] } });
    assert.equal(f.ticker.acceptSnapshot({ instance: instance.name, ok: true, asOf: f.snapshot.asOf, bodies }), true);
  }
  f.equalFullBuild("analytics");
  assert.notEqual(f.fingerprint("analytics"), before);
  const body = f.output.get("analytics")![0].data as AnalyticsViewData;
  assert.ok(body.instances.every(instance => instance.repositoryFlow?.gaps.includes("a new gap")));
});

test("W1-T11975 criterion 8: a repositoryFlow the body would restamp as of the clock stays undeclared", async t => {
  const f = production(t);
  await acceptFlowSnapshots(f, flow => ({ ...flow, materializedAt: new Date(f.start + 3_600_000).toISOString() }));
  f.build("analytics");
  assert.equal(f.fingerprint("analytics"), undefined, "a flow stamped ahead of the clock is replaced by a clock-stamped fallback");
  const calls = f.counts.get("analytics");
  f.build("analytics"); f.build("analytics");
  assert.equal(f.counts.get("analytics"), calls! + 2, "every call builds while the body holds a per-build stamp");
});

test("W1-T11975 criterion 8: production lane skips analytics when a valid repositoryFlow is in the snapshots", async t => {
  const f = production(t, true);
  await acceptFlowSnapshots(f);
  for (let i = 0; i < 5; i++) {
    f.append("read_model.slow_view"); f.tick();
    f.build("analytics");
  }
  f.tick(600_000);
  const rows = f.messages.filter(m => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === "analytics");
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.type === "log");
    assert.ok(Number(row.extra.skipped) > 0, "analytics skips with the production declaration and a valid flow");
    const reasons = row.extra.not_skipped as Record<string, number>;
    assert.ok(reasons.audit > 0, "the audit build is counted");
  }
});

test("W1-T11975 criterion 7: an instance mismatch leaves the other instance's audits and skips enabled", t => {
  const f = production(t);
  const agent = f.originals.get("agent")!;
  const materialize = agent.materialize;
  agent.materialize = ctx => materialize(ctx).map(body => ctx.instances[0].state.instance === "console"
    ? { ...body, data: { ...body.data as object, missedInput: true } } : body);
  for (let i = 0; i < 45; i++) f.build("agent");
  const mismatches = f.messages.filter(m => m.type === "log" && m.step === "read_model.view_skip_mismatch");
  assert.equal(mismatches.length, 1);
  assert.ok(mismatches[0].type === "log");
  assert.equal(mismatches[0].extra.instance, "console");
  f.tick(600_000);
  const rows = f.messages.flatMap(m => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === "agent" ? [m.extra] : []);
  const core = rows.find(row => row.instance === "core")!;
  const console = rows.find(row => row.instance === "console")!;
  assert.ok(Number(core.skipped) > Number(console.skipped));
  assert.equal((core.not_skipped as Record<string, number>).mismatch, undefined);
  assert.ok((console.not_skipped as Record<string, number>).mismatch > 0);
});

test("W1-T13835 criterion 1: a row that moves only the projector generation leaves the instances body skipped and equal to a full build", t => {
  const f = production(t);
  const before = f.counts.get("instances");
  const fingerprint = f.fingerprint("instances");
  const generation = f.contexts.get("instances")!.instances.map(({ state }) => state.generation);
  f.append("run.start"); f.tick();
  assert.notDeepEqual(f.contexts.get("instances")!.instances.map(({ state }) => state.generation), generation, "positive control: the row moved a generation");
  assert.equal(f.fingerprint("instances"), fingerprint, "the generation is not an input");
  f.build("instances");
  assert.equal(f.counts.get("instances"), before, "instances is skipped");
  const data = f.output.get("instances")![0].data as InstancesData;
  assert.ok(data.instances.every(entry => entry.inboxCapabilityEvidence === undefined || !Object.hasOwn(entry.inboxCapabilityEvidence, "generation")),
    "no entry publishes the per-pass generation");
  f.equalFullBuild("instances");
});

test("W1-T13873 criterion 1: a daemon heartbeat that keeps every instance up leaves the instances body skipped, restamped and equal to a full build", t => {
  const f = production(t);
  const beats = () => f.contexts.get("instances")!.instances.map(({ db }) =>
    (db?.prepare("SELECT last_ms FROM instance_heartbeat WHERE k = 'daemon'").get() as { last_ms: number } | undefined)?.last_ms);
  const before = f.counts.get("instances");
  const fingerprint = f.fingerprint("instances");
  const beat = beats();
  f.tick(1_000); f.append("daemon.tick"); f.append("daemon.tick", {}, "console"); f.tick();
  assert.notDeepEqual(beats(), beat, "positive control: the rows moved every instance's heartbeat");
  assert.equal(f.fingerprint("instances"), fingerprint, "W1-T13873 heartbeat: a beat that keeps liveness up is not an input");
  f.build("instances");
  assert.equal(f.counts.get("instances"), before, "instances is skipped");
  f.tick();
  const restamped = f.messages.flatMap(m => m.type === "sources" ? m.bodies ?? [] : []).filter(b => b.view === "instances").at(-1);
  const core = restamped?.sources.find(source => source.name === "ledger:core");
  assert.equal(core?.asOf, fixedClock(beats()[0]!).iso(), "the skip restamps the ledger source at the new heartbeat");
  const data = f.output.get("instances")![0].data as InstancesData;
  assert.ok(data.instances.filter(entry => entry.served).every(entry => entry.liveness.state === "up"), "every served instance is still up");
  const view = f.originals.get("instances")!;
  const declaration = view.inputsFingerprint;
  view.inputsFingerprint = () => undefined;
  f.build("instances");
  view.inputsFingerprint = declaration;
  assert.equal(f.counts.get("instances"), before! + 1, "positive control: the skip-disabled build ran");
  assert.deepEqual(f.output.get("instances")![0].data, data, "the skipped body's data equals the skip-disabled build");
});
