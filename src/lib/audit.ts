/**
 * `rmd audit` — the T2 monthly rung `docs/audits/README.md` names and stores fixtures for, and
 * until this module had zero consumers: `name: "audit"` never appeared in the `COMMANDS`
 * registry (src/run-task.ts), so two frozen findings tables (`recon-2026-07-21.md`,
 * `recon-2026-09-05.md`) sat beside a README describing a bar — "reproduces >= 80% of these 36
 * findings from source" — nothing measured.
 *
 * THE DESIGN, KEPT DETERMINISTIC (no LLM call, so the rate is a measurement, not a judgement):
 *
 *   1. A fixed set of GATHERERS ({@link AUDIT_GATHERERS}) walk a source corpus and each produce
 *      zero or more {@link AuditFinding}s, every one tagged with the repo-relative evidence path
 *      (and, where the gatherer's own check names one, a `symbol` — the literal substring the
 *      gatherer matched on, e.g. `"Date.now()"`, `"process.env"`, `"execFileSync"`).
 *   2. {@link parseFixtureFindings} reads a frozen `recon-YYYY-MM-DD.md`'s `| R-n | … |` table and
 *      pulls out every row's `Evidence` cell; {@link parseEvidenceCitations} splits that cell into
 *      its semicolon-separated citations and extracts each citation's file token (and backtick
 *      symbol, if any).
 *   3. {@link gradeFixture} marks a fixture finding REPRODUCED when ANY of its citations names a
 *      file some gatherer also flagged — a symbol-bearing citation additionally requires that
 *      gatherer's own `symbol` to contain the citation's backtick text. A finding with several
 *      evidence citations only needs ONE to land; that is why a still-true "god file" citation
 *      keeps reproducing a finding whose narrower defect was long since fixed (docs/audits/
 *      README.md's "known corrections" already record that a fixture is graded byte-identical
 *      to the day it was written, not to what is still true).
 *
 * INVARIANT: every gatherer here is a plain, offline read of the corpus it is handed — no
 * network, no subprocess, no `Date.now()`/`Math.random()` — so a grading run is reproducible byte
 * for byte given the same corpus.
 * INVARIANT: {@link gradeFixture} and {@link parseFixtureFindings}/{@link parseEvidenceCitations}
 * are PURE — no I/O — so a test drives them over a hand-built corpus/fixture with no filesystem
 * and no real repo. {@link buildDefaultCorpus} is the one impure seam, isolated so the command
 * caller (`auditFixtureCommand`, src/run-task.ts) can inject a fake one instead.
 * INVARIANT: a REPORT, never a gate — nothing here decides pass/fail; the caller always exits 0
 * on a well-formed invocation, exactly like `proof-queue-audit`/`plan-reconcile` (lib/proof-queue-
 * audit.ts's own module doc states the same posture for the sibling rung this one completes).
 * FALSIFIER: test/audit-command.test.ts.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One gatherer's observation: a repo-relative path it flagged, why, and (when the gatherer's own
 *  check names one) the literal substring matched — the `symbol` a fixture's backtick-quoted
 *  evidence token is graded against. */
export interface AuditFinding {
  /** Repo-relative, forward-slash path — never absolute, never platform-separated. */
  file: string;
  /** Which gatherer produced this — purely diagnostic, never read by grading. */
  gatherer: string;
  /** The literal text this gatherer matched on, when it has one worth naming. */
  symbol?: string;
  /** Human-readable one-line reason, printed by the caller, never parsed by grading. */
  detail: string;
}

/** repo-relative path (forward-slash) -> file text, for every file a gatherer might read. Built
 *  once per run by {@link buildDefaultCorpus} (or a test's own fixture) and handed to every
 *  gatherer unchanged — the gatherers never read the filesystem themselves. */
export type AuditCorpus = ReadonlyMap<string, string>;

// ─────────────────────────────────────── gatherers ─────────────────────────────────────────

const TS_SRC_PREFIX = "src/";
const TS_TEST_PREFIX = "test/";

