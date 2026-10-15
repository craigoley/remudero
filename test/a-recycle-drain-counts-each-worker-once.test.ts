import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTAINER_STATE = "/home/node/Remudero";
const LANE = "W1-T8038";
const WORKTREE = `run-${LANE}-1791735000000`;
const REVIEW_CWD = "/tmp/rmd-review-vCp2FT/checkout";
const CLAUDE = "claude --output-format stream-json --max-turns 400";
const CODEX = "codex exec -c default_permissions=rmd_review -C /tmp/rmd-review-vCp2FT/checkout -";

interface Worker { pid: number; ppid: number; age: number; args: string; cwd?: string }
const laneWorker: Worker = { pid: 31971, ppid: 110, age: 3117, args: CLAUDE, cwd: `${CONTAINER_STATE}/worktrees/${WORKTREE}/src` };
const wrapper: Worker = { pid: 173795, ppid: 110, age: 5, args: `node /usr/local/bin/${CODEX}`, cwd: REVIEW_CWD };
const native: Worker = { pid: 173802, ppid: wrapper.pid, age: 4, args: `/opt/vendor/bin/${CODEX}`, cwd: REVIEW_CWD };

function recycle(t: TestContext, workers: Worker[], lockKey?: string, worktree = WORKTREE, branch?: string, lateLock = false) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t8135-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const path of [bin, home, join(dir, "tmp"), join(dir, "state/inflight")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(dir, "key"), "fixture-key\n", { mode: 0o600 });
  if (lockKey) {
    writeFileSync(join(dir, "state/inflight", `${lockKey}.lock`), JSON.stringify({ pid: 110, host: "fixture-host", startedAt: new Date().toISOString() }));
    const tree = join(dir, "worktrees", worktree);
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${CONTAINER_STATE}/repos/remudero/.git/worktrees/fixture\n`);
    if (branch) {
      const admin = join(dir, "repos/remudero/.git/worktrees/fixture");
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, "HEAD"), `ref: refs/heads/${branch}\n`);
    }
    if (lateLock) rmSync(join(dir, "state/inflight", `${lockKey}.lock`));
  }
  writeFileSync(join(dir, "processes"), ["1 0 4000 init", "110 1 3500 node daemon.ts", ...workers.map(w => `${w.pid} ${w.ppid} ${w.age} ${w.args}`)].join("\n") + "\n");
  for (const w of workers) if (w.cwd) writeFileSync(join(dir, `cwd-${w.pid}`), w.cwd);
  writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  image) echo sha256:fixture ;;
  pull) echo 'Status: Downloaded newer image' ;;
  inspect)
    case "$3" in
      '{{.Id}}') echo fixture-container ;;
      '{{.State.Running}}') echo true ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*)
        printf '%s\\t/home/node/Remudero\\ttrue\\n' "$RMD_STATE_DIR"
        printf '%s\\t/home/node/.claude\\ttrue\\n' "$HOME/.claude" ;;
      *.Image}}*) echo sha256:fixture ;;
    esac ;;
  exec)
    shift 2
    case "$1" in
      ps)
        [ -z "$FIXTURE_LATE_LOCK" ] || printf '{}' > "$RMD_STATE_DIR/state/inflight/$FIXTURE_LATE_LOCK.lock"
        case "$3" in
          pid,etimes,args) awk '{ $2=""; print }' "$FIXTURE_DIR/processes" ;;
          pid,ppid) awk '{ print $1, $2 }' "$FIXTURE_DIR/processes" ;;
        esac ;;
      readlink)
        pid="\${2#/proc/}"; pid="\${pid%/cwd}"
        cat "$FIXTURE_DIR/cwd-$pid" 2>/dev/null ;;
      sh) echo PRESENT ;;
    esac ;;
  stop|rm|run|container) touch "$FIXTURE_DIR/stopped" ;;
esac
exit 0
`, { mode: 0o755 });
  const r = spawnSync("bash", [join(ROOT, "deploy/recycle-container.sh")], {
    cwd: ROOT, encoding: "utf8", timeout: 20_000,
    env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FIXTURE_DIR: dir,
      FIXTURE_LATE_LOCK: lateLock ? lockKey : "",
      TMPDIR: join(dir, "tmp"), RMD_STATE_DIR: dir, RMD_DAEMON_CONTAINER: "remudero",
      RMD_OPENWEIGHT_API_KEY_PATH: join(dir, "key"), RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-dockerenv"), RMD_RECYCLE_WAIT_S: "0",
      RMD_RECYCLE_VERDICT: "", GH_TOKEN: "", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    },
  });
  assert.ifError(r.error);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.equal(existsSync(join(dir, "stopped")), false, "busy work prevents smoke and container replacement");
  if (lockKey) assert.equal(existsSync(join(dir, "state/inflight", `${lockKey}.lock`)), true);
  assert.equal(existsSync(join(dir, "state/PAUSE")), false, "refusal releases its own pause");
  return r.stderr;
}

