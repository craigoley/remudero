# Worker bash-snapshot isolation on the Azure host

Record for W1-T11909. It is read-only evidence: no source, test, probe, wrapper-list or host file was
changed to produce it. Every ledger row below is quoted from `state/ledger.ndjson` on the host
`Remudero`, observed 2026-11-10 08:36–08:40Z.

Verdict up front: the shipped CLI's isolation probe now reports 0 aliases and 0 functions on real,
non-reused probe executions, with `/etc/profile.d/gawk.sh` untouched. One condition in the task's own
falsifier is NOT met, so `W1-T11891` is left blocked. The reason is under `## W1-T11891 unblock`.

## Failing baseline

Two native runs failed closed in the isolation preflight with the same six functions, none of them
aliases. Both rows are `step:"verdict"`, `guard:"isolation"`, `check:"inherited-functions"`:

```
{"ts":"2026-11-08T07:27:39.156Z","run_id":"W1-T11687-1794122603696","task_id":"W1-T11687","step":"verdict",
 "verdict":"blocked_isolation","observed":"0 aliases, 6 functions",
 "reason":"isolation_preflight_failed: worker inherited 0 alias(es) and 6 function(s)
 [gawklibpath_append gawklibpath_default gawklibpath_prepend gawkpath_append gawkpath_default gawkpath_prepend]
 from operator shell state — ... FAIL CLOSED, the run does not proceed"}

{"ts":"2026-11-09T19:31:52.758Z","run_id":"W1-T11891-1794252506105","task_id":"W1-T11891","step":"verdict",
 "verdict":"blocked_isolation","observed":"0 aliases, 6 functions",
 "reason":"isolation_preflight_failed: worker inherited 0 alias(es) and 6 function(s)
 [gawklibpath_append gawklibpath_default gawklibpath_prepend gawkpath_append gawkpath_default gawkpath_prepend]
 from operator shell state — ... FAIL CLOSED, the run does not proceed"}
```

Both rows: `alias_count` 0, `function_count` 6, `function_names` the six `gawk*` names above.

## Host profile unchanged

Observed read-only on 2026-11-10, during the probe window (~08:36Z):

```
$ ls -la --time-style=full-iso /etc/profile.d/gawk.sh
-rw-r--r-- 1 nobody nogroup 757 2026-07-20 22:38:24.000000000 +0000 /etc/profile.d/gawk.sh
$ sha256sum /etc/profile.d/gawk.sh
70621a3b586d3d523b020e76977633b444a70013ba50e1ea901a3a07a676f15f  /etc/profile.d/gawk.sh
$ grep -n -E '^gawk[a-z]*_(default|prepend|append) \(\)' /etc/profile.d/gawk.sh
1:gawkpath_default () {
6:gawkpath_prepend () {
11:gawkpath_append () {
16:gawklibpath_default () {
21:gawklibpath_prepend () {
27:gawklibpath_append () {
```

- The file is present and still defines all six names.
- Its mtime (2026-07-20) predates both baseline failures and the probe, so it was not edited in between.
- `/etc/bash.bashrc` mtime is 2024-03-31. No host profile or bashrc was edited for this record.
- The fix lives in the generated worker home instead. This run's `~/.bash_profile`, written 08:36Z
  by the worker-home generator, starts with `unalias -a`, then defines and calls
  `_rmd_clear_host_profile_functions`, which runs `unset -f` over `compgen -A function`. The system
  profile still runs first and defines the six functions; the worker profile then clears them.

## Fresh native probe

Four `step:"isolation.probe"` rows exist in the live ledger. Each carries a non-zero `cost_usd`, which a
reused PASS cannot, and a search for any isolation reuse row returned nothing, so none of these is a
cached verdict. Two are on this host for this task's own runs (the other two are on the container host
`06936af32bc5`, for W1-T11261 and W1-T11795):

```
{"ts":"2026-11-10T08:29:13.053Z","host":"Remudero","run_id":"W1-T11909-1794299001490","task_id":"W1-T11909",
 "step":"isolation.probe","isolated":true,
 "reason":"worker reports 0 aliases and 0 functions inherited (alias=0, functions=0)",
 "alias_count":0,"function_count":0,"alias_names":null,"function_names":null,"cost_usd":0.0425283}

{"ts":"2026-11-10T08:35:52.705Z","host":"Remudero","run_id":"W1-T11909-1794299436370","task_id":"W1-T11909",
 "step":"isolation.probe","isolated":true,
 "reason":"worker reports 0 aliases and 0 functions inherited (alias=0, functions=0)",
 "alias_count":0,"function_count":0,"alias_names":null,"function_names":null,"cost_usd":0.030871299999999997}
```

The 08:35:52 run then moved on to worker execution, 15 seconds later:

```
{"ts":"2026-11-10T08:36:07.878Z","host":"Remudero","run_id":"W1-T11909-1794299436370","step":"worker.assignment", ...}
{"ts":"2026-11-10T08:36:11.651Z","run_id":"W1-T11909-1794299436370","step":"worker.activity","event_kind":"tool-executing", ...}
```

A direct check from inside that worker agrees: `declare -F | grep -c gawk` printed 0 and `alias | wc -l`
printed 0.

Deployed commits, from the live `deploy.skip` rows at 08:20–08:34Z:

- install checkout HEAD: `4a5d3a2d7`. It contains both `971524cf1` (W1-T11693, `src/lib/worker-home.ts`)
  and `fd7f57a0e` (W1-T11908, `test/worker-bash-snapshot-isolation.test.ts`).
- running daemon head: `4d1188d3d779d64f14971f99aab12f27b44c76bf` (2026-11-10T04:01:31Z). It contains
  `971524cf1` but NOT `fd7f57a0e`. Every `deploy.skip` row reports it as `stale_running_daemon`.

Which of the two commits produced the 08:35:52 probe was not established. The probe ran in a run-task
process whose code source is not recorded in the row.

## W1-T11891 unblock

Did the probe pass? Yes, on every real probe execution quoted above: 0 aliases, 0 functions, and the run
proceeded to worker execution with `/etc/profile.d/gawk.sh` unchanged.

Is `W1-T11891` unblocked by this record? No, not yet. The task's falsifier says the record is wrong if
the deployed commit predates W1-T11693 or W1-T11908. The running daemon head `4d1188d3d` contains
W1-T11693, which is the source fix, but predates W1-T11908, which is test-only and adds no source change.
Read strictly, the deployed-commit condition is unmet, so this record does not clear `W1-T11891` to dispatch.

To close the gap, nothing in this task needs to change. Once the daemon recycles onto a head at or after
`fd7f57a0e`, one further governed native dispatch whose `isolation.probe` row shows `alias_count` 0 and
`function_count` 0 satisfies the condition, and `W1-T11891` may then dispatch. If that row ever shows a
non-zero count, quote the names here and keep `W1-T11891` blocked. That outcome would mean the shipped CLI
builds its snapshot at a point the W1-T11693 profile does not reach, and the remedy is to amend W1-T11908's
harness and fix the source. No probe exclusion is ever the remedy.
