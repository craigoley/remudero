#!/usr/bin/env python3
"""Preserve, then retire, idle checkouts that the janitor would otherwise hold forever.

The janitor never removes unpublished, dirty or ignored work, so on an account that is never
cleaned by hand those checkouts accumulate until the disk is full. This phase saves that work
first and retires a checkout only after the copy is verified. It is opt-in per account through an
owner-private config file; without it the phase reports "disabled" and changes nothing.

Invariants (JANITOR.md "Preserve-then-retire"):
- Every candidate is preserved before any candidate is deleted, and a candidate whose copy cannot
  be verified is held. The keep set is recomputed after preservation, so a held borrower keeps its
  object lender.
- A repository is held, never deleted, when its history is unreadable, when it has an untracked
  file over the size limit, when a worktree is locked, or when any probe fails.
- Clones and bare repositories are deleted only when no other account can enter this home and a
  complete census found no kept borrower of their objects.
- Housekeeping changes no history: a repository with too many packs is repacked keeping every
  object, and outside any checkout idle dumps are compressed (deleted after dump_retain_days) and
  idle regenerable build folders are removed.
- Temp roots (`temp_roots`, matched under /private/tmp) count only when owned by this account. The
  borrower census always walks the temp folders as well as the home, so a kept clone of this
  account keeps a temp lender; macOS clears /private/tmp at boot, so no account can rely on
  borrowing objects from it.
- Codex session logs idle for `codex_session_days` (0 = never) and not open are deleted.
- No action touches a path under a keep declaration (`KEEP_MARKERS`, or a seed generation's
  `ready.json` beside `consumers/`) on it, above it or inside it, or one that cannot be inspected:
  it is never retired, repacked, pruned, compressed, expired or removed. Seed stores belong to the
  reference-aware seed sweeper alone.
- Discovery scans the configured roots, then the whole home (depth 8; never `HOME_PRUNE` folders,
  symlinks, protected paths, the preserve root or shared object pools) for checkouts and bare
  repositories with a remote containing a `managed_remotes` entry, then every worktree a discovered
  clone or bare store has registered, even inside a `.git` folder. A repository without a managed
  remote outside the roots is never a candidate. Removal accepts only a path under a root or one
  found by those two rules inside the home. Loose-folder housekeeping and repacking stay in the roots.
Usage: preserve-retire.py --home DIR [--apply] [--config PATH]
"""
import argparse, glob, gzip, json, os, pwd, re, shlex, shutil, stat, subprocess, sys, tarfile, tempfile, time

CONFIG_REL = ".local/state/remudero/preserve-retire.json"
STAMP_REL = ".local/state/remudero/preserve-retire.last"
MIN_IDLE_HOURS = 6
DEFAULTS = {"enabled": False, "idle_hours": 24, "retain_days": 7, "interval_hours": 6,
            "preserve_root": "Remudero-preserved", "max_untracked_mb": 50, "census_seconds": 180,
            "repack_min_packs": 50, "repack_seconds": 1800, "dump_min_mb": 5, "dump_retain_days": 7,
            "codex_session_days": 0,
            "roots": ["Remudero", "rmd-work", ".codex/work-artifacts", "Developer/remudero-operator-worktrees",
                      "Developer/remudero-operator-recovered-worktrees-*", "Downloads/remudero-*",
                      ".local/share/remudero/source-recovery"],
            "temp_roots": [],
            "managed_remotes": ["github.com/craigoley/remudero"],
            "published_remotes": ["https://github.com/craigoley/", "git@github.com:craigoley/",
                                  "ssh://git@github.com/craigoley/"]}
# Regenerable trees that are neither preserved nor counted as data.
SKIP_DIRS = ("node_modules", "coverage", "dist", ".turbo", ".next")
# Outside a checkout these are removed once idle; `dist` may be a deliverable, so it stays.
BUILD_DIRS = ("node_modules", "coverage", ".turbo", ".next")
DUMP_SUFFIXES = (".json", ".jsonl", ".ndjson", ".log", ".lcov", ".info")
# An application or framework bundle is an installed program, never a pile of dumps.
BUNDLE_SUFFIXES = (".app", ".framework", ".xcframework", ".bundle")
# Keep declarations shared with cache-reclaim.py KEEP and dependency-seed-guard.sh. Seed stores and their
# generations are collected only by the reference-aware seed sweeper (deploy/DEPENDENCY-SEEDS.md).
KEEP_MARKERS = (".rmd-janitor-keep", ".rmd-scratch-keep", ".rmd-dependency-seed-root.json")
# Home-wide discovery never enters these folders (personal data, installs, Git admin) or a symlink.
HOME_PRUNE = {"Library", "Documents", "Desktop", "Pictures", "Music", "Movies", "Applications", ".Trash",
              "node_modules", ".git"}
# Shared infrastructure stores (object pools other checkouts borrow from) are never discovered home-wide.
PER_WORKTREE_REFS = ("refs/worktree/", "refs/bisect/", "refs/rewritten/")
HOME_PRUNE_PATHS = (".local/share/remudero/git-pools", ".local/share/remudero/repositories")
MAX_DEPTH = 8
CENSUS_PRUNE = {"Library", ".Trash", "Music", "Movies", "Pictures", "node_modules"}
TEMP_BASE = "/private/tmp"
CODEX_SESSION_DIRS = (".codex/sessions", ".codex/archived_sessions")
MIN_FREE_BYTES = 1 << 30
MAIN_HISTORY = 20000


def say(action, detail="", path=""):
    print(" ".join(x for x in ("preserve-retire:", action, detail, path) if x), flush=True)


