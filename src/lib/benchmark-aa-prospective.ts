/**
 * lib/benchmark-aa-prospective.ts — W1-T4647: a PROSPECTIVE A/A. A retrospective A/A over fleet history cannot read
 * clean, because that history never ran on one pinned stack. Here the operator registers a `benchmark-aa-trial-v1`
 * manifest; when normal dispatch admits one of its tasks, the task runs two isolated side attempts through the
 * W1-T4625/W1-T4638 paired seam, labelled A1 and A2 in a seeded order, BOTH on the manifest's one pinned stack. Each
 * attempt writes its assignment, attempt and graded terminal receipts to the trial's own ledger, so the existing A/A
 * builder reads them, and its `benchmark-aa-v1` report and receipt are the shapes pilot activation already cites.
 *
 * INVARIANT: inert by default. With no registered protocol nothing is read, logged or spawned, and normal dispatch never
 * changes: the pair takes the task by value, runs beside it, and returns nothing a caller routes on.
 * INVARIANT: subscription only. An attempt whose billing resolves to `api` is refused before spawn and recorded, so cash
 * is zero observed, never unknown. Pairs run one at a time (the shared pair slot) under the per-attempt cap.
 * INVARIANT: it never activates, resumes or reads the paid pilot; it writes a report the operator may choose to cite.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { aaArmFor, aaStackHash, buildAaAllocationReceipt, buildBenchmarkAaReport, parseAaTrialManifest, readAaLedgerEvidence,
  BENCHMARK_AA_VERSION, type AaTrialManifest, type BenchmarkAaCommandInput, type BenchmarkAaReport } from "./benchmark-aa.js";
import { benchmarkRunAssignmentReceipt, type BenchmarkStackEvidence } from "./benchmark-run.js";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig, type Config } from "./config.js";
import { canonicalWorkerProviderId } from "./config-schema.js";
import { billingMode, buildWorkerEnv } from "./env.js";
import type { CorpusProofOutcome } from "./golden-corpus.js";
import { appendLedger } from "./ledger.js";
import { ledgerLivePath } from "./ledger-union.js";
import { claimPairSlot, gradeHeadWithReviewerExecutor, PAIRED_ATTEMPT_MAX_BUDGET_USD, pairedStackEvidence, type PairedAttemptDispatch,
  type PairedAttemptResult, type PairedGrade, type PairedGrader } from "./paired-trial.js";
import type { AcceptanceCriterion } from "./plan.js";

export const BENCHMARK_AA_PROSPECTIVE_VERSION = "benchmark-aa-prospective-v1" as const;
export const PROSPECTIVE_ORDER_METHOD = "sha256(benchmark-aa-prospective-order-v1, trialId, taskId) parity" as const;
export const API_BILLING_REFUSAL = "api-billing-refused-before-spawn";
const PROTOCOL_ROOT = "benchmark-aa-prospective";
const STEPS = { decision: "aa_prospective.decision", refused: "aa_prospective.refused", pair: "aa_prospective.pair" } as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Everything one trial owns lives under one directory: its protocol, its controls and its own ledger. */
export function prospectiveAaDir(stateDir: string, trialId: string): string {
  return join(stateDir, PROTOCOL_ROOT, trialId);
}

/** The seeded order a task's two attempts run in: stable per task, so a retried dispatch never reorders it. */
export function prospectiveAaOrder(manifest: Pick<AaTrialManifest, "trialId" | "labels">, taskId: string): [string, string] {
  const [a, b] = manifest.labels;
  const digest = createHash("sha256").update(`benchmark-aa-prospective-order-v1\0${manifest.trialId}\0${taskId}`).digest();
  return digest.readUInt32BE(0) % 2 === 0 ? [a, b] : [b, a];
}

/** Each attempt is one A/A unit: the first `<taskId>~<label>~<n>` the A/A draw itself assigns to `label`, so the
 *  existing allocation reads every attempt under the label it ran as and the split is exactly one half by design. */
