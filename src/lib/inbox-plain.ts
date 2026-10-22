import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { OptionIntent, SummarizeDeps } from "./feedback.js";
import { validateDecisionSummary } from "./feedback.js";
import { writeAtomic } from "./fs-race-safe.js";
import { inboxKind, inboxOwner } from "./inbox-owner.js";
import { inboxThreadId } from "./inbox-thread.js";
import { checkOperatorMessage } from "./operator-message.js";

/**
 * lib/inbox-plain.ts (W1-T4087) — every inbox message, written for a person.
 *
 * On 2026-09-22 every one of the 674 live inbox items showed the producer's raw diagnostic as its
 * text — task ids, file paths, rule anchors, backticked config keys, command names. The operator
 * message standard (docs/operator-message-standard.md, ISO 24495-1) and the 2026-07-22 decision-card
 * directive (DECISIONS.md) already said what an operator message is; they only ever reached
 * escalations. This module gives every inbox item a plain message, written once and stored, with
 * the raw summary kept for the console's Details.
 *
 * WHAT IS CHECKED, AND WHAT IS NOT. {@link checkPlainMessage} checks the standard's four parts,
 * machine text, and fleet framing against the source summary. It never scores
 * readability, counts sentence length, or judges tone: the standard rules those out ("no
 * readability score, no word-count gate, and no sentence-length threshold"). The headline's
 * 15-word bound and the two-to-three options are the decision-card shape the operator directed,
 * enforced by the same {@link validateDecisionSummary} escalations use.
 *
 * IT FAILS TOWARD A PLAIN MESSAGE, NEVER TOWARD THE RAW TEXT. A writer answer that fails the check
 * is asked for once more with the offending tokens named; if that also fails, or there is no
 * writer, a per-kind template written in plain English is used. The raw summary is never promoted
 * to the plain text.
 */

export interface PlainOption {
  label: string;
  consequence: string;
  /** W1-T8826: which inbox verb the choice performs. Untagged stored options are served as "reply". */
  intent?: OptionIntent;
}

/** W1-T8826 — the existing route a served option posts to. Never stored: attached at serve time. */
export interface PlainOptionAction {
  method: "POST";
  path: string;
  fields: Record<string, string>;
  /** The one free-text field the console collects before posting. */
  input?: "reason" | "feedback" | "text";
}

/** An option as GET /v1/inbox serves it: always an intent, an action only when a route is valid. */
export interface ServedPlainOption extends PlainOption {
  intent: OptionIntent;
  action?: PlainOptionAction;
}

/** A plain message as GET /v1/inbox serves it. */
export type ServedPlainInboxMessage = Omit<PlainInboxMessage, "options"> & { options: ServedPlainOption[] };

export type InboxOptionLane = "ready" | "drafting" | "notReady" | "declined";

/** The route a choice maps onto, or none when the lane (or the choice) has no valid route. Each action
 *  points at an existing route with its existing tier and auth. */
export function optionAction(intent: OptionIntent, lane: InboxOptionLane, proposalId: string): PlainOptionAction | undefined {
  switch (intent) {
    case "approve":
      return lane === "ready" ? { method: "POST", path: "/v1/inbox/approve", fields: { proposalId } } : undefined;
    case "decline":
      return lane === "declined" ? undefined : { method: "POST", path: "/v1/inbox/decline", fields: { proposalId }, input: "reason" };
    case "reframe":
      return { method: "POST", path: "/v1/inbox/reframe", fields: { proposalId }, input: "feedback" };
    case "reply":
      // The thread route answers only an operator-owned item.
      return inboxOwner({ id: proposalId }) === "operator"
        ? { method: "POST", path: "/v1/inbox/thread/reply", fields: { threadId: inboxThreadId(proposalId) }, input: "text" }
        : undefined;
    case "keep":
      return { method: "POST", path: "/v1/inbox/keep", fields: { proposalId }, input: "reason" };
  }
}

