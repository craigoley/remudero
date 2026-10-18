// 2026-10-11: scope amendment #10842 (W1-T6018 + src/lib/now-view.ts, for #10833) was pushed without
// ever running the task linter; Rule 19 sizing blocked it and no lane could repair it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { newAmendedBlockers, requestScopeAmendment, type ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import { lintTask } from "#src/lib/task-linter.js";

const taskId = "W1-T9001";
const shardPath = `plan/tasks.d/${taskId}-a-fixture-shard.yaml`;

function shard(opts: { risk?: string; bandMeaning?: string; files?: string; verify?: string; vibeProof?: boolean }): string {
  return [
    `- id: ${taskId}`,
    `  title: "A FIXTURE"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    `  verify: ${opts.verify ?? "auto"}`,
    "  principles: {tdd: strict}",
    "  budget_usd: 2.00",
    ...(opts.risk === undefined ? [] : [`  risk: ${opts.risk}  # Rule 19: one concern`]),
    ...(opts.bandMeaning === undefined ? [] : [`  band_meaning: ${opts.bandMeaning}`]),
    `  origin: "fixture"`,
    `  files: ${opts.files ?? "[src/lib/view-shadow.ts]"}`,
    "  status: queued",
    "  priority: 3",
    "  attempts: 0",
    "  acceptance:",
    '    - claim: "the view classifies a time diff"',
    '      proof: "grep: classify in src/lib/view-shadow.ts"',
    ...(opts.vibeProof ? ['    - claim: "it feels right"', '      proof: "it feels right to the operator"'] : []),
    "",
  ].join("\n");
}

interface Calls { worktrees: number; written: string; commit: string; pushes: number; prs: Array<{ title: string; body: string }> }

