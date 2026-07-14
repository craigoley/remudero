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

This repo currently contains the **WS-0 spike**: a one-shot proof that the
primitive loop closes end-to-end against a sandbox repo — fully headless, under
OS containment, on subscription OAuth. See:

- **[MASTER-PLAN.md](./MASTER-PLAN.md)** — the full design; this document is the product.
- **[FINDINGS.md](./FINDINGS.md)** — the spike's per-verdict proofs and installed-version ground truth.
- **[DECISIONS.md](./DECISIONS.md)** — auto-choose decision log (append-only).
- `src/lib/` — the reusable primitives (`config`, `env`, `worker`) that become
  `run-task.ts` in WS-1.
- `settings/worker.json` + `hooks/deny-floor.sh` — the worker containment policy.

Run the primitives' unit tests with `npm test`. The spike itself
(`npm run spike`) requires a configured instance (see `MASTER-PLAN.md`).

## License

[Apache-2.0](./LICENSE) © Remudero contributors.
