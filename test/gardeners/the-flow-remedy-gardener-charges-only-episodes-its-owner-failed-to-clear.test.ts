import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_FRICTION_EFFECT_MAX_WINDOW_MS } from "#src/lib/ci-friction-remedy.js";
import { fixedClock } from "#src/lib/clock.js";
import { draftShard, FLOW_LADDER, flowGardenSpec, type PrOutcome } from "#src/lib/flow-remedy-gardener.js";
import { PR_BLOCKER_OWNERS, type PrBlocker } from "#src/lib/pr-blocker.js";
import { measureRemedy, prHoursMetric } from "#src/lib/remedy-effect.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 17);
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const url = (pr: number) => `https://github.com/acme/remudero/pull/${pr}`;
const ownerSearch = { filesContaining: () => [], fileExists: () => true };

function disposed(pr: number, hours: number, blocker: PrBlocker, reason: string, extra: Partial<LedgerRecord> = {}): LedgerRecord {
  return { step: "sweep.disposed", pr_number: pr, ts: iso(hours), blocker, blocker_owner: PR_BLOCKER_OWNERS[blocker], reason, ...extra };
}

function inventory(rows: LedgerRecord[], outcomes = new Map<number, PrOutcome>(), ledgerDir?: string) {
  return flowGardenSpec({
    repoRoot: "/unused", stateDir: ledgerDir ?? "/unused", clock: fixedClock(NOW),
    log: () => {}, openWorkspace: () => { throw new Error("unexpected workspace"); },
  }, {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001", ownerSearch,
    ...(ledgerDir === undefined ? { ledgerRecords: () => rows } : {}),
    planState: () => ({ tasks: [] }), prOutcomes: prs => new Map([...outcomes].filter(([pr]) => prs.includes(pr))),
  }).inventory();
}

test("W1-T13524 criterion 1: owner fix, review and acted observations suppress a flow-blocker filing", t => {
  const rows = [
    disposed(1, -4, "own-red", "fix round"), disposed(1, -2, "own-red", "fix round"),
    disposed(2, -4, "awaiting-review", "review round"), disposed(2, -2, "awaiting-review", "review round"),
    disposed(3, -4, "own-red", "acted observation"), disposed(3, -2, "own-red", "acted observation", { acted: true }),
  ];
  const ledger = writeLedger(rows, { scope: t, rotations: [{ at: iso(-1), rows: [
    { step: "fix.dispatch", repair_pr_url: url(1), run_id: "concurrent-sweep", ts: iso(-3) },
    { step: "sweep.review_admitted", pr_number: 2, pr_url: url(2), ts: iso(-3) },
  ] }] });
  const outcomes = new Map<number, PrOutcome>([
    [2, { state: "closed", at: iso(0) }], [3, { state: "closed", at: iso(0) }],
  ]);
  const result = inventory(rows, outcomes, ledger.dir);
  assert.deepEqual(result.priced.map(price => price.key).sort(), [
    "awaiting-review:review round", "own-red:acted observation", "own-red:fix round",
  ]);
  assert.equal(result.next, undefined);
  assert.deepEqual(result.candidates, []);

  const later = inventory([
    ...rows.slice(0, 2), disposed(1, -5, "awaiting-review", "before the fix episode"),
    { step: "fix.dispatch", pr_number: 1, ts: iso(-4.5) },
    { step: "fix.dispatch", pr_number: 99, ts: iso(-3) },
    { step: "review.posted", pr_url: url(1), status_recovered: true, ts: iso(-3) },
  ]);
  assert.equal(later.next?.price.key, "own-red:fix round");
  assert.equal(inventory([...rows.slice(0, 2), { step: "fix.dispatch", pr_number: 1, ts: iso(-1) }]).next, undefined);

  const handoff = inventory([
    disposed(4, -4, "own-red", "handed off", { head_sha: "abcdef1" }),
    disposed(4, -2, "own-red", "handed off"),
    { step: "ci_learning.ladder_handoff", gate: "check", red_heads: [{ pr: 4, sha: "abcdef1" }] },
    { step: "review.posted", pr_url: url(4), ts: iso(-3) },
  ]);
  assert.equal(handoff.next, undefined);
});

