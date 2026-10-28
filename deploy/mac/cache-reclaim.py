#!/usr/bin/env python3
"""Bounded cache-only cleanup. Never retire source, Git, state or build outputs.

Each pass has one serial owner, at most 45 seconds of admission/inspection,
500,000 inspected entries and 2 GiB of content reads. A commit already admitted
finishes or restores its staging even when the inspection budget expires.
Completed directory namespaces are checkpointed in at most 16 MiB of private,
authenticated state and physically revalidated before reuse. Checkpoints never
grant removal permission. A single crash-left save stage is held for inspection,
never accumulated or adopted. A single directory too wide to enumerate within one
pass remains held; it is never skipped using an unverified directory offset.
"""
import argparse
import errno
from contextlib import contextmanager, ExitStack
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

AGE_SECONDS = 6 * 3600
MAX_SECONDS = 45
MAX_ENTRIES = 500_000
MAX_READ_BYTES = 2 * 1024**3
MAX_PROGRESS_BYTES = 16 * 1024**2
PRUNE = {".git", "node_modules", ".next", "state", ".ssh", ".claude"}
KEEP = {".rmd-janitor-keep", ".rmd-scratch-keep", ".rmd-dependency-seed-root.json"}
RETAINED_PACKAGE_ENTRIES = {".vite", ".rmd-dependency-seed.json"}


def retained_package_entry(rel):
    return rel.split("/", 1)[0] in RETAINED_PACKAGE_ENTRIES


class Hold(Exception):
    """An unavailable or unsafe observation is a retention decision."""


class RemovedUnverified(Hold):
    """Generated deletion completed, but its final evidence is unavailable."""


class NamespaceChanged(Hold):
    """The same physical directory gained or lost entries while it was read.

    Only the reference scan reads such a directory again (NAMESPACE_RETRIES), and
    only a whole enumeration that saw no change counts. Everywhere else it is the
    plain hold its message names.
    """


NAMESPACE_RETRIES = 3


def changed(expected, observed, reason="scan-directory-changed"):
    """dev, inode, type/permissions and owner name the directory; size, times and
    link count move whenever a sibling is created or removed. Anything beyond the
    latter is a different or re-permissioned directory and stays a plain hold."""
    return NamespaceChanged(reason) if observed[:4] == expected[:4] else Hold(reason)


class Budget:
    def __init__(self):
        self.started = time.monotonic()
        self.entries = 0
        self.read_bytes = 0
        self.stage, self.root = "admission", None
        self.scans, self.current = [], None
        self.tick = self.started
        self.exhausted = None
        self.progress = None

    def phase(self, stage, root):
        self.finish_interval()
        self.stage, self.root = stage, str(root)
        self.current = {"stage": stage, "root": str(root), "elapsedMs": 0,
                        "entriesInspected": 0, "childrenEnumerated": 0,
                        "directoriesEnumerated": 0, "symlinksSeen": 0, "namespaceRetries": 0,
                        "complete": False}
        self.scans.append(self.current)

    def finish_interval(self):
        now = time.monotonic()
        if self.current is not None:
            self.current["elapsedMs"] += (now - self.tick) * 1000
        self.tick = now

    def count(self, key):
        if self.current is not None:
            self.current[key] += 1

    def exhaust(self, limit):
        self.exhausted = {"stage": self.stage, "root": self.root, "limit": limit}
        raise Hold("inspection-budget")

    def check(self, entries=0, read_bytes=0):
        limit = ("seconds" if time.monotonic() - self.started > MAX_SECONDS else
                 "entries" if self.entries + entries > MAX_ENTRIES else
                 "content-bytes" if self.read_bytes + read_bytes > MAX_READ_BYTES else None)
        if limit:
            self.exhaust(limit)
        self.entries += entries
        self.read_bytes += read_bytes
        if self.current is not None:
            self.current["entriesInspected"] += entries


def identity(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_size,
            s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)


