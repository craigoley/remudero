import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-macro-skills.mjs");
const TABLE = join(REPO_ROOT, "settings", "macros.yaml");

/**
 * test/operator-macros-are-generated.test.ts — W1-T2763.
 *
 * The operator types standing shorthand into sessions — `tddr`, `grfp` — and the model EXPANDS IT
 * BY GUESSING. A guess is right until it is not, and nothing records which expansion a session
 * used. Claude Code substitutes a skill's body VERBATIM when the operator types `/name`, and
 * `disable-model-invocation: true` means only the operator can invoke it, so one tracked table
 * plus a generator turns the guess into a substitution.
 *
 * The generated files are gated the way `docs/cli-reference.md` is: a macro's expansion is a
 * standing instruction that will be edited, and two hand-kept copies drift. This suite drives the
 * REAL script — including through `npm run macro-skills:check`, which is what puts the gate inside
 * `npm test` and therefore inside CI's required `ci` job.
 *
 * `scripts/**` sits outside tsconfig's `include`, so the module is reached through a runtime
 * `import(pathToFileURL(...))` rather than a static one (TS7016) — the same route
 * test/a-source-file-cannot-outgrow-its-baseline.test.ts already takes, so there is no shadow copy
 * to drift from the real generator.
 */
const {
  MacroSkillError,
  claudeMdHeadlines,
  main,
  orphanedSkillNames,
  renderAllMacroSkills,
  renderMacroSkill,
  rmdVerbNames,
  validateMacro,
} = (await import(pathToFileURL(SCRIPT).href)) as {
  MacroSkillError: new (m: string) => Error;
  claudeMdHeadlines: (text: string) => string[];
  main: (argv: string[], deps?: Record<string, unknown>) => number;
  orphanedSkillNames: (rendered: Array<{ name: string }>, skillsDir?: string) => string[];
  renderAllMacroSkills: (deps?: Record<string, unknown>) => Array<{ name: string; relPath: string; text: string }>;
  renderMacroSkill: (macro: Record<string, unknown>) => string;
  rmdVerbNames: (usage: string) => string[];
  validateMacro: (macro: unknown, headlines: string[], verbs: string[]) => unknown;
};

const HEADLINES = ["Investigation discipline", "Ledger and evidence discipline", "Plan and task hygiene"];
const VERBS = ["deploy", "review", "status"];

// ── acceptance 1: every row renders one user-invocable-only skill carrying the expansion verbatim ──

test("W1-T2763 (acceptance 1a): every macro row renders a skill marked user-invocable-only, carrying the row's expansion VERBATIM", () => {
  const rendered = renderAllMacroSkills();
  assert.ok(rendered.length >= 2, "the table's seed rows");
  const table = readFileSync(TABLE, "utf8");
  for (const r of rendered) {
    assert.equal(r.relPath, `.claude/skills/${r.name}/SKILL.md`, "one skill per row, at the path Claude Code reads");
    assert.match(r.text, /^---\n/, "frontmatter first");
    assert.match(r.text, new RegExp(`^name: ${r.name}$`, "m"));
    assert.match(r.text, /^disable-model-invocation: true$/m, "only the operator may invoke it");
    assert.match(r.text, /^description: \S/m, "and it carries a description line");
  }
  // VERBATIM is the claim, so assert on the text itself rather than on its presence: a distinctive
  // sentence from the table must appear unaltered in the rendered skill.
  const tddr = rendered.find((r) => r.name === "tddr");
  assert.ok(tddr, "the seed macro renders");
  assert.ok(
    tddr.text.includes("A zero is not a measurement until a positive control proves the query could see its"),
    "the expansion reaches the skill unaltered — a paraphrase here would be the guess this replaces",
  );
  assert.ok(table.includes("A zero is not a measurement until a positive control proves the query could see its"));
});

test("W1-T2763 (acceptance 1b): a row with `args` appends $ARGUMENTS last, and one without does not", () => {
  const withArgs = renderMacroSkill({ name: "a", summary: "s", expansion: "body", headlines: [], args: true });
  assert.match(withArgs, /\$ARGUMENTS\n$/, "appended LAST — Claude Code inserts it as literal text");
  const without = renderMacroSkill({ name: "b", summary: "s", expansion: "body", headlines: [], args: false });
  assert.doesNotMatch(without, /\$ARGUMENTS/);
});

