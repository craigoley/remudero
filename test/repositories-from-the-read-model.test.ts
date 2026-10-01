import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { fixedClock, systemClock } from "../src/lib/clock.js";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { pauseFilePath } from "../src/lib/fleet-control.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { acquireLease, READ_MODEL_DB_DIR_ENV } from "../src/lib/read-model-db.js";
import {
  createReadModelTicker,
  ledgerSource,
  readModelSwitchesPath,
  type ReadModelBodyEntry,
  type ReadModelInstanceState,
} from "../src/lib/read-model-worker.js";
import { buildRepoDashboardRoutes, type RepoDashboardResult } from "../src/lib/repo-dashboard-route.js";
import {
  createRepositoriesReadModelView,
  createRepositoriesSourcePublisher,
  groupRepositoryProjects,
  readRepoRows,
  repositoriesShadowPairing,
  startRepositoriesSourcePublisher,
  type RepositoriesData,
  type RepositoriesSources,
  type RepositoriesSummary,
  unstampedSummary,
} from "../src/lib/repositories-view.js";
import { buildServeServer, repositoriesSources, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { VIEW_SHADOW_DIFF_STEP, createViewShadow, readShadowEvidence, type ShadowRequest } from "../src/lib/view-shadow.js";
import type { ViewBody } from "../src/lib/views.js";

// P1-08: the repositories view is #7926's repos summary for every instance, computed from each instance's
// read-model `repo_row` table, counted once however many rotations carry a row, and dark until switched.

const NOW = systemClock.now();
const CORE = { owner: "craigoley", repo: "remudero" };
const CONSOLE = { owner: "craigoley", repo: "remudero-console" };
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function planYaml(repo: string, ids: string[]): string {
  return ids.map((id, i) => `- id: ${id}
  title: t
  repo: ${repo}
  depends_on: []
  type: implement
  verify: auto
  files: [src/x.ts]
  status: ${i === 0 ? "queued" : "blocked"}
  acceptance:
    - claim: c
      proof: "grep: x in y"
`).join("");
}

/** A repository's week: a merge, a CI failure, a failure a later merge superseded, api and subscription
 *  calls, an assignment with a usage window, a heartbeat, and noise the projection must not keep. */
function week(repo: string, tag: string): string[] {
  const rows: Array<Record<string, unknown>> = [
    { ts: iso(6 * 3_600_000), step: "run.start", run_id: `${tag}1`, task_id: `${tag}-T1`, repo },
    { ts: iso(5 * 3_600_000), step: "verdict", run_id: `${tag}1`, task_id: `${tag}-T1`, verdict: "merged" },
    { ts: iso(4 * 3_600_000), step: "run.start", run_id: `${tag}2`, task_id: `${tag}-T2`, repo },
    { ts: iso(3 * 3_600_000), step: "verdict", run_id: `${tag}2`, task_id: `${tag}-T2`, verdict: "blocked_ci" },
    { ts: iso(3 * 3_500_000), step: "verdict", run_id: `${tag}3`, task_id: `${tag}-T3`, verdict: "no_pr", repo },
    { ts: iso(3 * 3_400_000), step: "verdict.merged", run_id: `${tag}4`, task_id: `${tag}-T3`, repo },
    { ts: iso(2 * 3_600_000), step: "implement.done", run_id: `${tag}1`, billing_mode: "api", total_cost_usd: 1.25, served_model: "claude-sonnet-5-5", tokens: { input: 100, output: 50, cacheRead: 7 } },
    { ts: iso(2 * 3_500_000), step: "implement.done", run_id: `${tag}2`, billing_mode: "subscription", total_cost_usd: 0.5, tokens: { input: 10, output: 5 } },
    { ts: iso(3_600_000), step: "worker.assignment", run_id: `${tag}2`, repo, worker_assignment: { selected: { model: "claude-opus-5-5" }, candidates: [{ provider: "claude", windows: [{ name: "5h", usedPercent: 42, resetsAt: "2026-10-01T00:00:00.000Z" }] }] } },
    { ts: iso(60_000), step: "daemon.tick" },
    { ts: iso(30_000), step: "worker.activity", run_id: `${tag}2` },
  ];
  return rows.map((row) => JSON.stringify(row));
}

function archiveName(msAgo: number): string {
  return `ledger.${iso(msAgo).replace(/[:.]/g, "-")}.ndjson.gz`;
}

/** The same rows in two gzip rotations and again in the live file, as compaction and the carried core leave them. */
function writeTripled(dir: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true });
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, archiveName(20_000)), gzipSync(text));
  writeFileSync(join(dir, archiveName(10_000)), gzipSync(text));
  writeFileSync(join(dir, "ledger.ndjson"), text);
}

