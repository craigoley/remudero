"""Inert source-assembly controls. No candidate import, build hook or engine execution."""
from __future__ import annotations

import base64
import argparse
import copy
import csv
import gzip
import hashlib
import importlib.util
import io
import json
import pathlib
import stat
import sys
import tarfile
import tempfile
import unittest
import zipfile
from email.parser import BytesParser

sys.dont_write_bytecode = True


MODULE_PATH = pathlib.Path(__file__).absolute().with_name("prepare-source-build.py")
SPEC = importlib.util.spec_from_file_location("reviewed_source_builder", MODULE_PATH)
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)
PROJECT = b'''[project]
name = "semgrep"
version = "1.181.0"
description = "Source assembly fixture"
readme = "README.md"
requires-python = ">=3.10"
license = "LGPL-2.1-or-later"
license-files = ["LICENSE"]
dependencies = ["mcp==1.29.0", "attrs>=21.3"]
[project.urls]
Repository = "https://github.com/semgrep/semgrep"
[project.scripts]
semgrep = "semgrep.console_scripts.entrypoint:main"
pysemgrep = "semgrep.console_scripts.pysemgrep:main"
'''


def tar_bytes(files, specials=()):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for name, raw in files.items():
            item = tarfile.TarInfo("semgrep-1.181.0/" + name)
            item.mode, item.size = 0o644, len(raw)
            archive.addfile(item, io.BytesIO(raw))
        for item in specials:
            archive.addfile(item)
    return gzip.compress(stream.getvalue(), mtime=0)


def zip_bytes(files, modes=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_STORED) as archive:
        for name, raw in files.items():
            item = zipfile.ZipInfo(name, B.FIXED_TIME)
            item.create_system = 3
            item.external_attr = (stat.S_IFREG | (modes or {}).get(name, 0o644)) << 16
            archive.writestr(item, raw)
    return stream.getvalue()


class SourceAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rmd-source-assembly-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.marker = self.root / "candidate-executed"
        self.python = ("from pathlib import Path\nPath(" + repr(str(self.marker)) + ").touch()\nraise RuntimeError('CANDIDATE_EXECUTED')\n").encode()
        self.sources = {"pyproject.toml": PROJECT, "README.md": b"fixture readme\n", "LICENSE": b"fixture license\n", "src/semgrep/__init__.py": self.python}
        self.prefix = "semgrep-1.181.0.data/purelib/"
        self.engine_path = self.prefix + "semgrep/bin/semgrep-core"
        self.donor_files = {self.prefix + "semgrep/__init__.py": self.python, self.engine_path: b"\x7fELF-INERT-NOT-AN-EXECUTABLE", "semgrep-1.181.0.dist-info/METADATA": b"Name: semgrep\nVersion: 1.181.0\nRequires-Dist: mcp==1.29.0\n"}
        self.source_raw = tar_bytes(self.sources)
        self.donor_raw = zip_bytes(self.donor_files, {self.engine_path: 0o755})
        self.policy = {"upstreamVersion": "1.181.0", "distributionVersion": "1.181.0+remudero.1", "dependencyPatch": {"from": "mcp==1.29.0", "to": "mcp==1.30.0"},
                       "wheelTag": "cp312-none-manylinux_2_34_x86_64", "source": {"root": "semgrep-1.181.0", "bytes": len(self.source_raw), "sha256": B.sha(self.source_raw), "projectSha256": B.sha(PROJECT), "fileCount": len(self.sources)},
                       "engineDonor": {"bytes": len(self.donor_raw), "sha256": B.sha(self.donor_raw), "storagePrefix": self.prefix, "distInfo": "semgrep-1.181.0.dist-info", "sourceBackedPackageFiles": 1,
                                       "nativeMembers": [{"path": "semgrep/bin/semgrep-core", "bytes": len(self.donor_files[self.engine_path]), "sha256": B.sha(self.donor_files[self.engine_path]), "mode": 0o755}]},
                       "packageRoots": ["semgrep", "semdep"], "licenseFiles": ["LICENSE"], "entryPoints": {"semgrep": "semgrep.console_scripts.entrypoint:main", "pysemgrep": "semgrep.console_scripts.pysemgrep:main"}}

    def tearDown(self):
        self.assertFalse(self.marker.exists(), "candidate source was executed")
        self.assertFalse("semgrep" in sys.modules or "mcp" in sys.modules)

    def build(self):
        return B.assemble(self.source_raw, self.donor_raw, self.policy, "a" * 64)

    def source_again(self, specials=()):
        self.source_raw = tar_bytes(self.sources, specials)
        self.policy["source"].update(bytes=len(self.source_raw), sha256=B.sha(self.source_raw), fileCount=len(self.sources))

    def donor_again(self, modes=None):
        actual = {self.engine_path: 0o755, **(modes or {})}
        self.donor_raw = zip_bytes(self.donor_files, actual)
        self.policy["engineDonor"].update(bytes=len(self.donor_raw), sha256=B.sha(self.donor_raw))

    def blocked(self, reason):
        with self.assertRaisesRegex(B.BuildBlocked, "^" + reason + "$"):
            self.build()

    def test_source_build_has_local_identity_fixed_mcp_and_inert_original_python(self):
        name, files, receipt = self.build()
        self.assertEqual(name, "semgrep-1.181.0+remudero.1-cp312-none-manylinux_2_34_x86_64.whl")
        info = "semgrep-1.181.0+remudero.1.dist-info/"
        metadata = BytesParser().parsebytes(files[info + "METADATA"][0])
        self.assertEqual(metadata["Version"], "1.181.0+remudero.1")
        self.assertEqual(metadata.get_all("Requires-Dist"), ["mcp==1.30.0", "attrs>=21.3"])
        self.assertEqual(files["semgrep/__init__.py"][0], self.sources["src/semgrep/__init__.py"])
        self.assertEqual(files["semgrep/bin/semgrep-core"], (self.donor_files[self.engine_path], 0o755))
        self.assertFalse(receipt["engineRecompiled"] or receipt["runtimeQualified"] or receipt["dependencyClosureQualified"])
        self.assertEqual(receipt["engineVersion"], "1.181.0")

    def test_original_archives_and_source_metadata_are_not_rewritten(self):
        source, donor, project = self.source_raw, self.donor_raw, self.sources["pyproject.toml"]
        self.build()
        self.assertEqual((source, donor, project), (self.source_raw, self.donor_raw, PROJECT))

    def test_source_metadata_preserves_utf8_readme_bytes(self):
        self.sources["README.md"] = "Original source résumé 🔎\n".encode("utf-8")
        self.source_again()
        _, files, _ = self.build()
        path = next(p for p in files if p.endswith("/METADATA"))
        self.assertTrue(files[path][0].endswith(self.sources["README.md"]))

    def test_explicit_patch_changes_only_project_version_and_one_dependency(self):
        patched, project, diff = B.patch_project(PROJECT, self.policy)
        self.assertIn(b'-version = "1.181.0"', diff)
        self.assertIn(b'+version = "1.181.0+remudero.1"', diff)
        self.assertIn(b'mcp==1.30.0', patched)
        self.assertEqual(project["dependencies"], ["mcp==1.30.0", "attrs>=21.3"])

    def test_source_hash_mismatch_blocks(self):
        self.policy["source"]["sha256"] = "0" * 64
        self.blocked("SOURCE_HASH")

    def test_donor_hash_mismatch_blocks(self):
        self.policy["engineDonor"]["sha256"] = "0" * 64
        self.blocked("DONOR_HASH")

    def test_source_file_population_is_not_inferred_from_zero(self):
        self.policy["source"]["fileCount"] = 0
        self.blocked("SOURCE_INVENTORY")

    def test_missing_project_positive_control_blocks(self):
        del self.sources["pyproject.toml"]
        self.source_again()
        self.blocked("PROJECT_HASH")

    def test_source_path_traversal_blocks_before_any_extraction(self):
        self.sources["../escape.py"] = b"inert"
        self.source_again()
        self.blocked("ARCHIVE_PATH")

    def test_casefold_source_alias_blocks(self):
        self.sources["src/SEMGREP/__init__.py"] = self.python
        self.source_again()
        self.blocked("SOURCE_ALIAS")

    def test_symlink_in_source_blocks(self):
        item = tarfile.TarInfo("semgrep-1.181.0/link")
        item.type, item.linkname = tarfile.SYMTYPE, "/tmp/foreign"
        self.source_again([item])
        self.blocked("SOURCE_SPECIAL_FILE")

    def test_hardlink_in_source_blocks(self):
        item = tarfile.TarInfo("semgrep-1.181.0/link")
        item.type, item.linkname = tarfile.LNKTYPE, "semgrep-1.181.0/LICENSE"
        self.source_again([item])
        self.blocked("SOURCE_SPECIAL_FILE")

    def test_already_modified_source_project_cannot_reuse_patch(self):
        changed = PROJECT.replace(b"mcp==1.29.0", b"mcp==1.30.0")
        with self.assertRaisesRegex(B.BuildBlocked, "PATCH_CONTEXT"):
            B.patch_project(changed, self.policy)

    def test_unrelated_dynamic_source_metadata_blocks(self):
        changed = PROJECT.replace(b'[project.urls]', b'dynamic = ["requires-dist"]\n[project.urls]')
        with self.assertRaisesRegex(B.BuildBlocked, "PROJECT_SCOPE"):
            B.patch_project(changed, self.policy)

    def test_unexpected_entrypoint_change_blocks(self):
        changed = PROJECT.replace(b"entrypoint:main", b"attack:main")
        with self.assertRaisesRegex(B.BuildBlocked, "PROJECT_SCOPE"):
            B.patch_project(changed, self.policy)

    def test_donor_python_different_from_source_blocks(self):
        self.donor_files[self.prefix + "semgrep/__init__.py"] = b"raise RuntimeError('DONOR')"
        self.donor_again()
        self.blocked("PACKAGE_SOURCE_MISMATCH")

    def test_missing_package_positive_control_blocks(self):
        del self.donor_files[self.prefix + "semgrep/__init__.py"]
        self.donor_again()
        self.blocked("PAYLOAD_INVENTORY")

    def test_missing_engine_positive_control_blocks(self):
        del self.donor_files[self.engine_path]
        self.donor_again()
        self.blocked("PAYLOAD_INVENTORY")

    def test_changed_engine_bytes_blocks_even_with_a_new_synthetic_donor_hash(self):
        self.donor_files[self.engine_path] += b"mutation"
        self.donor_again()
        self.blocked("NATIVE_MEMBER_HASH")

    def test_changed_engine_mode_blocks(self):
        self.donor_again({self.engine_path: 0o644})
        self.blocked("NATIVE_MEMBER_HASH")

    def test_unknown_native_library_blocks(self):
        self.donor_files[self.prefix + "semgrep/bin/libs/unreviewed.so"] = b"inert"
        self.donor_again()
        self.blocked("PACKAGE_SOURCE_MISMATCH")

    def test_donor_destination_alias_and_case_difference_blocks(self):
        self.donor_files[self.prefix + "semgrep/__INIT__.py"] = self.python
        self.donor_again()
        self.blocked("DONOR_DESTINATION_ALIAS")

    def test_other_data_scheme_is_not_an_equivalent_install_mapping(self):
        self.donor_files[self.prefix.replace("purelib", "scripts") + "semgrep/evil"] = b"inert"
        self.donor_again()
        self.blocked("DONOR_INSTALL_SCHEME")

    def test_foreign_top_level_package_blocks(self):
        self.donor_files[self.prefix + "pip/evil.py"] = b"inert"
        self.donor_again()
        self.blocked("DONOR_PACKAGE_ROOT")

    def test_startup_pth_in_donor_blocks(self):
        self.donor_files[self.prefix + "evil.pth"] = b"import evil"
        self.donor_again()
        self.blocked("STARTUP_OR_BYTECODE")

    def test_missing_license_is_not_silently_dropped(self):
        del self.sources["LICENSE"]
        self.source_again()
        self.blocked("LICENSE_MISSING")

    def test_wheel_record_covers_every_member_with_own_sha_and_size(self):
        _, files, _ = self.build()
        record_path = next(path for path in files if path.endswith("/RECORD"))
        rows = list(csv.reader(io.StringIO(files[record_path][0].decode())))
        self.assertEqual({r[0] for r in rows}, set(files))
        for path, encoded, size in rows:
            if path == record_path:
                self.assertEqual((encoded, size), ("", ""))
            else:
                data = files[path][0]
                self.assertEqual(encoded, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode())
                self.assertEqual(size, str(len(data)))

    def test_wheel_reproducibility_does_not_depend_on_input_mapping_order(self):
        _, files, _ = self.build()
        a, b = self.root / "a.whl", self.root / "b.whl"
        B.write_wheel(a, files)
        B.write_wheel(b, dict(reversed(list(files.items()))))
        self.assertEqual(a.read_bytes(), b.read_bytes())
        with zipfile.ZipFile(a) as archive:
            self.assertIsNone(archive.testzip())
            self.assertTrue(all(i.date_time == B.FIXED_TIME and i.compress_type == zipfile.ZIP_DEFLATED for i in archive.infolist()))

    def test_existing_wheel_output_is_never_overwritten(self):
        path = self.root / "owned.whl"
        path.write_bytes(b"preserve")
        with self.assertRaises(FileExistsError):
            B.write_wheel(path, {})
        self.assertEqual(path.read_bytes(), b"preserve")

    def test_symlink_input_does_not_follow_a_valid_regular_file(self):
        source = self.root / "input"
        source.write_bytes(b"valid")
        link = self.root / "link"
        link.symlink_to(source)
        with self.assertRaisesRegex(B.BuildBlocked, "INPUT_NOT_REGULAR"):
            B.stable_regular(link, 100)

    def test_regular_input_size_limit_is_enforced(self):
        source = self.root / "input"
        source.write_bytes(b"valid")
        self.assertEqual(B.stable_regular(source, 100), b"valid")
        with self.assertRaisesRegex(B.BuildBlocked, "INPUT_SIZE"):
            B.stable_regular(source, 1)

    def test_real_policy_identity_is_hash_bound_and_default_off(self):
        policy = B.load_policy()
        self.assertEqual(policy["distributionVersion"], "1.181.0+remudero.1")
        self.assertEqual(policy["dependencyPatch"]["to"], "mcp==1.30.0")
        self.assertEqual(len(policy["engineDonor"]["nativeMembers"]), 28)
        self.assertTrue(policy["pilotDefaultOff"])
        self.assertFalse(policy["published"] or policy["runtimeQualified"])


