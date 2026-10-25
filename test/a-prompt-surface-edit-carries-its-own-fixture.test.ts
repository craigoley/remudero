import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "#src/lib/learnings.js";
import { loadInjectableSkills, observeSkillSelection, selectSkillsForTask, renderSkillsPart, SKILL_FIX_TASK_TYPE } from "#src/lib/skill-workshop.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";

import { gitRepo } from "#test/helpers/git-repo.js";

const SCRIPT = join(REPO_ROOT, "scripts", "prompt-surface-gate.mjs");

type GateResult = {
  ok: boolean;
  message: string;
  surfaces: string[];
  evidence: string[];
};

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluatePromptSurfaceGate: (opts: { root: string; base: string; head?: string }) => GateResult;
  evaluatePromptSurfaceDiff: (
    diffText: string,
    opts: { root: string; base: string; head?: string },
  ) => GateResult;
  readGitDiff: (root: string, base: string, head?: string) => string;
  functionRanges: (path: string, text: string) => Array<{ symbol: string; start: number; end: number }>;
  isOperatorOnlyMacroTable: (text: string, render?: (row: unknown) => string) => boolean;
  main: (
    argv: string[],
    io: { log: (msg: string) => void; error: (msg: string) => void },
  ) => number;
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "prompt surface fixture",
  GIT_AUTHOR_EMAIL: "fixture@remudero.invalid",
  GIT_COMMITTER_NAME: "prompt surface fixture",
  GIT_COMMITTER_EMAIL: "fixture@remudero.invalid",
};

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function commit(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function fixtureRepo(): string {
  return gitRepo({ seedCommit: false, kind: "prompt-surface-gate" }).dir;
}

function withFixture(fn: (root: string) => void): void {
  const root = fixtureRepo();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LEARNINGS_SOURCE = (line: string) => `
export function renderDoctrinePreamble(): string {
  return "${line}";
}

export function unrelatedLearningHelper(): string {
  return "steady";
}
`;

const RUN_TASK_SOURCE = (line: string) => `
export function unrelatedRunTaskHelper(): string {
  return "${line}";
}
`;

test("W1-T3077: a diff that edits a named prompt-surface function and adds no golden fixture is refused with the surface named", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "base");

    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("new doctrine"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, ["src/lib/learnings.ts:renderDoctrinePreamble"]);
    assert.match(result.message, /renderDoctrinePreamble/);
    assert.match(result.message, /test\/fixtures\/golden-verdicts/);
  });
});

test("W1-T3077: the same diff plus a fixture under test/fixtures/golden-verdicts passes, and a diff to an unrelated run-task.ts function passes", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "base");

    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("new doctrine"));
    write(root, "test/fixtures/golden-verdicts/prompt-surface/golden.yaml", "id: prompt-surface\n");
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence, ["test/fixtures/golden-verdicts/prompt-surface/golden.yaml"]);
  });

  withFixture((root) => {
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("old value"));
    commit(root, "base");

    write(root, "src/run-task.ts", RUN_TASK_SOURCE("new value"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.surfaces, []);
  });
});

const COMPACTION_SOURCE = (contract: string, helper: string) => `
export function outputContractLines(taskId: string): string[] {
  return ["${contract}", taskId];
}

export function unrelatedCompactionHelper(): string {
  return "${helper}";
}
`;

test("the implement output contract is a prompt surface: an outputContractLines edit with no golden fixture is refused, another compaction.ts function is not", () => {
  withFixture((root) => {
    write(root, "src/lib/compaction.ts", COMPACTION_SOURCE("old contract", "steady"));
    commit(root, "base");

    write(root, "src/lib/compaction.ts", COMPACTION_SOURCE("new contract", "steady"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, ["src/lib/compaction.ts:outputContractLines"]);
  });

  withFixture((root) => {
    write(root, "src/lib/compaction.ts", COMPACTION_SOURCE("steady", "old value"));
    commit(root, "base");

    write(root, "src/lib/compaction.ts", COMPACTION_SOURCE("steady", "new value"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.surfaces, []);
  });
});

test("prompt surface gate: a learnings shard edit is refused unless the diff carries golden evidence", () => {
  withFixture((root) => {
    write(root, "learnings/testing.yaml", "- id: before\n  fact: old\n");
    commit(root, "base");

    write(root, "learnings/testing.yaml", "- id: before\n  fact: new\n");
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, ["learnings/testing.yaml"]);
  });
});

test("W1-T3077: readGitDiff surfaces git's own failure rather than swallowing an unresolvable base ref", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("only doctrine"));
    commit(root, "only commit");

    assert.throws(() => mod.readGitDiff(root, "no-such-ref-at-all"), /git diff .* failed/);
  });
});

