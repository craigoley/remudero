# A home repository for each fleet

Recon for W1-T13727. Read 2026-11-19 against core `origin/main` eb79fd765 and the Console checkout. Each claim is
labelled OBSERVED (read in source or at the cited page) or INFERRED (my judgement).

## The pattern

Source: Matt Pocock, "The Home Repo Pattern", aihero.dev/the-home-repo-pattern, updated 2026-11-12, read 2026-11-19.

- OBSERVED: one git repository holds your skills, `AGENTS.md` and shared docs, plus one pointer line per working
  repository. You run your agent from it. The pointer line reads `<name> (<what it is>): <local path>. Clone from
  <remote> if missing.`, and can add a hint such as "read its AGENTS.md first".
- OBSERVED: code stays in each repository. Submodules are allowed but not needed; plain pointers do the same job.
- OBSERVED: it fits a mix of public and private repositories, or a team that will not adopt a monorepo.
- OBSERVED: scale. About 20 repositories works fine. Past that, group pointers into one file per area. At about 400,
  one pointer each is too many choices, so use progressive disclosure. At thousands, a skills marketplace fits better.
- OBSERVED: for a team, the home repository is the thing you share; everyone runs their agent in it.
- OBSERVED: secrets. The setup prompt tells the agent to leave `.env` and other secret files unread.
- INFERRED, what an operator gains: a session started anywhere in the fleet sees every repository's rules, tools and
  location from one place, and a new teammate gets the whole fleet by cloning one repository.

This project adopted the pattern on 2026-11-18 by making its existing private overlay repository the home: a
worker-safe instruction file of pointers, plus an operator-only doc it links to (OBSERVED, from the task brief).

## How Remudero onboards a repository today

Core (all OBSERVED):

- `src/lib/managed-repos.ts` `loadManagedRepos`: `.remudero/managed-repos.json`, a git-tracked list of `owner/repo`
  strings the harness polls for issues. Empty means nothing is managed.
- `src/lib/instance-registry.ts` `parseInstanceRegistry` / `projectRegistry`: the repo-tracked
  `daemon-instances.yaml`, read as Account, Project, Repository, Instance. Its header says it replaced four
  disagreeing lists. It names daemons and their `github_repo`; it carries no instructions or skills.
- `src/lib/project-init.ts` `buildProjectInit` and `src/lib/project-init-write.ts` `writeProjectInit`:
  `rmd project init <repo> [--write <dir>]` generates the gate stack (workflows, ratchets, branch protection payload)
  for ONE target repository, and refuses to overwrite existing files.
- `src/lib/onboard/{inventory,recon,session,synthesize}.ts`: the four-phase `rmd onboard <dir>` against a local
  clone. `synthesize.ts` seeds plan and learnings files (`seedProjectLearningsHomeFiles` in `src/lib/learnings.ts`)
  inside the target repository.
- `src/lib/onboarding-readiness.ts` `readOnboardingReadinessSnapshot`: eight readiness checks over the GitHub App API,
  one of which is whether the repository has agent instructions (`AGENTS.md` / `CLAUDE.md`).
- `src/lib/onboarding-repository-inventory.ts` `readOnboardingRepositoryInventory`: candidate repositories the
  token can see.
- `src/lib/onboarding-golive.ts`: go-live promotes a repository through a reviewed registry PR into a configured
  `RegistryWriteTarget { repository, filePath }`. So go-live already writes into a named repository other than the
  one being onboarded.
- `src/lib/product-repository.ts` `ghProductRepositoryProvider` `create`: "Start new" creates an empty GitHub
  repository (user or org scope, public or private); "adopt" connects an existing one.
- Name collision: `src/lib/feedback.ts` `loadHomeRepoPointer` already reads `.remudero/home-repo.json`, which means
  "the repository `rmd feedback` files upstream defects to" (W1-T397). It is not this pattern.

Console (symbol names only, OBSERVED):

- `app/repos/_components/RepositorySetups.tsx` `AddRepositoryActions`: "Connect existing" links to `/onboard`,
  "Start new" links to `/products`.
- `app/onboard/onboarding-client.tsx` `OnboardingClient`, steps from `onboardingSteps`: Verify Fleet GitHub App,
  Select repositories, Choose task types, Choose proof policy, Test run, Go live.
- `app/products/products-client.tsx` `ProductsClient` with `lib/product-schema.ts` `ProductRepositoryActionDraft`
  (`create` or `adopt`) and `lib/rmd-control.ts` `submitProductRepositoryAction`.

