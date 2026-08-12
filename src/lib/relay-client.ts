/**
 * lib/relay-client.ts — the Tier-2 relay CLIENT (W1-T431, MASTER-PLAN §7A/§6A, D-11).
 *
 * WHAT THIS IS: `runRelayClient` dials OUT to a configured relay, authenticates with a
 * short-lived enrollment token, and — for as long as the connection holds — forwards every
 * proxied request it receives to the LOCAL `rmd serve` surface as a transparent byte proxy
 * (REST and SSE both), relaying the response back byte-for-byte. It is the client HALF ONLY
 * of DECISIONS.md's 2026-07-20 distribution architecture: "the agent initiates an OUTBOUND
 * tunnel; the website brokers authenticated browser sessions to it … NO inbound ports … a
 * relay is a transparent proxy … with zero console rework." The hosted relay service itself
 * (accounts, remudero.com DNS/TLS, the browser-session broker) is out of scope — this module
 * only needs a relay REACHABLE at a URL, real or a loopback stub, to have something to dial.
 *
 * WHY OUTBOUND-ONLY (design note iii, tested invariant, not a stance): this module never calls
 * `.listen()` anywhere in its own code — `net.connect`/`tls.connect` dial OUT to the relay, and
 * `http(s).request` dials OUT to the local console surface. Nothing here opens a socket for
 * anyone else to connect TO. `rmd serve` keeps running exactly as it does today whether or not
 * a relay is configured, reachable, or even implemented — the two are separate processes, and
 * this module never touches `rmd serve`'s own listener.
 *
 * WHY THE RELAY ADDS NO SCOPE OF ITS OWN (design note ii): every proxied request's headers —
 * including whatever `Authorization` (or Tailscale identity) header the browser session that
 * reached the relay presented — are forwarded to the local console surface UNCHANGED. This
 * module never adds, strips, or substitutes a credential. The console's own auth (the W1-T430
 * identity seam, `lib/service.ts`) decides every grant exactly as it would for a direct call; a
 * relay that could mint write access would be a second credential system, which is the exact
 * thing that seam exists to prevent.
 *
 * WIRE PROTOCOL (v0 — this module both defines and consumes it, since no hosted relay exists
 * yet to negotiate one with): newline-delimited JSON frames over one outbound TCP (`http:`/`ws:`
 * relay URL) or TLS (`https:`/`wss:`) connection, keyed by scheme. A relay sends `req` frames
 * (one per proxied HTTP request, transparent — method/path/headers/body copied as-is from
 * whatever request reached it); this client answers with `res_head` (status + headers) followed
 * by zero or more `res_chunk` frames as the local response streams in and a terminal `res_end`
 * — the same three-frame shape serves a bounded REST response (one chunk) and an open-ended SSE
 * stream (one chunk per event, `res_end` only when the local connection closes) without a
 * special case for either. This is an interim, not a commitment: a real relay could equally
 * negotiate WebSocket/HTTP2 framing without this module's exported surface
 * (`RelayClientOptions`/`RelayClientHandle`) changing at all.
 *
 * NOT IN SCOPE (design note vi): the hosted relay service, accounts, remudero.com DNS/TLS,
 * cross-instance portfolio views, device-code enrollment (a later convenience over today's
 * pasted-token flow), and any change to console routes or scopes — this module forwards the
 * console API, it never reimplements it (§7A's product-boundary discipline).
 */

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

/** One ledger-shaped log line per connect/disconnect/frame-error/forward-error event. */
export type RelayClientLog = (step: string, extra?: Record<string, unknown>) => void;

/** Reconnect backoff (design note iii: "reconnects with backoff"). Exponential, capped. */
export interface RelayClientBackoff {
  /** Delay before the FIRST reconnect attempt. Default 500ms. */
  initialMs?: number;
  /** Multiplier applied after each failed/dropped attempt. Default 2. */
  factor?: number;
  /** Ceiling the delay never exceeds. Default 30000ms (30s). */
  maxMs?: number;
}

