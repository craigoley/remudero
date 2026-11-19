/**
 * A PLAN BLOB BATCH SIZES ITS OUTPUT BUFFER FROM THE BLOB SIZES GIT LISTS (W1-T13824).
 *
 * Every plan read at a ref prints the whole catalog through one `git cat-file --batch`. The readers bounded that output
 * at a fixed 64 MiB; the catalog measured 35,177,507 bytes on 2026-11-19 and grew 5,071,618 bytes in 14 days. The blob
 * listing readBlobsAtRef already runs now asks for sizes (`ls-tree -l`), so the batch gets the exact byte count git
 * will write. These tests use real git repositories and the real default runners: a fake runner never overflows.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  defaultGitRunnerAsync,
  loadPlanAtRef,
  loadPlanAtRefAsync,
  readBlobsAtRef,
  readBlobsAtRefAsync,
  type GitBlobRunner,
} from "#src/lib/plan.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SIXTY_FOUR_MIB = 1 << 26;

function shard(id: string, rationale: string): string {
  return `- id: ${id}\n  title: "fixture ${id} — sized"\n  repo: remudero\n  depends_on: []\n  type: implement\n` +
    `  verify: auto\n  risk: low\n  status: queued\n  rationale: |\n    ${rationale}\n  acceptance:\n` +
    `    - claim: fixture\n      proof: "grep: fixture in README.md"\n`;
}

/** A committed plan: an empty monolith and one shard per entry of `rationales`. */
function planRepo(t: TestContext, rationales: string[]): { dir: string; paths: string[]; ids: string[] } {
  const repo = gitRepo({ scope: t, kind: "plan-blob-bound" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  const ids = rationales.map((_, i) => `W9-T${i + 1}`);
  const paths = ids.map((id) => `plan/tasks.d/${id}-fixture.yaml`);
  rationales.forEach((rationale, i) => writeFileSync(join(repo.dir, paths[i]!), shard(ids[i]!, rationale)));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "café.txt"), "café — fallback\n".repeat(600));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "fixture plan");
  return { dir: repo.dir, paths, ids };
}

/** The bytes git itself writes for a `cat-file --batch` of `paths` at HEAD, read as a Buffer with no bound in the way. */
function batchBytes(dir: string, paths: string[]): number {
  const input = paths.map((p) => `HEAD:${p}`).join("\n") + "\n";
  return execFileSync("git", ["-C", dir, "cat-file", "--batch"], { input, maxBuffer: 1 << 30 }).length;
}

test("W1-T13824 criterion 1: shards over 64 MiB load through loadPlanAtRef and loadPlanAtRefAsync with the default runners", async (t) => {
  const piece = "x".repeat(17 * 1024 * 1024);
  const { dir, paths, ids } = planRepo(t, [piece, piece, piece, piece]);
  // FIXTURE FIRST: the batch must really pass the old fixed bound, or the test proves nothing.
  assert.ok(batchBytes(dir, paths) > SIXTY_FOUR_MIB, "the fixture's batch exceeds 64 MiB");

  const sync = loadPlanAtRef(dir, "plan/tasks.yaml", "HEAD");
  assert.deepEqual(sync.tasks.map((task) => task.id).sort(), ids);
  const awaited = await loadPlanAtRefAsync(dir, "plan/tasks.yaml", "HEAD");
  assert.deepEqual(awaited.tasks.map((task) => task.id).sort(), ids);
  assert.equal(awaited.tasks.find((task) => task.id === "W9-T1")?.rationale?.length, piece.length + 1);
});

