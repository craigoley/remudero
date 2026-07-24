import { execFileSync } from "node:child_process";
// Imported ADDITIONALLY as the module's DEFAULT export (a plain, mutable object) for the
// SAME reason inventory.ts's header comment gives: ESM named bindings off `node:fs` are
// non-configurable, so a test that wants to assert "no writes land outside
// plan/onboarding/" by spying on the REAL module needs every call site below to be a live
// `fs.<method>(...)` property lookup, never a destructured local const.
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { GhExec, Known } from "./inventory.js";
import { isReadOnlyToolset, SPECIALIST_TOOLS, type SpecialistName } from "../specialist-panel.js";
import type { Mount } from "../mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "../worker.js";

/**
 * `rmd onboard <target-dir> --phase recon` — phase 2 of the four-phase `rmd onboard`
 * family (MASTER-PLAN ★P24(2), W1-T83). Two independent producers, folded into one
 * candidate list:
 *
 *  1. A DETERMINISTIC MINER (rule 2, policy as data — mirrors inventory.ts's detector
 *     tables): lifts existing plan artifacts the phase-1 inventory already found
 *     (ROADMAP, TODO, ADR intents, open issues) into candidates, each carrying
 *     `confidence: "mined"`.
 *  2. Four READ-ONLY specialist LENSES (security/testing/design/containment — the SAME
 *     {@link SpecialistName} enum and {@link SPECIALIST_TOOLS} read-only allowlist W2-T1's
 *     specialist-panel.ts already established, REUSED here rather than re-declared)
 *     pointed at the WHOLE target repo instead of a diff. Their machine-readable
 *     `RECON_FINDING: <claim> (source: <ref>)` lines are parsed into candidates carrying
 *     `confidence: "inferred"`.
 *
 * Every candidate — mined or inferred — MUST cite a resolvable source ref (a file+line or
 * an issue number, {@link validateCandidate}): the findings doc never launders a recon
 * guess as ground truth (design intent, plan/tasks.yaml W1-T83). Candidates are INPUTS to
 * the phase-3 planning session, never tasks themselves — nothing produced here is
 * dispatchable (Standing rule 15).
 *
 * READ-ONLY against the target checkout + GitHub; the two writes this module performs are
 * `<target-dir>/plan/onboarding/findings.md` (human-readable) and
 * `<target-dir>/plan/onboarding/candidates.json` (the structured list), both staged to a
 * sibling temp file then `renameSync`'d into place — the same atomic-write idiom
 * inventory.ts's `writeInventoryAtomic` already uses.
 *
 * The specialist lenses are spawned via the SAME pure-builder/thin-real-spawn split
 * specialist-panel.ts established: {@link buildReconSpecialistSpawnArgs} is the unit-tested
 * contract (asserts `isReadOnlyToolset` — no Write/Edit/NotebookEdit/MultiEdit ever reaches
 * the model's tool list); {@link spawnReconSpecialist} is the real spawn, untested by unit
 * (it shells out via the Agent SDK, exactly like specialist-panel.ts's own
 * `spawnSpecialistWorker`). `runOnboardRecon` takes an INJECTED `runLens` so every
 * deterministic part of this module (mining, validation, parsing, rendering) is testable
 * without ever spawning a live worker; the CLI wrapper (`src/run-task.ts`) supplies the real
 * one. Containment preflight is the standing once-per-run invariant `probeContainment`
 * (containment.ts, W1-T2) already enforces around every real spawn in this repo — this
 * module's own contribution to that discipline is structural: the lenses NEVER carry a
 * write tool, so a containment lapse in configuration cannot be exploited by a recon worker
 * even if the once-per-run probe were skipped.
 */

// ── Candidates: the shared shape both producers emit ────────────────────────────────────

/** A candidate's provenance — EXACTLY a file+line or an issue number, never anything
 *  vaguer. This is what makes "every candidate cites its source verbatim" checkable. */
export type SourceRef = { kind: "file"; path: string; line: number } | { kind: "issue"; number: number };

/** Render a {@link SourceRef} the way a human-readable findings doc cites it verbatim:
 *  `path/to/file.md:12` or `#42`. */
