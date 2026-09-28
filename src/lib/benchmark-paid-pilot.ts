/**
 * lib/benchmark-paid-pilot.ts — W1-T4603: the operator-approved paid model pilot. A task-randomized
 * paid (API-billed) arm against a subscription control arm, $100 in total over seven days, across
 * three consented repos.
 *
 * INVARIANT: nothing here spends. Only `rmd benchmark-paid-pilot activate`, run by an operator,
 * persists the immutable protocol, and the seven-day clock starts at that activation.
 * INVARIANT: only the paid arm ever pauses. Work outside the pilot, the control arm, review, CI and
 * merge are never held by missing telemetry.
 * INVARIANT: cash is the API-billed worker-call estimate, never an invoice. Subscription notional
 * cost is reported apart and never depletes the ceiling, and a missing price is unknown, not zero.
 * W1-T4625 adds `design: "paired"` (paired-trial.ts): both arms run on each sampled task, `arm` names the
 * arm that runs FIRST, and cash counts only the paired paid attempt. `unpaired` stays valid and is the default.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFileSync, linkSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { aaArmFor, aaStackHash, BENCHMARK_AA_RECEIPT_VERSION, BENCHMARK_AA_VERSION, exactBinomialHalfPValue,
  IMMUTABLE_REVISION_RE, TRIAL_ID_RE, twoProportionPValue, type AaPinnedStack } from "./benchmark-aa.js";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "./benchmark-verified-outcome.js";
import { fixedClock, systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { buildEvalCard, normalQuantile, protocolHash as hashProtocolText, type EvalCard,
  type EvalCardEvidence, type EvalCardTrial } from "./eval-card.js";
import { fingerprintLedgerLine, ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import type { TaskCaseFile } from "./task-case-file.js";

export const BENCHMARK_PAID_PILOT_VERSION = "benchmark-paid-pilot-v1" as const;
export const PAID_PILOT_REQUEST_VERSION = "benchmark-paid-pilot-request-v1" as const;
export const PAID_PILOT_RECEIPT_VERSION = "benchmark-paid-pilot-receipt-v1" as const;
/** PRIMARY CONTROL: the operator-approved aggregate cash for the whole pilot (#7418), in API estimates. */
export const PAID_PILOT_CASH_CEILING_USD = 100;
/** PRIMARY CONTROL: the approved spend window, counted from activation and never from filing or build. */
export const PAID_PILOT_WINDOW_MS = 7 * 86_400_000;
/** PRIMARY CONTROL: an A/A receipt older than this at activation no longer vouches for the pipeline. */
export const PAID_PILOT_AA_RECEIPT_MAX_AGE_MS = 24 * 3_600_000;
export const PAID_PILOT_REPO_COUNT = 3;
export const PAID_PILOT_UNCERTAINTY_METHOD = "intention-to-treat difference in verified completion, two-sided Wald 95% interval" as const;
export const PAID_PILOT_STOPPING_RULE = "fixed horizon: one analysis at expiry plus the maturity window; no interim winner" as const;
export const PAIRED_UNCERTAINTY_METHOD = "paired: exact McNemar binomial test on discordant pairs, paired difference with a two-sided Wald 95% interval" as const;
/** BACKSTOP: the largest pair cap a paired protocol may pre-register; the cash ceiling is the primary control. */
export const PAIRED_MAX_PAIRS_CEILING = 500;
export const PAID_PILOT_CONTROL_VERSION = "benchmark-paid-pilot-control-v1" as const;
/** The paired trial's own ledger steps; no dispatch, review or merge reader consumes them. */
export const PAIRED_TRIAL_STEPS = { decision: "paired_trial.decision", spawn: "paired_trial.spawn",
  attempt: "paired_trial.attempt", pair: "paired_trial.pair" } as const;
export const REPO_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const REVISION_FIELDS = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"] as const;
const ARMS = ["paid", "control"] as const;
const BILLING = { paid: "api", control: "subscription" } as const;
const EVIDENCE_STEPS = ["worker.assignment", "worker.attempt", ...Object.values(PAIRED_TRIAL_STEPS)];
const PROTOCOL_SUFFIX = ".protocol.json";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type PaidPilotArm = typeof ARMS[number];
type RevisionField = typeof REVISION_FIELDS[number];
type ArmPin = { provider: string; model: string; effort: string };
export type PaidPilotDesign = "unpaired" | "paired";
/** The paired design's pre-registered sampler: a seeded task-level rate, a pair cap and the shadow flag. */
export type PairedDesign = { samplingRate: number; maxPairs: number; shadow: boolean };

export interface PaidPilotTask {
  taskId: string;
  repo: string;
  taskClass: string;
  risk: string;
}

export interface PaidPilotRequest {
  version: typeof PAID_PILOT_REQUEST_VERSION;
  pilotId: string;
  /** Provenance only: when the operator approved the spend. The clock never reads it. */
  approval: { reference: string; approvedAt: string | null };
  repos: { repo: string; consentReceipt: string }[];
  pseudonymSalt: string;
  assignmentSeed: string;
  arms: Record<PaidPilotArm, ArmPin>;
  revisions: Record<RevisionField, string>;
  strataRevision: string;
  population: PaidPilotTask[];
  primaryOutcome: "verified-completion";
  maturityDays: number;
  protocolText: string;
  design: PaidPilotDesign;
  paired: PairedDesign | null;
}

function parseDesign(raw: Record<string, unknown>): { design: PaidPilotDesign; paired: PairedDesign | null } | string {
  if (raw.design === undefined || raw.design === "unpaired")
    return raw.paired === undefined ? { design: "unpaired", paired: null } : "paired-settings-need-paired-design";
  if (raw.design !== "paired") return "design-invalid";
  const paired = record(raw.paired);
  if (paired === undefined) return "paired-settings-missing";
  const { samplingRate, maxPairs, shadow } = paired;
  if (typeof samplingRate !== "number" || !(samplingRate > 0 && samplingRate <= 1)) return "paired-sampling-rate-invalid";
  if (typeof maxPairs !== "number" || !Number.isInteger(maxPairs) || maxPairs < 1 || maxPairs > PAIRED_MAX_PAIRS_CEILING)
    return "paired-max-pairs-invalid";
  if (typeof shadow !== "boolean") return "paired-shadow-flag-required";
  return { design: "paired", paired: { samplingRate, maxPairs, shadow } };
}

function parsePopulation(value: unknown, repos: ReadonlySet<unknown>): PaidPilotTask[] | string {
  if (!Array.isArray(value) || value.length === 0) return "population-missing";
  const seen = new Set<string>();
  const tasks: PaidPilotTask[] = [];
  for (const entry of value.map(record)) {
    const [taskId, repo, taskClass, risk] = [text(entry?.taskId), text(entry?.repo), text(entry?.taskClass), text(entry?.risk)];
    if (taskId === null || repo === null || taskClass === null || risk === null) return "population-entry-invalid";
    if (!repos.has(repo)) return "population-repo-not-consented";
    if (seen.has(taskId)) return "population-task-duplicated";
    seen.add(taskId);
    tasks.push({ taskId, repo, taskClass, risk });
  }
  return tasks;
}

/** Refuses by name anything but three consented repos, two fully pinned arms and a pre-registered population. */
export function parsePaidPilotRequest(value: unknown): { ok: true; request: PaidPilotRequest } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const raw = record(value);
  if (raw?.version !== PAID_PILOT_REQUEST_VERSION) return refuse("request-version-unsupported");
  if (typeof raw.pilotId !== "string" || !TRIAL_ID_RE.test(raw.pilotId)) return refuse("pilot-id-invalid");
  const reference = text(record(raw.approval)?.reference);
  if (reference === null) return refuse("approval-reference-missing");
  const repos = Array.isArray(raw.repos) ? raw.repos.map(record) : [];
  const repoIds = new Set(repos.map((repo) => repo?.repo));
  if (repos.length !== PAID_PILOT_REPO_COUNT || repoIds.size !== PAID_PILOT_REPO_COUNT || repos.some((repo) =>
    typeof repo?.repo !== "string" || !REPO_IDENTITY_RE.test(repo.repo) || text(repo.consentReceipt) === null))
    return refuse("three-consented-repos-required");
  const pseudonymSalt = text(raw.pseudonymSalt);
  const assignmentSeed = text(raw.assignmentSeed);
  if (pseudonymSalt === null || assignmentSeed === null) return refuse("seed-and-salt-required");
  const arms: Record<string, ArmPin> = {};
  for (const arm of ARMS) {
    const pin = record(record(raw.arms)?.[arm]);
    const [provider, model, effort] = [text(pin?.provider), text(pin?.model), text(pin?.effort)];
    if (provider === null || model === null || effort === null) return refuse(`arm-not-pinned:${arm}`);
    arms[arm] = { provider, model, effort };
  }
  if (arms.paid!.model === arms.control!.model) return refuse("arms-must-differ-in-model");
  const revisions: Record<string, string> = {};
  for (const field of REVISION_FIELDS) {
    const revision = record(raw.revisions)?.[field];
    if (typeof revision !== "string" || !IMMUTABLE_REVISION_RE.test(revision)) return refuse(`revision-not-pinned:${field}`);
    revisions[field] = revision.toLowerCase();
  }
  const strataRevision = text(raw.strataRevision);
  if (strataRevision === null) return refuse("strata-revision-missing");
  const population = parsePopulation(raw.population, repoIds);
  if (typeof population === "string") return refuse(population);
  if (raw.primaryOutcome !== "verified-completion") return refuse("primary-outcome-must-be-verified-completion");
  const maturityDays = raw.maturityDays;
  if (typeof maturityDays !== "number" || !Number.isInteger(maturityDays) || maturityDays < 1 || maturityDays > 90)
    return refuse("maturity-days-invalid");
  const protocolText = text(raw.protocolText);
  if (protocolText === null) return refuse("protocol-text-missing");
  const design = parseDesign(raw);
  if (typeof design === "string") return refuse(design);
  return { ok: true, request: {
    version: PAID_PILOT_REQUEST_VERSION, pilotId: raw.pilotId,
    approval: { reference, approvedAt: text(record(raw.approval)?.approvedAt) },
    repos: repos.map((repo) => ({ repo: repo!.repo as string, consentReceipt: repo!.consentReceipt as string })),
    pseudonymSalt, assignmentSeed, arms: arms as Record<PaidPilotArm, ArmPin>,
    revisions: revisions as Record<RevisionField, string>, strataRevision, population,
    primaryOutcome: "verified-completion", maturityDays, protocolText, ...design,
  } };
}

