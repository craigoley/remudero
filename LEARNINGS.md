# LEARNINGS — durable, provenance-tagged ground truth

The knowledge pipeline (WS-8) starts here, now. Every line is one fact the fleet
paid to discover, tagged with the run/PR that proved it. Rules:

- **One fact per line. Each cites its source.** No fact without provenance.
- These are *installed-version / empirical* truths — the kind a prompt is wrong
  about (Standing rule 7: distrust the prompt over the installed version). When
  one is contradicted by a later probe, append the correction with its own
  provenance; never silently edit history.
- Promptsmith injects the matching entries into a rendered prompt as cited
  CONTEXT (W1-T19), so a worker inherits what we already learned.

## Isolation & containment

- Claude Code's Bash-tool snapshot sources `$HOME/.zshrc` via `os.homedir()`; `ZDOTDIR` is IGNORED — worker shell isolation must set `CLAUDE_CODE_SHELL` (the rc filename follows the shell), not ZDOTDIR. [PR #8]
- The current `CLAUDE_CODE_SHELL=/bin/bash` isolation works only because `~/.bashrc` is ABSENT on this machine — an accident of this host, not construction; a populated `~/.bashrc` would silently isolate nothing. [PR #8 → W1-T17/T18]
- Worker settings that fail schema validation are SILENTLY IGNORED under `claude -p` — a typo drops containment without erroring, so containment must be validated before spawn AND probed after. [WS-0]
- The SDK's `SandboxSettingsSchema` is `$loose` and silently strips unknown keys; validating against it alone PASSES a misplaced key (e.g. `allowedDomains` at the sandbox root) — validate shape explicitly, don't trust the schema to reject. [PR #6 / W1-T1]

## Ledger, budget & the SDK envelope

- The Agent SDK yields the `type:"result"` envelope (`num_turns`, `total_cost_usd`, `subtype`) and THEN throws from the iterator on an error subtype — read the envelope before the catch, or a failed run looks free. [PR #8]
- `maxBudgetUsd` is checked BETWEEN turns: a $0.01 budget produced $0.21 of real spend. It is a circuit breaker with up to one turn of overshoot, NOT a hard cap — set budgets with headroom. [PR #8]
