# launchd.ts forensics

The measured forensics, incident narratives and design arguments removed from `src/lib/launchd.ts`
when its comments were compacted to the plain-language standard (docs/comment-standard.md). Every
block below is the removed text verbatim, marker characters stripped and nothing else changed.
Headings name the symbol or field the text explained; the code keeps a one-line `// Why:` pointer
where the history mattered. Base revision: origin/main at
8945bb7c60b463feb457974d77554882feb8391b; the line numbers below are that revision's.

## Module header

Base lines 2-56.

```
launchd unit GENERATION (W1-T12b, split from W1-T12 — DIAGNOSIS.md, Rule 16).

This module only builds the .plist TEXT (a pure string transform over
explicit, injected inputs) and computes where it WOULD live on disk. It
never writes a file, never shells out to `launchctl`, and never touches
`~/Library/LaunchAgents` — actually installing + loading the unit on a real
user session is W1-T12d (verify:human): a headless worker cannot commission
a live launchd service (Rule 18). That boundary is why every function here
is a pure function of its arguments, provable with plain string assertions
in a unit test — no real launchd involved.

Three things this unit gets right on purpose:

 1. ABSOLUTE PATHS EVERYWHERE. launchd execs `ProgramArguments[0]` directly
    (no shell, no PATH search) and starts the child in `/` unless
    `WorkingDirectory` is set — a relative path or an unset working
    directory silently fails or resolves against the wrong tree. Every path
    `generateLaunchdPlist` embeds (the launcher, the working directory, the
    log files) is asserted absolute; a relative path is a thrown error, not
    a plist that fails silently at boot.

 2. AN EXPLICIT PATH, NO ANTHROPIC_*. launchd's own default PATH
    (`/usr/bin:/bin:/usr/sbin:/sbin`) omits `/usr/local/bin` and Homebrew's
    `/opt/homebrew/bin`, where `node`/`claude` typically live on macOS — so
    `EnvironmentVariables.PATH` is always set explicitly, never left to
    launchd's default. `EnvironmentVariables` is otherwise a closed
    allowlist (PATH + HOME only) — launchd never sources `~/.zshrc` (see
    lib/env.ts header), so this file is the WHOLE env the daemon process
    receives at boot, and no key here may ever match `ANTHROPIC_*` (the
    billing boundary, MASTER-PLAN §9). `assertNoAnthropicKeys` enforces this
    the same way `lib/env.ts`'s `buildWorkerEnv` enforces it for a worker's
    env: a survivor throws at generation time rather than shipping a
    contaminated unit. The daemon process ALSO re-checks its own live env at
    boot (`lib/daemon.ts` `daemonBoot`, over `lib/env.ts` `assertCleanBoot`)
    — belt-and-suspenders, since a plist that is clean today says nothing
    about how the process actually gets exec'd on a future edit.

 3. THE BINARY COMES FROM THE INSTALL CHECKOUT, NEVER THE INVOKING ONE
    (W1-T925, fb-1784913390318-1fcb63). `ProgramArguments[0]` used to be
    `join(repoRoot, "bin", "rmd")` — `repoRoot` the git toplevel of
    whichever tree `rmd daemon-plist`/`serve-plist`/`digest-plist`/
    `deploy-plist` HAPPENED TO BE RUN FROM — so which checkout the fleet
    actually executes was decided by a `cd`, once, and never revisited.
    Every generator here now takes `installRoot` (W1-T924's
    `resolveInstallRoot`, resolved by the caller) alongside `rmdBin`, and
    throws {@link LaunchdPlistError} — same posture as the self-target and
    ANTHROPIC-key gates — when `rmdBin` does not resolve inside
    `installRoot`, or when the caller reports the install checkout does not
    yet exist (`installRootExists: false`, resolved by the caller so this
    module stays a pure string transform — no filesystem read here, the
    same reason `isSelfTarget` is pre-resolved rather than shelled out to).
    A missing `ProgramArguments[0]` is a spawn error launchd retries
    forever — the crash-loop shape one level below the one this closes —
    so generation refuses and names the remedy (`rmd install-checkout
    --write`) rather than ever emitting that unit.
```

## LaunchdPlistOpts.allowSelfTarget

Base lines 119-129.

```
`rmd daemon-plist --allow-self-target` — explicit operator consent to generate a unit that
targets the daemon's own source repo (the W1-T109 commissioning crash-loop near-miss: a
self-target unit generated WITHOUT this flag loads fine, but the daemon's OWN runtime guard
(`resolveDaemonTarget`) then refuses to start, exits non-zero, and
`KeepAlive`/`SuccessfulExit: false` restarts it forever). When {@link isSelfTarget} is true,
this flag is REQUIRED — {@link generateLaunchdPlist} throws instead of emitting a unit that
would crash-loop at boot (fail at the cheapest layer, generation, not boot). When given, it
is baked into `ProgramArguments` so the daemon's own runtime consent gate is satisfied too.
Ignored (never required, never baked) for a non-self target.
```

## LaunchdPlistOpts.throttleIntervalS

Base lines 132-136.

```
Seconds launchd waits between daemon relaunches (R-1: the relaunch-storm rate limit
already applied to the SEPARATE serve unit, {@link DEFAULT_SERVE_THROTTLE_S}). NET-NEW
for the daemon unit (W1-T253, P37 CONSUMERS) — no prior literal existed to lift, so
absent here this reads `plan/policy.yaml`'s `launchd.throttleIntervalS` (net-new,
bounded [10, 3600] at load) rather than a source literal.
```

