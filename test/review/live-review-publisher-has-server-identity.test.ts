import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { postReviewStatusGuarded, readReviewStatusEntry, resolveReviewProvenance } from "#src/lib/review.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const combined = (state = "success") => ({ statuses: [{ context: "remudero-review", state }] });
const reader = (payload: unknown, state = "success") => (args: string[]) => args[1] === "graphql" ? payload : combined(state);
const response = (context: unknown = { context: "remudero-review", state: "SUCCESS", creator: { login: "fleet", __typename: "Bot" } }) =>
  ({ data: { repository: { nameWithOwner: "acme/portal", object: { oid: SHA, status: { context } } } } });

test("the live review reader obtains the server publisher from one head-bound named context", async () => {
  const reads: string[][] = [];
  const entry = await readReviewStatusEntry("acme", "portal", SHA, args => {
    reads.push(args);
    // The real combined endpoint contains this status but omits creator entirely.
    return args[1] === "graphql" ? response() : { statuses: [{ context: "remudero-review", state: "success" }] };
  });
  assert.deepEqual(entry, { state: "success", posterLogin: "fleet[bot]", posterType: "Bot" });
  assert.equal(resolveReviewProvenance(entry, "fleet[bot]"), "success");
  assert.equal(reads.length, 2);
  assert.match(reads[0]![1]!, /commits\/.+\/status$/);
  assert.equal(reads[1]![1], "graphql");
  assert.ok(reads[1]!.includes(`sha=${SHA}`));
  assert.match(reads[1]!.find(arg => arg.startsWith("query="))!, /context\(name:"remudero-review"\)/);
  assert.doesNotMatch(reads[1]!.find(arg => arg.startsWith("query="))!, /contexts\s*\{|first:|after:/);
});

for (const state of ["SUCCESS", "PENDING", "FAILURE", "ERROR"]) {
  test(`the live review reader preserves the server's ${state} state`, async () => {
    const entry = await readReviewStatusEntry("acme", "portal", SHA, reader(response({
      context: "remudero-review", state, creator: { login: "human", __typename: "User" },
    }), state.toLowerCase()));
    assert.equal(entry?.state, state === "ERROR" ? "failure" : state.toLowerCase());
    assert.equal(entry?.posterLogin, "human");
    assert.equal(resolveReviewProvenance(entry, "fleet[bot]"), "absent");
  });
}

test("an absent REST status stays absent, but a disappearing identity response refuses", async () => {
  assert.equal(await readReviewStatusEntry("acme", "portal", SHA, () => ({ statuses: [] })), undefined);
  await assert.rejects(() => readReviewStatusEntry("acme", "portal", SHA, reader(response(null))), /disappeared/);
  await assert.rejects(() => readReviewStatusEntry("other", "portal", SHA, reader(response())), /different repository or commit/);
  await assert.rejects(() => readReviewStatusEntry("acme", "portal", "b".repeat(40), reader(response())), /different repository or commit/);
});

test("unread, partial and mismatched status-context responses refuse", async () => {
  for (const raw of [null, {}, { errors: [{ message: "unavailable" }], ...response() },
    { data: { repository: { nameWithOwner: "acme/portal", object: { oid: SHA } } } },
    { data: { repository: { nameWithOwner: "acme/portal", object: { oid: SHA, status: {} } } } },
    response({ context: "ci-gate", state: "SUCCESS" }), response({ context: "remudero-review", state: "UNKNOWN" })]) {
    await assert.rejects(() => readReviewStatusEntry("acme", "portal", SHA, reader(raw)));
  }
  await assert.rejects(() => readReviewStatusEntry("acme", "portal", SHA, () => { throw new Error("offline"); }), /offline/);
});

test("missing or untrusted actors cannot acquire the established publisher identity", async () => {
  for (const creator of [null, { login: "human", __typename: "User" }, { login: "fleet", __typename: "Organization" },
    { login: "fleet" }, { __typename: "Bot" }]) {
    const entry = await readReviewStatusEntry("acme", "portal", SHA, reader(response({ context: "remudero-review", state: "SUCCESS", creator })));
    assert.equal(resolveReviewProvenance(entry, "fleet[bot]"), "absent");
  }
});

test("identity-bearing REST replies preserve the existing direct reader", async () => {
  const reads: string[][] = [];
  const entry = await readReviewStatusEntry("acme", "portal", SHA, args => {
    reads.push(args); return { statuses: [{ context: "remudero-review", state: "success", creator: { login: "fleet[bot]", type: "Bot" } }] };
  });
  assert.equal(reads.length, 1);
  assert.equal(entry?.posterLogin, "fleet[bot]");
});

test("a state change between identity representations refuses rather than confirming stale success", async () => {
  await assert.rejects(() => readReviewStatusEntry("acme", "portal", SHA, reader(response({
    context: "remudero-review", state: "FAILURE", creator: { login: "fleet", __typename: "Bot" },
  }))), /changed during/);
});

test("the default publisher reader confirms the existing review without rejudging or reposting", async t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-publisher-identity-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const savedEnv = { ...process.env };
  const shim = ghShim([
    { when: `api repos/acme/portal/commits/${SHA}/status`, stdout: JSON.stringify(combined()) },
    { when: "api graphql", stdout: JSON.stringify(response()) },
    { when: "", stderr: "unexpected identity fixture read", exit: 1 },
  ]);
  t.after(() => { process.env = savedEnv; rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  delete process.env.REMUDERO_REVIEWER_TOKEN;
  delete process.env.REMUDERO_REVIEWER_LOGIN;
  const prUrl = "https://github.com/acme/portal/pull/8";
  appendLedger(ledgerPath, { run_id: "original", task_id: "PR-8", step: "review.posted", pr_url: prUrl,
    head_sha: SHA, review_input_digest: "same-input", review_decision_digest: "v2:identity-fixture",
    state: "success", proof_exec: ["executed_pass"], decision_verdict: {
      state: "success", headSha: SHA, reviewerOutcome: "reviewer_completed", keywordOnly: false, capped: false,
      criteria: [{ claim: "works", proof: "grep: x in src/app.ts", met: true, reason: "executed", proof_exec: "executed_pass" }],
      testTheater: false, summary: "immutable captured review",
    } });
  const originalLedger = readFileSync(ledgerPath, "utf8");
  let posts = 0;
  const result = await postReviewStatusGuarded({ owner: "acme", repo: "portal", sha: SHA, state: "success",
    taskId: "PR-8", evidence: "executed", ledgerPath, runId: "retry", prUrl, reviewInputDigest: "same-input",
    reviewDecisionDigest: "v2:identity-fixture",
    fetchLifecycle: () => ({ merged: false, closed: false, reviewInputDigest: "same-input", baseRef: "main" }),
    fetchPublisher: () => ({ checks: [{ context: "remudero-review", app_id: null }] }),
    post: () => { posts++; },
  });
  assert.equal(result.replayed, true, JSON.stringify(result));
  assert.equal(result.posted, false);
  assert.equal(posts, 0);
  assert.equal(result.publisherEvidence?.posterLogin, "fleet[bot]");
  assert.equal(readFileSync(ledgerPath, "utf8"), originalLedger);
  assert.equal(shim.calls().filter(call => call.startsWith("api graphql")).length, 1);
});
