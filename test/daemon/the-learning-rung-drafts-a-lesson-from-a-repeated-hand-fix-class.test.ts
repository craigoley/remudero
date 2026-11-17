// W1-T12837: the scheduled learning rung drafts a lesson from each repeated hand-fix class, and the draft
// waits for the operator. One test per acceptance criterion; each title names its criterion.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ciLearningCadenceCheck,
  ciLearningRecordVerdict,
  ciLearningShardYaml,
  CI_LEARNING_MINT_CEILING,
  fileCiLearningShards,
  handFixClassKey,
  mintCiLearningShards,
  recordCiLearningCadenceFire,
  type HandFixInput,
} from "#src/lib/measurement-cadence.js";
import type { CiFailureCorpus, CiFailurePair } from "#src/lib/ci-failure-corpus.js";
import { interventionLedgerLine, type OperatorInterventionRow } from "#src/lib/operator-interventions.js";
import { appendLedger } from "#src/lib/ledger.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "#src/lib/clock.js";
import { buildCiLearningCadenceRunner } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const row = (pr: number, daysAgo: number, cause: string, files: string[], commit = `c${pr}`): OperatorInterventionRow => ({
  at: day(daysAgo),
  surface: "pr",
  action: "push",
  target: `pr#${pr}`,
  actor: "operator_craig",
  cause_class: cause,
  source: "test",
  evidence: { commit, files, files_total: files.length },
});

const CAUSE = "ci-gate:owner:lint-failed";
const emptyCorpus: CiFailureCorpus = { status: "populated", prsScanned: 0, unreadableShas: [], fullyObservedGatePrs: [], pairs: [] };
const pair = (pr: number, gate: string): CiFailurePair => ({ redSha: `r${pr}`, greenSha: `g${pr}`, pr, gate, state: "repaired", repairFiles: ["src/x.ts"] });
const input = (rows: OperatorInterventionRow[], retiredOrigins?: string[]): HandFixInput => ({ rows, now: NOW, ...(retiredOrigins ? { retiredOrigins } : {}) });

