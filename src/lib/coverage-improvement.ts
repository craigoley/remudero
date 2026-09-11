import { ghExec } from "./github-transport.js";
import { inflateRawSync } from "node:zlib";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { captureFeedback, type CaptureFeedbackOptions, type FeedbackEntry } from "./feedback.js";
import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "./ledger-grep.js";

/**
 * lib/coverage-improvement.ts — TIERS TWO AND THREE of the absolute-threshold coverage gate
 * (W1-T470; tier three added by W1-T3384b).
 *
 * TIER ONE (`classifyCoverageTier`, `scripts/coverage-ratchet.mjs`) bands a run's branch coverage:
 * `>= 90` healthy, `85-90` owes ONE improvement task, `< 85` owes a remediation ROUND. NO BAND
 * BLOCKS — #5117 retired every coverage floor by operator ruling, so severity decides how much work
 * is filed, never whether the PR lands. THIS module files that work: it names the `src/` files
 * owning the most uncovered branches and writes ONE `plan/feedback/` entry — never a shard directly
 * into `plan/tasks.d/` (the only programmatic write path into the plan is `captureFeedback`) and
 * never one entry per file (W1-T470 clause (2): the queue cannot absorb that fan-out, which is why
 * tier three escalates in ROUNDS instead).
 *
 * THRESHOLDS ARE RE-DECLARED HERE, DELIBERATELY, RATHER THAN IMPORTED. `scripts/coverage-
 * ratchet.mjs` already exports `classifyCoverageTier` with the same 85/90 cuts, but that file
 * is a plain `.mjs` outside tsconfig's `include` — `test/coverage-ratchet.test.ts` documents
 * exercising it only via its CLI surface for exactly that reason (importing it would pull an
 * un-type-checked module into this one's `tsc --noEmit` graph). Rule 25 independently forbids
 * this module from carrying tier one's own files in its diff at all (`detectInstrumentEntangle-
 * ment`, `src/lib/review.ts`: `scripts/coverage-ratchet.mjs` is `INSTRUMENT_SURFACE`, this module
 * is a product path — mixing them in one PR reads entangled). {@link DEFAULT_TIER_PASS_PCT} and
 * {@link DEFAULT_TIER_BLOCK_PCT} are the SAME two numbers scripts/coverage-ratchet.mjs's
 * `classifyCoverageTier` defaults to; a change to one must mirror the other by hand, same as any
 * two independently-typed modules sharing a constant across a module-system boundary neither can
 * cross.
 *
 * ATTRIBUTION IS COMPUTED AT RUN TIME, NEVER CARRIED FROM THE COMMISSIONING SHARD (design
 * clause (5)). The plan shard that commissioned this module carried a percentage figure ("51%
 * of all uncovered branches") that did NOT reproduce against a real lcov under any natural
 * denominator when re-measured — a frozen number rots the moment coverage moves again. So this
 * module reads `coverage/lcov.info` itself, on every run, and reports uncovered-branch COUNTS
 * (never a percentage) for the files that own the most of them.
 *
 * THE DEDUPE IS A UNION READ, NEVER A ONE-FILE READ (design clause (4)). The escalation
 * precedent this module's dedupe shape is modeled on used to consult exactly one file against a
 * rotation cap (`MAX_RETAINED_LINES_PER_STEP`, `src/lib/ledger.ts`) — which made old dedup
 * markers invisible once they aged out of that cap, and a producer built the same way would read
 * "not yet filed" for its own stale marker and refile identical content forever, an unbounded
 * loop wearing a dedupe as a disguise. {@link injectCoverageImprovementTask} instead reads the
 * FULL ledger union (`resolveLedgerUnion`, `src/lib/ledger-grep.ts`: gzip rotations, plain
 * rotations, and the live file) for its own {@link COVERAGE_IMPROVEMENT_FILED_STEP} marker
 * before filing — and {@link COVERAGE_IMPROVEMENT_FILED_STEP} is registered in
 * `DECISION_RELEVANT_LEDGER_STEPS` (`src/lib/ledger.ts`) in this same change, or a later rotation
 * would archive that marker's own evidence and silently re-arm the loop this exists to prevent.
 *
 * THE DEDUPE KEY IS THE DEBT SIGNATURE, NOT "ever filed" NOR "this CI run". "The same ten files
 * own the debt every single run" (the rationale's own observation) is exactly the shape that
 * would spam the queue with byte-identical entries on every red-band CI run if this module
 * deduped on nothing at all — and filing forever on ANY prior marker would mean at most one
 * coverage-improvement task ever gets filed, for the LIFE of the ledger, even after the debt
 * shifts to a different set of files entirely. {@link coverageDebtSignature} instead fingerprints
 * WHICH files currently own the debt; {@link injectCoverageImprovementTask} skips filing only
 * when a PRIOR marker recorded that exact same signature, and files again the moment the top
 * offenders change. `rmd triage`'s own semantic grounding (refusing duplicate/already-decided
 * work — the task's own title) is the second, independent backstop for anything that slips past
 * this narrower guard, e.g. a near-duplicate signature after one file drops off the list.
 */

