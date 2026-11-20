/**
 * W1-T13832: after a generation swap, serve reads each served view once, in its own process, and ledgers what it answered.
 * OBSERVED 2026-11-19 on the host: 18 swaps completed after W1-T13602 began serving, and only 3 had a serve.demand row with
 * view answers within 10 minutes, because those rows count only what clients happened to read.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { buildServeServer, serveGeneration, type ServeDeps } from "#src/lib/serve.js";
import { createServeDemand, SERVE_DEMAND_WINDOW_MS } from "#src/lib/serve-demand.js";
import { GENERATION_MESSAGES, onSwapProbeRequest, type GenerationMessage, type SwapProbeRequest } from "#src/lib/serve-generation.js";
import { createServeSupervisor, type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import { heldViewKeys, runSwapProbe, type SwapProbeRow } from "#src/lib/serve-swap-probe.js";
import { withTempDir } from "#src/lib/tmp.js";
import { buildReadModelViewRoutes, viewEtag, viewKey, type ViewBody, type ViewBodyEntry, type ViewProbeReader, type ViewSwitchMode } from "#src/lib/views.js";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
type Row = { step: string; views?: SwapProbeRow["views"]; views_probe?: Record<string, unknown> } & Partial<Omit<SwapProbeRow, "step" | "views">>;

function rows(path: string): Row[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

/**
 * Views as the routes serve them: `held` has a fresh core body and a stale games body and needs ?instance=; `warming`
 * serves with no body yet (404 view_not_ready); `keyed` needs ?id= and holds nothing (no_key); `dark` is off.
 */
function viewWorld(ledgerPath: string, onClient?: (read: () => Promise<number>) => void) {
  const wanted: string[] = [];
  let clock = 0;
  const demand = createServeDemand({ ledgerPath, routes: [], clock: clockFromMillisFn(() => clock) });
  const entries = new Map<string, ViewBodyEntry>();
  for (const [instance, state] of [["games", "stale"], ["core", "fresh"]] as const) {
    const key = viewKey(new URLSearchParams({ instance }));
    const data = { instance };
    const sources = [{ name: "ledger", state, asOf: "2026-11-19T11:59:00.000Z" }] as unknown as ViewBody["sources"];
    const body: ViewBody = { view: "held", version: 1, generatedAt: "2026-11-19T11:59:00.000Z", asOf: "2026-11-19T11:59:00.000Z", stale: false, sources, data };
    entries.set(key, { view: "held", key, version: 1, generation: 1, etag: viewEtag("held", 1, false, data), body });
  }
  let reader: ViewProbeReader | undefined;
  const routes = buildReadModelViewRoutes({
    legacy: [], readModelViews: ["held", "warming", "keyed", "dark", "validated"], clock: fixedClock(NOW), servedByDefault: ["held", "warming", "keyed", "validated"],
    requiredParams: { held: ["instance"], keyed: ["id"] },
    // Like the code-health and daily-progress validators: a cold key is asked for through source.want, then refused 503.
    requestValidators: { validated: (_params, source) => {
      if (source && !source.body("validated", "") && source.judge([], NOW).length === 0 && source.switches()) source.want?.("validated", "");
      return { error: "view_not_ready", status: 503 };
    } },
    readModel: {
      switches: () => ({ views: {} as Record<string, ViewSwitchMode> }),
      body: (view, key) => view === "held" ? entries.get(key ?? "") : undefined,
      judge: (sources) => [...sources],
      want: (view, key) => { wanted.push(`${view}:${key}`); return true; },
    },
    onAnswer: (view, status, code, stale, source) => demand.recordView(view, status, code, stale, undefined, source),
    onProbeReader: (got) => { reader = got; },
  });
  const getHeld = routes.find((route) => route.path === "/v1/views/held")!;
  onClient?.(async () => {
    const res = { statusCode: 0, headersSent: false, writeHead(status: number) { this.statusCode = status; }, end() {}, once() {} };
    getHeld.handler({ url: "/v1/views/held?instance=core", headers: {} } as never, res as never, {} as never);
    await settle();
    return res.statusCode;
  });
  const held = (view: string) => heldViewKeys(entries, view);
  const flushed = (): Row => { clock += SERVE_DEMAND_WINDOW_MS; demand.flush(); return rows(ledgerPath).filter((row) => row.step === "serve.demand").at(-1)!; };
  return { reader: () => reader, held, flushed, wanted };
}

