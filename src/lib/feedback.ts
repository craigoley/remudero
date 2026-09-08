import { execFileSync } from "node:child_process";
import { ghExec } from "./github-transport.js";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { landFeedback, landFeedbackStatusContent, type LandFeedbackOpts } from "./feedback-landing.js";
import type { Mount, Mounts } from "./mounts.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/** `plan/feedback/` — the durable, diffable feedback inbox (MASTER-PLAN §7B, W1-T40). One entry
 * per item: id, timestamp, raw text, attachments, origin, status. Capture is pure filesystem
 * I/O — no network, no LLM — so `rmd feedback` always returns instantly and works offline.
 *
 * After the write, capture also attempts to LAND the entry onto `origin/main` (W1-T243, see
 * {@link "./feedback-landing.js".landFeedback}) so `rmd triage` can see it without a human
 * hand-landing it; landing swallows every failure since the local write is already durable.
 * One file per entry so concurrent captures never race, and image attachments are
 * worker-readable directly. Why: the full rationale and the attachment-readability probe are
 * archived in docs/forensics/feedback.md. */

/** Where feedback originated — a closed enum per the §7B schema (human capture methods). */
export const FEEDBACK_ORIGINS = ["cli", "ui", "issue"] as const;
export type NamedFeedbackOrigin = (typeof FEEDBACK_ORIGINS)[number];

/** `FeedbackOrigin` is the named enum above plus three machine-origin shapes: `issue#<n>` (one
 * GitHub issue, W1-T57), `alert#<id>` (one scanning alert, W1-T56), and `repair#<surface>`
 * (one recurring `sweep.disposed` disposition, W1-T905). These name WHICH machine source
 * produced the entry, so `rmd trace` (W1-T43) can point straight back at it. Why: the full
 * citation is archived in docs/forensics/feedback.md. */
export type FeedbackOrigin = NamedFeedbackOrigin | `issue#${number}` | `alert#${string}` | `repair#${string}`;

const MACHINE_ORIGIN_ISSUE = /^issue#\d+$/;
/** `alert#<source>-<id>` — source is one of ops.ts's three ALERT_SOURCES, id is that source's own alert number. */
const MACHINE_ORIGIN_ALERT = /^alert#(code-scanning|dependabot|secret-scanning)-.+$/;
/** `repair#<surface>` (W1-T905) — a `sweep.disposed` row's own lower-kebab-case `disposition`
 *  value (`DISPOSITION_RULES`, src/lib/sweep.ts), never invented text. */
const MACHINE_ORIGIN_REPAIR = /^repair#[a-z][a-z-]*$/;

/** True for any valid {@link FeedbackOrigin} — the named enum or a well-formed machine-origin
 *  shape. */
export function isValidFeedbackOrigin(origin: string): origin is FeedbackOrigin {
  return (
    (FEEDBACK_ORIGINS as readonly string[]).includes(origin) ||
    MACHINE_ORIGIN_ISSUE.test(origin) ||
    MACHINE_ORIGIN_ALERT.test(origin) ||
    MACHINE_ORIGIN_REPAIR.test(origin)
  );
}

