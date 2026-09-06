# Forensics: src/lib/worker-home.ts

Every measured fact, incident and design argument the comments in `src/lib/worker-home.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard
(`docs/comment-standard.md`).

Nothing here is a rule. The worker-home mechanism's behaviour lives in the code, and each block below
is quoted exactly as it stood on `origin/main` at `94ba42cf`, under a heading naming the symbol or
section it explained. The code keeps a one-line `Why:` pointer wherever that history still matters,
and every isolation, security and bound invariant those blocks stated is kept in the code itself.

Every comment block of six lines or more at that revision is archived below, in file order, together
with four shorter blocks that carried an incident or a design argument. Two exceptions: the blocks
PR #4080 added (the keychain provisioning lock's holder-stale rule, its wait deadline and their
injectable seams) already follow the standard and stay in the code unchanged, so they are not
archived here; and PR #4080's own 37-line `acquireKeychainProvisionLock` doc IS archived, because it
exceeded the standard's 12-line function-doc limit and was compacted with it.

---

## module header

`src/lib/worker-home.ts:30-82` at `94ba42cf`, 53 comment lines.

```
/**
 * GENERAL SHELL-ISOLATION MECHANISM (W1-T18 / OSS blocker).
 *
 * W1-T17's preflight probe (isolation.ts) PROVES isolation per run but cannot
 * MANUFACTURE it — until now, isolation held only because CLAUDE_CODE_SHELL=
 * /bin/bash sources `$HOME/.bashrc`, and THIS host happens to have none
 * (LEARNINGS.md, PR #8). A stranger's machine with a populated `~/.bashrc`
 * would get ZERO isolation from that config alone (FIELD FINDING 11b) — the
 * probe would catch it and fail the run closed, but every OSS user's first run
 * would trip the gate.
 *
 * This module manufactures isolation instead of hoping for an absent file:
 * every worker's HOME is redirected to a Remudero-controlled SCRATCH directory
 * (`<root>/worker-home`) that holds ONLY empty rc files Remudero itself wrote —
 * `$HOME/.bashrc` (and its zsh/bash siblings) can never be populated by the
 * operator, because it is never the operator's `$HOME` in the first place. The
 * things a worker genuinely needs from the real HOME (OAuth session, `gh`
 * auth, git identity) are symlinked back in explicitly, one path at a time —
 * never a wholesale HOME copy, the same allowlist discipline as env.ts's
 * ANTHROPIC_* boundary.
 *
 * WS-0 FIELD FINDING 11c — CORRECTED (W1-T18 live drill, this fix): the earlier
 * belief that "the Keychain OAuth token resolves off `USER`, not `HOME`" was
 * FALSE. USER is necessary but NOT sufficient: the macOS login keychain that
 * holds the `Claude Code-credentials` OAuth item is located HOME-RELATIVELY at
 * `$HOME/Library/Keychains/login.keychain-db`. So the moment HOME was redirected
 * to the scratch dir (which has no `Library/Keychains`), the keychain lookup hit
 * an empty path and Claude Code returned "Not logged in · Please run /login" —
 * exiting at $0 / 0 real turns BEFORE any tool ran, which is exactly why the
 * first post-#100 spawn (the containment probe) produced nothing (inside-write
 * absent, no denial, cost 0). The worker never started. The fix is the SAME
 * defensive symlink-back this module already does for `.claude`/`.config/gh`:
 * add `Library/Keychains/login.keychain-db` to the allowlist so the redirected
 * HOME resolves the real login keychain. This does NOT weaken isolation (the rc
 * files are still empty ⇒ 0 aliases/0 functions) or containment (keychain I/O is
 * mediated by `securityd` over XPC, not a direct file write into the sandbox
 * scope; the outside-cwd write is still OS-denied). Only the single keychain DB
 * file is granted — never the whole `~/Library`. Verified live: a trivial task
 * completes under the redirect, the containment probe passes, isolation stays
 * 0/0. See LEARNINGS.md and the drill (W1-T12e), now a real spawn-under-redirect.
 *
 * WHERE THE HOME MAY LIVE (W1-T2633). Every per-run home this module has ever produced has
 * landed as a SIBLING of the worker-home root (see {@link perRunWorkerHomeDir}) — but until this
 * task that was incidental, not asserted: `workerHomeDir` (config.ts) resolves an
 * OPERATOR-SETTABLE `config.workerHomeRoot` with no guard, so pointing it (or `config.root`) at a
 * path inside a tracked checkout would have written the rc files and symlinks straight into a repo.
 *
 * THE INVARIANT, STATED PLAINLY: a worker home is never inside a git work tree. It is now
 * enforced, not hoped for — {@link materializeWorkerHome} refuses (via
 * {@link gitWorkTreeAncestor}, throwing {@link WorkerHomePlacementError}) before writing anything,
 * whether the offending ancestor is a plain clone's `.git` DIRECTORY or a linked worktree's `.git`
 * FILE.
 */
```

## the `.claude` grant

`src/lib/worker-home.ts:109-119` at `94ba42cf`, 11 comment lines.

```
/**
 * W1-T505: the credential-only sibling of the operator's real `.claude` that a worker's
 * `.claude` grant PREFERS. MEASURED at filing: the operator's whole `.claude` is 1.8GB —
 * 10,101 session transcripts, a `settings.json` that can inject env vars into the
 * operator's NEXT session, `history.jsonl`, `skills/`, `plugins/` — against the one thing a
 * worker actually needs, `.credentials.json` (509 bytes). When `<realHome>/.claude-fleet`
 * exists, {@link workerHomePlan} resolves the `.claude` grant to IT instead of the
 * operator's full `.claude`; when it does not exist, the grant falls back to today's
 * wholesale behaviour (see {@link workerHomePlan}) so no host is broken by upgrading before
 * this sibling has been populated (design points (ii)/(iv), W1-T505).
 */
```

## playwrightCacheRelPath

`src/lib/worker-home.ts:122-142` at `94ba42cf`, 21 comment lines.

```
/**
 * The explicit allowlist of real-HOME paths a worker needs back, symlinked
 * individually. Mirrors env.ts's ALLOWLIST discipline: name each grant and its
 * reason, never inherit the rest of HOME wholesale.
 */
/**
 * The browser cache's path RELATIVE TO HOME, derived from the SAME resolver the launch path uses
 * ({@link playwrightCacheRoot}, `lib/review.ts`) rather than a second copy of its platform branch —
 * W1-T1063's design point, so the grant and the resolver cannot disagree.
 *
 * PASSING AN EMPTY ENV IS DELIBERATE. The no-override branch is the only one a worker can ever
 * take, because `ALLOWLIST` (`lib/env.ts`) passes PATH, HOME, TMPDIR, LANG, USER and the Claude
 * token and NOTHING ELSE into a spawn, so `PLAYWRIGHT_BROWSERS_PATH` cannot survive to be read.
 * That is the same reason `deploy/Dockerfile` gives for installing at the default path and setting
 * no variable at all, and it is why this grant — not a variable — is the mechanism.
 *
 * A SENTINEL HOME IS USED, NOT A REAL ONE, so the result is a pure relative path independent of
 * whose HOME is asked about: linux yields `.cache/ms-playwright`, darwin
 * `Library/Caches/ms-playwright`. BOTH PLATFORMS ARE COVERED — the fleet runs in the Linux
 * container, and the table already carries a macOS-specific entry beside this one.
 */
