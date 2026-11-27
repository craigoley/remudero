/**
 * W1-T15077: a failed review of an ops-catalog task kept its criterion reasons and findings only on the host
 * (OBSERVED 2026-11-27 on #21034, #21054, #21045, #21071, #21047), so every builder had to ask the host for them. A failed
 * or capped verdict now lands them in the private plan repository, and the public status and comment stay as before.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  catalogReviewPoster, opsReviewCommentBody, opsReviewFindingsMarkdown, publishOpsReviewFindings, type OpsReviewRecord,
} from "#src/cli/commands/review.js";
import { isLandingRef, landingIdentity, landReviewFindingsAsync, reviewFindingsRelPath } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { originWithClone } from "#test/helpers/git-repo.js";

const OPS = { owner: "fixture", repo: "remudero-ops" };
const HEAD = "ab".repeat(20);
const PR = 15077;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const REASON = "the retry reuses the refused token: ensureFresh answers fresh while the timer is not due";
const MECHANISM = "a forced renewal with an armed loop never mints";
const REMEDY = "mint for a refused token in the held-token loop";

function record(state: string): OpsReviewRecord {
  return {
    version: 1, task_id: "W1-T15077X", pr_url: `https://github.com/fixture/remudero/pull/${PR}`, head_sha: HEAD, state,
    review_decision_digest: "d",
    criteria: [
      { index: 1, claim: "a renewed token posts", met: true, proof_exec: "executed_pass", proof: "unit test: c1", reason: "proof ran green" },
      { index: 2, claim: "a 401 retries once", met: false, proof_exec: "executed_pass", proof: "unit test: c2", reason: REASON },
    ],
    reasons: [REASON],
    findings: [{ criterion_index: 2, category: "correctness", severity: "high", mechanism: MECHANISM, remedy: REMEDY,
      anchor: { path: "src/lib/review.ts", line: 8118, kind: "changed", status: "verified", evidenceDigest: "e" } as OpsReviewRecord["findings"][number]["anchor"] }],
  };
}

/** One instance: `<root>/state` naming the private repository, whose checkout and origin sit under `<root>/repos`. */
function instance(t: TestContext) {
  const root = makeTempDir("w15077-instance");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  const publicOrigin = originWithClone(join(root, "repos", "remudero"), { scope: t, seed: { "scripts/README": "harness\n" } }).origin.dir;
  const opsOrigin = originWithClone(join(root, "repos", OPS.repo), { scope: t }).origin.dir;
  return { stateDir, publicOrigin, opsOrigin };
}

function fakeGh() {
  const calls: string[][] = [];
  const answer = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture/remudero-ops/pull/7\n";
    if (args[0] === "api") return "{}";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, gh: answer, ghAsync: async (args: string[]) => answer(args) };
}

const branches = (bare: string): string[] => git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();

