/**
 * W1-T10269 — A REVIEWER REGRESSION HEALS ITSELF. The fixture replays the 2026-10-20 shape: a baseline
 * of posted code reviews across several reviewer code shas with zero withheld-with-success; an
 * in-process boot head that predates the offending merge while fresh-tree reviews AT the offending sha
 * withhold and refuse; and a non-review merge between the last healthy sha and the offending one,
 * which must not be blamed. Every effect is an injected fake: no test here posts a status or a PR.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import { postReviewStatusGuarded } from "#src/lib/review.js";
import { checkReviewerCodeFreshness, type ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { MainRepairLane, MainRepairRevertRequest } from "#src/lib/main-health-rung.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import { reviewerRegressionRevertText } from "#src/lib/main-health-rung.js";
import { assigningIssueGateway, buildReviewerHealthRoute, mainRepairRevertBody, reviewCommand, reviewerRevertLane, runReview, type FreshTreeReviewSeams } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const REPO_URL = "https://github.com/acme/remudero/pull";
/** A fixture module's import line, spelled so this file's own text carries no relative specifier. */
const importLine = (names: string, path: string): string => `import { ${names} } from ${JSON.stringify(["", path].join("./"))};`;
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let clock = Date.parse("2026-10-19T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
type Row = Record<string, unknown>;
const unit = (pr: number, head = fake(`head-${pr}`)) => ({ pr_url: `${REPO_URL}/${pr}`, head_sha: head });
const posted = (sha: string, pr: number, host = "core"): Row =>
  ({ ts: tick(), host, step: "review.posted", state: "success", plan_only: false, reviewer_code_sha: sha, ...unit(pr) });
const withheld = (sha: string | undefined, pr: number, outcome = "success", host = "core"): Row =>
  ({ ts: tick(), host, step: "review.semantic_incomplete", reason: "required-semantic-incomplete-verdicts", reviewer_outcome: outcome,
    ...(sha === undefined ? {} : { reviewer_code_sha: sha }), ...unit(pr) });
const refused = (sha: string, pr: number, host = "core"): Row =>
  ({ ts: tick(), host, step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable", reviewer_code_sha: sha, ...unit(pr) });
const boot = (sha: string, host = "core"): Row => ({ ts: tick(), host, step: "daemon.boot", head_sha: sha });

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reviewer-heal-${kind}-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  return dir;
}

/** origin (bare) ← work, and the daemon's clone of origin. One commit per merge, as GitHub's squash
 *  merge lands them: C0 healthy, M1 a docs merge, M2 the offending review merge. */
interface TenTwenty { origin: GitRepo; work: GitRepo; daemon: GitRepo; c0: string; m1: string; m2: string; root: string }

function commitFile(repo: GitRepo, files: Record<string, string>, subject: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", subject);
  return repo.git("rev-parse", "HEAD");
}

function tenTwenty(t: TestContext): TenTwenty {
  const root = scratch(t, "repos");
  const origin = gitRepo({ bare: true, kind: "reviewer-heal-origin" });
  const work = gitRepo({ kind: "reviewer-heal-work" });
  const c0 = commitFile(work, {
    "src/lib/review.ts": `${importLine("refusal", "required-semantic-review.js")}\nexport const judge = () => refusal();\n`,
    "src/lib/required-semantic-review.ts": "export const refusal = () => undefined;\n",
    "docs/notes.md": "notes\n",
  }, "the healthy reviewer (#100)");
  const m1 = commitFile(work, { "docs/notes.md": "notes, revised\n" }, "docs: revise the notes (#101)");
  const m2 = commitFile(work, {
    "src/lib/required-semantic-review.ts": 'export const refusal = () => "required-semantic-incomplete-verdicts";\n',
    "src/lib/review.ts": `${importLine("refusal", "required-semantic-review.js")}\nexport const judge = () => refusal();\nexport const strict = true;\n`,
  }, "fix(review): refuse incomplete required semantic evaluation (#102)");
  work.addRemote("origin", origin.dir);
  work.git("push", "-q", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "reviewer-heal-daemon" });
  return { origin, work, daemon, c0, m1, m2, root };
}

const pushMain = (f: TenTwenty, files: Record<string, string>, subject: string): string => {
  const sha = commitFile(f.work, files, subject);
  f.work.git("push", "-q", "origin", "main");
  return sha;
};

/** The healed builder's cut and remove over the daemon clone: a detached worktree per cut. */
function cutter(f: TenTwenty): { cut: (prefix: string, sha: string) => string; remove: (dir: string) => void } {
  return {
    cut: (prefix, sha) => {
      const path = join(f.root, `${prefix}-${sha.slice(0, 12)}-${Math.random().toString(36).slice(2, 8)}`);
      f.daemon.git("worktree", "add", "-q", "--detach", path, sha);
      return path;
    },
    remove: (dir) => { f.daemon.git("worktree", "remove", "--force", dir); },
  };
}

/** The review path's own FreshTreeReviewSeams over the daemon clone, as buildSweepEffects builds them. */
function freshTree(f: TenTwenty, spawnReview: FreshTreeReviewSeams["spawnReview"], extra: Partial<FreshTreeReviewSeams> = {}): FreshTreeReviewSeams {
  return {
    git: (args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }),
    addWorktree: (repoDir, path, revision) => { execFileSync("git", ["-C", repoDir, "worktree", "add", "-q", "--detach", path, revision], { stdio: "pipe" }); },
    worktreeRoot: join(f.root, "worktrees"),
    spawnReview,
    prepareWorktree: () => true,
    withWorktreeLease: (_tree, action) => action(),
    ...extra,
  };
}

interface Calls {
  issues: Array<{ title: string; body: string }>;
  closedIssues: string[];
  reverts: MainRepairRevertRequest[];
  closedPrs: Array<{ url: string; comment: string }>;
}

/** Reviewer health's inputs: a queue standing in for the ledger, the escalation's issue gateway and
 *  the red-main repair lane as recording fakes, and the real fixture git. */
function harness(t: TestContext, git: health.GitText, over: Partial<AsyncIssueGateway & MainRepairLane> = {}) {
  const dir = scratch(t, "state");
  const ledgerPath = join(dir, "ledger.ndjson");
  const statePath = join(dir, "reviewer-health.json");
  const queue: Row[] = [];
  const logs: Array<{ step: string; extra: Row }> = [];
  const calls: Calls = { issues: [], closedIssues: [], reverts: [], closedPrs: [] };
  const issues: AsyncIssueGateway = {
    create: over.create ?? (async (title, body) => { calls.issues.push({ title, body }); return `https://github.com/acme/remudero/issues/${calls.issues.length}`; }),
    listOpen: async () => [],
    ensureLabel: async () => true,
    comment: async (_url, body) => { calls.issues.push({ title: "(comment)", body }); },
    closeWithComment: over.closeWithComment ?? (async (url) => { calls.closedIssues.push(url); }),
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: over.openRevertPr ?? (async (request) => { calls.reverts.push(request); return { prUrl: `${REPO_URL}/900` }; }),
    readPr: over.readPr ?? (async () => ({ state: "open" as const })),
    closePr: over.closePr ?? (async (url, comment) => { calls.closedPrs.push({ url, comment }); }),
  };
  const escalation = { issues, ledgerPath, runId: "reviewer-health-test" };
  const log = (step: string, extra: Row = {}) => { logs.push({ step, extra }); };
  const clockPort = { iso: () => new Date(clock).toISOString() };
  const readRows = async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } });
  const evaluate = (originMainSha: string | null) =>
    health.evaluateReviewerHealthNow({ originMainSha }, statePath, readRows, git, escalation, lane, log, clockPort);
  const write = (...rows: Row[]) => appendFileSync(ledgerPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return { queue, logs, calls, statePath, ledgerPath, issues, lane, escalation, log, clockPort, readRows, evaluate, write,
    steps: (step: string) => logs.filter((l) => l.step === step) };
}

