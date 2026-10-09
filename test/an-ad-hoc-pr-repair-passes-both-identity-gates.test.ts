import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workerScript = join(root, "scripts", "worker-branch-shape.mjs");
const worker = await import(pathToFileURL(workerScript).href) as {
  inspectDeclaredTaskIds: (path: string) => { ids: string[]; complete: boolean };
  evaluateWorkerBranchShape: (input: {
    headRef: string; commitMessages: string; addedFiles: string[]; changedFiles: string[];
    readFile: (path: string) => string | undefined; declaredTaskIds: string[]; declaredTaskIdsComplete?: boolean;
  }) => { ok: boolean; message: string };
};
const prId = "PR-10450";
const filedId = "TRIAGE-EXISTING";
const headRef = "codex/ad-hoc-repair";
const message = `fix(flow): repair gates\n\nRemudero-Task: ${prId}\n`;

function fixture(t: TestContext, commitMessage = message) {
  const path = mkdtempSync(join(tmpdir(), "rmd-ad-hoc-identity-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Identity fixture"]);
  mkdirSync(join(path, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(path, "plan", "tasks.yaml"), `- id: ${filedId}\n`);
  writeFileSync(join(path, "plan", "tasks.d", "positive.yaml"), "- id: W1-T100\n");
  git(["add", "plan"]);
  git(["commit", "-q", "-m", "chore: base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(path, "implementation.ts"), "export const repaired = true;\n");
  git(["add", "implementation.ts"]);
  git(["commit", "-q", "-m", commitMessage]);
  return { path, base, git };
}

function cli(script: string, path: string, base: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_SELF_SYNC_DONE: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--worktree-path", path,
    ...(script === workerScript ? ["--base", base] : []), "--head-ref", headRef],
  { env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 << 20 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test("an existing ad-hoc PR repair passes both real identity gates without weakening filed task shape", (t) => {
  const f = fixture(t);
  assert.deepEqual(worker.inspectDeclaredTaskIds(f.path), { ids: [filedId, "W1-T100"], complete: true });
  const identity = cli(join(root, "scripts", "head-identity-gate.mjs"), f.path, f.base);
  assert.equal(identity.status, 0, identity.stderr);
  assert.match(identity.stdout, /head-identity-gate: OK/);
  const shape = cli(workerScript, f.path, f.base);
  assert.equal(shape.status, 0, shape.stderr);
  assert.match(shape.stdout, /ad-hoc PR identity PR-10450.*complete plan/);
  const mixed = fixture(t, message + `Remudero-Task: ${filedId}\n`);
  const refused = cli(workerScript, mixed.path, mixed.base);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /TRIAGE-EXISTING/);
});

test("a PR-number identity cannot exempt declared quoted or flow-style plan task IDs", (t) => {
  for (const yaml of [`- id: '${prId}'\n`, `[{id: ${prId}}]\n`]) {
    const f = fixture(t);
    writeFileSync(join(f.path, "plan", "tasks.d", "pr-task.yaml"), yaml);
    f.git(["add", "plan"]);
    f.git(["commit", "-q", "-m", message]);
    assert.ok(worker.inspectDeclaredTaskIds(f.path).ids.includes(prId));
    assert.equal(cli(workerScript, f.path, f.base).status, 1);
  }
});

test("an ad-hoc PR trailer never erases a shard-only or declared head-ref task claim", () => {
  const input = { headRef, commitMessages: message, addedFiles: [], changedFiles: ["src/change.ts"],
    readFile: () => undefined, declaredTaskIds: [filedId], declaredTaskIdsComplete: true };
  assert.equal(worker.evaluateWorkerBranchShape(input).ok, true);
  assert.equal(worker.evaluateWorkerBranchShape({ ...input, headRef: `run-${filedId}-bad` }).ok, false);
  assert.equal(worker.evaluateWorkerBranchShape({ ...input, headRef: `run-${filedId}-123` }).ok, true);
  assert.equal(worker.evaluateWorkerBranchShape({ ...input, addedFiles: ["plan/tasks.d/new.yaml"],
    readFile: () => `- id: ${prId}\n` }).ok, false);
  assert.equal(worker.evaluateWorkerBranchShape({ ...input, addedFiles: ["plan/tasks.d/new.yaml"],
    readFile: () => `- id: ${filedId}\n` }).ok, false);
  for (const id of ["PR-0", "PR-01", "PR-text", "SBX-42", "W1-T100"]) {
    assert.equal(worker.evaluateWorkerBranchShape({ ...input, commitMessages: `Remudero-Task: ${id}\n` }).ok, false, id);
  }
  assert.equal(worker.evaluateWorkerBranchShape({ ...input, declaredTaskIdsComplete: undefined }).ok, false);
});

test("unreadable or malformed plan evidence cannot prove a PR number is ad-hoc", (t) => {
  for (const defect of ["missing-root", "root-is-directory", "missing-shards", "shard-is-directory", "invalid-yaml", "invalid-list", "missing-id"]) {
    const f = fixture(t);
    const plan = join(f.path, "plan", "tasks.yaml"), shards = join(f.path, "plan", "tasks.d");
    if (defect === "missing-root" || defect === "root-is-directory") rmSync(plan);
    if (defect === "root-is-directory") mkdirSync(plan);
    if (defect === "missing-shards") rmSync(shards, { recursive: true });
    if (defect === "shard-is-directory") mkdirSync(join(shards, "unreadable.yaml"));
    if (defect === "invalid-yaml") writeFileSync(plan, "[unterminated\n");
    if (defect === "invalid-list") writeFileSync(plan, "tasks: []\n");
    if (defect === "missing-id") writeFileSync(plan, "- title: missing id\n");
    assert.equal(worker.inspectDeclaredTaskIds(f.path).complete, false, defect);
    const result = cli(workerScript, f.path, f.base);
    assert.equal(result.status, 1, defect + result.stdout + result.stderr);
    assert.match(result.stderr, /REFUSED.*PR-10450/);
  }
});
