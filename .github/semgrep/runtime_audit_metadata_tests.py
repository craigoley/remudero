"""Hash-bound metadata controls; candidate bytes are data, never imported.

Attached methods retain the literal AuditSyntheticModuleTests identities. Lower
parser positives do not establish importability or real-artifact compatibility.
"""


def attach_metadata_cases(case, H):
    class MetadataCases:
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

    for name, method in vars(MetadataCases).items():
        if name == "metadata25" or name.startswith("test_"):
            if hasattr(case, name):
                raise AssertionError("duplicate metadata control: " + name)
            setattr(case, name, method)
