/**
 * The ci-friction gardener found the right causes and nothing happened with them (2026-10-02): six
 * remedies were built as paragraphs in a docs file nothing reads, a landed filing marked its cause
 * decided for good, and the effect reading credited half-life decay. These pin the replacement: a
 * remedy names owning code, is judged by its cause's SHARE of fix rounds around its BUILD merge, and
 * a remedy that did not move the share reopens its cause one rung up, then goes to a person.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CI_FRICTION_EFFECT_MAX_WINDOW_MS,
  CI_FRICTION_ESCALATE_RUNG,
  CI_FRICTION_REMEDIES_DOC,
  ciFrictionCauseState,
  ciFrictionEvidence,
  ciFrictionRemedyEffect,
  ciFrictionRemedyRationale,
  ciFrictionRungOrigin,
  isDocOnlyRemedy,
  locateCiFrictionOwner,
  ownerSearchTerms,
  parseCiFrictionOrigin,
  remedyRung,
  replayCiFrictionLadder,
  type CiFrictionRemedyTask,
  type OwnerSearch,
  type RemedyRound,
} from "../src/lib/ci-friction-remedy.js";

const DAY = 86_400_000;
const MERGE = Date.parse("2026-09-20T00:00:00.000Z");
const KEY = "fix_refusal:the-worker-changed-nothing";

/** `n` rounds evenly spread over [fromMs, toMs), every `every`-th one of `key`, the rest of `other`. */
function rounds(fromMs: number, toMs: number, n: number, every: number, key = KEY): RemedyRound[] {
  return Array.from({ length: n }, (_, i) => ({
    pr: 1000 + i,
    causeKey: i % every === 0 ? key : "check:ci-log:commitlint",
    at: new Date(fromMs + ((toMs - fromMs) * i) / n).toISOString(),
    detail: i % every === 0 ? "the worker changed nothing" : "commitlint round",
  }));
}

function remedy(over: Partial<CiFrictionRemedyTask> = {}): CiFrictionRemedyTask {
  return { id: "W1-T7001", origin: `ci-friction:${KEY}`, status: "merged", retired: false, files: ["src/run-task.ts", "test/w1-t7001-x.test.ts"], mergedAt: new Date(MERGE).toISOString(), ...over };
}

test("a ci-friction origin carries its rung, and rung 1 keeps the original spelling", () => {
  assert.deepEqual(parseCiFrictionOrigin(`ci-friction:${KEY}`), { key: KEY, rung: 1 });
  assert.deepEqual(parseCiFrictionOrigin(`ci-friction:${KEY}#r3`), { key: KEY, rung: 3 });
  assert.equal(parseCiFrictionOrigin("ci-learning:4283:coverage-ratchet"), undefined);
  assert.equal(ciFrictionRungOrigin(KEY, 1), `ci-friction:${KEY}`);
  assert.equal(ciFrictionRungOrigin(KEY, 2), `ci-friction:${KEY}#r2`);
});

test("a docs-only record is rung 0 whatever its origin says", () => {
  assert.equal(isDocOnlyRemedy({ files: [CI_FRICTION_REMEDIES_DOC] }), true);
  assert.equal(isDocOnlyRemedy({ files: [] }), true);
  assert.equal(isDocOnlyRemedy({ files: [CI_FRICTION_REMEDIES_DOC, "src/run-task.ts"] }), false);
  assert.equal(remedyRung(remedy({ files: [CI_FRICTION_REMEDIES_DOC], origin: `ci-friction:${KEY}#r2` })), 0);
  assert.equal(remedyRung(remedy({ origin: `ci-friction:${KEY}#r2` })), 2);
  assert.equal(remedyRung(remedy({ origin: "not-a-ci-friction-origin" })), 1);
});

test("a remedy whose cause's share of fix rounds fell significantly is credited", () => {
  const before = rounds(MERGE - 4 * DAY, MERGE, 200, 4); // 25%
  const after = rounds(MERGE, MERGE + 4 * DAY, 200, 20); // 5%
  const effect = ciFrictionRemedyEffect([...before, ...after], KEY, MERGE, MERGE + 4 * DAY);
  assert.equal(effect.verdict, "credit");
  assert.deepEqual(effect.before, { k: 50, n: 200 });
  assert.deepEqual(effect.after, { k: 10, n: 200 });
  assert.ok(effect.z < -1.6449);
  assert.match(effect.reason, /^fell: share of fix rounds 25\.0% \(50\/200\) before, 5\.0% \(10\/200\) after/);
});

