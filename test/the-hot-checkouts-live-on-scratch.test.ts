import { legacyHostScript, withoutRegistrySelection } from "#test/helpers/legacy-host-launch.js";
/**
 * W1-T9617 — THE HOT CHECKOUTS LIVE ON SCRATCH. Behind their own switch (RMD_SCRATCH_CHECKOUTS, the
 * file /etc/remudero/scratch-checkouts.on), each build daemon's own checkout is bound from
 * <scratch>/rmd/<key>/remudero and serve's code dir defaults to <scratch>/rmd/<key>/serve-repo, so
 * their page-cache refaults stop queueing on the IOPS-capped data and OS disks. Off, every plan is
 * byte-identical to before (no W1-T6110 drift, so a merge recycles nothing). A deallocate empties
 * scratch: the restore re-creates the recorded dir, the entrypoint re-clones into it, and the
 * recycle reads that as a re-clone, not as a state dir with no checkout. Every host reader of the
 * checkout follows the switch, the janitor never sweeps one, and nothing durable moves. Each
 * recycle also records where the checkout landed and what the outgoing container read per disk.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readMountPlanDrift } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { age, fixture as cleanupFixture, git as cleanupGit, repos as cleanupRepos, run as runCleanup } from "./helpers/host-cleanup-fixture.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const LIB = join(REPO_ROOT, "deploy", "scratch-mounts.sh");
const CHECKOUT_DEST = "/home/node/Remudero/remudero";

interface Host {
  root: string;
  scratch: string;
  state: string;
  base: string;
  env: Record<string, string>;
}

/** A throwaway host: a state dir, a scratch root the mounts table declares mounted, and both switch files. */
function host(t: { after: (fn: () => void) => void }, opts: { checkouts?: boolean } = {}): Host {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hot-checkouts-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "mnt", "scratch");
  const state = join(root, "rmd-state2");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(state, "state"), { recursive: true });
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  writeFileSync(join(root, "scratch-mounts.on"), "");
  if (opts.checkouts !== false) writeFileSync(join(root, "scratch-checkouts.on"), "");
  return {
    root, scratch, state, base: join(scratch, "rmd", "rmd-state2"),
    env: {
      RMD_SCRATCH_ROOT: scratch,
      RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts"),
      RMD_SCRATCH_SWITCH: join(root, "scratch-mounts.on"),
      RMD_SCRATCH_CHECKOUTS_SWITCH: join(root, "scratch-checkouts.on"),
    },
  };
}

