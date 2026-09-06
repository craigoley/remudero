# account-usage.ts comment forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/account-usage.ts` when its comments were compacted to the plain-language standard. Every
block below is the removed text verbatim, JSDoc marker characters stripped and nothing else
changed. Headings name the symbol or section the text explained; the code keeps a one-line `Why:`
pointer where the history mattered. Base revision: origin/main at
c185258e295d83d32371612edc2c39bde5d0fd4e; line numbers below are that revision's.

## File header — the module's own doctrine

### Base lines 1-66

```
lib/account-usage.ts — the console's ACCOUNT strip: which Anthropic account the fleet is
spending, and how much of each usage window is gone.

The operator's ask, verbatim in substance: "Can't we have something in the console that will
show which subscription it's using and how much is used?" The console showed neither. It shows
`spend today`/`spend this week` in DOLLARS (glance.ts, ledgered per-run cost) — a notional
API-equivalent figure on a subscription, which is explicitly NOT a window signal (headroom.ts's
own header says so). The thing that actually runs out is the WINDOW, and nothing rendered it.

─── WHY THE LEDGER IS NOT THE USAGE SOURCE ──────────────────────────────────────────────────
The obvious source is `daemon.headroom`, which carries `window`/`percent_used`/`limit_pct`/
`resets_at`. It is the wrong one for USAGE, for two measured reasons:

 1. IT IS WRITTEN ONLY WHILE THE DAEMON IS AWAKE. A paused or stopped fleet writes nothing, so
    the number freezes at whatever the last tick saw and keeps rendering as if current.
 2. IT IS PER-BOOT-ACCOUNT AND CARRIES NO IDENTITY. Measured on this host 2026-07-31: the
    newest `daemon.headroom` line anywhere (live ledger ∪ 661 rotations, 1,243 lines) was
    `14:59:05.671Z … "percent_used": 77`. The operator switched this host's Anthropic account
    the same afternoon, and the account it switched TO reads 2% / 0%. A panel keyed on that
    line would have shown "77% of your week is gone" for an account that had spent nothing —
    confidently wrong, with no field on the line to detect it by.

So usage comes from `~/.claude.json`'s `cachedUsageUtilization`, which carries the two things
the ledger cannot: its OWN `fetchedAtMs` (an honest as-of) and its OWN `accountUuid` (so a
block belonging to a DIFFERENT account is detectable and refused rather than rendered).

WHAT REFRESHES IT, AND HOW STALE IT CAN GET. It is a CACHE written by Claude Code itself —
any Claude Code process on this host refreshes it, which includes the fleet's workers AND the
operator's own interactive sessions. Nothing in remudero writes it and nothing in remudero can
force it. So its worst case is unbounded: a host with no Claude Code activity at all never
refreshes it. That is exactly why {@link USAGE_CACHE_MAX_AGE_MS} exists and why the age is
rendered even when fresh — a number nobody refreshes, presented as current, is worse than no
number, because the operator will act on it.

─── WHAT THIS MEASURES, STATED PLAINLY ──────────────────────────────────────────────────────
COMBINED BURN, not fleet burn. The fleet's workers and the operator's own interactive Claude
Code sessions authenticate as the SAME account and draw down the SAME five-hour and weekly
windows. Neither `cachedUsageUtilization` nor `/usage` attributes consumption to a caller, so
this panel CANNOT say "the fleet spent this" versus "you spent this" — it says "this account
has spent this". The console's existing dollar figures (glance.ts) are the fleet-only half,
because those are ledgered per-run by remudero itself; the percentage here is everything.

─── IDENTITY IS READ FRESH, NEVER CAPTURED AT BOOT ──────────────────────────────────────────
{@link buildAccountUsageRoute}'s handler calls {@link readAccountUsageFile} on EVERY request —
there is no module-level cache, no boot-time capture, and no memoization. An account switch is
therefore visible on the next poll. This is deliberate: the daemon and the console are
long-lived processes (the console has been up for days at a time on this host), so anything
captured once would outlive the fact it describes.

NOT FROM THE KEYCHAIN. `ensureWorkerKeychain` stamps its copied worker keychain with an `acct`
attribute scraped from the login keychain, and on this host that value is the macOS username
(`craigoleyagent`) — identical before and after an Anthropic account switch. It is not a
discriminator, so no keychain-derived value appears anywhere in this module. Nothing here reads
a credential: only `oauthAccount.emailAddress`/`accountUuid`/`organizationName` and the
`cachedUsageUtilization` block are projected out of that file, and the parsed object is
discarded in the same expression — see {@link readAccountUsageFile}.

A NOTE ON `readUsageSnapshot` (run-task.ts), the fleet's OWN reading: it shells
`claude -p "/usage"` with a worker env but WITHOUT a `home:` option, so it reads the OPERATOR'S
login keychain while spawned workers read a copied worker keychain. With one Anthropic account
on the host both resolve to the same identity and the reading is the right one. That stops
being true the moment a second account exists on this host, at which point the governor would
be metering an account the workers are not spending. Flagged here because this panel is where
an operator would first see the disagreement.
```

