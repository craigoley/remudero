/**
 * W1-T10279 — the CLIENT half of the Mac GitHub read broker (src/lib/gh-read-broker.ts).
 *
 * Every Claude session and agent on a Mac account shared ONE 180 s read slot (hooks/deny-floor.sh
 * rule 10), about 20 reads an hour between them. The broker serves those reads from one process per
 * account: fresh cache hits cost nothing, identical reads coalesce, interactive callers go first, and
 * upstream calls are paced from GitHub's own headers. This half only finds a live broker and talks to
 * it. It imports nothing from github-transport.ts, which routes its reads through here: the server half
 * imports the transport, so keeping the two apart keeps the import graph acyclic.
 *
 * THE PROTOCOL. One newline-delimited JSON request per connection; the broker answers with zero or more
 * `{"type":"progress"}` lines and exactly one final `{"type":"result"}` (or `{"type":"status"}`) line.
 */
import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock } from "./clock.js";

/** The caller's class, served in this order: an operator's own session, then agents and workers, then
 *  background automation. The same order as W1-T10271's ticket ranks. */
export type GhBrokerClass = "interactive" | "agent" | "background";
export const GH_BROKER_CLASSES: readonly GhBrokerClass[] = ["interactive", "agent", "background"];

export function isGhBrokerClass(value: unknown): value is GhBrokerClass {
  return value === "interactive" || value === "agent" || value === "background";
}

export interface GhBrokerReadRequest {
  op: "read";
  args: string[];
  class: GhBrokerClass;
  /** Round-robin identity within a class: a session or agent id. */
  caller: string;
  /** Force revalidation (conditional where possible); still coalesces. */
  fresh?: boolean;
  /** The client's working directory: porcelain reads resolve their repository from it. */
  cwd?: string;
  /** The repository a porcelain read resolves to (`-R` or GH_REPO), part of its key; `cwd` stands in otherwise. */
  repo?: string;
}

export type GhBrokerOutcome = "hit-fresh" | "coalesced" | "revalidated-304" | "upstream-200" | "upstream-error" | "refused";

export interface GhBrokerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outcome: GhBrokerOutcome;
}

export interface GhBrokerProgress {
  position: number;
  expectedWaitMs: number;
}

/** `<cache root>/remudero/gh-broker`, the cache root resolved exactly as the read stamp's. */
export function ghBrokerDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.RMD_GH_CACHE_HOME ?? env.XDG_CACHE_HOME ?? (env.HOME !== undefined ? `${env.HOME}/.cache` : undefined);
  return root === undefined || root === "" ? undefined : `${root}/remudero/gh-broker`;
}

export const GH_BROKER_SOCKET = "broker.sock";
export const GH_BROKER_HEARTBEAT = "heartbeat";
export const GH_BROKER_INVALIDATIONS = "invalidations";

/**
 * Whether a broker is serving: its heartbeat file is younger than TWICE the interval the broker wrote
 * into it. The interval is the broker's own, never a constant here, so a broker that slows its
 * heartbeat is not declared dead by a reader that assumed a faster one. hooks/deny-floor.sh reads the
 * same file the same way.
 */
export function ghReadBrokerLive(env: NodeJS.ProcessEnv = process.env, nowMs: number = systemClock.now()): string | undefined {
  const dir = ghBrokerDir(env);
  return dir === undefined ? undefined : ghBrokerDirLive(dir, nowMs);
}

/** {@link ghReadBrokerLive} for a broker directory named directly. */
export function ghBrokerDirLive(dir: string, nowMs: number = systemClock.now()): string | undefined {
  try {
    const heartbeat = join(dir, GH_BROKER_HEARTBEAT);
    const intervalS = Number(readFileSync(heartbeat, "utf8").trim());
    if (!(intervalS > 0)) return undefined;
    const ageMs = nowMs - statSync(heartbeat).mtimeMs;
    return ageMs < 2 * intervalS * 1000 ? join(dir, GH_BROKER_SOCKET) : undefined;
  } catch {
    // No heartbeat (no broker installed) and an unreadable one both mean "not live": every caller then
    // takes today's direct path, which is the documented fallback.
    return undefined;
  }
}

