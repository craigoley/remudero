/**
 * Drain v2 and the bounded exit (src/lib/serve-drain.ts, arch-phase3-design.md §1 and §4).
 * Every server here is real: the defects are socket races and a native join, which a fake cannot show.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import cluster, { type Worker } from "node:cluster";
import { Agent, createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { createServeDrain, EXIT_WATCHDOG_SCRIPT, exitWithin } from "../src/lib/serve-drain.js";
import { createService, type SseRoute, type SseSend } from "../src/lib/service.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const TOKENS = { read: "read-token", write: "write-token" };

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface Reply {
  status?: number;
  body: string;
  headers?: IncomingHttpHeaders;
  error?: string;
}

function send(port: number, opts: { agent?: Agent; method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: opts.path ?? "/", method: opts.method ?? "GET", agent: opts.agent, headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      res.on("error", (e) => resolve({ body, error: e.message }));
    });
    req.on("error", (e) => resolve({ body: "", error: (e as NodeJS.ErrnoException).code ?? e.message }));
    req.end(opts.method === "POST" ? "{}" : undefined);
  });
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A request handler that holds every response until the test releases it. */
function heldServer(): { server: Server; arrived: Promise<void>; respond: () => void } {
  let respond: () => void = () => {};
  let noteArrival: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (noteArrival = resolve));
  const server = createServer((_req, res) => {
    respond = () => res.end("done");
    noteArrival();
  });
  server.keepAliveTimeout = 60_000;
  return { server, arrived, respond: () => respond() };
}

test("W1-T4229: a drain lets an in-flight request finish before it resolves", async () => {
  const { server, arrived, respond } = heldServer();
  const drain = createServeDrain({ boundMs: 5_000, graceMs: 0 });
  drain.attach(server);
  const port = await listening(server);
  const pending = send(port);
  await arrived;
  let drained = false;
  const done = drain.drain("recycle").then((outcome) => {
    drained = true;
    return outcome;
  });
  await tick(20);
  assert.equal(drained, false, "the drain is still waiting on the open request");
  respond();
  const res = await pending;
  assert.equal(await done, "closed");
  assert.equal(res.status, 200);
  assert.equal(res.body, "done", "the in-flight request completed, never cut");
});

test("W1-T4229: a connection that never ends is closed at the drain bound", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
  });
  const fired: Array<() => void> = [];
  const drain = createServeDrain({ boundMs: 1, schedule: (run) => (fired.push(run), () => {}) });
  drain.attach(server);
  const port = await listening(server);
  const stream = send(port);
  await tick(20);
  const done = drain.drain("recycle");
  fired[0]();
  assert.equal(await done, "bound");
  const res = await stream;
  assert.ok(res.error !== undefined || res.body.includes("open"), "the stream was ended by the bound");
});

test("W1-T4229: a keep-alive connection that goes idle after the drain began is closed promptly", async () => {
  const { server, arrived, respond } = heldServer();
  const drain = createServeDrain({ boundMs: 60_000 });
  drain.attach(server);
  const port = await listening(server);
  const agent = new Agent({ keepAlive: true, timeout: 60_000 });
  const pending = send(port, { agent });
  await arrived;
  let drained = false;
  const done = drain.drain("recycle").then(() => (drained = true));
  respond();
  await pending;
  for (let i = 0; i < 100 && !drained; i += 1) await tick(10);
  agent.destroy();
  assert.equal(drained, true, "the drain resolved within a second, not at the client keep-alive timeout");
  await done;
});

test("drain answers in-flight keep-alive requests with connection close before sweeping idle sockets", async () => {
  let release: () => void = () => {};
  let noteHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => (noteHeld = resolve));
  const server = createServer((req, res) => {
    if (req.url !== "/hold") return void res.end("quick");
    release = () => res.end("late");
    noteHeld();
  });
  server.keepAliveTimeout = 60_000;
  const scheduled: Array<{ run: () => void; ms: number }> = [];
  const drain = createServeDrain({ boundMs: 60_000, graceMs: 1_000, schedule: (run, ms) => (scheduled.push({ run, ms }), () => {}) });
  drain.attach(server);
  const port = await listening(server);
  const idleAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  let idleClosed = false;
  idleAgent.once("free", (socket) => socket.once("close", () => (idleClosed = true)));
  assert.equal((await send(port, { agent: idleAgent, path: "/quick" })).headers?.connection, "keep-alive", "before the drain a response keeps the socket");
  const busyAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  const inFlight = send(port, { agent: busyAgent, path: "/hold" });
  await held;
  const done = drain.drain("recycle");
  release();
  const res = await inFlight;
  assert.equal(res.body, "late", "the in-flight request completed");
  assert.equal(res.headers?.connection, "close", "and its response retired the keep-alive socket");
  await tick(30);
  assert.equal(idleClosed, false, "an idle keep-alive socket is NOT swept during the grace");
  const grace = scheduled.find((s) => s.ms === 1_000);
  assert.ok(grace, "the grace is scheduled at the configured length");
  grace.run();
  assert.equal(await done, "closed");
  await tick(10);
  assert.equal(idleClosed, true, "the idle socket is swept once the grace ends");
  idleAgent.destroy();
  busyAgent.destroy();
});