@contextmanager
def checked_directory(path, budget, parent_fd=None, name=None, expected=None):
    """Pin each descent to its physical parent; a changed namespace is a hold."""
    budget.check(entries=1)
    operand = path if parent_fd is None else name
    before = os.stat(operand, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        raise Hold("scan-directory-changed")
    if expected is not None and identity(before) != expected:
        raise changed(expected, identity(before))
    fd = os.open(operand, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if identity(os.fstat(fd)) != identity(before):
            raise changed(identity(before), identity(os.fstat(fd)))
        yield fd
        budget.check()
        after = identity(os.fstat(fd))
        if after == identity(before):
            after = identity(os.stat(operand, dir_fd=parent_fd, follow_symlinks=False))
        if after != identity(before):
            raise changed(identity(before), after)
    finally:
        os.close(fd)


def reference_directory_identity(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid)


@contextmanager
def pinned_reference_directory(path, budget, parent_fd=None, name=None, expected=None):
    """Pin one known path edge, not an enumerated directory namespace.

    Sibling creation changes directory times/size/link-count but cannot change
    which inode a pinned edge names. Still revalidate that edge and descriptor,
    including type, permissions and ownership. Namespace scans continue using
    checked_directory's full identity; symlink edges are sealed separately.
    """
    budget.check(entries=1)
    operand = path if parent_fd is None else name
    before = os.stat(operand, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode) or expected is not None and identity(before)[:4] != expected[:4]:
        raise Hold("scan-directory-changed")
    sealed = reference_directory_identity(before)
    fd = os.open(operand, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if reference_directory_identity(os.fstat(fd)) != sealed:
            raise Hold("scan-directory-changed")
        yield fd
        budget.check()
        if (reference_directory_identity(os.fstat(fd)) != sealed
                or reference_directory_identity(os.stat(operand, dir_fd=parent_fd, follow_symlinks=False)) != sealed):
            raise Hold("scan-directory-changed")
    finally:
        os.close(fd)


class NamespaceEntry:
    """A checkpointed name always gets current no-follow metadata, never cached stat."""
    def __init__(self, name, fd):
        self.name, self.fd = name, fd

    def stat(self, follow_symlinks=True):
        return os.stat(self.name, dir_fd=self.fd, follow_symlinks=follow_symlinks)

    def is_symlink(self):
        return stat.S_ISLNK(self.stat(False).st_mode)

    def is_dir(self, follow_symlinks=True):
        return stat.S_ISDIR(self.stat(follow_symlinks).st_mode)


def directory_entries(path, budget, parent_fd=None, name=None, expected=None, progress=None):
    with checked_directory(path, budget, parent_fd, name, expected) as fd:
        budget.count("directoriesEnumerated")
        before = os.fstat(fd)
        cached = progress.lookup(path, before) if progress is not None else None
        names = []
        if cached is not None:
            # A complete, authenticated namespace with unchanged directory
            # identity proves the omitted regular entries are still regular.
            # Directory/symlink names are re-statted and traversed this pass.
            for child_name in cached:
                budget.count("childrenEnumerated")
                budget.check(entries=1)
                yield NamespaceEntry(child_name, fd), path / child_name, fd
        else:
            with os.scandir(fd) as children:
                while True:
                    budget.check()  # A wide flat directory must not evade the wall bound.
                    try:
                        child = next(children)
                    except StopIteration:
                        break
                    budget.count("childrenEnumerated")
                    budget.check(entries=1)  # Charge every child before inspecting its type.
                    if progress is not None and (child.is_symlink() or child.is_dir(follow_symlinks=False)):
                        names.append(child.name)
                    yield child, path / child.name, fd
    # Never checkpoint an interrupted enumeration or a changed physical parent.
    if progress is not None and cached is None:
        progress.remember(path, before, names)


def reference_roots(home):
    roots = [home / name for name in ["Remudero", "rmd-work", "Developer", ".codex/work-artifacts"]]
    roots.append(Path(tempfile.gettempdir()).resolve())
    if home == Path(pwd.getpwuid(os.getuid()).pw_dir):
        roots.append(Path("/private/tmp"))
    return list(dict.fromkeys(roots))


class DirectoryProgress:
    """Authenticated namespace observations, not candidates or deletion grants.

    Only fully enumerated directories are saved. Every reuse checks current
    dev/inode/mode/owner/size/mtime/ctime/nlink through a no-follow parent FD;
    every descendant directory and symlink is visited again. A changed tree is
    rescanned. A forged/corrupt checkpoint holds the entire artifact pass.
    Records are prefix-coded in LRU order; expanded path text is also bounded
    to four times the state ceiling so compact input cannot amplify unboundedly.
    The private key protects against accidental/unauthenticated state edits,
    not a malicious account owner who can also replace this executable.
    """
    def __init__(self, home, budget):
        self.budget, self.records, self.fd = budget, {}, None
        self.candidate_cursor = None  # scheduling hint, never cached eligibility
        self.stats = {"state": "cold", "loadedDirectories": 0, "reusedDirectories": 0,
                      "completedDirectories": 0, "invalidatedDirectories": 0,
                      "savedDirectories": 0, "evictedDirectories": 0, "metadataBytesRead": 0}
        self.path = home / ".local/state/remudero/cache-reclaim-progress"
        self.scope = {"version": 4, "home": str(home), "uid": os.getuid(),
                      "roots": [str(p) for p in reference_roots(home)],
                      "writer": regular_digest(Path(__file__), budget)}
        self.stats["metadataBytesRead"] = budget.read_bytes
        fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in [".local", "state", "remudero", "cache-reclaim-progress"]:
                budget.check()
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    # Existing parents are expected; still bound this path and
                    # validate its no-follow descriptor/type/owner below.
                    budget.check()
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                s = os.fstat(child)
                if s.st_uid != os.getuid() or part == "cache-reclaim-progress" and stat.S_IMODE(s.st_mode) != 0o700:
                    os.close(child)
                    raise Hold("progress-directory-not-private-owned")
                os.close(fd)
                fd = child
            self.fd, fd = fd, None
            self.directory_id = (os.fstat(self.fd).st_dev, os.fstat(self.fd).st_ino)
            try:
                self.key = self.read("key", 32)
            except FileNotFoundError:
                try:
                    os.stat("inventory.json", dir_fd=self.fd, follow_symlinks=False)
                except FileNotFoundError:
                    self.key = os.urandom(32)
                    key_fd = os.open("key", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
                    try:
                        os.write(key_fd, self.key)
                        os.fsync(key_fd)
                    finally:
                        os.close(key_fd)
                    os.fsync(self.fd)
                else:
                    raise Hold("progress-key-missing")
            if len(self.key) != 32:
                raise Hold("progress-key-invalid")
            try:
                raw = self.read("inventory.json", MAX_PROGRESS_BYTES)
            except FileNotFoundError:
                return
            try:
                envelope = json.loads(raw)
                payload = envelope["payload"]
                encoded = self.encode(payload)
                signature = hmac.new(self.key, encoded, hashlib.sha256).hexdigest()
                if not hmac.compare_digest(envelope["mac"], signature):
                    raise ValueError("authentication")
                if payload["scope"] != self.scope:
                    self.stats["state"] = "reset-scope"
                    return
                cursor = payload["candidateCursor"]
                if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 4096 or "\0" in cursor
                        or not Path(cursor).is_absolute() or str(Path(cursor)) != cursor or ".." in Path(cursor).parts
                        or not Path(cursor).is_relative_to(home / ".codex/work-artifacts")):
                    raise ValueError("candidate-cursor")
                records = payload["records"]
                if not isinstance(records, list):
                    raise ValueError("records")
                loaded, previous, expanded = {}, "", 0
                for record in records:
                    # Parsing authenticated, byte-bounded metadata is not a
                    # second filesystem inspection. Keep its time/read costs,
                    # but charge current names only when physically revisited.
                    budget.check()
                    if not isinstance(record, list) or len(record) != 4:
                        raise ValueError("record")
                    prefix, suffix, observed, names = record
                    if (type(prefix) is not int or not 0 <= prefix <= len(previous)
                            or not isinstance(suffix, str)
                            or not isinstance(observed, list) or len(observed) != 8
                            or not all(type(v) is int for v in observed)
                            or not isinstance(names, list)):
                        raise ValueError("record")
                    expanded += prefix + len(suffix)
                    if expanded > 4 * MAX_PROGRESS_BYTES:
                        raise ValueError("expanded-paths")
                    path = previous[:prefix] + suffix
                    physical = Path(path)
                    if (not physical.is_absolute() or str(physical) != path
                            or ".." in physical.parts or "\0" in path or path in loaded):
                        raise ValueError("path")
                    for name in names:
                        budget.check()
                        if not isinstance(name, str) or not name or name in {".", ".."} or "/" in name or "\0" in name:
                            raise ValueError("name")
                    if len(set(names)) != len(names):
                        raise ValueError("duplicate-name")
                    loaded[path] = {"identity": observed, "names": names}
                    previous = path
                self.records = loaded
                self.candidate_cursor = cursor
                self.stats.update(state="resumed", loadedDirectories=len(records))
            except (ValueError, TypeError, KeyError, RecursionError) as error:
                raise Hold("progress-state-invalid") from error
        except BaseException:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            raise
        finally:
            if fd is not None:
                os.close(fd)

    @staticmethod
    def encode(value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()

    def read(self, name, maximum):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            s = os.fstat(fd)
            if (not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1
                    or stat.S_IMODE(s.st_mode) != 0o600 or getattr(s, "st_flags", 0) or s.st_size > maximum):
                raise Hold("progress-file-not-private-owned-regular")
            self.budget.check(read_bytes=s.st_size)
            self.stats["metadataBytesRead"] += s.st_size
            data = b""
            while len(data) < s.st_size:
                self.budget.check()
                block = os.read(fd, min(1024 * 1024, s.st_size - len(data)))
                if not block:
                    break
                data += block
            if (len(data) != s.st_size or identity(os.fstat(fd)) != identity(s)
                    or identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False)) != identity(s)):
                raise Hold("progress-file-changed")
            return data
        finally:
            os.close(fd)

    def lookup(self, path, observed):
        record = self.records.pop(str(path), None)
        if record is not None and record["identity"] == list(identity(observed)):
            self.records[str(path)] = record  # Least-recently-used observations go first.
            self.stats["reusedDirectories"] += 1
            return record["names"]
        if record is not None:
            self.stats["invalidatedDirectories"] += 1
        return None

    def remember(self, path, observed, names):
        self.records.pop(str(path), None)
        self.records[str(path)] = {"identity": list(identity(observed)), "names": names}
        self.stats["completedDirectories"] += 1

    @staticmethod
    def pack_record(previous, path, record):
        prefix = len(os.path.commonprefix((previous, path)))
        return [prefix, path[prefix:], record["identity"], record["names"]]

    def save(self):
        # Eviction discards observations, never files or safety checks. Bound
        # state even during incomplete scans and ordinary deleted-tree churn.
        # Account for exact canonical encoding once; avoid repeated full dumps.
        sizes, previous, expanded = [], "", 0
        for path, record in self.records.items():
            packed = self.pack_record(previous, path, record)
            compact_size = len(self.encode(packed))
            full_size = len(self.encode([0, path, record["identity"], record["names"]]))
            sizes.append((path, compact_size, full_size))
            previous = path
            expanded += len(path)
        overhead = len(self.encode({"scope": self.scope, "records": [], "candidateCursor": self.candidate_cursor})) + 85
        size = overhead + sum(value for _, value, _ in sizes) + max(0, len(sizes) - 1)
        for index, (path, _compact_size, full_size) in enumerate(sizes):
            if size <= MAX_PROGRESS_BYTES and expanded <= 4 * MAX_PROGRESS_BYTES:
                break
            del self.records[path]
            self.stats["evictedDirectories"] += 1
            expanded -= len(path)
            size -= full_size
            if index + 1 < len(sizes):
                # The new first record has no predecessor: include its full
                # path before deciding whether the retained suffix fits.
                _, next_compact, next_full = sizes[index + 1]
                size += next_full - next_compact - 1
        records, previous = [], ""
        for path, record in self.records.items():
            records.append(self.pack_record(previous, path, record))
            previous = path
        # Array order is recency; canonical object-key sorting cannot reorder it.
        payload = {"scope": self.scope, "records": records, "candidateCursor": self.candidate_cursor}
        encoded = self.encode(payload)
        data = b'{"mac":' + json.dumps(hmac.new(self.key, encoded, hashlib.sha256).hexdigest()).encode() + b',"payload":' + encoded + b'}'
        if len(data) > MAX_PROGRESS_BYTES:
            raise Hold("progress-state-size-limit")
        if (self.path.lstat().st_dev, self.path.lstat().st_ino) != self.directory_id:
            raise Hold("progress-directory-changed")
        stage = "inventory.tmp"
        # O_EXCL bounds crash recovery to one stage. Unknown/replaced stages
        # are retained and reported, never adopted or swept speculatively.
        try:
            fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        except FileExistsError as error:
            raise Hold("progress-save-stage-present") from error
        try:
            with os.fdopen(os.dup(fd), "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            if identity(os.stat(stage, dir_fd=self.fd, follow_symlinks=False)) != identity(os.fstat(fd)):
                raise Hold("progress-save-stage-changed")
            os.replace(stage, "inventory.json", src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        except BaseException:
            # Remove only the still-open stage we created, not a raced path.
            try:
                if identity(os.stat(stage, dir_fd=self.fd, follow_symlinks=False)) == identity(os.fstat(fd)):
                    os.unlink(stage, dir_fd=self.fd)
            except FileNotFoundError:
                # Rename may have succeeded before the directory fsync failed.
                self.stats["saveStageAbsent"] = True
            except OSError:
                # One fixed stage remains bounded and the next save holds it.
                self.stats["saveStageCleanupUnverified"] = True
            raise
        finally:
            os.close(fd)
        self.stats.update(savedDirectories=len(self.records), stateBytes=len(data))

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def cache_target(path, entry, parent_fd, budget):
    """Probe .next/cache/turbopack without following any component symlink."""
    with ExitStack() as stack:
        fd = stack.enter_context(checked_directory(path, budget, parent_fd, entry.name,
                                                   identity(entry.stat(follow_symlinks=False))))
        for name in ("cache", "turbopack"):
            budget.check(entries=1)
            try:
                observed = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return None
            if not stat.S_ISDIR(observed.st_mode):
                return None
            path = path / name
            fd = stack.enter_context(checked_directory(path, budget, fd, name, identity(observed)))
        return path


@contextmanager
def cache_owner(home):
    lock = home / ".cache/remudero-generated-cache.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError as error:
        raise Hold("another-cache-owner") from error
    inode = lock.stat().st_ino
    try:
        yield
    finally:
        if lock.stat().st_ino == inode:
            lock.rmdir()


def command(argv, cwd=None):
    try:
        return subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                              timeout=5, env=dict(os.environ, GIT_OPTIONAL_LOCKS="0",
                              GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0"))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Hold("probe-unavailable") from error


def git(workspace, *args):
    return command(["git", "-C", str(workspace), *args])


def regular_digest(path, budget):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = identity(os.fstat(fd))
        result = hashlib.sha256()
        remaining = before[4]
        while remaining:
            room = MAX_READ_BYTES - budget.read_bytes
            if not room:
                budget.exhaust("content-bytes")
            block = os.read(fd, min(1024 * 1024, room, remaining))
            if not block:
                break
            budget.check(read_bytes=len(block))
            result.update(block)
            remaining -= len(block)
        if identity(os.fstat(fd)) != before:
            raise Hold("changed-during-read")
        return result.hexdigest()
    finally:
        os.close(fd)


def walk(root, budget, exclude=()):
    def visit(path, parent_fd=None, name=None, observed=None):
        if path in exclude:
            return
        if observed is None:
            budget.check(entries=1)
            observed = path.lstat()
        yield path, observed
        if stat.S_ISDIR(observed.st_mode):
            for entry, child, fd in directory_entries(path, budget, parent_fd, name, identity(observed)):
                if child not in exclude:
                    yield from visit(child, fd, entry.name, entry.stat(follow_symlinks=False))
    try:
        yield from visit(root)
    except RecursionError as error:
        raise Hold("scan-depth-unavailable") from error


def old_owned(root, budget):
    metadata = {}
    allocated = 0
    for p, s in walk(root, budget):
        if (s.st_uid != os.getuid() or getattr(s, "st_flags", 0)
                or max(s.st_mtime, s.st_ctime) > time.time() - AGE_SECONDS):
            raise Hold("recent-foreign-or-flagged")
        if p.name in KEEP or p.name in {".git", "openweight-allowance.json", "claude-cash-allowance.json"}:
            raise Hold("protected-data")
        if stat.S_ISREG(s.st_mode):
            if s.st_nlink != 1:
                raise Hold("shared-inodes")
            allocated += s.st_blocks * 512
        elif not (stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode)):
            raise Hold("special-data")
        metadata[str(p.relative_to(root))] = identity(s)
    return metadata, allocated


def payload(root, budget):
    result = {}
    for p, s in walk(root, budget):
        rel = str(p.relative_to(root))
        if retained_package_entry(rel):
            continue  # Preserved in place, including unique test results.
        mode = stat.S_IMODE(s.st_mode)
        if stat.S_ISDIR(s.st_mode):
            value = ["directory", mode]
        elif stat.S_ISLNK(s.st_mode):
            value = ["symlink", mode, os.readlink(p)]
        elif stat.S_ISREG(s.st_mode):
            value = ["file", mode, s.st_size, regular_digest(p, budget)]
        else:
            raise Hold("special-data")
        result[rel] = value
    if ".package-lock.json" not in result:
        raise Hold("npm-provenance-unavailable")
    return result


def unchanged(root, metadata, packages=False, staged=False):
    seen = set()
    todo = [root]
    while todo:
        p = todo.pop()
        rel = str(p.relative_to(root))
        if packages and retained_package_entry(rel):
            continue
        s = p.lstat()
        if not (staged and packages and rel == "."):
            actual, expected = identity(s), metadata.get(rel)
            if expected is None:
                raise Hold("changed-namespace")
            if staged and (rel == "." or "/" not in rel):
                if actual[:6] != expected[:6] or actual[7:] != expected[7:]:
                    raise Hold("changed-stage")
            elif actual != expected:
                raise Hold("changed-metadata")
            seen.add(rel)
        if s.st_uid != os.getuid() or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode)):
            raise Hold("changed-type-or-owner")
        if stat.S_ISDIR(s.st_mode):
            todo.extend(p.iterdir())
    expected = {k for k in metadata if not packages or not retained_package_entry(k)}
    if staged and packages:
        expected.discard(".")
    if seen != expected:
        raise Hold("changed-namespace")


def source_seal(workspace, target, budget, stage=None):
    excluded = {target}
    if stage:
        excluded.add(stage)
    roots = [workspace]
    if target.name == "node_modules":
        roots.extend(target / name for name in RETAINED_PACKAGE_ENTRIES
                     if (target / name).exists() or (target / name).is_symlink())
    result = {}
    for root in roots:
        for p, s in walk(root, budget, excluded):
            rel, mode = str(p.relative_to(workspace)), stat.S_IMODE(s.st_mode)
            if stat.S_ISDIR(s.st_mode):
                result[rel] = ["directory", mode]
            elif stat.S_ISLNK(s.st_mode):
                result[rel] = ["symlink", mode, os.readlink(p)]
            elif stat.S_ISREG(s.st_mode):
                result[rel] = ["file", mode, regular_digest(p, budget)]
            else:
                raise Hold("special-source-data")
    return result


LSOF_CANT_STAT = re.compile(r"^lsof: WARNING: can't stat\(\) \S+ file system (/.*)$")
LSOF_CANT_STAT_DETAIL = re.compile(r'^\s+(Output information may be incomplete\.|assuming "dev=[0-9A-Fa-fx]+" from mount table)$')


def lsof_stderr_unexplained(stderr, path):
    """True unless every stderr line is a can't-stat warning for a mount clear of `path`.

    lsof warns on every call about a mount it cannot stat (another account's CoreDevice
    DeviceFS, a session's private disk image); that says nothing about `path` unless the
    mount lies inside or above it.
    """
    for line in stderr.splitlines():
        if not line.strip() or LSOF_CANT_STAT_DETAIL.match(line):
            continue
        mount = LSOF_CANT_STAT.match(line)
        if not mount:
            return True
        mounted = Path(mount.group(1))
        if mounted.is_relative_to(path) or Path(path).is_relative_to(mounted):
            return True
    return False


def inactive(workspace, known_file=None):
    processes = command(["ps", "-axww", "-o", "pid=,command="])
    if processes.returncode:
        raise Hold("process-query-unavailable")
    commands = {}
    for line in processes.stdout.splitlines():
        row = line.strip().split(None, 1)
        if len(row) == 2 and row[0].isdigit():
            commands[int(row[0])] = row[1]
    if os.getpid() not in commands:
        raise Hold("process-positive-control-missing")
    if any(str(workspace) in row for pid, row in commands.items() if pid != os.getpid()):
        raise Hold("active-command")
    cwds = command(["lsof", "-nP", "-a", "-d", "cwd", "-Fn"])
    if cwds.returncode or lsof_stderr_unexplained(cwds.stderr, workspace):
        raise Hold("cwd-query-unavailable")
    pid, positive = None, False
    for line in cwds.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n"):
            path = Path(line[1:])
            positive |= pid == os.getpid() and path == Path.cwd()
            if workspace.is_relative_to(path) and pid not in commands:
                # ps and lsof are different snapshots. Resolve this specific
                # parent owner; a positively observed exited PID has no child
                # consumer, while an unreadable live owner still holds data.
                current = command(["ps", "-p", str(pid), "-ww", "-o", "command="])
                if current.returncode == 1 and not current.stdout.strip() and not current.stderr.strip():
                    continue
                if current.returncode or not current.stdout.strip():
                    raise Hold("parent-cwd-owner-unavailable")
                commands[pid] = current.stdout.strip()
            if path == workspace or workspace.is_relative_to(path) and str(workspace.relative_to(path)) in commands.get(pid, "") or path.is_relative_to(workspace):
                raise Hold("active-cwd")
    if not positive:
        raise Hold("cwd-positive-control-missing")
    known_file = known_file or workspace / "package.json"
    with known_file.open("rb"):
        known = command(["lsof", "-nP", "-p", str(os.getpid()), "-Fn"])
        if known.returncode or "n" + str(known_file) not in known.stdout.splitlines():
            raise Hold("open-positive-control-missing")
    opened = command(["lsof", "-nP", "+D", str(workspace)])
    if opened.returncode != 1 or opened.stdout.strip() or lsof_stderr_unexplained(opened.stderr, workspace):
        raise Hold("active-or-unknown-open-file")


def workspace_guard(workspace, target, budget):
    if (workspace.resolve() != workspace or target.resolve() != target
            or not (workspace / "package.json").is_file()):
        raise Hold("workspace-provenance-unavailable")
    top = git(workspace, "rev-parse", "--show-toplevel")
    rel = str(target.relative_to(workspace))
    tracked = git(workspace, "ls-files", "-z", "--", rel)
    ignored = git(workspace, "check-ignore", "-q", "--", rel)
    if (top.returncode or top.stderr.strip() or top.stdout.strip() != str(workspace)
            or tracked.returncode or tracked.stderr.strip() or tracked.stdout
            or ignored.returncode or ignored.stderr.strip()):
        raise Hold("git-provenance-unavailable")
    # No source publication claim is made: only duplicate generated data can go.
    for p, s in walk(workspace, budget, {workspace / ".git"}):
        if p.name in KEEP or max(s.st_mtime, s.st_ctime) > time.time() - AGE_SECONDS:
            raise Hold("recent-or-retained-workspace")
    inactive(workspace)


def discovery(root, budget, candidates=None):
    candidates = [] if candidates is None else candidates
    budget.phase("discovery", root)
    def visit(path, depth, parent_fd=None, name=None, expected=None):
        for entry, child, fd in directory_entries(path, budget, parent_fd, name, expected, progress=budget.progress):
            if entry.is_symlink():
                budget.count("symlinksSeen")
                continue
            directory = entry.is_dir(follow_symlinks=False)
            if entry.name == "node_modules" and directory:
                candidates.append((child.parent, child, "packages"))
            elif entry.name == ".next" and directory:
                target = cache_target(child, entry, fd, budget)
                if target is not None:
                    candidates.append((child.parent, target, "turbopack"))
            elif directory and depth < 6 and entry.name not in PRUNE and not entry.name.endswith(".git"):
                visit(child, depth + 1, fd, entry.name, identity(entry.stat(follow_symlinks=False)))
    visit(root, 0)
    budget.current["complete"] = True
    candidates.sort(key=lambda row: (row[2] != "turbopack", str(row[1])))
    return candidates


def reference_peers(home, budget):
    """Explicit owner-private argv, never an automatic SSH/key/permission change."""
    path = home / ".local/state/remudero/cache-reference-peers.json"
    try:
        before = path.lstat()
    except FileNotFoundError:
        return {}
    for parent in [path.parent, *path.parent.parents]:
        if parent == home.parent:
            break
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o022:
            raise Hold("reference-peer-config-parent-untrusted")
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1 or before.st_size > 65536):
        raise Hold("reference-peer-config-untrusted")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        raw = os.read(fd, 65537)
        budget.check(read_bytes=len(raw))
        if (len(raw) != before.st_size or identity(os.fstat(fd)) != identity(before)
                or identity(path.lstat()) != identity(before)):
            raise Hold("reference-peer-config-changed")
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
        if not isinstance(value, list) or len(value) > 8:
            raise ValueError()
        peers = {}
        for row in value:
            uid, argv = row["uid"], row["argv"]
            if (type(uid) is not int or uid <= 0 or uid in peers or not isinstance(argv, list)
                    or not 1 <= len(argv) <= 32 or not all(isinstance(a, str) and a and "\0" not in a for a in argv)
                    or not Path(argv[0]).is_absolute()):
                raise ValueError()
            peers[uid] = argv
        return peers
    except (ValueError, KeyError, TypeError) as error:
        raise Hold("reference-peer-config-invalid") from error


def peer_exchange(argv, request, budget):
    """Bound both pipe directions, output bytes, elapsed time and our own child."""
    packet = DirectoryProgress.encode(request)
    if len(packet) > 65536:
        raise Hold("reference-peer-request-size")
    budget.check()
    # Keep a supervisor alive until cleanup: even after the probe leader exits,
    # its process-group ID cannot be recycled into an unrelated worker's group.
    # The approved argv is executed unchanged, without a shell or extra rights.
    supervisor = """import os,select,signal,subprocess,sys
signal.signal(signal.SIGTERM,lambda *_:None)
probe=subprocess.Popen(sys.argv[3:])
for fd in (0,1,2):os.close(fd)
reported=False
try:
 while True:
  status=probe.poll()
  if status is not None and not reported:
   os.write(int(sys.argv[1]),str(status).encode()+b'\\n')
   os.close(int(sys.argv[1]));reported=True
  if select.select([int(sys.argv[2])],[],[],0.05)[0]:break
finally:os.killpg(os.getpgrp(),signal.SIGKILL)
"""
    with ExitStack() as handles:
        status_read, status_write = os.pipe()
        status_reader = handles.enter_context(os.fdopen(status_read, "rb", buffering=0))
        status_writer = handles.enter_context(os.fdopen(status_write, "wb", buffering=0))
        life_read, life_write = os.pipe()
        life_reader = handles.enter_context(os.fdopen(life_read, "rb", buffering=0))
        life_writer = handles.enter_context(os.fdopen(life_write, "wb", buffering=0))
        child = subprocess.Popen([sys.executable, "-c", supervisor, str(status_write), str(life_read), *argv],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 pass_fds=(status_write, life_read), start_new_session=True)
        status_writer.close()
        life_reader.close()
        out, err, status, offset = bytearray(), bytearray(), bytearray(), 0
        try:
            with selectors.DefaultSelector() as selector:
                for stream, event in [(child.stdin, selectors.EVENT_WRITE),
                                      (child.stdout, selectors.EVENT_READ), (child.stderr, selectors.EVENT_READ),
                                      (status_reader, selectors.EVENT_READ)]:
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, event)
                while selector.get_map():
                    budget.check()
                    for key, _event in selector.select(timeout=0.1):
                        stream = key.fileobj
                        if stream is child.stdin:
                            try:
                                offset += os.write(stream.fileno(), packet[offset:])
                            except BlockingIOError:
                                continue
                            except BrokenPipeError:
                                offset = len(packet)
                            if offset == len(packet):
                                selector.unregister(stream)
                                stream.close()
                        else:
                            try:
                                block = os.read(stream.fileno(), 16384)
                            except BlockingIOError:
                                continue
                            budget.check(read_bytes=len(block))
                            if not block:
                                selector.unregister(stream)
                                continue
                            data = status if stream is status_reader else out if stream is child.stdout else err
                            data.extend(block)
                            if len(data) > (32 if data is status else 1024 * 1024 if data is out else 4096):
                                raise Hold("reference-peer-output-size")
                budget.check()
            if not re.fullmatch(rb"-?[0-9]+\n", status) or int(status) != 0 or err:
                raise Hold("reference-peer-unavailable")
            try:
                return json.loads(out)
            except (ValueError, UnicodeError, RecursionError) as error:
                raise Hold("reference-peer-response-invalid") from error
        finally:
            closure_error = None
            try:
                # Never poll/wait/reap the supervisor before the last signal.
                # Its reserved PID pins this group even if it died unexpectedly.
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(child.pid, sig)
                    except ProcessLookupError:
                        # An absent owned group needs no grace period. Keep
                        # the supervisor unreaped until signalling is over.
                        continue
                    except OSError as error:
                        closure_error = error
                    if sig == signal.SIGTERM:
                        time.sleep(0.05)
                life_writer.close()  # EOF also kills the owned group if this parent disappears.
                deadline = time.monotonic() + 2
                try:
                    child.wait(timeout=2)
                    while True:
                        try:
                            os.killpg(child.pid, 0)  # Observation only after the supervisor is reaped.
                        except ProcessLookupError:
                            break
                        if time.monotonic() >= deadline:
                            raise TimeoutError("owned probe group still present")
                        time.sleep(0.01)
                except (OSError, subprocess.TimeoutExpired) as error:
                    closure_error = error
            finally:
                for stream in (child.stdin, child.stdout, child.stderr):
                    stream.close()
            if closure_error is not None:
                raise Hold("reference-peer-closure-unverified") from closure_error


