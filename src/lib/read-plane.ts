import { SHARE_ENV, Worker } from "node:worker_threads";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export const READ_PLANE_KIND = "remudero-tick-reads";

export function startReadPlaneTelemetry(): {
  sample(): { loop_delay_max_ms: number; loop_delay_p99_ms: number; sync_spawn_ms: number };
  stop(): void;
} {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let syncMs = 0;
  let depth = 0;
  const names = ["execFileSync", "execSync", "spawnSync"] as const;
  const originals = names.map((name) => childProcess[name]);
  names.forEach((name, index) => {
    const original = originals[index] as (...args: unknown[]) => unknown;
    const wrapper = (...args: unknown[]): unknown => {
      const began = performance.now();
      depth++;
      try { return original.apply(childProcess, args); }
      finally { if (--depth === 0) syncMs += performance.now() - began; }
    };
    Object.assign(childProcess, { [name]: wrapper });
  });
  syncBuiltinESMExports();
  let stopped = false;
  return {
    sample() {
      const sample = { loop_delay_max_ms: histogram.max / 1e6,
        loop_delay_p99_ms: histogram.count ? histogram.percentile(99) / 1e6 : 0, sync_spawn_ms: syncMs };
      histogram.reset();
      syncMs = 0;
      return sample;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      histogram.disable();
      names.forEach((name, index) => Object.assign(childProcess, { [name]: originals[index] }));
      syncBuiltinESMExports();
    },
  };
}

export function freezeReadGeneration<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !Object.isFrozen(value) && !seen.has(value)) {
    seen.add(value);
    if (value instanceof Map || value instanceof Set) {
      for (const child of value.values()) freezeReadGeneration(child, seen);
      const refuse = () => { throw new TypeError("immutable read generation"); };
      for (const method of value instanceof Map ? ["set", "delete", "clear"] : ["add", "delete", "clear"]) {
        Object.defineProperty(value, method, { value: refuse });
      }
    }
    Object.freeze(value);
    for (const child of Object.values(value)) freezeReadGeneration(child, seen);
  }
  return value;
}

export interface ReadGeneration<T> {
  generation: number;
  source: "worker" | "inline";
  facts: T;
}

export function startReadPlane<I, O>(options: {
  workerUrl: URL;
  workerInput: unknown;
  inline: (input: I) => O | Promise<O>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  spawn?: () => Worker;
}): { read(input: I): Promise<ReadGeneration<O>>; stop(): Promise<void> } {
  let thread: Worker | undefined;
  let stopped = false;
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<number, { resolve: (facts: O) => void; reject: (error: Error) => void }>();
  const fail = (held: Worker, error: Error): void => {
    if (thread !== held) return;
    thread = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    void held.terminate();
  };
  const start = (): Worker => {
    if (thread) return thread;
    if (stopped) throw new Error("read plane stopped");
    const workerData = { kind: READ_PLANE_KIND, input: options.workerInput, entry: options.workerUrl.href };
    // tsx's main-thread loader does not install itself in a worker's module loader (W1-T4075).
    // SHARE_ENV: the daemon's hourly GH_TOKEN refresh must reach the worker's reads.
    const held = options.spawn?.() ?? (options.workerUrl.pathname.endsWith(".ts")
      ? new Worker(`const { workerData } = require('node:worker_threads'); import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({ register }) => { register(); return import(workerData.entry); });`, { eval: true, workerData, env: SHARE_ENV })
      : new Worker(options.workerUrl, { workerData, env: SHARE_ENV }));
    thread = held;
    held.on("message", (reply: { generation: number; facts?: O; error?: string; kind?: string; step?: string; extra?: Record<string, unknown> }) => {
      if (thread !== held) return;
      if (reply.kind === "log" && reply.step) { options.log(reply.step, reply.extra); return; }
      const request = pending.get(reply.generation);
      if (!request || thread !== held) return;
      pending.delete(reply.generation);
      if (reply.error !== undefined) request.reject(new Error(reply.error));
      else request.resolve(reply.facts as O);
    });
    held.once("error", (error) => fail(held, error));
    held.once("exit", (code) => fail(held, new Error(`read plane exited: ${code}`)));
    return held;
  };
  return {
    read(input) {
      const id = ++generation;
      const captured = structuredClone(input);
      const run = async (): Promise<ReadGeneration<O>> => {
        if (stopped) throw new Error("read plane stopped");
        try {
          const held = start();
          const facts = await new Promise<O>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            held.postMessage({ generation: id, input: captured });
          });
          return freezeReadGeneration({ generation: id, source: "worker", facts });
        } catch (error) {
          pending.delete(id);
          if (stopped) throw error;
          options.log("read_plane.inline", { generation: id, reason: String(error) });
          return freezeReadGeneration({ generation: id, source: "inline", facts: await options.inline(captured) });
        }
      };
      const result = tail.then(run);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    async stop() {
      stopped = true;
      const held = thread;
      if (held) {
        fail(held, new Error("read plane stopped"));
        await held.terminate();
      }
    },
  };
}
