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

The installer also installs `cache-reclaim.py` and `retire-legacy-sweeper.py` in
both layouts. `--retire-legacy-sweeper` is an explicit additional installer option,
composable with `--shared`. It disables future launch admission only for the
known `com.craigoley.disk-sweep` job after verifying its exact plist arguments,
ownership and historical script hash. The plist is retained with a disabled
suffix. It never stops a running process, changes cron entries, or retires an
unknown/replaced job. Ordinary code-only installation does not change schedules.

The scan includes `~/Remudero`, nested disposable checkouts below the protected
operator checkout `~/Remudero/remudero`, `~/rmd-work`, and temporary roots. Git
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

The regular janitor additionally inspects this account's `.codex/work-artifacts`
for exact ignored package duplicates and `.next/cache/turbopack` compiler data.
Each invocation uses one account lock and serial probes. Inspection is bounded
to 45 seconds, 500,000 entries and 2 GiB of content reads; budget exhaustion is
a typed keep decision. Already admitted staging finishes or restores safely.
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
action, reason code and escaped complete message. Tabs/newlines/percent signs in
messages are escaped. Each pass summarizes skip counts by reason. A Git-unknown
hold needs its original object store restored or an operator-reviewed recovery;
an unpublished hold needs its work deliberately published, not forced cleanup.

Azure installs the shared guard through `deploy/install-host-units.sh` and records
the same receipts. Broad temp globs route Git-containing units through these
guards instead of recursively deleting them. Older orphan archives never expire
automatically: they may contain the only surviving unpublished work.
