# Native hash-locked Semgrep Community Edition

Scan uses an independently audited source closure, isolated native engine and bounded disposable MCP controls.

## Historical compatibility block and distinct source closure

The previous committed lock was not a compatible environment: Semgrep 1.180.0
requires `mcp==1.29.0`, while the security refresh locks MCP 1.30.0. Semgrep 1.181.0
has the same upstream constraint. That Scan failed at `pip check`; neither an
OSV result nor a matching hash overrides that incompatibility. Do not downgrade MCP,
ignore an advisory, suppress `pip check`, or edit an upstream wheel's METADATA.

The independent exact-head artifact/runtime boundary merged separately. Its source
unit controls and a source PR's required-CI success are not evidence that the scanner
installed or that a whole-repository scan completed.

The operator-approved replacement is the distinctly versioned source distribution
`1.181.0+remudero.1`, with CLI/protocol/unchanged CE engine version `1.181.0` and
MCP `1.30.0`. This is not a relabelled or edited upstream wheel. Ordinary `pip check`
remains mandatory in addition to the separately staged original and built audits.

## Scoped downstream source preparation

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

Preparation itself changes no runtime or findings/merge policy. Scan's separate
`source-runtime-qualification.py --install-root` composition first runs all seven
unchanged trusted auditor phases, restaging each regular committed source against
its independent digest. It then restages its own exact executed Git bytes and runs
the installed MCP probe. Missing, revised, partial, failed or timed-out controls
cannot publish an executable environment into `GITHUB_PATH`. No retry, resolver
override, live issuer or package publication substitutes for this boundary.

The installed probe uses the real Semgrep registration, context and lifecycle and
the installed SDK's HTTP client/server, bearer, scope, resource, Host and Origin
checks. Disposable user/deployment data comes from a private localhost fixture via
upstream's supported `SEMGREP_URL` setting; it is not a Semgrep account or live OAuth
identity. Only localhost reads and approved private commands are allowed by the
Python effect trap; this is not an OS sandbox claim. No prompt is executed, model
called, Pro engine installed, account logged in or external service written. Actual
language-schema/JavaScript/TypeScript controls and listener shutdown are mandatory.

Install/MCP receipts explicitly leave `runtimeQualified` and `wholeCorpusQualified`
false: scanner controls and repository inventories are distinct later evidence.
The paired original parser sentinel can retain `INCOMPLETE`/`PARTIAL` while boundary
markers are reached. Do not call that whole-AST coverage or silently fix source to
hide the omission. Report execution `COMPLETE` means the JSON/SARIF execution contract
closed, not zero findings, all Git paths scanned, all syntax parsed or SARIF upload
processed. Unreported skipped-target counts remain `null`/`UNKNOWN`; neither a report
nor an exit zero turns them into zero omissions. Raw reports stay private; summaries
retain constrained inventories and hashes rather than source snippets or secrets.

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

The initial 117-case layout inventory retained the original 107 controls and added
ten exact layout controls. The complete inventory now contains 168 literal controls,
including metadata declaration and trusted source-recipe controls. Synthetic tuple
controls are not original-artifact proof; real
approved-archive positives and wrong-owner/version/hash/path/body/destination
negatives must be retained separately. Source controls do not establish installed
closure, scanner operation, Python 3.12.15 qualification or pilot activation.

## Install boundary

The earlier CE 1.180.0 refresh replaced 1.167.0, whose dependency constraints forced
MCP 1.23.3 and PyJWT 2.13.0 with reported security advisories. The source closure
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
never restored. Each job makes a fresh private root in `RUNNER_TEMP`, obtains inert
hash-bound artifacts, audits original metadata/layout, builds only approved Peewee,
audits its built metadata/layout and hash-installs the complete closure offline.
`pip check`, distribution/CLI/engine identities and installed MCP controls must pass
before the runtime environment enters `GITHUB_PATH`. Installation failure fails
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

## Inert metadata declaration policy

The inert artifact auditor supports metadata 2.5 import declarations as untrusted
data, never as a namespace or installation permission. It checks identifier/private
syntax, empty-name semantics, same-project ambiguity and bounded cross-project
exclusive-name collisions. A shared parent may contain distinct exclusive children;
one exclusive parent cannot capture another project's namespace child. Existing
whole-artifact/destination/RECORD/tool/startup guards still decide installation safety.
Importability is not inferred from metadata and remains unproved by this inert audit.
Unsupported metadata versions still refuse. Final wheel dependencies are enforced
even when marked Dynamic; unresolved source dependencies/import declarations refuse.

Metadata controls are a separately hash-bound first-party module. Every existing
literal test identity is retained, and source staging, policy-change detection and
receipt verification include the module. No source-size limit is increased.
References: [core metadata](https://packaging.python.org/en/latest/specifications/core-metadata/)
and [PEP 794](https://peps.python.org/pep-0794/).

## Trusted source-recipe staging, before lock adoption

The compatibility workflow stages four regular, committed first-party files for
every phase: the auditor, `runtime_source_recipe.py`, source assembler and policy.
Each is checked against its independent workflow SHA256 before execution; unit
controls additionally bind their complete source inventory. A mutable checkout,
symlink, wrong digest or unknown recipe cannot replace those committed bytes.

The added recipe accepts only the reviewed local distribution and MCP 1.30.0 pins.
Source assembly occurs in the isolated parent, after checking the recorded Linux
x86_64, CPython 3.12.15 and zlib 1.3 profile. The exact whole-wheel hash must match
before the wheel joins the original-artifact population. Raw TLS acquisition is
separate from inert assembly. Newly created build/runtime environments have private
directory entries; existing entries and their permissions are never repaired or reused.

The trusted staging was merged before the separate lock/Scan adoption change. Its
workflow, auditor, recipe, assembler and policy remain unchanged by adoption; a new
need to change them requires another governed staging change before use. Original and built
metadata audits, offline hash installation, standard `pip check` and installed
version/engine checks remain mandatory. Source controls, relocated private Python
checks and inert artifact audits do not qualify the production runner, MCP startup,
HTTP authentication, repository scans or the pilot.

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
