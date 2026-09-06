# Forensics: src/lib/plan.ts

Every measured fact, incident and design argument the comments in `src/lib/plan.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard.

Nothing here is a rule. The loader's behaviour lives in the code, and each block below is quoted
exactly as it stood on `origin/main` at `4e4275b2`, under a heading naming the symbol it explained.
The code keeps a one-line `Why:` pointer wherever the history still matters.

`validateAcceptanceShape`'s doc comment and its inline `satisfied_by` comment (W1-T2908, #4105) and
`readBlobsAtRef`/`GitBlobRunner`/`loadPlanAtRef`'s batch-read comments (#4081) already followed the
standard and were left untouched — nothing from them is archived here.

## module header

Base revision `4e4275b2`, line 6, 8 comment lines.

```
/**
 * plan/tasks.yaml loader + validator (schema v1, MASTER-PLAN §2).
 *
 * The control plane flips `status`; humans and the Architect edit narrative.
 * This module only READS and VALIDATES — it never writes the plan (the runner
 * owns status writes separately). A task may carry a pre-authored `prompt` and
 * cited `context` entries (G-2: v0 prompts are pre-authored per task).
 */
```

## BAND_MEANINGS

Base revision `4e4275b2`, line 35, 12 comment lines.

```
/**
 * W1-T2503: which of two things a `risk: high` band ASSERTS for THIS task — Rule 19's
 * SPAN measure (`"span"`, ≥2 subsystems/concerns) or genuine BLAST RADIUS unrelated to
 * span (`"blast-radius"`: a boot script, an auth path, a merge arm). Before this field
 * the two facts — different review implications each — shared one value with nothing
 * recording which; fifteen shards filed in a single session wrote the distinction by
 * hand as prose their linter never read. See task-linter.ts's `sizingViolation` for
 * where this is enforced: computed and REPORTED for `"span"`, exempt for
 * `"blast-radius"`, and required only on a task the diff newly files or promotes to
 * `risk: high` — the standing backlog authored before this field existed is read as
 * `undefined` and is reported, never refused.
 */
```

## RETIREMENT_REASONS

Base revision `4e4275b2`, line 53, 10 comment lines.

```
/**
 * Retirement taxonomy (W1-T1287) — the sibling field that replaces the `RETIRED (…)` /
 * `CLOSED UNBUILT (…)` title-prefix convention (carried by 2 of 790 tasks, read by nothing in
 * `src/` or `test/`) with something a reader can actually filter on. Mirrors `learnings.ts`'s
 * `lifecycle` shape: a small closed vocabulary, validated at load, fail-closed on anything else
 * — the SAME three words (W1-T1287's rationale (2)) already found in use as candidate
 * `TASK_STATUSES` members before that task's Q1 ruled a new status-enum member out precisely
 * because it would re-litigate `blocked`'s exclusion semantics at four independent sites. A
 * sibling field on an already-excluded record cannot perturb that exclusion BY CONSTRUCTION.
 */
```

## AcceptanceCriterion.satisfied_by

Base revision `4e4275b2`, line 69, 11 comment lines.

```
  /**
   * ARCHITECT-ONLY. A PR (url or `#N`) that ALREADY satisfied this criterion in an
   * EARLIER merge. The deterministic judge treats such a criterion as MET, citing
   * that PR as the proof — the reviewer judges diff+report and never repo state, so
   * a criterion satisfied by an earlier PR is otherwise permanently unsatisfiable
   * by a later one. **May ONLY be set by a human/Architect in a plan PR.** A worker
   * adding `satisfied_by` to its own blocking criterion is "editing the criteria to
   * match the diff" (Standing rule 15) — a failed task. (W1-T3F makes the reviewer
   * OBSERVE repo state, which is the real fix; `satisfied_by` is the manual patch.)
   */
```

## AcceptanceCriterion.holdout

Base revision `4e4275b2`, line 80, 14 comment lines.

```
  /**
   * W1-T166 (the SpecBench reward-hacking finding): a criterion a worker that can
   * optimize TO the visible test suite would otherwise game. `holdout: true` marks
   * it REVIEWER-VISIBLE but WORKER-HIDDEN — every prompt assembled for a worker
   * (recon, implement, the fix rung's unmet-criteria block, the post-compaction
   * ANCHOR) filters it out via {@link visibleCriteria}; `buildReviewPrompt`
   * (lib/review.ts) deliberately does NOT filter through it, since the reviewer
   * must judge visible AND holdout criteria both — a diff that passes visible-only
   * still yields an overall FAIL (`judgeReview`). The visible-pass vs holdout-pass
   * gap is the reward-hacking measurement, ledgered per run as `reward_hacking_gap`
   * (see `ReviewVerdict.rewardHackingGap`). Absent/false is the default: an
   * ordinary criterion, shown to the worker like any other.
   */