export function prospectiveAaUnit(manifest: Pick<AaTrialManifest, "trialId" | "labels">, taskId: string, label: string): string {
  for (let n = 0; ; n += 1) {
    const unit = `${taskId}~${label}~${n}`;
    if (aaArmFor(manifest.trialId, unit, manifest.labels) === label) return unit;
  }
}

/** The immutable registration. `allocationReceiptHash` is the analysis allocation the report re-derives every refresh. */
export interface ProspectiveAaProtocol {
  version: typeof BENCHMARK_AA_PROSPECTIVE_VERSION;
  trialId: string;
  registeredAt: string;
  manifest: AaTrialManifest;
  allocationReceiptHash: string;
  orderMethod: typeof PROSPECTIVE_ORDER_METHOD;
  billing: "subscription-only";
  maxAttemptBudgetUsd: number;
  digest: string;
}

/** The manifest the A/A builder reads: one unit per task and label, each in its own task's stratum. */
export function prospectiveAnalysisManifest(protocol: Pick<ProspectiveAaProtocol, "manifest" | "allocationReceiptHash">): AaTrialManifest {
  const { manifest } = protocol;
  return { ...manifest, registeredAllocationHash: protocol.allocationReceiptHash,
    tasks: manifest.tasks.flatMap((task) => manifest.labels.map((label) => ({ ...task, taskId: prospectiveAaUnit(manifest, task.taskId, label) }))) };
}

/** The billing an attempt WOULD bill at, resolved before spawn by the worker's own env builder and resolver. */
export function resolveAttemptBilling(provider: string, config: Pick<Config, "overflow"> | undefined, env: NodeJS.ProcessEnv): "api" | "subscription" {
  if (canonicalWorkerProviderId(provider) === "cash") return "api";
  return billingMode(Object.keys(buildWorkerEnv({}, env, { allowApiKey: config?.overflow === "api_key" })));
}

/** A trial file's text; an absent file reads as "", since a trial that wrote nothing yet has nothing to lose. */
function readText(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch {
    // Absent is the only failure here that is not also "no rows": a registered trial's files are all created by this module.
    return "";
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    // A torn or blank line is skipped, never guessed at: it carries no row to count.
    return null;
  }
}

function readLines(path: string): Record<string, unknown>[] {
  return readText(path).split("\n").flatMap((line) => {
    const row = parseLine(line);
    return row === null ? [] : [row];
  });
}

function loadProtocol(stateDir: string, trialId: string): { ok: true; protocol: ProspectiveAaProtocol } | { ok: false; reason: string } {
  const text = readText(join(prospectiveAaDir(stateDir, trialId), "protocol.json"));
  if (text === "") return { ok: false, reason: "trial-not-registered" };
  const parsed = parseLine(text) as ProspectiveAaProtocol | null;
  if (parsed?.version !== BENCHMARK_AA_PROSPECTIVE_VERSION) return { ok: false, reason: "protocol-changed-since-registration" };
  const { digest, ...body } = parsed;
  return digest === sha256(JSON.stringify(body)) ? { ok: true, protocol: parsed } : { ok: false, reason: "protocol-changed-since-registration" };
}

function isPaused(trialDir: string): boolean {
  return readLines(join(trialDir, "controls.ndjson")).some((row) => row.action === "pause");
}

/** Every registered trial. A state dir with no protocol root reads as none: the inert path reads nothing further. */
function registeredProtocols(stateDir: string): { protocol: ProspectiveAaProtocol; paused: boolean }[] {
  let names: string[];
  try { names = readdirSync(join(stateDir, PROTOCOL_ROOT)); }
  catch {
    // No protocol root is the inert default: nothing was ever registered, so nothing is read further.
    return [];
  }
  return names.flatMap((name) => {
    const loaded = loadProtocol(stateDir, name);
    return loaded.ok ? [{ protocol: loaded.protocol, paused: isPaused(prospectiveAaDir(stateDir, name)) }] : [];
  });
}

/** W1-T5341: a trial's own live ledger rows; a torn line is skipped, an absent ledger reads as no rows. */
export function prospectiveAaLedgerRows(stateDir: string, trialId: string): Record<string, unknown>[] {
  return readLines(ledgerLivePath(prospectiveAaDir(stateDir, trialId)));
}

