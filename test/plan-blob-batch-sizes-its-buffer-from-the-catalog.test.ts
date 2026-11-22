/**
 * A PLAN BLOB BATCH SIZES ITS OUTPUT BUFFER FROM THE BLOB SIZES GIT LISTS (W1-T13911, rebuild of W1-T13824).
 *
 * Every plan read at a ref prints the whole catalog through one `git cat-file --batch`. The readers bounded that
 * output at a fixed 64 MiB; the catalog measured 35,177,507 bytes on 2026-11-19 and grew 5,071,618 bytes in 14 days.
 * The blob listing readBlobsAtRef already runs now asks for sizes (`ls-tree -l`), so the batch gets the exact byte
 * count git will write. A path the listing does not name keeps the runner's present bound.
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
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "fixture plan");
  return { dir: repo.dir, paths, ids };
}

/** The bytes git itself writes for a `cat-file --batch` of `paths` at HEAD, with no bound in the way. */
function batchBytes(dir: string, paths: string[]): number {
  const input = paths.map((p) => `HEAD:${p}`).join("\n") + "\n";
  return execFileSync("git", ["-C", dir, "cat-file", "--batch"], { input, maxBuffer: 1 << 30 }).length;
}

type Batch = { input: string | undefined; bound: number | undefined };

/** Real git in `dir`, recording each batch's request and the bound it was given. */
function recordingRunners(dir: string, batches: Batch[]): { sync: GitBlobRunner; awaited: ReturnType<typeof defaultGitRunnerAsync> } {
  const asyncRun = defaultGitRunnerAsync(dir);
  return {
    sync: (args, stdin, opts) => {
      if (args[1] === "--batch") batches.push({ input: stdin, bound: opts?.maxBuffer });
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin, maxBuffer: opts?.maxBuffer ?? SIXTY_FOUR_MIB });
    },
    awaited: (args, stdin, opts) => {
      if (args[1] === "--batch") batches.push({ input: stdin, bound: opts?.maxBuffer });
      return asyncRun(args, stdin, opts);
    },
  };
}

test("W1-T13824 criterion 1: shards over 64 MiB load through loadPlanAtRef and loadPlanAtRefAsync with the default runners", async (t) => {
  const piece = "x".repeat(17 * 1024 * 1024);
  const { dir, paths, ids } = planRepo(t, [piece, piece, piece, piece]);
  assert.ok(batchBytes(dir, paths) > SIXTY_FOUR_MIB, "the fixture's batch exceeds the old 64 MiB bound");

  assert.deepEqual(loadPlanAtRef(dir, "plan/tasks.yaml", "HEAD").tasks.map((task) => task.id).sort(), ids);
  const awaited = await loadPlanAtRefAsync(dir, "plan/tasks.yaml", "HEAD");
  assert.deepEqual(awaited.tasks.map((task) => task.id).sort(), ids);
  assert.equal(awaited.tasks.find((task) => task.id === "W9-T1")?.rationale?.length, piece.length + 1);
});

test("W1-T13824 criterion 1: a path the listing does not name as a blob is asked by path and passes no bound", async (t) => {
  const { dir, paths } = planRepo(t, ["first shard", "second shard"]);
  const batches: Batch[] = [];
  const { sync, awaited } = recordingRunners(dir, batches);
  const absent = "plan/tasks.d/absent.yaml";
  const missing = /could not read HEAD:plan\/tasks\.d\/absent\.yaml \(HEAD:plan\/tasks\.d\/absent\.yaml missing\)/;
  assert.throws(() => readBlobsAtRef(sync, "HEAD", [paths[0]!, absent]), missing);
  await assert.rejects(() => readBlobsAtRefAsync(awaited, "HEAD", [paths[0]!, absent]), missing);
  // Paths in two directories are both listed, so that batch gets its exact bound.
  assert.deepEqual(readBlobsAtRef(sync, "HEAD", [paths[0]!, "plan/tasks.yaml"]).at(-1), "[]\n");
  assert.deepEqual(batches.map((batch) => batch.bound), [undefined, undefined, Buffer.byteLength(
    execFileSync("git", ["-C", dir, "cat-file", "--batch"], { input: `HEAD:${paths[0]}\nHEAD:plan/tasks.yaml\n` }))]);
  assert.equal(batches[0]!.input?.split("\n")[1], `HEAD:${absent}`, "only the unlisted path is asked by path");
});

test("W1-T13824 criterion 2: a non-ASCII shard's bound is the exact byte count git writes, by id from any spelling or subdirectory", async (t) => {
  const { dir, paths } = planRepo(t, ["über — ünïcödé ✓ ".repeat(5000), "日本語のテキスト ".repeat(4000), "plain ascii"]);
  const exact = batchBytes(dir, paths);
  const subdir = join(dir, "plan", "tasks.d");
  const batches: Batch[] = [];
  const { sync, awaited } = recordingRunners(subdir, batches);
  const expected = readBlobsAtRef(recordingRunners(dir, []).sync, "HEAD", paths);
  assert.equal(expected[1]!.includes("日本語"), true, "the non-ASCII text survives the framing");
  const prefixed = paths.map((path) => `./${path}`);
  for (const request of [paths, prefixed]) {
    assert.deepEqual(readBlobsAtRef(sync, "HEAD", request), expected);
    assert.deepEqual(await readBlobsAtRefAsync(awaited, "HEAD", request), expected);
  }
  assert.equal(batches.length, 4, "one bounded batch per read");
  for (const { input, bound } of batches) {
    assert.match(input ?? "", /^(?:[0-9a-f]{40,64}\n){3}$/, "both spellings ask for the listed ids, even from a subdirectory");
    assert.equal(bound, exact, "the bound is every byte of git's output and framing");
    assert.ok(bound! >= exact && bound! < 2 * exact, "never short, and no hidden ceiling");
  }
});

test("W1-T13824 criterion 3: a two-argument runner still reads the plan, and the defaults keep 64 MiB without a bound", async (t) => {
  const big = "y".repeat(2 * 1024 * 1024);
  const { dir, paths, ids } = planRepo(t, [big, "small"]);
  const twoArgs = (args: string[], stdin?: string): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin, maxBuffer: SIXTY_FOUR_MIB });
  assert.deepEqual(loadPlanAtRef(dir, "plan/tasks.yaml", "HEAD", twoArgs).tasks.map((task) => task.id).sort(), ids);
  const awaited = await loadPlanAtRefAsync(dir, "plan/tasks.yaml", "HEAD", async (args, stdin) => twoArgs(args, stdin));
  assert.deepEqual(awaited.tasks.map((task) => task.id).sort(), ids);
  // A listing with no size column (the shape before `-l`) still reads by id; the runner keeps its own bound.
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

test("W1-T13824 criterion 3: a runner whose third parameter has a default value still gets the bound", async (t) => {
  const { dir, paths } = planRepo(t, ["first shard", "second shard"]);
  const bounds: Array<number | undefined> = [];
  const defaulted: GitBlobRunner = (args, stdin, opts = {}) => {
    if (args[1] === "--batch") bounds.push(opts.maxBuffer);
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin });
  };
  assert.equal(defaulted.length, 2, "a default parameter value lowers the declared arity");
  readBlobsAtRef(defaulted, "HEAD", paths);
  await readBlobsAtRefAsync(async (args, stdin, opts = {}) => defaulted(args, stdin, opts), "HEAD", paths);
  assert.deepEqual(bounds, [batchBytes(dir, paths), batchBytes(dir, paths)]);
});