```

## WorkerHomePlan

`src/lib/worker-home.ts:187-193` at `94ba42cf`, 7 comment lines.

```
/**
 * PURE plan of what {@link materializeWorkerHome} will do — extracted so the
 * redirection logic is unit-testable without touching the filesystem. Every
 * `from` is under the redirected `workerHome`; every `to` is under the real
 * `realHome`, one explicit path at a time (never `workerHome === realHome`,
 * or the redirection grants nothing).
 */
```

## WorkerHomePlan.outcomes

`src/lib/worker-home.ts:198-203` at `94ba42cf`, 6 comment lines.

```
  /**
   * What ACTUALLY happened to each grant (W1-T442-adjacent, the seventh instance of this
   * repo's own law: a grant that FAILED is not a grant that was OPTIONAL). Populated by
   * {@link materializeWorkerHome}; absent on the pure {@link workerHomePlan}, which decides
   * nothing and touches no filesystem.
   */
```

## WorkerHomePlan.claudeGrantTarget

`src/lib/worker-home.ts:205-213` at `94ba42cf`, 9 comment lines.

```
  /**
   * W1-T981: whatever the `.claude` grant resolves to for THIS plan — the operator's whole
   * `.claude`, or W1-T505's narrowed credential-only sibling when populated. This is where the
   * CLI's own `.claude.json` backups land (see {@link CLAUDE_CONFIG_REL}), so
   * {@link materializeWorkerHome} sweeps it via {@link sweepClaudeConfigBackups}. Optional only
   * so a hand-built literal (e.g. a fixture testing {@link lostWorkerHomeGrants} in isolation)
   * need not carry it — {@link workerHomePlan} and {@link materializeWorkerHome} both always
   * populate it.
   */
```

## WorkerHomeGrantOutcome

`src/lib/worker-home.ts:223-227` at `94ba42cf`, 5 comment lines.

```
/**
 * One grant's real outcome. `absent` and `failed` MUST stay distinguishable — the absent
 * skip is a deliberate, correct optional-grant path (the mini legitimately lacks several),
 * while a failure is a silent loss of capability that has already cost real money.
 */
```

## WorkerHomeGrantOutcome.state

`src/lib/worker-home.ts:231-239` at `94ba42cf`, 9 comment lines.

```
  /**
   * - `linked`    — the symlink was created (or re-pointed) and now resolves to `to`.
   * - `already`   — it already pointed at `to`; nothing done.
   * - `absent`    — the TARGET does not exist. An optional grant, skipped SILENTLY and
   *                 correctly: several are legitimately unavailable on the mini.
   * - `displaced` — a REAL DIRECTORY occupied the slot; it was moved aside (see
   *                 {@link WorkerHomeGrantOutcome.displacedTo}) and the link created.
   * - `failed`    — the grant could not be made. The worker runs WITHOUT it.
   */
```

## lostWorkerHomeGrants

`src/lib/worker-home.ts:248-254` at `94ba42cf`, 7 comment lines.

```
/**
 * The grants that were LOST or HEALED — everything a caller should surface, and nothing it
 * should not. `absent` and the two healthy states are excluded deliberately: materialisation
 * runs per spawn and per probe tick, so reporting every grant would be four rows a spawn, while
 * `failed`/`displaced` are rare by construction (a displaced slot heals once and then reads
 * `already`). That asymmetry is what lets this be reported at all without becoming noise.
 */
```

## CLAUDE_CONFIG_REL

`src/lib/worker-home.ts:265-300` at `94ba42cf`, 36 comment lines.

```
/**
 * W1-T981: the HOME-relative slot the CLI's OWN config file occupies — the sibling of
 * {@link CLAUDE_REL} that is DELIBERATELY ABSENT from {@link WORKER_HOME_SYMLINKS} and
 * {@link WORKER_HOME_RC_FILES} alike. Disposition (A), "ACCEPT AND DOCUMENT", chosen over
 * seeding (B) or granting it back (C):
 *
 *   - Every per-run redirected HOME (perRunWorkerHomeDir) starts this slot empty, because
 *     nothing in this module writes it and it is not in the allowlist above. The CLI itself
 *     notices, on first use, and creates a fresh `.claude.json` from scratch — the
 *     "Claude configuration file not found at worker-home-<uuid>/.claude.json" notice every
 *     spawn logs IS that creation, not a transiently-lost file and not a race: the slot was
 *     never populated in the first place, on every spawn, by construction. See this task's
 *     filing (feedback#fb-1785775974389-e25033) for the four source citations that refute the
 *     race hypothesis.
 *   - GRANTING it back (option C, symlinking this slot the way {@link CLAUDE_REL} is) is
 *     REJECTED: unlike the credential file `.claude` already narrows toward (W1-T505), a real
 *     operator `.claude.json` carries mutable, per-process state
 *     (`hasAvailableSubscription`, `cachedUsageUtilization`, `modelAccessCache`,
 *     `autoCompactWindowsCache`, `machineID`, `oauthAccount` — FINDINGS.md:263-266) that every
 *     concurrent worker would then read AND WRITE through one shared inode — the same
 *     class of coupling W1-T170 introduced per-run homes to end, in a new slot.
 *   - SEEDING it (option B) is not done here either: nothing measured shows a worker loses
 *     capability running with no `.claude.json` — `resolveActiveAccountId`
 *     (src/lib/worker.ts:657) already defaults to the PARENT's real
 *     `join(homedir(), ".claude.json")`, never the worker's redirected one, so account/identity
 *     resolution is unaffected by this slot being virgin.
 *
 * WHERE THE CLI'S OWN BACKUP OF THE FILE IT REPLACES LANDS: `<claudeGrantTarget>/backups/
 * .claude.json.backup.<epoch>` (see {@link CLAUDE_CONFIG_BACKUP_PREFIX}), where
 * `claudeGrantTarget` is whatever the `.claude` grant currently resolves to — the operator's
 * whole `.claude`, or W1-T505's narrowed sibling once populated. Because that grant is a
 * symlink OUT of the redirected worker home into a directory every concurrent worker shares,
 * the backup write lands there too, not inside the throwaway worker home the per-run reap
 * (`reapWorkerHome`, src/lib/worker.ts:1039) already cleans up. {@link sweepClaudeConfigBackups}
 * is what keeps that shared, otherwise-unbounded write bounded and observable.
 */
```

## workerHomePlan opts.workerKeychainPath

`src/lib/worker-home.ts:306-313` at `94ba42cf`, 8 comment lines.

```
  /**
   * W1-T235 (WS-7 keychain-unlock gate): when set, the redirected HOME's
   * `Library/Keychains/login.keychain-db` slot resolves to this DEDICATED,
   * always-unlocked worker keychain instead of the operator's real login
   * keychain — breaking the single-inode coupling under which a LOCKED login
   * keychain killed every headless spawn "Not logged in" at $0 (fired live
   * 2026-07-21). Unset ⇒ the pre-T235 grant to the real login keychain.
   */
