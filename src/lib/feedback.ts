import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { landFeedback, landFeedbackStatusContent, type LandFeedbackOpts } from "./feedback-landing.js";
import type { Mount, Mounts } from "./mounts.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/**
 * `plan/feedback/` — the durable, diffable feedback inbox (MASTER-PLAN §7B, W1-T40).
 *
 * "Today the harness has no front door: every piece of operator feedback goes chat with an
 * external Architect... FEEDBACK IS AN ARTIFACT, NOT A COMMAND. `plan/feedback/` is a durable,
 * diffable inbox — one entry per item: `{id, ts, raw text, attachments[] (multimodal —
 * screenshots, terminal dumps, links), origin: cli|ui|issue, status:
 * new|grilling|proposed|accepted|rejected, proposal_pr}`. Captured async by `rmd feedback`
 * (W1-T40); never lost in a chat scrollback." [MASTER-PLAN §7B]
 *
 * This module's WRITE is plain filesystem I/O, no network, no LLM call — `rmd feedback`
 * always returns instantly and always works offline; that promise never changes. What DOES
 * follow the write, since W1-T243, is a best-effort attempt to LAND the entry onto
 * `origin/main` (see {@link "./feedback-landing.js".landFeedback}) — without it, `rmd triage`
 * (which deliberately reads from a fresh `origin/main` worktree, never a possibly-stale
 * `repoRoot`) could never see a freshly captured entry until a human hand-landed it via a
 * manual `git add`+commit+PR. Landing is swallowed on any failure (offline, no `gh`, no
 * network) — the local write already IS the durable buffer; landing merely gets the entry to
 * `origin/main` sooner. The INTAKE LOOP that reads this inbox and moves entries through
 * `grilling`/`proposed` (`rmd triage`, W1-T41) is a separate task; this module exposes
 * {@link setFeedbackStatus} as the write primitive that worker will call, but ships no CLI
 * surface for it — the inbox itself is browsable with plain `ls`/`cat`/`git diff` on
 * `plan/feedback/*.yaml`, which is the point of "diffable" (no bespoke reader required).
 *
 * ONE FILE PER ENTRY (not one big YAML list): matches "one entry per item" literally, and keeps
 * concurrent captures (an operator and the daemon both running `rmd feedback` at once) from
 * racing on a shared file — each entry only ever touches its own path.
 *
 * IMAGE ATTACHMENTS ARE WORKER-READABLE — VERIFIED, not assumed (LEARNINGS.md "Agent SDK tools &
 * the feedback front door"): a probe captured an entry with `--attach <png>`, then opened the
 * copied `plan/feedback/attachments/<id>/…` file with the Read tool and got back an accurate
 * description of its shapes/colors/text — confirming a triage worker (W1-T41) can act on a
 * screenshot attachment directly, with no OCR/vision wiring needed on this module's side; a
 * "terminal dump" attachment is plain text and needed no such probe.
 */

/** Where feedback originated — a closed enum per the §7B schema (human capture methods). */
export const FEEDBACK_ORIGINS = ["cli", "ui", "issue"] as const;
export type NamedFeedbackOrigin = (typeof FEEDBACK_ORIGINS)[number];

/**
 * `FeedbackOrigin` is the named closed enum above PLUS `issue#<n>`, `alert#<id>` and
 * `repair#<surface>` — machine-origin provenance for one specific managed-repo GitHub issue
 * (W1-T57), one specific GitHub alert (code-scanning/Dependabot/secret-scanning; W1-T56,
 * MASTER-PLAN §5D/§7B: "machine-origin feedback... flows through the §7B feedback inbox
 * (`origin: alert#<id>` / `origin: issue#<n>`)"), or one classified `sweep.disposed` surface
 * that RECURRED at or above policy threshold (W1-T905, "repair the instance, file the class" —
 * fb-1784842083584-6cc22a's second half: `src/lib/sweep.ts`'s `dueRepairFilings`, wired via
 * `SweepDeps.captureRepairFeedback` in `src/run-task.ts`'s `buildSweepEffects`). This is a
 * DIFFERENT axis than the named enum's "issue" value (a human capturing feedback that
 * references remudero's own tracker) — `issue#<n>`/`alert#<id>`/`repair#<surface>` instead name
 * WHICH managed-repo issue, alert, or classified surface produced this entry, so `rmd trace`
 * (W1-T43) can point straight back at it.
 */
export type FeedbackOrigin = NamedFeedbackOrigin | `issue#${number}` | `alert#${string}` | `repair#${string}`;

const MACHINE_ORIGIN_ISSUE = /^issue#\d+$/;
/** `alert#<source>-<id>` — source is one of ops.ts's three ALERT_SOURCES, id is that source's own alert number. */
const MACHINE_ORIGIN_ALERT = /^alert#(code-scanning|dependabot|secret-scanning)-.+$/;
/** `repair#<surface>` (W1-T905) — surface is a `sweep.disposed` row's own `disposition` value
 *  (`DISPOSITION_RULES`, src/lib/sweep.ts — e.g. `blocked-fixable`, `stale`), always
 *  lower-kebab-case, never invented text: the SAME closed grammar every disposition already is. */
const MACHINE_ORIGIN_REPAIR = /^repair#[a-z][a-z-]*$/;

/**
 * True for any valid {@link FeedbackOrigin} — the named enum, a well-formed `issue#<n>`, a
 * well-formed `alert#<source>-<id>`, or a well-formed `repair#<surface>`.
 */
export function isValidFeedbackOrigin(origin: string): origin is FeedbackOrigin {
  return (
    (FEEDBACK_ORIGINS as readonly string[]).includes(origin) ||
    MACHINE_ORIGIN_ISSUE.test(origin) ||
    MACHINE_ORIGIN_ALERT.test(origin) ||
    MACHINE_ORIGIN_REPAIR.test(origin)
  );
}

/**
 * The status lifecycle a feedback entry moves through (§7B: capture -> triage -> gate), PLUS
 * `answered` (W1-T2278): the state a `grilling` entry advances to the moment a `replyTo` names
 * it and that reply is captured. This is a SEPARATE arm from the triage lifecycle's own
 * `grilling` -> `proposed` advance (a grill answer is not itself a proposal) — both are reachable
 * from `grilling`, and {@link setFeedbackStatus}'s own contract already leaves "which transition
 * is legal" to the caller, not to this list. `answered` is a genuine CLOSED state for the
 * question/answer exchange: once set, a second `replyTo` naming the same entry is refused for
 * exactly the same reason a `proposed`/`accepted`/`rejected` target already is (not parked at
 * `grilling`) — see `buildSubmitFeedbackRoute` in panel-graph.ts, the only place this status is
 * ever written, and always because an operator's own reply text just arrived, never on a timer
 * or a scheduler (W1-T2244 pins (ix)/(x): nothing here manufactures a decision on the operator's
 * behalf).
 */
export const FEEDBACK_STATUSES = ["new", "grilling", "proposed", "accepted", "rejected", "answered"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** One `plan/feedback/<id>.yaml` entry — the exact §7B schema shape. */
export interface FeedbackEntry {
  id: string;
  ts: string;
  raw: string;
  attachments: string[];
  origin: FeedbackOrigin;
  status: FeedbackStatus;
  /**
   * The id of the `grilling` entry THIS entry answers, when this entry was captured via
   * `POST /v1/feedback`'s `replyTo` (W1-T2278) — carried as a FIELD on the record, the same way
   * every other edge on this entry (`proposal_pr`, `upstream.pr_url`) is a field rather than
   * prose folded into `raw`. `null` for a submission carrying no reply reference — the
   * unchanged, pre-W1-T2278 shape. Set ONCE at capture time and never revised afterward: an
   * answer never gets re-parented. Optional (like `summary`/`expansion`/`upstream` below) so
   * every FeedbackEntry fixture predating this task stays a valid literal with no edit required;
   * a written-by-{@link captureFeedback} entry always carries it explicitly (`null` when absent),
   * never `undefined`.
   */
  reply_to?: string | null;
  /**
   * The id of the entry that answered THIS one — the reverse edge of `reply_to` (W1-T2278), so a
   * thread is enumerable from the ANSWERED end too, not only by reading a reply's own
   * `reply_to`. Set exactly once, by {@link setFeedbackStatus} in the same call that advances
   * this entry to `status: "answered"`; `null`/absent otherwise (every entry never replied to,
   * which is every entry captured before this task and every entry that is not itself parked
   * `grilling` and answered).
   */
  answered_by?: string | null;
  /** Set once `rmd triage` (W1-T41) opens a proposal PR for this entry; null until then. */
  proposal_pr: string | null;
  /**
   * A machine-written plain-language decision card, generated ONCE when this entry is set to
   * `status: proposed` (see {@link proposeFeedbackWithSummary}) and cached here thereafter — a
   * console render NEVER invokes the summarizer (W1-T313). `null` until proposed, or when a
   * summarizer failed/was unavailable/returned a record that failed
   * {@link validateDecisionSummary}: the raw `raw` text above stays byte-identical and
   * renderable either way — fail-open, never lossy (MASTER-PLAN §7B amendment; the entry shape
   * gains this ONE field, every existing consumer of the other fields is untouched).
   */
  summary?: DecisionSummary | null;
  /**
   * The four-section CLAIM/EVIDENCE/RECON/FALSIFYING CHECK expansion of `raw` (W1-T350),
   * generated at PREVIEW time (before this entry ever existed) and attached at capture — never
   * regenerated on render, exactly `summary`'s own discipline above. `undefined`/`null` for
   * every entry captured without a preview (the CLI, machine-origin intake, or the console's
   * own file-raw escape) — `raw` stays byte-identical and renderable either way.
   */
  expansion?: FeedbackExpansion | null;
  /**
   * Present ONLY when a home-repo pointer (W1-T397, `.remudero/home-repo.json`) is configured
   * AND this checkout is not itself the home repo — the no-pointer case and the
   * local-checkout-IS-home case both leave this key ABSENT, so the entry stays byte-identical
   * to a pre-W1-T397 capture either way (design point iv: upstreaming a self-target must be a
   * true no-op). `status: "landed"` once a PR against the home repo carries this entry;
   * `"unreachable"` when the attempt failed for any reason (network, `gh`, or even a
   * malformed pointer file) — the entry is captured LOCALLY either way, never dropped, and
   * `error` names why so a failure is greppable straight out of the entry file.
   */
  upstream?: {
    /** "owner/repo" of the configured home repo. */
    home: string;
    status: "landed" | "unreachable";
    pr_url?: string;
    error?: string;
  };
  /**
   * W1-T2302: the console-minted per-submission key `POST /v1/feedback` carried on this
   * capture, when the caller supplied one — the identity a REPEAT of this exact submission (a
   * reload, a second tab, a retried fetch) is recognised BY, distinct from `id` (a fresh id is
   * still minted every capture; this is a separate field precisely because re-using `id` for
   * dedup would OVERWRITE the entry, see {@link captureFeedback}'s doc). A DURABLE field on the
   * entry rather than a second store: readable by the same {@link listFeedback} every other
   * caller already runs, survives a daemon restart, and needs nothing new to go stale. `null`/
   * absent for every entry captured without one (the CLI, machine-origin intake, or a console
   * call that predates this task) — `raw` and every other field stay byte-identical either way.
   */
  submission_key?: string | null;
  /**
   * W1-T2496: the escalation thread id (`inbox-thread.ts`'s {@link deriveThreadId}) this entry
   * REPLIES TO, when captured via `POST /v1/escalation/reply` (panel-actions.ts). This is a
   * DIFFERENT edge than `reply_to` above — `reply_to` names another `plan/feedback/<id>.yaml`
   * entry parked `grilling` (the W1-T2278 grill-answer flow); `thread_id` names a thread in
   * `inbox-thread.ts`'s own JSONL store, which an ESCALATION (`escalate.ts`, never a feedback
   * entry) opened. Carrying it as a field — not folded into `raw` prose — is what makes this
   * entry findable by thread the same way `rmd trace`/a future console can already find one by
   * `reply_to`/`submission_key`: a plain field scan, no bespoke parser. `null`/absent for every
   * entry captured without one (every caller predating this task, and every entry this task's
   * own route does not touch) — `raw` and every other field stay byte-identical either way.
   */
  thread_id?: string | null;
}

// ── Decision summaries (W1-T313) ─────────────────────────────────────────────
//
// "every decision surface renders raw triage-architect analysis" (operator directive,
// fb-1784770111145-cf7c24): a triage proposal and an escalation both carry engineering prose
// written for a machine/plan reader, not the console the operator actually rules from. A
// DecisionSummary is a small, STRUCTURED record — never a blob of prose — so a renderer can
// lay it out and {@link validateDecisionSummary} can bound it before anything trusts it.
// Written ONCE at creation time by the producer (a feedback proposal here, an escalation in
// escalate.ts) and cached with the artifact; a render path NEVER calls the summarizer again.

/** One labelled choice inside a {@link DecisionSummary} — `consequence` is ONE LINE (no
 *  newline), so the console renders it as a single list item with no wrapping surprise. */
export interface DecisionSummaryOption {
  label: string;
  consequence: string;
}

/**
 * A machine-written, plain-language decision card. `headline`/`what_happened`/`decision` are
 * free text (bounded by {@link validateDecisionSummary}); `options` is 2-3 labelled choices —
 * for an escalation these are the escalation's OWN options passed through verbatim (see
 * escalate.ts's `summarizeEscalation`), never a paraphrase the model might invent.
 */
export interface DecisionSummary {
  /** <=15 words — the one-line hook a busy operator reads first. */
  headline: string;
  /** 1-2 sentences of plain-language context: what happened. */
  what_happened: string;
  /** Stated IMPERATIVELY — an instruction, never a question — what the operator should do. */
  decision: string;
  /** 2-3 labelled choices, each with a one-line consequence. */
  options: DecisionSummaryOption[];
}

const DECISION_SUMMARY_MAX_HEADLINE_WORDS = 15;
const DECISION_SUMMARY_MIN_OPTIONS = 2;
const DECISION_SUMMARY_MAX_OPTIONS = 3;

function isBoundedString(x: unknown, maxLen: number): x is string {
  return typeof x === "string" && x.trim().length > 0 && x.length <= maxLen;
}

function isValidDecisionSummaryOptionShape(x: unknown): x is DecisionSummaryOption {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return isBoundedString(o.label, 80) && isBoundedString(o.consequence, 240) && !(o.consequence as string).includes("\n");
}

/**
 * Validate an UNTRUSTED value (a raw summarizer response, or a value read back off disk)
 * against the {@link DecisionSummary} bounds — headline <=15 words, a non-empty
 * `what_happened`, a non-interrogative `decision`, and 2-3 options each with a one-line
 * consequence. Returns `null` on ANY violation rather than throwing: this is the fail-open
 * gate every producer/consumer in this task routes a summary through (W1-T313 acceptance:
 * "validated against those bounds rather than stored as free prose"). Trims whitespace on the
 * way out so a validated summary is always render-ready.
 */
export function validateDecisionSummary(x: unknown): DecisionSummary | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!isBoundedString(o.headline, 200)) return null;
  const headline = (o.headline as string).trim();
  if (headline.split(/\s+/).length > DECISION_SUMMARY_MAX_HEADLINE_WORDS) return null;
  if (!isBoundedString(o.what_happened, 600)) return null;
  if (!isBoundedString(o.decision, 300)) return null;
  const decision = (o.decision as string).trim();
  if (decision.endsWith("?")) return null; // an imperative is a directive, never a question
  if (!Array.isArray(o.options)) return null;
  if (o.options.length < DECISION_SUMMARY_MIN_OPTIONS || o.options.length > DECISION_SUMMARY_MAX_OPTIONS) return null;
  if (!o.options.every(isValidDecisionSummaryOptionShape)) return null;
  const options = (o.options as DecisionSummaryOption[]).map((opt) => ({
    label: opt.label.trim(),
    consequence: opt.consequence.trim(),
  }));
  return { headline, what_happened: (o.what_happened as string).trim(), decision, options };
}

