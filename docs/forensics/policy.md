# policy.ts comment forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/policy.ts` when its comments were compacted to the plain-language standard. Every block
below is the removed text verbatim, JSDoc marker characters stripped and nothing else changed.
Headings name the symbol or section the text explained; the code keeps a one-line `Why:` pointer
where the history mattered. Base revision: origin/main at 49e429e305c662712b2ee5d653613357a2e03c40;
line numbers below are that revision's.

## Module header

### Base lines 7-37

The fleet's operating-constants policy, loaded as DATA (W1-T252, P37 SUBSTRATE — the P34
ruling that the operating envelope belongs in policy data, not scattered source literals).
SAME load-and-validate house pattern `src/lib/mounts.ts`/`src/lib/alert-lane.ts` already use:
parse with the `yaml` package, validate into a typed shape, throw a named error on any
structural or semantic violation — never a second, ad hoc loader.

THIS MODULE IS THE SUBSTRATE ONLY (files: plan/policy.yaml, src/lib/policy.ts,
test/policy.test.ts — W1-T252). No consumer site reads from {@link loadPolicy} yet;
W1-T253 (P37 CONSUMERS, depends_on this task) rewires review.ts/worker.ts/daemon.ts/
sweep.ts/drain.ts/launchd.ts to read every field below instead of their current source
literals. `loadPolicy` is deterministic and pure (two loads of the same file yield
identical values) so that rewiring is a drop-in read, not a new I/O shape to design.

PROVENANCE, per field (`origin`): every LIFTED field's YAML row carries `lifted:<src-site>`
naming the exact current-source constant it was copied from (verified against source at
authoring time, OPERATOR RULING 2026-07-23) — {@link EXPECTED_ORIGIN_KIND} pins each named
field to the kind (`lifted` or `net-new`) it is REQUIRED to carry, so a fixture cannot
silently relabel a lifted constant as net-new (hiding its real source) or a net-new field
as lifted (inventing a source that never existed) — both directions are checked, by name,
at load. `launchd.throttleIntervalS` is the ONE net-new field this file carries: no
`ThrottleInterval` literal exists in `src/lib/launchd.ts`'s daemon-unit generator today.

BOUNDS: every numeric field's YAML row carries `min`/`max` traveling WITH the value — an
out-of-bounds `value` is refused at load, named by field, so a value change rides a
reviewed plan PR (the bound is legible in the diff) rather than an unbounded edit. THE 30000
REGRESSION (operator ruling, binding): `proofTimeoutMs.min` is pinned to 60000 — the value
already live at `src/lib/review.ts:675` — so a policy carrying the stale, pre-merge 30000
proof-timeout figure fails this ordinary bound check for exactly the reason it must: it is a
regression below the live source value, never a merely-smaller tuning choice.

## ArmCalibrationBandRow

### Base lines 46-59

One OPERATOR-RATIFIED row of {@link PolicyValues.armCalibrationBands} (W1-T2579) — see that
field's own doc for the seam this feeds. `class` names a {@link
import("./verdict-calibration.js").VerdictClass} `decideAutoMergeArm` (src/lib/review.ts) may
band: only `"full-pass"`/`"keyword-floor"` are ever consulted — `"degraded-arm"` (the CAPPED
class) is refused eligibility BY CONSTRUCTION, at the call site, never by validation here, so
a row naming it simply never matches anything. `verdict: "hold"` refuses the arm; `"notify"`
arms and carries `note` in the decision reason. Loaded STRICTLY (a row that fails this shape
check throws {@link PolicyError} at load, same as every other policy row) — the fail-INERT
half of this feature lives entirely in `decideAutoMergeArm`'s own runtime consult (a
shape-valid row naming a class the caller does not resolve, or a bands array injected directly
by a caller that bypassed this loader, is what stays inert there), not in tolerating a
malformed COMMITTED ratification.

## sweepWallClockBoundMs

### Base lines 87-94

