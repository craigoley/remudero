/**
 * lib/operator-notes.ts — operator guidance notes (W1-T164, MASTER-PLAN §7/§8B).
 *
 * A task carries GUIDANCE the operator authors BEFORE a run — feedback INTO a task, the
 * complement of W1-T141's verdicts (feedback AFTER a run). Notes are console-editable via the
 * write-scoped route below, and injected into that task's recon/implement prompts under the
 * SAME provenance discipline `learnings.ts` already enforces for injected LEARNINGS facts
 * (W1-T19): every rendered line carries a citation, and only a note stamped with both an
 * `author` and a `ts` is ever eligible to render.
 *
 * STORE: configured callers share an explicit repository-scoped store in the instance's existing
 * state directory. Code generations never select it. An explicitly bound current legacy root's
 * `plan/operator-notes.ndjson` remains readable without migration or replay (W1-T10772).
 *
 * PROVENANCE IS ENFORCED TWICE (belt-and-braces, same "fail loud before any write" doctrine as
 * panel-actions.ts): {@link appendOperatorNote} refuses to WRITE an unstamped entry, and
 * {@link loadOperatorNotesForTask} independently refuses to READ one back even if the ndjson
 * file was hand-edited to contain one — an unstamped note is never rendered into any prompt via
 * either path (the W1-T164 falsifier).
 *
 * SCOPING IS EXACT-MATCH BY taskId (the cross-task-leakage falsifier): `loadOperatorNotesForTask`
 * returns ONLY entries whose `taskId` equals the id asked for, so a note authored for task A can
 * never surface in task B's rendered prompt.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { IncomingMessage } from "node:http";
import { citation } from "./provenance.js";
import type { Route } from "./service.js";
import { appendPanelLedger, bearerTokenId, isRecord, jsonAction, sendJson } from "./panel-actions.js";
import { isSafeTaskId } from "./fleet-control.js";

/** One provenance-stamped operator guidance note, scoped to a single task. */
export interface OperatorNoteEntry {
  /** ISO timestamp, stamped by the server at write time — never client-supplied. */
  ts: string;
  /** The task this note is guidance FOR — scoping key; never injected into any other task's prompt. */
  taskId: string;
  /** Who authored the note (operator-supplied, free text — this deployment has no per-human identity, see panel-actions.ts's "WHO DID THIS"). */
  author: string;
  /** The guidance text itself, injected verbatim (whitespace-flattened to one line) into the prompt. */
  note: string;
}

/**
 * The provenance rule, mechanized: an entry is eligible to be written OR read back only if it
 * carries a non-empty `author`, a non-empty `note`, a non-empty `taskId`, and a `ts` that parses
 * as a real timestamp. Anything short of this is REFUSED — never partially trusted.
 */
function isStamped(entry: unknown): entry is OperatorNoteEntry {
  if (!isRecord(entry)) return false;
  const { ts, taskId, author, note } = entry as Record<string, unknown>;
  return (
    typeof taskId === "string" && taskId.trim().length > 0 &&
    typeof author === "string" && author.trim().length > 0 &&
    typeof note === "string" && note.trim().length > 0 &&
    typeof ts === "string" && !Number.isNaN(Date.parse(ts))
  );
}

function storePath(repoRoot: string): string {
  return join(repoRoot, "plan", "operator-notes.ndjson");
}

/** A configured instance's existing state directory and exact repository, independent of code generations. */
export interface OperatorNoteStore {
  readonly stateDir: string;
  readonly repository: string;
  readonly legacyRoot?: string;
}

const verifiedStores = new WeakMap<OperatorNoteStore, { dev: number; ino: number }>();

export function operatorNoteStore(context: OperatorNoteStore | undefined): OperatorNoteStore | undefined {
  if (!context || typeof context.stateDir !== "string" || !isAbsolute(context.stateDir) ||
      !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(context.repository) ||
      (context.legacyRoot !== undefined && (typeof context.legacyRoot !== "string" || !isAbsolute(context.legacyRoot)))) return undefined;
  try {
    const stateDir = realpathSync(context.stateDir);
    const stat = statSync(stateDir);
    if (!stat.isDirectory()) return undefined;
    const store = Object.freeze({ ...context, stateDir });
    verifiedStores.set(store, { dev: stat.dev, ino: stat.ino });
    return store;
  } catch (error) {
    // Missing or inaccessible state is unverified; never create a replacement in the code tree.
    return undefined;
  }
}

