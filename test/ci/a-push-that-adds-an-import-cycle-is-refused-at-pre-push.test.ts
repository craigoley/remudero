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

/** Push `rev` (HEAD by default) as a branch; `oldSha` is the remote's tip, all zeros for a new branch. */
function push(repo: GitRepo, rev = "HEAD", oldSha = "0".repeat(40)): { status: number; stderr: string } {
  const head = repo.git("rev-parse", rev);
  const res = spawnSync("sh", [join(repo.dir, "hooks", "pre-push")], {
    cwd: repo.dir,
    encoding: "utf8",
    input: `refs/heads/run-W1-T14945-1 ${head} refs/heads/run-W1-T14945-1 ${oldSha}\n`,
    env: { PATH: process.env.PATH ?? "", HOME: repo.dir, RMD_PREPUSH_GATES: "1" },
  });
  assert.equal(res.error, undefined, `the hook launched: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

function pushMany(repo: GitRepo, updates: Array<{ rev: string; oldSha?: string }>): { status: number; stderr: string } {
  const input = updates.map(({ rev, oldSha = "0".repeat(40) }) =>
    `refs/heads/${rev} ${repo.git("rev-parse", rev)} refs/heads/${rev} ${oldSha}`).join("\n") + "\n";
  const res = spawnSync("sh", [join(repo.dir, "hooks", "pre-push")], {
    cwd: repo.dir,
    encoding: "utf8",
    input,
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
    assert.match(stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped \(a named skip, NOT a pass\)/);
    assert.equal(status, 0, stderr);
  } finally { quiet.cleanup(); }
});

test("W1-T14945 criterion 1: every branch ref in a multi-ref push is checked", () => {
  const repo = fixture();
  try {
    const main = repo.git("rev-parse", "--abbrev-ref", "HEAD");
    repo.git("checkout", "-q", "-b", "clean-ref");
    commit(repo, "src/lib/c.ts", "export const c = 3;\n");
    const clean = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", main);
    repo.git("checkout", "-q", "-b", "ring-ref");
    commit(repo, "src/lib/b.ts", RING_B);
    const result = pushMany(repo, [{ rev: "clean-ref" }, { rev: "ring-ref" }]);
    assert.notEqual(result.status, 0, `the later ring-closing ref is refused:\n${result.stderr}`);
    assert.match(result.stderr, /^cycle-ratchet: src\/lib\/a\.ts -> src\/lib\/b\.ts$/m, result.stderr);
    assert.equal(repo.git("rev-parse", "clean-ref"), clean);
  } finally { repo.cleanup(); }
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

const RING_B = `import { a } from "${sibling("a")}";\nexport const b = 1;\nexport const viaA = () => a;\n`;
const CLEAN_C = `import { b } from "${sibling("b")}";\nexport const c = () => b;\n`;

test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring, when the import spans lines", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/b.ts", `import {\n  a,\n} from\n  "${sibling("a")}";\nexport const b = 1;\nexport const viaA = () => a;\n`);
    const { status, stderr } = push(repo);
    assert.notEqual(status, 0, `a multiline import is still an added import:\n${stderr}`);
    assert.match(stderr, /src\/lib\/a\.ts -> src\/lib\/b\.ts/, stderr);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 1: parsed imports with block comments still close and name an import ring", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/b.ts", `import { a } from /* valid trivia */ "${sibling("a")}";\nexport const b = 1;\nexport const viaA = () => a;\n`);
    const { status, stderr } = push(repo);
    assert.notEqual(status, 0, `a comment between from and the specifier cannot hide the import:\n${stderr}`);
    assert.match(stderr, /^cycle-ratchet: src\/lib\/a\.ts -> src\/lib\/b\.ts$/m, stderr);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring, for the pushed commit and never the checkout", () => {
  // The pushed branch holds the ring while a clean commit is checked out: the pushed commit answers.
  const other = fixture();
  try {
    const main = other.git("rev-parse", "--abbrev-ref", "HEAD");
    other.git("checkout", "-q", "-b", "ring");
    commit(other, "src/lib/b.ts", RING_B);
    other.git("checkout", "-q", main);
    const { status, stderr } = push(other, "ring");
    assert.notEqual(status, 0, `the pushed branch's ring is refused from a clean checkout:\n${stderr}`);
    assert.match(stderr, /src\/lib\/a\.ts -> src\/lib\/b\.ts/, stderr);
  } finally { other.cleanup(); }
  // The working tree is dirty with a ring the pushed commit does not hold: the push passes.
  const dirty = fixture();
  try {
    commit(dirty, "src/lib/c.ts", CLEAN_C);
    writeFileSync(join(dirty.dir, "src", "lib", "b.ts"), RING_B);
    const { status, stderr } = push(dirty);
    assert.doesNotMatch(stderr, /cycle-ratchet: BLOCKED/, `an uncommitted ring never answers for the pushed commit:\n${stderr}`);
    assert.equal(status, 0, stderr);
  } finally { dirty.cleanup(); }
  // The pushed commit holds the ring while the working tree is dirty without it: the push is refused.
  const hidden = fixture();
  try {
    commit(hidden, "src/lib/b.ts", RING_B);
    writeFileSync(join(hidden.dir, "src", "lib", "b.ts"), "export const b = 1;\n");
    const { status, stderr } = push(hidden);
    assert.notEqual(status, 0, `a dirty tree never hides the pushed commit's ring:\n${stderr}`);
  } finally { hidden.cleanup(); }
});

