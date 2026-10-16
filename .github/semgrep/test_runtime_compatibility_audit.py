"""Literal-inventory source-module controls, NOT runtime qualification.

Admitted CLI, bound to committed test/fixture/auditor bytes:
  python -I -S test_runtime_compatibility_audit.py --pip-wheel ABSOLUTE_WHEEL \
    --auditor-sha256 REVIEWED_SHA256 --receipt PRIVATE_ABSOLUTE_JSON

Linux Python 3.12 only; the real patch is reported. No download/install/build,
candidate import, production target-loader call or observed-host fallback.
The reviewed auditor digest is mandatory and has no environment/default value.

No selection/filter: require exclusive JSON, exit 0, literal inventory=140,
zero other outcomes, source/tool hashes and invariantErrors=[]. Node wrappers
are separate cases. Historical failed receipts remain immutable.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import stat
import sys
import time
import types
import unittest
import zipfile
from datetime import datetime, timezone

METADATA_TESTS_SHA256 = "6b0fd1ca518efa3fba8773b4398194eeb7e2e55bb53143fbd7e341103b50caa7"
FIXTURES_SHA256 = "66d2d91312ab5006bef72ef6ab2daa2ea8816870e7c6f740ca296d428d58190d"
APPROVED_PIP_SHA = "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"
RAW_CONFIGURATION_NAMES = (
    "pyvenv.cfg", "PyVenv.CfG", "python._pth", "python3._pth",
    "python3.12._pth", "libpython3.12._pth", "other._pth", "OTHER._PTH",
)
GENERATED_CONFIGURATION_NAMES = (
    *(("console_scripts", name) for name in RAW_CONFIGURATION_NAMES),
    ("gui_scripts", "pyvenv.cfg"), ("gui_scripts", "python._pth"),
)
PREPARED_CASE_COUNT = 55
H = None
CONTEXT = None
PREDECESSOR_99_MAIN_REPORT = {
    "attribution": "main-reported historical result; original receipts external and unchanged",
    "selected": 99, "executed": 99, "pass": 95, "fail": 4, "error": 0, "skipped": 0,
    "classification": "deterministic active-extra missing-edge defect, not flaky",
    "failingPolicyMethods": [
        "test_requested_extra_missing_dependency_blocks",
        "test_nested_requested_extra_missing_leaf_blocks",
        "test_cyclic_requested_extras_do_not_hide_missing_leaf",
        "test_second_requester_extra_dependency_cannot_be_lost",
    ],
}

class AuditSyntheticModuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global CONTEXT
        if CONTEXT is None:
            raise AssertionError("main must bind the reviewed source/tool context before tests")
        cls.c = CONTEXT
        cls.p = CONTEXT.auditor
        cls.api = CONTEXT.api

    def setUp(self):
        H.assert_no_candidate_execution(self.c)

    def tearDown(self):
        H.assert_no_candidate_execution(self.c)

    def positive(self, *wheels):
        result = H.audit(self.c, *wheels)
        self.assertEqual(result["state"], "ORIGINAL_METADATA_AND_LAYOUT_AUDIT_ONLY")
        self.assertIs(result["originalMetadataClosure"], True)
        self.assertIs(result["qualified"], False)
        self.assertIs(result["candidateExecutionAllowed"], False)
        return result

    def blocked(self, code, *wheels):
        with self.assertRaises(self.p.AuditBlocked) as raised:
            H.audit(self.c, *wheels)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_real_pip_2621_api_and_raw_metadata_adapter_have_zip_origin(self):
        row = H.scan(self.c, H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"]))
        self.assertIsInstance(row["dist"], self.api.Distribution)
        self.assertEqual(str(row["dist"].version), "1.180.0")
        self.assertEqual([str(r) for r in row["dependencies"]], ["mcp==1.29.0"])
        details = self.api.PackageDetails(row["dist"].version, row["dependencies"])
        missing, conflicting = self.api.check_package_set({"semgrep": details})
        self.assertIn("semgrep", missing)
        self.assertEqual(conflicting, {})
        self.assertEqual(self.api.pip.__version__, "26.2.1")
        self.assertEqual(self.c.provenance["platform"], sys.platform)
        self.assertEqual(self.c.provenance["pythonVersion"], platform.python_version())
        self.assertEqual(sys.platform, "linux")
        self.assertEqual(sys.version_info[:2], (3, 12))
        self.assertIs(self.c.provenance["linuxQualification"], False)

    def test_synthetic_wheel_has_actual_crc_and_byte_correct_record(self):
        fixture = H.wheel("attack", files={"attack/data.txt": b"positive bytes\n"})
        with zipfile.ZipFile(io.BytesIO(fixture.raw)) as archive:
            self.assertIsNone(archive.testzip())
            rows = list(csv.reader(io.StringIO(archive.read(fixture.record_path).decode())))
            self.assertEqual({r[0] for r in rows}, set(archive.namelist()))
            for path, encoded, size in rows:
                if path == fixture.record_path:
                    self.assertEqual((encoded, size), ("", ""))
                else:
                    raw = archive.read(path)
                    expected = base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).rstrip(b"=").decode()
                    self.assertEqual(encoded, "sha256=" + expected)
                    self.assertEqual(size, str(len(raw)))
        self.positive(fixture)

    def test_original_mcp_129_dependency_accepts_129_positive(self):
        self.positive(H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"]), H.wheel("mcp", "1.29.0"))

    def test_original_mcp_129_dependency_rejects_130_negative(self):
        error = self.blocked("DEPENDENCY_CLOSURE", H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"]), H.wheel("mcp", "1.30.0"))
        self.assertIn("mcp", error.detail)
        self.assertIn("1.30.0", error.detail)

    def test_mcp_mutant_preserves_exact_original_semgrep_metadata_bytes(self):
        original = H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"])
        before = hashlib.sha256(original.raw).hexdigest()
        self.positive(original, H.wheel("mcp", "1.29.0"))
        self.blocked("DEPENDENCY_CLOSURE", original, H.wheel("mcp", "1.30.0"))
        self.assertEqual(hashlib.sha256(original.raw).hexdigest(), before)
        self.assertEqual(original.raw, H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"]).raw)

    def test_missing_default_dependency_blocks(self):
        self.blocked("DEPENDENCY_CLOSURE", H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"]))

    def test_inactive_extra_uses_actual_pip_marker_filter(self):
        fixture = H.wheel("semgrep", "1.180.0", ['missing-extra==1.0; extra == "unused"'])
        self.assertEqual(H.scan(self.c, fixture)["dependencies"], [])
        self.positive(fixture)

    def test_actual_current_platform_marker_is_required_not_faked_pinned_target(self):
        requirement = 'missing-platform==1.0; sys_platform == ' + json.dumps(sys.platform)
        self.assertTrue(self.api.Requirement(requirement).marker.evaluate({"extra": ""}))
        self.blocked("DEPENDENCY_CLOSURE", H.wheel("semgrep", "1.180.0", [requirement]))

    def test_other_platform_marker_is_inactive_on_actual_linux(self):
        requirement = 'missing-platform==1.0; sys_platform == "win32"'
        self.assertFalse(self.api.Requirement(requirement).marker.evaluate({"extra": ""}))
        self.positive(H.wheel("semgrep", "1.180.0", [requirement]))

    def test_malformed_requires_dist_raises_real_pip_invalid_requirement(self):
        from pip._vendor.packaging.requirements import InvalidRequirement
        with self.assertRaises(InvalidRequirement):
            H.scan(self.c, H.wheel("semgrep", "1.180.0", ["mcp>=>1.29.0"]))

    def test_direct_url_dependency_is_rejected_without_fetch(self):
        self.blocked("DIRECT_URL_DEPENDENCY", H.wheel("attack", requirements=["mcp @ https://invalid.example/no-request.whl"]))

    def test_root_pth_marker_is_rejected_without_execution(self):
        self.blocked("UNAPPROVED_PTH", H.wheel("attack", files={"attack.pth": H.payload(self.c)}))

    def test_purelib_pth_alias_is_rejected_without_execution(self):
        self.blocked("UNAPPROVED_PTH", H.wheel("attack", files={"attack-1.0.data/purelib/attack.pth": H.payload(self.c)}))

    def test_sitecustomize_marker_is_rejected_without_execution(self):
        self.blocked("STARTUP_CUSTOMIZE", H.wheel("attack", files={"sitecustomize.py": H.payload(self.c)}))

    def test_usercustomize_marker_is_rejected_without_execution(self):
        self.blocked("STARTUP_CUSTOMIZE", H.wheel("attack", files={"usercustomize.py": H.payload(self.c)}))

    def test_ordinary_candidate_module_payload_is_never_imported(self):
        self.positive(H.wheel("attack", files={"attack/__init__.py": H.payload(self.c)}))
        self.assertNotIn("attack", sys.modules)
        self.assertFalse(self.c.marker.exists())

    def test_foreign_package_cannot_overwrite_pip_check_module(self):
        self.blocked("TOOL_NAMESPACE_OVERWRITE", H.wheel("attack", files={"pip/_internal/operations/check.py": H.payload(self.c)}))

    def test_foreign_package_cannot_add_file_to_semgrep_owned_root(self):
        self.blocked("NAMESPACE_OWNERSHIP", H.wheel("semgrep", "1.180.0"), H.wheel("attack", files={"semgrep/forged_version.py": H.payload(self.c)}))

    def test_foreign_package_cannot_shadow_stdlib_email(self):
        self.blocked("STDLIB_OVERWRITE", H.wheel("attack", files={"email/__init__.py": H.payload(self.c)}))

    def test_two_packages_cannot_own_same_destination_file(self):
        self.blocked("DESTINATION_COLLISION", H.wheel("one", files={"shared/file.py": b"# one\n"}), H.wheel("two", files={"shared/file.py": b"# two\n"}))

    def test_same_package_root_and_data_alias_destination_collides(self):
        self.blocked("DESTINATION_COLLISION", H.wheel("attack", files={"attack/file.py": b"# one\n", "attack-1.0.data/platlib/attack/file.py": b"# two\n"}))

    def test_raw_current_python_entrypoint_overwrite_blocks(self):
        command = f"python{sys.version_info.major}.{sys.version_info.minor}"
        self.blocked("RESERVED_ENTRYPOINT", H.wheel("attack", files={"attack-1.0.data/scripts/" + command: H.payload(self.c)}))

    def test_raw_current_pip_entrypoint_overwrite_blocks(self):
        command = f"pip{sys.version_info.major}.{sys.version_info.minor}"
        self.blocked("RESERVED_ENTRYPOINT", H.wheel("attack", files={"attack-1.0.data/scripts/" + command: H.payload(self.c)}))

    def test_foreign_generated_semgrep_entrypoint_blocks(self):
        self.blocked("RESERVED_ENTRYPOINT", H.wheel("attack", entry_points="[console_scripts]\nsemgrep = attack:main\n"))

    def test_generated_entrypoint_collision_between_packages_blocks(self):
        self.blocked("DESTINATION_COLLISION", H.wheel("one", entry_points="[console_scripts]\nshared-command = one:main\n"),
                     H.wheel("two", entry_points="[console_scripts]\nshared-command = two:main\n"))

    def test_unreviewed_shared_namespace_remains_blocked_not_waived(self):
        self.blocked("NAMESPACE_OWNERSHIP", H.wheel("one", files={"namespace/one.py": b"# one\n"}), H.wheel("two", files={"namespace/two.py": b"# two\n"}))
        self.assertEqual(set(self.p.APPROVED_SHARED_NAMESPACES), {"google", "opentelemetry"})
        self.assertNotIn("namespace", self.p.APPROVED_SHARED_NAMESPACES)

    def test_reviewed_namespace_tuples_are_exact_lower_seam_not_artifact_evidence(self):
        for root, identities in self.p.APPROVED_SHARED_NAMESPACES.items():
            for name, version, artifact_sha in identities:
                row = {"name": name, "version": version, "sha256": artifact_sha}
                self.assertTrue(self.p.approved_namespace_contributor(row, root, ("site", root, "child", "__init__.py")))

    def test_reviewed_namespace_rejects_wrong_owner_version_or_whole_artifact_hash(self):
        root = "google"
        name, version, artifact_sha = next(iter(self.p.APPROVED_SHARED_NAMESPACES[root]))
        original = {"name": name, "version": version, "sha256": artifact_sha}
        for field, value in [("name", "attack"), ("version", version + ".1"), ("sha256", "0" * 64)]:
            changed = dict(original, **{field: value})
            self.assertFalse(self.p.approved_namespace_contributor(changed, root, ("site", root, "child.py")))

    def test_reviewed_namespace_rejects_root_module_init_and_case_aliases(self):
        name, version, artifact_sha = next(iter(self.p.APPROVED_SHARED_NAMESPACES["google"]))
        row = {"name": name, "version": version, "sha256": artifact_sha}
        for destination in [("site", "google.py"), ("site", "google", "__init__.py"),
                            ("site", "google", "__INIT__.py"), ("site", "Google", "child.py"),
                            ("bin", "google", "child.py")]:
            self.assertFalse(self.p.approved_namespace_contributor(row, "google", destination))

    def test_unapproved_single_contributor_cannot_claim_a_reviewed_namespace(self):
        self.blocked("UNAPPROVED_NAMESPACE_CONTRIBUTOR", H.wheel("attack", files={"google/child.py": H.payload(self.c)}))

    def test_special_member_exact_tuple_fixture_is_not_original_artifact_proof(self):
        data = H.payload(self.c)
        path = "opentelemetry/instrumentation/auto_instrumentation/sitecustomize.py"
        identity = ("fixture", "1.0", "a" * 64)
        original = self.p.APPROVED_SPECIAL_MEMBERS
        try:
            self.p.APPROVED_SPECIAL_MEMBERS = {identity: {path: (len(data), self.p.digest(data))}}
            self.assertTrue(self.p.approved_special_member(*identity, path, data, ("site", *path.split("/"))))
        finally:
            self.p.APPROVED_SPECIAL_MEMBERS = original

    def test_special_member_rejects_wrong_identity_path_and_body(self):
        data = b"inert tuple control\n"
        path = "setuptools/_vendor/fixture-1.0.dist-info/METADATA"
        identity = ("fixture", "1.0", "a" * 64)
        original = self.p.APPROVED_SPECIAL_MEMBERS
        try:
            self.p.APPROVED_SPECIAL_MEMBERS = {identity: {path: (len(data), self.p.digest(data))}}
            for args in [("other", "1.0", identity[2], path, data), ("fixture", "1.1", identity[2], path, data),
                         ("fixture", "1.0", "b" * 64, path, data), (*identity, path.upper(), data),
                         (*identity, path, data + b"changed")]:
                self.assertFalse(self.p.approved_special_member(*args, ("site", *path.split("/"))))
        finally:
            self.p.APPROVED_SPECIAL_MEMBERS = original

    def test_special_member_rejects_install_scheme_and_case_destination_aliases(self):
        data = b"inert alias control\n"
        path, identity = "setuptools/_vendor/fixture.dist-info/METADATA", ("fixture", "1.0", "a" * 64)
        original = self.p.APPROVED_SPECIAL_MEMBERS
        try:
            self.p.APPROVED_SPECIAL_MEMBERS = {identity: {path: (len(data), self.p.digest(data))}}
            for destination in [("bin", *path.split("/")), ("site", *path.upper().split("/")),
                                ("site", "fixture.data", "purelib", *path.split("/"))]:
                self.assertFalse(self.p.approved_special_member(*identity, path, data, destination))
        finally:
            self.p.APPROVED_SPECIAL_MEMBERS = original

    def test_special_member_default_policy_never_accepts_an_unreviewed_body(self):
        identity, paths = next(iter(self.p.APPROVED_SPECIAL_MEMBERS.items()))
        path = next(iter(paths))
        self.assertFalse(self.p.approved_special_member(*identity, path, b"unreviewed", ("site", *path.split("/"))))
        self.assertFalse(self.p.approved_special_member(*identity, "sitecustomize.py", b"unreviewed", ("site", "sitecustomize.py")))

    def test_default_special_inventory_is_bounded_nested_and_digest_bound(self):
        self.assertEqual(sum(map(len, self.p.APPROVED_SPECIAL_MEMBERS.values())), 83)
        self.assertEqual({identity[0] for identity in self.p.APPROVED_SPECIAL_MEMBERS}, {"setuptools", "opentelemetry-instrumentation"})
        for identity, paths in self.p.APPROVED_SPECIAL_MEMBERS.items():
            self.assertRegex(identity[2], r"^[a-f0-9]{64}$")
            for path, (size, member_sha) in paths.items():
                self.assertGreaterEqual(size, 0)
                self.assertRegex(member_sha, r"^[a-f0-9]{64}$")
                self.assertTrue(path.startswith("setuptools/_vendor/") or path == "opentelemetry/instrumentation/auto_instrumentation/sitecustomize.py")

    def test_default_namespace_inventory_is_two_roots_and_twelve_versioned_artifacts(self):
        self.assertEqual(set(self.p.APPROVED_SHARED_NAMESPACES), {"google", "opentelemetry"})
        self.assertEqual(sum(map(len, self.p.APPROVED_SHARED_NAMESPACES.values())), 12)
        for identities in self.p.APPROVED_SHARED_NAMESPACES.values():
            for name, version, artifact_sha in identities:
                self.assertTrue(name and version)
                self.assertRegex(artifact_sha, r"^[a-f0-9]{64}$")

    def test_archive_parent_traversal_blocks(self):
        self.blocked("ARCHIVE_TRAVERSAL", H.wheel("attack", files={"../pip/__main__.py": H.payload(self.c)}))

    def test_archive_absolute_path_blocks(self):
        self.blocked("ARCHIVE_PATH", H.wheel("attack", files={"/absolute.py": H.payload(self.c)}))

    def test_archive_backslash_path_blocks(self):
        self.blocked("ARCHIVE_PATH", H.wheel("attack", files={"attack\\escape.py": H.payload(self.c)}))

    def test_case_alias_destination_collision_blocks(self):
        self.blocked("DESTINATION_COLLISION", H.wheel("attack", files={"attack/Case.py": b"# one\n", "attack/case.py": b"# two\n"}))

    def test_record_wrong_size_is_not_a_byte_correct_wheel(self):
        self.blocked("RECORD_BYTES", H.wheel("attack", record_mutation=lambda rows: rows[0].__setitem__(2, "99999")))

    def test_record_wrong_hash_is_not_a_byte_correct_wheel(self):
        self.blocked("RECORD_BYTES", H.wheel("attack", record_mutation=lambda rows: rows[0].__setitem__(1, "sha256=" + "A" * 43)))

    def test_record_foreign_destination_blocks(self):
        self.blocked("RECORD_FOREIGN_PATH", H.wheel("attack", record_mutation=lambda rows: rows[0].__setitem__(0, "../pip/__main__.py")))

    def test_archive_symbolic_link_is_not_an_installable_regular_file(self):
        self.blocked("ARCHIVE_SPECIAL_FILE", H.wheel("attack", files={"attack/link.py": b"../../pip/__main__.py"}, modes={"attack/link.py": stat.S_IFLNK | 0o777}))

    def test_metadata_name_cannot_disagree_with_filename(self):
        self.blocked("METADATA_IDENTITY", H.wheel("attack", metadata_bytes=H.metadata("other", "1.0")))

    def test_metadata_version_cannot_disagree_with_filename(self):
        self.blocked("METADATA_IDENTITY", H.wheel("attack", metadata_bytes=H.metadata("attack", "2.0")))

    def test_duplicate_distribution_identity_is_not_a_complete_set(self):
        self.blocked("DUPLICATE_DISTRIBUTION", H.wheel("mcp", "1.29.0"), H.wheel("mcp", "1.30.0"))

    def test_empty_population_is_not_positive_evidence(self):
        with self.assertRaises(self.p.AuditBlocked) as raised:
            self.p.audit_distribution_set([], self.api)
        self.assertEqual(raised.exception.code, "PACKAGE_BOUND")

    def test_exact_setuptools_pth_policy_tuple_positive_is_not_artifact_proof(self):
        self.assertTrue(self.p.approved_setuptools_pth("setuptools", "84.0.0", self.p.APPROVED_TOOLS["setuptools"][1], "distutils-precedence.pth"))

    def test_setuptools_pth_policy_rejects_wrong_owner(self):
        self.assertFalse(self.p.approved_setuptools_pth("attack", "84.0.0", self.p.APPROVED_TOOLS["setuptools"][1], "distutils-precedence.pth"))

    def test_setuptools_pth_policy_rejects_wrong_version(self):
        self.assertFalse(self.p.approved_setuptools_pth("setuptools", "83.0.0", self.p.APPROVED_TOOLS["setuptools"][1], "distutils-precedence.pth"))

    def test_setuptools_pth_policy_rejects_wrong_actual_digest(self):
        self.assertFalse(self.p.approved_setuptools_pth("setuptools", "84.0.0", "0" * 64, "distutils-precedence.pth"))

    def test_setuptools_pth_policy_rejects_data_path_alias(self):
        self.assertFalse(self.p.approved_setuptools_pth("setuptools", "84.0.0", self.p.APPROVED_TOOLS["setuptools"][1], "setuptools-84.0.0.data/purelib/distutils-precedence.pth"))

    def test_synthetic_setuptools_archive_cannot_fake_approved_artifact_digest(self):
        self.blocked("TOOL_ARTIFACT_NOT_APPROVED", H.wheel("setuptools", "84.0.0", files={"distutils-precedence.pth": H.payload(self.c)}))


def additionalCases(H, context):
    """Build the preserved 55 policy cases using the CLI-bound repo context."""

    class AdditionalPolicyCases(unittest.TestCase):
        def setUp(self):
            self.c = context
            self.p = context.auditor
            self.api = context.api
            self.assertEqual(sys.platform, "linux", "no platform substitution")
            self.assertEqual(sys.version_info[:2], (3, 12), "actual patch is recorded, never substituted")
            self.assertTrue(sys.flags.isolated and sys.flags.no_site)
            H.assert_no_candidate_execution(self.c)

        def tearDown(self):
            H.assert_no_candidate_execution(self.c)

        def wheel(self, name, requirements=(), extras=(), files=None, entry_points=None, version="1.0"):
            # Only raw metadata construction. All requirement/marker semantics
            # are evaluated by the actual pinned pip API in the audited module.
            raw = H.metadata(name, version, requirements)
            if extras:
                raw = (raw.rstrip(b"\n") + b"\n" +
                       b"".join(("Provides-Extra: " + extra + "\n").encode("ascii") for extra in extras) + b"\n")
            return H.wheel(name, version, files=files, entry_points=entry_points, metadata_bytes=raw)

        def positive(self, *fixtures, requested=None):
            result = H.audit(self.c, *fixtures)
            self.assertEqual(result["state"], "ORIGINAL_METADATA_AND_LAYOUT_AUDIT_ONLY")
            self.assertIs(result["originalMetadataClosure"], True)
            self.assertIs(result["qualified"], False)
            self.assertIs(result["candidateExecutionAllowed"], False)
            if requested is not None:
                self.assertEqual(result["requestedExtras"], requested)
            return result

        def blocked(self, code, *fixtures, detail=()):
            with self.assertRaises(self.p.AuditBlocked) as raised:
                H.audit(self.c, *fixtures)
            self.assertEqual(raised.exception.code, code)
            for fragment in detail:
                self.assertIn(fragment, raised.exception.detail)
            return raised.exception

        def scan_blocked(self, code, fixture, detail=()):
            # Deliberately stop at scan_wheel: the later distribution-set guard
            # must not mask removal of the archive-ingress policy being tested.
            with self.assertRaises(self.p.AuditBlocked) as raised:
                H.scan(self.c, fixture)
            self.assertEqual(raised.exception.code, code)
            for fragment in detail:
                self.assertIn(fragment, raised.exception.detail)
            return raised.exception

        def metadata_path_blocked(self, path):
            fixture = self.wheel("attack", files={path: H.metadata("pip", "999")})
            self.scan_blocked("FOREIGN_DISTRIBUTION_METADATA", fixture, detail=(path,))

        def extra_pair(self, dependency="leaf==1.0", leaf_version=None):
            fixtures = [self.wheel("one", ["two[cli]==1.0"]),
                        self.wheel("two", [dependency + '; extra == "cli"'], extras=["cli"])]
            if leaf_version is not None:
                fixtures.append(self.wheel("leaf", version=leaf_version))
            return fixtures

        def nested(self, include_leaf):
            # Provider rows deliberately precede their requesters. A single
            # forward pass without requeueing cannot establish this closure.
            fixtures = [self.wheel("three", ['leaf==1.0; extra == "deep"'], extras=["deep"]),
                        self.wheel("two", ['three[deep]==1.0; extra == "cli"'], extras=["cli"]),
                        self.wheel("one", ["two[cli]==1.0"])]
            if include_leaf:
                fixtures.append(self.wheel("leaf"))
            return fixtures

        def cyclic(self, include_leaf):
            fixtures = [self.wheel("two", ['one[loop]==1.0; extra == "cli"'], extras=["cli"]),
                        self.wheel("one", ["two[cli]==1.0", 'leaf==1.0; extra == "loop"'], extras=["loop"])]
            if include_leaf:
                fixtures.append(self.wheel("leaf"))
            return fixtures

        def test_actual_linux312_real_pip_context_not_target_qualification(self):
            self.assertEqual(self.c.provenance["auditorSha256"], self.c.expected_auditor_sha256)
            self.assertEqual(H.PIP_SHA, APPROVED_PIP_SHA)
            self.assertEqual(self.api.pip.__version__, "26.2.1")
            self.assertEqual(self.c.provenance["platform"], "linux")
            self.assertEqual(self.c.provenance["pythonVersion"], platform.python_version())
            self.assertIs(self.c.provenance["linuxQualification"], False)
            self.assertTrue(self.api.pip.__file__.startswith(str(self.c.pip_wheel) + "/pip/"))
            for obj in (self.api.Distribution, self.api.PackageDetails, self.api.check_package_set,
                        self.api.Requirement, self.api.get_console_script_specs):
                self.assertTrue(sys.modules[obj.__module__].__file__.startswith(str(self.c.pip_wheel) + "/pip/"))

        def test_canonical_original_own_metadata_is_still_accepted(self):
            fixture = self.wheel("attack", files={"attack/__init__.py": H.payload(self.c)})
            row = H.scan(self.c, fixture)
            self.assertIn((("site", fixture.info, "METADATA"), fixture.info + "/METADATA", "archive"), row["destinations"])
            self.assertIn((("site", fixture.info, "RECORD"), fixture.info + "/RECORD", "archive"), row["destinations"])
            self.positive(fixture, requested={})

        def test_ordinary_raw_bin_script_remains_inert_and_accepted(self):
            path = "attack-1.0.data/scripts/ordinary-cli"
            fixture = self.wheel("attack", files={path: H.payload(self.c)})
            self.assertIn((("bin", "ordinary-cli"), path, "archive"), H.scan(self.c, fixture)["destinations"])
            self.positive(fixture, requested={})

        def test_ordinary_generated_console_and_gui_commands_remain_accepted(self):
            fixture = self.wheel("attack", entry_points=(
                "[console_scripts]\nordinary-cli = attack:main\n[gui_scripts]\nordinary-gui = attack:main\n"))
            generated = {dest for dest, _source, kind in H.scan(self.c, fixture)["destinations"] if kind == "generated-entrypoint"}
            self.assertEqual(generated, {("bin", "ordinary-cli"), ("bin", "ordinary-gui")})
            self.positive(fixture, requested={})

        def test_ordinary_data_purelib_alias_is_not_blanket_rejected(self):
            self.positive(self.wheel("attack", files={"attack-1.0.data/purelib/attack/ordinary-info.txt": b"inert data\n"}), requested={})

        def test_foreign_purelib_pip_dist_info_metadata_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/purelib/pip-999.dist-info/METADATA")

        def test_foreign_purelib_pip_dist_info_mixed_case_metadata_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/purelib/pip-999.dist-info/Metadata")

        def test_foreign_platlib_dist_info_metadata_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/platlib/pip-999.dist-info/METADATA")

        def test_foreign_case_alias_distribution_metadata_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/purelib/PIP-999.DIST-INFO/Metadata")

        def test_foreign_purelib_egg_info_directory_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/purelib/pip-999.egg-info/PKG-INFO")

        def test_foreign_platlib_egg_info_directory_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/platlib/pip-999.egg-info/PKG-INFO")

        def test_foreign_root_egg_info_file_blocks(self):
            self.metadata_path_blocked("pip-999.egg-info")

        def test_foreign_root_egg_info_directory_blocks(self):
            self.metadata_path_blocked("pip-999.egg-info/PKG-INFO")

        def test_own_purelib_metadata_alias_without_collision_blocks(self):
            # No corresponding top-level EXTRA exists: collision detection alone
            # cannot make this negative pass after removing the metadata guard.
            self.metadata_path_blocked("attack-1.0.data/purelib/attack-1.0.dist-info/EXTRA")

        def test_own_platlib_metadata_alias_without_collision_blocks(self):
            self.metadata_path_blocked("attack-1.0.data/platlib/attack-1.0.dist-info/EXTRA")

        def test_nested_foreign_metadata_below_package_root_blocks(self):
            self.metadata_path_blocked("attack/private/pip-999.dist-info/METADATA")

        def test_unrequested_provided_extra_does_not_activate_missing_dependency(self):
            self.positive(self.wheel("two", ['leaf==1.0; extra == "cli"'], extras=["cli"]), requested={})

        def test_requested_extra_missing_dependency_blocks(self):
            self.blocked("DEPENDENCY_CLOSURE", *self.extra_pair(), detail=("two", "leaf"))

        def test_requested_extra_conflicting_dependency_blocks(self):
            self.blocked("DEPENDENCY_CLOSURE", *self.extra_pair(leaf_version="2.0"), detail=("two", "leaf", "2.0"))

        def test_requested_extra_complete_dependency_set_accepts(self):
            self.positive(*self.extra_pair(leaf_version="1.0"), requested={"two": ["cli"]})

        def test_requested_extra_cannot_drop_empty_extra_default_requirement(self):
            self.blocked("DEPENDENCY_CLOSURE", self.wheel("one", ["two[cli]==1.0"]),
                         self.wheel("two", ['base-dep==1.0; extra == ""', 'extra-dep==1.0; extra == "cli"'], extras=["cli"]),
                         self.wheel("extra-dep"), detail=("two", "base-dep"))

        def test_default_and_requested_extra_contexts_union_accepts_complete_set(self):
            self.positive(self.wheel("one", ["two[cli]==1.0"]),
                          self.wheel("two", ['base-dep==1.0; extra == ""', 'extra-dep==1.0; extra == "cli"'], extras=["cli"]),
                          self.wheel("base-dep"), self.wheel("extra-dep"), requested={"two": ["cli"]})

        def test_two_requesters_union_extras_after_provider_was_processed(self):
            self.positive(self.wheel("two", ['leaf==1.0; extra == "cli"', 'other-leaf==1.0; extra == "gui"'], extras=["cli", "gui"]),
                          self.wheel("one", ["two[cli]==1.0"]), self.wheel("three", ["two[gui]==1.0"]),
                          self.wheel("leaf"), self.wheel("other-leaf"), requested={"two": ["cli", "gui"]})

        def test_second_requester_extra_dependency_cannot_be_lost(self):
            self.blocked("DEPENDENCY_CLOSURE",
                         self.wheel("two", ['leaf==1.0; extra == "cli"', 'other-leaf==1.0; extra == "gui"'], extras=["cli", "gui"]),
                         self.wheel("one", ["two[cli]==1.0"]), self.wheel("three", ["two[gui]==1.0"]), self.wheel("leaf"),
                         detail=("two", "other-leaf"))

        def test_nested_requested_extras_reach_fixed_point(self):
            self.positive(*self.nested(True), requested={"two": ["cli"], "three": ["deep"]})

        def test_nested_requested_extra_missing_leaf_blocks(self):
            self.blocked("DEPENDENCY_CLOSURE", *self.nested(False), detail=("three", "leaf"))

        def test_cyclic_requested_extras_converge_with_complete_leaf(self):
            self.positive(*self.cyclic(True), requested={"one": ["loop"], "two": ["cli"]})

        def test_cyclic_requested_extras_do_not_hide_missing_leaf(self):
            self.blocked("DEPENDENCY_CLOSURE", *self.cyclic(False), detail=("one", "leaf"))

        def test_unknown_requested_extra_is_not_waived_by_another_provided_extra(self):
            self.blocked("UNKNOWN_REQUESTED_EXTRA", self.wheel("one", ["two[unknown]==1.0"]),
                         self.wheel("two", extras=["cli"]), detail=("two",))

        def test_unknown_requested_extra_without_any_provided_extra_blocks(self):
            self.blocked("UNKNOWN_REQUESTED_EXTRA", self.wheel("one", ["two[cli]==1.0"]), self.wheel("two"), detail=("two",))

        def test_requested_extra_normalization_uses_real_pip_metadata_api(self):
            self.positive(self.wheel("one", ["two[FAST_Mode]==1.0"]),
                          self.wheel("two", ['leaf==1.0; extra == "fast-mode"'], extras=["fast-mode"]),
                          self.wheel("leaf"), requested={"two": ["fast-mode"]})

        def test_inactive_darwin_requirement_does_not_request_extra_on_actual_linux(self):
            requirement = 'two[unknown]==1.0; sys_platform == "darwin"'
            self.assertFalse(self.api.Requirement(requirement).marker.evaluate({"extra": ""}))
            self.positive(self.wheel("one", [requirement]), self.wheel("two"), requested={})

        def test_exactly_256_requested_extras_are_accepted(self):
            names = [f"e{i:03d}" for i in range(256)]
            self.positive(self.wheel("one", ["two[" + ",".join(names) + "]==1.0"]),
                          self.wheel("two", extras=names), requested={"two": names})

        def test_257_requested_extras_fail_closed(self):
            names = [f"e{i:03d}" for i in range(257)]
            self.blocked("REQUESTED_EXTRA_BOUND", self.wheel("one", ["two[" + ",".join(names) + "]==1.0"]),
                         self.wheel("two", extras=names), detail=("two",))

        def test_exactly_256_requested_extras_across_providers_are_accepted(self):
            names = [f"e{i:03d}" for i in range(128)]
            self.positive(self.wheel("one", ["two[" + ",".join(names) + "]==1.0", "three[" + ",".join(names) + "]==1.0"]),
                          self.wheel("two", extras=names), self.wheel("three", extras=names),
                          requested={"two": names, "three": names})

        def test_aggregate_257_requested_extras_fail_closed(self):
            left = [f"e{i:03d}" for i in range(128)]
            right = [f"e{i:03d}" for i in range(129)]
            self.blocked("REQUESTED_EXTRA_BOUND",
                         self.wheel("one", ["two[" + ",".join(left) + "]==1.0", "three[" + ",".join(right) + "]==1.0"]),
                         self.wheel("two", extras=left), self.wheel("three", extras=right), detail=("three",))

        def test_repeated_requests_do_not_double_count_the_256_extra_bound(self):
            names = [f"e{i:03d}" for i in range(256)]
            requirement = "two[" + ",".join(names) + "]==1.0"
            self.positive(self.wheel("two", extras=names), self.wheel("one", [requirement]),
                          self.wheel("three", [requirement]), requested={"two": names})

    def raw_case(command):
        def test(self):
            path = "attack-1.0.data/scripts/" + command
            fixture = self.wheel("attack", files={path: H.payload(self.c)})
            self.scan_blocked("INTERPRETER_CONFIGURATION", fixture, detail=(path,))
        return test

    def generated_case(group, command):
        def test(self):
            fixture = self.wheel("attack", entry_points="[" + group + "]\n" + command + " = attack:main\n")
            # Prove this is an actually generated destination, not an archive
            # ingress rejection or an invalid entrypoint fixture.
            row = H.scan(self.c, fixture)
            self.assertIn((("bin", command), fixture.info + "/entry_points.txt", "generated-entrypoint"), row["destinations"])
            self.blocked("INTERPRETER_CONFIGURATION", fixture, detail=(command.lower(),))
        return test

    for index, command in enumerate(RAW_CONFIGURATION_NAMES):
        setattr(AdditionalPolicyCases, f"test_raw_configuration_{index:02d}_blocks_at_archive_ingress", raw_case(command))
    for index, (group, command) in enumerate(GENERATED_CONFIGURATION_NAMES):
        setattr(AdditionalPolicyCases, f"test_generated_configuration_{index:02d}_blocks_at_distribution_boundary", generated_case(group, command))
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(AdditionalPolicyCases)
    if suite.countTestCases() != PREPARED_CASE_COUNT:
        raise AssertionError("prepared policy-case inventory changed; main must reconcile explicit selection")
    return suite


class AuditLoaderMarkerRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if CONTEXT is None or H is None:
            raise AssertionError("reviewed CLI bootstrap is mandatory")
        cls.c, cls.p, cls.api = CONTEXT, CONTEXT.auditor, CONTEXT.api

    def setUp(self):
        H.assert_no_candidate_execution(self.c)

    def tearDown(self):
        H.assert_no_candidate_execution(self.c)
        H.assert_frozen_inputs(self.c)

    def extra_rows(self, include_leaf):
        fixtures = [H.wheel("one", requirements=["two[cli]==1.0"]),
                    H.wheel("two", metadata_bytes=H.metadata("two", "1.0", [
                        'leaf==1.0; extra == "cli"',
                        'one==1.0; sys_platform == "linux"',
                    ], provided_extras=["cli"]))]
        if include_leaf:
            fixtures.append(H.wheel("leaf"))
        return [H.scan(self.c, fixture) for fixture in fixtures]

    def row_snapshot(self, rows):
        return [(row["metadata"], [
            (id(req), str(req), id(req.marker), str(req.marker)) for req in row["dependencies"]
        ]) for row in rows]

    def test_wrong_reviewed_auditor_hash_refuses_without_fallback(self):
        with self.assertRaisesRegex(AssertionError, "auditor SHA-256 mismatch"):
            H.load_auditor("0" * 64)

    def test_malformed_reviewed_auditor_hash_refuses(self):
        for invalid in (None, "", "ABCDEF" * 10 + "ABCD", "0" * 63, "../auditor.py"):
            with self.assertRaisesRegex(AssertionError, "explicit reviewed auditor SHA-256"):
                H.load_auditor(invalid)

    def test_successful_extra_audit_preserves_source_metadata_and_cached_requirements(self):
        rows = self.extra_rows(True)
        before = self.row_snapshot(rows)
        auditor_before = H.stable_regular(self.c.auditor_path, 65536)
        result = self.p.audit_distribution_set(rows, self.api)
        self.assertIs(result["originalMetadataClosure"], True)
        self.assertEqual(result["requestedExtras"], {"two": ["cli"]})
        self.assertEqual(self.row_snapshot(rows), before)
        self.assertEqual(H.stable_regular(self.c.auditor_path, 65536), auditor_before)
        self.assertEqual(H.sha(auditor_before), self.c.expected_auditor_sha256)

    def test_denied_extra_audit_preserves_source_metadata_and_cached_requirements(self):
        rows = self.extra_rows(False)
        before = self.row_snapshot(rows)
        auditor_before = H.stable_regular(self.c.auditor_path, 65536)
        with self.assertRaises(self.p.AuditBlocked) as raised:
            self.p.audit_distribution_set(rows, self.api)
        self.assertEqual(raised.exception.code, "DEPENDENCY_CLOSURE")
        self.assertIn("leaf", raised.exception.detail)
        self.assertEqual(self.row_snapshot(rows), before)
        self.assertEqual(H.stable_regular(self.c.auditor_path, 65536), auditor_before)

    def test_unrequested_extra_marker_stays_inactive_when_another_extra_is_active(self):
        rows = [H.scan(self.c, fixture) for fixture in (
            H.wheel("one", requirements=["two[cli]==1.0"]),
            H.wheel("two", metadata_bytes=H.metadata("two", "1.0", [
                'leaf==1.0; extra == "cli"', 'missing-unused==1.0; extra == "unused"',
            ], provided_extras=["cli", "unused"])),
            H.wheel("leaf"),
        )]
        result = self.p.audit_distribution_set(rows, self.api)
        self.assertIs(result["originalMetadataClosure"], True)
        self.assertEqual(result["requestedExtras"], {"two": ["cli"]})

    def test_inactive_platform_marker_within_requested_extra_stays_inactive(self):
        requirement = 'missing-platform==1.0; extra == "cli" and sys_platform == "darwin"'
        self.assertFalse(self.api.Requirement(requirement).marker.evaluate({"extra": "cli"}))
        rows = [H.scan(self.c, fixture) for fixture in (
            H.wheel("one", requirements=["two[cli]==1.0"]),
            H.wheel("two", metadata_bytes=H.metadata("two", "1.0", [
                requirement, 'leaf==1.0; extra == "cli"',
            ], provided_extras=["cli"])),
            H.wheel("leaf"),
        )]
        result = self.p.audit_distribution_set(rows, self.api)
        self.assertIs(result["originalMetadataClosure"], True)
        self.assertEqual(result["requestedExtras"], {"two": ["cli"]})

    def test_real_pip_missing_branch_rechecks_extra_marker_and_copy_is_independent(self):
        original = self.api.Requirement('leaf==1.0; extra == "cli"')
        before = str(original)
        missing, conflicting = self.api.check_package_set({
            "one": self.api.PackageDetails(self.api.Version("1.0"), [original]),
        })
        self.assertEqual((missing, conflicting), ({}, {}))
        active = self.api.Requirement(str(original))
        self.assertIsNot(active, original)
        self.assertIsNot(active.marker, original.marker)
        active.marker = None
        missing, conflicting = self.api.check_package_set({
            "one": self.api.PackageDetails(self.api.Version("1.0"), [active]),
        })
        self.assertIn("one", missing)
        self.assertIn("leaf", repr(missing))
        self.assertEqual(conflicting, {})
        self.assertEqual(str(original), before)
        self.assertIsNotNone(original.marker)

    def test_pinned_pip_archive_bytes_and_every_imported_api_origin_stay_approved(self):
        raw = H.stable_regular(self.c.pip_wheel, 2 << 20)
        self.assertEqual(len(raw), H.PIP_BYTES)
        self.assertEqual(H.sha(raw), APPROVED_PIP_SHA)
        for obj in (self.api.Distribution, self.api.PackageDetails, self.api.check_package_set,
                    self.api.Requirement, self.api.get_console_script_specs):
            self.assertTrue(sys.modules[obj.__module__].__file__.startswith(str(self.c.pip_wheel) + "/pip/"))


# Literal inventory, independent of discovery. Additions/removals require review.
EXPECTED_TEST_IDS = (
    "AdditionalPolicyCases.test_257_requested_extras_fail_closed",
    "AdditionalPolicyCases.test_actual_linux312_real_pip_context_not_target_qualification",
    "AdditionalPolicyCases.test_aggregate_257_requested_extras_fail_closed",
    "AdditionalPolicyCases.test_canonical_original_own_metadata_is_still_accepted",
    "AdditionalPolicyCases.test_cyclic_requested_extras_converge_with_complete_leaf",
    "AdditionalPolicyCases.test_cyclic_requested_extras_do_not_hide_missing_leaf",
    "AdditionalPolicyCases.test_default_and_requested_extra_contexts_union_accepts_complete_set",
    "AdditionalPolicyCases.test_exactly_256_requested_extras_across_providers_are_accepted",
    "AdditionalPolicyCases.test_exactly_256_requested_extras_are_accepted",
    "AdditionalPolicyCases.test_foreign_case_alias_distribution_metadata_blocks",
    "AdditionalPolicyCases.test_foreign_platlib_dist_info_metadata_blocks",
    "AdditionalPolicyCases.test_foreign_platlib_egg_info_directory_blocks",
    "AdditionalPolicyCases.test_foreign_purelib_egg_info_directory_blocks",
    "AdditionalPolicyCases.test_foreign_purelib_pip_dist_info_metadata_blocks",
    "AdditionalPolicyCases.test_foreign_purelib_pip_dist_info_mixed_case_metadata_blocks",
    "AdditionalPolicyCases.test_foreign_root_egg_info_directory_blocks",
    "AdditionalPolicyCases.test_foreign_root_egg_info_file_blocks",
    "AdditionalPolicyCases.test_generated_configuration_00_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_01_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_02_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_03_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_04_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_05_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_06_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_07_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_08_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_generated_configuration_09_blocks_at_distribution_boundary",
    "AdditionalPolicyCases.test_inactive_darwin_requirement_does_not_request_extra_on_actual_linux",
    "AdditionalPolicyCases.test_nested_foreign_metadata_below_package_root_blocks",
    "AdditionalPolicyCases.test_nested_requested_extra_missing_leaf_blocks",
    "AdditionalPolicyCases.test_nested_requested_extras_reach_fixed_point",
    "AdditionalPolicyCases.test_ordinary_data_purelib_alias_is_not_blanket_rejected",
    "AdditionalPolicyCases.test_ordinary_generated_console_and_gui_commands_remain_accepted",
    "AdditionalPolicyCases.test_ordinary_raw_bin_script_remains_inert_and_accepted",
    "AdditionalPolicyCases.test_own_platlib_metadata_alias_without_collision_blocks",
    "AdditionalPolicyCases.test_own_purelib_metadata_alias_without_collision_blocks",
    "AdditionalPolicyCases.test_raw_configuration_00_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_01_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_02_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_03_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_04_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_05_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_06_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_raw_configuration_07_blocks_at_archive_ingress",
    "AdditionalPolicyCases.test_repeated_requests_do_not_double_count_the_256_extra_bound",
    "AdditionalPolicyCases.test_requested_extra_cannot_drop_empty_extra_default_requirement",
    "AdditionalPolicyCases.test_requested_extra_complete_dependency_set_accepts",
    "AdditionalPolicyCases.test_requested_extra_conflicting_dependency_blocks",
    "AdditionalPolicyCases.test_requested_extra_missing_dependency_blocks",
    "AdditionalPolicyCases.test_requested_extra_normalization_uses_real_pip_metadata_api",
    "AdditionalPolicyCases.test_second_requester_extra_dependency_cannot_be_lost",
    "AdditionalPolicyCases.test_two_requesters_union_extras_after_provider_was_processed",
    "AdditionalPolicyCases.test_unknown_requested_extra_is_not_waived_by_another_provided_extra",
    "AdditionalPolicyCases.test_unknown_requested_extra_without_any_provided_extra_blocks",
    "AdditionalPolicyCases.test_unrequested_provided_extra_does_not_activate_missing_dependency",
    "AuditLoaderMarkerRegressions.test_denied_extra_audit_preserves_source_metadata_and_cached_requirements",
    "AuditLoaderMarkerRegressions.test_inactive_platform_marker_within_requested_extra_stays_inactive",
    "AuditLoaderMarkerRegressions.test_malformed_reviewed_auditor_hash_refuses",
    "AuditLoaderMarkerRegressions.test_pinned_pip_archive_bytes_and_every_imported_api_origin_stay_approved",
    "AuditLoaderMarkerRegressions.test_real_pip_missing_branch_rechecks_extra_marker_and_copy_is_independent",
    "AuditLoaderMarkerRegressions.test_successful_extra_audit_preserves_source_metadata_and_cached_requirements",
    "AuditLoaderMarkerRegressions.test_unrequested_extra_marker_stays_inactive_when_another_extra_is_active",
    "AuditLoaderMarkerRegressions.test_wrong_reviewed_auditor_hash_refuses_without_fallback",
    "AuditSyntheticModuleTests.test_actual_current_platform_marker_is_required_not_faked_pinned_target",
    "AuditSyntheticModuleTests.test_archive_absolute_path_blocks",
    "AuditSyntheticModuleTests.test_archive_backslash_path_blocks",
    "AuditSyntheticModuleTests.test_archive_parent_traversal_blocks",
    "AuditSyntheticModuleTests.test_archive_symbolic_link_is_not_an_installable_regular_file",
    "AuditSyntheticModuleTests.test_case_alias_destination_collision_blocks",
    "AuditSyntheticModuleTests.test_cross_project_exclusive_import_cannot_shadow_namespace",
    "AuditSyntheticModuleTests.test_cross_project_exclusive_import_claims_cannot_collide",
    "AuditSyntheticModuleTests.test_cross_project_exclusive_import_prefixes_cannot_shadow",
    "AuditSyntheticModuleTests.test_default_namespace_inventory_is_two_roots_and_twelve_versioned_artifacts",
    "AuditSyntheticModuleTests.test_default_special_inventory_is_bounded_nested_and_digest_bound",
    "AuditSyntheticModuleTests.test_direct_url_dependency_is_rejected_without_fetch",
    "AuditSyntheticModuleTests.test_duplicate_distribution_identity_is_not_a_complete_set",
    "AuditSyntheticModuleTests.test_dynamic_identity_fields_and_unknown_origin_remain_blocked",
    "AuditSyntheticModuleTests.test_empty_population_is_not_positive_evidence",
    "AuditSyntheticModuleTests.test_exact_setuptools_pth_policy_tuple_positive_is_not_artifact_proof",
    "AuditSyntheticModuleTests.test_exclusive_namespace_child_can_coexist_with_shared_parent_metadata",
    "AuditSyntheticModuleTests.test_foreign_generated_semgrep_entrypoint_blocks",
    "AuditSyntheticModuleTests.test_foreign_package_cannot_add_file_to_semgrep_owned_root",
    "AuditSyntheticModuleTests.test_foreign_package_cannot_overwrite_pip_check_module",
    "AuditSyntheticModuleTests.test_foreign_package_cannot_shadow_stdlib_email",
    "AuditSyntheticModuleTests.test_generated_entrypoint_collision_between_packages_blocks",
    "AuditSyntheticModuleTests.test_import_declaration_work_is_bounded_per_project_and_whole_set",
    "AuditSyntheticModuleTests.test_import_declarations_require_the_reviewed_metadata_version",
    "AuditSyntheticModuleTests.test_import_metadata_does_not_waive_tool_namespace_protection",
    "AuditSyntheticModuleTests.test_import_parser_accepts_private_unicode_and_dotted_names_as_data",
    "AuditSyntheticModuleTests.test_import_parser_distinguishes_empty_exclusive_and_namespace_fields",
    "AuditSyntheticModuleTests.test_import_parser_refuses_invalid_names_and_private_markers",
    "AuditSyntheticModuleTests.test_inactive_extra_uses_actual_pip_marker_filter",
    "AuditSyntheticModuleTests.test_malformed_requires_dist_raises_real_pip_invalid_requirement",
    "AuditSyntheticModuleTests.test_mcp_mutant_preserves_exact_original_semgrep_metadata_bytes",
    "AuditSyntheticModuleTests.test_metadata25_final_dependency_closure_still_blocks",
    "AuditSyntheticModuleTests.test_metadata25_final_requires_python_still_blocks",
    "AuditSyntheticModuleTests.test_metadata25_preserves_raw_bytes_and_final_import_declarations",
    "AuditSyntheticModuleTests.test_metadata_name_cannot_disagree_with_filename",
    "AuditSyntheticModuleTests.test_metadata_unsupported_versions_remain_explicit_refusals",
    "AuditSyntheticModuleTests.test_metadata_version_cannot_disagree_with_filename",
    "AuditSyntheticModuleTests.test_missing_default_dependency_blocks",
    "AuditSyntheticModuleTests.test_namespace_metadata_does_not_waive_actual_archive_ownership",
    "AuditSyntheticModuleTests.test_ordinary_candidate_module_payload_is_never_imported",
    "AuditSyntheticModuleTests.test_original_mcp_129_dependency_accepts_129_positive",
    "AuditSyntheticModuleTests.test_original_mcp_129_dependency_rejects_130_negative",
    "AuditSyntheticModuleTests.test_other_platform_marker_is_inactive_on_actual_linux",
    "AuditSyntheticModuleTests.test_purelib_pth_alias_is_rejected_without_execution",
    "AuditSyntheticModuleTests.test_raw_current_pip_entrypoint_overwrite_blocks",
    "AuditSyntheticModuleTests.test_raw_current_python_entrypoint_overwrite_blocks",
    "AuditSyntheticModuleTests.test_real_pip_2621_api_and_raw_metadata_adapter_have_zip_origin",
    "AuditSyntheticModuleTests.test_record_foreign_destination_blocks",
    "AuditSyntheticModuleTests.test_record_wrong_hash_is_not_a_byte_correct_wheel",
    "AuditSyntheticModuleTests.test_record_wrong_size_is_not_a_byte_correct_wheel",
    "AuditSyntheticModuleTests.test_reviewed_namespace_rejects_root_module_init_and_case_aliases",
    "AuditSyntheticModuleTests.test_reviewed_namespace_rejects_wrong_owner_version_or_whole_artifact_hash",
    "AuditSyntheticModuleTests.test_reviewed_namespace_tuples_are_exact_lower_seam_not_artifact_evidence",
    "AuditSyntheticModuleTests.test_root_pth_marker_is_rejected_without_execution",
    "AuditSyntheticModuleTests.test_same_package_root_and_data_alias_destination_collides",
    "AuditSyntheticModuleTests.test_same_project_exclusive_parent_and_namespace_child_are_not_ambiguous",
    "AuditSyntheticModuleTests.test_same_project_import_name_namespace_ambiguity_blocks",
    "AuditSyntheticModuleTests.test_sdist_dynamic_dependencies_remain_blocked_before_build",
    "AuditSyntheticModuleTests.test_sdist_dynamic_import_fields_remain_blocked_before_build",
    "AuditSyntheticModuleTests.test_setuptools_pth_policy_rejects_data_path_alias",
    "AuditSyntheticModuleTests.test_setuptools_pth_policy_rejects_wrong_actual_digest",
    "AuditSyntheticModuleTests.test_setuptools_pth_policy_rejects_wrong_owner",
    "AuditSyntheticModuleTests.test_setuptools_pth_policy_rejects_wrong_version",
    "AuditSyntheticModuleTests.test_sitecustomize_marker_is_rejected_without_execution",
    "AuditSyntheticModuleTests.test_special_member_default_policy_never_accepts_an_unreviewed_body",
    "AuditSyntheticModuleTests.test_special_member_exact_tuple_fixture_is_not_original_artifact_proof",
    "AuditSyntheticModuleTests.test_special_member_rejects_install_scheme_and_case_destination_aliases",
    "AuditSyntheticModuleTests.test_special_member_rejects_wrong_identity_path_and_body",
    "AuditSyntheticModuleTests.test_synthetic_setuptools_archive_cannot_fake_approved_artifact_digest",
    "AuditSyntheticModuleTests.test_synthetic_wheel_has_actual_crc_and_byte_correct_record",
    "AuditSyntheticModuleTests.test_two_packages_cannot_own_same_destination_file",
    "AuditSyntheticModuleTests.test_unapproved_single_contributor_cannot_claim_a_reviewed_namespace",
    "AuditSyntheticModuleTests.test_unreviewed_shared_namespace_remains_blocked_not_waived",
    "AuditSyntheticModuleTests.test_usercustomize_marker_is_rejected_without_execution",
    "AuditSyntheticModuleTests.test_wheel_dynamic_dependency_is_final_and_original_bytes_are_preserved",
    "AuditSyntheticModuleTests.test_wheel_dynamic_import_field_still_enforces_final_syntax",
    "AuditSyntheticModuleTests.test_wheel_dynamic_python_still_enforces_final_requires_python",
)
EXPECTED_TEST_COUNT = 140


def canonical_id(test):
    return type(test).__name__ + "." + test._testMethodName


def flatten_suite(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten_suite(item)
        else:
            yield item


def build_suite():
    first = unittest.defaultTestLoader.loadTestsFromTestCase(AuditSyntheticModuleTests)
    second = additionalCases(H, CONTEXT)
    third = unittest.defaultTestLoader.loadTestsFromTestCase(AuditLoaderMarkerRegressions)
    if (first.countTestCases(), second.countTestCases(), third.countTestCases()) != (77, 55, 8):
        raise AssertionError("77+55+8 exact-layout/metadata inventory changed")
    suite = unittest.TestSuite([first, second, third])
    actual = tuple(sorted(canonical_id(test) for test in flatten_suite(suite)))
    if len(EXPECTED_TEST_IDS) != EXPECTED_TEST_COUNT or len(set(EXPECTED_TEST_IDS)) != EXPECTED_TEST_COUNT:
        raise AssertionError("literal inventory is incomplete or duplicated")
    if actual != EXPECTED_TEST_IDS:
        raise AssertionError("discovered IDs differ from literal inventory")
    return suite


class InventoryResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started_ids, self.success_ids = [], []

    def startTest(self, test):
        self.started_ids.append(canonical_id(test))
        super().startTest(test)

    def addSuccess(self, test):
        self.success_ids.append(canonical_id(test))
        super().addSuccess(test)


def read_regular(path, limit):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or path.is_symlink() or not 0 < before.st_size <= limit:
        raise AssertionError("bounded nonempty regular source required: " + str(path))
    raw = path.read_bytes()
    after = path.lstat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, len(raw), after.st_mtime_ns, after.st_ctime_ns):
        raise AssertionError("source changed during read: " + str(path))
    return raw


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def json_once(path, value):
    with path.open("xb") as sink:
        sink.write((json.dumps(value, sort_keys=True, indent=2) + "\n").encode())
        sink.flush()
        os.fsync(sink.fileno())


def main():
    global H, CONTEXT
    parser = argparse.ArgumentParser(description="140 literal-inventory source-module controls; no runtime qualification")
    parser.add_argument("--pip-wheel", required=True, type=pathlib.Path)
    parser.add_argument("--auditor-sha256", required=True, help="reviewed workflow/controller literal, never computed as an approval")
    parser.add_argument("--receipt", required=True, type=pathlib.Path, help="new JSON in an existing private neutral directory")
    args = parser.parse_args()
    receipt = args.receipt
    # Refuse overwrite and unsafe receipt destinations; never silently reuse a
    # prior native result. The controller owns creation/retention of this parent.
    parent = receipt.parent
    if (not receipt.is_absolute() or receipt.suffix != ".json" or receipt.exists() or receipt.is_symlink() or
            not parent.is_dir() or parent.is_symlink() or parent.stat().st_uid != os.getuid() or
            parent.stat().st_mode & 0o077 or re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", receipt.name) is None):
        parser.error("receipt must be a NEW bounded JSON basename in an existing owned private absolute directory")
    started, clock = datetime.now(timezone.utc).isoformat(), time.monotonic()
    result, invariant_errors, snapshots = None, [], {}
    sys.dont_write_bytecode = True
    path = pathlib.Path(__file__).absolute()
    fixture_path = path.with_name("runtime_audit_test_fixtures.py")
    auditor_path = path.with_name("runtime-compatibility-audit.py")
    metadata_tests_path = path.with_name("runtime_audit_metadata_tests.py")
    try:
        if not (sys.flags.isolated and sys.flags.no_site and sys.platform == "linux" and sys.version_info[:2] == (3, 12)):
            raise AssertionError("actual Linux Python 3.12 -I -S required; no substituted runtime")
        if re.fullmatch(r"[a-f0-9]{64}", args.auditor_sha256) is None:
            raise AssertionError("explicit reviewed auditor SHA-256 required")
        for source, limit in ((path, 262144), (fixture_path, 65536), (auditor_path, 65536), (metadata_tests_path, 65536)):
            snapshots[source] = read_regular(source, limit)
        raw = snapshots[fixture_path]
        if digest(raw) != FIXTURES_SHA256:
            raise AssertionError("repo fixture source SHA-256 mismatch")
        H = types.ModuleType("_repo_semgrep_audit_fixtures")
        H.__file__ = str(fixture_path)
        exec(compile(raw, str(fixture_path), "exec", dont_inherit=True), H.__dict__)
        CONTEXT = H.load_context(args.pip_wheel, args.auditor_sha256, parent, receipt.name + ".candidate-must-not-execute")
        raw_cases = snapshots[metadata_tests_path]
        if digest(raw_cases) != METADATA_TESTS_SHA256:
            raise AssertionError("repo metadata test source SHA-256 mismatch")
        metadata_cases = types.ModuleType("_repo_semgrep_metadata_controls")
        metadata_cases.__file__ = str(metadata_tests_path)
        exec(compile(raw_cases, str(metadata_tests_path), "exec", dont_inherit=True), metadata_cases.__dict__)
        metadata_cases.attach_metadata_cases(AuditSyntheticModuleTests, H)
        suite = build_suite()
        result = unittest.TextTestRunner(verbosity=2, resultclass=InventoryResult).run(suite)
    except Exception as error:
        invariant_errors.append("BOOTSTRAP_OR_RUN_REFUSAL: " + repr(error)[:4000])
    finally:
        if CONTEXT is not None:
            try:
                H.assert_no_candidate_execution(CONTEXT)
                H.assert_frozen_inputs(CONTEXT)
            except Exception as error:
                invariant_errors.append("CONTEXT_INVARIANT: " + repr(error)[:4000])
        for source, raw in snapshots.items():
            try:
                if read_regular(source, 262144) != raw:
                    raise AssertionError("source bytes changed: " + str(source))
            except Exception as error:
                invariant_errors.append("SOURCE_INVARIANT: " + repr(error)[:4000])
    executed = result.testsRun if result is not None else 0
    started_ids = result.started_ids if result is not None else []
    success_ids = result.success_ids if result is not None else []
    full_inventory = (tuple(sorted(started_ids)) == EXPECTED_TEST_IDS and len(set(started_ids)) == EXPECTED_TEST_COUNT)
    successful_inventory = tuple(sorted(success_ids)) == EXPECTED_TEST_IDS
    execution_complete = bool(result is not None and executed == EXPECTED_TEST_COUNT and full_inventory)
    closed = bool(result is not None and result.wasSuccessful() and executed == EXPECTED_TEST_COUNT and
                  full_inventory and successful_inventory and
                  not result.failures and not result.errors and not result.skipped and
                  not result.expectedFailures and not result.unexpectedSuccesses and not invariant_errors)
    report = {
        "schema": "semgrep-audit-unit-controls/v1",
        "state": "SOURCE_MODULE_CONTROLS_PASS" if closed else ("REFUSED_NOT_RUN" if result is None else "FAILED_OR_INCOMPLETE"),
        "startedAt": started, "closedAt": datetime.now(timezone.utc).isoformat(),
        "durationMs": round((time.monotonic() - clock) * 1000),
        "selected": EXPECTED_TEST_COUNT, "executed": executed,
        "unrun": max(0, EXPECTED_TEST_COUNT - executed), "pass": len(success_ids),
        "fail": len(result.failures) if result is not None else 0,
        "error": len(result.errors) if result is not None else 0,
        "skipped": len(result.skipped) if result is not None else 0,
        "expectedFailures": len(result.expectedFailures) if result is not None else 0,
        "unexpectedSuccesses": len(result.unexpectedSuccesses) if result is not None else 0,
        "complete": execution_complete, "successful": closed, "inventoryClosed": full_inventory,
        "successfulInventoryClosed": successful_inventory, "invariantErrors": invariant_errors,
        "literalInventory": list(EXPECTED_TEST_IDS), "executedIds": started_ids, "successfulIds": success_ids,
        "inventorySha256": digest(("\n".join(EXPECTED_TEST_IDS) + "\n").encode()),
        "sourceHashes": {source.name: digest(raw) for source, raw in snapshots.items()},
        "expectedAuditorSha256": args.auditor_sha256,
        "pipWheelSha256": CONTEXT.provenance["pipWheelSha256"] if CONTEXT is not None else None,
        "platform": sys.platform, "pythonVersion": platform.python_version(), "pythonFull": sys.version,
        "executable": sys.executable, "machine": platform.machine(),
        "isolated": bool(sys.flags.isolated), "noSite": bool(sys.flags.no_site),
        "qualified": False, "linuxQualification": False, "pinnedRuntimeQualified": False,
        "runnerQualified": False, "realArtifactCompatibility": "UNKNOWN", "workflowQualification": "UNKNOWN",
        "exactTargetPatchObserved": sys.platform == "linux" and sys.version_info[:3] == (3, 12, 15),
        "provenance": CONTEXT.provenance if CONTEXT is not None else None,
        "predecessor99MainReport": PREDECESSOR_99_MAIN_REPORT,
        "failures": [{"test": test.id(), "traceback": trace[:12000]} for test, trace in result.failures] if result is not None else [],
        "errors": [{"test": test.id(), "traceback": trace[:12000]} for test, trace in result.errors] if result is not None else [],
        "limits": ["synthetic source-module controls only", "no production target loader", "no build/install/network",
                   "no scanner or real-artifact positive", "no constrained runner/workflow/full-author/pilot qualification"],
    }
    json_once(receipt, report)
    print(json.dumps({"receipt": str(receipt), "state": report["state"], "selected": EXPECTED_TEST_COUNT,
                      "executed": executed, "complete": closed}), flush=True)
    return 0 if closed else 1


if __name__ == "__main__":
    raise SystemExit(main())