Gap (OBSERVED): every step works on one repository at a time. Nothing creates or updates a fleet-level place that
points at all of a customer's repositories, or holds their shared skills and steering.

## What it holds

Holds (INFERRED unless marked):

- One pointer line per managed repository in the pattern's format, generated from the instance registry projection
  (`projectRegistry`), with "read its own instruction file first". Grouped by Project once past about 20 lines.
- A short worker-safe instruction file (`CLAUDE.md` / `AGENTS.md`): what the fleet is, where things live (plans,
  Console, ledger is on the host and never in git), and a first line telling dispatched workers to touch only their
  task's `files:` and skip the operator section.
- An operator-only doc the instruction file links to: standing rulings, operator macros and skills, the route to the
  host. Named so no worker loads it automatically.
- Shared skills and steering files the customer wants in every operator session (for example Console copy rules,
  review rubrics).
- Shared docs that span repositories (architecture across services, glossary).
- Optionally the instance registry file itself and private plan records, when the customer has no other private
  place for them. This project's home holds both (OBSERVED, its instruction file).

Stays out:

- Secrets: tokens, App keys, `.env` files. They stay in the host's secret store and the provider's settings. The
  pattern itself says leave them unread (OBSERVED).
- Ledger and fleet state. The ledger lives on the host, never in git (OBSERVED, this project's rule).
- Code. It stays in each repository (OBSERVED, the pattern).
- Each repository's own rules. The home points to them; it never copies them, or they drift.
- Private plan records when they already have their own private repository. Pointing is enough.

How it differs from the instance registry (INFERRED from OBSERVED shapes): the registry
(`src/lib/instance-registry.ts`) is machine data for daemons: which instance runs which repository. The home repository
is reading material for agents and people: where each repository is, how to work in it, and what is shared. The
pointer list should be generated from the registry, never hand-kept beside it, or the fleet gets a fifth disagreeing
list, the problem the registry was built to end.

The worker-reach trap (OBSERVED): `src/lib/worker-provider.ts` `CODEX_DOCTRINE_PRELUDE` tells every Codex worker to read
`CLAUDE.md` first, and the Codex launch sets `project_doc_fallback_filenames` to `AGENTS.md` and `CLAUDE.md`. Claude
workers start with `settingSources: []` and load neither. So if a fleet's home repository is also a managed repository
(it will be when it holds plan records that tasks change), its instruction file reaches Codex workers dispatched into
it. INFERRED consequence: the generated instruction file must be safe for a worker to obey. Operator powers, host
routes and macros belong in the linked operator doc, never in the auto-loaded file.

## Recommendation

BUILD, small and staged (INFERRED).

Why: Remudero is meant for businesses running many repositories, often a public and private mix. That is the
pattern's stated fit. Today each onboarding step is per repository, so a customer's operator session started in any
one repository is blind to the rest. The project already runs this way and found it worth adopting. The cost is low:
the pointer list can be generated from data Remudero already holds, and go-live already writes a reviewed PR into a
named repository.

Onboarding steps it changes:

1. "Verify Fleet GitHub App" (first step of `onboardingSteps`): once per fleet, create the private home repository or
   adopt an existing one, with the same `create` / `adopt` provider used by "Start new"
   (`ghProductRepositoryProvider`).
2. "Go live" (`src/lib/onboarding-golive.ts`): the reviewed registry PR also adds the repository's pointer line to the
   home repository. The registry `RegistryWriteTarget` can default to the home repository.

Guards: private visibility only; no secrets written; a worker-safe instruction file with the operator doc separate;
generated pointers grouped by Project past about 20; pick a new config name, since `.remudero/home-repo.json` already
means the feedback upstream target.

Minimal first build task (core only, no Console wiring yet): a pure generator plus a write step, mirroring
`project-init.ts` / `project-init-write.ts`.

- `src/lib/fleet-home.ts`: `buildFleetHome(registry)` returns the instruction file and pointer files from
  `projectRegistry`; `writeFleetHome(payload, dir)` creates files and refuses any that exist.
- `src/cli/commands/fleet-home.ts`: `rmd fleet-home init --write <dir>`.
- A test in the folder `rmd test-place` computes, proving: one pointer per registry repository, grouping past 20, the
  worker-safe first line present, and no file named like a secret written.

Park the Console wizard change until that generator has been used on one more fleet than this project's own.
