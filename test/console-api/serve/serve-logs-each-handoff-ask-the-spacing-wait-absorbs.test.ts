/**
 * W1-T13534: src/lib/serve-supervisor.ts awaitSpacing returned silently on an ask that arrived while a spacing
 * wait was pending. OBSERVED 2026-11-17: a 3.45 h wait (spacingMs 13291701) absorbed asks at 22:48Z and 23:03Z and
 * no row said so. Each absorbed ask now writes serve.handoff_spacing_absorbed, and the pressure stretch is capped
 * at SERVE_HANDOFF_SPACING_MAX_MS. Injected clock and sleep only; generations are in-memory fakes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createServeSupervisor,
  handoffSpacingMs,
  SERVE_HANDOFF_SPACING_BASE_MS,
  SERVE_HANDOFF_SPACING_MAX_MS,
  type GenerationProcess,
  type PreparedSlot,
  type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import { GENERATION_MESSAGES, type GenerationMessage } from "#src/lib/serve-generation.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

type Row = { step: string; extra?: Record<string, unknown> };

/** Generations that promote and drain at once; `ask` sends a handoff request from the newest one over its IPC. */
function instantGenerations() {
  const slots = new Map<string, PreparedSlot>();
  const listeners: Array<Array<(m: GenerationMessage) => void>> = [];
  let forks = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    slots.set(env.RMD_SERVE_READY_SOCKET, slot);
    forks += 1;
    const onMessage: Array<(m: GenerationMessage) => void> = [];
    listeners.push(onMessage);
    const onExit: Array<(c: number | null, s: string | null) => void> = [];
    const generation: GenerationProcess = {
      pid: forks,
      send(message) {
        if (message.type === "rmd.promote") queueMicrotask(() => onMessage.forEach((l) => l({ type: "rmd.promoted" })));
        if (message.type === "rmd.drain") queueMicrotask(() => onExit.forEach((l) => l(0, null)));
      },
      onMessage: (l) => void onMessage.push(l),
      onExit: (l) => void onExit.push(l),
      kill: () => onExit.forEach((l) => l(null, "SIGKILL")),
    };
    return generation;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    const slot = slots.get(socketPath);
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: slot?.sha }) };
    return { status: 200, body: JSON.stringify({ ready: true, criteria: [] }) };
  };
  const ask = (detail: Record<string, unknown>): void => listeners.at(-1)!.forEach((l) => l({ ...detail, type: GENERATION_MESSAGES.handoffRequest }));
  return { spawn, get, ask, forks: () => forks, command: (slot: PreparedSlot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }) };
}

/** A supervisor on the production spacing base, with a fake clock and sleeps the test wakes by hand. */
function productionSpaced(halfLifeMs = 60 * MIN) {
  const fleet = instantGenerations();
  const state = { now: 0 };
  let sha = 1;
  const waits: Array<{ ms: number; wake: () => void }> = [];
  const logs: Row[] = [];
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn: fleet.spawn, get: fleet.get, command: fleet.command,
    log: (step, extra) => void logs.push({ step, extra }),
    exit: () => {},
    clock: { now: () => state.now, iso: () => "" } as never,
    sleep: (ms) => new Promise<void>((resolve) => void waits.push({ ms, wake: () => ((state.now += ms), resolve()) })),
    freeMemory: () => undefined, rss: () => undefined, peakRss: () => 1_000,
    hostPressure: async () => ({ atMs: state.now, memAvailableBytes: 2 ** 40, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] }),
    upgradeThresholds: () => ({ hostReserveBytes: 0, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    socketPathFor: (n) => `/sock/${n}`,
    spacingBaseMs: SERVE_HANDOFF_SPACING_BASE_MS,
    spacingHalfLifeMs: halfLifeMs,
  });
  const rows = (step: string) => logs.filter((l) => l.step === step).map((l) => l.extra!);
  const spacingRows = () => rows("serve.handoff_deferred").filter((r) => r.reason === "spacing");
  return { supervisor, state, logs, fleet, waits, rows, spacingRows };
}

