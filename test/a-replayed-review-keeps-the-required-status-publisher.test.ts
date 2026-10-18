import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import * as review from "#src/lib/review.js";
import { reviewCommand, reviewAttemptsForInput, type ReviewRunResult } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { ghShim } from "./helpers/gh-shim.js";

const HEAD = "1234567890abcdef1234567890abcdef12345678";
const PR = "https://github.com/acme/portal/pull/8";
const BODY = "## Acceptance\n- works — grep: x in src/app.ts\n";
const INPUT = review.reviewInputDigest(HEAD, BODY);
const verdict = {
  state: "success", headSha: HEAD, reviewerOutcome: "reviewer_completed", keywordOnly: false,
  criteria: [{ claim: "works", proof: "grep: x in src/app.ts", met: true, reason: "executed", proof_exec: "executed_pass" }],
  testTheater: false, summary: "immutable verdict", floorDegraded: false,
  capped: false, planOnly: false, decisionDisposition: "replayed", reviewDecisionDigest: "v2:decision",
} as ReviewRunResult;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-publisher-replay-"));
  const savedEnv = { ...process.env };
  const shim = ghShim([{ when: "", stderr: "fixture: publishing credential unreadable", exit: 1 }]);
  t.after(() => {
    process.env = savedEnv;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.REMUDERO_REVIEWER_TOKEN;
  delete process.env.REMUDERO_REVIEWER_LOGIN;
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const seed = () => appendLedger(ledgerPath, {
    run_id: "original", task_id: "PR-8", step: "review.posted", pr_url: PR, head_sha: HEAD,
    review_input_digest: INPUT, review_decision_digest: "v2:decision", state: "success",
    proof_exec: ["executed_pass"], decision_verdict: verdict,
  });
  seed();
  const posts: string[] = [];
  let status: unknown = { state: "success", posterLogin: "human", posterType: "User" };
  let binding: unknown = { contexts: [review.REVIEW_CONTEXT], checks: [{ context: review.REVIEW_CONTEXT, app_id: 42 }] };
  let app: unknown = { id: 42, slug: "fleet" };
  let lifecycle = { merged: false, closed: false, reviewInputDigest: INPUT, baseRef: "main" };
  const fetch = (args: string[]) => {
    if (args[1]?.endsWith("required_status_checks")) {
      if (binding instanceof Error) throw binding;
      return binding;
    }
    if (args[1]?.startsWith("apps/")) {
      if (app instanceof Error) throw app;
      return app;
    }
    throw new Error(`unexpected read ${args.join(" ")}`);
  };
  const options = {
    owner: "acme", repo: "portal", sha: HEAD, state: "success" as const, taskId: "PR-8",
    evidence: "executed" as const, ledgerPath, runId: "replay", prUrl: PR,
    reviewInputDigest: INPUT, reviewDecisionDigest: "v2:decision",
    fetchLifecycle: () => lifecycle,
    fetchCurrentStatus: () => status as review.ReviewStatusEntry,
    fetchPublisher: fetch,
    post: ({ state }: { state: string }) => { posts.push(state); },
  };
  return {
    root, ledgerPath, options, posts, seed, shim,
    status: (value: unknown) => { status = value; },
    binding: (value: unknown) => { binding = value; },
    app: (value: unknown) => { app = value; },
    lifecycle: (value: typeof lifecycle) => { lifecycle = value; },
    rows: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

async function nativePublisher() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GH_APP_ID = "42";
  process.env.GH_APP_INSTALLATION_ID = "7";
  process.env.GH_APP_PRIVATE_KEY_PATH = "/fixture/key";
  const result = await review.refreshReviewPublisherToken({
    readKey: () => privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    fetchImpl: (async () => new Response(JSON.stringify({
      token: "fixture-native-token", expires_at: new Date(Date.now() + 600_000).toISOString(),
    }))) as typeof fetch,
  });
  assert.equal(result.ok, true);
}

test("W1-T8959: replay refuses equal states from the wrong or unknown required publisher", async t => {
  const f = fixture(t);
  for (const status of [
    { state: "success", posterLogin: "human", posterType: "User" },
    { state: "success", posterLogin: "other[bot]", posterType: "Bot" },
    { state: "success" },
    "success",
  ]) {
    f.status(status);
    f.app({ id: 99, slug: "other" });
    const result = await review.postReviewStatusGuarded(f.options);
    assert.equal(result.replayed, undefined);
    assert.equal(result.posted, false);
    assert.match(result.reason!, /publisher|creator/);
  }
  assert.deepEqual(f.posts, []);
  assert.equal(f.rows().filter(row => row.step === "review.post_refused").length, 4);
});

test("W1-T8959: authorized publisher restores replay without changing the decision or rejudging", async t => {
  const f = fixture(t);
  await nativePublisher();
  const original = f.rows()[0];
  for (const status of [
    { state: "success", posterLogin: "human", posterType: "User" },
    { state: "failure", posterLogin: "human", posterType: "User" },
    { state: "pending", posterLogin: "fleet[bot]", posterType: "Bot" },
    undefined,
  ]) {
    f.status(status);
    const result = await review.postReviewStatusGuarded(f.options);
    assert.equal(result.posted, true);
    assert.equal(result.publisherEvidence?.requiredAppId, 42);
  }
  assert.deepEqual(f.posts, ["success", "success", "success", "success"]);
  assert.deepEqual(f.rows()[0], original);
  const decision = await review.claimReviewDecision({ ledgerPath: f.ledgerPath, taskId: "PR-8", prUrl: PR, digest: "v2:decision" });
  assert.equal(decision.kind, "replay", "recovery keeps the completed decision rather than reopening a model review");
  if (decision.kind === "replay") assert.deepEqual(decision.terminal.verdict, verdict);
  process.env.REMUDERO_REVIEWER_TOKEN = "operator-token";
  assert.equal((await review.postReviewStatusGuarded(f.options)).posted, false);
  assert.equal(f.posts.length, 4);
  delete process.env.REMUDERO_REVIEWER_TOKEN;
  process.env.GH_TOKEN = "different-native-looking-token";
  assert.equal((await review.postReviewStatusGuarded(f.options)).posted, false);
});

test("W1-T8959: trusted replay confirmation preserves conflicts lifecycle and legacy compatibility", async t => {
  const f = fixture(t);
  f.status({ state: "success", posterLogin: "fleet[bot]", posterType: "Bot", posterId: 9000 });
  const confirmed = await review.postReviewStatusGuarded(f.options);
  assert.equal(confirmed.replayed, true);
  assert.deepEqual(confirmed.publisherEvidence, {
    requiredAppId: 42, posterLogin: "fleet[bot]", publisherAppId: 42, source: "required-app",
  });
  f.status({ state: "failure", posterLogin: "fleet[bot]", posterType: "Bot" });
  assert.match((await review.postReviewStatusGuarded(f.options)).reason!, /conflicting terminal/);
  for (const lifecycle of [
    { merged: true, closed: false, reviewInputDigest: INPUT, baseRef: "main" },
    { merged: false, closed: true, reviewInputDigest: INPUT, baseRef: "main" },
    { merged: false, closed: false, reviewInputDigest: "body-moved", baseRef: "main" },
  ]) {
    f.lifecycle(lifecycle);
    assert.equal((await review.postReviewStatusGuarded(f.options)).replayed, undefined);
  }
  f.lifecycle({ merged: false, closed: false, reviewInputDigest: INPUT, baseRef: "main" });
  f.status({ state: "success", posterLogin: "fleet[bot]", posterType: "Bot" });
  assert.match((await review.postReviewStatusGuarded({ ...f.options, evidence: "no_evidence" })).reason!, /executed-evidence/);
  assert.match((await review.postReviewStatusGuarded({ ...f.options,
    reviewerCodeFreshness: { status: "unreadable", reason: "fixture code read failed" },
  })).reason!, /freshness is unprovable/);
  f.binding({ checks: [{ context: review.REVIEW_CONTEXT, app_id: null }] });
  f.status({ state: "success", posterLogin: "human", posterType: "User" });
  assert.equal((await review.postReviewStatusGuarded(f.options)).replayed, true);
  process.env.REMUDERO_REVIEWER_LOGIN = "trusted";
  assert.equal((await review.postReviewStatusGuarded(f.options)).posted, false);
  f.status({ state: "success", posterLogin: "TRUSTED", posterType: "User" });
  assert.equal((await review.postReviewStatusGuarded(f.options)).replayed, true);
  assert.deepEqual(f.posts, []);
  // The shim echoes the actual child's credential as JSON, so the selected token determines identity.
  f.shim.addRoute({ when: "api user", stdoutEnv: "GH_TOKEN" });
  process.env.REMUDERO_REVIEWER_TOKEN = JSON.stringify({ login: "trusted" });
  f.status(undefined);
  assert.equal((await review.postReviewStatusGuarded(f.options)).posted, true,
    "known unpinned recovery uses the same dedicated credential as the existing poster");
  process.env.REMUDERO_REVIEWER_TOKEN = JSON.stringify({ login: "operator" });
  assert.equal((await review.postReviewStatusGuarded(f.options)).posted, false);
  assert.deepEqual(f.posts, ["success"]);
  delete process.env.REMUDERO_REVIEWER_TOKEN;
  delete process.env.REMUDERO_REVIEWER_LOGIN;
  f.binding({ checks: [{ context: review.REVIEW_CONTEXT, app_id: 42 }] });
  f.status({ state: "success", posterLogin: "fleet[bot]", posterType: "Bot" });
  for (const app of [null, { id: 42, slug: "wrong-slug" }, { id: "42", slug: "fleet" }, new Error("App metadata read failed")]) {
    f.app(app);
    assert.equal((await review.postReviewStatusGuarded(f.options)).replayed, undefined);
  }
  f.app({ id: 42, slug: "fleet" });
  for (const binding of [null, {}, { checks: null }, { contexts: [review.REVIEW_CONTEXT], checks: [] },
    { checks: [{ context: review.REVIEW_CONTEXT }] }, { contexts: 42, checks: [] },
    { checks: [{ context: review.REVIEW_CONTEXT, app_id: 42 }, { context: review.REVIEW_CONTEXT, app_id: null }] },
    new Error("source read failed")]) {
    f.binding(binding);
    const refused = await review.postReviewStatusGuarded(f.options);
    assert.equal(refused.replayed, undefined);
    assert.match(refused.reason!, /source/);
  }
});

test("W1-T8959: default review CLI retains publisher evidence and refuses unreadable provenance", async t => {
  const f = fixture(t);
  const response = {
    status: { context: review.REVIEW_CONTEXT, state: "success", creator: { login: "fleet[bot]", type: "Bot", id: 9000 } },
    binding: { checks: [{ context: review.REVIEW_CONTEXT, app_id: 42 }] },
    app: { id: 42, slug: "fleet" }, fail: false, allowPost: false,
    pr: { state: "open", merged: false, body: BODY, html_url: PR,
      head: { ref: "run-unfiled-1", sha: HEAD }, base: { ref: "main" }, number: 8 },
  };
  let reviewers = 0;
  const run = async () => {
    f.shim.addRoute({ when: `api repos/acme/portal/commits/${HEAD}/status`,
      stdout: JSON.stringify({ statuses: [response.status] }) });
    f.shim.addRoute({ when: "required_status_checks", stdout: JSON.stringify(response.binding),
      stderr: response.fail ? "source read unavailable" : undefined, exit: response.fail ? 1 : 0 });
    f.shim.addRoute({ when: "api apps/", stdout: JSON.stringify(response.app) });
    f.shim.addRoute({ when: "api repos/acme/portal/pulls/8", stdout: JSON.stringify(response.pr) });
    f.shim.addRoute({ when: "-X POST", stdout: "{}",
      stderr: response.allowPost ? undefined : "unauthorized post", exit: response.allowPost ? 0 : 1 });
    return reviewCommand("8", ["--repo", "acme/portal"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "portal" }),
      enforceReviewSubjectCheckout: false,
      loadConfig: () => ({ root: f.root, installRoot: join(import.meta.dirname, "..") }) as Config,
      fetchHead: () => {}, postReviewPending: async () => ({ posted: false }),
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }) as never,
      runReview: (async () => { reviewers++; return { ...verdict }; }) as never,
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
    });
  };
  assert.equal(await run(), 0);
  const receipt = f.rows().findLast(row => row.status_confirmed);
  assert.equal(receipt.status_publisher.publisherAppId, 42);
  assert.equal(receipt.review_input_digest, INPUT);
  assert.equal(reviewAttemptsForInput(f.rows(), "PR-8", PR, HEAD, INPUT).attempts, 2);
  response.status.creator = { login: "human", type: "User", id: 42 };
  assert.equal(await run(), 2);
  response.fail = true;
  assert.equal(await run(), 2);
  response.fail = false;
  response.binding = { checks: [{ context: review.REVIEW_CONTEXT, app_id: "bad" as never }] };
  assert.equal(await run(), 2);
  assert.equal(reviewers, 4, "only immutable-decision lookup runs; no new judge is requested");
  assert.equal(f.rows().filter(row => row.status_confirmed).length, 1);
  assert.match(f.rows().findLast(row => row.step === "review.post_refused").reason, /source.*malformed/);
  response.binding = { checks: [{ context: review.REVIEW_CONTEXT, app_id: 42 }] };
  response.status.creator = undefined as never;
  assert.equal(await run(), 2);
  response.status.state = "unrecognized";
  assert.equal(await run(), 2);
  response.status.state = "error";
  response.status.creator = { login: "human", type: "User", id: 42 };
  await nativePublisher();
  response.allowPost = true;
  assert.equal(await run(), 0, "the real default poster restores a wrong-source failure using its existing native credential");
  const recovered = f.rows().findLast(row => row.status_recovered);
  assert.equal(recovered.review_decision_digest, "v2:decision");
  assert.equal(recovered.status_publisher.requiredAppId, 42);
  assert.equal(recovered.state, "success");
  assert.deepEqual(f.rows()[0].decision_verdict, verdict);
  assert.ok(f.shim.calls().some(call => call.includes(`/commits/${HEAD}/status`)));
});
