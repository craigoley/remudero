// W1-T10387: a scope-amendment recovery replays the asking round's edit onto the merged file. On #13324 the recovery
// wrote a whole-file copy saved before #13318 over the amendment merge and silently reverted #13318's hunks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { restoreScopeAmendmentWork, saveScopeAmendmentWork, ScopeRecoveryConflictError } from "#src/lib/proof-amendment.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const path = "src/lib/sweep.ts";
const lines = (...rows: string[]) => rows.map((row) => `${row}\n`).join("");
const original = lines("// header", "export const a = 1;", "", "", "", "export const b = 1;", "// footer");

/** A PR branch holding `path`, a round that edits it and asks for scope, and a main that moves on before the merge. */
function scopeFixture(t: TestContext, extra: Record<string, string> = {}) {
  const repo = gitRepo({ scope: t });
  const root = ownedFixtureDir(t, "scope-recovery-state").dir;
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  writeFileSync(join(repo.dir, path), original);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(repo.dir, name), text);
  repo.git("add", "-A"); repo.git("commit", "-qm", "seed");
  repo.git("checkout", "-qb", "run-W1-T10387-1");
  const input = { root, worktreePath: repo.dir, taskId: "W1-T10387", prNumber: 13324, amendmentNumber: 13330,
    paths: [path, ...Object.keys(extra)] };
  /** Main's commit lands, the round's dirty edit is gone, and the branch merges main as the amendment resume does. */
  const mergeMain = (files: Record<string, string | null>) => {
    repo.git("checkout", "-q", "--", ".");
    repo.git("clean", "-qfd");
    repo.git("checkout", "-q", "main");
    for (const [name, text] of Object.entries(files)) {
      if (text === null) rmSync(join(repo.dir, name)); else writeFileSync(join(repo.dir, name), text);
    }
    repo.git("add", "-A"); repo.git("commit", "-qm", "main moves on");
    repo.git("checkout", "-q", "run-W1-T10387-1");
    repo.git("merge", "-q", "--no-edit", "--no-ff", "main");
    return readFileSync(join(repo.dir, path));
  };
  return { repo, input, mergeMain };
}

test("W1-T10387: a scope recovery keeps main's hunks and replays the round's edit", async (t) => {
  const f = scopeFixture(t);
  writeFileSync(join(f.repo.dir, path), original.replace("export const b = 1;", "export const b = 2; // the round's edit"));
  await saveScopeAmendmentWork(f.input);
  f.mergeMain({ [path]: original.replace("export const a = 1;", "export const a = 1; // PR-13039: main's hold") });
  assert.deepEqual(await restoreScopeAmendmentWork(f.input), [path]);
  assert.equal(readFileSync(join(f.repo.dir, path), "utf8"), lines("// header", "export const a = 1; // PR-13039: main's hold",
    "", "", "", "export const b = 2; // the round's edit", "// footer"));
});

