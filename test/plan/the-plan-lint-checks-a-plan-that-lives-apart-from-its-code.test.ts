/**
 * W1-T12171: `lint-plan --code-root <dir>` checks a plan that lives in one checkout against the code in another.
 *
 * Each test runs the production entry, scripts/lint-plan-offline.mjs, as a child process over two real git
 * checkouts: a plan checkout (the private ops repository's shape) and a code root (the public repository's shape).
 * Nothing in the lint is injected.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CHILD_TIMEOUT_MS = 240_000;

/** One task record. `proof` is a `unit test:` path; `files` is the declared scope. */
function taskYaml(id: string, note: string, opts: { depends?: string[]; files?: string[]; proof?: string } = {}): string {
  return [
    `- id: ${id}`, `  title: "plan apart fixture ${id}"`, "  repo: remudero",
    `  depends_on: [${(opts.depends ?? []).join(", ")}]`, "  type: implement", "  verify: auto", "  priority: 1",
    "  risk: low", "  status: queued", "  attempts: 0", "  budget_usd: 1", '  origin: "test-fixture:plan-apart"',
    `  files: [${(opts.files ?? ["src/lib/held.ts"]).join(", ")}]`, `  note: ${JSON.stringify(note)}`,
    "  acceptance:", '    - claim: "the fixture proof is resolvable"',
    `      proof: "unit test: ${opts.proof ?? "test/held.test.ts"}"`, "",
  ].join("\n");
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const made: GitRepo[] = [];
after(() => { for (const r of made) r.cleanup(); });

// A proof outside `files` that names a path absent from the tree blocks. ZZ-T1 and ZZ-T2 carry one on purpose.
const ABSENT_PROOF = { proof: "test/absent.test.ts" };

/** The code root: the code the tasks name, and the public plan the tasks move from. */
function seedCodeRoot(): GitRepo {
  const code = gitRepo({ kind: "plan-apart-code" });
  made.push(code);
  code.addRemote("origin", "https://github.com/fixture-owner/remudero.git");
  put(code.dir, "src/lib/held.ts", "export function heldValue(): number { return 1; }\n");
  put(code.dir, "test/held.test.ts", 'import { test } from "node:test"; test("held", () => {});\n');
  put(code.dir, "plan/tasks.yaml", "[]\n");
  put(code.dir, "plan/tasks.d/ZZ-T1-moved.yaml", taskYaml("ZZ-T1", "moved as it is", ABSENT_PROOF));
  put(code.dir, "plan/tasks.d/ZZ-T2-amended.yaml", taskYaml("ZZ-T2", "amended", ABSENT_PROOF));
  put(code.dir, "plan/tasks.d/ZZ-T3-dependency.yaml", taskYaml("ZZ-T3", "only the code root holds this"));
  put(code.dir, "plan/tasks.d/ZZ-T5-conflict.yaml", taskYaml("ZZ-T5", "the code root's bytes"));
  code.git("add", "-A");
  code.git("commit", "-qm", "code root");
  return code;
}

/** The plan checkout: a base commit, then a head commit that moves, amends and files tasks. */
function seedPlan(extra: Record<string, string> = {}): { plan: GitRepo; base: string } {
  const plan = gitRepo({ kind: "plan-apart-plan" });
  made.push(plan);
  plan.addRemote("origin", "https://github.com/fixture-owner/remudero-ops.git");
  put(plan.dir, "plan/tasks.yaml", "[]\n");
  put(plan.dir, "plan/tasks.d/ZZ-T6-ops.yaml", taskYaml("ZZ-T6", "only the plan repository holds this"));
  put(plan.dir, "plan/tasks.d/ZZ-T5-conflict.yaml", taskYaml("ZZ-T5", "the plan repository's bytes"));
  plan.git("add", "-A");
  plan.git("commit", "-qm", "plan base");
  const base = plan.git("rev-parse", "HEAD");
  put(plan.dir, "plan/tasks.d/ZZ-T1-moved.yaml", taskYaml("ZZ-T1", "moved as it is", ABSENT_PROOF));
  // One byte differs from the code root's file: "amended" becomes "amendeD".
  put(plan.dir, "plan/tasks.d/ZZ-T2-amended.yaml", taskYaml("ZZ-T2", "amendeD", ABSENT_PROOF));
  // A new filing whose dependencies are in each plan, and whose proof path only the code root holds.
  put(plan.dir, "plan/tasks.d/ZZ-T4-new.yaml",
    taskYaml("ZZ-T4", "a new filing", { depends: ["ZZ-T3", "ZZ-T6"], files: ["src/lib/held.ts"], proof: "test/held.test.ts" }));
  for (const [rel, text] of Object.entries(extra)) put(plan.dir, rel, text);
  plan.git("add", "-A");
  plan.git("commit", "-qm", "plan head");
  return { plan, base };
}

function lint(cwd: string, args: string[]): { code: number | null; output: string } {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    join(REPO_ROOT, "scripts/lint-plan-offline.mjs"), ...args], {
    cwd, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LANG: "C", TZ: "UTC" },
  });
  assert.equal(r.error, undefined, "the offline lint child completes");
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

let apart: { code: number | null; output: string; codeDir: string; base: string } | undefined;
function lintApart(): { code: number | null; output: string; codeDir: string; base: string } {
  if (apart) return apart;
  const code = seedCodeRoot();
  const { plan, base } = seedPlan();
  apart = { ...lint(plan.dir, ["--repo-root", plan.dir, "--base", base, "--code-root", code.dir]), codeDir: code.dir, base };
  return apart;
}

