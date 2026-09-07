/**
 * W1-T2699: A SECRET A WORKER CAN READ IS A SECRET A PROMPT CAN LEAK.
 *
 * `buildWorkerEnv` (env.ts) copies the real subscription OAuth token and the real GitHub App
 * token BY VALUE into every worker's child env — a prompt injection that gets a worker to `env`
 * or `cat` its own process reads both outright. THE SHAPE: a worker's process tree holds only
 * SENTINELS (a fake model bearer, a loopback base URL, nothing at all for git); the REAL values
 * live only in the daemon's own process, substituted at the network boundary for declared
 * destinations alone. Every decision ledgers as value-free `boundary.request` (see
 * {@link boundaryLedgerRow}) — host, decision, status, reason, never a value.
 *
 * TWO CREDENTIALS, TWO MECHANISMS, because they arrive over different protocols. THE MODEL: the
 * CLI subprocess honours `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` above the on-disk login
 * (Claude Code docs); {@link startBoundaryProxy} swaps the sentinel for the real token and
 * forwards, entirely inside the daemon. Deliberately unrelated to `settings/worker.json`'s
 * `sandbox.network.allowedDomains`, which governs a worker's own SANDBOXED egress and refuses
 * `api.anthropic.com` there BY NAME (settings.ts) — a loopback connection never leaves the host.
 * THE REPOSITORY: git's own credential-helper protocol, moved to {@link startCredentialHelperSocket}'s
 * unix socket so a scoped, per-request token (github-app.ts's `mintScopedToken`) answers over the
 * wire and is never written to the worktree or held in the worker's own env.
 *
 * FALSIFIER: test/secret-boundary.test.ts.
 */

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

/** A fresh, unguessable stand-in for a real credential — never derived from the real value, so a
 *  worker holding one learns nothing about what it substitutes for. `label` is cosmetic (it
 *  appears only in the sentinel's own text, never logged as a secret) and helps a transcript or a
 *  stack trace name which boundary a stray sentinel belongs to. */
export function mintSentinel(label: string): string {
  return `rmd-sentinel-${label}-${randomBytes(24).toString("hex")}`;
}

/** The model host the sandbox's own egress allowlist deliberately excludes (settings.ts's
 *  `ALLOWED_NETWORK_DOMAINS` comment) — named here ONCE so this module and that one can never
 *  silently disagree about which host this boundary exists to protect. */
export const MODEL_HOST_DEFAULT = "api.anthropic.com";
/** The real upstream this proxy forwards a substituted request to, by default. */
export const MODEL_UPSTREAM_BASE_URL_DEFAULT = `https://${MODEL_HOST_DEFAULT}`;

/**
 * One row of the boundary proxy's destination table: a host declared reachable with a credential
 * substitution, the sentinel a worker presents in its place, and where the real value comes from.
 * `realValue` is a THUNK, never a captured string — read fresh per request so a rotated credential
 * (an App token refresh, W1-T2311) is honoured without restarting the proxy.
 */
export interface BoundaryDestination {
  readonly host: string;
  readonly sentinel: string;
  readonly upstreamBaseUrl: string;
  readonly realValue: () => string | undefined;
}

/** Read `sandbox.network.allowedDomains` off an already-parsed worker settings object — the SAME
 *  shape `allowedHostFromSettings` (containment.ts) reads. Used only to PROVE this boundary's
 *  model destination is deliberately NOT a member (see the module header); the model destination
 *  itself is never built from this list. */
export function declaredHostsFromWorkerSettings(settings: unknown): string[] {
  const domains = (settings as { sandbox?: { network?: { allowedDomains?: unknown } } })?.sandbox?.network
    ?.allowedDomains;
  return Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string" && d.length > 0) : [];
}

/** The one ledger step this module writes, so a reader has exactly one string to grep for. */
export const BOUNDARY_REQUEST_STEP = "boundary.request";

