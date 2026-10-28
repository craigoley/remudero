// W1-T9536 — on 2026-10-14 #11744 (W1-T9082) was direct-merged 23 commits behind main. The commits
// it skipped included #11758, which changed #11744's own src/run-task.ts and the child-entry test,
// and main went red 19:08Z-20:10Z. `directMergePreflightSteps` merged the behind PR as-is with no
// overlap check: an untouched PR at once (W1-T3694), a plan PR once its merged plan loaded
// (W1-T5748). Both arms now refresh a PR whose own files main changed since its merge base.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptArm, attemptArmAsync, logArmAttribution, realArmDeps, realArmDepsAsync, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { runStepsSync as runSync } from "#src/lib/git-push.js";
import * as safetyModule from "#src/lib/plan-pr-merge-safety.js";

// Read through a record so a tree without the W1-T9536 exports still loads and fails per test.
const safety = safetyModule as unknown as Record<string, any>;
const runStepsSync = (steps: unknown): any => runSync(steps as never);

const PR = "https://github.com/craigoley/remudero/pull/11744";
const HEAD = "4eca9e3314eca9e3314eca9e3314eca9e3314eca";
const CLEAN = "Pull request is in clean status";
const BEHIND_23 = { mergeable: "MERGEABLE", behindBy: 23, mergeableState: "clean" };

const own = (prFiles: string[] | undefined, mainFiles: string[], truncated = false) => ({
  ...(prFiles ? { prFiles } : {}),
  mainFiles: { files: mainFiles, truncated },
});

interface HarnessOpts {
  planTouch?: "touched" | "untouched";
  ownFiles?: () => unknown;
  planReadings?: () => unknown;
  facts?: Record<string, unknown>;
  ledger?: Array<Record<string, unknown>>;
}

