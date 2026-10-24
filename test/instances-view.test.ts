// W1-T5056 (arch Phase 4 design §4, P4-T17): the `instances` view says what serve actually serves. It joins
// the repo registry, the host registry and the read-model worker's mounts, and GET /v1/registry answers as a
// projection of its body. Every registry and state dir here is a temp-file fixture; the stores are real.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import {
  INSTANCE_LIVENESS_BOUND_MS,
  INSTANCES_VIEW_NAME,
  createInstancesView,
  instanceLiveness,
  legacyRegistryBody,
  registryFromInstances,
  type InstancesData,
} from "../src/lib/instances-view.js";
import type { ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, readModelSwitchesPath, type ReadModelInstanceState, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { buildRegistryRoute } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { diffViewData } from "../src/lib/view-shadow.js";
import type { ViewBodyEntry } from "../src/lib/views.js";
import { observeInstanceInboxContract, mountInstanceInboxRoutes } from "#src/lib/instance-inbox-contract.js";
import { judgeSource, SLOW_LANE_STORE_BUDGET_MS } from "#src/lib/view-freshness.js";
import { RAW_BODY_CACHE } from "#src/lib/service.js";
import { symlinkSync, truncateSync } from "node:fs";
import { INBOX_CONTRACT_OBSERVATION_MAX_BYTES } from "#src/lib/instance-inbox-contract.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import { createReadModelWorker, readModelLaneViews } from "#src/lib/read-model-worker.js";
import { INSTANCES_QUALIFICATION_GENERATION } from "#src/lib/instances-view.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function clockAt(ms: number): Clock {
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
}

const row = (name: string, repo: string, extra = ""): string => `  ${name}:\n    github_repo: ${repo}\n    project: remudero\n${extra}`;
const REPO_REGISTRY = `instances:\n${row("core", "craigoley/remudero")}${row("console", "craigoley/remudero-console", "    mode: shadow\n")}${row("site", "craigoley/remudero-site")}`;
/** The host copy names a fourth instance and lacks `site`: drift both ways. */
const HOST_REGISTRY = `instances:\n${row("core", "craigoley/remudero")}${row("console", "craigoley/remudero-console")}${row("ghost", "craigoley/ghost")}`;

interface Fixture {
  root: string;
  stateDir: string;
  repoPath: string;
  hostPath: string;
  instances: Array<{ name: string; ledgerDir: string; repo: string }>;
}

