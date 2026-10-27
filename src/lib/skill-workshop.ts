/**
 * lib/skill-workshop.ts — W1-T2766. THE SECOND HALF OF THE FLYWHEEL.
 *
 * `mineProceduralCandidates` (retro.ts, W1-T87/P13) already turns a procedure two or more merged
 * runs share into a FACT LINE — recalled, never executed. W1-T971 measured workers spontaneously
 * invoking BUNDLED Claude Code skills, so the runtime's own skill mechanism is live in this fleet;
 * the repository just never authored one of its own. This module drafts a SKILL.md from the same
 * candidate, scans it against the worker's allowlist, and stages it as one inbox proposal — Rule
 * 15 still means the operator ratifies the write; nothing here writes under `.claude/skills/`.
 *
 * `ProceduralCandidateLike` duplicates retro.ts's `ProceduralCandidate` STRUCTURALLY rather than
 * importing it, mirroring inbox.ts's own `BoardReferentState` — retro.ts imports THIS module to
 * render a draft beside its mined candidates, so importing the type the other way would close a
 * cycle. TypeScript's structural typing means a real `ProceduralCandidate` satisfies this shape
 * with zero conversion at the one call site that matters (retro.ts's `buildGather`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { slug as kebabSlug } from "./feedback-docket.js";
import { systemClock, type Clock } from "./clock.js";
import { SKILL_DRAFT_ID_PREFIX, updateProposalRegistry, type Proposal, type SkillLifecycleAction, type UpdateProposalRegistryOpts } from "./inbox.js";
import { TASK_TYPES, type Task } from "./plan.js";
import { WORKER_PROVIDER_IDS } from "./config-schema.js";
import { isMergedLedgerRow, PR_TERMINAL_STEP, prUrlKey } from "./ledger-carry.js";
import {
  mineTranscriptWorkflows,
  renderTranscriptWorkflowSteps,
  type TranscriptLedgerRow,
  type TranscriptRun,
} from "./workflow-mining.js";

/** The fields {@link renderSkillDraft} reads off a mined procedural candidate — see this module's
 *  header for why this duplicates retro.ts's `ProceduralCandidate` rather than importing it. */
export interface ProceduralCandidateLike {
  shapeKey: string;
  taskType: string;
  signals: string[];
  runIds: string[];
  taskIds: string[];
  supportingRuns: number;
  /** Outcome descriptions for caller-supplied signals, keyed by signal. */
  outcomeDescriptions?: Readonly<Record<string, string>>;
}

/** Each signal's rendered instruction and the outcome it measures. Adding a signal's row also
 *  gives the scanner its comparison vocabulary; no signal-key classification is needed. */
const PROCEDURAL_STEPS: Readonly<Record<string, { text: string; description: string }>> = {
  clean_single_strike: {
    text: "Resolve the task on the first attempt — land a fix that needs no `fix.dispatch` rung.",
    description: "The task resolves on the first attempt: a landed fix needs no fix.dispatch rung.",
  },
  fully_executed_proof: {
    text: "Execute every acceptance criterion as a real, observed proof — never let the keyword floor stand in for a run.",
    description: "Every acceptance criterion has an observed executed proof, without keyword-floor degradation.",
  },
};

/** Canonical rendered text, kept as strings for existing callers. {@link renderSkillDraft} never
 *  drafts an unmapped signal (W1-T4270's {@link skillEligibleSignal}); a draft built elsewhere that
 *  carries a raw key as its step is still refused by the scanner, which compares it to that key. */
export const PROCEDURAL_STEP_TEXT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROCEDURAL_STEPS).map(([key, step]) => [key, step.text]),
);

/** Task classes the plan schema can assign to a mined procedural candidate. Keeping this as a
 *  total record over {@link Task.type} makes a future task class a compile-time decision here,
 *  while an unrecognised runtime value remains unselectable rather than defaulting to implement. */
const INJECTABLE_SKILL_TASK_TYPES = {
  recon: true,
  implement: true,
  diagnose: true,
  review: true,
  manual: true,
} as const satisfies Readonly<Record<Task["type"], true>>;

function injectableSkillTaskType(taskType: string): Task["type"] | undefined {
  return Object.hasOwn(INJECTABLE_SKILL_TASK_TYPES, taskType) ? taskType as Task["type"] : undefined;
}

const SKILL_ELIGIBLE_SIGNALS: Readonly<Record<string, boolean>> = {
  clean_single_strike: false,
  fully_executed_proof: true,
};

function skillEligibleSignal(key: string): boolean {
  return Object.hasOwn(SKILL_ELIGIBLE_SIGNALS, key) && SKILL_ELIGIBLE_SIGNALS[key];
}

/** One drafted skill: the rendered SKILL.md text plus the fields a scanner/stager needs without
 *  re-parsing markdown. `candidateHash` is the dedup key {@link stageSkillDraft} keys off. */
export interface SkillDraft {
  name: string;
  description: string;
  markdown: string;
  candidateHash: string;
  /** W1-T3385c — THE PROCEDURE'S OWN IDENTITY, stable as its evidence grows. {@link
   *  candidateHash} deliberately hashes the RUN SET, so every cadence pass that mines the same
   *  procedure with one more supporting run produces a different hash and a different proposal. */
  procedureKey: string;
  /** How many merged runs backed this draft when it was rendered — carried so a stager can tell a
   *  better-evidenced draft of the SAME procedure from a weaker one. */
  supportingRuns: number;
  /** The mined outcomes, separate from the generated shape/provenance summary above. Older or
   *  hand-authored drafts can instead supply their outcome as `description`. */
  outcomeDescriptions?: readonly string[];
}

/** Deterministic id for a candidate's draft, over its shape AND its run set — two candidates that
 *  share a shapeKey but differ in supporting runs must never collide (W1-T470 dedup discipline,
 *  the same "hash the row, not the label" rule {@link import("./inbox.js").bundlePolicyProposalId}
 *  already ships). */
export function proceduralCandidateHash(candidate: ProceduralCandidateLike): string {
  return createHash("sha256")
    .update(`${candidate.shapeKey}|${[...candidate.runIds].sort().join(",")}`)
    .digest("hex")
    .slice(0, 16);
}

/** The transcript corpus {@link renderSkillDraft} mines a distinguishing workflow from (W1-T4668,
 *  design clause ii) — optional so the existing call site (retro.ts's `buildGather`, unchanged by
 *  this task) keeps drafting off signals alone until a future caller wires the ledger through. */
export interface TranscriptContext {
  runs: readonly TranscriptRun[];
  records: readonly TranscriptLedgerRow[];
}

/**
 * Render one procedural candidate as a Claude Code skill draft (design clause i). `undefined` for
 * a candidate with no eligible signal or under the two-run floor. Mining already enforces this
 * threshold, but a caller handing this function a single-run candidate
 * directly (a test, or a future caller that skips mining) must get NOTHING rather than an
 * anecdote dressed as a proven procedure.
 *
 * `transcripts`, when supplied, mines the SAME candidate's task type for a {@link
 * TranscriptWorkflow} (workflow-mining.ts, W1-T4668) and appends its distinguishing steps —
 * actual tool-call steps every first-attempt-success run of this shape took that no repaired run
 * ever needed — after the signal-derived steps, so the Procedure section stops restating the
 * outcome ("resolve on the first attempt") and starts naming what a successful worker actually
 * DID. A shape with no transcript workflow (none mined, or none matching this candidate's task
 * type) leaves the Procedure section exactly as before.
 */
