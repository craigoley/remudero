/**
 * A CENSUS THIS BRANCH GROWS IS REFUSED BEFORE THE PUSH — scripts/census-precheck.mjs, run by
 * hooks/pre-push. It asks the clock-signature, comment-load and fixture-copy censuses their own
 * questions without a test runner (W1-T3225 removed that from the hook), and blocks only growth
 * the branch causes against its merge base.
 *
 * The pure cases drive `evaluateCensusPrecheck` over in-memory trees. The last two go through a
 * REAL `git push` from a linked worktree, the way test/the-hook-spawns-no-test-suite.test.ts does,
 * because a hand-invoked hook runs in an environment the fleet never sees.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { lstatSync, chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateCensusPrecheck, main } from "../scripts/census-precheck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CLOCK = "scripts/clock-signature-baseline.json";
const COMMENTS = "scripts/comment-load-baseline.json";
const FIXTURES = "scripts/fixture-copy-baseline.json";
// Built by concatenation so THIS file never scores as a raw init site in the census it tests.
const INIT_SITE = 'run(["' + 'init"]);\n';
const comments = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join("\n") + "\n";

type Tree = Record<string, string>;

function evaluate(head: Tree, base: Tree): string[] {
  const changed = [...new Set([...Object.keys(head), ...Object.keys(base)])].filter((p) => head[p] !== base[p]);
  const testFiles = Object.keys(head)
    .filter((p) => /^test\/[^/]+\.test\.ts$/.test(p))
    .map((p) => p.slice("test/".length));
  return evaluateCensusPrecheck({
    changed,
    readHead: (p: string) => head[p] ?? null,
    readBase: (p: string) => base[p] ?? null,
    measuredFiles: Object.keys(head).filter((p) => p.startsWith("src/")),
    testFiles,
  });
}

const baselines: Tree = {
  [CLOCK]: JSON.stringify({ "src/a.ts": { legacy: 0, dateNow: 1, newDate: 0 } }),
  [COMMENTS]: JSON.stringify({}),
  [FIXTURES]: JSON.stringify({ gitInitSites: 1, gitInitFiles: 1 }),
};

test("census precheck: a new Date.now() past a file's clock row is refused, naming the file and the count", () => {
  const base = { ...baselines, "src/a.ts": "export const t = Date.now();\n" };
  const head = { ...base, "src/a.ts": "export const t = Date.now();\nexport const u = Date.now();\n" };
  const found = evaluate(head, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /clock-signature: src\/a\.ts dateNow 2 > baseline 1/);
});

test("census precheck: comment volume above the old bucket does not refuse the push", () => {
  const base = { ...baselines, "src/b.ts": comments(10) };
  const head = { ...base, "src/b.ts": comments(260) };
  const found = evaluate(head, base);
  assert.deepEqual(found, [], "the operator routes comment volume to follow-up work");
});

test("census precheck: a legacy comment-load row cannot refuse the push", () => {
  const base = { ...baselines, "src/b.ts": comments(10) };
  const head = { ...base, [COMMENTS]: JSON.stringify({ "src/b.ts": 250 }) };
  const found = evaluate(head, base);
  assert.deepEqual(found, [], "legacy ledger housekeeping is not a correctness gate");
});

test("census precheck: a hand-rolled fixture past the fixture-copy baseline is refused, naming the signature", () => {
  const base = { ...baselines, "test/one.test.ts": INIT_SITE };
  const head = { ...base, "test/two.test.ts": INIT_SITE };
  const found = evaluate(head, base);
  assert.deepEqual(
    found.map((f) => f.split(" — ")[0]),
    ["fixture-copy: gitInitSites 2 > baseline 1", "fixture-copy: gitInitFiles 2 > baseline 1"],
  );
});

test("census precheck: an EXISTING test file that gains a hand-rolled fixture is charged the growth, not the file", () => {
  const base = { ...baselines, "test/one.test.ts": INIT_SITE };
  const head = { ...base, "test/one.test.ts": INIT_SITE + INIT_SITE };
  const found = evaluate(head, base);
  assert.deepEqual(found.map((f) => f.split(" — ")[0]), ["fixture-copy: gitInitSites 2 > baseline 1"]);
});

test("census precheck: growth main already carries is not this branch's, but growing it further is", () => {
  // The base is already over its clock row. A branch that leaves the file alone must push; one that
  // adds another site on top must not.
  const base = { ...baselines, "src/a.ts": "Date.now();\nDate.now();\n", "src/other.ts": "export {};\n" };
  assert.deepEqual(evaluate({ ...base, "src/other.ts": "export const x = 1;\n" }, base), []);
  assert.deepEqual(evaluate({ ...base, "src/a.ts": "Date.now();\nDate.now();\n// edit\n" }, base), []);
  const grown = evaluate({ ...base, "src/a.ts": "Date.now();\nDate.now();\nDate.now();\n" }, base);
  assert.equal(grown.length, 1, grown.join("\n"));
});

test("census precheck: lowering a clock row below the file's own count is refused, like growth", () => {
  const base = { ...baselines, "src/a.ts": "export const t = Date.now();\n" };
  const head = { ...base, [CLOCK]: JSON.stringify({ "src/a.ts": { legacy: 0, dateNow: 0, newDate: 0 } }) };
  const found = evaluate(head, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /clock-signature: src\/a\.ts dateNow 1 > baseline 0/);
});

test("census precheck: a clean change, a deleted file and a changed census suite report nothing", () => {
  const base = { ...baselines, "src/a.ts": "Date.now();\n", "test/one.test.ts": INIT_SITE, "src/gone.ts": comments(300) };
  const head: Tree = { ...base, "src/a.ts": "Date.now(); // tidy\n", "test/fixture-copy-census.test.ts": INIT_SITE + INIT_SITE };
  delete head["src/gone.ts"];
  assert.deepEqual(evaluate(head, base), []);
});

/** This repo's real hook and the precheck's scripts, copied into `dir` — plus the node_modules
 *  symlink spawnWorker gives every worktree, and a passing rule15 stub the hook runs first. */