test("W1-T2763 (acceptance 1c): the rendered output is CONTENT-ONLY, so --check is a staleness gate and not a permanent false positive", () => {
  const first = renderAllMacroSkills();
  const second = renderAllMacroSkills();
  assert.deepEqual(
    first.map((r) => r.text),
    second.map((r) => r.text),
    "two regenerations are byte-identical — no timestamp, no environment data",
  );
});

// ── acceptance 2: a hand-edited skill fails the drift check, NAMING the macro ──────────────────

test("W1-T2763 (acceptance 2): a hand-edited skill file fails --check and the failure NAMES the macro", () => {
  // AGAINST A TEMP ROOT, NEVER THE TRACKED TREE. Editing a committed skill and restoring it would
  // leave the repo dirty on any crash between the two — the debris-that-reads-as-a-regression
  // shape. `main`'s `repoRoot`/`skillsDir` seams exist for exactly this, so the REAL generator and
  // the REAL comparison run over a tree this test owns.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}macro-drift-`));
  try {
    const rendered = renderAllMacroSkills();
    for (const r of rendered) {
      const path = join(root, r.relPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, r.text);
    }
    const skillsDir = join(root, ".claude", "skills");

    // CONTROL FIRST: the freshly written tree passes, so the failure below is about the edit
    // rather than about the check being permanently red against a temp root.
    const clean: string[] = [];
    assert.equal(
      main(["--check"], { repoRoot: root, skillsDir, log: (m: string) => clean.push(m), error: (m: string) => clean.push(m) }),
      0,
      clean.join("\n"),
    );
    assert.match(clean.join("\n"), /OK — 2 generated skill\(s\) match/);

    // NOW the hand edit.
    const edited = join(root, ".claude", "skills", "tddr", "SKILL.md");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}\nhand-edited\n`);
    const errors: string[] = [];
    const code = main(["--check"], { repoRoot: root, skillsDir, log: () => {}, error: (m: string) => errors.push(m) });
    assert.equal(code, 1, "a hand edit must fail the gate");
    const text = errors.join("\n");
    assert.match(text, /STALE/);
    assert.match(text, /`tddr`/, "and NAME the macro that drifted — a refusal a reader cannot act on costs a re-derivation");
    assert.doesNotMatch(text, /`grfp`/, "naming ONLY the file that drifted, not every generated file");
    assert.match(text, /Edit the table, not the skill/, "pointing at the source of truth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2763 (acceptance 2b): the COMMITTED skills are current — the same gate, run through the real repo, read-only", () => {
  const r = spawnSync("node", ["--import", "tsx", SCRIPT, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /OK — 2 generated skill\(s\) match/);
});

test("W1-T2763: a skill dir with no row is reported as ORPHANED — a deleted macro must not leave an invocable skill behind", () => {
  const orphans = orphanedSkillNames([{ name: "tddr" }]);
  assert.ok(orphans.includes("grfp"), `grfp has a row but was not declared here, so it reads orphaned: ${JSON.stringify(orphans)}`);
  assert.deepEqual(orphanedSkillNames([{ name: "tddr" }, { name: "grfp" }]), [], "the real declared set leaves none");
});

// ── acceptance 3: a macro naming a missing headline is refused, with the headline QUOTED ───────

test("W1-T2763 (acceptance 3): a macro naming a headline absent from CLAUDE.md is refused with the headline quoted", () => {
  assert.throws(
    () => validateMacro({ name: "x", summary: "s", expansion: "b", headlines: ["No Such Headline"] }, HEADLINES, VERBS),
    (err: Error) => {
      assert.ok(err instanceof MacroSkillError);
      assert.match(err.message, /"No Such Headline"/, "the missing headline is QUOTED, not merely counted");
      assert.match(err.message, /red check, never a silently orphaned macro/);
      assert.match(err.message, /Known headlines: /, "and the reader is told what IS available");
      return true;
    },
  );
  // BLOCKING CONTROL: a row naming a headline that DOES exist must pass, or the throw above proves
  // nothing about the headline check.
  assert.doesNotThrow(() =>
    validateMacro({ name: "x", summary: "s", expansion: "b", headlines: ["Investigation discipline"] }, HEADLINES, VERBS),
  );
});

test("W1-T2763: the headline set is READ from CLAUDE.md, so a renamed rule reddens rather than orphaning a macro", () => {
  const real = claudeMdHeadlines(readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8"));
  assert.ok(real.includes("Investigation discipline"), `parsed headlines: ${JSON.stringify(real)}`);
  assert.ok(real.length >= 5, "the document's own `##` sections, not a copy of them");
  // The committed table's headlines must all be in that set — the live guard, not a fixture.
  for (const r of renderAllMacroSkills()) assert.ok(r.text.length > 0);
});