export function formatSourceRef(ref: SourceRef): string {
  return ref.kind === "file" ? `${ref.path}:${ref.line}` : `#${ref.number}`;
}

export type CandidateConfidence = "mined" | "inferred";

export interface Candidate {
  /** The candidate goal/finding text itself. */
  text: string;
  /** Where this candidate came from — REQUIRED, never optional (see module doc). */
  source: SourceRef;
  /** `"mined"` — a deterministic-miner hit, no LLM judgment. `"inferred"` — an LLM
   *  specialist's read of the repo; a GUESS the findings doc must never launder as
   *  ground truth (hence the label is preserved end to end, {@link renderFindings}). */
  confidence: CandidateConfidence;
  /** Which lens produced this claim. Present ONLY on `"inferred"` candidates — a
   *  `"mined"` candidate has no specialist, by construction. */
  specialist?: SpecialistName;
}

/** Thrown by {@link validateCandidate}/{@link validateCandidates} on a candidate that does
 *  not cite a resolvable source, or by {@link parseReconArgs} on malformed CLI input — the
 *  `rmd onboard --phase recon` analogue of inventory.ts's `OnboardError`. */
export class ReconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconError";
  }
}

function isValidSourceRef(source: unknown): source is SourceRef {
  if (!source || typeof source !== "object") return false;
  const s = source as Record<string, unknown>;
  if (s.kind === "file") {
    return typeof s.path === "string" && s.path.length > 0 && typeof s.line === "number" && Number.isInteger(s.line) && s.line >= 1;
  }
  if (s.kind === "issue") {
    return typeof s.number === "number" && Number.isInteger(s.number) && s.number >= 1;
  }
  return false;
}

/**
 * FAIL LOUD (Standing rule / control-surface-fail-loud discipline): a candidate with no
 * text, or a source ref that isn't a well-formed file+line/issue-number, throws
 * {@link ReconError} rather than silently entering the findings doc as an unfounded claim.
 */
export function validateCandidate(candidate: Candidate): void {
  if (!candidate.text || !candidate.text.trim()) {
    throw new ReconError(`recon candidate has no text: ${JSON.stringify(candidate)}`);
  }
  if (!isValidSourceRef(candidate.source)) {
    throw new ReconError(
      `recon candidate does not cite a resolvable source (file+line or issue number): ${JSON.stringify(candidate)}`,
    );
  }
  if (candidate.confidence === "mined" && candidate.specialist !== undefined) {
    throw new ReconError(`a "mined" candidate must not carry a specialist label: ${JSON.stringify(candidate)}`);
  }
  if (candidate.confidence === "inferred" && candidate.specialist === undefined) {
    throw new ReconError(`an "inferred" candidate must name the specialist lens that produced it: ${JSON.stringify(candidate)}`);
  }
}

/** Validate every candidate in a list; returns a shallow copy on success (never mutates). */
export function validateCandidates(candidates: readonly Candidate[]): Candidate[] {
  for (const c of candidates) validateCandidate(c);
  return [...candidates];
}

// ── The injectable fs/gh surfaces this module needs ─────────────────────────────────────

/** Mirrors `OnboardFsDeps` (inventory.ts) plus the two extra reads mining requires:
 *  `readFileSync` (a ROADMAP/TODO/ADR file's content) and `readdirSync` (listing an ADR
 *  directory) — inventory.ts's phase 1 only ever needed `existsSync`. */
export interface ReconFsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  writeFileSync: (path: string, content: string) => void;
  renameSync: (from: string, to: string) => void;
}

export const realReconFsDeps: ReconFsDeps = {
  existsSync: (path) => fs.existsSync(path),
  readFileSync: (path) => fs.readFileSync(path, "utf8"),
  readdirSync: (path) => fs.readdirSync(path),
  mkdirSync: (path, opts) => {
    fs.mkdirSync(path, opts);
  },
  writeFileSync: (path, content) => {
    fs.writeFileSync(path, content, "utf8");
  },
  renameSync: (from, to) => {
    fs.renameSync(from, to);
  },
};

export interface ReconOpenIssue {
  number: number;
  title: string;
}