def run(cmd, inp=None, timeout=600, env_override=None):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    try:
        return subprocess.run(cmd, input=inp, capture_output=True, env=env_override or env, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return subprocess.CompletedProcess(cmd, 255, b"", str(error).encode())


class Repo:
    def __init__(self, path, kind):
        self.path, self.kind = path, kind  # kind: worktree | clone | bare
        self.gitdir = self.store = None    # store = the object-store owner (common git dir)
        self.lenders, self.hold = [], ""
        self.scoped = ""                   # keep_scope reason for this checkout or its store
        self.via = "root"                  # root | managed-remote | registered-worktree (remove guard)

    def git(self, *args, **kw):
        if self.kind == "bare":
            return run(["git", "--git-dir", self.path, *args], **kw)
        return run(["git", "-C", self.path, *args], **kw)


# ---------- configuration ----------

def private_file(path, uid, home):
    """Owner-private regular file inside `home`, whose folders up to and including `home`
    are owned by this account and not writable by others. Above `home` is the OS's concern."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if not path.startswith(home + "/"):
        return False
    if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
        return False
    parent = os.path.dirname(path)
    while True:
        pst = os.lstat(parent)
        if stat.S_ISLNK(pst.st_mode) or pst.st_mode & 0o022 or pst.st_uid != uid:
            return False
        if parent == home:
            return True
        parent = os.path.dirname(parent)


def load_config(home, path, temp_base=TEMP_BASE):
    ok = private_file(os.path.abspath(path), os.getuid(), home)
    if ok is None:
        return None, "disabled (no config)"
    if not ok:
        return None, "refused: config must be an owner-private 0600 file inside the home, below private parents"
    try:
        raw = json.load(open(path))
    except (OSError, ValueError) as error:
        return None, f"refused: config unreadable ({error.__class__.__name__})"
    if not isinstance(raw, dict) or set(raw) - set(DEFAULTS):
        return None, "refused: config has unknown keys"
    cfg = dict(DEFAULTS, **raw)
    ints = ("idle_hours", "retain_days", "interval_hours", "max_untracked_mb", "census_seconds",
            "repack_min_packs", "repack_seconds", "dump_min_mb", "dump_retain_days", "codex_session_days")
    if any(type(cfg[k]) is not int or cfg[k] < 0 for k in ints) or cfg["idle_hours"] < MIN_IDLE_HOURS:
        return None, f"refused: numeric settings must be whole numbers, idle_hours >= {MIN_IDLE_HOURS}"
    if cfg["enabled"] is not True:
        return None, "disabled (config enabled=false)"
    if type(cfg["managed_remotes"]) is not list or any(type(m) is not str or not m.strip() for m in cfg["managed_remotes"]):
        return None, "refused: managed_remotes must be a list of non-empty strings"
    cfg["preserve_root"] = os.path.join(home, cfg["preserve_root"])
    cfg["home"] = home
    if any(type(r) is not str or os.path.isabs(r) or ".." in r.split("/") for r in cfg["roots"] + cfg["temp_roots"]):
        return None, "refused: roots must be relative to the home, temp_roots to the temp folder"
    cfg["temp_roots"] = owned_temp_roots(temp_base, cfg["temp_roots"])
    cfg["temp_base"] = temp_base
    cfg["roots"] = expand_roots(home, cfg["roots"]) + cfg["temp_roots"]
    for root in cfg["roots"]:
        if cfg["preserve_root"] == root or cfg["preserve_root"].startswith(root + "/") or root.startswith(cfg["preserve_root"] + "/"):
            return None, "refused: preserve_root overlaps a scan root"
    return cfg, ""


def account_home():
    """The running account's OS home, independent of HOME, --home and --config."""
    return os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)


def require_action_authorized():
    """The installed default config is the account's hold, not an invocation policy input.
    Read it afresh at each action boundary; alternate config/home cannot replace it."""
    try:
        home = account_home()
        path = os.path.join(home, CONFIG_REL)
        if private_file(path, os.getuid(), home) is not True:
            raise Hold("responsible-account-hold (default config missing or unsafe)")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            st = os.fstat(stream.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
                raise Hold("responsible-account-hold (default config unsafe)")
            data = stream.read(65537)
        if len(data) > 65536:
            raise Hold("responsible-account-hold (default config oversized)")
        raw = json.loads(data)
        if not isinstance(raw, dict) or set(raw) - set(DEFAULTS) or raw.get("enabled") is not True:
            raise Hold("responsible-account-hold (default config not enabled)")
    except (OSError, ValueError, KeyError) as error:
        raise Hold(f"responsible-account-hold (default config unreadable: {error.__class__.__name__})") from error


def expand_roots(home, roots):
    """Absolute scan roots; a root containing `*` names every folder it matches."""
    out = []
    for r in roots:
        p = os.path.join(home, r)
        out += sorted(m for m in glob.glob(p) if os.path.isdir(m) and not os.path.islink(m)) if "*" in r else [p]
    return out


def owned_temp_roots(base, patterns):
    """Folders in the shared temp folder that match a pattern and that this account owns outright;
    a symlink or a folder another account made is never a root."""
    uid, out = os.getuid(), []
    for m in expand_roots(base, patterns):
        try:
            st = os.lstat(m)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(st.st_mode) and st.st_uid == uid and os.path.realpath(m) == m:
            out.append(m)
    return out


def protected_paths(home, cfg):
    fixed = ["Remudero/remudero", "Remudero/remudero-console", "Remudero/remudero-site",
             "Remudero/state", "Remudero/repos", "rmd-state2"]
    return [os.path.join(home, p) for p in fixed] + [cfg["preserve_root"]]


def inside(path, parents):
    return any(path == p or path.startswith(p + "/") for p in parents)


def keep_here(folder):
    """Why `folder` itself must be left alone: a keep marker of any kind (file, folder, symlink,
    dangling link), or the layout of a seed generation even without a marker. Unreadable holds."""
    for name in KEEP_MARKERS + ("ready.json",):
        try:
            os.lstat(os.path.join(folder, name))
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError as error:
            return f"keep-inspection-unknown ({name}: {error.__class__.__name__})"
        if name != "ready.json":
            return f"keep-declared ({name})"
        # A consumers entry of any kind (a link, a dangling link, a file) is seed-shaped evidence the
        # seed sweeper cannot verify either, so it holds as firmly as a real consumers folder.
        try:
            st = os.lstat(os.path.join(folder, "consumers"))
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError as error:
            return f"keep-inspection-unknown (consumers: {error.__class__.__name__})"
        if stat.S_ISDIR(st.st_mode):
            return "managed-seed-generation (ready.json, consumers)"
        return "seed-shaped-unknown (ready.json beside a consumers entry that is not a folder)"
    return ""


def keep_scope(path, below=True):
    """Why no action of this phase may touch `path`: a keep declaration on it, on any folder above it,
    or (with `below`) anywhere inside it. Every remove, retire, repack, prune, compress and expiry asks
    this first, so a kept tree keeps its objects, refs and working files; failing to look holds."""
    p = path if os.path.isdir(path) and not os.path.islink(path) else os.path.dirname(path)
    while True:
        why = keep_here(p)
        if why:
            return f"{why} at {p}"
        if os.path.dirname(p) == p:
            break
        p = os.path.dirname(p)
    if not below or os.path.islink(path) or not os.path.isdir(path):
        return ""
    try:
        for dirpath, dirs, files in os.walk(path, onerror=_raise):
            why = keep_here(dirpath) if dirpath != path else ""
            if why:
                return f"{why} at {dirpath}"
            # A Git object or admin store holds history, not declarations; links are never followed.
            dirs[:] = [d for d in dirs if d != ".git" and not os.path.islink(os.path.join(dirpath, d))
                       and not (d == "objects" and "HEAD" in files and "refs" in dirs)]
    except OSError as error:
        return f"keep-inspection-unknown ({error.__class__.__name__}) in {path}"
    return ""


# ---------- discovery and facts ----------

def is_bare(path, names, dirs):
    if "HEAD" not in names or "objects" not in dirs or "refs" not in dirs:
        return False
    out = run(["git", "--git-dir", path, "rev-parse", "--is-bare-repository"])
    return out.returncode == 0 and out.stdout.strip() == b"true"


def discover(cfg, protected):
    """Root discovery, then managed checkouts anywhere in the home, then registered worktrees."""
    found = {}
    for root in cfg["roots"]:
        if not os.path.isdir(root) or os.path.islink(root):
            continue
        base_depth = root.count("/")
        for dirpath, dirs, files in os.walk(root):
            if dirpath.count("/") - base_depth >= MAX_DEPTH or inside(dirpath, protected):
                dirs[:] = []
                continue
            if dirpath != root:
                if ".git" in files or ".git" in dirs:
                    if not os.path.islink(os.path.join(dirpath, ".git")):
                        found[dirpath] = "worktree" if ".git" in files else "clone"
                elif is_bare(dirpath, files, dirs):
                    found[dirpath] = "bare"
                    dirs[:] = []
                    continue
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules")
                       and not os.path.islink(os.path.join(dirpath, d))
                       and not (dirpath == root and d in ("lanes", "state"))]
    repos = {p: Repo(p, k) for p, k in found.items()}
    for p, k in discover_managed(cfg, protected, set(repos)):
        repos[p] = Repo(p, k)
        repos[p].via = "managed-remote"
    for p in registered_worktrees(cfg["home"], protected, list(repos.values())):
        if p not in repos:
            repos[p] = Repo(p, "worktree")
            repos[p].via = "registered-worktree"
    return [repos[p] for p in sorted(repos)]


