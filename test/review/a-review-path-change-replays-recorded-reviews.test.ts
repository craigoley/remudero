import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { classifyReviewOutcome, recordedReviewVerdictLines, reviewReplayLedgerFields,
  type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, parseReviewReplaySample, replayReviewSample,
  refreshReviewReplaySample, REVIEW_REPLAY_SAMPLE_PATH, reviewReplayGardenSpec,
  serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";
import { selectAffectedSuites } from "#src/lib/affected-suites.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { reviewCommand } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";

const samplePath = new URL("../fixtures/review-replay/sample.ndjson", import.meta.url);
const input = (overrides: Partial<ReviewReplayInput> = {}): ReviewReplayInput => ({
  stage: "semantic", plan_only: false, required_semantic: true, criteria_count: 1,
  risk_present: true, budget_present: true, untasked: false, head_task_resolved: true,
  own_task_record_missing: false, reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: PASS"],
  ...overrides,
});
const row = (i: ReviewReplayInput, recordedClass = classifyReviewOutcome(i).class, sha = "healthy"): Record<string, unknown> => ({
  ts: "2026-10-19T12:00:00.000Z", step: "review.replay_input",
  ...reviewReplayLedgerFields(i, { class: recordedClass, reason: "observed" }, {
    pr_url: "https://github.com/acme/remudero/pull/1", head_sha: "head", reviewer_code_sha: sha,
  }),
});
const derive = (rows: Record<string, unknown>[]) => deriveReviewReplaySample(rows, { generatorRevision: "test" });

test("W1-T10270: every recorded review replays to its recorded verdict class", (t) => {
  const sample = parseReviewReplaySample(readFileSync(samplePath, "utf8"));
  replayReviewSample(sample);
  t.diagnostic(`classes with recorded verdict lines: ${[...new Set(sample.rows
    .filter(r => r.input.verdict_lines !== "unrecorded").map(r => r.recorded_class))].sort().join(", ") || "none (setup bootstrap only)"}`);
});

test("W1-T10270: the 12954 decision turns recorded PASS reviews into withheld and fails the replay", () => {
  const pass = input();
  const withoutBudget = input({ stage: "setup", budget_present: false, verdict_lines: "unrecorded" });
  const sample = derive([row(pass, "posted"), row(withoutBudget, "posted")]);
  replayReviewSample(sample);
  assert.throws(() => replayReviewSample(sample, i => i.verdict_lines === "unrecorded"
    ? { class: "refused", reason: "head-task-metadata-unavailable" }
    : { class: "withheld", reason: "required-semantic-incomplete-verdicts" }), /recorded posted.*head (withheld|refused)/);
  assert.throws(() => replayReviewSample(derive([row(withoutBudget, "posted")]), () =>
    ({ class: "refused", reason: "head-task-metadata-unavailable" })), /recorded posted.*head refused/);
  assert.equal(classifyReviewOutcome(pass).class, "posted");
  assert.equal(classifyReviewOutcome(withoutBudget).class, "posted");
});

test("W1-T10270: an empty, incomplete or hand-edited sample fails the replay", () => {
  assert.throws(() => derive([]), /empty/);
  const sample = derive([row(input()), row(input({ reviewer_outcome: "spawn_error" }))]);
  assert.throws(() => replayReviewSample({ ...sample, rows: [] }), /empty/);
  assert.throws(() => replayReviewSample({ ...sample, rows: sample.rows.slice(0, 1) }), /digest|class/);
  const edited = serializeReviewReplaySample(sample).replace('"reviewer_outcome":"success"', '"reviewer_outcome":"error"');
  assert.throws(() => parseReviewReplaySample(edited), /digest/);
  assert.throws(() => parseReviewReplaySample("{}\n"), /header/);
  assert.throws(() => replayReviewSample({ ...sample, header: { ...sample.header, classes: ["posted", "withheld", "refused"] } }), /class/);
});

test("W1-T10270: the sample is refreshed from the ledger and excludes regressed reviewer shas", () => {
  const a = row(input());
  const b = row(input({ reviewer_outcome: "spawn_error" }));
  const c = row(input({ stage: "setup", head_task_resolved: false, budget_present: false }));
  const bad = row(input({ verdict_lines: [] }), "withheld", "regressed");
  const sample = derive([a, a, b, c, bad, { step: "reviewer.regression_opened", regressed_reviewer_code_sha: "regressed" }]);
  assert.equal(sample.rows.length, 3);
  assert.deepEqual(sample.header.classes, ["posted", "refused", "withheld"]);
  assert.ok(sample.rows.every(r => r.reviewer_code_sha !== "regressed"));
  replayReviewSample(parseReviewReplaySample(serializeReviewReplaySample(sample)));
  assert.throws(() => derive([a, row(input(), "withheld")]), /conflicting/);
  const legacy = derive([{ ts: a.ts, run_id: "old", step: "review.reviewer.skipped",
    reason: "head-task-metadata-unavailable", missing: ["budget_usd"] }, {
    ts: a.ts, run_id: "old", step: "review.posted", pr_url: a.pr_url, head_sha: "head",
    reviewer_code_sha: "healthy", proof_exec: [{ status: "passed" }], plan_only: false,
  }]);
  assert.equal(legacy.rows[0]!.input.verdict_lines, "unrecorded");
  assert.equal(legacy.rows[0]!.input.budget_present, false);
  replayReviewSample(legacy);
});

// @source-text-subject: the declared wiring proof checks both production call sites, not policy behavior.
test("W1-T10270: production review decisions route through the replayed seam", () => {
  const source = readFileSync(new URL("../../src/run-task.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("async function runReview("), source.indexOf("async function reviewCommand("));
  const command = source.slice(source.indexOf("async function reviewCommand("));
  assert.match(run, /const replayDecision = classifyReviewOutcome\(replayInput\)/);
  assert.match(command, /const setupDecision = classifyReviewOutcome\(replaySetupInput\)/);
  assert.match(command, /if \(setupDecision.class === "refused"\) \{[\s\S]{0,700}?return 2/);
  assert.doesNotMatch(run, /requiredSemanticRefusal\(/);
  const files = new Map([
    ["src/lib/self-sync.ts", ""],
    ["src/run-task.ts", 'import "#test/review/lib/required-semantic-review.js";'],
    ["src/lib/required-semantic-review.ts", 'import "#test/review/nested.js";'],
    ["src/lib/nested.ts", ""],
    ["test/review/a-review-path-change-replays-recorded-reviews.test.ts", ""],
  ]);
  for (const path of ["src/lib/required-semantic-review.ts", "src/lib/nested.ts"]) {
    const selected = selectAffectedSuites([path], { files, pathReaders: [], symbolSuites: [] });
    assert.ok(selected.suites.includes("test/review/a-review-path-change-replays-recorded-reviews.test.ts"));
    assert.ok(selected.narrow!.includes("test/review/a-review-path-change-replays-recorded-reviews.test.ts"));
  }
});

test("W1-T10270: verdict recording drops prose and bounds duplicate tokens independently of parsing", () => {
  const lines = recordedReviewVerdictLines("secret\nREVIEW_VERDICT 1: PASS (secret)\nREVIEW_VERDICT 1: FAIL: secret\n" +
    "REVIEW_VERDICT 1: PASS\nREVIEW_VERDICT 2: PASS\nREVIEW_VERDICT 0: FAIL", 1);
  assert.deepEqual(lines, ["REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 1: FAIL"]);
  assert.equal(classifyReviewOutcome(input({ verdict_lines: lines })).class, "posted");
  assert.equal(classifyReviewOutcome(input({ verdict_lines: [] })).class, "withheld");
  assert.equal(classifyReviewOutcome(input({ plan_only: true, verdict_lines: [] })).class, "posted");
  assert.equal(classifyReviewOutcome(input({ stage: "setup", setup_unavailable: true })).class, "refused");
});

test("W1-T10270: refresh reads compressed, plain and live ledger rows and leaves the sample on refusal", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-replay-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ndjson = (r: Record<string, unknown>) => JSON.stringify(r) + "\n";
  writeFileSync(join(stateDir, "ledger.2026-10-17.ndjson.gz"), gzipSync(ndjson(row(input()))));
  writeFileSync(join(stateDir, "ledger.2026-10-18.ndjson"), ndjson(row(input({ reviewer_outcome: "spawn_error" }))));
  writeFileSync(join(stateDir, "ledger.ndjson"), ndjson(row(input({ stage: "setup", setup_unavailable: true }))));
  const sample = refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" });
  assert.equal(sample.rows.length, 3, "each ledger form contributes a distinct shape");
  assert.deepEqual(sample.header.classes, ["posted", "refused", "withheld"]);
  const before = readFileSync(join(root, REVIEW_REPLAY_SAMPLE_PATH), "utf8");
  replayReviewSample(parseReviewReplaySample(before));
  const deps = { stateDir, repoRoot: root, openWorkspace: () => { throw new Error("not opened by inventory"); }, log: () => {} };
  const spec = reviewReplayGardenSpec(deps, () => "test");
  assert.deepEqual(spec.candidates(spec.inventory(), () => 0), []);
  writeFileSync(join(root, REVIEW_REPLAY_SAMPLE_PATH), "stale");
  const actions = spec.candidates(spec.inventory(), () => 0);
  assert.equal(actions.length, 1);
  const result = spec.apply({ root, land: () => undefined, dispose: () => {} }, { acting: ["refresh"], actions }, {});
  assert.equal(result?.title, "chore(test): refresh recorded review inputs");
  assert.deepEqual(result?.paths, [REVIEW_REPLAY_SAMPLE_PATH]);
  assert.equal(readFileSync(join(root, REVIEW_REPLAY_SAMPLE_PATH), "utf8"), before);
  assert.equal(spec.apply({ root, land: () => undefined, dispose: () => {} }, { acting: ["refresh"], actions }, {}), undefined);
  writeFileSync(join(stateDir, "ledger.2026-10-17.ndjson.gz"), "damaged gzip");
  assert.throws(() => refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" }), /incomplete/);
  assert.equal(readFileSync(join(root, REVIEW_REPLAY_SAMPLE_PATH), "utf8"), before);
});

test("W1-T10270: a production setup refusal records the replay input before any review effect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-replay-command-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const effects: string[] = [];
  const code = await reviewCommand("1", ["--repo", "acme/remudero"], {
    resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
    fetchView: () => ({ head: { sha: "f".repeat(40), ref: "topic" }, number: 1, state: "open",
      html_url: "https://github.com/acme/remudero/pull/1", body: "Remudero-Task: W1-T999999" }),
    fetchHead: () => {},
    loadConfig: () => ({ root, installRoot: process.cwd() }) as Config,
    executionMode: "semantic",
    postReviewPending: async () => { effects.push("pending"); return { posted: true }; },
    materialize: () => { throw new Error("setup refusal must precede materialization"); },
    runReview: async () => { throw new Error("setup refusal must precede evaluation"); },
  } as never);
  assert.equal(code, 2);
  assert.deepEqual(effects, []);
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const replay = rows.filter(r => r.step === "review.replay_input");
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.recorded_class, "refused");
  assert.equal(typeof replay[0]!.reviewer_code_sha, "string");
  replayReviewSample(derive(replay));
});
