# fs-race-safe.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/fs-race-safe.ts` when its comments were compacted to the plain-language standard. Every
block below is the removed text verbatim, marker characters stripped and nothing else changed.
Headings name the symbol the text explained; the code keeps a one-line `// Why:` pointer where the
history mattered. Base revision: origin/main at 9391ac5647ed0c337eeedffd5ff7525a5d5022f9; the line
numbers below are that revision's.

## Module header

### Base lines 6-38 — The `js/file-system-race`-safe idiom…

The `js/file-system-race`-safe idiom this repo has now shipped for a state file that is
created ONCE and read on every later call (config.ts's `loadConfig`, worker-home.ts's
`ensureWorkerKeychain`, and — via this shared helper — serve.ts's `resolveServiceTokens`).
CodeQL alerts #15/#16 (round 1), #24 (round 2), #71 (round 3), and #60/#61 (round 4, this
task) all trace back to the SAME check-then-act shape at a different call site:
`existsSync`-then-write on create, or a bare `readFileSync(path, ...)` re-checking the path
string on the fallback read. Folding create-or-read into ONE shared helper means a future
"first boot writes a state file" site reuses tested code instead of open-coding a fifth copy.

Attempts an exclusive `O_CREAT|O_EXCL` ("wx") open at `path` in ONE syscall — no separate
existence check that a second process could race between check and write. On success, the
open file descriptor is handed back (`created: true`) so the CALLER writes its own freshly
generated content through that SAME descriptor — never a path re-open, so there is no window
where a later syscall could re-resolve `path` to something else. The caller owns closing it.

On EEXIST — the file already exists, whether a concurrent first-provisioner won the race or
this is simply the second-and-later boot — this reads it back through a FRESH read descriptor
(`openSync(path, "r")` + `readFileSync(fd, ...)`), never `existsSync`-then-`readFileSync(path,
...)`. Reading through the descriptor rather than re-checking the path is what the CodeQL
query's own recommendation asks for on the READ itself.

BUT THE FALLBACK READ DOES RE-RESOLVE THE PATH, and an earlier revision of this header claimed
otherwise. `openSync(path, "r")` resolves `path` by name a second time, so the sequence
"`wx` proved it exists" → "open it" is a genuine check-then-act window: a peer that unlinks in
between made this helper throw ENOENT out of the very function meant to make the sequence
safe. CodeQL flagged exactly that (alert #84, `js/file-system-race`, on the fallback read) and
it was RIGHT. `createOrReadExclusive` therefore RETRIES rather than asserting the window
away — see its body. The flag is answered with code, not with a dismissal.

Any other open error (e.g. `EISDIR` from a misconfigured path) propagates unchanged — it is
never swallowed as if it were a benign race.

## readFileIfExists

### Base lines 98-106 — Read a file's contents, or…

Read a file's contents, or `undefined` if it doesn't exist — a single `readFileSync` guarded
by a catch on `ENOENT`, NOT a separate `existsSync` check-then-read (the latter is the same
`js/file-system-race` TOCTOU shape as the create side: a second process can create or delete
the file between the check and the read). This is the ONE shared helper for "read this state
file if it happens to exist yet" call sites — relocated here from `src/run-task.ts`, which had
it as a private function, so future callers reuse it instead of open-coding another private
copy (a second one had already appeared, independently, in `src/lib/panel-graph.ts`).

## reclaimStaleLock banner

### Base lines 116-125 — reclaimStaleLock: the ONE shared…

reclaimStaleLock: the ONE shared "read a dead-holder lock and clear it" idiom.

W1-T289. Four call sites (inflight-lock.ts, drain-lock.ts, review.ts's mutex, and the
boot sweep in inflight-lock.ts) each did the same shape: read a lock, decide its holder
is dead, then `unlinkSync(lockPath)` UNCONDITIONALLY. The create half of these locks is
genuinely atomic (`O_EXCL`), but that unlink is a SEPARATE syscall conditioned on
NOTHING — not on the file still being the same dead lock that was just read. Two
reclaimers of one dead lock could both decide "stale"; the first to unlink+recreate wins
a FRESH LIVE lock, and the second's unconditional unlink then deletes THAT, not the dead
lock it actually judged — so both come away believing they hold it.

## reclaimStaleLock

### Base lines 192-226 — Safely reclaim `lockPath` if, and…

Safely reclaim `lockPath` if, and only if, the holder read from it is confirmed stale
AND the file at `lockPath` is STILL the exact inode that read came from at the moment of
deletion. This is the shared primitive behind every "read a lock, and if its holder is
dead, clear it" call site: `acquireInflightLock`, `acquireDrainLock`,
`acquireReviewStatusLock`, and the boot sweep `sweepStaleInflightLocks`.

THE FIX: the delete is conditioned on file IDENTITY, not merely on the path string. The
SAME descriptor opened to do the stale-holder READ is `fstat`'d, right after the read,
BEFORE it is closed — so the `{dev, ino}` captured is guaranteed to be the identity of
the EXACT bytes this call judged dead, never a separately re-resolved path. Immediately
before deleting, the path is `stat`'d fresh (by name, since we need to know what is
THERE NOW, not what our old descriptor still points to); the unlink proceeds ONLY if
`dev`+`ino` still match. If they don't — or the path is gone entirely —
another actor already reclaimed (or recreated) it, so this call backs off with
`{outcome: "lost"}` rather than deleting whatever is there now. The caller's own acquire
loop simply retries from the top, which re-reads the CURRENT state fresh.

