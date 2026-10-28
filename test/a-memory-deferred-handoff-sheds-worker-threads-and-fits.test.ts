/**
 * W1-T8873: a handoff deferred for memory sheds the ACTIVE generation's rebuildable worker threads (tier 2) so the
 * new generation fits. Tier 1 (the main heap) is src/lib/serve-supervisor.ts's `shedActive`; it frees ~0.4 GB of the
 * ~3 GB the threads hold, which left 660 live deferrals. The falsifier: keep only tier 1, and the fixture's free
 * bytes stay below the candidate need, the handoff defers again and this file fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServeSupervisor, HANDOFF_NEED_MARGIN, type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import { GENERATION_MESSAGES, onShedWorkersRequest, type GenerationChannel, type GenerationMessage } from "#src/lib/serve-generation.js";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const NEED = 5_000;
const SHORT = 1_000;
const FITS = 9_000;
const BACKSTOP_MS = 7;
const DEFER_MS = 50;

interface Fake extends GenerationProcess {
  sent: GenerationMessage[];
  emit(message: GenerationMessage): void;
  die(code: number | null): void;
  slot: PreparedSlot;
}

/** Fake generations that answer promote, drain and the shed messages; `workerShed` decides what tier 2 frees. */
function harness(opts: { workersFree: boolean; neverReady?: boolean; extra?: Partial<ServeSupervisorOptions> }) {
  const generations: Fake[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const retries: Array<() => void> = [];
  const spawn: ServeSupervisorOptions["spawn"] = (command) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    const listeners: Array<(m: GenerationMessage) => void> = [];
    const exits: Array<(c: number | null, s: string | null) => void> = [];
    let dead = false;
    const gen: Fake = {
      pid: generations.length + 1,
      slot,
      sent: [],
      send(message) {
        gen.sent.push(message);
        const answer = (reply: GenerationMessage): void => queueMicrotask(() => gen.emit(reply));
        if (message.type === GENERATION_MESSAGES.promote) answer({ type: GENERATION_MESSAGES.promoted });
        if (message.type === GENERATION_MESSAGES.shed) answer({ type: GENERATION_MESSAGES.shed_done, beforeBytes: 3_600, afterBytes: 3_600 });
        if (message.type === GENERATION_MESSAGES.shed_workers) answer({ type: GENERATION_MESSAGES.shed_workers_done, beforeBytes: 3_600, afterBytes: 1_000, workers: 7, heapBytes: 2_600 });
        if (message.type === GENERATION_MESSAGES.restore_workers) answer({ type: GENERATION_MESSAGES.restore_workers_done });
        if (message.type === GENERATION_MESSAGES.drain) queueMicrotask(() => gen.die(0));
      },
      onMessage: (l) => void listeners.push(l),
      onExit: (l) => void exits.push(l),
      kill: () => gen.die(null),
      emit: (m) => listeners.forEach((l) => l(m)),
      die(code) {
        if (dead) return;
        dead = true;
        exits.forEach((l) => l(code, null));
      },
    };
    generations.push(gen);
    return gen;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    const asked = generations[Number(socketPath.split("/").pop()) - 1];
    if (opts.neverReady && asked?.slot.sha !== "sha-1" && path.startsWith("/v1/ready")) return { status: 503, body: "warming up" };
    if (path.startsWith("/v1/ready")) return { status: 200, body: JSON.stringify({ ready: true, criteria: [{ name: "read_model_warm", ok: true }] }) };
    if (path === "/v1/version") {
      const gen = generations[Number(socketPath.split("/").pop()) - 1];
      return { status: 200, body: JSON.stringify({ sha: gen?.slot.sha }) };
    }
    return { status: 200, body: "{}" };
  };
  let sha = 1;
  const workersShed = (): boolean => generations[0]?.sent.some((m) => m.type === GENERATION_MESSAGES.shed_workers) ?? false;
  const workersBack = (): boolean => generations[0]?.sent.some((m) => m.type === GENERATION_MESSAGES.restore_workers) ?? false;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn,
    get,
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, extra) => logs.push({ step, extra }),
    exit: () => {},
    // The shed backstop never fires (a healthy generation answers); a retry waits until the test releases it.
    sleep: (ms) => (ms === BACKSTOP_MS ? new Promise<void>(() => {}) : ms >= DEFER_MS ? new Promise<void>((resolve) => void retries.push(resolve)) : Promise.resolve()),
    pollMs: 1,
    drainBackstopMs: 1,
    // W1-T9570: a short shed's settle reads end at once here; their spacing and cap are that task's own test's.
    shedSettleIntervalMs: 1,
    shedSettleCapMs: 3,
    // Free memory is short until the worker threads are gone and, once they are back, short again.
    freeMemory: () => (opts.workersFree && workersShed() && !workersBack() ? FITS : SHORT),
    rss: () => NEED,
    peakRss: () => undefined,
    deferMs: DEFER_MS,
    shedBackstopMs: BACKSTOP_MS,
    socketPathFor: (n) => `/sock/${n}`,
    hostPressure: async () => ({ memAvailableBytes: 64 * 1024 ** 3, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [], atMs: (opts.extra?.clock ?? { now: () => Date.now() }).now() }),
    upgradeThresholds: () => ({ hostReserveBytes: 2 * 1024 ** 3, swapInPagesPerSec: 256, psiSomeAvg10: 10, psiFullAvg10: 2, staleMs: 600_000 }) as never,
    ...opts.extra,
  });
  const release = async (): Promise<void> => {
    retries.shift()?.();
    await tick(5);
  };
  return { supervisor, generations, logs, release, types: (i: number) => generations[i].sent.map((m) => m.type) };
}

