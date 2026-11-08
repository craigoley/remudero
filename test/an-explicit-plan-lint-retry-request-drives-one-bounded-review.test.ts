import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import * as reviewCli from "#src/cli/commands/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { refreshReviewPublisherToken, type PlanLintOutcome } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { reviewOptionFlags, reviewOptionsFromFlags, runReview } from "#test/helpers/run-task-test.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const FLAG = "--plan-lint-retry";
const PR = "https://github.com/acme/portal/pull/133";
const INCOMPLETE: PlanLintOutcome = { ran: false, reason: "lint-plan exited 1 with no summary" };
const CLEAN: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: [] };

async function fixture(t: TestContext) {
  const savedEnv = { ...process.env };
  t.after(() => { process.env = savedEnv; });
  delete process.env.REMUDERO_REVIEWER_TOKEN;
  delete process.env.REMUDERO_REVIEWER_LOGIN;
  process.env.GH_APP_ID = "42";
  process.env.GH_APP_INSTALLATION_ID = "7";
  process.env.GH_APP_PRIVATE_KEY_PATH = "/fixture/key";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const refreshed = await refreshReviewPublisherToken({
    readKey: () => privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    fetchImpl: (async () => new Response(JSON.stringify({
      token: "fixture-native-token", expires_at: new Date(Date.now() + 600_000).toISOString(),
    }))) as typeof fetch,
  });
  assert.equal(refreshed.ok, true);
  const repo = gitRepo({ scope: t, kind: "plan-lint-cli-retry" });
  mkdirSync(join(repo.dir, "plan"));
  const planPath = join(repo.dir, "plan/tasks.yaml");
  writeFileSync(planPath, "- id: PORTAL-T90\n  title: previous filing\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "chore: seed plan");
  const mergeBaseSha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", mergeBaseSha);
  writeFileSync(planPath, "- id: PORTAL-T90\n  title: revised filing\n");
  repo.git("commit", "-qam", "chore: revise filing");
  const headSha = repo.git("rev-parse", "HEAD");
  const diff = repo.git("diff", mergeBaseSha, "HEAD");
  const root = ownedFixtureDir(t, "plan-lint-cli-retry").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  const wire = { headSha, mergeBaseSha, baseRef: "release/fixture", compareReadable: true,
    check: "success", required: ["ci", "remudero-review"], pinned: true };
  // The scripted GitHub, answered by the shared PATH shim: first match wins, so the most specific
  // substring leads. Rebuilt from `wire` on every `sync`, the newest table shadowing the older one.
  const routesFor = (): GhShimRoute[] => [
    { when: "POST", stdout: "{}" },
    { when: "pr diff", stdout: diff },
    { when: "pr review", stdout: "{}" },
    { when: "/reviews", stdout: "[]" },
    { when: "/pulls/133", stdout: JSON.stringify({ number: 133, html_url: PR, state: "open", merged: false,
      body: "the filing names its revision", head: { sha: wire.headSha, ref: "filing" }, base: { ref: wire.baseRef } }) },
    { when: "/compare/", ...(wire.compareReadable
      ? { stdout: JSON.stringify({ merge_base_commit: { sha: wire.mergeBaseSha }, files: [] }) }
      : { stderr: "fixture compare unreadable", exit: 1 }) },
    { when: "/required_status_checks", stdout: JSON.stringify({ contexts: wire.required,
      checks: wire.required.map(context => ({ context, app_id: context === "remudero-review" && wire.pinned ? 42 : null })) }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [
      ...(wire.check === "missing" ? [] : [{ name: "ci", status: wire.check === "pending" ? "in_progress" : "completed",
        conclusion: wire.check === "pending" ? null : wire.check }]),
      { name: "remudero-review", status: "completed", conclusion: "failure" }] }) },
    // The paginated status history is a list; it must lead the combined-status route, whose
    // substring "/status" would otherwise answer it with an object and read as unreadable history.
    { when: "/statuses?", stdout: "[]" },
    { when: "/statuses/", stdout: "{}" },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ];
  const shim = ghShim(routesFor(), { kind: "plan-lint-cli-retry-gh" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const sync = () => { for (const route of routesFor().reverse()) shim.addRoute(route); };
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  let lintRuns = 0;
  let lint: PlanLintOutcome = INCOMPLETE;
  let sequence = 0;
  const invoke = (flags: string[] = [], over: Partial<Parameters<typeof runReview>[0]> = {}) => runReview({
    owner: "acme", repo: "portal", prUrl: PR,
    task: { id: "PORTAL-T90", acceptance: [{ claim: "the filing names its revision", proof: "grep: revised filing in plan/tasks.yaml" }] },
    report: "the filing names its revision", settingsFile: join(root, "settings.json"),
    config: { root } as never, ledgerPath, runId: `fixture-review-${++sequence}`,
    log: (step, extra) => appendLedger(ledgerPath, { run_id: `fixture-review-${sequence}`, task_id: "PORTAL-T90", step, ...extra }),
    say: () => {}, account: r => r, spawnReviewer: false, runtimeImageSha: null,
    headCheckoutDir: repo.dir, arm: () => "ledger-refused", disarm: () => {},
    lintPlanForReviewFn: async () => { lintRuns++; return lint; },
    ...reviewOptionsFromFlags(flags), ...over,
  });
  const seeded = await invoke();
  assert.deepEqual([seeded.state, seeded.planOnly, seeded.capped, seeded.keywordOnly], ["failure", true, false, false]);
  const seedRow = readFileSync(ledgerPath, "utf8").split("\n").find(line => line && JSON.parse(line).step === "review.posted")!;
  assert.ok(seedRow, JSON.stringify({ seeded, rows: readLedgerLines(ledgerPath), calls: shim.calls() }));
  const seed = seedRow;
  assert.equal(JSON.parse(seed).merge_base_sha, mergeBaseSha);
  // The shim records calls as raw joined argv lines; a reset forgets those taken so far.
  let callsSeen = 0;
  const calls = (): string[] => shim.calls().slice(callsSeen);
  const reset = () => { writeFileSync(ledgerPath, seed + "\n"); callsSeen = shim.calls().length; lintRuns = 0; lint = CLEAN; };
  reset();
  const rows = () => readLedgerLines(ledgerPath);
  const retries = () => rows().filter(row => row.step === "review.plan_lint_retry");
  const posts = () => calls().filter(line => /(^| )state=(success|failure)( |$)/.test(line));
  return { headSha, mergeBaseSha, wire, sync, invoke, reset, rows, retries, calls, posts, seed,
    lintRuns: () => lintRuns, setLint: (value: PlanLintOutcome) => { lint = value; },
    assertSeed: () => assert.ok(readFileSync(ledgerPath, "utf8").split("\n").includes(seed)) };
}

describe("test/an-explicit-plan-lint-retry-request-drives-one-bounded-review.test.ts", () => {
  test("the operator flag accepts only a full head and is never synthesised by reviewOptionFlags", () => {
    assert.equal(reviewCli.PLAN_LINT_RETRY_FLAG, FLAG);
    const head = "a".repeat(40);
    assert.equal((reviewOptionsFromFlags([FLAG, head]) as reviewCli.ReviewCommandDeps).planLintRetryHead, head);
    for (const flags of [[], [FLAG], [FLAG, "--review-attempt-id"], [FLAG, "abc"], [FLAG, "g".repeat(40)]]) {
      assert.equal(Object.hasOwn(reviewOptionsFromFlags(flags), "planLintRetryHead"), false);
    }
    for (const planOnlyFiling of [undefined, true, false]) {
      const options = { planOnlyFiling, executionMode: "semantic" as const, planLintRetryHead: head,
        reviewAttemptId: "review-PR133-00000000-0000-4000-8000-000000000000" };
      assert.equal(reviewOptionFlags(options).includes(FLAG), false);
      assert.equal(Object.hasOwn(reviewOptionsFromFlags(reviewOptionFlags(options)), "planLintRetryHead"), false);
    }
  });

  test("W1-T11429 no flag preserves prior terminal", async t => {
    const f = await fixture(t);
    const result = await f.invoke();
    assert.equal(result.decisionDisposition, "replayed");
    assert.equal(result.state, "failure");
    assert.deepEqual(f.retries(), []);
    assert.equal(f.rows().some(row => row.step === "review.plan_lint_retry_not_requested"), false);
    assert.deepEqual(f.posts(), []);
    assert.equal(f.lintRuns(), 0);
    f.assertSeed();
  });

  test("one explicit request admits and publishes once; repeating it replays", async t => {
    const f = await fixture(t);
    const result = await f.invoke([FLAG, f.headSha]);
    assert.equal(result.state, "success");
    assert.equal(result.decisionDisposition, "computed");
    assert.equal(f.lintRuns(), 1);
    assert.equal(f.posts().length, 1);
    assert.ok(f.posts()[0].includes("state=success"));
    assert.deepEqual(f.retries().map(row => row.outcome), ["admitted", "published"]);
    assert.match(String(f.retries()[0].attempt_id), /^review-PR133-[0-9a-f-]{36}$/);
    assert.equal(new Set(f.retries().map(row => row.attempt_id)).size, 1);
    assert.equal(f.retries()[0].head_sha, f.headSha);
    assert.equal(f.retries()[0].merge_base_sha, f.mergeBaseSha);
    assert.equal(f.calls().filter(line => line.includes("/compare/")).length, 3,
      "one capture, then fresh reads at admission and publication");
    assert.ok(f.calls().some(line => line.includes("release%2Ffixture")), "capture uses the PR base branch");
    const repeats = await f.invoke([FLAG, f.headSha]);
    assert.equal(repeats.decisionDisposition, "replayed");
    assert.equal(f.lintRuns(), 1);
    assert.equal(f.posts().length, 1);
    assert.equal(f.retries().filter(row => row.outcome === "admitted").length, 1);
    assert.equal(f.retries().at(-1)?.outcome, "refused");
    f.assertSeed();
  });

  test("unmatched heads and unreadable bases name the uncaptured request and replay", async t => {
    const f = await fixture(t);
    for (const scenario of ["head", "base", "base-ref"]) {
      f.reset();
      f.wire.compareReadable = scenario !== "base";
      f.wire.baseRef = scenario === "base-ref" ? "" : "release/fixture";
      f.sync();
      const result = await f.invoke([FLAG, scenario === "head" ? "f".repeat(40) : f.headSha]);
      assert.equal(result.decisionDisposition, "replayed");
      assert.deepEqual(f.retries(), []);
      const refusal = f.rows().find(row => row.step === "review.plan_lint_retry_not_requested");
      assert.ok(refusal);
      assert.deepEqual([refusal.pr_number, refusal.owner, refusal.repo], [133, "acme", "portal"]);
      assert.match(String(refusal.reason), scenario === "head" ? /head/ : /base|compare/);
      assert.deepEqual(f.posts(), []);
      assert.equal(f.lintRuns(), 0);
      f.assertSeed();
    }
  });

  test("an incomplete retry spends its attempt even while the old failure remains terminal", async t => {
    const f = await fixture(t);
    f.setLint(INCOMPLETE);
    const result = await f.invoke([FLAG, f.headSha]);
    assert.equal(result.state, "failure");
    assert.deepEqual(f.retries().map(row => row.outcome), ["admitted", "incomplete"]);
    assert.deepEqual(f.posts(), []);
    assert.equal(f.lintRuns(), 1);
    f.setLint(CLEAN);
    const repeated = await f.invoke([FLAG, f.headSha]);
    assert.equal(repeated.decisionDisposition, "replayed");
    assert.equal(repeated.state, "failure");
    assert.equal(f.lintRuns(), 1);
    assert.deepEqual(f.retries().map(row => row.outcome), ["admitted", "incomplete", "refused"]);
    assert.match(String(f.retries().at(-1)?.reason), /already spent their retry/);
    assert.notEqual(f.retries()[0].attempt_id, f.retries().at(-1)?.attempt_id);
    assert.deepEqual(f.posts(), []);
    f.assertSeed();
  });

  test("publication observes a merge base that moves after the admitted lint starts", async t => {
    const f = await fixture(t);
    const result = await f.invoke([FLAG, f.headSha], {
      lintPlanForReviewFn: async () => {
        f.wire.mergeBaseSha = "f".repeat(40);
        f.sync();
        return CLEAN;
      },
    });
    assert.match(result.summary, /plan-only PR/);
    assert.deepEqual(f.retries().map(row => row.outcome), ["admitted", "refused"]);
    assert.match(String(f.retries().at(-1)?.reason), /merge base moved/);
    assert.deepEqual(f.posts(), []);
    assert.equal(f.rows().filter(row => row.step === "review.posted").length, 1);
    f.assertSeed();
  });

  test("unhealthy checks, missing checkout and unpinned publisher refuse through the guard", async t => {
    const f = await fixture(t);
    for (const scenario of ["failure", "pending", "missing", "incomplete", "protection", "checkout", "unpinned"]) {
      f.reset();
      f.wire.check = ["failure", "pending", "missing"].includes(scenario) ? scenario : "success";
      f.wire.required = scenario === "incomplete" ? ["ci", "missing-required", "remudero-review"] :
        scenario === "protection" ? [] : ["ci", "remudero-review"];
      f.wire.pinned = scenario !== "unpinned";
      f.sync();
      const result = await f.invoke([FLAG, f.headSha], scenario === "checkout" ? { headCheckoutDir: undefined } : {});
      assert.equal(result.decisionDisposition, "replayed", scenario);
      assert.equal(f.retries().length, 1, scenario);
      assert.equal(f.retries()[0].outcome, "refused", scenario);
      assert.match(String(f.retries()[0].reason), scenario === "checkout" ? /no PR-head checkout/ :
        scenario === "unpinned" ? /no pinned App id/ : /not fresh, complete and passing/, scenario);
      assert.deepEqual(f.posts(), [], scenario);
      assert.equal(f.lintRuns(), 0, scenario);
      f.assertSeed();
    }
  });

  test("a shadow carrying the flag spends no attempt", async t => {
    const f = await fixture(t);
    const result = await f.invoke([FLAG, f.headSha], { shadow: true });
    assert.equal(result.decisionDisposition, "replayed");
    assert.deepEqual(f.retries(), []);
    assert.deepEqual(f.posts(), []);
    assert.equal(f.lintRuns(), 0);
  });
});