/** One registration a state root holds: its protocol, or the named reason the protocol does not verify. */
export interface ProspectiveAaRegistration {
  trialId: string;
  protocol: ProspectiveAaProtocol | null;
  reason: string | null;
  paused: boolean;
}

/** W1-T5341: every registration under one state root, unverifiable ones included by name. An absent or unreadable root
 *  is `unreadable`, never "none": a caller reconciling instances cannot prove no duplicate trial from a root it never read. */
export function listProspectiveAaRegistrations(stateDir: string):
  { state: "read"; registrations: ProspectiveAaRegistration[] } | { state: "unreadable"; reason: string } {
  if (!existsSync(stateDir)) return { state: "unreadable", reason: "state-dir-absent" };
  let names: string[];
  try { names = existsSync(join(stateDir, PROTOCOL_ROOT)) ? readdirSync(join(stateDir, PROTOCOL_ROOT)) : []; }
  catch (error) {
    return { state: "unreadable", reason: `protocol-root-unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
  return { state: "read", registrations: names.sort().map((trialId) => {
    const loaded = loadProtocol(stateDir, trialId);
    return { trialId, protocol: loaded.ok ? loaded.protocol : null, reason: loaded.ok ? null : loaded.reason,
      paused: isPaused(prospectiveAaDir(stateDir, trialId)) };
  }) };
}

/** How one admission's pair ended. Observational only: nothing in normal dispatch reads it. */
export interface ProspectiveAaPairResult {
  state: "inert" | "not-eligible" | "refused" | "measured" | "unmeasurable";
  trialId: string | null;
  pairId: string | null;
  order: string[];
  reasons: string[];
  outcomes: Record<string, CorpusProofOutcome | "not-run">;
  merged: false;
}

function revisionsOf(stack: AaTrialManifest["stack"]) {
  const { harnessRevision, promptRevision, toolRevision, scorerRevision, environmentRevision } = stack;
  return { harnessRevision, promptRevision, toolRevision, scorerRevision, environmentRevision };
}

/** The pair's input. Every optional field defaults to the production path; the pair never loads config itself. */
export interface ProspectiveAaPairInput {
  task: { id: string; acceptance?: readonly AcceptanceCriterion[] };
  lane: string;
  stateDir: string;
  /** The overflow setting the worker would spawn under: `api_key` with the key present resolves to api billing. */
  config?: Pick<Config, "overflow">;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  harnessRevision?: BenchmarkStackEvidence["harnessRevision"];
  /** W1-T5341: prompt, tool, scorer and environment pins derived from the executing runtime. A field given here is
   *  recorded beside the manifest's pin, and an unknown or disagreeing runtime pin refuses the pair before any spawn. */
  runtimeRevisions?: Omit<BenchmarkStackEvidence, "harnessRevision">;
  dispatchAttempt?: PairedAttemptDispatch<string>;
  dispatchRefusal?: string;
  grade?: PairedGrader;
}

type PairContext = {
  input: ProspectiveAaPairInput;
  protocol: ProspectiveAaProtocol;
  pairId: string;
  order: [string, string];
  stackEvidence: BenchmarkStackEvidence;
  receipt: ReturnType<typeof benchmarkRunAssignmentReceipt>;
  write: (taskId: string, step: string, fields: Record<string, unknown>) => void;
};

function pinOf(stack: AaTrialManifest["stack"]) {
  return { provider: stack.provider, model: stack.model, effort: stack.effort };
}

/** An executing harness off the manifest's pin would put every exposure off the stack: refused before any spawn. */
function harnessReason(receipt: PairContext["receipt"], stack: AaTrialManifest["stack"]): string | null {
  const harness = receipt.stack.harnessRevision;
  if (harness.state !== "observed") return `harness-unpinned:${harness.reason}`;
  return harness.value.toLowerCase() === stack.harnessRevision ? null : "harness-off-pin";
}

const RUNTIME_FIELDS = ["promptRevision", "toolRevision", "scorerRevision", "environmentRevision"] as const;

/** The manifest's pins with each runtime pin recorded beside its field: two disagreeing pins read as conflicting. */
function withRuntimeRevisions(evidence: BenchmarkStackEvidence, runtime: ProspectiveAaPairInput["runtimeRevisions"]): BenchmarkStackEvidence {
  if (runtime === undefined) return evidence;
  const merged: BenchmarkStackEvidence = { ...evidence };
  for (const field of RUNTIME_FIELDS) {
    const pin = runtime[field];
    if (pin === undefined) continue;
    if ("state" in pin) { merged[field] = pin; continue; }
    const manifest = evidence[field];
    const manifestPins = manifest === undefined || "state" in manifest ? [] : Array.isArray(manifest) ? manifest : [manifest];
    merged[field] = [...manifestPins, ...(Array.isArray(pin) ? pin : [pin])];
  }
  return merged;
}

/** A runtime pin that is unknown, or that disagrees with the registered stack, refuses the pair before any spawn. */
function runtimeRevisionReasons(receipt: PairContext["receipt"], stack: AaTrialManifest["stack"],
  runtime: ProspectiveAaPairInput["runtimeRevisions"]): string[] {
  if (runtime === undefined) return [];
  return RUNTIME_FIELDS.filter((field) => runtime[field] !== undefined).flatMap((field) => {
    const evidence = receipt.stack[field];
    if (evidence.state !== "observed") {
      return [evidence.reason === "conflicting-pins" ? `runtime-pin-drift:${field}` : `runtime-pin-unknown:${field}:${evidence.reason}`];
    }
    return evidence.value.toLowerCase() === stack[field] ? [] : [`runtime-pin-drift:${field}`];
  });
}

async function gradeAttempt(context: PairContext, label: string, attempt: PairedAttemptResult | null): Promise<{ grade: PairedGrade | null; reasons: string[] }> {
  if (attempt === null) return { grade: null, reasons: [] };
  if (attempt.pushedRef || attempt.prUrl || attempt.breach) return { grade: null, reasons: [`isolation-breach:${label}`] };
  if (attempt.billingMode === "api") return { grade: null, reasons: [`billing-breach:${label}`] };
  if (attempt.headDir === null) return { grade: null, reasons: [`no-head:${label}`] };
  const grade = context.input.grade ?? ((request) => gradeHeadWithReviewerExecutor(request.criteria, request.headDir));
  try { return { grade: await grade({ taskId: context.input.task.id, headDir: attempt.headDir, criteria: context.input.task.acceptance ?? [] }), reasons: [] }; }
  catch {
    const reason = `grading-failed:${label}`;
    return { grade: null, reasons: [reason] };
  }
}

async function runAttempt(context: PairContext, label: string, position: 0 | 1,
  dispatch: PairedAttemptDispatch<string>): Promise<{ outcome: CorpusProofOutcome; reasons: string[]; refused: boolean }> {
  const { input, protocol, pairId } = context;
  const stack = protocol.manifest.stack;
  const unit = prospectiveAaUnit(protocol.manifest, input.task.id, label);
  const tag = { trial_id: protocol.trialId, pair_id: pairId, task_id: input.task.id, label, position };
  const billing = resolveAttemptBilling(stack.provider, input.config, input.env ?? process.env);
  if (billing === "api") {
    context.write(unit, STEPS.refused, { aa_prospective: { ...tag, reason: API_BILLING_REFUSAL, resolved_billing: billing } });
    return { outcome: "unmeasurable", reasons: [`${API_BILLING_REFUSAL}:${label}`], refused: true };
  }
  const assignmentId = `${pairId}:${label}`;
  const pin = pinOf(stack);
  context.write(unit, "worker.assignment", { aa_prospective: tag,
    worker_assignment: { id: assignmentId, requested: { model: pin.model, effort: pin.effort }, selected: pin },
    benchmark_run: { ...context.receipt, allocation: { method: "randomized", experimentId: protocol.trialId, arm: label, position,
      orderMethod: PROSPECTIVE_ORDER_METHOD } } });
  let attempt: PairedAttemptResult | null = null;
  const reasons: string[] = [];
  try {
    attempt = await dispatch({ pilotId: protocol.trialId, pairId, taskId: input.task.id, arm: label, position,
      pin: { ...pin, billing: "subscription", stackHash: aaStackHash(stack) }, revisions: revisionsOf(stack),
      isolation: { worktree: "fresh-detached", push: false, openPr: false, merge: false }, stackEvidence: context.stackEvidence });
  } catch {
    const reason = `attempt-failed:${label}`;
    reasons.push(reason);
  }
  const graded = await gradeAttempt(context, label, attempt);
  reasons.push(...graded.reasons);
  try { attempt?.cleanup?.(); }
  catch {
    const reason = `cleanup-failed:${label}`;
    reasons.push(reason);
  }
  const outcome: CorpusProofOutcome = reasons.length === 0 && graded.grade !== null ? graded.grade.verdict : "unmeasurable";
  context.write(unit, "worker.attempt", { selection_assignment_id: assignmentId, aa_prospective: { ...tag, head_sha: attempt?.headSha ?? null, reasons },
    served_model: attempt?.servedModel ?? null, billing_mode: attempt?.billingMode ?? null, total_cost_usd: attempt?.costUsd ?? null });
  context.write(unit, "verdict", { selection_assignment_id: assignmentId, success: outcome === "unmeasurable" ? null : outcome === "pass",
    aa_prospective: { ...tag, outcome, grade: graded.grade === null ? null : { passed: graded.grade.passed, failed: graded.grade.failed,
      unmeasurable: graded.grade.unmeasurable, holdouts: graded.grade.holdouts } } });
  return { outcome, reasons, refused: false };
}

async function runPair(context: PairContext, dispatch: PairedAttemptDispatch<string>): Promise<ProspectiveAaPairResult> {
  const { input, protocol, pairId, order } = context;
  const outcomes: Record<string, CorpusProofOutcome | "not-run"> = { [order[0]]: "not-run", [order[1]]: "not-run" };
  const reasons: string[] = [];
  let refused = false;
  for (const [position, label] of order.entries()) {
    const attempt = await runAttempt(context, label, position as 0 | 1, dispatch);
    outcomes[label] = attempt.outcome;
    reasons.push(...attempt.reasons);
    refused ||= attempt.refused;
    if (attempt.outcome === "unmeasurable") { reasons.push("stopped-after-an-unmeasurable-attempt"); break; }
  }
  const measured = Object.values(outcomes).every((outcome) => outcome === "pass" || outcome === "fail");
  const state = refused ? "refused" as const : measured ? "measured" as const : "unmeasurable" as const;
  context.write(input.task.id, STEPS.pair, { aa_prospective: { trial_id: protocol.trialId, pair_id: pairId, task_id: input.task.id, order,
    outcomes, status: state, reasons, merged: false, pr_opened: false } });
  return { state, trialId: protocol.trialId, pairId, order, reasons, outcomes, merged: false };
}

const NOT_RUN: Omit<ProspectiveAaPairResult, "state"> = { trialId: null, pairId: null, order: [], reasons: [], outcomes: {}, merged: false };

async function prospectiveAaPair(input: ProspectiveAaPairInput, claim: () => boolean): Promise<ProspectiveAaPairResult> {
  const registered = registeredProtocols(input.stateDir);
  if (registered.length === 0) return { state: "inert", ...NOT_RUN };
  const candidates = registered.filter((entry) => entry.protocol.manifest.tasks.some((task) => task.taskId === input.task.id));
  const entry = candidates.find((candidate) => !candidate.paused) ?? candidates[0];
  if (entry === undefined || input.lane !== "implement") return { ...NOT_RUN, state: "not-eligible", trialId: entry?.protocol.trialId ?? null };
  const { protocol } = entry;
  const clock = input.clock ?? systemClock;
  const ledger = ledgerLivePath(prospectiveAaDir(input.stateDir, protocol.trialId));
  const pin = pinOf(protocol.manifest.stack);
  const task = protocol.manifest.tasks.find((candidate) => candidate.taskId === input.task.id)!;
  const stackEvidence = withRuntimeRevisions(pairedStackEvidence({ revisions: revisionsOf(protocol.manifest.stack) }, input.harnessRevision),
    input.runtimeRevisions);
  const context: PairContext = { input, protocol, pairId: `aapair-${sha256(`${protocol.trialId}\0${input.task.id}`).slice(0, 16)}`,
    order: prospectiveAaOrder(protocol.manifest, input.task.id), stackEvidence,
    receipt: benchmarkRunAssignmentReceipt({ id: "", requested: { model: pin.model, effort: pin.effort }, selected: pin },
      { taskClass: task.taskClass, risk: task.risk }, stackEvidence),
    write: (taskId, step, fields) => appendLedger(ledger, { ts: clock.iso(), step, task_id: taskId, run_id: `aa-prospective-${protocol.trialId}`, ...fields }) };
  const reasons: string[] = [];
  if (entry.paused) reasons.push("protocol-paused");
  if (readLines(ledger).some((row) => row.step === STEPS.decision && row.task_id === input.task.id
    && (row.aa_prospective as { admitted?: unknown } | undefined)?.admitted === true)) reasons.push("task-already-paired");
  const harness = harnessReason(context.receipt, protocol.manifest.stack);
  if (harness !== null) reasons.push(harness);
  reasons.push(...runtimeRevisionReasons(context.receipt, protocol.manifest.stack, input.runtimeRevisions));
  if (input.dispatchAttempt === undefined) reasons.push(input.dispatchRefusal ?? "attempt-dispatch-not-wired");
  if (reasons.length === 0 && !claim()) reasons.push("pair-in-flight");
  context.write(input.task.id, STEPS.decision, { aa_prospective: { trial_id: protocol.trialId, pair_id: context.pairId, task_id: input.task.id,
    order: context.order, order_method: PROSPECTIVE_ORDER_METHOD, admitted: reasons.length === 0, reasons } });
  if (reasons.length > 0) return { ...NOT_RUN, state: "refused", trialId: protocol.trialId, pairId: context.pairId, order: context.order, reasons };
  return runPair(context, input.dispatchAttempt!);
}

/**
 * The prospective pair at normal dispatch admission. Never throws and never rejects; a caller fires it and forgets it,
 * so nothing it does or fails to do can reach the normal dispatch that admitted the task.
 */
export async function runProspectiveAaPair(input: ProspectiveAaPairInput): Promise<ProspectiveAaPairResult> {
  const slot: { release: (() => void) | null } = { release: null };
  try {
    return await prospectiveAaPair(input, () => (slot.release = claimPairSlot()) !== null);
  } catch {
    const reason = "prospective-aa-failed";
    return { ...NOT_RUN, state: "refused", reasons: [reason] };
  } finally {
    slot.release?.();
  }
}

/** What the operator reads beside the report: pairs, pre-spawn refusals, and cash, which is zero observed by design. */
export interface ProspectiveAaSummary {
  trialId: string;
  paused: boolean;
  pairs: { admitted: number; measured: number; unmeasurable: number; refused: number };
  refusedBeforeSpawn: { apiBilling: number };
  cash: { state: "observed"; usd: number; apiBilledAttempts: number; basis: "subscription-only: api billing is refused before spawn" };
}

function summarize(protocol: ProspectiveAaProtocol, trialDir: string): ProspectiveAaSummary {
  const rows = readLines(ledgerLivePath(trialDir));
  const tagged = (step: string) => rows.filter((row) => row.step === step).map((row) => ({ row, tag: row.aa_prospective as Record<string, unknown> }));
  const pairs = tagged(STEPS.pair).map((entry) => entry.tag.status);
  const api = rows.filter((row) => row.step === "worker.attempt" && row.billing_mode === "api");
  return { trialId: protocol.trialId, paused: isPaused(trialDir),
    pairs: { admitted: tagged(STEPS.decision).filter((entry) => entry.tag.admitted === true).length,
      measured: pairs.filter((status) => status === "measured").length, unmeasurable: pairs.filter((status) => status === "unmeasurable").length,
      refused: pairs.filter((status) => status === "refused").length },
    refusedBeforeSpawn: { apiBilling: tagged(STEPS.refused).filter((entry) => entry.tag.reason === API_BILLING_REFUSAL).length },
    cash: { state: "observed", usd: api.reduce((sum, row) => sum + (typeof row.total_cost_usd === "number" ? row.total_cost_usd : 0), 0),
      apiBilledAttempts: api.length, basis: "subscription-only: api billing is refused before spawn" } };
}

/** One operator action on a prospective A/A. */
export type ProspectiveAaRequest = { stateDir: string; clock?: Clock } & (
  | { action: "register"; manifest: unknown }
  | { action: "report"; trialId: string; out?: string }
  | { action: "pause"; trialId: string; note?: string });

export type ProspectiveAaOutcome =
  | { ok: false; reason: string }
  | { ok: true; lines: string[]; protocol: ProspectiveAaProtocol; report?: BenchmarkAaReport; summary?: ProspectiveAaSummary };

function register(stateDir: string, manifestValue: unknown, nowIso: string): ProspectiveAaOutcome {
  const parsed = parseAaTrialManifest(manifestValue);
  if (!parsed.ok) return parsed;
  const manifest = parsed.manifest;
  const existing = loadProtocol(stateDir, manifest.trialId);
  if (existing.ok || existing.reason !== "trial-not-registered") return { ok: false, reason: "trial-already-registered" };
  if (registeredProtocols(stateDir).some((entry) => !entry.paused)) return { ok: false, reason: "another-prospective-aa-active" };
  const allocationReceiptHash = buildAaAllocationReceipt(prospectiveAnalysisManifest({ manifest, allocationReceiptHash: "" })).receiptHash;
  const body: Omit<ProspectiveAaProtocol, "digest"> = { version: BENCHMARK_AA_PROSPECTIVE_VERSION, trialId: manifest.trialId, registeredAt: nowIso,
    manifest, allocationReceiptHash, orderMethod: PROSPECTIVE_ORDER_METHOD, billing: "subscription-only", maxAttemptBudgetUsd: PAIRED_ATTEMPT_MAX_BUDGET_USD };
  const protocol: ProspectiveAaProtocol = { ...body, digest: sha256(JSON.stringify(body)) };
  const dir = prospectiveAaDir(stateDir, manifest.trialId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "protocol.json"), `${JSON.stringify(protocol, null, 2)}\n`, { flag: "wx" });
  return { ok: true, protocol, lines: [`benchmark-aa prospective ${manifest.trialId}: registered ${manifest.tasks.length} task(s), two labels `
    + `on one pinned stack (${manifest.stack.provider}/${manifest.stack.model}/${manifest.stack.effort}); subscription only, `
    + `$${PAIRED_ATTEMPT_MAX_BUDGET_USD} per-attempt cap; pairs run as normal dispatch admits each task`] };
}

async function report(stateDir: string, protocol: ProspectiveAaProtocol, nowIso: string, out: string | undefined): Promise<ProspectiveAaOutcome> {
  const dir = prospectiveAaDir(stateDir, protocol.trialId);
  const manifest = prospectiveAnalysisManifest(protocol);
  const path = out ?? join(dir, `${BENCHMARK_AA_VERSION}.${protocol.trialId}.json`);
  const prior = readLines(path).find((row) => row.version === BENCHMARK_AA_VERSION && row.trialId === protocol.trialId) as BenchmarkAaReport | undefined;
  const evidence = await readAaLedgerEvidence(dir, new Set(manifest.tasks.map((task) => task.taskId)));
  const built = buildBenchmarkAaReport({ manifest, evidence, nowIso, outcomeSource: "graded-terminal", ...(prior ? { prior } : {}) });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(built));
  renameSync(temporary, path);
  const summary = summarize(protocol, dir);
  return { ok: true, protocol, report: built, summary, lines: [
    `benchmark-aa prospective ${protocol.trialId}: ${built.state}; verdict ${built.verdict}; no winner is declared${summary.paused ? "; PAUSED" : ""}`,
    `  pairs ${summary.pairs.admitted} admitted: ${summary.pairs.measured} measured, ${summary.pairs.unmeasurable} unmeasurable, `
      + `${summary.pairs.refused} refused; ${summary.refusedBeforeSpawn.apiBilling} attempt(s) refused before spawn for api billing`,
    `  cash $${summary.cash.usd.toFixed(2)} observed (${summary.cash.apiBilledAttempts} api-billed attempts)`,
    ...built.findings.map((item) => `  ${item.severity}: ${item.kind} — ${item.detail}`),
    `  receipt ${built.receipt.version} ${built.receipt.reportHash.slice(0, 16)} written to ${path}`] };
}

/** The operator verb's core: register a manifest, report the trial, or pause it. Only `register` creates a protocol. */
export async function runProspectiveAa(request: ProspectiveAaRequest): Promise<ProspectiveAaOutcome> {
  const nowIso = (request.clock ?? systemClock).iso();
  if (request.action === "register") return register(request.stateDir, request.manifest, nowIso);
  const loaded = loadProtocol(request.stateDir, request.trialId);
  if (!loaded.ok) return loaded;
  if (request.action === "report") return report(request.stateDir, loaded.protocol, nowIso, request.out);
  appendFileSync(join(prospectiveAaDir(request.stateDir, request.trialId), "controls.ndjson"),
    `${JSON.stringify({ ts: nowIso, action: "pause", note: request.note ?? null })}\n`);
  return { ok: true, protocol: loaded.protocol, lines: [`benchmark-aa prospective ${request.trialId}: paused; no new pair is admitted, an in-flight one finishes`] };
}

const USAGE = "usage: rmd benchmark-aa prospective register --trial <manifest.json> | report --trial-id <id> [--out <report.json>] [--json]"
  + " | pause --trial-id <id> [--note <text>]  (each takes [--state-dir <dir>])";

/** `rmd benchmark-aa prospective ...`: parses the operator's words and hands one request to `run`. */
export async function prospectiveAaCommand(rest: string[], run: (request: ProspectiveAaRequest) => Promise<ProspectiveAaOutcome>,
  deps: BenchmarkAaCommandInput = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  const [action, ...args] = rest;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args, strict: true, allowPositionals: false, options: { trial: { type: "string" }, "trial-id": { type: "string" },
      out: { type: "string" }, note: { type: "string" }, "state-dir": { type: "string" }, json: { type: "boolean" } } }).values;
  } catch {
    const reason = "arguments-invalid";
    print(`${USAGE} (${reason})`);
    return 2;
  }
  const trialId = typeof values["trial-id"] === "string" ? values["trial-id"] : undefined;
  if (action === "register" ? typeof values.trial !== "string" : !(action === "report" || action === "pause") || trialId === undefined) {
    print(USAGE);
    return 2;
  }
  const stateDir = typeof values["state-dir"] === "string" ? values["state-dir"] : (deps.resolveStateDir ?? (() => join(loadConfig().root, "state")))();
  const base = { stateDir, ...(deps.clock ? { clock: deps.clock } : {}) };
  let requestOf: ProspectiveAaRequest;
  if (action === "register") {
    try { requestOf = { ...base, action, manifest: JSON.parse(readFileSync(values.trial as string, "utf8")) }; }
    catch {
      const reason = "trial-manifest-unreadable";
      print(`benchmark-aa prospective: refused (${reason})`);
      return 2;
    }
  } else if (action === "report") requestOf = { ...base, action, trialId: trialId!, ...(typeof values.out === "string" ? { out: values.out } : {}) };
  else requestOf = { ...base, action: "pause", trialId: trialId!, ...(typeof values.note === "string" ? { note: values.note } : {}) };
  const outcome = await run(requestOf);
  if (!outcome.ok) { print(`benchmark-aa prospective: refused (${outcome.reason})`); return 2; }
  if (values.json === true) print(JSON.stringify(outcome.report ? { report: outcome.report, summary: outcome.summary } : outcome.protocol));
  else for (const line of outcome.lines) print(line);
  return outcome.report === undefined || outcome.report.state === "observed" || outcome.report.state === "observed-partial" ? 0 : 1;
}