def remote_urls(path, kind):
    """Every configured remote URL; an unreadable config yields none, so the repo is never a candidate."""
    cmd = ["git", "--git-dir", path] if kind == "bare" else ["git", "-C", path]
    out = run(cmd + ["config", "--get-regexp", r"^remote\..*\.url$"], timeout=30)
    if out.returncode != 0:
        return []
    return [line.split(" ", 1)[1] for line in out.stdout.decode(errors="replace").splitlines() if " " in line]


def managed(path, kind, cfg):
    return any(m in url for url in remote_urls(path, kind) for m in cfg["managed_remotes"])


def discover_managed(cfg, protected, known):
    """Checkouts and bare repositories anywhere in the home (outside the roots, which were walked
    already) with a remote naming a `managed_remotes` entry. A repository without one is never a
    candidate, so personal projects are left alone however idle they are."""
    home = cfg["home"]
    skip = protected + [os.path.join(home, p) for p in HOME_PRUNE_PATHS] + [r for r in cfg["roots"] if inside(r, [home])]
    base_depth = home.count("/")
    for dirpath, dirs, files in os.walk(home):
        if dirpath.count("/") - base_depth >= MAX_DEPTH:
            dirs[:] = []
            continue
        if dirpath != home and dirpath not in known:
            if ".git" in files or ".git" in dirs:
                kind = "worktree" if ".git" in files else "clone"
                if not os.path.islink(os.path.join(dirpath, ".git")) and managed(dirpath, kind, cfg):
                    yield dirpath, kind
            elif is_bare(dirpath, files, dirs):
                if managed(dirpath, "bare", cfg):
                    yield dirpath, "bare"
                dirs[:] = []
                continue
        dirs[:] = [d for d in dirs if d not in HOME_PRUNE and not os.path.islink(os.path.join(dirpath, d))
                   and not inside(os.path.join(dirpath, d), skip)]


def registered_worktrees(home, protected, repos):
    """Worktrees a discovered clone or bare store has registered (`worktrees/*/gitdir`), wherever they
    are, even inside a `.git` folder or outside every root: inside the home, real, not protected."""
    out = []
    for r in repos:
        if r.kind == "worktree":
            continue
        admin = os.path.join(r.path if r.kind == "bare" else os.path.join(r.path, ".git"), "worktrees")
        if os.path.islink(admin) or not os.path.isdir(admin):
            continue
        for name in sorted(os.listdir(admin)):
            try:
                with open(os.path.join(admin, name, "gitdir")) as stream:
                    text = stream.read().strip()
            except OSError:
                continue
            path = os.path.dirname(text) if os.path.basename(text) == ".git" else ""
            if (path and os.path.isabs(path) and inside(path, [home]) and path != home
                    and os.path.realpath(path) == path and os.path.isfile(os.path.join(path, ".git"))
                    and not os.path.islink(os.path.join(path, ".git")) and not inside(path, protected)):
                out.append(path)
    return out


def resolve_git(repo):
    """Fill gitdir/store/lenders; set hold when the layout is unreadable."""
    p = repo.path
    if repo.kind == "bare":
        repo.gitdir = repo.store = os.path.realpath(p)
    elif repo.kind == "clone":
        repo.gitdir = repo.store = os.path.realpath(os.path.join(p, ".git"))
    else:
        try:
            text = open(os.path.join(p, ".git")).read().strip()
        except OSError:
            repo.hold = "git-file-unreadable"
            return
        if not text.startswith("gitdir: "):
            repo.hold = "git-file-malformed"
            return
        gd = text[8:]
        gd = os.path.realpath(gd if os.path.isabs(gd) else os.path.join(p, gd))
        if not os.path.isdir(gd):
            repo.hold = "history-unrecoverable (worktree git dir missing)"
            return
        repo.gitdir = gd
        common = gd
        cfile = os.path.join(gd, "commondir")
        if os.path.isfile(cfile):
            c = open(cfile).read().strip()
            common = os.path.realpath(c if os.path.isabs(c) else os.path.join(gd, c))
        if not os.path.isdir(common):
            repo.hold = "history-unrecoverable (common git dir missing)"
            return
        repo.store = common
    alt = os.path.join(repo.store, "objects/info/alternates")
    if os.path.isfile(alt):
        for line in open(alt, errors="replace"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            objdir = line if os.path.isabs(line) else os.path.join(repo.store, "objects", line)
            if not os.path.isdir(objdir):
                repo.hold = "history-unrecoverable (alternate object store missing)"
                return
            repo.lenders.append(os.path.dirname(os.path.realpath(objdir.rstrip("/"))))


def _raise(error):
    raise error


def recent_path(repo, cutoff):
    """Newest sign of use: any entry outside the repo's own git dir, plus its HEAD file.
    Returns the first path changed after `cutoff`; an unreadable path counts as changed."""
    heads = [os.path.join(repo.gitdir, "HEAD")] if repo.gitdir else []
    for h in heads:
        try:
            st = os.lstat(h)
            if max(st.st_mtime, st.st_ctime) > cutoff:
                return h
        except OSError:
            return h
    for dirpath, dirs, files in os.walk(repo.path, onerror=_raise):
        if repo.kind != "bare" and dirpath == repo.path:
            dirs[:] = [d for d in dirs if d != ".git"]
            files = [f for f in files if f != ".git"]
        for name in [None] + files + dirs:
            p = dirpath if name is None else os.path.join(dirpath, name)
            try:
                st = os.lstat(p)
            except OSError:
                return p
            if max(st.st_mtime, st.st_ctime) > cutoff:
                return p
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(dirpath, d))]
    return ""


def process_snapshot():
    """Command lines and every open path (including cwds). None means unknown: hold everything."""
    ps = run(["ps", "-axww", "-o", "command="], timeout=120)
    lsof = run(["lsof", "-nP", "-Fn"], timeout=300)
    if ps.returncode != 0 or (lsof.returncode != 0 and not lsof.stdout):
        return None
    commands = ps.stdout.decode(errors="replace").split("\n")
    opened = {line[1:] for line in lsof.stdout.decode(errors="replace").split("\n") if line.startswith("n/")}
    return commands, opened


def in_use(path, snap):
    commands, opened = snap
    if any(path in c for c in commands):
        return "live command names it"
    prefix = path + "/"
    if any(o == path or o.startswith(prefix) for o in opened):
        return "open file or cwd inside"
    return ""


