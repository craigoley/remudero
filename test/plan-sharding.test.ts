import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, PlanError, taskRecordPath } from "../src/lib/plan.js";

/**
 * test/plan-sharding.test.ts — W1-T122: PLAN SHARDING (plan/tasks.d/).
 *
 * One task per shard file (plan/tasks.d/<id>.yaml) so two concurrent filings add
 * DIFFERENT files instead of both appending to the single shared EOF of
 * plan/tasks.yaml — the exact collision surface the nine-PR appender train (#271)
 * hit. loadPlan globs plan/tasks.d/*.yaml and merges it with plan/tasks.yaml; every
 * consumer above loadPlan sees one merged view.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function task(id: string, deps: string[] = []): string {
  return `- id: ${id}
  title: ${id} title
  repo: remudero
  depends_on: [${deps.join(", ")}]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
}

test("two branches each adding a DIFFERENT shard merge with zero textual conflict", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-merge-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: GIT_ENV });

  execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repoDir, "plan", "tasks.yaml"), task("BASE"));
  writeFileSync(join(repoDir, "plan", "tasks.d", ".gitkeep"), "");
  git("add", "-A");
  git("commit", "-m", "base plan");

  git("checkout", "-b", "branch-a");
  writeFileSync(join(repoDir, "plan", "tasks.d", "W1-TA.yaml"), task("W1-TA"));
  git("add", "-A");
  git("commit", "-m", "file shard W1-TA");

  git("checkout", "main");
  git("checkout", "-b", "branch-b");
  writeFileSync(join(repoDir, "plan", "tasks.d", "W1-TB.yaml"), task("W1-TB"));
  git("add", "-A");
  git("commit", "-m", "file shard W1-TB");

  git("checkout", "main");
  git("merge", "--no-ff", "branch-a", "-m", "merge branch-a");
  // The real assertion: merging branch-b (filed concurrently, off the SAME base as
  // branch-a) never conflicts, because it added a different file under tasks.d/.
  assert.doesNotThrow(() => git("merge", "--no-ff", "branch-b", "-m", "merge branch-b"));

  const plan = loadPlan(join(repoDir, "plan", "tasks.yaml"));
  assert.deepEqual(
    plan.tasks.map((t) => t.id).sort(),
    ["BASE", "W1-TA", "W1-TB"],
  );
});

test("a duplicate id across two shards fails loadPlan, preserving the single-file uniqueness guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-dup-"));
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.yaml"), task("BASE"));
  writeFileSync(join(dir, "tasks.d", "a.yaml"), task("DUP"));
  writeFileSync(join(dir, "tasks.d", "b.yaml"), task("DUP"));

  assert.throws(() => loadPlan(join(dir, "tasks.yaml")), PlanError);
});

test("a duplicate id between tasks.yaml and a shard also fails loadPlan", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-dup-main-"));
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.yaml"), task("BASE"));
  writeFileSync(join(dir, "tasks.d", "a.yaml"), task("BASE"));

  assert.throws(() => loadPlan(join(dir, "tasks.yaml")), PlanError);
});

test("the existing single-file plan/tasks.yaml still loads unchanged when tasks.d is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-noshard-"));
  writeFileSync(join(dir, "tasks.yaml"), task("A") + task("B", ["A"]));

  const plan = loadPlan(join(dir, "tasks.yaml"));
  assert.deepEqual(
    plan.tasks.map((t) => t.id),
    ["A", "B"],
  );
});

test("a shard can depend on a task declared in the base tasks.yaml (merged-view dependency resolution)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-shard-deps-"));
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.yaml"), task("BASE"));
  writeFileSync(join(dir, "tasks.d", "dep.yaml"), task("DEP", ["BASE"]));

  const plan = loadPlan(join(dir, "tasks.yaml"));
  assert.deepEqual(plan.byId.get("DEP")?.depends_on, ["BASE"]);
});

// ── taskRecordPath: WHICH FILE holds a task's record ─────────────────────────────────────────
// Added for the degraded-recon prompt note, which names this path so a worker that lost recon
// knows where its own specification lives. It must be DERIVED: `plan/tasks.d/<id>-<slug>.yaml` is
// only a convention, the slug is unrecoverable from the id, and 4 tasks still live in the
// monolith — a constructed string would be wrong for both cases and wrong silently.

/** A record with every field `parseTasksFromYaml` requires — the helper reuses the REAL
 *  parser, so a record the loader would reject is correctly reported as not found. */
