import type { JudgePrimary, JudgeShadowArm, Mount } from "./mounts.js";
import { benchmarkNonDispatchSpawn } from "./benchmark-run.js";
import { askPrimaryCandidate, shadowJudgeCall, type JudgedHead, type ShadowJudgeCall } from "./judge-shadow.js";
import { spawnWorker, type SpawnWorkerArgs } from "./worker.js";

/**
 * Typed-choice judgment (W1-T4672) — Jev's model (TypeSafe AI; reference agent
 * https://github.com/browser-use/jev-ultrafast, docs https://docs.typesafe.ai/introduction):
 * A tool-less, one-turn SDK worker answers a fixed-option question with a probability
 * DISTRIBUTION. This adopts the typed-question pattern, not TypeSafe's runtime or latency:
 * the ordinary Remudero worker still starts, and its latency must be measured independently.
 *
 * WHY: {@link "./risk-judge.js".RiskJudgeVerdict.confidence} is the judge's OWN self-report —
 * a 0.85 confidence produced a wrong escalation (docs/forensics/risk-judge.md, #4316,
 * MEASURED 2026-09-06). A model-generated distribution is still a judgment, not measured
 * calibration. Normalization proves only the output contract: the model MUST spend its
 * probability mass across the declared options, or its response is REJECTED, never coerced.
 *
 * TOOL-LESS AND ONE TURN, BY CONSTRUCTION: {@link TYPED_JUDGMENT_TOOLS} is empty and
 * {@link TYPED_JUDGMENT_MAX_TURNS} is 1 — there is nothing to explore and nothing to retry
 * mid-session; the whole question is baked into the prompt, exactly like today's tool-less
 * judges ({@link "./risk-judge.js".RISK_JUDGE_TOOLS}, {@link
 * "./verify-human-judge.js".VERIFY_HUMAN_JUDGE_TOOLS}) but WITHOUT the multi-turn session
 * those still spawn.
 *
 * OUT-OF-SET IS REJECTED, NEVER COERCED: an unknown key, a missing option, a non-numeric or
 * out-of-range value, or a distribution that does not sum to ~1 all return {@link
 * TypedJudgmentRejected} rather than a best-effort guess at what the model meant.
 */

/** Empty by construction — everything the call needs is baked into the prompt. */
export const TYPED_JUDGMENT_TOOLS: readonly string[] = [];

/** PRIMARY CONTROL (W1-T1266): every typed-judgment call runs at exactly this cap, always —
 *  not a backstop that only fires once something else has failed. One stateless call per
 *  question is the whole design (Jev's fan-out answers a batch of dependent questions in a
 *  single call; this module answers one typed-choice question per call), so there is no
 *  healthy multi-turn path this could ever need to raise. */
export const TYPED_JUDGMENT_MAX_TURNS = 1;

// How far a distribution's sum may drift from 1 and still be accepted. W1-T12417: defined in decision-model.ts, which
// this module's shadow imports through judge-shadow.ts, so the two modules form no import ring.
import { TYPED_JUDGMENT_SUM_TOLERANCE } from "./decision-model.js";
export { TYPED_JUDGMENT_SUM_TOLERANCE };

/** A probability distribution over the fixed option set — every option present, every
 *  value a finite number in [0, 1]. */
export type TypedJudgmentDistribution<TOption extends string> = Record<TOption, number>;

export interface TypedJudgmentOutcome<TOption extends string> {
  kind: "distribution";
  distribution: TypedJudgmentDistribution<TOption>;
}

/** Anything that is not a clean, in-set, normalized distribution — the raw text is kept
 *  (capped by the caller if it renders this into a ledger row) so a rejection stays
 *  diagnosable rather than a silent coercion. */
export interface TypedJudgmentRejected {
  kind: "rejected";
  reason: string;
  raw: string;
}

export type TypedJudgmentResult<TOption extends string> = TypedJudgmentOutcome<TOption> | TypedJudgmentRejected;

