"""Bounded source-runtime qualification; audit completion is not adoption authority."""
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import pathlib
import platform
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from contextlib import asynccontextmanager, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROFILE = {"python": "3.12.15", "platform": "linux", "machine": "x86_64", "zlib": "1.3"}
AUDIT_SOURCES = {
    "runtime-compatibility-audit.py": "803a9edd12d2e6fbad45adf6463e72c6d5c62264f6579ec96b956f4fd1f786e3",
    "runtime_source_recipe.py": "6d1d2cc20e1a2fe225f913d9df815771b4e047c872bdaabbb59eceea52bcb35d",
    "prepare-source-build.py": "96eb19457f4799979e691459ad19ba761ab498d6576470db7c77eb5708171274",
    "source-build-policy.json": "5cf435e3bb81a52e1583ea00008d0e46a3c0ec64d920fe6720d59f88870bd83a",
}
PHASES = ("unit", "download", "original", "build", "built", "install", "verify")
PHASE_SECONDS = {"unit": 180, "download": 300, "original": 90, "build": 180,
                 "built": 90, "install": 180, "verify": 90}
MCP_TOOLS = frozenset({"semgrep_rule_schema", "get_supported_languages", "semgrep_findings",
                       "semgrep_scan_with_custom_rule", "semgrep_scan", "get_abstract_syntax_tree",
                       "semgrep_scan_supply_chain", "semgrep_whoami"})


class QualificationBlocked(ValueError):
    """Missing, changed, failed or incomplete evidence; never a success fallback."""


def need(condition, reason):
    if not condition:
        raise QualificationBlocked(reason)


def current_profile():
    return {"python": platform.python_version(), "platform": sys.platform,
            "machine": platform.machine(), "zlib": zlib.ZLIB_RUNTIME_VERSION}


def require_profile(profile):
    need(type(profile) is dict and profile == PROFILE, "TARGET_PROFILE_UNKNOWN")


def private_root(root):
    root = pathlib.Path(root)
    info = root.lstat()
    need(root.is_absolute() and root.resolve() == root and stat.S_ISDIR(info.st_mode)
         and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "PRIVATE_ROOT")
    return root


def environment(root):
    # Closed child environment: no credentials, proxy, Python/Node injection or arbitrary LD path.
    return {"PATH": "/usr/bin:/bin", "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"),
            "LANG": "C.UTF-8", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "NO_SQLITE": "1", "SEMGREP_SEND_METRICS": "off",
            "SEMGREP_ENABLE_VERSION_CHECK": "0", "OTEL_SDK_DISABLED": "true",
            "SEMGREP_MCP_DISABLE_TRACING": "true", "USE_SEMGREP_RPC": "false"}


def checked_bytes(name, raw):
    need(name in AUDIT_SOURCES and type(raw) is bytes and 0 < len(raw) <= 65536,
         "AUDIT_SOURCE_INVENTORY")
    need(hashlib.sha256(raw).hexdigest() == AUDIT_SOURCES[name], "AUDIT_SOURCE_HASH")
    return raw


def committed_source(root, workspace, head, path):
    need(re.fullmatch(r"[a-f0-9]{40}", head) is not None, "COMMITTED_HEAD")
    allowed = {".github/semgrep/" + name for name in AUDIT_SOURCES}
    allowed.add(".github/semgrep/source-runtime-qualification.py")
    need(path in allowed, "AUDIT_SOURCE_INVENTORY")
    def git(*args):
        return subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(workspace), *args],
                              env=environment(root), check=True, capture_output=True, timeout=15).stdout
    need(git("rev-parse", "HEAD").decode().strip() == head, "CHECKOUT_CHANGED")
    record = git("ls-tree", "-z", head, "--", path)
    need(re.fullmatch(rb"100644 blob [a-f0-9]{40}\t" + re.escape(path.encode()) + rb"\x00", record)
         is not None, "AUDIT_GIT_REGULAR_BLOB")
    blob = record.split(b"\t", 1)[0].split()[2].decode()
    size = int(git("cat-file", "-s", blob))
    need(0 < size <= 65536, "AUDIT_SOURCE_BOUND")
    raw = git("cat-file", "blob", blob)
    need(len(raw) == size, "AUDIT_GIT_BYTES")
    name = path.rsplit("/", 1)[1]
    expected = AUDIT_SOURCES.get(name)
    if expected is None:
        expected = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    need(hashlib.sha256(raw).hexdigest() == expected,
         "EXECUTED_QUALIFIER_DIFFERS_FROM_HEAD" if name == "source-runtime-qualification.py"
         else "AUDIT_SOURCE_HASH")
    return raw