test("a quieter fleet with the same share is a debit, never a credit", () => {
  // Half the volume after the merge, the same 25% share: decayed minutes would fall; the share does not.
  const before = rounds(MERGE - 4 * DAY, MERGE, 200, 4);
  const after = rounds(MERGE, MERGE + 4 * DAY, 200, 4);
  const effect = ciFrictionRemedyEffect([...before, ...after], KEY, MERGE, MERGE + 4 * DAY);
  assert.equal(effect.verdict, "debit");
  assert.match(effect.reason, /^did not fall:/);
});

test("too little evidence after the merge is pending, and a cause absent before is unmeasurable", () => {
  const before = rounds(MERGE - 4 * DAY, MERGE, 200, 4);
  const thin = rounds(MERGE, MERGE + 4 * DAY, 20, 4);
  assert.equal(ciFrictionRemedyEffect([...before, ...thin], KEY, MERGE, MERGE + 4 * DAY).verdict, "pending");
  const absent = rounds(MERGE - 4 * DAY, MERGE, 50, 1, "check:ci-log:claims");
  const effect = ciFrictionRemedyEffect(absent, KEY, MERGE, MERGE + 4 * DAY);
  assert.equal(effect.verdict, "unmeasurable");
  assert.match(effect.reason, /no fix_refusal:the-worker-changed-nothing round/);
  // A round with no time, or outside both windows, counts on neither side.
  const stray = ciFrictionRemedyEffect([{ pr: 1, causeKey: KEY }, { pr: 2, causeKey: KEY, at: "not a date" }, ...before], KEY, MERGE, MERGE + DAY);
  assert.deepEqual(stray.before.n, 50);
});

test("an old remedy is judged on its most recent fortnight, not its whole history", () => {
  const now = MERGE + 60 * DAY;
  const ancient = rounds(MERGE - 30 * DAY, MERGE - 20 * DAY, 100, 1);
  const effect = ciFrictionRemedyEffect(ancient, KEY, MERGE, now);
  assert.equal(effect.windowDays, CI_FRICTION_EFFECT_MAX_WINDOW_MS / DAY);
  assert.equal(effect.verdict, "unmeasurable", "rounds older than the capped window are not the before side");
});

test("a cause with no task is drafted at rung 1, and a landed filing receipt holds it", () => {
  assert.deepEqual(ciFrictionCauseState(KEY, [], [], MERGE), { state: "draft", key: KEY, rung: 1 });
  const held = ciFrictionCauseState(KEY, [], [], MERGE, new Set([`ci-friction:${KEY}`]));
  assert.equal(held.state, "in_progress");
});

test("an open remedy is in progress, and a retired one is a decision that is never re-drafted", () => {
  assert.equal(ciFrictionCauseState(KEY, [remedy({ status: "queued", mergedAt: undefined })], [], MERGE).state, "in_progress");
  const retired = ciFrictionCauseState(KEY, [remedy({ status: "blocked", retired: true, mergedAt: undefined })], [], MERGE);
  assert.equal(retired.state, "retired");
});

test("W1-T5076's docs-only remedy reopens its cause at rung 1 with the doc named as the last attempt", () => {
  const doc = remedy({ id: "W1-T5076", files: [CI_FRICTION_REMEDIES_DOC] });
  const s = ciFrictionCauseState(KEY, [doc], [], MERGE + DAY);
  assert.equal(s.state, "draft");
  assert.equal(s.state === "draft" && s.rung, 1);
  assert.equal(s.state === "draft" && s.prior?.task.id, "W1-T5076");
  // A person retiring the docs record retired the doc, not the cause.
  const retiredDoc = ciFrictionCauseState(KEY, [{ ...doc, retired: true, mergedAt: undefined, status: "blocked" }], [], MERGE + DAY);
  assert.equal(retiredDoc.state, "draft");
});

test("a merged remedy is measuring, then resolved on a fall, or reopened one rung up on none", () => {
  const before = rounds(MERGE - 4 * DAY, MERGE, 200, 4);
  const thin = rounds(MERGE, MERGE + 4 * DAY, 20, 4);
  assert.equal(ciFrictionCauseState(KEY, [remedy()], [...before, ...thin], MERGE + 4 * DAY).state, "measuring");
  const fell = rounds(MERGE, MERGE + 4 * DAY, 200, 20);
  assert.equal(ciFrictionCauseState(KEY, [remedy()], [...before, ...fell], MERGE + 4 * DAY).state, "resolved");
  const flat = rounds(MERGE, MERGE + 4 * DAY, 200, 4);
  const reopened = ciFrictionCauseState(KEY, [remedy()], [...before, ...flat], MERGE + 4 * DAY);
  assert.equal(reopened.state, "draft");
  assert.equal(reopened.state === "draft" && reopened.rung, 2);
  assert.equal(reopened.state === "draft" && reopened.prior?.effect?.verdict, "debit");
  // A cause that had already stopped before the merge is resolved by another road.
  assert.equal(ciFrictionCauseState(KEY, [remedy()], [], MERGE + DAY).state, "resolved");
  // Merged by status but no build merge time yet: wait, measure nothing.
  assert.equal(ciFrictionCauseState(KEY, [remedy({ mergedAt: undefined })], before, MERGE + DAY).state, "in_progress");
});

