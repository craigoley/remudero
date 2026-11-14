import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12510: the hook leaves the census precheck and the plan lint to CI and keeps its other checks.
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const LEFT_TO_CI = ["census-precheck.mjs", "lint-plan-precheck.mjs"];
const KEPT = ["rule15-precheck.mjs", "rule25-precheck.mjs", "ci-control-plane-precheck.mjs", "head-identity-gate.mjs"];
const OTHERS = ["test-tier-manifest.mjs", "worker-branch-shape.mjs", "proof-resolve-precheck.mjs"];
const CI_LINE = "pre-push: census suites and plan lint run in CI (ci.yml ci-shard and lint-plan, aggregated by ci-gate)";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

/** A gate script that records its name, then refuses when GATE_REFUSE names it. */
function recordingGate(name: string): string {
  const record = `import { appendFileSync } from "node:fs";
const record = () => {
  appendFileSync(process.env.GATE_LOG, ${JSON.stringify(name)} + "\\n");
  if ((process.env.GATE_REFUSE ?? "").split(",").includes(${JSON.stringify(name)})) process.exit(1);
};
`;
  if (name !== "head-identity-gate.mjs") return `${record}record();\n`;
  // The transition check imports this module and asks its predicate; the advisory runs it as a script.
  return `${record}export function evaluateHeadIdentityGate({ headCommitMessage }) {
  return /^Remudero-Task: /m.test(headCommitMessage) ? { ok: true, message: "trailer" } : { ok: false, message: "none" };
}
if (process.argv[1]?.endsWith("head-identity-gate.mjs")) record();
`;
}

/** A code root holding the hook, a loader and recording gates for `gates`. */
function plantGateRoot(root: string, gates: string[]): void {
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(HOOK, join(root, "hooks", "pre-push"));
  if (!existsSync(join(root, "node_modules"))) symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  for (const gate of gates) writeFileSync(join(root, "scripts", gate), recordingGate(gate));
}

/** A tree with origin/main at a seed commit and one branch commit that changes `changed`. */
function tree(t: TestContext, changed: string): { dir: string; base: string; head: string } {
  const dir = gitRepo({ scope: t, kind: "pre-push-left-to-ci", seedCommit: false }).dir;
  git(dir, "commit", "-q", "--allow-empty", "-m", "seed");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", base);
  mkdirSync(join(dir, dirname(changed)), { recursive: true });
  writeFileSync(join(dir, changed), "x: 1\n");
  git(dir, "add", changed);
  git(dir, "commit", "-q", "-m", "feat: change (W1-T1)\n\nRemudero-Task: W1-T1");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

function runHook(hook: string, cwd: string, log: string, opts: { refuse?: string; stdin?: string } = {}) {
  const res = spawnSync("sh", [hook], {
    cwd,
    encoding: "utf8",
    input: opts.stdin ?? "",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, RMD_PREPUSH_GATES: "1", GATE_LOG: log, GATE_REFUSE: opts.refuse ?? "" },
  });
  assert.equal(res.error, undefined, `the hook failed to launch: ${String(res.error)}`);
  const ran = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status: res.status ?? -1, stderr: res.stderr ?? "", ran };
}

for (const changed of ["src/lib/x.ts", "plan/tasks.d/W1-T1-x.yaml"]) {
  test(`W1-T12510 criterion 1: a push of ${changed} starts neither census-precheck nor lint-plan-precheck`, (t) => {
    // The tree's own hook: every gate, including the two left to CI, is present and records.
    const own = tree(t, changed);
    plantGateRoot(own.dir, [...LEFT_TO_CI, ...KEPT, ...OTHERS]);
    const ownRun = runHook(join(own.dir, "hooks", "pre-push"), own.dir, join(own.dir, "gate.log"));
    for (const gate of LEFT_TO_CI) assert.ok(!ownRun.ran.includes(gate), `${gate} ran: ${ownRun.ran.join(", ")}`);
    for (const gate of KEPT) assert.ok(ownRun.ran.includes(gate), `positive control: ${gate} ran (${ownRun.ran.join(", ")})`);
    assert.equal(ownRun.status, 0, ownRun.stderr);

    // A harness hook judging a managed worktree: the gate root differs from the pushed tree.
    const managed = tree(t, changed);
    const harness = ownedFixtureDir(t, "pre-push-left-to-ci-harness").dir;
    plantGateRoot(harness, LEFT_TO_CI);
    const log = join(harness, "gate.log");
    const managedRun = runHook(join(harness, "hooks", "pre-push"), managed.dir, log);
    assert.deepEqual(managedRun.ran, [], `the harness hook started: ${managedRun.ran.join(", ")}`);
    assert.equal(managedRun.status, 0, managedRun.stderr);
  });
}

test("W1-T12510 criterion 2: the identity, rule 15, rule 25 and control-plane checks still run, and each refusal refuses the push", (t) => {
  const { dir } = tree(t, "src/lib/x.ts");
  plantGateRoot(dir, [...KEPT, ...OTHERS]);
  const hook = join(dir, "hooks", "pre-push");
  const log = join(dir, "gate.log");
  const clean = runHook(hook, dir, log);
  for (const gate of [...KEPT, ...OTHERS]) assert.ok(clean.ran.includes(gate), `${gate} must run (ran: ${clean.ran.join(", ")})`);
  assert.equal(clean.status, 0, clean.stderr);

  for (const gate of ["rule15-precheck.mjs", "rule25-precheck.mjs", "ci-control-plane-precheck.mjs"]) {
    const refused = runHook(hook, dir, join(dir, `${gate}.log`), { refuse: gate });
    assert.equal(refused.status, 1, `${gate} refused, so the push must be refused: ${refused.stderr}`);
    assert.match(refused.stderr, /pre-push REFUSED/);
  }

  // The head-identity transition: the remote tip carries the trailer and the pushed head drops it.
  const admitted = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--allow-empty", "-m", "feat: drop the trailer");
  const lost = git(dir, "rev-parse", "HEAD");
  const line = `refs/heads/run-W1-T1-1 ${lost} refs/heads/run-W1-T1-1 ${admitted}\n`;
  const identity = runHook(hook, dir, join(dir, "identity.log"), { stdin: line });
  assert.equal(identity.status, 1, identity.stderr);
  assert.match(identity.stderr, /REFUSED — this push turns an admitted head into one head-identity-gate REFUSES/);
});

test("W1-T12510 criterion 3: the hook prints one line naming where the two checks run in CI", (t) => {
  const { dir } = tree(t, "plan/tasks.d/W1-T1-x.yaml");
  plantGateRoot(dir, [...KEPT, ...OTHERS]);
  const { stderr, status } = runHook(join(dir, "hooks", "pre-push"), dir, join(dir, "gate.log"));
  assert.equal(status, 0, stderr);
  const lines = stderr.split("\n").filter((l) => l === CI_LINE);
  assert.equal(lines.length, 1, stderr);
});
