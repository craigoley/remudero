import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, mock, describe } from "node:test";
import { buildOnboardingGoLiveRoutes, buildOnboardingReadinessRoute, buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { buildInstanceGatewayRoutes, watchInstanceLiveness, type InstanceGatewayOptions } from "../src/lib/instance-gateway.js";
import { fixedClock } from "../src/lib/clock.js";
import { registryInstanceRoots } from "../src/lib/benchmark-aa-readiness.js";
import { knownPlanRepos, lintDraftedFragment, fileRatificationDraft, fileRatificationBatch } from "../src/lib/inbox.js";
import { repoSummarySync } from "../src/lib/repo-dashboard-route.js";
import { GoLiveError } from "../src/lib/onboarding-golive.js";
import type { Route } from "../src/lib/service.js";
import type { OnboardingReadinessGateway } from "../src/lib/onboarding-readiness.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createSelectedRegistryObserver } from "../src/lib/selected-registry-consumers.js";
import * as registryConsumers from "../src/lib/selected-registry-consumers.js";
import { createRepositoriesReadModelView, createRepositoriesSourcePublisher } from "../src/lib/repositories-view.js";
import { createReadModelWorker, ledgerSource, readModelLaneViews } from "../src/lib/read-model-worker.js";
import { createDemandBook } from "../src/lib/view-demand.js";
import { trackWorkerThreads } from "../src/lib/worker-heaps.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";
import { readSelectedInstanceRegistry, registryFileIO } from "../src/lib/instance-registry-selection.js";

interface Row { step: string; fields: Record<string, unknown> }
function pendingValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const STEP = "instance_registry.consumer_shadow_observed";
const selectedText = (name = "fixture", repo = "owner/repo") =>
  `instances:\n  ${name}:\n    github_repo: ${repo}\n    mode: shadow\n    state_dir: /private/selected-material-sentinel\n`;
const gateway: OnboardingReadinessGateway = {
  listInstallationRepos: () => undefined, getRepo: () => undefined,
  getBranchProtection: () => undefined, getBranchRules: () => undefined, getContents: () => undefined,
};

async function invoke(route: Route, repo = "owner/repo"): Promise<{ code: number; body: Record<string, unknown>; raw: string }> {
  let code = 0, raw = "";
  await route.handler({ url: `/v1/onboarding/readiness?repo=${repo}` } as never,
    { writeHead: (n: number) => { code = n; }, end: (text: string) => { raw += text; } } as never, { params: {} });
  return { code, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

function fixture(t: { after(fn: () => void): void }, selected = true) {
  const root = makeTempDir("selected-serve-consumer");
  let retained = false;
  t.after(() => { if (!retained) rmSync(root, { recursive: true, force: true }); });
  const legacy = join(root, "legacy.yaml"), path = join(root, "selected.yaml");
  writeFileSync(legacy, selectedText("legacy"));
  if (selected) writeFileSync(path, selectedText());
  const rows: Row[] = [];
  const options = {
    settings: { mode: "shadow" as const, instanceName: "fixture", registryPath: path },
    record: (step: string, fields: Record<string, unknown>) => { rows.push({ step, fields }); },
  };
  const input = { repoRegistryPath: legacy, gateway, selectedRegistryObservation: options };
  return { root, legacy, path, rows, options, input, route: buildOnboardingReadinessRoute(input), preserve: () => { retained = true; } };
}

async function observed(rows: Row[]): Promise<Record<string, unknown> | undefined> {
  // The real selected FS reader is asynchronous and must not delay the independent HTTP effect.
  // Bound the test's observation wait, never promote timeout to successful selected evidence.
  for (let n = 0; n < 100; n++) {
    const row = rows.find(row => row.step === STEP);
    if (row) return row.fields;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return undefined;
}


describe("selected registry shadow reaches real serve and discovery consumers", () => {
test("selected readiness observer reaches the real handler without replacing legacy output", async (t) => {
  const f = fixture(t);
  const before = await invoke(buildOnboardingReadinessRoute({ repoRegistryPath: f.legacy, gateway }));
  const actual = await invoke(f.route);
  assert.equal(actual.code, 200);
  assert.deepEqual(actual.body.checks, before.body.checks, "actual healthy legacy checks remain unchanged");
  const row = await observed(f.rows);
  assert.ok(row, "the actual handler must forward the opt-in, not merely a helper fixture");
  assert.equal(row.action, "serve-readiness");
  assert.equal(row.selected_state, "ready");
  assert.equal(row.target_repo, "owner/repo");
  assert.equal(row.publication_permission, "not-granted");
  assert.ok(!actual.raw.includes("selected-material-sentinel"));
  assert.ok(!JSON.stringify(row).includes(f.root));
});

test("selected serve composition forwards one shadow context to the real registry readiness and dashboard routes", async (t) => {
  const f = fixture(t), ledgerPath = join(f.root, "ledger.ndjson"), planPath = join(f.root, "tasks.yaml");
  writeFileSync(f.legacy, selectedText("core"));
  writeFileSync(ledgerPath, ""); writeFileSync(planPath, "[]\n");
  const controller = new AbortController(); t.after(() => controller.abort());
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: {} },
    panelGraph: { root: f.root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: {}, ratify: { approve() {}, reframe() {} } },
    issues: { close: () => assert.fail("source qualification must never close an issue") },
    ledgerPath, fleetControlRoot: f.root, questionsRoot: f.root,
    tokens: { read: "r", write: "w" }, githubAppRefresh: { start: () => ({ armed: false }) }, log: () => {},
    registry: { repoRegistryPath: f.legacy }, onboardingReadiness: { gateway }, instances: { registryPath: f.legacy },
    selectedRegistryObservation: { ...f.options, input: { signal: controller.signal } },
  } as unknown as ServeDeps;
  const routes = buildServeRoutes(deps);
  for (const [path, expectedStatus] of [["/v1/registry", 200], ["/v1/onboarding/readiness", 200], ["/v1/repos/summary", 200], ["/v1/views/repositories", 404]] as const) {
    const route = routes.find(route => route.path === path); assert.ok(route, path);
    let raw = "", code = 0;
    await route.handler({ url: path + "?repo=owner/repo" } as never,
      { writeHead: (n: number) => { code = n; }, end: (text: string) => { raw += text; } } as never, { params: {} });
    assert.equal(code, expectedStatus, raw);
    assert.ok(!raw.includes("selected-material-sentinel"));
  }
  for (let n = 0; n < 100 && f.rows.filter(row => row.step === STEP).length < 4; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.rows.filter(row => row.step === STEP).map(row => row.fields.action).sort(), ["repo-dashboard", "repositories-view", "serve-readiness", "serve-registry"]);
  assert.ok(f.rows.every(row => row.fields.publication_permission === "not-granted"));
});

test("selected gateway observes the actual core request identity without changing its response", async (t) => {
  const f = fixture(t); writeFileSync(f.legacy, selectedText("core")); writeFileSync(f.path, selectedText("core"));
  const observer = createSelectedRegistryObserver(f.options)!; t.after(() => observer.close());
  const options = { registryPath: f.legacy, selectedRegistryObserver: observer };
  let effects = 0;
  const routes = buildInstanceGatewayRoutes([{ method: "GET", path: "/v1/status", scope: "read", handler: (_req, res) => {
    effects++; res.writeHead(200); res.end("legacy-core");
  } }], options);
  options.selectedRegistryObserver = createSelectedRegistryObserver({ ...f.options, record: () => {} })!;
  t.after(() => options.selectedRegistryObserver.close());
  const route = routes.find(route => route.path === "/v1/i/core/status"); assert.ok(route);
  let result = "";
  await route.handler({ url: route.path } as never, { writeHead() {}, end: (text: string) => { result += text; } } as never, { params: {} });
  await observer.settled();
  assert.equal(effects, 1); assert.equal(result, "legacy-core");
  const row = f.rows.find(row => row.fields.action === "serve-topology"); assert.ok(row);
  assert.equal(row.fields.target_instance, "core"); assert.equal(row.fields.target_repo, "owner/repo");
  assert.equal(row.fields.selected_state, "ready"); assert.equal(row.fields.publication_permission, "not-granted");
});

test("selected liveness rides the existing callback with real target and shutdown ownership", async (t) => {
  const f = fixture(t);
  writeFileSync(f.legacy, selectedText("core") + "  site:\n    github_repo: owner/site\n    mode: shadow\n");
  writeFileSync(f.path, selectedText("site", "owner/site"));
  const observer = createSelectedRegistryObserver(f.options)!; t.after(() => observer.close());
  const clock = fixedClock(Date.parse("2026-10-16T00:00:00Z"));
  let tick!: () => void, timers = 0, stopped = 0, reads = 0;
  const options: InstanceGatewayOptions & { ledgerPath: string; selectedRegistryObserver: typeof observer } = {
    registryPath: f.legacy, stateBase: f.root, ledgerPath: join(f.root, "ledger.ndjson"), selectedRegistryObserver: observer, clock,
    every: (run, ms) => { timers++; assert.equal(ms, 60000); tick = run; return () => { stopped++; }; },
    readLastRows: (instance) => { reads++; assert.equal(instance.name, "site"); return [{ ts: clock.iso(), step: "sweep.summary" }]; },
    gh: () => assert.fail("healthy control must never open or close a real issue"),
  };
  const stop = watchInstanceLiveness(options); t.after(() => { if (!stopped) stop(); });
  options.selectedRegistryObserver = createSelectedRegistryObserver({ ...f.options, record: () => {} })!;
  t.after(() => options.selectedRegistryObserver.close());
  assert.equal(timers, 1); tick();
  await observed(f.rows);
  assert.equal(reads, 1, "no second legacy scan is introduced by the observation");
  const row = f.rows.find(row => row.fields.action === "serve-liveness"); assert.ok(row);
  assert.equal(row.fields.target_instance, "site"); assert.equal(row.fields.target_repo, "owner/site"); assert.equal(row.fields.selected_state, "ready");
  stop(); assert.equal(stopped, 1);
});

test("selected benchmark discovery preserves actual legacy roots and names synchronous freshness unknown", (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver({ ...f.options,
    io: { lstat: () => assert.fail("sync discovery must not read selected IO"), open: () => assert.fail("sync discovery must not open selected IO") } })!;
  t.after(() => observer.close());
  writeFileSync(f.legacy, selectedText("core") + "  site:\n    github_repo: owner/site\n    mode: shadow\n");
  const read = () => readFileSync(f.legacy, "utf8"), local = join(f.root, "local"), base = join(f.root, "instances");
  const expected = registryInstanceRoots(local, read, base);
  const actual = Reflect.apply(registryInstanceRoots, undefined, [local, read, base, observer]);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, { roots: [{ instance: "core", stateDir: local }, { instance: "site", stateDir: join(base, "site", "state") }] });
  assert.equal(f.rows.at(-1)?.fields.action, "benchmark-discovery");
  assert.equal(f.rows.at(-1)?.fields.reason, "target_unavailable");
  assert.equal(f.rows.at(-1)?.fields.target_instance, undefined, "fleet discovery is not a configured single instance");
  assert.equal(f.rows.at(-1)?.fields.publication_permission, "not-granted");
});

test("selected inbox discovery preserves real registered repo defaults and unknown malformed evidence", (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!; t.after(() => observer.close());
  mkdirSync(join(f.root, ".remudero"));
  const path = join(f.root, ".remudero", "daemon-instances.yaml"); writeFileSync(path, selectedText("core"));
  assert.deepEqual(Reflect.apply(knownPlanRepos, undefined, [f.root, observer]), new Set(["none", "repo"]));
  assert.equal(f.rows.at(-1)?.fields.action, "inbox-discovery");
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "target_unavailable");
  writeFileSync(path, "instances: [invalid]");
  assert.equal(Reflect.apply(knownPlanRepos, undefined, [f.root, observer]), undefined, "legacy unreadable/malformed still refuses no repo");
});

test("selected inbox context reaches real lint and ratification defaults before any filing write", (t) => {
  const f = fixture(t), sync = Reflect.get(registryConsumers, "withSelectedRegistryContextSync");
  assert.equal(typeof sync, "function");
  const invalid = "not valid: [", expected = lintDraftedFragment(invalid, "P-selected");
  assert.deepEqual(Reflect.apply(sync, undefined, [createSelectedRegistryObserver(f.options), () => lintDraftedFragment(invalid, "P-selected")]), expected);
  assert.equal(f.rows.at(-1)?.fields.action, "inbox-discovery");
  // The real fileability guard must refuse before the supplied filesystem can write anything.
  const fs = { mkdirSync: () => assert.fail("invalid draft must not create directories"),
    writeFileSync: () => assert.fail("invalid draft must not write"), readFileSync: () => "" };
  const payload = { fragmentYaml: invalid, proposalId: "P-selected", stampLine: "stamp" };
  for (const batch of [false, true]) {
    f.rows.length = 0;
    assert.throws(() => Reflect.apply(sync, undefined, [createSelectedRegistryObserver(f.options), () => batch
      ? fileRatificationBatch(f.root, [payload], () => assert.fail("invalid draft must not mint"), fs, join)
      : fileRatificationDraft(f.root, payload, fs, join)]), /refus/i);
    assert.equal(f.rows.length, 1, "actual single/batch defaults must observe independently of their refusal");
    assert.equal(f.rows[0]?.fields.legacy_outcome, "returned", "discovery returns; the separate filing guard refuses");
  }
});

test("selected direct synchronous dashboard observes actual identity without changing projection", (t) => {
  const f = fixture(t), deps = { root: f.root, instanceRepository: { owner: "owner", repo: "repo" } };
  const expected = repoSummarySync(deps, 12345);
  const actual = repoSummarySync({ ...deps, selectedRegistryObserver: createSelectedRegistryObserver(f.options) }, 12345);
  assert.deepEqual(actual, expected);
  assert.equal(f.rows.at(-1)?.fields.action, "repo-dashboard");
  assert.equal(f.rows.at(-1)?.fields.target_repo, "owner/repo");
  assert.equal(f.rows.at(-1)?.fields.reason, "synchronous_seam");
  assert.equal(f.rows.at(-1)?.fields.publication_permission, "not-granted");
});

test("selected repositories factory observes real synchronous materialization without changing its body", (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!; t.after(() => observer.close());
  const ctx = { now: 0, instances: [] };
  const legacy = createRepositoriesReadModelView(ledgerSource).materialize(ctx);
  const view = Reflect.apply(createRepositoriesReadModelView, undefined, [ledgerSource, observer]) as ReturnType<typeof createRepositoriesReadModelView>;
  assert.deepEqual(view.materialize(ctx), legacy);
  const row = f.rows.at(-1); assert.ok(row);
  assert.equal(row.fields.action, "repositories-view"); assert.equal(row.fields.selected_state, "unknown");
  assert.equal(row.fields.publication_permission, "not-granted"); assert.ok(!JSON.stringify(row).includes(f.path));
});

test("selected real view-lane factory consumes optional shadow intent while old data stays compatible", (t) => {
  const f = fixture(t), clock = fixedClock(0), demand = createDemandBook({ clock });
  const capture = Reflect.get(registryConsumers, "captureSelectedRegistryIntent"); assert.equal(typeof capture, "function");
  const data = { instances: [], selectedRegistryIntent: capture(f.options) };
  const list = readModelLaneViews(data, clock, f.options.record, demand);
  const spec = list.find(view => view.name === "repositories"); assert.ok(spec && "create" in spec);
  assert.deepEqual(spec.create().materialize({ now: 0, instances: [] }), []);
  assert.equal(f.rows.at(-1)?.fields.action, "repositories-view");
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  f.rows.length = 0;
  const old = readModelLaneViews({ instances: [] }, clock, f.options.record, demand).find(view => view.name === "repositories"); assert.ok(old && "create" in old);
  assert.deepEqual(old.create().materialize({ now: 0, instances: [] }), []);
  assert.deepEqual(f.rows, [], "an absent old contract does not opt in by upgrade");
});

test("selected default projector and view workers carry optional intent without changing cached public bodies", { timeout: 60000 }, async (t) => {
  const f = fixture(t), stateDir = join(f.root, "state");
  mkdirSync(stateDir); mkdirSync(join(f.root, "plan"));
  writeFileSync(join(stateDir, "ledger.ndjson"), ""); writeFileSync(join(f.root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(f.legacy, selectedText("core"));
  createRepositoriesSourcePublisher({ stateDir, instances: () => [{ instanceId: "core", options: {
    root: f.root, repoRegistryPath: f.legacy, ownInstance: "core",
  } }] })();
  switchViewsOn(stateDir, ["repositories"], "shadow");
  let legacyBody: unknown;
  for (const enabled of [false, true]) {
    f.rows.length = 0;
    const threads = trackWorkerThreads();
    const options: Parameters<typeof createReadModelWorker>[0] = {
      stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 20, every: () => () => {},
      selectedRegistryObservation: enabled ? f.options : undefined,
      log: (step, fields = {}) => { f.rows.push({ step, fields }); },
    };
    const worker = createReadModelWorker(options);
    options.selectedRegistryObservation = undefined;
    try {
      worker.start();
      for (let n = 0; n < 1000 && (!worker.body("repositories") || (enabled && !f.rows.some(row => row.step === STEP && row.fields.target_instance === "core"))); n++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const body = worker.body("repositories")?.body.data; assert.ok(body, "the real default workers must produce an actual cached body");
      const selected = f.rows.filter(row => row.step === STEP);
      if (!enabled) { assert.deepEqual(selected, []); legacyBody = body; }
      else {
        assert.ok(selected.some(row => row.fields.action === "repositories-view" && row.fields.target_instance === "core"), "actual projector -> view thread -> factory forwarding, not just a fixture object");
        assert.ok(selected.every(row => row.fields.selected_state === "unknown" && row.fields.publication_permission === "not-granted"));
        assert.ok(!JSON.stringify(selected).includes(f.path));
        assert.deepEqual(body, legacyBody, "selected observation does not choose another public portfolio source");
      }
      assert.ok(!JSON.stringify(body).includes("selected-material-sentinel"));
    } finally {
      worker.stop();
      for (let n = 0; n < 200 && threads.live().length; n++) await new Promise(resolve => setTimeout(resolve, 10));
      const remaining = threads.live().length; threads.stop();
      if (remaining) f.preserve();
      assert.equal(remaining, 0, "preserve the fixture if any owned writer has not actually exited");
    }
  }
});


});

describe("selected serve failure never borrows legacy or cached authority", () => {
test("selected readiness missing source stays unknown beside a healthy legacy result", async (t) => {
  const f = fixture(t, false), actual = await invoke(f.route);
  assert.equal(actual.code, 200, "SHADOW is not a blocking gate");
  assert.ok((actual.body.checks as Array<{ id: string; status: string }>).some(c => c.id === "already-onboarded" && c.status === "warn"));
  const row = await observed(f.rows);
  assert.ok(row, "missing selected source must be observed independently of healthy legacy evidence");
  assert.equal(row.selected_state, "unknown");
  assert.equal(row.reason, "missing");
  assert.equal(row.publication_permission, "not-granted");
});

test("selected consumer catches an unexpected reader rejection without changing legacy effects", async (t) => {
  const f = fixture(t);
  const reader: typeof readSelectedInstanceRegistry = async () => { throw new Error("private-reader-error-sentinel"); };
  const observer = Reflect.apply(createSelectedRegistryObserver, undefined, [f.options, reader]) as NonNullable<ReturnType<typeof createSelectedRegistryObserver>>;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "source_read_rejected");
  assert.ok(!JSON.stringify(f.rows).includes("private-reader-error-sentinel"));
});

test("selected consumer catches a rejected final recheck without borrowing the original ready result", async (t) => {
  const f = fixture(t), selected = await readSelectedInstanceRegistry({ configuredPath: f.path });
  assert.equal(selected.kind, "ready");
  if (selected.kind !== "ready") return;
  const reader: typeof readSelectedInstanceRegistry = async () => ({ kind: "ready", binding: { ...selected.binding,
    recheck: async () => { throw new Error("private-recheck-error-sentinel"); } } });
  const observer = Reflect.apply(createSelectedRegistryObserver, undefined, [f.options, reader]) as NonNullable<ReturnType<typeof createSelectedRegistryObserver>>;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "recheck_failed");
  assert.equal(f.rows.at(-1)?.fields.binding_digest, selected.binding.digest);
  assert.ok(!JSON.stringify(f.rows).includes("private-recheck-error-sentinel"));
});

test("selected consumer distinguishes known row absence and retirement from an unreadable source", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { repository: "missing/repo" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "absent");
  writeFileSync(f.path, selectedText() + "    retired: true\n");
  const retired = createSelectedRegistryObserver(f.options)!;
  t.after(() => retired.close());
  await retired.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
  await retired.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "retired");
});

test("selected consumer unreadable captured input is explicit unknown", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver({ ...f.options, input: {
    get requiredCapabilities(): string[] { throw new Error("private-input-sentinel"); },
  } })!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.reason, "input_unreadable");
  assert.ok(!JSON.stringify(f.rows).includes("private-input-sentinel"));
});