interface Fixture {
  root: string;
  stateDir: string;
  consoleRoot: string;
  sources: RepositoriesSources["instances"];
}

function fixture(t: TestCtx): Fixture {
  const root = scratch(t, "repositories-rm");
  const stateDir = join(root, "state");
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(daemonInstanceRegistryPath(root), [
    "instances:",
    "  core:",
    "    repo: remudero",
    "    github_repo: craigoley/remudero",
    "    project: remudero",
    "  console:",
    "    repo: remudero-console",
    "    github_repo: craigoley/remudero-console",
    "    project: remudero",
    "",
  ].join("\n"));
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/remudero-site"] }));
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), planYaml("craigoley/remudero", ["W1-T1", "W1-T2", "c-T1"]));
  writeTripled(stateDir, week("craigoley/remudero", "c"));

  const consoleRoot = join(root, "instances", "console");
  const consolePlan = join(consoleRoot, "repos", "remudero-console", "plan", "tasks.yaml");
  mkdirSync(join(consolePlan, ".."), { recursive: true });
  writeFileSync(consolePlan, planYaml("craigoley/remudero-console", ["CONSOLE-T1"]));
  writeTripled(join(consoleRoot, "state"), week("craigoley/remudero-console", "k"));
  writeFileSync(pauseFilePath(consoleRoot), "");

  const sources: RepositoriesSources["instances"] = [
    { instanceId: "core", options: { root, repoRegistryPath: daemonInstanceRegistryPath(root), ownInstance: "core", controlRoot: root, incidentsDir: stateDir, ledgerPath: join(stateDir, "ledger.ndjson"), planPath: join(root, "plan", "tasks.yaml") } },
    { instanceId: "console", options: { root: consoleRoot, ledgerPath: join(consoleRoot, "state", "ledger.ndjson"), planPath: consolePlan, instanceRepository: CONSOLE, controlRoot: consoleRoot, incidentsDir: join(consoleRoot, "state") } },
  ];
  return { root, stateDir, consoleRoot, sources };
}

function ticker(f: Fixture, opts: { now?: number; holder?: string; view?: ReturnType<typeof createRepositoriesReadModelView<ReadModelInstanceState>> } = {}): { tick: () => ReadModelBodyEntry | undefined; release: () => void; shadow: (request: ShadowRequest) => boolean; logs: Array<{ step: string; extra: Record<string, unknown> }>; at: (ms: number) => void } {
  let last: ReadModelBodyEntry | undefined;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let now = opts.now ?? NOW;
  const view = opts.view ?? createRepositoriesReadModelView(ledgerSource);
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const inner = createReadModelTicker({
    stateDir: f.stateDir,
    instances: [{ name: "core", ledgerDir: f.stateDir }, { name: "console", ledgerDir: join(f.consoleRoot, "state") }],
    views: [view], clock, holder: opts.holder ?? "serve-a",
    post: (m) => void (m.type === "body" ? (last = m.entry) : m.type === "log" && logs.push({ step: m.step, extra: m.extra })),
  });
  return {
    tick: () => {
      last = undefined;
      inner.tick();
      now += 0;
      return last;
    },
    release: () => void inner.release(),
    shadow: (request) => inner.shadow(request),
    logs,
    at: (ms) => void (now = ms),
  };
}

function repositories(entry: ReadModelBodyEntry | undefined): RepositoriesData {
  assert.ok(entry, "the worker posted a repositories body");
  return entry.body.data as RepositoriesData;
}

/** The legacy route's JSON through its default path (the off-thread repo ledger index over the rotations), less the
 *  `generated_at` stamp that view version 2 moves to the instance's source. */
async function legacySummary(options: RepositoriesSources["instances"][number]["options"]): Promise<RepositoriesSummary> {
  const summary = buildRepoDashboardRoutes({ ...options, clock: fixedClock(NOW) }).find((route) => route.path === "/v1/repos/summary")!;
  let sent = "";
  await summary.handler({ url: "/v1/repos/summary", headers: {} } as never, { writeHead: () => undefined, end: (text: string) => void (sent = text) } as never, {} as never);
  return unstampedSummary(JSON.parse(sent) as RepoDashboardResult);
}

