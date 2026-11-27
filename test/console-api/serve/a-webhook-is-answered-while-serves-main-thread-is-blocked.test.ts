/**
 * W1-T14986: serve answers a webhook 202 and arms its wake marker off the main thread.
 * OBSERVED 2026-11-26: 29 of 4,000 App webhook deliveries timed out at GitHub's 10 s behind synchronous work on serve's
 * main thread. The supervisor's hook listener (github-hook-listener.ts) owns its own server in a worker thread, runs
 * the route's own fast path (acceptGithubDelivery, github-delivery-accept.ts) and relays each accepted check run to
 * the active generation after the 202.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import {
  createGitHubEventWakeHandler,
  createPersistentDeliveryDedupStore,
  githubDeliveryDedupPath,
  readSweepWakeMarker,
  sweepWakeMarkerPath,
  writeSweepWakeMarkerAtomicAsync,
} from "#src/lib/github-event-wake.js";
import { createGithubHookServer, serveHookPort, startGithubHookListener, type GithubHookListenerMessage } from "#src/lib/github-hook-listener.js";
import {
  GENERATION_MESSAGES,
  isGithubHookConfig,
  onGithubDelivery,
  startGithubHookConfigPush,
  type GenerationChannel,
  type GenerationMessage,
  type GithubHookConfig,
} from "#src/lib/serve-generation.js";
import { createServeSupervisor, type GenerationProcess, type ServeSupervisor, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import { runServeSupervisor } from "#src/lib/serve-supervisor-main.js";
import { buildServeServer, githubHookConfigOf, githubWakeMarkerPaths, resolveConsoleSha, serveGeneration, type ServeDeps } from "#src/lib/serve.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const SECRET = "w1-t14986-secret";
const CORE = "craigoley/remudero";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

interface Fixture { root: string; secretFile: string; markerPath: string; dedupPath: string; config: GithubHookConfig }

function fixture(t: TestContext, extra: Partial<GithubHookConfig> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hook-listener-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, `${SECRET}\n`);
  const markerPath = sweepWakeMarkerPath(root);
  const dedupPath = githubDeliveryDedupPath(root);
  const config: GithubHookConfig = {
    repository: CORE, markerPaths: { [CORE]: markerPath }, dedupPath, dedupCapacity: 100, semanticCheckMode: "shadow", aggregateCheckNames: ["ci-gate"], ...extra,
  };
  return { root, secretFile, markerPath, dedupPath, config };
}

function delivery(id: string, event: string, payload: Record<string, unknown>, signature?: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  return { body, headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signature ?? sign(body) } };
}

const pullRequest = (repository = CORE): Record<string, unknown> => ({ action: "opened", repository: { full_name: repository }, pull_request: { number: 7 } });
const checkRun = (id: number): Record<string, unknown> => ({
  action: "completed", repository: { full_name: CORE },
  check_run: { id, name: "unit", conclusion: "failure", head_sha: "a".repeat(40), head_branch: "main" },
});

async function post(port: number, d: { body: string; headers: Record<string, string> }, path = "/v1/hooks/github"): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: d.headers, body: d.body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

type Row = { step: string; extra?: Record<string, unknown> };

/** The real listener thread, on an ephemeral port, configured and answering. */
async function startListener(t: TestContext, f: Fixture, rows: Row[] = []) {
  const handle = startGithubHookListener({
    env: { RMD_SERVE_HOOK_PORT: "0", RMD_GITHUB_WEBHOOK_SECRET_FILE: f.secretFile }, host: "127.0.0.1", log: (step, extra) => void rows.push({ step, extra }),
  });
  assert.ok(handle, "a set port starts the listener");
  t.after(() => handle.stop());
  const messages: GithubHookListenerMessage[] = [];
  handle.onMessage((message) => {
    messages.push(message);
    if (message.kind === "log") rows.push({ step: message.step, extra: message.extra });
  });
  const port = await handle.listening();
  assert.equal(typeof port, "number");
  return { handle, port: port as number, messages, rows };
}

/** Polls until the pushed config has reached the listener: a bad signature reads 401 only once it answers with one. */
async function untilConfigured(port: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const answer = await post(port, delivery("probe", "pull_request", pullRequest(), "sha256=00"));
    if (answer.status === 401) return;
    assert.deepEqual(answer, { status: 503, body: { error: "hook_config_pending" } }, "until the first push the listener answers 503");
    await sleep(5);
  }
  assert.fail("the pushed config never reached the listener");
}

