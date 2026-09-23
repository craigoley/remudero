import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";

/**
 * lib/memory-lint.ts (W1-T4098) — keep an operator's Claude Code memory loadable.
 *
 * Claude Code loads a memory directory's `MEMORY.md` index into every session, up to a documented
 * limit (the first 200 lines / about 25 KB), and each memory lives in its own file with a
 * frontmatter block. On 2026-09-22 the operator's two stores for this repo — split by working
 * directory — held an index at 20.7 KB with 39 of its 67 links pointing at files that no longer
 * existed, and memories that repeated rules the repo's own doctrine already carries.
 *
 * `lintMemoryDir` reports; `fixMemoryDir` makes only safe, reversible edits to the INDEX (drop a
 * dangling line, list an unlisted file) and never deletes a memory file; `mergeMemoryDirs` moves one
 * store into another. Duplicate detection is word-shingle similarity against a knowledge corpus, so
 * it needs no model and gives the same answer every time.
 */

/** BACKSTOP: Claude Code's documented MEMORY.md load limit — the first 200 lines, about 25 KB. The
 *  lint reports an index nearing it long before anything is truncated; nothing here enforces it. */
export const MEMORY_INDEX_LINE_LIMIT = 200;
/** BACKSTOP: the byte half of the same documented load limit. */
export const MEMORY_INDEX_BYTE_LIMIT = 25_000;

export interface KnowledgeText {
  id: string;
  text: string;
}

export interface MemoryLintReport {
  dir: string;
  index: { bytes: number; lines: number; load: "ok" | "near" | "over"; share: number };
  dangling: Array<{ line: number; target: string }>;
  unlisted: string[];
  missingFrontmatter: string[];
  duplicates: Array<{ file: string; of: string; similarity: number }>;
}

const INDEX = "MEMORY.md";
/** Where a dangling index line goes: kept, readable, and not loaded into sessions. */
export const INDEX_ARCHIVE = "MEMORY.archive.md";
const LINK = /\]\(([^)\s]+\.md)\)/;
const FRONTMATTER = /^---\n[\s\S]*?\bname:[\s\S]*?\bdescription:[\s\S]*?\n---/;

function shingles(text: string, n = 3): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** How much of `a`'s phrasing also appears in `b` (containment of a's word 3-grams in b's), 0..1. */
export function textContainment(a: string, b: string): number {
  const sa = shingles(a);
  if (sa.size === 0) return 0;
  const sb = shingles(b);
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / sa.size;
}

function memoryFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== INDEX && f !== INDEX_ARCHIVE && statSync(join(dir, f)).isFile())
    .sort();
}

