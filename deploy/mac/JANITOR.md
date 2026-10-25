# Account-aware workspace retirement

Install code with `bash deploy/mac/install-janitor.sh`. This preserves the previous
script and installs both guards and the cache helper beside `~/bin/remudero-janitor.sh`; it does not
change schedules. Existing Craig launchd and agent cron jobs can use the same
binary: account paths are derived from the account running it.

For the shared cron entry point, run `bash deploy/mac/install-janitor.sh --shared`
as an account allowed to write `/Users/Shared/remudero-mac`. This installs the
same maintained janitor, both safety guards and cache helper there, and installs
`/Users/Shared/remudero-mac-janitor.sh` beside it. The launcher never reaches into
another user's private home. It preserves the caller's HOME and UID, existing
six-hour guards, per-account locks and schedules. Do not widen home-directory
permissions to make a cross-account launcher work. `--shared-root PATH` installs
the identical layout under an alternate absolute root for testing.

Run `~/bin/remudero-janitor.sh --dry-run` before `--apply`.

The temporary cleaner appends `/usr/sbin:/sbin` to the caller's PATH so cron can
find macOS `lsof`; it never changes caller precedence or adds user package bins.
Dependency-health diagnostics use Python's standard library, already required by
the generated-cache helper, rather than requiring Node on cron's PATH. Unknown
probe results still retain data and never trigger dependency installation.

The six-hour floor covers both modification and kernel change time in generic
temporary-file pruning and whole temporary/session-scratch retirement, not just
TSX caches. Restoring old mtime does not make a newly changed file eligible.
Before pruning old regular leaves from a mixed-age scratch tree, the cleaner
checks the enclosing tree's process/CWD/open-file activity and rechecks it at
each deletion boundary. Activity or an unavailable probe retains the tree.

The same leaf policy now covers `~/Remudero/.session-scratch`, including loose
regular files at its root. Each leaf needs six hours of both mtime and ctime
inactivity; a recent sibling retains the container. Credentials, Git checkouts,
symlinks, special files, scheduled logs and patch/diff/rej/orig evidence retain
their direct-child tree. Wholly idle safe directories still retire together.
Old empty directories are removed under the same guards; a directory whose
ctime changed during leaf removal waits until a later pass. The summary reports
session scratch files and directories separately, with decision receipts.

The account janitor also reclaims physical, account-owned direct children named
`~/.cache/remudero-*` after the entire tree has been idle for six hours. It keeps
`~/.cache/remudero`, its own lock, every `*.lock` name, and trees containing Git
metadata, bundles, locks, symlinks, foreign owners or special files. A receipt
identifies store-fill caches as historical/external with an unverified creator:
the checked-in core store-fill fixture uses temporary storage. A leaking creator
must be identified and fixed separately.

With no account npm/npx process, `~/.npm/_cacache/content-v2` and `~/.npm/_npx`
release old regular leaves after fresh activity/ownership/structure checks.
The janitor runs `npm cache verify --cache "$HOME/.npm"` after content pruning.
When npm is absent from cron's PATH, the existing whole-artifact policy applies
instead, requiring every entry (including the index) to be idle. Worker-home
cache handling and the six-hour minimum remain unchanged.

Before probing idle checkouts, the janitor can normalize relative alternates or
replace a dangling entry with a known same-home lender containing HEAD. It saves
`objects/info/alternates.pre-repair` without overwriting earlier evidence, then
checks HEAD and `git fsck --connectivity-only --no-reflogs <HEAD>`. Failed probes
restore the original bytes and record `repair-reverted`; successful repairs
record `repaired`. Missing lenders, live paths, partial clones and uncertain
ownership retain the checkout. Dry runs only describe a repair. Ordinary
publication and preservation checks still decide any later retirement.

`janitor-free-samples.tsv` beside the decision receipt keeps the last 200 pass
samples of timestamp/free bytes. A declining fitted trend projected to fill the
disk within three observed pass intervals produces one `low-space-report:`
block; inside one interval is critical. Stable/growing free space and insufficient
samples do not page by a fixed GiB floor. The existing EMERGENCY line and author
preflight reserve retain their thresholds.

