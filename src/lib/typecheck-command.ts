/**
 * `npm run typecheck` — ONE ENTRY FOR EVERY CALLER, ADMITTED LIKE THE HARNESS'S OWN CHECKS ON THE FLEET HOST.
 *
 * MEASURED 2026-10-10 08:25Z (Azure host): two Codex fix workers each ran `npm run typecheck` inside their bwrap
 * sandbox — the package script was plain `tsc -p tsconfig.json --noEmit`, so each ran COLD (2.4 GB and 2.1 GB RSS, over
 * 31 minutes), took no host slot, and together with the rest of the fleet pushed the host to load 34 and 5 GB of swap;
 * the daemon's PR sweep blew its bound. #10487 (W1-T7392) admitted the harness's OWN cold checks (merge probe,
 * preflight, the open-weight RunCheck) through the host-wide test slot, but a model shell never goes through those.
 *
 * TIERED, NEVER A REFUSAL:
 *   no fleet slot directory   → the plain check, byte-for-byte the old script (CI and a Mac are unchanged);
 *   fleet, warm buildinfo     → incremental, no slot: about half the cold peak, nothing to queue behind;
 *   fleet, cold               → incremental (seeded from the canonical checkout when it can be), inside a host slot;
 *   slot wait past its bound / slot dir unusable → test-slot's own named unslotted outcomes; the check still runs.
 * A caller that already holds a slot passes RMD_TEST_SLOT_PARENT and its descendant borrows it — no self-deadlock.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { acquireTestSlotAsync, resolveTestSlotDir, TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV, type TestSlotLease, type TestSlotOptions } from "./test-slot.js";
import {
  hasUsableTypecheckBuildInfo,
  installedTypescriptVersion,
  seedFromCanonical,
  typecheckArgs,
  worktreeBuildInfoPath,
  type SeedOutcome,
} from "./typecheck-buildinfo.js";

/** How often a running check refreshes its slot record, and the lease it declares on it: a killed check (a sandbox
 *  torn down with its worker) frees its slot within the lease instead of test-slot's 90-minute backstop. */
export const TYPECHECK_SLOT_HEARTBEAT_MS = 30_000;
export const TYPECHECK_SLOT_LEASE_MS = 5 * 60_000;

/** What `npm run typecheck` will run in `root`, and why. */
export interface TypecheckCommandPlan {
  mode: "plain" | "fleet";
  args: string[];
  /** Fleet only: the slot directory a cold check is admitted through. */
  slotDir?: string;
  buildInfo?: string;
  seed?: SeedOutcome;
}

function writableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    // A read-only bind (a sandboxed worker's git dir) or a missing directory: tsc could not write a buildinfo there.
    return false;
  }
}

/**
 * Where a fleet check keeps its buildinfo: the checkout's git directory (W1-T5658) when this process can write it, else
 * a per-checkout file in TMPDIR — a Codex writer's sandbox binds the worktree's git dir read-only (W1-T6148), and an
 * incremental tsc that cannot write its buildinfo fails. Neither writable: the plain check, never a broken one.
 */
export function typecheckBuildInfoFor(root: string, tmp: string = tmpdir()): string | undefined {
  const own = worktreeBuildInfoPath(root);
  if (own !== undefined && writableDir(dirname(own))) return own;
  if (!writableDir(tmp)) return undefined;
  let key = root;
  try {
    key = realpathSync(root);
  } catch {
    // An unresolvable root still names one checkout by its spelled path.
  }
  return join(tmp, `rmd-typecheck-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.tsbuildinfo`);
}

/** The plan for `root` under `env`. Fleet means a slot directory is configured or the host scratch mount is present —
 *  exactly the places test-slot coordinates host-wide; anywhere else the old plain script runs unchanged. */
export function planTypecheckCommand(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  isDir?: (path: string) => boolean,
  tmp?: string,
): TypecheckCommandPlan {
  const slots = resolveTestSlotDir(env, isDir);
  if (slots.scope !== "configured" && slots.scope !== "host-scratch") return { mode: "plain", args: typecheckArgs(undefined) };
  const buildInfo = typecheckBuildInfoFor(root, tmp);
  if (buildInfo === undefined) return { mode: "fleet", args: typecheckArgs(undefined), slotDir: slots.dir };
  return { mode: "fleet", args: typecheckArgs(buildInfo), slotDir: slots.dir, buildInfo, seed: seedFromCanonical(root, buildInfo) };
}

