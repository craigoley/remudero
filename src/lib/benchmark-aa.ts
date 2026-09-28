/**
 * lib/benchmark-aa.ts — W1-T4575: the A/A integrity trial. Two labels share one pinned stack and
 * split tasks by a deterministic draw, so any difference the report finds is the pipeline's own.
 *
 * INVARIANT: an A/A report never names a winner, and a public claim needs a reviewed release.
 * INVARIANT: absence is never zero. Unknown cost, a missing terminal and an open PR each stay
 * visible as themselves, and an unreadable source keeps the last dated report, marked stale.
 * INVARIANT: operator-invoked and inert. Nothing here routes, dispatches, gates or spends.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { runBenchmarkCohortPass, type BenchmarkCohortSnapshot } from "./benchmark-cohort.js";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "./benchmark-verified-outcome.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { buildEvalCard, chiSquareGoodnessOfFit, normalCdf, SRM_ALPHA, type EvalCard, type EvalCardEvidence,
  type EvalCardTrial } from "./eval-card.js";
import { fingerprintLedgerLine, ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import type { TaskCaseFile } from "./task-case-file.js";

export const BENCHMARK_AA_VERSION = "benchmark-aa-v1" as const;
export const BENCHMARK_AA_TRIAL_VERSION = "benchmark-aa-trial-v1" as const;
export const BENCHMARK_AA_ALLOCATION_VERSION = "benchmark-aa-allocation-v1" as const;
export const BENCHMARK_AA_RECEIPT_VERSION = "benchmark-aa-receipt-v1" as const;
/** Two-sided level at which a difference between identical arms is one the pipeline would report. */
export const AA_FALSE_DIFFERENCE_ALPHA = 0.05;
export const TRIAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const IMMUTABLE_REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REVISION_FIELDS = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"] as const;
const EVIDENCE_STEPS = ["worker.assignment", "worker.attempt", "verdict"];
const MISSINGNESS_FIELDS = ["servedModel", "tokens", "durationMs", "billingMode", "cost"] as const;
const DIFFERENTIAL_FIELDS = ["servedModel", "cost"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type AaPinnedStack = { provider: string; model: string; effort: string }
  & Record<typeof REVISION_FIELDS[number], string>;

export interface AaTrialTask {
  taskId: string;
  taskClass: string;
  risk: string;
}

export interface AaTrialManifest {
  version: typeof BENCHMARK_AA_TRIAL_VERSION;
  trialId: string;
  cohort: { kind: "public-fixture" } | { kind: "opted-in"; consentReceipt: string; pseudonymSalt: string };
  stack: AaPinnedStack;
  labels: [string, string];
  /** Version of the task-class/risk rubric the strata below were drawn from. */
  strataRevision: string;
  tasks: AaTrialTask[];
  protocolText?: string;
  preRegisteredAt?: string;
  invoice?: { usd: number; reference: string };
  registeredAllocationHash?: string;
}

function parseTasks(value: unknown): AaTrialTask[] | string {
  if (!Array.isArray(value) || value.length === 0) return "tasks-missing";
  const seen = new Set<string>();
  const tasks: AaTrialTask[] = [];
  for (const entry of value) {
    const task = record(entry);
    const taskId = text(task?.taskId);
    const taskClass = text(task?.taskClass);
    const risk = text(task?.risk);
    if (taskId === null || taskClass === null || risk === null) return "task-entry-invalid";
    if (seen.has(taskId)) return "task-duplicated";
    seen.add(taskId);
    tasks.push({ taskId, taskClass, risk });
  }
  return tasks;
}

/** Refuses anything but a public-fixture or explicitly opted-in cohort on one fully pinned stack. */
export function parseAaTrialManifest(value: unknown): { ok: true; manifest: AaTrialManifest } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const manifest = record(value);
  if (manifest?.version !== BENCHMARK_AA_TRIAL_VERSION) return refuse("manifest-version-unsupported");
  if (typeof manifest.trialId !== "string" || !TRIAL_ID_RE.test(manifest.trialId)) return refuse("trial-id-invalid");
  const cohort = record(manifest.cohort);
  let parsedCohort: AaTrialManifest["cohort"];
  if (cohort?.kind === "public-fixture") parsedCohort = { kind: "public-fixture" };
  else if (cohort?.kind === "opted-in") {
    const consentReceipt = text(cohort.consentReceipt);
    const pseudonymSalt = text(cohort.pseudonymSalt);
    if (consentReceipt === null || pseudonymSalt === null) return refuse("opted-in-cohort-needs-consent-receipt-and-salt");
    parsedCohort = { kind: "opted-in", consentReceipt, pseudonymSalt };
  } else return refuse("cohort-not-public-fixture-or-opted-in");
  const stack = record(manifest.stack);
  const pinned: Record<string, string> = {};
  for (const field of ["provider", "model", "effort"] as const) {
    const value = text(stack?.[field]);
    if (value === null) return refuse(`stack-not-pinned:${field}`);
    pinned[field] = value;
  }
  for (const field of REVISION_FIELDS) {
    const value = stack?.[field];
    if (typeof value !== "string" || !IMMUTABLE_REVISION_RE.test(value)) return refuse(`stack-not-pinned:${field}`);
    pinned[field] = value.toLowerCase();
  }
  const labels = manifest.labels === undefined ? ["A1", "A2"] : manifest.labels;
  if (!Array.isArray(labels) || labels.length !== 2 || labels.some((label) => text(label) === null) || labels[0] === labels[1])
    return refuse("labels-must-be-two-distinct-names");
  const strataRevision = text(manifest.strataRevision);
  if (strataRevision === null) return refuse("strata-revision-missing");
  const tasks = parseTasks(manifest.tasks);
  if (typeof tasks === "string") return refuse(tasks);
  const invoice = record(manifest.invoice);
  if (manifest.invoice !== undefined && (typeof invoice?.usd !== "number" || !Number.isFinite(invoice.usd)
    || invoice.usd < 0 || text(invoice.reference) === null)) return refuse("invoice-invalid");
  return { ok: true, manifest: {
    version: BENCHMARK_AA_TRIAL_VERSION, trialId: manifest.trialId, cohort: parsedCohort,
    stack: pinned as AaPinnedStack, labels: [labels[0] as string, labels[1] as string], strataRevision, tasks,
    ...(typeof manifest.protocolText === "string" ? { protocolText: manifest.protocolText } : {}),
    ...(typeof manifest.preRegisteredAt === "string" ? { preRegisteredAt: manifest.preRegisteredAt } : {}),
    ...(invoice ? { invoice: { usd: invoice.usd as number, reference: invoice.reference as string } } : {}),
    ...(typeof manifest.registeredAllocationHash === "string" ? { registeredAllocationHash: manifest.registeredAllocationHash } : {}),
  } };
}

