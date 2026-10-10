# Native hash-locked Semgrep Community Edition

Scan avoids Docker Hub container initialization with an isolated, fully hash-locked native installation.

## Install boundary

Operator-approved CE 1.180.0 replaces 1.167.0, whose dependency constraints forced
MCP 1.23.3 and PyJWT 2.13.0 with reported security advisories. The reviewed new closure
uses MCP 1.29.0 and PyJWT 2.15.1; PyPI reported no advisories for this exact closure at
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
nonsecret environment fingerprint, then independently rereads every closed sample artifact.
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
