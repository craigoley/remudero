# Remudero

**Plan-stewarding orchestration harness for Claude Code and Codex.**

A durable main agent runs a plan → recon → prompt → implement → review → merge →
plan-sync loop against subscription-backed Claude Code or opt-in Codex workers in isolated git worktrees,
escalating to the human like a senior engineer would: rarely, batched, with
options and a recommendation. Provider routing uses only subscriptions with reported reserve headroom;
GitHub-native.

> **`remudero`** — the wrangler in charge of the *remuda*: the hand who manages
> the worker herd and decides which mounts ride today. The orchestrator's own
> job title. CLI alias `rmd`.

---

## ⚠️ Pre-alpha

This project is **pre-alpha and built in the open from day one**. APIs, file
formats, and internals **change without notice**. Issues and Discussions may not
receive responses yet. Do not depend on anything here.

Unattended agents that run `Bash` are a prompt-injection surface (via
dependencies and fetched web content). Workers run under a layered containment
stack — OS sandbox + a deterministic deny-floor hook + worktree scoping — but the
deny-floor is a *tripwire, not a sandbox*. Read the plan before pointing this at
anything you care about.

**No releases while pre-alpha.** There are no semver tags (`git tag` returns
none) and `CHANGELOG.md` is frozen — main is the only moving line, and every
merged commit is current by definition. The deployable unit is an image build
(`.github/workflows/acr-build.yml`), not a version bump: the operator builds the
daemon image and its commit is stamped into `/etc/rmd-build-sha` inside the
container, which `scripts/fleet-heartbeat.sh` publishes as `image_build_sha` so a
fleet host's running code is checkable against `origin/main`. Semver, tags, and a
regenerated changelog return once the project leaves pre-alpha.

## Where this is going

**The harness is the product; GitHub is plumbing.** The loop already runs
unattended — the goal now is that operating it does not mean living on a PR
page. Operator judgement is being moved into the console (verdicts that steer
the fix rung, an inbox that ratifies a proposal *before* anything is written),
with the PR demoted to transport and audit. Some GitHub contact stays
irreducible on purpose: `verify: human` merges, commons and outbound gates,
credential and org acts.

Three rulings are open and are the operator's alone — instance topology, the
naked-zero proposal, and the console's write-tier shape. They are recorded, with
the query to re-check each, in
**[docs/open-decisions.md](./docs/open-decisions.md)**. Sessions cite that page;
they do not settle it.

## What's here today

WS-0 (the one-shot spike proving the primitive loop closed end-to-end,
headless, under OS containment, on subscription OAuth) shipped and closed; the
repo then ran WS-1 through its entire backlog and closed that too
(2026-07-15: the daemon runs itself, unattended, self-hosting its own PRs).
`src/run-task.ts` — the CLI orchestrator (`rmd`) — is not a future promise, it
is real code: run-task/drain/daemon/review/sweep/fix/serve and the rest of the
`rmd` command surface, over a hundred modules under `src/lib/`. See:

- **[MASTER-PLAN.md](./MASTER-PLAN.md)** — the full design; this document is the product.
- **[docs/architecture.md](./docs/architecture.md)** — the conceptual map: the three planes, and which of them a merge reaches before a restart.
- **[docs/operator-guide.md](./docs/operator-guide.md)** — the day-to-day view: what to type, what to watch.
- **[docs/open-decisions.md](./docs/open-decisions.md)** — the rulings that are open, and how to check whether they still are.
- **[FINDINGS.md](./FINDINGS.md)** — the WS-0 spike's per-verdict proofs, a dated snapshot (its
  version table is from the spike; the pins that matter today are `package.json`, `.nvmrc` and
  `deploy/Dockerfile`'s `ARG`s).
- **[docs/audits/](./docs/audits/README.md)** — dated production-readiness reviews, kept
  byte-identical as fixtures for the audit rung.
- **[DECISIONS.md](./DECISIONS.md)** — auto-choose decision log (append-only).
- `src/run-task.ts` — the orchestrator; `bin/rmd` is a thin `exec` wrapper into it.
- `src/lib/` — the reusable primitives (`config`, `env`, `worker`, …) `run-task.ts` is built on.
- `src/spike.ts` — the original WS-0 spike script, kept for the record (`npm run spike`).
- `settings/worker.json` + `hooks/deny-floor.sh` — the worker containment policy.

## Requirements

- **Node 22.22.3, exactly** — `.nvmrc` and `package.json#engines` pin it, `deploy/Dockerfile`
  builds from it, and the coverage tooling (`assertPinnedNodeVersion`,
  `scripts/coverage-merge-ratchet.mjs`) refuses any other version. `npm ci` only *warns* on a
  mismatch, so check `node --version` first.
- **`git`** and the **`gh`** CLI, already authenticated with a token scoped to the target
  repository (Standing rule 6: workers carry scoped tokens only).
- **The `claude` CLI**, signed in via subscription OAuth, never via `ANTHROPIC_API_KEY` — see the
  billing boundary in
  [docs/operator-guide.md](./docs/operator-guide.md#first-run-setup-on-a-new-machine). Codex is an
  optional second provider; the same section covers it.

## Install

```sh
git clone https://github.com/craigoley/remudero.git
cd remudero
npm ci
./bin/rmd --help
```

`bin/rmd` is a thin `exec` into `tsx src/run-task.ts`; `npm link` puts `rmd` on `PATH`. There is no
build step to run first — the CLI runs from source. Runtime configuration lives in
`~/.config/remudero/config.json` (`src/lib/config.ts` documents every field and its default).

## Quick start

```sh
rmd doctor                 # read-only health check: toolchain, auth, checkout state (exit 0/1/2)
rmd init                   # first-run wizard: subscription tier -> mount policy (headless-safe)
rmd status                 # "is it running, and why is it stalled" from one read model
rmd serve                  # the operator console on 127.0.0.1; `rmd console-url` prints the URL
rmd run-task <task-id>     # dispatch ONE task end to end: recon -> implement -> PR -> review -> merge
rmd daemon --repo <name>   # the persistent, self-pacing loop over the same machinery
```

Before your first push, run the shipped local gate, `rmd preflight --ci-parity` — it shells CI's
own commands, one per `ci.yml` job, including the full test suite. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the merge gate and the acceptance-criteria contract every
PR body must carry, and `rmd --help` (or `docs/cli-reference.md`, generated from the same
registry) for the full command list.

## Documentation map

[docs/README.md](./docs/README.md) lists every document, says which are hand-written, generated,
or parsed by a gate, and where to start for a given question.

## License

[Apache-2.0](./LICENSE) © Remudero contributors.