The report uses one bounded `du -xsk` observation per visible home child and known
root, under the existing 45-second inspection ceiling. Seen bytes sum only home
children, avoiding double-counting nested known roots. It includes swap from
`sysctl vm.swapusage`, `unaccounted = used - seen - swap`, and the operator's
action in other accounts and system areas this account cannot read. Incomplete
measurements remain labeled unknown/incomplete. It reports preservation's state;
when disabled it computes a read-only dry-run count/bytes with the installed
helper's default selection and lender guards. This estimate precedes preservation
checks and creates no config, archive, stamp or checkout changes. Preserve-retire
remains opt-in. Report rows use the `low-space-report` reason code; new successful
cache and scratch removals use `removed`.

## Preventing new validation growth

The `scripts/preflight-author.mjs` CLI checks Mac workspace and TMPDIR capacity
before starting author work, then checks freshly after slot waiting and before
each static/test phase. Both volumes must retain the existing 20-GiB local
coverage reserve, and a bounded native pressure read must report normal. Warning,
critical, unknown or unavailable readings return **NOT_RUN / exit 3**, not a test
pass. Help and dry-run remain available. Linux/hosted admission is unchanged.
This is a fresh pre-start observation, not a cross-account capacity reservation
or a guarantee against other jobs starting concurrently. It never kills jobs,
changes Janitor retention, deletes swap or dependencies, or weakens hosted gates.
Older author receipts are not proof of a refused invocation. Existing running
jobs and older checkouts are not modified; use the updated checkout for new runs.

Apple's public XNU source maps its internal pressure enum to userspace dispatch
flags for `kern.memorystatus_vm_pressure_level`: 1 is normal, 2 warning and 4
critical. Do not confuse these with the internal 0-through-4 enum:
<https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c>.
RSS alone also omits compressed memory; use Activity Monitor's pressure and swap
observations when investigating a capacity refusal:
<https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac>.

The installer also installs `cache-reclaim.py` and `retire-legacy-sweeper.py` in
both layouts. `--retire-legacy-sweeper` is an explicit additional installer option,
composable with `--shared`. It disables future launch admission only for the
known `com.craigoley.disk-sweep` job after verifying its exact plist arguments
and executable (an explicit `Program` must equal `/bin/zsh`), ownership and
historical script hash. The plist is retained with a disabled
suffix. It never stops a running process, changes cron entries, or retires an
unknown/replaced job. Ordinary code-only installation does not change schedules.
Retirement verification accepts the exact `disabled` token printed by macOS 27
and the older `true` spelling. Unknown, enabled or duplicate job rows remain
unverified, with the original plist retained.

The scan includes `~/Remudero`, nested disposable checkouts below the protected
operator checkout `~/Remudero/remudero`, `~/rmd-work`, and temporary roots.
On macOS it also includes each running account's
`~/Developer/remudero-operator-worktrees`, including non-Git scratch children.
That container itself remains in place; young descendants, active/open paths,
dirty or unpublished Git state, evidence and unknown visibility still retain a
child. No other Developer directory becomes a whole-directory cleanup root. Git
discovery is bounded to eight levels and reports incomplete scans. It never
deletes tracked source directories merely because they are old. Empty or unknown
non-repository containers remain classified as data, not silently ignored.

A linked workspace retires through Git only when it is clean, unlocked, owned by
the running account, unused by processes/CWD/open files, and every payload entry
has at least six hours of mtime **and ctime** inactivity. Git administrative
metadata is excluded. Dependency/coverage directories count as activity too.
The Git HEAD file is checked separately so a metadata-only branch switch is
protected without letting routine fetch/status refreshes hold a tree forever.
A launcher in a parent directory does not hold every inactive child. A cwd
inside a child still holds it, as does a parent process whose command names
that child through a relative path. PID/command visibility failures hold the
candidate. Artifact cleanup uses its enclosing Git checkout as the activity
scope, so an active repository retains its dependencies. Git-tracked nested directories and
submodule/gitlink sources are never retired.
An ancestor CWD record missing from the earlier process snapshot gets a fresh
PID-specific read. Only an empty no-selected-PID result releases that stale
record; live relative commands, unreadable probes, warnings and malformed
output still hold the candidate. Direct CWDs inside a candidate remain holds.