test("selected consumer unreadable binding produces unknown even when its injected reader claimed ready", async (t) => {
  const f = fixture(t), selected = await readSelectedInstanceRegistry({ configuredPath: f.path });
  assert.equal(selected.kind, "ready");
  if (selected.kind !== "ready") return;
  const reader: typeof readSelectedInstanceRegistry = async () => ({ kind: "ready", binding: { ...selected.binding,
    get digest(): string { throw new Error("private-binding-sentinel"); } } });
  const observer = createSelectedRegistryObserver(f.options, reader)!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.reason, "observation_failed");
  assert.ok(!JSON.stringify(f.rows).includes("private-binding-sentinel"));
});


});

describe("selected serve observations retain current immutable source identity", () => {
test("selected trusted-worker intent snapshots data without carrying ports or granting authority", async (t) => {
  const f = fixture(t), capturePort = Reflect.get(registryConsumers, "captureSelectedRegistryIntent");
  assert.equal(typeof capturePort, "function");
  const capture = (value: unknown) => Reflect.apply(capturePort, undefined, [value]) as ReturnType<typeof registryConsumers.captureSelectedRegistryIntent>;
  const caps = ["identity"], options = { ...f.options, settings: { ...f.options.settings }, input: { requiredCapabilities: caps } };
  const intent = capture(options); assert.ok(intent && intent.kind === "shadow");
  options.settings.registryPath = join(f.root, "wrong.yaml"); caps[0] = "unsupported";
  assert.equal(intent.kind, "shadow"); assert.equal(intent.version, 1);
  assert.equal(intent.input.configuredPath, f.path); assert.deepEqual(intent.input.requiredCapabilities, ["identity"]);
  assert.deepEqual(structuredClone(intent), intent, "a data-only trusted-worker contract, not an object carrying closures");
  assert.equal(Object.isFrozen(intent.input.requiredCapabilities), true);
  assert.equal(capture(undefined), undefined);
  assert.equal(capture({ ...f.options, io: registryFileIO })!.kind, "unknown", "custom ports must never silently become defaults in another thread");
  assert.equal(capture({ ...f.options, input: { signal: new AbortController().signal } })!.kind, "unknown");
  assert.equal(capture({ ...f.options, input: { configuredPath: (() => "invalid") as unknown as string } })!.kind, "unknown");
  assert.equal(capture({ ...f.options, settings: { get mode() { throw new Error("private-config-sentinel"); } } })!.kind, "unknown");
  const restore = Reflect.get(registryConsumers, "selectedRegistryObserverFromIntent"); assert.equal(typeof restore, "function");
  const observer = restore(structuredClone(intent), f.options.record) as NonNullable<ReturnType<typeof createSelectedRegistryObserver>>;
  t.after(() => observer.close());
  await observer.observe("repositories-view", { instanceName: "fixture", repository: "owner/repo" }, () => "legacy");
  await observer.settled(); assert.equal(f.rows.at(-1)?.fields.selected_state, "ready", "restored data uses the real bounded async reader");
  assert.equal(f.rows.at(-1)?.fields.publication_permission, "not-granted");
  for (const invalid of [null, "invalid", { ...intent, version: 999 }, { ...intent, input: null }, { kind: "unknown", version: 1 },
    { ...intent, input: { requiredCapabilities: [42] } }, { ...intent, input: { timeoutMs: "invalid" } },
    { ...intent, input: { requiredCapabilities: "invalid" } }, { version: 1, get kind() { throw new Error("private-intent-sentinel"); } }]) {
    const unknown = Reflect.apply(restore, undefined, [invalid, f.options.record]) as typeof observer; t.after(() => unknown.close());
    await unknown.observe("repositories-view", { instanceName: "fixture" }, () => "legacy"); await unknown.settled();
    assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown"); assert.equal(f.rows.at(-1)?.fields.reason, "transport_unavailable");
    assert.ok(!JSON.stringify(f.rows.at(-1)).includes("private-intent-sentinel"));
  }
});

test("selected trusted intent reads accessor-backed input once before the worker boundary", (t) => {
  const f = fixture(t); let reads = 0;
  const intent = Reflect.apply(registryConsumers.copySelectedRegistryIntent, undefined, [{ kind: "shadow", version: 1, instanceName: "fixture",
    get input() { reads++; return { configuredPath: reads === 1 ? f.path : join(f.root, "wrong.yaml") }; },
  }]) as registryConsumers.SelectedRegistryIntent;
  assert.equal(reads, 1, "the transport must capture ONE original input, not validate one and send another");
  assert.equal(intent.kind, "shadow"); if (intent.kind === "shadow") assert.equal(intent.input.configuredPath, f.path);
});

test("selected consumer captures its source ports capabilities and target before awaits", async (t) => {
  const f = fixture(t), capabilities = ["identity"], io = { ...registryFileIO };
  const observer = createSelectedRegistryObserver({ ...f.options, input: { requiredCapabilities: capabilities }, io })!;
  t.after(() => observer.close());
  f.options.settings.registryPath = join(f.root, "wrong.yaml");
  capabilities[0] = "unsupported";
  io.lstat = () => assert.fail("captured IO cannot retarget through caller mutation");
  const gate = pendingValue<string>(), target = { repository: "owner/repo", instanceName: "fixture" };
  const value = observer.observe("serve-readiness", target, () => gate.promise);
  target.repository = "attacker/elsewhere";
  target.instanceName = "wrong";
  gate.resolve("legacy");
  assert.equal(await value, "legacy");
  await observer.settled();
  const row = f.rows.find(row => row.step === STEP)?.fields;
  assert.equal(row?.target_repo, "owner/repo");
  assert.equal(row?.target_instance, "fixture");
  assert.equal(row?.selected_state, "ready");
  assert.match(String(row?.binding_digest), /^[a-f0-9]{64}$/);
});

test("selected consumer holds the original digest and rechecks the real source at each adoption", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy-cached-body");
  await observer.settled();
  const digest = f.rows.at(-1)?.fields.binding_digest;
  assert.equal(f.rows.at(-1)?.fields.selected_state, "ready");
  writeFileSync(f.path, selectedText().replace("mode: shadow", "mode: live"));
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy-cached-body"), "legacy-cached-body");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "revision_changed");
  assert.equal(f.rows.at(-1)?.fields.binding_digest, digest, "never silently adopt a new source revision");
});

test("selected consumer reads accessor-backed settings exactly once", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const observer = createSelectedRegistryObserver({ record: f.options.record, get settings() {
    return ++reads === 1 ? f.options.settings : { ...f.options.settings, registryPath: join(f.root, "wrong.yaml") };
  } })!;
  t.after(() => observer.close());
  assert.equal(reads, 1, "the mode check and selected source must come from ONE settings snapshot");
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "ready");
});