```

## sweepClaudeConfigBackups

`src/lib/worker-home.ts:376-384` at `94ba42cf`, 9 comment lines.

```
/**
 * W1-T981 design point (iv): bound and OBSERVE the CLI's `.claude.json` backups instead of
 * letting them accumulate silently in the shared granted `.claude` directory. Keeps the
 * `maxKeep` NEWEST backups (by the epoch embedded in each filename — the CLI's own ordering,
 * cheaper and more precise than an `mtime` stat per file) and reaps the rest. Best-effort and
 * never throws: an absent `backups/` directory (nothing has spawned against this grant target
 * yet) is a silent, correct no-op — the same discipline {@link sweepStaleWorkerHomes} already
 * applies to its own boot sweep, so this adds no new refusal path (design point (v)).
 */
```

## gitWorkTreeAncestor

`src/lib/worker-home.ts:426-439` at `94ba42cf`, 14 comment lines.

```
/**
 * W1-T2633: PURE — walks `homePath`'s own ancestors (starting at `homePath` itself, ending at
 * the filesystem root) looking for a `.git` entry. Returns the first ancestor `.git` path found,
 * or `undefined` if none exists all the way to `/`. Needs no repo path threaded through it — the
 * whole point of walking ancestors instead of taking one — so every caller of
 * {@link materializeWorkerHome} gets the guard for free regardless of how `workerHome` was
 * derived (the default `<root>/worker-home` shape, or an operator-set `config.workerHomeRoot`
 * alike).
 *
 * A `.git` ENTRY IS EITHER A DIRECTORY (a plain clone) OR A FILE (a linked worktree's `gitdir:`
 * pointer, `git worktree add`'s own shape) — both disqualify the home equally, and `exists`
 * (default `existsSync`) is agnostic to which: it answers only "is something there", which is
 * exactly the question this predicate needs answered.
 */
```

## WorkerHomePlacementError

`src/lib/worker-home.ts:454-463` at `94ba42cf`, 10 comment lines.

```
/**
 * W1-T2633: thrown by {@link materializeWorkerHome} BEFORE anything is written, when the
 * resolved worker home would land inside a git work tree (see {@link gitWorkTreeAncestor}).
 * Named after {@link WorkerKeychainError} — this module's own precedent for "throw before any
 * I/O, name the reason class" — except the reason here is a single, unambiguous fact rather than
 * a taxonomy: refusing is the loud failure and writing is the silent one, and a home nested
 * inside a repo is exactly the pollution this guard exists to make impossible. `workerHome` and
 * `gitAncestor` are both carried on the error, not just interpolated into the message, so a
 * caller can log or assert on them directly.
 */
```

## materializeWorkerHome

`src/lib/worker-home.ts:478-495` at `94ba42cf`, 18 comment lines.

```
/**
 * Materialize a {@link WorkerHomePlan} on disk: guarantee every rc file exists
 * and is EMPTY (truncating a stale one — this directory is Remudero-owned, so
 * a prior run's leftovers are debris, never operator content to preserve), and
 * symlink each real-HOME path back in.
 *
 * BEST-EFFORT per symlink: a source that does not exist on the real HOME
 * (e.g. no `gh` ever configured on this machine) is skipped rather than
 * thrown — isolation must not depend on every optional tool being installed.
 * An existing symlink already pointing at the right target is left alone
 * (idempotent across repeated spawns in the same run); one pointing anywhere
 * else is replaced (self-healing if the real HOME path moved).
 *
 * W1-T2633: REFUSES before writing anything if `opts.workerHome` resolves inside a git work
 * tree (see {@link gitWorkTreeAncestor}) — throws {@link WorkerHomePlacementError} naming both
 * the offending home path and the `.git` ancestor that disqualified it. A home outside every
 * work tree is unaffected: this check adds a refusal and moves no other behaviour.
 */
```

## the optional-grant skip

`src/lib/worker-home.ts:522-525` at `94ba42cf`, 4 comment lines.

```
      // THE OPTIONAL-GRANT SKIP, DELIBERATE AND UNCHANGED. The target genuinely is not on this
      // host (several are legitimately absent on the mini), so there is nothing to grant. This
      // is the one silent path, and it must STAY silent — turning it into an error would break
      // every host where a grant is unavailable by design.
```

## a real directory in the slot

`src/lib/worker-home.ts:537-554` at `94ba42cf`, 18 comment lines.

```
        // A REAL DIRECTORY IN THE SLOT. `unlinkSync` cannot remove one, and the `symlinkSync`
        // below then throws EEXIST — so before this, the directory won PERMANENTLY and silently.
        // MEASURED in the Azure container: `worker-home-usage-probe/.claude` was a directory, the
        // usage probe therefore ran LOGGED OUT, and 33 of 33 probes read `stage: "parse"` against
        // a 207-byte cost summary instead of the account panel. Re-materialisation did not heal it.
        //
        // MOVED ASIDE, NOT DELETED, and the choice is argued rather than assumed:
        //   - RECURSIVE REMOVAL would work and is defensible — a worker home is machine-owned
        //     scratch this function creates, so nothing user-authored lives here. It is rejected
        //     because the directory is written BY THE CLI WE ARE GRANTING TO (it creates `.claude`
        //     when HOME is redirected and the grant is missing), and it is the only evidence of
        //     what poisoned the slot. This defect went undiagnosed precisely because there was no
        //     evidence; deleting it would rebuild that condition.
        //   - REFUSING LOUDLY is rejected: it converts a recoverable, self-healing state into a
        //     hard spawn failure on every host that has one, which is strictly worse than the
        //     silent degradation it replaces.
        // `rename` is atomic and the suffix is unique, so two workers racing the same shared home
        // cannot collide.
```

## a failed grant is not a declined one

`src/lib/worker-home.ts:576-579` at `94ba42cf`, 4 comment lines.

```
      // Racing another worker materializing the same shared worker-home, or debris that could
      // not be cleared above — still never fatal to isolation itself (the rc files above are
      // what actually isolate). But it is NO LONGER SILENT: the target exists and we failed to
      // reach it, which is a lost capability, not an optional grant declined.
```

## per-run worker homes

`src/lib/worker-home.ts:599-609` at `94ba42cf`, 11 comment lines.

```
// ── W1-T170: per-run/per-spawn worker HOMES (the singleton does not survive concurrency) ──
//
// WS-2 names the failure mode by hand: "the singleton <root>/worker-home (W1-T18/
// #100/#102) does NOT survive concurrency; every concurrent worker needs its own
// worker-home-<runId> with its own empty rc + its own login.keychain-db/.claude/
// .config/gh symlinks. A shared home races on rc materialization and the keychain
// grant." Two overlapping spawns truncating/symlinking the SAME rc files and
// keychain slot is exactly the kind of interleaving that turns a deterministic,
// already-fixed bug (#100's HOME-relative keychain miss) into an intermittent one.
// NOT IN SCOPE, and unchanged by this section: WHAT is symlinked — the allowlist
// above, verbatim — only how many homes exist and who owns each.
```

## PER_SPAWN_TOKEN_SEP

`src/lib/worker-home.ts:614-621` at `94ba42cf`, 8 comment lines.

```
/**
 * W1-T2463: the delimiter between a per-spawn worker home's `runId` component and its
 * per-spawn uniqueness token (see {@link perRunWorkerHomeDir}'s `perSpawn` option and
 * {@link sweepStaleWorkerHomes}, which parses it back out). Chosen because every runId
 * observed in this repo (`grep -n 'const runId = ' src/run-task.ts`) is
 * `${wordOrTaskId}-${Date.now()}` — hyphen/alphanumeric only, never a dot — so a dot can
 * never collide with a runId's own characters and the split below is unambiguous.
 */
