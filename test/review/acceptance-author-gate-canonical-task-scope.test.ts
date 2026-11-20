import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";

/** The JavaScript gate has no declaration file. Keep its real import visible to test placement. */
// @ts-expect-error The script is outside the repository's TypeScript project.
const { main } = await import("#scripts/acceptance-author-gate.mjs") as {
  main: (args: string[], options: { root: string }) => void;
};

// These are the actual merged path and canonical file populations at the
// respective merge parents. Use small fixtures so the proof also runs on base.

const registryChange = {
  "id": "W1-T11431",
  "changed": [
    "deploy/host-update.sh",
    "deploy/recycle-container.sh",
    "deploy/runtime-env-vars.sh",
    "deploy/serve-container.sh",
    "docs/instance-registry-selection-contract.md",
    "src/cli/commands/daemon.ts",
    "src/cli/commands/run-task-verb.ts",
    "src/lib/config-schema.ts",
    "src/lib/deployer.ts",
    "src/lib/instance-registry-selection.ts",
    "src/lib/sre-lane.ts",
    "src/lib/sweep.ts",
    "src/lib/worker.ts",
    "src/run-task.ts",
    "test/a-recycle-finds-a-holders-worktree-where-the-container-mounts-it.test.ts",
    "test/deploy/legacy-catalog-and-active-selection.test.ts",
    "test/deploy/selected-registry-contract-discriminates.test.ts",
    "test/deploy/selected-registry-lifecycle-consumers.test.ts",
    "test/idle-capacity-behind-a-hold-is-an-incident.test.ts",
    "test/recycle-container.test.ts",
    "test/shadow-instance-safety.test.ts",
    "test/sre-lane.test.ts",
    "test/the-sre-lane-files-incidents-off-the-daemon-loop.test.ts",
    "test/the-sre-lane-finds-its-instance-from-inside-its-container.test.ts",
    "test/the-sre-lane-runs-on-the-primary-instance.test.ts"
  ],
  "canonical": [
    "src/lib/deployer.ts",
    "src/lib/worker.ts",
    "src/lib/instance-registry-selection.ts",
    "src/run-task.ts",
    "src/cli/commands/run-task-verb.ts",
    "src/cli/commands/daemon.ts",
    "src/lib/sweep.ts",
    "src/lib/sre-lane.ts",
    "src/lib/instance-mode.ts",
    "src/lib/config-schema.ts",
    "deploy/recycle-container.sh",
    "deploy/runtime-env-vars.sh",
    "deploy/host-update.sh",
    "deploy/serve-container.sh",
    "test/deployer.test.ts",
    "test/deploy/selected-registry-contract-discriminates.test.ts",
    "test/shadow-instance-safety.test.ts",
    "test/recycle-container.test.ts",
    "test/a-recycle-finds-a-holders-worktree-where-the-container-mounts-it.test.ts",
    "test/serve-launch-uniformity.test.ts",
    "test/env-var-registry.test.ts",
    "docs/instance-registry-selection-contract.md"
  ],
  "extra": [
    "test/deploy/legacy-catalog-and-active-selection.test.ts",
    "test/deploy/selected-registry-lifecycle-consumers.test.ts",
    "test/idle-capacity-behind-a-hold-is-an-incident.test.ts",
    "test/sre-lane.test.ts",
    "test/the-sre-lane-files-incidents-off-the-daemon-loop.test.ts",
    "test/the-sre-lane-finds-its-instance-from-inside-its-container.test.ts",
    "test/the-sre-lane-runs-on-the-primary-instance.test.ts"
  ]
};
const censusChange = {
  "id": "W1-T13604",
  "changed": [
    "scripts/census-precheck.mjs",
    "test/a-precheck-child-loads-each-source-file-once.test.ts",
    "test/plan/a-merge-safety-read-parses-only-the-plan-shards-that-changed.test.ts"
  ],
  "canonical": [
    "scripts/census-precheck.mjs",
    "test/a-precheck-child-loads-each-source-file-once.test.ts",
    "test/infra/gate-probe-native-evidence.test.ts"
  ],
  "extra": [
    "test/plan/a-merge-safety-read-parses-only-the-plan-shards-that-changed.test.ts"
  ]
};

