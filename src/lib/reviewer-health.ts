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
 *
 * W1-T13850: a posted verdict is a healthy outcome for the sha judgment, so a reviewer MODEL that fails
 * nearly everything read healthy (2026-11-19: gpt-6.2-sol failed 29 of 31 fleet code PRs). Each posted
 * verdict also counts as a pass or a FAIL for its evaluator model, and {@link judgeEvaluatorModels} judges
 * each model's FAIL rate against the other models' the same Wilson way. It is observe-only: it opens one
 * incident per diverged model and changes no route, verdict or sha judgment.
 */
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "./clock.js";
import { escalationTaskId, NEEDS_HUMAN_LABEL, renderIssueBody, tryEscalateAsync, type AsyncIssueGateway, type EscalateDeps, type Escalation } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import type { MainRepairLane, MainRepairRevertRequest } from "./main-health-rung.js";
import { upperNormalQuantile, wilsonInterval } from "./model-drift.js";
import { readReviewEvidenceRecord } from "./review-evidence-record.js";
import { DOWNGRADE_UNCLASSIFIED } from "./review-outcome-class.js";
import { REVIEW_MATERIAL_ADVANCE_PATHS, reviewAdvanceIsMaterial, reviewPathSpans, runTaskAdvanceTouchesReviewPath } from "./self-sync.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

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

/** BACKSTOP: GitHub refuses an issue body longer than this. It is the platform's bound on how much of
 *  a model's latest FAILs a model-divergence incident can quote, not a tuning choice. */
export const GITHUB_ISSUE_BODY_LIMIT = 65_536;
/** W1-T13850 — room a model-divergence incident leaves in its body for the footers tryEscalateAsync appends
 *  after rendering (the degraded-label note, the non-conforming-message note), so the body it DELIVERS stays
 *  within {@link GITHUB_ISSUE_BODY_LIMIT}. Both footers are a few hundred characters; this is their ceiling. */
export const ESCALATION_FOOTER_RESERVE = 4_096;
/** review.ts's note on a criterion the reviewer downgraded though its proof passed; the clause follows it. */
const SEMANTIC_DOWNGRADE_MARK = "(semantic downgrade):";

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
/** Passed by the daemon to a healed review child; every terminal row it writes carries the id. */
export const REVIEWER_INCIDENT_FLAG = "--reviewer-incident";

const ATTRIBUTION_STEPS = ["review.ran_from_fresh_tree", "daemon.boot"] as const;
/** Every step the health reader streams: terminal rows, their shadow twins, and attribution rows. */
export const REVIEWER_HEALTH_READ_STEPS: readonly string[] = [
  ...REVIEWER_HEALTH_STEPS,
  ...REVIEWER_HEALTH_STEPS.map((step) => `${REVIEWER_SHADOW_STEP_PREFIX}${step}`),
  `${REVIEWER_SHADOW_STEP_PREFIX}${REVIEWER_SHADOW_VERDICT_STEP}`,
  ...ATTRIBUTION_STEPS,
];

/** posted; withheld after the reviewer ran (success) or failed (provider health); refused at setup;
 *  withheld-pending: the first downgrade-unclassified hold for its head and input, which re-asks (W1-T13849). */
export type ReviewerOutcomeClass = "posted" | "withheld-success" | "withheld-failure" | "setup-refused" | "withheld-pending";

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
  /** W1-T13850: per evaluator model, each posted code-PR decision and whether it passed or failed. Keyed by
   *  the PR head and the posted review's own identity (its decision digest, else its attempt id), so a
   *  replayed row counts once and a FAIL and a later PASS at one head both count. Absent in a file written
   *  before it. */
  models?: EvaluatorModelUnits;
}

type EvaluatorModelUnits = Record<string, { provider: string | null; units: Record<string, "pass" | "fail">; counts?: { pass: number; fail: number } }>;
type EvaluatorModelCounts = Record<string, { provider: string | null; pass: number; fail: number }>;

/** W1-T13850: what an ops-catalog review publishes in place of its reasons (src/cli/commands/review.ts). */
export const REVIEW_EVIDENCE_RETAINED_ON_HOST = "detailed evidence retained on host";

/** The evaluator a posted verdict names: evaluator_provenance's routed, else served, else requested model. */
export interface ReviewerEvaluator { provider: string | null; model: string }

/** One of a model's FAILs, with the clauses its review row carries. `key` is its decision's identity
 *  (absent in a file written before it: the unit). `published` marks a review whose reasons its own
 *  publication already made public; any other FAIL's clauses stay on the host. */
export interface EvaluatorModelFail { unit: string; key?: string; sha: string; at: string; clauses: string[]; published?: true; inputDigest?: string }

/** One model's FAIL rate against the other models' pooled, over one population of reviewer code shas. */
export interface EvaluatorModelJudgment {
  model: string;
  provider: string | null;
  state: "diverged" | "healthy" | "insufficient";
  reason: string | null;
  /** Its interval lies wholly BELOW the baseline's: reported, never escalated (divergence is one-sided). */
  below: boolean;
  fail: number;
  n: number;
  baseline: { fail: number; n: number; models: string[] };
  interval: { lower: number; upper: number } | null;
  baselineInterval: { lower: number; upper: number } | null;
  z: number | null;
  /** shared-shas: the shas this model and another both carry, tracked (`shas`) and pooled away
   *  (`pooledShas`); healthy-shas: every never-regressed, never-healed sha, with the pooled-away ones' counts. */
  population: { kind: "shared-shas" | "healthy-shas"; shas: number; pooledShas: number };
}

/** One incident per model. An absent issue URL means delivery is pending. */
export interface EvaluatorModelIncident {
  id: string;
  model: string;
  provider: string | null;
  openedAt: string;
  evidence: EvaluatorModelJudgment;
  issueUrl?: string | null;
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
  pending: Record<string, Array<{ unit: string; cls: ReviewerOutcomeClass; reason: string | null; at: string; hold?: string } & VerdictFields>>;
  /** `<unit>\u0000<input digest>` → the first downgrade-unclassified hold: its sha and row time. A later hold
   *  on the same key is a second hold, which the review gate never writes while its ledger read works. */
  holds: Record<string, { sha: string; at: string }>;
  incident: ReviewerIncident | null;
  closed: Array<ReviewerIncident & { closedAt: string }>;
  /** The operator's explicit choice of a fix PR to heal with (reviewerHealCommand --with-pr <n>). */
  operatorHeal: { withPr: number; at: string } | null;
  coverage: { rows: number; unattributed: number };
  /** Eviction keeps model decisions keyed by sha so cursor re-reads dedupe and late verdicts can join. */
  pooledModelShas: Record<string, { models: EvaluatorModelUnits; healed: boolean; regressed: boolean }>;
  /** Aggregate counts from a state written before model pooling retained sha identities. */
  pooledModels?: EvaluatorModelCounts;
  pooledSharedModels?: Record<string, { shas: number; models: EvaluatorModelCounts }>;
  /** W1-T13850: model-divergence incidents pending delivery or open, by model. */
  modelIncidents: Record<string, EvaluatorModelIncident>;
  /** W1-T13850: each model's newest FAILs, newest last, no more than an issue body can quote. */
  modelFails: Record<string, EvaluatorModelFail[]>;
}

