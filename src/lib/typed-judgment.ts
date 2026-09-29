import type { Mount } from "./mounts.js";
import { benchmarkNonDispatchSpawn } from "./benchmark-run.js";
import { spawnWorker, type SpawnWorkerArgs } from "./worker.js";

/**
 * Typed-choice judgment (W1-T4672) — Jev's model (TypeSafe AI; reference agent
 * https://github.com/browser-use/jev-ultrafast, docs https://docs.typesafe.ai/introduction):
 * ONE stateless, tool-less call that answers a fixed-option question with a probability
 * DISTRIBUTION over those options, in ~100-180ms, rather than a full agent session that
 * self-reports a scalar confidence.
 *
 * WHY: {@link "./risk-judge.js".RiskJudgeVerdict.confidence} is the judge's OWN self-report —
 * a 0.85 confidence produced a wrong escalation (docs/forensics/risk-judge.md, #4316,
 * MEASURED 2026-09-06). A typed-choice call has no self-reported scalar to get wrong: the
 * model MUST spend its whole probability mass across the declared option set, and any
 * response that does not is REJECTED outright rather than coerced into a guess.
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

/** How far a distribution's sum may drift from 1 and still be accepted — floating-point
 *  slack only, never a licence for a model to under- or over-commit its probability mass. */
export const TYPED_JUDGMENT_SUM_TOLERANCE = 0.01;

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
  const exampleEntries = opts.options.map((o, i) => `"${o}": ${i === 0 ? "0.7" : "0.0"}`).join(", ");
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
    `  TYPED_JUDGMENT: {${exampleEntries}}`,
  ].join("\n");
}

/** Parse the `TYPED_JUDGMENT:` line. Rejects (never coerces) an unparseable line, a
 *  non-object payload, an out-of-set key, a missing option, a non-finite/out-of-range
 *  value, or a distribution that does not sum to ~1. */
export function parseTypedJudgmentResponse<TOption extends string>(
  text: string,
  options: readonly TOption[],
): TypedJudgmentResult<TOption> {
  const match = text.match(/TYPED_JUDGMENT:\s*(\{.*\})\s*$/m);
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

  const distribution = {} as Record<TOption, number>;
  let sum = 0;
  for (const option of options) {
    const value = record[option];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { kind: "rejected", reason: `option "${option}" was not a finite probability in [0, 1]`, raw: text };
    }
    distribution[option] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > TYPED_JUDGMENT_SUM_TOLERANCE) {
    return { kind: "rejected", reason: `distribution summed to ${sum.toFixed(3)}, not 1`, raw: text };
  }
  return { kind: "distribution", distribution };
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

/** Run one typed-choice call and parse its response. `spawn` is injectable for a
 *  caller's own resolved dependency (mirrors {@link "./risk-judge.js".spawnRiskJudgeWorker}). */
export async function runTypedJudgment<TOption extends string>(opts: {
  question: string;
  options: readonly TOption[];
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): Promise<TypedJudgmentResult<TOption>> {
  const spawn = opts.spawn ?? benchmarkNonDispatchSpawn("typed-judgment");
  const result = await spawn(buildTypedJudgmentSpawnArgs(opts));
  return parseTypedJudgmentResponse(result.text, opts.options);
}
