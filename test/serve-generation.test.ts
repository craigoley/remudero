/**
 * src/lib/serve-generation.ts: the standby's readiness probe, its private socket, and the IPC
 * channel to deploy/serve-supervisor.mjs (arch-phase3-design.md §3).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitPromotion,
  boardComputedProbe,
  GENERATION_MESSAGES,
  gatewayPrimedProbe,
  githubAuthProbe,
  listenReadiness,
  onDrainRequest,
  planLoadedProbe,
  processChannel,
  readinessReport,
  readModelWarmProbe,
  supervisedRole,
  type GenerationMessage,
} from "../src/lib/serve-generation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function overSocket(socketPath: string, path: string): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("readiness reports each criterion and is 503 until the board snapshot is computed", async () => {
  let boardDone = false;
  const real = createServer((req, res) => res.end(req.headers.authorization === "Bearer read-token" ? "real route" : "no token"));
  const socketPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ready-`)), "gen.sock");
  const plan = { tasks: [{ id: "W1-T1" }], byId: new Map() } as never;
  const priv = await listenReadiness(real, socketPath, () => [planLoadedProbe(() => plan, "abc123"), githubAuthProbe(() => true), boardComputedProbe(() => boardDone)], "read-token");
  try {
    const before = await overSocket(socketPath, "/v1/ready");
    assert.equal(before.status, 503);
    const report = JSON.parse(before.body) as { ready: boolean; criteria: Array<{ name: string; ok: boolean; detail?: Record<string, unknown> }> };
    assert.equal(report.ready, false);
    assert.deepEqual(report.criteria.map((c) => [c.name, c.ok]), [["plan_loaded", true], ["github_auth_settled", true], ["board_computed", false]], "every criterion is named");
    assert.deepEqual(report.criteria[0].detail, { tasks: 1, codeSha: "abc123" });
    boardDone = true;
    const after = await overSocket(socketPath, "/v1/ready");
    assert.equal(after.status, 200, "ready once the board is computed");
    assert.equal((JSON.parse(after.body) as { ready: boolean }).ready, true);
    assert.deepEqual(await overSocket(socketPath, "/v1/status"), { status: 200, body: "real route" }, "every other path reaches the real server's routes");
  } finally {
    real.emit("close");
  }
  await new Promise((resolve) => priv.once("close", resolve));
  writeFileSync(socketPath, "left behind by a killed generation");
  const again = await listenReadiness(real, socketPath, () => []);
  assert.equal((await overSocket(socketPath, "/v1/ready")).status, 200, "a stale socket file from a dead generation is replaced");
  again.close();
});

test("an empty plan and an unsettled App mint are not ready", () => {
  const report = readinessReport([planLoadedProbe(() => undefined, "x"), githubAuthProbe(() => false)]);
  assert.equal(report.ready, false);
  assert.deepEqual(report.criteria.map((c) => c.ok), [false, false]);
});

test("the gateway is primed by fresh facts or by one settled warm", () => {
  const probe = (github: Parameters<typeof gatewayPrimedProbe>[0]) => gatewayPrimedProbe(github)(new URLSearchParams());
  assert.equal(probe({}).ok, true, "a gateway that cannot say is not held hostage");
  assert.equal(probe({ factsAgeMs: () => undefined }).ok, false, "no facts held and no warm yet");
  assert.equal(probe({ factsAgeMs: () => 5, factsStale: () => false }).ok, true, "fresh facts from the disk cache");
  assert.equal(probe({ factsAgeMs: () => 5, factsStale: () => true }).ok, false, "stale facts are not primed");
  const warmed = probe({ factsAgeMs: () => 5, factsStale: () => true, warmTelemetry: () => ({ inFlight: false, last: {} as never }) });
  assert.equal(warmed.ok, true, "a settled warm counts even if it failed");
  assert.deepEqual(warmed.detail, { ageMs: 5, stale: true, warmed: true });
});

test("the read model is warm only with its committed bodies and at least as many as the active generation", () => {
  const handle = (size: number, warmBoot?: string) => ({ bodies: new Map(Array.from({ length: size }, (_, i) => [String(i), {} as never])), state: () => ({ instances: new Map(), switches: {} as never, ...(warmBoot ? { warmBoot } : {}) }) });
  const q = (bodies?: number) => new URLSearchParams(bodies === undefined ? "" : `bodies=${bodies}`);
  assert.equal(readModelWarmProbe(undefined)(q()).ok, true, "no read model configured");
  assert.equal(readModelWarmProbe(handle(3))(q(3)).ok, true);
  assert.equal(readModelWarmProbe(handle(2))(q(3)).ok, false, "thinner than the generation it replaces");
  const failed = readModelWarmProbe(handle(0, "db unreadable"))(q(4));
  assert.equal(failed.ok, false, "a failed warm load cannot replace a generation that serves bodies");
  assert.deepEqual(failed.detail, { bodies: 0, wanted: 4, warmBoot: "db unreadable" });
  assert.equal(readModelWarmProbe(handle(0, "no database yet"))(q(0)).ok, true, "a fleet with no read model yet can still hand over");
});

test("the standby role needs both the role and a socket", () => {
  assert.deepEqual(supervisedRole({ RMD_SERVE_ROLE: "standby", RMD_SERVE_READY_SOCKET: "/tmp/g.sock" }), { socketPath: "/tmp/g.sock" });
  assert.equal(supervisedRole({ RMD_SERVE_ROLE: "standby" }), undefined);
  assert.equal(supervisedRole({ RMD_SERVE_READY_SOCKET: "/tmp/g.sock" }), undefined);
  assert.equal(supervisedRole({}), undefined);
});

test("the process channel carries promote and drain from the supervisor and sends upward", async () => {
  assert.equal(processChannel({ send: undefined, on: () => process } as never), undefined, "no IPC means no supervisor");
  const proc = new EventEmitter() as EventEmitter & { send: (m: unknown) => boolean };
  const sent: unknown[] = [];
  proc.send = (m) => (sent.push(m), true);
  const channel = processChannel(proc as never);
  assert.ok(channel);
  channel.send({ type: GENERATION_MESSAGES.promoted });
  assert.deepEqual(sent, [{ type: "rmd.promoted" }]);
  const drains: string[] = [];
  onDrainRequest(channel, (reason) => drains.push(reason));
  let promoted = false;
  const promotion = awaitPromotion(channel).then(() => (promoted = true));
  proc.emit("message", "not an object");
  proc.emit("message", { type: "rmd.unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promoted, false, "only a promote promotes");
  proc.emit("message", { type: GENERATION_MESSAGES.promote } satisfies GenerationMessage);
  await promotion;
  proc.emit("message", { type: GENERATION_MESSAGES.drain, reason: "handoff" });
  proc.emit("message", { type: GENERATION_MESSAGES.drain });
  assert.deepEqual(drains, ["handoff", "handover"]);
});
