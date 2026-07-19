import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T31: generated CHANGELOG + semver (MASTER-PLAN §6A) ──────────────────
//
// Proves the acceptance claim directly: "running the changelog generator over a history
// containing a feat: commit yields a new minor version section naming that change." Each test
// builds an ISOLATED scratch git repo (never the real remudero history, which would make this
// suite depend on unrelated future commits), seeds one Conventional-Commits-typed commit, then
// drives the real `commit-and-tag-version` CLI (this project's own devDependency, invoked by
// absolute path so it works regardless of the scratch repo's own node_modules) exactly as
// `npm run changelog` would -- proving the feat:/fix:/breaking-change -> minor/patch/major bump
// mapping from the task's `design` field is ACTIVE, not merely configured. Same
// subprocess-against-a-fixture shape as claims-check.test.ts / coverage-ratchet.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "node_modules", ".bin", "commit-and-tag-version");

function makeScratchRepo(startVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), "changelog-gen-test-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result;
  };
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: startVersion }));
  git("add", "-A");
  git("commit", "-q", "-m", "chore: initial commit");
  return dir;
}

function commit(dir: string, file: string, message: string) {
  writeFileSync(join(dir, file), "content\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  const result = spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function runGenerator(dir: string) {
  return spawnSync(CLI, ["--skip.commit", "--skip.tag"], { cwd: dir, encoding: "utf8" });
}

function readVersion(dir: string): string {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

test("changelog generator: a history with a feat: commit -> MINOR bump + a CHANGELOG section naming the change", () => {
  const dir = makeScratchRepo("1.0.0");
  try {
    commit(dir, "a.txt", "feat: add a new capability");
    const result = runGenerator(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readVersion(dir), "1.1.0", "a feat: commit must bump the MINOR version (1.0.0 -> 1.1.0)");

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^## 1\.1\.0 /m);
    assert.match(changelog, /### Features/);
    assert.match(changelog, /add a new capability/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changelog generator: a history with a fix: commit -> PATCH bump + a Bug Fixes section", () => {
  const dir = makeScratchRepo("1.0.0");
  try {
    commit(dir, "a.txt", "fix: correct an off-by-one error");
    const result = runGenerator(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readVersion(dir), "1.0.1", "a fix: commit must bump the PATCH version (1.0.0 -> 1.0.1)");

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^## 1\.0\.1 /m);
    assert.match(changelog, /### Bug Fixes/);
    assert.match(changelog, /correct an off-by-one error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changelog generator: a BREAKING CHANGE footer -> MAJOR bump + a BREAKING CHANGES section", () => {
  const dir = makeScratchRepo("1.0.0");
  try {
    commit(
      dir,
      "a.txt",
      "feat!: change the public API\n\nBREAKING CHANGE: callers must update their imports",
    );
    const result = runGenerator(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readVersion(dir), "2.0.0", "a BREAKING CHANGE commit must bump the MAJOR version (1.0.0 -> 2.0.0)");

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^## 2\.0\.0 /m);
    assert.match(changelog, /BREAKING CHANGES/);
    assert.match(changelog, /callers must update their imports/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changelog generator: a history with only chore: commits -> default PATCH bump, but no Features/Bug Fixes/BREAKING section (nothing user-facing to name)", () => {
  const dir = makeScratchRepo("1.0.0");
  try {
    commit(dir, "a.txt", "chore: tidy up internal comments");
    const result = runGenerator(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readVersion(dir), "1.0.1", "with no feat/fix/breaking signal, the tool falls back to its default PATCH bump");

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^## 1\.0\.1 /m);
    assert.doesNotMatch(changelog, /### Features/);
    assert.doesNotMatch(changelog, /### Bug Fixes/);
    assert.doesNotMatch(changelog, /BREAKING CHANGES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