/** Render the typed-choice question: the caller's own question text, the fixed option
 *  set, and the one machine-readable line the parser below reads back. */
export function buildTypedJudgmentPrompt<TOption extends string>(opts: {
  question: string;
  options: readonly TOption[];
}): string {
  if (opts.options.length === 0 || new Set(opts.options).size !== opts.options.length) {
    throw new Error("typed judgment requires non-empty distinct options");
  }
  const example = JSON.stringify(Object.fromEntries(opts.options.map(o => [o, 1 / opts.options.length])));
  return [
    opts.question,
    "",
    `Answer with a probability DISTRIBUTION over EXACTLY these options — no others,`,
    `none omitted, values in [0, 1] summing to 1:`,
    ...opts.options.map((o) => `  ${o}`),
    "",
    `MACHINE-READABLE OUTPUT (required, and nothing else on the line): emit exactly one`,
    `JSON object on a single line, prefixed TYPED_JUDGMENT:, whose keys are exactly the`,
    `options above:`,
    "The example illustrates formatting only, not an answer to this input.",
    `  TYPED_JUDGMENT: ${example}`,
  ].join("\n");
}

/** Parse the `TYPED_JUDGMENT:` line. Rejects (never coerces) an unparseable line, a
 *  non-object payload, an out-of-set key, a missing option, a non-finite/out-of-range
 *  value, or a distribution that does not sum to ~1. */
export function parseTypedJudgmentResponse<TOption extends string>(
  text: string,
  options: readonly TOption[],
): TypedJudgmentResult<TOption> {
  if (options.length === 0 || new Set(options).size !== options.length) {
    return { kind: "rejected", reason: "typed judgment requires non-empty distinct options", raw: text };
  }
  const match = text.match(/TYPED_JUDGMENT:[ \t]*([^\r\n]+)$/m);
  if (!match) {
    return { kind: "rejected", reason: "no TYPED_JUDGMENT line found", raw: text };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { kind: "rejected", reason: "TYPED_JUDGMENT payload was not valid JSON", raw: text };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "rejected", reason: "TYPED_JUDGMENT payload was not an object", raw: text };
  }

  const record = parsed as Record<string, unknown>;
  const optionSet = new Set<string>(options);
  const outOfSet = Object.keys(record).filter((k) => !optionSet.has(k));
  if (outOfSet.length > 0) {
    return { kind: "rejected", reason: `out-of-set option(s): ${outOfSet.join(", ")}`, raw: text };
  }
  const missing = options.filter((o) => !(o in record));
  if (missing.length > 0) {
    return { kind: "rejected", reason: `missing option(s): ${missing.join(", ")}`, raw: text };
  }

  const entries: [TOption, number][] = [];
  let sum = 0;
  for (const option of options) {
    const value = record[option];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { kind: "rejected", reason: `option "${option}" was not a finite probability in [0, 1]`, raw: text };
    }
    entries.push([option, value]);
    sum += value;
  }
  if (Math.abs(sum - 1) > TYPED_JUDGMENT_SUM_TOLERANCE) {
    return { kind: "rejected", reason: `distribution summed to ${sum.toFixed(3)}, not 1`, raw: text };
  }
  return { kind: "distribution", distribution: Object.fromEntries(entries) as Record<TOption, number> };
}

/** The option with the highest mass — `undefined` for an empty distribution (never
 *  possible once {@link parseTypedJudgmentResponse} has accepted it, since every option
 *  is present by construction; kept total for callers that build a distribution by hand). */
export function argmaxTypedJudgmentOption<TOption extends string>(
  distribution: TypedJudgmentDistribution<TOption>,
): TOption | undefined {
  let best: TOption | undefined;
  let bestValue = -Infinity;
  for (const option of Object.keys(distribution) as TOption[]) {
    const value = distribution[option];
    if (value > bestValue) {
      best = option;
      bestValue = value;
    }
  }
  return best;
}

