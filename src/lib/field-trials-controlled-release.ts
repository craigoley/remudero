/**
 * lib/field-trials-controlled-release.ts — W1-T10843: THE CONTROLLED field-trials-v1 RELEASE.
 *
 * {@link buildFieldTrialsRelease} (field-trials-flow.ts) can only emit an OBSERVATIONAL candidate. The
 * site's parser accepts only a CONTROLLED release: two arms of a registered randomized epoch, exact
 * per-arm counts, task-bootstrap intervals, and an assignment audit that passed. This builder is
 * epoch-generic: it takes one registered epoch (arms, unit, draw method, window, stopping rule), the
 * epoch's assignment rows and per-task outcomes, and emits ONE release or a NAMED refusal.
 *
 * PRE-REGISTERED ANALYSIS. The unit is the task; analysis is intention to treat by FIRST assignment (a
 * task served by the other arm stays in its assigned arm). Primary verified_completion = merged on
 * main by the exact `Remudero-Task` trailer by the window's end plus a 72 h censoring margin, which
 * must have elapsed before any outcome is read. Secondaries: first_pass_success (merged with zero
 * fix-lane rounds) and repair_rounds_mean (fix-lane rounds per assigned task). Intervals resample TASKS,
 * 95 percent, from a fixed seed kept in the PRIVATE sidecar. Adherence is the crossover share of all
 * assignments, bucketed. Nothing here ranks a model.
 *
 * NEVER PUBLISHED. The result is a candidate for the reviewed import flow; this module performs no
 * network call, opens no pull request and writes no manifest entry.
 */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { TRIAL_REVISION_RE, type TrialRevisionPins } from "./field-trials-cohorts.js";
import { seededRandom, seedOf } from "./knowledge-value.js";
import { ROUTING_DRAW_METHOD } from "./worker-provider.js";

export const CONTROLLED_RELEASE_SCHEMA = "field-trials-v1" as const;
/** The censoring margin after the window's end before any outcome is read. */
export const CENSORING_MARGIN_MS = 72 * 3_600_000;
export const BOOTSTRAP_RESAMPLES = 2000;
/** The site's id grammar (model ids, release ids, revisions). */
export const SITE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
/** PRIMARY CONTROL: the audit's balance check. An arm split straying this many standard errors from the draw is a broken allocation. */
export const BALANCE_MAX_Z = 4;
/** PRIMARY CONTROL: the audit's missingness check. Above this share of assignments with an unknown served model, the audit does not pass. */
export const MISSINGNESS_MAX = 0.05;

/** The consent registry's shape this builder reads; the flow's FieldTrialsConsent satisfies it (no import, so no cycle). */
export interface ControlledConsent {
  repos: { repo: string; rights: string; receipt: string; revoked?: boolean }[];
}

/** A registered randomized epoch: fixed before any outcome is read. */
export interface ControlledEpoch {
  epochId: string;
  /** Exactly two distinct model ids, in the registered walk order. */
  arms: readonly [string, string];
  randomizationUnit: "task";
  drawMethod: string;
  /** Each arm's registered selection probability. */
  drawProbability: number;
  window: { start: string; end: string };
  /** Stopping rule: not before `afterIso`, and not before every arm has this many observed tasks. */
  stopping: { afterIso: string; minObservedPerArm: number };
  /** Bootstrap seed, fixed at registration. */
  seed: string;
  corpusRevision: string;
  sourceRepos: readonly string[];
}

/** One `worker.assignment` row of the epoch: what the draw assigned and what actually served it. */
export interface EpochAssignment {
  taskId: string;
  at: string;
  assignedArm: string;
  servedArm: string | null;
  propensity: number | "unavailable";
}

/** One task's outcome, read from main by the exact trailer and from the fix lane's rows. */
export interface EpochTaskOutcome {
  taskId: string;
  outcome: "merged" | "not-merged" | "unobserved";
  mergedAt?: string | null;
  fixRounds: number;
  /** Which model repaired (W1-T10876): sidecar only, never the arm. */
  repairedBy?: string | null;
}