def resolved_reference(parent, raw, budget):
    """Resolve from a certified physical parent; never hide EACCES as a path.

    Path.resolve(strict=False) can return an unresolved suffix on an access
    error. That is not negative evidence about references across accounts.
    Missing/dangling suffixes are allowed; inaccessible ones are not.
    """
    operand = Path(raw)
    absolute = operand.is_absolute()
    # POSIX permits a distinct // anchor. This Mac/Linux cleanup protocol does
    # not: aliases must compare against the same single-root candidate paths.
    remaining = [(part, True) for part in parent.parts[1:]] if not absolute else []
    remaining += [(part, False) for part in (operand.parts[1:] if absolute else operand.parts)]
    links, seals, directory_seals = 0, {}, {}
    anchors = {}

    def recheck_reference_edges(fd):
        for name, expected in directory_seals.get(fd, []):
            budget.check()
            try:
                after = reference_directory_identity(os.stat(name, dir_fd=fd, follow_symlinks=False))
            except FileNotFoundError:
                after = None
            if after != expected:
                raise Hold("scan-directory-changed")
        for name, expected in seals.get(fd, []):
            budget.check()
            try:
                after = identity(os.stat(name, dir_fd=fd, follow_symlinks=False))
            except FileNotFoundError:
                after = None
            if after != expected:
                raise Hold("reference-symlink-changed")

    def visit(resolved, remaining):
        nonlocal links
        while remaining:
            budget.check(entries=1)
            part, physical_start = remaining.pop(0)
            if part == ".":
                continue
            if part == "..":
                resolved = resolved.parent
                continue
            child = resolved / part
            fd = anchors.get(str(resolved))
            if fd is None:
                # A genuinely missing/non-directory prefix cannot contain a
                # symlink. Its last existing physical parent remains sealed.
                resolved = child
                continue
            try:
                before = os.stat(part, dir_fd=fd, follow_symlinks=False)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENOTDIR):
                    raise
                seals.setdefault(fd, []).append((part, None))
                resolved = child
                continue
            observed = identity(before)
            if physical_start and not stat.S_ISDIR(before.st_mode):
                raise Hold("reference-start-not-physical")
            if stat.S_ISDIR(before.st_mode):
                # Keep each child binding under its parent descriptor until
                # that parent's teardown, including after the child closes.
                directory_seals.setdefault(fd, []).append((part, reference_directory_identity(before)))
                if str(child) not in anchors:
                    # A lexical continuation owns each descriptor in an
                    # ordinary with-block. Only the final Path escapes; raw
                    # descriptors remain borrowed by this call's descendants.
                    with pinned_reference_directory(child, budget, fd, part, observed) as child_fd:
                        anchors[str(child)] = child_fd
                        try:
                            result = visit(child, remaining)
                            # Descendant teardown can overlap a retarget of an
                            # earlier alias. Recheck edges while their own
                            # parent descriptor is still pinned, after deeper
                            # contexts have finished closing.
                            recheck_reference_edges(child_fd)
                            return result
                        finally:
                            del anchors[str(child)]
                resolved = child
            elif stat.S_ISLNK(before.st_mode):
                links += 1
                if links > 40:
                    raise Hold("reference-symlink-unresolvable")
                referent = Path(os.readlink(part, dir_fd=fd))
                seals.setdefault(fd, []).append((part, observed))
                if referent.is_absolute():
                    resolved = Path("/")
                    remaining = [(p, False) for p in referent.parts[1:]] + remaining
                else:
                    remaining = [(p, False) for p in referent.parts] + remaining
            else:
                seals.setdefault(fd, []).append((part, observed))
                resolved = child
        for fd in dict.fromkeys([*directory_seals, *seals]):
            recheck_reference_edges(fd)
        return resolved
    try:
        with pinned_reference_directory(Path("/"), budget) as root_fd:
            anchors["/"] = root_fd
            result = visit(Path("/"), remaining)
            recheck_reference_edges(root_fd)
            return result
    except RecursionError as error:
        raise Hold("reference-chain-too-deep") from error