/** The draw reads the trial and the task only: a retry, a run or a spawn cannot move a task's label. */
export function aaArmFor(trialId: string, taskId: string, labels: readonly [string, string]): string {
  const digest = createHash("sha256").update(`${BENCHMARK_AA_ALLOCATION_VERSION}\0${trialId}\0${taskId}`).digest();
  return labels[digest.readUInt32BE(0) % 2]!;
}

function unitPseudonym(manifest: AaTrialManifest, taskId: string): string {
  const salt = manifest.cohort.kind === "opted-in" ? manifest.cohort.pseudonymSalt : manifest.trialId;
  return createHmac("sha256", salt).update(taskId).digest("hex").slice(0, 16);
}

export function aaStackHash(stack: AaPinnedStack): string {
  return sha256(JSON.stringify(["provider", "model", "effort", ...REVISION_FIELDS].map((field) => [field, stack[field as keyof AaPinnedStack]])));
}

export interface AaAllocationReceipt {
  version: typeof BENCHMARK_AA_ALLOCATION_VERSION;
  trialId: string;
  unit: "task";
  method: "sha256(version, trialId, taskId) parity";
  labels: [string, string];
  plannedAllocation: Record<string, number>;
  stack: AaPinnedStack;
  /** Per label: both carry the one pinned stack, so an A/A difference cannot come from the stack. */
  arms: Record<string, { stackHash: string }>;
  strataRevision: string;
  units: { unit: string; arm: string; stratum: string }[];
  receiptHash: string;
}

