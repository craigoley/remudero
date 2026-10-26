import assert from "node:assert/strict";
import { test } from "node:test";

import { backstopConcern, deterministicEscalation, machineShardRisk, pathClass } from "#src/lib/machine-filing.js";

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
