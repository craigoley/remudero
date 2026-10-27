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
// WHAT IT LISTS AND NEVER GUESSES: a relative specifier that leaves src/scripts/test (package.json, bin,
// packages), a runtime read of ./fixtures, `import.meta.url`/`__dirname` path math, and a read of another
// test by its `test/<name>` path. The repoRoot()/resolveTestPath helper (W1-T9860) is on main, but the codemod
// does not yet rewrite those reads: most `test/<name>` hits are string literals in test data, not file reads, so
// they stay reported for the batch task to judge.
//
// USAGE: node scripts/test-location-codemod.mjs [--folder <name> ...] [--files <list-file>] [--write] [file ...]
//   --folder <name>  every test the placement table (scripts/test-placement/test-folders.tsv, W1-T9874) maps to
//                    <name> or to a sub-folder of it (console-api covers console-api/board); when that file is absent the folder selects nothing and says so.
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

/**
 * True for a path under a scratch directory some test makes INSIDE test/ (`.tmp-*`, `proof-status-*`). Such a
 * directory is untracked and exists only while its owner runs, so a count that walks the working tree must not
 * see it: a sibling test in the same shard makes it appear and vanish between two reads.
 */
export function isTransientTestPath(path) {
  return /(^|\/)(\.tmp-[^/]*|proof-status-[^/]*)\//.test(path);
}

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
 * Rewrite one test file's content.
 * @param {string} text   the file's source
 * @param {string} file   repo-relative posix path of the file (its depth decides what each specifier resolves to)
 * @returns {{ text: string, rewritten: number, selfPathRemoved: boolean, unresolved: string[] }}
 */
export function rewriteSource(text, file) {
  const dir = posix.dirname(file);
  const unresolved = [];
  let rewritten = 0;
  const out = text.replace(SPECIFIER_RE, (whole, lead, quote, spec) => {
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
  const final = selfPathRemoved ? out.replace(selfPath, "") : out;
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
    if (file && (dest === folder || dest?.startsWith(`${folder}/`))) members.push(file);
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
