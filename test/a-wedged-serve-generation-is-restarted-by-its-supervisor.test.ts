/**
 * W1-T13276: the supervisor probes the generation that is serving and restarts one that answers nothing.
 * Every test drives createServeSupervisor with fake generations, a fake clock, a fake scheduler and an injected probe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_PROBE_FAILURES,
  ACTIVE_PROBE_INTERVAL_MS,
  ACTIVE_PROBE_PUBLIC_PATH,
  ACTIVE_PROBE_TIMEOUT_MS,
  ACTIVE_WEDGE_RESTART_FLOOR_MS,
  SMOKE_PATHS,
  createServeSupervisor,
  socketStatesForPort,
  type PreparedSlot,
  type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Fake {
  pid: number;
  sent: GenerationMessage[];
  killed: string[];
  slot: PreparedSlot;
  killThrows?: boolean;
  send(m: GenerationMessage): void;
  onMessage(l: (m: GenerationMessage) => void): void;
  onExit(l: (c: number | null, s: string | null) => void): void;
  kill(s: string): void;
}

function rig(extra: Partial<ServeSupervisorOptions> = {}, probe: (socketPath: string, path: string, timeoutMs: number) => Promise<{ status: number }> = async () => ({ status: 200 })) {
  const gens: Fake[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exits: number[] = [];
  const probes: Array<{ socketPath: string; path: string; timeoutMs: number }> = [];
  let now = 1_000_000;
  const scheduled: Array<{ ms: number; cancelled: boolean; tick: () => void }> = [];
  let killThrows = false;
  const spawn: ServeSupervisorOptions["spawn"] = (command) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    const messages: Array<(m: GenerationMessage) => void> = [];
    const exitsL: Array<(c: number | null, s: string | null) => void> = [];
    let dead = false;
    const die = (code: number | null, signal: string | null): void => {
      if (dead) return;
      dead = true;
      exitsL.forEach((l) => l(code, signal));
    };
    const gen: Fake = {
      pid: gens.length + 100,
      sent: [],
      killed: [],
      slot,
      send(m) {
        gen.sent.push(m);
        if (m.type === "rmd.promote") queueMicrotask(() => messages.forEach((l) => l({ type: "rmd.promoted" })));
        if (m.type === "rmd.drain") queueMicrotask(() => die(0, null));
      },
      onMessage: (l) => void messages.push(l),
      onExit: (l) => void exitsL.push(l),
      kill(signal) {
        if (killThrows) {
          killThrows = false; // the restart path's kill fails once; the legacy exit's drain backstop then succeeds
          throw new Error("no such process");
        }
        gen.killed.push(signal);
        die(null, signal);
      },
    };
    gens.push(gen);
    return gen;
  };
  const get: ServeSupervisorOptions["get"] = async (_socket, path) => {
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: "sha-1" }) };
    if (path.startsWith("/v1/ready")) return { status: 200, body: JSON.stringify({ ready: true, criteria: [] }) };
    return { status: 200, body: "{}" };
  };
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async () => ({ dir: "/slot-b", sha: "sha-2" }),
    spawn,
    get,
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    socketPathFor: (n) => `/fake/gen-${n}.sock`,
    log: (step, e) => logs.push({ step, extra: e }),
    exit: (code) => exits.push(code),
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    sleep: async () => {},
    activeProbe: (socketPath, path, timeoutMs) => {
      probes.push({ socketPath, path, timeoutMs });
      return probe(socketPath, path, timeoutMs);
    },
    every: (tick, ms) => {
      const entry = { ms, cancelled: false, tick };
      scheduled.push(entry);
      return () => void (entry.cancelled = true);
    },
    socketStates: () => ({ CLOSE_WAIT: 444, LISTEN: 1 }),
    privateProbe: async () => ({ status: 200 }),
    ...extra,
  });
  return {
    supervisor, gens, logs, exits, probes, scheduled,
    advance: (ms: number) => void (now += ms),
    killThrows: (v: boolean) => void (killThrows = v),
    /** One probe interval elapses. */
    fire: async () => {
      now += ACTIVE_PROBE_INTERVAL_MS;
      scheduled[0]?.tick();
      await settle();
    },
    steps: (name: string) => logs.filter((l) => l.step === name),
  };
}

