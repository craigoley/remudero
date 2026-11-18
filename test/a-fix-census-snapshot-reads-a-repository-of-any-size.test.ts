/**
 * W1-T13458 — the fix census snapshot sizes its git reads from the repository.
 *
 * On 2026-11-17 the fleet's census blob read passed its fixed 128 MiB bound (134,878,860 bytes of
 * `cat-file --batch` output at origin/main), and every fix round based on main after 07f538e6dd logged
 * `fix.census_snapshot` `unavailable` with ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The file lists (824,101 bytes)
 * run with no bound, so Node's 1 MiB default is next. These tests use the production git runners.
 *
 * @not-a-rule-suite: it tests one writer's git read bounds on fixture repositories and walks no tracked population.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { hostWorktreeGitAsync, type HostWorktreeGitOptions } from "#src/lib/worktree-git.js";
import { writeFixCensusSnapshot, writeFixCensusSnapshotAsync } from "#test/helpers/run-task-test.js";

const OLD_BLOB_BOUND = 128 * 1024 * 1024;
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

type Row = { step: string; extra: Record<string, unknown> };

function recorder() {
  const rows: Row[] = [];
  return { rows, log: (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, extra }); } };
}

function snapshotRows(rows: Row[]) {
  return rows.filter((row) => row.step === "fix.census_snapshot");
}

/** Plumbing with stdin and a large output: the fixture's own `git()` has neither. */
function plumbing(repo: GitRepo, args: string[], input?: string | Buffer): string {
  return execFileSync("git", ["-C", repo.dir, ...args], { input, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
}

/** Index entries that name blobs already in the object store, committed and set as origin/main. No file is on disk. */
function commitIndex(repo: GitRepo, entries: ReadonlyArray<readonly [path: string, oid: string]>) {
  plumbing(repo, ["update-index", "--index-info"], entries.map(([path, oid]) => `100644 ${oid}\t${path}\n`).join(""));
  repo.git("commit", "--quiet", "-m", "fixture: census tree");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
}

function readSnapshot(path: string | undefined) {
  assert.ok(path, "the snapshot is written");
  return JSON.parse(readFileSync(path, "utf8")) as {
    version: number; root: string; headSha: string; mainSha: string; mergeBase: string;
    headPaths: string[]; basePaths: string[]; baseBlobs: Record<string, string>; mainBlobs: Record<string, string>;
  };
}

function sha256(text: string | Buffer) {
  return createHash("sha256").update(text).digest("hex");
}

test("W1-T13458 criterion 1: a blob read past the old 128 MiB bound gives an available snapshot with every blob's bytes", async (t) => {
  const repo = gitRepo({ scope: t, kind: "census-big-blob" });
  const big = Buffer.alloc(68 * 1024 * 1024, "census blob line\n");
  const oid = plumbing(repo, ["hash-object", "-w", "--stdin"], big).trim();
  const names = ["test/big-a.txt", "test/big-b.txt"];
  commitIndex(repo, names.map((path) => [path, oid] as const));
  const batch = plumbing(repo, ["cat-file", "--batch"], names.map((path) => `HEAD:${path}\n`).join(""));
  assert.ok(Buffer.byteLength(batch, "latin1") > OLD_BLOB_BOUND, "control: the blob read is past the old bound");
  const { rows, log } = recorder();
  const snapshot = readSnapshot(await writeFixCensusSnapshotAsync(repo.dir, log));
  assert.deepEqual(snapshotRows(rows).map((row) => row.extra.outcome), ["available"]);
  const expected = sha256(big);
  for (const path of names) {
    assert.equal(snapshot.baseBlobs[path]?.length, big.length, `${path} has its full length`);
    assert.equal(sha256(snapshot.baseBlobs[path]!), expected, `${path} has the blob's exact bytes`);
  }
});

test("W1-T13458 criterion 2: file lists past Node's 1 MiB default give an available snapshot with every census path", async (t) => {
  const repo = gitRepo({ scope: t, kind: "census-long-list" });
  const oid = plumbing(repo, ["hash-object", "-w", "--stdin"], "export {};\n").trim();
  const paths = Array.from({ length: 3000 }, (_, i) => `test/${"d".repeat(200)}/${"f".repeat(190)}-${String(i).padStart(4, "0")}.ts`);
  commitIndex(repo, paths.map((path) => [path, oid] as const));
  assert.ok(Buffer.byteLength(plumbing(repo, ["ls-files"])) > NODE_DEFAULT_MAX_BUFFER, "control: ls-files is past the default");
  assert.ok(Buffer.byteLength(plumbing(repo, ["ls-tree", "-r", "--name-only", "HEAD"])) > NODE_DEFAULT_MAX_BUFFER,
    "control: ls-tree is past the default");
  const sorted = [...paths].sort();
  for (const [name, write] of [["async", writeFixCensusSnapshotAsync], ["sync", writeFixCensusSnapshot]] as const) {
    const { rows, log } = recorder();
    const snapshot = readSnapshot(await write(repo.dir, log));
    assert.deepEqual(snapshotRows(rows).map((row) => row.extra.outcome), ["available"], `${name} writer`);
    assert.deepEqual([...snapshot.headPaths].sort(), sorted, `${name} headPaths`);
    assert.deepEqual([...snapshot.basePaths].sort(), sorted, `${name} basePaths`);
    assert.equal(Object.keys(snapshot.baseBlobs).length, paths.length, `${name} baseBlobs`);
  }
});

const BASE_FILES: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "scripts/unicode.json": '{"text":"café 🐾"}\n',
  "scripts/x-baseline.json": '{"x":1}\n',
  "notes.bin": "not a census input\n",
};

/** main: base, then a baseline change; repair: base, then its own edits. HEAD is repair. */
function censusBranches(repo: GitRepo) {
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo.dir, path, ".."), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
    repo.git("add", "--", ...Object.keys(files));
  };
  write(BASE_FILES);
  repo.git("commit", "--quiet", "-m", "fixture: census base");
  const base = repo.git("rev-parse", "HEAD");
  write({ "scripts/x-baseline.json": '{"x":2}\n', "scripts/y-baseline.json": '{"y":1}\n' });
  repo.git("commit", "--quiet", "-m", "fixture: main moves its baselines");
  const main = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", main);
  repo.git("checkout", "--quiet", "-b", "repair", base);
  write({ "src/a.ts": "export const a = 2;\n", "test/new.test.ts": "export {};\n" });
  repo.git("commit", "--quiet", "-m", "fixture: the branch's own edits");
  return { base, main, head: repo.git("rev-parse", "HEAD") };
}

