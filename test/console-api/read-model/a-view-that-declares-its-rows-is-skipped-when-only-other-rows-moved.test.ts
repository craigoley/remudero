import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { coldAnalyticsSnapshot } from "#src/lib/analytics-route.js";
import { analyticsSourceBodies, ANALYTICS_STALE_AFTER_MS } from "#src/lib/analytics-view.js";
import { AGENT_CLOCK_MS } from "#src/lib/agent-view.js";
import { INSTANCE_LIVENESS_BOUND_MS, type InstancesData } from "#src/lib/instances-view.js";
import { navBadgeAnalyticsSlice, navBadgeSourcesPath, INBOX_STALE_AFTER_MS } from "#src/lib/nav-badge-view.js";
import { createDemandBook } from "#src/lib/view-demand.js";
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
  let context: ReadModelViewContext;
  const view: ReadModelView & { inputsFingerprint?: (ctx: ReadModelViewContext) => string | undefined } = {
    name: "declared", version: 1,
    inputsFingerprint: () => "own-input",
    materialize: ctx => {
      context = ctx;
      builds++;
      return [{ key, data: { value }, sources: [{ name: "file:fixture", asOf: iso(), state: fresh ? "fresh" : "stale" }] }];
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
    start, count: () => builds, context: () => context!,
    value: (n: number) => { value = n; }, key: (s: string) => { key = s; }, fresh: (b: boolean) => { fresh = b; },
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

test("W1-T11975 criterion 6: skip preserves non-ledger stamps and stale sources always rebuild", t => {
  const f = fixture(t);
  f.view.ledgerReads = () => null;
  f.tick(); f.build();
  const stamped = f.body().body.sources;
  f.tick(1_000);
  const sources = f.messages.flatMap(m => m.type === "sources" ? m.bodies ?? [] : []).at(-1);
  assert.equal(f.count(), 2);
  // A skip may emit no source update at all when every source is unchanged.
  assert.deepEqual(sources?.sources ?? stamped, stamped);
  f.view.inputsFingerprint = () => "stale-build";
  f.fresh(false);
  f.build(); f.build(); f.build();
  assert.equal(f.count(), 5);
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
  for (const name of ["agent", "analytics", "nav-badge"]) assert.equal(f.counts.get(name), before.get(name), `${name} also ignores a generation-moving unread row`);
  assert.equal(f.counts.get("instances"), before.get("instances")! + 1,
    "instances reads generation in inboxCapabilityEvidence and must rebuild when that field moves");
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
  changed("instances", () => { f.tick(1); f.append("daemon.tick"); f.tick(); });
  changed("analytics", () => {
    f.snapshot.asOf = f.iso();
    f.snapshot.consoleV1.metrics[0] = { key: "runs.completed", class: "observed", value: 42 };
    assert.equal(f.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: f.iso(), bodies: analyticsSourceBodies(f.snapshot, "owner/core") }), true);
  });
  changed("agent", () => {
    assert.equal(f.ticker.acceptSnapshot({ instance: "console", ok: false, names: ["signals"], error: "home source failed", atMs: f.start + 2 }), true);
  });
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