function taskYaml(id: string): string {
  return [`- id: ${id}`, "  title: t", "  repo: remudero", "  type: implement",
    "  verify: auto", "  risk: low", "  status: queued", ""].join("\n");
}

function planFixture(): { planPath: string; shardDir: string } {
  const root = mkdtempSync(join(tmpdir(), "task-record-path-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, taskYaml("T-IN-MONOLITH"));
  const shardDir = join(root, "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  return { planPath, shardDir };
}

test("taskRecordPath finds a task in the MONOLITH", () => {
  const { planPath } = planFixture();
  assert.equal(taskRecordPath(planPath, "T-IN-MONOLITH"), planPath);
});

test("taskRecordPath finds a task in a SHARD, whatever the file is named", () => {
  // THE FILENAME DELIBERATELY DOES NOT FOLLOW `<id>-<slug>.yaml`. A constructed path would look
  // for `T-IN-SHARD-*.yaml` and miss this entirely; deriving from the parsed record cannot.
  const { planPath, shardDir } = planFixture();
  const oddly = join(shardDir, "zzz-nothing-like-the-id.yaml");
  writeFileSync(oddly, taskYaml("T-IN-SHARD"));
  assert.equal(taskRecordPath(planPath, "T-IN-SHARD"), oddly);
});

test("taskRecordPath returns undefined for an id no plan file holds", () => {
  const { planPath } = planFixture();
  assert.equal(taskRecordPath(planPath, "T-NOWHERE"), undefined);
});

test("taskRecordPath SKIPS an unparseable shard rather than throwing — it may not refuse a run", () => {
  // THE CATCH ARM, driven for real. The only caller renders an advisory prompt line, so a throw
  // here would turn one malformed plan file into a FAILED RUN — strictly worse than the omission
  // this helper exists to fix. The good shard after it must still be found.
  const { planPath, shardDir } = planFixture();
  writeFileSync(join(shardDir, "aaa-broken.yaml"), "{{{ not yaml at all\n");
  const good = join(shardDir, "bbb-good.yaml");
  writeFileSync(good, taskYaml("T-AFTER-BROKEN"));
  assert.equal(taskRecordPath(planPath, "T-AFTER-BROKEN"), good, "a broken sibling must not hide it");
  assert.equal(taskRecordPath(planPath, "T-NOWHERE"), undefined, "and the miss is still a clean undefined");
});

test("taskRecordPath tolerates a missing plan file entirely", () => {
  // An unreadable MONOLITH is the same fail-soft case as an unparseable shard.
  assert.equal(taskRecordPath(join(tmpdir(), "no-such-plan-dir-xyzzy", "tasks.yaml"), "T-ANY"), undefined);
});

// ── A SHARD THAT VANISHES BETWEEN LISTING AND READING ────────────────────────────────────────
// `loadPlan` lists `tasks.d/` and then reads each entry, so anything removing a shard in that
// window used to make the whole load throw. Measured in CI as a FILE-LEVEL crash of whichever
// suite was reading the plan while `test/task-linter-wiring.test.ts` cleaned up its probe shard —
// `node --test` parallelises across files and 39 suites read this directory. It is reachable in
// production too: a filing or a `git checkout` can remove a shard mid-read.

test("a shard listed but gone by the time it is read is SKIPPED, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-race-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
  const shardDir = join(dir, "tasks.d");
  mkdirSync(shardDir, { recursive: true });

  // A DANGLING SYMLINK is the deterministic stand-in for the race: `readdir` lists it, so it
  // reaches the read loop exactly as a real shard would, and `readFileSync` then answers ENOENT
  // exactly as a shard deleted a millisecond earlier does. Deleting a real file before the call
  // would prove nothing — it would never be listed, so the guard would never be reached.
  symlinkSync(join(shardDir, "no-such-target.yaml"), join(shardDir, "zzz-vanished.yaml"));

  const plan = loadPlan(planPath);
  assert.deepEqual(plan.tasks.map((t) => t.id), ["T1"], "the surviving task loads; the vanished shard is simply absent");
});

test("FALSIFIER: an unreadable shard that STILL EXISTS is still fatal — only ENOENT is forgiven", () => {
  // Without this, the guard above could be a blanket `continue` that swallowed real corruption.
  // A DIRECTORY in the slot reads EISDIR, not ENOENT, so it must still throw.
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-eisdir-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
  const shardDir = join(dir, "tasks.d");
  mkdirSync(join(shardDir, "not-a-file.yaml"), { recursive: true });

  assert.throws(() => loadPlan(planPath), PlanError, "a shard that exists but cannot be read must still fail loud");
});