test("the second failed rung goes to a person instead of a third task", () => {
  const before = rounds(MERGE - 4 * DAY, MERGE, 200, 4);
  const flat = rounds(MERGE, MERGE + 4 * DAY, 200, 4);
  const rung2 = remedy({ id: "W1-T7002", origin: `ci-friction:${KEY}#r2` });
  const s = ciFrictionCauseState(KEY, [remedy({ mergedAt: new Date(MERGE - 20 * DAY).toISOString() }), rung2], [...before, ...flat], MERGE + 4 * DAY);
  assert.equal(s.state, "escalate");
  assert.equal(s.state === "escalate" && s.rung, CI_FRICTION_ESCALATE_RUNG);
  assert.equal(s.state === "escalate" && s.prior.task.id, "W1-T7002");
});

test("a reopened draft skips a rung that already has a record or a receipt", () => {
  const before = rounds(MERGE - 4 * DAY, MERGE, 200, 4);
  const flat = rounds(MERGE, MERGE + 4 * DAY, 200, 4);
  const s = ciFrictionCauseState(KEY, [remedy()], [...before, ...flat], MERGE + 4 * DAY, new Set([`ci-friction:${KEY}#r2`]));
  assert.equal(s.state, "escalate", "rung 2's filing already landed, so the next free rung is the escalation rung");
});

function search(map: Record<string, Array<{ file: string; hits: number }>>, files: string[] = []): OwnerSearch {
  return { filesContaining: (term) => map[term] ?? [], fileExists: (f) => files.includes(f) };
}

test("a refusal is owned by the code that raises its reason, most-implicated first", () => {
  const terms = ownerSearchTerms("fix_refusal:no-anchored-commit-message-line-in-the-report", ["no anchored COMMIT_MESSAGE line in the report", "short", "no anchored COMMIT_MESSAGE line in the report: abc1234"]);
  assert.deepEqual(terms, ["no anchored COMMIT_MESSAGE line in the report"]);
  const owner = locateCiFrictionOwner("fix_refusal:no-anchored-commit-message-line-in-the-report", ["no anchored COMMIT_MESSAGE line in the report"], search({
    "no anchored COMMIT_MESSAGE line in the report": [{ file: "src/lib/sweep.ts", hits: 1 }, { file: "src/run-task.ts", hits: 3 }, { file: "scripts/x.mjs", hits: 1 }],
  }));
  assert.deepEqual(owner?.files, ["src/run-task.ts", "scripts/x.mjs"]);
  assert.match(owner!.why[0]!, /src\/run-task\.ts: names "no anchored COMMIT_MESSAGE line in the report" \(3 line\(s\)\)/);
});

test("a CI check is owned by the code naming its family, and its rounds' failing test is evidence", () => {
  assert.deepEqual(ownerSearchTerms("check:ci-log:coverage-ratchet:diff-coverage-blocked", []), ["coverage-ratchet"]);
  assert.deepEqual(ownerSearchTerms("check:reviewer-unmet", []), ["reviewer-unmet"]);
  const owner = locateCiFrictionOwner("check:ci-log:coverage-shard:test-docs-claims-test-ts", ["ci-log round — coverage-shard: test/docs-claims.test.ts"], search({ "coverage-shard": [{ file: "scripts/coverage-shard.mjs", hits: 4 }] }));
  assert.deepEqual(owner, { files: ["scripts/coverage-shard.mjs"], why: ['scripts/coverage-shard.mjs: names "coverage-shard" (4 line(s))'], failingTest: "test/docs-claims.test.ts" });
});

test("a main-merge cause is owned by the file it conflicts on, and an unlocatable cause has no owner", () => {
  assert.deepEqual(locateCiFrictionOwner("main_merge:src/lib/shared.ts", [], search({}, ["src/lib/shared.ts"]))?.files, ["src/lib/shared.ts"]);
  assert.equal(locateCiFrictionOwner("main_merge:src/lib/gone.ts", [], search({})), undefined);
  assert.equal(locateCiFrictionOwner("check:ci-log:mystery", [], search({})), undefined);
  assert.deepEqual(ownerSearchTerms("conflict:merge-conflict", []), []);
});

