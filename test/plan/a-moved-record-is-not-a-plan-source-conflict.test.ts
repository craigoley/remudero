/**
 * W1-T13680 criterion 5: lint-plan in an ops checkout, with the public code root, reads a record whose bytes equal
 * the code root's record once its one moved_from line is removed as a move, not a plan-source conflict. A record
 * that differs in any other byte, or that carries two moved_from lines, is still refused.
 *
 * The lint runs as the production entry (scripts/lint-plan-offline.mjs) over two real git checkouts, as the
 * W1-T12171 suite does. The two pure functions it calls are pinned beside it, so each refusal names its rule.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { movedTaskIds, planFromFiles, planSourceConflicts } from "#src/lib/task-linter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CHILD_TIMEOUT_MS = 240_000;
const SOURCE = "c".repeat(40);
const MOVED_LINE = `  moved_from: remudero@${SOURCE}\n`;

function taskYaml(id: string, note: string, opts: { files?: string[]; noteBlock?: string } = {}): string {
  return [
    `- id: ${id}`, `  title: "moved record fixture ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement",
    "  design: |", "    NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve", "  verify: auto",
    "  priority: 1", "  risk: low", "  status: queued", "  attempts: 0", "  budget_usd: 1",
    '  origin: "test-fixture:moved-record"', `  files: [${(opts.files ?? ["src/lib/held.ts"]).join(", ")}]`,
    opts.noteBlock === undefined ? `  note: ${JSON.stringify(note)}` : `  note: |\n${opts.noteBlock}`,
    "  acceptance:", '    - claim: "the fixture proof is resolvable"', '      proof: "unit test: test/held.test.ts"', "",
  ].join("\n");
}
/** The mover's exact shape: the original bytes with one moved_from line after the id line. */
const withMovedFrom = (text: string): string => text.replace(/^(- id: [^\n]+\n)/, `$1${MOVED_LINE}`);

function put(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const ORIGINALS = {
  "plan/tasks.d/ZZ-T1-moved.yaml": taskYaml("ZZ-T1", "moved with one provenance line"),
  "plan/tasks.d/ZZ-T2-edited.yaml": taskYaml("ZZ-T2", "moved, then edited"),
  "plan/tasks.d/ZZ-T3-twice.yaml": taskYaml("ZZ-T3", "unused", { noteBlock: "    a note\n" }),
};
// The ops copies as a base commit holds them: one exact move, one move with one other byte changed, and one with
// a second moved_from line (inside a note block, so the YAML still loads and only the line count differs).
const OPS_COPIES = {
  "plan/tasks.d/ZZ-T1-moved.yaml": withMovedFrom(ORIGINALS["plan/tasks.d/ZZ-T1-moved.yaml"]),
  "plan/tasks.d/ZZ-T2-edited.yaml": withMovedFrom(taskYaml("ZZ-T2", "moved, then editeD")),
  "plan/tasks.d/ZZ-T3-twice.yaml": withMovedFrom(taskYaml("ZZ-T3", "unused", { noteBlock: `    a note\n  ${MOVED_LINE}` })),
};

function seed(t: TestContext): { code: GitRepo; plan: GitRepo; base: string } {
  const code = gitRepo({ scope: t, kind: "moved-record-code" });
  code.addRemote("origin", "https://github.com/fixture-owner/remudero.git");
  put(code.dir, "src/lib/held.ts", "export function heldValue(): number { return 1; }\n");
  put(code.dir, "test/held.test.ts", 'import { test } from "node:test"; test("held", () => {});\n');
  put(code.dir, "plan/tasks.yaml", "[]\n");
  for (const [rel, text] of Object.entries(ORIGINALS)) put(code.dir, rel, text);
  code.git("add", "-A");
  code.git("commit", "-qm", "code root");
  const plan = gitRepo({ scope: t, kind: "moved-record-plan" });
  plan.addRemote("origin", "https://github.com/fixture-owner/remudero-ops.git");
  put(plan.dir, "plan/tasks.yaml", "[]\n");
  for (const [rel, text] of Object.entries(OPS_COPIES)) put(plan.dir, rel, text);
  plan.git("add", "-A");
  plan.git("commit", "-qm", "ops base holds three moved records");
  const base = plan.git("rev-parse", "HEAD");
  // An ordinary ops filing on top: the plan-PR emitter's preflight lint runs exactly this shape.
  put(plan.dir, "plan/tasks.d/ZZ-T4-new.yaml", taskYaml("ZZ-T4", "an unrelated new ops filing"));
  plan.git("add", "-A");
  plan.git("commit", "-qm", "an ops filing");
  return { code, plan, base };
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

const conflictLine = (id: string) => `✗ ${id}: the plan repository and the code root hold different bytes for this id`;

test("W1-T13680 criterion 5: lint-plan reads a record equal to the code root's once its one moved_from line is removed as no plan-source conflict", t => {
  const { code, plan, base } = seed(t);
  const result = lint(plan.dir, ["--repo-root", plan.dir, "--base", base, "--code-root", code.dir]);
  // Positive control: the lint reached the plan-source comparison and judged the other two records.
  assert.match(result.output, /rmd lint-plan: \d+ task\(s\) checked/, result.output);
  assert.ok(result.output.includes(conflictLine("ZZ-T2")), `a one-byte edit beside moved_from is still a conflict:\n${result.output}`);
  assert.ok(result.output.includes(conflictLine("ZZ-T3")), `two moved_from lines are still a conflict:\n${result.output}`);
  assert.equal(result.code, 1, result.output);
  assert.ok(!result.output.includes(conflictLine("ZZ-T1")), `an exact move is not a conflict:\n${result.output}`);

  // The same rule, read off the two pure functions the lint calls.
  const codeFiles = new Map(Object.entries(ORIGINALS));
  const planFiles = new Map(Object.entries(OPS_COPIES));
  assert.deepEqual(planSourceConflicts(planFiles, codeFiles).map(c => c.id), ["ZZ-T2", "ZZ-T3"]);
  const tasks = planFromFiles(planFiles, rel => join(plan.dir, rel)).tasks;
  assert.deepEqual([...movedTaskIds(tasks, plan.dir, planFiles, codeFiles)], ["ZZ-T1"]);
  // A record with no moved_from line keeps the W1-T12171 rule: equal bytes are moved, one changed byte is not.
  const plain = new Map([["plan/tasks.d/ZZ-T1-moved.yaml", ORIGINALS["plan/tasks.d/ZZ-T1-moved.yaml"]]]);
  assert.deepEqual(planSourceConflicts(plain, codeFiles), []);
  const edited = new Map([["plan/tasks.d/ZZ-T2-edited.yaml", taskYaml("ZZ-T2", "moved, then editeD")]]);
  assert.deepEqual(planSourceConflicts(edited, codeFiles).map(c => c.id), ["ZZ-T2"]);
});