export function emptyReviewerHealthState(): ReviewerHealthState {
  return { version: REVIEWER_HEALTH_VERSION, seededAt: null, seq: 0, cursor: null, shas: {},
    pooled: { k: 0, n: 0, shas: 0 }, bootHeads: {}, pending: {}, holds: {}, incident: null, closed: [],
    operatorHeal: null, coverage: { rows: 0, unattributed: 0 }, pooledModelShas: {}, modelIncidents: {}, modelFails: {} };
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const SHA = /^[0-9a-f]{40,64}$/i;

/** A posted code-PR verdict's evaluator, its row state, the posted review's identity, a FAIL's clauses and
 *  whether its review published them (W1-T13850). */
type VerdictFields = { evaluator?: ReviewerEvaluator; state?: string; decision?: string; clauses?: string[]; published?: true; inputDigest?: string };

type Classified =
  | ({ kind: "outcome"; sha?: string; unit: string; cls: ReviewerOutcomeClass; reason: string | null;
    host: string; pr: string | null; at: string; healed: boolean; hold?: string } & VerdictFields)
  | { kind: "boot"; host: string; sha: string }
  | { kind: "fresh-tree"; host: string; pr: string; sha: string };

function prNumberOf(row: Record<string, unknown>): string | null {
  const url = str(row.pr_url);
  const match = url === undefined ? null : /\/pull\/(\d+)$/.exec(url);
  return match ? match[1]! : null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : []);

/** The clauses a FAIL row carries: each downgraded criterion's own clause, else its unmet criteria, else
 *  the failure line. */
function failClauses(row: Record<string, unknown>): string[] {
  const downgraded = strings(row.reasons).flatMap((reason) => {
    const at = reason.indexOf(SEMANTIC_DOWNGRADE_MARK);
    return at < 0 ? [] : [reason.slice(at + SEMANTIC_DOWNGRADE_MARK.length).trim()];
  });
  if (downgraded.length > 0) return downgraded;
  const unmet = strings(row.unmet_criteria).map((claim) => `unmet: ${claim}`);
  if (unmet.length > 0) return unmet;
  const line = str(row.failure_reason);
  return line === undefined ? [] : [line];
}

/** A published verdict's evaluator and state; a shadow published nothing, so it names no model. */
function verdictFields(row: Record<string, unknown>, shadow: boolean): VerdictFields {
  const provenance = row.evaluator_provenance as Record<string, unknown> | undefined;
  const model = str(provenance?.routedModel) ?? str(provenance?.servedModel) ?? str(provenance?.requestedModel);
  if (shadow || model === undefined) return {};
  const state = str(row.state);
  // The posted review's own identity: W1-T2722 gives one decision one digest (a second terminal on it is a
  // replay or a conflict hold), so two digests are two decisions; the attempt id stands in for a row without one.
  const decision = str(row.review_decision_digest) ?? str(row.review_attempt_id);
  const inputDigest = str(row.review_input_digest);
  const published = /^PR-\d+$/.test(str(row.task_id) ?? "");
  return { evaluator: { provider: str(provenance?.provider) ?? null, model }, ...(state === undefined ? {} : { state }),
    ...(decision === undefined ? {} : { decision }),
    ...(state === "failure" ? { clauses: failClauses(row), ...(published ? { published: true as const } : {}),
      ...(inputDigest === undefined ? {} : { inputDigest }) } : {}) };
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
  let verdict: VerdictFields = {};
  let hold: string | undefined;
  if (step === "review.posted" || (shadow && step === REVIEWER_SHADOW_VERDICT_STEP)) {
    // Code PRs only, and only a judgment: a plan-only PR, a reused or replayed verdict judged nothing.
    if (row.plan_only === true || row.review_reused === true || row.review_discriminated === true
      || row.status_recovered === true || row.status_confirmed === true) return undefined;
    cls = "posted";
    verdict = verdictFields(row, shadow);
  } else if (step === "review.semantic_incomplete") {
    cls = row.reviewer_outcome === "success" ? "withheld-success" : "withheld-failure";
    reason = str(row.reason) ?? null;
    // W1-T13849's hold re-asks once per head and input: pending until its unit and digest are seen twice.
    hold = cls === "withheld-success" && reason === DOWNGRADE_UNCLASSIFIED
      ? str(row.review_input_digest) ?? str(row.review_decision_digest) : undefined;
    if (hold !== undefined) cls = "withheld-pending";
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
    pr: prNumberOf(row), at: str(row.ts) ?? "", healed: !shadow && str(row.incident_id) !== undefined,
    ...(hold === undefined ? {} : { hold }), ...verdict };
}

const failChars = (f: EvaluatorModelFail): number => f.unit.length + f.at.length + f.clauses.reduce((sum, clause) => sum + clause.length, 0);
const modelValue = <T>(entries: Record<string, T> | undefined, model: string): T | undefined =>
  entries !== undefined && Object.hasOwn(entries, model) ? entries[model] : undefined;

function countModelUnits(units: Record<string, "pass" | "fail">): { pass: number; fail: number } {
  const counts = { pass: 0, fail: 0 };
  for (const verdict of Object.values(units)) counts[verdict] += 1;
  return counts;
}

/** Count a posted verdict for its evaluator model under `rec`, and remember a FAIL's clauses. */
function recordVerdict(state: ReviewerHealthState, rec: ReviewerShaRecord, outcome: Extract<Classified, { kind: "outcome" }>): void {
  if (outcome.cls !== "posted" || outcome.evaluator === undefined || (outcome.state !== "success" && outcome.state !== "failure")) return;
  const { model, provider } = outcome.evaluator;
  const owner = state.pooledModelShas?.[rec.sha] ?? rec;
  let entry = modelValue(owner.models, model);
  if (entry === undefined) {
    entry = { provider, units: {} };
    owner.models = { ...owner.models, [model]: entry };
  }
  const verdict = outcome.state === "failure" ? "fail" : "pass";
  const key = outcome.decision === undefined ? outcome.unit : `${outcome.unit}@${outcome.decision}`;
  const prior = entry.units[key];
  if (prior === verdict) return;
  const counts = entry.counts ??= countModelUnits(entry.units);
  if (prior !== undefined) counts[prior] -= 1;
  counts[verdict] += 1;
  entry.provider = provider;
  entry.units[key] = verdict;
  const fails = (modelValue(state.modelFails, model) ?? []).filter((f) => f.sha !== rec.sha || (f.key ?? f.unit) !== key);
  if (verdict === "fail") {
    fails.push({ unit: outcome.unit, key, sha: rec.sha, at: outcome.at, clauses: outcome.clauses ?? [],
      ...(outcome.published ? { published: true as const } : {}), ...(outcome.inputDigest === undefined ? {} : { inputDigest: outcome.inputDigest }) });
    fails.sort((a, b) => a.at.localeCompare(b.at));
  }
  // Never more than an issue body could quote: the oldest FAIL goes first.
  let chars = fails.reduce((sum, fail) => sum + failChars(fail), 0);
  while (fails.length > 1 && chars > GITHUB_ISSUE_BODY_LIMIT) chars -= failChars(fails.shift()!);
  state.modelFails = { ...state.modelFails, [model]: fails };
}

type ReviewerHealthLog = (step: string, extra?: Record<string, unknown>) => void;

function reportModelHealthFailure(error: unknown, log?: ReviewerHealthLog): void {
  const step = "reviewer.model_divergence_failed";
  const failure = { error: String((error as Error)?.message ?? error) };
  try {
    if (log !== undefined) { log(step, failure); return; }
  } catch (logError) {
    console.error(JSON.stringify({ step, ...failure, log_error: String((logError as Error)?.message ?? logError) }));
    return;
  }
  console.error(JSON.stringify({ step, ...failure }));
}

const isFailure = (cls: ReviewerOutcomeClass): boolean => cls === "withheld-success" || cls === "setup-refused";

function recordOutcome(state: ReviewerHealthState, sha: string, outcome: Extract<Classified, { kind: "outcome" }>, log?: ReviewerHealthLog): void {
  let rec = state.shas[sha];
  if (rec === undefined) {
    state.seq += 1;
    rec = { sha, seq: state.seq, firstSeen: outcome.at, healed: outcome.healed, units: {}, reasons: {} };
    state.shas[sha] = rec;
  } else if (!outcome.healed) {
    rec.healed = false;
  }
  try {
    recordVerdict(state, rec, outcome);
  } catch (error) {
    // SHA ingestion still owns this PR head even if its model record is unreadable.
    reportModelHealthFailure(error, log);
  }
  let cls = outcome.cls;
  if (outcome.hold !== undefined) {
    // The first hold per unit and digest is pending; another (not this row replayed) fails as any hold does.
    const key = `${outcome.unit}\u0000${outcome.hold}`;
    const first = state.holds[key];
    if (first === undefined) state.holds[key] = { sha, at: outcome.at };
    else if (first.sha !== sha || first.at !== outcome.at) cls = "withheld-success";
  }
  const prior = rec.units[outcome.unit];
  // A unit that ever posted at this sha is posted; otherwise its newest class stands. A pending hold
  // never displaces a class the unit already has.
  if (prior === "posted" || (cls === "withheld-pending" && prior !== undefined)) return;
  rec.units[outcome.unit] = cls;
  if (isFailure(cls) && (prior === undefined || prior === "withheld-pending")) {
    const reason = outcome.reason ?? cls;
    rec.reasons[reason] = (rec.reasons[reason] ?? 0) + 1;
    rec.firstFailHost ??= outcome.host;
  }
}

function pool(state: ReviewerHealthState, log?: ReviewerHealthLog): void {
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
    try {
      const archived = state.pooledModelShas?.[rec.sha];
      if (archived !== undefined) {
        archived.healed &&= rec.healed;
        archived.regressed ||= rec.regressedAt !== undefined;
      } else if (rec.models !== undefined) {
        (state.pooledModelShas ??= {})[rec.sha] = { models: rec.models, healed: rec.healed, regressed: rec.regressedAt !== undefined };
      }
    } catch (error) {
      // A failed model archive write does not keep this SHA in the tracked SHA window.
      reportModelHealthFailure(error, log);
    }
    delete state.shas[rec.sha];
    for (const [key, first] of Object.entries(state.holds)) if (first.sha === rec.sha) delete state.holds[key];
  }
}