function lib(h: Host, script: string, args: string[] = [], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `. "${LIB}"; ${script}`, "lib", ...args], { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** scratch_plan's docker arguments, its bind lines, its dirs and its note, for one container. */
function plan(h: Host, container: string, env: Record<string, string> = {}) {
  const r = lib(h, `scratch_plan "$1" "$2"; printf 'ARG %s\\n' "\${SCRATCH_ARGS[@]+"\${SCRATCH_ARGS[@]}"}"; printf 'BINDS<%s>\\n' "$SCRATCH_BINDS"; printf 'DIR %s\\n' "\${SCRATCH_DIRS[@]+"\${SCRATCH_DIRS[@]}"}"; echo "NOTE $SCRATCH_NOTE"`, [h.state, container], env);
  const lines = r.stdout.split("\n");
  return {
    args: lines.filter((l) => l.startsWith("ARG ")).map((l) => l.slice(4)).filter(Boolean),
    dirs: lines.filter((l) => l.startsWith("DIR ")).map((l) => l.slice(4)).filter(Boolean),
    binds: (r.stdout.match(/BINDS<([\s\S]*?)>\n/)?.[1] ?? ""),
    note: lines.find((l) => l.startsWith("NOTE ")) ?? "",
  };
}

/** The bind list deploy/scratch-mounts.sh planned before W1-T9617, for one container. */
function todaysArgs(h: Host, container: string): string[] {
  const b = h.base;
  return [
    "-v", `${b}/worktrees:/home/node/Remudero/worktrees`,
    "-v", `${b}/tmp:/home/node/Remudero/tmp`,
    "-v", `${b}/remudero-coverage:/home/node/Remudero/.remudero-coverage`,
    "-v", `${b}/repos:/home/node/Remudero/repos`,
    "-v", `${b}/repos-coverage:/home/node/Remudero/repos/.remudero-coverage`,
    "-v", `${b}/read-model:/home/node/rmd-scratch/read-model`,
    "-v", `${b}/worker-homes:/home/node/rmd-scratch/worker-homes`,
    "-v", `${b}/containers/${container}/tmp:/tmp`,
    "-v", `${h.scratch}/rmd/test-slots:/home/node/rmd-scratch/test-slots`,
    "-e", "RMD_READ_MODEL_DB_DIR=/home/node/Remudero/state:/home/node/rmd-scratch/read-model",
    "-e", "RMD_WORKER_HOME_DIR=/home/node/Remudero:/home/node/rmd-scratch/worker-homes",
    "-e", "RMD_TEST_SLOT_DIR=/home/node/rmd-scratch/test-slots",
  ];
}

/** Renders the fleet launcher for the host and runs its revival path against stub docker and findmnt. */
function revive(h: Host): { status: number | null; out: string; dockerRun: string } {
  const stubs = join(h.root, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> "${h.root}/docker.log"\ncase "$1" in inspect) echo none ;; esac\nexit 0\n`);
  writeFileSync(join(stubs, "findmnt"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stubs, "docker"), 0o755);
  chmodSync(join(stubs, "findmnt"), 0o755);
  writeFileSync(join(h.state, "state", "ledger.ndjson"), '{"step":"seed"}\n');
  const units = { RMD_UNIT_DIR: join(h.root, "systemd"), RMD_BIN_DIR: join(h.root, "sbin"), RMD_LAUNCHER_PATH: join(h.root, "rmd-relaunch.sh"), RMD_REVIVAL_LOG: join(h.root, "revivals.log"), RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_STATE_DIR: h.state };
  const installed = spawnSync("bash", [join(REPO_ROOT, "deploy", "install-host-units.sh"), "--install"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...units } });
  assert.equal(installed.status, 0, installed.stderr);
  rmSync(join(h.root, "docker.log"), { force: true });
  const r = spawnSync("bash", [join(h.root, "rmd-relaunch.sh")], { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env, PATH: `${stubs}:${process.env.PATH ?? ""}` } });
  const log = existsSync(join(h.root, "docker.log")) ? readFileSync(join(h.root, "docker.log"), "utf8") : "";
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dockerRun: log.split("\n").find((l) => l.startsWith("docker run")) ?? "" };
}

function dryRunServe(h: Host, env: Record<string, string> = {}): { status: number | null; out: string } {
  const bin = join(h.root, "serve-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ]; then exit 0; fi\nexit 1\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [join(REPO_ROOT, "deploy", "serve-container.sh"), "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...withoutRegistrySelection(process.env), ...h.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: h.root,
      GH_TOKEN: "test-token",
      RMD_STATE_DIR: h.state,
      RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
      RMD_SERVE_DOCKERENV_PATH: join(h.root, "no-dockerenv"),
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("W1-T9617: with the switch on the daemon checkout mount source is under the scratch root", (t) => {
  const h = host(t);
  const checkout = join(h.base, "remudero");
  const on = plan(h, "remudero-daemon");
  assert.deepEqual(on.args, ["-v", `${checkout}:${CHECKOUT_DEST}`, ...todaysArgs(h, "remudero-daemon")], "one more bind, the checkout, and nothing else changes");
  assert.equal(on.dirs[0], checkout, "the checkout dir is created and recorded like every other scratch dir");
  assert.match(on.note, /the code checkout at .*\/rmd\/rmd-state2\/remudero \(scratch-checkouts on\)/);
  assert.deepEqual(plan(h, "remudero-site-daemon").args.slice(0, 2), ["-v", `${checkout}:${CHECKOUT_DEST}`], "every build daemon, keyed by its own state dir");
  assert.equal(plan(h, "remudero-daemon", { RMD_SCRATCH_CHECKOUTS: "off" }).args.length, 24, "RMD_SCRATCH_CHECKOUTS=off wins over the switch file");
  rmSync(h.env.RMD_SCRATCH_CHECKOUTS_SWITCH);
  assert.equal(plan(h, "remudero-daemon", { RMD_SCRATCH_CHECKOUTS: "on" }).args[1], `${checkout}:${CHECKOUT_DEST}`, "RMD_SCRATCH_CHECKOUTS=on turns it on without the file");
  writeFileSync(h.env.RMD_SCRATCH_CHECKOUTS_SWITCH, "");

  // The rendered fleet launcher binds it on a revival — the docker run -v list itself.
  const revived = revive(h);
  assert.equal(revived.status, 0, revived.out);
  assert.match(revived.dockerRun, new RegExp(`-v ${checkout}:${CHECKOUT_DEST} -v ${h.base}/worktrees:`), revived.dockerRun);
  assert.ok(existsSync(checkout), "the launcher made the dir the entrypoint clones into");

  // W1-T6110's drift reading, from the same plan: flipping the switch is what recycles each daemon.
  const exec = (cmd: string, args: string[]): string => cmd === "docker"
    ? JSON.stringify({ Mounts: [{ Source: h.state, Destination: "/home/node/Remudero", RW: true }], Env: [] })
    : execFileSync(cmd, args, { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env } });
  const drift = readMountPlanDrift(exec, REPO_ROOT, h.state, "remudero-daemon") ?? [];
  assert.deepEqual(drift.find((d) => d.target === CHECKOUT_DEST), { target: CHECKOUT_DEST, expected: checkout, actual: undefined });
});

test("W1-T9617: with the switch on serve code directory defaults under the scratch root", (t) => {
  const h = host(t);
  const serveRepo = join(h.base, "serve-repo");
  const on = dryRunServe(h);
  assert.equal(on.status, 0, on.out);
  assert.match(on.out, new RegExp(`-v ${serveRepo}:${CHECKOUT_DEST} `), "serve binds its own scratch checkout at its code path");
  assert.equal(on.out.split(`:${CHECKOUT_DEST} `).length, 2, "exactly one bind at the code path — the plan never adds the daemon's");
  const servePlan = plan(h, "remudero-serve");
  assert.deepEqual(servePlan.args, todaysArgs(h, "remudero-serve"), "serve's own launcher binds the code dir; the scratch plan only records it");
  assert.ok(servePlan.dirs.includes(serveRepo), "recorded, so the boot-time restore re-creates it after a deallocate");
  assert.equal(existsSync(serveRepo), false, "a dry run creates no directory");

  const explicit = join(h.root, "my-serve-code");
  const pinned = dryRunServe(h, { RMD_SERVE_REPO_DIR: explicit });
  assert.equal(pinned.status, 0, pinned.out);
  assert.match(pinned.out, new RegExp(`-v ${explicit}:${CHECKOUT_DEST} `), "an explicit RMD_SERVE_REPO_DIR still wins");

  const daemonCheckout = join(h.base, "remudero");
  mkdirSync(daemonCheckout, { recursive: true });
  const shared = dryRunServe(h, { RMD_SERVE_REPO_DIR: daemonCheckout });
  assert.notEqual(shared.status, 0, "serve may never load the daemon's scratch checkout");
  assert.match(shared.out, /REFUSING — serve code directory is the daemon checkout/);

  rmSync(h.env.RMD_SCRATCH_CHECKOUTS_SWITCH);
  const off = dryRunServe(h);
  assert.equal(off.status, 0, off.out);
  assert.match(off.out, new RegExp(`-v ${h.root}/rmd-serve-repo:${CHECKOUT_DEST} `), "switched off, the default is today's ~/rmd-serve-repo");
});

test("W1-T9617: with the switch off the scratch plan is unchanged", (t) => {
  const h = host(t, { checkouts: false });
  for (const container of ["remudero-daemon", "remudero-site-daemon", "remudero-console-daemon", "remudero-serve"]) {
    const off = plan(h, container);
    assert.deepEqual(off.args, todaysArgs(h, container), `${container}: byte-identical docker arguments`);
    assert.doesNotMatch(off.binds, /remudero\t|serve-repo/, `${container}: no checkout line in the bind list the drift reading compares`);
    assert.doesNotMatch(off.dirs.join("\n"), /\/remudero$|serve-repo/, `${container}: no checkout dir to create or record`);
    assert.doesNotMatch(off.note, /code checkout/);
  }
  const prepared = lib(h, `scratch_plan "$1" remudero-daemon && scratch_prepare && cat "$1/.scratch-mounts"`, [h.state]);
  assert.deepEqual(prepared.stdout.trim().split("\n"), todaysArgs(h, "remudero-daemon").filter((a, i, all) => all[i - 1] === "-v").map((a) => a.split(":")[0]).sort(), "the manifest is today's");
  assert.equal(existsSync(join(h.base, "remudero")), false);

  // No drift on merge: a daemon launched before this task reads as current under the new library.
  const live = todaysArgs(h, "remudero-daemon").filter((a, i, all) => all[i - 1] === "-v").map((a) => ({ Source: a.split(":")[0], Destination: a.split(":")[1], RW: true }));
  const env = todaysArgs(h, "remudero-daemon").filter((a, i, all) => all[i - 1] === "-e");
  const exec = (cmd: string, args: string[]): string => cmd === "docker"
    ? JSON.stringify({ Mounts: [{ Source: h.state, Destination: "/home/node/Remudero", RW: true }, ...live], Env: env })
    : execFileSync(cmd, args, { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env } });
  assert.deepEqual(readMountPlanDrift(exec, REPO_ROOT, h.state, "remudero-daemon"), [], "a merge recycles nothing");

  // A test process never reads the host's real switch file: only an explicit path turns it on.
  const hostSwitch = { ...withoutRegistrySelection(process.env), ...h.env, NODE_TEST_CONTEXT: "child-v8" } as NodeJS.ProcessEnv;
  delete hostSwitch.RMD_SCRATCH_CHECKOUTS_SWITCH;
  delete hostSwitch.RMD_SCRATCH_CHECKOUTS;
  assert.equal(spawnSync("bash", ["-c", `. "${LIB}"; scratch_checkouts_enabled`], { env: hostSwitch }).status, 1);

  // The checkouts switch alone moves nothing: it only adds to a scratch plan that is already on.
  writeFileSync(join(h.root, "scratch-checkouts.on"), "");
  assert.deepEqual(plan(h, "remudero-daemon", { RMD_SCRATCH: "off" }).args, []);
  assert.equal(lib(h, `scratch_daemon_checkout "$1" remudero-daemon`, [h.state], { RMD_SCRATCH: "off" }).stdout.trim(), join(h.state, "remudero"));
});

test("W1-T9617: a boot with the scratch checkout missing re-creates it and the recycle does not refuse", (t) => {
  const h = host(t);
  const checkout = join(h.base, "remudero");
  // A launch recorded it; a deallocate wiped the whole scratch disk.
  const prepared = lib(h, `scratch_plan "$1" remudero-daemon && scratch_prepare && echo ok`, [h.state]);
  assert.match(prepared.stdout, /ok/, prepared.stderr);
  assert.ok(readFileSync(join(h.state, ".scratch-mounts"), "utf8").split("\n").includes(checkout));
  rmSync(join(h.scratch, "rmd"), { recursive: true, force: true });

  // 1. docker's ExecStartPre re-creates it, empty.
  const restored = spawnSync("bash", [LIB, "--restore", h.state], { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env } });
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(readdirSync(checkout), [], "re-created empty, as a bind the entrypoint can clone into");

  // 2. The entrypoint's existing clone path fills the empty bind (deploy/entrypoint.sh is not edited).
  const origin = gitRepo({ kind: "hot-origin" });
  t.after(() => origin.cleanup());
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"));
  writeFileSync(join(origin.dir, "bin", "rmd"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  origin.git("add", "-A");
  origin.git("commit", "--quiet", "-m", "c1");
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hot-home-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tree = join(home, "Remudero", "remudero");
  mkdirSync(tree, { recursive: true }); // the bind mount point: present and empty
  const stubs = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hot-npm-`));
  t.after(() => rmSync(stubs, { recursive: true, force: true }));
  writeFileSync(join(stubs, "npm"), `#!/usr/bin/env bash\necho "npm $*" >> "${stubs}/npm.log"\nif [ "$1" = ci ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(stubs, "npm"), 0o755);
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RMD_") && !/^(GH_APP_|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)));
  const boot = spawnSync("bash", [join(REPO_ROOT, "deploy", "entrypoint.sh"), "true"], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
    env: { ...ambient, PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home, RMD_REPO_URL: origin.dir, RMD_REF: "main", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(boot.status, 0, boot.stdout + boot.stderr);
  assert.match(boot.stdout + boot.stderr, /no work tree at .* — cloning/, "the empty bind takes the clone path");
  assert.ok(existsSync(join(tree, ".git")) && existsSync(join(tree, "bin", "rmd")), "the clone landed in the bind");
  assert.match(readFileSync(join(stubs, "npm.log"), "utf8"), /^npm ci$/m, "and the install ran");

  // 3. The recycle reads a recorded, empty scratch checkout as a re-clone — no data-disk checkout at all.
  rmSync(checkout, { recursive: true, force: true }); // even missing: the launch re-creates it
  const run = recycle(h, h.state);
  assert.equal(run.status, 0, run.out);
  assert.doesNotMatch(run.out, /does not look like a real checkout/);
  assert.match(run.out, /is a recorded scratch checkout with no \.git — the boot re-clones it/);
  assert.ok(run.dockerRun.includes(`${checkout}:${CHECKOUT_DEST}`), run.dockerRun);
  assert.ok(existsSync(checkout), "the launch re-created the dir");
  const row = placementRows(h.state).find((r) => r.step === "recycle.checkout_placement");
  assert.ok(row, "the recycle recorded the placement");
  assert.equal(row.placement, "scratch");
  assert.equal(row.checkout, checkout);
  assert.equal(row.cold, true, "an empty checkout is a cold re-clone");
  assert.equal(row.checkouts_switch, "on");

  // Controls: an unrecorded empty placement still refuses, and so does a state dir with no state/.
  const unrecorded = join(h.root, "rmd-state3");
  mkdirSync(join(unrecorded, "state"), { recursive: true });
  const refused = recycle(h, unrecorded);
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /does not look like a real checkout/);
  rmSync(join(h.state, "state"), { recursive: true, force: true });
  const noState = recycle(h, h.state);
  assert.notEqual(noState.status, 0);
  assert.match(noState.out, /state is MISSING/);
});

test("W1-T9617: host consumers resolve the live checkout and the cleanup protects it", (t) => {
  const h = host(t);
  const scratchCheckout = join(h.base, "remudero");
  const stale = join(h.state, "remudero");

  // The resolver: what the RUNNING container binds; its own copy when it binds none; else the plan.
  const stubs = join(h.root, "inspect-stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash\ncase "$STUB_DOCKER" in\n  scratch) printf '/home/node/Remudero\\t%s\\n${CHECKOUT_DEST}\\t%s\\n' "${h.state}" "${scratchCheckout}" ;;\n  disk) printf '/home/node/Remudero\\t%s\\n' "${h.state}" ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
  chmodSync(join(stubs, "docker"), 0o755);
  const live = (mode: string, env: Record<string, string> = {}) =>
    lib(h, `scratch_live_checkout "$1" remudero-daemon`, [h.state], { PATH: `${stubs}:${process.env.PATH ?? ""}`, STUB_DOCKER: mode, ...env }).stdout.trim();
  assert.equal(live("scratch"), scratchCheckout, "a container bound to scratch is read on scratch");
  assert.equal(live("disk"), stale, "before its recycle, the running container still uses the state disk's copy");
  assert.equal(live("absent"), scratchCheckout, "no container: the next launch's placement");
  assert.equal(live("absent", { RMD_SCRATCH_CHECKOUTS: "off" }), stale);

  // The fleet launcher's tick runs the live tree's bin/rmd, never the stale copy's.
  for (const [dir, logName] of [[scratchCheckout, "live.log"], [stale, "stale.log"]] as const) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "rmd"), `#!/usr/bin/env bash\necho "$*" >> "${h.root}/${logName}"\nexit 0\n`, { mode: 0o755 });
    chmodSync(join(dir, "bin", "rmd"), 0o755);
  }
  const tickStubs = join(h.root, "tick-stubs");
  mkdirSync(tickStubs, { recursive: true });
  writeFileSync(join(tickStubs, "docker"), `#!/usr/bin/env bash\ncase "$1" in\n  ps) echo fake-container-id ;;\n  inspect) case "$*" in *Mounts*) printf '/home/node/Remudero\\t%s\\n${CHECKOUT_DEST}\\t%s\\n' "${h.state}" "${scratchCheckout}" ;; esac ;;\nesac\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(tickStubs, "docker"), 0o755);
  const render = join(h.root, "render");
  const installed = spawnSync("bash", [join(REPO_ROOT, "deploy", "install-host-units.sh"), "--install"], {
    cwd: REPO_ROOT, encoding: "utf8",
    env: { ...withoutRegistrySelection(process.env), RMD_STATE_DIR: h.state, RMD_UNIT_DIR: join(render, "systemd"), RMD_BIN_DIR: join(render, "bin"), RMD_LAUNCHER_PATH: join(render, "rmd-relaunch.sh"), RMD_REVIVAL_LOG: join(render, "revivals.log"), RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(installed.status, 0, installed.stderr);
  const tick = spawnSync("bash", [join(render, "rmd-relaunch.sh")], { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env, PATH: `${tickStubs}:${process.env.PATH ?? ""}` } });
  assert.equal(tick.status, 0, tick.stdout + tick.stderr);
  const liveLog = existsSync(join(h.root, "live.log")) ? readFileSync(join(h.root, "live.log"), "utf8") : "";
  assert.match(liveLog, /progress-watchdog/, "the verdict comes from the live checkout");
  assert.match(liveLog, /deploy-run --image-drift-only/, "and so does deploy-run");
  assert.equal(existsSync(join(h.root, "stale.log")), false, "the data disk's stale copy is never run");

  // A cold re-clone in progress: no bin/rmd yet, so the tick skips by name and does not fail.
  rmSync(join(scratchCheckout, "bin"), { recursive: true, force: true });
  const cold = spawnSync("bash", [join(render, "rmd-relaunch.sh")], { encoding: "utf8", env: { ...withoutRegistrySelection(process.env), ...h.env, PATH: `${tickStubs}:${process.env.PATH ?? ""}` } });
  assert.equal(cold.status, 0, cold.stdout + cold.stderr);
  assert.match(cold.stdout, new RegExp(`its checkout ${scratchCheckout} has no bin/rmd yet`));
  assert.equal(existsSync(join(h.root, "stale.log")), false);

  // host-update's git reclaim targets the checkout the next launch binds.
  mkdirSync(join(scratchCheckout, ".git"), { recursive: true });
  const reclaimStubs = join(h.root, "reclaim-stubs");
  const dockerRoot = join(h.root, "docker-root");
  mkdirSync(reclaimStubs, { recursive: true });
  mkdirSync(dockerRoot, { recursive: true });
  // No fleet container is running and every prune frees nothing: the real docker is never reached.
  writeFileSync(join(reclaimStubs, "docker"), `#!/usr/bin/env bash\ncase "$1 $2" in\n  "info --format") echo "${dockerRoot}"; exit 0 ;;\n  "system df") echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;\nesac\ncase "$1" in\n  image|builder) [ "$2" = inspect ] || echo "Total reclaimed space: 0B"; exit 0 ;;\nesac\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(reclaimStubs, "docker"), 0o755);
  const reclaim = spawnSync("bash", [join(REPO_ROOT, "deploy", "host-update.sh"), "--reclaim-only", "--dry-run"], {
    cwd: REPO_ROOT, encoding: "utf8",
    env: { ...withoutRegistrySelection(process.env), ...h.env, HOME: h.root, PATH: `${reclaimStubs}:${process.env.PATH ?? ""}`, RMD_STATE_DIR: h.state, RMD_OP_DIR: join(h.root, "no-op-dir") },
  });
  assert.match(reclaim.stdout + reclaim.stderr, new RegExp(`git reclaim \\(DRY RUN\\) — ${scratchCheckout}: would`), reclaim.stdout + reclaim.stderr);

  // The janitor keeps a live scratch checkout even when it is idle, clean, published and unlisted.
  const fx = cleanupFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const { main } = cleanupRepos(fx);
  const key = join(fx.scratch, "rmd", "rmd-state2");
  mkdirSync(key, { recursive: true });
  const daemonCheckout = join(key, "remudero");
  const serveCheckout = join(key, "serve-repo");
  cleanupGit(fx.root, "clone", main, daemonCheckout);
  cleanupGit(fx.root, "clone", main, serveCheckout);
  const idleUnit = join(key, "an-idle-unit");
  mkdirSync(idleUnit);
  writeFileSync(join(idleUnit, "data"), "x");
  age(key);
  const swept = runCleanup(fx, { RMD_SCRATCH_ROOT: fx.scratch, RMD_CLEANUP_SCRATCH_ROOTS: key, RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS: "" });
  assert.equal(swept.status, 0, swept.stderr + swept.stdout);
  assert.equal(existsSync(idleUnit), false, `control: the pass did sweep this root\n${swept.stdout}`);
  for (const p of [daemonCheckout, serveCheckout]) {
    assert.ok(existsSync(join(p, ".git")), `${p} survives\n${swept.stdout}`);
    assert.ok(swept.stdout.includes(`KEEP ${p}: protected by janitor configuration`), swept.stdout);
  }
});

