import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { doctorCommand, type DoctorDeps } from "../src/lib/report-commands.js";
import { selectOpenWeightUnitTestSuites, spawnCodexWorker } from "../src/lib/worker-provider.js";
import { gitRepo } from "./helpers/git-repo.js";

const RUN = "W1-T6134-1";

function lane() {
  const repo = gitRepo({ kind: "provider-doctor-leaf" });
  for (const dir of ["src", "test", "scripts"]) mkdirSync(join(repo.dir, dir));
  writeFileSync(join(repo.dir, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
  writeFileSync(join(repo.dir, "test", "alpha.test.ts"), 'import { alpha } from "../src/alpha.js"; void alpha;\n');
  writeFileSync(join(repo.dir, "test", "beta.test.ts"), "export {};\n");
  writeFileSync(join(repo.dir, "scripts", "diff-class.mjs"), "// fixture selector marker\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "fixture base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const base = repo.git("rev-parse", "HEAD");
  const wt = repo.addWorktree(join(repo.dir, "worktrees", `run-${RUN}`), `run-${RUN}`);
  const gitdir = wt.git("rev-parse", "--absolute-git-dir");
  writeFileSync(`${wt.dir}.base`, `${base}\ngitdir: ${gitdir}\n`);
  return { repo, wt, base };
}

function plant(wt: string) {
  const repo = gitRepo({ kind: "provider-doctor-planted", cloneFrom: wt });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const planted = join(wt, "planted");
  renameSync(repo.dir, planted);
  const marker = join(wt, "fsmonitor-fired");
  const hook = join(planted, "fsmonitor");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(planted, ".git", "config"),
    `[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = ${hook}\n`);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(planted, ".git")}\n`);
  return marker;
}

async function codexArgs(root: string, cwd: string): Promise<string[]> {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  let argv: string[] | undefined;
  const result = spawnCodexWorker({
    workerHome: join(root, "worker-home"), cwd, prompt: "fixture", tools: ["Read", "Bash"],
    settingsFile: join(process.cwd(), "settings", "worker.json"),
    containment: {
      spawn: (opts) => { argv = opts.args; return { process: child as never, pid: 31634 }; },
      teardown: () => {},
    },
  }, {
    root, claudeBin: "/unused/claude",
    workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna" },
  });
  stdout.end(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
  queueMicrotask(() => child.emit("exit", 0));
  await result;
  assert.ok(argv, "the fixture reached the Codex spawn");
  return argv;
}

async function doctor(root: string, overrides: Partial<DoctorDeps> = {}): Promise<string> {
  const output: string[] = [];
  await doctorCommand([], {
    repoRoot: root, loadConfig: () => ({ root, claudeBin: "/unused/claude" }),
    out: (line) => output.push(line), err: (line) => output.push(line),
    readLedgerLines: () => [], liveInflightRuns: () => [{ taskId: "W1-T6134", runId: RUN, pid: 1 }],
    readLockFiles: () => ({ locks: [] }), readGitLocks: () => [],
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 0 }),
    readWorkerProcesses: () => ({ count: 0, processes: [] }),
    readDiskFreeBytes: () => 40 * 1024 ** 3, readDiskTotalBytes: () => 100 * 1024 ** 3,
    readPauseAgeMs: () => undefined, readCheckoutDepth: () => ({ shallow: false, commitCount: 1000 }),
    readNvmrcVersion: () => process.versions.node, readCaptureSurfaceFireHistory: () => [],
    ...overrides,
  });
  const row = output.join("\n").split("\n").find((line) => /^\s+\[.*\] worktree-base\s/.test(line));
  assert.ok(row, "doctor renders its worktree-base observation");
  return row;
}

describe("test/worker-provider-and-doctor-git-calls-into-a-worktree-go-through-the-leaf.test.ts", () => {
  it("positive control: the planted pointer executes its fsmonitor on a raw diff", () => {
    const { wt } = lane();
    const marker = plant(wt.dir);
    wt.git("diff", "--name-only", "HEAD");
    assert.equal(existsSync(marker), true);
  });

  it("the Codex membership probe refuses a planted pointer", async () => {
    const { repo, wt } = lane();
    const marker = plant(wt.dir);
    assert.equal((await codexArgs(repo.dir, wt.dir)).includes("--skip-git-repo-check"), true);
    assert.equal(existsSync(marker), false);
  });

  it("the selector's default git spawn refuses a planted pointer before reading its diff", () => {
    const { wt } = lane();
    const marker = plant(wt.dir);
    const selection = selectOpenWeightUnitTestSuites(wt.dir);
    assert.equal(selection.fullRun, true);
    assert.match(selection.reasons.join("\n"), /worktree-git: refusing.*pointer/);
    assert.equal(existsSync(marker), false);
  });

  it("both doctor worktree readers report a refused pointer as base-unknown", async () => {
    const { repo, wt, base } = lane();
    wt.git("commit", "-q", "--allow-empty", "-m", "own commit");
    const head = wt.git("rev-parse", "HEAD");
    const marker = plant(wt.dir);
    const headReading = await doctor(repo.dir, { isWorktreeBaseAncestor: () => true });
    const bothReadings = await doctor(repo.dir);
    const ancestryReading = await doctor(repo.dir, { readWorktreeHead: () => head, readWorktreeBase: () => base });
    assert.match(headReading, /base-unknown/);
    assert.doesNotMatch(headReading, /unrelated/);
    assert.match(bothReadings, /base-unknown/);
    assert.match(ancestryReading, /base-unknown/);
    assert.doesNotMatch(ancestryReading, /unrelated/);
    assert.equal(existsSync(marker), false);
  });

  it("intact worktrees retain membership, affected-suite selection and doctor ancestry outcomes", async () => {
    const { repo, wt, base } = lane();
    assert.equal((await codexArgs(repo.dir, wt.dir)).includes("--skip-git-repo-check"), false);
    assert.match(await doctor(repo.dir), /at-base/);
    writeFileSync(join(wt.dir, "src", "alpha.ts"), "export function alpha() { return 2; }\n");
    const selection = selectOpenWeightUnitTestSuites(wt.dir);
    assert.equal(selection.fullRun, false, selection.reasons.join("\n"));
    assert.deepEqual(selection.narrow, ["test/alpha.test.ts"]);
    writeFileSync(join(wt.dir, "src", "alpha.ts"),
      "export function alpha() { return 2; }\nexport function orphan() { return 3; }\n");
    const noSymbolHit = selectOpenWeightUnitTestSuites(wt.dir);
    assert.equal(noSymbolHit.fullRun, false, noSymbolHit.reasons.join("\n"));
    assert.deepEqual(noSymbolHit.narrow, ["test/alpha.test.ts"]);
    wt.git("commit", "-q", "--allow-empty", "-m", "own commit");
    assert.match(await doctor(repo.dir), /own-commits/);
    repo.git("commit", "-q", "--allow-empty", "-m", "other branch");
    assert.match(await doctor(repo.dir, { readWorktreeBase: () => repo.git("rev-parse", "HEAD") }), /unrelated/);
    assert.match(await doctor(repo.dir, { readWorktreeBase: () => "bad-revision" }), /base-unknown/);
    assert.match(await doctor(repo.dir, { readWorktreeBase: () => null }), /base-unknown/);
    assert.notEqual(wt.git("rev-parse", "HEAD"), base);
  });

  it("git command failures retain their exit status and reason through the default spawn", () => {
    const { repo, wt } = lane();
    repo.git("update-ref", "-d", "refs/remotes/origin/main");
    const selection = selectOpenWeightUnitTestSuites(wt.dir);
    assert.equal(selection.fullRun, true);
    assert.match(selection.reasons.join("\n"), /git merge-base origin\/main HEAD exited 128: fatal:/);
  });
});