```

## visibleCriteria

Base revision `4e4275b2`, line 96, 11 comment lines.

```
/**
 * Criteria a WORKER may be shown (W1-T166): every criterion EXCEPT `holdout:
 * true` ones. The single filter every worker-facing prompt assembler routes
 * through — `renderAnchorBlock` (lib/compaction.ts) and the fix rung's
 * unmet-criteria block (run-task.ts) both call this rather than each
 * hand-rolling its own `!c.holdout` predicate, so "never shown to a worker"
 * has exactly ONE implementation to audit. Generic over anything carrying an
 * optional `holdout` flag — both {@link AcceptanceCriterion} (the task's
 * authored list) and `CriterionVerdict` (lib/review.ts's judged list, which
 * copies `holdout` from the criterion it judged) satisfy it.
 */
```

## Task.priority

Base revision `4e4275b2`, line 140, 11 comment lines.

```
  /**
   * OPTIONAL dispatch priority (lower dispatches sooner; absent ⇒ the default tier,
   * ordered after every task that carries one). The honest successor to file
   * placement in `plan/tasks.yaml`, which `dispatchOrder` (lib/drain.ts) deliberately
   * stopped reading — see that function's impl-DQ comment for the full history. Read
   * ONLY by `compareDispatch`; parsing tolerates absence everywhere, so every task
   * filed before this field existed is unaffected. The §5C linter's `dispatch-priority`
   * check (lib/task-linter.ts) WARNS on a value outside [0, 99] or set on a non-open
   * task, so a stray value degrades to odd ordering rather than rotting silently.
   */
```

## Task.retirement

Base revision `4e4275b2`, line 192, 13 comment lines.

```
  /**
   * OPERATOR-ONLY retirement category (W1-T1287) — records WHY a `status: "blocked"` task will
   * never be built, so a closed operator ruling (W1-T1261, W1-T1273 — both closed by ruling on
   * 2026-08-23) is no longer indistinguishable from the 41 other `blocked` records that are
   * merely dependency-stalled. NEVER auto-written: nothing in `src/` sets this field, the same
   * way `status` itself is machine-derived-elsewhere but this sibling is not (see W1-T1287 Q3
   * (x) — a retirement is a judgement call, not a re-verifiable assertion, so unlike
   * `learnings.ts`'s `quarantined` arm there is deliberately no auto-flip writer to copy).
   * Absent on every non-retired task, including every other `blocked` one. `blocked`'s own
   * exclusion semantics at `isDispatchEligible` (lib/drain.ts), `assertRunnable` (this file),
   * and `isOpenLintTask` (run-task.ts) read `status` alone and never this field — a task with
   * and without `retirement` filters identically at all three.
   */
```

## loadPlan

Base revision `4e4275b2`, line 404, 16 comment lines — **orphaned**. This was `loadPlan`'s own doc
comment, but it sat directly above `taskRecordPath` (line 436), not above the real `loadPlan`
function (line 499, which carried no doc comment of its own at all) — the same
misattached-JSDoc shape `docs/comment-standard.md`'s own worked `ledger.ts` example calls out.
Compacting this file was the occasion to notice it: the content below now anchors the real
function, and `taskRecordPath` gets its own doc (see that heading).

```
/**
 * Load plan/tasks.yaml from disk AND merge in any shards under the sibling
 * `plan/tasks.d/*.yaml` directory (W1-T122: PLAN SHARDING). One task per shard
 * file means two concurrent filings each add a DIFFERENT file — they no longer
 * share an EOF to textually conflict on, which is the whole point (the
 * nine-PR appender train #271 was 437 lines of pure appends to one shared EOF).
 *
 * Every consumer of {@link loadPlan} sees the MERGED view — sharding is invisible
 * above this function. Duplicate ids across `tasks.yaml` and any shard (or across
 * two shards) FAIL LOUD: the uniqueness guarantee the single-file format gave for
 * free must not be lost in the split. When `plan/tasks.d/` does not exist (every
 * plan that has not migrated yet), this is byte-for-byte the old single-file
 * behavior — back-compat is load-bearing so migration can be staged separately.
 *
 * Throws {@link PlanError} on any problem.
 */