/** GitHub read this phase needs beyond phase 1's counts: the actual open-issue LIST (title
 *  + number), so each becomes a citable candidate. A separate gateway from
 *  `OnboardGhGateway` (inventory.ts) — that one only ever counts. */
export interface ReconGhGateway {
  listOpenIssues(owner: string, repo: string): Known<ReconOpenIssue[]>;
}

const defaultReconGhExec: GhExec = (args) =>
  execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Real gateway — `gh api`, never Octokit (matches inventory.ts/ops.ts/status.ts). Filters
 *  pull requests out of the issues-list response, the SAME contract issues-intake.ts's
 *  `normalizeIssue` and inventory.ts's `ghOpenIssueCount` already apply. */
export function realReconGhGateway(opts: { exec?: GhExec } = {}): ReconGhGateway {
  const exec = opts.exec ?? defaultReconGhExec;
  return {
    listOpenIssues: (owner, repo) => {
      try {
        const raw = exec([`repos/${owner}/${repo}/issues?state=open`, "--paginate"]);
        const parsed = JSON.parse(raw) as unknown;
        const arr = Array.isArray(parsed) ? (parsed as Array<{ number: number; title: string; pull_request?: unknown }>) : [];
        const issues = arr.filter((i) => i.pull_request === undefined).map((i) => ({ number: i.number, title: i.title }));
        return { known: true, value: issues };
      } catch {
        return { known: false };
      }
    },
  };
}

// ── The deterministic miner (rule 2: policy as data) ────────────────────────────────────

/** One line-pattern miner: the first existing `candidates` entry is read line by line;
 *  every line matching `lineRegex` (capture group 1 = the candidate text) becomes a mined
 *  candidate citing that exact file+line. Adding a new artifact type is a new ROW, never a
 *  new branch — {@link mineLines} is the one generic engine every row runs through. */
export interface LineMinerRule {
  readonly id: string;
  readonly candidates: readonly string[];
  readonly lineRegex: RegExp;
}

