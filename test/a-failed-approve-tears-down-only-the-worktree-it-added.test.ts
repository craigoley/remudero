// test/a-failed-approve-tears-down-only-the-worktree-it-added.test.ts — W1-T9153: on 2026-10-13 two fleet
// approves of one open plan PR met at ONE path, worktrees/<that PR's branch>, four times in thirteen minutes.
// The later run's `addLockedRunWorktree` overwrote the live holder's run lock, its add then failed (`a branch
// named ... already exists`), it removed the lock it had just overwritten, and `approveCommand`'s catch ran
// `git worktree remove --force` on the path it had set BEFORE the add. The holder's next `git -C` died with
// "cannot change to ...: No such file or directory".
//
// EVERYTHING HERE IS REAL: a bare fixture origin, a managed clone, real `git worktree add`, and in the
// concurrency test a SECOND PROCESS that holds the path with the real `addLockedRunWorktree` and is still
// standing in its worktree when the in-process approve tries the same path.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { approveRunBranch } from "#src/lib/inbox.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { addLockedRunWorktree, addLockedRunWorktreeAsync, approveCommand } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Row = Record<string, unknown>;
const noLog = (): void => {};

const SAVED = { HOME: process.env.HOME, PATH: process.env.PATH };
afterEach(() => {
  process.env.HOME = SAVED.HOME;
  process.env.PATH = SAVED.PATH;
});

/** A bare origin with one seed commit, and a managed clone of it at `<root>/repos/<this repo's name>` — the
 *  directory `approveCommand` derives from the checkout's own remote. */
function managedFixture(kind: string, seed: (dir: string) => void = () => {}) {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seedRepo = gitRepo({ kind: `${kind}-seed` });
  seed(seedRepo.dir);
  seedRepo.git("add", "-A");
  seedRepo.git("commit", "--quiet", "--allow-empty", "-m", "chore: seed");
  seedRepo.addRemote("origin", origin.dir);
  seedRepo.git("push", "--quiet", "origin", "main");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-root-`));
  const remoteUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const repoDir = join(root, "repos", remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]!);
  mkdirSync(dirname(repoDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email]);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  return { root, repoDir, scratch, worktreesRoot: join(root, "worktrees") };
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid!;
}

const headOf = (dir: string): string => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("W1-T9153: an add at a live-held path refuses and keeps the holder", async () => {
  const fx = managedFixture("t9153-held");
  for (const [form, add] of [
    ["sync", async (path: string, branch: string, runId: string) => addLockedRunWorktree(fx.repoDir, path, branch, "origin/main", runId, noLog)],
    ["async", (path: string, branch: string, runId: string) => addLockedRunWorktreeAsync(fx.repoDir, path, branch, "origin/main", runId, noLog)],
  ] as const) {
    const branch = `run-APPROVE-P-T9153-HELD-${form}`;
    const path = join(fx.worktreesRoot, branch);
    // The holder: its tree on its branch, and a lock naming a LIVE pid that is not this process (our parent).
    execFileSync("git", ["-C", fx.repoDir, "worktree", "add", "--quiet", "-b", branch, path, "origin/main"]);
    const holderLock = JSON.stringify({ pid: process.ppid, run_id: `APPROVE-P-T9153-HOLDER-${form}`, startedAt: new Date().toISOString() });
    writeFileSync(`${path}.lock`, holderLock);
    await assert.rejects(
      () => add(path, branch, `APPROVE-P-T9153-LOSER-${form}`),
      (e: Error) => {
        assert.equal(e.name, "RunWorktreeHeldError", `${form}: a typed refusal, not git's own failure: ${e.message}`);
        assert.ok(e.message.includes(path), `${form}: the refusal names the path: ${e.message}`);
        assert.ok(e.message.includes(String(process.ppid)), `${form}: the refusal names the holder's pid: ${e.message}`);
        assert.ok(e.message.includes(`APPROVE-P-T9153-HOLDER-${form}`), `${form}: the refusal names the holder's run_id: ${e.message}`);
        return true;
      },
    );
    assert.equal(readFileSync(`${path}.lock`, "utf8"), holderLock, `${form}: the holder's lock is byte-for-byte untouched`);
    assert.ok(existsSync(join(path, ".git")), `${form}: the holder's worktree is still there`);
    assert.equal(headOf(path), headOf(fx.repoDir), `${form}: the holder can still run git in its tree`);
  }
});

