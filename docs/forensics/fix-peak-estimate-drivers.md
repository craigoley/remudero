# What drives the fix class's learned peak estimate (W1-T13842)

Fix admission charges each fix at the fix class's learned p90 peak (`classEstimate("fix")`). It also uses the
class's median as the typical peak (`classTypical("fix")`). On 2026-11-19 the p90 was about 3.5 times the median.
This report reads the samples behind both numbers and asks why the p90 is so high. It changes no behaviour.

Each claim is labeled. OBSERVED means it was read from the Azure fleet host or the code at `origin/main` on
2026-11-19 between 20:16Z and 20:25Z. INFERRED means it is a conclusion drawn from what was observed.

## Method

- OBSERVED: the daemon container `remudero-daemon` keeps the peak store in
  `/home/node/rmd-scratch/test-slots/host-memory/estimates/`. The store has 176 instance files. Three of them hold
  fix samples: `state2.ndjson` (the fleet daemon, 140 fix rows), `remudero-console-state.ndjson` (192 fix rows) and
  `site-state.ndjson` (3 fix rows). The store was only read.
- OBSERVED: `readPeakSamples` (src/lib/host-memory-learning.ts) does not read whole files. It reads the last
  `PEAK_TAIL_BYTES` (256 KiB) of each file. `state2.ndjson` is 1,048,376 bytes, and most of its rows are test-file
  samples. At 20:21:22Z its last 256 KiB began at a row from 14:27:51Z, so the learner saw only about six hours of
  the fleet daemon's fix samples.
- OBSERVED: `learnedClass` learns the fix class from the legacy metric. It uses a `legacy-hwm` sample's own peak
  and a `concurrent-rss` sample's paired `legacy_p`. The legacy metric is the sum, at one sample time, of each
  live member's VmHWM (its lifetime peak RSS). The concurrent metric is the sum of the members' current VmRSS.
- OBSERVED: the learner's own `learnEstimate` and `ESTIMATE_LEARNING` were run on the visible tail samples (259
  fix samples). At 20:18:37Z they gave p90 5,911 MiB and p50 1,628 MiB. The `sweep.fix_capacity` row at
  2026-11-19T20:18:37.040Z shows `fix_estimate_mib` 5911 and `fix_typical_mib` 1628. The recompute matches the
  learner exactly.
- OBSERVED: the 13:07:33Z row in the task (7,154 and 2,048) cannot be reproduced now. The tail it was learned from
  has since moved. A recompute on every fix row in the files, not only the tail, gives 6,267 and 2,353 at 13:07:33Z.
  That number is not evidence, because the learner never reads whole files. This report uses the 20:18:37Z match.

## Fix peak samples

The learner saw 259 fix samples at 20:21:22Z (OBSERVED):

| Source file | Basis | Day | Count | Learned p50 (MiB) | Learned p90 (MiB) | Max (MiB) | Concurrent RSS p50 / p90 (MiB) |
|---|---|---|---|---|---|---|---|
| state2 | legacy-hwm | 11-19 | 46 | 3,158 | 6,458 | 7,231 | not measured |
| state2 | concurrent-rss | 11-19 | 17 | 574 | 1,700 | 1,733 | 567 / 835 |
| console-state | concurrent-rss | 11-18 and 11-19 | 13 | 250 to 273 | 254 to 431 | 431 | 224 to 240 / 242 to 367 |
| site-state | concurrent-rss | 11-19 | 1 | 229 | 229 | 229 | 218 |
| console-state and site-state | 10-12 to 11-17 | | 182 | (older, heavily decayed) | | | |

The learner computes p90 5,911 MiB and p50 1,628 MiB from these samples at 20:18:37Z (OBSERVED, as in Method).
Eight samples are at or above that p90, and they carry 10.1 % of the decayed weight.

All 17 visible samples of 5,000 MiB or more are `legacy-hwm` samples from `state2`, with entry kind `bundle`
(OBSERVED). The five largest are listed below. The store does not record a task or a PR. Each sample was joined to
the `sweep-fix` ledger rows within 3 s of its time. The join is INFERRED. The ledger rows are OBSERVED.

| Peak (MiB) | Time (Z) | Task and PR (joined) | What the run's ledger rows show |
|---|---|---|---|
| 7,231 | 11-19 18:04:53.514 | W1-T13840, #19704 | `fix.stood_down` at 17:44:02 ("a later round reclaimed this round's worktree"), `sweep.fix.owner_residue_preserved` and `fix.done` at 18:04:52 |
| 7,089 | 11-19 15:07:49.442 | W1-T10777, #19679 | `fix.dispatch` 15:07:13, `fix.scope_amendment` created, `fix.done` 15:07:47: a 35 s round |
| 6,794 | 11-19 18:04:34.866 | W1-T13811, #19693 (`fix.done` 18:04:34.919), or W1-T13816, #19700 (`fix.done` 18:04:33.080) | two rounds ended within 2 s, so the join is ambiguous |
| 6,529 | 11-19 17:44:05.138 | W1-T13840, #19704 | `fix.stood_down` at 17:44:02 |
| 6,458 | 11-19 16:24:15.282 | W1-T13785 (`fix.contract_hold`, then `fix.stood_down`) | no `fix.done` in the window |

