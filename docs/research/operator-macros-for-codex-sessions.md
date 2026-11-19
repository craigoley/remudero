# Operator macros for Codex sessions, not Codex workers

Recon for W1-T13726. Tree: `origin/main` at `eb79fd765d0ad4505aa2ebf6a29c3b1c1afed49f`. No repository file was changed.
Codex version: **codex-cli 0.169.0**. The pin is in `deploy/package.json` (`"@openai/codex": "0.169.0"`), and
`deploy/package-lock.json` agrees (`node_modules/@openai/codex` 0.169.0). The `deploy/Dockerfile` CLI layer refuses
a range, or a lock that disagrees with the pin. OBSERVED.

Sources, all read 2026-11-19:
- Source at tag `rust-v0.169.0`, from `https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/<path>`. Paths
  are given below as `<path>:<symbol>`.
- The `codex-cli 0.169.0` binary, installed from npm into a scratch folder (`codex --version` printed
  `codex-cli 0.169.0`). It was run as `codex debug prompt-input` against throwaway fixtures. That command renders the
  model-visible prompt as JSON, and it needs no login.
- At that tag, `docs/skills.md` holds only a link to developers.openai.com/codex/skills. That page and the
  learn.chatgpt.com "Build skills" page could not be reached from this session (the proxy refused them), so nothing
  below rests on them.

## Where Codex looks for skills

- OBSERVED (`codex-rs/ext/skills/src/host_roots.rs:resolve_skill_roots_with_home_dir`, `roots_from_layer_stack`,
  `repo_agents_skill_roots`): Codex 0.169.0 scans these roots.
  1. Repository (Repo scope): `.agents/skills` in every directory from the project root down to the cwd. The project
     root is the nearest ancestor holding a `project_root_markers` entry, which defaults to `[".git"]`
     (`codex-rs/config/src/project_root_markers.rs:DEFAULT_PROJECT_ROOT_MARKERS`). A linked worktree's `.git` file
     counts as that marker, so the scan stops at the worktree root.
  2. Project config layers: `<layer>/.codex/skills`. These load only when the project layer loads, which requires
     trust.
  3. User layer: `$CODEX_HOME/skills` (the code calls it "deprecated", kept for backward compatibility),
     `$HOME/.agents/skills`, and the bundled system-skill cache under `$CODEX_HOME`.
  4. System layer: `/etc/codex/skills` (Admin scope).
  5. Plugin skill roots and any extra roots.
- OBSERVED: no `.claude/skills` root exists anywhere in that resolver. A fixture holding only `.claude/skills` would
  list nothing, and the shipped macros had none in Codex, which confirms W1-T4332's premise.
- OBSERVED (`codex-rs/config/src/loader/mod.rs:load_user_config_layer`): `--ignore-user-config` still pushes an empty
  User layer, so the user-layer skill roots in item 3 are still scanned. The flag drops only
  `$CODEX_HOME/config.toml`.
- OBSERVED (fixture, untrusted git repo): a skill in the repository's `.agents/skills` was listed in the prompt with
  no trust decision saved. `repo_agents_skill_roots` contains no trust check.
- Explicit-only skills:
  - OBSERVED (`codex-rs/ext/skills/src/provider/host.rs`): `allow_implicit_invocation: false` in `agents/openai.yaml`
    calls `hidden_from_prompt()`.
  - OBSERVED (`codex-rs/ext/skills/src/catalog.rs:is_model_visible` = `enabled && prompt_visible`): the catalog
    renderer (`render_dedup.rs`) and the skills list and read tools (`tools/list.rs`, `tools/mod.rs`) all filter on
    it.
  - OBSERVED (fixture): an explicit-only skill's name and description were absent from the rendered prompt, while an
    implicit sibling in the same folder was present.
