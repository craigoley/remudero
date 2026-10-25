#!/usr/bin/env node
// scripts/prompt-surface-gate.mjs — require golden evidence for prompt/learnings edits (W1-T3077).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { renderMacroSkill } from "./generate-macro-skills.mjs";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { loadInjectableSkills, selectSkillsForTask, renderSkillsPart, SKILL_FIX_TASK_TYPE } from "../src/lib/skill-workshop.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import { TASK_TYPES } from "../src/lib/plan.js";

export const PROMPT_SURFACE_FUNCTIONS = new Set([
  "implementPromptParts",
  "outputContractLines",
  "renderDoctrinePreamble",
  "renderFixPrompt",
  "renderImplementPrompt",
  "renderImplementPromptWithParts",
  "renderMatchedLearnings",
  "renderReconPrompt",
]);

// compaction.ts holds `outputContractLines`, spread verbatim into every implement prompt.
const FUNCTION_SOURCE_RE = /^(?:src\/lib\/prompt-render\.ts|src\/lib\/learnings\.ts|src\/lib\/compaction\.ts)$/;
const LEARNINGS_SHARD_RE = /^learnings\/[^/]+\.ya?ml$/;
const GOLDEN_FIXTURE_RE = /^test\/fixtures\/golden-verdicts\//;
const TEST_FILE_RE = /^test\/.*\.test\.ts$/;
const INJECTED_SKILL_PATH_RE = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/;

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

