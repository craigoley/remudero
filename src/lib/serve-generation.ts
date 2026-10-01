/**
 * Serve as one GENERATION under deploy/serve-supervisor.mjs (arch-phase3-design.md §1(c), §3).
 *
 * The supervisor holds the listening socket and forks generations. A new generation boots as a
 * STANDBY: it never listens on the public port, starts no background writer, and answers
 * `GET /v1/ready` on a private unix socket. The supervisor polls that, smoke-tests real read routes
 * over the same socket, and only then sends `promote`. The old generation gets `drain`.
 *
 * Unsupervised (no {@link SERVE_ROLE_ENV}), none of this runs and serve boots as it always has.
 */
import { existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GitHub } from "./status.js";
import type { Plan } from "./plan.js";
import type { ReadModelWorkerHandle } from "./read-model-worker.js";

export const SERVE_ROLE_ENV = "RMD_SERVE_ROLE";
export const SERVE_READY_SOCKET_ENV = "RMD_SERVE_READY_SOCKET";
export const SERVE_READY_PATH = "/v1/ready";

/** Messages on the cluster IPC channel; the supervisor speaks the same names. */
export const GENERATION_MESSAGES = {
  promote: "rmd.promote",
  promoted: "rmd.promoted",
  drain: "rmd.drain",
  handoffRequest: "rmd.handoff_request",
  shed: "rmd.shed",
  shed_done: "rmd.shed_done",
} as const;

export interface GenerationMessage {
  type: string;
  reason?: string;
  [field: string]: unknown;
}

/** The IPC channel to the supervisor: `process.send` / `process.on("message")` in production. */
export interface GenerationChannel {
  send(message: GenerationMessage): void;
  onMessage(listener: (message: GenerationMessage) => void): void;
}

export interface ReadinessCriterion {
  name: string;
  ok: boolean;
  detail?: Record<string, unknown>;
}

export type ReadinessProbe = (query: URLSearchParams) => ReadinessCriterion;

export interface ReadinessReport {
  ready: boolean;
  criteria: ReadinessCriterion[];
}

/** Standby only when the supervisor said so and gave a socket; anything else is the legacy boot. */
export function supervisedRole(env: NodeJS.ProcessEnv): { socketPath: string } | undefined {
  const socketPath = env[SERVE_READY_SOCKET_ENV];
  return env[SERVE_ROLE_ENV] === "standby" && socketPath ? { socketPath } : undefined;
}

export function processChannel(proc: Pick<NodeJS.Process, "send" | "on"> = process): GenerationChannel | undefined {
  const send = proc.send?.bind(proc);
  if (!send) return undefined;
  return {
    send: (message) => void send(message),
    onMessage: (listener) => void proc.on("message", (message: unknown) => {
      if (message && typeof message === "object" && typeof (message as GenerationMessage).type === "string") listener(message as GenerationMessage);
    }),
  };
}

export function awaitPromotion(channel: GenerationChannel): Promise<void> {
  return new Promise((resolve) => channel.onMessage((message) => message.type === GENERATION_MESSAGES.promote && resolve()));
}

export function onDrainRequest(channel: GenerationChannel, drain: (reason: string) => void): void {
  channel.onMessage((message) => {
    if (message.type === GENERATION_MESSAGES.drain) drain(message.reason ?? "handover");
  });
}

/**
 * Memory tier 1 (design §1 "Memory"): the supervisor asks the ACTIVE generation to drop its rebuildable
 * caches before it forks a standby, then re-measures. The reply carries resident bytes before and after.
 */
export function onShedRequest(channel: GenerationChannel, shed: () => void, rss: () => number = () => process.memoryUsage().rss, gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc): void {
  channel.onMessage((message) => {
    if (message.type !== GENERATION_MESSAGES.shed) return;
    const beforeBytes = rss();
    shed();
    gc?.();
    channel.send({ type: GENERATION_MESSAGES.shed_done, beforeBytes, afterBytes: rss(), gc: gc !== undefined });
  });
}

export function readinessReport(probes: readonly ReadinessProbe[], query: URLSearchParams = new URLSearchParams()): ReadinessReport {
  const criteria = probes.map((probe) => probe(query));
  return { ready: criteria.every((criterion) => criterion.ok), criteria };
}

export function planLoadedProbe(plan: () => Plan | undefined, codeSha: string): ReadinessProbe {
  return () => {
    const tasks = plan()?.tasks.length ?? 0;
    return { name: "plan_loaded", ok: tasks > 0, detail: { tasks, codeSha } };
  };
}

export function githubAuthProbe(settled: () => boolean): ReadinessProbe {
  return () => ({ name: "github_auth_settled", ok: settled() });
}

/**
 * Primed means the gateway holds PR facts within their TTL, from its disk cache or one warm. A warm
 * that settled (even failing) also counts: a GitHub outage must not keep a healthy build from serving
 * the same honest "unreachable" the old generation would.
 */
export function gatewayPrimedProbe(github: Pick<GitHub, "factsAgeMs" | "factsStale" | "warmTelemetry">): ReadinessProbe {
  return () => {
    if (!github.factsAgeMs) return { name: "gateway_primed", ok: true, detail: { measurable: false } };
    const ageMs = github.factsAgeMs();
    const stale = github.factsStale?.() ?? false;
    const warmed = github.warmTelemetry?.().last !== undefined;
    return { name: "gateway_primed", ok: (ageMs !== undefined && !stale) || warmed, detail: { ageMs, stale, warmed } };
  };
}

export function boardComputedProbe(computed: () => boolean): ReadinessProbe {
  return () => ({ name: "board_computed", ok: computed() });
}

/**
 * `?bodies=N`: the supervisor passes the active generation's body count, so a standby is never thinner.
 * A failed warm load reads 0 bodies, so it blocks exactly when the active generation had some to serve.
 */
export function readModelWarmProbe(readModel: Pick<ReadModelWorkerHandle, "bodies" | "state"> | undefined): ReadinessProbe {
  return (query) => {
    if (!readModel) return { name: "read_model_warm", ok: true, detail: { readModel: false } };
    const bodies = readModel.bodies.size;
    const wanted = Number(query.get("bodies") ?? 0);
    const warmBoot = readModel.state().warmBoot;
    return { name: "read_model_warm", ok: bodies >= wanted, detail: { bodies, wanted, ...(warmBoot ? { warmBoot } : {}) } };
  };
}

/**
 * The private listener: `/v1/ready` answers here and nowhere else; every other request is handed to
 * the real server's own listeners, so the supervisor's smoke GETs exercise the routes a client will.
 * The socket is reachable only inside the container, where the token file is readable anyway, so an
 * unauthenticated request here is sent on with the read token: the supervisor never handles a secret.
 */
export async function listenReadiness(server: Server, socketPath: string, probes: () => readonly ReadinessProbe[], readToken?: string): Promise<Server> {
  if (existsSync(socketPath)) rmSync(socketPath);
  const privateServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== SERVE_READY_PATH) {
      if (readToken && !req.headers.authorization) req.headers.authorization = `Bearer ${readToken}`;
      for (const listener of server.listeners("request") as Array<(a: IncomingMessage, b: ServerResponse) => void>) listener(req, res);
      return;
    }
    const report = readinessReport(probes(), url.searchParams);
    res.writeHead(report.ready ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(report));
  });
  await new Promise<void>((resolve, reject) => {
    privateServer.once("error", reject);
    privateServer.listen(socketPath, resolve);
  });
  server.setMaxListeners(server.getMaxListeners() + 1).once("close", () => privateServer.close());
  return privateServer;
}