test("repositories from the read model equal the repos summary of each instance", async (t) => {
  const f = fixture(t);
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  const data = repositories(run.tick());
  run.release();

  assert.deepEqual(data.instances.map((i) => i.instanceId), ["core", "console"]);
  for (const { instanceId, options } of f.sources) {
    const legacy = await legacySummary(options);
    assert.equal(legacy.repos.length, 1, `${instanceId}'s route measures its own repository`);
    assert.deepEqual(data.instances.find((i) => i.instanceId === instanceId)?.summary, legacy, `${instanceId}'s summary`);
  }
  const paused = data.instances[1].summary!.repos[0];
  assert.equal(paused.active, false, "the console instance is paused");
  assert.equal(paused.health.condition, "paused");
  assert.equal(paused.telemetry.modelsused?.includes("claude-opus-5-5"), true);
});

test("with its DB on the scratch disk the read-model repositories view still reads the sources serve published to the state disk", (t) => {
  const f = fixture(t);
  const saved = process.env[READ_MODEL_DB_DIR_ENV];
  process.env[READ_MODEL_DB_DIR_ENV] = `${f.stateDir}:${join(scratch(t, "repos-nvme"), "read-model")}`;
  t.after(() => {
    if (saved === undefined) delete process.env[READ_MODEL_DB_DIR_ENV];
    else process.env[READ_MODEL_DB_DIR_ENV] = saved;
  });
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  const data = repositories(run.tick());
  run.release();
  assert.deepEqual(data.instances.map((i) => i.instanceId), ["core", "console"]);
});

