/**
 * src/lib/serve-generation.ts: the standby's readiness probe, its private socket, and the IPC
 * channel to deploy/serve-supervisor.mjs (arch-phase3-design.md §3).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  awaitPromotion,
  boardComputedProbe,
  GENERATION_MESSAGES,
  gatewayPrimedProbe,
  githubAuthProbe,
  listenReadiness,
  onDrainRequest,
  onRestoreRequest,
  onShedRequest,
  planLoadedProbe,
  processChannel,
  readinessReport,
  readModelWarmProbe,
  supervisedRole,
  type GenerationMessage,
} from "#src/lib/serve-generation.js";
import { makeTempDir, RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { systemClock } from "#src/lib/clock.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_VERSION, refreshInboxClassification } from "#src/lib/inbox-view.js";
import type { PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createReadModelTicker, createReadModelWorker, loadCommittedViewBodies, readModelStatusView, readModelSwitchesPath, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

function overSocket(socketPath: string, path: string): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("readiness reports each criterion and is 503 until the board snapshot is computed", async () => {
  let boardDone = false;
  const real = createServer((req, res) => res.end(req.headers.authorization === "Bearer read-token" ? "real route" : "no token"));
  const socketPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ready-`)), "gen.sock");
  const plan = { tasks: [{ id: "W1-T1" }], byId: new Map() } as never;
  const priv = await listenReadiness(real, socketPath, () => [planLoadedProbe(() => plan, "abc123"), githubAuthProbe(() => true), boardComputedProbe({ isReady: () => boardDone })], "read-token");
  try {
    const before = await overSocket(socketPath, "/v1/ready");
    assert.equal(before.status, 503);
    const report = JSON.parse(before.body) as { ready: boolean; criteria: Array<{ name: string; ok: boolean; detail?: Record<string, unknown> }> };
    assert.equal(report.ready, false);
    assert.deepEqual(report.criteria.map((c) => [c.name, c.ok]), [["plan_loaded", true], ["github_auth_settled", true], ["board_computed", false]], "every criterion is named");
    assert.deepEqual(report.criteria[0].detail, { tasks: 1, codeSha: "abc123" });
    boardDone = true;
    const after = await overSocket(socketPath, "/v1/ready");
    assert.equal(after.status, 200, "ready once the board is computed");
    assert.equal((JSON.parse(after.body) as { ready: boolean }).ready, true);
    assert.deepEqual(await overSocket(socketPath, "/v1/status"), { status: 200, body: "real route" }, "every other path reaches the real server's routes");
  } finally {
    real.emit("close");
  }
  await new Promise((resolve) => priv.once("close", resolve));
  writeFileSync(socketPath, "left behind by a killed generation");
  const again = await listenReadiness(real, socketPath, () => []);
  assert.equal((await overSocket(socketPath, "/v1/ready")).status, 200, "a stale socket file from a dead generation is replaced");
  again.close();
});

test("an empty plan and an unsettled App mint are not ready", () => {
  const report = readinessReport([planLoadedProbe(() => undefined, "x"), githubAuthProbe(() => false)]);
  assert.equal(report.ready, false);
  assert.deepEqual(report.criteria.map((c) => c.ok), [false, false]);
});

test("the gateway is primed by fresh facts or by one settled warm", () => {
  const probe = (github: Parameters<typeof gatewayPrimedProbe>[0]) => gatewayPrimedProbe(github)(new URLSearchParams());
  assert.equal(probe({}).ok, true, "a gateway that cannot say is not held hostage");
  assert.equal(probe({ factsAgeMs: () => undefined }).ok, false, "no facts held and no warm yet");
  assert.equal(probe({ factsAgeMs: () => 5, factsStale: () => false }).ok, true, "fresh facts from the disk cache");
  assert.equal(probe({ factsAgeMs: () => 5, factsStale: () => true }).ok, false, "stale facts are not primed");
  const warmed = probe({ factsAgeMs: () => 5, factsStale: () => true, warmTelemetry: () => ({ inFlight: false, last: {} as never }) });
  assert.equal(warmed.ok, true, "a settled warm counts even if it failed");
  assert.deepEqual(warmed.detail, { ageMs: 5, stale: true, warmed: true });
});

test("the read model is warm only with its committed bodies and at least as many as the active generation", () => {
  const handle = (size: number, warmBoot?: string) => ({ bodies: new Map(Array.from({ length: size }, (_, i) => [String(i), {} as never])), state: () => ({ instances: new Map(), switches: {} as never, ...(warmBoot ? { warmBoot } : {}) }) });
  const q = (bodies?: number) => new URLSearchParams(bodies === undefined ? "" : `bodies=${bodies}`);
  assert.equal(readModelWarmProbe(undefined)(q()).ok, true, "no read model configured");
  assert.equal(readModelWarmProbe(handle(3))(q(3)).ok, true);
  assert.equal(readModelWarmProbe(handle(2))(q(3)).ok, false, "thinner than the generation it replaces");
  const failed = readModelWarmProbe(handle(0, "db unreadable"))(q(4));
  assert.equal(failed.ok, false, "a failed warm load cannot replace a generation that serves bodies");
  assert.deepEqual(failed.detail, { bodies: 0, wanted: 4, warmBoot: "db unreadable" });
  assert.equal(readModelWarmProbe(handle(0, "no database yet"))(q(0)).ok, true, "a fleet with no read model yet can still hand over");
});

test("the standby role needs both the role and a socket", () => {
  assert.deepEqual(supervisedRole({ RMD_SERVE_ROLE: "standby", RMD_SERVE_READY_SOCKET: "/tmp/g.sock" }), { socketPath: "/tmp/g.sock" });
  assert.equal(supervisedRole({ RMD_SERVE_ROLE: "standby" }), undefined);
  assert.equal(supervisedRole({ RMD_SERVE_READY_SOCKET: "/tmp/g.sock" }), undefined);
  assert.equal(supervisedRole({}), undefined);
});

test("the process channel carries promote and drain from the supervisor and sends upward", async () => {
  assert.equal(processChannel({ send: undefined, on: () => process } as never), undefined, "no IPC means no supervisor");
  const proc = new EventEmitter() as EventEmitter & { send: (m: unknown) => boolean };
  const sent: unknown[] = [];
  proc.send = (m) => (sent.push(m), true);
  const channel = processChannel(proc as never);
  assert.ok(channel);
  channel.send({ type: GENERATION_MESSAGES.promoted });
  assert.deepEqual(sent, [{ type: "rmd.promoted" }]);
  const drains: string[] = [];
  onDrainRequest(channel, (reason) => drains.push(reason));
  let promoted = false;
  const promotion = awaitPromotion(channel).then(() => (promoted = true));
  proc.emit("message", "not an object");
  proc.emit("message", { type: "rmd.unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promoted, false, "only a promote promotes");
  proc.emit("message", { type: GENERATION_MESSAGES.promote } satisfies GenerationMessage);
  await promotion;
  proc.emit("message", { type: GENERATION_MESSAGES.drain, reason: "handoff" });
  proc.emit("message", { type: GENERATION_MESSAGES.drain });
  assert.deepEqual(drains, ["handoff", "handover"]);
});

test("the active generation sheds its caches on request and reports resident bytes", () => {
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const sent: GenerationMessage[] = [];
  const channel = { send: (m: GenerationMessage) => void sent.push(m), onMessage: (l: (m: GenerationMessage) => void) => void listeners.push(l) };
  let shed = 0;
  let collected = 0;
  let rss = 5_000;
  onShedRequest(channel, () => void (shed += 1, (rss = 3_000)), () => rss, () => void (collected += 1));
  for (const l of listeners) l({ type: GENERATION_MESSAGES.drain });
  assert.equal(shed, 0, "only a shed request sheds");
  for (const l of listeners) l({ type: GENERATION_MESSAGES.shed });
  assert.equal(shed, 1);
  assert.equal(collected, 1, "a full collection follows when the runtime exposes one");
  assert.deepEqual(sent, [{ type: "rmd.shed_done", beforeBytes: 5_000, afterBytes: 3_000, heapBeforeBytes: sent[0]?.heapBeforeBytes, heapAfterBytes: sent[0]?.heapAfterBytes, gc: true }]);

  const plain: GenerationMessage[] = [];
  const own: Array<(m: GenerationMessage) => void> = [];
  onShedRequest({ send: (m) => void plain.push(m), onMessage: (l) => void own.push(l) }, () => {}, undefined, undefined);
  for (const l of own) l({ type: GENERATION_MESSAGES.shed });
  assert.equal(plain[0]?.gc, false, "with no exposed collector the reply says so");
  assert.equal(typeof plain[0]?.beforeBytes, "number", "the default reads this process's resident bytes");
});

test("a shed reports the heap its collection freed after the shed ran", () => {
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const sent: GenerationMessage[] = [];
  let heap = 4_000;
  let dropped = false;
  // Resident bytes never move (V8 keeps freed pages); only a collection after the shed shrinks the heap.
  onShedRequest({ send: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) }, () => void (dropped = true), () => 9_000, () => void (heap = dropped ? 1_000 : heap), () => heap);
  for (const l of listeners) l({ type: GENERATION_MESSAGES.shed });
  assert.deepEqual(sent, [{ type: "rmd.shed_done", beforeBytes: 9_000, afterBytes: 9_000, heapBeforeBytes: 4_000, heapAfterBytes: 1_000, gc: true }]);
  const real: GenerationMessage[] = [];
  const own: Array<(m: GenerationMessage) => void> = [];
  onShedRequest({ send: (m) => void real.push(m), onMessage: (l) => void own.push(l) }, () => {});
  for (const l of own) l({ type: GENERATION_MESSAGES.shed });
  assert.equal(typeof real[0]?.heapBeforeBytes, "number", "the default reads this process's V8 heap");
});

test("a restore request re-warms the generation after an abandoned handoff", () => {
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const channel = { send: () => {}, onMessage: (l: (m: GenerationMessage) => void) => void listeners.push(l) };
  const restored: string[] = [];
  onRestoreRequest(channel, (reason) => restored.push(reason));
  for (const l of listeners) l({ type: GENERATION_MESSAGES.shed });
  assert.deepEqual(restored, [], "only a restore request restores");
  for (const l of listeners) l({ type: GENERATION_MESSAGES.restore, reason: "handoff_abandoned" });
  for (const l of listeners) l({ type: GENERATION_MESSAGES.restore });
  assert.deepEqual(restored, ["handoff_abandoned", "restore"]);
});

test("a converged population meets the original standby warm-body floor", async (t) => {
  const root = makeTempDir("converged-standby-floor"), active = join(root, "state"), thin = join(root, "thin"), repository = "craigoley/remudero";
  const workers: Array<ReturnType<typeof createReadModelWorker>> = [];
  t.after(() => { for (const worker of workers) worker.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  for (const stateDir of [active, thin]) {
    mkdirSync(join(stateDir, "read-model"), { recursive: true }); writeFileSync(join(stateDir, "ledger.ndjson"), "");
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { inbox: "auto" } }));
  }
  mkdirSync(join(root, "plan")); writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const registry = join(active, "inbox-proposals.json"), proposals = Array.from({ length: 180 }, (_, i) => ({ id: `ruling:floor-${i}`, summary: `${i} ${"operator context ".repeat(70)}`, evidenceAnchors: [] }));
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath: join(active, "ledger.ndjson"), inboxFromSlowLane: true,
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true };
  writeFileSync(registry, JSON.stringify({ proposals }));
  const first = (await refreshInboxClassification(deps, {}, systemClock)).bodies;
  writeFileSync(registry, JSON.stringify({ proposals: proposals.slice(0, 2) }));
  const shrunk = (await refreshInboxClassification(deps, {}, systemClock)).bodies;
  const instances = [{ name: "core", ledgerDir: active, repo: repository }];
  // The real producer over the real store: it publishes the first population, commits a legitimate shrink whose messages never
  // reach serve, and a replacement producer then republishes the committed population with nothing left to retire.
  const publish = (bodies: Array<typeof first>, stateDir = active) => {
    const messages: ReadModelWorkerMessage[][] = [];
    let into = 0;
    const ticker = createReadModelTicker({ stateDir, instances: [{ ...instances[0]!, ledgerDir: stateDir }], holder: "active-generation", oracle: "off", views: [readModelStatusView], post: message => { (messages[into] ??= []).push(message); } });
    ticker.start(); ticker.tick();
    for (const population of bodies) { ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: population }); into++; }
    ticker.release();
    return messages;
  };
  const script = join(active, "relay.json"), counter = join(active, "spawns"), file = join(active, "relay.mjs");
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const serving = createReadModelWorker({ stateDir: active, instances, workerUrl: pathToFileURL(file), tickMs: 5, stopWaitMs: 50, every: () => () => {}, log: (step, extra) => { logs.push({ step, extra }); } });
  workers.push(serving);
  assert.equal(serving.bodies.size, 0, "the active generation boots before its producer commits anything");
  const [published] = publish([first, shrunk]), [republished] = publish([shrunk]);
  writeFileSync(script, JSON.stringify([published, republished]));
  writeFileSync(file, `import { parentPort } from "node:worker_threads";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const spawn = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1 : 1;
writeFileSync(${JSON.stringify(counter)}, String(spawn));
for (const message of JSON.parse(readFileSync(${JSON.stringify(script)}, "utf8"))[spawn - 1] ?? []) parentPort.postMessage(message);
parentPort.postMessage({ type: "log", step: "fixture.published", extra: { spawn } });
const timer = setInterval(() => {}, 1000);
parentPort.on("message", message => { if (message.type === "stop") { clearInterval(timer); parentPort.close(); } else if (message.type === "shadow") process.exit(1); });
`);
  const until = async (what: string, done: () => boolean) => { const deadline = Date.now() + 30000; while (!done() && Date.now() < deadline) await sleep(20); assert.ok(done(), what); };
  serving.start();
  await until("the active generation's first producer published", () => logs.some(log => log.step === "fixture.published" && log.extra?.spawn === 1));
  const before = serving.bodies.size;
  assert.equal(before, first.length + 1, "positive control: the active generation served the larger first population and its status body");
  serving.shadow({ view: INBOX_VIEW_NAME, key: "section=needsYou", requests: 0 });
  await until("the replacement producer republished", () => logs.some(log => log.step === "fixture.published" && log.extra?.spawn === 2));
  const committed = loadCommittedViewBodies(active, "core");
  assert.equal(serving.qualificationGeneration?.(INBOX_VIEW_NAME), committed.inboxPopulation?.generation, "the active generation qualifies the committed population");
  const q = (bodies: number) => new URLSearchParams(`bodies=${bodies}`), wanted = serving.bodies.size;
  assert.equal(wanted, committed.bodies.length, "the active generation's legitimate shrink converged to its committed body count");
  const standby = createReadModelWorker({ stateDir: active, instances, every: () => () => {} });
  workers.push(standby);
  const report = readModelWarmProbe(standby)(q(wanted));
  assert.deepEqual([report.ok, report.detail], [true, { bodies: wanted, wanted }], "a standby on the same committed population meets the unchanged floor");
  assert.equal(readModelWarmProbe(standby)(q(before)).ok, false, "the unchanged floor still refuses the unconverged count");
  publish([], thin); // a store whose producer committed no Inbox population: only its status body
  const thinner = createReadModelWorker({ stateDir: thin, instances: [{ ...instances[0]!, ledgerDir: thin }], every: () => () => {} });
  workers.push(thinner);
  assert.ok(thinner.bodies.size > 0 && thinner.bodies.size < wanted, "positive control: the thinner standby really warmed some committed bodies");
  assert.equal(readModelWarmProbe(thinner)(q(wanted)).ok, false, "a genuinely thinner standby still refuses");
});