// Git's octal escapes encode UTF-8 bytes, not individual Unicode characters.
function decodeGitPath(path) {
  if (!path.startsWith('"')) return path;
  if (!/^"(?:[^"\\]|\\(?:[abfnrtv\\"]|[0-3][0-7]{2}))*"$/.test(path)) {
    throw new Error("prompt surface diff: invalid Git-quoted path");
  }
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  const parts = path.slice(1, -1).match(/[^\\]+|\\(?:[abfnrtv\\"]|[0-3][0-7]{2})/g) ?? [];
  const bytes = parts.map(part => part[0] !== "\\" ? Buffer.from(part) :
    Buffer.from([part.length === 4 ? parseInt(part.slice(1), 8) : escapes[part[1]]]));
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes));
}

export function parseUnifiedDiff(diffText) {
  const files = [];
  let current;
  let ambiguousHeader = false, oldPathResolved = false, newPathResolved = false;
  const requireResolvedPaths = () => {
    if (ambiguousHeader && (!oldPathResolved || !newPathResolved)) {
      throw new Error("prompt surface diff: ambiguous Git file header without authoritative paths");
    }
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      requireResolvedPaths();
      const fileMatch = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(line);
      if (!fileMatch) throw new Error("prompt surface diff: unparsed Git file header");
      // Unquoted names may themselves contain " b/"; binary diffs have no ---/+++ fallback.
      ambiguousHeader = fileMatch[1].startsWith("a/") && fileMatch[2].startsWith("b/") && line.split(" b/").length > 2;
      oldPathResolved = newPathResolved = false;
      current = { oldPath: decodeGitPath(fileMatch[1]).replace(/^a\//, ""),
        newPath: decodeGitPath(fileMatch[2]).replace(/^b\//, ""), hunks: [], changedLines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    // Rename records carry one whole path; an unquoted diff header can contain several " b/"s.
    if (line.startsWith("rename from ")) {
      current.oldPath = decodeGitPath(line.slice("rename from ".length));
      oldPathResolved = true;
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = decodeGitPath(line.slice("rename to ".length));
      newPathResolved = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPathResolved = true;
      const path = line.slice(4);
      if (path === "/dev/null") continue;
      current.newPath = decodeGitPath(path.replace(/\t$/, "")).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPathResolved = true;
      const path = line.slice(4);
      if (path === "/dev/null") continue;
      current.oldPath = decodeGitPath(path.replace(/\t$/, "")).replace(/^a\//, "");
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
  requireResolvedPaths();
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

export const MACRO_TABLE_PATH = "settings/macros.yaml";

/**
 * W1-T4332: whether every row of a macro table renders to a skill no model loads unasked — the
 * frontmatter carries `disable-model-invocation: true` and no `applies-to:` (the key
 * `loadInjectableSkills` selects on). Such a table reaches no worker prompt and no judge, so the
 * golden verdict this gate demands for a prompt surface could only be theater. Rendered through
 * the generator's own `renderMacroSkill`, never a second renderer, so a generator change that drops
 * the flag makes the table a surface again. FAILS CLOSED: an unreadable, empty or unparseable table
 * is NOT operator-only, so it stays gated.
 */
export function isOperatorOnlyMacroTable(text, render = renderMacroSkill) {
  let rows;
  try {
    rows = parseYaml(text)?.macros;
  } catch {
    return false;
  }
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((row) => {
    const front = /^---\n([\s\S]*?)\n---/.exec(render(row))?.[1] ?? "";
    return /^disable-model-invocation: true$/m.test(front) && !/^applies-to:/m.test(front);
  });
}

function touchedPathSurfaces(root, head, file) {
  const path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  const isSurface = LEARNINGS_SHARD_RE.test(path) || path === MACRO_TABLE_PATH;
  if (!isSurface) return [];
  // A schema-comment edit renders nothing different; see isCommentOnlyYamlChange for the measurement.
  if (isCommentOnlyYamlChange(file)) return [];
  if (path === MACRO_TABLE_PATH && isOperatorOnlyMacroTable(readRevisionFile(root, head, path))) return [];
  return [path];
}

function changedPaths(files) {
  return [...new Set(files.map((file) => (file.newPath === "/dev/null" ? file.oldPath : file.newPath)))];
}

// Read one immutable approved tree through the production loader. Known absence is
// empty; failed Git reads, symlinks and ambiguous tree shapes are never absence.
function revisionSkills(root, revision) {
  if (runGit(root, ["cat-file", "-t", revision]).trim() !== "commit") throw new Error(`skill reachability: ${revision} is not a commit`);
  const parent = runGit(root, ["ls-tree", "-z", revision, "--", ".claude"]);
  if (parent !== "" && !parent.startsWith("040000 tree ")) throw new Error("skill reachability: approved skill parent is not a tree");
  const tree = runGit(root, ["ls-tree", "-z", revision, "--", ".claude/skills"]);
  if (tree === "") return [];
  if (!tree.startsWith("040000 tree ")) throw new Error("skill reachability: approved skill root is not a tree");
  const entries = runGit(root, ["ls-tree", "-z", `${revision}:.claude/skills`]).split("\0").filter(Boolean);
  const names = [];
  const texts = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator), name = entry.slice(separator + 1);
    if (separator < 0 || !name || /[\r\n/]/.test(name)) throw new Error("skill reachability: ambiguous approved skill name");
    if (metadata.startsWith("120000 ")) throw new Error("skill reachability: a symbolic skill entry cannot be resolved from Git");
    if (metadata.startsWith("160000 ")) throw new Error("skill reachability: a gitlink skill entry cannot be resolved from Git");
    if (!metadata.startsWith("040000 tree ")) continue;
    const path = `.claude/skills/${name}/SKILL.md`;
    const record = runGit(root, ["ls-tree", "-z", revision, "--", path]);
    if (record === "") continue;
    if (!/^(100644|100755) blob /.test(record)) throw new Error(`skill reachability: ${path} is not a regular source blob`);
    names.push(name);
    texts.set(join("approved-skills", name, "SKILL.md"), runGit(root, ["show", `${revision}:${path}`]));
  }
  // Every advertised name has its complete regular blob before the loader runs.
  return loadInjectableSkills("approved-skills", () => names, path => texts.get(path));
}

function skillSurfaceContext(root, base, head, files) {
  const paths = [...new Set(files.flatMap(file => [file.oldPath, file.newPath]))];
  if (!paths.some(path => path === ".claude" || path === ".claude/skills" || path.startsWith(".claude/skills/"))) {
    return { surfaces: [], before: [], after: [] };
  }
  const candidates = paths.filter(path => INJECTED_SKILL_PATH_RE.test(path));
  const before = revisionSkills(root, base), after = revisionSkills(root, head);
  const signature = (skills, name) => {
    const skill = skills.find(skill => skill.name === name);
    return skill ? JSON.stringify({ name: skill.name, body: skill.body, appliesTo: [...new Set(skill.appliesTo)].sort(),
      whenPaths: skill.whenPaths === undefined ? null : [...new Set(skill.whenPaths)].sort() }) : null;
  };
  return { before, after, surfaces: candidates.filter(path => {
    const name = INJECTED_SKILL_PATH_RE.exec(path)[1];
    return signature(before, name) !== signature(after, name);
  }) };
}

function skillEvidenceFor(root, head, files, context) {
  const candidates = changedPaths(files).filter(path => GOLDEN_FIXTURE_RE.test(path));
  const qualified = new Map();
  for (const path of candidates) {
    let fixture;
    try { fixture = parseYaml(readRevisionFile(root, head, path)); }
    catch { continue; }
    if (!fixture || fixture.kind !== "injected-skill-prompt-effect" || typeof fixture.skill !== "string" ||
        typeof fixture.task_type !== "string" || ![...TASK_TYPES, SKILL_FIX_TASK_TYPE].includes(fixture.task_type) || !Array.isArray(fixture.task_files) ||
        !fixture.task_files.every(p => typeof p === "string") || typeof fixture.before !== "string" || typeof fixture.after !== "string") continue;
    const select = skills => selectSkillsForTask(skills, fixture.task_type, DEFAULT_KNOWLEDGE_BUDGET_CHARS, fixture.task_files);
    const before = select(context.before), after = select(context.after);
    if (![...before, ...after].some(skill => skill.name === fixture.skill)) continue;
    if (renderSkillsPart(before.filter(skill => skill.name === fixture.skill)) ===
        renderSkillsPart(after.filter(skill => skill.name === fixture.skill))) continue;
    const beforePrompt = renderSkillsPart(before), afterPrompt = renderSkillsPart(after);
    if (beforePrompt === afterPrompt || fixture.before !== beforePrompt || fixture.after !== afterPrompt) continue;
    qualified.set(fixture.skill, path);
  }
  return context.surfaces.every(path => qualified.has(INJECTED_SKILL_PATH_RE.exec(path)[1]))
    ? [...new Set(context.surfaces.map(path => qualified.get(INJECTED_SKILL_PATH_RE.exec(path)[1])))] : [];
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
  const skillContext = skillSurfaceContext(root, base, head, files);
  const ordinarySurfaces = [...new Set(files.flatMap(file => [...touchedPathSurfaces(root, head, file), ...touchedSymbolSurfaces(root, base, head, file)]))];
  const surfaces = [
    ...new Set([...ordinarySurfaces, ...skillContext.surfaces]),
  ];
  if (surfaces.length === 0) {
    return { ok: true, message: "prompt-surface-gate: OK — no prompt surface touched", surfaces, evidence: [] };
  }
  const ordinaryEvidence = ordinarySurfaces.length ? evidenceFor(root, head, files, ordinarySurfaces) : [];
  const skillEvidence = skillContext.surfaces.length ? skillEvidenceFor(root, head, files, skillContext) : [];
  const evidence = [...new Set([...ordinaryEvidence, ...skillEvidence])];
  if ((!ordinarySurfaces.length || ordinaryEvidence.length) && (!skillContext.surfaces.length || skillEvidence.length)) {
    return { ok: true, message: `prompt-surface-gate: OK — evidence: ${evidence.join(", ")}`, surfaces, evidence };
  }
  return {
    ok: false,
    surfaces,
    evidence,
    message: refusalMessage(surfaces) + (skillContext.surfaces.length ? " Injected skills require a changed golden fixture with kind: injected-skill-prompt-effect, skill, task_type, task_files, before and after. Both prompts must match actual maintained loading, default-budget selection and rendering at base and head, and differ for a context that selects that skill." : ""),
  };
}

export function evaluatePromptSurfaceGate({ root = REPO_ROOT, base = "origin/main", head = "HEAD" } = {}) {
  const comparisonBase = runGit(root, ["merge-base", base, head]).trim();
  return evaluatePromptSurfaceDiff(readGitDiff(root, base, head), { root, base: comparisonBase, head });
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