```

## stripPerSpawnToken

`src/lib/worker-home.ts:624-631` at `94ba42cf`, 8 comment lines.

```
/**
 * W1-T2463 Q3: the reverse of the encoding {@link perRunWorkerHomeDir} applies under
 * `perSpawn` — strips a trailing `${PER_SPAWN_TOKEN_SEP}<token>` suffix, if present, so a
 * caller matching on `runId` (the inflight-lock/ledger-verdict lookups in
 * {@link sweepStaleWorkerHomes}) compares against the SAME id the spawn was given, never
 * the token-bearing full directory suffix. A suffix with no separator — the pre-W1-T2463
 * shape, and `readUsageSnapshot`'s un-opted-in "usage-probe" shape — round-trips unchanged.
 */
```

## perRunWorkerHomeDir

`src/lib/worker-home.ts:637-657` at `94ba42cf`, 21 comment lines.

```
/**
 * The per-spawn worker HOME: `<workerHomeRoot>-<id>`, a SIBLING of the
 * singleton root (never the root itself, never nested under it — see
 * {@link isReapableWorkerHome}, which enforces exactly that shape on reap).
 * `id` prefers the caller's `runId` when supplied (durable and legible in
 * `ps`/logs — the literal `worker-home-<runId>` WS-2 names), but generation
 * never DEPENDS on one being threaded through: the concurrency invariant —
 * no two overlapping spawns ever share a home — must hold even for a caller
 * that has not (yet) wired a runId through, so an absent/empty one falls
 * back to a fresh `randomUUID()` per call.
 *
 * W1-T2463: `opts.perSpawn` OPTS IN to appending a per-spawn uniqueness token after `id`
 * (`<workerHomeRoot>-<id>.<token>`), so two spawns sharing one `runId` inside the same
 * daemon run resolve to DISTINCT homes — the collision `worker.ts:1009` hit, keyed on
 * `args.runId` alone. `runId` stays the FIRST/durable component (Q1: `workerMarkerEnv`
 * still writes the bare `runId`, unaffected — this function's return value is never what
 * reclamation matches on) and the DEFAULT (omitted `opts`) is BYTE-IDENTICAL to before
 * (Q2: `readUsageSnapshot`'s `perRunWorkerHomeDir(root, "usage-probe")` call never opts in,
 * so its stable, non-per-call home is unchanged). See {@link stripPerSpawnToken} for the
 * matching decode {@link sweepStaleWorkerHomes} applies (Q3).
 */
```

## isReapableWorkerHome

`src/lib/worker-home.ts:669-677` at `94ba42cf`, 9 comment lines.

```
/**
 * `true` IFF `target` is exactly `<root>-<nonempty-suffix>` — a per-spawn
 * SIBLING of the singleton root, one segment, no traversal. Guards
 * {@link reapWorkerHome} so a malformed target can never remove the
 * singleton root itself or anything outside its own sibling — the same
 * one-segment-below/beside-root discipline worker-scratch.ts's
 * `isReapableScratchTarget` already applies to the identical class of
 * mistake (a reap that escapes its own resource).
 */
```

## reapWorkerHome

`src/lib/worker-home.ts:694-701` at `94ba42cf`, 8 comment lines.

```
/**
 * Best-effort reap of ONE per-spawn worker home. Called at spawn teardown on
 * EVERY exit path, including a thrown error — the same `withTempDir`
 * discipline (W1-T115/W1-T131) rmd already applies to its other throwaway
 * resources, now covering a resource that must not accumulate across
 * concurrent or serial spawns. Guarded by {@link isReapableWorkerHome};
 * existence-checked; never throws.
 */
```

## DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS

`src/lib/worker-home.ts:718-722` at `94ba42cf`, 5 comment lines.

```
/** Default age ceiling for {@link sweepStaleWorkerHomes}: 24h — matches the
 * other boot sweeps (lib/tmp.ts's `sweepStaleTempDirs`, lib/worker-scratch.ts's
 * `sweepStaleWorkerScratch`). W1-T1064: this is now the BACKSTOP for a candidate whose
 * run id resolves to nothing, not the primary signal — see {@link sweepStaleWorkerHomes}'s
 * doc for the predicate that runs before it. */
```

## WorkerHomeSweepOpts.inflightDir

`src/lib/worker-home.ts:732-742` at `94ba42cf`, 11 comment lines.

```
  /**
   * W1-T1064: where `state/inflight/*.lock` files live — checked for a lock naming a
   * candidate's run id BEFORE anything is removed (a live lock keeps the home
   * regardless of age; design bullet 2, plan/tasks.d/W1-T1064). Defaults to
   * `<dirname(root)>/state/inflight`, mirroring config.ts's own documented relationship
   * between `workerHomeDir` (`<config.root>/worker-home`, unless a `workerHomeRoot`
   * override is configured) and `config.root` — every EXISTING caller of
   * {@link sweepStaleWorkerHomes} passes only `root`, so this default is what makes the
   * sharpened predicate apply with no call-site change. A caller running a custom
   * `workerHomeRoot` should pass this explicitly.
   */
```

## WorkerHomeSweepOpts.ledgerPath

`src/lib/worker-home.ts:744-749` at `94ba42cf`, 6 comment lines.

```
  /**
   * W1-T1064: the ledger checked for a terminal `verdict` line naming a candidate's run
   * id — the ONLY thing that authorises removing a home before the age ceiling (design
   * bullet 3). Defaults to `<dirname(root)>/state/ledger.ndjson`, the same
   * `workerHomeDir`-relative assumption {@link inflightDir} makes.
   */
```

## WorkerHomeSweepOpts.log

`src/lib/worker-home.ts:751-758` at `94ba42cf`, 8 comment lines.

```
  /**
   * W1-T1064: "PRINT BEFORE CLEARING, ALWAYS" (the task design's own words) — called once
   * per removal naming the home, its run id and the evidence that judged it dead, and
   * once more at the end of EVERY pass (including the zero-removed case), so a pass that
   * ran and found nothing stale is no longer indistinguishable from one that never ran.
   * Optional and unwired by any existing caller — every current call site is therefore
   * unaffected by this addition.
   */
```

## findLiveInflightLockForRun

`src/lib/worker-home.ts:767-776` at `94ba42cf`, 10 comment lines.

```
/**
 * W1-T1064: `true` iff `inflightDir` holds a `*.lock` file whose `run_id` names `runId`
 * — a POSITIVE liveness signal that is file-based and survives a restart (design bullet
 * 2), unlike a live-pid check (bullet 1), which the moment right after a restart makes
 * unreliable on its own (pids are reassigned right when workers are being respawned).
 * `sweepStaleInflightLocks` (inflight-lock.ts) reaps stale locks on its own schedule, so
 * this function's ABSENT result must never be read as "the run ended" — only a PRESENT
 * result means anything, which is why {@link sweepStaleWorkerHomes} only ever uses this
 * to KEEP, never to authorise a removal.
 */
