import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { GARDEN_LEDGER_BUCKET_MS, gardenPassDue, gardenStatePath, runGarden, type GardenerDeps } from "#src/lib/gardener.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { classifyReviewOutcome, reviewReplayLedgerFields, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { refreshReviewReplaySample, REVIEW_REPLAY_SAMPLE_PATH, reviewReplayGardenSpec } from "#src/lib/review-replay-sample.js";
import { evaluateReviewerHealthNow, reviewerHealthStatePath } from "#src/lib/reviewer-health.js";
import { withTempDir } from "#src/lib/tmp.js";

const input = (extra: Partial<ReviewReplayInput> = {}): ReviewReplayInput => ({ stage: "semantic", plan_only: false,
  required_semantic: true, criteria_count: 1, risk_present: true, budget_present: true, untasked: false,
  head_task_resolved: true, own_task_record_missing: false, reviewer_outcome: "success",
  verdict_lines: ["REVIEW_VERDICT 1: PASS"], ...extra });
const line = (i: ReviewReplayInput, ts: string): string => JSON.stringify({ ts, step: "review.replay_input",
  ...reviewReplayLedgerFields(i, classifyReviewOutcome(i), { pr_url: "https://github.com/acme/remudero/pull/1",
    head_sha: "e".repeat(40), reviewer_code_sha: "f".repeat(40) }) }) + "\n";

async function seedReviewerHealth(stateDir: string): Promise<void> {
  const unexpected = (): never => { throw new Error("seed must not perform an external effect"); };
  await evaluateReviewerHealthNow({ originMainSha: null }, reviewerHealthStatePath(stateDir),
    async () => ({ rows: [], cursor: { liveOffset: 0 } }), async () => unexpected(),
    { ledgerPath: join(stateDir, "ledger.ndjson"), runId: "seed-test", issues: {
      create: async () => unexpected(), listOpen: async () => [], ensureLabel: async () => true,
      comment: async () => unexpected(), closeWithComment: async () => unexpected(),
    } }, { openFixPr: async () => unexpected(), openRevertPr: async () => unexpected() },
    () => {}, { iso: () => "2026-10-21T00:00:00.000Z" });
}

type Fixture = { stateDir: string; root: string; deps: GardenerDeps; advance: (ms: number) => void; landed: string[];
  reads: () => number; readLedger: typeof readLedgerUnionRecordsSync };

async function fixture(dir: string): Promise<Fixture> {
  const stateDir = join(dir, "state"), root = join(dir, "repo"), ws = join(dir, "ws");
  for (const d of [stateDir, root, ws]) mkdirSync(d, { recursive: true });
  writeFileSync(join(stateDir, "ledger.2026-10-17.ndjson.gz"), gzipSync(line(input(), "2026-10-17T12:00:00.000Z")));
  writeFileSync(join(stateDir, "ledger.ndjson"), line(input({ reviewer_outcome: "spawn_error" }), "2026-10-18T12:00:00.000Z"));
  await seedReviewerHealth(stateDir);
  let nowMs = Date.parse("2026-11-16T13:05:00Z");
  let reads = 0;
  const landed: string[] = [];
  const deps: GardenerDeps = { stateDir, repoRoot: root, clock: clockFromMillisFn(() => nowMs), seed: 1, log: () => {},
    mergedPlanLint: () => undefined,
    openWorkspace: () => ({ root: ws, dispose: () => {},
      land: (opts) => { landed.push(readFileSync(join(ws, opts.paths[0]!), "utf8")); return "https://github.com/acme/remudero/pull/9"; } }) };
  return { stateDir, root, deps, landed, advance: (ms) => { nowMs += ms; }, reads: () => reads,
    readLedger: (...args) => { reads++; return readLedgerUnionRecordsSync(...args); } };
}

test("W1-T13155 criterion 1: the review-replay due check reads no ledger rows and holds while the ledger grows", async () => {
  await withTempDir("review-replay-due", async (dir) => {
    const f = await fixture(dir);
    const spec = reviewReplayGardenSpec(f.deps, () => "rev-a", { readLedger: f.readLedger });
    const first = spec.cheapFingerprint();
    assert.equal(gardenPassDue(spec, f.deps), true, "a garden with no recorded pass is due");
    assert.equal(f.reads(), 0, "the due check read the ledger union on the daemon loop");
    appendFileSync(join(f.stateDir, "ledger.ndjson"), line(input({ criteria_count: 2,
      verdict_lines: ["REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: PASS"] }), "2026-11-16T13:06:00.000Z"));
    f.advance(GARDEN_LEDGER_BUCKET_MS / 2);
    assert.equal(spec.cheapFingerprint(), first, "inside one hour bucket the due check holds while the ledger grows");
    gardenPassDue(spec, f.deps);
    assert.equal(f.reads(), 0);
  });
});

