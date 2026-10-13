import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { age, fixture, git, repos, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

function clone(fx: Fixture, root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  git(root, "clone", "--quiet", join(fx.root, "origin.git"), path);
  return path;
}

function orphan(fx: Fixture): string {
  writeFileSync(join(fx.root, "bin/fsid"), `#!/bin/bash\ncase "$1" in '${fx.home}'/*|'${fx.scratch}'/*|'${fx.rootfs}') echo 1 ;; *) echo "\${FAKE_ARCHIVE_FSID:-2}" ;; esac\n`, { mode: 0o755 });
  const { main, addWorktree } = repos(fx);
  const path = addWorktree("orphan", "orphan");
  writeFileSync(join(path, "unsaved"), "recover this payload\n");
  for (const name of ["node_modules", "coverage"]) {
    mkdirSync(join(path, name));
    writeFileSync(join(path, name, "cache"), "disposable\n");
  }
  rmSync(main, { recursive: true, force: true });
  age(path, 7);
  return path;
}

function archives(fx: Fixture): string[] {
  const root = join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "orphans");
  return existsSync(root) ? readdirSync(root).filter(n => n.endsWith(".tar")).map(n => join(root, n)) : [];
}

test("W1-T8863: the janitor reclaims saved work idle six hours wherever it sits", () => {
  const fx = fixture();
  try {
    const abandoned = orphan(fx);
    const live = clone(fx, fx.home, "rmd-mint");
    const clean = clone(fx, live, "clean");
    const hidden = clone(fx, live, ".hidden-clone");
    const dirty = clone(fx, live, "dirty");
    writeFileSync(join(dirty, "README"), "local edits\n");
    const recent = clone(fx, live, "recent");
    age(clean, 7); age(hidden, 7); age(dirty, 7); age(recent, 5);

    const r = run(fx, { IDLE_MINUTES: "", RMD_CLEANUP_LIVE_CHECKOUTS: live });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(abandoned), false, r.stdout);
    assert.equal(existsSync(clean), false, r.stdout);
    assert.equal(existsSync(hidden), false, r.stdout);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(dirty), true);
    assert.equal(existsSync(recent), true);
    assert.equal(readFileSync(join(dirty, "README"), "utf8"), "local edits\n");
    assert.match(r.stdout, /retention idle 6 h, scratch 6 h, tsx 6 h/);
    const saved = archives(fx);
    assert.equal(saved.length, 1, r.stdout);
    const listing = execFileSync("tar", ["-tf", saved[0]], { encoding: "utf8" });
    assert.ok(listing.includes("./.git"), listing);
    assert.ok(listing.includes("./unsaved"), listing);
    assert.doesNotMatch(listing, /node_modules|coverage/);
    assert.equal(execFileSync("tar", ["-xOf", saved[0], "./unsaved"], { encoding: "utf8" }), "recover this payload\n");
    const audit = readFileSync(join(fx.home, ".local/state/remudero/janitor-audit.log"), "utf8");
    assert.ok(audit.includes(`ARCHIVE-WORKTREE ${abandoned}`), audit);
    assert.ok(audit.indexOf(`ARCHIVE-WORKTREE ${abandoned}`) < audit.indexOf(`REMOVE ${abandoned}`), audit);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("W1-T8863: six hours at every pressure tier, with shorter pins clamped and longer pins respected", () => {
  for (const [pct, pin, removed] of [[50, "", true], [70, "", true], [78, "", true], [82, "", true], [97, "", true], [50, "1", true], [50, "720", false]] as const) {
    const fx = fixture();
    try {
      const { addWorktree } = repos(fx);
      const path = addWorktree("aged", "aged");
      age(path, 7);
      const r = run(fx, { IDLE_MINUTES: pin, FAKE_DF_PCT: String(pct), RMD_CLEANUP_LIVE_CHECKOUTS: "" });
      assert.equal(r.status, pct >= 85 ? 1 : 0, r.stderr + r.stdout);
      assert.equal(existsSync(path), !removed, r.stdout);
      assert.match(r.stdout, pin === "720" ? /retention idle 12 h/ : /retention idle 6 h/);
      if (pin === "1") assert.match(r.stdout, /CLAMP IDLE_MINUTES=1 min/);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("W1-T8863: an orphan is kept when its parent clone survives or its metadata is malformed", () => {
  const fx = fixture();
  try {
    const { main, addWorktree } = repos(fx);
    const path = addWorktree("missing-gitdir", "missing-gitdir");
    const gitdir = readFileSync(join(path, ".git"), "utf8").trim().slice("gitdir: ".length);
    rmSync(gitdir, { recursive: true, force: true });
    age(path, 7);
    const r = run(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(main), true);
    assert.equal(existsSync(path), true, r.stdout);
    assert.deepEqual(archives(fx), []);
    writeFileSync(join(path, ".git"), "gitdir: /unknown/layout\n");
    age(path, 7);
    assert.equal(run(fx).status, 0);
    assert.equal(existsSync(path), true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("W1-T8863: archive failures, shared filesystems and dry runs preserve orphan payload", () => {
  for (const failure of ["same-fs", "create", "verify", "empty", "audit", "dry-run"]) {
    const fx = fixture();
    try {
      const path = orphan(fx);
      const env: Record<string, string> = { IDLE_MINUTES: "", RMD_CLEANUP_LIVE_CHECKOUTS: "" };
      if (failure === "same-fs") env.FAKE_ARCHIVE_FSID = "1";
      if (["create", "verify", "empty"].includes(failure)) {
        const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
        const shim = join(fx.root, "bin/tar");
        const body = failure === "create" ? "exit 2" : failure === "empty" ? 'if [ "$1" = -cf ]; then : > "$2"; exit 0; fi' : 'if [ "$1" = -tf ]; then exit 2; fi';
        writeFileSync(shim, `#!/bin/bash\n${body}\nexec '${realTar}' "$@"\n`, { mode: 0o755 });
        env.PATH = `${join(fx.root, "bin")}:${process.env.PATH}`;
      }
      if (failure === "audit") {
        const blocker = join(fx.root, "blocker");
        writeFileSync(blocker, "x");
        env.RMD_CLEANUP_AUDIT_LOG = join(blocker, "audit.log");
      }
      if (failure === "dry-run") env.DRY_RUN = "1";
      const r = run(fx, env);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(path), true, `${failure}: ${r.stdout}`);
      assert.equal(readFileSync(join(path, "unsaved"), "utf8"), "recover this payload\n");
      assert.deepEqual(archives(fx), [], failure);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("W1-T8863: new candidates keep active, held, mounted, locked and hosting work", () => {
  for (const gate of ["recent", "open", "container", "lsof-failed", "mount", "docker-failed", "locked", "hosting"]) {
    const fx = fixture();
    try {
      const abandoned = orphan(fx);
      const live = clone(fx, fx.home, "rmd-mint");
      const path = clone(fx, live, "candidate");
      age(path, 7);
      const env: Record<string, string> = { IDLE_MINUTES: "", RMD_CLEANUP_LIVE_CHECKOUTS: live };
      if (gate === "recent") { age(path, 5); age(abandoned, 5); }
      if (gate === "open") writeFileSync(fx.lsofList, `${join(path, "README")}\n${abandoned}\n`);
      if (gate === "container") {
        env.RMD_CLEANUP_CONTAINER_MAP = `${fx.root}:/container`;
        writeFileSync(fx.lsofList, `${path.replace(fx.root, "/container")}\n${abandoned.replace(fx.root, "/container")}/unsaved\n`);
      }
      if (gate === "lsof-failed") env.FAKE_LSOF_FAIL = "1";
      if (gate === "mount") writeFileSync(join(fx.root, "bin/docker"), `#!/bin/bash\nif [ "$1" = ps ]; then echo container; else printf '%s\\n' '${path}' '${abandoned}'; fi\n`, { mode: 0o755 });
      if (gate === "docker-failed") env.RMD_CLEANUP_DOCKER = "false";
      if (gate === "locked") writeFileSync(join(path, ".git/locked"), "keep\n");
      if (gate === "hosting") git(path, "worktree", "add", "-b", "hosted", join(fx.root, "hosted"), "origin/main");
      const r = run(fx, env);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(path), true, `${gate}: ${r.stdout}`);
      if (!["locked", "hosting"].includes(gate)) assert.equal(existsSync(abandoned), true, `${gate}: ${r.stdout}`);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("W1-T8863: nested scanning excludes tracked children, submodules, deeper clones and symlinks", () => {
  const fx = fixture();
  try {
    repos(fx);
    const live = clone(fx, fx.home, "rmd-mint");
    const tracked = join(live, "tracked");
    mkdirSync(tracked);
    writeFileSync(join(tracked, "keep"), "tracked payload\n");
    git(live, "add", "--", "tracked/keep");
    assert.ok(git(live, "ls-files").includes("tracked/keep"), "fixture tracks a file inside the child clone");
    git(tracked, "init", "-b", "main");
    const submodule = join(live, "submodule");
    git(live, "-c", "protocol.file.allow=always", "submodule", "add", join(fx.root, "origin.git"), submodule);
    const moduleGitdir = readFileSync(join(submodule, ".git"), "utf8").trim().slice("gitdir: ".length);
    rmSync(join(submodule, ".git"));
    renameSync(join(submodule, moduleGitdir), join(submodule, ".git"));
    git(live, "config", "--file", join(submodule, ".git/config"), "--unset", "core.worktree");
    const deep = clone(fx, join(live, "ordinary"), "deep");
    symlinkSync(tracked, join(live, "alias"));
    age(live, 7);
    const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: live, RMD_CLEANUP_WORKTREE_ROOTS: fx.home });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const path of [live, tracked, submodule, deep, join(live, "ordinary"), join(live, "alias")]) assert.equal(existsSync(path), true, r.stdout);
    for (const path of [tracked, submodule, deep, join(live, "ordinary"), join(live, "alias")]) assert.ok(!r.stdout.includes(path), r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("W1-T8863: orphan archives expire after archive retention", () => {
  const fx = fixture();
  try {
    orphan(fx);
    assert.equal(run(fx).status, 0);
    const saved = archives(fx);
    assert.equal(saved.length, 1);
    age(saved[0], 32 * 24);
    const r = run(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(archives(fx), []);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("W1-T8863: an orphan reached through a scratch root is archived before removal too", () => {
  const fx = fixture();
  try {
    const path = join(fx.scratch, "orphan");
    renameSync(orphan(fx), path);
    age(path, 7);
    const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(path), false, r.stdout);
    const saved = archives(fx);
    assert.equal(saved.length, 1, r.stdout);
    assert.equal(execFileSync("tar", ["-xOf", saved[0], "./unsaved"], { encoding: "utf8" }), "recover this payload\n");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("W1-T8863: nested clones retain unsaved refs unless a verified bundle preserves them", () => {
  for (const sameFs of [false, true]) {
    const fx = fixture();
    try {
      orphan(fx);
      const live = clone(fx, fx.home, "rmd-mint");
      const path = clone(fx, live, "unpushed");
      git(path, "checkout", "-b", "local-only");
      git(path, "commit", "--allow-empty", "-m", "not pushed");
      const tip = git(path, "rev-parse", "HEAD").trim();
      git(path, "checkout", "main");
      age(path, 7);
      const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: live, ...(sameFs ? { FAKE_ARCHIVE_FSID: "1" } : {}) });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(path), sameFs, r.stdout);
      const root = fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT;
      const saved = existsSync(root) ? readdirSync(root).filter(n => n.endsWith(".bundle")) : [];
      assert.equal(saved.length, sameFs ? 0 : 1, r.stdout);
      if (!sameFs) assert.ok(git(fx.root, "bundle", "list-heads", join(root, saved[0])).includes(`${tip} refs/heads/local-only`));
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("W1-T8863: installer carries live checkouts and detects cron configuration drift", () => {
  const fx = fixture();
  try {
    const table = join(fx.root, "cron");
    const crontab = join(fx.root, "crontab");
    writeFileSync(crontab, `#!/bin/bash\nif [ "$1" = -l ]; then [ -f '${table}' ] && cat '${table}'; else cat > '${table}'; fi\n`, { mode: 0o755 });
    const meminfo = join(fx.root, "meminfo");
    writeFileSync(meminfo, "MemTotal:       16371996 kB\n");
    const cleanup = join(fx.home, "rmd-host-cleanup.sh");
    const live = `${fx.home}/rmd-mint:${fx.home}/rmd-op`;
    const env = { ...process.env, RMD_UNIT_DIR: join(fx.root, "systemd"), RMD_BIN_DIR: join(fx.root, "helpers"), RMD_LAUNCHER_PATH: join(fx.root, "launcher"), RMD_REVIVAL_LOG: join(fx.root, "revivals"), RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_SERVICE_UID: "42424", RMD_MEMINFO_PATH: meminfo, RMD_CLEANUP_PATH: cleanup, RMD_CRONTAB_CMD: crontab, RMD_CLEANUP_LIVE_CHECKOUTS: live };
    const install = (args: string[]) => spawnSync("bash", ["deploy/install-host-units.sh", ...args], { env, encoding: "utf8" });
    const r = install(["--install"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(readFileSync(table, "utf8").includes(`RMD_CLEANUP_LIVE_CHECKOUTS=${live}`));
    assert.equal(install([]).status, 0);
    writeFileSync(table, readFileSync(table, "utf8").replace(` RMD_CLEANUP_LIVE_CHECKOUTS=${live}`, ""));
    const drift = install([]);
    assert.equal(drift.status, 1, drift.stderr + drift.stdout);
    assert.match(drift.stdout, /DRIFTED crontab entry/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
