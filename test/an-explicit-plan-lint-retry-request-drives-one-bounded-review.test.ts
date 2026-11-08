import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import * as reviewCli from "#src/cli/commands/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { refreshReviewPublisherToken, type PlanLintOutcome } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { reviewOptionFlags, reviewOptionsFromFlags, runReview } from "#src/run-task.js";
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
  const wirePath = join(root, "wire.json");
  const callsPath = join(root, "calls.ndjson");
  const wire = { headSha, mergeBaseSha, baseRef: "release/fixture", compareReadable: true,
    check: "success", required: ["ci", "remudero-review"], pinned: true };
  const sync = () => writeFileSync(wirePath, JSON.stringify(wire));
  sync();
  writeFileSync(callsPath, "");
  writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(wirePath)}, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(a) + '\\n');
const route = a.find(value => value.startsWith('repos/')) || a[1] || '';
let result;
if (a[0] === 'pr' && a[1] === 'diff') {
  process.stdout.write(${JSON.stringify(diff)}); process.exit(0);
} else if (a[0] === 'pr' && a[1] === 'review') {
  result = {};
} else if (a[0] === 'api' && route.endsWith('/pulls/133')) {
  result = { number: 133, html_url: ${JSON.stringify(PR)}, state: 'open', merged: false, body: 'the filing names its revision',
    head: { sha: w.headSha, ref: 'filing' }, base: { ref: w.baseRef } };
} else if (a[0] === 'api' && route.includes('/reviews')) {
  result = a.includes('POST') ? {} : [];
} else if (a[0] === 'api' && route.includes('/compare/')) {
  if (!w.compareReadable) { process.stderr.write('fixture compare unreadable'); process.exit(1); }
  result = { merge_base_commit: { sha: w.mergeBaseSha }, files: [] };
} else if (a[0] === 'api' && route.endsWith('/required_status_checks')) {
  result = { contexts: w.required, checks: w.required.map(context => ({ context, app_id: context === 'remudero-review' && w.pinned ? 42 : null })) };
} else if (a[0] === 'api' && route.includes('/check-runs')) {
  result = { check_runs: w.check === 'missing' ? [] : [{ name: 'ci', status: w.check === 'pending' ? 'in_progress' : 'completed',
    conclusion: w.check === 'pending' ? null : w.check }] };
  result.check_runs.push({ name: 'remudero-review', status: 'completed', conclusion: 'failure' });
} else if (a[0] === 'api' && route.endsWith('/status')) {
  result = { statuses: [] };
} else if (a[0] === 'api' && route.includes('/statuses/')) {
  result = {};
} else { process.stderr.write('unexpected fixture gh: ' + JSON.stringify(a)); process.exit(1); }
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });
  process.env.PATH = `${root}:${process.env.PATH}`;
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
  assert.ok(seedRow, JSON.stringify({ seeded, rows: readLedgerLines(ledgerPath), calls: readFileSync(callsPath, "utf8") }));
  const seed = seedRow;
  assert.equal(JSON.parse(seed).merge_base_sha, mergeBaseSha);
  const reset = () => { writeFileSync(ledgerPath, seed + "\n"); writeFileSync(callsPath, ""); lintRuns = 0; lint = CLEAN; };
  reset();
  const rows = () => readLedgerLines(ledgerPath);
  const retries = () => rows().filter(row => row.step === "review.plan_lint_retry");
  const calls = (): string[][] => readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const posts = () => calls().filter(a => a.some(v => /^state=(success|failure)$/.test(v)));
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
    assert.equal(f.calls().filter(a => a[1]?.includes("/compare/")).length, 3,
      "one capture, then fresh reads at admission and publication");
    assert.ok(f.calls().some(a => a[1]?.includes("release%2Ffixture")), "capture uses the PR base branch");
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