export function renderSkillDraft(candidate: ProceduralCandidateLike, transcripts?: TranscriptContext): SkillDraft | undefined {
  if (candidate.supportingRuns < 2) return undefined;
  const eligibleSignals = candidate.signals.filter(skillEligibleSignal);
  if (eligibleSignals.length === 0) return undefined;
  const hash = proceduralCandidateHash(candidate);
  const procedureKey = procedureKeyFor(candidate);
  // The NAME follows the procedure too, so the written .claude/skills/<name>/ path is stable as
  // evidence accrues rather than minting a new directory per cadence pass.
  const name = `${kebabSlug(candidate.shapeKey)}-${procedureKey.slice(0, 8)}`;
  const description = `A procedure shape proven across ${candidate.supportingRuns} merged ${candidate.taskType} run(s): ${candidate.signals.join(" + ")}.`;
  const appliesTo = injectableSkillTaskType(candidate.taskType);
  const outcomeFor = (key: string): string =>
    candidate.outcomeDescriptions?.[key] ?? PROCEDURAL_STEPS[key]?.description ?? key;
  // Every mined outcome reaches the scanner's vocabulary, eligible or not (W1-T4283).
  const outcomeDescriptions = candidate.signals.map(outcomeFor);
  const workflow = transcripts
    ? mineTranscriptWorkflows(transcripts.runs, transcripts.records).find((w) => w.taskType === candidate.taskType)
    : undefined;
  const workflowSteps = workflow ? renderTranscriptWorkflowSteps(workflow) : [];
  // Once transcript-mined steps name what a worker DID, a signal step that only restates its own
  // mined outcome (W1-T4283) is dropped rather than left to make the scanner refuse the whole
  // draft; with no mined steps it stays, so the scanner still refuses an outcome-only procedure.
  // Only skill-eligible signals render a step (W1-T4270): an outcome label is never a procedure.
  const steps = eligibleSignals
    .map((key) => ({ line: `- ${PROCEDURAL_STEP_TEXT[key] ?? key}`, outcome: outcomeFor(key) }))
    .filter(({ line, outcome }) => workflowSteps.length === 0 || !restatesOutcome(line, outcome))
    .map(({ line }) => line);
  const evidence = [
    ...candidate.runIds.map((runId) => `- [src: run#${runId}]`),
    `- Filed under: ${candidate.taskIds.join(", ")}`,
    ...(workflow ? workflow.runIds.map((runId) => `- [src: transcript#${runId}]`) : []),
  ];
  const markdown = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(appliesTo ? [`applies-to: ${appliesTo}`] : []),
    "---",
    "",
    "<!-- DRAFTED by skill-workshop.ts (W1-T2766) from a mined procedural candidate — a Rule 15",
    "     plan write the Architect proposes and the operator ratifies, not yet ratified. -->",
    "",
    "## Procedure",
    "",
    ...steps,
    ...workflowSteps,
    "",
    "## Evidence",
    "",
    ...evidence,
  ].join("\n");
  return { name, description, markdown, candidateHash: hash, procedureKey, supportingRuns: candidate.supportingRuns, outcomeDescriptions };
}

/** Render the drafted skills (markdown) beside `renderProceduralCandidates`'s own output — the
 *  retro's gather splices this in immediately after it (design clause i). */
export function renderSkillDrafts(drafts: SkillDraft[]): string {
  if (drafts.length === 0) {
    return "## Skill drafts (workshop, W1-T2766)\n\nNo procedural candidate cleared the two-run floor into a drafted SKILL.md this cycle.";
  }
  return [
    "## Skill drafts (workshop, W1-T2766) — a SKILL.md drafted beside each candidate above",
    "",
    ...drafts.map((d) => `- ${d.name} — ${d.description}`),
  ].join("\n");
}

// ── The scanner (design clause ii) ──────────────────────────────────────────────────────────

/** The worker allowlist a draft is scanned against — reduced from `settings/worker.json`'s own
 *  shape by {@link workerAllowlistFromSettings}, never re-derived ad hoc per caller. */
export interface WorkerAllowlist {
  allowedHosts: string[];
  deniedPathPatterns: string[];
  allowedTools: string[];
  contextRefusal?: string;
  capabilityContext?: { generation: string; consumers: ReadonlyArray<{ lane: string; provider: string; source: string }> };
}

/** Unwraps a `permissions.deny` entry's `Read(<path>)` shape into `<path>`; `null` for anything
 *  else, e.g. a `Bash(...)`/`Write(...)` entry or a bare path with no wrapper at all — exported so
 *  a test drives both arms directly (negative-reachability-ratchet.test.ts's fixture-less bar). */
export const READ_WRAPPER_RE = /^Read\((.*)\)$/;

/** Reduce a parsed `settings/worker.json` (or an equivalent test fixture) to the three lists a
 *  scan needs: `sandbox.network.allowedDomains` for hosts, `sandbox.filesystem.denyRead` (falling
 *  back to unwrapped `permissions.deny` `Read(...)` entries) for paths, and `permissions.allow`
 *  for tools. Today's committed file ships an EMPTY `permissions.allow` — so, deliberately, any
 *  draft naming a tool explicitly fails closed until the operator populates it (W1-T2698 is the
 *  task that is meant to give this list real contents; this reads whatever it finds today). */
export function workerAllowlistFromSettings(settings: unknown): WorkerAllowlist {
  const s = (settings ?? {}) as Record<string, any>;
  const denyRead: string[] = s.sandbox?.filesystem?.denyRead ?? [];
  const denyPermissions: string[] = (s.permissions?.deny ?? [])
    .map((entry: string) => entry.match(READ_WRAPPER_RE)?.[1])
    .filter((p: string | undefined): p is string => p !== undefined);
  return {
    allowedHosts: s.sandbox?.network?.allowedDomains ?? [],
    deniedPathPatterns: denyRead.length > 0 ? denyRead : denyPermissions,
    allowedTools: s.permissions?.allow ?? [],
  };
}

/** A reporting-only view of existing bounds; no consumer may use this as a runtime grant. */
export interface SkillWorkerCapabilityContext {
  generation: string;
  currentGeneration: string;
  consumers: ReadonlyArray<{ lane: string; provider: string; source: string; tools: readonly string[] }>;
}

/** Resolve availability from the execution contract, never from auto-approval rules. */
export function workerAllowlistFromCapabilityContext(settings: unknown, context: SkillWorkerCapabilityContext | undefined): WorkerAllowlist {
  const unknown = (reason: string): WorkerAllowlist => ({ allowedHosts: [], deniedPathPatterns: [], allowedTools: [], contextRefusal: `worker-capability-context:${reason}` });
  if (!context || typeof context !== "object") return unknown("missing");
  if (typeof context.generation !== "string" || context.generation.length === 0 || context.generation !== context.currentGeneration) return unknown("stale-or-unknown-generation");
  if (!Array.isArray(context.consumers) || context.consumers.length === 0) return unknown("no-consumers");
  const identities = new Set<string>();
  for (const consumer of context.consumers) {
    if (!consumer || typeof consumer.lane !== "string" || !(TASK_TYPES as readonly string[]).includes(consumer.lane) && consumer.lane !== SKILL_FIX_TASK_TYPE
      || typeof consumer.provider !== "string" || !(WORKER_PROVIDER_IDS as readonly string[]).includes(consumer.provider)
      || typeof consumer.source !== "string" || consumer.source.length === 0
      || !Array.isArray(consumer.tools) || !consumer.tools.every((tool: unknown) => typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(tool))) return unknown("malformed-or-unbounded-consumer");
    const identity = `${consumer.lane}/${consumer.provider}`;
    if (identities.has(identity)) return unknown("ambiguous-consumer");
    identities.add(identity);
  }
  const s = settings as { permissions?: { allow?: unknown; deny?: unknown }; sandbox?: { network?: { allowedDomains?: unknown }; filesystem?: { denyRead?: unknown } } } | null;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
  const allow = s?.permissions?.allow, deny = s?.permissions?.deny, hosts = s?.sandbox?.network?.allowedDomains, denyRead = s?.sandbox?.filesystem?.denyRead;
  if (!strings(allow) || !strings(deny) || !strings(hosts) || !strings(denyRead)) return unknown("settings-unavailable-or-malformed");
  const tools = context.consumers[0]!.tools.filter((tool: string) => context.consumers.every(c => c.tools.includes(tool))
    && !deny.includes(tool) && !deny.includes("*"));
  const paths = [...denyRead, ...deny.flatMap(entry => entry.match(READ_WRAPPER_RE)?.[1] ?? [])];
  return { allowedHosts: [...hosts], deniedPathPatterns: [...new Set(paths)], allowedTools: [...tools],
    capabilityContext: { generation: context.generation, consumers: context.consumers.map(c => ({ lane: c.lane, provider: c.provider, source: c.source })) } };
}

