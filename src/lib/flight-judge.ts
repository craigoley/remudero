import type { AcceptanceCriterion } from "./plan.js";
import type { Mount } from "./mounts.js";
import type { TurnToolCall } from "./flight-signals.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/**
 * Flight judge (Layer 2) — MASTER-PLAN §4B, W1-T21.
 *
 * Invoked ONLY on a Layer-1 tripwire (flight-signals.ts, W1-T20) — never
 * resident per turn. A FRESH-context judge sees the task's goal, its
 * acceptance criteria, and the last N turns' TOOL CALLS AND RESULTS — never
 * the worker's own reasoning (the maker sees its own trail; the verifier
 * sees only behavior + rubric, so it cannot be talked into agreement by the
 * maker's narrative). This is enforced BY CONSTRUCTION here, not by
 * instruction alone: {@link JudgeTurnEvidence} has no field that could carry
 * an assistant's narrated text — {@link extractJudgeTurnEvidence} discards
 * assistant "text" content blocks and keeps only `tool_use` calls and their
 * `tool_result` outputs.
 *
 * The judge ADVISES; a DETERMINISTIC controller ACTS on the advice (Standing
 * rule 12) — {@link planJudgeAction} is a pure function, so its mapping from
 * verdict to action is unit-testable without ever spawning an LLM:
 *   - `spiraling` + high confidence  -> halt + dispatch a DIAGNOSE worker
 *     (never a third blind patch, Standing rule 5) — this module exposes NO
 *     "apply a patch" dependency at all, so a spiraling verdict structurally
 *     cannot produce a third blind edit.
 *   - `off_track`                    -> halt + escalate.
 *   - `converging`                   -> raise the tripped threshold ONCE,
 *     log it, continue (slow ≠ stuck).
 *   - anything else                  -> deferred to the judge's own
 *     `recommendation`, EXCEPT the judge is capped at K invocations per run
 *     (`FlightJudgeConfig.maxInvocationsPerRun`) — the Kth invocation MUST
 *     resolve to a terminal action (halt + diagnose/escalate), never another
 *     deferral (no infinite advisory loop).
 *
 * The judge NEVER edits code and NEVER merges: its real SDK spawn
 * ({@link buildFlightJudgeSpawnArgs}) carries an EMPTY tool list
 * ({@link JUDGE_TOOLS}) — it cannot invoke Write/Edit/Bash/anything, by
 * construction, because everything it needs to judge is already baked into
 * its prompt (the goal, criteria, and the distilled turn evidence). This is
 * the strongest form of "read-only": not a permission it is told to respect,
 * but a tool it does not have.
 *
 * The judge also rides a HIGHER tier than the worker it supervises (G-17
 * Tier Invariant) — asserted at LOAD time in mounts.ts, the same enforcement
 * shape as the Architect's own invariant (a `judge` mount below the worker
 * ceiling is REJECTED before any run can use it).
 */

// ── The verdict contract ────────────────────────────────────────────────

export type JudgeState = "productive" | "converging" | "spiraling" | "blocked" | "off_track";
export type JudgeRecommendation = "continue" | "nudge" | "halt_and_diagnose" | "escalate";

/** What the fresh-context judge returns. ADVISORY — never itself an action. */
export interface JudgeVerdict {
  state: JudgeState;
  /** Concrete observations from the tool calls/results, never the worker's own words. */
  evidence: string[];
  recommendation: JudgeRecommendation;
  /** 0..1 — how confident the judge is in `state`. */
  confidence: number;
}

// ── What the judge is shown (goal + criteria + behavior, never reasoning) ──

/** One turn's OBSERVABLE behavior: the tool calls issued and their results.
 * Deliberately has no field for assistant narration/reasoning — there is
 * nowhere to put it, so a caller cannot leak it in even by mistake. */
export interface JudgeTurnEvidence {
  turn: number;
  toolCalls: TurnToolCall[];
  /** Tool result contents observed this turn (stringified), success or error alike. */
  toolResults: string[];
}

