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

/** W1-T9701: the node that holds what a module evaluates at import. Not identifier-shaped, so no body names it and
 *  no seeded walk reaches it. */
export const MODULE_LOAD = "<module-load>";

/** `key: callee(` or `key: new Callee(` at the start of a member: the initializer calls it while the module loads. */
const CALL_VALUED_MEMBER = /^\s*(?:[\w$]+|"[^"]*"|'[^']*')\s*:\s*(?:new\s+)?(?!async\b|function\b)[A-Za-z_$][\w$.]*\s*\(/;

/** The `new` flag and the callee path of a call-valued member. */
const CALLEE = /^\s*(?:[\w$]+|"[^"]*"|'[^']*')\s*:\s*(new\s+)?([A-Za-z_$][\w$.]*)\s*\(/;

/** The declared return type of a `function` declaration: what follows the parameter list's `)` and a `:`, up to the
 *  body's `{`. `null` when it declares none. */
function declaredReturnType(body: string): string | null {
  if (!/^(?:export\s+)?(?:async\s+)?function\b/.test(body)) return null;
  let k = body.indexOf("(");
  if (k < 0) return null;
  for (let depth = 0; k < body.length; k++) {
    if (body[k] === "(") depth++;
    else if (body[k] === ")" && --depth === 0) break;
  }
  const after = /^\s*:/.exec(body.slice(k + 1));
  if (!after) return null;
  let end = k + 1 + after[0].length;
  for (let depth = 0; end < body.length; end++) {
    const c = body[end]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{" && depth === 0) break;
  }
  return body.slice(k + 1 + after[0].length, end).trim();
}

/**
 * W1-T9737: the column-0 functions whose result is itself a function, found structurally (no function is named):
 * the body returns an arrow or a `function`, or returns an identifier that is a local or column-0 function, or the
 * declared return type is a function type or `typeof <column-0 function>`. A body that merely contains a returning
 * arrow also counts: the walk is an upper bound, and a false factory only keeps a member as reach.
 */
export function factoryNames(fns: readonly Fn[]): Set<string> {
  const names = new Set(fns.map((f) => f.name));
  const out = new Set<string>();
  const fnValue = (id: string, body: string) =>
    names.has(id) ||
    new RegExp(`\\bfunction\\s*\\*?\\s*${id.replace(/\$/g, "\\$")}\\b|\\b(?:const|let)\\s+${id.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=>`).test(body);
  for (const f of fns) {
    const type = declaredReturnType(f.body);
    const typeofFn = type === null ? null : /^typeof\s+([A-Za-z_$][\w$]*)$/.exec(type);
    if (
      /\breturn\s+(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|\breturn\s+(?:async\s+)?function\b/.test(f.body) ||
      (type !== null && /^(?:<[^>]*>\s*)?\([^]*\)\s*=>/.test(type)) ||
      (typeofFn !== null && names.has(typeofFn[1]!)) ||
      [...f.body.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*;/g)].some((m) => fnValue(m[1]!, f.body))
    ) {
      out.add(f.name);
    }
  }
  return out;
}

/**
 * W1-T9701: split an object-literal node at `open` (its literal's `{`) into what the const hands over and what runs at
 * module load. Kept as reach: every member that is a function (an arrow, a method, a `function`), a handed-over
 * value, and a call that is passed a function (a wrapper may run it later). Moved to module load: a call-valued member
 * with no function in it, and the code after the literal closes (a column-0 statement in the same node). Both halves
 * keep the body's length and newlines, so neither shifts what the other matches.
 */
export function splitObjectLiteral(body: string, open: number, factories: ReadonlySet<string> = new Set()): { reach: string; load: string } {
  const reach = body.split("");
  const load = body.replace(/[^\n]/g, " ").split("");
  const move = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (body[k] === "\n") continue;
      load[k] = body[k]!;
      reach[k] = " ";
    }
  };
  const member = (from: number, to: number) => {
    const text = body.slice(from, to);
    if (!CALL_VALUED_MEMBER.test(text) || /=>|\bfunction\b/.test(text)) return;
    const call = CALLEE.exec(text);
    // W1-T9737: a factory runs at load only to RETURN a function the loop calls later, so it stays reach.
    if (call && !call[1] && factories.has(call[2]!.split(".").pop()!)) return;
    move(from, to);
  };
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < body.length && body[j] !== c && (c === "`" || body[j] !== "\n")) j += body[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "/" && body[i + 1] === "/") {
      while (i + 1 < body.length && body[i + 1] !== "\n") i++;
    } else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) {
        member(start, i);
        move(i + 1, body.length);
        break;
      }
    } else if (c === "," && depth === 1) {
      member(start, i);
      start = i + 1;
    }
  }
  return { reach: reach.join(""), load: load.join("") };
}

