import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runStepsAsync, runStepsSync } from "#src/lib/git-push.js";
import {
  decidePlanPrMergeSafety, planSafetyGitAsync, planSafetyGitSync, readPlanMergeSafetySteps,
  type PlanSafetyGit, type PlanSafetyGitResult,
} from "#src/lib/plan-pr-merge-safety.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TARGET = { owner: "fixture", repo: "remudero", prNumber: 7 };

function fixture(t: TestContext, missing = true) {
  const origin = gitRepo({ scope: t, kind: "plan-blob-origin" });
  const put = (id: number) => writeFileSync(join(origin.dir, "plan", "tasks.d", `${id}.yaml`),
    `- id: W1-T${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n`);
  mkdirSync(join(origin.dir, "plan", "tasks.d"), { recursive: true });
  // A valid YAML string can contain a header-shaped line; only batch headers mean missing.
  writeFileSync(join(origin.dir, "plan", "tasks.yaml"),
    `[{id: W1-T9, title: "é\n${"f".repeat(40)} missing\ntext", repo: remudero, type: implement, status: queued, attempts: 0}]\n`);
  put(1);
  put(2);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "base plan");
  origin.git("checkout", "-qb", "pr");
  put(3);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "pr plan");
  const head = origin.git("rev-parse", "HEAD");
  origin.git("checkout", "-q", "main");
  put(4);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "main plan");
  const main = origin.git("rev-parse", "HEAD");
  const clone = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "plan-blob-clone" });
  const ids = [1, 2].map((id) => origin.git("rev-parse", `HEAD:plan/tasks.d/${id}.yaml`));
  if (missing) {
    for (const id of ids) rmSync(join(clone.dir, ".git", "objects", id.slice(0, 2), id.slice(2)));
    const real = planSafetyGitSync(clone.dir);
    for (const id of ids) assert.notEqual((real(["cat-file", "-e", id]) as PlanSafetyGitResult).status, 0);
  }
  const rest = (args: string[]) => String(args[1]).endsWith(`/pulls/${TARGET.prNumber}`)
    ? { base: { ref: "main" }, head: { sha: head } }
    : String(args[1]).includes("compare/main")
      ? { base_commit: { sha: main }, merge_base_commit: { sha: main }, files: [{ filename: "plan/tasks.d/3.yaml" }] }
      : { files: [{ filename: "plan/tasks.d/4.yaml" }] };
  return { clone, ids, rest };
}

function recording(real: PlanSafetyGit, override?: PlanSafetyGit) {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const git: PlanSafetyGit = (args, stdin) => {
    calls.push({ args, stdin });
    return override ? override(args, stdin) : real(args, stdin);
  };
  return { git, calls, fetches: () => calls.filter((c) => c.args[0] === "fetch"),
    batches: () => calls.filter((c) => c.args[0] === "cat-file" && c.args[1] === "--batch") };
}

test("W1-T12158 criterion 1: fetch missing blob ids once and read the merged plan again", (t) => {
  const { clone, ids, rest } = fixture(t);
  const rec = recording(planSafetyGitSync(clone.dir));
  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.deepEqual(reading.mergedTree, { state: "loads" });
  assert.deepEqual(rec.fetches().map((c) => c.args), [["fetch", "--no-tags", "--quiet", "origin", ...ids]]);
  assert.equal(rec.batches().length, 2);
  assert.equal(rec.batches()[0]!.stdin, rec.batches()[1]!.stdin);
  assert.ok(rec.calls.indexOf(rec.batches()[0]!) < rec.calls.indexOf(rec.fetches()[0]!));
  assert.ok(rec.calls.indexOf(rec.fetches()[0]!) < rec.calls.indexOf(rec.batches()[1]!));
  for (const id of ids) assert.equal((planSafetyGitSync(clone.dir)(["cat-file", "-e", id]) as PlanSafetyGitResult).status, 0);
});

test("W1-T12158 criterion 2: a second miss names the clone path and the objects it lacks", (t) => {
  const { clone, ids, rest } = fixture(t);
  const real = planSafetyGitSync(clone.dir);
  const rec = recording(real, (args, stdin) => args[0] === "fetch" ? { status: 0, stdout: "" } : real(args, stdin));
  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.equal(reading.mergedTree?.state, "unreadable");
  if (reading.mergedTree?.state !== "unreadable") assert.fail("missing blobs must refuse the reading");
  assert.ok(reading.mergedTree.error.includes(clone.dir), reading.mergedTree.error);
  for (const id of ids) assert.ok(reading.mergedTree.error.includes(id), reading.mergedTree.error);
  assert.match(reading.mergedTree.error, /clone.*lacks.*object/);
  assert.equal(rec.fetches().length, 1);
  assert.equal(rec.batches().length, 2);
  assert.equal(decidePlanPrMergeSafety({ readings: reading, refreshes: { count: 0, heads: [] } }).action, "refresh");
});

test("W1-T12158 criterion 3: a complete clone reads once without a fetch", (t) => {
  const { clone, rest } = fixture(t, false);
  const rec = recording(planSafetyGitSync(clone.dir));
  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.deepEqual(reading.mergedTree, { state: "loads" });
  assert.equal(rec.fetches().length, 0);
  assert.equal(rec.batches().length, 1);
});