/** What a decision-summary rung reads to write its plain-language card — free-text CONTEXT
 *  only, never a live artifact reference, so {@link SummarizeDeps.summarize} is reusable
 *  across every producer (a feedback proposal here, an escalation in escalate.ts) with no
 *  producer-shaped branching inside the deps contract itself. */
export interface SummarizeInput {
  context: string;
}

/**
 * Injected decision-summary dependency (mirrors retro.ts's `ProceduralPhraseDeps`/
 * learnings.ts's `PromotionJudgeDeps.judge` shape): receives ONLY the already-assembled
 * {@link SummarizeInput}, returns an UNTRUSTED value this module validates before ever
 * trusting it. Real callers wire {@link realDecisionSummarizer}; tests inject a canned return
 * (or a throw) so every criterion is assertable with no network and no model call (W1-T313).
 */
export interface SummarizeDeps {
  summarize: (input: SummarizeInput) => unknown | Promise<unknown>;
}

/**
 * Summarize ONE feedback proposal into a {@link DecisionSummary}, FAIL-OPEN: a throw, a
 * rejected promise, or a response that fails {@link validateDecisionSummary} all resolve to
 * `null` — never propagate — so a summarizer outage can never block a triage proposal from
 * writing (W1-T313 acceptance: "never blocks capture, triage, escalation or a status
 * transition").
 */
