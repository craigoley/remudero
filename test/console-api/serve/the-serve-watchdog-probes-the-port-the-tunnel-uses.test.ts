/**
 * W1-T13503: THE SERVE WATCHDOG PROBES THE PORT THE TUNNEL USES.
 *
 * MEASURED 2026-11-16: a 40-minute serve wedge left the generation's event loop healthy (runtime.loop_lag p99 60-97 ms,
 * background rows still written) while 455 connections sat unaccepted on 4317. W1-T13276's watchdog probed the
 * generation's PRIVATE unix socket, which has its own listener, so it would have kept answering. These tests drive the
 * real createServeSupervisor with its REAL default probes (a TCP GET and a unix-socket GET), never injected ones.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ACTIVE_PROBE_FAILURES,
  ACTIVE_PROBE_PUBLIC_PATH,
  ACTIVE_WEDGE_SERVE_PORT,
  SMOKE_PATHS,
  createServeSupervisor,
  servePortOf,
  tcpGet,
  type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { createService } from "#src/lib/service.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const listen = (server: Server, at: number | string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    if (typeof at === "string") server.listen(at, resolve);
    else server.listen(at, "127.0.0.1", resolve);
  });
const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls until `ready()` holds or `ms` pass, so a slow runner waits for the row instead of racing a fixed sleep. */
const until = async (ready: () => boolean, ms = 10_000): Promise<void> => {
  for (const end = Date.now() + ms; !ready() && Date.now() < end; ) await wait(20);
};

/** A supervisor over one fake generation whose private socket is `socketPath`, serving `--port <port>`. */
function supervise(socketPath: string, port: number, extra: Partial<ServeSupervisorOptions> = {}) {
  const ticks: Array<() => void> = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const killed: string[] = [];
  let spawned = 0;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async () => ({ dir: "/b", sha: "sha-2" }),
    spawn: () => {
      spawned += 1;
      const messages: Array<(m: GenerationMessage) => void> = [];
      const exits: Array<(c: number | null, s: string | null) => void> = [];
      return {
        pid: 100 + spawned,
        send: (m) => void (m.type === "rmd.promote" && queueMicrotask(() => messages.forEach((l) => l({ type: "rmd.promoted" })))),
        onMessage: (l) => void messages.push(l),
        onExit: (l) => void exits.push(l),
        kill: (signal) => {
          killed.push(String(signal));
          queueMicrotask(() => exits.forEach((l) => l(null, String(signal))));
        },
      };
    },
    get: async (_s, path) => ({ status: 200, body: path === "/v1/version" ? JSON.stringify({ sha: "sha-1" }) : "{}" }),
    command: (slot) => ({ exec: "gen", execArgv: [], args: [], cwd: slot.dir }),
    socketPathFor: () => socketPath,
    serveArgs: ["serve", "--host", "0.0.0.0", "--port", String(port)],
    log: (step, e) => void rows.push({ step, extra: e }),
    exit: () => undefined,
    sleep: async () => {},
    socketStates: () => ({ LISTEN: 1 }),
    activeProbeTimeoutMs: 150,
    every: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
    ...extra,
  });
  return { supervisor, ticks, rows, killed, spawned: () => spawned };
}