test("W1-T9617: the ledger and state files stay on the state disk", (t) => {
  const h = host(t);
  for (const container of ["remudero-daemon", "remudero-serve"]) {
    const on = plan(h, container);
    for (const line of on.binds.split("\n").filter(Boolean)) {
      const [src, dest] = line.split("\t");
      assert.ok(src.startsWith(`${h.scratch}/rmd/`), `${container}: every source is on scratch: ${src}`);
      assert.ok(dest !== "/home/node/Remudero" && !dest.startsWith("/home/node/Remudero/state"), `${container}: never the state root or state/: ${dest}`);
    }
  }
  const prepared = lib(h, `scratch_plan "$1" remudero-daemon && scratch_prepare && echo ok`, [h.state]);
  assert.match(prepared.stdout, /ok/, prepared.stderr);
  assert.ok(statSync(join(h.state, ".scratch-mounts")).isFile(), "the restore's manifest is written on the state disk");
  assert.equal(existsSync(join(h.base, ".scratch-mounts")), false);

  // The recycle still binds the state dir itself, and appends its row to the state disk's ledger.
  mkdirSync(join(h.state, "remudero", ".git"), { recursive: true }); // the data-disk copy, kept as the rollback
  const run = recycle(h, h.state);
  assert.equal(run.status, 0, run.out);
  assert.ok(run.dockerRun.includes(`${h.state}:/home/node/Remudero`), run.dockerRun);
  const row = placementRows(h.state).find((r) => r.step === "recycle.checkout_placement");
  assert.ok(row, "the row lands in <state-dir>/state/ledger.ndjson");
  assert.equal(row.cold, true, "the scratch checkout starts empty the first time");
  assert.ok(existsSync(join(h.state, "remudero", ".git")), "the old checkout stays where it was");
});