/** One handoff done, then a second ask 15 minutes later that opens a spacing wait. */
async function openSpacingWait(halfLifeMs?: number) {
  const rig = productionSpaced(halfLifeMs);
  await rig.supervisor.start();
  await rig.supervisor.requestHandoff();
  await settle();
  assert.equal(rig.supervisor.activeSha(), "sha-2", "positive control: the first handoff ran unspaced");
  rig.state.now += 15 * MIN;
  rig.fleet.ask({ reason: "checkout_behind", currentSha: "sha-2", targetSha: "c287903b2" });
  await settle();
  assert.equal(rig.spacingRows().length, 1, "positive control: the ask opened one spacing wait");
  return rig;
}

test("W1-T13534 criterion 1: A handoff ask that arrives while a spacing wait is pending writes serve.handoff_spacing_absorbed with the asked sha, the remaining wait in ms and the count of asks absorbed so far", async () => {
  const rig = await openSpacingWait();
  const waitMs = rig.spacingRows()[0]!.waitMs as number;
  assert.equal(rig.rows("serve.handoff_spacing_absorbed").length, 0, "the ask that opened the wait is not an absorbed one");

  rig.state.now += 15 * MIN;
  rig.fleet.ask({ reason: "checkout_behind", currentSha: "sha-2", targetSha: "c287903b2" });
  await settle();
  rig.state.now += 15 * MIN;
  rig.fleet.ask({ reason: "checkout_behind", currentSha: "sha-2", targetSha: "d00dfeed1" });
  await settle();

  assert.deepEqual(rig.rows("serve.handoff_spacing_absorbed"), [
    { sha: "c287903b2", remainingMs: waitMs - 15 * MIN, absorbed: 1 },
    { sha: "d00dfeed1", remainingMs: waitMs - 30 * MIN, absorbed: 2 },
  ]);
  assert.equal(rig.spacingRows().length, 1, "still one serve.handoff_deferred spacing row per wait");
  assert.equal(rig.supervisor.activeSha(), "sha-2", "an absorbed ask still hands nothing off");

  // An ask with no known target (a direct requestHandoff) is still logged, without a sha.
  rig.state.now += 1 * MIN;
  await rig.supervisor.requestHandoff();
  const last = rig.rows("serve.handoff_spacing_absorbed").at(-1)!;
  assert.equal(last.sha, undefined);
  assert.equal(last.absorbed, 3);
  assert.equal(last.remainingMs, waitMs - 31 * MIN);
});

test("W1-T13534 criterion 2: When the wait ends, the one re-ask still runs exactly one handoff, as before", async () => {
  const rig = await openSpacingWait();
  const waitMs = rig.spacingRows()[0]!.waitMs as number;
  const sleepsBefore = rig.waits.length;
  for (let i = 0; i < 3; i += 1) {
    rig.state.now += 10 * MIN;
    rig.fleet.ask({ reason: "checkout_behind", currentSha: "sha-2", targetSha: `t-${i}` });
    await settle();
  }
  assert.equal(rig.rows("serve.handoff_spacing_absorbed").length, 3);
  const forksBefore = rig.fleet.forks();
  const doneBefore = rig.rows("serve.handoff_done").length;

  assert.equal(rig.waits.length, sleepsBefore, "an absorbed ask queues no re-ask of its own: the wait holds the only re-ask");
  const pending = rig.waits.filter((w) => w.ms === waitMs);
  assert.equal(pending.length, 1, "one sleep for the wait, however many asks it absorbed");
  rig.state.now = 15 * MIN; // the sleep advances the clock from the moment the wait opened
  pending[0]!.wake();
  await settle();
  assert.equal(rig.supervisor.activeSha(), "sha-3", "the re-ask ran the handoff");
  assert.equal(rig.fleet.forks(), forksBefore + 1, "exactly one fork");
  assert.equal(rig.rows("serve.handoff_done").length, doneBefore + 1, "exactly one handoff");

  // The count resets when the wait ends: the next wait's first absorbed ask counts from 1.
  rig.state.now += 15 * MIN;
  rig.fleet.ask({ reason: "checkout_behind", currentSha: "sha-3", targetSha: "next-1" });
  await settle();
  assert.equal(rig.spacingRows().length, 2, "positive control: a second wait opened");
  rig.state.now += 1 * MIN;
  rig.fleet.ask({ reason: "checkout_behind", currentSha: "sha-3", targetSha: "next-2" });
  await settle();
  const last = rig.rows("serve.handoff_spacing_absorbed").at(-1)!;
  assert.equal(last.sha, "next-2");
  assert.equal(last.absorbed, 1, "the count restarted with the new wait");
});