test("W1-T13458 criterion 3: a small repository's snapshot content is unchanged", async (t) => {
  const repo = gitRepo({ scope: t, kind: "census-small" });
  const { base, main, head } = censusBranches(repo);
  const asyncSnapshot = readSnapshot(await writeFixCensusSnapshotAsync(repo.dir, () => {}));
  const syncSnapshot = readSnapshot(writeFixCensusSnapshot(repo.dir, () => {}));
  const { version, root, headSha, mainSha, mergeBase } = asyncSnapshot;
  assert.deepEqual({ version, root, headSha, mainSha, mergeBase },
    { version: 1, root: resolve(repo.dir), headSha: head, mainSha: main, mergeBase: base });
  assert.deepEqual(asyncSnapshot.headPaths, ["scripts/unicode.json", "scripts/x-baseline.json", "src/a.ts", "test/new.test.ts"]);
  assert.deepEqual(asyncSnapshot.basePaths, ["scripts/unicode.json", "scripts/x-baseline.json", "src/a.ts"]);
  assert.deepEqual(asyncSnapshot.baseBlobs, {
    "scripts/unicode.json": BASE_FILES["scripts/unicode.json"],
    "scripts/x-baseline.json": BASE_FILES["scripts/x-baseline.json"],
    "src/a.ts": BASE_FILES["src/a.ts"],
  });
  assert.deepEqual(asyncSnapshot.mainBlobs, { "scripts/x-baseline.json": '{"x":2}\n', "scripts/y-baseline.json": '{"y":1}\n' });
  assert.deepEqual(syncSnapshot, asyncSnapshot, "the sync and async writers give equal snapshots");
});

test("W1-T13458 criterion 4: a missing ref still logs unavailable with git's own reason", async (t) => {
  const repo = gitRepo({ scope: t, kind: "census-no-main" });
  for (const [name, write] of [["async", writeFixCensusSnapshotAsync], ["sync", writeFixCensusSnapshot]] as const) {
    const { rows, log } = recorder();
    assert.equal(await write(repo.dir, log), undefined, `${name} writer returns no snapshot`);
    const logged = snapshotRows(rows);
    assert.equal(logged.length, 1, `${name} writer logs one row`);
    assert.equal(logged[0]!.extra.outcome, "unavailable");
    assert.match(String(logged[0]!.extra.reason), /origin\/main/);
    assert.match(String(logged[0]!.extra.reason), /unknown revision/);
  }
});

test("W1-T13458 criterion 5: every list and header read passes the list bound, and the blob read passes git's exact size", async (t) => {
  const repo = gitRepo({ scope: t, kind: "census-bounds" });
  censusBranches(repo);
  const calls: { args: string[]; maxBuffer: number | undefined; bytes: number }[] = [];
  const runGit = async (root: string, args: string[], options: HostWorktreeGitOptions = {}) => {
    const output = await hostWorktreeGitAsync(root, args, options);
    calls.push({ args, maxBuffer: options.maxBuffer, bytes: Buffer.byteLength(output, options.encoding ?? "utf8") });
    return output;
  };
  assert.ok(await writeFixCensusSnapshotAsync(repo.dir, () => {}, runGit));
  const lists = calls.filter((call) => call.args[0] === "ls-files" || call.args[0] === "ls-tree");
  const checks = calls.filter((call) => call.args.join(" ") === "cat-file --batch-check");
  const batches = calls.filter((call) => call.args.join(" ") === "cat-file --batch");
  assert.equal(lists.length, 3);
  assert.equal(checks.length, 2);
  assert.equal(batches.length, 2);
  for (const call of [...lists, ...checks]) assert.equal(call.maxBuffer, OLD_BLOB_BOUND, call.args.join(" "));
  for (const call of batches) assert.equal(call.maxBuffer, call.bytes, "the blob read's bound is its exact output size");
});