- OBSERVED (fixture): Claude's `disable-model-invocation: true` frontmatter means nothing to Codex. A copy of the
  generated `.claude/skills/tddr/SKILL.md` placed under `.agents/skills` was listed implicitly ("- tddr: Think deeply
  …"). Adding `agents/openai.yaml` with `allow_implicit_invocation: false` removed it.
- `$name` mentions:
  - OBSERVED (`codex-rs/ext/skills/src/selection.rs:collect_explicit_skill_mentions`): a `$name` mention matches on
    `entry.enabled` only, so a hidden skill that is still enabled can be invoked by name.
  - INFERRED: the skill's body then enters context. `debug prompt-input` does not resolve mentions, so this was not
    observed.
- Does `codex exec` load skills?
  - OBSERVED: `codex-rs/exec/src/lib.rs` runs an `InProcessAppServerClient`.
  - OBSERVED: `codex-rs/app-server/src/extensions.rs` installs `codex_skills_extension` into that server.
  - INFERRED: `codex exec` therefore builds the same catalog as `debug prompt-input`. `exec` itself was not run,
    because it needs a login.
- Config switches (OBSERVED in `codex-rs/config/src/skills_config.rs:SkillsConfig`, and each tested by fixture
  through `-c`):
  - `-c skills.include_instructions=false`: the catalog block disappears entirely, including bundled skills.
  - `-c 'skills.config=[{name="<n>",enabled=false},…]'`: that skill is removed. `path=` with an absolute SKILL.md path
    also works. A disabled skill also cannot be invoked with `$name` (from `selection.rs`).
  - `-c 'project_root_markers=[]'` run from a subfolder: the repository root's `.agents/skills` disappeared. INFERRED:
    the cwd's own `.agents/skills` is still scanned, and the empty list also changes project-config discovery, so it
    is not a clean exclusion.
  - `--enable skip_host_skill_discovery`: had no effect. The feature is `Stage::UnderDevelopment` and conditional
    (`codex-rs/features/src/lib.rs`).

## What a Codex worker would see

- OBSERVED (`src/lib/worker-provider.ts:codexExecArgs`): a fresh worker runs `codex exec --json --ignore-user-config …
  -C <cwd> -`. Its cwd is the task's git worktree. A writer's cwd is checked by `verifiedGitWorktree` in
  `spawnCodexWorker`.
- OBSERVED: the `-c` overrides cover the PreToolUse hook (`codexPreToolUseProfile`), the permissions profiles,
  `shell_environment_policy.*`, `project_doc_fallback_filenames`, `project_doc_max_bytes` and
  `model_reasoning_effort`. None of them is a `skills.*` key; `grep -n skills src/lib/worker-provider.ts` finds
  nothing.
- OBSERVED (`src/lib/worker-provider.ts:codexSpawnEnv`, `codexHome`): the worker's `CODEX_HOME` is the shared Codex
  home (`config.workerProviders.codexHome`, else `$CODEX_HOME`, else `~/.codex`). Its `HOME` is the per-run
  `args.workerHome` (W1-T2800).
- OBSERVED (`src/lib/worker-home.ts:WORKER_HOME_SYMLINKS`): the worker home links only `.claude`, the Playwright
  cache, `.gitconfig` and the macOS login keychain. Nothing links `.agents`.
- OBSERVED (`deploy/codex-requirements.toml`, installed as `/etc/codex/requirements.toml`): this file is only a
  `[permissions.filesystem] deny_read` list. It says nothing about skills, and no `/etc/codex/skills` is installed.
- OBSERVED (fixture: a linked git worktree of a repository with `.agents/skills`, `HOME` redirected to an empty
  folder, a separate `CODEX_HOME`): each skill location gave this result.

  | Skill location | Listed in the worker's prompt? |
  | --- | --- |
  | The repository's implicit `.agents/skills/<n>` | Yes |
  | The repository's explicit-only `.agents/skills/<n>` | No |
  | `$CODEX_HOME/skills/<n>` | Yes |
  | The operator's `$HOME/.agents/skills/<n>` | No, because `HOME` was redirected |

- So the answers are these:
  - (i) INFERRED from the fixture: a repository `.agents/skills` folder **would** be scanned by every dispatched
    Codex worker on that repository. Marked explicit-only, its macros would stay out of the catalog but could still
    be invoked by any `$tddr`-style token that reaches a worker prompt, for example from task text.
  - (ii) The clean way for `codexExecArgs` to exclude one is a `-c 'skills.config=[{name=…,enabled=false},…]'`
    entry per macro, generated from `settings/macros.yaml`. `skills.include_instructions=false` also works, but it
    removes every skill, including the bundled ones, which changes worker behaviour beyond this task.
  - (iii) A `$CODEX_HOME/skills` install would reach every worker, so it is never an operator-only target.
- Not in scope, but found along the way:
  - OBSERVED (fixture): bundled system skills such as `skill-installer` appear in the catalog under an empty config.
  - INFERRED: today's Codex workers carry that bundled catalog too.

## Recommendation

Build **option (b)**: a user-level install to the operator's `$HOME/.agents/skills` only, with no repository folder.

- (a) A repository mirror under `.agents/skills` would land in every Codex worker's worktree (OBSERVED fixture). It
  would then need a new per-macro `skills.config` disable in `codexExecArgs`, a worker-path change at `risk: high`,
  just to cancel what it added. Leaving that disable out leaves the `$name` route open.
- (c) A symlink from `.claude/skills` would be worse. It is still a repository path, and Codex ignores
  `disable-model-invocation`, so all eleven macros would be listed **implicitly** in every worker's context (OBSERVED
  fixture with `tddr`). The Claude SKILL.md also has no `agents/openai.yaml`.