Every scheduled janitor pass also calls the installed helper in cache-only
mode for its configured temporary roots, `~/Remudero` and `~/rmd-work`.
Discovery reaches historical job TMPDIRs up to eight levels deep, without
following symlinks or entering Git metadata, dependencies or runtime/state
directories. Both the regular temporary cleaner and this delegated mode
discover nested numeric `tsx-<uid>` caches. Only recognized generated cache
files are eligible in discovered caches; Git-owned, retained, seed or
unrecognized contents stay protected. Each file needs six hours of both mtime
and ctime inactivity, with fresh process/CWD/open-file checks before removal.
Cache roots and sibling fixtures/source/state stay in place. Delegated cache
counts are logged separately from workspace-removal counts.
Owned numeric `<pid>.pipe` Unix sockets are recognized as TSX IPC endpoints and
retained, not deleted or treated as cache files. Their mere presence does not
hide otherwise eligible old regular cache entries. The existing whole-cache
live/open checks still hold a cache with a live endpoint. Foreign, linked,
non-socket `.pipe` entries and all other unknown data retain the whole cache.

The regular janitor additionally inspects this account's `.codex/work-artifacts`
for exact ignored package duplicates and `.next/cache/turbopack` compiler data.
Each invocation uses one account lock and serial probes. Inspection is bounded
to 45 seconds, 500,000 entries and 2 GiB of content reads; budget exhaustion is
a typed keep decision. Already admitted staging finishes or restores safely.
Discovery and reference traversal stream physical directory entries with
no-follow, parent-fd-bound descent and directory identity checks. Every child
enumerated for inspection consumes the entry budget, including ordinary files
in a single flat directory; wall checks occur between children. This is an
honest inspection ceiling, not a directory-only counter. A corpus larger than
500,000 inspected entries can still yield no reclaim in this bounded pass.
Discovery retains known candidates when interrupted. Incomplete discovery or
any incomplete/unreadable reference root never clears a candidate for removal.
All original reference roots and depth limits remain in scope. A cheap root
observation can only KEEP a recent, foreign or flagged target; only when every
candidate is already kept can the reference phase be unnecessary.
Completed directory namespaces are authenticated in a private checkpoint capped
at 16 MiB. Prefix-coded paths and implicit LRU order avoid repeating long absolute
paths. Loading bounds expanded path text as well as encoded bytes; eviction
rebases the first remaining record. Old writer/format scopes cold-reset. Only
namespace observations are reused: current directories/symlinks, age, activity,
payload identity and deletion guards are checked again. No scan limit increases.
An authenticated candidate cursor resumes at a budget-interrupted candidate
instead of repeatedly spending the pass on the same prefix. It only rotates
inspection order after a fresh complete reference census; it never caches
eligibility, KEEP conclusions or dependency anchors. Every resumed attempt
rechecks the six-hour and activity guards, and a completed round clears the hint.

An inaccessible physical reference subtree can be inspected by an explicitly
configured, read-only peer account. The optional file
`~/.local/state/remudero/cache-reference-peers.json` must be an owner-private
0600 regular file below physical, same-owner, non-writable-by-others parents.
It is a JSON array of `{ "uid": <subtree owner UID>, "argv": [<absolute program>, ...] }`.
An operator may use an existing authorized SSH connection whose fixed remote
command is `python3 '<installed helper path>/cache-reclaim.py' --reference-probe`.
Arguments are executed without a local shell; requests go over stdin, never into
the remote command string. Installation does not create credentials, authorize
SSH keys, configure sudo, widen filesystem permissions or assume reciprocal
account access. Missing configuration/authentication remains a typed hold.

