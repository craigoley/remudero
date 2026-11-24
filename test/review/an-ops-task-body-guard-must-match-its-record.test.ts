/**
 * W1-T14627: proof-discrimination honours a PR body's `kind: guard` on a PR that names its task, because Actions cannot
 * read an ops-catalog record. remudero-review reads the record, so it is the half that refuses a body guard the record
 * does not declare: `markUnbackedBodyGuards` marks it and `judgeReview` fails that criterion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { reviewCommand, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { readLedgerLines } from "#src/lib/status.js";
import { BODY_GUARD_UNBACKED, judgeReview, markUnbackedBodyGuards, parseAcceptanceBlock } from "#src/lib/review.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";

const PROOF = "unit test: the committed registry keeps every other row";
const BODY = `## Acceptance\n\n- claim: the rows stay as they were\n  proof: ${PROOF}\n  kind: guard\n`;
const RECORD: AcceptanceCriterion = { claim: "the rows stay as they were", proof: PROOF };
const RECORD_GUARD = { ...RECORD, kind: "guard" } as AcceptanceCriterion;
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

const judge = (criteria: AcceptanceCriterion[]) =>
  judgeReview(criteria, { diff: DIFF, report: "the rows stay as they were", headCheckoutDir: "/head", execProof: () => "pass" });

test("markUnbackedBodyGuards marks a body guard its record does not declare, and the judge fails it", () => {
  const body = parseAcceptanceBlock(BODY);
  const checked = markUnbackedBodyGuards([RECORD], body, false);
  assert.deepEqual(checked.unbacked, [PROOF]);
  const verdict = judge(checked.criteria);
  assert.equal(verdict.state, "failure");
  assert.equal(verdict.criteria[0]!.met, false);
  assert.match(verdict.criteria[0]!.reason, new RegExp(BODY_GUARD_UNBACKED));

  // A body with no task record behind it backs no guard either.
  const fromBody = markUnbackedBodyGuards(body, body, true);
  assert.deepEqual(fromBody.unbacked, [PROOF]);
});

test("a body guard whose proof differs from every record proof is refused, naming that proof", () => {
  const edited = "unit test: edited";
  const body = parseAcceptanceBlock(BODY.replace(PROOF, edited));
  const checked = markUnbackedBodyGuards([RECORD_GUARD], body, false);
  assert.deepEqual(checked.unbacked, [edited]);
  assert.equal(checked.criteria.length, 2);
  const verdict = judge(checked.criteria);
  assert.equal(verdict.state, "failure");
  const refused = verdict.criteria.find((c) => c.proof === edited)!;
  assert.equal(refused.met, false);
  assert.match(refused.reason, new RegExp(BODY_GUARD_UNBACKED));
  assert.ok(refused.reason.includes(edited));
  // A record guard backs the body guard even when a plain record criterion shares its proof.
  const plain = markUnbackedBodyGuards([RECORD, RECORD_GUARD], parseAcceptanceBlock(BODY), false);
  assert.deepEqual(plain.unbacked, []);
});

test("a body guard its record declares, and a body with no guard, pass through unmarked", () => {
  const backed = markUnbackedBodyGuards([RECORD_GUARD], parseAcceptanceBlock(BODY), false);
  assert.deepEqual(backed.unbacked, []);
  assert.deepEqual(backed.criteria, [RECORD_GUARD]);
  const plain = markUnbackedBodyGuards([RECORD], parseAcceptanceBlock(BODY.replace("  kind: guard\n", "")), false);
  assert.deepEqual(plain.unbacked, []);
  assert.notEqual(judge(plain.criteria).criteria[0]!.met, false);
});

// The same refusal reached through the real `rmd review` command: the record comes from a pinned ops-catalog reader,
// the PR body marks the record's one proof `kind: guard`, and the criteria handed to the review carry the refusal.
const OPS_ID = "W1-T900001", OPS_REPOSITORY = "fixture-private/ops";
const OPS_RECORD = `- id: ${OPS_ID}\n  title: Body guard fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  priority: 0\n` +
  `  risk: high\n  budget_usd: 0.5\n  files: [src/fixture.ts]\n  design: fixture\n  acceptance:\n` +
  `    - claim: the rows stay as they were\n      proof: "${PROOF}"\n`;

function pinnedOpsCatalog(root: string): OpsCatalogApi {
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS_REPOSITORY, kinds: [] }));
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(OPS_RECORD), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(OPS_RECORD)}\0${OPS_RECORD}`), base = `repos/${OPS_REPOSITORY}`;
  return async (path) => {
    if (path === base) return { id: 42, full_name: OPS_REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(OPS_RECORD), content: Buffer.from(OPS_RECORD).toString("base64") };
  };
}

test("W1-T14627: review refuses a body guard its record does not declare, read through rmd review's ops catalog", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-body-guard-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = pinnedOpsCatalog(root);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const host = {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: () => undefined, reviewWorktreeAsync: { fetch: () => {} },
    materializeReviewWorktree: () => { throw Error("forbidden real materialization"); },
    realDeps: () => { throw Error("forbidden default worker graph"); },
    reviewPostedDescription: () => "fixture", readHeadShaRest: () => head, reviewerClockBoundMs: () => 60_000,
    liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (id: string) => `fixture-${id}`,
  } as unknown as ReviewCommandHost;
  let handed: AcceptanceCriterion[] | undefined;
  await assert.rejects(() => reviewCommand(host, "42", [], {
    loadConfig: () => ({ root }) as never,
    resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${OPS_ID}\n\n${BODY}`, html_url: "https://github.com/fixture/remudero/pull/42",
      number: 42, head: { ref: `run-${OPS_ID}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {}, taskLookup: { api },
    materialize: () => ({ worktreePath: REPO_ROOT }) as never,
    withMaterialized: async (_path, _repo, body) => body(), buildBaseProof: async () => undefined as never,
    reviewerCodeFreshness: () => ({ status: "unreadable", reason: "fixture has no deployment identity" }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    postReviewPending: async () => ({ posted: true }) as never,
    runReview: (async (args: { task: { acceptance?: AcceptanceCriterion[] } }) => { handed = args.task.acceptance; throw Error("fixture stops at the judge"); }) as never,
  }), /fixture stops at the judge/);
  assert.ok(handed, "the review reached the judge with the record's criteria");
  assert.equal(handed.length, 1);
  assert.equal((handed[0] as { bodyGuardUnbacked?: boolean }).bodyGuardUnbacked, true);
  const verdict = judge(handed);
  assert.equal(verdict.criteria[0]!.met, false);
  assert.match(verdict.criteria[0]!.reason, new RegExp(BODY_GUARD_UNBACKED));
  const rows = readLedgerLines(join(root, "state", "ledger.ndjson"));
  assert.ok(rows.some((row) => row.step === "review.body_guard_unbacked" && row.count === 1), "the refusal is ledgered on the host");
});
