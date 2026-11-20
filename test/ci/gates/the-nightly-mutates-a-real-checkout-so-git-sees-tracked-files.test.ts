import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13903: Mutation Nightly failed 7 of 10 nights. Stryker's default sandbox is a gitignored
// subfolder with no .git, so every test that runs git against REPO_ROOT saw untracked paths there.
const SANDBOX_RED_RUNS = "42750186208 42953579466 43149001216 43359737571 43552241378 44011034405 44452272063";

const scriptModule = "#scripts/mutation-ratchet.mjs";
const { buildNightlyStrykerConfig } = await import(scriptModule);

type Step = { id?: string; run?: string };
const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/mutation-nightly.yml"), "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const steps = workflow.jobs["mutation-nightly"]!.steps;

test("the nightly config mutates in place and rewrites no file for type checks", () => {
  const cfg = buildNightlyStrykerConfig("src/lib/alpha.ts", ["test/one.test.ts"], {
    reportPath: "reports/mutation/nightly/alpha.json",
    tempDirName: ".stryker-tmp-alpha",
  }) as Record<string, unknown>;
  assert.equal(cfg.inPlace, true, `a sandbox subfolder is not a git checkout (runs ${SANDBOX_RED_RUNS})`);
  assert.equal(cfg.disableTypeChecks, false, "a ts-nocheck rewrite of every src file dirties the tree in place");
});

test("the mark step runs after the plan and before the in-place stryker loop", () => {
  const ids = steps.map((s) => s.id);
  const mark = ids.indexOf("mark-mutate-targets");
  assert.ok(mark > ids.indexOf("plan") && mark < ids.indexOf("stryker"), JSON.stringify(ids));
});

function fixture(t: TestContext): string {
  const repo = gitRepo({ seedCommit: false, kind: "nightly-in-place" });
  t.after(() => repo.cleanup());
  const root = repo.dir;
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "alpha.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "lib", "beta.ts"), "export const b = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "fixture");
  // What Stryker does in place: the target file is rewritten with instrumented code.
  writeFileSync(join(root, "src", "lib", "alpha.ts"), "export const a = stryMutAct_9fa48(\"0\") ? 0 : 1;\n");
  return root;
}

const status = (root: string) => execFileSync("git", ["-C", root, "status", "--porcelain", "--", "src"], { encoding: "utf8" });

function runMark(root: string, mutate: string) {
  const script = steps.find((s) => s.id === "mark-mutate-targets")?.run;
  assert.ok(script, "the workflow has a mark-mutate-targets run: script");
  return spawnSync("bash", ["-c", script], { cwd: root, env: { ...process.env, MUTATE: mutate }, encoding: "utf8" });
}

test("the mark step makes an in-place mutate target read as HEAD to git status", (t) => {
  const root = fixture(t);
  assert.match(status(root), /src\/lib\/alpha\.ts/, "control: the instrumented file reads as dirty without the step");
  const result = runMark(root, "src/lib/alpha.ts,src/lib/beta.ts");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(status(root), "", "the instrumented target reads as HEAD");
});

test("the mark step is a no-op on a night with nothing included", (t) => {
  const root = fixture(t);
  const result = runMark(root, "");
  assert.equal(result.status, 0, result.stderr);
  assert.match(status(root), /src\/lib\/alpha\.ts/);
});
