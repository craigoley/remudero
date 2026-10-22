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
  HANDOFF_NEED_MARGIN,
  clusterSpawn,
  createServeSupervisor,
  generationCommand,
  handoffSwitch,
  judgeServeUpgradeAdmission,
  procRss,
  readHostPressure,
  readServeUpgradeThresholds,
  serveUpgradeThresholdsFromPolicy,
  type HostPressureReading,
  type ServeUpgradeThresholds,
  socketGet,
  type GenerationProcess,
  type PreparedSlot,
  type ServeSupervisorOptions,
} from "../src/lib/serve-supervisor.js";
import type { GenerationMessage } from "../src/lib/serve-generation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { systemClock } from "../src/lib/clock.js";
import { loadHostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MIB = 1024 * 1024;
/** W1-T8311: the shipped host budget thresholds, and a host reading with room to spare. */
const THRESHOLDS: ServeUpgradeThresholds = { hostReserveBytes: 2048 * MIB, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 };
const AMPLE: Omit<HostPressureReading, "atMs"> = { memAvailableBytes: 64 * 1024 * MIB, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] };

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
    peakRss: () => 1_000,
    socketPathFor: (n) => `/sock/${n}`,
    hostPressure: async () => ({ ...AMPLE, atMs: (extra.clock ?? systemClock).now() }),
    upgradeThresholds: () => THRESHOLDS,
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
  const retries: Array<() => void> = [];
  const { supervisor, logs, exits } = decisionSupervisor(fleet, {
    freeMemory: () => 1_000, rss: () => 5_000, peakRss: () => undefined, deferMs: 1, shedBackstopMs: 7,
    sleep: (ms) => (ms === 7 ? Promise.resolve() : new Promise<void>((resolve) => void retries.push(resolve))),
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  for (let i = 0; i < 4; i += 1) {
    retries.shift()?.();
    await tick(2);
  }
  const deferred = logs.filter((l) => l.step === "serve.handoff_deferred");
  assert.equal(deferred.length, 5, "every refusal defers again: pressure never ends the supervisor");
  assert.deepEqual(
    { reason: deferred[0].extra?.reason, hold: deferred[0].extra?.hold, freeBytes: deferred[0].extra?.freeBytes, needBytes: deferred[0].extra?.needBytes },
    { reason: "memory", hold: "container_headroom", freeBytes: 1_000, needBytes: 5_000 * HANDOFF_NEED_MARGIN },
  );
  assert.equal(fleet.generations.length, 1, "no standby is forked while headroom is short");
  assert.deepEqual(exits, [], "no legacy exit");
  assert.equal(logs.find((l) => l.step === "serve.handoff_shed")?.extra?.answered, false, "a generation that never answers the shed is waited out by its backstop");
  await supervisor.shutdown("test");
});

test("a memory-short handoff asks the active generation to shed before it defers", async () => {
  const fleet = fakeFleet();
  const shedAsked = (): boolean => fleet.generations[0]?.sent.some((m) => m.type === "rmd.shed") ?? false;
  const { supervisor, logs } = decisionSupervisor(fleet, {
    freeMemory: () => (shedAsked() ? 9_000 : 1_000),
    rss: () => 5_000,
    peakRss: () => undefined,
    shedBackstopMs: 123,
    sleep: (ms) => (ms === 123 ? new Promise<void>(() => {}) : Promise.resolve()),
  });
  await supervisor.start();
  const cold = fleet.generations[0];
  const send = cold.send.bind(cold);
  cold.send = (message) => {
    send(message);
    if (message.type === "rmd.shed") queueMicrotask(() => cold.emit({ type: "rmd.shed_done", beforeBytes: 5_000, afterBytes: 3_000, heapBeforeBytes: 4_000, heapAfterBytes: 1_000, gc: true }));
  };
  await supervisor.requestHandoff();
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote", "rmd.shed", "rmd.drain"], "tier 1 runs before the standby is forked");
  const shed = logs.find((l) => l.step === "serve.handoff_shed")?.extra;
  assert.deepEqual(
    { answered: shed?.answered, beforeBytes: shed?.beforeBytes, afterBytes: shed?.afterBytes, freeBefore: shed?.freeBefore, freeAfter: shed?.freeAfter, needBytes: shed?.needBytes },
    { answered: true, beforeBytes: 5_000, afterBytes: 3_000, freeBefore: 1_000, freeAfter: 9_000, needBytes: 5_000 * HANDOFF_NEED_MARGIN },
  );
  assert.deepEqual(
    { gc: shed?.gc, heapBeforeBytes: shed?.heapBeforeBytes, heapAfterBytes: shed?.heapAfterBytes },
    { gc: true, heapBeforeBytes: 4_000, heapAfterBytes: 1_000 },
    "the shed row carries what the collection freed and whether one ran",
  );
  assert.equal(logs.some((l) => l.step === "serve.handoff_deferred"), false, "the shed freed enough, so nothing defers");
  assert.equal(supervisor.activeSha(), "sha-2", "the handoff went ahead");
});