/** The 10-20 baseline: twenty reviewer code shas and then C0, five posted code reviews each, none withheld. */
function baseline(f: TenTwenty): Row[] {
  const rows: Row[] = [];
  let pr = 1;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 5; j++) rows.push(posted(fake(`baseline-${i}`), pr++));
  for (let j = 0; j < 5; j++) rows.push(posted(f.c0, pr++));
  rows.push(boot(f.c0));
  return rows;
}

/** The onset: fresh-tree reviews at the offending sha M2 (the boot head is still C0) withhold and refuse. */
const onset = (f: TenTwenty): Row[] => [withheld(f.m2, 201), withheld(f.m2, 202), withheld(f.m2, 203), withheld(f.m2, 204),
  refused(f.m2, 205), refused(f.m2, 206)];

async function openTenTwenty(t: TestContext, over: Partial<AsyncIssueGateway & MainRepairLane> = {}) {
  const f = tenTwenty(t);
  const h = harness(t, async (args) => f.daemon.git(...args), over);
  h.queue.push(...baseline(f));
  const seeded = await h.evaluate(f.c0);
  assert.equal(seeded.route, "normal");
  h.queue.push(...onset(f));
  const decision = await h.evaluate(f.m2);
  return { f, h, decision };
}

test("W1-T10269: the 10-20 outcome shape opens a reviewer-regression incident naming the offending merge", async (t) => {
  const { f, h, decision } = await openTenTwenty(t);
  const opened = h.steps("reviewer.regression_opened");
  assert.equal(opened.length, 1, "one incident");
  const incident = health.loadReviewerHealthState(h.statePath).incident!;
  assert.equal(incident.regressedSha, f.m2, "the code that judged: the fresh tree's sha, not the boot head");
  assert.equal(incident.bootHeadSha, f.c0, "the boot head current at onset is named too");
  assert.notEqual(incident.regressedSha, incident.bootHeadSha, "a detector keyed on daemon.boot head_sha alone names the wrong code");
  assert.equal(incident.lastHealthySha, f.c0);
  assert.equal(incident.offending?.sha, f.m2, "the review-material merge");
  assert.notEqual(incident.offending?.sha, f.m1, "the earlier non-review merge is not blamed");
  assert.equal(incident.offending?.pr, 102);
  assert.match(incident.offending!.reason, /src\/lib\/re/);
  assert.deepEqual(incident.signature, ["head-task-metadata-unavailable", "required-semantic-incomplete-verdicts"]);
  assert.equal(incident.evidence.k, 6);
  assert.equal(incident.evidence.n, 6);
  assert.equal(incident.evidence.baseline.k, 0);
  assert.equal(incident.evidence.baseline.n, 105);
  assert.equal(h.calls.issues.length, 1, "raised as an issue");
  assert.equal(h.calls.reverts.length, 1);
  assert.equal(decision.route, "healed");
  assert.equal(decision.route === "healed" && decision.shadow, false, "today's reviewer IS the regressed sha: judged, so no shadow");
  assert.equal(opened[0]!.extra.boot_head_sha, f.c0);
  assert.equal(opened[0]!.extra.offending_pr, 102);
});

test("W1-T10269: an outcome mix inside the baseline opens no incident", async (t) => {
  const h = harness(t, async () => { throw new Error("no git needed"); });
  // A baseline that already carries withholds: 20 of 300 units.
  let pr = 1;
  for (let i = 0; i < 30; i++) {
    const sha = fake(`noisy-${i}`);
    for (let j = 0; j < 10; j++) h.queue.push(i % 3 === 0 && j < 2 ? withheld(sha, pr++) : posted(sha, pr++));
  }
  await h.evaluate(null);
  const current = fake("noisy-current");
  h.queue.push(withheld(current, 9001), ...Array.from({ length: 9 }, (_, j) => posted(current, 9002 + j)));
  const decision = await h.evaluate(current);
  const state = health.loadReviewerHealthState(h.statePath);
  const judged = health.judgeReviewerSha(state, current);
  assert.ok(judged.k / judged.n > judged.baseline.k / judged.baseline.n,
    "the current sha withholds MORE often than its baseline's mean: a fixed rate would open here");
  assert.equal(judged.state, "healthy", "but its interval sits inside the baseline's");
  assert.equal(state.incident, null);
  assert.equal(h.steps("reviewer.regression_opened").length, 0);
  assert.equal(h.calls.issues.length, 0);
  assert.equal(decision.route, "normal");
  // A thin sample: one posted review at a new sha could not have shown a regression.
  const thin = fake("noisy-thin");
  h.queue.push(posted(thin, 9100));
  await h.evaluate(thin);
  const thinJudged = health.judgeReviewerSha(health.loadReviewerHealthState(h.statePath), thin);
  assert.equal(thinJudged.state, "insufficient", "a thin sample reads insufficient, never healthy");
  assert.equal(thinJudged.reason, "thin-sample");
  assert.equal(health.judgeReviewerSha(state, fake("never-seen")).reason, "no-outcomes");
});

