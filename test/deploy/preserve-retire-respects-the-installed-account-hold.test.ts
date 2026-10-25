/** Account authorization and candidate policy are independent inputs, exercised in private fixtures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const HELPER = join(REPO_ROOT, "deploy/mac/preserve-retire.py");
const NOW = Math.floor(Date.now() / 1000) + 48 * 3600;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-account-hold-")));
  const home = join(root, "account");
  mkdirSync(join(home, ".local/state/remudero"), { recursive: true, mode: 0o700 });
  for (const p of [home, join(home, ".local"), join(home, ".local/state"), join(home, ".local/state/remudero")]) chmodSync(p, 0o700);
  writeFileSync(join(home, ".local/state/remudero/preserve-retire.json"), JSON.stringify({ enabled: true }), { mode: 0o600 });
  return { root, home };
}
function probe(home: string, body: string) {
  const code = `import importlib.util, json, os, pwd, shutil, subprocess, sys, time, hashlib
spec = importlib.util.spec_from_file_location("pr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
home = sys.argv[2]
authority = os.path.join(home, m.CONFIG_REL)
def enabled(value):
    with open(authority, "w") as f: json.dump({"enabled": value}, f)
m.account_home = lambda: home
def held(action):
    try: action()
    except m.Hold as error:
        assert "responsible-account-hold" in str(error), error
    else: raise AssertionError("held action was allowed")
def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, env=dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null", GIT_AUTHOR_NAME="fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid", GIT_COMMITTER_NAME="fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid"))
    assert result.returncode == 0, result.stderr
    return result.stdout
now = int(sys.argv[3])
${body}`;
  return spawnSync("python3", ["-I", "-B", "-c", code, HELPER, home, String(NOW)], {
    encoding: "utf8", timeout: 120_000,
  });
}

test("an enabled alternate config cannot replace the account hold, while an explicitly unheld fixture retires a build directory", () => {
  const fx = fixture();
  try {
    const r = probe(fx.home, `
target = os.path.join(home, "target")
os.makedirs(os.path.join(target, ".local/state/remudero"), mode=0o700)
for p in [target, os.path.join(target, ".local"), os.path.join(target, ".local/state"), os.path.join(target, ".local/state/remudero")]: os.chmod(p, 0o700)
alternate = os.path.join(target, "alternate.json")
with open(alternate, "w") as f: json.dump(dict(m.DEFAULTS, enabled=True, idle_hours=6, interval_hours=0, roots=["work"], temp_roots=[]), f)
os.chmod(alternate, 0o600)
os.makedirs(os.path.join(target, "work/coverage"))
os.mkdir(os.path.join(target, "private-temp"))
with open(os.path.join(target, "work/package.json"), "w") as f: f.write("{}")
# Process liveness is controlled independently; authorization uses the real private-file reader.
m.process_snapshot = lambda: ([], set())
argv = [sys.argv[1], "--home", target, "--config", alternate, "--temp-base", os.path.join(target, "private-temp"), "--now", str(now), "--apply"]
os.environ["HOME"] = target
sys.argv = argv
enabled(False)
assert m.main() == 2
assert os.path.isdir(os.path.join(target, "work/coverage"))
assert not os.path.exists(os.path.join(target, "Remudero-preserved"))
assert not os.path.exists(os.path.join(target, m.STAMP_REL))
enabled(True)
assert m.main() == 0
assert not os.path.exists(os.path.join(target, "work/coverage")), "unheld positive must actually remove the build tree"
assert os.path.isfile(os.path.join(target, m.STAMP_REL))`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /responsible-account-hold/);
    assert.match(r.stdout, /REMOVED build-dir/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("every maintained destructive helper consults the account hold at its own action boundary", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.home, "work"));
    const seed = gitRepo({ kind: "janitor-account-hold" });
    renameSync(seed.dir, join(fx.home, "work/repo"));
    const r = probe(fx.home, `
root = os.path.join(home, "work")
repo = os.path.join(root, "repo")
with open(os.path.join(repo, "README"), "w") as f: f.write("fixture")
git("-C", repo, "add", "README"); git("-C", repo, "commit", "--quiet", "-m", "fixture")
git("-C", repo, "repack", "-a", "-d", "-q")
record = m.Repo(repo, "clone"); m.resolve_git(record)
wt = os.path.join(root, "stale")
git("-C", repo, "worktree", "add", "--quiet", "-b", "stale", wt); shutil.rmtree(wt)
plain = os.path.join(root, "plain"); os.mkdir(plain)
remove = m.Repo(plain, "clone")
compressed = os.path.join(root, "compress.log")
with open(compressed, "w") as f: f.write("compress me")
build = os.path.join(root, "build"); os.mkdir(build)
archive = os.path.join(root, "out.tar.gz")
expiry = os.path.join(home, "preserved"); os.mkdir(expiry)
old = os.path.join(expiry, "old@20000101T000000Z"); os.mkdir(old)
with open(os.path.join(old, "manifest.json"), "w") as f: json.dump({"preserved_at": 0}, f)
partial = os.path.join(expiry, ".incoming-old"); os.mkdir(partial); os.utime(partial, (0, 0))
cfg = dict(m.DEFAULTS, home=home, roots=[root], preserve_root=expiry, repack_min_packs=1)
published = type("Published", (), {"bases": [], "excludes": lambda self, repo: []})()
actions = [
    ("preserve", lambda: m.preserve(record, published, cfg, home, now)),
    ("remove", lambda: m.remove(remove, [root], [], [record])),
    ("prune", lambda: m.prune_worktrees([record.store], [record])),
    ("repack", lambda: m.housekeeping(cfg, [], [record], None, now, True)),
    ("compress", lambda: m.compress(compressed)),
    ("build", lambda: m.rmtree_writable(build)),
    ("archive", lambda: m.save_tar(root, ["repo/README"], archive)),
    ("expire-incoming", lambda: m.expire(cfg, now)),
]
def snapshot():
    result = []
    for top in [root, expiry]:
        for dp, dirs, files in os.walk(top):
            result.append((dp, os.lstat(dp).st_mode))
            for name in sorted(files):
                p = os.path.join(dp, name)
                with open(p, "rb") as f: digest = hashlib.sha256(f.read()).hexdigest()
                result.append((p, os.lstat(p).st_mode, digest))
    return sorted(result)
for name, action in actions:
    before = snapshot()
    enabled(False); held(action)
    assert snapshot() == before, (name, "held action changed fixture bytes or structure")
    enabled(True); action()
    print("authorized-positive", name)
# The first expiry invocation above reaches incoming cleanup first; this one reaches stamped expiry.
stamped = os.path.join(expiry, "second@20000101T000000Z"); os.mkdir(stamped)
with open(os.path.join(stamped, "manifest.json"), "w") as f: json.dump({"preserved_at": 0}, f)
enabled(False); held(lambda: m.expire(cfg, now))
enabled(True); m.expire(cfg, now); assert not os.path.exists(stamped)
assert not os.path.exists(plain)
assert not os.path.exists(os.path.join(record.store, "worktrees", "stale"))
assert os.path.isfile(compressed + ".gz") and not os.path.exists(compressed)
assert not os.path.exists(build)
assert os.path.isfile(archive)
assert not os.path.exists(old) and not os.path.exists(partial)`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal((r.stdout.match(/authorized-positive /g) ?? []).length, 8);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a hold activated during housekeeping stops the next dump and session deletion", () => {
  const fx = fixture();
  try {
    const r = probe(fx.home, `
root = os.path.join(home, "work"); os.mkdir(root)
dump = os.path.join(root, "old.log")
with open(dump, "wb") as f: f.write(b"x" * (5 << 20))
session_dir = os.path.join(home, ".codex/sessions"); os.makedirs(session_dir)
session = os.path.join(session_dir, "rollout-old.jsonl")
with open(session, "w") as f: f.write("{}")
cfg = dict(m.DEFAULTS, home=home, roots=[root], codex_session_days=1, dump_retain_days=1)
# These are actual filesystem actions. Each guard must be reached after the candidate was selected.
original = m.in_use
for path in [dump, session]:
    def arrive(p, snap):
        if p == path: enabled(False)
        return ""
    m.in_use = arrive
    enabled(True)
    held(lambda: m.housekeeping(cfg, [], [], ([], set()), now, True))
    assert os.path.isfile(path)
    # Keep earlier candidates out of the next iteration without weakening any production guard.
    if path == dump: cfg["roots"] = []
m.in_use = original
enabled(True)
result = m.housekeeping(cfg, [], [], ([], set()), now, True)
assert result["codex-sessions-removed"] == 1 and not os.path.exists(session)
cfg["roots"] = [root]
result = m.housekeeping(cfg, [], [], ([], set()), now, True)
assert result["dumps-expired"] == 1 and not os.path.exists(dump)`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a hold activated during compression retains the original and unfinished artifact", () => {
  const fx = fixture();
  try {
    const r = probe(fx.home, `
path = os.path.join(home, "large.log")
with open(path, "w") as f: f.write("original content")
stat = m.os.stat
calls = 0
def arrive(p, *a, **k):
    global calls
    if p == path:
        calls += 1
        if calls == 2: enabled(False)
    return stat(p, *a, **k)
m.os.stat = arrive
held(lambda: m.compress(path))
assert os.path.isfile(path) and os.path.isfile(path + ".gz.incoming")
assert not os.path.exists(path + ".gz")
m.os.stat = stat
enabled(True)
m.compress(path)
assert not os.path.exists(path) and os.path.isfile(path + ".gz")`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("responsible hold identity ignores HOME and refuses missing malformed unsafe and unreadable evidence", () => {
  const fx = fixture();
  try {
    const r = probe(fx.home, `
# Exercise the real OS resolver independently of test substitution and caller HOME.
os.environ["HOME"] = "/caller-cannot-select-authority"
# Restore the actual default function by importing a fresh module without the fixture substitution.
spec2 = importlib.util.spec_from_file_location("default_pr", sys.argv[1]); default = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(default)
assert default.account_home() == os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
for content in ["{", "[]", '{"enabled": 1}', '{"enabled": true, "unknown": 1}', "x" * 65537]:
    with open(authority, "w") as f: f.write(content)
    held(m.require_action_authorized)
enabled(True); os.chmod(authority, 0o644); held(m.require_action_authorized)
os.chmod(authority, 0o600)
os.rename(authority, authority + ".retained"); held(m.require_action_authorized)
os.symlink(authority + ".retained", authority); held(m.require_action_authorized)
os.unlink(authority); os.rename(authority + ".retained", authority)
reader = m.os.open
def deny(*a, **k): raise PermissionError("fixture denied")
m.os.open = deny; held(m.require_action_authorized)
m.os.open = reader
fstat = m.os.fstat
def unsafe(fd):
    st = fstat(fd)
    return type("Unsafe", (), {"st_mode": st.st_mode, "st_uid": os.getuid() + 1})()
m.os.fstat = unsafe; held(m.require_action_authorized)
m.os.fstat = fstat
resolver = m.account_home
def unknown_account(): raise KeyError("missing account")
m.account_home = unknown_account; held(m.require_action_authorized)
m.account_home = resolver
enabled(True); m.require_action_authorized()`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});


test("a hold activated before a read-only-tree retry prevents permission changes and removal", () => {
  const fx = fixture();
  try {
    const r = probe(fx.home, `
path = os.path.join(home, "retry"); os.mkdir(path); os.chmod(path, 0o500)
original = m.shutil.rmtree
def retry(p, onerror):
    enabled(False)
    onerror(os.rmdir, p, None)
m.shutil.rmtree = retry
held(lambda: m.rmtree_writable(path))
assert os.stat(path).st_mode & 0o777 == 0o500
assert os.path.isdir(path)
m.shutil.rmtree = original
enabled(True); m.rmtree_writable(path)
assert not os.path.exists(path)`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