/**
 * The value-free row every boundary decision ledgers: which host, whether it was allowed or
 * refused, the outcome status, and a human reason — NEVER a token, a header, or a body. This is
 * the whole of what {@link startBoundaryProxy} and {@link startCredentialHelperSocket} log; neither
 * holds any other write path.
 */
export interface BoundaryLedgerRow {
  readonly step: typeof BOUNDARY_REQUEST_STEP;
  readonly host: string;
  readonly decision: "allow" | "refuse";
  readonly status: string;
  readonly reason: string;
}

export function boundaryLedgerRow(
  host: string,
  decision: "allow" | "refuse",
  status: string,
  reason: string,
): BoundaryLedgerRow {
  return { step: BOUNDARY_REQUEST_STEP, host, decision, status, reason };
}

export interface BoundaryProxyHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartBoundaryProxyOpts {
  /** The declared destinations — in production, one entry: the model host. A worker's own
   *  Authorization bearer is the routing key: an unrecognised value names no destination and is
   *  refused before anything is forwarded (see {@link BoundaryDestination}). */
  destinations: readonly BoundaryDestination[];
  /** Value-free sink for every decision. Defaults to a no-op — a caller wires the real ledger. */
  log?: (row: BoundaryLedgerRow) => void;
  /** Injectable outbound fetch — a test substitutes a fake upstream so no real network call is
   *  ever made to prove the substitution logic. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Start the loopback reverse proxy. Binds `127.0.0.1:0` (an ephemeral port — never a fixed one,
 * so two daemons on one host cannot collide) and, per request, reads ONLY the Authorization
 * header to decide the destination: an unrecognised bearer is refused immediately — no other
 * header is read, no body is buffered, no upstream connection is opened — before a real
 * destination's real credential is substituted and the request is forwarded.
 */
export async function startBoundaryProxy(opts: StartBoundaryProxyOpts): Promise<BoundaryProxyHandle> {
  const log = opts.log ?? (() => {});
  const fetchFn = opts.fetchImpl ?? fetch;
  const bySentinel = new Map(opts.destinations.map((d) => [d.sentinel, d] as const));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization;
    const presented = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : undefined;
    const destination = presented ? bySentinel.get(presented) : undefined;
    if (!destination) {
      log(boundaryLedgerRow("undeclared", "refuse", "refused", "no destination is declared for the presented credential"));
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("boundary: destination not declared");
      return;
    }
    const real = destination.realValue();
    if (!real) {
      log(boundaryLedgerRow(destination.host, "refuse", "refused", "no real credential is available to substitute"));
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("boundary: no credential available");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const target = new URL(req.url ?? "/", destination.upstreamBaseUrl);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v || k.toLowerCase() === "host" || k.toLowerCase() === "authorization") continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    headers.set("authorization", `Bearer ${real}`);
    try {
      const upstream = await fetchFn(target, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });
      log(boundaryLedgerRow(destination.host, "allow", String(upstream.status), "substituted for a declared destination"));
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      log(boundaryLedgerRow(destination.host, "refuse", "error", `upstream request failed: ${String(err)}`));
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("boundary: upstream request failed");
    }
  }

  const server = createHttpServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** What `secretBoundaryEnv` needs to build a worker's env: the running proxy's own sentinel and
 *  loopback URL, plus (optionally) the credential-helper socket a worktree's git config points
 *  at. Omitting `credentialHelperSocketPath` leaves git's own credential path untouched by this
 *  call — see worker.ts's git-config wiring, which is gated on the same field. */
export interface SecretBoundaryHandles {
  readonly modelSentinel: string;
  readonly modelBaseUrl: string;
  readonly credentialHelperSocketPath?: string;
}