test("W1-T10269: the healed reviewer is origin/main plus the revert and W1-T228 reads it fresh", async (t) => {
  health.resetHealedReviewerTrees();
  const { f, h } = await openTenTwenty(t);
  const { cut, remove } = cutter(f);
  const healed = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.equal(healed.state, "ready");
  if (healed.state !== "ready") return;
  const at = (args: string[]) => execFileSync("git", ["-C", healed.path, ...args], { encoding: "utf8" }).trim();
  assert.equal(healed.originMainSha, f.m2);
  assert.equal(at(["rev-parse", "HEAD^1"]), f.m2, "origin/main is the healed commit's parent");
  assert.equal(at(["merge-base", "HEAD", "origin/main"]), f.m2, "so its merge-base with origin/main IS origin/main");
  assert.equal(at(["show", "HEAD:src/lib/required-semantic-review.ts"]), "export const refusal = () => undefined;",
    "the offending merge is reverted");
  assert.equal(readFileSync(join(healed.path, "docs/notes.md"), "utf8"), "notes, revised\n", "the non-review merge stays");
  // W1-T228, exactly as the child reads it: the guarded path of the reviewer's own freshness check.
  const childEnv = { RMD_SELF_SYNC_DONE: "1" };
  const fresh = checkReviewerCodeFreshness(healed.path, childEnv);
  assert.equal(fresh.status, "fresh", JSON.stringify(fresh));
  const publishLedger = join(scratch(t, "publish"), "state", "ledger.ndjson");
  const posts: string[] = [];
  const publish = (freshness: ReviewerCodeFreshness, sha: string) => postReviewStatusGuarded({
    owner: "acme", repo: "remudero", sha, state: "success", description: "PASS", taskId: "PR-205", evidence: "executed",
    ledgerPath: publishLedger, runId: `publish-${sha.slice(0, 7)}`, prUrl: `${REPO_URL}/205`, reviewerCodeFreshness: freshness,
    fetchLifecycle: () => ({ merged: false, closed: false }), post: ({ state }: { state: string }) => { posts.push(state); },
  } as never);
  const published = await publish(fresh, fake("head-205"));
  assert.equal(published.posted, true, `the healed verdict publishes: ${published.reason ?? ""}`);
  // The obvious fallback, an older head (the last healthy sha), W1-T228 reads stale and withholds.
  const old = join(f.root, "old-head");
  f.daemon.git("worktree", "add", "-q", "--detach", old, f.c0);
  const stale = checkReviewerCodeFreshness(old, childEnv);
  assert.equal(stale.status, "stale");
  const withheldPost = await publish(stale, fake("head-206"));
  assert.equal(withheldPost.posted, false);
  assert.match(withheldPost.reason ?? "", /materially behind origin\/main/);
  assert.deepEqual(posts, ["success"]);
  // Through the daemon's route: the reviewer it spawns is that healed tree, never the old head or an engine tree.
  const spawned: Array<{ tree: string; args: string[] }> = [];
  let normal = 0;
  const route = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath, () => {},
    freshTree(f, async (tree, args) => { spawned.push({ tree, args }); return 0; }), h.issues, h.lane);
  assert.equal(await route("207", ["--repo", "acme/remudero"], { executionMode: "semantic" }, async () => ++normal), 0);
  assert.equal(normal, 0, "the healed tree reviewed, not today's path");
  assert.equal(spawned.length, 1, "today's reviewer is judged regressed: no shadow, one healed review");
  const tree = spawned[0]!.tree;
  const parent = execFileSync("git", ["-C", tree, "rev-parse", "HEAD^1"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(parent, f.m2);
  assert.ok(![f.c0, f.m1, f.m2].includes(head), "the reviewer is no old head, and not origin/main unhealed");
  const args = spawned[0]!.args;
  assert.equal(args[0], "207");
  assert.equal(args[args.indexOf(health.REVIEWER_INCIDENT_FLAG) + 1], "reviewer-regression-" + f.m2.slice(0, 12));
  assert.ok(args.includes("--judge-at-own-start") && args.includes("--execution-mode"));
  assert.ok(!args.includes(health.REVIEWER_SHADOW_FLAG));
});

test("W1-T10269: the healed reviewer follows origin/main and escalates a conflicting revert", async (t) => {
  health.resetHealedReviewerTrees();
  const { f, h } = await openTenTwenty(t);
  const { cut, remove } = cutter(f);
  const first = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.equal(first.state, "ready");
  const again = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.deepEqual(again, first, "the same origin/main reuses its healed tree");
  const m3 = pushMain(f, { "docs/other.md": "other\n" }, "docs: another page (#103)");
  const moved = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.equal(moved.state, "ready");
  if (moved.state !== "ready" || first.state !== "ready") return;
  assert.equal(moved.originMainSha, m3, "rebuilt when origin/main moves");
  assert.notEqual(moved.path, first.path);
  assert.equal(execFileSync("git", ["-C", moved.path, "rev-parse", "HEAD^1"], { encoding: "utf8" }).trim(), m3);
  // Today's code (m3) has no judgment yet: the route shadows it from a fresh origin/main tree; a healed
  // child that cannot run falls back to today's path.
  const shadowLogs: Array<{ step: string; extra: Row }> = [];
  const calls: Array<{ tree: string; args: string[] }> = [];
  let fellBack = 0;
  const shadowRoute = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath,
    (step, extra = {}) => shadowLogs.push({ step, extra }), freshTree(f, async (tree, args, onFailure) => {
      calls.push({ tree, args });
      if (args.includes(health.REVIEWER_SHADOW_FLAG)) { onFailure?.("shadow child died"); return 1; }
      throw new Error("spawn ENOENT");
    }), h.issues, h.lane);
  assert.equal(await shadowRoute("216", [], {}, async () => { fellBack++; return 7; }), 7);
  const shadow = calls.find((c) => c.args.includes(health.REVIEWER_SHADOW_FLAG))!;
  assert.equal(execFileSync("git", ["-C", shadow.tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), m3, "today's reviewer, at origin/main, in shadow");
  assert.deepEqual(shadowLogs.map((l) => l.step), ["reviewer.shadow_ran", "reviewer.healed_review_failed"]);
  assert.equal(shadowLogs[0]!.extra.failure, "shadow child died");
  assert.equal(fellBack, 1);
  assert.equal((await health.gitIn(f.daemon.dir)(["rev-parse", "origin/main"])).trim(), m3, "the default git is the hardened leaf");
  // A later merge rewrites the offending lines: the revert no longer applies.
  const m4 = pushMain(f, { "src/lib/required-semantic-review.ts": 'export const refusal = () => "something else";\n' }, "fix(review): reword (#104)");
  const conflict = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.equal(conflict.state, "conflict");
  if (conflict.state !== "conflict") return;
  assert.equal(conflict.originMainSha, m4);
  assert.deepEqual(conflict.paths, ["src/lib/required-semantic-review.ts"]);
  // Through the route: it escalates the conflict once and reviews on today's path — never an old head.
  const logs: string[] = [];
  let normal = 0;
  const before = h.calls.issues.length;
  const route = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath, (step) => logs.push(step),
    freshTree(f, async () => { throw new Error("no healed tree exists to spawn"); }), h.issues, h.lane);
  assert.equal(await route("207", [], {}, async () => { normal++; return 0; }), 0);
  assert.equal(await route("208", [], {}, async () => { normal++; return 0; }), 0);
  assert.equal(normal, 2);
  const filed = h.calls.issues.slice(before);
  assert.equal(filed.length, 1, "escalated once per incident and origin/main");
  assert.match(filed[0]!.body, /does not apply/);
  assert.match(filed[0]!.body, /src\/lib\/required-semantic-review\.ts/);
  assert.ok(logs.includes("reviewer.healed_tree_unavailable"));
  // When main itself reverts the offending merge, the healed patch is empty: the healed tree IS origin/main.
  f.work.git("revert", "--no-edit", m4);
  f.work.git("revert", "--no-edit", f.m2);
  f.work.git("push", "-q", "origin", "main");
  assert.equal((await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove)).state, "empty");
  assert.equal(await route("209", [], {}, async () => { normal++; return 0; }), 0);
  assert.ok(logs.includes("reviewer.healed_patch_empty"));
});

test("W1-T10269: the incident opens one revert PR of the offending merge", async (t) => {
  health.resetHealedReviewerTrees();
  const f = tenTwenty(t);
  const h = harness(t, async (args) => f.daemon.git(...args));
  h.queue.push(...baseline(f));
  await h.evaluate(f.c0);
  // The route reads the ledger itself: its rows go to the ledger file.
  const route = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath, () => {},
    freshTree(f, async () => 0), h.issues, h.lane);
  h.write(...onset(f));
  await route("210", [], {}, async () => 0);
  // More regressed rows, at the same sha and a later one, never open a second revert.
  const m2b = fake("m2b");
  h.write(withheld(f.m2, 211), withheld(m2b, 212), withheld(m2b, 213), refused(m2b, 214));
  await route("215", [], {}, async () => 0);
  assert.equal(h.calls.reverts.length, 1, "one revert PR, through the red-main repair lane");
  const request = h.calls.reverts[0]!;
  assert.equal(request.offendingSha, f.m2);
  assert.equal(request.offendingPr, 102);
  assert.equal(request.reason?.kind, "reviewer-regression");
  const body = mainRepairRevertBody(request);
  assert.match(body, new RegExp(`Reverts \`${f.m2}\` \\(#102\\)`));
  assert.match(body, /ended 6 of 6 code-PR reviews not posted/, "the body names the outcome-mix evidence");
  assert.match(body, /against 0 of 105/);
  assert.doesNotMatch(body, /failing check/, "not a red main's failing checks");
  assert.match(body, /Remudero-Task: main-repair-revert-/);
  assert.equal(reviewerRegressionRevertText(request)?.title, "revert(review): revert #102, the merge that regressed the reviewer");
  assert.equal(reviewerRegressionRevertText({ ...request, reason: { kind: "red-main" } }), undefined);
  const state = health.loadReviewerHealthState(h.statePath);
  assert.equal(state.incident?.revertPrUrl, `${REPO_URL}/900`);
  assert.ok(state.incident!.signature.includes("head-task-metadata-unavailable"));
  const rows = readFileSync(h.ledgerPath, "utf8");
  assert.match(rows, /"step":"reviewer\.regression_extended"/, "the later regressed sha joins the open incident");
  assert.match(rows, /"task_id":"REVIEWER-HEALTH"/);
});

