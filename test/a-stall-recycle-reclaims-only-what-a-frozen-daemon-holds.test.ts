import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STALL_RECYCLE_AFTER_MS } from "../src/lib/progress-watchdog.js";

/**
 * W1-T6597. OBSERVED 2026-10-08: the core daemon (in-container pid 110, container 2ca2ffc969af)
 * wedged at 18:27:11Z in a pure compute loop. The progress watchdog named it STALLED and ran
 * deploy/recycle-container.sh twice; both runs waited 3000s and refused on "1 lane-holding and 1
 * lane-less worker(s) still in flight". The lock was the wedged daemon's OWN fix claim ({pid 110,
 * host 2ca2ffc969af}) and the lane-less worker its own idle CI-JUDGE child — and both existing
 * reclaims (W1-T2556: container gone; W1-T3611: pid gone) need a DEAD holder, while pid 110 was
 * alive and spinning.
 *
 * This suite drives the REAL script with a stubbed `docker` on PATH (the technique
 * test/a-lock-whose-container-is-gone-is-reclaimed-not-waited-on.test.ts uses), a real ledger on
 * the state dir, and a fake in-container process table, and proves the three cases the task's
 * acceptance names: (i) a STALLED recycle with ownership PROVEN reclaims without the wait and
 * preserves every recovery artifact; (ii) the same lock under a pid that wrote a ledger row inside
 * the bound is waited for and refused; (iii) a recycle with no STALLED verdict behaves as before.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

const DAEMON_HOST = "2ca2ffc969af";
const TARGET_ID = `${DAEMON_HOST}${"0".repeat(52)}`;
const DAEMON_PID = 110;
const CHILD_PID = 4321;
const BRANCH = "run-unfiled-1791423000000";
const LOCK_NAME = `fix-branch--craigoley--remudero--${BRANCH}.lock`;
const WORKTREE_NAME = "sweep-unfiled-1791423000000";

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

/**
 * A `docker` stub. The target container (any name) resolves to TARGET_ID and is RUNNING; its
 * process table is two files the test writes — `ps-workers` (`pid etimes args`, what worker_lines
 * reads) and `ps-ppid` (`pid ppid`); and every `/proc/<pid>` probe answers PRESENT, because the
 * frozen daemon is ALIVE — which is exactly why W1-T3611's dead-pid reclaim can never fire.
 */
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
    // A LIVING daemon, when the test asks for one: every worker census appends a fresh row from it.
    '        pid,etimes,args) [ -z "${STUB_PULSE_LEDGER:-}" ] || printf \'{"ts":"%s","actor_pid":%s,"step":"daemon.pulse"}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$STUB_PULSE_PID" >> "$STUB_PULSE_LEDGER"; cat "$STUB_REC/ps-workers" 2>/dev/null ;;',
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
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

interface Fleet {
  state: string;
  lockPath: string;
  worktree: string;
  workerHome: string;
}

/**
 * The incident's shape, on disk: drain.lock and the fix claim both name {pid 110, host
 * 2ca2ffc969af}; the claim's worktree (checked out at the claimed branch) holds an uncommitted
 * file; a worker home holds a log. `daemonRowAgoMs` is the age of pid 110's NEWEST ledger row
 * (its daemon.pulse); other pids keep writing inside the bound throughout.
 */
