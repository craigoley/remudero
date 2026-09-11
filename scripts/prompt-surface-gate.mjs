#!/usr/bin/env node
// scripts/prompt-surface-gate.mjs — require golden evidence for prompt/learnings edits (W1-T3077).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export const PROMPT_SURFACE_FUNCTIONS = new Set([
  "implementPromptParts",
  "renderDoctrinePreamble",
  "renderFixPrompt",
  "renderImplementPrompt",
  "renderImplementPromptWithParts",
  "renderMatchedLearnings",
  "renderReconPrompt",
]);

const FUNCTION_SOURCE_RE = /^(?:src\/lib\/prompt-render\.ts|src\/lib\/learnings\.ts)$/;
const LEARNINGS_SHARD_RE = /^learnings\/[^/]+\.ya?ml$/;
const GOLDEN_FIXTURE_RE = /^test\/fixtures\/golden-verdicts\//;
const TEST_FILE_RE = /^test\/.*\.test\.ts$/;

function runGit(root, args) {
  const result = git(args, { cwd: root });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

export function readGitDiff(root, base, head = "HEAD") {
  return runGit(root, ["diff", "--no-ext-diff", "--unified=0", `${base}...${head}`]);
}

function readRevisionFile(root, rev, path) {
  const result = git(["show", `${rev}:${path}`], { cwd: root });
  return result.status === 0 && !result.error ? result.stdout : "";
}

function parseRange(startText, countText) {
  const start = Number(startText);
  const count = countText === undefined ? 1 : Number(countText);
  return { start, end: count === 0 ? start - 1 : start + count - 1 };
}

function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

export function parseUnifiedDiff(diffText) {
  const files = [];
  let current;
  for (const line of diffText.split("\n")) {
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = { oldPath: fileMatch[1], newPath: fileMatch[2], hunks: [], changedLines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") continue;
      current.newPath = path.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      if (path === "/dev/null") continue;
      current.oldPath = path.replace(/^a\//, "");
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      current.hunks.push({
        oldRange: parseRange(hunkMatch[1], hunkMatch[2]),
        newRange: parseRange(hunkMatch[3], hunkMatch[4]),
      });
      continue;
    }
    // W1-T3086-adjacent (2026-09-11): the TEXT of every changed line, both directions. Ranges alone
    // cannot tell a data edit from a comment edit, and that distinction is what stops this gate
    // demanding a golden verdict for a schema comment nobody injects.
    // No `+++`/`---` guard is needed: the two header branches above consume them and `continue`, so
    // by here a leading +/- can only be content. A guard placed here was UNREACHABLE — its mutation
    // killed nothing, which is how it was found.
    if (/^[+-]/.test(line)) {
      current.changedLines.push(line);
    }
  }
  return files;
}

/** YAML comment/blank furniture — a changed line that cannot alter one injected byte. */
function isYamlNonContentLine(line) {
  const body = line.slice(1).trim();
  return body === "" || body.startsWith("#");
}

/**
 * True when a YAML prompt surface's change touches NOTHING a prompt renders.
 *
 * WHY THIS EXISTS. `learnings/*.yaml` is a prompt surface because its ENTRIES are injected. Its
 * comment header is not: it documents the schema for whoever edits the file, and
 * `renderDoctrinePreamble`/`renderMatchedLearnings` render entries, never comments. Before this,
 * editing that header refused the PR and demanded a golden verdict for a prompt that had not moved —
 * MEASURED on #5064, whose only `learnings/platform.yaml` change was four comment lines describing
 * the new `symbols:`/`error_signatures:` fields.
 *
 * BOTH DIRECTIONS MUST BE FURNITURE. A removed data line beside an added comment is a real change,
 * so a diff is exempt only when every line it touches, added and removed, is blank or a comment.
 */
export function isCommentOnlyYamlChange(file) {
  const path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  if (!/\.ya?ml$/.test(path)) return false;
  const lines = file.changedLines ?? [];
  if (lines.length === 0) return false; // nothing observed is not evidence of nothing changed
  return lines.every(isYamlNonContentLine);
}

export function functionRanges(path, text) {
  if (!FUNCTION_SOURCE_RE.test(path) || text.length === 0) return [];
  const ranges = [];
  const functionRe = /\bexport\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let match;
  while ((match = functionRe.exec(text)) !== null) {
    const symbol = match[1];
    if (!PROMPT_SURFACE_FUNCTIONS.has(symbol)) continue;
    const openParen = text.indexOf("(", match.index);
    const closeParen = matchingParen(text, openParen);
    const bodyOpen = closeParen === -1 ? -1 : bodyBraceAfterSignature(text, closeParen + 1);
    const bodyClose = bodyOpen === -1 ? -1 : matchingBrace(text, bodyOpen);
    if (bodyOpen === -1 || bodyClose === -1) continue;
    ranges.push({ symbol, start: lineNumberAt(text, match.index), end: lineNumberAt(text, bodyClose) });
  }
  return ranges;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function bodyBraceAfterSignature(text, from) {
  let i = from;
  while (i < text.length) {
    const nextLine = text.indexOf("\n", i);
    const end = nextLine === -1 ? text.length : nextLine;
    const brace = text.lastIndexOf("{", end);
    if (brace >= i) return brace;
    i = end + 1;
  }
  return -1;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (c === "/" && next === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) return -1;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(text, i, c);
      if (i === -1) return -1;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipQuoted(text, start, quote) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

function touchedSymbolSurfaces(root, base, head, file) {
  const oldRanges = functionRanges(file.oldPath, readRevisionFile(root, base, file.oldPath));
  const newRanges = functionRanges(file.newPath, readRevisionFile(root, head, file.newPath));
  const touched = new Set();
  for (const hunk of file.hunks) {
    for (const range of oldRanges) {
      if (overlaps(hunk.oldRange, range)) touched.add(`${file.oldPath}:${range.symbol}`);
    }
    for (const range of newRanges) {
      if (overlaps(hunk.newRange, range)) touched.add(`${file.newPath}:${range.symbol}`);
    }
  }
  return [...touched];
}

function touchedPathSurfaces(file) {
  const path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  const isSurface = LEARNINGS_SHARD_RE.test(path) || path === "settings/macros.yaml";
  if (!isSurface) return [];
  // A schema-comment edit renders nothing different; see isCommentOnlyYamlChange for the measurement.
  if (isCommentOnlyYamlChange(file)) return [];
  return [path];
}

function changedPaths(files) {
  return [...new Set(files.map((file) => (file.newPath === "/dev/null" ? file.oldPath : file.newPath)))];
}

function readWorktreeFile(root, path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return "";
  }
}

function evidenceFor(root, head, files, surfaces) {
  const paths = changedPaths(files);
  const goldenEvidence = paths.filter((path) => GOLDEN_FIXTURE_RE.test(path));
  if (goldenEvidence.length > 0) return goldenEvidence;

  const testPaths = paths.filter((path) => TEST_FILE_RE.test(path));
  const symbolSurfaces = surfaces
    .map((surface) => /^.+:([^:]+)$/.exec(surface)?.[1])
    .filter((symbol) => symbol !== undefined);
  if (symbolSurfaces.length !== surfaces.length || testPaths.length === 0) return [];

  const covered = new Set();
  for (const path of testPaths) {
    const text = readRevisionFile(root, head, path) || readWorktreeFile(root, path);
    for (const symbol of symbolSurfaces) {
      if (text.includes(symbol)) covered.add(symbol);
    }
  }
  return symbolSurfaces.every((symbol) => covered.has(symbol)) ? testPaths : [];
}

/**
 * The remedy this gate can actually accept, per surface kind — because the old single sentence
 * offered one that cannot work.
 *
 * MEASURED on #5064: the surface was `learnings/platform.yaml`, a PATH with no `:symbol`, so
 * `evidenceFor`'s `symbolSurfaces.length !== surfaces.length` guard returns `[]` BEFORE any test file
 * is considered. That PR touched seven test files and was refused by a message telling it to touch a
 * test file. A gate that names an impossible remedy is worse than one that names none: the author
 * does the work, stays refused, and distrusts the gate.
 */
export function refusalMessage(surfaces) {
  const symbolSurfaces = surfaces.filter((surface) => /^.+:[^:]+$/.test(surface));
  const pathSurfaces = surfaces.filter((surface) => !/^.+:[^:]+$/.test(surface));
  const parts = [`prompt-surface-gate: REFUSED — prompt surface touched without evidence: ${surfaces.join(", ")}.`];
  if (pathSurfaces.length > 0) {
    parts.push(
      `For the PATH surface(s) ${pathSurfaces.join(", ")} the ONLY admissible evidence is a golden ` +
        "verdict under test/fixtures/golden-verdicts/** — a test/** file cannot satisfy a path surface, " +
        "because evidence is matched on a changed prompt FUNCTION's symbol and a path carries none. " +
        "If the edit changes no injected content, a comment-only YAML change is already exempt; a data " +
        "change needs the golden verdict.",
    );
  }
  if (symbolSurfaces.length > 0) {
    parts.push(
      `For the SYMBOL surface(s) ${symbolSurfaces.join(", ")} either a golden verdict under ` +
        "test/fixtures/golden-verdicts/** or a test/** file naming each changed function satisfies it.",
    );
  }
  return parts.join(" ");
}

export function evaluatePromptSurfaceDiff(diffText, { root = REPO_ROOT, base = "origin/main", head = "HEAD" } = {}) {
  const files = parseUnifiedDiff(diffText);
  const surfaces = [
    ...new Set(files.flatMap((file) => [...touchedPathSurfaces(file), ...touchedSymbolSurfaces(root, base, head, file)])),
  ];
  if (surfaces.length === 0) {
    return { ok: true, message: "prompt-surface-gate: OK — no prompt surface touched", surfaces, evidence: [] };
  }
  const evidence = evidenceFor(root, head, files, surfaces);
  if (evidence.length > 0) {
    return { ok: true, message: `prompt-surface-gate: OK — evidence: ${evidence.join(", ")}`, surfaces, evidence };
  }
  return {
    ok: false,
    surfaces,
    evidence,
    message: refusalMessage(surfaces),
  };
}

export function evaluatePromptSurfaceGate({ root = REPO_ROOT, base = "origin/main", head = "HEAD" } = {}) {
  return evaluatePromptSurfaceDiff(readGitDiff(root, base, head), { root, base, head });
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      "worktree-path": { type: "string", default: REPO_ROOT },
    },
  });
  const base = values.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
  try {
    const result = evaluatePromptSurfaceGate({ root: values["worktree-path"], base, head: values.head });
    if (result.ok) {
      log(result.message);
      return 0;
    }
    error(result.message);
    return 1;
  } catch (err) {
    error(`prompt-surface-gate: REFUSED — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// diff-cov: process-boundary — direct CLI dispatch only translates main()'s tested return into a process exit code.
if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
