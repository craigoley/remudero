/**
 * W1-T14195: the mover's REMOVE pull request carries no `Remudero-Task:` line and no `## Acceptance` block on purpose
 * (W1-T13680), so the author-time gate refused it `no-header` and the review posted "no acceptance criteria to judge"
 * (public #20072). One receipt the review can verify against the ops record now admits exactly that shape; every other
 * plan-move or criteria-less pull request still fails closed. Every case below drives the real mover over two real Git
 * origins (test/helpers/plan-move-world.ts) and reads the pull request back through the gate's and the review's own
 * readers, so the receipt pattern in review.ts cannot drift from the one plan-task-move.ts writes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { Config } from "#src/lib/config.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { MOVE_BRANCH_PREFIX, MOVED_TO_TRAILER } from "#src/lib/plan-task-move.js";
import type { MoverOpsRead, MoverRemovalVerdict } from "#src/lib/review.js";
import type { ReviewCommandDeps, ReviewCommandHost } from "#src/cli/commands/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { blobAt, moveWorld, OPS, record, shard, type MoveWorld, type ModelPull } from "#test/helpers/plan-move-world.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Dynamic imports keep the named bindings typed while letting this suite load, and fail test by test, on a tree that
// lacks them (origin/main), so its red there is the missing admission and not an import error.
const {
  MOVER_BRANCH_PREFIX, MOVER_RECEIPT_PREFIX, judgeReview, movedFromCommit, moverRemovalOpsRefusal, parseMoverReceipts,
  verifyMoverRemoval, verifyMoverRemovalPublic,
} = await import("#src/lib/review.js");
const { readMoverRemoval, reviewCommand, runReview } = await import("#src/cli/commands/review.js");

function unexpectedReviewDependency(): never { throw new Error("unexpected review fixture dependency"); }
const REVIEW_HOST: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: unexpectedReviewDependency,
  ledgeredNonDispatchSpawn: unexpectedReviewDependency,
  lintPlanForReview: unexpectedReviewDependency,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpectedReviewDependency,
  readHeadShaRest: unexpectedReviewDependency,
  readMainPlanTreeSha: unexpectedReviewDependency,
  realDeps: () => ({ reviewWorktree: { fetch: unexpectedReviewDependency } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: unexpectedReviewDependency,
  reviewSubjectGit: unexpectedReviewDependency,
};

const LINT = { ran: true as const, label: "fixture", checked: 0, violations: [] };
const ID = "W1-T1";
const ORIGINAL = record(ID, "  files: [src/lib/moved.ts]\n");
const GATE = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs")).href)) as {
  evaluateGate: (input: Record<string, unknown>) => { ok: boolean; defect?: string; message: string };
  moverPublicAtRange: (input: { baseSha?: string; headSha?: string; root?: string; git?: (args: string[]) => string }) =>
    { message: string; entries: { status: string; path: string }[] | undefined; baseBlobAt: (path: string) => string | undefined } | undefined;
  main: (argv: string[], opts?: { root?: string }) => void;
};
const FAIL = "remudero-review: FAIL — no acceptance criteria to judge (fail closed)";
const blobSha = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/** The mover's real REMOVE pull request, on a public origin whose base is its main, plus the readers' inputs for it. */
async function removalWorld(t: TestContext) {
  const w = moveWorld(t, { [ID]: ORIGINAL });
  await w.run();
  const copy = w.pulls[0]!;
  const opsCommit = w.merge(copy);
  const remove = await w.run();
  assert.equal(remove.out.step, "remove", remove.lines.join("\n"));
  const pr = w.pulls.at(-1)!;
  const clone = w.pub.clone;
  clone.git("fetch", "--quiet", "origin");
  const base = w.pub.origin.git("rev-parse", "main");
  const head = w.pub.origin.git("rev-parse", pr.head);
  const stateDir = join(ownedFixtureDir(t, "mover-state").dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: ["task"] }));
  const diff = (headSha = head) => clone.git("diff", base, headSha) + "\n";
  return { w, pr, clone, base, head, opsCommit, stateDir, diff, blob: w.pub.origin.git("rev-parse", `main:${shard(ID)}`) };
}
type Removal = Awaited<ReturnType<typeof removalWorld>>;

/** The GitHub reads the ops half makes, answered from the ops origin the mover really wrote. */
function opsApi(w: MoveWorld, overrides: { file?: (path: string, ref: string) => unknown; compare?: (commit: string) => unknown } = {}): OpsCatalogApi {
  return async path => {
    const contents = /^repos\/fixture\/ops\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    if (contents) {
      if (overrides.file) return overrides.file(contents[1]!, contents[2]!);
      const text = blobAt(w.ops.origin.dir, `${contents[2]}:${contents[1]}`);
      if (text === undefined) throw new Error("HTTP 404");
      return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), sha: blobSha(text) };
    }
    const compare = /^repos\/fixture\/ops\/compare\/([0-9a-f]{40})\.\.\.main$/.exec(path);
    if (compare) {
      if (overrides.compare) return overrides.compare(compare[1]!);
      const commit = compare[1]!;
      const main = w.main("ops");
      if (commit === main) return { status: "identical" };
      try { w.ops.origin.git("merge-base", "--is-ancestor", commit, main); return { status: "ahead" }; }
      catch (error) { void error; return { status: "diverged" }; }
    }
    throw new Error(`unexpected ops read ${path}`);
  };
}

const receiptLine = (r: Removal, over: Partial<{ repository: string; commit: string; id: string; path: string; blob: string }> = {}) =>
  `${MOVED_TO_TRAILER} ${over.repository ?? OPS}@${over.commit ?? r.opsCommit} ${over.id ?? ID} path=${over.path ?? shard(ID)} blob=${over.blob ?? r.blob}`;

/** A head cut from the same base as the mover's, with any message, branch name and extra changes: a forged removal. */
function forge(r: Removal, name: string, message: string, extra: (git: (...a: string[]) => string, dir: string) => void = () => undefined, keepDeletion = true): string {
  const { clone } = r;
  clone.git("checkout", "--quiet", "-B", name, r.base);
  if (keepDeletion) clone.git("rm", "--quiet", shard(ID));
  extra(clone.git, clone.dir);
  clone.git("commit", "--quiet", "--allow-empty", "-m", message);
  const sha = clone.git("rev-parse", "HEAD");
  clone.git("checkout", "--quiet", "--detach", r.base);
  return sha;
}
const read = (r: Removal, headRefName: string, headRefOid: string, api: OpsCatalogApi = opsApi(r.w), stateDir = r.stateDir) =>
  readMoverRemoval({ headRefName, headRefOid, repoDir: r.clone.dir, stateDir, api, baseRef: r.base });