function installHook(dir: string): void {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  mkdirSync(join(dir, "test", "setup"), { recursive: true });
  assert.equal(lstatSync(join(dir, "test", "setup")).isSymbolicLink(), false,
    "the fixture owns its preload directory; lending it lets fixture writes change the checkout");
  writeFileSync(join(dir, "test", "setup", "tmp-hygiene.ts"),
    `import ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "test/setup/tmp-hygiene.ts")).href)};\n`);
  copyFileSync(join(REPO_ROOT, "src", "lib", "rule-suites.ts"), join(dir, "src", "lib", "rule-suites.ts"));
  copyFileSync(join(REPO_ROOT, "src", "lib", "trust-root-text.ts"), join(dir, "src", "lib", "trust-root-text.ts"));
  copyFileSync(join(REPO_ROOT, "hooks", "pre-push"), join(dir, "hooks", "pre-push"));
  chmodSync(join(dir, "hooks", "pre-push"), 0o755);
  for (const script of ["census-precheck.mjs", "clock-signature-ratchet.mjs", "comment-load-ratchet.mjs", "fixture-copy-census.mjs", "house-layout-census.mjs", "deps-interface-census.mjs", "test-repo-root-codemod.mjs", "coverage-session-blanking-check.mjs",
    // The suite child is judged (W1-T8379): the judge and the two files its argv names.
    "pure-test-pool.mjs", "pool-run-marker.mjs", "pool-run-tally.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", script), join(dir, "scripts", script));
  }
  for (const lib of ["argv.mjs", "git.mjs", "author-step-capture.mjs", "json-duplicate-keys.mjs", "instrument-surface-census.mjs", "git-spawn-shapes.mjs", "repo-root.mjs", "retained-fixtures.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", "lib", lib), join(dir, "scripts", "lib", lib));
  }
  writeFileSync(join(dir, "scripts", "rule15-precheck.mjs"), "process.exit(0)\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
}

let counter = 0;

/** The mandatory skill census runs on every nonempty diff, so each fixture base carries a healthy stand-in. */
const SKILL_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const SKILL_CENSUS_STUB = 'import { test } from "node:test"; test("healthy mandatory fixture census", () => {});\n';

/** A linked worktree whose origin/main holds `seed`, with this repo's real hook and precheck
 *  installed through core.hooksPath, and `change` committed on the branch being pushed. */
function pushFixture(seed: Tree, change: Tree) {
  const remote = gitRepo({ kind: "census-precheck-remote", bare: true });
  const parent = gitRepo({ kind: "census-precheck-parent" });
  const work = parent.addWorktree(join(parent.dir, `census-precheck-wt-${counter++}`), "pushbranch");
  const write = (tree: Tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(work.dir, path)), { recursive: true });
      writeFileSync(join(work.dir, path), text);
    }
  };
  installHook(work.dir);
  write({ ...seed, [SKILL_CENSUS]: SKILL_CENSUS_STUB });
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

test("census precheck: a real git push that grows a clock row is REFUSED by the hook, naming the file", () => {
  const seed = { ...baselines, "src/a.ts": "export const t = Date.now();\n" };
  const push = pushFixture(seed, { "src/a.ts": "export const t = Date.now();\nexport const u = Date.now();\n" });
  const r = push();
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /clock-signature: src\/a\.ts dateNow 2 > baseline 1/);
  assert.match(r.stderr, /pre-push REFUSED/);
});

