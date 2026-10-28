/**
 * lib/benchmark-aa-readiness.ts — W1-T5341: the explicit driver that runs a FRESH prospective A/A calibration.
 *
 * A retrospective report over fleet history cannot authorize the paid arm: it names missing joins, unknown cost and
 * unpinned revisions. This driver runs the existing W1-T4647 prospective pair (`runProspectiveAaPair`) itself, on
 * evidence it can stand behind:
 *   1. it reconciles registrations across every opted-in instance root, by identity (`instance/trial@digest`), and
 *      refuses a duplicate trial or a root it could not read;
 *   2. it derives the harness, prompt, tool, scorer and environment pins from the EXECUTING runtime and refuses before
 *      any dispatch when one is unknown or disagrees with the registered stack (old missing pins are never guessed);
 *   3. it freezes the eligible population once, keeping the denominator and every refusal;
 *   4. it runs pending pairs in a seeded order, skipping completed ones, so a restart resumes one trial without replay;
 *   5. it reports eligibility, untriggered exclusions, per-arm per-stage missingness, observed cash apart from
 *      notional usage (unknown is counted, never zero) and source-window completeness;
 *   6. it emits the calibration receipt only when the receipt's own integrity predicates pass, else names the next
 *      machine-repairable gap and files it once.
 *
 * INVARIANT: subscription only. An api-billed stack is refused before any spawn; it never activates or reads the paid
 * pilot, adds no route, PR or daemon hold, and reuses the one shared pair slot and the per-attempt cap.
 * INVARIANT: a small sample is inconclusive; nothing here declares a winner or adds a minimum-sample floor.
 */

import { execFileSync } from "node:child_process";
import { observeSelectedRegistrySync, type SelectedRegistryObserver } from "./selected-registry-consumers.js";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { IMMUTABLE_REVISION_RE, parseAaTrialManifest, type AaTrialManifest, type BenchmarkAaCommandInput, type BenchmarkAaReport } from "./benchmark-aa.js";
import { API_BILLING_REFUSAL, listProspectiveAaRegistrations, prospectiveAaDir, prospectiveAaLedgerRows, resolveAttemptBilling,
  runProspectiveAa, runProspectiveAaPair, type ProspectiveAaPairInput, type ProspectiveAaPairResult,
  type ProspectiveAaProtocol } from "./benchmark-aa-prospective.js";
import type { BenchmarkStackEvidence } from "./benchmark-run.js";
import { PAID_PILOT_AA_RECEIPT_MAX_AGE_MS } from "./benchmark-paid-pilot.js";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig, type Config } from "./config.js";
import { CORE_INSTANCE, DEFAULT_INSTANCE_STATE_BASE } from "./instance-gateway.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH, parseInstanceRegistry } from "./instance-registry.js";
import type { PairedAttemptDispatch, PairedGrader } from "./paired-trial.js";
import type { AcceptanceCriterion } from "./plan.js";
import { parseWhitelistedProof } from "./review.js";
import { READINESS_FOLLOW_UPS_FILE, type ReadinessGap } from "./benchmark-readiness-intake.js";

export const BENCHMARK_AA_READINESS_VERSION = "benchmark-aa-readiness-v1" as const;
export const READINESS_POPULATION_VERSION = "benchmark-aa-readiness-population-v1" as const;
export const READINESS_ORDER_METHOD = "sha256(benchmark-aa-readiness-order-v1, allocationReceiptHash, taskId)" as const;
export { READINESS_FOLLOW_UPS_FILE };
const REVISION_FIELDS = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"] as const;
type RevisionField = typeof REVISION_FIELDS[number];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The pins of the process about to dispatch: the harness it executes and the four artifacts it ships with. */
export interface RuntimePins {
  harnessRevision: BenchmarkStackEvidence["harnessRevision"];
  revisions: Required<Omit<BenchmarkStackEvidence, "harnessRevision">>;
}

/**
 * The production derivation. The prompt renderer and the reviewer-executor scorer are source modules, so they ship at
 * the executing harness revision, which `executingHarnessRevision` only attests over a clean `src/`. The worker's tools
 * are `settings/` and `hooks/` under the install root: the same revision only when those are clean and the
 * install HEAD still equals the imported harness on both sides of that read. The
 * environment is the image's build stamp. Anything else is unavailable by name — never inferred from a checkout.
 */