test("selected consumer reads an explicit configured path exactly once", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const observer = createSelectedRegistryObserver({ ...f.options, input: { get configuredPath() {
    return ++reads === 1 ? f.path : join(f.root, "wrong.yaml");
  } } })!;
  t.after(() => observer.close());
  assert.equal(reads, 1, "the precedence check cannot re-read a mutable path accessor");
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "ready");
});


});

describe("selected serve qualification keeps private material out of public consumers", () => {
test("selected source outage preserves verified owner and configured-human flow without granting private publication", async (t) => {
  const f = fixture(t, false); writeFileSync(f.legacy, selectedText("core"));
  for (const actor of [undefined, "owner", "configured-human"]) {
    const answers: Array<{ code: number; body: string; calls: number }> = [];
    for (const enabled of [false, true]) {
      f.rows.length = 0; let calls = 0, code = 0, body = "";
      const deps = { ledgerPath: join(f.root, "ledger.ndjson"), questionsRoot: f.root, log: () => {},
        instances: { registryPath: f.legacy }, selectedRegistryObservation: enabled ? f.options : undefined,
        onboardingGoLive: { registryRepository: "owner/repo", api: async (method: string) => {
          assert.equal(method, "GET", "qualification never permits a publication write"); calls++;
          throw new GoLiveError("github_unavailable", 502);
        } },
      } as unknown as ServeDeps;
      const route = buildOnboardingGoLiveRoutes(deps).find(route => route.method === "POST"); assert.ok(route);
      assert.equal(route.scope, "write"); assert.equal(route.tier, "high");
      await route.handler({ url: route.path, [Symbol.for("remudero.service.rawBody")]: "{}",
        ...(actor === undefined ? {} : { [Symbol.for("remudero.service.verifiedActor")]: actor }) } as never,
        { writeHead: (n: number) => { code = n; }, end: (text: string) => { body += text; } } as never, { params: {} });
      answers.push({ code, body, calls });
      assert.equal(calls, actor === undefined ? 0 : 1, "selected failure must not globally hold an admitted owner/human flow");
      assert.equal(code, actor === undefined ? 403 : 502);
      if (enabled) {
        const row = await observed(f.rows); assert.ok(row);
        assert.equal(row.selected_state, "unknown"); assert.equal(row.publication_permission, "not-granted");
        assert.ok(!JSON.stringify(row).includes(f.path));
      } else assert.deepEqual(f.rows, []);
    }
    assert.deepEqual(answers[1], answers[0], "SHADOW must retain the exact legacy response and effect trace");
  }
});

test("selected go-live observation cannot replace the verified-owner refusal or authorize publication", async (t) => {
  const f = fixture(t); writeFileSync(f.legacy, selectedText("core")); writeFileSync(f.path, selectedText("core"));
  const deps = { ledgerPath: join(f.root, "ledger.ndjson"), questionsRoot: f.root, log: () => {},
    instances: { registryPath: f.legacy }, selectedRegistryObservation: f.options,
    onboardingGoLive: { readRows: () => assert.fail("non-owner must never reach go-live evidence or publication") },
  } as unknown as ServeDeps;
  const route = buildOnboardingGoLiveRoutes(deps).find(route => route.method === "POST"); assert.ok(route);
  let code = 0, body = "";
  await route.handler({ url: route.path, [Symbol.for("remudero.service.rawBody")]: "{}" } as never,
    { writeHead: (n: number) => { code = n; }, end: (text: string) => { body += text; } } as never, { params: {} });
  assert.equal(code, 403); assert.deepEqual(JSON.parse(body), { error: "verified_operator_required" });
  const row = await observed(f.rows); assert.ok(row); assert.equal(row.action, "serve-go-live");
  assert.equal(row.target_instance, "core"); assert.equal(row.target_repo, "owner/repo"); assert.equal(row.publication_permission, "not-granted");
});

test("selected consumer receipts retain public-safe source contract and capability identity", async (t) => {
  const f = fixture(t);
  for (const [selection, input] of [["configuration", {}], ["environment", { envPath: f.path }], ["cli", { cliPath: f.path }]] as const) {
    const observer = createSelectedRegistryObserver({ ...f.options, input,
      settings: { ...f.options.settings, contractVersion: 2 } })!;
    t.after(() => observer.close());
    await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
    await observer.settled();
    const fields = f.rows.at(-1)!.fields;
    assert.equal(fields.selection_source, selection);
    assert.equal(fields.contract_version, 2);
    assert.deepEqual(fields.capabilities, ["identity", "mode", "primary"]);
    assert.equal(Object.isFrozen(fields.capabilities), true);
    assert.ok(!JSON.stringify(fields).includes(f.root));
  }
});

test("selected consumer failed sinks are bounded unrecorded evidence and never effect permission", async (t) => {
  const f = fixture(t), diagnostics: string[] = [];
  const errors = mock.method(console, "error", (text: string) => { diagnostics.push(text); });
  t.after(() => errors.mock.restore());
  for (const kind of ["throw", "reject"] as const) {
    const observer = createSelectedRegistryObserver({ ...f.options, record: () => {
      if (kind === "throw") throw new Error("private-sink-error-sentinel");
      return Promise.reject(new Error("private-sink-error-sentinel"));
    } })!;
    t.after(() => observer.close());
    for (let n = 0; n < 2; n++) {
      assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
      await observer.settled();
    }
  }
  assert.deepEqual(diagnostics, ["instance_registry.consumer_shadow_unrecorded", "instance_registry.consumer_shadow_unrecorded"]);
});

test("selected consumer unreadable target never substitutes identity or private exception text", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { get repository(): string { throw new Error("private-target-sentinel"); } }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.reason, "target_unreadable");
  assert.equal(f.rows.at(-1)?.fields.target_repo, undefined);
  assert.ok(!JSON.stringify(f.rows).includes("private-target-sentinel"));
});


});