if __name__ == "__main__":
    if not (sys.flags.isolated and sys.flags.no_site):
        raise SystemExit("Require Python -I -S; never process unreviewed site startup")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    output = pathlib.Path(args.receipt)
    if not output.is_absolute() or not output.parent.is_dir() or output.parent.is_symlink():
        raise SystemExit("Private absolute receipt path required")
    parent = output.parent.stat()
    import os
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise SystemExit("Receipt parent must be private and owned")
    files = [MODULE_PATH, pathlib.Path(__file__).absolute(), MODULE_PATH.with_name("source-build-policy.json")]
    frozen = {path.name: B.sha(path.read_bytes()) for path in files}
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SourceAssemblyTests)
    inventory = sorted(case.id() for case in suite)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    after = {path.name: B.sha(path.read_bytes()) for path in files}
    successful = result.wasSuccessful() and result.testsRun == len(inventory) and not result.skipped and frozen == after
    receipt = {"schema": "rmd-semgrep-source-assembly-controls/v1", "successful": successful,
               "selected": len(inventory), "executed": result.testsRun,
               "pass": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
               "fail": len(result.failures), "error": len(result.errors), "skipped": len(result.skipped),
               "unrun": len(inventory) - result.testsRun, "literalInventory": inventory,
               "sourceHashes": frozen, "sourceUnchanged": frozen == after,
               "pythonVersion": sys.version.split()[0], "platform": sys.platform,
               "runtimeQualified": False, "dependencyClosureQualified": False, "runnerQualified": False,
               "candidateExecution": False, "pilotDefaultOff": True}
    with output.open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"receipt": str(output), "selected": len(inventory), "successful": successful}))
    raise SystemExit(0 if successful else 1)