test("W1-T15077 criterion 1: a failed ops-task verdict writes its findings file to remudero-ops", async (t) => {
  const f = instance(t);
  writeFileSync(planDestinationPath(f.stateDir), JSON.stringify({ repository: `${OPS.owner}/${OPS.repo}`, kinds: ["decision"] }));
  const branch = landingIdentity({ family: "review-findings", targetRepository: OPS, sourceRepository: OPS }).branch;
  assert.ok(isLandingRef(branch), "the findings landing branch is a landing ref, so the reaper keeps it");
  for (const [state, capped] of [["failure", false], ["success", true]] as const) {
    const gh = fakeGh();
    const rows: Array<Record<string, unknown>> = [];
    const head = capped ? "cd".repeat(20) : HEAD;
    const outcome = await withLiveWritesAllowed(() => publishOpsReviewFindings(f.stateDir, { ...record(state), head_sha: head },
      { prNumber: PR, capped }, (step, extra) => rows.push({ step, ...extra }),
      (dir, input) => landReviewFindingsAsync(dir, input, { gh: gh.gh, ghAsync: gh.ghAsync })));
    assert.equal(outcome, "landed", JSON.stringify(rows));
    const rel = reviewFindingsRelPath(PR, head);
    assert.equal(rel, `plan/review-findings/pr-${PR}/${head}.md`);
    const page = git(f.opsOrigin, "show", `${branch}:${rel}`);
    for (const text of [REASON, MECHANISM, REMEDY, "src/lib/review.ts:8118", "verified", "FAIL"]) {
      assert.ok(page.includes(text), `THE CLAIM: the private page carries ${text}: ${page}`);
    }
    const create = gh.calls.find((args) => args[0] === "pr" && args[1] === "create");
    assert.equal(create?.[create.indexOf("--repo") + 1], `${OPS.owner}/${OPS.repo}`, "the landing pull request opens in the private repository");
  }
  assert.deepEqual(branches(f.publicOrigin), ["main"], "THE CLAIM: nothing reaches the public repository");
  // A passing verdict lands nothing.
  const quiet = await publishOpsReviewFindings(f.stateDir, record("success"), { prNumber: PR, capped: false },
    () => assert.fail("no row"), async () => assert.fail("no landing"));
  assert.equal(quiet, "not_failed");
});

test("W1-T15077 criterion 1: a host with no private destination lands nothing anywhere and records why", async (t) => {
  const f = instance(t);
  const rows: Array<Record<string, unknown>> = [];
  const outcome = await withLiveWritesAllowed(() => publishOpsReviewFindings(f.stateDir, record("failure"), { prNumber: PR, capped: false },
    (step, extra) => rows.push({ step, ...extra })));
  assert.equal(outcome, "refused");
  assert.deepEqual(rows.map((row) => [row.step, row.destination, row.head_sha]), [["review.record_write_failed", "plan_destination", HEAD]]);
  assert.match(String(rows[0]!.reason), /no private plan destination/);
  assert.deepEqual(branches(f.publicOrigin), ["main"], "the findings never fall back to the public repository");
  assert.deepEqual(branches(f.opsOrigin), ["main"]);
  // A lander that throws is a recorded refusal too.
  const thrown: Array<Record<string, unknown>> = [];
  assert.equal(await publishOpsReviewFindings(f.stateDir, record("failure"), { prNumber: PR, capped: false },
    (step, extra) => thrown.push({ step, ...extra }), async () => { throw new Error("push refused"); }), "refused");
  assert.match(String(thrown[0]!.reason), /push refused/);
});

test("W1-T15077 criterion 2: the public status and comment carry no claim or finding text", async () => {
  const posted: Array<{ state: string; description?: string }> = [];
  const post = catalogReviewPoster("ops", async (options) => { posted.push({ state: options.state, description: options.description }); });
  await post({ owner: "fixture", repo: "remudero", sha: HEAD, state: "failure", description: `remudero-review: failure — ${REASON}` });
  assert.deepEqual(posted, [{ state: "failure", description: "remudero-review: failure — detailed evidence retained on host" }],
    "THE CLAIM: the public status is today's, byte for byte");
  const page = opsReviewFindingsMarkdown(record("failure"));
  assert.ok(page.includes(REASON) && page.includes(MECHANISM), "positive control: the private page carries the text");
  const comment = opsReviewCommentBody("failure", [{ claim: "a renewed token posts", proof: "unit test: c1" },
    { claim: "a 401 retries once", proof: "unit test: c2" }] as never, record("failure").criteria as never);
  assert.equal(comment, "**remudero-review=failure** — detailed evidence retained on host\n\n- PASS: a renewed token posts\n- FAIL: a 401 retries once",
    "THE CLAIM: the public comment is today's, byte for byte");
  for (const text of [REASON, MECHANISM, REMEDY, "8118"]) {
    assert.ok(!posted[0]!.description!.includes(text) && !comment.includes(text), `THE CLAIM: no public text carries ${text}`);
  }
});
