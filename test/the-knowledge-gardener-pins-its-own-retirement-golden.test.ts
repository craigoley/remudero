/**
 * test/the-knowledge-gardener-pins-its-own-retirement-golden.test.ts — W1-T5837.
 *
 * A gardener RETIRE/MERGE pass changes only `learnings/*.yaml` data and the garden log. The
 * prompt-surface gate (W1-T3077) treats a learnings shard as a PATH surface and admits it only on a
 * golden verdict under test/fixtures/golden-verdicts/**, and nothing wrote one — so every gardener
 * PR needed a hand refresh of the knowledge-retire case. `apply` now writes that case from the pass
 * itself. This file runs a real pass over a fixture git repo, then the REAL gate and the REAL judge
 * over what it wrote.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { decideAutoMergeArm, judgeReview } from "../src/lib/review.js";
import { fileDiff, knowledgeGardenSpec, KNOWLEDGE_RETIRE_GOLDEN, type GardenAction, type GardenWorkspace } from "../src/lib/knowledge-gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "prompt-surface-gate.mjs")).href)) as {
  evaluatePromptSurfaceGate: (opts: { root: string; base: string; head?: string }) => { ok: boolean; message: string; surfaces: string[]; evidence: string[] };
};

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
const put = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const CI_SHARD = [
  "- id: stale-ci-lesson",
  "  title: a lesson workers stopped using",
  "  lifecycle: active",
  "  tags: [ci]",
  "- id: keeper",
  "  title: a lesson that stays",
  "  lifecycle: active",
  "  tags: [ci]",
  "",
].join("\n");
const LOG_HEAD = "# Knowledge garden log\n\nEach section is one pass of the knowledge gardener (W1-T4095): what it changed and how the knowledge base scored.\n\n## Pass 2026-01-01T00:00:00.000Z\n\n- retire older-one: it was old.\n";

/** A repo shaped like origin/main: shards, a garden log, and the knowledge-retire case hand-pinned to an EARLIER pass. */
function originMainFixture(): string {
  const root = gitRepo({ seedCommit: false, kind: "knowledge-golden" }).dir;
  put(root, "learnings/ci.yaml", CI_SHARD);
  put(root, "learnings/testing.yaml", "- id: other\n  lifecycle: active\n");
  put(root, "docs/knowledge-garden-log.md", LOG_HEAD);
  const case0 = `${KNOWLEDGE_RETIRE_GOLDEN}`;
  mkdirSync(join(root, case0), { recursive: true });
  const pinned = readFileSync(join(REPO_ROOT, case0, "golden.yaml"), "utf8");
  // Seed the earlier pass's single claim even when the repository golden already has two rows.
  put(root, `${case0}/golden.yaml`, `${pinned.slice(0, pinned.search(/^criteria:[ \t]*$/m))}criteria:\n  - met: true\n    proof_exec: executed_pass\n`);
  put(root, `${case0}/diff.patch`, "diff --git a/learnings/platform.yaml b/learnings/platform.yaml\n");
  put(root, `${case0}/criteria.yaml`, "- claim: old\n  proof: \"grep: old in learnings/platform.yaml\"\n");
  put(root, `${case0}/report.md`, "an earlier pass\n");
  put(root, `${case0}/checkout/learnings/platform.yaml`, "- id: old\n  lifecycle: superseded\n");
  put(root, `${case0}/checkout/learnings/testing.yaml`, "- id: other\n  lifecycle: superseded\n");
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=fx", "-c", "user.email=fx@remudero.invalid", "commit", "-q", "-m", "base"]);
  return root;
}

function pass(root: string, actions: GardenAction[], acting: GardenAction["class"], refreshed: string[] = []) {
  const spec = knowledgeGardenSpec({
    repoRoot: root,
    stateDir: join(root, "state"),
    openWorkspace: () => {
      throw new Error("apply must not open a workspace");
    },
    log: () => {},
    clock: { now: () => Date.parse("2026-10-06T09:21:02.674Z"), date: () => new Date("2026-10-06T09:21:02.674Z") } as never,
  });
  const ws: GardenWorkspace = {
    root,
    land: () => undefined,
    dispose: () => {},
    refreshAssertions: () => refreshed,
  };
  const card = { usedShare: 0.18, danglingPointers: 1, totals: {}, duplicatePairs: 0, retireCandidates: 1, heaviest: [] };
  return spec.apply(ws, { actions, acting: [acting] }, card as never);
}

