/**
 * lib/field-trials-flow.ts — W1-T4574: FIELD TRIALS FROM OUR OWN FLOW.
 *
 * An operator-invoked, resumable snapshot joining each opted-in repository's audited three-form
 * ledger union with its GitHub history (field-trials-github.ts) into five OBSERVATIONAL families —
 * model adoption, the automation funnel, PR repair/correctness signals, censored flow/recovery
 * times and learning-loop yield — by source x week x task class. The families, their denominators
 * and what is deferred are specified in docs/research/model-evidence-program.md ("Field trials
 * from our own flow"). No family estimates a causal effect; `causalClaims` says so.
 *
 * INVARIANTS. A merge is never a deployment (only a successful GitHub deployment or a daemon boot
 * at or after the merge commit is); a green check never moves a PR into a correctness bucket;
 * unknown, censored and missing-join are counted, never zero. Partitions carry an input hash, so a
 * late page or a ledger repair rebuilds only what it touches.
 *
 * PRIVACY. The snapshot is private. {@link buildFieldTrialsRelease} is the only export: consent
 * checked per repository, salted pseudonyms, small cells withheld, and REFUSED if any private join
 * key appears. Falsifier: test/field-trials-flow.test.ts (merge-as-deployment reddens it).
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "./benchmark-verified-outcome.js";
import { fixedClock, systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { DEFAULT_MAX_PAGES, ghApiFetch, ingestFieldTrialsGithub, parseGithubStore, RUN_BRANCH_RE,
  type FieldTrialsGithubPass, type FieldTrialsGithubStore, type GithubCursor, type GithubPageFetch,
  type GithubPull, type GithubRepoStore } from "./field-trials-github.js";
import { fingerprintLedgerLine, ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import { deriveReviewFindingOutcomes, type FindingOutcomeReport, type VerifiedFindingEvidence } from "./review-finding-outcomes.js";
import { deriveVerifiedReviewFindingEvidence, readReviewFindingEvidence, type FindingEvidenceInput, type FindingEvidenceReport } from "./review-finding-evidence.js";
import type { TaskCaseFile } from "./task-case-file.js";

export const FIELD_TRIALS_FLOW_VERSION = "field-trials-flow-v1" as const;
export const FIELD_TRIALS_RELEASE_VERSION = "field-trials-release-v1" as const;
export const FIELD_TRIALS_CONSENT_VERSION = "field-trials-consent-v1" as const;
export const FIELD_TRIALS_MANIFEST_VERSION = "field-trials-release-manifest-v1" as const;

/** PRIMARY CONTROL: days after a merge in which a revert or a same-task follow-up merge is an adverse
 *  signal. Until the window elapses the PR reads window-immature (censored), never correct. */
export const FOLLOW_UP_WINDOW_DAYS = 14;
/** PRIMARY CONTROL: the smallest count a released cell may show. A cell below it is withheld whole;
 *  a count below it inside a larger cell is withheld, with a complementary withholding when a sum
 *  would otherwise reveal it. */
export const SMALL_CELL_MIN = 5;

export const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
/** A task class or other stratum label allowed into a release verbatim; anything else reads `other`. */
export const SAFE_LABEL_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** A model name allowed into a release verbatim; anything else reads `other`. */
export const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const DAY_MS = 86_400_000;
const FLOW_STEPS = new Set(["run.start", "worker.assignment", "worker.attempt", "verdict", "pr.opened", "review.posted", "review.reviewer", "review.finding",
  "fix.dispatch", "escalation.issue_opened", "daemon.boot", "evidence_coverage.filed"]);
