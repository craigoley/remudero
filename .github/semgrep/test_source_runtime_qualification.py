"""Deterministic controls; these never install or qualify a candidate runtime."""
import hashlib
import builtins
import copy
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import symtable
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

BASE = pathlib.Path(__file__).absolute().parent
module_path = BASE / "source-runtime-qualification.py"
if len(sys.argv) > 2 and sys.argv[1] == "--qualifier-module":
    # Only this test runner accepts a disposable fix-deletion copy, never the production CLI.
    module_path = pathlib.Path(sys.argv[2])
    sys.argv = [sys.argv[0], *sys.argv[3:]]
spec = importlib.util.spec_from_file_location("qualifier", module_path)
qualifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualifier)


class SourceQualificationControls(unittest.TestCase):
    def test_language_response_requires_real_schema_and_both_js_ts_sentinels(self):
        names = ["apex", "bash", "c", "cpp", "docker", "elixir", "go", "html", "java", "javascript",
                 "json", "kotlin", "lua", "ocaml", "php", "python", "r", "ruby", "rust", "scala",
                 "sh", "swift", "typescript", "yaml"]
        text = "supported languages are: " + ", ".join(names)
        healthy = {"isError": False, "content": [{"type": "text", "text": text}],
                   "structuredContent": {"result": [text]}}
        self.assertEqual(qualifier.validate_language_response(healthy)["count"], len(names))
        for broken in (None, {}, dict(healthy, isError=True), dict(healthy, content=[]),
                       dict(healthy, structuredContent={}),
                       dict(healthy, content=[{"type": "text", "text": "not languages"}]),
                       dict(healthy, content=[{"type": "text", "text": text.replace("typescript", "other")}]),
                       dict(healthy, content=[{"type": "text", "text": text + ", javascript"}])):
            with self.assertRaises(qualifier.QualificationBlocked):
                qualifier.validate_language_response(broken)

    def audit_fixture(self, head):
        return {"state": "INDEPENDENT_AUDITS_COMPLETE_NOT_RUNTIME_QUALIFIED", "head": head,
                "profile": qualifier.PROFILE,
                "steps": [{"phase": phase, "exitCode": 0} for phase in qualifier.PHASES]}

    def test_install_orders_complete_audits_before_head_bound_mcp(self):
        workspace = BASE.parent.parent
        head = subprocess.check_output(["git", "-C", workspace, "rev-parse", "HEAD"], text=True).strip()
        with tempfile.TemporaryDirectory() as directory:
            root, calls = pathlib.Path(directory), []
            def audit(owner, repo, revision):
                self.assertEqual((owner, repo, revision), (root, workspace, head))
                calls.append("audit")
                return self.audit_fixture(head)
            def run(owner, argv, phase, seconds):
                self.assertEqual(calls, ["audit"])
                self.assertEqual(phase, "mcp")
                self.assertEqual(seconds, 90)
                self.assertEqual(argv[:3], [root / "runtime-env/bin/python", "-I", "-B"])
                self.assertEqual(pathlib.Path(argv[3]).read_bytes(), module_path.read_bytes())
                self.assertEqual(argv[4:], ["--probe-mcp-root", root])
                self.assertTrue((root / "source-qualification-audits.json").is_file())
                calls.append("mcp")
                (root / "mcp-qualification.json").write_text(json.dumps(
                    qualifier.validate_mcp_observations(self.healthy_mcp_observations())))
            result = qualifier.install_runtime(root, workspace, head, audit=audit, run=run)
            self.assertEqual(calls, ["audit", "mcp"])
            self.assertTrue(result["installedClosureQualified"])
            self.assertFalse(result["runtimeQualified"])
            self.assertFalse(result["wholeCorpusQualified"])
            self.assertEqual(result["productionOAuthIdentity"], "NOT_QUALIFIED")

    def test_install_refuses_each_missing_partial_or_changed_receipt(self):
        workspace = BASE.parent.parent
        head = subprocess.check_output(["git", "-C", workspace, "rev-parse", "HEAD"], text=True).strip()
        for broken in ("phase", "order", "status", "boolean-exit", "head", "profile"):
            with tempfile.TemporaryDirectory() as directory:
                result = self.audit_fixture(head)
                if broken == "phase": result["steps"].pop()
                if broken == "order": result["steps"].reverse()
                if broken == "status": result["steps"][2]["exitCode"] = 1
                if broken == "boolean-exit": result["steps"][2]["exitCode"] = False
                if broken == "head": result["head"] = "a" * 40
                if broken == "profile": result["profile"] = {}
                with self.assertRaisesRegex(qualifier.QualificationBlocked, "AUDIT_SEQUENCE_INCOMPLETE"):
                    qualifier.install_runtime(pathlib.Path(directory), workspace, head,
                        audit=lambda *_args: result, run=lambda *_args: self.fail("probe before complete audit"))
        for broken in ("missing", "partial", "changed", "oversized", "empty", "not-object", "symlink", "directory", "invalid-json", "runner-failed"):
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                def run(*_args):
                    if broken == "runner-failed": raise qualifier.QualificationBlocked("STEP_FAILED:mcp:1")
                    if broken == "missing": return
                    if broken == "symlink":
                        other = root / "other.json"
                        other.write_text("{}")
                        (root / "mcp-qualification.json").symlink_to(other)
                        return
                    if broken == "directory":
                        (root / "mcp-qualification.json").mkdir()
                        return
                    proof = qualifier.validate_mcp_observations(self.healthy_mcp_observations())
                    if broken == "partial": proof["observations"]["shutdown"] = False
                    if broken == "changed": proof["runtimeQualified"] = True
                    raw = {"oversized": " " * 65537, "empty": "", "not-object": "[]", "invalid-json": "{"}.get(broken, json.dumps(proof))
                    (root / "mcp-qualification.json").write_text(raw)
                with self.assertRaises((qualifier.QualificationBlocked, FileNotFoundError, json.JSONDecodeError)):
                    qualifier.install_runtime(root, workspace, head, audit=lambda *_args: self.audit_fixture(head), run=run)

    def test_probe_staging_requires_exact_committed_executed_bytes(self):
        workspace = BASE.parent.parent
        head = subprocess.check_output(["git", "-C", workspace, "rev-parse", "HEAD"], text=True).strip()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.assertEqual(qualifier.stage_probe(root, workspace, head).read_bytes(), module_path.read_bytes())
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "CHECKOUT_CHANGED"):
                qualifier.stage_probe(root, workspace, "a" * 40)
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "INVENTORY"):
                qualifier.committed_source(root, workspace, head, ".github/semgrep/not-declared.py")
            real_run = qualifier.subprocess.run
            for name, reason in (("runtime-compatibility-audit.py", "AUDIT_SOURCE_HASH"),
                                 ("source-runtime-qualification.py", "EXECUTED_QUALIFIER")):
                changed_reads = []
                def changed_blob(argv, **kwargs):
                    result = real_run(argv, **kwargs)
                    if argv[-3:-1] == ["cat-file", "blob"]:
                        raw = result.stdout
                        self.assertGreater(len(raw), 0)
                        result.stdout = bytes([raw[0] ^ 1]) + raw[1:]
                        self.assertEqual(len(result.stdout), len(raw))
                        changed_reads.append(name)
                    return result
                with patch.object(qualifier.subprocess, "run", side_effect=changed_blob):
                    with self.assertRaisesRegex(qualifier.QualificationBlocked, reason):
                        qualifier.committed_source(root, workspace, head, ".github/semgrep/" + name)
                self.assertEqual(changed_reads, [name], "the same-length tampered blob was actually read")
            other = root / "different.py"
            other.write_text("not the committed qualifier")
            with patch.object(qualifier, "__file__", str(other)):
                with self.assertRaisesRegex(qualifier.QualificationBlocked, "EXECUTED_QUALIFIER"):
                    qualifier.stage_probe(root, workspace, head)

    def test_actual_probe_has_no_unbound_global_names(self):
        table = symtable.symtable(module_path.read_text(), str(module_path), "exec")
        bound = {s.get_name() for s in table.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
        bound.update(vars(builtins))
        bound.update({"__name__", "__file__"})
        def inspect(scope):
            for symbol in scope.get_symbols():
                if symbol.is_global() and symbol.is_referenced():
                    self.assertIn(symbol.get_name(), bound, scope.get_name())
            for child in scope.get_children():
                inspect(child)
        inspect(table)

    def healthy_mcp_observations(self):
        return {"versions": {"semgrep": "1.181.0+remudero.1", "mcp": "1.30.0"},
                "initialized": True, "upstreamLifespan": True, "languages": True, "shutdown": True,
                "listenerClosed": True, "disallowedLoopbackDenied": True, "tools": sorted(qualifier.MCP_TOOLS),
                "localIdentityRead": True, "identityListenerClosed": True, "languageSentinels": True,
                "prompts": 2, "resources": 2, "loopbackConnections": 5, "ownedCommands": 2,
                "denied": {"missing": 401, "wrong": 401, "expired": 401, "audience": 401,
                           "scope": 403, "host": 421, "origin": 403}}

    def test_mcp_missing_revised_partial_or_timeout_evidence_is_not_healthy(self):
        healthy = self.healthy_mcp_observations()
        result = qualifier.validate_mcp_observations(healthy)
        self.assertTrue(result["mcpApiQualified"])
        self.assertFalse(result["runtimeQualified"])
        self.assertEqual(result["productionOAuthIdentity"], "NOT_QUALIFIED")
        for name in healthy:
            missing = copy.deepcopy(healthy)
            del missing[name]
            with self.assertRaises(qualifier.QualificationBlocked, msg=name):
                qualifier.validate_mcp_observations(missing)
        for name in ("initialized", "upstreamLifespan", "languages", "shutdown", "listenerClosed",
                     "disallowedLoopbackDenied", "localIdentityRead", "identityListenerClosed", "languageSentinels",
                     "loopbackConnections", "ownedCommands"):
            partial = copy.deepcopy(healthy)
            partial[name] = False
            with self.assertRaises(qualifier.QualificationBlocked, msg=name):
                qualifier.validate_mcp_observations(partial)
        wrong = copy.deepcopy(healthy)
        wrong["versions"]["mcp"] = "1.29.0"
        with self.assertRaisesRegex(qualifier.QualificationBlocked, "IDENTITY"):
            qualifier.validate_mcp_observations(wrong)

    def test_each_auth_and_transport_negative_requires_the_healthy_bound_corpus(self):
        for name in self.healthy_mcp_observations()["denied"]:
            broken = self.healthy_mcp_observations()
            broken["denied"][name] = 200
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "AUTH_OR_TRANSPORT"):
                qualifier.validate_mcp_observations(broken)
        for tools in ([], ["semgrep_scan"] * 8, sorted(qualifier.MCP_TOOLS - {"semgrep_findings"}) + ["unknown-tool"]):
            broken = self.healthy_mcp_observations()
            broken["tools"] = tools
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "REGISTRATION"):
                qualifier.validate_mcp_observations(broken)

    def test_real_local_identity_fixture_is_scoped_private_and_closed(self):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with qualifier.local_identity_fixture("disposable-test-only") as identity:
            url = identity["url"] + "/api/auth/users/current"
            req = urllib.request.Request(url, headers={"Authorization": "Bearer disposable-test-only"})
            with opener.open(req, timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b'"login": "not-a-live-user"', response.read())
            deployment = urllib.request.Request(identity["url"] + "/api/v2/deployments", headers=req.headers)
            with opener.open(deployment, timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b'"name": "disposable-qualification-only"', response.read())
            for target, headers in ((url, {}), (url, {"Authorization": "Bearer wrong"}),
                                    (identity["url"] + "/other", req.headers)):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    opener.open(urllib.request.Request(target, headers=headers), timeout=2)
                self.assertEqual(error.exception.code, 401)
            with self.assertRaises(urllib.error.HTTPError) as error:
                opener.open(urllib.request.Request(url, data=b"no-write", method="POST"), timeout=2)
            self.assertEqual(error.exception.code, 501)
            self.assertEqual(identity["counts"], {"accepted": 2, "refused": 3, "user": 1, "deployments": 1})
        self.assertTrue(identity["closed"])
        with self.assertRaises(urllib.error.URLError):
            opener.open(url, timeout=2)

    def test_exact_profile_is_required_before_any_runner(self):
        qualifier.require_profile(dict(qualifier.PROFILE))
        for key in qualifier.PROFILE:
            bad = dict(qualifier.PROFILE, **{key: "wrong"})
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "TARGET_PROFILE_UNKNOWN"):
                qualifier.audit_runtime(pathlib.Path("/nonexistent"), BASE, "a" * 40,
                                        run=lambda *args: self.fail("effect before profile"), profile=bad)
        with self.assertRaisesRegex(qualifier.QualificationBlocked, "TARGET_PROFILE_UNKNOWN"):
            qualifier.require_profile(dict(qualifier.PROFILE, extra="not-approved"))

    def test_real_committed_sources_and_every_hash_are_bound(self):
        for name, expected in qualifier.AUDIT_SOURCES.items():
            raw = (BASE / name).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected)
            self.assertEqual(qualifier.checked_bytes(name, raw), raw)
            for changed in (b"", raw + b"\n", b"changed"):
                with self.assertRaises(qualifier.QualificationBlocked):
                    qualifier.checked_bytes(name, changed)
        with self.assertRaisesRegex(qualifier.QualificationBlocked, "INVENTORY"):
            qualifier.checked_bytes("other.py", b"anything")

    def test_private_root_refuses_permissions_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.assertEqual(qualifier.private_root(root), root)
            link = root / "link"
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "PRIVATE_ROOT"):
                qualifier.private_root(link)
            invalid = root / "group-traversable"
            # Only an empty child of an owner-only parent; the creator's umask is process-local.
            subprocess.run([sys.executable, "-I", "-S", "-c",
                            "import os,sys;os.umask(0o067);os.mkdir(sys.argv[1],0o710)", str(invalid)],
                           check=True, timeout=5)
            self.assertEqual(invalid.stat().st_mode & 0o777, 0o710, "real non-owner-bit control")
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "PRIVATE_ROOT"):
                qualifier.private_root(invalid)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700, "the real fixture stayed owner-only")

    def test_environment_does_not_inherit_credentials_or_injection(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "trap", "SEMGREP_APP_TOKEN": "trap",
                                     "PYTHONPATH": "trap", "LD_PRELOAD": "trap", "NODE_OPTIONS": "trap"}):
            env = qualifier.environment(pathlib.Path("/private/fixture"))
        self.assertFalse(any(value == "trap" for value in env.values()))
        self.assertEqual(env["SEMGREP_SEND_METRICS"], "off")
        self.assertEqual(env["GIT_CONFIG_GLOBAL"], "/dev/null")

    def test_each_phase_reacquires_original_bytes_and_preserves_pip_check(self):
        with tempfile.TemporaryDirectory() as directory:
            root, calls = pathlib.Path(directory), []
            # Real Git reads exercise 100644/blob/hash checks, not a trusted fake path.
            workspace = BASE.parent.parent
            head = subprocess.check_output(["git", "-C", workspace, "rev-parse", "HEAD"], text=True).strip()
            def run(owner, argv, phase, seconds):
                self.assertEqual(owner, root)
                self.assertEqual(argv[1:3], ["-I", "-S"])
                self.assertGreater(seconds, 0)
                auditor = pathlib.Path(argv[3])
                self.assertEqual(auditor.read_bytes(), (BASE / "runtime-compatibility-audit.py").read_bytes())
                self.assertIn('"pip", "check"', auditor.read_text())
                calls.append((phase, auditor.parent))
                return {"phase": phase, "exitCode": 0}
            result = qualifier.audit_runtime(root, workspace, head, run=run, profile=qualifier.PROFILE)
            self.assertEqual([phase for phase, _ in calls], list(qualifier.PHASES))
            self.assertEqual(len({path for _, path in calls}), len(qualifier.PHASES))
            self.assertFalse(result["runtimeQualified"])
            self.assertFalse(result["mcpApiQualified"])
            self.assertFalse(result["wholeCorpusQualified"])

    def test_any_failed_audit_prevents_later_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            root, calls = pathlib.Path(directory), []
            workspace = BASE.parent.parent
            head = subprocess.check_output(["git", "-C", workspace, "rev-parse", "HEAD"], text=True).strip()
            def run(owner, argv, phase, seconds):
                calls.append(phase)
                if phase == "original":
                    raise qualifier.QualificationBlocked("ORIGINAL_METADATA_REFUSED")
                return {"phase": phase, "exitCode": 0}
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "ORIGINAL_METADATA_REFUSED"):
                qualifier.audit_runtime(root, workspace, head, run=run, profile=qualifier.PROFILE)
            self.assertEqual(calls, ["unit", "download", "original"])

    def test_real_default_child_and_every_process_failure_are_named(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            success = qualifier.run_checked(root, [sys.executable, "-I", "-S", "-c", "print('control')"], "healthy", 5)
            self.assertEqual(success["exitCode"], 0)
            self.assertIn("control", (root / "healthy.log").read_text())
            for name, argv, bound, reason in (
                ("failed", [sys.executable, "-I", "-S", "-c", "raise SystemExit(7)"], 5, "STEP_FAILED:failed:7"),
                ("missing", [str(root / "missing-executable")], 5, "STEP_UNAVAILABLE:missing"),
                ("timeout", [sys.executable, "-I", "-S", "-c", "import time;time.sleep(10)"], 0.05, "STEP_TIMEOUT:timeout"),
            ):
                with self.assertRaisesRegex(qualifier.QualificationBlocked, reason):
                    qualifier.run_checked(root, argv, name, bound)
            child = Mock(pid=987654)
            child.wait.side_effect = [subprocess.TimeoutExpired("owned-race", 0.01), 0, 0]
            with patch.object(qualifier.subprocess, "Popen", return_value=child), \
                    patch.object(qualifier.os, "killpg", side_effect=ProcessLookupError()):
                with self.assertRaisesRegex(qualifier.QualificationBlocked, "STEP_TIMEOUT:already-exited"):
                    qualifier.run_checked(root, ["fixture-only"], "already-exited", 0.01)
            with self.assertRaisesRegex(qualifier.QualificationBlocked, "STEP_OUTPUT_BOUND"):
                qualifier.run_checked(root, [sys.executable, "-I", "-S", "-c",
                                            "import sys;sys.stdout.write('x'*(8*1024*1024+1))"], "over-output", 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
