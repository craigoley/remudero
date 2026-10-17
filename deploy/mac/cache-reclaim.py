#!/usr/bin/env python3
"""Bounded cache-only cleanup. Never retire source, Git, state or build outputs.

Each pass has one serial owner, at most 45 seconds of admission/inspection,
500,000 inspected entries and 2 GiB of content reads. A commit already admitted
finishes or restores its staging even when the inspection budget expires.
"""
import argparse
from contextlib import contextmanager, ExitStack
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

AGE_SECONDS = 6 * 3600
MAX_SECONDS = 45
MAX_ENTRIES = 500_000
MAX_READ_BYTES = 2 * 1024**3
PRUNE = {".git", "node_modules", ".next", "state", ".ssh", ".claude"}
KEEP = {".rmd-janitor-keep", ".rmd-scratch-keep", ".rmd-dependency-seed-root.json"}
RETAINED_PACKAGE_ENTRIES = {".vite", ".rmd-dependency-seed.json"}


def retained_package_entry(rel):
    return rel.split("/", 1)[0] in RETAINED_PACKAGE_ENTRIES


class Hold(Exception):
    """An unavailable or unsafe observation is a retention decision."""


class RemovedUnverified(Hold):
    """Generated deletion completed, but its final evidence is unavailable."""


class Budget:
    def __init__(self):
        self.started = time.monotonic()
        self.entries = 0
        self.read_bytes = 0
        self.stage, self.root = "admission", None
        self.scans, self.current = [], None
        self.tick = self.started
        self.exhausted = None

    def phase(self, stage, root):
        self.finish_interval()
        self.stage, self.root = stage, str(root)
        self.current = {"stage": stage, "root": str(root), "elapsedMs": 0,
                        "entriesInspected": 0, "childrenEnumerated": 0,
                        "directoriesEnumerated": 0, "symlinksSeen": 0, "complete": False}
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
    if not stat.S_ISDIR(before.st_mode) or expected is not None and identity(before) != expected:
        raise Hold("scan-directory-changed")
    fd = os.open(operand, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if identity(os.fstat(fd)) != identity(before):
            raise Hold("scan-directory-changed")
        yield fd
        budget.check()
        if (identity(os.fstat(fd)) != identity(before)
                or identity(os.stat(operand, dir_fd=parent_fd, follow_symlinks=False)) != identity(before)):
            raise Hold("scan-directory-changed")
    finally:
        os.close(fd)


def directory_entries(path, budget, parent_fd=None, name=None, expected=None):
    with checked_directory(path, budget, parent_fd, name, expected) as fd:
        budget.count("directoriesEnumerated")
        with os.scandir(fd) as children:
            while True:
                budget.check()  # A wide flat directory must not evade the wall bound.
                try:
                    child = next(children)
                except StopIteration:
                    break
                budget.count("childrenEnumerated")
                budget.check(entries=1)  # Charge every child before inspecting its type.
                yield child, path / child.name, fd


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
    if cwds.returncode or cwds.stderr.strip():
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
    if opened.returncode != 1 or opened.stdout.strip() or opened.stderr.strip():
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
        for entry, child, fd in directory_entries(path, budget, parent_fd, name, expected):
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


def references(home, candidates, budget):
    roots = [home / name for name in ["Remudero", "rmd-work", "Developer", ".codex/work-artifacts"]]
    roots.append(Path(tempfile.gettempdir()).resolve())
    if home == Path(pwd.getpwuid(os.getuid()).pw_dir):
        roots.append(Path("/private/tmp"))
    shared = set()
    def visit(path, depth, parent_fd=None, name=None, expected=None):
        for entry, child, fd in directory_entries(path, budget, parent_fd, name, expected):
            if entry.is_symlink():
                budget.count("symlinksSeen")
                before = identity(entry.stat(follow_symlinks=False))
                referent = Path(os.readlink(entry.name, dir_fd=fd))
                if not referent.is_absolute():
                    referent = path / referent
                try:
                    referent = referent.resolve(strict=False)
                except RuntimeError as error:
                    raise Hold("reference-symlink-unresolvable") from error
                budget.check()
                if identity(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)) != before:
                    raise Hold("reference-symlink-changed")
                for workspace, target, _kind in candidates:
                    budget.check()
                    if (referent == target or referent.is_relative_to(target)
                            or referent.is_relative_to(workspace) and target.is_relative_to(referent)
                            or referent == workspace):
                        shared.add(target)
            elif entry.is_dir(follow_symlinks=False) and depth < 8 and entry.name not in PRUNE and not entry.name.endswith(".git"):
                visit(child, depth + 1, fd, entry.name, identity(entry.stat(follow_symlinks=False)))
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
        visit(root, 0, expected=identity(observed))
        budget.current["complete"] = True
    return shared


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
        for workspace, target, kind in pending:
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
                    raise
                row["reason"] = str(error)
            row["deferred"] = False
        inspection["candidateEvaluationComplete"] = True
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
                          prefilterKeepCount=sum(row.get("prefilterKeep", False) for row in rows.values()))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--node-compile-cache", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
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
                reclaim_artifacts(home, root, budget, args.apply, decisions, inspection)
        except (Hold, OSError) as error:
            decisions.append({"action": "keep", "reason": str(error)})
    budget.finish_interval()
    for scan in budget.scans:
        scan["elapsedMs"] = round(scan["elapsedMs"], 3)
    inspection.update(stage=budget.stage, root=budget.root, scans=budget.scans,
                      exhausted=budget.exhausted)
    result = {"version": 1, "ageHours": 6, "apply": args.apply,
              "durationMs": int((time.monotonic() - budget.started) * 1000),
              "entriesInspected": budget.entries, "bytesRead": budget.read_bytes,
              "beforeAvailableBytes": before, "afterAvailableBytes": shutil.disk_usage(home).free,
              "inspection": inspection, "decisions": decisions, "sourceOrGitRetired": False}
    print("cache-reclaim: " + json.dumps(result, separators=(",", ":")))
    return 2 if any(row["action"] == "removed-unverified" for row in decisions) else 0


if __name__ == "__main__":
    raise SystemExit(main())