def matching_reference(referent, candidates, budget, shared):
    for workspace, target, _kind in candidates:
        budget.check()
        if (referent == target or referent.is_relative_to(target)
                or referent.is_relative_to(workspace) and target.is_relative_to(referent)
                or referent == workspace):
            shared.add(target)


def delegated_references(home, path, depth, expected, candidates, budget):
    peers = reference_peers(home, budget)
    argv = peers.get(expected[3])
    if argv is None:
        raise Hold("reference-peer-unconfigured:uid=" + str(expected[3]) + ":" + str(path))
    budget.check()
    request = {"version": 1, "nonce": os.urandom(24).hex(), "root": str(path), "identity": list(expected),
               "depth": depth, "candidates": [[str(w), str(t), k] for w, t, k in candidates],
               "limits": {"entries": MAX_ENTRIES-budget.entries,
                          "seconds": max(0.01, MAX_SECONDS-(time.monotonic()-budget.started)-0.2)}}
    response = peer_exchange(argv, request, budget)
    writer = regular_digest(Path(__file__), budget)
    targets = {str(t): t for _w, t, _k in candidates}
    try:
        if (response["version"] != 1 or response["nonce"] != request["nonce"]
                or response["requestSha256"] != hashlib.sha256(DirectoryProgress.encode(request)).hexdigest()
                or response["uid"] != expected[3] or response["writer"] != writer
                or response["rootIdentity"] != list(expected) or response["complete"] is not True
                or not isinstance(response["shared"], list) or not all(isinstance(p, str) and p in targets for p in response["shared"])
                or not isinstance(response["unresolved"], list)
                or any(type(response[n]) is not int or response[n] < 0 for n in ["entriesInspected", "bytesRead"])
                or not 1 <= response["entriesInspected"] <= request["limits"]["entries"]):
            raise ValueError()
        budget.check(entries=response["entriesInspected"], read_bytes=response["bytesRead"])
        shared = {targets[p] for p in response["shared"]}
        for parent, raw in response["unresolved"]:
            if (not isinstance(parent, str) or not isinstance(raw, str) or not raw or "\0" in raw
                    or not Path(parent).is_absolute() or not Path(parent).is_relative_to(path) or ".." in Path(parent).parts):
                raise ValueError()
            matching_reference(resolved_reference(Path(parent), raw, budget), candidates, budget, shared)
        if identity(path.lstat()) != expected:
            raise changed(expected, identity(path.lstat()), "reference-peer-root-changed")
        budget.peer_probes = getattr(budget, "peer_probes", 0) + 1
        return shared
    except (KeyError, TypeError, ValueError) as error:
        raise Hold("reference-peer-response-invalid") from error


