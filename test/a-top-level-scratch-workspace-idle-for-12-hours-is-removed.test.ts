import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SCRIPT, age, fixture, git, repos, run, scratchDir } from "./helpers/host-cleanup-fixture.js";

test("test/a-top-level-scratch-workspace-idle-for-12-hours-is-removed.test.ts", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const idle = scratchDir(fx, "gate idle", false);
  git(fx.root, "clone", main, join(idle, "repo"));
  age(idle);
  const fresh = scratchDir(fx, "gate-fresh", false);
  const partly = scratchDir(fx, "gate-partly", true);
  writeFileSync(join(partly, "recent"), "x");
  const keep = scratchDir(fx, "gate-keep", false);
  writeFileSync(join(keep, ".rmd-scratch-keep"), "");
  age(keep);
  const cwd = scratchDir(fx, "gate-cwd", true);
  const fd = scratchDir(fx, "gate-fd", true);
  writeFileSync(fx.lsofList, `${cwd}\n${join(fd, "data")}\n`);
  const mount = scratchDir(fx, "gate-docker", true);
  const docker = join(fx.root, "bin", "docker");
  writeFileSync(docker, `#!/usr/bin/env bash\nif [ "$1" = ps ]; then echo container; else printf '%s\\n' '${mount}'; fi\n`);
  const never = ["swapfile", "lost+found", "rmd", "worktrees", "tmp", "npm-cache", "node-compile-cache", "node-v22-linux-x64", "tsx-cache", ".remudero-coverage", "state"]
    .map(name => scratchDir(fx, name, true));
  const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_ONLY_TMP: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(idle), false, r.stdout);
  for (const [p, reason] of [[fresh, "written within 720 min"], [partly, "written within 720 min"], [keep, "scratch keep marker"], [cwd, "held open by a process"], [fd, "held open by a process"], [mount, "running container mount"], ...never.map(p => [p, "protected scratch name"])]) {
    assert.equal(existsSync(p), true, p);
    assert.ok(r.stdout.includes(`KEEP ${p}: ${reason}`), r.stdout);
  }
});

test("scratch probes fail closed, including a docker failure with partial output", () => {
  for (const probe of ["find", "docker", "docker-inspect", "lsof"]) {
    const fx = fixture();
    const blind = scratchDir(fx, "gate-blind", true);
    const script = join(fx.root, "bin", probe === "docker-inspect" ? "docker" : probe);
    writeFileSync(script, `#!/usr/bin/env bash\n${probe === "docker-inspect" ? "if [ \"$1\" = ps ]; then echo container; exit 0; fi" : ""}\n${probe.startsWith("docker") ? "echo partial" : ""}\nexit 23\n`);
    chmodSync(script, 0o755);
    const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", PATH: `${join(fx.root, "bin")}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(blind), true);
    assert.ok(r.stdout.includes(`KEEP ${blind}:`), r.stdout);
    assert.match(r.stdout, probe === "find" ? /activity probe failed/ : probe.startsWith("docker") ? /docker.*failed/ : /held open by a process/);
  }
});

test("scratch dry run reports reclaimable bytes and the hourly wrapper enables the scratch pass", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "gate-idle", true);
  const options = { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "" };
  const dry = run(fx, { ...options, DRY_RUN: "1" });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(existsSync(idle), true);
  assert.ok(dry.stdout.includes(`REMOVE ${idle}`), dry.stdout);
  assert.match(dry.stdout, /would reclaim [1-9][0-9]* bytes/);
  assert.equal(existsSync(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT), false);
  const r = spawnSync("bash", ["deploy/rmd-tmp-sweep.sh"], { encoding: "utf8", env: { ...process.env, ...fx.env, ...options, RMD_HOST_CLEANUP_SCRIPT: join(process.cwd(), SCRIPT) } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(idle), false, r.stdout);
});

test("a protected nested checkout or dirty nested repo keeps the entire scratch unit", () => {
  for (const protectedRepo of [false, true]) {
    const fx = fixture();
    const { main } = repos(fx);
    const unit = scratchDir(fx, "gate", false);
    const repo = join(unit, "home", "checkout");
    mkdirSync(join(unit, "home"));
    git(fx.root, "clone", main, repo);
    if (!protectedRepo) writeFileSync(join(repo, "dirty"), "x");
    age(unit);
    const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS: protectedRepo ? repo : "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(unit), true);
    assert.match(r.stdout, protectedRepo ? /protected by janitor configuration/ : /uncommitted changes/);
  }
});