test("W1-T13155 criterion 2: the fingerprint moves with the hour and the revision, and a moved pass writes the refreshed sample", async () => {
  await withTempDir("review-replay-moved", async (dir) => {
    const f = await fixture(dir);
    let revision = "rev-a";
    const spec = reviewReplayGardenSpec(f.deps, () => revision, { readLedger: f.readLedger });
    refreshReviewReplaySample({ stateDir: f.stateDir, root: f.root, generatorRevision: revision });
    assert.equal(runGarden(spec, f.deps).ran, true);
    assert.deepEqual(f.landed, [], "the committed sample already matches the ledger");
    const first = spec.cheapFingerprint();
    assert.equal(gardenPassDue(spec, f.deps), false, "a recorded pass is not due again in the same hour");
    revision = "rev-b";
    assert.notEqual(spec.cheapFingerprint(), first, "a new generator revision makes the pass due");
    revision = "rev-a";
    f.advance(GARDEN_LEDGER_BUCKET_MS);
    const moved = spec.cheapFingerprint();
    assert.notEqual(moved, first, "a new hour bucket makes the pass due");
    assert.equal(gardenPassDue(spec, f.deps), true);
    appendFileSync(join(f.stateDir, "ledger.ndjson"), line(input({ stage: "setup", setup_unavailable: true }), "2026-11-16T14:00:00.000Z"));
    runGarden(spec, f.deps);
    const expected = join(dir, "expected");
    refreshReviewReplaySample({ stateDir: f.stateDir, root: expected, generatorRevision: revision });
    assert.equal(f.landed.length, 1, "the moved pass refreshed the sample");
    assert.equal(f.landed[0], readFileSync(join(expected, REVIEW_REPLAY_SAMPLE_PATH), "utf8"));
  });
});

test("W1-T13155 criterion 3: gardenPassDue on the review-replay spec reads and gunzips no ledger file", async () => {
  await withTempDir("review-replay-unreadable", async (dir) => {
    const stateDir = join(dir, "state");
    mkdirSync(join(stateDir, "ledger.ndjson"), { recursive: true });
    writeFileSync(join(stateDir, "ledger.2026-10-17.ndjson.gz"), "damaged gzip");
    const deps: GardenerDeps = { stateDir, repoRoot: dir, clock: clockFromMillisFn(() => Date.parse("2026-11-16T13:05:00Z")),
      log: () => {}, openWorkspace: () => { throw new Error("the due check never opens a workspace"); } };
    const spec = reviewReplayGardenSpec(deps, () => "rev-a");
    assert.throws(() => spec.inventory(), /review replay refuses/, "any read of this ledger union refuses");
    assert.equal(gardenPassDue(spec, deps), true, "the due check answers without reading the live ledger or any archive");
    assert.equal(spec.cheapFingerprint(), `rev-a:${Math.floor(Date.parse("2026-11-16T13:05:00Z") / GARDEN_LEDGER_BUCKET_MS)}`,
      "the due check reads only the clock and the generator revision");
    assert.equal(existsSync(gardenStatePath(stateDir, spec.name)), false, "the due check writes nothing");
  });
});

test("W1-T13155 criterion 4: one review-replay pass that reads its inventory reads the ledger union once", async () => {
  await withTempDir("review-replay-once", async (dir) => {
    const f = await fixture(dir);
    const spec = reviewReplayGardenSpec(f.deps, () => "rev-a", { readLedger: f.readLedger });
    runGarden(spec, f.deps);
    assert.equal(f.reads(), 1, "the first pass reads the union for its inventory only");
    runGarden(spec, f.deps);
    assert.equal(f.reads(), 1, "a pass in the same hour bucket reads no union");
    f.advance(GARDEN_LEDGER_BUCKET_MS);
    runGarden(spec, f.deps);
    assert.equal(f.reads(), 2, "a pass on a moved fingerprint reads the union once more");
  });
});
