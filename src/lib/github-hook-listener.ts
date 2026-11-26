/**
 * lib/github-hook-listener.ts — W1-T14986: the serve supervisor's webhook listener, a worker thread that owns its own
 * http.Server on RMD_SERVE_HOOK_PORT and runs only acceptGithubDelivery (github-delivery-accept.ts).
 * OBSERVED 2026-11-26: 29 of 4,000 App webhook deliveries timed out at GitHub's 10 s behind synchronous work on serve's
 * main thread. Started by the supervisor (serve-supervisor-main.ts), it outlives every generation, as the restarting
 * answer does (W1-T13277).
 * INVARIANT ack-off-the-main-thread: no generation's main thread, and not the supervisor's, stands between a hook
 * request and its answer. The thread posts its ledger rows and each accepted delivery's follow-up to its parent,
 * which relays the follow-up to the active generation after the 202 is written.
 * Its config (owner repo, marker paths, dedup bound, semantic mode) is pushed by the active generation; until the first
 * push the listener answers 503, so GitHub records the failure and the delivery log redelivers it.
 * ONE WRITER: serve's own 4317 route keeps the same fast path and the same dedup file. Once ingress sends
 * /v1/hooks/github here, only this listener writes that file, so the two in-memory windows never race and no lock is
 * needed; while ingress still points at 4317, this listener receives nothing.
 * Ships dark: with no port set, no thread starts. It runs from the baked image under the supervisor's tsx loader,
 * which a worker inherits through its execArgv.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SHARE_ENV, Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { systemClock } from "./clock.js";
import {
  answerGithubDeliveryRequest,
  isGithubHookConfig,
  type GithubDeliveryContext,
  type GithubDeliveryFollowUp,
  type GithubDeliveryMarker,
  type GithubHookConfig,
} from "./github-delivery-accept.js";
import {
  countWake,
  createPersistentDeliveryDedupStore,
  createWakeCounters,
  DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES,
  githubDeliveryChecks,
  readGithubWebhookSecret,
  resolveGithubWebhookSecretFilePath,
  startWakeSummaryFlush,
  wakeSummaryRow,
  writeSweepWakeMarkerAtomicAsync,
  type DeliveryDedupStore,
} from "./github-event-wake.js";
import { threadName } from "./thread-names.js";

export const SERVE_HOOK_PORT_ENV = "RMD_SERVE_HOOK_PORT";
export const GITHUB_HOOK_PATH = "/v1/hooks/github";

const KIND = "remudero-github-hook-listener";

/** What the listener thread posts to its parent. */
export type GithubHookListenerMessage =
  | { kind: "listening"; port: number }
  | { kind: "log"; step: string; extra?: Record<string, unknown> }
  | { kind: "followUp"; followUp: GithubDeliveryFollowUp };

/** The supervisor's handle on the listener thread. */
export interface GithubHookListenerHandle {
  /** Replaces the config the listener answers with. */
  configure(config: GithubHookConfig): void;
  onMessage(listener: (message: GithubHookListenerMessage) => void): void;
  /** The bound port once listening; undefined when the thread failed before it listened. */
  listening(): Promise<number | undefined>;
  stop(): Promise<void>;
}

export interface GithubHookServerOptions {
  secretFile: string | undefined;
  post: (message: GithubHookListenerMessage) => void;
  /** A test's marker write; production writes the marker atomically off the loop. */
  writeMarker?: (path: string, record: GithubDeliveryMarker) => void | Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, after?: () => void): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body), after);
}

