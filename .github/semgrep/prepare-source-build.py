"""Prepare an inert, reproducible downstream CLI build with the original CE engine.

This is SOURCE ASSEMBLY, not compilation of the OCaml engine. Python/package
payloads come from the original sdist, not the donor wheel. Only the exact approved
native payloads come from that wheel. The source pyproject is explicitly patched;
new distribution metadata is generated from that source. No upstream wheel or
installed METADATA is modified. No build hook, package import, subprocess, network,
installation, package publication or scanner execution occurs here.

An assembled wheel is NOT runtime, dependency-closure or whole-corpus qualification.
The existing independent artifact audit and pip check still have to accept it.
"""
from __future__ import annotations

import argparse
import base64
import csv
import difflib
import email.policy
import gzip
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import stat
import sys
import tarfile
import tomllib
import zipfile
import zlib
from email.message import EmailMessage

POLICY_SHA256 = "5cf435e3bb81a52e1583ea00008d0e46a3c0ec64d920fe6720d59f88870bd83a"
MAX_SOURCE = 2 << 20
MAX_TAR = 16 << 20
MAX_DONOR = 128 << 20
MAX_EXPANDED = 512 << 20
MAX_MEMBERS = 1000
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


class BuildBlocked(ValueError):
    """A named refusal, never a success-shaped fallback."""


def need(condition, reason):
    if not condition:
        raise BuildBlocked(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stable_regular(path, maximum):
    """Bind bytes to one non-symlink regular inode; reject concurrent replacement."""
    path = pathlib.Path(path)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and not path.is_symlink(), "INPUT_NOT_REGULAR")
    need(0 < before.st_size <= maximum, "INPUT_SIZE")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        need((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), "INPUT_REPLACED")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    final = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    need(identity(before) == identity(opened) == identity(after) == identity(final), "INPUT_CHANGED")
    need(len(raw) == before.st_size, "INPUT_TRUNCATED")
    return raw


def safe_name(name):
    need(isinstance(name, str) and 0 < len(name) <= 400, "ARCHIVE_PATH")
    need(re.fullmatch(r"[A-Za-z0-9_.+/-]+", name) is not None, "ARCHIVE_PATH")
    parts = name.split("/")
    need(not name.startswith("/") and all(p not in {"", ".", ".."} for p in parts), "ARCHIVE_PATH")
    need(not any(p.lower().endswith((".pyc", ".pyo", ".pth", "._pth")) or
                 p.lower() in {"__pycache__", "sitecustomize.py", "usercustomize.py", "pyvenv.cfg"}
                 for p in parts), "STARTUP_OR_BYTECODE")
    return parts


def load_policy():
    raw = stable_regular(pathlib.Path(__file__).absolute().with_name("source-build-policy.json"), 32768)
    need(sha(raw) == POLICY_SHA256, "POLICY_HASH")
    policy = json.loads(raw)
    need(policy["schema"] == "rmd-semgrep-source-build-policy/v1", "POLICY_SCHEMA")
    need(policy["upstreamVersion"] == "1.181.0" and
         policy["distributionVersion"] == "1.181.0+remudero.1", "POLICY_IDENTITY")
    need(policy["dependencyPatch"] == {"from": "mcp==1.29.0", "to": "mcp==1.30.0"}, "POLICY_DEPENDENCY")
    need(policy["pilotDefaultOff"] is True and policy["published"] is False and
         policy["runtimeQualified"] is False, "POLICY_BOUNDARY")
    return policy