export const DEFAULT_ROADMAP_MINER: LineMinerRule = {
  id: "roadmap",
  candidates: ["ROADMAP.md", "ROADMAP"],
  lineRegex: /^[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/,
};

export const DEFAULT_TODO_MINER: LineMinerRule = {
  id: "todo",
  candidates: ["TODO.md", "TODO"],
  lineRegex: /^[-*]\s*(?:\[[ xX]\]\s*)?(.+?)\s*$/,
};

export const DEFAULT_LINE_MINER_RULES: readonly LineMinerRule[] = [DEFAULT_ROADMAP_MINER, DEFAULT_TODO_MINER];

/** THE generic engine every {@link LineMinerRule} runs through — exercised by ROADMAP and
 *  TODO alike, and by a CALLER's own extra row (proves "a new artifact type mines with zero
 *  engine changes", mirroring inventory.ts's `detectPresence` acceptance criterion). */
export function mineLines(targetDir: string, fsDeps: ReconFsDeps, rule: LineMinerRule): Candidate[] {
  const hit = rule.candidates.find((c) => fsDeps.existsSync(join(targetDir, c)));
  if (!hit) return [];
  const content = fsDeps.readFileSync(join(targetDir, hit));
  const out: Candidate[] = [];
  content.split("\n").forEach((line, idx) => {
    const m = rule.lineRegex.exec(line);
    if (m && m[1] && m[1].trim()) {
      out.push({ text: m[1].trim(), source: { kind: "file", path: hit, line: idx + 1 }, confidence: "mined" });
    }
  });
  return out;
}

export function mineLinePatterns(
  targetDir: string,
  fsDeps: ReconFsDeps,
  rules: readonly LineMinerRule[] = DEFAULT_LINE_MINER_RULES,
): Candidate[] {
  return rules.flatMap((rule) => mineLines(targetDir, fsDeps, rule));
}

/** ADR directory candidates — the SAME set inventory.ts's `DEFAULT_DOC_DETECTORS` "adrs" row
 *  checks for existence; this phase goes one level deeper and mines each file's INTENT (its
 *  first `# ` heading) as a candidate. */
export const DEFAULT_ADR_DIR_CANDIDATES: readonly string[] = ["docs/adr", "docs/adrs", "doc/adr", "adr", "ADRs"];

const ADR_HEADING_RE = /^#\s+(.+?)\s*$/;

/** Mine ADR intents: the first existing ADR directory is listed; each `.md` file's first
 *  `# <heading>` line becomes a mined candidate citing `<dir>/<file>:<line>`. A directory
 *  with no matching heading in any file mines nothing (never a guessed intent). */
export function mineAdrIntents(
  targetDir: string,
  fsDeps: ReconFsDeps,
  dirCandidates: readonly string[] = DEFAULT_ADR_DIR_CANDIDATES,
): Candidate[] {
  const hitDir = dirCandidates.find((d) => fsDeps.existsSync(join(targetDir, d)));
  if (!hitDir) return [];
  const files = fsDeps
    .readdirSync(join(targetDir, hitDir))
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort();
  const out: Candidate[] = [];
  for (const file of files) {
    const relPath = `${hitDir}/${file}`;
    const lines = fsDeps.readFileSync(join(targetDir, relPath)).split("\n");
    const idx = lines.findIndex((l) => ADR_HEADING_RE.test(l));
    if (idx >= 0) {
      const m = ADR_HEADING_RE.exec(lines[idx]!)!;
      out.push({ text: m[1]!.trim(), source: { kind: "file", path: relPath, line: idx + 1 }, confidence: "mined" });
    }
  }
  return out;
}

/** Mine open issues (title + number) into candidates citing `#<number>`. `owner`/`repo`
 *  unresolved, or the gateway read unresolved — mines nothing (never guessed). */
export function mineOpenIssues(owner: string | undefined, repo: string | undefined, gh: ReconGhGateway): Candidate[] {
  if (!owner || !repo) return [];
  const result = gh.listOpenIssues(owner, repo);
  if (!result.known) return [];
  return result.value.map((issue) => ({
    text: issue.title,
    source: { kind: "issue", number: issue.number },
    confidence: "mined",
  }));
}

export interface ReconMinerDeps {
  fs: ReconFsDeps;
  gh: ReconGhGateway;
}

/** The full deterministic miner: ROADMAP + TODO (line patterns) + ADR intents + open
 *  issues, folded and VALIDATED (every mined candidate must cite a resolvable source —
 *  acceptance criterion 1). */
export function mineCandidates(
  targetDir: string,
  ownerRepo: { owner?: string; repo?: string },
  deps: ReconMinerDeps,
  lineMinerRules: readonly LineMinerRule[] = DEFAULT_LINE_MINER_RULES,
  adrDirCandidates: readonly string[] = DEFAULT_ADR_DIR_CANDIDATES,
): Candidate[] {
  const mined = [
    ...mineLinePatterns(targetDir, deps.fs, lineMinerRules),
    ...mineAdrIntents(targetDir, deps.fs, adrDirCandidates),
    ...mineOpenIssues(ownerRepo.owner, ownerRepo.repo, deps.gh),
  ];
  return validateCandidates(mined);
}

// ── The four read-only specialist lenses, pointed at the WHOLE repo (REUSING W2-T1) ─────

/** Recon runs ALL FOUR lenses every time — unlike W2-T1's diff-triggered router, there is
 *  no diff here to route on; a whole-repo recon consults every lens, in a fixed,
 *  deterministic order. */
export const RECON_LENSES: readonly SpecialistName[] = ["security", "testing", "design", "containment"];

/** The whole-repo analogue of specialist-panel.ts's (unexported) `SPECIALIST_RUBRIC` — same
 *  four lenses, same {@link SpecialistName} keys, reworded for a repo-wide READ instead of a
 *  diff review. */
const RECON_LENS_RUBRIC: Record<SpecialistName, string> = {
  security:
    "Auth, credentials, egress, dependencies, hooks, and settings, across the WHOLE repo. Flag anything " +
    "that already widens what this codebase can read, write, or call out to — a hardcoded domain, a " +
    "loosened permission, a dependency with a known CVE, a secret handled in plaintext.",
  testing:
    "Test coverage, conventions, and the test-runner setup, across the WHOLE repo. Flag conspicuously " +
    "untested modules, a missing CI test gate, or a stated TDD claim (README/CONTRIBUTING) contradicted " +
    "by what the test tree actually covers.",
  design:
    "Architecture, layer boundaries, and abstractions, across the WHOLE repo. Flag a documented layer " +
    "boundary the code itself already crosses, or a repeated pattern that begs for an abstraction the " +
    "codebase does not yet have.",
  containment:
    "Sandbox, settings, deny-floor hooks, and env, across the WHOLE repo. Flag any of these that exist " +
    "but look under-specified or inconsistent — this lens reads with the lowest tolerance for 'looks fine' " +
    "of the four (FIELD FINDING 10a).",
};

export interface ReconSpecialistPromptInput {
  specialist: SpecialistName;
  targetDir: string;
  owner?: string;
  repo?: string;
}

/**
 * Render the whole-repo recon specialist's prompt. Mirrors specialist-panel.ts's
 * `buildSpecialistPrompt` in spirit (read-only, scoped rubric) but for a RECON READ of the
 * whole target repo instead of a diff review, and it never posts anywhere — it emits
 * machine-readable `RECON_FINDING:` lines the caller parses ({@link parseReconFindings}).
 */
export function buildReconSpecialistPrompt(input: ReconSpecialistPromptInput): string {
  return [
    `You are the ${input.specialist.toUpperCase()} SPECIALIST (Layer 4 lens, MASTER-PLAN §4B, reused for`,
    `\`rmd onboard\` phase 2 recon, P24(2)) — a FRESH-context, read-only consultant performing RECON,`,
    `not a diff review: read the WHOLE target repo at ${input.targetDir}`,
    `(${input.owner ?? "unknown"}/${input.repo ?? "unknown"}) through your scoped rubric below.`,
    ``,
    `You are READ-ONLY: you may inspect the repo, but you must NEVER edit, modify, or write`,
    `any code or file. You never post a PR comment, a commit status, or merge anything — this`,
    `is a recon read, not a review (Standing rule 12).`,
    ``,
    `YOUR SCOPED RUBRIC:`,
    `  ${RECON_LENS_RUBRIC[input.specialist]}`,
    ``,
    `For each concrete finding, emit ONE line, exactly in this shape (repeatable, zero or`,
    `more lines):`,
    `  RECON_FINDING: <one concrete claim> (source: <path>:<line> or #<issue-number>)`,
    ``,
    `Every finding MUST cite a real file+line you actually read, or a real open-issue`,
    `number — never a vague or unsourced claim; an unsourced claim is DROPPED by the caller,`,
    `never presented as a candidate. If your rubric's scope turns up nothing worth flagging,`,
    `emit no RECON_FINDING lines at all.`,
  ].join("\n");
}

/**
 * Build the {@link SpawnWorkerArgs} for one recon specialist spawn — a PURE function, the
 * unit-testable seam (mirrors specialist-panel.ts's `buildSpecialistSpawnArgs`). `tools` is
 * the IMPORTED {@link SPECIALIST_TOOLS} constant, not a re-declared list — this literally
 * REUSES the W2-T1 read-only allowlist rather than duplicating it, and
 * {@link isReadOnlyToolset} (also imported from specialist-panel.ts) is the SAME structural
 * assertion W2-T1's own tests use, reused verbatim by this module's tests.
 */
export function buildReconSpecialistSpawnArgs(opts: {
  input: ReconSpecialistPromptInput;
  mount: Mount;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.input.targetDir,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildReconSpecialistPrompt(opts.input),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: SPECIALIST_TOOLS,
  };
}

/** Spawn the real, fresh-context recon specialist. Untested by unit — it shells out via the
 *  Agent SDK, exactly like specialist-panel.ts's own `spawnSpecialistWorker`;
 *  {@link buildReconSpecialistSpawnArgs} carries the testable read-only contract. */
export async function spawnReconSpecialist(opts: {
  input: ReconSpecialistPromptInput;
  mount: Mount;
  settingsFile: string;
}): Promise<WorkerResult> {
  return spawnWorker(buildReconSpecialistSpawnArgs(opts));
}

// ── Parsing a lens's raw text into "inferred" candidates ────────────────────────────────

const RECON_FINDING_RE = /RECON_FINDING:\s*(.+?)\s*\(source:\s*(.+?)\)\s*$/gim;

/** Parse a `<path>:<line>` or `#<issue-number>` source-ref string. `undefined` (never
 *  guessed) on anything else — mirrors inventory.ts's "unknown is recorded, never guessed"
 *  discipline for a parse failure instead of a read failure. */
export function parseSourceRefString(raw: string): SourceRef | undefined {
  const trimmed = raw.trim();
  const issueMatch = /^#(\d+)$/.exec(trimmed);
  if (issueMatch) return { kind: "issue", number: Number(issueMatch[1]) };
  const fileMatch = /^(.+):(\d+)$/.exec(trimmed);
  if (fileMatch) {
    const line = Number(fileMatch[2]);
    const path = fileMatch[1]!.trim();
    if (path && Number.isInteger(line) && line >= 1) return { kind: "file", path, line };
  }
  return undefined;
}

/**
 * Parse one specialist's `RECON_FINDING:` lines into `confidence: "inferred"` candidates.
 * FAIL-SAFE, never fail-closed (mirrors specialist-panel.ts's `parseSpecialistVerdict`): a
 * line whose source ref doesn't parse is DROPPED, not surfaced as an unsourced candidate —
 * the findings doc must never launder a guess as ground truth (design intent, W1-T83).
 */
export function parseReconFindings(specialist: SpecialistName, text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(RECON_FINDING_RE)) {
    const claim = m[1]?.trim();
    const source = m[2] ? parseSourceRefString(m[2]) : undefined;
    if (!claim || !source) continue;
    out.push({ text: claim, source, confidence: "inferred", specialist });
  }
  return out;
}

