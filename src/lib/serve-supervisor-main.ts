/**
 * The container entry for the serve supervisor (arch-phase3-design.md §5 step 4, P3-07):
 *
 *   node --import /app/node_modules/tsx/dist/loader.mjs /app/src/lib/serve-supervisor-main.ts \
 *     -- serve --host 0.0.0.0 --port 4317
 *
 * It runs from the BAKED image (/app), so it changes only with an image rebuild and a replace. The
 * generations it forks run from the serve clone (the cold start) and the two slots under
 * `RMD_SERVE_GENS_DIR`, each with its own checkout and `node_modules`.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { createSlotPreparer, prepareSlotDeps, runCommand, type RunCommand } from "./serve-slots.js";
import { createServeSupervisor, handoffSwitch, type ServeSupervisor, type ServeSupervisorOptions } from "./serve-supervisor.js";

export const SERVE_GENS_DIR_ENV = "RMD_SERVE_GENS_DIR";

export interface SupervisorMainOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  run?: RunCommand;
  headSha?: (repoDir: string) => string;
  log?: ServeSupervisorOptions["log"];
  create?: (opts: ServeSupervisorOptions) => ServeSupervisor;
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

/** The arguments after `--` are serve's own: `serve --host 0.0.0.0 --port 4317`. */
export function serveArgsOf(argv: readonly string[]): string[] {
  const at = argv.indexOf("--");
  const args = at === -1 ? [...argv] : argv.slice(at + 1);
  return args.length > 0 ? args : ["serve"];
}

export async function runServeSupervisor(argv: readonly string[], opts: SupervisorMainOptions = {}): Promise<ServeSupervisor> {
  const env = opts.env ?? process.env;
  const repoDir = opts.cwd ?? process.cwd();
  const gensDir = env[SERVE_GENS_DIR_ENV] ?? join(homedir(), "rmd-serve-gens");
  const run = opts.run ?? runCommand;
  const runId = `SERVE-SUPERVISOR-${process.pid}`;
  const log = opts.log ?? ((step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPathFor(loadConfig()), { run_id: runId, task_id: "SERVE", step, lane: "serve", ...extra }));
  // The cold generation runs from the clone the entrypoint synced; its install is made fresh here,
  // because a supervised generation skips serve's own fetch-and-install gate.
  const coldDeps = await prepareSlotDeps(repoDir, repoDir, run);
  const sha = (opts.headSha ?? ((dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()))(repoDir);
  const supervisor = (opts.create ?? createServeSupervisor)({
    coldSlot: { dir: repoDir, sha, deps: coldDeps },
    prepare: createSlotPreparer({ repoDir, gensDir, run }),
    serveArgs: serveArgsOf(argv),
    handoffEnabled: handoffSwitch(env, gensDir),
    log,
  });
  const onSignal = opts.onSignal ?? ((signal, handler) => void process.once(signal, handler));
  for (const signal of ["SIGTERM", "SIGINT"] as const) onSignal(signal, () => void supervisor.shutdown(signal.toLowerCase()));
  log("serve.supervisor_start", { sha, repoDir, gensDir, coldDeps });
  await supervisor.start();
  return supervisor;
}

// diff-cov: process-boundary - the container's direct entry; tests drive runServeSupervisor itself.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runServeSupervisor(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`rmd serve-supervisor: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
