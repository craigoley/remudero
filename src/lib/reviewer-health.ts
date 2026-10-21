/**
 * W1-T10269 — A REVIEWER REGRESSION HEALS ITSELF.
 *
 * On 2026-10-20 #12954 merged green and broke production review: every all-PASS review was withheld
 * and every shard without budget_usd was refused, for hours, and the two fix PRs could only be passed
 * by the broken reviewer. Main-health watches CI reds on main; a reviewer that WITHHOLDS is not red.
 *
 * This module measures the reviewer's own outcome mix per REVIEWER CODE SHA (the HEAD the judging
 * process loaded: the boot head in-process, the tree's sha in a fresh-tree child) and judges a
 * departure from its own history the way model-drift.ts judges drift: the current sha's Wilson
 * interval against the pooled interval of the shas before it, at a family alpha split over every sha
 * judged. No count, rate or time constant decides; a thin sample reads `insufficient`, never healthy.
 *
 * A departure opens ONE incident naming the boot head at onset, the regressed reviewer code sha (they
 * differ: the 10-20 onset rows came from a fresh tree at the offending sha while the boot head predated
 * it), the last healthy sha, and the offending merge: the first first-parent commit in healthy..regressed
 * whose diff is review-material. While it is open the review runs from a HEALED tree, origin/main with
 * that merge reverted on top, so W1-T228 reads it fresh with no exemption; a revert PR is opened through
 * the main-repair path; and the incident closes when the current reviewer's outcomes return to baseline.
 *
 * Counts are kept incrementally in state/reviewer-health.json as ledger rows are read past a cursor,
 * never by re-scanning the ledger (core memory ruling 10-10). The first boot seeds them with one
 * streaming, step-filtered read of the ledger union.
 */
import { execFileSync } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Escalation } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import { upperNormalQuantile, wilsonInterval } from "./model-drift.js";
import { REVIEW_MATERIAL_ADVANCE_PATHS, reviewAdvanceIsMaterial, reviewPathSpans, runTaskAdvanceTouchesReviewPath } from "./self-sync.js";

export const REVIEWER_HEALTH_VERSION = "reviewer-health-v1" as const;
export const REVIEWER_HEALTH_FILENAME = "reviewer-health.json";
/** PRIMARY CONTROL: the family-wise false-alarm rate, split evenly (Bonferroni) over every reviewer
 *  code sha that has outcomes, so a long history cannot inflate the alarm rate. Same value as
 *  model-drift's DRIFT_FAMILY_ALPHA. */
export const REVIEWER_HEALTH_FAMILY_ALPHA = 0.01;
/** BACKSTOP: per-sha unit maps kept in the state file; older shas pool into `pooled` (counts only),
 *  which still joins every later baseline and the Bonferroni family. */
export const MAX_TRACKED_REVIEWER_SHAS = 512;
/** BACKSTOP: closed incidents remembered for re-opening on the same failure signature. */
export const MAX_CLOSED_REVIEWER_INCIDENTS = 16;

/** The terminal review rows that record the judging process's code sha. */
export const REVIEWER_HEALTH_STEPS = [
  "review.posted",
  "review.semantic_incomplete",
  "review.semantic_setup_refused",
  "review.reviewer.skipped",
] as const;
/** A shadow review's rows are renamed under this prefix, so no other ledger reader can mistake one
 *  for a published review; only this module reads them. */
export const REVIEWER_SHADOW_STEP_PREFIX = "shadow.";
/** The shadow review's would-be terminal: it reached publication and published nothing. */
export const REVIEWER_SHADOW_VERDICT_STEP = "review.shadow_verdict";
export const REVIEWER_SHADOW_FLAG = "--reviewer-shadow";
/** Set by the daemon on a healed review child; every terminal row it writes carries it. */
export const REVIEWER_INCIDENT_ENV = "RMD_REVIEWER_INCIDENT_ID";

const ATTRIBUTION_STEPS = ["review.ran_from_fresh_tree", "daemon.boot"] as const;
/** Every step the health reader streams: terminal rows, their shadow twins, and attribution rows. */
export const REVIEWER_HEALTH_READ_STEPS: readonly string[] = [
  ...REVIEWER_HEALTH_STEPS,
  ...REVIEWER_HEALTH_STEPS.map((step) => `${REVIEWER_SHADOW_STEP_PREFIX}${step}`),
  `${REVIEWER_SHADOW_STEP_PREFIX}${REVIEWER_SHADOW_VERDICT_STEP}`,
  ...ATTRIBUTION_STEPS,
];

/** posted; withheld after the reviewer ran (success) or failed (provider health); refused at setup. */
export type ReviewerOutcomeClass = "posted" | "withheld-success" | "withheld-failure" | "setup-refused";

export interface ReviewerShaRecord {
  sha: string;
  seq: number;
  firstSeen: string;
  /** Every row came from a healed tree (it carries an incident id and is not a shadow). */
  healed: boolean;
  /** `<pr_url>#<head_sha>` → class. One unit per PR head, so a PR retried 146 times counts once. */
  units: Record<string, ReviewerOutcomeClass>;
  /** Reasons of the failing units, the incident's failure signature. */
  reasons: Record<string, number>;
  /** Host of the first failing unit: whose boot head was current at onset. */
  firstFailHost?: string;
  /** A regression judgment is final once made. */
  regressedAt?: string;
}

export interface ReviewerIncident {
  id: string;
  openedAt: string;
  regressedSha: string;
  regressedSeq: number;
  bootHeadSha: string | null;
  lastHealthySha: string | null;
  offending: { sha: string; subject: string; pr: number | null; reason: string } | null;
  offendingUnavailable?: string;
  signature: string[];
  evidence: ReviewerShaJudgment;
  issueUrl?: string | null;
  revertPrUrl?: string;
  revertRefused?: { reason: string; paths: string[] };
  reopenedFrom?: string;
}

export interface ReviewerHealthCursor {
  /** The newest rotation already read whole. */
  afterRotation?: string;
  /** Where the live ledger's next unread line starts, and the inode that offset belongs to. */
  liveOffset: number;
  liveIno?: number;
}

export interface ReviewerHealthState {
  version: typeof REVIEWER_HEALTH_VERSION;
  seededAt: string | null;
  seq: number;
  cursor: ReviewerHealthCursor | null;
  shas: Record<string, ReviewerShaRecord>;
  pooled: { k: number; n: number; shas: number };
  bootHeads: Record<string, string>;
  /** Legacy rows with no reviewer_code_sha, waiting for their fresh-tree row or the next boot. */
  pending: Record<string, Array<{ unit: string; cls: ReviewerOutcomeClass; reason: string | null; at: string }>>;
  incident: ReviewerIncident | null;
  closed: Array<ReviewerIncident & { closedAt: string }>;
  /** `rmd reviewer-heal --with-pr <n>`: the operator's explicit choice of a fix PR to heal with. */
  operatorHeal: { withPr: number; at: string } | null;
  coverage: { rows: number; unattributed: number };
}

