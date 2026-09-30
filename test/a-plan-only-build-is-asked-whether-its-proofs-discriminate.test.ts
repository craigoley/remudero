import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { certainStaleProofs, isDialectGrepProof, type StaleProofRow } from "../src/lib/proof-base-stale.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runPreflightProofs } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

/**
 * W1-T4921 — #7882 was W1-T4550's BUILD (branch run-W1-T4550-..., diff only a plan shard) and the pre-push precheck
 * skipped it as "a plan-only filing", while nothing pre-push asked the merge base whether a grep proof discriminates.
 * The reviewer's own classifier answers that for a grep proof in milliseconds, from one base blob, with no worktree.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { proofResolveVerdict } = (await import(pathToFileURL(join(REPO_ROOT, "scripts/proof-resolve-precheck.mjs")).href)) as {
  proofResolveVerdict: (input: {
    diff: string;
    headRef: string;
    headMessage: string;
    resolveCriteria: (taskId: string) => AcceptanceCriterion[];
    refusalsFor: (criteria: AcceptanceCriterion[]) => { claim: string; proof: string; why: string }[];
    staleFor?: (criteria: AcceptanceCriterion[]) => StaleProofRow[];
  }) => { exit: number; lines: string[] };
};

const PLAN_DIFF =
  "diff --git a/plan/tasks.d/W1-T9-x.yaml b/plan/tasks.d/W1-T9-x.yaml\n--- /dev/null\n+++ b/plan/tasks.d/W1-T9-x.yaml\n@@ -0,0 +1 @@\n+- id: W1-T9\n";
const ONE: AcceptanceCriterion[] = [{ claim: "c", proof: "grep: alreadyThere in a.txt" }];
const ROW: StaleProofRow = { claim: "c", proof: ONE[0].proof, why: "also matches at the merge base" };

test("W1-T4921: a plan-only build on a run branch is not skipped", () => {
  let asked = 0;
  const verdict = proofResolveVerdict({
    diff: PLAN_DIFF,
    headRef: "run-W1-T9-1790000000000",
    headMessage: "",
    resolveCriteria: () => {
      asked++;
      return ONE;
    },
    refusalsFor: () => [],
  });
  assert.equal(asked, 1, "a build whose diff is a plan shard still resolves its criteria");
  assert.match(verdict.lines[0], /OK -- 1 W1-T9 criteria/);
  assert.doesNotMatch(verdict.lines.join("\n"), /SKIP/);
});

test("W1-T4921: a plan-only filing on a non-run branch is still skipped", () => {
  const never = () => {
    throw new Error("a filing is never asked");
  };
  const verdict = proofResolveVerdict({
    diff: PLAN_DIFF,
    headRef: "feature",
    headMessage: "chore(plan): file W1-T9\n\nRemudero-Task: W1-T9",
    resolveCriteria: never,
    refusalsFor: never,
    staleFor: never,
  });
  assert.equal(verdict.exit, 0);
  assert.match(verdict.lines[0], /SKIP -- a plan-only filing \(no run-<taskId> branch\)/);
});

test("W1-T4921: a grep proof that also passes at the merge base is reported by name", () => {
  const stale = proofResolveVerdict({
    diff: PLAN_DIFF,
    headRef: "run-W1-T9-1790000000000",
    headMessage: "",
    resolveCriteria: () => ONE,
    refusalsFor: () => [],
    staleFor: () => [ROW],
  });
  assert.equal(stale.exit, 0, "a proof a builder may not edit must never strand the task without a pull request");
  const text = stale.lines.join("\n");
  assert.match(text, /1 of W1-T9's grep proofs ALSO PASS at the merge base/);
  assert.ok(text.includes(ROW.proof) && text.includes(ROW.why) && text.includes(ROW.claim), "the proof, claim and reason are named");
  assert.match(text, /kind: guard/);
  assert.match(text, /may not edit a criterion/);

  const both = proofResolveVerdict({
    diff: PLAN_DIFF,
    headRef: "run-W1-T9-1790000000000",
    headMessage: "",
    resolveCriteria: () => ONE,
    refusalsFor: () => [{ claim: "t", proof: "unit test: nobodyWroteThis", why: "absent" }],
    staleFor: () => [ROW],
  });
  assert.equal(both.exit, 1, "a title miss still blocks beside a stale grep");
  assert.match(both.lines.join("\n"), /WILL REFUSE 1[\s\S]*ALSO PASS at the merge base/);
});

/** A real repo: commit one holds `alreadyThere`; commit two adds `brandNew`. Returns the merge base (commit one). */
function twoCommitRepo(): { dir: string; base: string } {
  const repo = gitRepo({ kind: "proof-base-stale" });
  writeFileSync(join(repo.dir, "a.txt"), "alreadyThere\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "base");
  const base = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "a.txt"), "alreadyThere\nbrandNew\n");
  repo.git("commit", "-qam", "head");
  return { dir: repo.dir, base };
}