function amend(text: string, paths: string[]): { outcome: ReturnType<typeof requestScopeAmendment>; calls: Calls } {
  const calls: Calls = { worktrees: 0, written: "", commit: "", pushes: 0, prs: [] };
  const deps = {
    repoDir: "/fixture", findShard: () => ({ path: shardPath, text }),
    worktreeAdd: () => { calls.worktrees++; }, worktreeRemove: () => {},
    writeFile: (_p: string, next: string) => { calls.written = next; },
    gitAdd: () => {}, gitCommit: (_p: string, message: string) => { calls.commit = message; return "sha"; },
    gitPush: () => { calls.pushes++; },
    probeExisting: () => undefined,
    createPr: (o: { title: string; body: string }) => { calls.prs.push(o); return { prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: () => undefined, recordIdentity: () => {},
    updateBranch: () => ({ ok: true }),
  } as unknown as ProofAmendmentWritePorts;
  const outcome = requestScopeAmendment({ taskId, prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "head-a", trailerTaskId: taskId, paths, changedPaths: paths }, deps);
  return { outcome, calls };
}

test("W1-T7959: an amendment that crosses two subsystems is raised to risk:high and lints clean", () => {
  const base = shard({ risk: "medium" });
  const { outcome, calls } = amend(base, ["src/lib/now-view.ts"]);
  assert.equal(outcome.kind, "created");
  assert.equal(calls.pushes, 1);
  const task = parseTasksFromYaml(calls.written, shardPath)[0]!;
  assert.equal(task.risk, "high");
  assert.equal(task.band_meaning, "span");
  assert.deepEqual(task.files, ["src/lib/view-shadow.ts", "src/lib/now-view.ts"]);
  const blocking = lintTask(task, { riskTransition: { baseTask: parseTasksFromYaml(base, shardPath)[0] } })
    .violations.filter((v) => v.severity === "block");
  assert.deepEqual(blocking, [], "the pushed shard lints clean");
  assert.ok(calls.written.includes("risk: high  # Rule 19 span: widened to now-view, view-shadow by a scope amendment for #42\n"));
  assert.ok(!calls.written.includes("one concern"), "the stale one-concern comment is replaced");
  // The edit touches the risk line, one band_meaning line and the files list, nothing else.
  assert.equal(calls.written.split("\n").length, base.split("\n").length + 1);
  assert.match(calls.commit, /raise risk to high/);
  assert.match(calls.commit, /now-view, view-shadow/);
  const body = calls.prs[0]!.body;
  assert.match(body, /risk is raised to high/);
  assert.match(body, /- risk is raised to high for now-view, view-shadow \| grep: \^ \*risk: high in plan\/tasks\.d\//);
  assert.match(body, /- files includes src\/lib\/now-view\.ts \| grep: /);
});

test("W1-T7959: an existing band_meaning is left alone when risk is raised", () => {
  const { outcome, calls } = amend(shard({ risk: "medium", bandMeaning: "blast-radius" }), ["src/lib/now-view.ts"]);
  assert.equal(outcome.kind, "created");
  const task = parseTasksFromYaml(calls.written, shardPath)[0]!;
  assert.equal(task.risk, "high");
  assert.equal(task.band_meaning, "blast-radius");
  assert.equal(calls.written.match(/band_meaning/g)?.length, 1);
});

test("W1-T7959: an amendment that stays within one subsystem is pushed unchanged", () => {
  const base = shard({ risk: "medium" });
  const { outcome, calls } = amend(base, ["src/other/view-shadow.ts"]);
  assert.equal(outcome.kind, "created");
  assert.ok(!/risk: high/.test(calls.written));
  assert.match(calls.prs[0]!.body, /Only plan\/tasks\.d\/.* files list changes/);
  assert.ok(!/risk is raised/.test(calls.prs[0]!.body));
});

test("W1-T7959: an amendment with any other new lint violation is refused with no push", () => {
  // Declaring a src path beside the task's own record at verify:auto is the rule15-filing block.
  const text = shard({ risk: "medium", files: `[${shardPath}]` });
  const { outcome, calls } = amend(text, ["src/lib/view-shadow.ts"]);
  assert.equal(outcome.kind, "refused");
  assert.equal((outcome as { reason: string }).reason, "amended-shard-lint");
  assert.match((outcome as { detail: string }).detail, /rule15-filing: /);
  assert.deepEqual([calls.worktrees, calls.pushes, calls.prs.length, calls.written, calls.commit], [0, 0, 0, "", ""]);
});

test("W1-T7959: a violation the base shard already had does not stop the amendment", () => {
  const text = shard({ risk: "medium", vibeProof: true });
  const { outcome } = amend(text, ["src/other/view-shadow.ts"]);
  assert.equal(outcome.kind, "created", "the vibe proof already blocked at base");
});

test("W1-T7959: a sizing block that the task's shape cannot repair by a line edit is refused", () => {
  const flowTask = [
    `- {id: ${taskId}, title: "t", repo: remudero, depends_on: [], type: implement, verify: auto, risk: medium,`,
    "   files: [src/lib/view-shadow.ts], status: queued, priority: 3, attempts: 0,",
    '   acceptance: [{claim: "c", proof: "grep: x in src/lib/view-shadow.ts"}]}',
    "",
  ].join("\n");
  const { outcome, calls } = amend(flowTask, ["src/lib/now-view.ts"]);
  assert.equal(outcome.kind, "refused");
  assert.equal((outcome as { reason: string }).reason, "amended-shard-lint");
  assert.match((outcome as { detail: string }).detail, /sizing: spans 2 distinct subsystems/);
  assert.equal(calls.worktrees, 0);
});

test("W1-T7959: an amended shard that no longer parses is a blocking shard-shape violation naming the error", () => {
  const base = shard({ risk: "medium" });
  const broken = base.replace("  type: implement", "  type: bogus");
  const verdict = newAmendedBlockers(base, broken, shardPath, taskId)!;
  assert.equal(verdict.task, undefined);
  assert.equal(verdict.blockers.length, 1);
  assert.equal(verdict.blockers[0]!.check, "shard-shape");
  assert.equal(verdict.blockers[0]!.severity, "block");
  assert.match(verdict.blockers[0]!.message, /^the amended shard no longer loads as a plan task: .*invalid type 'bogus'/);
});

test("W1-T7959: an amended shard that parses but lost the task is blocked without an error suffix", () => {
  const base = shard({ risk: "medium" });
  const renamed = base.replace(`- id: ${taskId}`, "- id: W1-T9002");
  const verdict = newAmendedBlockers(base, renamed, shardPath, taskId)!;
  assert.equal(verdict.task, undefined);
  assert.deepEqual(verdict.blockers.map((v) => v.message), ["the amended shard no longer loads as a plan task"]);
});

test("W1-T7959: a base shard that does not load gives no verdict at all", () => {
  const base = shard({ risk: "medium" }).replace("  type: implement", "  type: bogus");
  assert.equal(newAmendedBlockers(base, shard({ risk: "medium" }), shardPath, taskId), undefined);
});

test("W1-T7959: a task that declares no risk is given one at high beside its id", () => {
  const { outcome, calls } = amend(shard({}), ["src/lib/now-view.ts"]);
  assert.equal(outcome.kind, "created");
  const task = parseTasksFromYaml(calls.written, shardPath)[0]!;
  assert.equal(task.risk, "high");
  assert.equal(task.band_meaning, "span");
  assert.equal(calls.written.match(/^ {2}risk: high {2}# Rule 19 span/m)?.length, 1);
});