/** The injection domain includes fix, which is not a plan TASK_TYPES member. */
export function skillDraftConsumerLanes(draft: SkillDraft): string[] {
  const match = SKILL_APPLIES_TO_RE.exec(splitFrontmatter(draft.markdown).front);
  return match ? [...new Set(match[1].split(",").map(lane => lane.trim().toLowerCase()).filter(Boolean))] : [];
}

/** Turn one `settings/worker.json`-shaped glob (`~/../../.ssh/**`) into a `RegExp` matched as a
 *  SUBSTRING test against a draft line — `**` widens to "anything", a single `*` stays within one
 *  path segment, everything else is escaped literally. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++; // consumed both stars of "**"
      } else {
        out += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(out);
}

const KNOWN_TOOL_NAMES = ["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"] as const;

/** Phrasings the untrusted envelope (W1-T2700) would fence as an instruction aimed at the reader
 *  rather than data describing a procedure — a small, curated set of classic injection shapes,
 *  deliberately narrower than "any imperative sentence" (a SKILL.md's whole body is imperative). */
const INSTRUCTION_INJECTION_PATTERNS: RegExp[] = [
  /ignore\b[\s\S]{0,30}\b(all|any|previous|prior)[\s\S]{0,20}\binstructions?\b/i,
  /disregard\b[\s\S]{0,30}\b(system|previous|prior)[\s\S]{0,10}\b(prompt|instructions?)\b/i,
  /you are now (in|a|an)/i,
  /reveal (your|the) (system prompt|instructions)/i,
  /pretend (you|to) (are|be)/i,
  /do not (tell|inform|mention) (the|your) (operator|user)/i,
];

/** One scan's verdict: `ok`, or refused with the offending line named (design clause ii — "never
 *  staged" without one). */
export interface SkillDraftScanResult {
  ok: boolean;
  offendingLine?: string;
  reason?: string;
}

const STEP_FILLER_WORDS = new Set("a an the and or are as at be been being by for from has have had in is it of on that to was were with".split(" "));

/** A lexical check, not a semantic judgement: case, punctuation, filler and common inflections
 *  cannot supply the distinct content a step must add to its own mined outcome. */
function stepContentTokens(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !STEP_FILLER_WORDS.has(word))
    .map((word) => word.replace(/(?:ing|ed|s)$/, "").replace(/e$/, "").replace(/([b-df-hj-np-tv-z])\1$/, "$1"));
}

/** Whether every content token of a step line already appears in one mined outcome description. */
function restatesOutcome(line: string, description: string): boolean {
  const outcome = new Set(stepContentTokens(description));
  return stepContentTokens(line).every((token) => outcome.has(token));
}

/**
 * Refuse a draft that names a host, path or tool outside `allowlist`, or a line the untrusted
 * envelope would fence, or a Procedure step that only restates a mined outcome. Scans
 * `draft.markdown` line by line and returns on the FIRST offence, named.
 */
export function scanSkillDraft(draft: SkillDraft, allowlist: WorkerAllowlist): SkillDraftScanResult {
  if (allowlist.contextRefusal) return { ok: false, offendingLine: "<worker-capability-context>", reason: allowlist.contextRefusal };
  const deniedPatterns = allowlist.deniedPathPatterns.map(globToRegExp);
  const descriptions = draft.outcomeDescriptions?.length ? draft.outcomeDescriptions : [draft.description];
  const outcomeTokens = descriptions.map((description) => new Set(stepContentTokens(description)));
  let inProcedure = false;
  for (const line of draft.markdown.split("\n")) {
    if (line.startsWith("## ")) inProcedure = line === "## Procedure";
    const hostMatch = line.match(/https?:\/\/([a-zA-Z0-9.-]+)/);
    if (hostMatch && !allowlist.allowedHosts.includes(hostMatch[1])) {
      return { ok: false, offendingLine: line, reason: `names host '${hostMatch[1]}' outside the worker allowlist` };
    }
    for (const pattern of deniedPatterns) {
      if (pattern.test(line)) {
        return { ok: false, offendingLine: line, reason: `names a path the worker's deny-floor already refuses ('${pattern.source}')` };
      }
    }
    const toolNames = allowlist.capabilityContext ? [...KNOWN_TOOL_NAMES, "Grep", "Glob", "RunCheck"] : KNOWN_TOOL_NAMES;
    const toolMatches = line.matchAll(new RegExp(`\\b(${toolNames.join("|")})\\b`, "g"));
    for (const toolMatch of toolMatches) {
      if (!allowlist.allowedTools.some(t => t === toolMatch[1] || (!allowlist.capabilityContext && t.startsWith(`${toolMatch[1]}(`)))) {
        return { ok: false, offendingLine: line, reason: `names tool '${toolMatch[1]}' outside the worker allowlist` };
      }
    }
    for (const pattern of INSTRUCTION_INJECTION_PATTERNS) {
      if (pattern.test(line)) {
        return {
          ok: false,
          offendingLine: line,
          reason: "reads as an instruction aimed at the runtime — the untrusted envelope (W1-T2700) would fence a line shaped like this",
        };
      }
    }
    if (inProcedure && line.startsWith("- ")) {
      const tokens = stepContentTokens(line);
      if (outcomeTokens.some((outcome) => tokens.every((token) => outcome.has(token)))) {
        return { ok: false, offendingLine: line, reason: "outcome-only: step restates its mined outcome without adding behavioral content" };
      }
    }
  }
  return { ok: true };
}

// ── The loading path, measured not assumed (design clause iv) ──────────────────────────────

/**
 * Whether a repo-owned `.claude/skills/<name>/SKILL.md` is visible to a worker spawned with
 * `settingSources`, per the installed SDK's own docs: `settingSources` gates which filesystem
 * settings load, and project-scoped resources (the doc names CLAUDE.md by example) require
 * `'project'` to be present. `spawnWorker` (worker.ts) passes `WORKER_SETTING_SOURCES`, exported
 * so a caller measures the REAL value a spawn uses rather than asserting one independently of it.
 */
export function describeWorkerSkillReachability(settingSources: readonly string[]): { reachable: boolean; reason: string } {
  if (settingSources.includes("project")) {
    return {
      reachable: true,
      reason: "settingSources includes 'project', so a repo-owned .claude/skills/<name>/SKILL.md is discoverable by the runtime",
    };
  }
  return {
    reachable: false,
    reason:
      "settingSources excludes 'project' (spawnWorker passes WORKER_SETTING_SOURCES), and the installed SDK ties " +
      "project-scoped filesystem resources to that source, so a repo-owned .claude/skills/<name>/SKILL.md is not " +
      "discoverable by a worker today",
  };
}

// ── The lane (design clause iii) ────────────────────────────────────────────────────────────

/** W1-T3385c — the PROCEDURE's identity: its shape and the task type it applies to, and NOT its
 *  run set. Hashed so the id stays the same shape as before. */