/** The status lifecycle a feedback entry moves through (§7B: new -> grilling -> proposed ->
 * accepted/rejected), plus `answered` (W1-T2278) — a separate terminal arm a `grilling` entry
 * reaches once a `replyTo` names it. {@link setFeedbackStatus} leaves which transition is legal
 * to its caller. Why: the closed-terminal-state reasoning is archived in
 * docs/forensics/feedback.md. */
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
  /** The `grilling` entry this entry answers, when captured via `POST /v1/feedback`'s `replyTo`
   *  (W1-T2278) — a field, not prose folded into `raw`. `null` when absent, set once. Why: the
   *  field-vs-prose reasoning is archived in docs/forensics/feedback.md. */
  reply_to?: string | null;
  /** The reverse edge of `reply_to` (W1-T2278) — the id of the entry that answered THIS one.
   *  Set exactly once, by {@link setFeedbackStatus} in the same call that advances this entry
   *  to `status: "answered"`; `null`/absent otherwise. */
  answered_by?: string | null;
  /** Set once `rmd triage` (W1-T41) opens a proposal PR for this entry; null until then. */
  proposal_pr: string | null;
  /** A machine-written plain-language decision card, generated ONCE when this entry moves to
   * `status: proposed` (see {@link proposeFeedbackWithSummary}); a render never re-invokes the
   * summarizer (W1-T313). `null` until proposed or on any summarizer failure — fail-open, never
   * lossy. */
  summary?: DecisionSummary | null;
  /** The four-section CLAIM/EVIDENCE/RECON/FALSIFYING CHECK expansion of `raw` (W1-T350),
   * generated at PREVIEW time and attached at capture — never regenerated on render.
   * `undefined`/`null` when no preview ran. */
  expansion?: FeedbackExpansion | null;
  /** Present ONLY when a home-repo pointer (W1-T397) is configured AND this checkout is not
   * itself the home repo. `status: "landed"` once a PR carries this entry; `"unreachable"` on
   * any failure, with `error` naming why. The entry is always captured locally first. */
  upstream?: {
    /** "owner/repo" of the configured home repo. */
    home: string;
    status: "landed" | "unreachable";
    pr_url?: string;
    error?: string;
  };
  /** W1-T2302: the console-minted per-submission key `POST /v1/feedback` carried on this
   * capture — the identity a REPEAT of this exact submission is recognised by, distinct from
   * `id` (see {@link captureFeedback}). Durable on the entry rather than a second store.
   * `null`/absent when none was supplied. */
  submission_key?: string | null;
  /** W1-T2496: the escalation thread id (`inbox-thread.ts`'s {@link deriveThreadId}) this entry
   * REPLIES TO, via `POST /v1/escalation/reply` — a DIFFERENT edge than `reply_to`, which names
   * another feedback entry rather than a thread. `null`/absent when none was supplied. */
  thread_id?: string | null;
}

// ── Decision summaries (W1-T313) ─────────────────────────────────────────────
//
// A DecisionSummary is a small, STRUCTURED record — never a blob of prose — so a renderer can
// lay it out and {@link validateDecisionSummary} can bound it before anything trusts it. Why:
// the operator directive that motivated this shape is archived in docs/forensics/feedback.md.

/** One labelled choice inside a {@link DecisionSummary} — `consequence` is ONE LINE (no
 *  newline), so the console renders it as a single list item with no wrapping surprise. */
export interface DecisionSummaryOption {
  label: string;
  consequence: string;
}

/** A machine-written, plain-language decision card. `options` is 2-3 labelled choices — for an
 * escalation these are its own options passed through verbatim, never a paraphrase. */
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

/** Validate an untrusted value against the {@link DecisionSummary} bounds. Returns `null` on
 * any violation rather than throwing — the fail-open gate every producer/consumer routes a
 * summary through. */
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

/** What a decision-summary rung reads to write its plain-language card — free-text context
 *  only, so {@link SummarizeDeps.summarize} is reusable across every producer (a feedback
 *  proposal here, an escalation in escalate.ts). */
export interface SummarizeInput {
  context: string;
}

/** Injected decision-summary dependency: an untrusted value this module validates before
 * trusting it. Real callers wire {@link realDecisionSummarizer}; tests inject a canned return
 * (W1-T313). */
export interface SummarizeDeps {
  summarize: (input: SummarizeInput) => unknown | Promise<unknown>;
}

