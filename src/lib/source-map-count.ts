/**
 * lib/source-map-count.ts — W1-T9822: DAEMON.MEMORY COUNTS THE SOURCE MAPS ACTUALLY PARSED, NOT ONLY AN UPPER BOUND.
 * With maps on (tsx turns them on), Node's stack formatter parses the map of each module on a formatted stack, the
 * first time it meets it, and keeps it for the life of the isolate. No public API counts those parses, and asking for a
 * map (module.findSourceMap) parses one that was never parsed. So the count is taken where the parses happen.
 *
 * THE SEAM: Node 24 exposes its formatter as `Error.prepareStackTrace` (`ErrorPrepareStackTrace`, which applies the
 * maps when they are on). {@link installSourceMapCount} wraps it once. The wrapper formats first, so every map that
 * stack needed is parsed by Node itself. It then asks `findSourceMap` once per script file it has NOT seen before.
 * That call reads the map the formatter just cached and parses nothing new, and a file with no map answers undefined
 * without parsing. The distinct files that answered with a map are the count.
 * OBSERVED offline (2026-10-19, node 24.21.0, tsx 4.23.15, --expose-internals wrapping Node's SourceMap class as the
 * reference): three mapped modules formatted, Node parsed 3 and the count read 3. Formatting them again, or formatting
 * frames in node: builtins, moved neither.
 *
 * WHAT IT CANNOT SEE, so the count is a LOWER bound (`basis: "formatted-frames"`): maps parsed before the install, by a
 * direct findSourceMap caller, or by another context's formatter. A raw-call-site scope (read-plane.ts rawCallSites,
 * ledger-union.ts) formats nothing and parses nothing, and is correctly not counted. Once something other than
 * the wrapper is left in `Error.prepareStackTrace`, the count stops seeing parses, so it reads `detached`. A counting
 * error reads `failed`. Neither reads as a number: the census then falls back to its upper bound.
 *
 * FALSIFIER: test/daemon-memory-counts-the-source-maps-parsed.test.ts.
 */

import { findSourceMap as nodeFindSourceMap } from "node:module";

/** How the count was taken: the distinct mapped script files whose frames the wrapped formatter formatted. */
export const SOURCE_MAP_PARSED_BASIS = "formatted-frames";

/** What {@link sourceMapsParsed} reads: a count, or the reason there is none. */
export type SourceMapsParsedReading =
  | { parsed: number; basis: typeof SOURCE_MAP_PARSED_BASIS }
  | { parsed?: undefined; basis: "not-installed" | "detached" | "failed"; error?: string };

type PrepareStackTrace = (error: Error, trace: NodeJS.CallSite[]) => unknown;

/** Every seam the counter touches; each defaults to the real process. */
export interface SourceMapCountIo {
  /** The object whose `prepareStackTrace` is wrapped (the global `Error`). */
  target?: { prepareStackTrace?: PrepareStackTrace };
  /** Node's map lookup; after the formatter ran it only reads the cache. */
  findSourceMap?: (file: string) => unknown;
  /** Whether this isolate applies source maps to stacks right now. */
  enabled?: () => boolean;
}

/** One counter: install wraps the formatter (idempotent), read reports, uninstall restores it if still in place. */
export interface SourceMapCount {
  install(): void;
  uninstall(): void;
  read(): SourceMapsParsedReading;
}

export function createSourceMapCount(io: SourceMapCountIo = {}): SourceMapCount {
  const target = io.target ?? (Error as { prepareStackTrace?: PrepareStackTrace });
  const findSourceMap = io.findSourceMap ?? nodeFindSourceMap;
  const enabled = io.enabled ?? (() => process.sourceMapsEnabled);
  const seen = new Set<string>();
  const mapped = new Set<string>();
  let wrapper: PrepareStackTrace | undefined;
  let prior: PrepareStackTrace;
  let failure: string | undefined;

  const note = (trace: readonly NodeJS.CallSite[]): void => {
    if (failure !== undefined || !enabled()) return;
    try {
      for (const site of trace) {
        const file = site.getFileName();
        if (!file || seen.has(file)) continue;
        seen.add(file);
        if (findSourceMap(file) !== undefined) mapped.add(file);
      }
    } catch (error) {
      // A count that missed a file is no count: say so, and let the census fall back to its upper bound.
      failure = String((error as Error)?.message ?? error).slice(0, 200);
    }
  };

  return {
    install: () => {
      const formatter = target.prepareStackTrace;
      // Already counting, or no formatter to wrap (Node before 24 exposed none): reads `not-installed`, formats as before.
      if (wrapper !== undefined || typeof formatter !== "function") return;
      prior = formatter;
      wrapper = function countingPrepareStackTrace(this: unknown, error: Error, trace: NodeJS.CallSite[]): unknown {
        const formatted = formatter.call(this, error, trace);
        note(trace);
        return formatted;
      };
      target.prepareStackTrace = wrapper;
    },
    uninstall: () => {
      if (wrapper !== undefined && target.prepareStackTrace === wrapper) target.prepareStackTrace = prior;
      wrapper = undefined;
    },
    read: () => {
      if (wrapper === undefined) return { basis: "not-installed" };
      if (failure !== undefined) return { basis: "failed", error: failure };
      if (target.prepareStackTrace !== wrapper) return { basis: "detached" };
      return { parsed: mapped.size, basis: SOURCE_MAP_PARSED_BASIS };
    },
  };
}

const processCount = createSourceMapCount();

/** Wrap this process's stack formatter once (the daemon does it when it builds its memory census). */
export function installSourceMapCount(): void {
  processCount.install();
}

/** The distinct source maps this isolate's formatter has parsed since the install, or why there is no count. */
export function sourceMapsParsed(): SourceMapsParsedReading {
  return processCount.read();
}
