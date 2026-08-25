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
 *
 * W1-T2257: `receiptCommand` used to hand `buildReceipt` the LIVE `ledger.ndjson` alone
 * (`readLedgerLines(ledgerPathFor(config))`) — exactly the slice rotation empties, since rotation
 * keeps only the newest rows per step and archives the rest. {@link resolveReceiptLedgerLines}
 * is the fix: it reads the archive∪live UNION via {@link resolveLedgerUnion}, scoped to the nine
 * `step`s {@link buildReceipt} actually reads ({@link RECEIPT_LEDGER_STEPS}) so the read stays
 * tractable (an unscoped union over every archive exhausted a 4 GB heap before scoring a single
 * receipt — see the task's rationale). A refused union (`ok: false` — zero archives matched, or a
 * matched archive could not be read) is surfaced as a refusal, `{ ok: false, reason }`, never
 * downgraded to an empty line list that would make every leaf read `absent` and look
 * indistinguishable from "this run never emitted the row".
 */

import { resolveLedgerUnion, type LedgerGrepFsDeps } from "./ledger-grep.js";

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

/** The `step` names {@link buildReceipt} reads from, named once so a scoped ledger read (see
 *  {@link resolveReceiptLedgerLines}) can never drift from what the generator actually consumes —
 *  design (ii): "the nine step names are derivable from the reader itself". */
const STEP = {
  runStart: "run.start",
  promptLinted: "prompt.linted",
  learningsInjected: "learnings.injected",
  implementDone: "implement.done",
  prOpened: "pr.opened",
  automergeArmed: "automerge.armed",
  reviewPosted: "review.posted",
  prMerged: "pr.merged",
  correctionProvenance: "correction.provenance",
} as const;

/** The nine ledger `step`s {@link buildReceipt} reads, in no particular order — the SAME list
 *  {@link resolveReceiptLedgerLines} compiles into its scoping pattern, so the two can never say
 *  a different nine. */
export const RECEIPT_LEDGER_STEPS: readonly string[] = Object.values(STEP);

/**
 * Everything {@link resolveReceiptLedgerLines} could resolve, or why it refused to. Mirrors
 * {@link LedgerUnionResult}'s own `ok` discriminant one layer up: `lines` is only ever populated
 * on `ok: true` — a refusal never degrades to an empty (and therefore indistinguishable from
 * "nothing was ever emitted") line list.
 */
export type ReceiptLedgerRead = { ok: true; lines: ReceiptLedgerLine[] } | { ok: false; reason: string };

/** Escapes a ledger `step` name for use inside the regex alternation below — every step here is a
 *  plain `word.word` name today, but this stays correct if that ever grows a metacharacter. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RECEIPT_LEDGER_STEP_PATTERN = RECEIPT_LEDGER_STEPS.map(
  (step) => `"step":"${escapeForRegExp(step)}"`,
).join("|");

/**
 * Compiled once, ahead of any call, and handed to {@link resolveLedgerUnion} as a `RegExp`
 * INSTANCE rather than the raw string above. `resolveLedgerUnion`'s string overload runs every
 * pattern through `sanitizeRegExp` — a `MAX_PATTERN_LENGTH` of 200 chars and a nested-quantifier
 * ReDoS guard — because ITS string input is `rmd ledger-grep <pattern>`'s OPERATOR-supplied
 * argument (`ledger-grep.ts`'s own doc). Nine step names alternated is 219 chars, past that cap,
 * but this pattern is neither operator input nor attacker-reachable: it is compiled once from
 * {@link RECEIPT_LEDGER_STEPS}, a fixed literal list this module owns, so the cap built for a
 * hostile CLI argument does not apply — passing the compiled `RegExp` is the same bypass
 * `resolveLedgerUnion`'s own signature (`pattern: string | RegExp`) already offers a trusted
 * internal caller.
 */
const RECEIPT_LEDGER_STEP_REGEXP = new RegExp(RECEIPT_LEDGER_STEP_PATTERN);

/**
 * Resolve the ledger lines {@link buildReceipt} needs from the archive∪live UNION
 * (`resolveLedgerUnion`, `./ledger-grep.js`) rather than the live `ledger.ndjson` file alone —
 * see this module's W1-T2257 header note for the defect this replaces.
 *
 * SCOPED BY STEP, NOT BY TASK. An unscoped union over every archive exhausted a 4 GB heap before
 * scoring a single receipt; scoped to {@link RECEIPT_LEDGER_STEPS} (the nine steps this receipt
 * actually reads) the same union returns comfortably. A task-id or time-window narrowing on top
 * of this is a further tightening this task deliberately leaves undone (design (ii)) — it is not
 * required for correctness, only for wall-clock, and bundling it here would widen this task past
 * "the reader is correct" into "the reader is fast".
 *
 * REFUSES, NEVER DOWNGRADES. When `resolveLedgerUnion` reports `ok: false` (zero archives matched
 * under `stateDir`, or a matched rotation could not be read), this returns `{ ok: false, reason }`
 * — the caller must surface that refusal, never fall back to treating it as "zero lines found",
 * which is exactly the silent-nulls shape this task exists to kill.
 *
 * PARSING NEVER FABRICATES. A matched line that fails to parse as a JSON object is corpus noise
 * (a torn write, a decoy), not a value this generator may guess at — it is dropped, never turned
 * into a leaf.
 */
