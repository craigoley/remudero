# config.ts forensics

The measured forensics, incident narratives and design arguments removed from `src/lib/config.ts`
when its comments were compacted to the plain-language standard (docs/comment-standard.md). Every
block below is the removed text verbatim, marker characters stripped and nothing else changed.
Headings name the symbol or field the text explained; the code keeps a one-line `// Why:` pointer
where the history mattered. Base revision: origin/main at
49e429e305c662712b2ee5d653613357a2e03c40; the line numbers below are that revision's.

## installRoot

Base lines 22-35.

```
The daemon's OWN git checkout — the one tree the deploy supervisor is allowed to
fast-forward (W1-T924, fb-1784913390318-1fcb63). Optional; defaults to
`join(config.root, "daemon-install")` (see {@link resolveInstallRoot},
lib/install-root.ts) — derived from `config.root`, NEVER a hardcoded absolute path
(public-repo hygiene, same precedent as {@link workerZdotdir}/{@link workerHomeDir}).

WHY THIS EXISTS: before this field, the deploy supervisor's `deployRunCommand` passed
`installPath: repoRoot` — the toplevel of WHATEVER CHECKOUT invoked the CLI, which on the
mini is the operator's own WIP tree. `lib/install-root.ts` owns resolving this field,
deciding whether the resulting tree is fit to deploy into, and provisioning it
(`rmd install-checkout`); this field is only ever the NOUN it resolves against — it carries
no behavior itself.
```

## accessTeamDomain

Base lines 65-75.

```
W1-T996 — the operator's Cloudflare Access team domain, e.g.
`https://example.cloudflareaccess.com` (no trailing slash). PER-INSTALL, never a plan
constant: the same class `.remudero/mounts.yaml`'s own header sends to `rmd init` config
rather than the plan.

⚠ BOTH THIS AND {@link Config.accessAudience} MUST BE PRESENT OR THE ACCESS PROVIDER IS NOT
COMPOSED AT ALL. Composing it with an empty audience would verify nothing and grant on any
assertion — a worse outcome than not wiring it, which is why absence is a hard skip rather
than a default.
```

## serve

Base lines 116-150.

```
Where the operator console BINDS (W1-T152) — the declared, per-install source for
`rmd serve`'s listen address and port, so the launchd unit (`rmd serve-plist`) and a
hand-run `rmd serve` resolve the SAME interfaces without the operator retyping flags.

`host` is the comma-separated interface list `resolveServeHosts` accepts (e.g.
`"127.0.0.1,100.90.47.107"` — loopback for local curls AND the tailnet address for the
phone); a wildcard is refused there, as always. It lives HERE, outside the git tree,
because a tailnet address is machine-specific and must never be a literal in committed
source (the same rule `root`/`claudeBin` follow).

PRECEDENCE, both in `rmd serve` and in the generated unit: `--host`/`--port` flag >
`RMD_SERVE_HOST` env > this field > loopback/{@link DEFAULT_SERVE_PORT}. Absent, nothing
changes: the console binds 127.0.0.1:4317 exactly as before.

`identityCapability` (W1-T371) opts the console into ADDITIVE tailnet-identity auth: the
Tailscale ACL app-capability name (e.g. `"example.com/cap/console-write"`) an allowlisted
node must be granted to authenticate with no bearer token at all — see
{@link resolveServeIdentity} (serve.ts) and service.ts's `IdentityAuth` for the two gates
enforced. No flag/env override, unlike host/port: it's a per-install constant chosen once
against the operator's own Tailscale ACL, not something a single invocation varies. Absent
(the default): identity is never consulted and the bearer token authenticates exactly as
it always has — a Tailscale failure (or simply never opting in) degrades to the token
rather than locking the operator out.

