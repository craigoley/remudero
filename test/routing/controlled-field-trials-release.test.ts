/**
 * W1-T10843 — THE CONTROLLED field-trials-v1 RELEASE. A registered randomized epoch becomes the site's
 * controlled release (exact per-arm counts, task-bootstrap intervals, pre-registered secondaries, a
 * bucketed crossover) or a NAMED refusal that emits nothing. Fixtures only: no network, no live ledger.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildControlledFieldTrialsRelease, crossoverBucket, deriveRegisteredEpoch, siteParserViolation, SITE_SECONDARY_COMMIT, type ControlledEpoch, type ControlledReleaseInput, type EpochAssignment,
  type EpochTaskOutcome,
} from "#src/lib/field-trials-controlled-release.js";
import { fieldTrialsCommand, verifySiteSecondarySupport, unavailableLedger, writeControlledCandidate, buildFieldTrialsFlowSnapshot, type FieldTrialsConsent }
  from "#src/lib/field-trials-flow.js";
import { FIELD_TRIALS_GITHUB_VERSION } from "#src/lib/field-trials-github.js";
import { ROUTING_DRAW_METHOD } from "#src/lib/worker-provider.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/** Vendored verbatim (imports removed) from craigoley/remudero-site at
 * eae03ec12a76227b4bf100d3d318111f43bf573c (PORTAL-T43, PR #207); base contract b80fbbb.
 * https://github.com/craigoley/remudero-site/blob/eae03ec12a76227b4bf100d3d318111f43bf573c/lib/field-trials-release.ts
 */
/** Owner-approved scope for reviewed, de-identified aggregates only. Not telemetry upload consent. */
export interface FieldTrialsConsentRegistry {
  revision: string;
  entries: readonly {
    repository: string;
    state: "active" | "revoked";
    scope: "aggregate-public";
    approvedOn: string;
    approvedBy: "owner";
  }[];
}