test("W1-T13503 criterion 1: the default probe GETs the unrouted probe path on the serve port, and a port that answers nothing is a wedge even while the private socket answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-tunnel-probe-"));
  const socketPath = join(dir, "g.sock");
  const privateSeen: string[] = [];
  // The generation's private socket: healthy, as on 2026-11-16.
  const privateSocket = createServer((req, res) => {
    privateSeen.push(req.url ?? "");
    res.end("{}");
  });
  // The public port: connections land in the accept queue and nothing ever answers them.
  const publicSeen: string[] = [];
  const stalled = createServer((req) => void publicSeen.push(req.url ?? ""));
  await listen(privateSocket, socketPath);
  await listen(stalled, 0);
  const port = (stalled.address() as AddressInfo).port;
  try {
    const r = supervise(socketPath, port);
    await r.supervisor.start();
    for (let n = 0; n < ACTIVE_PROBE_FAILURES; n++) {
      r.ticks[0]?.();
      await until(() => publicSeen.length === n + 1);
      await wait(250); // past the 150 ms bound, so the next tick is not skipped as still probing
    }
    await until(() => r.rows.some((x) => x.step === "serve.active_wedged"));
    assert.deepEqual(publicSeen, Array(ACTIVE_PROBE_FAILURES).fill(ACTIVE_PROBE_PUBLIC_PATH), "every probe went to the serve port");
    assert.deepEqual(privateSeen, [SMOKE_PATHS[0]], "the private socket is asked once, for the wedge row");
    const row = r.rows.find((x) => x.step === "serve.active_wedged");
    assert.ok(row, "the stalled public port is a wedge");
    assert.equal(row.extra?.probedPort, port);
    assert.equal(row.extra?.lastError, "timed out after 150 ms");
    assert.deepEqual(row.extra?.privateSocket, { answered: true, status: 200 }, "the row says the generation itself still answered");
    assert.deepEqual(r.killed, ["SIGKILL"]);
  } finally {
    stalled.closeAllConnections();
    await Promise.all([close(privateSocket), close(stalled)]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13503 criterion 1: a serve port that answers any status is alive, and the private socket is never asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-tunnel-probe-"));
  const socketPath = join(dir, "g.sock");
  const privateSeen: string[] = [];
  const privateSocket = createServer((req, res) => {
    privateSeen.push(req.url ?? "");
    res.end("{}");
  });
  const answering = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('{"error":"not_found"}');
  });
  await listen(privateSocket, socketPath);
  await listen(answering, 0);
  const port = (answering.address() as AddressInfo).port;
  try {
    const r = supervise(socketPath, port);
    await r.supervisor.start();
    for (let n = 0; n < ACTIVE_PROBE_FAILURES + 1; n++) {
      r.ticks[0]?.();
      await wait(60);
    }
    assert.equal(r.rows.filter((x) => x.step.startsWith("serve.active_wedge")).length, 0);
    assert.deepEqual(privateSeen, []);
    assert.deepEqual(r.killed, []);
  } finally {
    await Promise.all([close(privateSocket), close(answering)]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13503 criterion 1: a serve port that drops every connection and an absent private socket are both recorded, and the generation is still restarted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-tunnel-probe-"));
  // A listener that resets each connection: held for the whole test, so no other process can take the port
  // (a closed port can be reused by a parallel suite and then answer).
  const dropping = createNetServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => dropping.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (dropping.address() as AddressInfo).port;
  try {
    const r = supervise(join(dir, "absent.sock"), port);
    await r.supervisor.start();
    for (let n = 0; n < ACTIVE_PROBE_FAILURES; n++) {
      r.ticks[0]?.();
      await wait(80);
    }
    await until(() => r.rows.some((x) => x.step === "serve.active_wedged"));
    const row = r.rows.find((x) => x.step === "serve.active_wedged");
    assert.ok(row, `rows: ${JSON.stringify(r.rows.map((x) => x.step))}`);
    assert.match(String(row.extra?.lastError), /socket hang up|ECONNRESET/);
    const answer = row.extra?.privateSocket as { answered: boolean; error?: string };
    assert.equal(answer.answered, false);
    assert.match(String(answer.error), /ENOENT/);
    assert.deepEqual(r.killed, ["SIGKILL"]);
  } finally {
    await new Promise<void>((resolve) => dropping.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13503 criterion 2: the probed port is the one serve's own arguments bind, else 4317", () => {
  assert.equal(servePortOf(["serve", "--host", "0.0.0.0", "--port", "4318"]), 4318);
  assert.equal(servePortOf(["serve", "--port", "51234"]), 51234);
  assert.equal(servePortOf(["serve"]), ACTIVE_WEDGE_SERVE_PORT);
  assert.equal(servePortOf(undefined), ACTIVE_WEDGE_SERVE_PORT);
  assert.equal(servePortOf(["serve", "--port"]), ACTIVE_WEDGE_SERVE_PORT);
  assert.equal(servePortOf(["serve", "--port", "nope"]), ACTIVE_WEDGE_SERVE_PORT);
  assert.equal(servePortOf(["serve", "--port", "70000"]), ACTIVE_WEDGE_SERVE_PORT);
  assert.equal(servePortOf(["serve", "--port", "0"]), ACTIVE_WEDGE_SERVE_PORT);
  assert.equal(ACTIVE_WEDGE_SERVE_PORT, 4317);
});

test("W1-T13503 criterion 3: serve answers the probe path 404 before any credential check and writes no unauthorized row", async () => {
  const rows: Array<{ step: string }> = [];
  const server = createService({
    tokens: { read: "read-token-for-the-probe-test", write: "write-token-for-the-probe-test" },
    routes: [{ method: "GET", path: "/v1/status", scope: "read", handler: (_req, res) => void res.end("{}") }],
    log: (step) => void rows.push({ step }),
  });
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  try {
    const reply = await tcpGet(port, ACTIVE_PROBE_PUBLIC_PATH, 2_000);
    assert.equal(reply.status, 404);
    assert.equal(rows.length, 0, "no service.unauthorized row: the probe carries no token and needs none");
    // The positive control: a routed path without a token IS refused and logged, so the empty list above is a measurement.
    const refused = await new Promise<number>((resolve, reject) =>
      request({ host: "127.0.0.1", port, path: "/v1/status", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end(),
    );
    assert.equal(refused, 401);
    assert.deepEqual(rows.map((x) => x.step), ["service.unauthorized"]);
  } finally {
    await close(server);
  }
});

test("W1-T13503 criterion 3: no source file routes the probe path, so it stays unrouted", () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|mjs|js)$/.test(name) && readFileSync(path, "utf8").includes(ACTIVE_PROBE_PUBLIC_PATH)) hits.push(relative(REPO_ROOT, path));
    }
  };
  walk(join(REPO_ROOT, "src"));
  assert.deepEqual(hits, ["src/lib/serve-supervisor.ts"], "only the supervisor names the probe path");
});

test("W1-T13503 criterion 1: a TCP probe whose answer never comes is cut by its own timeout", async () => {
  const stalled = createServer(() => undefined);
  await listen(stalled, 0);
  const port = (stalled.address() as AddressInfo).port;
  try {
    await assert.rejects(tcpGet(port, ACTIVE_PROBE_PUBLIC_PATH, 50), /timed out after 50 ms/);
    const answered = createServer((_req, res) => void res.end("ok"));
    await listen(answered, 0);
    try {
      assert.deepEqual(await tcpGet((answered.address() as AddressInfo).port, "/x"), { status: 200, body: "ok" });
    } finally {
      await close(answered);
    }
  } finally {
    stalled.closeAllConnections();
    await close(stalled);
  }
});