## CREDIT_STATE_FIELDS

### Base lines 130-149

```
Why the usage half of the panel is UNKNOWN, when it is. Absent ⇒ the reading is good.

W1-T2688 — the credit state, read or refused, never inferred.

A subscription drawing on usage credits drops the prompt-cache lifetime from an hour to five
minutes. Every rung here reuses long prefixes, so cost per task moves for a reason no row
explains.

TRAP: the surface may not expose the state at all. The captured block
(test/fixtures/account-usage/claude-json.json) carries the utilization windows and no credit,
billing, plan or subscription field. So an absent field reads `not-exposed` — loud, in the shape
{@link UsageUnknownReason} already uses — and an unknown value reads `unrecognised-value`. A
credit state guessed from window utilisation would move policy on an inference.

Policy is out of scope: what to do when credits engage is an operator ruling. Nothing here
changes a mount, holds a dispatch, or reads a policy.

FALSIFIER: test/the-fleet-cannot-tell-it-has-crossed-into-credits.test.ts.
```

## DispatchGovernorState

### Base lines 261-278

```
Whether a DISPATCH-DEFERRING governor (the cost ceiling or the WIP/queue ceiling) is currently
holding back NEW dispatch, per the fleet's own newest heartbeat for that governor (W1-T329,
OPERATOR COMPLAINT 2026-08-04: the fleet deferred every dispatch for ~40 minutes at $152.28
against a $150 ceiling and the console said only "nothing in flight").

ONLY TWO STATES, DELIBERATELY — there is no "clear"/"under-ceiling" third state to derive.
Unlike `daemon.headroom` (written on EVERY tick, deferring or not, so its `enforced` field is a
real tri-state), `daemon.cost_governor`/`daemon.queue_governor` (daemon.ts) are written ONLY
while that governor is actively deferring — no line ever states "not deferring". So the only
two honest answers are "the newest deferral we've seen" and "we've never seen one", and the
second one must NEVER be presented as healthy: `GovernorState`'s own doc already establishes
why absent must not collapse into a healthy-looking default ("would report an armed-and-
breaching governor as telemetry-only") — the identical hazard here would report a governor
that has idled the whole fleet for hours as indistinguishable from one comfortably under
ceiling.
```

## deriveGovernorPosture

### Base lines 495-506

```
The governor's posture from the NEWEST `daemon.headroom` ledger line.

`enforced` is read as a TRI-STATE, not a boolean: `true` ⇒ armed, `false` ⇒ telemetry-only,
and ABSENT ⇒ unknown. The absent case is real history, not a hypothetical — of 1,243
`daemon.headroom` lines on this host, 922 carry `enforced: false` and 321 carry no `enforced`
key at all (they were written by the pre-symmetry over-ceiling branch, which never set it).
Mapping absent to `false` would report an armed-and-breaching governor as telemetry-only.

Ordering is by PARSED `ts`, never by ledger order, for the same reason `deriveLastPoll`
(daemon-health.ts) does it that way.
```

## AccountUsageProjection — the W1-T2516 defect and remedy

### Base lines 633-662