test("W1-T10269: the incident closes when the current reviewer returns to baseline", async (t) => {
  const { f, h } = await openTenTwenty(t);
  const fixed = fake("fixed-main");
  // A few clean reviews at today's code are not yet evidence enough: the shadow keeps measuring.
  h.queue.push(posted(fixed, 300), posted(fixed, 301), posted(fixed, 302));
  const early = await h.evaluate(fixed);
  assert.equal(early.route, "healed");
  assert.equal(early.route === "healed" && early.shadow, true, "today's reviewer has no judgment yet: it runs in shadow");
  assert.equal(h.steps("reviewer.regression_closed").length, 0);
  // Shadow reviews at today's code count as its outcomes.
  for (let i = 0; i < 30; i++) h.queue.push({ ...posted(fixed, 303 + i), step: "shadow.review.shadow_verdict" });
  const decision = await h.evaluate(fixed);
  const closed = h.steps("reviewer.regression_closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.extra.current_reviewer_code_sha, fixed);
  assert.equal(closed[0]!.extra.revert_pr_state, "open");
  assert.equal(decision.route, "normal", "routing returns to the normal path");
  assert.deepEqual(h.calls.closedIssues, ["https://github.com/acme/remudero/issues/1"]);
  assert.equal(h.calls.closedPrs.length, 1, "the revert PR a fix made unnecessary is closed");
  assert.match(h.calls.closedPrs[0]!.comment, /A fix made this revert unnecessary/);
  const state = health.loadReviewerHealthState(h.statePath);
  assert.equal(state.incident, null);
  assert.equal(state.closed.length, 1);
  // The same failure mode recurring reopens THAT incident, with its blame, instead of blaming a later merge.
  const later = fake("later-main");
  h.queue.push(refused(later, 400), refused(later, 401));
  await h.evaluate(later);
  const reopened = health.loadReviewerHealthState(h.statePath).incident!;
  assert.equal(reopened.reopenedFrom, "reviewer-regression-" + f.m2.slice(0, 12));
  assert.equal(reopened.offending?.sha, f.m2);
  assert.equal(h.steps("reviewer.regression_opened").at(-1)!.extra.reopened_from, reopened.reopenedFrom);
});

test("W1-T10269: rows classify by step, shadow and attribution; legacy rows attribute to their tree or boot head", () => {
  const state = health.emptyReviewerHealthState();
  const a = fake("a"), b = fake("b"), tree = fake("tree"), boot2 = fake("boot2");
  const skipped = [
    { ...posted(a, 1), plan_only: true }, { ...posted(a, 2), review_reused: true }, { ...posted(a, 3), status_confirmed: true },
    { ...posted(a, 4), pr_url: undefined }, { step: "review.reviewer.skipped", reason: "plan-only" }, { step: "worker.done" },
    { step: "daemon.boot", head_sha: "not-a-sha" }, { step: "review.ran_from_fresh_tree", pr: "5" },
    { step: "review.posted", ...unit(9), reviewer_code_sha: a, plan_only: false, review_discriminated: true },
    { step: "review.posted", ...unit(10), reviewer_code_sha: a, status_recovered: true },
  ];
  for (const row of skipped) assert.equal(health.classifyReviewerHealthRow(row), undefined, JSON.stringify(row));
  assert.deepEqual(health.classifyReviewerHealthRow({ step: "shadow.review.semantic_setup_refused", reason: "x", ...unit(11), reviewer_code_sha: a })?.kind, "outcome");
  const viaProvenance = health.classifyReviewerHealthRow({ step: "review.posted", ...unit(12), reviewer_code_provenance: { codeSha: b } });
  assert.equal(viaProvenance?.kind === "outcome" && viaProvenance.sha, b);
  health.ingestReviewerHealthRows(state, [
    boot(a, "h1"),
    withheld(undefined, 20, "success", "h1"),
    { ts: tick(), host: "h1", step: "review.ran_from_fresh_tree", pr: "20", origin_main_sha: tree },
    withheld(undefined, 21, "success", "h1"),
    withheld(undefined, 22, "spawn_error", "h1"),
    boot(boot2, "h1"),
    withheld(undefined, 23, "success", "h2"),
    boot(a, "h2"),
    posted(a, 24), posted(a, 24), withheld(a, 24),
    { ...posted(b, 25), incident_id: "reviewer-regression-x" },
  ]);
  assert.deepEqual(state.shas[tree]!.units, { [`${REPO_URL}/20#${fake("head-20")}`]: "withheld-success" }, "claimed by its fresh-tree row");
  assert.equal(state.shas[a]!.units[`${REPO_URL}/21#${fake("head-21")}`], "withheld-success", "unclaimed: the boot head before the next boot");
  assert.equal(state.shas[a]!.units[`${REPO_URL}/22#${fake("head-22")}`], "withheld-failure");
  assert.equal(state.shas[a]!.units[`${REPO_URL}/24#${fake("head-24")}`], "posted", "a unit that posted stays posted");
  assert.equal(state.coverage.unattributed, 1, "host h2 had no prior boot");
  assert.deepEqual(health.shaCounts(state.shas[a]!), { k: 1, n: 2 }, "withheld after a reviewer failure is provider health, in neither");
  assert.equal(state.shas[b]!.healed, true);
  assert.equal(state.bootHeads.h1, boot2);
});

test("W1-T10269: the per-sha backstop pools the oldest shas into the baseline", () => {
  const state = health.emptyReviewerHealthState();
  const rows: Row[] = [];
  for (let i = 0; i < health.MAX_TRACKED_REVIEWER_SHAS + 3; i++) rows.push(i === 0 ? withheld(fake(`pool-${i}`), i) : posted(fake(`pool-${i}`), i));
  health.ingestReviewerHealthRows(state, rows);
  assert.equal(Object.keys(state.shas).length, health.MAX_TRACKED_REVIEWER_SHAS);
  assert.deepEqual(state.pooled, { k: 1, n: 3, shas: 3 });
  const newest = fake(`pool-${health.MAX_TRACKED_REVIEWER_SHAS + 2}`);
  assert.equal(health.judgeReviewerSha(state, newest).baseline.n, health.MAX_TRACKED_REVIEWER_SHAS + 2);
});

test("W1-T10269: the seed replays history with effects off and raises only a regression judging today", async (t) => {
  const f = tenTwenty(t);
  const carried = harness(t, async (args) => f.daemon.git(...args));
  carried.queue.push(...baseline(f), ...onset(f));
  const decision = await carried.evaluate(fake("today"));
  assert.equal(decision.route, "normal");
  assert.equal(carried.calls.issues.length, 0, "history's incident raises nothing today");
  assert.equal(carried.steps("reviewer.regression_carried").length, 1);
  const state = health.loadReviewerHealthState(carried.statePath);
  assert.equal(state.closed.length, 1, "carried as closed, for a recurrence to reopen");
  assert.equal(state.closed[0]!.offending?.sha, f.m2);
  const raised = harness(t, async (args) => f.daemon.git(...args));
  raised.queue.push(...baseline(f), ...onset(f));
  const live = await raised.evaluate(f.m2);
  assert.equal(live.route, "healed");
  assert.equal(raised.calls.issues.length, 1, "today's reviewer is the regressed one: raised once");
  assert.equal(raised.steps("reviewer.regression_opened")[0]!.extra.from_seed, true);
  assert.equal(raised.steps("reviewer.health_seeded").length, 1);
});

test("W1-T10269: an incident without a healthy ancestor or a review-material merge escalates and reviews normally", async (t) => {
  const f = tenTwenty(t);
  // No healthy sha precedes the regression in git: the baseline shas are not on main.
  const lone = harness(t, async (args) => f.daemon.git(...args));
  lone.queue.push(...Array.from({ length: 200 }, (_, i) => posted(fake(`lone-${i % 40}`), i + 1)));
  await lone.evaluate(null);
  lone.queue.push(...onset(f));
  const decision = await lone.evaluate(f.m2);
  assert.equal(decision.route, "normal");
  assert.match(decision.reason, /names no offending merge/);
  assert.match(health.loadReviewerHealthState(lone.statePath).incident!.offendingUnavailable!, /no healthy reviewer code sha/);
  assert.equal(lone.calls.reverts.length, 0);
  assert.equal(lone.calls.issues.length, 1, "still raised as an issue");
  // Merge history unreadable.
  const blind = harness(t, async (args) => {
    if (args[0] === "rev-list") throw new Error("git gone");
    return f.daemon.git(...args);
  });
  blind.queue.push(...baseline(f));
  await blind.evaluate(null);
  blind.queue.push(...onset(f));
  await blind.evaluate(f.m2);
  assert.match(health.loadReviewerHealthState(blind.statePath).incident!.offendingUnavailable!, /merge history unreadable: git gone/);
  // Nothing review-material in range.
  assert.equal(await health.findOffendingMerge(async (args) => f.daemon.git(...args), f.c0, f.m1), undefined);
  const none = harness(t, async (args) => (args[0] === "rev-list" ? "" : f.daemon.git(...args)));
  none.queue.push(...baseline(f));
  await none.evaluate(null);
  none.queue.push(...onset(f));
  await none.evaluate(f.m2);
  assert.match(health.loadReviewerHealthState(none.statePath).incident!.offendingUnavailable!, /no review-material merge/);
});

test("W1-T10269: a failing effect is ledgered and never blocks the incident", async (t) => {
  const refusedRevert = await openTenTwenty(t, {
    create: async () => { throw new Error("issues down"); },
    openRevertPr: async () => ({ refused: "git revert did not apply", conflictPaths: ["src/lib/review.ts"] }),
  });
  const escalationRows = readFileSync(refusedRevert.h.ledgerPath, "utf8");
  assert.match(escalationRows, /"step":"escalation\.failed"/, "the escalation's own failure row");
  assert.equal(health.loadReviewerHealthState(refusedRevert.h.statePath).incident?.issueUrl, null);
  const refusal = refusedRevert.h.steps("main-repair.revert_refused");
  assert.equal(refusal.length, 1);
  assert.deepEqual(refusal[0]!.extra.conflict_paths, ["src/lib/review.ts"]);
  const thrown = await openTenTwenty(t, { openRevertPr: async () => { throw new Error("push refused"); } });
  assert.equal(thrown.h.steps("main-repair.revert_refused")[0]!.extra.reason, "push refused");
  const state = health.loadReviewerHealthState(thrown.h.statePath);
  assert.equal(state.incident?.revertRefused?.reason, "push refused");
  // Close-side failures: an unreadable revert PR is left open; failed closes are ledgered.
  const fixed = fake("fixed-close");
  const closing = await openTenTwenty(t, {
    readPr: async () => { throw new Error("unreadable"); },
    closeWithComment: async () => { throw new Error("close failed"); },
  });
  closing.h.queue.push(...Array.from({ length: 40 }, (_, i) => posted(fixed, 700 + i)));
  await closing.h.evaluate(fixed);
  assert.equal(closing.h.steps("reviewer.regression_closed")[0]!.extra.revert_pr_state, "unread");
  assert.equal(closing.h.calls.closedPrs.length, 0, "never closed blind");
  assert.equal(closing.h.steps("reviewer.regression_issue_close_failed").length, 1);
  const prFails = await openTenTwenty(t, { closePr: async () => { throw new Error("pr close failed"); } });
  prFails.h.queue.push(...Array.from({ length: 40 }, (_, i) => posted(fixed, 800 + i)));
  await prFails.h.evaluate(fixed);
  assert.equal(prFails.h.steps("reviewer.regression_revert_close_failed").length, 1);
  // A lane that cannot read or close a PR leaves the revert PR to its reviewers.
  const blindLane = await openTenTwenty(t);
  delete (blindLane.h.lane as { readPr?: unknown }).readPr;
  blindLane.h.queue.push(...Array.from({ length: 40 }, (_, i) => posted(fixed, 900 + i)));
  await blindLane.h.evaluate(fixed);
  assert.equal(blindLane.h.steps("reviewer.regression_closed")[0]!.extra.revert_pr_state, "unread");
});

test("W1-T10269: the ledger reader streams the union once, then only what is new", async (t) => {
  const stateDir = scratch(t, "ledger");
  const line = (row: Row) => `${JSON.stringify(row)}\n`;
  const a = fake("reader-a");
  writeFileSync(join(stateDir, "ledger.2026-10-19T00-00-00-000Z.ndjson.gz"), gzipSync(line(posted(a, 1)) + line({ step: "worker.done" })));
  writeFileSync(join(stateDir, "ledger.ndjson"), line(posted(a, 2)) + '{"step":"review.posted","torn');
  const seed = await health.readReviewerHealthRows(stateDir, null);
  assert.deepEqual(seed.rows.map((r) => r.pr_url), [`${REPO_URL}/1`, `${REPO_URL}/2`], "the torn tail is left for the next read");
  assert.equal(seed.cursor.afterRotation, "ledger.2026-10-19T00-00-00-000Z.ndjson.gz");
  const idle = await health.readReviewerHealthRows(stateDir, seed.cursor);
  assert.deepEqual(idle.rows, []);
  writeFileSync(join(stateDir, "ledger.ndjson"), line(posted(a, 2)) + line(posted(a, 3)));
  const next = await health.readReviewerHealthRows(stateDir, seed.cursor);
  assert.deepEqual(next.rows.map((r) => r.pr_url), [`${REPO_URL}/3`]);
  // A rotation: the new archive is read whole, the replaced live file from its start.
  writeFileSync(join(stateDir, "ledger.2026-10-20T00-00-00-000Z.ndjson.gz"), gzipSync(line(posted(a, 2)) + line(posted(a, 3))));
  writeFileSync(join(stateDir, "ledger.ndjson.next"), line(posted(a, 4)));
  execFileSync("mv", [join(stateDir, "ledger.ndjson.next"), join(stateDir, "ledger.ndjson")]);
  const rotated = await health.readReviewerHealthRows(stateDir, next.cursor);
  assert.deepEqual(rotated.rows.map((r) => r.pr_url), [`${REPO_URL}/2`, `${REPO_URL}/3`, `${REPO_URL}/4`]);
  const empty = await health.readReviewerHealthRows(join(stateDir, "absent"), null);
  assert.deepEqual(empty, { rows: [], cursor: { liveOffset: 0 } });
});

test("W1-T10269: evaluation seeds in the background, serializes, and degrades to the normal route", async (t) => {
  const h = harness(t, async () => "");
  const logs: string[] = [];
  let reads = 0;
  const readRows = async () => { reads++; return { rows: [posted(fake("serial"), reads)], cursor: { liveOffset: reads } }; };
  const log = (step: string) => { logs.push(step); };
  const run = (statePath: string, read: typeof readRows) =>
    health.evaluateReviewerHealth({ originMainSha: null }, statePath, read, async () => "", h.escalation, h.lane, log, h.clockPort);
  const first = await run(h.statePath, readRows);
  assert.match(first.route === "normal" ? first.reason : "", /seeding/);
  const during = await run(h.statePath, readRows);
  assert.match(during.route === "normal" ? during.reason : "", /seeding/);
  await health.settleReviewerHealthSeed(h.statePath);
  assert.ok(logs.includes("reviewer.health_seeded"));
  const both = await Promise.all([run(h.statePath, readRows), run(h.statePath, readRows)]);
  assert.deepEqual(both.map((d) => d.route), ["normal", "normal"]);
  assert.equal(reads, 3);
  assert.equal(health.loadReviewerHealthState(h.statePath).cursor?.liveOffset, 3);
  const broken = async (): Promise<never> => { throw new Error("ledger unreadable"); };
  const degraded = await run(h.statePath, broken);
  assert.match(degraded.route === "normal" ? degraded.reason : "", /reviewer health unavailable: ledger unreadable/);
  const otherPath = join(scratch(t, "serial-other"), "reviewer-health.json");
  await run(otherPath, broken);
  await health.settleReviewerHealthSeed(otherPath);
  assert.equal(logs.filter((step) => step === "reviewer.health_unavailable").length, 2);
  // A torn or older state file re-seeds rather than judging on counts it cannot trust.
  writeFileSync(h.statePath, "{torn");
  assert.equal(health.loadReviewerHealthState(h.statePath).cursor, null);
  writeFileSync(h.statePath, JSON.stringify({ version: "reviewer-health-v0" }));
  assert.equal(health.loadReviewerHealthState(h.statePath).seq, 0);
});

test("W1-T10269: the operator's fix-PR choice is recorded, and the healed tree merges it", async (t) => {
  health.resetHealedReviewerTrees();
  const { f, h } = await openTenTwenty(t);
  const out: string[] = [];
  const at = { iso: () => "2026-10-21T00:00:00.000Z" };
  const heal = (rest: string[]) => health.reviewerHealCommand(rest, h.statePath, at, (l) => out.push(l), (l) => out.push(l));
  assert.equal(heal(["--with-pr"]), 2);
  assert.equal(heal(["--with-pr", "77"]), 0);
  assert.deepEqual(health.loadReviewerHealthState(h.statePath).operatorHeal, { withPr: 77, at: "2026-10-21T00:00:00.000Z" });
  assert.match(out.at(-1)!, /merges PR #77 on origin\/main for reviewer-regression-/);
  // PR 77's head: a fix on top of main.
  f.work.git("checkout", "-q", "-b", "fix");
  const fix = commitFile(f.work, { "src/lib/required-semantic-review.ts": "export const refusal = () => undefined; // fixed\n" }, "fix: heal");
  f.work.git("push", "-q", "origin", `${fix}:refs/pull/77/head`);
  f.work.git("checkout", "-q", "main");
  const { cut, remove } = cutter(f);
  const healed = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove, { withPr: 77 });
  assert.equal(healed.state, "ready");
  if (healed.state !== "ready") return;
  assert.equal(healed.patch, "with-pr");
  assert.equal(execFileSync("git", ["-C", healed.path, "rev-parse", "HEAD^1"], { encoding: "utf8" }).trim(), f.m2);
  // The route never lets PR 77's own tree review PR 77.
  const spawned: string[] = [];
  const route = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath, () => {},
    freshTree(f, async (tree) => { spawned.push(tree); return 0; }), h.issues, h.lane);
  await route("77", [], {}, async () => 1);
  await route("78", [], {}, async () => 1);
  const parents = spawned.map((tree) => execFileSync("git", ["-C", tree, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim());
  assert.match(parents[0]!, /^Revert /, "PR 77 is judged by the revert-built tree");
  assert.match(parents[1]!, /^Merge /, "other PRs by the operator's fix-PR tree");
  // A fix PR that does not merge cleanly is a conflict, never an older tree.
  const clash = commitFile(f.work, { "src/lib/required-semantic-review.ts": "clash\n" }, "clash");
  f.work.git("push", "-q", "origin", `${clash}:refs/pull/79/head`);
  f.work.git("reset", "-q", "--hard", "HEAD^");
  pushMain(f, { "src/lib/required-semantic-review.ts": "main moved\n" }, "main moves (#105)");
  assert.equal((await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove, { withPr: 79 })).state, "conflict");
  assert.equal(heal(["--clear"]), 0);
  assert.equal(health.loadReviewerHealthState(h.statePath).operatorHeal, null);
});

test("W1-T10269: the route's default issue gateway assigns, and its default lane reads and closes over REST", async (t) => {
  const shim = ghShim([
    { when: "issue create", stdout: "https://github.com/acme/remudero/issues/41\n" },
    { when: "issues/42 --repo", stderr: "assign refused", exit: 1 },
    { when: "pulls/900", stdout: JSON.stringify({ state: "open", merged: false }) },
    { when: "pulls/901", stdout: JSON.stringify({ state: "closed", merged: true }) },
    { when: "api ", stdout: "{}" },
  ], { kind: "reviewer-heal-effects" });
  const saved = { PATH: process.env.PATH, allow: process.env.RMD_ALLOW_LIVE_WRITES };
  process.env.PATH = `${shim.dir}:${saved.PATH}`;
  process.env.RMD_ALLOW_LIVE_WRITES = "1"; // only the shim answers: no request leaves this machine
  t.after(() => {
    process.env.PATH = saved.PATH;
    if (saved.allow === undefined) delete process.env.RMD_ALLOW_LIVE_WRITES; else process.env.RMD_ALLOW_LIVE_WRITES = saved.allow;
    execFileSync("rm", ["-rf", shim.dir]);
  });
  const logs: string[] = [];
  const gateway = assigningIssueGateway("acme", "remudero", (step) => logs.push(step));
  assert.equal(await gateway.create("t", "b", []), "https://github.com/acme/remudero/issues/41");
  const failing = assigningIssueGateway("acme", "remudero", (step) => logs.push(step),
    { create: async () => "https://github.com/acme/remudero/issues/42" });
  assert.equal(await failing.create("t", "b", []), "https://github.com/acme/remudero/issues/42", "an unassigned issue still stands");
  assert.deepEqual(logs, ["reviewer.regression_assign_failed"]);
  const lane = reviewerRevertLane("acme", "remudero", { root: scratch(t, "lane") } as Config, join(scratch(t, "lane-ledger"), "ledger.ndjson"), "run");
  assert.deepEqual(await lane.readPr!(`${REPO_URL}/900`), { state: "open" });
  assert.deepEqual(await lane.readPr!(`${REPO_URL}/901`), { state: "merged" });
  await lane.closePr!(`${REPO_URL}/900`, "a fix made this revert unnecessary");
  const calls = shim.calls().join("\n");
  assert.match(calls, /issue edit https:\/\/github.com\/acme\/remudero\/issues\/41 --repo acme\/remudero --add-assignee acme/, "assigned");
  assert.match(calls, /--method POST repos\/acme\/remudero\/issues\/900\/comments/);
  assert.match(calls, /--method PATCH repos\/acme\/remudero\/pulls\/900/);
  // Built with no gateway or lane, the route takes those two defaults for this repo.
  const f = tenTwenty(t);
  assert.equal(typeof buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, join(f.root, "ledger.ndjson"), () => {},
    freshTree(f, async () => 0)), "function");
});

