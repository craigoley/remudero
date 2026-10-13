import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configPath, resolveHeavyReadyDirectory, type Config } from "./config.js";
import { heavyNewBuildGate, type HeavyBuildHold } from "./heavy-build-reservation.js";

/** Separate from config.json: older checkouts reject unknown config fields. Read ONCE at startup. */
export const HEAVY_READY_STARTUP_FILENAME = "heavy-ready-startup-v1.json";
const MAX_STARTUP_BYTES = 4096;
type StartupReading = { state: "absent" } | { state: "configured"; dir: string } | { state: "unavailable"; reason: string };
type StartupLog = (step: string, fields: Record<string, unknown>) => unknown;
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Descriptor-bounded, read-only opt-in. Absence is disabled; unreadable is never absence. */
export function readHeavyReadyStartupFile(path: string): StartupReading {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("startup path must be canonical and absolute");
    // Unsupported hosts may observe absence, but NEVER open an observed path after checking it.
    if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      try { lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" }; throw error; }
      throw new Error("safe startup reads unavailable");
    }
    // Atomic leaf open first; all policy/content checks use this descriptor, not a prior path check.
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" }; throw error; }
    const parent = dirname(path), directory = lstatSync(parent), uid = process.getuid?.();
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o077) !== 0 || realpathSync(parent) !== parent) throw new Error("startup parent must be canonical, private and owned");
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== uid || (before.mode & 0o077) !== 0 || before.nlink !== 1 || before.size > MAX_STARTUP_BYTES) throw new Error("startup file must be private, owned, regular, single-link and bounded");
    const buffer = Buffer.alloc(MAX_STARTUP_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, used);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd), published = lstatSync(path), parentAfter = lstatSync(parent);
    if (used > MAX_STARTUP_BYTES || used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        published.dev !== before.dev || published.ino !== before.ino || parentAfter.dev !== directory.dev || parentAfter.ino !== directory.ino ||
        parentAfter.mode !== directory.mode || parentAfter.uid !== directory.uid || realpathSync(parent) !== parent) throw new Error("startup identity or content changed during read");
    const value = JSON.parse(buffer.subarray(0, used).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("startup record must be an object");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "readyDirectory,version" || record.version !== 1 || typeof record.readyDirectory !== "string" ||
        !record.readyDirectory || record.readyDirectory.length > 2048 || !isAbsolute(record.readyDirectory) || resolve(record.readyDirectory) !== record.readyDirectory) throw new Error("unsupported or malformed startup record");
    return { state: "configured", dir: record.readyDirectory };
  } catch (error) { return { state: "unavailable", reason: detail(error) }; }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch (error) { return { state: "unavailable", reason: `startup descriptor closure unavailable: ${detail(error)}` }; }
    }
  }
}

/** Captures startup input; neither later file edits nor config/env mutation can hot-reload the gate.
 * A bad optional file refuses only NEW admissions when consulted, never throws during daemon startup.
 * Existing explicit env/config overrides retain precedence and do not consult the sidecar. */
export function captureHeavyNewBuildStartupGate(
  log: StartupLog,
  config: Pick<Config, "heavyReadyDirectory">,
  opts: { env?: NodeJS.ProcessEnv; startupFile?: string } = {},
): () => HeavyBuildHold | undefined {
  const explicit = resolveHeavyReadyDirectory(config, opts.env ?? process.env);
  if (explicit !== undefined) return heavyNewBuildGate(log, { dir: explicit });
  const reading = readHeavyReadyStartupFile(opts.startupFile ?? join(dirname(configPath()), HEAVY_READY_STARTUP_FILENAME));
  if (reading.state === "unavailable") return () => { throw new Error(`heavy READY startup observation unavailable: ${reading.reason}`); };
  return heavyNewBuildGate(log, { dir: reading.state === "configured" ? reading.dir : undefined });
}