test("W1-T8135: a codex wrapper and its native child are one lane-less worker", (t) => {
  const out = recycle(t, [native, wrapper]);
  assert.match(out, /REFUSING — 0 lane-holding and 1 lane-less/);
  assert.match(out, /oldest in-flight work this run observed was 5s old/);
  assert.equal(out.split("\n").filter(l => /pid 173795\b.*lane-less/.test(l)).length, 1);
  assert.doesNotMatch(out, /173802/);
});

test("W1-T8135: a lane holder own worker is not counted lane-less", (t) => {
  for (const tree of [WORKTREE, `sweep-${LANE}-1791735000000`]) {
    const out = recycle(t, [{ ...laneWorker, cwd: `${CONTAINER_STATE}/worktrees/${tree}/src` }], LANE, tree);
    assert.match(out, /REFUSING — 1 lane-holding and 0 lane-less/);
    assert.equal(out.split("\n").filter(l => /pid 31971\b.*lane W1-T8038/.test(l)).length, 1);
  }
});

test("W1-T8135: the 17:08 refusal replay counts 1 lane-holding and 1 lane-less", (t) => {
  const out = recycle(t, [laneWorker, wrapper, native], LANE);
  assert.match(out, /REFUSING — 1 lane-holding and 1 lane-less/);
  assert.equal(out.split("\n").filter(l => /pid \d+\s+age \d+s\s+lane/.test(l)).length, 2);
  assert.match(out, /pid 31971\s+age 3117s\s+lane W1-T8038/);
  assert.match(out, /pid 173795\s+age 5s\s+lane-less/);
  assert.doesNotMatch(out, /173802/);
});

test("W1-T8135: an unattributed worker still counts as lane-less busy", (t) => {
  for (const cwd of [REVIEW_CWD, undefined, `${CONTAINER_STATE}/worktrees/${WORKTREE}-other`]) {
    const out = recycle(t, [{ ...wrapper, cwd }], LANE);
    assert.match(out, /REFUSING — 1 lane-holding and 1 lane-less/);
    assert.match(out, /pid 173795\s+age 5s\s+lane-less/);
  }
});

test("a matching ancestor through a non-worker process is still one worker tree", (t) => {
  const bridge = { pid: 173800, ppid: wrapper.pid, age: 4, args: "sh helper", cwd: REVIEW_CWD };
  const out = recycle(t, [{ ...native, ppid: bridge.pid }, bridge, wrapper]);
  assert.match(out, /REFUSING — 0 lane-holding and 1 lane-less/);
  assert.doesNotMatch(out, /173802/);
});

test("a fix-branch lock attributes only its checked-out worktree", (t) => {
  const branch = "fix/fixture";
  const tree = "sweep-unfiled-1791735000000";
  const out = recycle(t, [{ ...laneWorker, cwd: `${CONTAINER_STATE}/worktrees/${tree}` }, wrapper], "fix-branch--owner--remudero--fix__fixture", tree, branch);
  assert.match(out, /REFUSING — 1 lane-holding and 1 lane-less/);
  assert.match(out, /pid 31971\s+age 3117s\s+lane fix-branch--owner--remudero--fix__fixture/);
  assert.match(out, /pid 173795\s+age 5s\s+lane-less/);
});

test("a lock appearing after the lane count cannot hide its worker", (t) => {
  const out = recycle(t, [laneWorker], LANE, WORKTREE, undefined, true);
  assert.match(out, /REFUSING — 0 lane-holding and 1 lane-less/);
  assert.match(out, /pid 31971\s+age 3117s\s+lane-less/);
});
