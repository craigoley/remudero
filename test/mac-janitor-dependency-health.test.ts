/** Execute the maintained shell script with private checkouts and no live reclaim helpers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repository, "deploy/mac/remudero-janitor.sh");

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-janitor-dependency-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), bin = join(root, "bin"), scratch = join(root, "tmp");
  const deploy = join(root, "deploy"), script = join(deploy, "mac/remudero-janitor.sh");
  for (const directory of [home, bin, scratch, dirname(script)]) mkdirSync(directory, { recursive: true });
  copyFileSync(source, script);
  for (const helper of ["workspace-retirement-guard.sh", "dependency-seed-guard.sh"]) {
    copyFileSync(join(repository, "deploy", helper), join(deploy, helper));
  }
  const invoked = join(root, "unexpected-command");
  const command = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
  // Keep even hard-coded legacy artifact roots outside this private fixture unscanned.
  command("find", 'case "$1" in "$FIXTURE_ROOT"/*) exec /usr/bin/find "$@" ;; *) exit 2 ;; esac');
  command("ps", "exit 2");
  command("lsof", "exit 2");
  command("df", "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 200000000 1 100000000 1%% /\\n'");
  // No real Git operation is needed in this fixture. Refuse every read and
  // separately trap network/mutation attempts rather than emulating a census.
  command("git", 'case " $* " in *" fetch "*|*" push "*|*" clone "*|*" checkout "*|*" reset "*|*" clean "*|*" worktree "*) printf "%s\\n" "git $*" >> "$FIXTURE_INVOKED"; exit 97 ;; esac\nexit 128');
  for (const name of ["npm", "npx", "pnpm", "yarn", "open", "osascript"]) {
    command(name, 'printf "%s\\n" "$0 $*" >> "$FIXTURE_INVOKED"; exit 97');
  }
  for (const name of ["awk", "bash", "cksum", "cut", "date", "dirname", "du", "grep", "id", "mkdir", "python3", "readlink", "rmdir", "sed", "sort", "stat", "tee", "uname"]) {
    const native = spawnSync("/bin/bash", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(native.status, 0, name);
    symlinkSync(native.stdout.trim(), join(bin, name));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  const core = join(home, "Remudero/remudero");
  const checkout = (path = core, manifest: unknown = { scripts: { test: "node --test --import tsx" }, dependencies: { tsx: "^4.0.0" } }, tsx = true) => {
    mkdirSync(join(path, "src/lib"), { recursive: true });
    writeFileSync(join(path, "src/lib/worker.ts"), "unpublished worker source\n");
    if (manifest !== undefined) writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
    if (tsx) {
      mkdirSync(join(path, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(path, "node_modules/.bin/tsx"), '#!/bin/bash\necho tsx >> "$FIXTURE_INVOKED"; exit 97\n', { mode: 0o755 });
    }
    return path;
  };
  const availableVitest = (path = core) => {
    mkdirSync(join(path, "node_modules/vitest"), { recursive: true });
    writeFileSync(join(path, "node_modules/vitest/vitest.mjs"), "throw new Error('runner must never be loaded');\n");
  };
  // These represent active/unpublished operator work; verify their bytes and metadata survive.
  const protectedFiles = [join(home, ".claude/settings.json"), join(home, "Developer/operator-checkout/private.ts")];
  for (const path of protectedFiles) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "active unpublished work\n");
  }
  const snapshot = (path: string): unknown => {
    const stat = lstatSync(path);
    let payload: unknown = "nonregular";
    if (stat.isSymbolicLink()) payload = readlinkSync(path);
    else if (stat.isDirectory()) payload = readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]);
    else if (stat.isFile()) {
      try { payload = readFileSync(path).toString("base64"); }
      catch (error) { payload = (error as NodeJS.ErrnoException).code; }
    }
    return [stat.mode, stat.mtimeMs, stat.ctimeMs, payload];
  };
  const run = (runtimeMode: "normal" | "absent" | "failed" | "node-absent" = "normal") => {
    if (runtimeMode === "node-absent") rmSync(join(bin, "node"));
    if (runtimeMode === "absent" || runtimeMode === "failed") {
      rmSync(join(bin, "python3"));
      if (runtimeMode === "failed") command("python3", "exit 97");
    }
    const path = bin;
    if (runtimeMode === "absent" || runtimeMode === "node-absent") {
      const name = runtimeMode === "absent" ? "python3" : "node";
      assert.notEqual(spawnSync("/bin/bash", ["-c", `command -v ${name}`], { env: { PATH: `${path}:/usr/sbin:/sbin` } }).status, 0);
    }
    const before = [existsSync(core) ? snapshot(core) : null, ...protectedFiles.map(snapshot)];
    const result = spawnSync("/bin/bash", [script, "--dry-run"], { encoding: "utf8", timeout: 20_000, env: {
      HOME: home, PATH: path, TMPDIR: scratch, NODE_OPTIONS: "", NODE_PATH: "",
      FIXTURE_ROOT: root, FIXTURE_INVOKED: invoked,
      REMUDERO_JANITOR_ACCOUNT_HOME: home, REMUDERO_JANITOR_SCAN_ROOTS: scratch,
      REMUDERO_JANITOR_DIRECTORY_ROOTS: scratch,
      REMUDERO_JANITOR_LOG: join(root, "janitor.log"),
      REMUDERO_JANITOR_DECISION_LOG: join(root, "decisions.tsv"),
      REMUDERO_JANITOR_LOCK_DIR: join(root, "janitor.lock"),
    } });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}${result.stdout}`);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /=== done:/, "the real shell must reach its final health check");
    assert.equal(existsSync(invoked), false, existsSync(invoked) ? readFileSync(invoked, "utf8") : "");
    assert.deepEqual([existsSync(core) ? snapshot(core) : null, ...protectedFiles.map(snapshot)], before);
    assert.equal(existsSync(join(root, "janitor.lock")), false, "pass lock released");
    return result.stdout;
  };
  return { root, home, core, checkout, availableVitest, run, preserve: (path: string) => protectedFiles.push(path) };
}

test("Janitor dependency health: node:test checkout without a Vitest declaration emits no Vitest warning", t => {
  const fx = fixture(t); fx.checkout();
  assert.doesNotMatch(fx.run(), /WARN.*(?:vitest|Vitest)|WARN dependency-health/);
});

test("Janitor dependency health: declared but missing Vitest warns for dependencies and devDependencies", t => {
  for (const section of ["dependencies", "devDependencies"]) {
    const fx = fixture(t); fx.checkout(fx.core, { [section]: { vitest: "^3.0.0" } });
    const output = fx.run();
    assert.match(output, /WARN dependency-health: declared vitest runner missing at .*node_modules\/vitest\/vitest.mjs/);
    assert.match(output, /linked proofs may fail/);
    assert.doesNotMatch(output, /declared tsx runner missing/);
  }
});

test("Janitor dependency health: an available Vitest runner is inspected without executing package code", t => {
  const fx = fixture(t); fx.checkout(fx.core, { devDependencies: { tsx: "^4", vitest: "^3" } });
  fx.availableVitest();
  assert.doesNotMatch(fx.run(), /WARN dependency-health/);
});

test("Janitor dependency health: an empty Vitest directory cannot pass as an available runner", t => {
  const fx = fixture(t); fx.checkout(fx.core, { devDependencies: { vitest: "^3" } });
  mkdirSync(join(fx.core, "node_modules/vitest"));
  assert.match(fx.run(), /declared vitest runner missing/);
});

test("Janitor dependency health: declared tsx remains diagnosable when no executable install is available", t => {
  const fx = fixture(t); fx.checkout(fx.core, { dependencies: { tsx: "^4" } }, false);
  assert.match(fx.run(), /declared tsx runner missing/);
});

test("Janitor dependency health: inaccessible or non-file runners do not become missing dependency claims", t => {
  for (const kind of ["tsx-permission", "vitest-permission", "vitest-directory"]) {
    // Root bypasses read permission bits; the directory/FIFO controls below
    // remain uid-independent and still execute on that host condition.
    if (process.getuid?.() === 0 && kind !== "vitest-directory") continue;
    const fx = fixture(t); fx.checkout(fx.core, { dependencies: { tsx: "^4", vitest: "^3" } });
    fx.availableVitest();
    const runner = join(fx.core, kind === "tsx-permission" ? "node_modules/.bin/tsx" : "node_modules/vitest/vitest.mjs");
    if (kind === "vitest-directory") { rmSync(runner); mkdirSync(runner); }
    else chmodSync(runner, 0);
    const output = fx.run();
    assert.match(output, kind === "vitest-directory" ? /declared vitest runner unavailable .*not a regular file/ : /declared (?:tsx|vitest) runner unreadable .*runner health unknown/);
    assert.doesNotMatch(output, /runner missing/);
  }
});

test("Janitor dependency health: an ancestor package cannot hide a missing checkout-local runner", t => {
  const fx = fixture(t); fx.checkout(fx.core, { devDependencies: { vitest: "^3" } });
  fx.availableVitest(join(fx.home, "Remudero"));
  assert.match(fx.run(), /declared vitest runner missing/);
});

test("Janitor dependency health: the selected executable checkout supplies the manifest", t => {
  const fx = fixture(t); fx.checkout(fx.core, { devDependencies: { vitest: "^3" } }, false);
  const fallback = fx.checkout(join(fx.home, "Remudero/repos/remudero"));
  assert.ok(existsSync(join(fallback, "package.json")));
  assert.doesNotMatch(fx.run(), /WARN dependency-health/);
});

test("Janitor dependency health: a satellite manifest and script mention cannot invent a Core dependency", t => {
  const fx = fixture(t); fx.checkout(fx.core, { scripts: { test: "vitest" }, overrides: { vitest: "^3" } });
  fx.checkout(join(fx.home, "Remudero/remudero-console"), { devDependencies: { vitest: "^3" } });
  assert.doesNotMatch(fx.run(), /WARN dependency-health|lacks vitest/);
});

test("Janitor dependency health: shared node_modules and runner symlinks are read without repair", t => {
  const fx = fixture(t); fx.checkout(fx.core, { dependencies: { tsx: "^4", vitest: "^3" } });
  const shared = join(fx.root, "shared");
  mkdirSync(join(shared, "vitest"), { recursive: true });
  mkdirSync(join(shared, ".bin"));
  writeFileSync(join(shared, "tsx"), "#!/bin/bash\nexit 97\n", { mode: 0o755 });
  symlinkSync("../tsx", join(shared, ".bin/tsx"));
  writeFileSync(join(shared, "vitest/vitest.mjs"), "throw new Error('never load');\n");
  rmSync(join(fx.core, "node_modules"), { recursive: true });
  symlinkSync(shared, join(fx.core, "node_modules"));
  fx.preserve(shared);
  assert.doesNotMatch(fx.run(), /WARN dependency-health/);
  assert.equal(realpathSync(join(fx.core, "node_modules")), shared);
});

test("Janitor dependency health: malformed JSON and dependency maps report unknown health without missing claims", t => {
  for (const text of ['{"dependencies":', "null", "[]", '{"dependencies":[]}', '{"devDependencies":{"vitest":null}}', '{"dependencies":{"tsx":""}}']) {
    const fx = fixture(t); fx.checkout();
    writeFileSync(join(fx.core, "package.json"), text);
    const output = fx.run();
    assert.match(output, /WARN dependency-health: manifest malformed .*runner health unknown/);
    assert.doesNotMatch(output, /runner missing|lacks vitest|check unavailable/);
  }
});

test("Janitor dependency health: missing, non-file, oversized and unreadable manifests fail safely", t => {
  for (const kind of ["missing", "directory", "oversized", "permission", "fifo"]) {
    if (process.getuid?.() === 0 && kind === "permission") continue;
    const fx = fixture(t); fx.checkout();
    const manifest = join(fx.core, "package.json");
    if (kind === "oversized") writeFileSync(manifest, " ".repeat(1024 * 1024 + 1));
    else if (kind === "permission") {
      chmodSync(manifest, 0);
      assert.throws(() => readFileSync(manifest), /EACCES|EPERM/, "permission control must actually be unreadable");
    } else {
      rmSync(manifest);
      if (kind === "directory") mkdirSync(manifest);
      if (kind === "fifo") assert.equal(spawnSync("/usr/bin/mkfifo", [manifest]).status, 0);
    }
    const output = fx.run();
    assert.match(output, /WARN dependency-health: manifest unreadable .*runner health unknown/);
    assert.doesNotMatch(output, /runner missing|manifest malformed/);
  }
});

test("Janitor dependency health: cron without Node still checks manifests without executing package code", t => {
  const fx = fixture(t); fx.checkout(fx.core, { devDependencies: { vitest: "^3" } });
  const output = fx.run("node-absent");
  assert.match(output, /declared vitest runner missing/);
  assert.doesNotMatch(output, /check unavailable|lacks vitest/);
});

test("Janitor dependency health: unavailable Python or a failed probe never becomes a missing dependency claim", t => {
  for (const kind of ["absent", "failed"] as const) {
    const fx = fixture(t); fx.checkout(fx.core, { devDependencies: { vitest: "^3" } });
    const output = fx.run(kind);
    assert.match(output, /WARN dependency-health: check unavailable/);
    assert.doesNotMatch(output, /runner missing|lacks vitest/);
  }
});

test("Janitor dependency health: no Core checkout produces no dependency warning", t => {
  assert.doesNotMatch(fixture(t).run(), /WARN dependency-health|lacks vitest/);
});