const STAGES = ["eligible", "assigned", "worker", "pr", "review", "merge", "deployment", "verified"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? fixedClock(Date.parse(value)).iso() : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The Monday (UTC) that starts the ISO week holding `at`; the time stratum of every family. */
export function periodOf(at: string | null): string {
  if (at === null) return "unknown";
  const days = Math.floor(Date.parse(at) / DAY_MS);
  // 1970-01-01 was a Thursday: three days after the Monday that starts its ISO week.
  return fixedClock((days - (days + 3) % 7) * DAY_MS).iso().slice(0, 10);
}

export interface FlowRow {
  fingerprint: string;
  ts: string | null;
  step: string;
  host: string | null;
  actor: string | null;
  taskId: string | null;
  runId: string | null;
  assignmentId: string | null;
  requestedModel: string | null;
  selectedModel: string | null;
  servedModel: string | null;
  taskClass: string | null;
  risk: string | null;
  workLane: string | null;
  stackPinned: { harness: boolean; prompt: boolean; tool: boolean; scorer: boolean; environment: boolean } | null;
  costUsd: number | null;
  billingMode: "api" | "subscription" | null;
  success: boolean | null;
  prRepo: string | null;
  prNumber: number | null;
  headSha: string | null;
  verdict: string | null;
  action: string | null;
  reviewModel: string | null;
  findingId: string | null;
  findingCategory: string | null;
  findingAnchorStatus: "verified" | "unsupported" | null;
  findingCaptureState: "unavailable" | "zero" | "captured" | "partial" | null;
  findingInvalidCount: number | null;
  findingDroppedCount: number | null;
  findingVerifiedCount: number | null;
  findingUnverifiedCount: number | null;
}

function flowRelevant(row: Record<string, unknown>): boolean {
  const step = String(row.step);
  return FLOW_STEPS.has(step) || step.endsWith(".scorecard") || step.endsWith(".gardener_judged")
    || (row.actor === "operator" && typeof row.task_id === "string");
}

/** Only these fields leave the raw row; prompts, bodies and free text never enter the snapshot. */
export function projectFlowRow(row: Record<string, unknown>, fingerprint: string): FlowRow {
  const assignment = record(row.worker_assignment);
  const benchmark = record(row.benchmark_run);
  const work = record(benchmark?.work);
  const taskClass = record(work?.taskClass);
  const risk = record(work?.risk);
  const lane = record(record(work?.shape)?.lane);
  const stack = record(benchmark?.stack);
  const evaluator = record(row.evaluator_provenance);
  const nonnegativeInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : null;
  const pinned = (field: string) => record(stack?.[field])?.state === "observed";
  const url = PR_URL_RE.exec(String(row.pr_url ?? ""));
  return {
    fingerprint, ts: iso(row.ts), step: String(row.step), host: text(row.host), actor: text(row.actor),
    taskId: text(row.task_id), runId: text(row.run_id),
    assignmentId: text(assignment?.id) ?? text(row.selection_assignment_id),
    requestedModel: text(record(assignment?.requested)?.model), selectedModel: text(record(assignment?.selected)?.model),
    servedModel: text(row.served_model),
    taskClass: taskClass?.state === "observed" ? text(taskClass.value) : text(row.task_class),
    risk: risk?.state === "observed" ? text(risk.value) : text(row.risk),
    workLane: lane?.state === "observed" ? text(lane.value) : text(row.worker_rung),
    stackPinned: assignment ? { harness: pinned("harnessRevision"), prompt: pinned("promptRevision"),
      tool: pinned("toolRevision"), scorer: pinned("scorerRevision"), environment: pinned("environmentRevision") } : null,
    costUsd: typeof row.total_cost_usd === "number" && Number.isFinite(row.total_cost_usd) && row.total_cost_usd >= 0
      ? row.total_cost_usd : typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0
        ? row.cost_usd : null,
    billingMode: row.billing_mode === "api" || row.billing_mode === "subscription" ? row.billing_mode : null,
    success: typeof row.success === "boolean" ? row.success : null,
    prRepo: url?.[1] ?? null, prNumber: url ? Number(url[2]) : Number.isSafeInteger(row.pr_number) ? row.pr_number as number : null,
    headSha: text(row.head_sha), verdict: text(row.verdict), action: text(row.action),
    reviewModel: text(evaluator?.servedModel) ?? text(evaluator?.requestedModel) ?? (row.step === "review.finding" ? text(row.served_model) : null),
    findingId: text(row.finding_id), findingCategory: text(row.category),
    findingAnchorStatus: row.capture_state === "verified" || row.capture_state === "unsupported" ? row.capture_state : null,
    findingCaptureState: ["unavailable", "zero", "captured", "partial"].includes(String(row.finding_capture_state))
      ? row.finding_capture_state as FlowRow["findingCaptureState"] : null,
    findingInvalidCount: nonnegativeInteger(row.finding_invalid_count), findingDroppedCount: nonnegativeInteger(row.finding_dropped_count),
    findingVerifiedCount: nonnegativeInteger(row.finding_verified_count), findingUnverifiedCount: nonnegativeInteger(row.finding_unverified_count),
  };
}

export interface FieldTrialsLedgerRead {
  state: "observed" | "observed-partial" | "unavailable";
  reason: string | null;
  forms: { gzip: number; plain: number; live: number };
  malformedRows: number;
  duplicateRows: number;
  futureRows: number;
  unreadSources: number;
  newestTs: string | null;
  rows: FlowRow[];
}

export function unavailableLedger(reason: string): FieldTrialsLedgerRead {
  return { state: "unavailable", reason, forms: { gzip: 0, plain: 0, live: 0 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: null, rows: [] };
}

/** The audited three-form union: every form counted, exact replayed lines counted as duplicates once. */
export async function readFieldTrialsLedger(stateDir: string, nowMs = systemClock.now()): Promise<FieldTrialsLedgerRead> {
  let names: string[];
  try { names = readdirSync(stateDir); }
  catch {
    const reason = "ledger-source-unreadable";
    return unavailableLedger(reason);
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const forms = { gzip: rotations.filter((entry) => entry.form === "gzip").length,
    plain: rotations.filter((entry) => entry.form === "plain").length,
    live: names.includes(basename(ledgerLivePath(stateDir))) ? 1 : 0 };
  if (rotations.length + forms.live === 0) return { ...unavailableLedger("ledger-source-missing"), forms };
  const seen = new Set<string>();
  const rows: FlowRow[] = [];
  let malformedRows = 0;
  let duplicateRows = 0;
  let futureRows = 0;
  let unreadSources = 0;
  let newestTs: string | null = null;
  for await (const row of openLedgerUnion(stateDir, {
    dedupe: false,
    onUnreadArchive: () => { unreadSources += 1; },
    onUnreadLive: () => { unreadSources += 1; },
    onMalformedRow: () => { malformedRows += 1; },
    onAcceptedRecord: (accepted, raw) => {
      const fingerprint = fingerprintLedgerLine(raw);
      if (seen.has(fingerprint)) { duplicateRows += 1; return; }
      seen.add(fingerprint);
      const ts = iso(accepted.ts);
      // A stray clock-forward row cannot create a future cohort or advance the source watermark.
      if (ts !== null && Date.parse(ts) > nowMs + 5 * 60_000) { futureRows += 1; return; }
      if (ts !== null && (newestTs === null || ts > newestTs)) newestTs = ts;
      if (flowRelevant(accepted)) rows.push(projectFlowRow(accepted, fingerprint));
    },
  })) void row;
  const partial = unreadSources > 0 ? "ledger-source-unreadable" : malformedRows > 0 ? "ledger-source-malformed"
    : futureRows > 0 ? "ledger-source-future-dated" : null;
  return { state: partial ? "observed-partial" : "observed", reason: partial, forms, malformedRows, duplicateRows,
    futureRows, unreadSources, newestTs, rows };
}

export interface FieldTrialsSource {
  label: string;
  repo: string;
  ledger: FieldTrialsLedgerRead;
}

type StageState =
  | { state: "reached"; at: string | null; humanTouched: boolean }
  | { state: "missing-join"; reason: string }
  | { state: "censored" }
  | { state: "not-reached" };

/** Kaplan-Meier: the time by which a share `q` of units reached the event, open work censored. `null` = not reached. */
export function kaplanMeierQuantile(events: ReadonlyArray<{ ms: number; observed: boolean }>, q: number): number | null {
  const sorted = [...events].sort((a, b) => a.ms - b.ms || Number(b.observed) - Number(a.observed));
  let survival = 1;
  let atRisk = sorted.length;
  for (let i = 0; i < sorted.length;) {
    const at = sorted[i]!.ms;
    let observed = 0;
    let leaving = 0;
    for (; i < sorted.length && sorted[i]!.ms === at; i += 1) { leaving += 1; if (sorted[i]!.observed) observed += 1; }
    survival *= 1 - observed / atRisk;
    if (observed > 0 && survival <= 1 - q + 1e-12) return at;
    atRisk -= leaving;
  }
  return null;
}

type Unit = { key: string; digest: string };
type Partition<C> = { inputHash: string; cells: C };

type FunnelUnit = Unit & { stages: Record<(typeof STAGES)[number], StageState> };

export interface FunnelStageCell {
  denominator: number;
  reached: number;
  missingJoin: number;
  censored: number;
  humanTouched: number;
  missingReasons: Record<string, number>;
}

/** Each stage's denominator is the tasks that reached the stage it follows. The PR follows the
 *  assignment and review and merge both follow the PR, so a PR with no recorded worker call, or a
 *  merge with no observed review, stays visible rather than falling out of the funnel. */
const STAGE_FOLLOWS: Record<(typeof STAGES)[number], (typeof STAGES)[number] | null> = { eligible: null, assigned: "eligible",
  worker: "assigned", pr: "assigned", review: "pr", merge: "pr", deployment: "merge", verified: "merge" };

function funnelCells(units: FunnelUnit[]): { tasks: number; stages: Record<string, FunnelStageCell> } {
  const stages: Record<string, FunnelStageCell> = {};
  for (const stage of STAGES) {
    const follows = STAGE_FOLLOWS[stage];
    const entering = follows === null ? units : units.filter((unit) => unit.stages[follows].state === "reached");
    const cell: FunnelStageCell = { denominator: entering.length, reached: 0, missingJoin: 0, censored: 0, humanTouched: 0, missingReasons: {} };
    for (const unit of entering) {
      const state = unit.stages[stage];
      if (state.state === "reached") { cell.reached += 1; if (state.humanTouched) cell.humanTouched += 1; }
      else if (state.state === "missing-join") { cell.missingJoin += 1; cell.missingReasons[state.reason] = (cell.missingReasons[state.reason] ?? 0) + 1; }
      else if (state.state === "censored") cell.censored += 1;
    }
    stages[stage] = cell;
  }
  return { tasks: units.length, stages };
}

type Duration = { ms: number; observed: boolean } | { excluded: "stopped" | "missing-join" | "no-start" };
type FlowUnit = Unit & { toPr: Duration; toMerge: Duration; toDeploy: Duration; commitToDeploy: Duration;
  retries: number; selfRepair: boolean; escalated: boolean };

export interface DurationCell {
  observed: number;
  censored: number;
  excluded: Record<string, number>;
  p50Ms: number | null;
  p90Ms: number | null;
}

function durationCell(values: Duration[]): DurationCell {
  const events = values.flatMap((value) => "ms" in value ? [value] : []);
  const excluded: Record<string, number> = {};
  for (const value of values) if ("excluded" in value) excluded[value.excluded] = (excluded[value.excluded] ?? 0) + 1;
  return { observed: events.filter((event) => event.observed).length, censored: events.filter((event) => !event.observed).length,
    excluded, p50Ms: kaplanMeierQuantile(events, 0.5), p90Ms: kaplanMeierQuantile(events, 0.9) };
}

function flowCells(units: FlowUnit[]) {
  return { tasks: units.length, toPr: durationCell(units.map((unit) => unit.toPr)),
    toMerge: durationCell(units.map((unit) => unit.toMerge)), toDeploy: durationCell(units.map((unit) => unit.toDeploy)),
    commitToDeploy: durationCell(units.map((unit) => unit.commitToDeploy)),
    retries: { none: units.filter((unit) => unit.retries === 0).length, one: units.filter((unit) => unit.retries === 1).length,
      twoOrMore: units.filter((unit) => unit.retries >= 2).length },
    selfRepair: units.filter((unit) => unit.selfRepair).length, escalated: units.filter((unit) => unit.escalated).length };
}

type RepairBucket = "adverse-signal" | "no-adverse-signal-in-window" | "window-immature" | "unknown";
type RepairUnit = Unit & { firstPass: string; reviewRounds: number | null; repairCommits: number | null; fixDispatches: number;
  reverted: boolean; followUp: boolean; bucket: RepairBucket };

function repairCells(units: RepairUnit[]) {
  const count = (predicate: (unit: RepairUnit) => boolean) => units.filter(predicate).length;
  const firstPass: Record<string, number> = {};
  for (const unit of units) firstPass[unit.firstPass] = (firstPass[unit.firstPass] ?? 0) + 1;
  const observed = units.filter((unit) => unit.reviewRounds !== null);
  return { mergedPrs: units.length, firstPass,
    reviewRounds: { observed: observed.length, total: observed.reduce((sum, unit) => sum + unit.reviewRounds!, 0) },
    repairCommits: { observed: observed.length, total: observed.reduce((sum, unit) => sum + unit.repairCommits!, 0) },
    fixDispatches: units.reduce((sum, unit) => sum + unit.fixDispatches, 0),
    reverted: count((unit) => unit.reverted), followUp: count((unit) => unit.followUp),
    correctness: { "adverse-signal": count((unit) => unit.bucket === "adverse-signal"),
      "no-adverse-signal-in-window": count((unit) => unit.bucket === "no-adverse-signal-in-window"),
      "window-immature": count((unit) => unit.bucket === "window-immature"), unknown: count((unit) => unit.bucket === "unknown") },
    incidents: { state: "unavailable" as const, reason: "no-incident-source" } };
}

type AdoptionUnit = Unit & { requested: string | null; selected: string | null; served: string | null; servedMissing: string | null };

function adoptionCells(units: AdoptionUnit[]) {
  const tally = (values: (string | null)[]) => {
    const out: Record<string, number> = {};
    for (const value of values) if (value !== null) out[value] = (out[value] ?? 0) + 1;
    return out;
  };
  return { assignments: units.length, requested: tally(units.map((unit) => unit.requested)),
    selected: tally(units.map((unit) => unit.selected)), served: tally(units.map((unit) => unit.served)),
    servedUnavailable: tally(units.map((unit) => unit.servedMissing)) };
}

type LearningUnit = Unit & { kind: "gardener-pr" | "evidence-followup" | "judgement";
  outcome: "accepted" | "declined" | "open" | "unknown" | "credit" | "debit"; reverted: boolean };

function learningCells(units: LearningUnit[]) {
  const count = (outcome: LearningUnit["outcome"]) => units.filter((unit) => unit.outcome === outcome).length;
  return { proposals: units.filter((unit) => unit.kind !== "judgement").length, accepted: count("accepted"),
    declined: count("declined"), open: count("open"), unknown: count("unknown"), credits: count("credit"), debits: count("debit"),
    followUpDefects: units.filter((unit) => unit.reverted).length,
    humanEffort: { state: "unavailable" as const, reason: "no-independent-human-effort-estimate" } };
}

function withDigest<U extends Omit<Unit, "digest">>(unit: U): U & Unit {
  return { ...unit, digest: sha256(JSON.stringify(unit)) };
}

/** Recompute a partition only when the hash of its units changed; count what was rebuilt and reused. */
function rebuildFamily<U extends Unit, C>(family: string, units: U[], prior: Record<string, Partition<C>> | undefined,
  compute: (units: U[]) => C, rebuilt: string[], reused: { count: number }): Record<string, Partition<C>> {
  const groups = new Map<string, U[]>();
  for (const unit of units) groups.set(unit.key, [...(groups.get(unit.key) ?? []), unit]);
  const out: Record<string, Partition<C>> = {};
  for (const key of [...groups.keys()].sort()) {
    const inputHash = sha256(groups.get(key)!.map((unit) => unit.digest).sort().join("\n"));
    const before = prior?.[key];
    if (before?.inputHash === inputHash) { out[key] = before; reused.count += 1; continue; }
    out[key] = { inputHash, cells: compute(groups.get(key)!) };
    rebuilt.push(`${family}:${key}`);
  }
  return out;
}

export interface ModelTransition {
  source: string;
  host: string;
  model: string;
  firstRequestedAt: string | null;
  firstSelectedAt: string | null;
  firstServedAt: string | null;
  /** Assignments that selected this model but were served another one (a fallback), kept visible. */
  servedOtherwise: number;
  runtimeBoot: { state: "observed"; at: string; headSha: string } | { state: "unavailable"; reason: string };
  sourceMerge: { state: "observed"; at: string } | { state: "unavailable"; reason: string };
}

export interface FieldTrialsFlowSnapshot {
  version: typeof FIELD_TRIALS_FLOW_VERSION;
  asOf: string;
  state: "observed" | "observed-partial" | "unavailable";
  reasons: string[];
  observational: true;
  causalClaims: "none";
  followUpWindowDays: number;
  /** Private assignment metadata coverage by source and selected model; absent revisions stay absent. */
  assignmentTelemetry: { source: string; selectedModel: string; assignments: number; taskClass: number; risk: number;
    workLane: number; harnessPinned: number; promptPinned: number; toolPinned: number; scorerPinned: number;
    environmentPinned: number; attemptReceipts: number; nonStarterAssignments: number; costMissingAssignments: number;
    apiCostEstimateUsd: number; subscriptionNotionalUsd: number }[];
  /** Private finding-quality evidence. Never copied into the public release. No trusted labels are inferred from GitHub workflow state. */
  reviewFindingOutcomes: FindingOutcomeReport;
  reviewFindingEvidence: FindingEvidenceReport;
  provenance: { sources: { label: string; repo: string; ledger: Omit<FieldTrialsLedgerRead, "rows"> & { rows: number };
    github: { pulls: GithubCursor | null; commits: GithubCursor | null; deployments: GithubCursor | null;
      prs: number; commitsKnown: number; deploymentsKnown: number } }[];
    githubPass: FieldTrialsGithubPass | null };
  /** Private: PR numbers and task ids stay in this local snapshot and never reach a release. */
  links: { prs: number; matched: number; ambiguous: number; unmatched: number;
    byPath: { trailer: number; branch: number; ledger: number; multiplePaths: number };
    ledgerPrNotInGithub: number; githubOnlyTasks: number;
    unmatchedPrs: { source: string; number: number }[]; ambiguousPrs: { source: string; number: number; tasks: string[] }[] };
  families: {
    adoption: Record<string, Partition<ReturnType<typeof adoptionCells>>>;
    transitions: ModelTransition[];
    funnel: Record<string, Partition<ReturnType<typeof funnelCells>>>;
    repair: Record<string, Partition<ReturnType<typeof repairCells>>>;
    flow: Record<string, Partition<ReturnType<typeof flowCells>>>;
    learning: Record<string, Partition<ReturnType<typeof learningCells>>>;
  };
  rebuild: { rebuiltPartitions: string[]; reusedPartitions: number };
  /** Every private join key this snapshot saw, so a release can be refused if one leaks. */
  privateKeys: string[];
}

export interface FieldTrialsFlowInput {
  asOf: string;
  sources: FieldTrialsSource[];
  github: FieldTrialsGithubStore;
  githubPass?: FieldTrialsGithubPass;
  prior?: FieldTrialsFlowSnapshot;
  caseFiles?: readonly TaskCaseFile[];
  /** Only an independently authenticated caller may supply this; the default ledger/GitHub path supplies none. */
  verifiedFindingEvidence?: readonly VerifiedFindingEvidence[];
  findingEvidence?: FindingEvidenceInput;
}

function stratum(value: string | null): string {
  return value ?? "unknown";
}

function earliest(values: (string | null)[]): string | null {
  return values.filter((value): value is string => value !== null).sort()[0] ?? null;
}

function spanMs(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return ms >= 0 ? ms : null;
}

type SourceContext = {
  label: string;
  repo: string;
  store: GithubRepoStore | undefined;
  rows: FlowRow[];
  asOf: string;
  boots: FlowRow[];
  mergedByNumber: Map<number, GithubPull>;
  revertedAt: Map<number, string>;
};

/** Deployment is observed only from a successful GitHub deployment or a daemon boot at or after the
 *  merge commit on main. A merge alone never reaches this stage. */
function deploymentOf(ctx: SourceContext, pull: GithubPull): StageState {
  const deployments = Object.values(ctx.store?.deployments ?? {}).filter((item) => item.status.state === "success");
  if (deployments.length === 0 && ctx.boots.length === 0) return { state: "missing-join", reason: "no-deployment-evidence" };
  const mergeAt = pull.mergeCommitSha === null ? undefined : ctx.store?.commits[pull.mergeCommitSha];
  if (mergeAt === undefined) return { state: "missing-join", reason: "merge-commit-not-in-history" };
  const commits = ctx.store!.commits;
  const times = [
    ...deployments.filter((item) => item.sha !== null && (commits[item.sha] ?? "") >= mergeAt)
      .map((item) => "at" in item.status && item.status.at !== null ? item.status.at : item.createdAt),
    ...ctx.boots.filter((boot) => boot.headSha !== null && (commits[boot.headSha] ?? "") >= mergeAt && boot.ts !== null
      && boot.ts >= pull.mergedAt!).map((boot) => boot.ts),
  ];
  const at = earliest(times);
  return at === null ? { state: "censored" } : { state: "reached", at, humanTouched: false };
}

function touchedBy(operatorTimes: string[], at: string | null): boolean {
  return operatorTimes.some((ts) => at === null || ts <= at);
}

function evaluateTask(ctx: SourceContext, taskId: string, rows: FlowRow[], pulls: GithubPull[],
  caseFiles: readonly TaskCaseFile[] | undefined, taskClass: string | null): { funnel: FunnelUnit; flow: FlowUnit } {
  const at = (step: string) => earliest(rows.filter((row) => row.step === step).map((row) => row.ts));
  const start = earliest(rows.filter((row) => row.step === "run.start" || row.step === "worker.assignment").map((row) => row.ts))
    ?? earliest(rows.map((row) => row.ts));
  const operatorTimes = rows.filter((row) => row.actor === "operator" && row.ts !== null).map((row) => row.ts!);
  const humanReviewed = pulls.some((pull) => pull.detail.state === "observed" && pull.detail.reviews.human > 0);
  const reached = (when: string | null, human = false): StageState => ({ state: "reached", at: when, humanTouched: human || touchedBy(operatorTimes, when) });
  const assignments = rows.filter((row) => row.step === "worker.assignment");
  const calls = rows.filter((row) => (row.step === "worker.attempt" || row.step === "verdict") && row.success !== null);
  const githubRead = ctx.store !== undefined && ctx.store.cursors.pulls.state !== "never-read" && ctx.store.cursors.pulls.state !== "unavailable";
  const ledgerPr = rows.some((row) => row.step === "pr.opened");
  const merged = pulls.filter((pull) => pull.mergedAt !== null).sort((a, b) => a.mergedAt!.localeCompare(b.mergedAt!));
  const open = pulls.some((pull) => pull.state === "open");
  const stages = {} as FunnelUnit["stages"];
  stages.eligible = reached(start);
  stages.assigned = assignments.length > 0 ? reached(at("worker.assignment")) : { state: "not-reached" };
  stages.worker = calls.length > 0 ? reached(earliest(calls.map((row) => row.ts)))
    : rows.some((row) => row.step === "verdict") ? { state: "not-reached" } : { state: "censored" };
  stages.pr = pulls.length > 0 ? reached(earliest(pulls.map((pull) => pull.createdAt)))
    : !githubRead ? { state: "missing-join", reason: "github-unavailable" }
      : ledgerPr ? { state: "missing-join", reason: "ledger-pr-not-in-github" }
        : rows.some((row) => row.step === "verdict") ? { state: "not-reached" } : { state: "censored" };
  const reviewAt = at("review.posted");
  stages.review = reviewAt !== null || pulls.some((pull) => pull.detail.state === "observed" && pull.detail.reviews.total > 0)
    ? reached(reviewAt, humanReviewed)
    : pulls.every((pull) => pull.detail.state !== "observed") ? { state: "missing-join", reason: "pr-detail-unavailable" }
      : open ? { state: "censored" } : { state: "not-reached" };
  stages.merge = merged.length > 0 ? reached(merged[0]!.mergedAt, humanReviewed) : open ? { state: "censored" } : { state: "not-reached" };
  const deployed = merged.length > 0 ? deploymentOf(ctx, merged[0]!) : { state: "not-reached" as const };
  stages.deployment = deployed.state === "reached" ? reached(deployed.at, humanReviewed) : deployed;
  stages.verified = verifiedStage(taskId, rows, caseFiles, ctx.asOf, humanReviewed, operatorTimes);
  const duration = (state: StageState, from: string | null): Duration => {
    if (from === null) return { excluded: "no-start" };
    if (state.state === "reached") return state.at === null ? { excluded: "missing-join" } : { ms: spanMs(from, state.at) ?? 0, observed: true };
    if (state.state === "censored") return { ms: spanMs(from, ctx.asOf) ?? 0, observed: false };
    return { excluded: state.state === "missing-join" ? "missing-join" : "stopped" };
  };
  const lastCommit = merged[0]?.detail.state === "observed" ? merged[0].detail.commits.lastCommittedAt : null;
  const key = `${ctx.label}|${periodOf(start)}|${stratum(taskClass)}`;
  const funnel = withDigest({ key, stages });
  const flow = withDigest({ key, toPr: duration(stages.pr, start), toMerge: duration(stages.merge, start),
    toDeploy: duration(stages.deployment, start),
    commitToDeploy: merged.length === 0 ? { excluded: "stopped" as const } : duration(stages.deployment, lastCommit),
    retries: Math.max(0, new Set(rows.map((row) => row.runId).filter((id) => id !== null)).size - 1),
    selfRepair: rows.some((row) => row.step === "fix.dispatch"), escalated: rows.some((row) => row.step === "escalation.issue_opened") });
  return { funnel, flow };
}

/** Verification is W1-T4608's join over a case-file snapshot. No merge, check or deployment awards it. */
function verifiedStage(taskId: string, rows: FlowRow[], caseFiles: readonly TaskCaseFile[] | undefined, asOf: string,
  humanReviewed: boolean, operatorTimes: string[]): StageState {
  if (caseFiles === undefined) return { state: "missing-join", reason: "no-case-file-snapshot" };
  const assignments: VerifiedAssignment[] = rows.filter((row) => row.step === "worker.assignment" && row.assignmentId !== null)
    .map((row) => ({ assignmentId: row.assignmentId!, taskId, runId: row.runId, assignedAt: row.ts, taskClass: row.taskClass,
      selectedModel: row.selectedModel, servedModel: null, billingMode: null, costUsd: null, attempted: true }));
  const { coverage } = joinVerifiedTaskOutcomes(assignments, caseFiles.filter((file) => file.taskId === taskId), asOf);
  if (coverage.completed > 0) return { state: "reached", at: null, humanTouched: humanReviewed || operatorTimes.length > 0 };
  if (coverage.censored > 0) return { state: "censored" };
  if (coverage.reasons["closed-unmerged-unadjudicated"]) return { state: "not-reached" };
  return { state: "missing-join", reason: Object.keys(coverage.reasons)[0] ?? "no-assignment-to-verify" };
}

function repairUnits(ctx: SourceContext, taskOf: Map<string, string>, classOf: Map<string, string | null>,
  rowsByTask: Map<string, FlowRow[]>): RepairUnit[] {
  const windowMs = FOLLOW_UP_WINDOW_DAYS * DAY_MS;
  const scanComplete = ctx.store?.cursors.pulls.state === "complete";
  const mergedByTask = new Map<string, GithubPull[]>();
  for (const pull of ctx.mergedByNumber.values()) {
    const task = taskOf.get(pull.nodeId);
    if (task !== undefined) mergedByTask.set(task, [...(mergedByTask.get(task) ?? []), pull]);
  }
  return [...ctx.mergedByNumber.values()].map((pull) => {
    const task = taskOf.get(pull.nodeId);
    const mergedAt = Date.parse(pull.mergedAt!);
    const revertAt = ctx.revertedAt.get(pull.number);
    const reverted = revertAt !== undefined && Date.parse(revertAt) - mergedAt <= windowMs;
    const followUp = task !== undefined && (mergedByTask.get(task) ?? []).some((other) => other.nodeId !== pull.nodeId
      && Date.parse(other.mergedAt!) > mergedAt && Date.parse(other.mergedAt!) - mergedAt <= windowMs);
    const bucket: RepairBucket = reverted || followUp ? "adverse-signal"
      : Date.parse(ctx.asOf) - mergedAt < windowMs ? "window-immature"
        : !scanComplete ? "unknown" : "no-adverse-signal-in-window";
    const detail = pull.detail.state === "observed" ? pull.detail : null;
    return withDigest({ key: `${ctx.label}|${periodOf(pull.mergedAt)}|${task === undefined ? "unlinked" : stratum(classOf.get(task) ?? null)}`,
      firstPass: detail === null ? "unavailable" : detail.checks.state, reviewRounds: detail?.reviews.changesRequested ?? null,
      repairCommits: detail === null ? null : Math.max(0, detail.commits.count - 1),
      fixDispatches: (rowsByTask.get(task ?? "") ?? []).filter((row) => row.step === "fix.dispatch").length,
      reverted, followUp, bucket });
  });
}

function adoptionUnits(ctx: SourceContext): { units: AdoptionUnit[]; transitions: ModelTransition[] } {
  const assignments = ctx.rows.filter((row) => row.step === "worker.assignment" && row.assignmentId !== null);
  const calls = new Map<string, FlowRow>();
  for (const row of ctx.rows) {
    if ((row.step === "worker.attempt" || row.step === "verdict") && row.assignmentId !== null) calls.set(row.assignmentId, row);
  }
  const units: AdoptionUnit[] = [];
  const transitions = new Map<string, ModelTransition>();
  const note = (host: string, model: string | null, field: "firstRequestedAt" | "firstSelectedAt" | "firstServedAt", at: string | null) => {
    if (model === null) return;
    const id = `${host}\n${model}`;
    const entry = transitions.get(id) ?? { source: ctx.label, host, model, firstRequestedAt: null, firstSelectedAt: null,
      firstServedAt: null, servedOtherwise: 0, runtimeBoot: { state: "unavailable", reason: "never-selected" },
      sourceMerge: { state: "unavailable", reason: "never-selected" } } as ModelTransition;
    entry[field] = earliest([entry[field], at]);
    transitions.set(id, entry);
  };
  for (const row of assignments) {
    const call = calls.get(row.assignmentId!);
    const host = stratum(row.host);
    const served = call?.servedModel ?? null;
    units.push(withDigest({ key: `${ctx.label}|${host}|${row.ts?.slice(0, 10) ?? "unknown"}|${stratum(row.taskClass)}`,
      requested: row.requestedModel, selected: row.selectedModel, served,
      servedMissing: served !== null ? null : call === undefined ? "no-attempt" : "not-recorded" }));
    note(host, row.requestedModel, "firstRequestedAt", row.ts);
    note(host, row.selectedModel, "firstSelectedAt", row.ts);
    note(host, served, "firstServedAt", call?.ts ?? null);
    if (served !== null && row.selectedModel !== null && served !== row.selectedModel) transitions.get(`${host}\n${row.selectedModel}`)!.servedOtherwise += 1;
  }
  for (const entry of transitions.values()) {
    if (entry.firstSelectedAt === null) continue;
    const boot = ctx.boots.filter((row) => stratum(row.host) === entry.host && row.headSha !== null && row.ts !== null
      && row.ts <= entry.firstSelectedAt!).sort((a, b) => b.ts!.localeCompare(a.ts!))[0];
    entry.runtimeBoot = boot === undefined ? { state: "unavailable", reason: "no-boot-before-first-selection" }
      : { state: "observed", at: boot.ts!, headSha: boot.headSha! };
    const committed = boot === undefined ? undefined : ctx.store?.commits[boot.headSha!];
    entry.sourceMerge = boot === undefined ? { state: "unavailable", reason: "no-runtime-boot" }
      : committed === undefined ? { state: "unavailable", reason: "boot-head-not-in-commit-history" } : { state: "observed", at: committed };
  }
  return { units, transitions: [...transitions.values()].sort((a, b) => `${a.host}\n${a.model}`.localeCompare(`${b.host}\n${b.model}`)) };
}

function learningUnits(ctx: SourceContext, pullsByRepo: (repo: string) => GithubRepoStore | undefined): LearningUnit[] {
  const units: LearningUnit[] = [];
  for (const row of ctx.rows) {
    const key = (kind: string) => `${ctx.label}|${periodOf(row.ts)}|${kind}`;
    if (row.step.endsWith(".gardener_judged") && (row.verdict === "credit" || row.verdict === "debit")) {
      units.push(withDigest({ key: key("judgement"), kind: "judgement" as const, outcome: row.verdict as "credit" | "debit", reverted: false, row: row.fingerprint }));
    } else if (row.step === "evidence_coverage.filed" && row.action === "filed") {
      units.push(withDigest({ key: key("evidence-followup"), kind: "evidence-followup" as const, outcome: "unknown" as const, reverted: false, row: row.fingerprint }));
    } else if (row.step.endsWith(".scorecard") && row.prRepo !== null && row.prNumber !== null) {
      const store = pullsByRepo(row.prRepo);
      const pull = Object.values(store?.pulls ?? {}).find((candidate) => candidate.number === row.prNumber);
      const reverted = pull !== undefined && Object.values(store!.pulls).some((other) => other.revertsPr === pull.number && other.mergedAt !== null);
      units.push(withDigest({ key: key("gardener-pr"), kind: "gardener-pr" as const, reverted, row: row.fingerprint,
        outcome: pull === undefined ? "unknown" as const : pull.mergedAt !== null ? "accepted" as const : pull.state === "open" ? "open" as const : "declined" as const }));
    }
  }
  return units;
}

/**
 * Join every source's ledger with its repository's GitHub history and derive the five families.
 * Pure: the caller does all I/O. `prior` lets unchanged partitions be reused verbatim.
 */
export function buildFieldTrialsFlowSnapshot(input: FieldTrialsFlowInput): FieldTrialsFlowSnapshot {
  const units = { adoption: [] as AdoptionUnit[], funnel: [] as FunnelUnit[], flow: [] as FlowUnit[], repair: [] as RepairUnit[],
    learning: [] as LearningUnit[] };
  const transitions: ModelTransition[] = [];
  const reasons: string[] = [];
  const privateKeys = new Set<string>();
  const assignmentTelemetry = new Map<string, FieldTrialsFlowSnapshot["assignmentTelemetry"][number]>();
  const findingRows: FlowRow[] = [];
  const links: FieldTrialsFlowSnapshot["links"] = { prs: 0, matched: 0, ambiguous: 0, unmatched: 0,
    byPath: { trailer: 0, branch: 0, ledger: 0, multiplePaths: 0 }, ledgerPrNotInGithub: 0, githubOnlyTasks: 0,
    unmatchedPrs: [], ambiguousPrs: [] };
  const provenance: FieldTrialsFlowSnapshot["provenance"]["sources"] = [];
  const storeOf = (repo: string) => Object.entries(input.github.repos).find(([name]) => name.toLowerCase() === repo.toLowerCase())?.[1];
  for (const source of input.sources) {
    const store = storeOf(source.repo);
    const { rows: ledgerRows, ...ledger } = source.ledger;
    // Only these three bounded schemas feed the private finding fold. Avoid a second copy
    // of the entire fleet ledger and an unbounded spread-argument list on large rotations.
    for (const row of ledgerRows) if (row.step === "review.posted" || row.step === "review.reviewer" || row.step === "review.finding")
      findingRows.push(row);
    if (ledger.state !== "observed") reasons.push(`${source.label}:ledger:${ledger.reason}`);
    const pullsCursor = store?.cursors.pulls ?? null;
    if (pullsCursor?.state !== "complete") reasons.push(`${source.label}:github:${pullsCursor?.reason ?? pullsCursor?.state ?? "never-read"}`);
    provenance.push({ label: source.label, repo: source.repo, ledger: { ...ledger, rows: ledgerRows.length },
      github: { pulls: pullsCursor, commits: store?.cursors.commits ?? null, deployments: store?.cursors.deployments ?? null,
        prs: Object.keys(store?.pulls ?? {}).length, commitsKnown: Object.keys(store?.commits ?? {}).length,
        deploymentsKnown: Object.keys(store?.deployments ?? {}).length } });
    privateKeys.add(source.repo);
    const pulls = Object.values(store?.pulls ?? {});
    const ctx: SourceContext = { label: source.label, repo: source.repo, store, rows: ledgerRows, asOf: input.asOf,
      boots: ledgerRows.filter((row) => row.step === "daemon.boot"),
      mergedByNumber: new Map(pulls.filter((pull) => pull.mergedAt !== null).map((pull) => [pull.number, pull])),
      revertedAt: new Map(pulls.filter((pull) => pull.revertsPr !== null && pull.mergedAt !== null).map((pull) => [pull.revertsPr!, pull.mergedAt!])) };
    const rowsByTask = new Map<string, FlowRow[]>();
    const attemptByAssignment = new Map<string, FlowRow>();
    for (const row of ledgerRows) {
      if (row.step !== "worker.attempt" || row.assignmentId === null) continue;
      const prior = attemptByAssignment.get(row.assignmentId);
      if (prior === undefined || (row.ts ?? "") >= (prior.ts ?? "")) attemptByAssignment.set(row.assignmentId, row);
    }
    for (const row of ledgerRows) {
      if (row.step === "worker.assignment") {
        const selectedModel = row.selectedModel ?? "unknown";
        const key = JSON.stringify([source.label, selectedModel]);
        const counts = assignmentTelemetry.get(key) ?? { source: source.label, selectedModel, assignments: 0,
          taskClass: 0, risk: 0, workLane: 0, harnessPinned: 0, promptPinned: 0, toolPinned: 0,
          scorerPinned: 0, environmentPinned: 0, attemptReceipts: 0, nonStarterAssignments: 0,
          costMissingAssignments: 0, apiCostEstimateUsd: 0, subscriptionNotionalUsd: 0 };
        counts.assignments += 1;
        counts.taskClass += Number(row.taskClass !== null);
        counts.risk += Number(row.risk !== null);
        counts.workLane += Number(row.workLane !== null);
        counts.harnessPinned += Number(row.stackPinned?.harness === true);
        counts.promptPinned += Number(row.stackPinned?.prompt === true);
        counts.toolPinned += Number(row.stackPinned?.tool === true);
        counts.scorerPinned += Number(row.stackPinned?.scorer === true);
        counts.environmentPinned += Number(row.stackPinned?.environment === true);
        const attempt = row.assignmentId === null ? undefined : attemptByAssignment.get(row.assignmentId);
        if (attempt === undefined) counts.nonStarterAssignments += 1;
        else counts.attemptReceipts += 1;
        if (attempt?.costUsd === null || attempt?.costUsd === undefined || attempt.billingMode === null)
          counts.costMissingAssignments += 1;
        else if (attempt.billingMode === "api") counts.apiCostEstimateUsd += attempt.costUsd;
        else counts.subscriptionNotionalUsd += attempt.costUsd;
        assignmentTelemetry.set(key, counts);
      }
      for (const key of [row.taskId, row.runId, row.assignmentId, row.host, row.headSha]) if (key !== null) privateKeys.add(key);
      if (row.taskId !== null) {
        const taskRows = rowsByTask.get(row.taskId);
        if (taskRows) taskRows.push(row);
        else rowsByTask.set(row.taskId, [row]);
      }
    }
    const ledgerTasksOfPr = new Map<number, Set<string>>();
    for (const row of ledgerRows) {
      if (row.step !== "pr.opened" || row.taskId === null || row.prNumber === null || row.prRepo?.toLowerCase() !== source.repo.toLowerCase()) continue;
      ledgerTasksOfPr.set(row.prNumber, new Set([...(ledgerTasksOfPr.get(row.prNumber) ?? []), row.taskId]));
    }
    const taskOf = new Map<string, string>();
    const pullsOfTask = new Map<string, GithubPull[]>();
    for (const pull of pulls) {
      for (const key of [pull.nodeId, pull.headRef, pull.headSha, pull.mergeCommitSha, ...pull.trailerTaskIds]) if (key !== null) privateKeys.add(key);
      const branch = RUN_BRANCH_RE.exec(pull.headRef ?? "")?.[1];
      const ledgerTasks = [...(ledgerTasksOfPr.get(pull.number) ?? [])];
      const paths = [pull.trailerTaskIds.length > 0, branch !== undefined, ledgerTasks.length > 0];
      const candidates = new Set([...pull.trailerTaskIds, ...(branch === undefined ? [] : [branch]), ...ledgerTasks]);
      links.prs += 1;
      links.byPath.trailer += Number(paths[0]);
      links.byPath.branch += Number(paths[1]);
      links.byPath.ledger += Number(paths[2]);
      if (candidates.size === 0) { links.unmatched += 1; links.unmatchedPrs.push({ source: source.label, number: pull.number }); continue; }
      if (candidates.size > 1) {
        links.ambiguous += 1;
        links.ambiguousPrs.push({ source: source.label, number: pull.number, tasks: [...candidates].sort() });
        continue;
      }
      links.matched += 1;
      if (paths.filter(Boolean).length > 1) links.byPath.multiplePaths += 1;
      const task = [...candidates][0]!;
      taskOf.set(pull.nodeId, task);
      pullsOfTask.set(task, [...(pullsOfTask.get(task) ?? []), pull]);
    }
    for (const number of ledgerTasksOfPr.keys()) if (!pulls.some((pull) => pull.number === number)) links.ledgerPrNotInGithub += 1;
    links.githubOnlyTasks += [...pullsOfTask.keys()].filter((task) => !rowsByTask.has(task)).length;
    for (const key of [...ctx.boots.map((boot) => boot.headSha)]) if (key !== null) privateKeys.add(key);
    const classOf = new Map<string, string | null>();
    for (const [taskId, rows] of rowsByTask) {
      const taskClass = rows.find((row) => row.taskClass !== null)?.taskClass ?? null;
      classOf.set(taskId, taskClass);
      const { funnel, flow } = evaluateTask(ctx, taskId, rows, pullsOfTask.get(taskId) ?? [], input.caseFiles, taskClass);
      units.funnel.push(funnel);
      units.flow.push(flow);
    }
    units.repair.push(...repairUnits(ctx, taskOf, classOf, rowsByTask));
    const adoption = adoptionUnits(ctx);
    units.adoption.push(...adoption.units);
    transitions.push(...adoption.transitions);
    units.learning.push(...learningUnits(ctx, storeOf));
  }
  const rebuilt: string[] = [];
  const reused = { count: 0 };
  const prior = input.prior?.version === FIELD_TRIALS_FLOW_VERSION ? input.prior.families : undefined;
  const families: FieldTrialsFlowSnapshot["families"] = {
    adoption: rebuildFamily("adoption", units.adoption, prior?.adoption, adoptionCells, rebuilt, reused),
    transitions,
    funnel: rebuildFamily("funnel", units.funnel, prior?.funnel, funnelCells, rebuilt, reused),
    repair: rebuildFamily("repair", units.repair, prior?.repair, repairCells, rebuilt, reused),
    flow: rebuildFamily("flow", units.flow, prior?.flow, flowCells, rebuilt, reused),
    learning: rebuildFamily("learning", units.learning, prior?.learning, learningCells, rebuilt, reused),
  };
  const githubFresh = (input.githubPass?.pagesRead ?? 0) > 0;
  const anyObserved = githubFresh || provenance.some((source) => source.ledger.state !== "unavailable");
  const { evidence: producedFindingEvidence, ...reviewFindingEvidence } = deriveVerifiedReviewFindingEvidence(
    findingRows, input.findingEvidence, input.asOf);
  const reviewFindingOutcomes = deriveReviewFindingOutcomes(findingRows,
    [...producedFindingEvidence, ...(input.verifiedFindingEvidence ?? [])]);
  for (const finding of reviewFindingOutcomes.findings) privateKeys.add(finding.findingId);
  for (const proof of reviewFindingEvidence.records) for (const key of [proof.receiptDigest, proof.findingDigest,
    proof.authorityDigest, proof.sourceDigest, proof.beforeHead, proof.afterHead, proof.scorerRevision,
    proof.caseDigest, proof.mechanismDigest]) if (key !== undefined) privateKeys.add(key);
  return { version: FIELD_TRIALS_FLOW_VERSION, asOf: input.asOf,
    state: !anyObserved ? "unavailable" : reasons.length > 0 ? "observed-partial" : "observed", reasons,
    observational: true, causalClaims: "none", followUpWindowDays: FOLLOW_UP_WINDOW_DAYS,
    reviewFindingOutcomes, reviewFindingEvidence,
    assignmentTelemetry: [...assignmentTelemetry.values()].sort((a, b) => a.source.localeCompare(b.source)
      || a.selectedModel.localeCompare(b.selectedModel)),
    provenance: { sources: provenance, githubPass: input.githubPass ?? null }, links, families,
    rebuild: { rebuiltPartitions: rebuilt, reusedPartitions: reused.count }, privateKeys: [...privateKeys].sort() };
}

export interface FieldTrialsConsent {
  version: typeof FIELD_TRIALS_CONSENT_VERSION;
  repos: { repo: string; rights: "private" | "aggregate-opt-in" | "public-benchmark"; receipt: string; revoked?: boolean;
    publicSourceUrl?: string }[];
}

export function parseFieldTrialsConsent(value: unknown): FieldTrialsConsent | string {
  const consent = record(value);
  if (consent?.version !== FIELD_TRIALS_CONSENT_VERSION || !Array.isArray(consent.repos)) return "consent-invalid";
  const valid = consent.repos.every((entry) => {
    const repo = record(entry);
    return text(repo?.repo) !== null && ["private", "aggregate-opt-in", "public-benchmark"].includes(String(repo?.rights))
      && text(repo?.receipt) !== null;
  });
  return valid ? consent as unknown as FieldTrialsConsent : "consent-invalid";
}

export interface ReleaseCell {
  family: string;
  source: string;
  stratum: Record<string, string>;
  n: number | null;
  counts: Record<string, number | null>;
  measures: Record<string, number | null>;
  reasons: string[];
  suppressed: string[];
}

export interface FieldTrialsRelease {
  version: typeof FIELD_TRIALS_RELEASE_VERSION;
  releaseId: string;
  asOf: string;
  snapshotVersion: typeof FIELD_TRIALS_FLOW_VERSION;
  status: "candidate-unreviewed";
  observational: true;
  causalClaims: "none";
  followUpWindowDays: number;
  sources: { source: string; rights: string; receiptHash: string; publicSourceUrl: string | null;
    ledger: { state: string; reason: string | null; forms: Record<string, number>; malformedRows: number;
      futureRows: number; unreadSources: number };
    github: Record<string, { state: string; reason: string | null; asOf: string | null; pagesRead: number } | null> }[];
  withheld: { reason: string; sources: number }[];
  links: { prs: number; matched: number; ambiguous: number; unmatched: number; ledgerPrNotInGithub: number } | null;
  disclosure: { smallCellMin: number; suppressedCells: number; suppressedValues: number; complementary: number };
  funnelStageFollows: Record<string, string | null>;
  cells: ReleaseCell[];
  transitions: { source: string; instance: string; model: string; firstRequestedDay: string | null; firstSelectedDay: string | null;
    firstServedDay: string | null; runtimeBootDay: string | null; sourceMergeDay: string | null; unavailable: string[] }[];
  unavailable: Record<string, string>;
}

export type FieldTrialsReleaseResult =
  | { state: "candidate"; release: FieldTrialsRelease; consentReceipts: string[] }
  | { state: "withheld" | "refused"; reason: string };

function safeLabel(value: string): string {
  return SAFE_LABEL_RE.test(value) ? value : "other";
}

function safeModel(value: string): string {
  return SAFE_MODEL_RE.test(value) ? value : "other";
}

/** Withhold small cells and small counts; when one member of a sum group is withheld, withhold the next smallest. */
export function suppressCell(cell: ReleaseCell, groups: string[][], min: number = SMALL_CELL_MIN): { values: number; complementary: number } {
  if (cell.n !== null && cell.n < min) {
    const values = Object.keys(cell.counts).length + Object.keys(cell.measures).length;
    cell.n = null;
    for (const key of Object.keys(cell.counts)) cell.counts[key] = null;
    for (const key of Object.keys(cell.measures)) cell.measures[key] = null;
    cell.suppressed.push("cell:small-n");
    return { values, complementary: 0 };
  }
  let values = 0;
  for (const [key, value] of Object.entries(cell.counts)) {
    if (value !== null && value > 0 && value < min) { cell.counts[key] = null; cell.suppressed.push(key); values += 1; }
  }
  let complementary = 0;
  for (const group of groups) {
    if (group.filter((key) => cell.counts[key] === null).length !== 1) continue;
    const next = group.filter((key) => (cell.counts[key] ?? 0) > 0).sort((a, b) => cell.counts[a]! - cell.counts[b]!)[0];
    if (next === undefined) continue;
    cell.counts[next] = null;
    cell.suppressed.push(`${next}:complementary`);
    complementary += 1;
  }
  return { values: values + complementary, complementary };
}

function releaseCells(snapshot: FieldTrialsFlowSnapshot, included: Set<string>, pseudonym: (value: string) => string): { cells: ReleaseCell[]; groups: string[][][] } {
  const cells: ReleaseCell[] = [];
  const groups: string[][][] = [];
  const add = (cell: ReleaseCell, cellGroups: string[][]) => { cells.push(cell); groups.push(cellGroups); };
  const split = (key: string) => key.split("|");
  for (const [key, { cells: value }] of Object.entries(snapshot.families.funnel)) {
    const [label, period, taskClass] = split(key);
    if (!included.has(label!)) continue;
    const counts: Record<string, number | null> = {};
    const reasons = new Set<string>();
    // A stage's denominator IS the reached count of the stage it follows, so releasing it would
    // reveal a withheld count; readers take it from `funnelStageFollows` instead.
    for (const [stage, stageCell] of Object.entries(value.stages)) {
      for (const field of ["reached", "missingJoin", "censored", "humanTouched"] as const) counts[`${stage}.${field}`] = stageCell[field];
      for (const reason of Object.keys(stageCell.missingReasons)) reasons.add(`${stage}:${reason}`);
    }
    add({ family: "funnel", source: pseudonym(label!), stratum: { period: period!, taskClass: safeLabel(taskClass!) }, n: value.tasks,
      counts, measures: {}, reasons: [...reasons].sort(), suppressed: [] }, []);
  }
  for (const [key, { cells: value }] of Object.entries(snapshot.families.repair)) {
    const [label, period, taskClass] = split(key);
    if (!included.has(label!)) continue;
    const counts: Record<string, number | null> = { reverted: value.reverted, followUp: value.followUp, fixDispatches: value.fixDispatches,
      "reviewRounds.observed": value.reviewRounds.observed, "reviewRounds.total": value.reviewRounds.total,
      "repairCommits.total": value.repairCommits.total };
    for (const [state, n] of Object.entries(value.firstPass)) counts[`firstPass.${safeLabel(state)}`] = n;
    for (const [bucket, n] of Object.entries(value.correctness)) counts[`correctness.${bucket}`] = n;
    add({ family: "repair", source: pseudonym(label!), stratum: { period: period!, taskClass: safeLabel(taskClass!) }, n: value.mergedPrs,
      counts, measures: {}, reasons: [`incidents:${value.incidents.reason}`], suppressed: [] },
    [Object.keys(counts).filter((name) => name.startsWith("firstPass.")), Object.keys(counts).filter((name) => name.startsWith("correctness."))]);
  }
  for (const [key, { cells: value }] of Object.entries(snapshot.families.flow)) {
    const [label, period, taskClass] = split(key);
    if (!included.has(label!)) continue;
    const counts: Record<string, number | null> = { "retries.none": value.retries.none, "retries.one": value.retries.one,
      "retries.twoOrMore": value.retries.twoOrMore, selfRepair: value.selfRepair, escalated: value.escalated };
    const measures: Record<string, number | null> = {};
    for (const endpoint of ["toPr", "toMerge", "toDeploy", "commitToDeploy"] as const) {
      const duration = value[endpoint];
      counts[`${endpoint}.observed`] = duration.observed;
      counts[`${endpoint}.censored`] = duration.censored;
      const enough = duration.observed >= SMALL_CELL_MIN;
      measures[`${endpoint}.p50Ms`] = enough ? duration.p50Ms : null;
      measures[`${endpoint}.p90Ms`] = enough ? duration.p90Ms : null;
    }
    add({ family: "flow", source: pseudonym(label!), stratum: { period: period!, taskClass: safeLabel(taskClass!) }, n: value.tasks,
      counts, measures, reasons: ["censoring:kaplan-meier"], suppressed: [] }, [["retries.none", "retries.one", "retries.twoOrMore"]]);
  }
  for (const [key, { cells: value }] of Object.entries(snapshot.families.adoption)) {
    const [label, host, day, taskClass] = split(key);
    if (!included.has(label!)) continue;
    const counts: Record<string, number | null> = {};
    for (const [field, tally] of [["requested", value.requested], ["selected", value.selected], ["served", value.served]] as const) {
      for (const [model, n] of Object.entries(tally)) counts[`${field}:${safeModel(model)}`] = (counts[`${field}:${safeModel(model)}`] ?? 0) + n;
    }
    for (const [reason, n] of Object.entries(value.servedUnavailable)) counts[`served-unavailable:${reason}`] = n;
    add({ family: "adoption", source: pseudonym(label!), stratum: { instance: pseudonym(`${label}\n${host}`), day: day!, taskClass: safeLabel(taskClass!) },
      n: value.assignments, counts, measures: {}, reasons: [], suppressed: [] },
    [Object.keys(counts).filter((name) => name.startsWith("served"))]);
  }
  for (const [key, { cells: value }] of Object.entries(snapshot.families.learning)) {
    const [label, period, kind] = split(key);
    if (!included.has(label!)) continue;
    const { humanEffort, proposals, ...counts } = value;
    add({ family: "learning", source: pseudonym(label!), stratum: { period: period!, kind: kind! }, n: kind === "judgement" ? counts.credits + counts.debits : proposals,
      counts: { ...counts }, measures: {}, reasons: [`humanEffort:${humanEffort.reason}`], suppressed: [] }, []);
  }
  return { cells, groups };
}

/** Every string a release carries, keys included, for the private-key scan. */
function releaseStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) releaseStrings(item, out);
  else if (record(value)) for (const [key, item] of Object.entries(value as Record<string, unknown>)) { out.push(key); releaseStrings(item, out); }
  return out;
}

/**
 * The only export path. Includes a source only while its repository carries a live aggregate or
 * public-benchmark consent; pseudonymises sources and instances with the local salt; withholds small
 * cells; and REFUSES the whole release if any private join key the snapshot saw appears in it.
 */
export function buildFieldTrialsRelease(snapshot: FieldTrialsFlowSnapshot, consent: FieldTrialsConsent | string | null,
  salt: string): FieldTrialsReleaseResult {
  if (consent === null) return { state: "withheld", reason: "no-consent-receipt" };
  if (typeof consent === "string") return { state: "withheld", reason: consent };
  if (snapshot.state === "unavailable") return { state: "refused", reason: "snapshot-unavailable" };
  const pseudonym = (value: string) => `src-${createHmac("sha256", salt).update(value).digest("hex").slice(0, 12)}`;
  const included = new Set<string>();
  const sources: FieldTrialsRelease["sources"] = [];
  const receipts: string[] = [];
  let withheld = 0;
  for (const source of snapshot.provenance.sources) {
    const grant = consent.repos.find((entry) => entry.repo.toLowerCase() === source.repo.toLowerCase() && entry.revoked !== true
      && (entry.rights === "aggregate-opt-in" || entry.rights === "public-benchmark"));
    if (grant === undefined) { withheld += 1; continue; }
    included.add(source.label);
    const receiptHash = sha256(grant.receipt);
    receipts.push(receiptHash);
    const cursor = (value: GithubCursor | null) => value === null ? null
      : { state: value.state, reason: value.reason, asOf: value.asOf, pagesRead: value.pagesRead };
    sources.push({ source: pseudonym(source.label), rights: grant.rights, receiptHash, publicSourceUrl: grant.publicSourceUrl ?? null,
      ledger: { state: source.ledger.state, reason: source.ledger.reason, forms: source.ledger.forms,
        malformedRows: source.ledger.malformedRows, futureRows: source.ledger.futureRows,
        unreadSources: source.ledger.unreadSources },
      github: { pulls: cursor(source.github.pulls), commits: cursor(source.github.commits), deployments: cursor(source.github.deployments) } });
  }
  if (included.size === 0) return { state: "withheld", reason: "no-aggregate-consent" };
  const { cells, groups } = releaseCells(snapshot, included, pseudonym);
  const disclosure = { smallCellMin: SMALL_CELL_MIN, suppressedCells: 0, suppressedValues: 0, complementary: 0 };
  cells.forEach((cell, index) => {
    const result = suppressCell(cell, groups[index]!);
    if (cell.n === null) disclosure.suppressedCells += 1;
    disclosure.suppressedValues += result.values;
    disclosure.complementary += result.complementary;
  });
  const day = (value: string | null) => value?.slice(0, 10) ?? null;
  const transitions = snapshot.families.transitions.filter((entry) => included.has(entry.source)).map((entry) => ({
    source: pseudonym(entry.source), instance: pseudonym(`${entry.source}\n${entry.host}`), model: safeModel(entry.model),
    firstRequestedDay: day(entry.firstRequestedAt), firstSelectedDay: day(entry.firstSelectedAt), firstServedDay: day(entry.firstServedAt),
    runtimeBootDay: entry.runtimeBoot.state === "observed" ? day(entry.runtimeBoot.at) : null,
    sourceMergeDay: entry.sourceMerge.state === "observed" ? day(entry.sourceMerge.at) : null,
    unavailable: [entry.runtimeBoot, entry.sourceMerge].flatMap((item) => item.state === "unavailable" ? [item.reason] : []) }));
  const body = { version: FIELD_TRIALS_RELEASE_VERSION, releaseId: "", asOf: snapshot.asOf, snapshotVersion: FIELD_TRIALS_FLOW_VERSION,
    status: "candidate-unreviewed" as const, observational: true as const, causalClaims: "none" as const,
    followUpWindowDays: snapshot.followUpWindowDays, sources,
    withheld: withheld > 0 ? [{ reason: "no-aggregate-consent", sources: withheld }] : [],
    links: withheld === 0 ? { prs: snapshot.links.prs, matched: snapshot.links.matched, ambiguous: snapshot.links.ambiguous,
      unmatched: snapshot.links.unmatched, ledgerPrNotInGithub: snapshot.links.ledgerPrNotInGithub } : null,
    disclosure, funnelStageFollows: STAGE_FOLLOWS, cells, transitions,
    unavailable: { incidents: "no-incident-source", humanEffort: "no-independent-human-effort-estimate",
      causalEffect: "observational-only-no-randomized-allocation" } };
  body.releaseId = sha256(JSON.stringify(body)).slice(0, 16);
  const strings = releaseStrings({ ...body, sources: body.sources.map(({ publicSourceUrl, ...scanned }) => (void publicSourceUrl, scanned)) });
  const leak = snapshot.privateKeys.find((key) => key.length >= 6 && strings.some((value) => value.includes(key)));
  if (leak !== undefined) return { state: "refused", reason: "private-join-key-in-release" };
  return { state: "candidate", release: body, consentReceipts: receipts };
}

export interface FieldTrialsManifestEntry {
  releaseId: string;
  asOf: string;
  createdAt: string;
  file: string;
  sha256: string;
  consentReceipts: string[];
  status: "candidate-unreviewed" | "superseded" | "revoked";
  revokedAt?: string;
  revokeReason?: string;
}

export interface FieldTrialsReleaseManifest {
  version: typeof FIELD_TRIALS_MANIFEST_VERSION;
  releases: FieldTrialsManifestEntry[];
  lastKnownGood: { releaseId: string; asOf: string } | null;
  lastRefresh: { at: string; state: "released" | "withheld" | "failed"; reason: string | null } | null;
}

export function parseReleaseManifest(value: unknown): FieldTrialsReleaseManifest {
  const manifest = record(value);
  return manifest?.version === FIELD_TRIALS_MANIFEST_VERSION && Array.isArray(manifest.releases)
    ? manifest as unknown as FieldTrialsReleaseManifest
    : { version: FIELD_TRIALS_MANIFEST_VERSION, releases: [], lastKnownGood: null, lastRefresh: null };
}

function refreshLastKnownGood(manifest: FieldTrialsReleaseManifest): void {
  const live = manifest.releases.filter((entry) => entry.status !== "revoked").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  manifest.lastKnownGood = live === undefined ? null : { releaseId: live.releaseId, asOf: live.asOf };
}

/** Withdraw one release: its manifest row says revoked and why; the returned file is for the caller to delete. */
export function revokeRelease(manifest: FieldTrialsReleaseManifest, releaseId: string, at: string, reason: string): string | null {
  const entry = manifest.releases.find((item) => item.releaseId === releaseId && item.status !== "revoked");
  if (entry === undefined) return null;
  Object.assign(entry, { status: "revoked", revokedAt: at, revokeReason: reason });
  refreshLastKnownGood(manifest);
  return entry.file;
}

/** Revoke every unrevoked release whose consent receipts are no longer all live. */
export function revokeWithdrawnConsent(manifest: FieldTrialsReleaseManifest, consent: FieldTrialsConsent | string | null,
  at: string): string[] {
  const live = new Set(typeof consent === "object" && consent !== null
    ? consent.repos.filter((entry) => entry.revoked !== true && entry.rights !== "private").map((entry) => sha256(entry.receipt)) : []);
  return manifest.releases.filter((entry) => entry.status !== "revoked" && entry.consentReceipts.some((receipt) => !live.has(receipt)))
    .map((entry) => revokeRelease(manifest, entry.releaseId, at, "consent-withdrawn")!);
}

/** Record a new candidate; earlier candidates stay dated on disk as superseded. */
export function recordRelease(manifest: FieldTrialsReleaseManifest, entry: FieldTrialsManifestEntry): void {
  for (const item of manifest.releases) if (item.status === "candidate-unreviewed") item.status = "superseded";
  manifest.releases.push(entry);
  refreshLastKnownGood(manifest);
  manifest.lastRefresh = { at: entry.createdAt, state: "released", reason: null };
}

function writeJsonAtomically(path: string, value: unknown): string {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // The container starts with a 022 umask. These snapshots and release candidates stay private
  // even when that process default differs from the host wrapper's 077 umask.
  writeFileSync(temporary, encoded, { mode: 0o600 });
  renameSync(temporary, path);
  return sha256(encoded);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch {
    const reason = "absent-or-unreadable";
    return { unreadable: reason };
  }
}

/** The local, rotatable pseudonym salt. Deleting the file rotates every pseudonym on the next release. */
function pseudonymSalt(outDir: string): string {
  const path = join(outDir, "field-trials-pseudonym-salt");
  const salt = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, salt, { mode: 0o600, flag: "wx" });
    return salt;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readFileSync(path, "utf8").trim();
  }
}