test("W1-T10269: the healed tree builder refuses rather than falls back", async (t) => {
  health.resetHealedReviewerTrees();
  const f = tenTwenty(t);
  const { cut, remove } = cutter(f);
  const noOrigin = await health.buildHealedReviewerTree(scratch(t, "not-a-repo"), f.m2, cut, remove);
  assert.equal(noOrigin.state, "unavailable");
  assert.match(noOrigin.state === "unavailable" ? noOrigin.reason : "", /^origin\/main unreadable/);
  const offMain = await health.buildHealedReviewerTree(f.daemon.dir, fake("not-on-main"), cut, remove);
  assert.equal(offMain.state, "unavailable");
  const uncut = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, () => { throw new Error("no worktree"); }, remove);
  assert.match(uncut.state === "unavailable" ? uncut.reason : "", /could not be cut: no worktree/);
  // A cached tree someone dirtied is removed and rebuilt, not reused.
  const first = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.equal(first.state, "ready");
  if (first.state !== "ready") return;
  writeFileSync(join(first.path, "src/lib/review.ts"), "dirty\n");
  const rebuilt = await health.buildHealedReviewerTree(f.daemon.dir, f.m2, cut, remove);
  assert.ok(rebuilt.state === "ready" && rebuilt.path !== first.path);
  assert.equal(existsSync(first.path), false, "the dirtied tree is gone");
  // The route's cut: a tree an earlier process left at the healed path is removed and cut again; a
  // tree that cannot be added at all is refused.
  const { h } = await openTenTwenty(t);
  void h;
  const merge = await (async () => {
    // A merge commit reverts against its first parent.
    f.work.git("checkout", "-q", "-b", "side");
    commitFile(f.work, { "src/lib/review.ts": "side\n" }, "side change");
    f.work.git("checkout", "-q", "main");
    f.work.git("merge", "-q", "--no-ff", "-m", "Merge pull request #106 from acme/side", "side");
    f.work.git("push", "-q", "origin", "main");
    f.daemon.git("fetch", "-q", "origin", "main");
    return f.work.git("rev-parse", "HEAD");
  })();
  assert.equal((await health.findOffendingMerge(async (args) => f.daemon.git(...args), f.m2, merge))?.pr, 106);
  const healedMerge = await health.buildHealedReviewerTree(f.daemon.dir, merge, cut, remove);
  assert.equal(healedMerge.state, "ready");
});