test("W1-T3077: functionRanges skips rather than throws on an unmatched signature paren, a bodyless signature, and braces that never balance", () => {
  const unmatchedParen = "export function renderDoctrinePreamble(\n  a: string,\n  no closing paren ever\n";
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", unmatchedParen), []);

  const noBodyBrace =
    "export function renderDoctrinePreamble(\n  a,\n  b\n)\n\n// no opening brace ever follows this signature\n";
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", noBodyBrace), []);

  const unbalancedBraces = 'export function renderDoctrinePreamble() {\n  if (true) {\n    return "ok";\n  \n';
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", unbalancedBraces), []);
});

test("W1-T3077: functionRanges scans past line/block comments and escaped or unterminated quotes inside a matched body", () => {
  const withComments =
    'export function renderDoctrinePreamble() {\n  // a line comment\n  /* a block comment */\n  return "ok";\n}\n';
  const commentRanges = mod.functionRanges("src/lib/learnings.ts", withComments);
  assert.equal(commentRanges.length, 1);
  assert.equal(commentRanges[0].symbol, "renderDoctrinePreamble");

  const withEscapedQuote = 'export function renderDoctrinePreamble() {\n  return "a \\" quote";\n}\n';
  const escapedRanges = mod.functionRanges("src/lib/learnings.ts", withEscapedQuote);
  assert.equal(escapedRanges.length, 1);
  assert.equal(escapedRanges[0].symbol, "renderDoctrinePreamble");

  const withUnterminatedQuote = 'export function renderDoctrinePreamble() {\n  return "unterminated';
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", withUnterminatedQuote), []);
});

test("W1-T3077: evidence for a touched surface falls back to a worktree read, and then to empty, once the given head cannot be read from git", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "only commit");

    write(root, "test/renders-doctrine-preamble.test.ts", "renderDoctrinePreamble();\n");

    const diffText = [
      "diff --git a/src/lib/learnings.ts b/src/lib/learnings.ts",
      "--- a/src/lib/learnings.ts",
      "+++ b/src/lib/learnings.ts",
      "@@ -2,3 +2,3 @@",
      "diff --git a/test/renders-doctrine-preamble.test.ts b/test/renders-doctrine-preamble.test.ts",
      "--- /dev/null",
      "+++ b/test/renders-doctrine-preamble.test.ts",
      "@@ -0,0 +1,1 @@",
      "diff --git a/test/phantom-never-written.test.ts b/test/phantom-never-written.test.ts",
      "--- /dev/null",
      "+++ b/test/phantom-never-written.test.ts",
      "@@ -0,0 +1,1 @@",
    ].join("\n");

    // "no-such-ref-at-all" makes every `git show <head>:<path>` read fail, forcing evidenceFor's
    // worktree-read fallback for the test path that exists on disk, and its own empty-string
    // fallback for the one that was only ever named in the (hand-built) diff above.
    const result = mod.evaluatePromptSurfaceDiff(diffText, { root, base: "HEAD", head: "no-such-ref-at-all" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence, [
      "test/renders-doctrine-preamble.test.ts",
      "test/phantom-never-written.test.ts",
    ]);
  });
});

test("W1-T3077 main(): exits 0 and logs on a clean diff, 1 and errors the refusal on a touched surface, and 1 from a caught git failure", () => {
  withFixture((root) => {
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("old value"));
    commit(root, "base");
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("new value"));
    commit(root, "head");

    const logs: string[] = [];
    const errors: string[] = [];
    const code = mod.main(["--base", "HEAD^", "--worktree-path", root], {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /OK/);
  });

  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "base");
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("new doctrine"));
    commit(root, "head");

    const logs: string[] = [];
    const errors: string[] = [];
    const code = mod.main(["--base", "HEAD^", "--worktree-path", root], {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });
    assert.equal(code, 1);
    assert.deepEqual(logs, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /REFUSED/);
  });

  withFixture((root) => {
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("old value"));
    commit(root, "only commit");

    const logs: string[] = [];
    const errors: string[] = [];
    const previousBaseRef = process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    try {
      // No `--base` and no GITHUB_BASE_REF: main() falls back to "origin/main", which does not
      // exist in this bare fixture repo, so the git failure is caught rather than thrown.
      const code = mod.main(["--worktree-path", root], {
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
      });
      assert.equal(code, 1);
      assert.deepEqual(logs, []);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /REFUSED/);
    } finally {
      if (previousBaseRef === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = previousBaseRef;
    }
  });
});

