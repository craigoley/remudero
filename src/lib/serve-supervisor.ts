/**
 * The serve supervisor (arch-phase3-design.md §1(c), P3-04): the container's long-lived process,
 * which holds port 4317 and swaps serve generations behind it with no gap.
 *
 * It is the Node `cluster` primary with `SCHED_NONE`. The primary creates the listening handle once
 * and shares the SAME fd with every worker, so the kernel's one accept queue survives any generation
 * exiting. The primary never accepts a connection and is never on the data path.
 *
 * One handoff, end to end:
 *   active asks (`rmd.handoff_request`) → prepare the inactive slot → memory headroom → fork a
 *   standby → poll its `/v1/ready` and smoke-test real read routes → `rmd.promote` → it binds the
 *   shared fd and says `rmd.promoted` → `rmd.drain` the old one → `serve.handoff_done`.
 * A standby that fails readiness is killed and never serves (`serve.handoff_aborted`); the active
 * generation keeps serving. A promoted generation that dies is replaced from the previous slot.
 *
 * Kill switch: `RMD_SERVE_HANDOFF=off`, or a `handoff.off` file in the generations directory, turns a
 * handoff request back into today's behaviour: drain, exit 0, and docker restarts the container.
 */
import cluster from "node:cluster";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { systemClock, type Clock } from "./clock.js";
import { GENERATION_MESSAGES, SERVE_READY_PATH, SERVE_READY_SOCKET_ENV, SERVE_ROLE_ENV, type GenerationMessage } from "./serve-generation.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";

export const SERVE_HANDOFF_ENV = "RMD_SERVE_HANDOFF";
export const HANDOFF_OFF_FILE = "handoff.off";
/** BACKSTOP on a wedged boot, about 5x the slowest boot measured (66 s); never a bound on a healthy one. */
export const STANDBY_READY_BOUND_MS = 330_000;
/** The drain's own bound (10 s) plus the exit watchdog (5 s), with room: past it the old generation is killed. */
export const DRAIN_BACKSTOP_MS = 30_000;
/** BACKSTOP on a generation that never answers a shed request; a healthy one answers in milliseconds. */
export const SHED_BACKSTOP_MS = 10_000;
export const SMOKE_PATHS = ["/v1/version", "/v1/status", "/v1/views/versions"] as const;

