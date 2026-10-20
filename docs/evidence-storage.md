# Bounded, opt-in evidence storage

The Mac janitor can invoke an account-private evidence compactor during an apply
pass. The installer creates no schedule and its new policy defaults **off**.
This phase does not expire history, prune Git objects, delete dependency seeds,
edit Codex session files, change fleet admission or activate a runtime pilot.

## Install and inspect

Use the maintained source installer with Node 24 or later:

```sh
bash deploy/mac/install-evidence-storage.sh
"$HOME/.local/bin/remudero-storage-maintenance" --status
```

The installer preserves an existing policy. Its optional `--prefix` selects an
already-existing, physical, account-owned installation directory for packaging
and fixture verification; it never substitutes a different authentication home.

An operator separately chooses specific closed-evidence roots in the private
`~/.config/remudero/evidence-storage.json` file. Example disabled policy:

```json
{"schema":"rmd-evidence-storage/v1","enabled":false,"roots":[]}
```

Roots must be canonical paths below that account's home. Git metadata,
`node_modules` and Codex session/archive directories are refused. Do not add a
credential directory, a source tree being edited or a live logging directory.
Enabling a policy is distinct from installing source and requires its own
operator review. This change does not enable either profile's policy.

## Eligibility and resource bounds

Only direct, private, singly linked, account-owned regular evidence files are
considered. Both content and metadata must be idle for six hours. Artifact links,
foreign ownership, ambiguous open-file checks, recent activity and uncertain
parents cause retention, not removal. The helper does not recursively crawl a
checkout or infer that a clean Git tree is disposable.

One invocation examines one configured root, with at most 10,000 direct entries,
256 candidates, 45 seconds of inspection and a 1-GiB priced read budget. The
maximum single file is 256 MiB; its repeated reads must also fit the whole-run
budget. Normal native memory pressure is required. A currently admitted file's
bounded copy and read-back may finish after the inspection deadline; each native
copy has a 30-second timeout. These are phase bounds, not fleet reservations.

## Publication and failure semantics

The compactor opens and pins a non-following source descriptor. Apple's
`fcopyfile` API snapshots its data, ACLs and extended attributes into an exclusive
private file. `ditto` compresses that snapshot, never the mutable source name.
There is no package download, SDK/model call, native compilation or Linux
compression fallback. Missing OS helpers refuse the file.

Source identity and bytes, compressed bytes and metadata, open-file state and
the ordinary reader path are checked through retained descriptors. Publication
uses Apple's `renameatx_np(RENAME_SWAP)` under a pinned directory descriptor,
not an ordinary overwriting rename: even a newer atomic write in the final
check-to-publication interval retains its actual displaced inode. An original
recovery link also remains until the displaced original is verified unchanged
and unused after publication. A
late writer or incomplete read-back produces `UNKNOWN_AFTER_PUBLICATION` and
retains that recovery path; it never reports a lossless success or overwrites a
new public-path write. An operator must reconcile an UNKNOWN before any retry.
An exchange timeout or missing terminal receipt may be post-syscall: both names
are retained, with no fallback, cleanup of the displaced name or automatic retry.

No-op passes do not create another immutable raw receipt. Meaningful results and
incomplete/failed publication evidence remain private and retained; the current
root cursor is bounded state. Existing logs and failed receipts are not expired.
Finite raw-evidence retention and producer budgets are separate contracts.

## Qualification boundary

The focused suite verifies private ownership and six-hour rules, policy refusal,
real descriptor-based compression, pre/post-publication writers, another process
holding the file, and a quote-containing installer prefix. Unsupported platforms
exercise an explicit platform refusal, not a native compression success.

Source tests, fix-removal controls, local author results, hosted CI, independent
review, merged source and live policy activation are separate claims. Keep all
prior failed receipts. The ordinary author's 20-GiB reserve is not lowered by
this helper.

The metadata API is specified in Apple's maintained
[copyfile header](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.h)
and [rename manual](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2).