The whole files hold larger samples that the learner no longer sees. These include 7,165 MiB at 10:02:56Z (W1-T11819,
#19625), 7,162 at 09:20:23Z (W1-T13192, #19613) and 7,154 at 11:06:26Z (W1-T12074, #19643) (OBSERVED). The p90 on
the capacity rows matched these single samples while they were in the tail. It was 7,154 from 11h to 13h, 7,039
(the 12:54:16Z sample) and 6,954 (the 13:26:02Z sample) (OBSERVED). W1-T12074's round ran 31 s, from `fix.dispatch`
at 11:05:54Z to `fix.done` at 11:06:25Z, and ended in a scope amendment (OBSERVED). W1-T11819 and W1-T13192 held
their reservation through `run.awaiting_external` for 49 and 38 minutes, until `fix.stood_down` (OBSERVED).

The estimate was already high before 2026-11-19. On the capacity rows, `fix_estimate_mib` was 5,076 to 5,574 MiB
on 11-17 and 3,443 to 5,305 MiB on 11-18 (OBSERVED). On 11-19 it rose to 7,162 MiB. The typical ranged from 256 to
2,619 MiB over those three days. W1-T9679 measured a fix p90 of 3,196 MiB on 2026-10-15.

## Verdict

- The p90 is not sample-starved (OBSERVED). The learner saw 259 samples, 73 of them from the last 24 hours.
- The p90 is not a few outliers in the usual sense (OBSERVED). On 11-19, `state2` wrote 103 `legacy-hwm` fix
  samples (p50 4,077 MiB, p90 6,629 MiB) and 36 `concurrent-rss` fix samples. The heavy population is a large
  share of the newest, highest-weight samples. In the whole file, 40 of them are at or above 5,000 MiB; 17 of those
  are in the visible tail.
- The p90 does not reflect a measured concurrent peak of a fix tree (INFERRED). A `legacy-hwm` sample with no
  concurrent value is written only when the tree's concurrent RSS was not observed, or was incomplete at some sample
  (`finishMeasurement` in src/lib/host-memory-learning.ts, OBSERVED). For the trees that do have both values on
  11-19, the concurrent RSS p90 is 835 MiB and the paired legacy p90 is 1,700 MiB (OBSERVED). A sum of members'
  lifetime peaks counts each member at its own worst moment, so it overstates the concurrent peak (INFERRED from the
  code). It also cannot fall when a large member settles, because VmHWM only rises (INFERRED from the code). A
  31 s scope-amendment round that is charged 7,154 MiB fits that overstatement better than a real 7 GiB tree
  (INFERRED).
- The 256 KiB tail makes the estimate jump (INFERRED). Test-file samples fill most of `state2.ndjson`, so the
  learner sees only the last few hours of fleet fix rounds. The p90 then follows whichever few heavy legacy samples
  are newest. This is why the p90 matched single samples hour by hour.
- What this means for host headroom (INFERRED): fix admission reserves 5.9 to 7.2 GiB for each fix. The measured
  concurrent RSS of a fix tree is under 1 GiB at its p90 on the same day. On the 2026-11-19 host (headroom 6 to
  9 GiB on the refusals in W1-T13869), the inflated estimate turns "room for several fixes" into "room for none"
  whenever a fix tree is live. The charge rule is not the cause. The input to it is.
- What was not established: why concurrent observation failed for so many fix trees on 11-19. Possible reasons are
  an incomplete process listing under load, unreadable `/proc/<pid>/status` lines, or adopted run-child trees. No
  ledger row records that reason, and this report does not guess one.

## Recommended remedy

One remedy task: learn the fix class's estimate and typical from the concurrent RSS peak where one exists. Do not
learn it from `legacy-hwm` samples whose concurrent peak was not observed. Record why the concurrent peak was not
observed, so that a tree that was never measured is named rather than charged at a summed lifetime peak. The same
task should take the class samples from a read that the test-file rows cannot crowd out, for example a per-class
tail or a separate file for test-file samples. A larger tail of mixed rows would not fix this.

This remedy LOOSENS the admission charge. On the 11-19 samples it would lower the fix estimate from about 6 GiB
toward the 1 to 2 GiB range, so more fixes would be admitted on the same headroom. It therefore needs the
operator's explicit yes before it is filed or built. Until then, the current charge stays as it is. If the operator
declines, the smaller first step does not loosen anything: record the reason that a fix tree's concurrent peak was
unobserved, and leave the estimate unchanged.