test("W1-T4921: the base blob is read by a real git show", () => {
  const { dir, base } = twoCommitRepo();
  const rows = certainStaleProofs(
    [
      { claim: "control", proof: "grep: alreadyThere in a.txt" },
      { claim: "added by the build", proof: "grep: brandNew in a.txt" },
    ],
    dir,
    base,
  );
  assert.deepEqual(
    rows.map((r) => r.claim),
    ["control"],
    "only the proof whose text the merge base already holds is stale; the one the build adds discriminates",
  );
  assert.match(rows[0].why, new RegExp(`merge base ${base.slice(0, 9)}`));
});

test("W1-T4921: the temp directory holding the base blob is removed", () => {
  const { dir, base } = twoCommitRepo();
  const made = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}proof-base-stale-test-`));
  const rows = certainStaleProofs([{ claim: "c", proof: "grep: alreadyThere in a.txt" }], dir, base, { makeDir: () => made });
  assert.equal(rows.length, 1);
  assert.equal(existsSync(made), false);
});

test("W1-T4921: what the reviewer would not grade stale is never reported", () => {
  const { dir, base } = twoCommitRepo();
  const grep = "grep: alreadyThere in a.txt";
  const criteria = [
    { claim: "credited", proof: grep, satisfied_by: "#1" },
    { claim: "guard", proof: grep, kind: "guard" },
    { claim: "holdout", proof: grep, holdout: true },
    { claim: "a test", proof: "unit test: alreadyThere" },
    { claim: "prose", proof: "the widget works" },
    { claim: "fenced", proof: "`grep -rn alreadyThere a.txt`" },
    { claim: "added at head", proof: "grep: brandNew in a.txt" },
    { claim: "absent at head", proof: "grep: nowhereAtAll in a.txt" },
    { claim: "no file at base", proof: "grep: alreadyThere in b.txt" },
  ];
  writeFileSync(join(dir, "b.txt"), "alreadyThere\n");
  assert.deepEqual(certainStaleProofs(criteria, dir, base), []);
});

test("W1-T4921: a head exec error, an absent base blob and an unreadable one are never findings", () => {
  const proof = "grep: x in a.txt";
  const showOf = (err: unknown) => () => {
    throw err;
  };
  const pass = (_w: unknown, cwd: string) => {
    if (cwd !== "/nowhere" && !existsSync(join(cwd, "a.txt"))) throw new Error("grep exit 2: no such file");
    return "pass" as const;
  };
  const at = (over: object) => certainStaleProofs([{ claim: "c", proof }], "/nowhere", "b".repeat(40), { makeDir: () => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stale-arm-`)), ...over });
  assert.deepEqual(at({ exec: showOf(new Error("spawn ENOENT")) }), [], "an exec error at head is an environment gap");
  assert.deepEqual(at({ exec: pass, showBlob: showOf(Object.assign(new Error("absent"), { status: 128 })) }), [], "absent at base");
  assert.deepEqual(at({ exec: pass, showBlob: showOf(new Error("read broke")) }), [], "a read that broke says nothing about the base");
  assert.equal(at({ exec: pass, showBlob: () => "x\n" }).length, 1, "control: the same call with a readable base blob IS stale");
});

test("W1-T4921: only a dialect grep proof is answered in-process", () => {
  assert.equal(isDialectGrepProof("grep: a in b.txt"), true);
  assert.equal(isDialectGrepProof("  `grep: a in b.txt`"), true);
  assert.equal(isDialectGrepProof("unit test: a title"), false);
  assert.equal(isDialectGrepProof("`grep -rn a b.txt`"), false);
  assert.equal(isDialectGrepProof("prose"), false);
});

test("W1-T4921: rmd preflight --proofs answers a grep proof in-process and still spawns a unit test", () => {
  const { dir, base } = twoCommitRepo();
  const asked: string[] = [];
  const spawn = (_file: string, args: string[]) => {
    asked.push(args[args.indexOf("check-proof") + 1]);
    return { status: 0, stdout: "", stderr: "" };
  };
  const git = (args: readonly string[]) => (args[0] === "merge-base" ? base : args[0] === "log" ? "feat: x\n\nRemudero-Task: W1-T1\n" : "headsha\n");
  const out = runPreflightProofs(dir, {
    git,
    spawn,
    resolveCriteria: () => [
      { proof: "grep: alreadyThere in a.txt" },
      { proof: "grep: brandNew in a.txt" },
      { proof: "unit test: something real" },
    ],
  });
  assert.equal(out.ok, false);
  assert.match(out.steps[0].detail ?? "", /1 of 3 proof\(s\) pass at BOTH head and/);
  assert.ok((out.steps[0].detail ?? "").includes("grep: alreadyThere in a.txt"));
  assert.deepEqual(asked, ["unit test: something real"], "no process tree is spawned for a grep proof");
});