function harness(opts: HarnessOpts = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const deps: Record<string, unknown> = {
    headSha: () => HEAD,
    ledgerLines: () => opts.ledger ?? [],
    armAuto: () => {
      calls.push("armAuto");
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => opts.facts ?? BEHIND_23,
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => opts.planTouch ?? "untouched",
    say: (msg: string) => void said.push(msg),
  };
  if (opts.ownFiles) {
    const read = opts.ownFiles;
    deps.readOwnFiles = () => {
      calls.push("readOwnFiles");
      return read();
    };
  }
  if (opts.planReadings) deps.readPlanMergeSafety = opts.planReadings;
  return { deps: deps as unknown as ArmDeps, calls, said };
}

test("W1-T9536: a behind PR whose own files main changed is refreshed, not direct-merged, on the untouched arm", () => {
  // #11744's own files against what main merged in the 23 commits it skipped (#11758 among them).
  const { deps, calls, said } = harness({
    ownFiles: () =>
      own(["src/run-task.ts", "scripts/build-child-entries.mjs", "src/run-child-main.ts"], [
        "src/run-task.ts",
        "test/the-core-fleet-fills-the-child-entry-store.test.ts",
      ]),
  });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.ok(!calls.includes("mergeDirect"), "a behind PR main changed under must never merge as-is");
  assert.deepEqual(calls.filter((c) => c === "updateBranch"), ["updateBranch"]);
  const evidence = result.directMergePreflight;
  assert.equal(evidence?.remedy, "update-branch");
  assert.equal(evidence?.reason, "main_changed_own_files");
  assert.equal(evidence?.ownFilesCause, "overlap");
  assert.deepEqual(evidence?.mainChangedOwnFiles, ["src/run-task.ts"]);
  assert.match(said.join("\n"), /automerge\.direct_merge_updated .*reason=main_changed_own_files .*files=src\/run-task\.ts/);
});

test("W1-T9536: a behind plan PR whose merged plan loads is still refreshed when main changed its own files", () => {
  const { deps, calls } = harness({
    planTouch: "touched",
    planReadings: () => ({
      prPlanPaths: ["plan/tasks.d/W1-T9082.yaml"],
      mainPlanPaths: [],
      mergedTree: { state: "loads" },
      ownFiles: own(["src/run-task.ts"], ["src/run-task.ts", "plan/tasks.d/W1-T9374.yaml"]),
    }),
  });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.ok(!calls.includes("mergeDirect") && !calls.includes("armAuto"));
  assert.equal(result.directMergePreflight?.reason, "main_changed_own_files", "not plan_pr_behind: the plan itself was safe");
  assert.equal(result.directMergePreflight?.planTouch, "touched");
  assert.deepEqual(result.directMergePreflight?.mainChangedOwnFiles, ["src/run-task.ts"]);
  assert.equal(result.directMergePreflight?.planMergeSafe, undefined);
});

test("a ceiling-crossing collision (#11776 over #11779) is caught: both PRs touched src/lib/sweep.ts", () => {
  // Neither PR's lines overlapped the other's, but together they crossed sweep.ts's comment ceiling.
  const { deps, calls } = harness({ ownFiles: () => own(["src/lib/sweep.ts"], ["src/lib/sweep.ts", "src/lib/drain.ts"]) });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.ok(!calls.includes("mergeDirect"));
  assert.deepEqual(result.directMergePreflight?.mainChangedOwnFiles, ["src/lib/sweep.ts"]);
});

test("a main change to a refresh-relevant path (a baseline, ci.yml, package.json) refreshes a behind PR", () => {
  const { deps, calls } = harness({ ownFiles: () => own(["src/lib/drain.ts"], ["scripts/comment-load-baseline.json"]) });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.ok(!calls.includes("mergeDirect"));
  assert.equal(result.directMergePreflight?.ownFilesCause, "baseline");
  assert.deepEqual(result.directMergePreflight?.mainChangedOwnFiles, ["scripts/comment-load-baseline.json"]);
});

test("a behind PR with no overlap still merges as-is, on both the untouched and the plan-safe arm", async () => {
  const untouched = harness({ ownFiles: () => own(["src/lib/drain.ts"], ["src/run-task.ts", "plan/tasks.d/W1-T1.yaml"]) });
  const merged = attemptArm(PR, untouched.deps, HEAD);
  assert.equal(merged.outcome, "direct-merged");
  assert.ok(untouched.calls.includes("readOwnFiles") && !untouched.calls.includes("updateBranch"));
  assert.equal(merged.directMergePreflight?.reason, undefined);

  const plan = harness({
    planTouch: "touched",
    // the plan shard both sides touched is the merged-plan load's to judge, never an own-files overlap.
    planReadings: () => ({ mergedTree: { state: "loads" }, ownFiles: own(["src/lib/drain.ts"], ["src/run-task.ts", "plan/tasks.d/W1-T1.yaml"]) }),
  });
  const planMerged = await attemptArmAsync(PR, plan.deps as never, HEAD);
  assert.equal(planMerged.outcome, "direct-merged");
  assert.equal(planMerged.directMergePreflight?.planMergeSafe, "merged_tree");
  assert.ok(!plan.calls.includes("updateBranch"));
});

test("an unreadable, failed or truncated compare refreshes a behind PR: never a merge on an unread overlap", async () => {
  const cases: Array<[string, () => unknown]> = [
    ["reader threw", () => {
      throw new Error("HTTP 502 on compare");
    }],
    ["reader error", () => ({ error: "the compare named no merge base or main tip" })],
    ["main list truncated", () => own(["src/lib/drain.ts"], ["src/run-task.ts"], true)],
    ["PR list unread", () => own(undefined, ["src/run-task.ts"])],
    ["main list unread", () => ({ prFiles: ["src/lib/drain.ts"] })],
  ];
  for (const [label, read] of cases) {
    const { deps, calls } = harness({ ownFiles: read });
    const result = await attemptArmAsync(PR, deps as never, HEAD);
    assert.equal(result.outcome, "direct-merge-updated", label);
    assert.ok(!calls.includes("mergeDirect"), label);
    assert.equal(result.directMergePreflight?.ownFilesCause, "unread", label);
  }
  // The plan arm's own lists come from the merge-safety reading; an unread one refreshes the same way.
  const plan = harness({ planTouch: "touched", planReadings: () => ({ mergedTree: { state: "loads" }, ownFiles: { error: "HTTP 404" } }) });
  const result = attemptArm(PR, plan.deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.equal(result.directMergePreflight?.reason, "main_changed_own_files");
  assert.equal(result.directMergePreflight?.ownFilesCause, "unread");
});

test("a PR at behind_by 0 is unchanged: no own-files read, merged directly", () => {
  const { deps, calls } = harness({ facts: { ...BEHIND_23, behindBy: 0 }, ownFiles: () => own(["a"], ["a"]) });
  assert.equal(attemptArm(PR, deps, HEAD).outcome, "direct-merged");
  assert.ok(!calls.includes("readOwnFiles"));
});

test("one refresh per (PR, head): a head already refreshed for main_changed_own_files awaits its new head", () => {
  const prior = { step: "automerge.direct_merge_updated", reason: "main_changed_own_files", pr_url: PR, prior_head_sha: HEAD };
  const { deps, calls } = harness({ ownFiles: () => own(["src/run-task.ts"], ["src/run-task.ts"]), ledger: [prior] });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merge-preflight-refused");
  assert.ok(!calls.includes("updateBranch") && !calls.includes("mergeDirect"));
  assert.equal(result.directMergePreflight?.remedy, "retry-later");
  // another head of the same PR is refreshed as usual.
  const moved = harness({ ownFiles: () => own(["src/run-task.ts"], ["src/run-task.ts"]), ledger: [{ ...prior, prior_head_sha: "older" }] });
  assert.equal(attemptArm(PR, moved.deps, HEAD).outcome, "direct-merge-updated");
});

test("the refresh's ledger row records reason main_changed_own_files with the overlapping files", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  logArmAttribution(log, "direct-merge-updated", PR, "W1-T9082", "review", {}, undefined, {
    remedy: "update-branch",
    behindBy: 23,
    reason: "main_changed_own_files",
    ownFilesCause: "overlap",
    mainChangedOwnFiles: ["src/run-task.ts"],
  } as never);
  const row = rows.find((r) => r.step === "automerge.direct_merge_updated")?.extra;
  assert.equal(row?.reason, "main_changed_own_files");
  assert.equal(row?.own_files_cause, "overlap");
  assert.deepEqual(row?.main_changed_own_files, ["src/run-task.ts"]);
});

// ── the real readers: GitHub's two compares, read once ─────────────────────────────────────────

const TARGET = { owner: "craigoley", repo: "remudero", prNumber: 11744 };
const fileRows = (names: string[]) => names.map((filename) => ({ filename }));

function fakeRest(prFiles: unknown[], mainFiles: unknown[]) {
  const reads: string[] = [];
  const rest = (args: string[]): unknown => {
    const path = args[1] ?? "";
    reads.push(path);
    if (path.endsWith("/pulls/11744")) return { base: { ref: "main" }, head: { sha: HEAD } };
    if (path.includes(`/compare/main...${HEAD}`)) return { files: prFiles, merge_base_commit: { sha: "mb" }, base_commit: { sha: "tip" } };
    if (path.includes("/compare/mb...tip")) return { files: mainFiles };
    throw new Error(`unexpected read ${args.join(" ")}`);
  };
  return { rest, reads };
}

test("readOwnFilesSteps reads the PR's own non-plan files and main's since the merge base", () => {
  assert.equal(typeof safety.readOwnFilesSteps, "function");
  const { rest, reads } = fakeRest(
    [...fileRows(["src/run-task.ts", "plan/tasks.d/W1-T9082.yaml"]), { filename: "src/new.ts", previous_filename: "src/old.ts" }],
    fileRows(["src/run-task.ts"]),
  );
  const readings = runStepsSync(safety.readOwnFilesSteps(TARGET, rest));
  assert.deepEqual(readings.prFiles, ["src/run-task.ts", "src/new.ts", "src/old.ts"]);
  assert.deepEqual(readings.mainFiles, { files: ["src/run-task.ts"], truncated: false });
  assert.equal(reads.length, 3);
  assert.deepEqual(safety.mainChangedOwnFiles(readings), { cause: "overlap", files: ["src/run-task.ts"] });

  // GitHub shows at most 300 files: a list that long may hide an overlap.
  const long = fakeRest(fileRows(Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`)), fileRows(Array.from({ length: 300 }, (_, i) => `m${i}`)));
  const cut = runStepsSync(safety.readOwnFilesSteps(TARGET, long.rest));
  assert.equal(cut.prFiles, undefined);
  assert.equal(cut.mainFiles.truncated, true);
  assert.equal(safety.mainChangedOwnFiles(cut).cause, "unread");

  const failing = runStepsSync(safety.readOwnFilesSteps(TARGET, () => {
    throw new Error("HTTP 502");
  }));
  assert.match(String(failing.error), /HTTP 502/);
});

test("the plan merge-safety reading carries the same compares' own-files lists, so the plan arm reads nothing more", () => {
  const { rest, reads } = fakeRest(fileRows(["src/run-task.ts", "plan/tasks.d/W1-T9082.yaml"]), fileRows(["src/run-task.ts"]));
  const git = () => ({ status: 128, stdout: "" });
  const readings = runStepsSync(safety.readPlanMergeSafetySteps(TARGET, rest, git));
  assert.deepEqual(readings.ownFiles, { prFiles: ["src/run-task.ts"], mainFiles: { files: ["src/run-task.ts"], truncated: false } });
  assert.deepEqual(readings.prPlanPaths, ["plan/tasks.d/W1-T9082.yaml"]);
  assert.equal(reads.length, 3);
});

test("the production arm deps wire the own-files reader on both drivers", () => {
  assert.equal(typeof (realArmDeps() as unknown as Record<string, unknown>).readOwnFiles, "function");
  assert.equal(typeof (realArmDepsAsync() as unknown as Record<string, unknown>).readOwnFiles, "function");
});
