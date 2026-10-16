# Native hash-locked Semgrep Community Edition

Scan avoids Docker Hub container initialization with an isolated, fully hash-locked native installation.

## Current compatibility block

The committed lock is not presently a compatible environment: Semgrep 1.180.0
requires `mcp==1.29.0`, while the security refresh locks MCP 1.30.0. Semgrep 1.181.0
has the same upstream constraint. The real Scan fails at `pip check`; neither an
OSV result nor a matching hash overrides that incompatibility. Do not downgrade MCP,
ignore an advisory, suppress `pip check`, or edit an upstream wheel's METADATA.

The independent exact-head artifact/runtime boundary merged separately. Its source
unit controls and a source PR's required-CI success are not evidence that the scanner
installed or that a whole-repository scan completed.

## Scoped downstream source preparation (not wired into Scan)

`.github/semgrep/prepare-source-build.py` prepares a distinctly versioned
`semgrep==1.181.0+remudero.1` distribution. It hash-checks the exact original sdist
and Linux x86_64 wheel against `source-build-policy.json`. The only source changes
are the pyproject distribution version and the exact MCP requirement to 1.30.0.
Python/package payloads are sourced from the sdist and must match the upstream
wheel's installed `.data/purelib` payloads. The approved CE engine and its complete
native-library inventory retain their original bytes and modes. The engine is not
recompiled; the Python protocol/engine version remains 1.181.0, separately recorded
from the local distribution version.

Preparation is inert: no package import, build hook, child process, network request,
install, scanner invocation, login or publication. All candidate inputs must already
be local. The output parent must be private and owned, and the output directory must
not exist. No existing output or input is overwritten. Example after independently
obtaining and verifying the approved archives:

```sh
python3 -I -S .github/semgrep/prepare-source-build.py \
  --source-archive /private/inputs/semgrep-1.181.0.tar.gz \
  --engine-donor /private/inputs/semgrep-1.181.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_x86_64.whl \
  --output-dir /private/owned-parent/new-build
```

The output includes a wheel, explicit source patch, patched pyproject, payload-origin
manifest, original licenses and a `SOURCE_ASSEMBLED_NOT_RUNTIME_QUALIFIED` receipt.
DEFLATE level, ordering, timestamps and modes are fixed. Reproduce twice on the
same recorded Python/zlib profile and compare full wheel hashes; no cross-profile
bit-identity is claimed. The existing 256-MiB artifact bound remains intact.

This preparation does not change the runtime locks, Scan workflow, findings policy,
merge policy, pilot, runner services or fleet configuration. Before wiring it into
Scan, independently qualify its original/built metadata and layout, the complete
hash-locked dependency closure, standard `pip check`, MCP API compatibility, actual
CLI/engine identity, baseline and invalid-rule sentinels, and full JSON/SARIF target
and error inventories on CPython 3.12.15/Linux x86_64. An assembled artifact or an
inert unit receipt cannot substitute for any of those checks. No package publication
or old native-runner/SDK/eval grant is authorized by this preparation.