test("the evidence pack is the newest rounds, one per pull request", () => {
  const rs: RemedyRound[] = [
    { pr: 1, causeKey: KEY, at: "2026-10-01T00:00:00Z", detail: "a" },
    { pr: 1, causeKey: KEY, at: "2026-10-02T00:00:00Z", detail: "b" },
    { pr: 2, causeKey: KEY, at: "2026-09-30T00:00:00Z" },
    { pr: 3, causeKey: "other", at: "2026-10-03T00:00:00Z", detail: "c" },
    { pr: 4, causeKey: KEY },
  ];
  assert.deepEqual(ciFrictionEvidence(rs, KEY), [
    { pr: 1, at: "2026-10-02T00:00:00Z", detail: "b" },
    { pr: 2, at: "2026-09-30T00:00:00Z", detail: "" },
  ]);
  assert.equal(ciFrictionEvidence(rs, KEY, 1).length, 1);
});

test("a drafted remedy's rationale names the cause, its evidence and the last rung's outcome", () => {
  const effect = ciFrictionRemedyEffect([...rounds(MERGE - 4 * DAY, MERGE, 200, 4), ...rounds(MERGE, MERGE + 4 * DAY, 200, 4)], KEY, MERGE, MERGE + 4 * DAY);
  const lines = ciFrictionRemedyRationale({
    key: KEY, minutes: 453.6, rounds: 127, prs: 79,
    owner: { files: ["src/run-task.ts"], why: ["src/run-task.ts: names x"], failingTest: "test/a.test.ts" },
    evidence: [{ pr: 8601, at: "2026-10-02T10:00:00Z", detail: "" }],
    prior: { task: remedy({ id: "W1-T7001" }), effect },
  }).join("\n");
  assert.match(lines, /cost 453\.6 PR minute\(s\)/);
  assert.match(lines, /- the rounds name a failing test: test\/a\.test\.ts/);
  assert.match(lines, /- PR #8601 at 2026-10-02T10:00:00Z: \(no detail recorded\)/);
  assert.match(lines, /WHAT THE LAST RUNG TRIED: W1-T7001 \(files src\/run-task\.ts, test\/w1-t7001-x\.test\.ts\) — did not fall:/);
  assert.match(lines, /A paragraph in docs is not a remedy/);
  const docPrior = ciFrictionRemedyRationale({ key: KEY, minutes: 1, rounds: 1, prs: 1, owner: { files: ["src/a.ts"], why: [] }, evidence: [], prior: { task: remedy({ files: [CI_FRICTION_REMEDIES_DOC] }) } }).join("\n");
  assert.match(docPrior, /a docs-only record, which changed no code path; its advice is under ci-friction:fix_refusal:the-worker-changed-nothing in docs\/ci-friction-remedies\.md\)\./);
  assert.match(docPrior, /- \(none recorded\)/);
});

test("the replay shows a docs-only remedy reopening its cause and a filed rung holding it", () => {
  const all = [...rounds(MERGE - 6 * DAY, MERGE + 6 * DAY, 400, 4)];
  const doc = { ...remedy({ id: "W1-T5076", files: [CI_FRICTION_REMEDIES_DOC], mergedAt: new Date(MERGE - 3 * DAY).toISOString() }), filedAt: new Date(MERGE - 5 * DAY).toISOString() };
  const rung1 = { ...remedy({ id: "W1-T7001", status: "queued", mergedAt: undefined }), filedAt: new Date(MERGE + 2 * DAY).toISOString() };
  const retiredLater = { ...remedy({ id: "W1-T7009", origin: "ci-friction:check:ci-log:commitlint", status: "blocked", retired: true, mergedAt: undefined }), filedAt: new Date(MERGE - 5 * DAY).toISOString(), retiredAt: new Date(MERGE + 3 * DAY).toISOString() };
  const steps = replayCiFrictionLadder({
    fromMs: MERGE - 4 * DAY,
    toMs: MERGE + 4 * DAY,
    stepMs: 4 * DAY,
    rounds: all,
    price: (visible) => [KEY, "check:ci-log:commitlint"].map((key) => ({ key, minutes: visible.filter((r) => r.causeKey === key).length })),
    tasks: [doc, rung1, retiredLater],
  });
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.causes[0]!.state, "in_progress", "the docs record is still building at the first step");
  assert.deepEqual(steps[1]!.next, { key: KEY, state: "draft", rung: 1 }, "once the docs record merged, the cause reopens");
  assert.equal(steps[2]!.causes.find((c) => c.key === KEY)!.state, "in_progress", "the rung-1 remedy filed in between holds it");
  assert.equal(steps[0]!.causes.find((c) => c.key === "check:ci-log:commitlint")!.state, "in_progress", "not retired until its retirement lands");
  assert.equal(steps[2]!.causes.find((c) => c.key === "check:ci-log:commitlint")!.state, "retired");
});