// ── lcov parsing (per-file branch attribution) ──────────────────────────────────────────────

/** One file's branch totals, as recorded by an `SF:`/`BRF:`/`BRH:` triple in an lcov report. */
export interface LcovFileRecord {
  /** The exact `SF:` path as written in the report — repo-relative for an in-repo record. */
  file: string;
  /** Branches found. */
  brf: number;
  /** Branches hit. */
  brh: number;
}

/**
 * Parse every per-file branch record out of an lcov report, EXCLUDING any record whose `SF:`
 * path escapes the checkout (`../`-relative or absolute) — the same exclusion
 * `scripts/coverage-ratchet.mjs`'s `parseLcovTotals` applies, and for the same reason: several
 * tests `mkdtemp` a scratch dir, copy a repo script into it, and spawn `node`, and because
 * `NODE_V8_COVERAGE` is inherited by children, that low-coverage temp copy's own SF: record
 * would otherwise pollute a per-file attribution with a path that is not a real source file at
 * all.
 */
export function parseLcovFileRecords(lcovText: string): LcovFileRecord[] {
  const records: LcovFileRecord[] = [];
  let current: LcovFileRecord | undefined;
  let inRepo = true;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      const path = line.slice(3).trim();
      inRepo = !(path.startsWith("../") || path.startsWith("/"));
      current = inRepo ? { file: path, brf: 0, brh: 0 } : undefined;
      continue;
    }
    if (!inRepo || !current) continue;
    if (line.startsWith("BRF:")) current.brf += Number(line.slice(4));
    else if (line.startsWith("BRH:")) current.brh += Number(line.slice(4));
    else if (line.startsWith("end_of_record")) {
      records.push(current);
      current = undefined;
    }
  }
  return records;
}

/**
 * Sum BRF/BRH across every in-repo record and derive the overall branch percentage — the SAME
 * aggregate `scripts/coverage-ratchet.mjs`'s `classifyCoverageTier` gates on (measured to
 * reproduce the gate's own 90.27% exactly, all in-repo BRF/BRH, W1-T470 design clause (5)).
 * Deliberately over EVERY in-repo record (not just `src/`-rooted ones, see
 * {@link rankCoverageDebt}) — the gate itself does not scope to `src/`, and this module's tier
 * classification must agree with the gate it is downstream of.
 */
export function aggregateBranchesPct(records: readonly LcovFileRecord[]): number {
  let brf = 0;
  let brh = 0;
  for (const r of records) {
    brf += r.brf;
    brh += r.brh;
  }
  return brf > 0 ? (100 * brh) / brf : 100;
}

// ── Tier classification (mirrors scripts/coverage-ratchet.mjs's classifyCoverageTier — see the
// module doc above for why this is a deliberate, disclosed re-declaration rather than an import) ─

export const DEFAULT_TIER_PASS_PCT = 90;
export const DEFAULT_TIER_BLOCK_PCT = 85;

export type CoverageImprovementTier = "healthy" | "improve" | "remediate";

export function classifyImprovementTier(
  branchesPct: number,
  thresholds: { pass?: number; block?: number } = {},
): CoverageImprovementTier {
  const pass = thresholds.pass ?? DEFAULT_TIER_PASS_PCT;
  const block = thresholds.block ?? DEFAULT_TIER_BLOCK_PCT;
  if (branchesPct < block) return "remediate";
  if (branchesPct < pass) return "improve";
  return "healthy";
}

