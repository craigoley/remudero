import { existsSync, readFileSync } from "node:fs";

import type { SummarizeDeps } from "./feedback.js";
import { validateDecisionSummary } from "./feedback.js";
import { writeAtomic } from "./fs-race-safe.js";
import { inboxKind, inboxOwner } from "./inbox-owner.js";
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
 * WHAT IS CHECKED, AND WHAT IS NOT. {@link checkPlainMessage} asks two mechanical questions: are
 * the standard's four parts present ({@link checkOperatorMessage}), and is the plain text free of
 * MACHINE TOKENS — text a program wrote for a program (see {@link machineTokens}). It never scores
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

export function checkPlainMessage(m: PlainInboxMessage): PlainCheckResult {
  const problems: string[] = [];
  const parts = checkOperatorMessage({
    speaker: INBOX_SPEAKER,
    whatHappened: m.whatHappened,
    whatIsAsked: m.whatWeNeed,
    consequenceOfInaction: m.ifNothingHappens,
  });
  for (const part of parts.missing) problems.push(`missing ${part}`);
  const card = validateDecisionSummary({
    headline: m.headline,
    what_happened: m.whatHappened,
    decision: m.whatWeNeed,
    options: m.options,
  });
  if (!card) problems.push("not a decision card: headline over 15 words, a question as the ask, or not two or three options");
  const texts = [m.headline, m.whatHappened, m.whatWeNeed, m.ifNothingHappens, ...m.options.flatMap((o) => [o.label, o.consequence])];
  for (const t of texts) for (const token of machineTokens(t)) problems.push(`machine text: ${token}`);
  return { ok: problems.length === 0, problems };
}

// ── The per-kind templates ─────────────────────────────────────────────────────────────────────

const ASK_OPTIONS: PlainOption[] = [
  { label: "Go ahead", consequence: "The fleet turns this into planned work and starts on it." },
  { label: "Drop it", consequence: "The item is closed. You can bring it back later." },
  { label: "Change it", consequence: "Tell the daemon what to change, and it redrafts the item." },
];

function daysWaiting(summary: string): string {
  const m = /(\d+) days? ago/.exec(summary);
  return m ? `${m[1]} days` : "some time";
}

type Template = (summary: string) => Omit<PlainInboxMessage, "source" | "options"> & { options?: PlainOption[] };

const FLEET_WORK_OPTIONS: PlainOption[] = [
  { label: "Let the fleet handle it", consequence: "The fleet decides whether to fix it, merge it with similar work, or close it." },
  { label: "Drop it", consequence: "The item is closed. You can bring it back later." },
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
    headline: "A planned task needs a person to check it",
    whatHappened: `This task was set aside for a person to check by hand, and it has waited ${daysWaiting(summary)}. An automatic review looked again and agrees it still needs you.`,
    whatWeNeed: "Decide whether the fleet should go ahead, drop the task, or change it.",
    ifNothingHappens: "The task stays blocked, and any work that depends on it keeps waiting.",
  }),
  ruling: () => ({
    headline: "A decision is waiting for your ruling",
    whatHappened: "The fleet reached a question that only you can decide, so it stopped and asked.",
    whatWeNeed: "Choose how the fleet should proceed.",
    ifNothingHappens: "The work behind this question stays paused.",
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
  headline: "The fleet has an item for you to look at",
  whatHappened: "A part of the fleet raised this item, and it is a new kind the daemon has not seen before.",
  whatWeNeed: "Read the details and decide whether the fleet should go ahead, drop it, or change it.",
  ifNothingHappens: "The item stays in your inbox.",
});

/** The kinds that have a written template (every kind seen live on 2026-09-22). */
export const TEMPLATED_KINDS: readonly string[] = Object.keys(TEMPLATES);

export function plainTemplate(proposal: { id: string; summary: string }): PlainInboxMessage {
  const t = (TEMPLATES[inboxKind(proposal.id)] ?? UNKNOWN_TEMPLATE)(proposal.summary);
  return { ...t, options: t.options ?? ASK_OPTIONS, source: "template" };
}

// ── The writer ─────────────────────────────────────────────────────────────────────────────────

function writerContext(proposal: { id: string; summary: string }, retryProblems: string[]): string {
  return [
    "Write for a busy person who does not read code. Use short, everyday words and active voice.",
    "Do NOT include code, file names, file paths, task ids, PR numbers, commands, or internal names.",
    "Say what happened and what the person should decide; the raw details are shown separately.",
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
  const message: PlainInboxMessage = {
    headline: card.headline,
    whatHappened: card.what_happened,
    whatWeNeed: card.decision,
    // The decision card has no "if nothing happens" part; the kind's template states it.
    ifNothingHappens: plainTemplate(proposal).ifNothingHappens,
    options: card.options,
    source: "writer",
  };
  const check = checkPlainMessage(message);
  return check.ok ? { message, problems: [] } : { message: null, problems: check.problems };
}

/** Write one item's plain message: the writer, once more with its problems named, then the
 *  template. Never throws, never returns the raw summary. */
export async function writePlainMessage(
  proposal: { id: string; summary: string },
  deps: Partial<SummarizeDeps> = {},
): Promise<PlainInboxMessage> {
  if (!deps.summarize) return plainTemplate(proposal);
  const summarize = { summarize: deps.summarize };
  const first = await askWriter(proposal, summarize, []);
  if (first.message) return first.message;
  const second = await askWriter(proposal, summarize, first.problems);
  return second.message ?? plainTemplate(proposal);
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────

export type PlainStore = Record<string, PlainInboxMessage>;

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

/** The plain message the console shows for one item: the stored one if it still passes the
 *  check, otherwise the template. Pure over its inputs. */
export function plainInboxMessage(proposal: { id: string; summary: string }, store: PlainStore): PlainInboxMessage {
  const stored = store[proposal.id];
  if (stored && checkPlainMessage(stored).ok) return stored;
  return plainTemplate(proposal);
}

export interface PlainBackfillDeps {
  stateDir: string;
  readProposals: () => Array<{ id: string; summary: string }>;
  summarize?: SummarizeDeps["summarize"];
}

/** Write plain messages for operator-owned items that have none yet, oldest registry order first,
 *  one at a time so a slow writer never piles up. Returns how many it wrote. */
export async function backfillPlainMessages(deps: PlainBackfillDeps, max: number): Promise<number> {
  const path = plainStorePath(deps.stateDir);
  const pending = deps
    .readProposals()
    .filter((p) => inboxOwner(p) === "operator" && !readPlainStore(path)[p.id])
    .slice(0, max);
  for (const proposal of pending) {
    const message = await writePlainMessage(proposal, { summarize: deps.summarize });
    const store = readPlainStore(path);
    store[proposal.id] = message;
    writeAtomic(path, JSON.stringify(store, null, 2) + "\n");
  }
  return pending.length;
}

/** Run {@link backfillPlainMessages} on its own timer, one item per tick, never two at once — the
 *  W1-T4077 pump pattern, so a busy daemon main loop never delays it. */
export function startPlainBackfill(
  deps: PlainBackfillDeps,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void; settled: () => Promise<void> } {
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
    settled: async () => {
      await running;
    },
  };
}
