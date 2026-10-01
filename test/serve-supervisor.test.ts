/**
 * src/lib/serve-supervisor.ts (arch-phase3-design.md §1(c), P3-04). The swap tests run REAL cluster
 * generations (test/helpers/supervised-generation.ts) on one shared listening handle under load; the
 * decision tests drive the state machine with fake generations.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { Agent, request, createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cgroupFreeMemory,
  clusterSpawn,
  createServeSupervisor,
  generationCommand,
  handoffSwitch,
  procRss,
  socketGet,
  type GenerationProcess,
  type PreparedSlot,
  type ServeSupervisorOptions,
} from "../src/lib/serve-supervisor.js";
import type { GenerationMessage } from "../src/lib/serve-generation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── fakes for the decision tests ────────────────────────────────────────────────────────────────

interface FakeGeneration extends GenerationProcess {
  sent: GenerationMessage[];
  killed: string[];
  emit(message: GenerationMessage): void;
  die(code: number | null, signal?: string | null): void;
  slot: PreparedSlot;
}

function fakeFleet(behaviour: (slot: PreparedSlot) => { readyAfter?: number; never?: boolean; sha?: string; noPromote?: boolean; smoke503?: boolean; deaf?: boolean } = () => ({})) {
  const generations: FakeGeneration[] = [];
  const bySocket = new Map<string, { gen: FakeGeneration; polls: number }>();
  let n = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    const messageListeners: Array<(m: GenerationMessage) => void> = [];
    const exitListeners: Array<(c: number | null, s: string | null) => void> = [];
    let dead = false;
    const gen: FakeGeneration = {
      pid: ++n,
      slot,
      sent: [],
      killed: [],
      send(message) {
        gen.sent.push(message);
        if (message.type === "rmd.promote" && !behaviour(slot).noPromote) queueMicrotask(() => gen.emit({ type: "rmd.promoted" }));
        if (message.type === "rmd.drain") queueMicrotask(() => gen.die(0));
      },
      onMessage: (l) => void messageListeners.push(l),
      onExit: (l) => void exitListeners.push(l),
      kill(signal) {
        gen.killed.push(signal);
        gen.die(null, signal);
      },
      emit: (m) => messageListeners.forEach((l) => l(m)),
      die(code, signal = null) {
        if (dead) return;
        dead = true;
        exitListeners.forEach((l) => l(code, signal));
      },
    };
    generations.push(gen);
    bySocket.set(env.RMD_SERVE_READY_SOCKET, { gen, polls: 0 });
    return gen;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    const entry = bySocket.get(socketPath);
    if (!entry) throw new Error("no such socket");
    const b = behaviour(entry.gen.slot);
    if (b.deaf) throw new Error("ECONNREFUSED");
    if (path === "/v1/status" && b.smoke503) return { status: 503, body: "{}" };
    if (path.startsWith("/v1/ready")) {
      entry.polls += 1;
      const ready = !b.never && entry.polls > (b.readyAfter ?? 0);
      if (b.never) return { status: 503, body: "warming up" };
      return { status: ready ? 200 : 503, body: JSON.stringify({ ready, criteria: [{ name: "read_model_warm", ok: true, detail: { bodies: 7 } }, { name: "board_computed", ok: ready }] }) };
    }
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: b.sha ?? entry.gen.slot.sha }) };
    return { status: 200, body: "{}" };
  };
  return { generations, spawn, get, command: (slot: PreparedSlot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }) };
}

function decisionSupervisor(fleet: ReturnType<typeof fakeFleet>, extra: Partial<ServeSupervisorOptions> = {}) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exits: number[] = [];
  let sha = 1;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn: fleet.spawn,
    get: fleet.get,
    command: fleet.command,
    log: (step, extra) => logs.push({ step, extra }),
    exit: (code) => exits.push(code),
    sleep: async () => {},
    freeMemory: () => undefined,
    rss: () => undefined,
    socketPathFor: (n) => `/sock/${n}`,
    ...extra,
  });
  return { supervisor, logs, exits, steps: () => logs.map((l) => l.step) };
}

test("supervisor promotes the standby only after readiness passes", async () => {
  const fleet = fakeFleet((slot) => ({ readyAfter: slot.sha === "sha-2" ? 3 : 0 }));
  const { supervisor, logs } = decisionSupervisor(fleet);
  await supervisor.start();
  const [cold] = fleet.generations;
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote"]);
  await supervisor.requestHandoff();
  const standby = fleet.generations[1];
  assert.deepEqual(standby.sent.map((m) => m.type), ["rmd.promote"], "promoted once, after three not-ready polls");
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote", "rmd.drain"], "the old generation is drained only after the new one is promoted");
  assert.equal(supervisor.activeSha(), "sha-2");
  const done = logs.find((l) => l.step === "serve.handoff_done");
  assert.equal(done?.extra?.fromSha, "sha-1");
  assert.equal(done?.extra?.toSha, "sha-2");
});

test("a standby failing readiness is killed and the active generation keeps serving (decision)", async () => {
  const fleet = fakeFleet((slot) => (slot.sha === "sha-2" ? { never: true } : slot.sha === "sha-3" ? { sha: "wrong" } : {}));
  let now = 0;
  const { supervisor, logs } = decisionSupervisor(fleet, { clock: { now: () => (now += 1_000), iso: () => "" } as never, readyBoundMs: 5_000 });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.deepEqual(fleet.generations[1].killed, ["SIGKILL"]);
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.equal(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.criterion, "ready_bound");
  assert.equal(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.detail, "warming up", "a non-JSON readiness body is ledgered as text");
  await supervisor.requestHandoff();
  assert.equal(logs.filter((l) => l.step === "serve.handoff_aborted")[1]?.extra?.criterion, "smoke /v1/version", "a build reporting the wrong sha never serves");
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(fleet.generations[0].sent.map((m) => m.type), ["rmd.promote"], "the active generation was never drained");
});

test("handoff off turns a handoff request into exit 0", async () => {
  const fleet = fakeFleet();
  let enabled = true;
  const { supervisor, exits, steps } = decisionSupervisor(fleet, { handoffEnabled: () => enabled });
  await supervisor.start();
  enabled = false;
  fleet.generations[0].emit({ type: "rmd.handoff_request" });
  await tick(0);
  await supervisor.requestHandoff();
  assert.deepEqual(exits, [0], "the supervisor exits so docker restarts the container, today's behaviour");
  assert.deepEqual(fleet.generations[0].sent.map((m) => m.type), ["rmd.promote", "rmd.drain"], "after draining the active generation");
  assert.ok(steps().includes("serve.handoff_legacy_exit"));
  assert.equal(fleet.generations.length, 1, "no standby was forked");
  await supervisor.requestHandoff();
  assert.deepEqual(exits, [0], "and nothing after it");
});

test("insufficient cgroup headroom defers the handoff and ledgers the reason", async () => {
  const fleet = fakeFleet();
  const { supervisor, logs, exits } = decisionSupervisor(fleet, { freeMemory: () => 1_000, rss: () => 5_000, deferMs: 1 });
  await supervisor.start();
  await supervisor.requestHandoff();
  const deferred = logs.filter((l) => l.step === "serve.handoff_deferred");
  assert.ok(deferred.length >= 1);
  assert.deepEqual({ reason: deferred[0].extra?.reason, freeBytes: deferred[0].extra?.freeBytes, needBytes: deferred[0].extra?.needBytes }, { reason: "memory", freeBytes: 1_000, needBytes: 5_000 });
  for (let i = 0; i < 20 && exits.length === 0; i += 1) await tick(5);
  assert.equal(fleet.generations.length, 1, "no standby is forked while headroom is short");
  assert.deepEqual(exits, [0], "repeated deferrals fall back to today's restart rather than never recycling");
  assert.equal(logs.filter((l) => l.step === "serve.handoff_deferred").length, 3);
  assert.equal(logs.find((l) => l.step === "serve.handoff_shed")?.extra?.answered, false, "a generation that never answers the shed is waited out by its backstop");
});

test("a memory-short handoff asks the active generation to shed before it defers", async () => {
  const fleet = fakeFleet();
  const shedAsked = (): boolean => fleet.generations[0]?.sent.some((m) => m.type === "rmd.shed") ?? false;
  const { supervisor, logs } = decisionSupervisor(fleet, {
    freeMemory: () => (shedAsked() ? 9_000 : 1_000),
    rss: () => 5_000,
    shedBackstopMs: 123,
    sleep: (ms) => (ms === 123 ? new Promise<void>(() => {}) : Promise.resolve()),
  });
  await supervisor.start();
  const cold = fleet.generations[0];
  const send = cold.send.bind(cold);
  cold.send = (message) => {
    send(message);
    if (message.type === "rmd.shed") queueMicrotask(() => cold.emit({ type: "rmd.shed_done", beforeBytes: 5_000, afterBytes: 3_000 }));
  };
  await supervisor.requestHandoff();
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote", "rmd.shed", "rmd.drain"], "tier 1 runs before the standby is forked");
  const shed = logs.find((l) => l.step === "serve.handoff_shed")?.extra;
  assert.deepEqual(
    { answered: shed?.answered, beforeBytes: shed?.beforeBytes, afterBytes: shed?.afterBytes, freeBefore: shed?.freeBefore, freeAfter: shed?.freeAfter, needBytes: shed?.needBytes },
    { answered: true, beforeBytes: 5_000, afterBytes: 3_000, freeBefore: 1_000, freeAfter: 9_000, needBytes: 5_000 },
  );
  assert.equal(logs.some((l) => l.step === "serve.handoff_deferred"), false, "the shed freed enough, so nothing defers");
  assert.equal(supervisor.activeSha(), "sha-2", "the handoff went ahead");
});

test("handoff requests coalesce, and only the active generation can ask", async () => {
  const fleet = fakeFleet();
  let releasePrepare: () => void = () => {};
  let prepares = 0;
  const { supervisor, steps } = decisionSupervisor(fleet, {
    prepare: async () => {
      prepares += 1;
      if (prepares === 1) await new Promise<void>((resolve) => (releasePrepare = resolve));
      return { dir: `/slot-${prepares}`, sha: `sha-${prepares + 1}` };
    },
  });
  await supervisor.start();
  const first = supervisor.requestHandoff();
  void supervisor.requestHandoff();
  void supervisor.requestHandoff();
  releasePrepare();
  await first;
  for (let i = 0; i < 20 && prepares < 2; i += 1) await tick(1);
  await tick(5);
  assert.equal(prepares, 2, "three requests during one handoff become exactly one more");
  const old = fleet.generations[0];
  old.emit({ type: "rmd.handoff_request" });
  await tick(5);
  assert.equal(prepares, 2, "a drained generation's request is ignored");
  assert.ok(steps().filter((s) => s === "serve.handoff_done").length >= 1);
});

test("prepare failures and an unchanged sha abort or skip without touching the active generation", async () => {
  const fleet = fakeFleet();
  let calls = 0;
  const { supervisor, steps, logs } = decisionSupervisor(fleet, {
    prepare: async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return { dir: "/slot-a", sha: "sha-1" };
    },
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.reason, "fetch failed");
  await supervisor.requestHandoff();
  assert.equal(logs.find((l) => l.step === "serve.handoff_skipped")?.extra?.reason, "already_serving");
  assert.equal(fleet.generations.length, 1);
  assert.ok(!steps().includes("serve.handoff_done"));
});

test("a promoted generation that crashes is replaced from the previous slot and its sha is not retried", async () => {
  const fleet = fakeFleet();
  let target = "sha-2";
  const { supervisor, logs } = decisionSupervisor(fleet, { prepare: async () => ({ dir: "/slot-a", sha: target }) });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(supervisor.activeSha(), "sha-2");
  fleet.generations[1].die(1);
  for (let i = 0; i < 20 && supervisor.activeSha() !== "sha-1"; i += 1) await tick(1);
  assert.equal(supervisor.activeSha(), "sha-1", "rolled back to the last known good build");
  assert.equal(logs.find((l) => l.step === "serve.handoff_rolled_back")?.extra?.sha, "sha-2");
  await supervisor.requestHandoff();
  assert.equal(logs.find((l) => l.step === "serve.handoff_skipped")?.extra?.reason, "failed_before");
  fleet.generations.at(-1)?.die(1);
  for (let i = 0; i < 20 && logs.filter((l) => l.step === "serve.generation_crashed").length === 0; i += 1) await tick(1);
  await tick(5);
  assert.equal(supervisor.activeSha(), "sha-1", "a crash with no other build to fall back to restarts the same one");
  target = "sha-3";
});

test("a cold start whose smoke read answers 503 is promoted degraded and the supervisor never exits", async () => {
  let smoke503 = true;
  const fleet = fakeFleet((slot) => ({ smoke503: slot.sha === "sha-1" && smoke503 }));
  const { supervisor, logs, exits } = decisionSupervisor(fleet, { sleep: () => tick(1) });
  await supervisor.start();
  assert.deepEqual(exits, [], "nothing else serves 4317, so a warming generation is never a reason to exit");
  assert.deepEqual(fleet.generations[0].sent.map((m) => m.type), ["rmd.promote"], "the only generation was promoted");
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(logs.find((l) => l.step === "serve.cold_start_degraded")?.extra?.unmet, ["smoke /v1/status"]);
  smoke503 = false;
  for (let i = 0; i < 50 && !logs.some((l) => l.step === "serve.cold_start_ready"); i += 1) await tick(2);
  assert.equal(logs.find((l) => l.step === "serve.cold_start_ready")?.extra?.sha, "sha-1", "the ledger says when it stopped serving 503s");
  assert.equal(logs.some((l) => l.step === "serve.cold_start_failed"), false);
});

test("a cold start with board_computed false past the ready bound is promoted and the supervisor never exits", async () => {
  let mode: "board" | "deaf" | "never" | "ready" = "board";
  const fleet = fakeFleet(() => (mode === "board" ? { readyAfter: 1_000_000 } : mode === "deaf" ? { deaf: true } : mode === "never" ? { never: true } : {}));
  let now = 0;
  const { supervisor, logs, exits } = decisionSupervisor(fleet, { clock: { now: () => (now += 10_000), iso: () => "" } as never, readyBoundMs: 1, sleep: () => tick(1) });
  await supervisor.start();
  assert.deepEqual(exits, []);
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(logs.find((l) => l.step === "serve.cold_start_degraded")?.extra?.unmet, ["board_computed"]);
  for (const next of ["deaf", "never", "ready"] as const) {
    await tick(10);
    mode = next;
  }
  for (let i = 0; i < 50 && !logs.some((l) => l.step === "serve.cold_start_ready"); i += 1) await tick(2);
  assert.ok(logs.some((l) => l.step === "serve.cold_start_ready"), "a refused or non-JSON readiness read keeps it degraded, not failed");
  assert.deepEqual(exits, []);
  await supervisor.shutdown("test");
});

test("a cold generation that asked for a handoff while standby gets it once promoted", async () => {
  const fleet = fakeFleet();
  const get = fleet.get;
  let asked = false;
  fleet.get = async (socketPath, path) => {
    if (!asked && socketPath === "/sock/1") (asked = true), fleet.generations[0].emit({ type: "rmd.handoff_request" });
    return get?.(socketPath, path) ?? { status: 0, body: "" };
  };
  const { supervisor, logs } = decisionSupervisor(fleet);
  await supervisor.start();
  for (let i = 0; i < 50 && supervisor.activeSha() !== "sha-2"; i += 1) await tick(1);
  assert.equal(supervisor.activeSha(), "sha-2", "the ask made before promotion was replayed, not dropped");
  assert.ok(logs.some((l) => l.step === "serve.handoff_done"));
});

test("a handoff whose standby smoke read answers 503 is still aborted and the old generation keeps serving", async () => {
  const fleet = fakeFleet((slot) => ({ smoke503: slot.sha === "sha-2" }));
  const { supervisor, logs } = decisionSupervisor(fleet);
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.criterion, "smoke /v1/status");
  assert.deepEqual(fleet.generations[1].killed, ["SIGKILL"], "the standby never served");
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(fleet.generations[0].sent.map((m) => m.type), ["rmd.promote"], "the serving generation was never drained");
});

test("a rollback to the previous slot is promoted even while its smoke read answers 503", async () => {
  let rolledBack = false;
  const fleet = fakeFleet((slot) => ({ smoke503: slot.sha === "sha-1" && rolledBack }));
  const { supervisor, logs, exits } = decisionSupervisor(fleet, { sleep: () => tick(1) });
  await supervisor.start();
  await supervisor.requestHandoff();
  rolledBack = true;
  fleet.generations[1].die(1);
  for (let i = 0; i < 50 && supervisor.activeSha() !== "sha-1"; i += 1) await tick(1);
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(exits, []);
  assert.deepEqual(logs.find((l) => l.step === "serve.cold_start_degraded")?.extra?.unmet, ["smoke /v1/status"]);
  await supervisor.shutdown("test");
});

test("a cold start that never listens exits 1, and a failed restart falls back to a container restart", async () => {
  const fleet = fakeFleet(() => ({ deaf: true }));
  let now = 0;
  const { supervisor, exits, logs } = decisionSupervisor(fleet, { clock: { now: () => (now += 10_000), iso: () => "" } as never, readyBoundMs: 1 });
  await supervisor.start();
  assert.deepEqual(exits, [1]);
  assert.equal(logs.find((l) => l.step === "serve.cold_start_failed")?.extra?.criterion, "listen_bound");

  const dying = fakeFleet(() => ({ deaf: true }));
  const died = decisionSupervisor(dying, { sleep: async () => dying.generations[0]?.die(1) });
  await died.supervisor.start();
  assert.equal(died.logs.find((l) => l.step === "serve.cold_start_failed")?.extra?.criterion, "exited");

  const mute = fakeFleet(() => ({ noPromote: true }));
  const unpromoted = decisionSupervisor(mute);
  const starting = unpromoted.supervisor.start();
  await tick(1);
  mute.generations[0].die(1);
  await starting;
  assert.equal(unpromoted.logs.find((l) => l.step === "serve.cold_start_failed")?.extra?.criterion, "promote");

  let broken = false;
  const flaky = fakeFleet(() => (broken ? { noPromote: true } : {}));
  const second = decisionSupervisor(flaky);
  await second.supervisor.start();
  broken = true;
  flaky.generations[0].die(1);
  for (let i = 0; i < 50 && second.exits.length === 0; i += 1) await tick(1);
  flaky.generations[1]?.die(1);
  for (let i = 0; i < 50 && second.exits.length === 0; i += 1) await tick(1);
  assert.deepEqual(second.exits, [0]);
  assert.ok(second.steps().includes("serve.generation_restart_failed"));
});

// ── the real swap: cluster generations on one shared handle, under load ─────────────────────────

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Reply {
  status?: number;
  sha?: string;
  error?: string;
}

function hit(port: number, agent: Agent | false, method: string): Promise<Reply> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/v1/x", method, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, sha: String(res.headers["x-sha"]) }));
      res.on("error", (e) => resolve({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    });
    req.on("error", (e) => resolve({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

function startLoad(port: number) {
  let running = true;
  const errors: Record<string, number> = {};
  const bySha: Record<string, number> = {};
  let posts = 0;
  const loop = async (agent: Agent | false, method: string, thinkMs: number): Promise<void> => {
    while (running) {
      if (thinkMs) await tick(thinkMs);
      const reply = await hit(port, agent, method);
      if (reply.status === 200 && reply.sha) {
        bySha[reply.sha] = (bySha[reply.sha] ?? 0) + 1;
        if (method === "POST") posts += 1;
      } else errors[`${method}:${reply.error ?? reply.status}`] = (errors[`${method}:${reply.error ?? reply.status}`] ?? 0) + 1;
    }
    if (agent) agent.destroy();
  };
  const ka = () => new Agent({ keepAlive: true, maxSockets: 1 });
  const loops = [
    ...Array.from({ length: 8 }, () => loop(ka(), "GET", 0)),
    ...Array.from({ length: 4 }, () => loop(ka(), "POST", 0)),
    ...Array.from({ length: 8 }, (_, i) => loop(ka(), i % 2 ? "POST" : "GET", 3 + (i % 5))),
    ...Array.from({ length: 4 }, () => loop(false, "GET", 0)),
  ];
  return {
    stop: async () => {
      running = false;
      await Promise.all(loops);
      return { errors, bySha, posts };
    },
  };
}

function realSupervisor(port: number, modes: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sup-`));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exits: number[] = [];
  let n = 1;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: REPO_ROOT, sha: "sha-1" },
    prepare: async () => ({ dir: REPO_ROOT, sha: `sha-${++n}` }),
    command: (slot) => ({ exec: join(REPO_ROOT, "test/helpers/supervised-generation.ts"), execArgv: ["--import", "tsx"], args: [String(port), slot.sha, modes[slot.sha] ?? "ok"], cwd: REPO_ROOT }),
    socketPathFor: (g) => join(dir, `g${g}.sock`),
    log: (step, extra) => logs.push({ step, extra }),
    exit: (code) => exits.push(code),
    pollMs: 50,
    readyBoundMs: 4_000,
  });
  return { supervisor, logs, exits };
}

test("zero connection errors across three supervised swaps under load", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const { supervisor, logs, exits } = realSupervisor(port, {});
  await supervisor.start();
  const load = startLoad(port);
  for (let i = 0; i < 3; i += 1) {
    await tick(300);
    await supervisor.requestHandoff();
  }
  await tick(300);
  const { errors, bySha, posts } = await load.stop();
  await supervisor.shutdown("test");
  assert.deepEqual(exits, [0]);
  assert.deepEqual(errors, {}, "no request was refused or reset across three swaps");
  assert.ok(posts > 50, `POSTs really ran across the swaps (${posts})`);
  for (const sha of ["sha-1", "sha-2", "sha-3", "sha-4"]) assert.ok((bySha[sha] ?? 0) > 0, `${sha} served: ${JSON.stringify(bySha)}`);
  assert.equal(logs.filter((l) => l.step === "serve.handoff_done").length, 3);
});

test("a standby failing readiness is killed and the active generation keeps serving", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const { supervisor, logs } = realSupervisor(port, { "sha-2": "never-ready", "sha-3": "wrong-sha" });
  await supervisor.start();
  const load = startLoad(port);
  await supervisor.requestHandoff();
  await supervisor.requestHandoff();
  await tick(200);
  const { errors, bySha } = await load.stop();
  assert.deepEqual(errors, {}, "the active generation served throughout");
  assert.deepEqual(Object.keys(bySha), ["sha-1"], "a standby that never passed readiness never served a request");
  assert.deepEqual(logs.filter((l) => l.step === "serve.handoff_aborted").map((l) => l.extra?.criterion), ["ready_bound", "smoke /v1/version"]);
  assert.equal(supervisor.activeSha(), "sha-1");
  await supervisor.shutdown("test");
});

test("a generation that crashes after promote is rolled back to the previous build", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const { supervisor, logs } = realSupervisor(port, { "sha-2": "crash-after-promote" });
  await supervisor.start();
  await supervisor.requestHandoff();
  for (let i = 0; i < 200 && !logs.some((l) => l.step === "serve.handoff_rolled_back"); i += 1) await tick(25);
  for (let i = 0; i < 200 && supervisor.activeSha() !== "sha-1"; i += 1) await tick(25);
  assert.equal(supervisor.activeSha(), "sha-1");
  const reply = await hit(port, false, "GET");
  assert.equal(reply.sha, "sha-1", "the rolled-back build serves the port");
  await supervisor.shutdown("test");
});

test("the only generation crashing is replaced and promoted even while its smoke read answers 503", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const modes: Record<string, string> = {};
  const { supervisor, logs, exits } = realSupervisor(port, modes);
  await supervisor.start();
  assert.equal((await hit(port, false, "GET")).status, 200);
  modes["sha-1"] = "status-503";
  process.kill(Number(logs.find((l) => l.step === "serve.generation_forked")?.extra?.pid), "SIGKILL");
  const degradedAfterCrash = (): boolean => logs.slice(logs.findIndex((l) => l.step === "serve.generation_crashed")).some((l) => l.step === "serve.cold_start_degraded");
  for (let i = 0; i < 400 && !(logs.some((l) => l.step === "serve.generation_crashed") && degradedAfterCrash()); i += 1) await tick(25);
  assert.deepEqual(exits, [], "nothing else was serving, so a warming replacement is never a reason to exit");
  assert.ok(degradedAfterCrash(), "the replacement was promoted and ledgered as degraded");
  assert.equal(logs.some((l) => l.step === "serve.generation_restart_failed"), false);
  assert.equal(logs.filter((l) => l.step === "serve.generation_forked").length, 2);
  const reply = await hit(port, false, "GET");
  assert.deepEqual({ status: reply.status, sha: reply.sha }, { status: 200, sha: "sha-1" }, "the replacement serves the port");
  await supervisor.shutdown("test");
});

// ── the default seams ───────────────────────────────────────────────────────────────────────────

test("the supervisor's default seams read cgroup memory, procfs and the kill switch", async () => {
  const files: Record<string, string> = { "/cg/memory.max": "5368709120\n", "/cg/memory.current": "1073741824\n" };
  assert.equal(cgroupFreeMemory((p) => files[p], "/cg"), 4_294_967_296);
  assert.equal(cgroupFreeMemory((p) => (p.endsWith("max") ? "max\n" : "1"), "/cg"), undefined, "an unbounded cgroup never defers");
  assert.equal(cgroupFreeMemory(() => { throw new Error("ENOENT"); }), undefined);
  assert.equal(cgroupFreeMemory(undefined, "/definitely/not/a/cgroup"), undefined);
  assert.equal(procRss(1, () => "Name:\tnode\nVmRSS:\t  2048 kB\n"), 2_097_152);
  assert.equal(procRss(1, () => "Name:\tnode\n"), undefined);
  assert.equal(procRss(1, () => { throw new Error("ENOENT"); }), undefined);
  assert.equal(procRss(process.pid) === undefined || (procRss(process.pid) ?? 0) > 0, true);
  const gens = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gens-`));
  assert.equal(handoffSwitch({}, gens)(), true);
  assert.equal(handoffSwitch({ RMD_SERVE_HANDOFF: "off" }, gens)(), false);
  writeFileSync(join(gens, "handoff.off"), "");
  assert.equal(handoffSwitch({}, gens)(), false, "an operator can turn handoff off with one file");
  assert.deepEqual(generationCommand(["serve", "--port", "4317"])({ dir: "/gens/a", sha: "s" }), {
    exec: "/gens/a/src/run-task.ts",
    execArgv: ["--import", "file:///gens/a/node_modules/tsx/dist/loader.mjs"],
    args: ["serve", "--port", "4317"],
    cwd: "/gens/a",
  });
  const socketPath = join(gens, "s.sock");
  const server = createHttpServer((req, res) => (req.url === "/slow" ? undefined : res.end(`got ${req.url}`)));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  assert.deepEqual(await socketGet(socketPath, "/v1/ready"), { status: 200, body: "got /v1/ready" });
  await assert.rejects(socketGet(socketPath, "/slow", 50), /timed out after 50 ms/);
  server.closeAllConnections();
  server.close();
  await assert.rejects(socketGet(join(gens, "missing.sock"), "/"));
  assert.equal(typeof clusterSpawn, "function");
});