test("W1-T14986 criterion 1: a webhook POST is answered 202 while serve's main thread is blocked", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const { handle, port } = await startListener(t, f);
  const before = await post(port, delivery("probe", "pull_request", pullRequest(), "sha256=00"));
  assert.deepEqual(before, { status: 503, body: { error: "hook_config_pending" } }, "positive control: no config yet, a named 503");
  handle.configure(f.config);
  await untilConfigured(port);

  const d = delivery("d-blocked", "pull_request", pullRequest());
  const flags = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT));
  const client = new Worker(`
    const { workerData, parentPort } = require("node:worker_threads");
    const http = require("node:http");
    const flags = workerData.flags;
    parentPort.postMessage("ready");
    Atomics.wait(flags, 0, 0);
    const started = performance.now();
    const req = http.request({ host: "127.0.0.1", port: workerData.port, path: "/v1/hooks/github", method: "POST", headers: workerData.headers }, (res) => {
      res.resume();
      res.on("end", () => { Atomics.store(flags, 1, res.statusCode); Atomics.store(flags, 2, Math.ceil(performance.now() - started)); Atomics.store(flags, 3, 1); });
    });
    req.on("error", () => Atomics.store(flags, 3, 2));
    req.end(workerData.body);
  `, { eval: true, execArgv: [], workerData: { flags, port, headers: d.headers, body: d.body } });
  t.after(() => client.terminate());
  await new Promise<void>((resolve) => client.once("message", () => resolve()));

  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
  const blockedFrom = performance.now();
  // This thread started the listener; it now runs nothing for 3 s.
  Atomics.wait(flags, 4, 0, 3_000);
  const blockedMs = performance.now() - blockedFrom;

  assert.ok(blockedMs >= 2_900, `the starting thread was blocked for 3 s (${blockedMs} ms)`);
  assert.equal(Atomics.load(flags, 3), 1, "the client was answered while this thread was blocked");
  assert.equal(Atomics.load(flags, 1), 202);
  assert.ok(Atomics.load(flags, 2) < 1_000, `answered within 1 s (${Atomics.load(flags, 2)} ms)`);
  assert.equal(readSweepWakeMarker(f.markerPath)?.deliveryId, "d-blocked", "and the delivery armed the wake marker");
});

