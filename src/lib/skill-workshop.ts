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
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { slug as kebabSlug } from "./feedback-docket.js";
import { systemClock, type Clock } from "./clock.js";
import { ledgerProposalVerdicts, loadProposalRegistry, SKILL_DRAFT_ID_PREFIX, updateProposalRegistry, type Proposal, type SkillLifecycleAction, type UpdateProposalRegistryOpts } from "./inbox.js";
import { mergeVerdictReceipts, verdictReceiptOf, type VerdictReceipt } from "./inbox-verdict-receipts.js";
import { inflightLockPath } from "./inflight-lock.js";
import { TASK_TYPES, type Task } from "./plan.js";
import { WORKER_PROVIDER_IDS } from "./config-schema.js";
import { isMergedLedgerRow, PR_TERMINAL_STEP, prUrlKey } from "./ledger-carry.js";
import { LedgerAppendConflict, ledgerFileVersion, ledgerRotationLockPath, tryAcquireRotationLock } from "./ledger.js";
import { ledgerLivePath, ledgerRotationEntries, readLedgerUnionRecordsSync, realLedgerFs, type LedgerUnionRecordRead } from "./ledger-union.js";
import { seededRandom, seedOf } from "./knowledge-value.js";
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
  // draft; with no mined steps it stays, so stageSkillDraft refuses the outcome-only procedure.
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

function procedureStepLines(markdown: string): string[] {
  const section = /^## Procedure\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  return section.split("\n").filter((line) => line.startsWith("- "));
}

/** Procedure steps, excluding restatements of the supplied mined outcomes. */
function skillProcedureSteps(markdown: string, descriptions: readonly string[]): string[] {
  return procedureStepLines(markdown).filter((line) => !descriptions.some((description) => restatesOutcome(line, description)));
}

const SIGNAL_TABLE_STEP_LINES: ReadonlySet<string> = new Set(Object.values(PROCEDURAL_STEP_TEXT).map((text) => `- ${text}`));

/** W1-T13858: the #7833 whole-draft check, beside the W1-T4283 per-line check. */
function outcomeOnlyDraftRefusal(markdown: string): string | undefined {
  const steps = procedureStepLines(markdown);
  if (steps.length === 0 || !steps.every((line) => SIGNAL_TABLE_STEP_LINES.has(line))) return undefined;
  return "outcome-only: every Procedure step restates the signal the runs were mined on, so the draft names no step a worker could take";
}

/** The origin a workshop close writes on its decline row. */
const SKILL_WORKSHOP_ORIGIN = "skill-workshop";

function storedSkillSha256(proposal: Proposal): string {
  return createHash("sha256").update(proposal.skillFile?.markdown ?? "").digest("hex");
}

/** True when the workshop already closed this entry's stored text. An operator restore keeps the record. */
function workshopClosedSkillDraft(proposal: Proposal): boolean {
  return proposal.skillDraftClose?.skillSha256 === storedSkillSha256(proposal);
}

type SkillDraftLog = (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) => void;

/**
 * Close one staged skill draft: the decline row first, then the close record on the registry entry.
 * A crash between the two can repeat one row; it cannot record a close for a draft that is still open.
 * Writes nothing under .claude/skills/. True when it closed.
 */
function closeSkillDraft(
  registryPath: string,
  proposalId: string,
  reasonFor: string | ((entry: Proposal) => { reason: string; liveVersion: string } | undefined),
  log: SkillDraftLog,
  clock: Pick<Clock, "iso">,
): boolean {
  const staged = loadProposalRegistry(registryPath).find((p) => p.id === proposalId);
  if (!staged || workshopClosedSkillDraft(staged)) return false;
  return updateProposalRegistry(registryPath, (current) => {
    const entry = current.find((p) => p.id === proposalId);
    if (!entry || workshopClosedSkillDraft(entry)) return null;
    const decision = typeof reasonFor === "string" ? { reason: reasonFor, liveVersion: undefined } : reasonFor(entry);
    if (decision === undefined) return null;
    const { reason, liveVersion } = decision;
    const at = clock.iso();
    const closeId = randomUUID();
    const step = "panel.proposal_declined";
    const skillSha256 = storedSkillSha256(entry);
    log(step, { ts: at, task_id: proposalId, origin: SKILL_WORKSHOP_ORIGIN, reason,
      skill_draft_close_id: closeId, skill_draft_sha256: skillSha256 }, liveVersion);

    // appendLedger can return after a short write. Confirm this attempt in the ledger, including rotations.
    const stateDir = dirname(registryPath);
    const livePath = ledgerLivePath(stateDir);
    const { rows } = readLedgerUnionRecordsSync(stateDir, {
      step, since: at, liveFirst: true, pattern: new RegExp(closeId),
      where: (row) => row.skill_draft_close_id === closeId && row.task_id === proposalId &&
        row.origin === SKILL_WORKSHOP_ORIGIN && row.reason === reason && row.skill_draft_sha256 === skillSha256,
      satisfied: (steps) => steps.has(step),
    }, {
      ...realLedgerFs,
      readFileSync: (path) => {
        const bytes = realLedgerFs.readFileSync(path);
        // A live tail missing its newline can still be valid JSON until another append joins it.
        return path === livePath ? bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1) : bytes;
      },
    });
    if (rows.length === 0) throw new Error(`could not confirm the workshop decline for ${proposalId} in the ledger`);
    const skillDraftClose = { at, reason, skillSha256 };
    return current.map((p) => p === entry ? { ...p, skillDraftClose } : p);
  }) !== null;
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
  const outcomeOnly = outcomeOnlyDraftRefusal(draft.markdown);
  if (!scan.ok) {
    const detail = `${scan.reason} (offending line: "${scan.offendingLine}")`;
    return { refused: true, staged: false, alreadyStaged: false, reason: outcomeOnly ? `${outcomeOnly}. ${detail}` : detail };
  }
  if (outcomeOnly !== undefined) return { refused: true, staged: false, alreadyStaged: false, reason: outcomeOnly };
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