/** A supervisor over fake generations; every message each one is sent is kept, and a generation can die on its own. */
function swapRig(refuseProbe = false) {
  const sent: GenerationMessage[][] = [];
  const exits: Array<(code: number | null, signal: string | null) => void>[] = [];
  const slots = new Map<string, PreparedSlot>();
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    const slot = JSON.parse(command.args[0]!) as PreparedSlot;
    slots.set(env.RMD_SERVE_READY_SOCKET!, slot);
    const index = sent.length;
    const messages: GenerationMessage[] = [];
    const onMessage: Array<(m: GenerationMessage) => void> = [];
    const onExit: Array<(c: number | null, s: string | null) => void> = [];
    sent.push(messages); exits.push(onExit);
    const generation: GenerationProcess = {
      pid: index + 1,
      send(message) {
        if (refuseProbe && message.type === GENERATION_MESSAGES.swapProbe) throw new Error("channel closed");
        messages.push(message);
        if (message.type === GENERATION_MESSAGES.promote) queueMicrotask(() => onMessage.forEach((l) => l({ type: GENERATION_MESSAGES.promoted })));
        if (message.type === GENERATION_MESSAGES.drain) queueMicrotask(() => onExit.forEach((l) => l(0, null)));
      },
      onMessage: (l) => void onMessage.push(l),
      onExit: (l) => void onExit.push(l),
      kill: () => onExit.forEach((l) => l(null, "SIGKILL")),
    };
    return generation;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: slots.get(socketPath)!.sha }) };
    if (path.startsWith("/v1/ready")) return { status: 200, body: JSON.stringify({ ready: true, criteria: [] }) };
    return { status: 200, body: "{}" };
  };
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const state = { now: 0 };
  let sha = 1;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn, get,
    command: (slot: PreparedSlot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, extra) => void logs.push({ step, extra }),
    exit: () => {},
    clock: { now: () => state.now, iso: () => "" } as never,
    sleep: async (ms) => void (state.now += ms),
    freeMemory: () => undefined, rss: () => undefined, peakRss: () => 1_000,
    hostPressure: async () => ({ atMs: state.now, memAvailableBytes: 2 ** 40, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] }),
    upgradeThresholds: () => ({ hostReserveBytes: 0, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    socketPathFor: (n) => `/sock/${n}`,
  });
  const probes = (index: number) => sent[index]!.filter((m) => m.type === GENERATION_MESSAGES.swapProbe);
  const crash = (index: number) => exits[index]!.forEach((l) => l(1, null));
  return { supervisor, sent, probes, crash, logs, steps: () => logs.map((l) => l.step) };
}

/** Hands each swap probe message to the generation's real channel handler, which runs the probe over `world`. */
async function probeFromMessage(message: GenerationMessage, opts: Omit<Parameters<typeof runSwapProbe>[1], "seen"> & { seen?: Set<string> }) {
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const runs: Promise<SwapProbeRow | undefined>[] = [];
  onSwapProbeRequest({ send() {}, onMessage: (l) => void listeners.push(l) }, (request: SwapProbeRequest) => void runs.push(runSwapProbe(request, { seen: new Set(), ...opts })));
  listeners.forEach((l) => l(message));
  assert.equal(runs.length, 1, "the generation's channel ran one probe");
  return runs[0]!;
}

test("W1-T13832 criterion 1: a completed swap writes one serve.swap_probe row with the sha, the generation, the trigger and each served view's status, code and stale", async () => {
  await withTempDir("swap-probe-row", async (root) => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const world = viewWorld(ledgerPath);
    const rig = swapRig();
    await rig.supervisor.start();
    assert.deepEqual(rig.probes(0).map((m) => m.trigger), ["cold_start"], "the cold start asks its generation for one probe");
    await rig.supervisor.requestHandoff();
    await settle();
    assert.ok(rig.steps().includes("serve.handoff_done"), rig.steps().join(", "));
    const [message, ...more] = rig.probes(1);
    assert.equal(more.length, 0, "one probe per swap");
    assert.deepEqual({ ...message }, { type: "rmd.swap_probe", trigger: "handoff", generation: 2, sha: "sha-2", fromSha: "sha-1" });
    const row = await probeFromMessage(message!, { reader: world.reader(), heldKeys: world.held, ledgerPath });
    const written = rows(ledgerPath).filter((r) => r.step === "serve.swap_probe").map(({ ts: _ts, host: _host, actor_pid: _pid, actor: _actor, ...rest }: Row & Record<string, unknown>) => rest);
    assert.deepEqual(written, [row], "the row is in the ledger");
    assert.equal(row?.trigger, "handoff");
    assert.equal(row?.generation, 2);
    assert.equal(row?.sha, "sha-2");
    assert.equal(row?.fromSha, "sha-1");
    assert.equal(row?.probe_failed, undefined);
    assert.deepEqual(row?.views, {
      held: { key: "instance=games", status: 200, code: "ok", stale: true },
      warming: { key: "", status: 404, code: "view_not_ready", stale: false },
      keyed: { key: null, code: "no_key" },
      validated: { key: "", status: 503, code: "view_not_ready", stale: false },
    }, "each served view once, the off view not at all");
    assert.deepEqual(world.wanted, [], "a probe read never asks the demand book for a key, through a validator or otherwise");
  });
});