/** The W1-T4575 draw, seeded by the pilot: no run, retry or spawn enters it, so no attempt moves a task. */
export function paidPilotArmFor(seed: string, taskId: string): PaidPilotArm {
  return aaArmFor(seed, taskId, ARMS) as PaidPilotArm;
}

export const PAIRED_SAMPLE_METHOD = "sha256(benchmark-paired-sample-v1, seed, taskId) first 32 bits / 2^32 < samplingRate" as const;

/** W1-T4625's task-level sampling draw in [0, 1): seeded, independent of the order draw, and stable per task. */
export function pairedSampleDraw(seed: string, taskId: string): number {
  return createHash("sha256").update(`benchmark-paired-sample-v1\0${seed}\0${taskId}`).digest().readUInt32BE(0) / 2 ** 32;
}

function pseudonym(salt: string, value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 16);
}

function allocationReceiptHash(seed: string, salt: string, population: readonly PaidPilotTask[]): string {
  return sha256(JSON.stringify(population.map((task) => ({ unit: pseudonym(salt, task.taskId),
    arm: paidPilotArmFor(seed, task.taskId), stratum: `${task.taskClass}|${task.risk}` }))
    .sort((a, b) => a.unit.localeCompare(b.unit))));
}

export interface PaidPilotAaCitation {
  version: typeof BENCHMARK_AA_RECEIPT_VERSION;
  trialId: string;
  asOf: string;
  verdict: "no-integrity-concern-detected";
  reportHash: string;
  allocationReceiptHash: string;
  stackHash: string;
}

/** A current, untampered A/A receipt with no integrity concern, or the named reason it is not one. */
function citeAaReceipt(value: unknown, nowMs: number): { ok: true; citation: PaidPilotAaCitation } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const report = record(value);
  if (report === undefined) return refuse("aa-receipt-missing");
  const { receipt: rawReceipt, ...body } = report;
  const receipt = record(rawReceipt);
  if (report.version !== BENCHMARK_AA_VERSION || receipt?.version !== BENCHMARK_AA_RECEIPT_VERSION) return refuse("aa-receipt-invalid");
  if (receipt.reportHash !== sha256(JSON.stringify(body))) return refuse("aa-receipt-hash-mismatch");
  const age = nowMs - Date.parse(String(receipt.asOf));
  if (receipt.state !== "observed" || !(age >= 0 && age <= PAID_PILOT_AA_RECEIPT_MAX_AGE_MS)) return refuse("aa-receipt-stale");
  if (receipt.verdict === "integrity-concerns") return refuse("aa-receipt-integrity-concerns");
  if (receipt.verdict !== "no-integrity-concern-detected" || receipt.winnerDeclared !== false) return refuse("aa-receipt-inconclusive");
  return { ok: true, citation: { version: BENCHMARK_AA_RECEIPT_VERSION, trialId: String(receipt.trialId), asOf: String(receipt.asOf),
    verdict: "no-integrity-concern-detected", reportHash: receipt.reportHash as string,
    allocationReceiptHash: String(receipt.allocationReceiptHash), stackHash: String(receipt.stackHash) } };
}

export interface PaidPilotProtocol {
  version: typeof BENCHMARK_PAID_PILOT_VERSION;
  pilotId: string;
  activation: "operator-command";
  activatedAt: string;
  expiresAt: string;
  /** Expiry plus the maturity window: the stopping rule's one analysis time. */
  analysisAt: string;
  approval: PaidPilotRequest["approval"];
  cash: { ceilingUsd: number; currency: "USD"; counts: "api-billed-worker-calls"; source: "worker-result-estimate-not-invoice" };
  repos: { repo: string; consentReceipt: string; pseudonym: string }[];
  pseudonymSalt: string;
  assignment: { seed: string; seedHash: string; unit: "task"; method: string; plannedAllocation: Record<PaidPilotArm, number>;
    receiptHash: string };
  population: (PaidPilotTask & { arm: PaidPilotArm })[];
  populationHash: string;
  arms: Record<PaidPilotArm, ArmPin & { billing: "api" | "subscription"; stackHash: string }>;
  revisions: Record<RevisionField, string>;
  strataRevision: string;
  primaryOutcome: "verified-completion";
  maturityDays: number;
  /** `paired`: every sampled task runs both arms, and `population[].arm` is the arm whose attempt runs first. */
  design: PaidPilotDesign;
  paired: (PairedDesign & { sampleMethod: string }) | null;
  uncertaintyMethod: typeof PAID_PILOT_UNCERTAINTY_METHOD | typeof PAIRED_UNCERTAINTY_METHOD;
  stoppingRule: typeof PAID_PILOT_STOPPING_RULE;
  aaReceipt: PaidPilotAaCitation;
  protocolText: string;
  protocolHash: string;
  digest: string;
}

export interface PaidPilotReceipt {
  version: typeof PAID_PILOT_RECEIPT_VERSION;
  pilotId: string;
  activatedAt: string;
  expiresAt: string;
  analysisAt: string;
  cashCeilingUsd: number;
  repoPseudonyms: string[];
  populationSize: number;
  populationHash: string;
  seedHash: string;
  allocationReceiptHash: string;
  armStackHashes: Record<PaidPilotArm, string>;
  primaryOutcome: "verified-completion";
  maturityDays: number;
  design: PaidPilotDesign;
  paired: PaidPilotProtocol["paired"];
  uncertaintyMethod: PaidPilotProtocol["uncertaintyMethod"];
  stoppingRule: typeof PAID_PILOT_STOPPING_RULE;
  aaReportHash: string;
  protocolHash: string;
  protocolDigest: string;
}

export interface PaidPilotActivationInput {
  request: PaidPilotRequest;
  /** The parsed `benchmark-aa-v1` report whose receipt vouches for the pipeline; undefined when unreadable. */
  aaReport: unknown;
  nowIso: string;
  /** Every pilot protocol already persisted; `expiresAt` null when it could not be read. A shadow protocol
   *  blocks only another shadow, so an operator can shadow a paired design before the live clock starts. */
  existing: readonly { pilotId: string; expiresAt: string | null; shadow?: boolean }[];
}

export type PaidPilotActivation = { ok: true; protocol: PaidPilotProtocol; receipt: PaidPilotReceipt } | { ok: false; reason: string };

