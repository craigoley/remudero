import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/host-update.sh");
const SECRET = "private-provider-value-12174";
const NIGHT = "state-backup.2026-11-10T00-00-00-000Z";
const LEDGER = '{"step":"run.start"}\n';

function fixture(t: TestContext) {
  const home = ownedFixtureDir(t, "w1-t12174-config-backup").dir;
  const bin = join(home, "bin");
  const config = join(home, "container config");
  const roots = [join(home, "primary"), join(home, "secondary")];
  for (const dir of [bin, config, ...roots.map((root) => join(root, "state"))]) mkdirSync(dir, { recursive: true });
  for (const root of roots) writeFileSync(join(root, "state/ledger.ndjson"), LEDGER);
  writeFileSync(join(config, "config.json"), SECRET, { mode: 0o644 });
  writeFileSync(join(config, ".hidden config"), "hidden", { mode: 0o666 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
set -eu
case "$1 $2" in
  'info --format') echo "$HOME"; exit 0 ;;
  'system df') echo 'TYPE TOTAL ACTIVE SIZE'; exit 0 ;;
esac
case "$1" in
  ps) echo live; exit 0 ;;
  inspect)
    case "$*" in
      *.Source*) echo "$STUB_SECOND_ROOT" ;;
      *) echo '/remudero-daemon|rmd-local:latest|/home/node/Remudero ' ;;
    esac; exit 0 ;;
  run)
    for arg in "$@"; do
      case "$arg" in
        *:/rmd-snapshot/state:ro) state="\${arg%:/rmd-snapshot/state:ro}" ;;
        *:/rmd-snapshot/backups) backups="\${arg%:/rmd-snapshot/backups}" ;;
      esac
    done
    mkdir -p "$backups/$STUB_NIGHT"
    /bin/cp "$state/ledger.ndjson" "$backups/$STUB_NIGHT/ledger.ndjson"
    if [ -n "\${STUB_CONFIG_LINK:-}" ]; then ln -s "$STUB_CONFIG_LINK" "$backups/$STUB_NIGHT/container-config"; fi
    echo "RMD_STATE_SNAPSHOT $STUB_NIGHT 1 0 0 0"; exit 0 ;;
  *) echo 'Total reclaimed space: 0B' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "cp"), `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "\${FAIL_COPY_PATH:-}" ]; then
    echo "$SECRET_VALUE" >&2
    exit 1
  fi
  if [ "$arg" = "\${SWAP_COPY_PATH:-}" ]; then
    rm -f -- "$arg"
    ln -s "$SWAP_TARGET" "$arg"
  fi
done
exec /bin/cp "$@"
`, { mode: 0o755 });
  const receipt = join(home, "snapshot.receipt");
  const run = (extra: NodeJS.ProcessEnv = {}, dryRun = false) => {
    const result = spawnSync("bash", [SCRIPT, "--reclaim-only", ...(dryRun ? ["--dry-run"] : [])], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: home,
        RMD_STATE_DIR: roots[0], RMD_CONTAINER_CONFIG_DIR: config,
        RMD_CLAUDE_DIR: join(home, "claude"), RMD_CODEX_DIR: join(home, "codex"),
        RMD_GIT_RECLAIM_DIRS: join(home, "no-checkout"),
        RMD_AGENT_HISTORY_DIRS: join(home, "no-history"), RMD_SCRATCH: "off",
        RMD_RECYCLE_HOST_LOCK: join(home, "recycle.lock"),
        RMD_STATE_SNAPSHOT_RECEIPT: receipt, STUB_SECOND_ROOT: roots[1], STUB_NIGHT: NIGHT,
        SECRET_VALUE: SECRET, ...extra,
      },
    });
    assert.ifError(result.error);
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const archive = (root = roots[0], night = NIGHT) => join(root, "state-backups", night);
  return { home, config, roots, receipt, run, archive };
}