test("W1-T13832 criterion 2: probe answers are counted in the window's views_probe section and never in its client views section", async () => {
  await withTempDir("swap-probe-tally", async (root) => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    let client: (() => Promise<number>) | undefined;
    const world = viewWorld(ledgerPath, (read) => { client = read; });
    await runSwapProbe({ trigger: "handoff", generation: 2, sha: "sha-2" }, { reader: world.reader(), heldKeys: world.held, ledgerPath, seen: new Set() });
    const probeOnly = world.flushed();
    assert.equal(Object.hasOwn(probeOnly, "views"), false, "no client read, so no client views section");
    assert.deepEqual(probeOnly.views_probe, {
      held: { n: 1, stale: 1, codes: { "200 ok": 1 } },
      warming: { n: 1, stale: 0, codes: { "404 view_not_ready": 1 } },
      validated: { n: 1, stale: 0, codes: { "503 view_not_ready": 1 } },
    });
    assert.deepEqual(world.wanted, [], "the probe added or refreshed no demand key");
    assert.equal(await client!(), 200);
    const clientOnly = world.flushed();
    assert.deepEqual(clientOnly.views, { held: { n: 1, stale: 0, codes: { "200 ok": 1 } } });
    assert.equal(Object.hasOwn(clientOnly, "views_probe"), false);
  });
});

