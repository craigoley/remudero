import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setProofSandboxForTests } from "#src/lib/review.js";
import { reviewHostedCiFileEvidence } from "#src/cli/commands/review.js";
import { runReview } from "#test/helpers/run-task-test.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const FILE = "test/loaded.test.ts";
const RECEIPT = `RMD-TEST-FILE-DIAGNOSTIC ${JSON.stringify({ phase: "completed", file: FILE })}`;
const target = { owner: "craigoley", repo: "remudero", headSha: "judged-head",
  criteria: [{ claim: "loaded child completes", proof: `unit test: ${FILE}` }] };

describe("test/review/the-review-is-told-whether-hosted-ci-passed-each-proof-file.test.ts", () => {
  test("runReview reads hosted proof evidence once for the judged head and feeds the binding judge", async t => {
    setProofSandboxForTests({ mode: "unsandboxed", reason: "disposable proof fixture" });
    t.after(() => setProofSandboxForTests());
    const repo = gitRepo({ scope: t, kind: "review-hosted-proof" });
    mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
    writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
    writeFileSync(join(repo.dir, FILE), "import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('loaded child', () => assert.equal(null, 2));\n");
    symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"), "dir");
    repo.git("add", "test");
    repo.git("commit", "-qm", "fixture proof");
    const headSha = repo.git("rev-parse", "HEAD");
    const prUrl = "https://github.com/craigoley/remudero/pull/15532";
    const check = { id: 12, name: "test-fast-shard (2/8)", status: "completed", conclusion: "success",
      details_url: "https://github.com/craigoley/remudero/actions/runs/4/job/7" };
    const diff = `diff --git a/${FILE} b/${FILE}\n--- /dev/null\n+++ b/${FILE}\n@@ -0,0 +1 @@\n+test('loaded child', () => assert.equal(null, 2));\n`;
    await withGhShim([
      { when: "pulls/15532", stdout: JSON.stringify({ number: 15532, state: "open", head: { sha: headSha, ref: "fixture" }, html_url: prUrl }) },
      { when: "pr diff", stdout: diff },
      { when: `/commits/${headSha}/check-runs?`, stdout: JSON.stringify({ check_runs: [check] }) },
      { when: `/commits/${headSha}/status`, stdout: '{"statuses":[]}' },
      { when: "actions/jobs/7/logs", stdout: RECEIPT },
      { when: "actions/jobs/7", stdout: JSON.stringify({ head_sha: headSha, name: check.name, conclusion: "success" }) },
      { when: "api", stdout: "{}" },
    ], async shim => {
      const result = await runReview({ owner: "craigoley", repo: "remudero", prUrl,
        task: { id: "W1-T11200", acceptance: [{ claim: "loaded child completes", proof: `unit test: ${FILE}` }], files: [FILE] },
        report: "loaded child completes", settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir } as never,
        headCheckoutDir: repo.dir, ledgerPath: join(repo.dir, ".git/ledger.ndjson"), runId: "review-hosted-proof",
        log: () => {}, say: () => {}, account: r => r, shadow: true, spawnReviewer: false,
        readReviewReuseFacts: () => undefined, runtimeImageSha: null,
      });
      assert.equal(result.criteria[0]?.proof_exec, "inconclusive_load", result.criteria[0]?.reason);
      assert.match(result.criteria[0]!.reason, /failed here while hosted CI passed the same file at this head/);
      assert.equal(result.state, "pending");
      assert.equal(shim.calls().filter(call => call.includes(`/commits/${headSha}/check-runs?`)).length, 1);
      assert.ok(shim.calls().some(call => call.includes("actions/jobs/7/logs")));
    });
  });

  test("W1-T11200 criterion 2: only the exact-head concluded shard that ran the file supplies its result", async () => {
    for (const scenario of [
      { conclusion: "success", log: RECEIPT, expected: "passed" },
      { conclusion: "failure", log: `${RECEIPT}\n✖ failing tests:\ntest at ${FILE}:2:1`, expected: "failed" },
      { conclusion: null, status: "in_progress", log: RECEIPT },
      { conclusion: "cancelled", log: RECEIPT },
      { conclusion: "success", log: RECEIPT, head: "another-head" },
      { conclusion: "success", log: RECEIPT.replace(FILE, "test/other.test.ts") },
      { conclusion: "success", log: `node --test ${FILE}\nok 1 - loaded child\n# tests 1\n# fail 0` },
      { conclusion: "success", log: RECEIPT, unreadable: true },
    ]) {
      const rows: Record<string, unknown>[] = [];
      const check = { id: 12, name: "test-fast-shard (2/8)", status: scenario.status ?? "completed",
        conclusion: scenario.conclusion, details_url: "https://github.com/craigoley/remudero/actions/runs/4/job/7" };
      await withGhShim([
        { when: "/check-runs?", stdout: JSON.stringify({ check_runs: [check] }) },
        { when: "/status", stdout: '{"statuses":[]}' },
        { when: "actions/jobs/7/logs", stdout: scenario.log, ...(scenario.unreadable ? { exit: 1, stderr: "job log denied" } : {}) },
        { when: "actions/jobs/7", stdout: JSON.stringify({ head_sha: scenario.head ?? target.headSha,
          name: check.name, conclusion: scenario.conclusion }) },
      ], async shim => {
        const evidence = await reviewHostedCiFileEvidence({ ...target,
          log: (step, extra) => rows.push({ step, ...extra }) });
        assert.equal(evidence?.get(FILE), scenario.expected, JSON.stringify(scenario));
        assert.equal(evidence?.get("test/other.test.ts"), undefined);
        assert.equal(shim.calls().filter(call => call.includes("/check-runs?")).length, 1);
        if (scenario.unreadable) {
          assert.equal(evidence, undefined);
          assert.equal(rows[0]?.step, "review.hosted_ci.unavailable");
          assert.equal(rows[0]?.head_sha, target.headSha);
          assert.match(String(rows[0]?.reason), /job log denied/);
        }
      });
    }
  });

  test("the per-file map retains failed evidence regardless of result order and rejects other heads", async () => {
    const result = { headSha: target.headSha, testFile: FILE, check: "test-fast-shard (2/8)", output: RECEIPT };
    for (const results of [
      [{ ...result, result: "pass" as const }, { ...result, result: "fail" as const }],
      [{ ...result, result: "fail" as const }, { ...result, result: "pass" as const }],
    ]) {
      let reads = 0;
      const evidence = await reviewHostedCiFileEvidence({ ...target, log: () => {} }, async (head, proofs) => {
        reads++;
        assert.equal(head, target.headSha);
        assert.deepEqual(proofs, [`unit test: ${FILE}`]);
        return [...results, { ...result, headSha: "old-head", testFile: "test/other.test.ts", result: "pass" },
          { ...result, testFile: "test/unrequested.test.ts", result: "pass" }];
      });
      assert.deepEqual(evidence, new Map([[FILE, "failed"]]));
      assert.equal(reads, 1);
    }
    assert.equal(await reviewHostedCiFileEvidence({ ...target, log: () => {} }, async () =>
      [{ ...result, headSha: "old-head", result: "pass" }]), undefined);
  });

  test("named and moved unit-test proofs resolve to the head's files before the single shared read", async t => {
    const repo = gitRepo({ scope: t, kind: "review-hosted-names" });
    mkdirSync(join(repo.dir, "test/review"), { recursive: true });
    const moved = "test/review/moved.test.ts";
    writeFileSync(join(repo.dir, moved), "test('a precise named proof', () => {});\n");
    repo.git("add", "test");
    repo.git("commit", "-qm", "fixture moved proof");
    let reads = 0;
    const evidence = await reviewHostedCiFileEvidence({ ...target, headCheckoutDir: repo.dir, log: () => {},
      criteria: [{ claim: "named proof", proof: "unit test: a precise named proof" },
        { claim: "moved proof", proof: "unit test: test/moved.test.ts" },
        { claim: "grep proof", proof: `grep: marker in ${FILE}` }] }, async (head, proofs) => {
      reads++;
      assert.deepEqual(proofs, [`unit test: ${moved}`]);
      return [{ headSha: head, testFile: moved, check: "test-fast-shard (2/8)", result: "pass", output: RECEIPT }];
    });
    assert.deepEqual(evidence, new Map([[moved, "passed"]]));
    assert.equal(reads, 1);
    let absentReads = 0;
    assert.equal(await reviewHostedCiFileEvidence({ ...target, headCheckoutDir: repo.dir, log: () => {},
      criteria: [{ claim: "absent title", proof: "unit test: a missing title" }] }, async () => {
      absentReads++;
      return [];
    }), undefined);
    assert.equal(absentReads, 0, "an unresolved title supplies no physical test file to read");
  });

  test("an unreadable hosted check read leaves the field absent with the exact-head reason", async () => {
    const rows: Record<string, unknown>[] = [];
    assert.equal(await reviewHostedCiFileEvidence({ ...target, log: (step, extra) => rows.push({ step, ...extra }) },
      async () => { throw new Error("checks denied"); }), undefined);
    assert.deepEqual(rows, [{ step: "review.hosted_ci.unavailable", head_sha: target.headSha, reason: "Error: checks denied" }]);
    let grepReads = 0;
    assert.equal(await reviewHostedCiFileEvidence({ ...target, criteria: [{ claim: "grep", proof: "grep: x in src/x.ts" }],
      log: () => {} }, async () => { grepReads++; return []; }), undefined);
    assert.equal(grepReads, 0, "a grep proof needs no hosted test evidence");
  });
});