// ── W1-T4332: an operator-only macro row reaches no worker and no judge ──────────────────────────

const MACRO_ROW = (expansion: string) =>
  `macros:\n  - name: probe\n    summary: "a probe"\n    expansion: |\n      ${expansion}\n    args: true\n`;

test("W1-T4332: a data edit to an operator-only macro row passes the gate with no golden fixture", () => {
  withFixture((root) => {
    write(root, "settings/macros.yaml", MACRO_ROW("old body"));
    commit(root, "base");
    write(root, "settings/macros.yaml", MACRO_ROW("new body"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.surfaces, [], "an operator-only table is not a prompt surface");
  });
});

test("W1-T4332: a macro table that would render a model-invocable or injectable skill is still a prompt surface", () => {
  const table = MACRO_ROW("body");
  // CONTROL: the real generator renders this row operator-only, so the refusals below are about the
  // rendered frontmatter and not about the table.
  assert.equal(mod.isOperatorOnlyMacroTable(table), true);
  const invocable = () => "---\nname: probe\ndescription: d\n---\nbody\n";
  const injectable = () => "---\nname: probe\ndisable-model-invocation: true\napplies-to: implement\n---\nbody\n";
  assert.equal(mod.isOperatorOnlyMacroTable(table, invocable), false, "no disable-model-invocation flag");
  assert.equal(mod.isOperatorOnlyMacroTable(table, injectable), false, "an applies-to: key opts into worker injection");
  // FAILS CLOSED: a table that does not parse, has no rows, or is gone stays a surface.
  assert.equal(mod.isOperatorOnlyMacroTable("macros: [unclosed"), false, "unparseable");
  assert.equal(mod.isOperatorOnlyMacroTable("macros: []\n"), false, "empty");
  assert.equal(mod.isOperatorOnlyMacroTable(""), false, "absent");

  // END TO END: an unparseable table at head is refused without golden evidence.
  withFixture((root) => {
    write(root, "settings/macros.yaml", MACRO_ROW("old body"));
    commit(root, "base");
    write(root, "settings/macros.yaml", "macros: [unclosed\n");
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, ["settings/macros.yaml"]);
  });
});

test("W1-T4332: a learnings shard data edit is still refused without a golden fixture", () => {
  withFixture((root) => {
    write(root, "learnings/testing.yaml", "- id: before\n  fact: old\n");
    write(root, "settings/macros.yaml", MACRO_ROW("old body"));
    commit(root, "base");
    write(root, "learnings/testing.yaml", "- id: before\n  fact: new\n");
    write(root, "settings/macros.yaml", MACRO_ROW("new body"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false, "the macro exemption must not carry a learnings edit through with it");
    assert.deepEqual(result.surfaces, ["learnings/testing.yaml"]);
  });
});

const INJECTED_PATH = ".claude/skills/procedure/SKILL.md";
const EFFECT_PATH = "test/fixtures/golden-verdicts/injected-skill-effect.yaml";
const skillSource = (body: string, front = "applies-to: implement") => `---\nname: procedure\n${front}\n---\n\n${body}\n`;
function renderedSkillPrompt(root: string, taskType = "implement", files = ["src/lib/example.ts"]) {
  return renderSkillsPart(selectSkillsForTask(loadInjectableSkills(join(root, ".claude", "skills")), taskType, DEFAULT_KNOWLEDGE_BUDGET_CHARS, files));
}
function effectFixture(before: string, after: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ kind: "injected-skill-prompt-effect", skill: "procedure", task_type: "implement", task_files: ["src/lib/example.ts"], before, after, ...extra });
}