test("W1-T10387: a conflicting scope recovery leaves the merged file untouched", async (t) => {
  const f = scopeFixture(t);
  writeFileSync(join(f.repo.dir, path), original.replace("export const a = 1;", "export const a = 2; // the round's edit"));
  await saveScopeAmendmentWork(f.input);
  const merged = f.mergeMain({ [path]: original.replace("export const a = 1;", "export const a = 3; // main's edit") });
  await assert.rejects(restoreScopeAmendmentWork(f.input), (error) => {
    assert.ok(error instanceof ScopeRecoveryConflictError);
    assert.equal(error.recoveryStatus, "conflicted");
    assert.deepEqual(error.conflictedPaths, [path]);
    assert.match(error.message, /conflicted on src\/lib\/sweep\.ts.*re-apply the round's change/);
    return true;
  });
  assert.deepEqual(readFileSync(join(f.repo.dir, path)), merged);
  assert.equal(f.repo.git("status", "--porcelain"), "");
});

test("W1-T10387: a legacy scope record never overwrites the merged file", async (t) => {
  const f = scopeFixture(t);
  writeFileSync(join(f.repo.dir, path), original.replace("export const b = 1;", "export const b = 2;"));
  const saved = await saveScopeAmendmentWork(f.input);
  const record = JSON.parse(readFileSync(saved, "utf8"));
  const payload = JSON.stringify(JSON.parse(record.payload).map(({ base: _b, baseMode: _m, ...entry }: Record<string, unknown>) => entry));
  writeFileSync(saved, JSON.stringify({ ...record, payload, digest: createHash("sha256").update(payload).digest("hex") }));
  const merged = f.mergeMain({ [path]: original.replace("export const a = 1;", "export const a = 1; // main's hold") });
  await assert.rejects(restoreScopeAmendmentWork(f.input), /no base, so it cannot be replayed; src\/lib\/sweep\.ts left as the merge/);
  assert.deepEqual(readFileSync(join(f.repo.dir, path)), merged);
  assert.equal(f.repo.git("status", "--porcelain"), "");
});

test("scope recovery keeps main's deletions and additions where the round left the path, and replays its mode", async (t) => {
  const f = scopeFixture(t, { "src/kept.ts": "kept\n", "src/added.ts": "round\n", "src/mode.sh": "echo\n" });
  // Saved after the seed, so every extra path has a base; the round edits only sweep.ts's tail and mode.sh's mode.
  writeFileSync(join(f.repo.dir, path), original.replace("// footer", "// round footer"));
  chmodSync(join(f.repo.dir, "src/mode.sh"), 0o755);
  await saveScopeAmendmentWork(f.input);
  f.mergeMain({ "src/kept.ts": null, "src/added.ts": "main\n", "src/mode.sh": "echo main\n" });
  assert.deepEqual(await restoreScopeAmendmentWork(f.input), ["src/added.ts", "src/kept.ts", path, "src/mode.sh"]);
  assert.equal(existsSync(join(f.repo.dir, "src/kept.ts")), false, "main's deletion survives an untouched path");
  assert.equal(readFileSync(join(f.repo.dir, "src/added.ts"), "utf8"), "main\n");
  assert.equal(readFileSync(join(f.repo.dir, "src/mode.sh"), "utf8"), "echo main\n");
  assert.equal(statSync(join(f.repo.dir, "src/mode.sh")).mode & 0o111, 0o111, "the round's mode change is replayed");
  assert.match(readFileSync(join(f.repo.dir, path), "utf8"), /\/\/ round footer\n$/);
});

test("scope recovery reports a round's edit to a path main deleted, and a round's addition main also added", async (t) => {
  const f = scopeFixture(t, { "src/gone.ts": "base\n" });
  const input = { ...f.input, paths: [...f.input.paths, "src/new.ts"] };
  writeFileSync(join(f.repo.dir, "src/gone.ts"), "round\n");
  writeFileSync(join(f.repo.dir, "src/new.ts"), "round's new file\n");
  writeFileSync(join(f.repo.dir, path), original.replace("// header", "// round header"));
  await saveScopeAmendmentWork(input);
  f.mergeMain({ "src/gone.ts": null, "src/new.ts": "main's new file\n" });
  await assert.rejects(restoreScopeAmendmentWork(input), (error) => {
    assert.ok(error instanceof ScopeRecoveryConflictError);
    assert.deepEqual(error.conflictedPaths, ["src/gone.ts", "src/new.ts"]);
    assert.deepEqual(error.replayedPaths, [path]);
    return true;
  });
  assert.equal(existsSync(join(f.repo.dir, "src/gone.ts")), false);
  assert.equal(readFileSync(join(f.repo.dir, "src/new.ts"), "utf8"), "main's new file\n");
  assert.match(readFileSync(join(f.repo.dir, path), "utf8"), /^\/\/ round header\n/, "a clean path still replays");
});

test("scope recovery refuses a non-regular base and propagates a merge that never ran", async (t) => {
  const f = scopeFixture(t);
  writeFileSync(join(f.repo.dir, path), original.replace("export const b = 1;", "export const b = 2;"));
  await saveScopeAmendmentWork(f.input);
  f.mergeMain({ [path]: original.replace("export const a = 1;", "export const a = 9;") });
  const real = { run: (await import("node:child_process")).execFileSync };
  const io = (git: (args: readonly string[]) => string) => ({
    run: (script: string, stdin: string) => String(real.run("python3", ["-I", "-c", script], { input: stdin, encoding: "utf8" })),
    git: (_wt: string, args: readonly string[]) => git(args),
  });
  const spawnFailure = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  await assert.rejects(restoreScopeAmendmentWork(f.input, io((args) => {
    if (args[0] === "merge-file") throw spawnFailure;
    return f.repo.git(...args.map(String)) + (args[0] === "ls-tree" ? "\0" : "");
  })), /spawn git ENOENT/);
  await assert.rejects(saveScopeAmendmentWork({ ...f.input, amendmentNumber: 1 }, io((args) =>
    args[0] === "ls-tree" ? `120000 blob ${"0".repeat(40)}\t${path}\0` : "")), /regular path at HEAD: src\/lib\/sweep\.ts/);
});
