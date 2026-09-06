# env.ts forensics

The measured forensics, incident narratives and design arguments removed from `src/lib/env.ts`
when its comments were compacted to the plain-language standard. Every block below is the removed
text verbatim, marker characters stripped and nothing else changed. Headings name the symbol the
text explained; the code keeps a one-line `// Why:` pointer where the history mattered. Base
revision: origin/main at 7ce3b525569bd7cfa98f5f858874e8667274d1dc; the line numbers below are that
revision's.

## Module header

### Base lines 1-30 — THE BILLING BOUNDARY (FIELD FINDING…

THE BILLING BOUNDARY (FIELD FINDING 1, MASTER-PLAN §9).

Worker environments are CONSTRUCTED, never inherited. `ANTHROPIC_API_KEY` is
exported from this operator's login shell and TAKES PRECEDENCE over the
claude.ai OAuth login — any child that inherits it silently bills API rates
instead of the Max subscription. By building each child env from an explicit
allowlist and asserting no `ANTHROPIC_*` key survives, Claude Code falls back
to subscription OAuth. `billing_mode` becomes a decision the harness makes and
records, never an accident it inherits.

launchd happens to be clean (it never sources `.zshrc`), but a daemon started
from a dev shell inherits the key — this function is what makes BOTH paths
safe by DEFAULT (absent key ⇒ subscription, exactly as before).

THE OVERFLOW VALVE (opt-in, W1-T258). Engaging it is TWO-FACTOR, so the key
merely being present in a shell can never silently bill the fleet to API:
  1. INTENT — `config.overflow: "api_key"` (config.ts §9), which `validateConfig`
     refuses unless it is paired with a `dailyCapUsd` (no uncapped api run can
     even be configured). The caller passes this through as `opts.allowApiKey`.
  2. KEY — `ANTHROPIC_API_KEY` present in the parent env.
With BOTH, that one key — and only that one — is passed BY VALUE into each
worker's env so the run bills to API credits instead of an exhausted
subscription window. It travels env→env only: never written to a file, never
logged as a value (only its NAME appears in `childEnvKeys`). Absent EITHER
factor ⇒ subscription, exactly as before. Every OTHER `ANTHROPIC_*` key
(BASE_URL/MODEL/AUTH_TOKEN/…) still fails loud below — those redirect billing
or behaviour and are contamination, not a valve. `billing_mode` is then
DERIVED from the child's actual key set ({@link billingMode}), never guessed.

## ALLOWLIST

### Base lines 34-42 — Base variables a worker legitimately…

Base variables a worker legitimately needs, copied from the parent by name.

`USER` is load-bearing on macOS: the subscription OAuth token is stored in the
login Keychain (not a file), and the CLI resolves the keychain identity from
`USER`. With PATH/HOME/TMPDIR/LANG but no USER, a headless run returns
"Not logged in · Please run /login" (verified: SDK 0.3.209 / CLI 2.1.209).
`LOGNAME` alone is NOT sufficient. None of these carry secrets.

### Base lines 43-88 — `CLAUDE_CODE_OAUTH_TOKEN` (impl-ED) is AMBIENT…

`CLAUDE_CODE_OAUTH_TOKEN` (impl-ED) is AMBIENT CONTAINER IDENTITY, the same class as the five
above, and it is the ONLY credential a container can hold: `claude setup-token` writes nothing to
disk — it prints a year-long string to the terminal and the vendor documentation says to set it as
this variable wherever you want to authenticate. Before this line the codebase had no awareness of
it at all and a token-authenticated worker was impossible.

WHY THE ALLOWLIST AND NOT AN OPT-IN, since `ANTHROPIC_API_KEY` sets the opposite precedent. That
key is opt-in (`opts.allowApiKey`) because it FLIPS BILLING MODE: {@link billingMode} returns
`"api"` when and only when it survives. This token does not — it authenticates the same
subscription the `/login` credential does, so `billingMode` still reads `"subscription"` and the
reason the valve is gated does not apply here. It also does not match {@link ANTHROPIC_KEY}
(verified, not assumed), so the leak assertion below is unweakened.

