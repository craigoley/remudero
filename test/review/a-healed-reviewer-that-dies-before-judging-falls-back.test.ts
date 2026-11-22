/**
 * W1-T14283 — A HEALED REVIEWER CHILD THAT DIES BEFORE IT CAN JUDGE FALLS BACK. The Console shape (2026-11-21): a
 * reviewer-regression incident was open, so every review ran from the healed tree, origin/main with the offending merge
 * reverted. A later merge imported an export that merge had added, so the healed child died with a SyntaxError at import:
 * every review.ran_from_healed_tree row had exit_code 1, #2772 was admitted 75 times and nothing posted. The fixture
 * replays that tree for real: its bin/rmd imports the export the revert removes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import { buildReviewerHealthRoute, spawnRmdReviewForFreshTree, type FreshTreeExit, type FreshTreeReviewSeams } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const REPO_URL = "https://github.com/acme/remudero/pull";
const importLine = (names: string, path: string): string => `import { ${names} } from ${JSON.stringify(["", path].join("./"))};`;
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let clock = Date.parse("2026-11-21T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
type Row = Record<string, unknown>;
const unit = (pr: number) => ({ pr_url: `${REPO_URL}/${pr}`, head_sha: fake(`head-${pr}`) });
const posted = (sha: string, pr: number): Row =>
  ({ ts: tick(), host: "core", step: "review.posted", state: "success", plan_only: false, reviewer_code_sha: sha, ...unit(pr) });
const withheld = (sha: string, pr: number): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_incomplete", reason: "required-semantic-incomplete-verdicts", reviewer_outcome: "success",
    reviewer_code_sha: sha, ...unit(pr) });
const refused = (sha: string, pr: number): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable", reviewer_code_sha: sha, ...unit(pr) });
const DIES = "the healed reviewer dies before it can judge";

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}healed-death-${kind}-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  return dir;
}

function commitFile(repo: GitRepo, files: Record<string, string>, subject: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
    if (path === "bin/rmd") chmodSync(join(repo.dir, path), 0o755);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", subject);
  return repo.git("rev-parse", "HEAD");
}

/** C0 healthy; M2 the offending review merge, which also adds the `strict` export; M3 a later merge whose bin/rmd imports
 *  it. The healed tree (M3 with M2 reverted) loads a module without that export: a SyntaxError before `rmd review` runs. */
interface Fixture { work: GitRepo; daemon: GitRepo; c0: string; m2: string; m3: string; root: string }

function fixture(t: TestContext): Fixture {
  const root = scratch(t, "repos");
  const origin = gitRepo({ bare: true, kind: "healed-death-origin" });
  const work = gitRepo({ kind: "healed-death-work" });
  const c0 = commitFile(work, {
    "src/lib/review.ts": `${importLine("refusal", "required-semantic-review.js")}\nexport const judge = () => refusal();\n`,
    "src/lib/required-semantic-review.ts": "export const refusal = () => undefined;\n",
    "bin/flags.mjs": "export const lax = true;\n",
    "docs/notes.md": "notes\n",
  }, "the healthy reviewer (#100)");
  commitFile(work, { "docs/notes.md": "notes, revised\n" }, "docs: revise the notes (#101)");
  const m2 = commitFile(work, {
    "src/lib/required-semantic-review.ts": 'export const refusal = () => "required-semantic-incomplete-verdicts";\n',
    "src/lib/review.ts": `${importLine("refusal", "required-semantic-review.js")}\nexport const judge = () => refusal();\nexport const strict = true;\n`,
    "bin/flags.mjs": "export const lax = true;\nexport const strict = true;\n",
  }, "fix(review): refuse incomplete required semantic evaluation (#102)");
  work.addRemote("origin", origin.dir);
  work.git("push", "-q", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "healed-death-daemon" });
  const f = { work, daemon, c0, m2, m3: "", root };
  f.m3 = pushMain(f, {
    "bin/main.mjs": `${importLine("strict", "flags.mjs")}\nprocess.exit(strict ? 0 : 3);\n`,
    "bin/rmd": '#!/usr/bin/env bash\nexec node "$(dirname "$0")/main.mjs" "$@"\n',
  }, "feat: the launcher reads the strict flag (#103)");
  return f;
}