def source_members(raw, policy):
    pin = policy["source"]
    need(len(raw) == pin["bytes"] and sha(raw) == pin["sha256"], "SOURCE_HASH")
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
        expanded = stream.read(MAX_TAR + 1)
    need(len(expanded) <= MAX_TAR, "SOURCE_EXPANSION")
    files, seen, expanded_files = {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
        for index, member in enumerate(archive):
            need(index < MAX_MEMBERS, "MEMBER_BOUND")
            parts = safe_name(member.name.rstrip("/") if member.isdir() else member.name)
            need(parts[0] == pin["root"] and member.name not in seen, "SOURCE_PATH")
            seen.add(member.name)
            need(member.isfile() or member.isdir(), "SOURCE_SPECIAL_FILE")
            if member.isdir():
                continue
            need(0 <= member.size <= 4 << 20 and not member.mode & 0o6000, "SOURCE_MEMBER_BOUND")
            expanded_files += member.size
            need(expanded_files <= MAX_TAR and len(parts) > 1, "SOURCE_EXPANSION")
            logical = "/".join(parts[1:])
            need(logical.casefold() not in {p.casefold() for p in files}, "SOURCE_ALIAS")
            files[logical] = archive.extractfile(member).read()  # bytes only, never extract()
    need(len(files) == pin["fileCount"], "SOURCE_INVENTORY")
    need(sha(files.get("pyproject.toml", b"")) == pin["projectSha256"], "PROJECT_HASH")
    return files


def patch_project(raw, policy):
    text = raw.decode("utf-8")
    original = tomllib.loads(text)["project"]
    need(original["name"] == "semgrep" and original["version"] == policy["upstreamVersion"], "PROJECT_IDENTITY")
    old_version = 'version = "' + policy["upstreamVersion"] + '"'
    new_version = 'version = "' + policy["distributionVersion"] + '"'
    old_dep, new_dep = policy["dependencyPatch"]["from"], policy["dependencyPatch"]["to"]
    need(text.count(old_version) == 1 and text.count('"' + old_dep + '"') == 1, "PATCH_CONTEXT")
    need(original["dependencies"].count(old_dep) == 1 and new_dep not in original["dependencies"], "PATCH_DEPENDENCY")
    patched = text.replace(old_version, new_version, 1).replace('"' + old_dep + '"', '"' + new_dep + '"', 1)
    project = tomllib.loads(patched)["project"]
    expected = dict(original)
    expected["version"] = policy["distributionVersion"]
    expected["dependencies"] = [new_dep if dep == old_dep else dep for dep in original["dependencies"]]
    need(project == expected, "PATCH_SCOPE")
    need(project["scripts"] == policy["entryPoints"] and not project.get("dynamic") and
         not project.get("optional-dependencies"), "PROJECT_SCOPE")
    diff = "".join(difflib.unified_diff(text.splitlines(keepends=True), patched.splitlines(keepends=True),
                                      fromfile="a/pyproject.toml", tofile="b/pyproject.toml"))
    return patched.encode(), project, diff.encode()


def original_payload(raw, sources, policy):
    pin = policy["engineDonor"]
    need(len(raw) == pin["bytes"] and sha(raw) == pin["sha256"], "DONOR_HASH")
    native_pins = {item["path"]: item for item in pin["nativeMembers"]}
    need(len(native_pins) == len(pin["nativeMembers"]) and "semgrep/bin/semgrep-core" in native_pins, "ENGINE_INVENTORY")
    payload, origins, seen, expanded = {}, {}, set(), 0
    native_seen, package_count = set(), 0
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        need(0 < len(infos) <= MAX_MEMBERS, "MEMBER_BOUND")
        for info in infos:
            need(info.filename == info.orig_filename and not info.flag_bits & 1, "DONOR_PATH")
            parts = safe_name(info.filename.rstrip("/") if info.is_dir() else info.filename)
            need(info.filename not in seen, "DONOR_DUPLICATE")
            seen.add(info.filename)
            kind = stat.S_IFMT(info.external_attr >> 16)
            need(kind in {0, stat.S_IFREG, stat.S_IFDIR}, "DONOR_SPECIAL_FILE")
            if info.is_dir():
                continue
            need(kind != stat.S_IFDIR, "DONOR_TYPE")
            expanded += info.file_size
            need(info.file_size <= MAX_EXPANDED and expanded <= MAX_EXPANDED, "DONOR_EXPANSION")
            # All source/metadata stays inert; ZIP reads also verify each member's CRC.
            data = archive.read(info)
            if parts[0] == pin["distInfo"]:
                continue
            need(info.filename.startswith(pin["storagePrefix"]), "DONOR_INSTALL_SCHEME")
            logical = info.filename.removeprefix(pin["storagePrefix"])
            logical_parts = safe_name(logical)
            need(logical_parts[0] in policy["packageRoots"], "DONOR_PACKAGE_ROOT")
            need(logical.casefold() not in {p.casefold() for p in payload}, "DONOR_DESTINATION_ALIAS")
            source_path = "src/" + logical
            if logical in native_pins:
                approved = native_pins[logical]
                need(len(data) == approved["bytes"] and sha(data) == approved["sha256"] and
                     (info.external_attr >> 16) & 0o777 == approved["mode"], "NATIVE_MEMBER_HASH")
                native_seen.add(logical)
                if logical.endswith(".py"):
                    need(sources.get(source_path) == data, "NATIVE_PYTHON_SOURCE_MISMATCH")
                    data = sources[source_path]
                    origin = "original-source"
                else:
                    origin = "unchanged-upstream-native-engine"
                mode = approved["mode"]
            else:
                need(sources.get(source_path) == data, "PACKAGE_SOURCE_MISMATCH")
                data, mode, origin = sources[source_path], 0o644, "original-source"
                package_count += 1
            payload[logical] = (data, mode)
            origins[logical] = {"path": logical, "bytes": len(data), "sha256": sha(data), "origin": origin}
    need(native_seen == set(native_pins) and package_count == pin["sourceBackedPackageFiles"], "PAYLOAD_INVENTORY")
    need(len(payload) == len(native_pins) + package_count, "PAYLOAD_POPULATION")
    return payload, [origins[path] for path in sorted(origins)]


def metadata_from_source(project, sources, policy):
    message = EmailMessage(policy=email.policy.default.clone(max_line_length=0, utf8=True))
    for key, value in [("Metadata-Version", "2.4"), ("Name", project["name"]), ("Version", project["version"]),
                       ("Summary", project["description"]), ("Requires-Python", project["requires-python"]),
                       ("License-Expression", project["license"]), ("Description-Content-Type", "text/markdown")]:
        message[key] = value
    for requirement in project["dependencies"]:
        message["Requires-Dist"] = requirement
    for label, url in project["urls"].items():
        message["Project-URL"] = label + ", " + url
    for license_file in policy["licenseFiles"]:
        need(license_file in sources and license_file in project["license-files"], "LICENSE_MISSING")
        message["License-File"] = license_file
    need(project["readme"] == "README.md" and "README.md" in sources, "README_MISSING")
    # Core metadata has a UTF-8 body, not an email transfer-encoding requirement.
    # Preserve the source README bytes; an ASCII-only fixture must not conceal
    # BytesGenerator rejecting real upstream Unicode prose and emoji.
    sources["README.md"].decode("utf-8")
    return message.as_bytes() + sources["README.md"]


def encode_record(files, record_path):
    stream = io.StringIO(newline="")
    rows = [[path, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode(), str(len(data))]
            for path, (data, _mode) in sorted(files.items())]
    rows.append([record_path, "", ""])
    csv.writer(stream, lineterminator="\n").writerows(rows)
    return stream.getvalue().encode()


def assemble(source_raw, donor_raw, policy, builder_sha):
    sources = source_members(source_raw, policy)
    patched, project, diff = patch_project(sources["pyproject.toml"], policy)
    payload, origins = original_payload(donor_raw, sources, policy)
    info = "semgrep-" + policy["distributionVersion"] + ".dist-info"
    provenance = {"schema": "rmd-semgrep-source-assembly/v1", "upstreamVersion": policy["upstreamVersion"],
                  "distributionVersion": policy["distributionVersion"], "engineVersion": policy["upstreamVersion"],
                  "engineRecompiled": False, "pythonProtocolVersionUnchanged": True,
                  "builderSha256": builder_sha, "policySha256": POLICY_SHA256,
                  "buildProfile": {"python": platform.python_version(), "platform": sys.platform,
                                   "machine": platform.machine(), "zlib": zlib.ZLIB_RUNTIME_VERSION,
                                   "zipCompression": "DEFLATE", "zipCompressionLevel": 9},
                  "reproducibilityScope": "same recorded Python/zlib profile; cross-profile identity is not claimed",
                  "sourceArchiveSha256": sha(source_raw), "engineDonorArchiveSha256": sha(donor_raw),
                  "originalProjectSha256": sha(sources["pyproject.toml"]), "patchedProjectSha256": sha(patched),
                  "sourcePatchSha256": sha(diff), "payload": origins,
                  "candidateExecution": False, "buildHooksExecuted": False, "networkAccessUsed": False,
                  "runtimeQualified": False, "dependencyClosureQualified": False, "wholeCorpusQualified": False,
                  "published": False, "pilotDefaultOff": True}
    files = dict(payload)
    files[info + "/METADATA"] = (metadata_from_source(project, sources, policy), 0o644)
    files[info + "/WHEEL"] = (("Wheel-Version: 1.0\nGenerator: remudero-inert-source-assembler 1\nRoot-Is-Purelib: false\nTag: " + policy["wheelTag"] + "\n").encode(), 0o644)
    entries = "[console_scripts]\n" + "".join(name + " = " + target + "\n" for name, target in sorted(project["scripts"].items()))
    files[info + "/entry_points.txt"] = (entries.encode(), 0o644)
    files[info + "/rmd-source/pyproject.toml"] = (patched, 0o644)
    files[info + "/rmd-source/source.patch"] = (diff, 0o644)
    files[info + "/rmd-source/provenance.json"] = ((json.dumps(provenance, sort_keys=True, separators=(",", ":")) + "\n").encode(), 0o644)
    for license_file in policy["licenseFiles"]:
        files[info + "/licenses/" + license_file] = (sources[license_file], 0o644)
    files[info + "/RECORD"] = (encode_record(files, info + "/RECORD"), 0o644)
    filename = "semgrep-" + policy["distributionVersion"] + "-" + policy["wheelTag"] + ".whl"
    return filename, files, provenance


def write_wheel(path, files):
    """Fixed order/time/modes and DEFLATE level; reproduce within recorded profile.

    Uncompressed payload exceeds the existing 256-MiB archive bound. Keep that
    guard intact rather than relabeling an oversized ZIP as independently audited.
    """
    with pathlib.Path(path).open("xb") as stream:
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as archive:
            for path in sorted(files, key=lambda p: (".dist-info/" in p, p)):
                data, mode = files[path]
                safe_name(path)
                info = zipfile.ZipInfo(path, FIXED_TIME)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def prepare(source_path, donor_path, output):
    need(sys_isolated(), "ISOLATED_STARTUP_REQUIRED")
    policy = load_policy()
    need(pathlib.Path(source_path).name == policy["source"]["name"] and
         pathlib.Path(donor_path).name == policy["engineDonor"]["name"], "INPUT_FILENAME")
    source_raw, donor_raw = stable_regular(source_path, MAX_SOURCE), stable_regular(donor_path, MAX_DONOR)
    builder_sha = sha(stable_regular(__file__, 65536))
    filename, files, provenance = assemble(source_raw, donor_raw, policy, builder_sha)
    output = pathlib.Path(output)
    need(output.is_absolute() and output.parent.is_dir() and not output.parent.is_symlink() and
         output.parent.resolve() == output.parent, "OUTPUT_PARENT")
    parent = output.parent.stat()
    need(parent.st_uid == os.getuid() and parent.st_mode & 0o077 == 0, "OUTPUT_PARENT_NOT_PRIVATE")
    output.mkdir(mode=0o700)  # exclusive; never overwrite, clear or follow an existing output
    wheel_path = output / filename
    write_wheel(wheel_path, files)
    with wheel_path.open("rb") as stream:
        wheel_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    receipt = {**{key: value for key, value in provenance.items() if key != "payload"},
               "state": "SOURCE_ASSEMBLED_NOT_RUNTIME_QUALIFIED", "wheel": filename,
               "wheelSha256": wheel_sha, "wheelBytes": wheel_path.stat().st_size,
               "payloadFiles": len(provenance["payload"]), "wheelFiles": len(files)}
    with (output / "source-build-receipt.json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    return receipt


def sys_isolated():
    return bool(sys.flags.isolated and sys.flags.no_site)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-archive", required=True)
    parser.add_argument("--engine-donor", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source_archive, args.engine_donor, args.output_dir), sort_keys=True))


if __name__ == "__main__":
    main()
