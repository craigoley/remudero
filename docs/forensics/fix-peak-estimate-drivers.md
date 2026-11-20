# What drives the fix class's learned peak estimate (W1-T13842)

Fix admission charges each fix at the fix class's learned p90 peak (`classEstimate("fix")`). It also uses the
class's median as the typical peak (`classTypical("fix")`). On 2026-11-19 the p90 was about 3.5 times the median.
This report reads the samples behind both numbers and asks why the p90 is so high. It changes no behaviour.

Each claim is labeled. OBSERVED means it was read from the Azure fleet host or the code at `origin/main`, on
2026-11-19 between 20:16Z and 20:25Z or on 2026-11-20 between 13:56Z and 14:15Z. INFERRED means it is a conclusion
drawn from what was observed.

## Method

- OBSERVED: the daemon container `remudero-daemon` keeps the peak store in
  `/home/node/rmd-scratch/test-slots/host-memory/estimates/`. On the host it is
  `/mnt/scratch/rmd/test-slots/host-memory/estimates/`. The store has 176 instance files. Three of them hold fix
  samples: `state2.ndjson` (the fleet daemon), `remudero-console-state.ndjson` and `site-state.ndjson`. The store
  was only read. For the 2026-11-20 check it was copied first, at 14:01:12Z, and the copy was read.
- OBSERVED: `readPeakSamples` (src/lib/host-memory-learning.ts) does not read whole files. It reads the last
  `PEAK_TAIL_BYTES` (256 KiB) of each file. `state2.ndjson` is about 1 MiB, and most of its rows are test-file
  samples. At 2026-11-19 20:21:22Z its last 256 KiB began at a row from 14:27:51Z, so the learner saw only about six
  hours of the fleet daemon's fix samples.
- OBSERVED: `learnedClass` learns the fix class from the legacy metric. It uses a `legacy-hwm` sample's own peak and
  a `concurrent-rss` sample's paired `legacy_p`. The legacy metric is the sum, at one sample time, of each live
  member's VmHWM (its lifetime peak RSS). The concurrent metric is the sum of the members' current VmRSS.
- OBSERVED (2026-11-19): the learner's own `learnEstimate` and `ESTIMATE_LEARNING` were run on the visible tail
  samples (259 fix samples). At 20:18:37Z they gave p90 5,911 MiB and p50 1,628 MiB. The `sweep.fix_capacity` row at
  2026-11-19T20:18:37.040Z shows `fix_estimate_mib` 5911 and `fix_typical_mib` 1628. The recompute matches.
- OBSERVED (2026-11-20): the learner's own `classEstimate("fix")` and `classTypical("fix")` were run on the copy,
  with the clock set to the `sweep.fix_capacity` row at 2026-11-20T13:56:29.634Z. Each file was cut after its last
  row written at or before that time (48 later rows in `state2.ndjson`, none in the other two files). They gave p90
  6,299 MiB and p50 1,425 MiB from 226 samples. The row shows `fix_estimate_mib` 6299 and `fix_typical_mib` 1425.
  The recompute matches exactly. Every one of the 226 samples is listed in the appendix.
- OBSERVED: the 2026-11-19 13:07:33Z row named in the task (7,154 and 2,048) cannot be reproduced. Its tail is no
  longer in the store: compaction has rewritten `state2.ndjson`, and its oldest fix row is now from 2026-11-19
  14:44:42Z. A recompute on every fix row the files held at 20:21Z gave 6,267 and 2,353 for 13:07:33Z. That number
  is not evidence, because the learner never reads whole files. The 2026-11-19 20:18:37Z match and the 2026-11-20
  13:56:29Z match are the evidence in this report.
- OBSERVED: the store records no task, PR or run for a sample. A sample is written when its reservation is released,
  at the end of a fix dispatch run. Each sample below is joined to the `sweep-fix` ledger row that ended a run just
  before it. The join is INFERRED. The ledger rows are OBSERVED. Between 11:53:49Z and 11:54:41Z on 2026-11-20, six
  runs ended and six fix samples were written. Each sample came 0.45 to 0.76 s after one run's end row, in the same
  order (OBSERVED). In the six 2026-11-19 samples with one candidate run, the sample came 1.2 to 9.9 s after the
  run's end row, never before it (OBSERVED).

## Fix peak samples

The task names the 2026-11-19 13:07:33Z row (7,154 and 2,048 MiB). Its samples are no longer in the store, so
no list of them can be checked against it (OBSERVED, see Method). This section lists the samples behind two later
rows that the learner's own code reproduces: 2026-11-20 13:56:29Z, sample by sample, and 2026-11-19 20:18:37Z, by
group.

### The 2026-11-20 13:56:29Z estimate

The learner read 226 fix samples (OBSERVED). From them it computes p90 6,299 MiB and p50 1,425 MiB, and the capacity
row shows the same two numbers (OBSERVED). The appendix lists every sample with its time, file, basis and value.

| Source file | Basis | Days | Count |
|---|---|---|---|
| state2 | legacy-hwm | 11-20 | 22 |
| state2 | concurrent-rss | 11-20 | 15 |
| console-state | concurrent-rss | 10-16 to 11-19 | 154 |
| console-state | legacy-hwm | 10-12 to 11-17 | 32 |
| site-state | concurrent-rss | 10-27 and 11-19 | 3 |

The five largest samples are all `legacy-hwm` samples from `state2`, with entry kind `bundle` and no concurrent
value (OBSERVED). The task and PR are joined as the Method says (INFERRED). The run start is the time in the run id
(OBSERVED).