test("W1-T12174 criterion 1: every state root gets private regular config files without following links", (t) => {
  const f = fixture(t);
  const outside = join(f.home, "outside");
  writeFileSync(outside, "must not copy", { mode: 0o644 });
  symlinkSync(outside, join(f.config, "linked.json"));
  symlinkSync(join(f.home, "missing"), join(f.config, "dangling"));
  mkdirSync(join(f.config, "subdirectory"));
  writeFileSync(join(f.config, "subdirectory/nested.json"), "not a direct regular file");
  const result = f.run();
  assert.equal(result.status, 0, result.out);
  for (const root of f.roots) {
    const copy = join(f.archive(root), "container-config");
    assert.equal(statSync(copy).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(copy).sort(), [".hidden config", "config.json"]);
    for (const name of readdirSync(copy)) {
      assert.equal(statSync(join(copy, name)).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(copy, name), "utf8"), readFileSync(join(f.config, name), "utf8"));
    }
  }
  assert.equal(statSync(outside).mode & 0o777, 0o644);
  assert.match(readFileSync(f.receipt, "utf8"), /^result=ok\n/);
});

test("W1-T12174 criterion 2: reports each copy path without printing config values", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.out);
  for (const root of f.roots) assert.ok(result.out.includes(join(f.archive(root), "container-config")));
  assert.ok(!result.out.includes(SECRET));
});

test("W1-T12174 criterion 1: directory links cannot be hidden by slashes or child components", async (t) => {
  for (const suffix of ["", "/", "///", "/.", "/nested", "/nested/..", "//nested//"]) {
    await t.test(`linked config path ending in ${JSON.stringify(suffix)}`, (t) => {
      const f = fixture(t);
      const link = join(f.home, "linked config");
      mkdirSync(join(f.config, "nested"));
      writeFileSync(join(f.config, "nested/config.json"), SECRET, { mode: 0o644 });
      symlinkSync(f.config, link);
      const result = f.run({ RMD_CONTAINER_CONFIG_DIR: `${link}${suffix}` });
      assert.equal(result.status, 1, result.out);
      assert.match(result.out, /STATE SNAPSHOT CONFIG COPY FAILED/);
      assert.ok(!result.out.includes(SECRET));
      for (const root of f.roots) {
        assert.equal(readFileSync(join(f.archive(root), "ledger.ndjson"), "utf8"), LEDGER);
        assert.equal(existsSync(join(f.archive(root), "container-config")), false);
      }
      assert.match(readFileSync(f.receipt, "utf8"), /^result=failed\n/);
      assert.equal(readFileSync(join(f.config, "config.json"), "utf8"), SECRET);
      assert.equal(statSync(join(f.config, "config.json")).mode & 0o777, 0o644);
    });
  }
});

test("W1-T12174 criterion 1: real config directories accept trailing slashes", (t) => {
  const f = fixture(t);
  const result = f.run({ RMD_CONTAINER_CONFIG_DIR: `${f.config}///` });
  assert.equal(result.status, 0, result.out);
  for (const root of f.roots) {
    const copy = join(f.archive(root), "container-config");
    assert.equal(statSync(copy).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(copy, "config.json"), "utf8"), SECRET);
    assert.equal(statSync(join(copy, "config.json")).mode & 0o777, 0o600);
  }
});