export function resolveReceiptLedgerLines(stateDir: string, fsDeps?: LedgerGrepFsDeps): ReceiptLedgerRead {
  const result = resolveLedgerUnion(stateDir, RECEIPT_LEDGER_STEP_REGEXP, fsDeps);
  if (!result.ok) {
    const reason =
      result.archiveCount === 0
        ? `zero ledger archive files matched under ${stateDir} — refusing to read the live ledger ` +
          "file alone, which is exactly the rotation-emptied slice this refusal exists to avoid"
        : `${result.unread.length} matched ledger rotation(s) under ${stateDir} could not be read: ` +
          result.unread.join(", ");
    return { ok: false, reason };
  }
  const lines: ReceiptLedgerLine[] = [];
  for (const raw of result.matches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Not valid JSON — never guessed into a leaf, just dropped.
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      lines.push(parsed as ReceiptLedgerLine);
    }
  }
  return { ok: true, lines };
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

  const runStart = lines.find((l) => l.step === STEP.runStart);
  const prOpened =
    [...lines].reverse().find((l) => l.step === STEP.prOpened && l.pr_url === prUrl) ??
    [...lines].reverse().find((l) => l.step === STEP.prOpened);
  const learningsInjected = lines.find((l) => l.step === STEP.learningsInjected);
  const implementDone = [...lines].reverse().find((l) => l.step === STEP.implementDone);
  const reviewPosted = [...lines].reverse().find((l) => l.step === STEP.reviewPosted);
  const prMerged = lines.find((l) => l.step === STEP.prMerged);
  const automergeArmed = [...lines].reverse().find((l) => l.step === STEP.automergeArmed);
  const hasCorrection = lines.some((l) => l.step === STEP.correctionProvenance);
  const promptLinted = [...lines].reverse().find((l) => l.step === STEP.promptLinted);

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    predicateType: REMUDERO_RECEIPT_PREDICATE_TYPE,
    subject: { task_id: taskId, pr_url: prUrl },
    predicate: {
      run: {
        run_id:
          runStart && typeof runStart.run_id === "string"
            ? present(runStart.run_id)
            : absent(noLineReason(STEP.runStart, taskId)),
      },
      pr: {
        branch:
          prOpened && typeof prOpened.branch === "string"
            ? present(prOpened.branch)
            : absent(
                prOpened
                  ? `"pr.opened" ledger line for ${prUrl} carries no branch field`
                  : noLineReason(STEP.prOpened, taskId),
              ),
      },
      learnings: {
        injected_ids:
          learningsInjected && Array.isArray(learningsInjected.matched_ids)
            ? present([...(learningsInjected.matched_ids as unknown[])].map((id) => String(id)))
            : absent(noLineReason(STEP.learningsInjected, taskId)),
      },
      implement: {
        model:
          implementDone && typeof implementDone.model === "string"
            ? present(implementDone.model)
            : absent(noLineReason(STEP.implementDone, taskId)),
        effort:
          implementDone && typeof implementDone.effort === "string"
            ? present(implementDone.effort)
            : absent(noLineReason(STEP.implementDone, taskId)),
        num_turns:
          implementDone && typeof implementDone.num_turns === "number"
            ? present(implementDone.num_turns)
            : absent(noLineReason(STEP.implementDone, taskId)),
        cost_usd:
          implementDone && typeof implementDone.cost_usd === "number"
            ? present(implementDone.cost_usd)
            : absent(noLineReason(STEP.implementDone, taskId)),
      },
      review: {
        reviewer_outcome:
          reviewPosted && typeof reviewPosted.reviewer_outcome === "string"
            ? present(reviewPosted.reviewer_outcome)
            : absent(
                reviewPosted
                  ? `"review.posted" ledger line for task ${taskId} carries no reviewer_outcome field`
                  : noLineReason(STEP.reviewPosted, taskId),
              ),
      },
      merge: {
        state:
          prMerged && typeof prMerged.state === "string"
            ? present(prMerged.state)
            : absent(noLineReason(STEP.prMerged, taskId)),
        automerge_outcome:
          automergeArmed && typeof automergeArmed.outcome === "string"
            ? present(automergeArmed.outcome)
            : absent(noLineReason(STEP.automergeArmed, taskId)),
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