function verifiedStore(store: OperatorNoteStore | undefined): store is OperatorNoteStore {
  if (!store) return false;
  const identity = verifiedStores.get(store);
  if (!identity) return false;
  try {
    const stat = statSync(store.stateDir);
    return stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch (error) {
    return false; // A removed or inaccessible binding is no longer verified.
  }
}

function durablePath(store: OperatorNoteStore): string {
  return join(store.stateDir, "operator-notes", `${encodeURIComponent(store.repository)}.ndjson`);
}

/**
 * Append a stamped operator note to the durable store. Refuses (returns `false`, writes
 * nothing) if `entry` is not fully provenance-stamped — the write-side half of the provenance
 * rule. Non-blocking by the same contract as `worker.ts`'s `appendQuestion`: a filesystem
 * failure is caught and reported as `false`, never thrown.
 */
export function appendOperatorNote(repoRoot: string | OperatorNoteStore | undefined, entry: OperatorNoteEntry): boolean {
  if (!isStamped(entry)) return false;
  try {
    if (typeof repoRoot !== "string") {
      if (!verifiedStore(repoRoot)) return false;
      mkdirSync(join(repoRoot.stateDir, "operator-notes"), { recursive: true });
      const fd = openSync(durablePath(repoRoot), "a");
      try {
        appendFileSync(fd, JSON.stringify({ ...entry, repository: repoRoot.repository }) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    }
    const dir = join(repoRoot, "plan");
    mkdirSync(dir, { recursive: true });
    appendFileSync(storePath(repoRoot), JSON.stringify(entry) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every note scoped to `taskId`, oldest first (the order guidance accumulated). A note for
 * any OTHER task id is excluded (the cross-task-leakage falsifier); an unstamped line — even one
 * that reached the file by some path other than {@link appendOperatorNote} — is excluded too
 * (the read-side half of the provenance rule). Missing store file ⇒ `[]`, never a throw (a fresh
 * checkout with no notes yet is the common case, not an error).
 */
export function loadOperatorNotesForTask(repoRoot: string | OperatorNoteStore | undefined, taskId: string): OperatorNoteEntry[] {
  return loadOperatorNotes(repoRoot).filter(entry => entry.taskId === taskId);
}

export function loadOperatorNotes(repoRoot: string | OperatorNoteStore | undefined, strict = false): OperatorNoteEntry[] {
  return loadOperatorNoteRows(repoRoot, strict)
    .filter((entry): entry is Record<string, unknown> & OperatorNoteEntry => isStamped(entry))
    .map(entry => ({ ts: entry.ts, taskId: entry.taskId, author: entry.author, note: entry.note }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Docket history keeps its existing row contract; prompt readers independently require stamps. */
export function loadOperatorNoteRows(repoRoot: string | OperatorNoteStore | undefined, strict = false): Array<Record<string, unknown>> {
  if (typeof repoRoot === "string") return readNoteRows(storePath(repoRoot), undefined, strict);
  if (!verifiedStore(repoRoot)) {
    if (strict) throw new Error("operator note store is unverified");
    return [];
  }
  const legacy = repoRoot.legacyRoot ? readNoteRows(storePath(repoRoot.legacyRoot), undefined, strict) : [];
  return [...legacy, ...readNoteRows(durablePath(repoRoot), repoRoot.repository, strict)];
}

function readNoteRows(path: string, repository?: string, strict = false): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (strict) throw error;
      continue; // a corrupt line is skipped, never crashes the read
    }
    if (strict && !isStamped(parsed)) throw new Error("operator note is unstamped or unreadable");
    if (!isRecord(parsed)) continue;
    if (repository !== undefined && parsed.repository !== repository) continue;
    entries.push(parsed);
  }
  return entries;
}

/** One note as a provenance-tagged CONTEXT bullet — same shape as `learnings.ts`'s `renderLearningLine`. */
function renderOperatorNoteLine(entry: OperatorNoteEntry): string {
  const flat = entry.note.replace(/\s+/g, " ").trim();
  return `- ${flat} ${citation(`operator#${entry.author}@${entry.ts}`)}`;
}

/**
 * Render task-scoped operator notes into a block ready to inject into a rendered prompt (recon
 * OR implement — both call this with the SAME pre-loaded entries, W1-T164 acceptance criterion
 * 1). `""` when there are none, so callers can `.filter((s) => s.length > 0)` it away exactly
 * like `renderMatchedLearnings`'s empty case.
 */
export function renderOperatorNotes(entries: OperatorNoteEntry[]): string {
  return entries.map(renderOperatorNoteLine).join("\n");
}

// ── Write-scoped console route: POST /v1/operator-notes/add ────────────────────────────────

interface AddOperatorNoteInput {
  taskId: string;
  author: string;
  note: string;
}

function validateAddOperatorNote(body: unknown): { error: string } | AddOperatorNoteInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (!isSafeTaskId(body.taskId)) return { error: "taskId is not a valid task id" };
  if (typeof body.author !== "string" || !body.author.trim()) return { error: "author is required" };
  if (typeof body.note !== "string" || !body.note.trim()) return { error: "note is required" };
  return { taskId: body.taskId, author: body.author.trim(), note: body.note.trim() };
}

export interface OperatorNoteRouteDeps {
  /** Legacy caller metadata; routes never use it as a fallback write store. */
  root: string;
  store?: OperatorNoteStore;
  ledgerPath: string;
}

/**
 * POST /v1/operator-notes/add — the console's "editable" half of "console-editable,
 * provenance-stamped." `ts` is stamped HERE, server-side, from real server time — never taken
 * from the request body, so a caller can never backdate/forge the provenance the injection side
 * relies on. `author` is operator-supplied free text (see `OperatorNoteEntry.author`'s doc) — the
 * bearer's hashed identity is ALSO ledgered as `origin` (the `panel-actions.ts` convention), so
 * both "who wrote this note" (human-facing `author`) and "which credential POSTed it"
 * (accountability `origin`) are recorded, never conflated.
 */
export function buildAddOperatorNoteRoute(deps: OperatorNoteRouteDeps): Route {
  return {
    method: "POST",
    path: "/v1/operator-notes/add",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (an advisory guidance note).
    tier: "low",
    handler: jsonAction(validateAddOperatorNote, (input, req, res) => {
      const ts = new Date().toISOString();
      const entry: OperatorNoteEntry = { ts, taskId: input.taskId, author: input.author, note: input.note };
      const written = appendOperatorNote(deps.store, entry);
      if (!written) {
        sendJson(res, 500, { error: "write_failed" });
        return;
      }
      appendPanelLedger(deps.ledgerPath, "panel.operator_note_added", input.taskId, bearerTokenId(req), {
        author: input.author,
      });
      sendJson(res, 200, { ok: true, taskId: input.taskId, author: input.author, ts });
    }),
  };
}

// ── Read-scoped console route: GET /v1/operator-notes?taskId=… ─────────────────────────────

/**
 * GET /v1/operator-notes?taskId=<id> — lets the console SHOW the current notes for a task before
 * the operator edits them (an edit surface with no read side is not really editable). Read-scoped
 * (same tier as `board.ts`'s status routes); a missing/blank `?taskId=` is a 400, never a
 * repo-wide dump — this route is deliberately task-scoped ONLY, the same discipline that keeps
 * the write side from ever leaking a note across tasks.
 */
export function buildListOperatorNotesRoute(deps: Pick<OperatorNoteRouteDeps, "root" | "store">): Route {
  return {
    method: "GET",
    path: "/v1/operator-notes",
    scope: "read",
    handler: (req: IncomingMessage, res) => {
      const taskId = new URL(req.url ?? "/", "http://localhost").searchParams.get("taskId");
      if (!taskId || !taskId.trim()) {
        sendJson(res, 400, { error: "invalid_request", detail: "taskId query param is required" });
        return;
      }
      const notes = loadOperatorNotesForTask(deps.store, taskId);
      sendJson(res, 200, { taskId, notes });
    },
  };
}
