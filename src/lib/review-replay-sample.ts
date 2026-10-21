import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { classifyReviewOutcome, reviewReplayInputDigest, type ReviewOutcomeClass,
  type ReviewOutcomeDecision, type ReviewReplayInput } from "./review-outcome-class.js";
import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";

export const REVIEW_REPLAY_SAMPLE_PATH = "test/fixtures/review-replay/sample.ndjson";
export const REVIEW_REPLAY_READ_STEPS = ["review.replay_input", "review.posted", "review.reviewer.skipped",
  "review.reviewer.untasked_defaults", "reviewer.regression_opened", "reviewer.regression_extended"];
export interface ReviewReplayRow {
  ts: string;
  pr_url: string;
  head_sha: string;
  reviewer_code_sha: string;
  input: ReviewReplayInput;
  input_digest: string;
  recorded_class: ReviewOutcomeClass;
}
export interface ReviewReplaySample {
  header: { format: "review-replay-v1"; window: { from: string; through: string };
    generator_revision: string; classes: ReviewOutcomeClass[]; digest: string };
  rows: ReviewReplayRow[];
}
const classes = (rows: readonly ReviewReplayRow[]): ReviewOutcomeClass[] => [...new Set(rows.map(r => r.recorded_class))].sort();
const digest = (rows: readonly ReviewReplayRow[]): string => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isClass = (value: unknown): value is ReviewOutcomeClass => value === "posted" || value === "withheld" || value === "refused";

function checkedInput(value: unknown): ReviewReplayInput {
  if (!record(value) || (value.stage !== "setup" && value.stage !== "semantic") ||
      !Number.isSafeInteger(value.criteria_count) || (value.criteria_count as number) < 0 ||
      typeof value.reviewer_outcome !== "string" || value.reviewer_outcome.length > 128 ||
      (value.setup_unavailable !== undefined && typeof value.setup_unavailable !== "boolean") ||
      (value.publication_refusal !== undefined &&
        (typeof value.publication_refusal !== "string" || value.publication_refusal.length > 160)) ||
      ["plan_only", "required_semantic", "risk_present", "budget_present", "untasked", "head_task_resolved",
        "own_task_record_missing"].some(k => typeof value[k] !== "boolean") ||
      !(value.verdict_lines === "unrecorded" || (Array.isArray(value.verdict_lines) &&
        value.verdict_lines.length <= 2 * (value.criteria_count as number) && value.verdict_lines.every(line =>
          typeof line === "string" && line.length <= 128 && /^REVIEW_VERDICT[ \t]+\d+[ \t]*:[ \t]*(PASS|FAIL)$/i.test(line))))) {
    throw new Error("invalid review replay input");
  }
  return value as unknown as ReviewReplayInput;
}

function checkedRow(value: unknown): ReviewReplayRow {
  if (!record(value) || !isClass(value.recorded_class)) throw new Error("invalid review replay row class");
  for (const key of ["ts", "pr_url", "head_sha", "reviewer_code_sha", "input_digest"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`invalid review replay row field: ${key}`);
  }
  if (!Number.isFinite(Date.parse(value.ts as string))) throw new Error("invalid review replay row timestamp");
  const input = checkedInput(value.input);
  if (reviewReplayInputDigest(input) !== value.input_digest) throw new Error("review replay input digest mismatch");
  return { ts: value.ts as string, pr_url: value.pr_url as string, head_sha: value.head_sha as string,
    reviewer_code_sha: value.reviewer_code_sha as string, input, input_digest: value.input_digest as string,
    recorded_class: value.recorded_class };
}

function validateSample(sample: ReviewReplaySample): void {
  if (sample.rows.length === 0) throw new Error("empty review replay sample");
  for (const row of sample.rows) checkedRow(row);
  if (digest(sample.rows) !== sample.header.digest) throw new Error("review replay header digest mismatch");
  if (JSON.stringify(classes(sample.rows)) !== JSON.stringify(sample.header.classes)) {
    throw new Error("review replay sample drops or adds an observed class");
  }
}

