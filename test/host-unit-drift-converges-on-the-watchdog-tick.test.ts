import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1-T3269 — THE THIRD CONVERGENCE QUESTION ON A TICK THAT ALREADY ASKS TWO.
//
// `deploy/install-host-units.sh` had NO automatic caller. Every reference to it in the tree was its
// own test, the operator guide and a size baseline — no workflow, no unit, no timer — so it
// converged only when a person remembered. MEASURED 2026-09-09: check mode on the live Azure host
// read DRIFTED against a checkout that was clean and exactly at origin/main. The code had shipped
// that morning; only the rendered artifact had not.
//
// These cases drive the RENDERED launcher against a stubbed installer, a stubbed docker and a
// stubbed sudo, so the DECISIONS run for real while nothing touches systemd. The installer's own
// behaviour is test/host-units-install.test.ts's job; what is under test here is which of its modes
// the tick calls, and — far more importantly — every case in which it calls neither.

const SCRIPT = "deploy/install-host-units.sh";
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

type World = { root: string; launcher: string; calls: string; revivals: string; checkout: string };

/** A host: a rendered launcher, a fake checkout at origin/main, and stubs for docker/sudo/git-less
 *  surfaces. `drift` decides what the stubbed installer's CHECK mode reports. */
function world(opts: { drift: boolean; daemonUp?: boolean }): World {
  const root = mkdtempSync(join(tmpdir(), "rmd-unitdrift-"));
  const bin = join(root, "bin");
  const checkout = join(root, "remudero");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(checkout, "deploy"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const calls = join(root, "calls.log");

  // The installer STUB. Check mode exits 1 on drift (the real one's contract); install mode exits 0.
  writeFileSync(
    join(checkout, "deploy", "install-host-units.sh"),
    `#!/usr/bin/env bash\necho "installer $* heap=\${RMD_NODE_MAX_OLD_SPACE_MB:-unset}" >> ${JSON.stringify(calls)}\n` +
      `if [ "\${1:-}" = "--install" ]; then exit 0; fi\nexit ${opts.drift ? 1 : 0}\n`,
  );
  chmodSync(join(checkout, "deploy", "install-host-units.sh"), 0o755);

  // A clean checkout sitting exactly at origin/main — the state convergence requires.
  execFileSync("git", ["-C", checkout, "init", "-q", "-b", "main"], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["-C", checkout, "add", "-A"], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["-C", checkout, "commit", "-qm", "seed"], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["-C", checkout, "update-ref", "refs/remotes/origin/main", "HEAD"], { env: { ...process.env, ...GIT_ENV } });

  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("docker", opts.daemonUp === false ? `echo "docker $*" >> ${JSON.stringify(calls)}; exit 0` : `if [ "$1" = ps ]; then echo deadbeef; fi; exit 0`);
  stub("sudo", `if [ "$1" = "-n" ]; then shift; fi\nif [ "$1" = true ]; then exit 0; fi\nif [ "$1" = env ]; then shift; fi\nexec env "$@"`);
  stub("findmnt", "exit 0");

  const r = spawnSync("bash", [SCRIPT, "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "unitbin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_STATE_DIR: root,
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    },
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /syntax error|command not found/, `renderer stderr: ${r.stderr}`);
  return { root, launcher: join(root, "rmd-relaunch.sh"), calls, revivals: join(root, "revivals.log"), checkout };
}

function tick(w: World, args: string[] = []) {
  const bin = join(w.root, "bin");
  return spawnSync("bash", [w.launcher, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` },
  });
}

const installerCalls = (w: World) => (existsSync(w.calls) ? readFileSync(w.calls, "utf8").trim().split("\n").filter(Boolean) : []);
const withWorld = (opts: { drift: boolean; daemonUp?: boolean }, fn: (w: World) => void) => {
  const w = world(opts);
  try {
    fn(w);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
};

test("W1-T3269: a healthy tick whose units already match runs the CHECK and installs nothing", () => {
  withWorld({ drift: false }, (w) => {
    const r = tick(w);
    assert.equal(r.status, 0, `tick failed: ${r.stderr}`);
    const calls = installerCalls(w);
    // The steady state is one cheap check and silence. That is what makes a converge event rare
    // enough to be worth a record, and what keeps a 5-minute timer free.
    assert.equal(calls.length, 1, `expected exactly one check call, got ${JSON.stringify(calls)}`);
    assert.doesNotMatch(calls[0], /--install/, "no drift means no install");
    assert.match(calls[0], /heap=8192/, "and the heap is passed through, never left to the installer's default");
  });
});

test("W1-T3269: a healthy tick that finds drift converges it and leaves a record", () => {
  withWorld({ drift: true }, (w) => {
    const r = tick(w);
    assert.equal(r.status, 0, `tick failed: ${r.stderr}`);
    const calls = installerCalls(w);
    assert.equal(calls.length, 2, `expected check THEN install, got ${JSON.stringify(calls)}`);
    assert.doesNotMatch(calls[0], /--install/, "the check runs first — install is never the opening move");
    assert.match(calls[1], /--install/, "and drift is actually converged");
    // An automated root write that leaves no evidence is worse than a manual one.
    assert.match(readFileSync(w.revivals, "utf8"), /units-converged sha=[0-9a-f]{7,}/, "the converge must be recorded with the sha it converged to");
  });
});

test("W1-T3269: convergence REFUSES on a dirty checkout and on one that is not at origin/main", () => {
  withWorld({ drift: true }, (w) => {
    writeFileSync(join(w.checkout, "uncommitted.txt"), "work in progress\n");
    const dirty = tick(w);
    assert.equal(installerCalls(w).length, 0, "a dirty tree must not even be checked, let alone installed");
    assert.match(dirty.stdout, /DIRTY/, "and the refusal must say so");
  });

  withWorld({ drift: true }, (w) => {
    // Move HEAD off the reviewed tree — the shape a worktree experiment leaves behind.
    execFileSync("git", ["-C", w.checkout, "commit", "-q", "--allow-empty", "-m", "local only"], { env: { ...process.env, ...GIT_ENV } });
    const ahead = tick(w);
    assert.equal(installerCalls(w).length, 0, "an unreviewed tree must never become root systemd config");
    assert.match(ahead.stdout, /not at origin\/main/, "and the refusal names the reason");
  });
});

test("W1-T3269: convergence REFUSES on the boot path and while state/STOP is present", () => {
  withWorld({ drift: true }, (w) => {
    tick(w, ["--boot"]);
    // A host coming up is the worst moment to rewrite its unit files — the same rule W1-T3245
    // applied to the recycle decision.
    assert.equal(installerCalls(w).length, 0, "boot revives from cache; it does not reconcile");
  });

  withWorld({ drift: true }, (w) => {
    writeFileSync(join(w.root, "state", "STOP"), "");
    const stopped = tick(w);
    assert.equal(installerCalls(w).length, 0, "the stop lever outranks every actor, this one included");
    assert.match(stopped.stdout, /state\/STOP present/);
  });
});

test("W1-T3269: a converge that cannot elevate reports and stands down, and a DOWN daemon is revived rather than tidied", () => {
  withWorld({ drift: true }, (w) => {
    // The tick runs as the service user while the unit dir is root-owned, so elevation is required
    // and is NEVER prompted for. A sudo that refuses `-n` is the shape of a host with no NOPASSWD
    // rule — deterministic here rather than dependent on the runner's own sudoers.
    writeFileSync(join(w.root, "bin", "sudo"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(w.root, "bin", "sudo"), 0o755);

    const r = tick(w);
    assert.equal(r.status, 0, "a failure to elevate must never fail the tick");
    const calls = installerCalls(w);
    assert.equal(calls.length, 1, `only the check may have run, got ${JSON.stringify(calls)}`);
    assert.ok(!calls.some((c) => c.includes("--install")), "it must not install when it cannot elevate");
    assert.match(r.stderr, /cannot elevate/, "and the stand-down must be legible, never silent");
  });

  withWorld({ drift: true, daemonUp: false }, (w) => {
    writeFileSync(join(w.root, "state", "ledger.ndjson"), '{"step":"seed"}\n');
    tick(w);
    // Nothing in the convergence path may run before the revive decision. A host that is DOWN needs
    // reviving, not tidying.
    assert.equal(installerCalls(w).filter((c) => c.startsWith("installer")).length, 0, "a down daemon is revived, never converged");
  });
});
