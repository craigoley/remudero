# What public core holds for one operator, who reads it, and where it moves

Recon for W1-T13729. Read at core `origin/main` **eb79fd765**. Nothing was changed, filed or pushed.
Each claim is marked **OBSERVED** (read in code or found with `git grep` at that sha) or **INFERRED** (my reasoning
from what I read). This report names core files and symbols only.

## Summary

- **The two files that matter are both in `.remudero/`.** `daemon-instances.yaml` and `managed-repos.json` hold one
  fleet's real values, and running processes read both: the daemon, serve, the Console (through serve) and host
  scripts. Everything else is a document, Mac session tooling, or a default value hard-coded in a script. (OBSERVED)
- **Two traps make "delete core's copy" unsafe.**
  - A missing registry makes every instance **live**. `readInstanceRegistryText` (src/lib/instance-mode.ts) returns
    `undefined` when the file is missing, and its own comment says that "resolves to live". Deleting core's copy
    before readers move would arm and merge on an instance that is meant to be in shadow. (OBSERVED)
  - A missing `managed-repos.json` gives an empty list with no error. `loadManagedRepos` returns `[]` when the file
    does not exist. The Console repository rows, issues intake and inbox repository checks would shrink without any
    error. (OBSERVED)
- **Core already has a way to point registry readers at another file.** The selected-registry path
  (`RMD_SELECTED_INSTANCE_REGISTRY`, src/lib/instance-registry-selection.ts) does this. Many readers honour it today;
  some do not yet. (OBSERVED)
- **The private overlay already has a copy of the registry.** Its instance names and field set match core's. It
  differs in one field: it states `mode` on every row, with a value other than core's live default, and core states
  `mode` on one row only. The overlay has no copy of `managed-repos.json`. (OBSERVED; the overlay was read for its
  shape only)

## Every file and its readers

When a file is read: **build** (image or CI), **boot** (process start), **tick** (each daemon or sweep loop),
**request** (each serve HTTP call), **pass** (each run of a scheduled host job), **session** (an operator or agent
session), **test** (the test suite only).

### `.remudero/daemon-instances.yaml`: SPLITS (a public example in core, the real values in the home repo)

It names one fleet's containers, state directories, credential directories, image and GitHub repos. (OBSERVED)
Resolved through `daemonInstanceRegistryPath` (src/lib/deployer.ts), which is `.remudero/` of the deploy checkout.
The daemon and serve run from that checkout, which follows core main, so deleting the file on main deletes it under
the running daemon at its next deploy. (OBSERVED for the path resolution; INFERRED for the deploy consequence)

| Reader (file:symbol) | Process | When |
|---|---|---|
| src/lib/instance-mode.ts:`readInstanceRegistryText`, used by `buildSweepEffects` (src/cli/commands/sweep.ts, src/lib/sweep.ts), `runTaskBody` (src/cli/commands/run-task-verb.ts), `daemonCommand` pause in-flight units (src/cli/commands/daemon.ts), `knownPlanRepos` (src/lib/inbox.ts) | daemon, sweep, run child | tick, run start |
| src/lib/installation-budget-start.ts:`daemonInstallationRegistry` (the host copy first, then the checkout copy) | daemon | boot |
| src/lib/deployer.ts:`realDeployDeps` | daemon deploy cycle | tick |
| src/lib/serve-policy-convergence.ts:`realServePolicyDeps` | daemon or serve policy | tick |
| src/lib/serve.ts: `buildRegistryRoute` (GET /v1/registry), `buildOnboardingGoLiveRoutes`, `assembleServeRoutes` (needs-you gates, operator-agent answer), `assembleServeServer` (instance liveness watcher), `readModelInstances` | serve, and through it the **Console** | boot and request |
| src/lib/onboarding-golive.ts:`requestGoLive`: **fetches the file from GitHub** (contents API) on the primary instance's repo | serve, from the Console go-live action | request |
| src/lib/product-build.ts:`registryDaemonRoot`, `nativeTargetAdmission` | daemon | tick |
| src/lib/sre-lane.ts:`daemonSreLaneInput`; src/cli/commands/daemon.ts:`daemonSreLaneEnabled` | daemon SRE lane | boot and tick |
| src/run-task.ts:`pauseTargetOrRefuse`, `explicitReframeTarget`, `reframeCausalScope` | `rmd pause` / `rmd resume`, inbox reframe | session (CLI) |
| deploy/recycle-container.sh, deploy/serve-container.sh, deploy/install-host-units.sh (`DEFAULT_INSTANCE_REGISTRY`), deploy/resource-policy.sh, deploy/host-update.sh (`SR_REGISTRY`), scripts/fleet-heartbeat.sh (`MEM_REGISTRY`), deploy/field-trials-refresh.sh (`REGISTRY`) | host scripts | recycle, install, timer pass |
| 8 tests read the tracked file directly: test/one-registry-for-the-fleet.test.ts, test/the-registry-names-one-primary-instance.test.ts, test/an-unscoped-recycle-refuses-once-instances-are-declared.test.ts, test/an-image-recycle-never-waits-on-a-build-nothing-started.test.ts, test/image-drift-recycles-itself.test.ts, test/the-batch-approve-lane-files-what-the-single-lane-refuses.test.ts, test/the-sre-lane-finds-its-instance-from-inside-its-container.test.ts, test/github/the-daemon-sets-its-installation-share-from-a-registry-its-container-can-read.test.ts | CI | test |