The peer endpoint accepts only owned physical subtrees in its existing reference
roots and bounded request limits. It reads metadata and symlinks, not source or
package contents, and creates no locks, checkpoints or cleanup stages. A nonce,
request digest, exact writer generation, UID and sealed root identity bind its
reply; entry/read/time costs consume the caller's remaining budget. Unknown,
incomplete, oversized, changed or failed replies never clear a candidate.
Permission errors while resolving a symlink's referent are not treated as an
unresolved non-reference: the peer returns that link for strict resolution by
the caller using its own access. If neither account can resolve it, cleanup
still holds. Resolving a known link pins and revalidates each physical path
edge (inode, type, permissions and ownership), without treating unrelated
sibling creation in an ancestor as a changed link. Enumerating a reference
namespace still seals its complete directory identity, and every symlink edge
is revalidated. This supplements the full census; it does not bypass process,
CWD/open-file, six-hour, Git, duplicate-payload or retained-evidence protections.
Duplicate package removal requires equal complete byte/mode/symlink namespaces
and an unchanged full payload anchor retained in place. Unique `.vite` results
and `.rmd-dependency-seed.json` receipts remain at their original paths. Source,
Git, dirty/unpublished changes, coverage evidence, compiled Next.js outputs and
preview/action metadata never enter this cache-only removal set. Broken Git,
warnings about missing object lenders, shared references, recent activity,
unknown ownership and incomplete probes retain the candidate. The helper does
not repair or infer lost Git metadata and makes no publication claim.

The temporary cleaner delegates recognized `node-compile-cache` directories to
the same helper. Only single-link, owned files with the observed Node cache
header, hexadecimal name and version/architecture directory layout qualify.
Old files need six hours of both mtime and ctime; fresh files and the cache root
remain. Whole-cache process/CWD/open-file probes run before the bounded batch,
and file/parent identities are rechecked before fd-bound staged unlinks. Unknown
data or an absent helper has no generic deletion fallback.

`cache-reclaim:` JSON receipts include inspection duration, bytes/entries read,
per-target removal/retention reasons and filesystem free bytes before/after.
The `inspection` object reports stage/root, each root's elapsed time, inspected
entries, enumerated children/directories, symlinks, completeness and errors,
plus the exhausted limit. An enumerated child rejected at the entry boundary
is counted as enumerated but not inspected. Discovery/reference/evaluation
completeness are separate; `referencesRequired: false` is not a successful
reference scan. Known unprocessed targets have explicit `deferred` KEEP rows
and a deferred count. Incomplete discovery reports an unknown (`null`)
undiscovered-candidate count, not zero. These receipts show bounded progress,
not proof of real-world reclaim effectiveness or cross-account visibility.
Listed path allocation and net free-space change are separate measurements.
Staging races restore data; a completed deletion whose final source verification
is unavailable is reported as `removed-unverified` with a nonzero exit, never as
a successful retention or certified removal.

Fresh `git ls-remote` advertisements establish recoverability. Current heads/tags
can prove ancestry when their commit objects are available locally; PR head refs
can prove the exact pushed tip even after its branch was deleted. Cached
remote-tracking refs, a task trailer, missing metadata, and a rescue archive are
not permission to delete. An unavailable remote fails closed. Publication is
cached only within a pass and refreshed before deletion.
Git object reads never hydrate partial clones: lazy fetching is disabled, and
older Git without that control holds promisor repositories before reading their
objects. The janitor does not fetch objects or update remote-tracking refs.

Protected operator clones, seed stores, dirty/unpublished work, unknown ignored
data, broken Git pointers and unreadable safety probes stay put.
Patch/diff files, rejected hunks and original-file backups are retained evidence,
not generic data-only scratch, even when they are outside a Git checkout.
Mac standalone object stores remain conservatively held because borrowers can live in another
account. Azure also checks configured-root alternates and linked registrations;
all local refs and reflog-only commits must be published before clone removal.

Each account writes human logs plus a tab-separated decision receipt at
`~/.local/state/remudero/janitor-decisions.tsv`. Columns are timestamp/PID pass ID, UTC time,
action, reason code and escaped complete message. These first five columns keep
their existing positions; appended columns contain observed allocated bytes (or
`unknown`) and the measurement scope. Existing successful size probes are reused;
reporting never walks a directory to obtain missing sizes. Tabs/newlines/percent
signs in messages are escaped. Each pass summarizes skip counts, known observed
bytes and unknown-size counts by reason. These observations can overlap and do
not prove a unique skipped-byte total or complete discovery. Cache-helper
decisions also enter the receipt; partial/unverified removals remain informational
with an explicit uncertainty reason, not completed removals. A Git-unknown
hold needs its original object store restored or an operator-reviewed recovery;
an unpublished hold needs its work deliberately published, not forced cleanup,
unless the account opts in to the preserve-then-retire phase below.