test("W1-T2763: an empty expansion and an rmd-verb collision are both refused, each naming what is wrong", () => {
  assert.throws(
    () => validateMacro({ name: "x", summary: "s", expansion: "   " }, HEADLINES, VERBS),
    /an empty substitution is worse than the guess it replaces/,
  );
  assert.throws(
    () => validateMacro({ name: "deploy", summary: "s", expansion: "b" }, HEADLINES, VERBS),
    /shares its name with the `rmd deploy` verb/,
  );
  assert.doesNotThrow(() => validateMacro({ name: "notaverb", summary: "s", expansion: "b" }, HEADLINES, VERBS));
});

test("W1-T2763: the verb list is read from the CLI's own reference, never a second hand-kept copy", () => {
  const verbs = rmdVerbNames(readFileSync(join(REPO_ROOT, "docs", "cli-reference.md"), "utf8"));
  assert.ok(verbs.length > 20, `expected the real verb list, got ${verbs.length}`);
  assert.ok(verbs.includes("review"), "a verb that certainly exists — the positive control for this parse");
});

// ── acceptance 5: the check is wired the way the cli reference is ──────────────────────────────

test("W1-T2763 (acceptance 5): package.json declares macro-skills and macro-skills:check, beside the cli-reference pair they mirror", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["macro-skills"], /generate-macro-skills\.mjs/);
  assert.match(pkg.scripts["macro-skills:check"], /generate-macro-skills\.mjs --check/);
  assert.ok(pkg.scripts["cli-reference:check"], "the precedent this mirrors still exists");
});

test("W1-T2763: the gate runs inside `npm test` — this suite IS the wiring, and it drives the npm script itself", () => {
  // `npm test` runs `node --test test/**/*.test.ts`, so a generated-file gate reaches CI by being
  // driven from a suite. Running the npm SCRIPT (not the file directly) is what proves the
  // package.json entry is the thing CI would use.
  const r = spawnSync("npm", ["run", "--silent", "macro-skills:check"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /macro-skills:check: OK/);
});

// ── main()'s own exit codes, driven through the injectable seam ────────────────────────────────

test("W1-T2763: main --check returns 1 and says why when a table row is invalid, and 0 when everything matches", () => {
  const errors: string[] = [];
  const code = main(["--check"], {
    readFile: (p: string) =>
      String(p).endsWith("macros.yaml")
        ? "macros:\n  - name: bad\n    summary: s\n"
        : readFileSync(String(p), "utf8"),
    error: (m: string) => errors.push(m),
    log: () => {},
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /macro `bad` has no `expansion`/);

  assert.equal(main(["--check"], { log: () => {}, error: (m: string) => errors.push(m) }), 0, errors.join("\n"));
});

// ── the generated files must be TRACKED, or the gate compares against nothing ──────────────────

test("W1-T2763: the generated skills are TRACKED — .claude/* is ignored, so an un-ignore is what keeps the drift gate from passing vacuously", () => {
  // A --check that compares a rendered file against an UNTRACKED path still passes locally and
  // then compares against a missing file in a fresh clone. The vacuous-pass family: OK over a set
  // where failure is unreachable. So assert git itself would track these paths.
  for (const rel of [".claude/skills/tddr/SKILL.md", ".claude/skills/grfp/SKILL.md"]) {
    const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(r.status, 0, `${rel} is gitignored — the drift gate would compare against nothing in a fresh clone`);
  }
  // CONTROL, in the other direction: the un-ignore must be NARROW. Operator-local state under
  // .claude/ (transcripts, session caches) must still be ignored, or this traded a vacuous gate
  // for a repo that commits session state.
  const local = spawnSync("git", ["check-ignore", "-q", ".claude/statsig/probe.json"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(local.status, 0, "unrelated .claude/ state must stay ignored — the un-ignore is one generated tree, not the directory");
});