```

## hasTerminalLedgerVerdict

`src/lib/worker-home.ts:798-805` at `94ba42cf`, 8 comment lines.

```
/**
 * W1-T1064: `true` iff `ledgerPath` holds a `step: "verdict"` line whose `run_id` names
 * `runId` — the POSITIVE statement of death (design bullet 3) that authorises
 * {@link sweepStaleWorkerHomes} to remove a home before the age ceiling. Every
 * `run-task.ts` run's `log` closure stamps this exact `{run_id, step: "verdict"}` shape
 * on every terminal outcome (`log("verdict", ...)`), so this reads the SAME fact the
 * daemon itself already records, never a second notion of "done".
 */
```

## sweepStaleWorkerHomes

`src/lib/worker-home.ts:828-862` at `94ba42cf`, 35 comment lines.

```
/**
 * Boot-time backstop (mirrors worker-scratch.ts's `sweepStaleWorkerScratch`
 * and tmp.ts's `sweepStaleTempDirs`): reap `<root>-<id>` worker-home dirs a
 * crashed/killed process could not reach its own {@link reapWorkerHome} call
 * for — the daemon boot sweep this task's design calls for, so a home
 * orphaned by an ended run does not accumulate across boots. Scans `root`'s
 * PARENT directory for siblings matching `<basename(root)>-`.
 *
 * W1-T1064 — THE PREDICATE, SHARPENED. Age alone let a day's worth of ~24h-old homes
 * (mostly a per-run Playwright browser cache) accumulate until the disk hit 100% and
 * tore a ledger write mid-record. Age is now the BACKSTOP, not the primary signal, for a
 * candidate whose run id (the `<id>` in `<root>-<id>`) resolves to nothing:
 *
 *   1. A LIVE `state/inflight/` lock naming this run id (see
 *      {@link findLiveInflightLockForRun}) keeps the home REGARDLESS OF AGE — file-based,
 *      so unlike a pid check it survives a restart. Its ABSENCE proves nothing (the lock
 *      sweep reaps stale locks on its own) and never authorises a removal by itself.
 *   2. Only once no live lock was found: a TERMINAL `verdict` ledger line naming this run
 *      id (see {@link hasTerminalLedgerVerdict}) is a POSITIVE statement that the run
 *      finished, and removes the home NOW, before the age ceiling.
 *   3. Anything else — no lock, no verdict; an orphan from a `kill -9` or a crash before
 *      any verdict was written — falls back to `maxAgeMs`, exactly the pre-existing
 *      mtime-only behavior.
 *
 * `inflightDir`/`ledgerPath` default off `dirname(root)` (see {@link WorkerHomeSweepOpts}),
 * so every EXISTING caller — `run-task.ts`'s boot rung and `logDiskReclaimRung` both call
 * `sweepStaleWorkerHomes(root)` with no other args — gets the sharpened predicate for
 * free, with no call-site change required.
 *
 * Every removal is named via the optional `log` (home, run id, evidence), and the pass
 * reports once more at the end EVEN WHEN NOTHING WAS REMOVED (design: "say so when
 * nothing was eligible"), so silence never again reads the same as "never ran".
 *
 * Best-effort throughout; never throws.
 */
```

## the dedicated worker keychain

`src/lib/worker-home.ts:947-964` at `94ba42cf`, 18 comment lines.

```
// ── W1-T235: the dedicated worker keychain (WS-7 keychain-unlock gate) ──────
//
// The login keychain holds the `Claude Code-credentials` OAuth item and locks
// with the operator's session (cold boot, `security lock-keychain`, screen
// policy). Under the pre-T235 symlink the redirected HOME resolved the REAL
// login keychain, so a lock killed every headless spawn "Not logged in" at $0
// before any turn — and, because a credential-dead worker makes zero writes,
// the death rendered as the generic "containment UNPROVEN" misdiagnosis
// (fired live 2026-07-21, two spawns, two days of theory).
//
// This section provisions a DEDICATED keychain holding a COPY of the item,
// configured to never auto-lock and unlocked by the harness itself with a
// password persisted 0600 under the config state dir. The operator's login
// keychain is READ exactly once (at provisioning, while it is unlocked) and
// is NEVER unlocked by the fleet — option (i) of the task's design space,
// chosen for the smallest blast radius. Every failure path out of this rung
// throws a {@link WorkerKeychainError} carrying a named reason CLASS, so a
// credential failure can never again render as a containment finding.
```

## WorkerKeychainReasonClass

`src/lib/worker-home.ts:969-978` at `94ba42cf`, 10 comment lines.

```
/** Named failure classes for the credential rung — queryable, not prose.
 *
 * The first four are the macOS keychain rung's own (W1-T235). The next two are the
 * NON-DARWIN file store's (recon-cloud-workers-spike, stop 6): a keychain either yields a
 * secret or does not, but a file has more ways to be wrong than that, and collapsing them
 * would put this rung back in the position the whole taxonomy exists to avoid. See
 * {@link classifyWorkerCredentialFile} for which observation earns which class. The last
 * is W1-T2398's: the credential IS usable right now but its recorded expiry cannot
 * outlive the caller's own `expectedRunMs` — a distinct fact from all of the above, none
 * of which speak to run length at all. */
```

## WorkerKeychainError

`src/lib/worker-home.ts:994-999` at `94ba42cf`, 6 comment lines.

```
/**
 * A credential-NAMED failure out of the worker-keychain rung. Thrown BEFORE
 * any worker spawns, so a locked/missing credential fails loudly at the spawn
 * boundary instead of spawning a credential-dead worker whose zero-write death
 * reads as "containment UNPROVEN" (the 2026-07-21 misdiagnosis).
 */
```

## WorkerKeychainPaths.identityPath

`src/lib/worker-home.ts:1015-1020` at `94ba42cf`, 6 comment lines.

```
  /**
   * The 0600 sidecar recording which account identity (an `EnsureWorkerKeychainOpts.accountId`
   * NAME — never a secret) this store was last provisioned for. `ensureWorkerKeychain` reads it
   * to detect an identity change under the unlabelled default path; a caller that never supplies
   * `accountId` never touches this file, so pre-W1-T265 behavior is unchanged.
   */
```

## WorkerKeychainPaths.expiryPath

`src/lib/worker-home.ts:1022-1030` at `94ba42cf`, 9 comment lines.

```
  /**
   * W1-T293: the 0600 sidecar recording the copied credential's OWN `claudeAiOauth.expiresAt`
   * (a plain epoch-ms NUMBER — never the secret) as of the last (re-)provision. `ensureWorkerKeychain`
   * reads it to detect the credential going stale WITHOUT re-reading the login keychain or the
   * worker store's own secret on every call — see `EnsureWorkerKeychainOpts.now`'s doc. Written on
   * every (re-)provision regardless of whether `accountId` is supplied (independent of the identity
   * sidecar above); absent when the credential carried no parseable expiry field, in which case the
   * expiry gate reports "unknown" rather than inventing one.
   */