test("W1-T13824 criterion 2: canonical and ./-prefixed UTF-8 shards have the same exact batch bound", async (t) => {
  const { dir, paths } = planRepo(t, ["über — ünïcödé ✓ ".repeat(5000), "日本語のテキスト ".repeat(4000), "plain ascii"]);
  const exact = batchBytes(dir, paths);
  const batches: Array<{ input: string | undefined; bound: number | undefined }> = [];
  const asyncRun = defaultGitRunnerAsync(dir);
  const awaited: typeof asyncRun = (args, stdin, opts) => {
    if (args[1] === "--batch") batches.push({ input: stdin, bound: opts?.maxBuffer });
    return asyncRun(args, stdin, opts);
  };
  const syncRun: GitBlobRunner = (args, stdin, opts) => {
    if (args[1] === "--batch") batches.push({ input: stdin, bound: opts?.maxBuffer });
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin, maxBuffer: opts?.maxBuffer });
  };
  const expected = readBlobsAtRef(syncRun, "HEAD", paths);
  assert.equal(expected[1]!.includes("日本語"), true, "the non-ASCII text survives the framing");
  const prefixed = paths.map(path => `./${path}`);
  assert.equal(batchBytes(dir, prefixed), exact, "Git resolves both spellings to the same blobs");
  for (const request of [paths, prefixed]) {
    assert.deepEqual(await readBlobsAtRefAsync(awaited, "HEAD", request), expected);
  }
  assert.deepEqual(readBlobsAtRef(syncRun, "HEAD", prefixed), expected);
  assert.equal(batches.length, 4, "one bounded batch per read");
  for (const { input, bound } of batches) {
    assert.match(input ?? "", /^(?:[0-9a-f]{40,64}\n){3}$/, "both spellings ask for the listed ids");
    assert.equal(bound, exact, "bound includes every byte of Git's UTF-8 output and framing");
  }
});

test("a quoted listing path can resolve to a blob and a missing UTF-8 path retains Git's error", async (t) => {
  const { dir, paths } = planRepo(t, ["first shard"]);
  const quoted = "plan/tasks.d/café.txt";
  const missing = "plan/tasks.d/absent-é.yaml";
  const request = [quoted, paths[0]!, quoted, missing];
  const exact = batchBytes(dir, request);
  const asyncRun = defaultGitRunnerAsync(dir);
  const bounds: Array<number | undefined> = [];
  const quotePaths = ["-c", "core.quotePath=true"];
  const missingError = /could not read HEAD:plan\/tasks\.d\/absent-é\.yaml \(HEAD:plan\/tasks\.d\/absent-é\.yaml missing\)/;
  assert.throws(() => readBlobsAtRef((args, stdin, opts) => {
    if (args[1] === "--batch") bounds.push(opts?.maxBuffer);
    return execFileSync("git", ["-C", dir, ...quotePaths, ...args], { encoding: "utf8", input: stdin, maxBuffer: opts?.maxBuffer });
  }, "HEAD", request), missingError);
  await assert.rejects(() => readBlobsAtRefAsync((args, stdin, opts) => {
    if (args[1] === "--batch") bounds.push(opts?.maxBuffer);
    return asyncRun([...quotePaths, ...args], stdin, opts);
  }, "HEAD", request), missingError);
  assert.deepEqual(bounds, [exact, exact], "resolved and missing fallback output is counted in request order");
});

test("W1-T13824 criterion 3: a two-argument runner still reads the plan, and the defaults keep 64 MiB without a bound", async (t) => {
  const big = "y".repeat(2 * 1024 * 1024);
  const { dir, paths, ids } = planRepo(t, [big, "small"]);
  const twoArgs = (args: string[], stdin?: string): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin, maxBuffer: SIXTY_FOUR_MIB });
  assert.deepEqual(loadPlanAtRef(dir, "plan/tasks.yaml", "HEAD", twoArgs).tasks.map((task) => task.id).sort(), ids);
  const awaited = await loadPlanAtRefAsync(dir, "plan/tasks.yaml", "HEAD", async (args, stdin) => twoArgs(args, stdin));
  assert.deepEqual(awaited.tasks.map((task) => task.id).sort(), ids);
  // A fake whose listing has no size column (the shape before `-l`) still reads; the runner keeps its own bound.
  const bounds: Array<number | undefined> = [];
  const noSizes: GitBlobRunner = (args, stdin, opts) => {
    if (args[0] === "cat-file") bounds.push(opts?.maxBuffer);
    return twoArgs(args.filter((arg) => arg !== "-l"), stdin);
  };
  assert.equal(readBlobsAtRef(noSizes, "HEAD", paths)[0]!.length, shard(ids[0]!, big).length);
  assert.deepEqual(bounds, [undefined]);
  // Without a bound the default async runner keeps 64 MiB: a 2 MiB blob passes Node's 1 MiB default.
  const blob = execFileSync("git", ["-C", dir, "rev-parse", `HEAD:${paths[0]}`], { encoding: "utf8" }).trim();
  assert.equal((await defaultGitRunnerAsync(dir)(["cat-file", "blob", blob])).length, shard(ids[0]!, big).length);
});