/** Pure. The seven-day clock starts at `nowIso`, the activation, never at approval, filing or build. */
export function activateBenchmarkPaidPilot(input: PaidPilotActivationInput): PaidPilotActivation {
  const { request, nowIso } = input;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return { ok: false, reason: "activation-clock-invalid" };
  if (input.existing.some((entry) => entry.pilotId === request.pilotId)) return { ok: false, reason: "pilot-already-activated" };
  const shadow = request.paired?.shadow === true;
  if (input.existing.some((entry) => entry.expiresAt === null || ((entry.shadow === true) === shadow && Date.parse(entry.expiresAt) > nowMs)))
    return { ok: false, reason: "another-pilot-active" };
  const cited = citeAaReceipt(input.aaReport, nowMs);
  if (!cited.ok) return cited;
  const activatedAt = fixedClock(nowMs).iso();
  const expiresAt = fixedClock(nowMs + PAID_PILOT_WINDOW_MS).iso();
  const population = request.population.map((task) => ({ ...task, arm: paidPilotArmFor(request.assignmentSeed, task.taskId) }));
  const arms = Object.fromEntries(ARMS.map((arm) => [arm, { ...request.arms[arm], billing: BILLING[arm],
    stackHash: aaStackHash({ ...request.arms[arm], ...request.revisions } as AaPinnedStack) }])) as PaidPilotProtocol["arms"];
  const body: Omit<PaidPilotProtocol, "digest"> = {
    version: BENCHMARK_PAID_PILOT_VERSION, pilotId: request.pilotId, activation: "operator-command", activatedAt, expiresAt,
    analysisAt: fixedClock(nowMs + PAID_PILOT_WINDOW_MS + request.maturityDays * 86_400_000).iso(), approval: request.approval,
    cash: { ceilingUsd: PAID_PILOT_CASH_CEILING_USD, currency: "USD", counts: "api-billed-worker-calls",
      source: "worker-result-estimate-not-invoice" },
    repos: request.repos.map((repo) => ({ ...repo, pseudonym: pseudonym(request.pseudonymSalt, repo.repo) })),
    pseudonymSalt: request.pseudonymSalt,
    assignment: { seed: request.assignmentSeed, seedHash: sha256(request.assignmentSeed), unit: "task",
      method: "sha256(benchmark-aa-allocation-v1, seed, taskId) parity", plannedAllocation: { paid: 0.5, control: 0.5 },
      receiptHash: allocationReceiptHash(request.assignmentSeed, request.pseudonymSalt, request.population) },
    population, populationHash: sha256(JSON.stringify(population.map((task) => task.taskId).sort())),
    arms, revisions: request.revisions, strataRevision: request.strataRevision, primaryOutcome: request.primaryOutcome,
    maturityDays: request.maturityDays, design: request.design,
    paired: request.paired === null ? null : { ...request.paired, sampleMethod: PAIRED_SAMPLE_METHOD },
    uncertaintyMethod: request.design === "paired" ? PAIRED_UNCERTAINTY_METHOD : PAID_PILOT_UNCERTAINTY_METHOD, stoppingRule: PAID_PILOT_STOPPING_RULE,
    aaReceipt: cited.citation, protocolText: request.protocolText, protocolHash: hashProtocolText(request.protocolText),
  };
  const protocol: PaidPilotProtocol = { ...body, digest: sha256(JSON.stringify(body)) };
  const receipt: PaidPilotReceipt = {
    version: PAID_PILOT_RECEIPT_VERSION, pilotId: protocol.pilotId, activatedAt, expiresAt, analysisAt: protocol.analysisAt,
    cashCeilingUsd: protocol.cash.ceilingUsd, repoPseudonyms: protocol.repos.map((repo) => repo.pseudonym),
    populationSize: population.length, populationHash: protocol.populationHash, seedHash: protocol.assignment.seedHash,
    allocationReceiptHash: protocol.assignment.receiptHash, armStackHashes: { paid: arms.paid.stackHash, control: arms.control.stackHash },
    primaryOutcome: protocol.primaryOutcome, maturityDays: protocol.maturityDays, design: protocol.design, paired: protocol.paired,
    uncertaintyMethod: protocol.uncertaintyMethod,
    stoppingRule: protocol.stoppingRule, aaReportHash: cited.citation.reportHash, protocolHash: protocol.protocolHash,
    protocolDigest: protocol.digest,
  };
  return { ok: true, protocol, receipt };
}

/** A protocol whose bytes or whose draw no longer match what activation registered. */
function allocationDrift(protocol: PaidPilotProtocol): string | null {
  const { digest, ...body } = protocol;
  if (sha256(JSON.stringify(body)) !== digest) return "allocation-drift:protocol-changed";
  const redrawn = protocol.population.every((task) => task.arm === paidPilotArmFor(protocol.assignment.seed, task.taskId))
    && allocationReceiptHash(protocol.assignment.seed, protocol.pseudonymSalt, protocol.population) === protocol.assignment.receiptHash;
  return redrawn ? null : "allocation-drift:draw-changed";
}

const PAIRED_ROW_STEPS: ReadonlySet<string> = new Set(Object.values(PAIRED_TRIAL_STEPS));

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function armOrNull(value: unknown): PaidPilotArm | null {
  return value === "paid" || value === "control" ? value : null;
}

/** Only the paired trial's own whitelisted fields for THIS pilot survive; anything else on the row is dropped. */
function projectPairedFields(row: Record<string, unknown>, protocol: PaidPilotProtocol): PairedTrialRowFields | null {
  const paired = record(row.paired_trial);
  const pairId = text(paired?.pair_id);
  if (!PAIRED_ROW_STEPS.has(String(row.step)) || paired?.pilot_id !== protocol.pilotId || pairId === null) return null;
  const outcomes = record(paired.outcomes);
  return { pairId, arm: armOrNull(paired.arm), shadow: paired.shadow === true,
    sampled: typeof paired.sampled === "boolean" ? paired.sampled : null,
    admitted: typeof paired.admitted === "boolean" ? paired.admitted : null,
    order: Array.isArray(paired.order) && paired.order.length === 2 && paired.order.every((arm) => armOrNull(arm) !== null)
      ? paired.order as PaidPilotArm[] : null,
    reasons: strings(paired.reasons), deviations: strings(paired.stack_deviations),
    outcome: text(paired.outcome),
    outcomes: outcomes === undefined ? null : { paid: text(outcomes.paid) ?? "missing", control: text(outcomes.control) ?? "missing" },
    status: text(paired.status) };
}

function projectRow(row: Record<string, unknown>, protocol: PaidPilotProtocol): PaidPilotRow {
  const paired = projectPairedFields(row, protocol);
  const pairedRef = paired !== null && paired.arm !== null ? `${paired.pairId}:${paired.arm}` : null;
  const assignment = record(row.worker_assignment);
  const selected = record(assignment?.selected);
  const receipt = record(row.benchmark_run);
  const allocation = record(receipt?.allocation);
  const pins = REVISION_FIELDS.map((field) => record(record(receipt?.stack)?.[field]));
  const cost = row.total_cost_usd;
  return {
    ts: row.ts as string, step: row.step as string, taskId: row.task_id as string, runId: text(row.run_id),
    assignmentId: row.step === PAIRED_TRIAL_STEPS.spawn ? pairedRef : text(assignment?.id),
    selectionAssignmentId: row.step === PAIRED_TRIAL_STEPS.attempt ? pairedRef : text(row.selection_assignment_id),
    selected: { provider: text(selected?.provider), model: text(selected?.model), effort: text(selected?.effort) },
    recordedArm: allocation?.method === "randomized" && allocation.experimentId === protocol.pilotId ? text(allocation.arm) : null,
    revisionsOffPin: pins.filter((pin, i) => pin?.state === "observed"
      && String(pin.value).toLowerCase() !== protocol.revisions[REVISION_FIELDS[i]!]).length,
    revisionsUnpinned: pins.filter((pin) => pin?.state !== "observed").length,
    servedModel: text(row.served_model),
    billingMode: row.billing_mode === "api" || row.billing_mode === "subscription" ? row.billing_mode : null,
    cost: cost === undefined || cost === null ? { state: "missing" }
      : typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { state: "observed", usd: cost } : { state: "invalid" },
    paired,
  };
}

/** A paired-trial row's projected fields (W1-T4625): the decision, spawn marker, attempt and pair records. */
export interface PairedTrialRowFields {
  pairId: string;
  arm: PaidPilotArm | null;
  shadow: boolean;
  sampled: boolean | null;
  admitted: boolean | null;
  order: PaidPilotArm[] | null;
  reasons: string[];
  /** Stack deviations the trial recorded, such as an executing harness off the protocol's pin. */
  deviations: string[];
  outcome: string | null;
  outcomes: Record<PaidPilotArm, string> | null;
  status: string | null;
}

/** One projected, privacy-reduced pilot row: no host, prompt, account label or raw text survives it. */
export interface PaidPilotRow {
  ts: string;
  step: string;
  taskId: string;
  runId: string | null;
  assignmentId: string | null;
  selectionAssignmentId: string | null;
  selected: { provider: string | null; model: string | null; effort: string | null };
  recordedArm: string | null;
  revisionsOffPin: number;
  revisionsUnpinned: number;
  servedModel: string | null;
  billingMode: "api" | "subscription" | null;
  cost: { state: "observed"; usd: number } | { state: "missing" } | { state: "invalid" };
  /** Present only on this pilot's paired-trial rows. */
  paired: PairedTrialRowFields | null;
}

export interface PaidPilotEvidence {
  state: "observed" | "observed-partial" | "unavailable";
  reason?: string;
  forms: { gzip: number; plain: number; live: number };
  unreadSources: string[];
  /** Malformed rows in a source the spend window needs; a torn live tail is an append in flight, not damage. */
  malformedRows: number;
  duplicateRows: number;
  newestTs: string | null;
  rows: PaidPilotRow[];
}