describe("selected serve defaults remain asynchronous shadow only and legacy compatible", () => {
test("selected discovery scopes isolate concurrent nested absent and escaped invocations", async (t) => {
  const f = fixture(t), other = fixture(t), ready = pendingValue<void>(), release = pendingValue<void>(), late = pendingValue<void>();
  const run = Reflect.get(registryConsumers, "withSelectedRegistryContext");
  const sync = Reflect.get(registryConsumers, "withSelectedRegistryContextSync");
  assert.equal(typeof run, "function"); assert.equal(typeof sync, "function");
  const first = createSelectedRegistryObserver(f.options), second = createSelectedRegistryObserver(other.options);
  let escaped!: () => ReadonlySet<string> | undefined;
  let lateWork!: Promise<ReadonlySet<string> | undefined>;
  const expected = knownPlanRepos(f.root);
  const a = Reflect.apply(run, undefined, [first, async () => {
    ready.resolve(); await release.promise;
    Reflect.apply(sync, undefined, [undefined, () => knownPlanRepos(f.root)]);
    assert.equal(f.rows.length, 0, "an absent nested invocation must mask the outer opt-in");
    assert.deepEqual(knownPlanRepos(f.root), expected);
    escaped = () => knownPlanRepos(other.root);
    lateWork = (async () => { await late.promise; return knownPlanRepos(f.root); })();
    return "first-result";
  }]) as Promise<string>;
  await ready.promise;
  const b = Reflect.apply(run, undefined, [second, async () => {
    await Promise.resolve(); knownPlanRepos(other.root); return "second-result";
  }]) as Promise<string>;
  assert.equal(await b, "second-result"); release.resolve(); assert.equal(await a, "first-result");
  assert.equal(f.rows.length, 1); assert.equal(other.rows.length, 1);
  assert.equal(f.rows[0]?.fields.reason, "target_unavailable", "aggregate discovery cannot invent a configured single-instance target");
  assert.equal(f.rows[0]?.fields.target_instance, undefined);
  assert.equal(f.rows[0]?.fields.publication_permission, "not-granted");
  const before = f.rows.length; late.resolve(); await lateWork; escaped(); knownPlanRepos(f.root);
  assert.equal(f.rows.length, before, "neither an escaped nor a later no-config call inherits authority");
  const failure = new Error("private-operation-sentinel");
  await assert.rejects(Reflect.apply(run, undefined, [undefined, async () => { throw failure; }]), error => error === failure);
  assert.throws(() => Reflect.apply(sync, undefined, [undefined, () => { throw failure; }]), error => error === failure);
});

test("absent selected dashboard context adds no reads of legacy identity accessors", (t) => {
  const f = fixture(t); let reads = 0;
  const result = repoSummarySync({ root: f.root, get instanceRepository() { reads++; return { owner: "owner", repo: "repo" }; } }, 12345);
  assert.equal(result.ok, true);
  assert.equal(reads, 5, "the unchanged legacy resolve/projection pass reads this accessor five times, not eight");
  assert.deepEqual(f.rows, []);
});


test("selected readiness absent opt-in preserves legacy checks without a selected read or receipt", async (t) => {
  const f = fixture(t);
  const input = { ...f.input, selectedRegistryObservation: { ...f.options, settings: undefined,
    io: { lstat: () => assert.fail("no selected read without explicit SHADOW"), open: () => assert.fail("no selected open without explicit SHADOW") } } };
  const actual = await invoke(buildOnboardingReadinessRoute(input));
  assert.equal(actual.code, 200);
  assert.equal(f.rows.length, 0);
});

test("selected consumer effects run immediately while the selected reader is pending", async (t) => {
  const f = fixture(t), pending = pendingValue<never>();
  const observer = createSelectedRegistryObserver({ ...f.options, io: { ...registryFileIO, lstat: () => pending.promise } })!;
  t.after(() => observer.close());
  let calls = 0;
  const value = observer.observe("serve-readiness", { repository: "owner/repo" }, () => { calls++; return "legacy"; });
  assert.equal(calls, 1, "SHADOW must not await selected IO before invoking the actual effect");
  assert.equal(await value, "legacy");
  assert.equal(f.rows.length, 0, "unresolved evidence is not a successful observation");
  observer.close();
  await observer.settled();
});

test("selected consumer invalid cancellation input stays unknown without replacing the legacy effect", async (t) => {
  const f = fixture(t);
  const observer = createSelectedRegistryObserver({ ...f.options, input: { signal: {} as AbortSignal } })!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "invalid_cancellation");
});

test("selected consumer records the actual legacy exception but rethrows its original identity", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  const failure = new Error("legacy-private-exception-sentinel");
  await assert.rejects(observer.observe("serve-readiness", { repository: "owner/repo" }, () => { throw failure; }), error => error === failure);
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.legacy_outcome, "threw");
  assert.ok(!JSON.stringify(f.rows).includes(failure.message));
});

