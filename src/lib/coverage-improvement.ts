import { appendLedger, type LedgerLine } from "./ledger.js";
import { captureFeedback, type CaptureFeedbackOptions, type FeedbackEntry } from "./feedback.js";
import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "./ledger-grep.js";

/**
 * lib/coverage-improvement.ts — TIER TWO of the absolute-threshold coverage gate (W1-T470).
 *
 * TIER ONE (`classifyCoverageTier`, `scripts/coverage-ratchet.mjs`, merged as W1-T466/#1758)
 * classifies a run's branch coverage into three bands: `>= 90` healthy, `85-90` PASS-but-owes-
 * a-task, `< 85` blocks (tier three, a remediation loop, deliberately NOT built yet — see this
 * task's own plan shard for why a saturated `plan/feedback/` queue cannot absorb a repeated-
 * injection loop today). THIS module is the middle tier's whole deliverable: when a run lands
 * in the 85-90 band, it names the `src/` files that own the most uncovered branches and files
 * ONE `plan/feedback/` entry about them — never a shard written directly into `plan/tasks.d/`
 * (no such minter exists anywhere in this codebase; the only programmatic write path into the
 * plan is `captureFeedback`, see `src/lib/feedback.ts`) and never one entry per file (the queue
 * cannot absorb that fan-out — see W1-T470's rationale clause (2)).
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
    `< ${DEFAULT_TIER_BLOCK_PCT}% blocks the build; this band passes but owes ONE improvement task).\n\n` +
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
export function injectCoverageImprovementTask(deps: InjectCoverageImprovementDeps): InjectCoverageImprovementResult {
  const records = parseLcovFileRecords(deps.lcovText);
  const branchesPct = aggregateBranchesPct(records);
  const tier = classifyImprovementTier(branchesPct, { pass: deps.pass, block: deps.block });
  if (tier !== "improve") {
    return { action: tier === "healthy" ? "healthy" : "blocking", branchesPct };
  }

  const files = rankCoverageDebt(records, { limit: deps.limit });
  if (files.length === 0) {
    return { action: "no-debt", branchesPct };
  }

  const signature = coverageDebtSignature(files);
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
    raw: buildCoverageImprovementFeedback(files, { branchesPct }),
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
}
