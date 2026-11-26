/**
 * W1-T14945: on 2026-11-26 a fix-lane round on core #20963 made src/lib/body-repair.ts import ./review.js, closing an
 * import ring that depcruise's no-circular rule refuses, and hooks/pre-push let it through to CI. The hook now cruises
 * a push whose diff adds an import under src/ and refuses a new ring with `cycle-ratchet:` lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  return pushMany(repo, [{ rev, oldSha, remoteRef: "refs/heads/run-W1-T14945-1" }]);
}

function pushMany(
  repo: GitRepo,
  updates: Array<{ rev: string; oldSha?: string; remoteRef?: string }>,
  gate = repo,
  remote: readonly string[] = [],
): { status: number; stderr: string } {
  const input = updates.map(({ rev, oldSha = "0".repeat(40), remoteRef = `refs/heads/${rev}` }) =>
    `${remoteRef} ${repo.git("rev-parse", rev)} ${remoteRef} ${oldSha}\n`).join("");
  // `remote` is the hook's own argv as Git passes it: the destination remote's name, then its URL.
  const res = spawnSync("sh", [join(gate.dir, "hooks", "pre-push"), ...remote], {
    cwd: repo.dir,
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH ?? "", HOME: repo.dir, TMPDIR: repo.dir, RMD_PREPUSH_GATES: "1" },
  });
  assert.equal(res.error, undefined, `the hook launched: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

function commit(repo: GitRepo, path: string, text: string): void {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
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
  // A push adding no import reports the named skip.
  const quiet = fixture();
  try {
    commit(quiet, "src/lib/c.ts", "export const c = 3;\n");
    const { status, stderr } = push(quiet);
    assert.match(stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped \(a named skip, NOT a pass\)/);
    assert.equal(status, 0, stderr);
  } finally { quiet.cleanup(); }
});

const WORKSPACE_CLIENT = "packages/client/src/client.ts";
const WORKSPACE_RETURN_PATH = "../../../src/lib/c.js";
const WORKSPACE_RETURN = `import { c } from "${WORKSPACE_RETURN_PATH}";\nexport const client = () => c;\n`;

test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring across workspace boundaries", () => {
  const gate = fixture();
  try {
    for (const specifier of ["../../packages/client/src/client.js", "@fixture/client/client"]) {
      const repo = fixture();
      try {
        commit(repo, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
        commit(repo, "packages/client/package.json", JSON.stringify({
          name: "@fixture/client", exports: { "./client": "./src/client.ts" },
        }));
        commit(repo, WORKSPACE_CLIENT, WORKSPACE_RETURN);
        commit(repo, ".dependency-cruiser.cjs", 'throw new Error("worktree config");\n');
        const remoteTip = repo.git("rev-parse", "HEAD");
        commit(repo, "src/lib/c.ts", `import { client } from "${specifier}";\nexport const c = () => client;\n`);
        writeFileSync(join(repo.dir, WORKSPACE_CLIENT), "export const client = 1;\n");
        unlinkSync(join(repo.dir, "node_modules"));
        const worktreeCruiser = join(repo.dir, "node_modules/.bin/depcruise");
        mkdirSync(dirname(worktreeCruiser), { recursive: true });
        writeFileSync(worktreeCruiser, "#!/bin/sh\nexit 2\n");
        chmodSync(worktreeCruiser, 0o755);

        const { status, stderr } = pushMany(repo, [{ rev: "HEAD", oldSha: remoteTip }], gate);
        assert.equal(status, 1, `${specifier} closes a ring in the pushed commits:\n${stderr}`);
        assert.match(stderr, /^cycle-ratchet: packages\/client\/src\/client\.ts -> src\/lib\/c\.ts$/m, stderr);
      } finally { repo.cleanup(); }
    }
  } finally { gate.cleanup(); }
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

test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring despite release archive attributes", () => {
  const repo = fixture();
  try {
    const trackedName = "$Format:%s$";
    commit(repo, ".gitattributes", "src/lib/a.ts export-ignore\nsrc/lib/b.ts export-subst\n");
    commit(repo, `src/lib/${trackedName}.ts`,
      `import { a } from "${sibling("a")}";\nexport const viaA = () => a();\n`);
    const remoteTip = repo.git("rev-parse", "HEAD");
    commit(repo, "src/lib/b.ts",
      `import { viaA } from "${sibling(trackedName)}";\nexport const b = () => viaA();\n`);

    const { status, stderr } = push(repo, "HEAD", remoteTip);
    assert.equal(status, 1, stderr);
    assert.match(stderr, /^cycle-ratchet: src\/lib\/\$Format:%s\$\.ts -> src\/lib\/a\.ts -> src\/lib\/b\.ts$/m, stderr);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: a cycle-free push passes the gate as before", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/c.ts", `import { b } from "${sibling("b")}";\nexport const c = () => b;\n`);
    const withImport = push(repo);
    assert.doesNotMatch(withImport.stderr, /cycle-ratchet: BLOCKED/, withImport.stderr);
    assert.doesNotMatch(withImport.stderr, /cycle-ratchet — .*skipped/, withImport.stderr);
    assert.equal(withImport.status, 0, `a cycle-free import passes:\n${withImport.stderr}`);
    commit(repo, "src/lib/c.ts", `import { b } from "${sibling("b")}";\nexport const c = () => b + 1;\n`);
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD~1");
    const noImport = push(repo);
    assert.doesNotMatch(noImport.stderr, /cycle-ratchet: BLOCKED/, noImport.stderr);
    assert.match(noImport.stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped/);
    assert.equal(noImport.status, 0, `a push adding no import passes:\n${noImport.stderr}`);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: a cycle-free push passes the gate as before when modules in a published ring move", () => {
  const repo = fixture();
  try {
    const existing = `import { b } from "${sibling("b")}";\nexport const a = () => b;\n` +
      "export const description = 'This module and its existing imports move together with their sibling modules.';\n";
    commit(repo, "src/lib/a.ts", existing);
    commit(repo, "src/lib/b.ts", RING_B);
    const remoteTip = repo.git("rev-parse", "HEAD");
    repo.git("mv", "src/lib", "src/relocated modules");
    repo.git("commit", "-qm", "move the directory without changing its files");

    const moved = push(repo, "HEAD", remoteTip);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped/);

    commit(repo, "src/relocated modules/c.ts", CLEAN_C);
    const withAcyclicImport = push(repo, "HEAD", remoteTip);
    assert.equal(withAcyclicImport.status, 0, withAcyclicImport.stderr);
    assert.doesNotMatch(withAcyclicImport.stderr, /cycle-ratchet — .*skipped/);

    const movedA = "src/relocated modules/a.ts";
    commit(repo, movedA, `import { c } from "${sibling("c")}";\n${existing}export const viaC = () => c;\n`);
    assert.match(repo.git("diff", "--name-status", "-M", remoteTip, "HEAD"),
      /^R\d+\tsrc\/lib\/a\.ts\tsrc\/relocated modules\/a\.ts$/m);
    const withClosingImport = push(repo, "HEAD", remoteTip);
    assert.equal(withClosingImport.status, 1, withClosingImport.stderr);
    assert.match(withClosingImport.stderr,
      /^cycle-ratchet: src\/relocated modules\/a\.ts -> src\/relocated modules\/c\.ts -> src\/relocated modules\/b\.ts$/m);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: a cycle-free push passes the gate as before for non-branch refs from a checkout with a ring", () => {
  const repo = fixture();
  try {
    const published = repo.git("rev-parse", "HEAD");
    repo.git("tag", "-a", "release", "-m", "release", published);
    commit(repo, "src/lib/b.ts", RING_B);
    const nonBranches = [
      { rev: "refs/tags/release", remoteRef: "refs/tags/release" },
      { rev: published, remoteRef: "refs/notes/release" },
    ];
    const onlyNonBranches = pushMany(repo, nonBranches);
    assert.equal(onlyNonBranches.status, 0, onlyNonBranches.stderr);
    assert.match(onlyNonBranches.stderr, /cycle-ratchet — no branch updates, skipped \(a named skip, NOT a pass\)/);

    const mixed = pushMany(repo, [...nonBranches, { rev: "HEAD", remoteRef: "refs/heads/ring" }]);
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.match(mixed.stderr, /^cycle-ratchet: src\/lib\/a\.ts -> src\/lib\/b\.ts$/m, mixed.stderr);

    const manual = pushMany(repo, []);
    assert.equal(manual.status, 1, manual.stderr);
    assert.match(manual.stderr, /^cycle-ratchet: src\/lib\/a\.ts -> src\/lib\/b\.ts$/m, manual.stderr);
  } finally { repo.cleanup(); }
});

test("W1-T14945 criterion 2: a cycle-free push passes the gate as before when existing imports resolve differently", () => {
  const repo = fixture();
  try {
    commit(repo, "package.json", JSON.stringify({ imports: { "#client": "./src/lib/b.ts" } }));
    commit(repo, WORKSPACE_CLIENT, WORKSPACE_RETURN);
    const beforeImporter = repo.git("rev-parse", "HEAD");
    commit(repo, "src/lib/c.ts", 'import { client } from "#client";\nexport const c = () => client;\n');
    const remoteTip = repo.git("rev-parse", "HEAD");
    commit(repo, "package.json", JSON.stringify({ imports: { "#client": `./${WORKSPACE_CLIENT}` } }));
    commit(repo, WORKSPACE_CLIENT, `${WORKSPACE_RETURN}export const metadata = 1;\n`);

    const retargeted = push(repo, "HEAD", remoteTip);
    assert.equal(retargeted.status, 0, retargeted.stderr);
    assert.match(retargeted.stderr, /cycle-ratchet — this diff adds no parsed import edge under src\/, skipped/);

    const withNewRingImport = push(repo, "HEAD", beforeImporter);
    assert.equal(withNewRingImport.status, 1, withNewRingImport.stderr);
    assert.match(withNewRingImport.stderr, /^cycle-ratchet: packages\/client\/src\/client\.ts -> src\/lib\/c\.ts$/m);

    commit(repo, "src/lib/e.ts", `import { a } from "${sibling("a")}";\nexport const e = () => a();\n`);
    const withUnrelatedImport = push(repo, "HEAD", remoteTip);
    assert.equal(withUnrelatedImport.status, 0, withUnrelatedImport.stderr);
    assert.doesNotMatch(withUnrelatedImport.stderr, /cycle-ratchet — .*skipped/, withUnrelatedImport.stderr);
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

// The twelfth review of #20986 (F1): a new branch was compared only with origin/main, so in a clone whose remote is named
// upstream the merge base was missing and a committed ring was skipped before depcruise ran.
test("W1-T14945 criterion 1: a push whose diff closes an import ring is refused at pre-push naming the ring, for a new branch on a remote not named origin", () => {
  const repo = fixture();
  try {
    repo.git("update-ref", "refs/remotes/upstream/main", "refs/remotes/origin/main");
    repo.git("update-ref", "-d", "refs/remotes/origin/main");
    commit(repo, "src/lib/b.ts", RING_B);
    const { status, stderr } = pushMany(repo, [{ rev: "HEAD", remoteRef: "refs/heads/run-W1-T14945-1" }], repo,
      ["upstream", "https://github.com/craigoley/remudero.git"]);
    assert.notEqual(status, 0, `the new branch's ring is refused against upstream's default branch:\n${stderr}`);
    assert.match(stderr, /^cycle-ratchet: BLOCKED/m, stderr);
    assert.match(stderr, /src\/lib\/a\.ts -> src\/lib\/b\.ts/, stderr);
  } finally { repo.cleanup(); }
});

// The twelfth review of #20986 (F2): an advertised old tip missing from this clone read as a branch creation, so the merge
// base with main counted a ring already on the remote as this push's. It is a named skip, as the gate was before.
test("W1-T14945 criterion 2: a cycle-free push passes the gate as before, when the remote's old tip is not in this clone", () => {
  const repo = fixture();
  try {
    commit(repo, "src/lib/b.ts", RING_B); // the ring the remote's branch already carries
    commit(repo, "src/lib/c.ts", CLEAN_C);
    const unfetched = "1234567890abcdef1234567890abcdef12345678";
    const { status, stderr } = push(repo, "HEAD", unfetched);
    assert.match(stderr, new RegExp(`cycle-ratchet — the remote's old tip ${unfetched} is unavailable in this clone, skipped`), stderr);
    assert.doesNotMatch(stderr, /cycle-ratchet: BLOCKED/, stderr);
    assert.equal(status, 0, stderr);
  } finally { repo.cleanup(); }
});