HONEST ABOUT THE REMAINING WINDOW: `stat`-then-`unlink` is still two syscalls, not one
indivisible one — POSIX `unlink(2)` has no compare-and-delete form. What remains is "a
brand-new, unrelated file lands on this exact path AND is assigned the SAME (dev, ino)
pair as what we just read, in between this call's final `stat` and its `unlink`" — inode
reuse within a handful of in-process syscalls. That is categorically narrower than the
bug this replaces, which was unconditional: ANY interleaving hit it, not only inode
reuse on an already-freed inode landing back on this path in a single-digit-syscall
window.

PRINTS THE LOCK IN FULL BEFORE REMOVING IT (W1-T1067 design (v), the same print-before-clear
discipline W1-T1036's `.git/config.lock` reclaimer already follows): `onReclaim` runs with
the lock's path and exact bytes right before the unlink, so a reclaim is never judged silently
— every caller gets this for free, since it is a property of the shared primitive rather than
of any one call site.

## reclaimStaleLock identity check

### Base lines 261-270 — IDENTITY IS `dev`+`ino` **AND THE…

IDENTITY IS `dev`+`ino` **AND THE BYTES** — dev+ino ALONE DOES NOT CLOSE THIS RACE.
Measured on ext4 (this repo's CI and Linux hosts): unlink followed immediately by a create
in the same directory REUSES the just-freed inode — a probe writing, unlinking and
rewriting one path read `ino=1957993` both times. So in the exact scenario this function
exists for (reclaimer A unlinks and recreates before B reaches its delete), B's dev+ino
check matches and B deletes A's LIVE lock: the TOCTOU, still open, with a check in front
of it that looks like a fix. The lock's own bytes carry the holder (a pid), so a
replacement writes different content; comparing them detects the swap that the inode
number cannot. Read through a single fd, like the stale read above, so the content and
the identity describe the same open file rather than two path re-resolutions.

## isHolderStale banner

### Base lines 314-324 — isHolderStale: THE ONE PREDICATE for…

isHolderStale: THE ONE PREDICATE for "does this lock still name a real holder?"

W1-T368. A bare `!isAlive(held.pid)` (the `isStale` every `reclaimStaleLock` call site
used before this) answers "is SOME process currently using this number", never "is it the
SAME process that wrote the lock". The pid space wraps (measured on the fleet host:
kern.maxproc 4000, kern.maxprocperuid 2666), so a dead holder's number gets reissued in the
ordinary course of things — and when that happens the recycled pid reads as LIVE forever,
which both refuses every future acquire of the task it names (acquireInflightLock throws)
and renders a dead run as RUNNING on the console (deriveStatus's third disjunct). Neither
other field the lock already carries was ever compared: `host` not at all, `startedAt` never
against anything.

## looksLikeContainerId

### Base lines 365-371 — Docker's own container id shape:…

Docker's own container id shape: a lowercase-hex string, 64 characters (the full id) or 12
(the short form — the SAME length `os.hostname()` actually returns inside a container;
MEASURED against the outage this fixes, `5efb86ede91b` and `eae16667008a`, both 12). Used by
`isHolderStale`'s rung 1 to require that a mismatched `held.host`, while this process is
containerised, is actually SHAPED like a container id before treating it as this cell's own
prior history — an arbitrary or human-named `host` (`"boxA"`, a hand-built test fixture) must
stay exactly as unverifiable in a container as it always was off one.

## isHolderStale

### Base lines 376-469 — Is `held` stale — safe…

Is `held` stale — safe to reclaim, sweep, or treat as not-running — rather than a genuinely
live holder? The ONE predicate every `reclaimStaleLock` caller and `deriveStatus`'s own
inflight-lock disjunct now share (previously each kept its own copy of the weaker
pid-only check).

THREE RUNGS, in order, each ANSWERING what it can and DEFERRING what it can't:
  1. `held.host` names a DIFFERENT host than this one ⇒ NOT stale, whatever the local
     process table says — UNLESS this process is running inside a CONTAINER, in which case
     a mismatch means something else entirely. See "W1-T978" below. A pid is only ever
     meaningful on the host that assigned it, so every probe below answers a question about
     OUR machine that says nothing about the recorded holder. Unresolvable from here ⇒ never
     reap (the same direction of caution `reclaimStaleLock`'s own "lost" outcome already takes).

     W1-T978 — A REPLACED CONTAINER COULD NEVER RECLAIM ITS OWN LOCK, because `os.hostname()`
     inside a container IS THE CONTAINER ID: Docker mints a new one on every replacement, so
     `held.host` (written by the PREVIOUS container) never again equals `myHost` (this one's),
     even though nothing genuinely foreign ever touched the lock. MEASURED during a live outage
     (2026-08-18): `state/drain.lock` held `{"pid":46,"host":"5efb86ede91b",...}`; container
     `5efb86ede91b` no longer existed; the replacement was `eae16667008a`; rung 1 compared the
     two, found them different, and refused to boot — forever, since the comparison can only
     ever fail again the same way.

     THE DISCRIMINATOR IS TWO-PART, DELIBERATELY, NOT "AM I IN A CONTAINER" ALONE. `state/`
     (wherever this lock lives) is a bind mount: nothing OTHER than a process on THIS machine
     could ever have written to it, so once we know we are running IN a container, a `host`
     mismatch CAN mean "an earlier container of this same cell" — but "am I in a container"
     says nothing about whether `held.host` is actually a container id at all. `host` is a
     free-form field: a lock that genuinely predates containerisation, a hand-edited fixture,
     or a future writer on a differently-shaped identity could all put an ARBITRARY string
     there, and none of those is "an earlier me" merely because this process happens to be
     containerised today. So the second half checks that `held.host` is actually SHAPED like
     what `os.hostname()` returns inside a container — Docker's own hex id format — before
     treating the mismatch as this cell's own history. Only BOTH together clear the bar: a
     foreign, human-named, or synthetic `host` stays exactly as unverifiable in a container as
     it always was off one.

     ONLY THEN is the lock treated as stale directly, WITHOUT consulting rungs 2/3. That
     omission is deliberate, not an oversight: a container has its OWN PID NAMESPACE, and pids
     restart from 1 (measured: the abandoned lock's pid 46 came back as pid 49 in the
     replacement) — so the recorded pid is exactly as likely to collide with a live, UNRELATED
     local process as to look cleanly dead, and trusting that collision in EITHER direction is
     answering a question the new namespace cannot answer.

     On a real (non-containerised) machine, or on any `host` that is not container-id-shaped,
     none of this applies and rung 1 behaves exactly as it always has — the discriminator only
     ever WIDENS what a container can reclaim of ITS OWN prior identities, never what a bare
     machine can, and never a foreign host that merely happens to be read from inside a
     container.

     W1-T396 MOVED THIS RUNG, and the order is the correctness property. It previously sat
     BELOW the pid probe, where it could only ever be reached when a foreign pid number
     happened to collide with a live LOCAL process — it guarded the coincidence and not the
     case it was written for. The ordinary cross-host reading is that the foreign pid is
     ABSENT here, so the pid rung answered "dead ⇒ stale" and the lock was RECLAIMED while
     its real holder was still running: two workers on one task, with no error on either
     side. Note the shape rather than only the fix — a guard ordered behind a check that
     claims its case first is this repo's second instance in two days (W1-T394 is the same
     defect in the sweep's rung table).
  2. `held.pid` is dead ⇒ stale. The common case, and the ONLY thing that recovers a killed
     run: `run-task.ts`'s SIGINT/SIGTERM handlers release the DRAIN lock only, never a
     per-task inflight lock, so a signalled run strands its inflight lock and an uncatchable
     kill strands both. Reclamation must stay reachable for every same-host holder.
  3. `held.pid` is alive on OUR host: compare its ACTUAL start time against `held.startedAt`.
     A pid reused by a new process necessarily starts AFTER the original holder wrote the
     lock (the original had to be running, and write the file, before it could die and free
     the number) — so "this pid started later than the lock claims" is exactly the reuse
     signal, decidable without waiting for a real wrap. If the start time can't be determined
     (probe failure — the pid could have died in the gap between rungs 1 and 3, `ps` missing,
     unparseable output), that is NOT evidence of staleness, so this rung defers too.

HONEST ABOUT THE REMAINING WINDOW: this is still a REASON TO BELIEVE the holder is alive,
never proof. A cross-host lock is trusted with no verification at all (rung 1), and a
same-host reused pid that starts within `STALE_START_TOLERANCE_MS` of the original is
indistinguishable from the original (rung 3's whole-second `ps` resolution).

AND HONEST ABOUT WHAT RUNG 1 NOW COSTS, since it is reached far more often than before: on a
REAL (non-containerised) machine, a foreign-host lock is unreclaimable by this process in
EVERY case, not just when its pid collides locally. That is the correct direction — the
alternative is stealing a live holder's task — but it makes `host`'s STABILITY load-bearing
there. It is written as `os.hostname()` by every acquire path (`inflight-lock`, `drain-lock`,
`review`, `task-id-reservation`) and compared against the same `os.hostname()` default here,
so the two agree by construction. A bare-metal/VM machine whose hostname CHANGES between
acquire and reclaim would still see its own older locks as foreign and therefore permanently
unreclaimable, recoverable only by deleting the lock file. Recording a stable per-machine
identity instead of a hostname would remove that exposure; it is deliberately not done here
because it changes what four writers RECORD rather than how this predicate READS, which is a
different concern and a different changeset.

W1-T978 NARROWS THIS COST TO NON-CONTAINERS ONLY. Inside a container the analogous exposure —
`host` changing on every restart — is exactly the defect this task fixes, and rung 1's new
container branch answers it directly rather than accepting it the way the paragraph above
accepts it for a real machine.

## isHolderStale rung 1 (inline)

### Base lines 471-484 — RUNG 1 — HOST FIRST, and…

RUNG 1 — HOST FIRST, and the order is the whole point (W1-T396). Every rung below
reasons about THIS machine's process table, which describes the recorded holder only
when the recorded holder ran here. Asking any of them about a foreign pid answers a
question nobody posed.

W1-T978: a mismatch on a real machine is still unverifiable and never reaped. A
mismatch INSIDE A CONTAINER, on a `host` actually SHAPED like a container id, can only
be an earlier container of this same bind-mounted cell (see the doc above) — reclaimed
directly, never via the pid/startedAt rungs below, which a fresh pid namespace cannot
answer meaningfully either way. A `host` that is not container-id-shaped stays exactly
as unverifiable as it always was — the shape check is what keeps an arbitrary or
human-named foreign host from being swept in just because THIS process is containerised.

## isHolderStale boot rung (inline)

### Base lines 490-514 — THE BOOT RUNG (W1-T1067) —…

THE BOOT RUNG (W1-T1067) — sits here, between rung 1 and rung 2, and answers a question
neither of them can: a `docker restart` REUSES the container, so `held.host` above reads
UNCHANGED (rung 1 falls through rather than firing) — but the restart mints a FRESH pid
namespace, so `held.pid` can coincidentally alias a live, unrelated process in the new boot,
one whose own start time gives rung 3 below nothing to compare against the ORIGINAL holder
(that comparison is about the number's CURRENT occupant, not about whether the boot the lock
was written in still exists at all). A lock whose `startedAt` PREDATES this container's own
boot was written by a process of an EARLIER boot and is dead by construction, whatever pid
it names — no live process from a prior boot can be running in this one's pid namespace.

PID 1 IS THIS CONTAINER'S OWN BOOT CLOCK, so its start time IS the container's boot time —
read through the SAME `getProcessStartTime` probe rung 3 already uses (the same `ps -o
etime=` route, MEASURED available in the live container via `ps -o etimes= -p 1`), so this
costs no new syscall and no new dependency. Skipped entirely when `startedAt` is absent
(pre-W1-T368 shape) or the probe is indeterminate — exactly rung 3's own "no evidence either
way" discipline, never inventing staleness from a probe that couldn't answer.

CONSERVATIVE IN THE RIGHT DIRECTION (design note iii): it can only ever reclaim a lock OLDER
than this boot. A genuinely concurrent second daemon in THIS container necessarily started
AFTER pid 1, so its lock's `startedAt` is always later than boot time and this rung never
touches it — the single-instance mutex this lock exists to be is never weakened by it.

ONLY REACHED WHEN RUNG 1 DID NOT ALREADY DECIDE: a genuinely foreign host already returned
above, so this rung only ever runs against `held.host === myHost` or an absent `host` —
never against a lock this process has no business judging at all.

## defaultGetProcessStartTime

### Base lines 565-575 — Default `getProcessStartTime`: shells out…

Default `getProcessStartTime`: shells out to `ps -o etime=`, whose `[[DD-]HH:]MM:SS`
elapsed-time column is the ONE process-age mechanism common to this repo's two real platforms
— verified directly rather than assumed: BSD `ps` (macOS, the dev host) and GNU `ps`
(`ubuntu-latest`, this repo's CI) both accept `-o etime=`, while GNU-only `etimes`/`lstart`
formatting differs enough between the two that elapsed time (this process's age, computed
against `Date.now()`) was chosen over wall-clock start time (which would need locale-safe
parsing of BSD's `lstart` string) to stay portable. Returns `null` — indeterminate, NOT
"dead" — for a pid `ps` can't find, a `ps` binary that isn't on PATH, or output this doesn't
recognize; `isHolderStale` already treats `null` as "no evidence either way".

## defaultInContainer

### Base lines 598-606 — Default `inContainer`: `/.dockerenv`, Docker's…

Default `inContainer`: `/.dockerenv`, Docker's own container marker — the SAME signal
`resolveHostPole` (host-parity.ts) is keyed on and the SAME path `scripts/host-parity.ts`
passes it (`existsSync("/.dockerenv")`), so this is established prior art rather than a new
detection strategy. Unlike `resolveHostPole`, which takes the marker as an INJECTED boolean
because that module has NO imports at all and values purity above everything, this module
already imports `node:fs` for the syscalls above it in this file, so a defaulted probe here
costs nothing this module was not already paying (W1-T978 design note v).