```
W1-T2516: THE DEFECT THIS CLOSES. Every worker's HOME is redirected to a Remudero-controlled
scratch dir (worker-home.ts), so the `cachedUsageUtilization` a worker's OWN Claude Code
invocation refreshes lands inside THAT scratch home — never inside `homedir()/.claude.json`,
the file {@link readAccountUsageFile} reads by default. `reapWorkerHome` (worker-home.ts)
deletes the scratch home moments after the spawn ends. On a genuinely headless fleet host —
where the ONLY Claude Code processes that ever run are the fleet's own workers — nothing ever
refreshes `homedir()/.claude.json`, which is exactly the "worst case" this module's own header
already named in the abstract ("a host with no Claude Code activity at all never refreshes
it"): HOME redirection turns that worst case into the permanent, steady state.

THE REMEDY. worker.ts's `captureWorkerUsageProjection` reads the worker's own
`.claude.json` and persists a NARROW projection — percent, resets_at, the cache's OWN
`accountUuid`, and `fetchedAtMs`; deliberately never `email`/`org`, see this interface's own
field list — to {@link accountUsageProjectionPath} BEFORE `reapWorkerHome` deletes the home
that produced it (the reap seam is in worker.ts, not this file — see that module's own doc
for why an import here would close an import cycle). {@link mergeAccountUsageProjection}
folds that projection into the PRIMARY (`homedir()`) reading, so a reading now SURVIVES the
reap of the worker home that produced it.

IDENTITY STAYS OUT OF SCOPE, DELIBERATELY. `email`/`uuid`/`org` are never captured into the
projection and are always carried through from `primary` untouched by
{@link mergeAccountUsageProjection} — this module's "identity is read fresh, never captured
at boot" doctrine (see this file's header) applies here too: a projection captured once at a
worker's teardown must never stand in for a live identity read, or an account switch since
that capture would go undetected. `cacheUuid` IS still carried, precisely so
{@link usageUnknownReason}'s existing account-mismatch guard keeps comparing it against that
live identity, exactly as it already does for a same-process reading — a projection captured
under a since-switched-away-from account is still refused, never rendered.
```

## AccountUsageDeps — field seams

### Base lines 840-867 (`root`, `policy`, `resolveCeiling`, `readUsageProjection`)

```
W1-T333: repo/workspace root for `resolveDailyCostCeiling`'s `state/` override lookup — the
SAME root every other console write surface already resolves `state/` against
(fleet-control's PAUSE flag, `policy.ts`'s own `DAILY_COST_CEILING_OVERRIDE`). Defaults to
`deps.fleetControlRoot` when `rmd serve`'s own wiring (serve.ts's `buildServeRoutes`) doesn't
override it.

Injectable, the same `deps.policy ??` seam `run-task.ts`'s `dailyCostCeilingReloader`/
`retroTriggerCheck`/`autoTriageCheck` already use for the identical reason
(test/config-reader-seams.test.ts's structural lock) — a test supplies a fixture `Policy`
without touching the installed `plan/policy.yaml`.

Injectable resolver — defaults to the real `resolveDailyCostCeiling(root, policy)` so a test
can inject a captured {@link EffectiveDailyCostCeiling} directly, without constructing a
`Policy` or touching `state/` on disk, the same "the assembler wires the real thing, a test
injects a fake" split every other optional field here already follows.

W1-T2516: injectable reader for the persisted worker-capture projection (see
{@link AccountUsageProjection}) — same "an assembler wires the real thing, a test injects
a fake" seam every other optional field on this type already follows. Omitted ⇒ the real
`readAccountUsageProjection(accountUsageProjectionPath(deps.root))` when `root` is set, or
no projection consulted at all when `root` is unset — an install that never supplies
`root` (every pre-W1-T333 caller of this type) renders BYTE-IDENTICAL to before this task.
```

## buildAccountUsageRoute

### Base lines 873-877 (doc) and 887-893 (handler comment)

```
`GET /v1/account-usage` — read-scoped, computed FRESH PER REQUEST. No cache, no memoization,
no boot capture: that is what makes an account switch visible on the next poll rather than on
the next daemon restart (see this module's header).

W1-T2516: fold in whatever a worker's own teardown persisted BEFORE its scratch home
was reaped — see AccountUsageProjection's doc for why this survives what the primary
`homedir()` read alone cannot on a headless fleet host. `deps.root` unset (every
pre-W1-T333 caller) ⇒ no projection is even looked for, byte-identical to before.
```