function isSrcTs(path: string): boolean {
  return path.startsWith(TS_SRC_PREFIX) && path.endsWith(".ts");
}

/** `scripts/source-size-baseline.json`'s own per-file ceiling, held against this corpus's actual
 *  line count — the same "baseline vs actual" shape every `scripts/*-ratchet.mjs` in this repo
 *  already uses, read here rather than re-derived, so a file this repo has already agreed is
 *  oversized (R-27's "6,734-line god file", now `src/run-task.ts` at 10x that) is exactly what
 *  this gatherer names. */
function gatherSourceSizeOverBaseline(files: AuditCorpus): AuditFinding[] {
  const raw = files.get("scripts/source-size-baseline.json");
  if (raw === undefined) return [];
  let baseline: unknown;
  try {
    baseline = JSON.parse(raw);
  } catch {
    // Not valid JSON in this corpus (a --repo target mid-edit, say) -- nothing to compare against,
    // not an error worth surfacing from a source gather.
    return [];
  }
  if (typeof baseline !== "object" || baseline === null) return [];
  const out: AuditFinding[] = [];
  for (const [path, ceiling] of Object.entries(baseline as Record<string, unknown>)) {
    if (typeof ceiling !== "number") continue;
    const text = files.get(path);
    if (text === undefined) continue;
    const actual = text.split("\n").length;
    if (actual > ceiling) {
      out.push({
        file: path,
        gatherer: "source-size-over-baseline",
        symbol: `${actual} lines`,
        detail: `${path}: ${actual} lines exceeds its scripts/source-size-baseline.json ceiling of ${ceiling}`,
      });
    }
  }
  return out;
}

/** Every tracked `.ts` file under `src/` (any depth) with at least one `execFileSync(` call whose own call site
 *  carries no `timeout` within a short window — the shape R-1/R-3/R-18's "no timeout hardening"
 *  class names. A heuristic proximity window, not a parser (same trade-off this repo's own
 *  catch-erasure/negative-reachability censuses already make over source text): it can call a
 *  call site "safe" when an unrelated `timeout` merely happens to sit nearby, so a real gate would
 *  want the AST this module deliberately does not build. One finding per file is enough for a
 *  report whose grading only needs to know the file was flagged, not by how many call sites. */
function gatherExecFileSyncWithoutTimeout(files: AuditCorpus): AuditFinding[] {
  const out: AuditFinding[] = [];
  const WINDOW = 400;
  for (const [path, text] of files) {
    if (!isSrcTs(path)) continue;
    let idx = text.indexOf("execFileSync(");
    while (idx !== -1) {
      const window = text.slice(idx, idx + WINDOW);
      if (!/timeout/i.test(window)) {
        out.push({
          file: path,
          gatherer: "exec-file-sync-without-timeout",
          symbol: "execFileSync",
          detail: `${path}: an execFileSync( call with no 'timeout' within ${WINDOW} chars`,
        });
        break;
      }
      idx = text.indexOf("execFileSync(", idx + 1);
    }
  }
  return out;
}

/** A literal `"gh"`/`'gh'` argument in a `.ts` file under `src/` — a direct `gh` spawn site, the shape R-3's
 *  "worker runs gh outside the sandbox" and R-1's `gh issue create` throw both name. */
function gatherGhDirectSpawn(files: AuditCorpus): AuditFinding[] {
  const out: AuditFinding[] = [];
  const ghLiteral = /(^|[^A-Za-z0-9_])["']gh["']/;
  for (const [path, text] of files) {
    if (!isSrcTs(path)) continue;
    if (ghLiteral.test(text)) {
      out.push({ file: path, gatherer: "gh-direct-spawn", symbol: "gh", detail: `${path}: a literal "gh" spawn argument` });
    }
  }
  return out;
}

/** Every `.ts` file under `src/` with a direct `Date.now()` call site — R-1's live crash-loop ledger
 *  arithmetic and R-23/R-36's unbounded-batch resets both read the wall clock this way. */
function gatherDateNowSites(files: AuditCorpus): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [path, text] of files) {
    if (!isSrcTs(path)) continue;
    if (text.includes("Date.now()")) {
      out.push({ file: path, gatherer: "date-now-sites", symbol: "Date.now()", detail: `${path}: a direct Date.now() call site` });
    }
  }
  return out;
}