const gateOn = (r: Removal, pr: { body: string; head: string }, headSha: string, extra: Record<string, unknown> = {}) =>
  GATE.evaluateGate({ body: pr.body, headRefName: pr.head, moverPublic: GATE.moverPublicAtRange({ baseSha: r.base, headSha, root: r.clone.dir }), ...extra });

test("W1-T14195 criterion 1: the mover's own REMOVE commit passes the gate (ops check deferred) and the review, where it failed closed before", async t => {
  const r = await removalWorld(t);
  assert.doesNotMatch(r.pr.body, /^Remudero-Task:|^## Acceptance/m, "positive control: the mover leaves out the trailer and the Acceptance block");
  assert.match(r.pr.head, /^plan-move-W1-T1-\d+$/);
  // Measured on the pre-change behaviour: with no public-half input the gate refuses exactly as it did for #20072.
  const before = GATE.evaluateGate({ body: r.pr.body, headRefName: r.pr.head });
  assert.equal(before.ok, false);
  assert.equal(before.defect, "no-header");
  assert.equal(judgeReview([], { diff: r.diff(), report: r.pr.body }).summary, FAIL, "no verified receipt: the review fails closed");

  const gate = gateOn(r, r.pr, r.head);
  assert.equal(gate.ok, true, gate.message);
  assert.match(gate.message, /the ops check is deferred to remudero-review/);
  assert.match(gate.message, /W1-T1/);

  const verdict = await read(r, r.pr.head, r.head);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  const judged = judgeReview([], { diff: r.diff(), report: r.pr.body, moverRemoval: verdict, planLint: LINT });
  assert.equal(judged.state, "success", judged.summary);
  assert.notEqual(judged.summary, FAIL);
  assert.equal(judged.planOnly, true);
  // The same verified receipt does not excuse a diff that is more than the one deletion.
  const extra = forge(r, "plan-move-W1-T1-1", `x\n\n${receiptLine(r)}`, (git, dir) => { mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true }); writeFileSync(join(dir, "plan", "tasks.d", "W1-T2.yaml"), record("W1-T2")); git("add", "plan/tasks.d/W1-T2.yaml"); });
  r.clone.git("fetch", "--quiet", "origin");
  const wider = r.clone.git("diff", r.base, extra) + "\n";
  assert.equal(judgeReview([], { diff: wider, report: "", moverRemoval: verdict, planLint: LINT }).summary, FAIL);
  // The receipt cannot be satisfied by a diff that deletes some other path.
  const other = ORIGINAL.replace(ID, "W1-T9");
  assert.equal(judgeReview([], { diff: `diff --git a/plan/tasks.d/W1-T9.yaml b/plan/tasks.d/W1-T9.yaml\ndeleted file mode 100644\n--- a/plan/tasks.d/W1-T9.yaml\n+++ /dev/null\n@@ -1 +0,0 @@\n-${other.split("\n")[0]}\n`, report: "", moverRemoval: verdict, planLint: LINT }).summary, FAIL);
  // Non-empty criteria never consult the receipt.
  const criterion = { claim: "a claim", proof: "grep: W1-T14195 in plan" };
  assert.equal(judgeReview([criterion], { diff: r.diff(), report: "" }).summary, judgeReview([criterion], { diff: r.diff(), report: "", moverRemoval: verdict, planLint: LINT }).summary);
});

test("W1-T14195 criterion 1: the receipt pattern is the one the mover writes, and reviewCommand hands the verdict to the review", async t => {
  const r = await removalWorld(t);
  assert.equal(MOVER_RECEIPT_PREFIX, MOVED_TO_TRAILER);
  assert.equal(MOVER_BRANCH_PREFIX, MOVE_BRANCH_PREFIX);
  const parsed = parseMoverReceipts(r.w.sides.public.origin.git("log", "-1", "--format=%B", r.pr.head));
  assert.deepEqual(parsed, { receipts: [{ repository: OPS, commit: r.opsCommit, id: ID, path: shard(ID), blob: r.blob }] });

  const seen: Array<MoverRemovalVerdict | undefined> = [];
  const asked: string[] = [];
  const drive = async (head: string, body: string, readFake: ReviewCommandDeps["readMoverRemoval"]) => {
    const root = ownedFixtureDir(t, "mover-review").dir;
    const sentinel = new Error("stop after the review inputs are captured");
    await assert.rejects(() => reviewCommand(REVIEW_HOST, "20072", ["--repo", "craigoley/remudero"], {
      fetchView: () => ({ body, html_url: "https://github.com/craigoley/remudero/pull/20072", head: { ref: head, sha: r.head }, updated_at: new Date().toISOString(), number: 20072 }),
      loadConfig: () => ({ root }) as Config,
      fetchHead: () => undefined,
      postReviewPending: async () => ({ posted: true }) as never,
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }) as never,
      readMoverRemoval: readFake,
      runReview: (async (args: { moverRemoval?: MoverRemovalVerdict }) => { seen.push(args.moverRemoval); throw sentinel; }) as never,
    }), (error: Error) => error === sentinel);
  };
  const verified = await read(r, r.pr.head, r.head);
  await drive(r.pr.head, r.pr.body, async args => { asked.push(args.headRefName); return verified; });
  await drive(r.pr.head, r.pr.body, async () => ({ verified: false, reason: "ops-read-unreadable" }));
  // A head that is not mover-shaped, and a mover-shaped one whose body carries its own criteria, never ask.
  await drive("run-unfiled-1795296862439", r.pr.body, async args => { asked.push(args.headRefName); return verified; });
  await drive(r.pr.head, `${r.pr.body}\n## Acceptance\n- a claim | grep: W1-T14195 in plan`, async args => { asked.push(args.headRefName); return verified; });
  assert.deepEqual(seen, [verified, { verified: false, reason: "ops-read-unreadable" }, undefined, undefined]);
  assert.deepEqual(asked, [r.pr.head], "only the criteria-less mover head reads the two repositories");
});

