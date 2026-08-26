#!/usr/bin/env node
// scripts/generate-docs-index.mjs
//
// Docs INDEX generator (W1-T2282, MASTER-PLAN §8A).
//
// docs/ was the one knowledge corpus that never got this repo's own RETRIEVED-not-INJECTED
// treatment: MASTER-PLAN.md has plan/plan-index.json + `plan-index:check` (W1-T37),
// learnings/ has learnings/index.json + `learnings-index:check` + a budget ratchet + per-task
// matching (W1-T33), and CLAUDE.md is injected up front by a recorded decision
// (src/lib/plan-index.ts). docs/ had none of the three: a doc was reachable only if some OTHER
// file happened to cite its path, so several files carried no incoming citation from outside
// docs/ and were unreachable by construction, not by neglect.
//
// This script builds the missing index: for every markdown file under docs/, its path, title
// (the first `# ` heading, or the filename if none), a one-line summary (the first non-blank
// body line after that heading) and a grep hint (the title itself -- the string a worker would
// grep docs/ for to land on this file). An entry gives every doc a retrieval key, so "reachable"
// stops depending on whether some other file happened to name it. The index EXCLUDES its own
// output path, so generating it never creates an entry that would regenerate on every run.
//
// It also exposes findUnresolvedMermaidCitations(), which refuses (names the offending doc and
// path) a doc that cites a repo-relative path inside a fenced ```mermaid code block that does not
// resolve against the real checkout -- the shape of the one live defect this task found
// (docs/system-diagrams.md's mermaid label names `lib/status.ts`, which does not exist; the real
// file is `src/lib/status.ts`). This scope -- mermaid node-label citations, not every path-shaped
// substring in prose -- is deliberate: this corpus's prose routinely shortens an already-
// established `src/lib/foo.ts` mention to bare `lib/foo.ts` as accepted shorthand
// (docs/cli-reference.md, docs/operator-guide.md, docs/dep-review.md, docs/alert-lane.md and
// docs/review-gate.md all do this repeatedly), and a check that flagged every one of those would
// be a false-positive firehose, not a gate on a real defect. A mermaid diagram node label is
// different: MASTER-PLAN §"System diagrams" (docs/system-diagrams.md's own header) states every
// edge is "derived from a named symbol", i.e. it is a literal citation of a source location, not
// shorthand for one already established in surrounding prose, so precision there is enforceable.
// Existing docs are NEVER rewritten by this generator or its checks -- an unresolved path is
// reported and named, never silently corrected; the repair is its own, later change.
//
// The generated index is content-only (no timestamp) so it is byte-stable across runs when
// docs/**/*.md hasn't changed -- that is what makes `--check` a meaningful staleness gate, the
// same convention scripts/generate-plan-index.mjs (W1-T37) and scripts/generate-learnings-index.mjs
// (W1-T33) already use. Mermaid-path resolution is a SEPARATE gate (`--check-paths`), kept out of
// `--check` on purpose: staleness must track this corpus's own committed shape 1:1 with its
// siblings, and today's real corpus carries one known, tracked, unrepaired defect (see above) that
// would otherwise make `--check` permanently red for a reason unrelated to staleness.
//
// Usage:
//   node scripts/generate-docs-index.mjs [--dir docs] [--out docs/docs-index.json]
//   node scripts/generate-docs-index.mjs --check         # exit 1 if the committed index is stale
//   node scripts/generate-docs-index.mjs --check-paths   # exit 1 if any mermaid citation is unresolved

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

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

/**
 * Parse one doc's markdown text into a {title, summary} pair: title is the first `# ` (H1)
 * heading with emphasis stripped, or null if the doc has none; summary is the first non-blank,
 * non-heading body line found after the title (truncated), or "" if the doc has no body prose
 * before its next heading / EOF.
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
    summary = truncate(stripEmphasis(candidate), SUMMARY_MAX_CHARS);
    break;
  }
  return { title, summary };
}

/**
 * Build the docs index: every `*.md` file under `dir`, excluding `outPath` (the generated index's
 * OWN destination) so generating the index never creates a self-entry that would regenerate on
 * every run -- even in the hypothetical case `outPath` sits under `dir` with a `.md` extension.
 * `title` falls back to the filename (no extension) when a doc has no `# ` heading. `grepHint` is
 * the title -- the string a worker greps docs/ for to land on this file.
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

/**
 * Extract every parenthesized, path-shaped citation `(a/b.ext)` found inside fenced ```mermaid
 * code blocks in `text` (e.g. a diagram node label's trailing `(src/lib/foo.ts)` source
 * annotation). Deliberately scoped to mermaid blocks only -- see the module doc above for why a
 * corpus-wide scan over every backtick/prose mention would be a false-positive firehose.
 */
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

/**
 * For one doc's text, return every mermaid-cited path (see extractMermaidPathCitations) that does
 * NOT resolve to a real file under `repoRoot`. Never touches the filesystem beyond `existsSync`/
 * `statSync` reads -- no doc is ever written or corrected here.
 */
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

/**
 * Walk every markdown file under `dir` and report each doc/path pair whose mermaid citation does
 * not resolve, in file order. Returns `[]` when the corpus is clean.
 */
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

/**
 * Exported (not merely local, like the sibling generators' own `main`) so a test can drive its
 * error path -- the outer try/catch around corpus generation -- IN-PROCESS. A `spawnSync`'d child
 * process runs under its own, unobserved V8 instance, so a subprocess-only CLI test can never
 * move THIS process's `--experimental-test-coverage` report; calling `main()` directly (a
 * bad `--dir`) is what lets that catch block show up as covered in this file's own diff
 * (W1-T2282 round 1).
 */
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
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
