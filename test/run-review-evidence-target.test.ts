import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runReview } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";

const REPO_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const REVIEWER_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
const SOURCE_TEXT_SUBJECT_MARKER = "@source-text-subject";

async function reviewSiteProof(): Promise<Awaited<ReturnType<typeof runReview>>> {
  const root = mkdtempSync(join(tmpdir(), "rmd-run-review-target-root-"));
  const checkout = mkdtempSync(join(tmpdir(), "rmd-run-review-site-head-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const diff = [
    "diff --git a/tests/site-target.test.ts b/tests/site-target.test.ts",
    "+++ b/tests/site-target.test.ts",
    "@@",
    "+import { test, expect } from 'vitest';",
    "+test('site registered suite proof reaches vitest', () => {",
    "+  expect(1 + 1).toBe(2);",
    "+});",
  ].join("\n");
  const gh = ghShim([
    { when: "headRefOid", stdout: '{"headRefOid":"abc1234def5678abc1234def5678abc1234def56"}' },
    { when: "state", stdout: '{"state":"OPEN"}' },
    { when: "pulls/", stdout: '{"number":1,"html_url":"https://github.com/craigoley/remudero-site/pull/7","updated_at":"t","body":"","head":{"ref":"b","sha":"abc1234def5678abc1234def5678abc1234def56"}}' },
    { when: "pr diff", stdout: diff },
  ]);
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(checkout, "tests"), { recursive: true });
    writeFileSync(join(root, "settings.json"), "{}", "utf8");
    writeFileSync(join(checkout, "package.json"), '{"type":"module"}\n', "utf8");
    symlinkSync(join(REPO_ROOT, "node_modules"), join(checkout, "node_modules"), "dir");
    writeFileSync(
      join(checkout, "tests", "site-target.test.ts"),
      [
        "import { test, expect } from 'vitest';",
        "test('site registered suite proof reaches vitest', () => {",
        "  expect(1 + 1).toBe(2);",
        "});",
      ].join("\n"),
      "utf8",
    );
    process.env.PATH = `${gh.dir}:${oldPath}`;
    process.env.HOME = root;

    return await runReview({
      owner: "craigoley",
      repo: "remudero-site",
      prUrl: "https://github.com/craigoley/remudero-site/pull/7",
      task: {
        id: "W1-T3529",
        acceptance: [
          {
            claim: "the site target proof reaches its registered tests suite",
            proof: "unit test: tests/site-target.test.ts",
          },
        ],
        files: ["tests/site-target.test.ts"],
      },
      report: "Body intentionally does not contain proof keywords; only execution can pass this.",
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: () => {},
      say: () => {},
      account: (r: WorkerResult) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      headCheckoutDir: checkout,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "REVIEW-TARGET-1",
      disarm: () => "not-armed" as const,
      arm: () => "armed" as const,
    });
  } finally {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

test("W1-T3529: runReview passes its owner/repo target through to judgeReview evidence", async () => {
  const verdict = await reviewSiteProof();
  assert.equal(verdict.state, "success", "the remudero-site registered tests/ proof must execute");
  assert.equal(verdict.criteria[0]?.proof_exec, "executed_pass");
  assert.match(verdict.criteria[0]?.reason ?? "", /tests\/site-target\.test\.ts/);
});

test("W1-T3529: runReview does not re-derive the target from a bare repo name", () => {
  assert.equal(SOURCE_TEXT_SUBJECT_MARKER, "@source-text-subject");
  const src = readRunTaskSource();
  const runReviewStart = src.indexOf("async function runReview(args:");
  assert.notEqual(runReviewStart, -1, "runReview must still be present");
  const judgeCall = src.indexOf("const computed = judgeReview(criteria, {", runReviewStart);
  assert.notEqual(judgeCall, -1, "runReview must still call judgeReview");
  const evidence = src.slice(judgeCall, src.indexOf("});", judgeCall));
  assert.match(evidence, /target: \{ owner, repo \},/);
  assert.doesNotMatch(evidence, /repo\.split|prUrl|parseOwnerRepo/, "runReview must not reconstruct target from another string");
});

test("W1-T3529: the fix-rung path still relies on its existing runReview owner/repo forwarding", () => {
  const src = readRunTaskSource();
  const call = src.indexOf("review = await deps.runReview({");
  assert.notEqual(call, -1, "the fix-rung re-review call must still exist");
  const args = src.slice(call, src.indexOf("});", call));
  assert.match(args, /owner: opts\.reviewBase\.owner,/);
  assert.match(args, /repo: opts\.reviewBase\.repo,/);
  assert.doesNotMatch(args, /target:/, "the fix rung must not grow a second independent target forwarding point");
});

test("W1-T3529: every pre-existing judgeReview evidence field remains in the runReview call", () => {
  const src = readRunTaskSource();
  const runReviewStart = src.indexOf("async function runReview(args:");
  const judgeCall = src.indexOf("const computed = judgeReview(criteria, {", runReviewStart);
  const evidence = src.slice(judgeCall, src.indexOf("});", judgeCall));
  for (const field of [
    "diff",
    "report",
    "semantic",
    "headCheckoutDir: args.headCheckoutDir",
    "baseCheckoutDir: args.baseCheckoutDir",
    "taskDeclaredFiles: task.files",
    "openTaskIds: args.openTaskIds",
  ]) {
    assert.ok(evidence.includes(field), `judgeReview evidence still carries ${field}`);
  }
});

function readRunTaskSource(): string {
  return readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
}