function unavailableEvidence(reason: string, forms = { gzip: 0, plain: 0, live: 0 }, unreadSources: string[] = []): PaidPilotEvidence {
  return { state: "unavailable", reason, forms, unreadSources, malformedRows: 0, duplicateRows: 0, newestTs: null, rows: [] };
}

/** Streams the three-form union from activation on. A rotation stamped before activation holds no window row and is not opened. */
export async function readPaidPilotEvidence(stateDir: string, protocol: PaidPilotProtocol): Promise<PaidPilotEvidence> {
  let names: string[];
  try { names = readdirSync(stateDir); }
  catch {
    const reason = "spend-source-unreadable";
    return unavailableEvidence(reason);
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const forms = { gzip: rotations.filter((entry) => entry.form === "gzip").length,
    plain: rotations.filter((entry) => entry.form === "plain").length,
    live: names.includes(basename(ledgerLivePath(stateDir))) ? 1 : 0 };
  if (forms.live === 0) return unavailableEvidence("spend-source-missing", forms);
  const tasks = new Set(protocol.population.map((task) => task.taskId));
  const unread: string[] = [];
  const fingerprints = new Set<string>();
  const rows: PaidPilotRow[] = [];
  let malformedRows = 0;
  let duplicateRows = 0;
  let newestTs: string | null = null;
  for await (const row of openLedgerUnion(stateDir, {
    dedupe: false, sinceTs: protocol.activatedAt, step: EVIDENCE_STEPS,
    onUnreadArchive: (path) => unread.push(basename(path)),
    onUnreadLive: (path) => unread.push(basename(path)),
    onMalformedRow: (finding) => {
      if (finding.kind !== "live-torn-tail" && !(finding.timestamp !== undefined && finding.timestamp < protocol.activatedAt)) malformedRows += 1;
    },
    onAcceptedRecord: (accepted, raw) => {
      if (typeof accepted.task_id !== "string" || !tasks.has(accepted.task_id)) return;
      const fingerprint = fingerprintLedgerLine(raw);
      if (fingerprints.has(fingerprint)) { duplicateRows += 1; return; }
      fingerprints.add(fingerprint);
      const projected = projectRow(accepted, protocol);
      if (newestTs === null || projected.ts > newestTs) newestTs = projected.ts;
      rows.push(projected);
    },
  })) void row;
  if (unread.length > 0) return unavailableEvidence("spend-source-unreadable", forms, unread);
  return { state: malformedRows > 0 ? "observed-partial" : "observed", forms, unreadSources: [], malformedRows, duplicateRows, newestTs, rows };
}

type CostClass = "cash" | "notional" | "notional-price-missing" | "cash-price-missing" | "cash-price-invalid" | "billing-mode-not-reported";

function costClass(row: PaidPilotRow): CostClass {
  if (row.billingMode === null) return "billing-mode-not-reported";
  if (row.billingMode === "subscription") return row.cost.state === "observed" ? "notional" : "notional-price-missing";
  return row.cost.state === "observed" ? "cash" : row.cost.state === "missing" ? "cash-price-missing" : "cash-price-invalid";
}

function indexRows(rows: readonly PaidPilotRow[]) {
  const assignments = new Map<string, PaidPilotRow>();
  const byTask = new Map<string, PaidPilotRow[]>();
  const attempts = new Map<string, PaidPilotRow[]>();
  const unattributed: PaidPilotRow[] = [];
  for (const row of [...rows].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if ((row.step === "worker.assignment" || row.step === PAIRED_TRIAL_STEPS.spawn) && row.assignmentId !== null
      && !assignments.has(row.assignmentId)) {
      assignments.set(row.assignmentId, row);
      byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
    }
  }
  for (const row of rows) {
    if (row.step !== "worker.attempt" && row.step !== PAIRED_TRIAL_STEPS.attempt) continue;
    if (row.selectionAssignmentId !== null && assignments.has(row.selectionAssignmentId))
      attempts.set(row.selectionAssignmentId, [...(attempts.get(row.selectionAssignmentId) ?? []), row]);
    else unattributed.push(row);
  }
  return { assignments, byTask, attempts, unattributed };
}

export interface PaidPilotSpend {
  cashEstimateUsd: number;
  cashReceipts: number;
  /** Subscription notional cost: reported, never added to cash. */
  notionalUsd: number;
  notionalReceipts: number;
  /** A paid call with no usable cash price, or an assignment that must carry one and does not. */
  missingReceipts: number;
  /** A receipt whose billing mode or price cannot be read as either cash or subscription. */
  ambiguousReceipts: number;
  /** Recorded pilot labels that disagree with the registered draw. */
  labelDrift: number;
}

/** The rows a design spends through: a paired pilot counts only its own side attempts, never normal dispatch. */
function spendRows(rows: readonly PaidPilotRow[], protocol: PaidPilotProtocol): PaidPilotRow[] {
  return protocol.design === "paired"
    ? rows.filter((row) => row.paired !== null && (row.step === PAIRED_TRIAL_STEPS.spawn || row.step === PAIRED_TRIAL_STEPS.attempt))
    : rows.filter((row) => !PAIRED_ROW_STEPS.has(row.step));
}

/** Per-call accounting over distinct API-billed worker receipts. A replayed receipt counts once; a missing price is never zero.
 *  Paired: cash is the paid attempt alone, and an API-billed control attempt is ambiguous rather than cash. */
export function summarizePaidPilotSpend(rows: readonly PaidPilotRow[], protocol: PaidPilotProtocol): PaidPilotSpend {
  const armOf = new Map(protocol.population.map((task) => [task.taskId, task.arm]));
  const paired = protocol.design === "paired";
  const spend: PaidPilotSpend = { cashEstimateUsd: 0, cashReceipts: 0, notionalUsd: 0, notionalReceipts: 0, missingReceipts: 0,
    ambiguousReceipts: 0, labelDrift: 0 };
  const index = indexRows(spendRows(rows, protocol));
  for (const row of index.assignments.values()) {
    if (row.recordedArm !== null && row.recordedArm !== armOf.get(row.taskId)) spend.labelDrift += 1;
    const paidCall = paired ? row.paired?.arm === "paid" : armOf.get(row.taskId) === "paid" || row.selected.provider === "cash";
    if (!index.attempts.has(row.assignmentId!) && paidCall) spend.missingReceipts += 1;
  }
  for (const row of [...index.attempts.values()].flat()) {
    const classified = costClass(row);
    const kind = !paired || row.paired?.arm === "paid" ? classified : classified === "cash" ? "billing-mode-not-reported"
      : classified === "billing-mode-not-reported" ? "notional-price-missing" : classified;
    if (kind === "cash") { spend.cashEstimateUsd = Math.round((spend.cashEstimateUsd + (row.cost as { usd: number }).usd) * 1e6) / 1e6; spend.cashReceipts += 1; }
    else if (kind === "notional") { spend.notionalUsd = Math.round((spend.notionalUsd + (row.cost as { usd: number }).usd) * 1e6) / 1e6; spend.notionalReceipts += 1; }
    else if (kind === "cash-price-missing") spend.missingReceipts += 1;
    else if (kind !== "notional-price-missing") spend.ambiguousReceipts += 1;
  }
  spend.ambiguousReceipts += index.unattributed.filter((row) => row.billingMode !== "subscription").length;
  return spend;
}

/** Every reason the paid arm may not take new work now. Empty means it may; nothing here touches any other lane. */
export function paidArmPauseReasons(protocol: PaidPilotProtocol, evidence: PaidPilotEvidence, nowIso: string,
  nextCallReserveUsd = 0): { reasons: string[]; spend: PaidPilotSpend | null } {
  const reasons: string[] = [];
  const nowMs = Date.parse(nowIso);
  if (!(nowMs >= Date.parse(protocol.activatedAt))) reasons.push("pilot-not-started");
  if (!(nowMs < Date.parse(protocol.expiresAt))) reasons.push("pilot-window-expired");
  const drift = allocationDrift(protocol);
  if (drift !== null) reasons.push(drift);
  if (evidence.state === "unavailable") return { reasons: [...reasons, evidence.reason ?? "spend-source-unavailable"], spend: null };
  if (evidence.malformedRows > 0) reasons.push("spend-source-malformed");
  const spend = summarizePaidPilotSpend(evidence.rows, protocol);
  if (spend.missingReceipts > 0) reasons.push("cost-evidence-missing");
  if (spend.ambiguousReceipts > 0) reasons.push("cost-evidence-ambiguous");
  if (spend.labelDrift > 0) reasons.push("allocation-drift:recorded-label");
  if (spend.cashEstimateUsd + Math.max(0, nextCallReserveUsd) >= protocol.cash.ceilingUsd) reasons.push("cash-budget-exhausted");
  return { reasons, spend };
}

export interface PaidPilotAdmissionInput {
  /** null: no pilot activated. `unavailable`: a protocol exists but could not be read. */
  protocol: PaidPilotProtocol | { unavailable: string } | null;
  lane: string;
  taskId: string;
  nowIso: string;
  /** Consulted only for a paid-arm task; ordinary work never waits on it. */
  evidence: PaidPilotEvidence;
  nextCallReserveUsd?: number;
  /** The operator's append-only pause/resume control file, read by {@link readPaidPilotControls}. */
  controls?: PaidPilotControlState;
}

export interface PaidPilotAdmission {
  arm: PaidPilotArm | null;
  paidArm: "admitted" | "paused" | "not-applicable";
  reasons: string[];
  ordinaryFlow: "continues";
  remainingCashUsd: number | null;
}

/** The pure admission seam for the paid arm. Every answer keeps ordinary dispatch, review, CI and merge flowing. */
export function paidPilotArmAdmission(input: PaidPilotAdmissionInput): PaidPilotAdmission {
  const answer = (arm: PaidPilotArm | null, paidArm: PaidPilotAdmission["paidArm"], reasons: string[], remainingCashUsd: number | null = null) =>
    ({ arm, paidArm, reasons, ordinaryFlow: "continues" as const, remainingCashUsd });
  if (input.protocol === null) return answer(null, "not-applicable", ["no-activated-pilot"]);
  if ("unavailable" in input.protocol) return answer(null, "paused", [`protocol-unreadable:${input.protocol.unavailable}`]);
  const task = input.protocol.population.find((entry) => entry.taskId === input.taskId);
  if (input.lane !== "implement" || task === undefined) return answer(null, "not-applicable", ["not-pilot-work"]);
  if (input.protocol.design !== "paired" && task.arm === "control") return answer("control", "not-applicable", ["subscription-control-arm"]);
  const { reasons, spend } = paidArmPauseReasons(input.protocol, input.evidence, input.nowIso, input.nextCallReserveUsd);
  if (input.controls?.paused === true) reasons.push(input.controls.reason ?? "operator-paused");
  const remaining = spend === null ? null : Math.max(0, input.protocol.cash.ceilingUsd - spend.cashEstimateUsd);
  return answer("paid", reasons.length === 0 ? "admitted" : "paused", reasons, remaining);
}

type Tally = { observed: number; missing: number; noAttempt: number };

function tally(): Tally {
  return { observed: 0, missing: 0, noAttempt: 0 };
}

export interface PaidPilotCell {
  arm: PaidPilotArm;
  /** "*" is the arm's total across task classes. */
  taskClass: string;
  allocatedUnits: number;
  exposedUnits: number;
  nonStarters: number;
  assignments: number;
  crossovers: number;
  fallbacks: number;
  outcomes: { completed: number; failed: number; censored: number; unavailable: number; reasons: Record<string, number> };
  /** Intention to treat: every allocated task is in the denominator, non-starters included. */
  verifiedCompletion: { completed: number; denominator: number; rate: number | null };
  humanEffort: { state: "unavailable"; reason: string };
  recovery: { retries: number; repairRunsObserved: number };
  laterDefects: { state: "censored" | "unavailable"; reason: string; matureAt: string };
  accounting: { cashEstimate: { usd: number; receipts: number }; subscriptionNotional: { usd: number; receipts: number };
    unknown: { receipts: number; reasons: Record<string, number> } };
  missingness: { servedModel: Tally; billingMode: Tally; cost: Tally };
}

function blankCell(arm: PaidPilotArm, taskClass: string, laterDefects: PaidPilotCell["laterDefects"]): PaidPilotCell {
  return { arm, taskClass, allocatedUnits: 0, exposedUnits: 0, nonStarters: 0, assignments: 0, crossovers: 0, fallbacks: 0,
    outcomes: { completed: 0, failed: 0, censored: 0, unavailable: 0, reasons: {} },
    verifiedCompletion: { completed: 0, denominator: 0, rate: null },
    humanEffort: { state: "unavailable", reason: "no-independent-human-effort-receipt" },
    recovery: { retries: 0, repairRunsObserved: 0 }, laterDefects,
    accounting: { cashEstimate: { usd: 0, receipts: 0 }, subscriptionNotional: { usd: 0, receipts: 0 }, unknown: { receipts: 0, reasons: {} } },
    missingness: { servedModel: tally(), billingMode: tally(), cost: tally() } };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function account(cell: PaidPilotCell, call: PaidPilotRow): void {
  const kind = costClass(call);
  const usd = call.cost.state === "observed" ? call.cost.usd : 0;
  if (kind === "cash") { cell.accounting.cashEstimate.usd += usd; cell.accounting.cashEstimate.receipts += 1; }
  else if (kind === "notional") { cell.accounting.subscriptionNotional.usd += usd; cell.accounting.subscriptionNotional.receipts += 1; }
  else { cell.accounting.unknown.receipts += 1; bump(cell.accounting.unknown.reasons, kind); }
  cell.missingness.servedModel[call.servedModel === null ? "missing" : "observed"] += 1;
  cell.missingness.billingMode[call.billingMode === null ? "missing" : "observed"] += 1;
  cell.missingness.cost[call.cost.state === "observed" ? "observed" : "missing"] += 1;
}

type Disposition = { state: "completed" | "failed" | "censored" | "unavailable"; reason?: string; repairRuns: number };

function unitDisposition(assignments: VerifiedAssignment[], files: readonly TaskCaseFile[] | undefined, cutoff: string): Disposition {
  if (assignments.length === 0) return { state: "unavailable", reason: "non-starter", repairRuns: 0 };
  if (files === undefined) return { state: "unavailable", reason: "no-verified-outcome-join", repairRuns: 0 };
  const joined = joinVerifiedTaskOutcomes(assignments, files, cutoff);
  const repairRuns = joined.groups.reduce((sum, group) => sum + group.repairRunsObserved, 0);
  if (joined.coverage.completed > 0) return { state: "completed", repairRuns };
  if (joined.coverage.reasons["closed-unmerged-unadjudicated"]) return { state: "failed", repairRuns };
  if (joined.coverage.censored > 0) return { state: "censored", reason: "open-at-cutoff", repairRuns };
  return { state: "unavailable", reason: Object.keys(joined.coverage.reasons)[0]!, repairRuns };
}

export type PaidPilotDifference = { estimate: number; low: number; high: number; pValue: number } | { unavailable: string };

function ittDifference(paid: PaidPilotCell, control: PaidPilotCell): PaidPilotDifference {
  const [n1, n2] = [paid.allocatedUnits, control.allocatedUnits];
  if (n1 === 0 || n2 === 0) return { unavailable: "an-arm-has-no-allocated-units" };
  const [p1, p2] = [paid.outcomes.completed / n1, control.outcomes.completed / n2];
  const se = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  const z = normalQuantile(0.975);
  return { estimate: p1 - p2, low: p1 - p2 - z * se, high: p1 - p2 + z * se,
    pValue: twoProportionPValue(paid.outcomes.completed, n1, control.outcomes.completed, n2) };
}

export interface PaidPilotReportInput {
  protocol: PaidPilotProtocol;
  evidence: PaidPilotEvidence;
  nowIso: string;
  caseFiles?: readonly TaskCaseFile[];
  /** The last persisted report: kept and dated when this projection cannot read its sources. */
  prior?: PaidPilotReport;
}

export interface PaidPilotReport {
  version: typeof BENCHMARK_PAID_PILOT_VERSION;
  pilotId: string;
  state: "observed" | "observed-partial" | "stale" | "unavailable";
  unavailableReason: string | null;
  asOf: string;
  lastGoodAt: string | null;
  visibility: "private";
  export: "none";
  publicClaim: "requires-reviewed-release";
  protocolDigest: string;
  window: { activatedAt: string; expiresAt: string; analysisAt: string; expired: boolean };
  cash: { ceilingUsd: number; spentEstimateUsd: number | null; remainingUsd: number | null;
    source: "worker-result-estimate-not-invoice"; invoice: "unavailable-no-invoice-receipt"; subscriptionNotionalUsd: number | null };
  paidArm: { state: "admitting" | "paused"; reasons: string[] };
  sources: { forms: PaidPilotEvidence["forms"]; unreadSources: string[]; malformedRows: number; duplicateRows: number; newestTs: string | null };
  stack: { revisions: PaidPilotProtocol["revisions"]; strataRevision: string; arms: PaidPilotProtocol["arms"];
    offPinExposures: number; unpinnedExposures: number };
  cells: PaidPilotCell[];
  sampleRatio: { exposed: Record<PaidPilotArm, number>; exactBinomialPValue: number | null };
  uncertainty: { method: typeof PAID_PILOT_UNCERTAINTY_METHOD; difference: PaidPilotDifference };
  stoppingRule: { rule: typeof PAID_PILOT_STOPPING_RULE; met: boolean; analysisAt: string };
  conclusion: { state: "no-conclusion" | "inconclusive"; reason: string } | { state: "difference-observed"; favors: PaidPilotArm };
  /** True only once the stopping rule is met and the interval excludes zero; still private and unpublished. */
  winnerDeclared: boolean;
  evalCard: EvalCard | null;
  /** The evidence `evalCard` was built from; its trial is {@link paidPilotEvalCardTrial} over the protocol. */
  evalCardEvidence: EvalCardEvidence | null;
  followUps: { kind: "repair"; reason: string; action: string }[];
}

function reportFrame(protocol: PaidPilotProtocol, nowIso: string, reason: string): PaidPilotReport {
  return {
    version: BENCHMARK_PAID_PILOT_VERSION, pilotId: protocol.pilotId, state: "unavailable", unavailableReason: reason,
    asOf: nowIso, lastGoodAt: null, visibility: "private", export: "none", publicClaim: "requires-reviewed-release",
    protocolDigest: protocol.digest,
    window: { activatedAt: protocol.activatedAt, expiresAt: protocol.expiresAt, analysisAt: protocol.analysisAt,
      expired: !(Date.parse(nowIso) < Date.parse(protocol.expiresAt)) },
    cash: { ceilingUsd: protocol.cash.ceilingUsd, spentEstimateUsd: null, remainingUsd: null, source: "worker-result-estimate-not-invoice",
      invoice: "unavailable-no-invoice-receipt", subscriptionNotionalUsd: null },
    paidArm: { state: "paused", reasons: [reason] },
    sources: { forms: { gzip: 0, plain: 0, live: 0 }, unreadSources: [], malformedRows: 0, duplicateRows: 0, newestTs: null },
    stack: { revisions: protocol.revisions, strataRevision: protocol.strataRevision, arms: protocol.arms, offPinExposures: 0, unpinnedExposures: 0 },
    cells: [], sampleRatio: { exposed: { paid: 0, control: 0 }, exactBinomialPValue: null },
    uncertainty: { method: PAID_PILOT_UNCERTAINTY_METHOD, difference: { unavailable: reason } },
    stoppingRule: { rule: PAID_PILOT_STOPPING_RULE, met: false, analysisAt: protocol.analysisAt },
    conclusion: { state: "no-conclusion", reason }, winnerDeclared: false, evalCard: null, evalCardEvidence: null, followUps: [],
  };
}

/** A projection that cannot read its sources keeps the last dated report, names why, and asks for its repair. */
function projectionUnavailable(input: PaidPilotReportInput): PaidPilotReport {
  const reason = input.evidence.reason ?? "spend-source-unavailable";
  const paidArm = { state: "paused" as const, reasons: paidArmPauseReasons(input.protocol, input.evidence, input.nowIso).reasons };
  const followUps = [{ kind: "repair" as const, reason,
    action: `file a task: restore the ledger source the paid pilot's spend window needs (${reason}); the paid arm stays paused until it reads` }];
  const prior = input.prior;
  if (prior?.version === BENCHMARK_PAID_PILOT_VERSION && prior.pilotId === input.protocol.pilotId && prior.lastGoodAt !== null)
    return { ...prior, state: "stale", unavailableReason: reason, asOf: input.nowIso, paidArm, followUps,
      sources: { ...prior.sources, unreadSources: input.evidence.unreadSources } };
  const frame = reportFrame(input.protocol, input.nowIso, reason);
  return { ...frame, paidArm, followUps, sources: { ...frame.sources, forms: input.evidence.forms, unreadSources: input.evidence.unreadSources } };
}

/** The pilot's eval-card trial, built from its persisted protocol alone. */
export function paidPilotEvalCardTrial(protocol: PaidPilotProtocol): EvalCardTrial {
  const classes = [...new Set(protocol.population.map((task) => task.taskClass))].sort();
  return { trialId: protocol.pilotId, kind: "paid-pilot", protocolText: protocol.protocolText,
    preRegisteredAt: protocol.activatedAt, registeredProtocolHash: protocol.protocolHash,
    estimand: "intention-to-treat difference in verified completion, paid arm minus subscription control",
    randomizationUnit: "task", propensity: protocol.assignment.method, plannedAllocation: protocol.assignment.plannedAllocation,
    cells: ARMS.flatMap((arm) => classes.map((taskClass) => `${arm}|${taskClass}`)), aaReceipt: protocol.aaReceipt.reportHash };
}

/** Build the private pilot report. Pure over its input; the operator verb supplies the ledger, case files and prior. */
export function buildPaidPilotReport(input: PaidPilotReportInput): PaidPilotReport {
  const { protocol, evidence, nowIso } = input;
  if (evidence.state === "unavailable") return projectionUnavailable(input);
  const pause = paidArmPauseReasons(protocol, evidence, nowIso);
  const spend = pause.spend!;
  const index = indexRows(spendRows(evidence.rows, protocol));
  const filesByTask = new Map<string, TaskCaseFile[]>();
  for (const file of input.caseFiles ?? []) filesByTask.set(file.taskId, [...(filesByTask.get(file.taskId) ?? []), file]);
  const met = !(Date.parse(nowIso) < Date.parse(protocol.analysisAt));
  const laterDefects: PaidPilotCell["laterDefects"] = met
    ? { state: "unavailable", reason: "no-follow-up-defect-source", matureAt: protocol.analysisAt }
    : { state: "censored", reason: "maturity-window-open", matureAt: protocol.analysisAt };
  const cells = new Map<string, PaidPilotCell>();
  const cellFor = (arm: PaidPilotArm, taskClass: string): PaidPilotCell => {
    const key = `${arm}|${taskClass}`;
    if (!cells.has(key)) cells.set(key, blankCell(arm, taskClass, laterDefects));
    return cells.get(key)!;
  };
  for (const arm of ARMS) cellFor(arm, "*");
  const card: EvalCardEvidence = { assignments: [], outcomes: [], reviewRows: [], deviations: [] };
  let offPinExposures = 0;
  let unpinnedExposures = 0;
  for (const task of protocol.population) {
    const own = protocol.arms[task.arm];
    const other = protocol.arms[task.arm === "paid" ? "control" : "paid"];
    const unit = pseudonym(protocol.pseudonymSalt, task.taskId);
    const exposures = index.byTask.get(task.taskId) ?? [];
    const verified: VerifiedAssignment[] = [];
    const calls: PaidPilotRow[] = [];
    let crossovers = 0;
    let fallbacks = 0;
    for (const exposure of exposures) {
      const attempts = index.attempts.get(exposure.assignmentId!) ?? [];
      calls.push(...attempts);
      if (exposure.selected.model === other.model) crossovers += 1;
      else if (exposure.selected.provider !== own.provider || exposure.selected.model !== own.model || exposure.selected.effort !== own.effort
        || attempts.some((call) => call.servedModel !== null && call.servedModel !== own.model)) fallbacks += 1;
      if (exposure.revisionsOffPin > 0) offPinExposures += 1;
      if (exposure.revisionsUnpinned > 0) unpinnedExposures += 1;
      const last = attempts[attempts.length - 1];
      verified.push({ assignmentId: exposure.assignmentId!, taskId: task.taskId, runId: exposure.runId, assignedAt: exposure.ts,
        taskClass: task.taskClass, selectedModel: exposure.selected.model, servedModel: last?.servedModel ?? null,
        billingMode: last?.billingMode ?? null, costUsd: last?.cost.state === "observed" ? last.cost.usd : null, attempted: last !== undefined });
      card.assignments.push({ unitId: unit, arm: exposure.recordedArm ?? task.arm, assignedAt: exposure.ts, taskId: unit });
    }
    const disposition = unitDisposition(verified, filesByTask.get(task.taskId) ?? (input.caseFiles ? [] : undefined), nowIso);
    for (const cell of [cellFor(task.arm, task.taskClass), cellFor(task.arm, "*")]) {
      cell.allocatedUnits += 1;
      if (exposures.length === 0) cell.nonStarters += 1;
      else cell.exposedUnits += 1;
      cell.assignments += exposures.length;
      cell.crossovers += crossovers;
      cell.fallbacks += fallbacks;
      cell.recovery.retries += Math.max(0, exposures.length - 1);
      cell.recovery.repairRunsObserved += disposition.repairRuns;
      cell.outcomes[disposition.state] += 1;
      if (disposition.reason !== undefined) bump(cell.outcomes.reasons, disposition.reason);
      for (const call of calls) account(cell, call);
      const noAttempt = exposures.filter((exposure) => !index.attempts.has(exposure.assignmentId!)).length;
      for (const field of ["servedModel", "billingMode", "cost"] as const) cell.missingness[field].noAttempt += noAttempt;
    }
    card.outcomes.push({ unitId: unit, arm: task.arm, stratum: task.taskClass,
      success: disposition.state === "completed" ? true : disposition.state === "failed" ? false : null });
  }
  for (const cell of cells.values()) cell.verifiedCompletion = { completed: cell.outcomes.completed, denominator: cell.allocatedUnits,
    rate: cell.allocatedUnits > 0 ? cell.outcomes.completed / cell.allocatedUnits : null };
  const [paid, control] = [cellFor("paid", "*"), cellFor("control", "*")];
  const difference = ittDifference(paid, control);
  const decisive = !("unavailable" in difference) && (difference.low > 0 || difference.high < 0) && difference.pValue < 0.05;
  const exposedTotal = paid.exposedUnits + control.exposedUnits;
  return {
    ...reportFrame(protocol, nowIso, ""), state: evidence.state, unavailableReason: null, lastGoodAt: nowIso,
    cash: { ceilingUsd: protocol.cash.ceilingUsd, spentEstimateUsd: spend.cashEstimateUsd,
      remainingUsd: Math.max(0, protocol.cash.ceilingUsd - spend.cashEstimateUsd), source: "worker-result-estimate-not-invoice",
      invoice: "unavailable-no-invoice-receipt", subscriptionNotionalUsd: spend.notionalUsd },
    paidArm: { state: pause.reasons.length === 0 ? "admitting" : "paused", reasons: pause.reasons },
    sources: { forms: evidence.forms, unreadSources: [], malformedRows: evidence.malformedRows, duplicateRows: evidence.duplicateRows,
      newestTs: evidence.newestTs },
    stack: { revisions: protocol.revisions, strataRevision: protocol.strataRevision, arms: protocol.arms, offPinExposures, unpinnedExposures },
    cells: [...cells.values()].sort((a, b) => `${a.arm}|${a.taskClass}`.localeCompare(`${b.arm}|${b.taskClass}`)),
    sampleRatio: { exposed: { paid: paid.exposedUnits, control: control.exposedUnits },
      exactBinomialPValue: exposedTotal > 0 ? exactBinomialHalfPValue(paid.exposedUnits, exposedTotal) : null },
    uncertainty: { method: PAID_PILOT_UNCERTAINTY_METHOD, difference },
    stoppingRule: { rule: PAID_PILOT_STOPPING_RULE, met, analysisAt: protocol.analysisAt },
    conclusion: !met ? { state: "no-conclusion", reason: "stopping-rule-not-met" }
      : "unavailable" in difference ? { state: "inconclusive", reason: difference.unavailable }
      : decisive ? { state: "difference-observed", favors: difference.estimate > 0 ? "paid" : "control" }
      : { state: "inconclusive", reason: "no-decisive-difference" },
    winnerDeclared: met && decisive,
    evalCard: buildEvalCard(paidPilotEvalCardTrial(protocol), card), evalCardEvidence: card,
  };
}

function protocolPath(stateDir: string, pilotId: string): string {
  return join(stateDir, `${BENCHMARK_PAID_PILOT_VERSION}.${pilotId}${PROTOCOL_SUFFIX}`);
}

/** The persisted protocol, or the named reason it cannot be read. */
export function loadPaidPilotProtocol(stateDir: string, pilotId: string): { ok: true; protocol: PaidPilotProtocol } | { ok: false; reason: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(protocolPath(stateDir, pilotId), "utf8")); }
  catch {
    const reason = "protocol-unreadable-or-not-activated";
    return { ok: false, reason };
  }
  const protocol = record(record(parsed)?.protocol);
  if (protocol?.version !== BENCHMARK_PAID_PILOT_VERSION || protocol.pilotId !== pilotId) return { ok: false, reason: "protocol-invalid" };
  return { ok: true, protocol: protocol as unknown as PaidPilotProtocol };
}

