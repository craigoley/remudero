/** Execute the maintained shell script with private checkouts and no live reclaim helpers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Execute only the maintained delegation, never the Janitor's real sweep phases. */
function cacheDelegationFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-janitor-cache-scope-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), home = join(root, "account home"), otherHome = join(root, "other home");
  const deploy = join(root, "deploy"), canonical = join(root, "account temp"), custom = join(root, "custom temp");
  for (const directory of [bin, home, otherHome, deploy, canonical, custom]) mkdirSync(directory);
  symlinkSync(root, join(root, "parent alias"));
  const nativeTemp = join(root, "parent alias/account temp/");
  const linked = join(root, "linked temp"); symlinkSync(canonical, linked);
  writeFileSync(join(deploy, "cache-reclaim.py"), "fixture only: never execute or scan\n");
  const script = readFileSync(source, "utf8");
  const start = script.indexOf("# This helper owns only exact ignored duplicate packages");
  const end = script.indexOf('rmd_decision_summary "$DECISION_LOG"', start);
  assert.ok(start >= 0 && end > start, "the maintained delegation must be located, not reimplemented");
  const block = script.slice(start, end);
  const command = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${text}\n`, { mode: 0o755 });
  for (const name of ["env", "tee", "cat"]) {
    const native = spawnSync("/bin/bash", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(native.status, 0, name); symlinkSync(native.stdout.trim(), join(bin, name));
  }
  command("getconf", '[ "$#" = 1 ] && [ "$1" = DARWIN_USER_TEMP_DIR ] || exit 97\nprintf getconf >> "$FIXTURE_PROBES"\nprintf "%s\\n" "$FIXTURE_NATIVE_TEMP"\nexit "$FIXTURE_GETCONF_STATUS"');
  command("dscl", '[ "$*" = ". -read /Users/fixture NFSHomeDirectory" ] || exit 97\nprintf dscl >> "$FIXTURE_PROBES"\nprintf "%s\\n" "$FIXTURE_ACCOUNT_RECORD"\nexit "$FIXTURE_ACCOUNT_STATUS"');
  // This stand-in observes environment/argv and cannot run the Python helper.
  command("python3", '[ "$1" = "$FIXTURE_DEPLOY/cache-reclaim.py" ] || exit 97\nprintf "%s\\n" "${TMPDIR-UNSET}" > "$FIXTURE_OBSERVED"\nprintf "%s\\n%s\\n" "${TEMP-UNSET}" "${TMP-UNSET}" > "$FIXTURE_FALLBACKS"\nprintf "%s\\n" "$@" > "$FIXTURE_ARGS"\nprintf "cache-fixture-only\\n"\nexit "$FIXTURE_PYTHON_STATUS"');
  const run = (options: {
    temp?: string; tempFallback?: string; tmpFallback?: string; os?: "Darwin" | "Linux"; selectedHome?: string; nativeTemp?: string;
    getconfStatus?: number; getconfMissing?: boolean; accountRecord?: string; accountStatus?: number; apply?: boolean;
    pythonStatus?: number; reporterStatus?: number; teeFailed?: boolean;
  } = {}) => {
    for (const name of ["observed", "args", "fallbacks", "probes", "helper.log", "decisions.tsv"]) rmSync(join(root, name), { force: true });
    if (options.getconfMissing) rmSync(join(bin, "getconf"));
    if (options.teeFailed) { rmSync(join(bin, "tee")); command("tee", "cat >/dev/null; exit 3"); }
    const selectedHome = options.selectedHome ?? home;
    const result = spawnSync("/bin/bash", ["-c", `set -uo pipefail