/** The immutable allocation: task pseudonyms only, so it can be cited without naming private work. */
export function buildAaAllocationReceipt(manifest: AaTrialManifest): AaAllocationReceipt {
  const stackHash = aaStackHash(manifest.stack);
  const body = {
    version: BENCHMARK_AA_ALLOCATION_VERSION, trialId: manifest.trialId, unit: "task" as const,
    method: "sha256(version, trialId, taskId) parity" as const, labels: manifest.labels,
    plannedAllocation: { [manifest.labels[0]]: 0.5, [manifest.labels[1]]: 0.5 },
    stack: manifest.stack,
    arms: { [manifest.labels[0]]: { stackHash }, [manifest.labels[1]]: { stackHash } },
    strataRevision: manifest.strataRevision,
    units: manifest.tasks.map((task) => ({ unit: unitPseudonym(manifest, task.taskId),
      arm: aaArmFor(manifest.trialId, task.taskId, manifest.labels), stratum: `${task.taskClass}|${task.risk}` }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
  };
  return { ...body, receiptHash: sha256(JSON.stringify(body)) };
}

function projectRow(row: Record<string, unknown>): AaRow {
  const assignment = record(row.worker_assignment);
  const selected = record(assignment?.selected);
  const receipt = record(row.benchmark_run);
  const allocation = record(receipt?.allocation);
  const tokens = record(row.tokens);
  return {
    ts: typeof row.ts === "string" ? row.ts : null, step: row.step as string,
    taskId: row.task_id as string, runId: text(row.run_id),
    assignmentId: text(assignment?.id), selectionAssignmentId: text(row.selection_assignment_id),
    selected: { provider: text(selected?.provider), model: text(selected?.model), effort: text(selected?.effort) },
    stack: Object.fromEntries(REVISION_FIELDS.map((field) => [field, record(record(receipt?.stack)?.[field]) ?? null])),
    work: { taskClass: evidenceText(record(receipt?.work)?.taskClass), risk: evidenceText(record(receipt?.work)?.risk) },
    recordedArm: allocation?.method === "randomized" && text(allocation.arm) !== null
      ? { experimentId: text(allocation.experimentId), arm: allocation.arm as string } : null,
    routingExperiment: text(record(record(assignment?.routing)?.decision)?.ab),
    success: typeof row.success === "boolean" ? row.success : null,
    servedModel: text(row.served_model),
    billingMode: row.billing_mode === "api" || row.billing_mode === "subscription" ? row.billing_mode : null,
    costUsd: typeof row.total_cost_usd === "number" && Number.isFinite(row.total_cost_usd) && row.total_cost_usd >= 0
      ? row.total_cost_usd : null,
    tokensObserved: typeof tokens?.input === "number" && typeof tokens.output === "number",
    durationObserved: typeof row.worker_duration_ms === "number" && Number.isFinite(row.worker_duration_ms),
    retract: row.evidence_action === "retract",
  };
}

function evidenceText(value: unknown): string | null {
  const evidence = record(value);
  return evidence?.state === "observed" ? text(evidence.value) : null;
}

/** One projected, privacy-reduced ledger row. Prompt text, hosts and account labels never enter it. */
export interface AaRow {
  ts: string | null;
  step: string;
  taskId: string;
  runId: string | null;
  assignmentId: string | null;
  selectionAssignmentId: string | null;
  selected: { provider: string | null; model: string | null; effort: string | null };
  stack: Record<string, Record<string, unknown> | null>;
  work: { taskClass: string | null; risk: string | null };
  recordedArm: { experimentId: string | null; arm: string } | null;
  routingExperiment: string | null;
  success: boolean | null;
  servedModel: string | null;
  billingMode: "api" | "subscription" | null;
  costUsd: number | null;
  tokensObserved: boolean;
  durationObserved: boolean;
  retract: boolean;
}

export interface AaLedgerEvidence {
  state: "observed" | "observed-partial" | "unavailable";
  reason?: string;
  /** File count per form: the control that every form of the union was opened. */
  forms: { gzip: number; plain: number; live: number };
  unreadSources: string[];
  malformedRows: number;
  duplicateRows: number;
  /** Distinct assignment ids across the whole union, for reconciliation with the cohort projection. */
  ledgerAssignments: number;
  newestTs: string | null;
  rows: AaRow[];
}

function unavailableEvidence(reason: string, forms = { gzip: 0, plain: 0, live: 0 }, unreadSources: string[] = []): AaLedgerEvidence {
  return { state: "unavailable", reason, forms, unreadSources, malformedRows: 0, duplicateRows: 0,
    ledgerAssignments: 0, newestTs: null, rows: [] };
}

/** Streams the three-form union. Exact replayed lines are counted as duplicates, never twice as evidence. */
export async function readAaLedgerEvidence(stateDir: string, taskIds: ReadonlySet<string>): Promise<AaLedgerEvidence> {
  let names: string[];
  try { names = readdirSync(stateDir); }
  catch {
    const reason = "ledger-source-unreadable";
    return unavailableEvidence(reason);
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const forms = { gzip: rotations.filter((entry) => entry.form === "gzip").length,
    plain: rotations.filter((entry) => entry.form === "plain").length,
    live: names.includes(basename(ledgerLivePath(stateDir))) ? 1 : 0 };
  if (rotations.length + forms.live === 0) return unavailableEvidence("ledger-source-missing", forms);
  const unread: string[] = [];
  const fingerprints = new Set<string>();
  const assignmentIds = new Set<string>();
  const rows: AaRow[] = [];
  let malformedRows = 0;
  let duplicateRows = 0;
  let newestTs: string | null = null;
  for await (const row of openLedgerUnion(stateDir, {
    dedupe: false, step: EVIDENCE_STEPS,
    onUnreadArchive: (path) => unread.push(basename(path)),
    onUnreadLive: (path) => unread.push(basename(path)),
    onMalformedRow: () => { malformedRows += 1; },
    onAcceptedRecord: (accepted, raw) => {
      const id = text(record(accepted.worker_assignment)?.id);
      if (accepted.step === "worker.assignment" && id !== null) assignmentIds.add(id);
      if (typeof accepted.task_id !== "string" || !taskIds.has(accepted.task_id)) return;
      const fingerprint = fingerprintLedgerLine(raw);
      if (fingerprints.has(fingerprint)) { duplicateRows += 1; return; }
      fingerprints.add(fingerprint);
      const projected = projectRow(accepted);
      if (projected.ts !== null && (newestTs === null || projected.ts > newestTs)) newestTs = projected.ts;
      rows.push(projected);
    },
  })) void row;
  if (unread.length > 0) return unavailableEvidence("ledger-source-unreadable", forms, unread);
  return { state: malformedRows > 0 ? "observed-partial" : "observed", forms, unreadSources: [], malformedRows,
    duplicateRows, ledgerAssignments: assignmentIds.size, newestTs, rows };
}

function lnFactorials(n: number): number[] {
  const table = [0];
  for (let i = 1; i <= n; i += 1) table.push(table[i - 1]! + Math.log(i));
  return table;
}

/** Exact two-sided binomial test of `k` of `n` against one half. */
export function exactBinomialHalfPValue(k: number, n: number): number {
  if (n === 0 || k * 2 === n) return 1;
  const ln = lnFactorials(n);
  const tail = Math.min(k, n - k);
  let sum = 0;
  for (let i = 0; i <= tail; i += 1) sum += Math.exp(ln[n]! - ln[i]! - ln[n - i]! - n * Math.LN2);
  return Math.min(1, 2 * sum);
}

/** Two-sided pooled two-proportion z test; 1 when either arm is empty or the pooled rate is degenerate. */
export function twoProportionPValue(x1: number, n1: number, x2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(x1 / n1 - x2 / n2) / se));
}

export type AaSrmTest =
  | { state: "unknown"; reason: string }
  | { state: "observed"; counts: Record<string, number>; chiSquare: { statistic: number; pValue: number };
    exactBinomialPValue: number; mismatch: boolean };

function srmTest(labels: readonly [string, string], counts: Record<string, number>): AaSrmTest {
  const n = counts[labels[0]]! + counts[labels[1]]!;
  if (n === 0) return { state: "unknown", reason: "no-units" };
  const fit = chiSquareGoodnessOfFit([counts[labels[0]]!, counts[labels[1]]!], [0.5, 0.5]);
  const exact = exactBinomialHalfPValue(counts[labels[0]]!, n);
  return { state: "observed", counts, chiSquare: { statistic: fit.statistic, pValue: fit.pValue },
    exactBinomialPValue: exact, mismatch: exact < SRM_ALPHA };
}

type FieldTally = { observed: number; notRecorded: number; noAttempt: number };
type Disposition = { state: "completed" | "failed" | "censored" | "unavailable"; reason?: string };

export interface AaArmSummary {
  allocatedUnits: number;
  exposedUnits: number;
  /** Allocated tasks that never reached an assignment: kept in the arm's denominator. */
  nonStarters: number;
  assignments: number;
  /** Assignments beyond a task's first: every one stays in the task's original arm. */
  retries: number;
  crossovers: number;
  fallbacks: { provider: number; selectedModel: number; effort: number; servedModel: number };
  revisions: { different: number; unpinned: number };
  routingOverlap: number;
  stratumMismatches: number;
  joins: { assigned: number; attempted: number; terminal: number; verifiedResolved: number };
  missingness: Record<typeof MISSINGNESS_FIELDS[number], FieldTally>;
  outcomes: { completed: number; failed: number; censored: number; unavailable: number; reasons: Record<string, number> };
  accounting: {
    apiCashEstimate: { assignments: number; usd: number };
    subscriptionNotional: { assignments: number; usd: number };
    /** Never a dollar figure: an unknown cost is not a zero cost. */
    unknown: { assignments: number; reasons: Record<string, number> };
  };
}

function blankArm(): AaArmSummary {
  const tally = (): FieldTally => ({ observed: 0, notRecorded: 0, noAttempt: 0 });
  return { allocatedUnits: 0, exposedUnits: 0, nonStarters: 0, assignments: 0, retries: 0, crossovers: 0,
    fallbacks: { provider: 0, selectedModel: 0, effort: 0, servedModel: 0 }, revisions: { different: 0, unpinned: 0 },
    routingOverlap: 0, stratumMismatches: 0, joins: { assigned: 0, attempted: 0, terminal: 0, verifiedResolved: 0 },
    missingness: { servedModel: tally(), tokens: tally(), durationMs: tally(), billingMode: tally(), cost: tally() },
    outcomes: { completed: 0, failed: 0, censored: 0, unavailable: 0, reasons: {} },
    accounting: { apiCashEstimate: { assignments: 0, usd: 0 }, subscriptionNotional: { assignments: 0, usd: 0 },
      unknown: { assignments: 0, reasons: {} } } };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Latest-wins per assignment id with retractions honored; a changed assignment receipt is a conflict. */
function indexRows(rows: readonly AaRow[]) {
  const assignments = new Map<string, AaRow>();
  const attempts = new Map<string, AaRow>();
  const terminals = new Map<string, AaRow>();
  let conflictingAssignments = 0;
  const ordered = [...rows].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  for (const row of ordered) {
    if (row.step === "worker.assignment") {
      if (row.assignmentId === null) continue;
      const prior = assignments.get(row.assignmentId);
      if (prior) { if (JSON.stringify(prior) !== JSON.stringify(row)) conflictingAssignments += 1; continue; }
      assignments.set(row.assignmentId, row);
    } else if (row.selectionAssignmentId !== null) {
      const target = row.step === "verdict" ? terminals : attempts;
      if (row.retract) target.delete(row.selectionAssignmentId);
      else target.set(row.selectionAssignmentId, row);
    }
  }
  return { assignments, attempts, terminals, conflictingAssignments };
}

function unitDisposition(taskAssignments: VerifiedAssignment[], files: readonly TaskCaseFile[] | undefined, cutoff: string): Disposition {
  if (taskAssignments.length === 0) return { state: "unavailable", reason: "non-starter" };
  if (!files) return { state: "unavailable", reason: "no-verified-outcome-join" };
  const { coverage } = joinVerifiedTaskOutcomes(taskAssignments, files, cutoff);
  if (coverage.completed > 0) return { state: "completed" };
  if (coverage.reasons["closed-unmerged-unadjudicated"]) return { state: "failed" };
  if (coverage.censored > 0) return { state: "censored", reason: "open-at-cutoff" };
  return { state: "unavailable", reason: Object.keys(coverage.reasons)[0]! };
}

export type AaCohortReconciliation =
  | { state: "not-requested" }
  | { state: "unavailable"; reason: string; lastGoodAt: string | null }
  | { state: "reconciled" | "mismatch"; cohortState: BenchmarkCohortSnapshot["state"]; cohortAsOf: string | null;
    ledgerAssignments: number; cohortAssignments: number; cohortDuplicateRows: number; quarantinedSources: number;
    cohortSourceForms: Record<string, number> };

function reconcileCohort(cohort: BenchmarkAaReportInput["cohort"], evidence: AaLedgerEvidence): AaCohortReconciliation {
  if (cohort === undefined) return { state: "not-requested" };
  if (cohort.state === "unavailable") return { state: "unavailable", reason: cohort.reason ?? "cohort-unavailable",
    lastGoodAt: "lastGoodAt" in cohort ? cohort.lastGoodAt ?? null : null };
  const cohortSourceForms: Record<string, number> = {};
  for (const source of cohort.sourceLineage) bump(cohortSourceForms, source.form);
  return { state: cohort.sourceRows.assignments === evidence.ledgerAssignments ? "reconciled" : "mismatch",
    cohortState: cohort.state, cohortAsOf: cohort.asOf, ledgerAssignments: evidence.ledgerAssignments,
    cohortAssignments: cohort.sourceRows.assignments, cohortDuplicateRows: cohort.sourceRows.duplicateRows,
    quarantinedSources: cohort.quarantine?.sources.length ?? 0, cohortSourceForms };
}

export interface BenchmarkAaReportInput {
  manifest: AaTrialManifest;
  evidence: AaLedgerEvidence;
  nowIso: string;
  caseFiles?: readonly TaskCaseFile[];
  cohort?: BenchmarkCohortSnapshot | { state: "unavailable"; reason: string };
  /** The last persisted report: kept, marked stale, when this refresh cannot read its sources. */
  prior?: BenchmarkAaReport;
}

export interface AaFinding {
  kind: string;
  severity: "concern" | "info";
  detail: string;
}

export interface AaIntegrityReceipt {
  version: typeof BENCHMARK_AA_RECEIPT_VERSION;
  trialId: string;
  cohortKind: AaTrialManifest["cohort"]["kind"];
  state: BenchmarkAaReport["state"];
  asOf: string;
  lastGoodAt: string | null;
  verdict: BenchmarkAaReport["verdict"];
  winnerDeclared: false;
  allocationReceiptHash: string;
  stackHash: string;
  protocolHash: string | null;
  sampleRatio: { allocatedExactP: number | null; exposedExactP: number | null; mismatch: boolean };
  joinRates: Record<string, { terminal: number | null; verifiedResolved: number | null }>;
  mature: boolean;
  difference: { estimate: number; low: number; high: number; pValue: number } | { unavailable: string };
  accountingKinds: ["api-cash-estimate", "subscription-notional", "invoice", "unknown"];
  invoiceObserved: boolean;
  findings: string[];
  recommendations: string[];
  reportHash: string;
}

export interface BenchmarkAaReport {
  version: typeof BENCHMARK_AA_VERSION;
  state: "observed" | "observed-partial" | "stale" | "unavailable";
  reason?: string;
  asOf: string;
  lastGoodAt: string | null;
  trialId: string;
  cohortKind: AaTrialManifest["cohort"]["kind"];
  visibility: "private";
  winnerDeclared: false;
  publicClaim: "requires-reviewed-release";
  verdict: "no-integrity-concern-detected" | "integrity-concerns" | "inconclusive" | "unavailable";
  allocation: AaAllocationReceipt;
  sources: { forms: AaLedgerEvidence["forms"]; unreadSources: string[]; malformedRows: number; duplicateRows: number;
    conflictingAssignments: number; trialRows: number; rowsByArm: Record<string, number>; newestTs: string | null };
  cohortReconciliation: AaCohortReconciliation;
  lateEvidence: { state: "no-prior" | "none" | "replayed"; rows: number; affectedArms: string[] };
  sampleRatio: { allocated: AaSrmTest; exposed: AaSrmTest };
  arms: Record<string, AaArmSummary> | null;
  strata: { stratum: string; revision: string; arms: Record<string, number> }[];
  maturity: { cutoff: string; mature: boolean; censored: number; unavailable: number };
  invoice: { state: "observed"; usd: number; attribution: "trial-level-not-per-arm" } | { state: "unavailable"; reason: string };
  evalCard: EvalCard | null;
  /** The exact trial and evidence `evalCard` was built from, so a reader can serve the same card. */
  evalCardInput: { trial: EvalCardTrial; evidence: EvalCardEvidence } | null;
  findings: AaFinding[];
  recommendations: string[];
  receipt: AaIntegrityReceipt;
}

const RECOMMENDATIONS: Record<string, string> = {
  "sample-ratio-mismatch-exposed": "file a task: trace which pipeline stage drops one label's tasks before assignment",
  "sample-ratio-mismatch-allocated": "file a task: audit the allocation draw; a deterministic hash should not split this unevenly",
  "spurious-difference": "do not run A/B on this pipeline until a repeat A/A shows no difference between identical arms",
  "billing-mode-imbalance": "file a task: pin the billing mode per trial so cost differences are not an accounting artifact",
  "terminal-join-incomplete": "file a task: repair the assignment-to-terminal join (selection_assignment_id on verdict rows)",
  "verified-join-incomplete": "file a task: collect task case files for every trial task before the next refresh",
  "stack-deviation": "file a task: the pinned stack was not honored; block the trial's fallback path or record it as its own arm",
  "unpinned-revision-at-run": "file a task: pin prompt/tool/scorer/environment revisions in the assignment receipt",
  "observational-routing-overlap": "exclude trial tasks from live routing experiments; a headroom-selected arm is not randomized",
  "crossover": "file a task: a recorded label disagreed with the allocation receipt; find the relabeling path",
  "conflicting-assignment-receipts": "file a task: an assignment receipt was rewritten; receipts must be immutable",
  "allocation-receipt-changed": "re-register the trial: its allocation no longer matches the registered receipt",
  "cohort-reconciliation-mismatch": "rerun after the cohort projection catches up; a persistent gap is a reader defect",
  "stratum-mismatch": "file a task: the assignment's recorded task class or risk disagrees with the trial's strata revision",
};

function finding(kind: string, detail: string, severity: AaFinding["severity"] = "concern"): AaFinding {
  return { kind, severity, detail };
}

function receiptFor(report: Omit<BenchmarkAaReport, "receipt">): AaIntegrityReceipt {
  const [a, b] = report.allocation.labels;
  const rate = (arm: AaArmSummary | undefined, part: number) => arm && arm.joins.assigned > 0 ? part / arm.joins.assigned : null;
  const aa = report.evalCard?.aa;
  return {
    version: BENCHMARK_AA_RECEIPT_VERSION, trialId: report.trialId, cohortKind: report.cohortKind, state: report.state,
    asOf: report.asOf, lastGoodAt: report.lastGoodAt, verdict: report.verdict, winnerDeclared: false,
    allocationReceiptHash: report.allocation.receiptHash, stackHash: report.allocation.arms[a]!.stackHash,
    protocolHash: report.evalCard?.preRegistration.protocolHash ?? null,
    sampleRatio: {
      allocatedExactP: report.sampleRatio.allocated.state === "observed" ? report.sampleRatio.allocated.exactBinomialPValue : null,
      exposedExactP: report.sampleRatio.exposed.state === "observed" ? report.sampleRatio.exposed.exactBinomialPValue : null,
      mismatch: [report.sampleRatio.allocated, report.sampleRatio.exposed].some((test) => test.state === "observed" && test.mismatch),
    },
    joinRates: Object.fromEntries([a, b].map((label) => {
      const arm = report.arms?.[label];
      return [label, { terminal: rate(arm, arm?.joins.terminal ?? 0), verifiedResolved: rate(arm, arm?.joins.verifiedResolved ?? 0) }];
    })),
    mature: report.maturity.mature,
    difference: aa?.state === "observed"
      ? { ...aa.difference, pValue: aa.pValue } : { unavailable: aa && "reason" in aa ? aa.reason : "no-eval-card" },
    accountingKinds: ["api-cash-estimate", "subscription-notional", "invoice", "unknown"],
    invoiceObserved: report.invoice.state === "observed",
    findings: report.findings.map((item) => item.kind),
    recommendations: report.recommendations,
    reportHash: sha256(JSON.stringify(report)),
  };
}

function withReceipt(report: Omit<BenchmarkAaReport, "receipt">): BenchmarkAaReport {
  return { ...report, receipt: receiptFor(report) };
}

/** A refresh that cannot read its sources: the last dated report survives, marked stale, never zeroed. */
function staleOrUnavailable(input: BenchmarkAaReportInput, allocation: AaAllocationReceipt): BenchmarkAaReport {
  const reason = input.evidence.reason ?? "ledger-source-unavailable";
  const prior = input.prior;
  const sourceFinding = finding("source-unavailable", `refresh could not read its sources: ${reason}`);
  if (prior?.version === BENCHMARK_AA_VERSION && prior.trialId === input.manifest.trialId && prior.arms !== null) {
    const { receipt: _receipt, ...kept } = prior;
    void _receipt;
    return withReceipt({ ...kept, state: "stale", reason, asOf: input.nowIso, lastGoodAt: prior.lastGoodAt,
      verdict: prior.verdict, findings: [...prior.findings.filter((item) => item.kind !== "source-unavailable"), sourceFinding] });
  }
  const unknown: AaSrmTest = { state: "unknown", reason };
  return withReceipt({
    version: BENCHMARK_AA_VERSION, state: "unavailable", reason, asOf: input.nowIso, lastGoodAt: null,
    trialId: input.manifest.trialId, cohortKind: input.manifest.cohort.kind, visibility: "private", winnerDeclared: false,
    publicClaim: "requires-reviewed-release", verdict: "unavailable", allocation,
    sources: { forms: input.evidence.forms, unreadSources: input.evidence.unreadSources, malformedRows: 0, duplicateRows: 0,
      conflictingAssignments: 0, trialRows: 0, rowsByArm: {}, newestTs: null },
    cohortReconciliation: reconcileCohort(input.cohort, input.evidence),
    lateEvidence: { state: "no-prior", rows: 0, affectedArms: [] },
    sampleRatio: { allocated: unknown, exposed: unknown }, arms: null, strata: [],
    maturity: { cutoff: input.nowIso, mature: false, censored: 0, unavailable: 0 },
    invoice: { state: "unavailable", reason }, evalCard: null, evalCardInput: null, findings: [sourceFinding], recommendations: [],
  });
}

/** Build the A/A integrity report. Pure over its input; the operator verb supplies ledger, case files and prior. */
export function buildBenchmarkAaReport(input: BenchmarkAaReportInput): BenchmarkAaReport {
  const { manifest, evidence, nowIso } = input;
  const allocation = buildAaAllocationReceipt(manifest);
  if (evidence.state === "unavailable") return staleOrUnavailable(input, allocation);
  const labels = manifest.labels;
  const arms: Record<string, AaArmSummary> = { [labels[0]]: blankArm(), [labels[1]]: blankArm() };
  const index = indexRows(evidence.rows);
  const byTask = new Map<string, AaRow[]>();
  for (const row of index.assignments.values()) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
  const filesByTask = new Map<string, TaskCaseFile[]>();
  for (const file of input.caseFiles ?? []) filesByTask.set(file.taskId, [...(filesByTask.get(file.taskId) ?? []), file]);
  const cardEvidence: EvalCardEvidence = { assignments: [], outcomes: [], reviewRows: [], deviations: [] };
  const strata = new Map<string, Record<string, number>>();
  const armOfTask = new Map<string, string>();
  for (const task of manifest.tasks) {
    const arm = aaArmFor(manifest.trialId, task.taskId, labels);
    armOfTask.set(task.taskId, arm);
    const summary = arms[arm]!;
    const unit = unitPseudonym(manifest, task.taskId);
    const stratum = `${task.taskClass}|${task.risk}`;
    strata.set(stratum, { ...(strata.get(stratum) ?? { [labels[0]]: 0, [labels[1]]: 0 }) });
    strata.get(stratum)![arm]! += 1;
    summary.allocatedUnits += 1;
    const exposures = byTask.get(task.taskId) ?? [];
    if (exposures.length === 0) summary.nonStarters += 1;
    else { summary.exposedUnits += 1; summary.joins.assigned += 1; }
    summary.assignments += exposures.length;
    summary.retries += Math.max(0, exposures.length - 1);
    let attempted = false;
    let terminal = false;
    const verified: VerifiedAssignment[] = [];
    for (const exposure of exposures) {
      const call = index.attempts.get(exposure.assignmentId!) ?? index.terminals.get(exposure.assignmentId!);
      attempted ||= index.attempts.has(exposure.assignmentId!);
      terminal ||= index.terminals.has(exposure.assignmentId!);
      if (exposure.recordedArm && exposure.recordedArm.arm !== arm) summary.crossovers += 1;
      if (exposure.selected.provider !== manifest.stack.provider) summary.fallbacks.provider += 1;
      if (exposure.selected.model !== manifest.stack.model) summary.fallbacks.selectedModel += 1;
      if (exposure.selected.effort !== manifest.stack.effort) summary.fallbacks.effort += 1;
      if (call?.servedModel && call.servedModel !== manifest.stack.model) summary.fallbacks.servedModel += 1;
      for (const field of REVISION_FIELDS) {
        const pin = exposure.stack[field];
        if (pin?.state !== "observed") summary.revisions.unpinned += 1;
        else if (String(pin.value).toLowerCase() !== manifest.stack[field]) summary.revisions.different += 1;
      }
      if (exposure.routingExperiment !== null) summary.routingOverlap += 1;
      if ((exposure.work.taskClass !== null && exposure.work.taskClass !== task.taskClass)
        || (exposure.work.risk !== null && exposure.work.risk !== task.risk)) summary.stratumMismatches += 1;
      for (const field of MISSINGNESS_FIELDS) {
        const observed = call === undefined ? false : { servedModel: call.servedModel !== null, tokens: call.tokensObserved,
          durationMs: call.durationObserved, billingMode: call.billingMode !== null, cost: call.costUsd !== null }[field];
        summary.missingness[field][call === undefined ? "noAttempt" : observed ? "observed" : "notRecorded"] += 1;
      }
      const accounting = summary.accounting;
      if (call === undefined) { accounting.unknown.assignments += 1; bump(accounting.unknown.reasons, "no-attempt"); }
      else if (call.billingMode === null) { accounting.unknown.assignments += 1; bump(accounting.unknown.reasons, "billing-mode-not-reported"); }
      else if (call.costUsd === null) { accounting.unknown.assignments += 1; bump(accounting.unknown.reasons, "cost-not-reported"); }
      else {
        const bucket = call.billingMode === "api" ? accounting.apiCashEstimate : accounting.subscriptionNotional;
        bucket.assignments += 1;
        bucket.usd += call.costUsd;
      }
      verified.push({ assignmentId: exposure.assignmentId!, taskId: task.taskId, runId: exposure.runId, assignedAt: exposure.ts,
        taskClass: task.taskClass, selectedModel: exposure.selected.model, servedModel: call?.servedModel ?? null,
        billingMode: call?.billingMode ?? null, costUsd: call?.costUsd ?? null, attempted: call !== undefined });
      if (exposure.ts !== null) cardEvidence.assignments.push({ unitId: unit, arm: exposure.recordedArm?.arm ?? arm, assignedAt: exposure.ts, taskId: unit });
    }
    if (attempted) summary.joins.attempted += 1;
    if (terminal) summary.joins.terminal += 1;
    const disposition = unitDisposition(verified, filesByTask.get(task.taskId) ?? (input.caseFiles ? [] : undefined), nowIso);
    summary.outcomes[disposition.state] += 1;
    if (disposition.reason && disposition.state === "unavailable") bump(summary.outcomes.reasons, disposition.reason);
    if (disposition.state === "completed" || disposition.state === "failed") summary.joins.verifiedResolved += 1;
    cardEvidence.outcomes.push({ unitId: unit, arm, stratum,
      success: disposition.state === "completed" ? true : disposition.state === "failed" ? false : null });
  }
  const trial: EvalCardTrial = {
    trialId: manifest.trialId, kind: "aa", protocolText: manifest.protocolText ?? null,
    preRegisteredAt: manifest.preRegisteredAt ?? null,
    estimand: "difference in verified completion between two labels on one pinned stack; expected zero",
    randomizationUnit: "task", propensity: "sha256(version, trialId, taskId) parity; one half per label",
    plannedAllocation: allocation.plannedAllocation,
    cells: labels.flatMap((label) => [...strata.keys()].sort().map((stratum) => `${label}|${stratum}`)),
  };
  const evalCard = buildEvalCard(trial, cardEvidence);
  const findings: AaFinding[] = [];
  const count = (pick: (arm: AaArmSummary) => number) => pick(arms[labels[0]]!) + pick(arms[labels[1]]!);
  const counts = (pick: (arm: AaArmSummary) => number) => ({ [labels[0]]: pick(arms[labels[0]]!), [labels[1]]: pick(arms[labels[1]]!) });
  const sampleRatio = { allocated: srmTest(labels, counts((arm) => arm.allocatedUnits)), exposed: srmTest(labels, counts((arm) => arm.exposedUnits)) };
  for (const [which, test] of Object.entries(sampleRatio)) {
    if (test.state === "observed" && test.mismatch)
      findings.push(finding(`sample-ratio-mismatch-${which}`, `${which} units ${JSON.stringify(test.counts)}, exact p=${test.exactBinomialPValue.toExponential(2)}`));
  }
  if (evalCard.aa.state === "observed" && evalCard.aa.pValue < AA_FALSE_DIFFERENCE_ALPHA)
    findings.push(finding("spurious-difference", `identical arms differ by ${evalCard.aa.difference.estimate.toFixed(3)} (p=${evalCard.aa.pValue.toFixed(4)}); the pipeline would have reported a model effect that cannot exist`));
  const [armA, armB] = [arms[labels[0]]!, arms[labels[1]]!];
  for (const field of DIFFERENTIAL_FIELDS) {
    const p = twoProportionPValue(armA.missingness[field].observed, armA.assignments, armB.missingness[field].observed, armB.assignments);
    if (p < AA_FALSE_DIFFERENCE_ALPHA) findings.push(finding(`differential-missingness:${field}`, `${field} observed share differs between arms (p=${p.toFixed(4)})`));
  }
  const subscription = (arm: AaArmSummary) => arm.accounting.subscriptionNotional.assignments;
  const known = (arm: AaArmSummary) => arm.accounting.subscriptionNotional.assignments + arm.accounting.apiCashEstimate.assignments;
  if (twoProportionPValue(subscription(armA), known(armA), subscription(armB), known(armB)) < AA_FALSE_DIFFERENCE_ALPHA)
    findings.push(finding("billing-mode-imbalance", "arms differ in cash versus subscription billing; any cost difference is an accounting artifact"));
  if (count((arm) => arm.accounting.unknown.assignments) > 0)
    findings.push(finding("unknown-cost", `${count((arm) => arm.accounting.unknown.assignments)} assignments have no known cost; excluded from every total, never zero`, "info"));
  if (count((arm) => arm.joins.assigned - arm.joins.terminal) > 0)
    findings.push(finding("terminal-join-incomplete", `${count((arm) => arm.joins.assigned - arm.joins.terminal)} exposed units lack a terminal receipt`));
  const unjoinedVerified = count((arm) => arm.exposedUnits - arm.joins.verifiedResolved - arm.outcomes.censored);
  if (unjoinedVerified > 0) findings.push(finding("verified-join-incomplete", `${unjoinedVerified} exposed units have no verified outcome`));
  if (count((arm) => arm.outcomes.censored) > 0)
    findings.push(finding("immature-outcomes", `${count((arm) => arm.outcomes.censored)} units are open at the cutoff: censored, not failed`, "info"));
  if (count((arm) => arm.fallbacks.provider + arm.fallbacks.selectedModel + arm.fallbacks.effort + arm.fallbacks.servedModel + arm.revisions.different) > 0)
    findings.push(finding("stack-deviation", "an exposure ran off the pinned stack; it stays in its original arm"));
  if (count((arm) => arm.revisions.unpinned) > 0)
    findings.push(finding("unpinned-revision-at-run", `${count((arm) => arm.revisions.unpinned)} revision fields were unavailable at assignment`));
  if (count((arm) => arm.routingOverlap) > 0)
    findings.push(finding("observational-routing-overlap", "a trial task also carried a live routing experiment tag"));
  if (count((arm) => arm.crossovers) > 0) findings.push(finding("crossover", `${count((arm) => arm.crossovers)} exposures recorded a different label than allocated`));
  if (count((arm) => arm.stratumMismatches) > 0) findings.push(finding("stratum-mismatch", `${count((arm) => arm.stratumMismatches)} exposures disagree with strata revision ${manifest.strataRevision}`));
  if (index.conflictingAssignments > 0) findings.push(finding("conflicting-assignment-receipts", `${index.conflictingAssignments} assignment ids carry differing receipts`));
  if (evidence.duplicateRows > 0) findings.push(finding("duplicate-evidence", `${evidence.duplicateRows} replayed rows collapsed before counting`, "info"));
  if (evidence.malformedRows > 0) findings.push(finding("source-malformed-rows", `${evidence.malformedRows} unparseable ledger rows were skipped`));
  const registered = manifest.registeredAllocationHash ?? (input.prior?.trialId === manifest.trialId ? input.prior.allocation.receiptHash : undefined);
  if (registered !== undefined && registered !== allocation.receiptHash)
    findings.push(finding("allocation-receipt-changed", `allocation ${allocation.receiptHash.slice(0, 12)} differs from registered ${registered.slice(0, 12)}`));
  const cohortReconciliation = reconcileCohort(input.cohort, evidence);
  if (cohortReconciliation.state === "mismatch")
    findings.push(finding("cohort-reconciliation-mismatch", `ledger ${cohortReconciliation.ledgerAssignments} vs cohort ${cohortReconciliation.cohortAssignments} assignments`));
  if (cohortReconciliation.state === "unavailable")
    findings.push(finding("cohort-unavailable", `cohort projection unavailable: ${cohortReconciliation.reason}`, "info"));
  if (count((arm) => arm.exposedUnits) === 0) findings.push(finding("no-exposures", "no trial task has reached an assignment yet", "info"));
  const lateEvidence = lateEvidenceOf(input, armOfTask);
  if (lateEvidence.state === "replayed")
    findings.push(finding("late-evidence-replayed", `${lateEvidence.rows} rows arrived at or before the prior watermark; arms ${lateEvidence.affectedArms.join(", ")} rebuilt`, "info"));
  const concerns = findings.filter((item) => item.severity === "concern");
  return withReceipt({
    version: BENCHMARK_AA_VERSION, state: evidence.state, asOf: nowIso, lastGoodAt: nowIso,
    trialId: manifest.trialId, cohortKind: manifest.cohort.kind, visibility: "private", winnerDeclared: false,
    publicClaim: "requires-reviewed-release",
    verdict: concerns.length > 0 ? "integrity-concerns" : evalCard.aa.state === "observed" ? "no-integrity-concern-detected" : "inconclusive",
    allocation,
    sources: { forms: evidence.forms, unreadSources: [], malformedRows: evidence.malformedRows, duplicateRows: evidence.duplicateRows,
      conflictingAssignments: index.conflictingAssignments, trialRows: evidence.rows.length,
      rowsByArm: rowsByArm(evidence.rows, armOfTask, labels), newestTs: evidence.newestTs },
    cohortReconciliation, lateEvidence, sampleRatio, arms,
    strata: [...strata].sort(([a], [b]) => a.localeCompare(b)).map(([stratum, perArm]) => ({ stratum, revision: manifest.strataRevision, arms: perArm })),
    maturity: { cutoff: nowIso, mature: count((arm) => arm.outcomes.censored + arm.outcomes.unavailable) === 0,
      censored: count((arm) => arm.outcomes.censored), unavailable: count((arm) => arm.outcomes.unavailable) },
    invoice: manifest.invoice ? { state: "observed", usd: manifest.invoice.usd, attribution: "trial-level-not-per-arm" }
      : { state: "unavailable", reason: "no-invoice-receipt" },
    evalCard, evalCardInput: { trial, evidence: cardEvidence }, findings,
    recommendations: [...new Set(concerns.map((item) => RECOMMENDATIONS[item.kind.split(":")[0]!])
      .filter((line): line is string => line !== undefined))],
  });
}

function rowsByArm(rows: readonly AaRow[], armOfTask: ReadonlyMap<string, string>, labels: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(labels.map((label) => [label, 0]));
  for (const row of rows) counts[armOfTask.get(row.taskId)!]! += 1;
  return counts;
}

/** Rows at or before the prior report's watermark that it did not count: the arms they touch are rebuilt. */
function lateEvidenceOf(input: BenchmarkAaReportInput, armOfTask: ReadonlyMap<string, string>): BenchmarkAaReport["lateEvidence"] {
  const prior = input.prior;
  if (prior?.version !== BENCHMARK_AA_VERSION || prior.trialId !== input.manifest.trialId || prior.sources.newestTs === null)
    return { state: "no-prior", rows: 0, affectedArms: [] };
  const watermark = prior.sources.newestTs;
  const early = rowsByArm(input.evidence.rows.filter((row) => row.ts !== null && row.ts <= watermark), armOfTask, input.manifest.labels);
  const affectedArms = input.manifest.labels.filter((label) => early[label]! > (prior.sources.rowsByArm[label] ?? 0));
  const rows = affectedArms.reduce((sum, label) => sum + early[label]! - (prior.sources.rowsByArm[label] ?? 0), 0);
  return affectedArms.length === 0 ? { state: "none", rows: 0, affectedArms: [] } : { state: "replayed", rows, affectedArms };
}

/** A first run has no prior; either way the refresh proceeds and only the stale path reads it. */
function readPriorReport(path: string, trialId: string): { prior?: BenchmarkAaReport; missing?: string } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BenchmarkAaReport;
    return parsed?.version === BENCHMARK_AA_VERSION && parsed.trialId === trialId ? { prior: parsed } : { missing: "prior-report-other-trial" };
  } catch {
    const reason = "no-readable-prior-report";
    return { missing: reason };
  }
}

