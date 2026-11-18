/**
 * W1-T13609 — A MERGE-SAFETY READ PARSES ONLY THE PLAN SHARDS THAT CHANGED.
 *
 * mergedPlanState parsed every blob of the merged tree as YAML on each plan PR's read, though two plan PRs
 * share almost all of tasks.d. It now passes one PlanBlobCache, so a shard whose path and content are
 * unchanged is reused, and duplicates and dependencies are still checked on every merge.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { runStepsSync } from "#src/lib/git-push.js";
import { mergePlanBlobsQuarantiningDuplicates } from "#src/lib/plan.js";
import { MERGED_PLAN_BLOB_CACHE, readPlanMergeSafetySteps, type MergedTreePlan, type PlanSafetyGit } from "#src/lib/plan-pr-merge-safety.js";

const TARGET = { owner: "craigoley", repo: "remudero", prNumber: 7 };
const PLAN = { monolith: "plan/tasks.yaml", planDir: "plan" };
const MAIN = "a".repeat(40);

function shard(id: string, extra = ""): string {
  return `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n${extra}`;
}

const sha1 = (text: string): string => createHash("sha1").update(text, "utf8").digest("hex");

/** An in-memory clone: the merged tree is `files`; `fail` makes that git verb exit 128. */
function fakeGit(files: Map<string, string>, fail?: string): PlanSafetyGit {
  const blobs = new Map([...files.values()].map((text) => [sha1(text), text]));
  const tree = sha1([...files].map(([p, t]) => `${p}\0${t}`).join("\n"));
  return (args, stdin) => {
    if (fail && args[0] === fail) return { status: 128, stdout: "", stderr: `fatal: ${fail} failed` };
    if (args[0] === "cat-file" && args[1] === "-e") return { status: 0, stdout: "" };
    if (args[0] === "merge-tree") return { status: 0, stdout: `${tree}\n` };
    if (args[0] === "ls-tree") {
      return { status: 0, stdout: [...files.keys()].map((p) => `100644 blob ${sha1(files.get(p)!)}\t${p}`).join("\n") + "\n" };
    }
    if (args[0] === "cat-file" && args[1] === "--batch") {
      const out = String(stdin).split("\n").filter(Boolean).map((id) => {
        const text = blobs.get(id);
        return text === undefined ? `${id} missing\n` : `${id} blob ${Buffer.byteLength(text, "utf8")}\n${text}\n`;
      });
      return { status: 0, stdout: out.join("") };
    }
    return { status: 128, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
  };
}

function restFor(head: string) {
  return (a: string[]) =>
    String(a[1]).endsWith(`/pulls/${TARGET.prNumber}`) ? { base: { ref: "main" }, head: { sha: head } }
      : String(a[1]).includes("compare/main") ? { base_commit: { sha: MAIN }, merge_base_commit: { sha: MAIN }, files: [{ filename: "plan/tasks.d/W1-T1.yaml" }] }
      : { files: [] };
}

let reads = 0;
/** One cached merge-safety read; each read names a new head ref. */
function read(files: Map<string, string>, fail?: string): MergedTreePlan | undefined {
  reads++;
  const head = sha1(`head-${reads}`);
  return runStepsSync(readPlanMergeSafetySteps(TARGET, restFor(head), fakeGit(files, fail), PLAN)).mergedTree;
}

/** The same merged tree's state through an uncached merge, as mergedPlanState mapped it before. */
function uncached(files: Map<string, string>): MergedTreePlan {
  const paths = [PLAN.monolith, ...[...files.keys()].filter((p) => p.startsWith("plan/tasks.d/") && p.endsWith(".yaml")).sort()];
  try {
    const { quarantined } = mergePlanBlobsQuarantiningDuplicates(paths.map((p) => ({ label: `merged:${p}`, text: files.get(p)! })));
    return quarantined.length === 0 ? { state: "loads" } : { state: "quarantined", ids: quarantined.map((q) => q.id) };
  } catch (e) {
    return { state: "refused", detail: String((e as Error)?.message ?? e).split("\n")[0] };
  }
}

function tree(count: number, monolith = "[]\n"): Map<string, string> {
  const files = new Map<string, string>([[PLAN.monolith, monolith]]);
  for (let i = 1; i <= count; i++) files.set(`plan/tasks.d/W1-T${i}.yaml`, shard(`W1-T${i}`));
  return files;
}

test("W1-T13609 criterion 1: two merge-safety reads over 200 shards that differ in one shard parse 200 shards, then 1", () => {
  // MERGED_PLAN_BLOB_CACHE is process-wide, and the pure-test pool runs many files in one process: an earlier
  // file's read can leave the identical "[]\n" monolith cached, which this read would then REUSE (200 parsed, not 201).
  // The criterion is about a cold first read, so start cold.
  MERGED_PLAN_BLOB_CACHE.entries.clear();
  // The counts include the monolith, blobs[0], which the cache keeps like a shard.
  const first = tree(200);
  assert.deepEqual(read(first), { state: "loads" });
  assert.equal(MERGED_PLAN_BLOB_CACHE.parsedBlobs, 1 + 200, "the monolith and all 200 shards are parsed on the first read");
  assert.equal(MERGED_PLAN_BLOB_CACHE.reusedBlobs, 0);

  const second = new Map(first);
  second.set("plan/tasks.d/W1-T17.yaml", shard("W1-T17", "  priority: 2\n"));
  assert.deepEqual(read(second), { state: "loads" });
  assert.equal(MERGED_PLAN_BLOB_CACHE.parsedBlobs, 1, "only the changed shard is parsed again");
  assert.equal(MERGED_PLAN_BLOB_CACHE.reusedBlobs, 199 + 1, "the 199 unchanged shards and the monolith are reused");
});

test("W1-T13609 criterion 2: the cached read gives the uncached merge's state for loads, duplicates and invalid shards", () => {
  const loads = tree(20);
  assert.deepEqual(read(loads), uncached(loads));
  assert.deepEqual(read(loads), { state: "loads" });

  const duplicate = new Map(loads);
  duplicate.set("plan/tasks.d/W1-T5-again.yaml", shard("W1-T5"));
  const dupState = read(duplicate);
  assert.deepEqual(dupState, uncached(duplicate));
  assert.equal(dupState?.state, "quarantined");
  assert.ok(dupState?.state === "quarantined" && dupState.ids.includes("W1-T5"), "the duplicate id is quarantined");
  assert.deepEqual(read(duplicate), dupState, "a repeat read with every shard reused still quarantines the duplicate");

  // one shard that declares W1-T800 twice: a repeat read reuses its text and must still quarantine it.
  const twice = new Map(duplicate);
  twice.set("plan/tasks.d/W1-T800.yaml", shard("W1-T800") + shard("W1-T800"));
  const twiceState = read(twice);
  assert.deepEqual(twiceState, uncached(twice));
  assert.ok(twiceState?.state === "quarantined" && twiceState.ids.includes("W1-T800"), "the in-shard duplicate is quarantined");
  assert.deepEqual(read(twice), twiceState, "a reused shard with a duplicate id is still quarantined");

  const invalid = new Map(twice);
  invalid.set("plan/tasks.d/W1-T900.yaml", "- id: W1-T900\n  title: [unclosed\n");
  const invalidState = read(invalid);
  assert.deepEqual(invalidState, uncached(invalid));
  assert.ok(invalidState?.state === "quarantined" && invalidState.ids.includes("W1-T900") && invalidState.ids.includes("W1-T5"));
  assert.deepEqual(read(invalid), invalidState, "a reused invalid shard is still quarantined");

  const fixed = new Map(invalid);
  fixed.delete("plan/tasks.d/W1-T5-again.yaml");
  fixed.delete("plan/tasks.d/W1-T900.yaml");
  fixed.delete("plan/tasks.d/W1-T800.yaml");
  assert.deepEqual(read(fixed), { state: "loads" }, "with the duplicate and the invalid shard removed the plan loads again");
  assert.deepEqual(read(fixed), uncached(fixed));
});

test("W1-T13609 criterion 3: a bad monolith and an unresolved dependency still refuse, and a failed git step is unreadable", () => {
  const good = tree(10);
  good.set("plan/tasks.d/W1-T50.yaml", shard("W1-T50", "  depends_on: [W1-T3]\n"));
  assert.deepEqual(read(good), { state: "loads" });

  const badMonolith = new Map(good);
  badMonolith.set(PLAN.monolith, "- id: [unclosed\n");
  const refusedYaml = read(badMonolith);
  assert.equal(refusedYaml?.state, "refused");
  assert.deepEqual(refusedYaml, uncached(badMonolith));
  assert.deepEqual(read(badMonolith), refusedYaml, "the same bad monolith seen before refuses with the same detail");

  // W1-T50's text is unchanged and reused; the merge removed the task it depends on.
  const unresolved = new Map(good);
  unresolved.delete("plan/tasks.d/W1-T3.yaml");
  const refusedDep = read(unresolved);
  assert.equal(refusedDep?.state, "refused");
  assert.match(refusedDep?.state === "refused" ? refusedDep.detail : "", /W1-T3/);
  assert.deepEqual(refusedDep, uncached(unresolved));
  assert.deepEqual(read(unresolved), refusedDep, "a repeat read refuses with the same first-line detail");

  const failed = read(good, "merge-tree");
  assert.equal(failed?.state, "unreadable");
  assert.match(failed?.state === "unreadable" ? failed.error : "", /git merge-tree exited 128/);
  assert.deepEqual(read(good), { state: "loads" }, "the next readable merge still loads");
});
