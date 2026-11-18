/**
 * W1-T13744: serve's handoff spacing read the pressure that the handoff just done had raised, so the handoff weighed on
 * its own gap. OBSERVED 2026-11-18: one handoff at about 21:02Z after a quiet spell held the next ask (absorbed at
 * 22:51:57Z, remainingMs 7801186) until 01:02Z, the 4 h cap, never the 2 h base W1-T13303 meant. Under
 * spaceByEarlierHandoffs the spacing counts only the handoffs before the last one.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { runServeSupervisor } from "#src/lib/serve-supervisor-main.js";
import {
  createServeSupervisor, SERVE_HANDOFF_SPACING_BASE_MS, SERVE_HANDOFF_SPACING_MAX_MS, type GenerationProcess, type PreparedSlot, type ServeSupervisor,
  type ServeSupervisorOptions,
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
  const state = { now: Date.parse("2026-11-18T19:18:00.000Z") };
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

const HOUR = 60 * MIN;
const at = (iso: string): number => Date.parse(`2026-11-18T${iso}Z`);

/** One handoff at 21:02Z after a quiet spell, then the ask a minute later that opens the spacing wait. */
async function oneHandoffThenAsk(extra: Partial<ServeSupervisorOptions>) {
  const s = supervisorAt(extra);
  await s.supervisor.start();
  s.state.now = at("21:02:00");
  await s.supervisor.requestHandoff();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-2", "positive control: the 21:02Z handoff ran");
  s.state.now = at("21:03:00");
  await s.supervisor.requestHandoff();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-2", "positive control: the 21:03Z ask waits");
  assert.equal(s.spaced().length, 1);
  return s;
}

test("W1-T13744 criterion 1: replaying 2026-11-18, one handoff at 21:02Z waits the 2 h base and hands off at 23:02Z, not at the 4 h cap", async () => {
  const s = await oneHandoffThenAsk({ spaceByEarlierHandoffs: true });
  const row = s.spaced()[0]!;
  assert.equal(row.spacingMs, SERVE_HANDOFF_SPACING_BASE_MS, "the handoff just done adds nothing to its own gap");
  assert.equal(row.pressure, 0);
  assert.equal(row.waitMs, at("23:02:00") - at("21:03:00"));
  s.state.now = at("22:51:57");
  await s.supervisor.requestHandoff();
  await settle();
  const absorbed = s.logs.filter((l) => l.step === "serve.handoff_spacing_absorbed").map((l) => l.extra!);
  assert.equal(absorbed.at(-1)?.remainingMs, at("23:02:00") - at("22:51:57"), "the 22:51:57Z ask now waits 10 minutes, not 7801186 ms");
  s.state.now = at("21:03:00");
  s.waits.find((w) => w.ms === row.waitMs)!.wake();
  await settle();
  assert.equal(s.state.now, at("23:02:00"));
  assert.equal(s.supervisor.activeSha(), "sha-3", "the deferred ask hands off at 23:02Z");
});

test("W1-T13744 criterion 2: earlier handoffs still stretch the next gap past the base, up to SERVE_HANDOFF_SPACING_MAX_MS", async () => {
  // A half-life far longer than the test keeps each earlier handoff at full weight, as three in quick succession would be.
  const s = await oneHandoffThenAsk({ spaceByEarlierHandoffs: true, spacingHalfLifeMs: 1_000 * HOUR });
  s.waits.find((w) => w.ms === s.spaced()[0]!.waitMs)!.wake();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-3", "positive control: the second handoff ran");
  s.state.now += MIN;
  await s.supervisor.requestHandoff();
  await settle();
  const second = s.spaced()[1]!;
  assert.ok((second.pressure as number) > 0.99, `one earlier handoff weighs on the gap: pressure ${String(second.pressure)}`);
  assert.ok((second.spacingMs as number) > SERVE_HANDOFF_SPACING_BASE_MS, `spacing ${String(second.spacingMs)}`);
  s.waits.find((w) => w.ms === second.waitMs)!.wake();
  await settle();
  assert.equal(s.supervisor.activeSha(), "sha-4", "positive control: the third handoff ran");
  s.state.now += MIN;
  await s.supervisor.requestHandoff();
  await settle();
  const third = s.spaced()[2]!;
  assert.ok((third.pressure as number) > 1.99, `two earlier handoffs: pressure ${String(third.pressure)}`);
  assert.equal(third.spacingMs, SERVE_HANDOFF_SPACING_MAX_MS, "the cap still bounds the stretch");
});

test("W1-T13744 criterion 3: serve's production supervisor passes spaceByEarlierHandoffs: true", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}earlier-spaced-cold-`));
  const gensDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}earlier-spaced-gens-`));
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
    assert.equal(built?.spacingBaseMs, SERVE_HANDOFF_SPACING_BASE_MS, "positive control: the production options were captured");
    assert.equal(built?.spaceByEarlierHandoffs, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(gensDir, { recursive: true, force: true });
  }
});

test("W1-T13744 criterion 4: invariant:seam-default-unchanged — without the option the handoff just done still weighs on its gap, and handoff_done carries the full pressure", async () => {
  const bare = await oneHandoffThenAsk({});
  const level = Math.pow(0.5, MIN / HOUR);
  assert.equal(bare.spaced()[0]!.spacingMs, SERVE_HANDOFF_SPACING_BASE_MS * (1 + level), "the seam default reads the pressure including the last handoff");
  assert.equal(bare.spaced()[0]!.pressure, Number(level.toFixed(3)));
  const opted = await oneHandoffThenAsk({ spaceByEarlierHandoffs: true });
  for (const s of [bare, opted]) {
    const done = s.logs.filter((l) => l.step === "serve.handoff_done").map((l) => l.extra!);
    assert.equal(done.at(-1)?.pressure, 1, "serve.handoff_done still counts the handoff it records");
  }
});
