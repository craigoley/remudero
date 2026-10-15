import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHICH TRACKED FILES A TEST SUITE READS AS TEXT — the population a source-text census walks, derived
 * from the read itself rather than from how the suite enumerates.
 *
 * MEASURED 2026-10-15: two hand PRs passed `rmd census-membership` and the census precheck and went
 * red in CI. #12019 tripped test/a-wall-clock-bound-declares-itself.test.ts, which walks
 * `test/*.test.ts` through `git grep`; #12104 tripped
 * test/a-generic-route-has-an-explicit-tool-bound.test.ts, which reads src/run-task.ts through one
 * `readFileSync`. The census recognizer admits a suite only by an enumeration token (`ls-files`,
 * `readdirSync`, `globSync`), so it was blind to both: neither was even named as unmodelled.
 *
 * A read names its own path, so membership is DERIVED from it: every `readFileSync`/`readFile`
 * argument and every `git ls-files`/`git grep` pathspec that names a tracked root. A suite whose
 * read the derivation cannot resolve DECLARES it with {@link CENSUS_READS_MARKER} followed by the
 * paths or globs it reads, and test/every-source-reading-suite-declares-what-it-reads.test.ts fails
 * on a source-reading suite that is neither derivable nor declared.
 */

/** A suite that cannot be placed by derivation names what it reads after this marker, e.g.
 *  `// @census-reads: src/lib/review.ts src/lib/*.ts — why`. `none` declares it reads no tracked text. */
export const CENSUS_READS_MARKER = "@census-reads:";

/** The marker test/source-text-assertion-census.test.ts reads as "this suite's SUBJECT is source
 *  text". Such a suite is census-shaped: it asserts over what a file says, so any edit there can move it. */
export const SOURCE_TEXT_SUBJECT_MARKER = "@source-text-subject";

export interface SourceTextReader {
  readonly testFile: string;
  /** Tracked-path prefixes the suite reads: an exact file, a directory ending `/`, or a glob cut at
   *  its first wildcard. Prefix matching over-includes on purpose: a wider join costs a suite run, a
   *  narrower one costs a CI round. */
  readonly walks: readonly string[];
  /** Declared with either marker, or walking a pathspec: its subject is the text, not the behaviour. */
  readonly censusShaped: boolean;
  /** Carries a marker, so the meta-census requires it to resolve to at least one walk. */
  readonly declaresSourceSubject: boolean;
  /** Declared `@census-reads: none`: the marker is about a fixture or the suite's own output. */
  readonly readsNothingTracked: boolean;
}

/** The meta-census predicate: a suite that declares source text as its subject but can be placed by
 *  neither derivation nor declaration is one `rmd census-membership` cannot select for any diff. */
export function isUnplacedSourceReader(reader: SourceTextReader): boolean {
  return reader.declaresSourceSubject && reader.walks.length === 0 && !reader.readsNothingTracked;
}

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