test("selected consumer synchronous seams never claim fresh selected authority", (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver({ ...f.options,
    io: { lstat: () => assert.fail("sync seam performs no selected IO"), open: () => assert.fail("sync seam performs no selected IO") } })!;
  t.after(() => observer.close());
  assert.equal(observer.observeSync("inbox-discovery", { repository: "owner/repo" }, () => "legacy"), "legacy");
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "synchronous_seam");
});

test("selected consumer retries unknown only at a later real consumer event", async (t) => {
  const f = fixture(t, false);
  let reads = 0;
  const observer = createSelectedRegistryObserver({ ...f.options, io: { ...registryFileIO,
    lstat: async (path) => { reads++; return registryFileIO.lstat(path); } } })!;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.reason, "missing");
  const first = reads;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, first, "no retry scanner or timer");
  writeFileSync(f.path, selectedText());
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy");
  await observer.settled();
  assert.ok(reads > first);
  assert.equal(f.rows.at(-1)?.fields.selected_state, "ready");
});

test("selected consumer failure of both sink and diagnostic channel cannot replace the effect", async (t) => {
  const f = fixture(t);
  let diagnosticCalls = 0;
  const errors = mock.method(console, "error", () => { diagnosticCalls++; throw new Error("private-diagnostic-sentinel"); });
  t.after(() => errors.mock.restore());
  const observer = createSelectedRegistryObserver({ ...f.options, record: () => { throw new Error("private-sink-sentinel"); } })!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(diagnosticCalls, 1);
  assert.equal(f.rows.length, 0, "failed channels produced no durable success receipt");
});

