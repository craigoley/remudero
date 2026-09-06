# fleet-heartbeat-watch.yml forensics

The measured forensics, incident narratives and design arguments removed from
`.github/workflows/fleet-heartbeat-watch.yml` when its comments were compacted to the
plain-language standard (`docs/comment-standard.md`). Every block below is the removed text
verbatim, marker characters (`⚠️`, the `── … ──` section rules, ALL-CAPS emphasis) stripped and
nothing else changed. Headings name the step or env var the text explained; the workflow keeps a
one-line `# Why:` pointer where the history mattered.

Base revision: `origin/main` at f148a1303173cb5789e36cc70aee8b78d90ca57f. The line numbers below
are that revision's.

## File header — purpose, delivery, polarity

### Base lines 3-7 — THE OTHER HALF OF scripts/fleet-heartbeat.sh…

THE OTHER HALF OF scripts/fleet-heartbeat.sh. That script makes the mini say "I am still here"
on a cadence; this job is the thing that NOTICES WHEN IT STOPS. A heartbeat nobody watches is
not a heartbeat — and the watcher has to live somewhere the machine cannot take down with it,
which is why this runs on GitHub's runners and reads the signal over the wire rather than
anywhere on the host it is judging.

### Base lines 9-16 — A FOURTH CALLER OF AN EXISTING MECHANISM…

A FOURTH CALLER OF AN EXISTING MECHANISM, not a new one. Delivery goes through
scripts/needs-human-issue.mjs exactly as clock-sweep.yml, recovery-drill.yml and
mutation-nightly.yml already do, for the reason that script's own header gives: "a scheduled job
that fails produces a red badge on a page nobody opens." It is idempotent by construction — it
COMMENTS on an existing open issue carrying the `<!-- needs-human:fleet-heartbeat -->` marker and
OPENS one only when none exists, so an hourly cron cannot produce a wall of duplicates; identity
rides that marker rather than the title, so retitling during triage does not fork a thread; and
it exits 1 when delivery itself failed, because a failure to notify must be loud.

### Base lines 18-21 — NOT A REQUIRED CHECK AND NOT AN ORDINARY PR TRIGGER…

NOT A REQUIRED CHECK AND NOT AN ORDINARY PR TRIGGER — the same polarity clock-sweep.yml,
recovery-drill.yml and mutation-nightly.yml all establish, and deliberately absent from
ci-gate.yml. It is also not a ci.yml job, so it needs no CI_PARITY_TABLE entry: `runCiParity`'s
drift check (src/lib/ci-parity.ts) parses ci.yml's own top-level job keys and nothing else.

## Branch absence is silent

### Base lines 23-34 — BRANCH ABSENT MEANS NOT INSTALLED, AND IS SILENT…

BRANCH ABSENT MEANS NOT INSTALLED, AND IS SILENT. The single most important behaviour here. The
beat script is committed to the repo but INSTALLED on each host separately, so between this
workflow merging and that installation there is a window — possibly days — in which a host's
branch does not exist at all. Firing then would open a needs-human issue every hour about a
machine nobody has armed yet, which is precisely how a label gets trained into noise and then
ignored. So: no branch => NOT INSTALLED => silent. Only a branch that EXISTS and has gone quiet is
a finding. This is the same bound-fires-on-a-healthy-condition trap W1-T312, W1-T380 and W1-T382
were each filed for, in a new guise.
AND THAT CLAUSE IS NOW PER BRANCH, WHICH IS THE PART MOST EASILY BROKEN. The loop below decides
installed-or-not for EACH branch on its own and never collapses to "some branch is fresh, so all
is well" — a single any-branch-is-fresh reading would reproduce the exact outage this watcher was
extended for.

### Base lines 36-52 — ONE BRANCH PER HOST, AND WHY A LIST RATHER THAN A JOB EACH (W1-T483)…

