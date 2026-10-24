import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { age, fixture, git, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const janitor = join(process.cwd(), "deploy/mac/remudero-janitor.sh");
const reclaim = join(process.cwd(), "deploy/mac/tmp-reclaim.sh");
const native = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
function setup() {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home); fx.scratch = realpathSync(fx.scratch);
  const bin = join(fx.root, "bin");
  const stat = native("stat"), find = native("find");
  writeFileSync(join(bin, "stat"), `#!/bin/bash
if [ "$2" = '%m %c' ]; then shift 2; exec '${stat}' -f '%m %m' "$@"; fi
if [ "$2" = '%Y %Z' ]; then shift 2; exec '${stat}' -c '%Y %Y' "$@"; fi
exec '${stat}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "find"), `#!/bin/bash
args=(); for arg; do [ "$arg" != -cmin ] || arg=-mmin; args+=("$arg"); done
exec '${find}' "\${args[@]}"
`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), '#!/bin/bash\n[ "${FAIL_PS:-0}" != 1 ] || exit 2\nprintf "1 %s\\n" "${LIVE_COMMAND:-/bin/sh}"\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!/bin/bash
[ "\${FAIL_LSOF:-0}" != 1 ] || exit 2
case " $* " in *" -d cwd "*) exit 0 ;; esac
target="\${@: -1}"
while IFS= read -r p; do
  case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; exit 0 ;; esac
done < '${fx.lsofList}'
exit 1
`, { mode: 0o755 });
  writeFileSync(join(bin, "df"), '#!/bin/bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/fixture 209715200 183500800 ${FREE_KB:-26214400} 88% /"\n', { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${fx.root}/npm.calls'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "sysctl"), '#!/bin/bash\necho "vm.swapusage: total = 2048.00M used = 1024.00M free = 1024.00M (encrypted)"\n', { mode: 0o755 });
  mkdirSync(join(fx.home, "Remudero/.session-scratch"), { recursive: true });
  mkdirSync(join(fx.home, "rmd-work"), { recursive: true });
  return fx;
}
function payload(path: string, hours = 7) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "disposable cache\n"); age(path, hours); return path;
}
function run(fx: Fixture, script = janitor, apply = true, extra: Record<string, string> = {}) {
  const result = spawnSync("bash", [script, apply ? "--apply" : "--dry-run"], { encoding: "utf8", timeout: 60_000, env: {
    ...process.env, HOME: fx.home, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`, TMPDIR: fx.scratch,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_DIRECTORY_ROOTS: fx.scratch, REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"),
    RMD_RECLAIM_ROOT: fx.scratch, RMD_RECLAIM_REPORT: join(fx.root, "retained.txt"), ...extra,
  } });
  assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout;
}
function receipts(fx: Fixture) { return readFileSync(join(fx.home, ".local/state/remudero/janitor-decisions.tsv"), "utf8"); }

test("W1-T10256: the Mac janitor reclaims the residual #13134 left and keeps what is live", () => {
  const fx = setup();
  try {
    const scratch = join(fx.home, "Remudero/.session-scratch");
    const old = payload(join(scratch, "mixed/nested/old.bin"));
    const loose = payload(join(scratch, "loose.bin"));
    const fresh = payload(join(scratch, "mixed/recent.bin"), 1);
    const kept = [fresh, payload(join(scratch, "secret-token")), payload(join(scratch, "repair.patch")),
      payload(join(scratch, "repo/.git/HEAD")), payload(join(scratch, "active/old.bin")),
      payload(join(scratch, "symlinked/old.bin"))];
    symlinkSync(fx.scratch, join(scratch, "symlinked/link"));
    writeFileSync(fx.lsofList, join(scratch, "active/old.bin") + "\n");
    const dry = run(fx, reclaim, false); assert.equal(existsSync(old), true); assert.match(dry, /WOULD DELETE/);
    const output = run(fx, reclaim);
    for (const path of [old, loose]) assert.equal(existsSync(path), false, output);
    for (const path of kept) assert.equal(existsSync(path), true, path + output);
    assert.match(output, /session scratch files deleted: 2, /);
    const cache = payload(join(fx.home, ".cache/remudero-store-fill-old/payload")); age(dirname(cache));
    const npm = payload(join(fx.home, ".npm/_cacache/content-v2/old"));
    const npx = payload(join(fx.home, ".npm/_npx/old/payload")); age(dirname(npx));
    const held = [payload(join(fx.home, ".cache/remudero/gh-last-read")),
      payload(join(fx.home, ".cache/remudero-live/payload"), 1),
      payload(join(fx.home, ".cache/remudero-evidence/work.bundle")),
      payload(join(fx.home, ".cache/remudero-coordination/task.lock")),
      payload(join(fx.home, ".cache/remudero-lock.lock/payload")),
      payload(join(fx.home, ".npm/_cacache/content-v2/recent"), 1)];
    const result = run(fx);
    for (const path of [cache, npm, npx]) assert.equal(existsSync(path), false, result);
    for (const path of held) assert.equal(existsSync(path), true, path + result);
    assert.match(readFileSync(join(fx.root, "npm.calls"), "utf8"), /cache verify/);
    assert.match(receipts(fx), /\tremoved\t/);
    assert.equal(existsSync(join(fx.home, ".local/state/remudero/preserve-retire.json")), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("W1-T10256: a broken alternates entry is repaired when its store exists", () => {
  for (const kind of ["relative", "dangling", "bare-lender", "wrong", "missing", "dry-run"] as const) {
    const fx = setup();
    try {
      const lender = join(fx.home, "Remudero/repos/lender"); mkdirSync(lender, { recursive: true });
      git(lender, "init", "-b", "main"); payload(join(lender, "source"));
      git(lender, "add", "."); git(lender, "commit", "-m", "fixture");
      let source = lender;
      if (kind === "bare-lender") {
        source = join(fx.home, ".local/share/remudero/git-pools/lender.git"); mkdirSync(dirname(source), { recursive: true });
        git(fx.root, "clone", "--bare", lender, source); rmSync(lender, { recursive: true });
      }
      const borrower = join(fx.home, "rmd-work/borrower"); git(fx.root, "clone", "--shared", source, borrower);
      const file = join(borrower, ".git/objects/info/alternates"), store = kind === "bare-lender" ? join(source, "objects") : join(lender, ".git/objects");
      const wrong = join(fx.home, "wrong/objects"); mkdirSync(wrong, { recursive: true });
      const original = kind === "wrong" ? relative(dirname(dirname(file)), wrong) + "\n"
        : kind === "dangling" || kind === "bare-lender" || kind === "missing" ? "/gone/lender/.git/objects\n"
        : relative(dirname(dirname(file)), store) + "\n";
      writeFileSync(file, original); age(borrower);
      if (kind === "missing") rmSync(lender, { recursive: true });
      const output = run(fx, janitor, kind !== "dry-run");
      const repaired = kind === "relative" || kind === "dangling" || kind === "bare-lender";
      assert.equal(readFileSync(file, "utf8"), repaired ? store + "\n" : original, output);
      if (repaired || kind === "wrong") assert.equal(readFileSync(file + ".pre-repair", "utf8"), original);
      if (repaired) { assert.ok(git(borrower, "rev-parse", "HEAD").trim()); assert.match(receipts(fx), /\trepaired\t/); }
      if (kind === "wrong") assert.match(receipts(fx), /\trepair-reverted\t/);
      if (kind === "missing" || kind === "dry-run") assert.equal(existsSync(file + ".pre-repair"), false);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("W1-T10256: a projected low-space report names consumers and the unreadable remainder", () => {
  for (const declining of [true, false]) {
    const fx = setup();
    try {
      const state = join(fx.home, ".local/state/remudero"); mkdirSync(state, { recursive: true });
      const now = Number(execFileSync("date", ["+%s"], { encoding: "utf8" }).trim());
      writeFileSync(join(state, "janitor-free-samples.tsv"), `${now - 3600}\t${(declining ? 40 : 20) * 2 ** 30}\n`);
      payload(join(fx.home, "large-consumer/payload"));
      const result = run(fx);
      if (declining) {
        assert.equal((result.match(/low-space-report: begin/g) ?? []).length, 1, result);
        assert.match(result, /top-consumer:.*large-consumer/);
        assert.match(result, /swap:.*1073741824/);
        assert.match(result, /unaccounted.*other accounts and system areas this account cannot read/);
        assert.match(result, /operator acts there/);
        assert.match(result, /preserve-retire: disabled.*dry-run.*count=0.*bytes=0/);
        assert.match(receipts(fx), /\tlow-space-report\t/);
      } else assert.doesNotMatch(result, /low-space-report: begin/);
      assert.doesNotMatch(result, /WARN low-space:/);
      assert.equal(existsSync(join(state, "preserve-retire.json")), false);
      assert.equal(readFileSync(join(state, "janitor-free-samples.tsv"), "utf8").trim().split("\n").length, 2);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("residual cleanup holds activity, failed probes, fresh ctime and cache evidence", () => {
  for (const kind of ["npm", "open", "ps-failed", "lsof-failed", "ctime", "git", "symlink"] as const) {
    const fx = setup();
    try {
      const cache = join(fx.home, ".cache/remudero-idle");
      const file = payload(join(cache, "old")); age(cache);
      const npm = payload(join(fx.home, ".npm/_cacache/content-v2/old"));
      const scratch = payload(join(fx.home, "Remudero/.session-scratch/old"));
      const extra: Record<string, string> = {};
      if (kind === "npm") extra.LIVE_COMMAND = "node /tools/npm/bin/npm-cli.js install";
      if (kind === "open") writeFileSync(fx.lsofList, `${file}\n${npm}\n${scratch}\n`);
      if (kind === "ps-failed") extra.FAIL_PS = "1";
      if (kind === "lsof-failed") extra.FAIL_LSOF = "1";
      if (kind === "ctime") { rmSync(join(fx.root, "bin/stat")); rmSync(join(fx.root, "bin/find")); }
      if (kind === "git") mkdirSync(join(cache, ".git"));
      if (kind === "symlink") symlinkSync(fx.scratch, join(cache, "outside"));
      const output = run(fx, janitor, true, extra);
      assert.equal(existsSync(file), kind !== "npm", kind + output);
      assert.equal(existsSync(npm), !["git", "symlink"].includes(kind), kind + output);
      if (kind === "npm") assert.equal(existsSync(join(fx.root, "npm.calls")), false);
      if (kind === "open" || kind === "ps-failed" || kind === "lsof-failed" || kind === "ctime") {
        run(fx, reclaim, true, extra); assert.equal(existsSync(scratch), true, kind);
      }
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

function realOpenFileFixture(launcherParent = false): void {
  const fx = setup(); const originalCwd = process.cwd(); let fd: number | undefined;
  try {
    const held = payload(join(fx.home, ".cache/remudero-held/old")); age(dirname(held));
    const idle = payload(join(fx.home, ".cache/remudero-idle/old")); age(dirname(idle));
    rmSync(join(fx.root, "bin/lsof"));
    rmSync(join(fx.root, "bin/ps"));
    fd = openSync(held, "r");
    if (launcherParent) process.chdir(dirname(fx.root));
    const output = run(fx);
    assert.equal(existsSync(held), true, output); assert.equal(existsSync(idle), false, output);
  } finally { process.chdir(originalCwd); if (fd !== undefined) closeSync(fd); rmSync(fx.root, { recursive: true, force: true }); }
}

test("real open-file probes retain a residual cache while its idle sibling is removed", () => {
  realOpenFileFixture();
});

test("real ps and lsof retain an open cache from a launcher directory and reclaim its idle peer", () => {
  realOpenFileFixture(true);
});

test("cron without npm falls back to six-hour whole-tree cleanup and keeps mixed-age caches", () => {
  const fx = setup();
  try {
    const bin = join(fx.root, "bin"); rmSync(join(bin, "npm"));
    for (const name of ["bash", "sh", "dirname", "id", "uname", "mkdir", "rmdir", "date", "du", "cut", "grep", "awk", "tee", "chmod", "rm", "python3", "git", "wc", "cksum", "sed", "sort", "readlink"]) {
      symlinkSync(native(name), join(bin, name));
    }
    const cache = join(fx.home, ".npm/_cacache"); payload(join(cache, "content-v2/old")); age(cache);
    const mixed = join(fx.home, ".npm/_npx"); payload(join(mixed, "old")); payload(join(mixed, "new"), 1);
    const output = run(fx, janitor, true, { PATH: bin });
    assert.equal(existsSync(cache), false, output); assert.equal(existsSync(join(mixed, "old")), true, output);
    assert.equal(existsSync(join(fx.root, "npm.calls")), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a disabled preservation report carries nonzero dry-run counts and bytes without enabling retirement", () => {
  const fx = setup();
  try {
    const installed = join(fx.root, "installed"); mkdirSync(installed);
    for (const file of [janitor, join(process.cwd(), "deploy/workspace-retirement-guard.sh"), join(process.cwd(), "deploy/dependency-seed-guard.sh")]) {
      execFileSync("cp", [file, installed]);
    }
    const candidate = join(fx.home, "rmd-work/planned"); payload(join(candidate, "source"));
    writeFileSync(join(installed, "preserve-retire.py"), `import os, subprocess
DEFAULTS = {'roots': ['rmd-work'], 'preserve_root': 'Remudero-preserved', 'idle_hours': 24, 'census_seconds': 180}
def run(cmd, **kw): return subprocess.run(cmd, capture_output=True)
def protected_paths(home, cfg): return []
def discover(cfg, protected):
    class Repo:
        path = os.path.join(cfg['roots'][0], 'planned')
        hold = ''; gitdir = None
    return [Repo()]
def resolve_git(repo): pass
def process_snapshot(): return ([], set())
def recent_path(repo, cutoff): return ''
def in_use(path, snap): return ''
def home_private(home): return False
def keep_closure(repos, keep, borrowers, private): return keep
if __name__ == '__main__': print('preserve-retire: disabled (no config)')
`);
    const state = join(fx.home, ".local/state/remudero"); mkdirSync(state, { recursive: true });
    const now = Number(execFileSync("date", ["+%s"], { encoding: "utf8" }).trim());
    writeFileSync(join(state, "janitor-free-samples.tsv"), `${now-3600}\t${40*2**30}\n`);
    const output = run(fx, join(installed, "remudero-janitor.sh"));
    assert.match(output, /dry-run defaults count=1 bytes=[1-9][0-9]*/);
    assert.equal(existsSync(join(candidate, "source")), true);
    assert.equal(existsSync(join(state, "preserve-retire.json")), false);
    assert.equal(existsSync(join(fx.home, "Remudero-preserved")), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
