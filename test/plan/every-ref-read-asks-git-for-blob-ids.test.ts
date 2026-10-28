/**
 * EVERY PLAN READ AT A REF ASKS GIT FOR BLOB IDS, NOT `<ref>:<path>`.
 *
 * #15230 fixed this for the direct-merge preflight only. readBlobsAtRef and readBlobsAtRefAsync, which the daemon's
 * plan sync, the console's plan reload and the review's base reads share, still asked `git cat-file --batch` for
 * each shard as `<ref>:plan/tasks.d/<name>`. git resolves each such line through tasks.d's tree, which held 4,577
 * entries on 2026-10-28: about 2 ms a shard, 9.9 s for the plan, where the same blobs asked by id take 0.36 s. Both
 * reads now list the paths' directories once and ask for the ids.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { readBlobsAtRef, readBlobsAtRefAsync } from "#src/lib/plan.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SHARDS = 300;

function shardText(i: number): string {
  // a multi-byte character in every shard, so a by-id read that mis-framed bytes would corrupt the shards after it.
  return `- id: W9-T${i}\n  title: shard ${i} — read by id\n`;
}

function fixture(t: TestContext): { dir: string; paths: string[] } {
  const repo = gitRepo({ kind: "blob-id-ref-read" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "README.md"), "not a shard\n");
  const paths: string[] = [];
  for (let i = 0; i < SHARDS; i++) {
    const rel = `plan/tasks.d/W9-T${i}.yaml`;
    writeFileSync(join(repo.dir, rel), shardText(i));
    paths.push(rel);
  }
  repo.git("add", "-A");
  repo.git("commit", "-qm", "plan");
  return { dir: repo.dir, paths };
}

/** A real git runner that keeps every `cat-file --batch` request it was handed. */
function recording(dir: string) {
  const batches: string[] = [];
  const run = (args: string[], stdin?: string): string => {
    if (args[0] === "cat-file" && args[1] === "--batch") batches.push(stdin ?? "");
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin, maxBuffer: 1 << 26 });
  };
  return { batches, run };
}

test("readBlobsAtRef asks the batch for blob ids only and returns every shard's bytes in order", (t) => {
  const { dir, paths } = fixture(t);
  const { batches, run } = recording(dir);

  const texts = readBlobsAtRef(run, "HEAD", [...paths, "plan/tasks.yaml"]);

  assert.deepEqual(texts, [...paths.map((_, i) => shardText(i)), "[]\n"]);
  assert.equal(batches.length, 1, "one batch for the whole read");
  const lines = batches[0]!.split("\n").filter(Boolean);
  assert.equal(lines.length, SHARDS + 1);
  for (const line of lines) assert.match(line, /^[0-9a-f]{40,64}$/, `asked by id, never by <ref>:<path>: ${line}`);
});

test("readBlobsAtRefAsync asks the batch for blob ids only, and a path the tree lacks is still git's own `missing`", async (t) => {
  const { dir, paths } = fixture(t);
  const { batches, run } = recording(dir);

  const texts = await readBlobsAtRefAsync(async (args, stdin) => run(args, stdin), "HEAD", paths.slice(0, 3));
  assert.deepEqual(texts, [shardText(0), shardText(1), shardText(2)]);
  for (const line of batches[0]!.split("\n").filter(Boolean)) assert.match(line, /^[0-9a-f]{40,64}$/);

  await assert.rejects(
    () => readBlobsAtRefAsync(async (args, stdin) => run(args, stdin), "HEAD", [paths[0]!, "plan/tasks.d/absent.yaml"]),
    /could not read HEAD:plan\/tasks\.d\/absent\.yaml \(HEAD:plan\/tasks\.d\/absent\.yaml missing\)/,
  );
  assert.match(batches[1]!.split("\n")[1]!, /^HEAD:plan\/tasks\.d\/absent\.yaml$/, "only the unlisted path is asked by path");
});