Azure installs the shared guard through `deploy/install-host-units.sh` and records
the same receipts. Broad temp globs route Git-containing units through these
guards instead of recursively deleting them. Operator ruling 2026-10-23: preserved
and archived copies of unpublished work expire after 7 days, the Mac's
preserve-retire `retain_days`. The Azure janitor expires the worktree archive
(`/mnt/rmd/host-cleanup-worktree-archive`), the dated archives under `/mnt/rmd/archive`
and `/mnt/rmd/host-cleanup-archive`, and its own preserved copies, entry by entry
(a top-level file, or one entry inside a top-level folder, unchanged by mtime and
ctime for `RMD_CLEANUP_RETAIN_DAYS`). It never touches `host-cleanup-validation-bundles-*`
or anything outside those roots. Transcripts in `/mnt/rmd/host/archive` keep their
30-day `ARCHIVE_DAYS`. Until 2026-10-23 the janitor's default archive path was
`/mnt/rmd/host-cleanup-archive`, which held no transcripts, so that expiry never ran.

The Azure janitor also runs the preserve-then-retire design below on the host's own
roots: the worktree roots, `/mnt/scratch` with its `o/`, `tmp/` and `rmd-work-tmp/`,
`/mnt/rmd/tmp`, `~/rmd-state2/tmp` and `/tmp`. It does that inside
`deploy/rmd-host-cleanup.sh`, which also runs from stdin, and not through
`preserve-retire.py`, whose roots must live inside the home. Copies go to
`/mnt/scratch/host-cleanup-preserved/<path>@<UTC>`, on the scratch disk rather than
the full state disk. A folder of units that is held only because a child is live,
open, mounted or otherwise held is descended, so each child is judged on its own.
A folder holding an instance's protected checkout (`rmd/<key>/remudero` or `serve-repo`)
is held whole. The 6-hourly service-user pass judges only what that user owns;
the hourly root pass sweeps temporary/scratch roots and also runs retention.
Docker and containerd stores are held by name even when idle; nested coverage and
dump housekeeping leave their data intact.

The service-user pass obtains its open-file
view with noninteractive `sudo -n -- /usr/bin/lsof`; the root pass reads it directly.
An explicit `RMD_CLEANUP_LSOF` command is used unchanged, never automatically run as
root. A failed process snapshot, any unsuccessful open-file scan (even one that
prints paths), or permission-denied process paths retain every candidate and name
the failed probe. Missing privilege never falls back to an account-only view.

Dump housekeeping follows the Mac rule
below: only a file of at least `dump_min_mb` is a dump, and only a `.gz` or `.zst` the
janitor wrote (its receipt `janitor-compressed.tsv`) expires in compressed form. Nothing
in a repository or an installed package or toolchain tree is touched: a venv (`pyvenv.cfg`),
`site-packages`, `lib/pythonX.Y`, a prefix install with `lib/pythonX.Y/`, `*.dist-info`,
`node_modules`, cargo or Go module caches. A keep marker whose first line is
`keep-until: YYYY-MM-DD` (or JSON `"until"`) lapses after that date; one without a date is
honoured and listed once a pass as `MARKER … days old`. By operator ruling 2026-10-23,
`/mnt/scratch/rmd-qa-namespace.ulkfFP`, an active operator session's namespace, has
only its idle `operator/wt-*` worktrees and top-level `tmp`, `tmp-*` and `t3.*` retired.
Everything else in it is kept, with no dump action, and each pass logs `MARKER-RULING`. In `/mnt/rmd/agent-codex/sessions` it never deletes, and it compresses idle
sessions to `.jsonl.zst` with zstd instead of gzip: Codex resumes `.jsonl` and
`.jsonl.zst`, but not `.jsonl.gz`.

## Preserve-then-retire (opt-in per account)

The holds above are permanent on their own: an account that is never cleaned by hand
accumulates unpublished, dirty and ignored checkouts until the disk is full. On
2026-10-20 one Mac account reached 0 GiB free with about 46 GiB of such checkouts and
bare origins, and every janitor pass reported `removed=0`.

