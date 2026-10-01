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
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { buildRegistryRoute } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { diffViewData } from "../src/lib/view-shadow.js";
import type { ViewBodyEntry } from "../src/lib/views.js";

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
  instances: Array<{ name: string; ledgerDir: string }>;
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
    { name: "core", ledgerDir: stateDir },
    { name: "console", ledgerDir: consoleDir },
    { name: "site", ledgerDir: join(root, "instances", "site", "state") },
  ];
  return { root, stateDir, repoPath, hostPath, instances };
}

/** One worker pass over the fixture's real stores; returns the instances body it posted. */
function materialize(f: Fixture, at: number = NOW): ViewBodyEntry {
  const view = createInstancesView<ReadModelInstanceState>({ instances: f.instances, repoPath: f.repoPath, hostPath: f.hostPath, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
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
