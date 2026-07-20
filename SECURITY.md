# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Report it
privately through [GitHub Security Advisories](https://github.com/craigoley/remudero/security/advisories/new)
("Report a vulnerability" on this repo's Security tab) — private vulnerability
reporting is enabled on this repository.

If you can't use GitHub Security Advisories, email **craigoley@gmail.com**
with a description of the issue, steps to reproduce, and its potential
impact.

You should expect an acknowledgment within a few days. This project is
pre-alpha and maintained part-time — there is no formal SLA, but security
reports get priority over everything else in the queue.

## Scope

Remudero orchestrates headless Claude Code workers that run `Bash` against
real repositories. In-scope issues include (non-exhaustively):

- Containment/sandbox bypass (the OS sandbox, the deny-floor hook, or
  worktree scoping in `settings/worker.json` / `hooks/deny-floor.sh`)
- Credential or token leakage (PATs, OAuth material, secrets in logs or
  committed output)
- Prompt-injection paths that escalate beyond the documented containment
  stack (see the Pre-alpha section of [README.md](./README.md))
- Supply-chain issues in this repo's own CI (unpinned actions, workflow
  permission over-grants)

## Supported versions

Pre-alpha, pre-1.0, single rolling branch (`main`): only the latest commit on
`main` is supported. There are no maintained release branches yet.