export interface ControlledReleaseInput {
  epoch: ControlledEpoch;
  assignments: readonly EpochAssignment[];
  outcomes: readonly EpochTaskOutcome[];
  pins: TrialRevisionPins;
  consent: ControlledConsent | string | null;
  asOf: string;
  /** Whether the vendored site parser accepts `adherence` and `secondary` (PORTAL-T43). Unproven: false. */
  siteAcceptsSecondary?: boolean;
}

export interface ControlledArm { modelId: string; assigned: number; observed: number; successes: number; ciLower: number; ciUpper: number }
export interface ControlledSecondary {
  metric: "first_pass_success" | "repair_rounds_mean";
  arms: { arm: string; value: number; ciLower: number; ciUpper: number }[];
  intervalMethod: "bootstrap-95-task";
}
export type CrossoverBucket = "<5%" | "5-15%" | "15-30%" | ">30%";

export interface ControlledFieldTrialsRelease {
  schema: typeof CONTROLLED_RELEASE_SCHEMA;
  releaseId: string;
  status: "published";
  publicationScope: "public-opt-in";
  publishedAt: string;
  evidence: "controlled";
  randomizationUnit: "task";
  metric: "verified_completion";
  intervalMethod: "bootstrap-95-task";
  corpusRevision: string;
  harnessRevision: string;
  scorerRevision: string;
  assignmentAudit: "pass";
  sourceRepos: string[];
  consentRegistryRevision: string;
  arms: [ControlledArm, ControlledArm];
  adherence: { crossoverPctBucket: CrossoverBucket; analysis: "intent-to-treat" };
  secondary: ControlledSecondary[];
}

/** Private: never leaves the host with the release. */
export interface ControlledSidecar {
  epochId: string;
  seed: string;
  resamples: number;
  crossover: { crossed: number; assignments: number };
  difference: { metric: "verified_completion"; arm: string; minus: string; value: number; ciLower: number; ciUpper: number };
  reportingRule: "no-detectable-difference" | "interval-excludes-zero";
  repairedBy: Record<string, string>;
  consentReceipts: string[];
}

export type ControlledReleaseRefusal =
  | "epoch-not-registered" | "no-consent-receipt" | "consent-invalid" | "source-consent-missing" | "horizon-not-reached"
  | "assignment-audit-failed" | "site-secondary-unavailable" | "revision-unavailable" | "site-parser-would-reject";

export type ControlledReleaseResult =
  | { state: "candidate"; release: ControlledFieldTrialsRelease; sidecar: ControlledSidecar }
  | { state: "refused"; reason: ControlledReleaseRefusal; detail: string };

const refuse = (reason: ControlledReleaseRefusal, detail: string): ControlledReleaseResult => ({ state: "refused", reason, detail });

function ms(value: string): number {
  return Date.parse(value);
}

/** The first assignment of each task inside the window, by time then input order. */
function firstAssignments(epoch: ControlledEpoch, assignments: readonly EpochAssignment[]): Map<string, EpochAssignment> {
  const first = new Map<string, EpochAssignment>();
  const start = ms(epoch.window.start);
  const end = ms(epoch.window.end);
  for (const row of assignments) {
    const at = ms(row.at);
    if (!(at >= start && at <= end)) continue;
    const prior = first.get(row.taskId);
    if (prior === undefined || at < ms(prior.at)) first.set(row.taskId, row);
  }
  return first;
}

