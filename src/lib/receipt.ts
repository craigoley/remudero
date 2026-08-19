/**
 * `rmd receipt <pr>` — a deterministic, in-toto-STYLE run receipt assembled purely from ledger
 * ground truth (W1-T71, ratifies P17: "the ledger proves our runs to US; nothing proves them to
 * anyone ELSE").
 *
 * FIRST RUNG ONLY (see the task's design). `buildReceipt` is the pure generator: same ledger in,
 * byte-identical predicate out — no `Date.now()`, no random ids, no other nondeterminism rides
 * this payload, so two calls over one fixture (or a real re-generation of an old run's receipt)
 * produce EXACTLY the same bytes. A field with no ledger source for this run is
 * `{ value: null, reason }` — this generator NEVER fabricates a value; see {@link ReceiptField}.
 *
 * SIGNING IS OUT OF SCOPE, DELIBERATELY (v2 rung). This module imports nothing from `sigstore` or
 * `cosign` and never will until that follow-on task ships — the predicate shape here is a
 * standalone artifact a v2 signer wraps, not one built to already assume it.
 */

const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
const REMUDERO_RECEIPT_PREDICATE_TYPE = "https://remudero.dev/attestations/run-receipt/v1" as const;

/**
 * A predicate leaf whose ledger source may be absent for this run. Present carries `value` alone
 * (no `reason` key — keeps a real value from ever looking half-null); absent carries `value: null`
 * plus a human-readable `reason` naming which ledger line was missing. The generator never
 * invents a value for either branch — this type is the enforcement, not just documentation of it.
 */
export type ReceiptField<T> = { value: T } | { value: null; reason: string };

function present<T>(value: T): ReceiptField<T> {
  return { value };
}

function absent<T = never>(reason: string): ReceiptField<T> {
  return { value: null, reason };
}

/** One ledger line, as {@link buildReceipt} reads it — the same loose shape every other ledger
 *  consumer in the tree uses (`Array<Record<string, unknown>>`), never a narrower type this
 *  module would have to keep byte-for-byte in sync with the writer. */
export type ReceiptLedgerLine = Record<string, unknown>;

export interface BuildReceiptOptions {
  /** The task id whose run this receipt covers (e.g. `W1-T71`). */
  taskId: string;
  /** The merged PR/commit this receipt is a statement ABOUT — the in-toto `subject`. */
  prUrl: string;
}

/** The full assembled receipt: an in-toto `Statement` wrapping a Remudero-specific predicate. */
export interface ReceiptPredicate {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  predicateType: typeof REMUDERO_RECEIPT_PREDICATE_TYPE;
  subject: { task_id: string; pr_url: string };
  predicate: {
    run: { run_id: ReceiptField<string> };
    pr: { branch: ReceiptField<string> };
    learnings: { injected_ids: ReceiptField<string[]> };
    implement: {
      model: ReceiptField<string>;
      effort: ReceiptField<string>;
      num_turns: ReceiptField<number>;
      cost_usd: ReceiptField<number>;
    };
    review: { reviewer_outcome: ReceiptField<string> };
    merge: {
      state: ReceiptField<string>;
      automerge_outcome: ReceiptField<string>;
    };
    /** `correction.provenance` is a presence check, not a field value (W1-T75's line carries no
     *  single scalar worth surfacing here) — `true` when at least one such line exists for this
     *  task, `false` otherwise. Never absent: "no correction was ever recorded" IS the fact. */
    correction: { present: boolean };
    /** W1-T71's one new emission (see `prompt.linted`'s ledger line in run-task.ts): a sha256 of
     *  the rendered prompt this run actually spawned with. Absent-with-reason on any run that
     *  predates this task, or whose `prompt.linted` line was rotated away — never guessed. */
    prompt_template_hash: ReceiptField<string>;
  };
}

/** Reason string used whenever a run/task simply has no ledger line for a given step — kept as
 *  one function so every "why null" reason reads identically across the predicate. */
function noLineReason(step: string, taskId: string): string {
  return `no "${step}" ledger line found for task ${taskId}`;
}