export async function summarizeFeedbackProposal(
  entry: Pick<FeedbackEntry, "raw">,
  deps: SummarizeDeps,
): Promise<DecisionSummary | null> {
  try {
    const out = await deps.summarize({ context: entry.raw });
    return validateDecisionSummary(out);
  } catch {
    return null;
  }
}

// ── Real decision-summary rung — routed via mounts.yaml, never a hard-coded model id ────────
//
// Mirrors risk-judge.ts's testable split exactly: a pure prompt builder + a pure spawn-args
// builder are unit-tested; the actual spawn ({@link realDecisionSummarizer}) is untested by
// unit, like every other real spawn in worker.ts — {@link buildDecisionSummaryPrompt} and
// {@link validateDecisionSummary} carry the testable contract.
//
// {@link resolveDecisionSummaryMount} reuses risk-judge.ts's `resolveRiskJudgeMount` rather
// than adding a new mounts.yaml row: it already scans the WHOLE routing table for the
// cheapest configured tier with no hardcoded model name — exactly "the cheapest correct host"
// the design calls for, and a decision summary is the same shape of cheap, structured,
// no-tool judgment call the risk judge already is (VERIFIED at source before reuse, per this
// task's own design note).

export function buildDecisionSummaryPrompt(input: SummarizeInput): string {
  return [
    "You are writing a PLAIN-LANGUAGE decision-card summary for an operator who must RULE on",
    "the item below, not read engineering prose. Respond with ONLY a JSON object — no prose,",
    "no markdown fence — shaped EXACTLY:",
    '{"headline": string (<=15 words), "what_happened": string (1-2 sentences),',
    ' "decision": string (an IMPERATIVE instruction, never a question),',
    ' "options": [{"label": string, "consequence": string (one line)}, ...] (2-3 entries)}',
    "",
    "ITEM:",
    input.context,
  ].join("\n");
}

/** Build the real spawn args for a decision-summary rung — pure, so the "no write tool,
 *  cheapest mount" contract is unit-testable with no spawn (mirrors risk-judge.ts's
 *  `buildRiskJudgeSpawnArgs`). */
export function buildDecisionSummarySpawnArgs(opts: {
  input: SummarizeInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildDecisionSummaryPrompt(opts.input),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: [], // everything it needs is in the prompt — no exploration, mirrors RISK_JUDGE_TOOLS
  };
}

/** Wire a real {@link SummarizeDeps.summarize} to an actual worker spawn — the production
 *  wiring for {@link summarizeFeedbackProposal} and escalate.ts's `summarizeEscalation`.
 *  Untested by unit (it shells out via the SDK, same as every other real spawn in worker.ts). */