/** One forked generation, as the supervisor sees it. */
export interface GenerationProcess {
  readonly pid: number | undefined;
  send(message: GenerationMessage): void;
  onMessage(listener: (message: GenerationMessage) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface GenerationCommand {
  exec: string;
  execArgv: string[];
  args: string[];
  cwd: string;
}

/** A prepared slot: a checkout of `sha` at `dir` with its own installed `node_modules`. */
export interface PreparedSlot {
  dir: string;
  sha: string;
  deps?: string;
}

export interface ServeSupervisorOptions {
  /** The cold-start checkout (the entrypoint's synced clone) and its sha. */
  coldSlot: PreparedSlot;
  /** Prepares the slot that is NOT `activeDir` at origin's newest main; rejects on failure. */
  prepare: (activeDir: string) => Promise<PreparedSlot>;
  /** How a slot runs serve; defaults to `src/run-task.ts serve …` under the slot's own tsx. */
  command?: (slot: PreparedSlot) => GenerationCommand;
  serveArgs?: string[];
  spawn?: (command: GenerationCommand, env: Record<string, string>) => GenerationProcess;
  /** One HTTP GET over a generation's private socket. */
  get?: (socketPath: string, path: string) => Promise<{ status: number; body: string }>;
  /** Free bytes in this container's memory cgroup, or undefined when unbounded or unreadable. */
  freeMemory?: () => number | undefined;
  /** A generation's resident bytes, or undefined when unreadable. */
  rss?: (pid: number) => number | undefined;
  handoffEnabled?: () => boolean;
  socketPathFor?: (generation: number) => string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  exit?: (code: number) => void;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  readyBoundMs?: number;
  pollMs?: number;
  drainBackstopMs?: number;
  /** When memory is short, a handoff waits this long before it asks again. */
  deferMs?: number;
  shedBackstopMs?: number;
}

interface Generation {
  id: number;
  slot: PreparedSlot;
  socketPath: string;
  process: GenerationProcess;
  exited: Promise<void>;
  isAlive: () => boolean;
}

export interface ServeSupervisor {
  start(): Promise<void>;
  requestHandoff(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  /** The sha the active generation runs, for tests and the ledger. */
  activeSha(): string | undefined;
}

export function generationCommand(serveArgs: string[]): (slot: PreparedSlot) => GenerationCommand {
  return (slot) => ({
    exec: join(slot.dir, "src", "run-task.ts"),
    execArgv: ["--import", pathToFileURL(join(slot.dir, "node_modules", "tsx", "dist", "loader.mjs")).href],
    args: serveArgs,
    cwd: slot.dir,
  });
}

/** Fork through `cluster`, so every generation listens on the primary's one shared handle. */
export function clusterSpawn(command: GenerationCommand, env: Record<string, string>): GenerationProcess {
  cluster.schedulingPolicy = cluster.SCHED_NONE;
  cluster.setupPrimary({ exec: command.exec, execArgv: command.execArgv, args: command.args, cwd: command.cwd });
  const worker = cluster.fork(env);
  return {
    pid: worker.process.pid,
    send: (message) => {
      if (worker.isConnected()) worker.send(message);
    },
    onMessage: (listener) => void worker.on("message", (message: GenerationMessage) => listener(message)),
    onExit: (listener) => void worker.on("exit", (code, signal) => listener(code, signal)),
    kill: (signal) => void worker.process.kill(signal),
  };
}

export function socketGet(socketPath: string, path: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** cgroup v2 `memory.max − memory.current`; undefined when the limit is `max` or the files are absent. */
export function cgroupFreeMemory(read: (path: string) => string = (path) => readFileSync(path, "utf8"), root = "/sys/fs/cgroup"): number | undefined {
  let max: number;
  let current: number;
  try {
    max = Number(read(join(root, "memory.max")).trim());
    current = Number(read(join(root, "memory.current")).trim());
  } catch {
    return undefined; // no cgroup v2 here (macOS, or a host process): headroom is not measurable, so nothing defers
  }
  return Number.isFinite(max) && Number.isFinite(current) ? max - current : undefined;
}

export function procRss(pid: number, read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | undefined {
  try {
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(read(`/proc/${pid}/status`))?.[1];
    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    return undefined; // no procfs (macOS) or the process is gone: this sample simply is not taken
  }
}

export function handoffSwitch(env: NodeJS.ProcessEnv, gensDir: string, exists: (path: string) => boolean = existsSync): () => boolean {
  return () => env[SERVE_HANDOFF_ENV] !== "off" && !exists(join(gensDir, HANDOFF_OFF_FILE));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createServeSupervisor(opts: ServeSupervisorOptions): ServeSupervisor {
  const command = opts.command ?? generationCommand(opts.serveArgs ?? ["serve"]);
  const spawn = opts.spawn ?? clusterSpawn;
  const get = opts.get ?? socketGet;
  const freeMemory = opts.freeMemory ?? (() => cgroupFreeMemory());
  const rss = opts.rss ?? ((pid: number) => procRss(pid));
  const handoffEnabled = opts.handoffEnabled ?? (() => true);
  const socketPathFor = opts.socketPathFor ?? ((n: number) => `/tmp/rmd-serve-gen-${process.pid}-${n}.sock`);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const readyBoundMs = opts.readyBoundMs ?? STANDBY_READY_BOUND_MS;
  const pollMs = opts.pollMs ?? 500;
  const drainBackstopMs = opts.drainBackstopMs ?? DRAIN_BACKSTOP_MS;
  const deferMs = opts.deferMs ?? 60_000;
  const shedBackstopMs = opts.shedBackstopMs ?? SHED_BACKSTOP_MS;

  let next = 0;
  let active: Generation | undefined;
  let previous: PreparedSlot | undefined;
  let inFlight: Promise<void> | undefined;
  let askedAgain = false;
  let stopping = false;
  let deferrals = 0;
  let largestRss = 0;
  let crashes = 0;
  const failed = new Set<string>();

  const fork = (slot: PreparedSlot): Generation => {
    const id = ++next;
    const socketPath = socketPathFor(id);
    const proc = spawn(command(slot), { [SERVE_ROLE_ENV]: "standby", [SERVE_READY_SOCKET_ENV]: socketPath, [SELF_SYNC_GUARD_ENV]: "1" });
    let alive = true;
    const exited = new Promise<void>((resolve) => proc.onExit(() => ((alive = false), resolve())));
    const generation: Generation = { id, slot, socketPath, process: proc, exited, isAlive: () => alive };
    proc.onMessage((message) => {
      if (message.type === GENERATION_MESSAGES.handoffRequest && generation === active) void supervisor.requestHandoff();
    });
    proc.onExit((code, signal) => {
      if (generation === active && !stopping) void replaceCrashed(generation, code, signal);
    });
    opts.log("serve.generation_forked", { generation: id, sha: slot.sha, dir: slot.dir, pid: proc.pid });
    return generation;
  };

  /** Ready means `/v1/ready` answered 200 and every smoke route answered 200 at the target sha. */
  const awaitReady = async (generation: Generation, bodies: number): Promise<{ ok: true } | { ok: false; criterion: string; detail?: unknown }> => {
    const deadline = clock.now() + readyBoundMs;
    let last: unknown;
    for (;;) {
      if (!generation.isAlive()) return { ok: false, criterion: "exited", detail: last };
      const reply = await get(generation.socketPath, `${SERVE_READY_PATH}?bodies=${bodies}`).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
      if (reply.status === 200) break;
      last = reply.status === 0 ? reply.body : safeJson(reply.body);
      if (clock.now() >= deadline) return { ok: false, criterion: "ready_bound", detail: last };
      await sleep(pollMs);
    }
    for (const path of SMOKE_PATHS) {
      const reply = await get(generation.socketPath, path).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
      if (reply.status !== 200) return { ok: false, criterion: `smoke ${path}`, detail: { status: reply.status } };
      if (path === "/v1/version" && (safeJson(reply.body) as { sha?: string } | undefined)?.sha !== generation.slot.sha) {
        return { ok: false, criterion: "smoke /v1/version", detail: { sha: safeJson(reply.body), want: generation.slot.sha } };
      }
    }
    return { ok: true };
  };

  /** The active generation's served body count: a standby must not be thinner than what it replaces. */
  const activeBodies = async (): Promise<number> => {
    if (!active) return 0;
    const reply = await get(active.socketPath, SERVE_READY_PATH).catch((err: unknown) => ({ status: 0, body: errorText(err) }));
    const report = (safeJson(reply.body) as { criteria?: Array<{ name: string; detail?: { bodies?: number } }> } | undefined);
    return report?.criteria?.find((c) => c.name === "read_model_warm")?.detail?.bodies ?? 0;
  };

  const promote = async (generation: Generation): Promise<boolean> => {
    const promoted = new Promise<boolean>((resolve) => {
      generation.process.onMessage((message) => message.type === GENERATION_MESSAGES.promoted && resolve(true));
      void generation.exited.then(() => resolve(false));
    });
    generation.process.send({ type: GENERATION_MESSAGES.promote });
    if (!(await promoted)) return false;
    const sample = generation.process.pid === undefined ? undefined : rss(generation.process.pid);
    if (sample !== undefined) largestRss = Math.max(largestRss, sample);
    return true;
  };

  const drainOld = async (generation: Generation, reason: string): Promise<number> => {
    const startedAt = clock.now();
    generation.process.send({ type: GENERATION_MESSAGES.drain, reason });
    const killed = await Promise.race([generation.exited.then(() => false), sleep(drainBackstopMs).then(() => true)]);
    if (killed) {
      opts.log("serve.drain_backstop_kill", { generation: generation.id, sha: generation.slot.sha, ms: drainBackstopMs });
      generation.process.kill("SIGKILL");
      await generation.exited;
    }
    return clock.now() - startedAt;
  };

  /** Fork, wait for readiness, promote; the caller decides what a failure means. */
  const bringUp = async (slot: PreparedSlot): Promise<{ generation?: Generation; criterion?: string; detail?: unknown; readyMs: number }> => {
    const startedAt = clock.now();
    const bodies = await activeBodies();
    const generation = fork(slot);
    const ready = await awaitReady(generation, bodies);
    if (!ready.ok) {
      generation.process.kill("SIGKILL");
      return { criterion: ready.criterion, detail: ready.detail, readyMs: clock.now() - startedAt };
    }
    if (!(await promote(generation))) return { criterion: "promote", readyMs: clock.now() - startedAt };
    return { generation, readyMs: clock.now() - startedAt };
  };

  /** Tier 1: the active generation drops its rebuildable caches, then free memory is measured again. */
  const shedActive = async (generation: Generation, freeBefore: number): Promise<number | undefined> => {
    const reply = new Promise<GenerationMessage | undefined>((resolve) => {
      generation.process.onMessage((message) => message.type === GENERATION_MESSAGES.shed_done && resolve(message));
      void generation.exited.then(() => resolve(undefined));
      void sleep(shedBackstopMs).then(() => resolve(undefined));
    });
    generation.process.send({ type: GENERATION_MESSAGES.shed });
    const done = await reply;
    const freeAfter = freeMemory();
    opts.log("serve.handoff_shed", { generation: generation.id, answered: done !== undefined, beforeBytes: done?.beforeBytes, afterBytes: done?.afterBytes, freeBefore, freeAfter, needBytes: largestRss });
    return freeAfter;
  };

  const legacyExit = async (reason: string): Promise<void> => {
    opts.log("serve.handoff_legacy_exit", { reason, sha: active?.slot.sha });
    await supervisor.shutdown(reason);
  };

  const handoff = async (): Promise<void> => {
    if (!handoffEnabled()) return legacyExit("handoff_off");
    const from = active;
    if (!from) return;
    const startedAt = clock.now();
    let slot: PreparedSlot;
    try {
      slot = await opts.prepare(from.slot.dir);
    } catch (err) {
      opts.log("serve.handoff_aborted", { criterion: "prepare", reason: errorText(err), fromSha: from.slot.sha });
      return;
    }
    const prepMs = clock.now() - startedAt;
    if (slot.sha === from.slot.sha || failed.has(slot.sha)) {
      opts.log("serve.handoff_skipped", { sha: slot.sha, reason: slot.sha === from.slot.sha ? "already_serving" : "failed_before" });
      return;
    }
    const short = (bytes: number | undefined): bytes is number => bytes !== undefined && largestRss > 0 && bytes < largestRss;
    let free = freeMemory();
    if (short(free)) free = await shedActive(from, free);
    if (short(free)) {
      deferrals += 1;
      opts.log("serve.handoff_deferred", { reason: "memory", freeBytes: free, needBytes: largestRss, deferrals, sha: slot.sha });
      if (deferrals >= 3) return legacyExit("memory");
      void sleep(deferMs).then(() => supervisor.requestHandoff());
      return;
    }
    deferrals = 0;
    const up = await bringUp(slot);
    if (!up.generation) {
      failed.add(slot.sha);
      opts.log("serve.handoff_aborted", { sha: slot.sha, fromSha: from.slot.sha, criterion: up.criterion, detail: up.detail, readyMs: up.readyMs });
      return;
    }
    previous = from.slot;
    active = up.generation;
    crashes = 0;
    const drainMs = await drainOld(from, "handoff");
    opts.log("serve.handoff_done", { fromSha: from.slot.sha, toSha: slot.sha, deps: slot.deps, prepMs, readyMs: up.readyMs, drainMs, peakBytes: largestRss || undefined });
  };

  /** A promoted generation died on its own: replace it, from the previous slot when it is a different build. */
  const replaceCrashed = async (dead: Generation, code: number | null, signal: string | null): Promise<void> => {
    active = undefined;
    if (inFlight) await inFlight;
    if (active) return;
    crashes += 1;
    const rollback = previous !== undefined && previous.sha !== dead.slot.sha;
    const slot = rollback && previous ? previous : dead.slot;
    if (rollback) failed.add(dead.slot.sha);
    opts.log(rollback ? "serve.handoff_rolled_back" : "serve.generation_crashed", { sha: dead.slot.sha, toSha: slot.sha, code, signal, crashes });
    // Self-healing back-off: a build that dies at once must not become a fork loop.
    await sleep(Math.min(60_000, 1_000 * 2 ** (crashes - 1)));
    const up = await bringUp(slot);
    if (up.generation) {
      active = up.generation;
      previous = undefined;
      return;
    }
    opts.log("serve.generation_restart_failed", { sha: slot.sha, criterion: up.criterion });
    await legacyExit("restart_failed");
  };

  const supervisor: ServeSupervisor = {
    activeSha: () => active?.slot.sha,
    start: async () => {
      const up = await bringUp(opts.coldSlot);
      if (!up.generation) {
        opts.log("serve.cold_start_failed", { sha: opts.coldSlot.sha, criterion: up.criterion, detail: up.detail });
        exit(1);
        return;
      }
      active = up.generation;
      opts.log("serve.supervisor_ready", { sha: opts.coldSlot.sha, readyMs: up.readyMs });
    },
    requestHandoff: () => {
      if (stopping) return Promise.resolve();
      if (inFlight) {
        askedAgain = true;
        return inFlight;
      }
      inFlight = handoff()
        .catch((err: unknown) => opts.log("serve.handoff_failed", { reason: errorText(err) }))
        .finally(() => {
          inFlight = undefined;
          if (askedAgain) {
            askedAgain = false;
            void supervisor.requestHandoff();
          }
        });
      return inFlight;
    },
    shutdown: async (reason) => {
      if (stopping) return;
      stopping = true;
      const generation = active;
      if (generation) await drainOld(generation, reason);
      exit(0);
    },
  };
  return supervisor;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // not JSON: the raw text is the most useful thing to ledger
  }
}
