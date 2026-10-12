- **Leave a red fleet PR to the fix lane while a round is due or in flight — hand pushes out-race it
  and hide its defects.**
  **OBSERVED 2026-10-10 ON #10671.** The fix-progress judge ruled `change-approach` at 16:55Z, in round 4,
  on comment-load-ratchet reds that census-precheck had refused. Between 16:36Z and 18:13Z six commits
  landed on the branch under the operator's git identity (cao825 / Craig Oley) rather than
  `remudero-fleet[bot]`: 4a84ad5eb, bfdff0329, 6ffd5207a, the main merge 175a960f4, 3535b41c0 and
  2493aaff7. The PR's later reds (coverage-shard 3/8, 4/8 and 7/8, then diff-coverage, at 17:26, 17:47
  and 18:12Z) were reds on those hand-made heads.

  **WHY THIS COSTS TWICE.**
  - **It out-races the lane.** A hand push mints a new head while a round is due or dispatched. The
    round's work can then land on a head its worker never saw, or be refused, and the round is wasted.
  - **It hides the lane's defects.** Every later sweep disposition on #10671 still read "fix round 4 —
    judge: change-approach", a verdict on a red class the PR no longer had. That is W1-T7762:
    `lastProgressJudgementFor` matches on `pr_number` alone. With hand pushes interleaved, the lane's
    mistake and the human's work could not be told apart while it happened. It was found only by
    reading the timeline afterwards.

  Operator ruling 2026-10-09: a hand-fixed PR is a bug in rmd. So while a round is due or in flight,
  leave the PR alone. If the lane is wrong, file the remedy, as W1-T7762 was filed, instead of
  pushing over it. A PR the lane has exhausted or escalated is yours to take. *(#10671, W1-T7762)*
