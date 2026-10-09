/**
 * src/lib/serve-supervisor.ts handoff spacing: 128 handoffs in 46.2 h were every one `checkout_behind`
 * on a merge serve loads, so the supervisor spaces them by a pressure that grows with recent handoffs
 * and decays. Injected clock and sleep only; generations are in-memory fakes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServeSupervisor, decayedPressure, handoffSpacingMs, type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions } from "../src/lib/serve-supervisor.js";
import type { GenerationMessage } from "../src/lib/serve-generation.js";

const MIN = 60_000;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

/** Generations that promote and drain at once and answer every read 200 at their slot's sha. */
function instantGenerations() {
  const slots = new Map<string, PreparedSlot>();
  let forks = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    slots.set(env.RMD_SERVE_READY_SOCKET, slot);
    forks += 1;
    const onMessage: Array<(m: GenerationMessage) => void> = [];
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
  return { spawn, get, forks: () => forks, command: (slot: PreparedSlot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }) };
}

test("a handoff waits out a spacing that grows with recent handoffs and heals once they stop", async () => {
  const fleet = instantGenerations();
  let now = 0;
  let sha = 1;
  const waits: Array<{ ms: number; wake: () => void }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn: fleet.spawn,
    get: fleet.get,
    command: fleet.command,
    log: (step, extra) => void logs.push({ step, extra }),
    exit: () => {},
    clock: { now: () => now, iso: () => "" } as never,
    sleep: (ms) => new Promise<void>((resolve) => void waits.push({ ms, wake: () => ((now += ms), resolve()) })),
    freeMemory: () => undefined,
    rss: () => undefined,
    peakRss: () => undefined,
    socketPathFor: (n) => `/sock/${n}`,
    spacingBaseMs: 15 * MIN,
    spacingHalfLifeMs: 60 * MIN,
  });
  const spacingRows = () => logs.filter((l) => l.step === "serve.handoff_deferred" && l.extra?.reason === "spacing").map((l) => l.extra!);
  await supervisor.start();
  await supervisor.requestHandoff();
  assert.equal(supervisor.activeSha(), "sha-2", "the first handoff has nothing to be spaced from");

  now = 15 * MIN;
  await supervisor.requestHandoff();
  await supervisor.requestHandoff();
  assert.equal(supervisor.activeSha(), "sha-2", "a handoff 15 minutes after the last one waits: the last one still weighs on it");
  assert.equal(fleet.forks(), 2, "nothing was forked while it waits");
  assert.equal(spacingRows().length, 1, "one deferral row however many asks arrive while it waits");
  const first = spacingRows()[0];
  assert.ok((first.spacingMs as number) > 15 * MIN && (first.spacingMs as number) < 30 * MIN, `spacing ${String(first.spacingMs)}`);
  assert.equal(first.waitMs, (first.spacingMs as number) - 15 * MIN);

  waits.find((w) => w.ms === first.waitMs)!.wake();
  await settle();
  assert.equal(supervisor.activeSha(), "sha-3", "the deferred ask re-runs itself once the spacing has passed");

  now += 15 * MIN;
  await supervisor.requestHandoff();
  assert.equal(supervisor.activeSha(), "sha-3");
  const second = spacingRows()[1];
  assert.ok((second.spacingMs as number) > (first.spacingMs as number), "two handoffs close together widen the next gap");

  waits.find((w) => w.ms === second.waitMs)!.wake();
  await settle();
  assert.equal(supervisor.activeSha(), "sha-4");

  now += 5 * 60 * MIN;
  await supervisor.requestHandoff();
  assert.equal(supervisor.activeSha(), "sha-5", "after a quiet spell the pressure has decayed and the handoff runs at once");
  assert.equal(spacingRows().length, 2);
  assert.ok((logs.filter((l) => l.step === "serve.handoff_done").at(-1)?.extra?.pressure as number) < 1.2, "the ledger carries the decayed pressure");
});

test("handoff pressure halves every half-life and the spacing never falls below its base", () => {
  assert.equal(decayedPressure(undefined, 10, 60), 0);
  assert.equal(decayedPressure({ value: 2, at: 0 }, 60, 60), 1);
  assert.equal(decayedPressure({ value: 2, at: 100 }, 50, 60), 2, "a clock that steps back never inflates pressure");
  assert.equal(handoffSpacingMs(0, 15 * MIN), 15 * MIN);
  assert.equal(handoffSpacingMs(1, 15 * MIN), 30 * MIN);
  assert.equal(handoffSpacingMs(-3, 15 * MIN), 15 * MIN);
});