/** Serve a plain message with each option's intent and, where a route is valid, its action. An option
 *  stored without an intent is served as "reply" with no action until the backfill re-writes it. */
export function servePlainOptions(plain: PlainInboxMessage, lane: InboxOptionLane, proposalId: string): ServedPlainInboxMessage {
  return {
    ...plain,
    options: plain.options.map((o): ServedPlainOption => {
      const option: ServedPlainOption = { label: o.label, consequence: o.consequence, intent: o.intent ?? "reply" };
      if (o.intent === undefined) return option;
      const action = optionAction(o.intent, lane, proposalId);
      return { ...option, ...(action ? { action } : {}) };
    }),
  };
}

export interface PlainInboxMessage {
  /** 15 words or fewer. */
  headline: string;
  whatHappened: string;
  /** What the daemon needs from the operator, as an instruction. */
  whatWeNeed: string;
  /** What happens if nobody acts. */
  ifNothingHappens: string;
  /** Two or three. */
  options: PlainOption[];
  /** Who wrote it: the model writer, or the per-kind template. */
  source: "writer" | "template";
  /** Cache provenance, not a verification of the writer's factual claims. */
  sourceFingerprint?: string;
}

/** Who speaks every inbox message — the standard's first part. */
export const INBOX_SPEAKER = "The Remudero daemon";