- (b) Option (b) reaches the operator's Codex sessions in any cwd, and no worker sees it: a worker's `HOME` is
  redirected and `WORKER_HOME_SYMLINKS` grants no `.agents`. It changes no worker code path.
  - Its cost: the macros appear in every repository the operator opens with Codex. They are explicit-only, so they
    cost no context there.
  - Its cost: they must be reinstalled after a macro edit. `--check` covers that.

Files:
- `scripts/generate-macro-skills.mjs`: add a `--codex-home[=<dir>]` target, defaulting to `$HOME/.agents/skills`,
  with these behaviours.
  - It writes `<dir>/<name>/SKILL.md` and `<dir>/<name>/agents/openai.yaml` with
    `policy:\n  allow_implicit_invocation: false`. A new `renderCodexMacroSkill` builds on `renderMacroSkill`.
  - INFERRED: the Codex copy should drop the `$ARGUMENTS` line. All eleven rows set `args: true`, and nothing in the
    0.169.0 skills code read here substitutes it.
  - It refuses a target inside any git worktree, or under `$CODEX_HOME` (OBSERVED: workers scan that root).
  - It supports `--check` against the installed copy.
- `package.json`: add a `macro-skills:codex` script.
- `scripts/prompt-surface-gate.mjs:isOperatorOnlyMacroTable`: also require that every row's Codex render carries
  `allow_implicit_invocation: false`, through the generator's own renderer, as W1-T4332 does for the Claude
  frontmatter. Otherwise a generator change that drops the yaml would make the table a prompt surface again.
- A new test beside `test/a-repo-skill-no-worker-can-reach.test.ts`, named for example
  `no-codex-worker-sees-an-operator-macro.test.ts`, in the `test/<folder>/` that `rmd test-place` computes, using
  `REPO_ROOT` and `#src/*` imports. It refuses a worker-visible macro by asserting four things.
  1. `git ls-files` shows no `.agents/skills/` path, and no `.codex/skills/` path, in the tree.
  2. `WORKER_HOME_SYMLINKS` has no `relPath` under `.agents`.
  3. The installer refuses a `$CODEX_HOME/skills` target and a target inside a worktree.
  4. Every rendered Codex macro is explicit-only.
  Run it with `rmd census-membership`, beside the existing Claude reachability census.

A live falsifier the build could carry: `codex debug prompt-input`, run in a worktree with `HOME` redirected, lists no
macro name. Run with the operator's `HOME`, the macro is still absent from the catalog, but the skill resolves on
`$tddr`.