export function serializeReviewReplaySample(sample: ReviewReplaySample): string {
  validateSample(sample);
  return [sample.header, ...sample.rows].map(row => JSON.stringify(row)).join("\n") + "\n";
}

export function parseReviewReplaySample(text: string): ReviewReplaySample {
  const [header, ...rawRows] = text.trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown);
  if (!record(header) || header.format !== "review-replay-v1" || !record(header.window) ||
      typeof header.window.from !== "string" || typeof header.window.through !== "string" ||
      typeof header.generator_revision !== "string" || typeof header.digest !== "string" ||
      !Array.isArray(header.classes) || !header.classes.every(isClass)) throw new Error("invalid review replay header");
  const sample = { header: header as unknown as ReviewReplaySample["header"], rows: rawRows.map(checkedRow) };
  validateSample(sample);
  return sample;
}

export function replayReviewSample(sample: ReviewReplaySample,
  classify: (input: ReviewReplayInput) => ReviewOutcomeDecision = classifyReviewOutcome): void {
  validateSample(sample);
  for (const row of sample.rows) {
    const head = classify(row.input);
    if (head.class !== row.recorded_class) throw new Error(`${row.pr_url} ${row.input_digest}: recorded ${row.recorded_class}; head ${head.class}: ${head.reason}`);
  }
}

/** Legacy evidence reaches only setup: no transcript or semantic verdict is invented. */
function legacyRow(row: Record<string, unknown>, prior: readonly Record<string, unknown>[]): ReviewReplayRow | undefined {
  if (row.step !== "review.posted") return undefined;
  const skipped = prior.findLast(r => r.step === "review.reviewer.skipped" &&
    (r.reason === "head-task-metadata-unavailable" || r.reason === "plan-only"));
  const defaults = prior.findLast(r => r.step === "review.reviewer.untasked_defaults");
  if (!skipped && !defaults) return undefined;
  const missing = Array.isArray(skipped?.missing) ? skipped.missing : [];
  const count = Array.isArray(row.proof_exec) ? row.proof_exec.length :
    record(row.decision_verdict) && Array.isArray(row.decision_verdict.criteria) ? row.decision_verdict.criteria.length : undefined;
  if (count === undefined) return undefined;
  const input: ReviewReplayInput = { stage: "setup", plan_only: row.plan_only === true || skipped?.reason === "plan-only",
    required_semantic: true, criteria_count: count, risk_present: !missing.includes("risk"),
    budget_present: !missing.includes("budget_usd"), untasked: defaults !== undefined,
    head_task_resolved: count > 0, own_task_record_missing: false,
    reviewer_outcome: typeof row.reviewer_outcome === "string" ? row.reviewer_outcome : "not_recorded",
    verdict_lines: "unrecorded" };
  const provenance = record(row.reviewer_code_provenance) ? row.reviewer_code_provenance : undefined;
  return checkedRow({ ...row, reviewer_code_sha: row.reviewer_code_sha ?? provenance?.codeSha,
    input, input_digest: reviewReplayInputDigest(input), recorded_class: "posted" });
}