def scan_reference_tree(home, path, depth, candidates, budget, shared, parent_fd=None,
                        name=None, expected=None, allow_peer=True):
    """Read a churning directory again rather than hold the whole pass.

    Shared temp roots gain and lose siblings constantly. A namespace that moved,
    or a child that vanished between listing and stat, re-reads this directory
    from scratch, bounded; only an attempt that saw no change completes, the same
    proof a first-try success gives. The directory itself vanishing or being
    is its parent's namespace change; a replaced directory, or a type, permission
    or owner change, stays a plain hold.
    """
    for attempt in range(NAMESPACE_RETRIES + 1):
        try:
            return reference_namespace(home, path, depth, candidates, budget, shared,
                                       parent_fd, name, expected, allow_peer)
        except NamespaceChanged as error:
            if attempt == NAMESPACE_RETRIES:
                raise Hold(str(error)) from error
            budget.count("namespaceRetries")
            if expected is not None:
                try:
                    current = identity(os.stat(path if parent_fd is None else name,
                                               dir_fd=parent_fd, follow_symlinks=False))
                except FileNotFoundError:
                    raise NamespaceChanged(str(error)) from None
                if current[:4] != expected[:4]:
                    raise Hold(str(error)) from error
                expected = current


def reference_namespace(home, path, depth, candidates, budget, shared, parent_fd, name, expected, allow_peer):
    try:
        for entry, child, fd in directory_entries(path, budget, parent_fd, name, expected, progress=budget.progress):
            if entry.is_symlink():
                budget.count("symlinksSeen")
                before = identity(entry.stat(follow_symlinks=False))
                raw = os.readlink(entry.name, dir_fd=fd)
                try:
                    referent = resolved_reference(path, raw, budget)
                except PermissionError:
                    if allow_peer:
                        raise
                    referral = [str(path), raw]
                    size = (getattr(budget, "unresolved_reference_bytes", 2)
                            + len(DirectoryProgress.encode(referral))
                            + bool(budget.unresolved_references))
                    if size > 1024 * 1024:
                        raise Hold("reference-peer-output-size")
                    budget.unresolved_reference_bytes = size
                    budget.unresolved_references.append(referral)
                    referent = None
                budget.check()
                if identity(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)) != before:
                    raise Hold("reference-symlink-changed")
                if referent is not None:
                    matching_reference(referent, candidates, budget, shared)
            elif entry.is_dir(follow_symlinks=False) and depth < 8 and entry.name not in PRUNE and not entry.name.endswith(".git"):
                scan_reference_tree(home, child, depth + 1, candidates, budget, shared,
                                    fd, entry.name, identity(entry.stat(follow_symlinks=False)), allow_peer)
    except FileNotFoundError as error:
        # An entry listed a moment ago is gone: this namespace moved under the scan.
        raise NamespaceChanged("scan-directory-changed") from error
    except PermissionError:
        # A sealed peer census replaces only this unreadable physical subtree,
        # never the rest of the local census, liveness or deletion guards.
        if not allow_peer or expected is None or identity(path.lstat()) != expected:
            raise Hold("reference-peer-unavailable")
        shared.update(delegated_references(home, path, depth, expected, candidates, budget))