export interface RelayClientOptions {
  /**
   * The relay to dial OUT to, e.g. `"https://relay.example.com:8443"`. Scheme picks plaintext
   * TCP (`http:`/`ws:`) vs TLS (`https:`/`wss:`) for the outbound control connection — this
   * module never listens regardless of scheme. Read from per-instance config by the CLI wiring
   * ({@link "../run-task.js".relayConnectCommand}), never argv, never committed (design note i).
   */
  relayUrl: string;
  /**
   * The short-lived enrollment token (design note iv) presented once per connection, in the
   * hello frame. Never persisted by this module — it is handed the value each call and holds it
   * only in memory for the life of the connection; rotation is re-enrollment (a new value), not
   * a call this module exposes.
   */
  enrollmentToken: string;
  /**
   * Base URL of the LOCAL console surface (`rmd serve`) every proxied request is forwarded to,
   * e.g. `"http://127.0.0.1:4317"`. Headers/method/body are forwarded byte-for-byte from the
   * relay's `req` frame — this module adds nothing of its own (design note ii).
   */
  localBaseUrl: string;
  log?: RelayClientLog;
  backoff?: RelayClientBackoff;
}

/** Returned by {@link runRelayClient}. Stopping is idempotent and synchronous. */
export interface RelayClientHandle {
  /** Stop the reconnect loop and close any live connection. Safe to call more than once. */
  stop(): void;
}

interface HelloFrame {
  t: "hello";
  token: string;
}
interface HelloOkFrame {
  t: "hello_ok";
}
interface HelloRejectFrame {
  t: "hello_reject";
  reason: string;
}
interface ReqFrame {
  t: "req";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** base64, or null/absent for a bodyless request (GET, etc). */
  body?: string | null;
}
interface ResHeadFrame {
  t: "res_head";
  id: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
}
interface ResChunkFrame {
  t: "res_chunk";
  id: string;
  /** base64-encoded chunk, forwarded exactly as the local response streamed it. */
  data: string;
}
interface ResEndFrame {
  t: "res_end";
  id: string;
}

type RelayFrame = HelloFrame | HelloOkFrame | HelloRejectFrame | ReqFrame | ResHeadFrame | ResChunkFrame | ResEndFrame;

const DEFAULT_BACKOFF: Required<RelayClientBackoff> = { initialMs: 500, factor: 2, maxMs: 30_000 };

/**
 * Forward one proxied `req` frame to the local console surface and stream the response back as
 * `res_head` → zero-or-more `res_chunk` → `res_end`. TRANSPARENT: `frame.headers`/`frame.method`/
 * `frame.body` are passed through unchanged — this is where design note (ii)'s "no scope of its
 * own" is actually true or false, and it is true because nothing here reads or sets an
 * `authorization` header.
 */
function forwardRequest(frame: ReqFrame, send: (frame: RelayFrame) => void, localBaseUrl: string, log: RelayClientLog): void {
  let target: URL;
  try {
    target = new URL(frame.path, localBaseUrl);
  } catch {
    log("relay.forward_bad_path", { id: frame.id, path: frame.path });
    send({ t: "res_head", id: frame.id, status: 502, headers: {} });
    send({ t: "res_end", id: frame.id });
    return;
  }
  const isTls = target.protocol === "https:";
  const requester = isTls ? httpsRequest : httpRequest;
  const outReq = requester(
    {
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: frame.method,
      headers: frame.headers as OutgoingHttpHeaders,
    },
    (res: IncomingMessage) => {
      send({ t: "res_head", id: frame.id, status: res.statusCode ?? 502, headers: res.headers });
      res.on("data", (chunk: Buffer) => {
        send({ t: "res_chunk", id: frame.id, data: chunk.toString("base64") });
      });
      res.on("end", () => {
        send({ t: "res_end", id: frame.id });
      });
      res.on("error", (err) => {
        log("relay.forward_response_error", { id: frame.id, error: err.message });
        send({ t: "res_end", id: frame.id });
      });
    },
  );
  outReq.on("error", (err) => {
    log("relay.forward_error", { id: frame.id, error: err.message });
    send({ t: "res_head", id: frame.id, status: 502, headers: {} });
    send({ t: "res_end", id: frame.id });
  });
  if (frame.body) {
    outReq.end(Buffer.from(frame.body, "base64"));
  } else {
    outReq.end();
  }
}