References: [PyPA local versions](https://packaging.python.org/en/latest/specifications/version-specifiers/#local-version-identifiers),
[wheel format](https://packaging.python.org/en/latest/specifications/binary-distribution-format/),
and [core metadata](https://packaging.python.org/en/latest/specifications/core-metadata/).

### Exact reviewed layout support

The independent auditor identifies shared namespace contributors by distribution,
version and whole-artifact SHA256, including a lone contributor. The reviewed
`google` and `opentelemetry` roots remain implicit namespaces: root modules,
root `__init__.py`, case aliases and unreviewed contributors are refused.

Nested vendor metadata and the one nested OpenTelemetry customization member
require exact owner/version/artifact/path/body-size/body-SHA tuples and the original
install destination. A same-content `.data` alias or different destination is not
the reviewed member. No general startup-hook, foreign-metadata, namespace, tool,
stdlib, collision, dependency or RECORD guard is disabled.

The 117-case source inventory retains the original 107 controls and adds ten exact
layout controls. Synthetic tuple controls are not original-artifact proof; real
approved-archive positives and wrong-owner/version/hash/path/body/destination
negatives must be retained separately. Source controls do not establish installed
closure, scanner operation, Python 3.12.15 qualification or pilot activation.

## Install boundary

Operator-approved CE 1.180.0 replaces 1.167.0, whose dependency constraints forced
MCP 1.23.3 and PyJWT 2.13.0 with reported security advisories. The reviewed new closure
uses MCP 1.30.0 and PyJWT 2.15.1; PyPI reported no advisories for this exact closure at
lock preparation. That point-in-time result is not an exhaustive vulnerability audit.

`.github/workflows/semgrep.yml` uses Ubuntu 24.04 x86_64 and Python 3.12.15 through a
full-commit-pinned official setup action. The existing Scan name, 20-minute deadline,
PR/nightly/manual events, advisory findings policy, four registry rule packs, PR-base
comparison and SARIF upload remain unchanged. No package publication, registry login,
Pro installation, Semgrep login or secret is needed, including for fork/Dependabot installs.
GitHub's existing fork restrictions on SARIF upload permissions still apply.

Every package in `.github/semgrep/build-requirements.txt` and
`.github/semgrep/requirements.txt` has an exact version and one SHA256-approved artifact.
These are platform-specific locks, not a general macOS/ARM/Windows install recipe.
The pip download cache key includes BOTH files; an executable virtual environment is
never restored. Each job makes a fresh venv in `RUNNER_TEMP`, hash-reinstalls the locked
build tools, hash-verifies runtime downloads, then rechecks those bytes during an offline
installation with built-wheel cache reuse disabled. `pip check` and the exact scanner
version check must pass before the venv enters `GITHUB_PATH`. Installation failure fails
Scan; the established advisory treatment applies only to the scan step's findings.

Peewee 3.18.3 is the only source-distribution exception because it has no PyPI wheel.
Its reviewed upstream build requires setuptools and wheel; their dependency packaging
and pip are locked too. `--no-build-isolation` forbids pip's hidden build-dependency
downloads. `NO_SQLITE=1` disables Peewee's optional SQLite C extensions, not Semgrep's
analysis engine. All other runtime and build artifacts must be wheels.

## Governed refresh

Update these locks only through a reviewed PR, never resolve `latest` in CI. On the exact
runner/Python platform, resolve the complete dependency closure, including extras, and
compare artifact filenames/hashes/yank status against official PyPI release metadata.
Review current security advisories and compatibility constraints; a successful hash check
does not establish safety, vulnerability absence, or behavioral equivalence. Preserve
the artifact/license metadata receipt outside the source tree. Do not substitute an
unreviewed source build or override a dependency constraint with `--no-deps`.

Validate a fresh install and `pip check`, exact CLI/engine identity, rejected wrong hashes,
clean and deliberately vulnerable JavaScript/TypeScript fixtures, existing-versus-new
baseline findings, all four actual registry packs, and complete SARIF output. Commit first,
run the shipped author preflight, and supply discriminating acceptance proofs. Hosted
required CI/coverage/review and a real hosted Scan remain separate shipping evidence.

The previous Docker image was proprietary-labelled and recorded a Pro-engine install;
public redistribution permission was not established. No image was republished. Native
CE avoids that distribution question, rather than declaring the image unlawful or its
contents Community Edition solely because the existing command was `semgrep scan`.

References: [pip secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/),
[Peewee's pinned build requirements](https://github.com/coleifer/peewee/blob/3.18.3/pyproject.toml),
[Peewee's supported source-build switch](https://github.com/coleifer/peewee/blob/3.18.3/setup.py),
and [Semgrep licensing](https://semgrep.dev/docs/licensing/).

## Deadline-aware native author validation

The local author gate still runs its verified affected selection (including full fallback)
and all default static checks. It does not replace hosted coverage, security, review or merge.
Normal author runs now save compact file-wrapper durations beside their native logs; a
missing, incomplete or unreadable timing artifact is explicit and is never priced as zero.
Timing observations are not automatically promoted into the committed duration ledger.

For a bounded heavy run, commit first and run
`node --import tsx scripts/calibrate-author-runtime.mjs` on the native target. It takes a
real host-wide slot, retains niceness, samples 32 physical files across the duration ledger
(all files when fewer exist), and keeps complete native/TAP/hash evidence under `coverage/`.
The sample includes the ledger's expensive tail. A failed or interrupted sample is not a profile.

Use the returned profile path with
`node --import tsx scripts/preflight-author.mjs --deadline <fixed-ISO-time> --runtime-profile <path>`.
The gate checks the exact source, corpus, lock/setup hashes, Node/V8/tsx, platform and
host/kernel/CPU identity and nonsecret environment fingerprint, then independently rereads every closed sample artifact.
Stale/future, corrupt, incomplete or mismatched profiles cannot price admission.

After acquiring the actual slot, fit the conservative sample-calibrated estimate, static
reserve and shutdown reserve into the remaining deadline. Recheck after static validation.
Unknown files retain explicit positive costs. A non-fitting or unslotted run refuses before
the expensive phase and releases only its own slot; it never increases concurrency, evicts
workers, shrinks the test set, bypasses gates or silently extends the deadline. Phase capture
limits follow the remaining window. A sample estimate is not full-corpus calibration or a
completion promise; completed full-run durations provide later, separately governed evidence.

The operator-approved 60-minute ready-heavy escalation SLA is a separate scheduler follow-up,
not this execution deadline. No live scheduler policy or default author deadline changes here.
