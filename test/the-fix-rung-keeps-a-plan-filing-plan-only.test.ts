/**
 * test/the-fix-rung-keeps-a-plan-filing-plan-only.test.ts — W1-T5118.
 *
 * #4236's shape: a one-file plan-only filing whose shard declares the FUTURE implementation paths.
 * Before this task the fix rung picked its scope regime from the task's declared files, so the
 * guard called the shard out of scope and the future src/test paths in scope, and a repair worker
 * could turn the filing into a Rule-15 mixture. The regime is now read from the PR's own captured
 * baseline diff, one `fixScopeRegime` call shared by the prompt and the pre-strike guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixRungScopeStandDownReason,
  fixScopeRegime,
  isPlanFilingBaseline,
  outOfDeclaredScopeFiles,
  renderFixPrompt,
} from "../src/run-task.js";

const SHARD = "plan/tasks.d/W1-T2949-worker-provider.yaml";
const SRC = "src/lib/worker-provider.ts";
const TEST = "test/worker-provider.test.ts";
const DECLARED = [SRC, TEST];
const TASK = { id: "W1-T2949", title: "the worker provider", files: DECLARED };
const EVIDENCE = { ciFailures: [{ name: "build", logTail: "boom" }] };

function render(baselineDiffFiles?: string[]): string {
  return renderFixPrompt({ task: TASK, round: 2, branch: "run-W1-T2949-1", evidence: EVIDENCE, baselineDiffFiles });
}

test("a plan-only baseline is a filing even when the task declares src files", () => {
  assert.equal(isPlanFilingBaseline([SHARD]), true);
  assert.equal(fixScopeRegime(DECLARED, [SHARD]), "plan");
  // The shard itself is in scope for a filing; the future paths are not.
  assert.deepEqual(outOfDeclaredScopeFiles([SHARD, SRC, TEST], DECLARED, [], fixScopeRegime(DECLARED, [SHARD])), [
    SRC,
    TEST,
  ]);
});

test("the fix prompt for a plan filing refuses the task's future src paths", () => {
  const prompt = render([SHARD]);
  const line = prompt.split("\n").find((l) => l.startsWith("PLAN FILING SCOPE (W1-T5118)"));
  assert.ok(line, "the filing renders its own scope line");
  assert.match(line, /MAY repair that shard/);
  assert.ok(line.includes(SHARD), "the shard is named as repairable");
  assert.match(line, /do NOT add any path outside plan scope/);
  assert.ok(line.includes(`declared future path(s): ${SRC}, ${TEST}`), "the future paths are named as refused");
  // The implementation regime's licences must not render for a filing.
  assert.doesNotMatch(prompt, /DECLARED SCOPE \(W1-T1227\): this task's PR may only touch/);
  assert.doesNotMatch(prompt, /Files under test\/ may be added/);
  assert.doesNotMatch(prompt, /REGISTRY EXCEPTION/);
});

test("the scope guard stands down when a fix worker adds src to a plan filing", () => {
  // The live call site appends "test/" to the declared list when tests are admitted.
  const declared = [...DECLARED, "test/"];
  const standDown = fixRungScopeStandDownReason([SHARD, SRC, TEST], [SHARD], declared);
  assert.ok(standDown, "the guard stands down on #4236's shape");
  assert.equal(standDown.scopeKind, "plan");
  assert.deepEqual(standDown.newOutOfScopePaths, [SRC, TEST]);
  assert.match(standDown.reason, /outside plan scope on a plan-only PR/);
  assert.match(standDown.reason, /plan-only filing/);
  // A repair to the shard itself stays allowed.
  assert.equal(fixRungScopeStandDownReason([SHARD], [SHARD], declared), undefined);
  assert.equal(fixRungScopeStandDownReason([SHARD, "plan/tasks.d/W1-T2949-b.yaml"], [SHARD], declared), undefined);
});

test("an implementation baseline keeps the declared-file fix scope", () => {
  const baseline = [SHARD, SRC];
  assert.equal(isPlanFilingBaseline(baseline), false);
  assert.equal(fixScopeRegime(DECLARED, baseline), "files");
  // Adding a declared path is fine; an undeclared one stands down under the files regime.
  assert.equal(fixRungScopeStandDownReason([SHARD, SRC, TEST], baseline, DECLARED), undefined);
  const standDown = fixRungScopeStandDownReason([SHARD, SRC, "src/other.ts"], baseline, DECLARED);
  assert.equal(standDown?.scopeKind, "files");
  assert.deepEqual(standDown?.newOutOfScopePaths, ["src/other.ts"]);
  // W1-T2653's remedy widening still applies to an implementation PR.
  assert.equal(
    fixRungScopeStandDownReason([SHARD, SRC, "src/other.ts"], baseline, DECLARED, ["src/other.ts"]),
    undefined,
  );
  const prompt = render(baseline);
  assert.match(prompt, new RegExp(`DECLARED SCOPE \\(W1-T1227\\): this task's PR may only touch: ${SRC}, ${TEST}`));
  assert.doesNotMatch(prompt, /PLAN FILING SCOPE/);
});

test("an empty fix baseline never invents a plan filing role", () => {
  assert.equal(isPlanFilingBaseline([]), false);
  assert.equal(isPlanFilingBaseline(undefined), false);
  assert.equal(fixScopeRegime(DECLARED, []), "files");
  assert.equal(fixScopeRegime(DECLARED, undefined), "files");
  // Today's declared-file regime: from an empty baseline, the shard is the out-of-scope addition.
  assert.equal(fixRungScopeStandDownReason([SHARD, SRC], [], DECLARED)?.scopeKind, "files");
  for (const baseline of [undefined, []]) {
    const prompt = render(baseline);
    assert.doesNotMatch(prompt, /PLAN FILING SCOPE/);
    assert.match(prompt, /DECLARED SCOPE \(W1-T1227\)/);
  }
  // A task declaring only plan paths is unchanged: plan regime with or without a baseline.
  assert.equal(fixScopeRegime([SHARD], []), "plan");
  assert.equal(fixScopeRegime([SHARD], [SRC]), "plan");
});
