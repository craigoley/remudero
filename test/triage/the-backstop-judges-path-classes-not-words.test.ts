import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { backstopConcern, deterministicEscalation, machineShardRisk, pathClass, renderMachineShard } from "#src/lib/machine-filing.js";
import { judgeMachineShard, machineJudgeInput } from "#src/lib/machine-filing-judge.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "#src/lib/risk-judge.js";

const rec = (files: string[], title = "tidy the helper", claim = "the helper is tidy") => ({
  title, files, acceptance: [{ claim }],
});

test("W1-T10350: a test or plan document named for deploy, infra or tokens is not a privileged path", () => {
  const named = [
    "test/deploy/x.test.ts", "test/infra/y.test.ts", "test/daemon-lane-tokens.test.ts",
    "test/deploy-failed-latch-superseded.test.ts", "test/scout-automerge-x.test.ts",
    "plan/deploy-recovery-design.md", "docs/credentials-rotation.md",
  ];
  for (const f of named) {
    assert.notEqual(pathClass(f), "privileged", f);
    assert.equal(deterministicEscalation(rec([f])), undefined, f);
    assert.equal(machineShardRisk([f]), "low", f);
  }
  assert.equal(pathClass("test/deploy/x.test.ts"), "test");
  assert.equal(pathClass("plan/deploy-recovery-design.md"), "prose");
});

test("W1-T10350: a policy word in a prose-only record goes to the judge, not the backstop", () => {
  const bypass = rec(["docs/investigation.md"], "investigate the bypass of lint-plan gate", "the investigation names the bypass of the lint-plan gate");
  assert.equal(deterministicEscalation(bypass), undefined);
  assert.match(backstopConcern(bypass) ?? "", /^CONCERN: .*changes merge, deploy or branch-protection policy.*bypass of lint-plan gate/);
  const del = rec(["test/x.test.ts"], "remove the unneeded defensive branch", "the branch is gone");
  assert.equal(deterministicEscalation(del), undefined);
  assert.match(backstopConcern(del) ?? "", /deletes data, branches/);
  // a source path, or no path, keeps the deterministic escalation and hands no concern
  for (const files of [["src/lib/x.ts"], []]) {
    assert.match(deterministicEscalation({ ...bypass, files }) ?? "", /merge, deploy or branch-protection policy/);
    assert.equal(backstopConcern({ ...bypass, files }), undefined);
  }
  // secrets/auth and irreversible text stay deterministic even in a prose-only record
  assert.match(deterministicEscalation(rec(["docs/x.md"], "rotate the api key", "the key is rotated")) ?? "", /secrets, auth/);
  assert.match(deterministicEscalation(rec(["docs/x.md"], "force-push the branch", "done")) ?? "", /irreversible/);
  assert.equal(backstopConcern(rec(["docs/x.md"], "tidy", "tidy")), undefined);
});

function filed(files: string[], title: string, claim: string): Task {
  const { text, refused } = renderMachineShard({
    taskId: "W1-T9902", title, origin: "ci-friction:W1-T9902", files,
    acceptance: [{ claim, proof: `grep: W1-T9902 in ${files[0]}` }],
  });
  assert.equal(refused, undefined, `the fixture record lints clean: ${refused}`);
  return loadPlanFromYaml(text, "plan/tasks.d/W1-T9902-x.yaml").tasks[0]!;
}

test("W1-T10350: the judge's input carries the concern for a prose-only record, and the judge is asked", async () => {
  const policy = filed(["docs/investigation.md"], "investigate the bypass of lint-plan gate", "the investigation names the bypass of the lint-plan gate");
  const record = { family: "ci-friction", merged: 3, declined: 1, alpha: 4, beta: 2, mean: 4 / 6 };
  const description = machineJudgeInput(policy, record, () => true).change.description;
  assert.match(description, /\nCONCERN: .*changes merge, deploy or branch-protection policy.*bypass of lint-plan gate/);
  assert.match(description, /^OPERATOR ESCALATION RULE: /);
  // no concern line when the record has nothing to hand over, or the backstop escalates it instead
  const plain = filed(["docs/x.md"], "tidy the helper", "the helper is tidy");
  assert.doesNotMatch(machineJudgeInput(plain, record, () => true).change.description, /CONCERN:/);
  const src = filed(["src/lib/x.ts"], policy.title, "the investigation names the bypass of the lint-plan gate");
  assert.doesNotMatch(machineJudgeInput(src, record, () => true).change.description, /CONCERN:/);
  // judgeMachineShard does not escalate it deterministically: the risk judge is called with the concern
  let seen: RiskJudgeInput | undefined;
  const judged = await judgeMachineShard(policy, record, {
    riskJudge: async (input): Promise<RiskJudgeVerdict> => ((seen = input), { verdict: "low", confidence: 0.95, reasons: ["prose only"] }),
    policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true },
    clock: fixedClock(Date.parse("2026-10-13T12:00:00.000Z")),
  });
  assert.ok(seen, "the risk judge was asked");
  assert.match(seen!.change.description, /CONCERN: /);
  assert.equal(judged.kind === "ruled" && judged.ruling.action, "proceed");
  // while the same words beside a source path are escalated before the judge is asked
  let asked = false;
  const escalated = await judgeMachineShard(src, record, {
    riskJudge: async (): Promise<RiskJudgeVerdict> => ((asked = true), { verdict: "low", confidence: 0.95, reasons: [] }),
    policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true },
    clock: fixedClock(Date.parse("2026-10-13T12:00:00.000Z")),
  });
  assert.equal(asked, false);
  assert.equal(escalated.kind === "ruled" && escalated.ruling.action, "escalate");
});

test("W1-T10350: every genuinely privileged path still escalates", () => {
  const privileged = [
    ".github/workflows/ci.yml", ".github/scripts/x.mjs", ".claude/skills/x/SKILL.md", "settings/worker.json",
    "deploy/mac/x.sh", "deploy/Dockerfile", "infra/x.tf", "src/lib/deployer.ts", "src/lib/arm-auto-merge.ts",
    "scripts/merge-queue-canary.mjs", "src/lib/github-token.ts", "plan/policy.yaml", "DECISIONS.md", "CLAUDE.md",
    ".github/scripts/x.test.mjs",
  ];
  for (const f of privileged) {
    assert.equal(pathClass(f), "privileged", f);
    assert.match(deterministicEscalation(rec([f])) ?? "", /^it declares /, f);
    assert.equal(machineShardRisk([f]), "high", f);
  }
  assert.equal(pathClass("src/lib/plain.ts"), "other");
  assert.equal(machineShardRisk(["src/lib/plain.ts", "test/a.test.ts"]), "low");
});