ONE BRANCH PER HOST, AND WHY A LIST RATHER THAN A JOB EACH (W1-T483). Each beat is a force-pushed
PARENTLESS commit, so a branch carries exactly one beat and no history, and two hosts beating to
the same branch OVERWRITE each other. This watcher reads `now - last commit`, so it would see
whichever host beat most recently and a healthy host would mask a dead one completely. MEASURED
2026-08-14: the Azure fleet was down 2h56m — 90% of a day's downtime in one event — while
`heartbeat` kept reporting `daemon live`, truthfully, about the mini, and this watcher correctly
stayed silent about the wrong machine.
TWO SHAPES WERE AVAILABLE AND THE SHARD RANKED NEITHER. One JOB per host reads well in the
Actions UI and isolates failures, but duplicates the whole body per host and makes the
absent-is-silent rule a copy-paste invariant — the kind that drifts. A LIST keeps that rule in
ONE place, costs one word per new host, and lets each entry be independently silent; its cost is
that all hosts share one job result and one issue thread, which the per-branch report below
offsets by naming every branch it read. The list is taken for the single-definition reason.
A THIRD SHAPE WAS REJECTED: discovering branches by prefix (`git ls-remote --heads 'heartbeat*'`)
would arm new hosts automatically, but any stray or abandoned `heartbeat-*` branch would then go
stale and alarm forever — a watcher that alarms on junk gets muted, and a muted watcher is worse
than none. An explicit list cannot do that.

## The staleness threshold

### Base lines 54-77 — THE THRESHOLD, AND WHERE THE NUMBER COMES FROM…

THE THRESHOLD, AND WHERE THE NUMBER COMES FROM. STALE_AFTER_MINUTES = 30, which is SIX TIMES the
beat script's documented five-minute install cadence. The multiple is what needs justifying, so:

  * The threshold must clear the largest gap a HEALTHY fleet can produce. Note what does NOT
    enter that: this job's own hourly cadence affects DETECTION LATENCY, not the measured age —
    the age is `now - last beat commit`, so a healthy reading is one beat interval plus jitter
    whenever this happens to run. The only healthy sources of a gap are a transiently failed
    `git push` (network blip, a GitHub 5xx) and launchd/cron jitter on the mini.
  * The distribution of those transient failures is UNMEASURED. It cannot be sampled today —
    the machine is down — and this repo's recurring defect is a bound sized against a population
    nobody has observed, which then fires on healthy conditions (ci-gate's wait cap under the
    real check wall-clock, W1-T312; a deploy ceiling consumed by a dry run, W1-T380; a check-wait
    bound where 21 of 21 booked PRs later merged, W1-T382). With the population unmeasured the
    correct move is to size GENEROUSLY and let operation measure it, not to fit to intuition.
  * Six tolerates five consecutive missed beats — twenty-five minutes in which `git push` alone
    failed repeatedly, which is a real problem in its own right and deserves the issue anyway.
  * The cost of that generosity is bounded and small: worst-case detection moves from about five
    minutes to about thirty, plus this job's hourly cadence — against a status quo of hours, or
    never.
  * REFINEMENT IS BUILT IN. Every beat carries `since_prev_beat_s`, the gap the MACHINE itself
    observed since its own last published beat, so after a few weeks the real distribution is
    readable off the beats and this multiple can be fitted to data instead of to caution. Do not
    tighten it before that data exists.

## What this job does not cover

### Base lines 79-83 — WHAT THIS JOB DOES NOT COVER…

WHAT THIS JOB DOES NOT COVER. Its own silence. GitHub's scheduled workflows are best-effort and
can be delayed or dropped on a low-activity repository, and nothing here notices if this job
stops running. A watcher-of-the-watcher is an infinite regress; the honest statement is that this
closes the machine-goes-dark gap and not the GitHub-drops-our-cron gap.

## Scheduling

### Base lines 85-87 — HOURLY at :37 — off :00/:30 for…

HOURLY at :37 — off :00/:30 for the reason clock-sweep.yml's own scheduling note gives, and off
the minutes clock-sweep (:23), mutation-nightly (:31) and recovery-drill (:17) already occupy, so
the four scheduled instruments never contend for the same runner window.

## HEARTBEAT_BRANCHES

### Base lines 101-123 — ONE ENTRY PER HOST, space-separated…