/** Column-0 function declarations (generators included) and column-0 arrow consts; a body runs to the
 *  next column-0 declaration (a closing brace at column 0 is NOT a boundary: a multi-line parameter type
 *  closes with one). `objectLiterals` also walks {@link OBJECT_DECL} bodies, split by {@link splitObjectLiteral}:
 *  what one evaluates at import goes to the {@link MODULE_LOAD} node. */
export function topLevelFunctions(opts: { objectLiterals?: boolean } = {}): Fn[] {
  const fns: Fn[] = [];
  const decl =
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
  const NEXT_DECL = /^(?:export\s+|declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|abstract)\b|^export\s/;
  // Object literals wait for the factory index, which needs every file's functions.
  const literals: { slot: number; name: string; file: string; body: string; open: number }[] = [];
  for (const file of trackedSourceFiles()) {
    const lines = stripComments(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const fn = decl.exec(lines[i]!);
      const m = fn ?? (opts.objectLiterals ? OBJECT_DECL.exec(lines[i]!) : null);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && !NEXT_DECL.test(lines[end]!)) end++;
      const body = lines.slice(i, end).join("\n");
      if (fn) {
        fns.push({ name: (m[1] ?? m[2])!, file, body });
        continue;
      }
      literals.push({ slot: fns.length, name: m[1]!, file, body, open: m.index + m[0].length - 1 });
    }
  }
  if (literals.length === 0) return fns;
  const factories = factoryNames(fns);
  const out: Fn[] = [];
  let next = 0;
  for (let slot = 0; slot <= fns.length; slot++) {
    for (; next < literals.length && literals[next]!.slot === slot; next++) {
      const lit = literals[next]!;
      const { reach, load } = splitObjectLiteral(lit.body, lit.open, factories);
      out.push({ name: lit.name, file: lit.file, body: reach });
      if (load.trim() !== "") out.push({ name: MODULE_LOAD, file: lit.file, body: load });
    }
    if (slot < fns.length) out.push(fns[slot]!);
  }
  return out;
}

const valueNameCache = new WeakMap<Fn, { body: string; names: readonly string[] }>();
const TYPE_QUERY_CONTEXT = [
  /\btype\s+[A-Za-z_$][\w$]*(?:\s*<[^;={}]*>)?\s*=\s*(?:\{[^{}]*|[^;={}]*)$/,
  /\binterface\s+[A-Za-z_$][\w$]*[^;={}]*\{[^{}]*$/,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:[^;={}]*$/,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)*[A-Za-z_$][\w$]*\??\s*:[^;={}]*$/,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^();={}]*\)\s*:[^;={}]*$/,
  /\bfunction\s*[A-Za-z_$]*\s*\([^;={}]*:[^;={}]*$/,
  /\b(?:as|satisfies)\s+typeof$/,
];

/** W1-T9736: property names and type queries do not hand over a same-named function. */
function valueNames(fn: Fn): readonly string[] {
  const cached = valueNameCache.get(fn);
  if (cached?.body === fn.body) return cached.names;
  const { body } = fn;
  const out: string[] = [];
  for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const before = body.slice(0, m.index).trimEnd();
    const after = body.slice(m.index + m[0].length);
    if (before.endsWith(".") && !before.endsWith("...")) continue;
    const memberStart = before.replace(/\breadonly$/, "").trimEnd();
    if ((memberStart === "" || /[{(,;]/.test(memberStart.at(-1)!)) && /^\s*\??\s*:/.test(after)) continue;
    if (before.endsWith("typeof") && /\btypeof$/.test(before.slice(-7)) && TYPE_QUERY_CONTEXT.some((context) => context.test(before))) continue;
    out.push(m[0]);
  }
  valueNameCache.set(fn, { body, names: out });
  return out;
}

/** Name-based fixed point over value identifiers in reachable bodies. */
export function loopReachable(fns: Fn[], seed: string): Set<string> {
  const byName = new Map<string, Fn[]>();
  for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const reached = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const name = queue.pop()!;
    for (const f of byName.get(name) ?? []) {
      for (const id of valueNames(f)) {
        if (byName.has(id) && !reached.has(id)) {
          reached.add(id);
          queue.push(id);
        }
      }
    }
  }
  return reached;
}
