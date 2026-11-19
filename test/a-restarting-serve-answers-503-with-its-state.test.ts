/**
 * W1-T13277: between generations (a container boot, a crash restart, a wedge restart) serve's port refused
 * connections, so the Console could not tell a restart from an outage. The supervisor now answers the port itself
 * with 503, Retry-After and its own restarting state until a generation is promoted onto it.
 */
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServeSupervisor, restartingRetryAfterS, type PreparedSlot, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { assertWallClockBound } from "#test/helpers/wall-clock-bound.js";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

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

const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

/** A supervisor whose fake generations bind a real server on the port when promoted, and whose boot waits for `release`. */
function rig(port: number) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const servers: Server[] = [];
  const seen: string[] = [];
  const dies: Array<() => void> = [];
  let releaseBoot: () => void = () => undefined;
  let held = new Promise<void>((resolve) => (releaseBoot = resolve));
  let now = 1_000_000;
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
        server.listen(port, "127.0.0.1", () => messages.forEach((l) => l({ type: "rmd.promoted" })));
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
      if (path.includes("bodies=0")) await held;
      return { status: 200, body: path.startsWith("/v1/ready") ? JSON.stringify({ ready: true, criteria: [] }) : JSON.stringify({ sha: "sha-1" }) };
    },
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    socketPathFor: (n) => `/fake/gen-${n}.sock`,
    log: (step, extra) => logs.push({ step, extra }),
    exit: () => undefined,
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    sleep: async () => undefined,
    every: () => () => undefined,
    restartingAnswer: { port, host: "127.0.0.1" },
  });
  return {
    supervisor, logs, seen,
    advance: (ms: number) => { now += ms; },
    release: () => releaseBoot(),
    hold: () => { held = new Promise<void>((resolve) => (releaseBoot = resolve)); },
    crash: () => dies.at(-1)!(),
    close: () => { for (const s of servers) { s.close(); s.closeAllConnections(); } },
  };
}

test("W1-T13277 criterion 1: before the first promotion, the port answers 503 with Retry-After and the starting state", async (t) => {
  const port = await freePort();
  const r = rig(port);
  const started = r.supervisor.start();
  t.after(async () => { r.release(); await started.catch(() => undefined); await r.supervisor.shutdown("test"); r.close(); });
  await until(() => r.logs.some((l) => l.step === "serve.restarting_answer_opened"), "the answer opened");
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
  await started;
  assert.equal(r.logs.find((l) => l.step === "serve.restarting_answer_closed")?.extra?.answered, 2, "both requests were answered by the supervisor");
});

test("W1-T13277 criterion 2: a promoted generation gets the port unchanged, and a crash restart answers restarting with the measured boot", async (t) => {
  const port = await freePort();
  const r = rig(port);
  const started = r.supervisor.start();
  t.after(async () => { r.release(); await started.catch(() => undefined); await r.supervisor.shutdown("test"); r.close(); });
  await until(() => r.logs.some((l) => l.step === "serve.restarting_answer_opened"), "the answer opened");
  r.advance(4_000);
  r.release();
  await started;
  const served = await call(port);
  assert.ok(!("error" in served) && served.status === 200 && served.body === "generation", "the generation answers once promoted");
  assert.ok(r.logs.some((l) => l.step === "serve.restarting_answer_closed"));

  r.hold();
  r.crash();
  await until(() => r.logs.filter((l) => l.step === "serve.restarting_answer_opened").length === 2, "the answer reopened at the crash");
  const restarting = await call(port);
  assert.ok(!("error" in restarting) && restarting.status === 503);
  const body = JSON.parse((restarting as { body: string }).body) as Record<string, unknown>;
  assert.deepEqual(body, { state: "restarting", since: new Date(1_004_000).toISOString(), reason: "restart", expectedReadyMs: 4_000 });
  assert.equal(restartingRetryAfterS(body as never, 1_004_000), 4);
  r.release();
  await until(() => r.logs.filter((l) => l.step === "serve.restarting_answer_closed").length === 2, "closed again at the new promotion");
  const back = await call(port);
  assert.ok(!("error" in back) && back.status === 200, "the replacement answers");
});

test("W1-T13277 criterion 3: invariant:writes-are-never-swallowed — a POST while restarting gets 503 and never reaches a generation", async (t) => {
  const port = await freePort();
  const r = rig(port);
  const started = r.supervisor.start();
  t.after(async () => { r.release(); await started.catch(() => undefined); await r.supervisor.shutdown("test"); r.close(); });
  await until(() => r.logs.some((l) => l.step === "serve.restarting_answer_opened"), "the answer opened");
  const write = await call(port, "POST", JSON.stringify({ action: "approve" }));
  assert.ok(!("error" in write) && write.status === 503, "the write is refused with the restarting answer");
  r.release();
  await started;
  await call(port);
  assert.deepEqual(r.seen, ["GET /v1/inbox"], "the generation saw only the read sent after promotion; the POST was never replayed");
});