The Console never reads the file itself. It reads serve's GET /v1/registry, GET /v1/views/instances and the repository
dashboard route. (OBSERVED in the Console's pinned read schemas and its repository dashboard code)

### `.remudero/managed-repos.json`: SPLITS (an empty or example list in core, the real list in the home repo)

It lists the operator's other repositories. (OBSERVED) Read through `loadManagedRepos` (src/lib/managed-repos.ts),
which returns `[]` when the file is missing. (OBSERVED)

| Reader (file:symbol) | Process | When |
|---|---|---|
| src/lib/repo-dashboard-route.ts:`resolveIdentities`: the Console's repository rows | serve, then the Console | request |
| src/run-task.ts:`buildIntakeRungsDaemonHooks` (issues intake), `issuesCommand` | daemon; CLI | tick; session |
| src/cli/commands/daemon.ts:`daemonCommand` (`openPrOwnership`) | daemon | tick |
| src/lib/inbox.ts:`knownPlanRepos` | daemon inbox | tick |
| src/lib/product-build.ts:`registryDaemonRoot` (`inspect`), `nativeTargetAdmission` | daemon | tick |
| test/review/wreckterra-web-profile.test.ts and test/the-gateway-reads-current-code.test.ts read or assert the tracked content | CI | test |

### Other `.remudero/` files: STAY

| File | Why it stays | Readers |
|---|---|---|
| `.remudero/mounts.yaml` | The product's routing table. It names no machine or account. (OBSERVED) | src/lib/mounts.ts:`mountsPath`, src/lib/worker.ts, src/lib/config-gardener.ts, src/lib/retro.ts, src/lib/risk-judge.ts (daemon, each run) |
| `.remudero/skills/*.yaml` | Product skill registry. No operator data. (OBSERVED) | src/lib/skill.ts, src/lib/panel-skills.ts, src/lib/panel-skill-run.ts (serve request, CLI) |

### `deploy/mac/`

The Mac jobs are installed by `deploy/mac/install-janitor.sh` and `install-tmp-reclaim.sh` as launchd jobs.
**`deploy/mac/tmp-reclaim.sh` refreshes the installed copies on each pass from core's `origin/main`.** It checks that
every file in its source set exists at that commit (`git cat-file -e`) and holds the old copies if any file is
missing. It also refuses any origin other than core. (OBSERVED) So deleting a `deploy/mac/` file on main does not
break the Mac. It freezes every installed Mac janitor at its current version, without an error, until the source
set is edited. (INFERRED from that code)

| File | Class | Readers and when |
|---|---|---|
| `remudero-janitor.sh`, `remudero-mac-janitor.sh`, `tmp-reclaim.sh`, `cache-reclaim.py`, `preserve-retire.py`, `install-janitor.sh`, `install-tmp-reclaim.sh` | **SPLITS.** The code is a general Mac janitor with about 30 tests in core. One operator's account names, owner remotes and an account check are written into the code. (OBSERVED) Keep the code; move those values into a config file the janitor reads. | Mac launchd (pass); the `tmp-reclaim.sh` refresh (pass); scripts/census-precheck.mjs census trigger list (CI); tests under test/deploy/ and test/ |
| `retire-legacy-sweeper.py` | **MOVES.** It disables one machine's legacy job, named by a fixed launchd label. (OBSERVED) | `install-janitor.sh` (`--retire-legacy-sweeper`, its copy loop), the `tmp-reclaim.sh` janitor source set (pass), test/mac-generated-cache-safety.test.ts, test/workspace-retirement-safety.test.ts, test/deploy/the-installed-mac-janitor-copies-refresh-themselves.test.ts |
| `JANITOR.md` | **SPLITS.** The general runbook stays; the account names and per-account install steps move. | Only cited as a path: scripts/lib/mac-author-admission.mjs (`MAC_AUTHOR_JANITOR_DRY_RUN` recovery text, author preflight, session); comments in deploy/rmd-host-cleanup.sh and deploy/rmd-session-reaper.sh; test/ci/author-preflight-capacity-refusal.test.ts |
| `install-gh-read-broker.sh` | **STAYS.** It installs the product's `rmd gh-broker`. | src/lib/gh-read-broker.ts:`installedBrokerWarning` and `GhReadBroker` (session); src/lib/gh-read-broker-watch.ts; deploy/install-gh-read-broker.sh (Linux sibling); test/github/* |
| `install-evidence-storage.sh` | **STAYS.** General installer. | docs/evidence-storage.md; test/review/evidence-storage.test.ts |
| `install-seed-open-files.sh`, `seed-open-files.py` | **STAYS.** General; one usage comment names an example account. | scripts/dependency-seeds.mjs (`attestedOpen` reads the scan output, session); test/dependency-seeds-cli.test.ts |

### Operator documents

| File | Class | Readers |
|---|---|---|
| `docs/operator-guide.md` | **SPLITS.** It is mostly the product guide, including the command table. About 17 lines name one host's account, state directories, container names and cloud resource names. (OBSERVED by count) | src/lib/sweep.ts:`ADDITIVE_REGISTRATION_SURFACES` (the literal `\| Command \| What it does \|`, read when a conflict is resolved, per tick); src/lib/runbook-coverage.ts (tests); messages in deploy/serve-container.sh; about 25 tests, including test/runbook-coverage.test.ts and test/docs-claims.test.ts |
| `docs/instance-registry-selection-contract.md` | **STAYS** as the contract; **SPLITS** its lines that name the host. | No code reader (OBSERVED) |
| `deploy/DEPENDENCY-SEEDS.md` | **SPLITS.** Its rollout lines name the operator's accounts. | Cited by deploy/mac files only; no code reader |
| Historical records: docs/forensics, docs/archive, docs/audits, docs/recon, docs/adr, DECISIONS.md, LEARNINGS.md, MASTER-PLAN.md | **STAY.** They are dated evidence; editing them breaks citations. (INFERRED) | Doc-index and citation tests only |

### Fleet values inside code: SPLITS by a parameter change, not by moving a file

These are named so later tasks can find them. No step below depends on them. (OBSERVED)

- **Host script defaults:**
  - Default state directory, image and service user: deploy/install-host-units.sh.
  - Default container registry: deploy/recycle-container.sh, deploy/serve-container.sh, deploy/host-update.sh,
    deploy/verify-image.sh and .github/workflows/acr-build.yml (`inputs.registry`).
  - Memory weights per named container: deploy/resource-policy.sh.
  - Published-remote owner: deploy/rmd-host-cleanup.sh (`PUBLISHED_REMOTES`).
  - Cleanup script path: deploy/rmd-tmp-sweep.sh.
  - Registry path: deploy/field-trials-refresh.sh.
  - Clone URL: deploy/entrypoint.sh (`REPO_URL`).
- **Source constants:**
  - The managed suite table in src/lib/review.ts.
  - The per-repository profiles in src/lib/ci-project-preflight.ts.
  - The default fleet list in src/lib/config-schema.ts.
  - `DEFAULT_FLEET_REPOS` in src/run-task.ts.
  - The repository lists in src/lib/field-trials-*.ts.
- **Session tooling:** hooks/deny-floor.sh refuses destructive commands sent to the fleet host's ssh alias. It
  **STAYS**, because it is a safety floor. No `.claude/skills/*` file names the operator.

## Move order

This fits inside the shard's phases. Phases 0 and 1 (catalog read, overlay review path, overlay instance live,
plan-record movers) move none of these files. Every Phase 2 step has three parts: (a) copy the file to the overlay
and point the reader at it, with core's copy as fallback; (b) prove it from a fresh session or a fresh daemon start;
(c) delete core's copy or replace it with an example, in Phase 3, after a day.