```

## workerKeychainPaths

`src/lib/worker-home.ts:1034-1045` at `94ba42cf`, 12 comment lines.

```
/**
 * Canonical locations under the config state dir (`<config.root>/state`).
 *
 * `accountLabel` is an OPTIONAL, operator-chosen NAME (never a token, never derived from a
 * credential — see billingMode(childEnvKeys)'s NAME-only discipline, env.ts:173) that partitions
 * the store per Anthropic account: `remudero-worker-<label>.keychain-db` /
 * `worker-keychain-password-<label>` instead of the legacy unlabelled pair. Omitted ⇒ the
 * legacy unlabelled paths, byte-for-byte, so an unconfigured install is unaffected. This is
 * independent of `EnsureWorkerKeychainOpts.accountId` (below): a label picks WHICH FILE a store
 * lives at; `accountId` is the value compared to detect the SAME file's identity drifting out
 * from under it. An operator may use either, both, or neither.
 */
```

## EnsureWorkerKeychainOpts.accountId

`src/lib/worker-home.ts:1070-1085` at `94ba42cf`, 16 comment lines.

```
  /**
   * W1-T265: the Anthropic account identity active for THIS call — an
   * `accountUuid`/`emailAddress` NAME, never a secret, and NEVER the worker keychain
   * item's own `acct` attribute: account-usage.ts measured that value to be the OS
   * username, identical across an Anthropic account switch, so it cannot discriminate
   * accounts. The caller (worker.ts) resolves it fresh from `~/.claude.json` via
   * account-usage.ts's `readAccountUsageFile` — the same non-keychain source the
   * console's account panel already trusts for this reason.
   *
   * Compared, name-to-name, against `identityPath`'s recorded value: a mismatch (or a
   * store with no recorded identity at all — e.g. one provisioned before this option
   * existed) re-provisions rather than silently reusing a stale copy. Omitted ⇒ the
   * identity check never runs and `identityPath` is never touched — pre-W1-T265
   * behavior (provision once, never re-checked) is unchanged. Appended LAST — no
   * positional caller shifts.
   */
```

## EnsureWorkerKeychainOpts.credentialExpirySkewMs

`src/lib/worker-home.ts:1093-1098` at `94ba42cf`, 6 comment lines.

```
  /**
   * W1-T293 arm (2): a token AT OR WITHIN this window of its recorded `expiresAt` is
   * treated as already stale, so a spawn never races a token that expires mid-run.
   * Omitted ⇒ `DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS`. Appended LAST — no positional
   * caller shifts.
   */
```

## EnsureWorkerKeychainOpts.priorSpawnCredentialExpired

`src/lib/worker-home.ts:1100-1107` at `94ba42cf`, 8 comment lines.

```
  /**
   * W1-T293 arm (3): set by the caller when the PRIOR spawn died on the containment
   * preflight's expiry-named reason (W1-T292's `spawn_credential_expired`, once that
   * task wires it through) — forces THIS call to re-provision even when arm (2)'s own
   * before-the-fact sidecar read saw nothing wrong (the token expired mid-run, after
   * the last check). `ensureWorkerKeychain` never sets this itself; it is purely a
   * caller-supplied hint. Appended LAST — no positional caller shifts.
   */
```

## EnsureWorkerKeychainOpts.expectedRunMs

`src/lib/worker-home.ts:1109-1132` at `94ba42cf`, 24 comment lines.

```
  /**
   * W1-T2398: how long (ms) the caller expects THIS run to take — the dispatcher's own
   * estimate (e.g. the task's `budget_usd` translated to a turn/time cap), never derived
   * in here. Omitted ⇒ behavior is BYTE-FOR-BYTE what it was before this option existed:
   * `DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS` (or `credentialExpirySkewMs`) alone is the margin,
   * and this function never refuses on run length.
   *
   * Supplied, it does two things, both scoped to the ALREADY-RUNNING gate below — no new
   * fetch, no re-authentication, no pacing/sleep of any kind:
   *  (1) it WIDENS the effective skew fed to {@link classifyCredentialSidecar} to
   *      `Math.max(credentialExpirySkewMs ?? DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS,
   *      expectedRunMs)`, so a credential that would expire mid-run is classified
   *      `"expired"` and re-provisioned from the login keychain exactly as any other
   *      expiry is — the fixed constant becomes a FLOOR, not the whole margin;
   *  (2) AFTER that (re-)provisioning attempt — or immediately, on the steady-state path
   *      that never needed one — it compares the credential this call is about to hand
   *      out against `expectedRunMs` one last time and THROWS {@link WorkerKeychainError}
   *      (`credential-too-short-for-run`) if even the freshest available copy still can't
   *      outlast the run, refusing the spawn before it starts rather than starting one
   *      doomed to lose auth partway through. A credential that carries no recorded
   *      expiry is never invented one for this comparison — {@link extractCredentialExpiryMs}'s
   *      "never invent a field" contract holds, and the check is simply skipped.
   * Appended LAST — no positional caller shifts.
   */
```

## WorkerKeychainSummary.observedHeadroomMs

`src/lib/worker-home.ts:1153-1161` at `94ba42cf`, 9 comment lines.

```
  /**
   * W1-T2398: `recordedExpiresAt - now` for the credential THIS call is handing out,
   * measured at the moment of the check below — independent of whether
   * `opts.expectedRunMs` was ever supplied, so the rate this shard's own rationale
   * could not measure from a ledger becomes answerable off-host purely by a caller
   * logging this field. `undefined` exactly when no numeric expiry is known for this
   * credential (no sidecar, or a credential that never carried an `expiresAt`) — never
   * invented.
   */
```

## DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS

`src/lib/worker-home.ts:1172-1179` at `94ba42cf`, 8 comment lines.

```
/** Default FLOOR (not the whole margin — see `EnsureWorkerKeychainOpts.expectedRunMs`,
 * W1-T2398) for the arm-2 expiry gate below: a stored token AT OR WITHIN this window of
 * its recorded `expiresAt` is treated as already stale. On its own this constant answers
 * only "is this credential expired NOW", never "will it still be valid when this run
 * ENDS" — a spawn holding six minutes of credential would pass a bare five-minute check
 * and lose it six minutes in. `deriveProvisionGate` widens the effective margin to
 * `Math.max(this, expectedRunMs)` when a caller supplies `expectedRunMs`, so a credential
 * that cannot outlive its own run is caught instead of handed out. */
```

## extractCredentialExpiryMs

`src/lib/worker-home.ts:1182-1192` at `94ba42cf`, 11 comment lines.

```
/**
 * Pure: pull `claudeAiOauth.expiresAt` (epoch ms) out of the RAW secret the login
 * keychain's `Claude Code-credentials` item carries. VERIFIED FROM SOURCE (a live
 * host's `~/.claude/.credentials.json`, byte-identical shape to what
 * `find-generic-password -w` returns and what `add-generic-password -w` copies
 * verbatim into the worker store): `{"claudeAiOauth":{"accessToken":...,
 * "expiresAt":<epoch-ms>,...}}`. Returns `undefined` for anything that doesn't parse
 * to that shape — callers must never invent a field when this comes back empty;
 * W1-T293's arm (3) (a caller-supplied hint) is the only fallback when a credential
 * genuinely carries no expiry.
 */
```

## classifyCredentialSidecar

`src/lib/worker-home.ts:1221-1229` at `94ba42cf`, 9 comment lines.

```
/**
 * Pure: classify a RECORDED expiry-sidecar value (never the credential itself — see
 * `WorkerKeychainPaths.expiryPath`'s doc) against a clock + skew. `undefined` (no
 * sidecar file — predates this feature, or the credential carried no expiry field at
 * provisioning time) is `"unknown"`: arm (2) has nothing to say, and only arm (3)'s
 * explicit hint can force a re-provision. A present-but-empty/non-numeric value is
 * `"broken"` — the #29896 wipe shape's signature at the sidecar layer — never read
 * as healthy.
 */
