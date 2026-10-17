"""Trusted source-recipe staging; runtime locks and Scan adoption are separate.

Only first-party, independently hash-bound assembler/policy bytes are evaluated.
Original source/donor archives remain inert inputs, never imported or rewritten.
The assembler runs in this Python -I -S parent, NOT an environment-losing child.
Synthetic source/receipt controls are not real-artifact or runtime qualification.
"""
import hashlib
import os
import pathlib
import platform
import re
import stat
import sys
import types
import zlib

ASSEMBLER_SHA256 = "96eb19457f4799979e691459ad19ba761ab498d6576470db7c77eb5708171274"
POLICY_SHA256 = "5cf435e3bb81a52e1583ea00008d0e46a3c0ec64d920fe6720d59f88870bd83a"
SOURCE_VERSION = "1.181.0+remudero.1"
SOURCE_WHEEL_SHA256 = "95b93c166f3ebaad3b407bfd4bf573499e1560b46c6500980e8d9acfc96fae52"
SOURCE_WHEEL = "semgrep-1.181.0+remudero.1-cp312-none-manylinux_2_34_x86_64.whl"
MCP_PIN = ("1.30.0", "666edb5009503e1047c9d60346a756f94b261f05cc2625f23d41c728ffc484d0")
ENGINE_SHA256 = "14f4b18720d881156bc0cc507b19130aa8d8db0882a5a479fb3919aadefca857"
SOURCE_ARCHIVE = ("semgrep-1.181.0.tar.gz", "4c0905288ccf9ee5330e766f1c677a31642a4cc0aac5a95097e7563f3f3a92fa")
DONOR_ARCHIVE = (
    "semgrep-1.181.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_x86_64.whl",
    "c142ec04a2ed144970cb0a92f6877651dd3c088505eec737bb7f4db7ae5f0ffa",
)
ASSEMBLY_PROFILE = {"python": "3.12.15", "platform": "linux", "machine": "x86_64",
                    "zlib": "1.3", "zipCompression": "DEFLATE", "zipCompressionLevel": 9}


class RecipeBlocked(ValueError):
    """Named refusal; no fallback recipe, alternate interpreter or resolver."""


def need(condition, reason):
    if not condition:
        raise RecipeBlocked(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def select_recipe(runtime):
    semgrep = runtime.get("semgrep")
    need(isinstance(semgrep, tuple) and len(semgrep) == 2, "RUNTIME_RECIPE")
    if semgrep[0] == "1.180.0":
        # Preserve legacy selection semantics. Full lock/artifact binding and
        # the original mcp==1.29.0 dependency edge still run in the auditor.
        return {"sourceBuilt": False, "distributionVersion": "1.180.0", "cliVersion": "1.180.0"}
    need(semgrep[0] == SOURCE_VERSION, "RUNTIME_RECIPE")
    need(semgrep == (SOURCE_VERSION, SOURCE_WHEEL_SHA256), "SOURCE_RECIPE_PIN")
    need(runtime.get("mcp") == MCP_PIN, "SOURCE_RECIPE_MCP")
    return {"sourceBuilt": True, "distributionVersion": SOURCE_VERSION,
            "cliVersion": "1.181.0", "engineSha256": ENGINE_SHA256}


def wheel_download_lock(pins):
    excluded = {"peewee"}
    if select_recipe(pins)["sourceBuilt"]:
        excluded.add("semgrep")  # private distribution MUST NOT reach pip/PyPI
    for name, pin in pins.items():
        need(re.fullmatch(r"[a-z0-9][a-z0-9._-]*", name) is not None
             and isinstance(pin, tuple) and len(pin) == 2
             and re.fullmatch(r"[A-Za-z0-9.!+_-]+", pin[0]) is not None
             and re.fullmatch(r"[a-f0-9]{64}", pin[1]) is not None, "SOURCE_DOWNLOAD_PIN")
    return "".join(f"{name}=={version} --hash=sha256:{sha}\n"
                   for name, (version, sha) in sorted(pins.items()) if name not in excluded)


def validate_profile(profile):
    need(type(profile) is dict and profile == ASSEMBLY_PROFILE
         and type(profile.get("zipCompressionLevel")) is int, "SOURCE_BUILD_PROFILE")


def current_profile():
    return {"python": platform.python_version(), "platform": sys.platform, "machine": platform.machine(),
            "zlib": zlib.ZLIB_RUNTIME_VERSION, "zipCompression": "DEFLATE", "zipCompressionLevel": 9}


def verify_code_bytes(assembler, policy):
    need(type(assembler) is bytes and 0 < len(assembler) <= 65536
         and digest(assembler) == ASSEMBLER_SHA256, "SOURCE_ASSEMBLER_HASH")
    need(type(policy) is bytes and 0 < len(policy) <= 32768
         and digest(policy) == POLICY_SHA256, "SOURCE_POLICY_HASH")


def _regular(path, maximum):
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum, "SOURCE_INPUT_REGULAR")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        opened = os.fstat(stream.fileno())
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    final = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    need(identity(before) == identity(opened) == identity(after) == identity(final)
         and len(raw) == before.st_size, "SOURCE_INPUT_CHANGED")
    return raw


