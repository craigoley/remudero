# What the fact history costs a now@core instance, and what each reader needs of it (W1-T6369)

STATUS: recon only. No `src/` file changes in this task, no production storage change and no cache release.
It ends with one recommended implementation task.

METHOD. All measurements come from an isolated replay:
- **Data:** a private online backup of the production read model, taken 2026-10-07 at about 20:22Z.
  It holds 836,723 fact rows; the board keeps 502,196 rows in memory.
- **Code:** main `33fc1ed4`, with a lockfile-matching dependency tree.
- **Isolation:** no network, run serially at low priority.
- **Experiment hooks:** a separate worktree adds three opt-in hooks to `board-projection.ts`, all off by default:
  a row transform at parse time, a view over `rows()`, and a view over the board's own `readLedger`.
  With no hook set the code is main's. Each candidate was one hook setting.
- **Arm isolation:** each arm ran in its own process on a fresh copy of the read model.
- **Frozen clock:** `Date.now`, a no-argument `Date` and the view clock all read one simulated instant.
- **Build sequence per arm:**
  1. a cold build;
  2. five warm builds;
  3. one build past the board oracle's 10-minute interval;
  4. one build across a UTC day;
  5. 40 appended fact rows (copies of real rows, re-stamped), then a warm build;
  6. a second instance's cold build in the same process (the lane-move case).
- **Per build:** the canonical JSON sha256 of every body, and of every top-level body section and its sources; CPU;
  heap after a full GC; and the process's maxRSS.

Symbols are cited by name, not line number.

## 1. What it costs today (main, 3 repetitions, identical heap figures each time)

| Measure | Value |
|---|---|
| Rows in the board's in-memory array | 502,196 = 394,768 fact rows + 106,874 `read_model.run_activity` + 553 `read_model.run_worker` stand-ins + 1 sentinel. No duplicate by identity or content |
| Heap one instance retains after its cold build | **522 MiB** |
| Heap a second instance adds (a lane move) | **431 MiB** |
| maxRSS | 1,288-1,346 MiB |
| Warm build CPU, median per repetition | 1,165-1,354 ms |
| Cold build CPU | 22.9-27.8 s |

`BoardProjection` keeps `rows: Row[]`, a full `JSON.parse` of every fact body plus the stand-ins, and exposes it as
`rows()`. Every stage that reads rows walks all of them on every build:

| Stage | Main reader | Rows touched (instrumented warm build) |
|---|---|---|
| `snapshot` | `computeBoardSnapshot` through `readLedger` (status board, PR queue, glance spend, `lastActivityByTask`) | all 502,196 |
| `decisions` | `decisionsOf` (`projectFeedbackGates`, `nowDependencyVerificationGates`) | all |
| `assemble` | `assembleNowView` (`changedActivityByTask`, `nowActions`, `mergedTodayCount`), `computeRecentActivity`, `dayCostRows` | all |
| inside the board | `projectPlan` for dirty tasks, and the no-reuse oracle every `BOARD_ORACLE_INTERVAL_MS` | all, through the board's `readLedger` |

## 2. What the readers need

**Fields.** A recording proxy over `rows()` and the board's `readLedger` recorded which fields were read; it changed nothing,
and its bodies equal main's at all 11 steps.
- Across the whole sequence the readers read **45 of the 546 distinct keys** present in the rows:
  - 24 on warm builds;
  - 42 once the oracle pass and the day crossing run;
  - 45 on cold derives.
- No row was enumerated whole (`ownKeys` was never called: no spread, `Object.keys` or `JSON.stringify` of a row).
- The heaviest keys never read are `host` (377,842 rows), `actor` and `actor_pid` (242,681 each), `acted`,
  `stand_down_reason`, `repeat_streak` and `lane`.
- The warm set: authority, class, cost_usd, decision, disposition, feedback_id, head_sha, issue_url, judge_decision,
  judge_failed, judge_reason, observed_state, plan_only, pr_number, pr_url, reason, released, review_decision, run_id,
  step, task, task_id, ts, verdict.
- Added by the oracle and day crossing: actual_pr_url, event_at, event_kind, harness_commit_refused, host, mount,
  original_refusal, original_run_id, original_verdict, provider, requested_model, served_model, stage, state,
  terminal_class, tool_completed_at, type, worker_role.
- Added only by cold derives: num_turns, strike, strikes.

**History.** Every reader was shown only the last N days of rows, and each section compared to main:

| Window | Sections that differ from main |
|---|---|
| 1 day | actions, board, decisions, humanGates, needsYou, prQueue, recent |
| 7 days | board, decisions, humanGates, needsYou |
| 30 days | board, decisions, humanGates, needsYou |