export function realDecisionSummarizer(opts: {
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (input: SummarizeInput) => Promise<unknown> {
  const spawn = opts.spawn ?? spawnWorker;
  return async (input: SummarizeInput) => {
    const result: WorkerResult = await spawn(
      buildDecisionSummarySpawnArgs({ input, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile }),
    );
    const match = /\{[\s\S]*\}/.exec(result.text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  };
}

/** The cheapest configured mount for a decision-summary rung — see the section doc above for
 *  why this reuses risk-judge.ts's scanner rather than adding a new mounts.yaml row. */
export function resolveDecisionSummaryMount(mounts: Mounts): Mount {
  return resolveRiskJudgeMount(mounts);
}

// ── Feedback expansions (W1-T350) ────────────────────────────────────────────
//
// "Whenever I submit feedback in the console, it probably needs to go through an interpreter —
// that will translate my simple feedback into an actual prompt that can be sent to the agent"
// (operator directive, oper#needs-me-filings-2026-08-04). The precedent corpus (14 feedback
// entries landed 2026-08-03/04) writes an ALL-CAPS falsifiable headline, measured evidence with
// verbatim figures/symbols/PR numbers, then two literal markers — "RECON:" and "Falsifying
// check:" — naming what a downstream pass must establish and what would retire the entry. A
// FeedbackExpansion is that skeleton as FOUR NAMED, independently-validated fields — never raw
// prose with embedded markers a reader has to parse back out — mirroring DecisionSummary's own
// "a validator can check" discipline above. `evidence` and `recon` may legitimately be EMPTY:
// the honesty constraint is that a specific the operator did not verify belongs under `recon`
// as a directive, never invented into `evidence` as a stated fact — a short operator note may
// carry no measured evidence at all.

/** One `plan/feedback/<id>.yaml` entry's four-section expansion (CLAIM / EVIDENCE / RECON /
 *  FALSIFYING CHECK) — machine-written ONCE at preview time, never regenerated on render. */
export interface FeedbackExpansion {
  /** A falsifiable, plain-language headline of what the operator is telling us. */
  claim: string;
  /** ONLY measured/verbatim specifics the operator actually stated; "" if none. */
  evidence: string;
  /** One directive per specific the operator implied but did not verify — each phrased as an
   *  instruction ("establish whether/what ..."), never a stated fact. May be empty. */
  recon: string[];
  /** What observation would retire/refute this claim. */
  falsifying_check: string;
}

const FEEDBACK_EXPANSION_MAX_CLAIM = 300;
const FEEDBACK_EXPANSION_MAX_EVIDENCE = 800;
const FEEDBACK_EXPANSION_MAX_RECON_ITEMS = 10;
const FEEDBACK_EXPANSION_MAX_RECON_ITEM = 300;
const FEEDBACK_EXPANSION_MAX_FALSIFYING_CHECK = 300;

/** Like {@link isBoundedString} but the empty string is VALID — `evidence` legitimately has
 *  nothing to report when the operator supplied no measured specific (see this section's own
 *  header for why that must never be papered over by inventing a fact). */
function isBoundedStringAllowEmpty(x: unknown, maxLen: number): x is string {
  return typeof x === "string" && x.length <= maxLen;
}

/**
 * Validate an UNTRUSTED value (a raw expander response) against the {@link FeedbackExpansion}
 * bounds — non-empty `claim`/`falsifying_check`, an `evidence` string of any length INCLUDING
 * empty, and a `recon` array of at most {@link FEEDBACK_EXPANSION_MAX_RECON_ITEMS} bounded
 * strings. Returns `null` on ANY violation rather than throwing — the fail-open gate this
 * task's whole round trip routes an expander response through (mirrors
 * {@link validateDecisionSummary} exactly). Trims whitespace on the way out so a validated
 * expansion is always render-ready.
 */
export function validateFeedbackExpansion(x: unknown): FeedbackExpansion | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!isBoundedString(o.claim, FEEDBACK_EXPANSION_MAX_CLAIM)) return null;
  if (!isBoundedStringAllowEmpty(o.evidence, FEEDBACK_EXPANSION_MAX_EVIDENCE)) return null;
  if (!isBoundedString(o.falsifying_check, FEEDBACK_EXPANSION_MAX_FALSIFYING_CHECK)) return null;
  if (!Array.isArray(o.recon)) return null;
  if (o.recon.length > FEEDBACK_EXPANSION_MAX_RECON_ITEMS) return null;
  if (!o.recon.every((r) => isBoundedString(r, FEEDBACK_EXPANSION_MAX_RECON_ITEM))) return null;
  return {
    claim: (o.claim as string).trim(),
    evidence: (o.evidence as string).trim(),
    falsifying_check: (o.falsifying_check as string).trim(),
    recon: (o.recon as string[]).map((r) => r.trim()),
  };
}

/** What a feedback-expansion rung reads to write the four-section skeleton — the operator's
 *  own draft plus a handful of recent, already-marked entries for register/tone calibration
 *  ONLY (never content to copy — the honesty constraint above). */
export interface FeedbackExpanderInput {
  draft: string;
  fewShot: string[];
}

/**
 * Injected feedback-expander dependency (mirrors {@link SummarizeDeps} exactly): receives ONLY
 * the already-assembled {@link FeedbackExpanderInput}, returns an UNTRUSTED value this module
 * validates before ever trusting it. Real callers wire {@link realFeedbackExpander}; tests
 * inject a canned return (or a throw) so every criterion is assertable with no network and no
 * model call.
 */
export interface FeedbackExpanderDeps {
  expand: (input: FeedbackExpanderInput) => unknown | Promise<unknown>;
}

/**
 * Expand ONE operator draft into a {@link FeedbackExpansion}, FAIL-OPEN: a throw, a rejected
 * promise, or a response that fails {@link validateFeedbackExpansion} all resolve to `null` —
 * never propagate — so an expander outage/timeout can never block the plain submission path
 * from filing (W1-T350's stated failure mode: "an expander that throws leaves the plain
 * submission path filing exactly today's entry").
 */
export async function expandFeedbackDraft(
  draft: string,
  fewShot: string[],
  deps: FeedbackExpanderDeps,
): Promise<FeedbackExpansion | null> {
  try {
    const out = await deps.expand({ draft, fewShot });
    return validateFeedbackExpansion(out);
  } catch {
    return null;
  }
}

const FEEDBACK_EXPANSION_FEW_SHOT_MARKERS = [/RECON:/, /Falsifying check:/i];

/**
 * The most recent (up to `limit`) `plan/feedback/*.yaml` `raw` texts that already carry BOTH
 * precedent markers ("RECON:" and "Falsifying check:") — the few-shot register a feedback-
 * expansion prompt calibrates against (this section's own header: "the register between the
 * markers is prose calibrated by examples"). Pure read, no LLM call; an empty inbox or one with
 * no marked entries yet returns `[]` (the prompt builder below renders no few-shot block).
 */
export function recentFeedbackFewShot(root: string, limit = 3): string[] {
  const marked = listFeedback(root).filter((e) => FEEDBACK_EXPANSION_FEW_SHOT_MARKERS.every((re) => re.test(e.raw)));
  return marked.slice(-limit).map((e) => e.raw);
}

/** Pure prompt builder — the testable half of the feedback-expansion rung, mirroring
 *  {@link buildDecisionSummaryPrompt} exactly (a caller assembles `fewShot` via
 *  {@link recentFeedbackFewShot} before calling this; this function does no I/O itself). */
export function buildFeedbackExpansionPrompt(input: FeedbackExpanderInput): string {
  const fewShotBlock = input.fewShot.length
    ? [
        "RECENT EXAMPLES OF THE SAME REGISTER (tone/calibration ONLY — never copy their content):",
        ...input.fewShot.map((ex, i) => `Example ${i + 1}:\n${ex}`),
        "",
      ]
    : [];
  return [
    "You are expanding a short operator note from a console into a four-section filing",
    "skeleton for this project's engineering-feedback inbox. Respond with ONLY a JSON object —",
    "no prose, no markdown fence — shaped EXACTLY:",
    '{"claim": string (a falsifiable, plain-language headline of what the operator is telling us),',
    ' "evidence": string (ONLY measured/verbatim specifics the operator actually stated —',
    '  figures, names, ids the operator gave; "" if the operator supplied none — NEVER invent one),',
    ' "recon": string[] (one directive per specific the operator implied but did NOT verify —',
    '  each phrased "establish whether/what ..."; [] if nothing is left unverified),',
    ' "falsifying_check": string (what observation would retire/refute this claim)}',
    "",
    "THE HONESTY CONSTRAINT: never state an unverified specific under evidence. Anything you",
    "cannot confirm from the operator's own words belongs under recon as a directive, never as",
    "a fact.",
    "",
    ...fewShotBlock,
    "OPERATOR'S DRAFT:",
    input.draft,
  ].join("\n");
}

/** Build the real spawn args for a feedback-expansion rung — pure, mirrors
 *  {@link buildDecisionSummarySpawnArgs} exactly (no write tool, cheapest mount). */
export function buildFeedbackExpansionSpawnArgs(opts: {
  input: FeedbackExpanderInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildFeedbackExpansionPrompt(opts.input),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: [], // everything it needs is in the prompt — no exploration, mirrors RISK_JUDGE_TOOLS
  };
}

/**
 * Wire a real {@link FeedbackExpanderDeps.expand} to an actual worker spawn — mirrors
 * {@link realDecisionSummarizer} exactly. Untested by unit (it shells out via the SDK, same as
 * every other real spawn in worker.ts).
 *
 * NO PRODUCTION CALLER WIRES THIS YET — this task builds the testable seam only, exactly the
 * W1-T313→W1-T348 precedent (a validated, injectable rung ships first; wiring a real default
 * into `rmd serve`'s boot path — mounts.yaml resolution, a rendered worker settings file — is a
 * follow-up once the round trip above is proven). `PanelGraphDeps.expandFeedback` is optional
 * for exactly this reason: undefined in production today means POST /v1/feedback/preview
 * always resolves `{ expansion: null }`, which is itself the documented fail-open behavior, not
 * a broken state.
 */
export function realFeedbackExpander(opts: {
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (input: FeedbackExpanderInput) => Promise<unknown> {
  const spawn = opts.spawn ?? spawnWorker;
  return async (input: FeedbackExpanderInput) => {
    const result: WorkerResult = await spawn(
      buildFeedbackExpansionSpawnArgs({ input, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile }),
    );
    const match = /\{[\s\S]*\}/.exec(result.text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  };
}

/** The cheapest configured mount for a feedback-expansion rung — same reuse rationale as
 *  {@link resolveDecisionSummaryMount} (risk-judge.ts's cheapest-tier scanner, no new
 *  mounts.yaml row). */
export function resolveFeedbackExpansionMount(mounts: Mounts): Mount {
  return resolveRiskJudgeMount(mounts);
}

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackError";
  }
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function feedbackDir(root: string): string {
  return join(root, "plan", "feedback");
}

export function feedbackAttachmentsDir(root: string, id: string): string {
  return join(feedbackDir(root), "attachments", id);
}

export function feedbackEntryPath(root: string, id: string): string {
  return join(feedbackDir(root), `${id}.yaml`);
}

/** Repo-relative, forward-slash form of {@link feedbackEntryPath} — what a git plumbing call
 *  (landFeedbackStatusContent) addresses the entry by, since it never touches the real path. */
function feedbackEntryRelPath(root: string, id: string): string {
  return relative(root, feedbackEntryPath(root, id)).split(sep).join("/");
}

/**
 * ROOT-FREE repo-relative path of a feedback entry — `plan/feedback/<id>.yaml`.
 *
 * The same string {@link feedbackEntryRelPath} produces, for the callers that must name the entry
 * WITHOUT holding a checkout root: `lib/triage.ts` renders it into an Acceptance proof at commit
 * time, when the only thing it has is the id. Derived from {@link feedbackEntryPath} against a
 * sentinel root rather than re-typing the literal, so a future move of `plan/feedback/` cannot
 * leave a proof pointing at a path that no longer exists.
 */
export function feedbackEntryRepoPath(id: string): string {
  return feedbackEntryRelPath("/", id);
}

/** `fb-<epoch-ms>-<6 hex>` — sortable by capture order, collision-safe under concurrent capture. */
function generateFeedbackId(): string {
  return `fb-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

// ── Parsing (pure — the `rmd feedback` CLI arg shape) ───────────────────────

export interface ParsedFeedbackAdd {
  raw: string;
  attachments: string[];
  origin: FeedbackOrigin;
}

/**
 * Parse `rmd feedback <text...> [--attach <path-or-url>]... [--origin cli|ui|issue]`. Pure (no
 * I/O) so it is unit-testable without touching a filesystem. FAILS LOUD (returns `{ error }`,
 * never a silent best-guess) on an unrecognized flag, a value-less `--attach`/`--origin`, an
 * `--origin` outside the closed enum, or empty text — the control-surface discipline every `rmd`
 * subcommand follows (Standing rule: validate flags BEFORE any write).
 */
export function parseFeedbackAddArgs(rest: string[]): ParsedFeedbackAdd | { error: string } {
  const attachments: string[] = [];
  let origin: FeedbackOrigin = "cli";
  const textParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--attach") {
      const v = rest[++i];
      if (v === undefined) return { error: "rmd feedback: --attach requires a value" };
      attachments.push(v);
      continue;
    }
    if (tok === "--origin") {
      const v = rest[++i];
      if (v === undefined || !(FEEDBACK_ORIGINS as readonly string[]).includes(v)) {
        return { error: `rmd feedback: --origin must be one of ${FEEDBACK_ORIGINS.join(", ")}; got ${JSON.stringify(v)}` };
      }
      origin = v as FeedbackOrigin;
      continue;
    }
    if (tok.startsWith("--")) {
      return { error: `rmd feedback: unrecognized flag '${tok}' — see \`rmd --help\`` };
    }
    textParts.push(tok);
  }
  const raw = textParts.join(" ").trim();
  if (!raw) {
    return {
      error: "rmd feedback: no feedback text given — usage: rmd feedback <text...> [--attach <path-or-url>]... [--origin cli|ui|issue]",
    };
  }
  return { raw, attachments, origin };
}