test("W1-T10269: the route's healed tree survives a restart and refuses a tree it cannot add", async (t) => {
  health.resetHealedReviewerTrees();
  const { f, h } = await openTenTwenty(t);
  const spawned: string[] = [];
  const tree = freshTree(f, async (path) => { spawned.push(path); return 0; });
  const route = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath, () => {}, tree, h.issues, h.lane);
  await route("230", [], {}, async () => 1);
  health.resetHealedReviewerTrees(); // a new process: the healed path is on disk, its memo is not
  await route("231", [], {}, async () => 1);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0], spawned[1], "the same healed path, removed and cut again");
  assert.equal(execFileSync("git", ["-C", spawned[1]!, "rev-parse", "HEAD^1"], { encoding: "utf8" }).trim(), f.m2);
  health.resetHealedReviewerTrees();
  const logs: Array<{ step: string; extra: Row }> = [];
  let normal = 0;
  const refusing = buildReviewerHealthRoute(f.daemon.dir, { root: f.root } as Config, h.ledgerPath, (step, extra = {}) => logs.push({ step, extra }),
    freshTree(f, async () => 0, { worktreeRoot: join(f.root, "fresh-root"), addWorktree: () => { throw new Error("worktree add refused"); } }), h.issues, h.lane);
  assert.equal(await refusing("232", [], {}, async () => ++normal), 1);
  assert.equal(logs[0]!.step, "reviewer.healed_tree_unavailable");
  assert.match(String(logs[0]!.extra.reason), /worktree add refused/);
});