test("W1-T12837 criterion 1: a hand-fix class seen twice in 14 days drafts one shard citing each PR and hand commit", () => {
  const rows = [
    row(101, 2, CAUSE, ["src/lib/a.ts", "src/lib/b.ts"]),
    row(102, 5, CAUSE, ["src/lib/a.ts"]),
    row(103, 6, "other-cause", ["src/lib/z.ts"]), // a class seen once is not a pattern
    row(104, 20, CAUSE, ["src/lib/a.ts"]), // outside the 14-day window
  ];
  const r = mintCiLearningShards(emptyCorpus, [], input(rows));
  assert.equal(r.drafts.length, 1);
  const d = r.drafts[0]!;
  assert.equal(d.findingId, `ci-learning:hand-fix:${handFixClassKey(CAUSE, "src/lib/a.ts")}#2`);
  assert.deepEqual(d.prs, [101, 102]);
  assert.equal(r.status, "backlog");

  const yaml = ciLearningShardYaml(d, "W1-T99999");
  assert.match(yaml, /#101 \(c101\)/);
  assert.match(yaml, /#102 \(c102\)/);
  assert.match(yaml, /left ci-gate:owner:lint-failed failing/);
  assert.match(yaml, /files:\n {4}- learnings\/ci\.d\/ci-learning-hand-fix-/);
  assert.match(yaml, /src\/lib\/a\.ts, src\/lib\/b\.ts/);
  assert.equal(ciLearningRecordVerdict(yaml, "hand-fix:test").ok, true, "the lint accepts the rendered record");
});

test("W1-T12837 criterion 1: the scheduled rung reads operator.intervention rows and drafts the repeated class", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-fix-scheduled-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  appendLedger(join(stateDir, LEDGER_FILENAME), interventionLedgerLine(row(111, 2, CAUSE, ["src/lib/a.ts"])));
  appendLedger(join(stateDir, LEDGER_FILENAME), interventionLedgerLine(row(112, 5, CAUSE, ["src/lib/a.ts"])));

  const drafted: Array<{ findingId: string; prs: number[] }> = [];
  const run = buildCiLearningCadenceRunner({
    root,
    checkoutRoot: REPO_ROOT,
    loadWindow: () => ({ prs: [] }) as never,
    fileShards: ((drafts: Array<{ findingId: string; prs: number[] }>) => {
      drafted.push(...drafts);
      return { filed: [], skipped: [], refused: [] };
    }) as never,
    planOrigins: [],
    pendingOrigins: () => [],
    mergedOrigins: () => [],
    loadLessons: () => ({ status: "unreadable" }) as never,
    recordAttempt: () => {},
    recordFire: () => {},
    clock: fixedClock(NOW.getTime()),
  });

  const result = await run();
  assert.equal(result.draftCount, 1, "the scheduled path must mine its own intervention ledger input");
  assert.equal(drafted[0]!.findingId, `ci-learning:hand-fix:${handFixClassKey(CAUSE, "src/lib/a.ts")}#2`);
  assert.deepEqual(drafted[0]!.prs, [111, 112]);
});

test("W1-T12837 criterion 2: the hand-fix draft is machine-authored, verify human, and writes nothing a worker prompt selects", () => {
  const rows = [row(201, 1, CAUSE, ["src/lib/a.ts"]), row(202, 2, CAUSE, ["src/lib/a.ts"])];
  const { drafts } = mintCiLearningShards(emptyCorpus, [], input(rows));
  assert.equal(drafts[0]!.author_class, "machine");
  assert.equal(drafts[0]!.verify, "human");

  const written: string[] = [];
  const result = fileCiLearningShards(drafts, "/wt", {
    mintTaskId: () => "W1-T99998",
    planOrigins: [],
    fs: { mkdirSync: () => undefined, writeFileSync: (p, data) => { written.push(p); const t = loadPlanFromYaml(data, p).tasks[0]!; assert.equal(t.verify, "human"); assert.equal(t.author_class, "machine"); } },
    join: (...parts) => parts.join("/"),
  });
  assert.equal(result.filed.length, 1);
  assert.deepEqual(result.refused, []);
  // The draft is a plan record; learnings/ is written only by the merged remedy, so a worker's selection sees nothing.
  assert.equal(written.length, 1);
  assert.match(written[0]!, /^\/wt\/plan\/tasks\.d\/W1-T99998-/);
  assert.equal(written.some((p) => p.includes("/learnings/")), false);
});

test("W1-T12837 criterion 3: an open draft, a merged lesson or a retired draft is not drafted again unless the retired count doubled", () => {
  const key = handFixClassKey(CAUSE, "src/lib/a.ts");
  const two = [row(301, 1, CAUSE, ["src/lib/a.ts"]), row(302, 2, CAUSE, ["src/lib/a.ts"])];
  const four = [...two, row(303, 3, CAUSE, ["src/lib/a.ts"]), row(304, 4, CAUSE, ["src/lib/a.ts"])];
  const origin = `ci-learning:hand-fix:${key}#2`;

  // Open draft or merged lesson: both are a held origin, at any count.
  assert.equal(mintCiLearningShards(emptyCorpus, [origin], input(four)).drafts.length, 0, "held origin");
  // Retired at count 2: two rows stay silent, four rows are drafted once more.
  assert.equal(mintCiLearningShards(emptyCorpus, [origin], input(two, [origin])).drafts.length, 0, "retired, not doubled");
  const redraft = mintCiLearningShards(emptyCorpus, [origin], input(four, [origin]));
  assert.equal(redraft.drafts.length, 1, "retired, doubled");
  assert.equal(redraft.drafts[0]!.findingId, `ci-learning:hand-fix:${key}#4`);
  // The redraft is itself an open draft, so it is not drafted a third time.
  assert.equal(mintCiLearningShards(emptyCorpus, [origin, `ci-learning:hand-fix:${key}#4`], input(four, [origin])).drafts.length, 0, "redraft held");
  // A different class is unaffected by another class's origin.
  assert.equal(mintCiLearningShards(emptyCorpus, [`ci-learning:hand-fix:${handFixClassKey(CAUSE, "src/lib/other.ts")}#2`], input(two)).drafts.length, 1);
});

test("W1-T12837 criterion 4: hand-fix drafts share the rung's ceiling and interval, and a day with none drafts nothing", () => {
  // The ceiling is shared: CI clusters and hand-fix classes together never exceed it; the rest are named.
  const rows: OperatorInterventionRow[] = [];
  for (let c = 0; c < CI_LEARNING_MINT_CEILING + 1; c++) {
    rows.push(row(400 + c * 2, 1, `cause-${c}`, [`src/lib/f${c}.ts`]), row(401 + c * 2, 2, `cause-${c}`, [`src/lib/f${c}.ts`]));
  }
  const full = mintCiLearningShards({ ...emptyCorpus, pairs: [pair(1, "gate-a"), pair(2, "gate-a"), pair(3, "gate-a")] }, [], input(rows));
  assert.equal(full.drafts.length, CI_LEARNING_MINT_CEILING);
  assert.equal(full.drafts[0]!.gate, "gate-a", "the larger CI cluster ranks first");
  assert.equal(full.excludedFindings.length, 2, "what the ceiling excluded is named, not dropped");
  assert.ok(full.excludedFindings.some((f) => f.startsWith("ci-learning:hand-fix:")));

  // The interval and daily cap are the existing rung's: a hand-fix draft adds no marker of its own.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-fix-cadence-`));
  const policy = { enabled: true, minIntervalMinutes: 60, maxPerDay: 1 };
  assert.equal(ciLearningCadenceCheck({ root, policy, now: NOW }).fire, true);
  recordCiLearningCadenceFire(root, NOW);
  const held = ciLearningCadenceCheck({ root, policy, now: new Date(NOW.getTime() + 30 * 60_000) });
  assert.equal(held.fire, false);

  // No qualifying class: nothing is drafted and the status is the rung's ordinary "clear".
  const none = mintCiLearningShards(emptyCorpus, [], input([row(501, 1, CAUSE, ["src/lib/a.ts"])]));
  assert.deepEqual(none.drafts, []);
  assert.equal(none.status, "clear");
  assert.deepEqual(mintCiLearningShards(emptyCorpus, []).drafts, [], "no hand-fix input is the old behaviour");
});