test("W1-T13276 criterion 1: an active generation that answers nothing three times is recorded and restarted", async () => {
  const refused = new Error("ECONNREFUSED");
  const r = rig({}, async () => {
    throw refused;
  });
  await r.supervisor.start();
  assert.equal(r.scheduled.length, 1, "one timer, started when the first generation is active");
  assert.equal(r.scheduled[0]?.ms, ACTIVE_PROBE_INTERVAL_MS);
  assert.equal(ACTIVE_PROBE_INTERVAL_MS, 60_000);
  assert.equal(ACTIVE_PROBE_TIMEOUT_MS, 10_000);
  assert.equal(ACTIVE_PROBE_FAILURES, 3);

  await r.fire();
  await r.fire();
  assert.equal(r.steps("serve.active_wedged").length, 0, "two unanswered probes are not a wedge");
  assert.equal(r.gens.length, 1);
  await r.fire();

  assert.deepEqual(r.probes[0], { socketPath: "/fake/gen-1.sock", path: ACTIVE_PROBE_PUBLIC_PATH, timeoutMs: ACTIVE_PROBE_TIMEOUT_MS });
  const rows = r.steps("serve.active_wedged");
  assert.equal(rows.length, 1, "exactly one row");
  assert.deepEqual(rows[0]?.extra, {
    generation: 1, sha: "sha-1", pid: 100, failures: 3, lastError: "ECONNREFUSED", uptimeMs: 3 * ACTIVE_PROBE_INTERVAL_MS, sockets: { CLOSE_WAIT: 444, LISTEN: 1 },
    probedPort: 4317, privateSocket: { answered: true, status: 200 },
  });
  assert.deepEqual(r.gens[0]?.killed, ["SIGKILL"]);
  assert.equal(r.gens.length, 2, "the generation was replaced by the existing restart path");
  assert.equal(r.gens[1]?.slot.sha, "sha-1", "a wedge is not a bad build: the same slot restarts");
  assert.equal(r.steps("serve.handoff_rolled_back").length, 0);
  assert.equal(r.supervisor.activeSha(), "sha-1");
  assert.deepEqual(r.exits, []);
});

test("W1-T13276 criterion 1: a probe that never resolves is cut at its bound and counts as unanswered", async () => {
  const r = rig({ activeProbeTimeoutMs: 5 }, () => new Promise(() => {}));
  await r.supervisor.start();
  const tick = async (): Promise<void> => {
    r.advance(ACTIVE_PROBE_INTERVAL_MS);
    r.scheduled[0]?.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  };
  await tick();
  await tick();
  await tick();
  const row = r.steps("serve.active_wedged")[0];
  assert.ok(row, "three bounded probes wedge it");
  assert.equal(row.extra?.lastError, "timed out after 5 ms");
});

test("W1-T13276 criterion 2: one answered probe resets the count", async () => {
  let call = 0;
  const r = rig({}, async () => {
    call += 1;
    if (call === 3) return { status: 200 };
    throw new Error("timed out");
  });
  await r.supervisor.start();
  for (let i = 0; i < 5; i++) await r.fire(); // fail, fail, answer, fail, fail
  assert.equal(r.steps("serve.active_wedged").length, 0, "the answer in the middle started the count over");
  await r.fire(); // the third failure since the answer
  assert.equal(r.steps("serve.active_wedged").length, 1);
});

test("W1-T13276 criterion 2: no probe runs during a handoff, a drain or the standby readiness wait", async () => {
  let release!: (slot: PreparedSlot) => void;
  const r = rig({ prepare: () => new Promise<PreparedSlot>((resolve) => (release = resolve)) }, async () => {
    throw new Error("timed out");
  });
  await r.supervisor.start();
  await r.fire();
  assert.equal(r.probes.length, 1);

  const handoff = r.supervisor.requestHandoff();
  await settle();
  for (let i = 0; i < 6; i++) await r.fire();
  assert.equal(r.probes.length, 1, "no probe while the handoff is in flight");
  assert.equal(r.steps("serve.active_wedged").length, 0);

  release({ dir: "/slot-b", sha: "sha-1" }); // the same sha: the handoff ends as skipped
  await handoff;
  await r.fire();
  assert.equal(r.probes.length, 2, "probing resumes once the handoff has ended");

  const draining = r.supervisor.shutdown("test");
  await draining;
  await r.fire();
  assert.equal(r.probes.length, 2, "no probe once the supervisor drains");
  assert.equal(r.scheduled[0]?.cancelled, true, "the timer is cancelled at shutdown");
});

