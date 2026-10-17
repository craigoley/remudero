import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

/**
 * W1-T9410. OBSERVED 2026-10-14 on host remudero: the watchdog's STALLED recycle proved the core
 * daemon frozen (W1-T6597), printed "RECLAIMING .../inflight/W1-T7898.lock", and died there with
 * rc=2. Its `.reason` file stopped after the "holder:" line, the lock was never moved, and the
 * recycle's PAUSE stayed on disk. Every worktree under the state dir's `worktrees/` pointed at a
 * git admin dir that had been pruned, so `holder_worktrees` ran `sed` on a gitdir HEAD that did not
 * exist, and under `set -euo pipefail` that unguarded assignment ended the whole script.
 *
 * This suite drives the REAL script with the stub-docker fixture of
 * test/a-stall-recycle-reclaims-only-what-a-frozen-daemon-holds.test.ts (test (i)), plus worktrees
 * whose admin dir is missing or has no HEAD.
 *
 * WHICH `sed`: the script runs whatever `sed` is first on PATH, as the host does. GNU sed (the
 * host, CI) exits 2 on a missing input file and BSD sed (macOS) exits 1. Either non-zero status is
 * enough to trip `set -e`, so the defect is reachable on both. The suite does not shim `sed`,
 * because a shim would replace the very binary under test. Instead `sedFailsOnAMissingFile` runs
 * the SAME PATH's sed on a missing file and asserts it fails. If a host's sed ever exited 0 there,
 * that control fails loudly instead of letting the suite pass without reaching the abort path.
 */

const REPO_ROOT = findRepoRoot();
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

const DAEMON_HOST = "2ca2ffc969af";
const TARGET_ID = `${DAEMON_HOST}${"0".repeat(52)}`;
const DAEMON_PID = 110;
const CHILD_PID = 4321;
const BRANCH = "run-unfiled-1791423000000";
const LOCK_NAME = `fix-branch--craigoley--remudero--${BRANCH}.lock`;
const WORKTREE_NAME = "sweep-unfiled-1791423000000";
/** The incident's own lock: a task lock, matched to its worktree by NAME, not by ref. */
const TASK_LOCK_NAME = "W1-T7898.lock";
const TASK_WORKTREE_NAME = "run-W1-T7898-1791900000000";
/** A worktree whose admin dir is gone entirely, as all six on the host were. */
const STRAY_NO_ADMIN_DIR = "plan-garden-1790850882168";
/** A worktree whose admin dir survives with no HEAD in it. */
const STRAY_NO_HEAD = "sweep-W1-T5-1790850882169";
const CONTAINER_GITDIR = "/home/node/Remudero/repos/remudero/.git/worktrees";

interface Call {
  bin: string;
  argv: string[];
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  calls: Call[];
}

const DECLARED_RUNTIME_ENV_LINES = [
  "GH_TOKEN=captured-token-value",
  "RMD_RESTART_THROTTLE_S=300",
  "RMD_FRESHNESS_RESTART_MAX=100",
  "GH_APP_ID=app-id-fixture",
  "GH_APP_INSTALLATION_ID=install-id-fixture",
  "GH_APP_PRIVATE_KEY_PATH=/path/to/key.pem",
];

/** The `docker` stub of the W1-T6597 suite: the target is RUNNING and every /proc probe is PRESENT. */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then echo "sha256:PULLEDID"; exit 0; fi',
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    case "$fmt" in',
    `      "{{.Id}}") echo "${TARGET_ID}"; exit 0 ;;`,
    '      "{{.State.Running}}") echo "true"; exit 0 ;;',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    "      *Config.Env*)",
    ...DECLARED_RUNTIME_ENV_LINES.map((l) => `        echo "${l}"`),
    '        echo ""',
    "        exit 0 ;;",
    "      *Mounts*)",
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        codex="${RMD_CODEX_DIR:-$HOME/.codex}"; [ ! -d "$codex" ] || printf "%s\\t/home/node/.codex\\ttrue\\n" "$codex"',
    '        config="${RMD_CONTAINER_CONFIG_DIR:-$HOME/.config/remudero-container}"; [ ! -d "$config" ] || printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$config"',
    "        exit 0 ;;",
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec)",
    "    shift 2",
    '    if [ "$1" = "ps" ]; then',
    '      case "$3" in',
    '        pid,etimes,args) cat "$STUB_REC/ps-workers" 2>/dev/null ;;',
    '        pid,ppid) cat "$STUB_REC/ps-ppid" 2>/dev/null ;;',
    "      esac",
    "      exit 0",
    "    fi",
    '    if [ "$1" = "sh" ]; then echo PRESENT; exit 0; fi',
    "    exit 0 ;;",
    "  stop|rm|run|container) exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