```

## taskRecordPath

Base revision `4e4275b2`, line 420, 16 comment lines (this was the doc actually sitting above
`taskRecordPath`, immediately following the orphaned `loadPlan` doc above).

```
/**
 * Which FILE holds `taskId`'s record — the monolith or one of the shards — or `undefined`.
 *
 * WHY THIS IS DERIVED RATHER THAN CONSTRUCTED. `plan/tasks.d/<id>-<slug>.yaml` is the convention,
 * but it is only a convention: the slug is not recoverable from the id, and tasks still live in
 * `plan/tasks.yaml` (measured: 4 of them). A constructed string would be wrong for both cases and
 * wrong SILENTLY — it would name a path that does not exist and send a worker looking for it.
 *
 * IT REUSES `parseTasksFromYaml`, NOT A REGEX, so the answer is the one {@link loadPlan} would
 * resolve. A text scan for `- id: <taskId>` would also match a commented-out line, a `depends_on`
 * entry, or a mention in prose; the parser matches on the record the loader actually builds.
 *
 * FAIL-SOFT BY CONSTRUCTION: every read is guarded and an unreadable or unparseable file is simply
 * not the answer. The only caller renders an advisory prompt line, so a throw here would turn a
 * missing plan file into a failed RUN — strictly worse than the omission it is fixing.
 */
```

## readWholeFile

Base revision `4e4275b2`, line 472, 14 comment lines.

```
/**
 * Read a WHOLE file, refusing a torn/partial read rather than silently handing back a prefix.
 * `loadPlan` cannot tell "the whole file" from "a prefix of it" from `readFileSync` alone — YAML
 * that stops early is still valid YAML, and every field after the cut DEFAULTS instead of
 * failing (measured: 83.1% of truncated shard cuts still parse). The only honest signal
 * `loadPlan` has, with no expected length of its own, is a stat/read/stat size disagreement: if
 * the byte size on disk before the read, the bytes actually read, and the byte size on disk
 * after the read do not all agree, a writer touched this file DURING the read and the bytes are
 * not trustworthy — retried a few times (the torn window measured ~0.8% of reads and is brief;
 * a request-scoped retry loop costs nothing when no checkout is landing, per this task's design
 * note (iv)), then refused outright rather than ever being handed to the YAML parser. This is
 * remedy (a) of that design note: cheap, and "usually not partial" — see {@link loadPlanAtRef}
 * for the write-gate's stronger "cannot be partial" guarantee.
 */
```

## loadPlan shard ENOENT skip

Base revision `4e4275b2`, line 516, 8 comment lines (inline, inside `loadPlan`'s shard-reading loop).

```
      // A shard that VANISHED BETWEEN THE LISTING AND THIS READ is a race, not corruption, and
      // skipping it is the only correct answer — it is not in the plan any more. Throwing here
      // made `loadPlan` fail whenever anything removed a shard concurrently: measured in CI as a
      // FILE-LEVEL crash of whichever suite happened to be reading the plan while
      // `test/task-linter-wiring.test.ts` cleaned up its probe shard, since `node --test`
      // parallelises across files and 39 suites name this directory. It is reachable in
      // production too — a filing or a `git checkout` can remove a shard mid-read.
      // ENOENT ONLY: every other errno (EACCES, EIO, EISDIR) still throws, because those mean the
      // shard is there and unreadable, which is exactly the corruption this guard must not hide.
```

## loadPlanAtRef

Base revision `4e4275b2`, line 547, 25 comment lines.

```
/**
 * W1-T2220 remedy (c): load the plan from committed git objects — `git show <ref>:<path>` —
 * rather than the working tree, for the ONE caller that cannot afford {@link loadPlan}'s
 * stat/read/stat retry (remedy (a), "usually not partial"): `POST /v1/inbox/approve`, a
 * write-scoped, tier-HIGH gate (W1-T404) that hands off to a detached `rmd approve` spawn and
 * so is irreversible in the direction that matters. Git objects are immutable and
 * content-addressed, so a blob at a fixed `ref` CANNOT be torn by a concurrent `git checkout
 * --detach` truncating the working copy in place — this is atomic by construction, not merely
 * unlikely to race, the stronger guarantee a gate needs over a render.
 *
 * `ref` defaults to `"HEAD"` — the commit the shared working tree is already checked out to
 * (`checkout_target`'s `git checkout --detach "$TARGET"`), so this reads exactly what a quiet
 * working tree would show, no network fetch and no second checkout (design note (v): the
 * console/panel gets no checkout of its own). `repoRoot` is `deps.root`, the same repo root
 * every other git-backed helper in this module already runs `-C` against.
 *
 * NAMED COST, NEVER SILENT (design note (iii)(c), acceptance criterion 5): this reads the
 * COMMITTED plan at `ref` — an UNCOMMITTED working-tree edit to `plan/tasks.yaml` or a shard is
 * INVISIBLE here. That is a real behavior difference from {@link loadPlan}, stated here and
 * exercised by `test/main-plan-load-guard.test.ts`, never a silent divergence discovered later.
 *
 * Mirrors {@link loadPlan}'s own merge semantics (duplicate id across monolith/shard fails
 * loud, every `depends_on` must resolve within the merged view) so the two loaders agree on
 * every plan that is not mid-write — only the SOURCE of the bytes differs.
 */
```