export interface TypecheckCommandPorts {
  env?: NodeJS.ProcessEnv;
  isDir?: (path: string) => boolean;
  tmp?: string;
  /** Extra argv after the fixed tail (`npm run typecheck -- --pretty false`). */
  extraArgs?: readonly string[];
  spawn?: (file: string, args: string[], options: { cwd: string; stdio: "inherit" }) => ChildProcess;
  testSlot?: Omit<TestSlotOptions, "sleep">;
  heartbeatMs?: number;
  log?: (line: string) => void;
}

/** Run the type-check for `root`, resolving to the exit code the npm script should end with. */
export async function runTypecheckCommand(root: string, ports: TypecheckCommandPorts = {}): Promise<number> {
  const log = ports.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const plan = planTypecheckCommand(root, ports.env, ports.isDir, ports.tmp);
  let slot: TestSlotLease | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (plan.mode === "fleet") {
    const warm = hasUsableTypecheckBuildInfo(plan.buildInfo, installedTypescriptVersion(root));
    log(JSON.stringify({ step: "typecheck.npm", mode: plan.mode, buildInfo: plan.buildInfo ?? null, seed: plan.seed ?? null, warm }));
    if (!warm) {
      slot = await acquireTestSlotAsync("typecheck:npm", { leaseMs: TYPECHECK_SLOT_LEASE_MS, ...ports.testSlot, dir: plan.slotDir });
      log(JSON.stringify({ step: "typecheck.npm_slot", outcome: slot.outcome, waitedMs: slot.waitedMs, note: slot.note }));
      const lease = slot;
      heartbeat = setInterval(() => {
        try {
          lease.refresh();
        } catch (error) {
          // A missed heartbeat only shortens the time before a peer may reclaim; the check itself is unaffected.
          log(JSON.stringify({ step: "typecheck.npm_heartbeat_failed", error: String(error) }));
        }
      }, ports.heartbeatMs ?? TYPECHECK_SLOT_HEARTBEAT_MS);
      heartbeat.unref();
    }
  }
  const spawnChild = ports.spawn ?? ((file, args, options) => nodeSpawn(file, args, options));
  try {
    return await new Promise<number>((resolveRun) => {
      let child: ChildProcess;
      const forward = (signal: NodeJS.Signals) => () => void child.kill(signal);
      const handlers = (["SIGINT", "SIGTERM"] as const).map((signal) => [signal, forward(signal)] as const);
      const settle = (code: number) => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
        resolveRun(code);
      };
      try {
        child = spawnChild(join(root, "node_modules", ".bin", "tsc"), [...plan.args, ...(ports.extraArgs ?? [])], { cwd: root, stdio: "inherit" });
      } catch (error) {
        log(`typecheck: SPAWN FAILURE — ${String(error)}; the check did NOT run`);
        settle(1);
        return;
      }
      for (const [signal, handler] of handlers) process.on(signal, handler);
      child.on("error", (error) => {
        log(`typecheck: SPAWN FAILURE — ${error.message}; the check did NOT run`);
        settle(1);
      });
      child.on("close", (code, signal) => settle(code ?? (signal ? 128 + signalNumber(signal) : 1)));
    });
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    slot?.release();
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 2 : signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 1;
}

/**
 * The Codex writer's half: its shell inherits only the "core" variables, and its bwrap binds `/` read-only, so a
 * model's `npm run typecheck` would see neither the slot directory's name nor be able to write a record in it. Grant the
 * ONE directory (lock records only — no credential, no git config) and name it in the shell. Absent outside the fleet,
 * and inside a test process, so a suite run in a container builds the same argv it builds on a Mac.
 */
export function codexTestSlotArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env[TEST_SLOT_DIR_ENV];
  if (!dir || env.NODE_TEST_CONTEXT) return [];
  const args = ["--add-dir", dir, "-c", `shell_environment_policy.set.${TEST_SLOT_DIR_ENV}=${JSON.stringify(dir)}`];
  const slots = Number(env[TEST_SLOTS_ENV]);
  if (Number.isSafeInteger(slots) && slots >= 1) args.push("-c", `shell_environment_policy.set.${TEST_SLOTS_ENV}=${JSON.stringify(String(slots))}`);
  return args;
}