def committed_blob(root, workspace, head, name):
    need(name in AUDIT_SOURCES, "AUDIT_SOURCE_INVENTORY")
    return checked_bytes(name, committed_source(root, workspace, head, ".github/semgrep/" + name))


def stage_auditor(root, workspace, head, phase, read=committed_blob):
    root = private_root(root)
    need(phase in PHASES, "AUDIT_PHASE")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="audit-code-" + phase + "-", dir=root))
    for name in AUDIT_SOURCES:
        raw = checked_bytes(name, read(root, workspace, head, name))
        with (stage / name).open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    return stage / "runtime-compatibility-audit.py"


def run_checked(root, argv, phase, seconds):
    root = private_root(root)
    need(re.fullmatch(r"[a-z][a-z0-9-]{0,63}", phase) is not None, "STEP_NAME")
    need(isinstance(seconds, (int, float)) and 0 < seconds <= 300, "STEP_BOUND")
    log = root / (phase + ".log")
    with log.open("xb") as output:
        try:
            child = subprocess.Popen(list(map(str, argv)), cwd=root, env=environment(root),
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                     start_new_session=True)
        except OSError as error:
            raise QualificationBlocked("STEP_UNAVAILABLE:" + phase) from error
        try:
            status = child.wait(timeout=seconds)
        except subprocess.TimeoutExpired as error:
            # Only this Popen's NEW session group; never a peer worker or host-wide target.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The owned group already exited; still report the original timeout, not healthy.
                child.wait()
            child.wait()
            raise QualificationBlocked("STEP_TIMEOUT:" + phase) from error
    need(status == 0, "STEP_FAILED:" + phase + ":" + str(status))
    need(log.stat().st_size <= 8 << 20, "STEP_OUTPUT_BOUND:" + phase)
    return {"phase": phase, "exitCode": status, "log": log.name}


def audit_runtime(root, workspace, head, run=run_checked, profile=None):
    require_profile(current_profile() if profile is None else profile)
    root = private_root(root)
    deadline = time.monotonic() + 900
    results = []
    for phase in PHASES:
        left = deadline - time.monotonic()
        need(left > 0, "AUDIT_DEADLINE")
        auditor = stage_auditor(root, workspace, head, phase)
        results.append(run(root, [sys.executable, "-I", "-S", auditor, "--phase", phase,
                                  "--root", root, "--workspace", workspace, "--head", head],
                           phase, min(PHASE_SECONDS[phase], left)))
    # The trusted audit already ran ordinary pip check and exact installed/engine checks.
    # MCP startup/auth, scanner controls and corpus inventories are STILL separate evidence.
    return {"state": "INDEPENDENT_AUDITS_COMPLETE_NOT_RUNTIME_QUALIFIED", "head": head,
            "profile": PROFILE, "steps": results, "runtimeQualified": False,
            "mcpApiQualified": False, "httpAuthQualified": False, "wholeCorpusQualified": False,
            "pilotDefaultOff": True, "ownerOverrideUnchanged": True}


def stage_probe(root, workspace, head):
    raw = committed_source(root, workspace, head, ".github/semgrep/source-runtime-qualification.py")
    need(raw == pathlib.Path(__file__).read_bytes(), "EXECUTED_QUALIFIER_DIFFERS_FROM_HEAD")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="installed-probe-code-", dir=private_root(root)))
    target = stage / "source-runtime-qualification.py"
    with target.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return target