`trustedProxy` (W1-T398) is the REQUIRED companion to `identityCapability`: it names which
process the operator means to be terminating on the loopback address gate 1
(`identityGrantedScopes`, service.ts) checks against, since nothing else in this config
states that. Setting `identityCapability` with `trustedProxy` absent is REFUSED at startup
— silently inheriting that trust assumption is exactly the hazard this field closes. The
only accepted value today is `"tailscale"` ({@link resolveServeIdentity}'s
`TRUSTED_PROXY_TAILSCALE`); any other value is a named opt-out that is also refused, with a
message naming the header-stripping guarantee it would have to provide. Irrelevant, and
never read, when `identityCapability` is absent.
```

## relay

Base lines 152-165.

```
W1-T431 (Tier-2 relay CLIENT — the outbound-only half of D-11's distribution architecture):
where `rmd relay` dials OUT to, and the short-lived credential it presents once it gets
there. Lives HERE, outside the git tree, for the same reason `serve.host`/`claudeBin` do —
both a relay address and an enrollment token are per-install secrets that must never be a
literal in committed source or a CLI argument (shell history, `ps`).

`url` is the relay's dial-out address (e.g. `"https://relay.example.com:8443"`); `token` is
the enrollment credential pasted from the relay's UI, the GitHub self-hosted-runner
registration-token shape (design note iv) — rotation is re-enrollment (delete/replace this
field), never a runtime rotation call. Both absent (the default): `rmd relay` refuses to
start and says so; `rmd serve` is completely unaffected either way, since the two commands
are separate processes and this field is read by neither's dispatch but its own.
```

## headroom

Base lines 167-194.

```
Headroom governor switch (operator ruling fb-1784894405468-a4153e, 2026-07-24,
amending P34(c)/W1-T249, extending W1-T252 — its DEFAULT clause reversed by the
operator ruling of 2026-07-25, below).

When `enabled` is false, ALL headroom-based dispatch gating is OFF: the W1-T197
daemon idle curve and the ratified W1-T249 reserve gate never pause dispatch on
`percent_used`. Headroom is still READ and LEDGERED every daemon cycle
(telemetry without enforcement), so the console shows weekly burn and the
operator flips the flag with data in front of him. The per-run turn limit and
`budget_usd` tripwire remain the runaway guards (ruling clause 4). When
`enabled` is true, the existing time-aware curve enforces unchanged.

DEFAULT — **true** (OPERATOR RULING 2026-07-25, superseding a4153e's default
clause while keeping its flag architecture intact): "most people would prefer
rmd to efficiently manage their tokens rather than eat into extra spend." The
shipped default protects the subscription window; SPENDING PAST IT IS THE
DELIBERATE ACT — an operator opts into overflow by setting this field false (or
`RMD_HEADROOM_ENABLED=0`), never by inheriting a permissive default. This host
carries exactly that explicit opt-out in `~/.config/remudero/config.json`
(`headroom.enabled: false`, the credits-burst posture a4153e ruled for), so live
behaviour here is unchanged — only what an unconfigured install inherits flips.

FUTURE HOME: `plan/policy.yaml`'s `headroom.enabled` row once W1-T252 ships —
documented there with the same default, **true**; this config field (and the
`RMD_HEADROOM_ENABLED` env override — see {@link resolveHeadroomEnabled}) is the
interim carrier until then.
```

## learningsHomes field

Base lines 227-246.

```
Explicit override for the shared-knowledge homes (the "org brain") — see
{@link learningsHomes}. Optional; when absent (or a given sub-field is
absent), each home defaults to its historic `config.root`-derived path
unchanged, so a single-instance install's behavior does not change.

WHY THIS EXISTS (D-11 cell architecture): `userOverallLearningsHome` and
`globalLearningsHome` used to derive ONLY from `config.root`, which was
fine while one instance had one `config.root`. Once a cell architecture
gives each codebase its own `config.root` (own ledger, governor,
worktrees), that same derivation silently SPLITS the org brain: N cells
each grow a private, empty `learnings-user/` instead of sharing one. This
field lets same-machine cells point at the SAME path explicitly, so N
cells read one brain instead of fragmenting it N ways. Cross-machine /
cross-user sharing stays W1-T425's redacted hash-pinned transport,
unchanged.

Cells READ the shared homes freely; this field does not add or change any
locking — writes remain whatever single-writer path already exists today.
```

## workerShell

Base lines 341-355.

```
The shell Claude Code runs for a worker's Bash tool, granted via `CLAUDE_CODE_SHELL`. Default
`/bin/bash`.
WHY NOT ZDOTDIR ALONE (installed-version ground truth, CLI 2.1.209): Claude Code builds a shell
SNAPSHOT for its Bash tool by sourcing the rc file at `os.homedir()/.zshrc` — resolved from
HOME, NOT `$ZDOTDIR`. Setting ZDOTDIR does not redirect it. But the rc filename follows the
shell: bash → `$HOME/.bashrc`. Pointing the snapshot shell at bash used to work only because
THIS host's `$HOME/.bashrc` happened to be absent (LEARNINGS.md, PR #8) — an accident, not
construction; a stranger's populated `~/.bashrc` would isolate nothing. W1-T18 (see
{@link workerHomeDir}, `worker-home.ts`) fixes the accident by redirecting the worker's `HOME`
itself to a Remudero-controlled scratch dir holding only empty rc files, so `bash →
$HOME/.bashrc` now resolves to a path the OPERATOR never wrote regardless of what their real
`~/.bashrc` contains. ZDOTDIR is kept alongside this as defense-in-depth for any direct `zsh` a
worker spawns, and never fires the interactive `compinit` prompt that stalled W1-T1C.
```

## FIXTURE_CONFIG_PATH_SEGMENTS

Base lines 472-479.

```
A test fixture that redirects HOME, reaches `loadConfig`/`configPath`, but hand-rolls its own
seeded `config.json` at some OTHER literal path is the trap W1-T2414 is filed against: the
absent file sends `loadConfig` down its `created` branch, which shells `resolveClaudeBin()` —
present on every developer host, absent on a runner with no `claude` binary, so the fixture
passes everywhere it is written and fails only where it is judged. `configPath()`'s own
construction (`.config/remudero/config.json`) is the ONE correct shape; this is its census.
```

## learningsHomes resolver

Base lines 650-663.

```
Resolve the two shared-knowledge homes (the "org brain") — P32/W1-T145's layered knowledge,
D-11's cell-sharing seam. This is the ONE place both homes are computed; {@link userOverallLearningsHome}
and {@link globalLearningsHome} are thin wrappers over it, and every consumer elsewhere
(run-task.ts, learnings.ts) reads through those wrappers rather than re-deriving a path, so an
explicit `config.learningsHomes` override actually reaches every call site instead of shipping
green and inert.
Each home independently defaults to its historic `config.root`-derived path when
`config.learningsHomes` (or the specific sub-field) is absent — BYTE-FOR-BYTE the same path an
unconfigured install always resolved, so existing single-instance installs see no behavior
change. An operator (or a cell orchestrator) sets `config.learningsHomes.userOverall` / `.global`
to an identical path across multiple `config.root`s to make N same-machine cells read one
shared corpus instead of N private ones.
```

## resolveClaudeBin

Base lines 715-726.

```
Resolve the real `claude` binary in a NON-shell context. `execFileSync('which', ...)` runs the
`which` binary directly, so it never sees the interactive zsh `claude` function (FIELD FINDING
3) — it returns the on-disk executable that a spawned Node process would actually exec.