const MACHINE_TOKEN_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["code span", /`[^`]*`?/],
  ["file path", /\b(?:src|test|plan|docs|scripts|state|bin|app|lib)\/[\w./-]+/],
  ["file name", /\b[\w-]+\.(?:ts|tsx|js|mjs|json|ya?ml|md|ndjson)\b/],
  ["task id", /\b[A-Z][A-Z0-9]*-T\d+\b/],
  ["PR or issue number", /(?:^|\s)#\d+\b/],
  ["rule anchor", /\w\.md#|\bdoctrine\//],
  ["command", /\b(?:rmd|gh|npm|npx)\s+[a-z][\w-]+|\bgit\s+(?:push|pull|merge|rebase|commit|checkout|fetch|reset|grep)\b/],
  ["function call", /\b\w+\(\)/],
  ["identifier", /\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]+\b/],
];

/** Every machine token in `text`, named by kind — empty when the text is plain. */
export function machineTokens(text: string): string[] {
  const found: string[] = [];
  for (const [name, re] of MACHINE_TOKEN_PATTERNS) {
    const m = re.exec(text);
    if (m) found.push(`${name} "${m[0].trim()}"`);
  }
  return found;
}

export interface PlainCheckResult {
  ok: boolean;
  problems: string[];
}

/** W1-T8829 — a consequence line that is about reading the summary, or says only that no decision is
 *  made, tells the operator nothing about waiting. */
const NON_ANSWER_PATTERNS: readonly RegExp[] = [
  /\b(?:view|viewing|viewed|read|reading|opening)\b[^.]*\bsummary\b/i,
  /\bno (?:decision|change|action)s?\b[^.]*\b(?:is|are) (?:made|recorded|taken)\b/i,
];

export function isNonAnswer(line: unknown): boolean {
  if (typeof line !== "string") return false;
  return NON_ANSWER_PATTERNS.some((re) => re.test(line));
}

const HARNESS_GLOSSARY: Readonly<Record<string, string>> = {
  lane: "work queue", gate: "review step", sweep: "review pass",
  shard: "task record", rung: "stage", ratchet: "cost check",
};
const HARNESS_TERMS = /\b(?:lanes?|gates?|sweeps?|shards?|rungs?|ratchets?)\b/i;
const SOURCE_PEOPLE = /\b(?:developers?|engineers?|people|persons?|workers?|humans?)\b/i;
const PEOPLE_TIME = /\b(?:developers?|engineers?|people|persons?|workers?|working hours|work hours|productivity|human time)\b/i;
const DEPLOYMENT = /\b(?:deploy(?:ment|ments|ing|ed|s)?|production)\b/i;

function templateKind(id: string): string {
  return inboxKind(id).split("/").at(-1)!;
}

function isOpenAgeFinding(proposal: { id: string; summary: string }): boolean {
  return templateKind(proposal.id) === "board-review"
    && proposal.id.slice(proposal.id.indexOf(":") + 1).startsWith("stale:")
    && !/unhandled escalation/i.test(proposal.summary)
    && (proposal.summary.trim() === ""
      || /^board-review: \S+ has sat open [^\r\n]*h, past the \d+(?:\.\d+)?h depth threshold$/.test(proposal.summary));
}

export function checkPlainMessage(m: PlainInboxMessage, proposal?: { id: string; summary: string }): PlainCheckResult {
  const problems: string[] = [];
  const parts = checkOperatorMessage({
    speaker: INBOX_SPEAKER,
    whatHappened: m.whatHappened,
    whatIsAsked: m.whatWeNeed,
    consequenceOfInaction: m.ifNothingHappens,
  });
  for (const part of parts.missing) problems.push(`missing ${part}`);
  if (isNonAnswer(m.ifNothingHappens)) {
    problems.push("the if-nothing-happens line says nothing about what happens if nobody decides; state the real consequence of waiting");
  }
  const card = validateDecisionSummary({
    headline: m.headline,
    what_happened: m.whatHappened,
    decision: m.whatWeNeed,
    options: m.options,
  });
  if (!card) problems.push("not a decision card: headline over 15 words, a question as the ask, or not two or three options");
  const texts = [m.headline, m.whatHappened, m.whatWeNeed, m.ifNothingHappens, ...m.options.flatMap((o) => [o.label, o.consequence])];
  if (proposal && isOpenAgeFinding(proposal)) {
    // This producer supplies age, not a review deadline or a person's obligation. Keep its fixed
    // factual card rather than guessing which free-text review claims a cache might invent.
    const facts = (message: PlainInboxMessage) => [message.headline, message.whatHappened, message.whatWeNeed,
      message.ifNothingHappens, message.options.map((option) => [option.label, option.consequence, option.intent])];
    if (JSON.stringify(facts(m)) !== JSON.stringify(facts(plainTemplate(proposal)))) {
      problems.push("open PR age does not establish a human review obligation; retain only the source-qualified age card");
    }
  }
  for (const t of texts) for (const token of machineTokens(t)) problems.push(`machine text: ${token}`);
  if (proposal && !SOURCE_PEOPLE.test(proposal.summary) && texts.some((t) => PEOPLE_TIME.test(t))) {
    problems.push("people's time is not in the source; describe the fleet's machine and CI time");
  }
  if (proposal && !DEPLOYMENT.test(proposal.summary) && texts.some((t) => DEPLOYMENT.test(t))) {
    problems.push("deployment or production framing is not in the source; state the actual merge, review or workflow situation");
  }
  const headline = m.headline.trim().toLowerCase();
  const picksLabel = m.options.some((o) => {
    const label = o.label.trim().toLowerCase();
    return label !== "" && headline.startsWith(label) && !/[a-z0-9]/i.test(headline.charAt(label.length));
  });
  if (picksLabel || /(?:^|[;.!?—]\s*)(?:approve|reject|release|decline|keep|do not)\b/i.test(headline)) {
    problems.push("the headline picks an option; state the situation and leave the choice to the operator");
  }
  for (const [part, text] of [["headline", m.headline], ["what-happened", m.whatHappened]] as const) {
    if (HARNESS_TERMS.test(text)) problems.push(`harness term in ${part}; use the plain glossary wording`);
  }
  if (proposal && TEMPLATES[templateKind(proposal.id)] && /^(?:review the original record|the fleet has an item for you to look at|the item still needs your review|the item needs your review)[.!]?$/i.test(headline)) {
    problems.push("placeholder headline for a kind with a template; state this kind's actual situation");
  }
  return { ok: problems.length === 0, problems };
}

// ── The per-kind templates ─────────────────────────────────────────────────────────────────────

const ASK_OPTIONS: PlainOption[] = [
  { label: "Explain this item", consequence: "Ask for the original evidence and exact decision.", intent: "reply" },
  { label: "Leave undecided", consequence: "This summary alone provides no authorization to act.", intent: "keep" },
];

function daysWaiting(summary: string): string {
  const m = /(\d+) days? ago/.exec(summary);
  return m ? `${m[1]} days` : "some time";
}

type Template = (summary: string) => Omit<PlainInboxMessage, "source" | "options"> & { options?: PlainOption[] };

const openAgeTemplate: Template = (summary) => {
  const reported = /has sat open ((?:0|[1-9]\d*)(?:\.\d+)?)h(?:,|\s|$)/.exec(summary)?.[1];
  const hours = reported !== undefined && Number.isFinite(Number(reported)) ? reported : undefined;
  return {
    headline: "A proposed change is still open",
    whatHappened: hours !== undefined
      ? `The board records that a proposed change has been open for ${hours} hours. This measures time since opening, not time spent awaiting a review.`
      : "The board records an open proposed change, but its age is unavailable. The record does not establish time spent awaiting a review.",
    whatWeNeed: "Read the current evidence if you need more context; age alone does not establish a human decision.",
    ifNothingHappens: "The proposed change remains open; its next step depends on the current evidence, not its age alone.",
  };
};

function plainEvidence(text: string): string {
  let plain = text.replace(/https?:\/\/\S+/g, "");
  for (const [, pattern] of MACHINE_TOKEN_PATTERNS) plain = plain.replace(new RegExp(pattern.source, "g"), "");
  for (const [term, meaning] of Object.entries(HARNESS_GLOSSARY)) {
    plain = plain.replace(new RegExp(`\\b${term}s?\\b`, "gi"), meaning);
  }
  return plain.replace(/\bci-friction\b/gi, "build cost")
    .replace(/\bPR-(minutes?|hours?)\b/gi, "fleet CI $1")
    .replace(/\bretro cycles?\b/gi, "review rounds")
    .replace(/\s+/g, " ").trim();
}

const FLEET_WORK_OPTIONS: PlainOption[] = [
  { label: "Let the fleet handle it", consequence: "The fleet decides whether to fix it, merge it with similar work, or close it.", intent: "keep" },
  { label: "Drop it", consequence: "The item is closed. You can bring it back later.", intent: "decline" },
];

const fleetFinding = (what: string, headline: string): Template => () => ({
  headline,
  whatHappened: what,
  whatWeNeed: "Nothing is needed from you. The fleet handles this kind of finding itself.",
  ifNothingHappens: "The fleet works through it at the pace it finishes other work.",
  options: FLEET_WORK_OPTIONS,
});

const TEMPLATES: Record<string, Template> = {
  "verify-human": (summary) => ({
    headline: "The record requests a manual check",
    whatHappened: `The record asks for a manual check and reports a wait of ${daysWaiting(summary)}. This summary does not verify the task's current status.`,
    whatWeNeed: "Review the original question and current evidence before deciding.",
    ifNothingHappens: "The task stays blocked until someone checks it.",
  }),
  ruling: () => ({
    headline: "The record requests an operator ruling",
    whatHappened: "The record requests an operator ruling; this summary does not verify the question or its current status.",
    whatWeNeed: "Read the recorded question and confirm its scope before deciding.",
    ifNothingHappens: "The question stays open and the work waiting on the ruling stays parked.",
  }),
  "machine-judge": (summary) => {
    const filer = /was filed by the (.+?) gardener/.exec(summary)?.[1];
    const reason = plainEvidence(/stays parked for you:\s*([\s\S]*?)(?:\n\n|$)/.exec(summary)?.[1] ?? "");
    return {
      headline: "A task is parked for a risk decision",
      whatHappened: `${filer ? `The ${plainEvidence(filer)} automated reviewer filed this task. ` : "The record requests a risk decision. "}${reason ? `The risk reviewer parked it because: ${reason}` : "This summary does not verify the reason it was parked."}`,
      whatWeNeed: "Review the recorded risk and decide whether the task may proceed or needs changes.",
      ifNothingHappens: "The task stays parked and the problem it targets remains.",
    };
  },
  "board-review": (summary) => {
    const ask = /unhandled escalation: "([\s\S]*?)"/.exec(summary)?.[1];
    return {
      headline: "A proposed change has an unanswered decision",
      whatHappened: ask ? `The review record has an unanswered request: ${plainEvidence(ask)}`
        : "The review record reports an unanswered request whose question could not be read.",
      whatWeNeed: "Check the current evidence and answer the recorded review request.",
      ifNothingHappens: "The review request stays unresolved and the proposed change keeps waiting.",
    };
  },
  "guard-retirement": (summary) => {
    const rounds = /zero times for (\d+) consecutive retro cycles/i.exec(summary)?.[1];
    return {
      headline: "An unused protective check is proposed for removal",
      whatHappened: rounds ? `The record reports that a protective check has not fired for ${rounds} consecutive review rounds. Removing it still needs a separate reviewed change.`
        : "The record proposes removing a protective check; this summary does not verify its usage history.",
      whatWeNeed: "Check whether the protection is still needed before deciding on its removal.",
      ifNothingHappens: "The protective check remains in place and the removal request stays open.",
    };
  },
  "standing-debt": (summary) => ({
    headline: "A recorded problem remains unresolved",
    whatHappened: `The fleet recorded an unresolved problem: ${plainEvidence(summary.split("\n")[0]!)}`,
    whatWeNeed: "Review the evidence and decide whether to address the recorded problem.",
    ifNothingHappens: "The recorded problem remains and its effects continue.",
  }),
  adoption: fleetFinding(
    "A feature was added to the code some time ago, but nothing uses it yet.",
    "A finished feature is not being used yet",
  ),
  followup: fleetFinding(
    "While finishing earlier work, the fleet noted something it should come back to.",
    "The fleet noted a follow-up from earlier work",
  ),
  "proof-debt": fleetFinding(
    "A check that should prove a finished task works cannot run as written.",
    "A finished task has a check that cannot run",
  ),
  "skill-draft": fleetFinding(
    "The fleet noticed a way of working that keeps succeeding and wrote it down as a reusable routine.",
    "The fleet drafted a reusable routine",
  ),
  "codeql-quality": fleetFinding(
    "The code scanner found places where the code could be tidier.",
    "The code scanner found cleanup work",
  ),
  "rule-efficacy": fleetFinding(
    "One of the fleet's working rules keeps being broken, so it may need to be enforced by a check instead.",
    "A working rule keeps being broken",
  ),
  "verify-human-automate": fleetFinding(
    "A task was set aside for a person, but an automatic review found the fleet can check it itself.",
    "A task can be checked without you",
  ),
  "feedback-docket": fleetFinding(
    "Feedback from the past week points at the same problem more than once.",
    "Repeated feedback points at one problem",
  ),
};