/**
 * The env a worker's process tree actually gets: `buildWorkerEnv`'s output (env.ts), with the
 * real `CLAUDE_CODE_OAUTH_TOKEN` it copied removed and replaced by a sentinel bearer plus the
 * loopback base URL. `boundary` UNSET is a deliberate no-op — this call is byte-identical to
 * `builtEnv` unchanged, so every existing caller of `buildWorkerEnv` keeps its current env until
 * it opts in by supplying one (Standing rule: a defect on this path stops the fleet).
 *
 * `GH_TOKEN` is left untouched here on purpose: `gh`'s own API calls (e.g. opening a PR) read it
 * directly and have no proxy-substitution path yet — only git's OWN credential protocol moves
 * behind the socket (worker.ts's git-config wiring). Narrowing `gh`'s own token is out of this
 * shard's one concern; see the PR's Follow-ups.
 */
export function secretBoundaryEnv(
  builtEnv: Record<string, string>,
  boundary?: SecretBoundaryHandles,
): Record<string, string> {
  if (!boundary) return builtEnv;
  const out = { ...builtEnv };
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  out.ANTHROPIC_AUTH_TOKEN = boundary.modelSentinel;
  out.ANTHROPIC_BASE_URL = boundary.modelBaseUrl;
  return out;
}

export interface CredentialHelperSocketHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** One mint outcome the socket server relays — never the failure's internals, only a named reason. */
export type ScopedTokenMint = (repo: string) => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;

/**
 * Parse git's own credential-helper request body (`key=value` lines, blank-line terminated) into
 * the one field this helper needs: a `repo` to mint a token for. `path` (present only when the
 * caller's `credential.useHttpPath` is set) wins over a bare `host`, because a path names the
 * actual `owner/name` a scoped token should be minted for; a bare host falls back to `host` itself
 * so a request naming no path still resolves to SOMETHING nameable in the ledger reason.
 */
export function repoFromCredentialRequest(raw: string): string {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const path = fields.get("path");
  if (path) return path.replace(/\.git$/, "");
  return fields.get("host") ?? "unknown";
}

/**
 * Start the git credential-helper socket (design (iii)): a unix domain socket that, on each
 * connection, reads git's own credential-request body, mints a fresh scoped token for the named
 * repo (`opts.mint`, production wires `mintScopedToken`, github-app.ts), and answers in git's own
 * `username=...\npassword=...\n` reply shape — over the wire ONLY. Nothing here ever opens a file
 * in the worktree; the token exists only in this response and whatever git holds in memory for
 * the single request it serves.
 */
export function startCredentialHelperSocket(opts: {
  socketPath: string;
  mint: ScopedTokenMint;
  log?: (row: BoundaryLedgerRow) => void;
  /** The host named in the ledger row — the credential's OWN identity, never a value. */
  host?: string;
}): Promise<CredentialHelperSocketHandle> {
  const log = opts.log ?? (() => {});
  const host = opts.host ?? "github.com";
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);

  // `allowHalfOpen: true` is load-bearing: a plain `net.Socket` auto-ends its OWN writable side the
  // instant the remote FIN arrives, and `opts.mint` is async — by the time it resolves, an
  // auto-closed socket turns this handler's own `socket.end(reply)` into ERR_STREAM_WRITE_AFTER_END.
  // MEASURED against Node 22.22.3 rather than assumed.
  const server = createNetServer({ allowHalfOpen: true }, (socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      void respond();
    });
    async function respond(): Promise<void> {
      const repo = repoFromCredentialRequest(buf);
      try {
        const result = await opts.mint(repo);
        if (!result.ok) {
          log(boundaryLedgerRow(host, "refuse", "refused", result.reason));
          socket.end("");
          return;
        }
        log(boundaryLedgerRow(host, "allow", "minted", `scoped token minted for ${repo}`));
        socket.end(`username=x-access-token\npassword=${result.token}\n`);
      } catch (err) {
        log(boundaryLedgerRow(host, "refuse", "error", `mint threw: ${String(err)}`));
        socket.end("");
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      resolve({
        socketPath: opts.socketPath,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