/** A skill with a staged retirement is offered only on the seeded share of runs that would have withheld it: the
 *  arms flip, so evidence keeps accruing, and a withdrawn proposal restores the normal share. */
export function skillWithheldUnderRetirement(runId: string, skillName: string, staged: ReadonlySet<string>): boolean {
  const withheld = skillWithheldForRun(runId, skillName);
  return staged.has(skillName) ? !withheld : withheld;
}

/** The skill names with a staged skill-retirement proposal in the inbox registry. */
export function stagedSkillRetirements(registryPath: string): ReadonlySet<string> {
  try {
    return new Set(loadProposalRegistry(registryPath).flatMap((p) =>
      p.lifecycleAction?.kind === "skill-retirement" ? [p.lifecycleAction.skillName] : []));
  } catch {
    // deliberate: an unreadable registry reads as no staged retirement, so every skill keeps its seeded share.
    return new Set();
  }
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
/** A terminal worker failure is the named harm outcome; harm decides only through {@link harmExcessPValue}. */
export const SKILL_EFFECTIVENESS_HARM_OUTCOMES = ["failed"] as const;
/** Predeclared, as the horizon is: harm alone makes a skill a retire candidate only when the selected arm's harm
 *  rate exceeds the control's at this one-sided significance. Any failed selected run used to suffice, which made
 *  a skill whose selected runs failed LESS often than its controls a retire candidate. */
export const SKILL_EFFECTIVENESS_HARM_ALPHA = 0.05;
/** The steps {@link buildSkillEffectivenessReport} reads; every caller passes exactly this as its union read's
 *  step filter. W1-T10764: a filter without the merge rows hands the report no merge, so both arms read
 *  `merged_runs=0` by construction and only the harm signal can ever decide. Both merge-row steps
 *  {@link isMergedLedgerRow} accepts are here: the sweep's `verdict.merged` credit backfill, and the
 *  `pr.terminal` row the direct merge writes, which is the only record of most merges. */
export const SKILL_EFFECTIVENESS_LEDGER_STEPS: readonly string[] = ["skills.selection", "verdict", "verdict.merged", PR_TERMINAL_STEP, "fix.done"];
/** Bootstrap draws for the cost comparison, the count retireCertainties uses. */
export const SKILL_COST_BOOTSTRAP_DRAWS = 400;
/** One-sided confidence for the cost rule and the percentile of verdict-to-merge time that settles a run. */
export const SKILL_COST_CONFIDENCE = 0.95;
const PENDING_VERDICTS: readonly string[] = ["handed_off", "blocked_ci"];

export interface SkillEffectivenessCohort {
  observed_eligible_runs: number;
  terminal_runs: number;
  /** Worker-terminal rows whose shipment can still resolve; never treat these as observed non-merges. */
  pending_merge_runs: number;
  merged_runs: number;
  harmful_terminal_runs: number;
  outcomes: Record<string, number>;
}

/** One arm of a report: its merge and harm counts, settled runs and costs. */
export interface SkillEffectivenessArm extends SkillEffectivenessCohort {
  /** Handed-off runs settled as not merged: the PR closed, or the run waited longer than the settle window. */
  not_merged_runs: number;
  /** Terminal runs with a recorded verdict cost, including runs whose shipment is pending. */
  costed_runs: number;
  /** The costed runs' verdict cost plus the cost of each fix round on the run's PR. */
  cost_usd: number;
  cost_per_merged_pr: number | null;
}

/** One-sided Fisher exact p-value that the selected arm's harm rate exceeds the control's: with each arm's terminal
 *  runs and the total harm fixed, the chance that the selected arm holds at least the harm it shows. 1 when either
 *  arm has no terminal run, since nothing is compared. */
export function harmExcessPValue(selected: SkillEffectivenessCohort, control: SkillEffectivenessCohort): number {
  const runs = selected.terminal_runs, total = runs + control.terminal_runs;
  if (runs === 0 || control.terminal_runs === 0) return 1;
  const harm = selected.harmful_terminal_runs + control.harmful_terminal_runs;
  const lnFactorial = [0];
  for (let i = 1; i <= total; i++) lnFactorial.push(lnFactorial[i - 1]! + Math.log(i));
  const lnChoose = (n: number, k: number): number => lnFactorial[n]! - lnFactorial[k]! - lnFactorial[n - k]!;
  let p = 0;
  for (let x = selected.harmful_terminal_runs; x <= Math.min(harm, runs); x++) {
    p += Math.exp(lnChoose(harm, x) + lnChoose(total - harm, runs - x) - lnChoose(total, runs));
  }
  return Math.min(1, p);
}

/** The harm comparison a report's reader and a retirement proposal both show, so a verdict names its evidence. */
function renderHarmComparison(report: SkillEffectivenessReport): string {
  return `selected ${report.selected.harmful_terminal_runs}/${report.selected.terminal_runs}, ` +
    `control ${report.control.harmful_terminal_runs}/${report.control.terminal_runs}; one-sided exact ` +
    `p=${harmExcessPValue(report.selected, report.control).toFixed(3)}; harm alone retires below p=${SKILL_EFFECTIVENESS_HARM_ALPHA}`;
}

/** Each arm's cost per merged PR from a seeded bootstrap of its costed runs: the one-sided lower bound of
 *  (offered minus control), or null below the horizon. Draws from the skill name, so the same rows give one verdict. */
function costDifferenceLowerBound(skillName: string, offered: readonly CostSample[], control: readonly CostSample[]): number | null {
  if (offered.length < SKILL_EFFECTIVENESS_HORIZON || control.length < SKILL_EFFECTIVENESS_HORIZON) return null;
  const rng = seededRandom(seedOf(skillName));
  const resampled = (samples: readonly CostSample[]): number => {
    let cost = 0;
    let merged = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[Math.floor(rng() * samples.length)]!;
      cost += s.cost;
      if (s.merged) merged++;
    }
    return merged === 0 ? Infinity : cost / merged;
  };
  const diffs: number[] = [];
  for (let k = 0; k < SKILL_COST_BOOTSTRAP_DRAWS; k++) {
    const d = resampled(offered) - resampled(control);
    diffs.push(Number.isNaN(d) ? 0 : d);
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor((1 - SKILL_COST_CONFIDENCE) * SKILL_COST_BOOTSTRAP_DRAWS)]!;
}