function pushMain(f: Pick<Fixture, "work">, files: Record<string, string>, subject: string): string {
  const sha = commitFile(f.work, files, subject);
  f.work.git("push", "-q", "origin", "main");
  return sha;
}

function freshTree(f: Fixture, spawnReview: FreshTreeReviewSeams["spawnReview"]): FreshTreeReviewSeams {
  return {
    git: (args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }),
    addWorktree: (repoDir, path, revision) => { execFileSync("git", ["-C", repoDir, "worktree", "add", "-q", "--detach", path, revision], { stdio: "pipe" }); },
    worktreeRoot: join(f.root, "worktrees"),
    spawnReview,
    prepareWorktree: () => true,
    withWorktreeLease: (_tree, action) => action(),
  };
}

/** Reviewer health opened over the fixture: the baseline, then the onset at M2, evaluated with origin/main at M2. */
async function openIncident(t: TestContext) {
  health.resetHealedReviewerTrees();
  const f = fixture(t);
  const git: health.GitText = async (args) => f.daemon.git(...args);
  const dir = scratch(t, "state");
  const ledgerPath = join(dir, "ledger.ndjson");
  const statePath = join(dir, "reviewer-health.json");
  const queue: Row[] = [];
  const titles: string[] = [];
  const issues: AsyncIssueGateway = {
    create: async (title) => { titles.push(title); return `https://github.com/acme/remudero/issues/${titles.length}`; },
    listOpen: async () => [],
    ensureLabel: async () => true,
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async () => ({ prUrl: `${REPO_URL}/900` }),
    readPr: async () => ({ state: "open" as const }),
    closePr: async () => {},
  };
  const escalation = { issues, ledgerPath, runId: "reviewer-health-test" };
  const readRows = async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } });
  const evaluate = (originMainSha: string) =>
    health.evaluateReviewerHealthNow({ originMainSha }, statePath, readRows, git, escalation, lane, () => {}, { iso: () => new Date(clock).toISOString() });
  let pr = 1;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 5; j++) queue.push(posted(fake(`baseline-${i}`), pr++));
  for (let j = 0; j < 5; j++) queue.push(posted(f.c0, pr++));
  queue.push({ ts: tick(), host: "core", step: "daemon.boot", head_sha: f.c0 });
  assert.equal((await evaluate(f.c0)).route, "normal");
  queue.push(withheld(f.m2, 201), withheld(f.m2, 202), withheld(f.m2, 203), withheld(f.m2, 204), refused(f.m2, 205), refused(f.m2, 206));
  const decision = await evaluate(f.m2);
  assert.equal(decision.route, "healed");
  const logs: Array<{ step: string; extra: Row }> = [];
  const route = (spawnReview: FreshTreeReviewSeams["spawnReview"]) => buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, ledgerPath,
    (step, extra = {}) => { logs.push({ step, extra }); }, freshTree(f, spawnReview), issues, lane);
  const deaths = () => titles.filter((title) => title.includes(DIES));
  return { f, ledgerPath, logs, route, deaths, titles };
}

/** A healed child that exits as `rmd review` would after judging: its code, and the cause it names. */
const judged = (code: number, exit: FreshTreeExit, before?: () => void): FreshTreeReviewSeams["spawnReview"] =>
  async (_tree, args, onFailure, _env, _entry, _store, onExit) => {
    if (args.includes(health.REVIEWER_SHADOW_FLAG)) return 0;
    before?.();
    onFailure?.("the review ended");
    onExit?.(exit);
    return code;
  };

/** The healed child that dies at import, reporting no cause, as a fake for repeated runs. */
const diesAtImport: FreshTreeReviewSeams["spawnReview"] = async (_tree, args, onFailure, _env, _entry, _store, onExit) => {
  if (args.includes(health.REVIEWER_SHADOW_FLAG)) return 0;
  onFailure?.("SyntaxError: The requested module './flags.mjs' does not provide an export named 'strict'");
  onExit?.({ cause: "not-reported" });
  return 1;
};

