import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const read = (path: string): string => existsSync(path) ? readFileSync(path, "utf8") : "";

// All repository commands are simulated: this suite also runs in workers forbidden to run git/gh.
// The generated launcher and, in the separation proof, bin/rmd and deploy-run are real.
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-code-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const daemon = join(state, "remudero");
  const install = join(state, "daemon-install");
  const stubs = join(root, "stubs");
  const calls = join(root, "calls");
  const deployed = join(root, "deployed");
  for (const dir of [stubs, join(daemon, ".git"), join(daemon, "bin"), join(install, ".git"), join(install, "bin"), join(state, "state", "inflight"), join(state, "worktrees")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(daemon, "version"), "old");
  executable(join(daemon, "bin", "rmd"), `#!/usr/bin/env bash\nprintf '%s %s cwd=%s\\n' "$(cat '${daemon}/version')" "$*" "$PWD" >> '${deployed}'\n`);
  executable(join(install, "bin", "rmd"), `#!/usr/bin/env bash\necho install-invoked >> '${deployed}'\n`);
  executable(join(stubs, "git"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = -C ]; then tree="$2"; shift 2; else tree="$PWD"; fi
case "$1" in
  status)
    [ "\${FAULT:-}" != status ] || exit 2
    if [ "\${FAULT:-}" = dirty ] || { [ "$tree" = '${daemon}' ] && [ -e '${root}/dirty-after-fetch' ]; }; then echo ' M src/deploy.ts'; fi;;
  fetch)
    [ "\${FAULT:-}" != fetch ] || exit 2
    if [ "$tree" = '${daemon}' ] && [ "\${FAULT:-}" = dirty-after-fetch ]; then touch '${root}/dirty-after-fetch'; fi;;
  merge-base)
    [ "\${FAULT:-}" != diverged ] || exit 1
    if [ "$3" != HEAD ] && [ "\${FAULT:-}" = install-ahead ]; then exit 1; fi;;
  merge)
    [ "\${FAULT:-}" != merge ] || exit 2
    if [ "$tree" = '${daemon}' ]; then
      echo new > '${daemon}/version'
      [ "\${FAULT:-}" != raced ] || touch '${state}/state/inflight/raced.lock'
    fi;;
  symbolic-ref) echo main;;
  rev-parse)
    if [ "$2" = --show-toplevel ]; then echo "$tree"; else printf '%040d\\n' 2; fi;;
  log|diff|show|rev-list) : ;;
  *) echo "unexpected simulated git command: $*" >&2; exit 2;;
esac
`);
  executable(join(stubs, "docker"), `#!/usr/bin/env bash
case "$1" in
  ps) echo healthy-container;;
  top)
    [ "\${FAULT:-}" != sensor ] || exit 1
    [ "\${FAULT:-}" != empty-sensor ] || exit 0
    echo COMMAND
    case "\${FAULT:-}" in
      claude) echo 'node /tools/claude --output-format stream-json';;
      codex) echo 'node /tools/codex exec --json';;
      *) echo 'node daemon';;
    esac;;
  inspect) echo unknown;;
  *) exit 1;;
esac
`);
  const github = ghShim([{ when: "", exit: 1 }]);
  t.after(() => rmSync(github.dir, { recursive: true, force: true }));
  executable(join(stubs, "grep"), `#!/usr/bin/env bash\nif [ "\${FAULT:-}" = matcher ] && [ "$1" = -E ]; then exit 2; fi\nexec /usr/bin/grep "$@"\n`);
  const launcher = join(root, "launcher");
  const render = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], {
    encoding: "utf8",
    env: { ...process.env, RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "bin"), RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(root, "revivals"), RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(render.status, 0, render.stderr);
  const env = { ...process.env, PATH: `${stubs}:${github.dir}:${process.env.PATH}` };
  const tick = (fault = "", boot = false) => spawnSync("bash", [launcher, ...(boot ? ["--boot"] : [])], { encoding: "utf8", cwd: root, env: { ...env, FAULT: fault }, timeout: 30000 });
  return { root, state, daemon, install, calls, deployed, env, tick };
}

test("W1-T4917: the deploy tick runs deploy code at least as new as the install checkout", (t) => {
  const f = fixture(t);
  const r = f.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(f.deployed), /^new deploy-run --image-drift-only/, "the refresh must happen before loading deploy code");
  assert.match(read(f.deployed), new RegExp(`cwd=${f.daemon}`), "the invoker must be outside the install checkout");
  assert.match(read(f.calls), new RegExp(`-C ${f.daemon} merge --ff-only --quiet origin/main`));
  assert.doesNotMatch(read(f.calls), /reset|checkout|clean|rebase/);
});

