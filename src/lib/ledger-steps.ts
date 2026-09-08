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