W1-T2414: `which` fails with a bare `Command failed: which claude` — nothing about a config
path, a HOME redirect or a fixture — so a test whose fixture seeds the config somewhere
`configPath()` doesn't resolve reads, on CI, as a missing binary rather than the wrong seam that
reached for it. This rethrows naming the config path this call was reached from (from
`configPath()` itself, not a passed-in argument) and WHICH branch of {@link loadConfig} entered
it, via `reason`. Control flow, return type and the eager call itself are unchanged.
```

## loadConfig

Base lines 741-770.

```
Load the instance config, creating it on first run with resolved defaults. `root` defaults to
`~/Remudero`. Returns fully-resolved absolute paths.

EXCLUSIVE-CREATE DISCIPLINE (CodeQL js/file-system-race): the old shape here was
`existsSync(p) ? read : write` — a classic TOCTOU. Between the `existsSync` check and the
`writeFileSync`, a second process (two workers racing their first `loadConfig()` call) could
create the file first; this process's unconditional write would then silently clobber it.
`openSync(p, "wx")` folds the check and the create into one atomic syscall: it succeeds only if
THIS call created the file, and fails with `EEXIST` if anything else already had — no window
for a second writer to win a race that this branch doesn't already know about.
`resolveClaudeBin()` (shells `which claude`) is deliberately called only *after* the exclusive
create wins, and not at all on the `EEXIST` fallback path unless the existing config is missing
the field — same laziness as before (LEARNINGS.md lazy-config-in-ci: it must stay absent from
CI runs where the config file already exists and the binary doesn't).

CodeQL js/file-system-race, round 2 (alert #24): the first round fixed the WRITE side (the `wx`
create above) but left the `EEXIST` fallback reading via `readFileSync(p, ...)` — a path-string
operation CodeQL's dataflow still correlates back to the `wx` attempt as "checked, then used by
name." Same remediation the query itself recommends for the write side applies here too: read
through the DESCRIPTOR, not the path. `openSync(p, "r")` plus `readFileSync(fd, ...)` never
hands a file-name string to the read sink, so there is nothing left for the query to flag.

CodeQL js/file-system-race, round 4 (alert #60): CodeQL still correlates the `wx` attempt's `p`
with the fallback read's `p`, even through the descriptor indirection (a false positive — see
fs-race-safe.ts's header comment). Rather than open-code a fourth copy of this exact
create-or-read shape, both the `wx` attempt and the descriptor read now live in the shared
`createOrReadExclusive` helper (also used by serve.ts's `resolveServiceTokens`), so a fifth
round reuses tested code instead of a new copy.
```