for (const [fault, reason] of [["claude", "active workers"], ["codex", "active workers"], ["sensor", "worker probe unreadable"], ["empty-sensor", "worker probe unreadable"], ["matcher", "worker probe unreadable"], ["dirty", "local edits"], ["dirty-after-fetch", "local edits"], ["status", "status unreadable"], ["fetch", "fetch failed"], ["diverged", "diverged"], ["install-ahead", "install checkout ancestry"], ["merge", "fast-forward failed"]]) {
  test(`W1-T4917: ${fault} refuses the code refresh and deploy tick`, (t) => {
    const f = fixture(t);
    const r = f.tick(fault);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(reason));
    assert.equal(read(f.deployed), "");
    assert.equal(read(join(f.daemon, "version")), "old");
  });
}

for (const dir of ["state/inflight", "worktrees"]) {
  test(`W1-T4917: ${dir} locks defer without moving the checkout`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.state, dir, "task.lock"), "held");
    const r = f.tick();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /active locks/);
    assert.equal(read(f.deployed), "");
    assert.equal(read(join(f.daemon, "version")), "old");
  });
}

test("W1-T4917: a lock admitted during refresh defers deploy-run", (t) => {
  const f = fixture(t);
  const r = f.tick("raced");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /active locks/);
  assert.equal(read(f.deployed), "");
});

test("W1-T4917: unreadable lock paths and a missing checkout defer deploy-run", (t) => {
  const f = fixture(t);
  rmSync(join(f.state, "worktrees"), { recursive: true });
  writeFileSync(join(f.state, "worktrees"), "not a directory");
  assert.match(f.tick().stderr, /lock probe unreadable/);
  rmSync(join(f.state, "worktrees"));
  rmSync(join(f.daemon, ".git"), { recursive: true });
  assert.match(f.tick().stderr, /checkout missing/);
  assert.equal(read(f.deployed), "");
});

test("W1-T4917: boot and STOP do not refresh or deploy", (t) => {
  const f = fixture(t);
  assert.equal(f.tick("", true).status, 0);
  writeFileSync(join(f.state, "state", "STOP"), "");
  assert.equal(f.tick().status, 0);
  assert.equal(read(f.calls), "");
  assert.equal(read(f.deployed), "");
});

test("W1-T4917: the real deploy-run is not the install-separation no-op", (t) => {
  const f = fixture(t);
  // Copy the actual CLI source so its direct-invocation guard sees its real filename.
  cpSync("src", join(f.daemon, "src"), { recursive: true });
  symlinkSync(resolve("scripts"), join(f.daemon, "scripts"), "dir");
  mkdirSync(join(f.daemon, "plan"));
  cpSync("plan/policy.yaml", join(f.daemon, "plan", "policy.yaml"));
  cpSync("bin/rmd", join(f.daemon, "bin", "rmd"));
  cpSync("package.json", join(f.daemon, "package.json"));
  symlinkSync(resolve("node_modules"), join(f.daemon, "node_modules"), "dir");
  const fixtureHome = join(f.root, "home");
  mkdirSync(fixtureHome);
  // A child-only bootstrap adds dry-run to the launcher's exact CLI args; deploy-run itself is real.
  const preload = join(f.root, "dry-run.cjs");
  writeFileSync(preload, "if (process.argv.includes('deploy-run')) process.argv.push('--dry-run');\n");
  const r = spawnSync("bash", [join(f.root, "launcher")], { encoding: "utf8", cwd: f.root, timeout: 30000, env: { ...f.env, HOME: fixtureHome, NODE_OPTIONS: `--require=${preload}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /### rmd deploy-run — (DEPLOYED|no-op):/, r.stderr);
  assert.match(r.stdout, /### rmd deploy-run — serve /, "the real cycle must be reached after assessment");
  assert.doesNotMatch(r.stdout, /resolves INSIDE|install root .*unfit|absent/);
  assert.match(read(f.calls), new RegExp(`-C ${f.daemon} rev-parse --show-toplevel`));
  const control = spawnSync(join(f.daemon, "bin", "rmd"), ["deploy-run", "--dry-run", "--state-root", f.state, "--repo-root", f.state], {
    encoding: "utf8", cwd: f.state, timeout: 30000, env: { ...f.env, HOME: fixtureHome },
  });
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout, /resolves INSIDE the operator's own checkout/, "the real separation guard still refuses a shared parent");
  assert.doesNotMatch(control.stdout, /### rmd deploy-run — serve /);
});