/** Every `.ts` file under `src/` reading `process.env` directly — R-7's headroom guard and R-8/R-9's
 *  ledger-path resolution are both env-driven the same way. */
function gatherProcessEnvReads(files: AuditCorpus): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [path, text] of files) {
    if (!isSrcTs(path)) continue;
    if (text.includes("process.env")) {
      out.push({ file: path, gatherer: "process-env-reads", symbol: "process.env", detail: `${path}: a direct process.env read` });
    }
  }
  return out;
}

/** R-28's own shape: a `.ts` file under `test/` that `readFileSync`s a `src/`-rooted path (or literally
 *  `run-task.ts`) to regex-read source text instead of asserting on behaviour — the "544 long-
 *  prose assertions" class, and the exact class `test/source-text-assertion-census.test.ts` now
 *  separately ratchets. This gatherer stays deliberately narrower than that census (a single
 *  substring check, not its depth-matched argument parse): it only needs to name a FILE for
 *  grading, not hold the debt down. */
function gatherReadFileSyncSrcInTests(files: AuditCorpus): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [path, text] of files) {
    if (!path.startsWith(TS_TEST_PREFIX) || !path.endsWith(".ts")) continue;
    const calls = text.match(/readFileSync\([^)]*\)/g) ?? [];
    for (const call of calls) {
      if (call.includes("run-task.ts") || call.includes("src/")) {
        out.push({
          file: path,
          gatherer: "readfilesync-src-in-tests",
          symbol: "readFileSync(src)",
          detail: `${path}: reads a src/-rooted path as text — ${call.slice(0, 100)}`,
        });
        break;
      }
    }
  }
  return out;
}

/** R-10's exact shape: `stryker.conf.json`'s `mutate` array scoped to fewer files than the corpus
 *  carries under `src/lib/` + the root `src/run-task.ts` — "the PR mutation ratchet covers only
 *  src/lib/classify.ts (1 of 74 modules)", re-measured against however many modules exist today
 *  rather than the frozen "74". */
function gatherMutationRatchetScope(files: AuditCorpus): AuditFinding[] {
  const raw = files.get("stryker.conf.json");
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // stryker.conf.json isn't valid JSON in this corpus -- nothing to gather, not an error.
    return [];
  }
  const mutate = (parsed as { mutate?: unknown })?.mutate;
  if (!Array.isArray(mutate)) return [];
  const totalModules = [...files.keys()].filter(
    (p) => (p.startsWith("src/lib/") || p === "src/run-task.ts") && p.endsWith(".ts"),
  ).length;
  if (totalModules === 0 || mutate.length >= totalModules) return [];
  return [
    {
      file: "stryker.conf.json",
      gatherer: "mutation-ratchet-scope",
      symbol: `${mutate.length}/${totalModules} modules`,
      detail: `stryker.conf.json: mutate[] covers ${mutate.length} of ${totalModules} source modules`,
    },
  ];
}

/** R-6/R-11's shape together: a security-scanner workflow marked `continue-on-error: true` whose
 *  job name never appears in `ci-gate.yml`'s own text — advisory-by-construction AND unregistered,
 *  the "not in ci-gate -> registration race" gap. Flags the scanner workflow itself always when
 *  it is `continue-on-error`; additionally flags `ci-gate.yml` when that scanner's name is absent
 *  from it, so the one gate this repo could weaken in-band is named directly (R-6). */
