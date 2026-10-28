/**
 * W1-T10831 — the field-note exporter writes a site candidate.
 *
 * The site (craigoley/remudero-site) shipped an importer for model-field-note-v1, but nothing in core
 * wrote that shape. `rmd field-trials --field-note <out>` now reads the private field-trials-flow-v1
 * snapshot and writes a candidate-unreviewed envelope whose `note` the site's own validator admits
 * once the site stamps its review fields. The validator below is a PINNED COPY of the site's
 * lib/model-field-note.ts parseModelFieldNote / validRow and lib/field-trials-consent.ts registry,
 * read 2026-10-28 from remudero-site main: if the site's rule moves, this copy is what to re-read.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildModelFieldNoteCandidate, PINNED_SITE_CONSENT_REGISTRY, SITE_MIN_CELL, SITE_ROW_LIMIT, SITE_SAFE_ID_RE, type FieldNoteWindows,
  type ModelFieldNoteCandidate, type SiteConsentRegistry } from "#src/lib/field-trials-field-note.js";
import { buildFieldTrialsFlowSnapshot, fieldTrialsCommand, readFieldTrialsLedger, SMALL_CELL_MIN, type FieldTrialsConsent,
  type FieldTrialsFlowSnapshot, type FieldTrialsSource } from "#src/lib/field-trials-flow.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { TaskCaseFile } from "#src/lib/task-case-file.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// ---- PINNED COPY of the site validator (remudero-site lib/model-field-note.ts) --------------------------------
const siteRowKeys = ["modelId", "taskClass", "assigned", "servedObserved", "callOutcomeObserved", "verified"];
const siteBodyKeys = ["schema", "releaseId", "status", "publicationScope", "evidence", "publishedAt", "windowStart",
  "windowEnd", "asOf", "sourceDigest", "sourceRepos", "consentRegistryRevision", "rows"];
const siteSafeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const siteDigest = /^[a-f0-9]{64}$/;
const siteMinCell = 10;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const publishableCount = (value: number, denominator: number) => (value === 0 || value >= siteMinCell)
  && (denominator - value === 0 || denominator - value >= siteMinCell);
function siteValidRow(value: unknown): boolean {
  if (!isRecord(value) || !exact(value, siteRowKeys) || typeof value.modelId !== "string" || !siteSafeId.test(value.modelId)
    || typeof value.taskClass !== "string" || !siteSafeId.test(value.taskClass) || !count(value.assigned)
    || !count(value.servedObserved) || !count(value.callOutcomeObserved) || !isRecord(value.verified)) return false;
  const assigned = value.assigned;
  if (assigned < siteMinCell * 2 || value.servedObserved > assigned || value.callOutcomeObserved > assigned
    || !publishableCount(value.servedObserved, assigned) || !publishableCount(value.callOutcomeObserved, assigned)) return false;
  const verified = value.verified;
  if (verified.state === "unavailable") return exact(verified, ["state", "reason"])
    && ["no-verified-outcome-join", "followup-window-open"].includes(String(verified.reason));
  if (verified.state !== "observed" || !exact(verified, ["state", "outcomes", "successes"]) || !count(verified.outcomes)
    || !count(verified.successes) || verified.outcomes > assigned || verified.successes > verified.outcomes) return false;
  return publishableCount(verified.outcomes, assigned) && publishableCount(verified.successes, verified.outcomes);
}
function siteParseModelFieldNote(input: unknown, registry: SiteConsentRegistry): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const ownerReviewed = exact(input, [...siteBodyKeys, "reviewedBy", "reviewedAt"]) && input.reviewedBy === "owner";
  const collectorStaged = exact(input, [...siteBodyKeys, "stagedBy", "stagedAt"]) && input.stagedBy === "field-trials-collector";
  if ((!ownerReviewed && !collectorStaged) || input.schema !== "model-field-note-v1" || input.status !== "published"
    || input.publicationScope !== "public-opt-in" || input.evidence !== "observational"
    || typeof input.releaseId !== "string" || !siteSafeId.test(input.releaseId)
    || typeof input.sourceDigest !== "string" || !siteDigest.test(input.sourceDigest)
    || input.consentRegistryRevision !== registry.revision) return null;
  const dates = [input.windowStart, input.windowEnd, input.asOf, ownerReviewed ? input.reviewedAt : input.stagedAt, input.publishedAt];
  if (!dates.every(timestamp) || !(dates[0]! < dates[1]! && dates[1]! <= dates[2]! && dates[2]! <= dates[3]! && dates[3]! <= dates[4]!
    && Date.parse(dates[4]!) <= Date.now())) return null;
  if (!Array.isArray(input.sourceRepos) || input.sourceRepos.length === 0 || new Set(input.sourceRepos).size !== input.sourceRepos.length
    || !input.sourceRepos.every((repo: unknown) => typeof repo === "string" && siteSafeId.test(repo))) return null;
  const byRepo = new Map(registry.entries.map((entry) => [entry.repository, entry]));
  if (!input.sourceRepos.every((repo: string) => byRepo.get(repo)?.state === "active" && byRepo.get(repo)?.scope === "aggregate-public")) return null;
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 24 || !input.rows.every(siteValidRow)) return null;
  const keys = input.rows.map((row: Record<string, unknown>) => `${String(row.modelId)}\u0000${String(row.taskClass)}`);
  return new Set(keys).size === keys.length ? input : null;
}
const wholeUtcDays = (start: string, end: string) => start < end && Date.parse(start) % 86_400_000 === 0 && Date.parse(end) % 86_400_000 === 0;
// ---- end of the pinned copy ------------------------------------------------------------------------------

const DAY = (day: number, hour = 0) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();
type Call = "served" | "served-failure" | "no-call" | "ladder-refusal" | "served-no-outcome";
type Verification = "completed" | "ended" | "open" | "unaccepted" | "mismatched" | "stale";
type Spec = { model: string; taskClass?: string; day: number; n: number; call: Call; host?: string; label?: string;
  verified?: Verification };

/** Ledger rows shaped like production: an assignment, and (unless no-call) the worker.attempt joined by assignment id. */
function assignmentCallRows(specs: Spec[]): Record<string, unknown>[] {
  return specs.flatMap((spec) => Array.from({ length: spec.n }, (_, i) => {
    const id = `asg-${spec.label ?? "core"}-${spec.model}-${spec.taskClass ?? "implement"}-${spec.day}-${spec.call}-${i}${spec.verified ? `-${spec.verified}` : ""}`;
    const base = { host: spec.host ?? "host-alpha-private", actor: "daemon", task_id: `task-${id}`, run_id: `run-${id}` };
    const assignment = { ...base, ts: DAY(spec.day, 2), step: "worker.assignment",
      worker_assignment: { id, requested: { model: spec.model }, selected: { provider: "p", model: spec.model } },
      benchmark_run: { work: { taskClass: { state: "observed", value: spec.taskClass ?? "implement" } } } };
    const attempt = { ...base, ts: DAY(spec.day, 3), step: "worker.attempt", selection_assignment_id: id,
      ...(spec.call === "served" ? { served_model: spec.model, success: true } : {}),
      ...(spec.call === "served-failure" ? { served_model: spec.model, success: false, worker_failure: "infra" } : {}),
      ...(spec.call === "served-no-outcome" ? { served_model: spec.model } : {}),
      ...(spec.call === "ladder-refusal" ? { success: false, worker_failure: "deployment-absent" } : {}) };
    return spec.call === "no-call" ? [assignment] : [assignment, attempt];
  }).flat());
}