W1-T1044: the WALL-CLOCK BOUND (ms) on `await deps.sweep()` (daemon.ts's poll loop) — see
this field's plan/policy.yaml row for the measured healthy-vs-hung derivation. W1-T1219
split ONE fix-rung worker spawn inside `runFixRung` (run-task.ts) OFF this field onto its
own {@link PolicyValues.fixSpawnWallClockBoundMs} row — a sweep tick and an implement-class
worker spawn are different populations (see that field's own doc), so retuning one must
never move the other. OPTIONAL in the committed row (same absent-means-default shape as
{@link PolicyValues.autoTriage}): an existing policy.yaml missing this row resolves to
{@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}.

## fixSpawnWallClockBoundMs

### Base lines 96-104

W1-T1219: the WALL-CLOCK BOUND (ms) on ONE fix-rung worker spawn inside `runFixRung`
(run-task.ts) — split OFF {@link PolicyValues.sweepWallClockBoundMs}: a sweep tick (a
poll-loop classification pass over an already-fetched rollup) and a fix-rung spawn (an
implement-class Claude worker that reads a diff, edits source and commits) are different
populations, so one policy row can no longer bound both. See this field's plan/policy.yaml
row for why the committed value is INTERIM — the population needed to derive the real one
could not be measured until this same task started recording it. OPTIONAL in the committed
row (same absent-means-default shape as {@link PolicyValues.autoTriage}): an existing
policy.yaml missing this row resolves to {@link DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS}.

## keychainProvisionLockWaitMs

### Base lines 106-115

R-3: the WAIT DEADLINE (ms) on `acquireKeychainProvisionLock` (src/lib/worker-home.ts) —
how long a call may wait on a provisioning lock whose holder is judged LIVE before it gives
up and throws `WorkerKeychainError` (`keychain-provision-lock-timeout`) naming that holder.
That wait is fully SYNCHRONOUS (`Atomics.wait`, never `await`) and is reached from the
daemon's own boot and from every worker spawn, so an unbounded one froze the daemon's event
loop outright. See plan/policy.yaml's own row for why no contended-wait population exists to
derive this from and what the value is anchored on instead. OPTIONAL in the committed row
(same absent-means-default shape as {@link PolicyValues.sweepWallClockBoundMs}): an existing
policy.yaml missing this row resolves to {@link DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS}.

## sweep block: tmpMaxAgeMs, dailyCostCeilingUsd, armSessionPrs, repairFiling*, supersessionDisposal

### Base lines 120-153

tmpMaxAgeMs — W1-T320: the rmd-owned temp-dir backstop's age ceiling (src/lib/tmp.ts's
sweepStaleTempDirs) — see this field's plan/policy.yaml row for the incident that made the
ceiling policy data instead of a source literal.

dailyCostCeilingUsd — W1-T330: the daily spend ceiling (W1-T148 COST GOVERNOR) — see this
field's plan/policy.yaml row for the incident that made retuning it a plan PR instead of a
src/ edit + CI + deploy. A RELOCATION of the pre-existing source literal, not a retune.

armSessionPrs — W1-T516: gates whether the SWEEP arms a PR that carries no plan task id (a
session filing) under the same synthetic `PR-<n>` id the review/escalation lanes already mint
(`escalationTaskIdFor`). DEFAULT OFF — see this field's plan/policy.yaml row for what
turning it on actually admits (a capped, plan-only PR merges on structural checks
alone, with zero executed proofs). NET-NEW: no prior source literal ever gated this;
the sweep's arm dep simply passed `pr.taskId` raw.

repairFilingThreshold — W1-T905: the RECURRENCE count — a classified surface (a
`sweep.disposed` row's own `disposition`) that a `sweep.disposed acted: true` row names at
least this many DISTINCT PRs for, inside {@link PolicyValues.sweep.repairFilingWindowDays},
is due for exactly ONE `repair#<surface>` §7B feedback entry — "one occurrence is a repair, a
recurrence is a defect." NET-NEW: no prior source literal ever counted this.

repairFilingWindowDays — W1-T905: the RECURRENCE window (days) {@link
PolicyValues.sweep.repairFilingThreshold} counts distinct-PR repairs within — see that
field's doc. NET-NEW.

supersessionDisposal — W1-T920: gates the SUPERSESSION disposition (lib/sweep.ts's
`DISPOSITION_RULES`, the `pr.supersessionVerdict.status === "superseded"` row) — DEFAULT OFF,
copying `armSessionPrs`'s own shape immediately above. See this field's plan/policy.yaml row
for why the off path is byte-for-byte today's behaviour and why turning it on still
changes nothing in production until a (separate, out-of-scope) detector populates
`OpenPrView.supersessionVerdict`. NET-NEW: no prior source literal ever gated this.

## sweep.memoryFloorMib

### Base lines 154-161

W1-T1038: the DISPATCH-PATH memory floor, in MiB of `/proc/meminfo`'s `MemAvailable` —
below this figure, NEW dispatch is deferred; drainage is never gated (the same
dispatch-only asymmetry every other field in this table already documents). SHIPS AT 0
(see this field's own plan/policy.yaml row): `MemAvailable` can never read below zero, so
the shipped default defers nothing until an operator raises it against a measured figure —
the 2026-08-19 host stall's own rationale is explicit that no such figure exists yet.
See {@link checkMemoryGovernor}, this row's consumer (sweep.ts).

## autoTriage

### Base lines 173-177

The daemon's auto-triage rung (recon-DC #2). DEFAULT OFF — it spends unsupervised.
W1-T475 deleted the W1-T318 adaptive-cadence curve (`maxIntervalMinutes`/`depthFloor`/
`depthCeiling`): it was a second, weaker governor on the quantity `maxPerDay` already bounds
exactly, keyed to a depth proxy uncorrelated with capacity. `minIntervalMinutes` survives as
the fixed floor — it used to reach the decision ONLY through that curve.

## measurementCadence

### Base lines 183-191

W1-T1259: the daemon's measurement-cadence rung — `rule-efficacy`, `verdict-calibration`
and `autonomy-rate` were merged, host-side, and reachable only by an operator typing them.
OPTIONAL, absent-means-default like {@link PolicyValues.autoTriage}, but the DEFAULT here
is the SAFE mode already ON (`enabled: true`) — unlike autoTriage, which spends
unsupervised, the base cadence runs only read-only reports (`verdict-calibration`/
`autonomy-rate` carry no write symbol at all; `rule-efficacy` runs its `--no-escalate`
form). `escalate` is the SEPARATE, opted-in flag for `rule-efficacy`'s ONE write (a
promote-to-instrument proposal, never a filed task — Law 5) and ships OFF, mirroring
`autoTriage.enabled`'s own off-by-default posture for anything that writes.

## digestCadence

### Base lines 198-204

W1-T2277: the daemon's digest cadence rung — its OWN row, deliberately separate from
{@link PolicyValues.measurementCadence} above, so a short digest interval can never drag
`rule-efficacy`/`verdict-calibration`/`autonomy-rate` to it (or vice versa). No `escalate`
field: the digest only reads and sends, it never drafts a proposal. OPTIONAL, same
absent-means-default shape as `measurementCadence`, defaulting to the SAFE always-on daily
cadence (`enabled: true`, once per day) — sending a digest spends nothing and writes
nothing (Law 5), so it is safe to run unattended from the start.

## boardReview

### Base lines 210-231

W1-T2304's board-review rung — its OWN row, deliberately separate from
{@link PolicyValues.measurementCadence} and {@link PolicyValues.digestCadence}, so the three
cadences can never drag one another. No `escalate` field: this rung drafts proposals through
the registry unconditionally when it finds something, and drafting a proposal is the whole
point of the rung rather than an opt-in side effect.

THE VALUES ARE DERIVED, not copied from a sibling. `minIntervalMinutes: 120` is read off the
board's own behaviour: on 2026-08-26 the depth trigger was continuously satisfied for 2h26m
(#2895 aged past the 8h bar at 08:55Z and stayed open until 16:20:51Z, with two reds landing
inside the same stretch). At 120m that stretch yields TWO reports — one when the condition
appears and one confirming it persisted — rather than one per poll, which for a condition an
operator can only act on every hour or so is noise, not signal. `maxPerDay: 6` bounds a
pathological day (a board red from morning to night) to twelve hours of coverage at that
interval and caps the cost at six whole-board reads. Both sit deliberately between
`measurementCadence` (360m / 4, a heavy ledger+git join over history that moves slowly) and a
per-tick check: the board changes faster than the ledger's shape does, and slower than a poll.

ABSENT ⇒ the same safe defaults, matching every other cadence's absent-means-default shape.
Defaults to ENABLED because the rung is read-only: it writes one report artifact and drafts
registry proposals, and nothing it produces files a task ITSELF — the rung's own scope, not a
rule forbidding it. W1-T2456: this said "Rule 15 still stands"; §12 rule 15 is the
acceptance-criteria goalpost rule and rule 27 now PERMITS automatic filing.

## worktreeReapBoot

### Base lines 251-256

W1-T406: the one-shot `rmd run-task` boot rung for {@link reapStaleWorktrees} — same
ship-off posture as {@link PolicyValues.scratchReap}, and for the same reason: it
DELETES, so it begins OFF, surveying and ledgering what it would reclaim until an
operator has read enough boots' worth of dispositions to arm it. No age field of its
own — the rung reuses {@link DEFAULT_WORKTREE_REAP_GRACE_MS} (`worktreeReapGraceMs`
above), the SAME ceiling the daemon poll / `rmd sweep` call sites already use.

## githubEventWake

### Base lines 260-266

W1-T2568: the GitHub-event wake's bounded recent-delivery dedup window (see
`github-event-wake.ts`'s `createDeliveryDedupStore`) — how many distinct `X-GitHub-Delivery`
ids the webhook route remembers before evicting the oldest. THE bounded row design (iv)
calls for ("the debounce is a bounded plan/policy.yaml row, not a literal beside
fs.watch"): a redelivery/replay burst is refused as a duplicate only while its delivery id
is still in this window, so the bound is a real, reviewed tuning knob, not a source
literal. OPTIONAL, absent-means-default like {@link PolicyValues.sweepWallClockBoundMs}.

## PolicyValues.armCalibrationBands

### Base lines 272-284

W1-T2579 — THE ARM GATE'S OPERATOR-RATIFIED BAND TABLE. `decideAutoMergeArm`
(src/lib/review.ts) consults this AFTER its existing refusals, on the already-arming
`full-pass`/`keyword-floor` path only — it can hold or annotate what today arms, never
arm what today refuses (the CAPPED class and the operator-override path are evaluated
before this table and are untouchable by it). SHIPS EMPTY, deliberately (design (iv)):
`verdict-calibration.ts` (W1-T424) and `measurement_cadence` (W1-T1259) MEASURE per-class
outcomes but never WRITE this table — a figure reaches a band only through a plan PR an
operator merges. OPTIONAL, same absent-means-default shape as every other cadence row in
this file, but the default is `[]` (not a triplet) — an absent table and an empty table are
BYTE-IDENTICAL to no table at all, the fail-inert contract this row's whole existence rests
on (test/arm-calibration-bands.test.ts).

## numberField — the finite-bound trap

### Base lines 435-440

FINITE, not merely `typeof === "number"`: YAML's `.nan`/`.inf` parse to NaN/Infinity, and a
NaN bound makes EVERY comparison below false — `min > max`, `value < min`, `value > max` — so
the declared bound silently stops binding and any value is accepted. That is not a theoretical
hole: with `proofTimeoutMs.min: .nan` a policy carrying the stale 30000 proof timeout loads
clean, which is exactly the regression the operator's binding ruling says must be refused. A
bound that cannot bind is a malformed bound, so it is refused here by name.

## validateHeadroomCurve — the NaN/Infinity rung trap

### Base lines 495-501

Number.isFinite, not `typeof === "number"`, for the SAME reason numberField above needs it:
NaN passes every range test by failing every comparison. A `maxHoursToReset: .nan` rung would
load clean and then never match in resolveHeadroomLimitPct's `hoursToReset <= r.maxHours`
(a silently dead rung); a `limitPct: .nan` would load clean and yield a NaN CEILING, which
every headroom comparison then silently fails. Infinity is refused here too: `null` is the
only spelling of the catch-all rung this schema accepts (see the final-rung check below), so
an `Infinity` rung in a non-final position would swallow every rung after it.

## Default constants — the absent-means-default shape

### Base lines 554-606

Six exported/module constants (`DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS`,
`DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS`, `DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS`,
`DEFAULT_GITHUB_EVENT_WAKE_DEDUP_CAPACITY`, `DEFAULT_GITHUB_EVENT_WAKE_CHECK_SETTLE_MS`) each
carried a repeated 5-9 line doc restating the same rule: the constant mirrors plan/policy.yaml's
own row (derivation lives there) and is used ONLY when that row is ABSENT from loaded YAML, so a
policy.yaml fixture that predates the field keeps loading clean instead of failing on a missing
mapping. `DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS` and `DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS`
are additionally EXPORTED because they are a consumer's own fallback: `spawnFixWorkerBounded`
(run-task.ts) needs one when a caller supplies no `deps.spawnWallClockBoundMs`, and
`acquireKeychainProvisionLock` (worker-home.ts) needs the other on the one path where the
committed policy cannot be read at all — the daemon's boot path, where a checkout with no
readable plan/policy.yaml must still wait with a deadline rather than freeze unbounded.

## installPolicyPath

### Base lines 823-832

Absolute path to THIS INSTALLATION's `plan/policy.yaml`, resolved from this module's own
file location — never from `process.cwd()` or an ambient repoRoot. `src/lib/policy.ts` sits
two directories under the repo root, so a leaf consumer with no `repoRoot` parameter of its
own (review.ts, worker.ts, daemon.ts, sweep.ts, drain.ts, launchd.ts — W1-T253's CONSUMER
sites) can still resolve the SAME `plan/policy.yaml` `rmd`'s own CLI entry point resolves
(`run-task.ts`'s `resolveRepoRoot`), regardless of the invoking shell's cwd. Mirrors that
same function's own `import.meta.url`-based install-root fallback — same technique, same
module-boundary reasoning, not a new pattern introduced by this file.

## The daily-cost-ceiling override store

### Base lines 852-880

OPERATOR RULING 2026-08-04: a runtime-tunable value belongs in a store the console can write
at runtime, not in `plan/policy.yaml` behind a PR and a deploy — a console write TO the
committed file must commit to survive, which reintroduces the PR the ruling removes, and an
UNCOMMITTED edit is actively destroyed by the deploy's `pull --ff-only` (it happened this
week, and took an operator kill switch with it).

THE PRECEDENT: `fleet-control.ts`'s `state/PAUSE` — a flag file under `<root>/state/`,
outside git (`.gitignore` carries `state/`), surviving every `pull --ff-only`. This reuses
that exact mechanism for one value: the daily cost ceiling.

ONE VALUE, ONE STORE, ONE PRECEDENCE RULE: an override under `state/` wins; its ABSENCE means
the committed `plan/policy.yaml` default — no merging, no partial objects. Bounds are never
duplicated: a write is validated against `policy.bounds["sweep.dailyCostCeilingUsd"]`, the
SAME committed row `validatePolicy` already parsed, never a second hand-copied `{min, max}`.
A malformed/unreadable override (bad JSON, missing/non-numeric `usd`, or a value the
committed row no longer bounds — the row itself can change bound on a later PR) FALLS BACK to
the committed default and REPORTS why, via {@link EffectiveDailyCostCeiling.fallback} — never
silently read as zero, unbounded, or absent-and-fine.

THE DISAPPEARANCE CASE (design note v): `state/` is deliberately outside git, so a wiped
state root reverts every override to its committed default with NO error and NO missing-file
surprise — that is by design (absence IS the "at default" case). But it means "at default
because never overridden" and "at default because a real override just vanished" are NOT
representable by THIS store alone — both read back identically here, `provenance: "default"`
with no `fallback`. Distinguishing them is deliberately W1-T333's job: THE LEDGER, not this
file, is where "was this ever overridden" survives a `state/` wipe, because `state/` is
exactly the thing that can disappear.

## resolveDailyCostCeiling — the ENOENT case

### Base lines 988-990

No override was ever written (or one was written and the state/ root vanished) — the
ABSENCE case (design note ii): reads as the committed default, no fallback report,
because absence is not a malformed override — it is the precedence rule's other arm.

## The per-instance share (W1-T408)

### Base lines 1040-1074

W1-T408 — THE PER-INSTANCE SHARE (the daily ceiling is per instance, not per fleet). Two
containers each reading `resolveDailyCostCeiling` independently both stop politely at the
SAME committed 500, and the bill is 1000 — each is correct about its OWN ledger and neither
can see the other (plan/tasks.d/W1-T408-…: "NOTHING LOOKS WRONG FROM INSIDE EITHER
CONTAINER"). This is deliberately NOT cross-instance coordination (there is no shared dollar
figure anywhere — see that task file's rationale for the two independent reasons the account
usage surface cannot serve this ceiling) — it is a per-instance knob the OPERATOR divides:
running N containers against one 500 ceiling, the operator sets each to a configured SHARE
(e.g. 250 each) so the fleet's real total matches what one instance used to spend alone.

ENV, NOT A FILE: `state/DAILY_COST_CEILING_OVERRIDE` (above) retunes what the ceiling IS,
shared identically by every reader of the SAME `state/` directory. A share answers a
different question — "what is THIS INSTANCE's portion" — and env is inherently
per-process/per-container already, needing no new per-instance directory the way a file
would (`state/` itself is already instance-scoped only because it is homed under HOME —
see run-task.ts's `repoRoot`/`config.root` chain — an incidental fact of this deployment's
layout, not something a share should depend on).

A CONFIGURED SHARE WINS OUTRIGHT, over both the committed default AND a written override —
it is the MOST specific, most local setting available, and the operator who sets an
instance's share has already made the coarser two irrelevant to that instance's own
enforcement. It does not merge with them (an instance's effective ceiling is one number).

UNSET BEHAVES EXACTLY AS TODAY (acceptance: test/cost-ceiling-default-unchanged.test.ts):
`resolveDailyCostCeilingInstanceShare` returns `undefined` when the env var is absent, blank,
non-numeric, or out of the committed bound, and `resolveDailyCostCeilingForInstance` returns
`resolveDailyCostCeiling`'s own result UNCHANGED whenever that happens — a single-instance
operator who never sets the env var sees no change of any kind, byte for byte.

WHAT THIS DOES NOT DO (recorded, not hidden): nothing stops an operator setting two
instances to 500 each, and nothing detects that they did — there is still no shared figure,
so there is nothing to check a share against. The fix makes the arithmetic CORRECT and
VISIBLE when the operator divides it; it does not, and cannot, ENFORCE the division.