/** The listener's request handling, in whichever thread builds it: the worker entry below, or a test's own. */
export function createGithubHookServer(opts: GithubHookServerOptions): { server: Server; configure(config: GithubHookConfig): void; stop(): void } {
  const log = (step: string, extra?: Record<string, unknown>): void => opts.post({ kind: "log", step, ...(extra ? { extra } : {}) });
  const counters = createWakeCounters();
  const stopSummary = startWakeSummaryFlush({
    counters,
    clock: systemClock,
    write: (window) => log("github.wake.summary", { ...wakeSummaryRow(counters, window) }),
  });
  let deps: GithubDeliveryContext | undefined;
  let held: { config: GithubHookConfig; dedup: DeliveryDedupStore; checks: GithubDeliveryContext["checks"] } | undefined;

  const configure = (config: GithubHookConfig): void => {
    const sameDedup = held && held.config.dedupPath === config.dedupPath && held.config.dedupCapacity === config.dedupCapacity;
    const sameChecks = held && held.config.semanticCheckMode === config.semanticCheckMode
      && JSON.stringify(held.config.aggregateCheckNames) === JSON.stringify(config.aggregateCheckNames);
    const dedup = sameDedup ? held!.dedup : createPersistentDeliveryDedupStore(config.dedupPath, config.dedupCapacity);
    const checks = sameChecks ? held!.checks : githubDeliveryChecks(config.aggregateCheckNames, config.semanticCheckMode);
    held = { config, dedup, checks };
    const markers = config.markerPaths;
    deps = {
      // Read at each push, so a rotated secret is taken up with the next config.
      secret: readGithubWebhookSecret(opts.secretFile),
      repository: config.repository,
      markerPath: markers[config.repository] ?? "",
      resolveMarkerPath: (repository) => (Object.hasOwn(markers, repository) ? markers[repository] : undefined),
      dedup,
      semanticCheckMode: config.semanticCheckMode,
      maxBodyBytes: DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES,
      checks,
      writeMarker: opts.writeMarker ?? writeSweepWakeMarkerAtomicAsync,
      clock: systemClock,
      log,
      count: (kind, event, action) => countWake(counters, kind, event, action),
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "POST" || path !== GITHUB_HOOK_PATH) {
      req.resume();
      return sendJson(res, 404, { error: "not_found" });
    }
    const current = deps;
    if (!current) {
      req.resume();
      log("github.wake.unavailable", { reason: "hook_config_pending" });
      return sendJson(res, 503, { error: "hook_config_pending" });
    }
    const answer = await answerGithubDeliveryRequest(req, current);
    const followUp = answer.followUp;
    // INVARIANT marker-before-ack: the answer exists only once its marker and dedup record are written.
    sendJson(res, answer.status, answer.body, followUp ? () => opts.post({ kind: "followUp", followUp }) : undefined);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // Recorded and answered: a socket that failed mid-body gets a 500 if it can still take one.
      log("github.wake.unavailable", { reason: "hook_request_failed", error: String((error as Error)?.message ?? error) });
      if (!res.headersSent) sendJson(res, 500, { error: "hook_request_failed" });
      else res.end();
    });
  });
  return {
    server,
    configure,
    stop: () => {
      stopSummary();
      server.close();
      server.closeAllConnections();
    },
  };
}

/** The bound port from RMD_SERVE_HOOK_PORT, or undefined when unset; a value that is no port is named, never guessed. */
export function serveHookPort(env: NodeJS.ProcessEnv): number | { invalid: string } | undefined {
  const raw = env[SERVE_HOOK_PORT_ENV]?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : { invalid: raw };
}

export interface StartGithubHookListenerOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** A test's own entry; production starts this module. */
  workerUrl?: URL;
}

/** Starts the listener thread, or nothing when RMD_SERVE_HOOK_PORT is unset or invalid. */
export function startGithubHookListener(opts: StartGithubHookListenerOptions): GithubHookListenerHandle | undefined {
  const env = opts.env ?? process.env;
  const port = serveHookPort(env);
  if (port === undefined) return undefined;
  if (typeof port !== "number") {
    opts.log("github.wake.unavailable", { reason: "hook_port_invalid", value: port.invalid });
    return undefined;
  }
  // SHARE_ENV: a long-lived thread reads the live supervisor env, not a spawn-time copy.
  const worker = new Worker(opts.workerUrl ?? new URL(import.meta.url), {
    name: threadName("hookListener"),
    execArgv: ["--import", "tsx"],
    workerData: { kind: KIND, port, host: opts.host, secretFile: resolveGithubWebhookSecretFilePath(undefined, env) },
    env: SHARE_ENV,
  });
  const listeners: Array<(message: GithubHookListenerMessage) => void> = [];
  let resolveListening: (port: number | undefined) => void = () => {};
  const listening = new Promise<number | undefined>((resolve) => (resolveListening = resolve));
  let stopping = false;
  worker.on("message", (message: GithubHookListenerMessage) => {
    if (message.kind === "listening") resolveListening(message.port);
    for (const listener of listeners) listener(message);
  });
  worker.on("error", (error) => opts.log("github.wake.unavailable", { reason: "hook_listener_failed", error: String(error?.message ?? error) }));
  worker.on("exit", (code) => {
    resolveListening(undefined);
    if (!stopping) opts.log("github.wake.unavailable", { reason: "hook_listener_exited", code });
  });
  return {
    configure: (config) => worker.postMessage({ kind: "configure", config }),
    onMessage: (listener) => void listeners.push(listener),
    listening: () => listening,
    stop: async () => {
      stopping = true;
      await worker.terminate();
    },
  };
}

if (!isMainThread && (workerData as { kind?: string } | undefined)?.kind === KIND && parentPort) {
  const port = parentPort;
  const input = workerData as { port: number; host?: string; secretFile?: string };
  const post = (message: GithubHookListenerMessage): void => port.postMessage(message);
  const hook = createGithubHookServer({ secretFile: input.secretFile, post });
  port.on("message", (message: { kind?: string; config?: unknown }) => {
    if (message?.kind === "configure" && isGithubHookConfig(message.config)) hook.configure(message.config);
  });
  hook.server.once("error", (error) => {
    post({ kind: "log", step: "github.wake.unavailable", extra: { reason: "hook_listen_failed", port: input.port, error: String(error?.message ?? error) } });
    process.exit(1);
  });
  hook.server.listen(input.port, input.host, () => post({ kind: "listening", port: (hook.server.address() as AddressInfo).port }));
}