export const fieldTrialsConsentRegistry: FieldTrialsConsentRegistry = {
  revision: "owner-2026-09-25-v1",
  entries: [
    { repository: "remudero", state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" },
    { repository: "remudero-console", state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" },
    { repository: "remudero-site", state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" },
  ],
};

export function fieldTrialsConsentAllows(
  contributors: readonly string[],
  revision: string,
  registry: FieldTrialsConsentRegistry = fieldTrialsConsentRegistry,
): boolean {
  if (revision !== registry.revision || contributors.length === 0 || new Set(contributors).size !== contributors.length) return false;
  const byRepo = new Map(registry.entries.map((entry) => [entry.repository, entry]));
  return contributors.every((repo) => byRepo.get(repo)?.state === "active" && byRepo.get(repo)?.scope === "aggregate-public");
}

/** A deliberately narrow public artifact; private telemetry is never accepted here. */

export interface FieldTrialsArm {
  modelId: string;
  assigned: number;
  observed: number;
  successes: number;
  ciLower: number;
  ciUpper: number;
}

export interface FieldTrialsRelease {
  schema: "field-trials-v1";
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
  arms: [FieldTrialsArm, FieldTrialsArm];
  adherence?: FieldTrialsAdherence;
  secondary?: FieldTrialsSecondary[];
}

export const crossoverPctBuckets = ["<5%", "5-15%", "15-30%", ">30%"] as const;

export interface FieldTrialsAdherence {
  crossoverPctBucket: (typeof crossoverPctBuckets)[number];
  analysis: "intent-to-treat";
}

export type FieldTrialsSecondaryMetric = "first_pass_success" | "repair_rounds_mean";

export interface FieldTrialsInterval {
  arm: string;
  value: number;
  ciLower: number;
  ciUpper: number;
}

export interface FieldTrialsSecondary {
  metric: FieldTrialsSecondaryMetric;
  arms: [FieldTrialsInterval, FieldTrialsInterval];
  intervalMethod: "bootstrap-95-task";
}

const releaseKeys = [
  "schema", "releaseId", "status", "publicationScope", "publishedAt", "evidence",
  "randomizationUnit", "metric", "intervalMethod", "corpusRevision", "harnessRevision", "scorerRevision",
  "assignmentAudit", "sourceRepos", "consentRegistryRevision", "arms",
];
const optionalReleaseKeys = ["adherence", "secondary"];
const adherenceKeys = ["crossoverPctBucket", "analysis"];
const secondaryKeys = ["metric", "arms", "intervalMethod"];
const intervalKeys = ["arm", "value", "ciLower", "ciUpper"];
const armKeys = ["modelId", "assigned", "observed", "successes", "ciLower", "ciUpper"];
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Every required key present; nothing beyond required and the named optional keys. */
function exactKeysWithOptional(value: Record<string, unknown>, keys: string[], optional: string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && safeId.test(value);
}

function isArm(value: unknown): value is FieldTrialsArm {
  if (!isRecord(value) || !exactKeys(value, armKeys) || !isSafeId(value.modelId)) return false;
  const { assigned, observed, successes, ciLower, ciUpper } = value;
  if (![assigned, observed, successes].every(Number.isSafeInteger)) return false;
  if (typeof assigned !== "number" || typeof observed !== "number" || typeof successes !== "number") return false;
  if (assigned <= 0 || observed <= 0 || observed > assigned || successes < 0 || successes > observed) return false;
  if (typeof ciLower !== "number" || typeof ciUpper !== "number") return false;
  const rate = successes / observed;
  return Number.isFinite(ciLower) && Number.isFinite(ciUpper) &&
    ciLower >= 0 && ciLower <= rate && rate <= ciUpper && ciUpper <= 1;
}

function isAdherence(value: unknown): value is FieldTrialsAdherence {
  return isRecord(value) && exactKeys(value, adherenceKeys) &&
    (crossoverPctBuckets as readonly unknown[]).includes(value.crossoverPctBucket) &&
    value.analysis === "intent-to-treat";
}

function isSecondaryValue(metric: unknown, value: number): boolean {
  if (metric === "first_pass_success") return Number.isSafeInteger(value) && value >= 0 && value <= 100;
  if (metric === "repair_rounds_mean") return value >= 0 && Number(value.toFixed(1)) === value;
  return false;
}

function isSecondaryInterval(value: unknown, metric: unknown, modelId: string): boolean {
  if (!isRecord(value) || !exactKeys(value, intervalKeys) || value.arm !== modelId) return false;
  const { value: point, ciLower, ciUpper } = value;
  if (typeof point !== "number" || typeof ciLower !== "number" || typeof ciUpper !== "number") return false;
  if (![point, ciLower, ciUpper].every(Number.isFinite)) return false;
  if (ciLower < 0 || ciLower > point || point > ciUpper) return false;
  if (metric === "first_pass_success" && ciUpper > 100) return false;
  return isSecondaryValue(metric, point);
}

function isSecondary(value: unknown, arms: [FieldTrialsArm, FieldTrialsArm]): value is FieldTrialsSecondary {
  if (!isRecord(value) || !exactKeys(value, secondaryKeys) || value.intervalMethod !== "bootstrap-95-task") return false;
  if (value.metric !== "first_pass_success" && value.metric !== "repair_rounds_mean") return false;
  return Array.isArray(value.arms) && value.arms.length === arms.length &&
    value.arms.every((entry, index) => isSecondaryInterval(entry, value.metric, arms[index].modelId));
}

function isSecondaryList(value: unknown, arms: [FieldTrialsArm, FieldTrialsArm]): value is FieldTrialsSecondary[] {
  if (!Array.isArray(value) || value.length > 3 || !value.every((entry) => isSecondary(entry, arms))) return false;
  const metrics = value.map((entry: FieldTrialsSecondary) => entry.metric);
  return new Set(metrics).size === metrics.length;
}

export function parseFieldTrialsRelease(
  input: unknown,
  registry: FieldTrialsConsentRegistry = fieldTrialsConsentRegistry,
): FieldTrialsRelease | null {
  if (!isRecord(input) || !exactKeysWithOptional(input, releaseKeys, optionalReleaseKeys)) return null;
  if (input.schema !== "field-trials-v1" || input.status !== "published" ||
    input.publicationScope !== "public-opt-in" || input.evidence !== "controlled" ||
    input.randomizationUnit !== "task" || input.metric !== "verified_completion" ||
    input.intervalMethod !== "bootstrap-95-task" ||
    input.assignmentAudit !== "pass") return null;
  if (![input.releaseId, input.corpusRevision, input.harnessRevision, input.scorerRevision, input.consentRegistryRevision].every(isSafeId)) return null;
  if (!Array.isArray(input.sourceRepos) || !input.sourceRepos.every(isSafeId) ||
    !fieldTrialsConsentAllows(input.sourceRepos, input.consentRegistryRevision as string, registry)) return null;
  if (typeof input.publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.publishedAt) ||
    !Number.isFinite(Date.parse(input.publishedAt)) ||
    new Date(input.publishedAt).toISOString() !== input.publishedAt) return null;
  if (!Array.isArray(input.arms) || input.arms.length !== 2 ||
    !input.arms.every(isArm) || input.arms[0].modelId === input.arms[1].modelId) return null;
  const arms = input.arms as [FieldTrialsArm, FieldTrialsArm];
  if (Object.hasOwn(input, "adherence") && !isAdherence(input.adherence)) return null;
  if (Object.hasOwn(input, "secondary") && !isSecondaryList(input.secondary, arms)) return null;
  return input as unknown as FieldTrialsRelease;
}

const BASE_KEYS = ["schema", "releaseId", "status", "publicationScope", "publishedAt", "evidence", "randomizationUnit", "metric",
  "intervalMethod", "corpusRevision", "harnessRevision", "scorerRevision", "assignmentAudit", "sourceRepos",
  "consentRegistryRevision", "arms"];
const OPTIONAL_KEYS = ["adherence", "secondary"];
const siteParse = (value: unknown, _repos: readonly string[]) => ({ ok: parseFieldTrialsRelease(value) !== null });

const SOL = "gpt-6.1-sol";
const SON = "claude-sonnet-5.5";
const REPO = "craigoley/remudero";
const HEX = (c: string) => c.repeat(40);
const PINS = { harness: HEX("a"), prompt: HEX("b"), tool: HEX("c"), scorer: HEX("d"), environment: HEX("e") };
const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", consentRegistryRevision: "owner-2026-09-25-v1",
  repos: [{ repo: REPO, sourceId: "remudero", rights: "aggregate-opt-in", receipt: "receipt-1" }] };
const EPOCH: ControlledEpoch = { epochId: "sol61-vs-sonnet55", arms: [SOL, SON], randomizationUnit: "task", drawMethod: ROUTING_DRAW_METHOD,
  drawProbability: 0.5, window: { start: "2026-09-27T00:00:00.000Z", end: "2026-10-24T23:59:59.000Z" },
  stopping: { afterIso: "2026-10-27T00:00:00.000Z", minObservedPerArm: 10 }, seed: "seed-1", corpusRevision: HEX("f"), sourceRepos: [REPO] };
const siteMainEvidence = { status: "ahead", base_commit: { sha: SITE_SECONDARY_COMMIT }, merge_base_commit: { sha: SITE_SECONDARY_COMMIT } };
const AS_OF = "2026-10-28T00:00:00.000Z";
const START = Date.UTC(2026, 8, 28);

function fixture(opts: { cross?: boolean } = {}): { assignments: EpochAssignment[]; outcomes: EpochTaskOutcome[] } {
  const assignments: EpochAssignment[] = [];
  const outcomes: EpochTaskOutcome[] = [];
  for (let i = 0; i < 80; i += 1) {
    const arm = i % 2 === 0 ? SOL : SON;
    const other = arm === SOL ? SON : SOL;
    const at = START + i * 3_600_000;
    const crossed = opts.cross !== false && (arm === SOL ? i % 4 === 0 : i % 10 === 1);
    assignments.push({ taskId: `t${i}`, at: new Date(at).toISOString(), assignedArm: arm, servedArm: crossed ? other : arm, propensity: 0.5 });
    if (i % 4 === 1) assignments.push({ taskId: `t${i}`, at: new Date(at + 86_400_000).toISOString(), assignedArm: arm, servedArm: arm, propensity: 0.5 });
    const lost = arm === SOL ? i % 10 === 0 : i % 7 === 1;
    outcomes.push({ taskId: `t${i}`, outcome: i === 2 ? "unobserved" : lost ? "not-merged" : "merged",
      mergedAt: lost || i === 2 ? null : new Date(at + 2 * 86_400_000).toISOString(), fixRounds: i % 9 === 0 ? 2 : i % 3 === 0 ? 1 : 0,
      ...(i % 3 === 0 ? { repairedBy: SON } : {}) });
  }
  return { assignments, outcomes };
}

function input(over: Partial<ControlledReleaseInput> = {}, data = fixture()): ControlledReleaseInput {
  return { epoch: EPOCH, ...data, pins: PINS, consent: CONSENT, asOf: AS_OF, siteAcceptsSecondary: true, ...over };
}

function built(over: Partial<ControlledReleaseInput> = {}, data = fixture()) {
  const result = buildControlledFieldTrialsRelease(input(over, data));
  assert.equal(result.state, "candidate", JSON.stringify(result));
  return result.state === "candidate" ? result : (undefined as never);
}

test("W1-T10843: the controlled release passes the site field-trials-v1 parser", () => {
  const { release } = built();
  assert.deepEqual(siteParse(release, [REPO]), { ok: true });
  assert.deepEqual(Object.keys(release).sort(), [...BASE_KEYS, ...OPTIONAL_KEYS].sort());
  assert.deepEqual([release.evidence, release.randomizationUnit, release.metric, release.intervalMethod, release.assignmentAudit],
    ["controlled", "task", "verified_completion", "bootstrap-95-task", "pass"]);
  assert.deepEqual(release.arms.map((arm) => arm.modelId), [SOL, SON]);
  for (const fixRounds of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const data = fixture();
    data.outcomes[0]!.fixRounds = fixRounds;
    const result = buildControlledFieldTrialsRelease(input({}, data));
    assert.equal(result.state, "refused", String(fixRounds));
    assert.equal("release" in result, false);
  }
  assert.equal(release.publishedAt, AS_OF);
  assert.deepEqual(siteParse({ ...release, evidence: "observational" }, [REPO]), { ok: false }, "the vendored parser is not vacuous");
  assert.deepEqual(siteParse({ ...release, arms: [release.arms[0]] }, [REPO]), { ok: false });
  assert.deepEqual(siteParse({ ...release, nBucket: "10-20" }, [REPO]), { ok: false });
  // a registered-but-malformed revision is refused here, before the site would reject it
  const refused = buildControlledFieldTrialsRelease(input({ pins: { ...PINS, scorer: null } }));
  assert.deepEqual([refused.state, (refused as { reason: string }).reason], ["refused", "revision-unavailable"]);
});

test("W1-T10843: a failing assignment audit or an unreached horizon emits no release", () => {
  const refusedWith = (over: Partial<ControlledReleaseInput>, data = fixture()) => {
    const result = buildControlledFieldTrialsRelease(input(over, data));
    assert.equal(result.state, "refused", JSON.stringify(result));
    assert.equal("release" in result, false, "a refusal carries no artifact");
    return result as { reason: string; detail: string };
  };
  const data = fixture();
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i === 3 ? { ...row, propensity: "unavailable" } : row) }).detail, "propensity-missing");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i === 3 ? { ...row, propensity: 0.7 } : row) }).detail,
    "propensity-differs-from-registered-draw");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i % 5 === 0 ? { ...row, servedArm: null } : row) }).detail,
    "served-model-missingness");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row) => row.assignedArm === SON && row.taskId !== "t1" ? { ...row, assignedArm: SOL } : row) }).detail,
    "arm-balance");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i === 4 ? { ...row, assignedArm: "gpt-6.1-terra" } : row) }).detail,
    "assigned-arm-outside-registered-arms");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row) => ({ ...row, servedArm: "gpt-6.1-terra" })) }).detail,
    "served-arm-outside-registered-arms");
  assert.equal(refusedWith({}, { assignments: [], outcomes: [] }).detail, "no-assignments-in-window");
  assert.equal(refusedWith({ asOf: "2026-10-26T00:00:00.000Z" }).reason, "horizon-not-reached", "inside the 72 h censoring margin");
  assert.equal(refusedWith({ epoch: { ...EPOCH, stopping: { ...EPOCH.stopping, minObservedPerArm: 500 } } }).reason, "horizon-not-reached");
  assert.equal(refusedWith({ epoch: { ...EPOCH, stopping: { ...EPOCH.stopping, afterIso: "2026-11-30T00:00:00.000Z" } } }).reason, "horizon-not-reached");
  assert.equal(refusedWith({ consent: null }).reason, "no-consent-receipt");
  assert.equal(refusedWith({ consent: { ...CONSENT, consentRegistryRevision: undefined } }).reason, "site-parser-would-reject");
  assert.equal(refusedWith({ consent: { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, sourceId: undefined }] } }).reason, "site-parser-would-reject");
  assert.equal(refusedWith({ consent: { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, sourceId: "unregistered" }] } }).reason, "site-parser-would-reject");
  assert.equal(refusedWith({ consent: "consent-invalid" }).reason, "consent-invalid");
  assert.equal(refusedWith({ consent: { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, revoked: true }] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ consent: { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, rights: "private" }] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ epoch: { ...EPOCH, sourceRepos: [REPO, "acme/other"] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ epoch: { ...EPOCH, sourceRepos: [] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ epoch: { ...EPOCH, arms: [SOL, SOL] } }).reason, "epoch-not-registered");
  assert.equal(refusedWith({ epoch: { ...EPOCH, drawMethod: "manual" } }).reason, "epoch-not-registered");
  assert.equal(refusedWith({ epoch: { ...EPOCH, window: { start: EPOCH.window.end, end: EPOCH.window.start } } }).reason, "epoch-not-registered");
  assert.equal(refusedWith({ epoch: { ...EPOCH, epochId: "has space" } }).reason, "epoch-not-registered");
  const noOutcomeForArm = refusedWith({}, { ...data, outcomes: data.outcomes.filter((row) => Number(row.taskId.slice(1)) % 2 === 1) });
  assert.equal(noOutcomeForArm.reason, "horizon-not-reached", "an arm none of whose tasks reached the outcome window is not a result");
  // the audit alone decides "pass": a clean fixture is the only one that yields a release
  assert.equal(built().release.assignmentAudit, "pass");
  const fx = productionFixture();
  const missingReceipts = fx.rows.filter((row) => row.step !== "worker.attempt" || Number(String(row.selection_assignment_id).slice(1)) % 7 !== 0);
  const derived = deriveRegisteredEpoch("sol61-vs-sonnet55", { rows: missingReceipts, merged: [], mergesObservedThrough: AS_OF, sourceRepos: [REPO] })!;
  assert.equal(derived.assignments.filter((row) => row.servedArm === null).length, 12, "routing choices are not execution receipts");
  const refusal = buildControlledFieldTrialsRelease({ ...input(), ...derived, pins: PINS });
  assert.deepEqual(refusal, { state: "refused", reason: "assignment-audit-failed", detail: "served-model-missingness" });
});