const UNKNOWN_TEMPLATE: Template = () => ({
  headline: "Review the original record",
  whatHappened: "A record is available, but this summary does not verify its current facts or requested action.",
  whatWeNeed: "Read the original details before making a decision.",
  ifNothingHappens: "The item stays parked and the work behind it waits.",
});

/** The kinds that have a written template, including every operator kind seen live. */
export const TEMPLATED_KINDS: readonly string[] = Object.keys(TEMPLATES);

export function plainTemplate(proposal: { id: string; summary: string }): PlainInboxMessage {
  const t = (isOpenAgeFinding(proposal) ? openAgeTemplate : TEMPLATES[templateKind(proposal.id)] ?? UNKNOWN_TEMPLATE)(proposal.summary);
  return { ...t, options: t.options ?? ASK_OPTIONS, source: "template" };
}

// ── The writer ─────────────────────────────────────────────────────────────────────────────────

function writerContext(proposal: { id: string; summary: string }, retryProblems: string[]): string {
  return [
    "Write for a busy person who does not read code. Use short, everyday words and active voice.",
    "The reader is the operator of an autonomous software fleet.",
    "PR-minutes, rounds and hours measure the fleet's machine and CI time, never people's time unless the source names people.",
    "A merge, arm, review or workflow change is not a deployment unless the source mentions deployment or production.",
    "The headline states the situation; never tell the operator which option to choose or use a placeholder headline.",
    `Glossary: ${Object.entries(HARNESS_GLOSSARY).map(([term, meaning]) => `${term} = ${meaning}`).join("; ")}. Use the plain wording in the headline and what happened.`,
    "Do NOT include code, file names, file paths, task ids, PR numbers, commands, or internal names.",
    "Say what happened and what the person should decide; the raw details are shown separately.",
    'Give every option an "intent": approve (go ahead), decline (close it), reframe (ask for a different proposal or clearer proof), reply (ask a question) or keep (leave it as it is).',
    'Also include the key "if_nothing_happens": one plain line saying what concretely happens if the person does nothing',
    '(for example "the fix stays parked and the cost it targets continues", or "the task stays blocked").',
    "Do not write that nothing is decided by reading the summary; say what waiting costs or leaves undone.",
    ...(retryProblems.length > 0 ? [`Your last answer was refused for: ${retryProblems.join("; ")}. Rewrite it without those.`] : []),
    "",
    `Item: ${proposal.summary}`,
  ].join("\n");
}