test("a repositories count diff is judged by the rows each id it counted", (t) => {
  const f = fixture(t);
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  repositories(run.tick());
  t.after(() => run.release());
  const live = join(f.stateDir, "ledger.ndjson");
  const failedRow = readFileSync(live, "utf8").split("\n").find((line) => line.includes('"blocked_ci"'))!;
  const base = "instances[instanceId=core].summary.repos[id=craigoley/remudero].health";
  const sample = (): Array<{ path: string; classification: string; reason: string }> => {
    assert.equal(run.shadow({ view: "repositories", key: "", requests: 1 }), true, "the worker computed the legacy side and compared");
    const row = run.logs.filter((l) => l.step === VIEW_SHADOW_DIFF_STEP).at(-1);
    assert.ok(row, "a view.shadow_diff row was written");
    return row.extra.diffs as Array<{ path: string; classification: string; reason: string }>;
  };
  // Legacy's live file re-emits c-T2's failure under a retried run id; the view counted that failure once.
  writeFileSync(live, `${readFileSync(live, "utf8")}${failedRow.replace('"run_id":"c2"', '"run_id":"c2b"')}\n`);
  const dup = sample();
  assert.deepEqual(dup.map((d) => [d.path, d.classification]), [[`${base}.errorrate`, "dedupe"], [`${base}.runs7d.failed`, "dedupe"]], JSON.stringify(dup));
  // A failure no read-model row names: its count is real, though c-T2's duplicate is still explained.
  const unnamed = JSON.stringify({ ts: iso(3_600_000), step: "verdict", run_id: "c9", task_id: "c-T9", verdict: "no_pr", repo: "craigoley/remudero" });
  writeFileSync(live, `${readFileSync(live, "utf8")}${unnamed}\n`);
  const failed = sample().find((d) => d.path === `${base}.runs7d.failed`)!;
  assert.equal(failed.classification, "real");
  assert.match(failed.reason, /no measured row explains c-T9#.*1 dedupe, 1 real/);
});

test("a repositories sum and the condition it drives are judged by the rows each side added", (t) => {
  const f = fixture(t);
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  repositories(run.tick());
  t.after(() => run.release());
  const live = join(f.stateDir, "ledger.ndjson");
  const lines = readFileSync(live, "utf8").split("\n");
  const apiCall = lines.find((line) => line.includes('"billing_mode":"api"'))!;
  const failure = lines.find((line) => line.includes('"blocked_ci"'))!;
  // Legacy's live file re-emits one api call and one failure twice under retried run ids; the view added each once.
  const again = [
    apiCall.replace('"run_id":"c1"', '"run_id":"c1b","task_id":"c-T1"'),
    failure.replace('"run_id":"c2"', '"run_id":"c2b"'),
    failure.replace('"run_id":"c2"', '"run_id":"c2c"'),
  ];
  writeFileSync(live, `${readFileSync(live, "utf8")}${again.join("\n")}\n`);
  assert.equal(run.shadow({ view: "repositories", key: "", requests: 1 }), true);
  const diffs = run.logs.filter((l) => l.step === VIEW_SHADOW_DIFF_STEP).at(-1)!.extra.diffs as Array<{ path: string; classification: string; reason: string }>;
  const base = "instances[instanceId=core].summary.repos[id=craigoley/remudero].";
  assert.deepEqual(diffs.map((d) => [d.path.replace(base, ""), d.classification]), [
    ["health.condition", "dedupe"],
    ["health.errorrate", "dedupe"],
    ["health.reasons", "dedupe"],
    ["health.runs7d.failed", "dedupe"],
    ["telemetry.cache_read_tokens7d", "dedupe"],
    ["telemetry.cash_usd_7d", "dedupe"],
    ["telemetry.cost_7d", "dedupe"],
    ["telemetry.tokens7d", "dedupe"],
  ], JSON.stringify(diffs));
});

test("condition is derived from the run counts only when legacy's signals reproduce the view's", () => {
  const facts = (condition: string) => ({ core: { "o/r": { counts: {}, sums: { "telemetry.cash_usd_7d": { rows: [], precision: 0.01 } }, lastRun: null, condition: () => ({ condition, reasons: [] }) } } });
  const view = { instances: [{ instanceId: "core", summary: { repos: [{ id: "o/r", health: { runs7d: { succeeded: 1, failed: 0, superseded: 0 }, condition: "healthy", reasons: [] } }] } }], projects: [] } as unknown as RepositoriesData;
  const base = "instances[instanceId=core].summary.repos[id=o/r].health";
  const same = repositoriesShadowPairing(facts("healthy") as never, {}, view);
  assert.deepEqual(same.derived[`${base}.condition`], [`${base}.runs7d.succeeded`, `${base}.runs7d.failed`]);
  assert.equal(same.sums["instances[instanceId=core].summary.repos[id=o/r].telemetry.cash_usd_7d"]!.precision, 0.01);
  const down = repositoriesShadowPairing(facts("down") as never, {}, view);
  assert.equal(down.derived[`${base}.condition`], undefined, "a heartbeat the counts cannot explain leaves condition real");
  assert.equal(down.derived[`${base}.reasons`], undefined);
  assert.deepEqual(down.latest[`${base}.last_run`], { legacy: null, view: null });
});

test("a row carried by several rotations is counted once", (t) => {
  const f = fixture(t);
  const raw = [archiveName(20_000), archiveName(10_000)].map((name) => gunzipSync(readFileSync(join(f.stateDir, name))).toString("utf8"))
    .concat(readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8")).join("");
  assert.equal(raw.split('"step":"verdict"').length - 1, 9, "positive control: each of three verdicts sits in three files");
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  const core = repositories(run.tick()).instances[0].summary!.repos[0];
  run.release();
  assert.deepEqual(core.health.runs7d, { succeeded: 2, failed: 1, superseded: 1 });
  assert.equal(core.health.errorrate, 1 / 3);
  assert.equal(core.telemetry.cash_usd_7d, 1.25, "api dollars once, not three times");
  assert.deepEqual(core.telemetry.subscription && { calls7d: core.telemetry.subscription.calls7d, tokens7d: core.telemetry.subscription.tokens7d }, { calls7d: 1, tokens7d: 15 });
  assert.equal(core.telemetry.tokens7d, 165);
  assert.equal(core.telemetry.cache_read_tokens7d, 7);
  assert.equal(core.health.queuedtasks, 2, "the merged task leaves the queue");
  assert.equal(core.health.condition, "healthy");

  const db = openProjectorReadModel(f.stateDir, "core");
  t.after(() => db.close());
  const rows = readRepoRows(db, NOW);
  assert.equal(rows.filter((row) => row.step === "verdict").length, 3);
  assert.equal(rows.filter((row) => row.step === "daemon.heartbeat").length, 1, "the heartbeat rides as one row");
  assert.equal(rows.some((row) => row.step === "worker.activity"), false);
});

test("each instance's summary and ledger carry their own staleness", (t) => {
  const f = fixture(t);
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const view = createRepositoriesReadModelView(ledgerSource);
  const first = ticker(f, { view });
  const fresh = first.tick()!;
  first.release();
  assert.equal(fresh.body.stale, false);
  assert.deepEqual(fresh.body.sources.map((s) => `${s.name}:${s.state}`), ["ledger:core:fresh", "repositories:core:fresh", "ledger:console:fresh", "repositories:console:fresh"]);

  // Console's plan becomes unreadable: its recompute fails, the last good summary stays and says why.
  rmSync(f.sources[1].options.planPath!);
  const later = ticker(f, { view, now: NOW + 61_000, holder: "serve-b" });
  const failed = later.tick()!;
  later.release();
  const consoleSource = failed.body.sources.find((s) => s.name === "repositories:console")!;
  assert.equal(consoleSource.state, "stale");
  assert.match(consoleSource.reason ?? "", /plan read failed/);
  assert.equal(failed.body.sources.find((s) => s.name === "repositories:core")?.state, "fresh", "core is judged on its own");
  assert.deepEqual(repositories(failed).instances[1].summary, repositories(fresh).instances[1].summary);

  // The plan comes back: the next recompute clears the staleness.
  writeFileSync(f.sources[1].options.planPath!, planYaml("craigoley/remudero-console", ["CONSOLE-T1"]));
  const healed = ticker(f, { view, now: NOW + 122_000, holder: "serve-c" });
  const recovered = healed.tick()!;
  healed.release();
  assert.equal(recovered.body.sources.find((s) => s.name === "repositories:console")?.state, "fresh");
  const ledgerState: ReadModelInstanceState = { instance: "core", generation: 1, lease: "held", failures: 0, newestTs: null, tickedAt: NOW };
  assert.equal(ledgerSource(ledgerState, NOW + 60_000).state, "stale", "a projector a minute behind makes its ledger source stale");
});

test("an instance with no read model or no summary yet is absent with a reason", (t) => {
  const f = fixture(t);
  const view = createRepositoriesReadModelView(ledgerSource);
  assert.deepEqual(view.materialize({ now: NOW, instances: [] }), []);
  const run = ticker(f, { view });
  assert.deepEqual(repositories(run.tick()), { instances: [], projects: [], reason: "serve has not published the repository sources yet" });
  run.release();

  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => [...f.sources, { instanceId: "site", options: { root: f.root } }] })();
  const dbPath = join(f.stateDir, "read-model", "core.v1.sqlite");
  const unticked = view.materialize({ now: NOW, instances: [{ state: { instance: "core", generation: 0, lease: "none", failures: 0, newestTs: null }, db: { path: dbPath } as never }] })[0];
  const byId = new Map(unticked.data.instances.map((i) => [i.instanceId, i]));
  assert.deepEqual(byId.get("core"), { instanceId: "core", reason: "the read model has not projected this instance's ledger yet" });
  assert.deepEqual(byId.get("site"), { instanceId: "site", reason: "the read model does not project this instance" });
  assert.equal(unticked.sources.find((s) => s.name === "repositories:core")?.state, "unavailable");

  const broken = view.materialize({ now: NOW + 300_000, instances: [{ state: { instance: "core", generation: 3, lease: "held", failures: 0, newestTs: null, tickedAt: NOW }, db: { path: dbPath, prepare: () => { throw new Error("no such table: repo_row"); } } as never }] })[0];
  assert.match(broken.data.instances[0].reason ?? "", /repository rows unreadable: no such table/);
});