function priorOnly(read: { prior?: BenchmarkAaReport }): { prior?: BenchmarkAaReport } {
  return read.prior ? { prior: read.prior } : {};
}

function writeReportAtomically(path: string, report: BenchmarkAaReport): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, path);
}

function readCaseFiles(path: string): TaskCaseFile[] | string {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch {
    const reason = "case-file-snapshot-unreadable";
    return reason;
  }
  if (!Array.isArray(parsed) || parsed.some((file) => record(file)?.version !== "task-case-file-v1"
    || typeof record(file)?.taskId !== "string" || typeof record(file)?.asOf !== "string")) return "case-file-snapshot-invalid";
  return parsed as TaskCaseFile[];
}

export interface BenchmarkAaCommandInput {
  nowIso?: string;
  print?: (line: string) => void;
  resolveStateDir?: () => string;
  readEvidence?: (stateDir: string, taskIds: ReadonlySet<string>) => Promise<AaLedgerEvidence>;
  readCohort?: (stateDir: string) => Promise<BenchmarkCohortSnapshot>;
}

const USAGE = "usage: rmd benchmark-aa --trial <manifest.json> [--state-dir <dir>] [--case-files <snapshot.json>] [--out <report.json>] [--no-cohort] [--json]";

/** The operator verb. Read-only toward routing and PR flow; it writes only its own dated report file. */
export async function benchmarkAaCommand(rest: string[], build: (input: BenchmarkAaReportInput) => BenchmarkAaReport,
  input: BenchmarkAaCommandInput = {}): Promise<number> {
  const print = input.print ?? ((line: string) => console.log(line));
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
      trial: { type: "string" }, "state-dir": { type: "string" }, "case-files": { type: "string" },
      out: { type: "string" }, "no-cohort": { type: "boolean" }, json: { type: "boolean" } } }).values;
  } catch {
    const reason = "arguments-invalid";
    print(`${USAGE} (${reason})`);
    return 2;
  }
  if (typeof values.trial !== "string") { print(USAGE); return 2; }
  let parsed: ReturnType<typeof parseAaTrialManifest>;
  try { parsed = parseAaTrialManifest(JSON.parse(readFileSync(values.trial, "utf8"))); }
  catch {
    const reason = "trial-manifest-unreadable";
    parsed = { ok: false, reason };
  }
  if (!parsed.ok) { print(`benchmark-aa: refused (${parsed.reason})`); return 2; }
  const manifest = parsed.manifest;
  const caseFiles = typeof values["case-files"] === "string" ? readCaseFiles(values["case-files"]) : undefined;
  if (typeof caseFiles === "string") { print(`benchmark-aa: refused (${caseFiles})`); return 2; }
  const stateDir = typeof values["state-dir"] === "string" ? values["state-dir"]
    : (input.resolveStateDir ?? (() => join(loadConfig().root, "state")))();
  const out = typeof values.out === "string" ? values.out : join(stateDir, `${BENCHMARK_AA_VERSION}.${manifest.trialId}.json`);
  const nowIso = input.nowIso ?? systemClock.iso();
  let evidence: AaLedgerEvidence;
  try { evidence = await (input.readEvidence ?? readAaLedgerEvidence)(stateDir, new Set(manifest.tasks.map((task) => task.taskId))); }
  catch {
    const reason = "ledger-read-failed";
    evidence = unavailableEvidence(reason);
  }
  let cohort: BenchmarkAaReportInput["cohort"];
  if (values["no-cohort"] !== true) {
    try { cohort = await (input.readCohort ?? (async (dir: string) => (await runBenchmarkCohortPass(dir, { maxSources: 4 })).snapshot))(stateDir); }
    catch {
      const reason = "cohort-projection-failed";
      cohort = { state: "unavailable", reason };
    }
  }
  const report = build({ manifest, evidence, nowIso, ...(caseFiles ? { caseFiles } : {}), ...(cohort ? { cohort } : {}),
    ...priorOnly(readPriorReport(out, manifest.trialId)) });
  let persisted = true;
  try { writeReportAtomically(out, report); }
  catch {
    const reason = "report-not-persisted";
    persisted = false;
    print(`benchmark-aa: ${reason} (${out})`);
  }
  if (values.json === true) print(JSON.stringify(report));
  else {
    print(`benchmark-aa ${manifest.trialId}: ${report.state}${report.reason ? ` (${report.reason})` : ""}; verdict ${report.verdict}; no winner is declared`);
    print(`  sample ratio: allocated ${describeSrm(report.sampleRatio.allocated)}; exposed ${describeSrm(report.sampleRatio.exposed)}`);
    for (const label of manifest.labels) {
      const arm = report.arms?.[label];
      print(arm ? `  ${label}: ${arm.allocatedUnits} allocated, ${arm.exposedUnits} exposed, ${arm.joins.terminal} terminal, `
        + `${arm.joins.verifiedResolved} verified, ${arm.outcomes.censored} censored; cash $${arm.accounting.apiCashEstimate.usd.toFixed(2)}, `
        + `notional $${arm.accounting.subscriptionNotional.usd.toFixed(2)}, unknown ${arm.accounting.unknown.assignments}` : `  ${label}: unavailable`);
    }
    for (const item of report.findings) print(`  ${item.severity}: ${item.kind} — ${item.detail}`);
    print(`  receipt ${report.receipt.version} ${report.receipt.reportHash.slice(0, 16)}${persisted ? ` written to ${out}` : ""}`);
  }
  return report.state === "observed" || report.state === "observed-partial" ? 0 : 1;
}

function describeSrm(test: AaSrmTest): string {
  return test.state === "observed" ? `${JSON.stringify(test.counts)} exact p=${test.exactBinomialPValue.toFixed(4)}${test.mismatch ? " MISMATCH" : ""}`
    : `unknown (${test.reason})`;
}