/** Core and console are mounted with ledgers; site is registered and projected but its state dir was never mounted. */
function fixture(t: TestCtx, opts: { heartbeatAgoMs?: number } = {}): Fixture {
  const root = makeTempDir("instances-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const consoleDir = join(root, "instances", "console", "state");
  for (const dir of [join(stateDir, "read-model"), consoleDir]) mkdirSync(dir, { recursive: true });
  const beat = new Date(NOW - (opts.heartbeatAgoMs ?? 60_000)).toISOString();
  writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: beat, step: "daemon.tick", host: "h1" })}\n`);
  writeFileSync(join(consoleDir, "ledger.ndjson"), `${JSON.stringify({ ts: beat, step: "daemon.tick", host: "h2" })}\n`);
  const repoPath = join(root, "daemon-instances.yaml");
  const hostPath = join(root, "host-instances.yaml");
  writeFileSync(repoPath, REPO_REGISTRY);
  writeFileSync(hostPath, HOST_REGISTRY);
  const instances = [
    { name: "core", ledgerDir: stateDir, repo: "craigoley/remudero" },
    { name: "console", ledgerDir: consoleDir, repo: "craigoley/remudero-console" },
    { name: "site", ledgerDir: join(root, "instances", "site", "state"), repo: "craigoley/remudero-site" },
  ];
  return { root, stateDir, repoPath, hostPath, instances };
}

/** One worker pass over the fixture's real stores; returns the instances body it posted. */
function materialize(f: Fixture, at: number = NOW): ViewBodyEntry {
  const view = createInstancesView<ReadModelInstanceState>({ instances: f.instances, repoPath: f.repoPath, hostPath: f.hostPath, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  // W1-T5896: a view with no switch is not built; its route serves it only under serve.
  mkdirSync(join(f.stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(f.stateDir), JSON.stringify({ views: { [INSTANCES_VIEW_NAME]: "serve" } }));
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock: clockAt(at), holder: "instances-test", oracle: "off", post: (m) => posted.push(m) });
  ticker.start();
  ticker.tick();
  ticker.release();
  const bodies = posted.flatMap((m) => (m.type === "body" && m.entry.view === INSTANCES_VIEW_NAME ? [m.entry] : []));
  assert.equal(bodies.length, 1, "one instances body per pass");
  return bodies[0];
}

async function invoke(route: Route): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let text = "";
  const res = { writeHead(code: number) { status = code; return res; }, setHeader() {}, end(chunk?: string) { text = chunk ?? ""; } };
  await route.handler({} as never, res as never, { params: {} });
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

test("W1-T5056: a registered instance that serve does not mount is listed as unmounted drift", (t) => {
  const f = fixture(t);
  const data = materialize(f).body.data as InstancesData;
  const byId = Object.fromEntries(data.instances.map((i) => [i.id, i]));
  // CORPUS CONTROL: every list's names are present, so an absent `site` could not pass by never being read.
  assert.deepEqual(data.instances.map((i) => i.id), ["core", "console", "site", "ghost"]);
  assert.equal(byId.site.registered, true);
  assert.equal(byId.site.served, false, "site's state dir is not mounted, so serve does not serve it");
  assert.deepEqual(byId.site.capabilities, { views: [], writes: [] });
  assert.deepEqual(data.drift, { hostOnly: ["ghost"], repoOnly: ["site"], unmounted: ["site"], unregistered: [] });
  // The mounted ones are served, with what serve answers for them.
  assert.equal(byId.console.served, true);
  assert.equal(byId.console.mode, "shadow");
  assert.equal(byId.console.prefix, "/v1/i/console");
  assert.deepEqual(byId.console.capabilities.writes, ["control/pause", "control/resume", "control/stop", "manual/approve", "escalation/mark-handled"]);
  assert.equal(byId.console.capabilities.coreOnly, undefined);
  assert.ok(byId.core.capabilities.coreOnly?.includes("inbox"));
  assert.equal(byId.core.readModel.lease, "held");
  assert.deepEqual(byId.core.liveness, { state: "up" });
  assert.equal(byId.ghost.registered, false);
  assert.equal(data.hostRegistry, "drifted");
});

test("W1-T5056: the registry route is a projection of the instances view", async (t) => {
  const f = fixture(t);
  const entry = materialize(f);
  const routeOver = (mode: "serve" | "off"): Route => buildRegistryRoute({
    repoRegistryPath: f.repoPath, hostRegistryPath: f.hostPath, clock: clockAt(NOW),
    readModel: { body: (view) => (view === INSTANCES_VIEW_NAME ? entry : undefined), switches: () => ({ projector: "on", views: { [INSTANCES_VIEW_NAME]: mode } }) },
  });
  const legacy = await invoke(routeOver("off"));
  // Delete the registry files: a served view answers from its body alone.
  rmSync(f.repoPath);
  rmSync(f.hostPath);
  const projected = await invoke(routeOver("serve"));
  assert.equal(legacy.status, 200);
  assert.deepEqual(projected, legacy);
  assert.deepEqual(legacy.body.drift, { hostOnly: ["ghost"], repoOnly: ["site"] }, "the fixture really drifts");
  // CONTROL: with the switch off and the files gone, the legacy computation answers, and says so.
  assert.deepEqual(await invoke(routeOver("off")), { status: 503, body: { error: "registry_unavailable", reason: "unreadable" } });
});

test("W1-T5056: an unchanged fleet keeps the instances etag across passes and a silent daemon flips it once", (t) => {
  const f = fixture(t);
  const first = materialize(f, NOW);
  const later = materialize(f, NOW + 5 * 60_000);
  assert.equal(later.etag, first.etag, "five minutes of clock move no field in data");
  const silent = materialize(f, NOW + INSTANCE_LIVENESS_BOUND_MS + 60_000);
  assert.notEqual(silent.etag, first.etag);
  const core = (silent.body.data as InstancesData).instances.find((i) => i.id === "core")!;
  assert.deepEqual(core.liveness, { state: "down", since: new Date(NOW - 60_000).toISOString() });
  assert.equal(materialize(f, NOW + INSTANCE_LIVENESS_BOUND_MS + 30 * 60_000).etag, silent.etag, "down stays down without a new field");
});

test("W1-T5056: the instances shadow side agrees with its own body and catches a registry it missed", (t) => {
  const f = fixture(t);
  const view = createInstancesView<ReadModelInstanceState>({ instances: f.instances, repoPath: f.repoPath, hostPath: f.hostPath, ledgerSource });
  const data = materialize(f).body.data as InstancesData;
  assert.deepEqual(diffViewData(view.legacy("", NOW, data)!.data, data), []);
  writeFileSync(f.repoPath, `${REPO_REGISTRY}${row("trails", "someone/wild-trails")}`);
  const diffs = diffViewData(view.legacy("", NOW, data)!.data, data).map((d) => d.path);
  assert.ok(diffs.some((p) => p.includes("id=trails")), diffs.join(" "));
  rmSync(f.repoPath);
  const missing = view.legacy("", NOW, data)!.data as InstancesData;
  assert.equal(missing.registryError, "unreadable");
  assert.deepEqual(missing.instances.filter((i) => i.registered), [], "no registry: legacy lists none of the registered instances");
});

test("W1-T5056: an unreadable or malformed registry is named and the route answers its refusal", (t) => {
  const f = fixture(t);
  writeFileSync(f.repoPath, "instances:\n  core:\n    github_repo: not-a-repo\n");
  writeFileSync(f.hostPath, "not a registry at all");
  const entry = materialize(f);
  const data = entry.body.data as InstancesData;
  assert.equal(data.registryError, "invalid_repo");
  assert.equal(data.hostRegistry, "malformed", "a host copy outside the grammar is a note, not a failure");
  assert.equal(entry.body.sources[0].state, "unavailable");
  assert.match(entry.body.sources[0].reason ?? "", /malformed: invalid_repo/);
  assert.deepEqual(registryFromInstances(data), { status: 503, body: { error: "registry_unavailable", reason: "invalid_repo" } });
  assert.deepEqual(data.instances.map((i) => [i.id, i.registered, i.served]), [["core", false, true], ["console", false, true], ["site", false, false]]);
  assert.deepEqual(data.drift?.unregistered, ["core", "console"]);
  const malformed = legacyRegistryBody({ ok: true, text: REPO_REGISTRY }, "instances:\n  bad name:\n");
  assert.ok(malformed.status === 200 && malformed.body.hostRegistry === "malformed", JSON.stringify(malformed));
  rmSync(f.repoPath);
  const gone = materialize(f).body;
  assert.match(gone.sources[0].reason ?? "", /unreadable: unreadable/);
});

test("W1-T5056: a store without a projected daemon row reads liveness unknown, never down", () => {
  assert.deepEqual(instanceLiveness(undefined, NOW), { state: "unknown" });
  const throwing = { prepare: () => { throw new Error("no such table: instance_heartbeat"); } } as unknown as ReadModelDb;
  assert.deepEqual(instanceLiveness(throwing, NOW), { state: "unknown" });
  const empty = { prepare: () => ({ get: () => undefined }) } as unknown as ReadModelDb;
  assert.deepEqual(instanceLiveness(empty, NOW), { state: "unknown" });
});

test("W1-T10430: capability evidence is current while independent ledger health is stale", (t) => {
  const f = fixture(t, { heartbeatAgoMs: INSTANCE_LIVENESS_BOUND_MS + 60_000 });
  writeFileSync(join(f.stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [] }));
  writeFileSync(readModelSwitchesPath(f.stateDir), JSON.stringify({ views: { instances: "serve" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const holder = "W10430-real-projector";
  const projector = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [], clock: clockAt(NOW), holder, oracle: "off", post: m => posted.push(m) });
  projector.start(); projector.tick();
  const states = posted.filter(m => m.type === "state").at(-1)!.instances;
  // A real projector has not ticked for 11 seconds, within its unchanged 20-second lease.
  const observedAt = NOW + 11_000;
  const view = createInstancesView<ReadModelInstanceState>({ instances: f.instances, repoPath: f.repoPath, hostPath: f.hostPath, ledgerSource });
  const bodies: ViewBodyEntry[] = [];
  const reader = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], viewsOnly: true, clock: clockAt(observedAt), holder, oracle: "off", post: m => { if (m.type === "body") bodies.push(m.entry); } });
  try { reader.start(); reader.observe(states); reader.tick(); } finally { reader.release(); projector.release(); }
  assert.equal(bodies.length, 1);
  const entry = bodies[0];
  const core = (entry.body.data as InstancesData).instances.find(i => i.id === "core")!;
  const source = entry.body.sources.find(s => s.name === core.inboxCapabilityEvidence?.source)!;
  assert.equal(core.liveness.state, "down", "real stale heartbeat is retained");
  assert.equal(source.state, "fresh", "real current filesystem observation, not a fake capability array");
  assert.equal(core.inboxCapabilityEvidence?.state, "observed");
  assert.equal(core.inboxCapabilityEvidence?.repository, "craigoley/remudero");
  assert.equal(core.inboxCapabilityEvidence?.instance, "core");
  assert.equal(core.inboxCapabilityEvidence?.prefix, "/v1/i/core");
  assert.equal(core.inboxCapabilityEvidence?.generation, states.find(s => s.instance === "core")!.generation, "bind core's generation, not the aggregate across repositories");
  assert.equal(source.asOf, new Date(observedAt).toISOString());
  assert.equal(judgeSource(source, observedAt + SLOW_LANE_STORE_BUDGET_MS + 1).state, "stale", "a frozen positive expires under the existing source budget");
  assert.equal(entry.body.sources.find(s => s.name === "ledger:core")!.state, "stale", "actual native ledger health remains stale independently");
});

test("W1-T10430: missing revoked malformed or foreign capability sources cannot authorize writes", async (t) => {
  const f = fixture(t), marker = join(f.stateDir, "inbox-proposals.json");
  writeFileSync(marker, "[]");
  assert.equal(observeInstanceInboxContract(f.stateDir, { instance: "core", repository: "craigoley/remudero" }).state.mode, "read-write", "legacy empty list is compatible, not a revocation");
  const evidence = () => (materialize(f).body.data as InstancesData).instances.find(i => i.id === "core")!.inboxCapabilityEvidence!;
  assert.equal(evidence().state, "observed", "positive control before each refusal class");
  for (const content of ["{torn", "null", "42", JSON.stringify({ proposals: [], repository: "foreign/repo" }), JSON.stringify({ proposals: [], instance: "other" })]) {
    writeFileSync(marker, content);
    assert.equal(evidence().state, "unavailable", content);
    writeFileSync(marker, "[]");
    assert.equal(evidence().state, "observed", "restored real source recovers");
  }
  rmSync(marker);
  assert.equal(evidence().state, "unavailable", "revoked marker replaces the previous positive");
  mkdirSync(marker);
  assert.equal(observeInstanceInboxContract(f.stateDir, { instance: "core", repository: "craigoley/remudero" }).state.mode, "read-only", "non-regular/unreadable source refuses");
  rmSync(marker, { recursive: true });
  writeFileSync(marker, "[]");
  const all = materialize(f).body.data as InstancesData;
  assert.equal(all.instances.find(i => i.id === "site")!.inboxCapabilityEvidence?.state, "unavailable", "unmounted instance cannot borrow core evidence");
  rmSync(f.repoPath);
  assert.equal(evidence().state, "unavailable", "missing registry never reuses a last-good binding");

  let calls = 0;
  const source: Route = { method: "POST", path: "/v1/inbox/thread/reply", scope: "write", handler: (_req, res) => { calls++; res.end("{}"); } };
  const route = mountInstanceInboxRoutes({ instance: "core", repository: "craigoley/remudero", stateDir: f.stateDir, routes: [source] })[0];
  let status = 0, text = "";
  const res = { writeHead(code: number) { status = code; return res; }, setHeader() {}, end(value?: string) { text = value ?? ""; } };
  const req = { url: route.path, [RAW_BODY_CACHE]: JSON.stringify({ repository: "foreign/repo", instance: "core", threadId: "irrelevant", intentId: "valid-intent", text: "never send" }) };
  await route.handler(req as never, res as never, { params: {} });
  assert.equal(status, 409, "actual scoped handler still refuses a foreign request");
  assert.equal(JSON.parse(text).error, "inbox_scope_mismatch");
  assert.equal(calls, 0, "no side effect or synthetic business reply");
});

test("W1-T10430: capability evidence follows owned generation and revalidation without request-time scans", (t) => {
  const f = fixture(t), marker = join(f.stateDir, "inbox-proposals.json");
  writeFileSync(marker, "[]");
  const state = { instance: "core", lease: "held" as "held" | "elsewhere" | "none", generation: 4 };
  let invalidate = false;
  const view = createInstancesView({ instances: [{ name: "core", ledgerDir: f.stateDir, repo: "craigoley/remudero" }], repoPath: f.repoPath, hostPath: f.hostPath,
    mounted: () => { if (invalidate) state.generation++; return true; }, ledgerSource: () => ({ name: "ledger:core", asOf: null, state: "stale" }) });
  const ctx = { now: NOW, instances: [{ state, lease: {} }] };
  const read = () => view.materialize(ctx)[0].data.instances.find(i => i.id === "core")!.inboxCapabilityEvidence!;
  assert.equal(read().state, "observed");
  assert.equal(read().generation, 4);
  state.lease = "elsewhere";
  assert.equal(read().state, "unavailable", "a lost owner cannot refresh positive evidence");
  state.lease = "held";
  assert.equal(view.materialize({ ...ctx, instances: [{ state }] })[0].data.instances[0].inboxCapabilityEvidence?.state, "unavailable", "a stale held label without its live lease is not ownership");
  invalidate = true;
  assert.equal(read().state, "unavailable", "generation changes during observation refuse");
  invalidate = false;
  const observed = observeInstanceInboxContract(f.stateDir, { instance: "core", repository: "craigoley/remudero" });
  assert.equal(observed.current(), true);
  rmSync(marker);
  assert.equal(observed.current(), false, "file disappearance is caught before publication");
  // Existing registry route consumes only the already-materialized body; no ledger scan or model call.
  assert.equal(registryFromInstances(view.materialize(ctx)[0].data).status, 200);
  for (const change of ["contract", "registry", "lease"] as const) {
    writeFileSync(marker, "[]"); writeFileSync(f.repoPath, REPO_REGISTRY);
    let reads = 0;
    const slot = { state: { instance: "core", lease: "held" as const, generation: 9 }, lease: {} };
    const changing = createInstancesView({ instances: [{ name: "core", ledgerDir: f.stateDir, repo: "craigoley/remudero" }], repoPath: f.repoPath, hostPath: f.hostPath, ledgerSource: () => ({ name: "ledger:core", asOf: null, state: "stale" }), mounted: () => {
      if (++reads === 2) {
        if (change === "contract") rmSync(marker);
        if (change === "registry") writeFileSync(f.repoPath, REPO_REGISTRY.replace("craigoley/remudero\n", "foreign/repository\n"));
        if (change === "lease") slot.lease = {};
      }
      return true;
    } });
    assert.equal(changing.materialize({ now: NOW, instances: [slot] })[0].data.instances[0].inboxCapabilityEvidence?.state, "unavailable", `${change} changing during mount revalidation refuses`);
    assert.equal(reads, 2, "the mutation happened after the real first observation");
  }
});

test("W1-T10430: legacy instances remain conservative and new capability clocks do not churn data", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.stateDir, "inbox-proposals.json"), "[]");
  const first = materialize(f), later = materialize(f, NOW + 60_000);
  assert.equal(first.body.version, 1, "additive contract retains version-one consumers");
  assert.deepEqual(first.body.data, later.body.data, "observation clock is outside content identity");
  assert.equal(first.etag, later.etag);
  const a = first.body.sources.find(s => s.name === "inbox-capability:core")!, b = later.body.sources.find(s => s.name === a.name)!;
  assert.equal(a.state, "fresh"); assert.equal(b.state, "fresh"); assert.notEqual(a.asOf, b.asOf, "each clock follows a real observation");
  assert.equal((first.body.data as InstancesData).instances.find(i => i.id === "console")!.capabilities.inbox?.mode, "read-only", "missing old-daemon contract remains read-only");
  const legacy = structuredClone(first.body.data) as InstancesData;
  for (const entry of legacy.instances) delete entry.inboxCapabilityEvidence;
  assert.deepEqual(registryFromInstances(legacy), registryFromInstances(first.body.data as InstancesData), "old registry projection does not invent capability evidence");
  const factory = readModelLaneViews({ instances: f.instances, registry: { repoPath: f.repoPath, hostPath: f.hostPath } }, clockAt(NOW), () => {}, createDemandBook({ clock: clockAt(NOW) })).find(v => v.name === "instances")!;
  assert.equal(factory.qualificationGeneration, INSTANCES_QUALIFICATION_GENERATION);
  assert.ok("create" in factory);
  assert.equal(factory.create().qualificationGeneration, factory.qualificationGeneration);
  const worker = createReadModelWorker({ stateDir: f.stateDir, instances: f.instances, clock: clockAt(NOW) });
  assert.equal(worker.qualificationGeneration?.("instances"), INSTANCES_QUALIFICATION_GENERATION, "persisted auto readiness cannot borrow an older generation");
  assert.equal(worker.qualificationGeneration?.("unknown-view"), undefined);
});

test("W1-T10430: revoked contract controls stay closed without positive qualification wiring", (t) => {
  const f = fixture(t), marker = join(f.stateDir, "inbox-proposals.json");
  const state = { instance: "core", lease: "held" as "held" | "elsewhere", generation: 2 };
  const view = createInstancesView({ instances: f.instances, repoPath: f.repoPath, hostPath: f.hostPath, ledgerSource });
  const read = () => view.materialize({ now: NOW, instances: [{ state: { ...state, failures: 0, newestTs: null }, lease: {} }] })[0];
  for (const raw of ["{malformed", "null", "42", JSON.stringify({ repository: "foreign/repo" }), JSON.stringify({ instance: "foreign" })]) {
    writeFileSync(marker, raw);
    const entry = read();
    assert.equal(entry.data.instances.find(i => i.id === "core")!.inboxCapabilityEvidence?.state, "unavailable");
    assert.equal(entry.sources.find(s => s.name === "inbox-capability:core")!.state, "unavailable");
  }
  rmSync(marker);
  assert.equal(read().data.instances[0].inboxCapabilityEvidence?.state, "unavailable");
  assert.deepEqual(read().data.instances[0].capabilities.writes.filter(w => w.startsWith("inbox/")), [], "the real revoked marker also removes legacy Inbox write advertisements");
  writeFileSync(marker, "[]"); truncateSync(marker, INBOX_CONTRACT_OBSERVATION_MAX_BYTES + 1);
  assert.equal(read().data.instances[0].inboxCapabilityEvidence?.state, "unavailable", "oversized regular sources are not read or truncated into positives");
  rmSync(marker); symlinkSync(f.repoPath, marker);
  assert.equal(read().data.instances[0].inboxCapabilityEvidence?.state, "unavailable", "a link cannot substitute another readable source");
  rmSync(marker); writeFileSync(marker, "[]");
  state.lease = "elsewhere";
  assert.equal(read().data.instances[0].inboxCapabilityEvidence?.state, "unavailable");
  state.lease = "held";
  writeFileSync(f.repoPath, REPO_REGISTRY.replace("craigoley/remudero\n", "foreign/repository\n"));
  assert.equal(read().data.instances[0].inboxCapabilityEvidence?.state, "unavailable", "mutable registry cannot rebind the fixed mount's repository");
  rmSync(f.repoPath);
  assert.equal(read().data.instances[0].inboxCapabilityEvidence?.state, "unavailable");
});