// ── Per-file debt ranking (clause (5): names files and uncovered-branch COUNTS, never a %) ──

export interface FileDebt {
  file: string;
  /** `brf - brh` for this file — an absolute count, never a percentage (see the module doc). */
  uncoveredBranches: number;
}

/**
 * Rank `src/`-rooted files by uncovered branch COUNT, descending, ties broken by path so the
 * output is deterministic. Scoped to `src/` (not every in-repo record — see
 * {@link aggregateBranchesPct} for why the AGGREGATE stays unscoped) because `src/` is what the
 * fleet actually maintains and can dispatch a task against; `scripts/`'s own coverage is a
 * different, smaller surface the gate does not separately ratchet.
 */
export function rankCoverageDebt(
  records: readonly LcovFileRecord[],
  opts: { prefix?: string; limit?: number } = {},
): FileDebt[] {
  const prefix = opts.prefix ?? "src/";
  const limit = opts.limit ?? 10;
  return records
    .filter((r) => r.file.startsWith(prefix))
    .map((r) => ({ file: r.file, uncoveredBranches: r.brf - r.brh }))
    .filter((f) => f.uncoveredBranches > 0)
    .sort((a, b) => b.uncoveredBranches - a.uncoveredBranches || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, limit);
}

/** W1-T3384b — TIER THREE'S ESCALATION CLOCK. Escalation is in TIME, not width: W1-T470 rejected
 *  one entry per file (the queue cannot absorb that fan-out), so each further drop of one full band
 *  opens a new round, which is a new debt signature, so the producer files again. The band is
 *  DERIVED from `pass - block` — the span already separating healthy from owing-work — not invented.
 *  FALSIFIER: test/coverage-remediation-escalates-in-rounds.test.ts. */
export function coverageRemediationRound(branchesPct: number, pass: number, block: number): number {
  const span = Math.max(1, pass - block);
  return Math.max(0, Math.floor((block - branchesPct) / span));
}

/** Tier three's `plan/feedback/` text — the same ranked files, plus the one remedy tier two cannot
 *  ask for: a branch no test can reach needs a seam, not another test. */
export function buildCoverageRemediationFeedback(
  files: readonly FileDebt[],
  opts: { branchesPct: number; round: number; block: number },
): string {
  const fileLines = files.map((f, i) => `${i + 1}. ${f.file} — ${f.uncoveredBranches} uncovered branch(es)`).join("\n");
  const roundLine =
    opts.round === 0
      ? `This is the FIRST remediation round for this debt.`
      : `This is remediation round ${opts.round + 1}: branch coverage has fallen a further ` +
        `${opts.round} full band(s) since the first round, and the earlier round(s) did not recover it.`;
  return (
    `Branch coverage is BELOW the remediation cut of the absolute coverage gate — ` +
    `${opts.branchesPct.toFixed(2)}% branches this run, under ${opts.block}%. THE BUILD IS NOT BLOCKED ` +
    `(operator ruling 2026-09-11: no hard floors; a PR lands and owes work). ${roundLine}\n\n` +
    `The files below own the most uncovered branches under src/, ranked by uncovered-branch COUNT ` +
    `(computed fresh from this run's own coverage/lcov.info):\n\n${fileLines}\n\n` +
    `Add branch-covering tests for these files. WHERE A FILE'S BRANCHES CANNOT BE REACHED FROM A ` +
    `TEST AT ALL, the work is to make it testable — extract the decision behind a seam, inject the ` +
    `dependency it reaches for — and not to write a test that asserts nothing in order to touch the ` +
    `line. Report which files needed that, so the next round can tell real progress from motion.`
  );
}

/**
 * A stable fingerprint of WHICH files currently own the debt — sorted (not rank-ordered), so a
 * trivial reordering of two files a single branch apart never looks like a changed debt profile,
 * while a genuinely different top-N (a file entering or leaving the list) always does. See the
 * module doc's "THE DEDUPE KEY IS THE DEBT SIGNATURE" section for why this, and not "ever filed"
 * or "this run", is what {@link injectCoverageImprovementTask} dedupes against.
 */
