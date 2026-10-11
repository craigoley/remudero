import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { requestScopeAmendment, type ProofAmendmentWritePorts } from "../src/lib/proof-amendment.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { lintTask } from "../src/lib/task-linter.js";

const taskId = "W1-T6018";
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const shard = `- id: ${taskId}
  title: repair the view
  repo: remudero
  type: implement
  verify: auto
  risk: medium  # Rule 19: one concern
  origin: scope amendment fixture
  files: [src/lib/view-shadow.ts]
  acceptance:
    - claim: the view is repaired
      proof: 'unit test: view fixture'
`;

function fixture(text = shard, paths = ["src/lib/now-view.ts"]) {
  const effects: string[] = [];
  const writes: string[] = [];
  const commits: string[] = [];
  const pushed: string[] = [];
  const prs: Array<Parameters<ProofAmendmentWritePorts["createPr"]>[0]> = [];
  const deps: ProofAmendmentWritePorts = {
    repoDir: "/fixture",
    findShard: () => ({ path: shardPath, text }),
    worktreeAdd: () => { effects.push("worktree"); },
    worktreeRemove: () => { effects.push("remove"); },
    worktreePathFor: () => "/amendment",
    writeFile: (_path, next) => { effects.push("write"); writes.push(next); },
    gitAdd: () => { effects.push("add"); },
    gitCommit: (_path, message) => { effects.push("commit"); commits.push(message); return "amended-sha"; },
    gitPush: (_path, _branch, sha) => {
      assert.equal(sha, "amended-sha");
      effects.push("push"); pushed.push(writes[0]);
    },
    createPr: (opts) => {
      effects.push("pr"); prs.push(opts);
      return { prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 };
    },
    lookupIdentity: () => undefined,
    probeExisting: () => undefined,
    recordIdentity: () => { effects.push("identity"); },
    updateBranch: () => ({ ok: true }),
  };
  const request = { taskId, prNumber: 10833, prUrl: "https://github.com/acme/repo/pull/10833",
    trailerTaskId: taskId, headSha: "implementation-sha", paths, changedPaths: paths };
  return { effects, writes, commits, pushed, prs, deps, request };
}

test("W1-T7959: an amendment that crosses two subsystems is raised to risk:high and lints clean", () => {
  const f = fixture();
  const baseTask = parseTasksFromYaml(shard, shardPath)[0];
  assert.equal(lintTask(baseTask).ok, true, "positive control: the base shard is clean");
  assert.equal(requestScopeAmendment(f.request, f.deps).kind, "created");
  assert.deepEqual(f.effects, ["worktree", "write", "add", "commit", "push", "pr", "identity", "remove"]);
  const task = parseTasksFromYaml(f.pushed[0], shardPath)[0];
  assert.equal(task.risk, "high");
  assert.equal(task.band_meaning, "span");
  assert.deepEqual(task.files, ["src/lib/view-shadow.ts", "src/lib/now-view.ts"]);
  assert.equal(lintTask(task, { riskTransition: { baseTask } }).ok, true);
  assert.equal(f.commits.length, 1);
  for (const narrative of [f.commits[0], f.prs[0].body]) {
    assert.match(narrative, /risk.*raised to high/i);
    assert.match(narrative, /now-view,\s+view-shadow/);
    assert.match(narrative, /#10833/);
  }
  assert.equal(f.pushed[0].includes("one concern"), false);
  assert.match(f.pushed[0], /risk: high.*#10833.*now-view, view-shadow/);
  const criteria = parseAcceptanceBlock(f.prs[0].body);
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].claim, "files includes src/lib/now-view.ts");
  assert.match(criteria[1].claim, /risk.*raised to high/i);
  assert.equal(criteria[1].proof, `grep: ^ *risk: high in ${shardPath}`);
});

test("W1-T7959: an amendment with any other new lint violation is refused with no push", () => {
  const text = shard.replace("files: [src/lib/view-shadow.ts]", `files: [${shardPath}]`);
  const baseTask = parseTasksFromYaml(text, shardPath)[0];
  assert.equal(lintTask(baseTask).ok, true, "positive control: a record by itself passes Rule 15");
  const amended = parseTasksFromYaml(text.replace(`files: [${shardPath}]`,
    `files: [${shardPath}, src/lib/now-view.ts]`), shardPath)[0];
  const violation = lintTask(amended, { riskTransition: { baseTask } }).violations
    .find((v) => v.check === "rule15-filing");
  assert.ok(violation, "positive control: adding code triggers Rule 15");
  assert.equal(violation.severity, "block");
  const f = fixture(text);
  const result = requestScopeAmendment(f.request, f.deps);
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") assert.fail("the amendment must refuse");
  assert.equal(result.reason, "amended-shard-lint");
  assert.ok(result.detail.includes(`[rule15-filing] ${violation.message}`));
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.pushed, []);
  assert.deepEqual(f.prs, []);
});

