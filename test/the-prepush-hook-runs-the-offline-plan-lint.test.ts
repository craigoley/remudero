import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const BEGIN = "# BEGIN offline plan lint admission";
const END = "# END offline plan lint admission";

function fixture(t: TestContext, npmExit: number, withScript = true): { root: string; bin: string; calls: string } {
  const container = mkdtempSync(join(tmpdir(), "rmd-prepush-offline-lint-"));
  const root = join(container, "repo");
  const bin = join(container, "fake-bin");
  const calls = join(container, "npm-calls.txt");
  t.after(() => rmSync(container, { recursive: true, force: true }));
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: withScript ? { "lint-plan:offline": "offline fixture" } : {} }),
  );
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit ${npmExit}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return { root, bin, calls };
}

function runHook(root: string, bin: string) {
  return spawnSync("/bin/sh", [HOOK], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RMD_PREPUSH_GATES: "1" },
  });
}

function runHookSource(root: string, bin: string, source: string) {
  return spawnSync("/bin/sh", ["-s"], {
    cwd: root,
    encoding: "utf8",
    input: source,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RMD_PREPUSH_GATES: "1" },
  });
}

test("the hook passes origin/main to the offline plan lint and refuses only its violation exit", (t) => {
  const f = fixture(t, 1);
  const result = runHook(f.root, f.bin);

  assert.equal(result.status, 1, "an offline lint violation must stop the push");
  assert.match(result.stderr, /pre-push REFUSED/);
  assert.equal(
    readFileSync(f.calls, "utf8").trim(),
    "run --silent lint-plan:offline -- --base origin/main",
    "the hook must use the dedicated offline runner against the same base as CI",
  );
});

test("MUTANT: removing only the offline lint admission lets the same violation through", (t) => {
  const f = fixture(t, 1);
  const hook = readFileSync(HOOK, "utf8");
  const start = hook.indexOf(BEGIN);
  const finish = hook.indexOf(END);
  assert.ok(start >= 0 && finish > start, "the admission must have stable mutation anchors");
  const mutant = `${hook.slice(0, start)}${hook.slice(finish + END.length)}`;

  const result = runHookSource(f.root, f.bin, mutant);

  assert.equal(result.status, 0, "without this arm, no surviving hook check sees the plan violation");
  assert.doesNotMatch(result.stderr, /pre-push REFUSED/);
});

test("an unreadable offline lint is named but does not masquerade as a plan violation", (t) => {
  const f = fixture(t, 2);
  const result = runHook(f.root, f.bin);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /lint-plan:offline could not read its inputs — skipped, NOT passed/);
  assert.doesNotMatch(result.stderr, /pre-push REFUSED/);
});

test("a runner failure is named but does not masquerade as a plan violation", (t) => {
  const f = fixture(t, 127);
  const result = runHook(f.root, f.bin);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /lint-plan:offline could not execute \(exit 127\) — skipped, NOT passed/);
});

test("a tree without the package script skips it by name and invokes nothing", (t) => {
  const f = fixture(t, 1, false);
  const result = runHook(f.root, f.bin);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /package script lint-plan:offline unavailable — skipped, NOT passed/);
  assert.throws(() => readFileSync(f.calls, "utf8"), /ENOENT/, "npm must not run when the script is absent");
});

test("a successful offline lint leaves the tracked tree byte-for-byte unchanged", (t) => {
  const f = fixture(t, 0);
  execFileSync("git", ["init", "--quiet"], { cwd: f.root });
  execFileSync("git", ["config", "user.name", "pre-push fixture"], { cwd: f.root });
  execFileSync("git", ["config", "user.email", "fixture@remudero.invalid"], { cwd: f.root });
  execFileSync("git", ["add", "package.json"], { cwd: f.root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: f.root });
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" });

  const result = runHook(f.root, f.bin);
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.equal(after, before, "the hook must not mutate any tracked or untracked path in the worktree");
});

test("the offline lint arm follows tier admission and carries no network or test-runner command", () => {
  const hook = readFileSync(HOOK, "utf8");
  const tier = hook.indexOf("scripts/test-tier-manifest.mjs");
  const lint = hook.indexOf("npm run --silent lint-plan:offline");

  assert.ok(tier >= 0 && lint > tier, "lint-plan:offline must run after tier admission");
  assert.doesNotMatch(hook.slice(tier, lint), /\bgh\b|node\s+--test/);
});