The board and the decision and gate sections depend on rows older than 30 days (credit and merged state, gate rulings,
latest dispositions), so **no window is exact**. A windowed representation would first have to move those full-history
readers to SQL or to persisted per-task aggregates.

## 3. Candidates, priced

Equality means the canonical body and every section equal main's at all 11 steps, under each fault:
- no fault;
- the board snapshot cache missing (GitHub unavailable);
- the plan unreadable;
- the live ledger truncated mid-row.

| Candidate | Retained, one instance | Second instance adds | maxRSS | Warm CPU median (3 reps) | Equality | Verdict |
|---|---|---|---|---|---|---|
| main | 522 MiB | 431 MiB | 1,288-1,346 | 1,165-1,354 ms | — | baseline |
| **intern**: equal short string values (96 chars or fewer) shared, at parse | **411 (-21%)** | 286 (-34%) | 1,079-1,103 | **669-773 ms (about -43%)** | all faults, all steps | **exact by construction; recommended** |
| project: only the 45 read fields kept | 340 (-35%) | 250 (-42%) | 944 | 1,429 ms (1 rep) | no fault, all steps | exact only for the OBSERVED field set |
| project + intern | 255 (-51%) | 134 (-69%) | 751-825 | 611-666 ms (about -51%) | all faults, all steps | same caveat as project |
| rows kept as JSON strings, parsed on demand | 415 MiB of strings vs 363 of parsed objects | — | — | +1.07-1.17 s per build to re-parse | not built | **rejected**: larger, and every build re-parses every row |
| windowed history | unchanged | — | — | — | not exact even at 30 days | **rejected** as a transparent change |
| per-reader aggregates or SQL for full-history readers | not priced | — | — | — | — | the route a window would need; a design task of its own |

Notes on the measurements:
- **Interning helps CPU, not just memory.** The CPU gain was not predicted. It held across 3 repetitions and all 3 faults
  (for example, warm 520 ms vs 1,094 ms with the cache missing).
- **The intern table's cost is included.** It held 438,329 distinct values, mostly unique `ts` and id strings that gain
  nothing from interning. An intern that skips per-row-unique fields may do better; that is untested.
- **The second-instance figure for interning shares one table across both instances in a process.** In production the
  fast and heavy views lanes are separate isolates, each with its own table, so the per-isolate figure is the
  one-instance column.
- **Projection fails silently.** A reader added later that reads a dropped field gets `undefined`, with no error. It needs
  a declared field contract that fails closed (for example, a development-mode proxy that throws on an unlisted field,
  plus a test over every reader). Without that it is unsafe, which is why it is not the recommendation.

## 4. The correctness oracle and recovery cases

- **The oracle:** canonical equality of every now@core body, and of every top-level section and its sources, against
  main at the same step, on identical inputs, with a frozen clock.
- **Controls:**
  - A/A: three separate main runs produced identical body sequences;
  - the recording arm, which changes nothing, equals main;
  - the history windows are a negative control: the oracle detects them.
- **A harness artifact the oracle caught:** the first cache-missing runs differed in `sources` only. The cause was the run
  directory's name (it carried the arm), which a source reason quotes. With a path that does not vary by arm, both
  candidates equal main.
- **Recovery, covered:**
  - a cold start, every arm;
  - a second instance, standing in for a lane move;
  - an oracle pass;
  - a UTC day crossing;
  - appended rows;
  - each fault above.
- **Recovery, not covered:**
  - an unreadable or corrupt read-model database;
  - a fact-table rewrite (the board reads the fact table, not ledger archives);
  - a worker death mid-build;
  - two isolates measured separately.

## 5. Recommendation: one implementation task

**Intern repeated string values at the board projection's row parse.**
- A per-projection table, released with the projection, holding values of 96 characters or fewer, applied where
  `BoardProjection` parses a fact body (and to its `run_activity` stand-ins).
- Its proof:
  - (a) canonical now-view body equality against an un-interned build across cold, warm, oracle, day-crossing, append
    and second-instance builds, and the faults above;
  - (b) a bounded heap assertion on a synthetic corpus with repeated values;
  - (c) the table is dropped when the projection is.
- Expected effect per views isolate holding a now@core instance, measured here: about -111 MiB retained (-21%) and
  about -43% warm build CPU. Not production numbers until adopted and measured, per lane, by W1-T6368's telemetry.

After that, and only with a declared, fail-closed field contract: projection (a further -30 to -35% on top). A windowed
or SQL-backed history comes only after the full-history readers named in section 2 have their own exact aggregates.

Receipts, kept outside the repository with the operator:
- `w6369-replay.mts` and `w6369-replay-v2.mts`: the arms;
- `w6369-fields.mts`: phase-1 fields;
- `w6369-strings.mts`;
- `w6369-rowcount.mts`;
- `cpu-candidates.mts`;
- the per-arm JSON.