test("W1-T8873: a memory-deferred handoff sheds worker threads and fits", async () => {
  const h = harness({ workersFree: true });
  await h.supervisor.start();
  await h.supervisor.requestHandoff();
  const [cold] = h.generations;
  assert.equal(h.logs.filter((l) => l.step === "serve.handoff_deferred").length, 1, "positive control: the first attempt sheds only tier 1, which frees nothing, and defers");
  assert.deepEqual(h.types(0), ["rmd.promote", "rmd.shed"], "the first attempt never touches the worker threads");
  assert.equal(h.generations.length, 1);
  await h.release();
  assert.equal(h.supervisor.activeSha(), "sha-3", "the retry fit once the worker threads were shed");
  const shed = h.logs.find((l) => l.step === "serve.handoff_shed" && l.extra?.tier === 2)?.extra;
  assert.deepEqual(
    { answered: shed?.answered, workers: shed?.workers, workerHeapBytes: shed?.workerHeapBytes, freedBytes: shed?.freedBytes, freeBefore: shed?.freeBefore, freeAfter: shed?.freeAfter, needBytes: shed?.needBytes },
    { answered: true, workers: 7, workerHeapBytes: 2_600, freedBytes: 2_600, freeBefore: SHORT, freeAfter: FITS, needBytes: NEED * HANDOFF_NEED_MARGIN },
    "the tier-2 row carries the freed bytes and the candidate need they were measured against",
  );
  assert.deepEqual(cold.sent.map((m) => m.type), ["rmd.promote", "rmd.shed", "rmd.shed", "rmd.shed_workers", "rmd.drain"], "the shed generation is drained only after the new one is promoted; its workers are not restored");
  assert.equal(h.logs.filter((l) => l.step === "serve.handoff_deferred").length, 1, "no second deferral");
  assert.equal(typeof h.logs.find((l) => l.step === "serve.handoff_done")?.extra?.workersShedMs, "number", "the degraded duration is ledgered at the handoff's end");
  assert.deepEqual(h.types(1), ["rmd.promote"], "the new generation was not asked to shed anything");
});

test("W1-T8873: a still-short attempt restores the worker threads before it defers", async () => {
  const h = harness({ workersFree: false });
  await h.supervisor.start();
  await h.supervisor.requestHandoff();
  await h.release();
  assert.deepEqual(h.types(0), ["rmd.promote", "rmd.shed", "rmd.shed", "rmd.shed_workers", "rmd.restore_workers"], "the threads come back as soon as the shed freed too little");
  assert.equal(h.generations.length, 1, "no standby forks while the candidate does not fit");
  assert.equal(h.logs.filter((l) => l.step === "serve.handoff_deferred").length, 2, "the deferral continues as before");
  const restored = h.logs.find((l) => l.step === "serve.handoff_shed" && l.extra?.phase === "restored")?.extra;
  assert.equal(restored?.reason, "still_short");
  assert.equal(typeof restored?.degradedMs, "number", "the degraded duration is ledgered");
  await h.supervisor.shutdown("test");
});