| # | Step | Waits for | Check that proves no read changed |
|---|---|---|---|
| 2.0 | The overlay pointer file lands in core. No such file exists at eb79fd765 (INFERRED: none found; the ops selection is host state read by `opsDispatchSelection`). | Phase 1 | New test: the pointer parses and nothing reads it yet (`git grep` count of readers is 0). |
| 2.1 | Document splits: `docs/operator-guide.md` host sections, `deploy/DEPENDENCY-SEEDS.md` rollout lines, `docs/instance-registry-selection-contract.md` host lines, `deploy/mac/JANITOR.md` account steps. No code reads the moved lines. | 2.0 | Existing test/runbook-coverage.test.ts, test/docs-claims.test.ts and test/claude-md-rules-reach-their-scope.test.ts stay green. A `grep:` proof that `\| Command \| What it does \|` is still in docs/operator-guide.md, which `ADDITIVE_REGISTRATION_SURFACES` reads. |
| 2.2 | Point the 8 tests that read the tracked registry, and the 2 that read the tracked managed list, at fixtures. This changes test reads only and is safe in any phase. | none | `# fail 0`. A `grep -c` of `REPO_ROOT, ".remudero", "daemon-instances.yaml"` across test/ reads 0. |
| 2.3 | Mac session tooling. First remove `retire-legacy-sweeper.py` from `tmp-reclaim.sh`'s janitor set and from `install-janitor.sh`'s copy loop and flag, in one PR. Then move the file. | 2.0 | Existing test/deploy/the-installed-mac-janitor-copies-refresh-themselves.test.ts, plus a new case: a refresh at a commit without the file still installs instead of holding the old copies. |
| 2.4 | The Mac janitor's account names and owner remotes move to a config file the janitor reads, with today's values as fallback. | 2.3 | Existing test/the-shared-mac-janitor-never-enters-another-accounts-home.test.ts and test/rules/the-janitor-preserves-tracked-artifacts.test.ts, plus a new test: the same config gives the same keep and retire decisions as the built-in values. |
| 2.5 | `managed-repos.json`: `loadManagedRepos` reads the overlay copy first, falls back to core's, and reports a configured but unreadable overlay as its own outcome, never as `[]`. If the overlay copy is fetched from GitHub, as the ops catalog is (`createOpsCatalogShadowSource`), this waits for W1-T13705; a host checkout of the overlay would not. (INFERRED) | W1-T13705 (GitHub read) | New test: `resolveIdentities`, `buildIntakeRungsDaemonHooks` and `knownPlanRepos` give the same repository set from the overlay copy as from core's copy, and an unreadable overlay gives the refusal, not an empty set. |
| 2.6 | Registry guard, before any registry move: a selected or overlay registry that is configured but unreadable must refuse arming, never fall back to live. Today only the legacy path's missing file gives live. | none | New test: with the core copy absent and a shadow overlay row, `instanceMode` is not `live` for the shadow repository. |
| 2.7 | Registry readers that fetch from GitHub: `requestGoLive` reads and edits the overlay registry through its existing `registryTarget` (selected) branch instead of the primary repo's `.remudero/` file. | W1-T13705, W1-T13700 | Existing go-live tests, plus a new one: the Console go-live action on a shadow overlay row opens its change on the overlay, and core's file is untouched. |
| 2.8 | Host script and daemon registry readers use the selected path (`RMD_SELECTED_INSTANCE_REGISTRY`, bound by digest) on the live overlay copy: recycle, serve-container, install-host-units, resource-policy, host-update, fleet-heartbeat, field-trials-refresh, and every `daemonInstanceRegistryPath` caller listed above. | W1-T13700, 2.6 | Existing test/selected-registry-shell-consumers.test.ts and test/deploy/legacy-catalog-and-active-selection.test.ts, plus a new census: every `daemonInstanceRegistryPath` caller reads the selected file when it is set (walk the callers, like `rmd census-membership`). GET /v1/registry gives the same body from both copies. |
| 3 | Replace core's `.remudero/daemon-instances.yaml` with a public example and core's `managed-repos.json` with an empty list. Each goes only after its readers have read the overlay copy for a day, as shown by the selected-registry observer and the new refusal outcome from 2.5. | 2.5 to 2.8 | GET /v1/registry, GET /v1/views/instances and the repository dashboard give the same instance and repository sets before and after, as a fixture test. |