/** The assignment audit: assigned arm vs served model, missingness, balance. Returns the failures, [] when it passes. */
export function assignmentAuditFailures(epoch: ControlledEpoch, windowRows: readonly EpochAssignment[],
  first: ReadonlyMap<string, EpochAssignment>): string[] {
  const failures: string[] = [];
  if (windowRows.length === 0) return ["no-assignments-in-window"];
  if (windowRows.some((row) => !epoch.arms.includes(row.assignedArm))) failures.push("assigned-arm-outside-registered-arms");
  if (windowRows.some((row) => row.propensity === "unavailable")) failures.push("propensity-missing");
  else if (windowRows.some((row) => row.propensity !== epoch.drawProbability)) failures.push("propensity-differs-from-registered-draw");
  const missing = windowRows.filter((row) => row.servedArm === null).length;
  if (missing / windowRows.length > MISSINGNESS_MAX) failures.push("served-model-missingness");
  const count = [...first.values()].filter((row) => row.assignedArm === epoch.arms[0]).length;
  const n = first.size;
  const z = (count - n * epoch.drawProbability) / Math.sqrt(n * epoch.drawProbability * (1 - epoch.drawProbability));
  if (Math.abs(z) > BALANCE_MAX_Z) failures.push("arm-balance");
  return failures;
}

export function crossoverBucket(crossed: number, assignments: number): CrossoverBucket {
  const pct = (crossed / assignments) * 100;
  return pct < 5 ? "<5%" : pct < 15 ? "5-15%" : pct <= 30 ? "15-30%" : ">30%";
}

const down = (value: number, places: number) => Math.floor(value * 10 ** places) / 10 ** places;
const up = (value: number, places: number) => Math.ceil(value * 10 ** places) / 10 ** places;

/** Percentile-bootstrap interval of a statistic over TASKS; the interval always contains the point value. */
function bootstrap(tasks: readonly number[], statistic: (sample: readonly number[]) => number, rng: () => number): { lo: number; hi: number } {
  const stats: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b += 1) {
    const sample = tasks.map(() => tasks[Math.floor(rng() * tasks.length)]!);
    stats.push(statistic(sample));
  }
  stats.sort((a, b) => a - b);
  return { lo: stats[Math.floor(0.025 * (stats.length - 1))]!, hi: stats[Math.ceil(0.975 * (stats.length - 1))]! };
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function interval(values: readonly number[], rng: () => number, places: number): { value: number; ciLower: number; ciUpper: number } {
  const point = mean(values);
  const { lo, hi } = bootstrap(values, mean, rng);
  return { value: point, ciLower: Math.max(0, down(Math.min(lo, point), places)), ciUpper: up(Math.max(hi, point), places) };
}

/** Everything the site's parser would reject, found here first. Returns the first violation or null. */
export function siteParserViolation(release: ControlledFieldTrialsRelease): string | null {
  const arms = release.arms;
  if (!SITE_ID_PATTERN.test(release.releaseId)) return "releaseId";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(release.publishedAt) || Number.isNaN(ms(release.publishedAt))) return "publishedAt";
  for (const key of ["corpusRevision", "harnessRevision", "scorerRevision", "consentRegistryRevision"] as const) {
    if (!SITE_ID_PATTERN.test(release[key])) return key;
  }
  if (release.sourceRepos.length === 0) return "sourceRepos";
  if (arms.length !== 2 || arms[0].modelId === arms[1].modelId) return "arms";
  for (const arm of arms) {
    const rate = arm.successes / arm.observed;
    if (!SITE_ID_PATTERN.test(arm.modelId) || !(arm.observed > 0 && arm.observed <= arm.assigned)
      || !(arm.successes >= 0 && arm.successes <= arm.observed) || !Number.isInteger(arm.assigned) || !Number.isInteger(arm.successes)
      || !(arm.ciLower >= 0 && arm.ciUpper <= 1 && arm.ciLower <= rate && rate <= arm.ciUpper)) return `arm:${arm.modelId}`;
  }
  if (release.secondary.length === 0 || release.secondary.length > 3) return "secondary";
  return null;
}

/**
 * Build the release for ONE registered epoch, or refuse with a named reason and emit nothing. Refusals,
 * in order: the epoch is not a registered two-arm task-level draw; consent is absent for any source repo;
 * the stopping horizon is not reached; the assignment audit does not pass; the pinned revisions are
 * unavailable; the site parser cannot yet accept secondaries; a built field would fail the site parser.
 */