test("W1-T12171 criterion 1: with --code-root, the paths in files and proofs resolve in the code root", () => {
  const { output } = lintApart();
  // ZZ-T4's proof names test/held.test.ts, outside its files. The code root holds it, so the remedy is to add it.
  assert.match(output, /\[proof-scope\][^\n]*proof names "test\/held\.test\.ts"[^\n]*Add "test\/held\.test\.ts" to files:/, output);
  // The base tree of a plan-only change is the code root's commit, which holds test/held.test.ts.
  assert.match(output, /ZZ-T4: \[proof-base-discrimination\][^\n]*"test\/held\.test\.ts", which ALREADY EXISTS at the base ref/, output);
  assert.doesNotMatch(output, /"test\/held\.test\.ts" does not exist in the tree/, output);
  // ZZ-T4 declares src/lib/held.ts. The code root holds it, so the call-site rule sees no new module.
  assert.doesNotMatch(output, /new module src\/lib\/held\.ts/, output);
  // ZZ-T2's proof path is in neither checkout, so it still blocks.
  assert.match(output, /\[proof-scope\][^\n]*"test\/absent\.test\.ts" does not exist in the tree/, output);
});

test("W1-T12171 criterion 2: the base is the union of both plans, for ids and for dependencies", () => {
  const { output } = lintApart();
  // ZZ-T4 depends on ZZ-T3 (code root only) and ZZ-T6 (plan repository only), and the plan loads.
  assert.doesNotMatch(output, /depends_on unknown task/, output);
  assert.match(output, /rmd lint-plan: \d+ task\(s\) checked/, output);
  // ZZ-T2 is absent from the plan repository's base, but the code root holds it: it is known, not new.
  assert.match(output, /✗ ZZ-T2: \d+ violation\(s\) \([1-9]\d* pre-existing on base/, output);
  // A dependency that neither plan holds is still refused.
  const code = seedCodeRoot();
  const { plan, base } = seedPlan({ "plan/tasks.d/ZZ-T7-orphan.yaml": taskYaml("ZZ-T7", "orphan", { depends: ["ZZ-T9"] }) });
  const refused = lint(plan.dir, ["--repo-root", plan.dir, "--base", base, "--code-root", code.dir]);
  assert.equal(refused.code, 2, refused.output);
  assert.match(refused.output, /### rmd lint-plan: task ZZ-T7: depends_on unknown task 'ZZ-T9'/, refused.output);
});

test("W1-T12171 criterion 3: a task file with the code root's bytes is moved and is not judged", () => {
  const { output } = lintApart();
  assert.match(output, /\(1 moved unchanged from the code root, not judged: ZZ-T1\)/, output);
  assert.doesNotMatch(output, /ZZ-T1:/, output);
});

test("W1-T12171 criterion 4: a task file that differs by one byte is an amendment and gets every check", () => {
  const { output } = lintApart();
  // Judged, with the code root's record as its base: the proof-scope block is counted as pre-existing.
  assert.match(output, /✗ ZZ-T2: 1 violation\(s\) \(1 pre-existing on base [0-9a-f]{40}\)/, output);
  assert.match(output, /\[proof-scope\] criterion 1/, output);
});

test("W1-T12171 criterion 5: an id both plans hold with different bytes is refused, naming both paths", () => {
  const { code, output, codeDir, base } = lintApart();
  assert.equal(code, 1, output);
  assert.ok(output.includes(
    "✗ ZZ-T5: the plan repository and the code root hold different bytes for this id: " +
      `${base}:plan/tasks.d/ZZ-T5-conflict.yaml and ${join(codeDir, "plan/tasks.d/ZZ-T5-conflict.yaml")}`), output);
});

test("W1-T12171 criterion 6: without --code-root, the output and the exit code are the same as before", () => {
  // The plan checkout alone: ZZ-T4's dependency on a task only the code root holds is refused, as before.
  const { plan, base } = seedPlan();
  const alone = lint(plan.dir, ["--repo-root", plan.dir, "--base", base]);
  assert.equal(alone.code, 2, alone.output);
  assert.equal(alone.output, "### rmd lint-plan: task ZZ-T4: depends_on unknown task 'ZZ-T3'\n");
  // One checkout that holds both plan and code: the whole transcript, byte for byte, with paths replaced.
  const code = seedCodeRoot();
  const before = code.git("rev-parse", "HEAD");
  put(code.dir, "plan/tasks.d/ZZ-T2-amended.yaml", taskYaml("ZZ-T2", "amendeD", ABSENT_PROOF));
  code.git("commit", "-qam", "amend ZZ-T2");
  const together = lint(code.dir, ["--repo-root", code.dir, "--base", before]);
  // A violation's prose belongs to its own rule; this test pins everything else.
  const transcript = together.output.split(code.dir).join("<root>").split(before).join("<base>")
    .replace(/^( {4}\[[a-z-]+\]) .*$/gm, "$1 <message>");
  assert.equal(together.code, EXPECTED_TOGETHER_CODE, transcript);
  assert.equal(transcript, EXPECTED_TOGETHER, transcript);
});

// Captured from origin/main before W1-T12171 changed lintPlanCommand.
const EXPECTED_TOGETHER_CODE = 1;
const EXPECTED_TOGETHER = [
  "",
  "rmd lint-plan: 1 task(s) checked (1 new/changed vs <base>) — 1 failing, 0 warning(s)",
  "  read: <root>/plan/tasks.yaml (sha256:37517e5f3dc6)",
  "  offline subset: GitHub reads disabled; post-merge-amendment (block) omitted; duplicate-title (warn) omitted; " +
    "duplicate-surface merge-credit filtering unavailable and may over-report warnings; " +
    "whole-plan merge-credit scoping falls back to status",
  "✗ ZZ-T2: 1 violation(s) (1 pre-existing on base <base>)",
  "    [proof-scope] <message>",
  "",
].join("\n");