// ── Upstream home-repo routing (W1-T397) ─────────────────────────────────────
//
// "an instance working on another codebase that finds a defect in rmd ITSELF files that
// defect into that other codebase's plan/feedback/, where nobody who maintains rmd will ever
// read it" (task rationale). `.remudero/home-repo.json` names the ONE repo `rmd feedback`
// reports upstream TO — the inverse of `.remudero/managed-repos.json` (WHICH repos this
// instance is responsible FOR). It reuses that file's validation discipline (fail loud on a
// malformed pointer, {@link loadHomeRepoPointer}) and its safe-empty default: a MISSING file
// means no pointer is configured, which resolves to today's local-only behavior — nothing
// regresses for the home instance itself, which never needs to ship this file at all.
//
// TRANSPORT (design point ii) is a pull request against the home repo adding this ONE entry's
// YAML under `plan/feedback/`, built entirely via `gh api` against the home repo's GitHub
// remote — never a local clone of it, since this checkout may share no git history with home
// at all. It NEVER blocks or fails capture (design point iii): the entry is always written to
// THIS checkout's own `plan/feedback/` first (unchanged from today); the upstream attempt only
// ever adds an `upstream` field to that same local entry recording what happened, success or
// failure, and is never allowed to escape {@link captureFeedback} as a thrown error.