export interface FieldTrialsCommandInput {
  nowIso?: string;
  print?: (line: string) => void;
  printError?: (line: string) => void;
  fetch?: GithubPageFetch;
  readLedger?: (stateDir: string) => Promise<FieldTrialsLedgerRead>;
  resolveConfig?: () => { root: string; fleetRepos?: string[] };
}

const USAGE = "usage: rmd field-trials [--source <label>=<owner/repo>]... [--ledger <label>=<state-dir>]... [--out-dir <dir>] "
  + "[--consent <file>] [--case-files <file>] [--finding-evidence <file>] [--finding-evidence-keys <file>] "
  + "[--max-pages <n>] [--offline] [--revoke <release-id>] [--json]";

function labelOf(repo: string): string {
  const name = repo.split("/").at(-1)!.toLowerCase();
  return name === "remudero" ? "core" : name.replace(/^remudero-/, "");
}

function pairs(values: string[] | undefined): Map<string, string> | string {
  const out = new Map<string, string>();
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at <= 0 || at === value.length - 1) return value;
    out.set(value.slice(0, at), value.slice(at + 1));
  }
  return out;
}

/**
 * `rmd field-trials`: one resumable snapshot pass. Reads each source's ledger union and a bounded
 * number of GitHub pages, writes the private snapshot, and — only with a consent file — a dated,
 * revocable candidate release. A refresh failure keeps the last known good release and says so.
 * It writes no ledger line, gates no PR, changes no routing, spends nothing and publishes nothing.
 */