AND THE FAILURE DIRECTIONS ARE NOT SYMMETRIC. Threading it through `extra` would need every one of
the three spawn paths to opt in; a missed one yields a silently UNAUTHENTICATED worker, which is
the failure this fleet is worst at seeing. On the allowlist it cannot be missed.
`GH_TOKEN` is PARITY RESTORATION, not a widening — and that distinction is the whole
justification, so it is worth stating precisely.

THE WORKER IS DESIGNED TO PUSH AND OPEN ITS OWN PR. Three independent places say so: the
implement prompt instructs it to `git push origin HEAD` and `gh pr create --fill --base main`;
`settings/worker.json` carries `excludedCommands: ["gh *"]`, an exclusion that exists ONLY so a
worker's `gh` runs outside Seatbelt (it fails TLS verification under it); and the orchestrator's
own push is commented as "the ONE orchestrator-initiated push in this file (the worker itself
normally pushes from inside its own sandbox)" — a FALLBACK, not the route.

AND THE WORKER ALREADY HOLDS THIS CREDENTIAL ON MACOS. `WORKER_HOME_SYMLINKS` (worker-home.ts)
grants `.config/gh` into every per-run worker HOME, with the reason recorded verbatim as "gh CLI
auth token, so a worker can open/merge PRs". A container simply stores the same secret in a
VARIABLE instead of a FILE — and the isolation boundary treats those two forms oppositely: the
file is symlinked in, the variable is stripped out. Measured with a fake token, `GH_TOKEN`
reaches the child env as `false`. So the container worker is the ONLY configuration in which the
fleet's own stated intent does not hold.

WHY THE ALLOWLIST AND NOT THREADING, the same argument `CLAUDE_CODE_OAUTH_TOKEN` records
directly above: threading needs all three spawn paths to opt in, and a missed one yields a
silently UNAUTHENTICATED worker — the failure this fleet is worst at seeing. Here that failure
is not hypothetical, it is the observed one: the container's workers fail their push, the
orchestrator's fallback quietly recovers it, and the only trace is a `fallback:` line.

IT DOES NOT WEAKEN THE BILLING BOUNDARY. `GH_TOKEN` does not match {@link ANTHROPIC_KEY}
(VERIFIED by running the pattern, not by reading it), so the leak assertion below is unchanged,
and {@link billingMode} keys off `SANCTIONED_KEY` alone so a GitHub token cannot flip a run to
`api`. `GITHUB_TOKEN` is deliberately NOT added: `gh` prefers `GH_TOKEN`, and the container's git
credential helper expands `$GH_TOKEN` specifically, so a second name would be scope creep on a
credential surface for no reachable caller.

## buildWorkerEnv

### Base lines 98-124 — Build a child environment from…

Build a child environment from an explicit allowlist plus caller-supplied
vars. Never inherits `process.env` wholesale. Throws if any `ANTHROPIC_*`
key OTHER than the sanctioned `ANTHROPIC_API_KEY` overflow valve survives
(including one a caller passed in), so a leak fails loud at the boundary
rather than silently on the invoice. The valve itself is opt-in: the parent's
`ANTHROPIC_API_KEY` is copied through ONLY when present (see file header).

Shell isolation is the SAME contamination class as the ANTHROPIC_* denial,
mirrored: where ANTHROPIC_* is DENIED, the vars below are GRANTED, so a
worker's shell sources Remudero's own (empty) rc, never the operator's.
Workers inherit NOTHING they aren't explicitly given; none of these is
copied from the parent (an operator HOME/ZDOTDIR/CLAUDE_CODE_SHELL is
ignored), only set to the granted value.
 - `opts.home` → **HOME** (W1-T18 general isolation mechanism). When set,
   OVERRIDES whatever the allowlist copied from the parent's real HOME with
   a Remudero-controlled scratch dir (`worker-home.ts`) holding only empty
   rc files — this is what makes isolation hold on ANY host, not just one
   whose `~/.bashrc` happens to be absent. See config.workerHomeDir.
 - `opts.shell` → **CLAUDE_CODE_SHELL** (default `/bin/bash`). Claude Code's
   Bash-tool snapshot sources `os.homedir()/.<shell>rc`, resolved off HOME —
   combined with `opts.home` above, that path is the redirected scratch
   HOME's empty rc, never the operator's `~/.zshrc` (and its interactive
   `compinit` prompt that stalled W1-T1C). See config.workerShell.
 - `opts.zdotdir` → **ZDOTDIR** (default derived from HOME). Defense-in-depth
   for any direct `zsh` a worker spawns. See config.workerZdotdir.