function caseFileFor(row: Record<string, unknown>, asOf: string, verified: Verification): TaskCaseFile {
  const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf });
  const unavailable = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf };
  const id = (row.worker_assignment as { id: string }).id;
  const headSha = "a".repeat(40);
  const gate = observed({ headSha, status: "success" as const });
  return { version: "task-case-file-v1", taskId: String(row.task_id),
    asOf: verified === "stale" ? DAY(1) : asOf, plan: unavailable,
    ledger: observed({ windowStart: DAY(1), forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 2 }),
    runs: [{ runId: String(row.run_id), startedAt: String(row.ts),
      assignmentId: verified === "mismatched" ? `other-${id}` : id, selectedProvider: "p", selectedModel: null,
      servedModel: null, billingMode: null, costUsd: null, verdict: verified === "ended" ? "no_pr" : "merged",
      prNumber: verified === "ended" ? null : 123 }],
    pr: verified === "ended" ? { ...unavailable, reason: "no-pr-in-current-projection", source: "github-pr-read" }
      : observed({ number: 123, url: "https://example.com/pull/123", headSha,
        state: verified === "open" ? "OPEN" as const : "MERGED" as const, taskCredit: true }),
    review: gate, acceptance: verified === "unaccepted" ? unavailable : gate, ci: gate,
    mergedSource: observed({ prNumber: 123, mergedAt: new Date(Date.parse(String(row.ts)) + 3 * 3_600_000).toISOString() }),
    deployment: unavailable, runtime: unavailable, next: null };
}