def references(home, candidates, budget):
    roots = reference_roots(home)
    shared = set()
    for root in dict.fromkeys(roots):
        budget.phase("references", root)
        budget.check(entries=1)
        try:
            observed = root.lstat()
        except FileNotFoundError:
            budget.current.update(complete=True, absent=True)
            continue
        if not stat.S_ISDIR(observed.st_mode):
            raise Hold("reference-root-not-physical-directory")
        scan_reference_tree(home, root, 0, candidates, budget, shared, expected=identity(observed))
        budget.current["complete"] = True
    return shared


def reference_probe():
    """Peer account entrypoint: metadata-only, no locks/checkpoints/deletion."""
    budget = Budget()
    raw = bytearray()
    with selectors.DefaultSelector() as selector:
        os.set_blocking(sys.stdin.fileno(), False)
        selector.register(sys.stdin, selectors.EVENT_READ)
        while True:
            budget.check()
            if not selector.select(timeout=0.1):
                continue
            block = os.read(sys.stdin.fileno(), 16384)
            budget.check(read_bytes=len(block))
            if not block:
                break
            raw.extend(block)
            if len(raw) > 65536:
                raise Hold("reference-peer-request-size")
    request = json.loads(raw)
    root, home = Path(request["root"]), Path.home().resolve()
    expected = request["identity"]
    limits = request["limits"]
    if (request["version"] != 1 or not re.fullmatch("[0-9a-f]{48}", request["nonce"])
            or type(request["depth"]) is not int or not 0 <= request["depth"] <= 8
            or not isinstance(expected, list) or len(expected) != 8 or not all(type(v) is int for v in expected)
            or not root.is_absolute() or root.resolve() != root
            or not any(root.is_relative_to(p) for p in reference_roots(home))
            or expected[3] != os.getuid() or identity(root.lstat()) != tuple(expected)
            or type(limits["entries"]) is not int or not 0 < limits["entries"] <= MAX_ENTRIES
            or type(limits["seconds"]) not in (int, float) or not 0 < limits["seconds"] <= MAX_SECONDS
            or not isinstance(request["candidates"], list) or len(request["candidates"]) > 256):
        raise Hold("reference-peer-request-invalid")
    candidates = []
    for w, t, k in request["candidates"]:
        workspace, target = Path(w), Path(t)
        if not workspace.is_absolute() or not target.is_absolute() or not target.is_relative_to(workspace) or k not in ("packages", "turbopack"):
            raise Hold("reference-peer-request-invalid")
        candidates.append((workspace, target, k))
    # Remaining global limits are passed down, never multiplied per peer.
    # Reduce the original deadline; input/startup/validation time is not refunded.
    budget.started -= MAX_SECONDS-limits["seconds"]
    budget.check()
    budget.entries = MAX_ENTRIES-limits["entries"]
    initial_entries = budget.entries
    shared = set()
    budget.unresolved_references = []
    scan_reference_tree(home, root, request["depth"], candidates, budget, shared,
                        expected=tuple(expected), allow_peer=False)
    writer = regular_digest(Path(__file__), budget)
    response = {"version": 1, "nonce": request["nonce"], "requestSha256": hashlib.sha256(DirectoryProgress.encode(request)).hexdigest(),
                "uid": os.getuid(), "writer": writer, "complete": True, "rootIdentity": expected,
                "shared": sorted(str(p) for p in shared), "entriesInspected": budget.entries-initial_entries,
                "unresolved": budget.unresolved_references, "bytesRead": budget.read_bytes}
    if len(DirectoryProgress.encode(response)) > 1024 * 1024:
        raise Hold("reference-peer-output-size")
    print(json.dumps(response, separators=(",", ":")))
    return 0