## DISABLE_AUTOUPDATER

### Base lines 166-177 — Grant DISABLE_AUTOUPDATER=1 (unless the caller…

Grant DISABLE_AUTOUPDATER=1 (unless the caller set one via `extra`) — W1-T236:
the shared `claude` binary a worker execs is a symlink into an
auto-updating install (npm-global or the native installer), and its
content can be rewritten mid-run out from under the resolved path — a
same-day 2.1.216→2.1.217 bump was observed rewriting it 2026-07-21
mid-incident. Unlike every OTHER grant above, this is not copied from the
parent (autoupdates are not something a worker's env legitimately carries
in) — it is an explicit ADD, the same discipline the ALLOWLIST enforces
for copies: nothing reaches `child` that is not named. This makes it
impossible for a running worker to trigger or race an update of the
binary it and every sibling worker are executing; the operator can still
update the CLI deliberately outside a run.

## BootAssertion

### Base lines 228-247 — True iff the DAEMON'S OWN…

True iff the DAEMON'S OWN process env (not a worker's — see below) is ANTHROPIC_*-free.

`api` iff the daemon booted with the sanctioned `ANTHROPIC_API_KEY` valve engaged
(overnight-on-credits, W1-T258), else `subscription` — the default this repo expects.

Absolute path of the node runtime executing THIS process (`process.execPath`) —
W1-T991: the reading that answers "which node does the fleet execute" without
reading a live process listing. Always present (unlike `node_drift` below), so the
ledger records the running interpreter on every boot, drifting or not.

Named drift reason — present ONLY when `node_path` falls outside the daemon
account's own roots (its HOME plus the system/homebrew prefixes), or `node_version`
disagrees with the repo's declared `.nvmrc` pin. Advisory: its presence never blocks
boot (W1-T991 design part 2 — same ruling as {@link checkBinaryPin}'s drift).

## assertCleanBoot

### Base lines 249-262 — The daemon's boot-time billing assertion…

The daemon's boot-time billing assertion (W1-T12b). This checks the DAEMON
PROCESS'S OWN env — what launchd (or a dev shell) handed it at exec — which
is a DIFFERENT env from a worker's: every worker's env is already built fresh
from `buildWorkerEnv`'s allowlist above and can never inherit an ANTHROPIC_*
key regardless of what the daemon process itself carries. So `env_clean:
false` here does not mean a leak reached a worker — it means the daemon was
booted from a contaminated shell rather than launchd's clean one (launchd
never sources `.zshrc` — see file header), which is a canary worth logging
loudly, not a hard gate: {@link isBillingClean} does the read, this just
shapes it into the ledger fields `daemon.boot` (wired in lib/daemon.ts)
records: `env_clean=true / billing_mode=subscription` on the clean path this
repo always expects in production.

## Node runtime provenance section

### Base lines 293-302 — THE SIBLING READING assertCleanBoot's own…

── Node runtime provenance (W1-T991) ───────────────────────────────────────

THE SIBLING READING assertCleanBoot's own doc names above: env_clean catches a daemon
booted from a contaminated SHELL; this catches a daemon EXECUTING a foreign RUNTIME —
same canary, same advisory posture, over process.execPath/version instead of
ANTHROPIC_* keys. bin/rmd's last line execs node_modules/.bin/tsx, a shebang script, so
the daemon's own node is whatever PATH resolved at exec time, never a path anyone
chose; nothing before this read it, pinned it, or recorded it (see the task's rationale
— a live worker was observed running a DIFFERENT account's nvm-installed node, invisible
until that install is eventually pruned or upgraded out from under every spawn at once).

## SYSTEM_NODE_ROOTS

### Base lines 304-311 — System/package-manager roots node commonly…