test("W1-T13276 criterion 2: a handoff that begins mid-probe discards that probe's verdict", async () => {
  let resolveProbe!: () => void;
  let calls = 0;
  const r = rig({ prepare: () => new Promise<PreparedSlot>(() => {}) }, () => {
    calls += 1;
    return new Promise<{ status: number }>((_, reject) => (resolveProbe = () => reject(new Error("timed out"))));
  });
  await r.supervisor.start();
  r.scheduled[0]?.tick();
  await settle();
  assert.equal(calls, 1);
  void r.supervisor.requestHandoff();
  await settle();
  resolveProbe();
  await settle();
  for (let i = 0; i < 2; i++) await r.fire();
  assert.equal(r.probes.length, 1, "the in-flight handoff still blocks probes");
  assert.equal(r.steps("serve.active_wedged").length, 0);
});

test("W1-T13276 criterion 2: a second wedge inside the floor is held, and one after it restarts again", async () => {
  const r = rig({}, async () => {
    throw new Error("timed out");
  });
  await r.supervisor.start();
  for (let i = 0; i < 3; i++) await r.fire();
  assert.equal(r.steps("serve.active_wedged").length, 1);
  assert.equal(r.gens.length, 2);

  for (let i = 0; i < 3; i++) await r.fire();
  const held = r.steps("serve.active_wedged_held");
  assert.equal(held.length, 1, "the second wedge is recorded as held");
  assert.equal(held[0]?.extra?.generation, 2);
  assert.equal(held[0]?.extra?.floorMs, ACTIVE_WEDGE_RESTART_FLOOR_MS);
  assert.equal(held[0]?.extra?.failures, 3);
  assert.equal(r.steps("serve.active_wedged").length, 1, "held writes no second serve.active_wedged row");
  assert.equal(r.gens.length, 2, "and restarts nothing");
  assert.deepEqual(r.gens[1]?.killed, []);

  r.advance(ACTIVE_WEDGE_RESTART_FLOOR_MS);
  for (let i = 0; i < 3; i++) await r.fire();
  assert.equal(r.steps("serve.active_wedged").length, 2, "past the floor the wedge restarts it");
  assert.equal(r.gens.length, 3);
  assert.equal(ACTIVE_WEDGE_RESTART_FLOOR_MS, 15 * 60_000);
});

test("W1-T13276 criterion 2: a restart path that cannot kill falls back to the legacy exit", async () => {
  const r = rig({}, async () => {
    throw new Error("timed out");
  });
  await r.supervisor.start();
  r.killThrows(true);
  for (let i = 0; i < 3; i++) await r.fire();
  assert.equal(r.steps("serve.active_wedge_kill_failed")[0]?.extra?.reason, "no such process");
  assert.equal(r.steps("serve.handoff_legacy_exit")[0]?.extra?.reason, "active_wedged");
  assert.deepEqual(r.exits, [0]);
});

test("W1-T13276 criterion 2: an unreadable socket census and a failing ledger write are recorded, not fatal", async () => {
  const r = rig(
    { socketStates: () => { throw new Error("no /proc"); } },
    async () => {
      throw new Error("timed out");
    },
  );
  await r.supervisor.start();
  for (let i = 0; i < 3; i++) await r.fire();
  assert.equal(r.steps("serve.active_wedge_snapshot_unread")[0]?.extra?.reason, "no /proc");
  assert.equal(r.steps("serve.active_wedged")[0]?.extra?.sockets, undefined, "the row is still written, without the census");

  const throwing = rig(
    { log: (step) => { if (step === "serve.active_wedged") throw new Error("ledger down"); } },
    async () => {
      throw new Error("timed out");
    },
  );
  await throwing.supervisor.start();
  for (let i = 0; i < 3; i++) await throwing.fire();
  assert.equal(throwing.gens.length, 1, "nothing restarted, and nothing escaped the timer");
});

test("W1-T13276 criterion 3: a probe answered with any HTTP status inside the bound is alive", async () => {
  const statuses = [200, 401, 503, 500, 404, 302];
  let i = 0;
  const r = rig({}, async () => ({ status: statuses[i++ % statuses.length]! }));
  await r.supervisor.start();
  for (let n = 0; n < statuses.length * 3; n++) await r.fire();
  assert.equal(r.probes.length, statuses.length * 3, "every interval probed");
  assert.equal(r.steps("serve.active_wedged").length, 0, "a 401 or a 503 is an answer, not a wedge");
  assert.equal(r.steps("serve.active_wedged_held").length, 0);
  assert.equal(r.gens.length, 1);
});