export function coverageDebtSignature(files: readonly FileDebt[]): string {
  return [...files]
    .map((f) => f.file)
    .sort()
    .join("|");
}

/** The raw `plan/feedback/` text for the ONE injected coverage-improvement task — names files
 *  and uncovered-branch counts, and reports the observed branch percentage only as run-time
 *  context (never a number carried from the commissioning shard — clause (5)). */
export function buildCoverageImprovementFeedback(files: readonly FileDebt[], opts: { branchesPct: number }): string {
  const fileLines = files.map((f, i) => `${i + 1}. ${f.file} — ${f.uncoveredBranches} uncovered branch(es)`).join("\n");
  return (
    `Branch coverage is in the pass-with-debt band of the absolute coverage gate — ` +
    `${opts.branchesPct.toFixed(2)}% branches this run (>= ${DEFAULT_TIER_PASS_PCT}% is healthy, ` +
    `< ${DEFAULT_TIER_BLOCK_PCT}% opens a remediation round; NO band blocks the build — operator ruling ` +
    `2026-09-11. This band passes and owes ONE improvement task).\n\n` +
    `The files below own the most uncovered branches under src/, ranked by uncovered-branch COUNT ` +
    `(never a percentage — computed fresh from this run's own coverage/lcov.info, not carried from ` +
    `any earlier measurement):\n\n${fileLines}\n\n` +
    `Add branch-covering tests for these files to move branch coverage back to healthy.`
  );
}

// ── Ledger dedupe (clause (4): a union read, never a one-file read) ────────────────────────

/** The ledger `step` this module's own dedupe marker uses. MUST be registered in
 *  `DECISION_RELEVANT_LEDGER_STEPS` (`src/lib/ledger.ts`) — see the module doc. */
export const COVERAGE_IMPROVEMENT_FILED_STEP = "coverage.improvement.filed";

/** A pre-filter pattern for {@link resolveLedgerUnion}, matching the RAW JSON line (the same
 *  `"step":"<literal>"` substring idiom `src/lib/autonomy.ts`'s `LEDGER_STEP_PATTERN` uses) so
 *  the union read never has to parse every non-matching line to find this module's own marker. */
const COVERAGE_IMPROVEMENT_LEDGER_PATTERN = /"step":"coverage\.improvement\.filed"/;

/** One PRIOR filing this module's own dedupe marker recorded. */
export interface FiledCoverageImprovementRecord {
  signature: string;
  ts?: string;
}

/** Parse every {@link COVERAGE_IMPROVEMENT_FILED_STEP} line out of a set of raw ledger match
 *  strings — a malformed line is skipped, never thrown on, the same discipline every other
 *  ledger reader in this codebase applies to a possibly-torn line. */
export function parseFiledCoverageImprovementLines(rawLines: readonly string[]): FiledCoverageImprovementRecord[] {
  const out: FiledCoverageImprovementRecord[] = [];
  for (const raw of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const line = parsed as { step?: unknown; signature?: unknown; ts?: unknown };
    if (line.step === COVERAGE_IMPROVEMENT_FILED_STEP && typeof line.signature === "string") {
      out.push({ signature: line.signature, ts: typeof line.ts === "string" ? line.ts : undefined });
    }
  }
  return out;
}

/** True iff `rawLines` (a {@link resolveLedgerUnion} match set) already recorded a filing for
 *  the EXACT same debt `signature`. */
export function alreadyFiledForSignature(rawLines: readonly string[], signature: string): boolean {
  return parseFiledCoverageImprovementLines(rawLines).some((r) => r.signature === signature);
}

// ── CI artifact reader (W1-T2661): daemon-side input for the producer above ─────────────────

export const COVERAGE_MERGED_ARTIFACT_NAME = "coverage-merged";
export const COVERAGE_AGGREGATOR_JOB_NAME = "coverage-ratchet";
export const COVERAGE_IMPROVEMENT_READ_STEP = "coverage_improvement.read";
export const COVERAGE_IMPROVEMENT_REFUSED_STEP = "coverage_improvement.refused";

export type CoverageArtifactRefusalReason =
  | "github_unreadable"
  | "no_merged_pr"
  | "no_completed_coverage_ratchet_run"
  | "no_coverage_merged_artifact"
  | "artifact_unreadable"
  | "download_not_lcov";