export function procedureKeyFor(candidate: Pick<ProceduralCandidateLike, "shapeKey" | "taskType">): string {
  return createHash("sha256").update(`${candidate.taskType}|${candidate.shapeKey}`).digest("hex").slice(0, 16);
}

/**
 * Deterministic proposal id for a drafted skill, keyed on the PROCEDURE (W1-T3385c) rather than on
 * {@link SkillDraft.candidateHash}.
 *
 * The hash keyed the run SET, which is correct for "two candidates sharing a shapeKey must not
 * collide" — but a procedure's run set GROWS, so every cadence pass minted another proposal for the
 * same procedure. MEASURED 2026-09-11: all SEVEN open skill-draft proposals staged the same mined
 * procedure, `implement-clean-single-strike`, at 26/27/78/79/81/82/84 runs — two real procedures
 * wearing seven operator decisions.
 */
export function skillDraftProposalId(procedureKey: string): string {
  return `${SKILL_DRAFT_ID_PREFIX}${procedureKey}`;
}

/** The operator-facing text of a staged skill draft: the SKILL.md, whether a worker can reach it, and what approval writes. */
function skillDraftSummary(draft: SkillDraft, reachability: { reachable: boolean; reason: string }): string {
  const reachabilityLine = reachability.reachable
    ? `Reachable: ${reachability.reason}`
    : `NOT reachable by a worker today: ${reachability.reason}`;
  return (
    `${draft.markdown}\n\n---\n\n${reachabilityLine}\n\n` +
    `Approving this proposal drafts a plan PR that writes '.claude/skills/${draft.name}/SKILL.md' — ` +
    `nothing writes under .claude/skills/ outside that PR.`
  );
}

/** One {@link stageSkillDraft} call's outcome. `refused` means the scanner rejected the draft and
 *  nothing was staged; `alreadyStaged` means a prior call already staged this exact candidate. */
export interface StageSkillDraftResult {
  refused: boolean;
  staged: boolean;
  alreadyStaged: boolean;
  /** An entry staged before W1-T4338 had no skill file; this call added it (and refreshed its summary). */
  backfilled?: boolean;
  /** The staged entry's Procedure named fewer behavioral steps, so this call replaced it. */
  refreshed?: boolean;
  /** An unstamped legacy payload differed from the newly scanned draft and was replaced before stamping. */
  legacyReplaced?: boolean;
  /** The entry already carried its file but no staged-at stamp; this call stamped it and changed nothing else. */
  stamped?: boolean;
  reason?: string;
}

/** A `skillFileStagedAt` stamp as epoch ms, or null: an absent or unparseable stamp is no stamp at all. */
export function skillFileStagedAtMs(value: string | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

/** Procedure steps, excluding restatements of the supplied mined outcomes. */
function skillProcedureSteps(markdown: string, descriptions: readonly string[]): string[] {
  const section = /^## Procedure\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  return section.split("\n").filter((line) =>
    line.startsWith("- ") && !descriptions.some((description) => restatesOutcome(line, description)),
  );
}

/**
 * Scan `draft`, and — only when it passes — stage it as ONE inbox proposal carrying the SKILL.md
 * text, its evidence, and `reachability`'s verdict on whether a worker can load it today. Never
 * writes under `.claude/skills/`: that write happens only once `rmd approve` ratifies the staged
 * proposal into a plan PR (design clause iii). Idempotent by `draft.candidateHash` — a re-run
 * staging the same candidate is reported `alreadyStaged`, never duplicated (W1-T470).
 *
 * THE HELD-OUT STAMP. Every write of `skillFile` (a new stage, a refresh, a backfill) sets
 * `skillFileStagedAt` to `clock`'s now, and an entry carrying a file but no stamp is stamped. The
 * drafter mines EVERY merged run in the retro window, not only the runs it cites, so no list of task
 * ids can say what it saw; time can. `rmd skill-eval` holds out only tasks merged after this stamp.
 * Stamping late is conservative: a later stamp excludes a superset of tasks.
 */
export function stageSkillDraft(
  registryPath: string,
  draft: SkillDraft,
  allowlist: WorkerAllowlist,
  reachability: { reachable: boolean; reason: string },
  opts: UpdateProposalRegistryOpts = {},
  clock: Pick<Clock, "iso"> = systemClock,
): StageSkillDraftResult {
  const scan = scanSkillDraft(draft, allowlist);
  if (!scan.ok) {
    return { refused: true, staged: false, alreadyStaged: false, reason: `${scan.reason} (offending line: "${scan.offendingLine}")` };
  }
  const id = skillDraftProposalId(draft.procedureKey);
  let staged = false;
  let alreadyStaged = false;
  let backfilled = false;
  let refreshed = false;
  let legacyReplaced = false;
  let stamped = false;
  updateProposalRegistry(
    registryPath,
    (current) => {
      staged = false;
      alreadyStaged = false;
      backfilled = false;
      refreshed = false;
      legacyReplaced = false;
      stamped = false;
      const existing = current.findIndex((p) => p.id === id);
      const skillFile = { name: draft.name, markdown: draft.markdown };
      const skillFileStagedAt = clock.iso();
      if (existing >= 0) {
        alreadyStaged = true;
        const stored = current[existing].skillFile;
        // The id is the PROCEDURE, so a draft whose Procedure grew (the transcript-mined steps of
        // W1-T4668) must replace the stored text, or approval writes the older, emptier skill.
        // Compare behavioral steps: removed outcome-only bullets do not count as lost procedure.
        const descriptions = draft.outcomeDescriptions?.length ? draft.outcomeDescriptions : [draft.description];
        legacyReplaced = stored !== undefined && skillFileStagedAtMs(current[existing].skillFileStagedAt) === null &&
          (stored.name !== skillFile.name || stored.markdown !== skillFile.markdown);
        if (stored && (legacyReplaced || skillProcedureSteps(draft.markdown, descriptions).length > skillProcedureSteps(stored.markdown, descriptions).length)) {
          refreshed = true;
          return current.map((p, i) => (i === existing ? { ...p, summary: skillDraftSummary(draft, reachability), skillFile, skillFileStagedAt } : p));
        }
        if (stored && skillFileStagedAtMs(current[existing].skillFileStagedAt) !== null) return null; // already staged with its file — never a duplicate write
        if (stored) {
          // Identical to the scanned draft: stamp it now, the conservative (later) instant.
          stamped = true;
          return current.map((p, i) => (i === existing ? { ...p, skillFileStagedAt } : p));
        }
        // Staged before W1-T4338: give it the file approval now writes, or it can only ever be declined.
        backfilled = true;
        return current.map((p, i) => (i === existing ? { ...p, summary: skillDraftSummary(draft, reachability), skillFile, skillFileStagedAt } : p));
      }
      staged = true;
      return [...current, { id, summary: skillDraftSummary(draft, reachability), evidenceAnchors: [], skillFile, skillFileStagedAt }];
    },
    opts,
  );
  return {
    refused: false,
    staged,
    alreadyStaged,
    ...(backfilled ? { backfilled: true } : {}),
    ...(refreshed ? { refreshed: true } : {}),
    ...(legacyReplaced ? { legacyReplaced: true } : {}),
    ...(stamped ? { stamped: true } : {}),
    reason: backfilled
      ? "already staged; skill file backfilled"
      : legacyReplaced
        ? "already staged; legacy text replaced with scanned draft before stamping"
      : refreshed
        ? "already staged; procedure refreshed with more steps"
        : stamped
          ? "already staged; staged-at stamp added"
          : alreadyStaged
            ? "already staged"
            : undefined,
  };
}

// ── W1-T3101: a staged skill reaches the worker prompt ────────────────────────────────────────