test("W1-T10269: blame reads run-task.ts's review path and the modules it imports", async (t) => {
  const repo = gitRepo({ kind: "reviewer-heal-blame" });
  void t;
  const runTask = (extra: string) => [
    importLine("helper", "lib/helper.js"),
    importLine("other", "lib/other.js"),
    "export async function runReview() { return helper(); }",
    "export async function reviewCommand() { return runReview(); }",
    "export function buildFreshTreeReviewRunner() { return 1; }",
    "export function spawnRmdReviewForFreshTree() { return 2; }",
    `export function unrelated() { return other() + ${extra}; }`,
    "",
  ].join("\n");
  const base = commitFile(repo, { "src/run-task.ts": runTask("1"), "src/lib/helper.ts": "export const helper = () => 1;\n",
    "src/lib/other.ts": "export const other = () => 1;\n" }, "base (#1)");
  commitFile(repo, { "src/run-task.ts": runTask("2") }, "an unrelated run-task hunk (#2)");
  commitFile(repo, { "src/lib/other.ts": "export const other = () => 2;\n" }, "a module only unrelated code imports (#3)");
  const helperChange = commitFile(repo, { "src/lib/helper.ts": "export const helper = () => 2;\n" }, "the review path's helper (#4)");
  const git: health.GitText = async (args) => repo.git(...args);
  assert.deepEqual(await health.reviewPathImportedModules(git, helperChange), ["src/lib/helper.ts"]);
  const blamed = await health.findOffendingMerge(git, base, helperChange);
  assert.equal(blamed?.pr, 4, "the first review-material commit, past an unrelated run-task hunk and module");
  const reviewHunk = commitFile(repo, { "src/run-task.ts": runTask("2").replace("return helper();", "return helper() + 1;") }, "a review-path hunk (#5)");
  const viaRunTask = await health.findOffendingMerge(git, helperChange, reviewHunk);
  assert.match(viaRunTask?.reason ?? "", /^src\/run-task\.ts: hunk /);
});