const RETIRE: GardenAction = { class: "retire", target: "stale-ci-lesson", reason: "Workers offered it have rarely used it, compared with other learnings." };

function stageAndCommit(root: string, paths: string[]): void {
  git(root, ["add", "--", ...paths]);
  git(root, ["-c", "user.name=fx", "-c", "user.email=fx@remudero.invalid", "commit", "-q", "-m", "gardener pass"]);
}

test("a retire pass writes the knowledge-retire case from its own diff and lists those paths in the PR", () => {
  const root = originMainFixture();
  const landing = pass(root, [RETIRE], "retire");
  assert.ok(landing, "the pass lands");
  const golden = (f: string) => `${KNOWLEDGE_RETIRE_GOLDEN}/${f}`;

  for (const f of ["diff.patch", "criteria.yaml", "report.md", "checkout/learnings/ci.yaml", "checkout/docs/knowledge-garden-log.md"]) {
    assert.ok(landing.paths.includes(golden(f)), `paths name ${f}`);
  }
  // golden.yaml keeps its verdict facts; its criteria rows are re-pinned to this pass's two claims.
  assert.ok(landing.paths.includes(golden("golden.yaml")), "the re-pinned golden.yaml is staged");
  assert.equal((parseYaml(readFileSync(join(root, golden("golden.yaml")), "utf8")) as { criteria: unknown[] }).criteria.length, 2);
  // The earlier pass's checkout files are removed, and the removal is staged with the rest.
  assert.ok(landing.paths.includes(golden("checkout/learnings/platform.yaml")));
  assert.ok(!existsSync(join(root, golden("checkout/learnings/platform.yaml"))));
  assert.ok(!existsSync(join(root, golden("checkout/learnings/testing.yaml"))), "a shard this pass did not change is not in its checkout");

  const diff = readFileSync(join(root, golden("diff.patch")), "utf8");
  assert.match(diff, /^diff --git a\/learnings\/ci\.yaml b\/learnings\/ci\.yaml$/m);
  assert.match(diff, /^@@ -3,1 \+3,2 @@$/m);
  assert.match(diff, /^-  lifecycle: active$/m);
  assert.match(diff, /^\+  # knowledge gardener: retire stale-ci-lesson$/m);
  assert.match(diff, /^\+  lifecycle: superseded$/m);
  assert.match(diff, /^diff --git a\/docs\/knowledge-garden-log\.md b\/docs\/knowledge-garden-log\.md$/m);
  assert.match(diff, /^\+## Pass 2026-10-06T09:21:02\.674Z$/m);
  assert.doesNotMatch(diff, /keeper/);

  const criteria = parseYaml(readFileSync(join(root, golden("criteria.yaml")), "utf8")) as AcceptanceCriterion[];
  assert.deepEqual(criteria.map((c) => c.proof), [
    "grep: ^## Pass 2026-10-06T09:21:02.674Z$ in docs/knowledge-garden-log.md",
    "grep: knowledge gardener: retire stale-ci-lesson$ in learnings/ci.yaml",
  ]);
  assert.equal(readFileSync(join(root, golden("report.md")), "utf8"), `${landing.body}\n`);
  assert.equal(
    readFileSync(join(root, golden("checkout/learnings/ci.yaml")), "utf8"),
    "- id: stale-ci-lesson\n  # knowledge gardener: retire stale-ci-lesson\n  lifecycle: superseded\n",
  );
});

test("the real prompt-surface gate passes over the pass's changed paths, and refuses them without the golden", () => {
  const root = originMainFixture();
  const landing = pass(root, [RETIRE], "retire")!;
  stageAndCommit(root, landing.paths);
  const result = gate.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.surfaces, ["learnings/ci.yaml"]);
  assert.ok(result.evidence.every((p) => p.startsWith("test/fixtures/golden-verdicts/")));
  assert.ok(result.evidence.includes(`${KNOWLEDGE_RETIRE_GOLDEN}/diff.patch`));

  // The same pass minus its golden paths is the pre-W1-T5837 behaviour: the gate refuses it.
  const bare = originMainFixture();
  const bareLanding = pass(bare, [RETIRE], "retire")!;
  git(bare, ["checkout", "-q", "--", KNOWLEDGE_RETIRE_GOLDEN]);
  stageAndCommit(bare, bareLanding.paths.filter((p) => !p.startsWith(KNOWLEDGE_RETIRE_GOLDEN)));
  const refused = gate.evaluatePromptSurfaceGate({ root: bare, base: "HEAD^" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /learnings\/ci\.yaml/);
});

test("the judge over the written case reaches the golden verdict", () => {
  const root = originMainFixture();
  pass(root, [RETIRE], "retire");
  const dir = join(root, KNOWLEDGE_RETIRE_GOLDEN);
  const criteria = parseYaml(readFileSync(join(dir, "criteria.yaml"), "utf8")) as AcceptanceCriterion[];
  const verdict = judgeReview(criteria, {
    diff: readFileSync(join(dir, "diff.patch"), "utf8"),
    report: readFileSync(join(dir, "report.md"), "utf8"),
    headCheckoutDir: join(dir, "checkout"),
  });
  const golden = parseYaml(readFileSync(join(dir, "golden.yaml"), "utf8")) as { verdict: Record<string, unknown>; arm: boolean; criteria: Array<{ met: boolean; proof_exec: string }> };
  for (const [key, expected] of Object.entries(golden.verdict)) assert.deepEqual((verdict as unknown as Record<string, unknown>)[key], expected, `verdict.${key}`);
  assert.equal(decideAutoMergeArm(verdict, true).arm, golden.arm);
  assert.equal(verdict.criteria.length, golden.criteria.length);
  golden.criteria.forEach((expected, i) => {
    assert.equal(verdict.criteria[i]!.met, expected.met);
    assert.equal(verdict.criteria[i]!.proof_exec, expected.proof_exec);
  });
});

test("a merge pass folds into the older learning and writes the case with the superseded_by line", () => {
  const root = originMainFixture();
  const landing = pass(root, [{ class: "merge", target: "stale-ci-lesson", into: "keeper", reason: "near-duplicate" }], "merge")!;
  assert.ok(landing.paths.includes(`${KNOWLEDGE_RETIRE_GOLDEN}/diff.patch`));
  assert.equal(
    readFileSync(join(root, KNOWLEDGE_RETIRE_GOLDEN, "checkout/learnings/ci.yaml"), "utf8"),
    "- id: stale-ci-lesson\n  # knowledge gardener: merge stale-ci-lesson\n  lifecycle: superseded\n  superseded_by: keeper\n",
  );
});

test("fileDiff keeps a line common to both middles out of the hunks and splits the change around it", () => {
  const before = ["h", "1", "m", "2", "t", ""].join("\n");
  const after = ["h", "3", "m", "4", "t", ""].join("\n");
  assert.equal(
    fileDiff("f.txt", before, after),
    ["diff --git a/f.txt b/f.txt", "--- a/f.txt", "+++ b/f.txt", "@@ -2,1 +2,1 @@", "-1", "+3", "@@ -4,1 +4,1 @@", "-2", "+4", ""].join("\n"),
  );
});

test("fileDiff replaces a middle too large to table with one remove-all/add-all hunk", () => {
  const lines = (prefix: string): string => Array.from({ length: 2001 }, (_, i) => `${prefix}${i}`).join("\n") + "\n";
  const diff = fileDiff("big.txt", lines("a"), lines("b"));
  const rows = diff.split("\n");
  assert.equal(rows[3], "@@ -1,2001 +1,2001 @@");
  assert.equal(rows[4], "-a0");
  assert.equal(rows[4 + 2000], "-a2000");
  assert.equal(rows[4 + 2001], "+b0");
  assert.equal(rows[4 + 4001], "+b2000");
  assert.equal(rows.length, 4 + 4002 + 1);
});

test("a pass with no retire or merge action writes no golden", () => {
  const root = originMainFixture();
  const landing = pass(root, [{ class: "refresh", target: "", reason: "assertions re-run" }], "refresh", ["learnings/ci.yaml"])!;
  assert.ok(landing);
  assert.deepEqual(landing.paths.filter((p) => p.startsWith("test/")), []);
  assert.equal(git(root, ["status", "--porcelain", "--", "test"]), "");
  assert.equal(readFileSync(join(root, KNOWLEDGE_RETIRE_GOLDEN, "report.md"), "utf8"), "an earlier pass\n");
});

test("a two-learning pass re-pins golden.yaml's criteria to the claims it writes, so the judge still reaches it", () => {
  const root = originMainFixture();
  const pinned = readFileSync(join(root, KNOWLEDGE_RETIRE_GOLDEN, "golden.yaml"), "utf8");
  const oneRow = `${pinned.slice(0, pinned.search(/^criteria:[ \t]*$/m))}criteria:\n  - met: true\n    proof_exec: executed_pass\n`;
  put(root, `${KNOWLEDGE_RETIRE_GOLDEN}/golden.yaml`, oneRow);
  const second: GardenAction = { class: "retire", target: "keeper", reason: "Workers offered it have rarely used it, compared with other learnings." };
  const landing = pass(root, [RETIRE, second], "retire")!;
  const dir = join(root, KNOWLEDGE_RETIRE_GOLDEN);
  assert.ok(landing.paths.includes(`${KNOWLEDGE_RETIRE_GOLDEN}/golden.yaml`), "the re-pinned golden.yaml is staged with the case");
  const criteria = parseYaml(readFileSync(join(dir, "criteria.yaml"), "utf8")) as AcceptanceCriterion[];
  const golden = parseYaml(readFileSync(join(dir, "golden.yaml"), "utf8")) as { verdict: Record<string, unknown>; criteria: unknown[] };
  assert.equal(criteria.length, 3, "the log heading plus one claim per retired learning");
  assert.equal(golden.criteria.length, criteria.length);
  assert.deepEqual(golden.verdict, (parseYaml(readFileSync(join(REPO_ROOT, KNOWLEDGE_RETIRE_GOLDEN, "golden.yaml"), "utf8")) as { verdict: unknown }).verdict, "verdict facts are kept");
  const verdict = judgeReview(criteria, {
    diff: readFileSync(join(dir, "diff.patch"), "utf8"),
    report: readFileSync(join(dir, "report.md"), "utf8"),
    headCheckoutDir: join(dir, "checkout"),
  });
  assert.equal(verdict.criteria.length, golden.criteria.length);
});

test("a golden.yaml already matching the pass, or with no criteria block, is left exactly as it was", () => {
  const matching = originMainFixture();
  pass(matching, [RETIRE], "retire");
  stageAndCommit(matching, [KNOWLEDGE_RETIRE_GOLDEN, "learnings", "docs"]);
  git(matching, ["checkout", "-q", "HEAD^", "--", "learnings", "docs"]);
  const again = pass(matching, [RETIRE], "retire")!;
  assert.equal(again.paths.includes(`${KNOWLEDGE_RETIRE_GOLDEN}/golden.yaml`), false, "an unchanged golden.yaml is not restaged");

  const root = originMainFixture();
  const bare = "violation: none\nverdict:\n  state: success\narm: true\n";
  put(root, `${KNOWLEDGE_RETIRE_GOLDEN}/golden.yaml`, bare);
  const landing = pass(root, [RETIRE], "retire")!;
  assert.equal(readFileSync(join(root, KNOWLEDGE_RETIRE_GOLDEN, "golden.yaml"), "utf8"), bare);
  assert.equal(landing.paths.includes(`${KNOWLEDGE_RETIRE_GOLDEN}/golden.yaml`), false);
});