/**
 * The broker socket an in-process read should use, or `undefined` for today's direct path.
 *
 * A test process routes only under an explicit cache root of its own (its RMD_GH_CACHE_HOME, a temp
 * dir), never to the account's real broker: the suite's sentinel GH_TOKEN guard is what keeps tests
 * off live GitHub, and a real broker answers with the account's own token. Any other caller holding
 * its own GH_TOKEN keeps that identity, so it is not routed: the broker reads as the account's login.
 */
export function ghBrokerRouteFor(env: NodeJS.ProcessEnv = process.env, nowMs: number = systemClock.now()): string | undefined {
  if (env.NODE_TEST_CONTEXT ? !env.RMD_GH_CACHE_HOME : Boolean(env.GH_TOKEN || env.GITHUB_TOKEN)) return undefined;
  return ghReadBrokerLive(env, nowMs);
}

/** The loader flags a synchronous client child needs to run TypeScript, and nothing else: a test
 *  runner's or profiler's own flags would change what the child does. */
function loaderExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i];
    if (arg === "--import" || arg === "--require" || arg === "--loader" || arg === "-r") {
      kept.push(arg, execArgv[i + 1] ?? "");
      i += 1;
    } else if (/^--(?:import|require|loader)=/.test(arg)) kept.push(arg);
  }
  return kept;
}

/** Who is asking, for round-robin: the Claude session when there is one, else the parent process. */
export function ghBrokerCallerId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CODE_SESSION_ID ?? env.REMUDERO_RUN_ID ?? `ppid-${process.ppid}`;
}

/** One request, one connection. Progress lines go to `onProgress`; the final line resolves. */
export function brokerRequest(
  socketPath: string,
  request: GhBrokerReadRequest | { op: "status"; sinceMs?: number } | { op: "stop" },
  onProgress?: (progress: GhBrokerProgress) => void,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffered = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch (cause) {
          // An unreadable reply is a broker fault, never a gh answer: the caller falls back to its direct path.
          settle(() => reject(new Error(`gh-broker: unreadable reply line (${String(cause)})`)));
          return;
        }
        if (message.type === "progress") onProgress?.({ position: Number(message.position), expectedWaitMs: Number(message.expectedWaitMs) });
        else settle(() => resolve(message));
      }
    });
    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => settle(() => reject(new Error("gh-broker: connection closed before a reply"))));
  });
}

/** A read through the broker, shaped as `gh` itself would have answered it. */
export async function brokerGhRead(
  socketPath: string,
  args: readonly string[],
  opts: { class?: GhBrokerClass; caller?: string; fresh?: boolean; cwd?: string; repo?: string; onProgress?: (p: GhBrokerProgress) => void } = {},
): Promise<GhBrokerResult> {
  const reply = await brokerRequest(socketPath, {
    op: "read",
    args: [...args],
    class: opts.class ?? "background",
    caller: opts.caller ?? ghBrokerCallerId(),
    fresh: opts.fresh,
    cwd: opts.cwd ?? process.cwd(),
    repo: opts.repo,
  }, opts.onProgress);
  return {
    stdout: String(reply.stdout ?? ""),
    stderr: String(reply.stderr ?? ""),
    exitCode: Number(reply.exitCode ?? 1),
    outcome: (reply.outcome as GhBrokerOutcome | undefined) ?? "upstream-error",
  };
}

const CLIENT_MAIN = fileURLToPath(new URL("../gh-read-broker-client-main.ts", import.meta.url));

/**
 * The SYNCHRONOUS form, for the transport's sync read paths: the file and argv to spawn IN PLACE OF
 * `gh`. The client entry answers exactly as `gh` would — its stdout, its stderr, its exit code — so a
 * sync path keeps its one synchronous spawn and only changes what it spawns. If the broker cannot be
 * reached, the entry runs `gh` itself.
 */
export function ghBrokerClientSpawn(socketPath: string, args: readonly string[], cls: GhBrokerClass): { file: string; args: string[] } {
  return { file: process.execPath, args: [...loaderExecArgv(process.execArgv), CLIENT_MAIN, socketPath, cls, ...args] };
}