test("selected consumer synchronous exception retains identity and an unknown observation", (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  const failure = new Error("private-sync-sentinel");
  assert.throws(() => observer.observeSync("inbox-discovery", { repository: "owner/repo" }, () => { throw failure; }), error => error === failure);
  assert.equal(f.rows.at(-1)?.fields.legacy_outcome, "threw");
  assert.equal(f.rows.at(-1)?.fields.reason, "synchronous_seam");
  assert.ok(!JSON.stringify(f.rows).includes("private-sync-sentinel"));
});

test("selected consumer pending evidence is bounded without throttling healthy legacy effects", async (t) => {
  const f = fixture(t), waiting = pendingValue<never>();
  const observer = createSelectedRegistryObserver({ ...f.options, io: { ...registryFileIO, lstat: () => waiting.promise } })!;
  t.after(() => observer.close());
  let calls = 0;
  const values = await Promise.all(Array.from({ length: 33 }, () => observer.observe("serve-readiness", { repository: "owner/repo" }, () => ++calls)));
  assert.equal(calls, 33);
  assert.deepEqual(values, Array.from({ length: 33 }, (_, i) => i + 1));
  assert.equal(f.rows.at(-1)?.fields.reason, "observation_capacity");
  observer.close();
  await observer.settled();
  assert.equal(f.rows.length, 1);
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "after-close-legacy"), "after-close-legacy");
  assert.equal(f.rows.length, 1, "shutdown produces no new receipt or permission");
});