function gatherSecurityScannerGateGap(files: AuditCorpus): AuditFinding[] {
  const scanners: Array<{ path: string; jobName: string }> = [
    { path: ".github/workflows/semgrep.yml", jobName: "semgrep" },
    { path: ".github/workflows/dependency-review.yml", jobName: "dependency-review" },
  ];
  const ciGateText = files.get(".github/workflows/ci-gate.yml");
  const out: AuditFinding[] = [];
  let anyUnregistered = false;
  for (const scanner of scanners) {
    const text = files.get(scanner.path);
    if (text === undefined || !/continue-on-error:\s*true/.test(text)) continue;
    out.push({
      file: scanner.path,
      gatherer: "security-scanner-gate-gap",
      symbol: "continue-on-error",
      detail: `${scanner.path}: continue-on-error: true on a security scanner`,
    });
    if (ciGateText !== undefined && !ciGateText.toLowerCase().includes(scanner.jobName)) anyUnregistered = true;
  }
  if (anyUnregistered) {
    out.push({
      file: ".github/workflows/ci-gate.yml",
      gatherer: "security-scanner-gate-gap",
      symbol: "unregistered scanner",
      detail: "ci-gate.yml: a continue-on-error security scanner's job name is absent from this file",
    });
  }
  return out;
}

/** R-34's exact shape, re-checked rather than assumed fixed: `tsconfig.json` missing
 *  `"noUncheckedIndexedAccess": true`. */
function gatherTsconfigMissingIndexAccess(files: AuditCorpus): AuditFinding[] {
  const text = files.get("tsconfig.json");
  if (text === undefined) return [];
  if (text.includes('"noUncheckedIndexedAccess": true') || text.includes('"noUncheckedIndexedAccess":true')) return [];
  return [
    {
      file: "tsconfig.json",
      gatherer: "tsconfig-missing-index-access",
      symbol: "noUncheckedIndexedAccess",
      detail: "tsconfig.json: no noUncheckedIndexedAccess: true",
    },
  ];
}

/** R-30's shape: a hand-written doc citing a `path:line` that either doesn't exist in this corpus
 *  or whose cited line is past the file's own length — "README 'WS-0 spike'; ci-gate.md is a
 *  probe artifact" was this same class, dangling doc-to-source citations. Scoped to the docs the
 *  fixture itself cites (never `docs/audits/*` — those are frozen fixtures, not claims about
 *  current state, per docs/audits/README.md's own header). */
function gatherDanglingDocCitations(files: AuditCorpus): AuditFinding[] {
  const DOC_PATHS = ["README.md", "CONTRIBUTING.md", "docs/ci-gate.md"];
  const citationRe = /([A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]+):(\d+)/g;
  const out: AuditFinding[] = [];
  for (const docPath of DOC_PATHS) {
    const text = files.get(docPath);
    if (text === undefined) continue;
    let m: RegExpExecArray | null;
    citationRe.lastIndex = 0;
    while ((m = citationRe.exec(text))) {
      const [, citedPath, lineStr] = m;
      const citedText = files.get(citedPath);
      const line = Number(lineStr);
      const dangling = citedText === undefined || citedText.split("\n").length < line;
      if (dangling) {
        out.push({
          file: docPath,
          gatherer: "dangling-doc-citations",
          symbol: citedPath,
          detail: `${docPath}: cites ${citedPath}:${lineStr}, which is absent or shorter than that`,
        });
        break;
      }
    }
  }
  return out;
}

/** For every `scripts/*-baseline.json` present in the corpus, names its paired
 *  `scripts/<prefix>-ratchet.mjs` (when the corpus carries one) as evidence — the "baseline-vs-
 *  actual" axis the rationale names, one entry per already-established ratchet pair. R-12's own
 *  evidence cites the RATCHET script (`coverage-ratchet.mjs`), not its baseline JSON, which is
 *  why this reports the script path rather than the baseline's. */
function gatherBaselineRatchetPairs(files: AuditCorpus): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const path of files.keys()) {
    if (!path.startsWith("scripts/") || !path.endsWith("-baseline.json")) continue;
    const prefix = path.slice("scripts/".length, path.length - "-baseline.json".length);
    const ratchetPath = `scripts/${prefix}-ratchet.mjs`;
    if (!files.has(ratchetPath)) continue;
    out.push({
      file: ratchetPath,
      gatherer: "baseline-ratchet-pairs",
      symbol: "baseline-vs-actual",
      detail: `${ratchetPath}: paired with ${path}, an existing baseline-vs-actual measurement`,
    });
  }
  return out;
}