## Recommendation

File one task per row below, each in core's public plan unless it says otherwise. None should be a step of the
plan-record move path. The proof shape uses this repo's convention:
`grep: <task id> criterion N in test/<folder>/<name>.test.ts`, with the folder from `rmd test-place`.

| Task | Files | Proof shape |
|---|---|---|
| A. A home-repo pointer lands and nothing reads it yet | a new pointer file under `.remudero/`, its parser in src/lib/, test/plan/ | criterion 1: parses; criterion 2: reader census is 0 |
| B. Move one operator's host steps out of the operator guide and the seed and registry docs | docs/operator-guide.md, deploy/DEPENDENCY-SEEDS.md, docs/instance-registry-selection-contract.md, deploy/mac/JANITOR.md; the overlay copy is filed in the overlay | `grep:` that the command-table literal remains; existing runbook and docs-claims tests |
| C. Tests stop reading the tracked registry and managed list | the 10 tests named above, test/helpers/ | `grep -c` of tracked-file reads in test/ is 0, as a test; `# fail 0` |
| D. The Mac janitor refresh no longer requires the legacy-sweeper retirer | deploy/mac/tmp-reclaim.sh, deploy/mac/install-janitor.sh, test/deploy/ | a refresh at a commit without the file installs; a delete-the-fix run fails |
| E. Move the legacy-sweeper retirer to the home repo | deploy/mac/retire-legacy-sweeper.py (delete), its test cases | `grep:` no reader in deploy/ or test/; refresh test green |
| F. The Mac janitor reads its account names and owner remotes from config | deploy/mac/remudero-janitor.sh, deploy/mac/preserve-retire.py, deploy/mac/tmp-reclaim.sh, test/deploy/ | the same keep and retire decisions from config as from built-ins |
| G. An unreadable selected registry never resolves an instance live | src/lib/instance-mode.ts, test/daemon/ | a shadow row stays not-live with core's copy absent; a delete-the-fix run fails |
| H. Managed repositories read the overlay copy first and say when it is unreadable | src/lib/managed-repos.ts, its callers if the return type changes, test/console-api/ or test/daemon/ | the same set from either copy; an unreadable overlay gives a refusal, not `[]` |
| I. Console go-live edits the overlay registry | src/lib/onboarding-golive.ts, src/lib/serve.ts (`buildOnboardingGoLiveRoutes`), test/console-api/ | go-live changes the overlay; core's file is untouched |
| J. Every registry reader honours the selected registry | src/lib/deployer.ts callers, the deploy/*.sh readers and scripts/fleet-heartbeat.sh listed above, test/deploy/ | caller census; GET /v1/registry gives the same body from both copies |
| K. Core keeps only a public example registry and an empty managed list | .remudero/daemon-instances.yaml, .remudero/managed-repos.json | registry, instances and dashboard fixture parity; filed only after H, I and J have read the overlay for a day |

**Order:** A, then B, C, D and G in parallel (cheap and independent). Then E after D, F after E, and H after
W1-T13705. I and J wait for W1-T13700, and K comes last.

**Not recommended now:**
- Moving the Mac janitor code itself. It would take about 30 tests out of core's CI.
- Rewriting historical docs.

The host-script defaults and source constants under "Fleet values inside code" need their own recon. Each is a
parameter change, not a file move.
