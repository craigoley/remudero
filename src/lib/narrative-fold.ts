import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * lib/narrative-fold.ts (W1-T4096) — the operations the knowledge gardener's FOLD tier (W1-T4095
 * design (iii)) runs on a narrative store once it outgrows its reading size: DECISIONS.md gets a
 * `Status:` line per entry, MASTER-PLAN.md's `## SHIPPED log` archives waves older than the
 * current one, and an oversized `docs/forensics/*.md` page splits one file per `## ` anchor.
 * Each operation is a pure text transform ({@link deriveDecisionStatuses},
 * {@link foldMasterPlanShippedLog}, {@link splitForensicsPage}) — what the tests below drive —
 * plus the thin {@link foldNarrativeStore} orchestrator that reads/writes real files, which `rmd
 * knowledge fold` (src/run-task.ts) and scripts/{decisions-status,forensics-split}.mjs call.
 */

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

/** GitHub-flavoured heading slug: lower-case, every run of non `[a-z0-9]` collapses to one `-`,
 *  trimmed at both ends. Matches the slugs this repo's own `// Why:` anchors already use (e.g.
 *  `## Second pass (2026-09-06)` -> `second-pass-2026-09-06`). */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function monthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// (i) DECISIONS — every `## ` entry gets a `Status:` line
// ---------------------------------------------------------------------------------------------

export type DecisionStatus = "accepted" | "withdrawn" | `superseded by ${string}`;

export interface DecisionEntryStatus {
  heading: string;
  status: DecisionStatus;
  successor?: string;
}

export interface DeriveDecisionStatusesResult {
  text: string;
  entries: DecisionEntryStatus[];
  /** Headings that carry supersession language the classifier could not resolve to a whole-entry
   *  named successor (a partial clause, e.g. "ITS X CLAUSE SUPERSEDED BY ..."). Left `accepted`
   *  for a human to review rather than guessed at. */
  unclassified: string[];
}

