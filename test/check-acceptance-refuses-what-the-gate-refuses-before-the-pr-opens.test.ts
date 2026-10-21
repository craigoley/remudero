import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkAcceptanceCommand } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const shard = "plan/tasks.d/W1-T9237.yaml";
const missing = "test/not-built-yet.test.ts";
const buildProof = `grep: implemented in ${missing}`;

function fixture(proof = buildProof) {
  const repo = gitRepo();
  repo.git("config", "user.name", "acceptance fixture");
  repo.git("config", "user.email", "acceptance@remudero.invalid");
  mkdirSync(join(repo.dir, "bin"));
  writeFileSync(join(repo.dir, "bin/rmd"), "exec node main.js\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base files");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base plan");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, shard), [
    "- id: W1-T9237", "  title: build the feature", "  repo: remudero", "  type: implement",
    "  files:", `    - ${missing}`, "  acceptance:", "    - claim: the feature works",
    `      proof: '${proof}'`, "",
  ].join("\n"));
  repo.git("add", ".");
  repo.git("commit", "-qm", "file the task");
  return repo;
}

function run(root: string, proof: string, options: { trailer?: boolean; changedFiles?: () => string[] } = {}) {
  writeFileSync(join(root, "body.md"),
    `## Acceptance\n\n- claim: the evidence exists\n  proof: ${proof}\n` +
    (options.trailer ? "\nRemudero-Task: W1-T9237\n" : ""));
  const lines: string[] = [];
  const previousCwd = process.cwd();
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    process.chdir(root);
    const code = checkAcceptanceCommand(["body.md"], {
      planPath: join(root, "plan/tasks.yaml"), changedFiles: options.changedFiles,
    });
    return { code, out: lines.join("\n") };
  } finally {
    process.chdir(previousCwd);
    console.log = log;
    console.error = error;
  }
}

test("W1-T9237: a body grep proof naming an absent path is refused before the PR opens", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, "grep: present in src/absent.ts");
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /REFUSED by acceptance-author-gate \(grep-proof-target-missing\)/);
    assert.match(result.out, /criterion 1's grep proof names `src\/absent.ts`, which does not exist at this head/);
    assert.doesNotMatch(result.out, /^OK/m);
    assert.doesNotMatch(result.out, /BUILD proof/);
  } finally { repo.cleanup(); }
});

test("W1-T9237: a filing body that copies its task build proof is named as such", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, buildProof);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /grep-proof-target-missing/);
    assert.match(result.out, /W1-T9237's BUILD proof/);
    assert.match(result.out, /a filing PR proves the filing/);
    assert.ok(result.out.includes(`grep: ^- id: W1-T9237$ in ${shard}`), result.out);
  } finally { repo.cleanup(); }
});

test("W1-T9237: a filing body proving its shard still passes", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, `grep: ^- id: W1-T9237$ in ${shard}`);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^OK — the parser resolves exactly what was written/m);
    assert.doesNotMatch(result.out, /REFUSED|BUILD proof/);
  } finally { repo.cleanup(); }
});

test("W1-T9237: a body grep proof naming an extensionless file is refused before the PR opens", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, "grep: exec node in bin/rmd");
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /REFUSED by acceptance-author-gate \(proof-shape\)/);
    assert.match(result.out, /criterion 1 cannot execute: target `bin\/rmd` names no file/);
    assert.doesNotMatch(result.out, /^OK/m);
  } finally { repo.cleanup(); }
});

test("W1-T9237: resolved trailers keep using the shard rather than body proof checks", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, "grep: exec node in bin/rmd", { trailer: true });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /OK — the gate would judge this PR from W1-T9237's shard/);
  } finally { repo.cleanup(); }
});

test("W1-T9237: an unreadable diff preserves the refusal without guessing a filing", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, buildProof, { changedFiles() { throw new Error("no diff available"); } });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /grep-proof-target-missing/);
    assert.doesNotMatch(result.out, /BUILD proof/);
  } finally { repo.cleanup(); }
});

test("W1-T9237: a mixed implementation diff is never called a filing", () => {
  const repo = fixture();
  try {
    const result = run(repo.dir, buildProof, { changedFiles: () => [shard, "src/feature.ts"] });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /grep-proof-target-missing/);
    assert.doesNotMatch(result.out, /BUILD proof/);
  } finally { repo.cleanup(); }
});

test("W1-T9237: a refused unit test copied from the filed task gets the filing remedy", () => {
  const proof = `unit test: ${missing}::the feature works`;
  const repo = fixture(proof);
  try {
    const result = run(repo.dir, proof);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /proof-shape/);
    assert.match(result.out, /W1-T9237's BUILD proof/);
    assert.ok(result.out.includes(`grep: ^- id: W1-T9237$ in ${shard}`), result.out);
  } finally { repo.cleanup(); }
});

test("W1-T9237: an unreadable shard cannot hide the gate's proof refusal", () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo.dir, shard), "not a task list\n");
    const result = run(repo.dir, buildProof);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /grep-proof-target-missing/);
    assert.match(result.out, /filing context unavailable: plan must be a YAML list/);
    assert.doesNotMatch(result.out, /BUILD proof/);
  } finally { repo.cleanup(); }
});
