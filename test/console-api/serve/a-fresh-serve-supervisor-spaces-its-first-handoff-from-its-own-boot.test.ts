/**
 * W1-T13676: on 2026-11-18 a fresh serve container booted at 06:01:29Z and handed off again at 06:21:51Z for a
 * checkout_behind ask, because a supervisor with no handoff yet was never spaced (W1-T13303 criterion 2). Craig ruled
 * 2026-11-18 that a fresh container waits out the spacing too: production counts its own boot as the last restart.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { runServeSupervisor } from "#src/lib/serve-supervisor-main.js";
import {
  createServeSupervisor, SERVE_HANDOFF_SPACING_BASE_MS, type GenerationProcess, type PreparedSlot, type ServeSupervisor, type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MIN = 60_000;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

/** A supervisor on the production spacing base whose generations promote and drain at once; the test wakes sleeps by hand. */
function supervisorAt(extra: Partial<ServeSupervisorOptions>) {
  const slots = new Map<string, PreparedSlot>();
  let forks = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    slots.set(env.RMD_SERVE_READY_SOCKET, JSON.parse(command.args[0]) as PreparedSlot);
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
  const state = { now: Date.parse("2026-11-18T06:01:29.271Z") };
  let sha = 1;
  const waits: Array<{ ms: number; wake: () => void }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn,
    get: async (socketPath, path) => path === "/v1/version"
      ? { status: 200, body: JSON.stringify({ sha: slots.get(socketPath)?.sha }) }
      : { status: 200, body: JSON.stringify({ ready: true, criteria: [] }) },
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, fields) => void logs.push({ step, extra: fields }),
    exit: () => {},
    clock: { now: () => state.now, iso: () => "" } as never,
    sleep: (ms) => new Promise<void>((resolve) => void waits.push({ ms, wake: () => ((state.now += ms), resolve()) })),
    freeMemory: () => undefined, rss: () => undefined, peakRss: () => 1_000,
    hostPressure: async () => ({ atMs: state.now, memAvailableBytes: 2 ** 40, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] }),
    upgradeThresholds: () => ({ hostReserveBytes: 0, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    socketPathFor: (n) => `/sock/${n}`,
    spacingBaseMs: SERVE_HANDOFF_SPACING_BASE_MS,
    spacingHalfLifeMs: 60 * MIN,
    ...extra,
  });
  const spaced = () => logs.filter((l) => l.step === "serve.handoff_deferred" && l.extra?.reason === "spacing").map((l) => l.extra!);
  return { supervisor, state, waits, logs, spaced };
}

test("W1-T13676 criterion 1: replaying 2026-11-18, a fresh supervisor's first ask 20 minutes after boot waits out the spacing from its boot, then hands off", async () => {
  const s = supervisorAt({ spaceFromBoot: true });
  await s.supervisor.start();
  s.state.now = Date.parse("2026-11-18T06:21:51.000Z");
  await s.supervisor.requestHandoff();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-1", "the 06:21:51Z ask no longer hands off 20 minutes after boot");
  assert.equal(s.spaced().length, 1);
  assert.equal(s.spaced()[0]!.spacingMs, SERVE_HANDOFF_SPACING_BASE_MS, "a boot adds no pressure: the wait is the base window");
  assert.equal(s.spaced()[0]!.waitMs, SERVE_HANDOFF_SPACING_BASE_MS - (Date.parse("2026-11-18T06:21:51.000Z") - Date.parse("2026-11-18T06:01:29.271Z")));
  s.waits.find((w) => w.ms === s.spaced()[0]!.waitMs)!.wake();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-2", "the deferred ask runs itself once two hours from boot have passed");
});

test("W1-T13676 criterion 2: an ask two hours after a fresh boot hands off at once", async () => {
  const s = supervisorAt({ spaceFromBoot: true });
  await s.supervisor.start();
  s.state.now += SERVE_HANDOFF_SPACING_BASE_MS;
  await s.supervisor.requestHandoff();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-2");
  assert.equal(s.spaced().length, 0);
});

test("W1-T13676 criterion 3: serve's production supervisor counts its own boot as the last restart", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-spaced-cold-`));
  const gensDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-spaced-gens-`));
  try {
    writeFileSync(join(repoDir, "package.json"), "{}\n");
    writeFileSync(join(repoDir, "package-lock.json"), "lock");
    let built: ServeSupervisorOptions | undefined;
    const fake: ServeSupervisor = { start: async () => {}, requestHandoff: async () => {}, shutdown: async () => {}, activeSha: () => undefined };
    await runServeSupervisor(["--", "serve", "--port", "4317"], {
      env: { RMD_SERVE_GENS_DIR: gensDir }, cwd: repoDir,
      run: async (command, _args, cwd) => { if (command === "npm") mkdirSync(join(cwd, "node_modules"), { recursive: true }); return ""; },
      headSha: () => "abc123", log: () => {},
      create: (opts) => ((built = opts), fake),
      onSignal: () => {},
    });
    assert.equal(built?.spacingBaseMs, SERVE_HANDOFF_SPACING_BASE_MS);
    assert.equal(built?.spaceFromBoot, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(gensDir, { recursive: true, force: true });
  }
});

test("W1-T13676 criterion 4: without spaceFromBoot the seam keeps the old first-handoff behaviour", async () => {
  const s = supervisorAt({});
  await s.supervisor.start();
  await s.supervisor.requestHandoff();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-2", "a bare supervisor's first ask still runs at once");
  assert.equal(s.spaced().length, 0);
});
