#!/usr/bin/env python3
"""Root's open-file scan of dependency seed stores, for accounts whose home others can enter.

A seed generation may be swept only when no process of any account holds a file in it. An account
whose home is group-readable cannot prove that with its own lsof, and running its sweeper as root
would run account-owned code as root. Instead root runs only this root-owned script: one
`lsof +D` per configured store, written as JSON to a root-owned folder. The account's sweeper
(scripts/dependency-seeds.mjs attestedOpen) accepts a fresh, root-owned scan in place of its own.

Usage (as root, from launchd): seed-open-files.py ROOT [ROOT ...]
"""
import argparse, grp, hashlib, json, os, stat, subprocess, sys, tempfile, time

OUT = "/Library/Application Support/Remudero/open-files"


def key(root):
    # APFS is case-insensitive here, so a store has one name whatever case a caller spells it in.
    return hashlib.sha256(root.lower().encode()).hexdigest()


def open_paths(root, lsof):
    out = subprocess.run([lsof, "-nP", "-Fn", "+D", root], capture_output=True, timeout=600)
    if out.returncode == 1 and not out.stdout and not out.stderr:
        return []  # lsof exits 1 with no output when nothing is open
    if out.returncode not in (0, 1) or (out.returncode == 1 and not out.stdout):
        raise RuntimeError(f"lsof failed ({out.returncode}): {out.stderr.decode(errors='replace').strip()[:200]}")
    return sorted({line[1:] for line in out.stdout.decode(errors="replace").split("\n") if line.startswith("n/")})


def scan(root, out_dir, lsof, now):
    st = os.lstat(root)
    if not stat.S_ISDIR(st.st_mode) or os.path.realpath(root) != root:
        raise RuntimeError("seed root must be a real directory, not a symlink")
    record = {"version": 1, "root": root, "scannedAt": now, "open": open_paths(root, lsof)}
    fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=".scan-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(record, f)
        # Every login account is in `staff`, so each account's sweeper can read its store's scan.
        try:
            os.chown(tmp, -1, grp.getgrnam("staff").gr_gid)
        except (KeyError, OSError):
            if sys.platform == "darwin":
                raise  # production scans must be readable by the staff group
            # Linux fixtures may have no staff group or reject chown in a user namespace.
        os.chmod(tmp, 0o640)
        os.replace(tmp, os.path.join(out_dir, key(root) + ".json"))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return record


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="+")
    ap.add_argument("--out", default=OUT, help=argparse.SUPPRESS)       # fixtures only
    ap.add_argument("--lsof", default="/usr/sbin/lsof", help=argparse.SUPPRESS)  # fixtures only
    a = ap.parse_args()
    os.makedirs(a.out, mode=0o755, exist_ok=True)
    failed = 0
    for root in a.roots:
        try:
            r = scan(root, a.out, a.lsof, int(time.time()))
            print(f"seed-open-files: {len(r['open'])} open in {root}")
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            failed += 1  # no fresh record: the sweeper keeps every generation in this store
            print(f"seed-open-files: skipped {root}: {error}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