def home_private(home):
    """True only when no other account can enter the home directory (mode and ACL)."""
    st = os.stat(home)
    if st.st_mode & 0o011:
        return False
    if sys.platform == "darwin":
        out = run(["ls", "-led", home])
        if out.returncode != 0:
            return False
        return not any(" allow " in line for line in out.stdout.decode().split("\n")[1:])
    if shutil.which("getfacl"):
        out = run(["getfacl", "-p", "-c", home])
        return out.returncode == 0 and not re.search(rb"^(user|group):[^:]+:", out.stdout, re.M)
    return True


def borrower_census(home, seconds, extra=()):
    """Map lender git dir -> borrower git dirs for every alternates file in this home and in
    `extra` folders. Returns None when the walk did not finish within its budget."""
    deadline = time.monotonic() + seconds
    borrowers = {}
    for dirpath, dirs, files in (w for top in (home, *extra) for w in os.walk(top)):
        if time.monotonic() > deadline:
            return None
        dirs[:] = [d for d in dirs if d not in CENSUS_PRUNE and not os.path.islink(os.path.join(dirpath, d))]
        if dirpath.endswith("/objects"):
            dirs[:] = [d for d in dirs if d == "info"]
        if dirpath.endswith("/objects/info") and "alternates" in files:
            store = os.path.realpath(os.path.dirname(os.path.dirname(dirpath)))
            for line in open(os.path.join(dirpath, "alternates"), errors="replace"):
                line = line.strip()
                if line and not line.startswith("#"):
                    objdir = line if os.path.isabs(line) else os.path.join(store, "objects", line)
                    lender = os.path.dirname(os.path.realpath(objdir.rstrip("/")))
                    borrowers.setdefault(lender, set()).add(store)
    return borrowers


# ---------- planning ----------

def keep_closure(repos, keep, borrowers, lenders_ok):
    """Grow `keep` until no deletion would break a kept repository."""
    owner = {r.store: r for r in repos if r.kind in ("clone", "bare") and r.store}
    changed = True
    while changed:
        changed = False
        for r in repos:
            if r.path in keep:
                continue
            why = ""
            if r.kind in ("clone", "bare"):
                if not lenders_ok:
                    why = "lender-unverified (home reachable by other accounts or census incomplete)"
                for w in repos:
                    if not why and w.kind == "worktree" and w.store == r.store and w.path in keep:
                        why = "has-kept-worktree"
                # A borrower that is not a candidate clone or bare repo is kept by definition.
                for b in borrowers.get(r.store, ()):
                    if not why and (b not in owner or owner[b].path in keep):
                        why = "lends-objects-to-kept"
            if not why:
                for q in repos:
                    if q.path in keep and q.path.startswith(r.path + "/"):
                        why = "contains-kept"
                        break
            if why:
                keep[r.path] = why
                changed = True
    return keep


# ---------- preservation ----------

class Published:
    """First-parent history of each published main, newest first, from a local copy."""

    def __init__(self, home, prefixes, repos):
        self.prefixes, self.lists, self.bases = prefixes, [], []
        urls = set()
        for r in repos:
            for line in r.git("remote", "-v").stdout.decode(errors="replace").split("\n"):
                parts = line.split()
                if len(parts) >= 2 and self.published(parts[1]):
                    urls.add(parts[1])
        pools = sorted(os.path.join(dp, d) for dp in [os.path.join(home, ".local/share/remudero/git-pools")]
                       if os.path.isdir(dp) for d in os.listdir(dp) if d.endswith(".git"))
        for url in sorted(urls):
            out = run(["git", "ls-remote", "--exit-code", url, "refs/heads/main"], timeout=120)
            tip = out.stdout.split()[0].decode() if out.returncode == 0 and out.stdout.split() else ""
            if not tip:
                continue
            for base in pools + [r.store for r in repos if r.store]:
                if run(["git", "--git-dir", base, "cat-file", "-e", tip + "^{commit}"]).returncode == 0:
                    hist = run(["git", "--git-dir", base, "rev-list", "--first-parent", "-n", str(MAIN_HISTORY), tip])
                    if hist.returncode == 0:
                        self.lists.append(hist.stdout)
                        self.bases.append(base)
                    break

    def published(self, url):
        return any(url.startswith(p) for p in self.prefixes)

    def excludes(self, repo):
        shas = []
        for text in self.lists:
            out = repo.git("cat-file", "--batch-check", inp=text)
            for line in out.stdout.decode().split("\n"):
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "commit":
                    shas.append(parts[0])
                    break
        # A cached main of a published remote was published when fetched.
        urls = {}
        for line in repo.git("remote", "-v").stdout.decode(errors="replace").split("\n"):
            parts = line.split()
            if len(parts) >= 2:
                urls[parts[0]] = parts[1]
        refs = repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/").stdout.decode()
        for line in refs.split("\n"):
            if not line:
                continue
            ref, sha = line.split()
            if self.published(urls.get(ref.split("/")[2], "")) and ref.rsplit("/", 1)[-1] in ("main", "master"):
                shas.append(sha)
        return list(dict.fromkeys(shas))


def git_reason(out):
    """Git's last stderr line, so a hold says why without a rerun."""
    lines = out.stderr.decode(errors="replace").strip().split("\n")
    return lines[-1][:120] or f"exit {out.returncode}"


def save_tar(path, members, dest):
    require_action_authorized()
    with tarfile.open(dest, "w:gz") as t:
        for rel in members:
            t.add(os.path.join(path, rel), arcname=rel, recursive=False)