/**
 * Build (but do not start) an NDJSON reader over `socket`'s `data` events — split incoming bytes
 * on `\n` and hand each complete line to `onFrame` as parsed JSON. A line that fails to parse is
 * logged and dropped, never thrown (a single malformed frame must not kill the connection).
 */
function wireFrameReader(socket: Socket | TLSSocket, log: RelayClientLog, onFrame: (frame: RelayFrame) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line) as RelayFrame);
      } catch {
        log("relay.bad_frame", { line });
      }
    }
  });
}

/**
 * Dial OUT to `opts.relayUrl`, authenticate with `opts.enrollmentToken`, and forward every `req`
 * frame the relay sends to `opts.localBaseUrl` — reconnecting with backoff (design note iii)
 * across any drop/refusal, until {@link RelayClientHandle.stop} is called. Never calls `.listen`
 * anywhere in its own code, directly or transitively — see this module's own header for why that
 * is the outbound-only invariant, not merely a description of the common case.
 */
export function runRelayClient(opts: RelayClientOptions): RelayClientHandle {
  const log = opts.log ?? (() => {});
  const backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
  let stopped = false;
  let current: Socket | TLSSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delayMs = backoff.initialMs;

  const scheduleReconnect = () => {
    if (stopped) return;
    const wait = delayMs;
    delayMs = Math.min(delayMs * backoff.factor, backoff.maxMs);
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, wait);
  };

  const connect = () => {
    if (stopped) return;
    let url: URL;
    try {
      url = new URL(opts.relayUrl);
    } catch {
      // A malformed relay URL is a config error, not a transient one -- retrying it forever
      // would just spin. Logged once; the CLI wiring is expected to have validated this already.
      log("relay.bad_url", { relayUrl: opts.relayUrl });
      return;
    }
    const isTls = url.protocol === "https:" || url.protocol === "wss:";
    const port = url.port ? Number(url.port) : isTls ? 443 : 80;
    const socket = isTls ? tlsConnect({ host: url.hostname, port }) : netConnect({ host: url.hostname, port });
    current = socket;

    const send = (frame: RelayFrame) => {
      if (socket.destroyed) return;
      socket.write(JSON.stringify(frame) + "\n");
    };

    socket.once("connect", () => {
      log("relay.connected", { relayUrl: opts.relayUrl });
      send({ t: "hello", token: opts.enrollmentToken });
    });

    wireFrameReader(socket, log, (frame) => {
      if (frame.t === "hello_ok") {
        // THE BACKOFF CLOCK RESETS HERE, NOT ON THE SOCKET'S `connect` EVENT. A relay that
        // accepts the TCP connection and then REJECTS the enrollment token would otherwise reset
        // the delay before the rejection could arrive, so every cycle restarted at `initialMs`
        // and the client redialed a relay that had already said no at that fixed rate forever
        // (measured: 20 dials in 400ms at initialMs=20, versus ~5 once it grows). An ACCEPTED
        // connection is the only one that proves the endpoint and the credential are both good,
        // which is exactly what "the backoff may start over" is supposed to mean.
        delayMs = backoff.initialMs;
        log("relay.hello_ok", {});
        return;
      }
      if (frame.t === "hello_reject") {
        log("relay.hello_reject", { reason: frame.reason });
        socket.destroy();
        return;
      }
      if (frame.t === "req") {
        forwardRequest(frame, send, opts.localBaseUrl, log);
        return;
      }
      // res_head/res_chunk/res_end are client -> relay only; anything else is unexpected and
      // deliberately ignored rather than crashing the connection over a stray frame.
    });

    socket.on("error", (err) => {
      log("relay.socket_error", { error: err.message });
    });
    socket.on("close", () => {
      if (current === socket) current = undefined;
      log("relay.disconnected", {});
      scheduleReconnect();
    });
  };

  connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      current?.destroy();
      current = undefined;
    },
  };
}