async function askWriter(
  proposal: { id: string; summary: string },
  deps: SummarizeDeps,
  retryProblems: string[],
): Promise<{ message: PlainInboxMessage | null; problems: string[] }> {
  let out: unknown;
  try {
    out = await deps.summarize({ context: writerContext(proposal, retryProblems) });
  } catch (e) {
    return { message: null, problems: [`writer failed: ${String((e as Error)?.message ?? e)}`] };
  }
  const card = validateDecisionSummary(out);
  if (!card) return { message: null, problems: ["not a decision card"] };
  if (card.options.some((option) => option.intent === undefined)) return { message: null, problems: ["give every option an intent"] };
  const message: PlainInboxMessage = {
    headline: card.headline,
    whatHappened: card.what_happened,
    whatWeNeed: card.decision,
    // The writer states it (W1-T8829); a card without the line takes the kind's template.
    ifNothingHappens: card.if_nothing_happens ?? plainTemplate(proposal).ifNothingHappens,
    options: card.options,
    source: "writer",
  };
  const check = checkPlainMessage(message, proposal);
  return check.ok ? { message, problems: [] } : { message: null, problems: check.problems };
}

/** Write one item's plain message: the writer, once more with its problems named, then the
 *  template. Never throws, never returns the raw summary. */
export async function writePlainMessage(
  proposal: { id: string; summary: string },
  deps: Partial<SummarizeDeps> = {},
): Promise<PlainInboxMessage> {
  // The existing backfill also calls this seam after refusing a cached card. A known age-only
  // finding needs no model call, including when its previous writer text is misleading.
  if (isOpenAgeFinding(proposal) || !deps.summarize) return plainTemplate(proposal);
  const summarize = { summarize: deps.summarize };
  const first = await askWriter(proposal, summarize, []);
  if (first.message) return first.message;
  const second = await askWriter(proposal, summarize, first.problems);
  return second.message ?? plainTemplate(proposal);
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────

export type PlainStore = Record<string, PlainInboxMessage>;

export function plainSourceFingerprint(proposal: { id: string; summary: string }): string {
  return createHash("sha256").update(JSON.stringify(["inbox-plain-v4", proposal.id, proposal.summary])).digest("hex");
}

export function plainStorePath(stateDir: string): string {
  return `${stateDir}/inbox-plain.json`;
}

export function readPlainStore(path: string): PlainStore {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PlainStore) : {};
  } catch {
    // deliberate: an unreadable store reads as empty — every item then shows its template, and the
    // backfill rewrites the store; nothing is lost that the writer cannot write again.
    return {};
  }
}

