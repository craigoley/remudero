import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
 * This module is the CAPTURE primitive only — plain filesystem I/O, no network, no LLM call,
 * so `rmd feedback` returns instantly and works offline. The INTAKE LOOP that reads this inbox
 * and moves entries through `grilling`/`proposed` (`rmd triage`, W1-T41) is a separate task; this
 * module exposes {@link setFeedbackStatus} as the write primitive that worker will call, but ships
 * no CLI surface for it — the inbox itself is browsable with plain `ls`/`cat`/`git diff` on
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
 * `FeedbackOrigin` is the named closed enum above PLUS `issue#<n>` — machine-origin provenance
 * for one specific managed-repo GitHub issue (W1-T57, MASTER-PLAN §5D/§7B: "machine-origin
 * feedback... flows through the §7B feedback inbox (`origin: alert#<id>` / `origin: issue#<n>`)").
 * This is a DIFFERENT axis than the named enum's "issue" value (a human capturing feedback
 * that references remudero's own tracker) — `issue#<n>` instead names WHICH managed-repo issue
 * produced this entry, so `rmd trace` (W1-T43) can point straight back at it.
 */
export type FeedbackOrigin = NamedFeedbackOrigin | `issue#${number}`;

const MACHINE_ORIGIN_ISSUE = /^issue#\d+$/;

/** True for any valid {@link FeedbackOrigin} — the named enum or a well-formed `issue#<n>`. */
export function isValidFeedbackOrigin(origin: string): origin is FeedbackOrigin {
  return (FEEDBACK_ORIGINS as readonly string[]).includes(origin) || MACHINE_ORIGIN_ISSUE.test(origin);
}

/** The status lifecycle a feedback entry moves through (§7B: capture -> triage -> gate). */
export const FEEDBACK_STATUSES = ["new", "grilling", "proposed", "accepted", "rejected"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** One `plan/feedback/<id>.yaml` entry — the exact §7B schema shape. */
export interface FeedbackEntry {
  id: string;
  ts: string;
  raw: string;
  attachments: string[];
  origin: FeedbackOrigin;
  status: FeedbackStatus;
  /** Set once `rmd triage` (W1-T41) opens a proposal PR for this entry; null until then. */
  proposal_pr: string | null;
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
}

/**
 * Capture one feedback item: writes `plan/feedback/<id>.yaml` with `status: new`, copying any
 * local-path attachments alongside it. Synchronous filesystem I/O only — no network, no LLM —
 * so a headless `rmd feedback` call returns immediately (ASYNC CAPTURE: the operator is never
 * blocked waiting on triage, which runs later and separately, W1-T41).
 */
export function captureFeedback(root: string, opts: CaptureFeedbackOptions): FeedbackEntry {
  const raw = opts.raw.trim();
  if (!raw) throw new FeedbackError("feedback text must not be empty");
  const origin = opts.origin ?? "cli";
  if (!isValidFeedbackOrigin(origin)) {
    throw new FeedbackError(
      `invalid origin "${origin}" — must be one of ${FEEDBACK_ORIGINS.join(", ")}, or "issue#<n>" (machine-origin, W1-T57)`,
    );
  }
  const id = opts.id ?? generateFeedbackId();
  mkdirSync(feedbackDir(root), { recursive: true });
  const attachments = resolveAttachments(root, id, opts.attachments ?? []);
  const entry: FeedbackEntry = {
    id,
    ts: new Date().toISOString(),
    raw,
    attachments,
    origin,
    status: "new",
    proposal_pr: null,
  };
  writeFileSync(feedbackEntryPath(root, id), stringifyYaml(entry));
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
 */
export function setFeedbackStatus(
  root: string,
  id: string,
  status: FeedbackStatus,
  opts: { proposalPr?: string } = {},
): FeedbackEntry {
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    throw new FeedbackError(`invalid status "${status}" — must be one of ${FEEDBACK_STATUSES.join(", ")}`);
  }
  const entry = readFeedbackEntry(root, id);
  const updated: FeedbackEntry = {
    ...entry,
    status,
    proposal_pr: opts.proposalPr ?? entry.proposal_pr ?? null,
  };
  writeFileSync(feedbackEntryPath(root, id), stringifyYaml(updated));
  return updated;
}
