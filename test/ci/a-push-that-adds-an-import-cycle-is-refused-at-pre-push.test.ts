/**
 * W1-T14945: on 2026-11-26 a fix-lane round on core #20963 made src/lib/body-repair.ts import ./review.js, closing an
 * import ring that depcruise's no-circular rule refuses, and hooks/pre-push let it through to CI. The hook now cruises
 * a push whose diff adds an import under src/ and refuses a new ring with `cycle-ratchet:` lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A fixture module's sibling specifier, built so this file's own source names no location-relative import. */
const sibling = (name: string): string => `.${"/"}${name}.js`;

/** A tree that is its own gate root (W1-T6120): the hook, the real cruise config and ratchet, and a two-module src/. */
function fixture(): GitRepo {
  const repo = gitRepo({ kind: "w1-t14945" });
  const dir = repo.dir;
  for (const path of ["hooks/pre-push", ".dependency-cruiser.cjs", "scripts/cycle-ratchet.mjs", "scripts/cycle-baseline.json"]) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), join(dir, path));
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext" } }));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  writeFileSync(join(dir, "src", "lib", "a.ts"), `import { b } from "${sibling("b")}";\nexport const a = () => b;\n`);
  writeFileSync(join(dir, "src", "lib", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "src", "lib", "c.ts"), "export const c = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function push(repo: GitRepo): { status: number; stderr: string } {
  const head = repo.git("rev-parse", "HEAD");
  const res = spawnSync("sh", [join(repo.dir, "hooks", "pre-push")], {
    cwd: repo.dir,
    encoding: "utf8",
    input: `refs/heads/run-W1-T14945-1 ${head} refs/heads/run-W1-T14945-1 ${"0".repeat(40)}\n`,
    env: { PATH: process.env.PATH ?? "", HOME: repo.dir, RMD_PREPUSH_GATES: "1" },
  });
  assert.equal(res.error, undefined, `the hook launched: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

function commit(repo: GitRepo, path: string, text: string): void {
  writeFileSync(join(repo.dir, path), text);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `edit ${path}`);
}

test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/b.ts", `import { a } from "${sibling("a")}";\nexport const b = 1;\nexport const viaA = () => a;\n`);
    const { status, stderr } = push(repo);
    assert.notEqual(status, 0, `the push is refused:\n${stderr}`);
    assert.match(stderr, /^cycle-ratchet: BLOCKED/m, "the refusal is a cycle-ratchet line, so the fix lane's strike names it");
    assert.match(stderr, /src\/lib\/a\.ts -> src\/lib\/b\.ts/, "the ring is named");
  } finally { repo.cleanup(); }
  // A push adding no import is a named skip, never cruised.
  const quiet = fixture();
  try {
    commit(quiet, "src/lib/c.ts", "export const c = 3;\n");
    const { status, stderr } = push(quiet);
    assert.match(stderr, /cycle-ratchet — this diff adds no import under src\/, skipped \(a named skip, NOT a pass\)/);
    assert.equal(status, 0, stderr);
  } finally { quiet.cleanup(); }
});

test("W1-T14945 criterion 2: a cycle-free push passes the gate as before", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/c.ts", `import { b } from "${sibling("b")}";\nexport const c = () => b;\n`);
    const withImport = push(repo);
    assert.doesNotMatch(withImport.stderr, /cycle-ratchet: BLOCKED/, withImport.stderr);
    assert.equal(withImport.status, 0, `a cycle-free import passes:\n${withImport.stderr}`);
    commit(repo, "src/lib/c.ts", `import { b } from "${sibling("b")}";\nexport const c = () => b + 1;\n`);
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD~1");
    const noImport = push(repo);
    assert.doesNotMatch(noImport.stderr, /cycle-ratchet: BLOCKED/, noImport.stderr);
    assert.equal(noImport.status, 0, `a push adding no import passes:\n${noImport.stderr}`);
  } finally { repo.cleanup(); }
});