/** Summarize ONE feedback proposal into a {@link DecisionSummary}, fail-open: a throw, a
 * rejected promise, or an invalid response all resolve to `null` rather than propagate, so a
 * summarizer outage never blocks a triage proposal from writing. */
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
// Mirrors risk-judge.ts's split: a pure prompt builder + spawn-args builder are unit-tested;
// the actual spawn is untested by unit, like every real spawn in worker.ts.
// {@link resolveDecisionSummaryMount} reuses risk-judge.ts's scanner rather than adding a
// mounts.yaml row. Why: the reuse rationale is archived in docs/forensics/feedback.md.

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

/** Build the real spawn args for a decision-summary rung — pure and unit-testable, mirroring
 *  risk-judge.ts's `buildRiskJudgeSpawnArgs`. */
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
 *  wiring for {@link summarizeFeedbackProposal}. Untested by unit, like every real spawn in
 *  worker.ts. */
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

/** The cheapest configured mount for a decision-summary rung (reuses risk-judge.ts's scanner). */
export function resolveDecisionSummaryMount(mounts: Mounts): Mount {
  return resolveRiskJudgeMount(mounts);
}

// ── Feedback expansions (W1-T350) ────────────────────────────────────────────
//
// A FeedbackExpansion is a four-section skeleton (CLAIM/EVIDENCE/RECON/FALSIFYING CHECK) as
// four named, validated fields — never raw prose with embedded markers to parse back out.
// `evidence`/`recon` may legitimately be EMPTY: an unverified specific belongs under `recon`,
// never invented into `evidence`. Why: the operator directive behind this shape is archived in
// docs/forensics/feedback.md.

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

/** Like {@link isBoundedString} but the empty string is VALID — `evidence` may legitimately
 *  report nothing when the operator supplied no measured specific. */
function isBoundedStringAllowEmpty(x: unknown, maxLen: number): x is string {
  return typeof x === "string" && x.length <= maxLen;
}

/** Validate an untrusted value (a raw expander response) against the {@link FeedbackExpansion}
 * bounds. Returns `null` on any violation rather than throwing, mirroring
 * {@link validateDecisionSummary} exactly. Trims whitespace on the way out. */
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

/** Injected feedback-expander dependency, mirroring {@link SummarizeDeps} exactly: an untrusted
 * value this module validates before trusting it. Real callers wire
 * {@link realFeedbackExpander}; tests inject a canned return. */
export interface FeedbackExpanderDeps {
  expand: (input: FeedbackExpanderInput) => unknown | Promise<unknown>;
}

/** Expand ONE operator draft into a {@link FeedbackExpansion}, fail-open: a throw, a rejected
 * promise, or an invalid response all resolve to `null`, so an expander outage never blocks the
 * plain submission path from filing (W1-T350). */
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

/** The most recent (up to `limit`) `plan/feedback/*.yaml` `raw` texts already carrying both
 * precedent markers ("RECON:" and "Falsifying check:") — the few-shot register a
 * feedback-expansion prompt calibrates against. Pure read; `[]` when nothing is marked yet. */
export function recentFeedbackFewShot(root: string, limit = 3): string[] {
  const marked = listFeedback(root).filter((e) => FEEDBACK_EXPANSION_FEW_SHOT_MARKERS.every((re) => re.test(e.raw)));
  return marked.slice(-limit).map((e) => e.raw);
}

/** Pure prompt builder — the testable half of the feedback-expansion rung, mirroring
 *  {@link buildDecisionSummaryPrompt}; a caller assembles `fewShot` via
 *  {@link recentFeedbackFewShot} first. */
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

/** Wire a real {@link FeedbackExpanderDeps.expand} to an actual worker spawn — mirrors
 * {@link realDecisionSummarizer}. Untested by unit, like every real spawn in worker.ts.
 *
 * No production caller wires this yet — the testable seam ships first (W1-T313's own
 * precedent); `PanelGraphDeps.expandFeedback` stays optional, so `POST /v1/feedback/preview`
 * resolves `{ expansion: null }` today — documented fail-open, not a broken state. */
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

