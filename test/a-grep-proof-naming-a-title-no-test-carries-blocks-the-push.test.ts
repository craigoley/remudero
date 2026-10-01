import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { certainHeadRefusals } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

/**
 * W1-T5026. #8156 (W1-T4914) named its test "... recorded as clean with no conflicting paths" while the proof was
 * `grep: test("... recorded as clean" in test/merge-probe.test.ts`. The pattern ends at the closing quote, so the longer
 * title is a miss; the pre-push precheck REPORTED it and exited 0, and the fix cost a round. A title-literal grep against
 * a test file that EXISTS is as certain a refusal as a missing `unit test:` title, so it blocks; every other grep miss
 * stays report-only.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { proofResolveVerdict } = (await import(pathToFileURL(join(REPO_ROOT, "scripts/proof-resolve-precheck.mjs")).href)) as {
  proofResolveVerdict: (input: {
    diff: string;
    headRef: string;
    headMessage: string;
    resolveCriteria: (taskId: string) => AcceptanceCriterion[];
    refusalsFor: (criteria: AcceptanceCriterion[]) => { claim: string; proof: string; why: string; blocking?: true }[];
  }) => { exit: number; lines: string[] };
};

const SHORT = "W1-T4914: a clean test merge is recorded as clean";
const LONG = `${SHORT} with no conflicting paths`;
const CARRIES_LONG = `import { test } from "node:test";\ntest("${LONG}", () => {});\n`;
const BUILD_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

function withHead(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}title-grep-`));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const titleProof = (title: string, path = "test/merge-probe.test.ts"): AcceptanceCriterion[] => [
  { claim: "title", proof: `grep: test("${title}" in ${path}` },
];

function verdictOver(refusals: ReturnType<typeof certainHeadRefusals>) {
  return proofResolveVerdict({
    diff: BUILD_DIFF,
    headRef: "run-W1-T9-1790000000000",
    headMessage: "feat: x",
    resolveCriteria: () => titleProof(SHORT),
    refusalsFor: () => refusals,
  });
}

test("W1-T5026: a title grep the test file does not carry blocks the push", () => {
  withHead({ "test/merge-probe.test.ts": CARRIES_LONG }, (dir) => {
    const refusals = certainHeadRefusals(titleProof(SHORT), dir);
    assert.equal(refusals.length, 1, "the pattern ends at the closing quote; the longer title is a miss");
    assert.equal(refusals[0].blocking, true);
    const verdict = verdictOver(refusals);
    assert.equal(verdict.exit, 1, "the #8156 shape must stop the push");
    assert.match(verdict.lines.join("\n"), /ends at the closing quote/);
  });
});

test("W1-T5026: a grep miss that is not a title literal stays report-only", () => {
  withHead({ "test/merge-probe.test.ts": CARRIES_LONG, "src/widget.ts": "export const owner = 1;\n" }, (dir) => {
    const criteria: AcceptanceCriterion[] = [
      { claim: "source prose", proof: "grep: resolveOwner( in src/widget.ts" },
      { claim: "not a test call", proof: 'grep: it("no such title" in test/merge-probe.test.ts' },
    ];
    const refusals = certainHeadRefusals(criteria, dir, () => "fail");
    assert.deepEqual(refusals.map((r) => r.claim), ["source prose", "not a test call"]);
    for (const r of refusals) assert.equal(r.blocking, undefined, `${r.claim} must not carry the field`);
    // A pattern wrapped over several lines never parses as a dialect grep (the pattern's `.` stops at the newline), so
    // it reaches no refusal at all and can never block.
    const wrapped: AcceptanceCriterion[] = [{ claim: "wrapped", proof: 'grep: test("first half\nsecond half" in test/merge-probe.test.ts' }];
    assert.deepEqual(certainHeadRefusals(wrapped, dir, () => "fail"), []);
    const verdict = verdictOver(refusals);
    assert.equal(verdict.exit, 0, "a plan grep the worker may not edit must never strand the task without a PR");
    assert.match(verdict.lines.join("\n"), /WILL REFUSE 2/);
    assert.match(verdict.lines.join("\n"), /reported, not blocking/);
  });
});

test("W1-T5026: a title grep against an absent target stays report-only", () => {
  withHead({ "test/merge-probe.test.ts": CARRIES_LONG }, (dir) => {
    const refusals = certainHeadRefusals(
      [...titleProof(SHORT, "test/not-written-yet.test.ts"), ...titleProof(SHORT, "src/merge-probe.ts")],
      dir,
      () => "fail",
    );
    assert.equal(refusals.length, 2);
    for (const r of refusals) assert.equal(r.blocking, undefined, "a forward reference or a non-test target is not the builder's title");
    assert.equal(verdictOver(refusals).exit, 0);
  });
});

test("W1-T5026: a title grep that matches the carried title is not reported", () => {
  withHead({ "test/merge-probe.test.ts": CARRIES_LONG }, (dir) => {
    const refusals = certainHeadRefusals(titleProof(LONG), dir);
    assert.deepEqual(refusals, []);
    const verdict = proofResolveVerdict({
      diff: BUILD_DIFF,
      headRef: "run-W1-T9-1790000000000",
      headMessage: "",
      resolveCriteria: () => titleProof(LONG),
      refusalsFor: (c) => certainHeadRefusals(c, dir),
    });
    assert.equal(verdict.exit, 0);
    assert.match(verdict.lines[0], /OK -- 1 W1-T9 criteria/);
  });
});

const SHARD = (title: string) =>
  [
    "- id: W1-T9",
    "  title: fixture",
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  priority: 3",
    "  budget_usd: 1.00",
    "  files:",
    "    - test/merge-probe.test.ts",
    "  acceptance:",
    "    - claim: title",
    `      proof: 'grep: test("${title}" in test/merge-probe.test.ts'`,
    "  status: queued",
    "  attempts: 0",
    "",
  ].join("\n");

function runPrecheck(title: string): { status: number | null; stdout: string; stderr: string } {
  const repo = gitRepo({ kind: "title-grep-child" });
  try {
    mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
    writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "base");
    repo.git("checkout", "--quiet", "-b", "run-W1-T9-1790000000000");
    writeFileSync(join(repo.dir, "plan/tasks.d/W1-T9-fixture.yaml"), SHARD(title));
    mkdirSync(join(repo.dir, "test"), { recursive: true });
    writeFileSync(join(repo.dir, "test/merge-probe.test.ts"), CARRIES_LONG);
    mkdirSync(join(repo.dir, "src"), { recursive: true });
    writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 1;\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "feat: fixture\n\nRemudero-Task: W1-T9");
    const tsx = pathToFileURL(join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;
    const run = spawnSync(
      process.execPath,
      ["--import", tsx, join(REPO_ROOT, "scripts/proof-resolve-precheck.mjs"), "--base", "main", "--head-ref", "run-W1-T9-1790000000000"],
      { cwd: repo.dir, encoding: "utf8" },
    );
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    repo.cleanup();
  }
}

test("W1-T5026: the precheck script exits 1 for a real title miss", () => {
  const miss = runPrecheck(SHORT);
  assert.equal(miss.status, 1, miss.stderr);
  assert.match(miss.stderr, /WILL REFUSE 1/);
  const near = runPrecheck(LONG);
  assert.equal(near.status, 0, near.stderr);
  assert.match(near.stdout, /OK -- 1 W1-T9 criteria/);
});

test("W1-T5026: the pre-push proof-resolve block fails on exit 1 and not on exit 2", () => {
  const hook = readFileSync(join(REPO_ROOT, "hooks/pre-push"), "utf8");
  const block = /# BEGIN proof-resolve precheck[^\n]*\n([\s\S]*?)# END proof-resolve precheck/.exec(hook)?.[1];
  assert.ok(block, "the hook must still carry the proof-resolve block");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}title-grep-hook-`));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "scripts/proof-resolve-precheck.mjs"), "");
    writeFileSync(join(dir, "bin/node"), '#!/bin/sh\nexit "$FAKE_RC"\n');
    chmodSync(join(dir, "bin/node"), 0o755);
    const outcome = (rc: number) => {
      const run = spawnSync("bash", ["-c", `fail=0; head_ref=run-W1-T9-1; ${block}\necho "fail=$fail"`], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_RC: String(rc) },
      });
      return { out: run.stdout.trim(), err: run.stderr };
    };
    assert.equal(outcome(1).out, "fail=1", "exit 1 is a blocking refusal and must fail the push");
    const unreadable = outcome(2);
    assert.equal(unreadable.out, "fail=0", "exit 2 is an unreadable head and must never block");
    assert.match(unreadable.err, /could not read this head/);
    assert.equal(outcome(0).out, "fail=0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
