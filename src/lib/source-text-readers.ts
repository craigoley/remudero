import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

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
export const CENSUS_CLOSURE_MARKER = "@census-closure:";

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

const isExclusion = (lit: string): boolean => lit.startsWith(":!") || lit.startsWith(":^") || /^:\([^)]*exclude/.test(lit);

/** The pathspecs of every `git ls-files`/`git grep` argv literal in the text. Exclusions (`:!`,
 *  `:(exclude)`) narrow a walk and are skipped; a grep pattern never names a tracked root. */
function walksFromGitArgv(text: string, roots: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^[\]]*["'`](?:ls-files|grep)["'`][^[\]]*)\]/g)) {
    for (const lit of literals(m[1])) {
      if (isExclusion(lit)) continue;
      const walk = toWalk(lit, roots);
      if (walk) out.push(walk);
    }
  }
  return out;
}

const GIT_SPAWN_ARGV = /\[[^[\]]*["'`](?:ls-files|grep|diff|status)["'`][^[\]]*\]/;

/** W1-T10063: in a suite that spawns git, the literals after `"--"` in ANY array literal are a pathspec. A
 *  helper (`gitGrepFiles(flags, [base, "--", "test"])`) takes its pathspec from the caller's array, so the
 *  literal naming the subcommand and the pathspec sit in different arrays. */
function walksFromPathspecArrays(text: string, roots: ReadonlySet<string>): string[] {
  if (!GIT_SPAWN_ARGV.test(text)) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^[\]]*["'`]--["'`][^[\]]*)\]/g)) {
    const lits = literals(m[1]);
    for (const lit of lits.slice(lits.indexOf("--") + 1)) {
      if (isExclusion(lit)) continue;
      const walk = toWalk(lit, roots);
      if (walk) out.push(walk);
    }
  }
  return out;
}

/** The `@census-reads:` declarations, or undefined when the file carries none. `none` declares a
 *  suite that reads no tracked text (its marker is about a fixture or its own output). */
function declaredReads(text: string, roots: ReadonlySet<string>, marker = CENSUS_READS_MARKER): { walks: string[]; none: boolean } | undefined {
  let declared: { walks: string[]; none: boolean } | undefined;
  for (const line of text.split("\n")) {
    // Only a COMMENT line declares: the marker inside a fixture string is data, not this suite's claim.
    const comment = /^\s*(?:\/\/|\/?\*+)\s*(.*)$/.exec(line)?.[1];
    if (comment === undefined || !comment.startsWith(marker)) continue;
    const at = line.indexOf(marker);
    declared ??= { walks: [], none: false };
    // Leading tokens only: a declaration may carry a reason after it, and a path in that prose is not a read.
    for (const token of line.slice(at + marker.length).trim().split(/\s+/)) {
      const bare = token.replace(/[,;]$/, "");
      const walk = toWalk(bare, roots);
      if (bare === "none") declared.none = true;
      else if (walk) declared.walks.push(walk);
      else break;
    }
  }
  return declared;
}

/** Literal runtime imports, excluding comments, string contents and type-only declarations. */
function runtimeSpecifiers(text: string): string[] {
  const scanner = createScanner(true, undefined, text);
  const tokens: { kind: SyntaxKind; value: string }[] = [];
  const braceDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.TemplateHead) braceDepths.push(0);
    else if (kind === SyntaxKind.OpenBraceToken && braceDepths.length > 0) braceDepths[braceDepths.length - 1]++;
    else if (kind === SyntaxKind.CloseBraceToken && braceDepths.length > 0) {
      if (braceDepths[braceDepths.length - 1] === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) braceDepths.pop();
      } else braceDepths[braceDepths.length - 1]--;
    }
    tokens.push({ kind, value: kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText() });
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    const importing = token.kind === SyntaxKind.ImportKeyword;
    if ((importing || (token.kind === SyntaxKind.Identifier && token.value === "require")) && next?.kind === SyntaxKind.OpenParenToken &&
        tokens[i + 2]?.kind === SyntaxKind.StringLiteral) {
      out.push(tokens[i + 2]!.value);
      continue;
    }
    if (!importing && token.kind !== SyntaxKind.ExportKeyword) continue;
    if (importing && next?.kind === SyntaxKind.StringLiteral) {
      out.push(next.value);
      continue;
    }
    if (!next || next.value === "type") continue;
    if (!importing && next.kind !== SyntaxKind.OpenBraceToken && next.kind !== SyntaxKind.AsteriskToken) continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const part = tokens[j]!;
      if ([SyntaxKind.SemicolonToken, SyntaxKind.ImportKeyword, SyntaxKind.ExportKeyword].includes(part.kind)) break;
      if (part.value !== "from" || tokens[j + 1]?.kind !== SyntaxKind.StringLiteral) continue;
      const clause = tokens.slice(i + 1, j);
      // An exclusively named clause with only `type T` members has no runtime edge.
      const members = clause.slice(1, -1).map((t) => t.value).join(" ").split(",").filter((s) => s.trim());
      const onlyTypes = clause[0]?.kind === SyntaxKind.OpenBraceToken &&
        members.every((s) => /^\s*type\s+(?!as\b)\w/.test(s));
      if (!onlyTypes) out.push(tokens[j + 1]!.value);
      break;
    }
  }
  return out;
}

