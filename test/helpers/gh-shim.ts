/**
 * test/helpers/gh-shim.ts — W1-T2903: the shared PATH-shim `gh`.
 *
 * WHY THIS EXISTS. Audit recon-2026-09-05 R-41 found 81 files hand-writing their own `gh` PATH
 * shim: a POSIX shell script named `gh`, written into a throwaway dir, prepended onto `PATH` so a
 * subject that shells out to the real `gh` binary answers from a scripted table instead of
 * touching the network. Every hand-rolled one is a `case "$*" in *"<substring>"*) …` dispatch —
 * this fixture is that shape, generalized: an ordered table of `{ when, stdout, stderr, exit }`
 * routes, first match wins, with a fallback that exits 0 quietly (the shape the real `gh`
 * subcommands this suite never asserts on — e.g. `pr edit` — are typically answered with).
 *
 * RECORDING. Every invocation's raw `"$*"` argv string is appended to a log file inside the
 * shim's own dir before the route table is even consulted, so `.calls()` sees a call regardless
 * of which route (or none) answered it — including the case where nothing in `test/*.test.ts`
 * itself parses `gh`'s own quoting rules, which is why this returns the raw joined string rather
 * than pretending to reconstruct argv precisely.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";

export interface GhShimRoute {
  /** Matches when the invocation's joined argv CONTAINS this substring — the same
   *  `*"<substring>"*)` shape every hand-rolled shim in this suite already used. Routes are
   *  checked in order; the first match answers. */
  when: string;
  /** stdout to print. Omitted ⇒ no stdout. */
  stdout?: string;
  /** stderr to print — e.g. simulating a `gh` failure message. Omitted ⇒ no stderr. */
  stderr?: string;
  /** Exit code. Default 0. */
  exit?: number;
}

export interface GhShim {
  /** The shim's own directory — prepend it onto `PATH` (`` `${shim.dir}:${originalPath}` ``, the
   *  same convention every migrated call site already used) so a child process resolves this
   *  `gh` before any real one. */
  readonly dir: string;
  /** Every invocation's raw joined argv, in call order — the recording half. */
  calls(): string[];
  /** Add a route ahead of the existing table (so it can override an earlier default) without
   *  rebuilding the whole shim. Rewrites the script on disk immediately. */
  addRoute(route: GhShimRoute): void;
}

function renderScript(routes: GhShimRoute[], callsPath: string): string {
  const cases = routes
    .map((r) => {
      const body = [
        r.stderr !== undefined ? `echo ${JSON.stringify(r.stderr)} 1>&2` : "",
        r.stdout !== undefined ? `echo ${JSON.stringify(r.stdout)}` : "",
        `exit ${r.exit ?? 0}`,
      ]
        .filter((part) => part.length > 0)
        .join("; ");
      return `  *${JSON.stringify(r.when)}*) ${body} ;;`;
    })
    .join("\n");
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'case "$*" in',
    cases,
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
}

/** Build a `gh` PATH shim answering from `routes` (checked in order; see {@link GhShimRoute}). */
export function ghShim(routes: GhShimRoute[] = [], opts: { kind?: string } = {}): GhShim {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${opts.kind ?? "gh-shim"}-`));
  const ghPath = join(dir, "gh");
  const callsPath = join(dir, "calls.log");
  writeFileSync(callsPath, "");
  let table = [...routes];
  writeFileSync(ghPath, renderScript(table, callsPath), { mode: 0o755 });

  return {
    dir,
    calls(): string[] {
      const text = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";
      return text.split("\n").filter((line) => line.length > 0);
    },
    addRoute(route: GhShimRoute): void {
      table = [route, ...table];
      writeFileSync(ghPath, renderScript(table, callsPath), { mode: 0o755 });
    },
  };
}