/**
 * The frontmatter key a skill uses to declare which task classes it applies to, e.g.
 * `applies-to: implement, diagnose`. OPT-IN BY CONSTRUCTION, and that is the whole point: the
 * `.claude/skills/` tree already holds GENERATED macro skills (`tddr`, `grfp`) written by
 * scripts/generate-macro-skills.mjs and marked `disable-model-invocation: true`. Those are for a
 * human at a terminal; injecting them into every implement prompt would spend the knowledge budget
 * on text no worker asked for. A skill with no `applies-to:` is NEVER selected — so the macro tree
 * is excluded without an allowlist naming it, and stays excluded when it grows.
 */
export const SKILL_APPLIES_TO_RE = /^applies-to:\s*(.+)$/m;
/** One skill that has been APPROVED into `.claude/skills/` and opted in to prompt injection. */
export interface InjectableSkill {
  name: string;
  /** Task classes this skill declares itself for, lower-cased. */
  appliesTo: string[];
  /** Optional repo-relative task-file globs. Absent means every file scope; present means at least
   *  one declared task file must match before the skill is eligible. */
  whenPaths?: string[];
  /** The body below the frontmatter — what a worker actually reads. */
  body: string;
}

/** Split `---`-delimited frontmatter from the body. A file with no frontmatter has no `applies-to`
 *  and is therefore never injectable, which is the safe direction for an unrecognised shape. */
function splitFrontmatter(text: string): { front: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: "", body: text };
}

export function describeSkillInjectionReachability(draft: SkillDraft): { reachable: boolean; reason: string } {
  const { front } = splitFrontmatter(draft.markdown);
  const match = SKILL_APPLIES_TO_RE.exec(front);
  const appliesTo = match
    ? match[1].split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
    : [];
  if (appliesTo.length === 0) {
    return { reachable: false, reason: "no non-empty applies-to frontmatter line, so the draft does not opt in to prompt injection" };
  }
  return {
    reachable: true,
    reason: `applies-to: ${appliesTo.join(", ")} opts in to prompt injection after approval via loadInjectableSkills/selectSkillsForTask`,
  };
}

/**
 * Every APPROVED skill under `dir` (`.claude/skills/<name>/SKILL.md`) that opted in to injection.
 *
 * READS THE APPROVED TREE, NEVER THE PROPOSAL REGISTRY. `stageSkillDraft` writes a PROPOSAL; only
 * `rmd approve` turns one into a file here. Injecting a staged-but-unapproved draft would put
 * machine-authored text into a worker prompt with no operator in the loop, which is the one thing
 * this repo's "a machine may propose, only an operator releases" rule forbids.
 */
export function loadInjectableSkills(
  dir: string,
  readDir: (d: string) => string[] = (d) => readdirSync(d),
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): InjectableSkill[] {
  let names: string[];
  try {
    names = readDir(dir).sort();
  } catch {
    return []; // no approved tree yet — an absent directory is zero skills, never an error
  }
  const out: InjectableSkill[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFile(join(dir, name, "SKILL.md"));
    } catch {
      continue; // a directory without a SKILL.md is not a skill; skip it rather than throw
    }
    const { front, body } = splitFrontmatter(text);
    const m = SKILL_APPLIES_TO_RE.exec(front);
    if (!m) continue; // no opt-in — the generated macro tree lands here and is excluded
    const appliesTo = m[1].split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
    if (appliesTo.length === 0) continue;
    const whenPathsMatch = SKILL_WHEN_PATHS_RE.exec(front);
    const whenPaths = whenPathsMatch
      ? whenPathsMatch[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    if (whenPathsMatch && (!whenPaths || whenPaths.length === 0)) continue; // malformed selector: fail closed
    out.push({ name, appliesTo, ...(whenPaths ? { whenPaths } : {}), body: body.trim() });
  }
  return out;
}

/** Optional repo-relative glob selectors. A declared selector is fail-closed when a task has no
 *  declared files or none of its file globs match; an absent key remains repo-wide for backwards
 *  compatibility. */
export const SKILL_WHEN_PATHS_RE = /^when-paths:\s*(.*)$/m;

/** Compile one repo-relative path glob as an anchored matcher. This intentionally mirrors the
 *  learnings selector's `*`, `?`, and `**` semantics so a task's declared `files:` vocabulary has
 *  one meaning across both injection paths. */