async function snapshotOf(asOf: string, sources: { label: string; repo: string; specs: Spec[] }[],
  prior?: FieldTrialsFlowSnapshot, omitCaseFiles = false): Promise<FieldTrialsFlowSnapshot> {
  const observed: FieldTrialsSource[] = [];
  const caseFiles: TaskCaseFile[] = [];
  for (const { label, repo, specs } of sources) {
    for (const spec of specs) if (spec.verified) {
      for (const row of assignmentCallRows([{ ...spec, label }]).filter((row) => row.step === "worker.assignment")) {
        caseFiles.push(caseFileFor(row, asOf, spec.verified));
      }
    }
    const fixture = writeLedger(assignmentCallRows(specs.map((spec) => ({ ...spec, label }))));
    try {
      observed.push({ label, repo, ledger: await readFieldTrialsLedger(fixture.dir, Date.parse(asOf)) });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
  return buildFieldTrialsFlowSnapshot({ asOf, github: { version: "field-trials-github-v1", repos: {} }, sources: observed,
    ...(omitCaseFiles ? {} : { caseFiles }), ...(prior ? { prior } : {}) });
}

const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: [
  { repo: "craigoley/remudero", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-craig-oley" },
  { repo: "craigoley/remudero-console", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-craig-oley" },
] };
const NO_WINDOWS: FieldNoteWindows = { version: "field-note-windows-v1", windows: [] };
const candidateOf = (snapshot: FieldTrialsFlowSnapshot, overrides: Partial<Parameters<typeof buildModelFieldNoteCandidate>[0]> = {}) =>
  buildModelFieldNoteCandidate({ snapshot, consent: CONSENT, registry: PINNED_SITE_CONSENT_REGISTRY, windows: NO_WINDOWS,
    salt: "salt-one", nowIso: DAY(4, 7), ...overrides });
const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}field-note-${name}-`));
const reviewed = (note: ModelFieldNoteCandidate["note"], at: string) => ({ ...note, reviewedBy: "owner", reviewedAt: at, publishedAt: at });

test("W1-T10831: the field-note candidate passes the site validator once reviewed", async () => {
  const snapshot = await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: [
    { model: "gpt-6.1-sol", day: 1, n: 20, call: "served", verified: "completed" }, { model: "gpt-6.1-sol", day: 2, n: 10, call: "no-call" },
    { model: "claude-opus-5", day: 2, n: 20, call: "served" }, { model: "claude-opus-5", day: 3, n: 10, call: "ladder-refusal" },
    { model: "claude-opus-5", taskClass: "review", day: 3, n: 10, call: "served", verified: "completed" },
    { model: "claude-opus-5", taskClass: "review", day: 3, n: 10, call: "served-no-outcome", verified: "ended" },
    { model: "gpt-6.1-sol", taskClass: "review", day: 3, n: 20, call: "served-failure", verified: "ended" },
    { model: "gpt-6.1-sol", day: 4, n: 12, call: "served", verified: "completed" }] }]);
  const result = candidateOf(snapshot);
  assert.equal(result.state, "candidate");
  if (result.state !== "candidate") return;
  const { candidate } = result;
  assert.equal(candidate.state, "candidate-unreviewed", "core writes a candidate, never a published note");
  for (const field of ["reviewedBy", "reviewedAt", "publishedAt", "stagedBy", "stagedAt"]) {
    assert.equal(Object.hasOwn(candidate.note, field), false, `core never stamps ${field}`);
  }
  assert.equal(siteParseModelFieldNote(candidate.note, PINNED_SITE_CONSENT_REGISTRY), null, "unstamped, the site refuses the note");
  const stamped = reviewed(candidate.note, candidate.note.asOf);
  assert.ok(siteParseModelFieldNote(stamped, PINNED_SITE_CONSENT_REGISTRY), "once reviewed, the site's validator admits the note");
  assert.ok(siteParseModelFieldNote({ ...candidate.note, stagedBy: "field-trials-collector", stagedAt: candidate.note.asOf,
    publishedAt: candidate.note.asOf }, PINNED_SITE_CONSENT_REGISTRY), "and so does the site's collector-staged stamp");
  assert.deepEqual([candidate.note.windowStart, candidate.note.windowEnd], [DAY(1), DAY(4)],
    "whole UTC days from the first observed day to the start of the snapshot's partial day");
  assert.ok(wholeUtcDays(candidate.note.windowStart, candidate.note.windowEnd));
  assert.deepEqual(candidate.note.sourceRepos, ["remudero"], "core's owner/repo maps to the site's bare repository name");
  assert.deepEqual(candidate.note.rows.map((row) => [row.modelId, row.taskClass, row.assigned, row.servedObserved, row.callOutcomeObserved]), [
    ["claude-opus-5", "implement", 30, 20, 30], ["gpt-6.1-sol", "implement", 30, 20, 20],
    ["claude-opus-5", "review", 20, 20, 10], ["gpt-6.1-sol", "review", 20, 20, 20],
  ], "joined true and false outcomes count regardless of attribution; absent outcomes and calls do not; day 4 is excluded");
  assert.deepEqual(candidate.note.rows.map((row) => row.verified), [
    { state: "unavailable", reason: "no-verified-outcome-join" },
    { state: "observed", outcomes: 20, successes: 20 }, { state: "observed", outcomes: 20, successes: 10 },
    { state: "observed", outcomes: 20, successes: 0 },
  ], "case-file completions and terminal non-completions survive the selected-model join independently of worker outcomes");
  assert.deepEqual(candidate.servedModelGap.rows.find((row) => row.modelId === "gpt-6.1-sol"),
    { modelId: "gpt-6.1-sol", taskClass: "implement", assigned: 30, servedObserved: 20, servedUnknown: 10 });
  assert.match(candidate.note.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(candidate.note.consentRegistryRevision, "owner-2026-09-25-v1");
});

test("W1-T10831: small cells and complements are withheld from the field note", async () => {
  const snapshot = await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: [
    { model: "model-ok", day: 1, n: 20, call: "served" },
    { model: "model-six", day: 1, n: 6, call: "served" },
    { model: "model-nineteen", day: 1, n: 19, call: "served" },
    { model: "model-served-complement", day: 1, n: 21, call: "served" }, { model: "model-served-complement", day: 2, n: 4, call: "no-call" },
    { model: "model-outcome-small", day: 1, n: 5, call: "served" }, { model: "model-outcome-small", day: 2, n: 20, call: "served-no-outcome" },
    { model: "model:colon", day: 1, n: 20, call: "served" }] }]);
  assert.ok(6 >= SMALL_CELL_MIN && 6 < SITE_MIN_CELL * 2, "core's own floor would show the six-assignment cell; the site's must not");
  const result = candidateOf(snapshot);
  assert.equal(result.state, "candidate");
  if (result.state !== "candidate") return;
  assert.deepEqual(result.candidate.note.rows.map((row) => row.modelId), ["model-ok"]);
  assert.deepEqual(result.candidate.withheld.reasons, { "assigned-below-twice-min-cell": 2, "served-observed-or-complement-small": 1,
    "call-outcome-or-complement-small": 1, "model-id-not-site-safe": 1 }, "each failing cell is withheld and counted by reason");
  assert.equal(result.candidate.withheld.cells, 5);
  assert.equal(SITE_SAFE_ID_RE.test("model:colon"), false, "core's model pattern admits a colon; the site's does not");
  assert.equal(SITE_SAFE_ID_RE.test("gpt-6.1-sol"), true);
  assert.equal(SITE_SAFE_ID_RE.source, siteSafeId.source, "core's copy of the site's safeId is the pinned one");

  const many = Array.from({ length: SITE_ROW_LIMIT + 2 }, (_, i) => ({ model: `model-${String(i).padStart(2, "0")}`, day: 1,
    n: 20 + (i % 3) * 10, call: "served" as const }));
  const crowded = candidateOf(await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: many }]));
  const reversed = candidateOf(await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: [...many].reverse() }]));
  assert.equal(crowded.state, "candidate");
  if (crowded.state !== "candidate" || reversed.state !== "candidate") return;
  assert.equal(crowded.candidate.note.rows.length, SITE_ROW_LIMIT, "never more rows than the site admits");
  assert.deepEqual(crowded.candidate.withheld.reasons, { "row-limit": 2 });
  assert.deepEqual(crowded.candidate.note.rows, reversed.candidate.note.rows, "the kept subset does not depend on input order");
  assert.deepEqual(crowded.candidate.note.rows.slice(0, 3).map((row) => row.assigned), [40, 40, 40], "the largest cells are kept first");
  assert.ok(siteParseModelFieldNote(reviewed(crowded.candidate.note, crowded.candidate.note.asOf), PINNED_SITE_CONSENT_REGISTRY));
  const none = candidateOf(await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: [
    { model: "model-six", day: 1, n: 6, call: "served" }] }]));
  assert.deepEqual(none, { state: "withheld", reason: "no-publishable-row",
    withheld: { cells: 1, reasons: { "assigned-below-twice-min-cell": 1 }, sources: [] } }, "no publishable row is no candidate");
});

test("W1-T10831: verified counts and their complements obey the pinned site disclosure rule", async () => {
  const snapshot = await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: [
    { model: "model-ok", day: 1, n: 20, call: "served", verified: "completed" },
    { model: "outcomes-small", day: 1, n: 5, call: "served", verified: "completed" },
    { model: "outcomes-small", day: 2, n: 15, call: "served" },
    { model: "outcomes-complement-small", day: 1, n: 20, call: "served", verified: "completed" },
    { model: "outcomes-complement-small", day: 2, n: 5, call: "served" },
    { model: "successes-small", day: 1, n: 5, call: "served", verified: "completed" },
    { model: "successes-small", day: 2, n: 15, call: "served", verified: "ended" },
    { model: "successes-complement-small", day: 1, n: 15, call: "served", verified: "completed" },
    { model: "successes-complement-small", day: 2, n: 5, call: "served", verified: "ended" }] }]);
  const result = candidateOf(snapshot);
  assert.equal(result.state, "candidate");
  if (result.state !== "candidate") return;
  assert.deepEqual(result.candidate.note.rows.map((row) => row.modelId), ["model-ok"]);
  assert.deepEqual(result.candidate.withheld.reasons, { "verified-outcomes-or-complement-small": 2,
    "verified-successes-or-complement-small": 2 });
  assert.equal(result.candidate.withheld.cells, 4, "a sensitive verified count withholds the entire cell");
  assert.ok(siteParseModelFieldNote(reviewed(result.candidate.note, result.candidate.note.asOf), PINNED_SITE_CONSENT_REGISTRY));
  for (const verified of [{ state: "observed", outcomes: 5, successes: 5 }, { state: "observed", outcomes: 20, successes: 5 }]) {
    assert.equal(siteValidRow({ ...result.candidate.note.rows[0], verified }), false,
      "the pinned site validator independently rejects the withheld subgroups");
  }
});

test("W1-T10831: only the verified outcome join can populate verified field-note counts", async () => {
  const specs: Spec[] = ["open", "unaccepted", "mismatched", "stale"].map((verified) => ({ model: `model-${verified}`,
    day: 1, n: 20, call: "served", verified: verified as Verification }));
  const result = candidateOf(await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs }]));
  assert.equal(result.state, "candidate");
  if (result.state !== "candidate") return;
  assert.equal(result.candidate.note.rows.length, 4);
  for (const row of result.candidate.note.rows) {
    assert.equal(row.callOutcomeObserved, 20, "successful worker calls do not prove verified completion");
    assert.deepEqual(row.verified, { state: "unavailable", reason: "no-verified-outcome-join" }, row.modelId);
  }
  const sources = [{ label: "core", repo: "craigoley/remudero", specs: [
    { model: "model-verified", day: 1, n: 20, call: "served" as const, verified: "completed" as const }] }];
  const before = await snapshotOf(DAY(4, 6), sources, undefined, true);
  const after = await snapshotOf(DAY(4, 6), sources, before);
  const afterResult = candidateOf(after);
  assert.equal(afterResult.state, "candidate");
  if (afterResult.state !== "candidate") return;
  assert.deepEqual(afterResult.candidate.note.rows[0]!.verified, { state: "observed", outcomes: 20, successes: 20 });
  const beforeResult = candidateOf(before);
  assert.equal(beforeResult.state, "candidate");
  if (beforeResult.state !== "candidate") return;
  assert.notEqual(afterResult.candidate.note.sourceDigest, beforeResult.candidate.note.sourceDigest,
    "new case-file evidence invalidates adoption partitions and changes the candidate's input digest");
  const reused = await snapshotOf(DAY(4, 6), sources, after);
  assert.deepEqual(reused.families.adoption, after.families.adoption, "unchanged verified evidence reuses its cross-tab");
  assert.equal(reused.rebuild.rebuiltPartitions.some((key) => key.startsWith("adoption:")), false);
  const withdrawn = candidateOf(await snapshotOf(DAY(4, 6), sources, after, true));
  assert.equal(withdrawn.state, "candidate");
  if (withdrawn.state !== "candidate") return;
  assert.deepEqual(withdrawn.candidate.note.rows[0]!.verified, { state: "unavailable", reason: "no-verified-outcome-join" },
    "removing case-file evidence also invalidates cached verified counts");
  for (const field of ["verifiedOutcomes", "verifiedSuccesses"] as const) {
    const legacy = structuredClone(after);
    for (const partition of Object.values(legacy.families.adoption)) {
      for (const cell of Object.values(partition.cells.bySelected)) delete (cell as Partial<typeof cell>)[field];
    }
    assert.deepEqual(candidateOf(legacy), { state: "refused", reason: "snapshot-predates-verified-outcome-cross-tab" },
      "an older cross-tab cannot silently discard verified evidence as unavailable");
  }
});

test("W1-T10831: the field note honours the consent receipts and carries no private ids", async () => {
  const specs: Spec[] = [{ model: "gpt-6.1-sol", day: 1, n: 20, call: "served", verified: "completed" },
    { model: "gpt-6.1-sol", day: 2, n: 10, call: "no-call" }];
  const snapshot = await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs },
    { label: "console", repo: "craigoley/remudero-console", specs: specs.map((spec) => ({ ...spec, host: "host-beta-private" })) },
    { label: "lab", repo: "craigoley/remudero-lab", specs }]);
  assert.deepEqual(candidateOf(snapshot, { consent: null }), { state: "withheld", reason: "no-consent-receipt" });
  assert.deepEqual(candidateOf(snapshot, { consent: "consent-invalid" }), { state: "withheld", reason: "consent-invalid" });
  assert.deepEqual(candidateOf(snapshot, { consent: { version: "field-trials-consent-v1", repos: CONSENT.repos.map((entry) =>
    ({ ...entry, revoked: true })) } }), { state: "withheld", reason: "no-aggregate-consent" }, "revoked receipts withdraw every source");
  assert.deepEqual(candidateOf(snapshot, { consent: { version: "field-trials-consent-v1", repos: CONSENT.repos.map((entry) =>
    ({ ...entry, rights: "private" as const })) } }), { state: "withheld", reason: "no-aggregate-consent" });
  const benchmarkConsent: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: CONSENT.repos.map((entry) =>
    ({ ...entry, rights: "public-benchmark", publicSourceUrl: "https://example.com/benchmark" })) };
  assert.deepEqual(candidateOf(snapshot, { consent: benchmarkConsent }), { state: "withheld", reason: "no-aggregate-consent" },
    "a public-benchmark receipt cannot replace aggregate-opt-in consent");
  const mixed = candidateOf(snapshot, { consent: { ...CONSENT, repos: [benchmarkConsent.repos[0]!, CONSENT.repos[1]!] } });
  assert.equal(mixed.state, "candidate");
  if (mixed.state !== "candidate") return;
  assert.deepEqual(mixed.candidate.note.sourceRepos, ["remudero-console"]);
  assert.deepEqual(mixed.candidate.note.rows.map((row) => [row.assigned, row.servedObserved, row.callOutcomeObserved]), [[30, 20, 20]],
    "only the source with live aggregate-opt-in consent contributes counts");
  assert.deepEqual(mixed.candidate.note.rows[0]!.verified, { state: "observed", outcomes: 20, successes: 20 });
  assert.deepEqual(mixed.candidate.withheld.sources.map((source) => source.reason), ["no-aggregate-consent", "no-aggregate-consent"]);

  const revokedCore = candidateOf(snapshot, { consent: { version: "field-trials-consent-v1", repos: [{ ...CONSENT.repos[0]!, revoked: true },
    CONSENT.repos[1]!, { repo: "craigoley/remudero-lab", rights: "aggregate-opt-in", receipt: "lab-receipt" }] } });
  assert.equal(revokedCore.state, "candidate");
  if (revokedCore.state !== "candidate") return;
  assert.deepEqual(revokedCore.candidate.note.sourceRepos, ["remudero-console"],
    "a revoked receipt withdraws its repo, and a repo absent from the site registry never contributes");
  assert.deepEqual(revokedCore.candidate.withheld.sources.map((source) => source.reason).sort(), ["no-aggregate-consent", "not-active-in-site-registry"]);
  const siteRevoked: SiteConsentRegistry = { ...PINNED_SITE_CONSENT_REGISTRY, entries: PINNED_SITE_CONSENT_REGISTRY.entries.map((entry) =>
    entry.repository === "remudero-console" ? { ...entry, state: "revoked" as const } : entry) };
  const both = candidateOf(snapshot, { registry: siteRevoked });
  assert.equal(both.state === "candidate" && both.candidate.note.sourceRepos.join(), "remudero", "the site registry's revocation also withdraws");
  assert.deepEqual(candidateOf(snapshot, { registry: "site-registry-invalid" }), { state: "withheld", reason: "site-registry-invalid" });

  const full = candidateOf(snapshot);
  assert.equal(full.state, "candidate");
  if (full.state !== "candidate") return;
  assert.deepEqual(full.candidate.note.rows.map((row) => [row.assigned, row.servedObserved]), [[60, 40]],
    "the two consented sources pool into one row; the unconsented one adds nothing");
  assert.deepEqual(full.candidate.note.rows[0]!.verified, { state: "observed", outcomes: 40, successes: 40 });
  assert.deepEqual(full.candidate.note.sourceRepos, ["remudero", "remudero-console"]);
  const encoded = JSON.stringify(full.candidate);
  const strings: string[] = [];
  const walk = (value: unknown): void => { if (typeof value === "string") strings.push(value); else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) for (const [key, item] of Object.entries(value)) { strings.push(key); walk(item); } };
  walk(full.candidate);
  for (const key of snapshot.privateKeys) assert.equal(encoded.includes(key), false, `private join key leaked: ${key}`);
  for (const value of ["host-alpha-private", "host-beta-private", "asg-core", "task-asg", "run-asg", "craigoley/", "owner-2026-10-27-craig-oley"]) {
    assert.equal(encoded.includes(value), false, `private value leaked: ${value}`);
  }
  for (const label of ["core", "console", "lab"]) assert.equal(strings.includes(label), false, `a source label is pseudonymised: ${label}`);
  assert.ok(full.candidate.sources.every((source) => /^src-[0-9a-f]{12}$/.test(source.source)));
  const leaking = { ...snapshot, privateKeys: [...snapshot.privateKeys, "gpt-6.1-sol"] };
  assert.deepEqual(candidateOf(leaking), { state: "refused", reason: "private-join-key-in-candidate" }, "a leak refuses the whole candidate");

  const root = tempDir("consent");
  try {
    const outDir = join(root, "ft");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "field-trials-flow-v1.json"), JSON.stringify(snapshot));
    const out = join(root, "candidate.json");
    const lines: string[] = [];
    const run = (extra: string[]) => fieldTrialsCommand(["--out-dir", outDir, "--field-note", out, ...extra], buildFieldTrialsFlowSnapshot,
      { nowIso: DAY(4, 7), print: (line) => lines.push(line), resolveConfig: () => ({ root }) });
    assert.equal(await run([]), 0);
    assert.equal(lines.at(-1), "field-trials: field note withheld (no-consent-receipt)");
    assert.equal(existsSync(out), false, "no consent file writes no candidate");
    assert.equal(existsSync(join(outDir, "field-trials-field-note-windows.json")), false, "and records no window");
    writeFileSync(join(root, "consent.json"), JSON.stringify(benchmarkConsent));
    assert.equal(await run(["--consent", join(root, "consent.json")]), 0);
    assert.equal(lines.at(-1), "field-trials: field note withheld (no-aggregate-consent)");
    assert.equal(existsSync(out), false, "public-benchmark consent writes no candidate");
    assert.equal(existsSync(join(outDir, "field-trials-field-note-windows.json")), false, "and records no exported window");
    writeFileSync(join(root, "consent.json"), JSON.stringify(CONSENT));
    writeFileSync(join(root, "registry.json"), JSON.stringify({ revision: "owner-2026-09-25-v1", entries: [{ repository: "remudero",
      state: "active", scope: "aggregate-public", approvedOn: "2026-09-25", approvedBy: "owner" }] }));
    assert.equal(await run(["--consent", join(root, "consent.json"), "--site-registry", join(root, "registry.json"), "--json"]), 0);
    const printed = JSON.parse(lines.at(-1)!);
    assert.equal(printed.state, "candidate");
    const written = JSON.parse(readFileSync(out, "utf8")) as ModelFieldNoteCandidate;
    assert.deepEqual(written.note.sourceRepos, ["remudero"], "the operator's pinned registry decides which repos may contribute");
    assert.deepEqual(written.note.rows[0]!.verified, { state: "observed", outcomes: 20, successes: 20 },
      "the command writes the verified cross-tab from the saved snapshot");
    assert.ok(siteParseModelFieldNote(reviewed(written.note, written.note.asOf), PINNED_SITE_CONSENT_REGISTRY));
    assert.equal(statSync(out).mode & 0o777, 0o600, "the candidate stays private until the site imports it");
    writeFileSync(join(root, "bad-registry.json"), JSON.stringify({ revision: "", entries: [] }));
    assert.equal(await run(["--consent", join(root, "consent.json"), "--site-registry", join(root, "bad-registry.json")]), 0);
    assert.equal(lines.at(-1), "field-trials: field note withheld (site-registry-invalid)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10831: consecutive field-note windows never overlap", async () => {
  const root = tempDir("windows");
  try {
    const outDir = join(root, "ft");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(root, "consent.json"), JSON.stringify(CONSENT));
    const out = join(root, "candidate.json");
    const lines: string[] = [];
    const run = (nowIso: string) => fieldTrialsCommand(["--out-dir", outDir, "--field-note", out, "--consent", join(root, "consent.json")],
      buildFieldTrialsFlowSnapshot, { nowIso, print: (line) => lines.push(line), resolveConfig: () => ({ root }) });
    const firstDays: Spec[] = [1, 2, 3].map((day) => ({ model: "gpt-6.1-sol", day, n: 10, call: "served", verified: "completed" }));
    const laterDays: Spec[] = [4, 5, 6].map((day) => ({ model: "gpt-6.1-sol", day, n: 7, call: "served", verified: "ended" }));
    writeFileSync(join(outDir, "field-trials-flow-v1.json"), JSON.stringify(await snapshotOf(DAY(4, 6),
      [{ label: "core", repo: "craigoley/remudero", specs: firstDays }])));
    assert.equal(await run(DAY(4, 7)), 0);
    assert.match(lines.at(-1)!, /^field-trials: field note candidate-unreviewed fn-2026-09-01-2026-09-04-[0-9a-f]{12} .*: 1 rows, 0 cells withheld/);
    const first = JSON.parse(readFileSync(out, "utf8")) as ModelFieldNoteCandidate;
    assert.deepEqual([first.note.windowStart, first.note.windowEnd, first.note.rows[0]!.assigned], [DAY(1), DAY(4), 30]);

    writeFileSync(join(outDir, "field-trials-flow-v1.json"), JSON.stringify(await snapshotOf(DAY(7, 6),
      [{ label: "core", repo: "craigoley/remudero", specs: [...firstDays, ...laterDays] }])));
    assert.equal(await run(DAY(7, 7)), 0);
    const second = JSON.parse(readFileSync(out, "utf8")) as ModelFieldNoteCandidate;
    assert.deepEqual([second.note.windowStart, second.note.windowEnd], [first.note.windowEnd, DAY(7)],
      "the second window starts where the first exported window ended, not at a fixed lookback");
    assert.equal(second.note.rows[0]!.assigned, 21, "only the new whole days are counted");
    assert.deepEqual(second.note.rows[0]!.verified, { state: "observed", outcomes: 21, successes: 0 },
      "verified counts also exclude the prior exported window");
    assert.ok(second.note.windowStart >= first.note.windowEnd && wholeUtcDays(second.note.windowStart, second.note.windowEnd));
    assert.notEqual(second.note.releaseId, first.note.releaseId);
    assert.ok(siteParseModelFieldNote(reviewed(second.note, second.note.asOf), PINNED_SITE_CONSENT_REGISTRY));
    const windowsPath = join(outDir, "field-trials-field-note-windows.json");
    const recorded = JSON.parse(readFileSync(windowsPath, "utf8")) as FieldNoteWindows;
    assert.deepEqual(recorded.windows.map((entry) => [entry.windowStart, entry.windowEnd]), [[DAY(1), DAY(4)], [DAY(4), DAY(7)]]);
    assert.equal(statSync(windowsPath).mode & 0o777, 0o600, "the window record is private");

    assert.equal(await run(DAY(7, 8)), 0);
    assert.equal(lines.at(-1), "field-trials: field note withheld (no-new-whole-utc-day)", "a re-run inside the same day exports nothing");
    const savedCandidate = readFileSync(out, "utf8");
    for (const corrupt of [JSON.stringify({ version: "something-else" }), '{"version":', "", "null", "[]"]) {
      writeFileSync(windowsPath, corrupt);
      assert.equal(await run(DAY(8, 7)), 1, `corrupt history must refuse: ${JSON.stringify(corrupt)}`);
      assert.equal(lines.at(-1), "field-trials: field note refused (field-note-windows-invalid)");
      assert.equal(readFileSync(out, "utf8"), savedCandidate, "a refused export preserves the existing candidate");
      assert.equal(readFileSync(windowsPath, "utf8"), corrupt, "a corrupt history is never overwritten with overlapping windows");
    }
    rmSync(windowsPath);
    mkdirSync(windowsPath);
    assert.equal(await run(DAY(8, 7)), 1, "an unreadable history must refuse, rather than act like an absent file");
    assert.equal(lines.at(-1), "field-trials: field note refused (field-note-windows-invalid)");
    assert.equal(readFileSync(out, "utf8"), savedCandidate);
    assert.ok(statSync(windowsPath).isDirectory(), "a read failure leaves history untouched");
    rmSync(join(outDir, "field-trials-flow-v1.json"));
    assert.equal(await run(DAY(8, 7)), 1);
    assert.equal(lines.at(-1), "field-trials: field note refused (no-snapshot)");

    const empty = await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: [] }]);
    assert.deepEqual(candidateOf(empty), { state: "withheld", reason: "no-observed-assignment-day" }, "no day observed is no window");
    assert.deepEqual(candidateOf({ ...empty, state: "unavailable" }), { state: "refused", reason: "snapshot-unavailable" });
    const legacy = await snapshotOf(DAY(4, 6), [{ label: "core", repo: "craigoley/remudero", specs: firstDays }]);
    for (const partition of Object.values(legacy.families.adoption)) delete (partition.cells as { bySelected?: unknown }).bySelected;
    assert.deepEqual(candidateOf(legacy), { state: "refused", reason: "snapshot-predates-selected-model-cross-tab" },
      "a snapshot written before the cross-tab cannot be read as zero served-known assignments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