function currentStoredMessage(proposal: { id: string; summary: string }, store: PlainStore): PlainInboxMessage | undefined {
  const stored = store[proposal.id];
  if (stored?.sourceFingerprint !== plainSourceFingerprint(proposal) || (stored.source !== "writer" && stored.source !== "template")) return undefined;
  const shape = validateDecisionSummary({
    headline: stored.headline,
    what_happened: stored.whatHappened,
    decision: stored.whatWeNeed,
    options: stored.options,
  });
  if (!shape || typeof stored.ifNothingHappens !== "string") return undefined;
  return checkPlainMessage(stored, proposal).ok ? stored : undefined;
}

/** Legacy or changed-source messages remain in the store but cannot be rendered as current. */
export function plainInboxMessage(proposal: { id: string; summary: string }, store: PlainStore): PlainInboxMessage {
  return currentStoredMessage(proposal, store) ?? plainTemplate(proposal);
}

export interface PlainBackfillDeps {
  stateDir: string;
  readProposals: () => Array<{ id: string; summary: string }>;
  summarize?: SummarizeDeps["summarize"];
}

function hasOptionIntents(message: PlainInboxMessage | undefined): boolean {
  return message?.options.every((option) => option.intent !== undefined) ?? false;
}

/** Write plain messages for operator-owned items with no current message, oldest registry order first,
 *  one at a time so a slow writer never piles up. Returns how many it wrote. */