test("W1-T14195 criterion 1: the plan lint the review runs reads a mover removal head as ran, with no violation, so the verified PASS is not withheld", async t => {
  const r = await removalWorld(t);
  r.clone.git("checkout", "--quiet", "--detach", r.head);
  // The very child lintPlanForReview launches (src/run-task.ts spawnReviewPlanLint): lint-plan, offline, over the head's plan
  // against the merge base, with RMD_SELF_SYNC_DONE=1 so the child's own self-sync does not refuse the checkout.
  const lint = (plan: string, base: string) => spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src", "run-task.ts"), "lint-plan", "--plan", plan,
    "--base", base, "--offline", "--repo-root", r.clone.dir], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, RMD_SELF_SYNC_DONE: "1" } });
  const ran = lint(join(r.clone.dir, "plan", "tasks.yaml"), r.base);
  const lines = `${ran.stdout}\n${ran.stderr}`;
  assert.equal(ran.status, 0, lines);
  assert.match(lines, /rmd lint-plan: \d+ task\(s\) checked/, "the summary line planLintOutcomeFromOutput needs to read it as `ran`");
  assert.doesNotMatch(lines, /^✗ /m, "a deletion-only plan head carries no violation");
  // Positive control: a plan the lint cannot read is the `ran: false` shape (exit 2 or no summary) that would withhold the PASS.
  const broken = lint(join(r.clone.dir, "plan", "no-such-plan.yaml"), r.base);
  assert.ok(broken.status === 2 || !/rmd lint-plan: \d+ task\(s\) checked/.test(`${broken.stdout}\n${broken.stderr}`), "the check can fail");
});

test("W1-T14195 criterion 1: runReview threads a verified removal into the judged verdict, and the same run without it fails closed", async t => {
  const r = await removalWorld(t);
  r.clone.git("checkout", "--quiet", "--detach", r.head);
  const verdict = await read(r, r.pr.head, r.head);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  const pr = "https://github.com/acme/remudero/pull/20072";
  const root = ownedFixtureDir(t, "mover-run-review").dir;
  mkdirSync(join(root, "state"), { recursive: true });
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "api repos/", stdout: JSON.stringify({ number: 20072, html_url: pr, updated_at: "t", body: r.pr.body, head: { ref: r.pr.head, sha: r.head }, state: "open" }) },
    { when: "pr diff", stdout: r.diff() },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
  ], { kind: "mover-run-review" });
  const prior = process.env.PATH;
  process.env.PATH = `${shim.dir}:${prior}`;
  try {
    const host: ReviewCommandHost = { ...REVIEW_HOST, readHeadShaRest: () => r.head };
    const review = (runId: string, moverRemoval?: MoverRemovalVerdict) => runReview(host, {
      owner: "acme", repo: "remudero", prUrl: pr, headRefName: r.pr.head,
      task: { id: "PR-20072", acceptance: [], files: [] }, report: r.pr.body,
      settingsFile: "", config: { root, claudeBin: "/bin/true" } as Config,
      log: (step, extra = {}) => appendLedger(join(root, "state", "ledger.ndjson"), { run_id: runId, task_id: "PR-20072", step, ...extra }),
      say: () => undefined, account: result => result, spawnReviewer: false,
      headCheckoutDir: r.clone.dir, lintPlanForReviewFn: async () => LINT,
      ledgerPath: join(root, "state", "ledger.ndjson"), runId,
      arm: () => "no-task-id", disarm: () => "not-armed",
      ...(moverRemoval === undefined ? {} : { moverRemoval }),
    });
    const withheld = await review("without");
    assert.equal(withheld.state, "failure", `${withheld.summary} | ${withheld.verdictWithheld ?? ""}`);
    assert.match(withheld.summary, /no acceptance criteria to judge/);
    const admitted = await review("with", verdict);
    assert.equal(admitted.state, "success", admitted.summary);
    assert.notEqual(admitted.reviewDecisionDigest, withheld.reviewDecisionDigest, "the verified removal is part of the decision's identity");
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
  }
});