export function buildControlledFieldTrialsRelease(input: ControlledReleaseInput): ControlledReleaseResult {
  const { epoch } = input;
  const [armA, armB] = epoch.arms;
  if (epoch.arms.length !== 2 || armA === armB || epoch.randomizationUnit !== "task" || epoch.drawMethod !== ROUTING_DRAW_METHOD
    || !(epoch.drawProbability > 0 && epoch.drawProbability < 1) || !SITE_ID_PATTERN.test(epoch.epochId)
    || !(ms(epoch.window.start) < ms(epoch.window.end))) {
    return refuse("epoch-not-registered", `${epoch.epochId}: needs two distinct arms, unit task, draw ${ROUTING_DRAW_METHOD}, a window`);
  }
  if (input.consent === null) return refuse("no-consent-receipt", "no consent registry supplied");
  if (typeof input.consent === "string") return refuse("consent-invalid", input.consent);
  const consent = input.consent;
  const receipts: string[] = [];
  for (const repo of epoch.sourceRepos) {
    const grant = consent.repos.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase() && entry.revoked !== true
      && (entry.rights === "aggregate-opt-in" || entry.rights === "public-benchmark"));
    if (grant === undefined) return refuse("source-consent-missing", repo);
    receipts.push(createHash("sha256").update(grant.receipt).digest("hex"));
  }
  if (epoch.sourceRepos.length === 0) return refuse("source-consent-missing", "no source repo registered");
  const cutoff = ms(epoch.window.end) + CENSORING_MARGIN_MS;
  const asOf = ms(input.asOf);
  if (!(asOf >= cutoff) || !(asOf >= ms(epoch.stopping.afterIso))) {
    return refuse("horizon-not-reached", `as of ${input.asOf}; earliest read ${fixedClock(Math.max(cutoff, ms(epoch.stopping.afterIso))).iso()}`);
  }
  const windowRows = input.assignments.filter((row) => ms(row.at) >= ms(epoch.window.start) && ms(row.at) <= ms(epoch.window.end));
  const first = firstAssignments(epoch, input.assignments);
  const failures = assignmentAuditFailures(epoch, windowRows, first);
  if (failures.length > 0) return refuse("assignment-audit-failed", failures.join(","));
  const outcomeOf = new Map(input.outcomes.map((row) => [row.taskId, row]));
  const tasks = [...first.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, row]) => {
    const outcome = outcomeOf.get(taskId);
    const merged = outcome?.outcome === "merged" && typeof outcome.mergedAt === "string" && ms(outcome.mergedAt) <= cutoff;
    return { taskId, arm: row.assignedArm, observed: outcome !== undefined && outcome.outcome !== "unobserved", merged,
      fixRounds: outcome?.fixRounds ?? 0, repairedBy: outcome?.repairedBy ?? null };
  });
  const pins = input.pins;
  const revisions = [epoch.corpusRevision, pins.harness, pins.scorer];
  if (revisions.some((value) => value === null || !TRIAL_REVISION_RE.test(value))) return refuse("revision-unavailable", "corpus, harness or scorer revision");
  if (input.siteAcceptsSecondary !== true) {
    return refuse("site-secondary-unavailable", "the site parser does not yet accept adherence and secondary (PORTAL-T43)");
  }
  const rng = seededRandom(seedOf(`${epoch.epochId}\u0000${epoch.seed}`));
  const arms: ControlledArm[] = [];
  const firstPass: ControlledSecondary["arms"] = [];
  const repair: ControlledSecondary["arms"] = [];
  const rates = new Map<string, number[]>();
  for (const modelId of epoch.arms) {
    const assignedTasks = tasks.filter((task) => task.arm === modelId);
    const observed = assignedTasks.filter((task) => task.observed);
    const success = observed.map((task) => Number(task.merged));
    rates.set(modelId, success);
    if (observed.length === 0) return refuse("horizon-not-reached", `${modelId}: no task reached the outcome window`);
    if (observed.length < epoch.stopping.minObservedPerArm) return refuse("horizon-not-reached", `${modelId}: ${observed.length} observed`);
    const primary = interval(success, rng, 6);
    arms.push({ modelId, assigned: assignedTasks.length, observed: observed.length, successes: success.reduce((a, b) => a + b, 0),
      ciLower: primary.ciLower, ciUpper: primary.ciUpper });
    const pass = interval(observed.map((task) => Number(task.merged && task.fixRounds === 0)), rng, 6);
    firstPass.push({ arm: modelId, value: pass.value, ciLower: pass.ciLower, ciUpper: pass.ciUpper });
    const rounds = interval(assignedTasks.map((task) => task.fixRounds), rng, 1);
    repair.push({ arm: modelId, value: Math.round(rounds.value * 10) / 10, ciLower: rounds.ciLower,
      ciUpper: Math.max(rounds.ciUpper, Math.round(rounds.value * 10) / 10) });
  }
  const crossed = windowRows.filter((row) => row.servedArm !== row.assignedArm).length;
  const body = {
    schema: CONTROLLED_RELEASE_SCHEMA, releaseId: "", status: "published" as const, publicationScope: "public-opt-in" as const,
    publishedAt: fixedClock(asOf).iso(), evidence: "controlled" as const, randomizationUnit: "task" as const,
    metric: "verified_completion" as const, intervalMethod: "bootstrap-95-task" as const, corpusRevision: epoch.corpusRevision,
    harnessRevision: pins.harness!, scorerRevision: pins.scorer!, assignmentAudit: "pass" as const,
    sourceRepos: [...epoch.sourceRepos], consentRegistryRevision: createHash("sha256").update(JSON.stringify(consent)).digest("hex"),
    arms: arms as [ControlledArm, ControlledArm],
    adherence: { crossoverPctBucket: crossoverBucket(crossed, windowRows.length), analysis: "intent-to-treat" as const },
    secondary: [
      { metric: "first_pass_success" as const, arms: firstPass, intervalMethod: "bootstrap-95-task" as const },
      { metric: "repair_rounds_mean" as const, arms: repair, intervalMethod: "bootstrap-95-task" as const },
    ],
  } satisfies ControlledFieldTrialsRelease;
  body.releaseId = `controlled-${createHash("sha256").update(JSON.stringify({ ...body, releaseId: "" })).digest("hex").slice(0, 16)}`;
  const violation = siteParserViolation(body);
  if (violation !== null) return refuse("site-parser-would-reject", violation);
  const a = rates.get(armA)!;
  const b = rates.get(armB)!;
  const diff = bootstrapDifference(a, b, rng);
  const point = mean(a) - mean(b);
  return { state: "candidate", release: body, sidecar: {
    epochId: epoch.epochId, seed: epoch.seed, resamples: BOOTSTRAP_RESAMPLES, crossover: { crossed, assignments: windowRows.length },
    difference: { metric: "verified_completion", arm: armA, minus: armB, value: point, ciLower: Math.min(diff.lo, point), ciUpper: Math.max(diff.hi, point) },
    reportingRule: Math.min(diff.lo, point) <= 0 && Math.max(diff.hi, point) >= 0 ? "no-detectable-difference" : "interval-excludes-zero",
    repairedBy: Object.fromEntries(tasks.flatMap((task) => task.repairedBy === null ? [] : [[task.taskId, task.repairedBy]])),
    consentReceipts: receipts } };
}

function bootstrapDifference(a: readonly number[], b: readonly number[], rng: () => number): { lo: number; hi: number } {
  const stats: number[] = [];
  const resample = (values: readonly number[]) => mean(values.map(() => values[Math.floor(rng() * values.length)]!));
  for (let i = 0; i < BOOTSTRAP_RESAMPLES; i += 1) stats.push(resample(a) - resample(b));
  stats.sort((x, y) => x - y);
  return { lo: stats[Math.floor(0.025 * (stats.length - 1))]!, hi: stats[Math.ceil(0.975 * (stats.length - 1))]! };
}