test("W1-T13524 criterion 2: terminal observations, pending waits and held drafts never qualify", () => {
  const outcomes = new Map<number, PrOutcome>([
    [10, { state: "merged", at: iso(-3), mergedBy: "remudero-fleet" }],
    [11, { state: "closed", at: iso(-1) }],
    [12, { state: "closed", at: iso(0) }],
    [13, { state: "closed", at: iso(0) }],
    [15, { state: "closed", at: iso(-3) }],
  ]);
  const result = inventory([
    disposed(10, -5, "own-red", "prior red"), disposed(10, -3, "own-red", "at merge"), disposed(10, -2, "escalated", "after merge"),
    disposed(11, -3, "awaiting-review", "prior review"), disposed(11, -1.5, "held-draft", "after close"), disposed(11, -1, "own-red", "later"),
    { step: "pr.terminal", pr_number: 11, state: "closed", closed_at: iso(-2), ts: iso(0) },
    disposed(12, -4, "awaiting-ci", "checks pending under ceiling", { disposition: "wait" }),
    disposed(12, -2, "awaiting-ci", "checks pending under ceiling", { disposition: "wait" }),
    disposed(13, -4, "held-draft", "draft held"), disposed(13, -2, "held-draft", "draft held"),
    disposed(15, -3, "escalated", "at close"), disposed(15, -2, "escalated", "after close"),
    disposed(16, -3, "escalated", "after ledger merge"),
    { step: "pr.terminal", pr_number: 16, state: "merged", merged_at: iso(-3.5), ts: iso(-2) },
  ], outcomes);
  assert.deepEqual(result.episodes.map(episode => [episode.pr, episode.key, episode.outcome]), [
    [10, "own-red:prior red", "cleared"], [11, "awaiting-review:prior review", "failed"],
    [12, "awaiting-ci:checks pending under ceiling", "failed"], [13, "held-draft:draft held", "failed"],
  ]);
  assert.deepEqual(result.charges.map(charge => [charge.pr, charge.end]), [
    [10, NOW - 3 * HOUR], [11, NOW - 2 * HOUR], [12, NOW - 2 * HOUR], [13, NOW - 2 * HOUR],
  ]);
  assert.deepEqual(result.candidates.map(price => price.key), ["awaiting-review:prior review"]);
  assert.equal(result.next?.price.key, "awaiting-review:prior review");

  const stale = inventory([
    disposed(14, -4, "awaiting-ci", "checks pending", { disposition: "wait" }),
    disposed(14, -2, "awaiting-ci", "checks pending", { disposition: "blocked-ambiguous" }),
  ], new Map([[14, { state: "closed", at: iso(0) }]]));
  assert.equal(stale.next?.price.key, "awaiting-ci:checks pending");
});

test("W1-T13524 criterion 3: filing needs eligible overlap with the widened before-window and explains its episodes", () => {
  const before = (3 * CI_FRICTION_EFFECT_MAX_WINDOW_MS) / HOUR;
  const cold = [
    disposed(20, -before - 100, "own-red", "expired"), disposed(20, -before, "own-red", "expired"),
    disposed(21, -4, "own-red", "expired", { acted: true }), disposed(21, -2, "own-red", "expired"),
  ];
  assert.equal(inventory(cold).next, undefined);

  const result = inventory([
    ...cold,
    disposed(22, -before - 1, "own-red", "overlap"), disposed(22, -before + 1, "own-red", "overlap"),
    disposed(23, -4, "own-red", "overlap"), disposed(23, -2, "own-red", "overlap"),
    disposed(24, -10, "own-red", "overlap", { acted: true }), disposed(24, -2, "own-red", "overlap"),
  ], new Map([[23, { state: "merged", at: iso(0), mergedBy: "operator" }]]));
  assert.equal(result.next?.price.key, "own-red:overlap");
  const action = result.next!;
  const measure = measureRemedy({ id: "W1-T9001", origin: action.origin },
    prHoursMetric(FLOW_LADDER.name, FLOW_LADDER.prefix, action.charges), NOW, NOW);
  assert.equal(measure.widened, true);
  assert.equal(measure.effect.before.k, 3);
  const shard = draftShard(action, "W1-T9001", ownerSearch, FLOW_LADDER);
  assert.match(shard, /unowned 0, failed 1, past p90 0, open own-red 1/);
  assert.match(shard, /PR #22/);
  assert.match(shard, /PR #23/);
  assert.doesNotMatch(shard, /PR #24/);
});

test("W1-T13524 criterion 4: the existing unowned, terminal failure and open-age eligibility arms still apply", () => {
  const unownedRows = [disposed(30, -4, "escalated", "unowned"), disposed(30, -2, "escalated", "unowned")];
  const result = inventory([
    ...unownedRows,
    disposed(31, -4, "conflict", "closed"), disposed(31, -2, "conflict", "closed"),
    disposed(32, -4, "review-failed", "operator merged"), disposed(32, -2, "review-failed", "operator merged"),
    disposed(33, -5, "awaiting-review", "review debt"), disposed(33, -4, "awaiting-arm", "review done"),
    disposed(34, -4, "awaiting-review", "review debt"), disposed(34, -2, "awaiting-review", "review debt"),
    disposed(35, -4, "own-red", "aged red"), disposed(35, -2, "own-red", "aged red"),
  ], new Map([
    [31, { state: "closed", at: iso(0) }], [32, { state: "merged", at: iso(0), mergedBy: "operator" }],
  ]));
  assert.deepEqual(result.episodes.filter(episode => episode.eligible).map(episode => episode.pr), [30, 31, 32, 34, 35]);
  assert.deepEqual(result.candidates.map(price => price.key).sort(), [
    "awaiting-review:review debt", "conflict:closed", "escalated:unowned", "own-red:aged red", "review-failed:operator merged",
  ]);
  assert.equal(inventory(unownedRows).ladder[0]?.state, "skipped");
  assert.ok(result.next);
});
