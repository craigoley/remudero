/**
 * lib/ruling-judge.ts — W1-T3212: an agent may RECORD a ruling, behind a judge.
 *
 * WHAT THIS REPLACES, and what it deliberately keeps. `fb-1785882211812-bafd8f` said "an agent
 * may recommend a ruling and may never record a ruling". That blanket ban bought exactly one real
 * thing — an agent could not quietly install a decision nobody reviewed — and it cost a backlog:
 * MEASURED 2026-09-08 over plan/tasks.d + plan/tasks.yaml, 74 `verify: human` shards exist
 * {queued: 56, blocked: 6, merged: 10, done: 2}, and `isDispatchEligible` refuses every queued
 * one. The operator ruled on 2026-09-08 that the ban should become a REVIEWER, not a permission:
 * "An agent should absolutely be able to record a ruling. It should only escalate to human if an
 * llm as a judge determines it to be risky or bad. Then it should show up in the inbox."
 *
 * WHAT REPLACES THE BAN IS NOT PERMISSION — IT IS A REVIEWER. Nothing here lets an agent decide
 * that a ruling is correct. {@link judgeRulingRisk} asks only whether THIS ruling is safe for an
 * agent to land: reversible, inside its competence, evidenced, and not overturning a standing
 * record. When the answer is no, the operator's bit is what settles it.
 *
 * TWO INVARIANTS A REVIEWER WILL BE TEMPTED TO 'FIX', each stated where it is enforced: this
 * judge fails CLOSED where escalate.ts's fails open (see FAIL_CLOSED_RULING_VERDICT), and a
 * refused ruling reaches the operator through the inbox that already exists, never a second
 * ratification channel (see proposalFromRefusedRuling).
 */

import type { Proposal } from "./inbox.js";
import type { Mount, Mounts } from "./mounts.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/** What {@link judgeRulingRisk} decides for one authored ruling. There is no third value: a
 *  ruling is either safe for the agent to land or it is the operator's — "drop" is not
 *  expressible, so a judge can never make a ruling disappear. */
export type RulingJudgeDecision = "record" | "escalate";

/** The step {@link judgeRulingRisk}'s caller writes for EVERY judged ruling, BOTH arms.
 *  Establishing that the escalation judge had never run took three separate reads because no such
 *  row existed (W1-T3166); that is not repeated. Retained across rotation in
 *  DECISION_RELEVANT_LEDGER_STEPS (lib/ledger.ts), in this same change.
 *  READER: the operator, who should READ the first weeks of these rather than assume the judge
 *  calibrates well — no measurement here establishes that it does. */
export const RULING_JUDGED_STEP = "ruling.judged";

/** The judge's verdict. `reason` is ledgered verbatim on both arms and, on an escalation, becomes
 *  the proposal's own stated reason — so a refusal is never silent about why. */
export interface RulingJudgeVerdict {
  decision: RulingJudgeDecision;
  reason: string;
}

/**
 * One ruling an agent has authored and wants recorded. Every field except `supersedes` is
 * REQUIRED, and that is design clause (iv) expressed as a type: an entry a reader cannot
 * attribute, evidence or undo is worse than no entry, so there is no shape of this interface that
 * produces an unattributed or unrevertible record.
 */
export interface AgentRuling {
  taskId: string;
  runId: string;
  /** One line, the entry's header text. */
  title: string;
  /** The ruling itself, in the author's own words. */
  ruling: string;
  /** Provenance a reader can chase — file:line, a measurement, a PR. Never empty (see
   *  {@link rulingIsWellFormed}): an unevidenced ruling is refused before the judge is asked. */
  evidence: readonly string[];
  /** How to undo this, concretely. */
  rollback: string;
  /** Who authored it — the agent, named. */
  author: string;
  /** Standing records this ruling would overturn, if the author declares any. ANY entry here
   *  routes to the operator unconditionally ({@link contradictsStandingDecision}). */
  supersedes?: readonly string[];
}