test("selected consumer receipt deduplication is bounded and never deduplicates actual effects", async (t) => {
  const f = fixture(t), members = Array.from({ length: 34 }, (_, i) => ({ instanceName: `member${i}`, repository: `owner/repo${i}` }));
  writeFileSync(f.path, "instances:\n" + members.map(member => `  ${member.instanceName}:\n    github_repo: ${member.repository}\n    mode: shadow\n`).join(""));
  const observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  let calls = 0;
  for (const target of members) {
    await observer.observe("serve-topology", target, () => ++calls);
    await observer.settled();
  }
  assert.equal(f.rows.length, members.length);
  assert.ok(f.rows.every(row => row.fields.selected_state === "ready"), "actual selected members are the healthy population control");
  await observer.observe("serve-topology", members[0]!, () => ++calls);
  await observer.settled();
  assert.equal(f.rows.length, members.length + 1, "oldest key was evicted, not retained forever");
  await observer.observe("serve-topology", members[0]!, () => ++calls);
  await observer.settled();
  assert.equal(calls, members.length + 2);
  assert.equal(f.rows.length, members.length + 1, "duplicate evidence did not suppress the legacy operation");
});

test("selected consumer preserves the reader's real capability bounds without adding a false refusal", async (t) => {
  const f = fixture(t);
  for (const requiredCapabilities of [Array<string>(16).fill("identity"), Array<string>(16).fill("mode"), Array<string>(17).fill("identity")]) {
    const observer = createSelectedRegistryObserver({ ...f.options, input: { requiredCapabilities } })!;
    t.after(() => observer.close());
    assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
    await observer.settled();
    assert.equal(f.rows.at(-1)?.fields.selected_state, requiredCapabilities.length <= 16 ? "ready" : "unknown");
    if (requiredCapabilities.length > 16) assert.equal(f.rows.at(-1)?.fields.reason, "unsupported_capability");
  }
});