test("W1-T12174 criterion 3: absent, linked, or unreadable config fails the receipt after state snapshots", async (t) => {
  for (const failure of ["absent", "linked", "unreadable"] as const) await t.test(failure, (t) => {
    const f = fixture(t);
    const alternate = join(f.home, "alternate");
    if (failure === "linked") symlinkSync(f.config, alternate);
    const older = ["state-backup.2026-11-08T00-00-00-000Z", "state-backup.2026-11-09T00-00-00-000Z"];
    for (const night of older) {
      mkdirSync(join(f.archive(f.roots[0], night), "container-config"), { recursive: true });
      writeFileSync(join(f.archive(f.roots[0], night), "container-config/config.json"), "last good copy");
    }
    const result = f.run(failure === "unreadable"
      ? { FAIL_COPY_PATH: join(f.config, "config.json") }
      : { RMD_CONTAINER_CONFIG_DIR: alternate });
    assert.equal(result.status, 1, result.out);
    for (const root of f.roots) assert.equal(readFileSync(join(f.archive(root), "ledger.ndjson"), "utf8"), LEDGER);
    assert.match(result.out, /STATE SNAPSHOT CONFIG COPY FAILED/);
    assert.match(result.out, /reclaim-only — no pull, no restart/);
    assert.ok(!result.out.includes(SECRET));
    const receipt = readFileSync(f.receipt, "utf8");
    assert.match(receipt, /^result=failed\n/);
    assert.match(receipt, /archives=2\n/);
    assert.match(receipt, /reason=host-update: STATE SNAPSHOT CONFIG COPY FAILED/);
    for (const night of older) assert.equal(readFileSync(join(f.archive(f.roots[0], night), "container-config/config.json"), "utf8"), "last good copy");
  });
});

test("W1-T12174: a source swapped to a symlink during copy is removed without reading its target", (t) => {
  const f = fixture(t);
  const target = join(f.home, "outside");
  writeFileSync(target, "outside bytes", { mode: 0o644 });
  const result = f.run({ SWAP_COPY_PATH: join(f.config, "config.json"), SWAP_TARGET: target });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /STATE SNAPSHOT CONFIG COPY FAILED/);
  assert.equal(existsSync(join(f.archive(), "container-config/config.json")), false);
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.equal(readFileSync(target, "utf8"), "outside bytes");
});

test("W1-T12174: refuses an existing destination symlink without changing its target", (t) => {
  const f = fixture(t);
  const target = join(f.home, "outside");
  mkdirSync(target, { mode: 0o755 });
  const result = f.run({ STUB_CONFIG_LINK: target });
  assert.equal(result.status, 1, result.out);
  assert.match(readFileSync(f.receipt, "utf8"), /^result=failed\n/);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(statSync(target).mode & 0o777, 0o755);
});

test("W1-T12174 criterion 4: retention removes config only with its expired state archive", (t) => {
  const f = fixture(t);
  const backups = join(f.roots[0], "state-backups");
  for (const name of ["state-backup.2026-11-08T00-00-00-000Z", "state-backup.2026-11-09T00-00-00-000Z", "state-backup.operator"]) {
    mkdirSync(join(backups, name, "container-config"), { recursive: true });
    writeFileSync(join(backups, name, "container-config/config.json"), "older");
    writeFileSync(join(backups, name, "ledger.ndjson"), LEDGER);
  }
  writeFileSync(join(backups, "operator-note"), "keep me");
  const result = f.run();
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(readdirSync(backups).sort(), ["operator-note", "state-backup.2026-11-09T00-00-00-000Z", NIGHT, "state-backup.operator"].sort());
  assert.equal(readFileSync(join(f.archive(), "container-config/config.json"), "utf8"), SECRET);
  assert.equal(readFileSync(join(backups, "state-backup.2026-11-09T00-00-00-000Z/container-config/config.json"), "utf8"), "older");
  assert.equal(readFileSync(join(backups, "state-backup.operator/container-config/config.json"), "utf8"), "older");
  assert.equal(readFileSync(join(backups, "operator-note"), "utf8"), "keep me");
  for (const root of f.roots) assert.equal(readFileSync(join(root, "state/ledger.ndjson"), "utf8"), LEDGER);
});

test("W1-T12174: dry run leaves config and state backups untouched", (t) => {
  const f = fixture(t);
  const result = f.run({}, true);
  assert.equal(result.status, 0, result.out);
  for (const root of f.roots) assert.equal(existsSync(join(root, "state-backups")), false);
  assert.equal(existsSync(f.receipt), false);
});