/**
 * Assemble the deterministic run-receipt predicate for `opts.prUrl` from `ledgerLines` — the
 * ground truth the rationale verified live in the ledger (run.start, pr.opened,
 * learnings.injected, implement.done via `workerLedgerFields`, review.posted, pr.merged +
 * automerge.armed, correction.provenance).
 *
 * PURE: reads only `ledgerLines` and `opts`, writes nothing, and returns the identical value
 * (by `JSON.stringify`) for the identical input every time — no wall-clock, no randomness, no
 * generation timestamp anywhere in the payload. Scoped to `opts.taskId`'s lines only, so a shared
 * ledger fixture spanning multiple tasks/runs never bleeds one run's data into another's receipt.
 *
 * When a step's ledger line is absent for this task, its field(s) resolve to
 * `{ value: null, reason }` — see {@link ReceiptField}. Nothing here fabricates a value; a
 * receipt with three null fields is an honest receipt, not a broken one.
 */
export function buildReceipt(ledgerLines: readonly ReceiptLedgerLine[], opts: BuildReceiptOptions): ReceiptPredicate {
  const { taskId, prUrl } = opts;
  const lines = ledgerLines.filter((l) => l.task_id === taskId);

  const runStart = lines.find((l) => l.step === "run.start");
  const prOpened =
    [...lines].reverse().find((l) => l.step === "pr.opened" && l.pr_url === prUrl) ??
    [...lines].reverse().find((l) => l.step === "pr.opened");
  const learningsInjected = lines.find((l) => l.step === "learnings.injected");
  const implementDone = [...lines].reverse().find((l) => l.step === "implement.done");
  const reviewPosted = [...lines].reverse().find((l) => l.step === "review.posted");
  const prMerged = lines.find((l) => l.step === "pr.merged");
  const automergeArmed = [...lines].reverse().find((l) => l.step === "automerge.armed");
  const hasCorrection = lines.some((l) => l.step === "correction.provenance");
  const promptLinted = [...lines].reverse().find((l) => l.step === "prompt.linted");

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    predicateType: REMUDERO_RECEIPT_PREDICATE_TYPE,
    subject: { task_id: taskId, pr_url: prUrl },
    predicate: {
      run: {
        run_id:
          runStart && typeof runStart.run_id === "string"
            ? present(runStart.run_id)
            : absent(noLineReason("run.start", taskId)),
      },
      pr: {
        branch:
          prOpened && typeof prOpened.branch === "string"
            ? present(prOpened.branch)
            : absent(
                prOpened
                  ? `"pr.opened" ledger line for ${prUrl} carries no branch field`
                  : noLineReason("pr.opened", taskId),
              ),
      },
      learnings: {
        injected_ids:
          learningsInjected && Array.isArray(learningsInjected.matched_ids)
            ? present([...(learningsInjected.matched_ids as unknown[])].map((id) => String(id)))
            : absent(noLineReason("learnings.injected", taskId)),
      },
      implement: {
        model:
          implementDone && typeof implementDone.model === "string"
            ? present(implementDone.model)
            : absent(noLineReason("implement.done", taskId)),
        effort:
          implementDone && typeof implementDone.effort === "string"
            ? present(implementDone.effort)
            : absent(noLineReason("implement.done", taskId)),
        num_turns:
          implementDone && typeof implementDone.num_turns === "number"
            ? present(implementDone.num_turns)
            : absent(noLineReason("implement.done", taskId)),
        cost_usd:
          implementDone && typeof implementDone.cost_usd === "number"
            ? present(implementDone.cost_usd)
            : absent(noLineReason("implement.done", taskId)),
      },
      review: {
        reviewer_outcome:
          reviewPosted && typeof reviewPosted.reviewer_outcome === "string"
            ? present(reviewPosted.reviewer_outcome)
            : absent(
                reviewPosted
                  ? `"review.posted" ledger line for task ${taskId} carries no reviewer_outcome field`
                  : noLineReason("review.posted", taskId),
              ),
      },
      merge: {
        state:
          prMerged && typeof prMerged.state === "string"
            ? present(prMerged.state)
            : absent(noLineReason("pr.merged", taskId)),
        automerge_outcome:
          automergeArmed && typeof automergeArmed.outcome === "string"
            ? present(automergeArmed.outcome)
            : absent(noLineReason("automerge.armed", taskId)),
      },
      correction: { present: hasCorrection },
      prompt_template_hash:
        promptLinted && typeof promptLinted.prompt_template_hash === "string"
          ? present(promptLinted.prompt_template_hash)
          : absent(
              `no prompt_template_hash on any "prompt.linted" ledger line for task ${taskId} ` +
                `(emitted starting W1-T71 — absent on runs before it shipped, or if the line rotated away)`,
            ),
    },
  };
}