def remove_target(workspace, target, kind, metadata, budget, anchor=None):
    if not getattr(shutil.rmtree, "avoids_symlink_attacks", False):
        raise Hold("fd-safe-removal-unavailable")
    packages = kind == "packages"
    stage = target.parent / (".rmd-cache-stage-" + uuid.uuid4().hex)
    before_read = budget.read_bytes
    seal = source_seal(workspace, target, budget)
    # Reserve both pre-deletion and final verification reads before staging.
    if budget.read_bytes + 2 * (budget.read_bytes - before_read) > MAX_READ_BYTES:
        budget.exhaust("content-read-reservation")
    workspace_guard(workspace, target, budget)
    unchanged(target, metadata, packages)
    if anchor:
        unchanged(anchor[0], anchor[1], True)
    try:
        if packages:
            stage.mkdir(mode=0o700)
            for child in list(target.iterdir()):
                if child.name not in RETAINED_PACKAGE_ENTRIES:
                    os.rename(child, stage / child.name)
        else:
            os.rename(target, stage)
        unchanged(stage, metadata, packages, True)
        inactive(workspace)
        if source_seal(workspace, target, budget, stage) != seal:
            raise Hold("source-or-evidence-changed")
        if anchor:
            unchanged(anchor[0], anchor[1], True)
        if not packages and target.exists() or packages and any(p.name not in RETAINED_PACKAGE_ENTRIES for p in target.iterdir()):
            raise Hold("replacement-target-appeared")
        unchanged(stage, metadata, packages, True)
        inactive(workspace)
        shutil.rmtree(stage)
    except BaseException:
        if stage.exists():
            if packages:
                for child in stage.iterdir():
                    if (target / child.name).exists() or (target / child.name).is_symlink():
                        raise Hold("restore-collision-stage-retained")
                    os.rename(child, target / child.name)
                stage.rmdir()
            elif not target.exists():
                os.rename(stage, target)
        raise
    try:
        if source_seal(workspace, target, budget) != seal:
            raise RemovedUnverified("post-removal-source-or-evidence-changed")
    except (Hold, OSError) as error:
        raise RemovedUnverified("post-removal-verification-unavailable") from error


def node_compile_files(root, budget):
    if root.name != "node-compile-cache" or root.resolve() != root:
        raise Hold("node-cache-provenance-unavailable")
    for parent in [root, *root.parents]:
        if (parent / ".git").exists() or parent.name in {"node_modules", ".ssh", ".claude", "state"} or any((parent / name).exists() for name in KEEP):
            raise Hold("node-cache-protected-parent")
    entries, selected = {}, {}
    for p, s in walk(root, budget):
        rel = p.relative_to(root)
        if s.st_uid != os.getuid() or getattr(s, "st_flags", 0):
            raise Hold("node-cache-foreign-or-flagged")
        if p == root:
            continue
        if len(rel.parts) == 1 and stat.S_ISDIR(s.st_mode):
            if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+-(?:arm64|x64)-[0-9a-f]{8}(?:-" + str(os.getuid()) + r")?", p.name):
                raise Hold("node-cache-unrecognized-version")
        elif len(rel.parts) == 2 and stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and re.fullmatch(r"[0-9a-f]{8}", p.name):
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                before = identity(os.fstat(fd))
                header = os.read(fd, 4)
                budget.check(read_bytes=len(header))
                if header != bytes.fromhex("b2dbdf8a") or identity(os.fstat(fd)) != before:
                    raise Hold("node-cache-unrecognized-or-changed-payload")
            finally:
                os.close(fd)
            if max(s.st_mtime, s.st_ctime) <= time.time() - AGE_SECONDS:
                selected[p] = identity(s)
        else:
            raise Hold("node-cache-unrecognized-or-special-entry")
        entries[p] = identity(s)
    return entries, selected


def reclaim_node_compile(root, budget, apply):
    row = {"path": str(root), "kind": "node-compile", "action": "keep"}
    try:
        entries, selected = node_compile_files(root, budget)
        if not selected:
            raise Hold("node-cache-no-old-files")
        inactive(root, next(iter(selected)))
        if apply:
            current, eligible = node_compile_files(root, budget)
            if current != entries or eligible != selected:
                raise Hold("node-cache-namespace-or-metadata-changed")
            inactive(root, next(iter(selected)))
            removed = 0
            for path, expected in selected.items():
                # Bind each unlink to its original physical parent. Renaming
                # first makes replacement races visible before deletion.
                fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                name = ".rmd-node-cache-stage-" + uuid.uuid4().hex
                staged = False
                try:
                    expected_parent = entries[path.parent]
                    if identity(os.fstat(fd))[:4] != expected_parent[:4]:
                        raise Hold("node-cache-parent-replaced")
                    if identity(os.stat(path.name, dir_fd=fd, follow_symlinks=False)) != expected:
                        raise Hold("node-cache-changed-before-stage")
                    os.rename(path.name, name, src_dir_fd=fd, dst_dir_fd=fd)
                    staged = True
                    actual = identity(os.stat(name, dir_fd=fd, follow_symlinks=False))
                    if actual[:6] != expected[:6] or actual[7:] != expected[7:]:
                        raise Hold("node-cache-changed-during-stage")
                    os.unlink(name, dir_fd=fd)
                    staged = False
                    removed += 1
                except BaseException:
                    if staged:
                        try:
                            os.stat(path.name, dir_fd=fd, follow_symlinks=False)
                        except FileNotFoundError:
                            os.rename(name, path.name, src_dir_fd=fd, dst_dir_fd=fd)
                        else:
                            row["retainedStage"] = str(path.parent / name)
                    raise
                finally:
                    os.close(fd)
            row.update(action="removed", removedFiles=removed)
        else:
            row.update(action="would-remove", selectedFiles=len(selected))
    except (Hold, OSError) as error:
        if apply and locals().get("removed", 0):
            row.update(action="removed-unverified", removedFiles=removed, reason=str(error))
        else:
            row["reason"] = str(error)
    return row


