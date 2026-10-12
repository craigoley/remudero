/**
 * deploy/scratch-mounts.sh and the launch paths that use it: rebuildable, I/O-heavy container paths
 * move to the host's ephemeral NVMe; nothing authoritative moves; a wiped scratch disk is re-created
 * at docker start. The recycle path is covered beside its own harness in test/recycle-container.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workerHomeDir, type Config } from "../src/lib/config.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { perRunWorkerHomeDir, sweepStaleWorkerHomes } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const LIB = join(REPO_ROOT, "deploy", "scratch-mounts.sh");

interface Host {
  root: string;
  scratch: string;
  state: string;
  env: Record<string, string>;
}

/** A throwaway host: a state dir, a scratch root the mounts table declares mounted, the switch file. */
function host(t: { after: (fn: () => void) => void }): Host {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scratch-host-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "mnt", "scratch");
  const state = join(root, "rmd-state2");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(state, "state"), { recursive: true });
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  writeFileSync(join(root, "scratch-mounts.on"), "");
  return {
    root, scratch, state,
    env: { RMD_SCRATCH_ROOT: scratch, RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts"), RMD_SCRATCH_SWITCH: join(root, "scratch-mounts.on") },
  };
}

function plan(h: Host, env: Record<string, string> = {}): { args: string[]; note: string } {
  const r = spawnSync("bash", ["-c", `. "${LIB}"; scratch_plan "$1" remudero-serve; printf '%s\\n' "\${SCRATCH_ARGS[@]+"\${SCRATCH_ARGS[@]}"}"; echo "NOTE $SCRATCH_NOTE"`, "plan", h.state], {
    encoding: "utf8", env: { ...process.env, ...h.env, ...env },
  });
  const lines = r.stdout.trim().split("\n");
  return { args: lines.filter((l) => !l.startsWith("NOTE ")), note: lines.find((l) => l.startsWith("NOTE ")) ?? "" };
}

test("the scratch plan binds only rebuildable paths and only when switched on over a mounted scratch root", (t) => {
  const h = host(t);
  const base = join(h.scratch, "rmd", "rmd-state2");
  assert.deepEqual(plan(h).args, [
    "-v", `${base}/worktrees:/home/node/Remudero/worktrees`,
    "-v", `${base}/tmp:/home/node/Remudero/tmp`,
    "-v", `${base}/remudero-coverage:/home/node/Remudero/.remudero-coverage`,
    "-v", `${base}/repos:/home/node/Remudero/repos`,
    "-v", `${base}/repos-coverage:/home/node/Remudero/repos/.remudero-coverage`,
    "-v", `${base}/read-model:/home/node/rmd-scratch/read-model`,
    "-v", `${base}/worker-homes:/home/node/rmd-scratch/worker-homes`,
    "-v", `${base}/containers/remudero-serve/tmp:/tmp`,
    "-v", `${h.scratch}/rmd/test-slots:/home/node/rmd-scratch/test-slots`,
    "-e", "RMD_READ_MODEL_DB_DIR=/home/node/Remudero/state:/home/node/rmd-scratch/read-model",
    "-e", "RMD_WORKER_HOME_DIR=/home/node/Remudero:/home/node/rmd-scratch/worker-homes",
    "-e", "RMD_TEST_SLOT_DIR=/home/node/rmd-scratch/test-slots",
  ], "the ledger, lanes, plan and state files are never bound away from the state disk");
  assert.equal(existsSync(base), false, "planning changes nothing on disk");

  rmSync(h.env.RMD_SCRATCH_SWITCH);
  assert.deepEqual(plan(h).args, [], "no switch file: dark, exactly today's launch");
  assert.match(plan(h).note, /^NOTE off/);
  assert.deepEqual(plan(h, { RMD_SCRATCH: "on" }).args.length, 24, "RMD_SCRATCH=on turns it on without the file");
  assert.deepEqual(plan(h, { RMD_SCRATCH: "on", RMD_SCRATCH_MOUNTS_FILE: join(h.root, "absent") }).args, [], "a scratch root that is not mounted would put worktrees on the OS disk");
  assert.match(plan(h, { RMD_SCRATCH: "on", RMD_SCRATCH_MOUNTS_FILE: join(h.root, "absent") }).note, /is not a mounted filesystem/);
  writeFileSync(h.env.RMD_SCRATCH_SWITCH, "");
  assert.deepEqual(plan(h, { RMD_SCRATCH: "off" }).args, [], "RMD_SCRATCH=off wins over the switch file");
  const unsafe = spawnSync("bash", ["-c", `. "${LIB}"; scratch_plan "$1" 'bad name' || echo "REFUSED $SCRATCH_NOTE"; scratch_plan . remudero-serve || echo "REFUSED $SCRATCH_NOTE"`, "plan", h.state], { encoding: "utf8", env: { ...process.env, ...h.env } });
  assert.match(unsafe.stdout, /REFUSED NOT USED — container name 'bad name' is not Docker-safe/);
  assert.match(unsafe.stdout, /REFUSED NOT USED — state dir \. has no usable name/);
});