function skillPathGlobToRegExp(glob: string): RegExp {
  const SPECIAL = ".+^${}()|[]\\";
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (SPECIAL.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function skillMatchesTaskFiles(skill: InjectableSkill, taskFiles: readonly string[] | undefined): boolean {
  if (skill.whenPaths === undefined) return true;
  if (skill.whenPaths.length === 0 || !taskFiles || taskFiles.length === 0) return false;
  const matchers = skill.whenPaths.map(skillPathGlobToRegExp);
  return taskFiles.some((taskFile) => matchers.some((matcher) => matcher.test(taskFile)));
}

/**
 * The skills to inject for one task class, bounded by `budgetChars`.
 *
 * SPENDS FROM THE EXISTING KNOWLEDGE BUDGET rather than adding a second one: a prompt carrying
 * skills is no larger than {@link import("./learnings.js").DEFAULT_KNOWLEDGE_BUDGET_CHARS} already
 * allowed, so no task has to re-measure a prompt ceiling. Deterministic order (name-sorted, already
 * guaranteed by {@link loadInjectableSkills}) so two runs of one task get one prompt.
 *
 * A skill that does not FIT is DROPPED, never truncated: half a procedure is worse than none.
 */
export function selectSkillsForTask(
  skills: readonly InjectableSkill[],
  taskType: string,
  budgetChars: number,
  taskFiles?: readonly string[],
): InjectableSkill[] {
  return observeSkillSelection(skills, taskType, budgetChars, taskFiles).selected;
}

/**
 * A prompt-assembly observation for the approved, opted-in skill tree.  Unlike the older
 * `skills.injected` event, this has an explicit zero shape: a future report can distinguish
 * "no procedure applied" from "the producer did not emit a row".
 *
 * This function is intentionally the one selection implementation.  Keeping the selected
 * objects and their denominator together prevents a report from describing a different budget
 * decision from the one whose text reached the worker.
 */
export interface SkillSelectionObservation extends Record<string, unknown> {
  task_type: string;
  approved_eligible_names: string[];
  path_filtered_names: string[];
  selected_names: string[];
  budget_omitted_names: string[];
  budget_chars: number;
  zero_selection: boolean;
  /** Present only when the caller randomized: eligible skills withheld from this run by assignment. */
  withheld_names?: string[];
  /** Each eligible skill's {@link skillContentDigest}: the version a selected run read and a withheld run did
   *  not, so effectiveness evidence can be told apart across edits of one skill. */
  skill_digests: Record<string, string>;
}

/** A skill version's identity: its body, the text a worker reads, hashed. An edit to the body is a new
 *  version; frontmatter that only scopes eligibility is not. */
export function skillContentDigest(skill: Pick<InjectableSkill, "body">): string {
  return createHash("sha256").update(skill.body).digest("hex").slice(0, 12);
}

export interface ObservedSkillSelection {
  selected: InjectableSkill[];
  observation: SkillSelectionObservation;
}

/** Predeclared share of eligible runs on which each approved skill is withheld. Without it a skill
 *  that fits the budget is selected on every eligible run and the report's control cohort is empty. */
export const SKILL_WITHHOLDING_SHARE = 0.25;

/** Seeded per-(run, skill) assignment, independent across skills and recomputable from the ledger. */
export function skillWithheldForRun(runId: string, skillName: string, share: number = SKILL_WITHHOLDING_SHARE): boolean {
  const digest = createHash("sha256").update(`${runId}\0${skillName}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < share;
}

export function observeSkillSelection(
  skills: readonly InjectableSkill[],
  taskType: string,
  budgetChars: number,
  taskFiles?: readonly string[],
  withhold?: (skillName: string) => boolean,
): ObservedSkillSelection {
  const want = taskType.toLowerCase();
  const taskTypeEligible = skills.filter((s) => s.appliesTo.includes(want));
  const pathFiltered = taskTypeEligible.filter((s) => !skillMatchesTaskFiles(s, taskFiles));
  const eligible = taskTypeEligible.filter((s) => !pathFiltered.includes(s));
  // A withheld skill is neither rendered nor charged to the budget, so it frees room for the rest.
  const withheld = withhold ? eligible.filter((s) => withhold(s.name)) : [];
  const assigned = eligible.filter((s) => !withheld.includes(s));
  const selected: InjectableSkill[] = [];
  let spent = 0;
  for (const s of assigned) {
    const cost = s.body.length;
    if (spent + cost > budgetChars) continue;
    selected.push(s);
    spent += cost;
  }
  const selectedNames = selected.map((s) => s.name);
  const selectedNameSet = new Set(selectedNames);
  return {
    selected,
    observation: {
      task_type: taskType,
      approved_eligible_names: eligible.map((s) => s.name),
      path_filtered_names: pathFiltered.map((s) => s.name),
      selected_names: selectedNames,
      budget_omitted_names: assigned.filter((s) => !selectedNameSet.has(s.name)).map((s) => s.name),
      budget_chars: budgetChars,
      zero_selection: selected.length === 0,
      ...(withhold ? { withheld_names: withheld.map((s) => s.name) } : {}),
      skill_digests: Object.fromEntries(eligible.map((s) => [s.name, skillContentDigest(s)])),
    },
  };
}

/** The CONTEXT part. Empty string when nothing was selected, so the prompt is byte-identical to
 *  today's for every task with no applicable skill — which is every task until one is approved. */
export function renderSkillsPart(selected: readonly InjectableSkill[]): string {
  if (selected.length === 0) return "";
  return selected.map((s) => `## skill: ${s.name}\n\n${s.body}`).join("\n\n");
}

/** The `skills.injected` payload, or `undefined` when nothing was selected — the caller logs only
 *  when this returns a value, so "no applicable skill" leaves no row rather than a zero-count one.
 *  Extracted as a seam because the caller is inside the implement command, where the branch was
 *  reachable by no test and `diff-coverage` named all five of its lines. ANALYTICS ONLY: nothing
 *  reads this row to make a decision, exactly like `learnings.injected` beside it. */
export function skillsInjectedEvent(
  selected: readonly InjectableSkill[],
  taskType: string,
  budgetChars: number,
): { selected: number; selected_names: string[]; task_type: string; budget_chars: number } | undefined {
  if (selected.length === 0) return undefined;
  return {
    selected: selected.length,
    selected_names: selected.map((s) => s.name),
    task_type: taskType,
    budget_chars: budgetChars,
  };
}

/** W1-T3379's pilot lane, and still the report's default: every existing caller reads implement rows. */
export const SKILL_EFFECTIVENESS_TASK_TYPE = "implement";
/** The fix rung's task class: `applies-to: fix` makes a skill eligible there, and its report reads these rows. */
export const SKILL_FIX_TASK_TYPE = "fix";
/** Predeclared before observing any result, so the report cannot lower it after the fact. */
export const SKILL_EFFECTIVENESS_HORIZON = 10;
/** A terminal worker failure is the named harm signal for this descriptive pilot. */
export const SKILL_EFFECTIVENESS_HARM_OUTCOMES = ["failed"] as const;
/** The steps {@link buildSkillEffectivenessReport} reads; every caller passes exactly this as its union read's
 *  step filter. W1-T10764: a filter without the merge rows hands the report no merge, so both arms read
 *  `merged_runs=0` by construction and only the harm signal can ever decide. Both merge-row steps
 *  {@link isMergedLedgerRow} accepts are here: the sweep's `verdict.merged` credit backfill, and the
 *  `pr.terminal` row the direct merge writes, which is the only record of most merges. */
export const SKILL_EFFECTIVENESS_LEDGER_STEPS: readonly string[] = ["skills.selection", "verdict", "verdict.merged", PR_TERMINAL_STEP];

export interface SkillEffectivenessCohort {
  observed_eligible_runs: number;
  terminal_runs: number;
  /** Worker-terminal rows whose shipment can still resolve; never treat these as observed non-merges. */
  pending_merge_runs: number;
  merged_runs: number;
  harmful_terminal_runs: number;
  outcomes: Record<string, number>;
}

export type SkillEffectivenessStatus = "INSUFFICIENT EVIDENCE" | "RETIRE-CANDIDATE" | "REVIEW-CANDIDATE";

export interface SkillEffectivenessReport {
  skill_name: string;
  task_type: string;
  horizon: number;
  status: SkillEffectivenessStatus;
  basis: "below-horizon" | "zero-selection" | "named-harm-signal" | "not-better-than-control" | "favorable-comparison" | "pending-shipment";
  selected: SkillEffectivenessCohort;
  control: SkillEffectivenessCohort;
  harm_outcomes: readonly string[];
  /** `randomized`: arms by seeded assignment, `selected` meaning not withheld (intent to treat).
   *  `observational`: legacy rows only, where the control is whatever the budget omitted. */
  assignment: "randomized" | "observational";
  /** Terminal compared runs per skill version, in first-seen order; `digest: null` is a row written before
   *  versions were recorded. The comparison above pools every version listed here. */
  versions: SkillEffectivenessVersion[];
}

export interface SkillEffectivenessVersion {
  digest: string | null;
  selected_terminal_runs: number;
  control_terminal_runs: number;
}

type SkillLedgerRow = Record<string, unknown>;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : [];

/** A row's PR: its `pr_url` as `owner/repo#n`, else its `pr_number` on the row's own `repo`. A row naming
 *  neither has no PR to match, so it is never credited a merge. */
const effectivenessPrKey = (row: SkillLedgerRow): string | undefined =>
  prUrlKey(row.pr_url) ??
  (typeof row.repo === "string" && Number.isInteger(row.pr_number) ? `${row.repo}#${row.pr_number as number}` : undefined);

const emptyCohort = (): SkillEffectivenessCohort => ({
  observed_eligible_runs: 0,
  terminal_runs: 0,
  pending_merge_runs: 0,
  merged_runs: 0,
  harmful_terminal_runs: 0,
  outcomes: {},
});

/**
 * Deterministically joins `taskType`'s `skills.selection` row emitted at prompt assembly to the
 * terminal `verdict` row that carries the same run id.  It never reads or writes the approved
 * tree: results are evidence for an operator's later decision, not a lifecycle action.
 *
 * W1-T10764: a run's own `verdict` row never reads `merged` — it hands off (`handed_off`,
 * `blocked_ci`) and the merge is recorded later under another run id: a `verdict.merged` credit
 * backfill, or a `pr.terminal` row reading `merged`. So a run resolves to `merged` when its terminal
 * `verdict` row names a PR that any {@link isMergedLedgerRow} row names. The join is by PR, never by
 * `task_id`: a task can have several runs and only one PR merged.
 */
export function buildSkillEffectivenessReport(
  rows: readonly SkillLedgerRow[],
  skillName: string,
  taskType: string = SKILL_EFFECTIVENESS_TASK_TYPE,
): SkillEffectivenessReport {
  const terminalVerdictByRun = new Map<string, { verdict: string; prKey: string | undefined }>();
  const mergedPrKeys = new Set<string>();
  const selectionByRun = new Map<string, { selected: boolean; withheld?: boolean; digest: string | null }>();

  for (const row of rows) {
    if (isMergedLedgerRow(row)) {
      const prKey = effectivenessPrKey(row);
      if (prKey !== undefined) mergedPrKeys.add(prKey);
    }
    if (row.step === "verdict" && typeof row.run_id === "string" && typeof row.verdict === "string") {
      terminalVerdictByRun.set(row.run_id, { verdict: row.verdict, prKey: effectivenessPrKey(row) });
      continue;
    }
    if (
      row.step !== "skills.selection" ||
      row.task_type !== taskType ||
      typeof row.run_id !== "string"
    ) continue;
    const eligible = stringArray(row.approved_eligible_names);
    if (!eligible.includes(skillName)) continue;
    const digests = row.skill_digests;
    const digest = digests !== null && typeof digests === "object" ? (digests as Record<string, unknown>)[skillName] : undefined;
    selectionByRun.set(row.run_id, {
      selected: stringArray(row.selected_names).includes(skillName),
      ...(Array.isArray(row.withheld_names) ? { withheld: stringArray(row.withheld_names).includes(skillName) } : {}),
      digest: typeof digest === "string" ? digest : null,
    });
  }

  // Resolved only after every row is read: the merge row is written after the run's verdict, but a union
  // read need not return them in that order.
  const terminalOutcome = (runId: string): string | undefined => {
    const terminal = terminalVerdictByRun.get(runId);
    if (terminal === undefined) return undefined;
    return terminal.prKey !== undefined && mergedPrKeys.has(terminal.prKey) ? "merged" : terminal.verdict;
  };

  // Once any randomized row exists for this skill, only randomized rows are compared: the arms are then
  // assigned, so a budget omission (which tracks how many skills a task drew) cannot bias them.
  const randomized = [...selectionByRun.values()].some((o) => o.withheld !== undefined);
  const inArm = (o: { selected: boolean; withheld?: boolean }, treated: boolean): boolean =>
    randomized ? o.withheld !== undefined && o.withheld !== treated : o.selected === treated;

  const buildCohort = (selected: boolean): SkillEffectivenessCohort => {
    const cohort = emptyCohort();
    for (const [runId, observation] of selectionByRun) {
      if (!inArm(observation, selected)) continue;
      cohort.observed_eligible_runs++;
      const outcome = terminalOutcome(runId);
      if (!outcome) continue;
      cohort.terminal_runs++;
      cohort.outcomes[outcome] = (cohort.outcomes[outcome] ?? 0) + 1;
      if (outcome === "merged") cohort.merged_runs++;
      if (outcome === "handed_off" || outcome === "blocked_ci") cohort.pending_merge_runs++;
      if ((SKILL_EFFECTIVENESS_HARM_OUTCOMES as readonly string[]).includes(outcome)) cohort.harmful_terminal_runs++;
    }
    return cohort;
  };

  const selected = buildCohort(true);
  const control = buildCohort(false);
  const versionByDigest = new Map<string | null, SkillEffectivenessVersion>();
  for (const [runId, observation] of selectionByRun) {
    const treated = inArm(observation, true);
    if ((!treated && !inArm(observation, false)) || terminalOutcome(runId) === undefined) continue;
    let version = versionByDigest.get(observation.digest);
    if (version === undefined) {
      version = { digest: observation.digest, selected_terminal_runs: 0, control_terminal_runs: 0 };
      versionByDigest.set(observation.digest, version);
    }
    if (treated) version.selected_terminal_runs++;
    else version.control_terminal_runs++;
  }
  const zeroSelectionAtHorizon =
    selected.observed_eligible_runs === 0 && control.terminal_runs >= SKILL_EFFECTIVENESS_HORIZON;
  const belowComparisonHorizon =
    selected.terminal_runs < SKILL_EFFECTIVENESS_HORIZON || control.terminal_runs < SKILL_EFFECTIVENESS_HORIZON;
  const selectedMergeRate = selected.terminal_runs === 0 ? 0 : selected.merged_runs / selected.terminal_runs;
  const controlMergeRate = control.terminal_runs === 0 ? 0 : control.merged_runs / control.terminal_runs;
  // Identification bounds, not confidence intervals: pending work can all merge or all remain unmerged.
  const selectedMergeUpper = selected.terminal_runs === 0 ? 0 : (selected.merged_runs + selected.pending_merge_runs) / selected.terminal_runs;
  const controlMergeUpper = control.terminal_runs === 0 ? 0 : (control.merged_runs + control.pending_merge_runs) / control.terminal_runs;

  let status: SkillEffectivenessStatus;
  let basis: SkillEffectivenessReport["basis"];
  if (zeroSelectionAtHorizon) {
    status = "RETIRE-CANDIDATE";
    basis = "zero-selection";
  } else if (belowComparisonHorizon) {
    status = "INSUFFICIENT EVIDENCE";
    basis = "below-horizon";
  } else if (selected.harmful_terminal_runs > 0) {
    status = "RETIRE-CANDIDATE";
    basis = "named-harm-signal";
  } else if (selectedMergeUpper <= controlMergeRate) {
    status = "RETIRE-CANDIDATE";
    basis = "not-better-than-control";
  } else if (selectedMergeRate > controlMergeUpper) {
    status = "REVIEW-CANDIDATE";
    basis = "favorable-comparison";
  } else {
    status = "INSUFFICIENT EVIDENCE";
    basis = "pending-shipment";
  }

  return {
    skill_name: skillName,
    task_type: taskType,
    horizon: SKILL_EFFECTIVENESS_HORIZON,
    status,
    basis,
    selected,
    control,
    harm_outcomes: SKILL_EFFECTIVENESS_HARM_OUTCOMES,
    assignment: randomized ? "randomized" : "observational",
    versions: [...versionByDigest.values()],
  };
}

const renderOutcomes = (outcomes: Record<string, number>): string => {
  const entries = Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "none" : entries.map(([outcome, count]) => `${outcome}=${count}`).join(", ");
};

/** A human-readable, read-only rendering.  It deliberately describes a comparison, not causation. */
export function renderSkillEffectivenessReport(report: SkillEffectivenessReport): string {
  const renderCohort = (name: string, cohort: SkillEffectivenessCohort): string =>
    `${name}: observed_eligible_runs=${cohort.observed_eligible_runs}; terminal_runs=${cohort.terminal_runs}; ` +
    `merged_runs=${cohort.merged_runs}; harmful_terminal_runs=${cohort.harmful_terminal_runs}; ` +
    `pending_merge_runs=${cohort.pending_merge_runs}; ` +
    `outcomes=${renderOutcomes(cohort.outcomes)}`;
  return [
    `### rmd skill effectiveness — ${report.skill_name} (${report.task_type})`,
    `status: ${report.status}`,
    `basis: ${report.basis}`,
    `horizon: ${report.horizon} terminal selected eligible runs and ${report.horizon} terminal unselected eligible controls`,
    renderCohort("selected", report.selected),
    renderCohort("control", report.control),
    `named harm outcomes: ${report.harm_outcomes.join(", ")}`,
    "shipment comparison: best/worst-case bounds over handed_off and blocked_ci runs; overlapping possibilities are insufficient evidence. These are not confidence intervals or deployment/live-benefit claims.",
    report.assignment === "randomized"
      ? `assignment: randomized — control is eligible runs that withheld the skill (share ${SKILL_WITHHOLDING_SHARE}); ` +
        "selected is every other eligible run (intent to treat)."
      : "assignment: observational — control is eligible runs on which the budget omitted the skill.",
    report.assignment === "randomized"
      ? "interpretation: a randomized comparison at a small horizon is evidence, not proof; this report does not modify a skill."
      : "interpretation: descriptive selection/outcome evidence only; this report does not prove causation or modify a skill.",
    `skill versions: ${renderSkillVersions(report.versions)}`,
  ].join("\n");
}

/** Each version's terminal runs per arm, and a warning when the pooled comparison spans recorded edits. */
function renderSkillVersions(versions: readonly SkillEffectivenessVersion[]): string {
  if (versions.length === 0) return "none compared";
  const listed = versions.map((v) =>
    `${v.digest ?? "unrecorded"} selected=${v.selected_terminal_runs} control=${v.control_terminal_runs}`).join("; ");
  const recorded = versions.filter((v) => v.digest !== null).length;
  return recorded > 1 ? `${listed} — the comparison pools ${recorded} recorded versions` : listed;
}

export const SKILL_LIFECYCLE_PROPOSAL_PREFIX = "skill-lifecycle:";

export function skillLifecycleProposalId(skillName: string): string {
  return `${SKILL_LIFECYCLE_PROPOSAL_PREFIX}${skillName}`;
}

export interface StageSkillLifecycleProposalResult {
  refused: boolean;
  staged: boolean;
  refreshed: boolean;
  alreadyStaged: boolean;
  proposalId?: string;
  evidenceFingerprint?: string;
  reason?: string;
}

const sortedOutcomes = (outcomes: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b)));

function fingerprintCohort(cohort: SkillEffectivenessCohort): SkillEffectivenessCohort {
  return { ...cohort, outcomes: sortedOutcomes(cohort.outcomes) };
}

export function skillLifecycleEvidenceFingerprint(report: SkillEffectivenessReport): string {
  return createHash("sha256")
    .update(JSON.stringify({
      skill_name: report.skill_name,
      task_type: report.task_type,
      horizon: report.horizon,
      status: report.status,
      basis: report.basis,
      selected: fingerprintCohort(report.selected),
      control: fingerprintCohort(report.control),
      harm_outcomes: [...report.harm_outcomes].sort(),
    }))
    .digest("hex")
    .slice(0, 16);
}

function skillLifecycleRefusal(report: SkillEffectivenessReport, approvedSkillsDir: string): string | undefined {
  const approved = loadInjectableSkills(approvedSkillsDir).some((skill) => skill.name === report.skill_name);
  if (!approved) {
    return `skill '${report.skill_name}' is not approved and opted in under ${approvedSkillsDir}`;
  }
  if (report.status === "INSUFFICIENT EVIDENCE") {
    if (report.basis === "pending-shipment") {
      return `pending shipment: selected=${report.selected.pending_merge_runs}, control=${report.control.pending_merge_runs}; merge-rate bounds overlap`;
    }
    return (
      `below horizon: selected terminal_runs=${report.selected.terminal_runs}, ` +
      `control terminal_runs=${report.control.terminal_runs}, horizon=${report.horizon}`
    );
  }
  if (report.status === "REVIEW-CANDIDATE") {
    return `REVIEW-CANDIDATE is read-only: ${report.basis} does not authorize a release action`;
  }
  return undefined;
}

function renderSkillLifecycleSummary(report: SkillEffectivenessReport, action: SkillLifecycleAction): string {
  return [
    `Retire approved skill '${report.skill_name}' from ${action.skillPath}.`,
    `Action: remove exactly ${action.skillPath}`,
    `Evidence fingerprint: ${action.evidenceFingerprint}`,
    `Status: ${report.status}`,
    `Basis: ${report.basis}`,
    `Selected: observed=${report.selected.observed_eligible_runs}; terminal=${report.selected.terminal_runs}; ` +
      `merged=${report.selected.merged_runs}; harmful=${report.selected.harmful_terminal_runs}; ` +
      `outcomes=${renderOutcomes(report.selected.outcomes)}`,
    `Control: observed=${report.control.observed_eligible_runs}; terminal=${report.control.terminal_runs}; ` +
      `merged=${report.control.merged_runs}; harmful=${report.control.harmful_terminal_runs}; ` +
      `outcomes=${renderOutcomes(report.control.outcomes)}`,
    `Versions: ${renderSkillVersions(report.versions)}`,
    `Approving this proposal opens a reviewed PR that deletes only ${action.skillPath}; staging this proposal deletes nothing.`,
  ].join("\n");
}

export function skillLifecycleProposalForReport(
  report: SkillEffectivenessReport,
  approvedSkillsDir: string,
): { ok: true; proposal: Proposal } | { ok: false; reason: string } {
  const refusal = skillLifecycleRefusal(report, approvedSkillsDir);
  if (refusal) return { ok: false, reason: refusal };
  const evidenceFingerprint = skillLifecycleEvidenceFingerprint(report);
  const action: SkillLifecycleAction = {
    kind: "skill-retirement",
    skillName: report.skill_name,
    skillPath: `.claude/skills/${report.skill_name}/SKILL.md`,
    evidenceFingerprint,
  };
  return {
    ok: true,
    proposal: {
      id: skillLifecycleProposalId(report.skill_name),
      summary: renderSkillLifecycleSummary(report, action),
      evidenceAnchors: [],
      lifecycleAction: action,
    },
  };
}

export function stageSkillLifecycleProposal(
  registryPath: string,
  approvedSkillsDir: string,
  report: SkillEffectivenessReport,
  opts: UpdateProposalRegistryOpts = {},
): StageSkillLifecycleProposalResult {
  const built = skillLifecycleProposalForReport(report, approvedSkillsDir);
  if (!built.ok) return { refused: true, staged: false, refreshed: false, alreadyStaged: false, reason: built.reason };
  const proposal = built.proposal;
  let staged = false;
  let refreshed = false;
  let alreadyStaged = false;
  updateProposalRegistry(
    registryPath,
    (current) => {
      staged = false;
      refreshed = false;
      alreadyStaged = false;
      const idx = current.findIndex((p) => p.id === proposal.id);
      if (idx === -1) {
        staged = true;
        return [...current, proposal];
      }
      if (current[idx].lifecycleAction?.evidenceFingerprint === proposal.lifecycleAction?.evidenceFingerprint) {
        alreadyStaged = true;
        return null;
      }
      refreshed = true;
      const next = [...current];
      next[idx] = { ...current[idx], ...proposal };
      return next;
    },
    opts,
  );
  return {
    refused: false,
    staged,
    refreshed,
    alreadyStaged,
    proposalId: proposal.id,
    evidenceFingerprint: proposal.lifecycleAction?.evidenceFingerprint,
    reason: alreadyStaged ? "already staged with identical evidence" : undefined,
  };
}

/**
 * Stage every draft the retro gathered, BEST-EFFORT: a throw on one draft must never fail the
 * retro, whose report is the thing the operator actually came for. Extracted as a seam for the
 * same reason as {@link skillsInjectedEvent} — the loop lived inside `retroCommand`, so its catch
 * arm was unreachable by any test and `diff-coverage` named nine of its lines.
 *
 * STAGING WRITES A PROPOSAL AND NOTHING ELSE. The operator still releases it with `rmd approve`,
 * and only that writes under `.claude/skills/` — so nothing here can put machine-authored text in
 * front of a worker.
 */
export function stageSkillDrafts(
  registryPath: string,
  drafts: readonly SkillDraft[],
  allowlist: WorkerAllowlist | ((draft: SkillDraft) => WorkerAllowlist),
  reachability: (draft: SkillDraft) => { reachable: boolean; reason: string },
  log: (step: string, extra?: Record<string, unknown>) => void,
  stageOne: typeof stageSkillDraft = stageSkillDraft,
): void {
  for (const draft of drafts) {
    try {
      const r = stageOne(registryPath, draft, typeof allowlist === "function" ? allowlist(draft) : allowlist, reachability(draft));
      log("skill.staged", { name: draft.name, staged: r.staged, already: r.alreadyStaged, backfilled: r.backfilled === true, refreshed: r.refreshed === true, refused: r.refused, reason: r.reason });
    } catch (e) {
      log("skill.stage_failed", { name: draft.name, error: String((e as Error)?.message ?? e) });
    }
  }
}
