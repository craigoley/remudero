/**
 * The daemon-loop walk shared by the loop censuses (W1-T5689's sync-spawn census, W1-T9651's wall-clock child
 * census). ONE copy, so two censuses that claim the same reach can never drift apart.
 *
 * Population unit: every top-level function (declaration or arrow const) in tracked src, comments stripped.
 * Reach: the name-based fixed point seeded from a function name (the censuses seed `daemonCommand`). The
 * reach is name-based, so it is an upper bound.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Fn {
  name: string;
  file: string;
  body: string;
}

/** Blank comment lines, keeping line numbers. Block comments are recognised only where they START a
 *  line: a naive `/\*...\*\/` regex also fires on glob strings such as "src/**\/*.ts" and swallows code. */
export function stripComments(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .map((line) => {
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        return "";
      }
      if (/^\s*\/\*/.test(line)) {
        if (!line.includes("*/", line.indexOf("/*") + 2)) inBlock = true;
        return "";
      }
      return /^\s*\/\//.test(line) ? "" : line;
    })
    .join("\n");
}

export function trackedSourceFiles(): string[] {
  const sub = "ls" + "-files";
  return execFileSync("git", [sub, "src/**/*.ts", "src/*.ts"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
}

/** W1-T9615: a column-0 object-literal const (`const defaultPreflightChecks = {`). Its member arrows are not
 *  functions to {@link topLevelFunctions}, so a name reached only through one (plan-pr-emitter's `runInTree`, the
 *  sync preflight's in-tree spawn) is invisible to the function-only walk. */
const OBJECT_DECL = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/;

/** Column-0 function declarations (generators included) and column-0 arrow consts; a body runs to the
 *  next column-0 declaration (a closing brace at column 0 is NOT a boundary: a multi-line parameter type
 *  closes with one). `objectLiterals` also walks {@link OBJECT_DECL} bodies. */
export function topLevelFunctions(opts: { objectLiterals?: boolean } = {}): Fn[] {
  const fns: Fn[] = [];
  const decl =
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
  const NEXT_DECL = /^(?:export\s+|declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|abstract)\b|^export\s/;
  for (const file of trackedSourceFiles()) {
    const lines = stripComments(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]!) ?? (opts.objectLiterals ? OBJECT_DECL.exec(lines[i]!) : null);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && !NEXT_DECL.test(lines[end]!)) end++;
      fns.push({ name: (m[1] ?? m[2])!, file, body: lines.slice(i, end).join("\n") });
    }
  }
  return fns;
}

/** Name-based fixed point: a function is reachable when its identifier appears in a reachable body. */
export function loopReachable(fns: Fn[], seed: string): Set<string> {
  const byName = new Map<string, Fn[]>();
  for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const reached = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const name = queue.pop()!;
    for (const f of byName.get(name) ?? []) {
      for (const id of f.body.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (byName.has(id) && !reached.has(id)) {
          reached.add(id);
          queue.push(id);
        }
      }
    }
  }
  return reached;
}
