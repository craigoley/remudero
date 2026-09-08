#!/usr/bin/env node
// scripts/generate-docs-index.mjs
//
// Docs index generator (W1-T2282, MASTER-PLAN §8A). docs/ had no retrieved-not-injected index
// like plan/plan-index.json or learnings/index.json, so a doc was reachable only if something
// else happened to cite it. Builds docs/docs-index.json: every markdown file under docs/, with a
// path, a title (first `# ` heading, or the filename), a one-line summary (the first body line
// after it) and a grepHint (the title). Excludes its own output path, so it never self-regenerates.
//
// Also exposes findUnresolvedMermaidCitations(), which refuses a doc whose fenced ```mermaid
// block cites a repo-relative path that does not resolve -- scoped to mermaid blocks only, since
// docs routinely shorten an established path to accepted shorthand in prose, which a corpus-wide
// scan would false-positive on. No existing doc is ever rewritten, only reported.
// Why: docs/system-diagrams.md once cited an unresolved path; see docs/forensics/generate-docs-index.md.
//
// Content-only output (no timestamp), so it is byte-stable when docs/**/*.md hasn't changed --
// what makes `--check` a meaningful staleness gate. `--check-paths` is a separate gate, so
// mermaid-path drift and index staleness fail independently.
//
// Usage:
//   node scripts/generate-docs-index.mjs [--dir docs] [--out docs/docs-index.json]
//   node scripts/generate-docs-index.mjs --check         # exit 1 if the committed index is stale
//   node scripts/generate-docs-index.mjs --check-paths   # exit 1 if any mermaid citation is unresolved

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";

/** Max rendered length of a doc's one-line summary (chars); longer text is ellipsized. */
const SUMMARY_MAX_CHARS = 160;

/** Strip light markdown emphasis markers so a summary/title line reads as plain text. */
function stripEmphasis(line) {
  return line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/** Recursively list every `*.md` file under `dir` (posix-style paths, relative to `dir`, sorted). */
function listMarkdownFiles(dir) {
  const out = [];
  function walk(sub) {
    const entries = readdirSync(join(dir, sub), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(relPath);
      }
    }
  }
  walk("");
  return out.sort();
}

/** A line wholly wrapped in emphasis (a maintenance/provenance banner, not prose). Matched raw,
 *  before {@link stripEmphasis} strips the markers that identify it. */
const WHOLLY_EMPHASISED_RE = /^(\*\*|__|\*|_)(?!\s).*\1\s*$/;

/**
 * Parse one doc's markdown text into a {title, summary} pair. title is the first `# ` heading
 * with emphasis stripped, or null if none; summary is the first non-blank, non-heading body line
 * after it, truncated -- but a line wholly wrapped in emphasis is skipped as a maintenance banner.
 *
 * TRAP: without that skip, `rmd retro`'s own banner in docs/ORIENTATION.md read as the summary,
 * so the index went stale on every retro run. KNOWN LIMIT: a genuine one-line summary written
 * entirely in emphasis is skipped too; none exists today.
 * FALSIFIER: test/docs-index.test.ts. Why: docs/forensics/generate-docs-index.md#parsedocentry.
 */
export function parseDocEntry(text) {
  const lines = text.split("\n");
  let titleIdx = -1;
  let title = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      title = stripEmphasis(m[1].trim());
      titleIdx = i;
      break;
    }
  }
  let summary = "";
  const startAt = titleIdx >= 0 ? titleIdx + 1 : 0;
  for (let j = startAt; j < lines.length; j++) {
    const candidate = lines[j].trim();
    if (candidate.length === 0) continue;
    if (/^#{1,6}\s/.test(candidate)) break; // next heading -- no body prose under this title
    if (WHOLLY_EMPHASISED_RE.test(candidate)) continue; // a banner, not this doc's first sentence
    summary = truncate(stripEmphasis(candidate), SUMMARY_MAX_CHARS);
    break;
  }
  return { title, summary };
}

/**
 * Build the docs index: every `*.md` file under `dir`, excluding `outPath` itself so the index
 * never regenerates on every run. `title` falls back to the filename with no `# ` heading;
 * `grepHint` is the title, the string a worker greps docs/ for to land on this file.
 */