test("W1-T9153: a dead holder lock is reclaimed and the add succeeds", async () => {
  const fx = managedFixture("t9153-dead");
  for (const [form, add] of [
    ["sync", async (path: string, branch: string, runId: string) => addLockedRunWorktree(fx.repoDir, path, branch, "origin/main", runId, noLog)],
    ["async", (path: string, branch: string, runId: string) => addLockedRunWorktreeAsync(fx.repoDir, path, branch, "origin/main", runId, noLog)],
  ] as const) {
    const branch = `run-APPROVE-P-T9153-DEAD-${form}`;
    const path = join(fx.worktreesRoot, branch);
    mkdirSync(path, { recursive: true });
    // A widowed lock from a run that died: its pid is gone.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: deadPid(), run_id: `APPROVE-P-T9153-DIED-${form}`, startedAt: new Date().toISOString() }));
    await add(path, branch, `APPROVE-P-T9153-NEXT-${form}`);
    assert.ok(existsSync(join(path, ".git")), `${form}: the add went through`);
    const lock = JSON.parse(readFileSync(`${path}.lock`, "utf8")) as Row;
    assert.equal(lock.pid, process.pid, `${form}: the lock is now this run's`);
    assert.equal(lock.run_id, `APPROVE-P-T9153-NEXT-${form}`);
  }
  // An unparseable lock is reclaimed the same way: no live holder can be named from it.
  const branch = "run-APPROVE-P-T9153-GARBLED";
  const path = join(fx.worktreesRoot, branch);
  mkdirSync(path, { recursive: true });
  writeFileSync(`${path}.lock`, "{ not json");
  addLockedRunWorktree(fx.repoDir, path, branch, "origin/main", "APPROVE-P-T9153-AFTER-GARBLE", noLog);
  assert.equal((JSON.parse(readFileSync(`${path}.lock`, "utf8")) as Row).run_id, "APPROVE-P-T9153-AFTER-GARBLE");
});

const OWN_PR_URL = "https://github.com/craigoley/remudero/pull/9153";

/** An offline `rmd approve <id>` world whose ledger names a PRIOR run of `id` that pushed its branch: the approve
 *  resumes that branch. W1-T9161: a resume cuts its OWN tree, `worktrees/<approveRunBranch(its run id)>`, so the run
 *  id is pinned (`Date.now` during `run`) and `path` is that tree's: anything this approve did not add that sits there
 *  meets its add. */
