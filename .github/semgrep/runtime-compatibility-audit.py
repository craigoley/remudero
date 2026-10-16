"""Independent original-artifact metadata and install-layout audit.

Run from trusted, digest-bound workflow bytes with Python -I -S before candidate
metadata/build hooks or installation. Candidate wheels stay inert until original
and built-artifact audits succeed. Installed pip check remains an ADDITIONAL test,
never the sole compatibility authority. No observed-host or candidate API fallback.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import ssl
import subprocess
import tempfile
import urllib.parse
import urllib.request
import csv
import email.policy
import gzip
import hashlib
import importlib.metadata
import io
import pathlib
import re
import stat
import sys
import tarfile
import zipfile
from email.parser import BytesParser
from types import SimpleNamespace

APPROVED_TOOLS = {
    "pip": ("26.2.1", "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"),
    "setuptools": ("84.0.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"),
    "packaging": ("26.3", "d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c"),
    "wheel": ("0.48.0", "3217dcc807155e45db462d7ef2431f5ddda0d7273b700d05a67b271ceb1287ab"),
}
APPROVED_PEEWEE = ("3.18.3", "62c3d93315b1a909360c4b43c3a573b47557a1ec7a4583a71286df2a28d4b72e")
MAX_ARCHIVE = 256 << 20
MAX_EXPANDED = 512 << 20
MAX_ALL_EXPANDED = 1 << 30
MAX_SDIST_EXPANDED = 64 << 20
MAX_METADATA = 2 << 20
MAX_MEMBERS = 20_000
MAX_PACKAGES = 128
TOOL_ROOT_OWNERS = {"pip": "pip", "setuptools": "setuptools", "pkg_resources": "setuptools",
                    "_distutils_hack": "setuptools", "packaging": "packaging", "wheel": "wheel"}
RESERVED_COMMAND_OWNERS = {"pip": "pip", "pip3": "pip", "pip3.12": "pip", "wheel": "wheel",
                           "semgrep": "semgrep", "pysemgrep": "semgrep", "semgrep-core": "semgrep"}
# Exact original-artifact contributors; no name-only or inferred namespace allowance.
APPROVED_SHARED_NAMESPACES = {
    "google": frozenset({
        ("googleapis-common-protos", "1.75.5", "d7285525c23039db98f2463e6d5a4f9b958b94d497f03a844ece3259c4e72d5d"),
        ("protobuf", "6.33.6", "e9db7e292e0ab79dd108d7f1a94fe31601ce1ee3f7b79e0692043423020b0593"),
    }),
    "opentelemetry": frozenset({
        ("opentelemetry-api", "1.37.0", "accf2024d3e89faec14302213bc39550ec0f4095d1cf5ca688e1bfb1c8612f47"),
        ("opentelemetry-exporter-otlp-proto-common", "1.37.0", "53038428449c559b0c564b8d718df3314da387109c4d36bd1b94c9a641b0292e"),
        ("opentelemetry-exporter-otlp-proto-http", "1.37.0", "54c42b39945a6cc9d9a2a33decb876eabb9547e0dcb49df090122773447f1aef"),
        ("opentelemetry-instrumentation", "0.58b0", "50f97ac03100676c9f7fc28197f8240c7290ca1baa12da8bfbb9a1de4f34cc45"),
        ("opentelemetry-instrumentation-requests", "0.58b0", "672a0be0bb5b52bea0c11820b35e27edcf4cd22d34abe4afc59a92a80519f8a8"),
        ("opentelemetry-instrumentation-threading", "0.58b0", "eacc072881006aceb5b9b6831bcdce718c67ef6f31ac0b32bd6a23a94d979b4a"),
        ("opentelemetry-proto", "1.37.0", "8ed8c066ae8828bbf0c39229979bdf583a126981142378a9cbe9d6fd5701c6e2"),
        ("opentelemetry-sdk", "1.37.0", "8f3c3c22063e52475c5dbced7209495c2c16723d016d39287dfc215d1771257c"),
        ("opentelemetry-semantic-conventions", "0.58b0", "5564905ab1458b96684db1340232729fce3b5375a06e140e8904c78e4f815b28"),
        ("opentelemetry-util-http", "0.58b0", "6c6b86762ed43025fbd593dc5f700ba0aa3e09711aedc36fd48a13b23d8cb1e7"),
    }),
}
# Exact path/body exceptions only inside an already approved whole artifact.
APPROVED_SPECIAL_MEMBERS = {
    ("opentelemetry-instrumentation", "0.58b0", "50f97ac03100676c9f7fc28197f8240c7290ca1baa12da8bfbb9a1de4f34cc45"): {
        "opentelemetry/instrumentation/auto_instrumentation/sitecustomize.py": (673, "ddcfb83130a15563be3e97502e92073e9d0cf69643aa73c410dfa3721eafe265"),
    },
    ("setuptools", "84.0.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"): {
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/licenses/LICENSE": (10278, "458502e12d97bbf64438606a20044aa85eb05fb0a8a807bb35dbec253fd1fc04"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/licenses/LICENSE": (1076, "9755a18519666e5f0f4cae3daad3d7012bcae48a600b31237d75e9fe134e6683"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/licenses/LICENSE": (1076, "5a57cb4db85e2a2dd88c290628908add57e3451449e0a9a71fdfb38776fd759d"),
        "setuptools/_vendor/more_itertools-10.8.0.dist-info/licenses/LICENSE": (1053, "09f1c8c9e941af3e584d59641ea9b87d83c0cb0fd007eb5ef391a7e2643c1a46"),
        "setuptools/_vendor/packaging-26.0.dist-info/licenses/LICENSE": (197, "cad1ef5bd340d73e074ba614d26f7deaca5c7940c3d8c34852e65c4909686c48"),
        "setuptools/_vendor/packaging-26.0.dist-info/licenses/LICENSE.APACHE": (10174, "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594"),
        "setuptools/_vendor/packaging-26.0.dist-info/licenses/LICENSE.BSD": (1344, "b70e7e9b742f1cc6f948b34c16aa39ffece94196364bc88ff0d2180f0028fac5"),
        "setuptools/_vendor/platformdirs-4.4.0.dist-info/licenses/LICENSE": (1089, "29e0fd62e929850e86eb28c3fdccf0cefdf4fa94879011cffb3d0d4bed6d4db6"),
        "setuptools/_vendor/tomli-2.4.0.dist-info/licenses/LICENSE": (1072, "b80816b0d530b8accb4c2211783790984a6e3b61922c2b5ee92f3372ab2742fe"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/licenses/LICENSE.txt": (1107, "30c23618679108f3e8ea1d2a658c7ca417bdfc891c98ef1a89fa4ff0c9828654"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/licenses/LICENSE": (1076, "5a57cb4db85e2a2dd88c290628908add57e3451449e0a9a71fdfb38776fd759d"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/LICENSE": (7634, "ade78d04982d69972d444a8e14a94f87a2334dd3855cc80348ea8e240aa0df2d"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/METADATA": (15006, "3800d9b91dceea2065a6ed6279383362e97ac38b8e56b9343f404ee531860099"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/RECORD": (1072, "2bee6072cbcec6390c57107c8dfcb0422918a98ecdb5a2cc362187f13d42e96f"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/WHEEL": (92, "db07a93359e4e034b8785a58ad6d534ea3dca0635f1e184efe2e66e1c3a299ba"),
        "setuptools/_vendor/autocommand-2.2.2.dist-info/top_level.txt": (12, "0337e180a292f04740c16513485f2681e5506d7398f64a241c1ea44aac30aaed"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/LICENSE": (1023, "86da0f01aeae46348a3c3d465195dc1ceccde79f79e87769a64b8da04b2a4741"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/METADATA": (2020, "8215c54ead77d9dc5a108a25c6bdc72b5999aa6f62c9499a440359412afa5a51"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/RECORD": (1056, "0f69db719b54220d6a4adff8bfb04ac98affea3dc8b54054a1a787a17567f4d1"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/WHEEL": (92, "189eedfe4581172c1b6a02b97a8f48a14c0b5baa3239e4ca990fbd8871553714"),
        "setuptools/_vendor/backports.tarfile-1.2.0.dist-info/top_level.txt": (10, "7068da2cc3a8051d452b4029a23b73595995893b49ec91882bf1f05e212cbed5"),
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/METADATA": (4670, "a3e38b9ee4326289d4864704f30e299ee769e2309ce9f4a75f0de1a50ad0a356"),
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/RECORD": (1868, "52a6b8ee0de15cf7fd99625f43b97cd2e3942ac86f16054ea90de48e66f29355"),
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/WHEEL": (91, "ff309ddcdd65ebd02bc724dbf2bcc4a0ff53a5b61792a44548d383e4ebb19d3b"),
        "setuptools/_vendor/importlib_metadata-8.7.1.dist-info/top_level.txt": (19, "08eddf0fdcb29403625e4acca38a872d5fe6a972f6b02e4914a82dd725804fe0"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/LICENSE": (1023, "86da0f01aeae46348a3c3d465195dc1ceccde79f79e87769a64b8da04b2a4741"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/METADATA": (3731, "5c2fd09012c954f139b10624978d5335a654c34014cd06f6f466ca683dbc9c56"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/RECORD": (1157, "63b936c308d0fcbe1390e824567cc007536c32a849adb02278e95f1d4c736c31"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/WHEEL": (91, "5b287efe76740c9628947367d7f84c6b894ceee0de743fd1195c1b9938f222d9"),
        "setuptools/_vendor/jaraco.text-4.0.0.dist-info/top_level.txt": (7, "d099cddcb7d71f82c845f5cbf9014e18227341664edc42f1e11d5dfe5a2ea103"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/METADATA": (4270, "0435ebfc52055c5a9974ed20c171b6454383eaf9dbb1508814ba7ad97c59d712"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/RECORD": (777, "4599d876ceb42b7eef03aa39e235c4ebeab6aea2409dbe634496852393d1f837"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/WHEEL": (91, "ff309ddcdd65ebd02bc724dbf2bcc4a0ff53a5b61792a44548d383e4ebb19d3b"),
        "setuptools/_vendor/jaraco_context-6.1.0.dist-info/top_level.txt": (7, "d099cddcb7d71f82c845f5cbf9014e18227341664edc42f1e11d5dfe5a2ea103"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/METADATA": (2960, "2e79da8dc3469924abe3ac8b22a3feb5692a79bf9f47bbc86b6535d618641849"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/RECORD": (882, "baafd2d6d94c1bde453e4c805ac05511dc53986e0a63b02f674ef0f788bec146"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/WHEEL": (91, "ff309ddcdd65ebd02bc724dbf2bcc4a0ff53a5b61792a44548d383e4ebb19d3b"),
        "setuptools/_vendor/jaraco_functools-4.4.0.dist-info/top_level.txt": (7, "d099cddcb7d71f82c845f5cbf9014e18227341664edc42f1e11d5dfe5a2ea103"),
        "setuptools/_vendor/more_itertools-10.8.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/more_itertools-10.8.0.dist-info/METADATA": (39413, "6ab3515145abe58b067f087c867631cf4cf5d653fed81b9642ee12086c3904b8"),
        "setuptools/_vendor/more_itertools-10.8.0.dist-info/RECORD": (1095, "9ed1b134c0aa83722f36e99f3918aa9610ce3a0a514d793bbb74a368d441a01d"),
        "setuptools/_vendor/more_itertools-10.8.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/more_itertools-10.8.0.dist-info/WHEEL": (82, "1b68144734c4b66791f27add5d425f3620775585718a03d0f9b110ba3a4d88db"),
        "setuptools/_vendor/packaging-26.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/packaging-26.0.dist-info/METADATA": (3309, "3362bb7d6a26da2962ba8daaa4785cd0bacac21aba908a1195cc8f59580a265a"),
        "setuptools/_vendor/packaging-26.0.dist-info/RECORD": (2113, "f50503333aae9517807d2fb4d81fc27cb60aa644666f50176812626d6224ce5d"),
        "setuptools/_vendor/packaging-26.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/packaging-26.0.dist-info/WHEEL": (82, "1b68144734c4b66791f27add5d425f3620775585718a03d0f9b110ba3a4d88db"),
        "setuptools/_vendor/platformdirs-4.4.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/platformdirs-4.4.0.dist-info/METADATA": (12831, "bbc5216d5f4c77bfbc57227264d52e66bccde71ccf79e75e1a6046d029d30223"),
        "setuptools/_vendor/platformdirs-4.4.0.dist-info/RECORD": (1218, "3d0d2f1cc018593c4d8baa2395baf0b1c1c645bbd8c18cd064f49cb4e4c95ea0"),
        "setuptools/_vendor/platformdirs-4.4.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/platformdirs-4.4.0.dist-info/WHEEL": (87, "aad0b0a12256807936d52d4a6f88a1773236ae527564a688bab4e3fe780e8724"),
        "setuptools/_vendor/tomli-2.4.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/tomli-2.4.0.dist-info/METADATA": (10567, "f5ac0a1f8fba908b4646cd655309e91aad969b6787616ac571ca462a3832ffce"),
        "setuptools/_vendor/tomli-2.4.0.dist-info/RECORD": (822, "225430ce95640e8d4fcdb93cdae2fc38d685aec016d0e293d5fb99a695886fed"),
        "setuptools/_vendor/tomli-2.4.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/tomli-2.4.0.dist-info/WHEEL": (82, "1b68144734c4b66791f27add5d425f3620775585718a03d0f9b110ba3a4d88db"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/METADATA": (2410, "22910aa97ca89cbcc20a019e27fe31360b7929a4bd66ca0d310f99a44f6ccd35"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/RECORD": (1734, "b0297c3ada17b8727e15ddd6d1e38c8a90a997f779fcf978996f6fec62ecb702"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/WHEEL": (82, "1b68144734c4b66791f27add5d425f3620775585718a03d0f9b110ba3a4d88db"),
        "setuptools/_vendor/wheel-0.46.3.dist-info/entry_points.txt": (110, "24976d480193bcc2db2244d565400cbc628edfd16d59f09517c9a9fcd1fa7b88"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/INSTALLER": (2, "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/METADATA": (3563, "bdd67d4d16cf0bf3b893e7d18cd3d2d774adb82f37ed985bc7770c607226b35b"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/RECORD": (1078, "3bfab660a24704f84228e4bb1ce1f0e3fa9ff80e5c806352a626b2f460ead836"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/REQUESTED": (0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/WHEEL": (91, "ff309ddcdd65ebd02bc724dbf2bcc4a0ff53a5b61792a44548d383e4ebb19d3b"),
        "setuptools/_vendor/zipp-3.23.0.dist-info/top_level.txt": (5, "8806dda121df686a817d56f65ee47d26a4901c2a0eb0eb46eb2f42fcb4a9a85c"),
    },
}
AUDIT_TEST_SOURCES = {
    "runtime_audit_test_fixtures.py": "66d2d91312ab5006bef72ef6ab2daa2ea8816870e7c6f740ca296d428d58190d",
    "test_runtime_compatibility_audit.py": "f60924048b15416a87ec20d92acf79de25b1bd30feed6a675103ec1b05a40939",
}
AUDIT_TEST_INVENTORY = "c01d30b972030556e1d7a597344ef70151999007a032bb869faf5321feb9d2ca"


class AuditBlocked(ValueError):
    def __init__(self, code: str, detail: str):
        self.code, self.detail = code, detail
        super().__init__(f"{code}: {detail}")


def need(condition: bool, code: str, detail: str) -> None:
    if not condition:
        raise AuditBlocked(code, detail)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def approved_namespace_contributor(row: dict, root: str, destination: tuple) -> bool:
    identity = (row["name"], row["version"], row["sha256"])
    # The original reviewed contributors are implicit namespaces, not an
    # executable root module or an __init__.py that takes over another package.
    return (identity in APPROVED_SHARED_NAMESPACES.get(root, frozenset()) and
            len(destination) >= 3 and destination[:2] == ("site", root) and
            not (len(destination) == 3 and destination[2].lower() == "__init__.py"))


def approved_special_member(name: str, version: str, artifact_sha: str, path: str,
                            data: bytes, destination: tuple) -> bool:
    expected = APPROVED_SPECIAL_MEMBERS.get((name, version, artifact_sha), {}).get(path)
    # An install-scheme/case alias is not the reviewed archive path, even if its
    # body or logical destination happens to match an approved member.
    return (expected is not None and expected == (len(data), digest(data)) and
            destination == ("site", *safe_member(path)))


def _api_from_imported_pip(provenance: dict) -> SimpleNamespace:
    # check_package_set/PackageDetails 26.2.1 were read by main; remaining metadata
    # adapter APIs were inspected on 26.1.1 only and still require pinned controls.
    # No substitute PEP
    # 508 parser and no get_default_environment()/installed distribution scan.
    import pip
    from pip._internal.metadata.importlib._dists import Distribution
    from pip._internal.operations.check import PackageDetails, check_package_set
    from pip._internal.operations.install.wheel import get_console_script_specs
    from pip._internal.utils.packaging import check_requires_python
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.tags import parse_tag, sys_tags
    from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
    from pip._vendor.packaging.version import Version
    return SimpleNamespace(**locals())


def load_approved_pip_wheel(path: str) -> SimpleNamespace:
    """Only approved pip code enters sys.path; candidate wheels NEVER enter it.

    NOT exercised here: missing exact wheel or changed private API must be UNKNOWN
    /BLOCK in the future caller, never fallback to host pip or candidate tooling.
    """
    need(sys.flags.isolated and sys.flags.no_site, "UNSAFE_STARTUP", "requires Python -I -S")
    need(sys.version_info[:3] == (3, 12, 15) and sys.platform == "linux" and platform.machine() == "x86_64", "TARGET_UNKNOWN", "exact target required")
    need(not any(n == "pip" or n.startswith("pip.") for n in sys.modules), "TOOL_PRELOADED", "pip already imported")
    p = pathlib.Path(path)
    need(p.is_absolute() and p.is_file() and not p.is_symlink(), "TOOL_PATH", "regular approved wheel required")
    need(p.name == "pip-26.2.1-py3-none-any.whl" and p.stat().st_size <= MAX_ARCHIVE, "TOOL_PATH", "wrong/big tooling wheel")
    raw = p.read_bytes()
    need(digest(raw) == APPROVED_TOOLS["pip"][1], "TOOL_HASH", "not approved pip 26.2.1 bytes")
    # zipimport does not process .pth or site initialization. Only this already
    # approved archive is importable; never unpack/add a candidate site directory.
    sys.path.insert(0, str(p))
    import pip
    need(pip.__version__ == "26.2.1" and pip.__file__.startswith(str(p) + "/pip/"), "TOOL_ORIGIN", "unexpected pip origin")
    return _api_from_imported_pip({"state": "PINNED_API_BYTES_VERIFIED", "pip": pip.__version__,
                                  "archiveSha256": digest(raw), "path": str(p), "target": list(sys.version_info[:3])})


class _RawMetadata(importlib.metadata.Distribution):
    """Read original byte headers only; never calls finders, .load() or package imports."""
    def __init__(self, metadata: bytes, entries: bytes = b""):
        self._texts = {"METADATA": metadata.decode("utf-8"), "entry_points.txt": entries.decode("utf-8")}

    def read_text(self, filename):
        return self._texts.get(filename)

    def locate_file(self, path):
        raise AuditBlocked("NO_METADATA_FILESYSTEM", str(path))


def metadata_distribution(raw: bytes, entries: bytes, name: str, version: str, api, *, source_kind="wheel"):
    need(0 < len(raw) <= MAX_METADATA and len(entries) <= MAX_METADATA, "METADATA_BOUND", name)
    msg = BytesParser(policy=email.policy.default.clone(raise_on_defect=True)).parsebytes(raw)
    for field in ("Metadata-Version", "Name", "Version"):
        need(len(msg.get_all(field, [])) == 1, "AMBIGUOUS_METADATA", field)
    need(str(msg["Metadata-Version"]) in {"2.1", "2.2", "2.3", "2.4"}, "METADATA_VERSION_UNKNOWN", name)
    need(api.canonicalize_name(str(msg["Name"])) == name and api.Version(str(msg["Version"])) == api.Version(version), "METADATA_IDENTITY", name)
    need(len(msg.get_all("Requires-Python", [])) <= 1, "AMBIGUOUS_METADATA", "Requires-Python")
    dynamic = {v.strip().lower() for row in msg.get_all("Dynamic", []) for v in str(row).split(",")}
    need(source_kind in {"wheel", "sdist"}, "METADATA_ORIGIN", name)
    need(not dynamic.intersection({"name", "version", "metadata-version"}), "DYNAMIC_METADATA", name)
    # PEP 643: Dynamic in a wheel is information about build-time calculation,
    # NOT an instruction to run a hook or ignore final Requires-* values.
    # Source distributions may still change those fields during an actual build.
    if source_kind == "sdist":
        need(not dynamic.intersection({"requires-dist", "requires-python"}), "DYNAMIC_METADATA", name)
    need(api.check_requires_python(msg.get("Requires-Python"), sys.version_info[:3]), "REQUIRES_PYTHON", name)
    # Full PEP 508 parsing is pip's vendored packaging, including inactive rows.
    for row in msg.get_all("Requires-Dist", []):
        need(api.Requirement(str(row).strip()).url is None, "DIRECT_URL_DEPENDENCY", name)
    dist = api.Distribution(_RawMetadata(raw, entries), None, None)
    # iter_dependencies() supplies pip's exact default-extra marker filtering.
    deps = list(dist.iter_dependencies())
    return dist, deps


def safe_member(path: str) -> tuple[str, ...]:
    need(isinstance(path, str) and 0 < len(path) <= 512 and re.fullmatch(r"[!-~]+", path) is not None,
         "ARCHIVE_PATH", repr(path))
    need("\\" not in path and ":" not in path and not path.startswith("/"), "ARCHIVE_PATH", path)
    parts = tuple(path.removesuffix("/").split("/"))
    need(all(p not in {"", ".", ".."} for p in parts), "ARCHIVE_TRAVERSAL", path)
    return parts


def approved_setuptools_pth(name: str, version: str, artifact_sha: str, archive_path: str) -> bool:
    # Exact whole-artifact digest binds the actual exception bytes; filename alone
    # is never a waiver. No invented .pth content hash before the real wheel is read.
    return (name, version, artifact_sha, archive_path) == (
        "setuptools", *APPROVED_TOOLS["setuptools"], "distutils-precedence.pth")


def _wheel_destination(parts: tuple[str, ...], info_dir: str, name: str) -> tuple[str, ...]:
    if parts[0].endswith(".data"):
        need(parts[0] == info_dir.removesuffix(".dist-info") + ".data" and len(parts) >= 3, "DATA_LAYOUT", name)
        if parts[1] in {"purelib", "platlib"}:
            return ("site", *parts[2:])  # collapse aliases: conservative target CPython venv model
        if parts[1] == "scripts":
            need(len(parts) == 3, "SCRIPT_PATH", "/".join(parts))
            return ("bin", parts[2])
        raise AuditBlocked("UNREVIEWED_SCHEME", "/".join(parts))
    return ("site", *parts)


def scan_wheel(filename: str, raw: bytes, api) -> dict:
    need(len(raw) <= MAX_ARCHIVE, "ARCHIVE_BOUND", filename)
    name, version_obj, _build, filename_tags = api.parse_wheel_filename(filename)
    version, artifact_sha = str(version_obj), digest(raw)
    need(bool(filename_tags.intersection(set(api.sys_tags()))), "WHEEL_TARGET", filename)
    if name in APPROVED_TOOLS:
        need((version, artifact_sha) == APPROVED_TOOLS[name], "TOOL_ARTIFACT_NOT_APPROVED", name)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        need(0 < len(infos) <= MAX_MEMBERS, "MEMBER_BOUND", filename)
        seen, files, expanded = set(), {}, 0
        for info in infos:
            need(info.filename == info.orig_filename, "ARCHIVE_PATH", "NUL-truncated name")
            parts = safe_member(info.filename)
            need(info.filename not in seen and not info.flag_bits & 1, "DUPLICATE_OR_ENCRYPTED_MEMBER", info.filename)
            seen.add(info.filename)
            mode = stat.S_IFMT(info.external_attr >> 16)
            need(mode in {0, stat.S_IFREG, stat.S_IFDIR}, "ARCHIVE_SPECIAL_FILE", info.filename)
            if info.is_dir():
                continue
            need(mode != stat.S_IFDIR, "ARCHIVE_TYPE", info.filename)
            expanded += info.file_size
            need(info.file_size <= MAX_ARCHIVE and expanded <= MAX_EXPANDED, "EXPANSION_BOUND", filename)
            files[info.filename] = (parts, archive.read(info))  # bytes only, CRC checked; never extracted
    roots = {p[0] for p, _ in files.values() if p[0].endswith(".dist-info")}
    need(len(roots) == 1, "DIST_INFO_IDENTITY", filename)
    info_dir = next(iter(roots))
    stem_name, stem_version = info_dir.removesuffix(".dist-info").split("-", 1)
    need(api.canonicalize_name(stem_name) == name and api.Version(stem_version) == version_obj, "DIST_INFO_IDENTITY", filename)
    def member(leaf):
        key = info_dir + "/" + leaf
        need(key in files, "MISSING_WHEEL_METADATA", key)
        return files[key][1]
    metadata, record = member("METADATA"), member("RECORD")
    need(len(record) <= MAX_METADATA, "RECORD_BOUND", name)
    wheel = BytesParser(policy=email.policy.default.clone(raise_on_defect=True)).parsebytes(member("WHEEL"))
    need(wheel.get_all("Wheel-Version") == ["1.0"] and wheel.get_all("Root-Is-Purelib") in (["true"], ["false"]), "WHEEL_METADATA", name)
    declared_tags = set().union(*(api.parse_tag(str(t)) for t in wheel.get_all("Tag", [])))
    need(declared_tags == set(filename_tags), "WHEEL_TAG_MISMATCH", name)
    record_rows = list(csv.reader(io.StringIO(record.decode("utf-8"))))
    need(all(len(row) == 3 for row in record_rows) and len(record_rows) == len(files), "RECORD_INVENTORY", name)
    need(len({row[0] for row in record_rows}) == len(record_rows), "RECORD_DUPLICATE", name)
    need({row[0] for row in record_rows} == set(files), "RECORD_FOREIGN_PATH", name)
    for path, expected_hash, expected_size in record_rows:
        if path == info_dir + "/RECORD":
            need(not expected_hash and not expected_size, "RECORD_SELF", name)
        else:
            data = files[path][1]
            encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            need(expected_hash == "sha256=" + encoded and expected_size == str(len(data)), "RECORD_BYTES", path)
    entries = files.get(info_dir + "/entry_points.txt", ((), b""))[1]
    dist, dependencies = metadata_distribution(metadata, entries, name, version, api)
    destinations = []
    for path, (parts, _data) in files.items():
        destination = _wheel_destination(parts, info_dir, name)
        lower = tuple(p.lower() for p in destination)
        need(not (lower[0] == "bin" and (lower[1] == "pyvenv.cfg" or lower[1].endswith("._pth"))),
             "INTERPRETER_CONFIGURATION", path)
        exact_special = approved_special_member(name, version, artifact_sha, path, _data, destination)
        metadata_parts = [i for i, part in enumerate(lower) if part.endswith((".dist-info", ".egg-info"))]
        need(exact_special or not metadata_parts or (metadata_parts == [1] and parts[0] == info_dir and destination[1] == info_dir),
             "FOREIGN_DISTRIBUTION_METADATA", path)
        need(not any(p.endswith((".pyc", ".pyo", ".egg-link")) or p == "__pycache__" for p in lower), "STARTUP_OR_BYTECODE", path)
        need(exact_special or not any(p.split(".", 1)[0] in {"sitecustomize", "usercustomize"} for p in lower), "STARTUP_CUSTOMIZE", path)
        if any(p.endswith(".pth") for p in lower):
            need(approved_setuptools_pth(name, version, artifact_sha, path), "UNAPPROVED_PTH", path)
        destinations.append((destination, path, "archive"))
    console, gui = {}, {}
    for ep in dist.iter_entry_points():
        if ep.group not in {"console_scripts", "gui_scripts"}:
            continue
        need(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", ep.name) is not None, "ENTRYPOINT_PATH", ep.name)
        # stdlib EntryPoint properties parse strings; .load() is NEVER called.
        parsed = importlib.metadata.EntryPoint(ep.name, ep.value, ep.group)
        need(parsed.attr is not None and bool(parsed.module), "ENTRYPOINT_TARGET", ep.name)
        module_root = parsed.module.split(".", 1)[0].lower()
        need(any(d[0] == "site" and d[1].split(".", 1)[0].lower() == module_root for d, _, _ in destinations), "ENTRYPOINT_FOREIGN_MODULE", ep.name)
        (console if ep.group == "console_scripts" else gui)[ep.name] = ep.value
    # pip's own alias generation includes pip3 and pip3.12, not just declared names.
    generated = api.get_console_script_specs(dict(console)) + [n + " = " + v for n, v in gui.items()]
    for specification in generated:
        command, separator, _ = specification.partition(" = ")
        need(bool(separator) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", command) is not None, "ENTRYPOINT_GENERATION", specification)
        destinations.append((("bin", command), info_dir + "/entry_points.txt", "generated-entrypoint"))
    return {"name": name, "version": version, "sha256": artifact_sha, "kind": "wheel", "metadata": metadata,
            "dist": dist, "dependencies": dependencies, "destinations": destinations, "expandedBytes": expanded}


def scan_approved_peewee_sdist(filename: str, raw: bytes, api) -> dict:
    need(filename == "peewee-3.18.3.tar.gz" and len(raw) <= MAX_ARCHIVE and digest(raw) == APPROVED_PEEWEE[1], "SDIST_NOT_APPROVED", filename)
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as source:
        tar_bytes = source.read(MAX_SDIST_EXPANDED + 1)
    need(len(tar_bytes) <= MAX_SDIST_EXPANDED, "SDIST_EXPANSION_BOUND", filename)
    metadata, seen = None, set()
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        for index, info in enumerate(archive):
            need(index < MAX_MEMBERS, "MEMBER_BOUND", filename)
            parts = safe_member(info.name)
            need(parts[0] == "peewee-3.18.3" and info.name not in seen, "SDIST_PATH", info.name)
            seen.add(info.name)
            need(info.isfile() or info.isdir(), "SDIST_SPECIAL_FILE", info.name)
            need(info.size <= MAX_ARCHIVE, "SDIST_MEMBER_BOUND", info.name)
            if info.name == "peewee-3.18.3/PKG-INFO":
                need(info.isfile() and info.size <= MAX_METADATA, "METADATA_BOUND", info.name)
                metadata = archive.extractfile(info).read()  # raw bytes, NOT extract()/setup.py
    need(metadata is not None, "MISSING_PKG_INFO", filename)
    dist, dependencies = metadata_distribution(metadata, b"", "peewee", APPROVED_PEEWEE[0], api, source_kind="sdist")
    return {"name": "peewee", "version": APPROVED_PEEWEE[0], "sha256": digest(raw), "kind": "approved-sdist",
            "metadata": metadata, "dist": dist, "dependencies": dependencies, "destinations": [],
            "expandedBytes": len(tar_bytes), "postBuildWheelAuditRequired": True}


def audit_distribution_set(rows: list[dict], api) -> dict:
    """Exact original-metadata closure + conservative destination ownership.

    Lower-level synthetic seam, NOT permission to skip locked-artifact admission.
    No directory scan of candidate packages; every metadata object is byte-backed.
    """
    need(0 < len(rows) <= MAX_PACKAGES, "PACKAGE_BOUND", "empty/oversize candidate set")
    need(sum(r["expandedBytes"] for r in rows) <= MAX_ALL_EXPANDED, "ALL_EXPANSION_BOUND", "candidate set")
    need(len({r["name"] for r in rows}) == len(rows), "DUPLICATE_DISTRIBUTION", "normalized name")
    owners, directories, root_owners = {}, set(), {}
    for row in rows:
        name = row["name"]
        for destination, source, kind in row["destinations"]:
            key = tuple(p.lower() for p in destination)  # reject case aliases conservatively
            need(key not in owners and key not in directories and not any(key[:i] in owners for i in range(1, len(key))), "DESTINATION_COLLISION", "/".join(destination))
            if key[0] == "bin":
                command = key[1]
                need(command != "pyvenv.cfg" and not command.endswith("._pth"), "INTERPRETER_CONFIGURATION", command)
                need(not re.fullmatch(r"python(?:[0-9.]+)?", command), "RESERVED_ENTRYPOINT", command)
                reserved = "pip" if re.fullmatch(r"pip(?:[0-9.]+)?", command) else RESERVED_COMMAND_OWNERS.get(command)
                need(reserved is None or reserved == name, "RESERVED_ENTRYPOINT", command)
            elif len(key) >= 2 and not key[1].endswith(".dist-info"):
                root = key[1].split(".", 1)[0]
                need(root not in sys.stdlib_module_names, "STDLIB_OVERWRITE", root)
                need(TOOL_ROOT_OWNERS.get(root, name) == name, "TOOL_NAMESPACE_OVERWRITE", root)
                if root in TOOL_ROOT_OWNERS:
                    need((row["version"], row["sha256"]) == APPROVED_TOOLS[name], "TOOL_ARTIFACT_NOT_APPROVED", name)
                if root in APPROVED_SHARED_NAMESPACES:
                    need(approved_namespace_contributor(row, root, destination), "UNAPPROVED_NAMESPACE_CONTRIBUTOR", root)
                prior = root_owners.setdefault(root, set())
                prior.add((name, row["version"], row["sha256"]))
                need(len(prior) == 1 or prior <= APPROVED_SHARED_NAMESPACES.get(root, frozenset()), "NAMESPACE_OWNERSHIP", root)
            owners[key] = {"owner": name, "source": source, "kind": kind}
            directories.update(key[:i] for i in range(1, len(key)))
    by_name = {row["name"]: row for row in rows}
    extras = {name: set() for name in by_name}
    dependencies, queue = {}, list(by_name)
    while queue:
        name = queue.pop(0)
        row = by_name[name]
        # Preserve base dependencies as well as every requested extra context.
        # Only the pinned pip metadata API evaluates PEP 508 markers.
        requirements = list(row["dist"].iter_dependencies())
        if extras[name]:
            provided = set(row["dist"].iter_provided_extras())
            need(extras[name] <= provided, "UNKNOWN_REQUESTED_EXTRA", name)
            requirements.extend(row["dist"].iter_dependencies(sorted(extras[name])))
        dependencies[name] = []
        for req in {str(req): req for req in requirements}.values():
            # These edges already passed pip's real base/requested-extra marker
            # evaluation. check_package_set rechecks missing packages with extra
            # "", so give it independent active-edge copies, not cached originals.
            active = api.Requirement(str(req))
            active.marker = None
            dependencies[name].append(active)
        for req in dependencies[name]:
            target = api.canonicalize_name(req.name)
            if target not in by_name:
                continue  # check_package_set below must report the missing package.
            requested = {api.canonicalize_name(extra) for extra in req.extras}
            if not requested <= extras[target]:
                extras[target].update(requested)
                need(sum(map(len, extras.values())) <= 256, "REQUESTED_EXTRA_BOUND", target)
                if target not in queue:
                    queue.append(target)
    package_set = {r["name"]: api.PackageDetails(r["dist"].version, dependencies[r["name"]]) for r in rows}
    missing, conflicting = api.check_package_set(package_set)  # actual pip function, no reimplementation
    need(not missing and not conflicting, "DEPENDENCY_CLOSURE", repr({"missing": missing, "conflicting": conflicting}))
    return {"state": "ORIGINAL_METADATA_AND_LAYOUT_AUDIT_ONLY", "qualified": False, "candidateExecutionAllowed": False,
            "pipApi": api.provenance, "packages": [{k: r[k] for k in ("name", "version", "sha256", "kind")} for r in rows],
            "originalMetadataClosure": True, "destinationCount": len(owners),
            "requestedExtras": {name: sorted(values) for name, values in extras.items() if values},
            "approvedSdistNeedsSeparateBuiltWheelAndMetadataAudit": any(r["kind"] == "approved-sdist" for r in rows),
            "notProven": ["pinned 26.2.1 API compatibility", "original real artifact inventory", "built Peewee wheel destinations/metadata", "installed pip check", "runtime/version/core truthfulness"]}


def audit_locked_artifacts(build_lock: bytes, runtime_lock: bytes, artifacts: list[tuple[str, bytes]], api) -> dict:
    """No candidate resolver/backend/metadata hooks. Files must already be downloaded raw.

    Candidate inputs never supply policy, namespace waivers or a PEP 508 parser.
    Caller must freeze auditor+tool origin in trusted workflow, not PR Python code.
    """
    def pins(raw):
        need(0 < len(raw) <= 131072, "LOCK_BOUND", "lock")
        result = {}
        for line in raw.decode("ascii").splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*) --hash=sha256:([a-f0-9]{64})", line)
            need(match is not None, "LOCK_GRAMMAR", line)
            name = api.canonicalize_name(match[1])
            need(name not in result, "LOCK_DUPLICATE", name)
            result[name] = (str(api.Version(match[2])), match[3])
        return result
    need(api.pip.__version__ == "26.2.1" and api.provenance["state"] == "PINNED_API_BYTES_VERIFIED", "PINNED_API_REQUIRED", "no host fallback")
    build, runtime = pins(build_lock), pins(runtime_lock)
    need(build == APPROVED_TOOLS, "BUILD_TOOL_POLICY", "tool pins differ from trusted constants")
    need(runtime.get("peewee") == APPROVED_PEEWEE and runtime.get("semgrep", (None,))[0] == "1.180.0", "RUNTIME_RECIPE", "Peewee/semgrep")
    for name in build.keys() & runtime.keys():
        need(build[name] == runtime[name], "LOCK_OVERLAP", name)
    expected, rows = build | runtime, []
    need(len(artifacts) == len(expected) <= MAX_PACKAGES, "ARTIFACT_INVENTORY", "one original artifact per merged pin")
    for filename, raw in artifacts:
        need(type(raw) is bytes and len(raw) <= MAX_ARCHIVE, "ARTIFACT_BYTES", filename)
        row = scan_wheel(filename, raw, api) if filename.endswith(".whl") else scan_approved_peewee_sdist(filename, raw, api)
        need(expected.get(row["name"]) == (row["version"], row["sha256"]), "LOCK_ARTIFACT_BINDING", filename)
        rows.append(row)
    need({r["name"] for r in rows} == set(expected), "ARTIFACT_INVENTORY", "foreign/missing artifact")
    return audit_distribution_set(rows, api)


# ---- Explicit, separately receipted phase controller. ----
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AuditBlocked("TLS_REDIRECT_REFUSED", newurl)


def _once(path, data):
    with path.open("xb") as sink:
        sink.write(data)
        sink.flush()
        os.fsync(sink.fileno())


def _json_once(path, value):
    _once(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def _regular(path, limit=MAX_ARCHIVE):
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_size <= limit and not path.is_symlink(), "INPUT_FILE", str(path))
    data = path.read_bytes()
    after = path.lstat()
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
         (after.st_dev, after.st_ino, len(data), after.st_mtime_ns, after.st_ctime_ns), "INPUT_CHANGED", str(path))
    return data


def _tls_bytes(url, host, limit):
    parsed = urllib.parse.urlsplit(url)
    need(parsed.scheme == "https" and parsed.hostname == host and parsed.port is None and
         parsed.username is None and parsed.password is None and not parsed.fragment, "TLS_URL", url)
    opener = urllib.request.build_opener(_NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "semgrep-runtime-audit"}), timeout=20) as response:
        need(response.status == 200 and response.url == url, "TLS_RESPONSE", url)
        raw = response.read(limit + 1)
    need(len(raw) <= limit, "TLS_BYTE_BOUND", url)
    return raw


def _raw_release(project, version, filename, expected_sha, destination):
    # TLS-authenticated official metadata chooses a file URL, but its digest must
    # ALSO equal the independently fixed trusted-workflow policy constant.
    release = json.loads(_tls_bytes(f"https://pypi.org/pypi/{project}/{version}/json", "pypi.org", 2 << 20))
    need(release["info"]["name"].lower() == project and release["info"]["version"] == version, "RELEASE_IDENTITY", project)
    matches = [r for r in release["urls"] if r["filename"] == filename and r["digests"]["sha256"] == expected_sha and not r["yanked"]]
    need(len(matches) == 1, "APPROVED_RELEASE_FILE", filename)
    raw = _tls_bytes(matches[0]["url"], "files.pythonhosted.org", MAX_ARCHIVE)
    need(digest(raw) == expected_sha, "APPROVED_RELEASE_HASH", filename)
    _once(destination, raw)


def _lock_pins(raw):
    need(0 < len(raw) <= 131072, "LOCK_BOUND", "lock")
    result = {}
    for line in raw.decode("ascii").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        m = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*) --hash=sha256:([a-f0-9]{64})", line)
        need(m is not None, "LOCK_GRAMMAR", line)
        name = re.sub(r"[-_.]+", "-", m[1].lower())  # lock-name grammar only; NOT a PEP 508 parser
        need(name not in result, "LOCK_DUPLICATE", name)
        result[name] = (m[2], m[3])
    return result


def _locked_inputs(root):
    build = _regular(root / "build-requirements.txt", 131072)
    runtime = _regular(root / "requirements.txt", 131072)
    b, r = _lock_pins(build), _lock_pins(runtime)
    need(b == APPROVED_TOOLS and r.get("peewee") == APPROVED_PEEWEE and r.get("semgrep", (None,))[0] == "1.180.0",
         "RECIPE_POLICY", "fixed original build pins, approved Peewee and Semgrep version required")
    need(all(b[n] == r[n] for n in b.keys() & r.keys()), "LOCK_OVERLAP", "tool drift")
    return build, runtime, b | r


def _environment(root):
    return {"PATH": str(pathlib.Path(sys.executable).parent) + ":/usr/bin:/bin",
            "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"), "NO_SQLITE": "1",
            "SEMGREP_SEND_METRICS": "off", "SEMGREP_ENABLE_VERSION_CHECK": "0",
            "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C.UTF-8"}


def _run(root, argv, seconds=90):
    # Phase output remains native Actions output; no retry/catch-to-success.
    subprocess.run(list(map(str, argv)), cwd=root, env=_environment(root), check=True, timeout=seconds)


def _trusted_pip(root, arguments, python=None):
    need(digest(_regular(root / "pip-26.2.1-py3-none-any.whl")) == APPROVED_TOOLS["pip"][1], "TOOL_HASH", "bootstrap drift")
    code = 'import sys;sys.path.insert(0,sys.argv[1]);from pip._internal.cli.main import main;raise SystemExit(main(sys.argv[2:]))'
    _run(root, [python or sys.executable, "-I", "-S", "-c", code, root / "pip-26.2.1-py3-none-any.whl",
                "--isolated", "--disable-pip-version-check", "--no-cache-dir", *arguments])


def _artifact_rows(root, api):
    paths = sorted((root / "artifacts").iterdir())
    need(0 < len(paths) <= MAX_PACKAGES, "ARTIFACT_INVENTORY", "bounded immediate directory only")
    artifacts = [(p.name, _regular(p)) for p in paths]
    need(sum(len(raw) for _, raw in artifacts) <= (512 << 20), "ALL_COMPRESSED_BOUND", "artifact set")
    build, runtime, _ = _locked_inputs(root)
    result = audit_locked_artifacts(build, runtime, artifacts, api)
    rows = [scan_wheel(n, b, api) if n.endswith(".whl") else scan_approved_peewee_sdist(n, b, api) for n, b in artifacts]
    return result, rows, [{"filename": n, "sha256": digest(b)} for n, b in artifacts]


def _require_original_audit(root, inventory):
    old = json.loads(_regular(root / "original-audit.json", 4 << 20))
    need(old["inventory"] == inventory and old["audit"]["originalMetadataClosure"] is True and
         old["auditorSha256"] == digest(_regular(pathlib.Path(__file__))), "ORIGINAL_AUDIT_BINDING", "changed/missing independent audit")
    return old


def _metadata_signature(row, api):
    msg = BytesParser(policy=email.policy.default.clone(raise_on_defect=True)).parsebytes(row["metadata"])
    return {"name": api.canonicalize_name(str(msg["Name"])), "version": str(api.Version(str(msg["Version"]))),
            "requiresDist": sorted(str(api.Requirement(str(v).strip())) for v in msg.get_all("Requires-Dist", [])),
            "requiresPython": str(msg.get("Requires-Python", "")).strip(),
            "providesExtra": sorted(api.canonicalize_name(str(v)) for v in msg.get_all("Provides-Extra", []))}


def _committed_blob(root, workspace, head, path, limit):
    need(re.fullmatch(r"[a-f0-9]{40}", head) is not None, "HEAD", head)
    def git(*args):
        return subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(workspace), *args],
                              env=_environment(root), check=True, capture_output=True, timeout=15).stdout
    need(git("rev-parse", "HEAD").decode().strip() == head, "HEAD", "checkout drift")
    record = git("ls-tree", "-z", head, "--", path)
    need(re.fullmatch(rb"100644 blob [a-f0-9]{40}\t" + re.escape(path.encode()) + rb"\x00", record) is not None,
         "SOURCE_GIT_BLOB", path)
    blob = record.split(b"\t", 1)[0].split()[2].decode()
    size = int(git("cat-file", "-s", blob))
    need(0 < size <= limit, "SOURCE_BOUND", path)
    raw = git("cat-file", "blob", blob)
    need(len(raw) == size and hashlib.sha1(b"blob " + str(size).encode() + b"\0" + raw).hexdigest() == blob,
         "SOURCE_GIT_BYTES", path)
    return raw


def _bootstrap_pip(root):
    path = root / "pip-26.2.1-py3-none-any.whl"
    if not path.exists() and not path.is_symlink():
        _raw_release("pip", "26.2.1", path.name, APPROVED_TOOLS["pip"][1], path)
    need(digest(_regular(path)) == APPROVED_TOOLS["pip"][1], "TOOL_HASH", "bootstrap drift")
    return path


def verify_unit_receipt(report, expected_sources):
    need(report.get("schema") == "semgrep-audit-unit-controls/v1" and
         report.get("state") == "SOURCE_MODULE_CONTROLS_PASS", "UNIT_RESULT", "wrong result type")
    need(all(type(report.get(k)) is int and report[k] == 121 for k in ("selected", "executed", "pass")) and
         all(type(report.get(k)) is int and report[k] == 0 for k in
             ("fail", "error", "skipped", "unrun", "expectedFailures", "unexpectedSuccesses")),
         "UNIT_COUNTS", "exact complete non-skipped inventory required")
    need(all(report.get(k) is True for k in
             ("complete", "successful", "inventoryClosed", "successfulInventoryClosed", "isolated", "noSite", "exactTargetPatchObserved")) and
         report.get("invariantErrors") == [] and report.get("failures") == [] and report.get("errors") == [],
         "UNIT_CLOSURE", "incomplete or failed source controls")
    ids = report.get("literalInventory")
    need(isinstance(ids, list) and len(ids) == 121 and all(isinstance(v, str) for v in ids) and
         len(set(ids)) == 121 and ids == sorted(ids) and
         digest(("\n".join(ids) + "\n").encode()) == AUDIT_TEST_INVENTORY and
         report.get("inventorySha256") == AUDIT_TEST_INVENTORY and
         sorted(report.get("executedIds", [])) == ids and sorted(report.get("successfulIds", [])) == ids,
         "UNIT_INVENTORY", "literal test inventory mismatch")
    need(report.get("sourceHashes") == expected_sources and
         report.get("expectedAuditorSha256") == expected_sources["runtime-compatibility-audit.py"] and
         report.get("pipWheelSha256") == APPROVED_TOOLS["pip"][1], "UNIT_SOURCE_BINDING", "source/tool drift")
    need(report.get("pythonVersion") == "3.12.15" and report.get("platform") == "linux" and
         report.get("machine") == "x86_64", "UNIT_TARGET", "actual pinned runtime required")
    # Unit success cannot mint production, full-author or constrained-runner proof.
    need(all(report.get(k) is False for k in
             ("qualified", "linuxQualification", "pinnedRuntimeQualified", "runnerQualified")),
         "UNIT_ASSURANCE", "unexpected qualification transfer")


def phase_unit(root, workspace, head):
    stage = pathlib.Path(tempfile.mkdtemp(prefix="unit-code-", dir=root))
    expected = dict(AUDIT_TEST_SOURCES)
    expected["runtime-compatibility-audit.py"] = digest(_regular(pathlib.Path(__file__), 65536))
    for name, sha256 in expected.items():
        raw = _committed_blob(root, workspace, head, ".github/semgrep/" + name, 262144)
        need(digest(raw) == sha256, "UNIT_SOURCE_HASH", name)
        _once(stage / name, raw)
    wheel = _bootstrap_pip(root)
    # Exercise the real strict production loader on the pinned interpreter too;
    # the synthetic controls deliberately use their own fresh child context.
    production_loader = load_approved_pip_wheel(str(wheel))
    receipt = stage / "unit-result.json"
    _run(root, [sys.executable, "-I", "-S", stage / "test_runtime_compatibility_audit.py",
                "--pip-wheel", wheel, "--auditor-sha256", expected["runtime-compatibility-audit.py"],
                "--receipt", receipt], seconds=90)
    report = json.loads(_regular(receipt, 65536))
    verify_unit_receipt(report, expected)
    summary = {"state": "PINNED_TARGET_SOURCE_CONTROLS_PASS", "head": head,
               "sourceHashes": expected, "inventorySha256": AUDIT_TEST_INVENTORY, "selected": 121,
               "pythonVersion": report["pythonVersion"], "productionLoader": production_loader.provenance,
               "runnerQualified": False}
    _json_once(root / "unit-audit.json", summary)
    # Preserve a bounded machine-readable receipt in native Actions logs, not
    # only in a disposable runner's filesystem. This contains no candidate code.
    print(json.dumps(summary, sort_keys=True), flush=True)


def phase_download(root, workspace, head):
    need(re.fullmatch(r"[a-f0-9]{40}", head) is not None, "HEAD", head)
    for name in ("home", "tmp", "artifacts", "built"):
        (root / name).mkdir(mode=0o700)
    def git(*args):
        return subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(workspace), *args],
                              env=_environment(root), check=True, capture_output=True, timeout=15).stdout
    need(git("rev-parse", "HEAD").decode().strip() == head, "HEAD", "checkout drift")
    for filename in ("build-requirements.txt", "requirements.txt"):
        path = ".github/semgrep/" + filename
        record = git("ls-tree", "-z", head, "--", path)
        need(re.fullmatch(rb"100644 blob [a-f0-9]{40}\t" + re.escape(path.encode()) + rb"\x00", record) is not None,
             "LOCK_GIT_BLOB", path)
        blob = record.split(b"\t", 1)[0].split()[2].decode()
        size = int(git("cat-file", "-s", blob))
        need(0 < size <= 131072, "LOCK_BOUND", path)
        raw = git("cat-file", "blob", blob)
        need(len(raw) == size and hashlib.sha1(b"blob " + str(size).encode() + b"\0" + raw).hexdigest() == blob, "LOCK_GIT_BYTES", path)
        _once(root / filename, raw)
    _, _, pins = _locked_inputs(root)  # grammar/fixed tool policy BEFORE any download
    _bootstrap_pip(root)  # reuse ONLY independently hash-verified unit-phase tool bytes
    # Wheels ONLY. Do not invoke pip download on Peewee or ANY sdist: pip may
    # execute backend/metadata hooks even with --no-deps.
    wheel_lock = "".join(f"{n}=={v} --hash=sha256:{h}\n" for n, (v, h) in sorted(pins.items()) if n != "peewee")
    _once(root / "wheels-only.txt", wheel_lock.encode())
    _trusted_pip(root, ["download", "--index-url", "https://pypi.org/simple", "--only-binary=:all:",
                        "--no-deps", "--require-hashes", "--dest", root / "artifacts", "-r", root / "wheels-only.txt"])
    _raw_release("peewee", "3.18.3", "peewee-3.18.3.tar.gz", APPROVED_PEEWEE[1], root / "artifacts/peewee-3.18.3.tar.gz")


def phase_original(root, api):
    result, _, inventory = _artifact_rows(root, api)
    _json_once(root / "original-audit.json", {"audit": result, "inventory": inventory,
                                             "auditorSha256": digest(_regular(pathlib.Path(__file__)))})


def phase_build(root, api):
    _, _, inventory = _artifact_rows(root, api)
    _require_original_audit(root, inventory)
    venv = root / "build-env"
    _run(root, [sys.executable, "-I", "-S", "-m", "venv", "--without-pip", venv])
    # Python 3.12 -S does NOT establish the venv prefix: always pass --prefix.
    # Use the venv executable so generated entrypoint shebangs name that venv.
    _trusted_pip(root, ["install", "--prefix", venv, "--ignore-installed", "--no-index", "--only-binary=:all:",
                        "--no-deps", "--require-hashes", "--find-links", root / "artifacts", "-r", root / "build-requirements.txt"],
                 python=venv / "bin/python")
    # Only the four fixed approved build tools exist in this venv. Their specific
    # approved setuptools .pth may initialize NOW, after original audit success.
    _run(root, [venv / "bin/python", "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-cache-dir",
                "wheel", "--no-index", "--no-deps", "--no-build-isolation", "--wheel-dir", root / "built",
                root / "artifacts/peewee-3.18.3.tar.gz"], seconds=120)


def phase_built(root, api):
    _, originals, inventory = _artifact_rows(root, api)
    _require_original_audit(root, inventory)
    paths = list((root / "built").iterdir())
    need(len(paths) == 1 and paths[0].name.endswith(".whl"), "BUILT_INVENTORY", "exact one Peewee wheel")
    raw = _regular(paths[0])
    built = scan_wheel(paths[0].name, raw, api)
    original = next(r for r in originals if r["name"] == "peewee")
    need(built["name"] == "peewee" and built["version"] == APPROVED_PEEWEE[0] and
         _metadata_signature(built, api) == _metadata_signature(original, api), "BUILT_METADATA_DRIFT", "Peewee")
    result = audit_distribution_set([built if r["name"] == "peewee" else r for r in originals], api)
    _json_once(root / "built-audit.json", {"audit": result, "filename": paths[0].name, "sha256": digest(raw), "originalInventory": inventory})


def phase_install(root, api):
    _, _, inventory = _artifact_rows(root, api)
    _require_original_audit(root, inventory)
    proof = json.loads(_regular(root / "built-audit.json", 4 << 20))
    need(proof["originalInventory"] == inventory and digest(_regular(root / "built" / proof["filename"])) == proof["sha256"],
         "BUILT_AUDIT_BINDING", "Peewee")
    _, _, pins = _locked_inputs(root)
    pins["peewee"] = (APPROVED_PEEWEE[0], proof["sha256"])  # private derived install lock ONLY; repo locks unchanged
    _once(root / "install.txt", "".join(f"{n}=={v} --hash=sha256:{h}\n" for n, (v, h) in sorted(pins.items())).encode())
    venv = root / "runtime-env"
    _run(root, [sys.executable, "-I", "-S", "-m", "venv", "--without-pip", venv])
    _trusted_pip(root, ["install", "--prefix", venv, "--ignore-installed", "--no-index", "--only-binary=:all:", "--no-deps",
                        "--require-hashes", "--find-links", root / "artifacts", "--find-links", root / "built", "-r", root / "install.txt"],
                 python=venv / "bin/python")


def phase_verify(root):
    venv = root / "runtime-env"
    _run(root, [venv / "bin/python", "-I", "-m", "pip", "check"])
    version = subprocess.run([str(venv / "bin/semgrep"), "--version"], cwd=root, env=_environment(root),
                             check=True, capture_output=True, text=True, timeout=30)
    need(version.stdout.strip() == "1.180.0", "SCANNER_VERSION", version.stdout)
    code = ("import pathlib,subprocess,sys;from semgrep.semgrep_core import SemgrepCore;"
            "engine=pathlib.Path(SemgrepCore.executable_path()).resolve();"
            "assert engine.is_relative_to(pathlib.Path(sys.prefix).resolve());"
            "subprocess.run([str(engine),'-version'],check=True,timeout=15)")
    _run(root, [venv / "bin/python", "-I", "-c", code])
    _json_once(root / "runtime-result.json", {"state": "INSTALLED_ADDITIONAL_CHECKS_CLOSED", "qualified": False,
        "note": "Original and built metadata audits are independent mandatory steps. No findings/SARIF scan or merge approval."})


def main():
    parser = argparse.ArgumentParser(description="Independently audit locked Semgrep artifact metadata and layout")
    parser.add_argument("--phase", choices=["unit", "download", "original", "build", "built", "install", "verify"], required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--workspace")
    parser.add_argument("--head")
    args = parser.parse_args()
    need(sys.flags.isolated and sys.flags.no_site and sys.version_info[:3] == (3, 12, 15) and
         sys.platform == "linux" and platform.machine() == "x86_64", "TARGET_UNKNOWN", "Python -I -S / exact Linux target")
    root = pathlib.Path(args.root)
    need(root.is_absolute() and root.is_dir() and not root.is_symlink() and root.resolve() == root and
         root.stat().st_uid == os.getuid() and root.stat().st_mode & 0o077 == 0, "PRIVATE_ROOT", str(root))
    if args.phase == "unit":
        phase_unit(root, pathlib.Path(args.workspace), args.head)
    elif args.phase == "download":
        phase_download(root, pathlib.Path(args.workspace), args.head)
    else:
        api = load_approved_pip_wheel(str(root / "pip-26.2.1-py3-none-any.whl"))
        if args.phase == "original":
            phase_original(root, api)
        elif args.phase == "build":
            phase_build(root, api)
        elif args.phase == "built":
            phase_built(root, api)
        elif args.phase == "install":
            phase_install(root, api)
        else:
            phase_verify(root)


if __name__ == "__main__":
    main()