/** A literal path as a walk prefix, or undefined when its first segment is not a tracked root. */
function toWalk(raw: string, roots: ReadonlySet<string>): string | undefined {
  const cleaned = raw
    .replaceAll("\\", "/")
    .replace(/\$\{[^}]*\}\/?/g, "")
    .replace(/^:\([^)]*\)/, "")
    .replace(/^(?:\.{1,2}\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  const first = cleaned.split("/")[0];
  if (!first || !roots.has(first)) return undefined;
  // A bare top-level FILE (README.md) is read whole; a bare top-level directory walks everything under it.
  if (cleaned === first) return /^[^.].*\.[A-Za-z0-9]+$/.test(first) ? first : `${first}/`;
  const wildcard = cleaned.search(/[*?[]/);
  return wildcard >= 0 ? cleaned.slice(0, wildcard) : cleaned;
}

function literals(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].map((m) => m[2]);
}

/** Walks named by one read call's arguments. A `join(...)`/`resolve(...)` is composed from its
 *  literal segments, so `join(ROOT, "src", "run-task.ts")` reads `src/run-task.ts`; a segment that is
 *  a variable stops the composition there, so `join(ROOT, "src", file)` reads `src/`. */
function walksFromArgs(args: string, roots: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const joinCall = /\b(?:join|resolve)\s*\(/g;
  for (let m = joinCall.exec(args); m; m = joinCall.exec(args)) {
    const inner = callArgs(args, m.index + m[0].length - 1);
    const parts = inner.split(",").map((p) => p.trim());
    const start = parts.findIndex((p) => /^(['"`])/.test(p) && toWalk(literals(p)[0] ?? "", roots));
    if (start < 0) continue;
    const segments: string[] = [];
    for (const part of parts.slice(start)) {
      const lit = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(part);
      if (!lit) break;
      segments.push(lit[2]);
    }
    const walk = toWalk(segments.join("/"), roots);
    if (walk) out.push(walk);
  }
  // A standalone path literal (`"../src/run-task.ts"`, `${root}/src/lib/x.ts`). A bare root name is
  // only ever a `join` segment, composed above; read alone here it would widen the walk to the root.
  for (const lit of literals(args)) {
    const walk = lit.includes("/") ? toWalk(lit, roots) : undefined;
    if (walk) out.push(walk);
  }
  return out;
}

/** The pathspecs of every `git ls-files`/`git grep` argv literal in the text. Exclusions (`:!`,
 *  `:(exclude)`) narrow a walk and are skipped; a grep pattern never names a tracked root. */
function walksFromGitArgv(text: string, roots: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^[\]]*["'`](?:ls-files|grep)["'`][^[\]]*)\]/g)) {
    for (const lit of literals(m[1])) {
      if (lit.startsWith(":!") || lit.startsWith(":^") || /^:\([^)]*exclude/.test(lit)) continue;
      const walk = toWalk(lit, roots);
      if (walk) out.push(walk);
    }
  }
  return out;
}

/** The `@census-reads:` declarations, or undefined when the file carries none. `none` declares a
 *  suite that reads no tracked text (its marker is about a fixture or its own output). */
function declaredReads(text: string, roots: ReadonlySet<string>): { walks: string[]; none: boolean } | undefined {
  let declared: { walks: string[]; none: boolean } | undefined;
  for (const line of text.split("\n")) {
    // Only a COMMENT line declares: the marker inside a fixture string is data, not this suite's claim.
    if (!/^\s*(?:\/\/|\/?\*+)\s*@census-reads:/.test(line)) continue;
    const at = line.indexOf(CENSUS_READS_MARKER);
    declared ??= { walks: [], none: false };
    // Leading tokens only: a declaration may carry a reason after it, and a path in that prose is not a read.
    for (const token of line.slice(at + CENSUS_READS_MARKER.length).trim().split(/\s+/)) {
      const bare = token.replace(/[,;]$/, "");
      const walk = toWalk(bare, roots);
      if (bare === "none") declared.none = true;
      else if (walk) declared.walks.push(walk);
      else break;
    }
  }
  return declared;
}

/** Paths a `@source-text-subject: src/** — …` marker names before its prose begins. Only the
 *  LEADING path tokens count, so prose that mentions a path later is never read as a declaration. */
function subjectMarkerWalks(text: string, roots: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf(SOURCE_TEXT_SUBJECT_MARKER);
    if (at < 0) continue;
    const tokens = line.slice(at + SOURCE_TEXT_SUBJECT_MARKER.length).replace(/^\s*[:\u2014-]?\s*/, "").split(/\s+/);
    for (const token of tokens) {
      const bare = token.replace(/[,;]$/, "");
      const walk = /[/.]/.test(bare) ? toWalk(bare, roots) : undefined;
      if (!walk) break;
      out.push(walk);
    }
  }
  return out;
}

/** One hop through named paths: every identifier in a read's arguments that the file defines as a
 *  one-line `const` is replaced by its initializer, so `const RUN_TASK = join(ROOT, "src/run-task.ts");
 *  readFileSync(RUN_TASK)` reads src/run-task.ts. One hop only: a name built from another name stops here. */
function withConstantsInlined(args: string, text: string): string {
  // Names inside a string literal or after a `.` are not references; only the code between literals is rewritten.
  const inline = (code: string) =>
    code.replace(/(?<![.\w$])[A-Za-z_$][\w$]*/g, (name) => {
      const def = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(text);
      return def ? def[1] : name;
    });
  let out = "";
  let last = 0;
  for (const m of args.matchAll(STRING_LITERAL)) {
    out += inline(args.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + inline(args.slice(last));
}

/**
 * PURE: what one suite's text reads, as walk prefixes. `roots` is the set of top-level tracked
 * names, so a literal is a read of the tree only when it starts at one of them.
 */
export function sourceTextReaderOf(testFile: string, text: string, roots: ReadonlySet<string>): SourceTextReader {
  const walks = new Set<string>();
  const readCall = /\breadFile(?:Sync)?\s*\(/g;
  for (let m = readCall.exec(text); m; m = readCall.exec(text)) {
    const args = withConstantsInlined(callArgs(text, m.index + m[0].length - 1), text);
    for (const walk of walksFromArgs(args, roots)) walks.add(walk);
  }
  const gitWalks = walksFromGitArgv(text, roots);
  for (const walk of gitWalks) walks.add(walk);
  const declared = declaredReads(text, roots);
  // A declaration is AUTHORITATIVE: it replaces what the text appears to read, so a suite whose
  // fixtures are read-call strings (a census of the census) names its real walk and nothing else.
  if (declared !== undefined) walks.clear();
  for (const walk of [...(declared?.walks ?? []), ...subjectMarkerWalks(text, roots)]) walks.add(walk);
  const declaresSourceSubject = text.includes(SOURCE_TEXT_SUBJECT_MARKER) || declared !== undefined;
  return {
    testFile,
    walks: [...walks].sort(),
    censusShaped: declaresSourceSubject || gitWalks.length > 0,
    declaresSourceSubject,
    readsNothingTracked: declared?.none === true,
  };
}

/** True when `path` falls under one of the reader's walks. */
export function readerJoins(reader: Pick<SourceTextReader, "walks">, path: string): boolean {
  return reader.walks.some((walk) => path.startsWith(walk));
}

/** The probe that finds every suite that could read tracked text. `--untracked` so the suite being
 *  added in this diff is seen before it is committed, as W1-T3021 does for the census probe. */
export const SOURCE_TEXT_READER_PROBE_ARGV: readonly string[] = [
  "grep",
  "--untracked",
  "-lE",
  `readFile(Sync)?[[:space:]]*\\(|ls-files|["'\`]grep["'\`]|${SOURCE_TEXT_SUBJECT_MARKER}|${CENSUS_READS_MARKER}`,
  "--",
  "test/*.test.ts",
];

export interface SourceTextReaderDeps {
  readonly git?: (args: readonly string[]) => string;
  readonly readFile?: (path: string) => string;
}

/** The impure edge: every test suite that reads tracked text, with what it reads. A suite that
 *  reads only temp fixtures resolves no walk and is dropped unless it carries a marker, which the
 *  meta-census then holds to resolving. */
export function discoverSourceTextReaders(repoRoot: string, deps: SourceTextReaderDeps = {}): SourceTextReader[] {
  const git = deps.git ?? ((args) => execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const readFile = deps.readFile ?? ((path) => readFileSync(join(repoRoot, path), "utf8"));
  const roots = new Set(
    git(["ls-files", "--cached", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean)
      .map((p) => p.split("/")[0]),
  );
  let hits: string[];
  try {
    hits = git([...SOURCE_TEXT_READER_PROBE_ARGV]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    // `git grep` exits 1 on no match; anything else is a failed read and must not read as "no readers".
    if ((e as { status?: number }).status === 1) hits = [];
    else throw e;
  }
  const out: SourceTextReader[] = [];
  for (const testFile of hits.sort()) {
    const reader = sourceTextReaderOf(testFile, readFile(testFile), roots);
    if (reader.walks.length > 0 || reader.declaresSourceSubject) out.push(reader);
  }
  return out;
}
