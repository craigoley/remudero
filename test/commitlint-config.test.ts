import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T31: Conventional Commits gate (MASTER-PLAN §6A) ─────────────────────
//
// commitlint.config.mjs must actually BLOCK a malformed commit message, not merely exist. This
// suite drives the real `commitlint` CLI (installed via @commitlint/cli) as a subprocess against
// the project's own config, piping candidate commit messages over stdin -- proving the gate is
// ACTIVE, the same falsifier-fixture shape used by claims-check.test.ts / jscpd-gate.test.ts.
// The CI job (.github/workflows/ci.yml `commitlint`) runs the same binary against the PR's
// TITLE (the squash-merge subject, read live via `gh pr view`); this test proves the config
// itself rejects/accepts the right messages independent of any particular PR's history.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

function lint(message: string, author?: string) {
  const env = { ...process.env };
  delete env.PR_TITLE_AUTHOR;
  if (author !== undefined) env.PR_TITLE_AUTHOR = author;
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8", env },
  );
}

test("commitlint: a message with no type/colon prefix -> non-zero exit (the gate BLOCKS a malformed message)", () => {
  const result = lint("this is not a conventional commit message\n");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /type may not be empty/);
});

test("commitlint: an unrecognized type -> non-zero exit, names the violated rule", () => {
  const result = lint("wibble: made up type\n");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /type-enum/);
});

test("commitlint: a well-formed feat: commit -> zero exit (the gate ACCEPTS)", () => {
  const result = lint("feat: add a new capability\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("commitlint: a well-formed fix: commit with a scope -> zero exit (the gate ACCEPTS)", () => {
  const result = lint("fix(cli): correct the flag parsing\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("commitlint: a breaking-change footer on a feat: commit -> zero exit (recognized, not penalized)", () => {
  const result = lint(
    "feat: change the public API\n\nBREAKING CHANGE: callers must update their imports\n",
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// #11968: Dependabot's one-update group title names the dependency in full and cannot be shortened.
const DEPENDABOT_11968_TITLE =
  "chore(deps): bump google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml from 2.6.0 to 2.7.0 in the actions-minor-and-patch group across 1 directory";

test("commitlint: a Dependabot-authored title skips header-max-length only, and no other author does", () => {
  assert.equal(DEPENDABOT_11968_TITLE.length, 162);
  const dependabot = lint(`${DEPENDABOT_11968_TITLE}\n`, "dependabot[bot]");
  assert.equal(dependabot.status, 0, dependabot.stdout + dependabot.stderr);
  for (const author of [undefined, "craigoley", "remudero-fleet[bot]"]) {
    const other = lint(`${DEPENDABOT_11968_TITLE}\n`, author);
    assert.notEqual(other.status, 0, `author ${author}: ${other.stdout}${other.stderr}`);
    assert.match(other.stdout + other.stderr, /header-max-length/);
  }
  const malformed = lint("bump google/osv-scanner-action from 2.6.0 to 2.7.0\n", "dependabot[bot]");
  assert.notEqual(malformed.status, 0, "every other rule still applies to a Dependabot title");
  assert.match(malformed.stdout + malformed.stderr, /type may not be empty/);
});

test("commitlint: pr-title-lint.yml names the title's author from the event payload, never from the title", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "pr-title-lint.yml"), "utf8");
  assert.match(workflow, /^ {10}PR_TITLE_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}$/m);
});
