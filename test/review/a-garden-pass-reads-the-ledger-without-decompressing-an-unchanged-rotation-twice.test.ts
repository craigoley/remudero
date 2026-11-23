import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readLedgerUnionRecordsSync, realLedgerFs } from "#src/lib/ledger-union.js";
import { classifyReviewOutcome, reviewReplayLedgerFields, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { reviewReplayGardenSpec } from "#src/lib/review-replay-sample.js";
import { emptyReviewerHealthState, reviewerHealthStatePath, saveReviewerHealthState } from "#src/lib/reviewer-health.js";
import { GARDENER_ORIGIN_ENV, gardenerOriginEnv } from "#src/lib/worker-containment.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function reviewLine(day: number, outcome = "success"): string {
  const input: ReviewReplayInput = { stage: "semantic", plan_only: false, required_semantic: true, criteria_count: 1,
    risk_present: true, budget_present: true, untasked: false, head_task_resolved: true, own_task_record_missing: false,
    reviewer_outcome: outcome, verdict_lines: ["REVIEW_VERDICT 1: PASS"] };
  return JSON.stringify({ ts: `2026-11-${day}T12:00:00.000Z`, step: "review.replay_input",
    ...reviewReplayLedgerFields(input, classifyReviewOutcome(input), { pr_url: `https://github.com/acme/remudero/pull/${day}`,
      head_sha: "e".repeat(40), reviewer_code_sha: "f".repeat(40) }) }) + "\n";
}

function fixture(t: Parameters<typeof ownedFixtureDir>[0]) {
  const { dir } = ownedFixtureDir(t, "review-replay-union");
  const archive = join(dir, "ledger.2026-11-18.ndjson.gz");
  const plain = join(dir, "ledger.2026-11-19.ndjson");
  const live = join(dir, "ledger.ndjson");
  const archivedLine = reviewLine(18);
  const liveLine = reviewLine(19, "spawn_error");
  writeFileSync(archive, gzipSync(archivedLine));
  writeFileSync(live, archivedLine + liveLine);
  saveReviewerHealthState(reviewerHealthStatePath(dir), { ...emptyReviewerHealthState(),
    cursor: { liveOffset: 0 }, seededAt: "2026-11-20T00:00:00.000Z" });
  const rows: Record<string, unknown>[] = [];
  const opened: string[] = [];
  let gunzips = 0;
  let bytesRead = 0;
  const ledgerFs = { ...realLedgerFs,
    readFileSync(path: string) {
      if (path.endsWith(".ndjson.gz")) opened.push(path);
      const bytes = realLedgerFs.readFileSync(path);
      bytesRead += bytes.length;
      return bytes;
    },
    readRangeSync(path: string, start: number, end: number) {
      const bytes = realLedgerFs.readRangeSync(path, start, end);
      bytesRead += bytes.length;
      return bytes;
    },
    gunzipSync(buffer: Buffer) {
      gunzips++;
      return realLedgerFs.gunzipSync(buffer);
    },
  };
  const deps = { stateDir: dir, repoRoot: dir,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    openWorkspace: (): never => { throw new Error("inventory must not open a workspace"); } };
  const pass = () => reviewReplayGardenSpec(deps, () => "test", { ledgerFs });
  const base = reviewReplayGardenSpec(deps, () => "test", { readLedger: readLedgerUnionRecordsSync });
  return { archive, plain, live, liveLine, dir, rows, opened, gunzips: () => gunzips, bytesRead: () => bytesRead, pass, base };
}

test("W1-T13973 criterion 1: a fresh review-replay reader opens only a new rotation", (t) => {
  const f = fixture(t);
  const cold = f.pass().inventory();
  assert.deepEqual(f.opened, [f.archive]);
  assert.equal(f.gunzips(), 1);
  assert.equal(f.pass().inventory(), cold);
  assert.deepEqual(f.opened, [f.archive]);
  assert.equal(f.gunzips(), 1);

  const added = join(f.dir, "ledger.2026-11-20.ndjson.gz");
  writeFileSync(added, gzipSync(reviewLine(20)));
  assert.equal(f.pass().inventory(), f.base.inventory());
  assert.deepEqual(f.opened, [f.archive, added]);
  assert.equal(f.gunzips(), 2);
});

test("W1-T13973 criterion 3: the review-replay child reports bytes and parsed rotations for its pass", (t) => {
  const f = fixture(t);
  writeFileSync(f.plain, f.liveLine);
  const passId = "d570a7e9-8a24-4a9e-9582-ed61f6a7a93f";
  const prior = process.env[GARDENER_ORIGIN_ENV];
  t.after(() => {
    if (prior === undefined) delete process.env[GARDENER_ORIGIN_ENV];
    else process.env[GARDENER_ORIGIN_ENV] = prior;
  });
  process.env[GARDENER_ORIGIN_ENV] = gardenerOriginEnv("review-replay", passId);
  f.pass().inventory();
  const coldBytes = f.bytesRead();
  f.pass().inventory();
  const warmBytes = f.bytesRead() - coldBytes;
  assert.ok(coldBytes > 0 && warmBytes > 0);
  assert.deepEqual(f.rows, [
    { step: "garden.lifecycle", name: "review-replay", passId, phase: "ledger-read",
      ledger_bytes_read: coldBytes, ledger_rotations_parsed: 2 },
    { step: "garden.lifecycle", name: "review-replay", passId, phase: "ledger-read",
      ledger_bytes_read: warmBytes, ledger_rotations_parsed: 0 },
  ]);
});

test("W1-T13973 criterion 4: cached review replay preserves the whole union's output and refusals", (t) => {
  const f = fixture(t);
  const cold = f.pass();
  const warm = f.pass();
  cold.inventory();
  const expected = f.base.inventory();
  const inventory = warm.inventory();
  assert.equal(inventory, expected);
  assert.equal(warm.fingerprint(inventory), f.base.fingerprint(expected));
  const actions = warm.candidates(inventory, () => 0);
  const baseActions = f.base.candidates(expected, () => 0);
  assert.deepEqual(actions, baseActions);
  assert.equal(actions.length, 1);
  const apply = (spec: typeof warm, candidates: typeof actions, directory: string) => {
    const root = join(f.dir, directory);
    mkdirSync(root);
    const filing = spec.apply({ root, land: () => undefined, dispose: () => {} },
      { acting: ["refresh"], actions: candidates }, {});
    assert.ok(filing);
    return { filing, content: readFileSync(join(root, filing.paths[0]!), "utf8") };
  };
  assert.deepEqual(apply(warm, actions, "warm-workspace"), apply(f.base, baseActions, "base-workspace"));
  assert.equal(f.gunzips(), 1);

  writeFileSync(f.live, f.liveLine + "{broken}\n");
  for (const spec of [f.pass(), f.base]) assert.throws(() => spec.inventory(), /incomplete ledger union/);

  writeFileSync(f.live, f.liveLine);
  writeFileSync(f.archive, gzipSync("{broken}\n"));
  for (const spec of [f.pass(), f.pass(), f.base]) assert.throws(() => spec.inventory(), /incomplete ledger union/);

  writeFileSync(f.archive, "damaged gzip");
  for (const spec of [f.pass(), f.base]) assert.throws(() => spec.inventory(), /incomplete ledger union/);

  unlinkSync(f.archive);
  for (const spec of [f.pass(), f.base]) assert.throws(() => spec.inventory(), /incomplete ledger union/);
});