def copy_git_env():
    """Neither inherited object stores nor replacement objects may qualify a saved copy."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return dict(env, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
                GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0",
                GIT_OPTIONAL_LOCKS="0")


def copy_git(repo, *args, inp=None):
    prefix = ["git", "--git-dir", repo.path] if repo.kind == "bare" else ["git", "-C", repo.path]
    return run(prefix + list(args), inp=inp, env_override=copy_git_env())


def git_snapshot(repo):
    """Freeze all named refs, not just branches/tags or commits unpublished upstream. A worktree's
    removal loses only its HEAD and per-worktree refs; its branches stay in the common store."""
    fmt = copy_git(repo, "rev-parse", "--show-object-format")
    shallow = copy_git(repo, "rev-parse", "--is-shallow-repository")
    if fmt.returncode or fmt.stdout.strip() != b"sha1" or shallow.returncode or shallow.stdout.strip() != b"false":
        raise Hold("git-copy-unsupported-format-or-shallow")
    refs = copy_git(repo, "for-each-ref", "--format=%(objectname) %(refname)")
    if refs.returncode or refs.stderr:
        raise Hold("refs-unreadable")
    entries = []
    for line in refs.stdout.decode(errors="surrogateescape").splitlines():
        parts = line.split(" ", 1)
        if len(parts) != 2 or not re.fullmatch("[0-9a-f]{40}", parts[0]) or not parts[1].startswith("refs/"):
            raise Hold("refs-unreadable")
        if repo.kind != "worktree" or parts[1].startswith(PER_WORKTREE_REFS):
            entries.append(parts)
    head = copy_git(repo, "rev-parse", "--verify", "HEAD")
    symbolic = copy_git(repo, "symbolic-ref", "-q", "HEAD")
    if head.returncode or not re.fullmatch(b"[0-9a-f]{40}\n?", head.stdout):
        raise Hold("history-unrecoverable (HEAD unreadable)")
    if symbolic.returncode not in (0, 1):
        raise Hold("HEAD-unreadable")
    return {"refs": entries, "head": head.stdout.decode().strip(),
            "symbolic_head": symbolic.stdout.decode().strip() if symbolic.returncode == 0 else ""}


def verify_git_copy(bundle, snapshot, expected, work):
    """Qualify in an empty independent store; source objects cannot satisfy prerequisites."""
    require_action_authorized()
    target = tempfile.mkdtemp(prefix=".verify-", dir=work)
    env = copy_git_env()
    try:
        def checked(*args, inp=None):
            result = run(["git", "--git-dir", target, *args], inp=inp, env_override=env)
            if result.returncode:
                raise Hold(f"independent-git-copy-unverified ({git_reason(result)})")
            return result.stdout
        checked("init", "--bare", "--quiet", "--template=")
        checked("bundle", "verify", bundle)
        checked("bundle", "unbundle", bundle)
        commands = "".join(f"update {ref} {oid}\n" for oid, ref in snapshot["refs"])
        checked("update-ref", "--stdin", inp=commands.encode(errors="surrogateescape"))
        checked("update-ref", "--no-deref", "HEAD", snapshot["head"])
        restored = checked("for-each-ref", "--format=%(objectname) %(refname)")
        wanted = "".join(f"{oid} {ref}\n" for oid, ref in snapshot["refs"]).encode(errors="surrogateescape")
        if restored != wanted or checked("rev-parse", "HEAD").decode().strip() != snapshot["head"]:
            raise Hold("independent-git-copy-ref-mismatch")
        actual = checked("cat-file", "--batch-all-objects", "--batch-check=%(objectname)").splitlines()
        if set(actual) != set(expected):
            raise Hold("independent-git-copy-object-mismatch")
        checked("fsck", "--full", "--no-reflogs", "--no-dangling")
    finally:
        require_action_authorized()
        shutil.rmtree(target)


def save_git_copy(repo, snapshot, work, cfg):
    roots = list(dict.fromkeys([oid for oid, _ in snapshot["refs"]] + [snapshot["head"]]))
    root_input = ("\n".join(roots) + "\n").encode()
    objects = copy_git(repo, "rev-list", "--objects", "--no-object-names", "--stdin", inp=root_input)
    if objects.returncode:
        raise Hold("git-copy-closure-unreadable")
    oids = objects.stdout.splitlines()
    if not oids or any(not re.fullmatch(b"[0-9a-f]{40}", oid) for oid in oids):
        raise Hold("git-copy-closure-unreadable")
    sizes = copy_git(repo, "cat-file", "--batch-check=%(objectname) %(objectsize) %(objectsize:disk) %(deltabase)",
                     inp=objects.stdout)
    total = 0
    try:
        rows = [line.split() for line in sizes.stdout.splitlines()]
        if sizes.returncode or len(rows) != len(oids) or any(len(row) != 4 or row[0] != oid for row, oid in zip(rows, oids)):
            raise ValueError()
        closure = set(oids)
        # A stored form whose delta base is in the closure is reused as is; any other object
        # is recompressed whole, which zlib can grow by at most a sliver.
        total = sum(int(disk) if base.strip(b"0") == b"" or base in closure else int(size) + int(size) // 100 + 64
                    for _, size, disk, base in rows)
    except ValueError:
        raise Hold("git-copy-size-unreadable")
    # Bundle plus index overhead, twice: bundle and verifier store.
    bound = total + total // 100 + len(oids) * 256 + 65536
    if free_bytes(cfg["preserve_root"]) < MIN_FREE_BYTES + 2 * bound:
        raise Hold("git-copy-disk-floor (complete independent copy would not fit)")
    bundle = os.path.join(work, "unpublished.bundle")  # stable artifact name, now every saved ref
    require_action_authorized()
    with open(bundle, "wb") as output:
        output.write(b"# v2 git bundle\n")
        for oid, ref in snapshot["refs"] + [[snapshot["head"], "HEAD"]]:
            output.write(f"{oid} {ref}\n".encode(errors="surrogateescape"))
        output.write(b"\n")
        output.flush()  # subprocess shares this fd; buffered headers must precede PACK
        prefix = ["git", "--git-dir", repo.path] if repo.kind == "bare" else ["git", "-C", repo.path]
        try:
            made = subprocess.run(prefix + ["pack-objects", "--stdout", "--revs", "--no-use-bitmap-index",
                "--depth=4095", "--threads=1"], input=root_input,
                stdout=output, stderr=subprocess.PIPE, env=copy_git_env(), timeout=600)
        except (OSError, subprocess.TimeoutExpired):
            raise Hold("git-copy-pack-failed")
        if made.returncode:
            raise Hold(f"git-copy-pack-failed ({git_reason(made)})")
    if free_bytes(cfg["preserve_root"]) < MIN_FREE_BYTES + os.path.getsize(bundle) + len(oids) * 256 + 65536:
        raise Hold("git-copy-disk-floor (verifier store would not fit)")
    verify_git_copy(bundle, snapshot, oids, work)
    return len(set(oids))


def preserve(repo, published, cfg, home, now):
    """Write a verified copy of everything retirement would lose. Returns (dir, summary) or raises Hold."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
    rel = os.path.relpath(repo.path, home) if repo.path.startswith(home + "/") else "tmp/" + os.path.relpath(repo.path, cfg["temp_base"])
    name = rel.replace("/", "__") + "@" + stamp
    final = os.path.join(cfg["preserve_root"], name)
    require_action_authorized()
    work = tempfile.mkdtemp(prefix=".incoming-", dir=cfg["preserve_root"])
    summary = {"path": repo.path, "kind": repo.kind, "preserved_at": now}
    try:
        snapshot = git_snapshot(repo)
        summary["git_snapshot"] = snapshot
        remotes = repo.git("remote")
        if remotes.returncode != 0:
            raise Hold("remotes-unreadable")
        summary["remotes"] = {}
        for name in remotes.stdout.decode().splitlines():
            url = repo.git("remote", "get-url", name)
            if url.returncode != 0:
                raise Hold("remote-url-unreadable")
            summary["remotes"][name] = url.stdout.decode().strip()
        if repo.kind != "bare":
            if repo.git("cat-file", "-e", "HEAD^{tree}").returncode != 0:
                raise Hold("history-unrecoverable (HEAD unreadable)")
            summary["head"] = repo.git("rev-parse", "HEAD").stdout.decode().strip()
            summary["branch"] = repo.git("branch", "--show-current").stdout.decode().strip()
        excl = published.excludes(repo)
        if repo.kind == "bare":
            revs = ["--all"]
        elif repo.kind == "worktree":
            revs = ["HEAD"] + [ref for _, ref in snapshot["refs"]]
        else:
            revs = ["--branches", "--tags", "HEAD"]
            if repo.git("rev-parse", "--verify", "-q", "refs/stash").returncode == 0:
                revs.append("refs/stash")
        revs += ["^" + s for s in excl]
        count = repo.git("rev-list", "--count", *revs)
        if count.returncode != 0:
            raise Hold("history-unrecoverable (rev-list failed)")
        summary["unpublished_commits"] = int(count.stdout or 0)
        summary["published_base"] = excl
        summary["packed_objects"] = save_git_copy(repo, snapshot, work, cfg)
        summary["bundle_prerequisites"] = []
        require_action_authorized()
        with open(os.path.join(work, "refs.txt"), "w", errors="surrogateescape") as refs:
            refs.write("".join(f"{oid} {ref}\n" for oid, ref in snapshot["refs"]))
        if repo.kind == "bare":
            save_tar(repo.path, [p for p in ("config", "description", "hooks", "info", "packed-refs")
                                 if os.path.exists(os.path.join(repo.path, p))], os.path.join(work, "config-hooks.tar.gz"))
        else:
            diff = repo.git("diff", "--binary", "HEAD")
            if diff.returncode != 0:
                raise Hold("diff-failed")
            if diff.stdout:
                require_action_authorized()
                open(os.path.join(work, "uncommitted.patch"), "wb").write(diff.stdout)
            excl_args = [a for d in SKIP_DIRS for a in ("-x", d)]
            listing = repo.git("ls-files", "-z", "--others", *excl_args)
            if listing.returncode != 0:
                raise Hold("untracked-listing-failed")
            members = [m for m in listing.stdout.decode(errors="surrogateescape").split("\0") if m]
            limit = cfg["max_untracked_mb"] << 20
            for rel in members:
                full = os.path.join(repo.path, rel)
                if not os.path.islink(full) and os.path.getsize(full) > limit:
                    raise Hold(f"untracked-file-over-{cfg['max_untracked_mb']}MB ({rel})")
            if members:
                save_tar(repo.path, members, os.path.join(work, "untracked.tar.gz"))
            summary["uncommitted_bytes"], summary["untracked_files"] = len(diff.stdout), len(members)
        require_action_authorized()
        json.dump(summary, open(os.path.join(work, "manifest.json"), "w"), indent=1)
        require_action_authorized()
        open(os.path.join(work, "MANIFEST.txt"), "w").write(restore_text(summary, final))
        if git_snapshot(repo) != snapshot:
            raise Hold("refs-changed-during-preservation")
        require_action_authorized()
        os.rename(work, final)
        return final, summary
    except BaseException:
        require_action_authorized()  # a newly held incomplete copy is retained, not cleaned up
        shutil.rmtree(work, ignore_errors=True)
        raise