for (const failure of [
  { status: 128, stdout: "", stderr: "fatal: upload-pack: not our ref" },
  { status: null, stdout: "", signal: "SIGTERM", stderr: "fatal: connection closed during blob fetch" },
] satisfies PlanSafetyGitResult[]) {
  test(`W1-T12158 criterion 4: a failed or bounded fetch refuses merge (${failure.status ?? failure.signal})`, (t) => {
    const { clone, rest } = fixture(t);
    const real = planSafetyGitSync(clone.dir);
    const rec = recording(real, (args, stdin) => args[0] === "fetch" ? failure : real(args, stdin));
    const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
    assert.equal(reading.mergedTree?.state, "unreadable");
    if (reading.mergedTree?.state !== "unreadable") assert.fail("a failed fetch must refuse the reading");
    assert.ok(reading.mergedTree.error.includes(failure.stderr), reading.mergedTree.error);
    assert.equal(reading.mergedTree.gitStderr, failure.stderr);
    assert.match(reading.mergedTree.error, /git fetch/);
    if (failure.signal) assert.ok(reading.mergedTree.error.includes(failure.signal));
    assert.equal(rec.fetches().length, 1);
    assert.equal(rec.batches().length, 1);
    for (const count of [0, 3]) {
      assert.notEqual(decidePlanPrMergeSafety({ readings: reading, refreshes: { count, heads: [] } }).action, "merge");
    }
  });
}

test("the async git transport also fetches and reloads missing plan blobs", async (t) => {
  const { clone, ids, rest } = fixture(t);
  const rec = recording(planSafetyGitAsync(clone.dir));
  const reading = await runStepsAsync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.deepEqual(reading.mergedTree, { state: "loads" });
  assert.deepEqual(rec.fetches().map((c) => c.args), [["fetch", "--no-tags", "--quiet", "origin", ...ids]]);
  assert.equal(rec.batches().length, 2);
});

test("a failed second batch read stays unreadable and keeps git's words", (t) => {
  const { clone, rest } = fixture(t);
  const real = planSafetyGitSync(clone.dir);
  let batches = 0;
  const rec = recording(real, (args, stdin) => {
    if (args[0] === "cat-file" && args[1] === "--batch" && ++batches === 2) {
      return { status: 128, stdout: "", stderr: "fatal: cannot read recovered blob" };
    }
    return real(args, stdin);
  });
  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.equal(reading.mergedTree?.state, "unreadable");
  if (reading.mergedTree?.state !== "unreadable") assert.fail("a failed retry must refuse the reading");
  assert.match(reading.mergedTree.error, /git cat-file --batch.*fatal: cannot read recovered blob/);
  assert.equal(rec.fetches().length, 1);
  assert.equal(rec.batches().length, 2);
});

test("a missing-clone-path read stays unreadable and names the objects and git failure", (t) => {
  const { clone, ids, rest } = fixture(t);
  const real = planSafetyGitSync(clone.dir);
  const rec = recording(real, (args, stdin) => args[0] === "fetch" ? { status: 0, stdout: "" }
    : args[0] === "rev-parse" ? { status: 128, stdout: "", stderr: "fatal: work tree unavailable" }
      : real(args, stdin));
  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.equal(reading.mergedTree?.state, "unreadable");
  if (reading.mergedTree?.state !== "unreadable") assert.fail("an unread clone path must refuse the reading");
  for (const id of ids) assert.ok(reading.mergedTree.error.includes(id));
  assert.match(reading.mergedTree.error, /fatal: work tree unavailable/);
});

test("repeated missing blob headers are fetched as one object", () => {
  const tree = "a".repeat(40);
  const blob = "b".repeat(40);
  let batches = 0;
  const rest = (args: string[]) => String(args[1]).endsWith(`/pulls/${TARGET.prNumber}`)
    ? { base: { ref: "main" }, head: { sha: "c".repeat(40) } }
    : { base_commit: { sha: "d".repeat(40) }, merge_base_commit: { sha: "d".repeat(40) }, files: [{ filename: "plan/tasks.d/1.yaml" }] };
  const git: PlanSafetyGit = (args) => {
    if (args[0] === "merge-tree") return { status: 0, stdout: `${tree}\n` };
    if (args[0] === "ls-tree") return { status: 0, stdout: `100644 blob ${blob}\tplan/tasks.yaml\n100644 blob ${blob}\tplan/tasks.d/1.yaml\n` };
    if (args[0] === "cat-file" && args[1] === "--batch") {
      return { status: 0, stdout: ++batches === 1 ? `${blob} missing\n`.repeat(2) : `${blob} blob 3\n[]\n\n`.repeat(2) };
    }
    return { status: 0, stdout: "" };
  };
  const rec = recording(git);
  const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
  assert.deepEqual(reading.mergedTree, { state: "loads" });
  assert.deepEqual(rec.fetches().map((c) => c.args), [["fetch", "--no-tags", "--quiet", "origin", blob]]);
});

for (const raw of [
  "incomplete header",
  `${"a".repeat(40)} ambiguous\n`,
  `${"a".repeat(40)} blob 9999999999999999999999\n`,
]) {
  test(`malformed batch output stays unreadable without fetching (${raw.trim()})`, (t) => {
    const { clone, rest } = fixture(t, false);
    const real = planSafetyGitSync(clone.dir);
    const rec = recording(real, (args, stdin) => args[0] === "cat-file" && args[1] === "--batch"
      ? { status: 0, stdout: raw } : real(args, stdin));
    const reading = runStepsSync(readPlanMergeSafetySteps(TARGET, rest, rec.git));
    assert.equal(reading.mergedTree?.state, "unreadable");
    assert.equal(rec.fetches().length, 0);
    assert.equal(rec.batches().length, 1);
  });
}