test("a store built before the repo_row projection is re-read so its history is not lost", (t) => {
  const f = fixture(t);
  const db = openProjectorReadModel(f.stateDir, "core");
  t.after(() => db.close());
  const got = acquireLease(db, { holder: "old-serve" });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir: f.stateDir, db, lease: got.lease, projections: [] }).tick();
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM fact").get()?.n) > 0, true, "the old store holds facts");
  const reread = createLedgerProjector({ ledgerDir: f.stateDir, db, lease: got.lease }).tick();
  assert.ok(reread.fresh > 0, "every row is read again");
  assert.equal(readRepoRows(db, NOW).filter((row) => row.step === "verdict").length, 3);
  assert.equal(createLedgerProjector({ ledgerDir: f.stateDir, db, lease: got.lease }).tick().fresh, 0, "a built projection is not rebuilt");
});

function serveDeps(root: string, stateDir: string, every: (run: () => void) => () => void): ServeDeps {
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(root, "plan", "tasks.yaml");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "r", write: "w" },
    consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    instances: { stateBase: join(root, "instances") },
    readModel: { workerUrl: SILENT_WORKER, every },
  };
}

async function listen(t: TestCtx, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("serve publishes every instance's summary options and keeps repositories dark until switched", async (t) => {
  const f = fixture(t);
  const deps = serveDeps(f.root, f.stateDir, (run) => (runs.push(run), () => {}));
  const runs: Array<() => void> = [];
  assert.deepEqual(repositoriesSources(deps).map((s) => ({ ...s.options, instanceId: s.instanceId })), f.sources.map((s) => ({ ...s.options, instanceId: s.instanceId })));
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  run.tick();
  run.release();

  const url = await listen(t, buildServeServer(deps));
  const get = async (): Promise<{ status: number; body?: ViewBody<RepositoriesData> }> => {
    const res = await fetch(`${url}/v1/views/repositories`, { headers: { authorization: "Bearer r" } });
    return { status: res.status, ...(res.status === 200 ? { body: (await res.json()) as ViewBody<RepositoriesData> } : {}) };
  };
  assert.equal((await get()).status, 404, "dark: no route answers from the read model");
  writeFileSync(readModelSwitchesPath(f.stateDir), JSON.stringify({ views: { repositories: "serve" } }));
  for (const each of runs) each();
  const served = await get();
  assert.equal(served.status, 200);
  assert.deepEqual(served.body?.data.instances.map((i) => i.instanceId), ["core", "console"]);
});

test("the repositories source publisher writes only on change and logs a failed write", (t) => {
  const root = scratch(t, "repositories-pub");
  const instances = [{ instanceId: "core", options: { root } }];
  const publish = createRepositoriesSourcePublisher({ stateDir: root, instances: () => instances });
  assert.equal(publish(), true);
  assert.equal(publish(), false);
  writeFileSync(join(root, "blocker"), "");
  const logs: string[] = [];
  const stop = startRepositoriesSourcePublisher({ stateDir: join(root, "blocker"), instances: () => instances, log: (step) => void logs.push(step), every: () => () => undefined });
  stop();
  assert.deepEqual(logs, ["read_model.repositories_sources_failed"]);
});

test("an unreadable registry or a half-written sources file is named and never guessed", async (t) => {
  const f = fixture(t);
  const missing = { ...f.sources[0], options: { ...f.sources[0].options, repoRegistryPath: join(f.root, "no-registry.yaml") } };
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => [missing] })();
  const run = ticker(f);
  const core = repositories(run.tick()).instances[0].summary!;
  run.release();
  assert.deepEqual(core.registry, { state: "unavailable", reason: "unreadable" });
  assert.deepEqual(core, await legacySummary(missing.options), "the route names the same reason");

  writeFileSync(join(f.stateDir, "read-model", "repositories-sources.json"), "{\"instances\": [");
  const torn = ticker(f, { holder: "serve-b" });
  assert.match(repositories(torn.tick()).reason ?? "", /not published/);
  torn.release();
});