```

## the non-darwin credential rung

`src/lib/worker-home.ts:1241-1257` at `94ba42cf`, 17 comment lines.

```
// ── recon-cloud-workers-spike stop 6: the NON-DARWIN credential rung ────────────────────────
//
// WHAT THIS CLOSES, stated precisely, because the obvious framing is wrong. A credential-dead
// worker is NOT silent on Linux today: `probeContainment` (containment.ts) is a once-per-run
// preflight on EVERY platform, and it already classifies the death as `spawn_credential_expired`
// or `spawn_credential_failure`. What Linux lacks is the DARWIN rung's timing and its cost —
// `ensureWorkerKeychain` reads the credential BEFORE anything spawns, so a broken one costs a
// file read; without it the same fact is bought with a probe worker, on every dispatch attempt,
// forever, because nothing upstream ever learns.
//
// EXPIRY IS DELIBERATELY NOT A FAILURE HERE, and this is the load-bearing decision. On darwin an
// expired credential TRIGGERS RE-PROVISIONING from the login keychain — it is a repair path, not
// a refusal. On Linux the file IS the source; there is nothing to re-provision from, and the CLI
// maintains its own refresh. Throwing on `expiresAt` in the past would therefore be a bound
// firing on a condition that may be perfectly healthy, which is this repo's most-repeated defect
// (W1-T312, W1-T380, W1-T382). A genuinely dead token is still caught, loudly and by name, by
// the containment probe that already runs. This rung refuses only what is UNAMBIGUOUSLY unusable.
```

## classifyWorkerCredentialFile

`src/lib/worker-home.ts:1273-1290` at `94ba42cf`, 18 comment lines.

```
/**
 * PURE (given a reader): classify the non-darwin credential file. Four observations, four
 * answers, none of them collapsed — the same null/empty discipline `readLedgerLines`' `present`
 * and `GitHub.readFailed` already keep elsewhere in this codebase:
 *
 *  - the reader throws ENOENT      → `credential-item-missing`, the SAME class the darwin rung
 *                                    uses for "no credential item", because it is the same fact.
 *  - the reader throws anything else → `credential-file-unreadable` (EACCES, EISDIR, EIO). A
 *                                    permissions problem is not an absence and must not read as one.
 *  - the bytes are not JSON        → `credential-file-malformed`.
 *  - the JSON parses but carries no `claudeAiOauth` object → `credential-file-malformed`, with a
 *                                    detail naming the missing block. THIS IS NOT HYPOTHETICAL: a
 *                                    real `.credentials.json` was observed carrying only an
 *                                    `mcpOAuth` section and no Claude credential at all, which a
 *                                    file-exists check would wave straight through.
 *
 * Anything else is `usable`. Expiry is reported, never refused — see the note above.
 */
```

## assertWorkerCredentialFile

`src/lib/worker-home.ts:1320-1329` at `94ba42cf`, 10 comment lines.

```
/**
 * The non-darwin analogue of {@link ensureWorkerKeychain}'s refusal half: throw
 * {@link WorkerKeychainError} with a named class BEFORE any worker spawns, so an unusable
 * credential costs a file read rather than a probe worker. Returns the expiry the file states
 * (or `undefined`) so a caller can carry it without re-reading.
 *
 * `read` is injectable for unit tests, but the production default is the real `readFileSync`
 * and the suite drives THAT against real fixture files — a test that only ever supplies its own
 * reader would prove nothing about the path that actually ships.
 */
```

## a token is a credential too

`src/lib/worker-home.ts:1336-1350` at `94ba42cf`, 15 comment lines.

```
  // A TOKEN IS A CREDENTIAL TOO (impl-ED). This guard exists because a credential-dead worker makes
  // zero writes and its $0 death reads as containment UNPROVEN rather than as an auth failure — that
  // reasoning is untouched and the refusal below still fires when NEITHER credential exists. What was
  // wrong was the guard's REACH, not the guard: it tested only for the `/login` file, so it refused
  // every container authenticated the one way a container can be. The CLI's own documented precedence
  // ranks this env var ABOVE the `/login` credential, so a worker holding it is authenticated
  // whatever the file says.
  //
  // EXPIRY IS A KNOWN GAP AND IS DELIBERATELY NOT SOLVED HERE. A bare token carries no
  // `claudeAiOauth.expiresAt`, so {@link extractCredentialExpiryMs} cannot read one and `undefined`
  // is the honest answer rather than a guess. The consequence, stated so it is not rediscovered: the
  // fleet's expiry machinery is BLIND to a token-authenticated worker — it runs for a year and then
  // every dispatch fails at once, with no advance warning from the sidecar classifier or the
  // re-provision path. `apiKeyHelper` is the vendor-documented seam if unattended recovery is ever
  // wanted; building rotation here would be a second concern.