/** Fold rows into the state. Pure apart from the state object; replaying a row changes nothing. */
export function ingestReviewerHealthRows(state: ReviewerHealthState, rows: Iterable<Record<string, unknown>>, log?: ReviewerHealthLog): string[] {
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
          recordOutcome(state, prior, { ...p, kind: "outcome", host: c.host, pr: null, healed: false }, log);
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
        recordOutcome(state, c.sha, { ...p, kind: "outcome", host: c.host, pr: c.pr, healed: false }, log);
        touched.add(c.sha);
      }
      delete state.pending[key];
      continue;
    }
    if (c.sha !== undefined) {
      recordOutcome(state, c.sha, c, log);
      touched.add(c.sha);
      continue;
    }
    // A row written before reviewer_code_sha existed: its fresh-tree row (logged by the parent after the
    // child exits) or the host's next boot says which code judged it.
    const key = `${c.host}\u0000${c.pr ?? ""}`;
    (state.pending[key] ??= []).push({ unit: c.unit, cls: c.cls, reason: c.reason, at: c.at,
      ...(c.hold === undefined ? {} : { hold: c.hold }),
      ...(c.evaluator === undefined ? {} : { evaluator: c.evaluator }), ...(c.state === undefined ? {} : { state: c.state }),
      ...(c.decision === undefined ? {} : { decision: c.decision }),
      ...(c.clauses === undefined ? {} : { clauses: c.clauses }), ...(c.published ? { published: c.published } : {}),
      ...(c.inputDigest === undefined ? {} : { inputDigest: c.inputDigest }) });
  }
  pool(state, log);
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
 *  Withheld after a reviewer FAILURE is provider health, not reviewer code: in neither. A first
 *  downgrade-unclassified hold has no outcome yet, its re-ask will: in neither. */