test("W1-T9617: a recycle records disk reads and exact generation age on a hermetic Linux host fixture", (t) => {
  const h = host(t);
  const sys = join(h.root, "sys-dev-block");
  const cg = join(h.root, "cgroup");
  const id = "b50a4f38500c" + "0".repeat(52);
  for (const [mm, name, part] of [["259:1", "nvme0n1", false], ["259:7", "nvme1n1", false], ["259:6", "nvme0n1p1", true]] as const) {
    mkdirSync(join(sys, mm), { recursive: true });
    writeFileSync(join(sys, mm, "uevent"), `MAJOR=259\nDEVNAME=${name}\n`);
    if (part) writeFileSync(join(sys, mm, "partition"), "1\n");
  }
  mkdirSync(join(cg, "system.slice", `docker-${id}.scope`), { recursive: true });
  writeFileSync(join(cg, "system.slice", `docker-${id}.scope`, "io.stat"), "259:1 rbytes=73570668544 wbytes=1 rios=2592899 wios=2 dbytes=0 dios=0\n259:7 rbytes=4096 wbytes=0 rios=1 wios=0 dbytes=0 dios=0\n8:0 garbage\n");
  const stubs = join(h.root, "io-stubs");
  mkdirSync(stubs, { recursive: true });
  // This is a simulated Linux host, including its GNU tool protocol. Neither the wall clock nor
  // the machine running the test determines the fixture's age or major:minor device identity.
  const startedAt = "2026-10-15T10:36:52.114786881Z";
  const startedSeconds = Math.floor(Date.parse(startedAt) / 1000);
  const nowSeconds = startedSeconds + 600;
  const calls = join(h.root, "io-tool-calls");
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash\n[ "$STUB_DOCKER" = up ] || exit 1\necho "${id} ${startedAt}"\n`, { mode: 0o755 });
  writeFileSync(join(stubs, "date"), `#!/usr/bin/env bash
printf 'date %s\\n' "$*" >> "${calls}"
if [ "$#" -eq 4 ] && [ "$1" = -u ] && [ "$2" = -d ] && [ "$4" = +%s ]; then
  [ "$3" = '${startedAt}' ] && [ "\${STUB_DATE_PARSE:-ok}" = ok ] || exit 1
  echo '${startedSeconds}'
elif [ "$#" -eq 2 ] && [ "$1" = -u ] && [ "$2" = +%s ]; then
  echo "\${STUB_DATE_NOW:-${nowSeconds}}"
elif [ "$#" -eq 2 ] && [ "$1" = -u ] && [ "$2" = +%Y-%m-%dT%H:%M:%S.000Z ]; then
  echo '${new Date(nowSeconds * 1000).toISOString()}'
else
  exit 64
fi
`, { mode: 0o755 });
  writeFileSync(join(stubs, "stat"), `#!/usr/bin/env bash
printf 'stat %s\\n' "$*" >> "${calls}"
[ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = '%Hd:%Ld' ] && [ -e "$3" ] || exit 64
echo '259:6'
`, { mode: 0o755 });
  chmodSync(join(stubs, "docker"), 0o755);
  chmodSync(join(stubs, "date"), 0o755);
  chmodSync(join(stubs, "stat"), 0o755);
  const env = { PATH: `${stubs}:${process.env.PATH ?? ""}`, RMD_SYS_DEV_BLOCK: sys, RMD_CGROUP_ROOT: cg, STUB_DOCKER: "up" };
  const reads = lib(h, `scratch_outgoing_reads remudero-daemon`, [], env).stdout;
  const parsed = JSON.parse(`{${reads}}`) as { outgoing_age_s: number | null; outgoing_reads: Record<string, { rios: number; rbytes: number }> };
  assert.deepEqual(parsed.outgoing_reads, { nvme0n1: { rios: 2592899, rbytes: 73570668544 }, nvme1n1: { rios: 1, rbytes: 4096 } }, "whole disks, by name; a malformed line is skipped");
  assert.equal(parsed.outgoing_age_s, 600, "the exact generation age, independent of host tools and wall time");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    `date -u -d ${startedAt} +%s`, "date -u +%s", "date -u +%s",
  ], "the real library must request the GNU parsing and clock protocol, not a canned age");
  const unknownClocks: Record<string, string>[] = [{ STUB_DATE_PARSE: "unreadable" }, { STUB_DATE_NOW: String(startedSeconds - 1) }];
  for (const clock of unknownClocks) {
    const unknown = JSON.parse(`{${lib(h, "scratch_outgoing_reads remudero-daemon", [], { ...env, ...clock }).stdout}}`);
    assert.equal(unknown.outgoing_age_s, null, "an unreadable or future start is unknown, never zero");
    assert.deepEqual(unknown.outgoing_reads, parsed.outgoing_reads, "unknown age preserves actual fixture I/O counters");
  }
  assert.equal(lib(h, `scratch_outgoing_reads remudero-daemon || echo unread`, [], { ...env, STUB_DOCKER: "down" }).stdout.trim(), "unread");
  assert.equal(lib(h, `scratch_outgoing_reads remudero-daemon || echo unread`, [], { ...env, RMD_CGROUP_ROOT: join(h.root, "no-cgroup") }).stdout.trim(), "unread");

  // A partition resolves to its whole disk; the row is one parseable line with the outgoing reads.
  writeFileSync(join(sys, "259:6", "uevent"), "DEVNAME=fakedisk1p1\n");
  writeFileSync(join(sys, "uevent"), "DEVNAME=fakedisk1\n"); // <sys>/<maj:min>/.. is the partition's disk
  const ledger = join(h.state, "state", "ledger.ndjson");
  mkdirSync(join(h.state, "remudero"));
  lib(h, `scratch_placement_row "$1" remudero-daemon "$2" false "$3"`, [ledger, join(h.state, "remudero"), reads], env);
  lib(h, `scratch_placement_row "$1" remudero-daemon "$2" maybe ""`, [ledger, join(h.base, "remudero")], { ...env, RMD_SYS_DEV_BLOCK: join(h.root, "no-sys") });
  const rows = placementRows(h.state);
  assert.ok(readFileSync(calls, "utf8").includes(`stat -c %Hd:%Ld ${join(h.state, "remudero")}\n`), "the real disk reader queries the fixture's existing checkout");
  assert.ok(readFileSync(calls, "utf8").includes("date -u +%Y-%m-%dT%H:%M:%S.000Z\n"), "the real placement writer requests its timestamp");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].placement, "state-disk");
  assert.equal(rows[0].checkout_disk, "fakedisk1", "a partition is named by its whole disk, the unit io.stat counts");
  assert.deepEqual(rows[0].outgoing_reads, parsed.outgoing_reads);
  assert.equal(rows[0].cold, false);
  assert.equal(rows[1].placement, "scratch");
  assert.equal(rows[1].checkout_disk, null, "an unreadable disk is null, never a guess");
  assert.equal(rows[1].cold, null);
  assert.equal(rows[1].outgoing_reads, undefined, "no outgoing generation read, no field");
  lib(h, `scratch_placement_row "$1" remudero-daemon x true ""`, [join(h.root, "no-such-dir", "ledger.ndjson")]);
  assert.equal(existsSync(join(h.root, "no-such-dir")), false, "a missing ledger dir is never created");
});

// ── recycle harness: stub docker/az, no container yet, a pull and a run that succeed ─────────────

interface RecycleRun { status: number | null; out: string; dockerRun: string }

function recycle(h: Host, stateDir: string): RecycleRun {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hot-recycle-`));
  const claude = join(dir, "claude");
  mkdirSync(claude);
  const rec = join(dir, "calls");
  // The runtime contract reads the started container's mounts: report exactly what docker run was given.
  const docker = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${rec}"`,
    'case "$1" in',
    "  run) shift; prev=''; for a in \"$@\"; do if [ \"$prev\" = -v ]; then printf '%s\\n' \"$a\" >> \"" + dir + "/binds\"; fi; prev=\"$a\"; done; exit 0 ;;",
    "  image) echo sha256:PULLEDID; exit 0 ;;",
    "  inspect)",
    '    fmt=""; [ "$2" = --format ] && fmt="$3"',
    '    [ -n "$fmt" ] || exit 1',
    '    case "$fmt" in',
    `      *Mounts*) while IFS= read -r b; do s="\${b%%:*}"; r="\${b#*:}"; d="\${r%%:*}"; rw=true; case "$r" in *:ro) rw=false ;; esac; printf '%s\\t%s\\t%s\\n' "$s" "$d" "$rw"; done < "${dir}/binds"; exit 0 ;;`,
    "      *.Image*) echo sha256:PULLEDID; exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...withoutRegistrySelection(process.env), ...h.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    HOME: dir,
    RMD_STATE_DIR: stateDir,
    RMD_CLAUDE_DIR: claude,
    RMD_CODEX_DIR: join(dir, "absent-codex"),
    RMD_CONTAINER_CONFIG_DIR: join(dir, "absent-config"),
    RMD_OPENWEIGHT_API_KEY_PATH: join(dir, "absent-key"),
    RMD_RECYCLE_WAIT_S: "1",
    RMD_RECYCLE_POLL_S: "1",
    RMD_RECYCLE_SKIP_RECLAIM: "1",
    RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-dockerenv"),
    GH_TOKEN: "fixture-token",
    GH_APP_ID: "",
    GH_APP_INSTALLATION_ID: "",
    GH_APP_PRIVATE_KEY_PATH: "",
  };
  delete env.RMD_RECYCLE_FIRST_BOOT;
  const r = spawnSync("bash", [legacyHostScript(dir, join(REPO_ROOT, "deploy", "recycle-container.sh"))], { cwd: REPO_ROOT, encoding: "utf8", env, timeout: 120_000 });
  const calls = existsSync(rec) ? readFileSync(rec, "utf8").split("\n") : [];
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dockerRun: calls.find((l) => l.startsWith("run ")) ?? "" };
}

function placementRows(stateDir: string): Array<Record<string, unknown>> {
  const file = join(stateDir, "state", "ledger.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"step":"recycle.checkout_placement"')).map((l) => JSON.parse(l) as Record<string, unknown>);
}