function fleet(daemonRowAgoMs: number): Fleet {
  const state = mkdtempSync(join(tmpdir(), "rmd-frozen-state-"));
  const stateSub = join(state, "state");
  const inflight = join(stateSub, "inflight");
  mkdirSync(inflight, { recursive: true });
  const holder = { pid: DAEMON_PID, host: DAEMON_HOST, startedAt: isoAgo(240 * MIN) };
  writeFileSync(join(stateSub, "drain.lock"), JSON.stringify(holder));
  const lockPath = join(inflight, LOCK_NAME);
  writeFileSync(lockPath, JSON.stringify({ ...holder, run_id: "sweep-1791423000000", startedAt: isoAgo(120 * MIN) }));

  const worktree = join(state, "worktrees", WORKTREE_NAME);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: /home/node/Remudero/repos/remudero/.git/worktrees/${WORKTREE_NAME}\n`);
  writeFileSync(join(worktree, "half-merged.ts"), "<<<<<<< ours\n");
  const gitdir = join(state, "repos", "remudero", ".git", "worktrees", WORKTREE_NAME);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${BRANCH}\n`);
  // A second worktree on another branch: never named as this lock's.
  const other = join(state, "worktrees", "run-W1-T1-1791000000000");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, ".git"), "gitdir: /home/node/Remudero/repos/remudero/.git/worktrees/run-W1-T1-1791000000000\n");
  mkdirSync(join(state, "repos", "remudero", ".git", "worktrees", "run-W1-T1-1791000000000"), { recursive: true });
  writeFileSync(join(state, "repos", "remudero", ".git", "worktrees", "run-W1-T1-1791000000000", "HEAD"), "ref: refs/heads/run-W1-T1-1791000000000\n");

  const workerHome = join(state, "worker-homes", "worker-home-fix-1791423000000");
  mkdirSync(workerHome, { recursive: true });
  writeFileSync(join(workerHome, "worker.log"), "fix worker finished 18:27:11Z\n");

  const rows = [
    { ts: isoAgo(90 * MIN), host: DAEMON_HOST, actor_pid: 999, step: "sweep.pass" },
    { ts: isoAgo(daemonRowAgoMs), host: DAEMON_HOST, actor_pid: DAEMON_PID, step: "daemon.pulse" },
    { ts: isoAgo(10 * MIN), host: DAEMON_HOST, actor_pid: 1110, step: "worker.state" },
    { ts: isoAgo(1 * MIN), host: "f00dfeedbeef", actor_pid: 4242, step: "serve.alive" },
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  writeFileSync(join(stateSub, "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { state, lockPath, worktree, workerHome };
}

function runRecycle(f: Fleet, verdict: string | undefined, waitS: number, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "rmd-frozen-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "rmd-frozen-rec-"));
  writeStubs(dir);
  // The daemon's idle CI-JUDGE child: lane-less, 2000s old (under the 7200s hung bound), so it
  // counts as BUSY to the lane-less census unless ownership is proven.
  writeFileSync(join(rec, "ps-workers"), `${CHILD_PID} 2000 claude --output-format stream-json --verbose\n`);
  writeFileSync(join(rec, "ps-ppid"), `1 0\n${DAEMON_PID} 1\n${CHILD_PID} ${DAEMON_PID}\n`);
  const cashKeyPath = join(rec, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-cash-key\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    RMD_STATE_DIR: f.state,
    RMD_RECYCLE_WAIT_S: String(waitS),
    RMD_RECYCLE_POLL_S: "1",
    RMD_RECYCLE_FIRST_BOOT: "1",
    GH_TOKEN: "",
    RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
    RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "frozen-test-no-such-dockerenv-marker"),
  };
  delete env.RMD_RECYCLE_VERDICT;
  delete env.RMD_RECYCLE_STALL_BOUND_S;
  if (verdict !== undefined) env.RMD_RECYCLE_VERDICT = verdict;
  Object.assign(env, extraEnv);
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

const isStop = (c: Call) => c.bin === "docker" && c.argv[0] === "stop";
const isRun = (c: Call) => c.bin === "docker" && c.argv[0] === "run";
const STALLED = "STALLED progressAgeMs=2400000";

test("(i) a STALLED recycle reclaims the frozen daemon's own lock and idle child without the wait, preserving its worktree and worker home", () => {
  // pid 110's newest row is 40 min old — older than the 30-min stall bound.
  const f = fleet(40 * MIN);
  // A wait long enough that a run which DID wait would visibly poll, and would refuse.
  const run = runRecycle(f, STALLED, 20);

  assert.equal(run.status, 0, `the STALLED recycle must proceed on the ownership proof: ${run.stderr}`);
  assert.doesNotMatch(run.stdout, /polling/, "a proven frozen daemon's holdings are never waited on");
  assert.match(run.stdout, /no in-flight workers — safe to proceed/);
  assert.ok(run.calls.some(isStop), "the recycle stops the container through its existing docker stop");
  assert.ok(run.calls.some(isRun), "a replacement starts");

  assert.ok(!existsSync(f.lockPath), "the frozen daemon's lock leaves the blocking set");
  const reclaimedDir = join(f.state, "state", "inflight", "reclaimed");
  const moved = readdirSync(reclaimedDir).filter((n) => n.startsWith(LOCK_NAME) && !n.endsWith(".reason"));
  assert.equal(moved.length, 1, "the lock is MOVED into inflight/reclaimed, never deleted");
  assert.match(readFileSync(join(reclaimedDir, moved[0]!), "utf8"), /"pid":110/, "the moved lock keeps its content");
  const reason = readFileSync(join(reclaimedDir, `${moved[0]}.reason`), "utf8");
  assert.match(reason, /W1-T6597/);
  assert.match(reason, /STALLED progressAgeMs=2400000/, "the reason records the verdict that triggered it");
  assert.ok(reason.includes(`worktree: ${f.worktree}`), `the reason names the holder's worktree:\n${reason}`);
  assert.ok(!reason.includes("run-W1-T1-1791000000000"), "a worktree on another branch is not named");

  assert.ok(existsSync(join(f.worktree, "half-merged.ts")), "the worktree and its uncommitted work are kept");
  assert.ok(existsSync(join(f.workerHome, "worker.log")), "the worker home and its log are kept");
  assert.match(run.stderr, new RegExp(`lane-less child ${CHILD_PID} of frozen daemon pid ${DAEMON_PID}`), "the idle child is named, not silently dropped");
});

test("(ii) the same lock, however old, under a pid with a ledger row inside the bound and a busy worker, is waited for and refused after WAIT_SECONDS", () => {
  // pid 110's newest row (a daemon.pulse) is 2 min inside the verdict's 30-min stall bound —
  // the lock itself is two hours old, and age alone must permit nothing.
  const f = fleet(STALL_RECYCLE_AFTER_MS - 2 * MIN);
  const run = runRecycle(f, STALLED, 2);

  assert.equal(run.status, 1, "a daemon that wrote a row inside the bound is healthy: refuse");
  assert.match(run.stdout, /1 lane-holding \+ 1 lane-less worker\(s\) still in flight, waited 0s\/2s — polling/, "it is waited for");
  assert.match(run.stderr, /REFUSING — 1 lane-holding and 1 lane-less worker\(s\) still in flight after 2s/);
  assert.match(run.stderr, /clause \(b\)/, "the refusal names the ownership clause that failed");
  assert.ok(existsSync(f.lockPath), "the lock is untouched");
  assert.ok(!existsSync(join(f.state, "state", "inflight", "reclaimed")), "nothing is reclaimed");
  assert.equal(run.calls.filter(isStop).length, 0, "the container is not stopped");
});

test("(ii) a lock naming any pid other than the drain.lock holder is untouched under a proven STALLED verdict", () => {
  const f = fleet(40 * MIN);
  writeFileSync(f.lockPath, JSON.stringify({ pid: 222, host: DAEMON_HOST, run_id: "r", startedAt: isoAgo(120 * MIN) }));
  const run = runRecycle(f, STALLED, 2);

  assert.equal(run.status, 1, "another pid's lock is still waited on and refused");
  assert.match(run.stderr, /REFUSING — 1 lane-holding and 0 lane-less worker\(s\)/, "the frozen daemon's child no longer counts; the foreign lock does");
  assert.ok(existsSync(f.lockPath), "a lock naming another pid is never moved");
});

test("(iii) a recycle without a STALLED verdict behaves as before: waited for and refused", () => {
  const f = fleet(40 * MIN);
  const run = runRecycle(f, undefined, 2);

  assert.equal(run.status, 1, "no verdict, no ownership rule");
  assert.match(run.stdout, /polling/);
  assert.match(run.stderr, /REFUSING — 1 lane-holding and 1 lane-less worker\(s\) still in flight after 2s/);
  assert.doesNotMatch(run.stderr + run.stdout, /W1-T6597|frozen daemon/, "the stall rule is silent without a verdict");
  assert.ok(existsSync(f.lockPath), "the lock is untouched");
  assert.equal(run.calls.filter(isStop).length, 0, "the container is not stopped");

  // A verdict that is not STALLED (a deploy or manual run naming something else) is the same.
  const g = fleet(40 * MIN);
  const other = runRecycle(g, "PROGRESSING progressAgeMs=60000", 2);
  assert.equal(other.status, 1);
  assert.ok(existsSync(g.lockPath), "a non-STALLED verdict reclaims nothing");
});

test("(iv) a daemon whose newest row is inside the bound when the drain starts, and which then stays frozen, is recognised on a later poll and its holdings reclaimed", () => {
  // OBSERVED 2026-10-10: the daemon froze at 08:22:50Z; the STALLED recycle checked ONCE at
  // 08:25:14Z (row 2.4 min old), failed clause (b), and then waited the full drain on the frozen
  // daemon's own children without asking again. Scaled down: a 4s bound, the row 1s old at start.
  const f = fleet(1_000);
  const run = runRecycle(f, STALLED, 20, { RMD_RECYCLE_STALL_BOUND_S: "4" });

  assert.equal(run.status, 0, `the proof must be re-evaluated during the wait and pass once the row ages out: ${run.stderr}`);
  assert.match(run.stdout, /1 lane-holding \+ 1 lane-less worker\(s\) still in flight, waited 0s\/20s — polling/, "the first check fails and the drain waits");
  assert.match(run.stderr, /frozen-daemon ownership NOT proven, clause \(b\)/, "the first check names the clause that failed");
  assert.match(run.stderr, /wrote no ledger row in 4s: FROZEN/, "a later poll proves the daemon frozen");
  assert.match(run.stdout, /no in-flight workers — safe to proceed/);
  assert.doesNotMatch(run.stderr, /REFUSING/, "it does not sit out the whole drain");
  assert.ok(!existsSync(f.lockPath), "the frozen daemon's lock leaves the blocking set");
  const reclaimedDir = join(f.state, "state", "inflight", "reclaimed");
  assert.equal(readdirSync(reclaimedDir).filter((n) => n.startsWith(LOCK_NAME) && !n.endsWith(".reason")).length, 1, "moved exactly once, never deleted");
  assert.ok(existsSync(join(f.worktree, "half-merged.ts")), "the worktree is kept");
  assert.equal(run.calls.filter(isStop).length, 1, "the container is stopped through the ordinary path");
});

test("(iv) re-evaluating on each poll never reclaims from a daemon that keeps writing rows through the wait", () => {
  // The same short bound, but the daemon is ALIVE: every worker census the script runs appends a
  // fresh row from pid 110, so each re-check finds a row inside the bound and the wait refuses.
  const f = fleet(1_000);
  const run = runRecycle(f, STALLED, 8, {
    RMD_RECYCLE_STALL_BOUND_S: "3",
    STUB_PULSE_LEDGER: join(f.state, "state", "ledger.ndjson"),
    STUB_PULSE_PID: String(DAEMON_PID),
  });

  assert.equal(run.status, 1, `a living daemon's holdings are waited for and refused: ${run.stderr}`);
  assert.match(run.stderr, /REFUSING — 1 lane-holding and 1 lane-less worker\(s\) still in flight after 8s/);
  assert.doesNotMatch(run.stderr, /FROZEN/, "a daemon writing rows is never proven frozen");
  assert.ok((run.stderr.match(/ownership NOT proven/g) ?? []).length >= 2, `the proof was re-evaluated during the wait, not once:\n${run.stderr}`);
  assert.ok(existsSync(f.lockPath), "the lock is untouched");
  assert.ok(!existsSync(join(f.state, "state", "inflight", "reclaimed")), "nothing is reclaimed");
});

test("the launcher forwards the STALLED verdict and its progress age to the recycle in RMD_RECYCLE_VERDICT", () => {
  // The REAL launcher, rendered by deploy/install-host-units.sh, with a fake rmd (the verdict), a
  // fake docker (the container is running) and a fake recycle-container.sh that records its env.
  const root = mkdtempSync(join(tmpdir(), "rmd-frozen-launcher-"));
  const stateDir = join(root, "state-root");
  const stub = join(root, "stubbin");
  const daemonTree = join(stateDir, "remudero");
  for (const d of [join(stateDir, "state"), stub, join(stateDir, "daemon-install", "deploy"), join(daemonTree, "bin"), join(daemonTree, "src")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(daemonTree, "src", "run-task.ts"), "// fixture\n");
  const verdictFile = join(root, "verdict.json");
  const recycleLog = join(root, "recycle.log");
  writeFileSync(
    verdictFile,
    `${JSON.stringify({ state: "STALLED", action: "recycle", progressAgeMs: 2_400_000, failedBoots15m: 0, reason: "fixture" })}\n`,
  );
  const exe = (p: string, body: string) => {
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  exe(join(daemonTree, "bin", "rmd"), `#!/usr/bin/env bash\nif [ "$1" = progress-watchdog ]; then cat "${verdictFile}"; fi\nexit 0\n`);
  exe(join(stateDir, "daemon-install", "deploy", "recycle-container.sh"), `#!/usr/bin/env bash\necho "VERDICT=$RMD_RECYCLE_VERDICT" >> "${recycleLog}"\nexit 0\n`);
  exe(
    join(stub, "docker"),
    '#!/usr/bin/env bash\ncase "$1" in\n  ps) echo fake-container-id ;;\n  top) echo "PID COMMAND"; echo "1 node bin/rmd daemon" ;;\n  image) echo sha256:image-one ;;\n  inspect) echo 1 ;;\nesac\nexit 0\n',
  );
  exe(join(stub, "findmnt"), "#!/usr/bin/env bash\nexit 0\n");
  const launcher = join(root, "rmd-relaunch.sh");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: stateDir,
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    PATH: `${stub}:${process.env.PATH ?? ""}`,
  };
  delete env.RMD_RECYCLE_VERDICT;
  const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", cwd: REPO_ROOT, env });
  assert.equal(install.status, 0, `render failed: ${install.stderr}`);
  const tick = spawnSync("bash", [launcher], { encoding: "utf8", env });
  assert.equal(tick.status, 0, tick.stderr);
  assert.equal(
    existsSync(recycleLog) ? readFileSync(recycleLog, "utf8") : "",
    "VERDICT=STALLED progressAgeMs=2400000\n",
    "the recycle is told which verdict triggered it",
  );
});