export async function fieldTrialsCommand(rest: string[], build: (input: FieldTrialsFlowInput) => FieldTrialsFlowSnapshot,
  input: FieldTrialsCommandInput = {}): Promise<number> {
  const print = input.print ?? ((line: string) => console.log(line));
  const printError = input.printError ?? ((line: string) => console.error(line));
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    values = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
      source: { type: "string", multiple: true }, ledger: { type: "string", multiple: true }, "out-dir": { type: "string" },
      consent: { type: "string" }, "case-files": { type: "string" }, "max-pages": { type: "string" },
      "finding-evidence": { type: "string" }, "finding-evidence-keys": { type: "string" },
      offline: { type: "boolean" }, revoke: { type: "string" }, json: { type: "boolean" } } }).values;
  } catch {
    const reason = "arguments-invalid";
    print(`${USAGE} (${reason})`);
    return 2;
  }
  const sourcePairs = pairs(values.source as string[] | undefined);
  const ledgerPairs = pairs(values.ledger as string[] | undefined);
  const maxPages = values["max-pages"] === undefined ? DEFAULT_MAX_PAGES : Number(values["max-pages"]);
  if (typeof sourcePairs === "string" || typeof ledgerPairs === "string" || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    print(`${USAGE} (invalid: ${typeof sourcePairs === "string" ? sourcePairs : typeof ledgerPairs === "string" ? ledgerPairs : "--max-pages"})`);
    return 2;
  }
  const config = (input.resolveConfig ?? loadConfig)();
  const outDir = typeof values["out-dir"] === "string" ? values["out-dir"] : join(config.root, "state", "field-trials");
  const nowIso = input.nowIso ?? systemClock.iso();
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(outDir, "field-trials-release-manifest.json");
  const manifest = parseReleaseManifest(readJson(manifestPath));
  if (typeof values.revoke === "string") {
    const file = revokeRelease(manifest, values.revoke, nowIso, "operator-revoked");
    if (file === null) { print(`field-trials: no unrevoked release ${values.revoke}`); return 2; }
    rmSync(join(outDir, file), { force: true });
    writeJsonAtomically(manifestPath, manifest);
    print(`field-trials: revoked ${values.revoke}; last known good ${manifest.lastKnownGood?.releaseId ?? "none"}`);
    return 0;
  }
  let caseFiles: TaskCaseFile[] | undefined;
  if (typeof values["case-files"] === "string") {
    const parsed = readJson(values["case-files"]);
    if (!Array.isArray(parsed) || parsed.some((file) => record(file)?.version !== "task-case-file-v1")) {
      print("field-trials: refused (case-file-snapshot-invalid)");
      return 2;
    }
    caseFiles = parsed as TaskCaseFile[];
  }
  const repos = sourcePairs.size > 0 ? [...sourcePairs] : (config.fleetRepos ?? ["craigoley/remudero"]).map((repo) => [labelOf(repo), repo] as const);
  const defaultLedgers = sourcePairs.size === 0 && ledgerPairs.size === 0 ? new Map([["core", join(config.root, "state")]]) : ledgerPairs;
  const githubPath = join(outDir, "field-trials-github-v1.json");
  const github = parseGithubStore(readJson(githubPath));
  const githubPass = values.offline === true ? { state: "skipped" as const, asOf: nowIso, pagesRead: 0, repos: {} }
    : await ingestFieldTrialsGithub(input.fetch ?? ghApiFetch(), repos.map(([, repo]) => repo), github, nowIso, maxPages);
  writeJsonAtomically(githubPath, github);
  const sources: FieldTrialsSource[] = [];
  for (const [label, repo] of repos) {
    const dir = defaultLedgers.get(label);
    let ledger = unavailableLedger("ledger-not-provided-on-this-host");
    if (dir !== undefined) {
      try { ledger = await (input.readLedger ?? readFieldTrialsLedger)(dir); }
      catch {
        const reason = "ledger-read-failed";
        ledger = unavailableLedger(reason);
      }
    }
    sources.push({ label, repo, ledger });
  }
  const snapshotPath = join(outDir, "field-trials-flow-v1.json");
  const priorValue = record(readJson(snapshotPath));
  const prior = priorValue?.version === FIELD_TRIALS_FLOW_VERSION ? priorValue as unknown as FieldTrialsFlowSnapshot : undefined;
  const findingEvidence = readReviewFindingEvidence(values["finding-evidence"] as string | undefined,
    values["finding-evidence-keys"] as string | undefined);
  const snapshot = build({ asOf: nowIso, sources, github, githubPass, findingEvidence,
    ...(prior ? { prior } : {}), ...(caseFiles ? { caseFiles } : {}) });
  if (snapshot.state !== "unavailable") writeJsonAtomically(snapshotPath, snapshot);
  const consent = typeof values.consent === "string" ? parseFieldTrialsConsent(readJson(values.consent)) : null;
  for (const file of revokeWithdrawnConsent(manifest, consent, nowIso)) rmSync(join(outDir, file), { force: true });
  const result = buildFieldTrialsRelease(snapshot, consent, pseudonymSalt(outDir));
  let failure: string | null = snapshot.state === "unavailable" ? "no-source-observed" : result.state === "refused" ? result.reason : null;
  if (failure === null && result.state === "candidate") {
    const file = join("releases", `${FIELD_TRIALS_RELEASE_VERSION}.${nowIso.slice(0, 10)}.${result.release.releaseId}.json`);
    try {
      const digest = writeJsonAtomically(join(outDir, file), result.release);
      recordRelease(manifest, { releaseId: result.release.releaseId, asOf: snapshot.asOf, createdAt: nowIso, file, sha256: digest,
        consentReceipts: result.consentReceipts, status: "candidate-unreviewed" });
    } catch {
      const reason = "release-not-persisted";
      failure = reason;
    }
  } else if (failure === null) {
    manifest.lastRefresh = { at: nowIso, state: "withheld", reason: (result as { reason: string }).reason };
  }
  if (failure !== null) {
    manifest.lastRefresh = { at: nowIso, state: "failed", reason: failure };
    printError(JSON.stringify({ event: "field_trials.refresh_failed", reason: failure, last_known_good: manifest.lastKnownGood }));
  }
  writeJsonAtomically(manifestPath, manifest);
  if (values.json === true) print(JSON.stringify({ snapshot: { state: snapshot.state, reasons: snapshot.reasons, links: {
    prs: snapshot.links.prs, matched: snapshot.links.matched, ambiguous: snapshot.links.ambiguous, unmatched: snapshot.links.unmatched },
  rebuild: snapshot.rebuild }, github: { state: githubPass.state, pagesRead: githubPass.pagesRead }, manifest }));
  else {
    print(`field-trials ${snapshot.asOf}: snapshot ${snapshot.state}; github ${githubPass.state} (${githubPass.pagesRead} pages); `
      + `${snapshot.links.matched}/${snapshot.links.prs} PRs linked, ${snapshot.links.ambiguous} ambiguous, ${snapshot.links.unmatched} unmatched`);
    for (const reason of snapshot.reasons) print(`  partial: ${reason}`);
    print(`  release: ${manifest.lastRefresh!.state}${manifest.lastRefresh!.reason ? ` (${manifest.lastRefresh!.reason})` : ""}; `
      + `last known good ${manifest.lastKnownGood ? `${manifest.lastKnownGood.releaseId} as of ${manifest.lastKnownGood.asOf}` : "none"}`);
    print("  observational only: no causal claim, no routing change, nothing published");
  }
  return failure === null ? 0 : 1;
}