test("W1-T14986 criterion 2: the marker is armed before the 202 is sent", async (t) => {
  const f = fixture(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let released = false;
  const hook = createGithubHookServer({
    secretFile: f.secretFile, post: () => {},
    writeMarker: async (path, record) => {
      await gate;
      await writeSweepWakeMarkerAtomicAsync(path, record);
    },
  });
  t.after(() => hook.stop());
  hook.configure(f.config);
  const port = await listen(hook.server);

  let answeredEarly: boolean | undefined;
  const answered = post(port, delivery("d-armed", "pull_request", pullRequest())).then((answer) => {
    answeredEarly = !released;
    // Read at the instant the answer arrived: both writes must already be on disk.
    return { ...answer, marker: readSweepWakeMarker(f.markerPath), dedup: existsSync(f.dedupPath) ? readFileSync(f.dedupPath, "utf8") : "" };
  });
  await sleep(200);
  assert.equal(answeredEarly, undefined, "no answer while the marker write is still pending");
  released = true;
  release();
  const answer = await answered;
  assert.equal(answeredEarly, false);
  assert.deepEqual({ status: answer.status, body: answer.body }, { status: 202, body: { accepted: true } });
  assert.equal(answer.marker?.deliveryId, "d-armed", "the marker holds the delivery id when the 202 arrives");
  assert.deepEqual((JSON.parse(answer.dedup) as { deliveryIds: string[] }).deliveryIds, ["d-armed"], "and so does the dedup window");
});

/** A supervisor whose one generation is a real serve server over a fake IPC channel. */
function supervisedServe(t: TestContext, f: Fixture, listener: ServeSupervisorOptions["hookListener"], jobLogReads: number[]) {
  const toServe: Array<(m: GenerationMessage) => void> = [];
  const toSupervisor: Array<(m: GenerationMessage) => void> = [];
  const exits: Array<(code: number | null, signal: string | null) => void> = [];
  const channel: GenerationChannel = { send: (m) => toSupervisor.forEach((l) => l(m)), onMessage: (l) => void toServe.push(l) };
  const ledgerPath = join(f.root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const plan: Plan = { tasks: [], byId: new Map() };
  const deps: ServeDeps = {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root: f.root, planPath: join(f.root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: f.root,
    questionsRoot: f.root,
    tokens: { read: "hook-read", write: "hook-write" },
    consoleSha: resolveConsoleSha(),
    daemonHealth: { exec: () => "{}", statfs: () => ({ bavail: 1, bsize: 1 }) },
    staleExitSeams: { scheduleRecheck: () => () => {}, exit: () => {} },
    incidentInvariants: { setInterval: ((() => 0) as unknown) as typeof setInterval, clearInterval: () => {} },
    generation: { requestHandoff: () => {}, channel },
    githubEventWake: { secret: SECRET, repository: CORE, dedupCapacity: 100, aggregateCheckNames: ["ci-gate"] },
    ciIncidents: { fetchJobLog: (_repository, jobId) => (jobLogReads.push(jobId), "log") },
  };
  const server = buildServeServer(deps);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const spawn: ServeSupervisorOptions["spawn"] = () => ({
    pid: 1,
    send(message) {
      if (message.type === GENERATION_MESSAGES.promote) {
        toSupervisor.forEach((l) => l({ type: GENERATION_MESSAGES.promoted }));
        serveGeneration(server)!.promote();
        return;
      }
      if (message.type === GENERATION_MESSAGES.drain) return void queueMicrotask(() => exits.splice(0).forEach((l) => l(0, null)));
      toServe.forEach((l) => l(message));
    },
    onMessage: (l) => void toSupervisor.push(l),
    onExit: (l) => void exits.push(l),
    kill: () => {},
  }) satisfies GenerationProcess;
  const rows: Row[] = [];
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async () => ({ dir: "/slot-a", sha: "sha-2" }),
    spawn,
    get: async () => ({ status: 200, body: JSON.stringify({ sha: "sha-1", ready: true, criteria: [] }) }),
    command: () => ({ exec: "gen", execArgv: [], args: [], cwd: "/cold" }),
    log: (step, extra) => void rows.push({ step, extra }),
    exit: () => {},
    sleep: () => new Promise<void>(() => {}),
    every: () => () => {},
    cpuBudget: { every: () => () => {}, usageUsec: () => undefined, consumers: () => new Map() },
    socketPathFor: (n) => `/sock/${n}`,
    hookListener: listener,
  });
  return { supervisor, rows, channel, crash: () => exits.forEach((l) => l(1, null)), deps };
}

test("W1-T14986 criterion 3: an accepted delivery's follow-up reaches the active generation after the 202", { timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const listener = await startListener(t, f);
  const jobLogReads: number[] = [];
  const s = supervisedServe(t, f, listener.handle, jobLogReads);
  t.after(() => s.supervisor.shutdown("test"));
  await s.supervisor.start();
  await untilConfigured(listener.port);

  let answeredAt: number | undefined;
  let readAt: number | undefined;
  const answer = await post(listener.port, delivery("d-check-1", "check_run", checkRun(101)));
  answeredAt = performance.now();
  assert.deepEqual(answer, { status: 202, body: { accepted: true } });
  for (let i = 0; i < 400 && jobLogReads.length === 0; i++) await sleep(5);
  readAt = performance.now();
  assert.deepEqual(jobLogReads, [101], "the relayed check run reached the active generation's onCheckRunCompleted");
  assert.ok(readAt >= answeredAt, "after the 202");

  // The generation pushes a changed config while active: the listener takes it at once.
  s.channel.send({ type: GENERATION_MESSAGES.githubHookConfig, config: { ...f.config, markerPaths: {} } });
  for (let i = 0; i < 400; i++) {
    if ((await post(listener.port, delivery("d-unmanaged", "pull_request", pullRequest()))).status === 202) break;
    await sleep(5);
  }
  assert.equal(readSweepWakeMarker(f.markerPath)?.deliveryId, "d-check-1", "the new map manages no repository, so nothing more is armed");
  s.channel.send({ type: GENERATION_MESSAGES.githubHookConfig, config: f.config });
  s.channel.send({ type: GENERATION_MESSAGES.githubHookConfig, config: { repository: 1 } });

  s.crash();
  for (let i = 0; i < 400; i++) {
    const again = await post(listener.port, delivery(`d-check-${i + 2}`, "check_run", checkRun(102)));
    assert.equal(again.status, 202, "with no generation active the delivery is still answered");
    if (s.rows.concat(listener.rows).some((r) => r.step === "github.wake.check_run_callback_failed" && r.extra?.reason === "no_active_generation")) break;
    await sleep(5);
  }
  assert.ok(s.rows.some((r) => r.step === "github.wake.check_run_callback_failed" && r.extra?.reason === "no_active_generation"), "and its follow-up is logged and dropped");
  assert.deepEqual(jobLogReads, [101], "never run on a dead generation");
});

test("W1-T14986 criterion 4: the listener refuses and ignores exactly as the route does", { timeout: 30_000 }, async (t) => {
  const listenerSide = fixture(t);
  const routeSide = fixture(t);
  const { handle, port: listenerPort } = await startListener(t, listenerSide);
  handle.configure(listenerSide.config);
  await untilConfigured(listenerPort);
  const route = createGitHubEventWakeHandler({
    secret: SECRET, repository: CORE, markerPath: routeSide.markerPath, resolveMarkerPath: (repository) => routeSide.config.markerPaths[repository],
    dedup: createPersistentDeliveryDedupStore(routeSide.dedupPath, 100), aggregateCheckNames: ["ci-gate"], counters: { accepted_coalesced: 0, ignored: 0, duplicate: 0, by_event: {} },
  });
  const routeServer = createServer((req, res) => void route.handler(req, res, {} as never));
  t.after(() => routeServer.close());
  const routePort = await listen(routeServer);
  const both = async (d: { body: string; headers: Record<string, string> }) => ({ listener: await post(listenerPort, d), route: await post(routePort, d) });
  const state = (side: Fixture) => ({ marker: existsSync(side.markerPath) ? readFileSync(side.markerPath, "utf8") : undefined, files: readdirSync(join(side.root, "state")).sort() });

  const bad = await both(delivery("d-bad", "pull_request", pullRequest(), sign("another body")));
  assert.deepEqual(bad.listener, { status: 401, body: { error: "invalid_signature" } });
  assert.deepEqual(bad.listener, bad.route);
  assert.equal(state(listenerSide).marker, undefined, "a bad signature writes no marker");

  const first = await both(delivery("d-1", "pull_request", pullRequest()));
  assert.deepEqual(first.listener, { status: 202, body: { accepted: true } });
  assert.deepEqual(first.listener, first.route);
  const armed = state(listenerSide);
  const seen = await both(delivery("d-1", "pull_request", pullRequest()));
  assert.deepEqual(seen.listener, { status: 202, body: { duplicate: true } });
  assert.deepEqual(seen.listener, seen.route);
  assert.deepEqual(state(listenerSide), armed, "a seen delivery id leaves the marker untouched");

  const unmanaged = await both(delivery("d-2", "pull_request", pullRequest("someone/else")));
  assert.deepEqual(unmanaged.listener, { status: 202, body: { error: "unmanaged_repository" } });
  assert.deepEqual(unmanaged.listener, unmanaged.route);
  assert.deepEqual(state(listenerSide), armed, "an unmanaged repository writes nothing");

  for (const [name, d] of [
    ["invalid json", { body: "{", headers: { "x-github-event": "pull_request", "x-github-delivery": "d-3", "x-hub-signature-256": sign("{") } }],
    ["unlisted event", delivery("d-4", "fork", pullRequest())],
    ["no delivery id", { ...delivery("", "pull_request", pullRequest()) }],
  ] as const) {
    const answer = await both(d);
    assert.deepEqual(answer.listener, answer.route, name);
  }
  assert.deepEqual(await post(listenerPort, delivery("d-5", "pull_request", pullRequest()), "/v1/other"), { status: 404, body: { error: "not_found" } });
});

test("W1-T14986: the listener's edges are named — no port, a bad port, no secret, a dead thread, a torn request", { timeout: 30_000 }, async (t) => {
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  assert.equal(serveHookPort({}), undefined);
  assert.equal(startGithubHookListener({ env: {}, log }), undefined, "ships dark: no port, no thread");
  assert.equal(startGithubHookListener({ env: { RMD_SERVE_HOOK_PORT: "http" }, log }), undefined);
  assert.deepEqual(rows.pop(), { step: "github.wake.unavailable", extra: { reason: "hook_port_invalid", value: "http" } });
  assert.equal(startGithubHookListener({ log }) === undefined, process.env.RMD_SERVE_HOOK_PORT === undefined, "the process env by default");

  const busy = createServer();
  t.after(() => busy.close());
  const busyPort = await listen(busy);
  const taken = startGithubHookListener({ env: { RMD_SERVE_HOOK_PORT: String(busyPort) }, host: "127.0.0.1", log });
  const takenRows: Row[] = [];
  taken!.onMessage((m) => void (m.kind === "log" && takenRows.push({ step: m.step, extra: m.extra })));
  assert.equal(await taken!.listening(), undefined, "a port in use never listens");
  for (let i = 0; i < 200 && !rows.some((r) => r.extra?.reason === "hook_listener_exited"); i++) await sleep(5);
  assert.equal(takenRows[0]?.extra?.reason, "hook_listen_failed");
  assert.ok(rows.some((r) => r.extra?.reason === "hook_listener_exited"), "and its exit is named");

  const broken = startGithubHookListener({ env: { RMD_SERVE_HOOK_PORT: "0" }, log, workerUrl: new URL("data:text/javascript,throw new Error('boom')") });
  assert.equal(await broken!.listening(), undefined);
  for (let i = 0; i < 200 && !rows.some((r) => r.extra?.reason === "hook_listener_failed"); i++) await sleep(5);
  assert.ok(rows.some((r) => r.extra?.reason === "hook_listener_failed" && String(r.extra?.error).includes("boom")));
  await broken!.stop();

  const f = fixture(t);
  const posted: GithubHookListenerMessage[] = [];
  const noSecret = createGithubHookServer({ secretFile: join(f.root, "absent"), post: (m) => void posted.push(m) });
  t.after(() => noSecret.stop());
  noSecret.configure(f.config);
  noSecret.configure({ ...f.config });
  noSecret.configure({ ...f.config, dedupCapacity: 5, semanticCheckMode: "enforce" });
  const port = await listen(noSecret.server);
  assert.deepEqual(await post(port, delivery("d-1", "pull_request", pullRequest())), { status: 503, body: { error: "webhook_not_configured" } });

  await new Promise<void>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/v1/hooks/github", method: "POST", headers: { "content-length": "1000" } });
    req.on("error", () => {});
    req.on("close", () => resolve());
    req.write("{");
    setTimeout(() => req.destroy(), 50);
  });
  const withSecret = createGithubHookServer({ secretFile: f.secretFile, post: (m) => void posted.push(m) });
  t.after(() => withSecret.stop());
  withSecret.configure(f.config);
  const port2 = await listen(withSecret.server);
  await new Promise<void>((resolve) => {
    const req = request({ host: "127.0.0.1", port: port2, path: "/v1/hooks/github", method: "POST", headers: { "content-length": "1000" } });
    req.on("error", () => {});
    req.on("close", () => resolve());
    req.write("{");
    setTimeout(() => req.destroy(), 50);
  });
  for (let i = 0; i < 200 && !posted.some((m) => m.kind === "log" && m.extra?.reason === "hook_request_failed"); i++) await sleep(5);
  assert.ok(posted.some((m) => m.kind === "log" && m.extra?.reason === "hook_request_failed"), "a torn request is named, never an unhandled rejection");
});