// ── The findings renderer — preserves the mined/inferred labels end to end ─────────────

/**
 * Render `plan/onboarding/findings.md`. Mined and inferred candidates are rendered in
 * SEPARATE, clearly labeled sections (never merged into one undifferentiated list) — this
 * is what makes "mined vs inferred is a labeled distinction" (acceptance criterion 3)
 * survive all the way to the human-readable artifact, not just the JSON.
 */
export function renderFindings(candidates: readonly Candidate[]): string {
  const mined = candidates.filter((c) => c.confidence === "mined");
  const inferred = candidates.filter((c) => c.confidence === "inferred");

  const lines: string[] = [
    "# rmd onboard — recon findings (phase 2, MASTER-PLAN P24(2), W1-T83)",
    "",
    "Every candidate below cites its source verbatim. Candidates are INPUTS to the phase 3",
    "planning session, never tasks themselves (Standing rule 15).",
    "",
    `## Mined candidates (${mined.length}) — deterministic, no LLM judgment`,
    "",
  ];
  if (mined.length === 0) lines.push("(none)");
  for (const c of mined) lines.push(`- ${c.text} (source: ${formatSourceRef(c.source)})`);

  lines.push(
    "",
    `## Inferred candidates (${inferred.length}) — an LLM specialist's read of the repo;`,
    "these are RECON GUESSES, never ground truth, until a human confirms them",
    "",
  );
  if (inferred.length === 0) lines.push("(none)");
  for (const c of inferred) lines.push(`- [${c.specialist}] ${c.text} (source: ${formatSourceRef(c.source)})`);
  lines.push("");

  return lines.join("\n");
}