/** FAIL-CLOSED default: a spawn error, a timeout, an unparseable verdict or a judge that is not
 *  wired at all all resolve to this. The OPPOSITE polarity from escalate.ts's
 *  `FAIL_OPEN_JUDGE_VERDICT`, because the costly direction here is landing a decision nobody
 *  reviewed. Copying the sibling's default is the single most damaging error available here. */
export const FAIL_CLOSED_RULING_VERDICT: RulingJudgeVerdict = {
  decision: "escalate",
  reason:
    "judge output carried no parseable RULING_JUDGE_DECISION — failing closed to escalate " +
    "(never land a governance decision nobody reviewed)",
};

const VALID_RULING_DECISIONS = new Set<RulingJudgeDecision>(["record", "escalate"]);

/** A ruling missing its attribution, evidence or rollback is refused BEFORE the judge is asked —
 *  that is a well-formedness question, not a risk one, and spending a spawn on it would let a
 *  generous judge wave through an entry no reader could chase. Returns the reason, or
 *  `undefined` when the ruling is well formed. */
export function rulingIsWellFormed(r: AgentRuling): string | undefined {
  if (!r.author.trim()) return "the ruling names no author — an entry a reader cannot attribute is worse than no entry";
  if (!r.title.trim()) return "the ruling has no title";
  if (!r.ruling.trim()) return "the ruling has no body";
  if (r.evidence.filter((e) => e.trim()).length === 0) return "the ruling cites no evidence";
  if (!r.rollback.trim()) return "the ruling states no rollback";
  return undefined;
}

/** Phrases that mean "this replaces something that already stands". Matched case-insensitively
 *  over the ruling's own text. Deliberately SMALL and literal: this list exists to catch an
 *  author who SAYS they are overturning a record, never to infer contradiction from topic
 *  overlap, which no text predicate can do honestly. */
export const REVERSAL_PHRASES: readonly string[] = [
  "supersedes",
  "overturns",
  "reverses",
  "rescinds",
  "replaces the ruling",
  "no longer applies",
];

/** Governance anchors a ruling can name: a feedback id, or a numbered rule/law. These are the
 *  identifiers DECISIONS.md's own records are cited by, so membership in the standing text is a
 *  real resolution rather than a string coincidence. */
export const STANDING_ANCHOR_RE = /\b(?:fb-\d+-[0-9a-f]+|(?:standing rule|rule|law)\s+\d+)\b/i;


