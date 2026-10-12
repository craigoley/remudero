- **Main push runs are cancelled while PENDING, so most main commits never get a CI verdict — never
  read CANCELLED as red.**
  `.github/workflows/ci.yml` puts every run in the concurrency group
  `ci-${{ github.event.pull_request.number || github.ref }}`, and `cancel-in-progress` is true only for
  `pull_request`. So main's push runs share one group and are never cancelled while RUNNING. But
  GitHub keeps one running and one PENDING run per group, and each newer push replaces the pending
  run, which GitHub cancels.

  **MEASURED 2026-10-10 (W1-T7760).** 63 of main's newest 100 CI runs were cancelled while still pending.
  Most main commits never get a CI verdict at all.

  **WHAT READING CANCELLED AS RED DID.** `REQUIRED_CHECK_FAIL` includes CANCELLED, and
  `mainHealthFirstRedCommitFromRunHistory` returned the first cancelled run after a green as the first
  red. On 2026-10-10 the red-main repair lane wrote `main.repair.located` seven times, each naming a
  different merge, and dispatched a fresh fix worker after each. cc903730b, 58eb31094 and cd5741b83
  were among the named culprits; none of them has a completed run.

  **WHAT #10731 CHANGED.**
  - The first-red locator never counts a CANCELLED, SKIPPED or STALE run as red (`mainRunConcludedRed`;
    the fallback's `MAIN_RUN_NON_VERDICT` already did this).
  - Repair is deduped by RED SIGNATURE, not by the located sha.
  - Only a PROVEN culprit is reverted: its own completed run is red on the signature and its first
    parent's completed run is green. Otherwise the lane writes `main.repair.revert_withheld` and
    escalates once.

  **WHAT STAYS OPEN (W1-T7760, queued).** The commits between the last completed green and the first
  completed red have no verdict, so the honest answer is a SPAN, not a sha. The task probes the span by
  running CI on each commit under its own ref. Re-running a cancelled run in place would rejoin
  `ci-refs/heads/main` and cancel main's own pending run.

  **BY HAND:** a culprit is a commit whose own completed run is red while its first parent's is green.
  Otherwise name the span. *(#10731, W1-T7760)*
