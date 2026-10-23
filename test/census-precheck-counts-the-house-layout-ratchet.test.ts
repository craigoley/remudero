/**
 * THE PRE-PUSH CENSUS PRECHECK COUNTS THE HOUSE-LAYOUT RATCHET — W1-T4899.
 *
 * test/repo-layout.test.ts refuses a branch that takes a house-layout literal ('plan/tasks.d',
 * 'MASTER-PLAN.md', '.remudero/', 'learnings/') into more non-test src files than the merge base
 * carries, but only in a CI coverage shard: four PRs went red on it (#7830 #7851 #7855 #7857) after
 * every local gate passed. scripts/census-precheck.mjs now asks the same question through the same
 * module (scripts/house-layout-census.mjs), with no test runner.
 *
 * The pure cases drive `evaluateCensusPrecheck` over in-memory trees; the last goes through a REAL
 * `git push` from a linked worktree so the hook's own path, the one a fleet worker takes, is seen.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateCensusPrecheck, main } from "../scripts/census-precheck.mjs";

// @ts-ignore executable module has no declaration file.
import { qualifiedRunTaskLayoutSplit, houseLiteralCounts } from "../scripts/house-layout-census.mjs";
// @ts-ignore executable module has no declaration file.
import { evaluateCommentLoadRatchet } from "../scripts/comment-load-ratchet.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Tree = Record<string, string>;

const NAMES_PLAN = 'export const dir = "plan/tasks.d";\n';
const NAMES_NOTHING = "export const dir = 1;\n";

function evaluate(head: Tree, base: Tree): string[] {
  const changed = [...new Set([...Object.keys(head), ...Object.keys(base)])].filter((p) => head[p] !== base[p]);
  return evaluateCensusPrecheck({
    changed,
    readHead: (p: string) => head[p] ?? null,
    readBase: (p: string) => base[p] ?? null,
    measuredFiles: [],
    testFiles: [],
    srcFiles: Object.keys(head).filter((p) => p.startsWith("src/") && p.endsWith(".ts")),
  });
}

test("a new src file naming a house-layout literal past the merge base's count is refused, naming the literal and both counts", () => {
  const base = { "src/a.ts": NAMES_PLAN };
  const head = { ...base, "src/b.ts": NAMES_PLAN };
  const found = evaluate(head, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /^house-layout: plan\/tasks\.d now in 2 non-test src files, up from 1 at the merge base/);
  assert.match(found[0], /resolveRepoLayout \(src\/lib\/repo-layout\.ts\)/);
});

test("each house-layout literal is counted on its own, so a second literal in an old file is a finding", () => {
  const base = { "src/a.ts": NAMES_PLAN, "src/b.ts": NAMES_NOTHING };
  const head = { ...base, "src/b.ts": 'export const f = "learnings/";\nexport const g = ".remudero/";\n' };
  const found = evaluate(head, base);
  assert.deepEqual(
    found.map((f) => f.split(" — ")[0]),
    [
      "house-layout: .remudero/ now in 1 non-test src files, up from 0 at the merge base",
      "house-layout: learnings/ now in 1 non-test src files, up from 0 at the merge base",
    ],
  );
});

test("a house-layout count at or below the merge base is not a finding", () => {
  const base = { "src/a.ts": NAMES_PLAN, "src/b.ts": NAMES_PLAN, "src/c.ts": NAMES_NOTHING };
  // Growth main already carries: an unrelated file changes, and the count stays where the base had it.
  assert.deepEqual(evaluate({ ...base, "src/c.ts": "export const x = 2;\n" }, base), []);
  // A second occurrence in a file that already named the literal is the same file, not a new site.
  assert.deepEqual(evaluate({ ...base, "src/a.ts": NAMES_PLAN + NAMES_PLAN }, base), []);
  // A removal, and a file deleted outright, both lower the count.
  assert.deepEqual(evaluate({ ...base, "src/a.ts": NAMES_NOTHING }, base), []);
  const deleted: Tree = { ...base };
  delete deleted["src/b.ts"];
  assert.deepEqual(evaluate(deleted, base), []);
  // A diff that changes no src file reports nothing, however the census stands.
  assert.deepEqual(evaluate({ ...base, "docs/x.md": "plan/tasks.d\n" }, base), []);
});

test("a src file the branch adds that names no literal, and a non-src path that does, report nothing", () => {
  const base = { "src/a.ts": NAMES_PLAN };
  assert.deepEqual(evaluate({ ...base, "src/b.ts": NAMES_NOTHING }, base), []);
  assert.deepEqual(evaluate({ ...base, "scripts/x.mjs": NAMES_PLAN, "test/x.test.ts": NAMES_PLAN }, base), []);
});

function installHook(dir: string): void {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "hooks", "pre-push"), join(dir, "hooks", "pre-push"));
  chmodSync(join(dir, "hooks", "pre-push"), 0o755);
  for (const script of [
    "census-precheck.mjs",
    "clock-signature-ratchet.mjs",
    "comment-load-ratchet.mjs",
    "fixture-copy-census.mjs",
    "house-layout-census.mjs",
    "deps-interface-census.mjs",
    "test-repo-root-codemod.mjs",
  ]) {
    copyFileSync(join(REPO_ROOT, "scripts", script), join(dir, "scripts", script));
  }
  for (const lib of ["argv.mjs", "git.mjs", "author-step-capture.mjs", "json-duplicate-keys.mjs", "instrument-surface-census.mjs", "git-spawn-shapes.mjs", "repo-root.mjs", "retained-fixtures.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", "lib", lib), join(dir, "scripts", "lib", lib));
  }
  writeFileSync(join(dir, "scripts", "rule15-precheck.mjs"), "process.exit(0)\n");
  // The synthetic runner triggers the gardener suite; this fixture measures hook/layout wiring.
  // The real bundled-loader regression runs separately against the complete repository.
  mkdirSync(join(dir, "test", "rules"), { recursive: true });
  writeFileSync(join(dir, "test", "rules", "scout-config-gardener-failed.test.ts"), `
    import assert from "node:assert/strict";
    import { statSync } from "node:fs";
    import { test } from "node:test";
    test("synthetic runner is present in the census child's working directory", () => {
      assert.ok(statSync("src/run-task.ts").isFile());
    });
  `);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
}

let counter = 0;

function pushFixture(seed: Tree, change: Tree) {
  const remote = gitRepo({ kind: "house-layout-remote", bare: true });
  const parent = gitRepo({ kind: "house-layout-parent" });
  const work = parent.addWorktree(join(parent.dir, `house-layout-wt-${counter++}`), "pushbranch");
  const write = (tree: Tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(work.dir, path)), { recursive: true });
      writeFileSync(join(work.dir, path), text);
    }
  };
  installHook(work.dir);
  write(seed);
  work.git("config", "core.hooksPath", "hooks");
  work.addRemote("origin", remote.dir);
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "the base");
  const push = (armed: boolean) =>
    spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
      cwd: work.dir,
      encoding: "utf8",
      env: { ...process.env, RMD_PREPUSH_GATES: armed ? "1" : "0" },
    });
  assert.equal(push(false).status, 0, "seeding the base push");
  work.git("fetch", "--quiet", "origin");
  write(change);
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "the change being pushed");
  return () => push(true);
}

test("a real git push that adds a house-layout site is refused by the hook", () => {
  const r = pushFixture({ "src/a.ts": NAMES_PLAN }, { "src/b.ts": NAMES_PLAN })();
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /house-layout: plan\/tasks\.d now in 2 non-test src files, up from 1 at the merge base/);
  assert.match(r.stderr, /pre-push REFUSED/);
});

test("a real git push that leaves the house-layout count alone passes the hook", () => {
  const r = pushFixture({ "src/a.ts": NAMES_PLAN }, { "src/b.ts": NAMES_NOTHING })();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /census-precheck: OK/);
});

test("census precheck main() reads the tree's own src files: 1 for a new site, 0 for none", (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const build = (change: Tree) => {
    const repo = gitRepo({ kind: "house-layout-main" });
    const write = (tree: Tree) => {
      for (const [path, text] of Object.entries(tree)) {
        mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
        writeFileSync(join(repo.dir, path), text);
      }
    };
    write({ "src/lib/a.ts": NAMES_PLAN });
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "the base");
    repo.git("switch", "--quiet", "-c", "work");
    write(change);
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "the change");
    return repo.dir;
  };
  assert.equal(main(["--root", build({ "src/lib/b.ts": NAMES_PLAN }), "--base", "main"]), 1);
  assert.equal(main(["--root", build({ "src/lib/b.ts": NAMES_NOTHING }), "--base", "main"]), 0);
});

test("a repo with no src directory at all is measured as zero sites, never as could-not-measure", (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const repo = gitRepo({ kind: "house-layout-no-src" });
  writeFileSync(join(repo.dir, "README.md"), "one\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the base");
  repo.git("switch", "--quiet", "-c", "work");
  writeFileSync(join(repo.dir, "README.md"), "two\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the change");
  assert.equal(main(["--root", repo.dir, "--base", "main"]), 0);
});

const RUN_TASK_LAYOUT_SPLIT = { old: "src/run-task.ts", moved: "src/cli/commands/run-task-verb.ts" } as const;
const RUN_TASK_LAYOUT_SPLIT_LITERALS = ["plan/tasks.d", "MASTER-PLAN.md", ".remudero/", "learnings/"] as const;

function remainingHouseLayoutViolations(
  violations: Array<{ path: string; comments: number; baseline: number; overage: number }>,
  qualifiedSplit: Readonly<Record<string, number>>,
): Array<{ path: string; comments: number; baseline: number; overage: number }> {
  return violations.filter(v => v.comments - (qualifiedSplit[v.path] ?? 0) > v.baseline);
}

function runTaskLayoutSplitFixture() {
  const once = RUN_TASK_LAYOUT_SPLIT_LITERALS.join("\n");
  const base = new Map<string, string>([[RUN_TASK_LAYOUT_SPLIT.old, once + "\n" + once]]);
  const current = new Map<string, string>([[RUN_TASK_LAYOUT_SPLIT.old, once], [RUN_TASK_LAYOUT_SPLIT.moved, once]]);
  const verdict = () => {
    const counts = houseLiteralCounts(current.values());
    const baseline = houseLiteralCounts(base.values());
    const physical = evaluateCommentLoadRatchet(counts, baseline);
    return remainingHouseLayoutViolations(physical.violations, qualifiedRunTaskLayoutSplit(base, current));
  };
  return { base, current, once, verdict };
}

test("W1-T9332 proposed layout split: exact pair conserves occurrences and relieves only its one physical duplicate", () => {
  const f = runTaskLayoutSplitFixture();
  assert.deepEqual(qualifiedRunTaskLayoutSplit(f.base, f.current), Object.fromEntries(RUN_TASK_LAYOUT_SPLIT_LITERALS.map(literal => [literal, 1])));
  assert.deepEqual(f.verdict(), []);
});

test("W1-T9332 proposed layout split: an extra occurrence in the pair is refused", () => {
  const f = runTaskLayoutSplitFixture();
  f.current.set(RUN_TASK_LAYOUT_SPLIT.moved, f.once + "\nMASTER-PLAN.md");
  assert.deepEqual(f.verdict().map(v => v.path), ["MASTER-PLAN.md"]);
});

test("W1-T9332 proposed layout split: a third file still contributes an unrelieved physical duplicate", () => {
  const f = runTaskLayoutSplitFixture();
  f.current.set("src/third-owner.ts", "MASTER-PLAN.md");
  assert.deepEqual(f.verdict().map(v => v.path), ["MASTER-PLAN.md"]);
});

test("W1-T9332 proposed layout split: an unapproved token gets no relief", () => {
  const f = runTaskLayoutSplitFixture();
  const futureLiteral = "future-house-token/";
  const physical = evaluateCommentLoadRatchet({ [futureLiteral]: 1 }, { [futureLiteral]: 0 });
  assert.deepEqual(remainingHouseLayoutViolations(physical.violations, qualifiedRunTaskLayoutSplit(f.base, f.current)).map(v => v.path), [futureLiteral]);
});

test("W1-T9332 proposed layout split: missing original merge-base owner is refused", () => {
  const f = runTaskLayoutSplitFixture();
  f.base.clear();
  assert.equal(f.verdict().length, 4);
});

test("W1-T9332 proposed layout split: a moved owner already present at merge base is refused", () => {
  const f = runTaskLayoutSplitFixture();
  f.base.set(RUN_TASK_LAYOUT_SPLIT.moved, "no house literal");
  assert.equal(f.verdict().length, 4);
});


test("W1-T9332 structural split: shared qualifier and real pre-push agree, and added occurrences still refuse", () => {
  const f = runTaskLayoutSplitFixture();
  const base = Object.fromEntries(f.base);
  const head = Object.fromEntries(f.current);
  assert.deepEqual(f.verdict(), []);
  assert.deepEqual(evaluate(head, base), []);
  const accepted = pushFixture(base, head)();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout + accepted.stderr, /census-precheck: OK/);
  assert.match(accepted.stdout + accepted.stderr, /W1-T9332 qualified structural split/);
  const extra = { ...head, [RUN_TASK_LAYOUT_SPLIT.moved]: f.once + "\nMASTER-PLAN.md" };
  assert.equal(evaluate(extra, base).length, 1);
  const refused = pushFixture(base, extra)();
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /house-layout: MASTER-PLAN\.md now in 2 non-test src files, up from 1/);
});
