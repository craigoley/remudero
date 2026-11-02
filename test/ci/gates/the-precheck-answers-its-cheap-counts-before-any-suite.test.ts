import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { main as censusMain } from "#scripts/census-precheck.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Mocked = { mock: { method: (...a: never[]) => { mock: { calls: { arguments: unknown[] }[] } } } };

function quietly(t: Mocked, fn: () => number) {
  const out = t.mock.method(console as never, "log" as never, (() => {}) as never);
  const err = t.mock.method(console as never, "error" as never, (() => {}) as never);
  const status = fn();
  const lines = (m: typeof out) => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  return { status, stdout: lines(out), stderr: lines(err) };
}

/** A census fixture: the real rule-suite selector, one src leaf and one test; the head adds a clock read or not. */
function censusFixture(head: "clock" | "clean") {
  const repo = gitRepo({ kind: "census-counts-first", seedCommit: false });
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, "src/lib/rule-suites.ts"), readFileSync(join(REPO_ROOT, "src/lib/rule-suites.ts")));
  writeFileSync(join(repo.dir, "src/lib/leaf.ts"), "export const leaf = 1;\n");
  writeFileSync(join(repo.dir, "test/leaf.test.ts"), "import { test } from 'node:test';\ntest('leaf', () => {});\n");
  repo.git("add", "."); repo.git("commit", "-q", "-m", "base");
  const base = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "src/lib/leaf.ts"), head === "clock" ? "export const leaf = Date.now();\n" : "export const leaf = 2;\n");
  repo.git("commit", "-q", "-am", "head");
  return { repo, base };
}

const neverStarted = (what: string) => () => { throw new Error(`${what} must not start`); };
const noChildren = { measure: neverStarted("the instrument child"), admitted: neverStarted("the census suite roster"),
  runSuites: neverStarted("a census suite") };

test("W1-T11098 criterion 1: --counts-only answers the static counts and starts no instrument child or census suite", (t) => {
  const refused = censusFixture("clock"); t.after(() => refused.repo.cleanup());
  const bad = quietly(t as never, () => censusMain(["--counts-only", "--root", refused.repo.dir, "--base", refused.base], noChildren as never));
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /clock-signature: src\/lib\/leaf\.ts dateNow 1 > baseline 0/);
  assert.doesNotMatch(bad.stderr, /NOT STARTED/, "counts-only never claims a suite it was not asked for");

  const clean = censusFixture("clean"); t.after(() => clean.repo.cleanup());
  const ok = quietly(t as never, () => censusMain(["--counts-only", "--root", clean.repo.dir, "--base", clean.base], noChildren as never));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /census-precheck: counts OK — 1 changed file\(s\).*census suites not run \(--counts-only\)/);
});

test("W1-T11098 criterion 2: in full mode a branch the counts already refuse exits 1 before any census suite starts", (t) => {
  const refused = censusFixture("clock"); t.after(() => refused.repo.cleanup());
  const full = quietly(t as never, () => censusMain(["--root", refused.repo.dir, "--base", refused.base], noChildren as never));
  assert.equal(full.status, 1, full.stderr);
  assert.match(full.stderr, /this branch grows 1 census count\(s\) CI will refuse/);
  assert.match(full.stderr, /census suites NOT STARTED - the counts above already refuse this branch/);
});