export interface MergedCoverageArtifact {
  lcovText: string;
  workflowRunId: number;
  headSha: string;
  artifactId: number;
  prNumber: number;
}

export type FetchMergedCoverageArtifactResult =
  | ({ status: "read" } & MergedCoverageArtifact)
  | {
      status: "refused";
      reason: CoverageArtifactRefusalReason;
      detail: string;
      workflowRunId?: number;
      headSha?: string;
      artifactId?: number;
      prNumber?: number;
    };

export type CoverageArtifactGhJson = (args: string[]) => unknown;
export type CoverageArtifactGhBuffer = (args: string[]) => Buffer;

export interface FetchMergedCoverageArtifactDeps {
  owner: string;
  repo: string;
  artifactName?: string;
  aggregatorJobName?: string;
  ghJson?: CoverageArtifactGhJson;
  ghBuffer?: CoverageArtifactGhBuffer;
  extractLcovFromZip?: (zip: Buffer) => string | undefined;
  ledgerPath?: string;
  ledgerRunId?: string;
  taskId?: string;
  writeLedgerLine?: (path: string, line: LedgerLine) => void;
}

export function mergedPullsRestArgs(owner: string, repo: string): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`];
}

export function workflowRunsForHeadRestArgs(owner: string, repo: string, headSha: string): string[] {
  return ["api", `repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&status=completed&per_page=100`];
}

export function workflowJobsForRunRestArgs(owner: string, repo: string, workflowRunId: number): string[] {
  return ["api", `repos/${owner}/${repo}/actions/runs/${workflowRunId}/jobs?per_page=100`];
}

export function workflowArtifactsForRunRestArgs(owner: string, repo: string, workflowRunId: number): string[] {
  return ["api", `repos/${owner}/${repo}/actions/runs/${workflowRunId}/artifacts?per_page=100`];
}

export function workflowArtifactZipRestArgs(owner: string, repo: string, artifactId: number): string[] {
  return ["api", `repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`];
}

function defaultCoverageArtifactGhJson(args: string[]): unknown {
  const out = ghExec(args, { encoding: "utf8", maxBuffer: 1 << 24 });
  return JSON.parse(out);
}

function defaultCoverageArtifactGhBuffer(args: string[]): Buffer {
  return ghExec(args, { maxBuffer: 1 << 28 });
}

function isLcovText(text: string): boolean {
  return /^SF:/m.test(text) && /^end_of_record$/m.test(text);
}

function zipEntryData(zip: Buffer, localHeaderOffset: number, compressedSize: number, compressionMethod: number): Buffer | undefined {
  if (localHeaderOffset < 0 || localHeaderOffset + 30 > zip.length) return undefined;
  if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) return undefined;
  const nameLen = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLen = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataStart > zip.length || dataEnd > zip.length) return undefined;
  const compressed = zip.subarray(dataStart, dataEnd);
  if (compressionMethod === 0) return compressed;
  if (compressionMethod === 8) return inflateRawSync(compressed);
  return undefined;
}

function findZipEndOfCentralDirectory(zip: Buffer): number {
  const min = Math.max(0, zip.length - 65_557);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Extract the first LCOV-looking text member from a GitHub Actions artifact zip. */
export function extractLcovFromArtifactZip(zip: Buffer): string | undefined {
  const eocd = findZipEndOfCentralDirectory(zip);
  if (eocd < 0 || eocd + 22 > zip.length) return undefined;
  const entryCount = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount && cursor + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) return undefined;
    const compressionMethod = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localHeaderOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    const data = zipEntryData(zip, localHeaderOffset, compressedSize, compressionMethod);
    if (data && (name.endsWith(".info") || /lcov/i.test(name))) {
      const text = data.toString("utf8");
      if (isLcovText(text)) return text;
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

function writeCoverageArtifactLedgerLine(
  deps: FetchMergedCoverageArtifactDeps,
  step: string,
  extra: Record<string, unknown>,
): void {
  if (!deps.ledgerPath) return;
  const writeLine = deps.writeLedgerLine ?? appendLedger;
  writeLine(deps.ledgerPath, {
    run_id: deps.ledgerRunId ?? `COVERAGE-IMPROVEMENT-${Date.now()}`,
    task_id: deps.taskId ?? "coverage-improve",
    step,
    ...extra,
  });
}

function refusal(
  deps: FetchMergedCoverageArtifactDeps,
  reason: CoverageArtifactRefusalReason,
  detail: string,
  extra: Omit<Extract<FetchMergedCoverageArtifactResult, { status: "refused" }>, "status" | "reason" | "detail"> = {},
): FetchMergedCoverageArtifactResult {
  writeCoverageArtifactLedgerLine(deps, COVERAGE_IMPROVEMENT_REFUSED_STEP, { reason, detail, ...extra });
  return { status: "refused", reason, detail, ...extra };
}

function mergedPrRows(rows: unknown): Array<{ number: number; mergedAt: string; headSha: string }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const r = row as { number?: unknown; merged_at?: unknown; head?: { sha?: unknown } };
      return typeof r.number === "number" && typeof r.merged_at === "string" && typeof r.head?.sha === "string"
        ? { number: r.number, mergedAt: r.merged_at, headSha: r.head.sha }
        : undefined;
    })
    .filter((r): r is { number: number; mergedAt: string; headSha: string } => r !== undefined)
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : b.number - a.number));
}

function completedAggregatorRunId(runsPayload: unknown, jobsForRun: (runId: number) => unknown, jobName: string): number | undefined {
  const runs = (runsPayload as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(runs)) return undefined;
  const ordered = [...runs]
    .filter((run): run is { id: number; status?: string; conclusion?: string; created_at?: string; run_started_at?: string } => {
      const r = run as { id?: unknown; status?: unknown; conclusion?: unknown; created_at?: unknown; run_started_at?: unknown };
      return typeof r.id === "number" && r.status === "completed" && r.conclusion === "success";
    })
    .sort((a, b) => {
      const at = a.run_started_at ?? a.created_at ?? "";
      const bt = b.run_started_at ?? b.created_at ?? "";
      return at < bt ? 1 : at > bt ? -1 : b.id - a.id;
    });
  for (const run of ordered) {
    const jobs = (jobsForRun(run.id) as { jobs?: unknown })?.jobs;
    if (!Array.isArray(jobs)) continue;
    const hasAggregator = jobs.some((job) => {
      const j = job as { name?: unknown; status?: unknown; conclusion?: unknown };
      return j.name === jobName && j.status === "completed" && j.conclusion === "success";
    });
    if (hasAggregator) return run.id;
  }
  return undefined;
}

function artifactIdByName(artifactsPayload: unknown, artifactName: string): number | undefined {
  const artifacts = (artifactsPayload as { artifacts?: unknown })?.artifacts;
  if (!Array.isArray(artifacts)) return undefined;
  const match = artifacts.find((artifact) => {
    const a = artifact as { id?: unknown; name?: unknown; expired?: unknown };
    return typeof a.id === "number" && a.name === artifactName && a.expired !== true;
  }) as { id?: number } | undefined;
  return match?.id;
}

/**
 * Resolve the newest merged PR with a completed, successful `coverage-ratchet` aggregator run,
 * read W1-T2662's `coverage-merged` artifact from that run, and return the LCOV text. Every
 * miss is a named refusal so the daemon never turns "not readable" into an empty report.
 */
export function fetchMergedCoverageArtifact(deps: FetchMergedCoverageArtifactDeps): FetchMergedCoverageArtifactResult {
  const ghJson = deps.ghJson ?? defaultCoverageArtifactGhJson;
  const ghBuffer = deps.ghBuffer ?? defaultCoverageArtifactGhBuffer;
  const extract = deps.extractLcovFromZip ?? extractLcovFromArtifactZip;
  const artifactName = deps.artifactName ?? COVERAGE_MERGED_ARTIFACT_NAME;
  const aggregatorJobName = deps.aggregatorJobName ?? COVERAGE_AGGREGATOR_JOB_NAME;

  let prs: Array<{ number: number; mergedAt: string; headSha: string }>;
  try {
    prs = mergedPrRows(ghJson(mergedPullsRestArgs(deps.owner, deps.repo)));
  } catch (e) {
    return refusal(deps, "github_unreadable", `merged PR list unreadable: ${String((e as Error)?.message ?? e)}`);
  }
  if (prs.length === 0) {
    return refusal(deps, "no_merged_pr", `no merged PRs were returned for ${deps.owner}/${deps.repo}`);
  }

  let selected: { prNumber: number; headSha: string; workflowRunId: number } | undefined;
  try {
    for (const pr of prs) {
      const runs = ghJson(workflowRunsForHeadRestArgs(deps.owner, deps.repo, pr.headSha));
      const workflowRunId = completedAggregatorRunId(
        runs,
        (runId) => ghJson(workflowJobsForRunRestArgs(deps.owner, deps.repo, runId)),
        aggregatorJobName,
      );
      if (workflowRunId !== undefined) {
        selected = { prNumber: pr.number, headSha: pr.headSha, workflowRunId };
        break;
      }
    }
  } catch (e) {
    return refusal(deps, "github_unreadable", `workflow run lookup unreadable: ${String((e as Error)?.message ?? e)}`);
  }
  if (!selected) {
    return refusal(deps, "no_completed_coverage_ratchet_run", `no merged PR head has a completed ${aggregatorJobName} run`);
  }

  let artifactId: number | undefined;
  try {
    artifactId = artifactIdByName(ghJson(workflowArtifactsForRunRestArgs(deps.owner, deps.repo, selected.workflowRunId)), artifactName);
  } catch (e) {
    return refusal(deps, "artifact_unreadable", `artifact list unreadable: ${String((e as Error)?.message ?? e)}`, selected);
  }
  if (artifactId === undefined) {
    return refusal(deps, "no_coverage_merged_artifact", `no ${artifactName} artifact on run ${selected.workflowRunId}`, selected);
  }

  let zip: Buffer;
  try {
    zip = ghBuffer(workflowArtifactZipRestArgs(deps.owner, deps.repo, artifactId));
  } catch (e) {
    return refusal(deps, "artifact_unreadable", `artifact ${artifactId} download unreadable: ${String((e as Error)?.message ?? e)}`, {
      ...selected,
      artifactId,
    });
  }
  const lcovText = extract(zip);
  if (lcovText === undefined) {
    return refusal(deps, "download_not_lcov", `artifact ${artifactId} did not contain an LCOV report`, { ...selected, artifactId });
  }

  writeCoverageArtifactLedgerLine(deps, COVERAGE_IMPROVEMENT_READ_STEP, {
    workflow_run_id: selected.workflowRunId,
    head_sha: selected.headSha,
    artifact_id: artifactId,
    artifact_name: artifactName,
    pr_number: selected.prNumber,
  });
  return { status: "read", lcovText, workflowRunId: selected.workflowRunId, headSha: selected.headSha, artifactId, prNumber: selected.prNumber };
}

// ── Orchestration (the producer's one entry point) ──────────────────────────────────────────

export interface InjectCoverageImprovementDeps {
  /** Repo checkout root — where `plan/feedback/` lives (passed straight to `captureFeedback`). */
  root: string;
  /** State dir `resolveLedgerUnion` globs for `ledger.*.ndjson[.gz]` rotations + the live file. */
  stateDir: string;
  /** Ledger path this run's own `coverage.improvement.filed` marker is appended to. */
  ledgerPath: string;
  runId: string;
  /** Already-read `coverage/lcov.info` contents — I/O stays with the caller so this function
   *  itself is a straightforward unit to drive with a fixture string. */
  lcovText: string;
  pass?: number;
  block?: number;
  limit?: number;
  /** Test seams — real callers never set these, matching every other injectable-deps producer
   *  in this codebase (e.g. `captureFeedback`'s own `land`/`upstream` seams). */
  capture?: (root: string, opts: CaptureFeedbackOptions) => FeedbackEntry;
  ledgerUnion?: (stateDir: string, pattern: string | RegExp, fsDeps?: LedgerGrepFsDeps) => LedgerUnionResult;
  writeLedgerLine?: (path: string, line: LedgerLine) => void;
  /** Passed straight through to `captureFeedback`'s own `land` seam so a test never touches a
   *  real `git`/`gh` landing attempt. */
  land?: CaptureFeedbackOptions["land"];
}

export type InjectCoverageImprovementResult =
  | { action: "healthy" | "blocking"; branchesPct: number }
  | { action: "no-debt"; branchesPct: number }
  | { action: "skipped-duplicate"; branchesPct: number; signature: string }
  | { action: "filed"; branchesPct: number; signature: string; feedbackId: string; files: FileDebt[] };

/**
 * THE PRODUCER'S ONE ENTRY POINT. Given this run's own lcov report, decide whether branch
 * coverage sits in the 85-90 pass-with-debt band; if it does, rank the `src/` files that own the
 * most uncovered branches, skip if a prior run already filed that EXACT debt signature (the
 * union-read dedupe — see the module doc), and otherwise file ONE `plan/feedback/` entry via
 * `captureFeedback` naming those files, recording a `coverage.improvement.filed` marker in the
 * ledger so a later run with the same debt signature does not refile it.
 *
 * Reached from `rmd coverage-improve` (`src/run-task.ts`) — an `rmd` verb, not a direct
 * `src/lib/` import from the coverage CI job, because that job cannot invoke a `src/lib/` module
 * directly without either a bare `tsx -e` incantation in the workflow or a second entry point
 * (W1-T470 design note). This function is inert until that verb is wired into
 * `.github/workflows/ci.yml`'s coverage job — a SEPARATE PR, per Rule 25 (see the module doc).
 */
export const injectCoverageImprovementTask = (deps: InjectCoverageImprovementDeps): InjectCoverageImprovementResult => {
  const records = parseLcovFileRecords(deps.lcovText);
  const branchesPct = aggregateBranchesPct(records);
  const pass = deps.pass ?? DEFAULT_TIER_PASS_PCT;
  const block = deps.block ?? DEFAULT_TIER_BLOCK_PCT;
  const tier = classifyImprovementTier(branchesPct, { pass, block });
  // W1-T3384b: `remediate` returned `blocking` and filed NOTHING, which was right while it failed
  // the build. #5117 retired that floor, so a band that neither blocks nor files left the debt
  // invisible AND unacted-on.
  if (tier === "healthy") {
    return { action: "healthy", branchesPct };
  }
  const remediating = tier === "remediate";

  const files = rankCoverageDebt(records, { limit: deps.limit });
  if (files.length === 0) {
    return { action: "no-debt", branchesPct };
  }

  // The round rides IN the dedupe key: the same files at a materially worse percentage is a NEW
  // ask, not a duplicate of the round that already failed to fix it.
  const round = remediating ? coverageRemediationRound(branchesPct, pass, block) : 0;
  const signature = remediating
    ? `${coverageDebtSignature(files)}#remediation-round:${round}`
    : coverageDebtSignature(files);
  const union = (deps.ledgerUnion ?? resolveLedgerUnion)(deps.stateDir, COVERAGE_IMPROVEMENT_LEDGER_PATTERN);
  // `union.ok === false` (zero archives matched, or a rotation went unread) means the union
  // cannot CONFIRM a prior filing — never that one is CONFIRMED absent. Filing anyway here is a
  // deliberate fail-open: `rmd triage`'s own semantic grounding is the queue's own backstop
  // against duplicate/already-decided work (the task's own title), so an occasional duplicate
  // entry is bounded and recoverable, while silently refusing to EVER file because a fresh
  // instance has not rotated a ledger yet would be the opposite, unbounded failure.
  if (union.ok && alreadyFiledForSignature(union.matches, signature)) {
    return { action: "skipped-duplicate", branchesPct, signature };
  }

  const capture = deps.capture ?? captureFeedback;
  const entry = capture(deps.root, {
    raw: remediating
      ? buildCoverageRemediationFeedback(files, { branchesPct, round, block })
      : buildCoverageImprovementFeedback(files, { branchesPct }),
    origin: "cli",
    land: deps.land,
  });

  const writeLine = deps.writeLedgerLine ?? appendLedger;
  writeLine(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: "coverage-improve",
    step: COVERAGE_IMPROVEMENT_FILED_STEP,
    signature,
    feedback_id: entry.id,
    files: files.map((f) => f.file),
    branches_pct: branchesPct,
  });

  return { action: "filed", branchesPct, signature, feedbackId: entry.id, files };
};