```

## MAX_CREDENTIAL_RECOVERY_ATTEMPTS

`src/lib/worker-home.ts:1363-1369` at `94ba42cf`, 7 comment lines.

```
// W1-T293 arm (6): NO HOT LOOP. A daemon whose LOGIN token is itself dead must not
// re-read it once per spawn forever — module-level (per-boot: resets only on process
// restart, never persisted to disk) so a permanently dead login token escalates ONCE
// per keychainPath, and every later credential-expired call in the SAME boot fails
// fast on the remembered reason class without touching `security` again. Scoped to
// the credential-expired trigger only: arms (1)/(4)/(5) (absent, identity-changed)
// keep their pre-existing, unbounded behavior byte-for-byte — this never bounds those.
```

## the provisioning lock

`src/lib/worker-home.ts:1373-1395` at `94ba42cf`, 23 comment lines.

```
// ── W1-T339: serialize ONLY the provisioning branch, not the whole function ────
//
// WHAT IS SAFE ALREADY (unaffected by this section): the password write above is
// atomic (`wx`) and converges losers onto the winner's password; the steady-state
// read path (present, identity-matching, unexpired store) costs one fs read and two
// IDEMPOTENT `security` calls (`unlock-keychain`/`set-keychain-settings`) that never
// touch this lock at all.
//
// WHAT IS NOT SAFE: the provisioning branch DELETES and recreates the keychain store
// (`rmSync` + `create-keychain` + `add-generic-password`). Two concurrent daemon
// lanes that BOTH decide to (re-)provision the SAME store — a cold-boot racing a
// spawn, or two lanes hitting an identity/expiry change together — would otherwise
// have one lane's `rmSync` pull the store out from under the other mid-write, which
// presents as flaky auth rather than as a lock bug.
//
// SAME SHAPE AS `acquireInflightLock`/`acquireDrainLock` (create-or-fail `wx`, no
// TOCTOU gap, stale-holder reclaim via the shared `reclaimStaleLock` identity check —
// W1-T289) with ONE deliberate difference: those two THROW when a live holder is
// found, because "another instance of the same thing is already running" is meant to
// abort the caller. Here a live holder means "a peer is provisioning THIS keychain
// right now" — the correct action is to WAIT for it and converge on its result, never
// throw and never proceed uncoordinated (this task's design point (iv)). So this lock
// polls instead of failing fast on EEXIST-with-a-live-holder.
```

## acquireKeychainProvisionLock

`src/lib/worker-home.ts:1502-1538` at `94ba42cf`, 37 comment lines.

```
/**
 * Acquire the exclusive provisioning lock for `keychainPath`, WAITING (never letting the caller
 * proceed uncoordinated) while a live peer holds it — but only up to a DEADLINE, past which it
 * throws {@link WorkerKeychainError} naming the holder it waited on.
 *
 * A stale lock — its holder judged dead by the shared {@link isHolderStale} predicate, or its file
 * unreadable/garbage — is reclaimed via the same identity-safe {@link reclaimStaleLock} every
 * other lock in this repo uses, so a crashed provisioner's abandoned lock cannot wedge every later
 * dispatch (W1-T339's design point (v)): the very next call to reach EEXIST on it takes it over.
 *
 * R-3 — TWO DEFECTS, ONE SHAPE: A WAIT WITH NOTHING TO END IT.
 *
 *   (i) STALENESS WAS JUDGED BY `!isPidAlive(held.pid)` ALONE — the pre-W1-T368 predicate every
 *       other lock in this repo has already stopped using. That answers "is SOME process using
 *       this number", never "is it the process that wrote the lock". A provisioner that died
 *       holding the lock, plus a REUSED pid, reads as LIVE forever: the recorded holder can never
 *       become dead again, so nothing here ever reclaims. The lock now runs the SAME
 *       {@link isHolderStale} — host first (rung 1), then pid liveness (rung 2), then the recorded
 *       start time against the live pid's ACTUAL one (rung 3) — as `acquireInflightLock`,
 *       `acquireDrainLock` and `acquireReviewStatusLock`. That is what needed `host` in the lock
 *       payload above, and what makes a reused pid decidable without waiting for a real wrap.
 *
 *  (ii) THE WAIT ITSELF HAD NO BOUND. `ensureWorkerKeychain` is synchronous end to end and is
 *       reached from `daemon.ts`'s boot and from `worker.ts` on every spawn, so this loop's
 *       `Atomics.wait` blocks the daemon's EVENT LOOP, not a task: a lock nothing can reclaim
 *       froze the whole process — no poll ticks, no STOP/PAUSE, and a relaunch queued behind the
 *       same lock on the same path. Rung 1 alone makes the unreclaimable case ORDINARY rather than
 *       exotic (a foreign-host lock is deliberately never reclaimed, and never should be), so the
 *       deadline is not a belt-and-braces addition to (i) — it is what keeps (i)'s correct refusal
 *       to steal a live holder's lock from being a new way to hang. A named throw hands the caller
 *       something it can act on; an unbounded wait hands it nothing at all.
 *
 * THE UNCONTENDED PATH IS UNCHANGED, deliberately: no policy is read, no clock is sampled, and no
 * deadline is computed unless and until this call actually meets a holder judged live. The
 * steady-state majority of calls never even reach this function (see `ensureWorkerKeychain`'s
 * pre-lock gate), and those that do overwhelmingly take the lock on the first `wx`.
 */
```

## ProvisionGate.recordedExpiresAtMs

`src/lib/worker-home.ts:1622-1629` at `94ba42cf`, 8 comment lines.

```
  /**
   * W1-T2398: the sidecar's recorded expiry (epoch ms), parsed independently of the
   * skew comparison above — present whenever the store exists, identity hasn't
   * changed, and the sidecar holds a well-formed number, EVEN when the credential is
   * nowhere near stale. `undefined` when there is nothing to read or nothing
   * parseable — never invented. Lets a caller measure headroom on the steady-state
   * path, where nothing else here touches the sidecar at all.
   */
```

## deriveProvisionGate

`src/lib/worker-home.ts:1633-1641` at `94ba42cf`, 9 comment lines.

```
/**
 * Pure(ish) — reads `identityPath`/`expiryPath` but writes nothing — extraction of
 * the W1-T265 identity gate + W1-T293 expiry gate so it can be evaluated TWICE
 * (W1-T339): once before the provisioning lock (to decide whether this call needs the
 * lock at all — the steady-state majority never does), and again immediately after
 * acquiring it, because a concurrent winner may have already (re-)provisioned while
 * this call was waiting. The second evaluation is what lets a loser CONVERGE on the
 * winner's result instead of redundantly re-provisioning on top of it.
 */
```

## ensureWorkerKeychain

`src/lib/worker-home.ts:1694-1708` at `94ba42cf`, 15 comment lines.

```
/**
 * Guarantee the dedicated worker keychain exists, holds the credential item,
 * never auto-locks, and is UNLOCKED — the invariant a headless spawn needs.
 *
 * Provisioning reads the item out of the login keychain, which therefore must
 * be unlocked AT THAT MOMENT (an interactive session, or the explicit operator
 * provisioning step in this task's PR). It runs on the FIRST call ever
 * (`identityPath`/`keychainPath` absent), and — when `opts.accountId` is
 * supplied (W1-T265) — again on any LATER call whose `accountId` no longer
 * matches the value the store was last provisioned for, e.g. the operator
 * logged the fleet user into a second Anthropic subscription. Every other
 * call — including a cold-boot daemon while the login keychain is LOCKED —
 * touches only the worker keychain. Failures throw {@link WorkerKeychainError}
 * with a named class; the password never rides an error message.
 */
```

## the atomic password create-or-read

`src/lib/worker-home.ts:1713-1719` at `94ba42cf`, 7 comment lines.

```
  // ATOMIC create-or-read (CodeQL alert #71, js/file-system-race): a check-then-act
  // (existsSync → write) let two concurrent first-provisioners (daemon boot racing a
  // spawn) each generate a DIFFERENT password — last writer wins the file, and the
  // keychain ends up keyed to a password the file no longer holds. `flag: "wx"`
  // (O_CREAT|O_EXCL) makes creation exclusive in ONE syscall, mode 0600 applied at
  // create: the loser gets EEXIST and reads the winner's password instead of
  // inventing a second one. No exists() check — there is nothing to go stale.
```

## reading the login keychain item

`src/lib/worker-home.ts:1786-1793` at `94ba42cf`, 8 comment lines.

```
        // Read the item (attributes, then secret) BEFORE creating anything, so a
        // locked/missing credential leaves no half-provisioned keychain behind. The
        // `acct` attribute is copied over UNCHANGED, exactly as before W1-T265 —
        // account-usage.ts measured it to be the OS username, identical across an
        // Anthropic account switch, so it is preserved here as informational
        // provenance only. It is NEVER used for the identity comparison above,
        // which compares `opts.accountId` against `identityPath`'s own sidecar
        // record instead — a separate, purpose-built value.
```

## the last expiry gate

`src/lib/worker-home.ts:1886-1891` at `94ba42cf`, 6 comment lines.

```
  // W1-T2398: the LAST gate, after any (re-)provisioning attempt above has had its
  // chance to fetch a fresher copy — refuse BEFORE this credential is ever unlocked
  // or handed to a spawn, never after. `finalExpiresAtMs` is `undefined` exactly when
  // no numeric expiry is known at all (no sidecar, or a credential that never carried
  // one) — the comparison is skipped rather than inventing a deadline, same discipline
  // as {@link extractCredentialExpiryMs}'s own contract.
```