// ── The runner: mine + consult the four lenses + write both artifacts ──────────────────

/** Atomic temp-file + `renameSync` write — the SAME idiom as inventory.ts's
 *  `writeInventoryAtomic` / ledger.ts's `writeFileAtomic`. */
function writeReconArtifactAtomic(fsDeps: ReconFsDeps, path: string, content: string): void {
  fsDeps.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fsDeps.writeFileSync(tmpPath, content);
  fsDeps.renameSync(tmpPath, path);
}

export interface OnboardReconDeps {
  fs: ReconFsDeps;
  gh: ReconGhGateway;
  /**
   * Produce ONE lens's raw text output. Real callers (the CLI wrapper) supply
   * {@link spawnReconSpecialist}'s `.text`; tests inject canned strings so every
   * deterministic part of this module — miner, validation, parsing, rendering — is
   * exercised WITHOUT ever spawning a live worker (mirrors specialist-panel.ts's own
   * pure/real split, one level up the call stack).
   */
  runLens: (specialist: SpecialistName) => Promise<string>;
}

export interface OnboardReconResult {
  candidates: Candidate[];
  findingsPath: string;
  candidatesPath: string;
}

/**
 * Run phase 2 recon: mine deterministic candidates, consult all four read-only lenses
 * (whole-repo, {@link RECON_LENSES}) and parse their inferred candidates, validate the
 * union, and write BOTH `plan/onboarding/findings.md` and `plan/onboarding/candidates.json`
 * atomically. The ONLY writes this module performs (acceptance criterion 2's write-spy
 * proof, mirroring inventory.ts's own read-only-against-the-target guarantee).
 */