/** The cheapest configured mount for a feedback-expansion rung (same reuse as
 *  {@link resolveDecisionSummaryMount}). */
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

/** ROOT-FREE repo-relative path of a feedback entry — `plan/feedback/<id>.yaml` — for callers
 * without a checkout root (`lib/triage.ts`'s Acceptance proof). Derived from
 * {@link feedbackEntryPath} rather than re-typed, so a path move cannot leave it stale. */
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

/** Parse `rmd feedback <text...> [--attach <path-or-url>]... [--origin cli|ui|issue]`. Pure (no
 * I/O). FAILS LOUD (`{ error }`, never a silent guess) on an unrecognized flag, a value-less
 * flag, an out-of-enum `--origin`, or empty text. */
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
// `.remudero/home-repo.json` names the ONE repo `rmd feedback` reports upstream TO. A missing
// file means no pointer configured (local-only, unchanged). It never blocks or fails capture —
// the entry is always written locally first, and the upstream attempt only ever adds an
// `upstream` field.
// Why: the full design rationale is archived in docs/forensics/feedback.md.

/** One `owner/repo` GitHub target. */
export interface UpstreamFeedbackTarget {
  owner: string;
  repo: string;
}

export function homeRepoPath(root: string): string {
  return join(root, ".remudero", "home-repo.json");
}

/** Load + validate `.remudero/home-repo.json` — `{"repo": "owner/repo"}`. Missing file -> `null`
 * (no pointer configured). A present but malformed file FAILS LOUD, mirroring
 * {@link "./managed-repos.js".loadManagedRepos}'s discipline for the inverse config. */
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
  return (args) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `root`'s own owner/repo, parsed from its git origin remote — deliberately duplicated from
 * run-task.ts's `resolveOwnerRepo()` rather than imported. `null` when it cannot be
 * determined, rather than throwing. */