function listPaidPilotProtocols(stateDir: string): { ok: true; entries: { pilotId: string; expiresAt: string | null; shadow: boolean;
  protocol: PaidPilotProtocol | null }[] } | { ok: false; reason: string } {
  let names: string[];
  try { names = readdirSync(stateDir); }
  catch {
    const reason = "state-dir-unreadable";
    return { ok: false, reason };
  }
  const prefix = `${BENCHMARK_PAID_PILOT_VERSION}.`;
  return { ok: true, entries: names.filter((name) => name.startsWith(prefix) && name.endsWith(PROTOCOL_SUFFIX)).map((name) => {
    const pilotId = name.slice(prefix.length, -PROTOCOL_SUFFIX.length);
    const loaded = loadPaidPilotProtocol(stateDir, pilotId);
    return { pilotId, expiresAt: loaded.ok && typeof loaded.protocol.expiresAt === "string" ? loaded.protocol.expiresAt : null,
      shadow: loaded.ok && loaded.protocol.paired?.shadow === true, protocol: loaded.ok ? loaded.protocol : null };
  }) };
}

/** Every readable protocol whose window holds `nowIso`. An unreadable state dir proves no pilot active, so it answers none. */
export function activePaidPilotProtocols(stateDir: string, nowIso: string): PaidPilotProtocol[] {
  const listed = listPaidPilotProtocols(stateDir);
  if (!listed.ok) return [];
  const nowMs = Date.parse(nowIso);
  return listed.entries.flatMap(({ protocol }) => protocol !== null && Date.parse(protocol.activatedAt) <= nowMs
    && nowMs < Date.parse(protocol.expiresAt) ? [protocol] : []);
}

