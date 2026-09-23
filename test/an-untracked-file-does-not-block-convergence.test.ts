import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "deploy/install-host-units.sh";
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

type World = { root: string; launcher: string; checkout: string; calls: string; bin: string };

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "rmd-converge-untracked-"));
  const bin = join(root, "bin");
  const checkout = join(root, "daemon-install");
  const calls = join(root, "installer-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(checkout, "deploy"), { recursive: true });
  writeFileSync(join(checkout, "tracked.txt"), "clean\n");
  writeFileSync(join(checkout, "deploy", "install-host-units.sh"), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
  chmodSync(join(checkout, "deploy", "install-host-units.sh"), 0o755);
  execFileSync("git", ["-C", checkout, "init", "-q", "-b", "main"], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["-C", checkout, "add", "-A"], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["-C", checkout, "commit", "-qm", "seed"], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["-C", checkout, "update-ref", "refs/remotes/origin/main", "HEAD"], { env: { ...process.env, ...GIT_ENV } });
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("docker", 'if [ "$1" = ps ]; then echo healthy; fi; exit 0');
  stub("sudo", 'if [ "$1" = "-n" ]; then shift; fi; if [ "$1" = true ]; then exit 0; fi; if [ "$1" = env ]; then shift; fi; exec env "$@"');
  stub("findmnt", "exit 0");
  const render = spawnSync("bash", [SCRIPT, "--install"], {
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
  assert.equal(render.status, 0, `launcher render failed: ${render.stderr}`);
  return { root, launcher: join(root, "rmd-relaunch.sh"), checkout, calls, bin };
}

function tick(w: World, now = "1000000000") {
  writeFileSync(join(w.bin, "date"), `#!/usr/bin/env bash\nprintf '%s\\n' '${now}'\n`);
  chmodSync(join(w.bin, "date"), 0o755);
  return spawnSync("bash", [w.launcher], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, PATH: `${w.bin}:${process.env.PATH}` },
  });
}

function withWorld(fn: (w: World) => void) {
  const w = world();
  try { fn(w); } finally { rmSync(w.root, { recursive: true, force: true }); }
}

test("W1-T4076: an untracked file does not block convergence", () => {
  withWorld((w) => {
    writeFileSync(join(w.checkout, "feedback.yaml"), "untracked\n");
    const result = tick(w);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /not converging/);
    assert.ok(existsSync(w.calls), "the clean tracked checkout reaches the installer's check");
    assert.equal(readFileSync(w.calls, "utf8"), "\n", "the installer check runs with no install arguments");
  });
});

test("W1-T4076: a tracked change still refuses", () => {
  withWorld((w) => {
    writeFileSync(join(w.checkout, "tracked.txt"), "edited\n");
    const result = tick(w);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tracked changes/);
    assert.match(result.stdout, /tracked\.txt/);
    assert.equal(existsSync(w.calls), false, "a tracked edit never reaches the installer");
  });
});

test("W1-T4076: a long refusal raises one alert", () => {
  withWorld((w) => {
    writeFileSync(join(w.checkout, "tracked.txt"), "edited\n");
    const first = tick(w, "1000000000");
    assert.doesNotMatch(first.stderr, /ALERT/, "the initial refusal starts the timer without alerting");
    const later = tick(w, "1000021600");
    assert.match(later.stderr, /ALERT.*6 hours/);
    assert.match(later.stderr, /tracked\.txt/, "the alert identifies the refusing path");
    const repeated = tick(w, "1000040000");
    assert.doesNotMatch(repeated.stderr, /ALERT/, "the same continuous refusal raises only one alert");
  });
});

test("W1-T4076: a refusal with no state directory yet neither leaks nor loses the stamp", () => {
  withWorld((w) => {
    // The stamp's directory is NOT guaranteed to exist — `world()` above happens to pre-create it,
    // which is exactly why this arm went unseen. A `>` redirection into a missing directory fails
    // in the SHELL before the command runs, so the trailing `2>/dev/null || true` cannot suppress
    // it: the launcher printed "No such file or directory" to its own stderr on EVERY refusing
    // tick, and never recorded the stamp the 6-hour alert is measured from.
    rmSync(join(w.root, "state"), { recursive: true, force: true });
    writeFileSync(join(w.checkout, "tracked.txt"), "edited\n");

    const first = tick(w, "1000000000");
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stderr, /No such file or directory/, "the refusal path must not leak a shell redirection error");
    assert.ok(existsSync(join(w.root, "state", "units-converge-refused-since")), "and the stamp the alert is measured from must actually be written");

    // The stamp being real is what makes the alert reachable at all from a bare state root.
    const later = tick(w, "1000021600");
    assert.match(later.stderr, /ALERT.*6 hours/, "so a long refusal still alerts when the directory had to be created");
  });
});
