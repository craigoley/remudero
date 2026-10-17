- **Judge main from its newest commit with genuine evidence — its head alone reads undetermined
  forever under steady merges, and a push run CANCELLED while pending is not red.**
  Main merges faster than CI concludes, and most main push runs are cancelled while pending (see the
  CANCELLED rule below). So the newest head almost never has evidence of its own. A reader that waits
  for the head's own verdict waits forever, and every consumer of that verdict (the base-red hold, the
  red-main repair lane) stalls on "unknown".

  **MEASURED 2026-10-10.** From about 14:40Z, `main.health.observed` read `undetermined` on nearly every
  pass. The fallback meant to cover a head with no evidence had two gaps:
  - An all-skipped or vacuous head (a plan-only merge, or CI not yet registered beside its skipped
    siblings) was never walked past.
  - The fallback read at most five completed runs (`MAIN_HEALTH_FALLBACK_RUN_LIMIT`). CodeQL, Semgrep,
    Scorecard, main-tripwire and the ACR build all finish minutes before CI, so those five were almost
    never a CI run.

  **THE FIX, IN TWO HALVES.**
  - #10702 walks every completed run in main's first-parent window, newest first. The first run whose
    required checks genuinely executed decides; a skipped, vacuous or cancelled run is walked past. A
    green older than main's own observed evidence latency reads `stale`. The row names the deciding sha
    (`decidedBySha`, `main_decided_by_sha`), its depth, the lag and the bound.
  - #10743 (W1-T7757) closes the inverse gap. A newer commit whose required checks have CONCLUDED
    decides even while its workflow run is still going. At 15:03:50Z run 38061454938 had `ci` green but
    was still running, so an older completed red decided instead.

  **THE GUARD THE OTHER WAY.** An older concluded red stays red. Walking back must never hide a red main
  while merges keep landing.

  **BY HAND:** report main's health as "<state> at <sha>, N commits behind head", never as "head is
  pending". *(#10702, #10743)*

*(Index line merged 2026-10-17: the rule below is carried by this headline's CANCELLED clause. It is kept verbatim; its id and old path resolve here through `doctrine/merged-rules.json`.)*

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