const acceptance = "## Acceptance\n\n- claim: fixture behavior\n  proof: unit test: fixture behavior\n";

function fixture(t: TestContext, id: string, files: readonly string[]) {
  const { dir: root, git } = gitRepo({ scope: t, kind: "canonical-scope" });
  const write = (path: string, text: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const scopePath = `plan/tasks.d/${id}.yaml`;
  const scope = (paths: readonly string[]) => write(scopePath, [
    `- id: ${id}`,
    "  title: Canonical scope fixture",
    "  repo: remudero",
    "  type: implement",
    "  status: queued",
    "  verify: auto",
    "  risk: low",
    "  depends_on: []",
    ...(paths.length === 0 ? [] : ["  files:", ...paths.map(path => `    - ${JSON.stringify(path)}`)]),
    "  acceptance:",
    "    - claim: fixture behavior",
    "      proof: 'unit test: fixture behavior'",
    "",
  ].join("\n"));
  const commit = (subject: string) => {
    git("add", "--all");
    git("commit", "-qm", subject);
    return git("rev-parse", "HEAD");
  };
  write("plan/tasks.yaml", "[]\n");
  for (const path of files) write(path, "first bytes\n");
  scope(files);
  return { root, write, scope, scopePath, commit, base: commit("file task scope"), git };
}

function check(root: string, options: {
  base?: string;
  head: string;
  body?: string;
  ref?: string;
  login?: string;
}) {
  // This event file is outside the fixture's plan and is never committed.
  const path = join(root, ".git", "event.json");
  writeFileSync(path, JSON.stringify({ pull_request: {
    body: options.body ?? acceptance,
    user: { login: options.login ?? "human" },
    base: { sha: options.base },
    head: { sha: options.head, ref: options.ref ?? "topic" },
  } }));
  const priorExit = process.exitCode;
  const messages: string[] = [];
  const report = (...args: unknown[]) => { messages.push(args.join(" ")); };
  const out = console.log;
  const err = console.error;
  console.log = report;
  console.error = report;
  try {
    main(["--event-path", path], { root });
    return { code: process.exitCode, message: messages.join("\n") };
  } finally {
    console.log = out;
    console.error = err;
    process.exitCode = priorExit;
  }
}

test("W1-T11571 criterion 1 names every undeclared task path", t => {
  for (const data of [registryChange, censusChange]) {
    const f = fixture(t, data.id, data.canonical);
    for (const path of data.changed) f.write(path, "changed bytes\n");
    const head = f.commit("implementation");
    const gate = check(f.root, { base: f.base, head, body: `Remudero-Task: ${data.id}\n` });
    assert.equal(gate.code, 1, gate.message);
    assert.match(gate.message, /canonical-task-scope-exceeded/);
    for (const path of data.extra) assert.ok(gate.message.includes(path), gate.message);
    for (const path of data.changed.filter(path => !data.extra.includes(path))) {
      assert.ok(!gate.message.includes(JSON.stringify(path)), gate.message);
    }
  }
});

test("W1-T11571 criterion 2 trusts only scope merged before the PR", t => {
  const id = "W1-T11571";
  const f = fixture(t, id, ["src/feature.ts"]);
  const nextPath = "src/extra.ts";
  f.git("switch", "-qc", "premature");
  f.scope(["src/feature.ts", nextPath]);
  f.write(nextPath, "new implementation\n");
  const premature = f.commit("unmerged widening");
  // The current target contains the amendment, while the PR's merge base does not.
  f.git("switch", "-q", "main");
  f.scope(["src/feature.ts", nextPath]);
  const amendedBase = f.commit("merge separate plan amendment");
  const body = `Remudero-Task: ${id}\n`;
  const blocked = check(f.root, { base: amendedBase, head: premature, body });
  assert.equal(blocked.code, 1, blocked.message);
  assert.match(blocked.message, /canonical-task-scope-exceeded.*src\/extra\.ts/);
  f.git("switch", "-qc", "qualified");
  f.write(nextPath, "new implementation\n");
  const qualified = check(f.root, { base: amendedBase, head: f.commit("use approved scope"), body });
  assert.equal(qualified.code, 0, qualified.message);
});

test("W1-T11571 criterion 3 preserves the supported gate outcomes", t => {
  const id = "W1-T11571";
  const f = fixture(t, id, ["src/feature.ts"]);
  const body = `Remudero-Task: ${id}\n`;
  f.write("src/feature.ts", "approved change\n");
  const inScope = f.commit("implementation inside scope");
  assert.equal(check(f.root, { base: f.base, head: inScope, ref: `run-${id}-12345678` }).code, 0);
  f.git("mv", "src/feature.ts", "src/renamed.ts");
  const rename = f.commit("rename to an undeclared path");
  const denied = check(f.root, { base: inScope, head: rename, body });
  assert.equal(denied.code, 1, denied.message);
  assert.match(denied.message, /canonical-task-scope-exceeded.*src\/renamed\.ts/);
  assert.equal(check(f.root, { base: inScope, head: rename, body, login: "dependabot[bot]" }).code, 0);
  assert.equal(check(f.root, { base: inScope, head: rename }).code, 0);
  f.scope(["src/feature.ts", "src/renamed.ts"]);
  const planOnly = f.commit("amend scope in a plan-only PR");
  assert.equal(check(f.root, { base: rename, head: planOnly }).code, 0);
});

test("W1-T11571 criterion 4 refuses unknown evidence for a canonical task", t => {
  const id = "W1-T11571";
  const f = fixture(t, id, ["src/feature.ts"]);
  const body = `Remudero-Task: ${id}\n`;
  const unreadable = check(f.root, { base: "0".repeat(40), head: f.base, body });
  assert.equal(unreadable.code, 1, unreadable.message);
  assert.match(unreadable.message, /canonical-task-scope-unreadable/);
  const missing = check(f.root, { head: f.base, body });
  assert.equal(missing.code, 1, missing.message);
  assert.match(missing.message, /canonical-task-scope-unreadable/);
  const noFiles = fixture(t, id, []);
  const undeclared = check(noFiles.root, { base: noFiles.base, head: noFiles.base, body });
  assert.equal(undeclared.code, 1, undeclared.message);
  assert.match(undeclared.message, /canonical-task-scope-unreadable/);
  const empty = check(f.root, { base: f.base, head: f.base, body });
  assert.equal(empty.code, 1, empty.message);
  assert.match(empty.message, /canonical-task-diff-unreadable/);
  const nonTask = check(f.root, { base: "0".repeat(40), head: f.base });
  assert.equal(nonTask.code, 0, nonTask.message);
  // The public checkout positively lacks this private or external task identity.
  const other = check(f.root, { base: f.base, head: f.base, body: acceptance, ref: "run-W1-T77777-12345678" });
  assert.equal(other.code, 0, other.message);

  // Keep the checked-out task and base monolith readable. Removing only the
  // fixture's loose shard tree object invalidates its committed shard listing.
  const tree = f.git("rev-parse", `${f.base}:plan/tasks.d`);
  const path = join(f.root, ".git", "objects", tree.slice(0, 2), tree.slice(2));
  renameSync(path, path + ".saved");
  try {
    const incomplete = check(f.root, { base: f.base, head: f.base, body });
    assert.equal(incomplete.code, 1, incomplete.message);
    assert.match(incomplete.message, /canonical-task-scope-unreadable/);
  } finally {
    renameSync(path + ".saved", path);
  }
});