export async function backfillPlainMessages(deps: PlainBackfillDeps, max: number): Promise<number> {
  const path = plainStorePath(deps.stateDir);
  const snapshot = readPlainStore(path);
  const pending = deps
    .readProposals()
    .filter((p) => inboxOwner(p) === "operator" && !hasOptionIntents(currentStoredMessage(p, snapshot)))
    .slice(0, max);
  let written = 0;
  for (const proposal of pending) {
    const message = await writePlainMessage(proposal, { summarize: deps.summarize });
    const current = deps.readProposals().find((p) => p.id === proposal.id);
    if (!current || inboxOwner(current) !== "operator" || plainSourceFingerprint(current) !== plainSourceFingerprint(proposal)) continue;
    const store = readPlainStore(path);
    const latest = currentStoredMessage(current, store);
    if (latest && (hasOptionIntents(latest) || JSON.stringify(latest) !== JSON.stringify(snapshot[proposal.id]))) continue;
    store[proposal.id] = { ...message, sourceFingerprint: plainSourceFingerprint(proposal) };
    writeAtomic(path, JSON.stringify(store, null, 2) + "\n");
    written += 1;
  }
  return written;
}

/** Run {@link backfillPlainMessages} on its own timer, one item per tick, never two at once — the
 *  W1-T4077 pump pattern, so a busy daemon main loop never delays it. */
export function startPlainBackfill(
  deps: PlainBackfillDeps,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void; settled: () => Promise<void>; isBusy: () => boolean } {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = backfillPlainMessages(deps, 1)
      .then((n) => {
        if (n > 0) log("inbox.plain_written", { count: n });
      })
      .catch((e) => log("inbox.plain_failed", { error: String((e as Error)?.message ?? e) }))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    isBusy: () => running !== undefined,
    settled: async () => {
      await running;
    },
  };
}
