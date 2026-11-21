/**
 * lib/ledger-steps.ts — THE DECODER for `LedgerLine.step` (W1-T2764).
 *
 * THE ASYMMETRY THIS CLOSES. Every other closed vocabulary in this repo is refused by code:
 * `validateEscalationOptionKind`, `parseOrigin`, `resolveWipeTestFactor`, `resolveProducerIdentity`
 * (whose `PRODUCER_IDENTITIES` even carries its own `displayName`). `LedgerLine.step` (ledger.ts) is
 * none of these — a free string, written ad hoc across ~180 files, with no registry and no meaning
 * beside it. `DECISION_RELEVANT_LEDGER_STEPS`/`RENDER_RELEVANT_LEDGER_STEPS` (ledger.ts) SELECT from
 * that open universe for retention or rendering; neither DEFINES a step's meaning.
 *
 * WHY THIS MATTERS (learnings#ledger-step-name-is-a-claim-not-evidence). `armAutoMerge` returns one
 * of many outcomes and never throws; several arm nothing at all, yet `runTask` logged
 * `"automerge.armed"` UNCONDITIONALLY on every one of them — 176 ledger rows, 135 of them blind
 * (no `head_sha`), because a step's NAME was read as a claim about what happened rather than as one
 * string among several a writer can log. A step name with its writer's real outcome set beside it —
 * this module's whole job — makes that row legible as what it actually is.
 *
 * A DECODER, NEVER A RENAME. DECISIONS.md (2026-08-15): "Ledger step names, function names and
 * file paths are [[not free to change]]. Those are query keys: renaming one breaks every historical
 * question anyone can ask of the record." Every step below keeps its literal exactly as logged;
 * this registry only adds the plain-language meaning, its writer(s) and their real outcome set
 * beside it. Nothing here renames, relocates or removes a single logged literal.
 */

/**
 * SEEDED, NOT EXHAUSTIVE. `scripts/ledger-steps-check.mjs` (the ratchet) finds roughly five hundred
 * distinct step literals under `src/`; this registry seeds the ones read closely enough to state a
 * writer and an honest outcome set for, starting with the `automerge.*` family the learning above
 * names. Every literal this registry does not yet cover is exempted by
 * `scripts/ledger-steps-baseline.json` with a written, shrink-only reason (the
 * `task-id-existence-check.mjs` shape) — moving a literal OUT of that baseline and INTO
 * {@link LEDGER_STEPS} is the intended way this registry grows; nothing here regresses that.
 *
 * THE ONE SEAM. {@link meaningOfStep} is read by `rmd ledger-grep` (run-task.ts's
 * `ledgerGrepCommand`) to print a registered row's meaning beside a matched line; a step this
 * registry does not (yet) cover prints unchanged, exactly as before this task.
 */

/** One row of the registry. Every field is DESCRIPTIVE of an existing step; none of it is read
 *  back into a write path, so adding, correcting or removing a row changes no runtime behaviour. */
export interface LedgerStepRow {
  /** The exact literal `LedgerLine.step` carries — never renamed (DECISIONS.md, 2026-08-15). */
  readonly step: string;
  /** What this row means, in the operator-message register: what a reader should understand
   *  actually happened, not a restatement of the literal itself. Where a step is logged under
   *  more than one condition (or by more than one writer) that disagree, this says so plainly —
   *  see the `automerge.armed` row for the case the learning above names. */
  readonly meaning: string;
  /** The exported (or otherwise named) symbol(s) that actually perform the `log(...)`/
   *  `ctx.log(...)` call for this exact step literal, verified to exist by
   *  `test/every-ledger-step-has-a-meaning.test.ts` via a live grep of `src/` — a renamed writer
   *  cannot leave a stale claim standing here undetected. More than one entry means more than one
   *  call site genuinely logs this literal; see `meaning` for whether they agree. */
  readonly writer: readonly string[];
  /** Every distinct value (or condition) under which `writer` logs THIS step — so a step logged
   *  unconditionally, across every outcome its writer can produce, reads as unconditional rather
   *  than as a claim about one specific outcome. Never a restatement of a TypeScript union it
   *  happens to share a name with; derived by reading the writer's own branching. */
  readonly outcomes: readonly string[];
  /** The dotted prefix before the step's last segment — how the generated page
   *  (docs/ledger-steps.md) groups rows. Derived from `step`, never hand-maintained; see
   *  {@link stepFamily}. */
  readonly family: string;
}

/** The dotted prefix before a step's last segment (`"automerge.armed"` -> `"automerge"`), or the
 *  whole step when it carries no dot (never happens for a real step, but this must still return
 *  something rather than throw on a malformed one). Exported so the generator and this module's
 *  own test derive `family` the SAME way {@link LEDGER_STEPS} does, rather than a second copy. */
export function stepFamily(step: string): string {
  const idx = step.lastIndexOf(".");
  return idx === -1 ? step : step.slice(0, idx);
}

/** A registry row before `family` is derived — {@link LEDGER_STEPS}' own input, so `family` can
 *  never drift from `step` by hand-edit (there is nowhere to hand-edit it). */