test("W1-T14195 criterion 2: the public half refuses with a named reason, and the gate returns no-header, for a head ref, receipt, diff or base blob that is not the mover's", async t => {
  const r = await removalWorld(t);
  const good = `chore(plan): move W1-T1\n\n${receiptLine(r)}`;
  const rows: Array<{ label: string; reason: string; head: string; sha: string; id?: string }> = [];
  const add = (label: string, reason: string, head: string, sha: string, id?: string) => rows.push({ label, reason, head, sha, id });
  add("a head ref that does not start plan-move-", "head-ref-is-not-a-mover-branch", "fix/hand-removal-of-w1-t1", forge(r, "f1", good));
  add("a head ref naming another id", "head-ref-names-another-id", "plan-move-W1-T2-1795000000000", forge(r, "f2", good), ID);
  add("no receipt line", "receipt-count", "plan-move-W1-T1-1795000000001", forge(r, "f3", "chore(plan): move W1-T1\n\nno receipt"));
  add("the same receipt twice", "receipt-count", "plan-move-W1-T1-1795000000002", forge(r, "f4", `${good}\n${receiptLine(r)}`));
  add("a malformed receipt line", "receipt-malformed", "plan-move-W1-T1-1795000000003", forge(r, "f5", `x\n\n${MOVED_TO_TRAILER} ${OPS}@${r.opsCommit} ${ID} path=${shard(ID)}`));
  add("a receipt path outside plan/tasks.d", "receipt-malformed", "plan-move-W1-T1-1795000000004", forge(r, "f6", `x\n\n${receiptLine(r, { path: "src/lib/review.ts" })}`));
  add("an added path beside the deletion", "diff-is-not-the-receipts-deletions", "plan-move-W1-T1-1795000000005",
    forge(r, "f7", good, (git, dir) => { mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true }); writeFileSync(join(dir, "plan", "tasks.d", "W1-T2.yaml"), record("W1-T2")); git("add", "plan/tasks.d/W1-T2.yaml"); }));
  add("a changed path beside the deletion", "diff-is-not-the-receipts-deletions", "plan-move-W1-T1-1795000000006",
    forge(r, "f8", good, (git, dir) => { writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n# touched\n"); git("add", "plan/tasks.yaml"); }));
  add("only a change, no deletion", "diff-is-not-the-receipts-deletions", "plan-move-W1-T1-1795000000007",
    forge(r, "f9", good, (git, dir) => { writeFileSync(join(dir, shard(ID)), ORIGINAL.replace("priority: 1", "priority: 2")); git("add", shard(ID)); }, false));
  add("a deletion of another path", "diff-is-not-the-receipts-deletions", "plan-move-W1-T1-1795000000008",
    forge(r, "f10", good, (git) => { git("rm", "--quiet", "plan/tasks.yaml"); }, false));
  add("a receipt blob that is not the base blob", "base-blob-differs-from-the-receipt", "plan-move-W1-T1-1795000000009",
    forge(r, "f11", `x\n\n${receiptLine(r, { blob: "a".repeat(40) })}`), ID);
  r.clone.git("fetch", "--quiet", "origin");
  const names = new Set<string>();
  for (const row of rows) {
    const verdict = await read(r, row.head, row.sha);
    assert.deepEqual(verdict, { verified: false, reason: row.reason, ...(row.id ? { id: row.id } : {}) }, row.label);
    const body = r.clone.git("log", "-1", "--format=%B", row.sha);
    const gate = GATE.evaluateGate({ body, headRefName: row.head, moverPublic: GATE.moverPublicAtRange({ baseSha: r.base, headSha: row.sha, root: r.clone.dir }) });
    assert.equal(gate.ok, false, row.label);
    assert.equal(gate.defect, "no-header", row.label);
    assert.equal(judgeReview([], { diff: r.clone.git("diff", r.base, row.sha) + "\n", report: body, moverRemoval: verdict, planLint: LINT }).summary, FAIL, row.label);
    names.add(row.reason);
  }
  assert.equal(names.size, 6, "positive control: every public refusal class was exercised");
  // An unreadable range refuses by name, never passes on absent evidence.
  assert.deepEqual(verifyMoverRemovalPublic({ headRefName: "plan-move-W1-T1-1", message: good, entries: undefined, baseBlobAt: () => r.blob }), { ok: false, reason: "diff-unreadable" });
  assert.deepEqual(await readMoverRemoval({ headRefName: r.pr.head, headRefOid: "f".repeat(40), repoDir: r.clone.dir, stateDir: r.stateDir, api: opsApi(r.w), baseRef: "no-such-ref" }), { verified: false, reason: "receipt-count" });
  assert.equal(GATE.moverPublicAtRange({ baseSha: r.base }), undefined);
  assert.equal(GATE.moverPublicAtRange({ baseSha: r.base, headSha: "e".repeat(40), root: r.clone.dir })?.entries, undefined, "an unreadable diff is `undefined`, never an empty one");
  assert.equal(GATE.moverPublicAtRange({ baseSha: r.base, headSha: "e".repeat(40), root: r.clone.dir })?.baseBlobAt(shard(ID)), undefined);
  assert.equal(GATE.moverPublicAtRange({ baseSha: r.base, headSha: r.head, git: () => { throw new Error("no git"); } })?.entries, undefined);
});

test("W1-T14195 criterion 2: main() admits the mover's head from a pull_request event and refuses the same body on another head", async t => {
  const r = await removalWorld(t);
  const run = (body: string, ref: string, sha: string) => {
    const event = join(ownedFixtureDir(t, "mover-event").dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { body, user: { login: "mover" }, base: { sha: r.base }, head: { sha, ref } } }));
    const prior = process.exitCode, out: string[] = [], err: string[] = [];
    const [realOut, realErr] = [console.log, console.error];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void err.push(a.join(" "));
    try { GATE.main(["--event-path", event], { root: r.clone.dir }); return { code: process.exitCode, out, err }; }
    finally { console.log = realOut; console.error = realErr; process.exitCode = prior; }
  };
  const ok = run(r.pr.body, r.pr.head, r.head);
  assert.equal(ok.code, 0, ok.err.join("\n"));
  assert.match(ok.out.join("\n"), /ops check is deferred to remudero-review/);
  const refused = run(r.pr.body, "run-unfiled-1795296862439", r.head);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /REFUSED \(no-header\)/);
});

const copyRow = (text: string, over: Partial<{ commit: string }> = {}) => ({ text, reachableFromMain: true, publicBlobAtMovedFrom: undefined as string | undefined, ...over });