test("the repositories view names the worst repository per project", (t) => {
  const f = fixture(t);
  writeFileSync(daemonInstanceRegistryPath(f.root), `${readFileSync(daemonInstanceRegistryPath(f.root), "utf8")}  site:\n    github_repo: craigoley/remudero-site\n    project: remudero\n  wiki:\n    github_repo: craigoley/wiki\n`);
  const site = { instanceId: "site", options: { root: f.root, instanceRepository: { owner: "craigoley", repo: "remudero-site" } } };
  const wiki = { instanceId: "wiki", options: { root: f.root } };
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => [...f.sources, site, wiki] })();
  const view = createRepositoriesReadModelView(ledgerSource);
  const first = ticker(f, { view });
  const data = repositories(first.tick());
  first.release();
  assert.equal(data.projectsReason, undefined, "the registry was read");
  assert.deepEqual(data.projects, [
    {
      project: "remudero",
      repos: [
        { id: "craigoley/remudero", reponame: "remudero", instanceId: "core", state: "verified" },
        { id: "craigoley/remudero-console", reponame: "remudero-console", instanceId: "console", state: "verified" },
        { id: "craigoley/remudero-site", reponame: "remudero-site", instanceId: "site", state: "unavailable" },
      ],
      worst: { state: "unavailable", repoId: "craigoley/remudero-site", repoName: "remudero-site" },
    },
    { project: "default", repos: [{ id: "craigoley/wiki", reponame: "wiki", instanceId: "wiki", state: "unavailable" }], worst: { state: "unavailable", repoId: "craigoley/wiki", repoName: "wiki" } },
  ]);

  // Console's recompute fails: its last summary stays, and its project's worst is the stale one, the first found.
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  rmSync(f.sources[1].options.planPath!);
  const later = ticker(f, { view, now: NOW + 61_000, holder: "serve-b" });
  const stale = repositories(later.tick());
  later.release();
  assert.deepEqual(stale.projects.map((p) => [p.project, p.repos.map((r) => r.state), p.worst.repoName]), [["remudero", ["verified", "stale"], "remudero-console"]]);
});

