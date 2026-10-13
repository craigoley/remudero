// A short, bounded signature of one worker tool call, for the `worker.activity` ledger row (operator ruling, 2026-10-13).
// It records WHAT ran so a miner can find procedures: a Bash program and subcommand, or a file tool and its repo-relative
// path. It never records a flag value, a quoted string, a URL, a header, or any later argument. Each word it does emit
// follows the program or a flag it knows; an unknown flag ends the walk, so a flag's value can never pass for a subcommand.

import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const SIGNATURE_MAX_CHARS = 120;
const OUTSIDE = "<outside>";
const FILE_PATH_KEYS: Readonly<Record<string, string>> = {
  Read: "file_path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path",
  Grep: "path", Glob: "path",
};
// Exported only so test/tool-step-signature.test.ts can drive each validator's refusing arm directly.
export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
export const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/;
export const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
export const PACKAGE_RE = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@[\w.^~-]+)?$/i;
export const UNSAFE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:|[\u0000-\u001f\u007f$`]/;

/** Per program, space-separated: the flags that take a separate value, then the flags that take none. Any other flag
 *  ends the walk. */
const FLAGS: Readonly<Record<string, readonly [string, string]>> = {
  git: ["-C -c --git-dir --work-tree --namespace --config-env",
    "--no-pager -P --paginate -p --bare --no-optional-locks --no-replace-objects --literal-pathspecs"],
  npm: ["--prefix -w --workspace", "-s --silent -q --quiet --ws --workspaces -y --yes --no-fund --no-audit --offline"],
  npx: ["-p --package -c --call", "-y --yes --no --no-install -q --quiet --ignore-existing"],
  gh: ["-R --repo", ""],
  rmd: ["", ""],
  node: ["--import -r --require --loader --experimental-loader --test-name-pattern --test-skip-pattern --test-reporter " +
    "--test-reporter-destination --test-concurrency --test-timeout --test-shard --input-type -C --conditions --env-file " +
    "--stack-size --title --watch-path",
    "--test --test-only --test-force-exit --test-update-snapshots --experimental-test-coverage " +
    "--experimental-test-module-mocks --experimental-strip-types --no-experimental-strip-types --experimental-vm-modules " +
    "--enable-source-maps --no-warnings --trace-warnings --expose-gc --watch --inspect --inspect-brk"],
  tsx: ["", "--watch"],
};

type Word = { word: string; dynamic: boolean };
type Token = Word | { op: string };
/** The lexer's last token when it meets an unterminated quote or substitution: the command cannot be read. */
const UNPARSEABLE: Token = { op: "unparseable" };

/**
 * The bounded signature of one tool call: `Bash:<program> [<subcommand>]`, `<FileTool>:<repo-relative path>` (or
 * `<outside>`), or the bare tool name. `worktree` is the absolute directory the worker ran in; a path is shown only
 * when it resolves inside it. `undefined` when the input cannot be read without guessing.
 */
export function toolStepSignature(toolName: string, input: unknown, worktree: string): string | undefined {
  if (!toolName) return undefined;
  const fields = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  let signature: string | undefined;
  if (toolName === "Bash") {
    signature = typeof fields?.command === "string" ? bashSignature(fields.command, worktree) : undefined;
  } else if (FILE_PATH_KEYS[toolName]) {
    const path = fields?.[FILE_PATH_KEYS[toolName]];
    if (typeof path === "string" && path.length > 0) signature = `${toolName}:${pathSignature(path, worktree)}`;
    else if (path === undefined && fields && (toolName === "Grep" || toolName === "Glob")) signature = toolName;
  } else {
    signature = toolName;
  }
  return signature?.slice(0, SIGNATURE_MAX_CHARS);
}

function pathSignature(path: string, worktree: string): string {
  if (!isAbsolute(worktree) || UNSAFE_PATH_RE.test(path)) return OUTSIDE;
  const rel = relative(worktree, resolve(worktree, path));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return OUTSIDE;
  return rel.split(sep).join("/");
}

/** Reads only as far as the signature needs; an unreadable stretch inside that reach makes the whole answer undefined. */
function bashSignature(command: string, worktree: string): string | undefined {
  const lexer = lex(command);
  let unparseable = false;
  const next = (): Token | undefined => {
    const step = lexer.next();
    unparseable ||= step.value === UNPARSEABLE;
    return step.done || unparseable ? undefined : step.value;
  };
  const signature = firstCommandSignature(next, worktree);
  return unparseable ? undefined : signature;
}

function firstCommandSignature(next: () => Token | undefined, worktree: string): string | undefined {
  for (;;) {
    let token = next();
    while (token && "word" in token && ASSIGNMENT_RE.test(token.word)) token = next();
    if (!token) return undefined;
    if ("op" in token) continue;
    if (token.dynamic) return undefined;
    const program = basename(token.word);
    if (!PROGRAM_RE.test(program)) return undefined;
    if (program !== "cd" && program !== "export") return commandSignature(program, next, worktree);
    // A leading `cd <dir> &&` / `cd <dir>;`, or an `export` of assignments only, sets up the command that follows it.
    let onlyAssignments = true;
    let rest = next();
    for (; rest && "word" in rest; rest = next()) onlyAssignments &&= ASSIGNMENT_RE.test(rest.word);
    const ended = rest && (rest.op === "&&" || rest.op === ";");
    if (!ended || (program === "export" && !onlyAssignments)) return `Bash:${program}`;
  }
}

function commandSignature(program: string, next: () => Token | undefined, worktree: string): string {
  const flags = FLAGS[program];
  if (!flags) return `Bash:${program}`;
  const nextWord = (): Word | undefined => {
    const token = next();
    return token && "word" in token ? token : undefined;
  };
  if (program === "node" || program === "tsx") return scriptSignature(program, flags, nextWord, worktree);
  const sub = firstPositional(flags, nextWord);
  if (program === "npx") {
    const pkg = sub && PACKAGE_RE.exec(sub);
    return pkg ? `Bash:npx ${pkg[1]}` : "Bash:npx";
  }
  if (!sub || !SUBCOMMAND_RE.test(sub)) return `Bash:${program}`;
  if (program !== "npm" || (sub !== "run" && sub !== "run-script")) return `Bash:${program} ${sub}`;
  const script = firstPositional(flags, nextWord);
  return script && SCRIPT_RE.test(script) ? `Bash:npm ${sub} ${script}` : `Bash:npm ${sub}`;
}

/** `node`/`tsx` plus the script it runs, shown only when inside the worktree. `--test` is kept: it names the mode. */
function scriptSignature(
  program: string,
  flags: readonly [string, string],
  nextWord: () => Word | undefined,
  worktree: string,
): string {
  let isTest = false;
  const script = firstPositional(flags, nextWord, (flag) => (isTest ||= flag === "--test"));
  const head = `Bash:${program}${isTest ? " --test" : ""}`;
  const path = script === undefined ? OUTSIDE : pathSignature(script, worktree);
  return path === OUTSIDE ? head : `${head} ${path}`;
}

/** The first word that is neither a known flag nor a known flag's value; `undefined` at an unknown flag or a `$` word. */
function firstPositional(
  [valueFlags, booleanFlags]: readonly [string, string],
  nextWord: () => Word | undefined,
  onFlag: (flag: string) => void = () => {},
): string | undefined {
  for (let token = nextWord(); token; token = nextWord()) {
    const { word, dynamic } = token;
    if (word === "--") {
      const after = nextWord();
      return after && !after.dynamic ? after.word : undefined;
    }
    if (!word.startsWith("-")) return dynamic ? undefined : word;
    if (/^--[^=]+=/.test(word)) continue;
    if (valueFlags.split(" ").includes(word)) nextWord();
    else if (!booleanFlags.split(" ").includes(word)) return undefined;
    onFlag(word);
  }
  return undefined;
}

/** A lazy shell lexer: words (quotes removed, `dynamic` when they hold an expansion) and control operators. Redirections
 *  and comments are dropped. It ends with {@link UNPARSEABLE} at an unterminated quote or substitution. */
function* lex(src: string): Generator<Token> {
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (c === " " || c === "\t") i++;
    else if (c === "\\" && src[i + 1] === "\n") i += 2;
    else if (c === "\n") {
      i++;
      yield { op: ";" };
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "<" || c === ">") {
      const end = skipRedirect(src, i);
      if (end === undefined) {
        yield UNPARSEABLE;
        return;
      }
      i = end;
    } else {
      const op = /^(?:&&|\|\||;;|\|&|[;&|()])/.exec(src.slice(i, i + 2));
      if (op) {
        i += op[0].length;
        yield { op: op[0] };
        continue;
      }
      const read = readWord(src, i);
      if (!read) {
        yield UNPARSEABLE;
        return;
      }
      i = read.end;
      // A run of digits right before `<`/`>` is a file-descriptor number, part of the redirection.
      if (!(/^\d+$/.test(read.word) && (src[i] === "<" || src[i] === ">"))) yield { word: read.word, dynamic: read.dynamic };
    }
  }
}

/** The offset past one redirection and its target; `undefined` when the target never closes. */
function skipRedirect(src: string, start: number): number | undefined {
  let i = start;
  while (src[i] === "<" || src[i] === ">") i++;
  if (src[i] === "&") {
    for (i++; /[\d-]/.test(src[i] ?? ""); ) i++;
    return i;
  }
  if (src[i] === "|" || src[i] === "-") i++;
  while (src[i] === " " || src[i] === "\t") i++;
  return i < src.length && !/[\n;&|()<>]/.test(src[i] ?? "") ? readWord(src, i)?.end : i;
}

/** One shell word from `start`, or `undefined` when a quote or substitution in it never closes. */
function readWord(src: string, start: number): (Word & { end: number }) | undefined {
  let word = "";
  let dynamic = false;
  let i = start;
  const after = (close: string, from: number): number => {
    const at = src.indexOf(close, from);
    return at < 0 ? -1 : at + 1;
  };
  // `$(…)`, `${…}`, `$NAME` and backticks make the word dynamic: its runtime value is unknown here. -1 if unterminated.
  const expansionEnd = (at: number): number => {
    dynamic = true;
    if (src[at] === "`") return after("`", at + 1);
    if (src[at + 1] === "{") return after("}", at + 2);
    if (src[at + 1] !== "(") return at + 1;
    for (let j = at + 2, depth = 1; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) return j + 1;
    }
    return -1;
  };
  while (i < src.length && !/[\s;&|()<>]/.test(src[i] ?? "")) {
    const c = src[i] ?? "";
    if (c === "'") {
      const end = after("'", i + 1);
      if (end < 0) return undefined;
      word += src.slice(i + 1, end - 1);
      i = end;
    } else if (c === '"') {
      for (i++; src[i] !== '"'; ) {
        if (i >= src.length) return undefined;
        if (src[i] === "\\" && i + 1 < src.length) {
          word += src[i + 1];
          i += 2;
        } else if (src[i] === "$" || src[i] === "`") {
          i = expansionEnd(i);
          if (i < 0) return undefined;
        } else word += src[i++];
      }
      i++;
    } else if (c === "\\") {
      word += src[i + 1] ?? "";
      i += 2;
    } else if (c === "$" || c === "`") {
      i = expansionEnd(i);
      if (i < 0) return undefined;
    } else {
      word += c;
      i++;
    }
  }
  return { word, dynamic, end: i };
}
