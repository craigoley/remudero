# Account-aware workspace retirement

Install code with `bash deploy/mac/install-janitor.sh`. This preserves the previous
script and installs both guards beside `~/bin/remudero-janitor.sh`; it does not
change schedules. Existing Craig launchd and agent cron jobs can use the same
binary: account paths are derived from the account running it.

Run `~/bin/remudero-janitor.sh --dry-run` before `--apply`.

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
A shell in the operator checkout does not hold every nested disposable worktree;
specific job-parent/child CWDs still do. Git-tracked nested directories and
submodule/gitlink sources are never retired.

Fresh `git ls-remote` advertisements establish recoverability. Current heads/tags
can prove ancestry when their commit objects are available locally; PR head refs
can prove the exact pushed tip even after its branch was deleted. Cached
remote-tracking refs, a task trailer, missing metadata, and a rescue archive are
not permission to delete. An unavailable remote fails closed. Publication is
cached only within a pass and refreshed before deletion.

Protected operator clones, seed stores, dirty/unpublished work, unknown ignored
data, broken Git pointers and unreadable safety probes stay put. Mac standalone
object stores remain conservatively held because borrowers can live in another
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