def install_runtime(root, workspace, head, audit=audit_runtime, run=run_checked):
    """Maintained Scan install composition. Scanner/corpus/merge authority remains separate."""
    root = private_root(root)
    result = audit(root, workspace, head)
    need(type(result) is dict and type(result.get("steps")) is list
         and all(type(step) is dict and type(step.get("exitCode")) is int for step in result["steps"]),
         "AUDIT_SEQUENCE_INCOMPLETE")
    need(result.get("state") == "INDEPENDENT_AUDITS_COMPLETE_NOT_RUNTIME_QUALIFIED"
         and result.get("head") == head and result.get("profile") == PROFILE
         and [step.get("phase") for step in result.get("steps", [])] == list(PHASES)
         and all(step.get("exitCode") == 0 for step in result["steps"]), "AUDIT_SEQUENCE_INCOMPLETE")
    with (root / "source-qualification-audits.json").open("x") as stream:
        json.dump(result, stream, sort_keys=True)
    probe = stage_probe(root, workspace, head)
    run(root, [root / "runtime-env/bin/python", "-I", "-B", probe, "--probe-mcp-root", root], "mcp", 90)
    path = root / "mcp-qualification.json"
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 65536, "MCP_RECEIPT_BOUND")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        opened = os.fstat(stream.fileno())
        raw = stream.read(65537)
        after = os.fstat(stream.fileno())
    identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
    need(identity(before) == identity(opened) == identity(after) == identity(path.lstat())
         and len(raw) == before.st_size, "MCP_RECEIPT_CHANGED_DURING_READ")
    proof = json.loads(raw)
    need(type(proof) is dict, "MCP_RECEIPT_UNKNOWN")
    need(proof == validate_mcp_observations(proof.get("observations")), "MCP_RECEIPT_CHANGED")
    return {"state": "HASH_BOUND_INSTALL_AND_MCP_CONTROLS_COMPLETE", "head": head,
            "profile": PROFILE, "installedClosureQualified": True, "mcpApiQualified": True,
            "httpAuthQualified": True, "productionOAuthIdentity": "NOT_QUALIFIED",
            "runtimeQualified": False, "wholeCorpusQualified": False,
            "pilotDefaultOff": True, "ownerOverrideUnchanged": True,
            "auditsSha256": hashlib.sha256((root / "source-qualification-audits.json").read_bytes()).hexdigest(),
            "mcpSha256": hashlib.sha256(raw).hexdigest(),
            "authority": "Install/MCP controls only; original scanner controls, corpus inventory and normal PR gates remain mandatory."}


def validate_language_response(response):
    need(type(response) is dict and response.get("isError") is False, "MCP_LANGUAGE_RESULT_UNKNOWN")
    content = response.get("content")
    need(type(content) is list and len(content) == 1 and type(content[0]) is dict
         and content[0].get("type") == "text", "MCP_LANGUAGE_CONTENT_UNKNOWN")
    text = content[0].get("text")
    need(type(text) is str and 0 < len(text) < 32768
         and text.startswith("supported languages are: "), "MCP_LANGUAGE_SCHEMA_CHANGED")
    names = text.removeprefix("supported languages are: ").split(", ")
    need(len(names) > 20 and len(set(names)) == len(names)
         and all(re.fullmatch(r"[a-z0-9_#+.-]{1,40}", name) for name in names)
         and {"javascript", "typescript"}.issubset(names), "MCP_LANGUAGE_SENTINELS_MISSING")
    need(response.get("structuredContent") == {"result": [text]}, "MCP_LANGUAGE_FORMATS_DIFFER")
    return {"count": len(names), "sha256": hashlib.sha256(text.encode()).hexdigest()}