test("a standby needs its boot peak and not its resident bytes at promotion", async () => {
  const fleet = fakeFleet();
  // Every generation reads 1 000 resident now; the cold one peaked at 1 500 while it booted.
  const { supervisor, logs } = decisionSupervisor(fleet, {
    freeMemory: () => 1_400, rss: () => 1_000, peakRss: (pid) => (pid === 1 ? 1_500 : undefined), deferMs: 1,
    sleep: (ms) => (ms === 1 ? new Promise<void>(() => {}) : Promise.resolve()),
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  const deferred = logs.find((l) => l.step === "serve.handoff_deferred")?.extra;
  assert.deepEqual(
    { freeBytes: deferred?.freeBytes, needBytes: deferred?.needBytes, activeRssBytes: deferred?.activeRssBytes, activePeakBytes: deferred?.activePeakBytes },
    { freeBytes: 1_400, needBytes: 1_500 * HANDOFF_NEED_MARGIN, activeRssBytes: 1_000, activePeakBytes: 1_500 },
    "1 400 free covers the 1 000 resident at promotion but not the 1 500 boot peak (times the W1-T9542 margin)",
  );
  await supervisor.shutdown("test");
});

/** The cold generation answers every shed at once, as a real one does. */
function answerSheds(cold: FakeGeneration): void {
  const send = cold.send.bind(cold);
  cold.send = (message) => {
    send(message);
    if (message.type === "rmd.shed") queueMicrotask(() => cold.emit({ type: "rmd.shed_done", beforeBytes: 5_000, afterBytes: 5_000 }));
  };
}

test("a shed generation left serving by an abandoned handoff is asked to restore at once", async () => {
  const fleet = fakeFleet((slot) => (slot.sha === "sha-2" ? { never: true } : {}));
  const shedAsked = (): boolean => fleet.generations[0]?.sent.some((m) => m.type === "rmd.shed") ?? false;
  let now = 0;
  const { supervisor, logs } = decisionSupervisor(fleet, {
    freeMemory: () => (shedAsked() ? 9_000 : 1_000),
    rss: () => 5_000,
    peakRss: () => undefined,
    clock: { now: () => (now += 1_000), iso: () => "" } as never,
    readyBoundMs: 5_000,
  });
  await supervisor.start();
  const cold = fleet.generations[0];
  answerSheds(cold);
  await supervisor.requestHandoff();
  assert.equal(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.criterion, "ready_bound", "positive control: the standby the shed made room for never became ready");
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote", "rmd.shed", "rmd.restore"], "the shed generation still serves, so it re-warms now rather than on its refresh schedule");
  assert.deepEqual(logs.find((l) => l.step === "serve.shed_restore")?.extra, { generation: 1, freeBytes: 9_000, needBytes: 5_000 });
  await supervisor.requestHandoff();
  assert.equal(cold.sent.filter((m) => m.type === "rmd.restore").length, 1, "a handoff that sheds nothing restores nothing");
});

test("a shed generation waiting on a memory retry stays cold until the handoff ends", async () => {
  const fleet = fakeFleet();
  let releaseRetry: () => void = () => {};
  const { supervisor, logs, exits } = decisionSupervisor(fleet, {
    freeMemory: () => 1_000,
    rss: () => 5_000,
    peakRss: () => undefined,
    deferMs: 50,
    sleep: (ms) => (ms >= 50 ? new Promise<void>((resolve) => (releaseRetry = resolve)) : Promise.resolve()),
  });
  await supervisor.start();
  const cold = fleet.generations[0];
  answerSheds(cold);
  await supervisor.requestHandoff();
  assert.equal(logs.filter((l) => l.step === "serve.handoff_deferred").length, 1, "positive control: the shed did not free enough and a retry is pending");
  assert.equal(cold.sent.some((m) => m.type === "rmd.restore"), false, "re-warming now would only be shed again by the retry");
  for (let i = 0; i < 5; i += 1) {
    releaseRetry();
    await tick(1);
  }
  assert.deepEqual(exits, [], "W1-T8311: a third and later deferral keeps the generation serving");
  assert.ok(logs.filter((l) => l.step === "serve.handoff_deferred").length >= 4);
  assert.equal(cold.sent.some((m) => m.type === "rmd.restore"), false, "a retry is always pending, so the shed generation stays cold");
  assert.equal(logs.some((l) => l.step === "serve.shed_restore"), false);
  await supervisor.shutdown("test");
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
  let now = 0;
  const { supervisor, logs } = decisionSupervisor(fleet, { clock: { now: () => (now += 1_000), iso: () => "" } as never, readyBoundMs: 5_000 });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.criterion, "smoke /v1/status");
  assert.deepEqual(fleet.generations[1].killed, ["SIGKILL"], "the standby never served");
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(fleet.generations[0].sent.map((m) => m.type), ["rmd.promote"], "the serving generation was never drained");
});

test("a recovering smoke read rechecks readiness and every route before promotion", async () => {
  const fleet = fakeFleet();
  let statusReads = 0;
  const checked: string[] = [];
  const { supervisor } = decisionSupervisor(fleet, {
    get: async (socket, path) => {
      if (socket !== "/sock/2") return fleet.get!(socket, path);
      checked.push(path.split("?")[0]);
      if (path === "/v1/status" && statusReads++ === 0) {
        assert.equal(supervisor.activeSha(), "sha-1", "the old generation still owns the port");
        return { status: 503, body: "warming" };
      }
      if (path.startsWith("/v1/ready") && statusReads === 1 && checked.filter((p) => p === "/v1/ready").length === 2)
        return { status: 503, body: "readiness regressed" };
      return fleet.get!(socket, path);
    },
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(supervisor.activeSha(), "sha-2");
  assert.deepEqual(checked, ["/v1/ready", "/v1/version", "/v1/status", "/v1/ready", "/v1/ready", "/v1/version", "/v1/status", "/v1/views/versions"]);
});

test("a non-503 smoke failure is refused immediately", async () => {
  const fleet = fakeFleet();
  let refused = 0;
  const { supervisor, logs } = decisionSupervisor(fleet, {
    get: async (socket, path) => socket === "/sock/2" && path === "/v1/status"
      ? (refused++, { status: 401, body: "unauthorized" }) : fleet.get!(socket, path),
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(refused, 1);
  assert.equal(supervisor.activeSha(), "sha-1");
  assert.deepEqual(logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.detail, { status: 401 });
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

// ── W1-T8311: a memory-unsafe upgrade is deferred, never turned into downtime ──────────────────

/** A retry gate: each deferral's retry sleep waits here until the test releases it. */
function retryGate(deferMs: number) {
  const waiting: Array<{ ms: number; wake: () => void }> = [];
  return {
    sleep: (ms: number): Promise<void> => (ms >= deferMs ? new Promise<void>((resolve) => void waiting.push({ ms, wake: resolve })) : Promise.resolve()),
    pending: () => waiting.length,
    async release(): Promise<number | undefined> {
      const next = waiting.shift();
      next?.wake();
      for (let i = 0; i < 5; i += 1) await tick(1);
      return next?.ms;
    },
  };
}

test("a pending memory retry coalesces external handoff requests without rebuilding workers", async () => {
  const fleet = fakeFleet();
  const gate = retryGate(10);
  let pressured = true;
  let prepares = 0;
  let newest = "sha-2";
  const { supervisor, logs } = decisionSupervisor(fleet, {
    deferMs: 10, sleep: gate.sleep,
    prepare: async () => { prepares++; return { dir: "/next", sha: newest }; },
    hostPressure: async () => ({ ...AMPLE, swapInPagesPerSec: pressured ? 800 : 0, atMs: Date.now() }),
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(gate.pending(), 1, "positive control: the actual refusal scheduled one retry");
  newest = "sha-9";
  await Promise.all(Array.from({ length: 5 }, () => supervisor.requestHandoff()));
  assert.equal(prepares, 1, "external requests cannot skip the outstanding pressure backoff");
  assert.equal(logs.filter(l => l.step === "serve.handoff_deferred").length, 1);
  assert.equal(gate.pending(), 1, "not one retry timer per external request");
  assert.equal(fleet.generations.length, 1, "the original generation still answers");
  pressured = false;
  await gate.release();
  assert.equal(prepares, 2, "the one retry prepares again, rather than pinning an obsolete candidate");
  assert.equal(supervisor.activeSha(), newest);
  assert.equal(logs.filter(l => l.step === "serve.handoff_deferred").length, 1, "adoption adds no pressure retry");
  await supervisor.shutdown("test");
});

test("host swap pressure is checked before a short handoff sheds the serving workers", async () => {
  const fleet = fakeFleet();
  const gate = retryGate(10);
  let free = 1_000;
  const { supervisor, logs } = decisionSupervisor(fleet, {
    freeMemory: () => free, peakRss: () => 1_000, deferMs: 10, sleep: gate.sleep,
    hostPressure: async () => ({ ...AMPLE, swapInPagesPerSec: 800, atMs: Date.now() }),
  });
  await supervisor.start();
  const cold = fleet.generations[0], send = cold.send;
  cold.send = (m) => {
    send(m);
    if (m.type === "rmd.shed") { free = 5_000; cold.emit({ type: "rmd.shed_done", beforeBytes: 4_000, afterBytes: 1_000, heapBeforeBytes: 3_000, heapAfterBytes: 500, gc: true }); }
  };
  await supervisor.requestHandoff();
  assert.deepEqual(cold.sent.map(m => m.type), ["rmd.promote"], "an already-unsafe host must not shed and rewarm a healthy generation");
  const held = logs.find(l => l.step === "serve.handoff_deferred")?.extra;
  assert.equal(held?.hold, "swap_in");
  assert.equal(held?.phase, "before_shed");
  assert.equal(held?.preserved, true);
  assert.equal(fleet.generations.length, 1);
  await supervisor.shutdown("test");
});

test("a pending memory retry does not defer the explicit handoff kill switch", async () => {
  const fleet = fakeFleet(), gate = retryGate(10);
  let enabled = true;
  const { supervisor, exits } = decisionSupervisor(fleet, {
    deferMs: 10, sleep: gate.sleep, handoffEnabled: () => enabled,
    hostPressure: async () => ({ ...AMPLE, swapInPagesPerSec: 800, atMs: Date.now() }),
  });
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(gate.pending(), 1);
  enabled = false;
  await supervisor.requestHandoff();
  assert.deepEqual(exits, [0], "the explicit legacy-exit switch is not delayed by coalescing");
  await gate.release();
  assert.equal(fleet.generations.length, 1, "a pending wake cannot fork after shutdown");
});

test("pressure arising during a handoff shed still blocks the final fork admission", async () => {
  const fleet = fakeFleet();
  const gate = retryGate(10);
  let free = 1_000, pressured = false, reads = 0;
  const { supervisor, logs } = decisionSupervisor(fleet, {
    freeMemory: () => free, peakRss: () => 1_000, deferMs: 10, sleep: gate.sleep,
    hostPressure: async () => { reads++; return { ...AMPLE, swapInPagesPerSec: pressured ? 800 : 0, atMs: Date.now() }; },
  });
  await supervisor.start();
  const cold = fleet.generations[0], send = cold.send;
  cold.send = (m) => {
    send(m);
    if (m.type === "rmd.shed") { free = 5_000; pressured = true; cold.emit({ type: "rmd.shed_done", beforeBytes: 4_000, afterBytes: 1_000, heapBeforeBytes: 3_000, heapAfterBytes: 500, gc: true }); }
  };
  await supervisor.requestHandoff();
  assert.equal(reads, 2, "a fresh final reading follows the early reading, never reuse it");
  assert.equal(logs.find(l => l.step === "serve.handoff_deferred")?.extra?.hold, "swap_in");
  assert.equal(fleet.generations.length, 1, "host pressure still prevents a standby fork");
  assert.equal(supervisor.activeSha(), "sha-1");
  await supervisor.shutdown("test");
});

test("a handoff shed can recover host headroom before final admission", async () => {
  const fleet = fakeFleet(), gate = retryGate(10);
  let free = 1_000, available = 2_000, reads = 0;
  const { supervisor } = decisionSupervisor(fleet, {
    freeMemory: () => free, peakRss: () => 1_000, deferMs: 10, sleep: gate.sleep,
    hostPressure: async () => { reads++; return { ...AMPLE, memAvailableBytes: available, atMs: Date.now() }; },
    upgradeThresholds: () => ({ ...THRESHOLDS, hostReserveBytes: 1_000 }),
  });
  await supervisor.start();
  const cold = fleet.generations[0], send = cold.send;
  cold.send = m => {
    send(m);
    if (m.type === "rmd.shed") { free = available = 5_000; cold.emit({ type: "rmd.shed_done", beforeBytes: 4_000, afterBytes: 1_000, heapBeforeBytes: 3_000, heapAfterBytes: 500, gc: true }); }
  };
  await supervisor.requestHandoff();
  assert(cold.sent.some(m => m.type === "rmd.shed"), "clean-but-thin headroom can be recovered by dropping caches");
  assert.equal(reads, 2, "the final guard verifies the actual recovered headroom");
  assert.equal(supervisor.activeSha(), "sha-2");
  await supervisor.shutdown("test");
});

test("a memory-deferred serve upgrade keeps the healthy console answering", async () => {
  const fleet = fakeFleet((slot) => ({ readyAfter: slot.sha === "sha-1" ? 0 : 2 }));
  const gate = retryGate(10);
  let pressured = true;
  let prepares = 0;
  const { supervisor, logs, exits, steps } = decisionSupervisor(fleet, {
    deferMs: 10,
    pollMs: 1,
    sleep: gate.sleep,
    prepare: async () => ({ dir: `/slot-${++prepares}`, sha: `sha-${prepares + 1}` }),
    hostPressure: async () => ({ ...AMPLE, ...(pressured ? { psiFullAvg10: 2.53, swapInPagesPerSec: 12 } : {}), atMs: Date.now() }),
  });
  await supervisor.start();
  const cold = fleet.generations[0];
  await supervisor.requestHandoff();
  const retryMs: Array<number | undefined> = [];
  for (let i = 0; i < 4; i += 1) retryMs.push(await gate.release());

  const deferred = logs.filter((l) => l.step === "serve.handoff_deferred").map((l) => l.extra!);
  assert.equal(deferred.length, 5, "five refusals, two past the old third-refusal exit");
  assert.deepEqual(deferred.map((d) => d.hold), ["psi", "psi", "psi", "psi", "psi"], "each refusal names its hold");
  assert.deepEqual(deferred.map((d) => d.preserved), [true, true, true, true, true], "the kept generation positively answered every time");
  assert.deepEqual(retryMs, [10, 20, 40, 80], "the existing retry, doubling per refusal");
  assert.deepEqual(exits, [], "pressure never exits the supervisor");
  assert.equal(steps().includes("serve.handoff_legacy_exit"), false);
  assert.equal(fleet.generations.length, 1, "zero standby forks while refused");
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote"], "the healthy generation was never drained");
  assert.equal((await fleet.get!("/sock/1", "/v1/ready")).status, 200, "and still answers");
  assert.equal(supervisor.activeSha(), "sha-1");

  // A positively admitted retry supersedes every obsolete candidate and takes the normal path.
  pressured = false;
  await gate.release();
  assert.equal(fleet.generations.length, 2, "exactly one standby, forked only once admitted");
  assert.equal(fleet.generations[1].slot.sha, "sha-7", "the newest target, never an obsolete deferred one");
  const admitted = logs.find((l) => l.step === "serve.handoff_admitted")?.extra;
  assert.equal(admitted?.sha, "sha-7");
  assert.equal(admitted?.deferrals, 5);
  assert.deepEqual(fleet.generations[1].sent.map((m) => m.type), ["rmd.promote"], "promoted after its readiness polls");
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote", "rmd.drain"], "the old generation drained only after the promote");
  assert.equal(logs.find((l) => l.step === "serve.handoff_done")?.extra?.toSha, "sha-7");
  assert.equal(supervisor.activeSha(), "sha-7");

  // A kept generation that does NOT positively answer is never reported preserved.
  const sick = fakeFleet();
  const sickGate = retryGate(10);
  let coldReady = 200;
  const unhealthy = decisionSupervisor(sick, {
    deferMs: 10,
    sleep: sickGate.sleep,
    get: async (socket, path) => (socket === "/sock/1" && path === "/v1/ready" ? { status: coldReady, body: "{}" } : sick.get!(socket, path)),
    hostPressure: async () => ({ ...AMPLE, memAvailableBytes: 1 * MIB, atMs: Date.now() }),
  });
  await unhealthy.supervisor.start();
  coldReady = 503;
  await unhealthy.supervisor.requestHandoff();
  const row = unhealthy.logs.find((l) => l.step === "serve.handoff_deferred")?.extra;
  assert.deepEqual({ hold: row?.hold, preserved: row?.preserved }, { hold: "host_headroom", preserved: false });
  assert.deepEqual(unhealthy.exits, []);
  await unhealthy.supervisor.shutdown("test");
  await supervisor.shutdown("test");
});

test("serve upgrade admission preserves unknowns and genuine recovery paths", async () => {
  const at = 1_000_000;
  const fits = { thresholds: THRESHOLDS, candidatePeakBytes: 7_680 * MIB, peakBasis: "boot peak", nowMs: at };
  const reading = (over: Partial<HostPressureReading> = {}): HostPressureReading => ({ ...AMPLE, atMs: at, ...over });
  const hold = (i: Parameters<typeof judgeServeUpgradeAdmission>[0]): string | undefined => {
    const v = judgeServeUpgradeAdmission(i);
    return v.admit ? undefined : v.hold;
  };
  // Unknowns are named holds, never zero pressure or a fit.
  assert.equal(hold({ ...fits, reading: undefined }), "pressure_unread");
  assert.equal(hold({ ...fits, reading: reading({ psiFullAvg10: undefined, psiSomeAvg10: undefined, unread: ["/proc/pressure/memory: ENOENT"] }) }), "pressure_unread");
  assert.equal(hold({ ...fits, reading: reading({ swapInPagesPerSec: undefined }) }), "pressure_unread", "a missing field without a reason is still unread");
  assert.equal(hold({ ...fits, reading: reading({ atMs: at - 600_001 }) }), "pressure_stale");
  assert.equal(hold({ ...fits, reading: reading({ atMs: at + 5 }) }), "pressure_stale", "a reading from the future is not fresh");
  assert.equal(hold({ ...fits, reading: reading(), candidatePeakBytes: undefined }), "peak_unknown");
  assert.equal(hold({ ...fits, reading: reading(), candidatePeakBytes: 0 }), "peak_unknown", "a zero peak is not a zero-sized candidate");
  assert.equal(hold({ ...fits, reading: reading(), thresholds: { unread: "policy.yaml: ENOENT" } }), "policy_unread");
  // Measured pressure refuses against the shipped thresholds.
  assert.equal(hold({ ...fits, reading: reading({ swapInPagesPerSec: 257 }) }), "swap_in");
  assert.equal(hold({ ...fits, reading: reading({ psiFullAvg10: 2.53 }) }), "psi");
  assert.equal(hold({ ...fits, reading: reading({ psiSomeAvg10: 10.5 }) }), "psi");
  // The 22:57Z minimum: 4 146 167 808 B available does not hold a 7.5 GiB peak over the 2 GiB reserve.
  assert.equal(hold({ ...fits, reading: reading({ memAvailableBytes: 4_146_167_808 }) }), "host_headroom");
  const freed = judgeServeUpgradeAdmission({ ...fits, reading: reading({ memAvailableBytes: 4_146_167_808 }), freedBytes: 6_144 * MIB });
  assert.deepEqual(freed.admit && freed.needBytes, 2_048 * MIB + 1_536 * MIB, "only what the stop frees first is credited, once");
  assert.equal(judgeServeUpgradeAdmission({ ...fits, reading: reading() }).admit, true, "positive control");

  // The default reader names each unread measurement and measures swap-in over its window.
  let vmstat = 100;
  const files: Record<string, () => string> = {
    "/proc/vmstat": () => `pgpgin 1\npswpin ${(vmstat += 50)}\n`,
    "/proc/meminfo": () => "MemTotal: 16000000 kB\nMemAvailable:    4049000 kB\n",
    "/proc/pressure/memory": () => "some avg10=1.50 avg60=0.10 avg300=0.00 total=1\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=1\n",
  };
  let now = 0;
  const read = (path: string): string => {
    const f = files[path];
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f();
  };
  const measured = await readHostPressure({ read, clock: { now: () => now, iso: () => "" } as never, sleep: async (ms) => void (now += ms), sampleMs: 500 });
  assert.deepEqual(measured, { atMs: 500, memAvailableBytes: 4_049_000 * 1024, swapInPagesPerSec: 100, swapInDiskPagesPerSec: 100,
    swapInZswapPagesPerSec: 0, swapInZswapBasis: "no zswpin line (zswap not compiled in): 0", psiSomeAvg10: 1.5, psiFullAvg10: 0.25, unread: [] });
  delete files["/proc/pressure/memory"];
  const noPsi = await readHostPressure({ read, clock: { now: () => now, iso: () => "" } as never, sleep: async (ms) => void (now += ms) });
  assert.match(noPsi.unread.join(";"), /\/proc\/pressure\/memory: ENOENT/);
  assert.equal(hold({ ...fits, reading: noPsi, nowMs: now }), "pressure_unread");
  const frozen = await readHostPressure({ read, clock: { now: () => 7, iso: () => "" } as never, sleep: async () => {} });
  assert.match(frozen.unread.join(";"), /no time elapsed/, "no window, no rate: never a zero swap-in");

  // The baked supervisor's threshold reader agrees with the validated loader on the shipped policy.
  const shipped = loadHostMemoryBudgetPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.deepEqual(readServeUpgradeThresholds(REPO_ROOT), {
    hostReserveBytes: shipped.hostReserveMib * MIB, swapInPagesPerSecMax: shipped.swapInPagesPerSecMax,
    psiSomeAvg10Max: shipped.psiSomeAvg10Max, psiFullAvg10Max: shipped.psiFullAvg10Max, staleMs: shipped.staleReadingMs,
  });
  assert.match(String((serveUpgradeThresholdsFromPolicy("sweep:\n  hostMemoryBudget:\n    hostReserveMib:\n      value: 2048\n") as { unread: string }).unread), /swapInPagesPerSecMax/);
  assert.match((readServeUpgradeThresholds("/definitely/not/a/slot") as { unread: string }).unread, /policy\.yaml/);

  // The supervisor holds on each unknown and forks nothing.
  const unknowns: Array<[string, Partial<ServeSupervisorOptions>]> = [
    ["peak_unknown", { peakRss: () => undefined, rss: () => undefined }],
    ["pressure_unread", { hostPressure: async () => { throw new Error("EIO"); } }],
    ["pressure_stale", { hostPressure: async () => ({ ...AMPLE, atMs: Date.now() - 3_600_000 }) }],
    ["policy_unread", { upgradeThresholds: () => ({ unread: "no policy" }) }],
  ];
  for (const [name, over] of unknowns) {
    const fleet = fakeFleet();
    const run = decisionSupervisor(fleet, { deferMs: 10, sleep: (ms) => (ms >= 10 ? new Promise<void>(() => {}) : Promise.resolve()), ...over });
    await run.supervisor.start();
    await run.supervisor.requestHandoff();
    assert.equal(run.logs.find((l) => l.step === "serve.handoff_deferred")?.extra?.hold, name, name);
    assert.equal(fleet.generations.length, 1, `${name}: no standby`);
    assert.deepEqual(run.exits, [], name);
    await run.supervisor.shutdown("test");
  }

  // Genuine recovery keeps its own outcomes, even on a pressured host.
  const pressured = { hostPressure: async () => ({ ...AMPLE, psiFullAvg10: 50, atMs: Date.now() }) };
  const crashFleet = fakeFleet();
  const crash = decisionSupervisor(crashFleet, pressured);
  await crash.supervisor.start();
  crashFleet.generations[0].die(1);
  for (let i = 0; i < 20 && crashFleet.generations.length < 2; i += 1) await tick(1);
  assert.equal(crash.logs.find((l) => l.step === "serve.generation_crashed")?.extra?.sha, "sha-1", "a real crash is replaced, not admitted");
  assert.equal(crash.supervisor.activeSha(), "sha-1");

  const rollFleet = fakeFleet();
  let admitAll = true;
  const roll = decisionSupervisor(rollFleet, { hostPressure: async () => ({ ...AMPLE, ...(admitAll ? {} : { psiFullAvg10: 50 }), atMs: Date.now() }) });
  await roll.supervisor.start();
  await roll.supervisor.requestHandoff();
  admitAll = false;
  rollFleet.generations[1].die(1);
  for (let i = 0; i < 20 && roll.supervisor.activeSha() !== "sha-1"; i += 1) await tick(1);
  assert.equal(roll.logs.find((l) => l.step === "serve.handoff_rolled_back")?.extra?.sha, "sha-2", "rollback is its own outcome");
  assert.equal(roll.supervisor.activeSha(), "sha-1");

  const readyFleet = fakeFleet((slot) => (slot.sha === "sha-2" ? { never: true } : {}));
  let clock = 0;
  const notReady = decisionSupervisor(readyFleet, { clock: { now: () => (clock += 1_000), iso: () => "" } as never, readyBoundMs: 5_000 });
  await notReady.supervisor.start();
  await notReady.supervisor.requestHandoff();
  assert.equal(notReady.logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.criterion, "ready_bound", "an admitted standby can still fail readiness");
  assert.equal(notReady.supervisor.activeSha(), "sha-1");
  assert.equal(notReady.steps().includes("serve.handoff_deferred"), false);

  const offFleet = fakeFleet();
  const off = decisionSupervisor(offFleet, { ...pressured, handoffEnabled: () => false });
  await off.supervisor.start();
  await off.supervisor.requestHandoff();
  assert.equal(off.logs.find((l) => l.step === "serve.handoff_legacy_exit")?.extra?.reason, "handoff_off", "the operator kill switch still exits");
  assert.deepEqual(off.exits, [0]);

  const stopFleet = fakeFleet();
  const stop = decisionSupervisor(stopFleet, pressured);
  await stop.supervisor.start();
  await stop.supervisor.shutdown("sigterm");
  assert.deepEqual(stop.exits, [0], "an explicit stop drains and exits");
  assert.deepEqual(stopFleet.generations[0].sent.map((m) => m.type), ["rmd.promote", "rmd.drain"]);
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
    // The swap itself is under test here, not this test host's own memory pressure.
    freeMemory: () => AMPLE.memAvailableBytes!, rss: () => 1_000, peakRss: () => 1_000,
    hostPressure: async () => ({ ...AMPLE, atMs: Date.now() }),
    upgradeThresholds: () => THRESHOLDS,
  });
  return { supervisor, logs, exits };
}

test("a real standby that briefly answers 503 becomes ready before it replaces the active generation", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const { supervisor, logs } = realSupervisor(port, { "sha-2": "status-warming" });
  try {
    await supervisor.start();
    assert.equal((await hit(port, false, "GET")).sha, "sha-1");
    const handoff = supervisor.requestHandoff();
    while (supervisor.activeSha() === "sha-1" && !logs.some((l) => l.step === "serve.handoff_aborted")) {
      const reply = await hit(port, false, "GET");
      assert.equal(reply.status, 200, "the active generation serves throughout the standby wait");
      await tick(10);
    }
    await handoff;
    assert.equal(supervisor.activeSha(), "sha-2");
    assert.equal(logs.some((l) => l.step === "serve.handoff_aborted"), false);
    assert.equal((await hit(port, false, "GET")).sha, "sha-2");
  } finally {
    await supervisor.shutdown("test");
  }
});

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

test("cgroup headroom counts clean page cache as reclaimable", () => {
  // The fleet serve cgroup 2026-10-02 07:28Z: current 3 593 220 096 of which file 171 245 568 (clean).
  const stat = "anon 3304325120\nfile 171245568\nkernel 113684480\nshmem 0\nfile_dirty 77824\nfile_writeback 0\n";
  const files: Record<string, string> = { "/cg/memory.max": "5368709120\n", "/cg/memory.current": "3593220096\n", "/cg/memory.stat": stat };
  assert.equal(cgroupFreeMemory((p) => files[p], "/cg"), 5_368_709_120 - (3_593_220_096 - (171_245_568 - 77_824)));
  const shmem: Record<string, string> = { ...files, "/cg/memory.stat": "file 1000\nshmem 400\nfile_dirty 100\nfile_writeback 50\n" };
  assert.equal(cgroupFreeMemory((p) => shmem[p], "/cg"), 5_368_709_120 - 3_593_220_096 + 450, "shmem and dirty or writeback pages are not reclaimable");
  const noStat = (p: string): string => {
    if (p.endsWith("memory.stat")) throw new Error("ENOENT");
    return files[p];
  };
  assert.equal(cgroupFreeMemory(noStat, "/cg"), 5_368_709_120 - 3_593_220_096, "without memory.stat every charged byte counts");
});

test("the supervisor's default seams read cgroup memory, procfs and the kill switch", async () => {
  const files: Record<string, string> = { "/cg/memory.max": "5368709120\n", "/cg/memory.current": "1073741824\n" };
  assert.equal(cgroupFreeMemory((p) => files[p], "/cg"), 4_294_967_296);
  assert.equal(cgroupFreeMemory((p) => (p.endsWith("max") ? "max\n" : "1"), "/cg"), undefined, "an unbounded cgroup never defers");
  assert.equal(cgroupFreeMemory(() => { throw new Error("ENOENT"); }), undefined);
  assert.equal(cgroupFreeMemory(undefined, "/definitely/not/a/cgroup"), undefined);
  assert.equal(procRss(1, () => "VmHWM:\t  4096 kB\nVmRSS:\t  2048 kB\n", "VmHWM"), 4_194_304);
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
    execArgv: ["--expose-gc", "--import", "file:///gens/a/node_modules/tsx/dist/loader.mjs"],
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

// W1-T8378: the active generation's peak is refreshed after promotion, before any fork. W1-T9542: that lifetime
// high-water mark is ledgered as evidence and no longer prices the handoff; the boot peak (until an overlap is
// measured) times the margin does.
const GIB = 1024 * MIB;

test("unit test: a serve handoff refreshes its peak after promotion before forking", async () => {
  // Early sample at promotion 1 GiB; the active generation's high-water mark later reaches 4 GiB.
  let hwm = 1 * GIB;
  const fleet = fakeFleet();
  const { supervisor, logs } = decisionSupervisor(fleet, {
    peakRss: () => hwm,
    hostPressure: async () => ({ ...AMPLE, memAvailableBytes: 5 * GIB, atMs: Date.now() }),
  });
  await supervisor.start();
  hwm = 4 * GIB; // grows after the supervisor's one promotion-time sample
  await supervisor.requestHandoff();
  const admitted = logs.find((l) => l.step === "serve.handoff_admitted")?.extra;
  assert.equal(admitted?.activePeakBytes, 4 * GIB, "the later high-water mark is read before the fork and ledgered");
  assert.equal(admitted?.candidateNeedBytes, 1.5 * GIB, "W1-T9542: the 1 GiB boot peak times the margin prices it, not the 4 GiB lifetime peak");
  assert.equal(admitted?.needBasis, "boot_peak");
  assert.match(String(admitted?.peakBasis), /generation 1 boot peak/);
  assert.equal(supervisor.activeSha(), "sha-2", "1.5 GiB over a 2 GiB reserve fits 5 GiB, where the 4 GiB lifetime peak needed 6 GiB");

  // Positive control: a boot peak that does not fit the host is still refused before any fork.
  const ctlFleet = fakeFleet();
  const ctl = decisionSupervisor(ctlFleet, {
    peakRss: () => 4 * GIB,
    hostPressure: async () => ({ ...AMPLE, memAvailableBytes: 5 * GIB, atMs: Date.now() }),
    deferMs: 10,
    sleep: (ms) => (ms >= 10 ? new Promise<void>(() => {}) : Promise.resolve()),
  });
  await ctl.supervisor.start();
  await ctl.supervisor.requestHandoff();
  const deferred = ctl.logs.find((l) => l.step === "serve.handoff_deferred")?.extra;
  assert.equal(deferred?.hold, "host_headroom", "a 4 GiB boot peak times the margin needs 8 GiB with the reserve");
  assert.match(String(deferred?.detail), /need 8589934592 B/);
  assert.equal(ctlFleet.generations.length, 1, "no standby was forked");
  assert.equal(ctl.supervisor.activeSha(), "sha-1", "the old generation is kept");
  await ctl.supervisor.shutdown("test");
});

test("unit test: serve peak evidence keeps its generation and unknown state", async () => {
  // A later missing, invalid or lower reading never shrinks a known peak, and never fabricates one.
  let current: number | undefined = 4 * GIB;
  const fleet = fakeFleet();
  const gate = retryGate(10);
  const { supervisor, logs } = decisionSupervisor(fleet, {
    peakRss: () => current,
    hostPressure: async () => ({ ...AMPLE, memAvailableBytes: 5 * GIB, atMs: Date.now() }),
    deferMs: 10,
    sleep: gate.sleep,
  });
  await supervisor.start();
  const deferredRows = (): Array<Record<string, unknown> | undefined> => logs.filter((l) => l.step === "serve.handoff_deferred").map((l) => l.extra);
  for (const later of [undefined, Number.NaN, -1, 0, 1 * GIB]) {
    current = later;
    const before = deferredRows().length;
    if (before === 0) await supervisor.requestHandoff();
    else await gate.release();
    const row = deferredRows()[before];
    assert.equal(row?.hold, "host_headroom", `reading ${String(later)} does not shrink the known 4 GiB peak`);
    assert.match(String(row?.detail), /candidate 6442450944/, "the 4 GiB boot peak times the W1-T9542 margin");
  }
  assert.equal(fleet.generations.length, 1, "nothing was forked on a shrunken or fabricated peak");
  await supervisor.shutdown("test");

  // With no positive reading at all the named unknown hold remains, not a zero-sized candidate.
  const unknownFleet = fakeFleet();
  const unknown = decisionSupervisor(unknownFleet, {
    peakRss: () => Number.NaN, rss: () => undefined, deferMs: 10,
    sleep: (ms) => (ms >= 10 ? new Promise<void>(() => {}) : Promise.resolve()),
  });
  await unknown.supervisor.start();
  await unknown.supervisor.requestHandoff();
  const hold = unknown.logs.find((l) => l.step === "serve.handoff_deferred")?.extra;
  assert.equal(hold?.hold, "peak_unknown");
  assert.equal(unknownFleet.generations.length, 1);
  await unknown.supervisor.shutdown("test");

  // The evidence names the generation that produced it.
  const named = fakeFleet();
  const rows = decisionSupervisor(named, { peakRss: () => 1 * GIB });
  await rows.supervisor.start();
  await rows.supervisor.requestHandoff();
  assert.match(String(rows.logs.find((l) => l.step === "serve.handoff_admitted")?.extra?.peakBasis), /generation 1 /);
});

test("a serve upgrade counts swap-in served from zswap: pswpin plus zswpin", async () => {
  // OPERATOR RULING 2026-10-19 (4): under zswap a swap-in from the compressed pool counts in zswpin, never pswpin.
  let zswpin = 0;
  const files: Record<string, () => string> = {
    "/proc/vmstat": () => `pswpin 100\nzswpin ${(zswpin += 1_000)}\n`,
    "/proc/meminfo": () => "MemAvailable:    14049000 kB\n",
    "/proc/pressure/memory": () => "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
  };
  let now = 0;
  const reading = await readHostPressure({ read: (path) => files[path]!(), clock: { now: () => now, iso: () => "" } as never,
    sleep: async (ms) => void (now += ms), sampleMs: 1_000 });
  assert.equal(reading.swapInPagesPerSec, 1_000, "zero disk swap-in, 1,000 zswap pages in a second");
  assert.equal(reading.swapInDiskPagesPerSec, 0);
  assert.equal(reading.swapInZswapPagesPerSec, 1_000);
  assert.equal(reading.swapInZswapBasis, "zswpin");
  const verdict = judgeServeUpgradeAdmission({ reading, thresholds: THRESHOLDS, candidatePeakBytes: 1_024 * MIB, peakBasis: "boot peak", nowMs: now });
  assert.equal(!verdict.admit && verdict.hold, "swap_in");
  assert.match(!verdict.admit ? verdict.detail : "", /swap-in 1000\.0 pages\/s \(disk 0\.0 \+ zswap 1000\.0, zswpin\) > /);
});
