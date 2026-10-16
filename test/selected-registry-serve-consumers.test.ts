import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, mock } from "node:test";
import { buildOnboardingGoLiveRoutes, buildOnboardingReadinessRoute, buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { buildInstanceGatewayRoutes, watchInstanceLiveness, type InstanceGatewayOptions } from "../src/lib/instance-gateway.js";
import { fixedClock } from "../src/lib/clock.js";
import type { Route } from "../src/lib/service.js";
import type { OnboardingReadinessGateway } from "../src/lib/onboarding-readiness.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createSelectedRegistryObserver } from "../src/lib/selected-registry-consumers.js";
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "legacy.yaml"), path = join(root, "selected.yaml");
  writeFileSync(legacy, selectedText("legacy"));
  if (selected) writeFileSync(path, selectedText());
  const rows: Row[] = [];
  const options = {
    settings: { mode: "shadow" as const, instanceName: "fixture", registryPath: path },
    record: (step: string, fields: Record<string, unknown>) => { rows.push({ step, fields }); },
  };
  const input = { repoRegistryPath: legacy, gateway, selectedRegistryObservation: options };
  return { root, legacy, path, rows, options, input, route: buildOnboardingReadinessRoute(input) };
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
  for (const path of ["/v1/registry", "/v1/onboarding/readiness", "/v1/repos/summary"]) {
    const route = routes.find(route => route.path === path); assert.ok(route, path);
    let raw = "", code = 0;
    await route.handler({ url: path + "?repo=owner/repo" } as never,
      { writeHead: (n: number) => { code = n; }, end: (text: string) => { raw += text; } } as never, { params: {} });
    assert.equal(code, 200, raw);
    assert.ok(!raw.includes("selected-material-sentinel"));
  }
  for (let n = 0; n < 100 && f.rows.filter(row => row.step === STEP).length < 3; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.rows.filter(row => row.step === STEP).map(row => row.fields.action).sort(), ["repo-dashboard", "serve-readiness", "serve-registry"]);
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
  const stop = watchInstanceLiveness(options); t.after(stop);
  assert.equal(timers, 1); tick(); await observer.settled();
  assert.equal(reads, 1, "no second legacy scan is introduced by the observation");
  const row = f.rows.find(row => row.fields.action === "serve-liveness"); assert.ok(row);
  assert.equal(row.fields.target_instance, "site"); assert.equal(row.fields.target_repo, "owner/site"); assert.equal(row.fields.selected_state, "ready");
  stop(); assert.equal(stopped, 1);
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

test("selected consumer unreadable target never substitutes identity or private exception text", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { get repository(): string { throw new Error("private-target-sentinel"); } }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.reason, "target_unreadable");
  assert.equal(f.rows.at(-1)?.fields.target_repo, undefined);
  assert.ok(!JSON.stringify(f.rows).includes("private-target-sentinel"));
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