OS_NAME="$FIXTURE_OS"; USER_HOME="$FIXTURE_SELECTED_HOME"; RUN_USER=fixture
SCRIPT_DIR="$FIXTURE_DEPLOY"; DEFAULT_TMP="\${TMPDIR:-/tmp}"; APPLY="$FIXTURE_APPLY"
LOG="$FIXTURE_LOG"; DECISION_LOG="$FIXTURE_DECISIONS"
log() { printf 'log:%s\\n' "$*"; }
rmd_decision_cache_json() { cat; return "$FIXTURE_REPORTER_STATUS"; }
rmd_decision_record() { printf '%s\\t%s\\n' "$3" "$4" >> "$1"; }
${block}
printf 'caller-TMPDIR=<%s>\\ncaller-DEFAULT_TMP=<%s>\\n' "\${TMPDIR-UNSET}" "$DEFAULT_TMP"
`], { encoding: "utf8", timeout: 5_000, env: {
      HOME: home, PATH: bin, ...(options.temp === undefined ? {} : { TMPDIR: options.temp }),
      ...(options.tempFallback === undefined ? {} : { TEMP: options.tempFallback }),
      ...(options.tmpFallback === undefined ? {} : { TMP: options.tmpFallback }),
      FIXTURE_OS: options.os ?? "Darwin", FIXTURE_SELECTED_HOME: selectedHome, FIXTURE_DEPLOY: deploy,
      FIXTURE_NATIVE_TEMP: options.nativeTemp ?? nativeTemp, FIXTURE_GETCONF_STATUS: String(options.getconfStatus ?? 0),
      FIXTURE_ACCOUNT_RECORD: options.accountRecord ?? `NFSHomeDirectory: ${home}`, FIXTURE_ACCOUNT_STATUS: String(options.accountStatus ?? 0),
      FIXTURE_APPLY: options.apply ? "1" : "0", FIXTURE_LOG: join(root, "helper.log"), FIXTURE_DECISIONS: join(root, "decisions.tsv"),
      FIXTURE_PROBES: join(root, "probes"), FIXTURE_OBSERVED: join(root, "observed"), FIXTURE_ARGS: join(root, "args"),
      FIXTURE_FALLBACKS: join(root, "fallbacks"), FIXTURE_PYTHON_STATUS: String(options.pythonStatus ?? 0), FIXTURE_REPORTER_STATUS: String(options.reporterStatus ?? 0),
    } });
    assert.equal(result.status, options.teeFailed ? 2 : 0, `${result.error || ""}\n${result.stderr}${result.stdout}`);
    assert.equal(result.stderr, "");
    if (!options.teeFailed) {
      assert.ok(result.stdout.includes(`caller-TMPDIR=<${options.temp ?? "UNSET"}>\n`), "only the helper's environment may change");
      assert.ok(result.stdout.includes(`caller-DEFAULT_TMP=<${options.temp || "/tmp"}>\n`), "other phases retain their original temp scope");
    }
    const read = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : undefined;
    if (read("observed") !== undefined) assert.equal(read("fallbacks"), `${options.tempFallback ?? "UNSET"}\n${options.tmpFallback ?? "UNSET"}\n`, "fallback environment is never changed");
    return { observed: read("observed"), args: read("args"), decisions: read("decisions.tsv"), probes: read("probes"), log: read("helper.log"), stdout: result.stdout };
  };
  return { root, home, otherHome, deploy, canonical, custom, linked, run };
}

test("Janitor cache scope: cron defaults and GUI retain one canonical per-user reference root", t => {
  const fx = cacheDelegationFixture(t);
  for (const temp of [fx.canonical, undefined, "", "/tmp", "/tmp/", "/private/tmp", "/private/tmp/"]) {
    const result = fx.run({ temp });
    assert.equal(result.observed, `${fx.canonical}\n`, `TMPDIR=${temp ?? "<unset>"}`);
    assert.equal(result.decisions, undefined);
    assert.equal(result.args, `${fx.deploy}/cache-reclaim.py\n--home\n${fx.home}\n`);
  }
  assert.equal(fx.run({ apply: true }).args, `${fx.deploy}/cache-reclaim.py\n--home\n${fx.home}\n--apply\n`);
  assert.equal(fx.run({ tempFallback: "", tmpFallback: "" }).observed, `${fx.canonical}\n`);
});

test("Janitor cache scope: explicit custom TMPDIR is retained without consulting current-user defaults", t => {
  const fx = cacheDelegationFixture(t);
  const result = fx.run({ temp: `${fx.custom}/`, getconfStatus: 1, accountStatus: 1 });
  assert.equal(result.observed, `${fx.custom}/\n`);
  assert.equal(result.probes, undefined);
  assert.equal(result.decisions, undefined);
});

test("Janitor cache scope: explicit TEMP and TMP fallbacks retain Python selection when TMPDIR is unset or empty", t => {
  const fx = cacheDelegationFixture(t);
  for (const temp of [undefined, ""]) {
    for (const fallback of [{ tempFallback: fx.custom }, { tmpFallback: fx.custom },
      { tempFallback: "", tmpFallback: fx.custom }, { tempFallback: fx.custom, tmpFallback: fx.otherHome }]) {
      const result = fx.run({ temp, ...fallback, getconfStatus: 1, accountStatus: 1 });
      assert.equal(result.observed, `${temp ?? "UNSET"}\n`, "do not inject TMPDIR ahead of an explicit fallback");
      assert.equal(result.probes, undefined);
      assert.equal(result.decisions, undefined);
    }
  }
});

test("Janitor cache scope: unavailable or invalid Darwin temp probes keep the cache pass without invoking Python", t => {
  for (const kind of ["missing-command", "failed-with-valid-path", "empty", "relative", "missing-directory", "regular-file", "symlink", "root", "double-root", "multiline"]) {
    const fx = cacheDelegationFixture(t);
    const paths: Record<string, string> = { empty: "", relative: "account temp", "missing-directory": join(fx.root, "absent"),
      "regular-file": join(fx.deploy, "cache-reclaim.py"), symlink: `${fx.linked}/`, root: "/", "double-root": "//", multiline: `${fx.canonical}\n/other` };
    const result = fx.run({ nativeTemp: paths[kind], getconfMissing: kind === "missing-command", getconfStatus: kind === "failed-with-valid-path" ? 1 : 0 });
    assert.equal(result.observed, undefined, kind);
    assert.equal(result.args, undefined, kind);
    assert.equal(result.decisions, "keep\tcache_scope_unknown\n", kind);
    assert.match(result.stdout, /SKIP generated-cache-scope/, kind);
  }
});

test("Janitor cache scope: a foreign-owned native temp directory cannot narrow the reference census", t => {
  const fx = cacheDelegationFixture(t);
  let foreign = "/usr";
  if (process.getuid?.() === 0) {
    foreign = join(fx.root, "foreign temp"); mkdirSync(foreign); chownSync(foreign, 1, 0);
  }
  assert.notEqual(lstatSync(foreign).uid, process.getuid?.(), "ownership control must actually be foreign");
  const result = fx.run({ nativeTemp: foreign });
  assert.equal(result.observed, undefined);
  assert.equal(result.decisions, "keep\tcache_scope_unknown\n");
});

test("Janitor cache scope: an unusable owned temp directory keeps the pass rather than allowing Python fallback", t => {
  if (process.getuid?.() === 0) { t.skip("root bypasses directory permission controls"); return; }
  const fx = cacheDelegationFixture(t);
  for (const mode of [0o500, 0o600]) {
    chmodSync(fx.canonical, mode);
    try {
      const result = fx.run();
      assert.equal(result.observed, undefined, `mode=${mode.toString(8)} must not invoke the helper`);
      assert.equal(result.decisions, "keep\tcache_scope_unknown\n");
    } finally {
      chmodSync(fx.canonical, 0o700);
    }
  }
});

test("Janitor cache scope: selected HOME must match the verified running account before normalization", t => {
  const fx = cacheDelegationFixture(t);
  for (const options of [
    { selectedHome: fx.otherHome }, { accountStatus: 1 }, { accountRecord: "" },
    { accountRecord: "NFSHomeDirectory: /missing/home" },
    { accountRecord: `NFSHomeDirectory: ${fx.home}\nNFSHomeDirectory: ${fx.otherHome}` },
  ]) {
    const result = fx.run(options);
    assert.equal(result.observed, undefined);
    assert.equal(result.decisions, "keep\tcache_scope_unknown\n");
    assert.doesNotMatch(result.probes ?? "", /getconf/, "do not look up another account's implicit temp scope");
  }
});

test("Janitor cache scope: Linux keeps inherited TMPDIR semantics without consulting Darwin probes", t => {
  const fx = cacheDelegationFixture(t);
  for (const temp of [undefined, "", "/tmp/", "/private/tmp", `${fx.custom}/`]) {
    const result = fx.run({ os: "Linux", temp, accountStatus: 1, getconfStatus: 1 });
    assert.equal(result.observed, `${temp ?? "UNSET"}\n`);
    assert.equal(result.probes, undefined);
    assert.equal(result.decisions, undefined);
  }
});

test("Janitor cache scope: delegation preserves helper refusals, original receipts and pipeline failure control", t => {
  for (const options of [{}, { pythonStatus: 17 }, { reporterStatus: 19 }, { teeFailed: true }]) {
    const fx = cacheDelegationFixture(t);
    const result = fx.run(options);
    assert.equal(result.observed, `${fx.canonical}\n`);
    if (options.teeFailed) { assert.equal(result.decisions, undefined); continue; }
    assert.equal(result.log, "cache-fixture-only\n", "retain the full original human-log receipt");
    if (options.reporterStatus) assert.equal(result.decisions, "info\tcache_report_unknown\n");
    else assert.equal(result.decisions, undefined);
    if (options.pythonStatus) assert.match(result.stdout, /WARN generated-cache helper refused/);
  }
});