test("W1-T14195 criterion 3: the ops half refuses, and the review posts the no-criteria FAIL, unless the ops record at a commit on ops main is the deleted blob plus one moved_from line", async t => {
  const r = await removalWorld(t);
  const opsText = blobAt(r.w.ops.origin.dir, `${r.opsCommit}:${shard(ID)}`)!;
  assert.match(opsText, /^ {2}moved_from: remudero@[0-9a-f]{40}$/m, "positive control: the ops copy carries its moved_from line");
  const movedFrom = movedFromCommit(opsText)!;
  const pubInput = { headRefName: r.pr.head, message: r.pr.body, entries: [{ status: "D", path: shard(ID) }], baseBlobAt: () => r.blob };
  const goodRead: MoverOpsRead = { text: opsText, reachableFromMain: true, publicBlobAtMovedFrom: r.blob };
  type OpsRow = { destination?: string; read?: MoverOpsRead };
  const check = (ops: OpsRow): MoverRemovalVerdict => verifyMoverRemoval({ public: pubInput, ops: { destination: ops.destination, reads: { [ID]: ops.read } } });
  assert.equal(check({ destination: OPS, read: goodRead }).verified, true, "positive control: the real ops record verifies");
  const rows: Array<[string, OpsRow, string]> = [
    ["no configured destination", { read: goodRead }, "plan-destination-is-not-configured"],
    ["a repository other than the destination", { destination: "fixture/other", read: goodRead }, "receipt-names-a-repository-other-than-the-plan-destination"],
    ["an unreadable ops read", { destination: OPS, read: "unreadable" }, "ops-read-unreadable"],
    ["no read at all", { destination: OPS }, "ops-read-unreadable"],
    ["a commit not reachable from ops main", { destination: OPS, read: { ...goodRead, reachableFromMain: false } }, "ops-commit-is-not-on-ops-main"],
    ["an absent record", { destination: OPS, read: { ...goodRead, text: undefined } }, "ops-record-is-absent"],
    ["a record with no moved_from line", { destination: OPS, read: { ...goodRead, text: opsText.replace(/^ {2}moved_from:.*\n/m, "") } }, "ops-record-moved-from-line-count-is-not-one"],
    ["a record with two moved_from lines", { destination: OPS, read: { ...goodRead, text: opsText.replace(/^( {2}moved_from:.*\n)/m, "$1$1") } }, "ops-record-moved-from-line-count-is-not-one"],
    ["a record naming another id", { destination: OPS, read: { ...goodRead, text: opsText.replace(`- id: ${ID}\n`, "- id: W1-T9\n") } }, "ops-record-names-another-id"],
    ["a record with a second id line", { destination: OPS, read: { ...goodRead, text: `${opsText}- id: ${ID}\n` } }, "ops-record-names-another-id"],
    ["a record that differs once its moved_from line is removed", { destination: OPS, read: { ...goodRead, text: opsText.replace("Move fixture", "Move fixturE") } }, "ops-record-differs-from-the-deleted-blob"],
    ["a malformed moved_from value", { destination: OPS, read: { ...goodRead, text: opsText.replace(/moved_from: remudero@/, "moved_from: remudero#") } }, "ops-record-moved-from-is-malformed"],
    ["a moved_from public commit that does not hold the receipt blob", { destination: OPS, read: { ...goodRead, publicBlobAtMovedFrom: "b".repeat(40) } }, "moved-from-public-commit-does-not-hold-the-receipt-blob"],
    ["a moved_from public commit that holds no file there", { destination: OPS, read: { ...goodRead, publicBlobAtMovedFrom: undefined } }, "moved-from-public-commit-does-not-hold-the-receipt-blob"],
  ];
  for (const [label, ops, reason] of rows) {
    const verdict = check(ops);
    assert.deepEqual(verdict, { verified: false, reason, id: ID }, label);
    assert.equal(judgeReview([], { diff: r.diff(), report: r.pr.body, moverRemoval: verdict, planLint: LINT }).summary, FAIL, label);
  }
  assert.equal(new Set(rows.map(row => row[2])).size, 10, "positive control: every ops refusal class was exercised");
  assert.equal(movedFromCommit("  moved_from: remudero@nothex\n"), undefined);
  assert.equal(movedFromCommit("no line"), undefined);
  assert.equal(copyRow(opsText).publicBlobAtMovedFrom, undefined);
  assert.equal(moverRemovalOpsRefusal(parsedReceipt(r), { destination: OPS, read: goodRead }), undefined);
  void movedFrom;
});
const parsedReceipt = (r: Removal) => ({ repository: OPS, commit: r.opsCommit, id: ID, path: shard(ID), blob: r.blob });

test("W1-T14195 criterion 3: the real two-repository read refuses for each ops fact it cannot prove", async t => {
  const r = await removalWorld(t);
  const opsText = blobAt(r.w.ops.origin.dir, `${r.opsCommit}:${shard(ID)}`)!;
  const message = (over: Parameters<typeof receiptLine>[1]) => `chore(plan): move W1-T1\n\n${receiptLine(r, over)}`;
  const verdictFor = async (name: string, over: Parameters<typeof receiptLine>[1], api?: OpsCatalogApi, stateDir?: string) => {
    const head = forge(r, `f-${name}`, message(over));
    r.clone.git("fetch", "--quiet", "origin");
    return read(r, `plan-move-${ID}-17950000${name.charCodeAt(0)}${name.charCodeAt(1)}`, head, api, stateDir);
  };
  assert.deepEqual(await read(r, r.pr.head, r.head), { verified: true, receipts: [parsedReceipt(r)] }, "positive control");
  // A newer ops main: the receipt's commit is an ancestor of it, not equal to it.
  r.w.commitTo("ops", { "plan/notes/later.md": "later\n" }, "a later ops commit");
  assert.equal((await read(r, r.pr.head, r.head)).verified, true, "an ancestor of ops main is on ops main");

  const named = (id: string) => `${id}`;
  void named;
  const other = join(ownedFixtureDir(t, "mover-other").dir, "state");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "plan-destination.json"), JSON.stringify({ repository: "fixture/other", kinds: [] }));
  assert.deepEqual(await read(r, r.pr.head, r.head, undefined, other), { verified: false, reason: "receipt-names-a-repository-other-than-the-plan-destination", id: ID });
  assert.deepEqual(await read(r, r.pr.head, r.head, undefined, join(other, "missing")), { verified: false, reason: "plan-destination-is-not-configured", id: ID });

  // Not reachable: a commit holding the right record that only a side branch holds.
  r.w.ops.clone.git("checkout", "--quiet", "-B", "side", "origin/main");
  writeFileSync(join(r.w.ops.clone.dir, "plan", "tasks.d", "side.txt"), "side\n");
  r.w.ops.clone.git("add", "plan/tasks.d/side.txt");
  r.w.ops.clone.git("commit", "--quiet", "-m", "side");
  r.w.ops.clone.git("push", "--quiet", "origin", "side");
  const side = r.w.ops.clone.git("rev-parse", "HEAD");
  r.w.ops.clone.git("checkout", "--quiet", "--detach", "origin/main");
  assert.deepEqual(await verdictFor("a1", { commit: side }), { verified: false, reason: "ops-commit-is-not-on-ops-main", id: ID });
  // Absent: the commit before the copy holds no record (a 404 is an unreadable read) or answers a directory.
  const before = r.w.ops.origin.git("rev-parse", `${r.opsCommit}^`);
  assert.deepEqual(await verdictFor("a2", { commit: before }), { verified: false, reason: "ops-read-unreadable", id: ID });
  assert.deepEqual(await verdictFor("a3", {}, opsApi(r.w, { file: () => ({ type: "dir" }) })), { verified: false, reason: "ops-record-is-absent", id: ID });
  // Unreadable: an API error, a compare error, a body that is not UTF-8, a blob whose sha is not its content's.
  const failing: OpsCatalogApi = async () => { throw new Error("HTTP 502"); };
  assert.deepEqual(await verdictFor("a4", {}, failing), { verified: false, reason: "ops-read-unreadable", id: ID });
  assert.deepEqual(await verdictFor("a5", {}, opsApi(r.w, { compare: () => { throw new Error("HTTP 404"); } })), { verified: false, reason: "ops-read-unreadable", id: ID });
  assert.deepEqual(await verdictFor("a6", {}, opsApi(r.w, { file: () => ({ type: "file", encoding: "base64", content: Buffer.from([0xff, 0xfe]).toString("base64"), sha: "c".repeat(40) }) })), { verified: false, reason: "ops-read-unreadable", id: ID });
  assert.deepEqual(await verdictFor("a7", {}, opsApi(r.w, { file: () => ({ type: "file", encoding: "base64", content: Buffer.from(opsText).toString("base64"), sha: "c".repeat(40) }) })), { verified: false, reason: "ops-read-unreadable", id: ID });
  // Another status is not on main.
  assert.deepEqual(await verdictFor("a8", {}, opsApi(r.w, { compare: () => ({ status: "behind" }) })), { verified: false, reason: "ops-commit-is-not-on-ops-main", id: ID });

  // The ops record at a commit on main that differs, names another id, or whose moved_from commit holds another blob.
  const onMain = (text: string) => r.w.commitTo("ops", { [shard(ID)]: text }, "hand-edited ops record");
  assert.deepEqual(await verdictFor("b1", { commit: onMain(opsText.replace("Move fixture", "Move fixturE")) }), { verified: false, reason: "ops-record-differs-from-the-deleted-blob", id: ID });
  assert.deepEqual(await verdictFor("b2", { commit: onMain(opsText.replace(`- id: ${ID}\n`, "- id: W1-T9\n")) }), { verified: false, reason: "ops-record-names-another-id", id: ID });
  assert.deepEqual(await verdictFor("b3", { commit: onMain(opsText.replace(/^( {2}moved_from:.*\n)/m, "")) }), { verified: false, reason: "ops-record-moved-from-line-count-is-not-one", id: ID });
  const unknown = onMain(opsText.replace(/moved_from: remudero@[0-9a-f]{40}/, `moved_from: remudero@${"0".repeat(40)}`));
  assert.deepEqual(await verdictFor("b4", { commit: unknown }), { verified: false, reason: "moved-from-public-commit-does-not-hold-the-receipt-blob", id: ID });
  // A moved_from commit whose file differs: the amended public main, while the forged head is cut from the older base.
  const amended = r.w.commitTo("public", { [shard(ID)]: ORIGINAL.replace("priority: 1", "priority: 2") }, "amend the public copy");
  const stale = onMain(opsText.replace(/moved_from: remudero@[0-9a-f]{40}/, `moved_from: remudero@${amended}`));
  assert.deepEqual(await verdictFor("b5", { commit: stale }), { verified: false, reason: "moved-from-public-commit-does-not-hold-the-receipt-blob", id: ID });
});