const DECISION_HEADING_RE = /^## .*$/gm;
const SECTION_RE = /^(## .*)\n\n([\s\S]*)$/;
const WHOLE_SUPERSEDED_RE = /\(SUPERSEDED BY ([^()]+)\)\s*$/;
const PARTIAL_SUPERSEDED_RE = /\([^()]*\bSUPERSEDED BY\b[^()]+\)/i;
const WITHDRAWN_RE = /\(WITHDRAWN\)\s*$/i;
const EXISTING_STATUS_RE = /^Status:\s.*\n\n?/;

/** Derive and stamp a `Status:` line onto every `## ` entry in a DECISIONS.md-shaped document.
 *  Classification reads ONLY the heading line's own trailing parenthetical — the one place this
 *  file already marks whole-entry supersession (`(SUPERSEDED BY <ref>)`) — never a body mention of
 *  "SUPERSEDED", which names what an entry supersedes at least as often as what supersedes IT.
 *  Idempotent: a re-run strips and re-derives any `Status:` line already present. */
export function deriveDecisionStatuses(content: string): DeriveDecisionStatusesResult {
  const indices = [...content.matchAll(DECISION_HEADING_RE)].map((m) => m.index!);
  if (indices.length === 0) return { text: content, entries: [], unclassified: [] };
  const preamble = content.slice(0, indices[0]);
  const sections = indices.map((start, i) => content.slice(start, i + 1 < indices.length ? indices[i + 1] : content.length));

  const entries: DecisionEntryStatus[] = [];
  const unclassified: string[] = [];
  const stamped = sections.map((section) => {
    const headingLine = section.slice(0, section.indexOf("\n")).trim();
    const heading = headingLine.replace(/^## /, "").trim();
    let status: DecisionStatus = "accepted";
    let successor: string | undefined;
    const whole = WHOLE_SUPERSEDED_RE.exec(headingLine);
    if (whole) {
      successor = whole[1]!.trim();
      status = `superseded by ${successor}`;
    } else if (WITHDRAWN_RE.test(headingLine)) {
      status = "withdrawn";
    } else if (PARTIAL_SUPERSEDED_RE.test(headingLine)) {
      unclassified.push(heading);
    }
    entries.push({ heading, status, successor });
    return stampSection(section, status);
  });
  return { text: preamble + stamped.join(""), entries, unclassified };
}

function stampSection(section: string, status: DecisionStatus): string {
  const m = SECTION_RE.exec(section);
  if (!m) return section; // malformed (no blank line after heading) — left untouched, never guessed at
  const [, heading, rest] = m;
  const body = rest.replace(EXISTING_STATUS_RE, "");
  return `${heading}\n\nStatus: ${status}\n\n${body}`;
}

// ---------------------------------------------------------------------------------------------
// (ii) MASTER-PLAN — the `## SHIPPED log` archives waves older than the current one
// ---------------------------------------------------------------------------------------------

export interface FoldMasterPlanResult {
  folded: string;
  /** archive repo-relative path -> its full content */
  archives: Record<string, string>;
}

const SHIPPED_HEADING = "## SHIPPED log";
const ARCHIVE_POINTER_RE = /^### Archived —/;

function monthBucketOf(entryText: string): string {
  const headingLine = entryText.slice(0, entryText.indexOf("\n"));
  const m = /(\d{4})-(\d{2})-\d{2}/.exec(headingLine);
  return m ? `${m[1]}-${m[2]}` : "earlier";
}

/** Archive every `### ` entry of MASTER-PLAN.md's `## SHIPPED log` older than
 *  `opts.currentWaveMonth` ("YYYY-MM") into one `docs/archive/master-plan-<bucket>.md` per month
 *  (undated entries bucket as `earlier`), leaving one `### Archived — <bucket> ...` pointer line
 *  in their place. Idempotent: an existing pointer entry is kept as-is, never re-archived, so a
 *  second run against the same `currentWaveMonth` returns the input byte-identical. */
export function foldMasterPlanShippedLog(
  content: string,
  opts: { currentWaveMonth: string; archiveDirRel?: string },
): FoldMasterPlanResult {
  const archiveDirRel = opts.archiveDirRel ?? "docs/archive";
  const headingAt = content.indexOf(`\n${SHIPPED_HEADING}\n`);
  if (headingAt === -1) return { folded: content, archives: {} };
  const sectionStart = headingAt + 1;
  const afterHeading = sectionStart + SHIPPED_HEADING.length;
  const nextH2 = content.slice(afterHeading).search(/\n## (?!#)/);
  const sectionEnd = nextH2 === -1 ? content.length : afterHeading + nextH2 + 1;
  const before = content.slice(0, sectionStart);
  const section = content.slice(sectionStart, sectionEnd);
  const after = content.slice(sectionEnd);

  const entryStarts = [...section.matchAll(/\n### /g)].map((m) => m.index! + 1);
  const preamble = section.slice(0, entryStarts.length ? entryStarts[0] : section.length);
  const entries = entryStarts.map((start, i) => section.slice(start, i + 1 < entryStarts.length ? entryStarts[i + 1] : section.length));

  const archives: Record<string, string> = {};
  const kept: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (ARCHIVE_POINTER_RE.test(entry)) {
      kept.push(entry);
      i++;
      continue;
    }
    const bucket = monthBucketOf(entry);
    if (bucket !== "earlier" && bucket >= opts.currentWaveMonth) {
      kept.push(entry);
      i++;
      continue;
    }
    const run: string[] = [];
    while (i < entries.length && !ARCHIVE_POINTER_RE.test(entries[i]!) && monthBucketOf(entries[i]!) === bucket) {
      run.push(entries[i]!);
      i++;
    }
    const archiveRelPath = `${archiveDirRel}/master-plan-${bucket}.md`;
    const header =
      `# MASTER-PLAN archive — ${bucket}\n\nFolded out of MASTER-PLAN.md's \`## SHIPPED log\` by ` +
      `\`foldNarrativeStore\` (W1-T4096) so the live plan keeps only the current wave. Newest first.\n\n`;
    archives[archiveRelPath] = (archives[archiveRelPath] ?? header) + run.join("");
    const label = bucket === "earlier" ? "earlier than the dated waves above" : bucket;
    kept.push(`### Archived — ${label} (${run.length} entr${run.length === 1 ? "y" : "ies"}) — see ${archiveRelPath}\n\n`);
  }

  return { folded: before + preamble + kept.join("") + after, archives };
}

// ---------------------------------------------------------------------------------------------
// (iii) FORENSICS — a page over its reading size splits one file per `## ` anchor
// ---------------------------------------------------------------------------------------------

export const DEFAULT_FORENSICS_READING_SIZE_BYTES = 200_000;

export interface SplitForensicsPageResult {
  index: string;
  /** new file repo-relative path -> its full content */
  files: Record<string, string>;
  /** `docs/forensics/<page>.md#<slug>` -> the new file's repo-relative path, for rewriting `//
   *  Why:` pointers that named a specific anchor. */
  pointerRewrites: Record<string, string>;
}

/** Split a `docs/forensics/<page>.md`-shaped file into one file per `## ` anchor, under
 *  `docs/forensics/<page>/<slug>.md`, keeping the ORIGINAL heading lines in the source page (so a
 *  GitHub anchor link into the un-split page still lands in the right spot) but replacing each
 *  section's body with a one-line pointer — the same "leave a pointer" shape
 *  {@link foldMasterPlanShippedLog} uses. A repeated slug (two headings that normalise the same)
 *  gets a `-1`, `-2`, ... suffix, same as GitHub's own de-duplication. */
export function splitForensicsPage(content: string, opts: { pageRelPath: string }): SplitForensicsPageResult {
  const stem = opts.pageRelPath.replace(/\.md$/, "");
  const parts = content.split(/\n(?=## )/);
  const hasPreamble = !/^## /.test(parts[0] ?? "");
  const preamble = hasPreamble ? parts[0]! : "";
  const sections = hasPreamble ? parts.slice(1) : parts;

  const files: Record<string, string> = {};
  const pointerRewrites: Record<string, string> = {};
  const indexEntries: string[] = [];
  const seen = new Map<string, number>();
  for (const section of sections) {
    const heading = /^## (.+)/.exec(section)?.[1]?.trim() ?? "section";
    const base = slugifyHeading(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    const relPath = `${stem}/${slug}.md`;
    files[relPath] = section.endsWith("\n") ? section : `${section}\n`;
    pointerRewrites[`${opts.pageRelPath}#${slug}`] = relPath;
    indexEntries.push(`## ${heading}\n\nSee \`${relPath}\`.\n`);
  }
  return { index: preamble + indexEntries.join("\n"), files, pointerRewrites };
}

/** Rewrite every occurrence of a split page's old `<page>.md#<slug>` anchor to its new file path,
 *  in one source file's text. A bare, anchor-less pointer (`docs/forensics/sweep.md` with no `#`)
 *  is left alone — the split page still exists as a (much smaller) index, so it still resolves. */
export function rewriteWhyPointers(text: string, pointerRewrites: Record<string, string>): string {
  let out = text;
  for (const [from, to] of Object.entries(pointerRewrites)) out = out.split(from).join(to);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Orchestrator — the one entry point `rmd knowledge fold` and the gardener call
// ---------------------------------------------------------------------------------------------

export type NarrativeFoldKind = "decisions" | "master-plan" | "forensics";

export interface FoldNarrativeStoreOptions {
  root: string;
  kind: NarrativeFoldKind;
  now?: () => Date;
  /** forensics only: repo-relative page paths to consider; defaults to every docs/forensics/*.md */
  forensicsPages?: string[];
  readingSizeBytes?: number;
  dryRun?: boolean;
}

export interface FoldNarrativeStoreReport {
  kind: NarrativeFoldKind;
  changed: boolean;
  filesWritten: string[];
  notes: string[];
}

/** Runs one of the three fold operations above against real files under `opts.root`. Each branch
 *  is idempotent (a second call with the same inputs reports `changed: false`) and, outside
 *  `dryRun`, writes only the files it names in `filesWritten`. */
export function foldNarrativeStore(opts: FoldNarrativeStoreOptions): FoldNarrativeStoreReport {
  if (opts.kind === "decisions") return foldDecisionsStore(opts);
  if (opts.kind === "master-plan") return foldMasterPlanStore(opts);
  return foldForensicsStore(opts);
}

function writeIfNeeded(path: string, content: string, dryRun: boolean | undefined, written: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!dryRun) writeFileSync(path, content, "utf8");
  written.push(path);
}

function foldDecisionsStore(opts: FoldNarrativeStoreOptions): FoldNarrativeStoreReport {
  const path = join(opts.root, "DECISIONS.md");
  if (!existsSync(path)) return { kind: "decisions", changed: false, filesWritten: [], notes: ["no DECISIONS.md"] };
  const before = readFileSync(path, "utf8");
  const { text, unclassified } = deriveDecisionStatuses(before);
  const changed = text !== before;
  const written: string[] = [];
  if (changed) writeIfNeeded(path, text, opts.dryRun, written);
  const notes = unclassified.map((h) => `unclassified (partial supersession, kept accepted): ${h}`);
  return { kind: "decisions", changed, filesWritten: written, notes };
}

function foldMasterPlanStore(opts: FoldNarrativeStoreOptions): FoldNarrativeStoreReport {
  const path = join(opts.root, "MASTER-PLAN.md");
  if (!existsSync(path)) return { kind: "master-plan", changed: false, filesWritten: [], notes: ["no MASTER-PLAN.md"] };
  const before = readFileSync(path, "utf8");
  const currentWaveMonth = monthOf((opts.now ?? (() => new Date()))());
  const { folded, archives } = foldMasterPlanShippedLog(before, { currentWaveMonth });
  const changed = folded !== before;
  const written: string[] = [];
  if (changed) {
    writeIfNeeded(path, folded, opts.dryRun, written);
    for (const [relPath, text] of Object.entries(archives)) writeIfNeeded(join(opts.root, relPath), text, opts.dryRun, written);
  }
  return { kind: "master-plan", changed, filesWritten: written, notes: Object.keys(archives).map((p) => `archived into ${p}`) };
}

function listForensicsPages(root: string): string[] {
  const dir = join(root, "docs", "forensics");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `docs/forensics/${e.name}`)
    .sort();
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkTsFiles(p, out);
    else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(p);
  }
}

function foldForensicsStore(opts: FoldNarrativeStoreOptions): FoldNarrativeStoreReport {
  const threshold = opts.readingSizeBytes ?? DEFAULT_FORENSICS_READING_SIZE_BYTES;
  const candidates = opts.forensicsPages ?? listForensicsPages(opts.root);
  const written: string[] = [];
  const notes: string[] = [];
  let anyChanged = false;
  const allRewrites: Record<string, string> = {};
  for (const pageRelPath of candidates) {
    const abs = join(opts.root, pageRelPath);
    if (!existsSync(abs)) {
      notes.push(`missing: ${pageRelPath}`);
      continue;
    }
    const bytes = statSync(abs).size;
    if (bytes < threshold) continue;
    const content = readFileSync(abs, "utf8");
    const { index, files, pointerRewrites } = splitForensicsPage(content, { pageRelPath });
    writeIfNeeded(abs, index, opts.dryRun, written);
    for (const [relPath, fileText] of Object.entries(files)) writeIfNeeded(join(opts.root, relPath), fileText, opts.dryRun, written);
    Object.assign(allRewrites, pointerRewrites);
    notes.push(`split ${pageRelPath} (${bytes} bytes) into ${Object.keys(files).length} files`);
    anyChanged = true;
  }
  if (anyChanged) {
    const tsFiles: string[] = [];
    walkTsFiles(join(opts.root, "src"), tsFiles);
    for (const file of tsFiles) {
      const before = readFileSync(file, "utf8");
      const after = rewriteWhyPointers(before, allRewrites);
      if (after !== before) writeIfNeeded(file, after, opts.dryRun, written);
    }
  }
  return { kind: "forensics", changed: anyChanged, filesWritten: written, notes };
}
