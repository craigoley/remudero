import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETIREMENT_REASONS } from "#src/lib/plan.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { originWithClone } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("migration preview excludes operator retirements before checking candidate merge credit", t => {
  const root = ownedFixtureDir(t, "migration-preview-retirement").dir;
  const record = (id: string, priority: number) =>
    `- id: ${id}\n  title: Fixture task ${id}\n  repo: remudero\n  type: implement\n  priority: ${priority}\n`;
  const eligible = "W1-T11";
  const eligibleBytes = record(eligible, 0);
  const retired = RETIREMENT_REASONS.map((reason, index) => ({
    id: `W1-T${index + 12}`,
    reason,
    priority: index + 1,
  }));
  const pub = originWithClone(join(root, "public"), {
    scope: t,
    seed: {
      "plan/tasks.yaml": "[]\n",
      [`plan/tasks.d/${eligible}.yaml`]: eligibleBytes,
      ...Object.fromEntries(retired.map(({ id, reason, priority }) => [
        `plan/tasks.d/${id}.yaml`,
        record(id, priority) + `  status: blocked\n  retirement: ${reason}\n`,
      ])),
    },
  });
  const ops = originWithClone(join(root, "ops"), {
    scope: t,
    seed: { "plan/tasks.yaml": "[]\n" },
  });
  const publicCommit = pub.clone.git("rev-parse", "HEAD");
  const opsCommit = ops.clone.git("rev-parse", "HEAD");
  const publicName = "fixture/remudero";
  const opsName = "fixture/ops";
  const credit = {
    number: 1,
    state: "MERGED",
    body: "Remudero-Task: W1-T999",
    headRefName: "run-W1-T999-1",
    mergeCommit: { oid: publicCommit },
    repository: { databaseId: 42, nameWithOwner: publicName },
  };
  const pageInfo = { hasNextPage: false, endCursor: null };
  const search = (nodes: unknown[]) => ({ nodes, issueCount: nodes.length, pageInfo });
  const response = join(root, "answer.json");
  writeFileSync(response, JSON.stringify({ data: {
    public: {
      databaseId: 42,
      nameWithOwner: publicName,
      defaultBranchRef: { name: "main", target: { oid: publicCommit } },
      open: { nodes: [], totalCount: 0, pageInfo },
      merged: { nodes: [credit], totalCount: 1, pageInfo },
    },
    ops: { databaseId: 43, nameWithOwner: opsName, defaultBranchRef: { name: "main", target: { oid: opsCommit } } },
    byTrailer: search([]),
    byBranch: search([]),
    control: search([credit]),
  } }));
  const shim = ghShim([{ when: "api graphql", stdoutFile: response }, { when: "", exit: 97, stderr: "unexpected GitHub call" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  const child = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src/run-task.ts"), "migration-preview",
    "--public-root", pub.clone.dir, "--public-commit", publicCommit, "--public-repo", publicName,
    "--ops-root", ops.clone.dir, "--ops-commit", opsCommit, "--ops-repo", opsName,
  ], {
    cwd: pub.clone.dir,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${shim.dir}:${process.env.PATH}`,
      HOME: home,
      RMD_GH_CACHE_HOME: home,
      TMPDIR: tmpdir(),
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
      LANG: "C",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      RMD_SELF_SYNC_DONE: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${pub.origin.dir}.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://github.com/${publicName}.git`,
      GIT_CONFIG_KEY_1: `url.${ops.origin.dir}.insteadOf`,
      GIT_CONFIG_VALUE_1: `https://github.com/${opsName}.git`,
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const preview = JSON.parse(child.stdout);
  assert.equal(preview.outcome, "candidate");
  assert.equal(preview.permission, "not_granted");
  assert.equal(preview.candidate.id, eligible);
  assert.equal(preview.candidate.originalBytesBase64, Buffer.from(eligibleBytes).toString("base64"));
  assert.equal(preview.controls.candidateSearches, 1);
  for (const { id } of retired) {
    assert.ok(preview.refused.some((item: { id: string; reason: string }) =>
      item.id === id && item.reason === "retired"), `missing explicit retirement refusal for ${id}`);
  }
});