/** One `owner/repo` GitHub target. */
export interface UpstreamFeedbackTarget {
  owner: string;
  repo: string;
}

export function homeRepoPath(root: string): string {
  return join(root, ".remudero", "home-repo.json");
}

/**
 * Load + validate `.remudero/home-repo.json` — `{"repo": "owner/repo"}`. Missing file -> `null`
 * (no pointer configured — design point i's recommendation: absent means "file locally, as
 * today", so nothing regresses for the home instance itself). A present but malformed file
 * FAILS LOUD, mirroring {@link "./managed-repos.js".loadManagedRepos}'s exact discipline for
 * the inverse config (Standing rule: validate before any consumer trusts it).
 */
export function loadHomeRepoPointer(root: string): UpstreamFeedbackTarget | null {
  const path = homeRepoPath(root);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new FeedbackError(`.remudero/home-repo.json is not valid JSON: ${String(err)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).repo !== "string"
  ) {
    throw new FeedbackError('.remudero/home-repo.json must be shaped {"repo": "owner/repo"}');
  }
  const entry = (parsed as { repo: string }).repo;
  if (!/^[^/\s]+\/[^/\s]+$/.test(entry)) {
    throw new FeedbackError(`.remudero/home-repo.json: invalid repo entry ${JSON.stringify(entry)} — expected "owner/repo"`);
  }
  const [owner, repo] = entry.split("/");
  return { owner, repo };
}

type UpstreamGitExec = (args: string[]) => string;
type UpstreamGhExec = (args: string[]) => string;

function defaultUpstreamGit(root: string): UpstreamGitExec {
  return (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function defaultUpstreamGh(): UpstreamGhExec {
  return (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `root`'s OWN owner/repo, parsed from its git origin remote — the same regex as
 * run-task.ts's `resolveOwnerRepo()`, deliberately duplicated rather than imported (run-task.ts
 * imports FROM this module, never the reverse). `null` when it cannot be determined (no git
 * repo, no origin remote) rather than throwing — see {@link isUpstreamSelfTarget} for why an
 * undeterminable "self" resolves to the safe side.
 */
function resolveCurrentRepoFromGit(git: UpstreamGitExec): UpstreamFeedbackTarget | null {
  try {
    const url = git(["config", "--get", "remote.origin.url"]).trim();
    const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

/**
 * True when this checkout IS the configured home repo — design point iv: "when the local
 * checkout IS the home repo, upstreaming must be a no-op... or the home instance will open
 * pull requests against itself for every entry." An UNDETERMINABLE current repo
 * (`current === null` — no git repo, no origin remote) resolves to `true` (treat as self, skip
 * upstreaming) rather than `false`: the worse failure mode is a home instance spamming itself
 * with PRs, not a checkout with no discoverable identity missing one upstream attempt — the
 * entry is still captured locally either way, never dropped.
 */
function isUpstreamSelfTarget(current: UpstreamFeedbackTarget | null, home: UpstreamFeedbackTarget): boolean {
  if (current === null) return true;
  return current.owner === home.owner && current.repo === home.repo;
}

/**
 * Open a pull request against the home repo adding `plan/feedback/<id>.yaml` with `content` —
 * pure `gh api` plumbing (repo lookup -> branch ref -> file write -> PR open), no local clone of
 * the home repo required. NEVER throws: every step is wrapped, and any failure resolves to
 * `{ error }` rather than propagating — {@link captureFeedback} never fails because of this.
 */
function openUpstreamFeedbackPr(
  home: UpstreamFeedbackTarget,
  entryId: string,
  content: string,
  gh: UpstreamGhExec,
): { prUrl?: string; error?: string } {
  const slug = `${home.owner}/${home.repo}`;
  try {
    const repoInfo = JSON.parse(gh(["api", `repos/${slug}`])) as { default_branch: string };
    const base = repoInfo.default_branch;
    const baseRef = JSON.parse(gh(["api", `repos/${slug}/git/ref/heads/${base}`])) as { object: { sha: string } };
    const branch = `feedback/${entryId}`;
    try {
      gh(["api", `repos/${slug}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseRef.object.sha}`]);
    } catch {
      // The branch may already exist from a prior attempt at the SAME entry id — reuse it
      // rather than fail; the content write below is what actually matters.
    }
    const path = `plan/feedback/${entryId}.yaml`;
    gh([
      "api",
      `repos/${slug}/contents/${path}`,
      "--method",
      "PUT",
      "-f",
      `message=chore(feedback): upstream ${entryId} from a remote instance`,
      "-f",
      `content=${Buffer.from(content, "utf8").toString("base64")}`,
      "-f",
      `branch=${branch}`,
    ]);
    const prOut = gh([
      "api",
      `repos/${slug}/pulls`,
      "-f",
      `title=chore(feedback): upstream ${entryId}`,
      "-f",
      `head=${branch}`,
      "-f",
      `base=${base}`,
      "-f",
      `body=Filed by an rmd instance working on a different codebase — plan/feedback/${entryId}.yaml`,
    ]);
    const pr = JSON.parse(prOut) as { html_url: string };
    return { prUrl: pr.html_url };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

// ── Capture (I/O) ────────────────────────────────────────────────────────────

/**
 * Resolve each `--attach` input to an attachments[] entry. A `http(s)://` input is a LINK — kept
 * verbatim, nothing copied. Anything else is a LOCAL FILE (a screenshot, a terminal dump) — must
 * exist and be a regular file, or capture fails loud rather than recording a dangling reference;
 * on success it is copied into `plan/feedback/attachments/<id>/` and stored as a root-relative,
 * forward-slash path so the entry stays portable across OSes and diffable in git.
 */
function resolveAttachments(root: string, id: string, inputs: string[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      out.push(input);
      continue;
    }
    const abs = resolve(input);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new FeedbackError(`attachment not found (not a link, not a readable file): ${input}`);
    }
    const destDir = feedbackAttachmentsDir(root, id);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, basename(abs));
    copyFileSync(abs, dest);
    out.push(relative(root, dest).split(sep).join("/"));
  }
  return out;
}