## isWithin

Base lines 155-162.

```
True when `child` is `parent` itself, or nested under it. Both inputs are already asserted
absolute by the caller (see {@link assertAbsolute}), so a plain `relative()` compare — no
`resolve()` needed — is sufficient. Deliberately a LOCAL copy, not an import of
`lib/install-root.ts`'s equivalent `isPathInside`: this module stays a leaf (node:os +
node:path + policy.js only, see file header) with no dependency on the install-root module,
the same reason `SERVE_WILDCARD_HOSTS` below is its own copy rather than an import of
`lib/serve.ts`'s `WILDCARD_HOSTS` — a few lines of path arithmetic, not shared policy that
could drift the way the ANTHROPIC-key check would if reimplemented twice.
```

## assertNoAnthropicKeys

Base lines 198-205.

```
Same billing-boundary check as `lib/env.ts`'s `buildWorkerEnv`, applied to a launchd unit's
own `EnvironmentVariables` block. EXPORTED (not module-private) so both {@link
generateLaunchdPlist} (the daemon unit, W1-T12b) and {@link generateDigestLaunchdPlist} (the
digest unit, W1-T112) can be PROVEN to call the identical assertion — one billing boundary
implementation, not two that could drift — and so a fixture can inject an ANTHROPIC_* key
directly and observe the throw without needing a generator whose options happen to expose a
raw-env override. `context` names the caller in the thrown message (defaults to the original
daemon-generator name for backward compatibility with existing error-text assertions).
```

## launchctlGuiTarget

Base lines 346-353.

```
The `launchctl` GUI-domain SERVICE target for one label — `gui/<uid>/<label>` — the
argument `launchctl bootout|print|kickstart` all take to address an already-bootstrapped
job by name (as opposed to `bootstrap`, which addresses the DOMAIN `gui/<uid>` plus a
plist PATH). Pure string composition, factored here so W1-T169's `rmd down`/`rmd up`
(run-task.ts) build this exactly once rather than re-deriving the format at each of
their several call sites — deployer.ts's `realDeployDeps` kickstart call built the same
shape inline (`gui/${uid}/${label}`) before this existed; this is the same string, not a
second format.
```

## The serve LaunchAgent

Base lines 359-386.

```
── The SERVE LaunchAgent (W1-T152 — the operator console as a background SERVICE) ────────

SAME generator family as generateLaunchdPlist above (W1-T12b): the same absolute-path
assertions and the same closed-allowlist, ANTHROPIC-clean EnvironmentVariables. Three
deliberate differences, each earned by an incident:

 1. `KeepAlive` is UNCONDITIONAL (`<true/>`), not the daemon's `SuccessfulExit: false`.
    `rmd serve` blocks until SIGINT/SIGTERM and returns 0 on a clean shutdown — under
    `SuccessfulExit: false` that clean exit is "successful", so launchd would leave the
    console DOWN exactly when someone ctrl+C'd or SIGTERM'd it, which is the fixture this
    task exists for (the operator reclaimed his shell twice in one morning and the board
    went dark). A console the operator reattaches to from a phone must come back from
    EVERY exit; deliberately stopping it is `launchctl bootout`, not an exit code.
 2. `ThrottleInterval` is EXPLICIT (default {@link DEFAULT_SERVE_THROTTLE_S}). R-1: 438
    daemon boots in two days, one per minute at its worst, because KeepAlive relaunches
    on exit and nothing rate-limited it. Unconditional KeepAlive inherits exactly that
    shape unless the throttle is stated, so it is stated.
 3. The bind interfaces ride in `RMD_SERVE_HOST` (the env slot `resolveServeHosts` in
    lib/serve.ts documents for remote access), resolved by the CALLER from config/env and
    passed in — never a literal address in committed source (public-repo hygiene, the same
    rule config.ts's `root` follows). This is the one key beyond PATH+HOME the allowlist
    carries, and it is still ANTHROPIC-clean (`assertNoAnthropicKeys` runs over the whole
    assembled dict, not a subset of it).

DAEMON-INDEPENDENCE IS A REQUIREMENT (W1-T152 note ii), not a detail: on 2026-07-21 the
daemon was deliberately stopped for containment while the operator still needed the board.
Nothing below references {@link DAEMON_LABEL} or any daemon path — this unit installs,
loads and runs with the daemon absent, so stopping the fleet never blinds the operator.
```

## SERVE_WILDCARD_HOSTS

Base lines 395-402.

```
Bind values that mean "EVERY interface", refused by name at generation time. This is the
defense-in-depth DUPLICATE of `lib/serve.ts`'s own `WILDCARD_HOSTS` (the primary gate — the
CLI resolves hosts through `resolveServeHosts` before ever reaching this generator). Two
copies exist because this module is a leaf (node:os + node:path only) and must not import the
live HTTP console to validate a string; test/serve-plist.test.ts asserts the two sets are
IDENTICAL, so they cannot drift apart. A unit that binds the wildcard would put fleet-control
write actions on every coffee-shop LAN the laptop joins, permanently and across reboots —
strictly worse than the foreground `rmd serve` it replaces.
```