test("W1-T13534 criterion 3: handoffSpacingMs never exceeds SERVE_HANDOFF_SPACING_MAX_MS, twice SERVE_HANDOFF_SPACING_BASE_MS, however high the pressure", async () => {
  assert.equal(SERVE_HANDOFF_SPACING_MAX_MS, 2 * SERVE_HANDOFF_SPACING_BASE_MS);
  for (const pressure of [1, 1.5, 2, 10, 1e6, Number.MAX_VALUE]) {
    assert.ok(handoffSpacingMs(pressure, SERVE_HANDOFF_SPACING_BASE_MS) <= SERVE_HANDOFF_SPACING_MAX_MS, `pressure ${pressure}`);
  }
  assert.equal(handoffSpacingMs(1e6, SERVE_HANDOFF_SPACING_BASE_MS), SERVE_HANDOFF_SPACING_MAX_MS);

  // Through the supervisor: with pressure that never decays, a third handoff's uncapped spacing would be 6 h.
  const rig = await openSpacingWait(1_000 * HOUR);
  const firstWait = rig.spacingRows()[0]!;
  rig.waits.find((w) => w.ms === firstWait.waitMs)!.wake();
  await settle();
  assert.equal(rig.supervisor.activeSha(), "sha-3", "positive control: the second handoff ran");
  rig.state.now += 15 * MIN;
  await rig.supervisor.requestHandoff();
  const second = rig.spacingRows()[1]!;
  assert.ok((second.pressure as number) > 1.9, `pressure ${String(second.pressure)} would stretch past the cap`);
  assert.equal(second.spacingMs, SERVE_HANDOFF_SPACING_MAX_MS);
  assert.ok(Math.abs((second.waitMs as number) - (SERVE_HANDOFF_SPACING_MAX_MS - 15 * MIN)) < 1, `waitMs ${String(second.waitMs)}`);
});

test("W1-T13534 criterion 4: invariant:pressure-still-stretches — below the cap, handoffSpacingMs still grows with pressure, and the first serve.handoff_deferred spacing row is unchanged", async () => {
  const base = SERVE_HANDOFF_SPACING_BASE_MS;
  assert.equal(handoffSpacingMs(0, base), base);
  assert.equal(handoffSpacingMs(0.25, base), 1.25 * base);
  assert.equal(handoffSpacingMs(0.5, base), 1.5 * base);
  assert.equal(handoffSpacingMs(0.9, base), 1.9 * base);
  assert.ok(handoffSpacingMs(0.5, base) > handoffSpacingMs(0.25, base));
  assert.equal(handoffSpacingMs(1, 15 * MIN), 30 * MIN, "a small base still doubles at pressure 1");

  const rig = await openSpacingWait();
  const level = Math.pow(0.5, (15 * MIN) / (60 * MIN));
  const spacingMs = base * (1 + level);
  assert.deepEqual(rig.spacingRows()[0], {
    reason: "spacing",
    waitMs: spacingMs - 15 * MIN,
    spacingMs,
    pressure: Number(level.toFixed(3)),
    sinceLastMs: 15 * MIN,
    sha: "sha-2",
  });
});
