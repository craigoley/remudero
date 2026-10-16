# test/ restructure: a data-derived taxonomy (2026-10-16)

Snapshot: `craigoley/remudero` **origin/main `a323d87`** (2026-10-16 16:29Z, #12341), extracted with
`git archive`. This was a read-only analysis: nothing in the repo was changed. The snapshot has
**3,640 top-level `test/*.test.ts`** files (git tracks 3,645; the other 5 already sit in
subfolders such as `test/helpers/*.test.ts`) and **599 src modules** (590 entries in `src/lib`, plus `src/*.ts`,
`src/cli`, `src/lib/onboard`).

Machine-readable output: `proposed-map.tsv` (here trimmed to test path, folder, kind and confidence), and `stats.json`, which holds every number quoted here. Scripts are under
`scripts/` (rerun recipe in §11).

---

## 0. Recommendation in one screen

Make **subsystem the top level, and give the rule suites one top-level folder of their own** (axis
*e* below). That is 21 folders. The three folders over ~300 files get a second level. Test kind
(unit/integration) stays as metadata in the tier manifest and is not part of the path.

```
test/
  console-api/   407   board/ 130 · serve/ 93 · views/ 57 · read-model/ 54 · (root) 73
  worker/        343   spawn/ 144 · run-task/ 72 · sandbox/ 67 · (root) 60
  ci/            301   gates/ 67 · suites/ 60 · parity/ 51 · coverage/ 31 · (root) 92
  inbox/         257   inbox, operator-agent, escalation, feedback landing, human gate
  rules/         254   census / ratchet / structural suites that read the repo as text
  review/        249   review, risk judge, proofs, check-proof, dep-review
  daemon/        227   daemon loop, self-sync, cadence, fleet control, wake
  plan/          218   task-linter, plan, plan-PR emitter, task-id reservation
  github/        188   open-prs-rest, live-write guard, auto-merge, transport, push, gh floor
  deploy/        183   deployer, host units, recycle, entrypoint, doctor, onboarding
  learning/      140   retro, learnings, skills, knowledge, doctrine
  ledger/        132   ledger, union, compaction, grep, receipts
  sweep/         127   sweep.ts (23k lines) and merge-state
  gardeners/     125   every *-gardener, garden registry
  fix-lane/      111   fix-progress judge, main-health rung, base reproduction, amendments
  routing/       111   models, providers, routing experiments, benchmarks, canaries, cost
  dispatch/       96   drain, dispatch-claim/value/overlap/governor, inflight lock
  memory/         68   host-memory-*, daemon-memory, reapers, headroom, heavy builds
  triage/         39   machine-filing judge, auto-triage, intake
  infra/          34   config/tmp/clock plumbing plus tests of test/helpers itself
  sre/            30   sre lane, incidents, detectors
  helpers/ fixtures/ setup/ lib/     (unchanged)
```

Headline numbers:

| | count | share |
|---|---:|---:|
| tests placed with **high** confidence (dominant subsystem ≥ 67% of score, via a direct import) | 1,876 | 51.5% |
| medium (≥ 55%) | 1,324 | 36.4% |
| low (a judgement call; the TSV names the runner-up) | 425 | 11.7% |
| none (no import, path or name signal) | 15 | 0.4% |
| **cross-cutting**: value-imports **3+** subsystems (core/time plumbing excluded) | 723 | 19.9% |
| **map to no src module** (no direct or helper import of src/ or scripts/) | 253 | 7.0% |
| … of which placed by path strings (scripts/, deploy/, hooks/, workflows, docs) | 229 | |
| … placed by a name keyword only | 9 | |
| … truly unplaceable (→ `infra/`, review by hand) | 15 | |

Before acting on this, read §8. **Moving the files is cheap; the references to them are not.**
`plan/tasks.d` cites 3,594 distinct test paths, 21,069 times. 989 tests compute `REPO_ROOT` as
`..` from their own directory. The rule-suite selector matches on the **path**, so a folder named
`census/`, `ratchets/` or `baselines/` would silently enrol every file under it.

---

## 1. Method

1. **Extraction** (`scripts/extract.py`). For every top-level test file it records:
   - the value imports and the type-only imports of `src/` and `scripts/`;
   - the helpers it imports, and the src modules those helpers reach (closure over
     `test/helpers|setup|lib`);
   - its fixtures;
   - the repo paths it names as strings (`scripts/x.mjs`, `deploy/*.sh`, `hooks/pre-push`,
     `.github/workflows/ci.yml`, `docs/`, `plan/`, `package.json`, …), kept only if the path
     exists at the snapshot;
   - the symbols it imports from each module, and its name tokens;
   - code signals for kind (§4).

   Comments are stripped by a scanner and not by a regex. A regex stripper ate real code: a `//`
   line containing `src/**/*.ts` opens a fake `/*` block. That bug alone hid `catch-erasure-ratchet`'s
   `ls-files` walk.
2. **src subsystems** (`scripts/explore_communities.py`, `scripts/subsystems.py`).
   - Louvain community detection runs over a graph of src→src imports (damped by fan-out, so that
     `daemon.ts` and `run-task.ts` don't glue everything together) plus test co-imports (a pair of
     modules imported by the same test; the 8 modules imported by more than 6% of tests are
     excluded).
   - The communities and the name-prefix census then seeded 23 nameable subsystems as basename
     regexes. 571 of 599 modules are placed by name. The remaining 28 are placed by weighted label
     propagation over the same graph (§2).
3. **Per-test assignment** (`scripts/taxonomy.py`). Every candidate module is scored:
   - weight by how it is reached: direct 1.0, helper 0.35, type 0.15, path string 0.45–0.5;
   - × IDF (rare imports are informative);
   - × the number of imported symbols;
   - plus a strong bonus when the test's name contains the module's tokens or starts with the
     module's name.

   Scores are summed per subsystem (best module plus 0.3 × the rest), and the top subsystem wins.

   Two data-driven corrections are applied:
   - **The `run-task.ts` hub.** It is 58,591 lines and houses the whole CLI (`daemonCommand`,
     `lintPlanCommand`, `reapBranchesCommand`, `buildSweepEffects`, …). When it is the primary
     module, the camelCase tokens of the imported symbols and the test name vote, using two
     vocabularies learned from the data: 128 module-name tokens and 61 test-name keywords. The vote
     moved 46 run-task-primary tests out of `worker/` (to plan, ci, review, fix-lane, github and others).
     72 stay in `worker/run-task/`.
   - **Infra-only tests.** When the only signal is `tmp`/`clock`/`config`, any non-infra
     candidate or a name keyword wins instead.

   Helpers are treated in two ways:
   - A **domain fixture** (`sweep-test`, `ledger-fixture`, `host-cleanup-fixture` → `deploy/`)
     counts toward its domain.
   - **Generic plumbing** (`git-repo`, `gh-shim`, `fake-github`, `wall-clock-bound`, …) counts as
     `harness`, and so lands in `infra/`.

---

## 2. src subsystems: what the data says

**The import graph is only moderately modular.** Modularity Q, measured on the same weighted graph:

| partition | groups | Q |
|---|---:|---:|
| Louvain (best the graph supports) | 19 | **0.457** |
| proposed subsystem map (nameable) | 23 | **0.236** |
| first name token only (`host-`, `model-`, …) | — | 0.087 |

Name prefixes alone carry almost no structure (Q 0.087). The seeded map captures about half of
what the graph supports. The Louvain partition would cut cross-cutting tests from 286 to 120
(under a strict infra exclusion) and raise the mean import concentration per test from 0.815 to
0.905. But its communities are blends that can't be named, for example:

- `run-task + review + live-write-guard + escalate + self-sync + …`
- `clock + benchmark-* + model-canary-* + serve-supervisor`

I tested a "names propose, graph disposes" refinement: a module moves when its neighbourhood pulls
≥ R× harder toward another subsystem. The results:

| R | modules moved | Q | tests cross-cutting | high-confidence tests |
|---:|---:|---:|---:|---:|
| off | 0 | 0.236 | 723 | 1,876 |
| 3.0 | 101 | 0.342 | 615 | 2,053 |
| 2.0 | 174 | 0.378 | 578 | 2,131 |
| 1.5 | 214 | 0.400 | 503 | 2,185 |

It is **rejected as the default.** Even at R=3.0 it moves namesake modules into the hubs' orbit:
`sweep`→github, `fix-progress-judge`/`main-health-rung`→github, `dep-review`→github,
`ledger-projector`→console-api. Folders named after a subsystem would stop containing it. To
inspect those 101 modules as "contested" candidates, run with `REFINE_RATIO=3`.

How well each subsystem agrees with the Louvain communities (share of its modules in its modal
community):

- above 0.7: gardeners 0.85, learning 0.74, github 0.71;
- below 0.35: routing 0.24, triage 0.30, memory 0.31, review 0.33, ci 0.36.

Low agreement here means the subsystem is a cross-cutting concern by nature. Memory budget, for
example, is consulted by daemon, serve and worker.

The full module→folder lists are in Appendix A.

---

## 3. Tests per folder (the recommended tree)

Columns: confidence split, kind split, how many value-import 3+ subsystems, the most frequent
primary modules, and three example tests (high confidence, named after their module where
possible).

| folder | files | high / med / low / none | unit / integ / rule / contract | cross-cutting | top primary modules (tests) | 3 example tests |
|---|---:|---|---|---:|---|---|
| `console-api/` | 407 | 252 / 107 / 48 / 0 | 337 / 55 / 0 / 15 | 76 | status (75), serve (30), status-board (24), board (20), read-model-worker (16), now-view (13) | `read-model-worker`<br>`serve-plan-reload`<br>`console-snapshot-cache` |
| `worker/` | 343 | 236 / 74 / 33 / 0 | 218 / 125 / 0 / 0 | 29 | worker (79), run-task (72), worker-provider (35), worker-home (20), mounts (16), containment (15) | `worker-tool-lineage-joins`<br>`the-daemon-fills-the-child-entry-store-for-its-own-tree`<br>`worker-mcp-isolation` |
| `ci/` | 301 | 132 / 138 / 31 / 0 | 133 / 165 / 0 / 3 | 26 | ci-parity (35), diff-coverage (11), run-task (10), test-slot (10), test-tier-manifest (9), affected-suites (9) | `workflow-guard-mutation-ratchet`<br>`local-diff-coverage-matches-ci`<br>`a-ci-friction-remedy-is-measured-and-reopened` |
| `inbox/` | 257 | 150 / 80 / 27 / 0 | 198 / 49 / 0 / 10 | 78 | inbox (42), feedback-landing (20), escalate (17), operator-agent (17), feedback (13), digest (8) | `operator-agent-action-handoff`<br>`operator-agent-gets-read-the-read-model`<br>`follow-up-policy-stale` |
| `rules/` | 254 | 35 / 186 / 25 / 8 | 0 / 0 / 254 / 0 | 12 | ci (11), recycle-container (7), ci-parity (7), console-parity-ratchet (6), ci-gate (6), workflows (5) | `merge-queue-review-attest`<br>`ci-control-plane-precheck-refuses-before-push`<br>`hand-run-census` |
| `review/` | 249 | 152 / 75 / 22 / 0 | 195 / 54 / 0 / 0 | 47 | review (125), risk-judge (19), run-task (9), review-capacity (9), check-proof (7), verify-human-judge (6) | `proof-queue-audit`<br>`review-provider-provenance`<br>`risk-judge-eval` |
| `daemon/` | 227 | 101 / 91 / 35 / 0 | 154 / 72 / 0 / 1 | 79 | daemon (80), self-sync (23), measurement-cadence (21), fleet-control (16), policy (14), github-event-wake (9) | `github-event-sweep-wake`<br>`a-loop-bounded-child-is-stopped-never-truncated`<br>`fleet-runtime-health-console` |
| `plan/` | 218 | 105 / 82 / 31 / 0 | 145 / 73 / 0 / 0 | 35 | task-linter (60), plan (36), plan-pr-emitter (21), task-id-reservation (17), run-task (11), plan-architect (6) | `plan-pr-emitter`<br>`task-id-reservation`<br>`task-case-file` |
| `github/` | 188 | 101 / 60 / 27 / 0 | 109 / 79 / 0 / 0 | 55 | open-prs-rest (27), live-write-guard (27), arm-auto-merge (24), github-transport (12), git-push (11), deny-floor (9) | `code-scanning-merge-adapter`<br>`github-read-queue-replay`<br>`code-scanning-merge-policy` |
| `deploy/` | 183 | 74 / 90 / 19 / 0 | 74 / 108 / 0 / 1 | 24 | deployer (31), install-host-units (20), recycle-container (12), host-cleanup-fixture (11), host-update (8), entrypoint (7) | `host-serve-evidence`<br>`onboarding-repository-inventory`<br>`report-commands` |
| `learning/` | 140 | 87 / 32 / 21 / 0 | 103 / 37 / 0 / 0 | 30 | retro (41), learnings (23), skill-workshop (16), retro-preflight (5), rule-efficacy (4), skill (4) | `retro-open-pr-guard`<br>`skill-workshop`<br>`automated-retro-preflight-scrubs-self-sync` |
| `ledger/` | 132 | 60 / 30 / 42 / 0 | 120 / 12 / 0 / 0 | 35 | ledger (65), ledger-union (13), compaction (10), status (5), ledger-grep (4), spend-rows (3) | `ledger-union`<br>`ledger-grep`<br>`ledger-path` |
| `sweep/` | 127 | 45 / 66 / 16 / 0 | 113 / 14 / 0 / 0 | 23 | sweep (123), merge-state (2), head-rehome (1), branch-update (1) | `sweep-age-clamp`<br>`an-update-branch-422-is-not-always-a-conflict`<br>`a-head-identity-red-is-rehomed-onto-a-conforming-branch` |
| `gardeners/` | 125 | 78 / 35 / 12 / 0 | 74 / 49 / 0 / 2 | 32 | selector-shadow-gardener (11), ci-friction-gardener (10), flake-incident-gardener (10), host-resource-gardener (9), garden-registry (9), gardener (9) | `host-resource-gardener`<br>`the-fix-lane-gardener-survives-an-unreadable-ci-log`<br>`the-flow-gardener-files-a-remedy-for-the-costliest-unowned-blocker` |
| `fix-lane/` | 111 | 51 / 56 / 4 / 0 | 80 / 31 / 0 / 0 | 23 | fix-progress-judge (29), main-health-rung (22), base-reproduction (8), run-task (7), proof-amendment (6), fix-routing-learner (5) | `a-progress-judge-decides-the-next-fix-round`<br>`the-main-health-rung-reads-run-history-once-per-head`<br>`a-signal-ended-fix-round-teaches-the-routing-learner-nothing` |
| `routing/` | 111 | 73 / 30 / 8 / 0 | 85 / 25 / 0 / 1 | 22 | cost-anomaly (8), benchmark-run (8), experiment-promotion (7), routing-experiments (4), account-usage (4), skill-eval (3) | `model-canary-paired-analysis`<br>`skill-eval-grant-consumption`<br>`provider-auth-sessions` |
| `dispatch/` | 96 | 52 / 34 / 10 / 0 | 76 / 20 / 0 / 0 | 43 | drain (36), dispatch-claim (12), inflight-lock (9), dispatch-value (9), dispatch-overlap (7), dispatch-governor (6) | `dispatch-claim`<br>`inflight-lock`<br>`dispatch-value` |
| `memory/` | 68 | 42 / 22 / 4 / 0 | 49 / 19 / 0 / 0 | 21 | host-memory-shadow (10), object-reaper (8), headroom (6), daemon-memory-policy (5), host-memory-admission (3), idle-lane-accounting (3) | `owned-run-cgroup`<br>`heavy-build-reservation`<br>`disk-artifact-reclaim-refuses-a-live-or-dirty-target` |
| `triage/` | 39 | 17 / 16 / 6 / 0 | 27 / 12 / 0 / 0 | 22 | machine-filing-judge (13), auto-triage (9), triage (8), classify (4), opportunity-outcomes (1), codeql-quality-intake (1) | `the-machine-filing-judge-survives-one-bad-record`<br>`triage-lane-outcomes`<br>`auto-triage-daily-cap` |
| `infra/` | 34 | 10 / 13 / 4 / 7 | 13 / 21 / 0 / 0 | 0 | git-repo (3), wall-clock-bound (3), config (2), composition-root (2), tmp (2), clock-shift (2) | `composition-root`<br>`config-schema`<br>`learnings-homes-config` |
| `sre/` | 30 | 23 / 7 / 0 / 0 | 23 / 7 / 0 / 0 | 11 | sre-lane (6), incident-invariants (3), ops (3), actions-incident (2), sre-governor (2), main-run-gaps (1) | `the-sre-lane-evaluates-fleet-flow-detectors`<br>`sre-lane`<br>`incident-invariants` |

**Second level** (only where a folder exceeds ~300). Families are taken from the primary module's
name, and a family needs ≥ 25 tests to get a subfolder:

- **`worker/`** — `spawn/` 144 (worker, worker-provider, worker-home, worker-tool-lineage, worker-scratch), `run-task/` 72 (run-task), `sandbox/` 67 (mounts, containment, worker-containment, capability-grant, isolation), root 60; by kind instead: {'unit': 218, 'integration': 125}
- **`console-api/`** — `board/` 130 (status, status-board, board, board-worker, board-review), `serve/` 93 (serve, service, analytics-route, serve-policy-convergence, serve-plan-reload), root 73, `views/` 57 (now-view, views, view-shadow, nav-badge-view, view-freshness), `read-model/` 54 (read-model-worker, board-projection, read-plane, console-snapshot-cache, read-model-consistency); by kind instead: {'unit': 337, 'integration': 55, 'contract': 15}
- **`ci/`** — root 92, `gates/` 67 (census-precheck, head-identity-gate, comment-load-ratchet, workflow-guard-mutation-ratchet, typecheck-run), `suites/` 60 (test-slot, test-tier-manifest, affected-suites, test-with-retry, wipe-test), `parity/` 51 (ci-parity, ci-friction-remedy, ci-failure-corpus, ci-escalation-judge, ci-incidents), `coverage/` 31 (diff-coverage, diff-coverage-local, coverage-merge-ratchet, coverage-ratchet, coverage-improvement); by kind instead: {'integration': 165, 'unit': 133, 'contract': 3}

The kind split is shown for comparison. A family split keeps each module's tests together. A kind
split puts the same module's tests in two places and moves a file whenever it gains a git fixture.

**Optional merges** if 21 is too many: `sre/` (30) into `gardeners/`, since both are governed
lanes, and `triage/` (39) into `gardeners/`, since the machine-filing judge sat in the gardener
Louvain community. Either merge keeps the count at 19–20, and every folder stays at 30 files or
more.

---

## 4. Test kind, detected per file

| kind | files | median runtime | p90 | > 5 s |
|---|---:|---:|---:|---:|
| unit | **2,326** (63.9%) | 23 ms | 2.6 s | 102 |
| integration (real git, child process or HTTP server) | **1,027** (28.2%) | 2.7 s | 12 s | 235 |
| rule (reads the real repo as text) | **254** (7.0%) | 0.9 s | 6.8 s | 37 |
| contract (OpenAPI spec / `contracts/` / wire schema) | **33** (0.9%) | 0.9 s | 5.8 s | 5 |

Runtimes come from `scripts/test-tier-manifest.json` (3,450 files covered).

Signals per file:

- git fixture (`gitRepo()` / `git init`): 671
- execs git: 449
- spawns `node`/`tsx`: 373
- any spawn: 911
- HTTP server or fetch mock: 43
- gh mocks (`gh-shim`, `fake-github`, an inline `GitHub` object): 369
- `mkdtemp`: 2,121
- defines a repo root: 989
- repo walks (`ls-files` or recursive readdir on repo-anchored paths): 95
- reads src text: 258
- reads workflow YAML: 169

**Rule** means one of the following:

- it walks a repo population;
- it reads repo-anchored text (src, workflows, plan, docs, baselines, package/tsconfig, deploy
  scripts) with no behavioural src import;
- it is in the official population (below) and reads repo text at all.

Paths are anchored by following `const` aliases back to `import.meta`, `__dirname` or `cwd`.
Paths derived from tmp dirs or fixtures don't count.

**390 behavioural tests also grep a src file or read a workflow** ("wiring assertions": the
behaviour test plus one source-text check). These are **not** rule suites. They keep their kind
and folder.

**Against the repo's own definition.** `listRuleSuites()` (`src/lib/ci-parity.ts:2887`) selects
`CENSUS_POPULATION` (12 roster files) plus every test whose name matches
`/(?:census|ratchet|baseline)/i` without an `@not-a-rule-suite` marker. That gives 88 files today.
Comparing it with the detector:

- **48** of the 88 are detected as structural.
- **40** are not: they are unit or integration tests *of the census machinery*, such as
  `a-census-refused-push-kills-a-finished-build` (drives `runTask` against a git origin) and
  `census-precheck-counts-the-house-layout-ratchet`. They belong in `ci/gates/`.
- **206** structural suites are outside the official population, because their names don't say
  `census|ratchet|baseline`. Examples: `a-required-check-outside-ci-yml-has-a-local-route`,
  `deploy-scripts-use-mktemp`, `every-shard-on-main-is-lintable`.

I spot-checked about 40 rule assignments by eye. Precision is good for walks and config reads. The weak
spot is a behavioural test that reads one `ci.yml` field with no src import, which is counted as
rule. Treat `kind` as roughly 80–90% right and fix individual rows in the TSV.

**Verdict on kind as an axis.** Kind is detectable and rarely ambiguous: 201 files (5.5%) carry
signals for 2+ kinds. But it is the wrong *folder* axis:

- `unit/` would hold 2,326 files;
- `contract/` would hold 33;
- the line moves whenever a test gains a git fixture.

Kind is already captured where it pays off, in the fast/slow tier manifest.

---

## 5. A home for the rule suites: `test/rules/`

These suites are a different kind of thing from the rest. They guard the *repository*, not a
module, and they are what the fast rule-check lane exists for. Of the 254:

- 129 guard CI / tooling surfaces;
- 22 deploy scripts;
- 22 test infrastructure;
- 18 docs / learnings;
- 13 worker;
- the rest is spread thinly.

At under 300 files the folder needs no second level. If one is wanted, use the guarded subsystem
(`rules/ci/`, `rules/deploy/`, …).

Proposed contract, needing one small code change:

1. **Make the folder the declaration.** `listRuleSuites()` should select `test/rules/**` (plus
   the roster) instead of the name regex. A new census then joins the lane by where it lives, not
   by remembering a word.
2. **Mind the cost before flipping it.** Membership by folder grows the lane from 88 files /
   226 s serial (summed tier-manifest durations) to 254 files / 759 s serial.
   `runRuleSuites` runs files one at a time. Either:
   - keep the fast lane to `rules/` files under a duration bound (the tier manifest already
     knows each one's cost), or
   - shard it.
3. **Until (1) lands, never use `census`, `ratchet` or `baseline` in a folder name.**
   `RULE_SUITE_NAME_RE` is tested against the path after `test/`, so `test/ci/census/x.test.ts`
   would enrol every file in that folder. For this reason the proposal uses `ci/gates/` and
   `rules/`. The 40 machinery tests whose *file names* contain those words stay enrolled by name,
   wherever they live. That is today's behaviour, and nothing changes for them.

---

## 6. The axes compared

| axis | top-level folders | largest | median | > 300 | < 20 | Gini | ambiguous | rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| (a) subsystem (rule suites stay with what they guard) | 20 | 430 | 147 | 3 | 0 | 0.35 | 1,003 | 27.6% |
| (b) kind | 4 | 2,326 | 641 | 2 | 0 | 0.53 | 201 | **5.5%** |
| (c) kind → subsystem (leaf folders) | 64 | 337 | 24 | 1 | **27** | 0.59 | 1,171 | 32.2% |
| (d1) mirror src as it is (flat `src/lib`) | 29 dirs | **2,990** | 7 | 1 | 21 | 0.91 | — | — |
| (d2) mirror src per module | **754** | 138 | **2** | 0 | 722 | 0.63 | 782 | 21.5% |
| **(e) subsystem + `rules/` (recommended)** | **21** | 407 | 140 | 3 | 0 | **0.33** | 959 | 26.3% |

How "ambiguous" is defined:

- (a) and (e): low or no confidence, or cross-cutting. The rules/ files don't count under (e).
- (b): signals for 2+ kinds.
- (c): either of the above.
- (d2): the runner-up module scores ≥ 80% of the primary.

Notes on each:

- **(b)** is the least ambiguous axis but is useless as a layout. Two folders hold 91% of the
  files.
- **(c)** fragments the tree: 27 of 64 leaves hold fewer than 20 files. It also inherits *both*
  ambiguities, and adds churn whenever a test's kind changes.
- **(d)** is only meaningful after `src/lib` itself is restructured. Today it collapses into one
  folder of 2,990 files.
  - Per-module mirroring gives 754 folders with a median of 2 files and 306 singletons.
  - If `src/lib` were later split into `src/lib/<subsystem>/` using this same map, test mirroring
    would become identical to (a). This proposal is therefore the cheap first half of (d).
  - Restructuring src first means moving 590 modules and rewriting every import in src and
    test. That is a far bigger change for no extra test-side benefit.
- **(e)** has the most even distribution (Gini 0.33), no folder under 30 files, and three folders
  that need a second level.

**About 26% ambiguity is the floor for any single-parent layout of these tests.** 723 tests
genuinely span 3+ subsystems. Value-import histogram (number of non-infra subsystems → tests):

| subsystems | tests |
|---:|---:|
| 0 | 492 |
| 1 | 1,417 |
| 2 | 1,008 |
| 3 | 443 |
| 4 | 185 |
| 5 | 63 |
| 6+ | 32 |

Folders are a browsing aid, not a dependency model. Selecting by import closure
(`select-affected-suites`) keeps working regardless of layout.

---

## 7. Naming conventions

| measure | value |
|---|---:|
| median words / chars | 7 / 38 (p90 11 words, max 16 words / 82 chars) |
| sentence-style (≥ 5 words with a verb or article) | 2,102 (57.7%) |
| starts with `a-` / `the-` / `an-` | 1,075 / 507 / 143 (47.4% in all) |
| starts with `every-` / `no-` / `each-` / `all-` / `never-` | 82 |
| named after its own primary module (`sweep-*`, `agent-view`) | 746 (20.5%) |
| named after *any* src module | 836 (23.0%) |
| contains a task id (`w1-t…`) | 13 |
| **basenames unique** | **3,640 / 3,640** |

**Do the names already encode a subsystem token?** Only partly. 61 tokens were learned from
confidently placed tests, keeping those with ≥ 60% of ≥ 8 uses in one subsystem. Examples:
`serve`, `board`, `view` → console-api; `coverage`, `census`, `suite` → ci; `retro` → learning;
`gardener`; `drain` → dispatch; `canary` → routing.

| | tests | share |
|---|---:|---:|
| tests that contain at least one such token | 1,403 | 38.5% |
| … of which the name token agrees with the import-derived folder | 988 | 70% |
| **folder recoverable from the name alone** | | **~27%** |

A name-prefix taxonomy would therefore misfile most tests. Names complement imports (they break
the `run-task` hub ties) but cannot replace them.

**Keep the sentence names. Don't rename as part of the move.**

- They are behaviour specs, which is why they are long.
- They are globally unique today, so a basename is a stable key even after files move into
  folders.
- `plan/` proofs, comments and the census roster all refer to them, and so do the 292 files whose
  first line is `// test/<own-name>.test.ts`.

The folder now carries the subsystem, so no prefix needs adding. Two optional, low-churn
conventions for *new* files:

- module-level unit suites keep the `<module>.test.ts` form (20% already do);
- rule suites live in `rules/`, so their names no longer need `census|ratchet|baseline`.

---

## 8. Migration coupling: measured, and it decides the plan

| coupling | measured |
|---|---|
| imports `../src`, `./helpers` or `../scripts` (path depth changes) | 3,409 files |
| computes `REPO_ROOT` as `..` relative to its own dir | **989 files** |
| test paths cited in `plan/` | 21,069 refs to 3,594 distinct tests. Open shards (queued 387 + blocked 340) carry ~5,850 refs, merged shards 14,449 |
| cited in `scripts/` | 7,317 refs / 3,457 tests (mostly the regenerable tier manifests) |
| cited in `src/` | 575 refs / 356 tests (e.g. the `CENSUS_POPULATION` roster) |
| cited in `docs/` / `.github/` / `package.json` | 376 / 51 / 28 (`test:*` scripts) |
| test files citing another test's path | 1,664 |
| flat-layout readers to audit | `.github/workflows/ci.yml:475` `ls test/*.test.ts` (a shell glob; not recursive); `readdirSync(join(root,"test"))` in `scripts/fixture-copy-census.mjs:69`, `scripts/diff-class.mjs:290/310/545`, `scripts/clock-sweep.mjs:40`, `src/lib/knowledge-gardener.ts:259`, `src/lib/selector-shadow-gardener.ts:1123`. `git ls-files 'test/*.test.ts'` already recurses (verified) and `test-tier-manifest.mjs` walks recursively, so those two are safe |

What this coupling means for the move:

- **`REPO_ROOT` is the dangerous one.** A census in `test/rules/` that still resolves `..` would
  read `test/src/…`, and a census that walks a missing directory can **pass while comparing
  nothing**. Before anything moves, put a shared `repoRoot()` in `test/helpers` and migrate all
  989 tests to it in its own PR. Prove every census asserts a minimum population, by
  fault-injecting the root and watching it go red.
- **Plan proofs.** `grep: … in test/x.test.ts` and `unit test: test/x.test.ts` proofs in the 727
  open shards would go stale, and per the "refactor can falsify its plan proof" lesson a
  stale-path grep reads 0 → FAIL. Since basenames are unique, the cheapest fix is for the proof
  resolver (`review.ts` / `task-linter.ts`) to resolve a `test/<name>.test.ts` that is missing by
  its unique basename under `test/**`. That has to land **before** the move. The alternative is
  ~5,850 plan amendments.
- **Sequencing.** Do it in one mechanical codemod PR driven by `proposed-map.tsv`: `git mv`,
  rewrite relative imports, regenerate the tier manifests, update `package.json` `test:*` scripts
  and the `CENSUS_POPULATION` roster. Land it on a quiet board, because every open run- branch
  that touches a test conflicts. If a single PR is too disruptive, move one folder per PR in
  ascending size.

---

## 9. Known limitations of the mapping

- Placement is import-driven. A test that imports `review.ts` but is *about* plan linting lands in
  `review/` unless its name says otherwise. The 425 low-confidence rows name their runner-up
  subsystem. Review those by hand, or accept them.
- `status.ts` (board/status reader, 5,881 lines) is grouped under `console-api/board/`. Louvain
  places it with ledger, sweep and analytics. Its 75 tests are the most debatable block.
- 15 tests carry no signal at all and go to `infra/`, for example `a-browser-boundary-has-no-directive`
  and `project-mcp-config`.
- Kind precision is roughly 80–90% (eyeballed, §4). The official-by-name rule population is reported separately
  in the `reason` column (`rule-suite-by-name`).

---

## 10. Files

- `proposed-map.tsv`: 3,640 rows: `test_path`, `proposed_folder`, `kind`, `confidence`
  (high / medium / low / none), and `reason`. The reason gives the primary module and its
  subsystem, the score share, the runner-up subsystem, the kind signals, any hub or infra
  re-vote, and the cross-cutting count.
- `stats.json`: all aggregates, including module→subsystem lists, learned name keywords,
  module-name token vocabulary, helper→subsystem map, axis size distributions, kind durations,
  and naming stats.
- `scripts/extract.py`, `explore_communities.py`, `louvain.py`, `subsystems.py`, `taxonomy.py`,
  `compare_partitions.py`, `render_tables.py`.

## 11. Rerun

The Python scripts named above live in the operator's session notes, not in this repository.
The build that ports the classifier (placeTest) reproduces sections 1-3 from `subsystem-map.json`
beside this file, and `proposed-map.tsv` is the reviewed output at the snapshot.

---

## Appendix A: src modules per folder

`rules/` maps to no src subsystem: its suites guard the repo. Modules are listed by basename.

- **`console-api/`** (72 src modules): ability-map, action-results, actions-view, actor-evidence, agent-view, analytics-breakdowns, analytics-live-metrics, analytics-route, analytics-timeseries, analytics-view, assistant-action-discovery, automation-trigger, board, board-projection, board-review, board-snapshot-cache, board-worker, console-projection-worker, console-snapshot-cache, console-snapshot-store, console-telemetry, feedback-view, glance, host-view, inbox-thread-list-view, inbox-thread-view, inbox-view, instance-gateway, instances-view, last-seen, live-analytics-snapshot-cache, nav-badge-view, needs-you-view, now-decisions, now-view, panel-actions, panel-graph, panel-skill-run, panel-skills, read-model-cli, read-model-consistency, read-model-db, read-model-slow-lane, read-model-worker, read-page, read-plane, read-plane.worker, recent-projection, relay-client, repo-dashboard-route, repositories-view, route-read-rollup, serve, serve-drain, serve-generation, serve-plan-reload, serve-policy-convergence, serve-restart-relevance, serve-slots, serve-supervisor, serve-supervisor-main, service, status, status-board, status-stream-publisher, view-demand, view-events, view-freshness, view-shadow, views, workstreams-projection-reuse, workstreams-view
- **`worker/`** (38 src modules): capability-grant, capability-inspection, check-proof-main, child-entry-argv, child-entry-store, containment, context-controls, hand-worktree, isolation, mount-exploration, mount-recommender, mounts, poll-read-retry, producer-completeness, producer-identity, prompt-manifest, prompt-render, run-child, run-child-contract, run-child-main, run-child-mode, run-result, run-task, secret-boundary, spawn-guard, tool-step-signature, untrusted-envelope, worker, worker-containment, worker-home, worker-init-summary, worker-mcp-isolation, worker-provider, worker-scratch, worker-telemetry, worker-tool-lineage, worktree-config, worktree-sites
- **`ci/`** (36 src modules): affected-suites, changed-files-cache, ci-control-plane, ci-escalation-judge, ci-failure-corpus, ci-friction-remedy, ci-gate-required, ci-incidents, ci-learning-graphql, ci-lesson-recurrence, ci-parity, ci-refresh-prevention, coverage-improvement, coverage-nightly-intake, diff-coverage-targets, followup-dedup-census, gate-fire-rate, gate-observations, gate-posture, grep-zero-cause, hand-run-census, merge-probe, preopen-gate, qualified-symbol-shadow, source-size-followup, source-text-readers, test-file-admission, test-impact-map, test-run, test-slot, test-slot-capacity, test-slot-mutation, test-slot-parent, typecheck-buildinfo, typecheck-run, wipe-test
- **`inbox/`** (57 src modules): action-executor, action-reconciliation, ask-classification, automation-action, consequence-policy, delegation-profile, deploy-refusal-escalation, digest, escalate, escalation-answers, escalation-catalogue, escalation-precision, escalation-triage, feedback, feedback-docket, feedback-landing, feedback-reconcile, feedback-record-merge, follow-up-policy, grill-choices, host-escalation-spool, human-gate, human-handoff, inbox, inbox-board-referents, inbox-dismissal-audit, inbox-owner, inbox-plain, inbox-recommendation, inbox-replay, inbox-responder, inbox-thread, inbox-verdict-command, instance-inbox-contract, instance-inbox-proposal, notify, operator-agent, operator-agent-action-handoff, operator-agent-answer, operator-agent-capacity, operator-agent-decisions, operator-agent-outcomes, operator-agent-proof, operator-agent-read-model, operator-identity-file, operator-interventions, operator-mcp, operator-merge-hold, operator-message, operator-notes, operator-sync, preference-policy, promised-follow-ups, recap, reply-interpreter, ruling-judge, standing-briefs
- **`review/`** (36 src modules, from review + dep-review): bre-metachars, check-proof, dep-review, dependency-seeds, flight-judge, flight-signals, fold-debt-pull, gate-verdict-record, held-dependency-roots, judge-calibration, mutation-verdict-pull, non-worker-verdict, paired-review-eval, proof-base-stale, proof-grammar, proof-missing-export, proof-queue-audit, proofExecutor, reader-agreement, review, review-capacity, review-finding-evidence, review-finding-outcomes, review-findings, review-flow-observation, review-provider-provenance, reviewer-worktree-lease, risk-judge, risk-judge-eval, risk-score, shadow-judge, specialist-panel, typed-judgment, verdict-calibration, verify-human-judge, verify-human-release
- **`daemon/`** (24 src modules): breaker-release, daemon, daemon-health, emergency-control, fleet-control, fleet-lane, fleet-liveness, fleet-runtime-health, flush-exit, github-event-wake, liveness-pulse, loop-bounded-child, loop-stall-profiler, measurement-cadence, measurement-cadence-child, policy, poll-interval, presence, progress-watchdog, quiet-worker-watchdog, self-forecast, self-sync, stall-verifier, unfinished-checkpoint
- **`plan/`** (30 src modules): advance-declarations, block-reason, companion-paths, goals, intent-plan, intent-planner, memory-lint, never-worked, plan, plan-architect, plan-coherence, plan-index, plan-pr-emitter, plan-pr-merge-safety, plan-proposals, plan-reconcile, plan-scope, ratification, relint, supersession, synthetic-tasks, task-card, task-case-file, task-id, task-id-release, task-id-reservation, task-linter, task-shard-name, task-view, thread-plan
- **`github/`** (24 src modules): arm-auto-merge, authority, branch-reaper, checkout-head, closing-reference-guard, code-scanning-merge-adapter, code-scanning-merge-policy, commit-message, git-fetch-retry, git-push, github-app, github-posture, github-read-queue-replay, github-refresh-pacer, github-transport, live-write-guard, open-prs-rest, pr-blocker, pr-board, pr-checks, pr-diff, pr-open, security-merge-admission, worktree-git
- **`deploy/`** (36 src modules): baked-runtime-inputs, bundle, deploy-judge, deployer, doctor, engine-tree, host-identity, host-parity, host-serve-evidence, image-drift, init, install-hash, install-root, instance-mode, instance-registry, instance-registry-selection, inventory, launchd, launcher-host-alerts, managed-repos, narrative-fold, onboarding-golive, onboarding-readiness, onboarding-repository-inventory, onboarding-repository-listing, owner-repo, project-init, recon, repo-layout, repo-location, report-commands, repository-flow, session, staged-install, synthesize, version-switchback
- **`learning/`** (23 src modules): doctrine-lifecycle, golden-corpus, knowledge-dedup, knowledge-gaps, knowledge-inventory, knowledge-outcome, knowledge-symbols, knowledge-value, learning-lexical, learnings, orientation, prompt-evolution, provenance, reachability, retro, retro-closure, retro-open-pr-guard, retro-preflight, retro-subprocess, rule-efficacy, skill, skill-workshop, workflow-mining
- **`ledger/`** (23 src modules): autonomy, compaction, correct, emissions, ledger, ledger-carry, ledger-compact, ledger-compaction-rung, ledger-grep, ledger-path, ledger-projector, ledger-replay, ledger-steps, ledger-union, log-rotation, read-only-inspection, receipt, recovery-refs, replay, replay-harness, repo-ledger-index, spend-rows, trace
- **`sweep/`** (4 src modules): branch-update, head-rehome, merge-state, sweep
- **`gardeners/`** (26 src modules): backlog-gardener, ci-friction-gardener, config-gardener, evidence-coverage-gardener, export-gardener, fix-lane-gardener, flake-incident-gardener, flow-gardener, flow-remedy-gardener, garden-registry, gardener, gardener-opportunity-evidence, gardener-overseer, gardener-runtime, gardener-spend, gardeners-route, gate-gardener, host-resource-gardener, hot-file-gardener, issue-revalidation-garden, knowledge-gardener, plan-gardener, remedy-effect, scout-gardener, selector-shadow-gardener, test-gardener
- **`fix-lane/`** (21 src modules): alert-fix-body, base-reproduction, body-repair, census-fix, ci-remedy-execution, dispatch-repair, fix-fence, fix-outcome, fix-progress-judge, fix-round-base, fix-round-reapply, fix-routing-learner, fix-rung-classify, live-edit-ladder, main-health-rung, plan-shard-repair, proof-amendment, refusal-amendment, repair-cost-evidence, strike-ladder, strike-schedule
- **`routing/`** (62 src modules): account-usage, bakeoff-trigger, benchmark-aa, benchmark-aa-prospective, benchmark-aa-readiness, benchmark-cohort, benchmark-evidence, benchmark-paid-pilot, benchmark-readiness-intake, benchmark-run, benchmark-verified-outcome, cash-allowance-lock, cash-request-effort, cash-responses, cash-trial, cash-web-bridge, claude-model-health, codex-capacity-probe, cost-anomaly, draft-routing, eval-card, experiment-promotion, field-trials-cohorts, field-trials-flow, field-trials-github, inbox-bakeoff, model-availability, model-canary-command, model-canary-context, model-canary-context-schedule, model-canary-metrics, model-canary-owner, model-canary-paired-analysis, model-canary-report, model-canary-retention, model-canary-retention-schedule, model-canary-rotation, model-canary-runner, model-canary-schedule, model-canary-suite, model-canary-transport, model-drift, model-gate, model-pool, paired-trial, prevention-source-evidence, provider-auth-sessions, provider-routing-policy, provider-routing-status, routing-daily-status, routing-experiments, routing-objective, routing-prior, routing-quarantine-resolution, skill-eval, skill-eval-command, skill-eval-control, skill-eval-gate, skill-eval-grant-consumption, skill-eval-reservation, spike, usage-telemetry
- **`dispatch/`** (17 src modules): adaptive-wip, contributor-admission, dispatch-claim, dispatch-governor, dispatch-overlap, dispatch-value, drain, drain-lock, inflight-lock, parallel-attempts, pause-target, recycle-yield, reservation-chain, run-child-reservation, task-class, tier, upgrade-allocation
- **`memory/`** (26 src modules): clone-reaper, daemon-footprint, daemon-memory-census, daemon-memory-policy, daemon-memory-telemetry, disk-artifact-reclaim, git-lock-reclaim, headroom, heavy-build-reservation, heavy-ready-deadline, heavy-ready-startup, host-memory-admission, host-memory-calibration, host-memory-learning, host-memory-ledger, host-memory-priority, host-memory-shadow, idle-capacity-detector, idle-lane-accounting, in-tree-budget, object-reaper, owned-run-cgroup, review-worktree-reclaim, serve-memory, worker-heaps, workspace-cleanup-contract
- **`triage/`** (10 src modules): auto-triage, classify, codeql-quality-intake, issues-intake, machine-filing, machine-filing-judge, opportunity-intake, opportunity-outcomes, triage, triage-lane-outcomes
- **`infra/`** (15 src modules, from core + time + harness): cli-args, clock, composition-root, config, config-schema, env, errors, fs-race-safe, lock-busy-retry, registry, settings, short-path-root, time-window, tmp, tty
- **`sre/`** (18 src modules): actions-incident, alert-lane, fleet-flow-detectors, foreign-pause-detector, impossible-canary, incident-events, incident-invariants, incident-lifecycle, incidents-view, main-run-gaps, ops, runbook-coverage, sre-governor, sre-lane, sre-runbooks, state-reconciler, stranded-task-detector, work-integrity