test("census precheck: a real git push of a clean change passes, and one with no origin/main is named, not blocked", () => {
  const seed = { ...baselines, "src/a.ts": "export const t = Date.now();\n" };
  const clean = pushFixture(seed, { "src/a.ts": "export const t = Date.now(); // tidy\n" })();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout + clean.stderr, /census-precheck: OK/);

  const remote = gitRepo({ kind: "census-precheck-lone-remote", bare: true });
  const lone = gitRepo({ kind: "census-precheck-lone" });
  installHook(lone.dir);
  lone.git("config", "core.hooksPath", "hooks");
  lone.addRemote("origin", remote.dir);
  lone.git("add", "-A");
  lone.git("commit", "--quiet", "-m", "a branch with no origin/main to measure against");
  const r = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
    cwd: lone.dir,
    encoding: "utf8",
    env: { ...process.env, RMD_PREPUSH_GATES: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /census-precheck could not measure — not blocking/);
});

/** A repo on branch `work`, cut from `main` holding `seed`, with `change` committed on top — for
 *  driving `main()` in-process, so its git and file readers run against a real tree. */
function branchFixture(seed: Tree, change: Tree): string {
  const repo = gitRepo({ kind: "census-precheck-main" });
  const write = (tree: Tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
  };
  write({ ...seed, [SKILL_CENSUS]: SKILL_CENSUS_STUB });
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the base");
  repo.git("switch", "--quiet", "-c", "work");
  write(change);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the change");
  return repo.dir;
}

test("census precheck main(): 1 and the named finding for caused growth, 0 for a clean change", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const logs = t.mock.method(console, "log", () => {});
  const seed = { ...baselines, "src/a.ts": "export const t = Date.now();\n" };
  const grown = branchFixture(seed, { "src/a.ts": "export const t = Date.now();\nexport const u = Date.now();\n" });
  assert.equal(main(["--root", grown, "--base", "main"]), 1);
  assert.match(errors.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /src\/a\.ts dateNow 2 > baseline 1/);
  const clean = branchFixture(seed, { "src/a.ts": "export const t = Date.now(); // tidy\n" });
  assert.equal(main(["--root", clean, "--base", "main"]), 0);
  assert.match(String(logs.mock.calls.at(-1)?.arguments[0]), /census-precheck: OK — 1 changed file\(s\)/);
});

test("census precheck main(): an unknown base or an unknown flag is 2, could-not-measure, never a violation", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const dir = branchFixture({ ...baselines }, { "src/a.ts": "export {};\n" });
  assert.equal(main(["--root", dir, "--base", "no-such-ref"]), 2);
  assert.equal(main(["--no-such-flag"]), 2);
  assert.ok(errors.mock.calls.every((c) => /could not measure/.test(String(c.arguments[0]))));
});


test("a real push refuses a newly unblanked child coverage session and accepts effective blanking", () => {
  const bad = "const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;\n";
  const good = bad + "childEnv.NODE_V8_COVERAGE = undefined;\n";
  const guard = `import assert from "node:assert/strict";
import { test } from "node:test";
import { scanRepo } from "#scripts/coverage-session-blanking-check.mjs";
test("the actual classifier sees a complete owned corpus", () => {
  const measured = scanRepo(process.cwd());
  assert.ok(measured.filesScanned >= 2);
  assert.deepEqual(measured.defects, []);
  assert.deepEqual(measured.suspects, []);
});
`;
  const seed = {
    ...baselines,
    "package.json": JSON.stringify({ type: "module", imports: { "#scripts/*": "./scripts/*" } }),
    "test/coverage-session-blanking.test.ts": guard,
    "test/setup/tmp-hygiene.ts": `import ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "test/setup/tmp-hygiene.ts")).href)};\n`,
    "test/child.ts": good,
    // A suite this push joins. Its child is judged (W1-T8379), so a joined path with no file fails instead of passing.
    "test/every-ci-census-is-asked-before-the-push.test.ts": 'import { test } from "node:test";\ntest("census stand-in", () => undefined);\n',
  };
  const refused = pushFixture(seed, { "test/child.ts": bad })();
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /census-suite: test\/coverage-session-blanking\.test\.ts fails/);
  assert.match(refused.stderr, /pre-push REFUSED/);
  const accepted = pushFixture(seed, { "test/coverage-session-blanking.test.ts": guard + "\n// a fresh clean measurement\n" })();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout + accepted.stderr, /census-precheck: OK/);
});
