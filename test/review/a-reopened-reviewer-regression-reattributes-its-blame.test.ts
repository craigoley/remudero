import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

type Row = Record<string, unknown>;
const fake = (text: string): string => createHash("sha1").update(text).digest("hex");
const repoUrl = "https://github.com/acme/remudero/pull";
let clock = Date.parse("2026-10-19T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
const unit = (pr: number, sha: string) => ({ pr_url: `${repoUrl}/${pr}`, head_sha: fake(`head-${pr}`), reviewer_code_sha: sha });
const posted = (sha: string, pr: number): Row => ({ ts: tick(), host: "core", step: "review.posted", state: "success", plan_only: false, ...unit(pr, sha) });
const onset = (sha: string, firstPr: number): Row[] => [
  ...Array.from({ length: 4 }, (_, i) => ({ ...posted(sha, firstPr + i), step: "review.semantic_incomplete", reason: "required-semantic-incomplete-verdicts", reviewer_outcome: "success" })),
  ...Array.from({ length: 2 }, (_, i) => ({ ...posted(sha, firstPr + 4 + i), step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable" })),
];
const baseline = (sha: string): Row[] => {
  const rows: Row[] = [];
  let pr = 1;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 5; j++) rows.push(posted(fake(`baseline-${i}`), pr++));
  for (let i = 0; i < 5; i++) rows.push(posted(sha, pr++));
  rows.push({ ts: tick(), host: "core", step: "daemon.boot", head_sha: sha });
  return rows;
};
const healthyShadow = (sha: string, firstPr: number): Row[] => Array.from({ length: 30 }, (_, i) => ({ ...posted(sha, firstPr + i), step: "shadow.review.shadow_verdict" }));

function commitFile(repo: GitRepo, content: string, subject: string): string {
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  writeFileSync(join(repo.dir, "src/run-task.ts"), "// reviewer history fixture: no dispatch review path\n");
  writeFileSync(join(repo.dir, "src/lib/review.ts"), content);
  repo.git("add", "src/lib/review.ts", "src/run-task.ts");
  repo.git("commit", "-q", "-m", subject);
  return repo.git("rev-parse", "HEAD");
}

function historyFixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}W1-T11448-history-`));
  const origin = gitRepo({ bare: true, kind: "11448-history-origin" });
  const work = gitRepo({ kind: "11448-history-work" });
  const c0 = commitFile(work, "export const review = 'healthy';\n", "healthy reviewer (#100)");
  const x = commitFile(work, "export const review = 'old failure';\n", "fix(review): old regression (#101)");
  const c2 = commitFile(work, "export const review = 'healthy again';\n", "fix(review): recover (#102)");
  const y = commitFile(work, "export const review = 'new failure';\n", "fix(review): new regression (#103)");
  work.git("checkout", "-q", "-b", "healthy-reviewer", c2);
  const c3 = commitFile(work, "export const review = 'healthy branch again';\n", "fix(review): recover on healthy branch (#104)");
  work.git("checkout", "-q", "main");
  const z = commitFile(work, "export const review = 'later failure';\n", "fix(review): later regression (#105)");
  work.addRemote("origin", origin.dir);
  work.git("push", "-q", "origin", "main");
  work.git("push", "-q", "origin", "healthy-reviewer");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "11448-history-daemon" });
  daemon.git("fetch", "-q", "origin", "healthy-reviewer");
  return { root, origin, work, daemon, c0, x, c2, c3, y, z };
}

function healthHarness(root: string, daemon: GitRepo) {
  const statePath = join(root, "reviewer-health.json");
  const queue: Row[] = [];
  const logs: Array<{ step: string; extra: Row }> = [];
  const issues = { create: async () => "https://github.com/acme/remudero/issues/1", listOpen: async () => [], ensureLabel: async () => true,
    comment: async () => {}, closeWithComment: async () => {} };
  const lane = { openFixPr: async () => undefined, openRevertPr: async () => ({ refused: "not exercised" }) };
  const evaluate = (originMainSha: string) => health.evaluateReviewerHealthNow(
    { originMainSha }, statePath, async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } }),
    async (args) => daemon.git(...args), { issues, ledgerPath: join(root, "ledger.ndjson"), runId: "reviewer-health-test" }, lane,
    (step, extra = {}) => logs.push({ step, extra }), { iso: tick });
  return { statePath, queue, logs, evaluate };
}

test("W1-T11448 criterion 1: a reopened incident blames fresh within the new range and retains an in-range offender", async (t) => {
  const f = historyFixture();
  t.after(() => f.work.cleanup()); t.after(() => f.daemon.cleanup()); t.after(() => f.origin.cleanup());
  t.after(() => execFileSync("rm", ["-rf", f.root]));
  const h = healthHarness(f.root, f.daemon);
  h.queue.push(...baseline(f.c0)); await h.evaluate(f.c0);
  h.queue.push(...onset(f.x, 200)); await h.evaluate(f.x);
  h.queue.push(...healthyShadow(f.c2, 300)); await h.evaluate(f.c2);
  h.queue.push(...onset(f.y, 400)); await h.evaluate(f.y);
  const outOfRange = health.loadReviewerHealthState(h.statePath).incident!;
  assert.equal(outOfRange.reopenedFrom, `reviewer-regression-${f.x.slice(0, 12)}`);
  assert.equal(outOfRange.offending?.sha, f.y, "the old offender is outside c2..y, so find the new cause");
  assert.equal(outOfRange.lastHealthySha, f.c2);
  h.queue.push(...healthyShadow(f.c3, 500)); await h.evaluate(f.c3);
  const closedAfterC3 = health.loadReviewerHealthState(h.statePath).closed.map((item) => item.id);
  assert.ok(closedAfterC3.includes(outOfRange.id), "the forked healthy tree closes the second incident");
  h.queue.push(...onset(f.z, 600)); await h.evaluate(f.z);
  const inRange = health.loadReviewerHealthState(h.statePath).incident!;
  assert.equal(inRange.reopenedFrom, `reviewer-regression-${f.y.slice(0, 12)}`);
  assert.equal(inRange.lastHealthySha, f.c2);
  assert.equal(inRange.offending?.sha, f.y, "the prior offender remains inside c2..z");
});

function conflictFixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}W1-T11448-conflict-`));
  const origin = gitRepo({ bare: true, kind: "11448-conflict-origin" });
  const work = gitRepo({ kind: "11448-conflict-work" });
  commitFile(work, "export const review = 'healthy';\n", "healthy reviewer (#110)");
  const offender = commitFile(work, "export const review = 'offending';\n", "fix(review): regression (#111)");
  commitFile(work, "export const review = 'rewritten differently';\n", "fix(review): conflict (#112)");
  work.addRemote("origin", origin.dir); work.git("push", "-q", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "11448-conflict-daemon" });
  return { root, work, origin, daemon, offender };
}