test("selected consumer requires identity support without normalizing unsupported reader capabilities", async (t) => {
  const f = fixture(t), selected = await readSelectedInstanceRegistry({ configuredPath: f.path });
  assert.equal(selected.kind, "ready");
  if (selected.kind !== "ready") return;
  const reader: typeof readSelectedInstanceRegistry = async () => ({ kind: "ready", binding: { ...selected.binding, capabilities: ["mode"] } });
  const observer = createSelectedRegistryObserver(f.options, reader)!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "identity_capability_missing");
});

test("selected intent's unreadable supported transport cannot become a trusted fallback or public exception", async (t) => {
  const f = fixture(t); let reads = 0;
  const unreadable = { version: 1, get kind(): "shadow" { reads++; throw new Error("private-intent-sentinel"); } };
  const copied = registryConsumers.copySelectedRegistryIntent(unreadable);
  assert.deepEqual(copied, { kind: "unknown", version: 1 }); assert.equal(Object.isFrozen(copied), true);
  const observer = registryConsumers.selectedRegistryObserverFromIntent(unreadable, f.options.record)!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "actual-legacy-result"), "actual-legacy-result");
  await observer.settled();
  assert.equal(reads, 2, "the supported-version kind getter really threw; version refusal must not short-circuit this catch test");
  assert.equal(f.rows.at(-1)?.fields.reason, "transport_unavailable");
  assert.equal(f.rows.at(-1)?.fields.publication_permission, "not-granted");
  assert.ok(!JSON.stringify(f.rows).includes("private-intent-sentinel"));
});

});