export async function runOnboardRecon(
  targetDir: string,
  ownerRepo: { owner?: string; repo?: string },
  deps: OnboardReconDeps,
): Promise<OnboardReconResult> {
  if (!deps.fs.existsSync(targetDir)) {
    throw new ReconError(`rmd onboard: target directory "${targetDir}" does not exist`);
  }

  const mined = mineCandidates(targetDir, ownerRepo, { fs: deps.fs, gh: deps.gh });

  const inferredPerLens = await Promise.all(
    RECON_LENSES.map(async (specialist) => parseReconFindings(specialist, await deps.runLens(specialist))),
  );
  const inferred = validateCandidates(inferredPerLens.flat());

  const candidates = validateCandidates([...mined, ...inferred]);

  const findingsPath = join(targetDir, "plan", "onboarding", "findings.md");
  const candidatesPath = join(targetDir, "plan", "onboarding", "candidates.json");
  writeReconArtifactAtomic(deps.fs, findingsPath, renderFindings(candidates));
  writeReconArtifactAtomic(deps.fs, candidatesPath, JSON.stringify(candidates, null, 2) + "\n");

  return { candidates, findingsPath, candidatesPath };
}

// ── CLI arg parsing (pure) — independent of inventory.ts's parseOnboardArgs so phase 1's ──
// own `KNOWN_ONBOARD_PHASES`/tests (which assert "recon" is UNKNOWN to phase 1) stay exactly
// as committed; run-task.ts's `onboardCommand` peeks `--phase` and routes to THIS parser for
// `--phase recon`, never touching inventory.ts's parser for that case. ─────────────────────

export const RECON_PHASE = "recon" as const;

export interface ParsedReconArgs {
  targetDir: string;
  owner?: string;
  repo?: string;
}

export type ParseReconArgsResult = { ok: true; args: ParsedReconArgs } | { ok: false; error: string };

function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

const RECON_VALUE_FLAGS = ["--phase", "--owner", "--repo"];

/**
 * Parse+validate `rmd onboard <target-dir> --phase recon [--owner <o> --repo <r>]`'s argv
 * tail. FAIL LOUD, BEFORE ANY WORK — the same control-surface-fail-loud discipline
 * inventory.ts's `parseOnboardArgs` already applies.
 */
export function parseReconArgs(rest: string[]): ParseReconArgsResult {
  const targetDir = rest[0];
  if (!targetDir || targetDir.startsWith("--")) {
    return { ok: false, error: "rmd onboard: <target-dir> is required as the first positional argument" };
  }

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i]!;
    if (RECON_VALUE_FLAGS.includes(tok)) {
      i++;
      continue;
    }
    return { ok: false, error: `rmd onboard: unrecognized argument '${tok}'` };
  }

  const phase = flagValue(tail, "--phase");
  if (phase !== RECON_PHASE) {
    return { ok: false, error: `rmd onboard recon: --phase must be "${RECON_PHASE}" here; got ${phase ? `"${phase}"` : "nothing"}` };
  }

  return { ok: true, args: { targetDir, owner: flagValue(tail, "--owner"), repo: flagValue(tail, "--repo") } };
}