/** Every gatherer this rung runs, in report order. Adding one is additive — see the module doc's
 *  design note (1): each just needs to return zero or more {@link AuditFinding}s over the corpus
 *  it is handed. depcruise's cycle count and jscpd's clone count are NOT here yet (both need a
 *  subprocess this deterministic, offline gather deliberately avoids) — a documented gap, not a
 *  silent one; see docs/audits/README.md's invocation section. */
export const AUDIT_GATHERERS: ReadonlyArray<(files: AuditCorpus) => AuditFinding[]> = [
  gatherSourceSizeOverBaseline,
  gatherExecFileSyncWithoutTimeout,
  gatherGhDirectSpawn,
  gatherDateNowSites,
  gatherProcessEnvReads,
  gatherReadFileSyncSrcInTests,
  gatherMutationRatchetScope,
  gatherSecurityScannerGateGap,
  gatherTsconfigMissingIndexAccess,
  gatherDanglingDocCitations,
  gatherBaselineRatchetPairs,
];

/** Run every gatherer in {@link AUDIT_GATHERERS} over `files` and concatenate their findings. */
export function gatherFindings(files: AuditCorpus): AuditFinding[] {
  return AUDIT_GATHERERS.flatMap((gatherer) => gatherer(files));
}

// ────────────────────────────────── fixture table parsing ──────────────────────────────────

/** One `| R-n | … | Evidence |` row read from a fixture's findings table — only the two columns
 *  grading needs. */
export interface FixtureFindingRow {
  id: string;
  evidence: string;
}

/** Read every `| R-n | … |` row of a fixture's markdown findings table (docs/audits/README.md's
 *  format), keyed off the ID column matching `R-<digits>` — robust to the exact column count and
 *  to the header/separator rows, which never match that shape. Only the first and last cell
 *  (`id`, `evidence`) are used; every fixture in docs/audits/ puts Evidence last. */
export function parseFixtureFindings(markdown: string): FixtureFindingRow[] {
  const rows: FixtureFindingRow[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    const id = cells[0];
    if (!id || !/^R-\d+$/.test(id)) continue;
    rows.push({ id, evidence: cells[cells.length - 1] ?? "" });
  }
  return rows;
}

/** One semicolon-separated citation out of an Evidence cell, with its file token (if any) and
 *  backtick-quoted symbol (if any) pulled out. `file` is undefined when the citation names no
 *  path at all (`"live protection API"`, `"grep: no semaphore"`) — those citations never
 *  reproduce anything, by construction, since grading only reads citations with a file. */
export interface FixtureCitation {
  raw: string;
  file?: string;
  symbol?: string;
}