type SeedRow = Omit<LedgerStepRow, "family">;

// ── W1-T2764: seeded from the automerge.* family learnings#ledger-step-name-is-a-claim-not-
// evidence names directly, plus one contrasting exhibit (panel.risk_override_recorded) where the
// step genuinely IS unconditional and single-meaning — read from `src/run-task.ts`,
// `src/lib/review.ts`, `src/lib/sweep.ts` and `src/lib/panel-actions.ts` at 2026-09-07.
const SEED_ROWS: readonly SeedRow[] = [
  {
    step: "judge_shadow.compared",
    meaning: "After the risk judge or the decision summary answered, the same prompt went once to a cash model in shadow and a reply came back. The row holds the role, both models and the cost of each call. A risk judge row also holds both answers and whether they agree; a decision summary row holds whether the reply parses and no agreement. W1-T12417: every fixed-option judge (risk, ci, fix-progress, verify-human, refresh-value, quiet-worker watchdog, head-rehome, typed judgment) writes it under its own role when its shadow is named; a decision-model shadow adds the distribution, the latency and model_surface decisions. Nothing acts on the row except the summary the config gardener reads.",
    writer: ["shadowJudgeCall"],
    outcomes: ["agreement true", "agreement false", "parses true", "parses false"],
  },
  {
    step: "judge_shadow.skipped",
    meaning: "The cash shadow of a risk judge or decision summary answer gave nothing to compare: the daily cash cap or a capacity limit refused it before any request (the row has a refusal), or the call failed, timed out or gave no usable answer. W1-T12417: a decision-model shadow also writes it for an unavailable candidate, a 429, a rejected answer and an abstention (the row has abstained, including below-threshold). The row holds the reason. The role's own answer is unchanged.",
    writer: ["shadowJudgeCall"],
    outcomes: ["refusal budget", "refusal capacity", "failed", "unparseable", "unavailable", "rate limited", "rejected", "abstained"],
  },
  {
    step: "git.dangling_ref_repaired",
    meaning: "A fetch through the git leaf or the fetch retry failed because a tracking ref named an object the clone lacks. The fetch refetched that one branch, or removed the tracking ref of a branch the remote no longer has (only while it still held the missing id), and then ran the fetch once more. One row per ref, with the clone, the ref, how and the milliseconds the repair took.",
    writer: ["danglingRefRepairPlan"],
    outcomes: ["refetched", "removed"],
  },
  {
    step: "git.dangling_ref_unrepaired",
    meaning: "A fetch failed on a ref that names a missing object, and this ref was not repaired, so the fetch was not run again. A local branch, a tag or any ref outside refs/remotes is only reported. Other reasons: the refetch, the removal or the listing failed or passed its time limit, more than 16 tracking refs dangled (the row carries the count), or no ref with a missing object was found.",
    writer: ["danglingRefRepairPlan"],
    outcomes: ["not_a_tracking_ref", "repair_failed", "over_the_bound", "no_dangling_ref"],
  },
  {
    step: "sweep_light.views_fallback",
    meaning: "A light pass could not use a fresh open-PR list: the read failed, was rate-limited or had not settled after 60 s. With a last good list younger than its age limit, the pass decides from that list, reads each head again at act time and stands a moved or unreadable head down. With no such list, the pass decides nothing, as before.",
    writer: ["createLightPassOpenPrList"],
    outcomes: ["rate_limited", "read_failed", "slow_read", "no_snapshot", "snapshot_too_old"],
  },
  {
    step: "routing.experiment.result",
    meaning: "A daily intention-to-treat routing experiment result, with separate pipeline metrics, task-cluster bootstrap intervals, the decision rule and sample requirement. Missing outcomes remain counted. Terminal results are preserved; the result changes no routing.",
    writer: ["recordRoutingExperimentResults"],
    outcomes: ["running", "concluded", "underpowered"],
  },
  {
    step: "routing.policy.estimate",
    meaning: "A daily estimate for one routed cell (capability, effort and task class) of how always-Claude, always-Codex and the logged policy would have done in each pipeline, from the probabilities the headroom auction and the fix learner logged. Hajek weights, a 0.05 trim, task-cluster bootstrap intervals and effective sample sizes; excluded rows are counted by reason. It reads concluded only past the experiments' decision rule and floor. One row per cell per day; nothing routes on it.",
    writer: ["recordRoutingPolicyEstimates"],
    outcomes: ["running", "concluded", "underpowered"],
  },
  {
    step: "recycle.inflight_reclaimed",
    meaning: "The recycle script moved an inflight lock to inflight/reclaimed/ because a process on this same host wrote it and that process is gone: its pid is dead, or the pid now belongs to a process that started after the lock. A lock whose process is alive with the lock's start time is never moved, whatever its age.",
    writer: ["reclaim_dead_inflight_locks"],
    outcomes: ["pid-dead", "pid-reused"],
  },
  {
    step: "host_cleanup.inflight_reclaimed",
    meaning: "The host janitor (deploy/rmd-host-cleanup.sh), in its six-hour or hourly pass, moved an inflight lock to inflight/reclaimed/ on the same test as recycle.inflight_reclaimed: written on this host, and its pid is dead or was used again. Locks of other hosts and of live processes stay.",
    writer: ["reclaim_host_inflight_locks"],
    outcomes: ["pid-dead", "pid-reused"],
  },
  {
    step: "daemon.inflight_host_lock_silent",
    meaning: "The daemon found an inflight lock that a host process wrote, whose run wrote no ledger row for longer than the longest closed quiet gap in the ledger window. The daemon cannot test a host pid from its container, so it only reports: the lock stays in place. One row per bound of silence, not per poll.",
    writer: ["reportSilentHostLocks"],
    outcomes: ["reported"],
  },
  {
    step: "issue_revalidation.attempt_spend",
    meaning: "One already-executed issue-revalidation judge attempt's own monetary evidence before verdict parsing, deduplicated by reported attempt identity. Unknown and unstarted prices stay unknown; API zero is reported evidence, subscription notional is separate, and no figure is an invoice or task outcome.",
    writer: ["issueRevalidationJudgeText"],
    outcomes: ["result", "failed", "not-started"],
  },
  {
    step: "machine_judge.attempt_spend",
    meaning: "One machine-filing judge attempt's own reported monetary evidence, before parsing. Unknown prices and unstarted calls stay unknown; subscription notional is separate and no figure is an invoice. Assignment and attempt receipts do not produce additional spend.",
    writer: ["productionMachineFilingJudgePorts"],
    outcomes: ["result", "failed", "not-started"],
  },
  {
    step: "sweep.update_branch.pending_guard",
    meaning: "The actual sweep selector declined the pending input head that would win with only its pending-CI guard removed. This is snapshot decision evidence; no saved run, CPU time or cash is established.",
    writer: ["runSweep"],
    outcomes: ["guarded"],
  },
  {
    step: "automerge.armed",
    meaning:
      "Auto-merge status was recorded for a PR. DISAGREEING WRITERS (the learning's own defect, " +
      "still live): `runTask` logs this literal UNCONDITIONALLY right after calling " +
      "`armAutoMergeAtOpen`, before anything is known about whether the arm stuck — the real " +
      "result rides only on the row's own `outcome` field, which may be any ArmOutcome or " +
      "`no-merge-boundary-refused`. `logArmAttribution` logs the SAME literal only when " +
      "`armOutcomeArmed(outcome)` is true (outcome `armed`, `direct-merged`, or a legacy `void` " +
      "return treated as armed) — a genuine success signal. Never read this step name alone as " +
      "\"arming succeeded\"; always read the row's `outcome` field first.",
    writer: ["runTask", "logArmAttribution"],
    outcomes: [
      "no-task-id",
      "head-unavailable",
      "ledger-refused",
      "armed",
      "direct-merged",
      "direct-merge-failed",
      "direct-merge-updated",
      "direct-merge-preflight-refused",
      "direct-merge-update-failed",
      "arm-error-ignored",
      "irreversible-refused",
      "hold-refused",
      "no-merge-boundary-refused",
    ],
  },
  {
    step: "automerge.arm_skipped",
    meaning:
      "Auto-merge was NOT attempted for this PR. `logArmAttribution` files every ArmOutcome that " +
      "is neither armed/direct-merged (see `automerge.armed`) nor one of the three genuinely-" +
      "attempted-and-failed outcomes (see `automerge.arm_failed`, named here but NOT independently " +
      "registered — it is produced only via `armSkipStepName`'s indirect return, never a literal " +
      "this registry's static census can see) under this name. `armIfVerdictPermits` also logs it " +
      "directly, before any arm is even attempted, for a dependabot PR (the dep-review lane owns " +
      "arming those) or when `decideAutoMergeArm` itself refuses.",
    writer: ["logArmAttribution", "armIfVerdictPermits"],
    outcomes: [
      "no-task-id",
      "head-unavailable",
      "ledger-refused",
      "direct-merge-updated",
      "direct-merge-preflight-refused",
      "irreversible-refused",
      "hold-refused",
      "plan-pr-held",
      "skipped",
    ],
  },
  {
    step: "automerge.clean_status_direct_merge",
    meaning:
      "GitHub refused `gh pr merge --auto` because the PR was ALREADY in clean/mergeable status " +
      "(every required check green), so `attemptArm`'s fallback merged it directly over REST " +
      "instead, and `logArmAttribution` filed this row once that fallback's outcome resolved to " +
      "`direct-merged`.",
    writer: ["logArmAttribution"],
    outcomes: ["direct-merged"],
  },
  {
    step: "automerge.rate_limit_refused",
    meaning:
      "`gh pr merge --auto` failed on an exhausted GitHub rate-limit bucket (W1-T1235). Filed " +
      "ALONGSIDE whatever step `automerge.armed`/`automerge.arm_skipped`/`automerge.arm_failed` " +
      "already recorded for this same attempt — the row exists so the spent budget is " +
      "discoverable by this ONE step name even when `attemptArm`'s REST fallback goes on to " +
      "rescue the merge (W1-T1255), which would otherwise leave no trace the quota was hit.",
    writer: ["logArmAttribution"],
    outcomes: [
      "no-task-id",
      "head-unavailable",
      "ledger-refused",
      "armed",
      "direct-merged",
      "direct-merge-failed",
      "direct-merge-updated",
      "direct-merge-preflight-refused",
      "direct-merge-update-failed",
      "arm-error-ignored",
      "irreversible-refused",
      "hold-refused",
    ],
  },
  {
    step: "automerge.disarmed",
    meaning:
      "A standing auto-merge arm was WITHDRAWN because a verdict computed after PR-open time " +
      "refused to arm (W1-T1215/impl-BF) — `disarmAutoMerge` reported the withdrawal actually " +
      "took effect on GitHub. Follows the OUTCOME, never the attempt: a withdrawal GitHub refused " +
      "files `automerge.disarm_skipped` instead (not independently registered here — like " +
      "`automerge.arm_failed`, it is produced only via a ternary, never a literal this registry's " +
      "static census can see).",
    writer: ["runTask", "withdrawArmIfVerdictRefuses"],
    outcomes: ["withdrawn"],
  },
  {
    step: "automerge.capped_override_used",
    meaning:
      "A CAPPED verdict (zero proofs executed) was armed anyway because a ledgered operator " +
      "override was present for this exact head — `resolveAutoMergeArm` files this row naming " +
      "who granted it, EXCLUDING a plan-only PR (which never consults an override at all, since " +
      "its capped status is structural, not a gate an override needs to lift).",
    writer: ["resolveAutoMergeArm"],
    outcomes: ["capped-override-used"],
  },
  {
    step: "automerge.capped_override_granted",
    meaning:
      "An operator ran `rmd review --override-capped-by <name> --override-capped-reason <reason>` " +
      "against a resolvable task, granting a ledgered escape hatch for one specific head that a " +
      "later `resolveAutoMergeArm` read (see `automerge.capped_override_used`) may honour.",
    writer: ["reviewCommand"],
    outcomes: ["capped-override-granted"],
  },
  {
    step: "panel.risk_override_recorded",
    meaning:
      "An operator acted on a risk-judge escalation instead of merging by hand in silence, " +
      "recording their disposition (`merged_by_hand` | `redispatched` | `abandoned`, " +
      "ledger.ts's RISK_OVERRIDE_DISPOSITIONS) and whether the judge itself was wrong or the risk " +
      "was knowingly accepted (ledger.ts's RISK_OVERRIDE_REASON_CLASSES). RECORDING ONLY — " +
      "nothing about this row decides dispatch or merge. A CONTRASTING EXHIBIT to the " +
      "`automerge.*` rows above: `recordRiskOverride` logs this literal (via the " +
      "`RISK_OVERRIDE_RECORDED_STEP` constant, not a bare quoted literal at the call site, which " +
      "is why the ratchet's static census cannot find it) on exactly ONE path — validation " +
      "succeeded — so this step name genuinely IS unconditional and single-meaning; not every " +
      "step in this repo is the `automerge.armed` defect.",
    writer: ["recordRiskOverride"],
    outcomes: ["recorded"],
  },
  {
    // W1-T4460 — filed as part of "give the synthetic task the PR's own surface and reload the
    // plan first": 8 of 65 measured fix rounds discarded real, valid edits as "the task declares
    // no files" because this row's own `task_id` never carried a commit surface. Registered here
    // per design note (iv) so the next diagnosis of that shape can decode it without re-reading
    // `dispatchFix`'s source.
    step: "sweep.fix.synthetic_task",
    meaning:
      "The fix rung is about to repair a PR whose task id was not found in the plan `dispatchFix` " +
      "holds — an agent-authored PR with no `Remudero-Task:` trailer, a RETRO/TRIAGE/PLAN/APPROVE " +
      "orchestrator lane, or (before W1-T4460) a genuinely filed task the sweep's own plan " +
      "snapshot merely predates. `task_id` carries the identity minted for it — the PR's own " +
      "trailer/lane id when one resolves, else the `PR-<n>` fallback `escalationTaskIdFor` mints. " +
      "Unconditional whenever `fixRungTaskFor`/`fixRungTaskWithPlanReload` resolves `synthetic: " +
      "true`, logged exactly once per dispatch, before the creditable-head guard is even checked.",
    writer: ["buildSweepEffects"],
    outcomes: ["synthetic"],
  },
  {
    // W1-T12545: a fix round re-enters merge-conflict mode instead of standing down on its own conflict.
    step: "fix.merge_mode_reentered",
    meaning:
      "A fix round outside merge-conflict mode read the PR's merge facts as CONFLICTING. A trial merge " +
      "of main at the round's head stopped with unmerged paths, and the merge was aborted. The next " +
      "round runs in merge-conflict mode with those paths (`conflicted_files`). Without unmerged paths " +
      "the round stands down for the sweep as before.",
    writer: ["runFixRung"],
    outcomes: ["reentered"],
  },
  {
    // W1-T12545: a fix child whose decision was a merge-conflict repair takes the moved head.
    step: "sweep.fix.child_head_adopted",
    meaning:
      "A fix child's recheck found that the PR head moved from `from_head` to `to_head` after the " +
      "sweep decided. The decision carried merge-conflict evidence, and the merge facts still read " +
      "CONFLICTING at the new head, so the child dispatches at `to_head` in merge-conflict mode. " +
      "Every other recheck and every write-time fence runs at `to_head`.",
    writer: ["runFixDispatchChild"],
    outcomes: ["adopted"],
  },
  {
    // W1-T4460 design note (iv) — the SAME literal `runDaemon`'s own top-of-tick `reloadPlanBinding`
    // already logs (src/lib/daemon.ts), reused rather than reinvented for `fixRungTaskWithPlanReload`
    // (src/lib/sweep.ts)'s narrower, dispatch-scoped re-read: ONE meaning ("a fresh plan was read
    // and adopted for what follows"), TWO writers at two different cadences.
    step: "daemon.plan_reloaded",
    meaning:
      "A fresh plan was read off disk and adopted. `runDaemon`'s `reloadPlanBinding` logs this " +
      "unconditionally at the top of every tick (and on a lane refill) whenever `deps.reloadPlan` " +
      "is wired and returns a plan; legitimately 0 rows in a deployment whose supervisor restarts " +
      "the process on every plan change instead (test/daemon-plan-freshness.test.ts's own note). " +
      "`fixRungTaskWithPlanReload` logs the identical literal, with the SAME `tasks` count field, " +
      "the ONE time a fix dispatch's task id is missing from the sweep's own plan snapshot in a " +
      "shape that is not already a known synthetic (lane/`PR-<n>`) id — closing the #6916/W1-T4413 " +
      "stale-snapshot gap without a second, disagreeing step name for the same fact.",
    writer: ["runDaemon", "fixRungTaskWithPlanReload"],
    outcomes: ["reloaded"],
  },
  {
    // W1-T10271, W1-T13182: observe only; nothing pauses dispatch on this row.
    step: "daemon.quota",
    meaning:
      "One GitHub rate-limit bucket (`bucket` core or graphql) as the daemon read it on one poll: " +
      "`remaining` and `resets_at`. The first row of a poll, core when core reads, also carries this " +
      "process's read cadence since the previous poll: `reads_stamped` by floor mode, `slots_yielded`, " +
      "`gated_admitted`, and `reads_by_call_site`, the same stamped reads by the code that made them " +
      "(`file:line` from the repository root, the shape of `github.pace.loop_wait` rows). It names the " +
      "15 largest call sites and sums the rest as `other`; its values sum to the sum of `reads_stamped`. " +
      "The site is sampled on one read in 8, and the reads after a sample count under that sample's site.",
    writer: ["runDaemon"],
    outcomes: ["read"],
  },
  {
    // W1-T12416: shadow only; no gate, route or judge reads this row.
    step: "decision.answered",
    meaning:
      "One decision-model request about one input: the role, the input digest, the candidate, its " +
      "deployment and request shape, the served model, the latency, the reserved, settled and held " +
      "dollars, the usage, the question count and each question's distribution, abstention or " +
      "rejection. A request refused before sending, a candidate that is unavailable and a request " +
      "that failed write the same row with their reason, so every request has exactly one row. " +
      "W1-T12417: a judge's shadow request adds the judged head as head_sha and, with it, the pull request as pr_url.",
    writer: ["askDecisionModel"],
    outcomes: ["answered", "refused", "unavailable", "failed"],
  },
  {
    // W1-T12418: offline only; no live judge, gate or route reads this row.
    step: "judge_replay.batch",
    meaning:
      "One replay of a judge corpus through one named model in one Anthropic Message Batch: the corpus, " +
      "the model, the batch id, the case count and the cases the scrub refused, the count of each result " +
      "type, the reserved, settled and held dollars at the batch price, the usage, and the retention " +
      "notice (batch prompts are kept 29 days). A refused, failed or unsettled replay writes the same row " +
      "with its reason, so every replay has exactly one row.",
    writer: ["replayJudgeCorpus"],
    outcomes: ["ended", "refused", "failed", "unsettled"],
  },
  {
    // W1-T12418: read by the judge calibration body through W1-T12414's scorer.
    step: "judge_replay.answered",
    meaning:
      "One result of a judge corpus replay batch: the corpus, the case, the model, the expected answer, " +
      "the result type and usage, and the recorded typed answer keyed by the model id. A request that " +
      "errored, was canceled or expired has no typed answer. W1-T12421: a direct replay writes one per " +
      "sent case, with lane direct, the model surface and the latency; its typed answer has the case's " +
      "expected answer as its outcome, and a failed request has no typed answer.",
    writer: ["replayJudgeCorpus"],
    outcomes: ["succeeded", "errored", "canceled", "expired", "failed"],
  },
  {
    // W1-T12421: offline only; no live judge, gate or route reads this row.
    step: "judge_replay.finished",
    meaning:
      "One direct replay of a judge corpus through one decision model or cash deployment, one request " +
      "per case: the candidate, its deployment and model surface, the role, the corpus name and digest, " +
      "the cost estimate and the replay ceiling, the cases sent, answered, abstained, rejected, too large " +
      "and failed, the reserved, settled and held dollars and the median latency. A refused replay (an " +
      "unknown corpus or candidate, or an estimate above the ceiling) and a stopped replay (a 429 that " +
      "stays after one retry, a budget refusal, an unavailable candidate) write the same row with their " +
      "reason, so every direct replay has exactly one row.",
    writer: ["replayJudgeCorpus"],
    outcomes: ["finished", "refused", "stopped"],
  },
  {
    // W1-T12425: a record only; the judge calibration reader joins it to typed answers by head.
    step: "verdict_calibration.outcome",
    meaning:
      "One merged head's outcome after its merge, from the same git read as the verdict calibration " +
      "report: the task id, the head, the merge commit and the window in days. reverted is a revert " +
      "inside the window, followup_fixed is a follow-up fix inside the window, and clean is a merge " +
      "older than the window with neither. A head and kind already recorded gets no second row, and a " +
      "head with a reverted or followup_fixed row never gets clean. No gate, route or judge reads it.",
    writer: ["runMeasurementCadenceReport"],
    outcomes: ["reverted", "followup_fixed", "clean"],
  },
  {
    // W1-T12546: a fix dispatch whose head moved before the checkout claim.
    step: "sweep.fix.head_adopted",
    meaning:
      "The fresh head read in a fix dispatch found a head other than the one the sweep judged. The PR " +
      "is open at that head, has no merge conflict, and its checks are red with readable failures, so " +
      "the dispatch continues at the new head with those failures. Every write-time fence (the live-state " +
      "preflight, the creditable-head check and the branch claim) runs again at the new head.",
    writer: ["buildSweepEffects"],
    outcomes: ["adopted"],
  },
  {
    // W1-T12546: the moved head was not fixable yet, so the dispatch took no claim.
    step: "sweep.fix.head_moved_deferred",
    meaning:
      "The fresh head read in a fix dispatch found a head other than the one the sweep judged, and the " +
      "new head is not fixable yet. `reason` says why: the evidence is not CI failure evidence, the PR " +
      "is not open, it moved again, it has a merge conflict, its checks are pending or green, or they " +
      "cannot be read. No claim is taken and no claim decline is written; the next pass judges the new head.",
    writer: ["buildSweepEffects"],
    outcomes: ["evidence_not_ci", "not_open", "head_moved_again", "merge_conflict", "checks_pending", "checks_green", "checks_none", "checks_unreadable", "failures_unreadable", "pr_unreadable"],
  },
  {
    // W1-T12546: the rung adopts a published head instead of standing down at rung.evidence_head.
    step: "fix.evidence_head_adopted",
    meaning:
      "A CI fix round found that the published branch advanced to the head its worktree holds before " +
      "the worker started. The checks at that head are red with readable failures, so the round takes " +
      "that head and those failures and builds the prompt again. Once per rung; otherwise it stands down " +
      "at rung.evidence_head as before.",
    writer: ["runFixRung"],
    outcomes: ["adopted"],
  },
  {
    // W1-T13046: the hold names the criteria and checks it covers.
    step: "fix.needs_design",
    meaning:
      "A fix round answered NEEDS_DESIGN and the fix lane holds the head: later passes at this head, task contract " +
      "and PR body stand down with no worker. `reason` is the worker's question. `covers_criteria` lists the unmet " +
      "claims the round was given, and `covers_checks` the red check names it was given. The sweep splits the covered " +
      "criteria into a held follow-up task, or closes and rebuilds the pull request when the hold covers every " +
      "criterion or only red checks. `needs_design_kind` and `needs_design_remedy` name W1-T12714's route.",
    writer: ["runFixRung"],
    outcomes: ["amendment-proposed", "escalate"],
  },
  {
    // W1-T12714: no needs-design report ends a pass with only a hold.
    step: "fix.needs_design_routed",
    meaning:
      "A fix round answered NEEDS_DESIGN and the fix lane sorted its report into one kind and took that " +
      "kind's remedy in the same round. environment: the round runs again on a fresh worker, and the first " +
      "such round in a rung is refunded. capability: the action the round could not take runs through its " +
      "owner (a body repair, the harness commit, a remote id reservation, or an amendment for a plan edit). contract: an " +
      "acceptance amendment is proposed and the head waits on it. design: the head is held and a person is " +
      "asked once. `kind`, `capability` and `remedy` name what happened. `reserved_task_id` records the id " +
      "passed to the next worker's prompt; a reservation failure records `outcome: refused` and its reason.",
    writer: ["runFixRung"],
    outcomes: ["redispatch-fresh-worker", "redispatch", "body-repair", "harness-commit", "id-reservation", "amendment-proposed", "escalate"],
  },
  {
    // W1-T12553: the daemon instances and hand runs share one GitHub App installation.
    step: "github.budget.throttled",
    meaning:
      "This daemon instance held back its GitHub reads, at most once per consumer and reset window. " +
      "\"share\": it spent its allowance, the remaining count less the write reserve divided by the " +
      "consumers on the installation. \"reserve\": the remaining count is in the write reserve. " +
      "\"refused\": GitHub refused a read for its rate limit. Writes never wait on this budget.",
    writer: ["daemonCommand"],
    outcomes: ["share", "reserve", "refused"],
  },
  {
    step: "github.budget.configured",
    meaning:
      "At start, a process that reads with the GitHub App installation token set its share of the installation " +
      "from the instance registry. role names the process: daemon, run_child or serve. The row gives " +
      "the consumer count and the registry it read (the host copy, else the checkout's copy when the host file is missing). " +
      "A run child also gives share_divisor, the host worker budget that splits the run-child share; " +
      "with no divisor it is 1 and divisor_reason is divisor_missing. " +
      "\"unconfigured\" names why there is no share (no installation id, an unreadable registry, no instance on the " +
      "installation); its reads are then paced as before. An instance found by neither RMD_INSTANCE_NAME nor the target " +
      "repo is \"unknown\", with instance_reason. Rotation keeps the row of each surviving boot.",
    writer: ["startProcessInstallationBudget"],
    outcomes: ["configured", "unconfigured"],
  },
  {
    step: "flow.open_repair_ages",
    meaning:
      "The daily flow pass read the open pull requests whose checks are red or whose branch conflicts. " +
      "For each one, oldest first, it gives the kind (red, conflict or both), its open age, the delay " +
      "from opening to its first fix round, the time since its latest fix round and how long it has " +
      "waited. A figure the ledger read cannot see reads unread, never zero. An unread, incomplete or " +
      "stale census or an incomplete ledger read writes UNKNOWN with its reason. A wait past 60 " +
      "minutes files one remedy task with origin flow-regression:open-repair-wait.",
    writer: ["runFlowGardener"],
    outcomes: ["OBSERVED", "UNKNOWN"],
  },
  {
    // W1-T12710: fix rounds that did not move one criterion get a different remedy.
    step: "fix.stall_remedy",
    meaning:
      "Before a fix round, the sweep found that `rounds` completed rounds left `criterion` unmet with the same " +
      "failure, or did not land, at or past fix.stallRounds. It took the first remedy not tried for this pull " +
      "request and criterion: `stronger-worker` (a round on the next mount in fix.modelOrder, named in `mount`, " +
      "with the earlier approaches listed), `amend-criterion` (an acceptance amendment proposal, `amendment_url`), or " +
      "`operator-input` (one escalation; with the parked-PR remedy wired, a held task instead, named in " +
      "`parked_pr_remedy` and `held_task_id`). \"skipped\" means the remedy could not apply; `reason` says why.",
    writer: ["takeStallRemedy"],
    outcomes: ["taken", "skipped"],
  },
  {
    // W1-T12709: an open pull request is never parked on a needs-human escalation.
    step: "parked_pr.remedy",
    meaning:
      "Where the sweep would stand down an open pull request on a needs-human escalation, a stage stall or " +
      "a clarification question, it took one remedy instead. `remedy` is fix-on-pr (a fix round, the stalled " +
      "stage or the review runs again on the pull request, and the fix lane's open-escalation stand-down is " +
      "released for this pull request and head), split-follow-up (the criteria that need operator input " +
      "move to the held task `held_task_id` by an acceptance amendment, and the pull request merges on the " +
      "rest) or close-and-rebuild (the pull request is closed and `held_task_id` rebuilds it). `cause` keys " +
      "one held task per pull request; `text` is the escalation text it replaces. \"refused\" means the " +
      "remedy could not act; `reason` says why, and the next pass tries again.",
    writer: ["takeParkedPrRemedy"],
    outcomes: ["taken", "refused"],
  },
  {
    // W1-T12711: a harness answer the code refused twice in one pass.
    step: "fix.progress_rerun",
    meaning:
      "The fix progress judge answered harness twice in one pass, and no off-host proof result supports it. " +
      "The sweep asked GitHub once to rerun the failed checks at this head. `red` is the red the judge saw. " +
      "When the rerun ends with the same red, the next judgment carries harnessRefuted and is not offered " +
      "harness at this head. \"unavailable\" means no failed run could be rerun, and the round runs.",
    writer: ["rerunChecksForHarness"],
    outcomes: ["rerun", "head-moved", "unavailable"],
  },
  {
    step: "serve.checkout_advanced",
    meaning:
      "Serve moved its own clean checkout forward to origin/main in place, with no write in flight, " +
      "instead of asking for a handoff. Every changed path was one serve reads per request (plan/feedback/) " +
      "or never loads, so the running generation and its warm read model stay. The row names the old " +
      "and new sha and the changed paths.",
    writer: ["gateStaleCodeExit"],
    outcomes: ["advanced"],
  },
  {
    step: "serve.checkout_advance_refused",
    meaning:
      "Serve tried to move its checkout forward in place and could not: the checkout moved, became " +
      "dirty, or git refused the checkout. The row names the reason. The next check of the same clean " +
      "advance asks for a handoff instead, as a code change does.",
    writer: ["gateStaleCodeExit"],
    outcomes: ["moved", "dirty", "git_refused"],
  },
  {
    // W1-T12712: a green pull request waiting for review starts before a new fix or build worker.
    step: "sweep.budget_yield",
    meaning:
      "A new fix round (lane \"fix\") or build lane (lane \"build\") did not start, because the review width " +
      "was held at host-worker-budget and a green head had waited for review longer than one sweep cadence. " +
      "One row per held spell: `waiting_heads` names the heads that waited and `oldest_wait_ms` the longest wait. " +
      "No running worker is stopped and the budget is unchanged; the held work starts once no such head waits.",
    writer: ["decideReviewPrecedence"],
    outcomes: ["fix", "build"],
  },
  {
    // W1-T13181: a refused request names the credential it carried and why each provider refused it.
    step: "service.unauthorized",
    meaning:
      "Serve answered 401: no identity provider granted the request. `method` and `path` name the request. " +
      "`presented` names the kinds of credential the request carried (bearer, operator_session, access, " +
      "tailnet_identity), or none. `refusals` holds one { provider, reason } for each provider, in the order " +
      "serve asked them. The row never holds a token, a session, a header value or a digest of one.",
    writer: ["createRoutedServer"],
    outcomes: [
      "no_credential",
      "unknown_token",
      "malformed_header",
      "expired_session",
      "unknown_session",
      "unverified_access",
      "untrusted_identity",
      "other_route",
      "not_granted",
    ],
  },
  {
    // W1-T13410: the gardener raises refs of the install clone that name an object the clone lacks.
    step: "host_resource.clone_refs_unresolvable",
    meaning:
      "A host's beat counted refs of its install clone that name an object the clone lacks, so a fetch there " +
      "fails. One escalation was raised for this episode. `count`, `first` and `install_dir` are from the beat; " +
      "`issue_url` is the escalation.",
    writer: ["observeCloneHealth"],
    outcomes: ["raised"],
  },
  {
    step: "host_resource.clone_refs_recovered",
    meaning: "A beat counted 0 refs that name a missing object after an escalation was raised. The episode ends.",
    writer: ["observeCloneHealth"],
    outcomes: ["recovered"],
  },
  {
    step: "host_resource.clone_gc_disabled",
    meaning:
      "The install clone's .git/gc.log has stayed with the same reason across beats that span 30 minutes, so " +
      "automatic gc does not run. One escalation was raised. `since` is the beat that first showed the reason.",
    writer: ["observeCloneHealth"],
    outcomes: ["raised"],
  },
  {
    step: "host_resource.clone_gc_recovered",
    meaning: "A beat read gc_verdict=ok after a gc.log escalation was raised. The episode ends.",
    writer: ["observeCloneHealth"],
    outcomes: ["recovered"],
  },
  {
    step: "skills.lifecycle_judged",
    meaning:
      "A knowledge-gardener skill-lifecycle pass judged one offered, approved skill before updating the proposal " +
      "registry. `status` and `basis` are its effectiveness verdict. The row carries the settle window and " +
      "each arm's terminal runs, merged runs and cost per merged PR.",
    writer: ["stageSkillLifecycleForAction"],
    outcomes: ["RETIRE-CANDIDATE", "REVIEW-CANDIDATE", "INSUFFICIENT EVIDENCE"],
  },
  {
    step: "inbox.draft_cash_skipped",
    meaning:
      "A cash inbox draft was not started, because its estimated whole run was larger than the model's window " +
      "(reason window) or the cash allowance left today (reason allowance). The refused cash run sent no request. " +
      "The proposal stays due without an attempt key. A retry resumes any earlier paid work separately.",
    writer: ["runDraftRung"],
    outcomes: ["window", "allowance"],
  },
];

/** THE REGISTRY — every step this task has decoded so far, `family` derived from `step` (never
 *  hand-maintained; see {@link stepFamily}). Read by {@link meaningOfStep}, by
 *  `scripts/ledger-steps-check.mjs` (subtracted from the found-literal census) and by
 *  `scripts/generate-ledger-steps.mjs` (rendered into docs/ledger-steps.md). */
export const LEDGER_STEPS: readonly LedgerStepRow[] = SEED_ROWS.map((row) => ({ ...row, family: stepFamily(row.step) }));

/** The one decoder seam (W1-T2764 design note iv). Returns the registered row for `step`, or
 *  `undefined` when this registry does not (yet) cover it — the caller (`rmd ledger-grep`) prints
 *  the matched row unchanged in that case, exactly as it did before this registry existed. */
export function meaningOfStep(step: string): LedgerStepRow | undefined {
  return LEDGER_STEPS.find((row) => row.step === step);
}