def reclaim_artifacts(home, root, budget, apply, decisions, inspection):
    candidates, pending, anchors, rows = [], [], {}, {}
    try:
        discovery(root, budget, candidates)
        inspection["discoveryComplete"] = True
        for workspace, target, kind in candidates:
            row = {"path": str(target), "kind": kind, "action": "keep", "deferred": True}
            rows[target] = row
            decisions.append(row)
        # This root-only observation can prove KEEP, never eligibility. If all
        # roots are young/foreign/flagged, no global reference scan is needed.
        for workspace, target, kind in candidates:
            budget.phase("keep-prefilter", target)
            budget.check(entries=1)
            try:
                observed = target.lstat()
                if (observed.st_uid != os.getuid() or getattr(observed, "st_flags", 0)
                        or max(observed.st_mtime, observed.st_ctime) > time.time() - AGE_SECONDS):
                    rows[target].update(reason="recent-foreign-or-flagged", deferred=False, prefilterKeep=True)
                else:
                    pending.append((workspace, target, kind))
                budget.current["complete"] = True
            except OSError as error:
                rows[target].update(reason=str(error), deferred=False, prefilterKeep=True)
        inspection["referencesRequired"] = bool(pending)
        if pending:
            shared = references(home, pending, budget)
            inspection["referencesComplete"] = True
        progress = budget.progress
        cursor = getattr(progress, "candidate_cursor", None)
        offset = next((index for index, (_w, target, _k) in enumerate(pending) if str(target) == cursor), 0)
        pending = pending[offset:] + pending[:offset]
        inspection["candidateStart"] = str(pending[0][1]) if pending else None
        for index, (workspace, target, kind) in enumerate(pending):
            if progress is not None:
                # If this attempt exhausts its budget, begin HERE next pass.
                # No prior KEEP/eligibility result or anchor is reused.
                progress.candidate_cursor = str(target)
            row = rows[target]
            budget.phase("candidate-inspection", target)
            try:
                budget.check()
                if target in shared:
                    raise Hold("shared-reference")
                metadata, allocated = old_owned(target, budget)
                workspace_guard(workspace, target, budget)
                anchor = None
                if kind == "packages":
                    signature = hashlib.sha256(json.dumps(payload(target, budget), sort_keys=True).encode()).hexdigest()
                    if signature not in anchors:
                        anchors[signature] = (target, metadata)
                        raise Hold("retained-complete-payload-anchor")
                    anchor = anchors[signature]
                if apply:
                    remove_target(workspace, target, kind, metadata, budget, anchor)
                row.update(action="removed" if apply else "would-remove", pathAllocatedBytes=allocated)
                budget.current["complete"] = True
            except RemovedUnverified as error:
                row.update(action="removed-unverified", reason=str(error), deferred=False)
                return
            except (Hold, OSError) as error:
                if str(error) == "inspection-budget":
                    # Give an interrupted tail the next fresh pass, but an
                    # indivisible first target must not starve every sibling.
                    if index == 0 and progress is not None:
                        progress.candidate_cursor = str(pending[(index + 1) % len(pending)][1])
                        inspection["candidateRotationAfterExhaustion"] = True
                    raise
                row["reason"] = str(error)
            row["deferred"] = False
            if progress is not None:
                progress.candidate_cursor = str(pending[(index + 1) % len(pending)][1])
        inspection["candidateEvaluationComplete"] = True
        if progress is not None:
            progress.candidate_cursor = None
    except (Hold, OSError) as error:
        if budget.current is not None:
            budget.current["error"] = str(error)
        inspection["blockedStage"] = budget.stage
        inspection["blockedRoot"] = budget.root
        inspection["reason"] = str(error)
        decisions.append({"action": "keep", "reason": str(error), "stage": budget.stage, "root": budget.root})
    finally:
        # Discovery is streaming: even an interrupted pass retains every
        # candidate already found, without pretending the unseen count is zero.
        for _workspace, target, kind in candidates:
            if target not in rows:
                rows[target] = {"path": str(target), "kind": kind, "action": "keep", "deferred": True}
                decisions.append(rows[target])
        for row in rows.values():
            if row["deferred"]:
                row.update(reason=("discovery-incomplete" if not inspection["discoveryComplete"] else
                                   "reference-corpus-incomplete" if inspection["referencesRequired"]
                                   and not inspection["referencesComplete"] else "candidate-inspection-incomplete"),
                           detail=inspection.get("reason", "evaluation-stopped"))
        inspection.update(discoveredCandidateCount=len(candidates),
                          undiscoveredCandidateCount=0 if inspection["discoveryComplete"] else None,
                          deferredCandidateCount=sum(row["deferred"] for row in rows.values()),
                          prefilterKeepCount=sum(row.get("prefilterKeep", False) for row in rows.values()),
                          candidateCursor=getattr(budget.progress, "candidate_cursor", None))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--node-compile-cache", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--reference-probe", action="store_true", help="read-only peer metadata protocol on stdin")
    args = parser.parse_args(argv)
    if args.reference_probe:
        if args.apply or args.node_compile_cache:
            parser.error("reference probes cannot apply cleanup")
        try:
            return reference_probe()
        except (Hold, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            print("reference probe refused: " + str(error), file=sys.stderr)
            return 2
    home = args.home.resolve()
    root = home / ".codex/work-artifacts"
    budget, decisions = Budget(), []
    inspection = {"mode": "artifacts", "discoveryComplete": False,
                  "referencesRequired": False, "referencesComplete": False,
                  "candidateEvaluationComplete": False, "discoveredCandidateCount": 0,
                  "undiscoveredCandidateCount": None, "deferredCandidateCount": 0,
                  "prefilterKeepCount": 0}
    before = shutil.disk_usage(home).free
    if args.node_compile_cache:
        inspection["mode"] = "node-compile"
        budget.phase("node-compile", args.node_compile_cache)
        try:
            with cache_owner(home):
                decisions.append(reclaim_node_compile(args.node_compile_cache, budget, args.apply))
        except (Hold, OSError) as error:
            decisions.append({"action": "keep", "reason": str(error)})
    elif root.is_dir() and not root.is_symlink() and root.resolve() == root:
        try:
            with cache_owner(home):
                progress = DirectoryProgress(home, budget)
                budget.progress = progress
                inspection["progress"] = progress.stats
                try:
                    reclaim_artifacts(home, root, budget, args.apply, decisions, inspection)
                finally:
                    try:
                        progress.save()
                    finally:
                        progress.close()
                        budget.progress = None
        except (Hold, OSError) as error:
            decisions.append({"action": "keep", "reason": str(error)})
    budget.finish_interval()
    for scan in budget.scans:
        scan["elapsedMs"] = round(scan["elapsedMs"], 3)
    inspection.update(stage=budget.stage, root=budget.root, scans=budget.scans,
                      exhausted=budget.exhausted, peerReferenceProbes=getattr(budget, "peer_probes", 0))
    result = {"version": 1, "ageHours": 6, "apply": args.apply,
              "durationMs": int((time.monotonic() - budget.started) * 1000),
              "entriesInspected": budget.entries, "bytesRead": budget.read_bytes,
              "beforeAvailableBytes": before, "afterAvailableBytes": shutil.disk_usage(home).free,
              "inspection": inspection, "decisions": decisions, "sourceOrGitRetired": False}
    print("cache-reclaim: " + json.dumps(result, separators=(",", ":")))
    return 2 if any(row["action"] == "removed-unverified" for row in decisions) else 0


if __name__ == "__main__":
    raise SystemExit(main())