test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring, against the remote's old tip on a branch update", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/c.ts", CLEAN_C);
    const tip = repo.git("rev-parse", "HEAD");
    commit(repo, "src/lib/b.ts", RING_B);
    const { status, stderr } = push(repo, "HEAD", tip);
    assert.notEqual(status, 0, `an update that adds the ring is refused:\n${stderr}`);
    assert.match(stderr, /src\/lib\/a\.ts -> src\/lib\/b\.ts/, stderr);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: a cycle-free push passes the gate as before, and a branch update reads only its own commits", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/c.ts", CLEAN_C);
    const tip = repo.git("rev-parse", "HEAD");
    commit(repo, "src/lib/c.ts", `${CLEAN_C}export const d = 4;\n`);
    const { status, stderr } = push(repo, "HEAD", tip);
    assert.match(stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped/, `the update adds no import past the remote tip:\n${stderr}`);
    assert.equal(status, 0, stderr);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: an acyclic edge on a branch update does not reject a ring already at its remote tip", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/b.ts", RING_B);
    const remoteTip = repo.git("rev-parse", "HEAD");
    commit(repo, "src/lib/c.ts", CLEAN_C);
    const { status, stderr } = push(repo, "HEAD", remoteTip);
    assert.doesNotMatch(stderr, /^cycle-ratchet: .+ -> .+$/m, stderr);
    assert.equal(status, 0, `the ring predates this push and remains unchanged:\n${stderr}`);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: an added edge outside an existing ring does not make that ring new", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/a.ts", `import { c } from "${sibling("c")}";\nimport { b } from "${sibling("b")}";\nexport const a = () => c + b;\n`);
    commit(repo, "src/lib/b.ts", `import { a } from "${sibling("a")}";\nexport const b = () => a();\n`);
    commit(repo, "src/lib/c.ts", `import { b } from "${sibling("b")}";\nexport const c = () => b();\n`);
    const remoteTip = repo.git("rev-parse", "HEAD");
    // Remove the extra a -> b edge while retaining a -> c -> b -> a, and add an unrelated e -> a edge.
    commit(repo, "src/lib/a.ts", `import { c } from "${sibling("c")}";\nexport const a = () => c;\n`);
    commit(repo, "src/lib/e.ts", `import { a } from "${sibling("a")}";\nexport const e = () => a();\n`);
    const { status, stderr } = push(repo, "HEAD", remoteTip);
    assert.doesNotMatch(stderr, /^cycle-ratchet: .+ -> .+$/m, stderr);
    assert.equal(status, 0, `an unrelated acyclic edge does not reclassify an existing ring:\n${stderr}`);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: an import quoted inside a comment is a named no-import skip even with a pre-existing ring", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/b.ts", RING_B);
    const remoteTip = repo.git("rev-parse", "HEAD");
    commit(repo, "src/lib/c.ts", `// import { a } from "${sibling("a")}";\nexport const c = 3;\n`);
    const { status, stderr } = push(repo, "HEAD", remoteTip);
    assert.match(stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped \(a named skip, NOT a pass\)/, stderr);
    assert.doesNotMatch(stderr, /^cycle-ratchet: .+ -> .+$/m, stderr);
    assert.equal(status, 0, stderr);
  } finally { repo.cleanup(); }
});