function resolveCurrentRepoFromGit(git: UpstreamGitExec): UpstreamFeedbackTarget | null {
  try {
    const url = git(["config", "--get", "remote.origin.url"]).trim();
    const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

/** True when this checkout IS the configured home repo — so upstreaming stays a no-op. An
 * undeterminable current repo resolves to `true` (skip upstreaming): the safer failure mode. */
function isUpstreamSelfTarget(current: UpstreamFeedbackTarget | null, home: UpstreamFeedbackTarget): boolean {
  if (current === null) return true;
  return current.owner === home.owner && current.repo === home.repo;
}

/** Open a pull request against the home repo adding `plan/feedback/<id>.yaml` with `content` —
 * pure `gh api` plumbing, no local clone required. Never throws: any failure resolves to
 * `{ error }` rather than propagating, so {@link captureFeedback} never fails because of this. */
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

/** Resolve each `--attach` input to an attachments[] entry. A `http(s)://` input is kept
 * verbatim as a link; anything else must be a readable local file, copied into
 * `plan/feedback/attachments/<id>/` and stored as a root-relative, forward-slash path. */
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
  /** Explicit id, overriding the default random `fb-<epoch>-<hex>` id. Machine-origin intake
   *  passes a deterministic id so a re-run's `existsSync` check is the whole dedup mechanism. */
  id?: string;
  /** W1-T243 test seam only — passed through verbatim to {@link landFeedback} after the write.
   *  Real callers never set this; a test injects a fake `gh` to exercise the bridge without
   *  hitting real GitHub. */
  land?: LandFeedbackOpts;
  /** W1-T350: the four-section expansion of `raw`, already produced by the caller's own
   * preview→arm→confirm round trip before this capture ever runs. `undefined`/`null` leaves
   * the entry's `expansion` at `null`. */
  expansion?: FeedbackExpansion | null;
  /** W1-T2278: the id of the `grilling` entry this capture answers, ALREADY VALIDATED by the
   * caller (`buildSubmitFeedbackRoute`, panel-graph.ts) before this function ever runs — this
   * function does no such lookup itself. `undefined`/omitted leaves `reply_to: null`. */
  replyTo?: string;
  /** W1-T2496: the escalation thread id this capture answers, ALREADY VALIDATED by the caller
   * (`buildEscalationReplyRoute`, panel-actions.ts) before this function ever runs — mirroring
   * `replyTo` above. `undefined`/omitted leaves `thread_id: null`. */
  threadId?: string;
  /** W1-T397 test seam only — injectable `git`/`gh` for the home-repo self-check and upstream
   *  PR attempt. Real callers never set this. */
  upstream?: { git?: UpstreamGitExec; gh?: UpstreamGhExec };
  /** W1-T2302: a per-submission key minted by the CALLER that identifies ONE operator submit
   * action — never derived from `raw`. A repeat of an already-filed key returns that entry
   * UNTOUCHED ({@link findFeedbackBySubmissionKey}); `undefined` always files fresh. Why: the
   * reasoning against reusing `id` for dedup is archived in docs/forensics/feedback.md. */
  submissionKey?: string;
}

/** Find an existing feedback entry by its console-minted `submission_key` (W1-T2302) —
 * {@link captureFeedback}'s never-clobber guard, run before it ever writes. `null` when nothing
 * carries this key. A linear scan over {@link listFeedback} rather than a second index, so it
 * survives a daemon restart with nothing new to go stale. */
export function findFeedbackBySubmissionKey(root: string, key: string): FeedbackEntry | null {
  return listFeedback(root).find((e) => e.submission_key === key) ?? null;
}

/** Capture one feedback item: writes `plan/feedback/<id>.yaml` with `status: new`, copying any
 * local-path attachments alongside it. The write is synchronous filesystem I/O only — no
 * network, no LLM — so `rmd feedback` always returns effectively immediately.
 *
 * After the write, this also attempts to LAND the entry onto `origin/main` (W1-T243) and, when
 * a home-repo pointer is configured and this checkout is not the home repo, to open a PR
 * against it (W1-T397). Both steps are best-effort and NEVER throw. Why: the full
 * landing/upstream sequencing is archived in docs/forensics/feedback.md. */
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
    // landFeedback already swallows its own failures — a defensive second layer only.
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
    // Same failure class as an unreachable home repo — the entry is already captured locally.
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

/** Move a feedback entry to a new lifecycle status (the write primitive `rmd triage`, W1-T41,
 * and the gate use). Rejects an unknown status; leaves which transition is legal to the caller.
 *
 * `opts.land`, when passed, routes the write through {@link landFeedbackStatusContent}
 * (W1-T191) instead of a normal local write, because `id`'s entry is already tracked in git —
 * a plain write here would dirty the checkout. OPT-IN: `rmd triage` writes locally and commits
 * for real; the console's `POST /v1/feedback/decision` route is the one `{ land: {} }` caller.
 * Why: the dirty-checkout defect is archived in docs/forensics/feedback.md. */
export function setFeedbackStatus(
  root: string,
  id: string,
  status: FeedbackStatus,
  opts: {
    proposalPr?: string;
    land?: LandFeedbackOpts;
    summary?: DecisionSummary | null;
    /** W1-T2278: the id of the entry that just answered THIS one — set ONLY by
     * `buildSubmitFeedbackRoute` in the same call that moves a `grilling` target to
     * `status: "answered"`. `undefined` leaves whatever this entry already had. */
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
      // landFeedbackStatusContent already swallows its own failures — defensive layer only.
    }
  } else {
    writeFileSync(feedbackEntryPath(root, id), content);
  }
  return updated;
}

/** `rmd triage`'s creation-time write for a proposal (W1-T313): asks `deps.summarize` for a
 * decision card once (fail-open, never throws), and writes both the `proposed` transition and
 * the resulting summary in the SAME {@link setFeedbackStatus} call, so a proposal never exists
 * half-written. */
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