export function deriveReviewReplaySample(ledger: readonly Record<string, unknown>[],
  options: { generatorRevision: string; since?: string }): ReviewReplaySample {
  const regressed = new Set(ledger.filter(r => r.step === "reviewer.regression_opened" || r.step === "reviewer.regression_extended")
    .flatMap(r => [r.regressed_reviewer_code_sha, r.step === "reviewer.regression_extended" ? r.reviewer_code_sha : undefined])
    .filter((sha): sha is string => typeof sha === "string"));
  const byRun = new Map<string, Record<string, unknown>[]>();
  for (const raw of ledger) {
    if (typeof raw.run_id !== "string") continue;
    const group = byRun.get(raw.run_id) ?? [];
    group.push(raw);
    byRun.set(raw.run_id, group);
  }
  const recordedRuns = new Set(ledger.filter(r => r.step === "review.replay_input").map(r => r.run_id));
  const distinct = new Map<string, ReviewReplayRow>();
  const observed: ReviewReplayRow[] = [];
  for (const raw of ledger) {
    let row: ReviewReplayRow | undefined;
    if (raw.step === "review.replay_input") row = checkedRow(raw);
    else if (typeof raw.run_id === "string" && !recordedRuns.has(raw.run_id)) row = legacyRow(raw, byRun.get(raw.run_id) ?? []);
    if (!row || regressed.has(row.reviewer_code_sha) || (options.since !== undefined && row.ts < options.since)) continue;
    observed.push(row);
    const existing = distinct.get(row.input_digest);
    if (existing && existing.recorded_class !== row.recorded_class) throw new Error(`conflicting review outcomes for ${row.input_digest}`);
    if (!existing || row.ts < existing.ts) distinct.set(row.input_digest, row);
  }
  if (observed.length === 0) throw new Error("empty review replay sample: no attributable ledger inputs");
  const rows = [...distinct.values()].sort((a, b) => a.input_digest.localeCompare(b.input_digest));
  const times = observed.map(r => r.ts).sort();
  const sample: ReviewReplaySample = { header: { format: "review-replay-v1",
    window: { from: options.since ?? times[0]!, through: times.at(-1)! }, generator_revision: options.generatorRevision,
    classes: classes(observed), digest: digest(rows) }, rows };
  validateSample(sample);
  return sample;
}

export function refreshReviewReplaySample(options: { stateDir: string; root: string; generatorRevision: string;
  since?: string; readLedger?: typeof readLedgerUnionRecordsSync }): ReviewReplaySample {
  const ledger = (options.readLedger ?? readLedgerUnionRecordsSync)(options.stateDir,
    { step: REVIEW_REPLAY_READ_STEPS, requireArchives: true, refuseIncomplete: true });
  if (!ledger.ok || ledger.torn > 0) throw new Error("review replay refuses an incomplete ledger union");
  const sample = deriveReviewReplaySample(ledger.rows, options);
  writeAtomic(join(options.root, REVIEW_REPLAY_SAMPLE_PATH), serializeReviewReplaySample(sample));
  return sample;
}

export function reviewReplayGardenSpec(deps: GardenerDeps, generatorRevision: () => string):
  GardenSpec<"refresh", string, GardenAction<"refresh"> & { content: string }, GardenCheckout> {
  const inventory = (): string => {
    const ledger = readLedgerUnionRecordsSync(deps.stateDir,
      { step: REVIEW_REPLAY_READ_STEPS, requireArchives: true, refuseIncomplete: true });
    if (!ledger.ok || ledger.torn > 0) throw new Error("review replay refuses an incomplete ledger union");
    return serializeReviewReplaySample(deriveReviewReplaySample(ledger.rows, { generatorRevision: generatorRevision() }));
  };
  return { name: "review-replay", classes: ["refresh"], decision: ["refresh"],
    cheapFingerprint: () => inventory(), inventory, fingerprint: content => content,
    candidates: content => {
      const path = join(deps.repoRoot, REVIEW_REPLAY_SAMPLE_PATH);
      return existsSync(path) && readFileSync(path, "utf8") === content ? [] :
        [{ class: "refresh", target: REVIEW_REPLAY_SAMPLE_PATH, reason: "new recorded review inputs", content }];
    },
    scorecard: (_content, plan) => ({ proposed: plan.actions.length }),
    apply: (ws, plan) => {
      const content = plan.actions[0]?.content;
      if (content === undefined) return undefined;
      const path = join(ws.root, REVIEW_REPLAY_SAMPLE_PATH);
      if (existsSync(path) && readFileSync(path, "utf8") === content) return undefined;
      parseReviewReplaySample(content);
      writeAtomic(path, content);
      return { paths: [REVIEW_REPLAY_SAMPLE_PATH], title: "chore(test): refresh recorded review inputs",
        body: "Refresh every distinct healthy input from the retained ledger union.\n\nAcceptance:\n" +
          "- recorded classes survive replay | unit test: test/review/a-review-path-change-replays-recorded-reviews.test.ts" };
    },
  };
}
