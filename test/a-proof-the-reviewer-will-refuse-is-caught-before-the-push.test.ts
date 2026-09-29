import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { certainHeadRefusals } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * 2026-09-29 — the worker half of "reviewer-unmet", the CI-friction gardener's costliest cause. MEASURED 2026-09-15..29:
 * 14 of 40 reviewer-unmet fix rounds were a build head whose `unit test:` title matched no test (#5646 #5770 #5840
 * #5865 #6516 never wrote the title; #5733 #5841 #5848 carried it only in a comment header). The reviewer's own
 * functions answer that offline, so the pre-push hook asks them before the push.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { proofResolveVerdict } = (await import(pathToFileURL(join(REPO_ROOT, "scripts/proof-resolve-precheck.mjs")).href)) as {
  proofResolveVerdict: (input: {
    diff: string;
    headRef: string;
    headMessage: string;
    resolveCriteria: (taskId: string) => AcceptanceCriterion[];
    refusalsFor: (criteria: AcceptanceCriterion[]) => { claim: string; proof: string; why: string }[];
  }) => { exit: number; lines: string[] };
};

function withHead(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}proof-precheck-`));
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

const REAL_TEST = 'import { test } from "node:test";\ntest("the widget names its owner", () => {});\n';
const COMMENT_ONLY = '// ── ACCEPTANCE 1: the widget refuses a stranger ──\ntest("owner check", () => {});\n';

test("a unit test title no test carries is a certain refusal before the push", () => {
  withHead({ "test/widget.test.ts": REAL_TEST }, (dir) => {
    const refusals = certainHeadRefusals([{ claim: "c", proof: "unit test: widgetRefusesAStranger" }], dir);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0].why, /no file under test\/ contains the title/);
  });
});

test("a unit test title carried only in a comment is a certain refusal before the push", () => {
  withHead({ "test/widget.test.ts": COMMENT_ONLY }, (dir) => {
    const refusals = certainHeadRefusals([{ claim: "c", proof: "unit test: the widget refuses a stranger" }], dir);
    assert.equal(refusals.length, 1, "the title sits in a comment header, never in test(...)");
    assert.match(refusals[0].why, /only in comments/);
  });
});

test("a missing pure-path test file and a grep with no match are certain refusals", () => {
  withHead({ "test/widget.test.ts": REAL_TEST, "src/widget.ts": "export const owner = 1;\n" }, (dir) => {
    const refusals = certainHeadRefusals(
      [
        { claim: "file", proof: "unit test: test/never-written.test.ts" },
        { claim: "grep", proof: "grep: resolveOwner( in src/widget.ts" },
      ],
      dir,
      () => "fail",
    );
    assert.deepEqual(refusals.map((r) => r.claim), ["file", "grep"]);
  });
});

test("what the reviewer would not hard-refuse is never reported", () => {
  withHead({ "test/widget.test.ts": REAL_TEST }, (dir) => {
    const criteria: AcceptanceCriterion[] = [
      { claim: "real title", proof: "unit test: the widget names its owner" },
      { claim: "prose", proof: "unit test: a stranger is refused, and the refusal names the owner it checked against" },
      { claim: "holdout", proof: "unit test: holdoutTitleNobodyWrote", holdout: true },
      { claim: "credited", proof: "unit test: creditedTitleNobodyWrote", satisfied_by: "#1" },
      { claim: "no dialect", proof: "the widget works" },
      { claim: "exec error", proof: "grep: owner in src/widget.ts" },
    ];
    const refusals = certainHeadRefusals(criteria, dir, () => {
      throw new Error("environment gap");
    });
    assert.deepEqual(refusals, [], "a holdout proof must never reach a worker, and degrades are not refusals");
  });
});

const BUILD_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const PLAN_DIFF =
  "diff --git a/plan/tasks.d/W1-T9-x.yaml b/plan/tasks.d/W1-T9-x.yaml\n--- /dev/null\n+++ b/plan/tasks.d/W1-T9-x.yaml\n@@ -0,0 +1 @@\n+- id: W1-T9\n";
const ONE: AcceptanceCriterion[] = [{ claim: "c", proof: "unit test: widgetRefusesAStranger" }];

test("the pre-push verdict blocks a title miss and only reports a grep miss", () => {
  const base = { diff: BUILD_DIFF, headRef: "run-W1-T9-1790000000000", headMessage: "feat: x", resolveCriteria: () => ONE };
  const titled = proofResolveVerdict({ ...base, refusalsFor: () => [{ claim: "c", proof: ONE[0].proof, why: "absent" }] });
  assert.equal(titled.exit, 1);
  assert.match(titled.lines.join("\n"), /LITERAL substring of a test NAME/);
  const grepped = proofResolveVerdict({ ...base, refusalsFor: () => [{ claim: "c", proof: "grep: x in src/a.ts", why: "none" }] });
  assert.equal(grepped.exit, 0, "a plan grep the worker may not edit must never strand the task without a PR");
  assert.match(grepped.lines.join("\n"), /WILL REFUSE 1/);
});

test("the pre-push verdict has no opinion on a filing or an unresolved task", () => {
  const never = () => {
    throw new Error("must not be asked");
  };
  const filing = proofResolveVerdict({ diff: PLAN_DIFF, headRef: "run-W1-T9-1790000000000", headMessage: "", resolveCriteria: never, refusalsFor: never });
  assert.equal(filing.exit, 0);
  const untasked = proofResolveVerdict({ diff: BUILD_DIFF, headRef: "feature", headMessage: "fix: y", resolveCriteria: never, refusalsFor: never });
  assert.match(untasked.lines[0], /no task resolved/);
  const trailer = proofResolveVerdict({
    diff: BUILD_DIFF,
    headRef: "feature",
    headMessage: "fix: y\n\nRemudero-Task: W1-T9",
    resolveCriteria: () => [],
    refusalsFor: never,
  });
  assert.match(trailer.lines[0], /W1-T9 resolves no acceptance criteria/);
  const clean = proofResolveVerdict({ diff: BUILD_DIFF, headRef: "run-W1-T9-1790000000000", headMessage: "", resolveCriteria: () => ONE, refusalsFor: () => [] });
  assert.match(clean.lines[0], /OK -- 1 W1-T9 criteria/);
});

test("the precheck script runs for real and never blocks on a head it cannot read", () => {
  const run = (base: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/proof-resolve-precheck.mjs", "--base", base, "--head-ref", "run-NOSUCH-T0-1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  const clean = run("HEAD");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^proof-resolve-precheck: SKIP/);
  const unreadable = run("refs/heads/no-such-base-ref-for-this-fixture");
  assert.equal(unreadable.status, 2, "an unreadable head is exit 2, which the hook never counts as a refusal");
  assert.match(unreadable.stderr, /could not read this head/);
});