function controlsPath(stateDir: string, pilotId: string): string {
  return join(stateDir, `${BENCHMARK_PAID_PILOT_VERSION}.${pilotId}.controls.ndjson`);
}

export interface PaidPilotControlState {
  state: "observed" | "unavailable";
  paused: boolean;
  /** Why the paid arm is held; null while it is not. */
  reason: string | null;
  entries: number;
  lastAction: "pause" | "resume" | null;
  lastAt: string | null;
}

/** The operator's append-only control file; the newest entry wins. Unreadable or malformed holds the paid arm. */
export function readPaidPilotControls(stateDir: string, pilotId: string): PaidPilotControlState {
  const held = (reason: string): PaidPilotControlState => ({ state: "unavailable", paused: true, reason, entries: 0, lastAction: null, lastAt: null });
  let raw: string;
  try { raw = readFileSync(controlsPath(stateDir, pilotId), "utf8"); }
  catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no-control-file" : "controls-unreadable";
    return reason === "no-control-file" ? { state: "observed", paused: false, reason: null, entries: 0, lastAction: null, lastAt: null } : held(reason);
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  let last: Record<string, unknown> | undefined;
  for (const line of lines) {
    try { last = record(JSON.parse(line)); }
    catch {
      const reason = "controls-malformed";
      return held(reason);
    }
    if (last?.version !== PAID_PILOT_CONTROL_VERSION || last.pilotId !== pilotId || (last.action !== "pause" && last.action !== "resume"))
      return held("controls-malformed");
  }
  const lastAction = last === undefined ? null : last.action as "pause" | "resume";
  return { state: "observed", paused: lastAction === "pause", reason: lastAction === "pause" ? "operator-paused" : null,
    entries: lines.length, lastAction, lastAt: last === undefined ? null : text(last.at) };
}