test("an unreadable registry makes every repository its own project and says why", (t) => {
  const f = fixture(t);
  writeFileSync(daemonInstanceRegistryPath(f.root), "instances:\n  core:\n    project: remudero\n");
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  const data = repositories(run.tick());
  run.release();
  assert.match(data.projectsReason ?? "", /could not be parsed: .*missing_repo/);
  assert.deepEqual(data.projects.map((p) => [p.project, p.worst.state, p.worst.repoName]), [["core", "unavailable", "core"], ["remudero-console", "verified", "remudero-console"]],
    "core resolves no repository without its registry, so it is listed unavailable under its instance name, never dropped");
  assert.deepEqual(groupRepositoryProjects([]), [], "no repository is no project");
  const bare = { ...f.sources[0], options: { ...f.sources[0].options, repoRegistryPath: undefined } };
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => [bare] })();
  const again = ticker(f, { holder: "serve-b", now: NOW + 61_000 });
  assert.equal(repositories(again.tick()).projectsReason, "no instance names a registry");
  again.release();
});

test("a cold repositories build reads each plan and each summary as a step of its own", (t) => {
  const f = fixture(t);
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  const whole = repositories(run.tick());
  run.release();
  const dbs = ["core", "console"].map((name) => openProjectorReadModel(f.stateDir, name));
  t.after(() => dbs.forEach((db) => db.close()));
  const instances = dbs.map((db, i) => ({ state: { instance: ["core", "console"][i], generation: 1, lease: "held" as const, failures: 0, newestTs: null, tickedAt: NOW }, db }));
  const view = createRepositoriesReadModelView(ledgerSource);
  const stepsUntilDone = (now: number): number => {
    let steps = 0;
    for (let done = false, calls = 0; !done && calls < 20; calls++) {
      let allowed = true;
      done = view.prepare({ now, instances }, () => {
        if (!allowed) return false;
        allowed = false;
        steps += 1;
        return true;
      });
    }
    return steps;
  };
  assert.equal(stepsUntilDone(NOW), 4, "core's plan, core's summary, console's plan, console's summary");
  assert.deepEqual(view.materialize({ now: NOW, instances })[0].data.instances, whole.instances, "the stepped summaries are the one-unit build's");
  assert.equal(stepsUntilDone(NOW + 1_000), 0, "nothing is due inside the cadence");
  assert.equal(stepsUntilDone(NOW + 61_000), 2, "a recompute over unchanged plans is the two summaries");
});

test("a usage window's percent_used is explained by the newer reading it is", () => {
  // Captured 2026-10-01T05:39:01Z: ...telemetry.subscription.windows[1].percent_used read real beside a timing observed_at;
  // the readings are the core ledger's worker.assignment windows at 05:54:45.422Z (58) and 06:04:56.451Z (59).
  const at = (percent: number, observed: string) => ({ provider: "claude", window: "weekly (all models)", percent_used: percent, resets_at: "2026-10-04T05:00:00.441142+00:00", observed_at: observed });
  const data = (window: ReturnType<typeof at>) => ({ instances: [{ instanceId: "core", summary: { repos: [{ id: "craigoley/remudero", telemetry: { subscription: { calls7d: 1, tokens7d: 1, windows: [window] } } }] } }], projects: [] });
  const judge = (legacy: ReturnType<typeof at>, view: ReturnType<typeof at>): Array<[string, string]> => {
    const shadow = createViewShadow({ clock: fixedClock(Date.parse("2026-10-01T06:05:00.000Z")), log: () => {}, evidence: (input) => readShadowEvidence([], input) });
    const pairing = repositoriesShadowPairing({}, {}, data(view) as unknown as RepositoriesData);
    const legacySide = { data: data(legacy), asOfMs: Date.parse("2026-10-01T06:05:00.000Z"), derived: pairing.derived };
    const got = shadow.compare({ view: "repositories", key: "", requests: 0, legacy: legacySide, body: { data: data(view), asOf: "2026-10-01T05:55:00.000Z" } });
    return got.diffs.map((d) => [d.path.replace(/^.*windows\[0\]\./, ""), d.classification]);
  };
  assert.deepEqual(judge(at(59, "2026-10-01T06:04:56.451Z"), at(58, "2026-10-01T05:54:45.422Z")), [["observed_at", "timing"], ["percent_used", "timing"]]);
  assert.deepEqual(judge(at(59, "2026-10-01T05:54:45.422Z"), at(58, "2026-10-01T05:54:45.422Z")), [["percent_used", "real"]], "one reading two percentages is a bug");
});