interface Fleet {
  state: string;
  lockPath: string;
  taskLockPath: string;
  worktree: string;
  taskWorktree: string;
}

/** A worktree directory whose `.git` file names `${CONTAINER_GITDIR}/<name>`, in the container's view. */
function placeWorkdir(state: string, name: string, head: string | undefined, adminDir = true): string {
  const wt = join(state, "worktrees", name);
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${CONTAINER_GITDIR}/${name}\n`);
  const admin = join(state, "repos", "remudero", ".git", "worktrees", name);
  if (adminDir) mkdirSync(admin, { recursive: true });
  if (head !== undefined) writeFileSync(join(admin, "HEAD"), head);
  return wt;
}

/**
 * Test (i)'s fleet: drain.lock and the fix claim both name {pid 110, host 2ca2ffc969af}, pid 110's
 * newest ledger row is 40 min old (past the 30-min stall bound). `strays` adds the two worktrees
 * whose admin dir is gone or has no HEAD; `taskLock` adds the incident's task lock and its run-
 * worktree, whose admin dir is also gone.
 */
function fleet(opts: { strays: boolean; taskLock: boolean }): Fleet {
  const state = mkdtempSync(join(tmpdir(), "rmd-noadmin-state-"));
  const stateSub = join(state, "state");
  const inflight = join(stateSub, "inflight");
  mkdirSync(inflight, { recursive: true });
  const holder = { pid: DAEMON_PID, host: DAEMON_HOST, startedAt: isoAgo(240 * MIN) };
  writeFileSync(join(stateSub, "drain.lock"), JSON.stringify(holder));
  const lockPath = join(inflight, LOCK_NAME);
  writeFileSync(lockPath, JSON.stringify({ ...holder, run_id: "sweep-1791423000000", startedAt: isoAgo(120 * MIN) }));
  const taskLockPath = join(inflight, TASK_LOCK_NAME);

  const worktree = placeWorkdir(state, WORKTREE_NAME, `ref: refs/heads/${BRANCH}\n`);
  writeFileSync(join(worktree, "half-merged.ts"), "<<<<<<< ours\n");
  placeWorkdir(state, "run-W1-T1-1791000000000", "ref: refs/heads/run-W1-T1-1791000000000\n");
  if (opts.strays) {
    placeWorkdir(state, STRAY_NO_ADMIN_DIR, undefined, false);
    placeWorkdir(state, STRAY_NO_HEAD, undefined, true);
  }
  let taskWorktree = "";
  if (opts.taskLock) {
    writeFileSync(taskLockPath, JSON.stringify({ ...holder, run_id: "run-W1-T7898", startedAt: isoAgo(100 * MIN) }));
    taskWorktree = placeWorkdir(state, TASK_WORKTREE_NAME, undefined, false);
  }

  const rows = [
    { ts: isoAgo(90 * MIN), host: DAEMON_HOST, actor_pid: 999, step: "sweep.pass" },
    { ts: isoAgo(40 * MIN), host: DAEMON_HOST, actor_pid: DAEMON_PID, step: "daemon.pulse" },
    { ts: isoAgo(10 * MIN), host: DAEMON_HOST, actor_pid: 1110, step: "worker.state" },
    { ts: isoAgo(1 * MIN), host: "f00dfeedbeef", actor_pid: 4242, step: "serve.alive" },
  ];
  writeFileSync(join(stateSub, "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { state, lockPath, taskLockPath, worktree, taskWorktree };
}

function recycleEnv(f: Fleet, dir: string, rec: string): NodeJS.ProcessEnv {
  const cashKeyPath = join(rec, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-cash-key\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    RMD_STATE_DIR: f.state,
    RMD_RECYCLE_WAIT_S: "20",
    RMD_RECYCLE_POLL_S: "1",
    RMD_RECYCLE_FIRST_BOOT: "1",
    GH_TOKEN: "",
    RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
    RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "noadmin-test-no-such-dockerenv-marker"),
    RMD_RECYCLE_VERDICT: "STALLED progressAgeMs=2400000",
  };
  delete env.RMD_RECYCLE_STALL_BOUND_S;
  return env;
}

function runRecycle(f: Fleet): Run {
  const dir = mkdtempSync(join(tmpdir(), "rmd-noadmin-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "rmd-noadmin-rec-"));
  writeStubs(dir);
  writeFileSync(join(rec, "ps-workers"), `${CHILD_PID} 2000 claude --output-format stream-json --verbose\n`);
  writeFileSync(join(rec, "ps-ppid"), `1 0\n${DAEMON_PID} 1\n${CHILD_PID} ${DAEMON_PID}\n`);
  const env = recycleEnv(f, dir, rec);
  sedFailsOnAMissingFile(env, f.state);
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", cwd: REPO_ROOT, env });
  let calls: Call[] = [];
  try {
    calls = readFileSync(join(rec, "calls"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [bin, ...argv] = l.split("\t");
        return { bin, argv };
      });
  } catch {
    calls = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls };
}

/**
 * The positive control for the platform: the `sed` this PATH resolves (the one the script will
 * run) exits non-zero on a missing input file, GNU with 2 and BSD with 1. Without that, a run that
 * survives the stray worktree would prove nothing about the abort path.
 */
function sedFailsOnAMissingFile(env: NodeJS.ProcessEnv, state: string): void {
  const probe = spawnSync("sed", ["-n", "p", join(state, "no-such-admin-dir", "HEAD")], { encoding: "utf8", env });
  assert.notEqual(probe.status, 0, `this host's sed must fail on a missing file, or the abort path is unreachable: ${probe.stderr}`);
}