test("W1-T10843: arm counts and intervals come from task-level outcomes", () => {
  const data = fixture();
  const { release } = built({}, data);
  const cutoff = Date.parse(EPOCH.window.end);
  for (const arm of release.arms) {
    const tasks = data.assignments.filter((row) => row.assignedArm === arm.modelId && row.taskId === `t${row.taskId.slice(1)}`)
      .map((row) => row.taskId).filter((id, i, all) => all.indexOf(id) === i);
    const rows = tasks.map((id) => data.outcomes.find((o) => o.taskId === id)!);
    const observed = rows.filter((o) => o.outcome !== "unobserved");
    const merged = observed.filter((o) => o.outcome === "merged" && Date.parse(o.mergedAt!) <= cutoff);
    assert.deepEqual([arm.assigned, arm.observed, arm.successes], [tasks.length, observed.length, merged.length], arm.modelId);
    const rate = arm.successes / arm.observed;
    assert.ok(arm.ciLower < rate && rate < arm.ciUpper, `${arm.modelId}: a real interval around ${rate}`);
    assert.ok(arm.ciLower >= 0 && arm.ciUpper <= 1);
  }
  assert.equal(release.arms[0].assigned, 40);
  assert.equal(release.arms[0].observed, 39, "the unobserved task is assigned but not observed");
  // one task's outcome moves exactly that arm's successes by one
  const flipped = built({}, { ...data, outcomes: data.outcomes.map((o) => o.taskId === "t4" ? { ...o, outcome: "not-merged", mergedAt: null } : o) });
  assert.equal(flipped.release.arms[0].successes, release.arms[0].successes - 1);
  assert.equal(flipped.release.arms[1].successes, release.arms[1].successes);
  // a merge after the 72 h margin is read as not merged
  const late = built({}, { ...data, outcomes: data.outcomes.map((o) => o.taskId === "t4" ? { ...o, mergedAt: "2026-11-20T00:00:00.000Z" } : o) });
  assert.equal(late.release.arms[0].successes, release.arms[0].successes - 1);
  const waitingPeriod = built({}, { ...data, outcomes: data.outcomes.map((o) => ({ ...o, outcome: "merged", mergedAt: "2026-10-26T00:00:00.000Z" })) });
  assert.deepEqual(waitingPeriod.release.arms.map((a) => a.successes), [0, 0], "the censoring margin grants no extra outcome time");
  const boundary = built({}, { ...data, outcomes: data.outcomes.map((o) => ({ ...o, outcome: "merged", mergedAt: EPOCH.window.end })) });
  assert.deepEqual(boundary.release.arms.map((a) => a.successes), [40, 40], "the window end is inclusive");
  // the interval is reproducible from the registered seed; the seed moves no count
  assert.deepEqual(built({}, data).release, release);
  const reseeded = built({ epoch: { ...EPOCH, seed: "seed-2" } }, data).release;
  assert.deepEqual(reseeded.arms.map((a) => [a.assigned, a.observed, a.successes]), release.arms.map((a) => [a.assigned, a.observed, a.successes]));
  assert.ok(reseeded.arms.every((a) => a.ciLower < a.successes / a.observed && a.successes / a.observed < a.ciUpper));
  const registered = registeredOutcomeRelease().release;
  assert.deepEqual(registered.arms.map((arm) => [arm.assigned, arm.observed, arm.successes]), [[40, 40, 1], [40, 40, 2]],
    "only verified main merges score; develop-only and missing main evidence do not");
  assert.ok(registered.arms.every((arm) => arm.ciLower < arm.successes / arm.observed && arm.successes / arm.observed < arm.ciUpper));
});