/** Append one pause or resume. Append-only: an entry is never rewritten, so the file is its own audit trail. */
export function appendPaidPilotControl(stateDir: string, pilotId: string, action: "pause" | "resume", nowIso: string, note: string | null): string {
  const path = controlsPath(stateDir, pilotId);
  appendFileSync(path, `${JSON.stringify({ version: PAID_PILOT_CONTROL_VERSION, pilotId, action, at: nowIso, note })}\n`, { flag: "a" });
  return path;
}

/** Exclusive publish: link refuses an existing path, so a protocol is written once and never overwritten. */
function persistOnce(path: string, content: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`);
  try { linkSync(temporary, path); }
  finally { unlinkSync(temporary); }
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try { return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) }; }
  catch {
    const reason = "file-unreadable";
    return { ok: false, reason };
  }
}

/** A paired protocol's report view, built by paired-trial.ts and injected so this module never imports it. */
export interface PairedPilotReportView {
  report: Record<string, unknown>;
  lines: string[];
  observed: boolean;
}

export interface BenchmarkPaidPilotCommandInput {
  nowIso?: string;
  print?: (line: string) => void;
  resolveStateDir?: () => string;
  readEvidence?: (stateDir: string, protocol: PaidPilotProtocol) => Promise<PaidPilotEvidence>;
  pairedReport?: (input: { protocol: PaidPilotProtocol; evidence: PaidPilotEvidence; nowIso: string }) => PairedPilotReportView;
}

const USAGE = "usage: rmd benchmark-paid-pilot activate --request <request.json> --aa-report <aa-report.json> "
  + "[--state-dir <dir>] [--json] | rmd benchmark-paid-pilot report --pilot <id> "
  + "[--case-files <snapshot.json>] [--out <report.json>] [--state-dir <dir>] [--json] | rmd benchmark-paid-pilot pause|resume "
  + "--pilot <id> [--note <text>] [--state-dir <dir>]";

function activateCommand(values: Record<string, string | boolean | undefined>, stateDir: string, nowIso: string,
  activate: (input: PaidPilotActivationInput) => PaidPilotActivation, print: (line: string) => void): number {
  const refuse = (reason: string) => { print(`benchmark-paid-pilot: activation refused (${reason}); nothing was activated`); return 2; };
  if (typeof values.request !== "string" || typeof values["aa-report"] !== "string") return refuse("request-and-aa-report-required");
  const raw = readJson(values.request);
  const parsed = raw.ok ? parsePaidPilotRequest(raw.value) : { ok: false as const, reason: "request-unreadable" };
  if (!parsed.ok) return refuse(parsed.reason);
  const existing = listPaidPilotProtocols(stateDir);
  if (!existing.ok) return refuse(existing.reason);
  const aa = readJson(values["aa-report"]);
  const result = activate({ request: parsed.request, aaReport: aa.ok ? aa.value : undefined, nowIso, existing: existing.entries });
  if (!result.ok) return refuse(result.reason);
  const path = protocolPath(stateDir, result.protocol.pilotId);
  try { persistOnce(path, { protocol: result.protocol, receipt: result.receipt }); }
  catch {
    const reason = "protocol-not-persisted";
    return refuse(reason);
  }
  if (values.json === true) print(JSON.stringify(result.receipt));
  else print(`benchmark-paid-pilot ${result.protocol.pilotId}: activated ${result.protocol.activatedAt}, expires `
    + `${result.protocol.expiresAt}; cash ceiling $${result.protocol.cash.ceilingUsd.toFixed(2)} in API estimates, never an invoice; `
    + `A/A receipt ${result.protocol.aaReceipt.reportHash.slice(0, 16)}; protocol written to ${path}`);
  return 0;
}

function readCaseFiles(path: string): TaskCaseFile[] | string {
  const raw = readJson(path);
  if (!raw.ok) return "case-file-snapshot-unreadable";
  return Array.isArray(raw.value) && raw.value.every((file) => record(file)?.version === "task-case-file-v1"
    && typeof record(file)?.taskId === "string") ? raw.value as TaskCaseFile[] : "case-file-snapshot-invalid";
}

function readPrior(path: string, pilotId: string): { prior?: PaidPilotReport } {
  const raw = readJson(path);
  const prior = record(raw.ok ? raw.value : undefined);
  return prior?.version === BENCHMARK_PAID_PILOT_VERSION && prior.pilotId === pilotId ? { prior: prior as unknown as PaidPilotReport } : {};
}

function writeAtomically(path: string, report: PaidPilotReport | Record<string, unknown>): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, path);
}

function pairedReportCommand(values: Record<string, string | boolean | undefined>, protocol: PaidPilotProtocol, evidence: PaidPilotEvidence,
  nowIso: string, out: string, pairedReport: BenchmarkPaidPilotCommandInput["pairedReport"], print: (line: string) => void): number {
  if (pairedReport === undefined) { print("benchmark-paid-pilot: report refused (paired-report-not-wired)"); return 2; }
  const view = pairedReport({ protocol, evidence, nowIso });
  try { writeAtomically(out, view.report); }
  catch {
    const reason = "report-not-persisted";
    print(`benchmark-paid-pilot: ${reason} (${out})`);
  }
  if (values.json === true) print(JSON.stringify(view.report));
  else for (const line of view.lines) print(line);
  return view.observed ? 0 : 1;
}

function controlCommand(action: "pause" | "resume", values: Record<string, string | boolean | undefined>, stateDir: string, nowIso: string,
  print: (line: string) => void): number {
  if (typeof values.pilot !== "string" || !TRIAL_ID_RE.test(values.pilot)) { print(USAGE); return 2; }
  const loaded = loadPaidPilotProtocol(stateDir, values.pilot);
  if (!loaded.ok) { print(`benchmark-paid-pilot: ${action} refused (${loaded.reason})`); return 2; }
  let path: string;
  try { path = appendPaidPilotControl(stateDir, values.pilot, action, nowIso, typeof values.note === "string" ? values.note : null); }
  catch {
    const reason = "control-not-recorded";
    print(`benchmark-paid-pilot: ${action} refused (${reason})`);
    return 2;
  }
  print(action === "pause"
    ? `benchmark-paid-pilot ${values.pilot}: paused at ${nowIso}; no new pair or paid-arm work is admitted, in-flight attempts finish; control file ${path}`
    : `benchmark-paid-pilot ${values.pilot}: resumed at ${nowIso}; admission reads the ordinary pause reasons again; control file ${path}`);
  return 0;
}

async function reportCommand(values: Record<string, string | boolean | undefined>, stateDir: string, nowIso: string,
  readEvidence: (stateDir: string, protocol: PaidPilotProtocol) => Promise<PaidPilotEvidence>, print: (line: string) => void,
  pairedReport?: BenchmarkPaidPilotCommandInput["pairedReport"]): Promise<number> {
  if (typeof values.pilot !== "string" || !TRIAL_ID_RE.test(values.pilot)) { print(USAGE); return 2; }
  const loaded = loadPaidPilotProtocol(stateDir, values.pilot);
  if (!loaded.ok) { print(`benchmark-paid-pilot: report refused (${loaded.reason})`); return 2; }
  const caseFiles = typeof values["case-files"] === "string" ? readCaseFiles(values["case-files"]) : undefined;
  if (typeof caseFiles === "string") { print(`benchmark-paid-pilot: report refused (${caseFiles})`); return 2; }
  const out = typeof values.out === "string" ? values.out : join(stateDir, `${BENCHMARK_PAID_PILOT_VERSION}.${values.pilot}.report.json`);
  let evidence: PaidPilotEvidence;
  try { evidence = await readEvidence(stateDir, loaded.protocol); }
  catch {
    const reason = "spend-source-read-failed";
    evidence = unavailableEvidence(reason);
  }
  if (loaded.protocol.design === "paired") return pairedReportCommand(values, loaded.protocol, evidence, nowIso, out, pairedReport, print);
  const report = buildPaidPilotReport({ protocol: loaded.protocol, evidence, nowIso, ...(caseFiles ? { caseFiles } : {}),
    ...readPrior(out, values.pilot) });
  try { writeAtomically(out, report); }
  catch {
    const reason = "report-not-persisted";
    print(`benchmark-paid-pilot: ${reason} (${out})`);
  }
  if (values.json === true) print(JSON.stringify(report));
  else {
    print(`benchmark-paid-pilot ${report.pilotId}: ${report.state}${report.unavailableReason ? ` (${report.unavailableReason})` : ""}; `
      + `paid arm ${report.paidArm.state}${report.paidArm.reasons.length > 0 ? ` (${report.paidArm.reasons.join(", ")})` : ""}`);
    print(`  window ${report.window.activatedAt} to ${report.window.expiresAt}; cash estimate `
      + `${report.cash.spentEstimateUsd === null ? "unknown" : `$${report.cash.spentEstimateUsd.toFixed(2)}`} of `
      + `$${report.cash.ceilingUsd.toFixed(2)}; subscription notional reported apart; conclusion ${report.conclusion.state}; no public export`);
    for (const followUp of report.followUps) print(`  follow-up: ${followUp.action}`);
  }
  return report.state === "observed" || report.state === "observed-partial" ? 0 : 1;
}

/** The operator verb. `activate` is the only path that starts the pilot; `report` reads and writes only its own report file;
 *  `pause`/`resume` append to the control file admission reads. */
export async function benchmarkPaidPilotCommand(rest: string[], activate: (input: PaidPilotActivationInput) => PaidPilotActivation,
  input: BenchmarkPaidPilotCommandInput = {}): Promise<number> {
  const print = input.print ?? ((line: string) => console.log(line));
  const [verb, ...args] = rest;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args, strict: true, allowPositionals: false, options: {
      request: { type: "string" }, "aa-report": { type: "string" },
      pilot: { type: "string" }, "case-files": { type: "string" }, out: { type: "string" }, "state-dir": { type: "string" },
      note: { type: "string" }, json: { type: "boolean" } } }).values;
  } catch {
    const reason = "arguments-invalid";
    print(`${USAGE} (${reason})`);
    return 2;
  }
  if (verb !== "activate" && verb !== "report" && verb !== "pause" && verb !== "resume") { print(USAGE); return 2; }
  const stateDir = typeof values["state-dir"] === "string" ? values["state-dir"]
    : (input.resolveStateDir ?? (() => join(loadConfig().root, "state")))();
  const nowIso = input.nowIso ?? systemClock.iso();
  if (verb === "activate") return activateCommand(values, stateDir, nowIso, activate, print);
  if (verb === "pause" || verb === "resume") return controlCommand(verb, values, stateDir, nowIso, print);
  return reportCommand(values, stateDir, nowIso, input.readEvidence ?? readPaidPilotEvidence, print, input.pairedReport);
}