export function emptyReviewerHealthState(): ReviewerHealthState {
  return { version: REVIEWER_HEALTH_VERSION, seededAt: null, seq: 0, cursor: null, shas: {},
    pooled: { k: 0, n: 0, shas: 0 }, bootHeads: {}, pending: {}, incident: null, closed: [],
    operatorHeal: null, coverage: { rows: 0, unattributed: 0 } };
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const SHA = /^[0-9a-f]{40,64}$/i;

type Classified =
  | { kind: "outcome"; sha?: string; unit: string; cls: ReviewerOutcomeClass; reason: string | null;
    host: string; pr: string | null; at: string; healed: boolean }
  | { kind: "boot"; host: string; sha: string }
  | { kind: "fresh-tree"; host: string; pr: string; sha: string };

function prNumberOf(row: Record<string, unknown>): string | null {
  const url = str(row.pr_url);
  const match = url === undefined ? null : /\/pull\/(\d+)$/.exec(url);
  return match ? match[1]! : null;
}

/** One ledger row as this module sees it, or undefined for a row it does not count. */
export function classifyReviewerHealthRow(row: Record<string, unknown>): Classified | undefined {
  const rawStep = str(row.step) ?? "";
  const host = str(row.host) ?? "unknown";
  if (rawStep === "daemon.boot") {
    const sha = str(row.head_sha);
    return sha && SHA.test(sha) ? { kind: "boot", host, sha } : undefined;
  }
  if (rawStep === "review.ran_from_fresh_tree") {
    const sha = str(row.origin_main_sha);
    const pr = row.pr === undefined ? undefined : String(row.pr);
    return sha && SHA.test(sha) && pr ? { kind: "fresh-tree", host, pr, sha } : undefined;
  }
  const shadow = rawStep.startsWith(REVIEWER_SHADOW_STEP_PREFIX);
  const step = shadow ? rawStep.slice(REVIEWER_SHADOW_STEP_PREFIX.length) : rawStep;
  let cls: ReviewerOutcomeClass;
  let reason: string | null = null;
  if (step === "review.posted" || (shadow && step === REVIEWER_SHADOW_VERDICT_STEP)) {
    // Code PRs only, and only a judgment: a plan-only PR, a reused or replayed verdict judged nothing.
    if (row.plan_only === true || row.review_reused === true || row.review_discriminated === true
      || row.status_recovered === true || row.status_confirmed === true) return undefined;
    cls = "posted";
  } else if (step === "review.semantic_incomplete") {
    cls = row.reviewer_outcome === "success" ? "withheld-success" : "withheld-failure";
    reason = str(row.reason) ?? null;
  } else if (step === "review.semantic_setup_refused") {
    cls = "setup-refused";
    reason = str(row.reason) ?? null;
  } else {
    return undefined;
  }
  const head = str(row.head_sha);
  const prUrl = str(row.pr_url);
  if (head === undefined || prUrl === undefined) return undefined;
  const provenance = row.reviewer_code_provenance as { codeSha?: unknown } | undefined;
  const sha = str(row.reviewer_code_sha) ?? str(provenance?.codeSha);
  return { kind: "outcome", ...(sha && SHA.test(sha) ? { sha } : {}), unit: `${prUrl}#${head}`, cls, reason, host,
    pr: prNumberOf(row), at: str(row.ts) ?? "", healed: !shadow && str(row.incident_id) !== undefined };
}

const isFailure = (cls: ReviewerOutcomeClass): boolean => cls === "withheld-success" || cls === "setup-refused";

function recordOutcome(state: ReviewerHealthState, sha: string, outcome: Extract<Classified, { kind: "outcome" }>): void {
  let rec = state.shas[sha];
  if (rec === undefined) {
    state.seq += 1;
    rec = { sha, seq: state.seq, firstSeen: outcome.at, healed: outcome.healed, units: {}, reasons: {} };
    state.shas[sha] = rec;
  } else if (!outcome.healed) {
    rec.healed = false;
  }
  const prior = rec.units[outcome.unit];
  // A unit that ever posted at this sha is posted; otherwise its newest class stands.
  if (prior === "posted") return;
  rec.units[outcome.unit] = outcome.cls;
  if (isFailure(outcome.cls) && prior === undefined) {
    const reason = outcome.reason ?? outcome.cls;
    rec.reasons[reason] = (rec.reasons[reason] ?? 0) + 1;
    rec.firstFailHost ??= outcome.host;
  }
}

function pool(state: ReviewerHealthState): void {
  const live = Object.values(state.shas).sort((a, b) => a.seq - b.seq);
  // The open incident's shas are never pooled away: the incident reads them until it closes.
  const keepFrom = state.incident?.regressedSeq ?? Number.POSITIVE_INFINITY;
  for (const rec of live.slice(0, Math.max(0, live.length - MAX_TRACKED_REVIEWER_SHAS))) {
    if (rec.seq >= keepFrom) continue;
    if (!rec.healed && rec.regressedAt === undefined) {
      const { k, n } = shaCounts(rec);
      state.pooled.k += k;
      state.pooled.n += n;
    }
    if (shaCounts(rec).n > 0) state.pooled.shas += 1;
    delete state.shas[rec.sha];
  }
}

/** Fold rows into the state. Pure apart from the state object; replaying a row changes nothing. */
export function ingestReviewerHealthRows(state: ReviewerHealthState, rows: Iterable<Record<string, unknown>>): string[] {
  const touched = new Set<string>();
  for (const row of rows) {
    const c = classifyReviewerHealthRow(row);
    if (c === undefined) continue;
    state.coverage.rows += 1;
    if (c.kind === "boot") {
      // A legacy row the tree never claimed was judged in-process, by the head booted before this one.
      const prior = state.bootHeads[c.host];
      for (const key of Object.keys(state.pending).filter((k) => k.startsWith(`${c.host}\u0000`))) {
        for (const p of state.pending[key]!) {
          if (prior === undefined) { state.coverage.unattributed += 1; continue; }
          recordOutcome(state, prior, { kind: "outcome", unit: p.unit, cls: p.cls, reason: p.reason, host: c.host, pr: null, at: p.at, healed: false });
          touched.add(prior);
        }
        delete state.pending[key];
      }
      state.bootHeads[c.host] = c.sha;
      continue;
    }
    if (c.kind === "fresh-tree") {
      const key = `${c.host}\u0000${c.pr}`;
      for (const p of state.pending[key] ?? []) {
        recordOutcome(state, c.sha, { kind: "outcome", unit: p.unit, cls: p.cls, reason: p.reason, host: c.host, pr: c.pr, at: p.at, healed: false });
        touched.add(c.sha);
      }
      delete state.pending[key];
      continue;
    }
    if (c.sha !== undefined) {
      recordOutcome(state, c.sha, c);
      touched.add(c.sha);
      continue;
    }
    // A row written before reviewer_code_sha existed: its fresh-tree row (logged by the parent after the
    // child exits) or the host's next boot says which code judged it.
    const key = `${c.host}\u0000${c.pr ?? ""}`;
    (state.pending[key] ??= []).push({ unit: c.unit, cls: c.cls, reason: c.reason, at: c.at });
  }
  pool(state);
  return [...touched];
}

export interface ReviewerShaJudgment {
  sha: string;
  state: "regressed" | "healthy" | "insufficient";
  reason: string | null;
  k: number;
  n: number;
  baseline: { k: number; n: number };
  interval: { lower: number; upper: number } | null;
  baselineInterval: { lower: number; upper: number } | null;
  z: number | null;
}

/** k = units not posted though the reviewer ran or was refused by setup; n adds the posted units.
 *  Withheld after a reviewer FAILURE is provider health, not reviewer code: in neither. */
export function shaCounts(rec: ReviewerShaRecord): { k: number; n: number } {
  let k = 0, n = 0;
  for (const cls of Object.values(rec.units)) {
    if (cls === "withheld-failure") continue;
    n += 1;
    if (isFailure(cls)) k += 1;
  }
  return { k, n };
}

function familyZ(state: ReviewerHealthState): number {
  const family = Object.values(state.shas).filter((rec) => shaCounts(rec).n > 0).length + state.pooled.shas;
  return upperNormalQuantile(REVIEWER_HEALTH_FAMILY_ALPHA / (2 * Math.max(1, family)));
}

/** The pooled outcomes of the non-healed shas before `rec` that were never judged regressed, and
 *  never inside the open incident. */
function baselineFor(state: ReviewerHealthState, rec: ReviewerShaRecord): { k: number; n: number } {
  let { k, n } = state.pooled;
  const incidentFrom = state.incident?.regressedSeq ?? Number.POSITIVE_INFINITY;
  for (const other of Object.values(state.shas)) {
    if (other.seq >= rec.seq || other.healed || other.regressedAt !== undefined || other.seq >= incidentFrom) continue;
    const c = shaCounts(other);
    k += c.k;
    n += c.n;
  }
  return { k, n };
}

/** Judge outcomes {k, n} against a baseline. Regressed: the interval lies wholly above the
 *  baseline's. Healthy: not regressed, AND the sample could have shown a regression — had every unit
 *  failed, that interval would lie above the baseline's. Anything else is insufficient. */
function judgeCounts(state: ReviewerHealthState, sha: string, k: number, n: number, baseline: { k: number; n: number }, regressedAt?: string): ReviewerShaJudgment {
  const counted = { sha, k, n, baseline, interval: null, baselineInterval: null, z: null };
  if (n === 0) return { ...counted, state: regressedAt ? "regressed" : "insufficient", reason: "no-outcomes" };
  if (baseline.n === 0) return { ...counted, state: regressedAt ? "regressed" : "insufficient", reason: "no-baseline" };
  const z = familyZ(state);
  const interval = wilsonInterval(k, n, z);
  const baselineInterval = wilsonInterval(baseline.k, baseline.n, z);
  const judged = { ...counted, interval, baselineInterval, z };
  if (regressedAt !== undefined || interval.lower > baselineInterval.upper) return { ...judged, state: "regressed", reason: null };
  if (wilsonInterval(n, n, z).lower <= baselineInterval.upper) return { ...judged, state: "insufficient", reason: "thin-sample" };
  return { ...judged, state: "healthy", reason: null };
}

/** Judge one sha against the pooled history before it. */
export function judgeReviewerSha(state: ReviewerHealthState, sha: string): ReviewerShaJudgment {
  const rec = state.shas[sha];
  if (rec === undefined) {
    return { sha, k: 0, n: 0, baseline: { k: 0, n: 0 }, interval: null, baselineInterval: null, z: null, state: "insufficient", reason: "no-outcomes" };
  }
  const { k, n } = shaCounts(rec);
  return judgeCounts(state, sha, k, n, baselineFor(state, rec), rec.regressedAt);
}

/** The incident's regressed shas, newest last. */
function incidentRegressed(state: ReviewerHealthState, incident: ReviewerIncident): ReviewerShaRecord[] {
  return Object.values(state.shas).filter((rec) => rec.regressedAt !== undefined && !rec.healed && rec.seq >= incident.regressedSeq)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Has the CURRENT reviewer returned to baseline? Its evidence is every non-healed sha since the
 * incident's newest regressed one (none of them regressed, or that one would be newest), pooled:
 * one sha rarely gathers enough outcomes alone before main moves on. It must read healthy against
 * the pre-incident baseline AND its interval must lie wholly below the newest regressed sha's.
 */
export function returnedToBaseline(state: ReviewerHealthState, incident: ReviewerIncident, sha: string): { returned: boolean; judgment: ReviewerShaJudgment } {
  const regressed = incidentRegressed(state, incident);
  const current = state.shas[sha];
  const since = regressed.at(-1)?.seq ?? incident.regressedSeq;
  if (current === undefined || current.healed || current.regressedAt !== undefined || current.seq <= since) {
    return { returned: false, judgment: judgeReviewerSha(state, sha) };
  }
  let k = 0, n = 0;
  for (const rec of Object.values(state.shas)) {
    if (rec.seq <= since || rec.healed || rec.regressedAt !== undefined) continue;
    const c = shaCounts(rec);
    k += c.k;
    n += c.n;
  }
  const judgment = judgeCounts(state, sha, k, n, baselineFor(state, current));
  if (judgment.state !== "healthy" || judgment.z === null || judgment.interval === null) return { returned: false, judgment };
  // Against the NEWEST regressed sha, the reviewer's most recent failure level: a total outage closes
  // on a few clean reviews after its fix; a partial one (one PR refused in a handful) needs more.
  const newest = regressed.at(-1);
  const level = newest === undefined ? { k: incident.evidence.k, n: incident.evidence.n } : shaCounts(newest);
  return { returned: level.n > 0 && judgment.interval.upper < wilsonInterval(level.k, level.n, judgment.z).lower, judgment };
}

export interface OffendingMerge { sha: string; subject: string; pr: number | null; reason: string }
export type GitText = (args: string[]) => string;

/** The src/lib modules the review path imports: src/lib/review.ts's own relative imports, and the
 *  import lines run-task.ts's review path reaches. #12954 added required-semantic-review.ts, which
 *  REVIEW_MATERIAL_ADVANCE_PATHS does not list. */
export function reviewPathImportedModules(git: GitText, sha: string): string[] {
  const found = new Set<string>();
  const show = (path: string): string | undefined => {
    try {
      return git(["show", `${sha}:${path}`]);
    } catch {
      return undefined; // deliberate: a path absent at this sha imports nothing
    }
  };
  for (const match of (show("src/lib/review.ts") ?? "").matchAll(/from\s+["']\.\/([^"']+)\.js["']/g)) found.add(`src/lib/${match[1]}.ts`);
  const runTask = show("src/run-task.ts");
  const spans = runTask === undefined ? undefined : reviewPathSpans(runTask);
  if (runTask !== undefined && spans !== undefined && "spans" in spans) {
    const reached = runTask.split("\n").filter((_line, index) => spans.spans.some(([from, to]) => index + 1 >= from && index + 1 <= to));
    for (const match of reached.join("\n").matchAll(/from\s+["']\.\/(lib\/[^"']+)\.js["']/g)) found.add(`src/${match[1]}.ts`);
  }
  return [...found].sort();
}

/** The first first-parent commit in healthy..regressed whose own diff is review-material. A squash
 *  merge and a merge commit both diff against their first parent. undefined: none qualifies. */
export function findOffendingMerge(git: GitText, healthySha: string, regressedSha: string): OffendingMerge | undefined {
  const commits = git(["rev-list", "--first-parent", "--reverse", `${healthySha}..${regressedSha}`]).split("\n").map((s) => s.trim()).filter(Boolean);
  const widened = new Set<string>([...REVIEW_MATERIAL_ADVANCE_PATHS, ...reviewPathImportedModules(git, regressedSha)]);
  for (const sha of commits) {
    const parent = `${sha}^1`;
    const paths = git(["diff", "--name-only", parent, sha]).split("\n").map((s) => s.trim()).filter(Boolean);
    // run-task.ts counts only when a hunk meets its review path (W1-T4469), never as a whole file.
    const material = paths.filter((path) => path !== "src/run-task.ts" && (widened.has(path) || reviewAdvanceIsMaterial([path])));
    let reason: string | undefined;
    if (material.length > 0) reason = `touches ${material.join(", ")}`;
    else if (paths.includes("src/run-task.ts")) {
      const touched = runTaskAdvanceTouchesReviewPath(git, parent, sha);
      if (touched.touchesReviewPath) reason = `src/run-task.ts: ${touched.reason}`;
    }
    if (reason === undefined) continue;
    const subject = git(["log", "-1", "--format=%s", sha]).trim();
    const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(subject)?.[1];
    return { sha, subject, pr: pr === undefined ? null : Number(pr), reason };
  }
  return undefined;
}

/** A healed reviewer tree: origin/main with the offending merge reverted (or an operator-named fix PR
 *  merged) on top, so its merge-base with origin/main IS origin/main. */
export type HealedTree =
  | { state: "ready"; path: string; sha: string; originMainSha: string; patch: "revert" | "with-pr"; withPr?: number }
  | { state: "empty"; originMainSha: string }
  | { state: "conflict"; originMainSha: string; reason: string; paths: string[] }
  | { state: "unavailable"; originMainSha: string | null; reason: string };

export interface HealedTreeSeams {
  /** git in `repoDir` (args only). */
  git: GitText;
  /** git inside a tree. */
  treeGit: (tree: string, args: string[]) => string;
  /** Cuts (or proves) a clean detached tree at `sha` under `prefix`, runnable; the fresh-tree helper. */
  cut: (prefix: string, sha: string) => string;
  /** Removes a tree this builder cut and could not finish. */
  remove: (tree: string) => void;
}

const HEAL_IDENTITY = ["-c", "user.name=remudero reviewer-heal", "-c", "user.email=reviewer-heal@remudero.invalid"];
const healedMemo = new Map<string, { path: string; sha: string }>();

/** Build (or reuse) the healed tree for `offendingSha` at origin/main. Never an old head, never an
 *  engine tree: every route here starts from origin/main. */
export function buildHealedReviewerTree(
  seams: HealedTreeSeams,
  offendingSha: string,
  opts: { withPr?: number } = {},
): HealedTree {
  let originMainSha: string;
  try {
    seams.git(["fetch", "--quiet", "origin", "main"]);
    originMainSha = seams.git(["rev-parse", "origin/main"]).trim();
  } catch (error) {
    return { state: "unavailable", originMainSha: null, reason: `origin/main unreadable: ${String((error as Error)?.message ?? error)}` };
  }
  const patch = opts.withPr === undefined ? "revert" as const : "with-pr" as const;
  const key = `${patch}:${opts.withPr ?? offendingSha}:${originMainSha}`;
  const known = healedMemo.get(key);
  if (known !== undefined) {
    try {
      const head = seams.treeGit(known.path, ["rev-parse", "HEAD"]).trim();
      const parent = seams.treeGit(known.path, ["rev-parse", "HEAD^1"]).trim();
      const dirty = seams.treeGit(known.path, ["status", "--porcelain", "-uno"]).trim();
      if (head === known.sha && parent === originMainSha && dirty === "") {
        return { state: "ready", path: known.path, sha: known.sha, originMainSha, patch, ...(opts.withPr === undefined ? {} : { withPr: opts.withPr }) };
      }
    } catch {
      // deliberate: an unreadable cached tree is rebuilt below
    }
    healedMemo.delete(key);
  }
  if (opts.withPr === undefined) {
    try {
      // Already reverted (or otherwise undone) on main: the healed tree IS origin/main.
      seams.git(["merge-base", "--is-ancestor", offendingSha, originMainSha]);
    } catch {
      return { state: "unavailable", originMainSha, reason: `${offendingSha.slice(0, 12)} is not on origin/main ${originMainSha.slice(0, 12)}` };
    }
  }
  let tree: string;
  try {
    tree = seams.cut(`healed-${(opts.withPr === undefined ? offendingSha : `pr${opts.withPr}`).slice(0, 12)}`, originMainSha);
  } catch (error) {
    return { state: "unavailable", originMainSha, reason: `healed tree could not be cut: ${String((error as Error)?.message ?? error)}` };
  }
  // A merge commit reverts against its first parent, as findOffendingMerge diffed it; a squash merge has one parent.
  const mainline = mainlineArgs(seams, offendingSha);
  try {
    if (opts.withPr === undefined) {
      seams.treeGit(tree, [...HEAL_IDENTITY, "revert", "--no-commit", ...mainline, offendingSha]);
      const staged = seams.treeGit(tree, ["diff", "--cached", "--name-only"]).trim();
      if (staged === "") {
        seams.treeGit(tree, ["revert", "--abort"]);
        seams.remove(tree);
        return { state: "empty", originMainSha };
      }
      seams.treeGit(tree, [...HEAL_IDENTITY, "commit", "--quiet", "--no-verify", "-m", `Revert ${offendingSha.slice(0, 12)} (reviewer-heal, W1-T10269)`]);
    } else {
      seams.treeGit(tree, ["fetch", "--quiet", "origin", `refs/pull/${opts.withPr}/head`]);
      seams.treeGit(tree, [...HEAL_IDENTITY, "merge", "--no-ff", "--no-edit", "--no-verify", "FETCH_HEAD"]);
    }
  } catch (error) {
    let paths: string[] = [];
    try {
      paths = seams.treeGit(tree, ["diff", "--name-only", "--diff-filter=U"]).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      // deliberate: the conflict stands without its path list
    }
    try {
      seams.treeGit(tree, opts.withPr === undefined ? ["revert", "--abort"] : ["merge", "--abort"]);
    } catch {
      // deliberate: the tree is removed next either way
    }
    if (opts.withPr === undefined && offendingChangesAbsent(seams, tree, offendingSha, mainline)) {
      seams.remove(tree);
      return { state: "empty", originMainSha };
    }
    try {
      seams.remove(tree);
    } catch {
      // deliberate: an unremoved tree is reaped with the reviewer's other trees
    }
    const what = opts.withPr === undefined ? `the revert of ${offendingSha.slice(0, 12)}` : `PR #${opts.withPr}`;
    return { state: "conflict", originMainSha, paths,
      reason: `${what} does not apply cleanly on origin/main ${originMainSha.slice(0, 12)}: ${String((error as Error)?.message ?? error).split("\n")[0]}` };
  }
  const sha = seams.treeGit(tree, ["rev-parse", "HEAD"]).trim();
  healedMemo.set(key, { path: tree, sha });
  return { state: "ready", path: tree, sha, originMainSha, patch, ...(opts.withPr === undefined ? {} : { withPr: opts.withPr }) };
}

/** A revert that does not apply may mean main already undid the merge (a revert PR merged): then
 *  re-applying the merge itself applies cleanly. That reads as an empty patch, never a conflict. */
function offendingChangesAbsent(seams: HealedTreeSeams, tree: string, offendingSha: string, mainline: string[]): boolean {
  try {
    seams.treeGit(tree, [...HEAL_IDENTITY, "cherry-pick", "--no-commit", ...mainline, offendingSha]);
    const staged = seams.treeGit(tree, ["diff", "--cached", "--name-only"]).trim();
    return staged !== "";
  } catch {
    return false; // deliberate: neither direction applies, so it is a conflict
  } finally {
    try {
      seams.treeGit(tree, ["reset", "--hard", "--quiet", "HEAD"]);
    } catch {
      // deliberate: the tree is removed by the caller either way
    }
  }
}

function mainlineArgs(seams: HealedTreeSeams, sha: string): string[] {
  try {
    return seams.git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).length > 2 ? ["-m", "1"] : [];
  } catch {
    return []; // deliberate: an unreadable parent list reverts as a single-parent commit, and a conflict says so
  }
}

/** Test seam: forget every healed tree this process built. */
export function resetHealedReviewerTrees(): void {
  healedMemo.clear();
}

/** The outcome-mix evidence, as the revert PR body and the issue name it. */
export function reviewerRegressionEvidenceText(incident: ReviewerIncident): string {
  const e = incident.evidence;
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const range = (i: { lower: number; upper: number } | null) => (i === null ? "n/a" : `[${pct(i.lower)}, ${pct(i.upper)}]`);
  return [
    `Reviewer code ${incident.regressedSha.slice(0, 12)} ended ${e.k} of ${e.n} code-PR reviews not posted though the reviewer ran or setup refused it ` +
      `(Wilson ${range(e.interval)} at z=${e.z === null ? "n/a" : e.z.toFixed(2)}), against ${e.baseline.k} of ${e.baseline.n} ` +
      `for the reviewer code before it (${range(e.baselineInterval)}).`,
    `Failure signature: ${incident.signature.join(", ") || "(none named)"}.`,
    `Boot head at onset: ${incident.bootHeadSha?.slice(0, 12) ?? "unknown"}; last healthy reviewer code: ${incident.lastHealthySha?.slice(0, 12) ?? "none judged"}.`,
    incident.offending ? `Offending merge: ${incident.offending.sha.slice(0, 12)} ${incident.offending.subject} (${incident.offending.reason}).`
      : `Offending merge: not found (${incident.offendingUnavailable ?? "no review-material merge in range"}).`,
  ].join("\n");
}

/** The incident as an escalation (an assigned issue: Remudero Issues are the alert channel). A
 *  healed tree that could not be built adds `conflict`: then reviews run as before the incident. */
export function reviewerRegressionEscalation(incident: ReviewerIncident, conflict?: { reason: string; paths: readonly string[] }): Escalation {
  const pr = incident.offending?.pr ?? null;
  return {
    class: "BLOCKED",
    taskId: incident.id,
    summary: conflict
      ? `Reviewer regression ${incident.id}: the healed reviewer cannot be built`
      : `Reviewer regression: reviewer code ${incident.regressedSha.slice(0, 12)} departed from its own history`,
    detail: [
      reviewerRegressionEvidenceText(incident),
      "",
      conflict
        ? `The healed tree (origin/main with the offending merge reverted) does not apply: ${conflict.reason}` +
          (conflict.paths.length > 0 ? ` (conflicting: ${conflict.paths.join(", ")})` : "") + ". Reviews run from today's path, unchanged."
        : "Reviews now run from origin/main with the offending merge reverted on top (W1-T228 reads that tree fresh), and a revert PR goes through ordinary CI, review and branch protection.",
    ].join("\n"),
    options: [
      { label: "Let the revert PR merge", detail: "Its review runs on the healed tree; the incident closes once the reviewer's outcomes return to baseline.", kind: { type: "operator-only" } },
      { label: "Heal with a fix PR", detail: `Run \`rmd reviewer-heal --with-pr <n>\` to review from origin/main merged with that PR instead of the revert${pr === null ? "" : ` of #${pr}`}.`, kind: { type: "operator-only" } },
      { label: "Close as a false alarm", detail: "Close this issue and the revert PR; the detector keeps measuring and closes the incident itself once the reviewer reads healthy.", kind: { type: "operator-only" } },
    ],
    recommendation: conflict ? "Heal with a fix PR" : "Let the revert PR merge",
    headDedup: "independent",
    consequence: conflict
      ? "Reviews keep running on the regressed reviewer, as before this incident, until a fix merges."
      : "Reviews keep running from the healed tree until the incident closes; nothing merges without review.",
  };
}

export interface ReviewerHealthEffects {
  findOffendingMerge(healthySha: string, regressedSha: string): OffendingMerge | undefined;
  /** True when `ancestor` is on `descendant`'s history: a last healthy sha must precede the regression in git. */
  isAncestor(ancestor: string, descendant: string): boolean;
  /** Raise the incident as an assigned issue (with `conflict`: its healed tree cannot be built);
   *  returns the issue url, or null when it could not be filed. */
  escalate(incident: ReviewerIncident, conflict?: { reason: string; paths: readonly string[] }): Promise<string | null>;
  openRevertPr(incident: ReviewerIncident & { offending: OffendingMerge }): Promise<{ prUrl: string } | { refused: string; conflictPaths?: readonly string[] }>;
  closeIssue(url: string, comment: string): Promise<void>;
  /** The revert PR's lifecycle, to close it only when a fix made it unnecessary. */
  readPr(url: string): Promise<"open" | "closed" | "merged">;
  closePr(url: string, comment: string): Promise<void>;
}

export interface ReviewerHealthDeps {
  statePath: string;
  /** New rows since the cursor (null: the first read, which seeds from the whole union). */
  readRows(cursor: ReviewerHealthCursor | null): Promise<{ rows: Iterable<Record<string, unknown>>; cursor: ReviewerHealthCursor }>;
  effects: ReviewerHealthEffects;
  log(step: string, extra?: Record<string, unknown>): void;
  now(): string;
}

export type ReviewerHealthDecision =
  | { route: "normal"; reason: string; current: ReviewerShaJudgment | null }
  | { route: "healed"; incident: ReviewerIncident; shadow: boolean; withPr: number | null; current: ReviewerShaJudgment | null };

/** An absent, unparseable or older-version file reads as empty, so the next evaluation re-seeds
 *  from the ledger union rather than judging on counts it cannot trust. */
export function loadReviewerHealthState(path: string): ReviewerHealthState {
  if (!existsSync(path)) return emptyReviewerHealthState();
  let parsed: Partial<ReviewerHealthState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewerHealthState>;
  } catch {
    return emptyReviewerHealthState(); // deliberate: a torn state file re-seeds; the ledger is the record
  }
  if (parsed?.version !== REVIEWER_HEALTH_VERSION) return emptyReviewerHealthState();
  return { ...emptyReviewerHealthState(), ...parsed } as ReviewerHealthState;
}

export function saveReviewerHealthState(path: string, state: ReviewerHealthState): void {
  writeAtomic(path, `${JSON.stringify(state)}\n`, { tmpTag: "reviewer-health" });
}

function signatureOf(rec: ReviewerShaRecord): string[] {
  return Object.keys(rec.reasons).sort();
}

/** Effects off: the seed replays history to learn which incident (if any) is still open, and acts
 *  on that one only, once, after. */
interface Act { live: boolean }

function newestHealthyAncestor(state: ReviewerHealthState, deps: ReviewerHealthDeps, rec: ReviewerShaRecord): ReviewerShaRecord | undefined {
  const earlier = Object.values(state.shas)
    .filter((other) => other.seq < rec.seq && !other.healed && other.regressedAt === undefined)
    .sort((a, b) => b.seq - a.seq);
  for (const other of earlier) {
    if (judgeReviewerSha(state, other.sha).state !== "healthy") continue;
    try {
      if (deps.effects.isAncestor(other.sha, rec.sha)) return other;
    } catch {
      // deliberate: an unknown sha (a PR head, a pruned tree) cannot be the healthy side of the range
    }
  }
  return undefined;
}

function openIncident(state: ReviewerHealthState, deps: ReviewerHealthDeps, rec: ReviewerShaRecord, judgment: ReviewerShaJudgment, act: Act): void {
  const signature = signatureOf(rec);
  const bootHeadSha = rec.firstFailHost === undefined ? null : state.bootHeads[rec.firstFailHost] ?? null;
  const prior = [...state.closed].reverse().find((c) => c.signature.some((s) => signature.includes(s)));
  let incident: ReviewerIncident;
  if (prior !== undefined) {
    // The same failure mode again after a close: the same cause, so the same blame and the same heal.
    const { closedAt: _closedAt, revertPrUrl: _url, revertRefused: _refused, ...rest } = prior;
    void [_closedAt, _url, _refused];
    incident = { ...rest, signature: [...new Set([...rest.signature, ...signature])].sort(), evidence: judgment, reopenedFrom: prior.id };
    state.closed = state.closed.filter((c) => c.id !== prior.id);
  } else {
    const lastHealthy = newestHealthyAncestor(state, deps, rec);
    let offending: OffendingMerge | undefined;
    let offendingUnavailable: string | undefined;
    if (lastHealthy === undefined) offendingUnavailable = "no healthy reviewer code sha precedes the regression";
    else {
      try {
        offending = deps.effects.findOffendingMerge(lastHealthy.sha, rec.sha);
        if (offending === undefined) offendingUnavailable = `no review-material merge in ${lastHealthy.sha.slice(0, 12)}..${rec.sha.slice(0, 12)}`;
      } catch (error) {
        offendingUnavailable = `merge history unreadable: ${String((error as Error)?.message ?? error)}`;
      }
    }
    incident = { id: `reviewer-regression-${rec.sha.slice(0, 12)}`, openedAt: deps.now(), regressedSha: rec.sha, regressedSeq: rec.seq,
      bootHeadSha, lastHealthySha: lastHealthy?.sha ?? null, offending: offending ?? null,
      ...(offendingUnavailable === undefined ? {} : { offendingUnavailable }), signature, evidence: judgment };
  }
  state.incident = incident;
  if (!act.live) return;
  deps.log("reviewer.regression_opened", {
    incident_id: incident.id, regressed_reviewer_code_sha: rec.sha, boot_head_sha: bootHeadSha,
    last_healthy_reviewer_code_sha: incident.lastHealthySha, offending_sha: incident.offending?.sha ?? null,
    offending_pr: incident.offending?.pr ?? null, offending_reason: incident.offending?.reason ?? incident.offendingUnavailable ?? null,
    signature: incident.signature, k: judgment.k, n: judgment.n, baseline_k: judgment.baseline.k, baseline_n: judgment.baseline.n,
    interval: judgment.interval, baseline_interval: judgment.baselineInterval, z: judgment.z,
    ...(incident.reopenedFrom ? { reopened_from: incident.reopenedFrom } : {}),
  });
}

/** The incident's outward effects: the assigned issue, then one revert PR of the offending merge. */
async function raiseIncident(deps: ReviewerHealthDeps, incident: ReviewerIncident): Promise<void> {
  try {
    incident.issueUrl = await deps.effects.escalate(incident);
  } catch (error) {
    incident.issueUrl = null;
    deps.log("reviewer.regression_escalation_failed", { incident_id: incident.id, error: String((error as Error)?.message ?? error) });
  }
  if (incident.offending === null || incident.revertPrUrl !== undefined) return;
  try {
    const outcome = await deps.effects.openRevertPr({ ...incident, offending: incident.offending });
    if ("prUrl" in outcome) {
      incident.revertPrUrl = outcome.prUrl;
      return;
    }
    incident.revertRefused = { reason: outcome.refused, paths: [...(outcome.conflictPaths ?? [])] };
  } catch (error) {
    incident.revertRefused = { reason: String((error as Error)?.message ?? error), paths: [] };
  }
  // A conflicting revert is ledgered with its paths; the healed reviewer (or the escalation) still covers it.
  deps.log("main-repair.revert_refused", { incident_id: incident.id, offending_sha: incident.offending.sha,
    reason: incident.revertRefused.reason, conflict_paths: incident.revertRefused.paths });
}

async function closeIncident(state: ReviewerHealthState, deps: ReviewerHealthDeps, judgment: ReviewerShaJudgment, act: Act): Promise<void> {
  const incident = state.incident!;
  state.closed = [...state.closed, { ...incident, closedAt: deps.now() }].slice(-MAX_CLOSED_REVIEWER_INCIDENTS);
  state.incident = null;
  if (!act.live) return;
  let revertPr: "open" | "closed" | "merged" | "unread" | null = null;
  if (incident.revertPrUrl !== undefined) {
    try {
      revertPr = await deps.effects.readPr(incident.revertPrUrl);
    } catch {
      revertPr = "unread"; // deliberate: an unread PR is left open, never closed blind
    }
  }
  const comment = `Reviewer code ${judgment.sha.slice(0, 12)} (origin/main) is back inside its baseline: ${judgment.k} of ${judgment.n} ` +
    `not posted against ${judgment.baseline.k} of ${judgment.baseline.n} before (W1-T10269).`;
  if (incident.revertPrUrl !== undefined && revertPr === "open") {
    try {
      await deps.effects.closePr(incident.revertPrUrl, `${comment} A fix made this revert unnecessary.`);
    } catch (error) {
      deps.log("reviewer.regression_revert_close_failed", { incident_id: incident.id, pr_url: incident.revertPrUrl, error: String((error as Error)?.message ?? error) });
    }
  }
  if (incident.issueUrl) {
    try {
      await deps.effects.closeIssue(incident.issueUrl, comment);
    } catch (error) {
      deps.log("reviewer.regression_issue_close_failed", { incident_id: incident.id, issue_url: incident.issueUrl, error: String((error as Error)?.message ?? error) });
    }
  }
  deps.log("reviewer.regression_closed", { incident_id: incident.id, current_reviewer_code_sha: judgment.sha, k: judgment.k, n: judgment.n,
    baseline_k: judgment.baseline.k, baseline_n: judgment.baseline.n, revert_pr: incident.revertPrUrl ?? null, revert_pr_state: revertPr });
}

/** Ingest `rows`, judge the shas they touched (oldest first, so the onset departs first), then test
 *  the open incident's close against `current`. */
async function stepReviewerHealth(state: ReviewerHealthState, deps: ReviewerHealthDeps, rows: Iterable<Record<string, unknown>>,
  current: string | null, act: Act): Promise<void> {
  const touched = ingestReviewerHealthRows(state, rows);
  const candidates = touched.map((sha) => state.shas[sha])
    .filter((rec): rec is ReviewerShaRecord => rec !== undefined && !rec.healed && rec.regressedAt === undefined)
    .sort((a, b) => a.seq - b.seq);
  for (const rec of candidates) {
    const judgment = judgeReviewerSha(state, rec.sha);
    if (judgment.state !== "regressed") continue;
    rec.regressedAt = deps.now();
    if (state.incident === null) {
      openIncident(state, deps, rec, judgment, act);
      if (act.live) await raiseIncident(deps, state.incident!);
      continue;
    }
    // A later sha failing the same way joins the open incident: its reasons extend the signature a
    // recurrence after a close is matched on, so the recurrence keeps the original blame.
    state.incident.signature = [...new Set([...state.incident.signature, ...signatureOf(rec)])].sort();
    if (act.live) deps.log("reviewer.regression_extended", { incident_id: state.incident.id, reviewer_code_sha: rec.sha,
      k: judgment.k, n: judgment.n, signature: state.incident.signature });
  }
  if (state.incident !== null && current !== null) {
    const back = returnedToBaseline(state, state.incident, current);
    if (back.returned) await closeIncident(state, deps, back.judgment, act);
  }
}

/** The newest non-healed sha the history names: the seed's stand-in for "origin/main then". */
function newestReviewerSha(state: ReviewerHealthState): string | null {
  const newest = Object.values(state.shas).filter((rec) => !rec.healed).sort((a, b) => b.seq - a.seq)[0];
  return newest?.sha ?? null;
}

/**
 * Read the reviewer's new outcomes, judge them, open or close the incident, and say how THIS review
 * routes. `originMainSha` is the current reviewer: origin/main's code.
 */
export async function evaluateReviewerHealthNow(deps: ReviewerHealthDeps, input: { originMainSha: string | null }): Promise<ReviewerHealthDecision> {
  const state = loadReviewerHealthState(deps.statePath);
  const read = await deps.readRows(state.cursor);
  if (state.cursor === null) {
    // THE SEED replays history row by row with effects off, so a deploy mid-outage inherits the
    // outage's incident (and its blame) rather than judging today against a poisoned baseline.
    for (const row of read.rows) await stepReviewerHealth(state, deps, [row], newestReviewerSha(state), { live: false });
    state.seededAt = deps.now();
    deps.log("reviewer.health_seeded", { shas: Object.keys(state.shas).length, pooled_shas: state.pooled.shas,
      rows: state.coverage.rows, unattributed: state.coverage.unattributed, open_incident: state.incident?.id ?? null,
      closed_incidents: state.closed.map((c) => c.id) });
    // History's incident is raised only when today's reviewer is itself regressed; otherwise it is
    // carried as closed, so a recurrence of its failure signature reopens it with the original blame.
    if (state.incident !== null && (input.originMainSha === null || judgeReviewerSha(state, input.originMainSha).state !== "regressed")) {
      deps.log("reviewer.regression_carried", { incident_id: state.incident.id, offending_sha: state.incident.offending?.sha ?? null,
        signature: state.incident.signature, reason: "today's reviewer code is not judged regressed" });
      await closeIncident(state, deps, judgeReviewerSha(state, input.originMainSha ?? state.incident.regressedSha), { live: false });
    }
    if (state.incident !== null) {
      const incident = state.incident;
      deps.log("reviewer.regression_opened", { incident_id: incident.id, regressed_reviewer_code_sha: incident.regressedSha,
        boot_head_sha: incident.bootHeadSha, last_healthy_reviewer_code_sha: incident.lastHealthySha,
        offending_sha: incident.offending?.sha ?? null, offending_pr: incident.offending?.pr ?? null,
        offending_reason: incident.offending?.reason ?? incident.offendingUnavailable ?? null, signature: incident.signature,
        k: incident.evidence.k, n: incident.evidence.n, baseline_k: incident.evidence.baseline.k, baseline_n: incident.evidence.baseline.n,
        from_seed: true });
      await raiseIncident(deps, incident);
    }
  } else {
    await stepReviewerHealth(state, deps, read.rows, input.originMainSha, { live: true });
  }
  state.cursor = read.cursor;
  saveReviewerHealthState(deps.statePath, state);
  const current = input.originMainSha === null ? null : judgeReviewerSha(state, input.originMainSha);
  const incident = state.incident;
  if (incident === null) return { route: "normal", reason: "no open reviewer-regression incident", current };
  if (incident.offending === null) return { route: "normal", reason: `incident ${incident.id} names no offending merge to revert`, current };
  // Shadow the current reviewer only while its own sha has no judgment yet: judged regressed, it stops;
  // returned to baseline, the incident has closed above.
  return { route: "healed", incident, shadow: input.originMainSha !== null && current?.state !== "regressed",
    withPr: state.operatorHeal?.withPr ?? null, current };
}

const chains = new Map<string, Promise<unknown>>();
const seeding = new Map<string, Promise<unknown>>();

/**
 * The daemon's entry: evaluations of one state file run one at a time (reviews run in parallel),
 * and the first boot's seed — a whole-union read — runs in the background while reviews route as
 * today. Any failure routes normally and is ledgered; it never blocks a review.
 */
export async function evaluateReviewerHealth(deps: ReviewerHealthDeps, input: { originMainSha: string | null }): Promise<ReviewerHealthDecision> {
  if (seeding.has(deps.statePath)) return { route: "normal", reason: "reviewer health is seeding from the ledger union", current: null };
  if (!existsSync(deps.statePath) || loadReviewerHealthState(deps.statePath).cursor === null) {
    const seed = evaluateReviewerHealthNow(deps, input).catch((error: unknown) => {
      deps.log("reviewer.health_unavailable", { phase: "seed", error: String((error as Error)?.message ?? error) });
    }).finally(() => seeding.delete(deps.statePath));
    seeding.set(deps.statePath, seed);
    return { route: "normal", reason: "reviewer health is seeding from the ledger union", current: null };
  }
  const prior = chains.get(deps.statePath) ?? Promise.resolve();
  const run = prior.then(() => evaluateReviewerHealthNow(deps, input), () => evaluateReviewerHealthNow(deps, input));
  chains.set(deps.statePath, run.catch(() => undefined));
  try {
    return await run;
  } catch (error) {
    deps.log("reviewer.health_unavailable", { phase: "evaluate", error: String((error as Error)?.message ?? error) });
    return { route: "normal", reason: `reviewer health unavailable: ${String((error as Error)?.message ?? error)}`, current: null };
  }
}

/** Test seam: wait for a background seed of `statePath` to settle. */
export async function settleReviewerHealthSeed(statePath: string): Promise<void> {
  await seeding.get(statePath);
}

/** Where the live ledger's last complete line ends. */
function completeLivePrefix(path: string, size: number): number {
  if (size === 0) return 0;
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const bytes = readSync(fd, chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytes).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/**
 * The incremental reader: rotations newer than the cursor whole, then the live ledger from the
 * cursor's offset while its inode holds (else from its start). A re-read row is harmless: counts are
 * sets of PR heads. With no cursor this is the seed: one streaming, step-filtered pass of the union.
 */
export async function readReviewerHealthRows(stateDir: string, cursor: ReviewerHealthCursor | null): Promise<{ rows: Array<Record<string, unknown>>; cursor: ReviewerHealthCursor }> {
  const rotations = ledgerRotationEntries(existsSync(stateDir) ? readdirSync(stateDir) : [], stateDir).map((e) => basename(e.path)).sort();
  const newest = rotations.at(-1);
  const livePath = ledgerLivePath(stateDir);
  const live = existsSync(livePath) ? statSync(livePath) : undefined;
  const prefix = live === undefined ? 0 : completeLivePrefix(livePath, live.size);
  const rotated = cursor === null || (newest !== undefined && (cursor.afterRotation === undefined || newest > cursor.afterRotation));
  const sameLive = cursor !== null && !rotated && live !== undefined && cursor.liveIno === live.ino && prefix >= cursor.liveOffset;
  const rows: Array<Record<string, unknown>> = [];
  const nothingNew = sameLive && prefix === cursor.liveOffset;
  if (!nothingNew) {
    const io = {
      readdirSync, existsSync,
      // The live file is read only to its last complete line; the next read resumes there.
      createReadStream: (path: string, options?: { start?: number }) =>
        createReadStream(path, path === livePath ? { ...options, end: Math.max(0, prefix - 1) } : options),
    };
    const stream = openLedgerUnion(stateDir, {
      step: REVIEWER_HEALTH_READ_STEPS, dedupe: false, includeLive: prefix > 0,
      ...(cursor === null ? {} : { afterRotation: rotated ? cursor.afterRotation : newest }),
      ...(sameLive ? { liveStartOffset: cursor.liveOffset } : {}),
    }, io);
    for await (const row of stream) rows.push(row);
  }
  return { rows, cursor: { ...(newest === undefined ? {} : { afterRotation: newest }), liveOffset: prefix, ...(live === undefined ? {} : { liveIno: live.ino }) } };
}

/** `rmd reviewer-heal --with-pr <n>` (or `--clear`): the operator's explicit choice of a fix PR the
 *  healed reviewer merges instead of the revert, when the revert no longer applies. */
export function reviewerHealCommand(rest: readonly string[], deps: { statePath: string; now: () => string; out: (line: string) => void; err: (line: string) => void }): number {
  const state = loadReviewerHealthState(deps.statePath);
  if (rest.includes("--clear")) {
    state.operatorHeal = null;
    saveReviewerHealthState(deps.statePath, state);
    deps.out("reviewer-heal: cleared; the healed reviewer reverts the offending merge");
    return 0;
  }
  const at = rest.indexOf("--with-pr");
  const value = at < 0 ? undefined : rest[at + 1];
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    deps.err("usage: rmd reviewer-heal --with-pr <n> | --clear");
    return 2;
  }
  state.operatorHeal = { withPr: Number(value), at: deps.now() };
  saveReviewerHealthState(deps.statePath, state);
  deps.out(`reviewer-heal: the healed reviewer merges PR #${value} on origin/main${state.incident ? ` for ${state.incident.id}` : " once an incident opens"}`);
  return 0;
}

let loadedSha: { value: string | null } | undefined;

/** The HEAD of the checkout this module was loaded from: the boot head in the daemon, the tree's sha
 *  in a fresh-tree or healed child. Read once per process; nothing moves a reviewer checkout (W1-T445). */
export function loadedReviewerCodeSha(read: () => string = () => gitIn(fileURLToPath(new URL("../../", import.meta.url)))(["rev-parse", "HEAD"])): string | null {
  if (loadedSha === undefined) {
    try {
      const sha = read().trim();
      loadedSha = { value: SHA.test(sha) ? sha : null };
    } catch {
      loadedSha = { value: null }; // deliberate: an unreadable checkout records no sha; the row stays legacy-attributable
    }
  }
  return loadedSha.value;
}

/** Test seam: forget the memoized loaded sha. */
export function resetLoadedReviewerCodeSha(): void {
  loadedSha = undefined;
}

/** The fields a review row adds so its outcome is attributable: the judging code's sha on every
 *  terminal row, and a healed child's incident id. Nothing on any other step. */
export function reviewerHealthRowFields(step: string, env: NodeJS.ProcessEnv = process.env, codeSha: () => string | null = loadedReviewerCodeSha): Record<string, unknown> {
  if (!(REVIEWER_HEALTH_STEPS as readonly string[]).includes(step) && step !== REVIEWER_SHADOW_VERDICT_STEP) return {};
  const sha = codeSha();
  const incident = str(env[REVIEWER_INCIDENT_ENV]);
  return { ...(sha === null ? {} : { reviewer_code_sha: sha }), ...(incident === undefined ? {} : { incident_id: incident }) };
}

/** A shadow review's step: renamed so no other ledger reader can take it for a real one. */
export function reviewerShadowStep(step: string, shadow: boolean): string {
  return shadow ? `${REVIEWER_SHADOW_STEP_PREFIX}${step}` : step;
}

/** The state file beside the ledger. */
export function reviewerHealthStatePath(stateDir: string): string {
  return join(stateDir, REVIEWER_HEALTH_FILENAME);
}

/** git in a directory, for the default seams. */
export function gitIn(dir: string): GitText {
  return (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe", maxBuffer: 256 * 1024 * 1024 });
}