test("an approved injected skill edit without prompt-effect evidence is refused", () => {
  for (const name of ["two\tparts", 'two"parts', "two\\parts", "procédure", "two parts"]) withFixture(root => {
    const path = `.claude/skills/${name}/SKILL.md`;
    write(root, path, skillSource("Original invariant."));
    assert.deepEqual(loadInjectableSkills(join(root, ".claude/skills")).map(skill => skill.name), [name]);
    assert.match(renderedSkillPrompt(root), /Original invariant/);
    commit(root, "approved unusual skill name");
    write(root, path, skillSource("Changed invariant."));
    commit(root, "sole skill body edit");
    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false, `no evidence for ${JSON.stringify(name)}`);
    assert.deepEqual(result.surfaces, [path]);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Check the original invariant."));
    commit(root, "approved base skill");
    write(root, INJECTED_PATH, skillSource("Check the changed invariant."));
    // The old any-golden-path shortcut must not satisfy an injected skill obligation.
    write(root, EFFECT_PATH, "id: unrelated-golden\n");
    commit(root, "body edit with unrelated evidence");
    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, [INJECTED_PATH]);
    assert.match(result.message, /actual maintained loading/);
  });
});

test("deleting or opting out a formerly injected skill retains its base-side prompt evidence obligation", () => {
  for (const header of [
    'diff --git "a/.claude/skills/procedure/SKILL.md" "b/.claude/skills/unterminated',
    'diff --git "a/.claude/skills/procedure/SKILL.md" "b/.claude/skills/invalid\\q/SKILL.md"',
    'diff --git "a/.claude/skills/procedure/SKILL.md" "b/.claude/skills/invalid\\377/SKILL.md"',
  ]) assert.throws(() => mod.evaluatePromptSurfaceDiff(header, { root: REPO_ROOT, base: "unused" }),
    /unparsed Git file header|invalid Git-quoted path|encoded data/, "unreadable paths never become an empty diff");
  for (const path of [".claude", ".claude/skills", ".claude/skills/procedure"]) withFixture(root => {
    const source = path === ".claude" ? "target/skills/procedure/SKILL.md" :
      path === ".claude/skills" ? "target/procedure/SKILL.md" : "target/SKILL.md";
    write(root, source, skillSource("Reachable through a symbolic ancestor."));
    commit(root, "source outside the approved tree");
    assert.equal(renderedSkillPrompt(root), "");
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, "target"), join(root, path));
    assert.match(renderedSkillPrompt(root), /Reachable through a symbolic ancestor/);
    commit(root, "sole symbolic ancestor change");
    assert.throws(() => mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }), /skill reachability/);
  });
  for (const path of [INJECTED_PATH, ".claude/skills/two\tparts/SKILL.md"])
  for (const change of ["delete", "rename", "opt-out", "selector"] as const) withFixture(root => {
    write(root, path, skillSource("Check the invariant."));
    commit(root, "approved skill");
    if (change === "delete") rmSync(join(root, path));
    if (change === "rename") {
      const renamed = '.claude/skills/renamed"skill/SKILL.md';
      mkdirSync(dirname(join(root, renamed)), { recursive: true });
      renameSync(join(root, path), join(root, renamed));
    }
    if (change === "opt-out") write(root, path, skillSource("Check the invariant.", "disable-model-invocation: true"));
    if (change === "selector") write(root, path, skillSource("Check the invariant.", "applies-to: implement\nwhen-paths: docs/**"));
    commit(root, change);
    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false, change);
    assert.ok(result.surfaces.includes(path), change);
    assert.throws(() => mod.evaluatePromptSurfaceGate({ root, base: "a-missing-base" }), /git (cat-file|merge-base)/);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Check the invariant."));
    commit(root, "regular skill");
    rmSync(join(root, ".claude/skills/procedure"), { recursive: true });
    symlinkSync("unresolved-target", join(root, ".claude/skills/procedure"));
    commit(root, "unresolved symbolic skill");
    assert.throws(() => mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }), /symbolic skill/);
  });
  for (const change of ["symbolic-root", "symbolic-file", "ambiguous-name"] as const) withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Old invariant."));
    commit(root, "regular base");
    if (change === "symbolic-root") {
      rmSync(join(root, ".claude/skills"), { recursive: true });
      symlinkSync("unresolved-target", join(root, ".claude/skills"));
    } else if (change === "symbolic-file") {
      rmSync(join(root, INJECTED_PATH));
      symlinkSync("unresolved-target", join(root, INJECTED_PATH));
    } else {
      write(root, ".claude/skills/two\nparts/SKILL.md", skillSource("Ambiguous name."));
    }
    commit(root, change);
    assert.throws(() => mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }), /skill reachability/);
  });
});

