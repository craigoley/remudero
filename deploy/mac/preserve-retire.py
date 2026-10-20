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
Usage: preserve-retire.py --home DIR [--apply] [--config PATH]
"""
import argparse, json, os, re, shlex, shutil, stat, subprocess, sys, tarfile, tempfile, time

CONFIG_REL = ".local/state/remudero/preserve-retire.json"
STAMP_REL = ".local/state/remudero/preserve-retire.last"
MIN_IDLE_HOURS = 6
DEFAULTS = {"enabled": False, "idle_hours": 24, "retain_days": 7, "interval_hours": 6,
            "preserve_root": "Remudero-preserved", "max_untracked_mb": 50, "census_seconds": 180,
            "roots": ["Remudero", "rmd-work", ".codex/work-artifacts", "Developer/remudero-operator-worktrees"],
            "published_remotes": ["https://github.com/craigoley/", "git@github.com:craigoley/",
                                  "ssh://git@github.com/craigoley/"]}
# Regenerable trees that are neither preserved nor counted as data.
SKIP_DIRS = ("node_modules", "coverage", "dist", ".turbo", ".next")
CENSUS_PRUNE = {"Library", ".Trash", "Music", "Movies", "Pictures", "node_modules"}
MIN_FREE_BYTES = 1 << 30
MAIN_HISTORY = 20000


def say(action, detail="", path=""):
    print(" ".join(x for x in ("preserve-retire:", action, detail, path) if x), flush=True)


def run(cmd, inp=None, timeout=600):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    try:
        return subprocess.run(cmd, input=inp, capture_output=True, env=env, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return subprocess.CompletedProcess(cmd, 255, b"", str(error).encode())


class Repo:
    def __init__(self, path, kind):
        self.path, self.kind = path, kind  # kind: worktree | clone | bare
        self.gitdir = self.store = None    # store = the object-store owner (common git dir)
        self.lenders, self.hold = [], ""

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


def load_config(home, path):
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
    ints = ("idle_hours", "retain_days", "interval_hours", "max_untracked_mb", "census_seconds")
    if any(type(cfg[k]) is not int or cfg[k] < 0 for k in ints) or cfg["idle_hours"] < MIN_IDLE_HOURS:
        return None, f"refused: numeric settings must be whole numbers, idle_hours >= {MIN_IDLE_HOURS}"
    if cfg["enabled"] is not True:
        return None, "disabled (config enabled=false)"
    cfg["preserve_root"] = os.path.join(home, cfg["preserve_root"])
    cfg["roots"] = [os.path.join(home, r) for r in cfg["roots"]]
    for root in cfg["roots"]:
        if cfg["preserve_root"] == root or cfg["preserve_root"].startswith(root + "/") or root.startswith(cfg["preserve_root"] + "/"):
            return None, "refused: preserve_root overlaps a scan root"
    return cfg, ""


def protected_paths(home, cfg):
    fixed = ["Remudero/remudero", "Remudero/remudero-console", "Remudero/remudero-site",
             "Remudero/state", "Remudero/repos", "rmd-state2"]
    return [os.path.join(home, p) for p in fixed] + [cfg["preserve_root"]]


def inside(path, parents):
    return any(path == p or path.startswith(p + "/") for p in parents)


# ---------- discovery and facts ----------

def is_bare(path, names, dirs):
    if "HEAD" not in names or "objects" not in dirs or "refs" not in dirs:
        return False
    out = run(["git", "--git-dir", path, "rev-parse", "--is-bare-repository"])
    return out.returncode == 0 and out.stdout.strip() == b"true"


def discover(cfg, protected):
    found = {}
    for root in cfg["roots"]:
        if not os.path.isdir(root) or os.path.islink(root):
            continue
        base_depth = root.count("/")
        for dirpath, dirs, files in os.walk(root):
            if dirpath.count("/") - base_depth >= 8 or inside(dirpath, protected):
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
    return [Repo(p, k) for p, k in sorted(found.items())]


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


def borrower_census(home, seconds):
    """Map lender git dir -> borrower git dirs for every alternates file in this home.
    Returns None when the walk did not finish within its budget."""
    deadline = time.monotonic() + seconds
    borrowers = {}
    for dirpath, dirs, files in os.walk(home):
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


def save_tar(path, members, dest):
    with tarfile.open(dest, "w:gz") as t:
        for rel in members:
            t.add(os.path.join(path, rel), arcname=rel, recursive=False)


def preserve(repo, published, cfg, home, now):
    """Write a verified copy of everything retirement would lose. Returns (dir, summary) or raises Hold."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
    name = os.path.relpath(repo.path, home).replace("/", "__") + "@" + stamp
    final = os.path.join(cfg["preserve_root"], name)
    work = tempfile.mkdtemp(prefix=".incoming-", dir=cfg["preserve_root"])
    summary = {"path": repo.path, "kind": repo.kind, "preserved_at": now}
    try:
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
        if summary["unpublished_commits"]:
            bundle = os.path.join(work, "unpublished.bundle")
            if repo.git("bundle", "create", bundle, *revs).returncode != 0:
                raise Hold("bundle-create-failed")
            checks = [repo.git("bundle", "verify", bundle)] + [
                run(["git", "--git-dir", b, "bundle", "verify", bundle]) for b in published.bases]
            if not any(c.returncode == 0 for c in checks):
                raise Hold("bundle-unverified")
        refs = repo.git("for-each-ref", "--format=%(objectname) %(refname)")
        if refs.returncode != 0:
            raise Hold("refs-unreadable")
        open(os.path.join(work, "refs.txt"), "wb").write(refs.stdout)
        if repo.kind == "bare":
            save_tar(repo.path, [p for p in ("config", "description", "hooks", "info", "packed-refs")
                                 if os.path.exists(os.path.join(repo.path, p))], os.path.join(work, "config-hooks.tar.gz"))
        else:
            diff = repo.git("diff", "--binary", "HEAD")
            if diff.returncode != 0:
                raise Hold("diff-failed")
            if diff.stdout:
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
        json.dump(summary, open(os.path.join(work, "manifest.json"), "w"), indent=1)
        open(os.path.join(work, "MANIFEST.txt"), "w").write(restore_text(summary, final))
        os.rename(work, final)
        return final, summary
    except BaseException:
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
  git clone {shlex.quote(upstream)} <dir> && cd <dir>
  git bundle unbundle {final}/unpublished.bundle   # if present; restores every commit, detached HEAD included
  # refs.txt lists every original ref: git update-ref <ref> <sha> recreates the ones you want
  git checkout {s.get('head', '<sha from refs.txt>')}
  git apply --binary {final}/uncommitted.patch                              # if present
  tar -xzf {final}/untracked.tar.gz                                          # if present