| Peak (MiB) | Time (Z) | Task and PR (joined) | The run's end row (OBSERVED) |
|---|---|---|---|
| 7,368 | 11-20 11:53:54.768 | W1-T13849, #19727 | `fix.stood_down` at 11:53:54.132 after `fix.ci_not_green`; the run started 10:55:31 |
| 7,307 | 11-20 11:54:40.789 | W1-T13819, #19699 | `fix.done` at 11:54:40.335 after `fix.needs_design`; the run started 11:39:22 |
| 7,218 | 11-20 09:35:40.392 | W1-T13855, #19728 | `fix.stood_down` at 09:35:40.128; the run started 08:40:21 |
| 7,020 | 11-20 11:53:59.513 | W1-T13905, #19812 | `fix.stood_down` at 11:53:58.902 after `fix.ci_not_green`; the run started 11:17:42 |
| 6,299 | 11-20 12:00:48.161 | W1-T12271, #19672 | `fix.progress_judged` at 12:00:45.885 is its last row; the run started 10:45:30 |

### The 2026-11-19 20:18:37Z estimate

The learner saw 259 fix samples at 20:21:22Z, and it computes p90 5,911 MiB and p50 1,628 MiB from them (OBSERVED).
Compaction has since removed most of the 2026-11-19 `state2` rows, so these 259 can no longer be listed one by one
(OBSERVED). The counts read on 2026-11-19 were:

| Source file | Basis | Day | Count | Learned p50 (MiB) | Learned p90 (MiB) | Max (MiB) | Concurrent RSS p50 / p90 (MiB) |
|---|---|---|---|---|---|---|---|
| state2 | legacy-hwm | 11-19 | 46 | 3,158 | 6,458 | 7,231 | not measured |
| state2 | concurrent-rss | 11-19 | 17 | 574 | 1,700 | 1,733 | 567 / 835 |
| console-state | concurrent-rss | 11-18 and 11-19 | 13 | 250 to 273 | 254 to 431 | 431 | 224 to 240 / 242 to 367 |
| site-state | concurrent-rss | 11-19 | 1 | 229 | 229 | 229 | 218 |
| console-state and site-state | all | 10-12 to 11-17 | 182 | (older, heavily decayed) | | | |

Eight samples were at or above that p90, and they carried 10.1 % of the decayed weight (OBSERVED). The five largest,
joined as the Method says (INFERRED):

| Peak (MiB) | Time (Z) | Task and PR (joined) | What the run's ledger rows show (OBSERVED) |
|---|---|---|---|
| 7,231 | 11-19 18:04:53.514 | W1-T13840, #19704 | `fix.stood_down` at 17:44:02 ("a later round reclaimed this round's worktree"), `sweep.fix.owner_residue_preserved` and `fix.done` at 18:04:52 |
| 7,089 | 11-19 15:07:49.442 | W1-T10777, #19679 | `fix.dispatch` 15:07:13, `fix.scope_amendment` created, `fix.done` 15:07:47: a 35 s round |
| 6,794 | 11-19 18:04:34.866 | W1-T13816, #19700 | `fix.done` at 18:04:33.080, 1.8 s before the sample |
| 6,529 | 11-19 17:44:05.138 | W1-T13840, #19704 | `fix.stood_down` at 17:44:02 |
| 6,458 | 11-19 16:24:15.282 | W1-T13785, #19691 | `fix.contract_hold` and `fix.stood_down` at 16:24:11 |