export interface JudgeInput {
  taskId: string;
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  /** The last N turns of tool calls + results ONLY (design: never the worker's reasoning). */
  recentTurns: JudgeTurnEvidence[];
}

// ── stream-json reducer: raw SDK messages -> JudgeTurnEvidence[] ──────────
// Mirrors flight-signals.ts's extractTurnSnapshots (the same raw shape
// collectWorkerResult/worker.ts consumes), but keeps ALL tool results (not
// just errors) since the judge's whole job is reading behavior, and — the
// one deliberate omission — NEVER an assistant "text" content block.

interface RawContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface RawMessage {
  type?: string;
  message?: { content?: unknown };
}

/** Best-effort stringification of a tool_result's content for the judge's evidence window. */
function stringifyResult(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Reduce a raw SDK-shaped `stream-json` message array into
 * `JudgeTurnEvidence[]`. One turn per `type:"assistant"` message; its
 * `tool_use` blocks are that turn's tool calls — assistant `text` blocks are
 * DROPPED, never carried into the evidence (the design's "never the worker's
 * reasoning" enforced structurally). A following `type:"user"` message's
 * `tool_result` blocks become that same turn's results, whatever their
 * content — success or error alike (the judge reads behavior, not just failure).
 */
export function extractJudgeTurnEvidence(rawMessages: unknown[]): JudgeTurnEvidence[] {
  const turns: JudgeTurnEvidence[] = [];
  let turn = 0;

  for (const raw of rawMessages) {
    const msg = raw as RawMessage;
    if (msg.type === "assistant") {
      turn += 1;
      const content = Array.isArray(msg.message?.content)
        ? (msg.message!.content as RawContentBlock[])
        : [];
      const toolCalls: TurnToolCall[] = content
        .filter((b) => b?.type === "tool_use" && typeof b.name === "string")
        .map((b) => ({ name: b.name as string, input: b.input }));
      turns.push({ turn, toolCalls, toolResults: [] });
    } else if (msg.type === "user" && turns.length > 0) {
      const content = Array.isArray(msg.message?.content)
        ? (msg.message!.content as RawContentBlock[])
        : [];
      const current = turns[turns.length - 1];
      for (const block of content) {
        if (block?.type === "tool_result") {
          current.toolResults.push(stringifyResult(block.content));
        }
      }
    }
  }
  return turns;
}

// ── The fresh-context judge prompt (no tools, never edits) ────────────────

/**
 * Render the FRESH-context judge's prompt. It carries the goal, the
 * acceptance criteria, and the distilled turn evidence — nothing else. The
 * judge is told explicitly it has no tools and must never be asked to act;
 * it only classifies and recommends via the machine-readable contract below.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  const criteria =
    input.acceptanceCriteria.map((c, i) => `  ${i + 1}. CLAIM: ${c.claim}\n     PROOF: ${c.proof}`).join("\n") ||
    "  (none stated)";

  const turns =
    input.recentTurns
      .map((t) => {
        const calls =
          t.toolCalls.map((c) => `      - ${c.name}(${JSON.stringify(c.input)})`).join("\n") ||
          "      (no tool calls)";
        const results =
          t.toolResults.map((r) => `      < ${r.slice(0, 400)}`).join("\n") || "      (no results)";
        return `  Turn ${t.turn}:\n    tool calls:\n${calls}\n    results:\n${results}`;
      })
      .join("\n") || "  (no turns observed)";

  return [
    `You are the FLIGHT JUDGE (Layer 2, MASTER-PLAN §4B) — a FRESH-context`,
    `advisory judge. You have NO tools and NO access to the worker's own`,
    `reasoning or commentary. You see ONLY: the task's goal, its acceptance`,
    `criteria, and the last ${input.recentTurns.length} turn(s) of TOOL CALLS`,
    `AND THEIR RESULTS. Judge PROCESS from behavior alone — never artifact,`,
    `never the worker's own narration (you were not given any).`,
    ``,
    `You NEVER edit code and NEVER merge — you cannot; you have no tools. You`,
    `ONLY advise; a deterministic controller decides what happens next`,
    `(Standing rule 12).`,
    ``,
    `TASK: ${input.taskId}`,
    `GOAL: ${input.goal}`,
    ``,
    `ACCEPTANCE CRITERIA:`,
    criteria,
    ``,
    `RECENT TURNS (tool calls + results only):`,
    turns,
    ``,
    `Classify the run's STATE — exactly one of:`,
    `  productive   — steady, varied progress toward the acceptance criteria`,
    `  converging   — slower, but still progressing (not stuck)`,
    `  spiraling    — repeating/reverting the same change with no net progress`,
    `  blocked      — stalled on an external dependency or unresolved error`,
    `  off_track    — working on something that will not satisfy the goal/criteria`,
    ``,
    `Then a RECOMMENDATION — exactly one of:`,
    `  continue | nudge | halt_and_diagnose | escalate`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit`,
    `exactly one of each of these lines, and nothing else on the line:`,
    `  JUDGE_STATE: <state>`,
    `  JUDGE_RECOMMENDATION: <recommendation>`,
    `  JUDGE_CONFIDENCE: <0.0-1.0>`,
    `and one or more lines:`,
    `  JUDGE_EVIDENCE: <one concrete observation drawn from the tool calls/results above>`,
  ].join("\n");
}

const VALID_STATES = new Set<JudgeState>(["productive", "converging", "spiraling", "blocked", "off_track"]);
const VALID_RECOMMENDATIONS = new Set<JudgeRecommendation>([
  "continue",
  "nudge",
  "halt_and_diagnose",
  "escalate",
]);

/**
 * FAIL-CLOSED default when the judge's output carries no parseable verdict
 * (a dead spawn, a malformed response, `error_max_turns`, …). Mirrors the
 * codebase's "never silently proceed" doctrine (review.ts: empty criteria
 * fails closed) — an unreadable judge is itself evidence the run needs a
 * human, not a reason to wave it through.
 */
const FAIL_CLOSED_VERDICT: JudgeVerdict = {
  state: "off_track",
  recommendation: "escalate",
  confidence: 1,
  evidence: ["judge output carried no parseable JUDGE_STATE/JUDGE_RECOMMENDATION verdict — failing closed"],
};

/**
 * Parse the fresh judge's `JUDGE_STATE`/`JUDGE_RECOMMENDATION`/
 * `JUDGE_CONFIDENCE`/`JUDGE_EVIDENCE` lines into a {@link JudgeVerdict}.
 * Missing or unrecognized state/recommendation fails closed
 * ({@link FAIL_CLOSED_VERDICT}); a missing/invalid confidence defaults to 0
 * (the conservative bias: never assume high confidence that was never
 * stated). Case-insensitive; tolerant of surrounding prose.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const stateMatch = text.match(/JUDGE_STATE:\s*(\w+)/i);
  const recMatch = text.match(/JUDGE_RECOMMENDATION:\s*(\w+)/i);
  const confMatch = text.match(/JUDGE_CONFIDENCE:\s*([\d.]+)/i);

  const state = stateMatch?.[1]?.toLowerCase() as JudgeState | undefined;
  const recommendation = recMatch?.[1]?.toLowerCase() as JudgeRecommendation | undefined;
  if (!state || !VALID_STATES.has(state) || !recommendation || !VALID_RECOMMENDATIONS.has(recommendation)) {
    return { ...FAIL_CLOSED_VERDICT, evidence: [...FAIL_CLOSED_VERDICT.evidence] };
  }

  let confidence = confMatch ? Number(confMatch[1]) : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const evidence = [...text.matchAll(/JUDGE_EVIDENCE:\s*(.+)/gi)].map((m) => m[1].trim());

  return { state, recommendation, confidence, evidence };
}

// ── The deterministic controller (Standing rule 12: judgment is advisory,
// supervision/action is deterministic) ─────────────────────────────────────

export interface FlightJudgeConfig {
  /** The judge is capped at this many invocations per run; the Kth call MUST decide. */
  maxInvocationsPerRun: number;
  /** `spiraling` at/above this confidence halts + dispatches diagnose. Default 0.7. */
  highConfidenceThreshold?: number;
}

const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.7;

/** Threaded across a run's Layer-2 invocations (mirrors classify.ts's RetryState). */
export interface FlightJudgeState {
  invocations: number;
  /** True once the `converging` threshold-raise has fired THIS run — it fires ONCE. */
  thresholdRaised: boolean;
}

export const INITIAL_FLIGHT_JUDGE_STATE: FlightJudgeState = { invocations: 0, thresholdRaised: false };

export type ControllerActionKind =
  | "continue"
  | "raise_threshold_and_continue"
  | "halt_and_diagnose"
  | "halt_and_escalate";

export interface ControllerAction {
  kind: ControllerActionKind;
  reason: string;
  state: FlightJudgeState;
}

const DEFERRING_KINDS = new Set<ControllerActionKind>(["continue", "raise_threshold_and_continue"]);

/** The action the verdict alone would produce, BEFORE the K-cap override below. */
function naturalAction(next: FlightJudgeState, verdict: JudgeVerdict, highConfidence: boolean): ControllerAction {
  if (verdict.state === "spiraling" && highConfidence) {
    return {
      kind: "halt_and_diagnose",
      reason: `spiraling at confidence ${verdict.confidence.toFixed(2)} (high-confidence threshold met) — halting for a DIAGNOSE worker, never a third blind patch`,
      state: next,
    };
  }
  if (verdict.state === "off_track") {
    return { kind: "halt_and_escalate", reason: "judge classified the run off_track", state: next };
  }
  if (verdict.state === "converging") {
    if (!next.thresholdRaised) {
      return {
        kind: "raise_threshold_and_continue",
        reason: "converging: slow but progressing — raising the tripped threshold once (slow ≠ stuck)",
        state: { ...next, thresholdRaised: true },
      };
    }
    return {
      kind: "continue",
      reason: "converging: the threshold was already raised once this run — continuing without raising it again",
      state: next,
    };
  }
  if (verdict.recommendation === "halt_and_diagnose") {
    return { kind: "halt_and_diagnose", reason: "judge recommended halt_and_diagnose", state: next };
  }
  if (verdict.recommendation === "escalate") {
    return { kind: "halt_and_escalate", reason: "judge recommended escalate", state: next };
  }
  return {
    kind: "continue",
    reason: `judge state=${verdict.state} recommendation=${verdict.recommendation} — continuing`,
    state: next,
  };
}

/**
 * The pure deterministic controller (acceptance: no LLM call inside this
 * function — it only maps an already-produced {@link JudgeVerdict} to an
 * action). Bumps `invocations` first, then computes the natural action; if
 * that natural action would DEFER (`continue` / `raise_threshold_and_continue`)
 * on the invocation that reaches the K-cap, it is forced to `halt_and_escalate`
 * instead — the Kth call must decide, never defer again (no infinite advisory
 * loop, design).
 */
export function planJudgeAction(
  state: FlightJudgeState,
  verdict: JudgeVerdict,
  config: FlightJudgeConfig,
): ControllerAction {
  const next: FlightJudgeState = { ...state, invocations: state.invocations + 1 };
  const isFinal = next.invocations >= config.maxInvocationsPerRun;
  const highConfidence = verdict.confidence >= (config.highConfidenceThreshold ?? DEFAULT_HIGH_CONFIDENCE_THRESHOLD);

  const natural = naturalAction(next, verdict, highConfidence);
  if (isFinal && DEFERRING_KINDS.has(natural.kind)) {
    return {
      kind: "halt_and_escalate",
      reason: `invocation ${next.invocations}/${config.maxInvocationsPerRun} reached the K-cap; the verdict (state=${verdict.state}, recommendation=${verdict.recommendation}) would defer (${natural.kind}) but the Kth call must decide — forcing halt_and_escalate`,
      state: next,
    };
  }
  return natural;
}

// ── The DI orchestrator: spawn the judge, then let the controller act ─────
// Mirrors classify.ts's runDiagnoseThenRetry: real callers wire `judge` to a
// fresh read-only spawn and `diagnose`/`escalate` to the existing primitives
// (classify.ts's diagnose dispatch, escalate.ts) — no real LLM call inside
// this module itself, so the whole orchestration is testable with fakes.

export interface FlightJudgeDeps {
  /** Spawn the fresh-context judge and return its verdict. Real callers wire this
   * to {@link spawnFlightJudgeWorker} + {@link parseJudgeVerdict}; tests inject a fake. */
  judge: (input: JudgeInput) => Promise<JudgeVerdict>;
  /** Dispatch an evidence-only DIAGNOSE worker (mirrors classify.ts's `diagnose` dep).
   * Called on `halt_and_diagnose` — NEVER on anything else; this module exposes no
   * "apply a patch" dependency at all, so a spiraling verdict cannot produce a third
   * blind edit. */
  diagnose: () => Promise<{ text: string }>;
  /** Open a `needs-human` escalation (mirrors escalate.ts). Called on `halt_and_escalate`. */
  escalate: (verdict: JudgeVerdict, action: ControllerAction) => Promise<string>;
  /** One ledger-shaped line per step; no-op default (real callers ledger it). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface FlightJudgeResult {
  verdict: JudgeVerdict;
  action: ControllerAction;
  state: FlightJudgeState;
  diagnosed: boolean;
  escalationUrl?: string;
}

/**
 * Run ONE Layer-2 invocation: spawn the fresh judge, then let the
 * deterministic controller act on its verdict. The judge itself never edits
 * code (see module doc); this orchestrator never calls a "patch" dependency
 * either — the only write-shaped effects it can trigger are `diagnose`
 * (evidence-only) and `escalate` (a GitHub issue).
 */
export async function runFlightJudge(
  input: JudgeInput,
  state: FlightJudgeState,
  config: FlightJudgeConfig,
  deps: FlightJudgeDeps,
): Promise<FlightJudgeResult> {
  const log = deps.log ?? (() => {});
  const verdict = await deps.judge(input);
  const action = planJudgeAction(state, verdict, config);

  log("flight_judge.verdict", {
    task_id: input.taskId,
    state: verdict.state,
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
    invocation: action.state.invocations,
  });
  log("flight_judge.action", { task_id: input.taskId, action: action.kind, reason: action.reason });

  if (action.kind === "halt_and_diagnose") {
    const report = await deps.diagnose();
    log("flight_judge.diagnose_dispatched", {
      task_id: input.taskId,
      findings_chars: report.text.length,
    });
    return { verdict, action, state: action.state, diagnosed: true };
  }
  if (action.kind === "halt_and_escalate") {
    const url = await deps.escalate(verdict, action);
    log("flight_judge.escalated", { task_id: input.taskId, issue_url: url });
    return { verdict, action, state: action.state, diagnosed: false, escalationUrl: url };
  }
  return { verdict, action, state: action.state, diagnosed: false };
}

// ── The real spawn (read-only BY CONSTRUCTION — no tools at all) ──────────

/**
 * The judge's SDK tool allowlist — EMPTY by construction. Everything it
 * needs to judge (the goal, criteria, and the distilled turn evidence) is
 * already baked into its prompt; it has no need to explore the live
 * worktree, and with zero tools it CANNOT edit code or merge even if asked
 * — the strongest form of "read-only" (a capability it lacks, not a rule it
 * is trusted to follow).
 */
export const JUDGE_TOOLS: string[] = [];

/** Build the {@link SpawnWorkerArgs} for a real flight-judge spawn — a pure
 * function so the "no write tool" guarantee is unit-testable without a spawn. */
export function buildFlightJudgeSpawnArgs(opts: {
  input: JudgeInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildJudgePrompt(opts.input),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: JUDGE_TOOLS,
  };
}

/** Spawn the real fresh-context judge. Untested by unit (it shells out via the
 * SDK, same as every other real spawn in worker.ts) — {@link buildFlightJudgeSpawnArgs}
 * carries the testable contract. */
export async function spawnFlightJudgeWorker(opts: {
  input: JudgeInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): Promise<WorkerResult> {
  return spawnWorker(buildFlightJudgeSpawnArgs(opts));
}