test("injected skill evidence qualifies only the actual maintained prompt effect", () => {
  for (const name of ["procedure", "fix\tprocedure"]) withFixture(root => {
    const path = `.claude/skills/${name}/SKILL.md`;
    const effectPath = 'test/fixtures/golden-verdicts/fix"effect.yaml';
    const front = `applies-to: ${SKILL_FIX_TASK_TYPE}\nwhen-paths: src/**`;
    const fixPrompt = (skillsPart: string) => renderFixPrompt({
      task: { id: "W1-T10576", title: "fix the gate", files: ["src/lib/example.ts"] },
      branch: "run-W1-T10576-1", round: 1,
      evidence: { ciFailures: [{ name: "prompt-surface-gate", logTail: "refused" }] }, skillsPart,
    });
    write(root, path, skillSource("Check the old fix invariant.", front));
    const before = renderedSkillPrompt(root, SKILL_FIX_TASK_TYPE);
    assert.match(fixPrompt(before), /Check the old fix invariant/);
    assert.equal(renderedSkillPrompt(root, "implement"), "", "this skill is fix-only");
    commit(root, "approved fix-only skill");
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    write(root, path, skillSource("Check the new fix invariant.", front));
    const after = renderedSkillPrompt(root, SKILL_FIX_TASK_TYPE);
    assert.match(fixPrompt(after), /Check the new fix invariant/);
    assert.notEqual(before, after);
    for (const taskType of ["implement", "implemnt", SKILL_FIX_TASK_TYPE]) {
      write(root, effectPath, effectFixture(before, after, { skill: name, task_type: taskType }));
      commit(root, "fix-only prompt-effect evidence");
      const result = mod.evaluatePromptSurfaceGate({ root, base });
      assert.equal(result.ok, taskType === SKILL_FIX_TASK_TYPE, taskType);
      assert.deepEqual(result.evidence, taskType === SKILL_FIX_TASK_TYPE ? [effectPath] : []);
    }
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Same body, but a new invalid selector must not invent a worker context."));
    const before = renderedSkillPrompt(root, "implemnt");
    commit(root, "valid base selector");
    write(root, INJECTED_PATH, skillSource("Same body, but a new invalid selector must not invent a worker context.", "applies-to: implement, implemnt"));
    const after = renderedSkillPrompt(root, "implemnt");
    assert.notEqual(before, after, "the permissive loader can select an arbitrary supplied type; a real worker task cannot have that type");
    write(root, EFFECT_PATH, effectFixture(before, after, { task_type: "implemnt" }));
    commit(root, "invalid worker context golden");
    assert.equal(mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }).ok, false);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Check the old invariant."));
    const before = renderedSkillPrompt(root);
    commit(root, "base");
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    write(root, INJECTED_PATH, skillSource("Check the new invariant."));
    const after = renderedSkillPrompt(root);
    assert.notEqual(before, after);
    assert.match(after, /Check the new invariant/);
    write(root, EFFECT_PATH, effectFixture(before, after));
    commit(root, "actual maintained prompt golden");
    assert.deepEqual(mod.evaluatePromptSurfaceGate({ root, base }).evidence, [EFFECT_PATH]);
    assert.equal(mod.evaluatePromptSurfaceGate({ root, base }).ok, true);
    for (const invalid of [
      effectFixture(before, after, { skill: "unrelated" }),
      effectFixture("invented before", after),
      effectFixture(before, "invented after"),
      effectFixture("", "", { task_type: "review" }),
      effectFixture(before, after, { task_files: "not a list" }),
      "{unparseable",
    ]) {
      write(root, EFFECT_PATH, invalid);
      commit(root, "unqualified fixture");
      assert.equal(mod.evaluatePromptSurfaceGate({ root, base }).ok, false);
    }
  });
});