The 6,794 MiB sample had two candidate runs. W1-T13811 (#19693) wrote `fix.done` at 18:04:34.919, 53 ms after the
sample, and W1-T13816 wrote `fix.done` 1.8 s before it (OBSERVED). No sample in the store was written before its
run's end row, so the sample is W1-T13816's (INFERRED). The next sample, 1,600 MiB at 18:04:37.221Z, came 2.3 s
after W1-T13811's end row, which fits W1-T13811 (INFERRED).

The 2026-11-19 files held larger samples that the learner no longer saw at 20:21Z. These include 7,165 MiB at
10:02:56Z (W1-T11819, #19625), 7,162 at 09:20:23Z (W1-T13192, #19613) and 7,154 at 11:06:26Z (W1-T12074, #19643)
(OBSERVED). The p90 on the capacity rows matched these single samples while they were in the tail. It was 7,154 from
11h to 13h, 7,039 (the 12:54:16Z sample) and 6,954 (the 13:26:02Z sample) (OBSERVED). W1-T12074's round ran 31 s,
from `fix.dispatch` at 11:05:54Z to `fix.done` at 11:06:25Z, and ended in a scope amendment (OBSERVED). W1-T11819
and W1-T13192 held their reservation through `run.awaiting_external` for 49 and 38 minutes, until `fix.stood_down`
(OBSERVED).

The estimate was already high before 2026-11-19. On the capacity rows, `fix_estimate_mib` was 5,076 to 5,574 MiB on
11-17 and 3,443 to 5,305 MiB on 11-18 (OBSERVED). On 11-19 it rose to 7,162 MiB. The typical ranged from 256 to
2,619 MiB over those three days (OBSERVED). W1-T9679 measured a fix p90 of 3,196 MiB on 2026-10-15 (OBSERVED in that
task).

## Verdict

The p90 is not sample-starved and is not a few outliers. It is set by the many recent `legacy-hwm` fix samples,
whose concurrent peak was not measured. So it is a real peak of the legacy metric, but the store cannot show that it
is a real concurrent peak of a fix tree. The evidence for each part:

- Not sample-starved (OBSERVED). On 2026-11-20 the learner read 226 samples. 46 of them are from the last 24 hours
  and carry 89.2 % of the decayed weight. On 2026-11-19 it read 259 samples, 73 of them from the last 24 hours.
- Not a few outliers (OBSERVED). On 2026-11-20, 5 samples are at or above the p90 and carry 10.5 % of the weight,
  which is what any p90 has above it. 12 samples are at or above 5,000 MiB, all `legacy-hwm` from `state2`. The 22
  `state2` `legacy-hwm` samples of 2026-11-20 have an unweighted p50 of 5,755 MiB and p90 of 7,218 MiB, so the heavy
  values are the usual value of that population, not a few rare ones. On 2026-11-19, `state2` wrote 103 `legacy-hwm`
  fix samples (p50 4,077 MiB, p90 6,629 MiB) and 36 `concurrent-rss` fix samples.
- Not shown to be a real concurrent peak of a fix tree. Every sample at or above 5,000 MiB is a `legacy-hwm` sample
  with no concurrent value (OBSERVED). `finishMeasurement` writes such a sample only when the tree's concurrent RSS
  was not observed, or was incomplete at some sample (OBSERVED in the code). So the store holds no concurrent
  measurement of any heavy tree, and it cannot say what their concurrent peak was (OBSERVED). The legacy value is
  not a bound on the concurrent peak either. It adds the lifetime peaks of the members the sampler read. When a
  process listing is incomplete, the sampler skips that sample, so a member that was large only then is missing
  from the sum (INFERRED from the code; the review of this report ran the sampler in memory and got a 1 MiB legacy
  value for a tree that had 9 MiB of concurrent RSS in a skipped, incomplete listing). So the heavy legacy values
  can be above or below those trees' real concurrent peaks, and the store cannot say which (INFERRED).
- The trees that were measured are a different set and do not settle the question (INFERRED). On 2026-11-20 the 15
  measured `state2` trees had an unweighted concurrent RSS p50 of 626 MiB and p90 of 2,091 MiB, and paired legacy
  p50 953 MiB and p90 2,981 MiB (OBSERVED). On 2026-11-19 the measured trees had concurrent RSS p90 835 MiB and
  paired legacy p90 1,700 MiB (OBSERVED). These numbers show how far the legacy metric runs above the concurrent
  metric on measured trees. They do not show that the unmeasured heavy trees were small (INFERRED).
- What the heavy runs did (OBSERVED in the ledger). The five largest 2026-11-20 samples close fix dispatch runs of
  15 to 75 minutes that ended in `fix.stood_down`, `fix.needs_design` or no end row. On 2026-11-19 two of the
  largest closed short rounds of 31 and 35 s that ended in a scope amendment. A sum of lifetime peaks over a long
  run keeps every member's worst moment, while a 35 s round charged 7 GiB is hard to match to a real 7 GiB tree
  (INFERRED).
- The 256 KiB tail makes the estimate jump (INFERRED). On 2026-11-20 the learner saw only 37 `state2` fix samples,
  all from that day, because test-file rows fill the rest of the tail (OBSERVED). The p90 then follows whichever few
  heavy legacy samples are newest. This is why the p90 matched single samples hour by hour on 2026-11-19 (OBSERVED
  on the capacity rows).
- What it means for host headroom. `createSweepFixAdmissionController` (src/lib/sweep.ts) gives the "fits" rung
  `floor(left / estimate)` fixes, where `left` is the headroom less the review and fix charges. This rung admits a
  fix whether or not a fix tree is live. The "typical" rung admits one fix at its typical peak only when no fix tree
  is live and nothing is reserved (OBSERVED in the code). On the 2026-11-20 13:56:29Z row the headroom was 5,478
  MiB, below the 6,299 MiB estimate, so the fits rung admitted none and the row shows `admission_rung` none and
  `fixes_refused` 1 (OBSERVED). With 6 to 9 GiB of headroom (the W1-T13869 refusals) and an estimate of 5,911 to
  7,162 MiB, the fits rung admits at most one fix, and none while a fix tree is live and the headroom is below the
  estimate (INFERRED from the code and the rows).
- What was not established: why concurrent observation failed for so many fix trees. Possible reasons are an
  incomplete process listing under load, unreadable `/proc/<pid>/status` lines, or adopted run-child trees. No
  ledger row or sample records that reason (OBSERVED), and this report does not guess one.

## Recommended remedy

One remedy task: learn the fix class's estimate and typical from the concurrent RSS peak where one exists. Do not
learn it from `legacy-hwm` samples whose concurrent peak was not observed. Record why the concurrent peak was not
observed, so that a tree that was never measured is named rather than charged at a summed lifetime peak. Take the
class samples from a read that the test-file rows cannot crowd out, for example a per-class tail or a separate file
for test-file samples. A larger tail of mixed rows would not fix this (INFERRED from the tail evidence above). This
task is filed as W1-T13878 and is open as #19776 (OBSERVED).

This remedy loosens the admission charge (INFERRED from the code: a lower fix estimate raises `floor(left /
estimate)` and lowers the fix charge, so more fixes are admitted on the same headroom). On the 2026-11-20 13:56:29Z
samples, `learnEstimate` over the 172 `concurrent-rss` samples' own peaks, with the fix prior of 2,048 MiB, gives
p90 2,048 MiB (the prior) and p50 573 MiB (OBSERVED: a recompute with the learner's own function). So the estimate
would fall from 6,299 MiB to about 2 GiB (INFERRED: W1-T13878 learns this way, but its exact numbers depend on its
final code).

Because the remedy loosens the charge, it needs the operator's explicit yes. The operator gave it on 2026-11-19: the
W1-T13878 task file says "The operator approved loosening the admission charge on 2026-11-19" (OBSERVED). If that
yes is withdrawn, the smaller first step does not loosen anything: record the reason that a fix tree's concurrent
peak was not observed, and leave the estimate unchanged (INFERRED).

## Appendix: every fix sample behind the 2026-11-20 13:56:29Z estimate

OBSERVED: the 226 fix samples that `readPeakSamples("fix")` returned from the store copy cut at
2026-11-20T13:56:29.634Z, oldest first. For a `concurrent-rss` sample the learner uses the paired legacy value, so
both values are shown. `learnEstimate` weights each sample by its age (half-life 24 hours) and adds the fix prior of
2,048 MiB at weight 1.
Values are printed as stored, not rounded, because the learner rounds only its result up. A replay of this table
alone, with that weighting and prior, gives p90 6,299 MiB and p50 1,425 MiB from 226 samples, the same as the
capacity row (OBSERVED). The store does not record a task or a PR for a sample. Only the five largest are joined
to a run above: many of the other samples have no fix run that ended within 15 s before them, and the
console-state and site-state samples come from other daemons (OBSERVED).

| # | Time (Z) | File | Basis | Value the learner uses (MiB, as stored) | Concurrent RSS (MiB) |
|---|---|---|---|---|---|
| 1 | 2026-10-12 23:48:27.903 | console-state | legacy-hwm | 266 | not measured |
| 2 | 2026-10-12 23:51:31.312 | console-state | legacy-hwm | 286 | not measured |
| 3 | 2026-10-13 00:41:27.428 | console-state | legacy-hwm | 302 | not measured |
| 4 | 2026-10-13 11:08:08.838 | console-state | legacy-hwm | 299 | not measured |
| 5 | 2026-10-13 11:17:53.159 | console-state | legacy-hwm | 417 | not measured |
| 6 | 2026-10-13 11:28:33.713 | console-state | legacy-hwm | 275 | not measured |
| 7 | 2026-10-13 16:20:26.082 | console-state | legacy-hwm | 421 | not measured |
| 8 | 2026-10-13 16:30:10.276 | console-state | legacy-hwm | 418 | not measured |
| 9 | 2026-10-13 16:50:43.938 | console-state | legacy-hwm | 274 | not measured |
| 10 | 2026-10-14 04:14:03.724 | console-state | legacy-hwm | 521 | not measured |
| 11 | 2026-10-14 06:25:21.234 | console-state | legacy-hwm | 265 | not measured |
| 12 | 2026-10-14 06:32:02.983 | console-state | legacy-hwm | 260 | not measured |
| 13 | 2026-10-14 07:34:42.630 | console-state | legacy-hwm | 281 | not measured |
| 14 | 2026-10-14 08:16:37.048 | console-state | legacy-hwm | 276 | not measured |
| 15 | 2026-10-16 22:15:07.818 | console-state | concurrent-rss | 442.5859 | 343 |
| 16 | 2026-10-19 23:10:48.711 | console-state | concurrent-rss | 287 | 274 |
| 17 | 2026-10-20 14:00:17.586 | console-state | concurrent-rss | 458.5664 | 377 |
| 18 | 2026-10-24 04:30:21.169 | console-state | concurrent-rss | 450.25 | 330 |
| 19 | 2026-10-24 04:44:51.511 | console-state | concurrent-rss | 532.2617 | 395 |
| 20 | 2026-10-24 04:51:03.646 | console-state | concurrent-rss | 700.6211 | 532 |
| 21 | 2026-10-24 05:07:15.830 | console-state | concurrent-rss | 496.2344 | 342 |
| 22 | 2026-10-24 17:39:33.539 | console-state | concurrent-rss | 1,121.582 | 821 |
| 23 | 2026-10-24 18:03:03.452 | console-state | concurrent-rss | 1,100.793 | 770 |
| 24 | 2026-10-24 18:21:57.863 | console-state | concurrent-rss | 481.6406 | 373 |
| 25 | 2026-10-24 18:25:14.401 | console-state | concurrent-rss | 454.4805 | 370 |
| 26 | 2026-10-24 18:42:47.976 | console-state | concurrent-rss | 453.1094 | 335 |
| 27 | 2026-10-24 18:54:38.136 | console-state | concurrent-rss | 692.5117 | 516 |
| 28 | 2026-10-24 19:13:19.638 | console-state | concurrent-rss | 674.8633 | 492 |
| 29 | 2026-10-24 19:20:26.226 | console-state | concurrent-rss | 562.6914 | 401 |
| 30 | 2026-10-24 19:25:16.461 | console-state | concurrent-rss | 443.4102 | 355 |
| 31 | 2026-10-24 19:35:24.558 | console-state | concurrent-rss | 727.668 | 622 |
| 32 | 2026-10-24 19:41:59.611 | console-state | concurrent-rss | 512.1797 | 394 |
| 33 | 2026-10-24 19:51:06.754 | console-state | concurrent-rss | 442.2852 | 325 |
| 34 | 2026-10-24 19:54:06.284 | console-state | concurrent-rss | 785.8398 | 637 |
| 35 | 2026-10-24 20:18:54.177 | console-state | legacy-hwm | 2,356 | not measured |
| 36 | 2026-10-24 20:36:51.408 | console-state | concurrent-rss | 717.8203 | 495 |
| 37 | 2026-10-24 20:54:28.350 | console-state | concurrent-rss | 1,828.7734 | 1,538 |
| 38 | 2026-10-25 17:35:37.394 | console-state | concurrent-rss | 460.875 | 369 |
| 39 | 2026-10-25 17:43:06.463 | console-state | concurrent-rss | 467.9102 | 369 |
| 40 | 2026-10-25 17:48:34.374 | console-state | concurrent-rss | 445.5664 | 342 |
| 41 | 2026-10-25 18:14:59.360 | console-state | concurrent-rss | 437.6055 | 308 |
| 42 | 2026-10-25 18:25:34.256 | console-state | concurrent-rss | 563.3984 | 417 |
| 43 | 2026-10-25 18:29:38.972 | console-state | concurrent-rss | 260.9375 | 261 |
| 44 | 2026-10-25 18:33:11.673 | console-state | concurrent-rss | 461.5273 | 353 |
| 45 | 2026-10-25 18:37:54.531 | console-state | concurrent-rss | 262.0742 | 251 |
| 46 | 2026-10-26 17:11:43.153 | console-state | concurrent-rss | 455.2422 | 336 |
| 47 | 2026-10-26 18:57:26.627 | console-state | concurrent-rss | 539.7109 | 411 |
| 48 | 2026-10-26 19:35:47.153 | console-state | concurrent-rss | 565.0703 | 397 |
| 49 | 2026-10-26 21:12:43.463 | console-state | concurrent-rss | 281.6797 | 279 |
| 50 | 2026-10-26 21:25:09.803 | console-state | concurrent-rss | 854.168 | 690 |
| 51 | 2026-10-26 21:46:08.930 | console-state | concurrent-rss | 883.2383 | 713 |
| 52 | 2026-10-26 22:11:19.565 | console-state | concurrent-rss | 466.2109 | 348 |
| 53 | 2026-10-26 22:28:58.010 | console-state | legacy-hwm | 503 | not measured |
| 54 | 2026-10-26 22:51:47.554 | console-state | concurrent-rss | 520.3008 | 390 |
| 55 | 2026-10-26 23:05:06.726 | console-state | concurrent-rss | 275.4648 | 270 |
| 56 | 2026-10-26 23:23:29.477 | console-state | concurrent-rss | 464.6641 | 341 |
| 57 | 2026-10-27 04:48:20.757 | console-state | concurrent-rss | 268.418 | 260 |
| 58 | 2026-10-27 05:30:29.728 | console-state | concurrent-rss | 468.918 | 380 |
| 59 | 2026-10-27 05:45:27.075 | console-state | legacy-hwm | 257 | not measured |
| 60 | 2026-10-27 05:56:52.215 | console-state | concurrent-rss | 462.4688 | 381 |
| 61 | 2026-10-27 06:20:33.125 | console-state | concurrent-rss | 298.8047 | 299 |
| 62 | 2026-10-27 06:34:48.563 | console-state | legacy-hwm | 461 | not measured |
| 63 | 2026-10-27 06:35:51.198 | console-state | concurrent-rss | 461.5312 | 435 |
| 64 | 2026-10-27 06:40:27.934 | console-state | concurrent-rss | 266.8672 | 267 |
| 65 | 2026-10-27 09:36:55.989 | console-state | concurrent-rss | 927.1484 | 710 |
| 66 | 2026-10-27 09:43:29.824 | console-state | concurrent-rss | 263.957 | 259 |
| 67 | 2026-10-27 09:51:10.769 | console-state | concurrent-rss | 263.8203 | 254 |
| 68 | 2026-10-27 09:56:39.697 | console-state | concurrent-rss | 260.2891 | 255 |
| 69 | 2026-10-27 10:38:30.624 | console-state | concurrent-rss | 231.6641 | 230 |
| 70 | 2026-10-27 10:58:51.169 | console-state | concurrent-rss | 278.043 | 278 |
| 71 | 2026-10-27 11:00:22.890 | console-state | concurrent-rss | 467.2617 | 362 |
| 72 | 2026-10-27 11:05:08.321 | console-state | concurrent-rss | 277.3828 | 274 |
| 73 | 2026-10-27 11:17:21.848 | console-state | legacy-hwm | 265 | not measured |
| 74 | 2026-10-27 11:45:34.337 | console-state | legacy-hwm | 458 | not measured |
| 75 | 2026-10-27 11:48:25.721 | console-state | concurrent-rss | 230.3945 | 218 |
| 76 | 2026-10-27 11:57:34.627 | console-state | concurrent-rss | 548.6445 | 410 |
| 77 | 2026-10-27 12:02:10.558 | console-state | concurrent-rss | 237.3555 | 230 |
| 78 | 2026-10-27 12:18:20.290 | console-state | concurrent-rss | 283.8984 | 277 |
| 79 | 2026-10-27 13:28:19.652 | console-state | concurrent-rss | 256.7891 | 253 |
| 80 | 2026-10-27 14:21:24.505 | console-state | legacy-hwm | 288 | not measured |
| 81 | 2026-10-27 19:32:28.230 | site-state | concurrent-rss | 245.25 | 236 |
| 82 | 2026-10-27 19:52:05.867 | site-state | concurrent-rss | 247.3242 | 235 |
| 83 | 2026-10-29 01:01:37.182 | console-state | concurrent-rss | 537.1797 | 439 |
| 84 | 2026-10-29 01:19:15.713 | console-state | concurrent-rss | 1,757.1289 | 1,590 |
| 85 | 2026-10-29 01:48:57.182 | console-state | concurrent-rss | 1,631.9922 | 1,443 |
| 86 | 2026-10-29 07:06:31.795 | console-state | concurrent-rss | 1,049.3672 | 870 |
| 87 | 2026-10-29 07:31:11.434 | console-state | concurrent-rss | 653.5977 | 477 |
| 88 | 2026-10-29 07:53:05.734 | console-state | concurrent-rss | 1,865.5938 | 1,649 |
| 89 | 2026-10-29 08:15:40.606 | console-state | concurrent-rss | 575.7188 | 498 |
| 90 | 2026-10-29 08:32:39.860 | console-state | concurrent-rss | 547.4766 | 407 |
| 91 | 2026-10-29 08:56:54.670 | console-state | legacy-hwm | 1,658 | not measured |
| 92 | 2026-10-29 09:20:27.336 | console-state | concurrent-rss | 677.7461 | 478 |
| 93 | 2026-10-29 16:57:26.132 | console-state | concurrent-rss | 534.9219 | 361 |
| 94 | 2026-10-29 17:01:37.837 | console-state | concurrent-rss | 489.8984 | 384 |
| 95 | 2026-10-29 17:19:40.662 | console-state | concurrent-rss | 819.0977 | 645 |
| 96 | 2026-10-29 18:09:19.066 | console-state | legacy-hwm | 664 | not measured |
| 97 | 2026-10-29 18:16:18.362 | console-state | concurrent-rss | 623.5156 | 455 |
| 98 | 2026-10-29 18:27:08.542 | console-state | concurrent-rss | 524.582 | 393 |
| 99 | 2026-10-30 02:17:21.603 | console-state | concurrent-rss | 962.5234 | 951 |
| 100 | 2026-10-30 02:38:15.567 | console-state | concurrent-rss | 458.3789 | 356 |
| 101 | 2026-10-30 07:21:27.333 | console-state | concurrent-rss | 589.375 | 399 |
| 102 | 2026-10-30 07:56:52.411 | console-state | concurrent-rss | 493.9961 | 313 |
| 103 | 2026-10-30 08:08:19.294 | console-state | legacy-hwm | 460 | not measured |
| 104 | 2026-10-30 08:16:31.465 | console-state | concurrent-rss | 598.6797 | 411 |
| 105 | 2026-10-30 08:32:19.451 | console-state | concurrent-rss | 480.625 | 330 |
| 106 | 2026-10-30 08:51:27.264 | console-state | concurrent-rss | 1,066.2148 | 887 |
| 107 | 2026-10-30 09:09:42.557 | console-state | concurrent-rss | 724.3164 | 540 |
| 108 | 2026-10-30 09:27:04.053 | console-state | legacy-hwm | 992 | not measured |
| 109 | 2026-10-30 09:39:25.547 | console-state | concurrent-rss | 470.0195 | 290 |
| 110 | 2026-10-30 09:58:46.371 | console-state | concurrent-rss | 941.3047 | 747 |
| 111 | 2026-10-30 10:17:45.040 | console-state | concurrent-rss | 470.9258 | 362 |
| 112 | 2026-11-02 15:28:54.435 | console-state | concurrent-rss | 260.3672 | 254 |
| 113 | 2026-11-02 19:50:13.422 | console-state | concurrent-rss | 949.4336 | 767 |
| 114 | 2026-11-02 19:54:55.619 | console-state | concurrent-rss | 474.7383 | 368 |
| 115 | 2026-11-02 20:08:01.172 | console-state | concurrent-rss | 746.75 | 427 |
| 116 | 2026-11-02 20:27:52.986 | console-state | concurrent-rss | 608.6211 | 421 |
| 117 | 2026-11-02 20:58:15.291 | console-state | concurrent-rss | 300.1719 | 293 |
| 118 | 2026-11-02 21:11:34.581 | console-state | concurrent-rss | 246.7773 | 238 |
| 119 | 2026-11-02 21:16:48.265 | console-state | concurrent-rss | 249.4609 | 248 |
| 120 | 2026-11-02 21:32:03.146 | console-state | concurrent-rss | 560.8242 | 456 |
| 121 | 2026-11-02 21:40:53.588 | console-state | concurrent-rss | 469.0312 | 378 |
| 122 | 2026-11-02 22:12:04.599 | console-state | legacy-hwm | 283 | not measured |
| 123 | 2026-11-03 15:38:19.025 | console-state | concurrent-rss | 549.9023 | 416 |
| 124 | 2026-11-04 13:05:56.729 | console-state | concurrent-rss | 547.8242 | 405 |
| 125 | 2026-11-06 13:34:39.263 | console-state | legacy-hwm | 453 | not measured |
| 126 | 2026-11-06 14:09:54.407 | console-state | concurrent-rss | 497.6992 | 372 |
| 127 | 2026-11-06 14:32:53.509 | console-state | concurrent-rss | 400.4688 | 308 |
| 128 | 2026-11-06 14:42:57.653 | console-state | concurrent-rss | 499.207 | 365 |
| 129 | 2026-11-06 14:55:49.052 | console-state | concurrent-rss | 396.2969 | 323 |
| 130 | 2026-11-06 15:05:54.663 | console-state | concurrent-rss | 532.3047 | 434 |
| 131 | 2026-11-06 15:18:40.078 | console-state | concurrent-rss | 387.9336 | 387 |
| 132 | 2026-11-06 16:00:33.459 | console-state | concurrent-rss | 267.25 | 253 |
| 133 | 2026-11-06 16:54:13.706 | console-state | legacy-hwm | 387 | not measured |
| 134 | 2026-11-08 06:04:47.696 | console-state | concurrent-rss | 241.7852 | 242 |
| 135 | 2026-11-08 14:28:40.827 | console-state | concurrent-rss | 233.8242 | 224 |
| 136 | 2026-11-08 14:43:36.948 | console-state | concurrent-rss | 246.0977 | 246 |
| 137 | 2026-11-08 15:02:36.963 | console-state | concurrent-rss | 238.6523 | 236 |
| 138 | 2026-11-08 15:26:40.926 | console-state | concurrent-rss | 459.1797 | 420 |
| 139 | 2026-11-08 15:46:35.822 | console-state | legacy-hwm | 229 | not measured |
| 140 | 2026-11-08 15:51:38.272 | console-state | concurrent-rss | 230.5195 | 226 |
| 141 | 2026-11-08 16:19:02.395 | console-state | concurrent-rss | 228.1016 | 219 |
| 142 | 2026-11-08 16:36:29.802 | console-state | concurrent-rss | 254.8281 | 246 |
| 143 | 2026-11-11 16:45:58.381 | console-state | concurrent-rss | 235.043 | 225 |
| 144 | 2026-11-13 14:33:01.672 | console-state | concurrent-rss | 455.2852 | 303 |
| 145 | 2026-11-13 14:37:58.809 | console-state | concurrent-rss | 477.3242 | 303 |
| 146 | 2026-11-13 18:46:23.825 | console-state | concurrent-rss | 447.3594 | 303 |
| 147 | 2026-11-13 18:51:53.310 | console-state | concurrent-rss | 445.0547 | 358 |
| 148 | 2026-11-13 19:20:12.561 | console-state | concurrent-rss | 470.0859 | 351 |
| 149 | 2026-11-13 19:28:54.752 | console-state | legacy-hwm | 1,091 | not measured |
| 150 | 2026-11-13 20:31:06.508 | console-state | concurrent-rss | 466.6953 | 310 |
| 151 | 2026-11-13 20:42:31.573 | console-state | concurrent-rss | 521.6602 | 317 |
| 152 | 2026-11-13 21:01:07.590 | console-state | legacy-hwm | 1,141 | not measured |
| 153 | 2026-11-15 23:06:57.985 | console-state | concurrent-rss | 250.4062 | 245 |
| 154 | 2026-11-16 15:30:15.121 | console-state | concurrent-rss | 379.3828 | 375 |
| 155 | 2026-11-16 15:45:20.650 | console-state | concurrent-rss | 202.1211 | 199 |
| 156 | 2026-11-16 15:50:45.256 | console-state | concurrent-rss | 321.3477 | 315 |
| 157 | 2026-11-16 15:59:28.263 | console-state | concurrent-rss | 210.8984 | 207 |
| 158 | 2026-11-16 15:59:42.421 | console-state | concurrent-rss | 282.4141 | 282 |
| 159 | 2026-11-16 16:12:04.997 | console-state | concurrent-rss | 1,084.5586 | 1,075 |
| 160 | 2026-11-16 16:14:34.398 | console-state | concurrent-rss | 635.9023 | 635 |
| 161 | 2026-11-16 20:15:23.557 | console-state | concurrent-rss | 259.5156 | 254 |
| 162 | 2026-11-17 01:36:34.304 | console-state | legacy-hwm | 249 | not measured |
| 163 | 2026-11-17 01:48:59.763 | console-state | concurrent-rss | 859.1133 | 847 |
| 164 | 2026-11-17 01:57:44.707 | console-state | concurrent-rss | 248.4844 | 248 |
| 165 | 2026-11-17 03:22:50.249 | console-state | concurrent-rss | 242.7344 | 234 |
| 166 | 2026-11-17 18:04:54.187 | console-state | concurrent-rss | 251.5117 | 247 |
| 167 | 2026-11-17 18:14:11.115 | console-state | concurrent-rss | 243.3867 | 236 |
| 168 | 2026-11-17 18:17:59.311 | console-state | concurrent-rss | 235.4375 | 215 |
| 169 | 2026-11-17 18:27:16.876 | console-state | concurrent-rss | 1,066.6602 | 1,053 |
| 170 | 2026-11-17 18:34:47.708 | console-state | concurrent-rss | 1,424.0234 | 1,417 |
| 171 | 2026-11-17 18:40:35.968 | console-state | concurrent-rss | 240.5664 | 236 |
| 172 | 2026-11-17 19:33:07.026 | console-state | concurrent-rss | 245.6016 | 230 |
| 173 | 2026-11-17 20:18:56.878 | console-state | concurrent-rss | 254.582 | 242 |
| 174 | 2026-11-17 22:19:12.247 | console-state | concurrent-rss | 232.5703 | 227 |
| 175 | 2026-11-18 04:26:43.150 | console-state | concurrent-rss | 252.9688 | 240 |
| 176 | 2026-11-18 05:00:56.203 | console-state | concurrent-rss | 242.9219 | 238 |
| 177 | 2026-11-18 05:14:38.992 | console-state | concurrent-rss | 234.543 | 229 |
| 178 | 2026-11-18 12:08:32.481 | console-state | concurrent-rss | 241.2305 | 237 |
| 179 | 2026-11-18 20:42:57.622 | console-state | concurrent-rss | 249.7188 | 242 |
| 180 | 2026-11-18 23:34:12.076 | console-state | concurrent-rss | 254.3281 | 241 |
| 181 | 2026-11-19 14:43:23.310 | console-state | concurrent-rss | 223.8359 | 221 |
| 182 | 2026-11-19 14:56:25.636 | console-state | concurrent-rss | 222.5625 | 215 |
| 183 | 2026-11-19 18:51:30.336 | console-state | concurrent-rss | 430.7695 | 367 |
| 184 | 2026-11-19 19:10:20.563 | console-state | concurrent-rss | 255.6289 | 251 |
| 185 | 2026-11-19 19:24:17.884 | console-state | concurrent-rss | 273.0078 | 223 |
| 186 | 2026-11-19 19:48:14.233 | console-state | concurrent-rss | 286.2656 | 224 |
| 187 | 2026-11-19 20:00:16.258 | site-state | concurrent-rss | 229.1367 | 218 |
| 188 | 2026-11-19 20:20:38.912 | console-state | concurrent-rss | 310.8438 | 231 |
| 189 | 2026-11-19 20:40:11.028 | console-state | concurrent-rss | 2,064.3125 | 1,819 |
| 190 | 2026-11-20 09:27:01.084 | state2 | legacy-hwm | 5,916 | not measured |
| 191 | 2026-11-20 09:35:40.392 | state2 | legacy-hwm | 7,218 | not measured |
| 192 | 2026-11-20 09:52:32.504 | state2 | legacy-hwm | 6,156 | not measured |
| 193 | 2026-11-20 10:08:22.036 | state2 | concurrent-rss | 953.0781 | 870 |
| 194 | 2026-11-20 10:08:33.625 | state2 | concurrent-rss | 3,393.3711 | 2,091 |
| 195 | 2026-11-20 10:10:53.737 | state2 | legacy-hwm | 350 | not measured |
| 196 | 2026-11-20 10:11:10.482 | state2 | concurrent-rss | 636.3008 | 577 |
| 197 | 2026-11-20 10:13:53.760 | state2 | concurrent-rss | 1,227.2578 | 1,015 |
| 198 | 2026-11-20 10:14:19.699 | state2 | legacy-hwm | 502 | not measured |
| 199 | 2026-11-20 10:14:52.241 | state2 | concurrent-rss | 573.8828 | 563 |
| 200 | 2026-11-20 10:15:43.976 | state2 | legacy-hwm | 2,110 | not measured |
| 201 | 2026-11-20 10:18:28.305 | state2 | concurrent-rss | 1,578.5039 | 417 |
| 202 | 2026-11-20 10:28:06.236 | state2 | concurrent-rss | 917.4141 | 814 |
| 203 | 2026-11-20 10:40:07.034 | state2 | concurrent-rss | 493.2109 | 493 |
| 204 | 2026-11-20 10:52:58.621 | state2 | legacy-hwm | 1,127 | not measured |
| 205 | 2026-11-20 10:59:43.523 | state2 | concurrent-rss | 2,980.7891 | 2,097 |
| 206 | 2026-11-20 10:59:54.985 | state2 | legacy-hwm | 6,269 | not measured |
| 207 | 2026-11-20 11:10:27.241 | state2 | legacy-hwm | 939 | not measured |
| 208 | 2026-11-20 11:23:57.608 | state2 | legacy-hwm | 2,946 | not measured |
| 209 | 2026-11-20 11:28:31.056 | state2 | legacy-hwm | 4,516 | not measured |
| 210 | 2026-11-20 11:32:37.104 | state2 | legacy-hwm | 5,755 | not measured |
| 211 | 2026-11-20 11:39:42.792 | state2 | legacy-hwm | 5,825 | not measured |
| 212 | 2026-11-20 11:42:34.598 | state2 | concurrent-rss | 646.7344 | 587 |
| 213 | 2026-11-20 11:46:27.175 | state2 | concurrent-rss | 632.7539 | 573 |
| 214 | 2026-11-20 11:48:40.384 | state2 | legacy-hwm | 578 | not measured |
| 215 | 2026-11-20 11:48:54.588 | state2 | concurrent-rss | 626.3398 | 626 |
| 216 | 2026-11-20 11:53:50.386 | state2 | legacy-hwm | 6,078 | not measured |
| 217 | 2026-11-20 11:53:54.768 | state2 | legacy-hwm | 7,368 | not measured |
| 218 | 2026-11-20 11:53:58.624 | state2 | legacy-hwm | 5,824 | not measured |
| 219 | 2026-11-20 11:53:59.513 | state2 | legacy-hwm | 7,020 | not measured |
| 220 | 2026-11-20 11:54:01.057 | state2 | concurrent-rss | 1,706.8828 | 1,596 |
| 221 | 2026-11-20 11:54:40.789 | state2 | legacy-hwm | 7,307 | not measured |
| 222 | 2026-11-20 12:00:48.161 | state2 | legacy-hwm | 6,299 | not measured |
| 223 | 2026-11-20 12:56:33.083 | state2 | concurrent-rss | 2,551.8789 | 1,798 |
| 224 | 2026-11-20 12:58:57.223 | state2 | legacy-hwm | 974 | not measured |
| 225 | 2026-11-20 13:32:31.120 | state2 | legacy-hwm | 4,625 | not measured |
| 226 | 2026-11-20 13:32:31.206 | state2 | concurrent-rss | 1,752.1094 | 326 |
