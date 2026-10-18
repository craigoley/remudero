#!/usr/bin/env node
// scripts/test-location-codemod.mjs — W1-T9864: make a test file LOCATION-FREE, as a content-only edit.
//
// WHY. A test's relative imports (`../src/x.js`, `./helpers/y.js`) encode its folder depth, so moving it
// rewrites its content and git stops pairing the move as a rename past ~1,100 files. package.json
// declares `#src/*`, `#scripts/*` and `#test/*` subpath imports; this codemod rewrites each relative
// specifier that lands in src/, scripts/ or test/ to its alias, so a later move is a PURE RENAME.
//
// WHAT IT REWRITES (static `from`, side-effect `import "x"`, and dynamic `import("x")`):
//   ../src/lib/x.js       -> #src/lib/x.js
//   ../scripts/y.mjs      -> #scripts/y.mjs
//   ./helpers/z.js, ./sibling.js, ../test/q.js -> #test/<path from test/>
//   a FIRST LINE `// test/<own-name>.test.ts` self-path comment is removed (it is false after a move).
//   join(<own folder>, "..", "x") / new URL("../x", import.meta.url) -> repoRoot() / join(repoRoot(), "x")
//   (W1-T9865: only a read that resolves to a path OUTSIDE the file's own folder and that is not a test file,
//   so the result is the same wherever the test sits; `import { repoRoot }` is added when it is used.)
// WHAT IT LISTS AND NEVER GUESSES: a relative specifier that leaves src/scripts/test (package.json, bin,
// packages), a runtime read of ./fixtures, `import.meta.url`/`__dirname` path math it cannot resolve to a
// location-free path, and a read of another test by its `test/<name>` path.
//
// USAGE: node scripts/test-location-codemod.mjs [--folder <name> ...] [--files <list-file>] [--write] [file ...]
//   --folder <name>  every test the placement table (scripts/test-placement/test-folders.tsv, W1-T9874) maps to
//                    <name>; when that file does not exist yet the folder selects nothing and says so.
//   --files <path>   a newline-separated list of test files.
//   --write          write the rewrite in place; without it the codemod only reports (a dry run).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repo-root.mjs";

/** The specifier of a static `from "x"`, a side-effect `import "x"`, or a dynamic `import("x")`. */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

/** The same shape as an ERE for `git grep -E` — POSIX classes, no `\s`/`\b`, which a POSIX engine drops silently. */
export const LOCATION_RELATIVE_ERE = "(from|import)[[:space:]]*\\(?[[:space:]]*[\"']\\.{1,2}/";

/** True when `text` carries at least one location-relative import specifier. */
export function hasLocationRelativeSpecifier(text) {
  return new RegExp(SPECIFIER_RE.source).test(text);
}

const ALIASES = [
  ["src/", "#src/"],
  ["scripts/", "#scripts/"],
  ["test/", "#test/"],
];

/** The alias for a repo-relative target path, or null when the target is outside src/scripts/test. */
export function aliasFor(target) {
  for (const [dir, alias] of ALIASES) if (target.startsWith(dir) && target.length > dir.length) return alias + target.slice(dir.length);
  return null;
}