def restore_text(s, final):
    remotes = s.get("remotes", {})
    upstream = remotes.get("origin") or next(iter(remotes.values()), "<upstream URL>")
    return f"""Preserved by the janitor's preserve-then-retire phase (deploy/mac/JANITOR.md).
path:   {s['path']}
kind:   {s['kind']}
head:   {s.get('head', '-')}  branch: {s.get('branch', '-')}
remotes: {json.dumps(remotes)}
commits not in published main: {s['unpublished_commits']}

Restore:
  git init <dir> && cd <dir>
  git remote add origin {shlex.quote(upstream)}   # optional: names the upstream; restore never fetches it
  git bundle unbundle {shlex.quote(final + "/unpublished.bundle")}   # self-contained; no upstream required
  # refs.txt lists every saved ref: recreate EACH with git update-ref <ref> <sha>
  # manifest.json git_snapshot also records original symbolic HEAD; restore it if wanted
  git checkout {s.get('head', '<sha from refs.txt>')}
  git apply --binary {final}/uncommitted.patch                              # if present
  tar -xzf {final}/untracked.tar.gz                                          # if present
"""


class Hold(Exception):
    pass


# ---------- retirement and retention ----------

def store_keep_scope(store, repos):
    """Recheck declarations on every checkout sharing this store, including registered worktrees
    outside discovery roots. Cached positive holds stay held; a cached absence grants nothing."""
    why = keep_scope(store, below=False)
    if why:
        return why
    for q in repos:
        if q.store == store:
            why = q.scoped or keep_scope(q.path)
            if why:
                return f"store-of-a-keep-scoped-checkout ({why})"
    listing = run(["git", "--git-dir", store, "worktree", "list", "--porcelain", "-z"], timeout=30)
    if listing.returncode != 0 or not listing.stdout.endswith(b"\0\0"):
        return "keep-inspection-unknown (worktree listing unavailable)"
    paths = []
    for record in listing.stdout.split(b"\0\0")[:-1]:
        first = record.split(b"\0", 1)[0]
        if not first.startswith(b"worktree "):
            return "keep-inspection-unknown (worktree listing malformed)"
        path = os.fsdecode(first[len(b"worktree "):])
        if not os.path.isabs(path) or os.path.islink(path):
            return "keep-inspection-unknown (worktree path unsafe)"
        paths.append(path)
    if not paths:
        return "keep-inspection-unknown (worktree listing empty)"
    for path in paths:
        why = keep_scope(path)
        if why:
            return f"store-of-a-keep-scoped-checkout ({why})"
    return ""


def remove(repo, roots, protected, repos, home=None):
    """A path under a scan root, or one discovered by managed remote or worktree registration inside the home."""
    p = repo.path
    discovered = repo.via in ("managed-remote", "registered-worktree") and home and p.startswith(home + "/")
    if (not os.path.isabs(p) or os.path.realpath(p) != p or os.path.islink(p) or inside(p, protected)
            or not (any(p.startswith(r + "/") for r in roots) or discovered)):
        raise Hold("path-guard")
    why = keep_scope(p) or (repo.store and store_keep_scope(repo.store, repos))
    if why:
        raise Hold(f"{why} (declared before remove)")
    require_action_authorized()
    if repo.kind == "worktree":
        out = run(["git", "--git-dir", repo.store, "worktree", "remove", "--force", p])
        if out.returncode != 0:
            raise Hold("git-worktree-remove-refused (" + out.stderr.decode(errors="replace").strip().split("\n")[-1][:80] + ")")
    else:
        shutil.rmtree(p)


def prune_worktrees(stores, repos):
    """`git worktree prune` each store, except one a keep-scoped checkout shares or one under a keep
    declaration: its stale worktree records are admin data of a held store. Returns those pruned."""
    pruned = []
    for store in stores:
        if store_keep_scope(store, repos):
            continue
        require_action_authorized()
        run(["git", "--git-dir", store, "worktree", "prune"])
        pruned.append(store)
    return pruned


def expire(cfg, now):
    root, cutoff = cfg["preserve_root"], now - cfg["retain_days"] * 86400
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if os.path.islink(path) or not os.path.isdir(path) or keep_scope(path):
            continue
        if name.startswith(".incoming-") and os.lstat(path).st_mtime < now - 86400:
            require_action_authorized()
            shutil.rmtree(path)  # an interrupted preservation; it never counted as a copy
            continue
        if not re.search(r"@\d{8}T\d{6}Z$", name):
            continue
        try:
            when = json.load(open(os.path.join(path, "manifest.json")))["preserved_at"]
        except (OSError, ValueError, KeyError):
            continue  # unknown age: keep
        if when < cutoff and os.lstat(path).st_uid == os.getuid():
            require_action_authorized()
            shutil.rmtree(path)
            say("EXPIRED", f"preserved {cfg['retain_days']}d+ ago", path)


def free_bytes(path):
    return shutil.disk_usage(path).free


# ---------- housekeeping ----------

def changed_after(top, cutoff):
    """First entry under `top` (itself included) changed after `cutoff`; unreadable counts as changed."""
    try:
        st = os.lstat(top)
        if max(st.st_mtime, st.st_ctime) > cutoff:
            return top
        for dirpath, dirs, files in os.walk(top, onerror=_raise):
            for name in files + dirs:
                p = os.path.join(dirpath, name)
                st = os.lstat(p)
                if max(st.st_mtime, st.st_ctime) > cutoff:
                    return p
            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(dirpath, d))]
    except OSError:
        return top
    return ""