/** A batched removal: three records copied to ops main in one commit, then one public head deleting all three with a receipt each. */
const BATCH = ["W1-T1", "W1-T2", "W1-T3"];
async function batchWorld(t: TestContext) {
  const w = moveWorld(t, Object.fromEntries(BATCH.map(id => [id, record(id, "  files: [src/lib/moved.ts]\n")])));
  const seeded = w.main("public");
  const withMovedFrom = (id: string) => record(id, "  files: [src/lib/moved.ts]\n").replace(`- id: ${id}\n`, `- id: ${id}\n  moved_from: remudero@${seeded}\n`);
  const opsCommit = w.commitTo("ops", Object.fromEntries(BATCH.map(id => [shard(id), withMovedFrom(id)])), "copy three records");
  const stateDir = join(ownedFixtureDir(t, "mover-batch-state").dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: ["task"] }));
  const clone = w.pub.clone;
  const base = w.pub.origin.git("rev-parse", "main");
  const blobs = Object.fromEntries(BATCH.map(id => [id, w.pub.origin.git("rev-parse", `main:${shard(id)}`)]));
  const line = (id: string, over: Partial<{ commit: string; blob: string }> = {}) =>
    `${MOVED_TO_TRAILER} ${OPS}@${over.commit ?? opsCommit} ${id} path=${shard(id)} blob=${over.blob ?? blobs[id]}`;
  const forgeBatch = (name: string, lines: string[], extra: (git: (...a: string[]) => string, dir: string) => void = () => undefined, removed = BATCH) => {
    clone.git("checkout", "--quiet", "-B", name, base);
    for (const id of removed) clone.git("rm", "--quiet", shard(id));
    extra(clone.git, clone.dir);
    clone.git("commit", "--quiet", "--allow-empty", "-m", `chore(plan): move three tasks to the ops catalog\n\n${lines.join("\n")}`);
    const sha = clone.git("rev-parse", "HEAD");
    clone.git("checkout", "--quiet", "--detach", base);
    return sha;
  };
  const readBatch = (head: string, sha: string, api: OpsCatalogApi = opsApi(w)) =>
    readMoverRemoval({ headRefName: head, headRefOid: sha, repoDir: clone.dir, stateDir, api, baseRef: base });
  const diff = (sha: string) => clone.git("diff", base, sha) + "\n";
  return { w, clone, base, opsCommit, blobs, line, forgeBatch, readBatch, diff, stateDir };
}