test("W1-T10269: terminal rows carry the judging code's sha; a shadow review is renamed and publishes nothing", async (t) => {
  health.resetLoadedReviewerCodeSha();
  const own = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO_ROOT }).trim();
  assert.equal(health.loadedReviewerCodeSha(), own, "the HEAD this module was loaded from");
  health.resetLoadedReviewerCodeSha();
  assert.equal(health.loadedReviewerCodeSha(() => { throw new Error("no git"); }), null);
  health.resetLoadedReviewerCodeSha();
  assert.equal(health.loadedReviewerCodeSha(() => "not-a-sha"), null);
  health.resetLoadedReviewerCodeSha();
  const sha = fake("loaded");
  assert.deepEqual(health.reviewerHealthRowFields("review.posted", "inc-1", () => sha), { reviewer_code_sha: sha, incident_id: "inc-1" });
  assert.deepEqual(health.reviewerHealthRowFields("review.semantic_setup_refused", undefined, () => null), {});
  assert.deepEqual(health.reviewerHealthRowFields("review.pending_posted", undefined, () => sha), {});
  assert.equal(health.reviewerShadowStep("review.posted", true), "shadow.review.posted");
  assert.equal(health.reviewerShadowStep("review.posted", false), "review.posted");
  // reviewCommand in shadow: no pending post, no admission, rows renamed with the code sha, exit at the verdict.
  const root = scratch(t, "shadow-command");
  const head = fake("shadow-head");
  let pending = 0, admissions = 0;
  let shadowArg: unknown;
  const code = await reviewCommand("8", ["--repo", "acme/remudero", health.REVIEWER_SHADOW_FLAG], {
    resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }), enforceReviewSubjectCheckout: false,
    loadConfig: () => ({ root, installRoot: REPO_ROOT }) as Config,
    fetchView: () => ({ number: 8, html_url: `${REPO_URL}/8`, state: "open", body: "## Acceptance\n- x — grep: x in y\n", head: { sha: head, ref: "b" } }),
    fetchHead: () => {}, postReviewPending: async () => { pending++; return { posted: false }; },
    contributorAdmission: async () => { admissions++; },
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }) as never,
    runReview: (async (args: { shadow?: boolean; log: (s: string, e?: Row) => void }) => {
      shadowArg = args.shadow;
      args.log("review.semantic_incomplete", { reason: "required-semantic-incomplete-verdicts", reviewer_outcome: "success", head_sha: head, pr_url: `${REPO_URL}/8` });
      return { state: "failure", headSha: head, criteria: [], verdictWithheld: "required-semantic-incomplete-verdicts" };
    }) as never,
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
  } as never);
  assert.equal(code, 2);
  assert.equal(shadowArg, true);
  assert.equal(pending, 0, "a shadow posts no pending status");
  assert.equal(admissions, 0);
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
  const incomplete = rows.find((r) => String(r.step).endsWith("review.semantic_incomplete"))!;
  assert.equal(incomplete.step, "shadow.review.semantic_incomplete", "no other reader can take it for a real withhold");
  assert.equal(incomplete.reviewer_code_sha, own);
  assert.ok(!rows.some((r) => r.step === "review.semantic_incomplete" || r.step === "review.posted"));
  const ok = await reviewCommand("8", ["--repo", "acme/remudero", health.REVIEWER_SHADOW_FLAG], {
    resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }), enforceReviewSubjectCheckout: false,
    loadConfig: () => ({ root, installRoot: REPO_ROOT }) as Config,
    fetchView: () => ({ number: 8, html_url: `${REPO_URL}/8`, state: "open", body: "", head: { sha: head, ref: "b" } }),
    fetchHead: () => {}, postReviewPending: async () => ({ posted: false }), contributorAdmission: async () => {},
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }) as never,
    runReview: (async () => ({ state: "success", headSha: head, criteria: [], decisionDisposition: "replayed" })) as never,
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
  } as never);
  assert.equal(ok, 0, "a replayed decision ends the shadow too: nothing restored");
});

test("W1-T10269: the loaded code sha is read from git's files, every layout, with no spawn", (t) => {
  const repo = gitRepo({ kind: "reviewer-heal-head" });
  const head = repo.git("rev-parse", "HEAD");
  assert.equal(health.checkoutHeadSha(repo.dir), head, "a branch: its loose ref");
  repo.git("pack-refs", "--all");
  assert.equal(health.checkoutHeadSha(repo.dir), head, "a packed ref");
  const tree = repo.addWorktree(join(scratch(t, "wt"), "tree"), "side");
  assert.equal(health.checkoutHeadSha(tree.dir), head, "a worktree: its gitdir pointer and the common dir");
  repo.git("checkout", "-q", "--detach");
  assert.equal(health.checkoutHeadSha(repo.dir), head, "a detached head");
  const broken = scratch(t, "broken");
  writeFileSync(join(broken, ".git"), "not a pointer\n");
  assert.throws(() => health.checkoutHeadSha(broken), /names no gitdir/);
  mkdirSync(join(broken, "gd"));
  writeFileSync(join(broken, ".git"), "gitdir: gd\n");
  writeFileSync(join(broken, "gd", "HEAD"), "garbage\n");
  assert.throws(() => health.checkoutHeadSha(broken), /neither a sha nor a ref/);
  writeFileSync(join(broken, "gd", "HEAD"), "ref: refs/heads/gone\n");
  assert.throws(() => health.checkoutHeadSha(broken), /refs\/heads\/gone is not resolvable/);
  const looped = scratch(t, "looped");
  symlinkSync(join(looped, ".git"), join(looped, ".git"));
  assert.throws(() => health.checkoutHeadSha(looped), /ELOOP/, "an unreadable file is not an absence");
});

test("W1-T10269: the ledger reader refuses an unreadable ledger rather than reading it as empty", async (t) => {
  const notADir = join(scratch(t, "notdir"), "file");
  writeFileSync(notADir, "x");
  await assert.rejects(health.readReviewerHealthRows(notADir, null), /ENOTDIR/);
  const stateDir = scratch(t, "unreadable");
  symlinkSync(join(stateDir, "ledger.ndjson"), join(stateDir, "ledger.ndjson"));
  await assert.rejects(health.readReviewerHealthRows(stateDir, null), /ELOOP/);
});

test("W1-T10269: runReview in shadow judges and stops before any arm or status", async (t) => {
  const repo = gitRepo({ kind: "reviewer-heal-shadow-run" });
  writeFileSync(join(repo.dir, "changed.ts"), "export const changed = true;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture");
  const headSha = repo.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const diff = "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n";
  const shim = ghShim([
    { when: "pulls/", stdout: JSON.stringify({ number: 1, html_url: prUrl, updated_at: "t", body: "changed", state: "open", head: { ref: "b", sha: headSha } }) },
    { when: "pr diff", stdout: diff },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "reviewer-heal-shadow" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; execFileSync("rm", ["-rf", shim.dir]); });
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  const steps: string[] = [];
  let armed = 0, disarmed = 0;
  const result = await runReview({
    owner: "acme", repo: "remudero", prUrl, shadow: true,
    task: { id: "W1-T10269", files: ["changed.ts"], acceptance: [{ claim: "changed exists", proof: "grep: changed in changed.ts" }] },
    report: "changed", settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir, claudeBin: "/unused" } as never,
    log: (step: string) => { steps.push(step); }, say: () => {}, account: (worker: unknown) => worker,
    spawnReviewer: false, headCheckoutDir: repo.dir, ledgerPath, runId: "shadow-run",
    disarm: () => { disarmed++; return "not-armed" as const; }, arm: () => { armed++; return { armed: false, reason: "test" }; },
  } as never);
  assert.equal(result.verdictWithheld, "reviewer-health shadow: no publication");
  assert.ok(steps.includes(health.REVIEWER_SHADOW_VERDICT_STEP));
  assert.ok(!steps.includes("review.posted") && !steps.includes("review.pending_posted"));
  assert.equal(armed + disarmed, 0);
  assert.ok(!existsSync(ledgerPath) || !readFileSync(ledgerPath, "utf8").includes('"step":"review.posted"'));
});