export interface CaptureFeedbackOptions {
  raw: string;
  attachments?: string[];
  origin?: FeedbackOrigin;
  /**
   * Explicit id, overriding the default random `fb-<epoch>-<hex>` id. Machine-origin intake
   * (issues, W1-T57; alerts, W1-T56) passes a DETERMINISTIC id derived from the source item so a
   * re-run's `existsSync` check on that exact path is the whole dedup mechanism — no second store.
   */
  id?: string;
  /**
   * W1-T243 test seam ONLY — passed through verbatim to {@link landFeedback} after the write.
   * Real callers (the CLI, ops, issues-intake, panel routes) never set this, so they get the
   * real `git`/`gh` landing attempt; a test can inject a fake `gh` here to exercise the bridge
   * without hitting real GitHub, while the `git` half still runs for real against a local
   * bare "origin".
   */
  land?: LandFeedbackOpts;
  /**
   * W1-T350: the four-section expansion of `raw`, already produced and confirmed by the
   * caller (the console's own preview→arm→confirm round trip, panel-graph.ts) BEFORE this
   * capture ever runs. `undefined`/omitted (every non-console caller: the CLI, machine-origin
   * intake) or `null` (the console's own file-raw escape, or a confirm whose preview never
   * produced one) both leave the entry's `expansion` at `null` — `raw` is byte-identical and
   * files unchanged either way. This function never generates one itself: expansion is a
   * PREVIEW-time concern, never something a plain capture call triggers on its own.
   */
  expansion?: FeedbackExpansion | null;
  /**
   * W1-T2278: the id of the `grilling` entry this capture answers, ALREADY VALIDATED by the
   * caller (panel-graph.ts's `buildSubmitFeedbackRoute` reads the target and confirms it is
   * parked `grilling` before this function ever runs — this function itself does no such
   * lookup, mirroring `expansion` above: the caller assembles and validates, this module only
   * stores). `undefined`/omitted leaves `reply_to: null` on the written entry — a submission
   * carrying no reply reference is byte-identical to today's shape plus this one added field.
   */
  replyTo?: string;
  /**
   * W1-T2496: the escalation thread id (`inbox-thread.ts`'s {@link deriveThreadId}) this capture
   * answers, ALREADY VALIDATED by the caller (panel-actions.ts's `buildEscalationReplyRoute`
   * confirms a thread by this id already carries at least one message before this function ever
   * runs — this function itself does no such lookup, mirroring `replyTo` above: the caller
   * validates, this module only stores). `undefined`/omitted leaves `thread_id: null` on the
   * written entry — a submission carrying no thread reference is byte-identical to today's shape
   * plus this one added field.
   */
  threadId?: string;
  /**
   * W1-T397 test seam ONLY — injectable `git`/`gh` for the home-repo self-check and the
   * upstream PR attempt. Real callers never set this, so they get the actual `git`/`gh` calls;
   * a test injects fakes so the routing decision (self vs. not) and the PR-open attempt are
   * both assertable with no real subprocess and no live GitHub call.
   */
  upstream?: { git?: UpstreamGitExec; gh?: UpstreamGhExec };
  /**
   * W1-T2302: a per-submission key minted by the CALLER (the console, `POST /v1/feedback`) that
   * identifies ONE operator submit action — never derived from `raw` (two deliberately separate
   * submissions carrying identical text must still each file, design point (iv), which a
   * text-derived key could not tell apart). When given and an entry ALREADY carries this exact
   * key ({@link findFeedbackBySubmissionKey}), this call is a REPEAT of a submission that already
   * filed: it returns that existing entry completely UNTOUCHED — no write, no re-land, no
   * re-upstream-attempt — even when that entry's `status` has since moved on from `new` (the
   * trap named in this function's own doc: re-using `id` for this purpose would silently reset
   * an already-triaged entry). `undefined` (every non-console caller, and a console call with no
   * key) always files a fresh entry, exactly today's behavior.
   */
  submissionKey?: string;
}

/**
 * Find an existing feedback entry by its console-minted `submission_key` (W1-T2302) —
 * {@link captureFeedback}'s never-clobber guard, run BEFORE it ever writes: a repeat `POST
 * /v1/feedback` carrying a key that already filed must read back the entry AS IT STANDS,
 * whatever its status has moved to since, never re-write it. `null` when nothing carries this
 * key — a genuinely new submission, or no key at all (every non-console caller). A linear scan
 * over {@link listFeedback} rather than a second index/store: design point (iii)'s durable-field
 * choice trades an O(n) scan (n = this checkout's whole feedback corpus, already read whole by
 * every other panel-graph route) for "no file, no index, no second thing to go stale" — and it
 * survives a daemon restart, unlike a bounded in-process map.
 */
export function findFeedbackBySubmissionKey(root: string, key: string): FeedbackEntry | null {
  return listFeedback(root).find((e) => e.submission_key === key) ?? null;
}

/**
 * Capture one feedback item: writes `plan/feedback/<id>.yaml` with `status: new`, copying any
 * local-path attachments alongside it. The write itself is synchronous filesystem I/O only —
 * no network, no LLM — so a headless `rmd feedback` call still returns effectively immediately
 * (ASYNC CAPTURE: the operator is never blocked waiting on triage, which runs later and
 * separately, W1-T41).
 *
 * Immediately after the write, this ALSO attempts to LAND the entry onto `origin/main` via the
 * ONE choke point {@link landFeedback} (W1-T243) — every caller of this function inherits the
 * bridge by construction, with no per-call-site wiring. Landing is best-effort and NEVER
 * throws: a failure here (offline, no `gh`, no network) never fails the capture — the write
 * above already is the durable record; landing merely gets it onto `origin/main` sooner so
 * `rmd triage` can act on it without a human hand-landing it first.
 *
 * After the local write and the local landing attempt, this ALSO checks for a home-repo
 * pointer (W1-T397, {@link loadHomeRepoPointer}) and, when one is configured and this checkout
 * is not itself the home repo, attempts to open a pull request against the home repo carrying
 * this same entry ({@link openUpstreamFeedbackPr}) — so an instance working on a DIFFERENT
 * codebase files an rmd defect where an rmd maintainer will actually read it, instead of into
 * that codebase's own `plan/feedback/`. Like landing, this is best-effort and NEVER throws:
 * any failure (no pointer, self-target, network, `gh`, even a malformed pointer file) leaves
 * the entry captured locally with an `upstream` field recording what happened — never dropped,
 * never blocking the run that produced it. This step takes no lock and writes nothing outside
 * this one entry file: a reporting-only instance needs no arbiter.
 */
export function captureFeedback(root: string, opts: CaptureFeedbackOptions): FeedbackEntry {
  if (opts.submissionKey) {
    const existing = findFeedbackBySubmissionKey(root, opts.submissionKey);
    if (existing) return existing;
  }
  const raw = opts.raw.trim();
  if (!raw) throw new FeedbackError("feedback text must not be empty");
  const origin = opts.origin ?? "cli";
  if (!isValidFeedbackOrigin(origin)) {
    throw new FeedbackError(
      `invalid origin "${origin}" — must be one of ${FEEDBACK_ORIGINS.join(", ")}, "issue#<n>" (machine-origin, W1-T57), ` +
        `"alert#<source>-<id>" (machine-origin, W1-T56), or "repair#<surface>" (machine-origin, W1-T905)`,
    );
  }
  const id = opts.id ?? generateFeedbackId();
  mkdirSync(feedbackDir(root), { recursive: true });
  const attachments = resolveAttachments(root, id, opts.attachments ?? []);
  let entry: FeedbackEntry = {
    id,
    ts: new Date().toISOString(),
    raw,
    attachments,
    origin,
    status: "new",
    reply_to: opts.replyTo ?? null,
    proposal_pr: null,
    summary: null,
    expansion: opts.expansion ?? null,
    submission_key: opts.submissionKey ?? null,
    thread_id: opts.threadId ?? null,
  };
  writeFileSync(feedbackEntryPath(root, id), stringifyYaml(entry));
  try {
    landFeedback(root, opts.land ?? {});
  } catch {
    // landFeedback already swallows its own failures — this is a defensive second layer so
    // NOTHING landing-related can ever turn a successful capture into a thrown error.
  }
  try {
    const home = loadHomeRepoPointer(root);
    if (home) {
      const git = opts.upstream?.git ?? defaultUpstreamGit(root);
      const current = resolveCurrentRepoFromGit(git);
      if (!isUpstreamSelfTarget(current, home)) {
        const gh = opts.upstream?.gh ?? defaultUpstreamGh();
        const { prUrl, error } = openUpstreamFeedbackPr(home, id, stringifyYaml(entry), gh);
        entry = {
          ...entry,
          upstream: prUrl
            ? { home: `${home.owner}/${home.repo}`, status: "landed", pr_url: prUrl }
            : { home: `${home.owner}/${home.repo}`, status: "unreachable", error: error ?? "unknown error" },
        };
        writeFileSync(feedbackEntryPath(root, id), stringifyYaml(entry));
      }
    }
  } catch (e) {
    // Anything here — a malformed .remudero/home-repo.json, an unexpected throw from an
    // injected test double — is the SAME failure class as an unreachable home repo: the entry
    // is already durably captured locally above, so this defensive layer only records what
    // went wrong rather than letting it turn a successful capture into a thrown error.
    entry = { ...entry, upstream: { home: "unknown", status: "unreachable", error: String((e as Error)?.message ?? e) } };
    writeFileSync(feedbackEntryPath(root, id), stringifyYaml(entry));
  }
  return entry;
}

