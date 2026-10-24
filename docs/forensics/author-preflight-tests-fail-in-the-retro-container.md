# Author preflight failures in the retro container

The daemon-specific cause remains unproven: the checked code exposes a process-group closure lead, but this worker cannot read the live failure evidence or reproduce the daemon environment.

Investigation: W1-T10300, 2026-10-23. Source and local `origin/main` both identify
`b452cccc2f0d5a72979501aaa2b9da9b704218b7`. This is an incomplete diagnosis, not
evidence that the tests have recovered. Runtime observations below describe this
worker's sandbox unless explicitly attributed to the task record.

Before editing, read `CLAUDE.md`, `AGENTS.md`, and the task shard. The shard at the
source SHA was also retrieved through GitHub. It contains no numbered file:line
citations. Both quoted test titles still exist, `MAX_FAILING_TESTS` remains 20,
and the two suites contain 31 and four top-level tests respectively. The requested
document was absent; all three acceptance grep commands exited 2 for the missing
file, rather than producing an executed proof. Adding the requested headings
alone cannot establish the substantive acceptance claims.

## Failure text

**Unavailable: acceptance criterion 1 is unmet.** No post-W1-T10298 daemon failure
row or reproduction matching the daemon environment was available to this worker.
The permission profile prohibits reading `/home/node/Remudero/state`; no attempt
was made to read it through another path or interface. Docker is not installed in
the worker's command path, so the live daemon cannot be inspected here.

READ, historical evidence reported by the task shard, not independently replayed:

| Reported time | What the record actually supplies |
| --- | --- |
| 2026-10-19T15:49Z | 20 capped author test names; no error blocks |
| 2026-10-20T06:31Z | 20 capped author test names; no error blocks |
| 2026-10-20T16:50Z | One failing name; no error block |
| 2026-10-20, exact reproduction time unspecified | A no-tini reproduction, 35 tests / 23 pass / 12 fail, with the generic message below |

The task shard quotes this reproduction message:

```text
native calibration failed or incomplete; evidence retained in
coverage/rmd-native-runtime-*
```

This quotation is neither a per-test TAP diagnostic nor a newly observed retro
error. It cannot be assigned to each historical failure. The coordinator's count
of 26 and the capped lists do not identify 26 error blocks.

READ, [`calibrateAuthorRuntime`](../../scripts/calibrate-author-runtime.mjs)
retains `sample.stdout.log`, `sample.stderr.log`, and
`sample.native-result.json` before emitting that generic exception.
[`completeTestResult`](../../scripts/preflight-author.mjs) rejects nonzero exit,
signal, capture error, incomplete output, or absence of positive tests/pass and
zero-fail summaries. The generic message therefore does not isolate an assertion
failure, a capture failure, or descendant teardown.

OBSERVED through GitHub's PR metadata: [PR #13744](https://github.com/craigoley/remudero/pull/13744),
W1-T10298, merged at `2026-10-23T14:26:38Z` as the source SHA above. Its last body
line names W1-T10298, not W1-T10300. It improves retained diagnostic excerpts;
its merge does not establish that a later retro has failed or passed. A search
for the W1-T10300 trailer returned no PR; the W1-T10298 search found #13744 as a
positive control for repository access. Search visibility is not a complete
merged-task census or a substitute for the missing runtime evidence.

## Environment difference

READ means inspected current source; OBSERVED means measured in this worker.
No row in this table claims a measurement of the running daemon container.