/** A worker cost row, as `projectRepoTelemetry` sums it into tokens7d, cache reads and the subscription split. */
function costRow(ts: number, taskId: string, step: string, input: number): string {
  return JSON.stringify({ ts: new Date(ts).toISOString(), step, task_id: taskId, run_id: `${taskId}-run`, billing_mode: "subscription", total_cost_usd: 0.1, tokens: { input, output: 0, cacheRead: input } });
}

/** One sampled comparison taken `laterMs` after the body was built, as the shadow driver takes it on the host. */
function sampleLater(t: TestCtx, f: Fixture, before: string[], after: string[], laterMs: number): Array<{ path: string; classification: string; reason: string }> {
  const live = join(f.stateDir, "ledger.ndjson");
  writeFileSync(live, `${readFileSync(live, "utf8")}${before.map((line) => `${line}\n`).join("")}`);
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => f.sources })();
  const run = ticker(f);
  t.after(() => run.release());
  repositories(run.tick());
  writeFileSync(live, `${readFileSync(live, "utf8")}${after.map((line) => `${line}\n`).join("")}`);
  run.at(NOW + laterMs);
  assert.equal(run.shadow({ view: "repositories", key: "", requests: 1 }), true, "the worker computed the legacy side and compared");
  return (run.logs.filter((l) => l.step === VIEW_SHADOW_DIFF_STEP).at(-1)?.extra.diffs ?? []) as Array<{ path: string; classification: string; reason: string }>;
}

const WEEK_MS = 7 * 24 * 3_600_000;

test("a cost row leaving the seven-day window between the build and the sample is no repositories diff", (t) => {
  // Captured 2026-10-01T07:57:45Z: telemetry.tokens7d read real, its residual 458255 exactly RETRO#retro.synthesized@2026-09-24T07:57:24,
  // the row then crossing the window edge: the view's summary was evaluated before it aged out and legacy's after.
  const f = fixture(t);
  const edge = costRow(NOW - WEEK_MS + 10_000, "RETRO", "retro.synthesized", 458_255);
  const diffs = sampleLater(t, f, [edge], [], 20_000);
  assert.deepEqual(diffs.filter((d) => d.path.includes("tokens7d") || d.path.includes("calls7d")), [], JSON.stringify(diffs));
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));
});

test("a cost row written seconds after the repositories build is no diff when legacy reads at the build instant", (t) => {
  // Captured 2026-10-01T14:02:14Z: residual 814006 exactly TRIAGE-fb-1789303258903-a19164#triage.synthesized@14:01:55, 19 s
  // before the sample: legacy's window closed at the sample instant and took in a row the view's earlier summary could not.
  const f = fixture(t);
  const fresh = costRow(NOW + 10_000, "TRIAGE-fb-1789303258903-a19164", "triage.synthesized", 814_006);
  const diffs = sampleLater(t, f, [], [fresh], 20_000);
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));
  assert.deepEqual(diffs.map((d) => d.path), [], "both sides evaluated the same window over the same rows");
});

test("a cost row inside both windows that the view lacks is still a real repositories diff", (t) => {
  // The negative control: a row older than the view's own summary instant, missing from the view, is a wrong value.
  const f = fixture(t);
  const missed = costRow(NOW - 3_600_000, "c-T7", "implement.done", 1_234);
  const diffs = sampleLater(t, f, [], [missed], 20_000);
  const tokens = diffs.find((d) => d.path === "instances[instanceId=core].summary.repos[id=craigoley/remudero].telemetry.tokens7d");
  assert.equal(tokens?.classification, "real", JSON.stringify(diffs));
  assert.match(tokens!.reason, /a residual of 1234 no measured row explains \(c-T7#implement\.done@/);
});
