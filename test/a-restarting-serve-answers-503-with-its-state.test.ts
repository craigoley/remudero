/**
 * W1-T13277: between generations (a container boot, a crash restart, a wedge restart) serve's port refused
 * connections, so the Console could not tell a restart from an outage. The supervisor now answers the port itself
 * with 503, Retry-After and its own restarting state until a generation is promoted onto it.
 */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { test, type TestContext } from "node:test";
import { createServeSupervisor, type PreparedSlot, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { assertWallClockBound } from "#test/helpers/wall-clock-bound.js";

function call(port: number, method = "GET", body?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string; ms: number } | { error: string }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/v1/inbox", method, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, ms: performance.now() - started }));
    });
    req.on("error", (error) => resolve({ error: (error as NodeJS.ErrnoException).code ?? String(error) }));
    req.end(body);
  });
}

/** A supervisor whose fake generations bind a real server on the port when promoted, and whose boot waits for `release`. */
function rig(t: TestContext) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const events = new EventEmitter();
  const servers: Server[] = [];
  const seen: string[] = [];
  const dies: Array<() => void> = [];
  let releaseBoot: () => void;
  const holdBoot = () => new Promise<void>((resolve) => { releaseBoot = resolve; });
  let held = holdBoot();
  let port = 0;
  let now = 1_000_000;
  const nextEvent = (name: string) => once(events, name, { signal: AbortSignal.timeout(30_000) });
  const waitForAnswer = async (): Promise<number> => {
    const [failure] = await nextEvent("answer");
    assert.equal(failure, undefined, `restarting listener failed to bind: ${failure}`);
    assert.ok(port > 0, "the restarting listener reports its assigned port");
    return port;
  };
  const spawn: ServeSupervisorOptions["spawn"] = () => {
    const messages: Array<(m: GenerationMessage) => void> = [];
    const exits: Array<(c: number | null, s: string | null) => void> = [];
    let server: Server | undefined;
    const die = (): void => {
      server?.close(); server?.closeAllConnections();
      exits.forEach((l) => l(1, null));
    };
    dies.push(die);
    return {
      pid: 100 + dies.length,
      send(m: GenerationMessage) {
        if (m.type !== "rmd.promote") return;
        server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200); res.end("generation"); });
        servers.push(server);
        server.once("error", (error) => {
          events.emit("promoted", error);
          die();
        });
        server.listen(port, "127.0.0.1", () => {
          messages.forEach((l) => l({ type: "rmd.promoted" }));
          events.emit("promoted");
        });
      },
      onMessage: (l: (m: GenerationMessage) => void) => void messages.push(l),
      onExit: (l: (c: number | null, s: string | null) => void) => void exits.push(l),
      kill: () => die(),
    };
  };
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async () => ({ dir: "/slot-b", sha: "sha-2" }) as PreparedSlot,
    spawn,
    get: async (_socket, path) => {
      if (path.includes("bodies=0")) {
        events.emit("boot-probe");
        await held;
      }
      return { status: 200, body: path.startsWith("/v1/ready") ? JSON.stringify({ ready: true, criteria: [] }) : JSON.stringify({ sha: "sha-1" }) };
    },
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    socketPathFor: (n) => `/fake/gen-${n}.sock`,
    log: (step, extra) => {
      logs.push({ step, extra });
      if (step === "serve.restarting_answer_opened" && typeof extra?.port === "number") {
        port = extra.port;
        events.emit("answer");
      } else if (step === "serve.restarting_answer_failed") {
        events.emit("answer", extra?.reason ?? "unknown error");
      }
    },
    exit: () => undefined,
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    sleep: async () => undefined,
    every: () => () => undefined,
    restartingAnswer: { port: 0, host: "127.0.0.1" },
  });
  const bootPort = waitForAnswer();
  const bootProbe = nextEvent("boot-probe");
  const started = supervisor.start();
  t.after(async () => {
    releaseBoot();
    await Promise.allSettled([started]);
    await supervisor.shutdown("test");
    for (const s of servers) { s.close(); s.closeAllConnections(); }
  });
  return {
    bootPort: Promise.all([bootPort, bootProbe]).then(([port]) => port),
    started, logs, seen,
    advance: (ms: number) => { now += ms; },
    release: () => releaseBoot(),
    crash: () => {
      const reopened = waitForAnswer();
      held = holdBoot();
      dies.at(-1)!();
      return reopened;
    },
    finishRestart: async () => {
      const promoted = nextEvent("promoted");
      releaseBoot();
      const [failure] = await promoted;
      assert.equal(failure, undefined, `replacement listener failed to bind: ${failure}`);
    },
  };
}

test("W1-T13277 criterion 1: before the first promotion, the port answers 503 with Retry-After and the starting state", async (t) => {
  const r = rig(t);
  const port = await r.bootPort;
  const first = await call(port);
  assert.ok(!("error" in first), `answered, not refused (${JSON.stringify(first)})`);
  // The first connection pays the process's own first-request cost; the criterion's 100 ms is the steady answer.
  const reply = await call(port);
  assert.ok(!("error" in reply), `answered, not refused (${JSON.stringify(reply)})`);
  assert.equal(reply.status, 503);
  assert.equal(reply.headers["retry-after"], "5", "no boot measured yet: the default");
  assertWallClockBound(reply.ms, 100, `answered within 100 ms (${reply.ms.toFixed(1)} ms)`);
  const body = JSON.parse(reply.body) as Record<string, unknown>;
  assert.deepEqual(body, { state: "starting", since: new Date(1_000_000).toISOString(), reason: "boot", expectedReadyMs: null });
  r.advance(4_000);
  r.release();
  await r.started;
  assert.equal(r.logs.find((l) => l.step === "serve.restarting_answer_closed")?.extra?.answered, 2, "both requests were answered by the supervisor");
});

test("W1-T13277 criterion 2: a promoted generation gets the port unchanged, and a crash restart answers restarting with the measured boot", async (t) => {
  const r = rig(t);
  const port = await r.bootPort;
  r.advance(4_000);
  r.release();
  await r.started;
  const served = await call(port);
  assert.ok(!("error" in served) && served.status === 200 && served.body === "generation", "the generation answers once promoted");
  assert.ok(r.logs.some((l) => l.step === "serve.restarting_answer_closed"));

  assert.equal(await r.crash(), port, "the restarting listener reopens the same port");
  const restarting = await call(port);
  assert.ok(!("error" in restarting) && restarting.status === 503);
  const body = JSON.parse(restarting.body) as Record<string, unknown>;
  assert.deepEqual(body, { state: "restarting", since: new Date(1_004_000).toISOString(), reason: "restart", expectedReadyMs: 4_000 });
  assert.equal(restarting.headers["retry-after"], "4");
  await r.finishRestart();
  assert.equal(r.logs.filter((l) => l.step === "serve.restarting_answer_closed").length, 2, "closed again at the new promotion");
  const back = await call(port);
  assert.ok(!("error" in back) && back.status === 200, "the replacement answers");
});

test("W1-T13277 criterion 3: invariant:writes-are-never-swallowed — a POST while restarting gets 503 and never reaches a generation", async (t) => {
  const r = rig(t);
  const port = await r.bootPort;
  const write = await call(port, "POST", JSON.stringify({ action: "approve" }));
  assert.ok(!("error" in write) && write.status === 503, "the write is refused with the restarting answer");
  r.release();
  await r.started;
  await call(port);
  assert.deepEqual(r.seen, ["GET /v1/inbox"], "the generation saw only the read sent after promotion; the POST was never replayed");
});