// ── Read / lifecycle ─────────────────────────────────────────────────────────

export function readFeedbackEntry(root: string, id: string): FeedbackEntry {
  const p = feedbackEntryPath(root, id);
  if (!existsSync(p)) throw new FeedbackError(`no feedback entry "${id}" (looked in ${p})`);
  return parseYaml(readFileSync(p, "utf8")) as FeedbackEntry;
}

/** List every captured entry, oldest first (id is Date.now()-prefixed, so filename sort = capture order). */
export function listFeedback(root: string, opts: { status?: FeedbackStatus } = {}): FeedbackEntry[] {
  const dir = feedbackDir(root);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as FeedbackEntry);
  return opts.status ? entries.filter((e) => e.status === opts.status) : entries;
}

/**
 * Move a feedback entry to a new lifecycle status (the write primitive `rmd triage`, W1-T41,
 * uses to mark `grilling`/`proposed`, and the gate uses to mark `accepted`/`rejected`). Rejects
 * an unknown status; does not otherwise constrain which transition is legal — the state machine
 * that decides WHEN each transition is appropriate belongs to the intake loop that calls this,
 * not to the inbox's storage layer.
 *
 * `opts.land`, when passed, routes the write itself through {@link landFeedbackStatusContent}
 * INSTEAD OF the normal local `writeFileSync` (W1-T191, write site 2) — deliberately, not an
 * add-on: `id`'s entry is already TRACKED in git (it was captured+landed+merged earlier), so a
 * normal local write here would leave it `M`-modified in `checkCliFreshness`'s `git status
 * --porcelain` — the exact "checkout dirties, auto-sync switches itself off" defect this task
 * removes — even though `landFeedback`'s bridge would separately get the SAME content onto
 * `origin/main`. See {@link "./feedback-landing.js".landContent}'s doc for why landing
 * afterward doesn't undo a local write's dirt (the bridge never touches the working tree
 * either way, by design).
 *
 * This is OPT-IN, not automatic for every caller, unlike `captureFeedback`'s unconditional
 * `landFeedback` call: `rmd triage` (run-task.ts) calls this against a worker's OWN worktree
 * and immediately `git add`+commit+push+`gh pr create`s it for real, so it needs the REAL
 * local write (that commit reads the working tree) and must never take this branch. The ONE
 * caller this exists for is the console's `POST /v1/feedback/decision` route
 * (panel-graph.ts), which writes straight against the daemon's own checkout and has no commit
 * path of its own — that route passes `{ land: {} }` explicitly. Trade-off: a caller that
 * reads `root`'s own `plan/feedback/<id>.yaml` again right after (e.g. the console's own list)
 * won't see the flip until this checkout's next self-sync past the landing PR's merge — out of
 * scope for this task's acceptance bar (a clean tree, not read-your-own-write).
 */
export function setFeedbackStatus(
  root: string,
  id: string,
  status: FeedbackStatus,
  opts: {
    proposalPr?: string;
    land?: LandFeedbackOpts;
    summary?: DecisionSummary | null;
    /**
     * W1-T2278: the id of the entry that just answered THIS one — passed ONLY by
     * `buildSubmitFeedbackRoute` (panel-graph.ts) in the same call that advances a `grilling`
     * target to `status: "answered"`. `undefined` (every other caller — `rmd triage`, the
     * accept/reject decision route) leaves whatever this entry already had, mirroring
     * `summary`'s own "unset means untouched" discipline immediately below.
     */
    answeredBy?: string | null;
  } = {},
): FeedbackEntry {
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    throw new FeedbackError(`invalid status "${status}" — must be one of ${FEEDBACK_STATUSES.join(", ")}`);
  }
  const entry = readFeedbackEntry(root, id);
  const updated: FeedbackEntry = {
    ...entry,
    status,
    proposal_pr: opts.proposalPr ?? entry.proposal_pr ?? null,
    // W1-T313: `summary` is set ONLY when THIS caller passed one — `undefined` means "leave
    // whatever this entry already had", so every pre-W1-T313 caller keeps writing
    // byte-identical entries. A caller that DOES pass one ({@link proposeFeedbackWithSummary},
    // below) overwrites unconditionally, including with `null` (a fail-open summarizer result).
    summary: opts.summary !== undefined ? opts.summary : (entry.summary ?? null),
    answered_by: opts.answeredBy !== undefined ? opts.answeredBy : (entry.answered_by ?? null),
  };
  const content = stringifyYaml(updated);
  if (opts.land) {
    try {
      landFeedbackStatusContent(root, feedbackEntryRelPath(root, id), content, opts.land);
    } catch {
      // landFeedbackStatusContent already swallows its own failures — this is a defensive
      // second layer, mirroring captureFeedback's own, so nothing landing-related can ever
      // turn a successful status flip into a thrown error.
    }
  } else {
    writeFileSync(feedbackEntryPath(root, id), content);
  }
  return updated;
}

/**
 * `rmd triage`'s CREATION-TIME write for a proposal (W1-T313): reads the entry, asks
 * `deps.summarize` for a plain-language decision card ONCE (fail-open via
 * {@link summarizeFeedbackProposal} — never throws), and writes BOTH the `proposed` status
 * transition and the resulting summary (or `null`) in the SAME {@link setFeedbackStatus} call
 * — so a proposal never exists half-written (transitioned but not yet summarized, or vice
 * versa). A summarizer outage degrades to `summary: null`: the entry still proposes normally
 * and the console still renders it (off `entry.raw`, unchanged) — it just has no decision
 * card yet, exactly today's behavior.
 */
export async function proposeFeedbackWithSummary(
  root: string,
  id: string,
  deps: SummarizeDeps,
  opts: { proposalPr?: string; land?: LandFeedbackOpts } = {},
): Promise<FeedbackEntry> {
  const entry = readFeedbackEntry(root, id);
  const summary = await summarizeFeedbackProposal(entry, deps);
  return setFeedbackStatus(root, id, "proposed", { ...opts, summary });
}