def rmtree_writable(path):
    """Remove a tree whose folders may be read-only (dependency clones are)."""
    def retry(func, p, _exc):
        require_action_authorized()
        os.chmod(os.path.dirname(p), 0o700)
        if not os.path.islink(p) and os.path.isdir(p):
            os.chmod(p, 0o700)
        require_action_authorized()
        func(p)
    require_action_authorized()
    shutil.rmtree(path, onerror=retry)


def loose_folders(cfg, protected):
    """Folders under the roots that belong to no repository and no keep declaration, walked top-down."""
    for root in cfg["roots"]:
        if not os.path.isdir(root) or os.path.islink(root) or keep_scope(root, below=False):
            continue
        for dirpath, dirs, files in os.walk(root):
            if inside(dirpath, protected) or ".git" in dirs or ".git" in files or (
                    "HEAD" in files and "objects" in dirs and "refs" in dirs) or keep_here(dirpath):
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(dirpath, d)) and not d.endswith(BUNDLE_SUFFIXES)]
            yield dirpath, dirs, files


def compress(path):
    """gzip `path` beside itself, keeping its times; the original goes only after a full read-back."""
    st = os.stat(path)
    tmp = path + ".gz.incoming"
    try:
        require_action_authorized()
        with open(path, "rb") as src, gzip.open(tmp, "wb", 6) as dst:
            shutil.copyfileobj(src, dst, 1 << 20)
        size = 0
        with gzip.open(tmp, "rb") as back:
            while chunk := back.read(1 << 20):
                size += len(chunk)
        now = os.stat(path)
        if size != st.st_size or (now.st_mtime, now.st_size) != (st.st_mtime, st.st_size):
            raise Hold("changed-while-compressing")
        require_action_authorized()
        os.utime(tmp, (st.st_atime, st.st_mtime))
        os.rename(tmp, path + ".gz")
        require_action_authorized()
        os.remove(path)
    finally:
        if os.path.exists(tmp):
            require_action_authorized()
            os.remove(tmp)


def housekeeping(cfg, protected, repos, snap, now, apply):
    """Repack, compress, expire and clear what retirement never reaches. Returns counts."""
    counts = {"repacked": 0, "compressed": 0, "dumps-expired": 0, "build-dirs-removed": 0,
              "codex-sessions-removed": 0}
    planned = {"REPACKED": "WOULD-REPACK", "REMOVED": "WOULD-REMOVE", "EXPIRED": "WOULD-EXPIRE",
               "COMPRESSED": "WOULD-COMPRESS"}
    verb = (lambda done: done) if apply else planned.get
    # A store shared by any keep-scoped checkout (a marker in its working tree, say) is never rewritten.
    held = {r.store for r in repos if r.store and r.scoped}
    stores = sorted({r.store for r in repos if r.store and os.path.isdir(r.store)
                     and any(r.store.startswith(root + "/") for root in cfg["roots"])
                     and not inside(r.store, protected) and r.store not in held and not keep_scope(r.store)})
    for store in stores:
        pack_dir = os.path.join(store, "objects", "pack")
        packs = len([f for f in os.listdir(pack_dir) if f.endswith(".pack")]) if os.path.isdir(pack_dir) else 0
        if packs < cfg["repack_min_packs"] or os.path.exists(os.path.join(store, "gc.pid")):
            continue
        why = store_keep_scope(store, repos)
        if why:
            say("HOLD", why, store)
            continue
        if apply:
            # -l leaves borrowed objects with their lender; --keep-unreachable drops nothing.
            require_action_authorized()
            out = run(["git", "--git-dir", store, "repack", "-a", "-d", "-l", "--keep-unreachable", "-q"],
                      timeout=cfg["repack_seconds"])
            if out.returncode != 0:
                say("HOLD", "repack-failed", store)
                continue
            packs = f"{packs}->{len([f for f in os.listdir(pack_dir) if f.endswith('.pack')])}"
        counts["repacked"] += 1
        say(verb("REPACKED"), f"packs={packs}", store)
    if snap is None:
        say("HOLD", "housekeeping (process-visibility-unknown)")
        return counts
    cutoff, expiry = now - cfg["idle_hours"] * 3600, now - cfg["dump_retain_days"] * 86400
    for dirpath, dirs, files in loose_folders(cfg, protected):
        for d in [d for d in dirs if d in BUILD_DIRS]:
            dirs.remove(d)
            p = os.path.join(dirpath, d)
            # node_modules is always an install; the others only at a package root, since a folder
            # of the same name elsewhere may be fixture data.
            if (d != "node_modules" and "package.json" not in files) or changed_after(p, cutoff) or in_use(p, snap):
                continue
            why = keep_scope(p)  # a seed store or keep marker inside the build dir holds all of it
            if why:
                say("HOLD", why, p)
                continue
            if apply:
                try:
                    rmtree_writable(p)
                except OSError as error:
                    say("HOLD", f"remove-failed ({error.__class__.__name__})", p)
                    continue
            counts["build-dirs-removed"] += 1
            say(verb("REMOVED"), "build-dir", p)
        # A package root is a project, whose small JSON and logs are its files, not dumps.
        for name in [] if "package.json" in files else files:
            p = os.path.join(dirpath, name)
            plain = name.endswith(DUMP_SUFFIXES)
            if not (plain or (name.endswith(".gz") and name[:-3].endswith(DUMP_SUFFIXES))):
                continue
            try:
                st = os.lstat(p)
            except OSError:
                continue
            last = max(st.st_mtime, st.st_ctime)
            # Only a large plain file or one already compressed is a dump; a small config or log is not.
            if not stat.S_ISREG(st.st_mode) or (plain and st.st_size < cfg["dump_min_mb"] << 20) or in_use(p, snap):
                continue
            # Compression keeps the original modification time, so the age survives it.
            if st.st_mtime < expiry and last < cutoff:
                if apply:
                    require_action_authorized()
                    os.remove(p)
                counts["dumps-expired"] += 1
                say(verb("EXPIRED"), f"dump unchanged {cfg['dump_retain_days']}d+", p)
            elif plain and last < cutoff and not os.path.exists(p + ".gz"):
                if apply:
                    try:
                        compress(p)
                    except (Hold, OSError) as error:
                        say("HOLD", f"compress-failed ({error.__class__.__name__})", p)
                        continue
                counts["compressed"] += 1
                say(verb("COMPRESSED"), f"{st.st_size >> 20}MB", p)
    days = cfg["codex_session_days"]
    for p in codex_sessions(cfg["home"]) if days else []:
        st = os.lstat(p)
        if max(st.st_mtime, st.st_ctime) >= now - days * 86400 or in_use(p, snap) or keep_scope(p, below=False):
            continue
        if apply:
            require_action_authorized()
            os.remove(p)
        counts["codex-sessions-removed"] += 1
        say(verb("REMOVED"), f"codex session idle {days}d+", p)
    return counts


