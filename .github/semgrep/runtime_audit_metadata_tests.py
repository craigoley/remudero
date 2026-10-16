"""Hash-bound metadata controls; candidate bytes are data, never imported.

Attached methods retain the literal AuditSyntheticModuleTests identities. Lower
parser positives do not establish importability or real-artifact compatibility.
The real stdlib venv-creation child covers the default seam, not child exact-target
runtime parity, installed candidate behavior or constrained-runner qualification.
"""
import base64
import csv
import hashlib
import io
import pathlib
import platform
import os
import sys
import tempfile
import zipfile
from unittest.mock import patch


def attach_metadata_cases(case, H):
    class MetadataCases:
        # Moved intact from the main file; attachment preserves all three IDs.
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

        def recipe(self):
            return self.p._source_recipe()

        def recipe_pins(self):
            r = self.recipe()
            return {"semgrep": (r.SOURCE_VERSION, r.SOURCE_WHEEL_SHA256), "mcp": r.MCP_PIN}

        def recipe_receipt(self):
            r = self.recipe()
            # Synthetic CLAIM fixture only; no real wheel/install qualification.
            return {"schema": "rmd-semgrep-source-assembly/v1",
                    "state": "SOURCE_ASSEMBLED_NOT_RUNTIME_QUALIFIED", "wheel": r.SOURCE_WHEEL,
                    "wheelSha256": r.SOURCE_WHEEL_SHA256, "buildProfile": dict(r.ASSEMBLY_PROFILE),
                    "builderSha256": r.ASSEMBLER_SHA256, "policySha256": r.POLICY_SHA256,
                    "sourceArchiveSha256": r.SOURCE_ARCHIVE[1], "engineDonorArchiveSha256": r.DONOR_ARCHIVE[1],
                    "upstreamVersion": "1.181.0", "distributionVersion": r.SOURCE_VERSION, "engineVersion": "1.181.0",
                    **{k: False for k in ("engineRecompiled", "candidateExecution", "buildHooksExecuted",
                       "networkAccessUsed", "runtimeQualified", "dependencyClosureQualified",
                       "wholeCorpusQualified", "published")}, "pythonProtocolVersionUnchanged": True,
                    "pilotDefaultOff": True}

        def test_source_recipe_01_exact_pins(self):
            r = self.recipe()
            self.assertTrue(r.select_recipe(self.recipe_pins())["sourceBuilt"])
            self.assertEqual(r.select_recipe(self.recipe_pins())["cliVersion"], "1.181.0")

        def test_source_recipe_02_legacy_closure(self):
            r = self.recipe()
            self.assertFalse(r.select_recipe({"semgrep": ("1.180.0", "0" * 64)})["sourceBuilt"])
            self.blocked("DEPENDENCY_CLOSURE", H.wheel("semgrep", "1.180.0", ["mcp==1.29.0"]), H.wheel("mcp", "1.30.0"))

        def test_source_recipe_03_wrong_wheel_hash(self):
            r, pins = self.recipe(), self.recipe_pins()
            pins["semgrep"] = (r.SOURCE_VERSION, "0" * 64)
            with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_RECIPE_PIN$"):
                r.select_recipe(pins)

        def test_source_recipe_04_wrong_mcp_pin(self):
            r = self.recipe()
            for pin in (("1.29.0", r.MCP_PIN[1]), ("1.30.0", "0" * 64), None):
                pins = self.recipe_pins()
                pins["mcp"] = pin
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_RECIPE_MCP$"):
                    r.select_recipe(pins)

        def test_source_recipe_05_unknown_version(self):
            r = self.recipe()
            for version in ("1.181.0", "1.181.0+remudero.2", "1.182.0", None):
                with self.assertRaisesRegex(r.RecipeBlocked, "^RUNTIME_RECIPE$"):
                    r.select_recipe({"semgrep": (version, r.SOURCE_WHEEL_SHA256)})

        def test_source_recipe_06_exclude_derived(self):
            r, pins = self.recipe(), self.recipe_pins()
            pins["peewee"] = self.p.APPROVED_PEEWEE
            pins["pip"] = self.p.APPROVED_TOOLS["pip"]
            lock = r.wheel_download_lock(pins)
            self.assertNotIn("semgrep", lock)
            self.assertNotIn("peewee", lock)
            self.assertIn("mcp==1.30.0 --hash=sha256:" + r.MCP_PIN[1], lock)
            self.assertIn("pip==26.2.1 --hash=sha256:", lock)

        def test_source_recipe_07_legacy_download(self):
            r = self.recipe()
            lock = r.wheel_download_lock({"semgrep": ("1.180.0", "a" * 64), "peewee": self.p.APPROVED_PEEWEE})
            self.assertEqual(lock, "semgrep==1.180.0 --hash=sha256:" + "a" * 64 + "\n")

        def test_source_recipe_08_bound_code(self):
            r = self.recipe()
            parent = pathlib.Path(self.p.__file__).parent
            r.verify_code_bytes((parent / "prepare-source-build.py").read_bytes(),
                                (parent / "source-build-policy.json").read_bytes())
            self.assertEqual(r.ASSEMBLER_SHA256, "96eb19457f4799979e691459ad19ba761ab498d6576470db7c77eb5708171274")
            self.assertEqual(r.POLICY_SHA256, "5cf435e3bb81a52e1583ea00008d0e46a3c0ec64d920fe6720d59f88870bd83a")
            with patch.object(self.p, "_regular", return_value=H.payload(self.c)):
                with self.assertRaises(self.p.AuditBlocked) as raised:
                    self.p._source_recipe()
                self.assertEqual(raised.exception.code, "SOURCE_RECIPE_HASH")
            self.assertFalse(self.c.marker.exists())

        def test_source_recipe_09_changed_assembler(self):
            r = self.recipe()
            policy = pathlib.Path(self.p.__file__).with_name("source-build-policy.json").read_bytes()
            with patch.object(r, "_regular", side_effect=lambda path, limit:
                              H.payload(self.c) if path.name == "prepare-source-build.py" else policy):
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_ASSEMBLER_HASH$"):
                    r.load_assembler()
            self.assertFalse(self.c.marker.exists())

        def test_source_recipe_10_changed_policy(self):
            r = self.recipe()
            builder = pathlib.Path(self.p.__file__).with_name("prepare-source-build.py").read_bytes()
            with patch.object(r, "_regular", side_effect=lambda path, limit:
                              builder if path.name == "prepare-source-build.py" else b'{"dependencyPatch":"waiver"}'):
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_POLICY_HASH$"):
                    r.load_assembler()

        def test_source_recipe_11_real_loader(self):
            r = self.recipe()
            builder, policy = r.load_assembler()
            self.assertEqual(builder.POLICY_SHA256, r.POLICY_SHA256)
            self.assertEqual(policy["distributionVersion"], r.SOURCE_VERSION)
            self.assertEqual(policy["dependencyPatch"], {"from": "mcp==1.29.0", "to": "mcp==1.30.0"})
            self.assertNotIn("semgrep", sys.modules)

        def test_source_recipe_12_exact_profile(self):
            r = self.recipe()
            self.assertIsNone(r.validate_profile(dict(r.ASSEMBLY_PROFILE)))
            self.assertEqual(r.ASSEMBLY_PROFILE["python"], "3.12.15")
            self.assertEqual(r.ASSEMBLY_PROFILE["zlib"], "1.3")

        def test_source_recipe_13_profile_drift(self):
            r = self.recipe()
            for key, value in (("python", "3.12.3"), ("platform", "darwin"), ("machine", "aarch64"),
                               ("zlib", "1.3.1"), ("zipCompression", "STORED"), ("zipCompressionLevel", 8)):
                profile = dict(r.ASSEMBLY_PROFILE, **{key: value})
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_BUILD_PROFILE$"):
                    r.validate_profile(profile)

        def test_source_recipe_14_profile_shape(self):
            r = self.recipe()
            for profile in ({}, {**r.ASSEMBLY_PROFILE, "foreign": True},
                            {**r.ASSEMBLY_PROFILE, "zipCompressionLevel": True}):
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_BUILD_PROFILE$"):
                    r.validate_profile(profile)

        def test_source_recipe_15_bound_receipt(self):
            r, receipt = self.recipe(), self.recipe_receipt()
            self.assertIsNone(r.validate_assembly_receipt(receipt))
            self.assertFalse(receipt["runtimeQualified"])

        def test_source_recipe_16_receipt_profile(self):
            r, receipt = self.recipe(), self.recipe_receipt()
            receipt["buildProfile"]["python"] = "3.12.3"
            with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_BUILD_PROFILE$"):
                r.validate_assembly_receipt(receipt)

        def test_source_recipe_17_receipt_identity(self):
            r = self.recipe()
            for key in ("schema", "wheel", "wheelSha256", "builderSha256", "policySha256", "sourceArchiveSha256",
                        "engineDonorArchiveSha256", "distributionVersion", "upstreamVersion", "engineVersion", "state"):
                receipt = self.recipe_receipt()
                receipt[key] = "unapproved"
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_ASSEMBLY_BINDING$"):
                    r.validate_assembly_receipt(receipt)

        def test_source_recipe_18_no_assurance_transfer(self):
            r = self.recipe()
            for key in ("runtimeQualified", "dependencyClosureQualified", "wholeCorpusQualified", "published",
                        "candidateExecution", "buildHooksExecuted", "networkAccessUsed", "engineRecompiled"):
                receipt = self.recipe_receipt()
                receipt[key] = True
                with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_ASSEMBLY_BOUNDARY$"):
                    r.validate_assembly_receipt(receipt)

        def test_source_recipe_19_bad_wheel_inert(self):
            r = self.recipe()
            with self.assertRaisesRegex(r.RecipeBlocked, "^SOURCE_WHEEL_HASH$"):
                r.validate_source_wheel(H.payload(self.c))
            self.assertFalse(self.c.marker.exists())

        def test_source_recipe_20_fixed_raw_inputs(self):
            r = self.recipe()
            self.assertEqual(r.SOURCE_ARCHIVE, ("semgrep-1.181.0.tar.gz", "4c0905288ccf9ee5330e766f1c677a31642a4cc0aac5a95097e7563f3f3a92fa"))
            self.assertEqual(r.DONOR_ARCHIVE[1], "c142ec04a2ed144970cb0a92f6877651dd3c088505eec737bb7f4db7ae5f0ffa")
            self.assertNotIn("+remudero", r.DONOR_ARCHIVE[0])

        def test_source_recipe_21_version_layers(self):
            r = self.recipe()
            recipe = r.select_recipe(self.recipe_pins())
            self.assertEqual(recipe["distributionVersion"], "1.181.0+remudero.1")
            self.assertEqual(recipe["cliVersion"], "1.181.0")
            self.assertEqual(recipe["engineSha256"], "14f4b18720d881156bc0cc507b19130aa8d8db0882a5a479fb3919aadefca857")
            self.assertEqual(r.select_recipe({"semgrep": ("1.180.0", "a" * 64)})["cliVersion"], "1.180.0")

        def test_source_recipe_22_new_metadata_graph(self):
            # Metadata-only positive; this synthetic wheel is NOT the approved
            # source-built artifact and cannot satisfy its whole SHA binding.
            fixture = H.wheel("semgrep", "1.181.0+remudero.1", ["mcp==1.30.0"])
            before = fixture.raw
            self.positive(fixture, H.wheel("mcp", "1.30.0"))
            self.blocked("DEPENDENCY_CLOSURE", fixture, H.wheel("mcp", "1.29.0"))
            self.assertEqual(fixture.raw, before)

        def test_source_recipe_23_original_donor_graph(self):
            fixture = H.wheel("semgrep", "1.181.0", ["mcp==1.29.0"])
            before = fixture.raw
            self.positive(fixture, H.wheel("mcp", "1.29.0"))
            self.blocked("DEPENDENCY_CLOSURE", fixture, H.wheel("mcp", "1.30.0"))
            self.assertEqual(fixture.raw, before)

        def test_source_recipe_24_missing_receipt_fields(self):
            r = self.recipe()
            for key in self.recipe_receipt():
                receipt = self.recipe_receipt()
                del receipt[key]
                with self.assertRaises(r.RecipeBlocked):
                    r.validate_assembly_receipt(receipt)

        def test_source_recipe_25_private_creation(self):
            r = self.recipe()
            with tempfile.TemporaryDirectory(dir=self.c.scratch) as temporary:
                root, calls = pathlib.Path(temporary), []
                def create(parent, argv):
                    # Synthetic creation seam only; no interpreter/venv runs.
                    self.assertEqual(parent, root)
                    self.assertEqual(argv[:-1], [sys.executable, "-I", "-S", "-m", "venv", "--without-pip"])
                    (argv[-1] / "bin").mkdir()
                    calls.append(argv[-1])
                previous = os.umask(0o027)
                try:
                    path = r.create_private_venv(root, "runtime-env", create)
                    self.assertEqual(os.umask(0o027), 0o027)
                    self.assertEqual(path.stat().st_mode & 0o777, 0o700)
                    self.assertEqual((path / "bin").stat().st_mode & 0o777, 0o700)
                    self.assertEqual(calls, [path])
                finally:
                    os.umask(previous)

        def test_source_recipe_26_existing_entry_refused(self):
            r = self.recipe()
            with tempfile.TemporaryDirectory(dir=self.c.scratch) as temporary:
                root = pathlib.Path(temporary)
                existing = root / "runtime-env"
                existing.mkdir(mode=0o700)
                marker = existing / "unpublished"
                marker.write_bytes(b"preserve")
                with self.assertRaisesRegex(r.RecipeBlocked, "^VENV_ENTRY_EXISTS$"):
                    r.create_private_venv(root, "runtime-env", lambda *args: self.fail("must not run"))
                self.assertEqual(marker.read_bytes(), b"preserve")
                with self.assertRaisesRegex(r.RecipeBlocked, "^VENV_BASENAME$"):
                    r.create_private_venv(root, "../escape", lambda *args: self.fail("must not run"))
                def failed(*args):
                    raise RuntimeError("fixture child failure")
                previous = os.umask(0o027)
                try:
                    with self.assertRaisesRegex(RuntimeError, "^fixture child failure$"):
                        r.create_private_venv(root, "build-env", failed)
                    self.assertEqual(os.umask(0o027), 0o027)
                finally:
                    os.umask(previous)

        def test_source_recipe_27_real_stdlib_creation(self):
            # REAL default child: stdlib venv --without-pip only. The stock
            # environment deliberately drops LD; this is NOT proof of child
            # exact Python patch/private-runtime parity or candidate behavior.
            r = self.recipe()
            parent = pathlib.Path(self.p.__file__).parent
            sources = [pathlib.Path(self.p.__file__),
                       *(parent / name for name in self.p.AUDIT_TEST_SOURCES)]
            before = {path: H.stable_regular(path, 65536) for path in sources}
            caller = (dict(os.environ), os.getcwd(), tuple(sys.path), sys.executable)
            with tempfile.TemporaryDirectory(dir=self.c.scratch) as temporary:
                root = pathlib.Path(temporary)
                for name in ("home", "tmp"):
                    (root / name).mkdir(mode=0o700)
                self.assertFalse((root / "runtime-env").exists())
                previous = os.umask(0o027)
                try:
                    path = r.create_private_venv(root, "runtime-env", self.p._run)
                    self.assertEqual(os.umask(0o027), 0o027)
                    self.assertEqual(path, root / "runtime-env")
                    self.assertEqual(path.stat().st_mode & 0o777, 0o700)
                    self.assertEqual((path / "bin").stat().st_mode & 0o777, 0o700)
                    config = path / "pyvenv.cfg"
                    self.assertTrue(config.is_file())
                    self.assertFalse(config.is_symlink())
                    self.assertIn("include-system-site-packages = false", config.read_text())
                    self.assertTrue((path / "bin/python").is_file())
                finally:
                    os.umask(previous)
            self.assertEqual((dict(os.environ), os.getcwd(), tuple(sys.path), sys.executable), caller)
            for path, raw in before.items():
                self.assertEqual(H.stable_regular(path, 65536), raw)
            H.assert_frozen_inputs(self.c)
            H.assert_no_candidate_execution(self.c)

        def metadata25(self, name="attack", fields=(), requirements=()):
            return H.metadata(name, "1.0", requirements).replace(
                b"Metadata-Version: 2.4\n", b"Metadata-Version: 2.5\n" +
                b"".join((field + "\n").encode() for field in fields))

        def test_metadata25_preserves_raw_bytes_and_final_import_declarations(self):
            raw = self.metadata25(fields=["Import-Name: attack"])
            fixture = H.wheel("attack", metadata_bytes=raw)
            self.assertEqual(H.scan(self.c, fixture)["metadata"], raw)
            self.positive(fixture)
            self.assertNotIn("attack", __import__("sys").modules)

        def test_metadata25_final_requires_python_still_blocks(self):
            raw = self.metadata25(fields=["Import-Name: attack"]).replace(b">=3.12", b">=99")
            self.blocked("REQUIRES_PYTHON", H.wheel("attack", metadata_bytes=raw))

        def test_metadata25_final_dependency_closure_still_blocks(self):
            raw = self.metadata25(fields=["Import-Name: attack"], requirements=["mcp==1.29.0"])
            fixture = H.wheel("attack", metadata_bytes=raw)
            self.positive(fixture, H.wheel("mcp", "1.29.0"))
            self.blocked("DEPENDENCY_CLOSURE", fixture, H.wheel("mcp", "1.30.0"))

        def test_metadata_unsupported_versions_remain_explicit_refusals(self):
            for version in ("2.6", "3.0", "2.50", "2.5.0"):
                raw = self.metadata25().replace(b"Metadata-Version: 2.5\n", ("Metadata-Version: " + version + "\n").encode())
                self.blocked("METADATA_VERSION_UNKNOWN", H.wheel("attack", metadata_bytes=raw))

        def test_import_declarations_require_the_reviewed_metadata_version(self):
            for version in ("2.1", "2.2", "2.3", "2.4"):
                raw = self.metadata25(fields=["Import-Name: attack"]).replace(b"Metadata-Version: 2.5\n", ("Metadata-Version: " + version + "\n").encode())
                self.blocked("IMPORT_DECLARATION_VERSION", H.wheel("attack", metadata_bytes=raw))

        def test_import_parser_accepts_private_unicode_and_dotted_names_as_data(self):
            raw = self.metadata25(fields=["Import-Name: ns.child ; private", "Import-Name: _élan", "Import-Namespace: ns"])
            msg = self.p.BytesParser(policy=self.p.email.policy.default.clone(raise_on_defect=True)).parsebytes(raw)
            exclusive, namespaces = self.p.declared_imports(msg, "attack")
            self.assertEqual(exclusive, {"ns.child", "_élan"})
            self.assertEqual(namespaces, {"ns"})
            self.positive(H.wheel("attack", metadata_bytes=raw))

        def test_import_parser_refuses_invalid_names_and_private_markers(self):
            for value in ("../pip", "a/b", "a..b", ".a", "a.", "1a", "class", "a b", "a; public", "a;private;private"):
                self.blocked("IMPORT_DECLARATION", H.wheel("attack", metadata_bytes=self.metadata25(fields=["Import-Name: " + value])))

        def test_import_parser_distinguishes_empty_exclusive_and_namespace_fields(self):
            msg = self.p.BytesParser().parsebytes(self.metadata25(fields=["Import-Name:"]))
            self.assertEqual(self.p.declared_imports(msg, "attack"), (set(), set()))
            for fields in (["Import-Namespace:"], ["Import-Name:", "Import-Name: attack"],
                           ["Import-Name:", "Import-Namespace: ns"], ["Import-Name: ; private"]):
                self.blocked("IMPORT_DECLARATION", H.wheel("attack", metadata_bytes=self.metadata25(fields=fields)))

        def test_same_project_import_name_namespace_ambiguity_blocks(self):
            raw = self.metadata25(fields=["Import-Name: attack ; private", "Import-Namespace: attack"])
            self.blocked("IMPORT_DECLARATION_AMBIGUOUS", H.wheel("attack", metadata_bytes=raw))

        def test_same_project_exclusive_parent_and_namespace_child_are_not_ambiguous(self):
            raw = self.metadata25(fields=["Import-Name: attack", "Import-Namespace: attack.plugins"])
            self.positive(H.wheel("attack", metadata_bytes=raw))

        def test_cross_project_exclusive_import_claims_cannot_collide(self):
            for other in ("shared", "Shared"):
                one = H.wheel("one", metadata_bytes=self.metadata25("one", ["Import-Name: shared"]))
                two = H.wheel("two", metadata_bytes=self.metadata25("two", ["Import-Name: " + other]))
                self.blocked("IMPORT_DECLARATION_COLLISION", one, two)

        def test_cross_project_exclusive_import_prefixes_cannot_shadow(self):
            one = H.wheel("one", metadata_bytes=self.metadata25("one", ["Import-Name: shared"]))
            two = H.wheel("two", metadata_bytes=self.metadata25("two", ["Import-Name: shared.child"]))
            self.blocked("IMPORT_DECLARATION_COLLISION", one, two)
            self.blocked("IMPORT_DECLARATION_COLLISION", two, one)

        def test_cross_project_exclusive_import_cannot_shadow_namespace(self):
            for namespace in ("shared", "shared.child"):
                one = H.wheel("one", metadata_bytes=self.metadata25("one", ["Import-Name: shared"]))
                two = H.wheel("two", metadata_bytes=self.metadata25("two", ["Import-Namespace: " + namespace]))
                self.blocked("IMPORT_DECLARATION_COLLISION", one, two)
                self.blocked("IMPORT_DECLARATION_COLLISION", two, one)

        def test_exclusive_namespace_child_can_coexist_with_shared_parent_metadata(self):
            one = H.wheel("one", metadata_bytes=self.metadata25("one", ["Import-Name: shared.one", "Import-Namespace: shared"]))
            two = H.wheel("two", metadata_bytes=self.metadata25("two", ["Import-Name: shared.two", "Import-Namespace: shared"]))
            # Distinct fixture file roots: this is declaration semantics, not a
            # claim that either fixture provides an importable shared package.
            self.positive(one, two)

        def test_namespace_metadata_does_not_waive_actual_archive_ownership(self):
            one = H.wheel("one", metadata_bytes=self.metadata25("one", ["Import-Namespace: namespace"]), files={"namespace/one.py": b"# one\n"})
            two = H.wheel("two", metadata_bytes=self.metadata25("two", ["Import-Namespace: namespace"]), files={"namespace/two.py": b"# two\n"})
            self.blocked("NAMESPACE_OWNERSHIP", one, two)

        def test_sdist_dynamic_import_fields_remain_blocked_before_build(self):
            for field in ("Import-Name", "Import-Namespace"):
                raw = self.metadata25(fields=["Dynamic: " + field])
                with self.assertRaises(self.p.AuditBlocked) as raised:
                    self.p.metadata_distribution(raw, b"", "attack", "1.0", self.api, source_kind="sdist")
                self.assertEqual(raised.exception.code, "DYNAMIC_METADATA")

        def test_wheel_dynamic_import_field_still_enforces_final_syntax(self):
            raw = self.metadata25(fields=["Dynamic: Import-Name", "Import-Name: ../pip"])
            self.blocked("IMPORT_DECLARATION", H.wheel("attack", metadata_bytes=raw))

        def test_import_metadata_does_not_waive_tool_namespace_protection(self):
            raw = self.metadata25(fields=["Import-Name: attack"])
            self.blocked("TOOL_NAMESPACE_OVERWRITE", H.wheel("attack", metadata_bytes=raw,
                         files={"pip/forged.py": H.payload(self.c)}))

        def test_import_declaration_work_is_bounded_per_project_and_whole_set(self):
            raw = self.metadata25(fields=["Import-Name: x" + str(i) for i in range(129)])
            self.blocked("IMPORT_DECLARATION_BOUND", H.wheel("attack", metadata_bytes=raw))
            fixtures = [H.wheel(name, metadata_bytes=self.metadata25(name, ["Import-Name: " + name + str(i) for i in range(86)]))
                        for name in ("one", "two", "three")]
            self.blocked("IMPORT_DECLARATION_BOUND", *fixtures)

        def test_wheel_dynamic_dependency_is_final_and_original_bytes_are_preserved(self):
            raw = H.metadata("semgrep", "1.180.0", ["mcp==1.29.0"]).replace(
                b"Metadata-Version: 2.4\n", b"Metadata-Version: 2.4\nDynamic: Requires-Dist\n")
            self.assertIn(b"Dynamic: Requires-Dist\n", raw)
            fixture = H.wheel("semgrep", "1.180.0", metadata_bytes=raw)
            self.assertEqual(H.scan(self.c, fixture)["metadata"], raw)
            self.positive(fixture, H.wheel("mcp", "1.29.0"))
            self.blocked("DEPENDENCY_CLOSURE", fixture, H.wheel("mcp", "1.30.0"))
            self.assertEqual(H.scan(self.c, fixture)["metadata"], raw)

        def test_wheel_dynamic_python_still_enforces_final_requires_python(self):
            raw = H.metadata("attack", "1.0").replace(
                b"Requires-Python: >=3.12\n", b"Dynamic: Requires-Python\nRequires-Python: >=99\n")
            self.assertIn(b"Dynamic: Requires-Python\n", raw)
            self.blocked("REQUIRES_PYTHON", H.wheel("attack", metadata_bytes=raw))

        def test_sdist_dynamic_dependencies_remain_blocked_before_build(self):
            for field in ("Requires-Dist", "Requires-Python"):
                raw = H.metadata("attack", "1.0").replace(
                    b"Metadata-Version: 2.4\n", ("Metadata-Version: 2.4\nDynamic: " + field + "\n").encode())
                self.assertIn(("Dynamic: " + field + "\n").encode(), raw)
                with self.assertRaises(self.p.AuditBlocked) as raised:
                    self.p.metadata_distribution(raw, b"", "attack", "1.0", self.api, source_kind="sdist")
                self.assertEqual(raised.exception.code, "DYNAMIC_METADATA")

        def test_dynamic_identity_fields_and_unknown_origin_remain_blocked(self):
            for field in ("Name", "Version", "Metadata-Version"):
                raw = H.metadata("attack", "1.0").replace(
                    b"Metadata-Version: 2.4\n", ("Metadata-Version: 2.4\nDynamic: " + field + "\n").encode())
                self.assertIn(("Dynamic: " + field + "\n").encode(), raw)
                for kind in ("wheel", "sdist"):
                    with self.assertRaises(self.p.AuditBlocked) as raised:
                        self.p.metadata_distribution(raw, b"", "attack", "1.0", self.api, source_kind=kind)
                    self.assertEqual(raised.exception.code, "DYNAMIC_METADATA")
            with self.assertRaises(self.p.AuditBlocked) as raised:
                self.p.metadata_distribution(H.metadata("attack", "1.0"), b"", "attack", "1.0", self.api, source_kind="unknown")
            self.assertEqual(raised.exception.code, "METADATA_ORIGIN")

        def test_printable_space_paths_keep_safety_guards(self):
            self.positive(H.wheel("attack", files={"attack/launcher manifest.xml": b"fixture data\n"}))
            for path, code in (("attack/bad\tname", "ARCHIVE_PATH"), ("attack/bad\nname", "ARCHIVE_PATH"),
                               ("attack/../escape file", "ARCHIVE_TRAVERSAL"), ("attack/./same file", "ARCHIVE_TRAVERSAL"),
                               ("attack//same file", "ARCHIVE_TRAVERSAL"), ("attack/ leading", "ARCHIVE_TRAVERSAL"),
                               ("attack/trailing ", "ARCHIVE_TRAVERSAL"), ("/attack/space file", "ARCHIVE_PATH"),
                               ("attack\\space file", "ARCHIVE_PATH"), ("C:/space file", "ARCHIVE_PATH")):
                self.blocked(code, H.wheel("attack", files={path: b"refused fixture data\n"}))
            with self.assertRaises(self.p.AuditBlocked) as raised:
                self.p.safe_member("attack/nul\x00file")
            self.assertEqual(raised.exception.code, "ARCHIVE_PATH")

    for name, method in vars(MetadataCases).items():
        if name in {"metadata25", "recipe", "recipe_pins", "recipe_receipt"} or name.startswith("test_"):
            if hasattr(case, name):
                raise AssertionError("duplicate metadata control: " + name)
            setattr(case, name, method)