export function buildDocsIndex(dir, outPath) {
  const outRelToDir = relative(dir, outPath);
  const files = listMarkdownFiles(dir).filter((f) => f !== outRelToDir);
  const entries = files.map((relFile) => {
    const fullPath = join(dir, relFile);
    const text = readFileSync(fullPath, "utf8");
    const { title, summary } = parseDocEntry(text);
    const docPath = `${dir}/${relFile}`;
    const resolvedTitle = title ?? relFile.replace(/\.md$/, "");
    return { path: docPath, title: resolvedTitle, summary, grepHint: resolvedTitle };
  });
  return entries;
}

/** Canonical JSON serialization -- what makes byte-equality checkable (`--check`). */
export function serializeDocsIndex(entries, dirLabel) {
  return JSON.stringify({ dir: dirLabel, entries }, null, 2) + "\n";
}

/** Extract every parenthesized, path-shaped citation `(a/b.ext)` inside fenced ```mermaid blocks
 *  in `text`. Scoped to mermaid blocks only -- see the file header for why a prose-wide scan
 *  would false-positive. */
export function extractMermaidPathCitations(text) {
  const citations = [];
  const blockRe = /```mermaid\n([\s\S]*?)```/g;
  let blockMatch;
  while ((blockMatch = blockRe.exec(text))) {
    const block = blockMatch[1];
    const pathRe = /\(([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,5})\)/g;
    let pathMatch;
    while ((pathMatch = pathRe.exec(block))) {
      if (/^https?:/.test(pathMatch[1])) continue;
      citations.push(pathMatch[1]);
    }
  }
  return citations;
}

/** Every mermaid-cited path in a doc's text that does not resolve to a real file under `repoRoot`.
 *  Read-only -- never writes to a doc. */
export function findUnresolvedPathsInText(text, repoRoot) {
  const unresolved = [];
  for (const citation of extractMermaidPathCitations(text)) {
    const abs = resolvePath(repoRoot, citation);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      unresolved.push(citation);
    }
  }
  return unresolved;
}

/** Walk every markdown file under `dir` and report each doc/path pair whose mermaid citation does
 *  not resolve, in file order. Returns `[]` when the corpus is clean. */
export function findUnresolvedMermaidCitations(dir, repoRoot) {
  const findings = [];
  for (const relFile of listMarkdownFiles(dir)) {
    const docPath = `${dir}/${relFile}`;
    const text = readFileSync(join(dir, relFile), "utf8");
    for (const badPath of findUnresolvedPathsInText(text, repoRoot)) {
      findings.push({ doc: docPath, path: badPath });
    }
  }
  return findings;
}

/** Exported, unlike the sibling generators' own local `main`, so a test can drive its outer
 *  try/catch IN-PROCESS: only a direct call moves this file's own coverage record (W1-T2282). */
export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", default: "docs" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
      "check-paths": { type: "boolean", default: false },
    },
  });
  const outPath = values.out ?? join(values.dir, "docs-index.json");
  const repoRoot = process.cwd();

  if (values["check-paths"]) {
    const findings = findUnresolvedMermaidCitations(values.dir, repoRoot);
    if (findings.length > 0) {
      console.error(`generate-docs-index: ${findings.length} unresolved mermaid path citation(s):`);
      for (const { doc, path } of findings) {
        console.error(`  ${doc} cites '${path}', which does not resolve to a real file`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`generate-docs-index: OK -- every mermaid citation under ${values.dir} resolves.`);
    process.exitCode = 0;
    return;
  }

  let fresh;
  try {
    const entries = buildDocsIndex(values.dir, outPath);
    fresh = serializeDocsIndex(entries, values.dir);
  } catch (err) {
    console.error(`generate-docs-index: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.check) {
    let committed;
    try {
      committed = readFileSync(outPath, "utf8");
    } catch {
      console.error(`generate-docs-index: ${outPath} does not exist -- run 'npm run docs-index' to generate it.`);
      process.exitCode = 1;
      return;
    }
    if (committed !== fresh) {
      console.error(
        `generate-docs-index: ${outPath} is STALE -- it does not match a fresh regeneration from ${values.dir}/**/*.md.\n` +
          `Run 'npm run docs-index' and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`generate-docs-index: OK -- ${outPath} matches the current ${values.dir}/**/*.md.`);
    process.exitCode = 0;
    return;
  }

  writeFileSync(outPath, fresh);
  const entryCount = JSON.parse(fresh).entries.length;
  console.log(`generate-docs-index: wrote ${outPath} (${entryCount} doc(s) from ${values.dir}/**/*.md).`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/generate-docs-index.mjs ...`), never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
