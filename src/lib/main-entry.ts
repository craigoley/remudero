/**
 * lib/main-entry.ts — bundlemain (operator ruling 2026-10-19, extending ADR 0006): the daemon names which entry its own
 * main started from, and a bundled main that reaches its first tick settles its attempt.
 *
 * bin/rmd asks scripts/build-child-entries.mjs `mainEntry` for the `daemon` verb and hands its answer to the process in
 * RMD_MAIN_ENTRY (`<kind>:<reason>`). {@link startMainEntryWatch} ledgers it once at boot as `daemon.entry.selected`,
 * with whether source maps are on and whether tsx's loader is on the node line, then removes the variable so no child
 * inherits a choice that was not made for it. At the first `daemon.tick_phases` a bundled main settles the attempt
 * marker beside its bundle: a later boot of the same source stays bundled, while an attempt that never settled (a
 * crash, a missing module, a heap-limit exit before the first tick) demotes the next boot to tsx (`mainEntry`).
 *
 * CHILDREN KEEP TSX. A bundled main runs without tsx's loader (beside the 12 MB bundle it transforms all of it: OBSERVED
 * offline 2026-10-20, 956 MiB RSS against 198 MiB), but the daemon still starts children from .ts sources with its own
 * `process.execArgv`: the measurement-cadence child, a garden pass when no bundle is current, a self-sync re-exec. So a
 * bundled main appends tsx's loader to `process.execArgv` at boot. Every such child inherits it, exactly as it did from
 * the tsx main, while this isolate never loads it; a child started from a bundle drops it (execArgvWithoutTsx).
 *
 * FALSIFIER: test/the-daemon-main-starts-from-its-bundle.test.ts.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runsBundled } from "./child-entry-argv.js";

export const MAIN_ENTRY_SELECTED_STEP = "daemon.entry.selected";
export const MAIN_ENTRY_SETTLED_STEP = "daemon.entry.settled";
const FIRST_TICK_STEP = "daemon.tick_phases";
const MAIN_ENTRY_ENV = "RMD_MAIN_ENTRY";

type BuildScript = { settleMainAttempt: (root: string) => boolean };
const loadBuildScript = (): BuildScript => createRequire(import.meta.url)("../../scripts/build-child-entries.mjs") as BuildScript;

/** What the launcher said, or what this process can tell of itself when nothing named it. */
export function readMainEntry(value: string | undefined, bundled: boolean): { kind: "bundle" | "tsx"; reason: string } {
  const at = value?.indexOf(":") ?? -1;
  const kind = value?.slice(0, at);
  if (value !== undefined && at > 0 && (kind === "bundle" || kind === "tsx")) return { kind, reason: value.slice(at + 1) || "unnamed" };
  return { kind: bundled ? "bundle" : "tsx", reason: "launcher-unnamed" };
}

export interface MainEntryWatchOptions {
  log: (step: string, extra: Record<string, unknown>) => void;
  /** The tree the main runs from (its bundle's attempt marker sits under it). */
  root: string;
  env?: NodeJS.ProcessEnv;
  bundled?: () => boolean;
  /** This process's node flags; a bundled main appends tsx's loader to it for its children. Default `process.execArgv`. */
  execArgv?: string[];
  exists?: (path: string) => boolean;
  sourceMapsEnabled?: () => boolean;
  settle?: (root: string) => boolean;
}

/** Ledgers the boot's entry once; the returned function is fed every step the daemon logs. */
export function startMainEntryWatch(opts: MainEntryWatchOptions): (step: string) => void {
  const env = opts.env ?? process.env;
  const choice = readMainEntry(env[MAIN_ENTRY_ENV], (opts.bundled ?? runsBundled)());
  delete env[MAIN_ENTRY_ENV];
  const execArgv = opts.execArgv ?? process.execArgv;
  const isTsx = (flag: string): boolean => /(^|[\\/=])tsx($|[\\/])/.test(flag);
  const tsxLoader = execArgv.some(isTsx);
  let childrenTsx: boolean | "loader-missing" = tsxLoader;
  if (!tsxLoader && (opts.bundled ?? runsBundled)()) {
    const loader = join(opts.root, "node_modules", "tsx", "dist", "loader.mjs");
    if ((opts.exists ?? existsSync)(loader)) {
      execArgv.push("--import", pathToFileURL(loader).href);
      childrenTsx = true;
    } else {
      childrenTsx = "loader-missing";
    }
  }
  opts.log(MAIN_ENTRY_SELECTED_STEP, {
    entry_kind: choice.kind,
    reason: choice.reason,
    source_maps_enabled: (opts.sourceMapsEnabled ?? (() => process.sourceMapsEnabled))(),
    tsx_loader: tsxLoader,
    children_tsx_loader: childrenTsx,
  });
  let pending = choice.kind === "bundle";
  return (step) => {
    if (!pending || step !== FIRST_TICK_STEP) return;
    pending = false;
    try {
      const settled = (opts.settle ?? ((root) => loadBuildScript().settleMainAttempt(root)))(opts.root);
      opts.log(MAIN_ENTRY_SETTLED_STEP, { settled });
    } catch (error) {
      // An unsettled attempt only costs the next boot of this source its bundle (it starts on tsx): name it, carry on.
      opts.log(MAIN_ENTRY_SETTLED_STEP, { settled: false, error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  };
}