/** Every governance anchor `text` cites, lowercased and de-duplicated. */
export function standingAnchorsCited(text: string): string[] {
  const seen = new Set<string>();
  // The global copy is built HERE rather than kept as a second module-level constant: a shared
  // global regex carries `lastIndex` across calls, and a second `_RE` symbol would need its own
  // negative fixture to satisfy negative-reachability-ratchet.test.ts while proving nothing the
  // exported one's fixture does not already prove. Two allocations per ruling is not a cost.
  for (const m of text.matchAll(new RegExp(STANDING_ANCHOR_RE.source, "gi"))) {
    seen.add(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  return [...seen];
}

/**
 * DESIGN CLAUSE (v): a ruling that would overturn a standing record is RISKY BY CONSTRUCTION and
 * goes to the operator regardless of what else the judge thinks. The reversal this very task
 * implements had to be the operator's own for exactly that reason.
 *
 * TWO ways to trip, and BOTH are conservative in the escalate direction:
 *   - `supersedes` is non-empty. The author has declared a reversal; that is the operator's call
 *     whether or not the named record resolves. An anchor naming something NOT in the standing
 *     text escalates too — the author believes they are overturning something and we cannot
 *     confirm what, which is strictly worse, never better.
 *   - the ruling's text uses a {@link REVERSAL_PHRASES} verb AND cites an anchor that actually
 *     appears in the standing record.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: fire on a mere citation. Nearly every good ruling cites a
 * standing rule it is consistent with; escalating those would make the judge decorative in the
 * other direction, which is the failure mode this shard's own falsifier warns about.
 *
 * Returns the reason to escalate, or `undefined`.
 */
export function contradictsStandingDecision(r: AgentRuling, standingDecisions: string): string | undefined {
  const declared = (r.supersedes ?? []).filter((s) => s.trim());
  if (declared.length > 0) {
    return `the ruling declares it supersedes ${declared.join(", ")} — overturning a standing record is the operator's call, never the judge's`;
  }
  const body = `${r.title}\n${r.ruling}`;
  const lower = body.toLowerCase();
  if (!REVERSAL_PHRASES.some((p) => lower.includes(p))) return undefined;
  const standing = standingDecisions.toLowerCase();
  const resolved = standingAnchorsCited(body).filter((a) => standing.includes(a));
  if (resolved.length === 0) return undefined;
  return `the ruling uses reversal language about ${resolved.join(", ")}, which stands in the decision record — overturning a standing record is the operator's call, never the judge's`;
}

/** Render the judge's prompt. Carries the asymmetry explicitly, in the opposite direction to
 *  escalate.ts's WHEN IN DOUBT, DELIVER: here, WHEN IN DOUBT, ESCALATE. */
export function buildRulingJudgePrompt(r: AgentRuling): string {
  const evidence = r.evidence.map((e, i) => `  ${i + 1}. ${e}`).join("\n") || "  (none)";
  return [
    `You are the RULING JUDGE (W1-T3212) — a ROUTING-ONLY judge deciding whether ONE ruling an`,
    `agent has already authored is SAFE FOR THAT AGENT TO RECORD, or whether it needs the`,
    `operator's own bit first.`,
    ``,
    `YOU ARE NOT ASKED WHETHER THE RULING IS RIGHT. That is what the operator's bit is for when`,
    `your answer is "escalate". You are asked only whether it is safe for an agent to land:`,
    `  - is it REVERSIBLE — does the stated rollback actually undo it?`,
    `  - is it INSIDE THE AGENT'S COMPETENCE — a judgement call on evidence it can see, not a`,
    `    question about the operator's own priorities, budget, risk appetite or intent?`,
    `  - is it EVIDENCED — does the cited provenance actually support the ruling?`,
    `  - is it NARROW — does it settle the question at hand rather than setting broad policy?`,
    ``,
    `THE ASYMMETRY THAT GOVERNS THIS DECISION, AND IT IS THE OPPOSITE OF THE ESCALATION JUDGE'S:`,
    `a FALSE NEGATIVE (recording a ruling that needed the operator) installs a governance decision`,
    `nobody reviewed, into a record later work will be built on — this is the COSTLY direction. A`,
    `FALSE POSITIVE (escalating one the agent could have made) costs the operator one skim of an`,
    `inbox item he can approve with one word. WHEN IN DOUBT, ESCALATE.`,
    ``,
    `A ruling that would overturn a standing decision never reaches you — it is routed to the`,
    `operator before you are asked. You will not see one.`,
    ``,
    `TASK: ${r.taskId}`,
    `AUTHOR: ${r.author}`,
    `TITLE: ${r.title}`,
    ``,
    `RULING:`,
    r.ruling,
    ``,
    `EVIDENCE CITED:`,
    evidence,
    ``,
    `STATED ROLLBACK: ${r.rollback}`,
    ``,
    `Decide — exactly one of:`,
    `  record    — safe for the agent to record itself`,
    `  escalate  — this needs the operator's bit; route it to his inbox`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit exactly one of each of`,
    `these lines, and nothing else on the line:`,
    `  RULING_JUDGE_DECISION: <record|escalate>`,
    `  RULING_JUDGE_REASON: <one concrete, specific reason — it is ledgered verbatim, and on an`,
    `    escalation it is what the operator reads first>`,
  ].join("\n");
}

/** Parse the judge's `RULING_JUDGE_DECISION`/`RULING_JUDGE_REASON` lines. A missing or
 *  unrecognised decision fails CLOSED ({@link FAIL_CLOSED_RULING_VERDICT} — `escalate`, never
 *  `record`). */
export function parseRulingJudgeVerdict(text: string): RulingJudgeVerdict {
  const decisionMatch = text.match(/RULING_JUDGE_DECISION:\s*(\w+)/i);
  const decision = decisionMatch?.[1]?.toLowerCase() as RulingJudgeDecision | undefined;
  if (!decision || !VALID_RULING_DECISIONS.has(decision)) {
    return { ...FAIL_CLOSED_RULING_VERDICT };
  }
  const reasonMatch = text.match(/RULING_JUDGE_REASON:\s*(.+)/i);
  const reason = reasonMatch?.[1]?.trim() || "(no reason stated)";
  return { decision, reason };
}

/** Injectable judge dependency — real callers wire this to {@link realRulingJudge}; tests inject
 *  a fake, exactly as escalate.ts's `EscalationJudgeDeps.judge` and risk-judge.ts's do.
 *  `standingDecisions` is the CURRENT decision record's text, read by the caller: this module
 *  does no file I/O, so the contradiction check is unit-testable without a repo. */
export interface RulingJudgeDeps {
  judge: (r: AgentRuling) => Promise<RulingJudgeVerdict>;
  standingDecisions: string;
}

/**
 * Decide record|escalate for ONE authored ruling.
 *
 * ORDER IS LOAD-BEARING and mirrors `judgeEscalation`'s exempt-first shape. Well-formedness, then
 * the standing-record check, run BEFORE `deps.judge` is ever called — so a judge stub that would
 * happily `record` an unevidenced ruling, or one overturning a standing decision, cannot
 * influence either outcome. A judge-unavailable error is caught HERE and fails CLOSED.
 */
export async function judgeRulingRisk(r: AgentRuling, deps: RulingJudgeDeps): Promise<RulingJudgeVerdict> {
  const malformed = rulingIsWellFormed(r);
  if (malformed) return { decision: "escalate", reason: malformed };
  const contradiction = contradictsStandingDecision(r, deps.standingDecisions);
  if (contradiction) return { decision: "escalate", reason: contradiction };
  try {
    return await deps.judge(r);
  } catch (err) {
    return {
      decision: "escalate",
      reason: `judge unavailable (${err instanceof Error ? err.message : String(err)}) — failing closed to escalate, never landing a governance decision nobody reviewed`,
    };
  }
}

// ── The recorded entry (design clause iv) ──────────────────────────────────────────────────────

/** `plan/decisions.d/<taskId>-<runId>-ruling.md` — one file per recorded ruling, so concurrent
 *  runs never collide on a path, and the `-ruling` suffix keeps an agent-authored governance
 *  entry distinguishable from an auto-choose decision record at the FILENAME, before a reader
 *  opens anything. */
export function rulingRecordRelPath(taskId: string, runId: string): string {
  return `plan/decisions.d/${taskId}-${runId}-ruling.md`;
}

/** The provenance line every agent-recorded ruling carries. DISTINCT from DECISIONS.md's existing
 *  "Operator-ruled" and "Chosen (RECOMMENDED, auto)" marks by design: a reader must be able to
 *  tell at a glance that an agent authored this and a judge passed it, never mistake it for the
 *  operator's own word.
 *  CAVEAT, and it is deliberate: this phrase is NOT in review.ts's
 *  `DECISIONS_PROVENANCE_MARKERS` closed vocabulary, so a diff appending one of these records
 *  directly to DECISIONS.md would be REFUSED by the W1-T352 provenance floor. Records land in
 *  `plan/decisions.d/`, which that floor does not watch, so the supported path is unaffected —
 *  and the refusal on the unsupported one is a failsafe worth keeping, not a defect to paper
 *  over here. */
export const AGENT_RULING_PROVENANCE = "Agent-ruled, judged";

/** Pure — the recorded entry's full body. Carries author, evidence and rollback unconditionally
 *  (design iv), plus the judge's own reason, so the record says not only what was decided but on
 *  whose authority and on what basis it was allowed to land. */
export function rulingRecordContent(r: AgentRuling, verdict: RulingJudgeVerdict, ts: string): string {
  const evidence = r.evidence.filter((e) => e.trim()).map((e) => `  - ${e}`).join("\n");
  return (
    `## ${ts} — RULING: ${r.title} (${r.taskId})\n` +
    `- ${AGENT_RULING_PROVENANCE}: authored by ${r.author}, recorded under W1-T3212's judged path.\n` +
    `- Ruling: ${r.ruling}\n` +
    `- Evidence:\n${evidence}\n` +
    `- Judge: ${verdict.decision} — ${verdict.reason}\n` +
    `- Rollback: ${r.rollback}\n`
  );
}

// ── The escape hatch: a refused ruling becomes an ordinary inbox proposal (design clause iii) ──

/** Derived from the task and run, so the same refused ruling staged twice is the same proposal
 *  rather than two, and the operator is never asked the same question in duplicate. */
export function refusedRulingProposalId(r: AgentRuling): string {
  return `ruling:${r.taskId}-${r.runId}`;
}

/**
 * Turn a REFUSED ruling into a {@link Proposal} the operator ratifies with `rmd approve` — the
 * same gated, ledgered, one-bit path proposals already take (design iii: no second channel).
 * `evidenceAnchors` is EMPTY on purpose: the anchors that tier a proposal READY ask "has the
 * thing this proposal depends on landed on main", and a ruling depends on nothing having landed;
 * its evidence is prose the operator reads, carried in the summary where he will actually see it.
 */
export function proposalFromRefusedRuling(r: AgentRuling, verdict: RulingJudgeVerdict): Proposal {
  const evidence = r.evidence.filter((e) => e.trim()).map((e) => `  - ${e}`).join("\n");
  return {
    id: refusedRulingProposalId(r),
    summary:
      `Record this ruling? ${r.title}\n\n` +
      `Authored by ${r.author} for ${r.taskId}, and routed here rather than recorded because:\n` +
      `  ${verdict.reason}\n\n` +
      `RULING:\n${r.ruling}\n\n` +
      `EVIDENCE:\n${evidence}\n\n` +
      `ROLLBACK: ${r.rollback}\n\n` +
      `Approving this records the ruling as written, attributed to its agent author, in ` +
      `plan/decisions.d/. Nothing is recorded until you do.`,
    evidenceAnchors: [],
  };
}

// ── The real spawn (read-only BY CONSTRUCTION — no tools at all, mirrors escalate.ts) ──────────

/** The judge's SDK tool allowlist — EMPTY by construction, like escalate.ts's and
 *  risk-judge.ts's: everything it needs is baked into the prompt, so it has no ability to explore
 *  the worktree or take any action. A judge that could read the repo could also be argued into
 *  editing it. */
export const RULING_JUDGE_TOOLS: string[] = [];

/** Build the {@link SpawnWorkerArgs} for a real ruling-judge spawn — a pure function, so the
 *  "no tools, cheapest mount" contract is unit-testable without a spawn. */
export function buildRulingJudgeSpawnArgs(opts: {
  ruling: AgentRuling;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildRulingJudgePrompt(opts.ruling),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: RULING_JUDGE_TOOLS,
  };
}

/** Spawn the real judge and parse its verdict. Untested by unit (it shells out via the SDK);
 *  {@link buildRulingJudgeSpawnArgs} and {@link parseRulingJudgeVerdict} carry the contract. */
export async function spawnRulingJudgeWorker(opts: {
  ruling: AgentRuling;
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): Promise<WorkerResult> {
  const spawn = opts.spawn ?? spawnWorker;
  return spawn(buildRulingJudgeSpawnArgs(opts));
}

/** Build a `judge` wired to a real spawn on the CHEAPEST configured mount — one cheap-mount call
 *  per authored ruling. Reuses `resolveRiskJudgeMount` rather than re-deriving the same
 *  routing-table walk: that resolver is generic, never risk-specific, despite its name. */
export function realRulingJudge(opts: {
  mounts: Mounts;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (r: AgentRuling) => Promise<RulingJudgeVerdict> {
  const mount = resolveRiskJudgeMount(opts.mounts);
  return async (r: AgentRuling) => {
    const result = await spawnRulingJudgeWorker({
      ruling: r,
      mount,
      cwd: opts.cwd,
      settingsFile: opts.settingsFile,
      spawn: opts.spawn,
    });
    return parseRulingJudgeVerdict(result.text);
  };
}