test("W1-T10843: the controlled release is a candidate and is never published automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}controlled-release-`));
  try {
    const out = join(root, "out");
    const epochFile = { epoch: EPOCH, ...fixture(), stack: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [`${k}Revision`, { state: "observed", value: v }])) };
    const result = writeControlledCandidate(out, epochFile, CONSENT, AS_OF, true);
    assert.equal(result.state, "candidate");
    const files = readdirSync(join(out, "controlled")).sort();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith(".candidate.json")) && files.some((f) => f.endsWith(".sidecar.private.json")));
    assert.deepEqual(readdirSync(out), ["controlled"], "nothing but the candidate directory: no manifest entry, no release directory");
    const candidate = JSON.parse(readFileSync(join(out, result.state === "candidate" ? result.file : ""), "utf8"));
    assert.deepEqual(siteParse(candidate, [REPO]), { ok: true });
    const sidecar = JSON.parse(readFileSync(join(out, "controlled", files.find((f) => f.endsWith(".sidecar.private.json"))!), "utf8"));
    assert.equal(sidecar.seed, "seed-1");
    assert.equal(sidecar.repairedBy.t3, SON, "the repairing model is private sidecar data");
    assert.equal(JSON.stringify(candidate).includes("seed-1"), false, "the seed never rides in the release");
    assert.equal(JSON.stringify(candidate).includes("t3"), false);
    assert.ok(["no-detectable-difference", "interval-excludes-zero"].includes(sidecar.reportingRule));
    // the existing flow reaches the builder; a refusal writes nothing and fails the pass, and nothing is published
    const dir = join(root, "flow");
    mkdirSync(dir);
    const epochPath = join(root, "epoch.json");
    const consentPath = join(root, "consent.json");
    writeFileSync(epochPath, JSON.stringify(epochFile));
    writeFileSync(consentPath, JSON.stringify(CONSENT));
    const printed: string[] = [];
    const run = (extra: string[], siteAcceptsSecondary?: boolean) => fieldTrialsCommand(
      ["--source", "core=craigoley/remudero", "--ledger", `core=${root}`, "--out-dir", dir, "--consent", consentPath, "--offline", ...extra],
      buildFieldTrialsFlowSnapshot, { nowIso: AS_OF, print: (l) => printed.push(l), printError: () => undefined,
        readLedger: async () => unavailableLedger("fixture"), resolveConfig: () => ({ root }),
        ...(siteAcceptsSecondary === undefined ? {} : { readSiteEvidence: async () => siteMainEvidence }) });
    assert.equal(await run(["--controlled-epoch", epochPath]), 1);
    assert.match(printed.join("\n"), /controlled release refused \(site-secondary-unavailable/);
    assert.equal(existsSync(join(dir, "controlled")), false, "a refusal emits no candidate");
    await run(["--controlled-epoch", epochPath, "--site-parser-commit", SITE_SECONDARY_COMMIT], true);
    assert.match(printed.join("\n"), /controlled candidate: controlled\/controlled-[0-9a-f]{16}\.candidate\.json \(never published/);
    assert.equal(readdirSync(join(dir, "controlled")).length, 2);
    assert.equal(existsSync(join(dir, "releases")), false, "no observational release rode along");
    await run(["--controlled-epoch", join(root, "missing.json")], true);
    assert.match(printed.join("\n"), /controlled release refused \(controlled-epoch-invalid\)/);
    printed.length = 0;
    await run(["--controlled-epoch", epochPath, "--site-parser-commit", SITE_SECONDARY_COMMIT, "--json"], true);
    assert.equal(JSON.parse(printed[0]!).controlled.state, "candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10843: the Sol x Sonnet release carries pre-registered secondaries and adherence", () => {
  const data = fixture();
  const { release, sidecar } = built({}, data);
  const firstAssignment = new Map<string, EpochAssignment>();
  for (const row of data.assignments) if (!firstAssignment.has(row.taskId)) firstAssignment.set(row.taskId, row);
  // ITT by FIRST assignment: a task served by the other arm stays in its assigned arm
  const assignedSol = [...firstAssignment.values()].filter((row) => row.assignedArm === SOL);
  const servedSol = [...firstAssignment.values()].filter((row) => row.servedArm === SOL);
  assert.notEqual(assignedSol.length, servedSol.length, "the fixture's crossover separates assigned from served");
  assert.equal(release.arms[0].assigned, assignedSol.length);
  const uncrossed = built({}, fixture({ cross: false })).release;
  assert.deepEqual(release.arms, uncrossed.arms, "the arms are identical whoever served the tasks");
  // adherence: crossed over all assignments in the window, bucketed
  const crossed = data.assignments.filter((row) => row.servedArm !== row.assignedArm).length;
  assert.deepEqual(sidecar.crossover, { crossed, assignments: data.assignments.length });
  assert.equal(release.adherence.crossoverPctBucket, "15-30%");
  assert.equal(uncrossed.adherence.crossoverPctBucket, "<5%");
  assert.equal(release.adherence.analysis, "intent-to-treat");
  assert.deepEqual([[0, 1, "<5%"], [5, 100, "5-15%"], [15, 100, "15-30%"], [30, 100, "15-30%"], [31, 100, ">30%"], [1386, 6115, "15-30%"]]
    .map(([c, n]) => crossoverBucket(c as number, n as number)), ["<5%", "5-15%", "15-30%", "15-30%", ">30%", "15-30%"]);
  // secondaries: first-pass success and repair rounds, each per arm with a task-bootstrap interval
  assert.deepEqual(release.secondary.map((s) => s.metric), ["first_pass_success", "repair_rounds_mean"]);
  assert.ok(release.secondary.every((s) => s.intervalMethod === "bootstrap-95-task" && s.arms.length === 2));
  const [firstPass, repair] = release.secondary;
  for (const [index, arm] of release.arms.entries()) {
    const rows = [...firstAssignment.values()].filter((row) => row.assignedArm === arm.modelId).map((row) => data.outcomes.find((o) => o.taskId === row.taskId)!);
    const observed = rows.filter((o) => o.outcome !== "unobserved");
    const clean = observed.filter((o) => o.outcome === "merged" && o.fixRounds === 0).length;
    assert.equal(firstPass!.arms[index]!.arm, arm.modelId);
    assert.ok(firstPass!.arms[index]!.value === Math.round(100 * clean / observed.length));
    assert.ok(clean < arm.successes, "repair rounds make first-pass strictly lower than the merge rate");
    const mean = rows.reduce((sum, o) => sum + o.fixRounds, 0) / rows.length;
    assert.equal(repair!.arms[index]!.value, Math.round(mean * 10) / 10, "one decimal, over every assigned task");
    for (const s of [firstPass!, repair!]) assert.ok(s.arms[index]!.ciLower <= s.arms[index]!.value && s.arms[index]!.value <= s.arms[index]!.ciUpper);
  }
  // exact per-arm counts, no bucket on the arms; no ranking word anywhere
  assert.ok(release.arms.every((arm) => Object.keys(arm).sort().join() === "assigned,ciLower,ciUpper,modelId,observed,successes"));
  assert.ok(["no-detectable-difference", "interval-excludes-zero"].includes(sidecar.reportingRule));
  assert.equal(sidecar.difference.minus, SON);
  assert.deepEqual(siteParse(release, [REPO]), { ok: true });
  // the first assignment, not a later one, fixes the arm
  const reassigned = data.assignments.map((row) => row.taskId === "t0" ? { ...row, at: "2026-09-27T12:00:00.000Z" } : row)
    .concat({ taskId: "t0", at: "2026-09-27T00:30:00.000Z", assignedArm: SON, servedArm: SON, propensity: 0.5 });
  const flipped = built({}, { ...data, assignments: reassigned }).release;
  assert.equal(flipped.arms[0].assigned, release.arms[0].assigned - 1, "t0's earliest assignment was the other arm");
  const registered = registeredOutcomeRelease();
  assert.deepEqual(registered.release.secondary[0]!.arms.map((arm) => arm.value), [3, 3],
    "first pass counts only zero-repair main merges, never develop-only merges");
  assert.deepEqual(registered.release.secondary[1]!.arms.map((arm) => arm.value), [0.5, 0.4]);
  assert.deepEqual(registered.sidecar.crossover, { crossed: 28, assignments: 80 }, "execution receipts determine crossover");
});

/** Raw ledger rows and a GitHub store shaped like production's, for the registered sol61-vs-sonnet55 epoch. */
function productionFixture() {
  const PROD_SOL = "gpt-6.1-sol";
  const PROD_SON = "claude-sonnet-5-5";
  const labelOf = (i: number) => (i % 2 === 0 ? "sol61" : "sonnet");
  const modelOf = (label: string) => (label === "sol61" ? PROD_SOL : PROD_SON);
  const crossed = (i: number) => (i % 2 === 0 ? i % 4 === 0 : i % 10 === 1);
  const merged = (i: number) => i % 5 !== 0 && !(i % 2 === 1 && i % 7 === 1) && i !== 13;
  const rounds = (i: number) => (i % 9 === 0 ? 2 : i % 3 === 0 ? 1 : 0);
  const task = (i: number) => `W1-T${1000 + i}`;
  const at = (i: number) => Date.UTC(2026, 8, 28) + i * 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const stack = { harnessRevision: { state: "observed", value: HEX("9") } };
  const rows: Record<string, unknown>[] = [];
  const pulls: Record<string, unknown> = {};
  const commits: Record<string, string> = {};
  const pull = (n: number, ids: string[], mergedAt: number, onMain = true) => {
    const sha = n.toString(16).padStart(40, "0");
    if (onMain) commits[sha] = iso(mergedAt);
    pulls[String(n)] = { nodeId: `n${n}`, number: n, state: "closed", createdAt: iso(mergedAt - 1000), updatedAt: iso(mergedAt), mergedAt: iso(mergedAt),
      closedAt: iso(mergedAt), headRef: null, headSha: null, mergeCommitSha: sha, trailerTaskIds: ids, revertsPr: null, authorClass: "bot",
      detail: { state: "pending" } };
  };
  for (let i = 0; i < 80; i += 1) {
    const label = labelOf(i);
    const servedLabel = crossed(i) ? (label === "sol61" ? "sonnet" : "sol61") : label;
    const claude = { provider: "claude", model: PROD_SON, eligible: true, selected: servedLabel === "sonnet" };
    rows.push({ step: "worker.assignment", task_id: task(i), ts: iso(at(i)), benchmark_run: { stack }, worker_assignment: {
      id: `a${i}`, selected: { provider: servedLabel === "sonnet" ? "claude" : "codex", model: modelOf(servedLabel) },
      routing: { decision: { ab: "sol61-vs-sonnet55", considered: [claude, { provider: "codex", model: PROD_SOL, eligible: true, selected: servedLabel === "sol61" }] },
        propensity: { method: ROUTING_DRAW_METHOD, selectedProbability: 0.5 },
        experiment: { id: "sol61-vs-sonnet55", unit: "task", assignedArm: label, assignedProbability: 0.5, servedArm: servedLabel, crossover: crossed(i) } } } });
    rows.push({ step: "worker.attempt", task_id: task(i), ts: iso(at(i) + 60_000), selection_assignment_id: `a${i}`, served_model: modelOf(servedLabel) });
    for (let r = 1; r <= rounds(i); r += 1) {
      rows.push({ step: "fix.dispatch", task_id: task(i), ts: iso(at(i) + r * 600_000), round_id: `r${i}-${r}` });
      rows.push({ step: "fix.done", task_id: task(i), ts: iso(at(i) + r * 600_000 + 1), round_id: `r${i}-${r}`, served_model: PROD_SON });
    }
    if (merged(i)) pull(i + 1, [task(i)], at(i) + 2 * 86_400_000);
  }
  rows.push({ step: "fix.dispatch", task_id: task(0), ts: iso(at(0) + 600_000), round_id: "r0-1" }); // a replayed row is one round
  rows.push({ step: "fix.dispatch", task_id: task(3), ts: iso(at(3) + 900_000), kind: "proof_amendment", round_id: "amend-3" }); // not a worker round
  rows.push({ step: "fix.dispatch", task_id: task(6), ts: iso(at(6) - 3_600_000), round_id: "before-6" }); // before the first assignment
  pull(500, [task(10)], at(10) - 86_400_000); // merged BEFORE its first assignment: not this assignment's outcome
  pull(501, [task(13), task(14)], at(13) + 86_400_000); // two trailers: ambiguous, never an exact trailer match
  for (const i of [5, 20]) pull(600 + i, [task(i)], at(i) + 86_400_000, false); // develop-only merges, zero repair rounds
  const cursor = (state: string) => ({ state, reason: null, watermark: null, sweepHigh: null, resumePage: null, pagesRead: 1, asOf: AS_OF });
  const store = (state: string) => ({ version: FIELD_TRIALS_GITHUB_VERSION, repos: { [REPO]: { pulls, commits, deployments: {},
    cursors: { pulls: cursor(state), commits: cursor("complete"), deployments: cursor("complete") } } } });
  return { rows, store, PROD_SOL, PROD_SON, labelOf, crossed, merged, rounds, task };
}

function registeredOutcomeRelease() {
  const fx = productionFixture();
  const merge = (i: number, mergedOnMain?: boolean) => ({ trailerTaskIds: [fx.task(i)], mergedAt: "2026-10-10T00:00:00.000Z",
    ...(mergedOnMain === undefined ? {} : { mergedOnMain }) });
  const derived = deriveRegisteredEpoch("sol61-vs-sonnet55", { rows: fx.rows, merged: [merge(4, true), merge(7, true), merge(3, true),
    merge(2, false), merge(5, false), merge(8), merge(11)], mergesObservedThrough: AS_OF, sourceRepos: [REPO] })!;
  const result = buildControlledFieldTrialsRelease({ ...input(), ...derived, pins: PINS });
  if (result.state !== "candidate") throw new Error(result.reason);
  return result;
}

test("W1-T10843: the registered sol61-vs-sonnet55 epoch is read from the ledger, with no operator epoch file", async () => {
  const fx = productionFixture();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}controlled-registered-`));
  try {
    const consentPath = join(root, "consent.json");
    writeFileSync(consentPath, JSON.stringify(CONSENT));
    const SITE_COMMIT = SITE_SECONDARY_COMMIT;
    const printed: string[] = [];
    const run = async (name: string, extra: string[], opts: { store?: string; github?: ReturnType<typeof fx.store>; rows?: Record<string, unknown>[]; protocol?: unknown; evidence?: unknown } = {}) => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "field-trials-github-v1.json"), JSON.stringify(opts.github ?? fx.store(opts.store ?? "complete")));
      writeFileSync(join(root, "benchmark-paid-pilot-v1.sol61-vs-sonnet55.protocol.json"), JSON.stringify({ protocol: opts.protocol ?? {
        version: "benchmark-paid-pilot-v1", pilotId: "sol61-vs-sonnet55",
        revisions: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [`${k}Revision`, v])) } }));
      printed.length = 0;
      const code = await fieldTrialsCommand(["--source", "core=craigoley/remudero", "--ledger", `core=${root}`, "--out-dir", dir, "--consent", consentPath,
        "--offline", ...extra], buildFieldTrialsFlowSnapshot, { nowIso: AS_OF, print: (l) => printed.push(l), printError: () => undefined,
        readLedger: async () => unavailableLedger("fixture"), resolveConfig: () => ({ root }), readRows: async () => opts.rows ?? fx.rows, readSiteEvidence: async () => opts.evidence ?? siteMainEvidence });
      return { dir, code, out: printed.join("\n") };
    };
    // the production path: no site commit named -> withheld, nothing emitted, never a merge-only release
    const withheld = await run("withheld", ["--controlled-registered", "sol61-vs-sonnet55"]);
    assert.match(withheld.out, /controlled release refused \(site-secondary-unavailable/);
    assert.equal(existsSync(join(withheld.dir, "controlled")), false);
    const unrelated = await run("unrelated", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", HEX("b")]);
    assert.match(unrelated.out, /site-secondary-unavailable/);
    assert.equal(existsSync(join(unrelated.dir, "controlled")), false);
    const unmerged = await run("unmerged", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { evidence: { ...siteMainEvidence, status: "diverged" } });
    assert.match(unmerged.out, /site-secondary-unavailable/);
    assert.equal(existsSync(join(unmerged.dir, "controlled")), false);
    const missingPins = await run("missing-pins", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { protocol: { pilotId: "different", revisions: {} } });
    assert.match(missingPins.out, /revision-unavailable/);
    assert.equal(existsSync(join(missingPins.dir, "controlled")), false);
    // The accepting commit is on site main; revisions come from the registered protocol, not assignment receipts.
    const ok = await run("ok", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT,
      "--controlled-protocol", join(root, "benchmark-paid-pilot-v1.sol61-vs-sonnet55.protocol.json")]);
    assert.match(ok.out, /controlled candidate: controlled\/controlled-[0-9a-f]{16}\.candidate\.json \(never published/);
    const files = readdirSync(join(ok.dir, "controlled"));
    const candidate = JSON.parse(readFileSync(join(ok.dir, "controlled", files.find((f) => f.endsWith(".candidate.json"))!), "utf8"));
    const sidecar = JSON.parse(readFileSync(join(ok.dir, "controlled", files.find((f) => f.endsWith(".sidecar.private.json"))!), "utf8"));
    assert.deepEqual(siteParse(candidate, [REPO]), { ok: true });
    assert.equal(sidecar.siteParserCommit, SITE_COMMIT);
    assert.equal(existsSync(join(ok.dir, "releases")), false, "nothing is published or manifested");
    // exact per-arm counts by FIRST assignment, from the ledger and the merged pulls
    const expect = (label: string) => {
      const ids = [...Array(80).keys()].filter((i) => fx.labelOf(i) === label);
      return { assigned: ids.length, observed: ids.length, successes: ids.filter(fx.merged).length,
        clean: ids.filter((i) => fx.merged(i) && fx.rounds(i) === 0).length, rounds: ids.reduce((s, i) => s + fx.rounds(i), 0) };
    };
    assert.deepEqual(candidate.arms.map((a: { modelId: string }) => a.modelId), [fx.PROD_SOL, fx.PROD_SON]);
    for (const [index, label] of ["sol61", "sonnet"].entries()) {
      const want = expect(label);
      const arm = candidate.arms[index];
      assert.deepEqual([arm.assigned, arm.observed, arm.successes], [want.assigned, want.observed, want.successes], label);
      assert.ok(candidate.secondary[0].arms[index].value === Math.round(100 * want.clean / want.observed), `${label}: first-pass success`);
      assert.equal(candidate.secondary[1].arms[index].value, Math.round((want.rounds / want.assigned) * 10) / 10, `${label}: repair rounds per assigned task`);
    }
    assert.deepEqual(candidate.secondary.map((s: { metric: string }) => s.metric), ["first_pass_success", "repair_rounds_mean"]);
    assert.deepEqual(sidecar.crossover, { crossed: 28, assignments: 80 });
    assert.equal([...Array(80).keys()].filter(fx.crossed).length, 28);
    assert.equal(candidate.adherence.crossoverPctBucket, ">30%", "28 of 80 assignments crossed over: 35%");
    assert.equal(sidecar.repairedBy[fx.task(3)], fx.PROD_SON, "the repairing model is private sidecar data");
    assert.equal(sidecar.seed, "W1-T10843:sol61-vs-sonnet55:2026-10-27");
    assert.equal(JSON.stringify(candidate).includes(sidecar.seed), false);
    assert.deepEqual(candidate.sourceRepos, ["remudero"]);
    assert.equal(candidate.harnessRevision, "a".repeat(40));
    assert.equal(candidate.scorerRevision, "d".repeat(40));
    // Positive main-history control above; without main evidence, merge timestamps cannot score either success metric.
    for (const missing of ["history", "merge-sha"]) {
      const github = structuredClone(fx.store("complete"));
      if (missing === "history") github.repos[REPO]!.commits = {};
      else for (const pull of Object.values(github.repos[REPO]!.pulls)) (pull as { mergeCommitSha: string | null }).mergeCommitSha = null;
      const result = await run(`no-main-${missing}`, ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { github });
      const file = readdirSync(join(result.dir, "controlled")).find((f) => f.endsWith(".candidate.json"))!;
      const release = JSON.parse(readFileSync(join(result.dir, "controlled", file), "utf8"));
      assert.deepEqual(release.arms.map((a: FieldTrialsArm) => [a.assigned, a.observed, a.successes, a.ciLower, a.ciUpper]),
        [[40, 40, 0, 0, 0], [40, 40, 0, 0, 0]], missing);
      assert.deepEqual(release.secondary[0].arms.map((a: FieldTrialsInterval) => [a.value, a.ciLower, a.ciUpper]), [[0, 0, 0], [0, 0, 0]], missing);
      assert.deepEqual(release.secondary[1], candidate.secondary[1], "repair rounds do not depend on merge evidence");
      assert.deepEqual(siteParse(release, [REPO]), { ok: true });
    }
    for (const incomplete of ["partial", "stale"]) {
      const github = structuredClone(fx.store("complete"));
      if (incomplete === "partial") github.repos[REPO]!.cursors.commits.state = "partial";
      else github.repos[REPO]!.cursors.commits.asOf = "2026-10-26T00:00:00.000Z";
      const result = await run(`main-${incomplete}`, ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { github });
      assert.match(result.out, /controlled release refused \(horizon-not-reached/);
      assert.equal(existsSync(join(result.dir, "controlled")), false);
    }
    // an incomplete pull history observed no outcomes: the epoch refuses rather than count unread merges as failures
    const lateRows = [...fx.rows, { step: "fix.dispatch", task_id: fx.task(4), ts: "2026-10-26T00:00:00.000Z", round_id: "late" }];
    const lateDerived = deriveRegisteredEpoch("sol61-vs-sonnet55", { rows: lateRows,
      merged: [{ trailerTaskIds: [fx.task(4)], mergedAt: "2026-10-26T00:00:00.000Z", mergedOnMain: true }], mergesObservedThrough: AS_OF, sourceRepos: [REPO] })!;
    assert.equal(lateDerived.outcomes.find((o) => o.taskId === fx.task(4))!.outcome, "not-merged");
    assert.equal(lateDerived.outcomes.find((o) => o.taskId === fx.task(4))!.fixRounds, 0);
    const partial = await run("partial", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { store: "partial" });
    assert.match(partial.out, /controlled release refused \(horizon-not-reached/);
    assert.equal(existsSync(join(partial.dir, "controlled")), false);
    // a draw not recorded through selectionPropensity is a missing propensity: the audit refuses
    const unrecorded = fx.rows.map((row) => row.step === "worker.assignment"
      ? { ...row, worker_assignment: { ...(row.worker_assignment as object), routing: { ...(row.worker_assignment as { routing: object }).routing, propensity: { method: "unavailable" } } } } : row);
    const audit = await run("audit", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { rows: unrecorded });
    assert.match(audit.out, /controlled release refused \(assignment-audit-failed: propensity-missing/);
    const unknownServed = fx.rows.map((row) => row.step === "worker.attempt" ? { ...row, served_model: "gpt-6.1-terra" } : row);
    const unknown = await run("unknown-served", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { rows: unknownServed });
    assert.match(unknown.out, /served-arm-outside-registered-arms/);
    assert.equal(existsSync(join(unknown.dir, "controlled")), false);
    const noReceipts = await run("missing-receipts", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT],
      { rows: fx.rows.filter((row) => row.step !== "worker.attempt") });
    assert.equal(noReceipts.code, 1);
    assert.match(noReceipts.out, /controlled release refused \(assignment-audit-failed: served-model-missingness/);
    assert.equal(existsSync(join(noReceipts.dir, "controlled")), false, "routing selections emit neither candidate nor sidecar");
    // an empty ledger has no assignments; an unregistered epoch and a malformed site commit are refused
    assert.match((await run("empty", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", SITE_COMMIT], { rows: [] })).out,
      /assignment-audit-failed: no-assignments-in-window/);
    assert.match((await run("unregistered", ["--controlled-registered", "terra-vs-sol", "--site-parser-commit", SITE_COMMIT])).out, /controlled-epoch-unregistered/);
    assert.equal(deriveRegisteredEpoch("terra-vs-sol", { rows: [], merged: [], mergesObservedThrough: null, sourceRepos: [REPO] }), null);
    assert.equal((await run("badsha", ["--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", "main"])).code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10843: an unreadable ledger refuses the registered epoch by name and emits nothing", async () => {
  const fx = productionFixture();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}controlled-ledger-unreadable-`));
  try {
    const consentPath = join(root, "consent.json");
    writeFileSync(consentPath, JSON.stringify(CONSENT));
    const dir = join(root, "out");
    mkdirSync(dir);
    writeFileSync(join(dir, "field-trials-github-v1.json"), JSON.stringify(fx.store("complete")));
    const printed: string[] = [];
    const code = await fieldTrialsCommand(["--source", "core=craigoley/remudero", "--ledger", `core=${root}`, "--out-dir", dir, "--consent", consentPath,
      "--offline", "--controlled-registered", "sol61-vs-sonnet55", "--site-parser-commit", "b".repeat(40)], buildFieldTrialsFlowSnapshot,
    { nowIso: AS_OF, print: (l) => printed.push(l), printError: () => undefined, readLedger: async () => unavailableLedger("fixture"),
      resolveConfig: () => ({ root }), readRows: async () => { throw new Error("ledger union unreadable"); } });
    assert.equal(code, 1, "a refused controlled release fails the command");
    assert.match(printed.join("\n"), /controlled release refused \(controlled-ledger-read-failed\)/);
    assert.equal(existsSync(join(dir, "controlled")), false, "no candidate and no sidecar are written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10843: no merge-only release before the site accepts secondaries", () => {
  for (const siteAcceptsSecondary of [undefined, false]) {
    const result = buildControlledFieldTrialsRelease({ ...input(), ...(siteAcceptsSecondary === undefined ? { siteAcceptsSecondary: undefined } : { siteAcceptsSecondary }) });
    assert.equal(result.state, "refused");
    assert.equal((result as { reason: string }).reason, "site-secondary-unavailable");
    assert.equal("release" in result, false, "no merge-only release is emitted");
  }
  assert.equal(buildControlledFieldTrialsRelease(input()).state, "candidate", "the same input releases once the site accepts the keys");
});

test("W1-T10843: site support requires the vendored accepting commit on main", async () => {
  const read = async () => siteMainEvidence;
  assert.deepEqual(await verifySiteSecondarySupport(SITE_SECONDARY_COMMIT, async (path) => {
    assert.equal(path, `repos/craigoley/remudero-site/compare/${SITE_SECONDARY_COMMIT}...main?per_page=1`);
    return siteMainEvidence;
  }), { ok: true });
  for (const evidence of [null, { ...siteMainEvidence, base_commit: { sha: HEX("f") } }, { ...siteMainEvidence, merge_base_commit: null }]) {
    assert.deepEqual(await verifySiteSecondarySupport(SITE_SECONDARY_COMMIT, async () => evidence), { ok: false, reason: "parser-commit-not-on-main" });
  }
  for (const status of ["behind", "diverged", "unknown"]) {
    assert.deepEqual(await verifySiteSecondarySupport(SITE_SECONDARY_COMMIT, async () => ({ ...siteMainEvidence, status })),
      { ok: false, reason: "parser-commit-not-on-main" });
  }
  assert.deepEqual(await verifySiteSecondarySupport(HEX("f"), read), { ok: false, reason: "parser-commit-not-vendored" });
  assert.deepEqual(await verifySiteSecondarySupport(SITE_SECONDARY_COMMIT, async () => { throw new Error("offline"); }),
    { ok: false, reason: "site-evidence-read-failed: offline" });
});

test("W1-T10843: secondary validation agrees with the real site parser", () => {
  const release = built().release;
  assert.equal(siteParserViolation(null), "keys");
  const invalid = [
    (r: typeof release) => { Object.assign(r, { extra: true }); },
    (r: typeof release) => { Object.assign(r, { evidence: "observational" }); },
    (r: typeof release) => { r.releaseId = "bad id"; },
    (r: typeof release) => { r.publishedAt = "2026-02-30T00:00:00.000Z"; },
    (r: typeof release) => { r.sourceRepos = []; },
    (r: typeof release) => { r.sourceRepos.push(r.sourceRepos[0]!); },
    (r: typeof release) => { r.consentRegistryRevision = "unregistered"; },
    (r: typeof release) => { r.arms.pop(); },
    (r: typeof release) => { Object.assign(r.arms[0]!, { extra: true }); },
    (r: typeof release) => { r.arms[0]!.assigned = 0.5; },
    (r: typeof release) => { r.arms[0]!.ciUpper = Infinity; },
    (r: typeof release) => { r.arms[1]!.modelId = r.arms[0]!.modelId; },
    (r: typeof release) => { r.secondary.push(r.secondary[0]!, r.secondary[0]!); },
    (r: typeof release) => { r.adherence.analysis = "as-served" as never; },
    (r: typeof release) => { r.secondary[0]!.arms[0]!.value = -1; },
    (r: typeof release) => { r.secondary[0]!.arms[0]!.value = 0.5; },
    (r: typeof release) => { r.secondary[0]!.arms[0]!.ciUpper = 101; },
    (r: typeof release) => { r.secondary[1]!.arms[0]!.value = Infinity; },
    (r: typeof release) => { r.secondary[1]!.arms[0]!.value = 0.55; },
    (r: typeof release) => { r.secondary[1]!.arms[0]!.ciLower = -1; },
    (r: typeof release) => { r.secondary[1]!.arms[0]!.arm = "outside"; },
    (r: typeof release) => { r.secondary[1]!.arms.reverse(); },
    (r: typeof release) => { r.secondary.push(r.secondary[0]!); },
    (r: typeof release) => { Object.assign(r.secondary[0]!, { extra: true }); },
    (r: typeof release) => { Object.assign(r.adherence, { extra: true }); },
  ];
  for (const mutate of invalid) {
    const changed = structuredClone(release);
    mutate(changed);
    assert.equal(parseFieldTrialsRelease(changed), null);
    assert.notEqual(siteParserViolation(changed), null);
  }
});
