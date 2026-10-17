/**
 * W1-T9860 — a test is found by its unique basename when its cited path is gone (operator ruling 5, 2026-10-16).
 * Every fixture is a REAL git repository, so the resolver's default git reads (rev-parse, ls-tree through
 * hostWorktreeGit) and the reviewer's real grep executor run here, not a fake of them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import {
  ELIGIBLE_TEST_PATH_RE,
  resolveTestPath,
  type TestBasenameIndex,
  type TestPathResolverGit,
} from "../src/lib/test-path-resolver.js";
import { certainHeadRefusals, judgeCriterion, type WhitelistedProof } from "../src/lib/review.js";
import { checkProofCommand } from "../src/lib/check-proof.js";

const gate = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "acceptance-author-gate.mjs")).href)) as {
  evaluateGate: (input: Record<string, unknown>) => { ok: boolean; defect?: string; message: string };
};

/** A committed repository holding `files` (path -> contents). */
function repoWith(files: Record<string, string>): GitRepo {
  const repo = gitRepo({ kind: "w1-t9860" });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "fixture");
  return repo;
}

/** `rmd check-proof <proof>` run from `dir`, its printed lines and exit code captured. */
function checkProofIn(dir: string, proof: string): { exit: number; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const cwd = process.cwd();
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    process.chdir(dir);
    return { exit: checkProofCommand([proof]), out: lines.join("\n") };
  } finally {
    process.chdir(cwd);
    console.log = log;
  }
}

const MOVED = { "test/folder/moved-widget.test.ts": 'test("W1-T9860 fixture: the widget spins", () => {});\n' };

test("W1-T9860: a moved test resolves by its unique basename", () => {
  const repo = repoWith(MOVED);
  assert.deepEqual(resolveTestPath("test/moved-widget.test.ts", { root: repo.dir }), {
    path: "test/folder/moved-widget.test.ts",
    how: "basename",
  });
  assert.deepEqual(resolveTestPath("test/folder/moved-widget.test.ts", { root: repo.dir }), {
    path: "test/folder/moved-widget.test.ts",
    how: "exact",
  });
  // A named tree resolves in ITS index: the exact path is what the tree lists, the fallback is its basename.
  assert.deepEqual(resolveTestPath("test/folder/moved-widget.test.ts", { root: repo.dir, tree: "HEAD" }), {
    path: "test/folder/moved-widget.test.ts",
    how: "exact",
  });
  assert.deepEqual(resolveTestPath("test/moved-widget.test.ts", { root: repo.dir, tree: "HEAD" }), {
    path: "test/folder/moved-widget.test.ts",
    how: "basename",
  });
});