interface CostSample {
  runId: string;
  cost: number;
  merged: boolean;
}

/** The nearest-rank percentile of sorted values. */
const percentile = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

export type SkillEffectivenessStatus = "INSUFFICIENT EVIDENCE" | "RETIRE-CANDIDATE" | "REVIEW-CANDIDATE";

export interface SkillEffectivenessReport {
  skill_name: string;
  task_type: string;
  horizon: number;
  status: SkillEffectivenessStatus;
  basis: "below-horizon" | "zero-selection" | "named-harm-signal" | "costs-more-than-it-saves" | "not-better-than-control" | "favorable-comparison" | "pending-shipment";
  selected: SkillEffectivenessArm;
  control: SkillEffectivenessArm;
  harm_outcomes: readonly string[];
  /** `randomized`: arms by seeded assignment, `selected` meaning not withheld (intent to treat).
   *  `observational`: legacy rows only, where the control is whatever the budget omitted. */
  assignment: "randomized" | "observational";
  /** Terminal compared runs per skill version, in first-seen order; `digest: null` is a row written before
   *  versions were recorded. The comparison above pools every version listed here. */
  versions: SkillEffectivenessVersion[];
  /** The 95th percentile of verdict-to-merge time over timestamped merged runs; null below the horizon. */
  settle_window_ms: number | null;
  /** One-sided 95% lower bound of (selected minus control) cost per merged PR; null when not compared. */
  cost_difference_lower_bound_usd: number | null;
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

const emptyCohort = (): SkillEffectivenessArm => ({
  observed_eligible_runs: 0,
  terminal_runs: 0,
  pending_merge_runs: 0,
  merged_runs: 0,
  not_merged_runs: 0,
  harmful_terminal_runs: 0,
  outcomes: {},
  costed_runs: 0,
  cost_usd: 0,
  cost_per_merged_pr: null,
});

const rowMs = (row: SkillLedgerRow): number | undefined => {
  const ms = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/** A row's notional cost, else its billed cost; undefined when it records neither. */
const rowCostUsd = (row: SkillLedgerRow): number | undefined => {
  for (const value of [row.notional_cost_usd, row.total_cost_usd]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
};

/**
 * Deterministically joins `taskType`'s `skills.selection` row emitted at prompt assembly to the
 * terminal `verdict` row that carries the same run id.  It never reads or writes the approved
 * tree: results are evidence for an operator's later decision, not a lifecycle action.
 *
 * A direct merge records its own terminal verdict. Handed-off runs can merge under another run id
 * through a `verdict.merged` credit or a `pr.terminal` row. The join is by PR because a task can
 * have several runs and only one PR merged.
 */
export function buildSkillEffectivenessReport(
  rows: readonly SkillLedgerRow[],
  skillName: string,
  taskType: string = SKILL_EFFECTIVENESS_TASK_TYPE,
): SkillEffectivenessReport {
  const terminalVerdictByRun = new Map<string, { verdict: string; prKey: string | undefined; ms: number | undefined; cost: number | undefined }>();
  const mergedAtMs = new Map<string, number | undefined>();
  const timedClosedPrKeys = new Set<string>();
  const fixCostByPr = new Map<string, number>();
  const selectionByRun = new Map<string, { selected: boolean; withheld?: boolean; digest: string | null }>();
  let latestMs: number | undefined;

  for (const row of rows) {
    const ms = rowMs(row);
    if (ms !== undefined && (latestMs === undefined || ms > latestMs)) latestMs = ms;
    if (isMergedLedgerRow(row)) {
      const prKey = effectivenessPrKey(row);
      if (prKey !== undefined) {
        const prior = mergedAtMs.get(prKey);
        mergedAtMs.set(prKey, prior === undefined ? ms : ms === undefined ? prior : Math.min(prior, ms));
      }
    }
    if (row.step === PR_TERMINAL_STEP && row.state === "closed" && ms !== undefined) {
      const prKey = effectivenessPrKey(row);
      if (prKey !== undefined) timedClosedPrKeys.add(prKey);
    }
    if (row.step === "fix.done") {
      const prKey = effectivenessPrKey(row) ?? prUrlKey(row.repair_pr_url);
      const cost = rowCostUsd(row);
      if (prKey !== undefined && cost !== undefined) fixCostByPr.set(prKey, (fixCostByPr.get(prKey) ?? 0) + cost);
      continue;
    }
    if (row.step === "verdict" && typeof row.run_id === "string" && typeof row.verdict === "string") {
      terminalVerdictByRun.set(row.run_id, { verdict: row.verdict, prKey: effectivenessPrKey(row), ms, cost: rowCostUsd(row) });
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

  const isMerged = (prKey: string | undefined): boolean => prKey !== undefined && mergedAtMs.has(prKey);
  const delays: number[] = [];
  for (const terminal of terminalVerdictByRun.values()) {
    const mergedMs = terminal.verdict === "merged" ? terminal.ms
      : terminal.prKey === undefined ? undefined : mergedAtMs.get(terminal.prKey);
    if (terminal.ms !== undefined && mergedMs !== undefined) delays.push(Math.max(0, mergedMs - terminal.ms));
  }
  delays.sort((a, b) => a - b);
  const settleWindowMs = delays.length >= SKILL_EFFECTIVENESS_HORIZON ? percentile(delays, SKILL_COST_CONFIDENCE) : null;

  // Resolved only after every row is read: the merge row is written after the run's verdict, but a union
  // read need not return them in that order.
  const resolve = (runId: string): { outcome: string; cost: number | undefined } | undefined => {
    const terminal = terminalVerdictByRun.get(runId);
    if (terminal === undefined) return undefined;
    const cost = terminal.cost === undefined ? undefined
      : terminal.cost + (terminal.prKey === undefined ? 0 : fixCostByPr.get(terminal.prKey) ?? 0);
    if (isMerged(terminal.prKey)) return { outcome: "merged", cost };
    if (PENDING_VERDICTS.includes(terminal.verdict) && settleWindowMs !== null && terminal.ms !== undefined) {
      const closed = terminal.prKey !== undefined && timedClosedPrKeys.has(terminal.prKey);
      if (closed || (latestMs !== undefined && latestMs > terminal.ms + settleWindowMs)) return { outcome: "not_merged", cost };
    }
    return { outcome: terminal.verdict, cost };
  };

  // Once any randomized row exists for this skill, only randomized rows are compared: the arms are then
  // assigned, so a budget omission (which tracks how many skills a task drew) cannot bias them.
  const randomized = [...selectionByRun.values()].some((o) => o.withheld !== undefined);
  const inArm = (o: { selected: boolean; withheld?: boolean }, treated: boolean): boolean =>
    randomized ? o.withheld !== undefined && o.withheld !== treated : o.selected === treated;

  const costSamples = { selected: [] as CostSample[], control: [] as CostSample[] };
  const buildCohort = (selected: boolean): SkillEffectivenessArm => {
    const cohort = emptyCohort();
    const samples = selected ? costSamples.selected : costSamples.control;
    for (const [runId, observation] of selectionByRun) {
      if (!inArm(observation, selected)) continue;
      cohort.observed_eligible_runs++;
      const resolved = resolve(runId);
      if (!resolved) continue;
      const { outcome, cost } = resolved;
      cohort.terminal_runs++;
      cohort.outcomes[outcome] = (cohort.outcomes[outcome] ?? 0) + 1;
      if (outcome === "merged") cohort.merged_runs++;
      if (outcome === "not_merged") cohort.not_merged_runs++;
      if (PENDING_VERDICTS.includes(outcome)) cohort.pending_merge_runs++;
      if ((SKILL_EFFECTIVENESS_HARM_OUTCOMES as readonly string[]).includes(outcome)) cohort.harmful_terminal_runs++;
      if (cost !== undefined) samples.push({ runId, cost, merged: outcome === "merged" });
    }
    // Summed in run order, so the same rows in any order give the same figures.
    samples.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
    cohort.costed_runs = samples.length;
    cohort.cost_usd = samples.reduce((sum, s) => sum + s.cost, 0);
    const mergedCosted = samples.filter((s) => s.merged).length;
    cohort.cost_per_merged_pr = mergedCosted === 0 ? null : cohort.cost_usd / mergedCosted;
    return cohort;
  };

  const selected = buildCohort(true);
  const control = buildCohort(false);
  const versionByDigest = new Map<string | null, SkillEffectivenessVersion>();
  for (const [runId, observation] of selectionByRun) {
    const treated = inArm(observation, true);
    if ((!treated && !inArm(observation, false)) || !terminalVerdictByRun.has(runId)) continue;
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

  const costLowerBound = selected.cost_per_merged_pr === null || control.cost_per_merged_pr === null
    ? null : costDifferenceLowerBound(skillName, costSamples.selected, costSamples.control);

  let status: SkillEffectivenessStatus;
  let basis: SkillEffectivenessReport["basis"];
  if (zeroSelectionAtHorizon) {
    status = "RETIRE-CANDIDATE";
    basis = "zero-selection";
  } else if (belowComparisonHorizon) {
    status = "INSUFFICIENT EVIDENCE";
    basis = "below-horizon";
  } else if (harmExcessPValue(selected, control) < SKILL_EFFECTIVENESS_HARM_ALPHA) {
    status = "RETIRE-CANDIDATE";
    basis = "named-harm-signal";
  } else if (costLowerBound !== null && costLowerBound > 0) {
    status = "RETIRE-CANDIDATE";
    basis = "costs-more-than-it-saves";
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
    settle_window_ms: settleWindowMs,
    cost_difference_lower_bound_usd: costLowerBound,
  };
}

const renderOutcomes = (outcomes: Record<string, number>): string => {
  const entries = Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "none" : entries.map(([outcome, count]) => `${outcome}=${count}`).join(", ");
};

/** A human-readable, read-only rendering.  It deliberately describes a comparison, not causation. */
export function renderSkillEffectivenessReport(report: SkillEffectivenessReport): string {
  const renderCohort = (name: string, cohort: SkillEffectivenessArm): string =>
    `${name}: observed_eligible_runs=${cohort.observed_eligible_runs}; terminal_runs=${cohort.terminal_runs}; ` +
    `merged_runs=${cohort.merged_runs}; harmful_terminal_runs=${cohort.harmful_terminal_runs}; ` +
    `pending_merge_runs=${cohort.pending_merge_runs}; not_merged_runs=${cohort.not_merged_runs}; ` +
    `costed_runs=${cohort.costed_runs}; cost_usd=${cohort.cost_usd.toFixed(2)}; ` +
    `cost_per_merged_pr=${cohort.cost_per_merged_pr === null ? "none" : cohort.cost_per_merged_pr.toFixed(2)}; ` +
    `outcomes=${renderOutcomes(cohort.outcomes)}`;
  return [
    `### rmd skill effectiveness — ${report.skill_name} (${report.task_type})`,
    `status: ${report.status}`,
    `basis: ${report.basis}`,
    `horizon: ${report.horizon} terminal selected eligible runs and ${report.horizon} terminal unselected eligible controls`,
    renderCohort("selected", report.selected),
    renderCohort("control", report.control),
    `named harm outcomes: ${report.harm_outcomes.join(", ")}`,
    `harm comparison: ${renderHarmComparison(report)}`,
    `cost comparison: ${renderCostComparison(report)}`,
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

/** The settle window and the cost bound a verdict rests on. */
function renderCostComparison(report: SkillEffectivenessReport): string {
  const bound = report.cost_difference_lower_bound_usd;
  return `settle window ${report.settle_window_ms === null ? "not derived" : `${report.settle_window_ms} ms`}; ` +
    `one-sided ${SKILL_COST_CONFIDENCE} lower bound of selected minus control cost per merged PR ` +
    `${bound === null ? "not compared" : `${bound.toFixed(2)} USD`}; a positive bound supports retirement`;
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
  /** A refused report removed this skill's staged retirement: the evidence it was staged on no longer qualifies. */
  withdrawn: boolean;
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
  return skillLifecycleEvidenceRefusal(report);
}

/** Why a report's evidence does not support a retirement, or undefined when it does. Staging and approval both
 *  judge with this one rule, so approval never accepts evidence staging would refuse. */
function skillLifecycleEvidenceRefusal(report: SkillEffectivenessReport): string | undefined {
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
    `Harm: ${renderHarmComparison(report)}`,
    `Cost: ${renderCostComparison(report)}`,
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
  if (!built.ok) {
    const withdrawn = withdrawSkillLifecycleProposal(registryPath, skillLifecycleProposalId(report.skill_name), opts);
    return { refused: true, staged: false, refreshed: false, alreadyStaged: false, withdrawn, reason: built.reason };
  }
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
    withdrawn: false,
    proposalId: proposal.id,
    evidenceFingerprint: proposal.lifecycleAction?.evidenceFingerprint,
    reason: alreadyStaged ? "already staged with identical evidence" : undefined,
  };
}

/** Remove a staged retirement the evidence no longer supports. Approval deletes a skill on the staged proposal, so
 *  one the ledger has turned against must not stay READY in the inbox. Reads before it locks, so a registry with
 *  nothing to withdraw is never written. True when a proposal was removed. */
export function withdrawSkillLifecycleProposal(registryPath: string, proposalId: string, opts: UpdateProposalRegistryOpts = {}): boolean {
  const staged = (p: Proposal): boolean => p.id === proposalId && p.lifecycleAction !== undefined;
  if (!loadProposalRegistry(registryPath).some(staged)) return false;
  let withdrawn = false;
  updateProposalRegistry(
    registryPath,
    (current) => {
      const next = current.filter((p) => !staged(p));
      withdrawn = next.length !== current.length;
      return withdrawn ? next : null;
    },
    opts,
  );
  return withdrawn;
}

/** Approval re-judges a staged retirement: `stale` names evidence that no longer qualifies, and `unverifiable` a
 *  ledger that could not be read whole. Neither is a pass, and only `stale` is grounds to withdraw the proposal. */
export type SkillRetirementRecheck =
  | { verdict: "qualifies" }
  | { verdict: "stale"; reason: string }
  | { verdict: "unverifiable"; reason: string };

/** A retirement is staged on the ledger as it stood then; more runs, or a corrected reducer, can since have turned
 *  the evidence. Re-judge with the reducer and rule staging used, over a COMPLETE union read. */
export function recheckSkillRetirement(
  stateDir: string,
  action: SkillLifecycleAction,
  read: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync,
): SkillRetirementRecheck {
  let union: ReturnType<typeof readLedgerUnionRecordsSync>;
  try {
    union = read(stateDir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true });
  } catch (error) {
    return { verdict: "unverifiable", reason: `unreadable ledger union under ${stateDir}: ${String(error)}` };
  }
  if (!union.ok) {
    return { verdict: "unverifiable", reason: `incomplete ledger union under ${stateDir}: ${union.unread.length} unread rotation(s)` };
  }
  const report = buildSkillEffectivenessReport(union.rows, action.skillName);
  const refusal = skillLifecycleEvidenceRefusal(report);
  if (refusal === undefined) return { verdict: "qualifies" };
  return { verdict: "stale", reason: `the evidence no longer supports retiring '${action.skillName}': ${report.status} (${report.basis}); ${refusal}` };
}

/**
 * Stage every draft the retro gathered, BEST-EFFORT: a throw on one draft must never fail the
 * retro, whose report is the thing the operator actually came for. Extracted as a seam for the
 * same reason as {@link skillsInjectedEvent} — the loop lived inside `retroCommand`, so its catch
 * arm was unreachable by any test and `diff-coverage` named nine of its lines.
 *
 * STAGING WRITES A PROPOSAL AND NOTHING ELSE. The operator still releases it with `rmd approve`,
 * and only that writes under `.claude/skills/` — so nothing here can put machine-authored text in
 * front of a worker. The log writes to the ledger beside `registryPath`.
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
      const list = typeof allowlist === "function" ? allowlist(draft) : allowlist;
      const r = stageOne(registryPath, draft, list, reachability(draft));
      const closed = r.refused &&
        closeSkillDraft(registryPath, skillDraftProposalId(draft.procedureKey), `withdrawn: ${r.reason}`, log, systemClock);
      const changed = r.staged || r.refreshed === true || r.backfilled === true || r.stamped === true || r.legacyReplaced === true;
      if (!changed && !closed) continue;
      log("skill.staged", { name: draft.name, staged: r.staged, already: r.alreadyStaged, backfilled: r.backfilled === true, refreshed: r.refreshed === true, refused: r.refused, closed, reason: r.reason });
    } catch (e) {
      log("skill.stage_failed", { name: draft.name, error: String((e as Error)?.message ?? e) });
    }
  }
}

// ── W1-T13859: an unanswered skill draft expires ────────────────────────────────────────────

/** The rows that answer a proposal, so a wait ends at the first of them. */
const SKILL_DRAFT_ANSWER_STEPS: readonly string[] = ["ratify.approved", "panel.proposal_declined"];
const SKILL_DRAFT_VERDICT_STEPS = [...SKILL_DRAFT_ANSWER_STEPS, "panel.proposal_restored"];
const DAY_MS = 86_400_000;

/** W1-T8825: the inbox's durable first-seen store, shared by the panel and the workshop. */
export function inboxFirstSeenPath(stateDir: string): string {
  return join(stateDir, "inbox-first-seen.json");
}

export function readInboxFirstSeen(stateDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(inboxFirstSeenPath(stateDir), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === "string" && Number.isFinite(Date.parse(at)))) as Record<string, string>;
  } catch {
    // deliberate: an absent or unreadable store supplies no measured waits.
    return {};
  }
}

/** Serialize expiry with operator decisions on this draft, including approval through its ledger receipt. */
export function withSkillDraftVerdictLock<T>(stateDir: string, proposalId: string | undefined, action: () => T): T {
  if (proposalId === undefined || !proposalId.startsWith(SKILL_DRAFT_ID_PREFIX)) return action();
  const lockId = `skill-draft-verdict-${createHash("sha256").update(proposalId).digest("hex")}`;
  mkdirSync(stateDir, { recursive: true });
  const release = tryAcquireRotationLock(inflightLockPath(stateDir, lockId), proposalId);
  if (release === null) throw new Error(`a verdict is in progress for ${proposalId}`);
  try {
    return action();
  } finally {
    release();
  }
}

/** `bound` is in ms; `sample` counts the answered proposals it was measured over. */
export type SkillDraftExpiryBound = { bound: number; sample: number } | { unmeasured: string };

type SkillDraftLedgerRows = LedgerUnionRecordRead["rows"];
type UnmeasuredSkillDraftLedger = { unmeasured: string; archivesUnreadable?: true };
type SkillDraftLedgerRead = { rows: SkillDraftLedgerRows; liveVersion: string } | UnmeasuredSkillDraftLedger;

function archiveVersion(path: string): string | undefined {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat && ledgerFileVersion(stat);
}

/**
 * Read the answer rows from a complete ledger union. Rotation and `rmd ledger-compact` move rows between
 * files while they hold the ledger rotation lock, so a read taken without the lock can finish between two
 * replacements and see neither copy of a row. This read holds that lock, and refuses while anyone else
 * holds it; the identity checks below still catch a writer that bypasses the lock.
 */
function readSkillDraftLedger(stateDir: string, step: readonly string[]): SkillDraftLedgerRead {
  const livePath = ledgerLivePath(stateDir);
  let release: (() => void) | null;
  try {
    release = tryAcquireRotationLock(ledgerRotationLockPath(livePath));
  } catch (error) {
    const reason = `incomplete ledger union: could not take the ledger rotation lock: ${String(error)}`;
    return { unmeasured: reason };
  }
  if (release === null) return { unmeasured: "incomplete ledger union: the ledger is being rotated or compacted" };
  try {
    return readLockedSkillDraftLedger(stateDir, livePath, step);
  } finally {
    release();
  }
}

function readLockedSkillDraftLedger(stateDir: string, livePath: string, step: readonly string[]): SkillDraftLedgerRead {
  const liveStat = () => statSync(livePath, { bigint: true, throwIfNoEntry: false });
  try {
    const before = liveStat();
    let unterminated = 0;
    let liveVersion: string | undefined;
    const versions = new Map<string, string | undefined>();
    const union = readLedgerUnionRecordsSync(stateDir, { step, refuseIncomplete: true }, {
      ...realLedgerFs,
      readdirSync: (dir) => {
        const names = realLedgerFs.readdirSync(dir);
        // Compaction can move a row between archives while keeping both filenames.
        for (const { path } of ledgerRotationEntries(names, dir)) versions.set(path, archiveVersion(path));
        return names;
      },
      readFileSync: (path) => {
        if (path !== livePath) return realLedgerFs.readFileSync(path);
        const stat = liveStat();
        liveVersion = stat && ledgerFileVersion(stat);
        const bytes = realLedgerFs.readFileSync(path);
        if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return bytes;
        // A short write can leave valid JSON, but the next append would join the two rows.
        unterminated = 1;
        return bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
      },
    });
    const torn = union.torn + unterminated;
    const incomplete = { unmeasured: `incomplete ledger union: ${union.unread.length} unread file(s), ${torn} torn row(s)` };
    if (torn > 0 || (!union.ok && (!union.liveFileRead || union.unread.includes(livePath)))) return incomplete;
    if (!union.liveFileRead) return { unmeasured: "incomplete ledger union: live ledger is missing" };

    // A writer that skips the lock can still publish or replace a file during the read.
    const archives = ledgerRotationEntries(realLedgerFs.readdirSync(stateDir), stateDir);
    const archivesChanged = archives.some(({ path }) => {
      const version = versions.get(path);
      return version === undefined || version !== archiveVersion(path);
    });
    const after = liveStat();
    if (before?.dev !== after?.dev || before?.ino !== after?.ino || archives.length !== union.archiveFiles.length ||
        archives.some(({ path }, index) => path !== union.archiveFiles[index])) {
      return { unmeasured: "incomplete ledger union: ledger rotated during read" };
    }
    if (archivesChanged) return { unmeasured: "incomplete ledger union: ledger archives changed during read" };
    if (liveVersion === undefined || after === undefined || liveVersion !== ledgerFileVersion(after)) {
      return { unmeasured: "incomplete ledger union: live ledger changed during read" };
    }
    return union.ok ? { rows: union.rows, liveVersion } : { ...incomplete, archivesUnreadable: true };
  } catch (error) {
    const reason = `incomplete ledger union: could not verify ledger files: ${String(error)}`;
    return { unmeasured: reason };
  }
}

/** The longest first-seen-to-first-answer wait from the complete ledger. */
export function skillDraftExpiryBound(stateDir: string): SkillDraftExpiryBound {
  const union = readSkillDraftLedger(stateDir, SKILL_DRAFT_ANSWER_STEPS);
  return "unmeasured" in union ? { unmeasured: union.unmeasured } : measureSkillDraftWaits(readInboxFirstSeen(stateDir), union.rows);
}

function measureSkillDraftWaits(firstSeen: Readonly<Record<string, string>>, rows: SkillDraftLedgerRows): SkillDraftExpiryBound {
  // The earliest stamp is backfilled, and workshop declines would feed the bound back into itself.
  const earliest = Object.values(firstSeen).reduce((min, at) => Math.min(min, Date.parse(at)), Infinity);
  const firstAnswer = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.task_id !== "string" || typeof row.ts !== "string" || !SKILL_DRAFT_ANSWER_STEPS.includes(String(row.step))) continue;
    if (row.origin === SKILL_WORKSHOP_ORIGIN || !Object.hasOwn(firstSeen, row.task_id)) continue;
    const seenMs = Date.parse(firstSeen[row.task_id]!);
    const at = Date.parse(row.ts);
    if (seenMs === earliest || !Number.isFinite(at) || at < seenMs) continue;
    const prior = firstAnswer.get(row.task_id);
    if (prior === undefined || at < prior) firstAnswer.set(row.task_id, at);
  }
  if (firstAnswer.size === 0) return { unmeasured: "no answered proposal has a measured wait" };
  let bound = 0;
  for (const [id, at] of firstAnswer) bound = Math.max(bound, at - Date.parse(firstSeen[id]!));
  return { bound, sample: firstAnswer.size };
}

function skillDraftVerdicts(rows: SkillDraftLedgerRows): ReturnType<typeof ledgerProposalVerdicts> {
  const receipts: VerdictReceipt[] = [];
  const unordered: SkillDraftLedgerRows = [];
  for (const row of rows) {
    const receipt = verdictReceiptOf(row);
    if (receipt) receipts.push(receipt);
    // An undated restore cannot establish that it came after a decline.
    else if (row.step !== "panel.proposal_restored") unordered.push(row);
  }
  return ledgerProposalVerdicts([...mergeVerdictReceipts(receipts), ...unordered]);
}

/** Restore can need an archived expiry receipt before the slow lane has retained it. */
export function readSkillDraftVerdicts(stateDir: string): ReturnType<typeof skillDraftVerdicts> | UnmeasuredSkillDraftLedger {
  const union = readSkillDraftLedger(stateDir, SKILL_DRAFT_VERDICT_STEPS);
  return "unmeasured" in union ? union : skillDraftVerdicts(union.rows);
}

/** Called after checking the current verdict. A restore can outlive a failed close-record write. */
function hasSkillDraftExpiryReceipt(proposal: Proposal, rows: SkillDraftLedgerRows): boolean {
  const skillSha256 = storedSkillSha256(proposal);
  return rows.some((row) => row.task_id === proposal.id && row.step === "panel.proposal_declined" &&
    row.origin === SKILL_WORKSHOP_ORIGIN && typeof row.reason === "string" && row.reason.startsWith("expired:") &&
    row.skill_draft_sha256 === skillSha256);
}

/** One expiry pass: the ids it closed, and a line the retro prints. */
export interface SkillDraftExpiryPass {
  expired: string[];
  reason: string;
}

export function reportSkillDraftExpiry(
  expire: () => SkillDraftExpiryPass,
  log: (step: string, extra?: Record<string, unknown>) => void,
  say: (message: string) => void,
): void {
  try {
    say(`skill drafts: ${expire().reason}`);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    try {
      log("skill.expire_failed", { error: message });
    } catch (logError) {
      say(`skill.expire_failed: ${message} (writing the failure to the ledger also failed: ${String(logError)})`);
    }
  }
}

/**
 * Close, once, each staged skill draft that nobody answered and that has waited longer than any answered
 * proposal waited. It uses the W1-T13858 close, so it writes only the decline row and the close record;
 * `rmd restore` reopens the draft, and nothing writes under .claude/skills/. With no complete ledger or no
 * sample, nothing expires.
 */
export function expireUnansweredSkillDrafts(
  registryPath: string,
  stateDir: string,
  log: SkillDraftLog,
  clock: Pick<Clock, "iso" | "now">,
): SkillDraftExpiryPass {
  const firstSeen = readInboxFirstSeen(stateDir);
  const readMeasuredLedger = () => {
    const union = readSkillDraftLedger(stateDir, SKILL_DRAFT_VERDICT_STEPS);
    if ("unmeasured" in union) return union;
    const measured = measureSkillDraftWaits(firstSeen, union.rows);
    return "unmeasured" in measured ? measured : { ...measured, ...union };
  };
  let measured = readMeasuredLedger();
  if ("unmeasured" in measured) return { expired: [], reason: `no skill draft expires: ${measured.unmeasured}` };
  const rows = measured.rows;
  const verdicts = skillDraftVerdicts(rows);
  const now = clock.now();
  const days = (ms: number): string => (ms / DAY_MS).toFixed(2);
  const expired: string[] = [];
  for (const proposal of loadProposalRegistry(registryPath)) {
    if (!proposal.id.startsWith(SKILL_DRAFT_ID_PREFIX) || !proposal.skillFile) continue;
    if (verdicts.isRatified(proposal.id) || verdicts.isDeclined(proposal.id) !== undefined || workshopClosedSkillDraft(proposal)) continue;
    const age = now - Date.parse(firstSeen[proposal.id] ?? "");
    if (!(age > measured.bound) || hasSkillDraftExpiryReceipt(proposal, rows)) continue;
    try {
      const closed = withSkillDraftVerdictLock(stateDir, proposal.id, () =>
        closeSkillDraft(registryPath, proposal.id, (entry) => {
          if (!entry.skillFile) return undefined;
          // Re-read under both locks. An answer may have landed since the pass began and extended the bound.
          measured = readMeasuredLedger();
          if ("unmeasured" in measured || age <= measured.bound) return undefined;
          const currentVerdicts = skillDraftVerdicts(measured.rows);
          if (currentVerdicts.isRatified(entry.id) || currentVerdicts.isDeclined(entry.id) !== undefined) return undefined;
          if (hasSkillDraftExpiryReceipt(entry, measured.rows)) return undefined;
          return {
            reason: `expired: unanswered for ${days(age)} days; the longest wait of any answered proposal is ` +
              `${days(measured.bound)} days (${measured.sample} answered)`,
            liveVersion: measured.liveVersion,
          };
        }, log, clock));
      if (closed) expired.push(proposal.id);
    } catch (error) {
      if (!(error instanceof LedgerAppendConflict)) throw error;
      return { expired, reason: `skill draft expiry stopped: incomplete ledger union: ${error.message}` };
    }
    if ("unmeasured" in measured) return { expired, reason: `skill draft expiry stopped: ${measured.unmeasured}` };
  }
  return { expired, reason: `${expired.length} skill draft(s) expired; the bound is ${days(measured.bound)} days over ${measured.sample} answered proposal(s)` };
}