test("W1-T13276 criterion 3: a slow answer inside the bound is not a wedge, and a refusal is", async () => {
  const slow = rig({}, () => new Promise<{ status: number }>((resolve) => setTimeout(() => resolve({ status: 503 }), 20)));
  await slow.supervisor.start();
  for (let n = 0; n < 4; n++) {
    slow.advance(ACTIVE_PROBE_INTERVAL_MS);
    slow.scheduled[0]?.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  }
  assert.equal(slow.probes.length, 4);
  assert.equal(slow.steps("serve.active_wedged").length, 0);

  const refused = rig({}, async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  });
  await refused.supervisor.start();
  for (let n = 0; n < 3; n++) await refused.fire();
  assert.equal(refused.steps("serve.active_wedged")[0]?.extra?.lastError, "connect ECONNREFUSED");
});

test("W1-T13276 criterion 3: the default probe really GETs the serve port and counts a 503 as alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-wedge-"));
  const socketPath = join(dir, "g.sock");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.statusCode = 503;
    res.end("warming");
  });
  // W1-T13503: the default probe goes to the TCP port serve binds, the accept queue the tunnel's connections enter.
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const ticks: Array<() => void> = [];
    const r = createServeSupervisor({
      coldSlot: { dir: "/cold", sha: "sha-1" },
      prepare: async () => ({ dir: "/b", sha: "sha-2" }),
      spawn: () => {
        const messages: Array<(m: GenerationMessage) => void> = [];
        return {
          pid: 1, send: (m) => void (m.type === "rmd.promote" && queueMicrotask(() => messages.forEach((l) => l({ type: "rmd.promoted" })))),
          onMessage: (l) => void messages.push(l), onExit: () => undefined, kill: () => undefined,
        };
      },
      get: async (_s, path) => ({ status: 200, body: path === "/v1/version" ? JSON.stringify({ sha: "sha-1" }) : "{}" }),
      command: (slot) => ({ exec: "gen", execArgv: [], args: [], cwd: slot.dir }),
      socketPathFor: () => socketPath,
      serveArgs: ["serve", "--port", String(port)],
      log: () => undefined,
      exit: () => undefined,
      every: (tick) => {
        ticks.push(tick);
        return () => undefined;
      },
    });
    await r.start();
    ticks[0]?.();
    for (let i = 0; i < 20 && seen.length === 0; i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seen, [ACTIVE_PROBE_PUBLIC_PATH]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13276 criterion 1: the default timer is an unref'd interval cancelled at shutdown", async () => {
  const r = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async () => ({ dir: "/b", sha: "sha-2" }),
    spawn: () => {
      const messages: Array<(m: GenerationMessage) => void> = [];
      const exitsL: Array<(c: number | null, s: string | null) => void> = [];
      return {
        pid: 1, send: (m) => void (m.type === "rmd.promote" && queueMicrotask(() => messages.forEach((l) => l({ type: "rmd.promoted" })))),
        onMessage: (l) => void messages.push(l), onExit: (l) => void exitsL.push(l), kill: (signal) => exitsL.forEach((l) => l(null, signal)),
      };
    },
    get: async (_s, path) => ({ status: 200, body: path === "/v1/version" ? JSON.stringify({ sha: "sha-1" }) : "{}" }),
    command: (slot) => ({ exec: "gen", execArgv: [], args: [], cwd: slot.dir }),
    log: () => undefined,
    exit: () => undefined,
    sleep: async () => {},
  });
  await r.start();
  await r.shutdown("test");
  assert.equal(r.activeSha(), "sha-1");
});

test("W1-T13276 criterion 1: the post-mortem census counts sockets on the serve port by TCP state", () => {
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const row = (local: string, st: string): string => `   0: ${local} 0100007F:9C40 ${st} 00000000:00000000 00:00000000 00000000     0        0 1\n`;
  const tcp = header + row("00000000:10DD", "08") + row("00000000:10DD", "08") + row("0100007F:10DD", "01") + row("00000000:0050", "0A") + row("00000000:10DD", "FF");
  const tcp6 = header + row("00000000000000000000000000000000:10DD", "0A");
  const read = (path: string): string => {
    if (path === "/proc/net/tcp") return tcp;
    if (path === "/proc/net/tcp6") return tcp6;
    throw new Error("ENOENT");
  };
  assert.deepEqual(socketStatesForPort(4317, read), { CLOSE_WAIT: 2, ESTABLISHED: 1, "0xFF": 1, LISTEN: 1 });
  assert.deepEqual(socketStatesForPort(4317, (path) => { if (path === "/proc/net/tcp") return tcp; throw new Error("ENOENT"); }), { CLOSE_WAIT: 2, ESTABLISHED: 1, "0xFF": 1 });
  assert.deepEqual(socketStatesForPort(4317, () => { throw new Error("ENOENT"); }), {}, "no table readable: an empty census, not an error");
  assert.equal(typeof socketStatesForPort(1), "object", "the real /proc read does not throw");
});