`preserve-retire.py` runs as the last phase of every pass. It does nothing until the
account writes an owner-private (0600) `~/.local/state/remudero/preserve-retire.json`
below private parents, for example `{"enabled": true, "idle_hours": 24, "retain_days": 7}`.
It scans `~/Remudero`, `~/rmd-work`, `~/.codex/work-artifacts`,
`~/Developer/remudero-operator-worktrees`, every `~/Developer/remudero-operator-recovered-worktrees-*`
every `~/Downloads/remudero-*` folder and `~/.local/share/remudero/source-recovery` (never
other `Developer` or `Downloads` content or protected roots), at most once every
`interval_hours` (default 6). A `roots` entry with `*` names every folder it matches.

`temp_roots` (default none) adds folders under `/private/tmp`, for example
`["remudero-*", "rmd*"]`. macOS on this host has no periodic `/tmp` cleaner, so agent scratch
there lasts until a reboot: on 2026-10-23 one `remudero-pr-queue-*` folder held 7.9 GiB, 5.6 GiB
of it in 60 subfolders idle for over six hours. A match counts only when this account owns it
and it is not a symlink. Worktrees, clones and bare repositories there are preserved and retired
like any other. Until 2026-10-25 a clone or bare repository in a root other accounts could enter
was held (`shared-temp-root`). Agents create those roots with mode 755, so every such clone was
held forever: 907 held, about 6 GiB, on that day. A lender in `/private/tmp` cannot be relied on
by any account, because macOS clears it at boot, and the borrower census still keeps a temp
lender of this account's own kept clones. Preserved copies are named `tmp__<path>@<UTC>`.

A checkout, standalone clone or bare repository is a candidate when nothing in it
(dependencies included, its own Git metadata excluded) changed in `idle_hours` by
mtime or ctime, its HEAD did not move, no command line names it, and no open file or
cwd is inside it. For each candidate it saves, under `~/Remudero-preserved/<path>@<UTC>`:
a bundle of every commit not in published `main` (detached HEAD, tags and stash
included), verified in the source or a published base; the `git diff --binary HEAD`
patch; a tarball of untracked and ignored files without `node_modules`, `coverage`,
`dist`, `.turbo` and `.next`; every ref in `refs.txt`; and `MANIFEST.txt` with restore
steps. "Published" means the first-parent history of each published remote's current
`main` (fresh `git ls-remote`), or a cached `origin/main` of a published remote.

Every candidate is preserved before any is deleted, and the keep set is recomputed
afterwards, so a borrower whose copy failed keeps its object lender. A clone or bare
repository is deleted only when no other account can enter the home (mode and ACL)
and a complete borrower census of the home and both temp folders (`/private/tmp` and
`$TMPDIR`) found no kept borrower; agent clones in `/private/tmp` borrow from each other. These are held
for a person and never retired: unreadable history (missing worktree Git dir or
alternate object store), a locked worktree, an untracked file over `max_untracked_mb`
(default 50), a foreign owner, and any failed probe. Each candidate is checked again
for activity just before removal. Worktrees go through `git worktree remove --force`,
then `git worktree prune`. Copies older than `retain_days` are expired; folders the
phase did not stamp are never touched. After expiry, unpublished work exists nowhere
else, so set `retain_days` to how long you might want it back.

The same pass then does housekeeping that changes no history. On 2026-10-21 one
clone held 8.6 GiB in 1,640 packs (repeated fetches with automatic gc off) that repacked
to 111 MiB, and agents had left 16 GB of JSON and log dumps beside their checkouts:

- A repository under the roots with `repack_min_packs` (default 50) or more packs is
  repacked with `git repack -a -d -l --keep-unreachable`, kept or active ones included:
  no object is dropped, and borrowed objects stay with their lender.
- Outside any repository, a `.json`, `.jsonl`, `.ndjson`, `.log`, `.lcov` or `.info`
  file of at least `dump_min_mb` (default 5) idle for `idle_hours` and not open is
  gzipped beside itself after a full read-back; its modification time is kept. A dump in
  either form unchanged for `dump_retain_days` (default 7) is deleted. A smaller plain file, any
  file in a folder holding `package.json`, and anything inside an `.app`, `.framework`,
  `.xcframework` or `.bundle` is never a dump (the first rule, 2026-10-21, would have expired
  `package.json` files and a cached Chrome for Testing app).
