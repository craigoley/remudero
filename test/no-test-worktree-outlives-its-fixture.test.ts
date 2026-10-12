/**
 * test/no-test-worktree-outlives-its-fixture.test.ts — W1-T5625.
 *
 * W1-T5550 moved seven suites' linked worktrees INSIDE their fixture repo's dir, so removing the
 * fixture takes the worktree and its `.git/worktrees/<name>` record together. Its census matched
 * one spelling only, `addWorktree(join(dirname(<x>.dir), ...))`, and three suites still built a
 * sibling another way: a template literal of the fixture dir plus `-wt`, held in a variable, then passed to
 * `worktreeAdd`/`worktreeAddAsync` (src/lib/worker.ts) or `addWorktree`. MEASURED at filing: a
 * CLEAN run of those suites left 10 worktrees and 9 `<wt>.base` sidecars beside the fixtures it
 * removed, each with a dangling gitdir.
 *
 * Two checks keep that from coming back:
 *  1. A census over test/**\/*.ts. In any file that adds a worktree, by any of the four spellings
 *     below, it refuses a path built beside a fixture dir: (a) the fixture dir plus a suffix, as a
 *     template literal or a `+` concatenation, and (b) the fixture's PARENT used as a path base,
 *     through `join`/`resolve` or a template literal. The scope is the whole file,
 *     so a path held in a variable before it is passed is still seen.
 *  2. A real clean run of test/worktree-base-currency-healthy.test.ts under a fresh TMPDIR, which
 *     must leave that TMPDIR empty.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(REPO_ROOT, "test");

/** A file adds a worktree: the fixture helper, both src entry points, or a raw git argv. */
const ADDS_WORKTREE = /\.addWorktree\(|\bworktreeAdd(?:Async)?\(|["']worktree["']\s*,\s*["']add["']/;

/** Shape (a): the fixture's own dir plus a name suffix — a sibling that shares its name. A `/` (a
 *  path inside it) or a `:` (a PATH list, a message) is not a suffix. */
const SUFFIXED_FIXTURE_DIR = /\$\{\s*[A-Za-z_$][\w$.]*\.dir\s*\}[-\w.]|\b[A-Za-z_$][\w$.]*\.dir\s*\+\s*["'`][-\w.]/g;

/** Shape (b): the fixture's PARENT dir used as the base of another path. */
const PARENT_OF_FIXTURE_DIR =
  /\b(?:join|resolve)\(\s*dirname\(\s*[A-Za-z_$][\w$.]*\.dir\s*\)\s*,|\$\{\s*dirname\(\s*[A-Za-z_$][\w$.]*\.dir\s*\)\s*\}\//g;

/** `file:line` for every sibling-shaped path in `text`, if the file adds a worktree at all. */
function siblingPathSites(file: string, text: string): string[] {
  if (!ADDS_WORKTREE.test(text)) return [];
  const sites: string[] = [];
  const aliases = new Set<string>();
  for (const binding of [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$.]*|gitRepo\([^;]*?\))\.dir\b/g,
    /\b(?:const|let|var)\s*\{[^}]*?\bdir\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g,
  ]) {
    for (const match of text.matchAll(binding)) aliases.add(match[1]);
  }
  const shapes = [SUFFIXED_FIXTURE_DIR, PARENT_OF_FIXTURE_DIR];
  for (const alias of aliases) {
    const operand = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    shapes.push(
      new RegExp(`\\$\\{\\s*${operand}\\s*\\}[-\\w.]|(?<![\\w$.])${operand}\\s*\\+\\s*["'\u0060][-\\w.]`, "g"),
      new RegExp(`\\b(?:join|resolve)\\(\\s*dirname\\(\\s*${operand}\\s*\\)\\s*,|\\$\\{\\s*dirname\\(\\s*${operand}\\s*\\)\\s*\\}\\/`, "g"),
    );
  }
  for (const shape of shapes) {
    for (const match of text.matchAll(shape)) {
      sites.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  return sites.sort();
}

function testSources(): Array<{ file: string; text: string }> {
  return readdirSync(TEST_DIR, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts") && !rel.split("/").includes("node_modules"))
    .map((rel) => ({ file: `test/${rel}`, text: readFileSync(join(TEST_DIR, rel), "utf8") }));
}

// Samples are assembled from halves so this file never matches its own census.
const DIR = ".d" + "ir";

test("W1-T5735: a fixture dir held in a plain variable and suffixed is refused", () => {
  const bindings = [
    ["const repo = fixture", DIR, ";"].join(""),
    ["const { d", "ir: repo } = gitRepo();"].join(""),
    ["const repo = gitRepo({ name: \"fixture\" })", DIR, ";"].join(""),
  ];
  for (const binding of bindings) {
    for (const path of [
      "const wt = `${repo}-wt`;",
      'const wt = repo + "-wt";',
      'const wt = join(dirname(repo), "wt");',
      "const wt = `${dirname(repo)}/wt`;",
    ]) {
      const text = [binding, path, 'worktreeAdd(repo, wt, "run");'].join("\n");
      assert.deepEqual(siblingPathSites("alias.ts", text), ["alias.ts:2"], text);
    }
    const inside = [binding, 'const wt = repo + "/wt";', 'worktreeAdd(repo, wt, "run");'].join("\n");
    assert.deepEqual(siblingPathSites("inside-alias.ts", inside), []);
    assert.deepEqual(siblingPathSites("noadd-alias.ts", binding + '\nconst wt = `${repo}-wt`;'), []);
  }
  const unrelated = 'const repo = "somewhere";\nconst wt = `${repo}-wt`;\nworktreeAdd(repo, wt, "run");';
  assert.deepEqual(siblingPathSites("non-fixture.ts", unrelated), []);
});

test("W1-T5625 census: shape (a), the fixture dir plus a suffix, is seen however the path reaches the add", () => {
  const held = ["const wt = `${repo", DIR, "}-wt`;", "worktreeAdd(repo", DIR, ", wt, \"run\");"].join("");
  assert.deepEqual(siblingPathSites("held.ts", held), ["held.ts:1"]);
  const later = ["const a = `${repo", DIR, "}-async`;\nconst b = 1;\nawait worktreeAddAsync(r, a);"].join("");
  assert.deepEqual(siblingPathSites("async.ts", later), ["async.ts:1"]);
  const concat = ["git(\"worktree\", \"add\", repo", DIR, " + \"-wt\");"].join("");
  assert.deepEqual(siblingPathSites("concat.ts", concat), ["concat.ts:1"]);
  const helper = ["const w = repo.addWorktree(`${repo", DIR, "}-wt`, \"b\");"].join("");
  assert.deepEqual(siblingPathSites("helper.ts", helper), ["helper.ts:1"]);
});

test("W1-T5625 census: shape (b), the fixture's parent as a path base, is seen in both spellings", () => {
  const joined = ["const work = parent.addWorktree(join(dirname(parent", DIR, "), `x-wt`), \"b\");"].join("");
  assert.deepEqual(siblingPathSites("joined.ts", joined), ["joined.ts:1"]);
  const templated = ["const wt = `${dirname(repo", DIR, ")}/wt`;\nworktreeAdd(repo", DIR, ", wt, \"r\");"].join("");
  assert.deepEqual(siblingPathSites("templated.ts", templated), ["templated.ts:1"]);
});

test("W1-T5625 census: a worktree INSIDE its fixture dir, or a sibling path in a file that adds none, is not flagged", () => {
  const inside = [
    "const a = join(repo", DIR, ", \"wt\");",
    "const b = `${repo", DIR, "}/wt`;",
    "const c = repo", DIR, " + \"/wt\";",
    "assert.equal(resolve(dirname(repo", DIR, ")), resolve(tmpdir()));",
    "process.env.PATH = `${gh", DIR, "}:${saved}`;",
    "worktreeAdd(repo", DIR, ", a, \"r\");",
  ].join("\n");
  assert.deepEqual(siblingPathSites("inside.ts", inside), []);
  assert.deepEqual(siblingPathSites("noadd.ts", ["const x = `${repo", DIR, "}-wt`;"].join("")), []);
});

test("W1-T5625 census: no test under test/ builds a worktree path beside its fixture dir in any spelling", () => {
  const sources = testSources();
  // Corpus control: the scan reads a file that adds a worktree by each spelling it keys on.
  const adders = sources.filter((s) => ADDS_WORKTREE.test(s.text)).map((s) => s.file);
  for (const suite of [
    "test/worktree-base-currency-healthy.test.ts", // worktreeAdd
    "test/worktree-add-async.test.ts", // worktreeAddAsync
    "test/helpers/git-repo.test.ts", // .addWorktree
    "test/adhoc-lane-reap.test.ts", // "worktree", "add"
  ]) {
    assert.ok(adders.includes(suite), `the scan must read ${suite}, which adds a worktree`);
  }
  const offenders = sources.flatMap((s) => siblingPathSites(s.file, s.text));
  assert.deepEqual(
    offenders,
    [],
    "build the worktree path INSIDE the fixture dir (join(repo.dir, \"wt\")) — a sibling outlives the fixture",
  );
});

test("W1-T5625: a clean run of the healthy-path worktree suite leaves its TMPDIR empty", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5625-root-`));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root };
  // A nested `node --test` reads NODE_TEST_CONTEXT as "report to a parent runner"; this one is its own.
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = ""; // a nested runner under a coverage session must not enrol in it
  delete env.RMD_ALLOW_LIVE_WRITES;
  delete env.RMD_SELF_SYNC_DONE;
  const run = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/worktree-base-currency-healthy.test.ts"],
    { cwd: REPO_ROOT, env, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `the suite must pass for its leftovers to mean anything:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /# pass 3\b/, "control: all three tests ran");
  // tsx keeps its transform cache at `<TMPDIR>/tsx-<uid>`: the loader's, not anything the suite made.
  const left = readdirSync(root).filter((name) => !/^tsx-\d+$/.test(name));
  assert.deepEqual(left.sort(), [], "a clean exit removes every worktree, sidecar and fixture it made");
});