/** Lines whose text reads a path at runtime in a location-dependent way. Reported, never rewritten. */
const RUNTIME_SHAPES = [
  [/import\.meta\.(url|dirname|filename)|__dirname|__filename/, "path derived from the file's own location"],
  [/["'`](\.\/)?fixtures\//, "runtime read of ./fixtures"],
  [/["'`]test\/[A-Za-z0-9_./-]+\.test\.ts["'`]/, "read of another test by its test/<name> path"],
];

/**
 * Which characters of `text` are CODE: not inside a comment, a string, a template literal's text or a regex
 * literal. A `from "./x.js"` inside a string is a FIXTURE (a test writing a source file for the tool under test),
 * never an import of this file, so rewriting it breaks the test (no-circular-is-an-error plants one).
 * A scanner and not a regex, for the reason src/lib/test-placement.ts's stripComments gives.
 * @returns {Uint8Array} 1 where the character is code
 */
export function codeMask(text) {
  const n = text.length;
  const mask = new Uint8Array(n);
  const braces = []; // brace depth at each open template `${`
  const regexAfter = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  let depth = 0;
  let last = "";
  let i = 0;
  const scanTemplate = () => {
    // `i` is just past the opening backtick or the closing brace of a `${ }`: consume template text.
    while (i < n) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        i += 1;
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        braces.push(depth);
        depth += 1;
        return;
      } else i += 1;
    }
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i += 1;
      last = c;
    } else if (c === "`") {
      i += 1;
      scanTemplate();
      last = "`";
    } else if (c === "/" && regexAfter.has(last)) {
      i += 1;
      let inClass = false;
      while (i < n && text[i] !== "\n" && (inClass || text[i] !== "/")) {
        if (text[i] === "\\") i += 1;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/i.test(text[i])) i += 1;
      last = "/";
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (braces.length > 0 && braces[braces.length - 1] === depth) {
          braces.pop();
          mask[i] = 1;
          i += 1;
          scanTemplate();
          last = "`";
          continue;
        }
      }
      mask[i] = 1;
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return mask;
}

/** The helper's name in a file where `repoRoot` is already a local identifier, so the call cannot read a shadow. */
const ALIASED_REPO_ROOT = "testRepoRoot";
/** A string literal argument, double- or single-quoted, without escapes. */
const LIT = `(?:"[^"\\n\\\\]*"|'[^'\\n\\\\]*')`;
const OWN_DIR_EXPRS = [
  "dirname\\(fileURLToPath\\(import\\.meta\\.url\\)\\)",
  "import\\.meta\\.dirname",
  `fileURLToPath\\(new URL\\((?:"\\.\\/?"|'\\.\\/?'), import\\.meta\\.url\\)\\)`,
];
const DUNDER_DECL_RE = /^[ \t]*const __dirname = (?:dirname\(fileURLToPath\(import\.meta\.url\)\)|import\.meta\.dirname);\r?\n/m;
/** Folders under test/ that no wave moves, so a path into one is the same wherever a test sits. */
const STABLE_TEST_DIRS = ["test/fixtures/", "test/helpers/", "test/setup/"];
const unquote = (lit) => lit.slice(1, -1);

/**
 * Rewrite a read of a path derived from the file's own location into a repoRoot() read, when the target is the
 * same wherever the file sits: it must lie inside the repo, outside test/ or in a folder no wave moves, and name
 * no test file (a test moves, so a read of it is resolveTestPath's job, never a fixed path).
 * @returns {{ text: string, count: number }}
 */
export function rewriteRootReads(text, file) {
  const dir = posix.dirname(file);
  const dunder = DUNDER_DECL_RE.test(text);
  const imported = /import\s*\{[^}]*\brepoRoot\b[^}]*\}\s*from\s*["']#test\/helpers\/repo-root\.js["']/.test(text);
  const call = !imported && /\brepoRoot\b/.test(text) ? `${ALIASED_REPO_ROOT}()` : "repoRoot()";
  const hasJoin = /import\s*\{[^}]*\bjoin\b[^}]*\}\s*from\s*["']node:path["']/.test(text);
  let count = 0;
  const emit = (rel) => {
    const target = posix.normalize(posix.join(dir, rel)).replace(/\/$/, "");
    if (target === "." || target === "") return call;
    if (target.startsWith("..") || target.endsWith(".test.ts")) return null;
    if (target === "test" || (target.startsWith("test/") && !STABLE_TEST_DIRS.some((d) => target.startsWith(d)))) return null;
    return hasJoin ? `join(${call}, ${JSON.stringify(target)})` : `\`\${${call}}/${target}\``;
  };
  const sub = (re, build) => {
    const mask = codeMask(text);
    text = text.replace(re, (whole, ...groups) => {
      const offset = groups[groups.length - 2];
      if (mask[offset] !== 1) return whole;
      const out = build(...groups);
      if (out === null) return whole;
      count += 1;
      return out;
    });
  };
  const dirExprs = [...OWN_DIR_EXPRS, ...(dunder ? ["__dirname"] : [])].join("|");
  sub(new RegExp(`\\b(?:join|resolve)\\(\\s*(${dirExprs})((?:\\s*,\\s*${LIT})*)\\s*,?\\s*\\)`, "g"), (dirExpr, args, offset) => {
    const parts = [...args.matchAll(new RegExp(LIT, "g"))].map((m) => unquote(m[0]));
    // test/source-text-assertion-census.test.ts cannot see a `src` segment that follows a NESTED call
    // (its `join\([^)]*` stops at the first `)`), so rewriting this read would make the census count a
    // source-text read it was blind to, and that ratchet takes no recorded number. Report it instead.
    if (dirExpr.includes(")") && parts.includes("src") && /\breadFileSync\(\s*$/.test(text.slice(0, offset))) return null;
    return emit(posix.join(...parts, "."));
  });
  sub(/fileURLToPath\(new URL\((["'])([^"'\n]+)\1, import\.meta\.url\)\)/g, (_q, rel) => emit(rel));
  sub(/(readFileSync|existsSync|readdirSync)\(new URL\((["'])([^"'\n]+)\2, import\.meta\.url\)/g, (fn, _q, rel) => {
    const out = emit(rel);
    return out === null ? null : `${fn}(${out}`;
  });
  let needsFileUrl = false;
  sub(/\bnew URL\((["'])([^"'\n`$]+)\1, ?import\.meta\.url\)/g, (_q, rel) => {
    const out = emit(rel);
    needsFileUrl ||= out !== null;
    return out === null ? null : `pathToFileURL(${out})`;
  });
  if (count === 0) return { text, count };
  if (needsFileUrl && !/import\s*\{[^}]*\bpathToFileURL\b/.test(text)) {
    const named = /import\s*\{([^}]*)\}\s*from\s*["']node:url["'];?/.exec(text);
    text = named
      ? text.replace(named[0], named[0].replace(named[1], `${named[1].trimEnd()}, pathToFileURL${named[1].match(/\s*$/)[0]}`))
      : `import { pathToFileURL } from "node:url";\n${text}`;
  }
  if (dunder && !/\b__dirname\b/.test(text.replace(new RegExp(DUNDER_DECL_RE.source, "gm"), ""))) text = text.replace(new RegExp(DUNDER_DECL_RE.source, "gm"), "");
  if (!imported) {
    const spec = call === "repoRoot()" ? "repoRoot" : `repoRoot as ${ALIASED_REPO_ROOT}`;
    const line = `import { ${spec} } from "#test/helpers/repo-root.js";\n`;
    const at = text.search(/^import /m);
    text = at < 0 ? `${line}${text}` : `${text.slice(0, at)}${line}${text.slice(at)}`;
  }
  return { text, count };
}

/**
 * Rewrite one test file's content.
 * @param {string} text   the file's source
 * @param {string} file   repo-relative posix path of the file (its depth decides what each specifier resolves to)
 * @returns {{ text: string, rewritten: number, selfPathRemoved: boolean, unresolved: string[] }}
 */
export function rewriteSource(text, file) {
  const dir = posix.dirname(file);
  const unresolved = [];
  let rewritten = 0;
  const mask = codeMask(text);
  const out = text.replace(SPECIFIER_RE, (whole, lead, quote, spec, offset) => {
    if (mask[offset] !== 1) return whole;
    const alias = aliasFor(posix.normalize(posix.join(dir, spec)));
    if (alias === null) {
      unresolved.push(`${spec} (leaves src/, scripts/ and test/)`);
      return whole;
    }
    rewritten += 1;
    return `${lead}${quote}${alias}${quote}`;
  });
  const selfPath = new RegExp(`^//[ \\t]*${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?\\n`);
  const selfPathRemoved = selfPath.test(out);
  const withoutSelfPath = selfPathRemoved ? out.replace(selfPath, "") : out;
  const roots = rewriteRootReads(withoutSelfPath, file);
  rewritten += roots.count;
  const final = roots.text;
  for (const line of final.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const [re, why] of RUNTIME_SHAPES) if (re.test(line)) unresolved.push(`${why}: ${line.trim().slice(0, 100)}`);
  }
  return { text: final, rewritten, selfPathRemoved, unresolved };
}

/** The tests a placement table maps to `folder`; null when the table does not exist yet. */
export function folderMembers(folder, root = repoRoot()) {
  const tsv = resolve(root, "scripts/test-placement/test-folders.tsv");
  if (!existsSync(tsv)) return null;
  const members = [];
  for (const line of readFileSync(tsv, "utf8").split("\n")) {
    const [file, dest] = line.split("\t");
    if (file && dest === folder) members.push(file);
  }
  return members;
}

function parseArgs(argv) {
  const opts = { folders: [], listFile: null, write: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--folder") opts.folders.push(argv[(i += 1)]);
    else if (a === "--files") opts.listFile = argv[(i += 1)];
    else if (a === "--write") opts.write = true;
    else opts.files.push(a);
  }
  return opts;
}

export function main(argv, root = repoRoot()) {
  const opts = parseArgs(argv);
  const files = [...opts.files];
  if (opts.listFile) files.push(...readFileSync(opts.listFile, "utf8").split("\n").filter(Boolean));
  for (const folder of opts.folders) {
    const members = folderMembers(folder, root);
    if (members === null) process.stderr.write(`--folder ${folder}: scripts/test-placement/test-folders.tsv does not exist yet — selects no test\n`);
    else files.push(...members);
  }
  let changed = 0;
  for (const raw of files) {
    const file = relative(root, resolve(root, raw)).split("\\").join("/");
    const abs = resolve(root, file);
    const result = rewriteSource(readFileSync(abs, "utf8"), file);
    for (const item of result.unresolved) process.stdout.write(`UNRESOLVED ${file}: ${item}\n`);
    if (result.rewritten === 0 && !result.selfPathRemoved) continue;
    changed += 1;
    if (opts.write) writeFileSync(abs, result.text);
    process.stdout.write(`${opts.write ? "REWROTE" : "WOULD REWRITE"} ${file}: ${result.rewritten} specifier(s)${result.selfPathRemoved ? ", self-path line removed" : ""}\n`);
  }
  process.stdout.write(`${changed} of ${files.length} file(s) ${opts.write ? "rewritten" : "would change"}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
