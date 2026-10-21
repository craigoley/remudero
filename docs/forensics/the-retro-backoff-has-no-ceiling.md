# The retro backoff has no ceiling

The time arm grows without a ceiling; a cap's effect on actual attempts remains unmeasured without the attempt and tick history.

W1-T10301 investigation against source at `7bd0dabc282e533b1f4dd0c83b11cc00c2497b23`.
This record changes neither the trigger nor policy and selects no cap.

## Which arm opened each attempt

The requested window starts at **2026-09-28T21:30:01Z**, when
[PR #7648](https://github.com/craigoley/remudero/pull/7648) merged W1-T4664
(merge `78bdf3d663d367338dda0a2b1918dbb5ed90b180`). GitHub's PR API reports
`merged: true` and the body carries the exact `Remudero-Task: W1-T4664` trailer.
The proposed observation cutoff is **2026-10-20T22:00:59Z**, the newest ledger row
reported by the task's author. This is a requested window, not verified corpus coverage.

Evidence boundaries: the worker can read source and the task record, but has no
permitted access to the core ledger or historical attempt records. The checkout
has no `state/` directory. The local task record matches the file fetched from
GitHub at the source SHA above. Its four backoff observations and seven start
times below are **author-reported**, not independently retrieved ledger rows.
[The filing PR](https://github.com/craigoley/remudero/pull/13241) repeats the
streak-11 observation but does not supply the missing attempt history.

Source premises were rechecked by symbol; the task cites no source line numbers:

| Cited premise | Current definition and verified behavior |
| --- | --- |
| `evaluateRetroBackoff` | `src/lib/retro.ts`: same-cycle delay is `baseDelayMs * 2 ** max(0, streak - 1)`; either elapsed time or the merge floor permits eligibility |
| `RetroBackoffPolicy` | `src/lib/retro.ts`: contains `baseDelayMs` and `mergesThreshold`; there is no cap field |
| `RETRO_ATTEMPT_RETRY_MS` | `src/run-task.ts`: six hours, passed by `retroBackoffPolicyFor` |
| `retro.mergesThreshold` | `plan/policy.yaml`: 25; the floor adds it to the previous attempt's count |
| `retro.daysThreshold` | `plan/policy.yaml`: seven days; this is cadence policy, not a backoff ceiling |
| `reportRetroTriggerBackoff` | `src/run-task.ts`: emits both boundaries, streak, marker, count and count basis for a declined tick |

Let the previous attempt be `(a, s, m, marker)`, with timestamp `a`, streak `s`
and merges-since-marker count `m`. At a tick `(t, n)` in that marker cycle:

```text
T = a + 6 hours * 2 ** max(0, s - 1)
F = m + 25
time = t >= T
merges = n >= F
backoff eligible = time OR merges
```

Classify the opening as **time**, **merges**, **both**, or **neither** by evaluating
both predicates at the decision tick. A missing/unreadable/malformed attempt
record or a changed marker is a separate **reset/unfenced** case, not proof of
either arm. `loadRetroAttemptRecord` can return `undefined` on a failed read.

`retroTriggerPrelude` first uses a local lower bound, possibly widened by cached
shipped credit. `retroTriggerDecide` rechecks the authoritative shipped-plus-runless
count before evaluating cadence. Preserve `count_basis`; a lower-bound refusal
does not measure all merges actually landed. Backoff eligibility also does not
prove dispatch: GitHub availability, cadence and downstream admission still apply.

The requested positive control is the **2026-10-20T18:11:00Z** backoff row:

| Tick (UTC, 2026-10-20) | Prior streak | Time boundary (UTC) | Merge floor | Count at tick | Time / merges | Result |
| --- | ---: | --- | ---: | ---: | --- | --- |
| 10:42, minute precision | 9 | 2026-12-23T05:06:06Z | 2681 | 2673 | false / false | declined |
| 11:56, minute precision | 9 | 2026-12-23T05:06:06Z | 2681 | 2674 | false / false | declined |
| **18:11:00** | **11** | **2027-07-03T17:18:40Z** | **2746** | **2734** | **false / false** | **declined** |
| 20:10:20 | 11 | 2027-07-03T17:18:40Z | 2746 | 2744 | false / false | declined |

At the control, the reported count is 12 below the floor; at 20:10:20 it is two
below. These calculations reproduce the reported refusal. The control has **not**
been recovered from a ledger union here, so it does not establish corpus visibility.
The task reports ten backoff rows on October 20 but supplies fields for only four.

Inverting the source formula gives these **derived**, not observed, prior records:

| Prior streak | Delay | Derived attempt timestamp (UTC) | Derived attempt count |
| --- | --- | --- | ---: |
| 9 | 1536 hours = 64 days | 2026-10-20T05:06:06Z | 2656 |
| 11 | 6144 hours = 256 days | 2026-10-20T17:18:40Z | 2721 |

Both use the author-reported marker `2026-10-06T10:45:50Z`. These inversions
check arithmetic consistency; they cannot validate the underlying ledger evidence.

The supplied attempt inventory is incomplete:

| Reported `retro.start` (UTC) | Prior streak / time boundary / merge floor / count at decision | Opening arm |
| --- | --- | --- |
| 2026-10-19 05:23 | unavailable / unavailable / unavailable / unavailable | undetermined |
| 2026-10-19 14:36 | unavailable / unavailable / unavailable / unavailable | undetermined |
| 2026-10-19 22:34 | unavailable / unavailable / unavailable / unavailable | undetermined |
| 2026-10-20 05:14 | unavailable / unavailable / unavailable / unavailable | undetermined |
| 2026-10-20 15:33 | unavailable / unavailable / unavailable / unavailable | undetermined |
| 2026-10-20 17:29 | unavailable / unavailable / unavailable / unavailable | undetermined |
| 2026-10-20 21:04 | unavailable / unavailable / unavailable / unavailable | undetermined |

`buildRetroDaemonHooks` writes `recordRetroAttempt` immediately before spawning;
`retroCommand` writes `retro.start` after gathering. A start timestamp is therefore
not the timestamp of the attempt record or eligibility decision. Nor does it alone
identify an automated invocation. The derived timestamps above must not be silently
substituted for decision ticks in this table. The filing's inference that merges
opened the attempts is plausible, but a reset/unfenced attempt must also be excluded.
Attempts between September 28 and October 19 are not enumerated by the supplied evidence.

Full attribution requires a permitted evidence export covering the whole window:
all gzip rotations, plain rotations and the live ledger, their opened-file counts,
deduplicated rows and newest timestamp; the 18:11:00Z positive control; automated
spawn identities and outcomes; marker transitions; and each attempt's previous
record, decision timestamp and authoritative merge count. A latest attempt file
cannot reconstruct records overwritten by earlier attempts. If historical fields
were not retained, mark those attempts unresolvable rather than infer an arm from
proximity to a declined tick. Criterion 1 remains incomplete.

## What a cap would change

For a hypothetical positive cap `C`, measured from the **last attempt**, replace
only the time boundary with `T_C = a + min(6 hours * 2 ** max(0, s - 1), C)`.
Keep the merge floor, marker reset, cadence and other gates unchanged. This is an
analysis parameter; the installed policy has no such setting.

Candidate values are six hours (one base delay), 24 hours (four base delays), and
seven days (the current `retro.daysThreshold`). No candidate is selected.

| Prior streak | Uncapped boundary | Six-hour boundary | 24-hour boundary | Seven-day boundary |
| --- | --- | --- | --- | --- |
| 9 | Dec 23 05:06:06 | Oct 20 11:06:06 | Oct 21 05:06:06 | Oct 27 05:06:06 |
| 11 | Jul 3 2027 17:18:40 | Oct 20 23:18:40 | Oct 21 17:18:40 | Oct 27 17:18:40 |

Dates other than July 3 are in 2026, all UTC. A replay of the **four supplied
declined ticks**, holding their previous records fixed, gives:

| Cap | Newly eligible ticks versus uncapped | Newly ineligible ticks | Additional/fewer actual attempts over the requested window |
| --- | ---: | ---: | --- |
| Uncapped | 0 (reference) | 0 (reference) | 0 (reference only; absolute total unknown) |
| Six hours | 1: October 20 at 11:56 | 0 | unknown |
| 24 hours | 0 | 0 | unknown |
| Seven days | 0 | 0 | unknown |

These are predicate counts, **not attempt counts**. Zero at the four declined ticks
does not imply zero effect during the rest of the window. The minute precision of
the first two observations does not affect their classification: neither is close
to a candidate boundary. Reproduce the table from the repository root with:

```sh
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { evaluateRetroBackoff, defaultRetroBackoffPolicy } from './src/lib/retro.ts';
const hour = 3600000;
const markerTs = '2026-10-06T10:45:50Z';
const policy = defaultRetroBackoffPolicy();
assert.deepEqual(policy, { baseDelayMs: 6 * hour, mergesThreshold: 25 });
const rows = [
  ['2026-10-20T10:42:00Z', 9, '2026-12-23T05:06:06Z', 2681, 2673],
  ['2026-10-20T11:56:00Z', 9, '2026-12-23T05:06:06Z', 2681, 2674],
  ['2026-10-20T18:11:00Z', 11, '2027-07-03T17:18:40Z', 2746, 2734],
  ['2026-10-20T20:10:20Z', 11, '2027-07-03T17:18:40Z', 2746, 2744],
];
for (const [capHours, expected] of [[Infinity, 0], [6, 1], [24, 0], [168, 0]]) {
  let newlyEligible = 0;
  for (const [tick, streak, boundary, floor, count] of rows) {
    const delay = policy.baseDelayMs * 2 ** (streak - 1);
    const attemptMs = Date.parse(boundary) - delay;
    const attempt = { retroAttemptAt: new Date(attemptMs).toISOString(),
      markerTs, streak, mergesSinceMarker: floor - policy.mergesThreshold };
    const actual = evaluateRetroBackoff(attempt, count, markerTs, new Date(tick), policy);
    assert.equal(actual.eligible, false);
    assert.equal(Date.parse(actual.nextEligibleAt), Date.parse(boundary));
    assert.equal(actual.mergesFloor, floor);
    const capped = Date.parse(tick) >= attemptMs + Math.min(delay, capHours * hour)
      || count >= floor;
    if (capped) newlyEligible++;
  }
  assert.equal(newlyEligible, expected);
  console.log(`${capHours}h: ${newlyEligible} newly eligible supplied ticks`);
}
JS
```

For fixed input records, a cap can only preserve or broaden eligibility. This does
not prove a monotonic change in total attempts: an earlier counterfactual attempt
rewrites the timestamp, streak and merge baseline and may displace a later one.
Replay the full ordered tick history separately for each `C`, updating simulated
attempt records on dispatch and applying marker changes and other admission gates.
Name any assumptions about the outcomes and duration of additional attempts; their
publication results are counterfactual, not observed. Without those inputs there is
no defensible total of more/fewer attempts for any finite cap. Criterion 2 remains
incomplete; the table above is only a bounded replay of the supplied observations.

## Operator decision

**Should the retro time arm remain uncapped, or be capped at a value `C` that you
specify (for example six hours, 24 hours, or the seven-day retro cadence)?**

- **Keep uncapped:** preserves W1-T4664's deliberate exponential retreat. At
  streak 11, absent merge credit or a marker/record reset, the time arm waits
  256 days. The four supplied ticks remain declined. Full-window absolute attempt
  totals are unavailable; zero change is only the baseline definition.
- **Cap at operator-specified `C`:** bounds this backoff's time wait when merges
  slow. At the supplied ticks, six hours adds one eligibility opportunity; 24 hours
  and seven days add none. Full-window attempt deltas are unavailable for all three.
  A seven-day cap tracks cadence policy; fixed multiples of the base delay express
  a separate retry tolerance. Neither interpretation has been ratified here.

The decision is pending. A finite cap does not bound the entire trigger's delay
when another gate refuses, and it does not repair the cause of publication failures.
No value is recommended from an incomplete replay. Any chosen runtime change
requires its own authorized scope; this record only presents the question.
