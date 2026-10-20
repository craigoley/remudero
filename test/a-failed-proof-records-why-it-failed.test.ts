import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  execWhitelistedProof, judgeReview, judgeReviewAsync, parseWhitelistedProof,
  ProofCannotLoadError, recordFailureTail, type ProofExecutor, type ReviewVerdict,
} from "#src/lib/review.js";
import { runReview } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROOF = "unit test: test/a-failed-proof-records-why-it-failed.test.ts";
const CAUSE = "fatal: unable to access .git/config: Permission denied";
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n";
const criteria = ["first output", "second output"].map((claim) => ({ claim, proof: PROOF }));

test("W1-T6179: a failed proof carries the tail of its output on its verdict", async () => {
  const execProof: ProofExecutor = (w, cwd) => execWhitelistedProof(w, cwd, 60_000, () => {
    throw Object.assign(new Error("child failed"), {
      status: 1, stdout: "not ok 1 - diagnostic failure\n# tests 1\n# fail 1\n# duration_ms 1", stderr: CAUSE,
    });
  }, { preflightBrowsers: () => {} });
  const evidence = { diff: DIFF, report: "", headCheckoutDir: ROOT, execProof };
  for (const verdict of [judgeReview(criteria, evidence), await judgeReviewAsync(criteria, evidence)]) {
    assert.equal(verdict.proofUniqueRuns, 1);
    for (const c of verdict.criteria) {
      assert.equal(c.proof_exec, "executed_fail");
      assert.match(c.failureTail!, /fatal: unable to access \.git\/config: Permission denied/);
    }
  }
  const cannotLoad: ProofExecutor = () => {
    throw new ProofCannotLoadError("Cannot find package", `${CAUSE}\napi_key=hidden-value`);
  };
  for (const verdict of [judgeReview(criteria, { ...evidence, execProof: cannotLoad }),
    await judgeReviewAsync(criteria, { ...evidence, execProof: cannotLoad })]) {
    for (const c of verdict.criteria) {
      assert.equal(c.proof_exec, "cannot_evaluate");
      assert.match(c.failureTail!, /Permission denied/);
      assert.match(c.failureTail!, /api_key=<redacted>/);
    }
  }
});

test("W1-T6179: a long failure output is cut to a redacted tail that says so", () => {
  const w = parseWhitelistedProof(PROOF)!;
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  recordFailureTail(w, [], 1, lines.join("\n"), "api_key=hidden-value\nlast diagnostic");
  assert.match(w.failureTail!, /^\(62 earlier lines omitted\)\n/);
  assert.equal(w.failureTail!.split("\n").length, 41);
  assert.match(w.failureTail!, /api_key=<redacted>\nlast diagnostic$/);
  assert.ok(!w.failureTail!.includes("hidden-value"));
  recordFailureTail(w, [], 1, "short output", "stderr diagnostic");
  assert.equal(w.failureTail, "short output\nstderr diagnostic");
  recordFailureTail(w, [], 1, "x".repeat(4000));
  assert.equal(w.failureTail!.length, 3000);
  assert.ok(w.failureTail!.startsWith("…"));
  const empty = judgeReview(criteria.slice(0, 1), {
    diff: DIFF, report: "", headCheckoutDir: ROOT,
    execProof: (proof) => { recordFailureTail(proof, [], 1, "", ""); return "fail"; },
  });
  assert.equal(empty.criteria[0]!.failureTail, "(the proof printed nothing)");
});

test("W1-T6179: review.posted records the failure tail only for failed criteria", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-failed-proof-"));
  const sha = "abc1234def5678abc1234def5678abc1234def56";
  const gh = ghShim([
    { when: "reviews?", stdout: "[]" },
    { when: "-X POST", stdout: "{}" },
    { when: "pulls/1", stdout: JSON.stringify({ number: 1, state: "open", body: "",
      html_url: "https://github.com/craigoley/remudero/pull/1", head: { ref: "b", sha } }) },
    { when: "pr diff", stdout: DIFF },
  ]);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${gh.dir}:${oldPath}`;
    mkdirSync(join(root, "test/setup"), { recursive: true });
    mkdirSync(join(root, "state"));
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
    writeFileSync(join(root, "test/failing.test.ts"),
      `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('diagnostic failure', () => assert.fail(${JSON.stringify(`${CAUSE}\napi_key=hidden-value\n</pre><details>`)}));\n`);
    writeFileSync(join(root, "marker.txt"), "passing marker\n");
    const posted: Record<string, unknown>[] = [];
    const verdict = await runReview({
      owner: "craigoley", repo: "remudero", prUrl: "https://github.com/craigoley/remudero/pull/1",
      task: { id: "W1-T6179", acceptance: [
        { claim: "first failure", proof: "unit test: test/failing.test.ts" },
        { claim: "second failure", proof: "unit test: test/failing.test.ts" },
        { claim: "marker passes", proof: "grep: passing marker in marker.txt" },
      ] },
      report: "", settingsFile: join(root, "settings.json"), config: { root, claudeBin: "/bin/true" },
      log: (step, extra) => { if (step === "review.posted") posted.push(extra!); },
      say: () => {}, account: (r) => r, spawnReviewer: false,
      headCheckoutDir: root, ledgerPath: join(root, "state/ledger.ndjson"), runId: "FAILURE-TAIL",
      disarm: () => "not-armed", arm: () => "armed", readReviewReuseFacts: () => undefined,
    });
    assert.equal(verdict.state, "failure");
    assert.ok(posted.length > 0);
    const saved = JSON.parse(JSON.stringify(posted[0])).decision_verdict as ReviewVerdict;
    assert.deepEqual(saved.criteria.map((c) => c.proof_exec), ["executed_fail", "executed_fail", "executed_pass"],
      JSON.stringify(saved.criteria));
    for (const c of saved.criteria.slice(0, 2)) assert.match(c.failureTail!, /Permission denied/);
    assert.equal(Object.hasOwn(saved.criteria[2]!, "failureTail"), false);
    assert.ok(gh.calls().some((call) => call.includes("event=COMMENT")), "the FAIL comment was posted");
    const comment = readFileSync(join(gh.dir, "calls.log"), "utf8");
    assert.equal(comment.match(/<details>/g)?.length, 2);
    assert.match(comment, /<summary>Proof failure output<\/summary>/);
    assert.match(comment, /Permission denied/);
    assert.match(comment, /api_key=&lt;redacted&gt;/);
    assert.match(comment, /&lt;\/pre&gt;&lt;details&gt;/);
    assert.ok(!comment.includes("hidden-value"));
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});