export function shaCounts(rec: ReviewerShaRecord): { k: number; n: number } {
  let k = 0, n = 0;
  for (const cls of Object.values(rec.units)) {
    if (cls === "withheld-failure" || cls === "withheld-pending") continue;
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

/** Each evaluator model's posted verdicts under one sha: pass and fail counts, by model. */
export function evaluatorModelCounts(state: ReviewerHealthState, sha: string): EvaluatorModelCounts {
  const models = state.pooledModelShas?.[sha]?.models ?? state.shas[sha]?.models ?? {};
  return Object.fromEntries(Object.entries(models).map(([model, entry]) =>
    [model, { provider: entry.provider, ...(entry.counts ?? countModelUnits(entry.units)) }]));
}

/**
 * Judge each evaluator model's FAIL rate against the pooled FAIL rate of every other model. The
 * population is the shas this model and another both carry when any exist, tracked or pooled away (the
 * same reviewer code judged by both), else every healthy sha (never regressed, never healed) with the
 * pooled-away ones, and the judgment names which. Diverged: the model's Wilson interval, at the family alpha split over every model
 * judged, lies wholly above the baseline's. Insufficient: no baseline, or a sample that could not show a
 * divergence even had every review failed. No count, rate or time decides. Observe-only: it reads the
 * state and writes nothing.
 */
export function judgeEvaluatorModels(state: ReviewerHealthState): EvaluatorModelJudgment[] {
  const archived = state.pooledModelShas ?? {};
  const countedModels = (counts: EvaluatorModelCounts) => Object.entries(counts).filter(([, c]) => c.pass + c.fail > 0);
  const live = Object.values(state.shas).filter((rec) => archived[rec.sha] === undefined && rec.models !== undefined)
    .map((rec) => ({ models: countedModels(evaluatorModelCounts(state, rec.sha)), healthy: !rec.healed && rec.regressedAt === undefined, shas: 1 }));
  const pooled = Object.entries(archived).map(([sha, rec]) => ({
    models: countedModels(evaluatorModelCounts(state, sha)), shas: 1,
    healthy: !rec.regressed && state.shas[sha]?.regressedAt === undefined && !(rec.healed && (state.shas[sha]?.healed ?? true)),
  }));
  const legacy = countedModels(state.pooledModels ?? {});
  const legacyShared = Object.values(state.pooledSharedModels ?? {}).map((group) => ({ shas: group.shas, models: countedModels(group.models) }));
  const models = [...new Set([...live, ...pooled, ...legacyShared, { models: legacy }].flatMap((s) => s.models.map(([model]) => model)))].sort();
  const z = upperNormalQuantile(REVIEWER_HEALTH_FAMILY_ALPHA / (2 * Math.max(1, models.length)));
  return models.map((model) => {
    const shared = (s: { models: typeof legacy }) => s.models.length > 1 && s.models.some(([name]) => name === model);
    const sharedLive = live.filter(shared);
    const sharedPooled = [...pooled, ...legacyShared].filter(shared);
    const kind = sharedLive.length > 0 || sharedPooled.length > 0 ? "shared-shas" : "healthy-shas";
    const livePopulation = kind === "shared-shas" ? sharedLive : live.filter((s) => s.healthy);
    const pooledPopulation = kind === "shared-shas" ? sharedPooled : pooled.filter((s) => s.healthy);
    const own = { fail: 0, n: 0 };
    const base = { fail: 0, n: 0, models: new Set<string>() };
    let provider: string | null = null;
    const add = (name: string, c: { provider: string | null; pass: number; fail: number }) => {
      if (c.pass + c.fail === 0) return;
      if (name === model) {
        provider = c.provider ?? provider;
        own.fail += c.fail;
        own.n += c.pass + c.fail;
        return;
      }
      base.fail += c.fail;
      base.n += c.pass + c.fail;
      base.models.add(name);
    };
    for (const group of [...livePopulation, ...pooledPopulation]) for (const [name, c] of group.models) add(name, c);
    if (kind === "healthy-shas") for (const [name, c] of legacy) add(name, c);
    const pooledShas = kind === "healthy-shas" && legacy.length > 0
      ? state.pooled.shas : pooledPopulation.reduce((sum, group) => sum + group.shas, 0);
    const population: EvaluatorModelJudgment["population"] = { kind, shas: livePopulation.length, pooledShas };
    const counted = { model, provider, fail: own.fail, n: own.n, baseline: { fail: base.fail, n: base.n, models: [...base.models].sort() }, population };
    if (own.n === 0) return { ...counted, state: "insufficient", reason: "no-outcomes", below: false, interval: null, baselineInterval: null, z: null };
    if (base.n === 0) return { ...counted, state: "insufficient", reason: "no-baseline", below: false, interval: null, baselineInterval: null, z: null };
    const interval = wilsonInterval(own.fail, own.n, z);
    const baselineInterval = wilsonInterval(base.fail, base.n, z);
    const judged = { ...counted, interval, baselineInterval, z, below: interval.upper < baselineInterval.lower };
    if (interval.lower > baselineInterval.upper) return { ...judged, state: "diverged", reason: null };
    if (wilsonInterval(own.n, own.n, z).lower <= baselineInterval.upper) return { ...judged, state: "insufficient", reason: "thin-sample" };
    return { ...judged, state: "healthy", reason: null };
  });
}

/** A model judgment as the reviewer.model_divergence row carries it. */
function evaluatorModelFields(j: EvaluatorModelJudgment): Record<string, unknown> {
  return { model: j.model, provider: j.provider, state: j.state, reason: j.reason, below: j.below, fail: j.fail, n: j.n,
    baseline_fail: j.baseline.fail, baseline_n: j.baseline.n, baseline_models: j.baseline.models, interval: j.interval,
    baseline_interval: j.baselineInterval, z: j.z, population: j.population.kind, population_shas: j.population.shas,
    pooled_shas: j.population.pooledShas };
}

/** Two intervals overlap when each starts at or before the other ends: both bounds intersect. */
const intervalsOverlap = (a: { lower: number; upper: number }, b: { lower: number; upper: number }): boolean =>
  a.lower <= b.upper && b.lower <= a.upper;

const pctRange = (i: { lower: number; upper: number } | null): string => (i === null ? "n/a" : `[${(100 * i.lower).toFixed(1)}%, ${(100 * i.upper).toFixed(1)}%]`);

/** The divergence's counts and intervals, as the issue and its closing comment name them. */
function evaluatorModelEvidenceText(j: EvaluatorModelJudgment): string {
  const population = j.population.kind === "shared-shas"
    ? `the ${j.population.shas + j.population.pooledShas} reviewer code sha(s) it shares with another model${j.population.pooledShas > 0 ? ` (${j.population.pooledShas} pooled)` : ""}`
    : `${j.population.shas} healthy reviewer code sha(s)${j.population.pooledShas > 0 ? ` and ${j.population.pooledShas} pooled` : ""} (no sha carried it beside another model)`;
  return `Evaluator model ${j.model}${j.provider === null ? "" : ` (${j.provider})`} failed ${j.fail} of ${j.n} posted code-PR verdicts ` +
    `(Wilson ${pctRange(j.interval)} at z=${j.z === null ? "n/a" : j.z.toFixed(2)}), against ${j.baseline.fail} of ${j.baseline.n} ` +
    `for ${j.baseline.models.join(", ") || "no other model"} (${pctRange(j.baselineInterval)}), over ${population}.`;
}

/** The divergence as an escalation: the evidence, the model's latest FAILs with their clauses (newest
 *  first, as many as the issue body holds; a FAIL whose review kept its reasons on the host is named with
 *  {@link REVIEW_EVIDENCE_RETAINED_ON_HOST} instead), and the action. It asks for no ruling and changes no route. */
export function evaluatorModelDivergenceEscalation(incident: EvaluatorModelIncident, fails: readonly EvaluatorModelFail[]): Escalation {
  const build = (shown: readonly EvaluatorModelFail[]): Escalation => ({
    class: "MANUAL",
    taskId: incident.id,
    summary: `Reviewer model divergence: ${incident.model} fails code PRs far above the other reviewer models`,
    detail: [
      evaluatorModelEvidenceText(incident.evidence),
      "",
      `Its latest FAILs, newest first (${shown.length} of ${fails.length} remembered), with the clauses the review rows carry:`,
      ...[...shown].reverse().flatMap((f) => [`- ${f.unit} (reviewer code ${f.sha.slice(0, 12)}, ${f.at})`,
        ...(f.published ? f.clauses : [REVIEW_EVIDENCE_RETAINED_ON_HOST]).map((c) => `  - ${c}`)]),
      "",
      "Observe-only (W1-T13850): routing, verdicts, the reviewer-sha judgment and the healed tree are unchanged.",
    ].join("\n"),
    options: [{ label: "File a calibration task", detail: `File a task to calibrate ${incident.model}'s review against the known-answer set (W1-T12145) and the replay (W1-T13448).`, kind: { type: "operator-only" } }],
    recommendation: "File a calibration task",
    consequence: `Reviews keep running on ${incident.model} as routed, and its FAILs keep holding PRs.`,
  });
  let shown = [...fails];
  while (shown.length > 0 && renderIssueBody(build(shown)).length > GITHUB_ISSUE_BODY_LIMIT - ESCALATION_FOOTER_RESERVE) shown = shown.slice(1);
  return build(shown);
}

/** Filed reviews can supply their own verified reasons. The ops producer removes those reasons. */
async function publishedModelFails(fails: readonly EvaluatorModelFail[], readEvidence: typeof readReviewEvidenceRecord, log: ReviewerHealthLog): Promise<EvaluatorModelFail[]> {
  const published: EvaluatorModelFail[] = [];
  for (const fail of fails) {
    if (fail.published || fail.inputDigest === undefined || fail.clauses.length === 0) {
      published.push(fail);
      continue;
    }
    const delimiter = fail.unit.lastIndexOf("#");
    const prUrl = fail.unit.slice(0, delimiter);
    const headSha = fail.unit.slice(delimiter + 1);
    let clauses: string[] = [];
    try {
      const evidence = await readEvidence({ prUrl, headSha, reviewInputDigest: fail.inputDigest, reviewState: "failure" });
      if (evidence?.row.reasons.length) {
        const approved = new Set(failClauses(evidence.row));
        clauses = fail.clauses.filter((clause) => approved.has(clause));
      }
    } catch (error) {
      log("reviewer.model_divergence_evidence_unavailable", { review_unit: fail.unit, error: String((error as Error)?.message ?? error) });
    }
    published.push(clauses.length === 0 ? fail : { ...fail, clauses, published: true });
  }
  return published;
}

export interface OffendingMerge { sha: string; subject: string; pr: number | null; reason: string }
/** git in one checkout, off the event loop (the daemon review path must not block it). */
export type GitText = (args: string[]) => Promise<string>;

/** The src/lib modules the review path imports: src/lib/review.ts's own relative imports, and the
 *  import lines run-task.ts's review path reaches. #12954 added required-semantic-review.ts, which
 *  REVIEW_MATERIAL_ADVANCE_PATHS does not list. */
export async function reviewPathImportedModules(git: GitText, sha: string): Promise<string[]> {
  const found = new Set<string>();
  const show = async (path: string): Promise<string | undefined> => {
    try {
      return await git(["show", `${sha}:${path}`]);
    } catch {
      return undefined; // deliberate: a path absent at this sha imports nothing
    }
  };
  for (const match of ((await show("src/lib/review.ts")) ?? "").matchAll(/from\s+["']\.\/([^"']+)\.js["']/g)) found.add(`src/lib/${match[1]}.ts`);
  const runTask = await show("src/run-task.ts");
  const spans = runTask === undefined ? undefined : reviewPathSpans(runTask);
  if (runTask !== undefined && spans !== undefined && "spans" in spans) {
    const reached = runTask.split("\n").filter((_line, index) => spans.spans.some(([from, to]) => index + 1 >= from && index + 1 <= to));
    for (const match of reached.join("\n").matchAll(/from\s+["']\.\/(lib\/[^"']+)\.js["']/g)) found.add(`src/${match[1]}.ts`);
  }
  return [...found].sort();
}

/** The first first-parent commit in healthy..regressed whose own diff is review-material. A squash
 *  merge and a merge commit both diff against their first parent. undefined: none qualifies. */
export async function findOffendingMerge(git: GitText, healthySha: string, regressedSha: string): Promise<OffendingMerge | undefined> {
  const commits = (await git(["rev-list", "--first-parent", "--reverse", `${healthySha}..${regressedSha}`])).split("\n").map((s) => s.trim()).filter(Boolean);
  const widened = new Set<string>([...REVIEW_MATERIAL_ADVANCE_PATHS, ...(await reviewPathImportedModules(git, regressedSha))]);
  for (const sha of commits) {
    const parent = `${sha}^1`;
    const paths = (await git(["diff", "--name-only", parent, sha])).split("\n").map((s) => s.trim()).filter(Boolean);
    // run-task.ts counts only when a hunk meets its review path (W1-T4469), never as a whole file.
    const material = paths.filter((path) => path !== "src/run-task.ts" && (widened.has(path) || reviewAdvanceIsMaterial([path])));
    let reason: string | undefined;
    if (material.length > 0) reason = `touches ${material.join(", ")}`;
    else if (paths.includes("src/run-task.ts")) {
      const touched = runTaskAdvanceTouchesReviewPath(await prefetchedRunTaskGit(git, parent, sha), parent, sha);
      if (touched.touchesReviewPath) reason = `src/run-task.ts: ${touched.reason}`;
    }
    if (reason === undefined) continue;
    const subject = (await git(["log", "-1", "--format=%s", sha])).trim();
    const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(subject)?.[1];
    return { sha, subject, pr: pr === undefined ? null : Number(pr), reason };
  }
  return undefined;
}

/** runTaskAdvanceTouchesReviewPath reads three things through a synchronous git: the run-task.ts
 *  diff and both blobs. They are read here off the event loop first and served from memory; an
 *  unread one throws, which that function already reads as "touches the review path". */
async function prefetchedRunTaskGit(git: GitText, from: string, to: string): Promise<(args: string[]) => string> {
  const reads = [["diff", "-U0", `${from}..${to}`, "--", "src/run-task.ts"], ["show", `${from}:src/run-task.ts`], ["show", `${to}:src/run-task.ts`]];
  const served = new Map<string, string>();
  for (const args of reads) {
    try {
      served.set(args.join("\u0000"), await git(args));
    } catch {
      // deliberate: an unread side stays unserved, and the sync reader below throws for it
    }
  }
  return (args) => {
    const text = served.get(args.join("\u0000"));
    if (text === undefined) throw new Error(`git ${args.join(" ")} was not read`);
    return text;
  };
}

/** A healed reviewer tree: origin/main with the offending merge reverted (or an operator-named fix PR
 *  merged) on top, so its merge-base with origin/main IS origin/main. */
export type HealedTree =
  | { state: "ready"; path: string; sha: string; originMainSha: string; patch: "revert" | "with-pr"; withPr?: number }
  | { state: "empty"; originMainSha: string }
  | { state: "conflict"; originMainSha: string; reason: string; paths: string[]; remembered?: true }
  | { state: "unavailable"; originMainSha: string | null; reason: string };

/** Project a failed healed-tree result into the route's stable ledger/log fields. */
export function reviewerHealedTreeUnavailableFields(healed: Exclude<HealedTree, { state: "ready" | "empty" }>): Record<string, unknown> {
  return {
    state: healed.state,
    reason: healed.reason,
    ...(healed.state === "conflict" ? { conflict_paths: healed.paths, ...(healed.remembered ? { remembered: true } : {}) } : {}),
    origin_main_sha: healed.originMainSha,
  };
}

const HEAL_IDENTITY = ["-c", "user.name=remudero reviewer-heal", "-c", "user.email=reviewer-heal@remudero.invalid"];
const healedMemo = new Map<string, { path: string; sha: string }>();
const healedConflictMemo = new Map<string, { reason: string; paths: string[] }>();

/** Build (or reuse) the healed tree for `offendingSha` at origin/main. Never an old head, never an
 *  engine tree: every route here starts from origin/main. */
export async function buildHealedReviewerTree(
  repoDir: string,
  offendingSha: string,
  /** Cuts (or proves) a clean detached tree at `sha` under `prefix`: the fresh-tree helper. */
  cut: (prefix: string, sha: string) => string | Promise<string>,
  /** Removes a tree this builder cut and could not finish. */
  remove: (tree: string) => void | Promise<void>,
  opts: { withPr?: number } = {},
): Promise<HealedTree> {
  // Every git here is the hardened leaf, off the event loop: the daemon checkout's, and the tree's own.
  const git = gitIn(repoDir);
  const treeGit = (tree: string, args: string[]) => hostWorktreeGitAsync(tree, args);
  let originMainSha: string;
  try {
    await git(["fetch", "--quiet", "origin", "main"]);
    originMainSha = (await git(["rev-parse", "origin/main"])).trim();
  } catch (error) {
    return { state: "unavailable", originMainSha: null, reason: `origin/main unreadable: ${String((error as Error)?.message ?? error)}` };
  }
  const patch = opts.withPr === undefined ? "revert" as const : "with-pr" as const;
  const key = `${patch}:${opts.withPr ?? offendingSha}:${originMainSha}`;
  const knownConflict = healedConflictMemo.get(key);
  if (knownConflict !== undefined) return { state: "conflict", originMainSha, ...knownConflict, remembered: true };
  const known = healedMemo.get(key);
  if (known !== undefined) {
    try {
      const head = (await treeGit(known.path, ["rev-parse", "HEAD"])).trim();
      const parent = (await treeGit(known.path, ["rev-parse", "HEAD^1"])).trim();
      const dirty = (await treeGit(known.path, ["status", "--porcelain", "-uno"])).trim();
      if (head === known.sha && parent === originMainSha && dirty === "") {
        return { state: "ready", path: known.path, sha: known.sha, originMainSha, patch, ...(opts.withPr === undefined ? {} : { withPr: opts.withPr }) };
      }
    } catch {
      // deliberate: an unreadable cached tree is rebuilt below
    }
    healedMemo.delete(key);
    await Promise.resolve(remove(known.path)).catch(() => undefined /* deliberate: an unremoved tree is reaped with the reviewer's other trees */);
  }
  // A merge commit reverts against its first parent, as findOffendingMerge diffed it; a squash merge has one parent.
  let mainline: string[] = [];
  if (opts.withPr === undefined) {
    try {
      await git(["merge-base", "--is-ancestor", offendingSha, originMainSha]);
      mainline = (await git(["rev-list", "--parents", "-n", "1", offendingSha])).trim().split(/\s+/).length > 2 ? ["-m", "1"] : [];
    } catch {
      return { state: "unavailable", originMainSha, reason: `${offendingSha.slice(0, 12)} is not on origin/main ${originMainSha.slice(0, 12)}` };
    }
  }
  let tree: string;
  try {
    tree = await cut(`healed-${(opts.withPr === undefined ? offendingSha : `pr${opts.withPr}`).slice(0, 12)}`, originMainSha);
  } catch (error) {
    return { state: "unavailable", originMainSha, reason: `healed tree could not be cut: ${String((error as Error)?.message ?? error)}` };
  }
  try {
    if (opts.withPr === undefined) {
      await treeGit(tree, [...HEAL_IDENTITY, "revert", "--no-commit", ...mainline, offendingSha]);
      // Already undone on main (a revert PR merged): reverting again stages nothing, so the healed tree IS origin/main.
      const staged = (await treeGit(tree, ["diff", "--cached", "--name-only"])).trim();
      if (staged === "") {
        await treeGit(tree, ["revert", "--abort"]);
        await remove(tree);
        return { state: "empty", originMainSha };
      }
      await treeGit(tree, [...HEAL_IDENTITY, "commit", "--quiet", "--no-verify", "-m", `Revert ${offendingSha.slice(0, 12)} (reviewer-heal, W1-T10269)`]);
    } else {
      await treeGit(tree, ["fetch", "--quiet", "origin", `refs/pull/${opts.withPr}/head`]);
      await treeGit(tree, [...HEAL_IDENTITY, "merge", "--no-ff", "--no-edit", "--no-verify", "FETCH_HEAD"]);
    }
  } catch (error) {
    let paths: string[] = [];
    try {
      paths = (await treeGit(tree, ["diff", "--name-only", "--diff-filter=U"])).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      // deliberate: the conflict stands without its path list
    }
    try {
      await treeGit(tree, opts.withPr === undefined ? ["revert", "--abort"] : ["merge", "--abort"]);
    } catch {
      // deliberate: the tree is removed next either way
    }
    try {
      await remove(tree);
    } catch {
      // deliberate: an unremoved tree is reaped with the reviewer's other trees
    }
    const what = opts.withPr === undefined ? `the revert of ${offendingSha.slice(0, 12)}` : `PR #${opts.withPr}`;
    const reason = `${what} does not apply cleanly on origin/main ${originMainSha.slice(0, 12)}: ${String((error as Error)?.message ?? error).split("\n")[0]}`;
    healedConflictMemo.set(key, { reason, paths });
    return { state: "conflict", originMainSha, paths, reason };
  }
  const sha = (await treeGit(tree, ["rev-parse", "HEAD"])).trim();
  healedMemo.set(key, { path: tree, sha });
  return { state: "ready", path: tree, sha, originMainSha, patch, ...(opts.withPr === undefined ? {} : { withPr: opts.withPr }) };
}

/** Test seam: forget every healed tree this process built. */
export function resetHealedReviewerTrees(): void {
  healedMemo.clear();
  healedConflictMemo.clear();
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
      { label: "Heal with a fix PR", detail: `Record the fix PR as \`operatorHeal\` in state/reviewer-health.json (reviewerHealCommand) to review from origin/main merged with it instead of the revert${pr === null ? "" : ` of #${pr}`}.`, kind: { type: "operator-only" } },
      { label: "Close as a false alarm", detail: "Close this issue and the revert PR; the detector keeps measuring and closes the incident itself once the reviewer reads healthy.", kind: { type: "operator-only" } },
    ],
    recommendation: conflict ? "Heal with a fix PR" : "Let the revert PR merge",
    headDedup: "independent",
    consequence: conflict
      ? "Reviews keep running on the regressed reviewer, as before this incident, until a fix merges."
      : "Reviews keep running from the healed tree until the incident closes; nothing merges without review.",
  };
}

export type ReviewerHealthDecision =
  | { route: "normal"; reason: string; current: ReviewerShaJudgment | null }
  | { route: "healed"; incident: ReviewerIncident; shadow: boolean; withPr: number | null; current: ReviewerShaJudgment | null };

/** An absent, unparseable or older-version file reads as empty, so the next evaluation re-seeds
 *  from the ledger union rather than judging on counts it cannot trust. */
export function loadReviewerHealthState(path: string): ReviewerHealthState {
  const text = readOptional(path);
  if (text === undefined) return emptyReviewerHealthState();
  let parsed: Partial<ReviewerHealthState>;
  try {
    parsed = JSON.parse(text) as Partial<ReviewerHealthState>;
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

/**
 * Read the reviewer's new outcomes, judge them, open or close the incident, and say how THIS review
 * routes. `originMainSha` is the current reviewer: origin/main's code. The incident's effects reuse
 * the shapes their lanes already have — the escalation's {@link EscalateDeps} (its issue gateway also
 * closes the issue), the red-main {@link MainRepairLane} (the revert PR, its read and its close), the
 * {@link Clock} port — and git, the ledger reader and the log are plain functions.
 */
export async function evaluateReviewerHealthNow(
  input: { originMainSha: string | null; readEvidence?: typeof readReviewEvidenceRecord },
  statePath: string,
  readRows: (cursor: ReviewerHealthCursor | null) => Promise<{ rows: Iterable<Record<string, unknown>>; cursor: ReviewerHealthCursor }>,
  git: GitText,
  escalation: EscalateDeps<AsyncIssueGateway>,
  lane: MainRepairLane,
  log: ReviewerHealthLog,
  clock: Pick<Clock, "iso">,
): Promise<ReviewerHealthDecision> {
  const state = loadReviewerHealthState(statePath);
  const read = await readRows(state.cursor);

  const isAncestor = (ancestor: string, descendant: string): Promise<boolean> =>
    git(["merge-base", "--is-ancestor", ancestor, descendant]).then(() => true, () => false);

  const newestHealthyAncestor = async (rec: ReviewerShaRecord): Promise<ReviewerShaRecord | undefined> => {
    const earlier = Object.values(state.shas)
      .filter((other) => other.seq < rec.seq && !other.healed && other.regressedAt === undefined)
      .sort((a, b) => b.seq - a.seq);
    for (const other of earlier) {
      // An unknown sha (a PR head, a pruned tree) is never an ancestor, so never the healthy side.
      if (judgeReviewerSha(state, other.sha).state === "healthy" && await isAncestor(other.sha, rec.sha)) return other;
    }
    return undefined;
  };

  const findBlame = async (rec: ReviewerShaRecord) => {
    const lastHealthy = await newestHealthyAncestor(rec);
    let offending: OffendingMerge | undefined;
    let offendingUnavailable: string | undefined;
    if (lastHealthy === undefined) offendingUnavailable = "no healthy reviewer code sha precedes the regression";
    else {
      try {
        offending = await findOffendingMerge(git, lastHealthy.sha, rec.sha);
        if (offending === undefined) offendingUnavailable = `no review-material merge in ${lastHealthy.sha.slice(0, 12)}..${rec.sha.slice(0, 12)}`;
      } catch (error) {
        offendingUnavailable = `merge history unreadable: ${String((error as Error)?.message ?? error)}`;
      }
    }
    return { lastHealthy, offending, offendingUnavailable };
  };
  const openIncident = async (rec: ReviewerShaRecord, judgment: ReviewerShaJudgment, live: boolean): Promise<void> => {
    const signature = signatureOf(rec);
    const bootHeadSha = rec.firstFailHost === undefined ? null : state.bootHeads[rec.firstFailHost] ?? null;
    const prior = [...state.closed].reverse().find((c) => c.signature.some((s) => signature.includes(s)));
    let incident: ReviewerIncident;
    if (prior !== undefined) {
      const { closedAt: _closedAt, revertPrUrl: _url, revertRefused: _refused,
        offendingUnavailable: _oldUnavailable, ...rest } = prior;
      void [_closedAt, _url, _refused, _oldUnavailable];
      const blame = await findBlame(rec);
      const priorOffenderInRange = prior.offending !== null && blame.lastHealthy !== undefined
        && await isAncestor(blame.lastHealthy.sha, prior.offending.sha) && await isAncestor(prior.offending.sha, rec.sha);
      incident = { ...rest, id: `reviewer-regression-${rec.sha.slice(0, 12)}`, openedAt: clock.iso(),
        regressedSha: rec.sha, regressedSeq: rec.seq, bootHeadSha,
        lastHealthySha: blame.lastHealthy?.sha ?? null,
        offending: priorOffenderInRange ? prior.offending : blame.offending ?? null,
        ...(priorOffenderInRange || blame.offendingUnavailable === undefined ? {} : { offendingUnavailable: blame.offendingUnavailable }),
        signature: [...new Set([...rest.signature, ...signature])].sort(), evidence: judgment, reopenedFrom: prior.id };
      state.closed = state.closed.filter((c) => c.id !== prior.id);
    } else {
      const blame = await findBlame(rec);
      incident = { id: `reviewer-regression-${rec.sha.slice(0, 12)}`, openedAt: clock.iso(), regressedSha: rec.sha, regressedSeq: rec.seq,
        bootHeadSha, lastHealthySha: blame.lastHealthy?.sha ?? null, offending: blame.offending ?? null,
        ...(blame.offendingUnavailable === undefined ? {} : { offendingUnavailable: blame.offendingUnavailable }), signature, evidence: judgment };
    }
    state.incident = incident;
    if (!live) return;
    log("reviewer.regression_opened", {
      incident_id: incident.id, regressed_reviewer_code_sha: rec.sha, boot_head_sha: bootHeadSha,
      last_healthy_reviewer_code_sha: incident.lastHealthySha, offending_sha: incident.offending?.sha ?? null,
      offending_pr: incident.offending?.pr ?? null, offending_reason: incident.offending?.reason ?? incident.offendingUnavailable ?? null,
      signature: incident.signature, k: judgment.k, n: judgment.n, baseline_k: judgment.baseline.k, baseline_n: judgment.baseline.n,
      interval: judgment.interval, baseline_interval: judgment.baselineInterval, z: judgment.z,
      ...(incident.reopenedFrom ? { reopened_from: incident.reopenedFrom } : {}),
    });
  };

  /** The incident's outward effects: the assigned issue, then one revert PR of the offending merge. */
  const raiseIncident = async (incident: ReviewerIncident): Promise<void> => {
    // tryEscalateAsync never rejects: a failed filing is ledgered as escalation.failed and reads null.
    incident.issueUrl = await tryEscalateAsync(reviewerRegressionEscalation(incident), escalation);
    if (incident.offending === null || incident.revertPrUrl !== undefined) return;
    try {
      const outcome = await lane.openRevertPr(reviewerRegressionRevertRequest(incident as ReviewerIncident & { offending: OffendingMerge }));
      if ("prUrl" in outcome) {
        incident.revertPrUrl = outcome.prUrl;
        return;
      }
      incident.revertRefused = { reason: outcome.refused, paths: [...(outcome.conflictPaths ?? [])] };
    } catch (error) {
      incident.revertRefused = { reason: String((error as Error)?.message ?? error), paths: [] };
    }
    // A conflicting revert is ledgered with its paths; the healed reviewer (or the escalation) still covers it.
    log("main-repair.revert_refused", { incident_id: incident.id, offending_sha: incident.offending.sha,
      reason: incident.revertRefused.reason, conflict_paths: incident.revertRefused.paths });
  };

  const closeIncident = async (judgment: ReviewerShaJudgment, live: boolean): Promise<void> => {
    const incident = state.incident!;
    state.closed = [...state.closed, { ...incident, closedAt: clock.iso() }].slice(-MAX_CLOSED_REVIEWER_INCIDENTS);
    state.incident = null;
    if (!live) return;
    let revertPr: "open" | "closed" | "merged" | "unread" | null = null;
    if (incident.revertPrUrl !== undefined) {
      try {
        revertPr = lane.readPr ? (await lane.readPr(incident.revertPrUrl)).state : "unread";
      } catch {
        revertPr = "unread"; // deliberate: an unread PR is left open, never closed blind
      }
    }
    const comment = `Reviewer code ${judgment.sha.slice(0, 12)} (origin/main) is back inside its baseline: ${judgment.k} of ${judgment.n} ` +
      `not posted against ${judgment.baseline.k} of ${judgment.baseline.n} before (W1-T10269).`;
    if (incident.revertPrUrl !== undefined && revertPr === "open" && lane.closePr) {
      try {
        await lane.closePr(incident.revertPrUrl, `${comment} A fix made this revert unnecessary.`);
      } catch (error) {
        log("reviewer.regression_revert_close_failed", { incident_id: incident.id, revert_pr: incident.revertPrUrl, error: String((error as Error)?.message ?? error) });
      }
    }
    if (incident.issueUrl && escalation.issues.closeWithComment) {
      try {
        await escalation.issues.closeWithComment(incident.issueUrl, comment);
      } catch (error) {
        log("reviewer.regression_issue_close_failed", { incident_id: incident.id, issue_url: incident.issueUrl, error: String((error as Error)?.message ?? error) });
      }
    }
    log("reviewer.regression_closed", { incident_id: incident.id, current_reviewer_code_sha: judgment.sha, k: judgment.k, n: judgment.n,
      baseline_k: judgment.baseline.k, baseline_n: judgment.baseline.n, revert_pr: incident.revertPrUrl ?? null, revert_pr_state: revertPr });
  };

  /** W1-T13850, observe-only: judge every evaluator model, ledger the judgment, open one incident per newly
   *  diverged model and close one whose interval overlaps its baseline again. It reads the counts and
   *  writes only `modelIncidents`: no route, verdict, sha judgment or reviewer-sha incident. */
  const judgeModels = async (state: ReviewerHealthState): Promise<void> => {
    const judged = judgeEvaluatorModels(state);
    log("reviewer.model_divergence", { models: judged.map(evaluatorModelFields), diverged: judged.filter((j) => j.state === "diverged").map((j) => j.model) });
    for (const j of judged) {
      const pending = modelValue(state.modelIncidents, j.model);
      const diverged = j.state === "diverged";
      const overlap = j.interval !== null && j.baselineInterval !== null && intervalsOverlap(j.interval, j.baselineInterval);
      if (diverged && pending?.issueUrl) continue;
      if (!diverged && (pending === undefined || !overlap)) continue;
      const incident: EvaluatorModelIncident = pending ?? { id: `reviewer-model-divergence-${j.model}`, model: j.model,
        provider: j.provider, openedAt: clock.iso(), evidence: j };
      state.modelIncidents = { ...state.modelIncidents, [j.model]: incident };

      if (!incident.issueUrl) {
        try {
          const open = await escalation.issues.listOpen?.(NEEDS_HUMAN_LABEL) ?? [];
          // The incident's task ID follows the model even if the issue is retitled or the latest FAIL changes.
          incident.issueUrl = open.find((issue) => escalationTaskId(issue.body) === incident.id)?.url ?? null;
          if (diverged && !incident.issueUrl) {
            const fails = await publishedModelFails(modelValue(state.modelFails, j.model) ?? [], input.readEvidence ?? readReviewEvidenceRecord, log);
            incident.issueUrl = await tryEscalateAsync(evaluatorModelDivergenceEscalation(incident, fails), {
              ...escalation, issues: { ...escalation.issues, listOpen: async () => open },
            });
          }
        } catch (error) {
          // Leave the issue pending when the lookup or delivery fails so the next evaluation can retry.
          reportModelHealthFailure(error, log);
          continue;
        }
      }
      if (diverged) {
        if (incident.issueUrl) log("reviewer.model_divergence_opened", { incident_id: incident.id, ...evaluatorModelFields(j), issue_url: incident.issueUrl });
        continue;
      }
      const { issueUrl } = incident;
      if (issueUrl) {
        if (!escalation.issues.closeWithComment) continue;
        try {
          await escalation.issues.closeWithComment(issueUrl, `Back inside its baseline (W1-T13850). ${evaluatorModelEvidenceText(j)}`);
        } catch (error) {
          log("reviewer.model_divergence_issue_close_failed", { incident_id: incident.id, issue_url: issueUrl, error: String((error as Error)?.message ?? error) });
          continue;
        }
      }
      delete state.modelIncidents[j.model];
      if (issueUrl) log("reviewer.model_divergence_closed", { incident_id: incident.id, ...evaluatorModelFields(j), issue_url: issueUrl });
    }
  };

  /** Ingest `rows`, judge the shas they touched (oldest first, so the onset departs first), then test the
   *  open incident's close against `current`. `live` false is the seed: history replayed, effects off. */
  const step = async (rows: Iterable<Record<string, unknown>>, current: string | null, live: boolean): Promise<void> => {
    const touched = ingestReviewerHealthRows(state, rows, log);
    const candidates = touched.map((sha) => state.shas[sha])
      .filter((rec): rec is ReviewerShaRecord => rec !== undefined && !rec.healed && rec.regressedAt === undefined)
      .sort((a, b) => a.seq - b.seq);
    for (const rec of candidates) {
      const judgment = judgeReviewerSha(state, rec.sha);
      if (judgment.state !== "regressed") continue;
      rec.regressedAt = clock.iso();
      if (state.incident === null) {
        await openIncident(rec, judgment, live);
        if (live) await raiseIncident(state.incident!);
        continue;
      }
      // A later sha failing the same way joins the open incident: its reasons extend the signature a
      // recurrence after a close is matched on, so the recurrence keeps the original blame.
      state.incident.signature = [...new Set([...state.incident.signature, ...signatureOf(rec)])].sort();
      if (live) log("reviewer.regression_extended", { incident_id: state.incident.id, reviewer_code_sha: rec.sha,
        k: judgment.k, n: judgment.n, signature: state.incident.signature });
    }
    if (state.incident !== null && current !== null) {
      const back = returnedToBaseline(state, state.incident, current);
      if (back.returned) await closeIncident(back.judgment, live);
    }
  };

  if (state.cursor === null) {
    // THE SEED replays history row by row with effects off, so a deploy mid-outage inherits the
    // outage's incident (and its blame) rather than judging today against a poisoned baseline.
    for (const row of read.rows) await step([row], newestReviewerSha(state), false);
    state.seededAt = clock.iso();
    log("reviewer.health_seeded", { shas: Object.keys(state.shas).length, pooled_shas: state.pooled.shas,
      rows: state.coverage.rows, unattributed: state.coverage.unattributed, open_incident: state.incident?.id ?? null,
      closed_incidents: state.closed.map((c) => c.id) });
    // History's incident is raised only when today's reviewer is itself regressed; otherwise it is
    // carried as closed, so a recurrence of its failure signature reopens it with the original blame.
    if (state.incident !== null && (input.originMainSha === null || judgeReviewerSha(state, input.originMainSha).state !== "regressed")) {
      log("reviewer.regression_carried", { incident_id: state.incident.id, offending_sha: state.incident.offending?.sha ?? null,
        signature: state.incident.signature, reason: "today's reviewer code is not judged regressed" });
      await closeIncident(judgeReviewerSha(state, input.originMainSha ?? state.incident.regressedSha), false);
    }
    if (state.incident !== null) {
      const incident = state.incident;
      log("reviewer.regression_opened", { incident_id: incident.id, regressed_reviewer_code_sha: incident.regressedSha,
        boot_head_sha: incident.bootHeadSha, last_healthy_reviewer_code_sha: incident.lastHealthySha,
        offending_sha: incident.offending?.sha ?? null, offending_pr: incident.offending?.pr ?? null,
        offending_reason: incident.offending?.reason ?? incident.offendingUnavailable ?? null, signature: incident.signature,
        k: incident.evidence.k, n: incident.evidence.n, baseline_k: incident.evidence.baseline.k, baseline_n: incident.evidence.baseline.n,
        from_seed: true });
      await raiseIncident(incident);
    }
  } else {
    await step(read.rows, input.originMainSha, true);
  }
  // Observe-only (W1-T13850): the SHA state is saved and the route decided BEFORE the model judgment runs, so a
  // slow or failing model issue lookup never delays or changes either. `modelIncidents` is the judgment's own
  // field: this save keeps the copy on disk, and the judgment below merges only that field back.
  state.cursor = read.cursor;
  state.modelIncidents = loadReviewerHealthState(statePath).modelIncidents;
  saveReviewerHealthState(statePath, state);
  const current = input.originMainSha === null ? null : judgeReviewerSha(state, input.originMainSha);
  const incident = state.incident;
  const decision: ReviewerHealthDecision = incident === null
    ? { route: "normal", reason: "no open reviewer-regression incident", current }
    : incident.offending === null
      ? { route: "normal", reason: `incident ${incident.id} names no offending merge to revert`, current }
      // Shadow the current reviewer only while its own sha has no judgment yet: judged regressed, it stops;
      // returned to baseline, the incident has closed above.
      : { route: "healed", incident, shadow: input.originMainSha !== null && current?.state !== "regressed",
        withPr: state.operatorHeal?.withPr ?? null, current };
  queueModelJudgment(statePath, async () => {
    const models = loadReviewerHealthState(statePath);
    await judgeModels(models);
    const latest = loadReviewerHealthState(statePath);
    latest.modelIncidents = models.modelIncidents;
    saveReviewerHealthState(statePath, latest);
  }, log);
  return decision;
}

/** W1-T13850 — the model judgments of one state file, run one at a time AFTER their evaluation returned. */
const modelJudgments = new Map<string, Promise<void>>();

function queueModelJudgment(statePath: string, job: () => Promise<void>, log: ReviewerHealthLog): void {
  const prior = modelJudgments.get(statePath) ?? Promise.resolve();
  // The judgment's own failure (a ledger append, a lookup) is ledgered, and when even that append fails it goes to
  // stderr; it never reaches the route already returned.
  const run = prior.then(job).catch((error: unknown) => reportModelHealthFailure(error, log));
  modelJudgments.set(statePath, run);
  void run.finally(() => { if (modelJudgments.get(statePath) === run) modelJudgments.delete(statePath); });
}

/** Test seam and shutdown hook: wait until every queued model judgment of `statePath` has settled. */
export async function settleReviewerModelJudgment(statePath: string): Promise<void> {
  for (let pending = modelJudgments.get(statePath); pending !== undefined; pending = modelJudgments.get(statePath)) {
    await pending;
    if (modelJudgments.get(statePath) === pending) break;
  }
}

/** The revert PR request for the main-repair lane: the outcome-mix evidence, not failing checks. */
export function reviewerRegressionRevertRequest(incident: ReviewerIncident & { offending: OffendingMerge }): MainRepairRevertRequest {
  return {
    branch: "main", headSha: incident.regressedSha, offendingSha: incident.offending.sha,
    ...(incident.offending.pr === null ? {} : { offendingPr: incident.offending.pr }),
    failingChecks: [], whyFixInsufficient: "no fix had returned the reviewer to its baseline",
    reason: { kind: "reviewer-regression", incidentId: incident.id, evidence: reviewerRegressionEvidenceText(incident) },
  };
}

/** The newest non-healed sha the history names: the seed's stand-in for "origin/main then". */
function newestReviewerSha(state: ReviewerHealthState): string | null {
  const newest = Object.values(state.shas).filter((rec) => !rec.healed).sort((a, b) => b.seq - a.seq)[0];
  return newest?.sha ?? null;
}

const chains = new Map<string, Promise<unknown>>();
const seeding = new Map<string, Promise<unknown>>();

/**
 * The daemon's entry: evaluations of one state file run one at a time (reviews run in parallel),
 * and the first boot's seed — a whole-union read — runs in the background while reviews route as
 * today. Any failure routes normally and is ledgered; it never blocks a review.
 */
export async function evaluateReviewerHealth(
  ...args: Parameters<typeof evaluateReviewerHealthNow>
): Promise<ReviewerHealthDecision> {
  const [, statePath, , , , , log] = args;
  if (seeding.has(statePath)) return { route: "normal", reason: "reviewer health is seeding from the ledger union", current: null };
  if (loadReviewerHealthState(statePath).cursor === null) {
    const seed = evaluateReviewerHealthNow(...args).catch((error: unknown) => {
      log("reviewer.health_unavailable", { phase: "seed", error: String((error as Error)?.message ?? error) });
    }).finally(() => seeding.delete(statePath));
    seeding.set(statePath, seed);
    return { route: "normal", reason: "reviewer health is seeding from the ledger union", current: null };
  }
  const prior = chains.get(statePath) ?? Promise.resolve();
  const run = prior.then(() => evaluateReviewerHealthNow(...args), () => evaluateReviewerHealthNow(...args));
  // The chain only orders the next evaluation; this caller awaits `run` below and ledgers its failure.
  chains.set(statePath, run.catch(() => undefined /* deliberate: ordered, not swallowed; see the await below */));
  try {
    return await run;
  } catch (error) {
    log("reviewer.health_unavailable", { phase: "evaluate", error: String((error as Error)?.message ?? error) });
    return { route: "normal", reason: `reviewer health unavailable: ${String((error as Error)?.message ?? error)}`, current: null };
  }
}

/** Test seam: wait for a background seed of `statePath` to settle. */
export async function settleReviewerHealthSeed(statePath: string): Promise<void> {
  await seeding.get(statePath);
}

/** The live ledger's inode and where its last complete line ends, from ONE open descriptor, so the
 *  size and the bytes read belong to the same file. An absent live ledger has no prefix. */
function liveLedgerPrefix(path: string): { live: { ino: number } | undefined; prefix: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { live: undefined, prefix: 0 };
    throw error;
  }
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    const { ino, size } = fstatSync(fd);
    let end = size;
    let newline = -1;
    let start = 0;
    while (end > 0 && newline < 0) {
      start = Math.max(0, end - chunk.length);
      newline = chunk.subarray(0, readSync(fd, chunk, 0, end - start, start)).lastIndexOf(0x0a);
      end = start;
    }
    return { live: { ino }, prefix: newline < 0 ? 0 : start + newline + 1 };
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
  let names: string[] = [];
  try {
    names = readdirSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; // an absent state dir is an empty ledger
  }
  const rotations = ledgerRotationEntries(names, stateDir).map((e) => basename(e.path)).sort();
  const newest = rotations.at(-1);
  const livePath = ledgerLivePath(stateDir);
  const { live, prefix } = liveLedgerPrefix(livePath);
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

/** The operator's explicit choice of a fix PR the healed reviewer merges instead of the revert, when the
 *  revert no longer applies (`--with-pr <n>`, or `--clear`). Its `rmd reviewer-heal` verb is not registered
 *  yet: a new CLI-only verb needs a row in the console-parity baseline, the operator's call. */
export function reviewerHealCommand(rest: readonly string[], statePath: string, clock: Pick<Clock, "iso">,
  out: (line: string) => void, err: (line: string) => void): number {
  const state = loadReviewerHealthState(statePath);
  if (rest.includes("--clear")) {
    state.operatorHeal = null;
    saveReviewerHealthState(statePath, state);
    out("reviewer-heal: cleared; the healed reviewer reverts the offending merge");
    return 0;
  }
  const at = rest.indexOf("--with-pr");
  const value = at < 0 ? undefined : rest[at + 1];
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    err("usage: reviewer-heal --with-pr <n> | --clear");
    return 2;
  }
  state.operatorHeal = { withPr: Number(value), at: clock.iso() };
  saveReviewerHealthState(statePath, state);
  out(`reviewer-heal: the healed reviewer merges PR #${value} on origin/main${state.incident ? ` for ${state.incident.id}` : " once an incident opens"}`);
  return 0;
}

let loadedSha: { value: string | null } | undefined;

/** The HEAD of the checkout this module was loaded from: the boot head in the daemon, the tree's sha
 *  in a fresh-tree or healed child. Read once per process; nothing moves a reviewer checkout (W1-T445). */
export function loadedReviewerCodeSha(read: () => string = () => checkoutHeadSha(fileURLToPath(new URL("../../", import.meta.url)))): string | null {
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

/** A checkout's HEAD sha read from its git files, spawning nothing: `.git` (a dir, or a worktree's
 *  `gitdir:` pointer file), HEAD, then the ref it names in the worktree or common dir or packed-refs. */
export function checkoutHeadSha(root: string): string {
  // Each file is read once and its absence classified from the read's own error: no check-then-read.
  const dotGit = join(root, ".git");
  const pointer = readOptional(dotGit);
  let gitDir = dotGit;
  if (pointer !== undefined) {
    const named = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (!named) throw new Error(`${dotGit} names no gitdir`);
    gitDir = resolve(root, named[1]!.trim());
  }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (ref === undefined) throw new Error(`${gitDir}/HEAD names neither a sha nor a ref`);
  const commonDir = readOptional(join(gitDir, "commondir"));
  const common = commonDir === undefined ? gitDir : resolve(gitDir, commonDir.trim());
  for (const dir of [gitDir, common]) {
    const loose = readOptional(join(dir, ref));
    if (loose !== undefined) return loose.trim();
  }
  const line = (readOptional(join(common, "packed-refs")) ?? "").split("\n").find((l) => l.endsWith(` ${ref}`));
  if (line === undefined) throw new Error(`${ref} is not resolvable in ${common}`);
  return line.split(" ")[0]!;
}

/** A file's text, or undefined when there is no FILE there (absent, or a directory). Any other
 *  failure — permissions, I/O — is thrown: it is not an absence. */
function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Test seam: forget the memoized loaded sha. */
export function resetLoadedReviewerCodeSha(): void {
  loadedSha = undefined;
}

/** The fields a review row adds so its outcome is attributable: the judging code's sha on every
 *  terminal row, and a healed child's incident id. Nothing on any other step. */
export function reviewerHealthRowFields(step: string, incidentId: string | undefined, codeSha: () => string | null = loadedReviewerCodeSha): Record<string, unknown> {
  if (!(REVIEWER_HEALTH_STEPS as readonly string[]).includes(step) && step !== REVIEWER_SHADOW_VERDICT_STEP) return {};
  const sha = codeSha();
  const incident = str(incidentId);
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

/** git in a directory, for the default seams: the hardened leaf, off the event loop. */
export function gitIn(dir: string): GitText {
  return (args) => hostWorktreeGitAsync(dir, args, { maxBuffer: 256 * 1024 * 1024 });
}