- Outside any repository, an idle, unopened `node_modules` is removed, and so are
  `coverage`, `.turbo` and `.next` beside a `package.json`; elsewhere those names may be
  fixture data. Symlinked folders are never followed.
- With `codex_session_days` set (default 0, off), Codex session logs
  (`~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions`) unchanged for that
  many days and not open are deleted. Archiving a thread in Codex keeps its log on disk, and its
  history database (`thread_history_*.sqlite`) is Codex's own and never touched.

Keep declarations hold every action of this phase. A path is held when any of these is on it,
on any folder above it, or anywhere inside it: `.rmd-janitor-keep`, `.rmd-scratch-keep`,
`.rmd-dependency-seed-root.json` (in any form, including a dangling symlink), or a seed
generation's `ready.json` beside `consumers/`. A path whose markers cannot be inspected is held
too. A held path is never retired, repacked, worktree-pruned, compressed, expired or removed.
A worktree is also held when its store is held. Seed stores are collected only by the
reference-aware sweeper below. On 2026-10-24 the loose-folder rule had removed two recovered
seed generations' `node_modules` under `~/.local/share/remudero/source-recovery`.

The janitor also runs `~/.local/bin/remudero-dependencies sweep --apply` on every apply
pass when that tool is installed (see `deploy/DEPENDENCY-SEEDS.md`).

The janitor's human log now rotates at 16 MiB, keeping one previous generation.

The final `=== done:` line counts successful artifact removals, published worktree
removals and preservation retirements together in `removed`. The
`preservation-status`, `preservation-retired`, `preservation-held` and
`preservation-planned` fields expose the last phase separately. A failed helper or
unreadable terminal summary reports unknown counts and `removed-complete=no`;
`removed` then includes only confirmed earlier removals. Disabled and throttled
passes report zero retirements, with held repositories unknown because no scan ran.

`reclaimed-scope=legacy` makes the existing byte estimate's scope explicit: it
excludes the preservation phase. The `free=before->afterGiB` readings cover the
whole pass and can also reflect concurrent writers. `planned` retains its legacy
scope; `preservation-planned` is separate and can overlap with those dry-run plans.

## Session and process reaper (Azure)

`deploy/rmd-session-reaper.sh` runs hourly as root on the Azure host, from
`rmd-session-reaper.timer`, which `deploy/install-host-units.sh` installs and checks for drift.
It appends to `~/session-reaper.log` and keeps CPU observations in
`/var/lib/rmd-session-reaper/`. `DRY_RUN=1` logs every decision and changes nothing:
`ssh remudero 'sudo -n env DRY_RUN=1 bash -s' < deploy/rmd-session-reaper.sh`.

**The incident.** At 2026-10-20 00:06:33Z a `systemctl daemon-reload` took 208 s under memory
pressure, and PID 1 logged `systemd-logind.service: Unexpected error response from
GetNameOwner(): Connection terminated`. logind lost its subscription to PID 1's unit and job
signals. It had logged `Removed session` 2,152 times before then and never once after. Every SSH
logout left a session in `State=closing` whose scope unit was already gone; `loginctl
terminate-session` could not finish them. By 2026-10-23 there were 3,073 such sessions:
`uptime` counted 3,056 users while `who` showed none. At about 650 a day, logind's default
`SessionsMax=8192` would eventually have refused new SSH logins. A logind restart re-subscribes
and drops every session whose scope is gone.

The same host also held processes leaked from long-closed sessions, re-parented to PID 1: a
forgotten `docker logs -f` pipeline (10 days old) and test `node` processes whose working
directory was a deleted `rmd-reader-runtime-*` temp dir (6 days old).

**What a pass does.**