function bodyOf(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Share of a memory's phrasing that must also appear in one knowledge item for it to be reported
 *  as a repeat. A reporting sensitivity, never a gate: nothing is changed on it. */
export const DUPLICATE_REPORT_SHARE = 0.4;

/** The corpus item whose phrasing `text` most repeats, when it repeats at least {@link DUPLICATE_REPORT_SHARE}. */
function closestKnowledge(text: string, corpus: KnowledgeText[]): { of: string; similarity: number } | undefined {
  const scored = corpus.map((k) => ({ of: k.id, similarity: Math.round(textContainment(text, k.text) * 100) / 100 }));
  const best = scored.sort((a, b) => b.similarity - a.similarity)[0];
  return best && best.similarity >= DUPLICATE_REPORT_SHARE ? best : undefined;
}

export function lintMemoryDir(dir: string, corpus: KnowledgeText[] = []): MemoryLintReport {
  const indexPath = join(dir, INDEX);
  const indexText = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const indexLines = indexText.split("\n");
  const files = memoryFiles(dir);
  const listed = new Set<string>();
  const dangling: MemoryLintReport["dangling"] = [];
  indexLines.forEach((line, i) => {
    const m = LINK.exec(line);
    if (!m) return;
    const target = m[1]!;
    listed.add(basename(target));
    if (!existsSync(join(dir, target))) dangling.push({ line: i + 1, target });
  });
  const bytes = Buffer.byteLength(indexText);
  const lines = indexText.length === 0 ? 0 : indexLines.filter((l, i) => i < indexLines.length - 1 || l !== "").length;
  const share = Math.max(bytes / MEMORY_INDEX_BYTE_LIMIT, lines / MEMORY_INDEX_LINE_LIMIT);
  const texts = new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const missingFrontmatter = files.filter((f) => !FRONTMATTER.test(texts.get(f)!));
  const duplicates = files.flatMap((f) => {
    const repeat = closestKnowledge(bodyOf(texts.get(f)!), corpus);
    return repeat ? [{ file: f, ...repeat }] : [];
  });
  return {
    dir,
    index: { bytes, lines, share: Math.round(share * 100) / 100, load: share > 1 ? "over" : share >= 0.75 ? "near" : "ok" },
    dangling,
    unlisted: files.filter((f) => !listed.has(f)),
    missingFrontmatter,
    duplicates,
  };
}

function indexLineFor(dir: string, file: string): string {
  const text = readFileSync(join(dir, file), "utf8");
  const name = /\bname:\s*(.+)/.exec(text)?.[1]?.trim() ?? file.replace(/\.md$/, "");
  const description = /\bdescription:\s*"?(.+?)"?\s*$/m.exec(text)?.[1]?.trim();
  return `- [${name}](${file})${description ? ` — ${description}` : ""}`;
}

/** Safe, reversible index edits only: move lines whose link target is gone to {@link INDEX_ARCHIVE}
 *  (their one-line summary may be the last copy of what the memory said), and list every memory file
 *  the index does not. Never deletes or edits a memory file. Returns what it changed. */
export function fixMemoryDir(dir: string): { removed: string[]; added: string[] } {
  const report = lintMemoryDir(dir);
  const indexPath = join(dir, INDEX);
  const indexLines = existsSync(indexPath) ? readFileSync(indexPath, "utf8").split("\n") : [];
  const deadLines = new Set(report.dangling.map((d) => d.line));
  const removed = indexLines.filter((_, i) => deadLines.has(i + 1));
  const kept = indexLines.filter((_, i) => !deadLines.has(i + 1));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const added = report.unlisted.map((f) => indexLineFor(dir, f));
  if (removed.length > 0) {
    const archivePath = join(dir, INDEX_ARCHIVE);
    const prior = existsSync(archivePath) ? readFileSync(archivePath, "utf8") : "# Archived memory index lines\n\nLinks whose memory file no longer exists, moved here by `rmd memory-lint --fix`.\n";
    writeAtomic(archivePath, `${prior.replace(/\n*$/, "\n")}${removed.join("\n")}\n`);
  }
  if (removed.length > 0 || added.length > 0) writeAtomic(indexPath, [...kept, ...added].join("\n") + "\n");
  return { removed, added };
}

/** Move every memory file from `from` into `into` (a name already taken in `into` keeps both, the
 *  moved one suffixed), then rebuild `into`'s index by listing what it now holds. `from` keeps its
 *  own index, rewritten to point at nothing it no longer holds. */
export function mergeMemoryDirs(from: string, into: string): { moved: Array<{ from: string; to: string }> } {
  const moved: Array<{ from: string; to: string }> = [];
  for (const f of memoryFiles(from)) {
    let target = f;
    for (let n = 2; existsSync(join(into, target)); n++) target = f.replace(/\.md$/, `-${n}.md`);
    renameSync(join(from, f), join(into, target));
    moved.push({ from: f, to: target });
  }
  fixMemoryDir(into);
  fixMemoryDir(from);
  return { moved };
}

/** Render a report for a person: plain, one line per finding. */
export function renderMemoryLint(report: MemoryLintReport): string {
  const out = [
    `memory-lint ${report.dir}`,
    `  index: ${report.index.bytes} bytes, ${report.index.lines} lines — ${Math.round(report.index.share * 100)}% of the load limit (${report.index.load})`,
  ];
  for (const d of report.dangling) out.push(`  dangling: line ${d.line} links ${d.target}, which does not exist`);
  for (const f of report.unlisted) out.push(`  unlisted: ${f} is not in the index`);
  for (const f of report.missingFrontmatter) out.push(`  frontmatter: ${f} has no name/description block`);
  for (const d of report.duplicates) out.push(`  repeats repo knowledge: ${d.file} ≈ ${d.of} (${Math.round(d.similarity * 100)}% of its phrasing)`);
  if (out.length === 2) out.push("  clean");
  return out.join("\n");
}