def validate_mcp_observations(observed):
    need(type(observed) is dict, "MCP_OBSERVATIONS_UNKNOWN")
    need(observed.get("versions") == {"semgrep": "1.181.0+remudero.1", "mcp": "1.30.0"},
         "MCP_INSTALLED_IDENTITY")
    for name in ("initialized", "upstreamLifespan", "languages", "shutdown", "listenerClosed",
                 "disallowedLoopbackDenied", "localIdentityRead", "identityListenerClosed", "languageSentinels"):
        need(observed.get(name) is True, "MCP_INCOMPLETE:" + name)
    need(type(observed.get("tools")) is list and len(observed["tools"]) == len(MCP_TOOLS)
         and all(type(name) is str for name in observed["tools"])
         and set(observed["tools"]) == MCP_TOOLS,
         "MCP_REGISTRATION")
    need(observed.get("prompts") == 2 and observed.get("resources") == 2, "MCP_API_INVENTORY")
    expected = {"missing": 401, "wrong": 401, "expired": 401, "audience": 401, "scope": 403,
                "host": 421, "origin": 403}
    need(observed.get("denied") == expected, "MCP_AUTH_OR_TRANSPORT_UNKNOWN")
    need(type(observed.get("loopbackConnections")) is int and observed["loopbackConnections"] > 0
         and type(observed.get("ownedCommands")) is int and observed["ownedCommands"] >= 2,
         "MCP_EFFECT_CORPUS_UNKNOWN")
    return {"state": "MCP_API_AND_DISPOSABLE_AUTH_CONTROLS_COMPLETE", "mcpApiQualified": True,
            "httpAuthQualified": True, "runtimeQualified": False, "wholeCorpusQualified": False,
            "productionOAuthIdentity": "NOT_QUALIFIED", "pilotDefaultOff": True,
            "ownerOverrideUnchanged": True, "observations": observed}


