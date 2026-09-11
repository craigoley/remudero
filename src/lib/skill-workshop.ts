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
import { updateProposalRegistry, type UpdateProposalRegistryOpts } from "./inbox.js";
import type { Task } from "./plan.js";

/** The fields {@link renderSkillDraft} reads off a mined procedural candidate — see this module's
 *  header for why this duplicates retro.ts's `ProceduralCandidate` rather than importing it. */
export interface ProceduralCandidateLike {
  shapeKey: string;
  taskType: string;
  signals: string[];
  runIds: string[];
  taskIds: string[];
  supportingRuns: number;
}

/** Canonical step text per {@link import("./retro.js").PROCEDURAL_SUCCESS_SIGNALS} key. A signal
 *  key absent here (a caller-supplied signal, Rule 2 — the signal set is DATA) still renders: the
 *  raw key stands in for its own step rather than being silently dropped. */
export const PROCEDURAL_STEP_TEXT: Readonly<Record<string, string>> = {
  clean_single_strike: "Resolve the task on the first attempt — land a fix that needs no `fix.dispatch` rung.",
  fully_executed_proof: "Execute every acceptance criterion as a real, observed proof — never let the keyword floor stand in for a run.",
};

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

/** One drafted skill: the rendered SKILL.md text plus the fields a scanner/stager needs without
 *  re-parsing markdown. `candidateHash` is the dedup key {@link stageSkillDraft} keys off. */