## deriveAccountUsage

### Base lines 391-412

```
The panel's projection. PURE: no clock of its own, no filesystem, no ledger read — every input
is passed in, so the whole staleness/mismatch policy is testable against a captured reading.

THE THREE WAYS USAGE GOES UNKNOWN, in the order they are checked:
  1. `unreadable` — the file was missing or unparseable. Nothing is known.
  2. `no-cache` — the file parsed but carries no `fetchedAtMs`, so the reading has no as-of and
     cannot be aged. An un-ageable reading is exactly the "value nobody refreshes" hazard.
  3. `account-mismatch` — the cached block's `accountUuid` is not the account currently logged
     in. THIS IS THE ACCOUNT-SWITCH GUARD: after a switch the cache still holds the previous
     account's percentages until some Claude Code process rewrites it, and rendering those
     against the new account's name is the precise failure this panel exists to avoid.
  4. `too-old` — older than {@link USAGE_CACHE_MAX_AGE_MS}.

Identity is returned in every case (it comes from a different part of the file and is fresh),
so the panel can always answer "which account" even when it cannot answer "how much".

`ceiling` (W1-T333) is OPTIONAL and orthogonal to every check above: it is the daily cost
ceiling's effective value + provenance (`policy.ts`'s `resolveDailyCostCeiling`), passed in
fresh per request by the real route so a test — or a caller that only cares about usage/
governor — can omit it entirely rather than construct one.
```

(The type is named "THE THREE WAYS" in the removed prose while four are listed — an inherited
inconsistency in the original comment, kept verbatim per this page's own rule.)

## AccountUsageSnapshot — field docs

### Base lines 319-321 (`creditState`)

```
W1-T2688 — subscription vs usage credits. A SEPARATE axis from `usageUnknownReason`: the
windows can be readable while the credit state is not exposed; collapsing the two would
make a readable panel claim the credit state was unreadable too.
```

### Base lines 336-337 (`costGovernorObservedUsd`)

```
The day's ledgered cost that produced the deferral, present only while `costGovernor` is
"deferred" — RENDER THE NUMBER, NOT JUST THE FLAG ("$152.28 of $150" is actionable).
```

### Base lines 351-358 (`dailyCostCeilingUsd`)

```
W1-T333: the daily cost ceiling's EFFECTIVE value, never the bare number — see
`policy.ts`'s `resolveDailyCostCeiling` for the precedence rule (a `state/` override wins;
absence means the committed `plan/policy.yaml` default). Present iff a resolver was supplied
(the real route always supplies one; a caller of {@link deriveAccountUsage} that omits it —
every pre-W1-T333 test in this file — simply renders no ceiling, exactly like every other
optional slot here when its own source was never read).
```

### Base lines 362-369 (`dailyCostCeilingDefaultUsd`, `dailyCostCeilingFallbackReason`)

```
`policy.values.sweep.dailyCostCeilingUsd` — carried alongside `dailyCostCeilingUsd` so an
overridden reading shows both the effective figure and what it was overridden FROM (design
note i: "so a reader can see it was changed and from what").

Present only when a stored override existed but was refused (malformed/out of bound) and
the reading fell back to the committed default — see
`policy.ts`'s `EffectiveDailyCostCeiling.fallback`.
```

### Base lines 370-379 (`dailyCostCeilingAuditAsOf` and siblings)

```
W1-T333: the newest console write's audit trail — who/when/from/to and the resulting
effective value, read off the newest `console.ceiling_override_written` ledger line (see
{@link deriveCeilingOverrideAudit}). Absent iff no such line has ever been ledgered, which is
what makes "at default because never overridden" distinguishable from "at default because a
real override just vanished" (the store's own documented DISAPPEARANCE CASE) — the store
ALONE cannot tell those apart, because both read `dailyCostCeilingProvenance: "default"` with
no `dailyCostCeilingFallbackReason`; only the ledger's independent write history can.
```