| Dimension | Evidence at this source SHA | Remaining daemon comparison |
| --- | --- | --- |
| PID 1 and reaping | READ: [`deploy/Dockerfile`](../../deploy/Dockerfile) declares `tini -- /usr/local/bin/rmd-entrypoint`. OBSERVED: this worker's `/proc/1/comm` is `codex-linux-san`, not tini. | Deployed image digest, actual PID 1, subreaper settings, and zombie ownership were not observed. An image declaration is not deployment evidence. |
| Process tree depth | READ: the supervised path in [`entrypoint.sh`](../../deploy/entrypoint.sh) starts `"$@" &` and waits for `child_pid`. [`runAutomatedRetroSubprocess`](../../src/lib/retro-subprocess.ts) starts a separate retro process; [`runAttempt`](../../src/lib/retro-preflight.ts) invokes the retry wrapper and native test runner. Author fixtures add capture helpers and their own children. | A direct image probe need not reproduce the waiting shell, detached groups, parent tracking, or daemon ancestry. The shell's presence alone does not prove that orphan reaping fails. |
| CPU and cgroup | OBSERVED: worker `/proc/self/cgroup` reads `0::/`; `cpu.max` reads `max 100000`; `memory.max` reads `9248440320`; Node is `v24.21.0`, matching `.nvmrc`. READ: slot concurrency is calculated from CPU/load and memory inputs. | Daemon cgroup membership, quota, throttling counters, pressure, and sibling workloads are unavailable. The task's historical 0.4-CPU pass is not a current measurement. |
| Environment | READ: retro inherits the daemon environment and adds `RMD_SELF_SYNC_DONE=1`; preflight `commandOptions` deletes that guard. `authorEnvironment` clears `NODE_TEST_CONTEXT`, blanks `NODE_V8_COVERAGE`, and removes repository-local Git overrides. `runtimeBindings` refuses nonempty `NODE_OPTIONS`. OBSERVED: those four Node/self-sync variables are absent in the worker parent. | Compare the actual child's relevant variables without dumping secrets. A command-line heap flag on the retro process is distinct from an inherited `NODE_OPTIONS` value. |
| Worktree and Git | READ: preflight commands use `worktreePath` as cwd. Author fixtures create their own committed repositories and link dependencies; native calibration requires a clean tree and the pinned Node version. OBSERVED: the worker is a linked checkout, with its Git administrative directory outside the worktree. | The daemon worktree's `.git` target and dependency symlink must resolve inside its namespace. The historical mount's “not a git repository” text is a topology confound, not evidence against the tests. |
| Test admission | READ: retro acquires a slot asynchronously, passes `slot.childEnvironment`, applies `lowPriorityCommand`, and releases in `finally`. `resolveTestSlotDir` isolates native test children carrying a parent marker; `inheritedTestSlot` does not borrow a parent when `NODE_TEST_CONTEXT` is set. OBSERVED: worker `RMD_TEST_SLOT_DIR` is present and `RMD_TEST_SLOT_PARENT` is absent. | Capture the actual retro slot outcome, concurrency, wait, priority, directory scope, and validated parent marker. Merely specifying concurrency 1 does not reproduce slot inheritance. |

READ, the concrete process-group lead is in
[`captureStepSync` and its spooler](../../scripts/lib/author-step-capture.mjs).
The spooler starts an owned detached process group, waits for the leader's
`close`, then probes that group using `process.kill(-child.pid, 0)`. If the group
remains present after the two-second natural-drain grace, it records:

```text
native leader closed with live descendants
ERR_AUTHOR_DESCENDANTS_ALIVE
```

These are source literals, not observed failure text. That probe does not read
member process states, so by itself it cannot distinguish running descendants
from unreaped zombies. A leader can exit 0 and its TAP can report zero failures
while capture still returns `outputComplete: false`; calibration then throws the
generic exception. This mechanism is consistent with the historical no-tini
lead, but no native-result receipt connects it to the daemon's author failures.

## Reproduction

**Unavailable: acceptance criterion 2 is unmet.** No same-SHA passing/failing/
restored trio has been observed. The historical five-run comparison in the task
record supplies useful leads but no independently inspected logs or bound source
SHA here; it must not be relabeled as this worker's reproduction.

OBSERVED, a local control was requested on the unchanged source SHA after both
physical test paths were checked:

```sh
TMPDIR=/tmp/rmd-t10300-o0JoOp node --import tsx scripts/test-run.mjs \
  --test --test-concurrency=1 --test-reporter=tap --import tsx \
  --import ./test/setup/tmp-hygiene.ts \
  test/author-preflight.test.ts test/author-workflow-contract-precheck.test.ts
```

