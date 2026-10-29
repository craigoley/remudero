import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const DEST = "/home/node/Remudero/worktrees";
const TASK = "W1-T1";
const TREE = `run-${TASK}-1791900000000`;
const HOST = "2ca2ffc969af";

interface Options {
  scratch?: boolean;
  mount?: "live" | "absent" | "missing" | "failed";
  reclaim?: boolean;
  fixClaim?: boolean;
  noTree?: boolean;
  cwd?: string;
  planUnavailable?: boolean;
  staleHolder?: boolean;
}

function recycle(t: TestContext, options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9713-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, "state-root");
  const scratch = join(dir, "scratch");
  const planned = join(scratch, "rmd/state-root/worktrees");
  const live = join(dir, "live worktrees");
  const stale = join(state, "worktrees");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const inflight = join(state, "state/inflight");
  for (const path of [planned, live, stale, bin, home, inflight, join(dir, "tmp")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(dir, "key"), "fixture-key\n", { mode: 0o600 });
  writeFileSync(join(dir, "mounts"), `fixture ${scratch} ext4 rw 0 0\n`);
  const key = options.fixClaim ? "fix-branch--owner--remudero--fix__fixture" : TASK;
  const tree = options.fixClaim ? "sweep-unfiled-1791900000000" : TREE;
  for (const root of [planned, live, stale]) {
    if (options.noTree) continue;
    const worktree = join(root, tree);
    mkdirSync(worktree);
    const admin = join(worktree, "admin");
    mkdirSync(admin);
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/fix/fixture\n");
    // Fix claims also exercise translation of a git admin dir inside the worktree bind.
    if (root !== stale || options.staleHolder || options.scratch === false) {
      writeFileSync(join(worktree, ".git"), options.fixClaim
        ? `gitdir: ${DEST}/${tree}/admin\n` : "gitdir: /missing-admin\n");
    }
    writeFileSync(join(worktree, "unpublished"), "keep this work\n");
  }
  const holder = { pid: 110, host: HOST, startedAt: new Date().toISOString() };
  const lock = join(inflight, `${key}.lock`);
  writeFileSync(lock, JSON.stringify(holder));
  if (options.reclaim) {
    writeFileSync(join(state, "state/drain.lock"), JSON.stringify(holder));
    writeFileSync(join(state, "state/ledger.ndjson"), JSON.stringify({
      ts: new Date(Date.now() - 90 * 60_000).toISOString(), actor_pid: 110, step: "daemon.pulse",
    }) + "\n");
  }
  writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  image) echo sha256:fixture ;;
  pull) echo 'Status: Downloaded newer image' ;;
  inspect)
    case "$3" in
      '{{.Id}}') echo '${HOST}${"0".repeat(52)}' ;;
      '{{.State.Running}}') echo true ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*)
        [ "$FIXTURE_MOUNT" != failed ] || exit 1
        printf '%s\\t/home/node/Remudero\\ttrue\\n' "$RMD_STATE_DIR"
        printf '%s\\t/home/node/.claude\\ttrue\\n' "$HOME/.claude"
        case "$FIXTURE_MOUNT" in
          live) printf '%s\\t${DEST}\\ttrue\\n' "$FIXTURE_LIVE" ;;
          missing) printf '%s/missing\\t${DEST}\\ttrue\\n' "$FIXTURE_LIVE" ;;
        esac ;;
      *.Image}}*) echo sha256:fixture ;;
    esac ;;
  exec)
    shift 2
    case "$1" in
      ps)
        case "$3" in
          pid,etimes,args) echo '4321 5 claude --output-format stream-json' ;;
          pid,ppid) printf '110 1\\n4321 999\\n' ;;
        esac ;;
      readlink) printf '%s\\n' "$FIXTURE_CWD" ;;
      sh) echo PRESENT ;;
    esac ;;
  stop|rm|run|container) touch "$FIXTURE_DIR/lifecycle" ;;