test("W1-T9860: an absent or ambiguous basename stays a failure, never a pass", () => {
  const repo = repoWith({
    "test/a/twin.test.ts": 'test("twin", () => {});\n',
    "test/b/twin.test.ts": 'test("twin", () => {});\n',
    "test/fixtures/checkout/test/existing.test.ts": 'test("fixture", () => {});\n',
  });
  assert.deepEqual(resolveTestPath("test/twin.test.ts", { root: repo.dir }), {
    unresolved: "ambiguous",
    candidates: ["test/a/twin.test.ts", "test/b/twin.test.ts"],
  });
  assert.deepEqual(resolveTestPath("test/never-written.test.ts", { root: repo.dir }), { unresolved: "absent", candidates: [] });
  // test/fixtures/ is not in the index: its test/existing.test.ts is a fixture, never a real test's identity.
  assert.deepEqual(resolveTestPath("test/existing.test.ts", { root: repo.dir }), { unresolved: "absent", candidates: [] });
  // Only test/**.test.ts shapes are eligible; any other path resolves exactly or not at all.
  assert.equal("unresolved" in resolveTestPath("src/twin.test.ts", { root: repo.dir }), true);
  assert.equal(ELIGIBLE_TEST_PATH_RE.test("src/lib/twin.test.ts"), false);
  assert.equal(ELIGIBLE_TEST_PATH_RE.test("test/a/twin.test.ts"), true);
  // A tree git cannot read is absent WITH its reason, never a guess (the real rev-parse, not a fake).
  const unreadable = resolveTestPath("test/twin.test.ts", { root: repo.dir, tree: "no-such-rev" });
  assert.equal("unresolved" in unreadable && unreadable.unresolved, "absent");
  assert.match("reason" in unreadable ? String(unreadable.reason) : "", /the tree could not be read/);

  // The reviewer keeps today's outcome for an unresolved path: the proof runs its cited ghost and FAILS.
  const ambiguous = judgeCriterion({ claim: "c", proof: 'grep: test("twin" in test/twin.test.ts' }, new Set(), undefined, { cwd: repo.dir });
  assert.notEqual(ambiguous.proof_exec, "executed_pass");
  assert.equal(ambiguous.met, false);
  assert.match(ambiguous.reason, /ambiguous, not guessed/);
  const refusals = certainHeadRefusals([{ claim: "c", proof: "unit test: test/twin.test.ts" }, { claim: "d", proof: "unit test: test/never-written.test.ts" }], repo.dir);
  assert.deepEqual(refusals.map((r) => r.proof), ["unit test: test/twin.test.ts", "unit test: test/never-written.test.ts"]);
  assert.match(refusals[0]!.why, /test\/a\/twin\.test\.ts, test\/b\/twin\.test\.ts — ambiguous, not guessed/);
  assert.match(refusals[1]!.why, /no test under test\/ carries its basename/);
  // rmd check-proof names the ambiguity and keeps its exec_error verdict (exit 4), never a pass.
  const checked = checkProofIn(repo.dir, "grep: twin in test/twin.test.ts");
  assert.equal(checked.exit, 4);
  assert.match(checked.out, /basename lookup: ambiguous \(test\/a\/twin\.test\.ts, test\/b\/twin\.test\.ts\) — never guessed/);
  assert.match(checked.out, /resolved: {3}NOT — test\/twin\.test\.ts is absent/);
});

test("W1-T9860: the basename index is built once per tree sha", () => {
  const listed: string[] = [];
  const git: TestPathResolverGit = {
    treeSha: (_root, rev) => (rev === "base" ? "sha-base" : "sha-head"),
    listTestTree: (_root, sha) => {
      listed.push(sha);
      return sha === "sha-head" ? ["test/folder/moved-widget.test.ts"] : ["test/moved-widget.test.ts"];
    },
  };
  const cache = new Map<string, TestBasenameIndex>();
  const at = (path: string, tree: string) => resolveTestPath(path, { root: "/nowhere", tree, git, cache });
  assert.deepEqual(at("test/moved-widget.test.ts", "head"), { path: "test/folder/moved-widget.test.ts", how: "basename" });
  assert.deepEqual(at("test/other.test.ts", "head"), { unresolved: "absent", candidates: [] });
  assert.deepEqual(at("test/moved-widget.test.ts", "head"), { path: "test/folder/moved-widget.test.ts", how: "basename" });
  assert.deepEqual(listed, ["sha-head"], "three lookups in one tree walk it once");
  // A second tree is a second index, so a base proof resolves against the base.
  assert.deepEqual(at("test/moved-widget.test.ts", "base"), { path: "test/moved-widget.test.ts", how: "exact" });
  assert.deepEqual(listed, ["sha-head", "sha-base"]);
  // A listing that fails is not cached and not guessed: the lookup is absent and says why.
  const broken: TestPathResolverGit = { treeSha: () => "sha-broken", listTestTree: () => { throw new Error("ls-tree died"); } };
  const failed = resolveTestPath("test/moved-widget.test.ts", { root: "/nowhere", tree: "x", git: broken, cache });
  assert.deepEqual(failed, { unresolved: "absent", candidates: [], reason: "the tree's test files could not be listed (ls-tree died)" });
  assert.equal(cache.has("sha-broken"), false);
});

