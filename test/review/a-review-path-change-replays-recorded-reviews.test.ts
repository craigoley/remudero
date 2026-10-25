import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { classifyReviewOutcome, recordedReviewVerdictLines, reviewReplayLedgerFields,
  type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, parseReviewReplaySample, replayReviewSample,
  refreshReviewReplaySample, REVIEW_REPLAY_SAMPLE_PATH, reviewReplayGardenSpec,
  serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";
import { selectAffectedSuites } from "#src/lib/affected-suites.js";
import { readConfigGardenLedgerRows } from "#src/lib/config-gardener.js";
import { evaluateReviewerHealthNow, loadReviewerHealthState, reviewerHealthStatePath,
  saveReviewerHealthState, resetLoadedReviewerCodeSha, loadedReviewerCodeSha } from "#src/lib/reviewer-health.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { reviewCommand, runReview } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import type { Config } from "#src/lib/config.js";

const samplePath = join(REPO_ROOT, "test/fixtures/review-replay/sample.ndjson");
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

async function seedReviewerHealth(stateDir: string, rows: Record<string, unknown>[]) {
  const logs: Record<string, unknown>[] = [];
  const unexpected = (): never => { throw new Error("seed must not perform an external effect"); };
  let tick = 0;
  await evaluateReviewerHealthNow({ originMainSha: null }, reviewerHealthStatePath(stateDir),
    async () => ({ rows, cursor: { liveOffset: 0 } }), async () => unexpected(),
    { ledgerPath: join(stateDir, "ledger.ndjson"), runId: "seed-test", issues: {
      create: async () => unexpected(), listOpen: async () => [], ensureLabel: async () => true,
      comment: async () => unexpected(), closeWithComment: async () => unexpected(),
    } }, { openFixPr: async () => unexpected(), openRevertPr: async () => unexpected() },
    (step, extra = {}) => logs.push({ step, ...extra }),
    { iso: () => new Date(Date.UTC(2026, 9, 21, 0, 0, tick++)).toISOString() });
  return logs;
}

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

test("W1-T10270: a malformed recorded input is refused instead of entering the sample", () => {
  const good = row(input());
  const malformed = (patch: Record<string, unknown>): Record<string, unknown> =>
    ({ ...good, input: { ...(good.input as Record<string, unknown>), ...patch } });
  for (const patch of [
    { verdict_lines: ["REVIEW_VERDICT 1: PASS — because the diff looks fine"] },
    { stage: "elsewhere" },
    { criteria_count: -1 },
    { budget_present: "yes" },
  ]) {
    assert.throws(() => derive([malformed(patch)]), /invalid review replay input/);
  }
  assert.equal(derive([good]).rows.length, 1);
  // The checked-in-file route reaches the same refusal: a hand-edited input is refused before the digest check.
  const text = serializeReviewReplaySample(derive([good]));
  assert.ok(text.includes('"stage":"semantic"'));
  assert.throws(() => parseReviewReplaySample(text.replace('"stage":"semantic"', '"stage":"elsewhere"')),
    /invalid review replay input/);
  assert.throws(() => parseReviewReplaySample(text.replace('"criteria_count":1', '"criteria_count":1.5')),
    /invalid review replay input/);
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
  const source = readFileSync(join(REPO_ROOT, "src/cli/commands/review.ts"), "utf8");
  const run = source.slice(source.indexOf("async function runReview("), source.indexOf("async function reviewCommand("));
  const command = source.slice(source.indexOf("async function reviewCommand("));
  assert.match(run, /const replayDecision = classifyReviewOutcome\(replayInput\)/);
  assert.match(command, /const setupDecision = classifyReviewOutcome\(replaySetupInput\)/);
  assert.match(command, /if \(setupDecision.class === "refused"\) \{[\s\S]{0,700}?return 2/);
  assert.doesNotMatch(run, /requiredSemanticRefusal\(/);
  const relative = (...segments: string[]): string => segments.join("/");
  const files = new Map([
    ["src/lib/self-sync.ts", ""],
    ["src/run-task.ts", `import "${relative(".", "lib", "required-semantic-review.js")}";`],
    ["src/lib/required-semantic-review.ts", `import "${relative(".", "nested.js")}";`],
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

test("W1-T10270: refresh reads compressed, plain and live ledger rows and leaves the sample on refusal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-replay-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ndjson = (r: Record<string, unknown>) => JSON.stringify(r) + "\n";
  writeFileSync(join(stateDir, "ledger.2026-10-17.ndjson.gz"), gzipSync(ndjson(row(input()))));
  writeFileSync(join(stateDir, "ledger.2026-10-18.ndjson"), ndjson(row(input({ reviewer_outcome: "spawn_error" }))));
  writeFileSync(join(stateDir, "ledger.ndjson"), ndjson(row(input({ stage: "setup", setup_unavailable: true }))));
  await seedReviewerHealth(stateDir, []);
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


test("W1-T10270: the real config-garden union reader retains a replay row's PR identity", () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-replay-reader-`));
  try {
    const recorded = { ...row(input()), ts: new Date().toISOString(), run_id: "replay-reader", task_id: "W1-T10270" };
    const unrelated = { ts: recorded.ts, step: "unrelated.telemetry", run_id: "noise" };
    writeFileSync(join(stateDir, "ledger.ndjson"), [recorded, unrelated].map(r => JSON.stringify(r)).join("\n") + "\n");
    assert.deepEqual(readConfigGardenLedgerRows(stateDir), [recorded]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});


test("W1-T10270: seed-carried closed regressions and their silent extensions never enter a refreshed sample", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-replay-carried-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const bad = "b".repeat(40), extension = "c".repeat(40), healthy = "d".repeat(40);
  const healthRows: Record<string, unknown>[] = [];
  let pr = 1;
  const outcome = (sha: string, failure: boolean): Record<string, unknown> => ({
    ts: "2026-10-20T00:00:00.000Z", host: "fixture", step: failure ? "review.semantic_incomplete" : "review.posted",
    reviewer_code_sha: sha, pr_url: `https://github.com/acme/remudero/pull/${pr++}`, head_sha: "e".repeat(40),
    plan_only: false, reviewer_outcome: "success", reason: failure ? "required-semantic-incomplete-verdicts" : undefined,
  });
  for (let sha = 1; sha <= 20; sha++) for (let unit = 0; unit < 5; unit++) {
    healthRows.push(outcome(sha.toString(16).padStart(40, "0"), false));
  }
  for (const sha of [bad, extension]) for (let unit = 0; unit < 6; unit++) healthRows.push(outcome(sha, true));
  const emitted = await seedReviewerHealth(stateDir, healthRows);
  assert.equal(emitted.filter(r => r.step === "reviewer.regression_carried").length, 1);
  assert.equal(emitted.filter(r => r.step === "reviewer.regression_opened" || r.step === "reviewer.regression_extended").length, 0);
  const state = loadReviewerHealthState(reviewerHealthStatePath(stateDir));
  assert.equal(state.incident, null);
  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0]!.regressedSha, bad);
  assert.ok(state.shas[bad]!.regressedAt);
  assert.ok(state.shas[extension]!.regressedAt, "seed marks the later judging code without an extended event");
  const inputs = [row(input(), "posted", healthy), row(input({ reviewer_outcome: "error" }), "withheld", bad),
    row(input({ stage: "setup", setup_unavailable: true }), "refused", extension)];
  const ndjson = (rows: Record<string, unknown>[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(stateDir, "ledger.2026-10-20.ndjson.gz"), gzipSync(ndjson(healthRows)));
  writeFileSync(join(stateDir, "ledger.2026-10-21.ndjson"), ndjson(emitted));
  writeFileSync(join(stateDir, "ledger.ndjson"), ndjson(inputs));
  assert.equal(derive([...healthRows, ...emitted, ...inputs]).rows.length, 3, "ledger-only derivation cannot see seed marks");
  const refreshed = refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" });
  assert.deepEqual(refreshed.rows.map(r => r.reviewer_code_sha), [healthy]);
  replayReviewSample(refreshed);
  const spec = reviewReplayGardenSpec({ stateDir, repoRoot: root,
    openWorkspace: () => { throw new Error("not opened by inventory"); }, log: () => {} }, () => "test");
  assert.deepEqual(parseReviewReplaySample(spec.inventory()).rows.map(r => r.reviewer_code_sha), [healthy]);
  // The closed incident retains the onset even after its tracked per-sha record is pooled away.
  delete state.shas[bad];
  saveReviewerHealthState(reviewerHealthStatePath(stateDir), state);
  assert.deepEqual(refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" }).rows.map(r => r.reviewer_code_sha), [healthy]);
  state.incident = state.closed[0]!;
  state.closed = [];
  saveReviewerHealthState(reviewerHealthStatePath(stateDir), state);
  assert.deepEqual(parseReviewReplaySample(spec.inventory()).rows.map(r => r.reviewer_code_sha), [healthy], "active onset also survives a missing tracked record");
});

test("W1-T10270: an unavailable health projection refuses refresh and inventory while a seeded healthy projection permits them", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-replay-health-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "ledger.2026-10-20.ndjson.gz"), gzipSync(""));
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify(row(input())) + "\n");
  const target = join(root, REVIEW_REPLAY_SAMPLE_PATH);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "previous sample bytes\n");
  const statePath = reviewerHealthStatePath(stateDir);
  const spec = reviewReplayGardenSpec({ stateDir, repoRoot: root,
    openWorkspace: () => { throw new Error("not opened by inventory"); }, log: () => {} }, () => "test");
  const refuses = (): void => {
    assert.throws(() => refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" }), /review replay refuses/);
    assert.throws(() => spec.inventory(), /review replay refuses/);
    assert.equal(readFileSync(target, "utf8"), "previous sample bytes\n");
  };
  refuses(); // Genuine absence is not an authoritative clean judgment.
  for (const text of ["{torn", '{"version":"older"}', '{"version":"reviewer-health-v1","cursor":null}']) {
    writeFileSync(statePath, text);
    refuses();
  }
  rmSync(statePath);
  await seedReviewerHealth(stateDir, []);
  const seeded = readFileSync(statePath, "utf8");
  const state = loadReviewerHealthState(statePath);
  assert.notEqual(state.cursor, null);
  assert.notEqual(state.seededAt, null);
  assert.deepEqual(state.shas, {});
  for (const corrupt of [{ ...state, cursor: undefined }, { ...state, cursor: { liveOffset: -1 } },
    { ...state, seededAt: "invalid" }, { ...state, shas: null }, { ...state, closed: [null] },
    { ...state, incident: { regressedSha: null } },
    { ...state, shas: { bad: { sha: "bad", regressedAt: null } } },
    { ...state, shas: { bad: null } }]) {
    writeFileSync(statePath, JSON.stringify(corrupt));
    refuses();
  }
  rmSync(statePath);
  mkdirSync(statePath); // The normative reader also treats a directory as no file.
  refuses();
  rmSync(statePath, { recursive: true });
  symlinkSync(statePath, statePath); // A real default read error, independent of filesystem permissions.
  assert.throws(() => refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" }), { code: "ELOOP" });
  assert.throws(() => spec.inventory(), { code: "ELOOP" });
  assert.equal(readFileSync(target, "utf8"), "previous sample bytes\n");
  rmSync(statePath);
  writeFileSync(statePath, seeded);
  assert.equal(refreshReviewReplaySample({ stateDir, root, generatorRevision: "test" }).rows.length, 1);
  assert.equal(parseReviewReplaySample(spec.inventory()).rows.length, 1);
});

async function reviewWithReplayProvenance(legacy: string | null, identified: boolean) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}replay-code-provenance-`));
  const head = "e".repeat(40), codeSha = "a".repeat(40), nextSha = "b".repeat(40);
  const diff = ["diff --git a/plan/tasks.yaml b/plan/tasks.yaml", "--- a/plan/tasks.yaml", "+++ b/plan/tasks.yaml",
    "@@ -1,2 +1,2 @@", " - id: W1-T10270", "-  title: previous", "+  title: revised"].join("\n");
  const shim = ghShim([
    { when: "pr diff", stdout: diff },
    { when: "headRefOid", stdout: JSON.stringify({ headRefOid: head }) },
    { when: "state", stdout: '{"state":"OPEN"}' },
    { when: "pulls/", stdout: JSON.stringify({ number: 1, state: "open", html_url: "https://github.com/acme/consumer/pull/1",
      body: "recorded reviewer identity", head: { ref: "topic", sha: head } }) },
    { when: "", stderr: "fixture refuses unexpected GitHub access", exit: 87 },
  ], { kind: "replay-code-provenance" });
  const priorPath = process.env.PATH;
  const rows: Record<string, unknown>[] = [];
  let freshnessReads = 0, arms = 0;
  try {
    resetLoadedReviewerCodeSha();
    assert.equal(loadedReviewerCodeSha(() => { if (legacy === null) throw new Error("bundle has no checkout"); return legacy; }), legacy);
    process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
    await runReview({ owner: "acme", repo: "consumer", prUrl: "https://github.com/acme/consumer/pull/1",
      task: { id: "W1-T10270", acceptance: [{ claim: "recorded reviewer identity", proof: "recorded reviewer identity" }] },
      report: "recorded reviewer identity", settingsFile: join(root, "settings.json"), config: { root } as Config,
      log: (step, extra) => rows.push({ ts: "2026-10-25T13:04:41.366Z", run_id: "fixture-review", step, ...extra }),
      say: () => {}, account: result => result, spawnReviewer: false, headCheckoutDir: REPO_ROOT,
      lintPlanForReviewFn: async () => ({ ran: true, label: "fixture", checked: 1, violations: [] }),
      ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture-review",
      reviewerCodeFreshness: () => {
        freshnessReads++;
        return identified ? { status: "stale", codeSha, originMainSha: nextSha, changedPaths: ["src/cli/commands/review.ts"] }
          : { status: "unreadable", reason: "fixture cannot establish reviewer provenance" };
      },
      arm: () => { arms++; return "skipped"; }, disarm: () => {},
    });
    return { rows, freshnessReads, arms, codeSha, head, publication: readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    resetLoadedReviewerCodeSha();
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
}

test("computed review replay uses the verified reviewer identity when checkout attribution is absent or different", async () => {
  for (const legacy of [null, "c".repeat(40)]) {
    const f = await reviewWithReplayProvenance(legacy, true);
    assert.equal(f.freshnessReads, 1, "the real publication boundary must assess reviewer provenance");
    const recorded = f.rows.filter(r => r.step === "review.replay_input");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.recorded_class, "withheld", "stale code still cannot publish");
    assert.ok(f.publication.some(r => r.step === "review.post_refused" && r.reviewer_code_freshness === "stale"));
    assert.equal(recorded[0]!.reviewer_code_sha, f.codeSha, "record the same code identity the publication guard assessed");
    assert.notEqual(recorded[0]!.reviewer_code_sha, f.head, "the consumer's PR head is not reviewer code");
    assert.equal(f.arms, 0);
    replayReviewSample(derive(recorded));
  }
});

test("unavailable reviewer provenance remains unknown and cannot enter a replay sample", async () => {
  const f = await reviewWithReplayProvenance(null, false);
  assert.equal(f.freshnessReads, 1);
  const recorded = f.rows.filter(r => r.step === "review.replay_input");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.recorded_class, "withheld");
  assert.ok(f.publication.some(r => r.step === "review.post_refused" && r.reviewer_code_freshness === "unreadable"));
  assert.equal(recorded[0]!.reviewer_code_sha, null);
  assert.equal(f.arms, 0);
  assert.throws(() => derive(recorded), /invalid review replay row field: reviewer_code_sha/);
});