const CITATION_FILE_RE = /([A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]+)/;
const CITATION_SYMBOL_RE = /`([^`]+)`/;

export function parseEvidenceCitations(evidence: string): FixtureCitation[] {
  return evidence
    .split(";")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({
      raw,
      file: raw.match(CITATION_FILE_RE)?.[1],
      symbol: raw.match(CITATION_SYMBOL_RE)?.[1],
    }));
}

// ──────────────────────────────────────── grading ───────────────────────────────────────────

function sameFile(findingFile: string, citationFile: string): boolean {
  const a = findingFile.replace(/\\/g, "/");
  const b = citationFile.replace(/\\/g, "/");
  if (a === b) return true;
  if (b.includes("/")) return a.endsWith(`/${b}`);
  return a.split("/").pop() === b;
}

/** One fixture finding's grading outcome. */
export interface AuditGradeRow {
  id: string;
  reproduced: boolean;
  /** The gatherer finding's own file, when reproduced — undefined otherwise. */
  matchedFile?: string;
}

export interface AuditGradeReport {
  total: number;
  reproducedCount: number;
  rows: AuditGradeRow[];
}

/**
 * Grade every fixture row against `findings`: REPRODUCED when some citation's file matches a
 * finding's file (and, when that citation carries a backtick symbol, some matching-file finding's
 * own `symbol` contains it, case-insensitively) — see the module doc's design note (3). Pure: no
 * I/O, no gatherer calls — {@link gatherFindings} and {@link parseFixtureFindings} are the
 * caller's job.
 */
export function gradeFixture(findings: readonly AuditFinding[], rows: readonly FixtureFindingRow[]): AuditGradeReport {
  const graded = rows.map((row): AuditGradeRow => {
    for (const citation of parseEvidenceCitations(row.evidence)) {
      if (!citation.file) continue;
      const candidates = findings.filter((f) => sameFile(f.file, citation.file as string));
      if (candidates.length === 0) continue;
      if (!citation.symbol) return { id: row.id, reproduced: true, matchedFile: candidates[0].file };
      const symbolNeedle = citation.symbol.toLowerCase();
      const hit = candidates.find((f) => f.symbol?.toLowerCase().includes(symbolNeedle));
      if (hit) return { id: row.id, reproduced: true, matchedFile: hit.file };
    }
    return { id: row.id, reproduced: false };
  });
  return { total: rows.length, reproducedCount: graded.filter((r) => r.reproduced).length, rows: graded };
}

// ────────────────────────────────── the one impure seam ────────────────────────────────────

const CORPUS_EXTRA_FILES: readonly string[] = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/ci-gate.md",
  "tsconfig.json",
  "stryker.conf.json",
  "scripts/source-size-baseline.json",
];

function listWorkflowFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No .github/workflows in this checkout (a --repo target that isn't this repo, say) -- the
    // workflow-scoped gatherers simply see nothing, not an error.
    return [];
  }
  return names.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).map((n) => `.github/workflows/${n}`);
}

/** Top-level `scripts/*-baseline.json` and `scripts/*-ratchet.mjs` only (never `scripts/lib/`) —
 *  {@link gatherBaselineRatchetPairs} is the one gatherer that reads these. */
function listScriptsBaselineAndRatchetFiles(repoRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, "scripts"));
  } catch {
    // No scripts/ directory in this checkout -- nothing to pair, not an error.
    return [];
  }
  return names.filter((n) => n.endsWith("-baseline.json") || n.endsWith("-ratchet.mjs")).map((n) => `scripts/${n}`);
}

function walkTsFiles(repoRoot: string, relDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, relDir));
  } catch {
    // relDir doesn't exist in this checkout -- nothing under it to walk, not an error.
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = `${relDir}/${name}`;
    let isDir: boolean;
    try {
      isDir = statSync(join(repoRoot, rel)).isDirectory();
    } catch {
      // A dangling symlink or a file removed between readdir and stat -- skip it, not an error.
      continue;
    }
    if (isDir) out.push(...walkTsFiles(repoRoot, rel));
    else if (name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/**
 * The real, filesystem-reading corpus builder — every `.ts` file under `src/` and `test/`, plus
 * the fixed config/doc paths the gatherers above name, all read once. The only impure function in
 * this module; `auditFixtureCommand` (src/run-task.ts) is its only production caller, and a test
 * injects a hand-built {@link AuditCorpus} instead so the pure gatherers/grading stay testable
 * with no repo on disk.
 */
export function buildDefaultCorpus(repoRoot: string): AuditCorpus {
  const relPaths = [
    ...walkTsFiles(repoRoot, "src"),
    ...walkTsFiles(repoRoot, "test"),
    ...CORPUS_EXTRA_FILES,
    ...listWorkflowFiles(repoRoot),
    ...listScriptsBaselineAndRatchetFiles(repoRoot),
  ];
  const files = new Map<string, string>();
  for (const rel of relPaths) {
    try {
      files.set(rel, readFileSync(join(repoRoot, rel), "utf8"));
    } catch {
      // Named but absent in this checkout (docs/ci-gate.md was removed after the fixture that
      // cites it was written, for instance) -- the gatherer that would have read it sees no
      // entry, not an error.
    }
  }
  return files;
}
