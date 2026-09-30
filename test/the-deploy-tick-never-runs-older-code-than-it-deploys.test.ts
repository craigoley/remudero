import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-09-29: the site's 19:06 deploy ran deploy logic from its daemon tree, still at the
// 13:09 boot commit, so a deployer fix merged at 15:26 never ran there. The tick ran
// "$STATE_DIR/remudero/bin/rmd" because the install checkout (daemon-install) had no node_modules.
// Convergence now keeps the install checkout runnable, and the tick prefers it, falling back to the
// daemon tree rather than stopping.

const SCRIPT = "deploy/install-host-units.sh";

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

interface Stage {
  root: string;
  stateDir: string;
  installDir: string;
  stubDir: string;
  installLog: string;
  daemonLog: string;
  npmLog: string;
  lockBlob: string;
}

function stage(npmSucceeds: boolean): Stage {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-code-`));
  const stateDir = join(root, "state");
  const installDir = join(stateDir, "daemon-install");
  mkdirSync(stateDir, { recursive: true });
  const installLog = join(root, "install-deploy-run.log");
  const daemonLog = join(root, "daemon-deploy-run.log");
  const npmLog = join(root, "npm.log");

  const origin = gitRepo({ bare: true, kind: "deploy-code-origin" });
  const seed = gitRepo({ kind: "deploy-code-seed" });
  mkdirSync(join(seed.dir, "deploy"), { recursive: true });
  mkdirSync(join(seed.dir, "bin"), { recursive: true });
  executable(join(seed.dir, "bin", "rmd"), `#!/usr/bin/env bash\necho "$PWD|$@" >> "${installLog}"\nexit 0\n`);
  executable(join(seed.dir, "deploy", "install-host-units.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(seed.dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  seed.addRemote("origin", origin.dir);
  seed.git("add", ".");
  seed.git("commit", "--quiet", "-m", "install checkout");
  seed.git("push", "--quiet", "origin", "main");
  execFileSync("git", ["clone", "--quiet", origin.dir, installDir]);
  const lockBlob = execFileSync("git", ["-C", installDir, "rev-parse", "HEAD:package-lock.json"], { encoding: "utf8" }).trim();

  const daemonBin = join(stateDir, "remudero", "bin");
  mkdirSync(daemonBin, { recursive: true });
  executable(join(daemonBin, "rmd"), `#!/usr/bin/env bash\necho "$@" >> "${daemonLog}"\nexit 0\n`);

  const stubDir = join(root, "stubbin");
  mkdirSync(stubDir, { recursive: true });
  executable(join(stubDir, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = "ps" ]; then echo fake-container-id; fi\nexit 0\n`);
  executable(join(stubDir, "sudo"), `#!/usr/bin/env bash\nif [ "\${1:-}" = "-n" ]; then shift; fi\nexec "$@"\n`);
  executable(
    join(stubDir, "npm"),
    npmSucceeds
      ? `#!/usr/bin/env bash\necho "$@" >> "${npmLog}"\nmkdir -p node_modules/.bin\nprintf '#!/usr/bin/env bash\\n' > node_modules/.bin/tsx\nchmod +x node_modules/.bin/tsx\nexit 0\n`
      : `#!/usr/bin/env bash\necho "$@" >> "${npmLog}"\nexit 1\n`,
  );
  return { root, stateDir, installDir, stubDir, installLog, daemonLog, npmLog, lockBlob };
}

function renderAndRun(s: Stage): { status: number | null; stderr: string } {
  const renderRoot = join(s.root, "render");
  mkdirSync(renderRoot, { recursive: true });
  const r = spawnSync("bash", [SCRIPT, "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_STATE_DIR: s.stateDir,
      RMD_UNIT_DIR: join(renderRoot, "systemd"),
      RMD_BIN_DIR: join(renderRoot, "bin"),
      RMD_LAUNCHER_PATH: join(renderRoot, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(renderRoot, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    },
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return spawnSync("bash", [join(renderRoot, "rmd-relaunch.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${s.stubDir}:${process.env.PATH}` },
  });
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

test("W1-T4844: the generated watchdog runs deploy-run from the install checkout", (t) => {
  const s = stage(true);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const r = renderAndRun(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(s.installLog), /deploy-run --image-drift-only/, "the install checkout's rmd must take the deploy");
  assert.equal(read(s.installLog).split("|")[0], s.installDir, "deploy-run must resolve repoRoot from the install checkout");
  assert.equal(read(s.daemonLog), "", "the daemon tree must not be asked once the install checkout can run");
});

test("W1-T4844: real deploy-run passes the install separation gate from the managed checkout", (t) => {
  const s = stage(true);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const home = join(s.root, "home");
  mkdirSync(home);
  const result = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), [
    join(process.cwd(), "src", "run-task.ts"), "deploy-run", "--dry-run", "--state-root", s.stateDir, "--repo-root", s.installDir,
  ], {
    cwd: s.installDir,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: home, GH_TOKEN: "test-token" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /resolves INSIDE the operator's own checkout/);
  assert.match(result.stdout, /### rmd deploy-run — no-op:/);
});

test("W1-T4844: convergence leaves the install checkout able to run rmd", (t) => {
  const s = stage(true);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  assert.equal(renderAndRun(s).status, 0);
  assert.equal(read(s.npmLog).trim().split("\n").filter(Boolean).length, 1, "npm ci runs once for a new lockfile");
  assert.match(read(s.npmLog), /^ci /m);
  assert.equal(read(join(s.installDir, "node_modules", ".rmd-lock-blob")).trim(), s.lockBlob);
  assert.equal(renderAndRun(s).status, 0);
  assert.equal(read(s.npmLog).trim().split("\n").filter(Boolean).length, 1, "an unchanged lockfile never reinstalls");
});

test("W1-T4844: a failed install leaves deploy-run on the daemon tree and never stops the tick", (t) => {
  const s = stage(false);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const r = renderAndRun(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(s.daemonLog), /deploy-run --image-drift-only/, "the daemon tree remains the fallback");
  assert.equal(read(s.installLog), "");
  assert.match(r.stderr, /npm ci in the install checkout failed/);
});

test("a failed reinstall cannot select an old install runtime that still has tsx", (t) => {
  const s = stage(true);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  assert.equal(renderAndRun(s).status, 0);
  writeFileSync(join(s.installDir, "node_modules", ".rmd-lock-blob"), "stale\n");
  executable(join(s.stubDir, "npm"), "#!/usr/bin/env bash\nexit 1\n");
  const r = renderAndRun(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(s.daemonLog), /deploy-run --image-drift-only/);
  assert.match(r.stderr, /npm ci in the install checkout failed/);
});

test("the runtime installer leaves a shared node_modules symlink untouched", (t) => {
  const s = stage(true);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const shared = join(s.root, "shared-modules");
  mkdirSync(shared);
  writeFileSync(join(shared, "sentinel"), "kept");
  symlinkSync(shared, join(s.installDir, "node_modules"));
  const r = renderAndRun(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(join(shared, "sentinel")), "kept");
  assert.equal(read(s.npmLog), "");
  assert.match(read(s.daemonLog), /deploy-run --image-drift-only/);
});