test("W1-T14195 criterion 1: a batched removal of three records, one receipt each, is admitted by the gate and the review", async t => {
  const b = await batchWorld(t);
  const head = "plan-move-batch-1795000000100";
  const sha = b.forgeBatch(head, BATCH.map(id => b.line(id)));
  const body = b.clone.git("log", "-1", "--format=%B", sha);
  assert.doesNotMatch(body, /^Remudero-Task:|^## Acceptance/m);
  assert.equal(GATE.evaluateGate({ body, headRefName: head }).defect, "no-header", "positive control: refused without the public input");
  const gate = GATE.evaluateGate({ body, headRefName: head, moverPublic: GATE.moverPublicAtRange({ baseSha: b.base, headSha: sha, root: b.clone.dir }) });
  assert.equal(gate.ok, true, gate.message);
  assert.match(gate.message, /W1-T1, W1-T2, W1-T3/);
  assert.match(gate.message, /the ops check is deferred to remudero-review/);
  const verdict = await b.readBatch(head, sha);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.deepEqual(verdict.verified && verdict.receipts.map(r => r.id), BATCH);
  const judged = judgeReview([], { diff: b.diff(sha), report: body, moverRemoval: verdict, planLint: LINT });
  assert.equal(judged.state, "success", judged.summary);
  // Admit only the exact deletions: a diff deleting a fourth record, or only two of the three, is not the receipts'.
  const four = b.forgeBatch("plan-move-batch-1795000000101", BATCH.map(id => b.line(id)), git => { git("rm", "--quiet", "plan/tasks.yaml"); });
  assert.equal(judgeReview([], { diff: b.diff(four), report: "", moverRemoval: verdict, planLint: LINT }).summary, FAIL);
  const two = b.forgeBatch("plan-move-batch-1795000000102", BATCH.map(id => b.line(id)), () => undefined, BATCH.slice(0, 2));
  assert.equal(judgeReview([], { diff: b.diff(two), report: "", moverRemoval: verdict, planLint: LINT }).summary, FAIL);
  assert.deepEqual(await b.readBatch("plan-move-batch-1795000000102", two), { verified: false, reason: "diff-is-not-the-receipts-deletions" });
  assert.deepEqual(await b.readBatch("plan-move-batch-1795000000101", four), { verified: false, reason: "diff-is-not-the-receipts-deletions" });
  // Fewer receipts than deletions is the same refusal; a repeated id or path is a receipt-count refusal.
  const three = b.forgeBatch("plan-move-batch-1795000000103", BATCH.slice(0, 2).map(id => b.line(id)));
  assert.deepEqual(await b.readBatch("plan-move-batch-1795000000103", three), { verified: false, reason: "diff-is-not-the-receipts-deletions" });
  const twice = b.forgeBatch("plan-move-batch-1795000000104", [...BATCH.map(id => b.line(id)), b.line("W1-T1")]);
  assert.deepEqual(await b.readBatch("plan-move-batch-1795000000104", twice), { verified: false, reason: "receipt-count" });
});

test("W1-T14195 criterion 3: when one of three receipts fails against its ops record the whole removal fails closed and names that receipt", async t => {
  const b = await batchWorld(t);
  const opsText = (id: string) => blobAt(b.w.ops.origin.dir, `${b.opsCommit}:${shard(id)}`)!;
  assert.match(opsText("W1-T2"), /moved_from: remudero@/, "positive control: the copies carry moved_from");
  // A hand-edited ops record for the middle task, on ops main.
  const edited = b.w.commitTo("ops", { [shard("W1-T2")]: opsText("W1-T2").replace("Move fixture", "Move fixturE") }, "edit one record");
  const head = "plan-move-batch-1795000000200";
  const sha = b.forgeBatch(head, [b.line("W1-T1"), b.line("W1-T2", { commit: edited }), b.line("W1-T3")]);
  const verdict = await b.readBatch(head, sha);
  assert.deepEqual(verdict, { verified: false, reason: "ops-record-differs-from-the-deleted-blob", id: "W1-T2" });
  assert.equal(judgeReview([], { diff: b.diff(sha), report: "", moverRemoval: verdict, planLint: LINT }).summary, FAIL);
  // Each ops fact failing on exactly one receipt of three.
  const unreadable: OpsCatalogApi = async path => { if (path.includes("W1-T3")) throw new Error("HTTP 502"); return opsApi(b.w)(path); };
  const third = b.forgeBatch("plan-move-batch-1795000000201", BATCH.map(id => b.line(id)));
  assert.deepEqual(await b.readBatch("plan-move-batch-1795000000201", third, unreadable), { verified: false, reason: "ops-read-unreadable", id: "W1-T3" });
  const blobOff = b.forgeBatch("plan-move-batch-1795000000202", BATCH.map(id => b.line(id, id === "W1-T1" ? { blob: "d".repeat(40) } : {})));
  assert.deepEqual(await b.readBatch("plan-move-batch-1795000000202", blobOff), { verified: false, reason: "base-blob-differs-from-the-receipt", id: "W1-T1" });
  // The same three, none failing, verify: positive control for the three refusals above.
  assert.equal((await b.readBatch("plan-move-batch-1795000000201", third)).verified, true);
});

/** The messages the mover writes for its other steps, none of which carries a receipt. */
async function otherMoverMessages(t: TestContext): Promise<Array<{ label: string; pr: ModelPull }>> {
  const out: Array<{ label: string; pr: ModelPull }> = [];
  const both = async () => { const w = moveWorld(t, { [ID]: ORIGINAL }); await w.run(); w.merge(w.pulls[0]!); return w; };
  const copy = moveWorld(t, { [ID]: ORIGINAL });
  await copy.run();
  out.push({ label: "COPY", pr: copy.pulls[0]! });
  const rolledBack = await both();
  rolledBack.commitTo("public", { [shard(ID)]: ORIGINAL.replace("priority: 1", "priority: 2") }, "amend");
  await rolledBack.run();
  out.push({ label: "ROLLBACK", pr: rolledBack.pulls.at(-1)! });
  const restored = await both();
  await restored.run();
  restored.merge(restored.pulls.at(-1)!);
  restored.commitTo("ops", { [shard(ID)]: null }, "the ops copy is deleted by hand");
  await restored.run();
  out.push({ label: "RESTORE", pr: restored.pulls.at(-1)! });
  return out;
}

/** What origin/main's gate and review answered for each production shape, measured before this change. */
const BUILD = { body: "Remudero-Task: W1-T5\n", head: "run-W1-T5-1795000000000" };
const FILING = { body: "## Acceptance\n- the shard is filed | grep: version in package.json\n", head: "plan-w1-t5-filing" };
const UNFILED = { body: "## Acceptance\n- the shard is filed | grep: version in package.json\n", head: "run-unfiled-1795296862439" };

test("W1-T14195 criterion 4 invariant:non-mover-prs-unchanged: every shape production emits gets the verdict and message origin/main gave", async t => {
  const shapes: Array<{ label: string; body: string; head: string; author?: string }> = [
    { label: "a run build with its trailer", ...BUILD },
    { label: "an emitter plan filing", ...FILING },
    { label: "a run-unfiled hand PR", ...UNFILED },
    { label: "a dependabot bump", body: "Bumps x from 1 to 2.", head: "dependabot/npm_and_yarn/x-2", author: "dependabot[bot]" },
    { label: "a PR with no criteria on an ordinary branch", body: "just prose", head: "fix/something" },
  ];
  const r = await removalWorld(t);
  const noReceipt = r.pr.body.split("\n").filter(line => !line.startsWith(MOVED_TO_TRAILER)).join("\n");
  for (const mover of await otherMoverMessages(t)) shapes.push({ label: `a mover ${mover.label} pull request`, body: mover.pr.body, head: mover.pr.head });
  shapes.push({ label: "a plan-move head with the receipt removed", body: noReceipt, head: r.pr.head });
  const seen: Record<string, unknown> = {};
  for (const shape of shapes) {
    // The shape's own message, with an otherwise perfect public half (one deletion of the record at its base blob): only the receipt differs.
    const moverPublic = shape.head.startsWith("plan-move-") ? { message: shape.body, entries: [{ status: "D", path: shard(ID) }], baseBlobAt: () => r.blob } : undefined;
    const gate = GATE.evaluateGate({ body: shape.body, headRefName: shape.head, authorLogin: shape.author, trailerResolves: () => true, moverPublic });
    const judged = judgeReview(shape.body.includes("## Acceptance") ? [{ claim: "the shard is filed", proof: "grep: version in package.json" }] : [],
      { diff: r.diff(), report: shape.body, planLint: LINT });
    seen[shape.label] = { gate: { ok: gate.ok, defect: gate.defect, message: gate.message }, review: { state: judged.state, summary: judged.summary } };
  }
  // Both sides go through JSON: origin/main's measurement was written as JSON, which drops an `undefined` key such as the
  // `defect` this test's own record shape carries on an ok verdict. origin/main's evaluateGate returns `{ ok, message }` there.
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), EXPECTED_BEFORE);
});