export function deriveRuntimePins(input: { harnessRevision: BenchmarkStackEvidence["harnessRevision"]; installRoot: string;
  git?: (cwd: string, args: string[]) => string; readStamp?: () => string | undefined }): RuntimePins {
  const harness = input.harnessRevision;
  const head = harness !== undefined && !("state" in harness) && !Array.isArray(harness) ? (harness as { revision: string }).revision : null;
  const unknown = (reason: string) => ({ state: "unavailable" as const, reason });
  const artifact = (revision: string) => ({ source: "resolved-artifact" as const, revision });
  const fromHarness = head === null ? unknown(harness !== undefined && "state" in harness ? harness.reason : "executing-module-revision-unavailable")
    : artifact(head);
  let tool: RuntimePins["revisions"]["toolRevision"] = fromHarness;
  if (head !== null) {
    const git = input.git ?? ((cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }));
    try {
      const before = git(input.installRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();
      const clean = git(input.installRoot, ["status", "--porcelain", "--", "settings", "hooks"]).trim() === "";
      const after = git(input.installRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();
      tool = before !== head.toLowerCase() || after !== head.toLowerCase() ? unknown("executing-tool-revision-drift")
        : clean ? fromHarness : unknown("executing-source-not-clean");
    }
    catch (error) {
      const reason = `executing-module-revision-unavailable:${(error as Error).message.slice(0, 80)}`;
      tool = unknown(reason);
    }
  }
  const stamp = (input.readStamp ?? (() => readOptional("/etc/rmd-build-sha")))()?.trim();
  return { harnessRevision: harness, revisions: { promptRevision: fromHarness, toolRevision: tool, scorerRevision: fromHarness,
    environmentRevision: stamp !== undefined && IMMUTABLE_REVISION_RE.test(stamp) ? artifact(stamp.toLowerCase()) : unknown("artifact-not-resolved") } };
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Every pin compared with the registered stack: unknown and drifting pins are refused by field, never guessed. */
export function runtimePinRefusals(pins: RuntimePins, stack: AaTrialManifest["stack"]): string[] {
  return REVISION_FIELDS.flatMap((field: RevisionField) => {
    const pin = field === "harnessRevision" ? pins?.harnessRevision : pins?.revisions?.[field];
    if (pin === undefined) return [`runtime-pin-unknown:${field}:not-pinned-by-runtime`];
    if (pin === null || typeof pin !== "object") return [`runtime-pin-unknown:${field}:malformed-runtime-pin`];
    if ("state" in pin) return [`runtime-pin-unknown:${field}:${pin.state === "unavailable"
      && typeof pin.reason === "string" && pin.reason.length > 0 ? pin.reason : "malformed-runtime-pin"}`];
    const entries = Array.isArray(pin) ? pin : [pin];
    if (entries.length === 0 || entries.some(entry => entry === null || typeof entry !== "object" || !("revision" in entry)
      || typeof entry.revision !== "string")) return [`runtime-pin-unknown:${field}:malformed-runtime-pin`];
    const sources = ["executing-module-git", "image-build-stamp", "resolved-artifact", "trial-manifest"];
    if (entries.some(entry => typeof (entry as { source?: unknown }).source !== "string"
      || !sources.includes((entry as { source: string }).source))) return [`runtime-pin-unknown:${field}:pin-source-invalid`];
    if (entries.some(entry => {
      const source = (entry as { source: string }).source;
      return ((source === "executing-module-git" || source === "image-build-stamp") !== (field === "harnessRevision"))
        && source !== "trial-manifest";
    })) return [`runtime-pin-unknown:${field}:pin-source-invalid-for-field`];
    const revisions = new Set(entries.map(entry => entry.revision.toLowerCase()));
    const [revision] = [...revisions];
    if (revisions.size !== 1 || revision === undefined || !IMMUTABLE_REVISION_RE.test(revision)) return [`runtime-pin-unknown:${field}:not-one-immutable-id`];
    return revision === stack[field] ? [] : [`runtime-pin-drift:${field}`];
  });
}

/** One opted-in instance's state directory. */
export interface InstanceRoot { instance: string; stateDir: string }

/** Every live instance in the fleet registry: core's state is this process's own, every other root is mounted under
 *  `stateBase`. An unreadable registry is a named gap, never a silent fall back to one root. */
export function registryInstanceRoots(localStateDir: string, readRegistry = () => readFileSync(DEFAULT_HOST_INSTANCE_REGISTRY_PATH, "utf8"),
  stateBase = DEFAULT_INSTANCE_STATE_BASE, observer?: SelectedRegistryObserver): { roots: InstanceRoot[] } | { reason: string } {
  return observeSelectedRegistrySync(observer, "benchmark-discovery", { instanceName: undefined }, () => {
  try {
    return { roots: parseInstanceRegistry(readRegistry()).instances.filter((instance) => instance.live).map((instance) => ({
      instance: instance.name, stateDir: instance.name === CORE_INSTANCE ? localStateDir : join(stateBase, instance.name, "state") })) };
  } catch (error) {
    return { reason: `instance-registry-unreadable:${(error as Error).message.slice(0, 80)}` };
  }
  });
}

export interface SourceWindow { instance: string; state: "read" | "unreadable"; reason: string | null; registrations: string[] }

function identityOf(instance: string, protocol: Pick<ProspectiveAaProtocol, "trialId" | "digest">): string {
  return `${instance}/${protocol.trialId}@${protocol.digest.slice(0, 16)}`;
}

type Owner = { instance: string; stateDir: string; protocol: ProspectiveAaProtocol; paused: boolean; identity: string };

/** Reads every root; the trial's one owner, or the refusals that keep a duplicate or an unprovable trial from running. */
function reconcile(roots: readonly InstanceRoot[], trialId: string) {
  const sources: SourceWindow[] = [];
  const owners: Owner[] = [];
  const refusals: string[] = [];
  let otherActive: string | null = null;
  for (const root of roots) {
    const listed = listProspectiveAaRegistrations(root.stateDir);
    if (listed.state === "unreadable") {
      sources.push({ instance: root.instance, state: "unreadable", reason: listed.reason, registrations: [] });
      refusals.push(`instance-root-unreadable:${root.instance}`);
      continue;
    }
    sources.push({ instance: root.instance, state: "read", reason: null, registrations: listed.registrations.map((entry) =>
      entry.protocol === null ? `${root.instance}/${entry.trialId}!${entry.reason}` : identityOf(root.instance, entry.protocol)) });
    for (const entry of listed.registrations) {
      if (entry.trialId === trialId && entry.protocol === null) refusals.push(`registration-unverifiable:${root.instance}:${entry.reason}`);
      else if (entry.trialId === trialId && entry.protocol !== null) {
        owners.push({ instance: root.instance, stateDir: root.stateDir, protocol: entry.protocol, paused: entry.paused,
          identity: identityOf(root.instance, entry.protocol) });
      } else if (entry.protocol !== null && !entry.paused) otherActive ??= identityOf(root.instance, entry.protocol);
    }
  }
  if (owners.length > 1) refusals.push(new Set(owners.map((owner) => owner.protocol.digest)).size > 1
    ? "trial-registered-with-conflicting-protocols" : "trial-registered-in-multiple-roots");
  return { sources, owner: owners.length === 1 ? owners[0]! : null, refusals, otherActive };
}

/** A task the driver can grade and dispatch: the plan's own task, by value. */
export interface ReadinessTask { id: string; acceptance?: readonly AcceptanceCriterion[] }

export interface FrozenPopulation {
  version: typeof READINESS_POPULATION_VERSION;
  trialId: string;
  frozenAt: string;
  allocationReceiptHash: string;
  consent: AaTrialManifest["cohort"]["kind"];
  orderMethod: typeof READINESS_ORDER_METHOD;
  denominator: number;
  eligible: { taskId: string; criteriaHash: string }[];
  refused: { taskId: string; reason: string }[];
  digest: string;
}

function criteriaHash(criteria: readonly AcceptanceCriterion[]): string {
  return sha256(JSON.stringify(criteria.map((criterion) => [criterion.claim, criterion.proof, criterion.holdout === true])));
}

function eligibilityReason(task: ReadinessTask | undefined): string | null {
  if (task === undefined) return "task-not-in-plan";
  const criteria = task.acceptance ?? [];
  if (criteria.length === 0) return "no-acceptance-criteria";
  return criteria.some((criterion) => parseWhitelistedProof(criterion.proof) !== null) ? null : "no-executable-proof";
}

type PopulationOutcome = { ok: true; population: FrozenPopulation } | { ok: false; reason: string };

/** Reads and validates a population already on disk; never re-derives or widens it. */
function readStoredPopulation(protocol: ProspectiveAaProtocol, path: string): PopulationOutcome | undefined {
  let stored: FrozenPopulation | undefined;
  try {
    const text = readOptional(path);
    if (text !== undefined) stored = JSON.parse(text) as FrozenPopulation;
  } catch (error) { return { ok: false, reason: `population-unreadable:${(error as Error).message.slice(0, 80)}` }; }
  if (stored === undefined) return undefined;
  const changed: PopulationOutcome = { ok: false, reason: "population-changed-since-freeze" };
  if (stored === null || typeof stored !== "object" || !Array.isArray(stored.eligible) || !Array.isArray(stored.refused)) return changed;
  const { digest, ...body } = stored;
  if (stored.version !== READINESS_POPULATION_VERSION || digest !== sha256(JSON.stringify(body))
    || stored.trialId !== protocol.trialId || stored.allocationReceiptHash !== protocol.allocationReceiptHash
    || stored.denominator !== protocol.manifest.tasks.length) return changed;
  const covered = [...stored.eligible.map((entry) => entry?.taskId), ...stored.refused.map((entry) => entry?.taskId)].sort();
  const registered = protocol.manifest.tasks.map((entry) => entry.taskId).sort();
  if (JSON.stringify(covered) !== JSON.stringify(registered)
    || stored.eligible.some((entry) => typeof entry.criteriaHash !== "string")) return changed;
  return { ok: true, population: stored };
}

/** The population is frozen ONCE, before the first pair: a later run reads it back and never re-derives eligibility. */
function freezePopulation(protocol: ProspectiveAaProtocol, trialDir: string, tasks: ReadonlyMap<string, ReadinessTask> | null,
  nowIso: string): PopulationOutcome {
  const path = join(trialDir, "population.json");
  const existing = readStoredPopulation(protocol, path);
  if (existing !== undefined) return existing;
  if (tasks === null) return { ok: false, reason: "plan-unreadable-before-freeze" };
  const order = (taskId: string) => sha256(`benchmark-aa-readiness-order-v1\0${protocol.allocationReceiptHash}\0${taskId}`);
  const eligible: FrozenPopulation["eligible"] = [];
  const refused: FrozenPopulation["refused"] = [];
  for (const { taskId } of protocol.manifest.tasks) {
    const reason = eligibilityReason(tasks.get(taskId));
    if (reason === null) eligible.push({ taskId, criteriaHash: criteriaHash(tasks.get(taskId)!.acceptance ?? []) });
    else refused.push({ taskId, reason });
  }
  eligible.sort((a, b) => order(a.taskId).localeCompare(order(b.taskId)));
  const body: Omit<FrozenPopulation, "digest"> = { version: READINESS_POPULATION_VERSION, trialId: protocol.trialId, frozenAt: nowIso,
    allocationReceiptHash: protocol.allocationReceiptHash, consent: protocol.manifest.cohort.kind, orderMethod: READINESS_ORDER_METHOD,
    denominator: protocol.manifest.tasks.length, eligible, refused };
  const population: FrozenPopulation = { ...body, digest: sha256(JSON.stringify(body)) };
  try { writeFileSync(path, `${JSON.stringify(population, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A competing driver installed its population between the read and the create: validate that winner, never replace it.
    return readStoredPopulation(protocol, path) ?? { ok: false, reason: "population-unreadable:winner-vanished" };
  }
  return { ok: true, population };
}

type Row = Record<string, unknown>;
const tagOf = (row: Row) => (row.aa_prospective ?? {}) as Record<string, unknown>;

/** Where each eligible task stands in the trial's own ledger: completed, orphaned in flight, or still pending. */
function progressOf(rows: readonly Row[], eligible: readonly string[]) {
  const paired = new Set(rows.filter((row) => row.step === "aa_prospective.pair").map((row) => String(row.task_id)));
  const admitted = new Set(rows.filter((row) => row.step === "aa_prospective.decision" && tagOf(row).admitted === true).map((row) => String(row.task_id)));
  return { completed: eligible.filter((id) => paired.has(id)), orphaned: eligible.filter((id) => admitted.has(id) && !paired.has(id)),
    pending: eligible.filter((id) => !admitted.has(id)) };
}

export type StageCount = { observed: number; missing: number };
export interface ArmMissingness { assigned: StageCount; attempted: StageCount; terminal: StageCount; verified: StageCount; refusedBeforeSpawn: number }

/** Missingness per arm and stage, over the pairs actually triggered; untriggered tasks are reported apart, by reason. */
function missingnessOf(rows: readonly Row[], labels: readonly string[], eligible: readonly string[]) {
  const eligibleSet = new Set(eligible);
  const triggered = new Set(rows.filter((row) => row.step === "aa_prospective.decision" && tagOf(row).admitted === true
    && eligibleSet.has(String(row.task_id))).map((row) => String(row.task_id)));
  const byLabel = (label: string, step: string, keep: (row: Row) => boolean = () => true) => new Set(rows.filter((row) =>
    row.step === step && tagOf(row).label === label && triggered.has(String(tagOf(row).task_id)) && keep(row)).map((row) => String(tagOf(row).task_id))).size;
  const stage = (observed: number): StageCount => ({ observed, missing: triggered.size - observed });
  const arms: Record<string, ArmMissingness> = {};
  for (const label of labels) {
    arms[label] = { assigned: stage(byLabel(label, "worker.assignment")), attempted: stage(byLabel(label, "worker.attempt")),
      terminal: stage(byLabel(label, "verdict")),
      verified: stage(byLabel(label, "verdict", (row) => tagOf(row).outcome === "pass" || tagOf(row).outcome === "fail")),
      refusedBeforeSpawn: byLabel(label, "aa_prospective.refused") };
  }
  const untriggered: Record<string, number> = {};
  for (const taskId of eligible.filter((id) => !triggered.has(id))) {
    const last = rows.filter((row) => row.step === "aa_prospective.decision" && row.task_id === taskId).at(-1);
    const reason = last === undefined ? "not-yet-run" : String((tagOf(last).reasons as string[] | undefined)?.[0] ?? "refused");
    untriggered[reason] = (untriggered[reason] ?? 0) + 1;
  }
  return { denominators: { eligible: eligible.length, triggered: triggered.size }, arms,
    untriggered: { count: eligible.length - triggered.size, byReason: untriggered } };
}

/** Observed cash apart from notional subscription usage; a cost the attempt never reported is counted, never zero. */
function cashOf(rows: readonly Row[]) {
  const attempts = rows.filter((row) => row.step === "worker.attempt");
  const of = (mode: string | null) => attempts.filter((row) => (row.billing_mode ?? null) === mode);
  const known = (list: Row[]) => list.filter((row) => typeof row.total_cost_usd === "number");
  const sum = (list: Row[]) => known(list).reduce((total, row) => total + (row.total_cost_usd as number), 0);
  const api = of("api");
  const subscription = of("subscription");
  return { observedCash: { usd: sum(api), apiBilledAttempts: api.length, unknownCostAttempts: api.length - known(api).length },
    notionalUsage: { usd: sum(subscription), attempts: subscription.length, unknownCostAttempts: subscription.length - known(subscription).length },
    billingUnknownAttempts: of(null).length };
}

export type { ReadinessGap };

export interface BenchmarkAaReadinessInput<T extends ReadinessTask = ReadinessTask> {
  /** The local instance's state dir: where a new registration goes and where follow-ups are filed. */
  stateDir: string;
  trialId: string;
  /** The GitHub identity (owner/name) of the checkout this process runs in; stamped on each recorded gap so intake never reads a foreign one. */
  repo?: string;
  /** Every opted-in instance root to reconcile, as the operator named them. */
  instanceRoots?: readonly InstanceRoot[];
  /** The roots when the operator named none (production: the fleet registry); absent, the local root alone. */
  defaultInstanceRoots?: () => { roots: InstanceRoot[] } | { reason: string };
  /** Registered on the local root only when no root holds the trial and no other trial is active. */
  manifest?: unknown;
  maxPairs?: number;
  out?: string;
  config?: Pick<Config, "overflow">;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  runtimePins: () => RuntimePins;
  loadPlanTasks: () => readonly T[];
  dispatcherFor: (task: T) => PairedAttemptDispatch<string>;
  grade?: PairedGrader;
  runPair?: (input: ProspectiveAaPairInput) => Promise<ProspectiveAaPairResult>;
}

export interface BenchmarkAaReadinessResult {
  version: typeof BENCHMARK_AA_READINESS_VERSION;
  trialId: string;
  asOf: string;
  state: "receipt-emitted" | "withheld" | "refused";
  identity: string | null;
  sources: { complete: boolean; roots: SourceWindow[] };
  refusals: string[];
  billing: "subscription" | "api" | null;
  population: Pick<FrozenPopulation, "denominator" | "refused" | "consent" | "frozenAt"> & { eligible: number } | null;
  run: { dispatchedPairs: number; completedBefore: number; orphaned: string[]; stoppedBy: string | null;
    pairs: { taskId: string; state: ProspectiveAaPairResult["state"]; reasons: string[] }[] };
  missingness: ReturnType<typeof missingnessOf> | null;
  cash: ReturnType<typeof cashOf> | null;
  report: { state: BenchmarkAaReport["state"]; verdict: BenchmarkAaReport["verdict"]; reportHash: string } | null;
  receipt: { state: "emitted"; path: string; reportHash: string } | { state: "withheld"; gaps: ReadinessGap[] };
  nextGap: ReadinessGap | null;
  followUp: { key: string; state: "recorded" | "already-recorded" | "pending"; unvalidated?: number } | null;
  /** The driver runs beside ordinary work: it pauses, holds and routes nothing, and never touches the paid pilot. */
  holds: { dispatch: false; pr: false; daemon: false };
  paidPilot: "not-activated";
}

function gapOf(reason: string): ReadinessGap {
  const kind = reason.split(":")[0]!;
  const repairable = !["instance-root-unreadable", "instance-registry-unreadable", "trial-registered-with-conflicting-protocols", API_BILLING_REFUSAL].includes(kind);
  return { kind, machineRepairable: repairable, detail: reason };
}

/** One canonical sidecar row; the owner file carries the exact row its writer intends to append. */
interface GapRow { ts: string; key: string; trialId: string; gap: ReadinessGap; repo?: string }

/** A line is the canonical record for `key` only when it parses, keys itself consistently and names this repo. */
function canonicalGapRow(line: string, key: string, repo: string | undefined): boolean {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch {
    // An unparseable line is never the canonical record: it is kept and counted as `unvalidated` by the caller.
    return false;
  }
  if (typeof row !== "object" || row === null || Array.isArray(row) || row.key !== key) return false;
  const gap = row.gap as Record<string, unknown> | null | undefined;
  return typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) && typeof row.trialId === "string"
    && typeof gap === "object" && gap !== null && typeof gap.kind === "string" && key === `${row.trialId}:${gap.kind}`
    && row.repo === repo;
}

/** Owner generation `n` for one key: published whole by link(2), so a reader never sees a torn owner. */
interface AdmissionOwner { host: string; pid: number; nonce: string; row: GapRow }

function readOwner(path: string): AdmissionOwner | "absent" | "unreadable" {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    // ENOENT ends the generation chain; every other failure is "unreadable", which the caller reports as pending.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    const owner = JSON.parse(text) as AdmissionOwner;
    return typeof owner.host === "string" && Number.isInteger(owner.pid) && typeof owner.nonce === "string"
      && typeof owner.row === "object" && owner.row !== null ? owner : "unreadable";
  } catch {
    // A torn or tampered owner file is explicit "unreadable" evidence (reported as pending), never read as a free slot.
    return "unreadable";
  }
}

/** Dead only when it is provably so: this host, and the kernel has no such process. Anything else may still be writing. */
function ownerProvablyDead(owner: AdmissionOwner): boolean {
  if (owner.host !== hostname()) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) {
    // Only ESRCH proves the owner gone; EPERM and anything else mean it may still be writing, so it is not dead.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Publishes `owner` at `path` with its content already in place; false when another writer already holds that generation. */
function publishOwner(path: string, owner: AdmissionOwner): boolean {
  const tmp = `${path}.${owner.nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  try { linkSync(tmp, path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  finally { unlinkSync(tmp); }
}

/**
 * Records one gap per repo, trial and gap kind in the local sidecar, once, even under competing writers.
 * Recording is NOT filing: a task exists only once the opportunity intake's triage has produced one (benchmark-readiness-intake.ts).
 * `repo` is the GitHub identity of the checkout that observed the gap; the reader refuses a record that lacks it or names another.
 *
 * Admission is a chain of exclusively-published owner files (`<hash>.<n>.owner`) beside the sidecar. The writer that publishes the
 * next generation is the only one that may append; a later writer that finds the key already recorded reports `already-recorded`,
 * one that finds a possibly-live owner reports `pending` (an explicit outcome, never empty or done). An owner that is provably dead
 * (this host, no such process) is succeeded by a NEW generation that appends the dead owner's own row; no owner file is ever deleted.
 * The sidecar descriptor is opened once, so a replaced path keeps appending to the file that was read, not to the replacement.
 */
export function recordReadinessGap(stateDir: string, trialId: string, gap: ReadinessGap, nowIso: string, repo?: string): BenchmarkAaReadinessResult["followUp"] {
  const path = join(stateDir, READINESS_FOLLOW_UPS_FILE);
  const key = `${trialId}:${gap.kind}`;
  const mine: GapRow = { ts: nowIso, key, trialId, gap, ...(repo === undefined ? {} : { repo }) };
  const dir = join(stateDir, `${READINESS_FOLLOW_UPS_FILE}.admissions`);
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, createHash("sha256").update(`${repo ?? ""}\0${key}`).digest("hex").slice(0, 32));
  const fd = openSync(path, "a+");
  try {
    // The first read starts at 0; later readFileSync(fd) calls continue from there, so each returns only what was appended since.
    let text = "";
    const recordedState = (): boolean => {
      text += readFileSync(fd, "utf8");
      return text.split("\n").some((line) => canonicalGapRow(line, key, repo));
    };
    const unvalidated = (): number => text.split("\n").filter((line) => line.includes(`"key":${JSON.stringify(key)}`) && !canonicalGapRow(line, key, repo)).length;
    const done = (state: "recorded" | "already-recorded" | "pending") => ({ key, state, ...(unvalidated() > 0 ? { unvalidated: unvalidated() } : {}) });
    const me: Omit<AdmissionOwner, "row"> = { host: hostname(), pid: process.pid, nonce: randomUUID() };
    for (let attempt = 0; attempt < 8; attempt++) {
      if (recordedState()) return done("already-recorded");
      let generation = 0;
      let last: AdmissionOwner | null = null;
      for (;; generation++) {
        const found = readOwner(`${stem}.${generation}.owner`);
        if (found === "absent") break;
        if (found === "unreadable") return done("pending");
        last = found;
      }
      if (last !== null && !ownerProvablyDead(last)) return recordedState() ? done("already-recorded") : done("pending");
      const row = last !== null && canonicalGapRow(JSON.stringify(last.row), key, repo) ? last.row : mine;
      if (!publishOwner(`${stem}.${generation}.owner`, { ...me, row })) continue;
      // The owner re-reads: a predecessor may have appended just before it died, and a partial line is kept as evidence.
      if (recordedState()) return done("already-recorded");
      const lead = text === "" || text.endsWith("\n") ? "" : "\n";
      appendFileSync(fd, `${lead}${JSON.stringify(row)}\n`);
      return done("recorded");
    }
    return done("pending");
  } finally { closeSync(fd); }
}

/** The receipt's own predicates, the ones pilot activation re-checks; anything short of them withholds the receipt. */
function receiptGaps(report: BenchmarkAaReport | null, nowMs: number, missingness: ReturnType<typeof missingnessOf>,
  orphaned: readonly string[]): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  if (missingness.untriggered.count > 0) gaps.push(gapOf(`untriggered-eligible-tasks:${missingness.untriggered.count}`));
  if (orphaned.length > 0) gaps.push(gapOf(`orphaned-admitted-pairs:${orphaned.length}`));
  for (const [label, arm] of Object.entries(missingness.arms)) {
    for (const stage of ["assigned", "attempted", "terminal", "verified"] as const) {
      if (arm[stage].missing > 0) gaps.push(gapOf(`stage-missing:${label}:${stage}:${arm[stage].missing}`));
    }
  }
  if (report === null) return [...gaps, gapOf("report-unavailable")];
  const age = nowMs - Date.parse(report.receipt.asOf);
  if (report.receipt.state !== "observed") gaps.push(gapOf(`report-not-observed:${report.receipt.state}`));
  if (!(age >= 0 && age <= PAID_PILOT_AA_RECEIPT_MAX_AGE_MS)) gaps.push(gapOf("report-stale"));
  if (report.receipt.verdict !== "no-integrity-concern-detected") gaps.push(gapOf(`report-verdict:${report.receipt.verdict}`));
  return gaps;
}

/**
 * Run one fresh calibration: reconcile, check pins and billing, freeze the population, resume pending pairs, report.
 * Never throws for a refusal: every refusal is a named reason in the result, and nothing was dispatched before it.
 */
export async function runBenchmarkAaReadiness<T extends ReadinessTask>(input: BenchmarkAaReadinessInput<T>): Promise<BenchmarkAaReadinessResult> {
  const clock = input.clock ?? systemClock;
  const nowIso = clock.iso();
  const fallback = input.instanceRoots === undefined ? input.defaultInstanceRoots?.() : undefined;
  const roots = input.instanceRoots ?? (fallback !== undefined && "roots" in fallback ? fallback.roots : [{ instance: "local", stateDir: input.stateDir }]);
  const base = { version: BENCHMARK_AA_READINESS_VERSION, trialId: input.trialId, asOf: nowIso, holds: { dispatch: false, pr: false, daemon: false },
    paidPilot: "not-activated", population: null, missingness: null, cash: null, report: null } as const;
  const emptyRun = { dispatchedPairs: 0, completedBefore: 0, orphaned: [], stoppedBy: null, pairs: [] };
  let reconciled = reconcile(roots, input.trialId);
  if (reconciled.owner === null && reconciled.refusals.length === 0 && input.manifest !== undefined) {
    const local = roots.find((root) => root.stateDir === input.stateDir) ?? roots[0]!;
    if (reconciled.otherActive !== null) reconciled.refusals.push(`another-prospective-aa-active:${reconciled.otherActive}`);
    else {
      const candidate = parseAaTrialManifest(input.manifest);
      if (!candidate.ok) reconciled.refusals.push(`registration-refused:${candidate.reason}`);
      else {
        const pinRefusals = runtimePinRefusals(input.runtimePins(), candidate.manifest.stack);
        if (pinRefusals.length > 0) reconciled.refusals.push(...pinRefusals);
        else {
          const registered = await runProspectiveAa({ action: "register", stateDir: local.stateDir, manifest: input.manifest, clock });
          if (!registered.ok) reconciled.refusals.push(`registration-refused:${registered.reason}`);
          else reconciled = reconcile(roots, input.trialId);
        }
      }
    }
  } else if (reconciled.owner === null && reconciled.refusals.length === 0) reconciled.refusals.push("trial-not-registered");
  const registryGap = fallback !== undefined && "reason" in fallback ? fallback.reason : null;
  const sources = { complete: registryGap === null && reconciled.sources.every((source) => source.state === "read"), roots: reconciled.sources };
  const owner = reconciled.owner;
  const refusals = [...(registryGap === null ? [] : [registryGap]), ...reconciled.refusals];
  const stack = owner?.protocol.manifest.stack;
  const billing = stack === undefined ? null : resolveAttemptBilling(stack.provider, input.config, input.env ?? process.env);
  if (billing === "api") refusals.push(API_BILLING_REFUSAL);
  if (owner?.paused) refusals.push("protocol-paused");
  if (stack !== undefined) refusals.push(...runtimePinRefusals(input.runtimePins(), stack));
  let tasks: Map<string, T> | null = null;
  try { tasks = new Map(input.loadPlanTasks().map((task) => [task.id, task])); }
  catch (error) {
    const reason = `plan-unreadable:${(error as Error).message.slice(0, 80)}`;
    refusals.push(reason);
  }
  const frozen = owner === null || refusals.length > 0 ? null
    : freezePopulation(owner.protocol, prospectiveAaDir(owner.stateDir, input.trialId), tasks, nowIso);
  if (frozen !== null && !frozen.ok) refusals.push(frozen.reason);
  if (owner === null || frozen === null || !frozen.ok || refusals.length > 0) {
    const gap = gapOf(refusals[0] ?? "trial-not-registered");
    return { ...base, state: "refused", identity: owner?.identity ?? null, sources, refusals, billing, run: emptyRun,
      receipt: { state: "withheld", gaps: refusals.map(gapOf) }, nextGap: gap,
      followUp: recordReadinessGap(input.stateDir, input.trialId, refusals.map(gapOf).find((entry) => entry.machineRepairable) ?? gap, nowIso, input.repo) };
  }
  const population = frozen.population;
  const eligible = population.eligible.map((entry) => entry.taskId);
  const before = progressOf(prospectiveAaLedgerRows(owner.stateDir, input.trialId), eligible);
  const pairs: BenchmarkAaReadinessResult["run"]["pairs"] = [];
  let stoppedBy: string | null = null;
  for (const taskId of before.pending) {
    if (pairs.length >= (input.maxPairs ?? Number.POSITIVE_INFINITY)) { stoppedBy = "max-pairs-reached"; break; }
    const pins = input.runtimePins();
    const drift = runtimePinRefusals(pins, owner.protocol.manifest.stack);
    if (drift.length > 0) { stoppedBy = `runtime-pins-drifted-mid-run:${drift.join(",")}`; break; }
    const task = tasks!.get(taskId);
    const expected = population.eligible.find((entry) => entry.taskId === taskId)!.criteriaHash;
    if (task === undefined || criteriaHash(task.acceptance ?? []) !== expected) { stoppedBy = `acceptance-changed-since-freeze:${taskId}`; break; }
    const result = await (input.runPair ?? runProspectiveAaPair)({ task: { id: task.id, acceptance: task.acceptance ?? [] }, lane: "implement",
      stateDir: owner.stateDir, config: input.config, env: input.env, clock, harnessRevision: pins.harnessRevision,
      runtimeRevisions: pins.revisions, dispatchAttempt: input.dispatcherFor(task), ...(input.grade ? { grade: input.grade } : {}) });
    pairs.push({ taskId, state: result.state, reasons: result.reasons });
    if (result.state === "refused") { stoppedBy = result.reasons.includes("pair-in-flight") ? "pair-slot-busy" : `pair-refused:${result.reasons.join(",")}`; break; }
  }
  const rows = prospectiveAaLedgerRows(owner.stateDir, input.trialId);
  const after = progressOf(rows, eligible);
  const missingness = missingnessOf(rows, owner.protocol.manifest.labels, eligible);
  const built = await runProspectiveAa({ action: "report", stateDir: owner.stateDir, trialId: input.trialId, clock });
  const report = built.ok ? built.report ?? null : null;
  const gaps = receiptGaps(report, clock.now(), missingness, after.orphaned);
  const run = { dispatchedPairs: pairs.filter((pair) => pair.state !== "refused").length, completedBefore: before.completed.length,
    orphaned: after.orphaned, stoppedBy, pairs };
  const common = { ...base, identity: owner.identity, sources, refusals, billing, run, missingness, cash: cashOf(rows),
    population: { denominator: population.denominator, eligible: eligible.length, refused: population.refused, consent: population.consent,
      frozenAt: population.frozenAt },
    report: report === null ? null : { state: report.state, verdict: report.verdict, reportHash: report.receipt.reportHash } };
  let result: BenchmarkAaReadinessResult;
  if (gaps.length === 0 && report !== null) {
    const path = input.out ?? join(prospectiveAaDir(owner.stateDir, input.trialId), `calibration-receipt.${input.trialId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(report));
    renameSync(temporary, path);
    result = { ...common, state: "receipt-emitted", receipt: { state: "emitted", path, reportHash: report.receipt.reportHash }, nextGap: null, followUp: null };
  } else {
    const nextGap = gaps.find((gap) => gap.machineRepairable) ?? gaps[0]!;
    result = { ...common, state: "withheld", receipt: { state: "withheld", gaps }, nextGap, followUp: recordReadinessGap(input.stateDir, input.trialId, nextGap, nowIso, input.repo) };
  }
  writeFileSync(join(prospectiveAaDir(owner.stateDir, input.trialId), "readiness.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** What the operator verb hands the driver; run-task adds the plan, the sealed dispatcher and the runtime pins. */
export type BenchmarkAaReadinessRequest = Pick<BenchmarkAaReadinessInput, "stateDir" | "trialId" | "repo" | "instanceRoots" | "manifest" | "maxPairs" | "out" | "clock">;

const USAGE = "usage: rmd benchmark-aa readiness --trial-id <id> [--trial <manifest.json>] [--instance-root <name>=<state-dir>]... "
  + "[--max-pairs <n>] [--out <receipt.json>] [--state-dir <dir>] [--json]";

/** `rmd benchmark-aa readiness ...`: parses the operator's words and hands one request to `run`. Exit 0 only on a receipt. */
export async function benchmarkAaReadinessCommand(rest: string[], run: (request: BenchmarkAaReadinessRequest) => Promise<BenchmarkAaReadinessResult>,
  deps: Pick<BenchmarkAaCommandInput, "print" | "clock" | "resolveStateDir"> = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  let values: { "trial-id"?: string; trial?: string; "instance-root"?: string[]; "max-pairs"?: string; out?: string; "state-dir"?: string; json?: boolean };
  try {
    values = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { "trial-id": { type: "string" }, trial: { type: "string" },
      "instance-root": { type: "string", multiple: true }, "max-pairs": { type: "string" }, out: { type: "string" },
      "state-dir": { type: "string" }, json: { type: "boolean" } } }).values;
  } catch (error) {
    const reason = `arguments-invalid: ${(error as Error).message}`;
    print(`${USAGE} (${reason})`);
    return 2;
  }
  const roots = (values["instance-root"] ?? []).map((spec) => spec.split("="));
  const maxPairs = values["max-pairs"] === undefined ? undefined : Number(values["max-pairs"]);
  if (values["trial-id"] === undefined || roots.some((parts) => parts.length !== 2 || !parts[0] || !parts[1])
    || (maxPairs !== undefined && !(Number.isInteger(maxPairs) && maxPairs > 0))) { print(USAGE); return 2; }
  const stateDir = values["state-dir"] ?? (deps.resolveStateDir ?? (() => join(loadConfig().root, "state")))();
  let manifest: unknown;
  if (values.trial !== undefined) {
    try { manifest = JSON.parse(readFileSync(values.trial, "utf8")); }
    catch (error) {
      const reason = `trial-manifest-unreadable: ${(error as Error).message}`;
      print(`benchmark-aa readiness: refused (${reason})`);
      return 2;
    }
  }
  const result = await run({ stateDir, trialId: values["trial-id"], ...(roots.length > 0 ? { instanceRoots: roots.map(([instance, dir]) => ({ instance: instance!, stateDir: dir! })) } : {}),
    ...(manifest === undefined ? {} : { manifest }), ...(maxPairs === undefined ? {} : { maxPairs }),
    ...(values.out === undefined ? {} : { out: values.out }), ...(deps.clock ? { clock: deps.clock } : {}) });
  if (values.json === true) print(JSON.stringify(result));
  else {
    print(`benchmark-aa readiness ${result.trialId}: ${result.state}${result.identity ? ` (${result.identity})` : ""}; no winner is declared; paid pilot not activated`);
    if (result.population) print(`  population ${result.population.denominator}: ${result.population.eligible} eligible, ${result.population.refused.length} refused`);
    print(`  pairs ${result.run.dispatchedPairs} run now, ${result.run.completedBefore} completed before${result.run.stoppedBy ? `; stopped: ${result.run.stoppedBy}` : ""}`);
    for (const refusal of result.refusals) print(`  refused: ${refusal}`);
    if (result.receipt.state === "emitted") print(`  receipt ${result.receipt.reportHash.slice(0, 16)} written to ${result.receipt.path}`);
    else if (result.nextGap) print(`  next gap: ${result.nextGap.detail}${result.followUp ? ` (gap ${result.followUp.state}; ${result.followUp.state === "pending" ? "another writer holds admission" : "recorded"}, not a filed task)` : ""}`);
  }
  return result.state === "receipt-emitted" ? 0 : 1;
}