def load_assembler():
    # Fixed siblings only: workflow/unit staging obtains exact regular Git blobs.
    parent = pathlib.Path(__file__).absolute().parent
    path = parent / "prepare-source-build.py"
    raw, policy = _regular(path, 65536), _regular(parent / "source-build-policy.json", 32768)
    verify_code_bytes(raw, policy)  # BEFORE compile/exec; never trust a filename
    module = types.ModuleType("_bound_first_party_semgrep_assembler")
    module.__file__ = str(path)
    exec(compile(raw, str(path), "exec", dont_inherit=True), module.__dict__)
    return module, module.load_policy()


def validate_assembly_receipt(receipt):
    need(type(receipt) is dict, "SOURCE_ASSEMBLY_BINDING")
    validate_profile(receipt.get("buildProfile"))
    expected = {"schema": "rmd-semgrep-source-assembly/v1",
                "state": "SOURCE_ASSEMBLED_NOT_RUNTIME_QUALIFIED", "wheel": SOURCE_WHEEL,
                "wheelSha256": SOURCE_WHEEL_SHA256, "builderSha256": ASSEMBLER_SHA256,
                "policySha256": POLICY_SHA256, "sourceArchiveSha256": SOURCE_ARCHIVE[1],
                "engineDonorArchiveSha256": DONOR_ARCHIVE[1], "upstreamVersion": "1.181.0",
                "distributionVersion": SOURCE_VERSION, "engineVersion": "1.181.0"}
    need(all(receipt.get(k) == v for k, v in expected.items()), "SOURCE_ASSEMBLY_BINDING")
    need(all(receipt.get(k) is False for k in
             ("engineRecompiled", "candidateExecution", "buildHooksExecuted", "networkAccessUsed",
              "runtimeQualified", "dependencyClosureQualified", "wholeCorpusQualified", "published"))
         and receipt.get("pythonProtocolVersionUnchanged") is True
         and receipt.get("pilotDefaultOff") is True, "SOURCE_ASSEMBLY_BOUNDARY")


def validate_source_wheel(raw):
    need(type(raw) is bytes and 0 < len(raw) <= 128 << 20
         and digest(raw) == SOURCE_WHEEL_SHA256, "SOURCE_WHEEL_HASH")