function streamService(graceMs = 0): { server: Server; drain: ReturnType<typeof createServeDrain>; opened: SseSend[] } {
  const opened: SseSend[] = [];
  const drain = createServeDrain({ boundMs: 60_000, graceMs });
  const status: SseRoute = { path: "/v1/status/stream", scope: "read", subscribe: (send) => (opened.push(send), () => {}) };
  const server = createService({
    tokens: TOKENS,
    sse: [drain.wrapSse(status)],
    routes: [
      drain.wrapStream({
        method: "GET",
        path: "/v1/views/events",
        scope: "read",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: hello\ndata: {}\n\n");
        },
      }),
    ],
  });
  drain.attach(server);
  return { server, drain, opened };
}

function openStream(port: number, path: string, onData: (text: string) => void): Promise<Reply> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false, headers: { authorization: `Bearer ${TOKENS.read}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => ((body += c), onData(body)));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", (e) => resolve({ body: "", error: e.message }));
    req.end();
  });
}

test("an open status stream gets a handover event when the drain starts", { timeout: 10_000 }, async () => {
  const { server, drain, opened } = streamService();
  const port = await listening(server);
  let seen: () => void = () => {};
  const ready = new Promise<void>((resolve) => (seen = resolve));
  const stream = openStream(port, "/v1/status/stream", (body) => body.includes(":ok") && seen());
  await ready;
  await tick(10);
  assert.equal(opened.length, 1, "the status stream subscribed");
  const done = drain.drain("recycle");
  const res = await stream;
  assert.match(res.body, /event: handover\ndata: \{"reason":"recycle","retryMs":0\}/, "the stream ended with a handover, not at the bound");
  assert.equal(await done, "closed");
});

test("a stream request arriving during drain gets an immediate handover", async () => {
  const { server, drain, opened } = streamService(1_000);
  const port = await listening(server);
  const keepOpen = new Agent({ keepAlive: true, maxSockets: 1 });
  await send(port, { agent: keepOpen, path: "/missing" });
  // An open keep-alive socket holds the drain open, the way a racing reconnect reaches a draining process.
  const done = drain.drain("recycle");
  assert.equal(drain.draining(), true);
  const views = await new Promise<Reply>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/v1/views/events", agent: keepOpen, headers: { authorization: `Bearer ${TOKENS.read}` } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.end();
  });
  assert.equal(views.status, 200);
  assert.match(views.body, /^event: handover\ndata: \{"reason":"recycle","retryMs":0\}/, "the view stream answered handover at once");
  assert.doesNotMatch(views.body, /hello/, "the route itself never ran");
  assert.equal(views.headers?.connection, "close");
  keepOpen.destroy();
  assert.equal(await done, "closed");
  const status = await new Promise<Reply>((resolve) => {
    const late = createServeDrain({ boundMs: 1_000 });
    late.drain("recycle");
    const sends: string[] = [];
    const send = Object.assign((event: string) => void sends.push(event), { end: (event: string) => void sends.push(`end:${event}`) });
    late.wrapSse({ path: "/s", scope: "read", subscribe: () => () => {} }).subscribe(send);
    const bare = Object.assign((event: string) => void sends.push(`bare:${event}`), {});
    late.wrapSse({ path: "/s", scope: "read", subscribe: () => () => {} }).subscribe(bare);
    resolve({ body: sends.join(",") });
  });
  assert.equal(status.body, "end:handover,bare:handover", "a status stream opened during the drain is ended with a handover too");
  assert.equal(opened.length, 0, "no status subscription was ever made during the drain");
});

test("a drain with no attached server resolves at once and is idempotent", async () => {
  const drain = createServeDrain({ boundMs: 1_000 });
  const first = drain.drain("recycle");
  assert.equal(drain.drain("again"), first, "a second drain call returns the first drain");
  assert.equal(await first, "closed");
});

// ── the load test: a keep-alive client across a drain to a second generation on the SAME handle ──

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function startGeneration(port: number, gen: number): { worker: Worker; ready: Promise<void>; exited: Promise<void> } {
  const worker = cluster.fork({ PORT: String(port), GEN: String(gen) });
  const ready = new Promise<void>((resolve) => worker.on("message", (m: { type?: string }) => m?.type === "ready" && resolve()));
  const exited = new Promise<void>((resolve) => worker.on("exit", () => resolve()));
  return { worker, ready, exited };
}

test("a keep-alive client sees zero ECONNRESET across a drain to a second server on the same handle", { timeout: 120_000 }, async () => {
  cluster.schedulingPolicy = cluster.SCHED_NONE;
  cluster.setupPrimary({ exec: join(REPO_ROOT, "test/helpers/serve-drain-generation.ts"), execArgv: ["--import", "tsx"], silent: true });
  const port = await freePort();
  let current = startGeneration(port, 1);
  await current.ready;
  let running = true;
  const errors: Record<string, number> = {};
  const okByGen: Record<string, number> = {};
  let posts = 0;
  const loop = async (method: string, thinkMs = 0): Promise<void> => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    while (running) {
      if (thinkMs) await tick(thinkMs);
      const res = await send(port, { agent, method });
      if (res.status === 200) {
        okByGen[String(res.headers?.["x-gen"])] = (okByGen[String(res.headers?.["x-gen"])] ?? 0) + 1;
        if (method === "POST") posts += 1;
      } else {
        const key = `${method}:${res.error ?? res.status}`;
        errors[key] = (errors[key] ?? 0) + 1;
      }
    }
    agent.destroy();
  };
  // Paced clients sit idle between requests, the way cloudflared's origin pool does; they are what a sweep races.
  const clients = [
    ...Array.from({ length: 12 }, () => loop("GET")),
    ...Array.from({ length: 6 }, () => loop("POST")),
    ...Array.from({ length: 12 }, (_, i) => loop(i % 2 ? "POST" : "GET", 3 + (i % 5))),
  ];
  for (let gen = 2; gen <= 4; gen += 1) {
    await tick(400);
    const next = startGeneration(port, gen);
    await next.ready;
    current.worker.send({ type: "drain" });
    await current.exited;
    current = next;
  }
  await tick(400);
  running = false;
  await Promise.all(clients);
  current.worker.send({ type: "drain" });
  await current.exited;
  assert.deepEqual(errors, {}, "no request was reset or refused across three generation swaps");
  assert.ok(posts > 100, `POSTs really ran across the swaps (${posts})`);
  for (const gen of ["1", "2", "3", "4"]) assert.ok((okByGen[gen] ?? 0) > 0, `generation ${gen} served requests: ${JSON.stringify(okByGen)}`);
});

// ── the bounded exit ───────────────────────────────────────────────────────────────────────────

test("an exit blocked by a worker thread in a native call is killed at the deadline", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { Worker } from "node:worker_threads";
    import { exitWithin } from "./src/lib/serve-drain.ts";
    const worker = new Worker(\`const { DatabaseSync } = process.getBuiltinModule("node:sqlite"); const db = new DatabaseSync(":memory:");
      process.getBuiltinModule("node:worker_threads").parentPort.postMessage("busy");
      db.prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000000) SELECT count(*) FROM c").get();\`, { eval: true });
    worker.on("message", () => setTimeout(() => exitWithin(0, 300), 50));
  `], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const startedAt = performance.now();
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("exit", (c, s) => resolve([c, s])));
  const ms = performance.now() - startedAt;
  assert.equal(signal, "SIGKILL", `the blocked exit was killed, not joined (code ${code}, ${stderr})`);
  assert.match(stderr, /exit still blocked after 300 ms/);
  assert.ok(ms < 20_000, `killed near the deadline, not after the query (${Math.round(ms)} ms)`);
});

test("the exit watchdog leaves alone a process that is no longer its parent", async () => {
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
  const watchdog = spawn(process.execPath, ["-e", EXIT_WATCHDOG_SCRIPT, String(bystander.pid), "50"], { stdio: "ignore" });
  await new Promise((resolve) => watchdog.on("exit", resolve));
  assert.equal(bystander.exitCode, null, "the watchdog fired and did not kill an unrelated pid");
  assert.equal(bystander.signalCode, null);
  bystander.kill();
});

test("exitWithin arms the watchdog before it exits", () => {
  const calls: string[] = [];
  exitWithin(0, 1_234, {
    pid: 42,
    execPath: "/node",
    spawnWatchdog: (execPath, args) => {
      calls.push(`spawn ${execPath} ${args.slice(2).join(" ")}`);
      return { unref: () => void calls.push("unref") };
    },
    exit: (code) => void calls.push(`exit ${code}`),
  });
  assert.deepEqual(calls, ["spawn /node 42 1234", "unref", "exit 0"]);
});