test("W1-T9860: a whole-file or grep proof on a moved path runs the moved file", () => {
  const repo = repoWith(MOVED);
  const ran: string[][] = [];
  const exec = (w: WhitelistedProof) => {
    ran.push([...w.args]);
    return "pass" as const;
  };
  const whole = judgeCriterion({ claim: "c", proof: "unit test: test/moved-widget.test.ts" }, new Set(), undefined, { cwd: repo.dir, exec });
  assert.equal(whole.proof_exec, "executed_pass");
  assert.equal(ran[0]!.at(-1), "test/folder/moved-widget.test.ts");
  assert.match(whole.reason, /resolved test\/moved-widget\.test\.ts -> test\/folder\/moved-widget\.test\.ts by basename/);

  // The grep proof runs through the reviewer's REAL executor: it reads the moved file, and a pattern absent from it
  // still fails, so the fallback can only find a file, never pass a proof.
  const grep = judgeCriterion(
    { claim: "c", proof: 'grep: test("W1-T9860 fixture: the widget spins" in test/moved-widget.test.ts' },
    new Set(), undefined, { cwd: repo.dir },
  );
  assert.equal(grep.proof_exec, "executed_pass");
  assert.match(grep.reason, /in test\/folder\/moved-widget\.test\.ts\) — NOTE: resolved test\/moved-widget\.test\.ts/);
  const miss = judgeCriterion({ claim: "c", proof: 'grep: test("not written" in test/moved-widget.test.ts' }, new Set(), undefined, { cwd: repo.dir });
  assert.equal(miss.proof_exec, "executed_fail");

  // Each tree resolves the cited path in its own index: a base that still had the file at the cited path re-runs it there.
  const base = repoWith({ "test/moved-widget.test.ts": 'test("an older widget", () => {});\n' });
  const seen: string[] = [];
  const both = (w: WhitelistedProof, cwd: string) => {
    seen.push(`${cwd === base.dir ? "base" : "head"}:${w.args.at(-1)}`);
    return cwd === base.dir ? ("fail" as const) : ("pass" as const);
  };
  const judged = judgeCriterion({ claim: "c", proof: "unit test: test/moved-widget.test.ts" }, new Set(), undefined, {
    cwd: repo.dir, exec: both, baseCwd: base.dir, baseIsCheckout: true,
  });
  assert.deepEqual(seen, ["head:test/folder/moved-widget.test.ts", "base:test/moved-widget.test.ts"]);
  assert.equal(judged.proof_exec, "executed_pass");
  assert.deepEqual(certainHeadRefusals([{ claim: "c", proof: "unit test: test/moved-widget.test.ts" }], repo.dir), []);
  const checked = checkProofIn(repo.dir, 'grep: test("W1-T9860 fixture: the widget spins" in test/moved-widget.test.ts');
  assert.equal(checked.exit, 0);
  assert.match(checked.out, /resolved: {3}resolved test\/moved-widget\.test\.ts -> test\/folder\/moved-widget\.test\.ts by basename/);
});

test("W1-T9860: the credited-test-path gate accepts a moved test and refuses an absent one", () => {
  const repo = repoWith(MOVED);
  const credited = (testPath: string) =>
    gate.evaluateGate({
      body: "Remudero-Task: W1-T9860",
      authorLogin: "a-human",
      trailerResolves: (id: string) => id === "W1-T9860",
      changedPaths: ["src/lib/test-path-resolver.ts"],
      taskFilesForId: (id: string) => (id === "W1-T9860" ? ["src/lib/test-path-resolver.ts", testPath] : undefined),
      taskAcceptanceForId: (id: string) => (id === "W1-T9860" ? [{ claim: "it shipped", proof: `unit test: ${testPath}` }] : undefined),
      root: repo.dir,
    });
  assert.notEqual(credited("test/moved-widget.test.ts").defect, "credited-test-path", "a moved test is the file that shipped");
  const absent = credited("test/never-written.test.ts");
  assert.equal(absent.ok, false);
  assert.equal(absent.defect, "credited-test-path");
  assert.match(absent.message, /test\/never-written\.test\.ts is absent from the PR head/);
});