def prepare_source_artifact(root, raw_release, once, json_once):
    """Raw TLS fetch + inert parent assembly; called only for the fixed recipe.

    Callbacks are the existing trusted auditor functions, not candidate hooks.
    No child, PYTHON selection, environment relaxation or candidate path import.
    Source inputs/assembly receipts stay OUTSIDE the artifacts population.
    """
    need(sys.flags.isolated and sys.flags.no_site, "SOURCE_PARENT_ISOLATION")
    validate_profile(current_profile())  # refuse BEFORE fetching any source input
    assembler, _policy = load_assembler()
    inputs = root / "source-inputs"
    inputs.mkdir(mode=0o700)  # exclusive, owned private root; no retry/reuse
    for filename, sha256 in (SOURCE_ARCHIVE, DONOR_ARCHIVE):
        raw_release("semgrep", "1.181.0", filename, sha256, inputs / filename)
    assembled = inputs / "assembled"
    receipt = assembler.prepare(inputs / SOURCE_ARCHIVE[0], inputs / DONOR_ARCHIVE[0], assembled)
    validate_assembly_receipt(receipt)
    wheel = _regular(assembled / SOURCE_WHEEL, 128 << 20)
    validate_source_wheel(wheel)
    once(root / "artifacts" / SOURCE_WHEEL, wheel)  # only after BOTH bindings pass
    json_once(root / "source-recipe-audit.json", {
        "state": "EXACT_INERT_SOURCE_RECIPE_ASSEMBLED_NOT_RUNTIME_QUALIFIED",
        "assembly": receipt, "assemblerSha256": ASSEMBLER_SHA256, "policySha256": POLICY_SHA256,
        "rawSourceDownloads": 2, "networkAccessUsed": True,
        "networkScope": "Raw TLS acquisition only; nested assembly itself performs no network access.",
        "runtimeQualified": False, "originalMetadataClosureQualified": False,
        "mcpApiQualified": False, "httpAuthQualified": False, "pilotDefaultOff": True,
    })


def create_private_venv(root, basename, run):
    """Create a NEW entry only; no chmod, reuse or repair of existing paths.

    The umask is process-local, inherited only by this creation child, and
    restored even on failure. Existing fixture/host permissions never change.
    """
    need(basename in {"build-env", "runtime-env"}, "VENV_BASENAME")
    root_stat = root.lstat()
    need(root.is_absolute() and root.resolve() == root and stat.S_ISDIR(root_stat.st_mode)
         and root_stat.st_uid == os.getuid() and root_stat.st_mode & 0o077 == 0, "VENV_PARENT_PRIVATE")
    target = root / basename
    need(not target.exists() and not target.is_symlink(), "VENV_ENTRY_EXISTS")
    target.mkdir(mode=0o700)  # exclusive NEW directory, never a mode repair
    def private_entry():
        row = target.lstat()
        return (stat.S_ISDIR(row.st_mode) and row.st_uid == os.getuid()
                and row.st_mode & 0o777 == 0o700 and target.resolve() == target)
    need(private_entry(), "VENV_ENTRY_PRIVATE")
    previous = os.umask(0o077)
    try:
        run(root, [sys.executable, "-I", "-S", "-m", "venv", "--without-pip", target])
    finally:
        os.umask(previous)
    need(private_entry(), "VENV_ENTRY_PRIVATE")
    return target


def verify_source_runtime(root, run):
    """ADDITIONAL installed checks after original/built audits and hash install.

    No MCP startup, authentication, model call, listener, rule or corpus scan.
    Existing trusted run() owns environment/timeout; do not inherit arbitrary LD.
    """
    code = (
        "import hashlib,importlib.metadata as m,pathlib,subprocess,sys,semgrep;"
        "from semgrep.semgrep_core import SemgrepCore;"
        "prefix=pathlib.Path(sys.prefix).resolve();"
        "assert m.version('semgrep')=='1.181.0+remudero.1';"
        "assert m.version('mcp')=='1.30.0' and semgrep.__VERSION__=='1.181.0';"
        "assert pathlib.Path(semgrep.__file__).resolve().is_relative_to(prefix);"
        "assert pathlib.Path(m.distribution('mcp').locate_file('mcp/__init__.py')).resolve().is_relative_to(prefix);"
        "engine=pathlib.Path(SemgrepCore.executable_path()).resolve();"
        "assert engine.is_relative_to(prefix);"
        "stream=engine.open('rb');engine_hash=hashlib.file_digest(stream,'sha256').hexdigest();stream.close();"
        "assert engine_hash=='" + ENGINE_SHA256 + "';"
        "result=subprocess.run([str(engine),'-version'],check=True,capture_output=True,text=True,timeout=15);"
        "assert result.stdout.strip()=='semgrep-core version: 1.181.0 (0f6e09374a)'"
    )
    run(root, [root / "runtime-env/bin/python", "-I", "-c", code])