test("W1-T14986: the generation's half — the config it pushes, the follow-ups it takes, and the supervisor entry's wiring", async (t) => {
  const f = fixture(t);
  const sent: GenerationMessage[] = [];
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const channel: GenerationChannel = { send: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) };

  let value: GithubHookConfig | undefined = f.config;
  let ticks: () => void = () => {};
  const rows: Row[] = [];
  const stop = startGithubHookConfigPush(channel, () => {
    if (value === null as never) throw new Error("registry unreadable");
    return value;
  }, (step, extra) => void rows.push({ step, extra }), (tick) => ((ticks = tick), () => {}));
  assert.deepEqual(sent, [{ type: GENERATION_MESSAGES.githubHookConfig, config: f.config }], "pushed once at promotion");
  ticks();
  assert.equal(sent.length, 1, "an unchanged config is not pushed again");
  value = { ...f.config, dedupCapacity: 7 };
  ticks();
  assert.equal(sent.length, 2, "a changed one is");
  value = undefined;
  ticks();
  value = null as never;
  ticks();
  assert.equal(sent.length, 2);
  assert.equal(rows[0]?.extra?.reason, "hook_config_unread");
  stop();
  startGithubHookConfigPush(channel, () => undefined, () => {})();

  const taken: number[] = [];
  onGithubDelivery(channel, (info) => void taken.push(info.id));
  for (const l of listeners) {
    l({ type: GENERATION_MESSAGES.githubDelivery, checkRunCompleted: { id: 9, sha: "s", name: "n", conclusion: "failure" } });
    l({ type: GENERATION_MESSAGES.githubDelivery, checkRunCompleted: "nope" });
    l({ type: GENERATION_MESSAGES.githubDelivery });
    l({ type: GENERATION_MESSAGES.promote });
  }
  assert.deepEqual(taken, [9]);

  assert.equal(isGithubHookConfig(f.config), true);
  for (const bad of [undefined, "x", { ...f.config, dedupCapacity: 0 }, { ...f.config, semanticCheckMode: "loud" }, { ...f.config, aggregateCheckNames: [1] }, { ...f.config, markerPaths: [] }, { ...f.config, markerPaths: { a: 1 } }]) {
    assert.equal(isGithubHookConfig(bad), false, JSON.stringify(bad));
  }

  const stateBase = join(f.root, "instances");
  mkdirSync(join(stateBase, "site", "state"), { recursive: true });
  const registry = join(f.root, "daemon-instances.yaml");
  const row = (name: string, repo: string) => [`  ${name}:`, `    repo: ${repo}`, "    project: remudero", `    github_repo: craigoley/${repo}`, `    state_dir: /host/${name}-state`];
  writeFileSync(registry, ["instances:", ...row("core", "remudero"), ...row("site", "remudero-site"), ...row("gone", "gone"), ""].join("\n"));
  const paths = githubWakeMarkerPaths(CORE, f.root, { registryPath: registry, stateBase });
  assert.deepEqual(Object.keys(paths).length, 2, JSON.stringify(paths));
  assert.equal(paths[CORE], f.markerPath);
  assert.ok(Object.values(paths).includes(sweepWakeMarkerPath(join(stateBase, "site"))), "a mounted instance's marker; an unmounted one has none");
  assert.deepEqual(githubWakeMarkerPaths(CORE, f.root, undefined), { [CORE]: f.markerPath });
  assert.equal(githubHookConfigOf({ fleetControlRoot: f.root, questionsRoot: f.root }), undefined, "serve that takes no webhooks pushes nothing");
  assert.deepEqual(githubHookConfigOf({ fleetControlRoot: f.root, questionsRoot: f.root, githubEventWake: { repository: CORE }, instances: { registryPath: join(f.root, "absent.yaml") } }), {
    repository: CORE, markerPaths: { [CORE]: f.markerPath }, dedupPath: f.dedupPath, dedupCapacity: 500, semanticCheckMode: "shadow", aggregateCheckNames: ["ci-gate", "ci"],
  });

  let built: ServeSupervisorOptions | undefined;
  const handle = { configure: () => {}, onMessage: () => {}, listening: async () => 1, stop: async () => {} };
  const askedWith: unknown[] = [];
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hook-cold-`));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  writeFileSync(join(repoDir, "package.json"), "{}\n");
  writeFileSync(join(repoDir, "package-lock.json"), "lock");
  const fake: ServeSupervisor = { start: async () => {}, requestHandoff: async () => {}, shutdown: async () => {}, activeSha: () => undefined };
  await runServeSupervisor(["--", "serve", "--host", "0.0.0.0", "--port", "4317"], {
    env: { RMD_SERVE_GENS_DIR: repoDir, RMD_SERVE_HOOK_PORT: "4320" },
    cwd: repoDir,
    run: async (command, _args, cwd) => (command === "npm" && mkdirSync(join(cwd, "node_modules"), { recursive: true }), ""),
    headSha: () => "abc",
    log: () => {},
    create: (opts) => ((built = opts), fake),
    hookListener: (opts) => (askedWith.push({ host: opts.host, port: opts.env?.RMD_SERVE_HOOK_PORT }), handle),
    onSignal: () => {},
  });
  assert.deepEqual(askedWith, [{ host: "0.0.0.0", port: "4320" }], "the entry starts the listener on serve's own host");
  assert.equal(built?.hookListener, handle, "and hands it to the supervisor");
});