test("W1-T8873: worker threads are shed at most once per interval", async () => {
  let now = 0;
  const h = harness({ workersFree: false, extra: { clock: { now: () => now, iso: () => "" } as never, workerShedIntervalMs: 900_000 } });
  await h.supervisor.start();
  const sheds = (): number => h.types(0).filter((t) => t === "rmd.shed_workers").length;
  await h.supervisor.requestHandoff();
  assert.equal(sheds(), 0, "the first attempt is tier 1 only");
  for (const at of [1_000, 2_000, 899_999]) {
    now = at;
    await h.release();
    assert.equal(sheds(), 1, `inside the interval (t=${at}) no second shed`);
  }
  now = 901_001;
  await h.release();
  assert.equal(sheds(), 2, "after the interval it sheds again");
  await h.supervisor.shutdown("test");
});

test("W1-T8873: a fitting handoff that is then abandoned restores the worker threads", async () => {
  // The new generation never becomes ready, so the active one keeps serving and must get its threads back.
  let now = 0;
  const h = harness({ workersFree: true, neverReady: true, extra: { clock: { now: () => (now += 1_000), iso: () => "" } as never, readyBoundMs: 5_000 } });
  await h.supervisor.start();
  await h.supervisor.requestHandoff();
  await h.release();
  assert.equal(h.logs.find((l) => l.step === "serve.handoff_aborted")?.extra?.criterion, "ready_bound", "positive control: the standby the shed made room for never became ready");
  assert.equal(h.supervisor.activeSha(), "sha-1");
  assert.deepEqual(h.types(0).slice(-2), ["rmd.restore_workers", "rmd.restore"], "the generation that kept serving gets its worker threads back, then its caches");
  assert.equal(h.logs.find((l) => l.step === "serve.handoff_shed" && l.extra?.phase === "restored")?.extra?.reason, "handoff_abandoned");
});

function channelPair() {
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const sent: GenerationMessage[] = [];
  const channel: GenerationChannel = { send: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) };
  return { channel, sent, deliver: (m: GenerationMessage) => listeners.forEach((l) => l(m)) };
}

test("W1-T8873: the generation terminates its workers, reports the bytes, and restores them on request", async () => {
  const { channel, sent, deliver } = channelPair();
  let resident = 3_600;
  const calls: string[] = [];
  onShedWorkersRequest(
    channel,
    { shed: async () => { calls.push("shed"); resident = 1_000; return { workers: 7, heapBytes: 2_600 }; }, restore: (reason) => void calls.push(`restore:${reason}`) },
    () => resident,
  );
  deliver({ type: "rmd.shed" });
  await tick(1);
  assert.deepEqual(sent, [], "a tier-1 shed is not a worker shed");
  deliver({ type: "rmd.shed_workers" });
  await tick(1);
  assert.deepEqual(sent, [{ type: "rmd.shed_workers_done", beforeBytes: 3_600, afterBytes: 1_000, workers: 7, heapBytes: 2_600 }]);
  deliver({ type: "rmd.restore_workers", reason: "still_short" });
  await tick(1);
  assert.deepEqual(calls, ["shed", "restore:still_short"]);
  assert.deepEqual(sent[1], { type: "rmd.restore_workers_done" });
});

test("W1-T8873: a worker shed or restore that throws is reported, not swallowed", async () => {
  const { channel, sent, deliver } = channelPair();
  onShedWorkersRequest(
    channel,
    { shed: () => { throw new Error("terminate refused"); }, restore: async () => { throw new Error("spawn refused"); } },
    () => 100,
  );
  deliver({ type: "rmd.shed_workers" });
  deliver({ type: "rmd.restore_workers" });
  await tick(1);
  assert.deepEqual(sent.map((m) => ({ type: m.type, error: m.error, workers: m.workers })), [
    { type: "rmd.shed_workers_done", error: "terminate refused", workers: 0 },
    { type: "rmd.restore_workers_done", error: "spawn refused", workers: undefined },
  ]);
});