export interface SkillDraft {
  name: string;
  description: string;
  markdown: string;
  candidateHash: string;
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

/**
 * Render one procedural candidate as a Claude Code skill draft (design clause i). `undefined` for
 * a candidate under the two-run floor: {@link import("./retro.js").mineProceduralCandidates}
 * already enforces this threshold, but a caller handing this function a single-run candidate
 * directly (a test, or a future caller that skips mining) must get NOTHING rather than an
 * anecdote dressed as a proven procedure.
 */
export function renderSkillDraft(candidate: ProceduralCandidateLike): SkillDraft | undefined {
  if (candidate.supportingRuns < 2) return undefined;
  const hash = proceduralCandidateHash(candidate);
  const name = `${kebabSlug(candidate.shapeKey)}-${hash.slice(0, 8)}`;
  const description = `A procedure shape proven across ${candidate.supportingRuns} merged ${candidate.taskType} run(s): ${candidate.signals.join(" + ")}.`;
  const appliesTo = injectableSkillTaskType(candidate.taskType);
  const steps = candidate.signals.map((key) => `- ${PROCEDURAL_STEP_TEXT[key] ?? key}`);
  const evidence = [
    ...candidate.runIds.map((runId) => `- [src: run#${runId}]`),
    `- Filed under: ${candidate.taskIds.join(", ")}`,
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
    "",
    "## Evidence",
    "",
    ...evidence,
  ].join("\n");
  return { name, description, markdown, candidateHash: hash };
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

/**
 * Refuse a draft that names a host, path or tool outside `allowlist`, or a line the untrusted
 * envelope would fence as an instruction rather than a procedure step. Scans `draft.markdown`
 * line by line and returns on the FIRST offence, named, so a refusal is always attributable.
 */
export function scanSkillDraft(draft: SkillDraft, allowlist: WorkerAllowlist): SkillDraftScanResult {
  const deniedPatterns = allowlist.deniedPathPatterns.map(globToRegExp);
  for (const line of draft.markdown.split("\n")) {
    const hostMatch = line.match(/https?:\/\/([a-zA-Z0-9.-]+)/);
    if (hostMatch && !allowlist.allowedHosts.includes(hostMatch[1])) {
      return { ok: false, offendingLine: line, reason: `names host '${hostMatch[1]}' outside the worker allowlist` };
    }
    for (const pattern of deniedPatterns) {
      if (pattern.test(line)) {
        return { ok: false, offendingLine: line, reason: `names a path the worker's deny-floor already refuses ('${pattern.source}')` };
      }
    }
    const toolMatch = line.match(new RegExp(`\\b(${KNOWN_TOOL_NAMES.join("|")})\\b`));
    if (toolMatch && !allowlist.allowedTools.some((t) => t.includes(toolMatch[1]))) {
      return { ok: false, offendingLine: line, reason: `names tool '${toolMatch[1]}' outside the worker allowlist` };
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

/** Deterministic proposal id for a drafted skill — derived from {@link SkillDraft.candidateHash},
 *  never random, so re-staging the SAME candidate names the SAME proposal. */
export function skillDraftProposalId(candidateHash: string): string {
  return `skill-draft:${candidateHash}`;
}

/** One {@link stageSkillDraft} call's outcome. `refused` means the scanner rejected the draft and
 *  nothing was staged; `alreadyStaged` means a prior call already staged this exact candidate. */
export interface StageSkillDraftResult {
  refused: boolean;
  staged: boolean;
  alreadyStaged: boolean;
  reason?: string;
}

/**
 * Scan `draft`, and — only when it passes — stage it as ONE inbox proposal carrying the SKILL.md
 * text, its evidence, and `reachability`'s verdict on whether a worker can load it today. Never
 * writes under `.claude/skills/`: that write happens only once `rmd approve` ratifies the staged
 * proposal into a plan PR (design clause iii). Idempotent by `draft.candidateHash` — a re-run
 * staging the same candidate is reported `alreadyStaged`, never duplicated (W1-T470).
 */
export function stageSkillDraft(
  registryPath: string,
  draft: SkillDraft,
  allowlist: WorkerAllowlist,
  reachability: { reachable: boolean; reason: string },
  opts: UpdateProposalRegistryOpts = {},
): StageSkillDraftResult {
  const scan = scanSkillDraft(draft, allowlist);
  if (!scan.ok) {
    return { refused: true, staged: false, alreadyStaged: false, reason: `${scan.reason} (offending line: "${scan.offendingLine}")` };
  }
  const id = skillDraftProposalId(draft.candidateHash);
  let staged = false;
  let alreadyStaged = false;
  updateProposalRegistry(
    registryPath,
    (current) => {
      staged = false;
      alreadyStaged = false;
      if (current.some((p) => p.id === id)) {
        alreadyStaged = true;
        return null; // already staged — never a duplicate write
      }
      const reachabilityLine = reachability.reachable
        ? `Reachable: ${reachability.reason}`
        : `NOT reachable by a worker today: ${reachability.reason}`;
      const summary =
        `${draft.markdown}\n\n---\n\n${reachabilityLine}\n\n` +
        `Approving this proposal drafts a plan PR that writes '.claude/skills/${draft.name}/SKILL.md' — ` +
        `nothing writes under .claude/skills/ outside that PR.`;
      staged = true;
      return [...current, { id, summary, evidenceAnchors: [] }];
    },
    opts,
  );
  return { refused: false, staged, alreadyStaged, reason: alreadyStaged ? "already staged" : undefined };
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
  /** The body below the frontmatter — what a worker actually reads. */
  body: string;
}

/** Split `---`-delimited frontmatter from the body. A file with no frontmatter has no `applies-to`
 *  and is therefore never injectable, which is the safe direction for an unrecognised shape. */
function splitFrontmatter(text: string): { front: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: "", body: text };
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
    out.push({ name, appliesTo, body: body.trim() });
  }
  return out;
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
): InjectableSkill[] {
  const want = taskType.toLowerCase();
  const out: InjectableSkill[] = [];
  let spent = 0;
  for (const s of skills) {
    if (!s.appliesTo.includes(want)) continue;
    const cost = s.body.length;
    if (spent + cost > budgetChars) continue;
    out.push(s);
    spent += cost;
  }
  return out;
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
  allowlist: WorkerAllowlist,
  reachability: { reachable: boolean; reason: string },
  log: (step: string, extra?: Record<string, unknown>) => void,
  stageOne: typeof stageSkillDraft = stageSkillDraft,
): void {
  for (const draft of drafts) {
    try {
      const r = stageOne(registryPath, draft, allowlist, reachability);
      log("skill.staged", { name: draft.name, staged: r.staged, already: r.alreadyStaged, refused: r.refused, reason: r.reason });
    } catch (e) {
      log("skill.stage_failed", { name: draft.name, error: String((e as Error)?.message ?? e) });
    }
  }
}