function runtimeClosure(seed: string, paths: ReadonlySet<string>, readFile: (path: string) => string): string[] {
  const seen = new Set<string>();
  const queue = [seed];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !paths.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFile(file))) {
      if (spec.startsWith(".")) queue.push(posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, ".ts"));
    }
  }
  return [...seen];
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
      const def = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(text);
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
export function sourceTextReaderOf(
  testFile: string, text: string, roots: ReadonlySet<string>,
  closure: (seed: string) => readonly string[] = () => [],
): SourceTextReader {
  const walks = new Set<string>();
  const readCall = /\breadFile(?:Sync)?\s*\(/g;
  for (let m = readCall.exec(text); m; m = readCall.exec(text)) {
    const args = withConstantsInlined(callArgs(text, m.index + m[0].length - 1), text);
    for (const walk of walksFromArgs(args, roots)) walks.add(walk);
  }
  const gitWalks = [...walksFromGitArgv(text, roots), ...walksFromPathspecArrays(text, roots)];
  for (const walk of gitWalks) walks.add(walk);
  const declared = declaredReads(text, roots);
  // A declaration is AUTHORITATIVE: it replaces what the text appears to read, so a suite whose
  // fixtures are read-call strings (a census of the census) names its real walk and nothing else.
  if (declared !== undefined) walks.clear();
  for (const walk of [...(declared?.walks ?? []), ...subjectMarkerWalks(text, roots)]) walks.add(walk);
  const seeds = declaredReads(text, roots, CENSUS_CLOSURE_MARKER);
  for (const seed of seeds?.walks ?? []) for (const file of closure(seed)) walks.add(file);
  const declaresSourceSubject = text.includes(SOURCE_TEXT_SUBJECT_MARKER) || declared !== undefined || seeds !== undefined;
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
  `readFile(Sync)?[[:space:]]*\\(|ls-files|["'\`](grep|diff|status)["'\`]|${SOURCE_TEXT_SUBJECT_MARKER}|${CENSUS_READS_MARKER}|${CENSUS_CLOSURE_MARKER}`,
  "--",
  "test/*.test.ts",
];

/** The default `git` for {@link discoverSourceTextReaders}: a read of the checkout it is given. */
function checkoutGit(repoRoot: string): (args: readonly string[]) => string {
  return (args) => execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The impure edge: every test suite that reads tracked text, with what it reads. A suite that
 *  reads only temp fixtures resolves no walk and is dropped unless it carries a marker, which the
 *  meta-census then holds to resolving. */
export function discoverSourceTextReaders(
  repoRoot: string,
  git: (args: readonly string[]) => string = checkoutGit(repoRoot),
  readFile: (path: string) => string = (path) => readFileSync(join(repoRoot, path), "utf8"),
): SourceTextReader[] {
  const paths = new Set(
    git(["ls-files", "--cached", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean)
  );
  const roots = new Set([...paths].map((p) => p.split("/")[0]));
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
    const reader = sourceTextReaderOf(testFile, readFile(testFile), roots, (seed) => runtimeClosure(seed, paths, readFile));
    if (reader.walks.length > 0 || reader.declaresSourceSubject) out.push(reader);
  }
  return out;
}