At `2026-10-23T14:45Z`, admission reported `test_slot.waiting` for `test:npm`
against `/home/node/rmd-scratch/test-slots`, naming two occupied
`preflight-author:static-and-affected` slots. The waiting command was interrupted
with exit 130 before it emitted any TAP or test summary. This is **NOT RUN**,
neither 35/35 nor an author-test failure. No parallel test run was started and no
holder or shared slot was altered. The private scratch is disposable after these
observations are saved in this record.

OBSERVED, a slot subsequently became available. A second request, using the same
command with `timeout --signal=INT 240s` before `node`, completed on
2026-10-23 at approximately 14:52Z, exit 0. Admission acquired slot 2/2 with
`nice+ionice` and concurrency 1. The runner's final summary was:

```text
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 57170.944408
```

This is a current passing worker control on the source SHA named above, with only
the forensic document and generated docs index edited. It includes the real
native-calibration fixture. It is not a daemon-container reproduction. In
particular, a worker pass with PID 1 named `codex-linux-san` shows why the absence
of the executable name `tini` alone cannot diagnose the failure; actual reaping
behavior still needs measurement.

The missing discriminating comparison must hold source, dependencies, worktree
visibility, slot, environment, and test argv fixed. First obtain a passing run
under the observed daemon ancestry; vary only the suspected reaping condition;
then restore it and require a second pass. For every failed capture, correlate
the TAP block with its native-result error and the owned PGID's PID/PPID/state
snapshot. A reproduction that only matches the generic exception does not yet
match the retro's failure.

## Remedy proposal

Proposed follow-on harness task, conditional on the native-result evidence:
make owned descendant closure distinguish unreaped zombie-only groups from
running descendants, and cover the distinction with a real reaping/non-reaping
fixture. Preserve the leader exit, completed output, and group-ownership checks;
continue refusing a live disconnected reader. The existing test
`a closed author leader cannot leave a disconnected reader group or certify success`
in [`author-step-capture.test.ts`](../../test/author-step-capture.test.ts) is a
required regression control, not an assertion to relax.

This proposal is appropriate only if the daemon's retained native results show
`ERR_AUTHOR_DESCENDANTS_ALIVE` and process-state evidence proves zombie-only
membership. If members are actually running, retain the refusal and repair the
producer's shutdown/reaping instead. If receipts show a different error, reject
this proposal and target that cause. A deployed process tree without the declared
init would instead justify an image/launch task verified from a fresh container.
There is no evidence here to choose either implementation as an established fix.
Every variant must execute both author suites without skips and show the same-SHA
pass/fail/restored controls. This diagnosis changes no test, gate, image, or
admission policy, and files no new task or acceptance criteria.

To complete this record, an operator must supply an authorized post-merge
`retro.preflight_failed` row with its timestamp and retained error blocks, the
corresponding native capture receipts, and a bounded environment/process snapshot
from that same run. Until then, criterion 1 and criterion 2 remain unmet even
though their heading grep proofs can resolve.

Validation of this document change: `comment-load-signal` passed over 923 measured
files; `source-size-ratchet` reported OK with zero changed source files, using
local `origin/main` at the stated SHA because its automatic refresh could not
write the read-only Git administrative directory. A fresh remote behind-count
was not established. `docs-index:check` and `docs-index:check-paths` passed after
regeneration. The actual `censusMembershipCommand` was called with both pending
changed paths explicitly, since the harness has not committed them. It selected
`test/the-knowledge-gardener-pins-its-own-retirement-golden.test.ts` and named
`test/docs-index.test.ts` as another text reader. Both physical files were
checked and run together at concurrency 1 through the admitted test runner:
exit 0, 36 tests, 36 pass, zero fail/cancelled/skipped/todo, 6473.371069 ms.
The three exact acceptance grep invocations now resolve their headings; they
do not supply the missing daemon evidence. All eight relative evidence links
resolve. No full CI-parity preflight or coverage run was performed.