def codex_sessions(home):
    """Regular Codex session logs (rollout-*.jsonl, plain or compressed) in this account's Codex folder."""
    for rel in CODEX_SESSION_DIRS:
        top = os.path.join(home, rel)
        if not os.path.isdir(top) or os.path.islink(top):
            continue
        for dirpath, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(dirpath, d))]
            for name in sorted(files):
                p = os.path.join(dirpath, name)
                if re.fullmatch(r"rollout-.*\.jsonl(\.zst|\.gz)?", name) and stat.S_ISREG(os.lstat(p).st_mode):
                    yield p


def main_authorized():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--config")
    ap.add_argument("--now", type=int, help=argparse.SUPPRESS)  # fixtures only: shifts the clock forward
    ap.add_argument("--temp-base", default=TEMP_BASE, help=argparse.SUPPRESS)  # fixtures only
    a = ap.parse_args()
    home = os.path.realpath(a.home)
    cfg, why = load_config(home, a.config or os.path.join(home, CONFIG_REL), a.temp_base)
    if cfg is None:
        say(why)
        return 2 if why.startswith("refused") else 0
    require_action_authorized()
    now = a.now or int(time.time())
    stamp_file = os.path.join(home, STAMP_REL)
    if a.apply and os.path.exists(stamp_file) and now - os.path.getmtime(stamp_file) < cfg["interval_hours"] * 3600:
        say("skip", f"ran within {cfg['interval_hours']}h")
        return 0
    require_action_authorized()
    os.makedirs(cfg["preserve_root"], mode=0o700, exist_ok=True)
    protected = protected_paths(home, cfg)
    repos = discover(cfg, protected)
    cutoff = now - cfg["idle_hours"] * 3600
    snap = process_snapshot()
    keep = {}
    for r in repos:
        resolve_git(r)
        r.scoped = keep_scope(r.path) or (r.store and keep_scope(r.store, below=False)) or ""
    # Every checkout of a store a keep-scoped checkout shares is held too: removing one would rewrite
    # the held store's worktree admin data, and its prune would follow.
    held_stores = {r.store for r in repos if r.store and r.scoped}
    for r in repos:
        if not r.scoped and r.store in held_stores:
            r.scoped = "store-of-a-keep-scoped-checkout"
        if r.hold:
            keep[r.path] = r.hold
        elif r.scoped:
            keep[r.path] = r.scoped
        elif os.lstat(r.path).st_uid != os.getuid():
            keep[r.path] = "foreign-owner"
        elif snap is None:
            keep[r.path] = "process-visibility-unknown"
        else:
            try:
                hit = recent_path(r, cutoff)
            except OSError:
                hit = r.path
            why = f"active <{cfg['idle_hours']}h" if hit else in_use(r.path, snap)
            if not why and r.kind == "worktree" and os.path.exists(os.path.join(r.gitdir, "locked")):
                why = "worktree-locked"
            if why:
                keep[r.path] = why
    lenders_ok = home_private(home)
    # A clone in a temp folder may borrow from a home checkout whether or not temp roots are scanned.
    census_extra = sorted({cfg["temp_base"], os.path.realpath(tempfile.gettempdir())})
    borrowers = borrower_census(home, cfg["census_seconds"], census_extra) if lenders_ok else {}
    if borrowers is None:
        lenders_ok, borrowers = False, {}
    keep_closure(repos, keep, borrowers, lenders_ok)
    candidates = [r for r in repos if r.path not in keep]

    # Phase 1: preserve every candidate before deleting any of them. A dry run plans only.
    published = Published(home, cfg["published_remotes"], repos) if a.apply and candidates else None
    saved = {}
    for r in candidates if a.apply else []:
        if free_bytes(cfg["preserve_root"]) < MIN_FREE_BYTES:
            keep[r.path] = "disk-floor (preservation needs 1 GiB free)"
            continue
        try:
            saved[r.path] = preserve(r, published, cfg, home, now)
            say("PRESERVED", f"{saved[r.path][1]['unpublished_commits']} commits", saved[r.path][0])
        except Hold as h:
            keep[r.path] = str(h)
        except OSError as error:
            keep[r.path] = f"preserve-failed ({error.__class__.__name__})"
    keep_closure(repos, keep, borrowers, lenders_ok)
    for path, why in sorted(keep.items()):
        say("HOLD", why, path)

    # Phase 2: retire, worktrees first so their common repository can unregister them.
    retired = 0
    fresh = process_snapshot() if a.apply else snap
    if a.apply:
        for r in repos:
            if r.path in keep:
                continue
            try:
                if fresh is None or in_use(r.path, fresh) or recent_path(r, cutoff):
                    keep[r.path] = "became-active-before-retire"
            except OSError:
                keep[r.path] = "activity-unverified-before-retire"
        keep_closure(repos, keep, borrowers, lenders_ok)
    order = sorted((r for r in repos if r.path not in keep), key=lambda r: (r.kind != "worktree", -r.path.count("/")))
    removing = set()
    for r in order:
        if r.path in keep:
            say("HOLD", keep[r.path], r.path)
            continue
        if not a.apply:
            say("WOULD-RETIRE", r.kind, r.path)
            continue
        try:
            if r.path not in saved:
                raise Hold("not-preserved")
            if fresh is None or in_use(r.path, fresh) or recent_path(r, cutoff):
                raise Hold("became-active-before-retire")
            why = keep_scope(r.path) or (r.store and keep_scope(r.store, below=False))
            if why:
                raise Hold(f"{why} (declared before retire)")
            if git_snapshot(r) != saved[r.path][1]["git_snapshot"]:
                raise Hold("refs-changed-before-retire")
            removing.add(r.path)
            remove(r, cfg["roots"], protected, repos, home)
            retired += 1
            say("RETIRED", r.kind, r.path)
        except Hold as h:
            keep[r.path] = str(h)
            keep_closure(repos, keep, borrowers, lenders_ok)
            say("HOLD", str(h), r.path)
        except OSError as error:
            keep[r.path] = f"remove-failed ({error.__class__.__name__})"
            keep_closure(repos, keep, borrowers, lenders_ok)
            say("HOLD", f"remove-failed ({error.__class__.__name__})", r.path)
    # A copy of a source that stays protects nothing; a removal that started keeps its copy.
    for path, (final, _) in sorted(saved.items()):
        if path in keep and path not in removing and not keep_scope(final):
            require_action_authorized()
            shutil.rmtree(final)
            say("DISCARDED", "source kept", final)
    if a.apply:  # a dry run plans only: pruning stale worktree records is a write
        prune_worktrees(sorted({r.store for r in order if r.kind == "worktree" and r.store and os.path.isdir(r.store)}), repos)
    tidy = housekeeping(cfg, protected, repos, fresh, now, a.apply)
    say("housekeeping", " ".join(f"{k}={v}" for k, v in tidy.items()) + f" apply={int(a.apply)}")
    if a.apply:
        expire(cfg, now)
        require_action_authorized()
        os.makedirs(os.path.dirname(stamp_file), exist_ok=True)
        open(stamp_file, "w").close()
        os.utime(stamp_file, (now, now))
    say("summary", f"candidates={len(candidates)} retired={retired} held={len(keep)} apply={int(a.apply)}")
    return 0


def main():
    try:
        return main_authorized()
    except Hold as error:
        say("HOLD", str(error))
        return 2


if __name__ == "__main__":
    sys.exit(main())
