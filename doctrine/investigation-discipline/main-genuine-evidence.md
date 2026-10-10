- **Judge main from its newest commit with genuine evidence — its head alone reads undetermined
  forever under steady merges.**
  Main merges faster than CI concludes, and most main push runs are cancelled while pending (see the
  CI rule on CANCELLED). So the newest head almost never has evidence of its own. A reader that waits
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