1. *Leaked processes.* It reads only processes in a `session-*.scope` cgroup. Builder
   `run-*.scope` jobs, containers, services and `user@.service` are never read. It stops a
   process (SIGTERM, then SIGKILL after a grace) only when all of these hold:
   - its session is closing, unknown to logind, or has a dead leader;
   - its parent is PID 1, or it descends from such a process in the same scope;
   - it is not sshd, systemd or logind, and no terminal multiplexer (tmux, screen and the like)
     sits above it, because a detached tmux is the operator's live work;
   - its cwd is deleted, or it provably used no CPU for six hours.

   The kernel's `se.exec_start` for every thread proves no CPU use on the first pass. Without
   that record, the proof is utime+stime unchanged since the reaper's own observation six hours
   earlier. Only comm and exe are logged, never a cmdline or environment.

   A descendant of a root stopped in the same pass is stopped with it, even while it uses CPU,
   when its stdout reaches nobody: a pipe or socket that no process outside the subtree holds, a
   deleted file, or a tty that no longer exists. That is the measured `docker logs -f | tail`
   pipeline, whose output pipe only its own bash and tail held. A descendant writing to an
   existing file, or read by an outside process, is a deliberate watcher and stays.
2. *Orphan sessions.* A session is a proven orphan when it is closing, its scope is gone, no
   process is still in the scope's cgroup, and nothing but logind holds its
   `/run/systemd/sessions/<id>.ref` fifo. One proven orphan is enough to restart logind, once per
   pass. The pass then checks that logind is active and that the session count dropped. If
   either check fails, it logs `REFUSE` and exits non-zero.

Every pass also logs how long ago logind last logged `Removed session`. A growing age while people
log in and out means logind has stopped finalising sessions again.

**The alarm.** `scripts/fleet-heartbeat.sh` publishes `session_reaper_verdict` from the log's last
pass and from `systemctl show rmd-session-reaper.service`. It reads `REFUSED` when the pass logged a
REFUSE, `INCOMPLETE` when the pass never reached its summary line (or was already running at the
previous beat), and `FAILED` when the unit's last result was not success. Any of the three raises
the `REAPER_ALARM` arm in `fleet-heartbeat-watch.yml`, which files that host's needs-human issue.
`ok`, `running` and `unknown` (no reaper on the host) are silent.


### Declarations that arrive during a pass

Discovery-time absence of a keep declaration is not permission for a later action.
Immediately before checkout removal, worktree pruning and repacking, preserve-retire
rechecks the common store and its registered worktrees, including worktrees outside
the discovery roots. An unreadable or malformed worktree listing holds the store.
Previously observed holds remain held for the pass. Unmarked stores retain their
ordinary eligibility, activity and preservation guards. This is a fresh pre-action
check, not an atomic lock against another process creating a marker after that check.

### The installed account hold is independent of invocation policy

Every maintained preserve-retire action rereads the running account's default
`~/.local/state/remudero/preserve-retire.json` and requires its owner-private
`enabled: true`. Account identity comes from the OS user database, not `HOME`,
`--home` or `--config`. Those arguments cannot replace a disabled account hold.
Missing, unsafe, malformed, oversized or unreadable hold evidence refuses action.
Preservation output and stamps are gated too; an unfinished copy or compression
artifact is retained if the hold activates during work. A started filesystem or
Git operation is not interrupted; the next action rechecks the hold.

Disposable tests substitute the OS account-home resolver only inside an imported
test module. No production environment variable, CLI flag or alternate config
unlocks that resolver. Updated maintained routes do not constrain old standalone
copies or arbitrary same-account Python code. Keep old copies unused, both account
holds disabled, and require separate explicit release after qualification and
installation; code installation does not enable either account.

Preservation Git copies are self-contained: the stable `unpublished.bundle` name now
contains the complete object closure of every recorded ref and HEAD, including custom
checkpoint, remote, tag and non-commit refs. Published-main counts remain diagnostic
only. Before retirement, the helper unbundles into a new empty store, recreates every
saved ref and HEAD, compares its exact object set and runs full Git integrity checks.
No upstream or source-store object can satisfy that qualification. Ref or symbolic-HEAD
changes during preservation or before retirement retain the source. Shallow/unsupported
object formats and insufficient space for both the complete bundle and independent
verification store retain it too. The bundle reuses stored deltas, so it is about the
size of the source pack: the space bound counts each object at its stored size when its
delta base is in the saved closure and at its full size otherwise, and space for the
verifier store is checked again against the bundle's real size before qualification. This covers recorded Git roots, not unreferenced
objects or a byte-for-byte copy of the index, reflogs, configuration or working files;
patch and untracked-archive preservation remain separate. Installation never releases
an account's disabled hold.