System/package-manager roots node commonly installs under, independent of any ONE
user's home — combined with the daemon's OWN homedir (`env.HOME`) below to decide
whether a resolved runtime is inside "this account's own roots". Never a single
hardcoded host path: the container lane runs as a different user under a different
prefix entirely (`deploy/`), so a check keyed to one literal `/Users/...` path would
fire on every non-macOS boot and get muted, then ignored (design part 3).

## Binary content pin section

### Base lines 361-374 — DISABLE_AUTOUPDATER above stops a WORKER…

── Binary content pin (W1-T236) ────────────────────────────────────────

DISABLE_AUTOUPDATER above stops a WORKER from triggering or racing an
update while it runs. It does not, by itself, make a swap the OPERATOR
caused between runs visible: `config.claudeBin` (config.ts's
`resolveClaudeBin`) records a path once, and a path is not content — the
same path can resolve to a rewritten binary after a deliberate `npm i -g`
or an autoupdate that landed between runs. `checkBinaryPin` is the smaller
of the two content-pin designs (MASTER-PLAN's harness-owned-copy is the
stronger, deferred guarantee): compare the version recorded at config time
against the version observed at THIS preflight (`claude --version`, e.g.
via `resolveClaudeExecutable`'s caller). A caller wires this at the actual
preflight call site; this module only supplies the pure comparison so it is
unit-testable without a real binary.

## checkBinaryPin

### Base lines 388-399 — Compare the `claude` binary version…

Compare the `claude` binary version recorded at config time against the
version observed at preflight (W1-T236). A MATCH returns `{drift: false}`
with no `reason` — the common case passes silently, exactly as before this
pin existed (acceptance: "a matching binary passes preflight silently").
A MISMATCH — the shared binary's content changed underneath the recorded
path (a deliberate operator update, or an autoupdate race) — returns
`{drift: true, reason}` naming both versions, so a caller can LEDGER the
drift and CONTINUE rather than hard-fail: the operator still updates the
CLI deliberately, so this makes a swap VISIBLE and INTENTIONAL, never
impossible (acceptance: "ledgered with a named drift reason").

## DECLARED_CLI_PIN_ARG section

### Base lines 412-434 — WHY THIS EXISTS: {@link checkBinaryPin} shipped…

── The DECLARED pin, and the reading that finally consumes checkBinaryPin ──

WHY THIS EXISTS: {@link checkBinaryPin} shipped with NO PRODUCTION CALLER (src/lib/reachability.ts
lists it by name among the zero-consumer organs), and the reason is not that someone forgot the
call — it is that its `recordedVersion` argument HAD NO PRODUCER ANYWHERE IN THE TREE. `Config`
carries `claudeBin`, a PATH, and no version; `resolveClaudeExecutable` runs `--version` with
`stdio: "ignore"` and discards the output. Wiring it therefore required deciding what "recorded"
means, which is the whole of the design below.

THE SOURCE OF TRUTH IS THE ONE DECLARATION THIS REPO ALREADY MAKES: `ARG CLAUDE_CODE_VERSION` in
deploy/Dockerfile. Two reasons, and the second is why nothing else was chosen:
  1. It is the version this repo SAYS its workers run — the Dockerfile argues it at length (the
     `stable` dist-tag, and lockstep with the `@anthropic-ai/claude-agent-sdk` version in
     package-lock.json). A host that disagrees with it is exactly the condition worth reporting.
  2. deploy/verify-image.sh reads THE SAME LINE. One declaration, two consumers, no second copy
     to drift — and no inference. Deriving the expected CLI from the SDK version instead would
     have meant trusting the 2.1.N-alongside-0.3.N convention, which upstream documents but does
     not guarantee; that would put an unenforced assumption inside a gate.

THREE STATES, NEVER TWO. `unknown` is not padding: this fleet's standing law is that a READ
FAILURE DEGRADES TO UNKNOWN, NEVER TO A NUMBER — and the recon that produced this task found that
law broken three times in one function elsewhere (deployer.ts's `probeIdle`). An unreadable
Dockerfile or a `claude --version` that will not run must not be able to render as `match`.