function resumableApprove(kind: string, id: string) {
  const fx = managedFixture(kind, (dir) => {
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(
      join(dir, "plan", "tasks.yaml"),
      "- id: W1-T4\n  title: \"a seed task\"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n",
    );
    writeFileSync(join(dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  });
  const priorRunId = `APPROVE-${id}-1791000000000`;
  const branch = approveRunBranch(priorRunId);
  execFileSync("git", ["-C", fx.repoDir, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  execFileSync("git", ["-C", fx.repoDir, "fetch", "--quiet", "origin"]);
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9153-home-`));
  const config = { claudeBin: "/usr/bin/true", root: fx.root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(fx.root, "state"), { recursive: true });
  const ledgerPath = join(fx.root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ run_id: priorRunId, task_id: id, step: "approve.start" }) + "\n");
  writeFileSync(join(fx.root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id, summary: `ratify ${id}`, evidenceAnchors: [] }] }));
  writeFileSync(
    join(fx.root, "state", "inbox-drafts.json"),
    JSON.stringify({
      [id]: {
        proposalId: id,
        fragmentYaml: "- id: NEW-1\n  title: a quiet zebra crossing\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n",
        stampLine: `- ${id} (plan) — RATIFIED -> NEW-1.`,
        anchorFingerprint: "",
      },
    }),
  );
  const shim = ghShim(
    [
      { when: "--method POST", stdout: JSON.stringify({ html_url: OWN_PR_URL, number: 9153 }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: "main" }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
      { when: "pulls?", stdout: "[]" },
    ],
    { kind: "t9153-gh" },
  );
  const pinnedMs = Date.now();
  const path = join(fx.worktreesRoot, approveRunBranch(`APPROVE-${id}-${pinnedMs}`));
  /** Run the approve in THIS process; what it throws is not under test, what it leaves behind is. */
  const run = async (): Promise<Row[]> => {
    process.env.HOME = home;
    process.env.PATH = `${shim.dir}:${SAVED.PATH}`;
    const now = mock.method(Date, "now", () => pinnedMs);
    try {
      await withLiveWritesAllowed(() => approveCommand([id], { config: config as never })).catch(() => undefined);
    } finally {
      now.mock.restore();
      process.env.HOME = SAVED.HOME;
      process.env.PATH = SAVED.PATH;
    }
    return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  };
  return { fx, branch, path, run };
}

/** The first approve, in its OWN process: it adds `path` through the real `addLockedRunWorktree`, stands in it,
 *  says so, and waits on stdin. Told to go on, it runs git from where it stands and reports. */
const HOLDER_SCRIPT = `
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
const [repoDir, path, branch, runId, runTaskUrl] = process.argv.slice(2);
const { addLockedRunWorktree } = await import(runTaskUrl);
addLockedRunWorktree(repoDir, path, branch, "origin/" + branch, runId, () => {});
process.chdir(path);
console.log("HOLDER-READY");
const lines = createInterface({ input: process.stdin });
for await (const _line of lines) break;
let report;
try {
  report = { ok: true, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
} catch (e) {
  report = { ok: false, error: String(e.stderr || e.message) };
}
console.log("HOLDER-REPORT " + JSON.stringify(report));
process.exit(0);
`;

test("W1-T9153: two concurrent approves on one path and neither loses its cwd", async () => {
  const { fx, branch, path, run } = resumableApprove("t9153-two", "P-T9153-TWO");
  const script = join(fx.scratch, "holder.mjs");
  writeFileSync(script, HOLDER_SCRIPT);
  // A child's coverage profile of the tmp script outlives the dir and empties the suite's lcov. Node copies
  // NODE_V8_COVERAGE back into any env object a spawn is handed, so it is unset by `env -u`, which execs node in place:
  // the holder's pid is the spawned pid.
  const holderRunId = "APPROVE-P-T9153-TWO-1791000000001";
  const holder = spawn(
    "env",
    ["-u", "NODE_TEST_CONTEXT", "-u", "NODE_OPTIONS", "-u", "NODE_V8_COVERAGE", process.execPath, "--import", import.meta.resolve("tsx"),
      script, fx.repoDir, path, branch, holderRunId, new URL("../src/run-task.ts", import.meta.url).href],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  holder.stderr.on("data", (chunk) => void (stderr += String(chunk)));
  // git's own checkout chatter shares the holder's stdout, so read to the marker lines.
  const out = createInterface({ input: holder.stdout })[Symbol.asyncIterator]();
  const nextMarked = async (marker: string): Promise<string | undefined> => {
    for (let line = await out.next(); !line.done; line = await out.next()) if (line.value.startsWith(marker)) return line.value.slice(marker.length);
    return undefined;
  };
  try {
    assert.equal(await nextMarked("HOLDER-READY"), "", `the first approve added and stands in its worktree; stderr: ${stderr}`);
    const rows = await run();
    assert.ok(existsSync(join(path, ".git")), "the first approve's worktree is still there");
    const lock = JSON.parse(readFileSync(`${path}.lock`, "utf8")) as Row;
    assert.equal(lock.pid, holder.pid, "the first approve still holds its run lock");
    assert.equal(lock.run_id, holderRunId);
    const error = rows.find((row) => row.step === "approve.error");
    assert.ok(error, "the second approve stopped with an approve.error row");
    const text = String(error.error);
    assert.ok(text.includes(String(holder.pid)) && text.includes(holderRunId), `the row names the holder's pid and run_id: ${text}`);
  } finally {
    holder.stdin.end("go\n");
  }
  const report = JSON.parse((await nextMarked("HOLDER-REPORT ")) ?? `{"ok":false,"error":"no report; stderr: ${stderr.length}B"}`) as {
    ok: boolean; head?: string; error?: string;
  };
  assert.equal(report.ok, true, `the first approve can still run git where it stands: ${report.error}`);
  assert.equal(report.head, headOf(fx.repoDir));
});

test("W1-T9153: an approve whose add threw removes nothing", async () => {
  const { fx, branch, path, run } = resumableApprove("t9153-threw", "P-T9153-THREW");
  // A tree this approve did not add, on the branch it resumes: its own add can only fail here.
  execFileSync("git", ["-C", fx.repoDir, "worktree", "add", "--quiet", "-b", branch, path, `origin/${branch}`]);
  const rows = await run();
  assert.ok(rows.find((row) => row.step === "approve.error"), "the add failed and the approve stopped");
  assert.ok(existsSync(join(path, ".git")), "the catch removed no worktree it had not added");
  assert.equal(headOf(path), headOf(fx.repoDir));
  assert.equal(existsSync(`${path}.lock`), false, "the lock this run claimed for its failed add is released");
});