test("W1-T14283 criterion 1: A healed child that exits non-zero at module load, reporting no cause, runs the normal review once and writes reviewer.healed_review_failed", async (t) => {
  const { f, logs, route, deaths } = await openIncident(t);
  let normal = 0;
  const spawned: string[] = [];
  // The REAL spawn: the healed tree's own bin/rmd, which dies at import before `rmd review` can name a cause.
  const real = route(async (tree, args, onFailure, env, onEntry, store, onExit) => {
    if (args.includes(health.REVIEWER_SHADOW_FLAG)) return 0;
    spawned.push(tree);
    return spawnRmdReviewForFreshTree(tree, args, onFailure, env, onEntry, store, onExit);
  });
  assert.equal(await real("2772", ["--repo", "acme/remudero"], { executionMode: "semantic" }, async () => { normal++; return 0; }), 0);
  assert.equal(spawned.length, 1, "the healed child ran");
  assert.equal(execFileSync("git", ["-C", spawned[0]!, "rev-parse", "HEAD^1"], { encoding: "utf8" }).trim(), f.m3, "from origin/main plus the revert");
  assert.equal(normal, 1, "today's path reviews once");
  const failed = logs.filter((l) => l.step === "reviewer.healed_review_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.extra.exit_code, 1);
  assert.equal(failed[0]!.extra.exit_cause, "not-reported");
  assert.equal(failed[0]!.extra.offending_sha, f.m2);
  assert.match(String(failed[0]!.extra.failure), /SyntaxError/);
  assert.ok(String(failed[0]!.extra.failure).length <= 2_000, "the failure text is bounded");
  assert.equal(logs.filter((l) => l.step === "review.ran_from_healed_tree").length, 0, "a death is not a healed review");
  assert.equal(deaths().length, 1, "the death escalates");
});

test("W1-T14283 criterion 2: invariant:a-judgement-never-falls-back — a healed FAIL, withheld post, setup refusal or signal exit returns its own code and never calls the normal review", async (t) => {
  const { ledgerPath, logs, route, deaths } = await openIncident(t);
  const started = () => appendFileSync(ledgerPath, `${JSON.stringify({ ts: tick(), run_id: "review-PR307-1795000000000", step: "review.start_phases", task_id: "PR-307" })}\n`);
  const cases: Array<{ pr: string; code: number; spawn: FreshTreeReviewSeams["spawnReview"] }> = [
    { pr: "301", code: 1, spawn: judged(1, { cause: "verdict-failure" }) },
    { pr: "302", code: 2, spawn: judged(2, { cause: "verdict-not-posted" }) },
    { pr: "303", code: 2, spawn: judged(2, { cause: "semantic-setup-unavailable" }) },
    { pr: "304", code: 1, spawn: judged(1, { cause: "signal", signal: "SIGKILL" }) },
    { pr: "305", code: 1, spawn: judged(1, { cause: "threw-in-review", errorClass: "TypeError" }) },
    // No cause reported, but the child wrote the row it writes before judging: it started, so it never falls back.
    { pr: "307", code: 1, spawn: judged(1, { cause: "not-reported" }, started) },
    // A seam that never reports how its child exited proves nothing.
    { pr: "308", code: 1, spawn: async (_tree, args) => (args.includes(health.REVIEWER_SHADOW_FLAG) ? 0 : 1) },
  ];
  for (const c of cases) {
    let normal = 0;
    assert.equal(await route(c.spawn)(c.pr, [], {}, async () => { normal++; return 0; }), c.code, `PR ${c.pr} returns its own code`);
    assert.equal(normal, 0, `PR ${c.pr} never reviews a second time`);
  }
  assert.equal(logs.filter((l) => l.step === "reviewer.healed_review_failed").length, 0);
  assert.equal(logs.filter((l) => l.step === "review.ran_from_healed_tree").length, cases.length);
  assert.equal(deaths().length, 0);
});

test("W1-T14283 criterion 3: Repeated deaths across pull requests and main advances raise one escalation for the incident and offending sha", async (t) => {
  const { f, logs, route, deaths } = await openIncident(t);
  let normal = 0;
  const review = async (pr: string) => route(diesAtImport)(pr, [], {}, async () => { normal++; return 0; });
  assert.equal(await review("2772"), 0);
  assert.equal(await review("2773"), 0);
  pushMain(f, { "docs/other.md": "other\n" }, "docs: another page (#104)");
  // A rebuilt route, as each poll builds one, on the advanced main.
  assert.equal(await review("2772"), 0);
  assert.equal(await review("2774"), 0);
  assert.equal(normal, 4, "every death falls back to today's path");
  const failed = logs.filter((l) => l.step === "reviewer.healed_review_failed");
  assert.equal(failed.length, 4);
  assert.equal(new Set(failed.map((l) => l.extra.origin_main_sha)).size, 2, "the deaths span a main advance");
  assert.equal(deaths().length, 1, "one escalation for the incident and offending sha");
});

test("W1-T14283: the started-judging record is proved absent only from a readable, unrotated, bounded tail", (t) => {
  const dir = scratch(t, "tail");
  const ledger = join(dir, "ledger.ndjson");
  const row = (pr: number) => `${JSON.stringify({ run_id: `review-PR${pr}-1795000000000`, step: "review.start_phases" })}\n`;
  const absent = health.healedChildLedgerMark(ledger);
  assert.deepEqual(absent, { ino: null, size: 0 });
  assert.equal(health.healedChildStartedJudging(ledger, absent, 7), false, "still absent: nothing was written");
  assert.equal(health.healedChildStartedJudging(ledger, null, 7), true, "an unread mark proves nothing");
  assert.equal(health.healedChildStartedJudging(ledger, absent, undefined), true, "an unknown pull request proves nothing");
  assert.equal(health.healedChildStartedJudging(ledger, { ino: 1, size: 0 }, 7), true, "gone since the mark: rotated");
  writeFileSync(ledger, row(9));
  const mark = health.healedChildLedgerMark(ledger)!;
  assert.equal(mark.size, statSync(ledger).size);
  appendFileSync(ledger, `${row(8)}{"step":"review.start_phases","run_id":"review-PR7-\n${JSON.stringify({ step: "review.posted", run_id: "review-PR7-1" })}\n`);
  assert.equal(health.healedChildStartedJudging(ledger, mark, 7), false, "another PR's row, a torn line and another step are no record");
  assert.equal(health.healedChildStartedJudging(ledger, { ...mark, ino: mark.ino! + 1 }, 7), true, "another file: rotated");
  assert.equal(health.healedChildStartedJudging(ledger, { ...mark, size: statSync(ledger).size + 1 }, 7), true, "shrunk: rotated");
  assert.equal(health.healedChildStartedJudging(ledger, { ...mark, size: statSync(ledger).size - health.HEALED_CHILD_TAIL_MAX_BYTES - 1 }, 7), true,
    "a longer tail than the bound reads as started");
  appendFileSync(ledger, row(7));
  assert.equal(health.healedChildStartedJudging(ledger, mark, 7), true, "this PR's start row is the record");
  assert.equal(health.healedChildLedgerMark(join(ledger, "under-a-file")), null, "an unreadable ledger marks nothing");
  assert.equal(health.healedChildStartedJudging(join(ledger, "under-a-file"), { ino: null, size: 0 }, 7), true, "an unopenable ledger proves nothing");
  assert.equal(health.healedChildStartedJudging(dir, { ino: statSync(dir).ino, size: 0 }, 7), true, "an unreadable tail proves nothing");
});

test("W1-T14283: the death names its own escalation, claimed once per incident and offending sha", () => {
  health.resetHealedReviewerTrees();
  const incident = { id: "reviewer-regression-abc", regressedSha: "a".repeat(40), offending: { sha: "b".repeat(40), subject: "s", reason: "r", pr: 9 },
    evidence: { k: 1, n: 2, z: null, interval: [0, 1], baseline: { k: 0, n: 2 }, baselineInterval: [0, 1] }, signature: [] } as never;
  const e = health.reviewerHealedChildDiedEscalation(incident, "SyntaxError: no export");
  assert.match(e.summary, new RegExp(DIES));
  assert.match(e.detail, /reporting no cause: SyntaxError: no export/);
  assert.equal(e.recommendation, "Heal with a fix PR");
  assert.equal(health.claimHealedDeathEscalation(incident), true);
  assert.equal(health.claimHealedDeathEscalation(incident), false);
  health.resetHealedReviewerTrees();
  assert.equal(health.claimHealedDeathEscalation(incident), true, "the test seam forgets it");
});
