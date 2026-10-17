"""Inert byte-correct fixtures and pinned real-pip loading for audit unit controls.

No downloads, package installation, build, candidate import or target-loader
fallback. The caller must run Linux Python 3.12 with -I -S and provide the exact
reviewed auditor SHA-256 plus an explicit approved pip wheel path.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import os
import pathlib
import platform
import re
import stat
import sys
import types
import zipfile

PIP_SHA = "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"
PIP_BYTES = 1816632
AUDITOR_FILENAME = "runtime-compatibility-audit.py"
CANDIDATE_MODULES = frozenset({
    "semgrep", "mcp", "attack", "one", "two", "three", "four", "leaf",
    "base_dep", "extra_dep", "other_leaf", "shared", "namespace",
})


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stable_regular(path, limit):
    path = pathlib.Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or path.is_symlink() or not 0 < before.st_size <= limit:
        raise AssertionError("bounded nonempty regular input required: " + str(path))
    raw = path.read_bytes()
    after = path.lstat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, len(raw), after.st_mtime_ns, after.st_ctime_ns):
        raise AssertionError("input changed during read: " + str(path))
    return raw


def require_runtime():
    if not (sys.flags.isolated and sys.flags.no_site):
        raise AssertionError("require Python -I -S; never process candidate site initialization")
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
        raise AssertionError("actual Linux Python 3.12 required; patch is recorded, not substituted")
    if "ENSUREPIP_OPTIONS" in os.environ:
        raise AssertionError("unset ENSUREPIP_OPTIONS; test real ordinary pip alias behavior")


def load_auditor(expected_sha):
    if not isinstance(expected_sha, str) or re.fullmatch(r"[a-f0-9]{64}", expected_sha) is None:
        raise AssertionError("explicit reviewed auditor SHA-256 required; no baseline fallback")
    # Fixed sibling only. No caller-selected source path or import search.
    path = pathlib.Path(__file__).absolute().with_name(AUDITOR_FILENAME)
    raw = stable_regular(path, 65536)
    if sha(raw) != expected_sha:
        raise AssertionError("reviewed auditor SHA-256 mismatch")
    module = types.ModuleType("_repo_semgrep_auditor_under_test")
    module.__file__ = str(path)
    exec(compile(raw, str(path), "exec", dont_inherit=True), module.__dict__)
    return module, path, raw


def load_context(pip_wheel, expected_auditor_sha256, scratch, marker_name):
    require_runtime()
    if any(name == "pip" or name.startswith("pip.") for name in sys.modules):
        raise AssertionError("pip already imported; fresh isolated interpreter required")
    wheel_path = pathlib.Path(pip_wheel)
    if not wheel_path.is_absolute() or wheel_path.name != "pip-26.2.1-py3-none-any.whl":
        raise AssertionError("explicit absolute approved pip wheel path required")
    raw = stable_regular(wheel_path, 2 << 20)
    if len(raw) != PIP_BYTES or sha(raw) != PIP_SHA:
        raise AssertionError("exact approved pip 26.2.1 wheel bytes required")
    scratch = pathlib.Path(scratch)
    if not scratch.is_absolute() or not scratch.is_dir() or scratch.is_symlink():
        raise AssertionError("explicit neutral receipt directory required")
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", marker_name) is None:
        raise AssertionError("bounded marker basename required")
    marker = scratch / marker_name
    if marker.exists() or marker.is_symlink():
        raise AssertionError("candidate marker must not preexist")
    auditor, auditor_path, auditor_raw = load_auditor(expected_auditor_sha256)
    before_path = tuple(sys.path)
    sys.path.insert(0, str(wheel_path))  # approved zip ONLY; never site.addsitedir()
    import pip
    if pip.__version__ != "26.2.1" or not pip.__file__.startswith(str(wheel_path) + "/pip/"):
        raise AssertionError("pip version/origin differs from approved archive")
    provenance = {
        "state": "ACTUAL_LINUX312_SYNTHETIC_SOURCE_MODULE_ONLY",
        "platform": sys.platform, "machine": platform.machine(),
        "pythonVersion": platform.python_version(), "pythonFull": sys.version,
        "executable": sys.executable, "isolated": bool(sys.flags.isolated),
        "noSite": bool(sys.flags.no_site), "pipVersion": pip.__version__,
        "pipOrigin": pip.__file__, "pipWheelSha256": PIP_SHA, "pipWheelBytes": len(raw),
        "auditorSha256": sha(auditor_raw), "auditorPath": str(auditor_path),
        "linuxQualification": False, "pinnedRuntimeQualified": False,
        "realArtifactCompatibility": "UNKNOWN", "runnerQualified": False,
        "exactTargetPatchObserved": sys.version_info[:3] == (3, 12, 15),
        "workflowQualification": "UNKNOWN", "syntheticWheelStorage": "memory only",
        "productionTargetLoaderCalled": False, "observedHostFallbackCalled": False,
    }
    api = auditor._api_from_imported_pip(provenance)
    for obj in (api.Distribution, api.PackageDetails, api.check_package_set,
                api.Requirement, api.get_console_script_specs):
        origin = sys.modules[obj.__module__].__file__
        if not origin.startswith(str(wheel_path) + "/pip/"):
            raise AssertionError("API did not originate in approved pip wheel")
    context = types.SimpleNamespace(
        auditor=auditor, api=api, provenance=provenance, pip_wheel=wheel_path,
        expected_auditor_sha256=expected_auditor_sha256, auditor_path=auditor_path,
        auditor_raw=auditor_raw, scratch=scratch, marker=marker,
        approved_path=(str(wheel_path), *before_path))
    assert_no_candidate_execution(context)
    assert_frozen_inputs(context)
    return context


def assert_no_candidate_execution(context):
    if context.marker.exists() or context.marker.is_symlink():
        raise AssertionError("candidate marker appeared: " + str(context.marker))
    imported = [name for name in sys.modules if name.split(".", 1)[0] in CANDIDATE_MODULES]
    if imported:
        raise AssertionError("candidate modules imported: " + repr(imported))
    if tuple(sys.path) != context.approved_path:
        raise AssertionError("candidate/unreviewed path entered sys.path")
    for name, module in tuple(sys.modules.items()):
        if name == "pip" or name.startswith("pip."):
            origin = getattr(module, "__file__", None)
            if origin is not None and not origin.startswith(str(context.pip_wheel) + "/pip/"):
                raise AssertionError("pip module escaped approved zip origin: " + name)


def assert_frozen_inputs(context):
    if stable_regular(context.auditor_path, 65536) != context.auditor_raw:
        raise AssertionError("auditor source bytes changed")
    raw = stable_regular(context.pip_wheel, 2 << 20)
    if len(raw) != PIP_BYTES or sha(raw) != PIP_SHA:
        raise AssertionError("approved pip bytes changed")


def payload(context):
    return ("import pathlib\npathlib.Path(" + repr(str(context.marker)) + ").write_text('EXECUTED')\n"
            "raise RuntimeError('candidate payload executed')\n").encode()


def metadata(name, version, requirements=(), provided_extras=()):
    return ("\n".join(["Metadata-Version: 2.4", "Name: " + name, "Version: " + version,
                      "Requires-Python: >=3.12", *["Requires-Dist: " + item for item in requirements],
                      *["Provides-Extra: " + item for item in provided_extras], "", ""])).encode()


def wheel(name, version="1.0", requirements=(), files=None, entry_points=None,
          metadata_bytes=None, record_mutation=None, modes=None):
    """Real deterministic ZIP/CRC/RECORD; synthetic candidate bytes stay in memory."""
    stem = re.sub(r"[-_.]+", "_", name)
    info = stem + "-" + version + ".dist-info"
    members = {
        stem + "/__init__.py": b"# fixture bytes; never import\n",
        info + "/METADATA": metadata_bytes if metadata_bytes is not None else metadata(name, version, requirements),
        info + "/WHEEL": b"Wheel-Version: 1.0\nGenerator: repo-audit-unit-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n\n",
    }
    for path, data in (files or {}).items():
        members[path] = data.encode() if isinstance(data, str) else data
    if entry_points is not None:
        members[info + "/entry_points.txt"] = entry_points.encode()
    record_path = info + "/RECORD"
    rows = [[path, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode(), str(len(data))]
            for path, data in sorted(members.items())]
    rows.append([record_path, "", ""])
    if record_mutation is not None:
        record_mutation(rows)
    text = io.StringIO(newline="")
    csv.writer(text, lineterminator="\n").writerows(rows)
    members[record_path] = text.getvalue().encode()
    sink = io.BytesIO()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED) as archive:
        for path, data in sorted(members.items()):
            item = zipfile.ZipInfo(path, date_time=(2020, 1, 1, 0, 0, 0))
            item.create_system = 3
            item.external_attr = (modes or {}).get(path, stat.S_IFREG | 0o600) << 16
            archive.writestr(item, data)
    raw = sink.getvalue()
    if len(raw) > 65536:
        raise AssertionError("synthetic wheel exceeds 64 KiB fixture bound")
    return types.SimpleNamespace(filename=stem + "-" + version + "-py3-none-any.whl", raw=raw,
                                 members=members, record_path=record_path, info=info)


def scan(context, fixture):
    return context.auditor.scan_wheel(fixture.filename, fixture.raw, context.api)


def audit(context, *fixtures):
    return context.auditor.audit_distribution_set([scan(context, fixture) for fixture in fixtures], context.api)