/** Build the spawn args for a real typed-judgment call — pure, so the "no tools, one
 *  turn" contract is unit-testable without a spawn. */
export function buildTypedJudgmentSpawnArgs<TOption extends string>(opts: {
  question: string;
  options: readonly TOption[];
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildTypedJudgmentPrompt(opts),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: TYPED_JUDGMENT_MAX_TURNS,
    tools: [...TYPED_JUDGMENT_TOOLS],
  };
}

/** W1-T12417: what a decision model is told about a typed-judgment question: the input is the question itself. */
const TYPED_JUDGMENT_DECISION_INSTRUCTIONS = "The input is a question. Choose the option that answers it.";

/** Run one typed-choice call and parse its response. `spawn` is injectable for a
 *  caller's own resolved dependency (mirrors {@link "./risk-judge.js".spawnRiskJudgeWorker}). */
export async function runTypedJudgment<TOption extends string>(opts: {
  question: string;
  options: readonly TOption[];
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
  /** W1-T12417: the role this spawn answers for, its ledger and its shadow arm. With one, the spawn's answer is asked
   *  of the arm afterwards (judge-shadow.ts) and the result returned here is the spawn's own. */
  shadow?: { role: "head-rehome" | "typed-judgment"; key: string; arm: JudgeShadowArm | undefined;
    log: (step: string, fields: Record<string, unknown>) => void; head?: JudgedHead;
    /** W1-T12417: a decision model that answers first. Its answer is the result when it clears its threshold, and the
     *  spawn below answers when it does not. */
    primary?: JudgePrimary;
    /** The decision-model seams of the primary and of the shadow, for a test; production reads the host config. */
    decisions?: ShadowJudgeCall<unknown>["decisions"] };
}): Promise<TypedJudgmentResult<TOption>> {
  const spawn = opts.spawn ?? benchmarkNonDispatchSpawn("typed-judgment");
  if (opts.shadow?.primary !== undefined) {
    const { role, key, primary, log, head, decisions } = opts.shadow;
    const answered = await askPrimaryCandidate({ role, key, primary, question: { instructions: TYPED_JUDGMENT_DECISION_INSTRUCTIONS, options: opts.options },
      input: opts.question, cwd: opts.cwd, log, ...(head === undefined ? {} : { head }), ...(decisions === undefined ? {} : { decisions }) });
    if (answered !== undefined) {
      return { kind: "distribution", distribution: Object.fromEntries(opts.options.map((option) => [option, answered.distribution.find((entry) => entry.option === option)!.probability])) as TypedJudgmentDistribution<TOption> };
    }
  }
  const args = buildTypedJudgmentSpawnArgs(opts);
  const result = await spawn(args);
  const parsed = parseTypedJudgmentResponse(result.text, opts.options);
  const shadow = opts.shadow;
  if (shadow !== undefined && shadow.arm !== undefined) {
    const top = (text: string): TOption | undefined => {
      const read = parseTypedJudgmentResponse(text, opts.options);
      return read.kind === "distribution" ? argmaxTypedJudgmentOption(read.distribution) : undefined;
    };
    // Not awaited: the caller holds the spawn's own answer before any shadow request is made.
    void shadowJudgeCall({ role: shadow.role, key: shadow.key, mount: { ...opts.mount, shadow: shadow.arm }, primaryArgs: args, primary: result,
      primaryAnswer: parsed.kind === "distribution" ? argmaxTypedJudgmentOption(parsed.distribution) : undefined, parse: top,
      agreementKey: (option) => option, input: opts.question, spawn, log: shadow.log,
      question: { instructions: TYPED_JUDGMENT_DECISION_INSTRUCTIONS, options: opts.options },
      ...(shadow.head === undefined ? {} : { head: shadow.head }), ...(shadow.decisions === undefined ? {} : { decisions: shadow.decisions }) });
  }
  return parsed;
}
