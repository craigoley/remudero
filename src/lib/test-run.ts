/**
 * `npm test` — the suite's `node --test` run, admitted through a host test slot and sized by memory as well as CPU.
 *
 * WHY. OBSERVED 2026-10-10 in the core daemon container: a worker's `node --test <many files>` at Node's default
 * concurrency (cores − 1) held 7–8 file children at 300–570 MB RSS each, 2.8 GB for one process tree, with no slot and
 * no admission. Node refuses `--test-concurrency` in NODE_OPTIONS, so no environment can size a run: the entrypoint
 * has to pass the flag. This one takes a slot sized by learned file peaks, so its concurrency is the
 * smaller of the CPU-derived count and what the memory headroom holds (at least one, no fixed cap), and runs niced.
 * A hand-run `node --test` that bypasses this entrypoint is admitted file by file instead (test-file-admission.ts).
 *
 * SAME RESULT. The argv is the caller's own with only `--test-concurrency` set, so the files, reporter and exit code
 * are node's. An explicit lower `--test-concurrency` is kept.
 */
import { spawn as spawnChild } from "node:child_process";
import { globSync, statSync } from "node:fs";
import { parseArgs } from "node:util";

import { testFileEstimates, type PeakStoreOptions } from "./host-memory-learning.js";

import {
  acquireTestSlotAsync,
  testSlotExecutionAllowed,
  lowPriorityCommand,
  TEST_SLOT_LEASE_MS,
  testRunArgv,
  type BinaryProbe,
  type TestSlotLease,
  type TestSlotOptions,
} from "./test-slot.js";

/** The slot label `npm test` holds while its run is live. */
export const NPM_TEST_SLOT_LABEL = "test:npm";

/** The caller's `--test-concurrency` (either spelling), or undefined when it named none. */
export function explicitTestConcurrency(args: readonly string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = arg === "--test-concurrency" ? args[i + 1] : arg.startsWith("--test-concurrency=") ? arg.slice(19) : undefined;
    const n = Number(value);
    if (value !== undefined && Number.isSafeInteger(n) && n >= 1) return n;
  }
  return undefined;
}

/** `args` with `--test-concurrency` set to the lease's, or the caller's own when that is lower. */
export function boundedTestArgv(args: readonly string[], concurrency: number): string[] {
  const explicit = explicitTestConcurrency(args);
  const kept = args.filter((arg, i) => arg !== "--test-concurrency" && args[i - 1] !== "--test-concurrency");
  return testRunArgv(kept, explicit === undefined ? concurrency : Math.min(explicit, concurrency));
}

/** Starts the runner with stdio inherited; resolves its exit code (128 + signal number when it was killed). */
export type BoundedTestSpawn = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;

export interface BoundedTestRunOptions {
  acquireSlot?: (label: string) => Promise<TestSlotLease>;
  /** Options for the default slot acquisition, including an explicitly supplied sizing override. */
  testSlot?: Omit<TestSlotOptions, "sleep">;
  peakStore?: PeakStoreOptions;
  spawn?: BoundedTestSpawn;
  spawnProcess?: typeof spawnChild;
  signalSource?: Pick<NodeJS.Process, "on" | "off">;
  binaryExists?: BinaryProbe;
  log?: (line: string) => void;
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** Expand Node's positional file selection for sizing only; the runner still receives its original argv. */
export function selectedTestFiles(args: readonly string[]): string[] {
  const valueFlags = ["import", "require", "loader", "experimental-loader", "test-concurrency", "test-name-pattern",
    "test-skip-pattern", "test-reporter", "test-reporter-destination", "test-timeout", "test-shard", "test-isolation"];
  const options = Object.fromEntries(valueFlags.map((flag) => [flag, { type: "string" as const,
    ...(flag === "require" ? { short: "r" } : {}) }]));
  const { positionals } = parseArgs({ args: [...args], options, strict: false, allowPositionals: true });
  if (positionals.length === 0) {
    return globSync("**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}", { exclude: ["**/node_modules/**"] });
  }
  const selected: string[] = [];
  for (const path of positionals) {
    if (/[*?\[{]/.test(path)) selected.push(...globSync(path, { exclude: ["**/node_modules/**"] }));
    else {
      let directory = false;
      try { directory = statSync(path).isDirectory(); } catch (error) { void error; /* Node reports a missing file. */ }
      selected.push(...(directory ? globSync(`${path}/**/*.test.{js,cjs,mjs,ts,cts,mts}`) : [path]));
    }
  }
  return [...new Set(selected)];
}

const inheritSpawn = (
  spawn: typeof spawnChild = spawnChild,
  signalSource: Pick<NodeJS.Process, "on" | "off"> = process,
): BoundedTestSpawn => (file, args, env) => new Promise((resolveRun) => {
  const child = spawn(file, [...args], { stdio: "inherit", env });
  // A Ctrl-C or a timeout's TERM reaches the runner too, so the suite stops with this wrapper rather than outliving it.
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) signalSource.on(signal, handler);
  const done = (code: number) => {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
    resolveRun(code);
  };
  child.on("error", (error) => {
    process.stderr.write(`test-run: could not start node --test: ${error.message}\n`);
    done(127);
  });
  child.on("exit", (code, signal) => done(code ?? 128 + (signal ? SIGNAL_NUMBERS[signal] ?? 0 : 0)));
});

/** Run `node <args>` (a `node --test` argv) in a memory-sized host test slot, niced; resolves the runner's exit code. */
export async function runBoundedTest(args: readonly string[], opts: BoundedTestRunOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const slot = await (opts.acquireSlot
    ? opts.acquireSlot(NPM_TEST_SLOT_LABEL)
    : acquireTestSlotAsync(NPM_TEST_SLOT_LABEL, {
      ...(opts.testSlot?.perFileBytes === undefined ? { filePeaks: testFileEstimates(selectedTestFiles(args), opts.peakStore) } : {}),
      ...opts.testSlot,
    }));
  if (!testSlotExecutionAllowed(slot)) {
    slot.release();
    log(JSON.stringify({ step: "test_run.not_run", slot: slot.outcome, note: slot.note }));
    return 75;
  }
  // A foreign-container holder is aged by its heartbeat: refresh well inside the lease while the run is live.
  const heartbeat = setInterval(() => slot.refresh(), TEST_SLOT_LEASE_MS / 3);
  heartbeat.unref();
  try {
    const argv = boundedTestArgv(args, slot.concurrency);
    const command = lowPriorityCommand(process.execPath, argv, opts.binaryExists);
    log(JSON.stringify({ step: "test_run.admitted", slot: slot.outcome, priority: command.priority, note: slot.note }));
    return await (opts.spawn ?? inheritSpawn(opts.spawnProcess, opts.signalSource))(
      command.file, command.args, { ...process.env, ...slot.childEnvironment },
    );
  } finally {
    clearInterval(heartbeat);
    slot.release();
  }
}