@contextmanager
def local_identity_fixture(token):
    """Disposable API data through upstream's SEMGREP_URL seam, never a live identity grant."""
    counts = {"accepted": 0, "refused": 0, "user": 0, "deployments": 0}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never serialize the ephemeral bearer or a request containing it.

        def do_GET(self):
            kind = {"/api/auth/users/current": "user", "/api/v2/deployments": "deployments"}.get(self.path)
            allowed = kind is not None and secrets.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + token)
            counts["accepted" if allowed else "refused"] += 1
            payload = {}
            if allowed:
                counts[kind] += 1
                payload = {"user": {"id": 1, "name": "Disposable qualification fixture",
                                    "email": "fixture@localhost", "login": "not-a-live-user"}} if kind == "user" else {
                    "deployments": [{"id": 1, "name": "disposable-qualification-only"}]}
            raw = json.dumps(payload).encode()
            self.send_response(200 if allowed else 401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fixture = {"url": "http://127.0.0.1:" + str(server.server_port), "counts": counts, "closed": False}
    try:
        yield fixture
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        need(not thread.is_alive(), "MCP_IDENTITY_FIXTURE_SHUTDOWN_UNKNOWN")
        fixture["closed"] = True


async def probe_installed_mcp(root):
    """Actual installed upstream registration/lifespan; disposable SDK auth, never a live issuer."""
    root = private_root(root)
    require_profile(current_profile())
    prefix = pathlib.Path(sys.prefix).resolve()
    need(prefix == root / "runtime-env" and sys.flags.isolated, "MCP_PRIVATE_INSTALLED_PREFIX")
    versions = {name: importlib.metadata.version(name) for name in ("semgrep", "mcp")}
    need(versions == {"semgrep": "1.181.0+remudero.1", "mcp": "1.30.0"}, "MCP_INSTALLED_IDENTITY")
    for name in versions:
        need(pathlib.Path(importlib.metadata.distribution(name).locate_file(name + "/__init__.py"))
             .resolve().is_relative_to(prefix), "MCP_IMPORT_OUTSIDE_PREFIX")
    os.environ.update(environment(root))
    os.environ["PATH"] = str(prefix / "bin") + ":/usr/bin:/bin"
    effects = {"loopbackConnections": 0, "ownedCommands": 0}
    class ForbiddenProbeEffect(PermissionError):
        """Refuse an effect before the syscall; no permissive fallback."""
    def effect_guard(event, args):
        if event in {"socket.connect", "socket.bind"}:
            address = args[1]
            if not isinstance(address, tuple) or address[0] not in {"127.0.0.1", "::1"}:
                raise ForbiddenProbeEffect("MCP_NON_LOOPBACK_EFFECT")
            if event == "socket.connect":
                effects["loopbackConnections"] += 1
        if event == "socket.getaddrinfo" and args[0] not in {"127.0.0.1", "::1", "localhost"}:
            raise ForbiddenProbeEffect("MCP_EXTERNAL_DNS")
        if event == "subprocess.Popen":
            executable, argv = pathlib.Path(args[0]).resolve(), args[1]
            if not executable.is_relative_to(prefix) or "login" in argv or "install-semgrep-pro" in argv \
                    or ("--pro" in argv and "--version" not in argv):
                raise ForbiddenProbeEffect("MCP_UNAPPROVED_COMMAND")
            effects["ownedCommands"] += 1
    sys.addaudithook(effect_guard)
    # A real denied syscall, but still loopback if the guard breaks: no external-network test effect.
    with socket.socket() as denied_socket:
        try:
            denied_socket.connect(("127.0.0.2", 9))
        except ForbiddenProbeEffect:
            disallowed_denied = True
        else:
            raise QualificationBlocked("MCP_NETWORK_GUARD_NOT_LOAD_BEARING")
    token = secrets.token_urlsafe(32)  # disposable, never serialized into a receipt/log
    with local_identity_fixture(token) as identity:
        # Real SemgrepContext reads the SDK bearer using its supported URL setting.
        # The first probe correctly refused its default live endpoint; no SDK or upstream shim.
        os.environ["SEMGREP_URL"] = identity["url"]
        observed = await exercise_installed_mcp(root, versions, token, effects, disallowed_denied, identity)
    observed["identityListenerClosed"] = identity["closed"]
    # Retain incomplete observations too; a later validator refusal never erases the measured corpus.
    stamp = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()[:16]
    with (root / ("mcp-observations-" + stamp + ".json")).open("x") as stream:
        json.dump(observed, stream, sort_keys=True)
    return validate_mcp_observations(observed)


async def exercise_installed_mcp(root, versions, token, effects, disallowed_denied, identity):
    import httpx
    import uvicorn
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from mcp.server.auth.provider import AccessToken
    from mcp.server.auth.settings import AuthSettings
    from mcp.server.fastmcp import FastMCP
    from mcp.server.transport_security import TransportSecuritySettings
    from pydantic import AnyHttpUrl
    from semgrep.mcp.server import register, deregister_tools, server_lifespan
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    listener.setblocking(False)
    url = "http://127.0.0.1:" + str(listener.getsockname()[1])
    class LocalVerifier:
        async def verify_token(self, received):
            if received not in {token, token + "-expired", token + "-audience", token + "-scope"}:
                return None
            return AccessToken(token=received, client_id="qualification-only", scopes=[] if received == token + "-scope"
                               else ["fixture-read"], expires_at=1 if received == token + "-expired" else None,
                               resource=url + ("/wrong" if received == token + "-audience" else "/mcp"))
    lifecycle = {"opened": 0, "closed": 0}
    @asynccontextmanager
    async def upstream_lifecycle(server_instance):
        async with server_lifespan(server_instance) as context:
            need(context.process is None and context.use_rpc is False, "MCP_RPC_OR_PRO_DAEMON")
            lifecycle["opened"] += 1
            yield context  # the actual upstream context, not a replacement test object
        lifecycle["closed"] += 1
    app = FastMCP("Semgrep qualification", host="127.0.0.1", port=listener.getsockname()[1],
                  stateless_http=False, json_response=True, lifespan=upstream_lifecycle,
                  token_verifier=LocalVerifier(),
                  auth=AuthSettings(issuer_url=AnyHttpUrl(url + "/fixture-issuer"),
                                    resource_server_url=AnyHttpUrl(url + "/mcp"),
                                    required_scopes=["fixture-read"], validate_token_resource=True),
                  transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,
                      allowed_hosts=["127.0.0.1:*", "localhost:*"],
                      allowed_origins=["http://127.0.0.1:*", "http://localhost:*"]))
    register(app)
    deregister_tools(app, "streamable-http")
    server = uvicorn.Server(uvicorn.Config(app.streamable_http_app(), log_level="error", lifespan="on"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    observed = {"versions": versions,
                "disallowedLoopbackDenied": disallowed_denied, "denied": {}}
    try:
        async with asyncio.timeout(60):
            for _ in range(300):
                if server.started:
                    break
                need(not serving.done(), "MCP_STARTUP_FAILED")
                await asyncio.sleep(0.01)
            need(server.started, "MCP_LISTENER_UNKNOWN")
            async with httpx.AsyncClient(headers={"Authorization": "Bearer " + token},
                                         timeout=5, trust_env=False, follow_redirects=False) as client:
                async with streamable_http_client(url + "/mcp", http_client=client) as streams:
                    async with ClientSession(streams[0], streams[1]) as session:
                        initialized = await session.initialize()
                        observed["initialized"] = initialized.serverInfo.name == "Semgrep qualification"
                        observed["tools"] = sorted(tool.name for tool in (await session.list_tools()).tools)
                        observed["prompts"] = len((await session.list_prompts()).prompts)
                        observed["resources"] = len((await session.list_resources()).resources)
                        languages = await session.call_tool("get_supported_languages", {})
                        raw = languages.model_dump_json().encode()
                        need(len(raw) <= 65536, "MCP_LANGUAGE_DIAGNOSTIC_BOUND")
                        stamp = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()[:16]
                        with (root / ("mcp-language-" + stamp + ".json")).open("xb") as stream:
                            stream.write(raw)  # private diagnostic only, never a PR body or source export
                        observed["languageInventory"] = validate_language_response(json.loads(raw))
                        observed["languages"] = True
                        observed["languageSentinels"] = True
                        payload = {"jsonrpc": "2.0", "id": 71, "method": "initialize", "params": {
                            "protocolVersion": initialized.protocolVersion, "capabilities": {},
                            "clientInfo": {"name": "disposable-negative", "version": "1"}}}
                        async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False) as negatives:
                            for name in ("missing", "wrong", "expired", "audience", "scope", "host", "origin"):
                                headers = {"Accept": "application/json, text/event-stream", "Authorization": "Bearer " + token}
                                if name == "missing":
                                    del headers["Authorization"]
                                elif name == "wrong":
                                    headers["Authorization"] = "Bearer not-the-fixture-token"
                                elif name in {"expired", "audience", "scope"}:
                                    headers["Authorization"] += "-" + name
                                elif name == "host":
                                    headers["Host"] = "forbidden.invalid"
                                elif name == "origin":
                                    headers["Origin"] = "https://forbidden.invalid"
                                response = await negatives.post(url + "/mcp", json=payload, headers=headers)
                                observed["denied"][name] = response.status_code
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=10)
        listener.close()
    observed["shutdown"] = serving.done() and not serving.cancelled() and serving.exception() is None
    observed["upstreamLifespan"] = lifecycle["opened"] > 0 and lifecycle["closed"] == lifecycle["opened"]
    async with httpx.AsyncClient(timeout=2, trust_env=False) as closed_client:
        try:
            await closed_client.get(url + "/mcp")
        except httpx.ConnectError:
            observed["listenerClosed"] = True
        else:
            raise QualificationBlocked("MCP_LISTENER_NOT_CLOSED")
    observed.update(effects)
    observed["localIdentityRead"] = identity["counts"]["user"] > 0 and identity["counts"]["deployments"] > 0 \
        and identity["counts"]["refused"] == 0
    return observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--audit-root")
    action.add_argument("--install-root")
    action.add_argument("--probe-mcp-root")
    parser.add_argument("--workspace")
    parser.add_argument("--head")
    args = parser.parse_args()
    if args.probe_mcp_root:
        need(sys.flags.isolated and not sys.flags.no_site, "INSTALLED_PROBE_ISOLATION")
        root = private_root(args.probe_mcp_root)
        result = asyncio.run(probe_installed_mcp(root))
        receipt = root / "mcp-qualification.json"
    else:
        need(sys.flags.isolated and sys.flags.no_site, "PARENT_ISOLATION")
        need(args.workspace is not None and args.head is not None, "AUDIT_INPUTS_UNKNOWN")
        root = private_root(args.install_root or args.audit_root)
        if args.install_root:
            result = install_runtime(root, pathlib.Path(args.workspace), args.head)
            receipt = root / "install-mcp-qualification.json"
        else:
            result = audit_runtime(root, pathlib.Path(args.workspace), args.head)
            receipt = root / "source-qualification-audits.json"
    with receipt.open("x") as stream:
        json.dump(result, stream, sort_keys=True)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