esac
exit 0
`, { mode: 0o755 });
  const run = spawnSync("bash", [join(REPO_ROOT, "deploy/recycle-container.sh")], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 20_000,
    env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TMPDIR: join(dir, "tmp"),
      FIXTURE_DIR: dir, FIXTURE_LIVE: live, FIXTURE_MOUNT: options.mount ?? "live",
      FIXTURE_CWD: options.cwd ?? `${DEST}/${tree}/src`, RMD_STATE_DIR: state,
      RMD_DAEMON_CONTAINER: "remudero", RMD_RECYCLE_FIRST_BOOT: "1", RMD_RECYCLE_WAIT_S: "0",
      RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-dockerenv"), RMD_OPENWEIGHT_API_KEY_PATH: join(dir, "key"),
      RMD_RECYCLE_VERDICT: options.reclaim ? "STALLED progressAgeMs=5400000" : "",
      RMD_RECYCLE_STALL_BOUND_S: "1800", RMD_SCRATCH: options.scratch === false ? "off" : "on",
      RMD_SCRATCH_ROOT: scratch, RMD_SCRATCH_CHECKOUTS: "off",
      RMD_SCRATCH_MOUNTS_FILE: join(dir, options.planUnavailable ? "missing-mounts" : "mounts"),
      GH_TOKEN: "", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /REFUSING — \d+ lane-holding and \d+ lane-less/);
  assert.equal(existsSync(join(dir, "lifecycle")), false, "the fixture never replaces a container");
  assert.equal(existsSync(join(state, "state/PAUSE")), false, "refusal releases its pause");
  assert.equal(existsSync(join(state, ".scratch-mounts")), false, "resolving a plan prepares no mounts");
  let reason = "";
  if (options.reclaim) {
    assert.equal(existsSync(lock), false, "the frozen daemon's lock is moved");
    const reclaimed = join(inflight, "reclaimed");
    const names = readdirSync(reclaimed).filter(name => name.endsWith(".reason"));
    assert.equal(names.length, 1);
    reason = readFileSync(join(reclaimed, names[0]), "utf8");
    assert.match(reason, /^kept: worktrees, worker homes and logs are untouched/m);
  } else assert.equal(existsSync(lock), true, "a live holder's lock stays put");
  if (!options.noTree) for (const root of [planned, live, stale]) {
    assert.equal(readFileSync(join(root, tree, "unpublished"), "utf8"), "keep this work\n");
  }
  return { stderr: run.stderr, reason, live, planned, stale, tree };
}

test("W1-T9713: a holder worktree is read from the scratch bind, not the stale state dir", t => {
  const r = recycle(t, { reclaim: true, staleHolder: true });
  assert.deepEqual(r.reason.split("\n").filter(line => line.startsWith("worktree: ")), [
    `worktree: ${join(r.live, r.tree)}`,
  ]);
  assert.equal(r.reason.includes(r.stale), false);
  assert.equal(r.reason.includes(r.planned), false, "the running bind wins over a different scratch plan");
});

test("W1-T9713: a worker in a scratch worktree is attributed to its lock", t => {
  const r = recycle(t);
  assert.match(r.stderr, /REFUSING — 1 lane-holding and 0 lane-less/);
  const worker = r.stderr.split("\n").find(line => line.includes("pid 4321  age 5s"));
  assert.ok(worker?.includes(`lane ${TASK}`));
  assert.ok(worker.includes(`worktrees: ${r.live}`), "the busy-worker line names the host dir read");
});

test("W1-T9713: with scratch off the state-dir worktrees are read as before", t => {
  const r = recycle(t, { scratch: false, mount: "absent", reclaim: true });
  assert.deepEqual(r.reason.split("\n").filter(line => line.startsWith("worktree: ")), [
    `worktree: ${join(r.stale, r.tree)}`,
  ]);
  const busy = recycle(t, { scratch: false, mount: "absent" });
  assert.match(busy.stderr, /REFUSING — 1 lane-holding and 0 lane-less/);
  assert.ok(busy.stderr.includes(`  pid 4321  age 5s  lane ${TASK}  claude --output-format stream-json\n`));
});

test("W1-T9713: an absent or unreadable live bind falls back to the scratch plan", t => {
  for (const mount of ["absent", "missing", "failed"] as const) {
    const r = recycle(t, { mount });
    assert.match(r.stderr, /REFUSING — 1 lane-holding and 0 lane-less/);
    assert.ok(r.stderr.includes(`worktrees: ${r.planned}`));
  }
});

test("W1-T9713: an unreadable plan falls back to state worktrees", t => {
  const r = recycle(t, { mount: "missing", planUnavailable: true, reclaim: true, staleHolder: true });
  assert.ok(r.reason.includes(`worktree: ${join(r.stale, r.tree)}\n`));
});

test("W1-T9713: the live bind wins even after the scratch switch is turned off", t => {
  const r = recycle(t, { scratch: false });
  assert.match(r.stderr, /REFUSING — 1 lane-holding and 0 lane-less/);
  assert.ok(r.stderr.includes(`worktrees: ${r.live}`));
});

test("W1-T9713: a missing holder reason names the resolved directory", t => {
  const r = recycle(t, { reclaim: true, noTree: true });
  assert.ok(r.reason.includes(`worktree: none found under ${r.live} for ${TASK}\n`));
});

test("W1-T9713: fix claims use the resolved bind for their git admin directory", t => {
  const r = recycle(t, { fixClaim: true });
  assert.match(r.stderr, /REFUSING — 1 lane-holding and 0 lane-less/);
  assert.match(r.stderr, /lane fix-branch--owner--remudero--fix__fixture/);
});

test("W1-T9713: a sibling path does not inherit the holder's lane", t => {
  const r = recycle(t, { cwd: `${DEST}/${TREE}-other` });
  assert.match(r.stderr, /REFUSING — 1 lane-holding and 1 lane-less/);
  assert.ok(r.stderr.includes(`lane-less  claude --output-format stream-json  worktrees: ${r.live}`));
});