ONE ENTRY PER HOST, space-separated. `heartbeat-mini` is the mini's and `heartbeat-azure` is
Azure's. Adding a host is one word here plus `RMD_HEARTBEAT_BRANCH=<that word>` in its cron
line — and an entry whose branch does not exist yet costs nothing, because absence is silent
per branch.

THE BARE `heartbeat` NAME IS DELIBERATELY GONE FROM THIS LIST, AND NOTHING WRITES IT ANY MORE.
It was the mini's until its cron moved to `RMD_HEARTBEAT_BRANCH=heartbeat-mini`; its last beat
is frozen at 2026-08-14T16:30:00Z carrying `beat_host=Craigs-Mac-mini`. Leaving it here would
watch a branch no host writes, which goes stale after STALE_AFTER_MINUTES and opens a
needs-human issue about a machine that is perfectly healthy — the fastest way to get this
watcher muted. The ref is NOT deleted: deleting a remote ref is the operator's act, and the
reaper can never offer it anyway (see the guard note below). It simply sits inert.

NAMING A BRANCH HERE ALSO GUARDS IT FROM THE REAPER, AND OWES A DECLARATION. `reapBranchesCommand`
(src/run-task.ts) derives `namedInSource` from `git grep -F <branch> -- src/ scripts/ deploy/
.github/`, so an entry in this list makes that branch permanently GUARDED — it can never be
classified deletable. The cost is the other half of that mechanism: a branch guarded by the grep
but missing from `DECLARED_BRANCH_GUARDS` is reported as DRIFT and `rmd reap-branches` exits 1
naming it. That verb is a hand-run DRY RUN — no workflow, no gate, no daemon cadence calls it —
so nothing automated goes red, and the message says exactly what to do. Declaring the name there
is a one-line change to src/run-task.ts and is deliberately NOT part of W1-T483, whose scope is
observability and which declares no `src/` path. Whoever adds the third host should expect the
same alarm; its own doc calls that "the alarm working as intended".

## DAEMON_EXPECTED_BRANCHES

### Base lines 126-131 — W1-T2876: THE BRANCHES THAT MUST HAVE A POLLING DAEMON…

W1-T2876: THE BRANCHES THAT MUST HAVE A POLLING DAEMON. The beat already carries
`daemon_verdict`; the judging step below now escalates on it, but ONLY for a branch named here.
`heartbeat-mini` reports `daemon_verdict=STALE` correctly and permanently -- the mini is not the
fleet host and runs no daemon -- so an unconditional arm would fail this job forever on a TRUE
reading, which is exactly what trains an operator to ignore an alarm. A branch not listed stays
silent on this arm, the same way a never-installed beat already does.

This escalation exists because of a real miss: the judging loop (the `## Read every host beat
branch and judge each age` step's `run:` body, unchanged by this compaction — see its own inline
comments) extracted `supervisor_verdict` and nothing else until W1-T2876. On 2026-09-05 (run
33961825846) this job printed `daemon STALE` twice while the Azure daemon had been dead three
hours, and reported `0 stale`. PRs #4095 and #4068 fixed the loop; this env var is the axis its
fix reads.

## No `npm ci`

### Base lines 153-157 — No `npm ci`, unlike the three sibling…

No `npm ci`, unlike the three sibling workflows — a deliberate subtraction, not an
oversight. scripts/needs-human-issue.mjs imports only node builtins (node:fs,
node:child_process, node:url, node:util) and the checks below are bash, so nothing here
needs the dependency tree. That also means this watcher keeps working on a day `npm ci`
itself is broken, which is not a hypothetical failure mode for this repo.

## Self-check first

### Base lines 159-165 — SELF-CHECK FIRST, gating the live read…

SELF-CHECK FIRST, gating the live read — the same "probe self-check before sweeping"
discipline clock-sweep.yml and recovery-drill.yml both open with. A watcher that reports
health regardless of input is worse than no watcher, because it reads as coverage that does
not exist. Both halves are exercised: the staleness predicate must DISCRIMINATE, and the
real beat script must produce the three verdicts it exists to distinguish. This is inline
rather than a third file because the changeset is deliberately two files; if it grows,
promote it to scripts/ and give it a test/ falsifier.