test("injected skill surface regressions preserve selection and operator-only macro behavior", async () => {
  const root = fixtureRepo();
  try {
    write(root, INJECTED_PATH, skillSource("Original procedure."));
    commit(root, "source-deletion base");
    write(root, INJECTED_PATH, skillSource("Changed procedure."));
    commit(root, "source-deletion head");
    // Execute the maintained gate with its skill check deleted, then restore that exact source.
    // Absolute imports let the disposable modules use the real maintained dependencies.
    const source = readFileSync(SCRIPT, "utf8").replace(/\bfrom "([^"]+)"/g, (_match, specifier: string) =>
      `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, pathToFileURL(SCRIPT)).href : import.meta.resolve(specifier))}`);
    const deleted = source.replace("const skillContext = skillSurfaceContext(root, base, head, files);",
      "const skillContext = { surfaces: [], before: [], after: [] };");
    const load = (text: string) => import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`) as Promise<typeof mod>;
    const removedGate = await load(deleted), restoredGate = await load(source);
    const refuses = (gate: typeof mod) => assert.equal(gate.evaluatePromptSurfaceGate({ root, base: "HEAD^" }).ok, false,
      "the changed approved skill must be refused");
    assert.throws(() => refuses(removedGate), /the changed approved skill must be refused/);
    refuses(restoredGate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  withFixture(root => {
    const path = '.claude/skills/operator"macro/SKILL.md';
    write(root, path, skillSource("Old macro.", "disable-model-invocation: true"));
    commit(root, "quoted operator-only macro");
    write(root, path, skillSource("New macro.", "disable-model-invocation: true"));
    commit(root, "sole quoted macro edit");
    assert.equal(mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }).ok, true);
    assert.equal(renderedSkillPrompt(root), "");
    const skills = [{ name: "procedure", body: "procedure", appliesTo: ["implement"] }];
    const withheld = observeSkillSelection(skills, "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS, [], () => true);
    assert.deepEqual(withheld.selected, []);
    assert.deepEqual(withheld.observation.withheld_names, ["procedure"]);
    assert.deepEqual(selectSkillsForTask(skills, "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS), skills);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Old operator-only macro.", "disable-model-invocation: true"));
    write(root, ".claude/skills/README.md", "Not a skill directory.\n");
    write(root, ".claude/skills/orphan/README.md", "No skill file.\n");
    commit(root, "operator-only and non-skill entries");
    write(root, INJECTED_PATH, skillSource("New operator-only macro.", "disable-model-invocation: true"));
    commit(root, "operator-only body edit");
    assert.equal(mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }).ok, true);
    const diff = mod.readGitDiff(root, "HEAD^");
    assert.throws(() => mod.evaluatePromptSurfaceDiff(diff, { root, base: `HEAD:${INJECTED_PATH}` }), /not a commit/);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Unchanged actual prompt.", "applies-to: implement, review"));
    commit(root, "base");
    write(root, INJECTED_PATH, skillSource("Unchanged actual prompt.", "# frontmatter furniture\napplies-to: review, implement"));
    commit(root, "non-injected metadata furniture");
    assert.equal(mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }).ok, true);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("Old skill."));
    write(root, "settings/macros.yaml", MACRO_ROW("old operator macro"));
    const before = renderedSkillPrompt(root);
    commit(root, "base skill and operator macro");
    write(root, INJECTED_PATH, skillSource("New skill."));
    write(root, "settings/macros.yaml", MACRO_ROW("new operator macro"));
    write(root, EFFECT_PATH, effectFixture(before, renderedSkillPrompt(root)));
    commit(root, "independent macro exemption and qualified skill");
    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.surfaces, [INJECTED_PATH]);
  });
  withFixture(root => {
    write(root, INJECTED_PATH, skillSource("x".repeat(DEFAULT_KNOWLEDGE_BUDGET_CHARS + 1)));
    assert.equal(renderedSkillPrompt(root), renderSkillsPart([]));
    const before = renderedSkillPrompt(root);
    commit(root, "over-budget skill");
    write(root, INJECTED_PATH, skillSource("y".repeat(DEFAULT_KNOWLEDGE_BUDGET_CHARS + 1)));
    write(root, EFFECT_PATH, effectFixture(before, renderedSkillPrompt(root)));
    commit(root, "cannot fake selection of an over-budget skill");
    assert.equal(mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" }).ok, false);
  });
});