/** The lock's moved copy and its reason, read from inflight/reclaimed. */
function reclaimed(f: Fleet, lockName: string): { moved: string[]; reason: string; partials: string[] } {
  const dir = join(f.state, "state", "inflight", "reclaimed");
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const moved = names.filter((n) => n.startsWith(lockName) && /\.recycle-\d+$/.test(n));
  const partials = names.filter((n) => n.startsWith(lockName) && !/\.recycle-\d+(\.reason)?$/.test(n));
  const reasonPath = moved.length === 1 ? join(dir, `${moved[0]}.reason`) : "";
  const reason = reasonPath && existsSync(reasonPath) ? readFileSync(reasonPath, "utf8") : "";
  return { moved, reason, partials };
}

test("W1-T9410: a worktree with no git admin dir does not abort the frozen-daemon reclaim", () => {
  const f = fleet({ strays: true, taskLock: false });
  const run = runRecycle(f);

  assert.equal(run.status, 0, `a stray worktree must not end the STALLED recycle:\n${run.stderr}`);
  assert.match(run.stderr, /RECLAIMING .*fix-branch--craigoley--remudero--run-unfiled-1791423000000\.lock/);
  assert.ok(!existsSync(f.lockPath), "the frozen daemon's lock leaves the blocking set");
  const { moved, reason, partials } = reclaimed(f, LOCK_NAME);
  assert.equal(moved.length, 1, "the lock is MOVED into inflight/reclaimed");
  assert.match(reason, /^kept: worktrees, worker homes and logs are untouched/m, `the reason file is written in full:\n${reason}`);
  assert.deepEqual(partials, [], "no half-written reason is left beside the moved lock");
  assert.match(run.stdout, /no in-flight workers — safe to proceed/);
  assert.ok(run.calls.some((c) => c.bin === "docker" && c.argv[0] === "stop"), "the recycle goes on to stop the frozen container");
  assert.ok(run.calls.some((c) => c.bin === "docker" && c.argv[0] === "run"), "a replacement starts");
  assert.ok(!existsSync(join(f.state, "state", "PAUSE")), "the recycle's own PAUSE does not outlive it");
  assert.ok(existsSync(join(f.state, "worktrees", STRAY_NO_ADMIN_DIR, ".git")), "the stray worktree is kept, never touched");
});

test("W1-T9410: the reason file still names the holder worktree beside a stray one", () => {
  const f = fleet({ strays: true, taskLock: true });
  const run = runRecycle(f);

  assert.equal(run.status, 0, `the STALLED recycle completes:\n${run.stderr}`);
  const fix = reclaimed(f, LOCK_NAME);
  assert.equal(fix.moved.length, 1, "the fix claim is moved");
  const fixWorktrees = fix.reason.split("\n").filter((l) => l.startsWith("worktree: "));
  assert.deepEqual(fixWorktrees, [`worktree: ${f.worktree}`], `only the branch's own worktree is named:\n${fix.reason}`);

  // The incident's lock: a task lock whose run- worktree lost its admin dir too. The match is by
  // name, so the worktree is still named — its files are what an operator recovers the work from.
  assert.ok(!existsSync(f.taskLockPath), "the frozen daemon's task lock is moved too");
  const task = reclaimed(f, TASK_LOCK_NAME);
  assert.equal(task.moved.length, 1, "the task lock is moved");
  const taskWorktrees = task.reason.split("\n").filter((l) => l.startsWith("worktree: "));
  assert.deepEqual(taskWorktrees, [`worktree: ${f.taskWorktree}`], `the task's run- worktree is named:\n${task.reason}`);
  for (const r of [fix.reason, task.reason]) {
    assert.ok(!r.includes(STRAY_NO_ADMIN_DIR) && !r.includes(STRAY_NO_HEAD), `a stray worktree is never named:\n${r}`);
    assert.match(r, /^kept: /m, "each reason file is complete");
  }
});