test("serve's generation hook runs the probe through its own view routes and counts it apart from client reads", async () => {
  await withTempDir("swap-probe-serve", async (root) => {
    mkdirSync(join(root, "state"));
    const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan.yaml");
    writeFileSync(ledgerPath, ""); writeFileSync(planPath, "[]\n");
    let clock = 0, tick: (() => void) | undefined;
    const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const deps: ServeDeps = {
      ledgerPath, fleetControlRoot: root, questionsRoot: root,
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
      issues: { close() {} }, tokens: { read: "r", write: "w" },
      consoleSha: "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa", gatewayCheckout: async () => ({ state: "clean" }) as never,
      githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
      assistantRepository: "craigoley/remudero",
      demand: { clock: clockFromMillisFn(() => clock), every: (fn) => { tick = fn; return () => {}; } },
    };
    const server = buildServeServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const hooks = serveGeneration(server);
      assert.ok(hooks, "a built serve server has generation hooks");
      hooks.swapProbe({ trigger: "cold_start", generation: 1, sha: "aaaaaaaa" });
      hooks.swapProbe({ trigger: "cold_start", generation: 1, sha: "aaaaaaaa" });
      await settle();
      const probes = rows(ledgerPath).filter((r) => r.step === "serve.swap_probe");
      assert.equal(probes.length, 1, "a repeated request for the same generation and trigger is ignored");
      const views = probes[0]!.views!;
      assert.ok(Object.keys(views).length > 0, "the served-by-default views were probed");
      for (const result of Object.values(views)) assert.ok(typeof result.code === "string");
      clock = SERVE_DEMAND_WINDOW_MS; tick!();
      const window = rows(ledgerPath).find((r) => r.step === "serve.demand");
      assert.ok(window?.views_probe, "the probe's reads reached the demand window");
      assert.equal(Object.hasOwn(window, "views"), false, "and none of them counted as a client read");
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

test("W1-T13832 criterion 3: invariant:probe-never-blocks-the-swap — a probe that throws or passes its time bound leaves the swap done and writes serve.swap_probe with a probe_failed reason", async () => {
  await withTempDir("swap-probe-failed", async (root) => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const world = viewWorld(ledgerPath);
    const rig = swapRig();
    await rig.supervisor.start();
    await rig.supervisor.requestHandoff();
    await settle();
    assert.ok(rig.steps().includes("serve.handoff_done"));
    assert.equal(rig.supervisor.activeSha(), "sha-2", "the swap is done whatever the probe does");
    const base = world.reader()!;
    const throwing: ViewProbeReader = { ...base, read: async () => { throw new Error("body store closed"); } };
    const thrown = await probeFromMessage(rig.probes(1)[0]!, { reader: throwing, heldKeys: world.held, ledgerPath });
    assert.equal(thrown?.probe_failed, "threw: body store closed");
    const stuck: ViewProbeReader = { ...base, read: (name, params) => name === "warming" ? new Promise(() => {}) : base.read(name, params) };
    const timedOut = await runSwapProbe({ trigger: "handoff", generation: 3, sha: "sha-3" }, { reader: stuck, heldKeys: world.held, ledgerPath, seen: new Set(), timeoutMs: 20 });
    assert.equal(timedOut?.probe_failed, "timeout after 20 ms");
    assert.deepEqual(timedOut?.views.held, { key: "instance=games", status: 200, code: "ok", stale: true }, "the views it had read are kept");
    let now = 0;
    const blocking: ViewProbeReader = { ...base, read: async (name, params) => { now += 46; return base.read(name, params); } };
    const slow = await runSwapProbe({ trigger: "handoff", generation: 4, sha: "sha-4" }, { reader: blocking, heldKeys: world.held, ledgerPath, seen: new Set(), timeoutMs: 10, clock: clockFromMillisFn(() => now) });
    assert.equal(slow?.probe_failed, "timeout after 10 ms", "a read that blocks past the bound before any timer can fire is still a timeout");
    assert.deepEqual(rows(ledgerPath).filter((r) => r.step === "serve.swap_probe").map((r) => r.probe_failed), ["threw: body store closed", "timeout after 20 ms", "timeout after 10 ms"]);
    const directory = join(root, "not-a-file");
    mkdirSync(directory);
    const throwingLog = await runSwapProbe({ trigger: "handoff", generation: 5, sha: "sha-5" }, { reader: base, heldKeys: world.held, ledgerPath: directory, seen: new Set(),
      log: () => { throw new Error("the logger shares the ledger"); } });
    assert.ok(throwingLog, "a ledger write failure whose logger also throws still resolves, so the fire-and-forget hook never rejects");

    const refused = swapRig(true);
    await refused.supervisor.start();
    await refused.supervisor.requestHandoff();
    await settle();
    assert.ok(refused.steps().includes("serve.handoff_done"), "a probe request that cannot be sent never undoes the swap");
    assert.equal(refused.supervisor.activeSha(), "sha-2");
    assert.deepEqual(refused.logs.filter((l) => l.step === "serve.swap_probe_unsent").map((l) => l.extra?.trigger), ["cold_start", "handoff"]);
  });
});

test("a probe whose view list throws, or whose ledger cannot be written, still returns its row and says why", async () => {
  await withTempDir("swap-probe-edges", async (root) => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const world = viewWorld(ledgerPath);
    const base = world.reader()!;
    const broken: ViewProbeReader = { ...base, mode: () => { throw new Error("switches unreadable"); } };
    const thrown = await runSwapProbe({ trigger: "cold_start", generation: 1, sha: "sha-1" }, { reader: broken, heldKeys: world.held, ledgerPath, seen: new Set() });
    assert.equal(thrown?.probe_failed, "threw: switches unreadable");
    assert.deepEqual(thrown?.views, {});
    const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const unwritable = join(root, "a-directory");
    mkdirSync(unwritable);
    const row = await runSwapProbe({ trigger: "handoff", generation: 2, sha: "sha-2" }, { reader: base, heldKeys: world.held, ledgerPath: unwritable, seen: new Set(), log: (step, extra) => void logged.push({ step, extra }) });
    assert.equal(row?.views.held?.status, 200, "the row is still returned");
    assert.deepEqual(logged.map((entry) => [entry.step, entry.extra.trigger, entry.extra.generation]), [["serve.swap_probe_write_failed", "handoff", 2]]);
    assert.match(String(logged[0]?.extra.reason), /EISDIR|directory/i);
  });
});

test("W1-T13832 criterion 5: a crash restart's replacement generation runs the swap probe and its serve.swap_probe row says trigger crash_restart", async () => {
  await withTempDir("swap-probe-crash", async (root) => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const world = viewWorld(ledgerPath);
    const rig = swapRig();
    await rig.supervisor.start();
    rig.crash(0);
    await settle();
    assert.ok(rig.steps().includes("serve.generation_crashed"), rig.steps().join(", "));
    assert.equal(rig.sent.length, 2, "the crash forked one replacement");
    const [message, ...more] = rig.probes(1);
    assert.equal(more.length, 0);
    assert.deepEqual({ ...message }, { type: "rmd.swap_probe", trigger: "crash_restart", generation: 2, sha: "sha-1", fromSha: "sha-1" });
    const row = await probeFromMessage(message!, { reader: world.reader(), heldKeys: world.held, ledgerPath });
    assert.equal(row?.trigger, "crash_restart");
    assert.equal(rows(ledgerPath).filter((r) => r.step === "serve.swap_probe")[0]?.trigger, "crash_restart");
  });
});