test("scope lint preserves an existing band meaning when it raises risk", () => {
  for (const band of ["span", "blast-radius"]) {
    const f = fixture(shard.replace("  origin:", `  band_meaning: ${band}\n  origin:`));
    assert.equal(requestScopeAmendment(f.request, f.deps).kind, "created");
    const task = parseTasksFromYaml(f.pushed[0], shardPath)[0];
    assert.equal(task.risk, "high");
    assert.equal(task.band_meaning, band);
    assert.equal(f.pushed[0].split("band_meaning:").length, 2);
  }
});

test("scope lint allows inherited blockers and warnings without rewriting risk", () => {
  for (const text of [shard.replace("  origin: scope amendment fixture\n", ""),
    shard.replace("risk: medium  # Rule 19: one concern", "risk: high")]) {
    const f = fixture(text, ["src/view-shadow.ts"]);
    const base = parseTasksFromYaml(text, shardPath)[0];
    assert.ok(lintTask(base, { riskTransition: { baseTask: base } }).violations.length > 0);
    assert.equal(requestScopeAmendment(f.request, f.deps).kind, "created");
    assert.equal(f.pushed[0], text.replace("[src/lib/view-shadow.ts]",
      '[src/lib/view-shadow.ts, "src/view-shadow.ts"]'));
    assert.equal(parseAcceptanceBlock(f.prs[0].body).length, 1);
    assert.ok(f.commits[0].includes("files only"));
  }
});

test("scope lint compares sizing messages as well as checks", () => {
  const text = shard.replace("[src/lib/view-shadow.ts]", "[src/lib/view-shadow.ts, src/lib/status.ts]");
  const f = fixture(text);
  assert.equal(requestScopeAmendment(f.request, f.deps).kind, "created");
  const task = parseTasksFromYaml(f.pushed[0], shardPath)[0];
  assert.equal(task.risk, "high");
  assert.match(f.commits[0], /now-view,\s+status,\s+view-shadow/);
  const inherited = fixture(text, ["src/view-shadow.ts"]);
  assert.equal(requestScopeAmendment(inherited.request, inherited.deps).kind, "created");
  assert.equal(parseTasksFromYaml(inherited.pushed[0], shardPath)[0].risk, "medium");
});

test("scope lint refuses sizing mixed with another new blocker", () => {
  const text = shard.replace("[src/lib/view-shadow.ts]", `[${shardPath}, src/lib/view-shadow.ts]`);
  const f = fixture(text);
  const result = requestScopeAmendment(f.request, f.deps);
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") assert.fail("mixed violations must refuse");
  assert.equal(result.reason, "amended-shard-lint");
  assert.match(result.detail, /\[sizing\]/);
  assert.match(result.detail, /\[rule15-filing\]/);
  assert.deepEqual(f.effects, []);
});

test("scope lint edits only the target task fields across scalar and sequence shapes", () => {
  const other = shard.replace(taskId, "W1-T42");
  for (const text of [shard.replace("risk: medium", 'risk: "low"'),
    shard.replace("  risk: medium  # Rule 19: one concern\n", ""),
    shard.replace("  risk: medium  # Rule 19: one concern\n", "") + "  risk: low # keep this comment",
    shard.replace("files: [src/lib/view-shadow.ts]", "files:\n    - src/lib/view-shadow.ts"),
    shard.replace("one concern", "keep this comment")]) {
    const f = fixture(other + text);
    assert.equal(requestScopeAmendment(f.request, f.deps).kind, "created");
    assert.ok(f.pushed[0].startsWith(other), "the other task is byte-identical");
    const task = parseTasksFromYaml(f.pushed[0], shardPath)[1];
    assert.equal(task.risk, "high");
    assert.equal(task.band_meaning, "span");
    assert.deepEqual(task.files, ["src/lib/view-shadow.ts", "src/lib/now-view.ts"]);
    if (text.includes("keep this comment")) assert.ok(f.pushed[0].includes("keep this comment"));
    for (const line of f.commits[0].split("\n")) assert.ok(line.length <= 100);
  }
});

test("scope lint does not repair inherited provenance while raising risk", () => {
  const text = shard.replace("  origin: scope amendment fixture\n", "");
  const f = fixture(text);
  assert.equal(requestScopeAmendment(f.request, f.deps).kind, "created");
  const task = parseTasksFromYaml(f.pushed[0], shardPath)[0];
  assert.equal(task.risk, "high");
  assert.equal(task.origin, undefined);
  assert.deepEqual(lintTask(task).violations.filter((v) => v.severity === "block").map((v) => v.check),
    ["provenance"]);
});

test("scope lint refuses an unreadable task schema before any effects", () => {
  for (const text of [shard.replace("type: implement", "type: unknown"),
    shard.replace("  origin:", "  band_meaning: unknown\n  origin:"),
    shard.replace("risk: medium", "risk: invalid")]) {
    const f = fixture(text);
    const result = requestScopeAmendment(f.request, f.deps);
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") assert.fail("invalid schemas must refuse");
    assert.equal(result.reason, "amended-shard-lint");
    assert.match(result.detail, /cannot lint.*invalid (type|risk|band_meaning)/);
    assert.deepEqual(f.effects, []);
  }
});
