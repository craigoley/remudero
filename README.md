# Remudero

**Plan-stewarding orchestration harness for Claude Code.**

A durable main agent runs a plan → recon → prompt → implement → review → merge →
plan-sync loop against headless Claude Code workers in isolated git worktrees,
escalating to the human like a senior engineer would: rarely, batched, with
options and a recommendation. Open source; runs on a Claude Code subscription;
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

## What's here today

WS-0 (the one-shot spike proving the primitive loop closed end-to-end,
headless, under OS containment, on subscription OAuth) shipped and closed; the
repo then ran WS-1 through its entire backlog and closed that too
(2026-07-15: the daemon runs itself, unattended, self-hosting its own PRs).
`src/run-task.ts` — the CLI orchestrator (`rmd`) — is not a future promise, it
is real code: run-task/drain/daemon/review/sweep/fix/serve and the rest of the
`rmd` command surface, over six thousand lines. See:

- **[MASTER-PLAN.md](./MASTER-PLAN.md)** — the full design; this document is the product.
- **[docs/operator-guide.md](./docs/operator-guide.md)** — the day-to-day view: what to type, what to watch.
- **[FINDINGS.md](./FINDINGS.md)** — the WS-0 spike's per-verdict proofs and installed-version ground truth.
- **[DECISIONS.md](./DECISIONS.md)** — auto-choose decision log (append-only).
- `src/run-task.ts` — the orchestrator; `bin/rmd` is a thin `exec` wrapper into it.
- `src/lib/` — the reusable primitives (`config`, `env`, `worker`, …) `run-task.ts` is built on.
- `src/spike.ts` — the original WS-0 spike script, kept for the record (`npm run spike`).
- `settings/worker.json` + `hooks/deny-floor.sh` — the worker containment policy.

Run the unit tests with `npm test`. Run the CLI itself with `rmd --help` (or
`bin/rmd --help` from a checkout) for the full, generated command list — see
`docs/cli-reference.md`.

## License

[Apache-2.0](./LICENSE) © Remudero contributors.