test("W1-T11448 criterion 2: a same-main conflict is remembered, then retried after main moves", async (t) => {
  health.resetHealedReviewerTrees();
  const f = conflictFixture();
  t.after(() => health.resetHealedReviewerTrees()); t.after(() => f.work.cleanup()); t.after(() => f.daemon.cleanup());
  t.after(() => f.origin.cleanup()); t.after(() => execFileSync("rm", ["-rf", f.root]));
  let cuts = 0;
  const cut = (prefix: string, sha: string) => {
    cuts++;
    const path = join(f.root, `${prefix}-${sha.slice(0, 12)}-${cuts}`);
    f.daemon.git("worktree", "add", "-q", "--detach", path, sha);
    return path;
  };
  const remove = (path: string) => { f.daemon.git("worktree", "remove", "--force", path); };
  const first = await health.buildHealedReviewerTree(f.daemon.dir, f.offender, cut, remove);
  assert.equal(first.state, "conflict"); assert.equal(cuts, 1);
  const repeated = await health.buildHealedReviewerTree(f.daemon.dir, f.offender, cut, remove);
  assert.equal(repeated.state, "conflict"); assert.equal(repeated.remembered, true);
  if (repeated.state !== "conflict") assert.fail("expected the memoized conflict");
  assert.deepEqual(health.reviewerHealedTreeUnavailableFields(repeated), {
    state: "conflict", reason: repeated.reason, conflict_paths: repeated.paths, remembered: true,
    origin_main_sha: repeated.originMainSha,
  });
  assert.equal(cuts, 1, "same key returns before another cut and revert");
  const moved = commitFile(f.work, "export const unrelated = true;\n", "docs: advance main (#113)");
  f.work.git("push", "-q", "origin", "main");
  const retried = await health.buildHealedReviewerTree(f.daemon.dir, f.offender, cut, remove);
  assert.equal(retried.state, "conflict"); assert.equal(retried.originMainSha, moved);
  assert.notEqual(retried.remembered, true); assert.equal(cuts, 2, "a moved origin/main is a new memo key and retries");
});