"""


class Hold(Exception):
    pass


# ---------- retirement and retention ----------

def remove(repo, roots, protected):
    p = repo.path
    if (not os.path.isabs(p) or os.path.realpath(p) != p or os.path.islink(p) or inside(p, protected)
            or not any(p.startswith(r + "/") for r in roots)):
        raise Hold("path-guard")
    if repo.kind == "worktree":
        out = run(["git", "--git-dir", repo.store, "worktree", "remove", "--force", p])
        if out.returncode != 0:
            raise Hold("git-worktree-remove-refused (" + out.stderr.decode(errors="replace").strip().split("\n")[-1][:80] + ")")
    else:
        shutil.rmtree(p)


def expire(cfg, now):
    root, cutoff = cfg["preserve_root"], now - cfg["retain_days"] * 86400
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if os.path.islink(path) or not os.path.isdir(path):
            continue
        if name.startswith(".incoming-") and os.lstat(path).st_mtime < now - 86400:
            shutil.rmtree(path)  # an interrupted preservation; it never counted as a copy
            continue
        if not re.search(r"@\d{8}T\d{6}Z$", name):
            continue
        try:
            when = json.load(open(os.path.join(path, "manifest.json")))["preserved_at"]
        except (OSError, ValueError, KeyError):
            continue  # unknown age: keep
        if when < cutoff and os.lstat(path).st_uid == os.getuid():
            shutil.rmtree(path)
            say("EXPIRED", f"preserved {cfg['retain_days']}d+ ago", path)


def free_bytes(path):
    return shutil.disk_usage(path).free


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--config")
    ap.add_argument("--now", type=int, help=argparse.SUPPRESS)  # fixtures only: shifts the clock forward
    a = ap.parse_args()
    home = os.path.realpath(a.home)
    cfg, why = load_config(home, a.config or os.path.join(home, CONFIG_REL))
    if cfg is None:
        say(why)
        return 2 if why.startswith("refused") else 0
    now = a.now or int(time.time())
    stamp_file = os.path.join(home, STAMP_REL)
    if a.apply and os.path.exists(stamp_file) and now - os.path.getmtime(stamp_file) < cfg["interval_hours"] * 3600:
        say("skip", f"ran within {cfg['interval_hours']}h")
        return 0
    os.makedirs(cfg["preserve_root"], mode=0o700, exist_ok=True)
    protected = protected_paths(home, cfg)
    repos = discover(cfg, protected)
    cutoff = now - cfg["idle_hours"] * 3600
    snap = process_snapshot()
    keep = {}
    for r in repos:
        resolve_git(r)
        if r.hold:
            keep[r.path] = r.hold
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
    borrowers = borrower_census(home, cfg["census_seconds"]) if lenders_ok else {}
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
            remove(r, cfg["roots"], protected)
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
    for store in sorted({r.store for r in order if r.kind == "worktree" and r.store and os.path.isdir(r.store)}):
        run(["git", "--git-dir", store, "worktree", "prune"])
    if a.apply:
        expire(cfg, now)
        os.makedirs(os.path.dirname(stamp_file), exist_ok=True)
        open(stamp_file, "w").close()
        os.utime(stamp_file, (now, now))
    say("summary", f"candidates={len(candidates)} retired={retired} held={len(keep)} apply={int(a.apply)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