test("a scratch dir that cannot be created drops the binds and the launch goes ahead without them", (t) => {
  const h = host(t);
  writeFileSync(join(h.scratch, "rmd"), "a file where a directory must go");
  const r = spawnSync("bash", ["-c", `. "${LIB}"; scratch_plan "$1" remudero-daemon; scratch_prepare || echo "FELL BACK \${#SCRATCH_ARGS[@]} $SCRATCH_NOTE"; scratch_fresh_tmp && echo fresh-ok`, "prep", h.state], { encoding: "utf8", env: { ...process.env, ...h.env } });
  assert.match(r.stdout, /FELL BACK 0 NOT USED — could not create a writable/);
  assert.match(r.stdout, /fresh-ok/, "with no binds there is no /tmp to empty, and nothing fails");
});

function dryRunServe(h: Host): { status: number | null; out: string } {
  const bin = join(h.root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(h.root, "code"), { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ]; then exit 0; fi\nexit 1\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [join(REPO_ROOT, "deploy", "serve-container.sh"), "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env, ...h.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: h.root,
      GH_TOKEN: "test-token",
      RMD_STATE_DIR: h.state,
      RMD_SERVE_REPO_DIR: join(h.root, "code"),
      RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
      RMD_SERVE_DOCKERENV_PATH: join(h.root, "no-dockerenv"),
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("the serve launch carries the scratch binds when switched on and changes nothing in a dry run", (t) => {
  const h = host(t);
  const on = dryRunServe(h);
  assert.equal(on.status, 0, on.out);
  assert.match(on.out, /-v [^ ]*\/rmd\/rmd-state2\/read-model:\/home\/node\/rmd-scratch\/read-model -v [^ ]*\/worker-homes:\/home\/node\/rmd-scratch\/worker-homes -v [^ ]*\/containers\/remudero-serve\/tmp:\/tmp -v [^ ]*\/rmd\/test-slots:\/home\/node\/rmd-scratch\/test-slots -e RMD_READ_MODEL_DB_DIR=\/home\/node\/Remudero\/state:\/home\/node\/rmd-scratch\/read-model/);
  assert.match(on.out, /scratch mounts on/);
  assert.equal(existsSync(join(h.scratch, "rmd")), false, "a dry run creates no directory");

  rmSync(h.env.RMD_SCRATCH_SWITCH);
  const off = dryRunServe(h);
  assert.equal(off.status, 0, off.out);
  assert.doesNotMatch(off.out, /\/home\/node\/rmd-scratch|RMD_READ_MODEL_DB_DIR/, "switched off, the serve launch is today's");
});

/** Renders the fleet launcher for a throwaway host and runs its revival path against stub docker and findmnt. */
function launch(h: Host, env: Record<string, string> = {}): { status: number | null; out: string; dockerRun: string } {
  const stubs = join(h.root, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> "${h.root}/docker.log"\ncase "$1" in inspect) echo none ;; esac\nexit 0\n`);
  writeFileSync(join(stubs, "findmnt"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stubs, "docker"), 0o755);
  chmodSync(join(stubs, "findmnt"), 0o755);
  writeFileSync(join(h.state, "state", "ledger.ndjson"), '{"step":"seed"}\n');
  const units = { RMD_UNIT_DIR: join(h.root, "systemd"), RMD_BIN_DIR: join(h.root, "sbin"), RMD_LAUNCHER_PATH: join(h.root, "rmd-relaunch.sh"), RMD_REVIVAL_LOG: join(h.root, "revivals.log"), RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_STATE_DIR: h.state };
  const installed = spawnSync("bash", [join(REPO_ROOT, "deploy", "install-host-units.sh"), "--install"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, ...units } });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(join(h.root, "sbin", "rmd-scratch-mounts"), "utf8"), readFileSync(LIB, "utf8"), "the launcher's library is installed beside it");
  rmSync(join(h.root, "docker.log"), { force: true });
  const r = spawnSync("bash", [join(h.root, "rmd-relaunch.sh")], { encoding: "utf8", env: { ...process.env, ...h.env, ...env, PATH: `${stubs}:${process.env.PATH ?? ""}` } });
  const log = existsSync(join(h.root, "docker.log")) ? readFileSync(join(h.root, "docker.log"), "utf8") : "";
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dockerRun: log.split("\n").find((l) => l.startsWith("docker run")) ?? "" };
}

test("an empty scratch disk after a deallocate is re-created at docker start and by the fleet launcher", (t) => {
  const h = host(t);
  const base = join(h.scratch, "rmd", "rmd-state2");
  const first = launch(h);
  assert.equal(first.status, 0, first.out);
  assert.match(first.dockerRun, new RegExp(`-v ${base}/worktrees:/home/node/Remudero/worktrees .*-v ${base}/containers/remudero-daemon/tmp:/tmp -v ${h.scratch}/rmd/test-slots:/home/node/rmd-scratch/test-slots -e RMD_READ_MODEL_DB_DIR=`), first.dockerRun);
  const recorded = readFileSync(join(h.state, ".scratch-mounts"), "utf8").trim().split("\n");
  assert.equal(recorded.length, 9);

  rmSync(join(h.scratch, "rmd"), { recursive: true, force: true });
  const restored = spawnSync("bash", [LIB, "--restore", h.state, join(h.root, "no-such-instance")], { encoding: "utf8", env: { ...process.env, ...h.env } });
  assert.equal(restored.status, 0, restored.stderr);
  for (const dir of recorded) assert.ok(existsSync(dir), `docker's ExecStartPre re-created ${dir} before any container restarts`);
  assert.match(restored.stdout, /no .*no-such-instance\/\.scratch-mounts; nothing to restore/);

  writeFileSync(join(h.state, ".scratch-mounts"), `${recorded.join("\n")}\n/etc/not-scratch\n${h.scratch}/rmd/../escape\n`);
  rmSync(join(h.scratch, "rmd"), { recursive: true, force: true });
  const unmounted = spawnSync("bash", [LIB, "--restore", h.state], { encoding: "utf8", env: { ...process.env, ...h.env, RMD_SCRATCH_MOUNTS_FILE: join(h.root, "absent") } });
  assert.equal(unmounted.status, 0, "a restore never fails docker");
  assert.equal(existsSync(join(h.scratch, "rmd")), false, "nothing is created on a scratch root that is not mounted");
  const guarded = spawnSync("bash", [LIB, "--restore", h.state], { encoding: "utf8", env: { ...process.env, ...h.env } });
  assert.equal(guarded.stdout.match(/restored/g)?.length, 9, "only dirs under the scratch root, with no '..', are re-created");
  assert.equal(spawnSync("bash", [LIB], { encoding: "utf8" }).status, 2, "the CLI names its one verb");

  rmSync(join(h.scratch, "rmd"), { recursive: true, force: true });
  const again = launch(h);
  assert.equal(again.status, 0, again.out);
  for (const dir of recorded) assert.ok(existsSync(dir), `the launcher re-creates ${dir} on an empty scratch disk`);
  const off = launch(h, { RMD_SCRATCH: "off" });
  assert.doesNotMatch(off.dockerRun, /\/home\/node\/rmd-scratch|RMD_READ_MODEL_DB_DIR/, "switched off, the revival is today's launch");
});

test("docker mount ordering uses the fixture mountinfo and re-creates scratch dirs first", (t) => {
  const h = host(t);
  const fixture = join(h.root, "units");
  const stubs = join(fixture, "bin");
  mkdirSync(stubs, { recursive: true });
  mkdirSync(join(fixture, "docker.service.d"));
  mkdirSync(join(fixture, "containerd.service.d"));
  writeFileSync(join(stubs, "id"), '#!/usr/bin/env bash\n[ "$1" = "-u" ] && echo 0\n');
  writeFileSync(join(stubs, "docker"), '#!/usr/bin/env bash\necho /mnt/rmd/docker\n');
  writeFileSync(join(stubs, "systemctl"), '#!/usr/bin/env bash\n[ "$1" = show ] && echo "RequiresMountsFor=/mnt/rmd/docker /var/lib/containerd /mnt/rmd ' + h.state + '"\nexit 0\n');
  for (const s of ["id", "docker", "systemctl"]) chmodSync(join(stubs, s), 0o755);
  writeFileSync(join(fixture, "mounts"), `/dev/sdb1 /mnt/rmd ext4 rw 0 0\n/mnt/rmd/containerd /var/lib/containerd none rw,bind 0 0\nnone ${h.state} ext4 rw 0 0\n`);
  // mountinfo, not mounts, retains a bind's filesystem root. Never mix this fake
  // host with /proc/self/mountinfo from the runner (whose backing mount may differ).
  writeFileSync(join(fixture, "mountinfo"), "25 1 8:1 / /mnt/rmd rw - ext4 /dev/sdb1 rw\n26 25 8:1 /containerd /var/lib/containerd rw - ext4 /dev/sdb1 rw\n");
  const r = spawnSync("bash", [join(REPO_ROOT, "deploy", "install-container-runtime-mount-order.sh"), "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      RMD_STATE_DIR: h.state,
      RMD_SCRATCH_STATE_DIRS: "/mnt/rmd/remudero-console-state /home/u/rmd-site-state",
      RMD_SCRATCH_LIB_PATH: join(fixture, "rmd-scratch-mounts"),
      RMD_DOCKER_DROPIN_DIR: join(fixture, "docker.service.d"),
      RMD_CONTAINERD_DROPIN_DIR: join(fixture, "containerd.service.d"),
      RMD_PROC_MOUNTS_FILE: join(fixture, "mounts"),
      RMD_PROC_MOUNTINFO_FILE: join(fixture, "mountinfo"),
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const containerdDropin = readFileSync(join(fixture, "containerd.service.d", "20-remudero-mount-order.conf"), "utf8");
  assert.match(containerdDropin, /^RequiresMountsFor=\/mnt\/rmd \/var\/lib\/containerd$/m, "the private mountinfo owns the bind backing, not the live host");
  const dropin = readFileSync(join(fixture, "docker.service.d", "20-remudero-mount-order.conf"), "utf8");
  assert.match(dropin, /^After=rmd-scratch\.service$/m);
  assert.match(dropin, /^Wants=rmd-scratch\.service$/m);
  assert.match(dropin, new RegExp(`^ExecStartPre=-/bin/bash ${join(fixture, "rmd-scratch-mounts")} --restore ${h.state} /mnt/rmd/remudero-console-state /home/u/rmd-site-state$`, "m"));
  assert.match(dropin, new RegExp(`^RequiresMountsFor=/mnt/rmd/docker /var/lib/containerd ${h.state}$`, "m"), "never a RequiresMountsFor on a disk no mount unit owns");
  assert.equal(readFileSync(join(fixture, "rmd-scratch-mounts"), "utf8"), readFileSync(LIB, "utf8"), "the restore it runs is this repo's library");
});

test("scratch prepare makes each state side mount point first so a rollback leaves it writable", (t) => {
  const h = host(t);
  const r = spawnSync("bash", ["-c", `. "${LIB}"; scratch_plan "$1" remudero-daemon && scratch_prepare && echo prepared`, "prep", h.state], { encoding: "utf8", env: { ...process.env, ...h.env } });
  assert.match(r.stdout, /prepared/, r.stderr);
  for (const rel of ["worktrees", "tmp", ".remudero-coverage", "repos", join("repos", ".remudero-coverage")]) {
    assert.ok(existsSync(join(h.state, rel)), `${rel} exists on the state disk before docker could create it as root`);
  }
  assert.equal(existsSync(join(h.state, "rmd-scratch")), false, "a bind outside the state root makes nothing on the state disk");
});

test("a worker home mapping for this config root moves the per spawn homes and the sweep still reads that root's ledger", (t) => {
  const h = host(t);
  const relocated = join(h.scratch, "worker-homes");
  const config = { root: h.state } as Config;
  const env = { RMD_WORKER_HOME_DIR: `${h.state}:${relocated}` };
  assert.equal(workerHomeDir(config, env), join(relocated, "worker-home"));
  assert.equal(workerHomeDir(config, { RMD_WORKER_HOME_DIR: `${h.root}/other-root:${relocated}` }), join(h.state, "worker-home"), "another root's mapping never redirects this one");
  assert.equal(workerHomeDir(config, { RMD_WORKER_HOME_DIR: `${h.state}:` }), join(h.state, "worker-home"), "a mapping with no dir is ignored");
  assert.equal(workerHomeDir({ ...config, workerHomeRoot: join(h.root, "explicit") }, env), join(h.root, "explicit"), "an explicit workerHomeRoot still wins");

  const root = workerHomeDir(config, env);
  const done = perRunWorkerHomeDir(root, "W1-T1-1", { perSpawn: true });
  const live = perRunWorkerHomeDir(root, "W1-T2-2", { perSpawn: true });
  mkdirSync(done, { recursive: true });
  mkdirSync(live, { recursive: true });
  mkdirSync(join(h.state, "state", "inflight"), { recursive: true });
  writeFileSync(join(h.state, "state", "ledger.ndjson"), `${JSON.stringify({ step: "verdict", run_id: "W1-T1-1" })}\n`);
  const swept = sweepStaleWorkerHomes(root, { stateRoot: h.state });
  assert.deepEqual(swept.removed.map((n) => n.split(".")[0]), ["worker-home-W1-T1-1"], "the terminal verdict in the config root's ledger reaps the relocated home now");
  assert.ok(existsSync(live), "a run with no verdict keeps its home");
});

test("the printed host update runs carry the same mounts as the real launchers when scratch is on", (t) => {
  const h = host(t);
  const codex = join(h.root, "codex");
  const containerConfig = join(h.root, "container-config");
  const claude = join(h.root, "claude");
  for (const d of [codex, containerConfig, claude]) mkdirSync(d, { recursive: true });
  const printed = (extra: Record<string, string> = {}) => spawnSync("bash", [join(REPO_ROOT, "deploy", "host-update.sh"), "--print-daemon-run"], {
    cwd: REPO_ROOT, encoding: "utf8",
    env: { ...process.env, ...h.env, ...extra, RMD_STATE_DIR: h.state, RMD_CLAUDE_DIR: claude, RMD_CODEX_DIR: codex, RMD_CONTAINER_CONFIG_DIR: containerConfig },
  });
  const binds = (text: string) => [...text.matchAll(/-v ("?)(\S+?):(\S+?)\1 /g)].map((m) => m[3]).sort();
  const on = printed();
  assert.equal(on.status, 0, on.stderr);
  const [daemonRun, serveRun] = on.stdout.split("docker run -d --name ").slice(1);
  const base = join(h.scratch, "rmd", "rmd-state2");
  assert.match(daemonRun, new RegExp(`-v ${base}/worker-homes:/home/node/rmd-scratch/worker-homes \\\\\\n`));
  assert.match(daemonRun, new RegExp(`-v ${base}/containers/remudero-daemon/tmp:/tmp \\\\\\n`));
  assert.match(daemonRun, /-e RMD_WORKER_HOME_DIR=\/home\/node\/Remudero:\/home\/node\/rmd-scratch\/worker-homes \\\n/);
  assert.match(serveRun, new RegExp(`-v ${base}/containers/remudero-serve/tmp:/tmp \\\\\\n`));
  assert.match(serveRun, /-e RMD_READ_MODEL_DB_DIR=\/home\/node\/Remudero\/state:\/home\/node\/rmd-scratch\/read-model \\\n/);
  assert.match(on.stdout, new RegExp(`mkdir -p .*${base}/worker-homes .*${h.state}/repos/\\.remudero-coverage`), "the printed dirs are made by the operator, never as root by docker");
  assert.equal(existsSync(join(h.scratch, "rmd")), false, "printing changes nothing on disk");

  const real = launch(h, {});
  assert.equal(real.status, 0, real.out);
  assert.deepEqual(binds(`${daemonRun.split("./bin/rmd daemon")[0].replace(/ \\\n/g, " ")} `), binds(`${real.dockerRun} `), "the printed daemon mounts exactly what the rendered fleet launcher mounts");

  rmSync(h.env.RMD_SCRATCH_SWITCH);
  const off = printed();
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /\/home\/node\/rmd-scratch|RMD_WORKER_HOME_DIR|mkdir -p/, "switched off, the printed runs are today's");
});