/** Measured by running the same shapes through origin/main's source (cdf4d24dd1), before this change. */
const EXPECTED_BEFORE: Record<string, unknown> = {
  "a run build with its trailer": {
    "gate": {
      "ok": true,
      "message": "Remudero-Task: W1-T5 trailer present — criteria resolve from plan/tasks.yaml"
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  },
  "an emitter plan filing": {
    "gate": {
      "ok": true,
      "message": "Acceptance block is judgeable"
    },
    "review": {
      "state": "success",
      "summary": "remudero-review: PASS — plan-only PR (1 criteria); lint-plan ran on its changed tasks (0 checked, 0 failing); no proof run"
    }
  },
  "a run-unfiled hand PR": {
    "gate": {
      "ok": true,
      "message": "Remudero-Task: unfiled trailer present — criteria resolve from plan/tasks.yaml"
    },
    "review": {
      "state": "success",
      "summary": "remudero-review: PASS — plan-only PR (1 criteria); lint-plan ran on its changed tasks (0 checked, 0 failing); no proof run"
    }
  },
  "a dependabot bump": {
    "gate": {
      "ok": true,
      "message": "author \"dependabot[bot]\" is exempt — the dep-review lane owns arming for these (W1-T1060 rationale (5))"
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  },
  "a PR with no criteria on an ordinary branch": {
    "gate": {
      "ok": false,
      "defect": "no-header",
      "message": "no `## Acceptance` header and no `Remudero-Task:` trailer — review has nothing to resolve criteria from and fails CLOSED. Add a bare `## Acceptance` (or `Acceptance:`) header followed by bullets, or a `Remudero-Task: <id>` trailer line. Task identity was read from the PR body (no Remudero-Task trailer) and the head ref (the head ref \"fix/something\" is not a run-<taskId>-<epochMs> branch); the trailer must be in the PR body."
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  },
  "a mover COPY pull request": {
    "gate": {
      "ok": false,
      "defect": "no-header",
      "message": "no `## Acceptance` header and no `Remudero-Task:` trailer — review has nothing to resolve criteria from and fails CLOSED. Add a bare `## Acceptance` (or `Acceptance:`) header followed by bullets, or a `Remudero-Task: <id>` trailer line. Task identity was read from the PR body (no Remudero-Task trailer) and the head ref (the head ref \"plan-move-W1-T1-1800000000001\" is not a run-<taskId>-<epochMs> branch); the trailer must be in the PR body."
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  },
  "a mover ROLLBACK pull request": {
    "gate": {
      "ok": false,
      "defect": "no-header",
      "message": "no `## Acceptance` header and no `Remudero-Task:` trailer — review has nothing to resolve criteria from and fails CLOSED. Add a bare `## Acceptance` (or `Acceptance:`) header followed by bullets, or a `Remudero-Task: <id>` trailer line. Task identity was read from the PR body (no Remudero-Task trailer) and the head ref (the head ref \"plan-move-W1-T1-1800000000002\" is not a run-<taskId>-<epochMs> branch); the trailer must be in the PR body."
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  },
  "a mover RESTORE pull request": {
    "gate": {
      "ok": false,
      "defect": "no-header",
      "message": "no `## Acceptance` header and no `Remudero-Task:` trailer — review has nothing to resolve criteria from and fails CLOSED. Add a bare `## Acceptance` (or `Acceptance:`) header followed by bullets, or a `Remudero-Task: <id>` trailer line. Task identity was read from the PR body (no Remudero-Task trailer) and the head ref (the head ref \"plan-move-W1-T1-1800000000003\" is not a run-<taskId>-<epochMs> branch); the trailer must be in the PR body."
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  },
  "a plan-move head with the receipt removed": {
    "gate": {
      "ok": false,
      "defect": "no-header",
      "message": "no `## Acceptance` header and no `Remudero-Task:` trailer — review has nothing to resolve criteria from and fails CLOSED. Add a bare `## Acceptance` (or `Acceptance:`) header followed by bullets, or a `Remudero-Task: <id>` trailer line. Task identity was read from the PR body (no Remudero-Task trailer) and the head ref (the head ref \"plan-move-W1-T1-1800000000002\" is not a run-<taskId>-<epochMs> branch); the trailer must be in the PR body."
    },
    "review": {
      "state": "failure",
      "summary": "remudero-review: FAIL — no acceptance criteria to judge (fail closed)"
    }
  }
};
